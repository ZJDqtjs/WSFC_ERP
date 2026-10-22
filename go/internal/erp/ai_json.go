package erp

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// ---------------- Python 风格的 JSON 序列化 ----------------
//
// AI 模块的响应要参与 SSE「逐字节」比对，而 starlette/Python 的 json 序列化与 Go 的
// encoding/json 有三处稳定差异：
//  1. float 永远带小数点（100.0 而不是 100）；
//  2. JSONResponse 用 separators=(",", ":")（紧凑），而 StreamingResponse 里
//     json.dumps(obj) 用默认分隔符（", " 与 ": "）；
//  3. dict 保持插入顺序，Go 的 map 会被排序。
//
// 因此本文件自带一个保序序列化器：JObj 复刻 Python dict，PyNum 复刻 Python float，
// AIJSON 复刻 json.dumps（compact 开关对应上面两种分隔符口径）。

// PyNum 按 Python repr(float) 输出的浮点（100.0 / 25.0 / 1e+16）。
type PyNum float64

// F 把普通 float64 包成 Python 浮点，写响应里的数值字段统一用它。
func F(v float64) PyNum { return PyNum(v) }

// JObj 保序 JSON 对象（Python dict 语义：重复赋同一个键时保留首次出现的位置）。
type JObj struct {
	keys []string
	vals map[string]any
}

// NewJ 新建一个空对象。
func NewJ() *JObj { return &JObj{vals: map[string]any{}} }

// Set 赋值（等价于 d[k] = v）。
func (o *JObj) Set(k string, v any) *JObj {
	if o.vals == nil {
		o.vals = map[string]any{}
	}
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
	return o
}

// Get 取值；键不存在返回 nil（等价于 d.get(k)）。
func (o *JObj) Get(k string) any {
	if o == nil || o.vals == nil {
		return nil
	}
	return o.vals[k]
}

// Has 是否含某个键。
func (o *JObj) Has(k string) bool {
	if o == nil {
		return false
	}
	_, ok := o.vals[k]
	return ok
}

// Str 取字符串字段（缺失/null → 空串）。
func (o *JObj) Str(k string) string { return ToStr(o.Get(k)) }

// Num 取浮点字段（缺失/null → 0）。
func (o *JObj) Num(k string) float64 { return ToFloat(o.Get(k)) }

// Keys 按插入顺序返回键名（比对与调试用）。
func (o *JObj) Keys() []string { return o.keys }

// Len 键个数（Python 的 len(dict)）。
func (o *JObj) Len() int { return len(o.keys) }

// Clone 浅拷贝（Python 的 {**d, "k": v}）。
func (o *JObj) Clone() *JObj {
	out := NewJ()
	for _, k := range o.keys {
		out.Set(k, o.vals[k])
	}
	return out
}

// Map 转成普通 map（仅用于内部计算，不用于输出）。
func (o *JObj) Map() map[string]any {
	out := make(map[string]any, len(o.keys))
	for k, v := range o.vals {
		out[k] = v
	}
	return out
}

// NewJFromMap 把解析外部 JSON 得到的普通 map 包成只读对象（Python 的 dict）。
// 输入 map 本身无序，这里按键名排序保证行为确定；调用方只用它取值，不依赖顺序输出。
func NewJFromMap(m map[string]any) *JObj {
	out := NewJ()
	if m == nil {
		return out
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out.Set(k, m[k])
	}
	return out
}

// JList 是「对象数组」的构造器，顺序即输出顺序。
func JList(items []*JObj) []*JObj {
	if items == nil {
		return []*JObj{}
	}
	return items
}

// AIJSON 按 Python json.dumps 的口径序列化；spaced=true 用默认分隔符（", " / ": "），
// false 用 JSONResponse 的紧凑分隔符（"," / ":"）。
func AIJSON(v any, spaced bool) []byte {
	it, kv := ",", ":"
	if spaced {
		it, kv = ", ", ": "
	}
	var b strings.Builder
	writePyValue(&b, v, it, kv)
	return []byte(b.String())
}

