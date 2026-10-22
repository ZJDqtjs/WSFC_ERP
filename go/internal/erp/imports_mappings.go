package erp

// ---------------- 编码关联（/api/mappings*）与聚水潭商品自动新增 ----------------

import (
	"context"
	"database/sql"
)

// ImpCodeMapping code_mappings 的一行。
type ImpCodeMapping struct {
	ID           int
	Source       string
	ExternalCode string
	ExternalName string
	ProductID    *int
	AutoScore    float64
}

func scanCodeMapping(scan func(dest ...any) error) (ImpCodeMapping, error) {
	var m ImpCodeMapping
	var productID sql.NullInt64
	err := scan(&m.ID, &m.Source, &m.ExternalCode, &m.ExternalName, &productID, &m.AutoScore)
	if productID.Valid {
		v := int(productID.Int64)
		m.ProductID = &v
	}
	return m, err
}

const codeMappingColumns = "id, source, external_code, external_name, product_id, auto_score"

// impListCodeMappings 按 SQL 片段取关联记录（order/where 由调用方给，顺序即返回顺序）。
func impListCodeMappings(ctx context.Context, q Querier, where string, args []any, orderBy string) ([]ImpCodeMapping, error) {
	query := "SELECT " + codeMappingColumns + " FROM code_mappings"
	if where != "" {
		query += " WHERE " + where
	}
	if orderBy != "" {
		query += " ORDER BY " + orderBy
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ImpCodeMapping{}
	for rows.Next() {
		m, err := scanCodeMapping(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func impCodeMappingByID(ctx context.Context, q Querier, id int) (*ImpCodeMapping, error) {
	rows, err := impListCodeMappings(ctx, q, "id = ?", []any{id}, "")
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return &rows[0], nil
}

func impCodeMappingByCode(ctx context.Context, q Querier, source, extCode string) (*ImpCodeMapping, error) {
	// Python 用 select().where(source, external_code) 取第一条：SQLite 按 rowid 升序
	rows, err := impListCodeMappings(ctx, q, "source = ? AND external_code = ?", []any{source, extCode}, "id")
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return &rows[0], nil
}

// UpsertCodeMapping _upsert_mapping：有则改关联商品，无则新增（external_name 空、auto_score 0）。
func UpsertCodeMapping(ctx context.Context, q Querier, source, extCode string, productID *int) error {
	m, err := impCodeMappingByCode(ctx, q, source, extCode)
	if err != nil {
		return err
	}
	if m != nil {
		_, err := q.ExecContext(ctx, "UPDATE code_mappings SET product_id = ?, updated_at = ? WHERE id = ?",
			AsInt(productID), NowDB(), m.ID)
		return err
	}
	_, err = q.ExecContext(ctx,
		"INSERT INTO code_mappings (source, external_code, external_name, product_id, auto_score, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
		source, extCode, "", AsInt(productID), 0.0, NowDB(), NowDB())
	return err
}

// ImpListMappings GET /api/mappings 的业务部分。
func ImpListMappings(ctx context.Context, q Querier) (map[string]any, error) {
	list, err := impListCodeMappings(ctx, q, "", nil, "id DESC")
	if err != nil {
		return nil, err
	}
	// 预取关联商品，避免逐条查询（与 Python 一样先批量取商品、再批量取大类名）
	ids := []int{}
	seen := map[int]bool{}
	for _, m := range list {
		if m.ProductID != nil && !seen[*m.ProductID] {
			seen[*m.ProductID] = true
			ids = append(ids, *m.ProductID)
		}
	}
	prods := map[int]*Product{}
	if len(ids) > 0 {
		rows, err := q.QueryContext(ctx, "SELECT "+productColumns+" FROM products WHERE id IN ("+Placeholders(len(ids))+")", ToArgs(ids)...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			p, err := scanProduct(rows.Scan)
			if err == nil {
				prods[p.ID] = p
			}
		}
	}
	spIDs := []int{}
	spSeen := map[int]bool{}
	for _, p := range prods {
		if p.StockProductID != nil && !spSeen[*p.StockProductID] {
			spSeen[*p.StockProductID] = true
			spIDs = append(spIDs, *p.StockProductID)
		}
	}
	spNames := map[int]string{}
	if len(spIDs) > 0 {
		rows, err := q.QueryContext(ctx, "SELECT id, name FROM products WHERE id IN ("+Placeholders(len(spIDs))+")", ToArgs(spIDs)...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id int
			var name string
			if err := rows.Scan(&id, &name); err == nil {
				spNames[id] = name
			}
		}
	}

	items := []map[string]any{}
	linked, linkedOrder, linkedStock := 0, 0, 0
	for _, m := range list {
		var p *Product
		if m.ProductID != nil {
			p = prods[*m.ProductID]
		}
		externalName := m.ExternalName
		if externalName == "" {
			externalName = m.ExternalCode
		}
		item := map[string]any{
			"id": m.ID, "source": m.Source,
			"external_code": m.ExternalCode, "external_name": externalName,
			"product_id": AsInt(m.ProductID),
			"auto_score": m.AutoScore,
		}
		if p != nil {
			item["product_name"] = p.Name
			item["product_type"] = p.ProductType
			item["product_category"] = p.Category
			item["stock_product_id"] = AsInt(p.StockProductID)
			name := ""
			if p.StockProductID != nil {
				name = spNames[*p.StockProductID]
			}
			item["stock_product_name"] = name
		} else {
			item["product_name"] = ""
			item["product_type"] = ""
			item["product_category"] = ""
			item["stock_product_id"] = nil
			item["stock_product_name"] = ""
		}
		items = append(items, item)
		if p != nil {
			linked++
			if p.ProductType == "order" {
				linkedOrder++
			} else {
				linkedStock++
			}
		}
	}
	return map[string]any{
		"summary": map[string]any{
			"total": len(items), "linked": linked, "unlinked": len(items) - linked,
			"linked_order": linkedOrder, "linked_stock": linkedStock,
		},
		"items": items,
	}, nil
}

// ImpSetMapping POST /api/mappings 的业务部分。
func ImpSetMapping(ctx context.Context, q Querier, source, extCode string, productID *int) (map[string]any, error) {
	if err := UpsertCodeMapping(ctx, q, source, extCode, productID); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// ImpBulkMappings POST /api/mappings/bulk 的业务部分。
func ImpBulkMappings(ctx context.Context, q Querier, source string, items []map[string]any) (map[string]any, error) {
	for _, it := range items {
		if err := UpsertCodeMapping(ctx, q, source, ToStr(it["external_code"]), OptInt(it, "product_id")); err != nil {
			return nil, err
		}
	}
	return map[string]any{"ok": true, "saved": len(items)}, nil
}

// ImpAutoMappings POST /api/mappings/auto 的业务部分：只关联到库存大类，用基础名精确/高阈值匹配。
func ImpAutoMappings(ctx context.Context, q Querier) (map[string]any, error) {
	rows, err := impListCodeMappings(ctx, q, "product_id IS NULL", nil, "id")
	if err != nil {
		return nil, err
	}
	matched := 0
	for _, m := range rows {
		stock := MatchStock(ctx, q, m.ExternalCode)
		if stock == nil {
			continue
		}
		pid := stock.ID
		if err := UpsertCodeMapping(ctx, q, m.Source, m.ExternalCode, &pid); err != nil {
			return nil, err
		}
		if _, err := q.ExecContext(ctx, "UPDATE code_mappings SET auto_score = 1.0, updated_at = ? WHERE id = ?", NowDB(), m.ID); err != nil {
			return nil, err
		}
		matched++
	}
	return map[string]any{"ok": true, "matched": matched, "total": len(rows)}, nil
}

// ImpClearMappings DELETE /api/mappings 的业务部分（按来源整批清空）。
func ImpClearMappings(ctx context.Context, q Querier, source string) (map[string]any, error) {
	if _, err := q.ExecContext(ctx, "DELETE FROM code_mappings WHERE source = ?", source); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// ImpDeleteMapping DELETE /api/mappings/{mid} 的业务部分。
func ImpDeleteMapping(ctx context.Context, q Querier, mid int) (map[string]any, error) {
	m, err := impCodeMappingByID(ctx, q, mid)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, Err404("关联记录不存在")
	}
	if _, err := q.ExecContext(ctx, "DELETE FROM code_mappings WHERE id = ?", mid); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// ---------------- 订单商品（小类）自动新增 ----------------

// AutoCreateOrderProduct _auto_create_order：为外部商品名新建订单小类（可空关联库存大类）。
func AutoCreateOrderProduct(ctx context.Context, q Querier, extName string, stock *Product) (*Product, error) {
	if existing := productByColumn(ctx, q, "name", extName); existing != nil {
		return existing, nil
	}
	mult := 1.0
	spec := "未关联库存，待匹配"
	category := "待分类"
	links := "[]"
	spArg := any(nil)
	if stock != nil {
		mult = SpecMultiplier(stock, extName)
		du := stock.DefaultUnit
		if du == "" {
			du = stock.BaseUnit
		}
		spec = "每单约 " + FmtQty(mult) + du
		category = stock.Category
		spArg = stock.ID
		links = EncodeJSONColumn([]StockLink{{ProductID: stock.ID, Multiplier: mult}})
	}
	res, err := q.ExecContext(ctx, `INSERT INTO products (code, name, category, product_type, base_unit, default_unit,
		spec, sale_price, unit_cost, weight_kg, free_shipping, conversions, pack_items, pack_fee, is_active,
		stock_product_id, multiplier, stock_links, stock, avg_cost, stock_value, workload, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,1.0,?,0,0,0,0,?)`,
		extName, extName, category, "order", "单", "单", spec,
		0.0, 0.0, 0.0, 0, EncodeJSONColumn(map[string]float64{"单": 1}), "[]", 0.0,
		spArg, links, NowDB())
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return GetProduct(ctx, q, int(id))
}

// SetOrderStockLink 给已存在但未关联库存的订单小类补关键词关联（/api/jushuitan/parse 用）。
func SetOrderStockLink(ctx context.Context, q Querier, order *Product, stock *Product) error {
	mult := SpecMultiplier(stock, order.Name)
	order.Multiplier = mult
	du := stock.DefaultUnit
	if du == "" {
		du = stock.BaseUnit
	}
	spec := "每单约 " + FmtQty(mult) + du
	links := EncodeJSONColumn([]StockLink{{ProductID: stock.ID, Multiplier: mult}})
	_, err := q.ExecContext(ctx,
		"UPDATE products SET stock_product_id = ?, multiplier = ?, stock_links = ?, spec = ? WHERE id = ?",
		stock.ID, mult, links, spec, order.ID)
	if err == nil {
		order.StockProductID = &stock.ID
		order.Spec = spec
	}
	return err
}
