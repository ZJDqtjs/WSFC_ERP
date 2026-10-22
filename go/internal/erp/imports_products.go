package erp

// ---------------- 商品导入（POST /api/import/products，支持柠檬云模板） ----------------

import (
	"context"
	"fmt"
)

// ImpImportProducts 逐行建商品：同名/同编码跳过，解析不出表头 400。
// 返回体与 Python import_products 一致：ok / created / skipped / failed / product_ids / failed_count。
func ImpImportProducts(ctx context.Context, q Querier, data []byte) (map[string]any, error) {
	rows, err := ImpReadRows(data)
	if err != nil {
		return nil, err
	}
	mapping, start := ImpDetectHeader(rows, ImpProductAliases)
	if _, hasName := mapping["name"]; !hasName || len(mapping) == 0 {
		return nil, ErrText("未识别到商品表头（需包含「商品名称」等列），请使用下载的模板或柠檬云商品导入模板")
	}
	success, skipped := 0, 0
	failed := []map[string]any{}
	createdIDs := []int{}

	for i := start; i < len(rows); i++ {
		row := rows[i]
		name := impGet(row, mapping, "name")
		if name == "" {
			continue
		}
		code := impGet(row, mapping, "code")
		dup := productByColumn(ctx, q, "name", name) != nil
		if !dup && code != "" {
			dup = productByColumn(ctx, q, "code", code) != nil
		}
		if dup {
			skipped++
			continue
		}
		unit := impGet(row, mapping, "unit")
		baseUnit := impGet(row, mapping, "base_unit")
		if baseUnit == "" {
			baseUnit = InferBaseUnit(unit)
		}
		conversions := ParseConversions(impGet(row, mapping, "conversions"), baseUnit, unit)
		if _, ok := conversions[baseUnit]; !ok {
			conversions[baseUnit] = 1.0
		}
		defaultUnit := unit // 默认出库/展示单位，如 斤
		if defaultUnit == "" {
			defaultUnit = baseUnit
		}
		if _, ok := conversions[defaultUnit]; !ok {
			conversions[defaultUnit] = 1.0
		}
		packItems := ParsePackItems(ctx, q, impGet(row, mapping, "pack_items"))
		id, err := insertImportProduct(ctx, q, importProductRow{
			Code:        code,
			Name:        name,
			Category:    impGet(row, mapping, "category"),
			Spec:        impGet(row, mapping, "spec"),
			BaseUnit:    baseUnit,
			DefaultUnit: defaultUnit,
			SalePrice:   ImpToFloat(impGet(row, mapping, "sale_price"), 0),
			Conversions: conversions,
			PackItems:   packItems,
			PackFee:     ImpToFloat(impGet(row, mapping, "pack_fee"), 0),
		})
		if err != nil {
			// Python 这里把 ORM 异常原样拼进 reason（str(e)），实际极少触发
			failed = append(failed, map[string]any{"row": i + 1, "reason": fmt.Sprintf("%s: %s", name, err.Error())})
			continue
		}
		createdIDs = append(createdIDs, id)
		success++
	}

	return map[string]any{
		"ok": true, "created": success, "skipped": skipped,
		"failed": failed, "product_ids": createdIDs,
		"failed_count": len(failed),
	}, nil
}

type importProductRow struct {
	Code        string
	Name        string
	Category    string
	Spec        string
	BaseUnit    string
	DefaultUnit string
	SalePrice   float64
	Conversions map[string]float64
	PackItems   []PackItem
	PackFee     float64
}

// insertImportProduct 直接按 ORM 默认值落库（导入路径不走商品接口的校验层）。
func insertImportProduct(ctx context.Context, q Querier, r importProductRow) (int, error) {
	packs := r.PackItems
	if packs == nil {
		packs = []PackItem{}
	}
	res, err := q.ExecContext(ctx, `INSERT INTO products (code, name, category, product_type, base_unit, default_unit,
		spec, sale_price, unit_cost, weight_kg, free_shipping, conversions, pack_items, pack_fee, is_active,
		stock_product_id, multiplier, stock_links, stock, avg_cost, stock_value, workload, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,1,'[]',0,0,0,0,?)`,
		r.Code, r.Name, r.Category, "stock", r.BaseUnit, r.DefaultUnit,
		r.Spec, r.SalePrice, 0.0, 0.0, 0, EncodeJSONColumn(r.Conversions), EncodeJSONColumn(packs),
		r.PackFee, NowDB())
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	return int(id), nil
}
