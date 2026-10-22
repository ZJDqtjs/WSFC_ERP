package api

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"wsfc-erp-go/internal/auth"
	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// ---------------- 会话：私钥登录 / 登出 / 当前身份 ----------------

// loginIn 登录请求体。
// private_key 是主系统口径（与 Python 一致）；password 是 Go 端为移动端增加的便捷通道，
// 只对 users.password_hash 非空的账号生效（种子管理员账号），详见 docs/api_go_design.md。
type loginIn struct {
	Username   string "json:\"username\""
	PrivateKey string "json:\"private_key\""
	Password   string "json:\"password\""
}

// Login POST /api/auth/login —— 私钥登录 + 分级失败锁定，与 Python routers/auth.py 同口径。
// 账号表固定读默认仓（切仓不影响登录），新会话从默认分仓起步。
func (s *Server) Login(w http.ResponseWriter, r *http.Request) {
	var in loginIn
	if err := web.Bind(r, &in); err != nil {
		web.WriteValue(w, r, err)
		return
	}
	username := strings.TrimSpace(in.Username)
	if username == "" {
		web.Error(w, http.StatusUnauthorized, "用户名或私钥不匹配")
		return
	}
	if left := s.Guard.LockedLeft(auth.ScopeERP, username); left > 0 {
		web.Error(w, http.StatusTooManyRequests, "账号已锁定，请 %s 后再试", auth.Humanize(left))
		return
	}
 gdb, err := s.Mgr.DB(s.Mgr.Registry.DefaultKey())
	if err != nil {
		web.Error(w, http.StatusInternalServerError, "账号库不可用：%s", err.Error())
		return
	}
	reject := func() {
		wait := s.Guard.RecordFail(auth.ScopeERP, username)
		if wait > 0 {
			web.Error(w, http.StatusTooManyRequests, "连续失败次数过多，账号已锁定 %s，请稍后再试", auth.Humanize(wait))
			return
		}
		web.Error(w, http.StatusUnauthorized, "用户名或私钥不匹配")
	}
	user, err := erp.GetUserByUsername(r.Context(), gdb, username)
	if err != nil || user == nil || !user.IsActive {
		reject()
		return
	}
	if in.PrivateKey != "" {
		_, fp, err := auth.FingerprintFromPrivate(in.PrivateKey)
		if err != nil {
			web.Error(w, http.StatusBadRequest, "%s", err.Error()) // 私钥格式问题不计入锁定
			return
		}
		if user.Fingerprint == "" || !secureEqual(fp, user.Fingerprint) {
			reject()
			return
		}
	} else if in.Password != "" {
		if user.PasswordHash == "" || !auth.VerifyPassword(in.Password, user.PasswordHash) {
			reject()
			return
		}
	} else {
		web.Error(w, http.StatusBadRequest, "请提供私钥（private_key）或密码（password）")
		return
	}
	s.Guard.Reset(auth.ScopeERP, username)

	key := s.Mgr.Registry.DefaultKey()
	token, err := s.issueToken(w, user.ID, key)
	if err != nil {
		web.Error(w, http.StatusInternalServerError, "签发会话失败：%s", err.Error())
		return
	}
	_ = token
	web.Write(w, http.StatusOK, map[string]any{
		"ok":        true,
		"user":      user.UserJSON(),
		"warehouse": map[string]any{"key": key, "name": s.Mgr.Registry.Name(key)},
	})
}

// Logout POST /api/auth/logout —— 只删浏览器 cookie；令牌本身无状态，到期前仍然有效（与 Python 一致）。
func (s *Server) Logout(w http.ResponseWriter, r *http.Request) {
	clearSessionCookie(w)
	web.Write(w, http.StatusOK, map[string]any{"ok": true})
}

// Me GET /api/auth/me —— 当前身份 + 本会话所在分仓。
func (s *Server) Me(w http.ResponseWriter, r *http.Request) {
	user := MustUser(r)
	if user == nil {
		web.Error(w, http.StatusUnauthorized, "未登录")
		return
	}
	key := web.Warehouse(r)
	web.Write(w, http.StatusOK, map[string]any{
		"id": user.ID, "username": user.Username, "name": user.Name, "role": user.Role,
		"warehouse": map[string]any{"key": key, "name": s.Mgr.Registry.Name(key)},
	})
}

// issueToken 签发会话并写 cookie（Max-Age 7 天 / HttpOnly / Path=/ / SameSite=Lax）。
func (s *Server) issueToken(w http.ResponseWriter, uid int, key string) (string, error) {
	sec, err := s.Sec.Secret()
	if err != nil {
		return "", err
	}
	token, err := auth.MakeToken(sec, uid, key)
	if err != nil {
		return "", err
	}
	http.SetCookie(w, &http.Cookie{
		Name: auth.CookieName, Value: token, Path: "/", MaxAge: auth.TokenMaxAge,
		HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	return token, nil
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: auth.CookieName, Value: "", Path: "/", MaxAge: -1})
}

// secureEqual 定长比较，避免用 == 造成的时序侧信道（对应 Python hmac.compare_digest）。
// secureEqual 定长比较，避免用 == 造成的时序侧信道（对应 Python hmac.compare_digest）。
func secureEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

