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

// 本文件是入库单接口，路径与响应结构与 Python routers/inbound.py 一致（裸数组 / {ok,...} 逐一对应）。

// Inbounds GET /api/inbounds（按 id 倒序，带商品名）。
func (s *Server) Inbounds(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := MustDB(r)
	list, err := erp.ListInbounds(ctx, q, web.Query(r, "date_from"), web.Query(r, "date_to"))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	ids := make([]int, 0, len(list))
	for _, rec := range list {
		ids = append(ids, rec.ProductID)
	}
	briefs, err := erp.BriefsOf(ctx, q, ids)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, rec := range list {
		out = append(out, erp.InboundJSON(rec, briefs[rec.ProductID].Name))
	}
	web.Write(w, http.StatusOK, out)
}

// CreateInbound POST /api/inbounds（订单商品小类不可入库；操作员取当前账号）。
func (s *Server) CreateInbound(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		if err := RejectOrderProduct(ctx, tx, erp.ToInt(body["product_id"])); err != nil {
			return nil, Err400(err)
		}
		rec, err := erp.CreateInbound(ctx, tx, body, Operator(r))
		if err != nil {
			return nil, Err400(err)
		}
		briefs, _ := erp.BriefsOf(ctx, tx, []int{rec.ProductID})
		return erp.InboundJSON(rec, briefs[rec.ProductID].Name), nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// BatchCreateInbounds POST /api/inbounds/batch（一行一张单；单行失败不影响其它行，失败连行号返回）。
func (s *Server) BatchCreateInbounds(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	items := erp.MapSlice(body["items"])
	op := Operator(r)
	created := 0
	failed := []map[string]any{}
	ids := []int{}
	_, err = WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		for i, it := range items {
			no := i + 1;
			if err := RejectOrderProduct(ctx, tx, erp.ToInt(it["product_id"])); err != nil {
				failed = append(failed, map[string]any{"row": no, "reason": err.Error()})
				continue
			}
			newID := 0
			subErr := Savepoint(ctx, tx, func(tx *sql.Tx) error {
				rec, err := erp.CreateInbound(ctx, tx, it, op)
				if err != nil {
					return err
				}
				newID = rec.ID
				return nil
			})
			if subErr != nil {
				failed = append(failed, map[string]any{"row": no, "reason": subErr.Error()})
				continue
			}
			created++
			ids = append(ids, newID)
		}
		return nil, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, map[string]any{"ok": true, "created": created, "failed": failed,
		"failed_count": len(failed), "ids": ids})
}

// UpdateInbound PUT /api/inbounds/{rid}（只改供应商/日期/付款状态/运费/装卸费）。
func (s *Server) UpdateInbound(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	in := erp.UpdateInboundIn{Supplier: erp.ToStr(body["supplier"]), Date: erp.ToStr(body["date"]),
		PayStatus: erp.ToStr(body["pay_status"]), Freight: erp.OptFloat(body, "freight"), Handling: erp.OptFloat(body, "handling")}
	rid := PathInt(r, "rid")
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		rec, err := erp.UpdateInbound(ctx, tx, rid, in, Operator(r))
		if err != nil {
			return nil, NotFoundOr(err, "入库单不存在")
		}
		briefs, _ := erp.BriefsOf(ctx, tx, []int{rec.ProductID})
		return erp.InboundJSON(rec, briefs[rec.ProductID].Name), nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteInbound DELETE /api/inbounds/{rid}（连带删除它带出的流水/财务/其他开支镜像行）。
func (s *Server) DeleteInbound(w http.ResponseWriter, r *http.Request) {
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		return NotFoundOr(erp.DeleteInbound(ctx, tx, PathInt(r, "rid")), "入库单不存在")
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.OK(w, nil)
}

// BatchDeleteInbounds POST /api/inbounds/batch-delete。
func (s *Server) BatchDeleteInbounds(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		deleted, missing, _, err := erp.PurgeInbounds(ctx, tx, erp.ParseIDs(body))
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

// RejectOrderProduct 订单商品（小类）不能直接入库，必须入库它关联的库存大类。
func RejectOrderProduct(ctx context.Context, q erp.Querier, pid int) error {
	if pid <= 0 {
		return nil
	}
	p, err := erp.GetProduct(ctx, q, pid)
	if err != nil {
		return nil // 商品不存在时交给创建逻辑报错
	}
	if p.ProductType == "order" {
		return erp.ErrText("「%s」是订单商品（小类），请入库其关联的库存商品（大类）", p.Name)
	}
	return nil
}

// Savepoint 一行失败只回滚这一行（等价于 Python 的 db.begin_nested()）。
func Savepoint(ctx context.Context, tx *sql.Tx, fn func(*sql.Tx) error) error {
	const name = "sp_row"
	if _, err := tx.ExecContext(ctx, "SAVEPOINT "+name); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_, _ = tx.ExecContext(ctx, "ROLLBACK TO "+name)
		_, _ = tx.ExecContext(ctx, "RELEASE "+name)
		return err
	}
	_, _ = tx.ExecContext(ctx, "RELEASE "+name)
	return nil
}
