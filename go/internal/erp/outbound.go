package erp

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ---------------- 出库（销售）单：读 + 写 + 删 ----------------

// Outbound 出库单主表。
type Outbound struct {
	ID           int
	Code         string
	ImportGroup  string
	PackRuleID   *int
	PackRuleName string
	Customer     string
	Operator     string
	Date         string
	Remark       string
	TotalAmount  float64
	AdjustAmount float64
	TotalCOGS    float64
	TotalFee     float64
	SettleIncome float64
	SettleCats   string
	BrushCost    float64
	BrushFee     float64
	BrushAutoFee float64
	PayStatus    string
	PaidAt       string
}

// OutboundLine 出库明细行（line_type：sale 销售行 / pack 关联结算行）。
type OutboundLine struct {
	ID            int
	OutboundID    int
	ProductID     int
	LineType      string
	SaleProductID *int
	Spec          string
	Unit          string
	Quantity      float64
	QuantityBase  float64
	UnitPrice     float64
	Amount        float64
	COGS          float64
	GrossSales    float64
	PackFee       float64
	IsDropship    bool
}

const outboundColumns = "id, code, import_group, pack_rule_id, pack_rule_name, customer, operator, date, remark, " +
	"total_amount, total_cogs, total_fee, pay_status, paid_at, adjust_amount, brush_cost, brush_fee, brush_auto_fee, settle_income, settle_cats"

func scanOutbound(scan func(dest ...any) error) (*Outbound, error) {
	var o Outbound
	var importGroup, packRuleName, payStatus, paidAt, settleCats sql.NullString
	var packRuleID sql.NullInt64
	var adjust, brushCost, brushFee, brushAuto, settleIncome sql.NullFloat64
	err := scan(&o.ID, &o.Code, &importGroup, &packRuleID, &packRuleName, &o.Customer, &o.Operator, &o.Date, &o.Remark,
		&o.TotalAmount, &o.TotalCOGS, &o.TotalFee, &payStatus, &paidAt, &adjust, &brushCost, &brushFee, &brushAuto, &settleIncome, &settleCats)
	if err != nil {
		return nil, err
	}
	o.ImportGroup = importGroup.String
	o.PackRuleName = packRuleName.String
	if packRuleID.Valid {
		v := int(packRuleID.Int64)
		o.PackRuleID = &v
	}
	o.PayStatus = payStatus.String
	if o.PayStatus == "" {
		o.PayStatus = "paid"
	}
	o.PaidAt = paidAt.String
	o.AdjustAmount = adjust.Float64
	o.BrushCost = brushCost.Float64
	o.BrushFee = brushFee.Float64
	o.BrushAutoFee = brushAuto.Float64
	o.SettleIncome = settleIncome.Float64
	o.SettleCats = settleCats.String
	return &o, nil
}

