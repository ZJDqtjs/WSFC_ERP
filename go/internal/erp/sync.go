package erp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
)

// 本文件是「单据带出的联动账」：单号、金额调整/运费装卸镜像行、代发应付账单、
// 客户代收结算收入，逐条对齐 Python services.py（同一段业务口径只能有一份事实源）。

// InboundFeeRef 入库运费/装卸费在「其他开支」里的镜像行来源标记（与金额调整的 "inbound" 区分，互不误伤）。
const InboundFeeRef = "inbound_fee"

// AdjustCategory 抹零/凑整自动生成的其他开支类型。
const AdjustCategory = "金额调整"

// SettleIncomeCat 客户随货款一起付回的关联结算（包材/人工/快递费）收入流水类别。
const SettleIncomeCat = "关联结算代收"

// Pay 单据付款状态：paid 已付款（直接进报表）/ unpaid 待付款（先进「待付款账单」）。
type Pay struct {
	PayStatus string
	PaidAt    string
}

// PayFields 解析 payload 的付款状态，口径同 Python pay_fields：
// 默认已付款；已付款且未填支付日期时，支付日期 = 单据日期；待付款时 paid_at 置空。
func PayFields(payload map[string]any, date string) Pay {
	status := "paid"
	if strings.TrimSpace(ToStr(payload["pay_status"])) == "unpaid" {
		status = "unpaid"
	}
	paidAt := strings.TrimSpace(ToStr(payload["paid_at"]))
	if paidAt == "" {
		if date != "" {
			paidAt = date
		} else {
			paidAt = strings.TrimSpace(ToStr(payload["date"]))
		}
	}
	if status == "unpaid" {
		paidAt = ""
	}
	return Pay{PayStatus: status, PaidAt: paidAt}
}

// ---------------- 单号 ----------------

// GenInboundCode 入库单号 RK{date}-{序号:03d}（date 原样拼进去，与 Python 一致）。
func GenInboundCode(ctx context.Context, q Querier, date string) (string, error) {
	return genCode(ctx, q, "inbounds", "RK", date)
}

// GenOutboundCode 出库单号 CK{date}-{序号:03d}。
func GenOutboundCode(ctx context.Context, q Querier, date string) (string, error) {
	return genCode(ctx, q, "outbounds", "CK", date)
}

func genCode(ctx context.Context, q Querier, table, prefix, date string) (string, error) {
	var count int
	if err := q.QueryRowContext(ctx,
		"SELECT COUNT(1) FROM "+table+" WHERE code LIKE ?", prefix+date+"%").Scan(&count); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s%s-%03d", prefix, date, count+1), nil
}

// ---------------- 金额调整 ----------------

