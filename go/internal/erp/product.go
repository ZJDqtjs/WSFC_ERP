package erp

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// 商品（大类/小类）读写：字段口径与 Python routers/products.py 完全一致。
// 商品是跨仓共享的「主数据」，但每个分仓各存一份（与 Python 一样按分仓库读写）。

// LastIn 是某商品最近一次录入的入库价（入库时前端自动带出）。
type LastIn struct {
	BasePrice float64
	Unit      string
	UnitPrice float64
	Date      string
}

// LastInMap 一次查询算出所有商品的最近入库价：「最近」= 按录入顺序 id 最大那条（补录旧日期也算最后录的）。
func LastInMap(ctx context.Context, q Querier) (map[int]LastIn, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT i.product_id, i.unit, i.unit_price, i.date, COALESCE(p.conversions,'') FROM inbounds i " +
		"JOIN (SELECT product_id, MAX(id) mid FROM inbounds GROUP BY product_id) t ON t.mid = i.id " +
		"LEFT JOIN products p ON p.id = i.product_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]LastIn{}
	for rows.Next() {
		var pid int
		var unit, date string
		var price float64
		var conv sql.NullString
		if err := rows.Scan(&pid, &unit, &price, &date, &conv); err != nil {
			return nil, err
		}
		f := 1.0
		if v, ok := decodeFloatMap(conv.String)[unit]; ok && v != 0 {
			f = v
		}
		out[pid] = LastIn{BasePrice: Round(price/f, 8), Unit: unit, UnitPrice: price, Date: date}
	}
	return out, rows.Err()
}

// ProductJSON 输出一个商品（与 _to_dict 的键序/缺省一致）。lastIn 传 nil 表示不带入库价；
// lastDates 是预取的「库存商品最近一次采购入库日期」，传 nil 时按本商品的方案清单现查。
func (p *Product) ProductJSON(ctx context.Context, q Querier, lastIn map[int]LastIn, lastDates map[int]string) map[string]any {
	spName := ""
	if p.StockProductID != nil && *p.StockProductID > 0 && q != nil {
		if sp, err := GetProduct(ctx, q, *p.StockProductID); err == nil && sp != nil {
			spName = sp.Name
		}
	}
	var li LastIn
	if lastIn != nil {
		li = lastIn[p.ID]
	}
	raw := p.StockLinks
	if len(raw) == 0 && p.StockProductID != nil && *p.StockProductID > 0 {
		m := p.Multiplier
		if m == 0 {
			m = 1
		}
		raw = []StockLink{{ProductID: *p.StockProductID, Multiplier: m}}
	}
	links := []map[string]any{}
	for _, it := range raw {
		if q == nil || it.ProductID == 0 {
			continue
		}
		sp, err := GetProduct(ctx, q, it.ProductID)
		if err != nil || sp == nil {
			continue
		}
		mult := it.Multiplier
		if mult == 0 {
			mult = 1
		}
		du := sp.DefaultUnit
		if du == "" {
			du = sp.BaseUnit
		}
		links = append(links, map[string]any{"product_id": sp.ID, "name": sp.Name, "category": sp.Category,
			"multiplier": mult, "default_unit": du})
	}
	conv := p.Conversions
	if conv == nil {
		conv = map[string]float64{}
	}
	// 多套扣减方案：每个扣减项带上库存商品名/大类/展示单位与「最近一次采购入库」日期，
	// 前端据此提示出库会自动选哪一套。
	schemes := []map[string]any{}
	if len(p.StockSchemes) > 0 && q != nil {
		dates := lastDates
		if dates == nil {
			ids := []int{}
			for _, s := range p.StockSchemes {
				for _, it := range s.Links {
					ids = append(ids, it.ProductID)
				}
			}
			dates, _ = LatestInboundDates(ctx, q, ids)
		}
		for i, s := range p.StockSchemes {
			sLinks := []map[string]any{}
			for _, it := range s.Links {
				if it.ProductID == 0 {
					continue
				}
				sp, err := GetProduct(ctx, q, it.ProductID)
				if err != nil || sp == nil {
					continue
				}
				mult := it.Multiplier
				if mult == 0 {
					mult = 1
				}
				du := sp.DefaultUnit
				if du == "" {
					du = sp.BaseUnit
				}
				sLinks = append(sLinks, map[string]any{"product_id": sp.ID, "name": sp.Name, "category": sp.Category,
					"multiplier": mult, "default_unit": du, "last_in_date": dates[sp.ID]})
			}
			if len(sLinks) == 0 {
				continue
			}
			name := strings.TrimSpace(s.Name)
			if name == "" {
				name = fmt.Sprintf("方案%d", i+1)
			}
			schemes = append(schemes, map[string]any{"name": name, "links": sLinks})
		}
	}
	packs := p.PackItems
	if packs == nil {
		packs = []PackItem{}
	}
	workload := p.Workload
	var spID any
	if p.StockProductID != nil && *p.StockProductID > 0 {
		spID = *p.StockProductID
	}
	return map[string]any{
		"id": p.ID, "code": p.Code, "name": p.Name, "category": p.Category,
		"product_type": p.ProductType, "base_unit": p.BaseUnit, "default_unit": p.DefaultUnit,
		"spec": p.Spec, "sale_price": p.SalePrice, "unit_cost": p.UnitCost,
		"last_in_price": li.BasePrice, "last_in_unit": li.Unit, "last_in_unit_price": li.UnitPrice,
		"last_in_date": li.Date, "weight_kg": p.WeightKg, "free_shipping": p.FreeShipping,
		"conversions": conv, "pack_items": packs, "pack_fee": p.PackFee,
		"stock_product_id": spID, "stock_product_name": spName, "multiplier": p.Multiplier,
		"stock_links": links, "stock_schemes": schemes, "is_active": p.IsActive, "stock": p.Stock,
		"avg_cost": p.AvgCost, "stock_value": p.StockValue, "workload": workload,
	}
}

