package erp

// 本文件对齐 Python backend/app/jst/client.py 与 login.py：
// 带限速的聚水潭 HTTP 会话、Cookie 失效识别、账号密码登录、分仓列表解析。
// 注意：这里只做「读」与「登录」，下单/发货回传这类写操作不在移植范围内。

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// JstBaseURL 聚水潭（erp321）站点根。
const JstBaseURL = "https://www.erp321.com"

// JstUserAgent 与 Python 完全一致（风控会看 UA）。
const JstUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0"

// 导出链路上的三个固定路径。
const (
	JstSaleoutPath    = "/app/wms/saleout/saleout.aspx"
	JstExportPagePath = "/app/wms/saleout/ExportSaleoutV2.aspx"
	JstPageQuery      = "?_c=jst-epaas&epaas=true"
)

// JstSaleoutURL 销售出库单页面（检查登录态、拉分仓列表都打它）。
var JstSaleoutURL = JstBaseURL + JstSaleoutPath + JstPageQuery

// ---- 异常类型（对应 Python 的 NotLoggedIn / LoginError / CaptchaRequired / ExportError）----

// JstNotLoggedIn Cookie 失效 / 未登录。
type JstNotLoggedIn struct{ Msg string }

func (e *JstNotLoggedIn) Error() string { return e.Msg }

// JstLoginError 登录失败（账号密码错误、被风控拦截等）。
type JstLoginError struct{ Msg string }

func (e *JstLoginError) Error() string { return e.Msg }

// JstCaptchaRequired 聚水潭要求验证码 / 二次安全校验（需要人工介入 → 归「待办」）。
// HasAuth=true 表示带着 action/toAdmin/sid（导出被平台安全中心拦下），
// 可以用人工填的验证码调 CheckSmsAuthCode 过校验；否则只能换 Cookie。
type JstCaptchaRequired struct {
	Msg     string
	HasAuth bool
	Action  string
	ToAdmin bool
	SID     any
}

func (e *JstCaptchaRequired) Error() string { return e.Msg }

// AuthParams 待办里存的 sms_auth（键名与 Python auth_params 一致）。
func (e *JstCaptchaRequired) AuthParams() map[string]any {
	return map[string]any{"action": e.Action, "to_admin": e.ToAdmin, "sid": e.SID}
}

// JstExportError 导出流程失败。
type JstExportError struct{ Msg string }

func (e *JstExportError) Error() string { return e.Msg }

// ---- 底层客户端 ----

type jstClient struct {
	c *http.Client
}

// newJstClient：followRedirects=false 与 httpx 一致（要靠 Location 自己判断登录态）。
func newJstClient(timeout float64) *jstClient {
	c := &http.Client{Timeout: jstDuration(timeout)}
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }
	return &jstClient{c: c}
}

func jstDuration(sec float64) time.Duration {
	if sec <= 0 {
		sec = 120
	}
	return time.Duration(sec * float64(time.Second))
}

func (cl *jstClient) call(method, rawURL string, body []byte, params map[string]string, headers map[string]string) (*jstResponse, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	if len(params) > 0 {
		q := u.Query()
		for k, v := range params {
			q.Set(k, v)
		}
		u.RawQuery = q.Encode()
	}
	var rdr io.Reader
	if body != nil {
		rdr = strings.NewReader(string(body))
	}
	req, err := http.NewRequest(method, u.String(), rdr)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := cl.c.Do(req)
	if err != nil {
		return nil, jstWrapURLError(err, u.String())
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, jstWrapURLError(err, u.String())
	}
	return &jstResponse{status: resp.StatusCode, header: resp.Header, body: data, url: u.String()}, nil
}

// jstWrapURLError 把 Go 的网络错误收敛成短句（Python 会把它塞进「检查失败：{e}」里）。
func jstWrapURLError(err error, where string) error {
	var uerr *url.Error
	if errors.As(err, &uerr) {
		return errors.New(uerr.Err.Error())
	}
	return err
}

type jstResponse struct {
	status int
	header http.Header
	body   []byte
	url    string
}

func (r *jstResponse) StatusCode() int { return r.status }
func (r *jstResponse) Text() string     { return string(r.body) }
func (r *jstResponse) Content() []byte { return r.body }
func (r *jstResponse) HeaderVal(k string) string { return r.header.Get(k) }

