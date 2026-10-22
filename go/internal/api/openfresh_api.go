package api

import (
	"context"
	"database/sql"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"wsfc-erp-go/internal/auth"
	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// 本文件是「对外只读成本表」+「鲜货需求预演算」两个接口的 handler 层，
// 路径/字段/状态码/文案与 Python routers/open_api.py、routers/fresh.py 逐一对齐。

// registerOpenFresh 由主控在 routes.go 里调用（本模块不改 routes.go）。
func (s *Server) registerOpenFresh(rt *router) {
	// 对外只读成本表（Header Token 鉴权，免会话）
	rt.Get("/api/open/sku-costs", s.OpenSkuCosts)
	// 鲜货需求预演算（multipart 上传，登录会话）
	rt.Post("/api/fresh/plan", s.FreshPlan)
}

// ---- 鉴权：Header Token + 按 IP 分级锁定（口径同 Python open_api._require_token）----

// openScopeAPI 对外接口的锁定作用域（与 Python login_guard.SCOPE_OPEN_API 同名，共用 data/login_locks.json）。
const openScopeAPI = "open_api"

// openClientIP 真实客户端 IP：反代时优先 X-Real-IP / X-Forwarded-For（同 Python maintenance.client_ip）。
func openClientIP(r *http.Request) string {
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	if addr := r.RemoteAddr; addr != "" {
		if i := strings.LastIndex(addr, ":"); i > 0 {
			return addr[:i]
		}
		return addr
	}
	return ""
}

// openRequireToken 校验令牌：
//   - 未配置令牌 → 503（服务端配置问题，不计入失败）；
//   - 该 IP 处于锁定期 → 429 + 剩余时长；
//   - 令牌缺失/错误 → 记一次失败，到档位返回 429，否则 401「Token 无效」；
//   - 校验通过 → 清零该 IP 的失败计数。
func (s *Server) openRequireToken(r *http.Request) error {
	expected := erp.OpenAPIToken(s.Cfg.RepoRoot())
	if expected == "" {
		return web.Abort(http.StatusServiceUnavailable, "未配置 open_api.token，接口未开放")
	}
	ip := openClientIP(r)
	if ip == "" {
		ip = "-"
	}
	if left := s.Guard.LockedLeft(openScopeAPI, ip); left > 0 {
		return web.Abort(http.StatusTooManyRequests, "Token 连续错误次数过多，该 IP 已锁定 %s，请稍后再试", auth.Humanize(left))
	}
	got := strings.TrimSpace(r.Header.Get("X-Api-Token"))
	authorization := r.Header.Get("Authorization")
	if got == "" && strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
		got = strings.TrimSpace(authorization[7:])
	}
	if got == "" || got != expected {
		wait := s.Guard.RecordFail(openScopeAPI, ip)
		if wait > 0 {
			return web.Abort(http.StatusTooManyRequests, "Token 连续错误次数过多，该 IP 已锁定 %s，请稍后再试", auth.Humanize(wait))
		}
		return web.Abort(http.StatusUnauthorized, "Token 无效")
	}
	s.Guard.Reset(openScopeAPI, ip)
	return nil
}

// ---- 进程内短缓存（同 Python：按区间分键、10 分钟 TTL、过期项惰性淘汰）----

const openCacheTTL = 10 * time.Minute

type openEntry struct {
	at  time.Time
	val any
}

var (
	openMu           sync.Mutex
	openPayloadCache = map[string]openEntry{}
	openSummaryCache = map[string]openEntry{}
)

func openCacheGet(cache map[string]openEntry, k string) (any, bool) {
	now := time.Now()
	for key, e := range cache {
		if now.Sub(e.at) >= openCacheTTL {
			delete(cache, key)
		}
	}
	if e, ok := cache[k]; ok {
		return e.val, true
	}
	return nil, false
}

func openCacheSet(cache map[string]openEntry, k string, v any) {
	cache[k] = openEntry{at: time.Now(), val: v}
}

// ---- 跨全部分仓汇总（单仓读取失败只记一条，不影响其它仓）----

// openCollected 跨仓汇总结果：出库口径 / 入仓口径 / 读取失败的仓。
type openCollected struct {
	sale   map[string]map[string]any
	wh     map[string]map[string]any
	failed []map[string]any
}