// ListProductJSON 商品列表（含最近入库价，一次查询避免 N+1）。
func ListProductJSON(ctx context.Context, q Querier) ([]map[string]any, error) {
	items, err := ListProducts(ctx, q)
	if err != nil {
		return nil, err
	}
	lastIn, err := LastInMap(ctx, q)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(items))
	for _, p := range items {
		out = append(out, p.ProductJSON(ctx, q, lastIn, nil))
	}
	return out, nil
}

// ProductIn 是 POST/PUT /api/products 的请求体（字段名与 ProductIn 模型一致）。
type ProductIn struct {
	Code           string
	Name           string
	Category       string
	ProductType    string
	BaseUnit       string
	DefaultUnit    string
	Spec           string
	SalePrice      float64
	UnitCost       float64
	WeightKg       float64
	FreeShipping   bool
	Conversions    map[string]float64
	PackItems      []PackItem
	PackFee        float64
	StockProductID int
	Multiplier     float64
	StockLinks     []StockLink
	LinksProvided  bool
	// StockSchemes 多套扣减方案；SchemesProvided 区分「没传（保留原方案）」与「传了 []（清空）」。
	StockSchemes   []StockScheme
	SchemesGiven   bool
	IsActive       bool
	// UnitChangeRatio：跨类别改基础单位（计数「个」↔ 重量「克」）时的换算关系，
	// 1 旧基础单位 = N 新基础单位；已有历史单据时必填（见 RescaleBaseUnitChange）。
	UnitChangeRatio float64
	// CodeTakeover：编码冲突时是否「替换」（True = 清空占用方编码、改给当前商品）；
	// 不传则冲突返回 409，让前端弹「替换编码」按钮。
	CodeTakeover bool
}

