package erp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
)

// 本文件是「盘点调整」读写口径，对齐 Python routers/inventory.py 的 adjust / adjustments 接口。
// 一次调整写若干条流水，共享同一个 ref_id（= 该批第一条流水自身的 id），称为「分组 id」。

// AdjustInput 是 POST /api/adjust 的请求体。
type AdjustInput struct {
	ProductID   int
	Quantity    string
	Unit        string
	AvgCostAdj  string
	UnitCostAdj string
	Remark      string
	Date        string
}

var relRE = regexp.MustCompile("^[+-][0-9]+(\\.[0-9]+)?$")

// ParseRel 解析相对调整串：必须 + 或 - 开头，裸数字与 0 都拒绝（与 Python _parse_rel 一致）。
func ParseRel(s, what string) (float64, bool, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false, nil
	}
	if !relRE.MatchString(s) {
		return 0, false, ErrText("%s必须以 + 或 - 开头（如 +2 增加 / -1 减少），不允许直接填裸数字；留空则不调整", what)
	}
	v := ToFloat(s)
	if v == 0 {
		return 0, false, ErrText("%s不能为 0（需要不调整请留空）", what)
	}
	return v, true, nil
}

// ParseAdjustIn 从请求体解析调整入参。
func ParseAdjustIn(body map[string]any) AdjustInput {
	return AdjustInput{
		ProductID:   ToInt(body["product_id"]),
		Quantity:    ToStr(body["quantity"]),
		Unit:        ToStr(body["unit"]),
		AvgCostAdj:  ToStr(body["avg_cost_adj"]),
		UnitCostAdj: ToStr(body["unit_cost_adj"]),
		Remark:      ToStr(body["remark"]),
		Date:        ToStr(body["date"]),
	}
}

