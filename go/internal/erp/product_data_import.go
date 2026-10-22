package erp

// 本文件是「商品主数据导入」，逐条对齐 Python product_master 的 _import_* / import_*。
// 所有 upsert 按名称解析引用，写库口径（列、默认值、or 链）与 Python 一致。

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// pdProductIDByName 按名称取商品 id（trim；空名不查）。等价 _get_product_by_name。
func pdProductIDByName(ctx context.Context, q Querier, name string) (int, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		return 0, false
	}
	var id int
	err := q.QueryRowContext(ctx, "SELECT id FROM products WHERE name = ? ORDER BY id LIMIT 1", name).Scan(&id)
	if err != nil {
		return 0, false
	}
	return id, true
}

// defaultConversions 按基础单位给默认换算表（克->重量单位；其余->计数单位）。
func defaultConversions(base string) *om {
	m := newOM()
	if base == "克" || base == "g" {
		m.set("克", 1)
		m.set("斤", 500)
		m.set("公斤", 1000)
		m.set("千克", 1000)
		return m
	}
	m.set("个", 1)
	return m
}

// ---------------- units ----------------

func pdImportUnits(ctx context.Context, q Querier, items []map[string]any) (map[string]any, error) {
	created, updated := 0, 0
	warnings := []string{}
	done := func() map[string]any {
		return map[string]any{"created": created, "updated": updated, "skipped": 0, "warnings": warnings}
	}
	for _, it := range items {
		name := strings.TrimSpace(pyStr(getOr(it, "name", "")))
		if name == "" {
			continue
		}
		var id int
		var cat string
		var gram sql.NullFloat64
		var std int
		err := q.QueryRowContext(ctx, "SELECT id, COALESCE(category,''), gram_per_unit, COALESCE(is_standard,0) FROM units WHERE name = ?", name).
			Scan(&id, &cat, &gram, &std)
		if errors.Is(err, sql.ErrNoRows) {
			res, err := q.ExecContext(ctx, "INSERT INTO units (name, category, gram_per_unit, is_standard) VALUES (?,?,NULL,0)", name, "weight")
			if err != nil {
				return nil, err
			}
			nid, _ := res.LastInsertId()
			id = int(nid)
			cat, gram, std = "weight", sql.NullFloat64{}, 0
			created++
		} else if err != nil {
			return nil, err
		} else {
			updated++
		}
		// category 仅在 weight/count 时覆盖
		if c := getOr(it, "category", nil); c == "weight" || c == "count" {
			cat = c.(string)
		}
		// gram_per_unit：非 None/空串才写
		g := getOr(it, "gram_per_unit", nil)
		if g != nil && g != "" {
			gram = sql.NullFloat64{Float64: pyFloat(g), Valid: true}
		}
		// is_standard：键存在用 bool(值)，否则保持
		if hasKey(it, "is_standard") {
			std = b2i(ToBool(it["is_standard"]))
		}
		if _, err := q.ExecContext(ctx, "UPDATE units SET category = ?, gram_per_unit = ?, is_standard = ? WHERE id = ?", cat, gram, std, id); err != nil {
			return nil, err
		}
	}
	return done(), nil
}

// ---------------- products ----------------

