package erp

// ---------------- 入库批量导入（/api/import/inbounds*） ----------------

import (
	"context"
)

// ImpDraftInbound 草稿入库行（等价 pydantic DraftInbound）。
type ImpDraftInbound struct {
	ProductID   int
	ProductName string
	Unit        string
	Quantity    float64
	UnitPrice   float64
	Freight     float64
	Handling    float64
	Supplier    string
	Date        string
	Operator    string
	Remark      string
}

// JSON model_dump() 口径的响应体。
func (d ImpDraftInbound) JSON() map[string]any {
	return map[string]any{
		"product_id": d.ProductID, "product_name": d.ProductName, "unit": d.Unit,
		"quantity": d.Quantity, "unit_price": d.UnitPrice,
		"freight": d.Freight, "handling": d.Handling,
		"supplier": d.Supplier, "date": d.Date, "operator": d.Operator, "remark": d.Remark,
	}
}

// impParseInboundDraft parse_inbound_draft：解析入库模板 → 草稿行（不建单）。
func impParseInboundDraft(ctx context.Context, q Querier, data []byte, userName string) ([]ImpDraftInbound, []map[string]any, error) {
	rows, err := ImpReadRows(data)
	if err != nil {
		return nil, nil, err
	}
	mapping, start := ImpDetectHeader(rows, ImpInboundAliases)
	if _, has := mapping["product"]; !has || len(mapping) == 0 {
		return nil, nil, ErrText("未识别到入库表头（需包含「商品」列），请使用下载的入库导入模板")
	}
	deductionMap, err := DeductionMap(ctx, q)
	if err != nil {
		return nil, nil, err
	}
	items := []ImpDraftInbound{}
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
		if product.ProductType == "order" {
			failed = append(failed, map[string]any{"row": i + 1,
				"reason": "「" + product.Name + "」是订单商品（小类），请入库其关联的库存商品（大类）"})
			continue
		}
		unit := impGet(row, mapping, "unit")
		if _, ok := product.Conversions[unit]; !ok {
			failed = append(failed, map[string]any{"row": i + 1,
				"reason": "商品「" + product.Name + "」未配置单位「" + unit + "」"})
			continue
		}
		qty := ImpToFloat(impGet(row, mapping, "quantity"), -1)
		price := ImpToFloat(impGet(row, mapping, "unit_price"), -1)
		if qty <= 0 || price < 0 {
			failed = append(failed, map[string]any{"row": i + 1, "reason": "数量/单价无效（" + productKey + "）"})
			continue
		}
		// 扣点折算：命中类别扣点时，实际入库单价 = 原价 × (1 - 扣点%)
		price = impApplyDeduction(price, product, deductionMap)
		operator := impGet(row, mapping, "operator")
		if operator == "" {
			operator = userName
		}
		date := ImpNormDate(impGet(row, mapping, "date"))
		if date == "" {
			date = Today()
		}
		items = append(items, ImpDraftInbound{
			ProductID: product.ID, ProductName: product.Name, Unit: unit,
			Quantity: qty, UnitPrice: price,
			Freight:  impMax0(ImpToFloat(impGet(row, mapping, "freight"), 0)),
			Handling: impMax0(ImpToFloat(impGet(row, mapping, "handling"), 0)),
			Supplier: impGet(row, mapping, "supplier"),
			Operator: operator, Date: date,
			Remark: impGet(row, mapping, "remark"),
		})
	}
	return items, failed, nil
}

// impMax0 max(0.0, v)：运费/装卸费为选填列，负数钳到 0。
func impMax0(v float64) float64 {
	if v < 0 {
		return 0
	}
	return v
}

// ImpInboundPreview POST /api/import/inbounds/preview 的业务部分。
func ImpInboundPreview(ctx context.Context, q Querier, data []byte, userName string) (map[string]any, error) {
	items, failed, err := impParseInboundDraft(ctx, q, data, userName)
	if err != nil {
		return nil, err
	}
	list := make([]map[string]any, 0, len(items))
	for _, it := range items {
		list = append(list, it.JSON())
	}
	return map[string]any{"items": list, "failed": failed, "failed_count": len(failed)}, nil
}

