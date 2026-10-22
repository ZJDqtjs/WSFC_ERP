package erp

// ---------------- 导入模块公共件：表头别名、单元格取值、聚水潭商品名解析
//
// 本文件对齐 backend/app/routers/imports.py 顶部与「聚水潭解析」小节的纯函数部分：
// 别名表、_norm/_norm_cell/cell/to_float/norm_date 已在 imports_xlsx.go 落地（Imp* 前缀），
// 这里补上 detect_header 之后的业务口径（换算解析、扣点折算、外部商品名拆解、候选推荐）。

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// ImpWeightUnits WEIGHT_UNITS：单位 → 克。
var ImpWeightUnits = map[string]float64{"克": 1.0, "g": 1.0, "斤": 500.0, "公斤": 1000.0, "千克": 1000.0, "kg": 1000.0}

// 四套表头别名（键顺序无关，detect_header 只按列扫）。
var (
	ImpProductAliases = map[string][]string{
		"code":        {"商品编码", "*商品编码", "编码"},
		"name":        {"商品名称", "*商品名称", "名称", "商品名"},
		"category":    {"商品类别", "商品分类", "分类", "类别", "类目"},
		"spec":        {"规格型号", "规格", "型号"},
		"unit":        {"单位", "*单位", "基本单位"},
		"base_unit":   {"基础单位"},
		"conversions": {"单位换算"},
		"sale_price":  {"默认售价", "销售价", "售价"},
		"pack_fee":    {"打包费", "包装费"},
		"pack_items":  {"关联商品清单", "关联商品"},
	}
	ImpInboundAliases = map[string][]string{
		"product":    {"商品编码或名称", "商品编码", "商品名称", "商品", "名称"},
		"unit":       {"进货单位", "单位", "*单位"},
		"quantity":   {"数量", "*数量"},
		"unit_price": {"单价", "进货单价", "*单价"},
		"freight":    {"运费", "入库运费", "货运费"},
		"handling":   {"装卸费", "装卸", "搬运费"},
		"supplier":   {"供应商"},
		"date":       {"日期", "入库日期"},
		"operator":   {"操作员"},
		"remark":     {"备注"},
	}
	ImpOutboundAliases = map[string][]string{
		"doc_no":     {"单号", "订单号"},
		"date":       {"日期", "出库日期"},
		"customer":   {"客户"},
		"product":    {"商品编码或名称", "商品编码", "商品名称", "商品"},
		"unit":       {"销售单位", "单位", "出库单位"},
		"quantity":   {"数量"},
		"unit_price": {"单价", "售价", "出库单价"},
		"pack_fee":   {"打包费"},
		"operator":   {"操作员"},
		"remark":     {"备注"},
	}
	ImpJushuitanCols = map[string][]string{
		"doc_no":    {"出库单号", "出仓单号"},
		"date":      {"出库日期"},
		"status":    {"状态"},
		"name":      {"商品名称"},
		"amount":    {"卖家实收", "实付金额", "买家实付"},
		"shop":      {"店铺名称"},
		"express":   {"快递公司"},
		"track":     {"快递单号"},
		"seller":    {"业务员", "操作员"},
		"customer":  {"线下客户", "买家账号"},
		"warehouse": {"仓储方"},
	}
)

// impIdx mapping.get(field)：没有这一列返回 -1（Go 侧 cell 越界即默认值）。
func impIdx(mapping map[string]int, field string) int {
	if i, ok := mapping[field]; ok {
		return i
	}
	return -1
}

// impGet cell(row, mapping.get(field))：取列并 strip。
func impGet(row []any, mapping map[string]int, field string) string {
	return ImpCell(row, impIdx(mapping, field), "")
}

// InferBaseUnit infer_base_unit：重量单位 → 克，其余 → 个。
func InferBaseUnit(unit string) string {
	if _, ok := ImpWeightUnits[unit]; ok {
		return "克"
	}
	return "个"
}

var impReConvSplit = regexp.MustCompile(`[;,；，\n]`)

