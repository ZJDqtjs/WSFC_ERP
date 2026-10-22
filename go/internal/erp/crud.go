package erp

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 本文件是「商品删除/批量、计量单位、库存大类清单、一单多货打包规则」，对齐 products.py / pack_rules.py。

// PyFloat 复刻 Python 的 float 字符串（2.0 而不是 2）：打包规则名要用它拼接。
func PyFloat(v float64) string {
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return fmt.Sprintf("%.1f", v)
	}
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.10f", v), "0"), "")
}

// DeleteProduct 删除商品；被任何数据引用时拒删，并把「被谁引用」逐条列出（前端弹窗直接用）。
func DeleteProduct(ctx context.Context, q Querier, pid int) error {
	var name string
	row := q.QueryRowContext(ctx, "SELECT name FROM products WHERE id = ?", pid)
	if err := row.Scan(&name); err == sql.ErrNoRows {
		return Err404("商品不存在")
	} else if err != nil {
		return err
	}
	sources := ProductReferenceSources(ctx, q, pid)
	if len(sources) > 0 {
		// 文案与 Python 一致：每条来源前面加 "- "，尾部给出可选处理办法（前端直接弹这个多行 detail）
		lines := []string{fmt.Sprintf("商品「%s」仍被以下数据引用，无法删除：", name)}
		for _, s := range sources {
			lines = append(lines, "- "+s)
		}
		lines = append(lines, "（可先删除对应单据 / 盘点调整记录，或把该商品改为「停用」）")
		return ErrText("%s", strings.Join(lines, "\n"))
	}
	_, err := q.ExecContext(ctx, "DELETE FROM products WHERE id = ?", pid)
	return err
}

// BatchDeleteProducts 批量删除：被引用的商品跳过并回原因。
func BatchDeleteProducts(ctx context.Context, q Querier, ids []int) (map[string]any, error) {
	deleted := 0
	blocked := []map[string]any{}
	names := []string{}
	for _, pid := range ids {
		var name string
		row := q.QueryRowContext(ctx, "SELECT name FROM products WHERE id = ?", pid)
		if err := row.Scan(&name); err != nil {
			continue
		}
		sources := ProductReferenceSources(ctx, q, pid)
		if len(sources) > 0 {
			blocked = append(blocked, map[string]any{"id": pid, "name": name, "sources": sources})
			names = append(names, name)
			continue
		}
		if _, err := q.ExecContext(ctx, "DELETE FROM products WHERE id = ?", pid); err != nil {
			return nil, err
		}
		deleted++
	}
	if blocked == nil {
		blocked = []map[string]any{}
	}
	if names == nil {
		names = []string{}
	}
	return map[string]any{"ok": true, "deleted": deleted, "blocked": names, "blocked_items": blocked}, nil
}

// BatchUpdateProducts 批量改分类/默认单位/启停/售价/成本/打包费/包邮；不存在的 id 静默跳过。
func BatchUpdateProducts(ctx context.Context, q Querier, body map[string]any) (map[string]any, error) {
	ids := ParseIDs(body)
	if !HasKey(body, "ids") {
		ids = IntSlice(body["ids"])
	}
	updated := 0
	for _, pid := range ids {
		row := q.QueryRowContext(ctx, "SELECT conversions FROM products WHERE id = ?", pid)
		var conv string
		if err := row.Scan(&conv); err != nil {
			continue
		}
		sets := []string{}
		args := []any{}
		if v, ok := body["category"].(string); ok {
			sets = append(sets, "category = ?")
			args = append(args, strings.TrimSpace(v))
		}
		if v, ok := body["default_unit"].(string); ok {
			// 只有该商品配置了这个单位才生效，否则默默忽略（避免默认单位与换算表打架）
			cm := decodeFloatMap(conv)
			if _, has := cm[v]; has {
				sets = append(sets, "default_unit = ?")
				args = append(args, v)
			}
		}
		if v, ok := body["is_active"].(bool); ok {
			sets = append(sets, "is_active = ?")
			args = append(args, b2i(v))
		}
		if v, ok := toFloat(body["sale_price"]); ok {
			sets = append(sets, "sale_price = ?")
			args = append(args, v)
		}
		if v, ok := toFloat(body["unit_cost"]); ok {
			sets = append(sets, "unit_cost = ?")
			args = append(args, v)
		}
		if v, ok := toFloat(body["pack_fee"]); ok {
			sets = append(sets, "pack_fee = ?")
			args = append(args, v)
		}
		if v, ok := toFloat(body["weight_kg"]); ok {
			sets = append(sets, "weight_kg = ?")
			args = append(args, v)
		}
		if _, ok := body["free_shipping"]; ok {
			sets = append(sets, "free_shipping = ?")
			args = append(args, b2i(ToBool(body["free_shipping"])))
		}
		if len(sets) == 0 {
			continue
		}
		args = append(args, pid)
		if _, err := q.ExecContext(ctx, "UPDATE products SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
			return nil, err
		}
		updated++
	}
	return map[string]any{"ok": true, "updated": updated}, nil
}

