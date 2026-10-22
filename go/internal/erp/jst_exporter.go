package erp

// 本文件对齐 Python backend/app/jst/exporter.py：销售出库单导出四步流程
//   1. GET  saleout.aspx           取 __VIEWSTATE / __VIEWSTATEGENERATOR
//   2. POST saleout.aspx?am___=ExportSaleOut   拿导出令牌 JTable:<uid>-<hash>
//   3. GET  ExportSaleoutV2.aspx?s=<令牌>       302 到 www-do.erp321.com
//   4. GET  OSS 签名地址                        下载 xlsx
// 另外包含「导出要先过短信验证」的识别与 CheckSmsAuthCode 校验。

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	jstAPIBase     = "https://api.erp321.com"
	jstSmsSendPath = "/erp/webapi/SecurityApi/SendSmsAuthCode"
	jstSmsCheckP   = "/erp/webapi/SecurityApi/CheckSmsAuthCode"
)

var (
	reJstViewstate = regexp.MustCompile(`id="__VIEWSTATE" value="([^"]*)"`)
	reJstViewgen   = regexp.MustCompile(`id="__VIEWSTATEGENERATOR" value="([^"]*)"`)
	reJstToken     = regexp.MustCompile(`"ReturnValue":"(JTable:[^"]+)"`)
	reJstMoved     = regexp.MustCompile(`href="([^"]+)"`)
	reJstMsg       = regexp.MustCompile(`"msg":"([^"]*)"`)
	reJstFileDISP  = regexp.MustCompile(`filename=([^;]+)`)
)

// 导出时间区间在接口里的格式。
const jstTimeFmt = "2006-01-02 15:04:05"

// 「导出出库单要先过短信验证」的识别标记。
var (
	jstCaptchaCodes   = []string{"910001"}
	jstCaptchaMarkers = []string{"验证码", "验证身份", "身份验证"}
)

// jstBaseFields ASP.NET 表单的固定字段（取自 HAR 里 ExportSaleOut 的真实请求体）。
var jstBaseFields = map[string]string{
	"set_type": "1",
	"l_id2": "", "l_id4": "", "sorted_ioids": "", "is_tpw_wms": "0", "insurePrice": "",
	"o_id": "", "sku_id": "", "lc_ids": "", "lc_id_dom": "", "status": "", "is_weight": "",
	"labels": "", "nolabels": "", "seller_flag": "", "node": "", "is_print_express": "",
	"is_print": "", "shop_name": "", "receiver_nameCtrl": "", "remark": "", "outer_so_id": "",
	"platformId": "", "print_count": "", "drp_co_id_id": "", "drp_co_id": "", "sku_count": "",
	"sWeight": "", "bWeight": "", "receiver_state": "", "carryId": "", "wms_co_id_select_id": "",
	"wms_co_id_select": "", "cus_id": "", "cus": "", "creator": "", "goodType": "skus",
	"has_ipc": "", "_jt_page_count_enabled": "", "_jt_page_increament_enabled": "true",
	"_jt_page_increament_page_mode": "", "_jt_page_increament_key_value": "",
	"_jt_page_increament_business_values": "", "_jt_page_increament_key_name": "io_id",
	"_jt_page_size": "500", "receiver_city": "", "receiver_district": "", "receiver_address": "",
	"receiver_name": "", "receiver_phone": "", "receiver_mobile": "", "check_name": "",
	"check_address": "", "_cbb_lc_id_dom": "", "_cbb_status": "", "_cbb_shop_name": "",
	"_cbb_receiver_state": "", "_cbb_wms_co_id_select": "", "_cbb_cus": "",
	"__CALLBACKID": "JTable1",
}

// JstConfig 一次导出所需的全部参数（由「自动出库设置」+ 当前分仓配置组装）。
type JstConfig struct {
	Cookie           string
	Account          string
	Password         string
	OwnerCoID        string
	AuthorizeCoID    string
	OutputDir        string
	Window           string
	FixedRange       []time.Time // 长度 2 才生效（固定区间）
	IODateField      string
	MinInterval      float64
	Timeout          float64
	MaxRetries       int
	Flag             int
	Schedule         []JstSchedule
	FilenameTemplate string
	KeepRawName      bool
	VerifyCode       string
}

// CanRelogin 是否具备账号密码续登条件。
func (c *JstConfig) CanRelogin() bool { return c.Account != "" && c.Password != "" }