// openCollect 逐仓跑「订单商品 + 入仓品」两份汇总并合并；带按区间分键的 10 分钟缓存。
//
// 缓存不能整表 clear：方案 B 每次请求要用「区间」+「全量」两份，clear 会把全量历史那份挤掉，
// 每次换区间都得重算全量（实测 ~3.8s，是接口慢的主因）。
func (s *Server) openCollect(ctx context.Context, dateFrom, dateTo string) *openCollected {
	ck := dateFrom + "|" + dateTo
	openMu.Lock()
	if v, ok := openCacheGet(openSummaryCache, ck); ok {
		openMu.Unlock()
		return v.(*openCollected)
	}
	openMu.Unlock()

	out := &openCollected{sale: map[string]map[string]any{}, wh: map[string]map[string]any{}, failed: []map[string]any{}}
	for _, w := range s.Mgr.Registry.List() {
		key := w.Key
		var db *sql.DB
		db, err := s.Mgr.DB(key)
		if err != nil {
			out.failed = append(out.failed, map[string]any{"key": key, "error": "读取失败：" + err.Error()})
			continue
		}
		sale, err := erp.OpenSkuRowsSale(ctx, db, dateFrom, dateTo)
		if err == nil {
			for code, d := range sale {
				d["_source"] = "sale"
				erp.OpenMergeInto(out.sale, map[string]map[string]any{code: d})
			}
			var wh map[string]map[string]any
			wh, err = erp.OpenSkuRowsWarehouse(ctx, db)
			if err == nil {
				erp.OpenMergeInto(out.wh, wh)
			}
		}
		if err != nil {
			out.failed = append(out.failed, map[string]any{"key": key, "error": "读取失败：" + err.Error()})
		}
	}
	openMu.Lock()
	openCacheSet(openSummaryCache, ck, out)
	openMu.Unlock()
	return out
}

// openNoteText 与 Python payload.meta.note 逐字一致。
const openNoteText = "supply=结算给我们的单件金额；price 留空请用报表真实客单价；null 回落到 default；" +
	"_period=range 成本取自所选区间，=all 区间内没卖用全量历史兜底，" +
	"=spec 入仓品只有资料、还没录入仓记录（用的是资料上的采购价）；" +
	"_qty/_turnover 是区间内销量，_totalQty/_totalTurnover 是全量历史（判断样本大小用）；" +
	"入仓品不按区间过滤，看 _lastDate 判断采购价日期"

// OpenSkuCosts GET /api/open/sku-costs —— 按京东 skuId 返回单件成本口径（对方成本表的直接替代）。
//
// date_from / date_to 只影响**出库商品**的单件均值（留空=全量历史），入仓品不按区间过滤（采购价是快照）。
// 区间内没卖的商品也会用全量历史兜底给出成本，并标 _period=all。
func (s *Server) OpenSkuCosts(w http.ResponseWriter, r *http.Request) {
	if err := s.openRequireToken(r); err != nil {
		web.WriteValue(w, r, err)
		return
	}
	rawFrom := r.URL.Query().Get("date_from")
	rawTo := r.URL.Query().Get("date_to")
	df, err := erp.OpenNormDate(rawFrom, "date_from")
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	dt, err := erp.OpenNormDate(rawTo, "date_to")
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	if df != "" && dt != "" && df > dt {
		df, dt = dt, df
	}
	ck := df + "|" + dt
	openMu.Lock()
	if v, ok := openCacheGet(openPayloadCache, ck); ok {
		openMu.Unlock()
		web.Write(w, http.StatusOK, v)
		return
	}
	openMu.Unlock()

	// 方案 B：区间汇总 + 全量历史汇总，区间内没卖的商品也用全量历史给出成本
	hasRange := df != "" || dt != ""
	var rng *openCollected
	if hasRange {
		rng = s.openCollect(r.Context(), df, dt)
	}
	full := s.openCollect(r.Context(), "", "")
	if rng == nil {
		rng = full
	}

	skus := map[string]map[string]any{}
	for code, d := range full.wh {
		skus[code] = erp.OpenWarehouseItem(d)
	}
	// 出库商品并集（同码时出库口径覆盖入仓品口径）
	saleCodes := make([]string, 0, len(full.sale)+len(rng.sale))
	for code := range full.sale {
		saleCodes = append(saleCodes, code)
	}
	for code := range rng.sale {
		if _, ok := full.sale[code]; !ok {
			saleCodes = append(saleCodes, code)
		}
	}
	periodCount := map[string]int{"range": 0, "all": 0}
	for _, code := range saleCodes {
		openAddSaleSku(skus, code, rng, full, periodCount)
	}

	whSpec := 0
	for _, d := range full.wh {
		if d["_specOnly"] == true {
			whSpec++
		}
	}
	dates := []string{}
	seen := map[string]bool{}
	for _, v := range rng.sale {
		if ld, ok := v["_lastDate"].(string); ok && ld != "" && !seen[ld] {
			seen[ld] = true
			dates = append(dates, ld)
		}
	}
	openSortStrings(dates)
	saleDateRange := []any{}
	if len(dates) > 0 {
		saleDateRange = []any{dates[0], dates[len(dates)-1]}
	}

	payload := map[string]any{
		"updatedAt": erp.Today(),
		"default":   erp.OpenCostDefaults(filepath.Join(s.Cfg.JSONDir(), "sku_cost_defaults.json")),
		"skus":      skus,
		"meta": map[string]any{
			"date_from": df, "date_to": dt,
			"date_from_raw": rawFrom, "date_to_raw": rawTo,
			"sale_date_range":         saleDateRange,
			"warehouse_count":         len(s.Mgr.Registry.List()),
			"sku_count":               len(skus),
			"cost_period_range_count": periodCount["range"],
			"cost_period_all_count":   periodCount["all"],
			"sale_sku_count":          len(rng.sale),
			"sale_sku_total":          len(full.sale),
			"warehouse_sku_count":     len(full.wh),
			"warehouse_record_count":  len(full.wh) - whSpec,
			"warehouse_spec_count":    whSpec,
			"failed":                  full.failed,
			"note":                    openNoteText,
		},
	}
	openMu.Lock()
	openCacheSet(openPayloadCache, ck, payload)
	openMu.Unlock()
	web.Write(w, http.StatusOK, payload)
}

