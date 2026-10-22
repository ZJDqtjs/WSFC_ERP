package erp

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------------- 识别结果规范化（_build_result / charges / 工具） ----------------

// aiTruthy 复刻 Python 的真值判断（None/False/0/""/空集合 为假）。
func aiTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case int:
		return x != 0
	case json.Number:
		f, err := x.Float64()
		return err == nil && f != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

// aiListOfMaps 把 JSON 数组读成 []map[string]any（非对象的元素按 Python 的 .get 失败处理：跳过）。
func aiListOfMaps(v any) []map[string]any {
	switch arr := v.(type) {
	case []map[string]any:
		return arr
	case []any:
		out := make([]map[string]any, 0, len(arr))
		for _, it := range arr {
			if m, ok := it.(map[string]any); ok {
				out = append(out, m)
			} else {
				out = append(out, map[string]any{})
			}
		}
		return out
	}
	return nil
}

// aiJObjs 取一个「对象数组」字段（用于 result["lines"] / charges 列表）。
func aiJObjs(v any) []*JObj {
	out := []*JObj{}
	switch arr := v.(type) {
	case []*JObj:
		return arr
	case []any:
		for _, it := range arr {
			if j, ok := it.(*JObj); ok {
				out = append(out, j)
			}
		}
	}
	return out
}

// aiStrList 取一个「字符串数组」字段。
func aiStrList(v any) []string {
	out := []string{}
	switch arr := v.(type) {
	case []string:
		return arr
	case []any:
		for _, it := range arr {
			out = append(out, ToStr(it))
		}
	}
	return out
}

// aiPyStr 复刻 Python 的 str(v)（含 None/True/False 与浮点 repr）。
func aiPyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case bool:
		if x {
			return "True"
		}
		return "False"
	case string:
		return x
	case float64:
		return PyFloatRepr(x)
	case int:
		return strconv.Itoa(x)
	case json.Number:
		s := x.String()
		if strings.ContainsAny(s, ".eE") {
			return PyFloatRepr(ToFloat(v))
		}
		return s
	}
	return fmt.Sprintf("%v", v)
}

// aiOrStr 复刻 Python 的 `str(v or "")`。
func aiOrStr(v any) string {
	if !aiTruthy(v) {
		return ""
	}
	return aiPyStr(v)
}

// aiGetOr 取键值，缺失时返回 def（Python 的 d.get(k, def)）。
func aiGetOr(m map[string]any, k string, def any) any {
	if v, ok := m[k]; ok {
		return v
	}
	return def
}

// ---------------- 出库附加项 ----------------

var aiChargeExpressWords = []string{"运费", "快递", "邮费", "物流", "配送费"}
var aiChargeLaborWords = []string{"工时", "人工", "手工", "劳务", "打包费", "胶带", "胶布"}

var aiReChargeParen = regexp.MustCompile(`[（(][^)）]*[)）]`)
var aiReChargePrice = regexp.MustCompile(`[0-9.]+\s*(?:[/／]\s*[0-9.]+)?\s*(?:元|块|¥|￥)?`)

const aiChargeStripSet = " /／-—,，、:：.·"

// AIChargeName 费用项名称归一（「胶带4/30」→「胶带」、「吸水纸0.23」→「吸水纸」）。
func AIChargeName(raw any) string {
	orig := strings.TrimSpace(aiOrStr(raw))
	s := aiReChargeParen.ReplaceAllString(orig, "")
	s = aiReChargePrice.ReplaceAllString(s, "")
	s = strings.TrimFunc(s, func(r rune) bool { return strings.ContainsRune(aiChargeStripSet, r) })
	if s != "" {
		return s
	}
	return orig
}

// AIChargeAmount 费用金额（非法值按 0，同 Python 的 try/except）。
func AIChargeAmount(v any) float64 { return Round(ToFloat(v), 2) }

// AIChargeCandidates 给费用项找候选商品（包材/人工/其他都算），供确认框里手动改。
func AIChargeCandidates(ctx context.Context, q Querier, name string) []*aiProductRow {
	var cands []*aiProductRow
	seen := map[int]bool{}
	for _, cat := range []string{"pack", "labor", ""} {
		list, err := AILineCandidates(ctx, q, name, cat)
		if err != nil {
			continue
		}
		for _, p := range list {
			if !seen[p.ID] {
				seen[p.ID] = true
				cands = append(cands, p)
			}
		}
	}
	if len(cands) > 6 {
		cands = cands[:6]
	}
	return cands
}

// AIChargeUnitCost 该商品在 unit 单位下的单位成本（先用库存均价，无则参考成本）。
func AIChargeUnitCost(p *aiProductRow, unit string) float64 {
	conv := p.Conversions[unit]
	if conv == 0 {
		return 0
	}
	c := p.AvgCost
	if c == 0 {
		c = p.UnitCost
	}
	return Round(c*conv, 6)
}

