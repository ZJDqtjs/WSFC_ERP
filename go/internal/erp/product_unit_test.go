package erp

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

// 跨类别改基础单位（计数「个」↔ 重量「克」）——对齐 products.py 的 _base_unit_category / _rescale_base_unit_change。

func unitFixture(t *testing.T) (context.Context, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	_, err = db.ExecContext(ctx, `
		CREATE TABLE stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INT, quantity_base REAL);
		CREATE TABLE inbounds (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INT, quantity_base REAL);`)
	if err != nil {
		t.Fatal(err)
	}
	return ctx, db
}

func addHistory(t *testing.T, db *sql.DB, pid int, qty float64) {
	t.Helper()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `INSERT INTO stock_movements (product_id, quantity_base) VALUES (?, ?)`, pid, qty); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO inbounds (product_id, quantity_base) VALUES (?, ?)`, pid, qty); err != nil {
		t.Fatal(err)
	}
}

func baseQty(t *testing.T, db *sql.DB, table string, pid int) float64 {
	t.Helper()
	var v float64
	if err := db.QueryRowContext(context.Background(), "SELECT quantity_base FROM "+table+" WHERE product_id = ?", pid).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestRescaleBaseUnitChangeSkips(t *testing.T) {
	ctx, db := unitFixture(t)
	p := &Product{ID: 7, Name: "木耳菜", BaseUnit: "个", Stock: 10}
	addHistory(t, db, p.ID, 10)

	// 没改 / 改成空 / 同类别（计数类之间）都不折算，即便有历史也不要求系数
	for _, newBase := range []string{"", "个", "只", "件"} {
		k, err := RescaleBaseUnitChange(ctx, db, p, newBase, 0)
		if err != nil || k != 0 {
			t.Errorf("基准 %q → %q 不该折算：k=%v err=%v", p.BaseUnit, newBase, k, err)
		}
	}
	if v := baseQty(t, db, "stock_movements", p.ID); v != 10 {
		t.Errorf("同类别改动不该动历史：quantity_base=%v", v)
	}

	// 重量类内部（克 ↔ g）同理：Python 只把「克/g」当重量类，其余都算计数类
	gram := &Product{ID: 8, Name: "称重菜", BaseUnit: "克", Stock: 10}
	addHistory(t, db, gram.ID, 10)
	if k, err := RescaleBaseUnitChange(ctx, db, gram, "G", 0); err != nil || k != 0 {
		t.Errorf("克→G 同类别不该折算：k=%v err=%v", k, err)
	}

	// 完全没有历史：跨类别也不需要系数
	empty := &Product{ID: 9, Name: "无名", BaseUnit: "个"}
	if k, err := RescaleBaseUnitChange(ctx, db, empty, "克", 0); err != nil || k != 0 {
		t.Errorf("无历史应直接放行：k=%v err=%v", k, err)
	}
}

func TestRescaleBaseUnitChangeRequiresRatio(t *testing.T) {
	ctx, db := unitFixture(t)
	p := &Product{ID: 7, Name: "木耳菜", BaseUnit: "个", Stock: 10}
	addHistory(t, db, p.ID, 10)

	_, err := RescaleBaseUnitChange(ctx, db, p, "克", 0)
	var be *BizError
	if !errors.As(err, &be) || be.StatusCode() != 400 {
		t.Fatalf("跨类别有历史且不给系数应 400，实际 %T %v", err, err)
	}
	want := "商品「木耳菜」已有 1 条库存流水、1 条入库记录（当前库存 10 个），" +
		"从「个」改成「克」不是一个类别，历史数量与成本会被按新单位重新解读（均价会被放大 个→克 的倍数）。\n" +
		"请填写换算关系：1 个 = ? 克；或先清理该商品的入库/出库单据后再改单位。"
	if be.Msg != want {
		t.Errorf("400 文案不一致\n得到 %q\n想要 %q", be.Msg, want)
	}
	if v := baseQty(t, db, "stock_movements", p.ID); v != 10 {
		t.Errorf("报错后不该写库：quantity_base=%v", v)
	}
}

func TestRescaleBaseUnitChangeAppliesRatio(t *testing.T) {
	ctx, db := unitFixture(t)
	p := &Product{ID: 7, Name: "木耳菜", BaseUnit: "个", Stock: 10}
	addHistory(t, db, p.ID, 10)

	k, err := RescaleBaseUnitChange(ctx, db, p, "克", 1000)
	if err != nil || k != 1000 {
		t.Fatalf("折算失败：k=%v err=%v", k, err)
	}
	if v := baseQty(t, db, "stock_movements", p.ID); v != 10000 {
		t.Errorf("流水应按 1 个 = 1000 克 折算，实际 %v", v)
	}
	if v := baseQty(t, db, "inbounds", p.ID); v != 10000 {
		t.Errorf("入库行应同步折算，实际 %v", v)
	}

	// 只有流水、没有入库行时，不能去 UPDATE 不存在的入库记录（Python 的 if inbs:）
	only, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { only.Close() })
	only.SetMaxOpenConns(1)
	if _, err := only.ExecContext(ctx, `
		CREATE TABLE stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INT, quantity_base REAL);
		CREATE TABLE inbounds (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INT, quantity_base REAL);
		INSERT INTO stock_movements (product_id, quantity_base) VALUES (9, 4)`); err != nil {
		t.Fatal(err)
	}
	if k, err := RescaleBaseUnitChange(ctx, only, &Product{ID: 9, Name: "只有流水", BaseUnit: "个", Stock: 4}, "克", 0.5); err != nil || k != 0.5 {
		t.Fatalf("小数系数：k=%v err=%v", k, err)
	}
	var v float64
	if err := only.QueryRowContext(ctx, "SELECT quantity_base FROM stock_movements WHERE product_id = 9").Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != 2 {
		t.Errorf("0.5 系数应把 4 折成 2，实际 %v", v)
	}
}