func pdImportProducts(ctx context.Context, q Querier, items []map[string]any, defaultType string) (map[string]any, error) {
	created, updated := 0, 0
	warnings := []string{}
	done := func() map[string]any {
		return map[string]any{"created": created, "updated": updated, "skipped": 0, "warnings": warnings}
	}
	for _, it := range items {
		name := strings.TrimSpace(pyStr(getOr(it, "name", "")))
		if name == "" {
			continue
		}
		var id int
		var curBaseS string
		var curSaleF, curCostF, curPackFeeF, curMultF float64
		var curConv string
		err := q.QueryRowContext(ctx, "SELECT id, COALESCE(base_unit,''), COALESCE(sale_price,0), COALESCE(unit_cost,0),"+
			" COALESCE(conversions,'{}'), COALESCE(pack_fee,0), COALESCE(multiplier,1) FROM products WHERE name = ? ORDER BY id LIMIT 1", name).
			Scan(&id, &curBaseS, &curSaleF, &curCostF, &curConv, &curPackFeeF, &curMultF)
		isNew := errors.Is(err, sql.ErrNoRows)
		if err != nil && !isNew {
			return nil, err
		}
		var curBaseV string
		var curSaleV, curCostV, curPackFeeV, curMultV float64
		if isNew {
			curBaseV, curSaleV, curCostV, curPackFeeV, curMultV = "", 0, 0, 0, 1
			created++
		} else {
			curBaseV, curSaleV, curCostV, curPackFeeV, curMultV = curBaseS, curSaleF, curCostF, curPackFeeF, curMultF
			updated++
		}

		newCode := strings.TrimSpace(pyStr(getOr(it, "code", "")))
		newCategory := strings.TrimSpace(pyStr(getOr(it, "category", "")))
		newType := pyStr(getOr(it, "product_type", defaultType))
		// base = it.base_unit or 当前 base_unit or "克"
		baseUnit := strings.TrimSpace(pyStr(orFallback(orFallback(getOr(it, "base_unit", ""), curBaseV), "克")))
		defaultUnit := strings.TrimSpace(pyStr(orFallback(getOr(it, "default_unit", ""), baseUnit)))
		spec := strings.TrimSpace(pyStr(getOr(it, "spec", "")))
		salePrice := floatOr(it, "sale_price", curSaleV, 0)
		unitCost := floatOr(it, "unit_cost", curCostV, 0)
		multiplier := floatOr(it, "multiplier", curMultV, 1)
		packFee := floatOr(it, "pack_fee", curPackFeeV, 0)
		isActive := true
		if hasKey(it, "is_active") {
			isActive = ToBool(it["is_active"])
		}
		// conversions
		convVal := getOr(it, "conversions", nil)
		if !truthyPy(convVal) {
			convVal = defaultConversions(baseUnit)
		}
		convJSON := marshalColumn(convVal)

		// stock_links（多扣减关联）
		var rawLinks []map[string]any
		if rv, present := it["stock_links"]; !present || rv == nil {
			spName := strings.TrimSpace(pyStr(getOr(it, "stock_product", "")))
			if spName != "" {
				fbMult := getOr(it, "multiplier", multiplier)
				rawLinks = []map[string]any{{"product": spName, "multiplier": fbMult}}
			}
		} else {
			rawLinks = decodeAnyList(rv)
		}
		links := []*om{}
		seen := map[int]bool{}
		for _, li := range rawLinks {
			ln := strings.TrimSpace(pyStr(getOr(li, "product", "")))
			if ln == "" {
				continue
			}
			spid, ok := pdProductIDByName(ctx, q, ln)
			if !ok {
				warnings = append(warnings, fmt.Sprintf("商品「%s」关联的库存商品「%s」不存在，已跳过", name, ln))
				continue
			}
			if seen[spid] {
				continue
			}
			seen[spid] = true
			mult := pyFloat(orFallback(getOr(li, "multiplier", float64(1)), float64(1)))
			l := newOM()
			l.set("product_id", spid)
			l.set("multiplier", mult)
			links = append(links, l)
		}
		linksJSON := marshalColumn(links)
		var stockProductID any
		if len(links) > 0 {
			multiplier = pyFloat(links[0].vals["multiplier"])
			stockProductID = links[0].vals["product_id"]
		}

		// pack_items
		pack := []*om{}
		for _, pi := range decodeAnyList(orFallback(getOr(it, "pack_items", nil), []any{})) {
			piName := strings.TrimSpace(pyStr(getOr(pi, "name", "")))
			if piName == "" {
				continue
			}
			mpid, ok := pdProductIDByName(ctx, q, piName)
			if !ok {
				warnings = append(warnings, fmt.Sprintf("商品「%s」的关联结算项「%s」不存在，已跳过", name, piName))
				continue
			}
			qty := pyFloat(orFallback(getOr(pi, "quantity", float64(1)), float64(1)))
			unit := strings.TrimSpace(pyStr(orFallback(getOr(pi, "unit", "个"), "个")))
			e := newOM()
			e.set("product_id", mpid)
			e.set("quantity", qty)
			e.set("unit", unit)
			pack = append(pack, e)
		}
		packJSON := marshalColumn(pack)

		if isNew {
			// 与 Python 一致：所有字段一次性 INSERT。沙箱库由 SQLAlchemy 建表，
			// weight_kg/stock/avg_cost/stock_value/workload 是 NOT NULL 无 DB 默认，必须显式给 0。
			if _, err := q.ExecContext(ctx, "INSERT INTO products"+
				" (code, name, category, product_type, base_unit, default_unit, spec, sale_price, unit_cost, weight_kg, conversions,"+
				" pack_items, pack_fee, is_active, stock_product_id, multiplier, stock, avg_cost, stock_value, workload, stock_links, created_at)"+
				" VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
				newCode, name, newCategory, newType, baseUnit, defaultUnit, spec, salePrice, unitCost, 0.0, convJSON,
				packJSON, packFee, b2i(isActive), stockProductID, multiplier, 0.0, 0.0, 0.0, 0.0, linksJSON, NowDB()); err != nil {
				return nil, err
			}
		} else {
			if _, err := q.ExecContext(ctx, "UPDATE products SET code=?, category=?, product_type=?, base_unit=?, default_unit=?, spec=?,"+
				" sale_price=?, unit_cost=?, conversions=?, pack_fee=?, is_active=?, multiplier=?, stock_links=?, stock_product_id=?, pack_items=? WHERE id=?",
				newCode, newCategory, newType, baseUnit, defaultUnit, spec, salePrice, unitCost, convJSON, packFee, b2i(isActive),
				multiplier, linksJSON, stockProductID, packJSON, id); err != nil {
				return nil, err
			}
		}
	}
	return done(), nil
}

