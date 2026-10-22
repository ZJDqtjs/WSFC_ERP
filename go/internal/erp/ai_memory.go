package erp

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// 本文件是「AI 识别记忆」（routers/ai.py 的 _remember_note / _memory_block）：
// 用户在补充说明里给出的「别名对应 / 装箱换算」这类规则，记进 ai_memories 表，
// 之后每次识别都作为「历史约定」注入提示词。写库失败只记日志，不影响识别（同 Python）。

const (
	aiMemoryKeep   = 300 // 每仓最多保留条数（超出删最旧）
	aiMemoryInject = 60  // 每次识别最多注入条数
)

var (
	aiRuleWords = []string{"就是", "->", "→", "统一叫", "统一转", "叫做", "又叫", "也叫", "别名", "等于", "＝"}
	aiPackWords = []string{"一件", "一箱", "一包", "一袋", "一筐", "每件", "每箱", "每包", "每袋"}

	aiMemSpaceRe   = regexp.MustCompile(`\s+`)
	aiMemNonLetRe  = regexp.MustCompile(`[^\p{L}]+`) // Python [\s\d\W_]+：去空白/数字/下划线/标点，留下文字
	aiMemPackQtyRe = regexp.MustCompile(`\d+(?:\.\d+)?\s*(?:kg|KG|公斤|千克|斤|克|个|袋|箱|包)`)
	aiMemUnitQtyRe = regexp.MustCompile(`\d+(?:\.\d+)?\s*(?:kg|KG|公斤|千克|斤|克)`)
)

// aiMemNorm 去重键：去掉所有空白并忽略大小写。
func aiMemNorm(s string) string {
	return strings.ToLower(aiMemSpaceRe.ReplaceAllString(s, ""))
}

// aiMemGrams 中文没有空格，用 2-gram 判断「这条记忆和这次内容是否相关」。
func aiMemGrams(t string) map[string]bool {
	r := []rune(aiMemNonLetRe.ReplaceAllString(t, ""))
	out := map[string]bool{}
	for i := 0; i+2 <= len(r); i++ {
		out[string(r[i:i+2])] = true
	}
	return out
}

// aiLooksLikeRule 这句是不是值得长期记住的「规则」（别名对应 / 装箱换算）。
// 普通业务描述（「今天入库100斤木耳25一斤」）不记，否则会把流水当规则注入，反而干扰识别。
func aiLooksLikeRule(text string) bool {
	t := strings.TrimSpace(text)
	n := utf8.RuneCountInString(t)
	if n < 4 || n > 500 {
		return false
	}
	for _, w := range aiRuleWords {
		if strings.Contains(t, w) {
			return true
		}
	}
	for _, w := range aiPackWords {
		if strings.Contains(t, w) && aiMemPackQtyRe.MatchString(t) {
			return true
		}
	}
	return false
}

// aiMemoryKind 粗分类型（只用于列表展示）：unit 装箱换算 / alias 别名。
func aiMemoryKind(text string) string {
	for _, w := range aiPackWords {
		if strings.Contains(text, w) {
			return "unit"
		}
	}
	if aiMemUnitQtyRe.MatchString(text) {
		return "unit"
	}
	return "alias"
}

// AIRememberNote 记下「规则型」补充说明（同一句只记一次）。
// 返回 {text, added[, reactivated]}；不是规则、或写库失败都返回 nil（同 Python 吞掉异常）。
func AIRememberNote(ctx context.Context, q Querier, text, source string) *JObj {
	t := strings.TrimSpace(aiMemSpaceRe.ReplaceAllString(text, " "))
	if !aiLooksLikeRule(t) {
		return nil
	}
	norm := aiMemNorm(t)
	var (
		id     int64
		isAct  int
		stored string
	)
	err := q.QueryRowContext(ctx,
		"SELECT id, text, is_active FROM ai_memories WHERE norm = ? ORDER BY id LIMIT 1", norm).
		Scan(&id, &stored, &isAct)
	switch {
	case err == nil:
		if isAct == 0 { // 之前删掉过的规则，用户又说了一遍 → 恢复
			if _, err := q.ExecContext(ctx,
				"UPDATE ai_memories SET is_active = 1, updated_at = ? WHERE id = ?", NowDB(), id); err != nil {
				return nil
			}
			return NewJ().Set("text", stored).Set("added", false).Set("reactivated", true)
		}
		return NewJ().Set("text", stored).Set("added", false)
	case errors.Is(err, sql.ErrNoRows):
		// 新规则，落到下面插入
	default:
		return nil
	}
	now := NowDB()
	if _, err := q.ExecContext(ctx,
		"INSERT INTO ai_memories (text, norm, kind, source, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
		t, norm, aiMemoryKind(t), source, now, now); err != nil {
		return nil
	}
	// 只保留最近 aiMemoryKeep 条
	rows, err := q.QueryContext(ctx,
		"SELECT id FROM ai_memories ORDER BY id DESC LIMIT -1 OFFSET ?", aiMemoryKeep)
	if err == nil {
		var dead []any
		for rows.Next() {
			var old int64
			if rows.Scan(&old) == nil {
				dead = append(dead, old)
			}
		}
		rows.Close()
		if len(dead) > 0 {
			for _, old := range dead {
				_, _ = q.ExecContext(ctx, "DELETE FROM ai_memories WHERE id = ?", old)
			}
		}
	}
	return NewJ().Set("text", t).Set("added", true)
}

