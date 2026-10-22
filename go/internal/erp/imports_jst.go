package erp

// ---------------- 聚水潭出库单：行解析、一单多货结算与草稿单 ----------------
//
// 对应 Python routers/imports.py 的 jushuitan_rows / parse_jushuitan_draft 及其私有 helper。
// 口径要点（改动前务必对照 Python）：
//   · 一单多货命中打包规则 → 按规则结算；未命中且含 ≥2 种商品时**不跳过**，回退逐商品关联结算；
//   · 平台名只匹配到「库存大类」不算解析失败，与未关联编码一样进「待匹配」列表；
//   · 收入分摊：有实收单价的行按 单价×数量 取值（总价超额时整体压缩），无单价的行分剩余实收；
//   · failed 里既有「失败」也有「提示」，靠 _issue_level 分级，failed_count 统计的是全部条目。

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

// impDefaultBrushFee brush.DEFAULT_BRUSH_FEE：放单仓「快递+包装固定费」的逐单预填值。
const impDefaultBrushFee = 3.6

// ImpJstRow jushuitan_rows 输出的一行（一条出库单）。
type ImpJstRow struct {
	DocNo     string
	Date      string
	Name      string
	Amount    float64
	Shop      string
	Express   string
	Track     string
	Seller    string
	Customer  string
	Warehouse string
}

// impJstSkip 跳过统计，键序与 Python 的 {"待出库","作废","其他"} 一致。
type impJstSkip struct {
	pending int
	voided  int
	other   int
}

func (s impJstSkip) JSON() orderedMap {
	return orderedMap{{"待出库", s.pending}, {"作废", s.voided}, {"其他", s.other}}
}

// Note 执行记录说明："待出库 3单、作废 1单"（计数为 0 的项不列，全为 0 时返回空串）。
func (s impJstSkip) Note() string {
	var parts []string
	for _, kv := range [][2]any{{"待出库", s.pending}, {"作废", s.voided}, {"其他", s.other}} {
		if n, _ := kv[1].(int); n != 0 {
			parts = append(parts, kv[0].(string)+" "+strconv.Itoa(n)+"单")
		}
	}
	return strings.Join(parts, "、")
}

// inc 等价 skip[status if status in skip else "其他"] += 1。
func (s *impJstSkip) inc(status string) {
	switch status {
	case "待出库":
		s.pending++
	case "作废":
		s.voided++
	default:
		s.other++
	}
}

// impJushuitanRows jushuitan_rows：statuses 为 nil 时接受全部状态（仅排除 作废/已删除/空）。
func impJushuitanRows(rows [][]any, statuses []string) ([]ImpJstRow, impJstSkip, error) {
	mapping, start := ImpDetectHeader(rows, ImpJushuitanCols)
	if len(mapping) == 0 || impIdx(mapping, "name") < 0 {
		return nil, impJstSkip{}, ErrText("未识别到聚水潭出库单表头（需包含「出库单号」「商品名称」等列）")
	}
	var out []ImpJstRow
	skip := impJstSkip{}
	for _, row := range rows[start:] {
		status := NormalizeJstStatus(ImpCell(row, impIdx(mapping, "status"), ""))
		if statuses == nil {
			if status == "作废" || status == "已删除" || status == "" {
				skip.inc(status)
				continue
			}
		} else if !ContainsStr(statuses, status) {
			skip.inc(status)
			continue
		}
		out = append(out, ImpJstRow{
			DocNo:     impGet(row, mapping, "doc_no"),
			Date:      ImpNormDate(impGet(row, mapping, "date")),
			Name:      impGet(row, mapping, "name"),
			Amount:    ImpToFloat(impGet(row, mapping, "amount"), 0),
			Shop:      impGet(row, mapping, "shop"),
			Express:   impGet(row, mapping, "express"),
			Track:     impGet(row, mapping, "track"),
			Seller:    impGet(row, mapping, "seller"),
			Customer:  impGet(row, mapping, "customer"),
			Warehouse: impGet(row, mapping, "warehouse"),
		})
	}
	return out, skip, nil
}