// AdjustStock 执行一次相对盘点，返回接口响应体（键名与 Python 完全一致）。
func AdjustStock(ctx context.Context, q Querier, in AdjustInput, operator string) (map[string]any, error) {
	p, err := GetProduct(ctx, q, in.ProductID)
	if errors.Is(err, ErrNotFound) {
		// Python inventory.py adjust_stock: HTTPException(404, "商品不存在")
		return nil, Err404("商品不存在")
	} else if err != nil {
		return nil, err
	}
	du := p.DisplayUnit()
	fDisp := p.Factor(du)
	op := operator // 操作员一律取当前登录账号
	reason := strings.TrimSpace(in.Remark)
	qtyStr := strings.TrimSpace(in.Quantity)
	avgStr := strings.TrimSpace(in.AvgCostAdj)
	ucStr := strings.TrimSpace(in.UnitCostAdj)

	if qtyStr == "" && avgStr == "" && ucStr == "" {
		return map[string]any{"ok": true, "adjusted": false, "stock": p.Stock,
			"display": Round(p.Stock/fDisp, 4), "unit": du, "avg_cost": p.AvgCost, "unit_cost": p.UnitCost,
			"message": "数量与成本均留空，未进行调整"}, nil
	}

	type pending struct {
		moveType string
		qty      float64
		amount   float64
		remark   string
	}
	var moves []pending
	var parts []string
	var avgDeltaDisp, ucDeltaDisp, deltaDisp float64
	avgDeltaBase := 0.0

	if avgStr != "" {
		v, _, err := ParseRel(avgStr, "平均成本")
		if err != nil {
			return nil, err
		}
		avgDeltaDisp = v
		avgDeltaBase = Round(avgDeltaDisp/fDisp, 6)
		moves = append(moves, pending{moveType: "avg", amount: avgDeltaBase})
		parts = append(parts, fmt.Sprintf("均价%+g元/%s", avgDeltaDisp, du))
	}

	ucDeltaBase := 0.0
	if ucStr != "" {
		v, _, err := ParseRel(ucStr, "成本单价")
		if err != nil {
			return nil, err
		}
		ucDeltaDisp = v
		ucDeltaBase = Round(ucDeltaDisp/fDisp, 6)
		nv := p.UnitCost + ucDeltaBase
		if nv < 0 {
			nv = 0
		}
		if _, err := q.ExecContext(ctx, "UPDATE products SET unit_cost = ? WHERE id = ?", Round(nv, 6), p.ID); err != nil {
			return nil, err
		}
		moves = append(moves, pending{moveType: "ucost", amount: Round(ucDeltaBase, 6)})
		parts = append(parts, fmt.Sprintf("成本单价%+g元/%s", ucDeltaDisp, du))
	}

	if qtyStr != "" {
		v, _, err := ParseRel(qtyStr, "调整数量")
		if err != nil {
			return nil, err
		}
		deltaDisp = v
		unit := in.Unit
		if strings.TrimSpace(unit) == "" {
			unit = du
		}
		f := p.Factor(unit)
		deltaBase := Round(deltaDisp*f, 6)
		// 盘盈金额按「保持均价不变」入账：amount = 目标均价×调整后库存 − 现库存价值，
		// 否则负库存（价值被截到 0）时盘盈会把均价抬高。
		amount := 0.0
		if deltaBase > 0 {
			s0 := p.Stock
			veff := p.StockValue
			aeff := p.AvgCost
			if avgStr != "" {
				aeff += avgDeltaBase
				if s0 > 0 {
					veff += s0 * avgDeltaBase
				}
			}
			ns := s0 + deltaBase
			if ns > 0 {
				amount = Round(aeff*ns-veff, 2)
			}
		}
		remark := ""
		if reason != "" {
			remark = "盘点调整：" + reason
		}
		moves = append(moves, pending{moveType: "adjust", qty: deltaBase, amount: amount, remark: remark})
	}

	var ids []int
	for _, m := range moves {
		res, err := q.ExecContext(ctx,
			"INSERT INTO stock_movements (product_id, move_type, quantity_base, amount, ref_type, ref_id, line_id, date, operator, remark, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
			p.ID, m.moveType, m.qty, m.amount, "manual", nil, nil, in.Date, op, m.remark, NowDB())
		if err != nil {
			return nil, err
		}
		id64, err := res.LastInsertId()
		if err != nil {
			return nil, err
		}
		ids = append(ids, int(id64))
	}
	if len(ids) == 0 {
		return map[string]any{"ok": true, "adjusted": false, "unit": du, "stock": p.Stock,
			"display": Round(p.Stock/fDisp, 4), "message": "未产生调整流水"}, nil
	}
	groupID := ids[0]
	fallback := "盘点调整"
	if len(parts) > 0 {
		fallback = "盘点调整：" + strings.Join(parts, ", ")
	}
	if reason != "" {
		fallback = "盘点调整：" + reason
	}
	for _, id := range ids {
		if _, err := q.ExecContext(ctx, "UPDATE stock_movements SET ref_id = ?, remark = CASE WHEN remark = '' THEN ? ELSE remark END WHERE id = ?", groupID, fallback, id); err != nil {
			return nil, err
		}
	}
	if err := RecomputeProduct(ctx, q, p.ID); err != nil {
		return nil, err
	}
	out, err := GetProduct(ctx, q, p.ID)
	if err != nil {
		return nil, err
	}
	var msgParts []string
	if qtyStr != "" {
		msgParts = append(msgParts, fmt.Sprintf("库存%+.6g %s", deltaDisp, du))
	}
	if avgStr != "" {
		msgParts = append(msgParts, fmt.Sprintf("均价%+g元/%s", avgDeltaDisp, du))
	}
	if ucStr != "" {
		msgParts = append(msgParts, fmt.Sprintf("成本单价%+g元/%s", ucDeltaDisp, du))
	}
	msg := "调整成功：" + strings.Join(msgParts, "；") + fmt.Sprintf("（当前 %s %s，均价 %s元/%s）",
		FmtQty(Round(out.Stock/fDisp, 6)), du, FmtQty(Round(out.AvgCost*fDisp, 4)), du)
	res := map[string]any{"ok": true, "adjusted": true, "adjustment_id": groupID,
		"quantity": deltaDisp, "unit": du, "stock": out.Stock, "display": Round(out.Stock/fDisp, 4),
		"avg_cost": Round(out.AvgCost*fDisp, 4), "unit_cost": Round(out.UnitCost*fDisp, 4), "message": msg}
	if avgStr != "" {
		res["avg_cost_delta"] = Round(avgDeltaDisp, 4)
	} else {
		res["avg_cost_delta"] = 0
	}
	if ucStr != "" {
		res["unit_cost_delta"] = Round(ucDeltaDisp, 4)
	} else {
		res["unit_cost_delta"] = 0
	}
	return res, nil
}

