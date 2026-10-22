package api

// 自动出库（聚水潭销售出库单定时导出并导入）—— 与 Python backend/app/routers/jst_auto.py 逐接口对齐。
// 业务实现都在 internal/erp 的 jst_*.go 里（client / exporter / runner / settings），
// 本文件只做参数解析（Pydantic 模型口径）、状态码与文案的对齐。

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// registerJstAuto 由主控在 routes.go 里调用的一行注册：
//
//	s.registerJstAuto(s.rt)
//
// 依赖注入（配置文件路径、导出目录、分仓库连接、分仓显示名）与定时调度都在这里完成，
// 服务停机时请调用 StopJstAuto（见 Server.Close 或 main.go）。
func (s *Server) registerJstAuto(rt *router) {
	// 与 Python 共用同一批文件：json/jst_auto.json、data/jst_exports/<分仓 key>/
	erp.JstConfigPath = filepath.Join(s.Cfg.JSONDir(), "jst_auto.json")
	erp.JstDataDir = s.Cfg.DataDir()
	erp.JstOpenDB = func(key string) (*sql.DB, error) { return s.Mgr.DB(key) }
	erp.JstWarehouseName = s.JstWHLabel
	erp.JstSetDefaultKey(s.Mgr.Registry.DefaultKey())
	erp.JstStartScheduler()

	rt.Get("/api/jst-auto/settings", s.JstAutoSettings)
	rt.Post("/api/jst-auto/settings", s.JstAutoSaveSettings)
	rt.Post("/api/jst-auto/check", s.JstAutoCheck)
	rt.Post("/api/jst-auto/jst-warehouses", s.JstAutoJstWarehouses)
	rt.Post("/api/jst-auto/run", s.JstAutoRun)
	rt.Get("/api/jst-auto/status", s.JstAutoStatus)
	rt.Get("/api/jst-auto/history", s.JstAutoHistory)
	rt.Get("/api/jst-auto/pending", s.JstAutoPending)
	rt.Post("/api/jst-auto/pending/{task_id}/resolve", s.JstAutoPendingResolve)
	rt.Post("/api/jst-auto/pending/{task_id}/rematch", s.JstAutoPendingRematch)
	rt.Post("/api/jst-auto/pending/{task_id}/dismiss", s.JstAutoPendingDismiss)
}

// StartJstAutoScheduler 独立暴露给 main.go（registerJstAuto 已调用，重复调用无害）。
func (s *Server) StartJstAutoScheduler() { erp.JstStartScheduler() }

// StopJstAuto 服务停机时停掉调度协程（Python 的守护线程随进程退出）。
func (s *Server) StopJstAuto() { erp.JstStopScheduler() }

// JstWHLabel 分仓 key → 显示名（等价 Python _wh_name / _wh_label：name 为空或找不到都回 key）。
func (s *Server) JstWHLabel(key string) string {
	for _, w := range s.Mgr.Registry.List() {
		if w.Key == key {
			if strings.TrimSpace(w.Name) != "" {
				return w.Name
			}
			return key
		}
	}
	return key
}

// jstWHLabel 与 Python 的 next((w["name"] or key ...), key) 完全一致（不额外去空格）。
func (s *Server) jstWHLabel(key string) string {
	for _, w := range s.Mgr.Registry.List() {
		if w.Key == key {
			if w.Name != "" {
				return w.Name
			}
			return key
		}
	}
	return key
}

func (s *Server) jstAllWarehouses() []any {
	items := []any{}
	for _, w := range s.Mgr.Registry.List() {
		name := w.Name
		if name == "" {
			name = w.Key
		}
		items = append(items, map[string]any{"key": w.Key, "name": name})
	}
	return items
}

func jstAnyList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return []any{}
}

// ---------------- GET /api/jst-auto/settings ----------------