// AINormalizeCharges 把出库附加项（商品行之外的费用项）归一到确认框里那一行行可改的结构。
func AINormalizeCharges(ctx context.Context, q Querier, parsed map[string]any, opType string) []*JObj {
	out := []*JObj{}
	if opType != "outbound" {
		return out
	}
	seen := map[string]bool{}
	for _, rawAny := range aiListOfMaps(parsed["charges"]) {
		raw := rawAny
		name := AIChargeName(aiOrStr(aiGetOr(raw, "name", "")))
		if name == "" {
			name = AIChargeName(aiOrStr(aiGetOr(raw, "product", "")))
		}
		if name == "" {
			continue
		}
		amount := AIChargeAmount(raw["amount"])
		qty := Round(ToFloat(raw["quantity"]), 6)
		unit := aiCanonicalUnit(strings.TrimSpace(aiOrStr(raw["unit"])))
		if amount <= 0 && qty <= 0 {
			continue
		}
		key := fmt.Sprintf("%s\x00%.17g", name, amount)
		if seen[key] { // 同一行里重复的列
			continue
		}
		seen[key] = true
		isExpress := anyWordIn(name, aiChargeExpressWords)
		isFixed := anyWordIn(name, aiChargeLaborWords)
		var cands []*aiProductRow
		if !isExpress {
			cands = AIChargeCandidates(ctx, q, name)
		}
		var picked *aiProductRow
		pidIn := ToInt(raw["product_id"])
		if pidIn != 0 {
			if p, err := GetProduct(ctx, q, pidIn); err == nil {
				picked = p
			}
		}
		if picked == nil && len(cands) > 0 {
			tight := aiTight(name)
			pk := aiPackKey(name)
			var same []*aiProductRow
			for _, c := range cands {
				if aiTight(c.Name) == tight || aiPackKey(c.Name) == pk {
					same = append(same, c)
				}
			}
			if len(same) == 1 {
				picked = same[0]
			}
		}
		kindIn := strings.ToLower(strings.TrimSpace(aiOrStr(raw["kind"])))
		kind := ""
		switch {
		case kindIn == "pack" || kindIn == "labor" || kindIn == "express" || kindIn == "fee":
			kind = kindIn
		case isExpress:
			kind = "express"
		case isFixed:
			kind = "fee"
		default:
			kind = "fee"
			if picked != nil {
				kind = "pack"
			}
		}
		item := NewJ().
			Set("name", name).
			Set("amount", amount).
			Set("quantity", qty).
			Set("unit", unit).
			Set("kind", kind).
			Set("product_id", aiPickedID(picked)).
			Set("product_name", aiPickedName(picked)).
			Set("category", aiPickedCategory(picked)).
			Set("qty_est", false).
			Set("unit_cost", 0.0).
			Set("candidates", aiCandidateBriefs(cands))
		if kind == "pack" || kind == "labor" {
			if picked == nil {
				item.Set("kind", "fee") // 没商品就只能按金额记（用户可在确认框里挑商品）
			} else {
				conv := picked.Conversions
				du := picked.DisplayUnit()
				if du == "" {
					du = "个"
				}
				curUnit := item.Str("unit")
				if curUnit == "" || !aiHasKey(conv, curUnit) {
					if aiHasKey(conv, du) {
						curUnit = du
					} else {
						first, ok := aiFirstConversionKey(ctx, q, picked.ID)
						if !ok {
							first = du
						}
						curUnit = first
					}
					item.Set("unit", curUnit)
				}
				if item.Num("quantity") <= 0 && amount > 0 {
					// 结算表只写金额的列（泡沫箱 2.2）→ 按该商品单位成本反推数量，
					// 金额仍按结算表的数记账（提交时传显式成本）。
					cost := AIChargeUnitCost(picked, item.Str("unit"))
					if cost > 0 {
						item.Set("quantity", Round(amount/cost, 4))
						item.Set("qty_est", true)
						item.Set("unit_cost", cost)
					}
				}
				if item.Num("quantity") <= 0 {
					item.Set("kind", "fee") // 没有数量、也反推不出来 → 按金额进固定成本
				}
			}
		}
		out = append(out, item)
	}
	return out
}

func aiPickedID(p *aiProductRow) int {
	if p == nil {
		return 0
	}
	return p.ID
}

func aiPickedName(p *aiProductRow) string {
	if p == nil {
		return ""
	}
	return p.Name
}

func aiPickedCategory(p *aiProductRow) string {
	if p == nil {
		return ""
	}
	return aiProductCategory(p)
}

func aiCandidateBriefs(cands []*aiProductRow) []*JObj {
	out := []*JObj{}
	for _, c := range cands {
		u := c.DisplayUnit()
		out = append(out, NewJ().
			Set("product_id", c.ID).
			Set("name", c.Name).
			Set("category", aiProductCategory(c)).
			Set("unit", u))
	}
	return out
}

