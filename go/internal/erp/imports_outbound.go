package erp

// ---------------- 出库批量导入（/api/import/outbounds*）与草稿单确认 ----------------

import (
	"context"
	"strconv"
)

// ImpDraftLine 草稿出库明细行（等价 pydantic DraftLine，键序即字段声明序）。
type ImpDraftLine struct {
	ProductID      int
	ProductName    string
	Unit           string
	Quantity       float64
	Price          float64
	Amount         float64
	GrossSales     float64
	Deduct         string
	Spec           string
	StockProductID *int
	Multiplier     float64
}

func (l ImpDraftLine) JSON() map[string]any {
	return map[string]any{
		"product_id": l.ProductID, "product_name": l.ProductName, "unit": l.Unit,
		"quantity": l.Quantity, "price": l.Price, "amount": l.Amount,
		"gross_sales": l.GrossSales, "deduct": l.Deduct, "spec": l.Spec,
		"stock_product_id": AsInt(l.StockProductID), "multiplier": l.Multiplier,
	}
}

// ImpDraftOrder 草稿出库单（等价 pydantic DraftOrder）。
type ImpDraftOrder struct {
	DocNo        string
	Date         string
	Customer     string
	Operator     string
	Remark       string
	PackFee      float64
	PackRuleID   *int
	PackRuleName string
	PackLines    []map[string]any
	Warehouse    string
	BrushFeeAuto float64
	BrushCost    float64
	BrushFee     float64
	Lines        []ImpDraftLine
}

func (o ImpDraftOrder) JSON() map[string]any {
	lines := make([]map[string]any, 0, len(o.Lines))
	for _, l := range o.Lines {
		lines = append(lines, l.JSON())
	}
	packLines := o.PackLines
	if packLines == nil {
		packLines = []map[string]any{}
	}
	return map[string]any{
		"doc_no": o.DocNo, "date": o.Date, "customer": o.Customer,
		"operator": o.Operator, "remark": o.Remark, "pack_fee": o.PackFee,
		"pack_rule_id": AsInt(o.PackRuleID), "pack_rule_name": o.PackRuleName,
		"pack_lines": packLines, "warehouse": o.Warehouse,
		"brush_fee_auto": o.BrushFeeAuto, "brush_cost": o.BrushCost, "brush_fee": o.BrushFee,
		"lines": lines,
	}
}

// impDraftOrderFromMap 前端确认后回传的草稿单 → 结构体（校验层已把类型与默认值补齐）。
func impDraftOrderFromMap(m map[string]any) ImpDraftOrder {
	o := ImpDraftOrder{
		DocNo:        ToStr(m["doc_no"]),
		Date:         ToStr(m["date"]),
		Customer:     ToStr(m["customer"]),
		Operator:     ToStr(m["operator"]),
		Remark:       ToStr(m["remark"]),
		PackFee:      ToFloat(m["pack_fee"]),
		PackRuleName: ToStr(m["pack_rule_name"]),
		Warehouse:    ToStr(m["warehouse"]),
		BrushFeeAuto: ToFloat(m["brush_fee_auto"]),
		BrushCost:    ToFloat(m["brush_cost"]),
		BrushFee:     ToFloat(m["brush_fee"]),
		PackLines:    MapSlice(m["pack_lines"]),
		PackRuleID:   OptInt(m, "pack_rule_id"),
	}
	for _, raw := range MapSlice(m["lines"]) {
		o.Lines = append(o.Lines, ImpDraftLine{
			ProductID:      ToInt(raw["product_id"]),
			ProductName:    ToStr(raw["product_name"]),
			Unit:           ToStr(raw["unit"]),
			Quantity:       ToFloat(raw["quantity"]),
			Price:          ToFloat(raw["price"]),
			Amount:         ToFloat(raw["amount"]),
			GrossSales:     ToFloat(raw["gross_sales"]),
			Deduct:         ToStr(raw["deduct"]),
			Spec:           ToStr(raw["spec"]),
			StockProductID: OptInt(raw, "stock_product_id"),
			Multiplier:     ToFloat(raw["multiplier"]),
		})
	}
	return o
}

// ImpDraftOrdersFromPayload 校验后的 body.orders → 草稿单列表。
func ImpDraftOrdersFromPayload(payload map[string]any) []ImpDraftOrder {
	out := []ImpDraftOrder{}
	for _, raw := range MapSlice(payload["orders"]) {
		out = append(out, impDraftOrderFromMap(raw))
	}
	return out
}