// JstAutoSettings 读设置：口令类只回「是否已设置」，另带回待办、下次执行时间与运行状态。
func (s *Server) JstAutoSettings(w http.ResponseWriter, r *http.Request) {
	key := web.Warehouse(r)
	d := erp.JstSettingsLoad()
	wh := erp.JstWhOf(d, key)
	name := s.jstWHLabel(key)
	pending := erp.JstPendingOpen(key)
	gv := erp.JstGlobalsView(d)
	globals := erp.JstPublicGlobals(d)
	globals["notify_webhook"] = jstViewStr(gv, "notify_webhook", "")
	globals["notify_users"] = jstAnyList(gv["notify_users"])

	web.Write(w, http.StatusOK, map[string]any{
		"globals":     globals,
		"warehouse":   jstMergeName(wh, key, name),
		"warehouse_key": key,
		"warehouse_name": name,
		"all_warehouses": s.jstAllWarehouses(),
		"windows":     jstWindowChoices(),
		"window_help": erp.JstWindowHelp,
		"next_runs":   erp.JstNextRunsWithJitter(key, wh, 3),
		"status":      erp.JstStatus(),
		"last_run":    jstOrEmptyMap(wh["last_run"]),
		"pending":     jstPendingBrief(pending),
		"pending_count": len(pending),
	})
}

func jstMergeName(wh map[string]any, key, name string) map[string]any {
	out := map[string]any{}
	for k, v := range wh {
		out[k] = v
	}
	out["key"] = key
	out["name"] = name
	return out
}

func jstViewStr(gv map[string]any, k, def string) string {
	if v, ok := gv[k]; ok && v != nil {
		if s, isStr := v.(string); isStr {
			return s
		}
	}
	return def
}

func jstOrEmptyMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok && len(m) > 0 {
		return m
	}
	return map[string]any{}
}

func jstWindowChoices() []any {
	out := []any{}
	for _, c := range erp.JstWindowChoices {
		out = append(out, map[string]any{"value": c[0], "label": c[1]})
	}
	return out
}

// pending 摘要（settings 里只回四个字段，取不到是 null，与 Python .get() 一致）
func jstPendingBrief(tasks []map[string]any) []any {
	out := []any{}
	for _, t := range tasks {
		out = append(out, map[string]any{
			"id": t["id"], "type": t["type"], "message": t["message"], "created_at": t["created_at"],
		})
	}
	return out
}

// ---------------- POST /api/jst-auto/settings ----------------

// JstAutoSaveSettings 保存设置：普通字段照原样保存（清空就是清空），口令类留空表示「不修改」，
// 想清掉 Cookie 要显式 clear_cookie（与 Python GlobalSettingsIn / WhSettingsIn 的 model_dump 口径一致）。
func (s *Server) JstAutoSaveSettings(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	key := web.Warehouse(r)

	if g, ok := jstSubModel(body, "globals"); ok {
		patch := map[string]any{
			"account":           jstStrField(g, "account"),
			"owner_co_id":       jstStrField(g, "owner_co_id"),
			"io_date_field":     jstStrField(g, "io_date_field"),
			"filename_template": jstStrField(g, "filename_template"),
			"min_interval":      jstOptNumField(g, "min_interval"),
			"timeout":           jstOptNumField(g, "timeout"),
			"max_retries":       jstOptNumField(g, "max_retries"),
		}
		if v := jstStrField(g, "password"); v != "" {
			patch["password"] = v
		}
		if v := jstStrField(g, "cookie"); v != "" {
			patch["cookie"] = v
		} else if jstBoolField(g, "clear_cookie") {
			patch["cookie"] = ""
		}
		patch["notify_webhook"] = jstStrField(g, "notify_webhook")
		if v, present := g["notify_users"]; present && v != nil {
			patch["notify_users"] = jstAnyList(v)
		}
		if _, err := erp.JstPatchGlobals(patch); err != nil {
			web.WriteValue(w, r, err)
			return
		}
	}
	if data, ok := jstSubModel(body, "warehouse"); ok {
		whIn := map[string]any{
			"enabled":       jstOptBoolField(data, "enabled"),
			"targets":       jstOptTargetsField(data, "targets"),
			"window":        jstStrField(data, "window"),
			"fixed_from":    jstStrField(data, "fixed_from"),
			"fixed_to":      jstStrField(data, "fixed_to"),
			"schedule":      jstOptStrListField(data, "schedule"),
			"jitter_minutes": jstOptNumField(data, "jitter_minutes"),
			"auto_import":   jstOptBoolField(data, "auto_import"),
			"skip_imported": jstOptBoolField(data, "skip_imported"),
			"operator":      jstStrField(data, "operator"),
		}
		// _validate_wh：定时时间与区间规则写错要立刻报错，而不是等定时到点才失败
		if err := jstValidateWH(whIn); err != nil {
			web.WriteValue(w, r, err)
			return
		}
		if _, err := erp.JstPatchWh(key, whIn); err != nil {
			web.WriteValue(w, r, err)
			return
		}
	}
	s.JstAutoSettings(w, r)
}