// impGetProduct db.get(Product, id)：id 空/取不到一律 nil（与 Python 的 db.get 返回 None 一致）。
func impGetProduct(ctx context.Context, q Querier, id any) *Product {
	n := ToInt(id)
	if n == 0 {
		return nil
	}
	p, err := GetProduct(ctx, q, n)
	if err != nil {
		return nil
	}
	return p
}

// impProductByNameOrCode select(Product).where(or_(name==v, code==v))：SQLite 按 rowid 取第一条。
func impProductByNameOrCode(ctx context.Context, q Querier, v string) *Product {
	row := q.QueryRowContext(ctx,
		"SELECT "+productColumns+" FROM products WHERE name = ? OR code = ? ORDER BY id LIMIT 1", v, v)
	p, err := scanProduct(row.Scan)
	if err != nil {
		return nil
	}
	return p
}

// impResolveJstProduct _resolve_jst_product：外部商品名 → 系统商品。
// 优先编码关联指向的订单小类；关联指向大类（或没关联）时优先同名订单小类；再回退按名称/编码精确匹配。
func impResolveJstProduct(ctx context.Context, q Querier, byCode map[string]*ImpCodeMapping, extName string) *Product {
	var mapped *Product
	if m := byCode[extName]; m != nil && m.ProductID != nil {
		mapped = impGetProduct(ctx, q, *m.ProductID)
	}
	if mapped != nil && mapped.ProductType != "stock" {
		return mapped
	}
	if same := productByNameAndType(ctx, q, extName, "order"); same != nil {
		return same
	}
	if mapped != nil {
		return mapped
	}
	return impProductByNameOrCode(ctx, q, extName)
}

// impCollectBatchUnitPrice _collect_batch_unit_price：从「单种商品」的订单推导每个商品的实收单价（每基础单位）。
// 组合单（含多种商品）与换算缺失的单不参与推导；同一商品多次命中时取第一个。
func impCollectBatchUnitPrice(ctx context.Context, q Querier, orders []ImpJstRow,
	byCode map[string]*ImpCodeMapping) (map[int]float64, error) {
	prices := map[int]float64{}
	for _, o := range orders {
		items := ParseJstName(o.Name)
		if len(items) == 0 || o.Amount == 0 {
			continue
		}
		pid, totalQb, invalid := 0, 0.0, false
		for _, it := range items {
			p := impResolveJstProduct(ctx, q, byCode, it.Name)
			if p == nil {
				invalid = true
				break
			}
			unit, perItem, ok := PickJstUnit(p, it.Name)
			if !ok {
				invalid = true
				break
			}
			if _, has := p.Conversions[unit]; !has {
				invalid = true
				break
			}
			qb, err := UnitToBase(p, unit, Round(it.Qty*perItem, 4))
			if err != nil {
				return nil, err
			}
			if pid == 0 {
				pid = p.ID
			} else if pid != p.ID {
				invalid = true
				break
			}
			totalQb += qb
		}
		if invalid || pid == 0 || totalQb <= 0 {
			continue
		}
		if _, seen := prices[pid]; !seen {
			prices[pid] = o.Amount / totalQb
		}
	}
	return prices, nil
}

// impLinePriceWeight _line_price_weight：该行分摊权重 = 单价×数量；完全无价格时退化为按数量占比。
func impLinePriceWeight(p *Product, qb float64, batchUnitPrice map[int]float64) float64 {
	price := batchUnitPrice[p.ID]
	if price == 0 {
		price = p.SalePrice
	}
	if price == 0 {
		price = p.AvgCost
	}
	if price == 0 {
		price = p.UnitCost
	}
	w := price * qb
	if w <= 0 {
		w = qb
	}
	return w
}

// ---------------- 一单多货（打包规则）----------------

