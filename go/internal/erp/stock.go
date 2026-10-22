package erp

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"
)

// ---------------- 单位换算 ----------------

// UnitToBase 把某商品在指定单位的数量折算成基础单位数量（口径同 Python unit_to_base）。
func UnitToBase(p *Product, unit string, quantity float64) (float64, error) {
	factor, ok := p.Conversions[unit]
	if !ok || factor <= 0 {
		return 0, ErrText("商品「%s」未配置单位「%s」的换算系数", p.Name, unit)
	}
	return quantity * factor, nil
}

// BaseToUnit 基础单位数量折算回展示单位。
func BaseToUnit(p *Product, unit string, quantityBase float64) (float64, error) {
	factor, ok := p.Conversions[unit]
	if !ok || factor <= 0 {
		return 0, ErrText("商品「%s」未配置单位「%s」的换算系数", p.Name, unit)
	}
	return quantityBase / factor, nil
}

var defaultConversionsWeight = map[string]float64{"克": 1, "斤": 500, "公斤": 1000, "千克": 1000}
var defaultConversionsCount = map[string]float64{"个": 1}

// DefaultConversions 按基础单位给出默认换算表（新建商品未填 conversions 时使用）。
func DefaultConversions(baseUnit string) map[string]float64 {
	if baseUnit == "克" || baseUnit == "g" {
		out := make(map[string]float64, len(defaultConversionsWeight))
		for k, v := range defaultConversionsWeight {
			out[k] = v
		}
		return out
	}
	out := make(map[string]float64, 1)
	for k, v := range defaultConversionsCount {
		out[k] = v
	}
	return out
}

