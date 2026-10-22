package erp

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestAiLooksLikeRule(t *testing.T) {
	yes := []string{
		"京东8号->8号纸箱",
		"清芹就是水果西芹",
		"一件清芹 13公斤水果西芹",
		"别名：大果等于特大果",
	}
	for _, s := range yes {
		if !aiLooksLikeRule(s) {
			t.Errorf("应识别为规则: %q", s)
		}
	}
	no := []string{
		"今天入库100斤木耳25一斤",          // 普通流水描述
		"箱子",                      // 太短
		strings.Repeat("就是", 300), // 超长
	}
	for _, s := range no {
		if aiLooksLikeRule(s) {
			t.Errorf("不该记成规则: %q", s)
		}
	}
	if got := aiMemoryKind("一件清芹 13公斤"); got != "unit" {
		t.Errorf("装箱换算应归 unit，得到 %q", got)
	}
	if got := aiMemoryKind("京东8号->8号纸箱"); got != "alias" {
		t.Errorf("别名应归 alias，得到 %q", got)
	}
}

func TestAiMemNormAndGrams(t *testing.T) {
	if got := aiMemNorm(" 京东8号 -> 8号纸箱 "); got != "京东8号->8号纸箱" {
		t.Errorf("aiMemNorm = %q", got)
	}
	g := aiMemGrams("清芹 12 水果，西芹")
	for _, want := range []string{"清芹", "芹水", "水果", "果西", "西芹"} {
		if !g[want] {
			t.Errorf("2-gram 缺 %q（实际 %v）", want, g)
		}
	}
	if len(g) != 5 {
		t.Errorf("数字与标点应被剔除，得到 %d 个 gram: %v", len(g), g)
	}
}

