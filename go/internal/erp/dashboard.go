package erp

import (
	"context"
	"sort"
	"strings"
)

// 本文件是工作台（GET /api/dashboard）与报表区间汇总，口径对齐 Python routers/report.py::dashboard。
// 注意：工作台的收入只算「出库」，不含入仓（京东），与 /report/summary 的口径不同，这是既有设计。

// RangeSummary 一个日期区间的汇总（工作台今日/本月共用）。
type RangeSummary struct {
	Revenue      float64
	Gross        float64
	Net          float64
	Orders       int
	COGS         float64
	BrushCost    float64
	Expense      float64
	OtherExpense float64
	PackCosts    map[string]float64
	PackTotal    float64
}

// JSON 输出（键名与 Python 一致；pack_costs 无数据时是空对象而不是 null）。
func (s RangeSummary) JSON() map[string]any {
	packs := map[string]float64{}
	for k, v := range s.PackCosts {
		packs[k] = v
	}
	return map[string]any{"revenue": Round2(s.Revenue), "gross": Round2(s.Gross), "net": Round2(s.Net),
		"orders": s.Orders, "cogs": Round2(s.COGS), "brush_cost": s.BrushCost, "expense": Round2(s.Expense),
		"other_expense": s.OtherExpense, "pack_costs": packs, "pack_cost_total": s.PackTotal}
}

// SumRange 按区间汇总（只统计已付款单据；未付款单据不进金额，只进待付款）。
func SumRange(ctx context.Context, q Querier, from, to string) (*RangeSummary, error) {
	s := &RangeSummary{PackCosts: map[string]float64{}}
	var orders int
	var revenue, cogs, brush float64
	row := q.QueryRowContext(ctx, "SELECT COUNT(1), COALESCE(SUM(total_amount + COALESCE(settle_income,0)),0), COALESCE(SUM(total_cogs),0), COALESCE(SUM("+BrushAdjustSQL+"),0) FROM outbounds WHERE date >= ? AND date <= ? AND COALESCE(pay_status,'paid') <> 'unpaid'", from, to)
	if err := row.Scan(&orders, &revenue, &cogs, &brush); err != nil {
		return nil, err
	}
	s.Orders, s.Revenue, s.COGS, s.BrushCost = orders, revenue, cogs, Round2(brush)
	var manualExpense float64
	err := q.QueryRowContext(ctx, "SELECT COALESCE(SUM(amount),0) FROM finance_records WHERE date >= ? AND date <= ? AND type = 'expense' AND category <> '采购支出' AND COALESCE(pay_status,'paid') <> 'unpaid'", from, to).Scan(&manualExpense);
	if err != nil {
		return nil, err
	}
	var otherExpense float64
	err = q.QueryRowContext(ctx, "SELECT COALESCE(SUM(amount),0) FROM other_expenses WHERE date >= ? AND date <= ? AND COALESCE(pay_status,'paid') <> 'unpaid' AND COALESCE(ref_type,'') <> ?", from, to, InboundFeeRef).Scan(&otherExpense);
	if err != nil {
		return nil, err
	}
	s.OtherExpense = Round2(otherExpense)
	s.Expense = Round2(manualExpense + s.OtherExpense)
	s.Gross = Round2(revenue - cogs - s.BrushCost)
	s.Net = Round2(revenue - cogs - s.BrushCost - s.Expense)
	// 关联结算成本按「商品分类 + 名称」归类（一条 group by 查完，避免把明细实例化）
	rows, err := q.QueryContext(ctx, "SELECT COALESCE(p.category,''), COALESCE(p.name,''), COALESCE(SUM(l.cogs),0) FROM outbound_lines l JOIN outbounds o ON o.id = l.outbound_id LEFT JOIN products p ON p.id = l.product_id WHERE l.line_type = 'pack' AND o.date >= ? AND o.date <= ? AND COALESCE(o.pay_status,'paid') <> 'unpaid' GROUP BY COALESCE(p.category,''), COALESCE(p.name,'')", from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var cat, name string
		var amt float64
		if err := rows.Scan(&cat, &name, &amt); err != nil {
			continue
		}
		key := PackCostBucketOf(cat, name)
		s.PackCosts[key] = Round(s.PackCosts[key]+amt, 2)
	}
	total := 0.0;
	for _, v := range s.PackCosts {
		total += v
	}
	s.PackTotal = Round2(total)
	return s, rows.Err()
}

