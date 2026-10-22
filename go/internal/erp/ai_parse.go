package erp

import (
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// ---------------- AI 识别的纯文本口径（逐条对齐 app/routers/ai.py） ----------------

// aiUnitAliases 单位别名 -> 系统换算表里的标准名（Python UNIT_ALIASES）。
var aiUnitAliases = map[string]string{
	"g": "克", "克": "克",
	"kg": "千克", "千克": "千克", "公斤": "公斤", "斤": "斤",
	"个": "个", "件": "件", "袋": "袋", "包": "包", "盒": "盒", "箱": "箱", "份": "份", "单": "单",
}

// aiUnitEquivs 等价单位（写法不同、含义相同）。
var aiUnitEquivs = map[string]string{"千克": "公斤", "kg": "公斤", "KG": "公斤", "公斤": "公斤"}

// aiPackKeywords 包材识别关键字（本地兜底/新建商品归类）。
var aiPackKeywords = []string{
	"纸箱", "拖箱", "果箱", "泡沫箱", "保温箱", "周转箱", "编织袋", "保鲜袋",
	"包装袋", "胶带", "气泡膜", "珍珠棉", "冰袋", "内膜袋", "牛皮纸", "封箱",
	"气柱", "吸塑", "拉链袋", "自封袋", "网兜", "彩盒", "礼盒盒",
	"号箱", "箱子",
}

// AICategories AI 商品分类标识。
var AICategories = []string{"stock", "order", "pack", "labor"}

// AICategoryLabels 分类标识 -> 中文。
var AICategoryLabels = map[string]string{
	"stock": "库存商品",
	"order": "订单商品",
	"pack":  "包材",
	"labor": "人工",
}

// aiAliasToCat 分类别名表：setdefault 语义（先注册的别名赢），故用有序列表。
var aiAliasToCat = func() []struct {
	alias string
	cat   string
} {
	spec := []struct {
		cat     string
		aliases []string
	}{
		{"stock", []string{"库存商品", "库存", "商品", "stock", "货品"}},
		{"order", []string{"订单商品", "订单", "order", "销售商品"}},
		{"pack", []string{"包材", "包装材料", "包装耗材", "耗材", "包装", "pack"}},
		{"labor", []string{"人工", "劳务", "打包", "labor", "工费"}},
	}
	var out []struct {
		alias string
		cat   string
	}
	seen := map[string]bool{}
	for _, s := range spec {
		for _, a := range s.aliases {
			if seen[a] {
				continue
			}
			seen[a] = true
			out = append(out, struct {
				alias string
				cat   string
			}{a, s.cat})
		}
	}
	return out
}()

// aiTight 名称归一：去掉所有空白（Python _tight）。
func aiTight(s string) string { return aiReWhitespace.ReplaceAllString(s, "") }

var aiReWhitespace = regexp.MustCompile(`\s+`)

// aiNormNumerals 汉字数字 -> 阿拉伯数字（「京东八号」↔「京东8号」）。
var aiNumCN = map[rune]rune{'〇': '0', '零': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9'}

func aiNormNumerals(s string) string {
	var b strings.Builder
	for _, r := range s {
		if v, ok := aiNumCN[r]; ok {
			b.WriteRune(v)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// aiCanonicalUnit 把识别到的单位统一成系统里的写法（千克/kg 一律记「公斤」）。
func aiCanonicalUnit(unit string) string {
	s := strings.TrimSpace(unit)
	if v, ok := aiUnitEquivs[s]; ok {
		return v
	}
	return s
}

// aiSameUnit 两个单位是否等价。
func aiSameUnit(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return aiCanonicalUnit(a) == aiCanonicalUnit(b)
}

// aiNormUnit 把单位别名归一到商品换算表中的标准名；找不到标准名时原样返回（同 Python）。
func aiNormUnit(unit string, conv map[string]float64) string {
	if unit == "" {
		return ""
	}
	unit = strings.TrimSpace(unit)
	if _, ok := conv[unit]; ok {
		return unit
	}
	if u, ok := aiUnitAliases[unit]; ok {
		if _, ok2 := conv[u]; ok2 {
			return u
		}
	}
	return unit
}

// aiNormalizeCategory 把 LLM 输出的分类原文归一到 stock/order/pack/labor；无法识别返回空串。
func aiNormalizeCategory(raw any) string {
	s := strings.ToLower(strings.TrimSpace(anyToStrOrEmpty(raw)))
	if s == "" {
		return ""
	}
	best, blen := "", -1
	for _, e := range aiAliasToCat {
		if strings.Contains(s, e.alias) && len(e.alias) > blen {
			blen, best = len(e.alias), e.cat
		}
	}
	return best
}

// aiProductCategory 按商品档案反推其 AI 分类标识。
func aiProductCategory(p *Product) string {
	if p == nil {
		return ""
	}
	cat := strings.TrimSpace(p.Category)
	name := p.Name
	if p.ProductType == "order" {
		return "order"
	}
	if cat == "人工" || strings.HasSuffix(name, "打包") {
		return "labor"
	}
	if cat == "包材" || cat == "耗材" || cat == "包装" {
		return "pack"
	}
	return "stock"
}

// aiGuessCategory 本地兜底：按名称猜测分类。
func aiGuessCategory(name string) string {
	if strings.HasSuffix(name, "打包") || strings.HasSuffix(name, "人工") || strings.Contains(name, "人工") {
		return "labor"
	}
	for _, k := range aiPackKeywords {
		if strings.Contains(name, k) {
			return "pack"
		}
	}
	return ""
}

// aiPackKey 包材宽松名：去空白与容器词，只留编号/主名。
func aiPackKey(s string) string {
	t := aiTight(s)
	for _, w := range []string{"泡沫箱", "纸箱", "拖箱", "塑料箱", "箱"} {
		t = strings.ReplaceAll(t, w, "")
	}
	t = strings.ReplaceAll(t, "纸", "")
	return strings.ReplaceAll(t, "拖", "")
}

// aiPackBoxType 包材箱型词：纸箱->「纸」、拖箱->「拖」，判别不出返回空。
func aiPackBoxType(s string) string {
	t := aiTight(s)
	if strings.Contains(t, "拖") {
		return "拖"
	}
	if strings.Contains(t, "纸") {
		return "纸"
	}
	return ""
}

// ---------------- 模型输出的 JSON 提取 ----------------

var aiReJSONBlock = regexp.MustCompile(`(?s)\{.*\}`)

// aiRepairTruncatedJSON 按括号配平补上缺失的闭合括号（模型被 max_tokens 截断时）。
func aiRepairTruncatedJSON(content string) (map[string]any, error) {
	base := strings.TrimSpace(content)
	if strings.HasSuffix(base, ",") {
		base = strings.TrimSpace(strings.TrimSuffix(base, ","))
	}
	var stack []byte
	inStr, esc := false, false
	for _, ch := range []byte(base) {
		if inStr {
			if esc {
				esc = false
			} else if ch == '\\' {
				esc = true
			} else if ch == '"' {
				inStr = false
			}
			continue
		}
		switch ch {
		case '"':
			inStr = true
		case '{':
			stack = append(stack, '}')
		case '[':
			stack = append(stack, ']')
		case '}', ']':
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	tail := make([]byte, 0, len(stack))
	for i := len(stack) - 1; i >= 0; i-- {
		tail = append(tail, stack[i])
	}
	if len(tail) > 0 {
		var out map[string]any
		if err := aiLoadJSONObject([]byte(base+string(tail)), &out); err == nil && out != nil {
			return out, nil
		}
	}
	return nil, aiErr("ValueError", "模型输出无法解析为 JSON（可能被截断）")
}

// aiLoadJSONObject 解析一个 JSON 对象；数字用 json.Number 保留原文（Python 的 json.loads
// 会区分 int/float，这里保住字面量才能把「100」和「100.0」都按原样参与后续计算与输出）。
// 尾部还有非空白内容时判为解析失败（同 json.loads 的严格口径）。
func aiLoadJSONObject(raw []byte, out *map[string]any) error {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errInvalidJSON
	}
	return nil
}

var errInvalidJSON = errors.New("模型输出无法解析为 JSON（可能被截断）")

// aiExtractJSON 从模型输出里稳健提取 JSON（兼容代码块 / 前后杂文 / 截断）。
func aiExtractJSON(content string) (map[string]any, error) {
	content = strings.TrimSpace(content)
	if m := aiReJSONBlock.FindString(content); m != "" {
		content = m
	}
	var out map[string]any
	if err := aiLoadJSONObject([]byte(content), &out); err == nil && out != nil {
		return out, nil
	}
	return aiRepairTruncatedJSON(content)
}

// AIExtractJSON 接口层入口：Python 里提取失败抛 ValueError("模型输出无法解析为 JSON（可能被截断）")，
// 这里折成同口径的 AIError，好让 502 文案拼出「ValueError: …」而不是 Go 的类型名。
func AIExtractJSON(content string) (map[string]any, error) {
	m, err := aiExtractJSON(content)
	if err != nil || m == nil {
		return nil, aiErr("ValueError", "模型输出无法解析为 JSON（可能被截断）")
	}
	return m, nil
}

// ---------------- 本地快速解析（_quick_parse_text） ----------------

var aiReExplicitDate = regexp.MustCompile(`\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|\d{1,2}月\d{1,2}[日号]`)

var aiReQuickLead = regexp.MustCompile(`^(?:今天|昨天|前天|今早|上午|下午|晚上|早上|刚才|刚刚)?(?:入库|进货|采购|进仓|收货|出库|销售|卖出|发货|出货)+了*`)

var aiReQuickStrip = regexp.MustCompile(`^(?:的|约|大约|约为)\s*`)

const aiUnitPattern = `斤|公斤|千克|个|件|袋|包|盒|箱|份|单|桶|瓶|扎|本`

// alt_pattern：名称写在数量之前（「入库6号纸箱100个」）。
var aiReAltLine = regexp.MustCompile(`(?s)(?P<product>[A-Za-z0-9\x{4e00}-\x{9fa5}][^\d\x{ff0c},\x{3002}!\x{ff01}?\x{ff1f};\x{ff1b}\n]{0,20}?)\s*(?P<qty>\d+(?:\.\d+)?)\s*(?P<unit>` + aiUnitPattern + `)`)

var aiPricePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?s)(?:每\s*(?:` + aiUnitPattern + `)|单价|每单|每份|每袋|每盒|每箱|每包|每件|每斤|每公斤|每千克)\s*(?:￥|¥)?(\d+(?:\.\d+)?)\s*(?:元|￥|¥)`),
	regexp.MustCompile(`(?s)(?:￥|¥)?(\d+(?:\.\d+)?)\s*(?:一|两)?(?:` + aiUnitPattern + `)\s*(?:元|￥|¥)`),
	regexp.MustCompile(`(?s)(?:￥|¥)?(\d+(?:\.\d+)?)\s*(?:一|两)?(?:` + aiUnitPattern + `)`),
	regexp.MustCompile(`(?s)(?:￥|¥)?(\d+(?:\.\d+)?)\s*(?:元|￥|¥)`),
}

var aiRePriceBefore = regexp.MustCompile(`(?s)(?:￥|¥)?(\d+(?:\.\d+)?)\s*(?:元|￥|¥|(?:一|两)(?:` + aiUnitPattern + `))`)

// aiQuickMatch line_pattern 的一次命中。
type aiQuickMatch struct {
	Qty      string
	Unit     string
	Product  string
	ProdFrom int // m.start("product")（字节偏移）
	End      int // m.end()
}

// aiUnitsOrdered 正则分支顺序（Python 的 alternation 顺序）。
var aiUnitsOrdered = []string{"斤", "公斤", "千克", "个", "件", "袋", "包", "盒", "箱", "份", "单", "桶", "瓶", "扎", "本"}

func aiIsBannedRune(r rune) bool {
	switch r {
	case '，', ',', '。', '!', '！', '?', '？', ';', '；', '\n':
		return true
	}
	return false
}

func aiIsProductLeadRune(r rune) bool {
	if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
		return true
	}
	return r >= 0x4e00 && r <= 0x9fa5
}

// aiMatchUnitAt 在 s[i:] 上按分支顺序匹配一个单位，返回长度（0 = 不匹配）。
func aiMatchUnitAt(s string, i int) int {
	for _, u := range aiUnitsOrdered {
		if strings.HasPrefix(s[i:], u) {
			return len(u)
		}
	}
	return 0
}

// aiSkipSpaces 跳过 ASCII 空白（快速解析的 s 已去空白，这里只为等价保险）。
func aiSkipSpaces(s string, i int) int {
	for i < len(s) {
		switch s[i] {
		case ' ', '\t', '\n', '\r', '\v', '\f':
			i++
			continue
		}
		break
	}
	return i
}

// aiReadNumber 读 `\d+(\.\d+)?`（贪婪，与 Python 的回溯顺序一致）。
func aiReadNumber(s string, i int) (string, int) {
	start := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == start {
		return "", start
	}
	if i < len(s) && s[i] == '.' && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '9' {
		i++
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
	}
	return s[start:i], i
}

// aiLineLookahead line_pattern 的零宽前向断言：`\d+\s*UNIT` / 标点 / 串尾。
func aiLineLookahead(s string, i int) bool {
	if i >= len(s) {
		return true
	}
	if n, j := aiReadNumber(s, i); n != "" {
		if aiMatchUnitAt(s, aiSkipSpaces(s, j)) > 0 {
			return true
		}
	}
	r, _ := utf8.DecodeRuneInString(s[i:])
	switch r {
	case '，', ',', '。', '!', '！', '?', '？', ';', '；':
		return true
	}
	return false
}

// aiLinePatternFindAll 复刻 line_pattern.finditer(s)：RE2 不支持前向断言，这里按同样的
// 「最左优先 + 惰性最短」规则手写扫描。
func aiLinePatternFindAll(s string) []aiQuickMatch {
	out := []aiQuickMatch{}
	i := 0
	for i < len(s) {
		if m, ok := aiLineMatchAt(s, i); ok {
			out = append(out, m)
			i = m.End
			continue
		}
		i++
	}
	return out
}

func aiLineMatchAt(s string, i int) (aiQuickMatch, bool) {
	qty, j := aiReadNumber(s, i)
	if qty == "" {
		return aiQuickMatch{}, false
	}
	j = aiSkipSpaces(s, j)
	ul := aiMatchUnitAt(s, j)
	if ul == 0 {
		return aiQuickMatch{}, false
	}
	unit := s[j : j+ul]
	pos := aiSkipSpaces(s, j+ul)
	if pos >= len(s) {
		return aiQuickMatch{}, false
	}
	lead, w := utf8.DecodeRuneInString(s[pos:])
	if !aiIsProductLeadRune(lead) {
		return aiQuickMatch{}, false
	}
	start := pos
	pos += w
	for pos < len(s) {
		r, rw := utf8.DecodeRuneInString(s[pos:])
		if aiIsBannedRune(r) {
			break
		}
		pos += rw
		if aiLineLookahead(s, pos) {
			return aiQuickMatch{Qty: qty, Unit: unit, Product: s[start:pos], ProdFrom: start, End: pos}, true
		}
	}
	return aiQuickMatch{}, false
}

// AINormalizeQuickProductName 快速解析的商品名清理（Python _normalize_quick_product_name）。
func AINormalizeQuickProductName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.Trim(name, "，,。;；")
	name = aiReQuickStrip.ReplaceAllString(name, "")
	stripped := aiReQuickLead.ReplaceAllString(name, "")
	if stripped != name && lenRune(stripped) >= 2 {
		name = stripped
	}
	return name
}

func lenRune(s string) int { return utf8.RuneCountInString(s) }

// AIQuickParseText 针对简单口语文本做本地快速识别；不适用时返回 nil（Python 返回 None）。
func AIQuickParseText(text string) map[string]any {
	s := strings.TrimSpace(aiReWhitespace.ReplaceAllString(ToStr(text), ""))
	if s == "" {
		return nil
	}
	if aiReExplicitDate.MatchString(s) {
		return nil
	}
	baseDate := todayDate()
	for _, kw := range []struct {
		word string
		days int
	}{{"大前天", 3}, {"前天", 2}, {"昨天", 1}} {
		if strings.Contains(s, kw.word) {
			baseDate = shiftDays(todayDate(), -kw.days)
			break
		}
	}
	opType := ""
	lowered := strings.ToLower(s)
	for _, k := range []string{"入库", "进货", "采购", "进仓", "收货"} {
		if strings.Contains(lowered, k) {
			opType = "inbound"
			break
		}
	}
	if opType == "" {
		for _, k := range []string{"出库", "销售", "卖出", "发货", "出货"} {
			if strings.Contains(lowered, k) {
				opType = "outbound"
				break
			}
		}
	}
	if opType == "" {
		return nil
	}

	matches := aiLinePatternFindAll(s)
	if len(matches) == 0 {
		idx := aiReAltLine.FindAllStringSubmatchIndex(s, -1)
		for _, g := range idx {
			matches = append(matches, aiQuickMatch{
				Qty:      sliceOf(s, g[6], g[7]),
				Unit:     sliceOf(s, g[12], g[13]),
				Product:  sliceOf(s, g[2], g[3]),
				ProdFrom: g[2],
				End:      g[1],
			})
		}
	}
	if len(matches) == 0 {
		return nil
	}

	lines := []map[string]any{}
	for idx, m := range matches {
		qty := parseFloatOr(m.Qty)
		unit := m.Unit
		if unit == "" {
			unit = "个"
		}
		rawProduct := m.Product
		// 商品名以数字开头且紧邻的前一个字符也是数字：只是更长词条的一截，丢弃该行交给大模型。
		if len(rawProduct) > 0 && rawProduct[0] >= '0' && rawProduct[0] <= '9' &&
			m.ProdFrom > 0 && isDigitByte(s[m.ProdFrom-1]) {
			continue
		}
		product := AINormalizeQuickProductName(rawProduct)
		if product == "" {
			continue
		}
		tail := s[m.End:]
		price := 0.0
		for _, pat := range aiPricePatterns {
			if g := pat.FindStringSubmatch(tail); g != nil {
				price = parseFloatOr(g[1])
				break
			}
		}
		if idx == 0 && price == 0 {
			others := s[:m.ProdFrom] + tail
			if g := aiRePriceBefore.FindStringSubmatch(others); g != nil {
				price = parseFloatOr(g[1])
			}
		}
		lines = append(lines, map[string]any{
			"product":    product,
			"quantity":   qty,
			"unit":       unit,
			"unit_price": price,
		})
	}
	if len(lines) == 0 {
		return nil
	}
	return map[string]any{
		"type":     opType,
		"date":     baseDate,
		"supplier": "",
		"customer": "",
		"remark":   "",
		"lines":    lines,
	}
}

func sliceOf(s string, a, b int) string {
	if a < 0 || b > len(s) || a > b {
		return ""
	}
	return s[a:b]
}

func isDigitByte(c byte) bool { return c >= '0' && c <= '9' }

func parseFloatOr(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return v
}


// ---------------- 别名（补充说明里的「别名 -> 正式名称」） ----------------

var aiReArrowAlias = regexp.MustCompile(`([^，,。;；、（）()\[\]【】|]{1,24}?)\s*(?:->|→|=>|⇒|＝|=)\s*([^，,。;；、（）()\[\]【】|]{1,24})`)

var aiReNLAlias = regexp.MustCompile(`\s*(?:就是|即是|改为|改成|换成|叫作|叫做)\s*`)

var aiAliasNoise = []string{"的", "说", "图", "里", "所谓", "这个", "这些"}

var aiReAliasLead = regexp.MustCompile(`^(?:图里的|图里说的|图里写的|图上的|图中有?的?|里面说的|这个|这些|所谓|指的是|是|为|叫|即)+`)

var aiReAliasTail = regexp.MustCompile(`(?:这类|之类的|等等|等)$`)

func aiAliasSide(s string) string {
	s = strings.Trim(aiTight(s), "，,。;；:：")
	s = aiReAliasLead.ReplaceAllString(s, "")
	s = aiReAliasTail.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}

func aiAliasOK(src, dst string) bool {
	if src == "" || dst == "" || src == dst {
		return false
	}
	if lenRune(src) < 2 || lenRune(dst) < 2 || lenRune(dst) > 24 {
		return false
	}
	for _, w := range aiAliasNoise {
		if strings.Contains(src, w) {
			return false
		}
	}
	return true
}

type aiAlias struct {
	Src string
	Dst string
}

var aiReSegSplit = regexp.MustCompile(`[，,。;；\n\r\t（）()\[\]【】{}"'“”‘’|]`)

// AIParseAliases 从补充说明里提取「别名 -> 正式名称」对应关系。
func AIParseAliases(text string) []aiAlias {
	text = ToStr(text)
	if strings.TrimSpace(text) == "" {
		return nil
	}
	out := []aiAlias{}
	for _, g := range aiReArrowAlias.FindAllStringSubmatch(text, -1) {
		src, dst := aiAliasSide(g[1]), aiAliasSide(g[2])
		if aiAliasOK(src, dst) {
			out = append(out, aiAlias{src, dst})
		}
	}
	if len(out) > 0 {
		return out
	}
	for _, seg := range aiReSegSplit.Split(text, -1) {
		seg = strings.TrimSpace(seg)
		if seg == "" || lenRune(seg) > 24 {
			continue
		}
		loc := aiReNLAlias.FindStringIndex(seg)
		if loc == nil {
			continue
		}
		src, dst := aiAliasSide(seg[:loc[0]]), aiAliasSide(seg[loc[1]:])
		if aiAliasOK(src, dst) {
			out = append(out, aiAlias{src, dst})
		}
	}
	return out
}

// AIApplyAliases 按补充说明改写识别到的商品名。
func AIApplyAliases(name string, aliases []aiAlias) string {
	name = strings.TrimSpace(name)
	if name == "" || len(aliases) == 0 {
		return name
	}
	norm := aiNormNumerals(aiTight(name))
	for _, a := range aliases {
		if aiNormNumerals(aiTight(a.Src)) == norm {
			return a.Dst
		}
	}
	for _, a := range aliases {
		if a.Src != "" && strings.Contains(name, a.Src) {
			return strings.Replace(name, a.Src, a.Dst, -1)
		}
	}
	return name
}

// ---------------- 日期 ----------------

// aiSafeDate 把模型给的日期转成规范 YYYY-MM-DD；空/非法/未来日期返回 fallback。
func aiSafeDate(v any, fallback string) string {
	s := strings.TrimSpace(anyToStrOrEmpty(v))
	if s == "" {
		return fallback
	}
	d, ok := parseISODateLoose(s)
	if !ok {
		return fallback
	}
	if d > shiftDays(todayDate(), 1) {
		return fallback
	}
	return d
}

// parseISODateLoose 与 Python 3.12 的 date.fromisoformat 一致：接受 YYYY-MM-DD 与 YYYYMMDD，
// 其余写法（缺前导零、带分隔符、带时间）一律视为非法。
func parseISODateLoose(s string) (string, bool) {
	if len(s) == 10 && s[4] == '-' && s[7] == '-' {
		y, m, d := s[:4], s[5:7], s[8:10]
		return dateParts(y, m, d)
	}
	if len(s) == 8 {
		return dateParts(s[:4], s[4:6], s[6:8])
	}
	return "", false
}

func dateParts(y, m, d string) (string, bool) {
	yi, err1 := strconv.Atoi(y)
	mi, err2 := strconv.Atoi(m)
	di, err3 := strconv.Atoi(d)
	if err1 != nil || err2 != nil || err3 != nil {
		return "", false
	}
	if mi < 1 || mi > 12 || di < 1 || di > daysInMonth(yi, time.Month(mi)) {
		return "", false
	}
	if yi < 1 || yi > 9999 {
		return "", false
	}
	return time.Date(yi, time.Month(mi), di, 0, 0, 0, 0, time.UTC).Format("2006-01-02"), true
}

// daysInMonth 与 datetime.date 的合法性校验一致（闰年 2 月 29 天）。
func daysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func todayDate() string { return time.Now().Format("2006-01-02") }

func shiftDays(date string, days int) string {
	t, err := time.ParseInLocation("2006-01-02", date, time.Local)
	if err != nil {
		return date
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

// ---------------- 发给模型的用户消息 ----------------

// AIUserMsg 文本识别的用户消息（显式告知今天日期，避免模型幻觉）。
func AIUserMsg(text string) string {
	return "今天是 " + todayDate() + "（务必以这个日期作为\"今天\"）。\n\n【用户描述】\n" + text
}

// AIImageUserMsg 图片识别的用户消息：日期 + 补充说明 + 「别名 -> 正式名称」对应表。
func AIImageUserMsg(text string) string {
	text = strings.TrimSpace(text)
	aliasBlock := ""
	aliases := AIParseAliases(text)
	if len(aliases) > 0 {
		lines := make([]string, 0, len(aliases))
		for _, a := range aliases {
			lines = append(lines, a.Src+" -> "+a.Dst)
		}
		aliasBlock = "\n【名称对应关系（product 必须输出右边的正式名称，不要沿用图片里的别名）】\n" +
			strings.Join(lines, "\n") +
			"\n同类名称请按同样的规律套用（例如给了「京东8号 -> 8号纸箱」，那「京东五号」就要输出「5号纸箱」）。"
	}
	out := "今天是 " + todayDate() + "（务必以这个日期作为\"今天\"）。请识别这张采购票据图片。"
	if text != "" {
		out += "\n补充说明：" + text
	}
	return out + aliasBlock
}

// AIFollowupBlock 连续对话（追问重识别）：把「上一次结果 + 用户这次的要求」一起给模型。
func AIFollowupBlock(prev, hint string) string {
	hint = strings.TrimSpace(ToStr(hint))
	prev = strings.TrimSpace(ToStr(prev))
	if hint == "" && prev == "" {
		return ""
	}
	parts := []string{"\n\n【连续对话·请在上一次结果的基础上修正】"}
	if prev != "" {
		parts = append(parts, "上一次的识别结果（JSON，作为基准）：\n"+clipRunes(prev, 4000))
	}
	if hint != "" {
		parts = append(parts, "用户这次的要求（必须改到位）：\n"+hint)
	}
	parts = append(parts, "只修改用户指出的部分，其余（没被提到的商品/数量/单位/日期/类型）保持与上一次结果一致；"+
		"若用户的要求与票据/描述矛盾，以用户的要求为准。仍旧只输出「思路」和一个 JSON 对象。")
	return strings.Join(parts, "\n")
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
