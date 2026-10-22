package erp

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// 出库「多套扣减方案」的选方案与扣减口径（对齐 services.deduction_scheme / _deduction_plan）。

const testProductDDL = `CREATE TABLE products (
	id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT DEFAULT '', name TEXT DEFAULT '',
	category TEXT DEFAULT '', product_type TEXT DEFAULT 'stock', base_unit TEXT DEFAULT '',
	default_unit TEXT DEFAULT '', spec TEXT DEFAULT '', sale_price FLOAT DEFAULT 0,
	unit_cost FLOAT DEFAULT 0, conversions TEXT DEFAULT '{}', pack_items TEXT DEFAULT '[]',
	pack_fee FLOAT DEFAULT 0, is_active INTEGER DEFAULT 1, stock_product_id INTEGER,
	multiplier FLOAT DEFAULT 1, stock FLOAT DEFAULT 0, avg_cost FLOAT DEFAULT 0,
	stock_value FLOAT DEFAULT 0, created_at DATETIME, workload FLOAT DEFAULT 0,
	weight_kg FLOAT DEFAULT 0, stock_links TEXT DEFAULT '[]', free_shipping INTEGER DEFAULT 0,
	stock_schemes TEXT DEFAULT '[]')`

func schemeFixture(t *testing.T) (context.Context, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, testProductDDL); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE inbounds (id INTEGER PRIMARY KEY AUTOINCREMENT,
		product_id INTEGER, date TEXT)`); err != nil {
		t.Fatal(err)
	}
	add := func(name, ptype, du string, conv map[string]float64, links, schemes string) int {
		t.Helper()
		res, err := db.ExecContext(ctx, "INSERT INTO products (name, product_type, base_unit, default_unit, "+
			"conversions, stock_links, stock_schemes, created_at) VALUES (?,?,?,?,?,?,?,?)",
			name, ptype, du, du, EncodeJSONColumn(conv), links, schemes, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return int(id)
	}
	// 两个库存商品：1 公斤装、2 斤装
	add("库存甲", "stock", "公斤", map[string]float64{"公斤": 1000}, "[]", "[]")
	add("库存乙", "stock", "公斤", map[string]float64{"公斤": 1000}, "[]", "[]")
	add("订单丙", "stock", "公斤", map[string]float64{"公斤": 1000}, "[]", "[]")
	add("单关联旧商品", "order", "单", map[string]float64{"单": 1}, "[]", "[]")
	return ctx, db
}

func setInbound(t *testing.T, db *sql.DB, pid int, date string) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(),
		"INSERT INTO inbounds (product_id, date) VALUES (?, ?)", pid, date); err != nil {
		t.Fatal(err)
	}
}

func TestDeductionSchemeSelection(t *testing.T) {
	ctx, db := schemeFixture(t)

	// 配了两套方案：第一套扣 库存甲×2，第二套扣 库存乙×1
	order := addSchemeProduct(t, ctx, db, `[{"name":"四合一","links":[{"product_id":1,"multiplier":2}]},`+
		`{"name":"","links":[{"product_id":2,"multiplier":1}]}]`)

	// 都没入库记录 → 用第一套（顺序最可预期）
	links, name, err := DeductionScheme(ctx, db, order)
	if err != nil {
		t.Fatal(err)
	}
	if name != "四合一" || len(links) != 1 || links[0].ProductID != 1 {
		t.Errorf("无入库记录应选第一套：%q %+v", name, links)
	}

	// 第二套里的库存商品进了更新的货 → 选第二套，方案名留空补「方案2」
	setInbound(t, db, 1, "2026-09-01")
	setInbound(t, db, 2, "2026-10-05")
	order = reload(t, ctx, db, order.ID)
	links, name, err = DeductionScheme(ctx, db, order)
	if err != nil {
		t.Fatal(err)
	}
	if name != "方案2" || len(links) != 1 || links[0].ProductID != 2 {
		t.Errorf("应选最近进货的第二套：%q %+v", name, links)
	}

	// 日期并列 → 严格大于，保留前面那套
	setInbound(t, db, 1, "2026-10-05")
	order = reload(t, ctx, db, order.ID)
	links, name, err = DeductionScheme(ctx, db, order)
	if err != nil {
		t.Fatal(err)
	}
	if name != "四合一" || links[0].ProductID != 1 {
		t.Errorf("并列应保留第一套：%q %+v", name, links)
	}
}

func TestDeductionPlanWithSchemes(t *testing.T) {
	ctx, db := schemeFixture(t)
	setInbound(t, db, 2, "2026-10-05") // 库存乙最近进过货 → 选第二套
	order := addSchemeProduct(t, ctx, db, `[{"name":"方案A","links":[{"product_id":1,"multiplier":2}]},`+
		`{"name":"方案B","links":[{"product_id":2,"multiplier":3}]}]`)

	deds, schemeName, err := DeductionPlan(ctx, db, order, 10, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if schemeName != "方案B" || len(deds) != 1 || deds[0].Target.ID != 2 {
		t.Fatalf("应扣第二套方案：%q %+v", schemeName, deds)
	}
	// 扣减量 = 订单基础数量 × 倍数 × 库存默认单位系数 = 10 × 3 × 1000
	if deds[0].Qty != 30000 {
		t.Errorf("扣减量 = %v，想要 30000", deds[0].Qty)
	}

	// 一单多货规则显式指定库存大类 → 规则优先，方案名清空
	deds, schemeName, err = DeductionPlan(ctx, db, order, 10, 3, 2)
	if err != nil {
		t.Fatal(err)
	}
	if schemeName != "" || len(deds) != 1 || deds[0].Target.ID != 3 || deds[0].Qty != 20000 {
		t.Errorf("规则指定应覆盖商品方案：%q %+v", schemeName, deds)
	}

	// 没配多方案的老商品：仍按 stock_links 扣减，方案名为空
	if _, err := db.ExecContext(ctx,
		`UPDATE products SET stock_links = '[{"product_id":1,"multiplier":1.5}]' WHERE id = 4`); err != nil {
		t.Fatal(err)
	}
	deds, schemeName, err = DeductionPlan(ctx, db, reload(t, ctx, db, 4), 4, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if schemeName != "" || len(deds) != 1 || deds[0].Qty != 6000 {
		t.Errorf("老口径应扣 4×1.5×1000：%q %+v", schemeName, deds)
	}

	// 无任何关联 = 代发：不扣库存、方案名为空
	drop := addSchemeProduct(t, ctx, db, "[]")
	deds, schemeName, err = DeductionPlan(ctx, db, drop, 5, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if schemeName != "" || len(deds) != 0 {
		t.Errorf("代发不该扣库存：%q %+v", schemeName, deds)
	}
}

func addSchemeProduct(t *testing.T, ctx context.Context, db *sql.DB, schemes string) *Product {
	t.Helper()
	res, err := db.ExecContext(ctx, `INSERT INTO products
		(name, product_type, base_unit, default_unit, conversions, stock_links, stock_schemes, created_at)
		VALUES ('订单商品','order','单','单','{"单": 1}','[]',?,?)`, schemes, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	p, err := GetProduct(ctx, db, int(id))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func reload(t *testing.T, ctx context.Context, db *sql.DB, id int) *Product {
	t.Helper()
	p, err := GetProduct(ctx, db, id)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
