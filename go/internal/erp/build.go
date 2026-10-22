package erp

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ---------------- 出库明细构建（与 Python services.build_order 逐行对齐） ----------------

// BuildInput 是 BuildOrder 的入参（原始 JSON 字段名与 Python 请求体一致）。
type BuildInput struct {
	Lines          []map[string]any // 销售行
	PackLines      []map[string]any // 用户编辑后的关联结算行（为空则按商品「关联结算清单」自动带出）
	FeeTotal       *float64         // 「一单一包装费」合计（nil = 未编辑，按销售行 pack_fee 求和）
	AutoExpress    bool             // 是否自动结算快递费
	AllowSelfStock bool             // 手动出库：销售行直接选库存大类时扣它自己的库存
	ExtraPackLines []map[string]any // 手动挑选的关联出库物品（追加，不替换）
	SettleCats     any              // 客户承担的关联结算类别
	SettleProvided bool             // 请求里是否显式带了 settle_cats
	ExpressCfg     ExpressConfig    // 快递费计费配置（nil 时按文件/默认值加载）
	Brush          bool             // 芳谊放单仓刷单：不生成任何关联结算行（包材/人工/快递）
}

type fifoEntry struct {
	layers []fifoLayer
	base   float64
}

// BuildOrder 构建出库单明细：销售行 + 关联结算行（包材/人工/快递）+ 打包费，并校验库存；不落库。
// 成本按「先进先出(FIFO)」从最早的入库批次依次扣减；预览与提交共用同一套算法。
func BuildOrder(ctx context.Context, q Querier, in BuildInput) (map[string]any, error) {
	saleRows := []map[string]any{}
	packRows := []map[string]any{}
	warnings := []string{}
	totalAmount, totalCOGS := 0.0, 0.0
	expressWeight := 0.0 // 整单计费毛重(kg)，用于自动计算快递费

	cfg := in.ExpressCfg
	if cfg.Mode == "" {
		cfg = LoadExpressConfig()
	}

	cache := map[int]*fifoEntry{}
	fifoCOGS := func(target *Product, qty float64) (float64, error) {
		e, ok := cache[target.ID]
		if !ok {
			st, _, err := FIFOStateFor(ctx, q, target.ID)
			if err != nil {
				return 0, err
			}
			e = &fifoEntry{layers: st.Layers, base: st.Base}
			cache[target.ID] = e
		}
		cost := Take(&e.layers, e.base, qty, target.UnitCost)
		return cost, nil
	}

	for _, ln := range in.Lines {
		pid := ToInt(ln["product_id"])
		unit := ToStr(ln["unit"])
		quantity := ToFloat(ln["quantity"])
		price := ToFloat(ln["price"])
		fee := OptFloat(ln, "pack_fee")
		spec := ToStr(ln["spec"])
		ovSP := ToInt(ln["stock_product_id"])
		ovMult := 1.0
		if HasKey(ln, "multiplier") && ln["multiplier"] != nil {
			ovMult = ToFloat(ln["multiplier"])
		}
		gross := OptFloat(ln, "gross_sales")

		p, err := GetProduct(ctx, q, pid)
		if errors.Is(err, ErrNotFound) {
			return nil, ErrText("商品不存在")
		} else if err != nil {
			return nil, err
		}
		if quantity <= 0 {
			return nil, ErrText("「%s」数量必须大于 0", p.Name)
		}
		// 规格：导入单会带「每件2斤」这类规格，手动单没有 → 回退商品维护的「规格说明」，
		// 这样「出库明细（每天×每种规格）」对手动单也能按规格归类。
		if spec == "" {
			spec = strings.TrimSpace(p.Spec)
		}
		qtyBase, err := UnitToBase(p, unit, quantity)
		if err != nil {
			return nil, err
		}
		amount := Round(quantity*price, 2)
		grossSales := amount
		if gross != nil && *gross > 0 {
			grossSales = Round(*gross, 2)
		}

		// 刷单（芳谊放单仓）：本仓不出货、不计商品成本 —— 只留一条销售行，
		// 不解析扣减目标（不扣库存、不做库存大类关联校验），成本口径见 brush.go。
		if in.Brush {
			saleRows = append(saleRows, map[string]any{
				"product_id": p.ID, "product_name": p.Name, "base_unit": p.BaseUnit,
				"unit": unit, "quantity": quantity, "quantity_base": qtyBase,
				"stock_product_id": p.ID, "stock_product_name": p.Name,
				"deduction_base": 0.0, "deductions": []map[string]any{},
				"is_dropship": false, "free_shipping": true, "no_stock": true,
				"unit_price": price, "amount": amount, "cogs": 0.0, "pack_fee": 0.0,
				"gross_sales": grossSales, "line_type": "sale", "spec": spec,
			})
			totalAmount += amount
			continue
		}

		deds, schemeName, err := DeductionPlan(ctx, q, p, qtyBase, ovSP, ovMult)
		if err != nil {
			return nil, err
		}
		if len(deds) == 0 && p.ProductType == "stock" {
			if in.AllowSelfStock {
				deds, schemeName = []Deduction{{Target: p, Qty: qtyBase}}, ""
			} else {
				return nil, ErrText("商品「%s」是库存大类、没有关联结算清单，未扣减库存："+
					"请先在「关联结算」新增对应的订单商品（小类）并关联该库存大类"+
					"（或在「关联明细」把平台商品名指到该小类）后重新导入", p.Name)
			}
		}
		isDropship := len(deds) == 0

		// 包邮：商品自身勾了包邮，或其扣减的任一库存大类勾了包邮 → 该行不计入计费毛重。
		lineFree := p.FreeShipping
		for _, d := range deds {
			if d.Target.FreeShipping {
				lineFree = true
			}
		}

		dedInfo := []map[string]any{}
		cogs := 0.0
		if isDropship {
			// 代发：不扣库存，成本按商品「参考成本（每基础单位）」计；填了单件净重仍计快递费。
			if !lineFree {
				expressWeight += LineWeightKg(p, qtyBase)
			}
			cogs = Round(qtyBase*p.UnitCost, 2)
			if p.UnitCost == 0 {
				warnings = append(warnings, fmt.Sprintf("「%s」是代发商品（未关联库存大类）但没填「参考成本」，代发成本按 0 计", p.Name))
			}
		} else {
			// 订单商品可关联多个库存商品：成本与净重按各扣减项分别结转后累加。
			lineNetKg := 0.0
			for _, d := range deds {
				sp := d.Target
				kg := DeductionNetWeightKg(sp, d.Qty)
				if kg <= 0 {
					kg = LineWeightKg(sp, d.Qty)
				}
				lineNetKg += kg
				c, err := fifoCOGS(sp, d.Qty)
				if err != nil {
					return nil, err
				}
				cogs += c
				dedInfo = append(dedInfo, map[string]any{
					"product_id": sp.ID, "product_name": sp.Name, "base_unit": sp.BaseUnit,
					"deduction_base": d.Qty, "cogs": c,
				})
			}
			if lineNetKg <= 0 {
				lineNetKg = LineWeightKg(p, qtyBase)
			}
			if !lineFree {
				expressWeight += lineNetKg
			}
			cogs = Round(cogs, 2)
		}

		packFee := p.PackFee
		if fee != nil {
			packFee = *fee
		}
		stockPID := p.ID
		stockPName := p.Name
		deductionBase := 0.0
		if len(deds) > 0 {
			stockPID = deds[0].Target.ID
			stockPName = deds[0].Target.Name
			deductionBase = deds[0].Qty
		}
		rowScheme := schemeName
		if isDropship {
			rowScheme = ""
		}
		saleRows = append(saleRows, map[string]any{
			"product_id": p.ID, "product_name": p.Name, "base_unit": p.BaseUnit,
			"unit": unit, "quantity": quantity, "quantity_base": qtyBase,
			"stock_product_id": stockPID, "stock_product_name": stockPName,
			"deduction_base": deductionBase, "deductions": dedInfo,
			"is_dropship": isDropship, "free_shipping": lineFree, "scheme_name": rowScheme,
			"unit_price": price, "amount": amount, "cogs": cogs, "pack_fee": packFee,
			"gross_sales": grossSales, "line_type": "sale", "spec": spec,
		})
		totalAmount += amount
		totalCOGS += cogs
	}

	// 关联结算行：前端（预览后）传了 pack_lines 就按它算；否则按每个销售商品的 pack_items 自动汇总。
	packSpecs := in.PackLines
	if len(packSpecs) == 0 && !in.Brush { // 刷单不生成任何关联结算行（包材/人工/快递）
		type aggKey struct{ pid, mid int }
		agg := map[aggKey]map[string]any{}
		var aggOrder []aggKey
		for _, ln := range in.Lines {
			pid := ToInt(ln["product_id"])
			quantity := ToFloat(ln["quantity"])
			p, err := GetProduct(ctx, q, pid)
			if err != nil {
				continue
			}
			for _, item := range p.PackItems {
				// 关联结算按「单」计：每销售 1 单消耗一次包材/人工。
				q := item.Quantity * quantity
				k := aggKey{pid, item.ProductID}
				d, ok := agg[k]
				if !ok {
					unit := item.Unit
					if unit == "" {
						unit = "个"
					}
					d = map[string]any{"quantity": 0.0, "unit": unit, "sale_product_id": pid}
					agg[k] = d
					aggOrder = append(aggOrder, k)
				}
				d["quantity"] = ToFloat(d["quantity"]) + q
			}
		}
		for _, k := range aggOrder {
			d := agg[k]
			packSpecs = append(packSpecs, map[string]any{
				"product_id": k.mid, "unit": d["unit"], "quantity": d["quantity"], "sale_product_id": d["sale_product_id"],
			})
		}
	}

	// 手动挑选的关联出库物品：追加在自动带出的后面（不替换），标 manual 供前端显示「手动」。
	for _, extra := range in.ExtraPackLines {
		item := map[string]any{}
		for k, v := range extra {
			item[k] = v
		}
		item["manual"] = true
		packSpecs = append(packSpecs, item)
	}

	for _, spec := range packSpecs {
		m, err := GetProduct(ctx, q, ToInt(spec["product_id"]))
		if errors.Is(err, ErrNotFound) {
			return nil, ErrText("关联商品ID %d 不存在", ToInt(spec["product_id"]))
		} else if err != nil {
			return nil, err
		}
		unit := ToStr(spec["unit"])
		quantity := ToFloat(spec["quantity"])
		qtyBase, err := UnitToBase(m, unit, quantity)
		if err != nil {
			return nil, err
		}
		// 关联材料成本：优先用显式指定成本（人工行），否则按 FIFO 结转，无批次时回退参考成本。
		var cost, unitPrice float64
		if v, ok := spec["cogs"]; ok && v != nil {
			cost = Round(ToFloat(v), 2)
			unitPrice = 0.0
			if quantity != 0 {
				unitPrice = Round(cost/quantity, 4)
			}
		} else {
			c, err := fifoCOGS(m, qtyBase)
			if err != nil {
				return nil, err
			}
			cost = Round(c, 2)
			unitPrice = 0.0
			if quantity != 0 {
				unitPrice = Round(cost/quantity, 6)
			}
		}
		row := map[string]any{
			"product_id": m.ID, "product_name": m.Name, "base_unit": m.BaseUnit,
			"unit": unit, "quantity": quantity, "quantity_base": qtyBase,
			"unit_price": unitPrice, "amount": cost, "cogs": cost, "pack_fee": 0.0,
			"line_type": "pack", "sale_product_id": AsAnyInt(spec["sale_product_id"]),
			"manual": ToBool(spec["manual"]),
			"settle_cat": PackSettleCat(m.Category, m.Name),
		}
		if v, ok := spec["spec"]; ok {
			row["spec"] = ToStr(v)
		}
		packRows = append(packRows, row)
		totalCOGS += cost
	}

	// 快递费自动结算：整单净重 + 每单箱体 0.1kg，多段计费，作为一项「快递」分类成本。
	if in.AutoExpress && expressWeight > 0 {
		totalWeight := Round(expressWeight+BoxWeightKg, 3)
		fee := ComputeExpressFee(totalWeight, cfg)
		if fee > 0 {
			ep, err := GetExpressCarrier(ctx, q)
			if err != nil {
				return nil, err
			}
			packRows = append(packRows, map[string]any{
				"product_id": ep.ID, "product_name": ep.Name, "base_unit": ep.BaseUnit,
				"unit": "单", "quantity": 1.0, "quantity_base": 1.0,
				"unit_price": fee, "amount": fee, "cogs": fee, "pack_fee": 0.0,
				"line_type": "pack", "sale_product_id": nil,
				"express_weight": totalWeight, "manual": false,
				"spec": fmt.Sprintf("%.3fkg", totalWeight),
				"settle_cat": PackSettleCat(ep.Category, ep.Name),
			})
			totalCOGS += fee
		}
	}

	totalFee := 0.0
	if in.FeeTotal != nil {
		totalFee = Round(*in.FeeTotal, 2)
	} else {
		for _, r := range saleRows {
			totalFee += ToFloat(r["pack_fee"])
		}
		totalFee = Round(totalFee, 2)
	}

	// 库存预警（允许继续，仅提示；服务型商品不校验，代发跳过）。
	checkStock := func(pid int, need float64, label, spName string) error {
		p, err := GetProduct(ctx, q, pid)
		if errors.Is(err, ErrNotFound) {
			return nil
		} else if err != nil {
			return err
		}
		if p.Category == "人工" || p.Category == "快递" {
			return nil
		}
		if need > p.Stock+1e-6 {
			text := label
			if spName != "" {
				text = fmt.Sprintf("%s（扣%s %s）", label, FmtQty(need), spName)
			}
			warnings = append(warnings, fmt.Sprintf("「%s」库存不足：需 %s %s，现有 %s %s",
				text, FmtQty(need), p.BaseUnit, FmtQty(p.Stock), p.BaseUnit))
		}
		return nil
	}
	for _, r := range saleRows {
		if ToBool(r["is_dropship"]) {
			continue
		}
		deds, _ := r["deductions"].([]map[string]any)
		for _, d := range deds {
			if err := checkStock(ToInt(d["product_id"]), ToFloat(d["deduction_base"]), ToStr(r["product_name"]), ToStr(d["product_name"])); err != nil {
				return nil, err
			}
		}
	}
	for _, r := range packRows {
		if err := checkStock(ToInt(r["product_id"]), ToFloat(r["quantity_base"]), ToStr(r["product_name"]), ""); err != nil {
			return nil, err
		}
	}

	// 客户承担的关联结算（包材/人工/快递费）：计入「实收金额」与报表收入，成本不受影响。
	settleKinds := NormalizeSettleCats(in.SettleCats, in.SettleProvided)
	settleIncome := 0.0
	if len(settleKinds) > 0 {
		for _, r := range packRows {
			if ContainsStr(settleKinds, ToStr(r["settle_cat"])) {
				settleIncome += ToFloat(r["cogs"])
			}
		}
		settleIncome = Round(settleIncome, 2)
	}
	if ContainsStr(settleKinds, SettleFeeCat) {
		settleIncome = Round(settleIncome+Round(totalFee, 2), 2)
	}

	packCOGS := 0.0
	for _, r := range packRows {
		packCOGS += ToFloat(r["cogs"])
	}

	return map[string]any{
		"sale_lines": saleRows, "pack_lines": packRows,
		"is_brush":     in.Brush, // 刷单单：成本=快递+包装固定费+刷单成本（口径见 brush.py）
		"total_amount": Round(totalAmount, 2), "total_cogs": Round(totalCOGS, 2), "total_fee": Round(totalFee, 2),
		"pack_cogs":     Round(packCOGS, 2),
		"settle_income": settleIncome,
		"settle_cats":   strings.Join(settleKinds, ","),
		"gross_profit":  Round(totalAmount+settleIncome-totalCOGS, 2),
		"net_profit":    Round(totalAmount+settleIncome-totalCOGS-totalFee, 2),
		"warnings":      warnings,
	}, nil
}

// AsAnyInt 把 JSON 里的可选整数变成 nil 或 int（sale_product_id 可为空）。
func AsAnyInt(v any) any {
	if v == nil {
		return nil
	}
	i := ToInt(v)
	if i == 0 {
		return nil
	}
	return i
}

// ExpressCarrier 快递费载体商品。
type ExpressCarrier struct {
	ID       int
	Name     string
	Category string
	BaseUnit string
}

func GetExpressCarrier(ctx context.Context, q Querier) (*ExpressCarrier, error) {
	id, name, err := GetOrCreateExpressProduct(ctx, q)
	if err != nil {
		return nil, err
	}
	if p, err := GetProduct(ctx, q, id); err == nil {
		return &ExpressCarrier{ID: p.ID, Name: p.Name, Category: p.Category, BaseUnit: p.BaseUnit}, nil
	}
	return &ExpressCarrier{ID: id, Name: name, Category: "快递", BaseUnit: "单"}, nil
}

