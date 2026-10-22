package erp

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ---------------- 入库单 ----------------

// Inbound 入库单（一张单 = 一个商品的一个批次）。
type Inbound struct {
	ID           int
	Code         string
	ProductID    int
	Unit         string
	Quantity     float64
	QuantityBase float64
	UnitPrice    float64
	TotalAmount  float64
	AdjustAmount float64
	Freight      float64
	Handling     float64
	Supplier     string
	Operator     string
	Date         string
	Remark       string
	PayStatus    string
	PaidAt       string
}

// LandedAmount 批次到岸成本 = 货款 + 运费 + 装卸费（金额调整不计入成本）。
func (r *Inbound) LandedAmount() float64 { return Round(r.TotalAmount+r.Freight+r.Handling, 2) }

// FinalAmount 实付金额 = 商品金额 + 金额调整（抹零/凑整）。
func (r *Inbound) FinalAmount() float64 { return Round(r.TotalAmount+r.AdjustAmount, 2) }

const inboundColumns = "id, code, product_id, unit, quantity, quantity_base, unit_price, total_amount, supplier, operator, date, remark, pay_status, paid_at, adjust_amount, freight, handling"

func scanInbound(scan func(dest ...any) error) (*Inbound, error) {
	var r Inbound
	var payStatus, paidAt sql.NullString
	err := scan(&r.ID, &r.Code, &r.ProductID, &r.Unit, &r.Quantity, &r.QuantityBase, &r.UnitPrice,
		&r.TotalAmount, &r.Supplier, &r.Operator, &r.Date, &r.Remark, &payStatus, &paidAt,
		&r.AdjustAmount, &r.Freight, &r.Handling)
	if err != nil {
		return nil, err
	}
	r.PayStatus = payStatus.String
	if r.PayStatus == "" {
		r.PayStatus = "paid"
	}
	r.PaidAt = paidAt.String
	return &r, nil
}

