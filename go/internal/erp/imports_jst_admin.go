package erp

// ---------------- 聚水潭辅助接口：商品名发现 / 规则回写 / 古法导入留痕 ----------------
//
// 对应 Python routers/imports.py 的 parse_jushuitan、create_rule_from_jushuitan、_log_manual_jst_import。

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ImpJstDiscoverCodes POST /api/jushuitan/parse：
// 关联页用它「发现商品并自动新增品类」，与出库状态无关，因此接受全部状态（仅排除 作废/已删除/空）。
// 这个接口会写库（自动新增订单小类、回写编码关联），所以必须在事务里跑。
func ImpJstDiscoverCodes(ctx context.Context, q Querier, data []byte) (map[string]any, error) {
	orders, skip, err := JstRows(ctx, q, data, nil)
	if err != nil {
		return nil, err
	}
	byCode, err := CodeMappingsByCode(ctx, q)
	if err != nil {
		return nil, err
	}

	// codes 按首次出现顺序累积（最终按 -count 稳定排序，依赖这个插入序）
	var order []string
	type codeRow struct {
		m   map[string]any
		num int
	}
	codes := map[string]*codeRow{}
	for _, o := range orders {
		for _, it := range ParseJstName(o.Name) {
			c := codes[it.Name]
			if c == nil {
				c = &codeRow{m: map[string]any{"external_code": it.Name, "count": 0}}
				codes[it.Name] = c
				order = append(order, it.Name)
			}
			c.num++
			c.m["count"] = c.num
		}
	}

	autoCreated := 0
	for _, key := range order {
		c := codes[key]
		ext := key
		c.m["count"] = c.num
		su, sq, _ := ParseJstSpec(ext)
		if su != "" && sq != 0 {
			c.m["spec"] = FmtQty(sq) + " " + su + "/件"
		} else {
			c.m["spec"] = ""
		}

		m := byCode[ext]
		if m != nil && m.ProductID != nil && *m.ProductID != 0 {
			c.m["stock_product_name"] = ""
			productID := *m.ProductID
			tp := impGetProduct(ctx, q, productID)
			var stockName any = ""
			if tp != nil && tp.ProductType == "order" && tp.StockProductID != nil {
				sp := impGetProduct(ctx, q, *tp.StockProductID)
				if sp != nil && sp.ProductType == "stock" {
					productID = sp.ID
					if err := impSetMappingProductID(ctx, q, m.ID, productID); err != nil {
						return nil, err
					}
					stockName = sp.Name
				}
			}
			sp := impGetProduct(ctx, q, productID)
			isStock := sp != nil && sp.ProductType == "stock"
			var name any = ""
			if tp != nil {
				name = tp.Name
			}
			var stockID any
			if isStock {
				stockID = productID
			}
			if ToStr(stockName) == "" && isStock {
				stockName = sp.Name
			}
			c.m["product_id"] = productID
			c.m["product_name"] = name
			c.m["stock_product_id"] = stockID
			c.m["stock_product_name"] = stockName
			c.m["score"] = m.AutoScore
			c.m["status"] = "已关联"
			continue
		}

		// 订单商品（小类）是否已存在：存在则不新增（Python 只按名称查，不分类型）
		orderP := productByColumn(ctx, q, "name", ext)
		if orderP != nil {
			c.m["status"] = "已存在"
		} else {
			stock := MatchStock(ctx, q, ext)
			created, err := AutoCreateOrderProduct(ctx, q, ext, stock)
			if err != nil {
				return nil, err
			}
			orderP = created
			autoCreated++
			c.m["status"] = "自动新增"
		}

		// 已存在但未关联库存的，补关键词关联
		if ToStr(c.m["status"]) == "已存在" && orderP.StockProductID == nil {
			if stock := MatchStock(ctx, q, ext); stock != nil {
				if err := SetOrderStockLink(ctx, q, orderP, stock); err != nil {
					return nil, err
				}
			}
		}

		// 编码关联统一指向库存商品（大类）；无匹配库存则不关联（留待人工）
		var sp *Product
		if orderP.StockProductID != nil {
			sp = impGetProduct(ctx, q, *orderP.StockProductID)
		}
		if sp != nil && sp.ProductType == "stock" {
			if err := UpsertCodeMapping(ctx, q, "jushuitan", ext, &sp.ID); err != nil {
				return nil, err
			}
			c.m["product_id"] = sp.ID
			c.m["stock_product_id"] = sp.ID
			c.m["stock_product_name"] = sp.Name
		} else {
			c.m["product_id"] = orderP.ID
			c.m["stock_product_id"] = nil
			c.m["stock_product_name"] = ""
		}
		c.m["product_name"] = orderP.Name
		c.m["multiplier"] = orderP.Multiplier
		c.m["score"] = 1.0
	}

	list := make([]map[string]any, 0, len(order))
	for _, key := range order {
		list = append(list, codes[key].m)
	}
	sort.SliceStable(list, func(i, j int) bool { return ToInt(list[i]["count"]) > ToInt(list[j]["count"]) })

	return map[string]any{
		"total_orders": len(orders),
		"skip":         skip.JSON(),
		"auto_created": autoCreated,
		"codes":        list,
	}, nil
}

