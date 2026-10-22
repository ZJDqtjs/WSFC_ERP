package erp

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

// 本文件是「待付款账单」，对齐 routers/payables.py：
// 把入库/入仓/出库/其他开支/手动记账里的未结清单据聚合成一张待办账单；
// 标记已支付时会连带把单据自动生成的财务流水、其他开支镜像行一起结清。

// SettledListLimit 勾选「含已结清」时最多列多少张出库单（上万张会把接口与前端拖垮）。
const SettledListLimit = 1200

// PayableSourceName kind → 中文名。
var PayableSourceName = map[string]string{"inbound": "入库", "warehouse_in": "入仓", "outbound": "出库", "otherexp": "其他开支", "finance": "手动记账", "dropship": "代发", "dropship_item": "代发"}

// PayableSourcePage kind → 前端页面锚点。
var PayableSourcePage = map[string]string{"inbound": "inbound", "warehouse_in": "warehouse-in", "outbound": "outbound", "otherexp": "otherexp", "finance": "report", "dropship": "outbound"}

func payableRow(kind string, id int, date, title, sub string, amount float64, direction, payStatus, paidAt, operator, remark, code string) map[string]any {
	if payStatus == "" {
		payStatus = "paid"
	}
	return map[string]any{"kind": kind, "source": PayableSourceName[kind], "page": PayableSourcePage[kind],
		"id": id, "code": code, "date": date, "title": title, "sub": sub, "amount": Round2(amount),
		"direction": direction, "pay_status": payStatus, "paid_at": paidAt, "operator": operator, "remark": remark}
}

// payWhere 付款状态过滤下推到 SQL（空状态按「已付款」看待）。
func payWhere(includePaid bool, cutoff string) string {
	if !includePaid {
		return " AND COALESCE(pay_status,'paid') = 'unpaid'"
	}
	return " AND (COALESCE(pay_status,'paid') = 'unpaid' OR (COALESCE(pay_status,'paid') <> 'unpaid' AND COALESCE(NULLIF(paid_at,''), date) >= ?))"
}

func payableStrings(includePaid bool, cutoff string) []any {
	if includePaid {
		return []any{cutoff}
	}
	return []any{}
}