// ParseProductIn 从请求体解析（保留「字段是否出现」的语义：stock_links 未传时不能当成空数组）。
func ParseProductIn(body map[string]any) *ProductIn {
	in := &ProductIn{
		Code: ToStr(body["code"]), Name: ToStr(body["name"]), Category: ToStr(body["category"]),
		ProductType: ToStr(body["product_type"]), BaseUnit: ToStr(body["base_unit"]),
		DefaultUnit: ToStr(body["default_unit"]), Spec: ToStr(body["spec"]),
		SalePrice: ToFloat(body["sale_price"]), UnitCost: ToFloat(body["unit_cost"]),
		WeightKg: ToFloat(body["weight_kg"]), FreeShipping: ToBool(body["free_shipping"]),
		PackFee: ToFloat(body["pack_fee"]), Multiplier: ToFloat(body["multiplier"]),
		UnitChangeRatio: ToFloat(body["unit_change_ratio"]),
		CodeTakeover:    ToBool(body["code_takeover"]),
	}
	if in.ProductType == "" {
		in.ProductType = "stock"
	}
	if in.BaseUnit == "" {
		in.BaseUnit = "克"
	}
	if HasKey(body, "multiplier") {
		in.Multiplier = ToFloat(body["multiplier"])
	} else {
		in.Multiplier = 1.0
	}
	if v := ToInt(body["stock_product_id"]); v > 0 {
		in.StockProductID = v
	}
	if raw, ok := body["conversions"].(map[string]any); ok {
		in.Conversions = AnyToFloatMap(raw)
	}
	if raw, ok := body["pack_items"].([]any); ok {
		for _, it := range raw {
			m, ok := it.(map[string]any)
			if !ok {
				continue
			}
			u := ToStr(m["unit"])
			if u == "" {
				u = "个"
			}
			in.PackItems = append(in.PackItems, PackItem{ProductID: ToInt(m["product_id"]), Quantity: ToFloat(m["quantity"]), Unit: u})
		}
	}
	if links, ok := body["stock_links"].([]any); ok {
		in.LinksProvided = true
		for _, it := range links {
			m, ok := it.(map[string]any)
			if !ok {
				continue
			}
			// 只有「没写 multiplier」才取默认 1.0；显式传 0 / 负数要留给校验层报中文错，
			// 否则前端填 0 会被静悄悄改成 1（Python 端 Pydantic 就是这个语义）。
			mult := 1.0
			if HasKey(m, "multiplier") {
				mult = ToFloat(m["multiplier"])
			}
			in.StockLinks = append(in.StockLinks, StockLink{ProductID: ToInt(m["product_id"]), Multiplier: mult})
		}
	}
	// stock_schemes：null = 未提供（保留原方案），[] = 清空（只剩 stock_links 那一套）
	if raw, ok := body["stock_schemes"].([]any); ok {
		in.SchemesGiven = true
		for _, it := range raw {
			m, ok := it.(map[string]any)
			if !ok {
				continue
			}
			sch := StockScheme{Name: ToStr(m["name"])}
			if ls, ok := m["links"].([]any); ok {
				for _, l := range ls {
					lm, ok := l.(map[string]any)
					if !ok {
						continue
					}
					mult := 1.0
					if HasKey(lm, "multiplier") {
						mult = ToFloat(lm["multiplier"])
					}
					sch.Links = append(sch.Links, StockLink{ProductID: ToInt(lm["product_id"]), Multiplier: mult})
				}
			}
			in.StockSchemes = append(in.StockSchemes, sch)
		}
	}
	if v, ok := body["is_active"].(bool); ok {
		in.IsActive = v
	} else {
		in.IsActive = true
	}
	return in
}

// ValidateStockLinks 校验订单商品→库存商品的扣减关联（支持多条，重复只留第一条）；
// 未显式提供 stock_links 时回退旧的单关联字段。
func ValidateStockLinks(ctx context.Context, q Querier, in *ProductIn) ([]StockLink, error) {
	raw := in.StockLinks
	if !in.LinksProvided {
		if in.StockProductID == 0 {
			return nil, nil
		}
		raw = []StockLink{{ProductID: in.StockProductID, Multiplier: in.Multiplier}}
	}
	out := []StockLink{}
	seen := map[int]bool{}
	for _, it := range raw {
		sp, err := GetProduct(ctx, q, it.ProductID)
		if err != nil || sp == nil {
			return nil, ErrText("关联的库存商品不存在")
		}
		if sp.ProductType != "stock" {
			return nil, ErrText("只能关联「库存商品」（大类）作为扣减对象")
		}
		if seen[sp.ID] {
			continue
		}
		mult := it.Multiplier
		if mult <= 0 {
			return nil, ErrText("「%s」的扣减倍数必须大于 0", sp.Name)
		}
		seen[sp.ID] = true
		out = append(out, StockLink{ProductID: sp.ID, Multiplier: mult})
	}
	return out, nil
}

