package api

import (
	"context"
	"net/http"
	"strconv"

	"wsfc-erp-go/internal/database"
	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// 本文件是经营分析报表接口，对齐 routers/report.py 的
//   GET /api/report/summary、GET /api/report/sales-by-spec、GET /api/report/all-warehouses
// 口径要点：只含「已付款」单据；每个分仓是独立账套，全仓口径逐仓算完再合并。

// repAllWH 与 Python report.py::ALL_WH 一致。
const repAllWH = "all"

// registerReport 由主控在 routes.go 的 register 里加一行：s.registerReport(rt)
func (s *Server) registerReport(rt *router) {
	rt.Get("/api/report/summary", s.ReportSummary)
	rt.Get("/api/report/sales-by-spec", s.ReportSalesBySpec)
	rt.Get("/api/report/all-warehouses", s.ReportAllWarehouses)
}

// repParams 报表公共查询参数（date_from / date_to / exclude_other）。
type repParams struct {
	dateFrom     string
	dateTo       string
	excludeOther bool
	wh           string
	sessionKey   string
}

func repReadParams(r *http.Request) repParams {
	return repParams{
		dateFrom: web.Query(r, "date_from"),
		dateTo:   web.Query(r, "date_to"),
		// Python: exclude_other: int = 0 → bool(exclude_other)，非 0 即排除
		excludeOther: web.QueryInt(r, "exclude_other", 0) != 0,
		wh:           web.Query(r, "wh"),
		sessionKey:   web.Warehouse(r),
	}
}

// repFailRow 单仓读取失败的记录（Python _each_warehouse 的 failed 元素）。
func repFailRow(wh database.Warehouse, err error) map[string]any {
	name := wh.Name
	if name == "" {
		name = wh.Key
	}
	return map[string]any{"key": wh.Key, "name": name, "error": "读取失败：" + err.Error()}
}

// repName 分仓显示名（Python current_warehouse_name）。
func (s *Server) repName(key string) string { return s.Mgr.Registry.Name(key) }

// repKey 重汇总缓存键，对齐 Python _heavy_cached 的元组键（接口 + 分仓 + 区间 + 口径）。
func repKey(route, wh, dateFrom, dateTo string, excludeOther bool) string {
	excl := 0
	if excludeOther {
		excl = 1
	}
	return route + "|" + wh + "|" + dateFrom + "|" + dateTo + "|" + strconv.Itoa(excl)
}

// ReportSummary GET /api/report/summary（wh=all 时合并所有分仓）。
func (s *Server) ReportSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := repReadParams(r)
	if p.wh == repAllWH {
		out, err := erp.HeavyCached(repKey("summary", repAllWH, p.dateFrom, p.dateTo, p.excludeOther), func() (any, error) {
			parts := []map[string]any{}
			failed := []map[string]any{}
			for _, item := range s.Mgr.Registry.List() {
				part, err := s.summaryOne(ctx, item.Key, p)
				if err != nil {
					failed = append(failed, repFailRow(item, err))
					continue
				}
				parts = append(parts, part)
			}
			return erp.MergeSummaries(parts, p.dateFrom, p.dateTo, failed), nil
		})
		if err != nil {
			web.WriteValue(w, r, err)
			return
		}
		web.Write(w, http.StatusOK, out)
		return
	}
	key := s.Mgr.Registry.ResolveKey(p.wh, p.sessionKey)
	out, err := erp.HeavyCached(repKey("summary", key, p.dateFrom, p.dateTo, p.excludeOther), func() (any, error) {
		return s.summaryOne(ctx, key, p)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// summaryOne 单个分仓的经营汇总（连接池取不到也按失败上抛，供全仓遍历降级）。
func (s *Server) summaryOne(ctx context.Context, key string, p repParams) (map[string]any, error) {
	db, err := s.Mgr.DB(key)
	if err != nil {
		return nil, err
	}
	return erp.SummaryOf(ctx, db, p.dateFrom, p.dateTo, key, s.repName(key), p.excludeOther, key == p.sessionKey)
}

// ReportSalesBySpec GET /api/report/sales-by-spec（出库明细：按天 × 规格；wh=all 合并全仓）。
func (s *Server) ReportSalesBySpec(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := repReadParams(r)
	if p.wh == repAllWH {
		parts := []erp.RepSalesPart{}
		failed := []map[string]any{}
		for _, item := range s.Mgr.Registry.List() {
			part, err := s.salesOne(ctx, item.Key, p)
			if err != nil {
				failed = append(failed, repFailRow(item, err))
				continue
			}
			parts = append(parts, *part)
		}
		web.Write(w, http.StatusOK, erp.SalesBySpecAll(parts, p.dateFrom, p.dateTo, failed))
		return
	}
	key := s.Mgr.Registry.ResolveKey(p.wh, p.sessionKey)
	part, err := s.salesOne(ctx, key, p)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, part.Data)
}

// salesOne 单个分仓的「日期 × 规格」出库明细。
func (s *Server) salesOne(ctx context.Context, key string, p repParams) (*erp.RepSalesPart, error) {
	db, err := s.Mgr.DB(key)
	if err != nil {
		return nil, err
	}
	return erp.SalesBySpecOf(ctx, db, p.dateFrom, p.dateTo, key, s.repName(key))
}

// ReportAllWarehouses GET /api/report/all-warehouses（全仓总览：每仓一行 + 合计）。
func (s *Server) ReportAllWarehouses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := repReadParams(r)
	out, err := erp.HeavyCached(repKey("all-warehouses", "", p.dateFrom, p.dateTo, p.excludeOther), func() (any, error) {
		items := []map[string]any{}
		okParts := []map[string]any{}
		for _, item := range s.Mgr.Registry.List() {
			row, err := s.overviewOne(ctx, item.Key, p)
			if err != nil {
				// 单个仓失败不拖累整体：只在该行标记 error
				items = append(items, repFailRow(item, err))
				continue
			}
			items = append(items, row)
			okParts = append(okParts, row)
		}
		return map[string]any{
			"date_from":             p.dateFrom,
			"date_to":               p.dateTo,
			"exclude_other_expense": p.excludeOther,
			"current":               p.sessionKey,
			"items":                 items,
			"total":                 erp.OverviewTotal(okParts),
		}, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// overviewOne 单个分仓的收入/支出/利润总览。
func (s *Server) overviewOne(ctx context.Context, key string, p repParams) (map[string]any, error) {
	db, err := s.Mgr.DB(key)
	if err != nil {
		return nil, err
	}
	return erp.OverviewOf(ctx, db, key, s.repName(key), p.dateFrom, p.dateTo, p.excludeOther)
}