// jstSubModel 取嵌套模型：缺键或显式 null 都视为「没传」（Python 里 data.globals is None 分支）。
func jstSubModel(body map[string]any, k string) (map[string]any, bool) {
	v, ok := body[k]
	if !ok || v == nil {
		return nil, false
	}
	m, isMap := v.(map[string]any)
	if !isMap {
		return nil, false
	}
	return m, true
}

// jstStrField：str 字段，缺键/null 用默认值 ""；非字符串按 Python 的 str() 收（真实 Pydantic 会 422）。
func jstStrField(m map[string]any, k string) string {
	v, ok := m[k]
	if !ok || v == nil {
		return ""
	}
	if s, isStr := v.(string); isStr {
		return s
	}
	return web.ToStr(v)
}

// jstBoolField：bool 字段（默认 False）。
func jstBoolField(m map[string]any, k string) bool {
	v, ok := m[k]
	if !ok || v == nil {
		return false
	}
	if b, isBool := v.(bool); isBool {
		return b
	}
	if s, isStr := v.(string); isStr {
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "1", "true", "yes", "on":
			return true
		}
		return false
	}
	return web.ToFloat(v) != 0
}

// jstOptNumField：float|int|None，缺键/null → nil（表示不修改）。
func jstOptNumField(m map[string]any, k string) any {
	v, ok := m[k]
	if !ok || v == nil {
		return nil
	}
	if s, isStr := v.(string); isStr {
		s = strings.TrimSpace(s)
		if s == "" {
			return ""
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
		return nil // Pydantic 会 422，这里按「不修改」降级
	}
	return v
}

// jstOptBoolField：bool|None，缺键/null → nil。
func jstOptBoolField(m map[string]any, k string) any {
	v, ok := m[k]
	if !ok || v == nil {
		return nil
	}
	return jstBoolField(m, k)
}

// jstOptStrListField：list[str]|None，缺键/null → nil。
func jstOptStrListField(m map[string]any, k string) any {
	v, ok := m[k]
	if !ok || v == nil {
		return nil
	}
	items := jstAnyList(v)
	out := make([]any, 0, len(items))
	for _, it := range items {
		if s, isStr := it.(string); isStr {
			out = append(out, s)
			continue
		}
		if it == nil {
			out = append(out, "")
			continue
		}
		out = append(out, web.ToStr(it))
	}
	return out
}

// jstOptTargetsField：list[TargetIn]|None → [{"co_id":..,"name":..}]（name 默认 ""）。
func jstOptTargetsField(m map[string]any, k string) any {
	v, ok := m[k]
	if !ok || v == nil {
		return nil
	}
	items := jstAnyList(v)
	out := make([]any, 0, len(items))
	for _, it := range items {
		t, isMap := it.(map[string]any)
		if !isMap {
			t = map[string]any{}
		}
		out = append(out, map[string]any{"co_id": jstStrField(t, "co_id"), "name": jstStrField(t, "name")})
	}
	return out
}

// jstValidateWH 对齐 _validate_wh：定时 → 区间规则 → 固定区间（成对、可解析、开始早于结束）。
func jstValidateWH(in map[string]any) error {
	if list := jstAnyList(in["schedule"]); len(list) > 0 {
		if _, err := erp.JstParseSchedule(list); err != nil {
			return web.Abort(http.StatusBadRequest, "%s", err.Error())
		}
	}
	if win := web.ToStr(in["window"]); win != "" {
		if _, _, err := erp.JstResolveWindow(win, time.Now()); err != nil {
			return web.Abort(http.StatusBadRequest, "%s", err.Error())
		}
	}
	from := web.ToStr(in["fixed_from"])
	to := web.ToStr(in["fixed_to"])
	if from != "" || to != "" {
		if !(from != "" && to != "") {
			return web.Abort(http.StatusBadRequest, "固定区间必须同时填写开始与结束时间（留空则用区间规则）")
		}
		start, err := erp.JstParseDatetime(from)
		if err != nil {
			return web.Abort(http.StatusBadRequest, "%s", err.Error())
		}
		end, err := erp.JstParseDatetime(to)
		if err != nil {
			return web.Abort(http.StatusBadRequest, "%s", err.Error())
		}
		if !start.Before(end) {
			return web.Abort(http.StatusBadRequest, "固定区间的开始时间必须早于结束时间")
		}
	}
	return nil
}

// ---------------- POST /check、POST /jst-warehouses ----------------

// JstAutoCheck 检查聚水潭登录态。
func (s *Server) JstAutoCheck(w http.ResponseWriter, r *http.Request) {
	web.Write(w, http.StatusOK, erp.JstCheckLogin())
}

// JstAutoJstWarehouses 拉取聚水潭分仓列表（供勾选）。
func (s *Server) JstAutoJstWarehouses(w http.ResponseWriter, r *http.Request) {
	web.Write(w, http.StatusOK, erp.JstFetchWarehouses())
}

// ---------------- POST /run ----------------

// JstAutoRun 立即执行一次（后台跑；/status 看进度，/history 看结果）。
func (s *Server) JstAutoRun(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	key := web.Warehouse(r)
	state := erp.JstStatus()
	if jstTruthy(state["running"]) {
		web.Error(w, http.StatusConflict, "已有一轮在执行中（%s · %s），请等它结束",
			jstStateText(state["warehouse"]), jstStateText(state["step"]))
		return
	}

	data := jstRunIn{
		Targets:  jstOptStrListField(body, "targets"),
		Window:   jstStrField(body, "window"),
		Start:    jstStrField(body, "start"),
		End:      jstStrField(body, "end"),
		DoImport: jstOptBoolField(body, "do_import"),
	}
	start, end, err := data.ParseRange()
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}

	wh := erp.JstWhOf(erp.JstSettingsLoad(), key)
	if len(jstAnyList(wh["targets"])) == 0 && len(data.coIDs()) == 0 {
		web.Error(w, http.StatusBadRequest, "请先在「自动出库设置」里勾选要导入的聚水潭分仓")
		return
	}

	in := erp.JstRunIn{Key: key, TargetCoIDs: data.coIDs(), Window: data.Window,
		Start: start, End: end, Trigger: "手动·" + Operator(r), DoImport: data.DoImportPtr()}
	go erp.JstRunOnce(in)
	web.Write(w, http.StatusOK, map[string]any{
		"ok": true, "started": true, "warehouse": key, "message": "已开始执行，可点「刷新状态」查看进度",
	})
}

