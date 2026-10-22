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

// 本文件是商品/单位/库存清单接口，路径与响应结构与 Python routers/products.py 完全一致。

// Products GET /api/products（裸数组，含停用商品）。
func (s *Server) Products(w http.ResponseWriter, r *http.Request) {
	items, err := erp.ListProductJSON(r.Context(), MustDB(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, ListJSON(items))
}

// CreateProduct POST /api/products（新建商品；返回体里的 last_in_* 恒为空，与 Python 一致）。
func (s *Server) CreateProduct(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		p, err := erp.CreateProduct(ctx, tx, erp.ParseProductIn(body))
		if err != nil {
			return nil, Err400(err)
		}
		return p.ProductJSON(ctx, tx, nil, nil), nil
	})
	if err != nil {
		if writeDetailErr(w, err) {
			return
		}
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// UpdateProduct PUT /api/products/{pid}。
func (s *Server) UpdateProduct(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	pid := PathInt(r, "pid")
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		p, err := erp.UpdateProduct(ctx, tx, pid, erp.ParseProductIn(body))
		if err != nil {
			return nil, Err400(NotFoundOr(err, "商品不存在"))
		}
		lastIn, _ := erp.LastInMap(ctx, tx)
		return p.ProductJSON(ctx, tx, lastIn, nil), nil
	})
	if err != nil {
		if writeDetailErr(w, err) {
			return
		}
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteProduct DELETE /api/products/{pid}（被引用时 400，detail 是多行文案）。
func (s *Server) DeleteProduct(w http.ResponseWriter, r *http.Request) {
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		return NotFoundOr(erp.DeleteProduct(ctx, tx, PathInt(r, "pid")), "商品不存在")
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.OK(w, nil)
}

// BatchDeleteProducts POST /api/products/batch-delete。
func (s *Server) BatchDeleteProducts(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		return erp.BatchDeleteProducts(ctx, tx, erp.ParseIDs(body))
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// BatchUpdateProducts POST /api/products/batch-update（null 字段不改）。
func (s *Server) BatchUpdateProducts(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		return erp.BatchUpdateProducts(ctx, tx, body)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// Units GET /api/units（裸数组；每次调用会先播种标准单位）。
func (s *Server) Units(w http.ResponseWriter, r *http.Request) {
	items, err := erp.ListUnits(r.Context(), MustDB(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, ListJSON(items))
}

// CreateUnit POST /api/units。
func (s *Server) CreateUnit(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		u, err := erp.CreateUnit(ctx, tx, body)
		if err != nil {
			return nil, Err400(err)
		}
		return u.JSON(), nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteUnit DELETE /api/units/{uid}。
func (s *Server) DeleteUnit(w http.ResponseWriter, r *http.Request) {
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		return Err400(erp.DeleteUnit(ctx, tx, PathInt(r, "uid")))
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.OK(w, nil)
}

// Stocks GET /api/stocks（库存大类清单，出库/入库选品用）。
func (s *Server) Stocks(w http.ResponseWriter, r *http.Request) {
	items, err := erp.StockProducts(r.Context(), MustDB(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, ListJSON(items))
}