// impComboKeyOf _jst_combo_key：((名称, 数量), ...) 按名称排序后的规范化键，条目顺序不影响匹配。
func impComboKeyOf(items [][2]any) string {
	trimmed := make([][2]any, len(items))
	for i, it := range items {
		trimmed[i] = [2]any{strings.TrimSpace(ToStr(it[0])), Round(ToFloat(it[1]), 6)}
	}
	sort.SliceStable(trimmed, func(i, j int) bool {
		a, b := trimmed[i], trimmed[j]
		if a[0].(string) != b[0].(string) {
			return a[0].(string) < b[0].(string)
		}
		return a[1].(float64) < b[1].(float64)
	})
	parts := make([]string, 0, len(trimmed))
	for _, it := range trimmed {
		parts = append(parts, it[0].(string)+"\x00"+strconv.FormatFloat(it[1].(float64), 'g', -1, 64))
	}
	return strings.Join(parts, "\x01")
}

// impQtyOr1 it.get("quantity", 1) or 1：缺键或 0/null 都按 1（Python 的 or 兜底口径）。
func impQtyOr1(m map[string]any) float64 {
	v, ok := m["quantity"]
	if !ok {
		return 1
	}
	f := ToFloat(v)
	if f == 0 {
		return 1
	}
	return f
}

// impLoadPackRuleMap _load_pack_rule_map：启用的「一单多货打包规则」，键为规范化组合键。
func impLoadPackRuleMap(ctx context.Context, q Querier) (map[string]*PackRule, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+packRuleColumns+" FROM pack_rules WHERE is_active = 1")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*PackRule{}
	for rows.Next() {
		var r PackRule
		var act int
		if err := rows.Scan(&r.ID, &r.Name, &r.Items, &r.BoxType, &r.BoxItems,
			&r.LaborPrice, &r.BoxRatio, &r.Remark, &act, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.IsActive = act != 0
		items := MapSlice(decodeJSONAny(r.Items))
		if len(items) == 0 {
			continue
		}
		named := true
		for _, it := range items {
			if strings.TrimSpace(ToStr(it["name"])) == "" {
				named = false
				break
			}
		}
		if !named {
			continue
		}
		keyItems := make([][2]any, 0, len(items))
		for _, it := range items {
			qty := 1.0
			if v, ok := it["quantity"]; ok {
				qty = ToFloat(v)
			}
			keyItems = append(keyItems, [2]any{it["name"], qty})
		}
		out[impComboKeyOf(keyItems)] = &r
	}
	return out, rows.Err()
}

// impResolveLaborProduct _resolve_labor_product：人工打包费商品（用于人工明细行溯源）。
func impResolveLaborProduct(ctx context.Context, q Querier) *Product {
	return productByNameAndType(ctx, q, "人工打包费", "人工")
}

// impPackSaleLine _pack_rule_settle 的 sale_lines 元素。
type impPackSaleLine struct {
	P              *Product
	Unit           string
	PerItem        float64
	Qty            float64
	ExtName        string
	Spec           string
	StockProductID *int
	Multiplier     float64
	QtyBase        float64
	raw            float64
	Amount         float64
	Price          float64
	GrossSales     float64
}

