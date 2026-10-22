package erp

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/xuri/excelize/v2"
)

// 本文件是《入仓配送明细》贴单导入的读侧与名称匹配口径，对齐 Python routers/warehouse_in.py：
// 工作表按分仓自动选、表头别名扫描、合并单元格的采购单号向下回填、商品名解析每袋净重、
// 入仓品名称匹配（精确 → 核心名精确 → difflib 模糊）。

// ---------------- 表头别名 ----------------

type whAliasField struct {
	Field string
	Names []string
}

// WhAliases 贴单表头别名（顺序即 Python WH_ALIASES 的字典顺序）。
var WhAliases = []whAliasField{
	{"purchase_no", []string{"采购单号", "采购订单号", "采购编号", "单号"}},
	{"product", []string{"商品名称", "商品", "名称", "商品编码或名称"}},
	{"box_count", []string{"箱数", "件数"}},
	{"center", []string{"配送中心", "收货仓", "仓库", "仓"}},
	{"quantity", []string{"数量"}},
	{"box_spec", []string{"箱规", "每箱", "规格"}},
}

// ---------------- 文本归一化 ----------------

// whSpaceRe 与 Python 的 \s+（str 模式）等价：ASCII 空白 + Unicode 空白/分隔符。
func whStripSpace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.Is(unicode.Zs, r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// whNorm 去空白 + 转小写（同 Python _norm）。
func whNorm(s string) string { return strings.ToLower(whStripSpace(s)) }

// whCoreStrip 核心名要剥掉的数量/单位/包装词（顺序同 Python _CORE_STRIP）。
var whCoreStrip = []string{
	"净重", "礼盒装", "礼盒", "公斤", "千克", "kg", "斤", "克", "g",
	"袋", "包", "盒", "箱", "个", "件", "份", "装",
}

var whDigitsDots = regexp.MustCompile(`[\d.]+`)

// whCore 核心名归一化：去数量与单位/包装词，便于「拇指小玉米净重2斤」≈「白拇指玉米」。
func whCore(name string) string {
	s := whDigitsDots.ReplaceAllString(whNorm(name), "")
	for _, w := range whCoreStrip {
		s = strings.ReplaceAll(s, w, "")
	}
	return s
}

// whNormCell 单元格归一化（表头比对用）：去首尾空白并去掉 * 号（同 Python _norm_cell）。
func whNormCell(c string) string {
	return strings.TrimSpace(strings.ReplaceAll(strings.TrimSpace(c), "*", ""))
}

// whCell 取单元格文本（列缺失/空 → ""，同 Python _cell）。
func whCell(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[idx])
}

// whIdx 表头里某字段的列号（未识别到 → -1，对应 Python 的 mapping.get(field) → None）。
func whIdx(mapping map[string]int, field string) int {
	if i, ok := mapping[field]; ok {
		return i
	}
	return -1
}

var whNonNumeric = regexp.MustCompile(`[^\d\-+.]+`)

// whToFloat 宽松取数（同 Python _to_float：去千分位与货币符号，失败再剥非数字字符）。
func whToFloat(v string) float64 {
	s := strings.TrimSpace(v)
	s = strings.ReplaceAll(s, ",", "")
	s = strings.ReplaceAll(s, "￥", "")
	s = strings.ReplaceAll(s, "¥", "")
	if s == "" {
		return 0
	}
	if f, err := parseFloatPy(s); err == nil {
		return f
	}
	if f, err := parseFloatPy(whNonNumeric.ReplaceAllString(s, "")); err == nil {
		return f
	}
	return 0
}

var pyFloatWords = map[string]float64{"inf": math.Inf(1), "-inf": math.Inf(-1), "+inf": math.Inf(1), "+infinity": math.Inf(1), "-infinity": math.Inf(-1), "infinity": math.Inf(1)}