func TestAIRememberNoteAndBlock(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE TABLE ai_memories (
		id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, norm TEXT NOT NULL UNIQUE,
		kind TEXT NOT NULL, source TEXT NOT NULL, is_active INTEGER NOT NULL,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if got := AIRememberNote(ctx, db, "今天入库100斤木耳", "text"); got != nil {
		t.Errorf("非规则不该记: %v", got)
	}
	first := AIRememberNote(ctx, db, "京东8号 -> 8号纸箱", "text")
	if first == nil || !ToBool(first.Get("added")) || first.Str("text") != "京东8号 -> 8号纸箱" {
		t.Fatalf("首次记录异常: %v", first)
	}
	again := AIRememberNote(ctx, db, "京东8号->8号纸箱", "hint") // 去空白后同一句
	if again == nil || ToBool(again.Get("added")) || again.Has("reactivated") {
		t.Errorf("重复规则应只回 added=false: %v", again)
	}
	if n := countRows(ctx, t, db); n != 1 {
		t.Fatalf("去重失效，表里有 %d 行", n)
	}
	if _, err := db.ExecContext(ctx, "UPDATE ai_memories SET is_active = 0"); err != nil {
		t.Fatal(err)
	}
	re := AIRememberNote(ctx, db, "京东8号->8号纸箱", "hint")
	if re == nil || !ToBool(re.Get("reactivated")) || ToBool(re.Get("added")) {
		t.Errorf("停用后再说一遍应恢复: %v", re)
	}
	block := AIMemoryBlock(ctx, db, "这次的票据里有 京东8号")
	if !strings.Contains(block, "【历史约定") || !strings.Contains(block, "- 京东8号 -> 8号纸箱") {
		t.Errorf("记忆块未注入: %q", block)
	}
	if _, err := db.ExecContext(ctx, "UPDATE ai_memories SET is_active = 0"); err != nil {
		t.Fatal(err)
	}
	if got := AIMemoryBlock(ctx, db, "京东8号"); got != "" {
		t.Errorf("无在用记忆应为空串，得到 %q", got)
	}
}

func countRows(ctx context.Context, t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM ai_memories").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAIMemoryCrud(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE TABLE ai_memories (
		id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, norm TEXT NOT NULL UNIQUE,
		kind TEXT NOT NULL, source TEXT NOT NULL, is_active INTEGER NOT NULL,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}

	// 太短 / 太长都按 Python 文案报 400
	for _, bad := range []struct{ text, msg string }{{" 只 ", "记忆内容太短"}, {strings.Repeat("字", 501), "记忆内容太长（≤500 字）"}} {
		if _, err := AIAddMemory(ctx, db, bad.text); err == nil || !strings.Contains(ErrMessage(err), bad.msg) {
			t.Errorf("%q 应报 %q，实际 %v", bad.text, bad.msg, err)
		}
	}

	out, err := AIAddMemory(ctx, db, "  大果   就是 特大果\n")
	if err != nil {
		t.Fatal(err)
	}
	if out.Str("text") != "大果 就是 特大果" || !ToBool(out.Get("ok")) {
		t.Errorf("回执异常: %v", out)
	}
	if !out.Has("ok") || out.Keys()[0] != "ok" {
		t.Errorf("键序应为 ok,text，实际 %v", out.Keys())
	}
	// 手动添加不做规则判定：普通句子也会记下
	if n := countRows(ctx, t, db); n != 1 {
		t.Fatalf("手动新增后应有 1 行，实际 %d", n)
	}
	// 同一句（去空白/大小写后）不重复插入
	if _, err := AIAddMemory(ctx, db, "大果就是特大果"); err != nil {
		t.Fatal(err)
	}
	if n := countRows(ctx, t, db); n != 1 {
		t.Fatalf("去重失效，实际 %d 行", n)
	}

	// 手动加过的若是停用记录 → 重新启用；列表只回启用的，新的在前
	if _, err := db.ExecContext(ctx, "UPDATE ai_memories SET is_active = 0"); err != nil {
		t.Fatal(err)
	}
	if rows, err := AIMemoriesList(ctx, db); err != nil || len(rows) != 0 {
		t.Errorf("停用后列表应为空：%v / %v", rows, err)
	}
	if _, err := AIAddMemory(ctx, db, "大果 就是 特大果"); err != nil {
		t.Fatal(err)
	}
	rows, err := AIMemoriesList(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("恢复后应列出 1 条，实际 %d", len(rows))
	}
	want := []string{"id", "text", "kind", "source", "created_at"}
	if !reflect.DeepEqual(rows[0].Keys(), want) {
		t.Errorf("列表键序 = %v，想要 %v", rows[0].Keys(), want)
	}
	if rows[0].Str("source") != "manual" || rows[0].Str("kind") != "alias" {
		t.Errorf("列表行内容异常: %v", rows[0])
	}
	if len(rows[0].Str("created_at")) != 16 {
		t.Errorf("created_at 应精确到分钟，实际 %q", rows[0].Str("created_at"))
	}

	// 删除：不存在 → 404「记忆不存在」
	if err := AIDeleteMemory(ctx, db, 9999); err == nil ||
		!strings.Contains(ErrMessage(err), "记忆不存在") || asStatus(err) != 404 {
		t.Errorf("删除不存在的记忆应 404 记忆不存在，实际 %v", err)
	}
	id := int(rows[0].Num("id"))
	if err := AIDeleteMemory(ctx, db, id); err != nil {
		t.Fatal(err)
	}
	if n := countRows(ctx, t, db); n != 0 {
		t.Errorf("删除是硬删，实际还剩 %d 行", n)
	}

	// 清空：连停用的也一起删
	if _, err := AIAddMemory(ctx, db, "一件纸箱 12个"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO ai_memories (text,norm,kind,source,is_active,created_at,updated_at)"+
		" VALUES ('停用','tingyong','alias','manual',0,'2026-01-01 00:00:00','2026-01-01 00:00:00')"); err != nil {
		t.Fatal(err)
	}
	if err := AIClearMemories(ctx, db); err != nil {
		t.Fatal(err)
	}
	if n := countRows(ctx, t, db); n != 0 {
		t.Errorf("清空后应 0 行，实际 %d", n)
	}
}

func asStatus(err error) int {
	var de interface{ StatusCode() int }
	if errors.As(err, &de) {
		return de.StatusCode()
	}
	return 0
}