// Unit 计量单位（换算基准表）。
type Unit struct {
	ID           int
	Name         string
	Category     string
	GramPerUnit  sql.NullFloat64
	IsStandard   bool
}

// JSON：非重量类单位 gram_per_unit 为 null；is_standard 只在服务端用于删除保护，不下发。
func (u Unit) JSON() map[string]any {
	var g any
	if u.GramPerUnit.Valid {
		g = u.GramPerUnit.Float64
	}
	return map[string]any{"id": u.ID, "name": u.Name, "category": u.Category, "gram_per_unit": g}
}

// ListUnits 单位列表（空表先播种标准单位，与 Python 一致）。
func ListUnits(ctx context.Context, q Querier) ([]map[string]any, error) {
	if err := SeedUnits(ctx, q); err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, "SELECT id, name, category, gram_per_unit, is_standard FROM units ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var u Unit
		var std int
		if err := rows.Scan(&u.ID, &u.Name, &u.Category, &u.GramPerUnit, &std); err != nil {
			return nil, err
		}
		u.IsStandard = std != 0
		out = append(out, u.JSON())
	}
	return out, rows.Err()
}

// CreateUnit 新增自定义单位。
func CreateUnit(ctx context.Context, q Querier, body map[string]any) (Unit, error) {
	name := strings.TrimSpace(ToStr(body["name"]));
	if name == "" {
		return Unit{}, ErrText("单位名称不能为空")
	}
	cat := strings.TrimSpace(ToStr(body["category"]));
	if cat != "weight" && cat != "count" {
		return Unit{}, ErrText("类型必须为 weight 或 count")
	}
	var dup int
	_ = q.QueryRowContext(ctx, "SELECT id FROM units WHERE name = ?", name).Scan(&dup)
	if dup != 0 {
		return Unit{}, ErrText("单位「%s」已存在", name)
	}
	u := Unit{Name: name, Category: cat};
	if cat == "weight" {
		g, ok := toFloat(body["gram_per_unit"]);
		if !ok || g <= 0 {
			return Unit{}, ErrText("重量类单位必须填写每单位克数")
		}
		u.GramPerUnit = sql.NullFloat64{Float64: g, Valid: true}
	}
	res, err := q.ExecContext(ctx, "INSERT INTO units (name, category, gram_per_unit, is_standard) VALUES (?,?,?,0)", u.Name, u.Category, u.GramPerUnit)
	if err != nil {
		return Unit{}, err
	}
	id64, _ := res.LastInsertId()
	u.ID = int(id64)
	return u, nil
}

// DeleteUnit 删除自定义单位（标准单位受保护）。
func DeleteUnit(ctx context.Context, q Querier, id int) error {
	var name string
	var std int
	row := q.QueryRowContext(ctx, "SELECT name, is_standard FROM units WHERE id = ?", id)
	if err := row.Scan(&name, &std); err == sql.ErrNoRows {
		return Err404("单位不存在")
	} else if err != nil {
		return err
	}
	if std != 0 {
		return ErrText("标准单位不可删除")
	}
	_, err := q.ExecContext(ctx, "DELETE FROM units WHERE id = ?", id)
	return err
}

