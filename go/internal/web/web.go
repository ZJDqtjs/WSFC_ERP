package web

import (
	"log"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// 本包是 Go 端的 HTTP 适配层：响应/错误格式与 FastAPI 保持一致，
// 这样同一套前端（桌面 Web、移动 PWA、Flutter）不需要区分后端是谁。

type ctxKey int

const (
	keyUser ctxKey = iota
	keyWarehouse
	keyDB
)

// ErrorBody 与 FastAPI 的 {"detail": "..."} 完全一致。
type ErrorBody struct {
	Detail string `json:"detail"`
}

// Error 写出错误响应。前端（mobile/api.js 的 readError）只认 detail 字段。
func Error(w http.ResponseWriter, status int, format string, args ...any) {
	msg := format
	if len(args) > 0 {
		msg = fmt.Sprintf(format, args...)
	}
	Write(w, status, ErrorBody{Detail: msg})
}

// AbortError 是 handler 内部用于「中断并返回错误」的哨兵类型。
type AbortError struct {
	Status int
	Msg    string
}

func (e *AbortError) Error() string { return e.Msg }

// Abort 生成一个业务中断错误（等价于 FastAPI 的 raise HTTPException）。
func Abort(status int, format string, args ...any) error {
	msg := format
	if len(args) > 0 {
		msg = fmt.Sprintf(format, args...)
	}
	return &AbortError{Status: status, Msg: msg}
}

// Write 输出 JSON（Content-Type 与 FastAPI 一致）。
func Write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return
	}
}

// OK 输出 {"ok": true, ...} 包装（部分接口用它，与 Python 端逐一对应）。
func OK(w http.ResponseWriter, extra map[string]any) {
	body := map[string]any{"ok": true}
	for k, v := range extra {
		body[k] = v
	}
	Write(w, http.StatusOK, body)
}

// Bind 解析 JSON 请求体；空体允许（handler 用零值继续）。
func Bind(r *http.Request, dst any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		return &AbortError{Status: http.StatusBadRequest, Msg: "读取请求体失败"}
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil
	}
	if err := json.Unmarshal(body, dst); err != nil {
		return &AbortError{Status: http.StatusBadRequest, Msg: "请求体 JSON 格式不正确：" + err.Error()}
	}
	return nil
}

// Query 取查询参数（去空格）。
func Query(r *http.Request, name string) string {
	return strings.TrimSpace(r.URL.Query().Get(name))
}

// QueryInt 取整型查询参数，缺省值 def。
func QueryInt(r *http.Request, name string, def int) int {
	v := strings.TrimSpace(r.URL.Query().Get(name))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// QueryFloat 取浮点查询参数。
func QueryFloat(r *http.Request, name string, def float64) float64 {
	v := strings.TrimSpace(r.URL.Query().Get(name))
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return def
	}
	return f
}

// QueryBool 取布尔查询参数（FastAPI 接受 true/false/1/0）。
func QueryBool(r *http.Request, name string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(r.URL.Query().Get(name)))
	switch v {
	case "":
		return def
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

// SetUser 把登录用户放进请求上下文。
func SetUser(r *http.Request, u any) *http.Request { return r.WithContext(setVal(r.Context(), keyUser, u)) }

// User 取出登录用户（未登录返回 nil）。
func User(r *http.Request) any { return getVal(r.Context(), keyUser) }

// SetWarehouse 把本请求的分仓 key 放进上下文。
func SetWarehouse(r *http.Request, key string) *http.Request {
	return r.WithContext(setVal(r.Context(), keyWarehouse, key))
}

// Warehouse 取出本请求的分仓 key。
func Warehouse(r *http.Request) string {
	if v := getVal(r.Context(), keyWarehouse); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// SetDB 把本请求分仓的连接池放进上下文。
func SetDB(r *http.Request, db *sql.DB) *http.Request { return r.WithContext(setVal(r.Context(), keyDB, db)) }

// DB 取出本请求分仓的连接池。
func DB(r *http.Request) *sql.DB {
	if v := getVal(r.Context(), keyDB); v != nil {
		if db, ok := v.(*sql.DB); ok {
			return db
		}
	}
	return nil
}

// IsAbort 判断错误是否为业务中断（并拿到状态码）。
func IsAbort(err error) (*AbortError, bool) {
	var a *AbortError
	if errors.As(err, &a) {
		return a, true
	}
	return nil, false
}

// detailedError 带状态码的业务错误（erp.BizError 实现）：Detail 给文案，StatusCode 给状态码。
// 用接口而不是直接引用 erp，避免 web 反向依赖业务包。
type detailedError interface {
	Detail() string
	StatusCode() int
}

// WriteValue 把任意错误按 FastAPI 风格落盘：已知错误用原始文案，未知错误统一 500。
func WriteValue(w http.ResponseWriter, r *http.Request, err error) {
	if a, ok := IsAbort(err); ok {
		Error(w, a.Status, "%s", a.Msg)
		return
	}
	var d detailedError
	if errors.As(err, &d) {
		Error(w, d.StatusCode(), "%s", d.Detail())
		return
	}
	// 与 FastAPI 的 ServerErrorMiddleware 一致：500 只回纯文本 Internal Server Error，细节进服务日志
	log.Printf("[500] %s %s: %v", r.Method, r.URL.Path, err)
	http.Error(w, "Internal Server Error", http.StatusInternalServerError)
}


// FloatMap 用于把 JSON 里的数字统一读成 float64（json.Number 也兼容）。
func FloatMap(m map[string]any) map[string]float64 {
	out := make(map[string]float64, len(m))
	for k, v := range m {
		switch n := v.(type) {
		case float64:
			out[k] = n
		case int:
			out[k] = float64(n)
		case json.Number:
			f, _ := n.Float64()
			out[k] = f
		}
	}
	return out
}

// ToInt 宽松地把 any 转成 int（JSON 数字、字符串都接受）。
func ToInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case string:
		i, _ := strconv.Atoi(strings.TrimSpace(n))
		return i
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return 0
}

// ToFloat 宽松地把 any 转成 float64。
func ToFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(n), 64)
		return f
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}

// ToStr 宽松地把 any 转成 string。
func ToStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}