func anyWordIn(s string, words []string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

// aiFirstConversionKey 取商品换算表 JSON 文本里的第一个键（Python 的 next(iter(dict)) 依赖插入顺序）。
func aiFirstConversionKey(ctx context.Context, q Querier, pid int) (string, bool) {
	var raw sql.NullString
	if err := q.QueryRowContext(ctx, "SELECT conversions FROM products WHERE id = ?", pid).Scan(&raw); err != nil {
		return "", false
	}
	keys := aiJSONKeys(raw.String)
	if len(keys) == 0 {
		return "", false
	}
	return keys[0], true
}

// aiJSONKeys 按 JSON 文本里的出现顺序返回顶层键名（Python 的 dict 保持插入顺序，
// Go 的 map 不保证，所以这里绕过 map 直接用 token 流）。
func aiJSONKeys(text string) []string {
	dec := json.NewDecoder(strings.NewReader(text))
	t, err := dec.Token()
	if err != nil {
		return nil
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return nil
	}
	depth := 1
	var keys []string
	for {
		t, err := dec.Token()
		if err != nil {
			return keys
		}
		switch v := t.(type) {
		case json.Delim:
			switch v {
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return keys
				}
			}
		case string:
			if depth == 1 {
				// 顶层的 string token 交替出现：键 → 值 → 键 → 值。
				// 值为字符串时也会在这里出现，所以靠「读掉值」来配对。
				keys = append(keys, v)
				if _, err := dec.Token(); err != nil {
					return keys
				}
			}
		default:
			if depth == 1 {
				// 顶层值（数字/布尔/null）：上一个 string 是它的键，已在配对时消费。
				continue
			}
		}
	}
}

// AIAttachOutboundCharges 给出库结果补上「关联结算预览 + 固定成本 + 实收金额」。
func AIAttachOutboundCharges(ctx context.Context, q Querier, result *JObj, parsed map[string]any, feeOverride *float64) {
	charges := AINormalizeCharges(ctx, q, parsed, "outbound")
	var packItems, feeItems, expressItems []*JObj
	for _, c := range charges {
		kind := c.Str("kind")
		if (kind == "pack" || kind == "labor") && ToInt(c.Get("product_id")) != 0 && c.Num("quantity") > 0 {
			packItems = append(packItems, c)
		}
		if kind == "fee" && c.Num("amount") > 0 {
			feeItems = append(feeItems, c)
		}
		if kind == "express" && c.Num("amount") > 0 {
			expressItems = append(expressItems, c)
		}
	}
	feeTotal := 0.0
	for _, c := range feeItems {
		feeTotal += c.Num("amount")
	}
	feeTotal = Round(feeTotal, 2)
	if feeOverride != nil {
		feeTotal = Round(*feeOverride, 2)
	}
	result.Set("charges", charges)
	result.Set("fee_total", feeTotal)
	var note []string
	for _, c := range append(append(append([]*JObj{}, packItems...), feeItems...), expressItems...) {
		if c.Num("amount") > 0 {
			note = append(note, fmt.Sprintf("%s ¥%.2f", c.Str("name"), c.Num("amount")))
		}
	}
	result.Set("fee_note", strings.Join(note, "、"))

	var saleLines []map[string]any
	missing := 0
	for _, l := range aiJObjs(result.Get("lines")) {
		if aiTruthy(l.Get("product_id")) && !aiTruthy(l.Get("_deleted")) {
			saleLines = append(saleLines, map[string]any{
				"product_id": ToInt(l.Get("product_id")),
				"unit":       strings.TrimSpace(aiOrStr(l.Get("unit"))),
				"quantity":   ToFloat(l.Get("quantity")),
				"price":      ToFloat(l.Get("unit_price")),
			})
		}
		if !aiTruthy(l.Get("product_id")) {
			missing++
		}
	}
	cats := []string{"material", "labor", "express"}
	if feeTotal > 0 {
		cats = append(cats, "fee")
	}
	result.Set("settle_cats", strings.Join(cats, ","))
	autoExpress := len(expressItems) == 0
	result.Set("auto_express", autoExpress)
	extraPack := []*JObj{}
	for _, c := range packItems {
		item := NewJ().
			Set("product_id", ToInt(c.Get("product_id"))).
			Set("unit", c.Str("unit")).
			Set("quantity", c.Num("quantity"))
		if c.Has("qty_est") && ToBool(c.Get("qty_est")) {
			item.Set("cogs", c.Num("amount"))
		} else {
			item.Set("cogs", nil)
		}
		extraPack = append(extraPack, item)
	}
	if len(expressItems) > 0 {
		// Python 在这里 _get_or_create_express_product(db) + db.commit()，
		// 让新建的「快递费(自动)」商品立即可见（确认框按 id 引用它提交）。
		// Go 侧这段跑在非事务连接上，插入即生效，语义等价。
		id, _, err := GetOrCreateExpressProduct(ctx, q)
		if err == nil {
			amount := 0.0
			for _, c := range expressItems {
				amount += c.Num("amount")
			}
			extraPack = append(extraPack, NewJ().
				Set("product_id", id).
				Set("unit", "单").
				Set("quantity", 1).
				Set("cogs", Round(amount, 2)))
		}
	}
	result.Set("extra_pack_lines", extraPack)
	if len(saleLines) == 0 || missing > 0 {
		// 商品还没补齐时先不预览，等确认框里补全后由服务端重算
		result.Set("preview", nil)
		if missing > 0 {
			result.Set("preview_hint", "有商品还没确认，选好商品后包材/快递/实收金额会自动算出来")
		}
		return
	}
	var feeArg *float64
	if feeTotal != 0 {
		v := feeTotal
		feeArg = &v
	}
	order, err := BuildOrder(ctx, q, BuildInput{
		Lines:          saleLines,
		PackLines:      []map[string]any{},
		FeeTotal:       feeArg,
		AutoExpress:    autoExpress,
		AllowSelfStock: true,
		ExtraPackLines: extraPackMaps(extraPack),
		SettleCats:     cats,
		SettleProvided: true,
	})
	if err != nil {
		result.Set("preview", nil)
		result.Set("preview_hint", "关联结算预览失败："+err.Error())
		return
	}
	packRows := mapSliceAt(order, "pack_lines")
	packLines := []*JObj{}
	for _, r := range packRows {
		source := "自动"
		if ToBool(r["manual"]) {
			source = "识别"
		}
		packLines = append(packLines, NewJ().
			Set("product_id", r["product_id"]).
			Set("product_name", r["product_name"]).
			Set("unit", r["unit"]).
			Set("quantity", r["quantity"]).
			Set("quantity_base", r["quantity_base"]).
			Set("unit_price", r["unit_price"]).
			Set("amount", r["amount"]).
			Set("category", aiOrStr(r["category"])).
			Set("settle_cat", aiOrStr(r["settle_cat"])).
			Set("source", source))
	}
	result.Set("pack_lines", packLines)
	totalAmount, _ := order["total_amount"].(float64)
	settleIncome, _ := order["settle_income"].(float64)
	result.Set("preview", NewJ().
		Set("amount", order["total_amount"]).
		Set("cogs", order["total_cogs"]).
		Set("pack_cogs", order["pack_cogs"]).
		Set("fee", order["total_fee"]).
		Set("settle_income", order["settle_income"]).
		Set("final_amount", Round(totalAmount+settleIncome, 2)).
		Set("gross_profit", order["gross_profit"]))
	if ws := aiStrList(aiGetOr(order, "warnings", nil)); len(ws) > 0 {
		out := make([]string, 0, len(ws))
		out = append(out, ws...)
		result.Set("warnings", out)
	}
	result.Set("preview_hint", "包材/快递/固定成本都按服务端口径算好了：上面金额与提交后一致，可改商品/数量后再提交")
}

