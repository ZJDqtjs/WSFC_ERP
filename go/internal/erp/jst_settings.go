package erp

// 本文件对齐 Python backend/app/jst/settings.py：「自动出库设置」的读写。
// 存放位置 <backend>/json/jst_auto.json（全局聚水潭账号 + 各 ERP 分仓配置同一个文件），
// 读侧容错（文件缺失/损坏 → 空结构），写侧走 tmp + 原子 rename，与 Python 一样。

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// JstConfigPath 由 api 层注入（filepath.Join(cfg.JSONDir(), "jst_auto.json")）。
var JstConfigPath = ""

// jstLock 对应 Python settings.LOCK（RLock）：所有读改写都在锁内。
var jstLock sync.Mutex

// jstMaxRuns 每个分仓保留的执行记录条数；jstMaxText 字段长度上限。
const (
	jstMaxRuns      = 50
	jstMaxText      = 4000
	jstMaxPending   = 20
	jstMaxPendingIt = 200
)

// JstGlobalDefaults 全局默认值（键序与 Python GLOBAL_DEFAULTS 一致）。
func JstGlobalDefaults() map[string]any {
	return map[string]any{
		"account": "", "password": "", "cookie": "",
		"owner_co_id": "13662884", "min_interval": 10.0, "timeout": 120.0, "max_retries": 3,
		"io_date_field": "io_date",
		"filename_template": "销售出库单_{start:%Y%m%d}_{authorize_co_id}.xlsx",
		"notify_webhook": "", "notify_users": []any{},
	}
}

// JstGlobalDefaultOrder 全局键的展示顺序（Python dict 插入序；比较器不计顺序，仅供写文件用）。
var JstGlobalDefaultOrder = []string{"account", "password", "cookie", "owner_co_id", "min_interval",
	"timeout", "max_retries", "io_date_field", "filename_template", "notify_webhook", "notify_users"}

// JstWHDefaults 分仓默认值。
func JstWHDefaults() map[string]any {
	return map[string]any{
		"enabled": false, "targets": []any{}, "window": "yesterday",
		"fixed_from": "", "fixed_to": "", "schedule": []any{}, "jitter_minutes": 0,
		"auto_import": true, "skip_imported": true, "operator": "",
		"last_run": map[string]any{}, "runs": []any{}, "done_slots": []any{}, "pending": []any{},
	}
}

// ---- Python 的宽松清洗器 ----

// jstCleanStr 等价 _clean_str：str(v).strip()[:limit]。
func jstCleanStr(v any, limit int) string {
	s := jstPyStr(v)
	s = strings.TrimSpace(s)
	if limit <= 0 {
		limit = jstMaxText
	}
	r := []rune(s)
	if len(r) > limit {
		s = string(r[:limit])
	}
	return s
}

// jstPyStr 近似 Python str()：None→""，bool→True/False，数字按 repr，字符串原样。
func jstPyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case float64:
		if math.IsNaN(x) {
			return "nan"
		}
		if math.IsInf(x, 1) {
			return "inf"
		}
		if math.IsInf(x, -1) {
			return "-inf"
		}
		return pyFloatRepr(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case json.Number:
		return x.String()
	}
	return fmt.Sprintf("%v", v)
}

// pyFloatRepr 用最短十进制表示（Python 的 str(float)）：10.0 → "10.0"，0.5 → "0.5"。
func pyFloatRepr(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e16 {
		return strconv.FormatFloat(f, 'f', 1, 64)
	}
	return strconv.FormatFloat(f, 'g', 17, 64)
}

// jstCleanNum 等价 _clean_num：转不动或 NaN 用默认值，否则夹到 [lo,hi]。
func jstCleanNum(v any, def, lo, hi float64) float64 {
	f, ok := jstPyFloat(v)
	if !ok || math.IsNaN(f) {
		return def
	}
	if f < lo {
		return lo
	}
	if f > hi {
		return hi
	}
	return f
}

