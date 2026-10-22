package erp

// ---------------- AI 自动归并库存大类（/api/mappings/ai-suggest）----------------
//
// 对应 Python routers/imports.py 的 AI_SUGGEST_SYSTEM_PROMPT / _ai_plan /
// _apply_ai_mappings / _preview_ai_mappings / ai_suggest_mappings。
// apply=False 只试算不落库；apply=True 且带 plan 时照用户确认的方案落库（不再调大模型）。

import (
	"context"
	"fmt"
	"strings"
)

// impAiSuggestSystemPrompt AI_SUGGEST_SYSTEM_PROMPT（逐字）。
const impAiSuggestSystemPrompt = `你正在帮助「企业台账系统」的用户处理出库单解析。当前有一批聚水潭出库商品名在系统中找不到，请自动把它们归并为若干个「库存大类商品」并给出分类，随后系统会为每个大类新增一条库存商品，并把每个原始商品名关联到对应大类，从而让出库单正常结算。

请按以下要求处理：
1. 把形态相同、只是规格/净重/包装/克重等级不同的外部商品名归为同一个「库存大类」。例如：
   「京喜红皮土豆80g+1斤(带箱」「京喜红皮土豆80g+净重1.8斤」「红皮土豆3斤100g+」「红皮土豆5斤200g+」→ 库存大类「红皮土豆」；
   「新鲜天麻大果1斤4-5个」「新鲜天麻特大果3斤10-13个」「新鲜有机天麻大果2斤8-10个」→ 库存大类「天麻」；
   「新鲜西兰苔2.5斤」「新鲜西兰苔4.5斤」→ 库存大类「西兰苔」。
2. 库存大类名称要尽可能短、只保留核心名，且必须是该组绝大多数外部商品名的【子串】（例如「红皮土豆」要被「京喜红皮土豆80g+1斤(带箱」包含），这样系统才能把商品名自动挂到正确的大类。不要把『斤/克/个/箱/带箱/净重/80g+/100g+』等规格字眼放进大类名；名称不要重复。
3. category 只能输出以下原始词之一：蔬菜、干货、商品。蔬菜鲜果类（土豆、天麻、西兰苔、雪莲果、芦笋等）选「蔬菜」；干制品选「干货」；无法确定选「商品」。
4. 只对用户给的商品名做归类，禁止新增用户没提到的商品名。
5. 只输出一个 JSON 对象，禁止输出 JSON 以外的文字、解释、markdown 代码块标记，紧凑单行。
JSON 结构：
{"products":[{"name":"红皮土豆","category":"蔬菜"}],"message":"用一句话说明将新增哪些库存大类并覆盖哪些商品名"}`

// impAiCatNorm _CAT_NORM：大模型给的分类归一到 蔬菜/干货/商品。
var impAiCatNorm = map[string]string{"蔬菜": "蔬菜", "蔬菜类": "蔬菜", "干货": "干货", "干货类": "干货", "商品": "商品"}

func impAiCategory(v string) string {
	if c, ok := impAiCatNorm[strings.TrimSpace(v)]; ok {
		return c
	}
	return "商品"
}

// impAiMappingUserMsg _ai_mapping_user_msg：把未关联商品名连同解析出的规格一起给大模型。
func impAiMappingUserMsg(names []string) string {
	lines := make([]string, 0, len(names))
	for _, n := range names {
		u, q, _ := ParseJstSpec(n)
		spec := ""
		if u != "" {
			spec = FmtQty(q) + " " + u
		}
		line := "- " + n
		if spec != "" {
			line += "　（解析为每件 " + spec + "，这只是规格不是大类名）"
		}
		lines = append(lines, line)
	}
	return "请为下面这些【未关联】的出库商品名归并库存大类并分类。\n" +
		"注意：带『带箱/净重/80g+/100g+』等字样的都只是规格差别，应归到同一个库存大类。\n\n" +
		strings.Join(lines, "\n")
}

// impAiStockConversions _create_ai_stock / _ai_stock_stub 共用的一套标准重量换算。
var impAiStockConversions = map[string]float64{"克": 1, "斤": 500, "公斤": 1000, "千克": 1000}