// ParseConversions parse_conversions(text, base_unit, unit)：标准换算打底，
// 再叠加文本里的「单位=系数」，最后把销售单位补进去（计数单位按 1:1）。
func ParseConversions(text, baseUnit, unit string) map[string]float64 {
	conv := DefaultConversions(baseUnit)
	if strings.TrimSpace(text) != "" {
		for _, part := range impReConvSplit.Split(text, -1) {
			part = strings.TrimSpace(part)
			if !strings.Contains(part, "=") {
				continue
			}
			kv := strings.SplitN(part, "=", 2)
			u := strings.TrimSpace(kv[0])
			f := ImpToFloat(strings.TrimSpace(kv[1]), 0)
			if u != "" && f > 0 {
				conv[u] = f
			}
		}
	}
	if unit != "" {
		if _, ok := conv[unit]; !ok {
			if w, isWeight := ImpWeightUnits[unit]; isWeight {
				conv[unit] = w
			} else {
				conv[unit] = 1.0 // 计数单位暂定 1:1，需人工核对
			}
		}
	}
	return conv
}

var impReQtyUnit = regexp.MustCompile(`^([\d.]+)\s*(.*)$`)

// ParsePackItems parse_pack_items：'泡沫箱=1个;泡沫垫=2个' → 关联清单，找不到的商品自动跳过。
func ParsePackItems(ctx context.Context, q Querier, text string) []PackItem {
	items := []PackItem{}
	if strings.TrimSpace(text) == "" {
		return items
	}
	for _, part := range impReConvSplit.Split(text, -1) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, qtyUnit := part, ""
		if i := strings.Index(part, "="); i >= 0 {
			name = strings.TrimSpace(part[:i])
			qtyUnit = strings.TrimSpace(part[i+1:])
		}
		qty := 1.0
		unit := "个"
		if m := impReQtyUnit.FindStringSubmatch(qtyUnit); m != nil {
			qty = ImpToFloat(m[1], 0)
			if strings.TrimSpace(m[2]) != "" {
				unit = strings.TrimSpace(m[2])
			}
		}
		p := ResolveProduct(ctx, q, name)
		if p != nil {
			items = append(items, PackItem{ProductID: p.ID, Quantity: qty, Unit: unit})
		}
	}
	return items
}

// ResolveProduct resolve_product：先按编码再按名称。
func ResolveProduct(ctx context.Context, q Querier, key string) *Product {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil
	}
	if p := productByColumn(ctx, q, "code", key); p != nil {
		return p
	}
	return productByColumn(ctx, q, "name", key)
}

func productByColumn(ctx context.Context, q Querier, column, value string) *Product {
	row := q.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products WHERE "+column+" = ? ORDER BY id LIMIT 1", value)
	p, err := scanProduct(row.Scan)
	if err != nil {
		return nil
	}
	return p
}

func productByColumnAnd(ctx context.Context, q Querier, column, value, column2, value2 string) *Product {
	row := q.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products WHERE "+column+" = ? AND "+column2+" = ? ORDER BY id LIMIT 1", value, value2)
	p, err := scanProduct(row.Scan)
	if err != nil {
		return nil
	}
	return p
}

// productByNameAndType：select(Product).where(name==, product_type==)。
func productByNameAndType(ctx context.Context, q Querier, name, ptype string) *Product {
	return productByColumnAnd(ctx, q, "name", name, "product_type", ptype)
}

// impApplyDeduction apply_deduction_price：按商品类别命中扣点规则折算入库单价。
func impApplyDeduction(price float64, p *Product, deductionMap map[string]float64) float64 {
	percent := 0.0
	if p != nil && p.Category != "" {
		percent = deductionMap[p.Category]
	}
	return ApplyDeductionPrice(price, percent)
}

// ---------------- 聚水潭外部商品名解析 ----------------

// ImpJstItem 聚水潭商品串里的一段：(商品名, 件数)。
type ImpJstItem struct {
	Name string
	Qty  float64
}