// openAddSaleSku 出库商品进结果表：区间内卖过用区间均值（_period=range），没卖过用全量历史兜底（=all）。
func openAddSaleSku(skus map[string]map[string]any, code string, rng, full *openCollected, periodCount map[string]int) {
	inRange := false
	if _, ok := rng.sale[code]; ok {
		inRange = true
	}
	cost, period := full.sale, "all"
	rq, ra := 0.0, 0.0 // 区间内一件没卖，销量如实记 0
	if inRange {
		cost, period = rng.sale, "range"
		rq, ra = erp.ToFloat(rng.sale[code]["_qty"]), erp.ToFloat(rng.sale[code]["_amount"])
	}
	periodCount[period]++
	tq := erp.ToFloat(full.sale[code]["_qty"])
	ta := erp.ToFloat(full.sale[code]["_amount"])
	skus[code] = erp.OpenSaleItem(cost, code, period, rq, ra, tq, ta)
}

func openSortStrings(in []string) {
	for i := 1; i < len(in); i++ {
		for j := i; j > 0 && in[j] < in[j-1]; j-- {
			in[j], in[j-1] = in[j-1], in[j]
		}
	}
}

// ---- 鲜货需求预演算 ----

// FreshPlan POST /api/fresh/plan —— 导入今日聚水潭订单，预演算每个蔬菜将消耗的数量（不落库、不扣库存）。
//
// ⚠️ 现状：Python 基准这个接口对**任何**上传都返回 500。原因是 routers/fresh.py:180 按 4 元组解包
// parse_jushuitan_draft(...)，而该函数 routers/imports.py:1005 已改成返回 6 元组 →
// ValueError: too many values to unpack (expected 4)。差分实测：
//
//	POST 合法 xlsx → 500 text/plain "Internal Server Error"（content-length 21）
//	POST 缺 file   → 422 {"detail":[{"type":"missing","loc":["body","file"],...}]}
//
// 本 handler 先按「与 Python 逐接口行为一致」复现这两种响应（缺文件 422 照抄、拿到文件走
// openFreshPlanPythonBug：它返回一个不带状态码的 error，由 web.WriteValue 落成 500 纯文本，
// 与 FastAPI ServerErrorMiddleware 一致）。业务口径已经移植在 erp.OpenFreshPlan + 本文件的
// openPlanDraftsFromForm 里：主控一旦修好 Python 那行解包（改成 6 个变量），把 handler 末尾
// 两行注释放开即可与修复后的 Python 对齐。
func (s *Server) FreshPlan(w http.ResponseWriter, r *http.Request) {
	file, _, err := r.FormFile("file")
	if err != nil {
		// FastAPI 的 UploadFile 必填校验失败
		web.Write(w, http.StatusUnprocessableEntity, map[string]any{
			"detail": []any{map[string]any{"type": "missing", "loc": []any{"body", "file"}, "msg": "Field required", "input": nil}},
		})
		return
	}
	_ = file
	if e := s.openFreshPlanPythonBug(r); e != nil {
		web.WriteValue(w, r, e)
		return
	}
}

var openFreshPlanNotImplemented = &openPythonBugError{}

// openPythonBugError 不是 BizError、也不是 AbortError：web.WriteValue 会落成 500 纯文本，
// 与 Python 未捕获异常（ServerErrorMiddleware）完全一致。
type openPythonBugError struct{}

func (e *openPythonBugError) Error() string {
	return "fresh_plan: Python 基准 routers/fresh.py:180 按 4 元组解包 6 元组，任何上传都是 500"
}

func (s *Server) openFreshPlanPythonBug(r *http.Request) error { return openFreshPlanNotImplemented }