func extraPackMaps(items []*JObj) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		m := it.Map()
		// BuildOrder 用 cogs 是否显式给定来决定成本口径，nil 就是「按 FIFO 算」。
		out = append(out, m)
	}
	return out
}

// ---------------- 识别结果主体 ----------------

// AIBuildResult 把模型抽取结果规范化：校验类型/日期，匹配商品，换算单位。
func AIBuildResult(ctx context.Context, q Querier, parsed map[string]any, text string) (*JObj, error) {
	opType := strings.ToLower(strings.TrimSpace(aiPyStr(aiGetOr(parsed, "type", ""))))
	if opType != "inbound" && opType != "outbound" && opType != "stocktake" {
		return nil, ErrText("无法识别业务类型（入库 / 出库 / 盘点），请换个说法")
	}
	linesIn := aiListOfMaps(parsed["lines"])
	if len(linesIn) == 0 {
		return nil, ErrText("未能从描述中提取商品明细，请补充商品名称、数量与价格")
	}

	aliases := AIParseAliases(text)
	lineDates := make([]string, 0, len(linesIn))
	for _, ln := range linesIn {
		d := aiSafeDate(ln["date"], "")
		lineDates = append(lineDates, d)
	}
	validDates := make([]string, 0, len(lineDates))
	for _, d := range lineDates {
		if d != "" {
			validDates = append(validDates, d)
		}
	}
	// Python: max(set(dates), key=dates.count)。并列时 Python 取集合遍历顺序（受哈希随机化影响），
	// 这里取第一次出现的日期，保证 Go 侧稳定。
	commonDate := ""
	if len(validDates) > 0 {
		cnt := map[string]int{}
		order := []string{}
		seen := map[string]bool{}
		for _, d := range validDates {
			cnt[d]++
			if !seen[d] {
				seen[d] = true
				order = append(order, d)
			}
		}
		best, bestN := "", -1
		for _, d := range order {
			if cnt[d] > bestN {
				bestN, best = cnt[d], d
			}
		}
		commonDate = best
	}
	docDate := aiSafeDate(parsed["date"], "")
	if docDate == "" {
		docDate = commonDate
	}
	if docDate == "" {
		docDate = todayDate()
	}

	lines := []*JObj{}
	for i, ln := range linesIn {
		name := aiOrStr(ln["product"])
		if len(aliases) > 0 {
			realName := AIApplyAliases(name, aliases)
			if realName != name {
				ln["product"] = realName
				name = realName
			}
		}
		cat := aiNormalizeCategory(ln["category"])
		if cat == "" {
			cat = aiGuessCategory(name)
		}
		p, err := AIResolveLine(ctx, q, name, opType, cat)
		if err != nil {
			return nil, err
		}
		auto := false
		cands, err := AILineCandidates(ctx, q, name, cat)
		if err != nil {
			return nil, err
		}
		exactHit := false
		var narrowed []*aiProductRow
		var exactName []*aiProductRow
		if cat == "pack" {
			qname := aiTight(name)
			qkey := aiPackKey(name)
			for _, c := range cands {
				if aiTight(c.Name) == qname {
					exactName = append(exactName, c)
				}
			}
			inList := func(list []*aiProductRow, c *aiProductRow) bool {
				for _, x := range list {
					if x.ID == c.ID {
						return true
					}
				}
				return false
			}
			var loose, sub []*aiProductRow
			for _, c := range cands {
				if inList(exactName, c) {
					continue
				}
				if aiPackKey(c.Name) == qkey {
					loose = append(loose, c)
					continue
				}
				if strings.HasPrefix(aiPackKey(c.Name), qkey) {
					sub = append(sub, c)
				}
			}
			rebuilt := append(append(append([]*aiProductRow{}, exactName...), loose...), sub...)
			base := loose
			if len(base) == 0 {
				base = sub
			}
			narrowed = AINarrowByPackType(name, base)
			if len(narrowed) > 0 {
				var others []*aiProductRow
				for _, c := range rebuilt {
					if !inList(narrowed, c) {
						others = append(others, c)
					}
				}
				rebuilt = append(append([]*aiProductRow{}, narrowed...), others...)
			}
			cands = rebuilt
			switch {
			case len(exactName) > 0:
				exactHit, p = true, exactName[0]
			case len(loose) == 1:
				exactHit, p = true, loose[0]
			case len(loose) == 0 && len(sub) == 1:
				exactHit, p = true, sub[0]
			case len(narrowed) == 1:
				exactHit, p = true, narrowed[0]
			default:
				exactHit, p = false, nil
			}
		} else {
			nameT := aiTight(name)
			rawUnit := aiOrStr(ln["unit"])
			var keep []*aiProductRow
			for _, c := range cands {
				if aiTight(c.Name) == nameT || strings.HasPrefix(aiTight(c.Name), nameT) || !AIUnitIncompatible(c, rawUnit) {
					keep = append(keep, c)
				}
			}
			cands = keep
			inList := func(list []*aiProductRow, c *aiProductRow) bool {
				for _, x := range list {
					if x.ID == c.ID {
						return true
					}
				}
				return false
			}
			for _, c := range cands {
				if aiTight(c.Name) == nameT {
					exactName = append(exactName, c)
				}
			}
			var prefix, rest []*aiProductRow
			for _, c := range cands {
				if inList(exactName, c) {
					continue
				}
				if strings.HasPrefix(aiTight(c.Name), nameT) {
					prefix = append(prefix, c)
					continue
				}
				rest = append(rest, c)
			}
			cands = append(append(append([]*aiProductRow{}, exactName...), prefix...), rest...)
			switch {
			case len(exactName) > 0:
				exactHit, p = true, exactName[0]
			case len(prefix) == 1:
				exactHit, p = true, prefix[0]
			case len(prefix) > 1:
				exactHit, p = false, nil
			case p != nil && strings.HasPrefix(aiTight(p.Name), nameT):
				exactHit = true
			default:
				exactHit = false
			}
			if p != nil && !inList(cands, p) {
				p = nil
			}
		}
		_ = narrowed
		_ = i
		var similar []*aiProductRow
		pid := 0
		if p != nil {
			pid = p.ID
		}
		for _, c := range cands {
			if c.ID != pid {
				similar = append(similar, c)
			}
		}
		ambiguous := !exactHit && (p != nil || len(similar) > 0)
		var pendingNew *JObj
		if p == nil && !ambiguous && (opType == "inbound" || opType == "stocktake") {
			pendingNew = AINewProductMeta(aiTight(name), orStrCat(cat, "stock"))
			auto = true
		}
		category := ""
		if p != nil {
			category = aiProductCategory(p)
		} else {
			category = cat
		}
		lnLine := map[string]any(ln)
		lnOut, err := AINormalizeLine(ctx, q, p, NewJFromMap(lnLine), opType, auto, category)
		if err != nil {
			return nil, err
		}
		lnOut.Set("ambiguous", ambiguous)
		if ambiguous && p != nil {
			found := false
			for _, c := range cands {
				if c.ID == p.ID {
					found = true
					break
				}
			}
			if !found {
				cands = append([]*aiProductRow{p}, cands...)
			}
		}
		candList := []*JObj{}
		if ambiguous {
			for _, c := range cands {
				u := c.DisplayUnit()
				candList = append(candList, NewJ().
					Set("product_id", c.ID).
					Set("name", c.Name).
					Set("category", aiProductCategory(c)).
					Set("unit", u).
					Set("last_price", AILastPriceDefault(ctx, q, c, opType)))
			}
		}
		lnOut.Set("candidates", candList)
		if pendingNew != nil {
			lnOut.Set("product_name", pendingNew.Str("name"))
			np := pendingNew.Clone()
			nu := aiCanonicalUnit(aiOrStr(lnLine["unit"]))
			if nu == "" {
				nu = "个"
			}
			np.Set("unit", nu)
			lnOut.Set("new_product", np)
			lnOut.Set("hint", fmt.Sprintf("🆕 系统暂无此商品，确认提交后将新增到「%s」，新商品没有历史价，请填写单价（取消不会创建）",
				pendingNew.Str("category_label")))
		}
		if ambiguous {
			names := make([]string, 0, len(candList))
			for _, c := range candList {
				names = append(names, c.Str("name"))
			}
			rec := lnOut.Str("recognized_name")
			if rec == "" {
				rec = name
			}
			onlyApprox := true
			recT := aiTight(rec)
			for _, c := range candList {
				if aiTight(c.Str("name")) == recT {
					onlyApprox = false
					break
				}
			}
			if onlyApprox {
				lnOut.Set("hint", fmt.Sprintf("⚠ 没有与「%s」完全同名的商品，最接近的是（%s），请确认识别对没有（不是同一商品时，可在下拉里选「🆕 新建」）",
					rec, strings.Join(names, "、")))
			} else {
				lnOut.Set("hint", fmt.Sprintf("⚠ 识别到多个相似商品（%s），请确认选哪一个", strings.Join(names, "、")))
			}
			if lnOut.Num("unit_price") == 0 && len(candList) > 0 {
				first := candList[0]
				if lp := first.Num("last_price"); lp != 0 {
					lnOut.Set("unit_price", lp)
					lnOut.Set("price_defaulted", true)
					lnOut.Set("hint", lnOut.Str("hint")+fmt.Sprintf("；已按默认候选「%s」最近价 %s 填入，请核对",
						first.Str("name"), PyFloatRepr(lp)))
				}
			}
		}
		lnDate := aiSafeDate(lnLine["date"], docDate)
		if lnDate == "" {
			lnDate = docDate
		}
		lnOut.Set("date", lnDate)
		if opType == "stocktake" {
			conv := map[string]float64{}
			du := ""
			if p != nil {
				conv = p.Conversions
				du = p.DisplayUnit()
			} else {
				du = lnOut.Str("unit")
			}
			f := 1.0
			if v, ok := conv[du]; ok && v != 0 {
				f = v
			}
			before := 0.0
			if p != nil {
				st := p.Stock
				if st != 0 {
					before = Round(st/f, 4)
				}
			}
			qty := Round(lnOut.Num("quantity"), 4)
			rel := aiTruthy(lnLine["rel"])
			adjust := qty
			if !rel {
				adjust = Round(qty-before, 4)
			}
			lnOut.Set("stock_before", before)
			lnOut.Set("stock_unit", du)
			lnOut.Set("stock_adjust", adjust)
			lnOut.Set("stock_after", Round(before+adjust, 4))
			if rel {
				lnOut.Set("stock_counted", nil)
			} else {
				lnOut.Set("stock_counted", qty)
			}
			lnOut.Set("stock_rel", rel)
			lnOut.Set("unit_price", 0.0)
			lnOut.Set("hint", fmt.Sprintf("当前库存 %s%s，调整 %s%s → 盘点后 %s%s",
				PyG(before), du, PyGPlus(adjust), du, PyG(before+adjust), du))
		}
		lines = append(lines, lnOut)
	}

	lines = AIMergeDuplicateLines(lines, opType)

	result := NewJ().
		Set("type", opType).
		Set("date", docDate).
		Set("supplier", aiOrStr(aiGetOr(parsed, "supplier", ""))).
		Set("customer", aiOrStr(aiGetOr(parsed, "customer", ""))).
		Set("remark", aiOrStr(aiGetOr(parsed, "remark", ""))).
		Set("lines", lines).
		Set("raw", text)
	if opType == "outbound" {
		AIAttachOutboundCharges(ctx, q, result, parsed, nil)
	}
	return result, nil
}

