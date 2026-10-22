package erp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 本文件是「扣点」读写口径，对齐 Python routers/deductions.py。
// 两种扣点：① 分类扣点存 deductions 表；② 店铺扣点存 backend/json/deduction_config.json 文件（与 Python 共用同一份）。

// DeductionConfigPath 店铺扣点配置文件（由 api 层按配置目录赋值）。
var DeductionConfigPath = ""

// Deduction 分类扣点。
type DeductionRule struct {
	ID        int
	Category  string
	Percent   float64
	Remark    string
	CreatedAt string
	UpdatedAt string
}

// JSON 输出（created_at/updated_at 为空时给 null，与 Python isoformat 一致）。
func (d DeductionRule) JSON() map[string]any {
	return map[string]any{"id": d.ID, "category": d.Category, "percent": d.Percent, "remark": d.Remark,
		"created_at": orNull(isoStamp(d.CreatedAt)), "updated_at": orNull(isoStamp(d.UpdatedAt))}
}

func orNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ListDeductions 分类扣点列表（按类别名排序）。
func ListDeductions(ctx context.Context, q Querier) ([]map[string]any, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, category, percent, COALESCE(remark,''), COALESCE(created_at,''), COALESCE(updated_at,'') FROM deductions ORDER BY category")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var d DeductionRule
		if err := rows.Scan(&d.ID, &d.Category, &d.Percent, &d.Remark, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, d.JSON())
	}
	return out, rows.Err()
}

// UpsertDeduction 按类别名新增或更新（无 PUT 接口，POST 幂等覆盖）。
func UpsertDeduction(ctx context.Context, q Querier, in map[string]any) (DeductionRule, error) {
	cat := strings.TrimSpace(ToStr(in["category"]));
	if cat == "" {
		return DeductionRule{}, ErrText("商品类别不能为空")
	}
	percent := ToFloat(in["percent"])
	if percent < 0 || percent >= 100 {
		return DeductionRule{}, ErrText("扣点百分比必须在 0 ~ 100 之间（不含 100）")
	}
	remark := strings.TrimSpace(ToStr(in["remark"]));
	now := NowDB()
	var id int
	row := q.QueryRowContext(ctx, "SELECT id FROM deductions WHERE category = ?", cat)
	if err := row.Scan(&id); err == nil {
		if _, err := q.ExecContext(ctx, "UPDATE deductions SET percent = ?, remark = ?, updated_at = ? WHERE id = ?", percent, remark, now, id); err != nil {
			return DeductionRule{}, err
		}
	} else {
		res, err := q.ExecContext(ctx, "INSERT INTO deductions (category, percent, remark, created_at, updated_at) VALUES (?,?,?,?,?)", cat, percent, remark, now, now)
		if err != nil {
			return DeductionRule{}, err
		}
		n64, _ := res.LastInsertId()
		id = int(n64)
	}
	return DeductionRule{ID: id, Category: cat, Percent: percent, Remark: remark, CreatedAt: now, UpdatedAt: now}, nil
}

// DeleteDeduction 删除一条分类扣点。
func DeleteDeduction(ctx context.Context, q Querier, id int) error {
	res, err := q.ExecContext(ctx, "DELETE FROM deductions WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return Err404("扣点规则不存在")
	}
	return nil
}

// ShopRule 店铺扣点（二选一：固定 percent 或按 categories）。
// CatOrder 记录 categories 的键顺序：Python 用 dict 原样读写文件，Go 的 map 无序，
// 少了它会把「蔬菜/水果」这类分类顺序在每次保存时打乱。
type ShopRule struct {
	Shop       string
	Percent    *float64
	Categories map[string]float64
	CatOrder   []string
}

// JSON：percent 优先；否则输出 categories（按 CatOrder 保序）。
func (r ShopRule) JSON() map[string]any {
	if r.Percent != nil {
		return map[string]any{"shop": r.Shop, "percent": *r.Percent}
	}
	return map[string]any{"shop": r.Shop, "categories": r.catJSON()}
}

