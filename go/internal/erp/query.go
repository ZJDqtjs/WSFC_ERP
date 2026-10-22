package erp

import (
	"context"
	"database/sql"
	"math"
	"regexp"
	"sort"
	"strings"
)

// 本文件是「库存流水查询/图表/库存总览/工作量」的读侧口径，逐条对齐 Python routers/inventory.py。

// MovementRow 是一条库存流水（接口返回用）。
type MovementRow struct {
	ID             int      "json:\"id\""
	ProductID      int      "json:\"product_id\""
	ProductName    string   "json:\"product_name\""
	MoveType       string   "json:\"move_type\""
	QuantityBase   float64  "json:\"quantity_base\""
	Unit           string   "json:\"unit\""
	QuantityDisplay float64 "json:\"quantity_display\""
	Amount         float64  "json:\"amount\""
	Date           string   "json:\"date\""
	Operator       string   "json:\"operator\""
	Remark         string   "json:\"remark\""
}

// MergeOut 出库行按「同一商品 + 同一每单扣减量」合并成一行。
// 出库是按单逐笔记账的，同一商品同一规格一天可能几十行，不合并一页 100 条连一天都看不完；
// 合并后把涉及的单号（CK…）收在 remark 里。非出库行（入库/盘点/工作量/包装消耗）原样保留。
func MergeOut(rows []map[string]any) []map[string]any {
	type key struct{ pid int; name, unit string; per float64 }
	groups := map[key]map[string]any{}
	var order []key
	rest := []map[string]any{}
	re := regexp.MustCompile("(CK\\S+)")
	for _, m := range rows {
		if ToStr(m["move_type"]) != "out" {
			rest = append(rest, m)
			continue
		}
		v := m["quantity_display"]
		if v == nil {
			v = m["quantity_base"]
		}
		k := key{ToInt(m["product_id"]), ToStr(m["product_name"]), ToStr(m["unit"]), ToFloat(v)}
		g, ok := groups[k]
		if !ok {
			g = map[string]any{"product_id": k.pid, "product_name": k.name, "unit": k.unit,
				"per": k.per, "count": 0.0, "total": 0.0, "amount": 0.0,
				"dates": map[string]bool{}, "operators": map[string]bool{}, "codes": []string{}}
			groups[k] = g
			order = append(order, k)
		}
		g["count"] = ToFloat(g["count"]) + 1
		g["total"] = ToFloat(g["total"]) + ToFloat(v)
		g["amount"] = ToFloat(g["amount"]) + ToFloat(m["amount"])
		g["dates"].(map[string]bool)[ToStr(m["date"])] = true
		if op := ToStr(m["operator"]); op != "" {
			g["operators"].(map[string]bool)[op] = true
		}
		if hit := re.FindStringSubmatch(ToStr(m["remark"])); hit != nil {
			codes := g["codes"].([]string)
			if !ContainsStr(codes, hit[1]) {
				g["codes"] = append(codes, hit[1])
			}
		}
	}
	merged := []map[string]any{}
	for _, k := range order {
		g := groups[k]
		dates := sortedKeysBool(g["dates"].(map[string]bool))
		date := dates[0]
		if len(dates) > 1 {
			date = dates[0] + " ~ " + dates[len(dates)-1]
		}
		operators := sortedKeysBool(g["operators"].(map[string]bool))
		codes := g["codes"].([]string)
		merged = append(merged, map[string]any{
			"date": date, "_date_sort": dates[0],
			"product_id": g["product_id"], "product_name": g["product_name"],
			"move_type": "out", "quantity_display": g["per"], "unit": g["unit"],
			"quantity_base": g["total"], "amount": Round(ToFloat(g["amount"]), 4),
			"operator": strings.Join(operators, "、"), "remark": strings.Join(codes, "、"),
			"_merged": map[string]any{"count": ToFloat(g["count"]), "per": g["per"], "total": g["total"],
				"unit": g["unit"], "days": len(dates), "codes": codes, "more": 0.0},
		})
	}
	return append(rest, merged...)
}