// ValidateStockSchemes 校验并规范化「多套扣减方案」→ [{name, links:[{product_id, multiplier}]}]。
// 每套至少一个扣减项；库存商品必须是 stock、倍数 > 0，同一套里重复的只留第一项；方案名留空补「方案N」。
// 未提供（null）按空清单处理（Python 的 `if data.stock_schemes is None: return []`）。
func ValidateStockSchemes(ctx context.Context, q Querier, in *ProductIn) ([]StockScheme, error) {
	if !in.SchemesGiven {
		return []StockScheme{}, nil
	}
	out := []StockScheme{}
	for i, s := range in.StockSchemes {
		links := []StockLink{}
		seen := map[int]bool{}
		for _, it := range s.Links {
			sp, err := GetProduct(ctx, q, it.ProductID)
			if err != nil || sp == nil {
				return nil, ErrText("关联的库存商品不存在")
			}
			if sp.ProductType != "stock" {
				return nil, ErrText("只能关联「库存商品」（大类）作为扣减对象")
			}
			if seen[sp.ID] {
				continue
			}
			if it.Multiplier <= 0 {
				return nil, ErrText("「%s」的扣减倍数必须大于 0", sp.Name)
			}
			seen[sp.ID] = true
			links = append(links, StockLink{ProductID: sp.ID, Multiplier: it.Multiplier})
		}
		name := strings.TrimSpace(s.Name)
		if name == "" {
			name = fmt.Sprintf("方案%d", i+1)
		}
		if len(links) == 0 {
			return nil, ErrText("扣减方案「%s」至少要有一个扣减库存商品", name)
		}
		out = append(out, StockScheme{Name: name, Links: links})
	}
	return out, nil
}

// ProductCodeOwner 占用该编码的其他商品（编码一对一：trim 后精确匹配；空编码不校验）。
// excludeID 传 0 表示不排除任何商品（Python 的 `if exclude_id:` 语义）。
func ProductCodeOwner(ctx context.Context, q Querier, code string, excludeID int) (int, string, bool) {
	c := strings.TrimSpace(code)
	if c == "" {
		return 0, "", false
	}
	var (
		id   int
		name string
		err  error
	)
	if excludeID != 0 {
		err = q.QueryRowContext(ctx,
			"SELECT id, name FROM products WHERE TRIM(code) = ? AND id <> ? LIMIT 1", c, excludeID).Scan(&id, &name)
	} else {
		err = q.QueryRowContext(ctx, "SELECT id, name FROM products WHERE TRIM(code) = ? LIMIT 1", c).Scan(&id, &name)
	}
	if err != nil {
		return 0, "", false
	}
	return id, name, true
}

// TakeProductCode 校验商品编码是否被别的商品占着（编码一对一）。
// 被占用且没点「替换」→ 409（detail 带占用方，前端据此弹「替换编码」按钮）；
// takeover=true → 把原商品编码清空，编码改给当前商品。
func TakeProductCode(ctx context.Context, q Querier, code string, excludeID int, takeover bool) error {
	c := strings.TrimSpace(code)
	ownerID, ownerName, ok := ProductCodeOwner(ctx, q, c, excludeID)
	if !ok {
		return nil
	}
	if !takeover {
		return &DetailError{Code: 409, Body: NewJ().
			Set("message", fmt.Sprintf("编码「%s」已被商品「%s」使用（编码一对一）", c, ownerName)).
			Set("code_conflict", NewJ().
				Set("id", ownerID).
				Set("name", ownerName).
				Set("code", c))}
	}
	_, err := q.ExecContext(ctx, "UPDATE products SET code = '' WHERE id = ?", ownerID)
	return err
}