// StockProducts 库存大类清单（出库/入库选品用，字段精简）。
func StockProducts(ctx context.Context, q Querier) ([]map[string]any, error) {
	items, err := ListProducts(ctx, q)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, p := range items {
		if p.ProductType != "stock" || !p.IsActive {
			continue
		}
		conv := p.Conversions
		if conv == nil {
			conv = map[string]float64{}
		}
		du := p.DefaultUnit;
		if strings.TrimSpace(du) == "" {
			du = p.BaseUnit
		}
		out = append(out, map[string]any{"id": p.ID, "name": p.Name, "category": p.Category,
			"base_unit": p.BaseUnit, "default_unit": du, "conversions": conv, "stock": p.Stock})
	}
	return out, nil
}

// PackRule 一单多货打包规则。
type PackRule struct {
	ID         int
	Name       string
	Items      string
	BoxType    string
	BoxItems   string
	LaborPrice sql.NullFloat64
	BoxRatio   float64
	Remark     string
	IsActive   bool
	CreatedAt  string
}

// JSON 输出（items/box_items 是库里存的 JSON，原样解析回数组）。
func (r PackRule) JSON() map[string]any {
	var lp any
	if r.LaborPrice.Valid {
		lp = r.LaborPrice.Float64
	}
	return map[string]any{"id": r.ID, "name": r.Name, "items": decodeJSONAny(r.Items),
		"box_type": r.BoxType, "box_items": decodeJSONAny(r.BoxItems), "labor_price": lp,
		"box_ratio": r.BoxRatio, "remark": r.Remark, "is_active": r.IsActive, "created_at": orNull(isoStamp(r.CreatedAt))}
}

func decodeJSONAny(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return []any{}
	}
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil || v == nil {
		return []any{}
	}
	return v
}

const packRuleColumns = "id, name, COALESCE(items,'[]'), COALESCE(box_type,''), COALESCE(box_items,'[]'), labor_price, COALESCE(box_ratio,1), COALESCE(remark,''), is_active, COALESCE(created_at,'')"

// ListPackRules 打包规则（含停用，按名称排序）。
func ListPackRules(ctx context.Context, q Querier) ([]map[string]any, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+packRuleColumns+" FROM pack_rules ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var r PackRule
		var act int
		if err := rows.Scan(&r.ID, &r.Name, &r.Items, &r.BoxType, &r.BoxItems, &r.LaborPrice, &r.BoxRatio, &r.Remark, &act, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.IsActive = act != 0
		out = append(out, r.JSON())
	}
	return out, rows.Err()
}

// PackRuleGenName 用组合商品生成规则名（与 Python _gen_name 完全一致：数量 != 1 时写 名*数量）。
func PackRuleGenName(items []map[string]any) string {
	parts := []string{}
	for _, it := range items {
		name := strings.TrimSpace(ToStr(it["name"]));
		q := ToFloat(it["quantity"])
		if q == 0 {
			q = 1
		}
		if q != 1 {
			parts = append(parts, name+"*"+PyFloat(q))
		} else {
			parts = append(parts, name)
		}
	}
	return strings.Join(parts, ",")
}

// packRuleBoxTypeToItems 把 '7号+8号' / '6号*2+7号*2' 解析成 [{name, quantity}]（对齐 Python _box_type_to_items）。
func packRuleBoxTypeToItems(boxType string) []map[string]any {
	out := []map[string]any{}
	for _, part := range strings.Split(boxType, "+") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, qty := part, 1.0
		if m := packRuleQtySuffixRe.FindStringSubmatch(part); m != nil {
			name = part[:len(part)-len(m[0])]
			qty = float64(ToInt(m[1]))
		}
		if name != "" {
			out = append(out, map[string]any{"name": name, "quantity": qty})
		}
	}
	return out
}

var packRuleQtySuffixRe = regexp.MustCompile(`\*([0-9]+)$`)