// impParseOutboundDraft parse_outbound_draft：标准出库模板 → 草稿单（不建单）。
// 同一单号的行合并成一张单；单号留空则每行一单（键为 _r{行号}）。
func impParseOutboundDraft(ctx context.Context, q Querier, data []byte, userName string) ([]ImpDraftOrder, []map[string]any, error) {
	rows, err := ImpReadRows(data)
	if err != nil {
		return nil, nil, err
	}
	mapping, start := ImpDetectHeader(rows, ImpOutboundAliases)
	if _, has := mapping["product"]; !has || len(mapping) == 0 {
		return nil, nil, ErrText("未识别到出库表头（需包含「商品」列），请使用下载的出库导入模板")
	}
	type acc struct {
		order ImpDraftOrder
		fee   float64
	}
	var keys []string
	orders := map[string]*acc{}
	failed := []map[string]any{}

	for i := start; i < len(rows); i++ {
		row := rows[i]
		productKey := impGet(row, mapping, "product")
		if productKey == "" {
			continue
		}
		product := ResolveProduct(ctx, q, productKey)
		if product == nil {
			failed = append(failed, map[string]any{"row": i + 1, "reason": "商品「" + productKey + "」不存在"})
			continue
		}
		unit := impGet(row, mapping, "unit")
		if _, ok := product.Conversions[unit]; !ok {
			failed = append(failed, map[string]any{"row": i + 1,
				"reason": "商品「" + product.Name + "」未配置单位「" + unit + "」"})
			continue
		}
		qty := ImpToFloat(impGet(row, mapping, "quantity"), -1)
		price := ImpToFloat(impGet(row, mapping, "unit_price"), 0)
		if qty <= 0 {
			failed = append(failed, map[string]any{"row": i + 1, "reason": "数量无效（" + productKey + "）"})
			continue
		}
		docNo := impGet(row, mapping, "doc_no")
		if docNo == "" {
			docNo = "_r" + strconv.Itoa(i)
		}
		a, ok := orders[docNo]
		if !ok {
			date := ImpNormDate(impGet(row, mapping, "date"))
			if date == "" {
				date = Today()
			}
			operator := impGet(row, mapping, "operator")
			if operator == "" {
				operator = userName
			}
			a = &acc{order: ImpDraftOrder{
				DocNo: docNo, Date: date,
				Customer: impGet(row, mapping, "customer"),
				Operator: operator,
				Remark:   impGet(row, mapping, "remark"),
			}}
			orders[docNo] = a
			keys = append(keys, docNo) // dict 保序：按首次出现顺序输出
		}
		a.order.Lines = append(a.order.Lines, ImpDraftLine{
			ProductID: product.ID, ProductName: product.Name, Unit: unit,
			Quantity: qty, Price: price, Amount: Round(qty*price, 2),
			Multiplier: 1.0, // pydantic DraftLine.multiplier 默认 1.0
		})
		a.fee += ImpToFloat(impGet(row, mapping, "pack_fee"), 0)
	}

	out := make([]ImpDraftOrder, 0, len(keys))
	for _, k := range keys {
		o := orders[k].order
		o.PackFee = orders[k].fee
		out = append(out, o)
	}
	return out, failed, nil
}

// ImpOutboundPreview POST /api/import/outbounds/preview 的业务部分。
func ImpOutboundPreview(ctx context.Context, q Querier, data []byte, userName string) (map[string]any, error) {
	drafts, failed, err := impParseOutboundDraft(ctx, q, data, userName)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"orders": impDraftOrderListJSON(drafts), "failed": failed, "failed_count": len(failed),
	}, nil
}

func impDraftOrderListJSON(drafts []ImpDraftOrder) []map[string]any {
	out := make([]map[string]any, 0, len(drafts))
	for _, d := range drafts {
		out = append(out, d.JSON())
	}
	return out
}