// ---- AI 记忆管理接口（routers/ai.py 的 /memories 四个路由）----

// AIMemoryMeta 列表接口的一行：{id, text, kind, source, created_at}（键序即 Python 的字典序）。
type AIMemoryMeta struct {
	ID        int
	Text      string
	Kind      string
	Source    string
	CreatedAt string // Python 的 strftime("%Y-%m-%d %H:%M")；无时间 → 空串
}

func (m AIMemoryMeta) JSON() *JObj {
	return NewJ().
		Set("id", m.ID).
		Set("text", m.Text).
		Set("kind", m.Kind).
		Set("source", m.Source).
		Set("created_at", m.CreatedAt)
}

// aiMemMinute 取库里的时间戳前 16 位（"YYYY-MM-DD HH:MM"），等价 Python 的 strftime。
func aiMemMinute(s string) string {
	if len(s) < 16 {
		return ""
	}
	return s[:16]
}

// AIMemoriesList 本仓启用中的记忆，新的在前。
func AIMemoriesList(ctx context.Context, q Querier) ([]*JObj, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT id, COALESCE(text,''), COALESCE(kind,''), COALESCE(source,''), COALESCE(created_at,'')"+
			" FROM ai_memories WHERE is_active = 1 ORDER BY id DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*JObj{}
	for rows.Next() {
		var m AIMemoryMeta
		if err := rows.Scan(&m.ID, &m.Text, &m.Kind, &m.Source, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.CreatedAt = aiMemMinute(m.CreatedAt)
		out = append(out, m.JSON())
	}
	return out, rows.Err()
}

// AIAddMemory 手动记住一条规则（同一句不会重复；之前删过的重新置为启用）。
// 文案与 Python 一致：太短 / 太长都是 400。
func AIAddMemory(ctx context.Context, q Querier, text string) (*JObj, error) {
	t := strings.TrimSpace(aiMemSpaceRe.ReplaceAllString(text, " "))
	if utf8.RuneCountInString(t) < 2 {
		return nil, ErrText("记忆内容太短")
	}
	if utf8.RuneCountInString(t) > 500 {
		return nil, ErrText("记忆内容太长（≤500 字）")
	}
	norm := aiMemNorm(t)
	var id int
	err := q.QueryRowContext(ctx, "SELECT id FROM ai_memories WHERE norm = ? LIMIT 1", norm).Scan(&id)
	switch {
	case err == nil:
		if _, err := q.ExecContext(ctx,
			"UPDATE ai_memories SET is_active = 1, updated_at = ? WHERE id = ?", NowDB(), id); err != nil {
			return nil, err
		}
	case errors.Is(err, sql.ErrNoRows):
		_, err = q.ExecContext(ctx,
			"INSERT INTO ai_memories (text, norm, kind, source, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
			t, norm, aiMemoryKind(t), "manual", NowDB(), NowDB())
		if err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	return NewJ().Set("ok", true).Set("text", t), nil
}

// AIDeleteMemory 删掉一条记忆；不存在 → 404「记忆不存在」（历史单据不受影响）。
func AIDeleteMemory(ctx context.Context, q Querier, id int) error {
	var found int
	err := q.QueryRowContext(ctx, "SELECT id FROM ai_memories WHERE id = ? LIMIT 1", id).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return &BizError{Code: 404, Msg: "记忆不存在"}
	}
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, "DELETE FROM ai_memories WHERE id = ?", id)
	return err
}

// AIClearMemories 清空本仓全部记忆（含停用过的）。
func AIClearMemories(ctx context.Context, q Querier) error {
	_, err := q.ExecContext(ctx, "DELETE FROM ai_memories")
	return err
}

// AIMemoryBlock 把本仓记忆附到用户消息里，让模型沿用用户之前确认过的口径。
// 与这次内容字面相关的排前面，其余按新旧排，最多 aiMemoryInject 条。
func AIMemoryBlock(ctx context.Context, q Querier, contextText string) string {
	rows, err := q.QueryContext(ctx,
		"SELECT text FROM ai_memories WHERE is_active = 1 ORDER BY id")
	if err != nil {
		return ""
	}
	defer rows.Close()
	var texts []string
	for rows.Next() {
		var s string
		if rows.Scan(&s) != nil {
			continue
		}
		texts = append(texts, s)
	}
	if len(texts) == 0 {
		return ""
	}
	ctxGrams := aiMemGrams(contextText)
	if len(ctxGrams) > 0 {
		rel := func(s string) int {
			g := aiMemGrams(s)
			for k := range g {
				if ctxGrams[k] {
					return 0
				}
			}
			return 1
		}
		// Python 的稳定排序：相关的排前面，其余保持原有新旧顺序
		sort.SliceStable(texts, func(i, j int) bool { return rel(texts[i]) < rel(texts[j]) })
	}
	if len(texts) > aiMemoryInject {
		texts = texts[:aiMemoryInject]
	}
	lines := make([]string, 0, len(texts))
	for _, s := range texts {
		lines = append(lines, "- "+s)
	}
	return "\n\n【历史约定（用户之前确认过的口径，务必沿用；优先级高于你的常识猜测）】\n" +
		strings.Join(lines, "\n") +
		"\n（这些是长期有效的规则：商品名、包装/箱型、单位与装箱换算都按它们来；与用户这次明确说的冲突时，以这次说的为准。）"
}