// parseFloatPy 兼容 Python float() 可接受但 Go ParseFloat 拒绝的写法（inf / infinity）。
func parseFloatPy(s string) (float64, error) {
	if v, ok := pyFloatWords[strings.ToLower(strings.TrimSpace(s))]; ok {
		return v, nil
	}
	return strconv.ParseFloat(s, 64)
}

// whPickKeys 只保留声明过的键（Pydantic 会丢弃模型未声明的字段）。
func whPickKeys(src map[string]any, keys []string) map[string]any {
	out := make(map[string]any, len(keys))
	for _, k := range keys {
		if v, ok := src[k]; ok {
			out[k] = v
		}
	}
	return out
}

// ---------------- 每袋净重解析 ----------------

var whWeightKgRe = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*(?:公斤|千克|kg)`)
var whWeightJinRe = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*斤`)
var whWeightGRe = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*(?:克|g)`)

// WhParseWeightGrams 从商品名解析每袋净重（克）：净重2斤→1000；1.2kg→1200；228g→228。
func WhParseWeightGrams(name string) float64 {
	s := strings.ToLower(name)
	if m := whWeightKgRe.FindStringSubmatch(s); m != nil {
		return Round(ToFloat(m[1])*1000, 4)
	}
	if m := whWeightJinRe.FindStringSubmatch(s); m != nil {
		return Round(ToFloat(m[1])*500, 4)
	}
	if m := whWeightGRe.FindStringSubmatch(s); m != nil {
		return Round(ToFloat(m[1]), 4)
	}
	return 0
}

func whBaseGrams(unit string) float64 {
	return WhBaseUnitGrams[strings.ToLower(strings.TrimSpace(unit))]
}

// WhBagWeightFromName 每袋净重（默认单位）：商品名内嵌规格只在「关联库存商品按重量计」时可用，
// 否则（瓶/单/袋…）用入仓品维护值——否则「冻干花生228g」会被算成 228 瓶、成本虚高百倍。
func WhBagWeightFromName(name string, sp *Product, factor, fallback float64) float64 {
	grams := WhParseWeightGrams(name)
	bg := 0.0
	if sp != nil {
		bg = whBaseGrams(sp.BaseUnit)
	}
	if grams != 0 && bg != 0 {
		return Round(grams/bg/factor, 6)
	}
	return Round(fallback, 6)
}

// ---------------- 工作表与表头 ----------------

// PickWhSheet 决定本次读哪张工作表：显式指定 → 只用它（不存在报错并列出可选）；
// 未指定 → 按分仓取（wh02=冷冻贴单，其余=常温贴单），该表不在时退而用名字含「贴单」的第一张；
// 连贴单表都没有则报错让用户手动选（绝不回落到第一张表，避免把商品明细表当贴单导入）。
func PickWhSheet(names []string, wanted, whKey string) (string, error) {
	wanted = strings.TrimSpace(wanted)
	if wanted != "" {
		for _, n := range names {
			if n == wanted {
				return wanted, nil
			}
		}
		return "", ErrText("工作表「%s」不存在，可选：%s", wanted, strings.Join(names, "、"))
	}
	if len(names) == 0 {
		return "", nil
	}
	preferred := WhDefaultSheet
	if p, ok := WhWarehouseSheet[strings.TrimSpace(whKey)]; ok {
		preferred = p
	}
	for _, n := range names {
		if n == preferred {
			return preferred, nil
		}
	}
	for _, n := range names {
		if strings.Contains(n, WhSheetKeyword) {
			return n, nil
		}
	}
	return "", ErrText("未找到「%s」工作表，也没有其他名字含「%s」的工作表；请在工作表下拉里手动选择要导入的那张。可选：%s",
		preferred, WhSheetKeyword, strings.Join(names, "、"))
}

// detectWhHeader 扫描前 20 行找表头行（命中 ≥2 个别名即认定），返回 {字段: 列索引} 与数据起始行。
func detectWhHeader(rows [][]string) (map[string]int, int) {
	flat := map[string]bool{}
	for _, al := range WhAliases {
		for _, n := range al.Names {
			flat[n] = true
		}
	}
	limit := len(rows)
	if limit > 20 {
		limit = 20
	}
	for idx := 0; idx < limit; idx++ {
		cellSet := map[string]bool{}
		for _, c := range rows[idx] {
			if n := whNormCell(c); n != "" {
				cellSet[n] = true
			}
		}
		hits := 0
		for k := range cellSet {
			if flat[k] {
				hits++
			}
		}
		if hits >= 2 {
			mapping := map[string]int{}
			for i, c := range rows[idx] {
				n := whNormCell(c)
				if n == "" {
					continue
				}
				for _, al := range WhAliases {
					for _, nm := range al.Names {
						if n == nm {
							mapping[al.Field] = i
						}
					}
				}
			}
			return mapping, idx + 1
		}
	}
	return map[string]int{}, 0
}

// ---------------- difflib.SequenceMatcher.ratio 等价实现 ----------------

// whLongestMatch 与 CPython difflib find_longest_match 同序同规则（无 isjunk、b 长度 <200 时无 autojunk）。
func whLongestMatch(a, b []rune, b2j map[rune][]int, alo, ahi, blo, bhi int) (int, int, int) {
	besti, bestj, bestsize := alo, blo, 0
	j2len := map[int]int{}
	for i := alo; i < ahi; i++ {
		newj2len := map[int]int{}
		for _, j := range b2j[a[i]] {
			if j < blo {
				continue
			}
			if j >= bhi {
				break
			}
			k := j2len[j-1] + 1
			newj2len[j] = k
			if k > bestsize {
				besti, bestj, bestsize = i-k+1, j-k+1, k
			}
		}
		j2len = newj2len
	}
	return besti, bestj, bestsize
}

// seqRatio difflib.SequenceMatcher(None, a, b).ratio()：2×匹配字符数 ÷ 两侧长度和。
func seqRatio(as, bs string) float64 {
	a, b := []rune(as), []rune(bs)
	total := len(a) + len(b)
	if total == 0 {
		return 1
	}
	b2j := map[rune][]int{}
	for j, r := range b {
		b2j[r] = append(b2j[r], j)
	}
	type window struct{ alo, ahi, blo, bhi int }
	queue := []window{{0, len(a), 0, len(b)}}
	matches := 0
	for len(queue) > 0 {
		w := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		i, j, k := whLongestMatch(a, b, b2j, w.alo, w.ahi, w.blo, w.bhi)
		if k == 0 {
			continue
		}
		matches += k
		if w.alo < i && w.blo < j {
			queue = append(queue, window{w.alo, i, w.blo, j})
		}
		if i+k < w.ahi && j+k < w.bhi {
			queue = append(queue, window{i + k, w.ahi, j + k, w.bhi})
		}
	}
	return 2.0 * float64(matches) / float64(total)
}

// MatchWhProduct 按名称匹配入仓品：先精确名，再核心名精确/模糊（阈值 0.6 / 归一化名 0.5）。
// 返回 (入仓品, 匹配分)，与 Python _match_product 完全一致（包括「两轮都不达标时返回 nil + 末轮分」）。
func MatchWhProduct(products []*WarehouseProduct, name string) (*WarehouseProduct, float64) {
	key := strings.TrimSpace(name)
	if key == "" {
		return nil, 0
	}
	for _, p := range products {
		if p.Name == key {
			return p, 1.0
		}
	}
	core := whCore(key)
	for _, p := range products {
		if whCore(p.Name) == core && core != "" {
			return p, 0.99
		}
	}
	var best *WarehouseProduct
	bestScore := 0.0
	for _, p := range products {
		if s := seqRatio(core, whCore(p.Name)); s > bestScore {
			best, bestScore = p, s
		}
	}
	if best != nil && bestScore >= 0.6 {
		return best, Round(bestScore, 3)
	}
	score := 0.0
	for _, p := range products {
		if s := seqRatio(whNorm(key), whNorm(p.Name)); s > score {
			best, score = p, s
		}
	}
	if best != nil && score >= 0.5 {
		return best, Round(score, 3)
	}
	return nil, Round(score, 3)
}

// ---------------- 导入预览 ----------------

// WhImportPreview POST /api/warehouse-in/import/preview 的业务部分。
func WhImportPreview(ctx context.Context, q Querier, data []byte, sheet, date, whKey string) (map[string]any, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, ErrText("无法读取文件，请上传 .xlsx 格式")
	}
	defer f.Close()
	sheets := f.GetSheetList()
	if sheets == nil {
		sheets = []string{}
	}
	sheetName, err := PickWhSheet(sheets, sheet, whKey)
	if err != nil {
		return nil, err
	}
	if sheetName == "" {
		return nil, ErrText("Excel 中没有可读取的工作表")
	}
	// RawCellValue：取单元格存储的原始值，口径等同 openpyxl 的 values_only=True
	rows, err := f.GetRows(sheetName, excelize.Options{RawCellValue: true})
	if err != nil {
		return nil, ErrText("无法读取文件，请上传 .xlsx 格式")
	}
	mapping, start := detectWhHeader(rows)
	_, hasProduct := mapping["product"]
	if len(mapping) == 0 || !hasProduct {
		return nil, ErrText("未识别到表头（需包含「商品名称」等列），请确认工作表内容")
	}

	products, err := ListWarehouseProducts(ctx, q)
	if err != nil {
		return nil, err
	}
	deduction, err := WarehouseDeduction(ctx, q)
	if err != nil {
		return nil, err
	}
	defaultDate := strings.TrimSpace(date)
	if defaultDate == "" {
		defaultDate = Today()
	}

	items := []map[string]any{}
	failed := []map[string]any{}
	lastPurchaseNo := ""
	for i := start; i < len(rows); i++ {
		row := rows[i]
		rawPn := whCell(row, whIdx(mapping, "purchase_no"))
		if rawPn != "" { // 合并单元格：采购单号仅首行有值，向下回填
			lastPurchaseNo = rawPn
		}
		purchaseNo := rawPn
		if purchaseNo == "" {
			purchaseNo = lastPurchaseNo
		}
		name := whCell(row, whIdx(mapping, "product"))
		if name == "" {
			continue
		}
		qty := whToFloat(whCell(row, whIdx(mapping, "quantity")))
		if qty <= 0 {
			failed = append(failed, map[string]any{"row": i + 1, "reason": fmt.Sprintf("「%s」数量无效", name)})
			continue
		}
		boxCount := whToFloat(whCell(row, whIdx(mapping, "box_count")))
		boxSpec := whToFloat(whCell(row, whIdx(mapping, "box_spec")))
		product, score := MatchWhProduct(products, name)
		var stockID *int
		if product != nil {
			stockID = product.StockProductID
		}
		sp, _, factor, unitCost, err := WhStockInfo(ctx, q, stockID)
		if err != nil {
			return nil, err
		}
		fallback := 0.0
		if product != nil {
			fallback = product.BagWeight
		}
		bagWeight := WhBagWeightFromName(name, sp, factor, fallback)
		unitPrice, freight := 0.0, 0.0
		if product != nil {
			unitPrice, freight = product.PurchasePrice, product.Freight
		}
		revenue := Round(qty*unitPrice*(1-deduction/100), 2)
		bagCost := WhBagCost(product, bagWeight, unitCost)
		cogs := Round(qty*bagCost, 2)
		freightTotal := Round(qty*freight, 2)
		outBoxSpec := boxSpec
		if outBoxSpec == 0 && product != nil {
			outBoxSpec = product.BoxSpec
		}
		item := map[string]any{
			"row": i + 1,
			"purchase_no": purchaseNo,
			"product_name": name,
			"center":       whCell(row, whIdx(mapping, "center")),
			"quantity":     qty,
			"box_count":    boxCount,
			"box_spec":     outBoxSpec,
			"product_id":   nil,
			"matched_name": "",
			"matched_sku":  "",
			"category":     "",
			"unit_price":   unitPrice,
			"deduction_percent": deduction,
			"net_price":    Round(unitPrice*(1-deduction/100), 4),
			"freight":      freight,
			"bag_weight":   bagWeight,
			"unit_cost":    unitCost,
			"bag_cost":     bagCost,
			"stock_product_name": productNameOrEmpty(sp),
			"stock_default_unit": WhStockDefaultUnit(sp),
			"revenue": revenue,
			"cogs":    cogs,
			"freight_total": freightTotal,
			"profit":  Round(revenue-cogs-freightTotal, 2),
			"match_score": score,
		}
		if product != nil {
			item["product_id"] = product.ID
			item["matched_name"] = product.Name
			item["matched_sku"] = product.SKU
			item["category"] = product.Category
		}
		items = append(items, item)
	}

	var sumRevenue, sumCOGS, sumFreight, sumProfit, sumQty float64
	matched, unmatched := 0, 0
	for _, it := range items {
		sumRevenue += ToFloat(it["revenue"])
		sumCOGS += ToFloat(it["cogs"])
		sumFreight += ToFloat(it["freight_total"])
		sumProfit += ToFloat(it["profit"])
		sumQty += ToFloat(it["quantity"])
		if ToInt(it["product_id"]) != 0 {
			matched++
		} else {
			unmatched++
		}
	}
	return map[string]any{
		"sheet":       sheetName,
		"sheet_auto":  strings.TrimSpace(sheet) == "",
		"warehouse_key": whKey,
		"sheets":      sheets,
		"matched":     matched,
		"unmatched":   unmatched,
		"date":        defaultDate,
		"items":       items,
		"totals": map[string]any{
			"revenue":  Round(sumRevenue, 2),
			"cogs":     Round(sumCOGS, 2),
			"freight":  Round(sumFreight, 2),
			"profit":   Round(sumProfit, 2),
			"quantity": Round(sumQty, 2),
		},
		"failed":       failed,
		"failed_count": len(failed),
	}, nil
}

// ---------------- 导入确认 ----------------

// whConfirmKeys 是 ConfirmItem 的声明字段：Pydantic 会丢弃未声明的键（如前端误传的 pay_status），
// 所以 Go 必须只按这批键构造 payload。
var whConfirmKeys = []string{
	"product_id", "product_name", "category", "unit", "purchase_no", "center", "quantity",
	"box_count", "box_spec", "unit_price", "freight", "bag_weight", "date", "remark",
}

// WhImportConfirm POST /api/warehouse-in/import/confirm：逐行落库，单行失败不影响其它行。
func WhImportConfirm(ctx context.Context, q Querier, body map[string]any, operator string) (map[string]any, error) {
	items := MapSlice(body["items"])
	if len(items) == 0 {
		return nil, ErrText("没有可入仓的数据")
	}
	headerDate := whStr(body["date"])
	group := "wh" + whRandHex(5)
	created := 0
	failed := []map[string]any{}
	for _, it := range items {
		payload := whPickKeys(it, whConfirmKeys)
		if whStr(payload["date"]) == "" { // 同 Python `if not payload.get("date")`
			payload["date"] = headerDate
		}
		// 失败行标签：同 Python `it.product_name or it.purchase_no`（不 trim）
		label := whStr(payload["product_name"])
		if label == "" {
			label = whStr(payload["purchase_no"])
		}
		if _, err := CreateWarehouseIn(ctx, q, payload, operator, group); err != nil {
			failed = append(failed, map[string]any{"row": label, "reason": err.Error()})
			continue
		}
		created++
	}
	return map[string]any{
		"ok": true, "created": created, "failed": failed,
		"failed_count": len(failed), "group": group,
	}, nil
}

// whRandHex 导入批次号 wh{uuid4().hex[:10]} 的等价实现（n 字节 → 2n 个小写十六进制字符）。
func whRandHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return strings.Repeat("0", n*2)
	}
	return hex.EncodeToString(buf)
}