// AIJSONCompact 等价于 starlette JSONResponse 的渲染结果。
func AIJSONCompact(v any) []byte { return AIJSON(v, false) }

// AIJSONSpaced 等价于 json.dumps(obj, ensure_ascii=False)。
func AIJSONSpaced(v any) []byte { return AIJSON(v, true) }

func writePyValue(b *strings.Builder, v any, it, kv string) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case *JObj:
		if x == nil {
			b.WriteString("null")
			return
		}
		b.WriteByte('{')
		for i, k := range x.keys {
			if i > 0 {
				b.WriteString(it)
			}
			writePyString(b, k)
			b.WriteString(kv)
			writePyValue(b, x.vals[k], it, kv)
		}
		b.WriteByte('}')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteString(it)
			}
			writePyString(b, k)
			b.WriteString(kv)
			writePyValue(b, x[k], it, kv)
		}
		b.WriteByte('}')
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writePyString(b, x)
	case PyNum:
		b.WriteString(PyFloatRepr(float64(x)))
	case float64:
		b.WriteString(PyFloatRepr(x))
	case float32:
		b.WriteString(PyFloatRepr(float64(x)))
	case int:
		b.WriteString(strconv.Itoa(x))
	case int8, int16, int32, int64:
		b.WriteString(fmt.Sprintf("%d", reflect.ValueOf(x).Int()))
	case uint, uint8, uint16, uint32, uint64:
		b.WriteString(fmt.Sprintf("%d", reflect.ValueOf(x).Uint()))
	case json.Number:
		b.WriteString(x.String())
	case json.RawMessage:
		b.Write(x)
	case error:
		writePyString(b, x.Error())
	default:
		rv := reflect.ValueOf(v)
		switch rv.Kind() {
		case reflect.Slice, reflect.Array:
			b.WriteByte('[')
			for i := 0; i < rv.Len(); i++ {
				if i > 0 {
					b.WriteString(it)
				}
				writePyValue(b, rv.Index(i).Interface(), it, kv)
			}
			b.WriteByte(']')
		case reflect.Map:
			keys := make([]string, 0, rv.Len())
			iter := rv.MapRange()
			for iter.Next() {
				keys = append(keys, ToStr(iter.Key().Interface()))
			}
			sort.Strings(keys)
			b.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					b.WriteString(it)
				}
				writePyString(b, k)
				b.WriteString(kv)
				writePyValue(b, rv.MapIndex(reflect.ValueOf(k)).Interface(), it, kv)
			}
			b.WriteByte('}')
		case reflect.Ptr, reflect.Interface:
			if rv.IsNil() {
				b.WriteString("null")
				return
			}
			writePyValue(b, rv.Elem().Interface(), it, kv)
		default:
			writePyString(b, fmt.Sprintf("%v", v))
		}
	}
}

// writePyString 复刻 json.dumps(ensure_ascii=False) 的字符串转义：
// 只转义引号、反斜杠与控制字符（< 0x20），中文与 emoji 原样输出，不做 HTML 转义。
func writePyString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString("\\\"")
		case '\\':
			b.WriteString("\\\\")
		case '\n':
			b.WriteString("\\n")
		case '\r':
			b.WriteString("\\r")
		case '\t':
			b.WriteString("\\t")
		case '\b':
			b.WriteString("\\b")
		case '\f':
			b.WriteString("\\f")
		default:
			if r < 0x20 {
				fmt.Fprintf(b, "\\u%04x", r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// PyFloatRepr 复刻 Python 的 repr(float)：整数值也带 .0，超大规模用科学计数法。
func PyFloatRepr(v float64) string {
	if math.IsNaN(v) {
		return "NaN"
	}
	if math.IsInf(v, 1) {
		return "Infinity"
	}
	if math.IsInf(v, -1) {
		return "-Infinity"
	}
	a := math.Abs(v)
	if a != 0 && (a >= 1e16 || a < 1e-4) {
		return strconv.FormatFloat(v, 'e', -1, 64)
	}
	s := strconv.FormatFloat(v, 'f', -1, 64)
	if !strings.Contains(s, ".") {
		s += ".0"
	}
	return s
}