// GetInbound 按 id 取入库单。
func GetInbound(ctx context.Context, q Querier, id int) (*Inbound, error) {
	row := q.QueryRowContext(ctx, "SELECT "+inboundColumns+" FROM inbounds WHERE id = ?", id)
	r, err := scanInbound(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// ListInbounds 入库明细（按 id 倒序 = 录入顺序倒排），可按日期区间过滤。
func ListInbounds(ctx context.Context, q Querier, dateFrom, dateTo string) ([]*Inbound, error) {
	where := ""
	args := []any{}
	if dateFrom != "" {
		where += " AND date >= ?"
		args = append(args, dateFrom)
	}
	if dateTo != "" {
		where += " AND date <= ?"
		args = append(args, dateTo)
	}
	sqlText := "SELECT " + inboundColumns + " FROM inbounds WHERE 1=1" + where + " ORDER BY id DESC"
	rows, err := q.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Inbound
	for rows.Next() {
		r, err := scanInbound(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// InboundJSON 与 Python routers/inbound.py 的 _to_dict 字段完全一致。
func InboundJSON(r *Inbound, productName string) map[string]any {
	return map[string]any{
		"id":            r.ID,
		"code":          r.Code,
		"product_id":    r.ProductID,
		"product_name":  productName,
		"unit":          r.Unit,
		"quantity":      r.Quantity,
		"quantity_base": r.QuantityBase,
		"unit_price":    r.UnitPrice,
		"total_amount":  r.TotalAmount,
		"adjust_amount": Round(r.AdjustAmount, 2),
		"final_amount":  r.FinalAmount(),
		"freight":       Round(r.Freight, 2),
		"handling":      Round(r.Handling, 2),
		"landed_amount": r.LandedAmount(),
		"supplier":      r.Supplier,
		"operator":      r.Operator,
		"date":          r.Date,
		"remark":        r.Remark,
		"pay_status":    r.PayStatus,
		"paid_at":       r.PaidAt,
	}
}

// CreateInbound 创建入库单（含库存流水 + 财务记录 + 成本重算）。
// 与 Python services.create_inbound 同口径：运费/装卸费计入批次成本，金额调整另记「其他开支」。
func CreateInbound(ctx context.Context, q Querier, payload map[string]any, operator string) (*Inbound, error) {
	product, err := GetProduct(ctx, q, ToInt(payload["product_id"]))
	if errors.Is(err, ErrNotFound) {
		// Python: services.create_inbound 抛 ValueError("商品不存在") -> 路由层转 400
		return nil, ErrText("商品不存在")
	} else if err != nil {
		return nil, err
	}
	quantity := ToFloat(payload["quantity"])
	if quantity <= 0 {
		return nil, ErrText("数量必须大于 0")
	}
	unit := strings.TrimSpace(ToStr(payload["unit"]))
	unitPrice := ToFloat(payload["unit_price"])
	rawDate, hasDate := payload["date"]
	if !hasDate {
		return nil, ErrText("字段 'date' 缺失")
	}
	date := strings.TrimSpace(ToStr(rawDate))
	// 建单路径 Python 不做日期格式校验（只有 PUT /api/inbounds/{rid} 用 DATE_RE 校验），
	// 这里同样原样落库，否则同一请求体两边结果不同。
	qtyBase, err := UnitToBase(product, unit, quantity)
	if err != nil {
		return nil, err
	}
	amount := Round(quantity*unitPrice, 2)
	adjust := Round(ToFloat(payload["adjust_amount"]), 2)
	freight := Round(ToFloat(payload["freight"]), 2)
	handling := Round(ToFloat(payload["handling"]), 2)
	if freight < 0 || handling < 0 {
		return nil, ErrText("运费 / 装卸费不能为负数")
	}
	landed := Round(amount + freight + handling, 2)
	op := strings.TrimSpace(ToStr(payload["operator"]))
	if op == "" {
		op = operator
	}
	pay := PayFields(payload, date)
	code, err := GenInboundCode(ctx, q, date)
	if err != nil {
		return nil, err
	}
	res, err := q.ExecContext(ctx,
		"INSERT INTO inbounds (code, product_id, unit, quantity, quantity_base, unit_price, total_amount, supplier, operator, date, remark, created_at, pay_status, paid_at, adjust_amount, freight, handling) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		code, product.ID, unit, quantity, qtyBase, unitPrice, amount,
		strings.TrimSpace(ToStr(payload["supplier"])), op, date,
		strings.TrimSpace(ToStr(payload["remark"])), nowDB(), pay.PayStatus, pay.PaidAt, adjust, freight, handling)
	if err != nil {
		return nil, err
	}
	id64, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	rec := &Inbound{ID: int(id64), Code: code, ProductID: product.ID, Unit: unit, Quantity: quantity,
		QuantityBase: qtyBase, UnitPrice: unitPrice, TotalAmount: amount, AdjustAmount: adjust,
		Freight: freight, Handling: handling, Supplier: strings.TrimSpace(ToStr(payload["supplier"])),
		Operator: op, Date: date, Remark: strings.TrimSpace(ToStr(payload["remark"])),
		PayStatus: pay.PayStatus, PaidAt: pay.PaidAt}

	feeRemark := "入库 " + code
	if freight != 0 || handling != 0 {
		feeRemark += "（含运费/装卸 ¥" + FmtMoney(Round(freight+handling, 2)) + "）"
	}
	if _, err := q.ExecContext(ctx,
		"INSERT INTO stock_movements (product_id, move_type, quantity_base, amount, ref_type, ref_id, date, operator, remark, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
		product.ID, "in", qtyBase, landed, "inbound", rec.ID, date, op, feeRemark, nowDB()); err != nil {
		return nil, err
	}
	if _, err := q.ExecContext(ctx,
		"INSERT INTO finance_records (type, category, product_id, amount, date, operator, remark, ref_type, ref_id, created_at, pay_status, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
		"expense", "采购支出", product.ID, amount, date, op, "采购入库 "+code, "inbound", rec.ID, nowDB(), pay.PayStatus, pay.PaidAt); err != nil {
		return nil, err
	}
	if err := SyncAdjustExpense(ctx, q, "inbound", rec.ID, code, date, op, adjust, pay); err != nil {
		return nil, err
	}
	if err := SyncInboundFeeExpenses(ctx, q, rec, product.Name, pay); err != nil {
		return nil, err
	}
	if err := RecomputeProduct(ctx, q, product.ID); err != nil {
		return nil, err
	}
	return rec, nil
}

// UpdateInboundIn 是 PUT /api/inbounds/{id} 的请求体。
// 运费/装卸费为 nil 表示「不传 = 保持原值」；改动会重算该批次到岸成本与商品均价。
type UpdateInboundIn struct {
	Supplier  string
	Date      string
	PayStatus string
	Freight   *float64
	Handling  *float64
}

// UpdateInbound 手动修改入库单：只允许改 供应商 / 日期 / 付款状态 / 运费 / 装卸费
// （数量、单价变动须删除重建），操作员记为本次修改人。
// 运费/装卸费改动连带三件事：① 批次到岸成本 = 货款 + 运费 + 装卸 → 同步库存流水金额并重算均价；
// ② 「其他开支」镜像行金额跟着改；③ 报表期间费用按到岸成本取值，自然跟着变。
func UpdateInbound(ctx context.Context, q Querier, id int, in UpdateInboundIn, operator string) (*Inbound, error) {
	rec, err := GetInbound(ctx, q, id)
	if err != nil {
		return nil, err
	}
	date := strings.TrimSpace(in.Date)
	if !ValidDate(date) {
		return nil, ErrText("日期格式应为 YYYY-MM-DD")
	}
	pay := PayFields(map[string]any{"pay_status": in.PayStatus}, date)
	rec.Supplier = strings.TrimSpace(in.Supplier)
	rec.Date = date
	rec.Operator = operator // 记录为后来的修改人（忽略前端传值）
	rec.PayStatus, rec.PaidAt = pay.PayStatus, pay.PaidAt

	oldFee := Round(rec.Freight+rec.Handling, 2)
	freight, handling := Round(rec.Freight, 2), Round(rec.Handling, 2)
	if in.Freight != nil {
		freight = Round(*in.Freight, 2)
	}
	if in.Handling != nil {
		handling = Round(*in.Handling, 2)
	}
	if freight < 0 || handling < 0 {
		return nil, ErrText("运费 / 装卸费不能为负数")
	}
	rec.Freight, rec.Handling = freight, handling
	newFee := Round(freight+handling, 2)

	if _, err := q.ExecContext(ctx,
		"UPDATE inbounds SET supplier = ?, date = ?, operator = ?, pay_status = ?, paid_at = ?, freight = ?, handling = ? WHERE id = ?",
		rec.Supplier, rec.Date, rec.Operator, pay.PayStatus, pay.PaidAt, freight, handling, id); err != nil {
		return nil, err
	}
	// 日期/操作员/收付款状态同步到它带出的流水、财务、其他开支（含运费镜像行）
	if err := SyncDocEdit(ctx, q, "inbound", id, date, operator, pay); err != nil {
		return nil, err
	}
	if newFee != oldFee {
		landed := Round(rec.TotalAmount+newFee, 2)
		remark := "入库 " + rec.Code
		if newFee != 0 {
			remark += fmt.Sprintf("（含运费/装卸 ¥%s）", FmtMoney(newFee))
		}
		if _, err := q.ExecContext(ctx,
			"UPDATE stock_movements SET amount = ?, remark = ? WHERE ref_type = 'inbound' AND ref_id = ?",
			landed, remark, id); err != nil {
			return nil, err
		}
		// 金额变了 → 重算该品 FIFO 批次/均价（后续出库的结转成本按新成本重放）
		if err := RecomputeProduct(ctx, q, rec.ProductID); err != nil {
			return nil, err
		}
	}
	// 每项 >0 生成一行镜像、清零则删除（日期=入库单日期），幂等
	if err := SyncInboundFeeExpenses(ctx, q, rec, productName(ctx, q, rec.ProductID), pay); err != nil {
		return nil, err
	}
	return rec, nil
}

func productName(ctx context.Context, q Querier, pid int) string {
	if p, err := GetProduct(ctx, q, pid); err == nil {
		return p.Name
	}
	return ""
}

// DeleteInbound 删除入库单并清理它带出的流水/财务/其他开支，随后重算受影响商品。
func DeleteInbound(ctx context.Context, q Querier, id int) error {
	rec, err := GetInbound(ctx, q, id)
	if err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx, "DELETE FROM stock_movements WHERE ref_type = ? AND ref_id = ?", "inbound", id); err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx, "DELETE FROM finance_records WHERE ref_type = ? AND ref_id = ?", "inbound", id); err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx, "DELETE FROM other_expenses WHERE ref_type IN (?, ?) AND ref_id = ?", "inbound", InboundFeeRef, id); err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx, "DELETE FROM inbounds WHERE id = ?", id); err != nil {
		return err
	}
	if err := RecomputeProduct(ctx, q, rec.ProductID); err != nil {
		return err
	}
	return nil
}

// PurgeInbounds 批量删除入库单（主单 + 库存流水 + 财务流水 + 带出的其他开支）：
// 查询与删除按批合并，受影响商品去重后只在最后各重算一次。
func PurgeInbounds(ctx context.Context, q Querier, ids []int) (deleted int, missing int, affected []int, err error) {
	uniq := UniqueInts(ids)
	var existing []int
	affectedSet := map[int]bool{}
	affectedList := []int{}
	add := func(pid int) {
		if pid == 0 || affectedSet[pid] {
			return
		}
		affectedSet[pid] = true
		affectedList = append(affectedList, pid)
	}
	for _, part := range Chunk(uniq, 400) {
		ph, args := Placeholders(len(part)), ToArgs(part)
		var ids1 []int
		rows, err := q.QueryContext(ctx, "SELECT id FROM inbounds WHERE id IN ("+ph+")", args...)
		if err != nil {
			return 0, 0, nil, err
		}
		for rows.Next() {
			var id int
			if err := rows.Scan(&id); err == nil {
				ids1 = append(ids1, id)
			}
		}
		rows.Close()
		existing = append(existing, ids1...)
		rows2, err := q.QueryContext(ctx, "SELECT product_id FROM inbounds WHERE id IN ("+ph+")", args...)
		if err != nil {
			return 0, 0, nil, err
		}
		for rows2.Next() {
			var pid int
			if err := rows2.Scan(&pid); err == nil {
				add(pid)
			}
		}
		rows2.Close()
		rows3, err := q.QueryContext(ctx, "SELECT product_id FROM stock_movements WHERE ref_type = 'inbound' AND ref_id IN ("+ph+")", args...)
		if err != nil {
			return 0, 0, nil, err
		}
		for rows3.Next() {
			var pid int
			if err := rows3.Scan(&pid); err == nil {
				add(pid)
			}
		}
		rows3.Close()
	}
	for _, part := range Chunk(existing, 400) {
		ph, args := Placeholders(len(part)), ToArgs(part)
		stmts := []string{
			"DELETE FROM stock_movements WHERE ref_type = 'inbound' AND ref_id IN (" + ph + ")",
			"DELETE FROM finance_records WHERE ref_type = 'inbound' AND ref_id IN (" + ph + ")",
			"DELETE FROM other_expenses WHERE ref_type = 'inbound' AND ref_id IN (" + ph + ")",
			"DELETE FROM other_expenses WHERE ref_type = '" + InboundFeeRef + "' AND ref_id IN (" + ph + ")",
			"DELETE FROM inbounds WHERE id IN (" + ph + ")",
		}
		for _, s := range stmts {
			if _, err := q.ExecContext(ctx, s, args...); err != nil {
				return 0, 0, nil, err
			}
		}
	}
	for _, pid := range affectedList {
		if err := RecomputeProduct(ctx, q, pid); err != nil {
			return 0, 0, nil, err
		}
	}
	return len(existing), len(uniq) - len(existing), affectedList, nil
}