// ---------------- pack_rules ----------------

func pdImportPackRules(ctx context.Context, q Querier, items []map[string]any) (map[string]any, error) {
	created, updated := 0, 0
	warnings := []string{}
	done := func() map[string]any {
		return map[string]any{"created": created, "updated": updated, "skipped": 0, "warnings": warnings}
	}
	for _, it := range items {
		name := strings.TrimSpace(pyStr(getOr(it, "name", "")))
		if name == "" {
			continue
		}
		var id int
		var curBoxRatio float64
		err := q.QueryRowContext(ctx, "SELECT id, COALESCE(box_ratio,1) FROM pack_rules WHERE name = ? ORDER BY id LIMIT 1", name).Scan(&id, &curBoxRatio)
		isNew := errors.Is(err, sql.ErrNoRows)
		if err != nil && !isNew {
			return nil, err
		}
		if isNew {
			curBoxRatio = 1
			res, err := q.ExecContext(ctx, "INSERT INTO pack_rules (name, items, box_type, box_items, labor_price, box_ratio, remark, is_active, created_at)"+
				" VALUES (?,?,?,'[]',NULL,?,?,?,?)", name, "[]", "", 1.0, "", 1, NowDB())
			if err != nil {
				return nil, err
			}
			nid, _ := res.LastInsertId()
			id = int(nid)
			created++
		} else {
			updated++
		}

		ruleItems := []*om{}
		for _, ri := range decodeAnyList(orFallback(getOr(it, "items", nil), []any{})) {
			rn := strings.TrimSpace(pyStr(getOr(ri, "name", "")))
			var productID any
			if rn != "" {
				if mp, ok := pdProductIDByName(ctx, q, rn); ok {
					productID = mp
				}
			}
			var spID any
			spName := strings.TrimSpace(pyStr(getOr(ri, "stock_product", "")))
			if spName != "" {
				if msp, ok := pdProductIDByName(ctx, q, spName); ok {
					spID = msp
				} else {
					warnings = append(warnings, fmt.Sprintf("规则「%s」的扣减关联库存商品「%s」不存在，扣减关联已置空", name, spName))
				}
			}
			e := newOM()
			e.set("product_id", productID)
			e.set("name", rn)
			e.set("quantity", pyFloat(orFallback(getOr(ri, "quantity", float64(1)), float64(1))))
			e.set("stock_product_id", spID)
			e.set("multiplier", pyFloat(orFallback(getOr(ri, "multiplier", float64(1)), float64(1))))
			ruleItems = append(ruleItems, e)
		}

		boxType := strings.TrimSpace(pyStr(getOr(it, "box_type", "")))
		lp := getOr(it, "labor_price", nil)
		var laborPrice any
		if lp != nil {
			laborPrice = pyFloat(lp)
		}
		boxRatio := pyFloat(orFallback(getOr(it, "box_ratio", curBoxRatio), float64(1)))
		remark := strings.TrimSpace(pyStr(getOr(it, "remark", "")))
		isActive := true
		if hasKey(it, "is_active") {
			isActive = ToBool(it["is_active"])
		}

		if hasKey(it, "box_items") {
			boxItems := []*om{}
			for _, bi := range decodeAnyList(orFallback(it["box_items"], []any{})) {
				pname := strings.TrimSpace(pyStr(getOr(bi, "product", "")))
				var mp any
				found := false
				if pname != "" {
					if bid, ok := pdProductIDByName(ctx, q, pname); ok {
						mp = bid
						found = true
					}
				}
				if pname != "" && !found {
					warnings = append(warnings, fmt.Sprintf("规则「%s」的包材商品「%s」不存在，已跳过", name, pname))
					continue
				}
				nm := pyStr(orFallback(getOr(bi, "name", ""), orFallback(pname, "")))
				e := newOM()
				e.set("product_id", mp)
				e.set("name", nm)
				e.set("quantity", pyFloat(orFallback(getOr(bi, "quantity", float64(1)), float64(1))))
				boxItems = append(boxItems, e)
			}
			if _, err := q.ExecContext(ctx, "UPDATE pack_rules SET items=?, box_items=?, box_type=?, labor_price=?, box_ratio=?, remark=?, is_active=? WHERE id=?",
				marshalColumn(ruleItems), marshalColumn(boxItems), boxType, laborPrice, boxRatio, remark, b2i(isActive), id); err != nil {
				return nil, err
			}
		} else {
			if _, err := q.ExecContext(ctx, "UPDATE pack_rules SET items=?, box_type=?, labor_price=?, box_ratio=?, remark=?, is_active=? WHERE id=?",
				marshalColumn(ruleItems), boxType, laborPrice, boxRatio, remark, b2i(isActive), id); err != nil {
				return nil, err
			}
		}
	}
	return done(), nil
}