func orStrCat(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// ---------------- 商品/单位建档 ----------------

// AIEnsureUnit 确保单位存在，不存在则自动新增（计数类单位）。
func AIEnsureUnit(ctx context.Context, q Querier, unit string) error {
	unit = strings.TrimSpace(unit)
	if unit == "" {
		unit = "个"
	}
	var id int
	err := q.QueryRowContext(ctx, "SELECT id FROM units WHERE name = ?", unit).Scan(&id)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = q.ExecContext(ctx,
		"INSERT INTO units (name, category, gram_per_unit, is_standard) VALUES (?, ?, NULL, 0)", unit, "count")
	return err
}

// AIAutoCreateProduct 按分类自动新增商品档案（采购新物品/新包材/新人工），并自动补齐单位。
func AIAutoCreateProduct(ctx context.Context, q Querier, name, unit, cat string) (*aiProductRow, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, ErrText("商品名称为空，无法自动新增")
	}
	if err := AIEnsureUnit(ctx, q, orStrCat(unit, "个")); err != nil {
		return nil, err
	}
	u := strings.TrimSpace(orStrCat(unit, "个"))
	category, ptype := "商品", "stock"
	switch cat {
	case "labor":
		category, ptype = "人工", "stock"
	case "pack":
		category, ptype = "包材", "stock"
	case "order":
		category, ptype = "商品", "order"
	}
	conv := map[string]float64{u: 1}
	res, err := q.ExecContext(ctx, "INSERT INTO products (code, name, category, product_type, base_unit, default_unit, spec,"+
		" sale_price, unit_cost, weight_kg, free_shipping, conversions, pack_items, pack_fee, stock, avg_cost, stock_value,"+
		" stock_product_id, multiplier, stock_links, is_active, workload, created_at)"+
		" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		"", name, category, ptype, u, u, "AI 自动新增（票据识别）",
		0.0, 0.0, 0.0, 0, EncodeJSONColumn(conv), EncodeJSONColumn([]PackItem{}), 0.0, 0.0, 0.0, 0.0,
		nil, 1.0, EncodeJSONColumn([]StockLink{}), 1, 0.0, NowDB())
	if err != nil {
		return nil, err
	}
	id64, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return GetProduct(ctx, q, int(id64))
}

