package erp

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 本文件是「对外只读成本表」GET /api/open/sku-costs 的业务层，逐字段对齐
// Python routers/open_api.py；订单商品那半边复用报表 routers/report.py::_summary_of
// 的「商品销售明细」口径（只取对外成本表要用的那几个字段），不另写一套分摊规则。
//
// 命名一律带 Open 前缀：report 模块也会移植 _summary_of，合并时若撞车以 report 的为准。

// openPaidStatus 付款状态默认值（历史数据 pay_status 为空即视为已付款）。
const openPaidStatus = "paid"
// OpenFallbackDefaults 兜底默认值：JSON 配置缺失时的出厂口径（运费 5 元、扣点 0、退货率 5%）。
var OpenFallbackDefaults = map[string]any{
	"shipping": 5.0, "platformRate": 0.0, "package": 0.0, "labor": 0.0, "returnRate": 0.05,
}

// openDefaultKeys 默认值文件的合法键（顺序与 Python 的 dict 一致）。
var openDefaultKeys = []string{"shipping", "platformRate", "package", "labor", "returnRate"}

func openReadJSONObject(path string) map[string]any {
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	raw = trimJSONBOM(raw)
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var data map[string]any
	if err := dec.Decode(&data); err != nil {
		return map[string]any{}
	}
	if data == nil {
		return map[string]any{}
	}
	return data
}

// OpenAPIToken 读 open_api.token（config.local.json 覆盖 product_rules.json，与 Python load_rules 同序）。
// 未配置返回空串，调用方据此回 503。
func OpenAPIToken(repoRoot string) string {
	if repoRoot == "" {
		return ""
	}
	sep := string(os.PathSeparator)
	rules := openReadJSONObject(repoRoot + sep + "product_rules.json")
	local := openReadJSONObject(repoRoot + sep + "config.local.json")
	merged := deepMergeMap(rules, local)
	sec, _ := merged["open_api"].(map[string]any)
	return strings.TrimSpace(ToStr(sec["token"]))
}

func deepMergeMap(base, override map[string]any) map[string]any {
	out := make(map[string]any, len(base))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range override {
		if bm, ok := out[k].(map[string]any); ok {
			if vm, ok2 := v.(map[string]any); ok2 {
				out[k] = deepMergeMap(bm, vm)
				continue
			}
		}
		out[k] = v
	}
	return out
}

// OpenCostDefaults 全店默认成本：文件缺失/损坏或非数值项都回落到出厂默认。
// 文件里的数值按原始字面量输出（json.Number），与 Python 保留 int/float 类型一致。
func OpenCostDefaults(path string) map[string]any {
	out := make(map[string]any, len(openDefaultKeys))
	for _, k := range openDefaultKeys {
		out[k] = OpenFallbackDefaults[k]
	}
	if path == "" {
		return out
	}
	data := openReadJSONObject(path)
	for _, k := range openDefaultKeys {
		v, ok := data[k]
		if !ok {
			continue
		}
		switch n := v.(type) {
		case json.Number: // bool 在 JSON 里不是 Number，天然排除（Python 同样拒绝 bool）
			if _, err := n.Float64(); err == nil {
				out[k] = n
			}
		}
	}
	return out
}

// ---- 日期规范化（_norm_date）----