// ResolveWindow 按配置的区间规则算出本次导出的 [start, end)。
func (c *JstConfig) ResolveWindow(now time.Time) (time.Time, time.Time, error) {
	return JstResolveWindow(c.Window, now)
}

// JstCheckSmsCode 把人工填的验证码交给聚水潭校验（导出前那道「验证身份」）。
// 返回 (是否通过, 提示语)；网络异常也按「没过」处理。
func JstCheckSmsCode(cookie, smsCode, action string, toAdmin bool, sid any, timeout float64) (bool, string) {
	code := strings.TrimSpace(orStr(smsCode))
	if code == "" {
		return false, "验证码为空"
	}
	var smsVal any = code
	if isAllDigits(code) {
		if n, err := strconv.Atoi(code); err == nil {
			smsVal = n
		}
	}
	payload := map[string]any{"data": orderedMap{
		{"smsCode", smsVal}, {"action", action}, {"toAdmin", toAdmin}, {"sid", sid},
	}}
	if timeout <= 0 {
		timeout = 30
	}
	cl := newJstClient(timeout)
	defer cl.c.CloseIdleConnections()
	raw, err := jsonMarshalNoEscape(payload)
	if err != nil {
		return false, fmt.Sprintf("校验请求失败：%s", err)
	}
	resp, err := cl.call("POST", jstAPIBase+jstSmsCheckP, raw, nil, map[string]string{
		"content-type": "application/json",
		"accept":       "application/json, text/plain, */*",
		"cookie":       cookie,
		"user-agent":   JstUserAgent,
		"origin":       JstBaseURL,
		"referer":      JstBaseURL + "/",
	})
	if err != nil {
		return false, fmt.Sprintf("校验请求失败：%s", err)
	}
	data, err := resp.jsonMap()
	if err != nil {
		return false, fmt.Sprintf("校验返回异常（HTTP %d）", resp.status)
	}
	codeNum, _ := jstPyFloat(data["code"])
	if codeNum == 0 && jstTruthy(data["data"], false) {
		return true, "验证通过"
	}
	if m, ok := data["msg"].(string); ok && m != "" {
		return false, m
	}
	return false, fmt.Sprintf("校验失败（code=%s）", jstFloatText(data["code"]))
}

// jstSmsSendPath 保留常量引用（发码接口目前由聚水潭页面自己触发，Go 侧不主动调用）。
var _ = jstSmsSendPath

// JstMakeRelogin Cookie 失效时用账号密码换一套新的，并通过 onCookie 持久化。
func JstMakeRelogin(cfg *JstConfig, onCookie func(string)) func() (string, error) {
	base := JstBuildRelogin(cfg.Account, cfg.Password, cfg.Cookie, cfg.Timeout, cfg.VerifyCode)
	if base == nil {
		return nil
	}
	return func() (string, error) {
		cookie, err := base()
		if err != nil {
			return "", err
		}
		cfg.Cookie = cookie
		if onCookie != nil {
			if err := onCookieWrapErr(onCookie, cookie); err != nil {
				jstLogf("新 Cookie 写回设置失败：%s", err)
			}
		}
		return cookie, nil
	}
}

func onCookieWrapErr(fn func(string), cookie string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	fn(cookie)
	return nil
}

// JstExporter 一次导出的执行者（自己持有会话时负责关闭）。
type JstExporter struct {
	cfg         *JstConfig
	session     *JstSession
	ownsSession bool
}

// NewJstExporter 建导出器（内部建会话）。会话建不出来（首次登录失败）时返回错误。
func NewJstExporter(cfg *JstConfig, onCookie func(string)) (*JstExporter, error) {
	s, err := NewJstSession(cfg.Cookie, cfg.MinInterval, cfg.Timeout, JstMakeRelogin(cfg, onCookie))
	if err != nil {
		return nil, err
	}
	return &JstExporter{cfg: cfg, session: s, ownsSession: true}, nil
}

// Close 关闭自己创建的会话。
func (e *JstExporter) Close() {
	if e.ownsSession {
		e.session.Close()
	}
}