// jstRunIn 对应 Python RunIn（targets 可为 null / window / start / end / do_import 三态）。
type jstRunIn struct {
	Targets  any
	Window   string
	Start    string
	End      string
	DoImport any
}

func (in jstRunIn) coIDs() []string {
	if in.Targets == nil {
		return nil
	}
	out := []string{}
	for _, v := range jstAnyList(in.Targets) {
		out = append(out, web.ToStr(v))
	}
	return out
}

func (in jstRunIn) DoImportPtr() *bool {
	if in.DoImport == nil {
		return nil
	}
	b := jstTruthy(in.DoImport)
	return &b
}

// ParseRange 固定区间优先（start+end 都填），否则校验 window 规则；与 Python run_once 的入参校验一致。
func (in jstRunIn) ParseRange() (*time.Time, *time.Time, error) {
	if in.Start != "" && in.End != "" {
		start, err := erp.JstParseDatetime(in.Start)
		if err != nil {
			return nil, nil, web.Abort(http.StatusBadRequest, "%s", err.Error())
		}
		end, err := erp.JstParseDatetime(in.End)
		if err != nil {
			return nil, nil, web.Abort(http.StatusBadRequest, "%s", err.Error())
		}
		if !start.Before(end) {
			return nil, nil, web.Abort(http.StatusBadRequest, "开始时间必须早于结束时间")
		}
		return &start, &end, nil
	}
	if in.Window != "" {
		if _, _, err := erp.JstResolveWindow(in.Window, time.Now()); err != nil {
			return nil, nil, web.Abort(http.StatusBadRequest, "%s", err.Error())
		}
	}
	return nil, nil, nil
}