// ListAdjustments 盘点调整记录：按分组汇总，供「谁在什么时候盘了多少」以及一键回退。
func ListAdjustments(ctx context.Context, q Querier, productID int, dateFrom, dateTo string) ([]map[string]any, error) {
	where := " WHERE ref_type = 'manual'"
	args := []any{}
	if dateFrom != "" {
		where += " AND date >= ?"
		args = append(args, dateFrom)
	}
	if dateTo != "" {
		where += " AND date <= ?"
		args = append(args, dateTo)
	}
	rows, err := q.QueryContext(ctx, "SELECT id, product_id, move_type, quantity_base, amount, date, operator, COALESCE(remark,''), COALESCE(ref_id,0), COALESCE(created_at,'') FROM stock_movements"+where+" ORDER BY COALESCE(ref_id,0) DESC, id", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type mv struct {
		id, pid, refID int
		moveType, date, operator, remark, createdAt string
		qty, amount float64
	}
	var all []mv
	for rows.Next() {
		var m mv
		if err := rows.Scan(&m.id, &m.pid, &m.moveType, &m.qty, &m.amount, &m.date, &m.operator, &m.remark, &m.refID, &m.createdAt); err != nil {
			return nil, err
		}
		all = append(all, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	groups := map[int][]mv{}
	var order []int
	for _, m := range all {
		if productID > 0 && m.pid != productID {
			continue
		}
		key := m.refID
		if key == 0 {
			key = m.id
		}
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], m)
	}
	// 旧式 cost 流水（整批价值增量）要还原「发生时的库存基数」才能反算单位均价
	basis := map[int]float64{}
	for _, gid := range order {
		pid := groups[gid][0].pid
		has := false
		for _, m := range groups[gid] {
			if m.moveType == "cost" {
				has = true
			}
		}
		if !has {
			continue
		}
		run := 0.0
		rs, err := q.QueryContext(ctx, "SELECT id, move_type, quantity_base FROM stock_movements WHERE product_id = ? ORDER BY id", pid)
		if err != nil {
			return nil, err
		}
		for rs.Next() {
			var id int
			var mt string
			var qb float64
			if err := rs.Scan(&id, &mt, &qb); err != nil {
				continue
			}
			if mt == "cost" {
				basis[id] = run
			}
			run += qb
		}
		rs.Close()
	}
	out := []map[string]any{}
	for _, gid := range order {
		ms := groups[gid]
		p, err := GetProduct(ctx, q, ms[0].pid)
		if err != nil {
			continue // 商品已删除的分组跳过
		}
		du := p.DisplayUnit()
		f := p.Factor(du)
		var qtyMove, costMove, ucMove *mv
		for i := range ms {
			switch ms[i].moveType {
			case "adjust":
				if qtyMove == nil {
					qtyMove = &ms[i]
				}
			case "avg", "cost":
				if costMove == nil {
					costMove = &ms[i]
				}
			case "ucost":
				if ucMove == nil {
					ucMove = &ms[i]
				}
			}
		}
		qtyDisp := 0.0
		if qtyMove != nil {
			qtyDisp = qtyMove.qty / f
		}
		costDelta := 0.0
		if costMove != nil {
			if costMove.moveType == "avg" {
				costDelta = costMove.amount * f
			} else if b := basis[costMove.id]; b > 0 {
				costDelta = costMove.amount / b * f
			}
		}
		ucDelta := 0.0
		if ucMove != nil {
			ucDelta = ucMove.amount * f
		}
		remark := ""
		switch {
		case qtyMove != nil:
			remark = qtyMove.remark
		case ucMove != nil:
			remark = ucMove.remark
		case costMove != nil:
			remark = costMove.remark
		}
		out = append(out, map[string]any{"id": gid, "product_id": p.ID, "product_name": p.Name, "unit": du,
			"quantity": Round(qtyDisp, 4), "avg_cost_delta": Round(costDelta, 4), "unit_cost_delta": Round(ucDelta, 4),
			"date": ms[0].date, "operator": ms[0].operator, "remark": remark, "created_at": trimStamp(ms[0].createdAt)})
	}
	return out, nil
}

// trimStamp SQLite 的 datetime 可能带微秒，接口只到秒。
func trimStamp(s string) string {
	s = NormalizeStamp(s)
	if len(s) > 19 {
		return s[:19]
	}
	return s
}

// DeleteAdjustment 回退一次盘点调整：反向抵消参考成本、删除这批流水、重算受影响商品。
func DeleteAdjustment(ctx context.Context, q Querier, gid int) (int, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, product_id, move_type, amount FROM stock_movements WHERE ref_type = 'manual' AND (ref_id = ? OR (ref_id IS NULL AND id = ?))", gid, gid)
	if err != nil {
		return 0, err
	}
	type row struct {
		id, pid int
		mt      string
		amount  float64
	}
	var moves []row
	for rows.Next() {
		var m row
		if err := rows.Scan(&m.id, &m.pid, &m.mt, &m.amount); err == nil {
			moves = append(moves, m)
		}
	}
	rows.Close()
	if len(moves) == 0 {
		return 0, Err404("盘点调整记录不存在")
	}
	affected := map[int]bool{}
	for _, m := range moves {
		affected[m.pid] = true
		if m.mt == "ucost" && m.amount != 0 {
			if pu, err := GetProduct(ctx, q, m.pid); err == nil {
				nv := pu.UnitCost - m.amount
				if nv < 0 {
					nv = 0
				}
				if _, err := q.ExecContext(ctx, "UPDATE products SET unit_cost = ? WHERE id = ?", Round(nv, 6), m.pid); err != nil {
					return 0, err
				}
			}
		}
	}
	for _, m := range moves {
		if _, err := q.ExecContext(ctx, "DELETE FROM stock_movements WHERE id = ?", m.id); err != nil {
			return 0, err
		}
	}
	for pid := range affected {
		if err := RecomputeProduct(ctx, q, pid); err != nil {
			return 0, err
		}
	}
	return len(moves), nil
}

// AbsFloat 绝对值（避免在 handler 里引 math）。
func AbsFloat(v float64) float64 { return math.Abs(v) }