var (
	impReJstSerialPrefix = regexp.MustCompile(`^\d+\.?\d*\s*\.\s*`)
	impReJstQtySuffix    = regexp.MustCompile(`^(.*?)\*(\d+(?:\.\d+)?)\s*$`)
	impReJstSplitter     = regexp.MustCompile(`[;,]`)
)

// ParseJstName parse_jushuitan_name：兼容中英文分隔符与序号前缀。
func ParseJstName(name string) []ImpJstItem {
	out := []ImpJstItem{}
	s := strings.TrimSpace(name)
	if s == "" {
		return out
	}
	r := strings.NewReplacer("，", ",", "；", ";", "、", ",", "\n", ";", "\r", ";")
	s = r.Replace(s)
	s = impReJstSerialPrefix.ReplaceAllString(s, "")
	for _, part := range impReJstSplitter.Split(s, -1) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		part = impReJstSerialPrefix.ReplaceAllString(part, "")
		product, qty := part, 1.0
		if m := impReJstQtySuffix.FindStringSubmatch(part); m != nil {
			product = strings.TrimSpace(m[1])
			qty = impPyFloat(m[2])
		}
		product = strings.Trim(product, "()[]{} ")
		if product == "" {
			continue
		}
		out = append(out, ImpJstItem{Name: product, Qty: qty})
	}
	return out
}

var (
	// 聚水潭商品名开头的序号（如「1.牛奶芋头4.5斤50g＋」的「1.」）
	impReJstSerial = regexp.MustCompile(`^\s*\d+\s*[.、,，)）]\s*`)
	// 整件净重优先：商品名里可能同时有单颗克重与整件斤重，取斤/公斤/千克
	impReJstSpecMajor = regexp.MustCompile(`([\d.]+)\s*(公斤|千克|斤)`)
	// 单颗克重兜底（如 250g），仅当整名没有斤/公斤时才使用
	impReJstSpecMinor = regexp.MustCompile(`([\d.]+)\s*(克|g|kg)`)
	// 计数规格：2个 / 1袋 …
	impReJstCountSpec = regexp.MustCompile(`([\d.]+)\s*(个|袋|包|盒|箱|件|份|瓶|支)`)
)

var impJstUnitAlias = map[string]string{"g": "克", "kg": "千克"}

// 计数单位优先顺序（含订单商品的「单」：1 件订单商品 = 1 单）
var impCountPref = []string{"个", "单", "袋", "包", "盒", "箱", "件", "份"}

// impPyFloat Python float(s)：允许 "1." / ".5" 这类写法（Go ParseFloat 也允许，留此口子统一异常口径）。
func impPyFloat(s string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return f
}

// ParseJstSpec parse_jst_spec：外部名里的每件规格 → (单位, 数量)。
func ParseJstSpec(name string) (string, float64, bool) {
	m := impReJstSpecMajor.FindStringSubmatch(name)
	if m == nil {
		m = impReJstSpecMinor.FindStringSubmatch(name)
	}
	if m == nil {
		return "", 0, false
	}
	u := impJstUnitAlias[m[2]]
	if u == "" {
		u = m[2]
	}
	return u, impPyFloat(m[1]), true
}

// JstSpecLabel jst_spec_label：去掉开头序号的外部名就是这一行的规格标签。
func JstSpecLabel(extName, unit string, perItem float64) string {
	name := impReJstSerial.ReplaceAllString(strings.TrimSpace(extName), "")
	if name != "" {
		return name
	}
	if perItem != 0 {
		return "每件" + FmtQty(perItem) + unit
	}
	return ""
}

// PickJstUnit pick_jst_unit：这一行用哪个单位、每件折算多少。取不到时 ok=false（交由调用方报错）。
func PickJstUnit(p *Product, extName string) (string, float64, bool) {
	conv := p.Conversions
	u, qty, has := ParseJstSpec(extName)
	if has && u != "" {
		if _, ok := conv[u]; ok {
			return u, qty, true
		}
		if p.BaseUnit == u {
			return u, qty, true
		}
	}
	for _, cu := range impCountPref {
		if _, ok := conv[cu]; ok {
			return cu, 1.0, true
		}
	}
	for _, cu := range impCountPref {
		if p.BaseUnit == cu {
			return p.BaseUnit, 1.0, true
		}
	}
	return "", 0, false
}