// Payables 账单列表：未结清在前（按日期倒序），已结清在后（按结清日倒序）。
func Payables(ctx context.Context, q Querier, includePaid bool, days int) (map[string]any, error) {
	if days < 1 {
		days = 1;
	}
	if days == 0 {
		days = 30
	}
	cutoff := ShiftDate(Today(), -days)
	rows := []map[string]any{}
	// 入库：应付 = 实付（货款 + 抹零/凑整 + 运费 + 装卸费；运费/装卸的镜像其他开支不单独列）
	irs, err := q.QueryContext(ctx, "SELECT i.id, COALESCE(i.date,''), COALESCE(p.name,''), i.quantity, COALESCE(i.unit,''), COALESCE(i.supplier,''), COALESCE(i.total_amount,0), COALESCE(i.adjust_amount,0), COALESCE(i.freight,0), COALESCE(i.handling,0), COALESCE(i.pay_status,''), COALESCE(i.paid_at,''), COALESCE(i.operator,''), COALESCE(i.remark,''), i.code FROM inbounds i LEFT JOIN products p ON p.id = i.product_id WHERE 1=1"+payWhere(includePaid, cutoff), payableStrings(includePaid, cutoff)...);
	if err != nil {
		return nil, err
	}
	for irs.Next() {
		var id int
		var date, name, unit, supplier, payStatus, paidAt, operator, remark, code string
		var qty, total, adjust, freight, handling float64
		if err := irs.Scan(&id, &date, &name, &qty, &unit, &supplier, &total, &adjust, &freight, &handling, &payStatus, &paidAt, &operator, &remark, &code); err != nil {
			continue
		}
		title := strings.TrimSpace(fmt.Sprintf("%s × %s%s", name, FmtQty(qty), unit))
		sub := "采购入库"
		if supplier != "" {
			sub = "供应商 " + supplier
		}
		rows = append(rows, payableRow("inbound", id, date, title, sub, total+adjust+freight+handling, "out", payStatus, paidAt, operator, remark, code))
	}
	irs.Close()
	// 入仓（卖到京东仓）：应收
	irs2, err := q.QueryContext(ctx, "SELECT id, COALESCE(date,''), COALESCE(product_name,''), quantity, COALESCE(unit,'袋'), COALESCE(purchase_no,''), COALESCE(center,''), COALESCE(freight_total,0), COALESCE(amount,0), COALESCE(pay_status,''), COALESCE(paid_at,''), COALESCE(operator,''), COALESCE(remark,''), COALESCE(code,'') FROM warehouse_ins WHERE 1=1"+payWhere(includePaid, cutoff), payableStrings(includePaid, cutoff)...);
	if err != nil {
		return nil, err
	}
	for irs2.Next() {
		var id int
		var date, pname, unit, purchaseNo, center, payStatus, paidAt, operator, remark, code string
		var qty, freightTotal, amount float64
		if err := irs2.Scan(&id, &date, &pname, &qty, &unit, &purchaseNo, &center, &freightTotal, &amount, &payStatus, &paidAt, &operator, &remark, &code); err != nil {
			continue
		}
		parts := []string{}
		if purchaseNo != "" {
			parts = append(parts, "采购单 "+purchaseNo)
		}
		if center != "" {
			parts = append(parts, center)
		}
		sub := "入仓"
		if len(parts) > 0 {
			sub = strings.Join(parts, " / ")
		}
		if freightTotal != 0 {
			sub += fmt.Sprintf("（含运费 ¥%.2f）", Round2(freightTotal))
		}
		title := fmt.Sprintf("%s × %s%s", pname, FmtQty(qty), unit)
		rows = append(rows, payableRow("warehouse_in", id, date, title, sub, amount, "in", payStatus, paidAt, operator, remark, code))
	}
	irs2.Close()
	// 出库：应收 = 销售收入 + 金额调整 + 代收的包材/人工/快递
	limitSQL := ""
	if includePaid {
		limitSQL = fmt.Sprintf(" LIMIT %d", SettledListLimit)
	}
	ors, err := q.QueryContext(ctx, "SELECT id, code, COALESCE(date,''), COALESCE(customer,''), COALESCE(total_amount,0), COALESCE(adjust_amount,0), COALESCE(settle_income,0), COALESCE(pay_status,''), COALESCE(paid_at,''), COALESCE(operator,''), COALESCE(remark,'') FROM outbounds WHERE 1=1"+payWhere(includePaid, cutoff)+" ORDER BY date DESC, id DESC"+limitSQL, payableStrings(includePaid, cutoff)...);
	if err != nil {
		return nil, err
	}
	type obRec struct {
		id                          int
		code, date, customer        string
		total, adjust, settle       float64
		payStatus, paidAt, operator, remark string
	}
	var obs []obRec
	var obIDs []int
	for ors.Next() {
		var o obRec
		if err := ors.Scan(&o.id, &o.code, &o.date, &o.customer, &o.total, &o.adjust, &o.settle, &o.payStatus, &o.paidAt, &o.operator, &o.remark); err != nil {
			continue
		}
		obs = append(obs, o)
		obIDs = append(obIDs, o.id)
	}
	ors.Close()
	// 标题只取「首个销售行」+ 销售行数：出库明细上万行，没必要整棵树加载
	saleName := map[int]string{}
	saleQty := map[int]float64{}
	saleUnit := map[int]string{}
	saleCnt := map[int]int{}
	for _, part := range Chunk(obIDs, 400) {
		sql2 := "SELECT l.outbound_id, COUNT(1) FROM outbound_lines l WHERE l.line_type = 'sale' AND l.outbound_id IN (" + Placeholders(len(part)) + ") GROUP BY l.outbound_id";
		rs, err := q.QueryContext(ctx, sql2, ToArgs(part)...);
		if err == nil {
			for rs.Next() {
				var oid, n int
				if err := rs.Scan(&oid, &n); err == nil {
					saleCnt[oid] = n
				}
			}
			rs.Close()
		}
		sql3 := "SELECT l.outbound_id, COALESCE(p.name,''), l.quantity, COALESCE(l.unit,'') FROM outbound_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.line_type = 'sale' AND l.outbound_id IN (" + Placeholders(len(part)) + ") ORDER BY l.outbound_id, l.id";
		rs2, err := q.QueryContext(ctx, sql3, ToArgs(part)...);
		if err == nil {
			seen := map[int]bool{}
			for rs2.Next() {
				var oid int
				var nm, un string
				var qq float64
				if err := rs2.Scan(&oid, &nm, &qq, &un); err != nil {
					continue
				}
				if seen[oid] {
					continue
				}
				seen[oid] = true
				if nm == "" {
					nm = "销售"
				}
				saleName[oid] = nm
				saleQty[oid] = qq
				saleUnit[oid] = un
			}
			rs2.Close()
		}
	}
	for _, o := range obs {
		n := saleCnt[o.id]
		title := ""
		if n > 0 {
			name := saleName[o.id]
			if name == "" {
				name = "销售"
			}
			title = strings.TrimSpace(fmt.Sprintf("%s × %s%s", name, FmtQty(saleQty[o.id]), saleUnit[o.id]))
			if n > 1 {
				title += fmt.Sprintf(" 等 %d 项", n)
			}
		} else {
			title = "出库单 " + o.code
		}
		sub := "销售出库"
		if o.customer != "" {
			sub = "客户 " + o.customer
		}
		rows = append(rows, payableRow("outbound", o.id, o.date, title, sub, o.total+o.adjust+o.settle, "in", o.payStatus, o.paidAt, o.operator, o.remark, o.code))
	}
	// 其他开支只列手工登记的（单据带出的金额调整/运费镜像随主单结算）
	oes, err := q.QueryContext(ctx, "SELECT id, COALESCE(date,''), category, COALESCE(amount,0), COALESCE(pay_status,''), COALESCE(paid_at,''), COALESCE(operator,''), COALESCE(remark,'') FROM other_expenses WHERE COALESCE(ref_type,'') = ''"+payWhere(includePaid, cutoff), payableStrings(includePaid, cutoff)...);
	if err != nil {
		return nil, err
	}
	for oes.Next() {
		var id int
		var date, cat, payStatus, paidAt, operator, remark string
		var amount float64
		if err := oes.Scan(&id, &date, &cat, &amount, &payStatus, &paidAt, &operator, &remark); err != nil {
			continue
		}
		rows = append(rows, payableRow("otherexp", id, date, cat, "其他开支", amount, "out", payStatus, paidAt, operator, remark, ""))
	}
	oes.Close()
	// 手动记账：自动生成的流水由来源单据代表，不重复列
	frs, err := q.QueryContext(ctx, "SELECT id, COALESCE(date,''), category, COALESCE(amount,0), type, COALESCE(pay_status,''), COALESCE(paid_at,''), COALESCE(operator,''), COALESCE(remark,'') FROM finance_records WHERE ref_type = 'manual'"+payWhere(includePaid, cutoff), payableStrings(includePaid, cutoff)...);
	if err != nil {
		return nil, err
	}
	for frs.Next() {
		var id int
		var date, cat, typ, payStatus, paidAt, operator, remark string
		var amount float64
		if err := frs.Scan(&id, &date, &cat, &amount, &typ, &payStatus, &paidAt, &operator, &remark); err != nil {
			continue
		}
		label := "支出"
		direction := "out"
		if typ == "income" {
			label = "收入"
			direction = "in"
		}
		rows = append(rows, payableRow("finance", id, date, cat, "手动记账 · "+label, amount, direction, payStatus, paidAt, operator, remark, ""))
	}
	frs.Close()
	// 代发不进这张通用列表（量太大），有专门的 /api/payables/dropship 页签
	unpaid, paid := []map[string]any{}, []map[string]any{}
	for _, r := range rows {
		if ToStr(r["pay_status"]) == "unpaid" {
			unpaid = append(unpaid, r)
		} else {
			paid = append(paid, r)
		}
	}
	sort.SliceStable(unpaid, func(i, j int) bool { return ToStr(unpaid[i]["date"]) > ToStr(unpaid[j]["date"]) })
	sort.SliceStable(paid, func(i, j int) bool {
		ki := ToStr(paid[i]["paid_at"])
		if ki == "" {
			ki = ToStr(paid[i]["date"])
		}
		kj := ToStr(paid[j]["paid_at"])
		if kj == "" {
			kj = ToStr(paid[j]["date"])
		}
		return ki > kj
	})
	sumOf := func(list []map[string]any, dir string) float64 {
		t := 0.0;
		for _, r := range list {
			if ToStr(r["direction"]) == dir {
				t += ToFloat(r["amount"])
			}
		}
		return Round2(t)
	}
	items := append(append([]map[string]any{}, unpaid...), paid...)
	return map[string]any{"items": items, "total": map[string]any{"unpaid_count": len(unpaid),
		"payables_amount": sumOf(unpaid, "out"), "receivables_amount": sumOf(unpaid, "in"), "paid_count": len(paid)}}, nil
}