// impPackRuleSettle _pack_rule_settle：按一单多货规则生成 (销售行, 包材/人工行, 人工回退费用, 提示)。
func impPackRuleSettle(ctx context.Context, q Querier, rule *PackRule, orderItems []ImpJstItem) (
	[]*impPackSaleLine, []map[string]any, float64, []string, error) {
	qtyByName := map[string]float64{}
	for _, it := range orderItems {
		n := strings.TrimSpace(it.Name)
		qtyByName[n] += it.Qty
	}
	var saleLines []*impPackSaleLine
	var issues []string
	var salePids []int
	for _, raw := range MapSlice(decodeJSONAny(rule.Items)) {
		name := strings.TrimSpace(ToStr(raw["name"]))
		p := impGetProduct(ctx, q, raw["product_id"])
		if p == nil {
			issues = append(issues, "「"+name+"」未关联订单商品，请在一单多货规则中维护")
			continue
		}
		unit, perItem, ok := PickJstUnit(p, name)
		if !ok {
			issues = append(issues, "「"+name+"」未配置每件重量换算（如 1个=1000克 或 每件2斤）")
			continue
		}
		if _, has := p.Conversions[unit]; !has {
			issues = append(issues, "「"+name+"」换算单位「"+unit+"」未配置")
			continue
		}
		qv, has := qtyByName[name]
		if !has {
			qv = impQtyOr1(raw)
		}
		spec := JstSpecLabel(name, unit, perItem)
		if qv > 1 {
			spec += "，合并" + FmtQty(qv) + "件"
		}
		mult := ToFloat(raw["multiplier"])
		if mult == 0 {
			mult = 1
		}
		saleLines = append(saleLines, &impPackSaleLine{
			P: p, Unit: unit, PerItem: perItem, Qty: Round(qv*perItem, 4), ExtName: name,
			Spec: spec, StockProductID: OptInt(raw, "stock_product_id"), Multiplier: mult,
		})
		salePids = append(salePids, p.ID)
	}

	// 只有一个销售商品时，包材/人工行归属它（sale_product_id）；多货组合归属整单规则（留空）。
	distinct := uniqueIntsKeepOrder(salePids)
	var spID *int
	if len(distinct) == 1 {
		v := distinct[0]
		spID = &v
	}

	packLines := []map[string]any{}
	for _, b := range MapSlice(decodeJSONAny(rule.BoxItems)) {
		if !truthyPy(b["product_id"]) {
			continue
		}
		packLines = append(packLines, map[string]any{
			"product_id": b["product_id"], "unit": "个",
			"quantity": impQtyOr1(b), "name": ToStr(b["name"]),
			"sale_product_id": AsInt(spID), "cogs": nil,
		})
	}

	laborPrice := 0.0
	if rule.LaborPrice.Valid {
		laborPrice = rule.LaborPrice.Float64
	}
	laborFee := laborPrice
	if laborPrice != 0 {
		if lp := impResolveLaborProduct(ctx, q); lp != nil {
			packLines = append(packLines, map[string]any{
				"product_id": lp.ID, "unit": "单", "quantity": 1.0, "name": lp.Name,
				"sale_product_id": AsInt(spID), "cogs": laborPrice,
			})
			laborFee = 0
		} else {
			issues = append(issues, "未找到「人工打包费」商品，人工将按费用记入")
		}
	}
	return saleLines, packLines, laborFee, issues, nil
}

// impSettleRevenue _settle_revenue：把实收金额按权重分摊到各销售行（写回 QtyBase/Amount/Price）。
func impSettleRevenue(lines []*impPackSaleLine, revenue float64, priceMap map[int]float64) error {
	total := 0.0
	for _, ln := range lines {
		qb, err := UnitToBase(ln.P, ln.Unit, ln.Qty)
		if err != nil {
			return err
		}
		ln.QtyBase = qb
		ln.raw = impLinePriceWeight(ln.P, qb, priceMap)
		total += ln.raw
	}
	if total <= 0 {
		total = 0
		for _, ln := range lines {
			total += ln.QtyBase
			ln.raw = ln.QtyBase
		}
	}
	for _, ln := range lines {
		amt := 0.0
		if total != 0 {
			amt = Round(revenue*ln.raw/total, 2)
		}
		ln.Amount = amt
		if ln.Qty != 0 {
			ln.Price = Round(amt/ln.Qty, 4)
		}
	}
	return nil
}

// impSoftIssueKeys 「提示」类问题：单子照建，只是某个明细行没建出来 / 人工改成按费用记。
var impSoftIssueKeys = []string{
	"人工将按费用记入",
	"未关联订单商品",
	"未配置每件重量换算",
	"换算单位",
}

// impIssueLevel _issue_level：warn=提示（单子照建）/ fail=失败（这张单没建出来）。
func impIssueLevel(reason string) string {
	for _, k := range impSoftIssueKeys {
		if strings.Contains(reason, k) {
			return "warn"
		}
	}
	return "fail"
}

// ImpJstParseResult parse_jushuitan_draft 的返回值。
type ImpJstParseResult struct {
	Drafts         []ImpDraftOrder
	Failed         []map[string]any
	Skip           impJstSkip
	UnmappedCodes  []string
	Unmapped       []map[string]any
	UnmatchedMulti []map[string]any
}