// ImpInboundConfirm POST /api/import/inbounds/confirm 的业务部分（逐行落库）。
func ImpInboundConfirm(ctx context.Context, q Querier, items []map[string]any, userName string) (map[string]any, error) {
	created := 0
	failed := []map[string]any{}
	for _, raw := range items {
		it := ImpDraftInbound{
			ProductID:   ToInt(raw["product_id"]),
			ProductName: ToStr(raw["product_name"]),
			Unit:        ToStr(raw["unit"]),
			Quantity:    ToFloat(raw["quantity"]),
			UnitPrice:   ToFloat(raw["unit_price"]),
			Freight:     ToFloat(raw["freight"]),
			Handling:    ToFloat(raw["handling"]),
			Supplier:    ToStr(raw["supplier"]),
			Date:        ToStr(raw["date"]),
			Operator:    ToStr(raw["operator"]),
			Remark:      ToStr(raw["remark"]),
		}
		if it.Quantity <= 0 {
			failed = append(failed, map[string]any{"row": it.ProductName, "reason": "数量无效"})
			continue
		}
		operator := it.Operator
		if operator == "" {
			operator = userName
		}
		_, err := CreateInbound(ctx, q, map[string]any{
			"product_id": it.ProductID, "unit": it.Unit, "quantity": it.Quantity,
			"unit_price": it.UnitPrice, "supplier": it.Supplier,
			"freight": impMax0(it.Freight), "handling": impMax0(it.Handling),
			"operator": operator, "date": it.Date, "remark": it.Remark,
		}, userName)
		if err != nil {
			failed = append(failed, map[string]any{"row": it.ProductName, "reason": ErrMessage(err)})
			continue
		}
		created++
	}
	return map[string]any{"ok": true, "created": created, "failed": failed, "failed_count": len(failed)}, nil
}

// ImpImportInbounds POST /api/import/inbounds 的业务部分（老入口：解析即建单）。
// 注意与 preview 的差别：这条路径不拦「订单商品（小类）」。
func ImpImportInbounds(ctx context.Context, q Querier, data []byte, userName string) (map[string]any, error) {
	rows, err := ImpReadRows(data)
	if err != nil {
		return nil, err
	}
	mapping, start := ImpDetectHeader(rows, ImpInboundAliases)
	if _, has := mapping["product"]; !has || len(mapping) == 0 {
		return nil, ErrText("未识别到入库表头（需包含「商品」列），请使用下载的入库导入模板")
	}
	deductionMap, err := DeductionMap(ctx, q)
	if err != nil {
		return nil, err
	}
	success := 0
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
		price := ImpToFloat(impGet(row, mapping, "unit_price"), -1)
		if qty <= 0 || price < 0 {
			failed = append(failed, map[string]any{"row": i + 1, "reason": "数量/单价无效（" + productKey + "）"})
			continue
		}
		price = impApplyDeduction(price, product, deductionMap)
		operator := impGet(row, mapping, "operator")
		if operator == "" {
			operator = userName
		}
		date := ImpNormDate(impGet(row, mapping, "date"))
		if date == "" {
			date = Today()
		}
		_, err := CreateInbound(ctx, q, map[string]any{
			"product_id": product.ID, "unit": unit, "quantity": qty,
			"unit_price": price, "supplier": impGet(row, mapping, "supplier"),
			"freight":  impMax0(ImpToFloat(impGet(row, mapping, "freight"), 0)),
			"handling": impMax0(ImpToFloat(impGet(row, mapping, "handling"), 0)),
			"operator": operator, "date": date, "remark": impGet(row, mapping, "remark"),
		}, userName)
		if err != nil {
			failed = append(failed, map[string]any{"row": i + 1, "reason": ErrMessage(err)})
			continue
		}
		success++
	}
	return map[string]any{"ok": true, "created": success, "failed": failed, "failed_count": len(failed)}, nil
}
