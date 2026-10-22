package erp

// 本文件对齐 Python backend/app/jst/runner.py：导出 → 落盘 → 复用导入链路建出库单 → 记执行历史，
// 含定时调度（每 20 秒检查一次到点的分仓）。运行状态放 jstState 供 /status 轮询。

import (
	"context"
	"crypto/md5"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// JstDataDir / JstExportDirName：导出件落盘位置 <backend>/data/jst_exports/<分仓 key>/。
var (
	JstDataDir        = ""
	jstExportDirName  = "jst_exports"
	jstExportDirCache sync.Map
)

// JstOpenDB 按分仓 key 拿业务库连接（由 api 层注入 database.Manager）。
var JstOpenDB func(key string) (*sql.DB, error)

// JstWarehouseName 分仓 key → 显示名（等价 Python _wh_name / _wh_label）。
var JstWarehouseName func(key string) string

// JstImportFunc 由「聚水潭导入」模块注册：把一个已下载的 xlsx 导入指定分仓并建出库单。
// 未注册时自动出库的「导入」环节会跳过并记录原因（导出环节不受影响）。
var JstImportFunc func(key, path, operator string, skipImported bool) (map[string]any, error)

// jstState 全局运行状态（同一时间只允许一轮自动出库）。
var (
	jstStateMu sync.Mutex
	jstState   = map[string]any{
		"running": false, "warehouse": "", "trigger": "", "step": "", "started_at": "",
		"last": map[string]any{},
	}
	jstJobLock   sync.Mutex
	jstJobBusy   bool
	jstJobMu     sync.Mutex
	jstSchedMu   sync.Mutex
	jstSchedRun  bool
	jstSchedStop chan struct{}
)

// 调度周期：Python 每 20 秒 tick 一次。
const jstTickEvery = 20 * time.Second

func jstSetState(kw map[string]any) {
	jstStateMu.Lock()
	defer jstStateMu.Unlock()
	for k, v := range kw {
		jstState[k] = v
	}
}

// JstStatus 当前执行状态（含调度线程是否存活），键序与 Python status() 一致。
func JstStatus() map[string]any {
	jstStateMu.Lock()
	out := map[string]any{}
	for k, v := range jstState {
		out[k] = v
	}
	jstStateMu.Unlock()
	out["scheduler"] = JstSchedulerAlive()
	return out
}

func jstUpdateLast(patch map[string]any) {
	jstStateMu.Lock()
	jstState["last"] = patch
	jstStateMu.Unlock()
}

// JstSchedulerAlive 调度是否在工作（设置页显示「定时调度：运行中/未启动」）。
func JstSchedulerAlive() bool {
	jstSchedMu.Lock()
	defer jstSchedMu.Unlock()
	return jstSchedRun
}

// JstStartScheduler 启动定时调度（幂等）。stop 关闭时退出，保证服务能优雅停机。
func JstStartScheduler() {
	jstSchedMu.Lock()
	if jstSchedRun {
		jstSchedMu.Unlock()
		return
	}
	jstSchedRun = true
	jstSchedStop = make(chan struct{})
	stop := jstSchedStop
	jstSchedMu.Unlock()
	jstLogf("定时调度已启动（每 %d 秒检查一次）", int(jstTickEvery/time.Second))
	go jstSchedLoop(stop)
}

// JstStopScheduler 停止调度线程（服务 Close 时调用）。
func JstStopScheduler() {
	jstSchedMu.Lock()
	if jstSchedRun && jstSchedStop != nil {
		close(jstSchedStop)
	}
	jstSchedRun = false
	jstSchedStop = nil
	jstSchedMu.Unlock()
}

func jstSchedLoop(stop chan struct{}) {
	for {
		jstTick(time.Now())
		select {
		case <-stop:
			return
		case <-time.After(jstTickEvery):
		}
	}
}

// JstRunOnceInFlight 是否已有一轮在跑（handler 用来出 409）。
func JstRunOnceInFlight() map[string]any { return JstStatus() }

// ---- 配置组装 ----

// jstBuildConfig 组装一次导出所需的全部参数。
func jstBuildConfig(key, targetCoID, outDir string) *JstConfig {
	d := JstSettingsLoad()
	g := JstGlobalsOf(d)
	wh := JstWhOf(d, key)
	start, end, ok := jstFixedRange(wh)
	cfg := &JstConfig{
		Cookie: jstPyStr(orAny(g["cookie"], "")),
		Account: jstPyStr(orAny(g["account"], "")),
		Password: jstPyStr(orAny(g["password"], "")),
		OwnerCoID: jstPyStr(orAny(g["owner_co_id"], "")),
		AuthorizeCoID: targetCoID,
		OutputDir: outDir,
		Window:      orStr(jstPyStr(orAny(wh["window"], "")), "yesterday"),
		IODateField: orStr(jstPyStr(orAny(g["io_date_field"], "")), "io_date"),
		MinInterval: jstFloatOr(g["min_interval"], 10),
		Timeout:     jstFloatOr(g["timeout"], 120),
		MaxRetries:  int(jstFloatOr(g["max_retries"], 3)),
		Flag:        0,
		Schedule:    jstSafeSchedule(wh["schedule"]),
		FilenameTemplate: orStr(jstPyStr(orAny(g["filename_template"], "")),
			"销售出库单_{start:%Y%m%d}_{authorize_co_id}.xlsx"),
		VerifyCode: JstPendingVerifyCode(key),
	}
	if ok {
		cfg.FixedRange = []time.Time{start, end}
	}
	return cfg
}

func orAny(v any, def any) any {
	if v == nil {
		return def
	}
	return v
}

func jstFloatOr(v any, def float64) float64 {
	if f, ok := jstPyFloat(v); ok {
		return f
	}
	return def
}

func jstSafeSchedule(slots any) []JstSchedule {
	parsed, err := JstParseSchedule(slots)
	if err != nil {
		jstLogf("定时时间配置有问题，本次忽略：%s", err)
		return []JstSchedule{}
	}
	return parsed
}

// jstFixedRange 固定区间（补数据用）：两个都填才生效。
func jstFixedRange(wh map[string]any) (time.Time, time.Time, bool) {
	rawFrom := strings.TrimSpace(jstPyStr(orAny(wh["fixed_from"], "")))
	rawTo := strings.TrimSpace(jstPyStr(orAny(wh["fixed_to"], "")))
	if rawFrom == "" || rawTo == "" {
		return time.Time{}, time.Time{}, false
	}
	start, err1 := JstParseDatetime(rawFrom)
	end, err2 := JstParseDatetime(rawTo)
	if err1 != nil || err2 != nil {
		// Python 在这里不兜底（配置页保存时已校验过）；脏数据按「不生效」处理，避免让接口 500
		return time.Time{}, time.Time{}, false
	}
	if !start.Before(end) {
		return time.Time{}, time.Time{}, false
	}
	return start, end, true
}

// JstResolveRange 本次导出的时间区间：固定区间优先，其次指定规则，最后分仓默认规则。
func JstResolveRange(wh map[string]any, window string, now time.Time) (time.Time, time.Time, error) {
	if s, e, ok := jstFixedRange(wh); ok {
		return s, e, nil
	}
	return JstResolveWindow(orStr(window, orStr(jstPyStr(orAny(wh["window"], "")), "yesterday")), now)
}

// JstExportDir 导出件目录（backend/data/jst_exports/<分仓 key>/）。
func JstExportDir(key string) string {
	if v, ok := jstExportDirCache.Load(key); ok {
		return v.(string)
	}
	p := joinPath(JstDataDir, jstExportDirName, key)
	jstExportDirCache.Store(key, p)
	return p
}

// ---- 登录态 / 分仓 ----

// JstCheckLogin 检查聚水潭登录态（Cookie 有效则 ok）。
func JstCheckLogin() map[string]any {
	d := JstSettingsLoad()
	g := JstGlobalsOf(d)
	cookie := jstPyStr(orAny(g["cookie"], ""))
	account := jstPyStr(orAny(g["account"], ""))
	password := jstPyStr(orAny(g["password"], ""))
	if cookie == "" && !(account != "" && password != "") {
		return map[string]any{"ok": false, "message": "还没配置聚水潭账号密码或 Cookie"}
	}
	session, err := NewJstSession(cookie, jstFloatOr(g["min_interval"], 10), jstFloatOr(g["timeout"], 120),
		jstReloginFor(g))
	if err != nil {
		return map[string]any{"ok": false, "message": fmt.Sprintf("检查失败：%s", err)}
	}
	defer session.Close()
	resp, err := session.Get(JstSaleoutURL, nil, nil, false)
	if err != nil {
		return map[string]any{"ok": false, "message": fmt.Sprintf("检查失败：%s", err)}
	}
	if err := JstEnsureLoggedIn(resp, false); err != nil {
		var nl *JstNotLoggedIn
		if errors.As(err, &nl) {
			return map[string]any{"ok": false, "message": nl.Msg}
		}
		return map[string]any{"ok": false, "message": fmt.Sprintf("检查失败：%s", err)}
	}
	return map[string]any{
		"ok": true, "message": "登录态正常，可以正常导出销售出库单",
		"cookie_refreshed": session.Cookie() != cookie,
	}
}

// JstFetchWarehouses 拉取聚水潭账号可见的分仓列表（供设置里勾选）。
func JstFetchWarehouses() map[string]any {
	d := JstSettingsLoad()
	g := JstGlobalsOf(d)
	session, err := NewJstSession(jstPyStr(orAny(g["cookie"], "")), jstFloatOr(g["min_interval"], 10),
		jstFloatOr(g["timeout"], 120), jstReloginFor(g))
	if err != nil {
		return map[string]any{"ok": false, "message": fmt.Sprintf("拉取失败：%s", err)}
	}
	defer session.Close()
	resp, err := session.Get(JstSaleoutURL, nil, nil, false)
	if err != nil {
		return map[string]any{"ok": false, "message": fmt.Sprintf("拉取失败：%s", err)}
	}
	if err := JstEnsureLoggedIn(resp, false); err != nil {
		var nl *JstNotLoggedIn
		var le *JstLoginError
		if errors.As(err, &nl) {
			return map[string]any{"ok": false, "message": nl.Msg}
		}
		_ = le
		return map[string]any{"ok": false, "message": fmt.Sprintf("拉取失败：%s", err)}
	}
	if err := resp.RaiseForStatus(); err != nil {
		return map[string]any{"ok": false, "message": fmt.Sprintf("拉取失败：%s", err)}
	}
	items := JstParseWarehouses(resp.Text())
	list := make([]any, 0, len(items))
	for _, w := range items {
		list = append(list, map[string]any{"co_id": w.CoID, "name": w.Name})
	}
	return map[string]any{"ok": true, "warehouses": list}
}

// jstReloginFor 构造续登回调：成功后把新 Cookie 写回设置。
func jstReloginFor(g map[string]any) func() (string, error) {
	account := jstPyStr(orAny(g["account"], ""))
	password := jstPyStr(orAny(g["password"], ""))
	if account == "" || password == "" {
		return nil
	}
	key := jstCurrentKey()
	base := JstBuildRelogin(account, password, jstPyStr(orAny(g["cookie"], "")),
		jstFloatOr(g["timeout"], 120), JstPendingVerifyCode(key))
	if base == nil {
		return nil
	}
	return func() (string, error) {
		cookie, err := base()
		if err != nil {
			return "", err
		}
		if err := JstSetCookie(cookie); err != nil {
			return "", err
		}
		return cookie, nil
	}
}

// jstCurrentKey 后台线程没有请求上下文，用「调度默认分仓」兜底（Python 用 get_current_key()）。
var jstCurrentKeyHolder = struct {
	mu  sync.Mutex
	key string
}{key: ""}

// JstSetDefaultKey 注入默认分仓 key（后台续登时取验证码用）。
func JstSetDefaultKey(key string) {
	jstCurrentKeyHolder.mu.Lock()
	jstCurrentKeyHolder.key = key
	jstCurrentKeyHolder.mu.Unlock()
}

func jstCurrentKey() string {
	jstCurrentKeyHolder.mu.Lock()
	defer jstCurrentKeyHolder.mu.Unlock()
	return jstCurrentKeyHolder.key
}

// ---- 执行记录文案 ----

// jstWindowText 区间展示串：2026-10-12 00:00 ~ 2026-10-13 00:00。
func jstWindowText(start, end time.Time) string {
	return fmt.Sprintf("%s ~ %s", start.Format("2006-01-02 15:04"), end.Format("2006-01-02 15:04"))
}

// jstRangeISO 待办里存档的区间（[start, end]，秒精度）。
func jstRangeISO(rng []time.Time) []any {
	if len(rng) != 2 {
		return []any{}
	}
	return []any{rng[0].Format("2006-01-02 15:04:05"), rng[1].Format("2006-01-02 15:04:05")}
}

func jstPendingID(kind string) string {
	return fmt.Sprintf("pt-%s-%s", kind, time.Now().Format("20060102150405"))
}

func jstTaskBase(key, kind, message string, files []string, rng []time.Time, targets []map[string]any) map[string]any {
	tgts := []any{}
	for _, t := range targets {
		tgts = append(tgts, map[string]any{"co_id": jstPyStr(orAny(t["co_id"], "")), "name": jstPyStr(orAny(t["name"], ""))})
	}
	return map[string]any{
		"id": jstPendingID(kind), "type": kind, "message": message,
		"files": strList(files), "file_paths": strList(files),
		"window": jstWindowOrZero(rng), "range": jstRangeISO(rng),
		"targets": tgts, "items": []any{}, "status": "open",
	}
}

func jstWindowOrZero(rng []time.Time) string {
	if len(rng) == 2 {
		return jstWindowText(rng[0], rng[1])
	}
	return ""
}

func strList(in []string) []any {
	out := make([]any, 0, len(in))
	for _, s := range in {
		out = append(out, s)
	}
	return out
}

// ---- 主流程 ----

// JstRunIn 立即执行一次的参数（对应 Python run_once 的关键字参数）。
type JstRunIn struct {
	Key         string
	TargetCoIDs []string
	Window      string
	Start       *time.Time
	End         *time.Time
	Trigger     string
	DoImport    *bool
}

// JstRunOnce 跑一轮：导出所有勾选的聚水潭分仓 →（可选）导入当前 ERP 分仓。
// DoImport=nil 表示按分仓设置里的 auto_import；false 时只下载不建单（试跑）。
func JstRunOnce(in JstRunIn) map[string]any {
	if !jstTryLock() {
		return map[string]any{"ok": false, "message": "已有一轮自动出库在跑，请稍后再试"}
	}
	defer jstUnlock()

	started := time.Now()
	startedText := started.Format("2006-01-02 15:04:05")
	jstSetState(map[string]any{"running": true, "warehouse": in.Key, "trigger": in.Trigger,
		"step": "准备中", "started_at": startedText})
	result := map[string]any{
		"at": startedText, "trigger": in.Trigger, "ok": false, "warehouse": in.Key,
		"warehouse_name": jstWhName(in.Key), "targets": []any{}, "files": []any{},
		"message": "", "stats": map[string]any{},
	}

	var rng []time.Time
	var files []string
	targets := []map[string]any{}
	wh := map[string]any{}

	run := func() error {
		d := JstSettingsLoad()
		wh = JstWhOf(d, in.Key)
		for _, t := range jstMapSlice(wh["targets"]) {
			targets = append(targets, t)
		}
		if len(in.TargetCoIDs) > 0 {
			wanted := map[string]bool{}
			for _, c := range in.TargetCoIDs {
				wanted[c] = true
			}
			var picked []map[string]any
			for _, t := range targets {
				if wanted[jstPyStr(orAny(t["co_id"], ""))] {
					picked = append(picked, t)
				}
			}
			if len(picked) > 0 {
				targets = picked
			} else {
				targets = nil
				for _, c := range in.TargetCoIDs {
					targets = append(targets, map[string]any{"co_id": c, "name": ""})
				}
			}
		}
		if len(targets) == 0 {
			return errors.New("这个分仓还没勾选要导入的聚水潭分仓，请先在「自动出库设置」里设置")
		}

		if in.Start != nil && in.End != nil {
			rng = []time.Time{*in.Start, *in.End}
		} else {
			s, e, err := JstResolveRange(wh, in.Window, time.Now())
			if err != nil {
				return err
			}
			rng = []time.Time{s, e}
		}
		result["window"] = jstWindowText(rng[0], rng[1])

		outDir := JstExportDir(in.Key)
		for _, t := range targets {
			coID := jstPyStr(orAny(t["co_id"], ""))
			name := orStr(jstPyStr(orAny(t["name"], "")), coID)
			jstSetState(map[string]any{"step": fmt.Sprintf("正在导出聚水潭分仓「%s」…", name)})
			cfg := jstBuildConfig(in.Key, coID, outDir)
			exporter, err := NewJstExporter(cfg, func(c string) { _ = JstSetCookie(c) })
			if err != nil {
				return err
			}
			p, err := exporter.ExportWithRetries(rng[0], rng[1])
			exporter.Close()
			if err != nil {
				return err
			}
			files = append(files, p)
			result["targets"] = append(jstAnyList(result["targets"]), map[string]any{
				"co_id": coID, "name": name, "file": baseName(p),
			})
		}
		names := make([]string, 0, len(files))
		for _, f := range files {
			names = append(names, baseName(f))
		}
		result["files"] = strList(names)

		shouldImport := jstTruthy(orAny(wh["auto_import"], true), true)
		if in.DoImport != nil {
			shouldImport = *in.DoImport
		}
		if !shouldImport {
			result["ok"] = true
			result["message"] = fmt.Sprintf("已导出 %d 个文件（按设置未自动导入）", len(files))
			return nil
		}

		agg := jstNewAgg()
		unmappedSet := map[string]bool{}
		statusSkipped := map[string]int{}
		detail := map[string]map[string]any{}
		for _, f := range files {
			jstSetState(map[string]any{"step": fmt.Sprintf("正在导入 %s …", baseName(f))})
			stt, err := jstImportFile(in.Key, f, jstPyStr(orAny(wh["operator"], "")),
				jstTruthy(orAny(wh["skip_imported"], true), true))
			if err != nil {
				return err
			}
			agg["orders"] = agg["orders"].(int) + jstIntOf(stt["orders"])
			agg["created"] = agg["created"].(int) + jstIntOf(stt["created"])
			agg["duplicate_skipped"] = agg["duplicate_skipped"].(int) + jstIntOf(stt["duplicate_skipped"])
			agg["failed"] = append(agg["failed"].([]any), jstAnySlice(stt["failed"])...)
			for _, u := range jstAnySlice(stt["unmapped"]) {
				unmappedSet[jstPyStr(u)] = true
			}
			for _, it := range jstMapSlice(stt["unmapped_detail"]) {
				code := jstPyStr(orAny(it["external_code"], ""))
				if code == "" {
					continue
				}
				cur, ok := detail[code]
				if !ok {
					cp := map[string]any{}
					for k, v := range it {
						cp[k] = v
					}
					detail[code] = cp
				} else {
					cur["count"] = jstIntOf(cur["count"]) + jstIntOf(it["count"])
				}
			}
			for k, v := range jstIntMap(stt["status_skipped"]) {
				statusSkipped[k] += v
			}
		}
		agg["unmapped"] = sortedKeys(unmappedSet)
		agg["unmapped_detail"] = sortedByCountDesc(detail)
		agg["status_skipped"] = statusSkipped
		result["stats"] = agg
		result["ok"] = true

		var soft, hard []map[string]any
		for _, f := range jstMapSlice(agg["failed"]) {
			if jstPyStr(orAny(f["level"], "")) == "warn" {
				soft = append(soft, f)
			} else {
				hard = append(hard, f)
			}
		}
		voidN := statusSkipped["作废"]
		softReasons := map[string]int{}
		for _, f := range soft {
			k := strings.TrimSpace(jstPyStr(orAny(f["reason"], "")))
			softReasons[k]++
		}
		softTop := ""
		if len(softReasons) > 0 {
			type kv struct {
				k string
				v int
			}
			list := make([]kv, 0, len(softReasons))
			for k, v := range softReasons {
				list = append(list, kv{k, v})
			}
			// max(...)：取计数最大的键；并列时 Python 取首个插入的，这里用字典序保证稳定
			sort.SliceStable(list, func(i, j int) bool {
				if list[i].v != list[j].v {
					return list[i].v > list[j].v
				}
				return list[i].k < list[j].k
			})
			softTop = jstClip(list[0].k, 40)
		}
		result["notices"] = toAnyList(soft)
		msg := fmt.Sprintf("导出 %d 个文件，新建出库单 %d 张", len(files), agg["created"])
		if n := agg["duplicate_skipped"].(int); n > 0 {
			msg += fmt.Sprintf("，跳过重复 %d 张", n)
		}
		if voidN > 0 {
			msg += fmt.Sprintf("，跳过作废 %d 张", voidN)
		}
		if n := len(jstAnySlice(agg["unmapped"])); n > 0 {
			msg += fmt.Sprintf("，未关联商品 %d 种（已生成待办，补完关联后可一键重跑）", n)
		}
		if len(soft) > 0 {
			msg += fmt.Sprintf("，提示 %d 条（%s）", len(soft), softTop)
		}
		if len(hard) > 0 {
			msg += fmt.Sprintf("，失败 %d 条", len(hard))
		}
		result["message"] = msg
		if len(jstAnySlice(agg["unmapped"])) > 0 {
			result["pending_id"] = jstOpenUnmappedTask(in.Key, files, rng, targets, agg)
		}
		return nil
	}

	err := run()
	if err != nil {
		var capErr *JstCaptchaRequired
		var nl *JstNotLoggedIn
		switch {
		case errors.As(err, &capErr):
			result["message"] = capErr.Msg
			result["need"] = "captcha"
			sms := map[string]any(nil)
			if capErr.HasAuth {
				sms = capErr.AuthParams()
			}
			result["pending_id"] = jstOpenCaptchaTask(in.Key, capErr.Msg, files, rng, targets, "captcha", sms)
		case errors.As(err, &nl):
			result["message"] = nl.Msg
			result["need"] = "captcha"
			result["pending_id"] = jstOpenCaptchaTask(in.Key, nl.Msg, files, rng, targets, "not_logged_in", nil)
		default:
			result["message"] = err.Error()
		}
	}

	if stats, ok := result["stats"].(map[string]any); ok && len(stats) == 0 {
		delete(result, "stats")
	}
	if err := JstRecordRun(in.Key, result, true); err != nil {
		jstLogf("执行记录写盘失败：%s", err)
	}
	jstUpdateLast(result)
	jstSetState(map[string]any{"running": false, "step": "", "warehouse": "", "trigger": ""})
	jstLogf("自动出库[%s] %s：%s", in.Trigger, in.Key, jstPyStr(result["message"]))
	return result
}

func jstTryLock() bool {
	jstJobMu.Lock()
	defer jstJobMu.Unlock()
	if jstJobBusy {
		return false
	}
	jstJobBusy = true
	return true
}

func jstUnlock() {
	jstJobMu.Lock()
	jstJobBusy = false
	jstJobMu.Unlock()
}

// jstNewAgg 统计壳：键集与 Python 的 agg 完全一致（unmapped 先占位，最后被 sorted 列表覆盖）。
func jstNewAgg() map[string]any {
	return map[string]any{
		"orders": 0, "created": 0, "duplicate_skipped": 0, "failed": []any{},
		"unmapped": []any{},
	}
}

func jstIntOf(v any) int {
	if f, ok := jstPyFloat(v); ok {
		return int(f)
	}
	return 0
}

func jstIntMap(v any) map[string]int {
	out := map[string]int{}
	if m, ok := v.(map[string]any); ok {
		for k, val := range m {
			out[k] = jstIntOf(val)
		}
	}
	if m, ok := v.(map[string]int); ok {
		for k, val := range m {
			out[k] = val
		}
	}
	return out
}

func sortedKeys(set map[string]bool) []any {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sortStrings(out)
	return strList(out)
}

// sortedByCountDesc 对应 Python sorted(detail.values(), key=lambda x: -count)（稳定排序）。
func sortedByCountDesc(detail map[string]map[string]any) []any {
	list := make([]map[string]any, 0, len(detail))
	// 先按 code 排序，给稳定排序一个确定的初值（Python 用的是 dict 插入序）
	codes := make([]string, 0, len(detail))
	for c := range detail {
		codes = append(codes, c)
	}
	sortStrings(codes)
	for _, c := range codes {
		list = append(list, detail[c])
	}
	sort.SliceStable(list, func(i, j int) bool {
		return jstIntOf(list[i]["count"]) > jstIntOf(list[j]["count"])
	})
	return toAnyList(list)
}

func toAnyList(list []map[string]any) []any {
	out := make([]any, 0, len(list))
	for _, m := range list {
		out = append(out, m)
	}
	return out
}

func jstAnyList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return []any{}
}