// impUnmappedEntry unmapped_detail 里记一条待匹配商品（count==1 时才补 spec/reason，与 Python 一致）。
func impUnmappedEntry(detail map[string]map[string]any, seen map[string]bool, extName string) {
	seen[extName] = true
	d, ok := detail[extName]
	if !ok {
		d = map[string]any{"external_code": extName, "count": 0}
		detail[extName] = d
	}
	d["count"] = ToInt(d["count"]) + 1
	if ToInt(d["count"]) == 1 {
		d["spec"] = impSpecLabelFromName(extName)
	}
}

func impSpecLabelFromName(extName string) string {
	su, sq, _ := ParseJstSpec(extName)
	if su != "" && sq != 0 {
		return FmtQty(sq) + " " + su + "/件"
	}
	return ""
}

// ImpParseJstDraft parse_jushuitan_draft：聚水潭出库单 → 草稿单（不建单）。
// statuses 传 nil 表示接受全部状态（鲜货需求预演算用）。
func ImpParseJstDraft(ctx context.Context, q Querier, data []byte, userName string, statuses []string) (*ImpJstParseResult, error) {
	rows, err := ImpReadRows(data)
	if err != nil {
		return nil, err
	}
	orders, skip, err := impJushuitanRows(rows, statuses)
	if err != nil {
		return nil, err
	}
	list, err := impListCodeMappings(ctx, q, "", nil, "")
	if err != nil {
		return nil, err
	}
	byCode := map[string]*ImpCodeMapping{}
	for i := range list {
		byCode[list[i].ExternalCode] = &list[i]
	}

	drafts := []ImpDraftOrder{}
	failed := []map[string]any{}
	unmappedSeen := map[string]bool{}
	unmappedDetail := map[string]map[string]any{}
	type multiEntry struct {
		docNo string
		items []map[string]any
	}
	multi := map[string]*multiEntry{}
	var multiOrder []string

	ruleMap, err := impLoadPackRuleMap(ctx, q)
	if err != nil {
		return nil, err
	}
	shopDeductions := LoadShopDeductions()
	batchUnitPrice, err := impCollectBatchUnitPrice(ctx, q, orders, byCode)
	if err != nil {
		return nil, err
	}

	for _, o := range orders {
		orderItems := ParseJstName(o.Name)
		shopRule := shopDeductions[o.Shop]
		rule := ruleMap[impComboKeyOf(jstPairs(orderItems))]

		// 一单多货未命中规则时不再跳过（否则不扣库存），回退到逐商品关联结算路径，
		// 同时把这个组合记进 unmatched_multi 供前端提示「去配置规则」。
		if rule == nil && len(uniqueStrings(jstNames(orderItems))) > 1 {
			e := multi[o.DocNo]
			if e == nil {
				e = &multiEntry{docNo: o.DocNo}
				multi[o.DocNo] = e
				multiOrder = append(multiOrder, o.DocNo)
			}
			for _, it := range orderItems {
				base := impFindItem(e.items, it.Name)
				if base != nil {
					base["quantity"] = ToFloat(base["quantity"]) + it.Qty
					continue
				}
				e.items = append(e.items, map[string]any{
					"external_code": it.Name, "quantity": it.Qty,
					"suggest": SuggestCandidates(ctx, q, it.Name, 8),
				})
			}
		}

		if rule != nil {
			// 命中打包规则：用规则内维护的商品/纸箱/人工结算
			saleLines, packLines, labor, packIssues, err := impPackRuleSettle(ctx, q, rule, orderItems)
			if err != nil {
				return nil, err
			}
			for _, iss := range packIssues {
				failed = append(failed, map[string]any{"doc": o.DocNo, "reason": iss})
			}
			if len(saleLines) == 0 {
				failed = append(failed, map[string]any{"doc": o.DocNo, "reason": "一单多货规则未关联到可用商品"})
				continue
			}
			if err := impSettleRevenue(saleLines, o.Amount, batchUnitPrice); err != nil {
				return nil, err
			}
			for _, ln := range saleLines {
				ln.GrossSales = Round(ln.Amount, 2)
			}
			deducted := false
			if shopRule != nil {
				for _, ln := range saleLines {
					sid := 0
					if ln.StockProductID != nil {
						sid = *ln.StockProductID
					}
					pct := ShopLinePercent(shopRule, LineDeductStockCategory(ctx, q, ln.P, sid))
					if pct > 0 {
						ln.Amount = Round(ln.Amount*(1-pct/100.0), 2)
						ln.Price = 0
						if ln.Qty != 0 {
							ln.Price = Round(ln.Amount/ln.Qty, 4)
						}
						deducted = true
					}
				}
			}
			lines := make([]ImpDraftLine, 0, len(saleLines))
			for _, ln := range saleLines {
				gross := ln.GrossSales
				if gross == 0 { // ln.get("gross_sales") or ln["amount"]
					gross = ln.Amount
				}
				lines = append(lines, ImpDraftLine{
					ProductID: ln.P.ID, ProductName: ln.P.Name, Unit: ln.Unit,
					Quantity: ln.Qty, Price: ln.Price, Amount: ln.Amount, GrossSales: gross,
					Deduct:         "一单多货：“" + ln.ExtName + "”每件" + FmtQty(ln.PerItem) + ln.Unit,
					Spec:           ln.Spec,
					StockProductID: ln.StockProductID,
					Multiplier:     ln.Multiplier,
				})
			}
			note := ""
			if deducted {
				note = ShopDeductionNote(shopRule)
			}
			rid := rule.ID
			drafts = append(drafts, ImpDraftOrder{
				DocNo: o.DocNo, Date: o.Date,
				Customer: impFirstNonEmpty(o.Customer, o.Shop),
				Operator: impFirstNonEmpty(o.Seller, userName),
				Remark: "聚水潭导入 单" + o.DocNo + " " + o.Express + o.Track +
					"（一单多货·规则：" + rule.Name + "）" + note,
				PackFee: Round(labor, 2), PackRuleID: &rid, PackRuleName: rule.Name,
				PackLines: packLines, Lines: lines, Warehouse: o.Warehouse,
			})
			continue
		}

		type jstLine struct {
			p       *Product
			extName string
			unit    string
			perItem float64
			qty     float64
			qtyBase float64
		}
		var lines []jstLine
		for _, it := range orderItems {
			p := impResolveJstProduct(ctx, q, byCode, it.Name)
			if p == nil {
				impUnmappedEntry(unmappedDetail, unmappedSeen, it.Name)
				continue
			}
			if impFirstNonEmpty(p.ProductType, "stock") == "stock" {
				// 平台名只匹配到库存大类 ⇒ 这一行没有关联结算清单；不算失败，进待匹配列表
				impUnmappedEntry(unmappedDetail, unmappedSeen, it.Name)
				if ToInt(unmappedDetail[it.Name]["count"]) == 1 {
					d := unmappedDetail[it.Name]
					d["reason"] = "只匹配到库存大类「" + p.Name + "」，缺少关联结算的订单小类"
					d["stock_product_id"] = p.ID
					d["stock_product_name"] = p.Name
				}
				continue
			}
			unit, perItem, ok := PickJstUnit(p, it.Name)
			if !ok {
				failed = append(failed, map[string]any{"doc": o.DocNo,
					"reason": "「" + it.Name + "」未配置每件重量换算（如 1个=1000克 或 每件2斤），请在商品管理中补充换算后重试"})
				continue
			}
			if _, has := p.Conversions[unit]; !has {
				failed = append(failed, map[string]any{"doc": o.DocNo,
					"reason": "「" + it.Name + "」换算单位「" + unit + "」未配置"})
				continue
			}
			lines = append(lines, jstLine{p: p, extName: it.Name, unit: unit, perItem: perItem,
				qty: Round(it.Qty*perItem, 4)})
		}
		if len(lines) == 0 {
			failed = append(failed, map[string]any{"doc": o.DocNo, "reason": "无已关联商品（未关联编码）"})
			continue
		}

		qtyBases := make([]float64, len(lines))
		for i, ln := range lines {
			qb, err := UnitToBase(ln.p, ln.unit, ln.qty)
			if err != nil {
				return nil, err
			}
			lines[i].qtyBase = qb
			qtyBases[i] = qb
		}
		// 收入分摊：有售价的行按 单价×数量 取值（总价超出实收时按比例压缩），无售价的行分剩余实收
		ests := make([]float64, len(lines))
		for i, ln := range lines {
			est := batchUnitPrice[ln.p.ID]
			if est == 0 {
				est = ln.p.SalePrice
			}
			ests[i] = est
		}
		var pricedAmt, resQb float64
		var pricedIdx, resIdx []int
		for i := range lines {
			if ests[i] > 0 {
				pricedIdx = append(pricedIdx, i)
				pricedAmt += qtyBases[i] * ests[i]
			} else {
				resIdx = append(resIdx, i)
				resQb += qtyBases[i]
			}
		}
		ratio := 1.0
		if pricedAmt > o.Amount && pricedAmt > 0 {
			ratio = o.Amount / pricedAmt
		}
		alloc := make([]float64, len(lines))
		var pricedSum float64
		for _, i := range pricedIdx {
			alloc[i] = qtyBases[i] * ests[i] * ratio
			pricedSum += alloc[i]
		}
		residual := o.Amount - pricedSum
		for _, i := range resIdx {
			if resQb > 0 {
				alloc[i] = residual * qtyBases[i] / resQb
			} else {
				alloc[i] = residual / float64(len(resIdx))
			}
		}

		draftLines := make([]ImpDraftLine, 0, len(lines))
		deducted := false
		for i, ln := range lines {
			amt := Round(alloc[i], 2)
			grossAmount := amt
			if shopRule != nil {
				pct := ShopLinePercent(shopRule, LineDeductStockCategory(ctx, q, ln.p, 0))
				if pct > 0 {
					amt = Round(amt*(1-pct/100.0), 2)
					deducted = true
				}
			}
			price := 0.0
			if ln.qty != 0 {
				price = Round(amt/ln.qty, 4)
			}
			deduct := ""
			if ln.perItem != 0 {
				deduct = ln.extName + " 每件" + FmtQty(ln.perItem) + ln.unit
			}
			draftLines = append(draftLines, ImpDraftLine{
				ProductID: ln.p.ID, ProductName: ln.p.Name, Unit: ln.unit,
				Quantity: ln.qty, Price: price, Amount: amt, GrossSales: grossAmount,
				Deduct: deduct, Spec: JstSpecLabel(ln.extName, ln.unit, ln.perItem),
				Multiplier: 1.0,
			})
		}
		note := ""
		if deducted {
			note = ShopDeductionNote(shopRule)
		}
		drafts = append(drafts, ImpDraftOrder{
			DocNo: o.DocNo, Date: o.Date,
			Customer: impFirstNonEmpty(o.Customer, o.Shop),
			Operator: impFirstNonEmpty(o.Seller, userName),
			Remark:   "聚水潭导入 单" + o.DocNo + " " + o.Express + o.Track + note,
			PackFee:  0.0, Lines: draftLines, Warehouse: o.Warehouse,
		})
	}

	// 放单仓：确认框逐单预填「快递+包装固定费」默认值，用户可改；确认时以回传的 brush_fee 为准。
	feeDefault := Round(impDefaultBrushFee, 2)
	for i := range drafts {
		if IsBrushWarehouse(drafts[i].Warehouse) {
			drafts[i].BrushFeeAuto = feeDefault
		}
	}

	codes := make([]string, 0, len(unmappedSeen))
	for c := range unmappedSeen {
		codes = append(codes, c)
	}
	sort.Strings(codes)
	unmapped := make([]map[string]any, 0, len(codes))
	for _, code := range codes {
		d := unmappedDetail[code]
		d["suggest"] = SuggestCandidates(ctx, q, code, 8)
		unmapped = append(unmapped, d)
	}
	sort.SliceStable(unmapped, func(i, j int) bool {
		return ToInt(unmapped[i]["count"]) > ToInt(unmapped[j]["count"])
	})

	for _, f := range failed {
		f["level"] = impIssueLevel(ToStr(f["reason"]))
	}

	unmatched := make([]map[string]any, 0, len(multiOrder))
	for _, docNo := range multiOrder {
		unmatched = append(unmatched, map[string]any{"doc_no": docNo, "items": multi[docNo].items})
	}

	return &ImpJstParseResult{
		Drafts: drafts, Failed: failed, Skip: skip,
		UnmappedCodes: codes, Unmapped: unmapped, UnmatchedMulti: unmatched,
	}, nil
}