func jstStateText(v any) string {
	if v == nil {
		return ""
	}
	return web.ToStr(v)
}

// ---------------- GET /status、GET /history ----------------

// JstAutoStatus 当前执行状态 / 最近一次结果。
func (s *Server) JstAutoStatus(w http.ResponseWriter, r *http.Request) {
	web.Write(w, http.StatusOK, erp.JstStatus())
}

// JstAutoHistory 最近执行记录（limit 夹到 1~50）。
func (s *Server) JstAutoHistory(w http.ResponseWriter, r *http.Request) {
	limit, ok := jstQueryIntParam(w, r, "limit", 20)
	if !ok {
		return
	}
	key := web.Warehouse(r)
	runs := jstAnyList(erp.JstWhOf(erp.JstSettingsLoad(), key)["runs"])
	n := limit
	if n < 1 {
		n = 1
	}
	if n > 50 {
		n = 50
	}
	if n > len(runs) {
		n = len(runs)
	}
	out := make([]any, 0, n)
	out = append(out, runs[:n]...)
	web.Write(w, http.StatusOK, map[string]any{"runs": out})
}

// jstQueryIntParam 与 FastAPI 的 int 查询参数一致：值无法解析时回 422（detail 是校验错误数组）。
func jstQueryIntParam(w http.ResponseWriter, r *http.Request, name string, def int) (int, bool) {
	vals, present := r.URL.Query()[name]
	raw := ""
	if present {
		raw = vals[0]
	}
	if !present {
		return def, true
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || !isPlainInt(strings.TrimSpace(raw)) {
		web.Write(w, http.StatusUnprocessableEntity, map[string]any{"detail": []any{map[string]any{
			"type": "int_parsing", "loc": []any{"query", name},
			"msg":   "Input should be a valid integer, unable to parse string as an integer",
			"input": raw,
		}}})
		return def, false
	}
	return n, true
}

func isPlainInt(s string) bool {
	if s == "" {
		return false
	}
	i := 0
	if s[0] == '+' || s[0] == '-' {
		i++
	}
	if i >= len(s) {
		return false
	}
	for ; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// ---------------- GET /pending ----------------

// JstAutoPending 当前分仓待办（站内通知靠它：登录后拉一次，命中提醒名单就弹窗）。
func (s *Server) JstAutoPending(w http.ResponseWriter, r *http.Request) {
	key := web.Warehouse(r)
	g := erp.JstGlobalsView(erp.JstSettingsLoad())
	tasks := erp.JstPendingOpen(key)
	users := []any{}
	for _, x := range jstAnyList(g["notify_users"]) {
		if jstTruthy(x) {
			users = append(users, x)
		}
	}
	notify := jstUserInNames(MustUser(r), users)
	if len(users) == 0 {
		u := MustUser(r)
		notify = u != nil && u.Role == "admin"
	}
	items := []any{}
	for _, t := range tasks {
		items = append(items, erp.JstPublicTask(t))
	}
	web.Write(w, http.StatusOK, map[string]any{
		"warehouse":      key,
		"warehouse_name": s.jstWHLabel(key),
		"count":          len(tasks),
		"tasks":          items,
		"notify":         notify,
		"notify_users":   users,
		"notify_webhook": jstOrEmptyStr(g["notify_webhook"]),
		"running":        jstTruthy(erp.JstStatus()["running"]),
	})
}

func jstOrEmptyStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return web.ToStr(v)
}

func jstUserInNames(u *erp.User, names []any) bool {
	if u == nil {
		return false
	}
	for _, n := range names {
		if jstOrEmptyStr(n) == u.Name {
			return true
		}
	}
	return false
}

// jstTruthy 等价 Python 的真值判断（None/0/""/false 为假）。
func jstTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case int:
		return x != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

// ---------------- POST /pending/{task_id}/resolve ----------------

// JstAutoPendingResolve 完成一条待办：保存商品关联 / 记录验证码或 Cookie，然后自动重跑。
func (s *Server) JstAutoPendingResolve(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	key := web.Warehouse(r)
	taskID := PathValue(r, "task_id")
	found := false
	for _, t := range erp.JstPendingOpen(key) {
		if t["id"] == taskID {
			found = true
		}
	}
	if !found {
		web.Error(w, http.StatusNotFound, "待办不存在或已被处理")
		return
	}
	mappings := jstMappingItems(body["mappings"])
	verifyCode := jstStrField(body, "verify_code")
	cookie := jstStrField(body, "cookie")
	if len(mappings) == 0 && verifyCode == "" && cookie == "" {
		web.Error(w, http.StatusBadRequest, "没有可提交的内容：请至少选择商品关联，或填写验证码 / Cookie")
		return
	}
	state := erp.JstStatus()
	if jstTruthy(state["running"]) {
		web.Error(w, http.StatusConflict, "已有一轮在执行中（%s · %s），等它结束后再提交",
			jstStateText(state["warehouse"]), jstStateText(state["step"]))
		return
	}
	user := MustUser(r)
	name := ""
	if user != nil {
		name = user.Name
	}
	in := erp.JstResolvePendingIn{Mappings: mappings, VerifyCode: verifyCode, Cookie: cookie, UserName: name}
	// 后台线程里跑重跑流程（失败只记日志，避免异常被吞掉）
	go jstRunResolve(key, taskID, in)
	web.Write(w, http.StatusOK, map[string]any{
		"ok": true, "started": true, "message": "已提交，正在自动重跑（可点「刷新状态」看进度）",
	})
}

// jstMappingItems 对应 list[MappingItemIn]：external_code 必填字符串，product_id 可空。
func jstMappingItems(v any) []map[string]any {
	out := []map[string]any{}
	for _, it := range jstAnyList(v) {
		m, isMap := it.(map[string]any)
		if !isMap {
			m = map[string]any{}
		}
		item := map[string]any{"external_code": jstStrField(m, "external_code")}
		if pv, ok := m["product_id"]; !ok || pv == nil {
			item["product_id"] = nil
		} else if f, isNum := pv.(float64); isNum {
			item["product_id"] = int(f)
		} else if n, isInt := pv.(json.Number); isInt {
			i, _ := n.Int64()
			item["product_id"] = int(i)
		} else {
			item["product_id"] = web.ToInt(pv)
		}
		out = append(out, item)
	}
	return out
}

func jstRunResolve(key, taskID string, in erp.JstResolvePendingIn) {
	res, err := erp.JstResolvePending(context.Background(), key, taskID, in)
	if err != nil {
		log.Printf("[自动出库] 待办 %s 处理失败：%s", taskID, err)
		return
	}
	log.Printf("[自动出库] 待办 %s 处理完成：%s", taskID, jstOrEmptyStr(res["message"]))
}

// ---------------- POST /pending/{task_id}/rematch ----------------

// JstAutoPendingRematch 重新完全匹配：只认与系统商品名称/编码 100% 相同的待补全商品。
func (s *Server) JstAutoPendingRematch(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	key := web.Warehouse(r)
	taskID := PathValue(r, "task_id")
	var task map[string]any
	for _, t := range erp.JstPendingOpen(key) {
		if t["id"] == taskID {
			task = t
		}
	}
	if task == nil {
		web.Error(w, http.StatusNotFound, "待办不存在或已被处理")
		return
	}
	if task["type"] != "unmapped" {
		web.Error(w, http.StatusBadRequest, "只有「商品资料待补全」的待办能重新匹配")
		return
	}
	dryRun := jstBoolField(body, "dry_run")
	onlyCodes := jstOptStrListField(body, "only_codes")
	var only []string
	if list := jstAnyList(onlyCodes); len(list) > 0 {
		only = []string{}
		for _, v := range list {
			only = append(only, web.ToStr(v))
		}
	}
	matched, left, err := erp.JstExactRematch(context.Background(), key, jstMapList(task["items"]), only)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	msg := fmt.Sprintf("按 100%% 同名匹配到 %d 种，还有 %d 种没匹配到（需人工选择）", len(matched), len(left))
	if len(matched) == 0 {
		msg = fmt.Sprintf("没有名称/编码完全一致的商品（%d 种待人工选择）", len(left))
	}
	if len(matched) == 0 || dryRun {
		web.Write(w, http.StatusOK, map[string]any{
			"ok": true, "started": false, "dry_run": dryRun,
			"matched": jstAnyListFromMaps(matched), "left": jstAnyListFromMaps(left), "message": msg,
		})
		return
	}
	state := erp.JstStatus()
	if jstTruthy(state["running"]) {
		web.Error(w, http.StatusConflict, "已有一轮在执行中（%s · %s），等它结束后再试",
			jstStateText(state["warehouse"]), jstStateText(state["step"]))
		return
	}
	user := MustUser(r)
	name := ""
	if user != nil {
		name = user.Name
	}
	go jstRunResolve(key, taskID, erp.JstResolvePendingIn{Mappings: matched, UserName: name})
	web.Write(w, http.StatusOK, map[string]any{
		"ok": true, "started": true, "dry_run": false,
		"matched": jstAnyListFromMaps(matched), "left": jstAnyListFromMaps(left),
		"message": msg + "；已开始重新导入出库",
	})
}

func jstMapList(v any) []map[string]any {
	out := []map[string]any{}
	for _, it := range jstAnyList(v) {
		if m, isMap := it.(map[string]any); isMap {
			out = append(out, m)
		}
	}
	return out
}

func jstAnyListFromMaps(items []map[string]any) []any {
	out := make([]any, 0, len(items))
	for _, m := range items {
		out = append(out, m)
	}
	return out
}

// ---------------- POST /pending/{task_id}/dismiss ----------------

// JstAutoPendingDismiss 忽略一条待办（不再提醒，不影响已导入的数据）。
func (s *Server) JstAutoPendingDismiss(w http.ResponseWriter, r *http.Request) {
	key := web.Warehouse(r)
	taskID := PathValue(r, "task_id")
	t, err := erp.JstClosePending(key, taskID, "dismissed", fmt.Sprintf("由 %s 忽略", Operator(r)))
	if err != nil {
		web.Error(w, http.StatusInternalServerError, "待办状态写入失败：%s", err.Error())
		return
	}
	if t == nil {
		web.Error(w, http.StatusNotFound, "待办不存在")
		return
	}
	web.Write(w, http.StatusOK, map[string]any{"ok": true, "task": erp.JstPublicTask(t)})
}