// PackCostBucket 关联结算成本的费用桶名（与报表 _pack_cost_category_of 一致）。
var PackCostBucketLabor = "人工打包费"
var PackCostBucketMaterial = "包材耗材"
var PackCostBucketExpress = "快递运费"
var PackCostBucketOther = "其他关联结算"

// PackCostBucketOf 按分类/名称归类。
func PackCostBucketOf(cat, name string) string {
	switch cat {
	case "人工":
		return PackCostBucketLabor
	case "包材", "耗材", "包装":
		return PackCostBucketMaterial
	case "快递":
		return PackCostBucketExpress
	}
	if strings.HasSuffix(strings.TrimSpace(name), "打包") {
		return PackCostBucketLabor
	}
	return PackCostBucketOther
}

// Dashboard 工作台数据（区间 = 今日 / 本月）。
func Dashboard(ctx context.Context, q Querier, userName string) (map[string]any, error) {
	today := Today()
	month := MonthStart()
	cur, err := SumRange(ctx, q, today, today)
	if err != nil {
		return nil, err
	}
	mon, err := SumRange(ctx, q, month, today)
	if err != nil {
		return nil, err
	}
	items, err := ListProductsByID(ctx, q)
	if err != nil {
		return nil, err
	}
	stockValue := 0.0;
	count := 0;
	low := []map[string]any{}
	for _, p := range items {
		if p.ProductType != "stock" || !p.IsActive || IsServiceCat(p.Category) {
			continue
		}
		count++
		stockValue += p.StockValue
		if p.Stock <= 1e-6 {
			conv := p.Conversions
			if conv == nil {
				conv = map[string]float64{}
			}
			low = append(low, map[string]any{"id": p.ID, "name": p.Name, "stock": p.Stock,
				"base_unit": p.BaseUnit, "default_unit": p.DefaultUnit, "conversions": conv})
		}
	}
	sort.SliceStable(low, func(i, j int) bool { return ToFloat(low[i]["stock"]) < ToFloat(low[j]["stock"]) })
	inbounds, err := recentInbounds(ctx, q)
	if err != nil {
		return nil, err
	}
	outbounds, err := recentOutbounds(ctx, q)
	if err != nil {
		return nil, err
	}
	return map[string]any{"user_name": userName, "today": today,
		"today_summary": cur.JSON(), "month_summary": mon.JSON(),
		"stock_value": Round2(stockValue), "low_stock": low,
		"recent_inbounds": inbounds, "recent_outbounds": outbounds, "product_count": count}, nil
}

func recentInbounds(ctx context.Context, q Querier) ([]map[string]any, error) {
	rows, err := q.QueryContext(ctx, "SELECT i.code, COALESCE(p.name,''), i.quantity, i.unit, i.date, COALESCE(i.operator,''), i.total_amount FROM inbounds i LEFT JOIN products p ON p.id = i.product_id ORDER BY i.id DESC LIMIT 6")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var code, name, unit, date, operator string
		var qty, amount float64
		if err := rows.Scan(&code, &name, &qty, &unit, &date, &operator, &amount); err != nil {
			continue
		}
		out = append(out, map[string]any{"code": code, "product_name": name, "quantity": qty,
			"unit": unit, "date": date, "operator": operator, "amount": amount})
	}
	return out, rows.Err()
}