// CreateProduct 新建商品。
// 注意：Python 侧 ProductIn.name 只要求「必填字段存在」，空串允许（只用 strip 后查重/落库），
// 这里不能额外加「请填写商品名称」，否则同名空商品在两边行为不一致。
func CreateProduct(ctx context.Context, q Querier, in *ProductIn) (*Product, error) {
	var dup int
	if err := q.QueryRowContext(ctx, "SELECT COUNT(1) FROM products WHERE name = ?", strings.TrimSpace(in.Name)).Scan(&dup); err != nil {
		return nil, err
	}
	if dup > 0 {
		return nil, ErrText("商品「%s」已存在", in.Name)
	}
	if err := TakeProductCode(ctx, q, in.Code, 0, in.CodeTakeover); err != nil {
		return nil, err
	}
	if in.ProductType != "stock" && in.ProductType != "order" {
		return nil, ErrText("商品类型必须为 stock 或 order")
	}
	links, err := ValidateStockLinks(ctx, q, in)
	if err != nil {
		return nil, err
	}
	schemes, err := ValidateStockSchemes(ctx, q, in)
	if err != nil {
		return nil, err
	}
	if len(schemes) > 0 && len(links) == 0 {
		// 兼容：报表/移动端/需求预演算仍读 stock_links → 同步成第一套方案
		links = append([]StockLink{}, schemes[0].Links...)
	}
	conv := in.Conversions
	if len(conv) == 0 {
		conv = DefaultConversions(in.BaseUnit)
	}
	du := in.DefaultUnit
	if du == "" {
		du = in.BaseUnit
	}
	spID := 0
	mult := 1.0
	if len(links) > 0 {
		spID = links[0].ProductID
		mult = links[0].Multiplier
	}
	packs := in.PackItems
	if packs == nil {
		packs = []PackItem{}
	}
	free := 0
	if in.FreeShipping {
		free = 1
	}
	active := 0
	if in.IsActive {
		active = 1
	}
	res, err := q.ExecContext(ctx, "INSERT INTO products (code, name, category, product_type, base_unit, default_unit, spec, sale_price, unit_cost, weight_kg, free_shipping, conversions, pack_items, pack_fee, stock, avg_cost, stock_value, stock_product_id, multiplier, stock_links, stock_schemes, is_active, workload, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		strings.TrimSpace(in.Code), strings.TrimSpace(in.Name), strings.TrimSpace(in.Category), in.ProductType,
		in.BaseUnit, du, strings.TrimSpace(in.Spec), in.SalePrice, in.UnitCost, in.WeightKg, free,
		EncodeJSONColumn(conv), EncodeJSONColumn(packs), in.PackFee, 0, 0, 0, spArg(spID), mult, EncodeJSONColumn(links), EncodeJSONColumn(schemes), active, 0, NowDB())
	if err != nil {
		return nil, err
	}
	id64, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return GetProduct(ctx, q, int(id64))
}

// baseUnitCategory 基础单位归属的类别：重量类记「克」、计数类记「个」（同前端 deriveUnitPayload）。
func baseUnitCategory(base string) string {
	switch strings.ToLower(strings.TrimSpace(base)) {
	case "克", "g":
		return "weight"
	default:
		return "count"
	}
}

