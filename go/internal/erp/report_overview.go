package erp

import (
	"context"
	"database/sql"
	"sort"
	"strings"
)

// 本文件对齐 Python routers/report.py 的
//   _merge_summaries / _sales_by_spec_of / _sales_by_spec_all / _overview_of
// 逐仓遍历（_each_warehouse / _all_warehouses_impl）在 api 层做，因为要用 database.Manager。

// ---------------- 全仓合计：合并各分仓的 _summary_of ----------------

// repMergeNumFields 合并时要先清零再逐仓累加的数值字段（顺序照抄 Python num_fields）。
var repMergeNumFields = []string{"qty", "weight_kg", "amount", "gross_sales", "goods_cogs", "pack_cogs",
	"labor_cogs", "material_cogs", "other_cogs", "express_cogs", "brush_cogs", "settle_income"}

// MergeSummaries 把各分仓的 _summary_of 结果合并成「全仓合计」（Python _merge_summaries）。
func MergeSummaries(parts []map[string]any, dateFrom, dateTo string, failed []map[string]any) map[string]any {
	if failed == nil {
		failed = []map[string]any{}
	}
	sumField := func(field string) float64 {
		t := 0.0
		for _, p := range parts {
			t += ToFloat(p[field])
		}
		return repRound2(t)
	}
	intField := func(field string) int {
		t := 0
		for _, p := range parts {
			t += ToInt(p[field])
		}
		return t
	}
	pendField := func(field string) float64 {
		t := 0.0
		for _, p := range parts {
			pd, _ := p["pending"].(map[string]any)
			t += ToFloat(pd[field])
		}
		return repRound2(t)
	}
	mergeMaps := func(field string) map[string]float64 {
		out := map[string]float64{}
		for _, p := range parts {
			m, _ := p[field].(map[string]float64)
			for k, v := range m {
				out[k] = repRound(out[k]+v, 2)
			}
		}
		return out
	}

	type bucketKey struct {
		name string
		spec string
		dr   bool
		isWI bool
	}
	buckets := map[bucketKey]map[string]any{}
	var bucketOrder []bucketKey
	for _, p := range parts {
		rows, _ := p["by_product"].([]map[string]any)
		for _, r := range rows {
			k := bucketKey{name: ToStr(r["name"]), spec: ToStr(r["spec"]),
				dr: ToBool(r["is_dropship"]), isWI: ToBool(r["is_warehouse_in"])}
			d, ok := buckets[k]
			if !ok {
				d = map[string]any{}
				for key, v := range r {
					d[key] = v
				}
				for _, f := range repMergeNumFields {
					d[f] = 0.0
				}
				d["_srcs"] = map[string]bool{}
				buckets[k] = d
				bucketOrder = append(bucketOrder, k)
			}
			for _, f := range repMergeNumFields {
				d[f] = ToFloat(d[f]) + ToFloat(r[f])
			}
			// 来源跨分仓取并集（同一商品在不同分仓可能是手动建单或聚水潭导入）
			srcs := d["_srcs"].(map[string]bool)
			for _, x := range strings.Split(ToStr(r["source"]), "＋") {
				if x = strings.TrimSpace(x); x != "" {
					srcs[x] = true
				}
			}
		}
	}
	productRows := make([]map[string]any, 0, len(bucketOrder))
	for _, k := range bucketOrder {
		d := buckets[k]
		goods := repRound2(ToFloat(d["goods_cogs"]))
		pack := repRound2(ToFloat(d["pack_cogs"]))
		express := repRound2(ToFloat(d["express_cogs"]))
		brush := repRound2(ToFloat(d["brush_cogs"]))
		totalCOGS := repRound(goods+pack+express+brush, 2)
		amount := repRound2(ToFloat(d["amount"]))
		grossSales := repRound2(ToFloat(d["gross_sales"]))
		settle := repRound2(ToFloat(d["settle_income"]))
		gp := repRound(amount+settle-totalCOGS, 2)
		base := grossSales
		if base == 0 {
			base = amount
		}
		denom := repRound(base+settle, 2)
		gpRate := 0.0
		if denom != 0 {
			gpRate = repRound(gp/denom*100, 2)
		}
		srcs := d["_srcs"].(map[string]bool)
		names := make([]string, 0, len(srcs))
		for s := range srcs {
			names = append(names, s)
		}
		sort.Strings(names)
		source := strings.Join(names, " ＋ ")
		if source == "" {
			source = ToStr(d["source"])
		}
		out := map[string]any{}
		for key, v := range d {
			if strings.HasPrefix(key, "_") {
				continue
			}
			out[key] = v
		}
		out["qty"] = repRound4(ToFloat(d["qty"]))
		out["source"] = source
		out["amount"] = amount
		out["gross_sales"] = grossSales
		out["settle_income"] = settle
		out["cogs"] = totalCOGS
		out["total_cogs"] = totalCOGS
		out["gross_profit"] = gp
		out["gp_rate"] = gpRate
		productRows = append(productRows, out)
	}
	sort.SliceStable(productRows, func(i, j int) bool {
		return ToFloat(productRows[i]["amount"]) > ToFloat(productRows[j]["amount"])
	})

	// ---- 支出：按日 / 按月归并（采购 + 其他开支 + 手工记账）----
	mergeExpense := func(field, label string) []map[string]any {
		type accRow struct {
			purchase, other, manual, brush float64
			count                          int
		}
		acc := map[string]*accRow{}
		var keys []string
		for _, p := range parts {
			rows, _ := p[field].([]map[string]any)
			for _, r := range rows {
				k := ToStr(r[label])
				if k == "" {
					continue
				}
				b, ok := acc[k]
				if !ok {
					b = &accRow{}
					acc[k] = b
					keys = append(keys, k)
				}
				b.purchase += ToFloat(r["purchase"])
				b.other += ToFloat(r["other_expense"])
				b.manual += ToFloat(r["manual_expense"])
				b.brush += ToFloat(r["brush_expense"])
				b.count += ToInt(r["count"])
			}
		}
		// Python: sorted(acc.items(), reverse=True) —— 按日期/月份字符串倒序
		sort.Sort(sort.Reverse(sort.StringSlice(keys)))
		out := make([]map[string]any, 0, len(keys))
		for _, k := range keys {
			v := acc[k]
			out = append(out, map[string]any{
				label:            k,
				"purchase":       repRound2(v.purchase),
				"other_expense":  repRound2(v.other),
				"manual_expense": repRound2(v.manual),
				"brush_expense":  repRound2(v.brush),
				"period_expense": repRound(v.other+v.manual, 2),
				"total":          repRound(v.purchase+v.other+v.manual+v.brush, 2),
				"count":          v.count,
			})
		}
		return out
	}

	// ---- 逐笔支出明细：拼接并补上来源分仓，按日期倒序 ----
	expenseItems := []map[string]any{}
	for _, p := range parts {
		wh, _ := p["warehouse"].(map[string]any)
		wname := ToStr(wh["name"])
		rows, _ := p["expense_items"].([]map[string]any)
		for _, r := range rows {
			it := map[string]any{}
			for k, v := range r {
				it[k] = v
			}
			it["warehouse"] = wname
			expenseItems = append(expenseItems, it)
		}
	}
	sort.SliceStable(expenseItems, func(i, j int) bool {
		return ToStr(expenseItems[i]["date"]) > ToStr(expenseItems[j]["date"])
	})

	packCosts := mergeMaps("pack_costs")
	manualFees := mergeMaps("manual_fees")
	packTotal := 0.0
	for _, v := range packCosts {
		packTotal += v
	}
	anyExclude := false
	for _, p := range parts {
		if ToBool(p["exclude_other_expense"]) {
			anyExclude = true
			break
		}
	}
	feeBreakdown := map[string]float64{}
	for k, v := range packCosts {
		feeBreakdown[k] = v
	}
	for k, v := range manualFees {
		if _, ok := feeBreakdown[k]; !ok {
			feeBreakdown[k] = v
		}
	}

	pending := map[string]any{
		"payables_count":     int(pendField("payables_count")),
		"payables_amount":    pendField("payables_amount"),
		"receivables_count":  int(pendField("receivables_count")),
		"receivables_amount": pendField("receivables_amount"),
	}

	return map[string]any{
		"date_from":               dateFrom,
		"date_to":                 dateTo,
		"warehouse":               map[string]any{"key": repAllWH, "name": "全仓合计"},
		"is_current":              false,
		"is_all":                  true,
		"warehouse_count":         len(parts),
		"failed":                  failed,
		"pending":                 pending,
		"revenue":                 sumField("revenue"),
		"cogs":                    sumField("cogs"),
		"goods_cogs":              sumField("goods_cogs"),
		"warehouse_in_revenue":    sumField("warehouse_in_revenue"),
		"warehouse_in_cogs":       sumField("warehouse_in_cogs"),
		"warehouse_in_goods_cogs": sumField("warehouse_in_goods_cogs"),
		"warehouse_in_freight":    sumField("warehouse_in_freight"),
		"warehouse_in_pack":       sumField("warehouse_in_pack"),
		"warehouse_in_qty":        sumField("warehouse_in_qty"),
		"warehouse_in_count":      intField("warehouse_in_count"),
		"brush_cost":              sumField("brush_cost"),
		"brush_input_cost":        sumField("brush_input_cost"),
		"brush_fee_cost":          sumField("brush_fee_cost"),
		"gross_profit":            sumField("gross_profit"),
		"expense":                 sumField("expense"),
		"manual_expense":          sumField("manual_expense"),
		"other_expense":           sumField("other_expense"),
		"exclude_other_expense":   anyExclude,
		"excluded_other_expense":  sumField("excluded_other_expense"),
		"net_profit":              sumField("net_profit"),
		"purchase":                sumField("purchase"),
		"total_expense":           sumField("total_expense"),
		"stock_value":             sumField("stock_value"),
		"order_count":             intField("order_count"),
		"inbound_count":           intField("inbound_count"),
		"by_product":              productRows,
		"pack_costs":              packCosts,
		"pack_cost_total":         repRound2(packTotal),
		"manual_fees":             manualFees,
		"other_expenses":          mergeMaps("other_expenses"),
		"expense_by_day":          mergeExpense("expense_by_day", "date"),
		"expense_by_month":        mergeExpense("expense_by_month", "month"),
		"expense_items":           expenseItems,
		"fee_breakdown":           feeBreakdown,
	}
}