// loadViewstate 步骤 1：取表单隐藏字段。
func (e *JstExporter) loadViewstate() (string, string, error) {
	resp, err := e.session.Get(JstBaseURL+JstSaleoutPath+JstPageQuery, nil, nil, false)
	if err != nil {
		return "", "", err
	}
	if err := JstEnsureLoggedIn(resp, false); err != nil {
		return "", "", err
	}
	if err := resp.RaiseForStatus(); err != nil {
		return "", "", err
	}
	vs := reJstViewstate.FindStringSubmatch(resp.Text())
	vg := reJstViewgen.FindStringSubmatch(resp.Text())
	if vs == nil || vg == nil {
		return "", "", &JstExportError{"未能从出库单页面解析出 __VIEWSTATE，页面结构可能已变更"}
	}
	return vs[1], vg[1], nil
}

// CreateExportTask 步骤 2：创建导出任务，返回导出令牌。
func (e *JstExporter) CreateExportTask(start, end time.Time) (string, error) {
	viewstate, viewgen, err := e.loadViewstate()
	if err != nil {
		return "", err
	}
	filters := []orderedMap{
		{{"k", e.cfg.IODateField}, {"v", start.Format(jstTimeFmt)}, {"c", ">="}},
		{{"k", e.cfg.IODateField}, {"v", end.Format(jstTimeFmt)}, {"c", "<"}},
	}
	filterJSON, err := jsonMarshalNoEscape(filters)
	if err != nil {
		return "", err
	}
	exportPar := orderedMap{
		{"Filter", string(filterJSON)},
		{"CheckIoIds", orderedMap{}},
		{"Flag", e.cfg.Flag},
		{"CheckoutAfterSend", orderedMap{}},
		{"IsExportSonInouts", false},
		{"IsExportNoTask", true},
	}
	parJSON, err := jsonMarshalNoEscape(exportPar)
	if err != nil {
		return "", err
	}
	callback := orderedMap{
		{"Method", "ExportSaleOut"},
		{"Args", []any{string(parJSON)}},
		{"CallControl", "{page}"},
	}
	cbJSON, err := jsonMarshalNoEscape(callback)
	if err != nil {
		return "", err
	}
	data := map[string]string{}
	for k, v := range jstBaseFields {
		data[k] = v
	}
	data["__VIEWSTATE"] = viewstate
	data["__VIEWSTATEGENERATOR"] = viewgen
	data["owner_co_id"] = e.cfg.OwnerCoID
	data["authorize_co_id"] = e.cfg.AuthorizeCoID
	data["__CALLBACKPARAM"] = string(cbJSON)

	ts := time.Now().UnixNano() / int64(time.Millisecond)
	u := fmt.Sprintf("%s%s%s&ts___=%d&am___=ExportSaleOut", JstBaseURL, JstSaleoutPath, JstPageQuery, ts)
	resp, err := e.session.PostForm(u, data, nil)
	if err != nil {
		return "", err
	}
	if err := JstEnsureLoggedIn(resp, false); err != nil {
		return "", err
	}
	if err := resp.RaiseForStatus(); err != nil {
		return "", err
	}
	if strings.Contains(resp.Text(), `"IsSuccess":false`) {
		if hint, rv := jstCaptchaHint(resp.Text()); hint != "" {
			return "", &JstCaptchaRequired{
				Msg: fmt.Sprintf("聚水潭要求短信验证（导出出库单）：%s —— 在「待办」里填验证码即可（会先校验，通过后自动重跑）", hint),
				HasAuth: true, Action: jstPyStr(rv["action"]), ToAdmin: jstTruthy(rv["toAdmin"], false), SID: rv["sid"],
			}
		}
		return "", &JstExportError{fmt.Sprintf("创建导出任务失败：%s", jstClip(resp.Text(), 300))}
	}
	m := reJstToken.FindStringSubmatch(resp.Text())
	if m == nil {
		return "", &JstExportError{fmt.Sprintf("未能解析导出令牌，返回内容：%s", jstClip(resp.Text(), 300))}
	}
	return m[1], nil
}

// jstCaptchaHint 识别「要求短信验证」的返回：返回 (提示文案, ReturnValue)，不是这种情况返回 ("", nil)。
func jstCaptchaHint(text string) (string, map[string]any) {
	codeHit := false
	for _, c := range jstCaptchaCodes {
		if strings.Contains(text, fmt.Sprintf(`"Message":"%s"`, c)) {
			codeHit = true
			break
		}
	}
	hint := ""
	if m := reJstMsg.FindStringSubmatch(text); m != nil {
		hint = strings.TrimSpace(m[1])
	}
	if !codeHit {
		matched := false
		for _, k := range jstCaptchaMarkers {
			if strings.Contains(hint, k) {
				matched = true
				break
			}
		}
		if !matched {
			return "", nil
		}
	}
	rv := jstParseCallReturn(text)["ReturnValue"]
	if m, ok := rv.(map[string]any); ok {
		return orStr(hint, "聚水潭要求验证身份"), m
	}
	return orStr(hint, "聚水潭要求验证身份"), map[string]any{}
}

