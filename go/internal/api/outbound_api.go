package api

import (
	"context"
	"database/sql"
	"net/http"
)

import (
	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// 本文件是出库单接口，对齐 routers/outbound.py：预览与提交共用同一套 FIFO 成本算法。

// PreviewOutbound POST /api/outbounds/preview（不落库，只返回成本/快递费/预警）。
func (s *Server) PreviewOutbound(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := erp.BuildOrder(r.Context(), MustDB(r), buildInputFrom(body, true))
	if err != nil {
		web.WriteValue(w, r, Err400(err))
		return
	}
	web.Write(w, http.StatusOK, out)
}

// Outbounds GET /api/outbounds（含明细行；g=批次号过滤。明细与商品名各用一条批量查询，不做 N+1）。
func (s *Server) Outbounds(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := MustDB(r)
	list, err := erp.ListOutbounds(ctx, q, web.Query(r, "date_from"), web.Query(r, "date_to"), web.Query(r, "g"))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	orderIDs := make([]int, 0, len(list))
	for _, rec := range list {
		orderIDs = append(orderIDs, rec.ID)
	}
	linesBy, err := erp.OutboundLinesByIDs(ctx, q, orderIDs)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	briefIDs := []int{}
	for _, lines := range linesBy {
		for _, ln := range lines {
			briefIDs = append(briefIDs, ln.ProductID)
			if ln.SaleProductID != nil {
				briefIDs = append(briefIDs, *ln.SaleProductID)
			}
		}
	}
	briefs, err := erp.BriefsOf(ctx, q, briefIDs)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, rec := range list {
		out = append(out, erp.OutboundJSON(rec, linesBy[rec.ID], briefs))
	}
	web.Write(w, http.StatusOK, out)
}

// CreateOutbound POST /api/outbounds（手动单：允许销售行直接选库存大类并扣它自己的库存）。
func (s *Server) CreateOutbound(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	op := Operator(r)
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		rec, warnings, affected, err := erp.CreateOutbound(ctx, tx, body, op, "", true, false)
		if err != nil {
			return nil, Err400(err)
		}
		lines, err := erp.GetOutboundLines(ctx, tx, rec.ID)
		if err != nil {
			return nil, err
		}
		ids := []int{}
		for _, ln := range lines {
			ids = append(ids, ln.ProductID)
			if ln.SaleProductID != nil {
				ids = append(ids, *ln.SaleProductID)
			}
		}
		for _, pid := range affected {
			ids = append(ids, pid)
		}
		briefs, _ := erp.BriefsOf(ctx, tx, ids)
		if warnings == nil {
			warnings = []string{}
		}
		return map[string]any{"order": erp.OutboundJSON(rec, lines, briefs), "warnings": warnings}, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// UpdateOutbound PUT /api/outbounds/{oid}（只改客户/日期/付款状态/实收口径）。
func (s *Server) UpdateOutbound(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	in := erp.UpdateOutboundIn{Customer: erp.ToStr(body["customer"]), Date: erp.ToStr(body["date"]),
		PayStatus: erp.ToStr(body["pay_status"])}
	if v, ok := body["settle_cats"]; ok {
		in.SettleCats = v;
		in.HasSettle = true
	}
	n := PathInt(r, "oid")
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		rec, err := erp.UpdateOutbound(ctx, tx, n, in, Operator(r))
		if err != nil {
			return nil, NotFoundOr(err, "出库单不存在")
		}
		lines, err := erp.GetOutboundLines(ctx, tx, rec.ID)
		if err != nil {
			return nil, err
		}
		ids := []int{}
		for _, ln := range lines {
			ids = append(ids, ln.ProductID)
			if ln.SaleProductID != nil {
				ids = append(ids, *ln.SaleProductID)
			}
		}
		briefs, _ := erp.BriefsOf(ctx, tx, ids)
		return erp.OutboundJSON(rec, lines, briefs), nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteOutbound DELETE /api/outbounds/{oid}（连带流水/财务/代发账单/其他开支镜像行）。
func (s *Server) DeleteOutbound(w http.ResponseWriter, r *http.Request) {
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		return NotFoundOr(erp.DeleteOutbound(ctx, tx, PathInt(r, "oid")), "出库单不存在")
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.OK(w, nil)
}

// BatchDeleteOutbounds POST /api/outbounds/batch-delete。
func (s *Server) BatchDeleteOutbounds(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		deleted, missing, _, err := erp.PurgeOutbounds(ctx, tx, erp.ParseIDs(body))
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "deleted": deleted, "missing": missing}, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// buildInputFrom 把请求体翻译成 BuildInput（预览与提交共用同一套算法）。
func buildInputFrom(body map[string]any, allowSelfStock bool) erp.BuildInput {
	autoExpress := true;
	if v, ok := body["auto_express"]; ok {
		autoExpress = erp.ToBool(v)
	}
	return erp.BuildInput{
		Lines: pickLines(body["lines"], saleLineKeys...), PackLines: pickLines(body["pack_lines"], packLineKeys...),
		FeeTotal: erp.OptFloat(body, "pack_fee_total"), AutoExpress: autoExpress,
		AllowSelfStock: allowSelfStock, ExtraPackLines: pickLines(body["extra_pack_lines"], packLineKeys...),
		SettleCats: body["settle_cats"],
		SettleProvided: erp.HasKey(body, "settle_cats") && body["settle_cats"] != nil,
	}
}

// Python 的 SaleLine/PackLine 只认这几个字段，请求里多带的键（spec、stock_product_id、multiplier…）
// 会被 pydantic 丢掉 —— 一单多货的覆盖只在内部导入路径生效，HTTP 不能让它漏进来。
var (
	saleLineKeys = []string{"product_id", "unit", "quantity", "price", "pack_fee"}
	packLineKeys = []string{"product_id", "unit", "quantity", "cogs"}
)

func pickLines(v any, keys ...string) []map[string]any {
	out := []map[string]any{}
	for _, m := range erp.MapSlice(v) {
		p := make(map[string]any, len(keys))
		for _, k := range keys {
			if x, ok := m[k]; ok {
				p[k] = x
			}
		}
		out = append(out, p)
	}
	return out
}