// SyncAdjustExpense 维护单据「金额调整」对应的其他开支：调整为 0 删除，否则新建/更新为 |调整额|。
// 单据金额与商品成本都按原价不变，抹零/凑整的差额在这里单独记一笔支出，
// 于是报表口径 = 实收/实付，而 FIFO 批次成本不受影响。
func SyncAdjustExpense(ctx context.Context, q Querier, kind string, refID int, code, date, operator string, adjust float64, pay Pay) error {
	var ids []int
	rows, err := q.QueryContext(ctx,
		"SELECT id FROM other_expenses WHERE ref_type = ? AND ref_id = ? ORDER BY id", kind, refID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()

	amount := Round(math.Abs(adjust), 2)
	if amount <= 0 {
		return deleteIDs(ctx, q, "other_expenses", ids)
	}
	label := "出库"
	if kind == "inbound" {
		label = "入库"
	}
	sign := "-"
	if adjust > 0 {
		sign = "+"
	}
	remark := fmt.Sprintf("%s %s 金额调整 %s%s", label, code, sign, FmtQty(amount))
	if len(ids) > 0 {
		if _, err := q.ExecContext(ctx,
			"UPDATE other_expenses SET amount = ?, date = ?, remark = ?, operator = ?, pay_status = ?, paid_at = ? WHERE id = ?",
			amount, date, remark, operator, pay.PayStatus, pay.PaidAt, ids[0]); err != nil {
			return err
		}
		return deleteIDs(ctx, q, "other_expenses", ids[1:])
	}
	_, err = q.ExecContext(ctx,
		"INSERT INTO other_expenses (category, amount, date, remark, operator, created_at, pay_status, paid_at, ref_type, ref_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
		AdjustCategory, amount, date, remark, operator, nowDB(), pay.PayStatus, pay.PaidAt, kind, refID)
	return err
}

// ---------------- 入库运费/装卸费镜像行 ----------------

// SyncInboundFeeExpenses 维护入库单「运费 / 装卸费」的其他开支镜像行：
// 每项 >0 各一行、清零则删除；金额已计入批次到岸成本，所以报表期间费用排除这类镜像行。
func SyncInboundFeeExpenses(ctx context.Context, q Querier, rec *Inbound, productName string, pay Pay) error {
	for _, f := range []struct {
		label string
		amt   float64
	}{{"运费", Round(rec.Freight, 2)}, {"装卸费", Round(rec.Handling, 2)}} {
		var ids []int
		rows, err := q.QueryContext(ctx,
			"SELECT id FROM other_expenses WHERE ref_type = ? AND ref_id = ? AND category = ? ORDER BY id",
			InboundFeeRef, rec.ID, f.label)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id int
			if err := rows.Scan(&id); err == nil {
				ids = append(ids, id)
			}
		}
		rows.Close()
		if err := deleteIDs(ctx, q, "other_expenses", idsFrom(ids, 1)); err != nil {
			return err
		}
		if f.amt <= 0 {
			if err := deleteIDs(ctx, q, "other_expenses", idsFrom(ids, 0, 1)); err != nil {
				return err
			}
			continue
		}
		remark := fmt.Sprintf("入库 %s %s · %s（已计入批次成本）", rec.Code, f.label, productName)
		if len(ids) > 0 {
			if _, err := q.ExecContext(ctx,
				"UPDATE other_expenses SET amount = ?, date = ?, remark = ?, operator = ?, pay_status = ?, paid_at = ? WHERE id = ?",
				f.amt, rec.Date, remark, rec.Operator, pay.PayStatus, pay.PaidAt, ids[0]); err != nil {
				return err
			}
			continue
		}
		if _, err := q.ExecContext(ctx,
			"INSERT INTO other_expenses (category, amount, date, remark, operator, created_at, pay_status, paid_at, ref_type, ref_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
			f.label, f.amt, rec.Date, remark, rec.Operator, nowDB(), pay.PayStatus, pay.PaidAt, InboundFeeRef, rec.ID); err != nil {
			return err
		}
	}
	return nil
}

// ---------------- 单据修改后的连带同步 ----------------

// SyncDocEdit 单据被手动修改（供应商/客户、日期、付款状态）后，同步它带出的
// 库存流水 / 财务流水 / 其他开支 / 代发账单。FIFO 重放按流水 id 排序，改日期不改变结转成本。
func SyncDocEdit(ctx context.Context, q Querier, kind string, refID int, date, operator string, pay Pay) error {
	if _, err := q.ExecContext(ctx,
		"UPDATE stock_movements SET date = ?, operator = ? WHERE ref_type = ? AND ref_id = ?",
		date, operator, kind, refID); err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx,
		"UPDATE finance_records SET date = ?, operator = ?, pay_status = ?, paid_at = ? WHERE ref_type = ? AND ref_id = ?",
		date, operator, pay.PayStatus, pay.PaidAt, kind, refID); err != nil {
		return err
	}
	types := []string{kind}
	if kind == "inbound" {
		types = append(types, InboundFeeRef)
	}
	args := []any{date, operator, pay.PayStatus, pay.PaidAt}
	query := "UPDATE other_expenses SET date = ?, operator = ?, pay_status = ?, paid_at = ? WHERE ref_type IN (" +
		Placeholders(len(types)) + ") AND ref_id = ?"
	for _, t := range types {
		args = append(args, t)
	}
	args = append(args, refID)
	if _, err := q.ExecContext(ctx, query, args...); err != nil {
		return err
	}
	if kind == "outbound" { // 代发账单只跟日期/操作员（其付款状态是「付给代发方」，与本单收付无关）
		if _, err := q.ExecContext(ctx,
			"UPDATE dropship_bills SET date = ?, operator = ? WHERE outbound_id = ?",
			date, operator, refID); err != nil {
			return err
		}
	}
	return nil
}