// AINewProductMeta 计算「待新增商品」的档案信息（纯计算，不写库）。
func AINewProductMeta(name, cat string) *JObj {
	if !ContainsStr(AICategories, cat) {
		cat = "stock"
	}
	category, ptype := "商品", "stock"
	switch cat {
	case "labor":
		category, ptype = "人工", "stock"
	case "pack":
		category, ptype = "包材", "stock"
	case "order":
		category, ptype = "商品", "order"
	}
	return NewJ().
		Set("name", strings.TrimSpace(name)).
		Set("category", cat).
		Set("category_label", category).
		Set("product_type", ptype)
}

// AIMaterialize 确认提交时把识别出的「新物品」真正写入商品档案（同名复用，不重复创建）。
func AIMaterialize(ctx context.Context, q Querier, items []map[string]any) ([]*JObj, error) {
	out := []*JObj{}
	createdAny := false
	for _, it := range items {
		name := strings.TrimSpace(aiOrStr(it["name"]))
		if name == "" {
			continue
		}
		var p *aiProductRow
		row := q.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products WHERE name = ? ORDER BY id LIMIT 1", name)
		got, err := scanProduct(row.Scan)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		p = got
		created := false
		if p == nil {
			unit := aiCanonicalUnit(aiOrStr(it["unit"]))
			if unit == "" {
				unit = "个"
			}
			p, err = AIAutoCreateProduct(ctx, q, name, unit, aiOrStr(it["category"]))
			if err != nil {
				return nil, err
			}
			created = true
		}
		out = append(out, NewJ().
			Set("name", name).
			Set("product_id", p.ID).
			Set("category", aiProductCategory(p)).
			Set("created", created))
		createdAny = createdAny || created
	}
	if createdAny {
		if ex, ok := q.(interface{ Commit() error }); ok {
			_ = ex
		}
	}
	return out, nil
}

