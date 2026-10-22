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

// 本文件是工作台 / 鲜货 / 其他开支 / 扣点 / 快递规则 / 打包规则 / 账单 / 财务流水接口。

// Dashboard GET /api/dashboard（今日/本月汇总 + 低库存 + 最近单据）。
func (s *Server) Dashboard(w http.ResponseWriter, r *http.Request) {
	out, err := erp.Dashboard(r.Context(), MustDB(r), Operator(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// Fresh GET /api/fresh（鲜货现采；只按展示清单排序，不在查询时重算成本）。
func (s *Server) Fresh(w http.ResponseWriter, r *http.Request) {
	onlyList := web.QueryBool(r, "only_list", false)
	out, err := erp.FreshStock(r.Context(), MustDB(r), web.Warehouse(r), onlyList)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// FreshOptions GET /api/fresh/options（可加入展示清单的候选商品）。
func (s *Server) FreshOptions(w http.ResponseWriter, r *http.Request) {
	out, err := erp.FreshOptions(r.Context(), MustDB(r), web.Query(r, "scope"))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// SaveFreshConfig POST /api/fresh/config（写当前分仓的展示清单文件）。
func (s *Server) SaveFreshConfig(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	ids := erp.ParseIDs(body)
	if err := erp.SaveFreshConfig(web.Warehouse(r), ids); err != nil {
		web.WriteValue(w, r, Err400(err))
		return
	}
	web.Write(w, http.StatusOK, map[string]any{"ok": true, "count": len(ids)})
}

// OtherExpenses GET /api/other-expenses（裸数组，日期倒序）。
func (s *Server) OtherExpenses(w http.ResponseWriter, r *http.Request) {
	items, err := erp.ListOtherExpenses(r.Context(), MustDB(r), web.Query(r, "date_from"), web.Query(r, "date_to"), web.Query(r, "category"))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, ListJSON(items))
}

// OtherExpenseStats GET /api/other-expenses/stats（今日/本月不受区间影响）。
func (s *Server) OtherExpenseStats(w http.ResponseWriter, r *http.Request) {
	out, err := erp.OtherExpenseStats(r.Context(), MustDB(r), web.Query(r, "date_from"), web.Query(r, "date_to"))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// CreateOtherExpense POST /api/other-expenses。
func (s *Server) CreateOtherExpense(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		e, err := erp.CreateOtherExpense(ctx, tx, body, Operator(r))
		if err != nil {
			return nil, Err400(err)
		}
		return map[string]any{"ok": true, "item": e.JSON()}, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// UpdateOtherExpense PUT /api/other-expenses/{eid}。
func (s *Server) UpdateOtherExpense(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	n := PathInt(r, "eid")
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		e, err := erp.UpdateOtherExpense(ctx, tx, n, body, Operator(r))
		if err != nil {
			return nil, Err400(err)
		}
		return map[string]any{"ok": true, "item": e.JSON()}, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteOtherExpense DELETE /api/other-expenses/{eid}。
func (s *Server) DeleteOtherExpense(w http.ResponseWriter, r *http.Request) {
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		return Err400(erp.DeleteOtherExpense(ctx, tx, PathInt(r, "eid")))
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.OK(w, nil)
}

// Deductions GET /api/deductions（分类扣点，裸数组）。
func (s *Server) Deductions(w http.ResponseWriter, r *http.Request) {
	items, err := erp.ListDeductions(r.Context(), MustDB(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, ListJSON(items))
}

// UpsertDeduction POST /api/deductions（按类别名 upsert，返回裸对象）。
func (s *Server) UpsertDeduction(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		d, err := erp.UpsertDeduction(ctx, tx, body)
		if err != nil {
			return nil, Err400(err)
		}
		return d.JSON(), nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteDeduction DELETE /api/deductions/{did}。
func (s *Server) DeleteDeduction(w http.ResponseWriter, r *http.Request) {
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		return Err400(erp.DeleteDeduction(ctx, tx, PathInt(r, "did")))
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.OK(w, nil)
}

// ShopDeductions GET /api/deductions/shops（店铺扣点存在配置文件里，与 Python 共用同一份）。
func (s *Server) ShopDeductions(w http.ResponseWriter, r *http.Request) {
	rules, err := erp.LoadShopRules()
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	items := make([]map[string]any, 0, len(rules))
	for _, ru := range rules {
		items = append(items, ru.JSON())
	}
	if items == nil {
		items = []map[string]any{}
	}
	web.Write(w, http.StatusOK, map[string]any{"file": erp.DeductionConfigPath, "rules": items})
}

// UpsertShopDeduction POST /api/deductions/shops。
func (s *Server) UpsertShopDeduction(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	rules, err := erp.UpsertShopRule(body)
	if err != nil {
		web.WriteValue(w, r, Err400(err))
		return
	}
	writeShopRules(w, r, rules)
}

// DeleteShopDeduction DELETE /api/deductions/shops/{shop}（幂等）。
func (s *Server) DeleteShopDeduction(w http.ResponseWriter, r *http.Request) {
	rules, err := erp.DeleteShopRule(PathValue(r, "shop"))
	if err != nil {
		web.WriteValue(w, r, Err400(err))
		return
	}
	writeShopRules(w, r, rules)
}

func writeShopRules(w http.ResponseWriter, r *http.Request, rules []erp.ShopRule) {
	items := make([]map[string]any, 0, len(rules))
	for _, ru := range rules {
		items = append(items, ru.JSON())
	}
	web.Write(w, http.StatusOK, map[string]any{"ok": true, "rules": items})
}

// ExpressRule GET /api/express/rule。
func (s *Server) ExpressRule(w http.ResponseWriter, r *http.Request) {
	web.Write(w, http.StatusOK, erp.LoadExpressConfig())
}

// SaveExpressRule PUT /api/express/rule（写仓库根 json/express_config.json，与 Python 同一份）。
func (s *Server) SaveExpressRule(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	cfg, err := erp.SaveExpressConfig(body)
	if err != nil {
		web.WriteValue(w, r, Err400(err))
		return
	}
	web.Write(w, http.StatusOK, cfg)
}

// PackRules GET /api/pack-rules（一单多货规则，含停用）。
func (s *Server) PackRules(w http.ResponseWriter, r *http.Request) {
	items, err := erp.ListPackRules(r.Context(), MustDB(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, ListJSON(items))
}

// CreatePackRule POST /api/pack-rules（组合键由后端生成，返回裸对象）。
func (s *Server) CreatePackRule(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		return erp.CreatePackRule(ctx, tx, body)
	})
	if err != nil {
		web.WriteValue(w, r, Err400(err))
		return
	}
	web.Write(w, http.StatusOK, out)
}

// UpdatePackRule PUT /api/pack-rules/{rid}。
func (s *Server) UpdatePackRule(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	n := PathInt(r, "rid")
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		return erp.UpdatePackRule(ctx, tx, n, body)
	})
	if err != nil {
		web.WriteValue(w, r, Err400(err))
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeletePackRule DELETE /api/pack-rules/{rid}。
func (s *Server) DeletePackRule(w http.ResponseWriter, r *http.Request) {
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		return Err400(erp.DeletePackRule(ctx, tx, PathInt(r, "rid")))
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.OK(w, nil)
}

// Payables GET /api/payables?include_paid=0&days=30。
func (s *Server) Payables(w http.ResponseWriter, r *http.Request) {
	out, err := erp.Payables(r.Context(), MustDB(r), web.QueryBool(r, "include_paid", false), web.QueryInt(r, "days", 30))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// PayBill POST /api/payables/pay {kind,id,paid}。
func (s *Server) PayBill(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	kind := erp.ToStr(body["kind"])
	id := erp.ToInt(body["id"])
	paid := true;
	if v, ok := body["paid"]; ok {
		paid = erp.ToBool(v)
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		status, at, err := erp.MarkPaid(ctx, tx, kind, id, paid)
		if err != nil {
			return nil, Err400(err)
		}
		source := erp.PayableSourceName[kind]
		if source == "" {
			source = kind
		}
		return map[string]any{"ok": true, "kind": kind, "id": id, "source": source, "pay_status": status, "paid_at": at}, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// PayBillsBatch POST /api/payables/pay-batch {kind,ids,paid}。
func (s *Server) PayBillsBatch(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	kind := erp.ToStr(body["kind"])
	paid := true;
	if v, ok := body["paid"]; ok {
		paid = erp.ToBool(v)
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		return erp.MarkPaidBatch(ctx, tx, kind, erp.ParseIDs(body), paid)
	})
	if err != nil {
		web.WriteValue(w, r, Err400(err))
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DropshipBills GET /api/payables/dropship（代发应付，按商品+规格+日期分行）。
func (s *Server) DropshipBills(w http.ResponseWriter, r *http.Request) {
	out, err := erp.DropshipBills(r.Context(), MustDB(r), web.Query(r, "date_from"), web.Query(r, "date_to"),
		web.QueryBool(r, "include_paid", false), web.QueryInt(r, "limit", 300))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}
