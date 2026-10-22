package api

import (
	"context"
	"database/sql"
	"io"
	"net/http"

	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// 本文件是入仓（仓内商品）接口：路径、方法、字段名与错误文案与 Python
// routers/warehouse_in.py 逐一对齐（入仓品资料 / 入仓台账 / 随货包材结算 / 贴单导入）。

// maxWhImportBytes 贴单导入的上传上限（与单据附件同量级，够放几千行明细）。
const maxWhImportBytes = 30 * 1024 * 1024

// registerWarehouseIn 挂入仓模块的全部接口。
//
// 路由按「注册顺序优先」匹配，所以字面量路径（deduction / products / batch-delete / import/*）
// 必须注册在 {rid}、{pid} 这类通配段之前，否则 /api/warehouse-in/products 会被 /{rid} 抢走。
func (s *Server) registerWarehouseIn(rt *router) {
	rt.Get("/api/warehouse-in/deduction", s.WarehouseInDeduction)
	rt.Get("/api/warehouse-in/products", s.WarehouseProducts)
	rt.Post("/api/warehouse-in/products", s.CreateWarehouseProduct)
	rt.Put("/api/warehouse-in/products/{pid}", s.UpdateWarehouseProduct)
	rt.Delete("/api/warehouse-in/products/{pid}", s.DeleteWarehouseProduct)
	rt.Get("/api/warehouse-in", s.WarehouseIns)
	rt.Post("/api/warehouse-in", s.CreateWarehouseIn)
	rt.Post("/api/warehouse-in/batch-delete", s.BatchDeleteWarehouseIns)
	rt.Post("/api/warehouse-in/import/preview", s.WarehouseInImportPreview)
	rt.Post("/api/warehouse-in/import/confirm", s.WarehouseInImportConfirm)
	rt.Put("/api/warehouse-in/{rid}", s.UpdateWarehouseIn)
	rt.Delete("/api/warehouse-in/{rid}", s.DeleteWarehouseIn)
}

// WarehouseInDeduction GET /api/warehouse-in/deduction
// 入仓品扣点百分比 + 本分仓默认贴单工作表（供入仓页文案与导入预览用）。
func (s *Server) WarehouseInDeduction(w http.ResponseWriter, r *http.Request) {
	percent, err := erp.WarehouseDeduction(r.Context(), MustDB(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	whKey := web.Warehouse(r)
	web.Write(w, http.StatusOK, map[string]any{
		"percent":       percent,
		"warehouse_key": whKey,
		"sheet":         erp.WhSheetFor(whKey),
	})
}

// WarehouseProducts GET /api/warehouse-in/products（按 id 正序，裸数组）。
func (s *Server) WarehouseProducts(w http.ResponseWriter, r *http.Request) {
	ctx, q := r.Context(), MustDB(r)
	list, err := erp.ListWarehouseProducts(ctx, q)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, p := range list {
		item, err := erp.WarehouseProductJSON(ctx, q, p)
		if err != nil {
			web.WriteValue(w, r, err)
			return
		}
		out = append(out, item)
	}
	web.Write(w, http.StatusOK, out)
}

// CreateWarehouseProduct POST /api/warehouse-in/products
func (s *Server) CreateWarehouseProduct(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, whProductFields)
	if payload == nil {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.CreateWarehouseProduct(ctx, tx, payload)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// UpdateWarehouseProduct PUT /api/warehouse-in/products/{pid}（全量覆盖，缺省字段回模型默认值）。
func (s *Server) UpdateWarehouseProduct(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, whProductFields)
	if payload == nil {
		return
	}
	pid := PathInt(r, "pid")
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.UpdateWarehouseProduct(ctx, tx, pid, payload)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteWarehouseProduct DELETE /api/warehouse-in/products/{pid}
func (s *Server) DeleteWarehouseProduct(w http.ResponseWriter, r *http.Request) {
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		return Err400(erp.DeleteWarehouseProduct(ctx, tx, PathInt(r, "pid")))
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, map[string]any{"ok": true})
}

// WarehouseIns GET /api/warehouse-in（date_from/date_to/q；明细 + 按入仓品汇总 + 合计）。
func (s *Server) WarehouseIns(w http.ResponseWriter, r *http.Request) {
	out, err := erp.ListWarehouseIn(r.Context(), MustDB(r),
		web.Query(r, "date_from"), web.Query(r, "date_to"), web.Query(r, "q"))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// CreateWarehouseIn POST /api/warehouse-in（操作员取当前登录账号；随货包材按 FIFO 结转成本并出流水）。
func (s *Server) CreateWarehouseIn(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, whInboundCreateFields)
	if payload == nil {
		return
	}
	op := Operator(r)
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		rec, err := erp.CreateWarehouseIn(ctx, tx, payload, op, "")
		if err != nil {
			return nil, Err400(err)
		}
		res, err := erp.WarehouseInJSON(ctx, tx, rec)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// UpdateWarehouseIn PUT /api/warehouse-in/{rid}（重算成本口径并重建随货包材结算流水）。
func (s *Server) UpdateWarehouseIn(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, whInboundUpdateFields)
	if payload == nil {
		return
	}
	rid := PathInt(r, "rid")
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.UpdateWarehouseIn(ctx, tx, rid, payload)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteWarehouseIn DELETE /api/warehouse-in/{rid}（回滚它带出的包材出库流水并重算库存）。
func (s *Server) DeleteWarehouseIn(w http.ResponseWriter, r *http.Request) {
	rid := PathInt(r, "rid")
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		return Err400(erp.DeleteWarehouseIn(ctx, tx, rid))
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, map[string]any{"ok": true})
}

// BatchDeleteWarehouseIns POST /api/warehouse-in/batch-delete（{ids:[...]} → {ok,deleted}）。
func (s *Server) BatchDeleteWarehouseIns(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, whBatchIdsFields)
	if payload == nil {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.BatchDeleteWarehouseIn(ctx, tx, erp.ParseIDs(payload))
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// WarehouseInImportPreview POST /api/warehouse-in/import/preview
// multipart：file=贴单 xlsx、sheet=可选工作表名、date=可选默认入仓日期。
func (s *Server) WarehouseInImportPreview(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxWhImportBytes); err != nil {
		web.Error(w, http.StatusUnprocessableEntity, "请求需为 multipart/form-data，字段名 file")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, _, err := r.FormFile("file")
	if err != nil {
		web.Error(w, http.StatusUnprocessableEntity, "缺少上传文件字段 file")
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, int64(maxWhImportBytes)+1))
	if err != nil {
		web.Error(w, http.StatusBadRequest, "读取文件失败")
		return
	}
	out, err := erp.WhImportPreview(r.Context(), MustDB(r), raw,
		r.FormValue("sheet"), r.FormValue("date"), web.Warehouse(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// WarehouseInImportConfirm POST /api/warehouse-in/import/confirm（逐行落库，单行失败只记进 failed）。
func (s *Server) WarehouseInImportConfirm(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, whConfirmFields)
	if payload == nil {
		return
	}
	op := Operator(r)
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.WhImportConfirm(ctx, tx, payload, op)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}