// RescaleBaseUnitChange 改「基础单位」时把已有历史数据按换算关系折算过来，返回实际用到的系数
// （没改 / 同类别 / 无历史 = 0）。
//
// 基础单位就是库存与成本的记账单位：库存流水 quantity_base、入库行 quantity_base、库存、
// 库存均价都按它记。前端把默认单位映射成基础单位（重量类→克、计数类→个），于是「个」改成
// 「公斤」其实是把基础单位从「个」换成「克」——只改字段不改数据的话，4 个变成 4 克、
// 均价 5 元/个变成 5 元/克，列表按默认单位换算后显示成 5000 元/公斤。
// 跨类别没有可自动推导的换算关系，所以要么由用户给「1 旧基础单位 = N 新基础单位」，
// 要么在完全没有历史数据时才允许直接改。只换数量、不动金额：批次绝对成本不变，
// 单位成本跟着数量一起换，换完由 FIFO 重算库存与均价（成本总额守恒）。
func RescaleBaseUnitChange(ctx context.Context, q Querier, p *Product, newBase string, ratio float64) (float64, error) {
	oldBase := strings.TrimSpace(p.BaseUnit)
	newBase = strings.TrimSpace(newBase)
	if newBase == "" || newBase == oldBase {
		return 0, nil
	}
	if baseUnitCategory(oldBase) == baseUnitCategory(newBase) {
		return 0, nil // 同类单位（都按同一规则记），不涉及跨类换算
	}
	var moves, inbs int
	if err := q.QueryRowContext(ctx, "SELECT COUNT(1) FROM stock_movements WHERE product_id = ?", p.ID).Scan(&moves); err != nil {
		return 0, err
	}
	if err := q.QueryRowContext(ctx, "SELECT COUNT(1) FROM inbounds WHERE product_id = ?", p.ID).Scan(&inbs); err != nil {
		return 0, err
	}
	stock := p.Stock
	if moves == 0 && inbs == 0 && math.Abs(stock) < 1e-9 {
		return 0, nil // 没有任何历史数据：改单位不会误解任何数字，直接改
	}
	if ratio <= 0 {
		return 0, ErrText("商品「%s」已有 %d 条库存流水、%d 条入库记录（当前库存 %s %s），从「%s」改成「%s」不是一个类别，历史数量与成本会被按新单位重新解读（均价会被放大 %s→%s 的倍数）。\n请填写换算关系：1 %s = ? %s；或先清理该商品的入库/出库单据后再改单位。",
			p.Name, moves, inbs, formatPyG(stock), oldBase, oldBase, newBase, oldBase, newBase, oldBase, newBase)
	}
	if _, err := q.ExecContext(ctx, "UPDATE stock_movements SET quantity_base = quantity_base * ? WHERE product_id = ?", ratio, p.ID); err != nil {
		return 0, err
	}
	if inbs > 0 {
		if _, err := q.ExecContext(ctx, "UPDATE inbounds SET quantity_base = quantity_base * ? WHERE product_id = ?", ratio, p.ID); err != nil {
			return 0, err
		}
	}
	return ratio, nil
}

// formatPyG 复刻 Python 的 f"{v:g}"（6 位有效数字，整数不带小数点）。
func formatPyG(v float64) string {
	return strconv.FormatFloat(v, 'g', 6, 64)
}