// jstPyFloat 等价 Python float(v)：接受 bool/数字/字符串（可含空格），其它失败。
func jstPyFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case nil:
		return 0, false
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case float64:
		return x, true
	case int:
		return float64(x), true
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

// jstCleanBool 等价 _clean_bool：bool 原样；字符串认 1/true/yes/on/是；None 用默认；其它按真值。
func jstCleanBool(v any, def bool) bool {
	switch x := v.(type) {
	case nil:
		return def
	case bool:
		return x
	case string:
		return containsAnyStr(strings.ToLower(strings.TrimSpace(x)), "1", "true", "yes", "on", "是")
	}
	return jstTruthy(v, def)
}

func containsAnyStr(s string, opts ...string) bool {
	for _, o := range opts {
		if s == o {
			return true
		}
	}
	return false
}

// jstTruthy Python 的 bool(v)：0/""/空集合为假。
func jstTruthy(v any, def bool) bool {
	switch x := v.(type) {
	case nil:
		return def
	case bool:
		return x
	case float64:
		return x != 0
	case int:
		return x != 0
	case string:
		return x != ""
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

// ---- 读 ----

// JstSettingsLoad 读整个设置文件（缺失/损坏返回 {"warehouses":{}}，不报错）。
func JstSettingsLoad() map[string]any {
	jstLock.Lock()
	defer jstLock.Unlock()
	return jstLoadLocked()
}

func jstLoadLocked() map[string]any {
	fallback := map[string]any{"warehouses": map[string]any{}}
	if JstConfigPath == "" {
		return fallback
	}
	raw, err := os.ReadFile(JstConfigPath)
	if err != nil {
		return fallback
	}
	var d map[string]any
	if err := json.Unmarshal(raw, &d); err != nil {
		return fallback
	}
	if d == nil {
		return fallback
	}
	if wh, ok := d["warehouses"].(map[string]any); !ok || wh == nil {
		d["warehouses"] = map[string]any{}
	}
	return d
}

// JstSettingsSave 原子写回（tmp + rename，indent=2、不转义中文、无尾随换行）。
func JstSettingsSave(d map[string]any) error {
	jstLock.Lock()
	defer jstLock.Unlock()
	return jstSaveLocked(d)
}

func jstSaveLocked(d map[string]any) error {
	if JstConfigPath == "" {
		return fmt.Errorf("未配置自动出库设置文件路径")
	}
	dir := filepath.Dir(JstConfigPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := jstMarshal(d)
	if err != nil {
		return err
	}
	tmp := JstConfigPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, JstConfigPath)
}

// jstMarshal 按 Python 的插入顺序风格序列化：默认键先（保留默认顺序），其余按字典序。
// Go 的 map 无序，这里显式排序以保证写盘内容稳定（差分比较的是解析后的值）。
func jstMarshal(v any) ([]byte, error) {
	return jsonIndentNoEscape(orderJSON(v))
}

// orderJSON 递归把 map 排成固定顺序的有序 JSON 文本（Python 的 ensure_ascii=False + indent=2）。
func orderJSON(v any) any {
	switch x := v.(type) {
	case map[string]any:
		keys := jstOrderedKeys(x)
		out := make(orderedMap, 0, len(keys))
		for _, k := range keys {
			out = append(out, kvPair{k, orderJSON(x[k])})
		}
		return out
	case []any:
		out := make([]any, 0, len(x))
		for _, it := range x {
			out = append(out, orderJSON(it))
		}
		return out
	default:
		return v
	}
}

// orderedMap 让 encoding/json 按切片顺序输出键。
type orderedMap []kvPair
type kvPair struct {
	K string `json:"-"`
	V any    `json:"-"`
}

// MarshalJSON 输出保序对象。
func (m orderedMap) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, p := range m {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, err := json.Marshal(p.K)
		if err != nil {
			return nil, err
		}
		vb, err := json.Marshal(p.V)
		if err != nil {
			return nil, err
		}
		b.Write(kb)
		b.WriteByte(':')
		b.Write(vb)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// jstOrderedKeys 默认键按 Python 的默认表顺序，未知键按字典序附在后面（只求稳定）。
func jstOrderedKeys(m map[string]any) []string {
	prefer := []string{"warehouses", "account", "password", "cookie", "owner_co_id", "min_interval",
		"timeout", "max_retries", "io_date_field", "filename_template", "notify_webhook", "notify_users",
		"enabled", "targets", "window", "fixed_from", "fixed_to", "schedule", "jitter_minutes",
		"auto_import", "skip_imported", "operator", "last_run", "runs", "done_slots", "pending",
		"id", "type", "message", "files", "file_paths", "window", "range", "items", "status",
		"reason", "sms_auth", "verify_code", "created_at", "closed_at", "close_note", "cookie_saved"}
	seen := map[string]bool{}
	out := make([]string, 0, len(m))
	for _, k := range prefer {
		if _, ok := m[k]; ok && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	rest := make([]string, 0, len(m))
	for k := range m {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sortStrings(rest)
	return append(out, rest...)
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// ---- 取配置 ----

// JstGlobalsOf 全局配置（补默认值 + 数值夹紧）。password/cookie 原样返回（内部用）。
func JstGlobalsOf(d map[string]any) map[string]any {
	if d == nil {
		d = jstLoadLocked()
	}
	out := JstGlobalDefaults()
	for _, k := range JstGlobalDefaultOrder {
		if v, ok := d[k]; ok {
			out[k] = v
		}
	}
	out["min_interval"] = jstCleanNum(out["min_interval"], 10.0, 0.0, 600.0)
	out["timeout"] = jstCleanNum(out["timeout"], 120.0, 5.0, 600.0)
	out["max_retries"] = int(jstCleanNum(out["max_retries"], 3, 1, 10))
	return out
}

// JstWhOf 某个 ERP 分仓的配置（补默认值 + 归一化，含 runs/pending 等运行时数据）。
func JstWhOf(d map[string]any, key string) map[string]any {
	if d == nil {
		d = jstLoadLocked()
	}
	raw := map[string]any{}
	if ws, ok := d["warehouses"].(map[string]any); ok {
		if v, ok := ws[key].(map[string]any); ok {
			raw = v
		}
	}
	out := JstWHDefaults()
	for k, v := range raw {
		switch k {
		case "last_run", "runs", "done_slots", "pending":
		default:
			out[k] = v
		}
	}
	// targets：只留带 co_id 的字典，co_id/name 截断
	tgt := []any{}
	for _, it := range jstAnySlice(raw["targets"]) {
		t, ok := it.(map[string]any)
		if !ok {
			continue
		}
		co := jstCleanStr(t["co_id"], 32)
		if co == "" {
			continue
		}
		tgt = append(tgt, map[string]any{"co_id": co, "name": jstCleanStr(t["name"], 128)})
	}
	out["targets"] = tgt
	// schedule：去空、截断（保留重复项，与 Python 一致）
	sch := []any{}
	for _, it := range jstAnySlice(raw["schedule"]) {
		s := jstCleanStr(it, 48)
		if s != "" {
			sch = append(sch, s)
		}
	}
	out["schedule"] = sch
	if lr, ok := raw["last_run"].(map[string]any); ok {
		out["last_run"] = lr
	} else {
		out["last_run"] = map[string]any{}
	}
	if rs, ok := raw["runs"].([]any); ok {
		out["runs"] = rs
	} else {
		out["runs"] = []any{}
	}
	ds := []any{}
	for _, it := range jstAnySlice(raw["done_slots"]) {
		if s, ok := it.(string); ok {
			ds = append(ds, s)
		}
	}
	out["done_slots"] = ds
	pd := []any{}
	for _, it := range jstAnySlice(raw["pending"]) {
		if t, ok := it.(map[string]any); ok {
			if jstTruthy(t["id"], false) {
				pd = append(pd, t)
			}
		}
	}
	out["pending"] = pd
	out["enabled"] = jstCleanBool(out["enabled"], false)
	out["auto_import"] = jstCleanBool(out["auto_import"], true)
	out["skip_imported"] = jstCleanBool(out["skip_imported"], true)
	out["jitter_minutes"] = int(jstCleanNum(out["jitter_minutes"], 0, 0, 120))
	return out
}

func jstAnySlice(v any) []any {
	switch x := v.(type) {
	case []any:
		return x
	case nil:
		return nil
	}
	return nil
}

// jstMapSlice 取 map 列表（pending/targets 用）。
func jstMapSlice(v any) []map[string]any {
	out := []map[string]any{}
	for _, it := range jstAnySlice(v) {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// JstGlobalsView 全局配置的非口令视图（含通知设置），供前端编辑。
func JstGlobalsView(d map[string]any) map[string]any {
	g := JstGlobalsOf(d)
	g["notify_webhook"] = jstCleanStr(g["notify_webhook"], 500)
	users := []any{}
	for _, x := range jstAnySlice(g["notify_users"]) {
		s := jstCleanStr(x, 64)
		if s != "" {
			users = append(users, s)
		}
	}
	g["notify_users"] = users
	return g
}

// JstPublicGlobals 回给前端的全局配置：口令类只回「是否已设置」。
func JstPublicGlobals(d map[string]any) map[string]any {
	g := JstGlobalsOf(d)
	g["has_password"] = jstTruthy(g["password"], false)
	delete(g, "password")
	// Python: cookie = g.pop("cookie", "") or ""（None/空串都归一成 ""）
	cookie := ""
	if v, ok := g["cookie"]; ok && v != nil {
		if s, isStr := v.(string); isStr {
			cookie = s
		} else {
			cookie = jstPyStr(v)
		}
	}
	g["has_cookie"] = cookie != ""
	g["cookie_len"] = len([]rune(cookie))
	delete(g, "cookie")
	return g
}

// ---- 写 ----

// JstPatchGlobals 保存全局配置；password/cookie 传空串表示「不修改」。
func JstPatchGlobals(patch map[string]any) (map[string]any, error) {
	jstLock.Lock()
	defer jstLock.Unlock()
	d := jstLoadLocked()
	for _, k := range []string{"account", "cookie", "owner_co_id", "io_date_field", "filename_template"} {
		if v, ok := patch[k]; ok && v != nil {
			d[k] = jstCleanStr(v, jstMaxText)
		}
	}
	if v, ok := patch["password"]; ok && jstCleanStr(v, jstMaxText) != "" {
		d["password"] = jstCleanStr(v, jstMaxText)
	}
	for _, spec := range []struct {
		key    string
		lo, hi float64
	}{{"min_interval", 0, 600}, {"timeout", 5, 600}, {"max_retries", 1, 10}} {
		if v, ok := patch[spec.key]; ok && !jstIsNoneOrEmpty(v) {
			def, _ := jstPyFloat(JstGlobalDefaults()[spec.key])
			d[spec.key] = jstCleanNum(v, def, spec.lo, spec.hi)
		}
	}
	if v, ok := patch["notify_webhook"]; ok && v != nil {
		d["notify_webhook"] = jstCleanStr(v, 500)
	}
	if v, ok := patch["notify_users"]; ok && v != nil {
		users := []any{}
		for _, x := range jstAnySlice(v) {
			s := jstCleanStr(x, 64)
			if s != "" {
				users = append(users, s)
			}
		}
		d["notify_users"] = users
	}
	if err := jstSaveLocked(d); err != nil {
		return nil, err
	}
	return JstGlobalsOf(d), nil
}

func jstIsNoneOrEmpty(v any) bool {
	if v == nil {
		return true
	}
	if s, ok := v.(string); ok && s == "" {
		return true
	}
	return false
}

// JstPatchWh 保存某个分仓的配置（只接受白名单字段；运行时数据原样带回）。
func JstPatchWh(key string, patch map[string]any) (map[string]any, error) {
	jstLock.Lock()
	defer jstLock.Unlock()
	d := jstLoadLocked()
	cur := JstWhOf(d, key)
	for _, k := range []string{"window", "fixed_from", "fixed_to", "operator"} {
		if v, ok := patch[k]; ok && v != nil {
			cur[k] = jstCleanStr(v, 64)
		}
	}
	for _, k := range []string{"enabled", "auto_import", "skip_imported"} {
		if v, ok := patch[k]; ok && v != nil {
			cur[k] = jstCleanBool(v, jstTruthy(cur[k], false))
		}
	}
	if v, ok := patch["targets"]; ok && v != nil {
		tgt := []any{}
		for _, it := range jstAnySlice(v) {
			t, ok := it.(map[string]any)
			if !ok {
				if it == nil {
					t = map[string]any{}
				} else {
					continue
				}
			}
			co := jstCleanStr(t["co_id"], 32)
			if co == "" {
				continue
			}
			tgt = append(tgt, map[string]any{"co_id": co, "name": jstCleanStr(t["name"], 128)})
		}
		cur["targets"] = tgt
	}
	if v, ok := patch["schedule"]; ok && v != nil {
		sch := []any{}
		for _, s := range jstAnySlice(v) {
			t := jstCleanStr(s, 48)
			if t != "" {
				sch = append(sch, t)
			}
		}
		cur["schedule"] = sch
	}
	if v, ok := patch["jitter_minutes"]; ok && v != nil {
		cur["jitter_minutes"] = int(jstCleanNum(v, 0, 0, 120))
	}
	ws, _ := d["warehouses"].(map[string]any)
	if ws == nil {
		ws = map[string]any{}
		d["warehouses"] = ws
	}
	ws[key] = cur
	if err := jstSaveLocked(d); err != nil {
		return nil, err
	}
	return JstWhOf(d, key), nil
}

// JstSetCookie Cookie 续登成功后写回。
func JstSetCookie(cookie string) error {
	jstLock.Lock()
	defer jstLock.Unlock()
	d := jstLoadLocked()
	d["cookie"] = jstCleanStr(cookie, 20000)
	return jstSaveLocked(d)
}

// JstRecordRun 追加一条执行记录（最新在前，最多 50 条）。
// updateLast=false 只进列表、不覆盖「上次执行」展示位（手动/古法导入用）。
func JstRecordRun(key string, entry map[string]any, updateLast bool) error {
	jstLock.Lock()
	defer jstLock.Unlock()
	d := jstLoadLocked()
	wh := jstWhSlot(d, key)
	var runs []any
	if r, ok := wh["runs"].([]any); ok {
		runs = r
	} else {
		runs = []any{}
	}
	runs = append([]any{entry}, runs...)
	if len(runs) > jstMaxRuns {
		runs = runs[:jstMaxRuns]
	}
	wh["runs"] = runs
	if updateLast {
		wh["last_run"] = entry
	}
	return jstSaveLocked(d)
}

// jstWhSlot 拿到分仓的**原始** dict（缺失则建空壳），等价 Python setdefault 链。
func jstWhSlot(d map[string]any, key string) map[string]any {
	ws, ok := d["warehouses"].(map[string]any)
	if !ok || ws == nil {
		ws = map[string]any{}
		d["warehouses"] = ws
	}
	wh, ok := ws[key].(map[string]any)
	if !ok || wh == nil {
		wh = map[string]any{}
		ws[key] = wh
	}
	return wh
}

// JstMarkSlot 标记某分仓某天某个定时点已执行；true = 首次标记（可以执行）。
func JstMarkSlot(key, slotText, day string) (bool, error) {
	jstLock.Lock()
	defer jstLock.Unlock()
	d := jstLoadLocked()
	wh := jstWhSlot(d, key)
	done := []any{}
	for _, s := range jstAnySlice(wh["done_slots"]) {
		if str, ok := s.(string); ok && strings.HasPrefix(str, day) {
			done = append(done, str)
		}
	}
	wh["done_slots"] = done
	existed := false
	for _, s := range done {
		if s == slotText {
			existed = true
			break
		}
	}
	if !existed {
		wh["done_slots"] = append(done, slotText)
	}
	if err := jstSaveLocked(d); err != nil {
		return false, err
	}
	return !existed, nil
}

// JstPruneSlots 清掉非今天的定时点标记。
func JstPruneSlots(day string) error {
	jstLock.Lock()
	defer jstLock.Unlock()
	d := jstLoadLocked()
	changed := false
	for _, v := range jstWhMap(d) {
		wh, ok := v.(map[string]any)
		if !ok {
			continue
		}
		done := []any{}
		for _, s := range jstAnySlice(wh["done_slots"]) {
			if str, ok := s.(string); ok && strings.HasPrefix(str, day) {
				done = append(done, str)
			}
		}
		if !jstSameStrList(done, jstAnySlice(wh["done_slots"])) {
			wh["done_slots"] = done
			changed = true
		}
	}
	if changed {
		return jstSaveLocked(d)
	}
	return nil
}

func jstWhMap(d map[string]any) map[string]any {
	ws, ok := d["warehouses"].(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return ws
}

func jstSameStrList(a, b []any) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ---- 待办 ----

// JstPendingOpen 该分仓未完成的待办（新→旧）。
func JstPendingOpen(key string) []map[string]any {
	out := []map[string]any{}
	for _, t := range jstMapSlice(JstWhOf(jstLoadLocked(), key)["pending"]) {
		st, ok := t["status"]
		if !ok {
			out = append(out, t)
			continue
		}
		if s, ok := st.(string); ok && s == "open" {
			out = append(out, t)
		}
	}
	return out
}

// JstUpsertPending 写入/更新一条待办：同「类型 + 文件」就地更新并保留人工填过的内容。
func JstUpsertPending(key string, task map[string]any) (map[string]any, error) {
	jstLock.Lock()
	defer jstLock.Unlock()
	d := jstLoadLocked()
	wh := jstWhSlot(d, key)
	items := jstMapSlice(wh["pending"])
	if its, ok := task["items"].([]any); ok && len(its) > jstMaxPendingIt {
		task["items"] = its[:jstMaxPendingIt]
	}
	old := findPendingByTypeFiles(items, task)
	if old != nil {
		keep := map[string]any{}
		for _, k := range []string{"id", "verify_code", "cookie", "created_at"} {
			if v, ok := old[k]; ok && jstTruthy(v, false) {
				keep[k] = v
			}
		}
		for k, v := range task {
			old[k] = v
		}
		for k, v := range keep {
			old[k] = v
		}
		task = old
	} else {
		if _, ok := task["created_at"]; !ok {
			task["created_at"] = time.Now().Format("2006-01-02 15:04:05")
		}
		items = append([]map[string]any{task}, items...)
	}
	if len(items) > jstMaxPending {
		items = items[:jstMaxPending]
	}
	list := make([]any, 0, len(items))
	for _, it := range items {
		list = append(list, it)
	}
	wh["pending"] = list
	if err := jstSaveLocked(d); err != nil {
		return nil, err
	}
	return task, nil
}

// findPendingByTypeFiles Python: t["type"]==task["type"] and t["files"]==task["files"]（深比较）。
func findPendingByTypeFiles(items []map[string]any, task map[string]any) map[string]any {
	for _, t := range items {
		if jstPyStr(t["type"]) == jstPyStr(task["type"]) && jstValuesEqual(t["files"], task["files"]) {
			return t
		}
	}
	return nil
}

// jstValuesEqual Python 的 ==（对 JSON 值）：类型与顺序都敏感。
func jstValuesEqual(a, b any) bool {
	ja, e1 := json.Marshal(orderJSON(a))
	jb, e2 := json.Marshal(orderJSON(b))
	if e1 != nil || e2 != nil {
		return false
	}
	return string(ja) == string(jb)
}

// JstPendingVerifyCode 待办里人工填的验证码（取最新一条）。
func JstPendingVerifyCode(key string) string {
	for _, t := range JstPendingOpen(key) {
		code := jstCleanStr(t["verify_code"], 32)
		if code != "" {
			return code
		}
	}
	return ""
}

// JstClosePending 把一条待办标记为已完成/已忽略（返回最后一条命中的；不存在返回 nil）。
func JstClosePending(key, taskID, status, note string) (map[string]any, error) {
	jstLock.Lock()
	defer jstLock.Unlock()
	d := jstLoadLocked()
	wh := jstWhSlot(d, key)
	var found map[string]any
	for _, t := range jstMapSlice(wh["pending"]) {
		if t["id"] == taskID {
			t["status"] = status
			t["closed_at"] = time.Now().Format("2006-01-02 15:04:05")
			if note != "" {
				t["close_note"] = note
			}
			found = t
		}
	}
	if found != nil {
		if err := jstSaveLocked(d); err != nil {
			return nil, err
		}
	}
	return found, nil
}

// JstPatchPendingItem 更新待办里的少量字段（id/status 除外）。
func JstPatchPendingItem(key, taskID string, patch map[string]any) (map[string]any, error) {
	jstLock.Lock()
	defer jstLock.Unlock()
	d := jstLoadLocked()
	wh := jstWhSlot(d, key)
	var found map[string]any
	for _, t := range jstMapSlice(wh["pending"]) {
		if t["id"] == taskID {
			for k, v := range patch {
				if k == "id" || k == "status" {
					continue
				}
				t[k] = v
			}
			found = t
		}
	}
	if found != nil {
		if err := jstSaveLocked(d); err != nil {
			return nil, err
		}
	}
	return found, nil
}

// ---- 展示用 ----

// JstNextRunsWithJitter 界面上的「接下来几次实际执行时间」：把定时浮动算进去。
func JstNextRunsWithJitter(key string, wh map[string]any, limit int) []string {
	span := int(jstCleanNum(wh["jitter_minutes"], 0, 0, 120)) * 60
	parsed, err := JstParseSchedule(wh["schedule"])
	if err != nil {
		return []string{}
	}
	if limit <= 0 {
		limit = 3
	}
	now := time.Now()
	out := []time.Time{}
	for dayOffset := 0; dayOffset < 8; dayOffset++ {
		day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, dayOffset)
		dayStr := day.Format("2006-01-02")
		for _, s := range parsed {
			base := time.Date(day.Year(), day.Month(), day.Day(), s.Hour, s.Minute, 0, 0, now.Location())
			off := jstJitterSeconds(key, dayStr, jstStamp(s.Hour, s.Minute, dayStr), span)
			target := base.Add(time.Duration(off) * time.Second)
			if target.Day() != base.Day() || target.Month() != base.Month() || target.Year() != base.Year() {
				target = base
			}
			if target.After(now) {
				out = append(out, target)
			}
		}
		if len(out) >= limit {
			break
		}
	}
	sortTimes(out)
	if len(out) > limit {
		out = out[:limit]
	}
	res := make([]string, 0, len(out))
	for _, t := range out {
		res = append(res, t.Format("2006-01-02 15:04"))
	}
	return res
}

func sortTimes(ts []time.Time) {
	for i := 1; i < len(ts); i++ {
		for j := i; j > 0 && ts[j].Before(ts[j-1]); j-- {
			ts[j], ts[j-1] = ts[j-1], ts[j]
		}
	}
}
