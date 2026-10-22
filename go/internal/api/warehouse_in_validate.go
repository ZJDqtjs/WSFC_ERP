package api

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"wsfc-erp-go/internal/web"
)

// 本文件复刻 FastAPI + Pydantic v2（lax 模式）的请求体校验：
// 缺必填字段、类型不兼容时返回与 Python 完全一致的 422 明细（type/loc/msg/input 四元组、
// 字段按模型声明顺序、嵌套模型带下标），并把通过校验的值按 model_dump() 的口径补齐默认值，
// 让 erp 层拿到的 payload 与 Python 路由里 data.model_dump() 一字不差。

// whKind 字段类型（对应 Python 注解）。
type whKind int

const (
	whKindStr       whKind = iota // str
	whKindFloat                   // float
	whKindInt                     // int
	whKindOptInt                  // int | None
	whKindBool                    // bool
	whKindIntList                 // list[int]
	whKindModelList               // list[SomeModel]
	whKindStrList                 // list[str]
	whKindAnyList                 // list（裸类型，元素原样透传）
	whKindOptDict                 // dict | None
	whKindOptFloat                // float | None
	whKindDictList                // list[dict]（元素必须是对象，否则 dict_type）
)

// whField 模型声明的一个字段：顺序即 Pydantic 报错顺序，def 是它的默认值。
type whField struct {
	Name     string
	Kind     whKind
	Required bool
	Def      any
	Sub      []whField // 仅 whKindModelList 使用
}

// whIssue 一条 422 明细（字段顺序与 Python JSON 一致）。
type whIssue struct {
	Type  string `json:"type"`
	Loc   []any  `json:"loc"`
	Msg   string `json:"msg"`
	Input any    `json:"input"`
}

const (
	whMsgMissing    = "Field required"
	whMsgStr        = "Input should be a valid string"
	whMsgFloatType  = "Input should be a valid number"
	whMsgFloatParse = "Input should be a valid number, unable to parse string as a number"
	whMsgIntType    = "Input should be a valid integer"
	whMsgIntParse   = "Input should be a valid integer, unable to parse string as an integer"
	whMsgIntFrac    = "Input should be a valid integer, got a number with a fractional part"
	whMsgBoolType   = "Input should be a valid boolean"
	whMsgBoolParse  = "Input should be a valid boolean, unable to interpret input"
	whMsgListType   = "Input should be a valid list"
	whMsgObjType    = "Input should be a valid dictionary or object to extract fields from"
	whMsgDictType   = "Input should be a valid dictionary"
)

// ---- 各模型的字段声明（顺序必须与 Python 源码一致）----

var whPackItemFields = []whField{
	{Name: "product_id", Kind: whKindInt, Required: true},
	{Name: "quantity", Kind: whKindFloat, Required: true},
	{Name: "unit", Kind: whKindStr, Def: "个"},
}

var whProductFields = []whField{
	{Name: "name", Kind: whKindStr, Required: true},
	{Name: "category", Kind: whKindStr, Def: ""},
	{Name: "sku", Kind: whKindStr, Def: ""},
	{Name: "barcode", Kind: whKindStr, Def: ""},
	{Name: "box_spec", Kind: whKindFloat, Def: 0.0},
	{Name: "purchase_price", Kind: whKindFloat, Def: 0.0},
	{Name: "freight", Kind: whKindFloat, Def: 0.0},
	{Name: "stock_product_id", Kind: whKindOptInt},
	{Name: "bag_weight", Kind: whKindFloat, Def: 0.0},
	{Name: "bag_net_weight", Kind: whKindFloat, Def: 0.0},
	{Name: "bag_net_unit", Kind: whKindStr, Def: "克"},
	{Name: "dropship_cost", Kind: whKindFloat, Def: 0.0},
	{Name: "shelf_life", Kind: whKindStr, Def: ""},
	{Name: "remark", Kind: whKindStr, Def: ""},
	{Name: "is_active", Kind: whKindBool, Def: true},
	{Name: "pack_items", Kind: whKindModelList, Def: nil, Sub: whPackItemFields},
}