// MarkPaid 标记已支付/撤销；入库出库会连带把自动生成的财务流水与其他开支一起结清。
func MarkPaid(ctx context.Context, q Querier, kind string, rid int, paid bool) (string, string, error) {
	status := "unpaid"
	if paid {
		status = "paid"
	}
	paidAt := ""
	if paid {
		paidAt = Today()
	}
	switch kind {
	case "dropship_item":
		var n int
		if err := q.QueryRowContext(ctx, "SELECT id FROM dropship_bills WHERE id = ?", rid).Scan(&n); err == sql.ErrNoRows {
			return "", "", Err404("账单不存在")
		}
		_, err := q.ExecContext(ctx, "UPDATE dropship_bills SET pay_status = ?, paid_at = ? WHERE id = ?", status, paidAt, rid)
		return status, paidAt, err
	case "dropship":
		var n int
		if err := q.QueryRowContext(ctx, "SELECT COUNT(1) FROM dropship_bills WHERE outbound_id = ?", rid).Scan(&n); err != nil || n == 0 {
			return "", "", Err404("账单不存在")
		}
		_, err := q.ExecContext(ctx, "UPDATE dropship_bills SET pay_status = ?, paid_at = ? WHERE outbound_id = ?", status, paidAt, rid)
		return status, paidAt, err
	}
	table := map[string]string{"inbound": "inbounds", "warehouse_in": "warehouse_ins", "outbound": "outbounds", "otherexp": "other_expenses", "finance": "finance_records"}[kind]
	if table == "" {
		return "", "", ErrText("未知的账单类型")
	}
	var exists int
	if err := q.QueryRowContext(ctx, "SELECT id FROM "+table+" WHERE id = ?", rid).Scan(&exists); err == sql.ErrNoRows {
		return "", "", Err404("账单不存在")
	}
	if _, err := q.ExecContext(ctx, "UPDATE "+table+" SET pay_status = ?, paid_at = ? WHERE id = ?", status, paidAt, rid); err != nil {
		return "", "", err
	}
	if kind == "inbound" || kind == "outbound" {
		if _, err := q.ExecContext(ctx, "UPDATE finance_records SET pay_status = ?, paid_at = ? WHERE ref_type = ? AND ref_id = ?", status, paidAt, kind, rid); err != nil {
			return "", "", err
		}
		types := []string{kind}
		if kind == "inbound" {
			types = append(types, InboundFeeRef)
		}
		sqlU := "UPDATE other_expenses SET pay_status = ?, paid_at = ? WHERE ref_type IN (" + Placeholders(len(types)) + ") AND ref_id = ?";
		args := append([]any{status, paidAt}, StringArgs(types)...)
		args = append(args, rid)
		if _, err := q.ExecContext(ctx, sqlU, args...); err != nil {
			return "", "", err
		}
	}
	return status, paidAt, nil
}