// impCreateAiStock _create_ai_stock：按名称取或新建库存大类商品，返回 (商品, 是否新建)。
// 注意 Python 的查重不分商品类型（同名即用），这里保持一致。
func impCreateAiStock(ctx context.Context, q Querier, name, category string) (*Product, bool, error) {
	if p := productByColumn(ctx, q, "name", name); p != nil {
		return p, false, nil
	}
	id, err := insertImportProduct(ctx, q, importProductRow{
		Code: "", Name: name, Category: impAiCategory(category), Spec: "AI 自动新增（出库未关联）",
		BaseUnit: "克", DefaultUnit: "公斤", SalePrice: 0, Conversions: impAiStockConversions,
		PackItems: []PackItem{}, PackFee: 0,
	})
	if err != nil {
		return nil, false, err
	}
	p, err := GetProduct(ctx, q, id)
	if err != nil {
		return nil, false, err
	}
	return p, true, nil
}

// impAiStockStub _ai_stock_stub：未落库的大类占位对象（只为先算扣减倍数）。
func impAiStockStub(name, category string) *Product {
	return &Product{
		Name: name, Category: impAiCategoryOr(category, "商品"), ProductType: "stock",
		BaseUnit: "克", DefaultUnit: "公斤", Conversions: impAiStockConversions,
	}
}

func impAiCategoryOr(category, def string) string {
	if strings.TrimSpace(category) == "" {
		return def
	}
	return category
}

// impAiPlan _ai_plan：为每个外部商品名算出「订单小类 → 关联哪个库存大类、按几倍扣减」的方案。
// 返回 (库存大类清单, 每个商品名的方案, 无法自动归属的商品名)。
func impAiPlan(ctx context.Context, q Querier, names []string, products []map[string]any) (
	[]map[string]any, []map[string]any, []string, error) {
	aiItems := []map[string]any{}
	seen := map[string]bool{}
	for _, pr := range products {
		pname := strings.TrimSpace(ToStr(pr["name"]))
		if pname == "" || seen[pname] {
			continue
		}
		seen[pname] = true
		var productID any
		if ex := productByNameAndType(ctx, q, pname, "stock"); ex != nil {
			productID = ex.ID
		}
		aiItems = append(aiItems, map[string]any{
			"name": pname, "category": impAiCategory(ToStr(pr["category"])), "product_id": productID,
		})
	}

	plans := []map[string]any{}
	leftover := []string{}
	needNew := map[string]string{} // 待新建的大类名 → 分类
	for _, name := range names {
		stock := MatchStock(ctx, q, name)
		if stock != nil && stock.ProductType != "stock" {
			stock = nil
		}
		targetNew := false
		if stock == nil {
			// 取「名称是外部商品名子串」里最长的那个（Python max(key=len) 取第一个最长）
			picked := ""
			hitIdx := -1
			for i, a := range aiItems {
				an := ToStr(a["name"])
				if an == "" || !strings.Contains(name, an) {
					continue
				}
				if len([]rune(an)) > len([]rune(picked)) {
					picked = an
					hitIdx = i
				}
			}
			if picked != "" {
				hit := aiItems[hitIdx]
				if pid := ToInt(hit["product_id"]); pid != 0 {
					stock = impGetProduct(ctx, q, pid)
				} else {
					stock = impAiStockStub(picked, ToStr(hit["category"]))
					needNew[picked] = ToStr(hit["category"])
					targetNew = true
				}
			}
		}
		if stock == nil {
			leftover = append(leftover, name)
			continue
		}
		unit := stock.DisplayUnit()
		mult := SpecMultiplier(stock, name)
		var stockID any
		if stock.ID != 0 {
			stockID = stock.ID
		}
		orderExists := false
		if p := productByNameAndType(ctx, q, name, "order"); p != nil {
			orderExists = true
		}
		plans = append(plans, map[string]any{
			"code": name, "target": stock.Name, "target_new": targetNew,
			"stock_product_id": stockID, "multiplier": mult, "unit": unit,
			"spec":         "每单约 " + FmtQty(mult) + unit,
			"order_exists": orderExists,
		})
	}
	for _, a := range aiItems {
		_, isNew := needNew[ToStr(a["name"])]
		a["is_new"] = isNew
	}
	return aiItems, plans, leftover, nil
}