// ---------------- 出库明细（按天 × 规格） ----------------

// repSpecCell 是「某天某规格」的聚合值。
type repSpecCell struct {
	orders        int
	qty           float64
	amount        float64
	dropshipQty   float64
	dropshipCOGS  float64
	unit          string
	hasUnit       bool
}

// repSpecAgg 是「某个规格」的聚合值。
type repSpecAgg struct {
	name          string
	orders        int
	days          int
	qty           float64
	amount        float64
	dropshipQty   float64
	dropshipCOGS  float64
	unit          string
	hasUnit       bool
}

// RepSalesPart 单仓出库明细结果 + Python 侧字典插入顺序（cells 的键序会影响浮点累加顺序，
// Go 的 map 无序，必须把顺序带出来，全仓合并才能逐位对齐）。
type RepSalesPart struct {
	Data     map[string]any
	CellKeys map[string][]string // 日期 -> 该天规格的出现顺序
}

// repSpecSQL 是销售行的分组聚合列（Python _sums()）。
const repSpecSums = `COUNT(DISTINCT outbounds.id), COALESCE(SUM(outbound_lines.quantity), 0.0), ` +
	`COALESCE(SUM(outbound_lines.amount), 0.0), ` +
	`COALESCE(SUM(CASE WHEN (outbound_lines.is_dropship = 1) THEN outbound_lines.quantity ELSE 0.0 END), 0.0), ` +
	`COALESCE(SUM(CASE WHEN (outbound_lines.is_dropship = 1) THEN outbound_lines.cogs ELSE 0.0 END), 0.0)`

