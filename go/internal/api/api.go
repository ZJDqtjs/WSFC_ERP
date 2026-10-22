// Package api 是 Go 侧的业务接口层：路径、字段名、错误文案与 Python(FastAPI) 后端逐一对齐，
// 前端（web / mobile PWA / Flutter）只改地址就能切换后端，不需要改一行调用代码。
package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"path/filepath"
	"runtime/debug"
	"strings"

	"wsfc-erp-go/internal/auth"
	"wsfc-erp-go/internal/config"
	"wsfc-erp-go/internal/database"
	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// Server 持有配置、分仓连接、会话密钥与登录锁定状态。
type Server struct {
	Cfg   *config.Config
	Mgr   *database.Manager
	Sec   *auth.SecretStore
	Guard *auth.LockGuard
	rt    *router
	// Fallback 未迁到 Go 的接口回源 Python（迁移期两边可并行跑）。
	Fallback http.Handler
}

// New 构造服务：分仓注册表 + 连接池 + 会话密钥 + 锁定状态。
func New(cfg *config.Config) (*Server, error) {
	reg := database.NewRegistry(cfg.DataDir())
	mgr := database.NewManager(reg)
	// 开机数据层（种子账号 / 入仓品扣点 / 商品净重与默认单位回填），与 Python init_warehouse 同步。
	// 依赖 register 里注入的 AIRulesFile/AILocalFile —— register 在返回 Server 之前跑完，
	// 而连接池最早也只会在第一个请求里建，所以取配置不会读到空路径。
	mgr.AfterOpen = erp.BootWarehouse
	// 与 Python 共用同一批 json/ 配置文件：快递计费规则等改动两边同时生效
	erp.ExpressConfigPath = filepath.Join(cfg.RootJSONDir(), "express_config.json")
	erp.FreshConfigDir = cfg.JSONDir()
	erp.DeductionConfigPath = filepath.Join(cfg.JSONDir(), "deduction_config.json")
	// 模板下载：backend/docs 下有静态模板就直发，否则按工厂生成（同 Python DOCS_DIR）
	erp.ImpDocsDir = filepath.Join(cfg.BackendDir, "docs")
	s := &Server{Cfg: cfg, Mgr: mgr, Sec: auth.NewSecretStore(cfg.DataDir()), Guard: auth.NewLockGuard(cfg.DataDir())}
	s.rt = newRouter()
	s.register(s.rt)
	return s, nil
}

// Close 关闭所有分仓连接池。
func (s *Server) Close() { s.Mgr.Close() }

// Handler 组装中间件与路由。
func (s *Server) Handler() http.Handler {
	var h http.Handler = s.rtWithStatic()
	h = s.withScope(h)
	h = withCORS(h)
	h = withRecover(h)
	if s.Fallback != nil {
		h = s.withFallback(h)
	}
	return h
}

// ServeHTTP 让 Server 直接当 http.Handler 用。
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.Handler().ServeHTTP(w, r) }

// rtWithStatic 先接住 /uploads/ 静态附件（等价于 Python 的 StaticFiles 挂载），其余走业务路由。
func (s *Server) rtWithStatic() http.Handler {
	dir := s.Cfg.UploadDir()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/uploads/") {
			rel := strings.TrimPrefix(r.URL.Path, "/uploads/")
			if rel == "" || strings.Contains(rel, "..") {
				web.Error(w, http.StatusNotFound, "Not Found")
				return
			}
			http.ServeFile(w, r, filepath.Join(dir, filepath.FromSlash(rel)))
			return
		}
		s.rt.ServeHTTP(w, r)
	})
}

func withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				debug.PrintStack()
				web.Error(w, http.StatusInternalServerError, "Internal Server Error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// withCORS 与 Python CORSMiddleware 一致：全放开但不带 credentials（系统按同源部署）。
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "*")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// publicExact 免登录的确切路径。
var publicExact = map[string]bool{
	"/api/auth/login":         true,
	"/api/auth/logout":        true,
	"/api/maintenance/status": true,
	"/health":                 true,
}

// openPublicPrefixes 免会话的路径前缀：对外只读接口自己用 Header Token 鉴权
// （对齐 Python /api/open/*，那里不依赖 get_current_user）。
var openPublicPrefixes = []string{"/api/open/"}