// recentOutbounds 最近出库：同一聚水潭批次合并成一条（「今日同步 294 单」不能刷 294 行）。
func recentOutbounds(ctx context.Context, q Querier) ([]map[string]any, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, code, COALESCE(import_group,''), COALESCE(customer,''), COALESCE(operator,''), date, total_amount, COALESCE(settle_income,0), COALESCE(total_cogs,0), COALESCE(total_fee,0), COALESCE("+BrushAdjustSQL+",0), COALESCE(remark,'') FROM outbounds ORDER BY id DESC LIMIT 200")
	if err != nil {
		return nil, err
	}
	type ob struct {
		id                          int
		code, group, customer, operator, date, remark string
		total, settle, cogs, fee, brush float64
	}
	var recent []ob
	for rows.Next() {
		var o ob
		if err := rows.Scan(&o.id, &o.code, &o.group, &o.customer, &o.operator, &o.date, &o.total, &o.settle, &o.cogs, &o.fee, &o.brush, &o.remark); err != nil {
			continue
		}
		recent = append(recent, o)
	}
	rows.Close()
	groups := map[string][]ob{}
	var groupKeys []string
	var singles []ob
	for _, o := range recent {
		if o.group != "" {
			if _, ok := groups[o.group]; !ok {
				groupKeys = append(groupKeys, o.group)
			}
			groups[o.group] = append(groups[o.group], o)
		} else {
			singles = append(singles, o)
		}
	}
	type stat struct{ cnt int; amount, net float64 }
	stats := map[string]stat{}
	if len(groupKeys) > 0 {
		q2 := "SELECT import_group, COUNT(1), COALESCE(SUM(total_amount + COALESCE(settle_income,0)),0), COALESCE(SUM(total_amount + COALESCE(settle_income,0) - total_cogs - total_fee - " + BrushAdjustSQL + "),0) FROM outbounds WHERE import_group IN (" + Placeholders(len(groupKeys)) + ") GROUP BY import_group"
			rs, err := q.QueryContext(ctx, q2, StringArgs(groupKeys)...)
		if err == nil {
			for rs.Next() {
				var gk string
				var st stat
				if err := rs.Scan(&gk, &st.cnt, &st.amount, &st.net); err == nil {
					stats[gk] = st
				}
			}
			rs.Close()
		}
	}
	out := []map[string]any{}
	for _, gk := range groupKeys {
		g := groups[gk];
		st := stats[gk]
		if st.cnt == 0 {
			st.cnt = len(g)
			for _, o := range g {
				st.amount += o.total + o.settle
				st.net += o.total + o.settle - o.cogs - o.fee - o.brush
			}
		}
		maxID := 0;
		date := ""
		operator := ""
		seen := map[string]bool{}
		var customers []string
		for _, o := range g {
			if o.id > maxID {
				maxID = o.id
				operator = o.operator
			}
			if o.date > date {
				date = o.date
			}
			if o.customer != "" && !seen[o.customer] && len(customers) < 6 {
				seen[o.customer] = true
				customers = append(customers, o.customer)
			}
		}
		out = append(out, map[string]any{"code": "批量 · " + intToStr(st.cnt) + "单", "customer": strings.Join(customers, "/"),
			"date": date, "operator": operator, "amount": Round2(st.amount), "net": Round2(st.net), "_sort": maxID})
	}
	for _, o := range singles {
		amount := o.total + o.settle
		out = append(out, map[string]any{"code": o.code, "customer": o.customer, "date": o.date,
			"operator": o.operator, "amount": amount,
			"net": Round2(amount - o.cogs - o.fee - o.brush), "_sort": o.id})
	}
	sort.SliceStable(out, func(i, j int) bool { return ToInt(out[i]["_sort"]) > ToInt(out[j]["_sort"]) })
	if len(out) > 6 {
		out = out[:6]
	}
	for _, m := range out {
		delete(m, "_sort")
	}
	return out, nil
}

func intToStr(v int) string {
	if v == 0 {
		return "0"
	}
	return FormatFloat(float64(v))
}

