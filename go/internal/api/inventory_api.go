package api

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
)

import (
	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// 本文件是库存流水/盘点/图表/概览/工作量接口，对齐 routers/inventory.py。

// 流水分页常量：一次最多取 20 万条参与合并/排序，返回 total 供前端翻页。
const (
	mvDefaultPage = 100
	mvMaxPage     = 1000
	mvFetchCap    = 200000
)

// Movements GET /api/movements（合并出库 → 关键字 → 排序 → 切片都在后端做，翻页时合计口径才不变）。
func (s *Server) Movements(w http.ResponseWriter, r *http.Request) {
	productID := web.QueryInt(r, "product_id", 0)
	dateFrom := web.Query(r, "date_from")
	dateTo := web.Query(r, "date_to")
	kwRaw := web.Query(r, "keyword")
	keyword := strings.ToLower(strings.TrimSpace(kwRaw))
	mergeOut := true;
	if v := web.Query(r, "merge_out"); v != "" {
		mergeOut = v != "0" && v != "false"
	}
	sortKey := web.Query(r, "sort")
	if !erp.IsMovementSortKey(sortKey) {
		sortKey = "date"
	}
	asc := web.Query(r, "dir") == "asc"
	limit := web.QueryInt(r, "limit", mvDefaultPage)
	if limit < 1 {
		limit = mvDefaultPage
	}
	if limit > mvMaxPage {
		limit = mvMaxPage
	}
	offset := web.QueryInt(r, "offset", 0)
	if offset < 0 {
		offset = 0
	}
	rows, truncated, err := erp.ListMovements(r.Context(), MustDB(r), productID, dateFrom, dateTo, mvFetchCap)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	if mergeOut {
		rows = erp.MergeOut(rows)
	}
	if keyword != "" {
		kept := []map[string]any{}
		for _, row := range rows {
			if strings.Contains(erp.MovementSearchText(row), keyword) {
				kept = append(kept, row)
			}
		}
		rows = kept
	}
	erp.SortMovements(rows, sortKey, asc)
	total := len(rows)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	page := rows[offset:end]
	for _, row := range page {
		delete(row, "_date_sort")
		if mg, ok := row["_merged"].(map[string]any); ok {
			if codes, ok := mg["codes"].([]string); ok && len(codes) > 12 {
				mg["more"] = len(codes) - 12
				mg["codes"] = codes[:12]
			}
		}
	}
	outDir := "desc"
	if asc {
		outDir = "asc"
	}
	web.Write(w, http.StatusOK, map[string]any{"total": total, "offset": offset, "limit": limit,
		"merged": mergeOut, "keyword": kwRaw, "sort": sortKey, "dir": outDir,
		"truncated": truncated, "rows": ListJSON(page)})
}

// MovementsChart GET /api/movements/chart（柱状图只统计真实库存进出）。
func (s *Server) MovementsChart(w http.ResponseWriter, r *http.Request) {
	out := erp.MovementsChart(r.Context(), MustDB(r), web.QueryInt(r, "product_id", 0), web.Query(r, "date_from"), web.Query(r, "date_to"))
	web.Write(w, http.StatusOK, out)
}

// Adjust POST /api/adjust（盘点：数量/均价/成本单价都只接受 +、- 开头的相对值）。
func (s *Server) Adjust(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	in := erp.ParseAdjustIn(body)
	// Python 的 AdjustIn.date 是必填字段；Go 侧按 400 拒收，不再静默补今天
	if !erp.ValidDate(strings.TrimSpace(in.Date)) {
		web.Error(w, http.StatusBadRequest, "日期格式应为 YYYY-MM-DD")
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		return erp.AdjustStock(ctx, tx, in, Operator(r))
	})
	if err != nil {
		if strings.Contains(err.Error(), "商品不存在") {
			web.Error(w, http.StatusNotFound, "商品不存在")
			return
		}
		web.WriteValue(w, r, Err400(err))
		return
	}
	web.Write(w, http.StatusOK, out)
}

// Adjustments GET /api/adjustments（盘点调整记录，按分组汇总）。
func (s *Server) Adjustments(w http.ResponseWriter, r *http.Request) {
	items, err := erp.ListAdjustments(r.Context(), MustDB(r), web.QueryInt(r, "product_id", 0), web.Query(r, "date_from"), web.Query(r, "date_to"))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, ListJSON(items))
}

// DeleteAdjustment DELETE /api/adjustments/{gid}（一键回退那次盘点）。
func (s *Server) DeleteAdjustment(w http.ResponseWriter, r *http.Request) {
	gid := PathInt(r, "gid")
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		n, err := erp.DeleteAdjustment(ctx, tx, gid)
		if err != nil {
			return nil, Err400(err)
		}
		return map[string]any{"ok": true, "deleted": n}, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// StockOverview GET /api/stock-overview（库存总览，裸数组）。
func (s *Server) StockOverview(w http.ResponseWriter, r *http.Request) {
	items, err := erp.StockOverview(r.Context(), MustDB(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, ListJSON(items))
}

// Workload GET /api/workload（人工/快递工作量统计）。
func (s *Server) Workload(w http.ResponseWriter, r *http.Request) {
	out, err := erp.Workload(r.Context(), MustDB(r), web.Query(r, "date_from"), web.Query(r, "date_to"))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}