// GetOutbound 按 id 取出库单。
func GetOutbound(ctx context.Context, q Querier, id int) (*Outbound, error) {
	row := q.QueryRowContext(ctx, "SELECT "+outboundColumns+" FROM outbounds WHERE id = ?", id)
	o, err := scanOutbound(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return o, err
}

// GetOutboundLines 取出库明细（按 id 升序 = 销售行在前、关联结算行在后）。
func GetOutboundLines(ctx context.Context, q Querier, outboundID int) ([]*OutboundLine, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT id, outbound_id, product_id, COALESCE(line_type,'sale'), sale_product_id, spec, unit, quantity, quantity_base, "+
			"unit_price, amount, cogs, gross_sales, pack_fee, is_dropship FROM outbound_lines WHERE outbound_id = ? ORDER BY id", outboundID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*OutboundLine
	for rows.Next() {
		var l OutboundLine
		var saleProductID sql.NullInt64
		var spec sql.NullString
		var gross sql.NullFloat64
		var dropship sql.NullInt64
		if err := rows.Scan(&l.ID, &l.OutboundID, &l.ProductID, &l.LineType, &saleProductID, &spec, &l.Unit,
			&l.Quantity, &l.QuantityBase, &l.UnitPrice, &l.Amount, &l.COGS, &gross, &l.PackFee, &dropship); err != nil {
			return nil, err
		}
		if saleProductID.Valid {
			v := int(saleProductID.Int64)
			l.SaleProductID = &v
		}
		l.Spec = spec.String
		l.GrossSales = gross.Float64
		l.IsDropship = dropship.Int64 != 0
		out = append(out, &l)
	}
	return out, rows.Err()
}

// OutboundLinesByIDs 一次取多张单的明细行（列表接口避免 N+1：每单两条查询在万单级会放大到几十条 SQL）。
func OutboundLinesByIDs(ctx context.Context, q Querier, ids []int) (map[int][]*OutboundLine, error) {
	out := map[int][]*OutboundLine{}
	ids = UniqueInts(ids)
	if len(ids) == 0 {
		return out, nil
	}
	for _, part := range Chunk(ids, 400) {
		rows, err := q.QueryContext(ctx,
			"SELECT id, outbound_id, product_id, COALESCE(line_type,'sale'), sale_product_id, spec, unit, quantity, quantity_base, "+
				"unit_price, amount, cogs, gross_sales, pack_fee, is_dropship FROM outbound_lines WHERE outbound_id IN ("+Placeholders(len(part))+") ORDER BY outbound_id, id", ToArgs(part)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var l OutboundLine
			var saleProductID sql.NullInt64
			var spec sql.NullString
			var gross sql.NullFloat64
			var dropship sql.NullInt64
			if err := rows.Scan(&l.ID, &l.OutboundID, &l.ProductID, &l.LineType, &saleProductID, &spec, &l.Unit,
				&l.Quantity, &l.QuantityBase, &l.UnitPrice, &l.Amount, &l.COGS, &gross, &l.PackFee, &dropship); err != nil {
				rows.Close()
				return nil, err
			}
			if saleProductID.Valid {
				v := int(saleProductID.Int64)
				l.SaleProductID = &v
			}
			l.Spec = spec.String
			l.GrossSales = gross.Float64
			l.IsDropship = dropship.Int64 != 0
			out[l.OutboundID] = append(out[l.OutboundID], &l)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

// ListOutbounds 出库明细（按 id 倒序）；可按日期区间与导入批次（逗号分隔）过滤。
func ListOutbounds(ctx context.Context, q Querier, dateFrom, dateTo, groups string) ([]*Outbound, error) {
	where := " WHERE 1=1"
	args := []any{}
	if dateFrom != "" {
		where += " AND date >= ?"
		args = append(args, dateFrom)
	}
	if dateTo != "" {
		where += " AND date <= ?"
		args = append(args, dateTo)
	}
	if groups != "" {
		parts := []string{}
		for _, g := range strings.Split(groups, ",") {
			if g = strings.TrimSpace(g); g != "" {
				parts = append(parts, g)
			}
		}
		if len(parts) > 0 {
			ph := make([]string, len(parts))
			for i, g := range parts {
				ph[i] = "?"
				args = append(args, g)
			}
			where += " AND import_group IN (" + strings.Join(ph, ",") + ")"
		}
	}
	rows, err := q.QueryContext(ctx, "SELECT "+outboundColumns+" FROM outbounds"+where+" ORDER BY id DESC", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Outbound
	for rows.Next() {
		o, err := scanOutbound(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// ProductBrief 商品名/类别（出库明细展示用）。
type ProductBrief struct {
	Name     string
	Category string
}

// BriefsOf 一次性取多个商品的名称与类别（替代 ORM 的 lazy load）。
func BriefsOf(ctx context.Context, q Querier, ids []int) (map[int]ProductBrief, error) {
	ids = UniqueInts(ids)
	out := map[int]ProductBrief{}
	if len(ids) == 0 {
		return out, nil
	}
	for _, part := range Chunk(ids, 400) {
		rows, err := q.QueryContext(ctx,
			"SELECT id, name, category FROM products WHERE id IN ("+Placeholders(len(part))+")", ToArgs(part)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int
			var name, category sql.NullString
			if err := rows.Scan(&id, &name, &category); err == nil {
				out[id] = ProductBrief{Name: name.String, Category: category.String}
			}
		}
		rows.Close()
	}
	return out, nil
}

// OutboundJSON 与 Python routers/outbound.py 的 _to_dict 字段完全一致。
func OutboundJSON(o *Outbound, lines []*OutboundLine, briefs map[int]ProductBrief) map[string]any {
	remark := o.Remark
	isMulti := strings.Contains(remark, "一单多货")
	multiRule := o.PackRuleName
	if multiRule == "" && strings.Contains(remark, "一单多货·规则：") {
		multiRule = strings.SplitN(remark, "一单多货·规则：", 2)[1]
		if k := strings.Index(multiRule, "）"); k >= 0 {
			multiRule = multiRule[:k]
		}
	}
	settleIncome := Round(o.SettleIncome, 2)
	// 实收金额 = 销售收入 + 抹零/凑整 + 客户代收的关联结算
	brushFinal := Round(o.TotalAmount+Round(o.AdjustAmount, 2)+settleIncome, 2)
	adj := BrushAdjust(o)
	brushFeeOf := BrushFeeOf(o)
	saleNames := map[int]string{}
	for _, l := range lines {
		if l.LineType == "sale" {
			saleNames[l.ProductID] = briefs[l.ProductID].Name
		}
	}
	lineJSON := make([]map[string]any, 0, len(lines))
	hasDropship := false
	for _, l := range lines {
		brief := briefs[l.ProductID]
		isLabor := brief.Category == "人工" || strings.HasSuffix(strings.TrimSpace(brief.Name), "打包")
		salePID := AsInt(l.SaleProductID)
		var saleName any = ""
		if l.SaleProductID != nil {
			saleName = saleNames[*l.SaleProductID]
		}
		lineJSON = append(lineJSON, map[string]any{
			"product_id": l.ProductID, "product_name": brief.Name, "line_type": l.LineType,
			"sale_product_id": salePID, "sale_product_name": saleName,
			"spec": NullToEmpty(l.Spec), "is_dropship": l.IsDropship,
			"unit": l.Unit, "quantity": l.Quantity, "quantity_base": l.QuantityBase,
			"unit_price": l.UnitPrice, "amount": l.Amount, "cogs": l.COGS,
			"gross_sales": Round(l.GrossSales, 6), "pack_fee": l.PackFee,
			"category": brief.Category, "is_labor": isLabor,
		})
		if l.IsDropship {
			hasDropship = true
		}
	}
	return map[string]any{
		"id": o.ID, "code": o.Code, "import_group": o.ImportGroup,
		"pack_rule_id": AsInt(o.PackRuleID), "pack_rule_name": o.PackRuleName,
		"customer": o.Customer, "operator": o.Operator, "date": o.Date, "remark": remark,
		"is_multi": isMulti, "multi_rule": multiRule,
		"total_amount": o.TotalAmount, "adjust_amount": Round(o.AdjustAmount, 2),
		"settle_income": settleIncome, "settle_cats": o.SettleCats,
		"final_amount": brushFinal, "total_cogs": o.TotalCOGS, "total_fee": o.TotalFee,
		"pay_status": o.PayStatus, "paid_at": o.PaidAt,
		"gross_profit": Round(brushFinal-o.TotalCOGS-adj, 2),
		"net_profit":   Round(brushFinal-o.TotalCOGS-o.TotalFee-adj, 2),
		"brush_cost":   Round(o.BrushCost, 2), "brush_fee": Round(brushFeeOf, 2),
		"brush_auto_fee": Round(o.BrushAutoFee, 2),
		"is_brush_order": o.BrushAutoFee != 0,
		"brush_adjust":   adj,
		"settle_amount":  Round(brushFinal-brushFeeOf, 2),
		"brush_profit":   Round(brushFinal-brushFeeOf-o.BrushCost, 2),
		"has_dropship":   hasDropship,
		"lines":          lineJSON,
	}
}

// NullToEmpty 把 SQL NULL 字符串转空串。
func NullToEmpty(s string) string { return s }

// ---------------- 创建 ----------------

// CreateOutbound 创建出库/销售单（明细、库存流水、财务记录、成本重算）。
// deferRecompute=true 时不重算商品，只把受影响商品 id 返回给调用方（批量导入整批只算一次）。
func CreateOutbound(ctx context.Context, q Querier, payload map[string]any, operator string,
	importGroup string, allowSelfStock bool, deferRecompute bool) (*Outbound, []string, []int, error) {

	// 空行列表不拒绝：与 Python 一致，允许开出一张 0 元单（前端「先建单后补明细」的用法）
	linesRaw := MapSlice(payload["lines"])
	extra := MapSlice(payload["extra_pack_lines"])
	settleProvided := HasKey(payload, "settle_cats") && payload["settle_cats"] != nil
	autoExpress := true
	if v, ok := payload["auto_express"]; ok {
		autoExpress = ToBool(v)
	}
	// 芳谊放单仓刷单结算：只有放单仓的单子记这三列；brush_auto_fee 由服务端自己算，不信任前端传值。
	// 同一 face 还决定 build_order 是否自动带出关联结算行（刷单不带包材/人工/快递）。
	brush := IsBrushWarehouse(ToStr(payload["warehouse"]))
	in := BuildInput{
		Lines: linesRaw, PackLines: MapSlice(payload["pack_lines"]), FeeTotal: OptFloat(payload, "pack_fee_total"),
		AutoExpress: autoExpress, AllowSelfStock: allowSelfStock, ExtraPackLines: extra,
		SettleCats: payload["settle_cats"], SettleProvided: settleProvided, Brush: brush,
	}
	order, err := BuildOrder(ctx, q, in)
	if err != nil {
		return nil, nil, nil, err
	}
	op := strings.TrimSpace(ToStr(payload["operator"]))
	if op == "" {
		op = operator
	}
	// 对齐 Python：OutboundIn.date 只是「必填」，Pydantic 不校验格式（格式校验只在 PUT 里做）。
	// 缺字段 Python 走 422，这里按 400 拒收；空串/非法日期则原样接受，避免同一请求两边结果不同。
	rawDate, hasDate := payload["date"]
	if !hasDate {
		return nil, nil, nil, ErrText("字段 'date' 缺失")
	}
	date := strings.TrimSpace(ToStr(rawDate))
	adjust := Round(ToFloat(payload["adjust_amount"]), 2)
	pay := PayFields(payload, date)

	brushAutoFee := 0.0
	if brush {
		brushAutoFee = Round(ToFloat(order["pack_cogs"])+ToFloat(order["total_fee"]), 2)
	}
	brushCost, brushFee := 0.0, 0.0
	if brush {
		brushCost = Round(ToFloat(payload["brush_cost"]), 2)
		brushFee = Round(ToFloat(payload["brush_fee"]), 2)
	}
	code, err := GenOutboundCode(ctx, q, date)
	if err != nil {
		return nil, nil, nil, err
	}
	var packRuleID *int
	if v := OptInt(payload, "pack_rule_id"); v != nil && *v > 0 {
		packRuleID = v
	}
	rec := &Outbound{
		Code: code, ImportGroup: importGroup, PackRuleID: packRuleID,
		PackRuleName: strings.TrimSpace(ToStr(payload["pack_rule_name"])),
		Customer:     strings.TrimSpace(ToStr(payload["customer"])),
		Operator:     op, Date: date, Remark: strings.TrimSpace(ToStr(payload["remark"])),
		TotalAmount:  ToFloat(order["total_amount"]), AdjustAmount: adjust,
		TotalCOGS: ToFloat(order["total_cogs"]), TotalFee: ToFloat(order["total_fee"]),
		SettleIncome: ToFloat(order["settle_income"]), SettleCats: ToStr(order["settle_cats"]),
		BrushCost: brushCost, BrushFee: brushFee, BrushAutoFee: brushAutoFee,
		PayStatus: pay.PayStatus, PaidAt: pay.PaidAt,
	}
	res, err := q.ExecContext(ctx,
		"INSERT INTO outbounds (code, import_group, pack_rule_id, pack_rule_name, customer, operator, date, remark, total_amount, "+
			"adjust_amount, total_cogs, total_fee, settle_income, settle_cats, brush_cost, brush_fee, brush_auto_fee, pay_status, paid_at, created_at) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		rec.Code, rec.ImportGroup, AsInt(rec.PackRuleID), rec.PackRuleName, rec.Customer, rec.Operator, rec.Date, rec.Remark,
		rec.TotalAmount, rec.AdjustAmount, rec.TotalCOGS, rec.TotalFee, rec.SettleIncome, rec.SettleCats,
		rec.BrushCost, rec.BrushFee, rec.BrushAutoFee, rec.PayStatus, rec.PaidAt, nowDB())
	if err != nil {
		return nil, nil, nil, err
	}
	id64, err := res.LastInsertId()
	if err != nil {
		return nil, nil, nil, err
	}
	rec.ID = int(id64)

	allRows := append(append([]map[string]any{}, MapSlice(order["sale_lines"])...), MapSlice(order["pack_lines"])...)
	affected := map[int]bool{}
	affectedList := []int{}
	addAffected := func(pid int) {
		if pid == 0 || affected[pid] {
			return
		}
		affected[pid] = true
		affectedList = append(affectedList, pid)
	}

	for _, r := range allRows {
		isSale := ToStr(r["line_type"]) == "sale"
		dropship := isSale && ToBool(r["is_dropship"])
		noStock := ToBool(r["no_stock"]) // 刷单单：本仓不出货也不耗包材，只进台账
		line := &OutboundLine{
			OutboundID: rec.ID, ProductID: ToInt(r["product_id"]), LineType: ToStr(r["line_type"]),
			Spec: ToStr(r["spec"]), Unit: ToStr(r["unit"]), Quantity: ToFloat(r["quantity"]),
			QuantityBase: ToFloat(r["quantity_base"]), UnitPrice: ToFloat(r["unit_price"]),
			Amount: ToFloat(r["amount"]), COGS: ToFloat(r["cogs"]), GrossSales: ToFloat(r["gross_sales"]),
			PackFee: ToFloat(r["pack_fee"]), IsDropship: dropship,
		}
		if v := AsAnyInt(r["sale_product_id"]); v != nil {
			pid := ToInt(v)
			line.SaleProductID = &pid
		}
		lres, err := q.ExecContext(ctx,
			"INSERT INTO outbound_lines (outbound_id, product_id, line_type, sale_product_id, spec, unit, quantity, quantity_base, "+
				"unit_price, amount, cogs, gross_sales, pack_fee, is_dropship) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			line.OutboundID, line.ProductID, line.LineType, AsInt(line.SaleProductID), line.Spec, line.Unit, line.Quantity,
			line.QuantityBase, line.UnitPrice, line.Amount, line.COGS, line.GrossSales, line.PackFee, b2i(line.IsDropship))
		if err != nil {
			return nil, nil, nil, err
		}
		lineID64, err := lres.LastInsertId()
		if err != nil {
			return nil, nil, nil, err
		}
		line.ID = int(lineID64)

		if !dropship && !noStock { // 代发/刷单：本仓不出货，不产生库存流水（否则会把库存扣成负数）
			if isSale {
				// 库存流水扣在库存商品（大类）上：关联多个则逐个扣减，每条流水回指本行
				type moveItem struct {
					pid    int
					qty    float64
					amount float64
				}
				var items []moveItem
				deds := MapSlice(r["deductions"])
				for _, d := range deds {
					items = append(items, moveItem{ToInt(d["product_id"]), -ToFloat(d["deduction_base"]), ToFloat(d["cogs"])})
				}
				if len(items) == 0 {
					items = append(items, moveItem{ToInt(r["stock_product_id"]), -ToFloat(r["deduction_base"]), ToFloat(r["cogs"])})
				}
				for _, it := range items {
					if err := insertMovement(ctx, q, it.pid, "out", it.qty, it.amount, "outbound", rec.ID, &line.ID, date, op, "销售 "+rec.Code); err != nil {
						return nil, nil, nil, err
					}
					addAffected(it.pid)
				}
			} else {
				// 人工/快递等服务类记为正向工作量（不扣库存）；包材等仍为负向包装消耗
				p, err := GetProduct(ctx, q, ToInt(r["product_id"]))
				isService := err == nil && (p.Category == "人工" || p.Category == "快递")
				moveQty := ToFloat(r["quantity_base"])
				moveType := "pack_out"
				if isService {
					moveType = "work"
				} else {
					moveQty = -moveQty
				}
				if err := insertMovement(ctx, q, ToInt(r["product_id"]), moveType, moveQty, ToFloat(r["cogs"]), "outbound", rec.ID, &line.ID, date, op, "包装消耗 "+rec.Code); err != nil {
					return nil, nil, nil, err
				}
				addAffected(ToInt(r["product_id"]))
			}
		}
		addAffected(line.ProductID)
		if isSale && line.Amount > 0 {
			if err := insertFinance(ctx, q, "income", "销售收入", line.ProductID, line.Amount, date, op, "销售 "+rec.Code, "outbound", rec.ID, pay); err != nil {
				return nil, nil, nil, err
			}
		}
	}
	if ToFloat(order["total_fee"]) > 0 {
		if err := insertFinance(ctx, q, "expense", "人工打包费", 0, ToFloat(order["total_fee"]), date, op, "打包费 "+rec.Code, "outbound", rec.ID, pay); err != nil {
			return nil, nil, nil, err
		}
	}
	if err := SyncAdjustExpense(ctx, q, "outbound", rec.ID, rec.Code, date, op, adjust, pay); err != nil {
		return nil, nil, nil, err
	}
	if err := SyncSettleIncomeRecord(ctx, q, rec, date, op, pay); err != nil {
		return nil, nil, nil, err
	}
	if err := SyncDropshipBills(ctx, q, rec, MapSlice(order["sale_lines"])); err != nil {
		return nil, nil, nil, err
	}
	warnings := []string{}
	for _, w := range MapSliceNil(order["warnings"]) {
		warnings = append(warnings, w)
	}
	if !deferRecompute {
		for _, pid := range affectedList {
			if err := RecomputeProduct(ctx, q, pid); err != nil {
				return nil, nil, nil, err
			}
		}
		affectedList = nil
	}
	return rec, warnings, affectedList, nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func insertMovement(ctx context.Context, q Querier, productID int, moveType string, qty, amount float64,
	refType string, refID int, lineID *int, date, operator, remark string) error {
	_, err := q.ExecContext(ctx,
		"INSERT INTO stock_movements (product_id, move_type, quantity_base, amount, ref_type, ref_id, line_id, date, operator, remark, created_at) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?,?)",
		productID, moveType, qty, amount, refType, refID, AsInt(lineID), date, operator, remark, nowDB())
	return err
}

func insertFinance(ctx context.Context, q Querier, typ, category string, productID int, amount float64,
	date, operator, remark, refType string, refID int, pay Pay) error {
	var pid any
	if productID > 0 {
		pid = productID
	}
	_, err := q.ExecContext(ctx,
		"INSERT INTO finance_records (type, category, product_id, amount, date, operator, remark, ref_type, ref_id, created_at, pay_status, paid_at) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
		typ, category, pid, amount, date, operator, remark, refType, refID, nowDB(), pay.PayStatus, pay.PaidAt)
	return err
}

// MapSliceNil 把 []any 里的字符串取出来（warnings）。
func MapSliceNil(v any) []string {
	arr, ok := v.([]any)
	if ok {
		out := make([]string, 0, len(arr))
		for _, it := range arr {
			if s, ok2 := it.(string); ok2 {
				out = append(out, s)
			}
		}
		return out
	}
	if s, ok2 := v.([]string); ok2 {
		return s
	}
	return nil
}

// ---------------- 修改 ----------------

// UpdateOutboundIn 手动修改出库单：只允许改 客户 / 日期 / 付款状态 / 实收口径（其余字段须删除重建）。
type UpdateOutboundIn struct {
	Customer   string
	Date       string
	PayStatus  string
	SettleCats any
	HasSettle  bool
}

// UpdateOutbound 修改出库单；「实收含哪些关联结算」可改，只动实收/报表收入口径，成本与库存不变。
func UpdateOutbound(ctx context.Context, q Querier, id int, in UpdateOutboundIn, operator string) (*Outbound, error) {
	rec, err := GetOutbound(ctx, q, id)
	if err != nil {
		return nil, err
	}
	date := strings.TrimSpace(in.Date)
	if !ValidDate(date) {
		return nil, ErrText("日期格式应为 YYYY-MM-DD")
	}
	pay := PayFields(map[string]any{"pay_status": in.PayStatus}, date)
	rec.Customer = strings.TrimSpace(in.Customer)
	rec.Date = date
	rec.Operator = operator // 记录为后来的修改人（忽略前端传值）
	rec.PayStatus, rec.PaidAt = pay.PayStatus, pay.PaidAt

	if in.HasSettle {
		cats := NormalizeSettleCats(in.SettleCats, true)
		rec.SettleCats = strings.Join(cats, ",")
		lines, err := GetOutboundLines(ctx, q, id)
		if err != nil {
			return nil, err
		}
		ids := []int{}
		for _, l := range lines {
			ids = append(ids, l.ProductID)
		}
		briefs, err := BriefsOf(ctx, q, ids)
		if err != nil {
			return nil, err
		}
		amount := 0.0
		for _, l := range lines {
			if l.LineType != "pack" {
				continue
			}
			b := briefs[l.ProductID]
			if ContainsStr(cats, PackSettleCat(b.Category, b.Name)) {
				amount += l.COGS
			}
		}
		if ContainsStr(cats, SettleFeeCat) {
			amount += rec.TotalFee
		}
		rec.SettleIncome = Round(amount, 2)
		if _, err := q.ExecContext(ctx, "UPDATE outbounds SET customer = ?, date = ?, operator = ?, pay_status = ?, paid_at = ?, settle_income = ?, settle_cats = ? WHERE id = ?",
			rec.Customer, rec.Date, rec.Operator, rec.PayStatus, rec.PaidAt, rec.SettleIncome, rec.SettleCats, id); err != nil {
			return nil, err
		}
		if err := SyncSettleIncomeRecord(ctx, q, rec, date, operator, pay); err != nil {
			return nil, err
		}
	} else {
		if _, err := q.ExecContext(ctx, "UPDATE outbounds SET customer = ?, date = ?, operator = ?, pay_status = ?, paid_at = ? WHERE id = ?",
			rec.Customer, rec.Date, rec.Operator, rec.PayStatus, rec.PaidAt, id); err != nil {
			return nil, err
		}
	}
	return rec, SyncDocEdit(ctx, q, "outbound", id, date, operator, pay)
}

// ---------------- 删除 ----------------

// DeleteOutbound 删除出库单并清理明细/流水/财务/其他开支/代发账单，随后重算受影响商品。
func DeleteOutbound(ctx context.Context, q Querier, id int) error {
	deleted, missing, _, err := PurgeOutbounds(ctx, q, []int{id})
	if err != nil {
		return err
	}
	if deleted == 0 || missing > 0 {
		// 与 Python 一致：删不存在的出库单是 404「出库单不存在」，不能静默回 200
		return ErrNotFound
	}
	return nil
}

// PurgeOutbounds 批量删除出库单：查询与删除按批合并成常数次 SQL，受影响商品去重后只在最后各重算一次。
func PurgeOutbounds(ctx context.Context, q Querier, ids []int) (deleted int, missing int, affected []int, err error) {
	uniq := UniqueInts(ids)
	var existing []int
	affectedSet := map[int]bool{}
	affectedList := []int{}
	add := func(pid int) {
		if pid == 0 || affectedSet[pid] {
			return
		}
		affectedSet[pid] = true
		affectedList = append(affectedList, pid)
	}
	for _, part := range Chunk(uniq, 400) {
		args := ToArgs(part)
		rows, err := q.QueryContext(ctx, "SELECT id FROM outbounds WHERE id IN ("+Placeholders(len(part))+")", args...)
		if err != nil {
			return 0, 0, nil, err
		}
		for rows.Next() {
			var id int
			if err := rows.Scan(&id); err == nil {
				existing = append(existing, id)
			}
		}
		rows.Close()
		rows2, err := q.QueryContext(ctx, "SELECT product_id FROM outbound_lines WHERE outbound_id IN ("+Placeholders(len(part))+")", args...)
		if err != nil {
			return 0, 0, nil, err
		}
		for rows2.Next() {
			var pid int
			if err := rows2.Scan(&pid); err == nil {
				add(pid)
			}
		}
		rows2.Close()
		rows3, err := q.QueryContext(ctx, "SELECT product_id FROM stock_movements WHERE ref_type = 'outbound' AND ref_id IN ("+Placeholders(len(part))+")", args...)
		if err != nil {
			return 0, 0, nil, err
		}
		for rows3.Next() {
			var pid int
			if err := rows3.Scan(&pid); err == nil {
				add(pid)
			}
		}
		rows3.Close()
	}
	for _, part := range Chunk(existing, 400) {
		ph := Placeholders(len(part))
		args := ToArgs(part)
		for _, stmt := range []string{
			"DELETE FROM stock_movements WHERE ref_type = 'outbound' AND ref_id IN (" + ph + ")",
			"DELETE FROM finance_records WHERE ref_type = 'outbound' AND ref_id IN (" + ph + ")",
			"DELETE FROM other_expenses WHERE ref_type = 'outbound' AND ref_id IN (" + ph + ")",
			"DELETE FROM dropship_bills WHERE outbound_id IN (" + ph + ")",
			"DELETE FROM outbound_lines WHERE outbound_id IN (" + ph + ")",
			"DELETE FROM outbounds WHERE id IN (" + ph + ")",
		} {
			if _, err := q.ExecContext(ctx, stmt, args...); err != nil {
				return 0, 0, nil, err
			}
		}
	}
	for _, pid := range affectedList {
		if err := RecomputeProduct(ctx, q, pid); err != nil {
			return 0, 0, nil, err
		}
	}
	return len(existing), len(uniq) - len(existing), affectedList, nil
}

var _ = fmt.Sprintf

