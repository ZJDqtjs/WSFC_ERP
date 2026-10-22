package api

import (
	"context"
	"net/http"
	"strings"

	"wsfc-erp-go/internal/web"
)

// 自带一个极小的路由：既要能区分「路径不存在」（回源 Python）与「方法不允许」，
// 也要能给出接口清单给 /api/_meta/routes 做迁移核对，标准库 ServeMux 的匹配结果拿不到。

type handlerFunc func(w http.ResponseWriter, r *http.Request)

type ctxKeyParams struct{}

type route struct {
	Method  string
	Pattern string // 如 /api/products/{pid}
	Segs    []string
	H       handlerFunc
}

type router struct {
	routes []route
}

func newRouter() *router { return &router{} }

// Handle 注册一条路由。
func (rt *router) Handle(method, pattern string, h handlerFunc) {
	rt.routes = append(rt.routes, route{Method: method, Pattern: pattern, Segs: splitPath(pattern), H: h})
}

// Get / Post / Put / Delete 快捷注册。
func (rt *router) Get(pattern string, h handlerFunc)    { rt.Handle(http.MethodGet, pattern, h) }
func (rt *router) Post(pattern string, h handlerFunc)   { rt.Handle(http.MethodPost, pattern, h) }
func (rt *router) Put(pattern string, h handlerFunc)    { rt.Handle(http.MethodPut, pattern, h) }
func (rt *router) Delete(pattern string, h handlerFunc) { rt.Handle(http.MethodDelete, pattern, h) }

func splitPath(p string) []string {
	p = strings.Trim(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}

// match 路径匹配（尾段 {name} 为通配）。
func (rt *router) match(segs []string, r *route) (map[string]string, bool) {
	params := map[string]string{}
	for i, seg := range r.Segs {
		if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
			if i >= len(segs) || segs[i] == "" {
				return nil, false
			}
			params[strings.Trim(seg, "{}")] = segs[i]
			continue
		}
		if i >= len(segs) || segs[i] != seg {
			return nil, false
		}
	}
	if len(segs) != len(r.Segs) {
		return nil, false
	}
	return params, true
}

// lookup 找到处理器；路径存在但方法不对时返回 methodMismatch=true。
func (rt *router) lookup(method string, segs []string) (*route, map[string]string, bool) {
	mismatch := false
	for i := range rt.routes {
		r := &rt.routes[i]
		params, ok := rt.match(segs, r)
		if !ok {
			continue
		}
		if r.Method == method || (r.Method == http.MethodGet && method == http.MethodHead) {
			return r, params, true
		}
		mismatch = true
	}
	if mismatch {
		return nil, nil, true
	}
	return nil, nil, false
}

// MatchesPath 该路径是否已由 Go 实现（用于决定要不要回源 Python）。
func (rt *router) MatchesPath(path string) bool {
	segs := splitPath(path)
	for i := range rt.routes {
		if _, ok := rt.match(segs, &rt.routes[i]); ok {
			return true
		}
	}
	return false
}

func (rt *router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	segs := splitPath(r.URL.Path)
	route, params, found := rt.lookup(r.Method, segs)
	if !found {
		web.Error(w, http.StatusNotFound, "Not Found")
		return
	}
	if route == nil {
		web.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	ctx := context.WithValue(r.Context(), ctxKeyParams{}, params)
	route.H(w, r.WithContext(ctx))
}

// PathValue 取路由通配参数。
func PathValue(r *http.Request, name string) string {
	if m, ok := r.Context().Value(ctxKeyParams{}).(map[string]string); ok {
		return m[name]
	}
	return ""
}

// PathInt 取路由里的数字参数。
func PathInt(r *http.Request, name string) int {
	return web.ToInt(PathValue(r, name))
}