// AutoSuggest auto_suggest：名称/编码归一化后精确命中返回 1.0，否则取 difflib 最高分（>=0.35 才算）。
func AutoSuggest(name string, products []*Product) (*Product, float64) {
	n := ImpNorm(name)
	var best *Product
	bestScore := 0.0
	for _, p := range products {
		for _, cand := range []string{p.Name, p.Code} {
			c := ImpNorm(cand)
			if c == "" {
				continue
			}
			if c == n {
				return p, 1.0
			}
			score := ImportsDifflibRatio(n, c)
			if score > bestScore {
				bestScore, best = score, p
			}
		}
	}
	if best != nil && bestScore >= 0.35 {
		return best, Round(bestScore, 3)
	}
	return nil, 0.0
}

// 「自动新增」排除的库存分类：人工/包材/快递不作为关联大类
var impNoAutoStockCats = []string{"人工", "包材", "快递"}

// Go 的 RE2 不允许转义全角加号，故 [+\＋] 写成字面量（Python 原文是 [+\＋]?）。
var impReSpecTail = regexp.MustCompile(`[\d.]+(?:\s*[－\-–]\s*[\d.]+)?\s*(?:斤|公斤|千克|克|g|kg|个|袋|包|盒|箱|件|份|瓶|支)[+＋]?$`)

// StripSpecTail _strip_spec：反复剥离尾部规格得到基础名。
func StripSpecTail(name string) string {
	s := strings.TrimSpace(name)
	for {
		n := strings.TrimSpace(impReSpecTail.ReplaceAllString(s, ""))
		if n == s {
			return s
		}
		s = n
	}
}

// stockCandidates 库存大类候选（排除 人工/包材/快递）。
func stockCandidates(ctx context.Context, q Querier) []*Product {
	rows, err := q.QueryContext(ctx, "SELECT "+productColumns+" FROM products WHERE product_type = 'stock' ORDER BY id")
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []*Product{}
	for rows.Next() {
		p, err := scanProduct(rows.Scan)
		if err != nil {
			continue
		}
		if !ContainsStr(impNoAutoStockCats, p.Category) {
			out = append(out, p)
		}
	}
	return out
}

// allProductCandidates 全部商品候选（含订单小类，排除 人工/包材/快递）。
func allProductCandidates(ctx context.Context, q Querier) []*Product {
	list, err := ListProductsByID(ctx, q)
	if err != nil {
		return nil
	}
	out := make([]*Product, 0, len(list))
	for _, p := range list {
		if !ContainsStr(impNoAutoStockCats, p.Category) {
			out = append(out, p)
		}
	}
	return out
}

// MatchStock _match_stock：先按剥离规格后的基础名精确匹配，再按整名高阈值(0.7)模糊匹配。
func MatchStock(ctx context.Context, q Querier, extName string) *Product {
	base := StripSpecTail(extName)
	stocks := stockCandidates(ctx, q)
	for _, s := range stocks {
		if s.Name == base || s.Code == base {
			return s
		}
	}
	if base == extName {
		return nil
	}
	p, score := AutoSuggest(base, stocks)
	if p != nil && score >= 0.7 {
		return p
	}
	return nil
}