func isOpenPublicPath(path string) bool {
	for _, p := range openPublicPrefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// withScope 会话与分仓：cookie 里的令牌决定「本请求看哪个分仓库」，
// 与 Python 的 WarehouseScopeMiddleware + get_current_user 同语义（一人切仓不影响他人）。
func (s *Server) withScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.HasPrefix(path, "/uploads/") { // 静态附件与 Python StaticFiles 一样免登录
			next.ServeHTTP(w, r)
			return
		}
		key := s.Mgr.Registry.DefaultKey()
		var user *erp.User
		if cookie, err := r.Cookie(auth.CookieName); err == nil && cookie.Value != "" {
			sec, err := s.Sec.Secret()
			if err == nil {
				if payload := auth.DecodeToken(sec, cookie.Value); payload != nil {
					if k := payload.WH; k != "" && s.Mgr.Registry.KeyExists(k) {
						key = k
					}
					// 账号表固定读默认仓，切仓不会把其他人登出
					if gdb, err := s.Mgr.DB(s.Mgr.Registry.DefaultKey()); err == nil {
						if u, err := erp.GetUserByID(r.Context(), gdb, payload.UID); err == nil && u != nil && u.IsActive {
							user = u
						}
					}
				}
			}
		}
		needAuth := !publicExact[path] && !isOpenPublicPath(path) && !strings.HasPrefix(path, "/uploads/") && path != "/api/_meta/routes"
		if needAuth && user == nil {
			web.Error(w, http.StatusUnauthorized, "未登录")
			return
		}
		db, err := s.Mgr.DB(key)
		if err != nil {
			web.Error(w, http.StatusInternalServerError, "分仓数据库不可用：%s", err.Error())
			return
		}
		r = web.SetWarehouse(r, key)
		r = web.SetDB(r, db)
		if user != nil {
			r = web.SetUser(r, user)
		}
		next.ServeHTTP(w, r)
	})
}

// withFallback 未迁到 Go 的接口原样回源 Python；已实现的（含 404/405）由 Go 自己回答。
func (s *Server) withFallback(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.rt.MatchesPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		s.Fallback.ServeHTTP(w, r)
	})
}

// ---- handler 内部使用的小工具 ----

// MustDB 本请求分仓的连接池。
func MustDB(r *http.Request) *sql.DB { return web.DB(r) }

// MustUser 当前登录账号（中间件保证已登录时非空）。
func MustUser(r *http.Request) *erp.User {
	u, _ := web.User(r).(*erp.User)
	return u
}

// Operator 单据的「操作员」一律取当前登录账号的展示名（忽略前端传值）。
func Operator(r *http.Request) string {
	if u := MustUser(r); u != nil {
		return u.Name
	}
	return ""
}

// WithTx 在一个事务里完成「单据 + 流水 + 财务 + FIFO 重算」，
// 等价于 Python 一个 Session 里 flush 后重算再 commit；中途报错整体回滚，不留半个账套。
func WithTx(r *http.Request, fn func(ctx context.Context, tx *sql.Tx) (any, error)) (any, error) {
	tx, err := MustDB(r).BeginTx(r.Context(), nil)
	if err != nil {
		return nil, err
	}
	out, err := fn(r.Context(), tx)
	if err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// WithTxMust 无返回值的写事务。
func WithTxMust(r *http.Request, fn func(ctx context.Context, tx *sql.Tx) error) error {
	_, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		return nil, fn(ctx, tx)
	})
	return err
}

// Err400 业务错误（等价于 Python 里 raise ValueError(msg) → 接口 400）。
func Err400(err error) error {
	if err == nil {
		return nil
	}
	var ae *web.AbortError
	if errors.As(err, &ae) {
		return err
	}
	// erp.BizError 自带状态码（业务 400 / 记录不存在 404），别在这里被压成 400
	var de interface{ StatusCode() int }
	if errors.As(err, &de) {
		return err
	}
	if errors.Is(err, erp.ErrNotFound) {
		return web.Abort(http.StatusNotFound, "记录不存在")
	}
	return web.Abort(http.StatusBadRequest, "%s", err.Error())
}

// NotFoundOr 把 erp.ErrNotFound 翻成 404，其它错误原样返回。
func NotFoundOr(err error, msg string) error {
	if errors.Is(err, erp.ErrNotFound) {
		return web.Abort(http.StatusNotFound, "%s", msg)
	}
	return err
}

// writeDetailErr 落盘 detail 是 JSON 对象的业务错误（Python 的 raise HTTPException(409, detail={...}），
// 如商品编码一对一冲突）。返回 false 表示不是这类错误，调用方继续走 web.WriteValue。
func writeDetailErr(w http.ResponseWriter, err error) bool {
	var de *erp.DetailError
	if !errors.As(err, &de) {
		return false
	}
	aiWrite(w, de.StatusCode(), erp.NewJ().Set("detail", de.DetailValue()))
	return true
}

// BindBody 解析 JSON 请求体为 map（业务字段口径与 Python 模型一致，缺键按默认值处理）。
func BindBody(r *http.Request) (map[string]any, error) {
	var body map[string]any
	if err := web.Bind(r, &body); err != nil {
		return nil, err
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, nil
}

// ListJSON 列表响应的空值保护（Python 返回 [] 而不是 null）。
func ListJSON(items []map[string]any) []map[string]any {
	if items == nil {
		return []map[string]any{}
	}
	return items
}