const repSpecCol = `COALESCE(NULLIF(TRIM(outbound_lines.spec), ''), '未标规格')`

// SalesBySpecOf 单仓「日期 × 规格」出库明细（Python _sales_by_spec_of）。
func SalesBySpecOf(ctx context.Context, q Querier, dateFrom, dateTo, whKey, whName string) (*RepSalesPart, error) {
	cond, args := repDateConds("date", dateFrom, dateTo)

	type dayAgg struct {
		orders int
		cells  map[string]*repSpecCell
		ord    []string
	}
	days := map[string]*dayAgg{}
	var dayOrder []string

	// 每天的总单数：含没有销售行的单
	{
		rows, err := q.QueryContext(ctx, "SELECT date, COUNT(*) FROM outbounds WHERE 1=1"+cond+" GROUP BY date", args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var d string
			var c int
			if err := rows.Scan(&d, &c); err != nil {
				continue
			}
			if _, ok := days[d]; !ok {
				days[d] = &dayAgg{cells: map[string]*repSpecCell{}}
				dayOrder = append(dayOrder, d)
			}
			days[d].orders = c
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	lineCond, lineArgs := repDateConds("outbounds.date", dateFrom, dateTo)
	saleCond := lineCond + " AND outbound_lines.line_type = 'sale'"

	{
		sqlText := "SELECT outbounds.date, " + repSpecCol + ", " + repSpecSums +
			" FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id" +
			" WHERE 1=1" + saleCond + " GROUP BY outbounds.date, " + repSpecCol
		rows, err := q.QueryContext(ctx, sqlText, lineArgs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var date, spec string
			var c repSpecCell
			if err := rows.Scan(&date, &spec, &c.orders, &c.qty, &c.amount, &c.dropshipQty, &c.dropshipCOGS); err != nil {
				continue
			}
			d := days[date]
			if d == nil {
				continue
			}
			if _, ok := d.cells[spec]; !ok {
				d.ord = append(d.ord, spec)
			}
			d.cells[spec] = &c
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	specs := map[string]*repSpecAgg{}
	var specOrder []string
	{
		sqlText := "SELECT " + repSpecCol + ", " + repSpecSums + ", COUNT(DISTINCT outbounds.date)" +
			" FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id" +
			" WHERE 1=1" + saleCond + " GROUP BY " + repSpecCol
		rows, err := q.QueryContext(ctx, sqlText, lineArgs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var spec string
			var s repSpecAgg
			if err := rows.Scan(&spec, &s.orders, &s.qty, &s.amount, &s.dropshipQty, &s.dropshipCOGS, &s.days); err != nil {
				continue
			}
			s.name = spec
			specs[spec] = &s
			specOrder = append(specOrder, spec)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	// 单位取组内出现次数最多的（按计数倒序、单位名升序，只取每组第一条）
	{
		sqlText := "SELECT outbounds.date, " + repSpecCol + ", outbound_lines.unit, COUNT(*)" +
			" FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id" +
			" WHERE 1=1" + saleCond + " GROUP BY outbounds.date, " + repSpecCol + ", outbound_lines.unit" +
			" ORDER BY COUNT(*) DESC, outbound_lines.unit"
		rows, err := q.QueryContext(ctx, sqlText, lineArgs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var date, spec string
			var unit sql.NullString
			var cnt int
			if err := rows.Scan(&date, &spec, &unit, &cnt); err != nil {
				continue
			}
			_ = cnt
			u := ""
			if unit.Valid {
				u = unit.String
			}
			if d := days[date]; d != nil {
				if c := d.cells[spec]; c != nil && !c.hasUnit {
					c.unit, c.hasUnit = u, true
				}
			}
			if s := specs[spec]; s != nil && !s.hasUnit {
				s.unit, s.hasUnit = u, true
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	// out_rows：按日期倒序（Python sorted(days, reverse=True)）
	dates := append([]string{}, dayOrder...)
	sort.Sort(sort.Reverse(sort.StringSlice(dates)))
	outRows := make([]map[string]any, 0, len(dates))
	cellKeys := map[string][]string{}
	for _, d := range dates {
		agg := days[d]
		cellKeys[d] = append([]string{}, agg.ord...)
		var tQty, tAmt, tDQ, tDC float64
		for _, name := range agg.ord {
			c := agg.cells[name]
			tQty += c.qty
			tAmt += c.amount
			tDQ += c.dropshipQty
			tDC += c.dropshipCOGS
		}
		cells := map[string]any{}
		for _, name := range agg.ord {
			c := agg.cells[name]
			cells[name] = map[string]any{
				"orders":        c.orders,
				"qty":           repRound2(c.qty),
				"unit":          c.unit,
				"amount":        repRound2(c.amount),
				"dropship_qty":  repRound2(c.dropshipQty),
				"dropship_cogs": repRound2(c.dropshipCOGS),
			}
		}
		outRows = append(outRows, map[string]any{
			"date":          d,
			"orders":        agg.orders,
			"qty":           repRound2(tQty),
			"amount":        repRound2(tAmt),
			"dropship_qty":  repRound2(tDQ),
			"dropship_cogs": repRound2(tDC),
			"cells":         cells,
		})
	}

	totalOrders := 0
	for _, d := range dayOrder {
		totalOrders += days[d].orders
	}

	specCols := make([]*repSpecAgg, 0, len(specOrder))
	for _, n := range specOrder {
		specCols = append(specCols, specs[n])
	}
	sort.SliceStable(specCols, func(i, j int) bool {
		if specCols[i].orders != specCols[j].orders {
			return specCols[i].orders > specCols[j].orders
		}
		return specCols[i].qty > specCols[j].qty
	})
	specOut := make([]map[string]any, 0, len(specCols))
	for _, s := range specCols {
		specOut = append(specOut, map[string]any{
			"name":          s.name,
			"orders":        s.orders,
			"days":          s.days,
			"qty":           repRound2(s.qty),
			"unit":          s.unit,
			"amount":        repRound2(s.amount),
			"dropship_qty":  repRound2(s.dropshipQty),
			"dropship_cogs": repRound2(s.dropshipCOGS),
		})
	}

	var rQty, rAmt, rDQ, rDC float64
	for _, r := range outRows {
		rQty += ToFloat(r["qty"])
		rAmt += ToFloat(r["amount"])
		rDQ += ToFloat(r["dropship_qty"])
		rDC += ToFloat(r["dropship_cogs"])
	}

	data := map[string]any{
		"date_from": dateFrom,
		"date_to":   dateTo,
		"warehouse": map[string]any{"key": whKey, "name": whName},
		"specs":     specOut,
		"rows":      outRows,
		"totals": map[string]any{
			"orders":        totalOrders,
			"days":          len(days),
			"spec_count":    len(specs),
			"qty":           repRound2(rQty),
			"amount":        repRound2(rAmt),
			"dropship_qty":  repRound2(rDQ),
			"dropship_cogs": repRound2(rDC),
		},
	}
	return &RepSalesPart{Data: data, CellKeys: cellKeys}, nil
}

// SalesBySpecAll 全仓合计的出库明细（Python _sales_by_spec_all）。
func SalesBySpecAll(parts []RepSalesPart, dateFrom, dateTo string, failed []map[string]any) map[string]any {
	if failed == nil {
		failed = []map[string]any{}
	}
	type cellRow struct {
		orders       int
		qty          float64
		amount       float64
		unit         string
		dropshipQty  float64
		dropshipCOGS float64
	}
	type dayAgg struct {
		orders int
		cells  map[string]*cellRow
		ord    []string
	}
	days := map[string]*dayAgg{}
	var dayKeys []string
	var tOrders int
	var tQty, tAmt, tDQ, tDC float64

	for _, p := range parts {
		t, _ := p.Data["totals"].(map[string]any)
		tOrders += ToInt(t["orders"])
		tQty += ToFloat(t["qty"])
		tAmt += ToFloat(t["amount"])
		tDQ += ToFloat(t["dropship_qty"])
		tDC += ToFloat(t["dropship_cogs"])

		rows, _ := p.Data["rows"].([]map[string]any)
		for _, r := range rows {
			date := ToStr(r["date"])
			d, ok := days[date]
			if !ok {
				d = &dayAgg{cells: map[string]*cellRow{}}
				days[date] = d
				dayKeys = append(dayKeys, date)
			}
			d.orders += ToInt(r["orders"])
			cs, _ := r["cells"].(map[string]any)
			// Python 按 cells 字典的插入顺序遍历（顺序影响浮点累加），这里把顺序带出来
			for _, name := range p.CellKeys[date] {
				c0, _ := cs[name].(map[string]any)
				if c0 == nil {
					continue
				}
				c, ok := d.cells[name]
				if !ok {
					c = &cellRow{}
					d.cells[name] = c
					d.ord = append(d.ord, name)
				}
				c.orders += ToInt(c0["orders"])
				c.qty += ToFloat(c0["qty"])
				c.amount += ToFloat(c0["amount"])
				c.dropshipQty += ToFloat(c0["dropship_qty"])
				c.dropshipCOGS += ToFloat(c0["dropship_cogs"])
				if c.unit == "" && ToStr(c0["unit"]) != "" {
					c.unit = ToStr(c0["unit"])
				}
			}
		}
	}

	sort.Sort(sort.Reverse(sort.StringSlice(dayKeys)))

	type specAcc struct {
		orders       int
		qty          float64
		amount       float64
		unit         string
		dropshipQty  float64
		dropshipCOGS float64
		name         string
		daySet       map[string]bool
	}
	specMap := map[string]*specAcc{}
	var specKeys []string
	rows := make([]map[string]any, 0, len(dayKeys))
	for _, date := range dayKeys {
		d := days[date]
		for _, name := range d.ord {
			c := d.cells[name]
			acc, ok := specMap[name]
			if !ok {
				acc = &specAcc{name: name, daySet: map[string]bool{}}
				specMap[name] = acc
				specKeys = append(specKeys, name)
			}
			acc.orders += c.orders
			acc.qty += c.qty
			acc.amount += c.amount
			acc.dropshipQty += c.dropshipQty
			acc.dropshipCOGS += c.dropshipCOGS
			if acc.unit == "" && c.unit != "" {
				acc.unit = c.unit
			}
			acc.daySet[date] = true
		}
		var cQty, cAmt, cDQ, cDC float64
		for _, name := range d.ord {
			c := d.cells[name]
			cQty += c.qty
			cAmt += c.amount
			cDQ += c.dropshipQty
			cDC += c.dropshipCOGS
		}
		cells := map[string]any{}
		for _, name := range d.ord {
			c := d.cells[name]
			cells[name] = map[string]any{
				"orders":        c.orders,
				"qty":           repRound2(c.qty),
				"unit":          c.unit,
				"amount":        repRound2(c.amount),
				"dropship_qty":  repRound2(c.dropshipQty),
				"dropship_cogs": repRound2(c.dropshipCOGS),
			}
		}
		rows = append(rows, map[string]any{
			"date":          date,
			"orders":        d.orders,
			"qty":           repRound2(cQty),
			"amount":        repRound2(cAmt),
			"dropship_qty":  repRound2(cDQ),
			"dropship_cogs": repRound2(cDC),
			"cells":         cells,
		})
	}

	specCols := make([]*specAcc, 0, len(specKeys))
	for _, k := range specKeys {
		specCols = append(specCols, specMap[k])
	}
	sort.SliceStable(specCols, func(i, j int) bool {
		if len(specCols[i].daySet) != len(specCols[j].daySet) {
			return len(specCols[i].daySet) > len(specCols[j].daySet)
		}
		return specCols[i].qty > specCols[j].qty
	})
	specOut := make([]map[string]any, 0, len(specCols))
	for _, s := range specCols {
		specOut = append(specOut, map[string]any{
			"name":          s.name,
			"orders":        s.orders,
			"days":          len(s.daySet),
			"qty":           repRound2(s.qty),
			"unit":          s.unit,
			"amount":        repRound2(s.amount),
			"dropship_qty":  repRound2(s.dropshipQty),
			"dropship_cogs": repRound2(s.dropshipCOGS),
		})
	}

	return map[string]any{
		"date_from":       dateFrom,
		"date_to":         dateTo,
		"warehouse":       map[string]any{"key": repAllWH, "name": "全仓合计"},
		"is_all":          true,
		"warehouse_count": len(parts),
		"failed":          failed,
		"specs":           specOut,
		"rows":            rows,
		"totals": map[string]any{
			"orders":        tOrders,
			"days":          len(days),
			"spec_count":    len(specCols),
			"qty":           repRound2(tQty),
			"amount":        repRound2(tAmt),
			"dropship_qty":  repRound2(tDQ),
			"dropship_cogs": repRound2(tDC),
		},
	}
}

// ---------------- 全仓总览（收入 / 支出 / 利润一张表） ----------------

// OverviewOf 单个分仓的收入/支出/利润总览（Python _overview_of），全部走 SQL 聚合。
func OverviewOf(ctx context.Context, q Querier, whKey, whName, dateFrom, dateTo string, excludeOther bool) (map[string]any, error) {
	const paidCond = " AND COALESCE(pay_status, 'paid') != 'unpaid'"
	const unpaidCond = " AND COALESCE(pay_status, 'paid') = 'unpaid'"

	cond, args := repDateConds("date", dateFrom, dateTo)

	var orders int
	var revenue, cogs, brush, settle float64
	err := q.QueryRowContext(ctx, "SELECT COUNT(*), "+
		"COALESCE(SUM(total_amount + COALESCE(settle_income, 0)), 0), "+
		"COALESCE(SUM(total_cogs), 0), "+
		"COALESCE(SUM("+BrushAdjustSQL+"), 0), "+
		"COALESCE(SUM(COALESCE(settle_income, 0)), 0) "+
		"FROM outbounds WHERE 1=1"+cond+paidCond, args...).
		Scan(&orders, &revenue, &cogs, &brush, &settle)
	if err != nil {
		return nil, err
	}
	brush = repRound2(brush)
	settle = repRound2(settle)

	var wiCnt int
	var wiRevenue, wiCOGS float64
	err = q.QueryRowContext(ctx, "SELECT COUNT(*), COALESCE(SUM(amount), 0), "+
		"COALESCE(SUM(COALESCE(cogs, 0) + COALESCE(freight_total, 0) + COALESCE(pack_cost, 0)), 0) "+
		"FROM warehouse_ins WHERE 1=1"+cond+paidCond, args...).
		Scan(&wiCnt, &wiRevenue, &wiCOGS)
	if err != nil {
		return nil, err
	}
	revenue += wiRevenue
	cogs += wiCOGS

	var manualExpense float64
	err = q.QueryRowContext(ctx, "SELECT COALESCE(SUM(amount), 0) FROM finance_records WHERE 1=1"+cond+paidCond+
		" AND type = 'expense' AND category != '采购支出'", args...).Scan(&manualExpense)
	if err != nil {
		return nil, err
	}

	var otherRaw float64
	err = q.QueryRowContext(ctx, "SELECT COALESCE(SUM(amount), 0) FROM other_expenses WHERE 1=1"+cond+paidCond+
		" AND COALESCE(ref_type, '') != ?", append(append([]any{}, args...), repInboundFeeRef)...).
		Scan(&otherRaw)
	if err != nil {
		return nil, err
	}
	otherRaw = repRound2(otherRaw)

	var inbounds int
	var purchase float64
	err = q.QueryRowContext(ctx, "SELECT COUNT(*), "+
		"COALESCE(SUM(total_amount + COALESCE(freight, 0) + COALESCE(handling, 0)), 0) "+
		"FROM inbounds WHERE 1=1"+cond+paidCond, args...).Scan(&inbounds, &purchase)
	if err != nil {
		return nil, err
	}

	var stockValue float64
	if err := q.QueryRowContext(ctx, "SELECT COALESCE(SUM(stock_value), 0) FROM products").Scan(&stockValue); err != nil {
		return nil, err
	}
	stockValue = repRound2(stockValue)

	otherExpense := 0.0
	if !excludeOther {
		otherExpense = otherRaw
	}
	expense := repRound(manualExpense+otherExpense, 2)

	// 待付款 / 待收款：与 _pending_stats 同口径（按来源单据算，避免自动流水重复计）
	unpaidSum := func(table, col, extra string) (int, float64) {
		var cnt int
		var amt float64
		err := q.QueryRowContext(ctx, "SELECT COUNT(*), COALESCE(SUM("+col+"), 0) FROM "+table+
			" WHERE 1=1"+cond+unpaidCond+extra, args...).Scan(&cnt, &amt)
		if err != nil {
			return 0, 0
		}
		return cnt, amt
	}
	ibC, ibA := unpaidSum("inbounds", "total_amount", "")
	oeC, oeA := unpaidSum("other_expenses", "amount", "")
	fioC, fioA := unpaidSum("finance_records", "amount", " AND type = 'expense' AND ref_type = 'manual'")
	obC, obA := unpaidSum("outbounds", "total_amount + COALESCE(settle_income, 0)", "")
	fiiC, fiiA := unpaidSum("finance_records", "amount", " AND type = 'income' AND ref_type = 'manual'")
	wiuC, wiuA := unpaidSum("warehouse_ins", "amount", "")

	return map[string]any{
		"key":                   whKey,
		"name":                  whName,
		"revenue":               repRound2(revenue),
		"settle_income":         settle,
		"cogs":                  repRound2(cogs),
		"warehouse_in_revenue":  repRound2(wiRevenue),
		"warehouse_in_cogs":     repRound2(wiCOGS),
		"brush_cost":            brush,
		"gross":                 repRound(revenue-cogs-brush, 2),
		"expense":               expense,
		"other_expense":         otherExpense,
		"manual_expense":        repRound2(manualExpense),
		"exclude_other_expense": excludeOther,
		"excluded_other_expense": otherRaw,
		"purchase":              repRound2(purchase),
		"total_expense":         repRound(purchase+expense+brush, 2),
		"net_profit":            repRound(revenue-cogs-brush-expense, 2),
		"orders":                orders,
		"inbounds":              inbounds,
		"warehouse_ins":         wiCnt,
		"stock_value":           stockValue,
		"pending": map[string]any{
			"payables_count":     ibC + oeC + fioC,
			"payables_amount":    repRound(ibA+oeA+fioA, 2),
			"receivables_count":  obC + fiiC + wiuC,
			"receivables_amount": repRound(obA+fiiA+wiuA, 2),
		},
	}, nil
}

// OverviewTotal 全仓总览的合计行（Python _all_warehouses_impl 的 total，只统计没有 error 的行）。
func OverviewTotal(ok []map[string]any) map[string]any {
	f := func(field string) float64 {
		t := 0.0
		for _, x := range ok {
			t += ToFloat(x[field])
		}
		return repRound2(t)
	}
	n := func(field string) int {
		t := 0
		for _, x := range ok {
			t += ToInt(x[field])
		}
		return t
	}
	p := func(field string) float64 {
		t := 0.0
		for _, x := range ok {
			pd, _ := x["pending"].(map[string]any)
			t += ToFloat(pd[field])
		}
		return repRound2(t)
	}
	return map[string]any{
		"revenue":                f("revenue"),
		"cogs":                   f("cogs"),
		"warehouse_in_revenue":   f("warehouse_in_revenue"),
		"warehouse_in_cogs":      f("warehouse_in_cogs"),
		"brush_cost":             f("brush_cost"),
		"gross":                  f("gross"),
		"expense":                f("expense"),
		"other_expense":          f("other_expense"),
		"manual_expense":         f("manual_expense"),
		"excluded_other_expense": f("excluded_other_expense"),
		"purchase":               f("purchase"),
		"total_expense":          f("total_expense"),
		"net_profit":             f("net_profit"),
		"orders":                 n("orders"),
		"inbounds":               n("inbounds"),
		"warehouse_ins":          n("warehouse_ins"),
		"stock_value":            f("stock_value"),
		"warehouse_count":        len(ok),
		"pending": map[string]any{
			"payables_count":     int(p("payables_count")),
			"payables_amount":    p("payables_amount"),
			"receivables_count":  int(p("receivables_count")),
			"receivables_amount": p("receivables_amount"),
		},
	}
}