// packRuleBoxTypeOf 由箱条目生成箱型号文本：'7号' / '6号*2+7号*2'（对齐 Python _box_type_from_items）。
func packRuleBoxTypeOf(items []map[string]any) string {
	parts := []string{}
	for _, it := range items {
		q := int(math.Trunc(ToFloat(it["quantity"])))
		if q > 1 {
			parts = append(parts, ToStr(it["name"])+"*"+strconv.Itoa(q))
		} else {
			parts = append(parts, ToStr(it["name"]))
		}
	}
	return strings.Join(parts, "+")
}

// modelFromBoxProduct 包材商品名 → 箱型号显示名：'3号纸箱'→'3号'；'松茸6号箱'→'松茸6号'。
func modelFromBoxProduct(name string) string {
	n := strings.TrimSpace(name)
	if strings.HasSuffix(n, "纸箱") {
		return strings.TrimSuffix(n, "纸箱")
	}
	if strings.HasSuffix(n, "号箱") {
		return strings.TrimSuffix(n, "箱")
	}
	return n
}

// resolveBoxProduct 按箱型号名匹配包材商品：精确 / +'纸箱' / +'箱'。
func resolveBoxProduct(ctx context.Context, q Querier, name string) *Product {
	for _, cand := range []string{name, name + "纸箱", name + "箱"} {
		if p, err := productByName(ctx, q, cand); err == nil && p != nil {
			return p
		}
	}
	return nil
}