var whInboundCreateFields = []whField{
	{Name: "product_id", Kind: whKindOptInt},
	{Name: "product_name", Kind: whKindStr, Def: ""},
	{Name: "category", Kind: whKindStr, Def: ""},
	{Name: "unit", Kind: whKindStr, Def: "袋"},
	{Name: "purchase_no", Kind: whKindStr, Def: ""},
	{Name: "center", Kind: whKindStr, Def: ""},
	{Name: "quantity", Kind: whKindFloat, Required: true},
	{Name: "box_count", Kind: whKindFloat, Def: 0.0},
	{Name: "box_spec", Kind: whKindFloat, Def: 0.0},
	{Name: "unit_price", Kind: whKindFloat, Def: 0.0},
	{Name: "freight", Kind: whKindFloat, Def: 0.0},
	{Name: "bag_weight", Kind: whKindFloat, Def: 0.0},
	{Name: "date", Kind: whKindStr, Required: true},
	{Name: "operator", Kind: whKindStr, Def: ""},
	{Name: "remark", Kind: whKindStr, Def: ""},
	{Name: "pay_status", Kind: whKindStr, Def: "paid"},
}

var whInboundUpdateFields = func() []whField {
	// InboundUpdate 与 InboundIn 同字段，只多了没有 operator
	out := make([]whField, 0, len(whInboundCreateFields))
	for _, f := range whInboundCreateFields {
		if f.Name == "operator" {
			continue
		}
		out = append(out, f)
	}
	return out
}()

var whBatchIdsFields = []whField{
	{Name: "ids", Kind: whKindIntList, Required: true},
}

var whConfirmItemFields = []whField{
	{Name: "product_id", Kind: whKindOptInt},
	{Name: "product_name", Kind: whKindStr, Def: ""},
	{Name: "category", Kind: whKindStr, Def: ""},
	{Name: "unit", Kind: whKindStr, Def: "袋"},
	{Name: "purchase_no", Kind: whKindStr, Def: ""},
	{Name: "center", Kind: whKindStr, Def: ""},
	{Name: "quantity", Kind: whKindFloat, Required: true},
	{Name: "box_count", Kind: whKindFloat, Def: 0.0},
	{Name: "box_spec", Kind: whKindFloat, Def: 0.0},
	{Name: "unit_price", Kind: whKindFloat, Def: 0.0},
	{Name: "freight", Kind: whKindFloat, Def: 0.0},
	{Name: "bag_weight", Kind: whKindFloat, Def: 0.0},
	{Name: "date", Kind: whKindStr, Def: ""},
	{Name: "remark", Kind: whKindStr, Def: ""},
}

var whConfirmFields = []whField{
	{Name: "date", Kind: whKindStr, Def: ""},
	{Name: "items", Kind: whKindModelList, Sub: whConfirmItemFields},
}

// ---- 校验主流程 ----

// whBind 读请求体并按模型声明校验，返回 (model_dump 等价的 payload, 422 明细)。
// 明细非空时调用方必须原样返回 422（此时绝不能落库，与 Python 一致）。
func whBind(r *http.Request, fields []whField) (map[string]any, []whIssue) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		return nil, []whIssue{{Type: "missing", Loc: []any{"body"}, Msg: whMsgMissing, Input: nil}}
	}
	if strings.TrimSpace(string(raw)) == "" {
		return nil, []whIssue{{Type: "missing", Loc: []any{"body"}, Msg: whMsgMissing, Input: nil}}
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		// Python 这里给 json_invalid（带解析器错误短语与字节偏移）；Go 的偏移与措辞无法等价，
		// 按项目既有口径回 400，属已记录的有意偏差。
		return nil, nil
	}
	if v == nil { // 请求体是 JSON null
		return nil, []whIssue{{Type: "missing", Loc: []any{"body"}, Msg: whMsgMissing, Input: nil}}
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, []whIssue{{Type: "model_attributes_type", Loc: []any{"body"}, Msg: whMsgObjType, Input: v}}
	}
	return whValidateObject(obj, fields, []any{"body"})
}

// whBindOr422 校验并把 422 写出去；返回 nil 表示 handler 已经写完响应、可以直接 return。
func whBindOr422(w http.ResponseWriter, r *http.Request, fields []whField) map[string]any {
	payload, issues := whBind(r, fields)
	if len(issues) == 0 && payload == nil {
		// JSON 解析失败：与 web.Bind 同口径（400 + 中文），主控已在其它模块采用
		web.Error(w, http.StatusBadRequest, "请求体 JSON 格式不正确")
		return nil
	}
	if len(issues) > 0 {
		whWrite422(w, issues)
		return nil
	}
	return whNormalize(payload)
}