// LatestInboundDates 各库存商品「最近一次采购入库」的日期（YYYY-MM-DD，Inbound.date 取最大值）。
// 用于多方案扣减时挑方案；口径只看采购入库单日期，不含入仓台账与盘点调整。
func LatestInboundDates(ctx context.Context, q Querier, productIDs []int) (map[int]string, error) {
	seen := map[int]bool{}
	ids := make([]int, 0, len(productIDs))
	for _, id := range productIDs {
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	out := map[int]string{}
	if len(ids) == 0 {
		return out, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := q.QueryContext(ctx,
		"SELECT product_id, MAX(date) FROM inbounds WHERE product_id IN ("+ph+") GROUP BY product_id", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var pid int
		var date sql.NullString
		if err := rows.Scan(&pid, &date); err != nil {
			return nil, err
		}
		if pid != 0 {
			out[pid] = date.String
		}
	}
	return out, rows.Err()
}

// Deduction 一次出库需要扣减的库存商品与扣减量（基础单位）。
type Deduction struct {
	Target *Product
	Qty    float64
}

// DeductionScheme 选出本次出库要用的扣减方案 → (扣减项清单, 方案名)（口径同 Python deduction_scheme）：
//   - 没配多方案 → 用商品自身的 stock_links（老数据口径不变），方案名为空；
//   - 配了多方案 → 每套取「方案内库存商品最近一次采购入库日期」的最大值，谁最新用谁；
//     都没入库记录或日期并列 → 用第一套（严格大于，顺序最可预期）。
func DeductionScheme(ctx context.Context, q Querier, order *Product) ([]StockLink, string, error) {
	if len(order.StockSchemes) == 0 {
		return order.StockLinks, "", nil
	}
	ids := []int{}
	for _, s := range order.StockSchemes {
		for _, it := range s.Links {
			ids = append(ids, it.ProductID)
		}
	}
	lastIn, err := LatestInboundDates(ctx, q, ids)
	if err != nil {
		return nil, "", err
	}
	bestI, bestDate := 0, ""
	for i, s := range order.StockSchemes {
		d := ""
		for _, it := range s.Links {
			if v := lastIn[it.ProductID]; v > d {
				d = v
			}
		}
		if d > bestDate {
			bestI, bestDate = i, d
		}
	}
	chosen := order.StockSchemes[bestI]
	name := strings.TrimSpace(chosen.Name)
	if name == "" {
		name = fmt.Sprintf("方案%d", bestI+1)
	}
	return chosen.Links, name, nil
}

// DeductionPlan 一次出库需扣减的库存商品清单 + 采用的方案名（口径同 Python _deduction_plan）：
//   - 一单多货规则显式指定了库存大类与倍数 → 按它扣单项（方案名为空，规则优先于商品方案）；
//   - 否则按商品自身的扣减方案（多方案自动选，未配则用 stock_links，再兜底旧的单关联字段）；
//   - 订单商品无任何关联 = 代发：返回空，不扣库存；
//   - 库存大类无关联不再兜底扣自身库存，由调用方决定报错还是 allow_self_stock。
func DeductionPlan(ctx context.Context, q Querier, order *Product, qtyBase float64,
	stockProductID int, multiplier float64) ([]Deduction, string, error) {
	var items []Deduction
	add := func(sp *Product, mult float64) {
		factor := sp.Factor(sp.DisplayUnit())
		qty := qtyBase * mult * factor
		if qty > 0 {
			items = append(items, Deduction{Target: sp, Qty: qty})
		}
	}
	if stockProductID != 0 {
		sp, err := GetProduct(ctx, q, stockProductID)
		if err == nil && sp.ProductType == "stock" {
			if multiplier == 0 {
				multiplier = 1
			}
			add(sp, multiplier)
			return items, "", nil
		}
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, "", err
		}
	}
	links, schemeName, err := DeductionScheme(ctx, q, order)
	if err != nil {
		return nil, "", err
	}
	for _, link := range links {
		if link.ProductID == 0 {
			continue
		}
		sp, err := GetProduct(ctx, q, link.ProductID)
		if err == nil {
			mult := link.Multiplier
			if mult == 0 {
				mult = 1
			}
			add(sp, mult)
		} else if !errors.Is(err, ErrNotFound) {
			return nil, "", err
		}
	}
	if len(items) == 0 && order.StockProductID != nil {
		sp, err := GetProduct(ctx, q, *order.StockProductID)
		if err == nil {
			mult := order.Multiplier
			if mult == 0 {
				mult = 1
			}
			add(sp, mult)
		} else if !errors.Is(err, ErrNotFound) {
			return nil, "", err
		}
	}
	if len(items) == 0 {
		schemeName = ""
	}
	return items, schemeName, nil
}

// StockDeductions 计算出库时实际扣减的库存商品清单（口径同 Python stock_deductions）：
//   - 订单小类配了多关联 stock_links：逐项扣减，扣减量 = 订单基础数量 × 倍数 × 库存默认单位系数
//   - 只有旧的单关联字段（stock_product_id + multiplier）：按单关联扣减
//   - 无任何关联：视为代发，返回空（不扣库存）
//   - 库存大类无关联：不再兜底扣自身库存，由调用方决定报错还是 allow_self_stock
func StockDeductions(ctx context.Context, q Querier, order *Product, qtyBase float64) ([]Deduction, error) {
	items, _, err := DeductionPlan(ctx, q, order, qtyBase, 0, 1)
	return items, err
}

// StockDeductionsOverride 一单多货规则显式指定了库存大类与倍数时优先按其扣减（单项），
// 否则回退到订单商品自身关联（口径同 Python _deductions_with_override）。
func StockDeductionsOverride(ctx context.Context, q Querier, order *Product, qtyBase float64, stockProductID int, multiplier float64) ([]Deduction, error) {
	items, _, err := DeductionPlan(ctx, q, order, qtyBase, stockProductID, multiplier)
	return items, err
}

// ---------------- 库存流水与 FIFO ----------------

// Movement 库存流水（FIFO 重放只需要这几列）。
type Movement struct {
	ID          int
	ProductID   int
	MoveType    string
	Quantity    float64 // quantity_base，有符号
	Amount      float64
	RefType     string
	RefID       *int
	LineID      *int
	Date        string
	Operator    string
	Remark      string
}

// MovementsFor 读取某商品的全部流水（按 id 升序，即记账顺序）。
func MovementsFor(ctx context.Context, q Querier, productID int) ([]Movement, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT id, product_id, move_type, quantity_base, amount, ref_type, ref_id
		   FROM stock_movements WHERE product_id = ? ORDER BY id`, productID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Movement
	for rows.Next() {
		var m Movement
		var refType sql.NullString
		var refID sql.NullInt64
		if err := rows.Scan(&m.ID, &m.ProductID, &m.MoveType, &m.Quantity, &m.Amount, &refType, &refID); err != nil {
			return nil, err
		}
		m.RefType = refType.String
		if refID.Valid {
			v := int(refID.Int64)
			m.RefID = &v
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

type fifoLayer struct {
	qty  float64
	cost float64
}

type backorder struct {
	qty       float64
	assumed   float64
	movementID int
}

// FIFOState 是 FIFO 重放后的现场：剩余批次、兜底单位成本、每条出库流水的结转成本。
type FIFOState struct {
	Stock    float64
	Value    float64
	Layers   []fifoLayer
	Base     float64
	OutCosts map[int]float64
}

const eps = 1e-9

// FIFOReplay 按「先进先出」重放流水，口径与 Python _fifo_replay 完全一致：
//   - 入库/盘盈：先按本次实际进价补回历史超卖（并回溯修正那次出库的成本），余量作为新批次；
//   - 出库/包装消耗/盘亏：从最早批次依次扣减；批次不足（超卖）先按最后已知进价暂估并登记待补；
//   - avg/cost：成本重估，把每基础单位均价增量平摊到现存批次；
//   - ucost：参考成本调整，仅记录，不影响库存与成本。
func FIFOReplay(moves []Movement, fallback float64) *FIFOState {
	var layers []fifoLayer
	var backorders []backorder
	stock, base, layersValue := 0.0, 0.0, 0.0
	dirty := false
	outCosts := map[int]float64{}

	layersValueSum := func() float64 {
		if dirty {
			v := 0.0
			for _, l := range layers {
				v += l.qty * l.cost
			}
			layersValue, dirty = v, false
		}
		return layersValue
	}

	for _, m := range moves {
		qty := m.Quantity
		if m.MoveType == "ucost" {
			continue
		}
		if m.MoveType == "avg" || m.MoveType == "cost" {
			delta := 0.0
			if m.MoveType == "avg" {
				delta = m.Amount
			} else if stock > eps {
				delta = m.Amount / stock
			}
			if delta != 0 {
				for i := range layers {
					layers[i].cost = math.Max(layers[i].cost+delta, 0)
				}
				base = math.Max(base+delta, 0)
				dirty = true
			}
			continue
		}
		if qty >= 0 { // 入库 / 盘盈
			if qty > 0 {
				cur := layersValueSum()
				unit := 0.0
				if m.Amount != 0 {
					unit = m.Amount / qty
				} else if stock > eps {
					unit = cur / stock
				} else {
					unit = base
				}
				unit = math.Max(unit, 0)
				base = unit
				rest := qty
				for rest > eps && len(backorders) > 0 {
					bo := backorders[0]
					take := bo.qty
					if rest < take {
						take = rest
					}
					outCosts[bo.movementID] += take * (unit - bo.assumed)
					backorders[0].qty -= take
					rest -= take
					if backorders[0].qty <= eps {
						backorders = backorders[1:]
					}
				}
				if rest > eps {
					layers = append(layers, fifoLayer{qty: rest, cost: unit})
					layersValue += rest * unit
				}
			}
			stock += qty
			continue
		}
		// 出库 / 包装消耗 / 盘亏：先进先出扣减
		out := -qty
		cost, remain := 0.0, out
		for remain > eps && len(layers) > 0 {
			l := layers[0]
			take := l.qty
			if remain < take {
				take = remain
			}
			cost += take * l.cost
			layersValue -= take * l.cost
			layers[0].qty -= take
			remain -= take
			if layers[0].qty <= eps {
				layers = layers[1:]
			}
		}
		if remain > eps { // 超卖：按最后已知进价暂估，登记待后续入库回补
			assumed := base
			if base <= 0 {
				assumed = fallback
				base = assumed
			}
			cost += remain * assumed
			backorders = append(backorders, backorder{qty: remain, assumed: assumed, movementID: m.ID})
		}
		stock -= out
		outCosts[m.ID] += cost
	}
	return &FIFOState{Stock: stock, Value: layersValueSum(), Layers: layers, Base: base, OutCosts: outCosts}
}

// Take 从 FIFO 批次消耗 qty 并返回结转成本（批次不足部分按 base，无则 fallback 计）。
// 会就地消耗 layers（同一张出库单里对同一商品的多行按顺序依次扣减）。
func Take(layers *[]fifoLayer, base float64, qty, fallback float64) float64 {
	cost, remain := 0.0, qty
	for remain > eps && len(*layers) > 0 {
		l := (*layers)[0]
		take := l.qty
		if remain < take {
			take = remain
		}
		cost += take * l.cost
		(*layers)[0].qty -= take
		remain -= take
		if (*layers)[0].qty <= eps {
			*layers = (*layers)[1:]
		}
	}
	if remain > eps {
		unit := base
		if base <= 0 {
			unit = fallback
		}
		cost += remain * unit
	}
	return cost
}

// FIFOStateFor 取商品当前 FIFO 剩余批次与兜底成本（供出库前预估结转成本，不落库）。
func FIFOStateFor(ctx context.Context, q Querier, productID int) (*FIFOState, *Product, error) {
	p, err := GetProduct(ctx, q, productID)
	if errors.Is(err, ErrNotFound) {
		return nil, nil, fmt.Errorf("商品不存在")
	} else if err != nil {
		return nil, nil, err
	}
	moves, err := MovementsFor(ctx, q, productID)
	if err != nil {
		return nil, nil, err
	}
	return FIFOReplay(moves, p.UnitCost), p, nil
}

// SyncOutboundCOGS 把 FIFO 重算后的出库流水金额回写到出库单行成本与单据总成本。
// 优先按流水 line_id 归组（一行明细可对应多条流水）；旧数据退化为按 id 顺序一一对应。
func SyncOutboundCOGS(ctx context.Context, q Querier, outboundID int) error {
	lines, err := listOutboundLineCOGS(ctx, q, outboundID)
	if err != nil {
		return err
	}
	if len(lines) == 0 {
		return nil
	}
	moves, err := MovementsForRef(ctx, q, "outbound", outboundID)
	if err != nil {
		return err
	}
	byLine := map[int]float64{}
	for _, m := range moves {
		if m.LineID != nil && *m.LineID > 0 {
			byLine[*m.LineID] += m.Amount
		}
	}
	total := 0.0
	if len(byLine) > 0 {
		for _, l := range lines {
			amt, ok := byLine[l.ID]
			if !ok {
				total += l.COGS
				continue
			}
			amount := Round2(amt)
			cogs := l.COGS
			if math.Abs(cogs-amount) > 1e-6 {
				cogs = amount
				if _, err := q.ExecContext(ctx, "UPDATE outbound_lines SET cogs = ? WHERE id = ?", cogs, l.ID); err != nil {
					return err
				}
			}
			total += cogs
		}
		return setOutboundTotalCOGS(ctx, q, outboundID, Round2(total))
	}
	if len(lines) != len(moves) {
		return nil // 结构不一致时保守跳过，避免错配
	}
	for i, l := range lines {
		amount := Round2(moves[i].Amount)
		cogs := l.COGS
		if math.Abs(cogs-amount) > 1e-6 {
			cogs = amount
			if _, err := q.ExecContext(ctx, "UPDATE outbound_lines SET cogs = ? WHERE id = ?", cogs, l.ID); err != nil {
				return err
			}
		}
		total += cogs
	}
	return setOutboundTotalCOGS(ctx, q, outboundID, Round2(total))
}

func setOutboundTotalCOGS(ctx context.Context, q Querier, outboundID int, total float64) error {
	_, err := q.ExecContext(ctx, "UPDATE outbounds SET total_cogs = ? WHERE id = ?", total, outboundID)
	return err
}

type lineCOGS struct {
	ID   int
	COGS float64
}

func listOutboundLineCOGS(ctx context.Context, q Querier, outboundID int) ([]lineCOGS, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, cogs FROM outbound_lines WHERE outbound_id = ? ORDER BY id", outboundID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []lineCOGS
	for rows.Next() {
		var l lineCOGS
		if err := rows.Scan(&l.ID, &l.COGS); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// MovementsForRef 按来源单据取流水（含 line_id，供成本回写）。
func MovementsForRef(ctx context.Context, q Querier, refType string, refID int) ([]Movement, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT id, product_id, move_type, quantity_base, amount, ref_type, ref_id, line_id
		   FROM stock_movements WHERE ref_type = ? AND ref_id = ? ORDER BY id`, refType, refID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Movement
	for rows.Next() {
		var m Movement
		var refTypeCol sql.NullString
		var refIDCol, lineID sql.NullInt64
		if err := rows.Scan(&m.ID, &m.ProductID, &m.MoveType, &m.Quantity, &m.Amount, &refTypeCol, &refIDCol, &lineID); err != nil {
			return nil, err
		}
		m.RefType = refTypeCol.String
		if refIDCol.Valid {
			v := int(refIDCol.Int64)
			m.RefID = &v
		}
		if lineID.Valid {
			v := int(lineID.Int64)
			m.LineID = &v
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// RecomputeProduct 以库存流水为准按 FIFO 重算商品的库存、库存均价与库存价值，
// 并把变化后的结转成本回写到流水/出库单行/出库单总额（口径同 Python recompute_product）。
func RecomputeProduct(ctx context.Context, q Querier, productID int) error {
	p, err := GetProduct(ctx, q, productID)
	if errors.Is(err, ErrNotFound) {
		return nil // 商品已删除：跳过重算
	} else if err != nil {
		return err
	}
	moves, err := MovementsFor(ctx, q, productID)
	if err != nil {
		return err
	}
	st := FIFOReplay(moves, p.UnitCost)

	affectedOutbounds := map[int]bool{}
	for _, m := range moves {
		newAmount, ok := st.OutCosts[m.ID]
		if !ok {
			continue
		}
		if math.Abs(m.Amount-newAmount) > 1e-9 {
			if _, err := q.ExecContext(ctx, "UPDATE stock_movements SET amount = ? WHERE id = ?", newAmount, m.ID); err != nil {
				return err
			}
			if m.RefType == "outbound" && m.RefID != nil && *m.RefID > 0 {
				affectedOutbounds[*m.RefID] = true
			}
		}
	}
	for oid := range affectedOutbounds {
		if err := SyncOutboundCOGS(ctx, q, oid); err != nil {
			return err
		}
	}

	avg := st.Base
	if st.Stock > eps {
		avg = st.Value / st.Stock
	}
	stock := Round(st.Stock, 6)
	value := Round(st.Value, 6)
	avgCost := Round(avg, 6)
	workload := p.Workload
	if p.IsService() {
		sum := 0.0
		for _, m := range moves {
			sum += math.Abs(m.Quantity)
		}
		workload = Round(sum, 6)
		stock, value = 0, 0
	}
	_, err = q.ExecContext(ctx,
		"UPDATE products SET stock = ?, stock_value = ?, avg_cost = ?, workload = ? WHERE id = ?",
		stock, value, avgCost, workload, productID)
	return err
}