// ---------------- AI 只读工具 ----------------

var aiCatAliases = map[string]string{
	"库存商品": "stock", "库存": "stock", "stock": "stock",
	"包材": "pack", "耗材": "pack", "包装": "pack", "包装材料": "pack", "pack": "pack",
	"人工": "labor", "labor": "labor",
}

var aiReToolSplit = regexp.MustCompile(`[\s,，、/|]+`)

// aiToolProductBrief 给模型看的商品摘要。
func aiToolProductBrief(p *aiProductRow) *JObj {
	conv := p.Conversions
	if conv == nil {
		conv = map[string]float64{}
	}
	o := NewJ().
		Set("id", p.ID).
		Set("name", p.Name).
		Set("type", aiOrStr(p.ProductType)).
		Set("category", aiOrStr(p.Category)).
		Set("unit", aiOrStr(p.DisplayUnit())).
		Set("conversions", conv).
		Set("stock", Round(p.Stock, 3))
	return o
}

func aiToolSearch(ctx context.Context, q Querier, args map[string]any) []*JObj {
	kw := clipRunes(strings.TrimSpace(aiOrStr(args["keyword"])), AIToolKeywordMax)
	out := []*JObj{}
	if kw == "" {
		return out
	}
	limit := 10
	if v, ok := args["limit"]; ok && v != nil {
		if n, err := aiPyInt(v); err == nil {
			limit = n
		} else {
			limit = 10
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > AIToolMaxLimit {
		limit = AIToolMaxLimit
	}
	cat := aiCatAliases[strings.ToLower(strings.TrimSpace(aiOrStr(args["category"])))]
	rows, err := aiLoadProducts(ctx, q, "")
	if err != nil {
		return out
	}
	var hits []*aiProductRow
	for _, p := range rows {
		if strings.Contains(p.Name, kw) {
			hits = append(hits, p)
		}
	}
	if len(hits) == 0 {
		var toks []string
		for _, t := range aiReToolSplit.Split(kw, -1) {
			if lenRune(t) >= 2 {
				toks = append(toks, t)
			}
		}
		if len(toks) > 0 {
			var all, any []*aiProductRow
			for _, p := range rows {
				allHit, anyHit := true, false
				for _, t := range toks {
					if strings.Contains(p.Name, t) {
						anyHit = true
					} else {
						allHit = false
					}
				}
				if allHit {
					all = append(all, p)
				}
				if anyHit {
					any = append(any, p)
				}
			}
			if len(all) > 0 {
				hits = all
			} else {
				hits = any
			}
		}
	}
	if cat != "" {
		var keep []*aiProductRow
		for _, p := range hits {
			if p.ProductType == cat || (cat == "pack" && ContainsStr([]string{"包材", "耗材", "包装"}, p.Category)) {
				keep = append(keep, p)
			}
		}
		hits = keep
	}
	// 完全同名 → 前缀 → 包含；同档按名称排（Python 的 sort 稳定，且 key 里带 name）
	rank := func(p *aiProductRow) int {
		if p.Name == kw {
			return 0
		}
		if strings.HasPrefix(p.Name, kw) {
			return 1
		}
		return 2
	}
	sort.SliceStable(hits, func(i, j int) bool {
		ri, rj := rank(hits[i]), rank(hits[j])
		if ri != rj {
			return ri < rj
		}
		return hits[i].Name < hits[j].Name
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	for _, p := range hits {
		out = append(out, aiToolProductBrief(p))
	}
	return out
}

func aiToolGet(ctx context.Context, q Querier, args map[string]any) any {
	key := clipRunes(strings.TrimSpace(aiOrStr(args["name_or_id"])), AIToolKeywordMax)
	if key == "" {
		return NewJ()
	}
	var p *aiProductRow
	if isAllDigits(key) {
		if id, err := strconv.ParseInt(key, 10, 64); err == nil {
			row := q.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products WHERE id = ? LIMIT 1", int(id))
			got, err := scanProduct(row.Scan)
			if err == nil {
				p = got
			}
		}
	}
	if p == nil {
		row := q.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products WHERE name = ? ORDER BY id LIMIT 1", key)
		got, err := scanProduct(row.Scan)
		if err == nil {
			p = got
		}
	}
	if p != nil {
		return aiToolProductBrief(p)
	}
	rows, err := q.QueryContext(ctx,
		"SELECT "+productColumns+" FROM products WHERE name LIKE '%' || ? || '%' ORDER BY id", key)
	var near []*aiProductRow
	if err == nil {
		defer rows.Close()
		for rows.Next() && len(near) < 5 {
			got, err := scanProduct(rows.Scan)
			if err != nil {
				break
			}
			near = append(near, got)
		}
	}
	list := []*JObj{}
	for _, x := range near {
		list = append(list, aiToolProductBrief(x))
	}
	return NewJ().
		Set("matched", nil).
		Set("hint", "没有完全同名的商品").
		Set("candidates", list)
}

// AIRunTool 执行模型请求的只读工具调用：白名单 + 限参 + 分仓隔离 + 审计，返回给模型的 JSON 文本。
func AIRunTool(ctx context.Context, q Querier, name, argsJSON string, budget *int) string {
	var args map[string]any
	if err := aiLoadJSONObject([]byte(orStrDefault(argsJSON, "{}")), &args); err != nil || args == nil {
		args = map[string]any{}
	}
	if name != "search_products" && name != "get_product" {
		return string(AIJSONSpaced(NewJ().Set("error",
			fmt.Sprintf("没有这个工具：%s；可用工具只有 search_products / get_product", name))))
	}
	if budget == nil || *budget <= 0 {
		return string(AIJSONSpaced(NewJ().Set("error", "本次查询次数已用完，请用已知信息直接输出结果")))
	}
	*budget--
	var out any
	if name == "search_products" {
		out = aiToolSearch(ctx, q, args)
	} else {
		out = aiToolGet(ctx, q, args)
	}
	return string(AIJSONSpaced(out))
}


// aiPyInt 复刻 Python 的 int(v)：截断小数、非数字字符串报错。
func aiPyInt(v any) (int, error) {
	switch x := v.(type) {
	case string:
		s := strings.TrimSpace(x)
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return 0, err
		}
		return int(n), nil
	}
	f := ToFloat(v)
	return int(f), nil
}

func orStrDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// ---------------- 图片 ----------------

var aiMimeByExt = map[string]string{
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
	"gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
}

// aiPathSuffix 取文件扩展名（含点，同 pathlib 的 .suffix）。
func aiPathSuffix(filename string) string {
	base := filename
	if i := strings.LastIndexAny(base, `/\`); i >= 0 {
		base = base[i+1:]
	}
	i := strings.LastIndex(base, ".")
	if i <= 0 || i == len(base)-1 {
		return ""
	}
	return base[i:]
}

// AIImageDataURI 把上传的图片字节转成 data URI（base64），供多模态模型使用。
func AIImageDataURI(data []byte, filename string) string {
	ext := strings.ToLower(strings.TrimPrefix(aiPathSuffix(filename), "."))
	mime := aiMimeByExt[ext]
	if mime == "" {
		mime = "image/jpeg"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

var aiAllowedExts = []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

// AISaveInvoice 把票据图片保存到 data/uploads，返回 /uploads/xxx.jpg 相对路径。
func AISaveInvoice(data []byte, filename string) (string, error) {
	dir := AIUploadsPath()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	ext := strings.ToLower(aiPathSuffix(filename))
	if !ContainsStr(aiAllowedExts, ext) {
		ext = ".jpg"
	}
	// Python: f"invoice_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}{ext}"
	name := fmt.Sprintf("invoice_%s%s",
		strings.ReplaceAll(time.Now().Format("20060102_150405.000000"), ".", "_"), ext)
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		return "", err
	}
	return "/uploads/" + name, nil
}