// ---------------- code_mappings ----------------

func pdImportCodeMappings(ctx context.Context, q Querier, items []map[string]any) (map[string]any, error) {
	created, updated := 0, 0
	warnings := []string{}
	done := func() map[string]any {
		return map[string]any{"created": created, "updated": updated, "skipped": 0, "warnings": warnings}
	}
	for _, it := range items {
		source := strings.TrimSpace(pyStr(getOr(it, "source", "jushuitan")))
		extCode := strings.TrimSpace(pyStr(getOr(it, "external_code", "")))
		if extCode == "" {
			continue
		}
		var id int
		err := q.QueryRowContext(ctx, "SELECT id FROM code_mappings WHERE source = ? AND external_code = ? ORDER BY id LIMIT 1", source, extCode).Scan(&id)
		isNew := errors.Is(err, sql.ErrNoRows)
		if err != nil && !isNew {
			return nil, err
		}
		extName := strings.TrimSpace(pyStr(getOr(it, "external_name", "")))
		var productID any
		pname := strings.TrimSpace(pyStr(getOr(it, "product", "")))
		if pname != "" {
			if mp, ok := pdProductIDByName(ctx, q, pname); ok {
				productID = mp
			} else {
				warnings = append(warnings, fmt.Sprintf("编码关联「%s」映射的商品「%s」不存在，映射已置空", extCode, pname))
			}
		}
		score := pyFloat(orFallback(getOr(it, "auto_score", float64(0)), float64(0)))
		if isNew {
			if _, err := q.ExecContext(ctx, "INSERT INTO code_mappings (source, external_code, external_name, product_id, auto_score, created_at, updated_at)"+
				" VALUES (?,?,?,?,?,?,?)", source, extCode, extName, productID, score, NowDB(), NowDB()); err != nil {
				return nil, err
			}
			created++
		} else {
			if _, err := q.ExecContext(ctx, "UPDATE code_mappings SET external_name=?, product_id=?, auto_score=?, updated_at=? WHERE id=?",
				extName, productID, score, NowDB(), id); err != nil {
				return nil, err
			}
			updated++
		}
	}
	return done(), nil
}