// SyncSettleIncomeRecord 把「客户代收的关联结算」登记/更新成一条收入流水；金额为 0 时删掉这条流水。
func SyncSettleIncomeRecord(ctx context.Context, q Querier, rec *Outbound, date, operator string, pay Pay) error {
	var ids []int
	rows, err := q.QueryContext(ctx,
		"SELECT id FROM finance_records WHERE ref_type = ? AND ref_id = ? AND category = ? ORDER BY id",
		"outbound", rec.ID, SettleIncomeCat)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	amount := Round(rec.SettleIncome, 2)
	if amount <= 0 {
		return deleteIDs(ctx, q, "finance_records", ids)
	}
	remark := "关联结算代收 " + rec.Code
	if len(ids) > 0 {
		if _, err := q.ExecContext(ctx,
			"UPDATE finance_records SET amount = ?, date = ?, operator = ?, pay_status = ?, paid_at = ?, remark = ? WHERE id = ?",
			amount, date, operator, pay.PayStatus, pay.PaidAt, remark, ids[0]); err != nil {
			return err
		}
		return deleteIDs(ctx, q, "finance_records", ids[1:])
	}
	_, err = q.ExecContext(ctx,
		"INSERT INTO finance_records (type, category, product_id, amount, date, operator, remark, ref_type, ref_id, created_at, pay_status, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
		"income", SettleIncomeCat, nil, amount, date, operator, remark, "outbound", rec.ID, nowDB(), pay.PayStatus, pay.PaidAt)
	return err
}

// ---------------- 代发应付账单 ----------------

