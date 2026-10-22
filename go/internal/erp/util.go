package erp

import (
	"math"
	"strconv"
	"strings"
)

// 本文件是 erp 包内共用的小工具：SQL 片段拼接、批量切块、数值格式化。

// Placeholders 生成 "?,?,?"（长度 n）。
func Placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}

// InClause 生成 "IN (?,?,?)"。
func InClause(n int) string {
	if n <= 0 {
		return "IN ()"
	}
	return "IN (" + Placeholders(n) + ")"
}

// ToArgs 把 int 切片转成查询参数。
func ToArgs(ids []int) []any {
	out := make([]any, len(ids))
	for i, v := range ids {
		out[i] = v
	}
	return out
}

// Prepend 在参数前面插一个值（用于 ref_type 这类固定条件）。
func Prepend(v any, args []any) []any {
	return append([]any{v}, args...)
}

// Chunk 按 size 切分 id 列表（SQLite 单条 SQL 的变量数有上限）。
func Chunk(seq []int, size int) [][]int {
	if size <= 0 {
		size = 400
	}
	var out [][]int
	for i := 0; i < len(seq); i += size {
		end := i + size
		if end > len(seq) {
			end = len(seq)
		}
		out = append(out, seq[i:end])
	}
	return out
}

// UniqueInts 去重并保序（与 Python dict.fromkeys 一致）。
// UniqueInts 去重保序（对应 Python 的 list(dict.fromkeys(...))）。
// 不过滤 0/负数：Python 侧 ids 原样进 IN 子句，多传 0 只影响 missing 计数，不能在这里吞掉。
func UniqueInts(ids []int) []int {
	seen := map[int]bool{}
	out := []int{}
	for _, v := range ids {
		if seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// FmtMoney 金额展示（整数不带小数，否则两位）。
func FmtMoney(v float64) string {
	if math.Abs(v-math.Round(v)) < 1e-9 {
		return strconv.FormatInt(int64(math.Round(v)), 10)
	}
	return strconv.FormatFloat(v, 'f', 2, 64)
}

// NullStr 空字符串按 NULL 存（保持与 Python 写入的 NULL/'' 混合数据可读性）。
func NullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// PtrFloat / PtrInt 便于构造可空字段。
func PtrFloat(v float64) *float64 { return &v }
func PtrInt(v int) *int           { return &v }

// AsInt 把 *int 解引用为 0（写库用）。
func AsInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