func whWrite422(w http.ResponseWriter, issues []whIssue) {
	web.Write(w, http.StatusUnprocessableEntity, map[string]any{"detail": issues})
}

// whValidateObject 逐字段校验一个对象（loc 为它在请求体里的路径前缀）。
func whValidateObject(obj map[string]any, fields []whField, loc []any) (map[string]any, []whIssue) {
	out := make(map[string]any, len(fields))
	var issues []whIssue
	for _, f := range fields {
		raw, present := obj[f.Name]
		fieldLoc := append(append([]any{}, loc...), f.Name)
		if !present {
			if f.Required {
				issues = append(issues, whIssue{Type: "missing", Loc: fieldLoc, Msg: whMsgMissing, Input: obj})
				continue
			}
			out[f.Name] = f.Def // 缺省：模型默认值（null 表示 Optional 未给）
			continue
		}
		val, kind := whCoerce(raw, f, fieldLoc)
		if kind == "" {
			out[f.Name] = val
			continue
		}
		if kind == "__list__" {
			v, sub := whCoerceList(raw, f, fieldLoc, loc)
			if len(sub) > 0 {
				issues = append(issues, sub...)
				continue
			}
			out[f.Name] = v
			continue
		}
		issues = append(issues, whIssue{Type: kind, Loc: fieldLoc, Msg: whTypeMsg(kind), Input: raw})
	}
	return out, issues
}

// whCoerceList 处理 list[int] 与 list[Model]：元素级错误把下标并进 loc（同 Python）。
func whCoerceList(raw any, f whField, fieldLoc []any, _ []any) (any, []whIssue) {
	arr, ok := raw.([]any)
	if !ok {
		return nil, []whIssue{{Type: "list_type", Loc: fieldLoc, Msg: whMsgListType, Input: raw}}
	}
	if f.Kind == whKindAnyList {
		// 裸 list：元素原样透传（Pydantic 不做任何校验）
		out := make([]any, len(arr))
		copy(out, arr)
		return out, nil
	}
	if f.Kind == whKindDictList {
		// list[dict]：元素必须是对象，值本身不再按子类型校验（Pydantic 的裸 dict）
		out := make([]any, 0, len(arr))
		var issues []whIssue
		for i, it := range arr {
			itemLoc := append(append([]any{}, fieldLoc...), i)
			m, ok := it.(map[string]any)
			if !ok {
				issues = append(issues, whIssue{Type: "dict_type", Loc: itemLoc, Msg: whMsgDictType, Input: it})
				continue
			}
			cp := make(map[string]any, len(m))
			for k, v := range m {
				cp[k] = v
			}
			out = append(out, cp)
		}
		if len(issues) > 0 {
			return nil, issues
		}
		return out, nil
	}
	if f.Kind == whKindStrList {
		out := make([]any, 0, len(arr))
		var issues []whIssue
		for i, it := range arr {
			itemLoc := append(append([]any{}, fieldLoc...), i)
			s, ok := it.(string)
			if !ok {
				issues = append(issues, whIssue{Type: "string_type", Loc: itemLoc, Msg: whMsgStr, Input: it})
				continue
			}
			out = append(out, s)
		}
		if len(issues) > 0 {
			return nil, issues
		}
		return out, nil
	}
	if f.Kind == whKindIntList {
		out := make([]any, 0, len(arr))
		var issues []whIssue
		for i, it := range arr {
			v, kind := whCoerceScalar(it, whKindInt, append(append([]any{}, fieldLoc...), i))
			if kind != "" {
				issues = append(issues, whIssue{Type: kind, Loc: append(append([]any{}, fieldLoc...), i), Msg: whTypeMsg(kind), Input: it})
				continue
			}
			out = append(out, v)
		}
		if len(issues) > 0 {
			return nil, issues
		}
		return out, nil
	}
	out := make([]any, 0, len(arr))
	var issues []whIssue
	for i, it := range arr {
		itemLoc := append(append([]any{}, fieldLoc...), i)
		obj, ok := it.(map[string]any)
		if !ok {
			issues = append(issues, whIssue{Type: "model_attributes_type", Loc: itemLoc, Msg: whMsgObjType, Input: it})
			continue
		}
		val, sub := whValidateObject(obj, f.Sub, itemLoc)
		if len(sub) > 0 {
			issues = append(issues, sub...)
			continue
		}
		out = append(out, val)
	}
	if len(issues) > 0 {
		return nil, issues
	}
	return out, nil
}