func sortedKeysBool(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// MovementSearchText 一行的可搜索文本（日期/商品名/备注/操作员/单位/类型 + 合并行单号）。
func MovementSearchText(r map[string]any) string {
	parts := []string{ToStr(r["date"]), ToStr(r["product_name"]), ToStr(r["remark"]), ToStr(r["operator"]), ToStr(r["unit"]), ToStr(r["move_type"])}
	if mg, ok := r["_merged"].(map[string]any); ok {
		for _, c := range mg["codes"].([]string) {
			parts = append(parts, c)
		}
	}
	return strings.ToLower(strings.Join(parts, " "))
}

// MovementSortValue 排序取值，与表格显示的值一致（合并行按最早那天参与排序）。
func MovementSortValue(r map[string]any, key string) float64 {
	switch key {
	case "quantity_base", "amount":
		return ToFloat(r[key])
	default:
		return 0
	}
}

// MovementSortText 文本列排序值（按码位排序，与 Python 一致）。
func MovementSortText(r map[string]any, key string) string {
	if key == "date" {
		if v, ok := r["_date_sort"].(string); ok && v != "" {
			return v
		}
		return ToStr(r["date"])
	}
	return ToStr(r[key])
}

// ListMovements 按条件取流水（已带商品名与展示单位数量），上限 fetchCap 防把内存吃光。
func ListMovements(ctx context.Context, q Querier, productID int, dateFrom, dateTo string, fetchCap int) ([]map[string]any, bool, error) {
	where := " WHERE 1=1"
	args := []any{}
	if productID > 0 {
		where += " AND m.product_id = ?"
		args = append(args, productID)
	}
	if dateFrom != "" {
		where += " AND m.date >= ?"
		args = append(args, dateFrom)
	}
	if dateTo != "" {
		where += " AND m.date <= ?"
		args = append(args, dateTo)
	}
	query := "SELECT m.id, m.product_id, COALESCE(p.name,''), m.move_type, m.quantity_base, m.amount, m.date, m.operator, m.remark, " +
		"COALESCE(p.default_unit,''), COALESCE(p.base_unit,''), COALESCE(p.conversions,'') " +
		"FROM stock_movements m LEFT JOIN products p ON p.id = m.product_id" + where + " ORDER BY m.id DESC LIMIT ?"
	args = append(args, fetchCap)
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			id, pid             int
			name, moveType      string
			qtyBase, amount     float64
			date, operator      string
			remark              sql.NullString
			defaultUnit, baseUnit string
			conversions         sql.NullString
		)
		if err := rows.Scan(&id, &pid, &name, &moveType, &qtyBase, &amount, &date, &operator, &remark, &defaultUnit, &baseUnit, &conversions); err != nil {
			return nil, false, err
		}
		du := defaultUnit
		if du == "" {
			du = baseUnit
		}
		conv := decodeFloatMap(conversions.String)
		f := 1.0
		if v, ok := conv[du]; ok && v != 0 {
			f = v
		}
		out = append(out, map[string]any{
			"id": id, "product_id": pid, "product_name": name, "move_type": moveType,
			"quantity_base": qtyBase, "unit": du, "quantity_display": Round(qtyBase/f, 4),
			"amount": amount, "date": date, "operator": operator, "remark": remark.String,
		})
	}
	return out, len(out) >= fetchCap, rows.Err()
}

// ChartUnitDisplay 重量类统一按公斤显示（与商品列表/明细表口径一致），其它单位原样。
var chartUnitDisplay = map[string][2]any{
	"克": {"公斤", 1000.0}, "g": {"公斤", 1000.0}, "G": {"公斤", 1000.0},
	"公斤": {"公斤", 1.0}, "千克": {"公斤", 1.0}, "kg": {"公斤", 1.0},
	"斤": {"公斤", 2.0},
}

// ChartExcludeTypes 柱状图只统计真实库存进出：work=人工/快递工作量，avg/ucost=成本流水。
var ChartExcludeTypes = []string{"work", "avg", "ucost"}

// ChartExcludeUnits 单位为「单」的流水记的是单数，不是库存数量。
var ChartExcludeUnits = []string{"单"}

