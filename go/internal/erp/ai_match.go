package erp

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ---------------- 商品匹配与单位换算（逐条对齐 app/routers/ai.py） ----------------

// aiProductRow 一次商品查询的行（Python 的 Product 实例）。
type aiProductRow = Product

// aiCatCond 各 AI 分类对应的 SQL 过滤条件（与 SQLAlchemy 的 filter 逐条一致）。
func aiCatCond(cat string) string {
	switch cat {
	case "order":
		return "product_type = 'order'"
	case "pack":
		return "category IN ('包材', '耗材', '包装')"
	case "labor":
		return "category = '人工'"
	case "stock":
		return "product_type = 'stock' AND category NOT IN ('人工', '包材', '耗材', '包装')"
	}
	return ""
}

// aiLoadProducts 按分类取在用商品（Python 的 query 不带 ORDER BY，这里按 id 稳定排序，
// 与 SQLite 默认的 rowid 扫描顺序一致）。
func aiLoadProducts(ctx context.Context, q Querier, cond string) ([]*aiProductRow, error) {
	stmt := "SELECT " + productColumns + " FROM products WHERE is_active = 1"
	if cond != "" {
		stmt += " AND " + cond
	}
	stmt += " ORDER BY id"
	rows, err := q.QueryContext(ctx, stmt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*aiProductRow
	for rows.Next() {
		p, err := scanProduct(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// aiProductByName 在用商品里按名称精确取第一条（Python 的 filter(name==).first()）。
func aiProductByName(ctx context.Context, q Querier, name, cond string) (*aiProductRow, error) {
	stmt := "SELECT " + productColumns + " FROM products WHERE is_active = 1"
	if cond != "" {
		stmt += " AND " + cond
	}
	stmt += " AND name = ? ORDER BY id LIMIT 1"
	row := q.QueryRowContext(ctx, stmt, name)
	p, err := scanProduct(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return p, nil
}

// aiWantCond _match_product 的 want 参数（stock/order/其它=不限）。
func aiWantCond(want string) string {
	switch want {
	case "stock":
		return "product_type = 'stock'"
	case "order":
		return "product_type = 'order'"
	}
	return ""
}

// AIMatchProduct 按名称匹配商品：先精确（忽略空白），再子串包含（取匹配更长的）。
func AIMatchProduct(ctx context.Context, q Querier, name, want string) (*aiProductRow, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, nil
	}
	cond := aiWantCond(want)
	qkey := aiTight(name)
	p, err := aiProductByName(ctx, q, name, cond)
	if err != nil {
		return nil, err
	}
	if p != nil {
		return p, nil
	}
	rows, err := aiLoadProducts(ctx, q, cond)
	if err != nil {
		return nil, err
	}
	for _, r := range rows { // 忽略空白的同名（模型常把「8号拖箱」写成「8 号拖箱」）
		if aiTight(r.Name) == qkey {
			return r, nil
		}
	}
	type scored struct {
		score int
		p     *aiProductRow
	}
	var cands []scored
	for _, r := range rows {
		pn := aiTight(r.Name)
		if strings.Contains(pn, qkey) || strings.Contains(qkey, pn) {
			cands = append(cands, scored{aiMinLen(pn, qkey), r})
		}
	}
	if len(cands) > 0 {
		sort.SliceStable(cands, func(i, j int) bool { return cands[i].score > cands[j].score })
		return cands[0].p, nil
	}
	return nil, nil
}

func aiMinLen(a, b string) int {
	la, lb := lenRune(a), lenRune(b)
	if la < lb {
		return la
	}
	return lb
}

// AIResolveInboundProduct 入库必须是库存商品（大类）；若命中订单商品，则用其关联的库存商品。
func AIResolveInboundProduct(ctx context.Context, q Querier, name string) (*aiProductRow, error) {
	p, err := AIMatchProduct(ctx, q, name, "stock")
	if err != nil || p != nil {
		return p, err
	}
	o, err := AIMatchProduct(ctx, q, name, "order")
	if err != nil {
		return nil, err
	}
	if o != nil && o.StockProductID != nil {
		row := q.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products WHERE id = ?", *o.StockProductID)
		sp, err := scanProduct(row.Scan)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return sp, nil
	}
	if o != nil {
		return nil, nil
	}
	return AIMatchProduct(ctx, q, name, "")
}

// AIResolveOutboundProduct 出库优先订单商品（小类，可自动结算），否则用库存商品。
func AIResolveOutboundProduct(ctx context.Context, q Querier, name string) (*aiProductRow, error) {
	p, err := AIMatchProduct(ctx, q, name, "order")
	if err != nil || p != nil {
		return p, err
	}
	return AIMatchProduct(ctx, q, name, "stock")
}

// AIMatchByCategory 在指定 AI 分类内按名称匹配商品（精确→子串，取更长）。
func AIMatchByCategory(ctx context.Context, q Querier, name, cat string) (*aiProductRow, error) {
	name = strings.TrimSpace(name)
	if name == "" || !ContainsStr(AICategories, cat) {
		return nil, nil
	}
	cond := aiCatCond(cat)
	p, err := aiProductByName(ctx, q, name, cond)
	if err != nil || p != nil {
		return p, err
	}
	qkey := aiTight(name)
	rows, err := aiLoadProducts(ctx, q, cond)
	if err != nil {
		return nil, err
	}
	for _, c := range rows { // 忽略空白的同名（如票据「8 号拖箱」↔ 档案「8号拖箱」）
		if aiTight(c.Name) == qkey {
			return c, nil
		}
	}
	var best *aiProductRow
	blen := -1
	for _, c := range rows {
		cn := aiTight(c.Name)
		if strings.Contains(cn, qkey) || strings.Contains(qkey, cn) {
			m := aiMinLen(cn, qkey)
			if m > blen {
				blen, best = m, c
			}
		}
	}
	return best, nil
}

// AIResolveLine 按分类优先匹配商品；未命中再回退业务类型默认解析（入库库存，出库订单优先）。
func AIResolveLine(ctx context.Context, q Querier, name, opType, cat string) (*aiProductRow, error) {
	if ContainsStr(AICategories, cat) {
		p, err := AIMatchByCategory(ctx, q, name, cat)
		if err != nil || p != nil {
			return p, err
		}
		return aiProductByName(ctx, q, name, "")
	}
	if opType == "inbound" {
		return AIResolveInboundProduct(ctx, q, name)
	}
	return AIResolveOutboundProduct(ctx, q, name)
}

// AIUnitIncompatible 票据单位与商品单位体系是否完全对不上（如票据按「瓶」、商品按「公斤」管）。
func AIUnitIncompatible(p *aiProductRow, unit string) bool {
	unit = strings.TrimSpace(unit)
	if unit == "" {
		return false
	}
	conv := p.Conversions
	if conv == nil {
		conv = map[string]float64{}
	}
	du := p.DisplayUnit()
	u := aiNormUnit(unit, conv)
	if u == "" {
		u = unit
	}
	if aiSameUnit(u, du) || aiSameUnit(u, p.BaseUnit) {
		return false
	}
	if v, ok := conv[u]; ok && v != 0 {
		return false
	}
	if u == "斤" && aiHasKey(conv, "公斤") {
		return false
	}
	if aiCanonicalUnit(u) == "公斤" && aiHasKey(conv, "公斤") {
		return false
	}
	return true
}

func aiHasKey(m map[string]float64, k string) bool { _, ok := m[k]; return ok }

// AILastPriceDefault 取该商品最近一次录入的价格（折算到默认展示单位）。
func AILastPriceDefault(ctx context.Context, q Querier, p *aiProductRow, opType string) float64 {
	if p == nil {
		return 0
	}
	conv := p.Conversions
	if conv == nil {
		conv = map[string]float64{}
	}
	du := p.DisplayUnit()
	toDU := func(price float64, unit string) float64 {
		if price == 0 {
			return 0
		}
		cv, ok1 := conv[unit]
		dv, ok2 := conv[du]
		if unit != "" && ok1 && ok2 && cv != 0 {
			return Round(price*dv/cv, 4)
		}
		return Round(price, 4)
	}
	type row struct {
		unitPrice float64
		unit      string
	}
	pick := func(table string) *row {
		var (
			up sql.NullFloat64
			u  sql.NullString
		)
		err := q.QueryRowContext(ctx,
			"SELECT unit_price, unit FROM "+table+" WHERE product_id = ? ORDER BY id DESC LIMIT 1", p.ID).
			Scan(&up, &u)
		if err != nil {
			return nil
		}
		return &row{unitPrice: up.Float64, unit: u.String}
	}
	if opType == "inbound" {
		if r := pick("inbounds"); r != nil && r.unitPrice != 0 {
			return toDU(r.unitPrice, r.unit)
		}
		// 参考采购价没维护时，退回商品资料里的「均价」（库存均价），再没有才是 0
		if v := toDU(p.UnitCost, p.BaseUnit); v != 0 {
			return v
		}
		return toDU(p.AvgCost, p.BaseUnit)
	}
	if r := pick("outbound_lines"); r != nil && r.unitPrice != 0 {
		return toDU(r.unitPrice, r.unit)
	}
	return toDU(p.SalePrice, p.BaseUnit)
}


// AILineCandidates 收集该识别名称下的候选商品（精确同名优先，其次近似名）。
func AILineCandidates(ctx context.Context, q Querier, name, cat string) ([]*aiProductRow, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, nil
	}
	var (
		rows []*aiProductRow
		err  error
	)
	if ContainsStr(AICategories, cat) {
		rows, err = aiLoadProducts(ctx, q, aiCatCond(cat))
	} else {
		rows, err = aiLoadProducts(ctx, q, "")
	}
	if err != nil {
		return nil, err
	}
	qname := aiTight(name)
	qkey := qname
	if cat == "pack" {
		qkey = aiPackKey(name)
	}
	var exact []*aiProductRow
	seen := map[int]bool{}
	for _, p := range rows {
		if aiTight(p.Name) == qname { // 同名（忽略空白）
			exact = append(exact, p)
			seen[p.ID] = true
		} else if cat == "pack" && aiPackKey(p.Name) == qkey && aiTight(p.Name) != qname {
			exact = append(exact, p)
			seen[p.ID] = true
		}
	}
	type scored struct {
		score int
		p     *aiProductRow
	}
	var sub []scored
	for _, p := range rows {
		if seen[p.ID] {
			continue
		}
		pn := aiTight(p.Name)
		var hit bool
		if cat == "pack" {
			pkey := aiPackKey(p.Name)
			hit = pkey == qkey || (strings.HasPrefix(pkey, qkey) && pkey != qkey)
		} else {
			hit = strings.Contains(pn, qname) || strings.Contains(qname, pn)
		}
		if hit {
			sub = append(sub, scored{aiMinLen(pn, qname), p})
		}
	}
	// Python: sub.sort(key=lambda p: -min(len(_tight(p.name)), len(qname)))（稳定排序）
	sort.SliceStable(sub, func(i, j int) bool { return sub[i].score > sub[j].score })
	out := append([]*aiProductRow{}, exact...)
	for _, s := range sub {
		out = append(out, s.p)
	}
	return out, nil
}

// AINarrowByPackType 按识别名里的箱型词（纸箱/拖箱）筛候选；识别名没写箱型词时返回空。
func AINarrowByPackType(name string, cands []*aiProductRow) []*aiProductRow {
	qt := aiPackBoxType(name)
	if qt == "" {
		return nil
	}
	var out []*aiProductRow
	for _, c := range cands {
		if aiPackBoxType(c.Name) == qt {
			out = append(out, c)
		}
	}
	return out
}

// AINormalizeLine 把 数量/单价 换算到商品的默认展示单位，并保留原始值供前端参考。
func AINormalizeLine(ctx context.Context, q Querier, p *aiProductRow, line *JObj, opType string,
	autoCreated bool, category string) (*JObj, error) {
	name := strings.TrimSpace(anyToStrOrEmpty(line.Get("product")))
	qty := ToFloat(line.Get("quantity"))
	unit := aiCanonicalUnit(strings.TrimSpace(anyToStrOrEmpty(line.Get("unit"))))
	price := ToFloat(line.Get("unit_price"))

	out := NewJ().
		Set("product_id", 0).
		Set("product_name", name).
		Set("recognized_name", name).
		Set("recognized_unit", unit).
		Set("category", category).
		Set("quantity", qty).
		Set("unit", unit).
		Set("unit_price", price).
		Set("matched", false).
		Set("auto_created", autoCreated).
		Set("price_defaulted", false).
		Set("ambiguous", false).
		Set("candidates", []any{}).
		Set("unit_conflict", false).
		Set("unit_conflict_msg", "").
		Set("hint", "未匹配到系统商品，请手动选择"+aiIf(autoCreated, "（已自动新增为新商品）", ""))
	if p == nil {
		return out, nil
	}

	conv := p.Conversions
	if conv == nil {
		conv = map[string]float64{}
	}
	du := p.DisplayUnit()
	u := aiNormUnit(unit, conv)
	out.Set("product_id", p.ID).
		Set("product_name", p.Name).
		Set("matched", true)
	cat2 := aiProductCategory(p)
	if cat2 == "" {
		cat2 = category
	}
	out.Set("category", cat2)
	label := AICategoryLabels[cat2]
	if label == "" {
		label = p.ProductType
	}
	hint := fmt.Sprintf("已匹配「%s」（%s）", p.Name, label) + aiIf(autoCreated, "，🆕 自动新增", "")
	out.Set("hint", hint)

	// 换算到默认展示单位：数量与单价都折算到 1 个默认单位
	if u != "" && aiHasKey(conv, u) && aiHasKey(conv, du) && conv[u] != 0 {
		qtyDefault := qty * conv[u] / conv[du]
		out.Set("quantity", Round(qtyDefault, 4))
		out.Set("unit", du)
		if price != 0 {
			out.Set("unit_price", Round(price*conv[du]/conv[u], 4))
		}
	} else {
		// 换算表没有该单位：尝试 斤<->公斤 兜底
		switch {
		case u == "斤" && aiHasKey(conv, "公斤"):
			out.Set("quantity", Round(qty*0.5, 4))
			out.Set("unit", "公斤")
			if price != 0 {
				out.Set("unit_price", Round(price*2, 4))
			}
		case (u == "公斤" || u == "千克") && aiHasKey(conv, "公斤"):
			out.Set("quantity", Round(qty, 4))
			out.Set("unit", "公斤")
		default:
			nu := du
			if nu == "" {
				nu = unit
			}
			out.Set("unit", nu)
			out.Set("hint", out.Str("hint")+"；未能换算单位，请核对")
		}
	}

	// 商品档案若把默认单位写成「千克」，展示与提交统一改用「公斤」（同义单位不再重复引入）
	tgt := aiCanonicalUnit(out.Str("unit"))
	if tgt != out.Str("unit") && (len(conv) == 0 || aiHasKey(conv, tgt)) {
		out.Set("unit", tgt)
	}

	// 单位冲突检测：识别原始单位 与 商品库存/展示单位 不一致时，提示用户确认换算
	rawUnit := aiNormUnit(unit, conv)
	if rawUnit == "" {
		rawUnit = unit
	}
	storedUnit := du
	if storedUnit == "" {
		storedUnit = p.BaseUnit
	}
	if out.Str("unit") != "" && rawUnit != "" && storedUnit != "" &&
		!aiSameUnit(rawUnit, storedUnit) && !aiSameUnit(rawUnit, out.Str("unit")) && !autoCreated {
		msg := fmt.Sprintf("识别单位为「%s」，商品「%s」当前按「%s」记录，已换算为「%s」，请核对数量与单位",
			rawUnit, p.Name, storedUnit, out.Str("unit"))
		out.Set("unit_conflict", true)
		out.Set("unit_conflict_msg", msg)
		out.Set("hint", out.Str("hint")+fmt.Sprintf("；⚠ %s", msg))
	}

	// 用户未录入单价（仍为 0）：按该商品上次录入的价格默认填入（已是默认单位，不再换算）
	if ToFloat(out.Get("unit_price")) == 0 && opType != "stocktake" {
		last := AILastPriceDefault(ctx, q, p, opType)
		if last != 0 {
			out.Set("unit_price", Round(last, 4))
			out.Set("price_defaulted", true)
			out.Set("hint", out.Str("hint")+"；价格未识别，已按该商品最近价 / 均价默认填入，请核对")
		}
	}
	return out, nil
}

func aiIf(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

// AIMergeDuplicateLines 同种商品的多行合并成一行（数量累加），不再分开。
func AIMergeDuplicateLines(lines []*JObj, opType string) []*JObj {
	if len(lines) == 0 {
		return lines
	}
	kept := map[string]*JObj{}
	out := []*JObj{}
	for _, ln := range lines {
		pid := ToInt(ln.Get("product_id"))
		if pid == 0 {
			out = append(out, ln)
			continue
		}
		var key string
		if opType == "stocktake" {
			su := anyToStrOrEmpty(ln.Get("stock_unit"))
			if su == "" {
				su = anyToStrOrEmpty(ln.Get("unit"))
			}
			key = aiTupleKey("stocktake", pid, su)
		} else {
			paid := true
			if ln.Has("paid") {
				paid = ToBool(ln.Get("paid"))
			}
			d := anyToStrOrEmpty(ln.Get("date"))
			key = fmt.Sprintf("%s|%d|%s|%.17g|%s|%v", opType, pid,
				anyToStrOrEmpty(ln.Get("unit")), Round(ToFloat(ln.Get("unit_price")), 6), d, paid)
		}
		first, ok := kept[key]
		if !ok {
			kept[key] = ln
			out = append(out, ln)
			continue
		}
		first.Set("quantity", Round(ToFloat(first.Get("quantity"))+ToFloat(ln.Get("quantity")), 4))
		if first.Get("stock_counted") != nil && ln.Get("stock_counted") != nil {
			first.Set("stock_counted", Round(ToFloat(first.Get("stock_counted"))+ToFloat(ln.Get("stock_counted")), 4))
		}
		// Python: first["merged_count"] = int(first.get("merged_count") or 1) + 1
		mc := ToInt(first.Get("merged_count"))
		if mc == 0 {
			mc = 1
		}
		first.Set("merged_count", mc+1)
	}

	// 合并过的行：按累加后的数量重算（批量提交读的就是这里的 stock_adjust / quantity）
	for _, ln := range out {
		n := ToInt(ln.Get("merged_count"))
		if n == 0 {
			n = 1
		}
		if n <= 1 {
			continue
		}
		before := ToFloat(ln.Get("stock_before"))
		du := anyToStrOrEmpty(ln.Get("stock_unit"))
		if du == "" {
			du = anyToStrOrEmpty(ln.Get("unit"))
		}
		if opType == "stocktake" {
			counted := ln.Get("stock_counted")
			if counted != nil {
				adj := Round(ToFloat(counted)-before, 4)
				ln.Set("stock_adjust", adj)
				ln.Set("stock_after", Round(before+adj, 4))
				ln.Set("hint", fmt.Sprintf("已把 %d 行合并为一行（实盘数累加）：当前库存 %s%s，实盘 %s%s，调整 %s%s → 盘点后 %s%s",
					n, PyG(before), du, PyG(ToFloat(counted)), du, PyGPlus(adj), du, PyG(before+adj), du))
			} else {
				adj := Round(ToFloat(ln.Get("quantity")), 4)
				ln.Set("stock_adjust", adj)
				ln.Set("stock_after", Round(before+adj, 4))
				ln.Set("hint", fmt.Sprintf("已把 %d 行合并为一行（增减量累加）：调整 %s%s → 盘点后 %s%s",
					n, PyGPlus(adj), du, PyG(before+adj), du))
			}
		} else {
			ln.Set("hint", anyToStrOrEmpty(ln.Get("hint"))+fmt.Sprintf("；已把 %d 行合并为一行（数量累加）", n))
		}
	}
	return out
}

func aiTupleKey(parts ...any) string {
	segs := make([]string, 0, len(parts))
	for _, p := range parts {
		segs = append(segs, fmt.Sprintf("%v", p))
	}
	return strings.Join(segs, "|")
}

// PyG 复刻 Python 的 format(v, "g")（C 风格 %g：6 位有效数字）。
func PyG(v float64) string { return pyFormatG(v, false) }

// PyGPlus 复刻 Python 的 format(v, "+g")。
func PyGPlus(v float64) string { return pyFormatG(v, true) }

func pyFormatG(v float64, plus bool) string {
	s := strconv.FormatFloat(v, 'g', 6, 64)
	if plus && !strings.HasPrefix(s, "-") && !strings.Contains(s, "nan") {
		s = "+" + s
	}
	return s
}