// whCoerce 单值转换；返回值 kind=="" 表示通过。
func whCoerce(v any, f whField, _ []any) (any, string) {
	switch f.Kind {
	case whKindModelList, whKindIntList, whKindStrList, whKindAnyList, whKindDictList:
		return nil, "__list__"
	case whKindOptFloat:
		if v == nil {
			return nil, ""
		}
		return whCoerceScalar(v, whKindFloat, nil)
	case whKindOptDict:
		if v == nil {
			return nil, ""
		}
		if _, ok := v.(map[string]any); ok {
			return v, ""
		}
		return nil, "dict_type"
	}
	return whCoerceScalar(v, f.Kind, nil)
}

func whCoerceScalar(v any, k whKind, _ []any) (any, string) {
	switch k {
	case whKindStr:
		if s, ok := v.(string); ok {
			return s, ""
		}
		return nil, "string_type"
	case whKindFloat:
		switch t := v.(type) {
		case float64:
			return t, ""
		case bool:
			if t {
				return 1.0, ""
			}
			return 0.0, ""
		case string:
			if f, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
				return f, ""
			}
			return nil, "float_parsing"
		}
		return nil, "float_type"
	case whKindInt, whKindOptInt:
		if v == nil && k == whKindOptInt {
			return nil, ""
		}
		switch t := v.(type) {
		case float64:
			if t == math.Trunc(t) && !math.IsInf(t, 0) && !math.IsNaN(t) {
				return int64(t), ""
			}
			return nil, "int_from_float"
		case bool:
			if t {
				return int64(1), ""
			}
			return int64(0), ""
		case string:
			s := strings.TrimSpace(t)
			if n, err := strconv.ParseInt(s, 10, 64); err == nil {
				return n, ""
			}
			if f, err := strconv.ParseFloat(s, 64); err == nil && f == math.Trunc(f) {
				return int64(f), ""
			}
			return nil, "int_parsing"
		}
		return nil, "int_type"
	case whKindBool:
		switch t := v.(type) {
		case bool:
			return t, ""
		case float64:
			if t == 1 {
				return true, ""
			}
			if t == 0 {
				return false, ""
			}
			return nil, "bool_parsing"
		case string:
			switch strings.ToLower(strings.TrimSpace(t)) {
			case "true", "t", "yes", "y", "on", "1":
				return true, ""
			case "false", "f", "no", "n", "off", "0":
				return false, ""
			}
			return nil, "bool_parsing"
		}
		return nil, "bool_type"
	}
	return nil, ""
}

// whTypeMsg Pydantic 错误类型 → 文案（与 Python 返回值逐字一致）。
func whTypeMsg(kind string) string {
	switch kind {
	case "string_type":
		return whMsgStr
	case "float_type":
		return whMsgFloatType
	case "float_parsing":
		return whMsgFloatParse
	case "int_type":
		return whMsgIntType
	case "int_parsing":
		return whMsgIntParse
	case "int_from_float":
		return whMsgIntFrac
	case "bool_type":
		return whMsgBoolType
	case "bool_parsing":
		return whMsgBoolParse
	case "list_type":
		return whMsgListType
	case "model_attributes_type":
		return whMsgObjType
	case "dict_type":
		return whMsgDictType
	}
	return ""
}

// whFixInts 递归把校验出来的 int64 折成 erp 层习惯的 int（含数组元素与嵌套对象）。
func whFixInts(v any) any {
	switch t := v.(type) {
	case int64:
		return int(t)
	case map[string]any:
		for k, it := range t {
			t[k] = whFixInts(it)
		}
		return t
	case []any:
		for i, it := range t {
			t[i] = whFixInts(it)
		}
		return t
	}
	return v
}

// whNormalize 校验后的收尾口径修正（model_dump 等价）：int64 → int；
// 净重单位那类 field_validator 仍由 erp 层负责。
func whNormalize(payload map[string]any) map[string]any {
	return whFixInts(payload).(map[string]any)
}