// MovementsChart 按「日期 × 单位」聚合的柱状图数据。
func MovementsChart(ctx context.Context, q Querier, productID int, dateFrom, dateTo string) map[string]any {
	end := dateTo
	if end == "" {
		end = Today()
	}
	start := dateFrom
	if start == "" {
		start = shiftDate(end, -(ChartDefaultDays - 1))
	}
	if start > end {
		start = end
	}
	if daysBetween(start, end)+1 > ChartMaxDays {
		start = shiftDate(end, -(ChartMaxDays - 1))
	}
	days := listDates(start, end)

	where := " WHERE m.date >= ? AND m.date <= ? AND m.move_type NOT IN ('work','avg','ucost') AND COALESCE(p.base_unit,'') NOT IN ('单')"
	args := []any{days[0], days[len(days)-1]}
	if productID > 0 {
		where += " AND m.product_id = ?"
		args = append(args, productID)
	}
	rows, err := q.QueryContext(ctx, "SELECT m.date, m.quantity_base, m.amount, COALESCE(p.base_unit,''), COALESCE(p.default_unit,''), COALESCE(p.conversions,'') FROM stock_movements m LEFT JOIN products p ON p.id = m.product_id"+where, args...)
	if err != nil {
		return map[string]any{"series": []map[string]any{}, "error": err.Error()}
	}
	defer rows.Close()
	type cell struct{ in, out float64 }
	buckets := map[string]map[string]*cell{}
	amounts := map[string]float64{}
	for rows.Next() {
		var d string
		var qty, amount float64
		var baseUnit, defaultUnit, conversions string
		if err := rows.Scan(&d, &qty, &amount, &baseUnit, &defaultUnit, &conversions); err != nil {
			break
		}
		v := qty
		unit := baseUnit
		if productID > 0 {
			du := defaultUnit
			if du == "" {
				du = baseUnit
			}
			unit = du
			conv := decodeFloatMap(conversions)
			f := 1.0
			if x, ok := conv[du]; ok && x != 0 {
				f = x
			}
			v /= f
		} else {
			if got, ok := chartUnitDisplay[baseUnit]; ok {
				unit = ToStr(got[0])
				v /= ToFloat(got[1])
			} else {
				if unit == "" {
					unit = "未知单位"
				}
			}
		}
		if unit == "" {
			unit = "未知单位"
		}
		if buckets[unit] == nil {
			buckets[unit] = map[string]*cell{}
		}
		c := buckets[unit][d]
		if c == nil {
			c = &cell{}
			buckets[unit][d] = c
		}
		if v >= 0 {
			c.in += v
		} else {
			c.out -= v
		}
		amounts[unit] += math.Abs(amount)
	}
	series := []map[string]any{}
	for unit, perDay := range buckets {
		points := []map[string]any{}
		totalIn, totalOut := 0.0, 0.0
		for _, d := range days {
			c := perDay[d]
			var i, o float64
			if c != nil {
				i, o = c.in, c.out
			}
			points = append(points, map[string]any{"date": d, "in": Round(i, 4), "out": Round(o, 4)})
			totalIn += i
			totalOut += o
		}
		series = append(series, map[string]any{"unit": unit, "days": points,
			"total_in": Round(totalIn, 4), "total_out": Round(totalOut, 4), "total_amount": Round(amounts[unit], 2)})
	}
	// 排序按「流水金额」从大到小：公斤/个/瓶 的量不能互比，金额可以
	sort.SliceStable(series, func(i, j int) bool {
		a, b := series[i], series[j]
		if ToFloat(a["total_amount"]) != ToFloat(b["total_amount"]) {
			return ToFloat(a["total_amount"]) > ToFloat(b["total_amount"])
		}
		return ToFloat(a["total_in"])+ToFloat(a["total_out"]) > ToFloat(b["total_in"])+ToFloat(b["total_out"])
	})
	mode := "base_unit"
	if productID > 0 {
		mode = "display"
	}
	return map[string]any{"product_id": productID, "mode": mode, "date_from": days[0], "date_to": days[len(days)-1],
		"excluded_types": ChartExcludeTypes, "excluded_units": ChartExcludeUnits, "series": series}
}

// ChartDefaultDays / ChartMaxDays 柱状图默认与最大天数。
const ChartDefaultDays = 30

// ChartMaxDays 柱状图最多统计的天数。
const ChartMaxDays = 62