// MarkPaidBatch 批量结清/撤销（ids 去重保序）。
func MarkPaidBatch(ctx context.Context, q Querier, kind string, ids []int, paid bool) (map[string]any, error) {
	ids = UniqueInts(ids)
	if len(ids) == 0 {
		return nil, ErrText("请先勾选要处理的账单")
	}
	updated, missing := 0, 0;
	for _, id := range ids {
		if _, _, err := MarkPaid(ctx, q, kind, id, paid); err != nil {
			if strings.Contains(err.Error(), "账单不存在") {
				missing++
				continue
			}
			return nil, err
		}
		updated++
	}
	return map[string]any{"ok": true, "kind": kind, "updated": updated, "missing": missing}, nil
}

// DropshipBills 代发应付：按「商品 + 规格 + 单位 + 出库日期」分行（同款按天分列，付款核对更清晰）。
func DropshipBills(ctx context.Context, q Querier, dateFrom, dateTo string, includePaid bool, limit int) (map[string]any, error) {
	where := " WHERE 1=1"
	args := []any{}
	if dateFrom != "" {
		where += " AND date >= ?"
		args = append(args, dateFrom)
	}
	if dateTo != "" {
		where += " AND date <= ?"
		args = append(args, dateTo)
	}
	if !includePaid {
		where += " AND COALESCE(pay_status,'unpaid') = 'unpaid'"
	}
	rows, err := q.QueryContext(ctx, "SELECT id, outbound_id, date, product_id, product_name, spec, unit, base_unit, quantity, quantity_base, unit_cost, amount, sale_price, sale_amount, operator, COALESCE(pay_status,'unpaid'), paid_at FROM dropship_bills"+where+" ORDER BY date DESC, id DESC", args...);
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type key struct {
		pid      int
		spec, un string
		day      string
	}
	groups := map[key]map[string]any{}
	order := []key{}
	for rows.Next() {
		var id, oid, pid int
		var date, pname, spec, unit, baseUnit, payStatus, paidAt, operator string
		var qty, qtyBase, unitCost, amount, salePrice, saleAmount float64
		if err := rows.Scan(&id, &oid, &date, &pid, &pname, &spec, &unit, &baseUnit, &qty, &qtyBase, &unitCost, &amount, &salePrice, &saleAmount, &operator, &payStatus, &paidAt); err != nil {
			continue
		}
		spec = strings.TrimSpace(spec)
		unit = strings.TrimSpace(unit)
		date = strings.TrimSpace(date)
		k := key{pid, spec, unit, date}
		g, ok := groups[k]
		if !ok {
			g = map[string]any{"product_id": pid, "product_name": pname, "spec": spec, "unit": unit, "date": date,
				"base_unit": baseUnit, "quantity": 0.0, "quantity_base": 0.0, "amount": 0.0, "sale_amount": 0.0,
				"sale_price": 0.0, "unit_cost": 0.0, "unpaid": 0, "paid_at": "", "operator": "", "_orders": map[int]bool{}, "_bills": []int{}}
			groups[k] = g
			order = append(order, k)
		}
		g["quantity"] = ToFloat(g["quantity"]) + qty
		g["quantity_base"] = ToFloat(g["quantity_base"]) + qtyBase
		g["amount"] = Round2(ToFloat(g["amount"]) + amount)
		g["sale_amount"] = Round2(ToFloat(g["sale_amount"]) + saleAmount)
		g["_orders"].(map[int]bool)[oid] = true
		g["_bills"] = append(g["_bills"].([]int), id)
		if payStatus == "unpaid" {
			g["unpaid"] = ToInt(g["unpaid"]) + 1
		} else if paidAt > ToStr(g["paid_at"]) {
			g["paid_at"] = paidAt
		}
		if ToStr(g["operator"]) == "" {
			g["operator"] = operator
		}
		if ToFloat(g["unit_cost"]) == 0 {
			g["unit_cost"] = Round(unitCost, 6)
		}
		if ToFloat(g["sale_price"]) == 0 {
			g["sale_price"] = Round(salePrice, 4)
		}
	}
	out := []map[string]any{}
	for _, k := range order {
		g := groups[k]
		qty := Round(ToFloat(g["quantity"]), 4)
		orders := g["_orders"].(map[int]bool)
		ids := []int{}
		for oid := range orders {
			ids = append(ids, oid)
		}
	sort.Ints(ids)
		unitPrice := 0.0;
		if qty != 0 {
			unitPrice = Round(ToFloat(g["amount"])/qty, 4)
		}
		payStatus := "paid"
		if ToInt(g["unpaid"]) > 0 {
			payStatus = "unpaid"
		}
		out = append(out, map[string]any{"product_id": g["product_id"], "product_name": g["product_name"],
			"spec": g["spec"], "unit": g["unit"], "date": g["date"], "base_unit": g["base_unit"],
			"quantity": qty, "quantity_base": Round(ToFloat(g["quantity_base"]), 4), "unit_price": unitPrice,
			"unit_cost": g["unit_cost"], "sale_price": g["sale_price"], "sale_amount": g["sale_amount"],
			"amount": g["amount"], "order_count": len(ids), "order_ids": ids, "bill_ids": g["_bills"],
			"date_from": g["date"], "date_to": g["date"], "pay_status": payStatus,
			"unpaid_count": ToInt(g["unpaid"]), "paid_at": g["paid_at"], "operator": g["operator"]})
	}
	// 先「待结清优先 + 金额倒序」，再按出库日期倒序（稳定排序保留上一层顺序）
	sort.SliceStable(out, func(i, j int) bool {
		pi := ToStr(out[i]["pay_status"]) != "unpaid"
		pj := ToStr(out[j]["pay_status"]) != "unpaid"
		if pi != pj {
			return !pi
		}
		return ToFloat(out[i]["amount"]) > ToFloat(out[j]["amount"])
	})
	sort.SliceStable(out, func(i, j int) bool { return ToStr(out[i]["date"]) > ToStr(out[j]["date"]) })
	if limit <= 0 {
		limit = 300
	}
	if limit > 2000 {
		limit = 2000
	}
	if limit < 1 {
		limit = 1
	}
	shown := out
	if len(shown) > limit {
		shown = shown[:limit]
	}
	totalAmount, totalQty, orders := 0.0, 0.0, 0;
	pending, pendingAmount, paidAmount := 0, 0.0, 0.0
	for _, x := range out {
		totalAmount += ToFloat(x["amount"])
		totalQty += ToFloat(x["quantity"])
		orders += ToInt(x["order_count"])
		if ToStr(x["pay_status"]) == "unpaid" {
			pending++
			pendingAmount += ToFloat(x["amount"])
		} else {
			paidAmount += ToFloat(x["amount"])
		}
	}
	return map[string]any{"groups": shown, "truncated": len(out) > len(shown), "limit": len(shown),
		"total": map[string]any{"groups": len(out), "orders": orders, "quantity": Round(totalQty, 4),
			"amount": Round2(totalAmount), "pending_groups": pending, "pending_amount": Round2(pendingAmount),
			"paid_amount": Round2(paidAmount)}}, nil
}