// SyncDropshipBills 按出库单的代发销售行重建「待付款 → 代发」应付账单（按商品 × 规格聚合）。
// 幂等：重复同步只刷新数值，已结清的付款状态保留；行不再属于代发或金额为 0 则删除。
func SyncDropshipBills(ctx context.Context, q Querier, rec *Outbound, saleLines []map[string]any) error {
	type bill struct {
		productID           int
		spec, unit, baseUnit string
		quantity, qtyBase   float64
		amount, saleAmount  float64
	}
	order := []string{}
	want := map[string]*bill{}
	for _, r := range saleLines {
		if !ToBool(r["is_dropship"]) {
			continue
		}
		amount := Round(ToFloat(r["cogs"]), 2)
		if amount <= 0 {
			continue
		}
		pid := ToInt(r["product_id"])
		spec := strings.TrimSpace(ToStr(r["spec"]))
		key := fmt.Sprintf("%d|%s", pid, spec)
		qty := ToFloat(r["quantity"])
		qtyBase := ToFloat(r["quantity_base"])
		saleAmount := ToFloat(r["amount"])
		if acc, ok := want[key]; ok {
			acc.quantity += qty
			acc.qtyBase += qtyBase
			acc.amount = Round(acc.amount+amount, 2)
			acc.saleAmount = Round(acc.saleAmount+saleAmount, 2)
		} else {
			want[key] = &bill{productID: pid, spec: spec, unit: strings.TrimSpace(ToStr(r["unit"])),
				baseUnit: strings.TrimSpace(ToStr(r["base_unit"])), quantity: qty, qtyBase: qtyBase,
				amount: amount, saleAmount: saleAmount}
			order = append(order, key)
		}
	}

	type existingBill struct {
		id                int
		productID         int
		spec              string
		payStatus, paidAt string
	}
	var existing []existingBill
	rows, err := q.QueryContext(ctx,
		"SELECT id, product_id, COALESCE(spec,''), pay_status, paid_at FROM dropship_bills WHERE outbound_id = ? ORDER BY id", rec.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var b existingBill
		if err := rows.Scan(&b.id, &b.productID, &b.spec, &b.payStatus, &b.paidAt); err == nil {
			existing = append(existing, b)
		}
	}
	rows.Close()
	byKey := map[string]existingBill{}
	for _, b := range existing {
		byKey[fmt.Sprintf("%d|%s", b.productID, strings.TrimSpace(b.spec))] = b
	}

	for _, key := range order {
		v := want[key]
		unitCost, salePrice := 0.0, 0.0
		if v.qtyBase != 0 {
			unitCost = Round(v.amount/v.qtyBase, 6)
		}
		if v.quantity != 0 {
			salePrice = Round(v.saleAmount/v.quantity, 6)
		}
		if b, ok := byKey[key]; ok {
			unit := v.unit
			baseUnit := v.baseUnit
			if _, err := q.ExecContext(ctx,
				"UPDATE dropship_bills SET quantity = ?, quantity_base = ?, unit_cost = ?, amount = ?, sale_price = ?, sale_amount = ?, date = ?, operator = ?, outbound_code = ?, unit = CASE WHEN ? = '' THEN unit ELSE ? END, base_unit = CASE WHEN ? = '' THEN base_unit ELSE ? END WHERE id = ?",
				v.quantity, v.qtyBase, unitCost, v.amount, salePrice, v.saleAmount, rec.Date, rec.Operator, rec.Code, unit, unit, baseUnit, baseUnit, b.id); err != nil {
				return err
			}
			delete(byKey, key)
			continue
		}
		name := ""
		if p, err := GetProduct(ctx, q, v.productID); err == nil {
			name = p.Name
		}
		if _, err := q.ExecContext(ctx,
			"INSERT INTO dropship_bills (outbound_id, outbound_code, date, product_id, product_name, spec, unit, base_unit, quantity, quantity_base, unit_cost, amount, sale_price, sale_amount, operator, pay_status, paid_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			rec.ID, rec.Code, rec.Date, v.productID, name, v.spec, v.unit, v.baseUnit, v.quantity, v.qtyBase,
			unitCost, v.amount, salePrice, v.saleAmount, rec.Operator, "unpaid", "", nowDB()); err != nil {
			return err
		}
	}
	stale := []int{}
	for k, b := range byKey {
		if _, ok := want[k]; !ok {
			stale = append(stale, b.id)
		}
	}
	return deleteIDs(ctx, q, "dropship_bills", stale)
}

// ---------------- 工具 ----------------

func deleteIDs(ctx context.Context, q Querier, table string, ids []int) error {
	if len(ids) == 0 {
		return nil
	}
	if _, err := q.ExecContext(ctx,
		"DELETE FROM "+table+" WHERE id IN ("+Placeholders(len(ids))+")", ToArgs(ids)...); err != nil {
		return err
	}
	return nil
}

func idsFrom(ids []int, from int, to ...int) []int {
	end := len(ids)
	if len(to) > 0 {
		end = to[0]
	}
	if from > len(ids) {
		from = len(ids)
	}
	if end > len(ids) {
		end = len(ids)
	}
	if end < from {
		end = from
	}
	return ids[from:end]
}

// ErrTextf 业务错误（handler 统一翻成 400 {"detail": "..."}）。
func ErrTextf(format string, args ...any) error {
	return errors.New(fmt.Sprintf(format, args...))
}