// StockOverview 库存总览（人工/快递无真实库存，不进入）。
func StockOverview(ctx context.Context, q Querier) ([]map[string]any, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, name, category, base_unit, default_unit, conversions, stock, avg_cost, stock_value FROM products WHERE is_active = 1 AND product_type = 'stock' AND category NOT IN ('人工','快递') ORDER BY category, name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int
		var name, category, baseUnit, conversions string
		var defaultUnit sql.NullString
		var stock, avgCost, stockValue float64
		if err := rows.Scan(&id, &name, &category, &baseUnit, &defaultUnit, &conversions, &stock, &avgCost, &stockValue); err != nil {
			return nil, err
		}
		du := defaultUnit.String
		if du == "" {
			du = baseUnit
		}
		conv := decodeFloatMap(conversions)
		f := 1.0
		if v, ok := conv[du]; ok && v != 0 {
			f = v
		}
		out = append(out, map[string]any{"id": id, "name": name, "category": category,
			"base_unit": baseUnit, "default_unit": du, "conversions": conv, "stock": stock,
			"stock_display": FmtQty(Round(stock/f, 6)) + " " + du, "avg_cost": avgCost, "stock_value": stockValue})
	}
	return out, rows.Err()
}

// Workload 人工工作量统计：按 人工 商品与日期聚合完成的工作量（单，正数）。
func Workload(ctx context.Context, q Querier, dateFrom, dateTo string) (map[string]any, error) {
	rows, err := q.QueryContext(ctx, "SELECT m.product_id, m.date, m.quantity_base FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE p.category = '人工' ORDER BY m.date")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// perProd 要保持「首次出现顺序」：Python 用的是 dict（插入序），
	// 之后的 -workload 稳定排序依赖它，Go 的 map 遍历顺序是随机的。
	perProd := map[int]float64{}
	var prodOrder []int
	perDate := map[string]float64{}
	total := 0.0
	for rows.Next() {
		var pid int
		var d string
		var qty float64
		if err := rows.Scan(&pid, &d, &qty); err != nil {
			return nil, err
		}
		if dateFrom != "" && d < dateFrom {
			continue
		}
		if dateTo != "" && d > dateTo {
			continue
		}
		w := math.Abs(qty);
		if w == 0 {
			continue
		}
		if _, seen := perProd[pid]; !seen {
			prodOrder = append(prodOrder, pid)
		}
		perProd[pid] += w
		perDate[d] += w
		total += w
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	byProduct := []map[string]any{}
	totalCost := 0.0
	for _, pid := range prodOrder {
		w := perProd[pid]
		p, err := GetProduct(ctx, q, pid)
		if err != nil || p == nil {
			continue
		}
		rate := p.AvgCost
		if rate == 0 {
			rate = p.UnitCost
		}
		cost := Round(w*rate, 2)
		totalCost += cost
		unit := p.BaseUnit
		if unit == "" {
			unit = "单"
		}
		byProduct = append(byProduct, map[string]any{"id": p.ID, "name": p.Name, "workload": Round(w, 2),
			"unit": unit, "rate": Round(rate, 4), "cost": cost})
	}
	sort.SliceStable(byProduct, func(i, j int) bool { return ToFloat(byProduct[i]["workload"]) > ToFloat(byProduct[j]["workload"]) })
	byDate := []map[string]any{}
	for _, d := range sortedKeysFloat(perDate) {
		byDate = append(byDate, map[string]any{"date": d, "workload": Round(perDate[d], 2)})
	}
	return map[string]any{"total_workload": Round(total, 2), "total_cost": Round(totalCost, 2),
		"by_product": byProduct, "by_date": byDate}, nil
}

func sortedKeysFloat(m map[string]float64) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// MovementSortKeys 允许的排序列（非法值回落 date，与 Python MV_SORT_KEYS 一致）。
var MovementSortKeys = map[string]bool{"date": true, "product_name": true, "move_type": true, "quantity_base": true, "amount": true, "operator": true}

// IsMovementSortKey 判断排序列是否合法。
func IsMovementSortKey(k string) bool { return MovementSortKeys[k] }

// SortMovements 全局排序：数值列按大小，文本列按码位（合并行的日期用最早那天参与排序）。
func SortMovements(rows []map[string]any, key string, asc bool) {
	num := key == "quantity_base" || key == "amount"
	sort.SliceStable(rows, func(i, j int) bool {
		if num {
			a, b := MovementSortValue(rows[i], key), MovementSortValue(rows[j], key)
			if asc {
				return a < b
			}
			return a > b
		}
		a, b := MovementSortText(rows[i], key), MovementSortText(rows[j], key)
		if asc {
			return a < b
		}
		return a > b
	})
}