var (
	openDateSepRe = regexp.MustCompile(`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$`)
	openDateRawRe = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})$`)
)

// OpenNormDate 把各种写法统一成 YYYY-MM-DD；空串原样返回。
//
// 必需而非严谨癖：出库日期在库里就是 YYYY-MM-DD 字符串、区间走字符串比较，
// 传 2026-10-1（缺前导零）会让 10-01~10-09 被整段过滤掉。
// 支持 2026-10-1 / 2026-10-1 / 2026.10.1 / 20261001。
func OpenNormDate(raw, field string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", nil
	}
	m := openDateSepRe.FindStringSubmatch(s)
	if m == nil {
		m = openDateRawRe.FindStringSubmatch(s)
	}
	if m == nil {
		return "", &BizError{Code: 422, Msg: fmt.Sprintf("%s 日期格式应为 YYYY-MM-DD（可省略前导零），收到：%s", field, raw)}
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	if err := openCheckDate(y, mo, d); err != nil {
		return "", &BizError{Code: 422, Msg: fmt.Sprintf("%s 日期无效：%s（%s）", field, raw, err.Error())}
	}
	return fmt.Sprintf("%04d-%02d-%02d", y, mo, d), nil
}

func openCheckDate(y, mo, d int) error {
	if mo < 1 || mo > 12 {
		return fmt.Errorf("month must be in 1..12")
	}
	if d < 1 || d > openDaysInMonth(y, mo) {
		return fmt.Errorf("day is out of range for month")
	}
	if y < 1 {
		return fmt.Errorf("year %d is out of range", y)
	}
	return nil
}

func openDaysInMonth(y, mo int) int {
	switch mo {
	case 1, 3, 5, 7, 8, 10, 12:
		return 31
	case 4, 6, 9, 11:
		return 30
	case 2:
	 leap := (y%4 == 0 && y%100 != 0) || y%400 == 0
		if leap {
			return 29
		}
		return 28
	}
	return 0
}

// ---- 订单商品（复用报表「商品销售明细」口径）----

// openSaleBucket 报表里「商品 + 规格 + 是否代发」的一个桶。
type openSaleBucket struct {
	pid       int
	spec      string
	dropship  bool
	name      string
	code      string
	unit      string
	srcs      map[string]bool
	qty       float64
	amount    float64
	gross     float64
	goods     float64
	labor     float64
	material  float64
	other     float64
	express   float64
	order     int
}

type openSaleRow struct {
	oid, pid, n int
	spec        string
	dr          bool
	qb, amt     float64
	gross       float64
	goods       float64
	pname       string
	pcode       string
	ig          string
	jst         int
}

// openFieldOfCatSQL 关联结算行（line_type='pack'）的成本字段归类，
// CASE 分支与 Python report.PACK_FIELD_OF_CATNAME + 「名称以打包结尾」兜底逐条一致。
const openFieldOfCatSQL = "CASE " +
	"WHEN trim(coalesce(pk.category,''))='人工' THEN 'labor_cogs' " +
	"WHEN trim(coalesce(pk.category,''))='包材' THEN 'material_cogs' " +
	"WHEN trim(coalesce(pk.category,''))='耗材' THEN 'material_cogs' " +
	"WHEN trim(coalesce(pk.category,''))='包装' THEN 'material_cogs' " +
	"WHEN trim(coalesce(pk.category,''))='快递' THEN 'express_cogs' " +
	"WHEN trim(coalesce(pk.name,'')) LIKE '%打包' THEN 'labor_cogs' " +
	"ELSE 'other_cogs' END"

type openBucketKey struct {
	pid  int
	spec string
	dr   bool
}

// OpenSaleByProduct 单仓「商品销售明细」行（只带对外成本表用到的字段），
// 顺序与 Python product_rows 最终顺序一致（按金额倒序、稳定排序）。
func OpenSaleByProduct(ctx context.Context, q Querier, dateFrom, dateTo string) ([]map[string]any, error) {
	conds := []string{}
	args := []any{}
	if dateFrom != "" {
		conds = append(conds, "o.date >= ?")
		args = append(args, dateFrom)
	}
	if dateTo != "" {
		conds = append(conds, "o.date <= ?")
		args = append(args, dateTo)
	}
	where := "ol.line_type = 'sale'"
	if len(conds) > 0 {
		where += " AND " + strings.Join(conds, " AND ")
	}
	where += " AND coalesce(o.pay_status, '" + openPaidStatus + "') != 'unpaid'"

	// ① 销售行：按「单 × 商品 × 规格 × 是否代发」聚合
	rows, err := q.QueryContext(ctx,
		"SELECT ol.outbound_id, ol.product_id, trim(coalesce(ol.spec,'')), coalesce(ol.is_dropship,0), "+
			"count(*), coalesce(sum(ol.quantity_base),0), coalesce(sum(ol.amount),0), "+
			"coalesce(sum(coalesce(ol.gross_sales, ol.amount)),0), coalesce(sum(ol.cogs),0), "+
			"max(p.name), max(p.code), coalesce(max(o.import_group),''), "+
			"max(CASE WHEN o.remark LIKE '%聚水潭%' THEN 1 ELSE 0 END) "+
			"FROM outbound_lines ol JOIN outbounds o ON o.id = ol.outbound_id "+
			"LEFT JOIN products p ON p.id = ol.product_id "+
			"WHERE "+where+" GROUP BY ol.outbound_id, ol.product_id, trim(coalesce(ol.spec,'')), coalesce(ol.is_dropship,0)",
		args...)
	if err != nil {
		return nil, err
	}
	saleRows := []openSaleRow{}
	for rows.Next() {
		var r openSaleRow
		var dr int
		if err := rows.Scan(&r.oid, &r.pid, &r.spec, &dr, &r.n, &r.qb, &r.amt, &r.gross, &r.goods,
			&r.pname, &r.pcode, &r.ig, &r.jst); err != nil {
			rows.Close()
			return nil, err
		}
		r.dr = dr != 0
		saleRows = append(saleRows, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 销量口径：quantity_base 是基础单位数量，统一折成「默认单位」
	duOf := map[int]struct {
		unit string
		f    float64
	}{}
	if len(saleRows) > 0 {
		ids := map[int]bool{}
		for _, r := range saleRows {
			if r.pid != 0 {
				ids[r.pid] = true
			}
		}
		list := make([]int, 0, len(ids))
		for id := range ids {
			list = append(list, id)
		}
		for _, chunk := range Chunk(list, 500) {
			prows, err := q.QueryContext(ctx,
				"SELECT id, coalesce(default_unit,''), coalesce(base_unit,''), coalesce(conversions,'') FROM products WHERE id "+InClause(len(chunk)),
				ToArgs(chunk)...)
			if err != nil {
				return nil, err
			}
			for prows.Next() {
				var id int
				var defU, baseU, conv string
				if err := prows.Scan(&id, &defU, &baseU, &conv); err != nil {
					prows.Close()
					return nil, err
				}
				du := strings.TrimSpace(defU)
				if du == "" {
					du = strings.TrimSpace(baseU)
				}
				f := 1.0
				if v, ok := decodeFloatMap(conv)[du]; ok && v != 0 {
					f = v
				}
				if f == 0 {
					f = 1.0
				}
				duOf[id] = struct {
					unit string
					f    float64
				}{du, f}
			}
			prows.Close()
			if err := prows.Err(); err != nil {
				return nil, err
			}
		}
	}

	buckets := map[openBucketKey]*openSaleBucket{}
	order := []*openSaleBucket{}
	bucket := func(pid int, spec string, dr bool, name string) *openSaleBucket {
		k := openBucketKey{pid, spec, dr}
		if b, ok := buckets[k]; ok {
			return b
		}
		b := &openSaleBucket{pid: pid, spec: spec, dropship: dr, name: name, srcs: map[string]bool{}, order: len(order)}
		buckets[k] = b
		order = append(order, b)
		return b
	}

	for _, r := range saleRows {
		b := bucket(r.pid, r.spec, r.dr, r.pname)
		if r.pname != "" { // 名称/编码以销售行自身的商品为准
			b.name = r.pname
		}
		if r.pcode != "" {
			b.code = r.pcode
		}
		got := duOf[r.pid]
		f := got.f
		if f == 0 {
			f = 1.0
		}
		b.qty += r.qb / f
		if got.unit != "" && b.unit == "" {
			b.unit = got.unit
		}
		src := "手动出库"
		if r.ig != "" {
			src = "导入出库"
			if r.jst != 0 {
				src = "聚水潭出库"
			}
		}
		b.srcs[src] = true
		b.amount += r.amt
		b.gross += r.gross
		b.goods += r.goods
	}

	// ② 有关联对象的结算行：归到「本单该销售商品所在的桶」
	owned, err := q.QueryContext(ctx,
		"SELECT owner.product_id, trim(coalesce(owner.spec,'')), coalesce(owner.is_dropship,0), "+openFieldOfCatSQL+", "+
			"coalesce(sum(ol.cogs),0) "+
			"FROM outbound_lines ol JOIN outbounds o ON o.id = ol.outbound_id "+
			"JOIN (SELECT outbound_id AS oid, product_id AS pid, min(id) AS sid FROM outbound_lines WHERE line_type='sale' GROUP BY outbound_id, product_id) fs "+
			"ON fs.oid = ol.outbound_id AND fs.pid = ol.sale_product_id "+
			"JOIN outbound_lines owner ON owner.id = fs.sid "+
			"LEFT JOIN products pk ON pk.id = ol.product_id "+
			"WHERE ol.line_type = 'pack' AND "+strings.ReplaceAll(where, "ol.line_type = 'sale'", "ol.line_type = 'pack'")+
			" GROUP BY 1,2,3,4", args...)
	if err != nil {
		return nil, err
	}
	type openOwned struct {
		pid    int
		spec   string
		dr     bool
		field  string
		amount float64
	}
	ownedRows := []openOwned{}
	for owned.Next() {
		var r openOwned
		var dr int
		if err := owned.Scan(&r.pid, &r.spec, &dr, &r.field, &r.amount); err != nil {
			owned.Close()
			return nil, err
		}
		r.dr = dr != 0
		ownedRows = append(ownedRows, r)
	}
	owned.Close()
	if err := owned.Err(); err != nil {
		return nil, err
	}
	for _, r := range ownedRows {
		b := bucket(r.pid, r.spec, r.dr, "")
		openAddField(b, r.field, r.amount)
	}

	// ③ 无归属的结算成本：按「单 × 类别」聚合，稍后按单内销售金额占比分摊
	packWhere := "ol.line_type = 'pack' AND " + strings.ReplaceAll(where, "ol.line_type = 'sale'", "ol.line_type = 'pack'") +
		" AND (ol.sale_product_id IS NULL OR NOT EXISTS (SELECT 1 FROM outbound_lines sl WHERE sl.outbound_id = ol.outbound_id"+
		" AND sl.line_type = 'sale' AND sl.product_id = ol.sale_product_id))"
	unowned, err := q.QueryContext(ctx,
		"SELECT ol.outbound_id, "+openFieldOfCatSQL+", coalesce(sum(ol.cogs),0) "+
			"FROM outbound_lines ol JOIN outbounds o ON o.id = ol.outbound_id "+
			"LEFT JOIN products pk ON pk.id = ol.product_id WHERE "+packWhere+" GROUP BY ol.outbound_id, 2", args...)
	if err != nil {
		return nil, err
	}
	type openSpread struct {
		oid    int
		field  string
		amount float64
	}
	unownedRows := []openSpread{}
	for unowned.Next() {
		var r openSpread
		if err := unowned.Scan(&r.oid, &r.field, &r.amount); err != nil {
			unowned.Close()
			return nil, err
		}
		unownedRows = append(unownedRows, r)
	}
	unowned.Close()
	if err := unowned.Err(); err != nil {
		return nil, err
	}

	perOrder := map[int][]openSaleRow{}
	for _, r := range saleRows {
		perOrder[r.oid] = append(perOrder[r.oid], r)
	}
	spread := func(oid int, field string, amt float64) {
		rs := perOrder[oid]
		if len(rs) == 0 || amt == 0 {
			return
		}
		totAmt := 0.0
		totN := 0
		for _, x := range rs {
			totAmt += x.amt
			totN += x.n
		}
		for _, x := range rs {
			share := 0.0
			if totAmt != 0 {
				share = x.amt / totAmt
			} else if totN != 0 {
				share = float64(x.n) / float64(totN)
			}
			openAddField(bucket(x.pid, x.spec, x.dr, ""), field, amt*share)
		}
	}
	for _, r := range unownedRows {
		spread(r.oid, r.field, r.amount)
	}

	// 输出：按金额倒序（稳定），再做「空规格并到同名规格」的归一
	sorted := append([]*openSaleBucket(nil), order...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].amount > sorted[j].amount })

	type openPRow struct {
		pid             int
		spec            string
		dr              bool
		name, code, unit string
		srcs            string
		qty, amount     float64
		gross           float64
		goods, labor    float64
		material, other float64
		express         float64
	}
	toRow := func(b *openSaleBucket) openPRow {
		srcs := []string{}
		for s := range b.srcs {
			srcs = append(srcs, s)
		}
		sort.Strings(srcs)
		return openPRow{pid: b.pid, spec: b.spec, dr: b.dropship, name: b.name, code: b.code, unit: b.unit,
			srcs: strings.Join(srcs, " ＋ "),
			qty:  openRound(b.qty, 4), amount: openRound(b.amount, 2), gross: openRound(b.gross, 2),
			goods: openRound(b.goods, 2), labor: openRound(b.labor, 2), material: openRound(b.material, 2),
			other: openRound(b.other, 2), express: openRound(b.express, 2)}
	}
	productRows := make([]openPRow, 0, len(sorted))
	for _, b := range sorted {
		productRows = append(productRows, toRow(b))
	}

	// ---- 规格归一：空规格并入「同名规格」，消掉看起来重复的行 ----
	type groupKey struct {
		pid int
		dr  bool
	}
	groups := map[groupKey][]int{}
	groupOrder := []groupKey{}
	for i, r := range productRows {
		k := groupKey{r.pid, r.dr}
		if _, ok := groups[k]; !ok {
			groupOrder = append(groupOrder, k)
		}
		groups[k] = append(groups[k], i)
	}
	merged := []openPRow{}
	for _, k := range groupOrder {
		g := groups[k]
		named, blank := []openPRow{}, []openPRow{}
		namedIdx := -1
		for _, i := range g {
			r := productRows[i]
			if strings.TrimSpace(r.spec) != "" {
				named = append(named, r)
				if namedIdx < 0 {
					namedIdx = len(named) - 1
				}
			} else {
				blank = append(blank, r)
			}
		}
		switch {
		case len(blank) > 0 && len(named) == 1:
			t := named[0]
			for _, r := range blank {
				t.qty += r.qty
				t.amount += r.amount
				t.gross += r.gross
				t.goods = openRound(t.goods+r.goods, 2)
				t.labor = openRound(t.labor+r.labor, 2)
				t.material = openRound(t.material+r.material, 2)
				t.other = openRound(t.other+r.other, 2)
				t.express = openRound(t.express+r.express, 2)
			}
			named[0] = t
			merged = append(merged, named...)
		case len(blank) > 0:
			for i := range blank {
				blank[i].spec = "未标注规格"
			}
			merged = append(merged, named...)
			merged = append(merged, blank...)
		default:
			merged = append(merged, named...)
		}
	}
	sort.SliceStable(merged, func(i, j int) bool { return merged[i].amount > merged[j].amount })

	out := make([]map[string]any, 0, len(merged))
	for _, r := range merged {
		out = append(out, map[string]any{
			"product_id": r.pid, "spec": r.spec, "is_dropship": r.dr, "name": r.name, "code": r.code,
			"qty": r.qty, "unit": r.unit, "source": r.srcs, "amount": r.amount, "gross_sales": r.gross,
			"goods_cogs": r.goods, "labor_cogs": r.labor, "material_cogs": r.material,
			"other_cogs": r.other, "express_cogs": r.express,
		})
	}
	return out, nil
}

func openAddField(b *openSaleBucket, field string, amt float64) {
	switch field {
	case "labor_cogs":
		b.labor += amt
	case "material_cogs":
		b.material += amt
	case "express_cogs":
		b.express += amt
	default:
		b.other += amt
	}
}

// OpenSkuRowsSale 按商品编码（京东 skuId）汇总出库明细 → 单件结算收入/运费/包材/人工/扣点。
func OpenSkuRowsSale(ctx context.Context, q Querier, dateFrom, dateTo string) (map[string]map[string]any, error) {
	data, err := OpenSaleByProduct(ctx, q, dateFrom, dateTo)
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]any{}
	for _, r := range data {
		code := strings.TrimSpace(ToStr(r["code"]))
		if code == "" {
			continue // 没填编码的订单商品对不上京东 SKU
		}
		qty := ToFloat(r["qty"])
		if qty == 0 {
			continue
		}
		amount := ToFloat(r["amount"])
		gross := ToFloat(r["gross_sales"])
		if gross == 0 {
			gross = amount
		}
		d, ok := out[code]
		if !ok {
			d = map[string]any{"_qty": 0.0, "_amount": 0.0, "_gross": 0.0, "_labor": 0.0,
				"_material": 0.0, "_express": 0.0, "_cogs": 0.0, "_name": ""}
			out[code] = d
		}
		d["_qty"] = ToFloat(d["_qty"]) + qty
		d["_amount"] = ToFloat(d["_amount"]) + amount
		d["_gross"] = ToFloat(d["_gross"]) + gross
		d["_labor"] = ToFloat(d["_labor"]) + ToFloat(r["labor_cogs"])
		d["_material"] = ToFloat(d["_material"]) + ToFloat(r["material_cogs"]) + ToFloat(r["other_cogs"])
		d["_express"] = ToFloat(d["_express"]) + ToFloat(r["express_cogs"])
		d["_cogs"] = ToFloat(d["_cogs"]) + ToFloat(r["goods_cogs"])
		if ToStr(d["_name"]) == "" {
			d["_name"] = ToStr(r["name"])
		}
	}

	// 该商品在区间内**实际有出库**的日期范围（_summary_of 不返回日期，这里另查一次）
	conds := []string{"ol.line_type = 'sale'",
		"coalesce(o.pay_status, '" + openPaidStatus + "') != 'unpaid'", "p.code != ''"}
	args := []any{}
	if dateFrom != "" {
		conds = append(conds, "o.date >= ?")
		args = append(args, dateFrom)
	}
	if dateTo != "" {
		conds = append(conds, "o.date <= ?")
		args = append(args, dateTo)
	}
	rows, err := q.QueryContext(ctx,
		"SELECT p.code, min(o.date), max(o.date) FROM outbound_lines ol "+
			"JOIN outbounds o ON o.id = ol.outbound_id JOIN products p ON p.id = ol.product_id "+
			"WHERE "+strings.Join(conds, " AND ")+" GROUP BY p.code", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			code           string
			d0, d1         sql.NullString
		)
		if err := rows.Scan(&code, &d0, &d1); err != nil {
			return nil, err
		}
		if d, ok := out[strings.TrimSpace(code)]; ok {
			d["_firstDate"] = d0.String
			d["_lastDate"] = d1.String
		}
	}
	return out, rows.Err()
}

// ---- 入仓品 ----

// OpenSkuRowsWarehouse 按入仓品 sku 汇总每袋结算收入/运费/包材/毛利率。
// 两条来源：① 入仓记录（真实结算，优先）；② 只有入仓品资料、还没录入仓记录的用资料价兜底（标 _specOnly）。
func OpenSkuRowsWarehouse(ctx context.Context, q Querier) (map[string]map[string]any, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT wp.sku, coalesce(sum(wi.quantity),0), coalesce(sum(wi.amount),0), "+
			"coalesce(sum(wi.unit_price * wi.quantity),0), coalesce(sum(wi.freight_total),0), "+
			"coalesce(sum(wi.pack_cost),0), coalesce(sum(wi.cogs),0), coalesce(sum(wi.profit),0), "+
			"max(wi.deduction_percent), max(wp.name), max(wi.date) "+
			"FROM warehouse_ins wi LEFT JOIN warehouse_products wp ON wp.id = wi.product_id "+
			"WHERE coalesce(wi.pay_status, '"+openPaidStatus+"') != 'unpaid' GROUP BY wp.sku")
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]any{}
	type whRow struct {
		sku                              string
		qty, amount, gross, freight      float64
		pack, cogs, profit, ded          float64
		name, last                       string
	}
	list := []whRow{}
	for rows.Next() {
		var r whRow
		var ded sql.NullFloat64
		var name, last sql.NullString
		if err := rows.Scan(&r.sku, &r.qty, &r.amount, &r.gross, &r.freight, &r.pack, &r.cogs, &r.profit,
			&ded, &name, &last); err != nil {
			rows.Close()
			return nil, err
		}
		r.ded = ded.Float64
		r.name, r.last = name.String, last.String
		list = append(list, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, r := range list {
		code := strings.TrimSpace(r.sku)
		if code == "" || r.qty == 0 {
			continue // 没维护 sku 的入仓品无法与京东 SKU 对应
		}
		out[code] = map[string]any{
			"_qty": r.qty, "_amount": r.amount, "_gross": r.gross, "_freight": r.freight,
			"_pack": r.pack, "_cogs": r.cogs, "_profit": r.profit,
			"_deduction": openRound(r.ded/100.0, 6), "_name": r.name, "_source": "warehouse",
			"_lastDate": r.last,
		}
	}

	// ② 只有资料、还没有入仓记录的：用资料价兜底（否则「建了资料但没录记录」的仓查不到任何东西）
	ded, err := OpenWarehouseDeduction(ctx, q)
	if err != nil {
		return nil, err
	}
	ded = ded / 100
	specRows, err := q.QueryContext(ctx,
		"SELECT id, coalesce(sku,''), coalesce(name,''), coalesce(purchase_price,0), coalesce(freight,0), coalesce(pack_items,'') "+
			"FROM warehouse_products WHERE coalesce(is_active,1) != 0")
	if err != nil {
		return nil, err
	}
	type specRow struct {
		id             int
		sku, name      string
		price, freight float64
		packItems      string
	}
	specs := []specRow{}
	for specRows.Next() {
		var r specRow
		if err := specRows.Scan(&r.id, &r.sku, &r.name, &r.price, &r.freight, &r.packItems); err != nil {
			specRows.Close()
			return nil, err
		}
		specs = append(specs, r)
	}
	specRows.Close()
	if err := specRows.Err(); err != nil {
		return nil, err
	}
	for _, wp := range specs {
		code := strings.TrimSpace(wp.sku)
		if code == "" {
			continue
		}
		if _, ok := out[code]; ok {
			continue
		}
		if wp.price == 0 {
			continue // 连采购价都没维护，给不出成本
		}
		packCost, err := OpenSettlePackItems(ctx, q, decodePackItems(wp.packItems), 1.0, map[int]*FIFOState{})
		if err != nil {
			return nil, err
		}
		out[code] = map[string]any{
			"_qty": 1.0, // 虚拟基准：单件价 = 总额 ÷ 1
			"_amount": openRound(wp.price*(1-ded), 6), "_gross": wp.price,
			"_freight": wp.freight, "_pack": packCost, "_cogs": 0.0, "_profit": 0.0,
			"_deduction": openRound(ded, 6), "_name": wp.name, "_source": "warehouse",
			"_specOnly": true, "_lastDate": "",
		}
	}
	return out, nil
}

// OpenWarehouseDeduction 入仓品采购价（收入）扣点百分比；未配置返回 0（不折算）。
func OpenWarehouseDeduction(ctx context.Context, q Querier) (float64, error) {
	var pct float64
	err := q.QueryRowContext(ctx, "SELECT percent FROM deductions WHERE category = '入仓品'").Scan(&pct)
	if errorsIsNoRows(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return pct, nil
}

func errorsIsNoRows(err error) bool { return err == sql.ErrNoRows }

// OpenSettlePackItems 按「每袋用量 × 袋数」结算随货包材，返回包材成本合计（不落库）。
// 成本按 FIFO 结转，同一结算过程共享 cache，避免重复读同一商品批次。
func OpenSettlePackItems(ctx context.Context, q Querier, items []PackItem, quantity float64, cache map[int]*FIFOState) (float64, error) {
	total := 0.0
	for _, it := range items {
		m, err := GetProduct(ctx, q, it.ProductID)
		if err != nil || m == nil {
			continue
		}
		per := it.Quantity
		qty := openRound(per*quantity, 6)
		if qty <= 0 {
			continue
		}
		unit := strings.TrimSpace(it.Unit)
		if unit == "" {
			unit = m.DefaultUnit
		}
		if unit == "" {
			unit = m.BaseUnit
		}
		if unit == "" {
			unit = "个"
		}
		if _, ok := m.Conversions[unit]; !ok {
			continue
		}
		qtyBase, err := UnitToBase(m, unit, qty)
		if err != nil {
			continue
		}
		st, ok := cache[m.ID]
		if !ok {
			st, _, err = FIFOStateFor(ctx, q, m.ID)
			if err != nil {
				return 0, err
			}
			cache[m.ID] = st
		}
		cost := openRound(Take(&st.Layers, st.Base, qtyBase, m.UnitCost), 2)
		total += cost
	}
	return openRound(total, 2), nil
}

// ---- 跨仓合并 ----

// OpenMergeInto 把一个仓的汇总累加进总表；同一 skuId 两边都有时以出库口径为准。
func OpenMergeInto(dst map[string]map[string]any, src map[string]map[string]any) {
	for code, d := range src {
		cur, ok := dst[code]
		if !ok {
			cp := make(map[string]any, len(d))
			for k, v := range d {
				cp[k] = v
			}
			dst[code] = cp
			continue
		}
		if ToStr(cur["_source"]) == "warehouse" {
			// 两个仓都有这个入仓品时，优先保留**有实际入仓记录**的那份：资料价不该盖掉真实结算价
			if cur["_specOnly"] == true && d["_specOnly"] != true {
				cp := make(map[string]any, len(d))
				for k, v := range d {
					cp[k] = v
				}
				dst[code] = cp
			}
			continue
		}
		for k, v := range d { // 已有出库口径 → 金额累加，日期取并集
			switch k {
			case "_name", "_deduction", "_source":
				continue
			case "_firstDate":
				a, b := ToStr(cur[k]), ToStr(v)
				if a != "" || b != "" {
					if a == "" {
						cur[k] = b
					} else if b == "" {
						cur[k] = a
					} else if b < a {
						cur[k] = b
					} else {
						cur[k] = a
					}
				} else {
					cur[k] = ""
				}
			case "_lastDate":
				a, b := ToStr(cur[k]), ToStr(v)
				if b > a {
					cur[k] = b
				} else {
					cur[k] = a
				}
			default:
				cur[k] = ToFloat(cur[k]) + ToFloat(v)
			}
		}
	}
}

// ---- 输出 ----

// openRound 与 Python 内置 round(v, places) 逐位一致：对二进制真值做「四舍六入五成双」。
// 共享库 erp.Round 是先乘 10^places 再判断 .5，乘法本身会引入第二次舍入
// （实测 erp.Round(18.991250000000001,4)=18.9912，而 Python round 得 18.9913；
// erp.Round(2.6749999999999998,2)=2.68，Python round 得 2.67），
// 这里用 strconv 的定点格式化（内部按精确十进制展开舍入到最近偶数）+ 回读避免该误差。
func openRound(v float64, places int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	s := strconv.FormatFloat(v, 'f', places, 64)
	out, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return v
	}
	return out
}

func openRound4(v float64) float64 { return openRound(v, 4) }

// OpenSaleItem 订单商品 → 对方成本表的一行。
// cost 是算单件单价用的那份汇总（区间内有出库就是区间那份，否则全量历史兜底）；
// rq/ra 是**区间内**销量与结算额（区间内没卖就是 0），tq/ta 是全量历史。
func OpenSaleItem(cost map[string]map[string]any, code, period string, rq, ra, tq, ta float64) map[string]any {
	d := cost[code]
	qty := ToFloat(d["_qty"])
	amount := ToFloat(d["_amount"])
	gross := ToFloat(d["_gross"])
	if gross == 0 {
		gross = amount
	}
	var platformRate any
	if gross != 0 {
		platformRate = openRound((gross-amount)/gross, 6)
	}
	return map[string]any{
		"supply": openRound4(amount / qty), "supplyGross": openRound4(gross / qty), "price": nil,
		"shipping": openRound4(ToFloat(d["_express"]) / qty),
		"package":  openRound4(ToFloat(d["_material"]) / qty),
		"labor":    openRound4(ToFloat(d["_labor"]) / qty),
		"platformRate": platformRate,
		"returnRate":   nil,
		"_name":        ToStr(d["_name"]), "_source": "sale",
		"_period": period, "_qty": openRound(rq, 2), "_turnover": openRound(ra, 2),
		"_totalQty": openRound(tq, 2), "_totalTurnover": openRound(ta, 2),
		"_goodsCost": openRound4(ToFloat(d["_cogs"]) / qty),
		"_firstDate": ToStr(d["_firstDate"]), "_lastDate": ToStr(d["_lastDate"]),
	}
}

// OpenWarehouseItem 入仓品 → 对方成本表的一行。
func OpenWarehouseItem(d map[string]any) map[string]any {
	qty := ToFloat(d["_qty"])
	specOnly := d["_specOnly"] == true
	var marginRate any
	if !specOnly {
		if ToFloat(d["_amount"]) != 0 {
			marginRate = openRound(ToFloat(d["_profit"])/ToFloat(d["_amount"])*100, 2)
		}
	}
	var goodsCost any
	if !specOnly {
		goodsCost = openRound4(ToFloat(d["_cogs"]) / qty)
	}
	return map[string]any{
		"supply": openRound4(ToFloat(d["_amount"]) / qty), "supplyGross": openRound4(ToFloat(d["_gross"]) / qty),
		"price": nil,
		"shipping": openRound4(ToFloat(d["_freight"]) / qty), "package": openRound4(ToFloat(d["_pack"]) / qty),
		"labor": 0.0, // 入仓品没有出库时的打包人工
		"platformRate": openRound(ToFloat(d["_deduction"]), 6), "returnRate": nil,
		"_name": ToStr(d["_name"]), "_source": "warehouse",
		"_period": map[bool]string{true: "spec", false: "all"}[specOnly],
		// 资料价没有实际入仓量，销量如实记 0（虚拟基准不对外暴露）
		"_qty": openQty(specOnly, qty), "_turnover": openSpecNum(specOnly, openRound(ToFloat(d["_amount"]), 2)),
		"_totalQty": openQty(specOnly, qty), "_totalTurnover": openSpecNum(specOnly, openRound(ToFloat(d["_amount"]), 2)),
		"_goodsCost": goodsCost, "_marginRate": marginRate, "_lastDate": ToStr(d["_lastDate"]),
	}
}

func openQty(specOnly bool, qty float64) float64 {
	if specOnly {
		return 0.0
	}
	return openRound(qty, 2)
}

func openSpecNum(specOnly bool, v float64) float64 {
	if specOnly {
		return 0.0
	}
	return v
}

// OpenIsZero 判断 float 是否为 0（含 -0），用于 Python `if not qty` 的等价判断。
func OpenIsZero(v float64) bool { return math.Abs(v) < 1e-12 }

// ---- 鲜货需求预演算（POST /api/fresh/plan 的算料部分）----

// OpenPlanLine 一条草稿出库明细（聚水潭订单解析产物）。
type OpenPlanLine struct {
	ProductID int
	Unit      string
	Quantity  float64
}

// OpenPlanDraft 一张草稿出库单。
type OpenPlanDraft struct {
	Lines []OpenPlanLine
}

// OpenFreshPlan 订单商品 → 关联蔬菜的消耗折算（不落库、不扣库存）。
//
// 规则（对齐 Python routers/fresh.py::fresh_plan）：
//   - 订单商品（product_type=order）→ 折算到它关联的库存蔬菜：base × multiplier × 默认单位系数；
//   - 直接销售的库存蔬菜 → 按原数量折算；
//   - 只统计 FRESH_CATS（蔬菜/干货）分类；换算没配置的行直接跳过（Python 是 except ValueError: continue）。
//
// drafts 由聚水潭导入模块（parse_jushuitan_draft，statuses=None）产出；
// failedCount / skipTotal / unmapped 分别是它的「失败条数」「按状态跳过计数之和」「未关联编码集合」。
func OpenFreshPlan(ctx context.Context, q Querier, drafts []OpenPlanDraft, failedCount int, skipTotal int, unmapped []string) (map[string]any, error) {
	consume := map[int]float64{}
	consumeOrder := []int{}
	for _, o := range drafts {
		for _, ln := range o.Lines {
			p, err := GetProduct(ctx, q, ln.ProductID)
			if err != nil || p == nil {
				continue
			}
			base, err := UnitToBase(p, ln.Unit, ln.Quantity)
			if err != nil {
				continue
			}
			target := p
			if p.ProductType == "order" {
				var sp *Product
				if p.StockProductID != nil {
					sp, err = GetProduct(ctx, q, *p.StockProductID)
					if err != nil {
						sp = nil
					}
				}
				if sp == nil || !ContainsStr(FreshCats, sp.Category) {
					continue
				}
				// multiplier 以库存默认单位计（如 0.5 公斤），再乘「默认单位→基础单位」系数，
				// 统一折到库存基础单位累计，与 stock_deduction 扣减口径一致
				du := sp.DisplayUnit()
				base = base * orOne(p.Multiplier) * openFactor(sp, du)
				target = sp
			} else if !ContainsStr(FreshCats, p.Category) {
				continue
			}
			if _, ok := consume[target.ID]; !ok {
				consumeOrder = append(consumeOrder, target.ID)
			}
			consume[target.ID] += base
		}
	}
	items := []map[string]any{}
	for _, pid := range consumeOrder {
		sp, err := GetProduct(ctx, q, pid)
		if err != nil || sp == nil {
			continue
		}
		du := sp.DisplayUnit()
		f := openFactor(sp, du)
		stock := sp.Stock / f
		need := consume[pid] / f
		remain := stock - need
		items = append(items, map[string]any{"id": sp.ID, "name": sp.Name, "unit": du,
			"stock": openRound(stock, 2), "need": openRound(need, 2), "remain": openRound(remain, 2),
			"suggest": openRound(math.Max(0, -remain), 2)})
	}
	sort.SliceStable(items, func(i, j int) bool {
		if ToFloat(items[i]["remain"]) != ToFloat(items[j]["remain"]) {
			return ToFloat(items[i]["remain"]) < ToFloat(items[j]["remain"])
		}
		return ToStr(items[i]["name"]) < ToStr(items[j]["name"])
	})
	if items == nil {
		items = []map[string]any{}
	}
	if unmapped == nil {
		unmapped = []string{}
	}
	return map[string]any{"items": items, "order_count": len(drafts), "failed_count": failedCount,
		"skip": skipTotal, "unmapped": unmapped}, nil
}

// openFactor 「展示单位 → 基础单位」系数：Python `(p.conversions or {}).get(du, 1) or 1`（缺失或 0 都按 1）。
func openFactor(p *Product, du string) float64 {
	f, ok := p.Conversions[du]
	if !ok || f == 0 {
		return 1
	}
	return f
}

// trimJSONBOM 去掉 UTF-8 BOM：Python 用 encoding="utf-8-sig" 读默认成本配置（那个文件带 BOM）。
func trimJSONBOM(raw []byte) []byte {
	return []byte(strings.TrimPrefix(string(raw), "\ufeff"))
}