// ---------------- 组装 ----------------

// decodeAnyList 把 payload 里的数组解析成 []map[string]any（非数组/坏 -> nil）。
func decodeAnyList(v any) []map[string]any {
	arr, ok := v.([]any)
	if !ok {
		if ms, ok2 := v.([]map[string]any); ok2 {
			return ms
		}
		return nil
	}
	out := make([]map[string]any, 0, len(arr))
	for _, e := range arr {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		} else {
			out = append(out, map[string]any{})
		}
	}
	return out
}

// marshalColumn 把结构序列化成 SQLite JSON 列文本（不转义 HTML）。
func marshalColumn(v any) string {
	b, err := marshalNoEscape(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// ProductDataImportPayload 按一个已解析的 payload 导入对应类目；未知 kind 返回 error（ValueError 文案）。
func ProductDataImportPayload(ctx context.Context, q Querier, payload map[string]any) (map[string]any, error) {
	kind := getOr(payload, "kind", nil)
	kindStr, _ := kind.(string)
	meta, ok := ProductDataKindBy(kindStr)
	if !ok {
		return nil, fmt.Errorf("未知的商品资料类型: %s", pyStr(kind))
	}
	items := decodeAnyList(getOr(payload, meta.ListKey, []any{}))
	var stats map[string]any
	var err error
	switch kindStr {
	case "units":
		stats, err = pdImportUnits(ctx, q, items)
	case "products_stock":
		stats, err = pdImportProducts(ctx, q, items, "stock")
	case "products_order":
		stats, err = pdImportProducts(ctx, q, items, "order")
	case "pack_rules":
		stats, err = pdImportPackRules(ctx, q, items)
	default:
		stats, err = pdImportCodeMappings(ctx, q, items)
	}
	if err != nil {
		return nil, err
	}
	out := map[string]any{"kind": kindStr, "file": meta.File, "label": meta.Label}
	for k, v := range stats {
		out[k] = v
	}
	return out, nil
}

// ProductDataImportFromFile 从 json 目录读取某一类并导入；缺文件返回 FileNotFoundError 文案。
func ProductDataImportFromFile(ctx context.Context, q Querier, dir, kind string) (map[string]any, error) {
	meta, ok := ProductDataKindBy(kind)
	if !ok {
		return nil, fmt.Errorf("未知的商品资料类型: %s", kind)
	}
	fp := filepath.Join(dir, meta.File)
	raw, err := os.ReadFile(fp)
	if err != nil {
		return nil, fmt.Errorf("缺少 %s", meta.File)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	return ProductDataImportPayload(ctx, q, payload)
}

// ProductDataImportAll 从 json 目录一键导入全部 5 类（逐类各自落库，失败记录进 warnings）。
func ProductDataImportAll(ctx context.Context, q Querier, dir string) map[string]any {
	results := []map[string]any{}
	for _, kind := range ProductDataImportOrder {
		meta, _ := ProductDataKindBy(kind)
		fp := filepath.Join(dir, meta.File)
		if _, err := os.Stat(fp); err != nil {
			results = append(results, map[string]any{"kind": kind, "file": meta.File, "label": meta.Label,
				"created": 0, "updated": 0, "skipped": 0, "warnings": []string{"文件不存在，已跳过"}, "loaded": false})
			continue
		}
		stats, err := ProductDataImportFromFile(ctx, q, dir, kind)
		if err != nil {
			results = append(results, map[string]any{"kind": kind, "file": meta.File, "label": meta.Label,
				"created": 0, "updated": 0, "skipped": 0, "warnings": []string{fmt.Sprintf("导入失败：%s", err.Error())}, "loaded": false})
			continue
		}
		stats["loaded"] = true
		results = append(results, stats)
	}
	return map[string]any{"ok": true, "imported_at": pdNow(), "results": results}
}
