package erp

import (
	"os"
	"regexp"
	"strconv"
	"testing"
)

// Round 必须与 CPython 的 round(v, places) 逐值一致（金额半分位是 1 分钱差异的来源）。
// 期望值由 go/_diff/roundvecs.txt 提供（Python 侧生成），文件不存在时跳过。
func TestRoundMatchesPython(t *testing.T) {
	raw, err := os.ReadFile("../../_diff/roundvecs.txt")
	if err != nil {
		t.Skip("no golden vectors")
	}
	re := regexp.MustCompile(`\{v: ([-0-9.eE+]+), p: (\d+), want: ([-0-9.eE+]+)\}`)
	n, bad := 0, 0
	for _, m := range re.FindAllStringSubmatch(string(raw), -1) {
		v, _ := strconv.ParseFloat(m[1], 64)
		p, _ := strconv.Atoi(m[2])
		want, _ := strconv.ParseFloat(m[3], 64)
		n++
		got := Round(v, p)
		gs, ws := strconv.FormatFloat(got, 'g', -1, 64), strconv.FormatFloat(want, 'g', -1, 64)
		// 唯一允许的偏差：Python 对 -0.1x 返回 -0.0，Go 统一消除负零（数值等价，且避免 JSON 出现 "-0"）
		if gs != ws && !(got == 0 && want == 0) {
			bad++
			if bad <= 10 {
				t.Errorf("round(%s, %d) = %s, want %s", m[1], p, strconv.FormatFloat(got, 'g', -1, 64), m[3])
			}
		}
	}
	if n == 0 {
		t.Fatal("golden file parsed to 0 vectors")
	}
	t.Logf("checked %d vectors, %d mismatches", n, bad)
}