// catJSON 保序的 categories 对象；顺序缺失的键按字典序补在后面。
func (r ShopRule) catJSON() any {
	keys := make([]string, 0, len(r.Categories))
	seen := map[string]bool{}
	for _, k := range r.CatOrder {
		if _, ok := r.Categories[k]; ok && !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	rest := make([]string, 0, len(r.Categories))
	for k := range r.Categories {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	keys = append(keys, rest...)
	om := newOM()
	for _, k := range keys {
		om.set(k, r.Categories[k])
	}
	return om
}

func (r ShopRule) Raw() map[string]any { return r.JSON() }

// LoadShopRules 读店铺扣点文件（缺失/损坏 → 空）。
func LoadShopRules() ([]ShopRule, error) {
	if DeductionConfigPath == "" {
		return nil, ErrText("未配置扣点文件路径")
	}
	raw, err := os.ReadFile(DeductionConfigPath)
	if err != nil {
		return []ShopRule{}, nil
	}
	var doc struct {
		Rules []map[string]any `json:"rules"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return []ShopRule{}, nil
	}
	out := []ShopRule{}
	for _, m := range doc.Rules {
		shop := strings.TrimSpace(ToStr(m["shop"]))
		if shop == "" {
			continue
		}
		r := ShopRule{Shop: shop}
		if v, ok := toFloat(m["percent"]); ok {
			p := Round(v, 4)
			r.Percent = &p
		} else if cm, ok := m["categories"].(map[string]any); ok {
			cats := map[string]float64{}
			for k, v := range cm {
				if f, ok := toFloat(v); ok && f > 0 && strings.TrimSpace(k) != "" {
					cats[k] = Round(f, 4)
				}
			}
			if len(cats) > 0 {
				r.Categories = cats
				r.CatOrder = jsonMapKeys(raw, shop, "categories")
			}
		}
		if r.Percent == nil && len(r.Categories) == 0 {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

// SaveShopRules 整档写回（与 Python 一样非原子、indent=2、保留中文）。
func SaveShopRules(rules []ShopRule) error {
	if DeductionConfigPath == "" {
		return ErrText("未配置扣点文件路径")
	}
	if err := os.MkdirAll(filepath.Dir(DeductionConfigPath), 0o755); err != nil {
		return err
	}
	items := make([]map[string]any, 0, len(rules))
	for _, r := range rules {
		items = append(items, r.JSON())
	}
	raw, err := marshalIndentJSON(map[string]any{"rules": items})
	if err != nil {
		return err
	}
	return os.WriteFile(DeductionConfigPath, raw, 0o644)
}

// UpsertShopRule 同名店铺替换；percent 优先于 categories。
func UpsertShopRule(in map[string]any) ([]ShopRule, error) {
	shop := strings.TrimSpace(ToStr(in["shop"]));
	if shop == "" {
		return nil, ErrText("店铺名称不能为空")
	}
	rules, err := LoadShopRules()
	if err != nil {
		return nil, err
	}
	var next ShopRule
	percentProvided := HasKey(in, "percent") && in["percent"] != nil
	if percentProvided {
		p := ToFloat(in["percent"])
		if p < 0 || p >= 100 {
			return nil, ErrText("固定扣点百分比需在 0 ~ 100 之间（不含 100）")
		}
		v := Round(p, 4)
		next = ShopRule{Shop: shop, Percent: &v}
	} else if cm, ok := in["categories"].(map[string]any); ok && len(cm) > 0 {
		cats := map[string]float64{}
		for k, v := range cm {
			f := ToFloat(v)
			if f > 0 && strings.TrimSpace(k) != "" {
				cats[k] = Round(f, 4)
			}
		}
		if len(cats) == 0 {
			return nil, ErrText("请至少填写一个「分类 ≥ 0」的扣点")
		}
		next = ShopRule{Shop: shop, Categories: cats}
	} else {
		return nil, ErrText("请选择「固定扣点」或填写「按分类扣点」")
	}
	out := []ShopRule{}
	replaced := false;
	for _, r := range rules {
		if r.Shop == shop {
			out = append(out, next)
			replaced = true
			continue
		}
		out = append(out, r)
	}
	if !replaced {
		out = append(out, next)
	}
	if err := SaveShopRules(out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteShopRule 删除店铺（幂等：不存在也不报错）。
func DeleteShopRule(shop string) ([]ShopRule, error) {
	rules, err := LoadShopRules()
	if err != nil {
		return nil, err
	}
	out := []ShopRule{}
	for _, r := range rules {
		if r.Shop == shop {
			continue
		}
		out = append(out, r)
	}
	if err := SaveShopRules(out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeductionMap 分类扣点表（导入时折算用）。
func DeductionMap(ctx context.Context, q Querier) (map[string]float64, error) {
	rows, err := q.QueryContext(ctx, "SELECT category, percent FROM deductions")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]float64{}
	for rows.Next() {
		var c string
		var p float64
		if err := rows.Scan(&c, &p); err == nil {
			out[c] = p
		}
	}
	return out, rows.Err()
}

// ApplyDeductionPrice 扣点后的实际入库单价：round(price*(1-percent/100), 4)。
func ApplyDeductionPrice(price, percent float64) float64 {
	if percent <= 0 {
		return price
	}
	return Round(price*(1-percent/100), 4)
}

// SortedCategories 把 categories 映射按键排序输出（写文件与响应都要稳定顺序）。
func SortedCategories(m map[string]float64) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
