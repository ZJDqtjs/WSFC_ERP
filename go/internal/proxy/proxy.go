// Package proxy 把尚未在 Go 里实现的接口原样转发回 Python 后端（迁移期用）。
//
// 会话 cookie 一起透传，两边共用同一份 token：调用方不需要知道请求被谁处理了。
package proxy

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

// New 构造回源代理。FlushInterval = -1 让 SSE / 大文件等流式响应不被缓冲（聚水潭导入进度接口要用）。
func New(target *url.URL) http.Handler {
	rp := httputil.NewSingleHostReverseProxy(target)
	rp.FlushInterval = -1
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[proxy] 回源失败 %s %s: %v", r.Method, r.URL.Path, err)
		body := "{\"detail\":\"后端服务不可用，请稍后再试\"}"
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, body, http.StatusBadGateway)
	}
	rp.Transport = &http.Transport{
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 32,
		IdleConnTimeout:     90 * time.Second,
	}
	return rp
}