// impApplyAiMappings _apply_ai_mappings：按（可能被用户改过的）方案落库。
func impApplyAiMappings(ctx context.Context, q Querier, names []string, products []map[string]any,
	overrides map[string]map[string]any) (map[string]any, error) {
	if overrides == nil {
		overrides = map[string]map[string]any{}
	}
	aiItems, plans, leftover, err := impAiPlan(ctx, q, names, products)
	if err != nil {
		return nil, err
	}

	// 用户改过的行：目标大类 / 倍数以他选的为准
	for _, pl := range plans {
		ov, ok := overrides[ToStr(pl["code"])]
		if !ok {
			continue
		}
		tid := ToFloat(ov["stock_product_id"])
		tname := strings.TrimSpace(ToStr(ov["target"]))
		if tid != 0 {
			sp := impGetProduct(ctx, q, int64(tid))
			if sp == nil || sp.ProductType != "stock" {
				return nil, ErrText("「%s」的目标必须是库存大类", ToStr(pl["code"]))
			}
			pl["target"] = sp.Name
			pl["target_new"] = false
			pl["stock_product_id"] = sp.ID
			pl["unit"] = sp.DisplayUnit()
		} else if tname != "" {
			pl["target"] = tname
			pl["target_new"] = true
			pl["stock_product_id"] = nil
		}
		if multRaw, present := ov["multiplier"]; present && multRaw != nil && ToStr(multRaw) != "" {
			mult := ToFloat(multRaw)
			if mult > 0 {
				pl["multiplier"] = Round(mult, 6)
			}
		}
		pl["spec"] = "每单约 " + FmtQty(ToFloat(pl["multiplier"])) + ToStr(pl["unit"])
	}

	// 只新建「最终方案里真正会用到、且还不存在」的库存大类：
	// 用户把某行目标改成已有大类时，AI 原本建议新建的那个大类不能再建。
	createdProducts := []map[string]any{}
	stockIDByName := map[string]int{}
	for _, pl := range plans {
		tname := ToStr(pl["target"])
		if tname == "" || ToInt(pl["stock_product_id"]) != 0 {
			continue
		}
		if _, dup := stockIDByName[tname]; dup {
			continue
		}
		if existing := productByNameAndType(ctx, q, tname, "stock"); existing != nil {
			pl["stock_product_id"] = existing.ID
			pl["target_new"] = false
			continue
		}
		cat := "商品"
		for _, a := range aiItems {
			if ToStr(a["name"]) == tname {
				cat = ToStr(a["category"])
				break
			}
		}
		p, isNew, err := impCreateAiStock(ctx, q, tname, cat)
		if err != nil {
			return nil, err
		}
		stockIDByName[tname] = p.ID
		if isNew {
			createdProducts = append(createdProducts, map[string]any{"name": p.Name, "product_id": p.ID})
		}
	}
	for _, a := range aiItems {
		if id, ok := stockIDByName[ToStr(a["name"])]; ok {
			a["product_id"] = id
		}
	}

	createdOrders := []map[string]any{}
	mapped := 0
	for _, pl := range plans {
		stock := impGetProduct(ctx, q, pl["stock_product_id"])
		if stock == nil {
			if sid, ok := stockIDByName[ToStr(pl["target"])]; ok && sid != 0 {
				stock = impGetProduct(ctx, q, sid)
			}
		}
		if stock == nil {
			stock = productByNameAndType(ctx, q, ToStr(pl["target"]), "stock")
		}
		if stock == nil {
			leftover = append(leftover, ToStr(pl["code"]))
			continue
		}
		orderP := productByNameAndType(ctx, q, ToStr(pl["code"]), "order")
		if orderP == nil {
			orderP, err = AutoCreateOrderProduct(ctx, q, ToStr(pl["code"]), stock)
			if err != nil {
				return nil, err
			}
			createdOrders = append(createdOrders, map[string]any{"name": orderP.Name, "product_id": orderP.ID})
		}
		// 关联结算（含倍数）：新老小类都按当前规格刷新
		mult := ToFloat(pl["multiplier"])
		links := EncodeJSONColumn([]StockLink{{ProductID: stock.ID, Multiplier: mult}})
		if _, err := q.ExecContext(ctx,
			"UPDATE products SET stock_product_id = ?, multiplier = ?, stock_links = ? WHERE id = ?",
			stock.ID, mult, links, orderP.ID); err != nil {
			return nil, err
		}
		m, err := impCodeMappingByCode(ctx, q, "jushuitan", ToStr(pl["code"]))
		if err != nil {
			return nil, err
		}
		if m != nil {
			if _, err := q.ExecContext(ctx, "UPDATE code_mappings SET product_id = ?, updated_at = ? WHERE id = ?",
				orderP.ID, NowDB(), m.ID); err != nil {
				return nil, err
			}
		} else if _, err := q.ExecContext(ctx,
			"INSERT INTO code_mappings (source, external_code, external_name, product_id, auto_score, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
			"jushuitan", ToStr(pl["code"]), ToStr(pl["code"]), orderP.ID, 0.0, NowDB(), NowDB()); err != nil {
			return nil, err
		}
		mapped++
	}

	msg := fmt.Sprintf("新增 %d 个库存大类、%d 个订单商品（小类），已为 %d/%d 个平台商品名建立关联结算（按规格倍数扣减对应大类库存）。",
		len(createdProducts), len(createdOrders), mapped, len(names))
	if len(leftover) > 0 {
		msg += "仍有 " + fmt.Sprint(len(leftover)) + " 个无法自动关联：" + strings.Join(leftover, "、") + "，请手动到「关联明细」补充。"
	}
	return map[string]any{
		"ok": true, "created_products": createdProducts, "created_orders": createdOrders,
		"products": aiItems, "mappings": plans, "mapped": mapped,
		"total": len(names), "leftover": leftover, "message": msg,
	}, nil
}