func baseName(p string) string {
	i := strings.LastIndexAny(p, `/\`)
	if i < 0 {
		return p
	}
	return p[i+1:]
}

func jstWhName(key string) string {
	if JstWarehouseName != nil {
		if n := JstWarehouseName(key); n != "" {
			return n
		}
	}
	return key
}

// ---- 待办 ----

func jstOpenUnmappedTask(key string, files []string, rng []time.Time, targets []map[string]any, agg map[string]any) string {
	items := jstAnySlice(agg["unmapped_detail"])
	task := jstTaskBase(key, "unmapped", fmt.Sprintf(
		"有 %d 种聚水潭商品还没关联系统商品；在待办里补完关联后点「完成并重新导入」即可把剩下的单建出来",
		len(jstAnySlice(agg["unmapped"]))), files, rng, targets)
	task["items"] = items
	saved, err := JstUpsertPending(key, task)
	if err != nil {
		jstLogf("待办写入失败：%s", err)
		return ""
	}
	jstNotify(key, saved)
	return jstPyStr(saved["id"])
}

func jstOpenCaptchaTask(key, message string, files []string, rng []time.Time, targets []map[string]any,
	reason string, smsAuth map[string]any) string {
	task := jstTaskBase(key, "captcha", message, files, rng, targets)
	task["reason"] = reason
	if smsAuth != nil {
		task["sms_auth"] = smsAuth
	}
	saved, err := JstUpsertPending(key, task)
	if err != nil {
		jstLogf("待办写入失败：%s", err)
		return ""
	}
	jstNotify(key, saved)
	return jstPyStr(saved["id"])
}

// jstNotify 待办通知：站内（前端拉 /pending）一定有；另可选 webhook 推到手机。
func jstNotify(key string, task map[string]any) {
	text := fmt.Sprintf("【ERP 自动出库待办】%s：%s", jstWhName(key), jstPyStr(orAny(task["message"], "")))
	jstLogf("%s", text)
	url := strings.TrimSpace(jstPyStr(orAny(JstGlobalsView(nil)["notify_webhook"], "")))
	if url == "" {
		return
	}
	payload := map[string]any{
		"msgtype": "text", "text": map[string]any{"content": text},
		"title": "ERP 自动出库待办", "desp": text, "message": text,
		"warehouse": key, "task_id": task["id"],
	}
	raw, err := jsonMarshalNoEscape(payload)
	if err != nil {
		return
	}
	go func() {
		cl := &http.Client{Timeout: 10 * time.Second}
		req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(string(raw)))
		if err != nil {
			jstLogf("待办 webhook 推送失败：%s", err)
			return
		}
		req.Header.Set("content-type", "application/json")
		resp, err := cl.Do(req)
		if err != nil {
			jstLogf("待办 webhook 推送失败：%s", err)
			return
		}
		defer resp.Body.Close()
		jstLogf("待办已推送到 webhook")
	}()
}

// JstPublicTask 给前端看的待办内容（不返回 Cookie，只返回是否已填过验证码）。
func JstPublicTask(t map[string]any) map[string]any {
	sms, _ := t["sms_auth"].(map[string]any)
	smsVerifiable := false
	if sms != nil {
		smsVerifiable = jstPyStr(orAny(sms["action"], "")) != ""
	}
	reason, _ := t["reason"].(string)
	msg, _ := t["message"].(string)
	created, _ := t["created_at"].(string)
	window, _ := t["window"].(string)
	status := t["status"]
	if status == nil {
		status = "open"
	}
	return map[string]any{
		"id": t["id"], "type": t["type"], "reason": reason, "message": msg,
		"created_at": created, "sms_verifiable": smsVerifiable,
		"files": orAny(t["files"], []any{}), "window": window,
		"targets": orAny(t["targets"], []any{}), "items": orAny(t["items"], []any{}),
		"has_verify_code": jstTruthy(t["verify_code"], false), "status": status,
	}
}

// ---- 导入 / 关联 ----

// jstImportFile 复用「聚水潭导入」链路把一个 xlsx 导入指定分仓。
func jstImportFile(key, path, operator string, skipImported bool) (map[string]any, error) {
	if JstImportFunc == nil {
		return nil, errors.New("聚水潭导入链路（xlsx 建出库单）尚未在 Go 侧接管，无法自动建单")
	}
	return JstImportFunc(key, path, operator, skipImported)
}

// JstSaveMappings 保存「聚水潭商品名 → 系统商品」关联（与「聚水潭关联」页同一张表）。
func JstSaveMappings(ctx context.Context, key string, mappings []map[string]any) (int, error) {
	if JstOpenDB == nil {
		return 0, errors.New("未注入分仓数据库")
	}
	db, err := JstOpenDB(key)
	if err != nil {
		return 0, err
	}
	saved := 0
	for _, m := range mappings {
		code := strings.TrimSpace(jstPyStr(orAny(m["external_code"], "")))
		pid := m["product_id"]
		if code == "" || !jstTruthy(pid, false) {
			continue
		}
		id := jstIntOf(pid)
		var rowID int
		err := db.QueryRowContext(ctx,
			"SELECT id FROM code_mappings WHERE source = 'jushuitan' AND external_code = ? ORDER BY id LIMIT 1",
			code).Scan(&rowID)
		if err == nil {
			_, err = db.ExecContext(ctx, "UPDATE code_mappings SET product_id = ?, updated_at = ? WHERE id = ?",
				id, NowDB(), rowID)
		} else if errors.Is(err, sql.ErrNoRows) {
			_, err = db.ExecContext(ctx,
				"INSERT INTO code_mappings (source, external_code, external_name, product_id, auto_score, created_at, updated_at)"+
					" VALUES ('jushuitan', ?, ?, ?, 0.0, ?, ?)", code, code, id, NowDB(), NowDB())
		}
		if err != nil {
			return saved, err
		}
		saved++
	}
	return saved, nil
}

// jstExactNorm 100% 同名的比较口径：去掉所有空白 + 忽略大小写。
func jstExactNorm(s string) string { return strings.ToLower(jstTrimAllSpace(s)) }

type jstProductRow struct {
	ID   int
	Name string
	Code string
	Type string
}

// jstPickExactMatch 找「名称/编码 100% 相同」的商品；有歧义就不猜（返回 nil）。
// 优先级与导入链路一致：唯一同名的订单小类 > 唯一同名商品。
func jstPickExactMatch(extName string, products []jstProductRow, attr string) *jstProductRow {
	k := jstExactNorm(extName)
	if k == "" {
		return nil
	}
	var hits []jstProductRow
	for i := range products {
		v := products[i].Name
		if attr == "code" {
			v = products[i].Code
		}
		if jstExactNorm(v) == k {
			hits = append(hits, products[i])
		}
	}
	var orders []jstProductRow
	for _, p := range hits {
		if p.Type == "order" {
			orders = append(orders, p)
		}
	}
	if len(orders) == 1 {
		return &orders[0]
	}
	if len(hits) == 1 {
		return &hits[0]
	}
	return nil
}

// JstExactRematch 按「100% 同名」重新匹配待补全的聚水潭商品名（只读，不写库）。
// 返回 (匹配上的 [{external_code, product_id, product_name}], 仍未匹配的 items)。
func JstExactRematch(ctx context.Context, key string, items []map[string]any, onlyCodes []string) (matched []map[string]any, left []map[string]any, err error) {
	if JstOpenDB == nil {
		return nil, nil, errors.New("未注入分仓数据库")
	}
	db, err := JstOpenDB(key)
	if err != nil {
		return nil, nil, err
	}
	products, err := jstAllProducts(ctx, db)
	if err != nil {
		return nil, nil, err
	}
	matched = []map[string]any{}
	left = []map[string]any{}
	inOnly := func(code string) bool {
		for _, c := range onlyCodes {
			if c == code {
				return true
			}
		}
		return false
	}
	for _, it := range items {
		code := strings.TrimSpace(jstPyStr(orAny(it["external_code"], "")))
		if code == "" {
			continue
		}
		if len(onlyCodes) > 0 && !inOnly(code) {
			left = append(left, it)
			continue
		}
		hit := jstPickExactMatch(code, products, "name")
		if hit == nil {
			hit = jstPickExactMatch(code, products, "code")
		}
		if hit == nil {
			left = append(left, it)
			continue
		}
		matched = append(matched, map[string]any{"external_code": code, "product_id": hit.ID, "product_name": hit.Name})
	}
	return matched, left, nil
}

func jstAllProducts(ctx context.Context, db *sql.DB) ([]jstProductRow, error) {
	rows, err := db.QueryContext(ctx, "SELECT id, name, code, product_type FROM products")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []jstProductRow{}
	for rows.Next() {
		var p jstProductRow
		var name, code, typ sql.NullString
		if err := rows.Scan(&p.ID, &name, &code, &typ); err != nil {
			return nil, err
		}
		p.Name, p.Code, p.Type = name.String, code.String, typ.String
		out = append(out, p)
	}
	return out, rows.Err()
}

// JstReimportFiles 只重新导入已下载的文件（不再去聚水潭导一遍）。
func JstReimportFiles(ctx context.Context, key string, paths []string, operator string, skipImported bool) (map[string]any, error) {
	agg := jstNewAgg()
	unmappedSet := map[string]bool{}
	detail := map[string]map[string]any{}
	existing := []string{}
	for _, p := range paths {
		if !fileExists(p) {
			continue
		}
		existing = append(existing, p)
		jstSetState(map[string]any{"step": fmt.Sprintf("正在重新导入 %s …", baseName(p))})
		stt, err := jstImportFile(key, p, operator, skipImported)
		if err != nil {
			return nil, err
		}
		agg["orders"] = agg["orders"].(int) + jstIntOf(stt["orders"])
		agg["created"] = agg["created"].(int) + jstIntOf(stt["created"])
		agg["duplicate_skipped"] = agg["duplicate_skipped"].(int) + jstIntOf(stt["duplicate_skipped"])
		agg["failed"] = append(agg["failed"].([]any), jstAnySlice(stt["failed"])...)
		for _, u := range jstAnySlice(stt["unmapped"]) {
			unmappedSet[jstPyStr(u)] = true
		}
		for _, it := range jstMapSlice(stt["unmapped_detail"]) {
			code := jstPyStr(orAny(it["external_code"], ""))
			if code != "" {
				if _, ok := detail[code]; !ok {
					detail[code] = it
				}
			}
		}
	}
	agg["unmapped"] = sortedKeys(unmappedSet)
	agg["unmapped_detail"] = sortedByCountDesc(detail)
	names := []any{}
	for _, p := range existing {
		names = append(names, baseName(p))
	}
	agg["files"] = names
	return agg, nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ---- 待办重跑 ----

// JstResolvePendingIn 处理一条待办的入参。
type JstResolvePendingIn struct {
	Mappings   []map[string]any
	VerifyCode string
	Cookie     string
	UserName   string
}

// JstResolvePending 处理一条待办：保存关联 / 记录验证码或 Cookie → 自动重跑 → 更新或关闭待办。
// unmapped 只重新导入已下载的文件；captcha 带着新验证码或 Cookie 整轮重跑。
func JstResolvePending(ctx context.Context, key, taskID string, in JstResolvePendingIn) (map[string]any, error) {
	var task map[string]any
	for _, t := range jstMapSlice(JstWhOf(JstSettingsLoad(), key)["pending"]) {
		if t["id"] == taskID {
			task = t
		}
	}
	if task == nil {
		return nil, errors.New("待办不存在或已被处理")
	}
	saved, err := JstSaveMappings(ctx, key, in.Mappings)
	if err != nil {
		return nil, err
	}
	if in.VerifyCode != "" {
		if _, err := JstPatchPendingItem(key, taskID, map[string]any{"verify_code": strings.TrimSpace(in.VerifyCode)}); err != nil {
			return nil, err
		}
	}
	if in.Cookie != "" {
		if err := JstSetCookie(strings.TrimSpace(in.Cookie)); err != nil { // 全局 Cookie，所有分仓共用
			return nil, err
		}
		if _, err := JstPatchPendingItem(key, taskID, map[string]any{"cookie_saved": true}); err != nil {
			return nil, err
		}
	}

	wh := JstWhOf(JstSettingsLoad(), key)
	var rng []time.Time
	if r := jstAnySlice(task["range"]); len(r) == 2 {
		s, e1 := JstParseDatetime(jstPyStr(r[0]))
		e, e2 := JstParseDatetime(jstPyStr(r[1]))
		if e1 == nil && e2 == nil {
			rng = []time.Time{s, e}
		}
	}

	var res map[string]any
	if jstPyStr(task["type"]) == "unmapped" && len(jstAnySlice(task["file_paths"])) > 0 {
		// 只重新导入：自己拿锁（JstRunOnce 会自己拿，不能在这里拿，否则死锁）
		if !jstTryLock() {
			return map[string]any{"ok": false, "message": "已有一轮自动出库在跑，请稍后再点「完成」", "mappings_saved": saved}, nil
		}
		paths := make([]string, 0)
		for _, p := range jstAnySlice(task["file_paths"]) {
			paths = append(paths, jstPyStr(p))
		}
		jstSetState(map[string]any{"running": true, "warehouse": key,
			"trigger": fmt.Sprintf("待办重试·%s", orStr(in.UserName, "手动")), "step": "重新导入",
			"started_at": time.Now().Format("2006-01-02 15:04:05")})
		agg, err := JstReimportFiles(ctx, key, paths, jstPyStr(orAny(wh["operator"], "")),
			jstTruthy(orAny(wh["skip_imported"], true), true))
		jstSetState(map[string]any{"running": false, "step": "", "warehouse": "", "trigger": ""})
		jstUnlock()
		if err != nil {
			return nil, err
		}
		leftSet := jstAnySlice(agg["unmapped"])
		msg := fmt.Sprintf("重新导入完成：新建出库单 %d 张", agg["created"])
		if len(leftSet) > 0 {
			msg += fmt.Sprintf("，还有 %d 种商品未关联", len(leftSet))
		} else {
			msg += "，未关联商品已全部解决"
		}
		stats := map[string]any{}
		unsorted := map[string]bool{}
		_ = unsorted
		for k, v := range agg {
			if k == "unmappedSet" {
				continue
			}
			stats[k] = v
		}
		res = map[string]any{
			"ok":      jstIntOf(agg["created"]) != 0 || len(leftSet) == 0,
			"message": msg,
			"window":  jstPyStr(orAny(task["window"], "")),
			"files":   orAny(agg["files"], []any{}),
			"stats":   stats,
		}
	} else {
		smsAuth, _ := task["sms_auth"].(map[string]any)
		if in.VerifyCode != "" && smsAuth != nil && jstPyStr(orAny(smsAuth["action"], "")) != "" {
			ok, why := JstCheckSmsCode(jstPyStr(orAny(JstSettingsLoad()["cookie"], "")), in.VerifyCode,
				jstPyStr(orAny(smsAuth["action"], "")), jstTruthy(smsAuth["to_admin"], false), smsAuth["sid"], 30)
			if !ok {
				jstLogf("待办 %s 验证码校验未通过：%s", taskID, why)
				return map[string]any{"ok": false, "verify_failed": true, "mappings_saved": saved, "pending_left": 0,
					"task_id": taskID,
					"message": fmt.Sprintf("聚水潭校验未通过：%s。请填最新一条短信里的验证码（后发的新码会让旧码失效）", why)}, nil
			}
			jstLogf("待办 %s 验证码已通过聚水潭校验，开始重跑导出", taskID)
		}
		coIDs := []string{}
		for _, t := range jstMapSlice(task["targets"]) {
			coIDs = append(coIDs, jstPyStr(orAny(t["co_id"], "")))
		}
		run := JstRunIn{Key: key, TargetCoIDs: coIDs, Trigger: fmt.Sprintf("待办重试·%s", orStr(in.UserName, "手动"))}
		if len(rng) == 2 {
			s, e := rng[0], rng[1]
			run.Start, run.End = &s, &e
		}
		res = JstRunOnce(run)
	}

	stats := jstMapAny(res["stats"])
	var left []any
	if jstPyStr(task["type"]) == "unmapped" {
		left = jstAnySlice(stats["unmapped"])
	}
	if jstTruthy(res["ok"], false) && len(left) == 0 {
		note := fmt.Sprintf("已保存 %d 条关联；%s", saved, jstPyStr(orAny(res["message"], "")))
		if _, err := JstClosePending(key, taskID, "done", note); err != nil {
			return nil, err
		}
	} else if len(left) > 0 {
		upd := map[string]any{}
		for k, v := range task {
			upd[k] = v
		}
		upd["items"] = orAny(stats["unmapped_detail"], []any{})
		upd["message"] = fmt.Sprintf("还有 %d 种聚水潭商品未关联，补完后可继续重跑", len(left))
		if _, err := JstUpsertPending(key, upd); err != nil {
			return nil, err
		}
	}
	jstLogf("待办 %s 处理结果：%s", taskID, jstPyStr(orAny(res["message"], "")))
	out := map[string]any{}
	for k, v := range res {
		out[k] = v
	}
	out["mappings_saved"] = saved
	out["pending_left"] = len(left)
	out["task_id"] = taskID
	return out, nil
}

// jstMapAny 把 stats 这类可能是 map/nil 的值取成 map。
func jstMapAny(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// ---- 定时调度 ----

// jstJitterSeconds 按 (分仓, 日期, 定时点) 生成稳定的随机偏移秒数，范围 [-span, +span]。
// 用哈希而不是随机数：同一分钟内多次 tick 结果一致、服务重启也不变，但每天不同。
func jstJitterSeconds(key, day, slotText string, span int) int {
	if span <= 0 {
		return 0
	}
	sum := md5.Sum([]byte(fmt.Sprintf("%s|%s|%s", key, day, slotText)))
	h, _ := strconv.ParseInt(hex.EncodeToString(sum[:])[:8], 16, 64)
	return int(h%int64(2*span+1)) - span
}

// jstTick 检查到点未执行的分仓并触发一轮自动出库。
func jstTick(now time.Time) {
	defer func() {
		if r := recover(); r != nil {
			jstLogf("自动出库调度检查出错：%v", r)
		}
	}()
	day := now.Format("2006-01-02")
	d := JstSettingsLoad()
	keys := make([]string, 0, len(jstWhMap(d)))
	for k := range jstWhMap(d) {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, key := range keys {
		wh := JstWhOf(d, key)
		if !jstTruthy(wh["enabled"], false) || len(jstMapSlice(wh["targets"])) == 0 {
			continue
		}
		slots, err := JstParseSchedule(wh["schedule"])
		if err != nil {
			jstLogf("分仓 %s 的定时时间配置有问题：%s", key, err)
			continue
		}
		span := jstIntOf(wh["jitter_minutes"]) * 60
		for _, slot := range slots {
			stamp := jstStamp(slot.Hour, slot.Minute, day)
			base := time.Date(now.Year(), now.Month(), now.Day(), slot.Hour, slot.Minute, 0, 0, now.Location())
			offset := jstJitterSeconds(key, day, stamp, span)
			target := base.Add(time.Duration(offset) * time.Second)
			if target.Day() != now.Day() || target.Month() != now.Month() || target.Year() != now.Year() {
				target, offset = base, 0 // 浮动不跨天，否则去重用的 stamp 日期会对不上
			}
			if now.Before(target) {
				continue // 还没到（浮动后的）触发时刻
			}
			if now.Sub(target) >= time.Minute {
				continue // 已错过这一分钟：与 Python 一致，不补跑
			}
			first, err := JstMarkSlot(key, stamp, day)
			if err != nil {
				jstLogf("定时点标记写盘失败：%s", err)
				continue
			}
			if !first {
				continue // 这一分钟内已经跑过（或服务刚重启但已记录）
			}
			window := slot.Window
			jstLogf("到点触发自动出库：%s %s（浮动 %+ds → 实际 %s；区间规则 %s）",
				key, stamp, offset, target.Format("15:04:05"), orStr(window, jstPyStr(orAny(wh["window"], ""))))
			runIn := JstRunIn{Key: key, Window: window, Trigger: "定时"}
			go func(runIn JstRunIn) { JstRunOnce(runIn) }(runIn)
		}
	}
	if err := JstPruneSlots(day); err != nil {
		jstLogf("定时点清理写盘失败：%s", err)
	}
}