// ImpConfirmOrders _confirm_orders：按用户确认后的草稿建单（同批共用一个批次号）。
func ImpConfirmOrders(ctx context.Context, q Querier, orders []ImpDraftOrder, userName string) (map[string]any, error) {
	group := "imp" + whRandHex(5)
	created := 0
	warnings := []string{}
	failed := []map[string]any{}
	pendingRecompute := []int{}

	for _, o := range orders {
		if len(o.Lines) == 0 {
			continue
		}
		lines := make([]map[string]any, 0, len(o.Lines))
		for _, l := range o.Lines {
			lines = append(lines, map[string]any{
				"product_id": l.ProductID, "unit": l.Unit, "quantity": l.Quantity,
				"price": l.Price, "spec": l.Spec,
				"stock_product_id": AsInt(l.StockProductID),
				"multiplier":       l.Multiplier, "gross_sales": l.GrossSales,
			})
		}
		operator := o.Operator
		if operator == "" {
			operator = userName
		}
		rec, warns, affected, err := CreateOutbound(ctx, q, map[string]any{
			"customer": o.Customer, "operator": operator,
			"date": o.Date, "remark": o.Remark,
			"pack_rule_id":   AsInt(o.PackRuleID),
			"pack_rule_name": o.PackRuleName,
			"lines":          lines,
			"pack_lines":     o.PackLines,
			"pack_fee_total": o.PackFee,
			"warehouse":      o.Warehouse,
			"brush_cost":     o.BrushCost,
			"brush_fee":      o.BrushFee,
		}, userName, group, false, true)
		if err != nil {
			failed = append(failed, map[string]any{"doc": o.DocNo, "reason": ErrMessage(err)})
			continue
		}
		created++
		for _, w := range warns {
			warnings = append(warnings, rec.Code+": "+w)
		}
		pendingRecompute = append(pendingRecompute, affected...)
	}
	// 统一重算受影响商品（去重）：避免每单都对同一商品全量重放流水
	for _, pid := range uniqueIntsKeepOrder(pendingRecompute) {
		if err := RecomputeProduct(ctx, q, pid); err != nil {
			return nil, err
		}
	}
	return map[string]any{
		"ok": true, "created": created, "failed": failed,
		"warnings": warnings, "failed_count": len(failed),
	}, nil
}

func uniqueIntsKeepOrder(ids []int) []int {
	seen := map[int]bool{}
	out := []int{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// ImpImportOutbounds POST /api/import/outbounds（老入口：解析即建单）。
func ImpImportOutbounds(ctx context.Context, q Querier, data []byte, userName string) (map[string]any, error) {
	rows, err := ImpReadRows(data)
	if err != nil {
		return nil, err
	}
	mapping, start := ImpDetectHeader(rows, ImpOutboundAliases)
	if _, has := mapping["product"]; !has || len(mapping) == 0 {
		return nil, ErrText("未识别到出库表头（需包含「商品」列），请使用下载的出库导入模板")
	}
	type acc struct {
		date, customer, operator, remark string
		lines                            []map[string]any
		fee                              float64
	}
	var keys []string
	orders := map[string]*acc{}
	failed := []map[string]any{}

	for i := start; i < len(rows); i++ {
		row := rows[i]
		productKey := impGet(row, mapping, "product")
		if productKey == "" {
			continue
		}
		product := ResolveProduct(ctx, q, productKey)
		if product == nil {
			failed = append(failed, map[string]any{"row": i + 1, "reason": "商品「" + productKey + "」不存在"})
			continue
		}
		unit := impGet(row, mapping, "unit")
		if _, ok := product.Conversions[unit]; !ok {
			failed = append(failed, map[string]any{"row": i + 1,
				"reason": "商品「" + product.Name + "」未配置单位「" + unit + "」"})
			continue
		}
		qty := ImpToFloat(impGet(row, mapping, "quantity"), -1)
		price := ImpToFloat(impGet(row, mapping, "unit_price"), 0)
		if qty <= 0 {
			failed = append(failed, map[string]any{"row": i + 1, "reason": "数量无效（" + productKey + "）"})
			continue
		}
		docNo := impGet(row, mapping, "doc_no")
		if docNo == "" {
			docNo = "_r" + strconv.Itoa(i)
		}
		a, ok := orders[docNo]
		if !ok {
			date := ImpNormDate(impGet(row, mapping, "date"))
			if date == "" {
				date = Today()
			}
			operator := impGet(row, mapping, "operator")
			if operator == "" {
				operator = userName
			}
			a = &acc{date: date, customer: impGet(row, mapping, "customer"),
				operator: operator, remark: impGet(row, mapping, "remark")}
			orders[docNo] = a
			keys = append(keys, docNo)
		}
		a.lines = append(a.lines, map[string]any{
			"product_id": product.ID, "unit": unit, "quantity": qty, "price": price})
		a.fee += ImpToFloat(impGet(row, mapping, "pack_fee"), 0)
	}

	created := 0
	warnings := []string{}
	group := "imp" + whRandHex(5)
	for _, docNo := range keys {
		order := orders[docNo]
		if len(order.lines) == 0 {
			continue
		}
		rec, warns, _, err := CreateOutbound(ctx, q, map[string]any{
			"customer": order.customer, "operator": order.operator,
			"date": order.date, "remark": order.remark,
			"lines": order.lines, "pack_lines": []map[string]any{}, "pack_fee_total": order.fee,
		}, userName, group, false, false)
		if err != nil {
			failed = append(failed, map[string]any{"row": docNo, "reason": ErrMessage(err)})
			continue
		}
		created++
		for _, w := range warns {
			warnings = append(warnings, rec.Code+": "+w)
		}
	}
	return map[string]any{
		"ok": true, "created": created, "failed": failed,
		"warnings": warnings, "failed_count": len(failed),
	}, nil
}
