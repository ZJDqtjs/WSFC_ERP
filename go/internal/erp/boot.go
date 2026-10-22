package erp

import (
	"database/sql"
	"encoding/json"
	"math"
	"strings"

	"wsfc-erp-go/internal/auth"
)

// 开机数据层：Python 每次启动都对**每个分仓**跑一遍 initdb.init_warehouse()，
// 里面有三步幂等动作没被移植过来（种子账号收口、入仓品扣点种子、商品回填）。
// Go 与 Python 读写同一批 .db 文件，少跑这一步的库会在账面（净重/快递费/报表重量）
// 和管理面（账号、口令）上长期错位，所以这里按同样时机、同样规则补齐。
// 一次性迁移（FIFO 全量重算、入仓品每袋净重）不在此列：那两个由 data 下的 marker 文件控制，
// 生产上早已跑完，重复跑反而危险。

// SeedAccount 是 accounts 段里的一条种子账号（口令只在私有的 config.local.json 里）。
type SeedAccount struct {
	Username string
	Password string
	Name     string
	Role     string
}

// BootSeedAccounts 读合并后的配置取 accounts，规则与 Python config.seed_accounts 一致：
// 非对象项跳过、用户名空跳过、角色缺省 user（口令原样保留，空串也照样散列，不替用户做主）。
func BootSeedAccounts() []SeedAccount {
	list, _ := AILoadRules()["accounts"].([]any)
	out := make([]SeedAccount, 0, len(list))
	for _, item := range list {
		acc, ok := item.(map[string]any)
		if !ok {
			continue
		}
		username := strings.TrimSpace(ToStr(acc["username"]))
		if username == "" {
			continue
		}
		role := strings.TrimSpace(ToStr(acc["role"]))
		if role == "" {
			role = "user"
		}
		out = append(out, SeedAccount{
			Username: username,
			Password: ToStr(acc["password"]),
			Name:     strings.TrimSpace(ToStr(acc["name"])),
			Role:     role,
		})
	}
	return out
}

// BootWarehouse 对一个分仓的连接池执行开机三步，顺序照 Python init_warehouse
// （ensure_seed_users → _backfill_products → ensure_warehouse_deduction）。
// 由 database.Manager 在建池后调用；新建分仓由 initWarehouse 在 copy_users 之后显式调用。
func BootWarehouse(db *sql.DB) error {
	if err := bootSeedUsers(db, BootSeedAccounts()); err != nil {
		return err
	}
	if err := bootBackfillProducts(db); err != nil {
		return err
	}
	return bootWarehouseDeduction(db)
}

