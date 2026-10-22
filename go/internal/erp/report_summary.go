package erp

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"strconv"
	"strings"
)

// 本文件是「经营分析报表」的业务口径，逐段对齐 Python routers/report.py：
//   _summary_of / _merge_summaries / _sales_by_spec_of / _sales_by_spec_all / _overview_of
// 报表是重聚合接口，浮点累加顺序、字典插入顺序、sorted 的并列次序都会影响结果，
// 因此这里的 SQL 文本与 Python（SQLAlchemy）编译出来的语句逐字保持一致，
// 让 SQLite 用同一个查询计划、返回同一个行序，Python 怎么累加 Go 就怎么累加。

// repAllWH 是「全仓合计」的保留分仓标识（Python report.ALL_WH）。
const repAllWH = "all"

// repInboundFeeRef 与 InboundFeeRef 同源（入库运费/装卸费镜像行，期间费用要剔除）。
const repInboundFeeRef = InboundFeeRef

// repPackFieldCase 是「关联结算行 → 成本字段」的 SQL CASE，
// 与 Python 里 case(...PACK_FIELD_OF_CATNAME..., name like '%打包' → labor_cogs, else other_cogs) 同一段 SQL。
const repPackFieldCase = `CASE WHEN TRIM(COALESCE(products_1.category, '')) = '人工' THEN 'labor_cogs' ` +
	`WHEN TRIM(COALESCE(products_1.category, '')) = '包材' THEN 'material_cogs' ` +
	`WHEN TRIM(COALESCE(products_1.category, '')) = '耗材' THEN 'material_cogs' ` +
	`WHEN TRIM(COALESCE(products_1.category, '')) = '包装' THEN 'material_cogs' ` +
	`WHEN TRIM(COALESCE(products_1.category, '')) = '快递' THEN 'express_cogs' ` +
	`WHEN TRIM(COALESCE(products_1.name, '')) LIKE '%打包' THEN 'labor_cogs' ELSE 'other_cogs' END`

// repKgPerBase 是 _kg_per_base(pr) 编译出的 SQL（1 个基础单位折成多少 kg）。
// 注意 1.0/1000.0 在 Python 侧是先算成 0.001 再作为绑定参数下发的，这里直接用同一个常量。
func repKgPerBase(alias string) string {
	return `CASE WHEN ` + alias + `.base_unit IN ('克', 'g') THEN 0.001 ELSE ` +
		`(1.0 / CAST(COALESCE(json_extract(` + alias + `.conversions, '$.' || ` + alias + `.default_unit), 1.0) AS FLOAT)) ` +
		`* COALESCE(` + alias + `.weight_kg, 0.0) END`
}

// repRound 与 Python 的 round(v, places) 逐位一致：先做十进制正确舍入（半偶），
// 再回到最近的双精度值。erp.Round 用 v*10^places 判半，遇到 0.145 这类
// 「乘完刚好落在 .5、真实值其实偏上」的数会和 Python 差一分，报表里这类中间值很多。
// 公用函数 erp.Round 保持原样不动，只在本模块用这个版本（详见 REPORT.md 的偏差说明）。
func repRound(v float64, places int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	out, err := strconv.ParseFloat(strconv.FormatFloat(v, 'f', places, 64), 64)
	if err != nil {
		return v
	}
	if out == 0 {
		return 0 // 消除 -0（与 erp.Round 行为一致）
	}
	return out
}

func repRound2(v float64) float64 { return repRound(v, 2) }
func repRound4(v float64) float64 { return repRound(v, 4) }
func repRound6(v float64) float64 { return repRound(v, 6) }

// repFloatStr 复刻 Python 的 str(float)：12.0 → "12.0"、12.5 → "12.5"。
func repFloatStr(v float64) string {
	s := strconv.FormatFloat(v, 'f', -1, 64)
	if !strings.ContainsAny(s, ".eE") {
		s += ".0"
	}
	return s
}

// repQtyStr 复刻 report.py::_fmt_qty（f"{v:.4f}".rstrip("0").rstrip(".") or "0"）。
func repQtyStr(v float64) string {
	s := strings.TrimRight(strconv.FormatFloat(v, 'f', 4, 64), "0")
	s = strings.TrimRight(s, ".")
	if s == "" {
		return "0"
	}
	return s
}

// repNum 取 JSON 数字（缺失/null 按 0，对齐 Python 的 `x or 0`）。
func repNum(m map[string]any, k string) float64 { return ToFloat(m[k]) }

// repDateConds 拼 ` AND <col> >= ? AND <col> <= ?`（空串=不加条件，与 Python 的 if date_from 一致）。
func repDateConds(col, from, to string) (string, []any) {
	s, args := "", []any{}
	if from != "" {
		s += " AND " + col + " >= ?"
		args = append(args, from)
	}
	if to != "" {
		s += " AND " + col + " <= ?"
		args = append(args, to)
	}
	return s, args
}

// repPaidCol 单据侧付款状态口径：空/NULL 一律按「已付款」看待（Python _is_paid）。
func repPaid(payStatus string) bool { return payStatus != "unpaid" }

// ---------------- 单据行 ----------------

type repOutbound struct {
	ID                                int
	Date, Code, Operator, Remark      string
	TotalAmount, SettleIncome, TotalCOGS float64
	BrushCost, BrushFee, BrushAutoFee float64
	PayStatus                         string
}

// income 销售行收入 = 销售收入 + 客户代收的关联结算（Python _income_of）。
func (o *repOutbound) income() float64 { return o.TotalAmount + o.SettleIncome }

// brushFeeOf 该单结算用的「快递+包装固定费」（Python brush.brush_fee_of）。
func (o *repOutbound) brushFeeOf() float64 {
	if o.BrushFee > 0 {
		return o.BrushFee
	}
	return o.BrushAutoFee
}

// brushAdjust 该单要从利润里额外扣掉的刷单结算额（Python brush.brush_adjust）。
func (o *repOutbound) brushAdjust() float64 {
	if o.BrushCost == 0 && o.BrushFee == 0 {
		return 0
	}
	return repRound(o.BrushCost+o.brushFeeOf()-o.BrushAutoFee, 2)
}

type repInbound struct {
	ID          int
	Code, Date  string
	Unit        string
	Supplier    string
	Operator    string
	Remark      string
	Quantity    float64
	TotalAmount float64
	Freight     float64
	Handling    float64
	ProductID   int // 0 = NULL
	PayStatus   string
	ProductName string // selectinload 出来的商品名（可能为空）
}

// landed 入库实际支出 = 货款 + 运费 + 装卸费（Python _inbound_landed）。
func (i *repInbound) landed() float64 {
	return repRound(i.TotalAmount+i.Freight+i.Handling, 2)
}

type repFinance struct {
	Type, Category, Date, Operator, Remark, RefType, PayStatus string
	Amount                                                     float64
}

type repOther struct {
	Category, Date, Operator, Remark, RefType, PayStatus string
	Amount                                               float64
}

type repWarehouseIn struct {
	ProductID, StockProductID int // 0 = NULL
	ProductName, Category, Unit string
	Date                       string
	Quantity, UnitPrice, Amount, COGS, FreightTotal, PackCost, BagWeight float64
	PayStatus string
}

// ---------------- 读单据（行序 = Python ORM 的返回序） ----------------