// SuggestCandidates _suggest_candidates：未关联外部名的候选商品（带分数），供导入页手动匹配。
func SuggestCandidates(ctx context.Context, q Querier, extName string, top int) []map[string]any {
	if top <= 0 {
		top = 8
	}
	base := StripSpecTail(extName)
	cands := allProductCandidates(ctx, q)
	type scored struct {
		score float64
		pid   int
		name  string
	}
	var list []scored
	seen := map[int]bool{}
	push := func(pid int, score float64) {
		if seen[pid] {
			return
		}
		seen[pid] = true
		list = append(list, scored{score: score, pid: pid})
	}
	n, b := ImpNorm(extName), ImpNorm(base)
	// 1) 基础名精确匹配优先（安全，绝不误配）
	for _, s := range cands {
		if s.Name == base || s.Code == base {
			push(s.ID, 1.0)
		}
	}
	// 2) 整名/基础名模糊匹配
	for _, s := range cands {
		sc := 0.0
		for _, cand := range []string{s.Name, s.Code} {
			c := ImpNorm(cand)
			if c == "" {
				continue
			}
			if c == n || c == b {
				sc = math.Max(sc, 1.0)
				continue
			}
			sc = math.Max(sc, ImportsDifflibRatio(n, c))
			if b != n {
				sc = math.Max(sc, ImportsDifflibRatio(b, c))
			}
		}
		if sc >= 0.35 {
			push(s.ID, sc)
		}
	}
	// 分数降序、同分按 id 升序（Python: sort(key=lambda x: (-x[0], x[1]))）
	for i := 1; i < len(list); i++ {
		for j := i; j > 0; j-- {
			a, prev := list[j], list[j-1]
			if a.score > prev.score || (a.score == prev.score && a.pid < prev.pid) {
				list[j], list[j-1] = prev, a
				continue
			}
			break
		}
	}
	out := []map[string]any{}
	// Python 先按 scored[:top] 切片再过滤，所以取不到商品的条目会让结果少于 top 条
	if len(list) > top {
		list = list[:top]
	}
	for _, it := range list {
		p, err := GetProduct(ctx, q, it.pid)
		if err != nil || p == nil {
			continue
		}
		out = append(out, map[string]any{"id": p.ID, "name": p.Name, "score": Round(it.score, 3)})
	}
	return out
}

// SpecMultiplier _spec_multiplier：外部名规格 → 1 单扣多少「库存默认单位」。
func SpecMultiplier(stock *Product, extName string) float64 {
	du := stock.DefaultUnit
	if du == "" {
		du = stock.BaseUnit
	}
	conv := stock.Conversions
	factorDU := 1.0
	if v, ok := conv[du]; ok && v != 0 {
		factorDU = v
	}
	if u, qty, has := ParseJstSpec(extName); has && u != "" {
		if f, ok := conv[u]; ok {
			return Round(qty*f/factorDU, 6)
		}
	}
	if m := impReJstCountSpec.FindStringSubmatch(extName); m != nil {
		cu := m[2]
		num := impPyFloat(m[1])
		if du == cu {
			return Round(num, 6)
		}
		if f, ok := conv[cu]; ok && f != 0 {
			return Round(num*f/factorDU, 6)
		}
	}
	return 1.0
}

// ---------------- 店铺扣点（backend/json/deduction_config.json） ----------------

// ImpShopRule _load_shop_deductions 的一条规则：固定扣点或按分类扣点（分类保持文件里的顺序）。
type ImpShopRule struct {
	Percent    *float64
	Categories map[string]float64
	CatOrder   []string
}