// jstParseCallReturn 解析 ASP.NET AJAX 的 `0|{...}` 响应体（只取第一个 JSON 对象）。
func jstParseCallReturn(text string) map[string]any {
	i := strings.Index(text, "{")
	if i < 0 {
		return map[string]any{}
	}
	raw := []byte(text[i:])
	decEnd, obj, err := jsonScanObject(raw)
	_ = decEnd
	if err != nil {
		return map[string]any{}
	}
	if m, ok := obj.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// jstExtractRedirect 取「下一步该访问的地址」：先看 Location，再看 meta 刷新页里的 href。
func jstExtractRedirect(resp *jstResponse) string {
	if loc := resp.HeaderVal("location"); loc != "" {
		return loc
	}
	if resp.status == 200 && strings.Contains(strings.ToLower(resp.HeaderVal("content-type")), "text/html") {
		if m := reJstMoved.FindStringSubmatch(resp.Text()); m != nil {
			return strings.ReplaceAll(m[1], "&amp;", "&")
		}
	}
	return ""
}

// FetchFile 步骤 3~5：拿下载地址并下载。
func (e *JstExporter) FetchFile(token string) ([]byte, string, error) {
	params := map[string]string{
		"s":               token,
		"owner_co_id":     e.cfg.OwnerCoID,
		"authorize_co_id": e.cfg.AuthorizeCoID,
	}
	u := JstBaseURL + JstExportPagePath
	resp, err := e.session.Get(u, params, nil, false)
	if err != nil {
		return nil, "", err
	}
	target := ""
	for attempt := 1; attempt <= e.cfg.MaxRetries; attempt++ {
		if err := JstEnsureLoggedIn(resp, true); err != nil {
			return nil, "", err
		}
		target = jstExtractRedirect(resp)
		if target != "" {
			break
		}
		if attempt == e.cfg.MaxRetries {
			return nil, "", &JstExportError{fmt.Sprintf("导出文件生成超时，最后一次响应：%s", jstClip(resp.Text(), 300))}
		}
		time.Sleep(jstDuration(e.cfg.MinInterval))
		resp, err = e.session.Get(u, params, nil, false)
		if err != nil {
			return nil, "", err
		}
	}
	download, err := e.session.Get(target, nil, map[string]string{
		"referer": JstBaseURL + JstSaleoutPath + JstPageQuery,
	}, true)
	if err != nil {
		return nil, "", err
	}
	if err := JstEnsureLoggedIn(download, true); err != nil {
		return nil, "", err
	}
	if err := download.RaiseForStatus(); err != nil {
		return nil, "", err
	}
	if strings.Contains(strings.ToLower(download.HeaderVal("content-type")), "html") &&
		!strings.HasPrefix(string(download.Content()), "PK") {
		return nil, "", &JstExportError{fmt.Sprintf("下载到的不是 Excel 文件：%s", jstClip(download.Text(), 300))}
	}
	return download.Content(), e.extractFilename(download, target), nil
}

func (e *JstExporter) extractFilename(resp *jstResponse, fallbackURL string) string {
	disp := resp.HeaderVal("content-disposition")
	if m := reJstFileDISP.FindStringSubmatch(disp); m != nil {
		return jstUnquote(strings.Trim(strings.TrimSpace(m[1]), "\""))
	}
	u, err := url.Parse(fallbackURL)
	if err != nil {
		return path.Base(fallbackURL)
	}
	return jstUnquote(path.Base(u.Path))
}

// Export 完整跑一遍并落盘，返回保存路径。
func (e *JstExporter) Export(start, end time.Time) (string, error) {
	token, err := e.CreateExportTask(start, end)
	if err != nil {
		return "", err
	}
	content, remoteName, err := e.FetchFile(token)
	if err != nil {
		return "", err
	}
	if err := mkdirAll(e.cfg.OutputDir); err != nil {
		return "", err
	}
	name := remoteName
	if !e.cfg.KeepRawName {
		formatted, err := jstFormatFilename(e.cfg.FilenameTemplate, start, end, e.cfg.AuthorizeCoID, e.cfg.OwnerCoID)
		if err != nil {
			jstLogf("文件名模板 %q 不可用（%s），改用聚水潭原始文件名", e.cfg.FilenameTemplate, err)
			name = remoteName
		} else {
			name = formatted
		}
	}
	p := joinPath(e.cfg.OutputDir, name)
	if err := writeFile(p, content); err != nil {
		return "", err
	}
	return p, nil
}

// ExportWithRetries 带重试的导出：Cookie 失效最多续登一次；要验证码时直接上交给「待办」。
func (e *JstExporter) ExportWithRetries(start, end time.Time) (string, error) {
	var lastErr error
	relogged := false
	for attempt := 1; attempt <= e.cfg.MaxRetries; attempt++ {
		p, err := e.Export(start, end)
		if err == nil {
			return p, nil
		}
		var nl *JstNotLoggedIn
		var capErr *JstCaptchaRequired
		switch {
		case asJst(err, &capErr):
			return "", err
		case asJst(err, &nl):
			lastErr = err
			if relogged {
				return "", err
			}
			if !e.session.Relogin() {
				return "", err
			}
			relogged = true
			jstLogf("Cookie 已失效并完成自动续登，重试导出")
		default:
			lastErr = err
			jstLogf("第 %d/%d 次导出失败：%s", attempt, e.cfg.MaxRetries, err)
			if attempt < e.cfg.MaxRetries {
				time.Sleep(jstDuration(e.cfg.MinInterval))
			}
		}
	}
	return "", &JstExportError{fmt.Sprintf("导出失败，已重试 %d 次：%s", e.cfg.MaxRetries, lastErr)}
}

// asJst 类型的 errors.As 简写（错误链上找特定类型）。
func asJst(err error, target any) bool {
	return errorsAs(err, target)
}

// jstFormatFilename 实现 Python 的 template.format(start=.., end=.., authorize_co_id=.., owner_co_id=..)
// 支持 {key} 与 {key:%Y%m%d…} 两种占位；未知 key 报错（调用方回退原始文件名）。
func jstFormatFilename(tpl string, start, end time.Time, authorizeCoID, ownerCoID string) (string, error) {
	var b strings.Builder
	runes := []rune(tpl)
	for i := 0; i < len(runes); i++ {
		if runes[i] != '{' {
			if runes[i] == '}' {
				return "", fmt.Errorf("Single '}' encountered in format string")
			}
			b.WriteRune(runes[i])
			continue
		}
		j := i + 1
		for j < len(runes) && runes[j] != '}' && runes[j] != '{' {
			j++
		}
		if j >= len(runes) || runes[j] != '}' {
			return "", fmt.Errorf("expected '}' before end of string")
		}
		field := string(runes[i+1 : j])
		key, fmtSpec := field, ""
		if k := strings.Index(field, ":"); k >= 0 {
			key, fmtSpec = field[:k], field[k+1:]
		}
		var val string
		switch key {
		case "":
			return "", fmt.Errorf("Empty attribute in format string")
		case "start":
			val = jstStrftime(start, fmtSpec)
		case "end":
			val = jstStrftime(end, fmtSpec)
		case "authorize_co_id":
			val = authorizeCoID
		case "owner_co_id":
			val = ownerCoID
		default:
			return "", fmt.Errorf("%s", key)
		}
		b.WriteString(val)
		i = j
	}
	return b.String(), nil
}

// jstStrftime 支持模板里可能用到的 strftime 指令（未识别的原样输出，与 Python 行为差异极小）。
func jstStrftime(t time.Time, spec string) string {
	if spec == "" {
		return t.Format("2006-01-02 15:04:05")
	}
	var b strings.Builder
	runes := []rune(spec)
	for i := 0; i < len(runes); i++ {
		if runes[i] != '%' || i+1 >= len(runes) {
			b.WriteRune(runes[i])
			continue
		}
		i++
		switch runes[i] {
		case 'Y':
			b.WriteString(t.Format("2006"))
		case 'y':
			b.WriteString(t.Format("06"))
		case 'm':
			b.WriteString(t.Format("01"))
		case 'd':
			b.WriteString(t.Format("02"))
		case 'H':
			b.WriteString(t.Format("15"))
		case 'M':
			b.WriteString(t.Format("04"))
		case 'S':
			b.WriteString(t.Format("05"))
		case '%':
			b.WriteRune('%')
		default:
			b.WriteRune('%')
			b.WriteRune(runes[i])
		}
	}
	return b.String()
}
