package erp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 本文件是接口层与业务层之间的「宽松取值器」：JSON 反序列化后的 any 值
// 按 Python 的 float()/str()/int() 语义转换，缺键与 null 一律回退零值。

// ToStr 取字符串（数字也转成字符串；null/缺失 → 空串）。
func ToStr(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case json.Number:
		return x.String()
	}
	return fmt.Sprintf("%v", v)
}

// ToFloat 取浮点数（字符串可解析则解析；bool → 0/1）。
func ToFloat(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0
		}
		return f
	}
	return 0
}

// ToInt 取整数（小数截断，与 Python int() 一致）。
func ToInt(v any) int {
	f := ToFloat(v)
	if f == 0 {
		return 0
	}
	return int(f)
}

// HasKey 判断 JSON 对象里是否显式带了某个键（用于区分「没传」与「传了 0」）。
func HasKey(m map[string]any, k string) bool {
	_, ok := m[k]
	return ok
}

// OptFloat 取可选浮点：键不存在或值为 null 返回 nil（PUT 接口「不传 = 不改」）。
func OptFloat(m map[string]any, k string) *float64 {
	v, ok := m[k]
	if !ok || v == nil {
		return nil
	}
	f := ToFloat(v)
	return &f
}

// OptInt 取可选整数。
func OptInt(m map[string]any, k string) *int {
	v, ok := m[k]
	if !ok || v == nil {
		return nil
	}
	i := ToInt(v)
	return &i
}

// OptStr 取可选字符串。
func OptStr(m map[string]any, k string) *string {
	v, ok := m[k]
	if !ok {
		return nil
	}
	s := ToStr(v)
	return &s
}

// NowDB 数据库用的本地朴素时间串（后端全链路无时区概念，勿改成 UTC）。
func NowDB() string { return time.Now().Format("2006-01-02 15:04:05.000000") }

func nowDB() string { return NowDB() }

// NowStamp 文件名/批次号用的时间戳（YYYYmmdd_HHMMSS_ffffff）。
func NowStamp() string {
	n := time.Now()
	return fmt.Sprintf("%s_%06d", n.Format("20060102_150405"), n.Nanosecond()/1000)
}

// MapSlice 把 any 转成 []map[string]any：既接 JSON 解出来的 []any，也接引擎内部直接构造的 []map[string]any。
// （出库单的 sale_lines / pack_lines / deductions 在 Go 里是后者，早期只处理 []any 会静默丢行、不写库存流水。）
func MapSlice(v any) []map[string]any {
	switch arr := v.(type) {
	case []map[string]any:
		out := make([]map[string]any, len(arr))
		copy(out, arr)
		return out
	case []any:
		out := make([]map[string]any, 0, len(arr))
		for _, it := range arr {
			if m, ok := it.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

// IntSlice 把 []any 转成 []int。
func IntSlice(v any) []int {
	if ints, ok := v.([]int); ok {
		return ints
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]int, 0, len(arr))
	for _, it := range arr {
		if i := ToInt(it); i != 0 {
			out = append(out, i)
		}
	}
	return out
}

// StrSlice 把 []any 转成 []string。
func StrSlice(v any) []string {
	if ss, ok := v.([]string); ok {
		return ss
	}
	arr, ok := v.([]any)
	if !ok {
		if s, ok2 := v.(string); ok2 {
			return strings.Split(strings.ReplaceAll(s, "，", ","), ",")
		}
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, it := range arr {
		out = append(out, ToStr(it))
	}
	return out
}

// ContainsStr 列表是否含某值。
func ContainsStr(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// CeilFloat 向上取整（Python math.ceil）。
func CeilFloat(v float64) float64 { return float64(int64(ceil(v))) }

func ceil(v float64) float64 {
	n := int64(v)
	if float64(n) < v {
		return float64(n + 1)
	}
	return float64(n)
}


// ToBool 宽松布尔转换（JSON true/false、"1"/"true"、数字非 0 都算真）。
func ToBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		s := strings.ToLower(strings.TrimSpace(x))
		return s == "1" || s == "true" || s == "yes" || s == "on"
	case float64:
		return x != 0
	case int:
		return x != 0
	case int64:
		return x != 0
	case json.Number:
		f, err := x.Float64()
		return err == nil && f != 0
	}
	return false
}



// AnyToFloatMap 把 JSON 对象转成 map[string]float64（数字/数字字符串都接受）。
// IsServiceCat 人工/快递这类服务型分类（不记真实库存）。
func IsServiceCat(cat string) bool { return cat == "人工" || cat == "快递" }

// StringArgs 把字符串切片转成查询参数。
func StringArgs(list []string) []any {
	out := make([]any, len(list))
	for i, s := range list {
		out[i] = s
	}
	return out
}

// FormatFloat 稳定的整数字符串（Go 没有 Python 的 str(int) 直写）。
func FormatFloat(v float64) string {
	if v == float64(int64(v)) {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// MarshalIndentJSON 缩进 2、保留中文（与 Python json.dump(ensure_ascii=False, indent=2) 一致）。
func MarshalIndentJSON(v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, b, "", "  "); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func marshalIndentJSON(v any) ([]byte, error) { return MarshalIndentJSON(v) }

func AnyToFloatMap(m map[string]any) map[string]float64 {
	out := make(map[string]float64, len(m))
	for k, val := range m {
		if f, ok := toFloat(val); ok {
			out[k] = f
		}
	}
	return out
}

// legacyStampRe 匹配早期 Go 版本误写进库的时间戳（形如 20261013_141205_000000）。
// 这种值 Python 端 SQLAlchemy 解析时会直接抛 ValueError（列表接口 500）。
var legacyStampRe = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\d+)?$`)

// NormalizeStamp 把历史脏时间戳还原成 NowDB 的 "YYYY-MM-DD HH:MM:SS.ffffff" 形态，其它值原样返回。
func NormalizeStamp(s string) string {
	t := strings.TrimSpace(s)
	m := legacyStampRe.FindStringSubmatch(t)
	if m == nil {
		return s
	}
	return fmt.Sprintf("%s-%s-%s %s:%s:%s.000000", m[1], m[2], m[3], m[4], m[5], m[6])
}

// isoSeconds 把库里的 "YYYY-MM-DD HH:MM:SS.ffffff" 变成 "YYYY-MM-DDTHH:MM:SS"
// （Python 侧 other_expenses 用 isoformat(timespec="seconds")）。
func isoSeconds(s string) string {
	s = NormalizeStamp(strings.TrimSpace(s))
	if len(s) >= 19 {
		s = s[:19]
	}
	if len(s) >= 11 && s[10] == ' ' {
		return s[:10] + "T" + s[11:]
	}
	return s
}