func productByName(ctx context.Context, q Querier, name string) (*Product, error) {
	row := q.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products WHERE name = ? LIMIT 1", name)
	p, err := scanProduct(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return p, nil
}

// linkBoxItems 把箱条目关联到包材商品：有 product_id 则校验，否则按型号名解析（对齐 Python _link_box_items）。
func linkBoxItems(ctx context.Context, q Querier, items []map[string]any) []map[string]any {
	out := []map[string]any{}
	for _, it := range items {
		name := strings.TrimSpace(ToStr(it["name"]))
		qty := ToFloat(it["quantity"])
		if qty == 0 {
			qty = 1
		}
		var p *Product
		if pid := ToInt(it["product_id"]); pid != 0 {
			got, err := GetProduct(ctx, q, pid)
			if err == nil {
				p = got
			}
		}
		if p == nil {
			p = resolveBoxProduct(ctx, q, name)
		}
		row := map[string]any{"quantity": qty}
		if p != nil {
			row["product_id"] = p.ID
			row["name"] = modelFromBoxProduct(p.Name)
		} else {
			row["product_id"] = nil
			row["name"] = name
		}
		out = append(out, row)
	}
	return out
}

// anyPtrInt 把 *int 变成 JSON 友好的 any（nil → null，用于落库/回显）。
func anyPtrInt(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

// optFloatDefault 取可选浮点，缺省/null 用 def（对齐 Pydantic 的字段默认值）。
func optFloatDefault(m map[string]any, k string, def float64) float64 {
	if v := OptFloat(m, k); v != nil {
		return *v
	}
	return def
}

// normalizePackRule 校验 + 补全（用商品真名覆盖传入名，箱型/箱量互相推导）。
func normalizePackRule(ctx context.Context, q Querier, body map[string]any) (map[string]any, error) {
	items := MapSlice(body["items"])
	if len(items) == 0 {
		return nil, ErrText("至少需要一条组合商品")
	}
	norm := []map[string]any{}
	// 校验顺序与 Python _validate_items 一致：名称 → 数量 → 订单商品 → 库存大类 → 扣减倍数。
	for _, it := range items {
		name := strings.TrimSpace(ToStr(it["name"]))
		if name == "" {
			return nil, ErrText("组合商品名不能为空")
		}
		qty := 1.0
		if v := OptFloat(it, "quantity"); v != nil {
			qty = *v
		}
		if qty <= 0 {
			return nil, ErrText("商品「%s」的数量必须大于 0", name)
		}
		// product_id：Python 用「真值」判断（0/null/缺省都不校验），但落库保留原值
		pid := OptInt(it, "product_id")
		if pid != nil && *pid != 0 {
			p, err := GetProduct(ctx, q, *pid)
			if err != nil || p == nil {
				return nil, ErrText("关联的订单商品「%s」不存在", name)
			}
			name = p.Name // 关联时以订单商品名称为准
		}
		mult := 1.0
		if v := OptFloat(it, "multiplier"); v != nil {
			mult = *v
		}
		row := map[string]any{"product_id": anyPtrInt(pid), "name": name, "quantity": qty}
		if sp := OptInt(it, "stock_product_id"); sp != nil { // 传了就要校验，0 也算「传了」
			target, err := GetProduct(ctx, q, *sp)
			if err != nil || target == nil {
				return nil, ErrText("关联的库存商品（大类）不存在")
			}
			if target.ProductType != "stock" {
				return nil, ErrText("「%s」不是库存大类，出库扣减目标必须是库存商品（大类）", target.Name)
			}
			row["stock_product_id"] = *sp
		} else {
			row["stock_product_id"] = nil
		}
		if mult <= 0 {
			return nil, ErrText("商品「%s」的扣减倍数必须大于 0", name)
		}
		row["multiplier"] = mult
		norm = append(norm, row)
	}
	// 箱型/箱条目：与 Python _prepare 一致——请求给了 box_items 就用它，
	// 否则从 box_type 反推；带出条目后回写 box_type（原始 box_type 会被覆盖）。
	boxType := strings.TrimSpace(ToStr(body["box_type"]))
	boxItems := []map[string]any{}
	for _, b := range MapSlice(body["box_items"]) { // BoxItemIn 只有三字段，多余键按 Pydantic 丢弃
		boxItems = append(boxItems, map[string]any{
			"product_id": anyPtrInt(OptInt(b, "product_id")),
			"name":       ToStr(b["name"]),
			"quantity":   optFloatDefault(b, "quantity", 1.0),
		})
	}
	if len(boxItems) == 0 {
		boxItems = packRuleBoxTypeToItems(boxType)
	}
	if len(boxItems) > 0 {
		boxItems = linkBoxItems(ctx, q, boxItems)
		boxType = packRuleBoxTypeOf(boxItems)
	} else {
		boxType = ""
	}
	for _, it := range boxItems {
		qty := ToFloat(it["quantity"])
		if qty == 0 {
			qty = 1
		}
		if qty <= 0 {
			return nil, ErrText("箱型「%s」的数量必须大于 0", ToStr(it["name"]))
		}
	}
	ratio := ToFloat(body["box_ratio"])
	if ratio == 0 {
		ratio = 1
	}
	var labor any
	if HasKey(body, "labor_price") && body["labor_price"] != nil {
		labor = ToFloat(body["labor_price"])
	}
	isActive := true;
	if HasKey(body, "is_active") {
		isActive = ToBool(body["is_active"])
	}
	return map[string]any{"name": PackRuleGenName(norm), "items": norm, "box_type": boxType,
		"box_items": boxItems, "labor_price": labor, "box_ratio": ratio,
		"remark": strings.TrimSpace(ToStr(body["remark"])), "is_active": isActive}, nil
}

// CreatePackRule 新增打包规则（同名组合键已存在则拒）。
func CreatePackRule(ctx context.Context, q Querier, body map[string]any) (map[string]any, error) {
	r, err := normalizePackRule(ctx, q, body)
	if err != nil {
		return nil, err
	}
	name := ToStr(r["name"]);
	if name == "" {
		return nil, ErrText("组合商品名不能为空")
	}
	var dup int
	_ = q.QueryRowContext(ctx, "SELECT id FROM pack_rules WHERE name = ?", name).Scan(&dup)
	if dup != 0 {
		return nil, ErrText("该一单多货组合「%s」已存在", name)
	}
	var labor any
	if v := r["labor_price"]; v != nil {
		labor = ToFloat(v)
	}
	_, err = q.ExecContext(ctx, "INSERT INTO pack_rules (name, items, box_type, box_items, labor_price, box_ratio, remark, is_active, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
		name, EncodeJSONColumn(r["items"]), r["box_type"], EncodeJSONColumn(r["box_items"]), labor, r["box_ratio"], r["remark"], b2i(r["is_active"].(bool)), NowDB())
	if err != nil {
		return nil, err
	}
	var id int
	_ = q.QueryRowContext(ctx, "SELECT id FROM pack_rules WHERE name = ?", name).Scan(&id)
	r["id"] = id
	r["created_at"] = isoStamp(NowDB())
	return r, nil
}

// UpdatePackRule 修改打包规则（重新生成组合键，仍保持唯一）。
func UpdatePackRule(ctx context.Context, q Querier, id int, body map[string]any) (map[string]any, error) {
	var old PackRule
	var act int
	row := q.QueryRowContext(ctx, "SELECT "+packRuleColumns+" FROM pack_rules WHERE id = ?", id)
	if err := row.Scan(&old.ID, &old.Name, &old.Items, &old.BoxType, &old.BoxItems, &old.LaborPrice, &old.BoxRatio, &old.Remark, &act, &old.CreatedAt); err == sql.ErrNoRows {
		return nil, Err404("规则不存在")
	} else if err != nil {
		return nil, err
	}
	r, err := normalizePackRule(ctx, q, body)
	if err != nil {
		return nil, err
	}
	name := ToStr(r["name"]);
	var dup int
	_ = q.QueryRowContext(ctx, "SELECT id FROM pack_rules WHERE name = ? AND id <> ?", name, id).Scan(&dup)
	if dup != 0 {
		return nil, ErrText("该一单多货组合「%s」已存在", name)
	}
	var labor any
	if v := r["labor_price"]; v != nil {
		labor = ToFloat(v)
	}
	_, err = q.ExecContext(ctx, "UPDATE pack_rules SET name = ?, items = ?, box_type = ?, box_items = ?, labor_price = ?, box_ratio = ?, remark = ?, is_active = ? WHERE id = ?",
		name, EncodeJSONColumn(r["items"]), r["box_type"], EncodeJSONColumn(r["box_items"]), labor, r["box_ratio"], r["remark"], b2i(r["is_active"].(bool)), id)
	if err != nil {
		return nil, err
	}
	r["id"] = id
	r["created_at"] = isoStamp(old.CreatedAt)
	return r, nil
}

// DeletePackRule 删除打包规则。
func DeletePackRule(ctx context.Context, q Querier, id int) error {
	res, err := q.ExecContext(ctx, "DELETE FROM pack_rules WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return Err404("规则不存在")
	}
	return nil
}

// SortedNames 名称升序（候选清单用）。
func SortedNames(list []string) []string {
	out := append([]string{}, list...)
	sort.Strings(out)
	return out
}

// SeedUnits 单位表为空时播种标准单位（GET /api/units 每次调用都会先做这件事）。
func SeedUnits(ctx context.Context, q Querier) error {
	var n int
	if err := q.QueryRowContext(ctx, "SELECT COUNT(1) FROM units").Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	weight := [][2]any{{"克", 1.0}, {"斤", 500.0}, {"公斤", 1000.0}, {"千克", 1000.0}}
	count := []string{"个", "包", "袋", "盒", "箱", "件", "份"}
	for _, w := range weight {
		if _, err := q.ExecContext(ctx, "INSERT INTO units (name, category, gram_per_unit, is_standard) VALUES (?, ?, ?, 1)", w[0], "weight", w[1]); err != nil {
			return err
		}
	}
	for _, cn := range count {
		if _, err := q.ExecContext(ctx, "INSERT INTO units (name, category, gram_per_unit, is_standard) VALUES (?, ?, NULL, 1)", cn, "count"); err != nil {
			return err
		}
	}
	return nil
}

// isoStamp 把库里的 "YYYY-MM-DD HH:MM:SS.ffffff" 转成 Python datetime.isoformat() 的 "T" 形式。
func isoStamp(s string) string {
	s = NormalizeStamp(strings.TrimSpace(s))
	if len(s) < 11 || s[10] != ' ' {
		return s
	}
	return s[:10] + "T" + s[11:]
}