// UpdateProduct 全量覆盖更新商品；旧客户端不传 stock_links 且没改动单关联字段时保留原多关联清单。
func UpdateProduct(ctx context.Context, q Querier, pid int, in *ProductIn) (*Product, error) {
	p, err := GetProduct(ctx, q, pid)
	if err != nil {
		return nil, ErrNotFound
	}
	var dup int
	if err := q.QueryRowContext(ctx, "SELECT COUNT(1) FROM products WHERE name = ? AND id <> ?", strings.TrimSpace(in.Name), pid).Scan(&dup); err != nil {
		return nil, err
	}
	if dup > 0 {
		return nil, ErrText("商品「%s」已存在", in.Name)
	}
	// 编码一对一：只在「编码有变化」时校验（历史重复的编码不拦改名/改价，用户可点替换逐个理顺）
	if strings.TrimSpace(in.Code) != strings.TrimSpace(p.Code) {
		if err := TakeProductCode(ctx, q, in.Code, pid, in.CodeTakeover); err != nil {
			return nil, err
		}
	}
	if in.ProductType != "stock" && in.ProductType != "order" {
		return nil, ErrText("商品类型必须为 stock 或 order")
	}
	var links []StockLink
	if in.LinksProvided {
		links, err = ValidateStockLinks(ctx, q, in)
		if err != nil {
			return nil, err
		}
	} else if sameInt(in.StockProductID, derefInt(p.StockProductID)) && math.Abs(orOne(in.Multiplier)-orOne(p.Multiplier)) < 1e-9 {
		links = p.StockLinks
	} else {
		links, err = ValidateStockLinks(ctx, q, in)
		if err != nil {
			return nil, err
		}
	}
	// 多套扣减方案：未传（null）→ 保留原方案（兼容未升级客户端）；传 [] → 清空
	var schemes []StockScheme
	if in.SchemesGiven {
		schemes, err = ValidateStockSchemes(ctx, q, in)
		if err != nil {
			return nil, err
		}
	} else {
		schemes = append([]StockScheme{}, p.StockSchemes...)
	}
	if len(schemes) > 0 && len(links) == 0 {
		// 兼容：报表/移动端/需求预演算仍读 stock_links → 同步成第一套方案
		links = append([]StockLink{}, schemes[0].Links...)
	}
	spID := 0
	mult := 1.0
	if len(links) > 0 {
		spID = links[0].ProductID
		mult = links[0].Multiplier
	}
	// 换基础单位（计数↔重量）先校验并折算历史数据：不合格就整体报错，什么都不写
	unitK, err := RescaleBaseUnitChange(ctx, q, p, in.BaseUnit, in.UnitChangeRatio)
	if err != nil {
		return nil, err
	}
	conv := in.Conversions
	if len(conv) == 0 {
		conv = DefaultConversions(in.BaseUnit)
	}
	du := in.DefaultUnit
	if du == "" {
		du = in.BaseUnit
	}
	packs := in.PackItems
	if packs == nil {
		packs = []PackItem{}
	}
	free := 0
	if in.FreeShipping {
		free = 1
	}
	active := 0
	if in.IsActive {
		active = 1
	}
	_, err = q.ExecContext(ctx, "UPDATE products SET code=?, name=?, category=?, product_type=?, base_unit=?, default_unit=?, spec=?, sale_price=?, unit_cost=?, weight_kg=?, free_shipping=?, conversions=?, pack_items=?, pack_fee=?, stock_product_id=?, multiplier=?, stock_links=?, stock_schemes=?, is_active=? WHERE id=?",
		strings.TrimSpace(in.Code), strings.TrimSpace(in.Name), strings.TrimSpace(in.Category), in.ProductType,
		in.BaseUnit, du, strings.TrimSpace(in.Spec), in.SalePrice, in.UnitCost, in.WeightKg, free,
		EncodeJSONColumn(conv), EncodeJSONColumn(packs), in.PackFee, spArg(spID), mult, EncodeJSONColumn(links), EncodeJSONColumn(schemes), active, pid)
	if err != nil {
		return nil, err
	}
	if unitK != 0 {
		// 历史数量已按换算关系折算成新基础单位 → 库存/均价按新单位重算（FIFO，成本总额守恒）
		if err := RecomputeProduct(ctx, q, pid); err != nil {
			return nil, err
		}
	}
	return GetProduct(ctx, q, pid)
}

func sameInt(a, b int) bool { return (a == 0 && b == 0) || a == b }

func orOne(v float64) float64 {
	if v == 0 {
		return 1
	}
	return v
}

// spArg 0 表示 NULL（商品未关联库存大类）。
func spArg(v int) any {
	if v == 0 {
		return nil
	}
	return v
}