func repOutbounds(ctx context.Context, q Querier, from, to string) ([]*repOutbound, error) {
	cond, args := repDateConds("date", from, to)
	rows, err := q.QueryContext(ctx, "SELECT id, COALESCE(date,''), COALESCE(total_amount,0), COALESCE(settle_income,0), "+
		"COALESCE(total_cogs,0), COALESCE(brush_cost,0), COALESCE(brush_fee,0), COALESCE(brush_auto_fee,0), "+
		"COALESCE(pay_status,''), COALESCE(code,''), COALESCE(operator,''), COALESCE(remark,'') "+
		"FROM outbounds WHERE 1=1"+cond, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*repOutbound
	for rows.Next() {
		var o repOutbound
		if err := rows.Scan(&o.ID, &o.Date, &o.TotalAmount, &o.SettleIncome, &o.TotalCOGS, &o.BrushCost,
			&o.BrushFee, &o.BrushAutoFee, &o.PayStatus, &o.Code, &o.Operator, &o.Remark); err != nil {
			return nil, err
		}
		out = append(out, &o)
	}
	return out, rows.Err()
}

func repInbounds(ctx context.Context, q Querier, from, to string) ([]*repInbound, error) {
	cond, args := repDateConds("date", from, to)
	rows, err := q.QueryContext(ctx, "SELECT id, COALESCE(code,''), COALESCE(date,''), COALESCE(unit,''), "+
		"COALESCE(supplier,''), COALESCE(operator,''), COALESCE(remark,''), COALESCE(quantity,0), "+
		"COALESCE(total_amount,0), COALESCE(freight,0), COALESCE(handling,0), COALESCE(product_id,0), COALESCE(pay_status,'') "+
		"FROM inbounds WHERE 1=1"+cond, args...)
	if err != nil {
		return nil, err
	}
	var out []*repInbound
	nameOf := map[int]string{}
	for rows.Next() {
		var i repInbound
		if err := rows.Scan(&i.ID, &i.Code, &i.Date, &i.Unit, &i.Supplier, &i.Operator, &i.Remark,
			&i.Quantity, &i.TotalAmount, &i.Freight, &i.Handling, &i.ProductID, &i.PayStatus); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, &i)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	// Python 用 selectinload(Inbound.product) 二次取商品，这里同样按 id 批量取名
	ids := []any{}
	seen := map[int]bool{}
	for _, i := range out {
		if i.ProductID != 0 && !seen[i.ProductID] {
			seen[i.ProductID] = true
			ids = append(ids, i.ProductID)
		}
	}
	if len(ids) > 0 {
		ph := strings.TrimRight(strings.Repeat("?,", len(ids)), ",")
		prows, err := q.QueryContext(ctx, "SELECT id, COALESCE(name,'') FROM products WHERE id IN ("+ph+")", ids...)
		if err != nil {
			return nil, err
		}
		defer prows.Close()
		for prows.Next() {
			var id int
			var name string
			if err := prows.Scan(&id, &name); err == nil {
				nameOf[id] = name
			}
		}
	}
	for _, i := range out {
		i.ProductName = nameOf[i.ProductID] // 关联不到商品时为 ""（Python 的 i.product 为 None）
	}
	return out, nil
}

func repFinances(ctx context.Context, q Querier, from, to string) ([]*repFinance, error) {
	cond, args := repDateConds("date", from, to)
	rows, err := q.QueryContext(ctx, "SELECT COALESCE(type,''), COALESCE(category,''), COALESCE(amount,0), COALESCE(date,''), "+
		"COALESCE(operator,''), COALESCE(remark,''), COALESCE(ref_type,''), COALESCE(pay_status,'') "+
		"FROM finance_records WHERE 1=1"+cond, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*repFinance
	for rows.Next() {
		var f repFinance
		if err := rows.Scan(&f.Type, &f.Category, &f.Amount, &f.Date, &f.Operator, &f.Remark, &f.RefType, &f.PayStatus); err != nil {
			return nil, err
		}
		out = append(out, &f)
	}
	return out, rows.Err()
}

func repOthers(ctx context.Context, q Querier, from, to string) ([]*repOther, error) {
	cond, args := repDateConds("date", from, to)
	rows, err := q.QueryContext(ctx, "SELECT COALESCE(category,''), COALESCE(amount,0), COALESCE(date,''), COALESCE(operator,''), "+
		"COALESCE(remark,''), COALESCE(ref_type,''), COALESCE(pay_status,'') FROM other_expenses WHERE 1=1"+cond, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*repOther
	for rows.Next() {
		var e repOther
		if err := rows.Scan(&e.Category, &e.Amount, &e.Date, &e.Operator, &e.Remark, &e.RefType, &e.PayStatus); err != nil {
			return nil, err
		}
		out = append(out, &e)
	}
	return out, rows.Err()
}

func repWarehouseIns(ctx context.Context, q Querier, from, to string) ([]*repWarehouseIn, error) {
	cond, args := repDateConds("date", from, to)
	rows, err := q.QueryContext(ctx, "SELECT COALESCE(product_id,0), COALESCE(product_name,''), COALESCE(category,''), COALESCE(unit,''), "+
		"COALESCE(quantity,0), COALESCE(unit_price,0), COALESCE(amount,0), COALESCE(cogs,0), COALESCE(freight_total,0), "+
		"COALESCE(pack_cost,0), COALESCE(bag_weight,0), COALESCE(stock_product_id,0), COALESCE(pay_status,'') "+
		"FROM warehouse_ins WHERE 1=1"+cond, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*repWarehouseIn
	for rows.Next() {
		var w repWarehouseIn
		if err := rows.Scan(&w.ProductID, &w.ProductName, &w.Category, &w.Unit, &w.Quantity, &w.UnitPrice,
			&w.Amount, &w.COGS, &w.FreightTotal, &w.PackCost, &w.BagWeight, &w.StockProductID, &w.PayStatus); err != nil {
			return nil, err
		}
		out = append(out, &w)
	}
	return out, rows.Err()
}

// repSplitPaid 按付款状态拆成 (已付款, 待付款)，保持原行序（Python _split_paid）。
func repSplitPaidT[T any](list []T, pay func(T) string) ([]T, []T) {
	paid, unpaid := []T{}, []T{}
	for _, it := range list {
		if repPaid(pay(it)) {
			paid = append(paid, it)
		} else {
			unpaid = append(unpaid, it)
		}
	}
	return paid, unpaid
}

func repSplitOutbounds(list []*repOutbound) ([]*repOutbound, []*repOutbound) {
	return repSplitPaidT(list, func(o *repOutbound) string { return o.PayStatus })
}
func repSplitInbounds(list []*repInbound) ([]*repInbound, []*repInbound) {
	return repSplitPaidT(list, func(i *repInbound) string { return i.PayStatus })
}
func repSplitFinances(list []*repFinance) ([]*repFinance, []*repFinance) {
	return repSplitPaidT(list, func(f *repFinance) string { return f.PayStatus })
}
func repSplitOthers(list []*repOther) ([]*repOther, []*repOther) {
	return repSplitPaidT(list, func(e *repOther) string { return e.PayStatus })
}
func repSplitWIs(list []*repWarehouseIn) ([]*repWarehouseIn, []*repWarehouseIn) {
	return repSplitPaidT(list, func(w *repWarehouseIn) string { return w.PayStatus })
}

// repPendingStats 未计入本报表的待付款/待收款汇总（Python _pending_stats）。
func repPendingStats(unpaidInbounds []*repInbound, unpaidOutbounds []*repOutbound,
	unpaidOthers []*repOther, unpaidFinances []*repFinance, unpaidWIs []*repWarehouseIn) map[string]any {
	payables, receivables := []float64{}, []float64{}
	for _, i := range unpaidInbounds {
		payables = append(payables, i.TotalAmount)
	}
	for _, e := range unpaidOthers {
		payables = append(payables, e.Amount)
	}
	for _, f := range unpaidFinances {
		if f.Type == "expense" && f.RefType == "manual" {
			payables = append(payables, f.Amount)
		}
	}
	for _, o := range unpaidOutbounds {
		receivables = append(receivables, o.income())
	}
	for _, w := range unpaidWIs {
		receivables = append(receivables, w.Amount)
	}
	for _, f := range unpaidFinances {
		if f.Type == "income" && f.RefType == "manual" {
			receivables = append(receivables, f.Amount)
		}
	}
	sum := func(list []float64) float64 {
		t := 0.0
		for _, v := range list {
			t += v
		}
		return t
	}
	return map[string]any{
		"payables_count":     len(payables),
		"payables_amount":    repRound2(sum(payables)),
		"receivables_count":  len(receivables),
		"receivables_amount": repRound2(sum(receivables)),
	}
}

// ---------------- 商品维度分桶 ----------------

// repBK 是「商品 + 规格 + 是否代发」桶键（pid=0 表示 product_id 为 NULL）。
type repBK struct {
	pid  int
	spec string
	dr   bool
}

type repBucket struct {
	pid          int
	spec         string
	dr           bool
	name, code   string
	unit         string
	srcs         map[string]bool
	qty, amount  float64
	grossSales   float64
	goodsCogs    float64
	laborCogs    float64
	materialCogs float64
	otherCogs    float64
	expressCogs  float64
	brushCogs    float64
	settleIncome float64
}

func (b *repBucket) add(field string, v float64) {
	switch field {
	case "labor_cogs":
		b.laborCogs += v
	case "material_cogs":
		b.materialCogs += v
	case "express_cogs":
		b.expressCogs += v
	case "other_cogs":
		b.otherCogs += v
	case "brush_cogs":
		b.brushCogs += v
	case "settle_income":
		b.settleIncome += v
	}
}

type repBucketSet struct {
	m   map[repBK]*repBucket
	ord []repBK
}

func newRepBucketSet() *repBucketSet { return &repBucketSet{m: map[repBK]*repBucket{}} }

// bucket 等价于 Python 的 _bucket：不存在就按当前顺序建桶（name 只在建桶时写入）。
func (s *repBucketSet) bucket(pid int, spec string, dr bool, name string) *repBucket {
	k := repBK{pid: pid, spec: spec, dr: dr}
	if b, ok := s.m[k]; ok {
		return b
	}
	b := &repBucket{pid: pid, spec: spec, dr: dr, name: name, srcs: map[string]bool{}}
	s.m[k] = b
	s.ord = append(s.ord, k)
	return b
}

// repSaleRow 是「① 销售行按单×商品×规格×代发」聚合出的一行。
type repSaleRow struct {
	oid   int
	pid   int
	spec  string
	dr    bool
	n     int
	qb    float64
	amt   float64
	gross float64
	goods float64
	pname string
	pcode string
	ig    string
	jst   int
}

// ---------------- 单仓经营汇总 ----------------

// SummaryOf 单个分仓的经营汇总（Python report._summary_of）。
// whKey/whName 只用于回填响应的 warehouse 字段；isCurrent 由调用方按会话分仓判定。
func SummaryOf(ctx context.Context, q Querier, dateFrom, dateTo, whKey, whName string, excludeOther, isCurrent bool) (map[string]any, error) {
	outbounds, err := repOutbounds(ctx, q, dateFrom, dateTo)
	if err != nil {
		return nil, err
	}
	inbounds, err := repInbounds(ctx, q, dateFrom, dateTo)
	if err != nil {
		return nil, err
	}
	finances, err := repFinances(ctx, q, dateFrom, dateTo)
	if err != nil {
		return nil, err
	}
	othersAll, err := repOthers(ctx, q, dateFrom, dateTo)
	if err != nil {
		return nil, err
	}
	warehouseIns, err := repWarehouseIns(ctx, q, dateFrom, dateTo)
	if err != nil {
		return nil, err
	}
	paidOB, unpaidOB := repSplitOutbounds(outbounds)
	paidIB, unpaidIB := repSplitInbounds(inbounds)
	paidFIN, unpaidFIN := repSplitFinances(finances)
	paidOE, unpaidOE := repSplitOthers(othersAll)
	paidWI, unpaidWI := repSplitWIs(warehouseIns)

	// 运费/装卸费镜像行已计入批次到岸成本，期间费用里要剔除（待付款口径保留）
	others := make([]*repOther, 0, len(paidOE))
	for _, e := range paidOE {
		if e.RefType != repInboundFeeRef {
			others = append(others, e)
		}
	}

	// ---- 入仓（入仓品卖到京东）----
	wiRevenue := 0.0
	wiGoods := 0.0
	wiFreight := 0.0
	wiPack := 0.0
	for _, w := range paidWI {
		wiRevenue += w.Amount
		wiGoods += w.COGS
		wiFreight += w.FreightTotal
		wiPack += w.PackCost
	}
	wiRevenue = repRound2(wiRevenue)
	wiGoods = repRound2(wiGoods)
	wiFreight = repRound2(wiFreight)
	wiPack = repRound2(wiPack)
	wiCOGS := repRound(wiGoods+wiFreight+wiPack, 2)

	revenue := 0.0
	for _, o := range paidOB {
		revenue += o.income()
	}
	revenue += wiRevenue
	cogs := 0.0
	for _, o := range paidOB {
		cogs += o.TotalCOGS
	}
	cogs += wiCOGS

	brushInput := 0.0
	brushTotal := 0.0
	brushFeeTotal := 0.0
	for _, o := range paidOB {
		brushInput += o.BrushCost
		brushTotal += o.brushAdjust()
		brushFeeTotal += o.brushFeeOf()
	}
	brushInput = repRound2(brushInput)
	brushTotal = repRound2(brushTotal)
	brushFeeTotal = repRound2(brushFeeTotal)
	gross := repRound(revenue-cogs-brushTotal, 2)

	manualExpense := 0.0
	purchase := 0.0
	for _, f := range paidFIN {
		if f.Type != "expense" {
			continue
		}
		if f.Category != "采购支出" {
			manualExpense += f.Amount
		} else {
			purchase += f.Amount
		}
	}
	_ = purchase // Python 里 purchase 变量算了但不输出（输出用 purchase_db）

	otherRaw := 0.0
	for _, e := range others {
		otherRaw += e.Amount
	}
	otherRaw = repRound2(otherRaw)
	othersIn := others
	otherTotal := otherRaw
	if excludeOther {
		othersIn = nil
		otherTotal = 0.0
	}
	expense := repRound(manualExpense+otherTotal, 2)

	purchaseDB := 0.0
	for _, i := range paidIB {
		purchaseDB += i.landed()
	}

	net := repRound(gross-expense, 2)

	stockValue := 0.0
	{
		srows, err := q.QueryContext(ctx, "SELECT COALESCE(stock_value,0) FROM products")
		if err != nil {
			return nil, err
		}
		for srows.Next() {
			var v float64
			if err := srows.Scan(&v); err == nil {
				stockValue += v
			}
		}
		srows.Close()
		if err := srows.Err(); err != nil {
			return nil, err
		}
	}
	stockValue = repRound2(stockValue)

	// ---- 商品维度：交给与 Python 逐字一致的 SQL 聚合 ----
	lineCond, lineArgs := repDateConds("outbounds.date", dateFrom, dateTo)
	paidOut := " AND COALESCE(outbounds.pay_status, 'paid') != 'unpaid'"
	specExpr := `TRIM(COALESCE(outbound_lines.spec, ''))`
	drExpr := `COALESCE(outbound_lines.is_dropship, 0)`

	saleRows, err := repSaleRows(ctx, q, lineCond+paidOut, lineArgs, specExpr, drExpr)
	if err != nil {
		return nil, err
	}
	ownedRows, err := repOwnedRows(ctx, q, lineCond+paidOut, lineArgs)
	if err != nil {
		return nil, err
	}
	unownedRows, err := repUnownedRows(ctx, q, lineCond+paidOut, lineArgs)
	if err != nil {
		return nil, err
	}

	// 销量折成「默认单位」
	duOf, err := repDefaultUnits(ctx, q, saleRows)
	if err != nil {
		return nil, err
	}

	byProduct := newRepBucketSet()
	for _, r := range saleRows {
		d := byProduct.bucket(r.pid, r.spec, r.dr, r.pname)
		if r.pname != "" {
			d.name = r.pname
		}
		if r.pcode != "" {
			d.code = r.pcode
		}
		du := duOf[r.pid]
		factor := du.factor
		if factor == 0 {
			factor = 1.0
		}
		d.qty += r.qb / factor
		if du.unit != "" && d.unit == "" {
			d.unit = du.unit
		}
		src := "手动出库"
		if r.ig != "" {
			if r.jst != 0 {
				src = "聚水潭出库"
			} else {
				src = "导入出库"
			}
		}
		d.srcs[src] = true
		d.amount += r.amt
		d.grossSales += r.gross
		d.goodsCogs += r.goods
	}
	for _, r := range ownedRows {
		byProduct.bucket(r.pid, r.spec, r.dr, "").add(r.field, r.amt)
	}

	perOrder := map[int][]*repSaleRow{}
	for _, r := range saleRows {
		perOrder[r.oid] = append(perOrder[r.oid], r)
	}
	spread := func(oid int, field string, amt float64) {
		rowsO := perOrder[oid]
		if len(rowsO) == 0 || amt == 0 {
			return
		}
		totAmt := 0.0
		totN := 0
		for _, x := range rowsO {
			totAmt += x.amt
			totN += x.n
		}
		for _, x := range rowsO {
			share := 0.0
			if totAmt != 0 {
				share = x.amt / totAmt
			} else if totN != 0 {
				share = float64(x.n) / float64(totN)
			}
			byProduct.bucket(x.pid, x.spec, x.dr, "").add(field, amt*share)
		}
	}
	for _, r := range unownedRows {
		spread(r.oid, r.field, r.amt)
	}
	for _, o := range paidOB {
		spread(o.ID, "brush_cogs", o.brushAdjust())
	}
	for _, o := range paidOB {
		spread(o.ID, "settle_income", o.SettleIncome)
	}

	// ---- 净重 kg ----
	kg := map[repBK]float64{}
	addKG := func(pid int, spec string, dr bool, v float64) {
		k := repBK{pid: pid, spec: spec, dr: dr}
		kg[k] = repRound(kg[k]+v, 4)
	}
	singleLineOut, err := repSingleLineOutbounds(ctx, q, lineCond+paidOut, lineArgs)
	if err != nil {
		return nil, err
	}
	if err := repAddKG(ctx, q, lineCond+paidOut, lineArgs, specExpr, drExpr, singleLineOut, addKG); err != nil {
		return nil, err
	}

	// ---- 输出：按销售额倒序 + 规格归一 + 入仓行并入 ----
	productRows := make([]map[string]any, 0, len(byProduct.ord))
	ordered := make([]*repBucket, 0, len(byProduct.ord))
	for _, k := range byProduct.ord {
		ordered = append(ordered, byProduct.m[k])
	}
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].amount > ordered[j].amount })
	for _, d := range ordered {
		goods := repRound2(d.goodsCogs)
		labor := repRound2(d.laborCogs)
		material := repRound2(d.materialCogs)
		other := repRound2(d.otherCogs)
		pack := repRound(labor+material+other, 2)
		express := repRound2(d.expressCogs)
		brush := repRound2(d.brushCogs)
		totalCOGS := repRound(goods+pack+express+brush, 2)
		amount := repRound2(d.amount)
		grossSales := repRound2(d.grossSales)
		settle := repRound2(d.settleIncome)
		gp := repRound(amount+settle-totalCOGS, 2)
		base := grossSales
		if base == 0 {
			base = amount
		}
		denom := repRound(base+settle, 2)
		srcs := make([]string, 0, len(d.srcs))
		for s := range d.srcs {
			srcs = append(srcs, s)
		}
		sort.Strings(srcs)
		gpRate := 0.0
		if denom != 0 {
			gpRate = repRound(gp/denom*100, 2)
		}
		var pid any
		if d.pid != 0 {
			pid = d.pid
		}
		productRows = append(productRows, map[string]any{
			"product_id":    pid,
			"spec":          d.spec,
			"is_dropship":   d.dr,
			"name":          d.name,
			"code":          d.code,
			"qty":           repRound4(d.qty),
			"unit":          d.unit,
			"source":        strings.Join(srcs, " ＋ "),
			"weight_kg":     repRound4(kg[repBK{pid: d.pid, spec: d.spec, dr: d.dr}]),
			"amount":        amount,
			"gross_sales":   grossSales,
			"cogs":          totalCOGS,
			"goods_cogs":    goods,
			"pack_cogs":     pack,
			"labor_cogs":    labor,
			"material_cogs": material,
			"other_cogs":    other,
			"express_cogs":  express,
			"brush_cogs":    brush,
			"settle_income": settle,
			"total_cogs":    totalCOGS,
			"gross_profit":  gp,
			"gp_rate":       gpRate,
		})
	}

	// 规格归一：空规格并入「同名规格」
	type gpKey struct {
		pid int
		dr  bool
	}
	groups := map[gpKey][]map[string]any{}
	var gOrder []gpKey
	for _, r := range productRows {
		pid := ToInt(r["product_id"])
		k := gpKey{pid: pid, dr: ToBool(r["is_dropship"])}
		if _, ok := groups[k]; !ok {
			gOrder = append(gOrder, k)
		}
		groups[k] = append(groups[k], r)
	}
	merged := []map[string]any{}
	for _, k := range gOrder {
		rows := groups[k]
		named := []map[string]any{}
		blank := []map[string]any{}
		for _, r := range rows {
			if strings.TrimSpace(ToStr(r["spec"])) != "" {
				named = append(named, r)
			} else {
				blank = append(blank, r)
			}
		}
		if len(blank) > 0 && len(named) == 1 {
			t := named[0]
			for _, r := range blank {
				t["qty"] = ToFloat(t["qty"]) + ToFloat(r["qty"])
				t["weight_kg"] = repRound(ToFloat(t["weight_kg"])+ToFloat(r["weight_kg"]), 4)
				t["amount"] = ToFloat(t["amount"]) + ToFloat(r["amount"])
				t["gross_sales"] = ToFloat(t["gross_sales"]) + ToFloat(r["gross_sales"])
				for _, f := range []string{"cogs", "goods_cogs", "pack_cogs", "labor_cogs",
					"material_cogs", "other_cogs", "express_cogs", "brush_cogs", "settle_income", "total_cogs"} {
					t[f] = repRound(ToFloat(t[f])+ToFloat(r[f]), 2)
				}
				t["gross_profit"] = repRound(ToFloat(t["amount"])+ToFloat(t["settle_income"])-ToFloat(t["total_cogs"]), 2)
				den := ToFloat(t["gross_sales"])
				if den == 0 {
					den = ToFloat(t["amount"])
				}
				den = den + ToFloat(t["settle_income"])
				if den != 0 {
					t["gp_rate"] = repRound(ToFloat(t["gross_profit"])/den*100, 2)
				} else {
					t["gp_rate"] = 0.0
				}
			}
			merged = append(merged, named...)
		} else if len(blank) > 0 {
			for _, r := range blank {
				r["spec"] = "未标注规格"
			}
			merged = append(merged, named...)
			merged = append(merged, blank...)
		} else {
			merged = append(merged, named...)
		}
	}
	productRows = merged
	sort.SliceStable(productRows, func(i, j int) bool { return ToFloat(productRows[i]["amount"]) > ToFloat(productRows[j]["amount"]) })

	// 入仓品单独成行
	wiNetOf, wiUnitOf, err := repWarehouseMeta(ctx, q, paidWI)
	if err != nil {
		return nil, err
	}
	wiBuckets := map[[2]string]*repWIBucket{}
	var wiOrder [][2]string
	for _, w := range paidWI {
		nm := strings.TrimSpace(w.ProductName)
		cat := strings.TrimSpace(w.Category)
		k := [2]string{nm, cat}
		b, ok := wiBuckets[k]
		if !ok {
			unit := w.Unit
			if unit == "" {
				unit = "袋"
			}
			b = &repWIBucket{productID: w.ProductID, name: nm, spec: cat, unit: unit}
			wiBuckets[k] = b
			wiOrder = append(wiOrder, k)
		}
		b.qty += w.Quantity
		b.weight += repWIWeight(w, wiNetOf, wiUnitOf)
		b.amount += w.Amount
		b.grossSales += w.Quantity * w.UnitPrice
		b.goods += w.COGS
		b.freight += w.FreightTotal
		b.pack += w.PackCost
	}
	for _, k := range wiOrder {
		b := wiBuckets[k]
		goods := repRound2(b.goods)
		freight := repRound2(b.freight)
		pack := repRound2(b.pack)
		totalCOGS := repRound(goods+freight+pack, 2)
		amount := repRound2(b.amount)
		grossSales := repRound2(b.grossSales)
		gp := repRound(amount-totalCOGS, 2)
		wiGPRate := 0.0
		if grossSales != 0 {
			wiGPRate = repRound(gp/grossSales*100, 2)
		}
		var pid any
		if b.productID != 0 {
			pid = b.productID
		}
		name := b.name
		if name == "" {
			name = "（未命名入仓品）"
		}
		productRows = append(productRows, map[string]any{
			"product_id":      pid,
			"spec":            b.spec,
			"is_dropship":     false,
			"is_warehouse_in": true,
			"source":          "入仓",
			"name":            name,
			"code":            "",
			"unit":            b.unit,
			"qty":             repRound4(b.qty),
			"weight_kg":       repRound4(b.weight),
			"amount":          amount,
			"gross_sales":     grossSales,
			"cogs":            totalCOGS,
			"goods_cogs":      goods,
			"pack_cogs":       pack,
			"labor_cogs":      0.0,
			"material_cogs":   pack,
			"other_cogs":      0.0,
			"express_cogs":    freight,
			"brush_cogs":      0.0,
			"settle_income":   0.0,
			"total_cogs":      totalCOGS,
			"gross_profit":    gp,
			"gp_rate":         wiGPRate,
		})
	}
	sort.SliceStable(productRows, func(i, j int) bool { return ToFloat(productRows[i]["amount"]) > ToFloat(productRows[j]["amount"]) })

	// 关联结算成本拆分（按商品分类+名称归类）
	packCosts := map[string]float64{}
	var packOrder []string
	{
		cond := lineCond + " AND COALESCE(outbounds.pay_status, 'paid') != 'unpaid'"
		prows, err := q.QueryContext(ctx, "SELECT COALESCE(products.category,''), COALESCE(products.name,''), "+
			"COALESCE(SUM(outbound_lines.cogs), 0) FROM outbound_lines "+
			"JOIN outbounds ON outbounds.id = outbound_lines.outbound_id "+
			"LEFT OUTER JOIN products ON products.id = outbound_lines.product_id "+
			"WHERE outbound_lines.line_type = 'pack'"+cond+
			" GROUP BY products.category, products.name", lineArgs...)
		if err != nil {
			return nil, err
		}
		for prows.Next() {
			var cat, name string
			var amt float64
			if err := prows.Scan(&cat, &name, &amt); err != nil {
				continue
			}
			ck := PackCostBucketOf(cat, name)
			if _, ok := packCosts[ck]; !ok {
				packOrder = append(packOrder, ck)
			}
			packCosts[ck] = repRound(packCosts[ck]+amt, 2)
		}
		prows.Close()
		if err := prows.Err(); err != nil {
			return nil, err
		}
	}
	packTotal := 0.0
	for _, k := range packOrder {
		packTotal += packCosts[k]
	}
	packTotal = repRound2(packTotal)
	goodsCOGS := repRound(cogs-packTotal-wiFreight-wiPack, 2)

	manualFees := map[string]float64{}
	for _, f := range paidFIN {
		if f.Type != "expense" || f.Category == "采购支出" {
			continue
		}
		manualFees[f.Category] = repRound(manualFees[f.Category]+f.Amount, 2)
	}
	otherFees := map[string]float64{}
	for _, e := range othersIn {
		otherFees[e.Category] = repRound(otherFees[e.Category]+e.Amount, 2)
	}

	// 逐日 / 逐月支出
	expDay := newRepExpense()
	expMonth := newRepExpense()
	for _, i := range paidIB {
		amt := i.landed()
		expDay.add(i.Date, "purchase", amt)
		expMonth.add(monthOf(i.Date), "purchase", amt)
	}
	for _, e := range othersIn {
		expDay.add(e.Date, "other", e.Amount)
		expMonth.add(monthOf(e.Date), "other", e.Amount)
	}
	for _, f := range paidFIN {
		if f.Type != "expense" || f.Category == "采购支出" {
			continue
		}
		expDay.add(f.Date, "manual", f.Amount)
		expMonth.add(monthOf(f.Date), "manual", f.Amount)
	}
	for _, o := range paidOB {
		adj := o.brushAdjust()
		if adj == 0 && o.BrushFee == 0 {
			continue
		}
		expDay.add(o.Date, "brush", adj)
		expMonth.add(monthOf(o.Date), "brush", adj)
	}

	// 逐笔支出明细
	expenseItems := []map[string]any{}
	for _, i := range paidIB {
		fee := repRound(i.Freight+i.Handling, 2)
		note := i.Supplier
		if note == "" {
			note = i.Remark
		}
		if fee != 0 {
			parts := []string{}
			if i.Freight != 0 {
				parts = append(parts, "运费 ¥"+repFloatStr(repRound2(i.Freight)))
			}
			if i.Handling != 0 {
				parts = append(parts, "装卸费 ¥"+repFloatStr(repRound2(i.Handling)))
			}
			head := ""
			if note != "" {
				head = note + " · "
			}
			note = head + strings.Join(parts, "、") + "（已计入成本）"
		}
		label := ""
		if i.ProductName != "" {
			label = i.ProductName + " × " + repQtyStr(i.Quantity) + i.Unit
		} else {
			label = i.Code
			if label == "" {
				label = "入库"
			}
		}
		expenseItems = append(expenseItems, map[string]any{
			"date": i.Date, "source": "采购", "category": "采购支出", "item": label,
			"amount": i.landed(), "operator": i.Operator, "remark": note, "ref": i.Code, "auto": false,
		})
	}
	for _, e := range othersIn {
		expenseItems = append(expenseItems, map[string]any{
			"date": e.Date, "source": "其他开支", "category": e.Category, "item": e.Category,
			"amount": repRound2(e.Amount), "operator": e.Operator, "remark": e.Remark, "ref": "", "auto": false,
		})
	}
	for _, f := range paidFIN {
		if f.Type != "expense" || f.Category == "采购支出" {
			continue
		}
		expenseItems = append(expenseItems, map[string]any{
			"date": f.Date, "source": "手工记账", "category": f.Category, "item": f.Category,
			"amount": repRound2(f.Amount), "operator": f.Operator, "remark": f.Remark, "ref": "",
			"auto": f.RefType != "" && f.RefType != "manual",
		})
	}
	for _, o := range paidOB {
		adj := o.brushAdjust()
		if adj == 0 && o.BrushFee == 0 {
			continue
		}
		fee := repRound2(o.brushFeeOf())
		cost := repRound2(o.BrushCost)
		parts := []string{}
		if fee != 0 {
			parts = append(parts, "快递+包装 ¥"+repFloatStr(fee))
		}
		if cost != 0 {
			parts = append(parts, "刷单成本 ¥"+repFloatStr(cost))
		}
		detail := strings.Join(parts, " ＋ ")
		if detail == "" {
			detail = "刷单结算"
		}
		expenseItems = append(expenseItems, map[string]any{
			"date": o.Date, "source": "刷单成本", "category": "刷单成本", "item": detail,
			"amount": adj, "operator": o.Operator, "remark": o.Remark, "ref": o.Code, "auto": false,
		})
	}
	sort.SliceStable(expenseItems, func(i, j int) bool {
		return ToStr(expenseItems[i]["date"]) > ToStr(expenseItems[j]["date"])
	})

	wiQty := 0.0
	for _, w := range paidWI {
		wiQty += w.Quantity
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

	packCostsOut := map[string]float64{}
	for k, v := range packCosts {
		packCostsOut[k] = v
	}

	return map[string]any{
		"date_from": dateFrom,
		"date_to":   dateTo,
		"warehouse": map[string]any{"key": whKey, "name": whName},
		"is_current": isCurrent,
		"pending":    repPendingStats(unpaidIB, unpaidOB, unpaidOE, unpaidFIN, unpaidWI),
		"revenue":    repRound2(revenue),
		"settle_income": func() float64 {
			t := 0.0
			for _, o := range paidOB {
				t += o.SettleIncome
			}
			return repRound2(t)
		}(),
		"cogs":                    repRound2(cogs),
		"goods_cogs":              goodsCOGS,
		"warehouse_in_revenue":    wiRevenue,
		"warehouse_in_cogs":       wiCOGS,
		"warehouse_in_goods_cogs": wiGoods,
		"warehouse_in_freight":    wiFreight,
		"warehouse_in_pack":       wiPack,
		"warehouse_in_qty":        repRound4(wiQty),
		"warehouse_in_count":      len(paidWI),
		"brush_cost":              brushTotal,
		"brush_input_cost":        brushInput,
		"brush_fee_cost":          brushFeeTotal,
		"gross_profit":            gross,
		"expense":                 expense,
		"manual_expense":          repRound2(manualExpense),
		"other_expense":           otherTotal,
		"exclude_other_expense":   excludeOther,
		"excluded_other_expense":  otherRaw,
		"net_profit":              net,
		"purchase":                repRound2(purchaseDB),
		"total_expense":           repRound(purchaseDB+expense+brushTotal, 2),
		"stock_value":             stockValue,
		"order_count":             len(paidOB),
		"inbound_count":           len(paidIB),
		"by_product":              productRows,
		"pack_costs":              packCostsOut,
		"pack_cost_total":         packTotal,
		"manual_fees":             manualFees,
		"other_expenses":          otherFees,
		"expense_by_day":          expDay.rows("date"),
		"expense_by_month":        expMonth.rows("month"),
		"expense_items":           expenseItems,
		"fee_breakdown":           feeBreakdown,
	}, nil
}

func monthOf(date string) string {
	if len(date) >= 7 {
		return date[:7]
	}
	return ""
}

// repWIBucket 入仓品行桶（按「入仓品名 + 分类」）。
type repWIBucket struct {
	productID                          int
	name, spec, unit                   string
	qty, amount, grossSales            float64
	goods, freight, pack, weight       float64
}

var repNetWeightGrams = map[string]float64{
	"克": 1.0, "g": 1.0, "两": 50.0, "斤": 500.0,
	"公斤": 1000.0, "千克": 1000.0, "kg": 1000.0,
}

// repNetWeightKg 与 warehouse_in.net_weight_kg 一致（注意只 strip，不做大小写归一）。
func repNetWeightKg(value float64, unit string) float64 {
	grams := repNetWeightGrams[strings.TrimSpace(unit)]
	if grams == 0 {
		return 0.0
	}
	return repRound(value*grams/1000.0, 6)
}

func repWIWeight(w *repWarehouseIn, netOf map[int][2]any, unitOf map[int]string) float64 {
	qty := w.Quantity
	net, unit := 0.0, ""
	if p, ok := netOf[w.ProductID]; ok {
		net = ToFloat(p[0])
		unit = ToStr(p[1])
	}
	if net > 0 {
		return qty * repNetWeightKg(net, unit)
	}
	return qty * repNetWeightKg(w.BagWeight, unitOf[w.StockProductID])
}

// repWarehouseMeta 取「入仓品每袋净重」与「关联库存商品默认单位」。
func repWarehouseMeta(ctx context.Context, q Querier, list []*repWarehouseIn) (map[int][2]any, map[int]string, error) {
	netOf := map[int][2]any{}
	unitOf := map[int]string{}
	pids := []any{}
	seen := map[int]bool{}
	for _, w := range list {
		if w.ProductID != 0 && !seen[w.ProductID] {
			seen[w.ProductID] = true
			pids = append(pids, w.ProductID)
		}
	}
	if len(pids) > 0 {
		ph := strings.TrimRight(strings.Repeat("?,", len(pids)), ",")
		rows, err := q.QueryContext(ctx, "SELECT id, COALESCE(bag_net_weight,0), COALESCE(bag_net_unit,'') FROM warehouse_products WHERE id IN ("+ph+")", pids...)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var id int
			var w float64
			var u string
			if err := rows.Scan(&id, &w, &u); err == nil {
				netOf[id] = [2]any{w, strings.TrimSpace(u)}
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, nil, err
		}
	}
	spids := []any{}
	seen2 := map[int]bool{}
	for _, w := range list {
		if w.StockProductID != 0 && !seen2[w.StockProductID] {
			seen2[w.StockProductID] = true
			spids = append(spids, w.StockProductID)
		}
	}
	if len(spids) > 0 {
		ph := strings.TrimRight(strings.Repeat("?,", len(spids)), ",")
		rows, err := q.QueryContext(ctx, "SELECT id, COALESCE(default_unit,''), COALESCE(base_unit,'') FROM products WHERE id IN ("+ph+")", spids...)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var id int
			var du, bu string
			if err := rows.Scan(&id, &du, &bu); err == nil {
				u := du
				if u == "" {
					u = bu
				}
				unitOf[id] = strings.TrimSpace(u)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, nil, err
		}
	}
	return netOf, unitOf, nil
}

// repExpenseBucket 逐日/逐月支出桶（四类 + 笔数）。
type repExpenseBucket struct {
	m   map[string][5]float64 // purchase, other, manual, brush, count
	ord []string
}

func newRepExpense() *repExpenseBucket { return &repExpenseBucket{m: map[string][5]float64{}} }

func (b *repExpenseBucket) add(key, kind string, amount float64) {
	if key == "" {
		return
	}
	v, ok := b.m[key]
	if !ok {
		b.ord = append(b.ord, key)
	}
	idx := map[string]int{"purchase": 0, "other": 1, "manual": 2, "brush": 3}
	v[idx[kind]] += amount
	v[4]++
	b.m[key] = v
}

// rows 按日期/月份倒序输出（Python sorted(bucket.items(), reverse=True)）。
func (b *repExpenseBucket) rows(label string) []map[string]any {
	keys := make([]string, len(b.m))
	i := 0
	for k := range b.m {
		keys[i] = k
		i++
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	out := make([]map[string]any, 0, len(keys))
	for _, k := range keys {
		v := b.m[k]
		out = append(out, map[string]any{
			label:            k,
			"purchase":       repRound2(v[0]),
			"other_expense":  repRound2(v[1]),
			"manual_expense": repRound2(v[2]),
			"brush_expense":  repRound2(v[3]),
			"period_expense": repRound(v[1]+v[2], 2),
			"total":          repRound(v[0]+v[1]+v[2]+v[3], 2),
			"count":          int(v[4]),
		})
	}
	return out
}

// ---------------- 商品维度 SQL（与 SQLAlchemy 编译结果逐字一致） ----------------

func repSaleRows(ctx context.Context, q Querier, cond string, args []any, specExpr, drExpr string) ([]*repSaleRow, error) {
	sqlText := `SELECT outbound_lines.outbound_id AS oid, outbound_lines.product_id AS pid, ` + specExpr + ` AS spec, ` + drExpr + ` AS dr, ` +
		`COUNT(*) AS n, COALESCE(SUM(outbound_lines.quantity_base), 0) AS qb, COALESCE(SUM(outbound_lines.amount), 0) AS amt, ` +
		`COALESCE(SUM(COALESCE(outbound_lines.gross_sales, outbound_lines.amount)), 0) AS gross, ` +
		`COALESCE(SUM(outbound_lines.cogs), 0) AS goods, MAX(products.name) AS pname, MAX(products.code) AS pcode, ` +
		`MAX(COALESCE(outbounds.import_group, '')) AS ig, ` +
		`MAX(CASE WHEN outbounds.remark LIKE '%聚水潭%' THEN 1 ELSE 0 END) AS jst ` +
		`FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id ` +
		`LEFT OUTER JOIN products ON products.id = outbound_lines.product_id ` +
		`WHERE outbound_lines.line_type = 'sale'` + cond +
		` GROUP BY outbound_lines.outbound_id, outbound_lines.product_id, ` + specExpr + `, ` + drExpr
	rows, err := q.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*repSaleRow
	for rows.Next() {
		var r repSaleRow
		var pid sql.NullInt64
		var pname, pcode, ig sql.NullString
		var n, jst sql.NullInt64
		if err := rows.Scan(&r.oid, &pid, &r.spec, &r.dr, &n, &r.qb, &r.amt, &r.gross, &r.goods,
			&pname, &pcode, &ig, &jst); err != nil {
			return nil, err
		}
		r.pid = int(pid.Int64)
		r.pname, r.pcode, r.ig = pname.String, pcode.String, ig.String
		r.n, r.jst = int(n.Int64), int(jst.Int64)
		out = append(out, &r)
	}
	return out, rows.Err()
}

func repOwnedRows(ctx context.Context, q Querier, cond string, args []any) ([]struct {
	pid   int
	spec  string
	dr    bool
	field string
	amt   float64
}, error) {
	sqlText := `SELECT outbound_lines_1.product_id AS pid, TRIM(COALESCE(outbound_lines_1.spec, '')) AS spec, ` +
		`COALESCE(outbound_lines_1.is_dropship, 0) AS dr, ` + repPackFieldCase + ` AS field, COALESCE(SUM(outbound_lines.cogs), 0) AS amt ` +
		`FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id ` +
		`JOIN (SELECT outbound_lines.outbound_id AS oid, outbound_lines.product_id AS pid, MIN(outbound_lines.id) AS sid ` +
		`FROM outbound_lines WHERE outbound_lines.line_type = 'sale' ` +
		`GROUP BY outbound_lines.outbound_id, outbound_lines.product_id) AS anon_1 ` +
		`ON anon_1.oid = outbound_lines.outbound_id AND anon_1.pid = outbound_lines.sale_product_id ` +
		`JOIN outbound_lines AS outbound_lines_1 ON outbound_lines_1.id = anon_1.sid ` +
		`LEFT OUTER JOIN products AS products_1 ON products_1.id = outbound_lines.product_id ` +
		`WHERE outbound_lines.line_type = 'pack'` + cond +
		` GROUP BY outbound_lines_1.product_id, TRIM(COALESCE(outbound_lines_1.spec, '')), ` +
		`COALESCE(outbound_lines_1.is_dropship, 0), ` + repPackFieldCase
	rows, err := q.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []struct {
		pid   int
		spec  string
		dr    bool
		field string
		amt   float64
	}{}
	for rows.Next() {
		var it struct {
			pid   int
			spec  string
			dr    bool
			field string
			amt   float64
		}
		var pid sql.NullInt64
		if err := rows.Scan(&pid, &it.spec, &it.dr, &it.field, &it.amt); err != nil {
			return nil, err
		}
		it.pid = int(pid.Int64)
		out = append(out, it)
	}
	return out, rows.Err()
}

func repUnownedRows(ctx context.Context, q Querier, cond string, args []any) ([]struct {
	oid   int
	field string
	amt   float64
}, error) {
	sqlText := `SELECT outbound_lines.outbound_id AS oid, ` + repPackFieldCase + ` AS field, COALESCE(SUM(outbound_lines.cogs), 0) AS amt ` +
		`FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id ` +
		`LEFT OUTER JOIN products AS products_1 ON products_1.id = outbound_lines.product_id ` +
		`WHERE outbound_lines.line_type = 'pack'` + cond +
		` AND (outbound_lines.sale_product_id IS NULL OR NOT (EXISTS (SELECT outbound_lines_1.id ` +
		`FROM outbound_lines AS outbound_lines_1 ` +
		`WHERE outbound_lines_1.outbound_id = outbound_lines.outbound_id ` +
		`AND outbound_lines_1.line_type = 'sale' AND outbound_lines_1.product_id = outbound_lines.sale_product_id))) ` +
		`GROUP BY outbound_lines.outbound_id, ` + repPackFieldCase
	rows, err := q.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []struct {
		oid   int
		field string
		amt   float64
	}{}
	for rows.Next() {
		var it struct {
			oid   int
			field string
			amt   float64
		}
		if err := rows.Scan(&it.oid, &it.field, &it.amt); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func repSingleLineOutbounds(ctx context.Context, q Querier, cond string, args []any) ([]int, error) {
	rows, err := q.QueryContext(ctx, `SELECT outbound_lines.outbound_id, COUNT(*) FROM outbound_lines `+
		`JOIN outbounds ON outbounds.id = outbound_lines.outbound_id `+
		`WHERE outbound_lines.line_type = 'sale'`+cond+` GROUP BY outbound_lines.outbound_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var oid int
		var cnt int
		if err := rows.Scan(&oid, &cnt); err == nil && cnt == 1 {
			out = append(out, oid)
		}
	}
	return out, rows.Err()
}

// repAddKG 三段重量查询（与 Python 的分段口径一致：不能合并成一条带 OR 的 JOIN）。
func repAddKG(ctx context.Context, q Querier, cond string, args []any, specExpr, drExpr string,
	singleLineOut []int, add func(pid int, spec string, dr bool, v float64)) error {

	scanKG := func(sqlText string, qa []any) error {
		rows, err := q.QueryContext(ctx, sqlText, qa...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var pid sql.NullInt64
			var spec string
			var dr bool
			var v float64
			if err := rows.Scan(&pid, &spec, &dr, &v); err != nil {
				continue
			}
			add(int(pid.Int64), spec, dr, v)
		}
		return rows.Err()
	}

	kgExpr := repKgPerBase("products_1")
	// ①-A 新流水：严格按 line_id 关联
	if err := scanKG(`SELECT outbound_lines.product_id, `+specExpr+`, `+drExpr+`, `+
		`COALESCE(SUM((-stock_movements.quantity_base) * `+kgExpr+`), 0.0) `+
		`FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id `+
		`JOIN stock_movements ON stock_movements.ref_type = 'outbound' AND stock_movements.line_id = outbound_lines.id `+
		`LEFT OUTER JOIN products AS products_1 ON products_1.id = stock_movements.product_id `+
		`WHERE outbound_lines.line_type = 'sale'`+cond+
		` GROUP BY outbound_lines.product_id, `+specExpr+`, `+drExpr, args); err != nil {
		return err
	}
	if len(singleLineOut) == 0 {
		// ② 没有任何按 line_id 的流水
		return scanKG(`SELECT outbound_lines.product_id, `+specExpr+`, `+drExpr+`, `+
			`COALESCE(SUM(outbound_lines.quantity_base * `+kgExpr+`), 0.0) `+
			`FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id `+
			`LEFT OUTER JOIN products AS products_1 ON products_1.id = outbound_lines.product_id `+
			`WHERE outbound_lines.line_type = 'sale'`+cond+
			` AND NOT (EXISTS (SELECT * FROM stock_movements `+
			`WHERE stock_movements.ref_type = 'outbound' AND stock_movements.line_id = outbound_lines.id)) `+
			`GROUP BY outbound_lines.product_id, `+specExpr+`, `+drExpr, args)
	}
	ids := ToArgs(singleLineOut)
	ph := Placeholders(len(singleLineOut))
	// ①-B 旧流水（line_id 为空）：仅「该单只有一条销售行」时按整单归属
	if err := scanKG(`SELECT outbound_lines.product_id, `+specExpr+`, `+drExpr+`, `+
		`COALESCE(SUM((-stock_movements.quantity_base) * `+kgExpr+`), 0.0) `+
		`FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id `+
		`JOIN stock_movements ON stock_movements.ref_type = 'outbound' AND stock_movements.line_id IS NULL `+
		`AND stock_movements.ref_id = outbounds.id `+
		`LEFT OUTER JOIN products AS products_1 ON products_1.id = stock_movements.product_id `+
		`WHERE outbound_lines.line_type = 'sale'`+cond+` AND outbounds.id IN (`+ph+`) `+
		`GROUP BY outbound_lines.product_id, `+specExpr+`, `+drExpr, append(append([]any{}, args...), ids...)); err != nil {
		return err
	}
	// ② 完全没有扣减流水的销售行（代发等）：回退用订单商品自身单件净重
	a2 := append(append([]any{}, args...), ids...)
	return scanKG(`SELECT outbound_lines.product_id, `+specExpr+`, `+drExpr+`, `+
		`COALESCE(SUM(outbound_lines.quantity_base * `+kgExpr+`), 0.0) `+
		`FROM outbound_lines JOIN outbounds ON outbounds.id = outbound_lines.outbound_id `+
		`LEFT OUTER JOIN products AS products_1 ON products_1.id = outbound_lines.product_id `+
		`WHERE outbound_lines.line_type = 'sale'`+cond+
		` AND NOT (EXISTS (SELECT * FROM stock_movements `+
		`WHERE stock_movements.ref_type = 'outbound' AND stock_movements.line_id = outbound_lines.id)) `+
		`AND ((outbounds.id NOT IN (`+ph+`)) OR NOT (EXISTS (SELECT * FROM stock_movements `+
		`WHERE stock_movements.ref_type = 'outbound' AND stock_movements.line_id IS NULL `+
		`AND stock_movements.ref_id = outbounds.id))) `+
		`GROUP BY outbound_lines.product_id, `+specExpr+`, `+drExpr, a2)
}

// repDU 是 Python du_of 的 (默认单位, 换算系数) 二元组。
type repDU struct {
	unit   string
	factor float64
}

// repDefaultUnits 复刻 Python 的 du_of：默认单位（空则回退基础单位）与该单位换算系数。
func repDefaultUnits(ctx context.Context, q Querier, saleRows []*repSaleRow) (map[int]repDU, error) {
	set := map[int]bool{}
	for _, r := range saleRows {
		if r.pid != 0 {
			set[r.pid] = true
		}
	}
	out := map[int]repDU{}
	if len(set) == 0 {
		return out, nil
	}
	ids := make([]int, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	args := ToArgs(ids)
	rows, err := q.QueryContext(ctx, "SELECT id, COALESCE(default_unit,''), COALESCE(base_unit,''), conversions "+
		"FROM products WHERE id IN ("+Placeholders(len(ids))+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var du, bu string
		var conv sql.NullString
		if err := rows.Scan(&id, &du, &bu, &conv); err != nil {
			continue
		}
		u := du
		if u == "" {
			u = bu
		}
		u = strings.TrimSpace(u)
		f := ToFloat(decodeFloatMap(conv.String)[u])
		if f == 0 {
			f = 1
		}
		if f == 0 {
			f = 1.0
		}
		out[id] = repDU{unit: u, factor: f}
	}
	return out, rows.Err()
}