// ImpBrushDefaultFee 预览响应里的 brush_default_fee：放单仓「快递+包装固定费」的默认值。
func ImpBrushDefaultFee() float64 { return Round(impDefaultBrushFee, 2) }

// ImpJstOneShot POST /api/jushuitan/import（一键导入）：解析 + 立即落库，口径与出库页导入一致。
//
// 返回体照 Python 的 {**res, skip, failed, …}：_confirm_orders 的结果打底，再被解析侧统计覆盖
// failed / failed_count（即这两个键报的是「解析失败」而不是「建单失败」），
// logRes 是建单结果本身，执行记录留痕要用它（Python 传的是 res）。
// logRes 是建单结果本身，执行记录留痕要用它（Python 传的是 res）；note 是执行记录的「说明」文案。
func ImpJstOneShot(ctx context.Context, q Querier, data []byte, userName string) (body, logRes map[string]any, dates []string, note string, err error) {
	res, err := ImpParseJstDraft(ctx, q, data, userName, []string{"已出库"})
	if err != nil {
		return nil, nil, nil, "", err
	}
	dates = make([]string, 0, len(res.Drafts))
	for _, d := range res.Drafts {
		dates = append(dates, d.Date)
	}
	note = "由「导入与关联 → 一键导入」确认"
	if s := res.Skip.Note(); s != "" {
		note = "跳过（" + s + "）"
	}
	confirm, err := ImpConfirmOrders(ctx, q, res.Drafts, userName)
	if err != nil {
		return nil, nil, nil, "", err
	}
	body = map[string]any{}
	for k, v := range confirm {
		body[k] = v
	}
	body["skip"] = res.Skip.JSON()
	body["failed"] = res.Failed
	body["unmapped_codes"] = res.UnmappedCodes
	body["unmapped"] = res.Unmapped
	body["unmatched_multi"] = res.UnmatchedMulti
	body["failed_count"] = len(res.Failed)
	return body, confirm, dates, note, nil
}

