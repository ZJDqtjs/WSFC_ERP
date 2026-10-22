package erp

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
)

// 编码一对一（商品编码冲突 409 / 替换）——对齐 products.py 的 _code_owner / _take_code。

func seedProducts(t *testing.T) (context.Context, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE TABLE products (
		id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '')`); err != nil {
		t.Fatal(err)
	}
	for _, p := range []struct{ code, name string }{{"A01", "木耳"}, {" A02 ", "香菇"}, {"", "无名"}} {
		if _, err := db.ExecContext(ctx, "INSERT INTO products (code, name) VALUES (?, ?)", p.code, p.name); err != nil {
			t.Fatal(err)
		}
	}
	return ctx, db
}

func TestProductCodeOwner(t *testing.T) {
	ctx, db := seedProducts(t)

	// 空编码不校验
	if _, _, ok := ProductCodeOwner(ctx, db, "  ", 0); ok {
		t.Error("空编码不该有占用方")
	}
	// trim 后精确匹配：库里是 ' A02 '，查询 'A02' 也要命中
	if id, name, ok := ProductCodeOwner(ctx, db, " A02 ", 0); !ok || name != "香菇" || id != 2 {
		t.Errorf("trim 匹配异常: id=%d name=%q ok=%v", id, name, ok)
	}
	// exclude 自己 → 不算冲突
	if _, _, ok := ProductCodeOwner(ctx, db, "A02", 2); ok {
		t.Error("排除自身后不该有占用方")
	}
	// excludeID=0 等价「不排除」（Python 的 if exclude_id:）
	if _, _, ok := ProductCodeOwner(ctx, db, "A01", 0); !ok {
		t.Error("A01 应被木耳占用")
	}
}

func TestTakeProductCode(t *testing.T) {
	ctx, db := seedProducts(t)

	if err := TakeProductCode(ctx, db, "", 0, false); err != nil {
		t.Errorf("空编码直接放行，实际 %v", err)
	}
	if err := TakeProductCode(ctx, db, "A99", 0, false); err != nil {
		t.Errorf("没人用的编码直接放行，实际 %v", err)
	}

	err := TakeProductCode(ctx, db, "  A01 ", 0, false)
	var de *DetailError
	if !errors.As(err, &de) {
		t.Fatalf("冲突应返回结构化 detail，实际 %T %v", err, err)
	}
	if de.StatusCode() != 409 {
		t.Errorf("状态码 = %d，想要 409", de.StatusCode())
	}
	want := `{"message":"编码「A01」已被商品「木耳」使用（编码一对一）",` +
		`"code_conflict":{"id":1,"name":"木耳","code":"A01"}}`
	if got := string(AIJSONCompact(de.Body)); got != want {
		t.Errorf("detail 不一致\n得到 %s\n想要 %s", got, want)
	}

	// 替换：占用方编码清空，编码改给当前商品
	if err := TakeProductCode(ctx, db, "A01", 3, true); err != nil {
		t.Fatal(err)
	}
	var code string
	if err := db.QueryRowContext(ctx, "SELECT code FROM products WHERE id = 1").Scan(&code); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(code) != "" {
		t.Errorf("替换后木耳的编码应清空，实际 %q", code)
	}
}