// LoadShopDeductions _load_shop_deductions：文件缺失/损坏返回空表（不折算）。
func LoadShopDeductions() map[string]*ImpShopRule {
	rules := map[string]*ImpShopRule{}
	if DeductionConfigPath == "" {
		return rules
	}
	raw, err := os.ReadFile(DeductionConfigPath)
	if err != nil {
		return rules
	}
	var doc struct {
		Rules []map[string]any `json:"rules"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return rules
	}
	for _, r := range doc.Rules {
		shop := strings.TrimSpace(ToStr(r["shop"]))
		if shop == "" {
			continue
		}
		if v, ok := r["percent"]; ok && v != nil {
			p := ToFloat(v)
			rules[shop] = &ImpShopRule{Percent: &p}
			continue
		}
		if cm, ok := r["categories"].(map[string]any); ok && len(cm) > 0 {
			cats := map[string]float64{}
			order := []string{}
			for _, k := range jsonMapKeys(raw, shop, "categories") {
				v, present := cm[k]
				if !present || v == nil {
					continue
				}
				key := strings.TrimSpace(k)
				cats[key] = ToFloat(v)
				order = append(order, key)
			}
			if len(cats) > 0 {
				rules[shop] = &ImpShopRule{Categories: cats, CatOrder: order}
			}
		}
	}
	return rules
}

// ShopLinePercent _shop_line_percent：固定扣点对所有行生效；分类扣点按扣减库存分类取。
func ShopLinePercent(rule *ImpShopRule, stockCat string) float64 {
	if rule == nil {
		return 0
	}
	if rule.Percent != nil {
		if *rule.Percent == 0 {
			return 0
		}
		return *rule.Percent
	}
	if rule.Categories != nil {
		return rule.Categories[stockCat]
	}
	return 0
}

// ShopDeductionNote _shop_deduction_note：备注里的扣点说明片段。
func ShopDeductionNote(rule *ImpShopRule) string {
	if rule == nil {
		return ""
	}
	if rule.Percent != nil {
		return "（店铺扣点 " + formatGFloat(*rule.Percent) + "%）"
	}
	if len(rule.Categories) > 0 {
		parts := make([]string, 0, len(rule.CatOrder))
		for _, k := range rule.CatOrder {
			parts = append(parts, k+formatGFloat(rule.Categories[k])+"%")
		}
		return "（店铺分类扣点 " + strings.Join(parts, "、") + "）"
	}
	return ""
}

// formatGFloat Python f"{v:g}"：整数不带小数点，否则用最短定点表示。
func formatGFloat(v float64) string {
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return PyFloatRepr(v)
	}
	// :g 用 6 位有效数字，且小数尾部的 0 会被去掉
	s := strconv.FormatFloat(v, 'g', 6, 64)
	if strings.ContainsAny(s, "eE") {
		return s
	}
	if strings.Contains(s, ".") {
		s = strings.TrimRight(s, "0")
		s = strings.TrimRight(s, ".")
	}
	return s
}

// LineDeductStockCategory _line_deduct_stock_category：这一行实际扣减的库存商品分类。
func LineDeductStockCategory(ctx context.Context, q Querier, p *Product, stockProductID int) string {
	var sp *Product
	if stockProductID != 0 {
		if got, err := GetProduct(ctx, q, stockProductID); err == nil {
			sp = got
		}
	}
	if (sp == nil || sp.ProductType != "stock") && p != nil && p.ProductType == "order" && p.StockProductID != nil {
		if got, err := GetProduct(ctx, q, *p.StockProductID); err == nil {
			sp = got
		}
	}
	if sp != nil && sp.ProductType == "stock" {
		return sp.Category
	}
	if p != nil {
		return p.Category
	}
	return ""
}

// jsonMapKeys 取 raw JSON 里 rules[shop==shop].categories 的键顺序（Python dict 保序，
// Go map 不保序，而扣点备注要把分类按文件顺序拼出来）。
func jsonMapKeys(raw []byte, shop, field string) []string {
	var doc struct {
		Rules []json.RawMessage `json:"rules"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	for _, one := range doc.Rules {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(one, &obj); err != nil {
			continue
		}
		var shopVal string
		if b, ok := obj["shop"]; ok {
			_ = json.Unmarshal(b, &shopVal)
		}
		if strings.TrimSpace(shopVal) != shop {
			continue
		}
		b, ok := obj[field]
		if !ok {
			return nil
		}
		// 按原始字节顺序解出键名
		dec := json.NewDecoder(strings.NewReader(string(b)))
		tk, err := dec.Token()
		if err != nil || tk != json.Delim('{') {
			return nil
		}
		var keys []string
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil
			}
			k, ok := kt.(string)
			if !ok {
				return nil
			}
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return nil
			}
			keys = append(keys, k)
		}
		return keys
	}
	return nil
}

// ---------------- 执行记录（古法导入留痕） ----------------

var impReJstStatusSpace = regexp.MustCompile(`[\s　]+`)

// NormalizeJstStatus _normalize_jushuitan_status：去全部空白（含全角空格）。
func NormalizeJstStatus(v any) string {
	if !truthyPy(v) {
		return ""
	}
	return strings.TrimSpace(impReJstStatusSpace.ReplaceAllString(ImpCellText(v), ""))
}