// RaiseForStatus 等价 httpx raise_for_status（4/5 段状态码报错，文案仿 httpx）。
func (r *jstResponse) RaiseForStatus() error {
	if r.status < 400 {
		return nil
	}
	kind := "Client"
	if r.status >= 500 {
		kind = "Server"
	}
	return fmt.Errorf("%s error '%s' for url '%s'", kind, http.StatusText(r.status), r.url)
}

func (r *jstResponse) jsonMap() (map[string]any, error) {
	var m map[string]any
	if err := jsonUseNumber(r.body, &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

// JstEnsureLoggedIn 识别被踢回登录页的情况，避免拿着失效 Cookie 反复重试。
func JstEnsureLoggedIn(resp *jstResponse, redirectOK bool) error {
	switch resp.status {
	case 301, 302, 303, 307, 308:
		location := strings.ToLower(resp.header.Get("location"))
		if strings.Contains(location, "login") || location == "/epaas" {
			return &JstNotLoggedIn{"Cookie 已失效，被重定向到登录页，请在「自动出库设置」里重新填写账号密码或 Cookie"}
		}
		if redirectOK {
			return nil
		}
	}
	if resp.status == 401 || resp.status == 403 {
		return &JstNotLoggedIn{fmt.Sprintf("请求被拒绝（HTTP %d），Cookie 可能已失效", resp.status)}
	}
	if strings.Contains(resp.Text(), `"GotoLogin":true`) {
		return &JstNotLoggedIn{"接口返回 GotoLogin=true，Cookie 已失效，请重新填写账号密码或 Cookie"}
	}
	return nil
}

// ---- 带限速的会话 ----

// JstSession 保证两次请求之间至少间隔 minInterval 秒（聚水潭对高频请求会风控）。
type JstSession struct {
	mu        sync.Mutex
	minInt    float64
	lastReq   time.Time
	timeout   float64
	client    *jstClient
	headers   map[string]string
	reloginFn func() (string, error)
}

// NewJstSession：有 Cookie 就直接复用（聚水潭 Cookie 有效期很长）；
// 没有 Cookie 且配了账号密码则先登录一次，登录失败按 Python 一样把异常抛给调用方。
func NewJstSession(cookie string, minInterval, timeout float64, relogin func() (string, error)) (*JstSession, error) {
	if cookie == "" && relogin != nil {
		c, err := relogin()
		if err != nil {
			return nil, err
		}
		cookie = c
	}
	s := &JstSession{
		minInt: minInterval, timeout: timeout, client: newJstClient(timeout), reloginFn: relogin,
		headers: map[string]string{
			"accept":           "*/*",
			"accept-language":  "zh-CN,zh;q=0.9,en;q=0.8",
			"origin":           JstBaseURL,
			"user-agent":       JstUserAgent,
			"x-requested-with": "XMLHttpRequest",
			"cookie":           cookie,
		},
	}
	return s, nil
}

// Cookie 当前请求头里的 Cookie（check_login 用它判断 cookie_refreshed）。
func (s *JstSession) Cookie() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.headers["cookie"]
}

// Close 释放空闲连接。
func (s *JstSession) Close() {
	if s.client != nil {
		s.client.c.CloseIdleConnections()
	}
}

// Relogin Cookie 失效时重新登录并就地替换请求头，返回是否续登成功。
func (s *JstSession) Relogin() bool {
	if s.reloginFn == nil {
		return false
	}
	cookie, err := s.reloginFn()
	if err != nil {
		return false
	}
	s.mu.Lock()
	s.headers["cookie"] = cookie
	s.mu.Unlock()
	return true
}

// throttle 不足 minInterval 就补足等待（Python _throttle 用 monotonic 时钟）。
func (s *JstSession) throttle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.lastReq.IsZero() && s.minInt > 0 {
		if wait := time.Duration(s.minInt*float64(time.Second)) - time.Since(s.lastReq); wait > 0 {
			time.Sleep(wait)
		}
	}
	s.lastReq = time.Now()
}

// Get 一次 GET；follow=true 时跟随重定向（下载 OSS 文件用）。
func (s *JstSession) Get(rawURL string, params map[string]string, extraHeaders map[string]string, follow bool) (*jstResponse, error) {
	s.throttle()
	if follow {
		c2 := &jstClient{c: &http.Client{Timeout: jstDuration(s.timeout)}}
		defer c2.c.CloseIdleConnections()
		return c2.call(http.MethodGet, rawURL, nil, params, s.mergedHeaders(extraHeaders))
	}
	return s.client.call(http.MethodGet, rawURL, nil, params, s.mergedHeaders(extraHeaders))
}