// impSetMappingProductID 把已有编码关联改指到别的产品（/api/jushuitan/parse 的「大类纠正」）。
func impSetMappingProductID(ctx context.Context, q Querier, mid, productID int) error {
	_, err := q.ExecContext(ctx, "UPDATE code_mappings SET product_id = ?, updated_at = ? WHERE id = ?",
		productID, NowDB(), mid)
	return err
}

// ImpRuleFromJst POST /api/pack-rules/from-jushuitan：
// 把导入时用户手动补选的一单多货组合写进「一单多货规则」，供后续自动命中。
// items.name 保留聚水潭外部商品名（组合匹配靠它），product_id 指向所选系统商品。
func ImpRuleFromJst(ctx context.Context, q Querier, items []map[string]any) (map[string]any, error) {
	if len(items) == 0 {
		return nil, ErrText("没有组合商品")
	}
	ruleItems := []map[string]any{}
	for _, it := range items {
		name := strings.TrimSpace(ToStr(it["external_code"]))
		if name == "" {
			return nil, ErrText("外部商品名不能为空")
		}
		pid := ToInt(it["product_id"])
		if pid == 0 {
			continue
		}
		p := impGetProduct(ctx, q, pid)
		if p == nil {
			return nil, ErrText("商品不存在：%s", name)
		}
		qty := ToFloat(it["quantity"])
		if qty == 0 {
			qty = 1
		}
		ruleItems = append(ruleItems, map[string]any{"name": name, "quantity": qty, "product_id": p.ID})
	}
	if len(ruleItems) == 0 {
		return nil, ErrText("请为组合中的商品选择关联商品")
	}

	parts := make([]string, 0, len(ruleItems))
	for _, it := range ruleItems {
		q := ToFloat(it["quantity"])
		n := ToStr(it["name"])
		if q != 1 {
			parts = append(parts, n+"*"+FmtQty(q))
		} else {
			parts = append(parts, n)
		}
	}
	comboName := strings.Join(parts, ",")

	var existID int
	_ = q.QueryRowContext(ctx, "SELECT id FROM pack_rules WHERE name = ? ORDER BY id LIMIT 1", comboName).Scan(&existID)
	if existID != 0 {
		if _, err := q.ExecContext(ctx, "UPDATE pack_rules SET items = ?, is_active = 1 WHERE id = ?",
			EncodeJSONColumn(ruleItems), existID); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "id": existID, "created": false}, nil
	}
	if _, err := q.ExecContext(ctx,
		"INSERT INTO pack_rules (name, items, box_type, box_items, labor_price, box_ratio, remark, is_active, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
		comboName, EncodeJSONColumn(ruleItems), "", EncodeJSONColumn([]any{}), nil, 1.0, "导入自动生成", 1, NowDB()); err != nil {
		return nil, err
	}
	var id int
	if err := q.QueryRowContext(ctx, "SELECT id FROM pack_rules WHERE name = ? ORDER BY id LIMIT 1", comboName).Scan(&id); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "id": id, "created": true}, nil
}

// ImpLogManualJstImport _log_manual_jst_import：把「古法导入」（手动上传聚水潭导出文件）
// 也记进「自动出库设置 → 执行记录」。只追加记录、不覆盖「上次执行」；记失败不影响导入结果。
func ImpLogManualJstImport(key, whName, source string, res map[string]any, dates []string, note string) {
	sorted := append([]string{}, dates...)
	sort.Strings(sorted)
	var clean []string
	for _, d := range sorted {
		if d != "" {
			clean = append(clean, d)
		}
	}
	created := ToInt(res["created"])
	failedCnt := ToInt(res["failed_count"])
	msg := "古法导入："
	if source != "" {
		msg += "「" + source + "」"
	} else {
		msg += "手动上传聚水潭导出文件"
	}
	msg += fmt.Sprintf("，新建出库单 %d 张", created)
	if failedCnt != 0 {
		msg += fmt.Sprintf("，失败 %d 张", failedCnt)
	}
	if note != "" {
		msg += "，" + note
	}
	window := ""
	if len(clean) > 0 {
		window = clean[0] + " ~ " + clean[len(clean)-1]
	}
	files := []any{}
	if source != "" {
		files = append(files, source)
	}
	entry := map[string]any{
		"at":             time.Now().Format("2006-01-02 15:04:05"),
		"trigger":        "古法导入",
		"ok":             failedCnt == 0,
		"warehouse":      key,
		"warehouse_name": whName,
		"targets":        []any{},
		"files":          files,
		"window":         window,
		"stats":          map[string]any{"created": created, "failed": failedCnt},
		"message":        msg,
	}
	_ = JstRecordRun(key, entry, false)
}