// bootSeedUsers 对齐 auth.ensure_seed_users：有号就收口（口令散列不匹配才重写散列，
// 姓名/角色/is_active 每次都按配置覆盖），没号就建。散列格式 salt$hexdk 与 Python 互通。
func bootSeedUsers(db *sql.DB, accounts []SeedAccount) error {
	for _, a := range accounts {
		var id int
		var hash string
		err := db.QueryRow("SELECT id, COALESCE(password_hash,'') FROM users WHERE username = ?", a.Username).Scan(&id, &hash)
		switch {
		case err == sql.ErrNoRows:
			_, err = db.Exec("INSERT INTO users (username, password_hash, name, role, is_active, created_at) VALUES (?,?,?,?,1,?)",
				a.Username, auth.HashPassword(a.Password), a.Name, a.Role, NowDB())
		case err != nil:
			return err
		default:
			if hash == "" || !auth.VerifyPassword(a.Password, hash) {
				hash = auth.HashPassword(a.Password)
			}
			_, err = db.Exec("UPDATE users SET password_hash=?, name=?, role=?, is_active=1 WHERE id=?",
				hash, a.Name, a.Role, id)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// 入仓品扣点：Python 用类别名「入仓品」在扣点表里统一维护，默认 6%，已有则不覆盖用户改动。
const warehouseDeductionCategory = "入仓品"

func bootWarehouseDeduction(db *sql.DB) error {
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM deductions WHERE category = ?", warehouseDeductionCategory).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err := db.Exec("INSERT INTO deductions (category, percent, remark, created_at, updated_at) VALUES (?,?,?,?,?)",
		warehouseDeductionCategory, 6.0, "入仓品采购价（收入）扣点", NowDB(), NowDB())
	return err
}

// bootBackfillProducts 对齐 initdb._backfill_products 的两条腿：
// ① default_unit 为空的老商品，换算表里有「斤」就以「斤」为默认单位，否则跟基础单位；
// ② 基础单位是克/g 且净重为 0 的，按 conversions[默认单位]/1000 补出单件净重(kg)。
// 顺序照 Python：先补默认单位，净重那条才用得上新值。
// 「人工」类的工作量重算不在这里做——Go 的建档/入库/出库/调整各写路径本来就跑 RecomputeProduct，
// 再在开机时全量扫一遍只是把成本重算的写放大搬到启动，两边观测到的 workload 也一致。
func bootBackfillProducts(db *sql.DB) error {
	type row struct {
		id   int
		base string
		def  string
		conv map[string]any
	}
	rows := make([]row, 0, 64)
	res, err := db.Query("SELECT id, COALESCE(base_unit,''), COALESCE(default_unit,''), COALESCE(conversions,'') FROM products")
	if err != nil {
		return err
	}
	for res.Next() {
		var (
			r       row
			convRaw string
		)
		if err := res.Scan(&r.id, &r.base, &r.def, &convRaw); err != nil {
			res.Close()
			return err
		}
		conv := map[string]any{}
		if strings.TrimSpace(convRaw) != "" {
			_ = json.Unmarshal([]byte(convRaw), &conv)
		}
		r.conv = conv
		rows = append(rows, r)
	}
	if err := res.Close(); err != nil {
		return err
	}

	for _, r := range rows {
		if r.def == "" {
			fallback := r.base
			if _, ok := r.conv["斤"]; ok {
				fallback = "斤"
			}
			if fallback != "" {
				if _, err := db.Exec("UPDATE products SET default_unit=? WHERE id=?", fallback, r.id); err != nil {
					return err
				}
				r.def = fallback
			}
		}
	}

	// 净重那条按 Python 的过滤条件重来一遍：只处理克/g 且当前净重为 0 的行。
	res, err = db.Query("SELECT id, COALESCE(base_unit,''), COALESCE(default_unit,''), COALESCE(conversions,'') " +
		"FROM products WHERE (weight_kg IS NULL OR weight_kg = 0) AND base_unit IN ('克','g')")
	if err != nil {
		return err
	}
	type fill struct {
		id     int
		weight float64
	}
	fills := make([]fill, 0, 16)
	for res.Next() {
		var (
			id      int
			base    string
			def     string
			convRaw string
		)
		if err := res.Scan(&id, &base, &def, &convRaw); err != nil {
			res.Close()
			return err
		}
		key := def
		if key == "" {
			key = base
		}
		conv := map[string]any{}
		if strings.TrimSpace(convRaw) != "" {
			_ = json.Unmarshal([]byte(convRaw), &conv)
		}
		gm := ToFloat(conv[key])
		if gm > 0 {
			fills = append(fills, fill{id: id, weight: roundTo(gm/1000.0, 4)})
		}
	}
	if err := res.Close(); err != nil {
		return err
	}
	for _, f := range fills {
		if _, err := db.Exec("UPDATE products SET weight_kg=? WHERE id=?", f.weight, f.id); err != nil {
			return err
		}
	}
	return nil
}

// roundTo 取整到 4 位、逢半取偶（Python round(x, 4) 的 banker's rounding）。
func roundTo(v float64, digits int) float64 {
	p := math.Pow(10, float64(digits))
	return math.RoundToEven(v*p) / p
}