// PostForm 一次表单 POST（等价 httpx data=...）。
func (s *JstSession) PostForm(rawURL string, form map[string]string, extraHeaders map[string]string) (*jstResponse, error) {
	s.throttle()
	v := url.Values{}
	for k, val := range form {
		v.Set(k, val)
	}
	h := map[string]string{"content-type": "application/x-www-form-urlencoded"}
	for k, val := range extraHeaders {
		h[k] = val
	}
	return s.client.call(http.MethodPost, rawURL, []byte(v.Encode()), nil, s.mergedHeaders(h))
}

func (s *JstSession) mergedHeaders(extra map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range s.headers {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// ---- 登录 ----

const (
	jstLoginPageURL = JstBaseURL + "/login.aspx"
	jstPassportURL  = "https://api.erp321.com/erp/webapi/UserApi/WebLogin/Passport"
)

var (
	jstWarehouseRe = regexp.MustCompile(`(?s)var\s+warehouseList\s*=\s*(\[\{.*?\}\])`)
	jstItemRe      = regexp.MustCompile(`\{"value":(\d+),"text":"(.*?)"\}`)
)

// jstCodeMsg 登录返回码 → 人话（与 Python _CODE_MSG 一致）。
var jstCodeMsg = map[float64]string{
	0:      "登录成功",
	10003:  "触发了图形验证码校验，纯请求登录无法通过（请在浏览器登录后把 Cookie 粘到设置里）",
	10005:  "账号或密码错误",
	301105: "需要安全校验（uidSecuCode 已过期）",
	301109: "触发了 IDAAS 二次验证，需要人工处理（请在浏览器登录后把 Cookie 粘到设置里）",
}

// JstWarehouse 聚水潭分仓。
type JstWarehouse struct {
	CoID string
	Name string
}

// JstLogin 用账号密码换一套新 Cookie；要验证码时抛 JstCaptchaRequired。
// deviceID/clientID 对应浏览器指纹 j_d_3 / v_d_144，续登时保持一致。
func JstLogin(account, password, deviceID, clientID string, timeout float64, verifyCode string) (string, error) {
	if account == "" || password == "" {
		return "", &JstLoginError{"未配置账号或密码，无法自动登录"}
	}
	cl := newJstClient(timeout)
	defer cl.c.CloseIdleConnections()
	jar := newJstCookieJar()

	// 先落一个 acw_tc 会话票据，再调登录接口
	resp, err := cl.call(http.MethodGet, jstLoginPageURL, nil, nil, map[string]string{"user-agent": JstUserAgent})
	if err != nil {
		return "", err
	}
	jar.absorb(resp)

	payload := map[string]any{"data": map[string]any{
		"account":    account,
		"password":   password,
		"verifyCode": strings.TrimSpace(orStr(verifyCode)),
		"j_d_3":      orStr(deviceID),
		"v_d_144":    orStr(clientID),
		"isApp":      false,
	}}
	raw, err := jsonMarshalNoEscape(payload)
	if err != nil {
		return "", err
	}
	resp, err = cl.call(http.MethodPost, jstPassportURL, raw, nil, map[string]string{
		"content-type": "application/json",
		"origin":       "https://src.erp321.com",
		"referer":      "https://src.erp321.com/",
		"accept":       "application/json, text/plain, */*",
		"user-agent":   JstUserAgent,
	})
	if err != nil {
		return "", err
	}
	jar.absorb(resp)
	if err := resp.RaiseForStatus(); err != nil {
		return "", err
	}
	body, err := resp.jsonMap()
	if err != nil {
		return "", err
	}
	code, hasCode := jstPyFloat(body["code"])
	msg := "未知错误"
	if s, ok := body["msg"].(string); ok && s != "" {
		msg = s
	}
	if preset, ok := jstCodeMsg[code]; ok && hasCode {
		msg = preset
	}
	failMsg := fmt.Sprintf("登录失败（code=%s）：%s", jstFloatText(body["code"]), msg)
	if hasCode && (code == 10003 || code == 301105 || code == 301109) {
		return "", &JstCaptchaRequired{Msg: failMsg}
	}
	if !hasCode || code != 0 {
		return "", &JstLoginError{failMsg}
	}
	data, _ := body["data"].(map[string]any)
	if data == nil {
		data = map[string]any{}
	}
	if jstTruthy(data["hasRisk"], false) || jstTruthy(data["idaasHasRisk"], false) {
		return "", &JstCaptchaRequired{Msg: fmt.Sprintf(
			"登录被风控拦截（hasRisk=%s）：需要在待办里填一次验证码，或到浏览器登录后把 Cookie 粘进来", jstPyStr(data["hasRisk"]))}
	}
	cookie := jar.String(deviceID, clientID)
	if !strings.Contains(cookie, "isLogin=true") {
		return "", &JstLoginError{"登录接口返回成功，但未下发登录态 Cookie"}
	}
	return cookie, nil
}

// jstFloatText code 的展示形式（Python 的 f-string：整数不带小数点）。
func jstFloatText(v any) string {
	if f, ok := jstPyFloat(v); ok {
		if f == float64(int64(f)) {
			return fmt.Sprintf("%d", int64(f))
		}
		return pyFloatRepr(f)
	}
	if v == nil {
		return "None"
	}
	return jstPyStr(v)
}

// JstParseWarehouses 从 saleout.aspx 页面解析分仓列表（服务端直出的 var warehouseList）。
func JstParseWarehouses(html string) []JstWarehouse {
	m := jstWarehouseRe.FindStringSubmatch(html)
	if m == nil {
		return []JstWarehouse{}
	}
	out := []JstWarehouse{}
	for _, it := range jstItemRe.FindAllStringSubmatch(m[1], -1) {
		out = append(out, JstWarehouse{CoID: it[1], Name: it[2]})
	}
	return out
}

// JstDeviceIDsFromCookie 从现有 Cookie 里取 j_d_3 / v_d_144。
func JstDeviceIDsFromCookie(cookie string) (string, string) {
	fields := map[string]string{}
	for _, item := range strings.Split(cookie, ";") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		kv := strings.SplitN(item, "=", 2)
		key := kv[0]
		if key == "" {
			continue
		}
		val := ""
		if len(kv) > 1 {
			val = kv[1]
		}
		fields[key] = val
	}
	return fields["j_d_3"], fields["v_d_144"]
}

// JstBuildRelogin 生成续登回调；未配置账号密码时返回 nil（等价 Python 返回 None）。
func JstBuildRelogin(account, password, oldCookie string, timeout float64, verifyCode string) func() (string, error) {
	if account == "" || password == "" {
		return nil
	}
	deviceID, clientID := JstDeviceIDsFromCookie(oldCookie)
	return func() (string, error) {
		return JstLogin(account, password, deviceID, clientID, timeout, verifyCode)
	}
}

// ---- 极简 CookieJar：保留首次出现顺序、同名取最后一个值（等价 Python jar→dict）----

type jstCookieJar struct {
	mu    sync.Mutex
	order []string
	vals  map[string]string
}

func newJstCookieJar() *jstCookieJar {
	return &jstCookieJar{vals: map[string]string{}}
}

func (j *jstCookieJar) absorb(resp *jstResponse) {
	if resp == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, raw := range resp.header.Values("set-cookie") {
		name, value, ok := parseSetCookie(raw)
		if !ok {
			continue
		}
		if _, seen := j.vals[name]; !seen {
			j.order = append(j.order, name)
		}
		j.vals[name] = value
	}
}

// String 拼 Cookie 头，并按需补设备指纹（Python cookie_from_jar）。
func (j *jstCookieJar) String(deviceID, clientID string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	pairs := make([]string, 0, len(j.order)+2)
	for _, n := range j.order {
		pairs = append(pairs, n+"="+j.vals[n])
	}
	has := func(name string) bool {
		for _, n := range j.order {
			if n == name {
				return j.vals[name] != ""
			}
		}
		return false
	}
	if deviceID != "" && !has("j_d_3") {
		pairs = append(pairs, "j_d_3="+deviceID)
	}
	if clientID != "" && !has("v_d_144") {
		pairs = append(pairs, "v_d_144="+clientID)
	}
	return strings.Join(pairs, "; ")
}

func parseSetCookie(raw string) (string, string, bool) {
	segs := strings.Split(raw, ";")
	if len(segs) == 0 {
		return "", "", false
	}
	kv := strings.SplitN(strings.TrimSpace(segs[0]), "=", 2)
	if len(kv) != 2 || kv[0] == "" {
		return "", "", false
	}
	return kv[0], kv[1], true
}