// BrushWarehouses 预览响应里的 brush_warehouses：本次解析命中的放单仓（去重 + 排序）。
func (r *ImpJstParseResult) BrushWarehouses() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, d := range r.Drafts {
		if IsBrushWarehouse(d.Warehouse) && !seen[d.Warehouse] {
			seen[d.Warehouse] = true
			out = append(out, d.Warehouse)
		}
	}
	sort.Strings(out)
	return out
}

// JstRows 暴露行解析结果给 /api/jushuitan/parse 与预演算调用方。
func JstRows(ctx context.Context, q Querier, data []byte, statuses []string) ([]ImpJstRow, impJstSkip, error) {
	rows, err := ImpReadRows(data)
	if err != nil {
		return nil, impJstSkip{}, err
	}
	return impJushuitanRows(rows, statuses)
}

// CodeMappingsByCode 全量编码关联按外部名建表（同 Python 的 {m.external_code: m}，后者覆盖前者）。
func CodeMappingsByCode(ctx context.Context, q Querier) (map[string]*ImpCodeMapping, error) {
	list, err := impListCodeMappings(ctx, q, "", nil, "")
	if err != nil {
		return nil, err
	}
	out := map[string]*ImpCodeMapping{}
	for i := range list {
		out[list[i].ExternalCode] = &list[i]
	}
	return out, nil
}

func jstPairs(items []ImpJstItem) [][2]any {
	out := make([][2]any, 0, len(items))
	for _, it := range items {
		out = append(out, [2]any{it.Name, it.Qty})
	}
	return out
}

func jstNames(items []ImpJstItem) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}

func impFindItem(list []map[string]any, extName string) map[string]any {
	for _, m := range list {
		if ToStr(m["external_code"]) == extName {
			return m
		}
	}
	return nil
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func impFirstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