func derefInt(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

// ProductReferenceSources 列出阻止删除该商品的引用来源（人话版，供前端逐条展示）。
func ProductReferenceSources(ctx context.Context, q Querier, pid int) []string {
	out := []string{}
	add := func(format string, args ...any) { out = append(out, fmt.Sprintf(format, args...)) };
	count := func(query string, args ...any) int {
		var n int
		if err := q.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
			return 0
		}
		return n
	};
	if n := count("SELECT COUNT(1) FROM stock_movements WHERE product_id = ?", pid); n > 0 {
		var d, mt, remark string
		row := q.QueryRowContext(ctx, "SELECT date, move_type, COALESCE(remark,'') FROM stock_movements WHERE product_id = ? ORDER BY date DESC, id DESC LIMIT 1", pid)
		if err := row.Scan(&d, &mt, &remark); err == nil {
			detail := fmt.Sprintf("（最近一条：%s %s", d, mt)
			if strings.TrimSpace(remark) != "" {
				detail += "·" + firstRunes(strings.TrimSpace(remark), 30);
			}
			detail += "）"
			if nm := count("SELECT COUNT(1) FROM stock_movements WHERE product_id = ? AND ref_type = 'manual'", pid); nm > 0 {
				detail += fmt.Sprintf("；其中盘点调整 %d 条，可到「库存 → 盘点调整」删除对应记录", nm)
			}
			add("库存流水 %d 条%s", n, detail)
		}
	}
	if n := count("SELECT COUNT(1) FROM outbound_lines WHERE product_id = ?", pid); n > 0 {
		add("出库 / 销售明细 %d 行（最近单据：%s）", n, namesBrief(joinCodes(ctx, q, "SELECT o.code FROM outbounds o JOIN outbound_lines l ON l.outbound_id = o.id WHERE l.product_id = ? ORDER BY o.date DESC, o.id DESC LIMIT 3", pid)))
	}
	if n := count("SELECT COUNT(1) FROM inbounds WHERE product_id = ?", pid); n > 0 {
		add("入库单 %d 张（最近：%s）", n, namesBrief(joinCodes(ctx, q, "SELECT code FROM inbounds WHERE product_id = ? ORDER BY date DESC, id DESC LIMIT 3", pid)))
	}
	if n := count("SELECT COUNT(1) FROM finance_records WHERE product_id = ?", pid); n > 0 {
		add("财务流水 %d 条", n)
	}
	if n := count("SELECT COUNT(1) FROM code_mappings WHERE product_id = ?", pid); n > 0 {
		add("商品编码关联（平台编码映射）%d 条", n)
	}
	var wpLinked, wpPacks, pSub, pLinks, pPacks []string
	wrows, err := q.QueryContext(ctx, "SELECT name, COALESCE(stock_product_id,0), COALESCE(pack_items,'') FROM warehouse_products")
	if err == nil {
		for wrows.Next() {
			var name, packs string
			var spid int
			if err := wrows.Scan(&name, &spid, &packs); err != nil {
				continue
			}
			if spid == pid {
				wpLinked = append(wpLinked, name)
			}
			if ContainsInt(ExtractPackProductIDs(packs), pid) {
				wpPacks = append(wpPacks, name)
			}
		}
		wrows.Close()
	}
	prows, err := q.QueryContext(ctx, "SELECT name, COALESCE(stock_product_id,0), COALESCE(stock_links,''), COALESCE(pack_items,'') FROM products WHERE id <> ?", pid)
	if err == nil {
		for prows.Next() {
			var name, links, packs string
			var spid int
			if err := prows.Scan(&name, &spid, &links, &packs); err != nil {
				continue
			}
			if spid == pid {
				pSub = append(pSub, name);
			}
			if ContainsInt(ExtractPackProductIDs(links), pid) {
				pLinks = append(pLinks, name)
			}
			if ContainsInt(ExtractPackProductIDs(packs), pid) {
				pPacks = append(pPacks, name)
			}
		}
		prows.Close()
	}
	if len(wpLinked) > 0 {
		add("被入仓品当作「关联库存商品」：%s", namesBrief(wpLinked))
	}
	if len(wpPacks) > 0 {
		add("挂在入仓品的「关联结算（随货包材）」清单里：%s", namesBrief(wpPacks))
	}
	if len(pSub) > 0 {
		add("被订单商品当作「扣减库存商品」：%s", namesBrief(pSub))
	}
	if len(pLinks) > 0 {
		add("在订单商品的「扣减库存商品」清单里：%s", namesBrief(pLinks))
	}
	if len(pPacks) > 0 {
		add("在商品的「出库关联结算清单」里：%s", namesBrief(pPacks))
	}
	return out
}

// ExtractPackProductIDs 从 pack_items / stock_links 的 JSON 里取出所有 product_id。
func ExtractPackProductIDs(raw string) []int {
	out := []int{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	var arr []any
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		return out
	}
	for _, it := range arr {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		if pid := ToInt(m["product_id"]); pid > 0 {
			out = append(out, pid)
		}
	}
	return out
}

func ContainsInt(list []int, v int) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func joinCodes(ctx context.Context, q Querier, query string, pid int) []string {
	rows, err := q.QueryContext(ctx, query, pid)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err == nil {
			out = append(out, c)
		}
	}
	return out
}

// namesBrief 名称列表缩略展示：最多 4 个，超出用「…」。
func namesBrief(names []string) string {
	if len(names) == 0 {
		return "—"
	}
	out := []string{}
	for i, n := range names {
		if i >= 4 {
			break
		}
		if strings.TrimSpace(n) == "" {
			n = "—"
		}
		out = append(out, n)
	}
	res := strings.Join(out, "、")
	if len(names) > 4 {
		res += "…"
	}
	return res
}

func firstRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
