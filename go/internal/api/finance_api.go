package api

import (
	"context"
	"database/sql"
	"net/http"
	"sort"
	"strings"
)

import (
	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// 本文件是财务流水（手动记账）接口，对齐 routers/report.py 的 /api/finance。
// 入库/出库自动生成的流水只能在源单据里改删，这里只处理 ref_type=manual。

// Finance GET /api/finance（按 id 倒序；wh=all 时合并各分仓流水并带 warehouse 字段）。
// 全仓/跨仓流水属于「重汇总」，走与 Python _heavy_cached 同语义的单飞 + 并发闸 + 60 秒短缓存。
func (s *Server) Finance(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	dateFrom := web.Query(r, "date_from")
	dateTo := web.Query(r, "date_to")
	if web.Query(r, "wh") == "all" {
		out, err := erp.HeavyCached(repKey("finance", "all", dateFrom, dateTo, false), func() (any, error) {
			rows := []map[string]any{}
			for _, wh := range s.Mgr.Registry.List() {
				db, err := s.Mgr.DB(wh.Key)
				if err != nil {
					continue // 单仓读取失败不拖累整体
				}
				items, err := s.financeRows(ctx, db, dateFrom, dateTo, wh.Name)
				if err != nil {
					continue
				}
				rows = append(rows, items...)
			}
			// 全仓合并后按日期倒序、同日期按 id 倒序
			sortFinanceRows(rows)
			return rows, nil
		})
		if err != nil {
			web.WriteValue(w, r, err)
			return
		}
		web.Write(w, http.StatusOK, out)
		return
	}
	whKey := s.Mgr.Registry.ResolveKey(web.Query(r, "wh"), web.Warehouse(r))
	out, err := erp.HeavyCached(repKey("finance", whKey, dateFrom, dateTo, false), func() (any, error) {
		return s.financeRows(ctx, MustDB(r), dateFrom, dateTo, "")
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// financeRows 一个库的财务流水（商品名用 join 直接取列，不实例化整棵对象树）。
func (s *Server) financeRows(ctx context.Context, q erp.Querier, dateFrom, dateTo, whName string) ([]map[string]any, error) {
	where := " WHERE 1=1"
	args := []any{}
	if dateFrom != "" {
		where += " AND f.date >= ?"
		args = append(args, dateFrom)
	}
	if dateTo != "" {
		where += " AND f.date <= ?"
		args = append(args, dateTo)
	}
	rows, err := q.QueryContext(ctx, "SELECT f.id, f.type, f.category, f.product_id, COALESCE(p.name,''), f.amount, f.date, COALESCE(f.operator,''), COALESCE(f.remark,''), COALESCE(f.ref_type,''), f.ref_id, COALESCE(f.pay_status,'paid'), COALESCE(f.paid_at,'') FROM finance_records f LEFT JOIN products p ON p.id = f.product_id"+where+" ORDER BY f.id DESC", args...);
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, kind string
		_ = kind
		var fid int
		var ftype, cat string
		var pid sql.NullInt64
		var pname string
		var amount float64
		var date, operator, remark, refType, payStatus, paidAt string
		var refID sql.NullInt64
		if err := rows.Scan(&fid, &ftype, &cat, &pid, &pname, &amount, &date, &operator, &remark, &refType, &refID, &payStatus, &paidAt); err != nil {
			return nil, err
		}
		_ = id
		row := map[string]any{"id": fid, "type": ftype, "category": cat, "product_id": nil, "product_name": pname,
			"amount": amount, "date": date, "operator": operator, "remark": remark, "ref_type": refType,
			"ref_id": nil, "pay_status": payStatus, "paid_at": paidAt}
		if pid.Valid {
			row["product_id"] = int(pid.Int64)
		}
		if refID.Valid {
			row["ref_id"] = int(refID.Int64)
		}
		if whName != "" {
			row["warehouse"] = whName
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// CreateFinance POST /api/finance（手动记账；操作员固定取当前账号）。
func (s *Server) CreateFinance(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	typ := strings.TrimSpace(erp.ToStr(body["type"]));
	if typ != "income" && typ != "expense" {
		web.Error(w, http.StatusBadRequest, "类型必须为 income 或 expense")
		return
	}
	amount := erp.ToFloat(body["amount"])
	if amount <= 0 {
		web.Error(w, http.StatusBadRequest, "金额必须大于 0")
		return
	}
	cat := strings.TrimSpace(erp.ToStr(body["category"]));
	if cat == "" {
		if typ == "income" {
			cat = "销售收入"
		} else {
			cat = "其他支出"
		}
	}
	// Python 的 FinanceIn.date 是必填；Go 侧统一 400（避免 date="" 的流水把按日聚合搞乱）
	date := strings.TrimSpace(erp.ToStr(body["date"]))
	if !erp.ValidDate(date) {
		web.Error(w, http.StatusBadRequest, "日期格式应为 YYYY-MM-DD")
		return
	}
	remark := strings.TrimSpace(erp.ToStr(body["remark"]));
	payStatus := "paid"
	if strings.TrimSpace(erp.ToStr(body["pay_status"])) == "unpaid" {
		payStatus = "unpaid"
	}
	paidAt := ""
	if payStatus == "paid" {
		paidAt = date
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := tx.ExecContext(ctx,
			"INSERT INTO finance_records (type, category, product_id, amount, date, operator, remark, ref_type, ref_id, created_at, pay_status, paid_at)"+
				" VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
			typ, cat, nil, amount, date, Operator(r), remark, "manual", nil, erp.NowDB(), payStatus, paidAt)
		if err != nil {
			return nil, err
		}
	id64, _ := res.LastInsertId()
		return map[string]any{"ok": true, "id": int(id64)}, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteFinance DELETE /api/finance/{fid}（自动生成的流水要在源单据里删）。
func (s *Server) DeleteFinance(w http.ResponseWriter, r *http.Request) {
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		fid := PathInt(r, "fid")
		var refType string
		row := tx.QueryRowContext(ctx, "SELECT COALESCE(ref_type,'') FROM finance_records WHERE id = ?", fid)
		if err := row.Scan(&refType); err == sql.ErrNoRows {
			return web.Abort(http.StatusNotFound, "财务记录不存在")
		} else if err != nil {
			return err
		}
		if refType != "manual" {
			return web.Abort(http.StatusBadRequest, "该记录由入库/出库自动生成，请在对应单据中删除")
		}
		_, err := tx.ExecContext(ctx, "DELETE FROM finance_records WHERE id = ?", fid)
		return err
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.OK(w, nil)
}

// sortFinanceRows 全仓合并后按日期倒序、同日期按 id 倒序（与 Python 一致）。
func sortFinanceRows(rows []map[string]any) {
	sort.SliceStable(rows, func(i, j int) bool {
		di, dj := web.ToStr(rows[i]["date"]), web.ToStr(rows[j]["date"])
		if di != dj {
			return di > dj
		}
		return web.ToInt(rows[i]["id"]) > web.ToInt(rows[j]["id"])
	})
}