// impPreviewAiMappings _preview_ai_mappings：只试算不落库。
func impPreviewAiMappings(ctx context.Context, q Querier, names []string, products []map[string]any) (map[string]any, error) {
	aiItems, plans, leftover, err := impAiPlan(ctx, q, names, products)
	if err != nil {
		return nil, err
	}
	newCnt := 0
	for _, a := range aiItems {
		if ToBool(a["is_new"]) {
			newCnt++
		}
	}
	orderNew := 0
	for _, p := range plans {
		if !ToBool(p["order_exists"]) {
			orderNew++
		}
	}
	msg := fmt.Sprintf("计划新增 %d 个库存大类、%d 个订单商品（小类），为 %d/%d 个平台商品名建立关联结算（按规格倍数扣减对应大类库存）。",
		newCnt, orderNew, len(plans), len(names))
	if len(leftover) > 0 {
		msg += "仍有 " + fmt.Sprint(len(leftover)) + " 个无法自动关联：" + strings.Join(leftover, "、") + "，请手动补充。"
	}
	return map[string]any{
		"ok": true, "dry_run": true, "products": aiItems, "mappings": plans,
		"created_products": []map[string]any{}, "created_orders": []map[string]any{},
		"mapped": len(plans), "total": len(names), "leftover": leftover, "message": msg,
	}, nil
}

// ImpAiSuggestMappings POST /api/mappings/ai-suggest。
// payload 已由校验层补齐默认值：source / codes / apply / plan。
func ImpAiSuggestMappings(ctx context.Context, q Querier, payload map[string]any) (map[string]any, error) {
	names := impDedupeCodes(payload["codes"])
	if len(names) == 0 {
		return nil, ErrText("没有需要关联的商品名")
	}
	apply := ToBool(payload["apply"])
	var products []map[string]any
	var overrides map[string]map[string]any

	if plan := payload["plan"]; apply && plan != nil {
		// 用户已确认的方案：直接照它落库，不再问一次大模型
		pm, _ := plan.(map[string]any)
		products = MapSlice(pm["products"])
		if ToBool(pm["edited"]) {
			overrides = map[string]map[string]any{}
			for _, m := range MapSlice(pm["mappings"]) {
				code := ToStr(m["code"])
				if code != "" {
					overrides[code] = m
				}
			}
		}
	} else {
		cfg := AILLMConfig()
		if AILLMKey(cfg) == "" {
			return nil, ErrText("未配置 LLM（product_rules.json 的 llm 段），无法使用 AI 自动关联")
		}
		content, _, err := AIChatOnce(ctx, cfg, AIRequest{
			System:   impAiSuggestSystemPrompt,
			Messages: []AIChatMessage{{Role: "user", Content: impAiMappingUserMsg(names)}},
		})
		if err != nil {
			return nil, &BizError{Code: 502, Msg: "AI 归并库存大类失败：" + ErrTextOf(err)}
		}
		parsed, err := aiExtractJSON(content)
		if err != nil {
			return nil, &BizError{Code: 502, Msg: "AI 归并库存大类失败：" + ErrTextOf(err)}
		}
		products = MapSlice(parsed["products"])
	}

	if !apply {
		return impPreviewAiMappings(ctx, q, names, products)
	}
	res, err := impApplyAiMappings(ctx, q, names, products, overrides)
	if err != nil {
		return nil, err
	}
	res["dry_run"] = false
	return res, nil
}

// impDedupeCodes dict.fromkeys(n.strip() for n in codes if n and n.strip())：去空白、去重、保序。
func impDedupeCodes(raw any) []string {
	var arr []any
	switch v := raw.(type) {
	case []any:
		arr = v
	case []string:
		for _, s := range v {
			arr = append(arr, s)
		}
	}
	out := []string{}
	seen := map[string]bool{}
	for _, v := range arr {
		n := strings.TrimSpace(ToStr(v))
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}
