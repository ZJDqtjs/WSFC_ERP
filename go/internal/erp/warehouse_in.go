package erp

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// 本文件是「入仓」台账（入仓品资料 + 入仓记录）的业务层，口径逐条对齐 Python routers/warehouse_in.py：
//   - 收入 = 数量 × 采购价 × (1 − 入仓品扣点%)
//   - 商品成本 = 数量 × 每袋商品成本；每袋成本：关联库存商品 = 每袋数量 × 库存单位成本（均价优先、回退参考成本），
//     未关联（代发）= 入仓品手填的「代发成本」
//   - 运费 = 数量 × 运费单价；毛利 = 收入 − 商品成本 − 运费 − 随货包材成本
//   - 随货包材按「每袋用量 × 袋数」以 FIFO 结转成本，落成库存流水（包材=pack_out，人工/快递=work）并重算商品

// WarehouseDeductionCategory 入仓品扣点类别名（统一在「扣点」页维护）。
const WarehouseDeductionCategory = "入仓品"

// WhNetWeightUnits 「每袋净重」可选单位 → 克（与成本口径的 _BASE_UNIT_GRAMS 同源）。
var WhNetWeightUnits = map[string]float64{"克": 1, "g": 1, "两": 50, "斤": 500, "公斤": 1000, "千克": 1000, "kg": 1000}

// WhBaseUnitGrams 基础单位 → 克：只有按重量计的基础单位，才能把商品名里的规格换算成默认单位。
var WhBaseUnitGrams = WhNetWeightUnits

// WhNetWeightUnitChoices 前端下拉框用的单位（去掉 g/kg/千克 等别名）。
var WhNetWeightUnitChoices = []string{"克", "两", "斤", "公斤"}

// WhDefaultSheet 未显式指定工作表时的默认贴单表（常温品）。
const WhDefaultSheet = "常温贴单"

// WhSheetKeyword 表名兜底关键字。
const WhSheetKeyword = "贴单"

// WhWarehouseSheet 分仓 → 贴单表（一个仓对应一个温层）。
var WhWarehouseSheet = map[string]string{"wh02": "冷冻贴单"}

// ---------------- 入仓品资料 ----------------

// WarehouseProduct 入仓品（按「袋」采购的备货商品），与库存商品 Product 解耦。
type WarehouseProduct struct {
	ID             int
	Name           string
	Category       string
	SKU            string
	Barcode        string
	BoxSpec        float64
	PurchasePrice  float64
	Freight        float64
	StockProductID *int
	BagWeight      float64
	ShelfLife      string
	Remark         string
	IsActive       bool
	PackItems      []map[string]any // 关联结算原始 JSON（product_id/quantity/unit）
	DropshipCost   float64
	BagNetWeight   float64
	BagNetUnit     string
}

const whProductColumns = `id, name, COALESCE(category,''), COALESCE(sku,''), COALESCE(barcode,''),
	COALESCE(box_spec,0), COALESCE(purchase_price,0), COALESCE(freight,0), stock_product_id,
	COALESCE(bag_weight,0), COALESCE(shelf_life,''), COALESCE(remark,''), COALESCE(is_active,1),
	pack_items, COALESCE(dropship_cost,0), COALESCE(bag_net_weight,0), COALESCE(bag_net_unit,'')`

func scanWarehouseProduct(scan func(dest ...any) error) (*WarehouseProduct, error) {
	var p WarehouseProduct
	var stockID sql.NullInt64
	var packItems sql.NullString
	err := scan(&p.ID, &p.Name, &p.Category, &p.SKU, &p.Barcode, &p.BoxSpec, &p.PurchasePrice, &p.Freight,
		&stockID, &p.BagWeight, &p.ShelfLife, &p.Remark, &p.IsActive, &packItems, &p.DropshipCost,
		&p.BagNetWeight, &p.BagNetUnit)
	if err != nil {
		return nil, err
	}
	if stockID.Valid {
		v := int(stockID.Int64)
		p.StockProductID = &v
	}
	p.PackItems = MapSlice(decodeJSONAny(packItems.String))
	return &p, nil
}

// GetWarehouseProduct 按 id 取入仓品；不存在返回 ErrNotFound。
func GetWarehouseProduct(ctx context.Context, q Querier, id int) (*WarehouseProduct, error) {
	row := q.QueryRowContext(ctx, "SELECT "+whProductColumns+" FROM warehouse_products WHERE id = ?", id)
	p, err := scanWarehouseProduct(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// ListWarehouseProducts 入仓品全量（按 id 升序，同 Python 的 order_by(WarehouseProduct.id)）。
func ListWarehouseProducts(ctx context.Context, q Querier) ([]*WarehouseProduct, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+whProductColumns+" FROM warehouse_products ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*WarehouseProduct
	for rows.Next() {
		p, err := scanWarehouseProduct(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ---------------- 成本口径 ----------------

// WhStockInfo 库存商品 + 单位成本（库存均价优先，无库存回退参考成本），
// 返回 (库存商品, 基础单位成本, 默认单位换算系数, 默认单位成本)，口径同 Python _stock_info。
func WhStockInfo(ctx context.Context, q Querier, stockProductID *int) (*Product, float64, float64, float64, error) {
	if stockProductID == nil || *stockProductID == 0 {
		return nil, 0, 1, 0, nil
	}
	sp, err := GetProduct(ctx, q, *stockProductID)
	if errors.Is(err, ErrNotFound) {
		return nil, 0, 1, 0, nil
	} else if err != nil {
		return nil, 0, 1, 0, err
	}
	baseCost := sp.UnitCost
	if sp.AvgCost > 0 {
		baseCost = sp.AvgCost
	}
	factor := sp.Factor(sp.DisplayUnit())
	return sp, baseCost, factor, baseCost * factor, nil
}

// WhStockDefaultUnit 库存商品的默认单位（空则回退基础单位）。
func WhStockDefaultUnit(sp *Product) string {
	if sp == nil {
		return ""
	}
	return sp.DisplayUnit()
}

// WhBagCost 每袋商品成本（元/袋）——成本口径的唯一入口，同 Python _goods_bag_cost：
//   - 关联了库存商品：净重 × 库存单位成本
//   - 未关联（代发）：入仓品手填的「代发成本」
func WhBagCost(p *WarehouseProduct, bagWeight, unitCost float64) float64 {
	if p != nil && (p.StockProductID == nil || *p.StockProductID == 0) {
		return Round(p.DropshipCost, 4)
	}
	return Round(bagWeight*unitCost, 4)
}

// WarehouseDeduction 入仓品采购价（收入）扣点百分比；未配置返回 0（不折算）。
func WarehouseDeduction(ctx context.Context, q Querier) (float64, error) {
	var percent float64
	err := q.QueryRowContext(ctx,
		"SELECT percent FROM deductions WHERE category = ? LIMIT 1", WarehouseDeductionCategory).Scan(&percent)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return percent, nil
}

// WhSheetFor 本分仓默认导入的贴单工作表名（供入仓页文案与导入预览使用）。
func WhSheetFor(whKey string) string {
	if p, ok := WhWarehouseSheet[strings.TrimSpace(whKey)]; ok {
		return p
	}
	return WhDefaultSheet
}

// WhProfitRate 毛利率（%）= 毛利 ÷ 收入；收入为 0 时返回 0，避免除零。
func WhProfitRate(profit, amount float64) float64 {
	if amount == 0 {
		return 0
	}
	return Round(profit/amount*100, 2)
}

// whDiv 每袋口径：整单金额 ÷ 袋数（数量为 0 时返回 0）。
func whDiv(total, qty float64, places int) float64 {
	if qty == 0 {
		return 0
	}
	return Round(total/qty, places)
}

// whStr 取字符串并去掉 null（Python 的 `x or ""`）。
func whStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ToStr(v)
}

// productNameOrEmpty / baseUnitOrEmpty 可空商品指针的展示回退。
func productNameOrEmpty(p *Product) string {
	if p == nil {
		return ""
	}
	return p.Name
}

func baseUnitOrEmpty(p *Product) string {
	if p == nil {
		return ""
	}
	return p.BaseUnit
}

// encodeWhList JSON 数组列写库（空一律存 "[]"，与 Python 的 default=list 一致）。
func encodeWhList(list []map[string]any) string {
	if len(list) == 0 {
		return "[]"
	}
	return EncodeJSONColumn(list)
}

// ---------------- 入仓品序列化 ----------------

// WarehouseProductJSON 字段与 Python _product_dict 逐一一致。
func WarehouseProductJSON(ctx context.Context, q Querier, p *WarehouseProduct) (map[string]any, error) {
	sp, _, _, unitCost, err := WhStockInfo(ctx, q, p.StockProductID)
	if err != nil {
		return nil, err
	}
	packItems := []map[string]any{}
	for _, it := range p.PackItems {
		row := map[string]any{
			"product_id": it["product_id"],
			"quantity":   it["quantity"],
			"unit":       whStr(it["unit"]),
			"name":       "",
			"category":   "",
		}
		if pid := ToInt(it["product_id"]); pid != 0 {
			mp, err := GetProduct(ctx, q, pid)
			if err == nil && mp != nil {
				row["name"], row["category"] = mp.Name, mp.Category
			} else if err != nil && !errors.Is(err, ErrNotFound) {
				return nil, err
			}
		}
		packItems = append(packItems, row)
	}
	bagNetUnit := p.BagNetUnit
	if bagNetUnit == "" {
		bagNetUnit = "克"
	}
	units := make([]string, len(WhNetWeightUnitChoices))
	copy(units, WhNetWeightUnitChoices)
	return map[string]any{
		"id": p.ID, "name": p.Name, "category": p.Category, "sku": p.SKU,
		"barcode": p.Barcode, "box_spec": p.BoxSpec,
		"purchase_price":   p.PurchasePrice,
		"freight":          p.Freight,
		"stock_product_id": AsInt(p.StockProductID),
		"stock_product_name": productNameOrEmpty(sp),
		"stock_base_unit":    baseUnitOrEmpty(sp),
		"stock_default_unit": WhStockDefaultUnit(sp),
		"stock_unit_cost":    Round(unitCost, 6),
		"bag_weight":         p.BagWeight,
		"bag_net_weight":     Round(p.BagNetWeight, 4),
		"bag_net_unit":       bagNetUnit,
		"net_weight_units":   units,
		"dropship_cost":      Round(p.DropshipCost, 4),
		"bag_cost":           WhBagCost(p, p.BagWeight, unitCost),
		"shelf_life":         p.ShelfLife, "remark": p.Remark, "is_active": p.IsActive,
		"pack_items": packItems,
	}, nil
}

// ---------------- 入仓品增删改 ----------------

// CleanWhPackItems 校验并规范化入仓品关联结算清单：商品必须存在、数量>0、单位有效，否则 400。
func CleanWhPackItems(ctx context.Context, q Querier, items []map[string]any) ([]map[string]any, error) {
	cleaned := []map[string]any{}
	for _, it := range items {
		pid := ToInt(it["product_id"])
		qty := ToFloat(it["quantity"])
		if pid == 0 || qty <= 0 {
			return nil, ErrText("关联结算清单存在无效行（商品/数量需完整且大于 0）")
		}
		p, err := GetProduct(ctx, q, pid)
		if errors.Is(err, ErrNotFound) {
			return nil, ErrText("关联结算商品ID %d 不存在", pid)
		} else if err != nil {
			return nil, err
		}
		unit := strings.TrimSpace(whStr(it["unit"]))
		if unit == "" {
			unit = p.DefaultUnit
		}
		if unit == "" {
			unit = p.BaseUnit
		}
		if unit == "" {
			unit = "个"
		}
		if _, ok := p.Conversions[unit]; !ok {
			return nil, ErrText("关联结算商品「%s」不支持单位「%s」", p.Name, unit)
		}
		cleaned = append(cleaned, map[string]any{"product_id": pid, "quantity": qty, "unit": unit})
	}
	return cleaned, nil
}

// whNetUnitOrDefault 净重单位只认重量单位，其它（含空）一律按「克」（同 ProductIn 的 field_validator）。
func whNetUnitOrDefault(v any) string {
	u := strings.TrimSpace(ToStr(v))
	if _, ok := WhNetWeightUnits[u]; ok {
		return u
	}
	return "克"
}

// warehouseProductFromBody 按 ProductIn 的字段与默认值构造入仓品（缺键/null → 模型默认值）。
func warehouseProductFromBody(name string, body map[string]any, packItems []map[string]any) *WarehouseProduct {
	p := &WarehouseProduct{
		Name:          name,
		Category:      whStr(body["category"]),
		SKU:           whStr(body["sku"]),
		Barcode:       whStr(body["barcode"]),
		BoxSpec:       whNum(body, "box_spec"),
		PurchasePrice: whNum(body, "purchase_price"),
		Freight:       whNum(body, "freight"),
		BagWeight:     whNum(body, "bag_weight"),
		BagNetWeight:  whNum(body, "bag_net_weight"),
		BagNetUnit:    whNetUnitOrDefault(body["bag_net_unit"]),
		DropshipCost:  whNum(body, "dropship_cost"),
		ShelfLife:     whStr(body["shelf_life"]),
		Remark:        whStr(body["remark"]),
		PackItems:     packItems,
	}
	if v, ok := body["is_active"]; !ok || v == nil {
		p.IsActive = true // Pydantic 默认 True
	} else {
		p.IsActive = ToBool(v)
	}
	if spid := OptInt(body, "stock_product_id"); spid != nil {
		p.StockProductID = spid
	}
	return p
}

// whNum 取数值字段（缺键/null → 0.0，与 Pydantic 的 float = 0.0 默认值一致）。
func whNum(body map[string]any, k string) float64 { return ToFloat(body[k]) }

// 入仓品/入仓记录的请求模型只声明这些字段：Pydantic 的 model_dump() 不会带上前端多传的键
// （如 code、paid_at），Go 必须同样先按声明字段过滤，否则 PayFields 会读到 Python 读不到的 paid_at。
var (
	whProductKeys = []string{
		"name", "category", "sku", "barcode", "box_spec", "purchase_price", "freight",
		"stock_product_id", "bag_weight", "bag_net_weight", "bag_net_unit", "dropship_cost",
		"shelf_life", "remark", "is_active", "pack_items",
	}
	whInboundCreateKeys = []string{
		"product_id", "product_name", "category", "unit", "purchase_no", "center", "quantity",
		"box_count", "box_spec", "unit_price", "freight", "bag_weight", "date", "operator",
		"remark", "pay_status",
	}
	whInboundUpdateKeys = []string{
		"product_id", "product_name", "category", "unit", "purchase_no", "center", "quantity",
		"box_count", "box_spec", "unit_price", "freight", "bag_weight", "date", "remark", "pay_status",
	}
)

// WhProductPayload 入仓品请求体按 ProductIn 声明字段过滤。
func WhProductPayload(body map[string]any) map[string]any { return whPickKeys(body, whProductKeys) }

// WhInboundCreatePayload 新建入仓记录请求体按 InboundIn 声明字段过滤。
func WhInboundCreatePayload(body map[string]any) map[string]any { return whPickKeys(body, whInboundCreateKeys) }

// WhInboundUpdatePayload 修改入仓记录请求体按 InboundUpdate 声明字段过滤。
func WhInboundUpdatePayload(body map[string]any) map[string]any { return whPickKeys(body, whInboundUpdateKeys) }

// CreateWarehouseProduct 新增入仓品（同 Python create_product）。
func CreateWarehouseProduct(ctx context.Context, q Querier, body map[string]any) (map[string]any, error) {
	name := strings.TrimSpace(ToStr(body["name"]))
	if name == "" {
		return nil, ErrText("入仓品名称不能为空")
	}
	packItems, err := CleanWhPackItems(ctx, q, MapSlice(body["pack_items"]))
	if err != nil {
		return nil, err
	}
	p := warehouseProductFromBody(name, body, packItems)
	res, err := q.ExecContext(ctx,
		`INSERT INTO warehouse_products (name, category, sku, barcode, box_spec, purchase_price, freight,
			stock_product_id, bag_weight, bag_net_weight, bag_net_unit, dropship_cost, shelf_life, remark,
			is_active, pack_items, created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		p.Name, p.Category, p.SKU, p.Barcode, p.BoxSpec, p.PurchasePrice, p.Freight, AsInt(p.StockProductID),
		p.BagWeight, p.BagNetWeight, p.BagNetUnit, p.DropshipCost, p.ShelfLife, p.Remark, p.IsActive,
		encodeWhList(p.PackItems), nowDB())
	if err != nil {
		return nil, err
	}
	id64, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	p.ID = int(id64)
	return WarehouseProductJSON(ctx, q, p)
}

// UpdateWarehouseProduct 全量覆盖入仓品字段（同 Python update_product：Pydantic 缺省字段会写回默认值）。
func UpdateWarehouseProduct(ctx context.Context, q Querier, id int, body map[string]any) (map[string]any, error) {
	if _, err := GetWarehouseProduct(ctx, q, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, Err404("入仓品不存在")
		}
		return nil, err
	}
	name := strings.TrimSpace(ToStr(body["name"]))
	if name == "" {
		return nil, ErrText("入仓品名称不能为空")
	}
	packItems, err := CleanWhPackItems(ctx, q, MapSlice(body["pack_items"]))
	if err != nil {
		return nil, err
	}
	np := warehouseProductFromBody(name, body, packItems)
	np.ID = id
	_, err = q.ExecContext(ctx,
		`UPDATE warehouse_products SET name=?, category=?, sku=?, barcode=?, box_spec=?, purchase_price=?,
			freight=?, stock_product_id=?, bag_weight=?, bag_net_weight=?, bag_net_unit=?, dropship_cost=?,
			shelf_life=?, remark=?, is_active=?, pack_items=? WHERE id=?`,
		np.Name, np.Category, np.SKU, np.Barcode, np.BoxSpec, np.PurchasePrice, np.Freight,
		AsInt(np.StockProductID), np.BagWeight, np.BagNetWeight, np.BagNetUnit, np.DropshipCost,
		np.ShelfLife, np.Remark, np.IsActive, encodeWhList(np.PackItems), np.ID)
	if err != nil {
		return nil, err
	}
	return WarehouseProductJSON(ctx, q, np)
}

// DeleteWarehouseProduct 删除入仓品（Python 不检查是否已被入仓记录引用）。
func DeleteWarehouseProduct(ctx context.Context, q Querier, id int) error {
	p, err := GetWarehouseProduct(ctx, q, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Err404("入仓品不存在")
		}
		return err
	}
	_, err = q.ExecContext(ctx, "DELETE FROM warehouse_products WHERE id = ?", p.ID)
	return err
}

// ---------------- 入仓记录 ----------------

// WarehouseIn 一条入仓记录（按「袋」）。
type WarehouseIn struct {
	ID             int
	Code           string
	ProductID      *int
	ProductName    string
	Category       string
	Unit           string
	PurchaseNo     string
	Center         string
	Quantity       float64
	BoxCount       float64
	BoxSpec        float64
	UnitPrice      float64
	DeductionPct   float64
	Freight        float64
	StockProductID *int
	BagWeight      float64
	UnitCost       float64
	BagCost        float64
	COGS           float64
	Amount         float64
	FreightTotal   float64
	PackItems      []map[string]any
	PackCost       float64
	Profit         float64
	Date           string
	Operator       string
	Remark         string
	ImportGroup    string
	PayStatus      string
	PaidAt         string
}

const whInColumns = `id, code, product_id, COALESCE(product_name,''), COALESCE(category,''), COALESCE(unit,''),
	COALESCE(purchase_no,''), COALESCE(center,''), COALESCE(quantity,0), COALESCE(box_count,0), COALESCE(box_spec,0),
	COALESCE(unit_price,0), COALESCE(deduction_percent,0), COALESCE(freight,0), stock_product_id,
	COALESCE(bag_weight,0), COALESCE(unit_cost,0), COALESCE(bag_cost,0), COALESCE(cogs,0), COALESCE(amount,0),
	COALESCE(freight_total,0), pack_items, COALESCE(pack_cost,0), COALESCE(profit,0), date,
	COALESCE(operator,''), COALESCE(remark,''), COALESCE(import_group,''), COALESCE(pay_status,'paid'), COALESCE(paid_at,'')`

func scanWarehouseIn(scan func(dest ...any) error) (*WarehouseIn, error) {
	var r WarehouseIn
	var productID, stockID sql.NullInt64
	var packItems sql.NullString
	var payStatus, paidAt sql.NullString
	err := scan(&r.ID, &r.Code, &productID, &r.ProductName, &r.Category, &r.Unit, &r.PurchaseNo, &r.Center,
		&r.Quantity, &r.BoxCount, &r.BoxSpec, &r.UnitPrice, &r.DeductionPct, &r.Freight, &stockID,
		&r.BagWeight, &r.UnitCost, &r.BagCost, &r.COGS, &r.Amount, &r.FreightTotal, &packItems, &r.PackCost,
		&r.Profit, &r.Date, &r.Operator, &r.Remark, &r.ImportGroup, &payStatus, &paidAt)
	if err != nil {
		return nil, err
	}
	if productID.Valid {
		v := int(productID.Int64)
		r.ProductID = &v
	}
	if stockID.Valid {
		v := int(stockID.Int64)
		r.StockProductID = &v
	}
	r.PackItems = MapSlice(decodeJSONAny(packItems.String))
	r.PayStatus = payStatus.String
	if r.PayStatus == "" {
		r.PayStatus = "paid"
	}
	r.PaidAt = paidAt.String
	return &r, nil
}

// GetWarehouseIn 按 id 取入仓记录；不存在返回 ErrNotFound。
func GetWarehouseIn(ctx context.Context, q Querier, id int) (*WarehouseIn, error) {
	row := q.QueryRowContext(ctx, "SELECT "+whInColumns+" FROM warehouse_ins WHERE id = ?", id)
	r, err := scanWarehouseIn(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// WarehouseInJSON 字段与 Python _in_dict 逐一一致。
func WarehouseInJSON(ctx context.Context, q Querier, r *WarehouseIn) (map[string]any, error) {
	var sp *Product
	if r.StockProductID != nil {
		got, err := GetProduct(ctx, q, *r.StockProductID)
		if err == nil {
			sp = got
		} else if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
	}
	qty := r.Quantity
	packItems := r.PackItems
	if packItems == nil {
		packItems = []map[string]any{}
	}
	// 老记录没有 bag_cost 值（0）时回退按 净重 × 单位成本 算，口径与改造前一致
	bagCost := r.BagCost
	if bagCost == 0 {
		bagCost = Round(r.BagWeight*r.UnitCost, 4)
	}
	return map[string]any{
		"id": r.ID, "code": r.Code, "product_id": AsInt(r.ProductID),
		"product_name": r.ProductName, "category": r.Category, "unit": r.Unit,
		"purchase_no": r.PurchaseNo, "center": r.Center,
		"quantity": r.Quantity, "box_count": r.BoxCount, "box_spec": r.BoxSpec,
		"unit_price": r.UnitPrice, "deduction_percent": r.DeductionPct, "freight": r.Freight,
		"stock_product_id":     AsInt(r.StockProductID),
		"stock_product_name":   productNameOrEmpty(sp),
		"stock_default_unit":   WhStockDefaultUnit(sp),
		"bag_weight":           r.BagWeight,
		"unit_cost":            r.UnitCost,
		"bag_cost":             bagCost,
		"cogs":                 r.COGS,
		"amount":               r.Amount,
		"freight_total":        r.FreightTotal,
		"profit":               r.Profit,
		"profit_rate":          WhProfitRate(r.Profit, r.Amount),
		"unit_revenue":         whDiv(r.Amount, qty, 4),
		"unit_goods_cost":      whDiv(r.COGS, qty, 4),
		"unit_freight":         whDiv(r.FreightTotal, qty, 4),
		"unit_pack_cost":       whDiv(r.PackCost, qty, 4),
		"unit_profit":          whDiv(r.Profit, qty, 4),
		"pack_items":           packItems,
		"pack_cost":            r.PackCost,
		"date":                 r.Date, "operator": r.Operator, "remark": r.Remark,
		"import_group": r.ImportGroup,
		"pay_status":   r.PayStatus,
		"paid_at":      r.PaidAt,
	}, nil
}

// ---------------- 列表 / 汇总 ----------------

// ListWarehouseIn GET /api/warehouse-in：明细 + 按入仓品汇总 + 合计 + 条数。
func ListWarehouseIn(ctx context.Context, q Querier, dateFrom, dateTo, search string) (map[string]any, error) {
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
	rows, err := q.QueryContext(ctx, "SELECT "+whInColumns+" FROM warehouse_ins"+where+" ORDER BY id DESC", args...)
	if err != nil {
		return nil, err
	}
	var recs []*WarehouseIn
	for rows.Next() {
		r, err := scanWarehouseIn(rows.Scan)
		if err != nil {
			rows.Close()
			return nil, err
		}
		recs = append(recs, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	filtered := recs
	if kw := strings.ToLower(strings.TrimSpace(search)); kw != "" {
		filtered = nil
		for _, r := range recs {
			hay := strings.ToLower(strings.Join([]string{r.Code, r.ProductName, r.PurchaseNo, r.Center, r.Operator}, " "))
			if strings.Contains(hay, kw) {
				filtered = append(filtered, r)
			}
		}
	}

	items := []map[string]any{}
	var sumAmount, sumCOGS, sumFreight, sumPack, sumProfit, sumQty float64
	for _, r := range filtered {
		m, err := WarehouseInJSON(ctx, q, r)
		if err != nil {
			return nil, err
		}
		items = append(items, m)
		sumAmount += r.Amount
		sumCOGS += r.COGS
		sumFreight += r.FreightTotal
		sumPack += r.PackCost
		sumProfit += r.Profit
		sumQty += r.Quantity
	}
	total := map[string]any{
		"amount": Round(sumAmount, 2), "cogs": Round(sumCOGS, 2), "freight": Round(sumFreight, 2),
		"pack_cost": Round(sumPack, 2), "profit": Round(sumProfit, 2), "quantity": Round(sumQty, 2),
	}
	// 毛利率 = 合计毛利 ÷ 合计收入（不是各条毛利率的平均）
	total["profit_rate"] = WhProfitRate(ToFloat(total["profit"]), ToFloat(total["amount"]))

	byProduct, err := whByProduct(ctx, q, filtered)
	if err != nil {
		return nil, err
	}
	return map[string]any{"items": items, "by_product": byProduct, "total": total, "count": len(filtered)}, nil
}

// whByProduct 按入仓品汇总（含毛利率），同 Python _by_product：金额按原始精度累加、最后一步才舍入。
func whByProduct(ctx context.Context, q Querier, recs []*WarehouseIn) ([]map[string]any, error) {
	products, err := ListWarehouseProducts(ctx, q)
	if err != nil {
		return nil, err
	}
	skuOf := map[int]string{}
	for _, p := range products {
		skuOf[p.ID] = p.SKU
	}
	type key struct {
		pid  int
		name string
	}
	acc := map[key]map[string]any{}
	var order []key
	for _, r := range recs {
		pid := 0
		if r.ProductID != nil {
			pid = *r.ProductID
		}
		k := key{pid, r.ProductName}
		b, ok := acc[k]
		if !ok {
			unit := r.Unit
			if unit == "" {
				unit = "袋"
			}
			b = map[string]any{
				"product_id": AsInt(r.ProductID), "sku": skuOf[pid],
				"product_name": r.ProductName, "category": r.Category, "unit": unit,
				"records": 0.0, "quantity": 0.0, "amount": 0.0, "cogs": 0.0,
				"freight_total": 0.0, "pack_cost": 0.0, "profit": 0.0, "last_date": "",
			}
			acc[k] = b
			order = append(order, k)
		}
		b["records"] = ToFloat(b["records"]) + 1
		b["quantity"] = ToFloat(b["quantity"]) + r.Quantity
		b["amount"] = ToFloat(b["amount"]) + r.Amount
		b["cogs"] = ToFloat(b["cogs"]) + r.COGS
		b["freight_total"] = ToFloat(b["freight_total"]) + r.FreightTotal
		b["pack_cost"] = ToFloat(b["pack_cost"]) + r.PackCost
		b["profit"] = ToFloat(b["profit"]) + r.Profit
		if r.Date > whStr(b["last_date"]) {
			b["last_date"] = r.Date
		}
	}
	out := make([]map[string]any, 0, len(order))
	for _, k := range order {
		out = append(out, acc[k])
	}
	// Python: sorted(..., key=lambda x: -x["amount"])，并列时保持插入顺序
	sort.SliceStable(out, func(i, j int) bool { return ToFloat(out[i]["amount"]) > ToFloat(out[j]["amount"]) })
	for _, b := range out {
		qty := ToFloat(b["quantity"])
		b["amount"] = Round(ToFloat(b["amount"]), 2)
		b["cogs"] = Round(ToFloat(b["cogs"]), 2)
		b["freight_total"] = Round(ToFloat(b["freight_total"]), 2)
		b["pack_cost"] = Round(ToFloat(b["pack_cost"]), 2)
		b["profit"] = Round(ToFloat(b["profit"]), 2)
		b["quantity"] = Round(qty, 4)
		b["profit_rate"] = WhProfitRate(ToFloat(b["profit"]), ToFloat(b["amount"]))
		b["unit_revenue"] = whDiv(ToFloat(b["amount"]), qty, 4)
		b["unit_profit"] = whDiv(ToFloat(b["profit"]), qty, 4)
	}
	return out, nil
}

// ---------------- 随货包材结算 ----------------

// whSettlePackItems 按「每袋用量 × 入仓袋数」结算随货包材，返回 (明细快照, 成本合计)。
// 不落库；成本按 FIFO 结转（批次不足回退参考成本），同一结算过程共享 cache 避免重复扣减。
func whSettlePackItems(ctx context.Context, q Querier, product *WarehouseProduct, quantity float64) ([]map[string]any, float64, error) {
	items := []map[string]any{}
	if product == nil {
		return items, 0, nil
	}
	type fifoCache struct {
		layers []fifoLayer
		base   float64
	}
	cache := map[int]*fifoCache{}
	total := 0.0
	for _, it := range product.PackItems {
		pid := ToInt(it["product_id"])
		if pid == 0 {
			continue
		}
		m, err := GetProduct(ctx, q, pid)
		if errors.Is(err, ErrNotFound) {
			continue
		} else if err != nil {
			return nil, 0, err
		}
		qty := Round(ToFloat(it["quantity"])*quantity, 6)
		if qty <= 0 {
			continue
		}
		unit := strings.TrimSpace(whStr(it["unit"]))
		if unit == "" {
			unit = m.DefaultUnit
		}
		if unit == "" {
			unit = m.BaseUnit
		}
		if unit == "" {
			unit = "个"
		}
		if _, ok := m.Conversions[unit]; !ok {
			continue
		}
		qtyBase, err := UnitToBase(m, unit, qty)
		if err != nil {
			return nil, 0, err
		}
		if _, ok := cache[m.ID]; !ok {
			st, _, err := FIFOStateFor(ctx, q, m.ID)
			if err != nil {
				return nil, 0, err
			}
			layers := make([]fifoLayer, len(st.Layers))
			copy(layers, st.Layers)
			cache[m.ID] = &fifoCache{layers: layers, base: st.Base}
		}
		c := cache[m.ID]
		cost := Round(Take(&c.layers, c.base, qtyBase, m.UnitCost), 2)
		unitPrice := 0.0
		if qty != 0 {
			unitPrice = Round(cost/qty, 6)
		}
		items = append(items, map[string]any{
			"product_id": m.ID, "name": m.Name, "unit": unit,
			"quantity": qty, "quantity_base": Round(qtyBase, 6),
			"unit_price": unitPrice, "cost": cost,
		})
		total += cost
	}
	return items, Round(total, 2), nil
}

// whApplyPackSettlement 把随货包材结算落成库存流水（包材=pack_out 消耗；人工/快递=work 正向工作量）
// 并重算受影响商品，同 Python _apply_pack_settlement。
func whApplyPackSettlement(ctx context.Context, q Querier, rec *WarehouseIn) error {
	var affected []int
	seen := map[int]bool{}
	for _, it := range rec.PackItems {
		pid := ToInt(it["product_id"])
		if pid == 0 {
			continue
		}
		m, err := GetProduct(ctx, q, pid)
		if errors.Is(err, ErrNotFound) {
			continue
		} else if err != nil {
			return err
		}
		isService := m.IsService()
		qtyBase := ToFloat(it["quantity_base"])
		moveType := "pack_out"
		if isService {
			moveType = "work"
		} else {
			qtyBase = -qtyBase
		}
		if _, err := q.ExecContext(ctx,
			`INSERT INTO stock_movements (product_id, move_type, quantity_base, amount, ref_type, ref_id,
				date, operator, remark, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
			pid, moveType, qtyBase, ToFloat(it["cost"]), "warehouse_in", rec.ID, rec.Date, rec.Operator,
			"入仓随货包材 "+rec.Code, nowDB()); err != nil {
			return err
		}
		if !seen[pid] {
			seen[pid] = true
			affected = append(affected, pid)
		}
	}
	for _, pid := range affected {
		if err := RecomputeProduct(ctx, q, pid); err != nil {
			return err
		}
	}
	return nil
}

// whClearPackSettlement 删除某入仓记录的随货包材流水，返回受影响商品 id（供调用方重算）。
func whClearPackSettlement(ctx context.Context, q Querier, recID int) ([]int, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT id, product_id FROM stock_movements WHERE ref_type = ? AND ref_id = ? ORDER BY id",
		"warehouse_in", recID)
	if err != nil {
		return nil, err
	}
	type mv struct{ id, pid int }
	var list []mv
	for rows.Next() {
		var m mv
		if err := rows.Scan(&m.id, &m.pid); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, m)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	seen := map[int]bool{}
	var affected []int
	for _, m := range list {
		if _, err := q.ExecContext(ctx, "DELETE FROM stock_movements WHERE id = ?", m.id); err != nil {
			return nil, err
		}
		if !seen[m.pid] {
			seen[m.pid] = true
			affected = append(affected, m.pid)
		}
	}
	return affected, nil
}

// ---------------- 写接口 ----------------

// GenWarehouseInCode 入仓单号 RC{date}-NNN（同一天已有几条就顺延）。
func GenWarehouseInCode(ctx context.Context, q Querier, date string) (string, error) {
	var count int
	if err := q.QueryRowContext(ctx, "SELECT COUNT(*) FROM warehouse_ins WHERE code LIKE ?", "RC"+date+"%").Scan(&count); err != nil {
		return "", err
	}
	return fmt.Sprintf("RC%s-%03d", date, count+1), nil
}

// CreateWarehouseIn 创建入仓记录（含随货包材结算流水与库存重算），口径同 Python _create_record。
// payload 用 Pydantic 模型 dump 后的键（quantity/date 必填，其余缺省按默认值）。
func CreateWarehouseIn(ctx context.Context, q Querier, payload map[string]any, operator, importGroup string) (*WarehouseIn, error) {
	quantity := ToFloat(payload["quantity"])
	if quantity <= 0 {
		return nil, ErrText("数量必须大于 0")
	}
	date := strings.TrimSpace(ToStr(payload["date"]))
	if date == "" {
		date = Today()
	}
	unitPrice := ToFloat(payload["unit_price"])
	freight := ToFloat(payload["freight"])

	var product *WarehouseProduct
	if pid := OptInt(payload, "product_id"); pid != nil && *pid != 0 {
		p, err := GetWarehouseProduct(ctx, q, *pid)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		product = p
	}
	name := strings.TrimSpace(ToStr(payload["product_name"]))
	if name == "" && product != nil {
		name = product.Name
	}
	if name == "" {
		return nil, ErrText("缺少商品名称")
	}

	// 成本口径：每袋商品成本 × 数量（关联库存 = 净重 × 单位成本；未关联 = 代发成本）
	var stockID *int
	if product != nil {
		stockID = product.StockProductID
	}
	sp, _, _, unitCost, err := WhStockInfo(ctx, q, stockID)
	if err != nil {
		return nil, err
	}
	bagWeight := ToFloat(payload["bag_weight"])
	if bagWeight == 0 && product != nil {
		bagWeight = product.BagWeight
	}
	bagCost := WhBagCost(product, bagWeight, unitCost)
	deduction, err := WarehouseDeduction(ctx, q)
	if err != nil {
		return nil, err
	}
	revenue := Round(quantity*unitPrice*(1-deduction/100), 2)
	cogs := Round(quantity*bagCost, 2)
	freightTotal := Round(quantity*freight, 2)
	packItems, packCost, err := whSettlePackItems(ctx, q, product, quantity)
	if err != nil {
		return nil, err
	}
	profit := Round(revenue-cogs-freightTotal-packCost, 2)

	code, err := GenWarehouseInCode(ctx, q, date)
	if err != nil {
		return nil, err
	}
	category := strings.TrimSpace(ToStr(payload["category"]))
	if category == "" && product != nil {
		category = product.Category
	}
	unit := strings.TrimSpace(whStr(payload["unit"]))
	if unit == "" {
		unit = "袋"
	}
	op := strings.TrimSpace(ToStr(payload["operator"]))
	if op == "" {
		op = operator
	}
	pay := PayFields(payload, date)

	rec := &WarehouseIn{
		Code: code, ProductName: name, Category: category, Unit: unit,
		PurchaseNo: strings.TrimSpace(ToStr(payload["purchase_no"])),
		Center:     strings.TrimSpace(ToStr(payload["center"])),
		Quantity:   quantity, BoxCount: ToFloat(payload["box_count"]), BoxSpec: ToFloat(payload["box_spec"]),
		UnitPrice: unitPrice, DeductionPct: deduction, Freight: freight,
		BagWeight: bagWeight, UnitCost: unitCost, BagCost: bagCost,
		COGS: cogs, Amount: revenue, FreightTotal: freightTotal,
		PackItems: packItems, PackCost: packCost, Profit: profit,
		Date: date, Operator: op, Remark: strings.TrimSpace(ToStr(payload["remark"])),
		ImportGroup: importGroup, PayStatus: pay.PayStatus, PaidAt: pay.PaidAt,
	}
	if product != nil {
		rec.ProductID = &product.ID
	}
	if sp != nil {
		rec.StockProductID = &sp.ID
	}

	res, err := q.ExecContext(ctx,
		`INSERT INTO warehouse_ins (code, product_id, product_name, category, unit, purchase_no, center, quantity,
			box_count, box_spec, unit_price, deduction_percent, freight, stock_product_id, bag_weight, unit_cost,
			bag_cost, cogs, amount, freight_total, pack_items, pack_cost, profit, date, operator, remark,
			import_group, pay_status, paid_at, created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		rec.Code, AsInt(rec.ProductID), rec.ProductName, rec.Category, rec.Unit, rec.PurchaseNo, rec.Center,
		rec.Quantity, rec.BoxCount, rec.BoxSpec, rec.UnitPrice, rec.DeductionPct, rec.Freight,
		AsInt(rec.StockProductID), rec.BagWeight, rec.UnitCost, rec.BagCost, rec.COGS, rec.Amount,
		rec.FreightTotal, encodeWhList(rec.PackItems), rec.PackCost, rec.Profit, rec.Date, rec.Operator,
		rec.Remark, rec.ImportGroup, rec.PayStatus, rec.PaidAt, nowDB())
	if err != nil {
		return nil, err
	}
	id64, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	rec.ID = int(id64)
	if err := whApplyPackSettlement(ctx, q, rec); err != nil {
		return nil, err
	}
	return rec, nil
}

// UpdateWarehouseIn 修改入仓记录：重算成本口径与随货包材结算，口径同 Python update_inbound。
func UpdateWarehouseIn(ctx context.Context, q Querier, id int, body map[string]any) (map[string]any, error) {
	rec, err := GetWarehouseIn(ctx, q, id)
	if errors.Is(err, ErrNotFound) {
		return nil, Err404("入仓记录不存在")
	} else if err != nil {
		return nil, err
	}
	quantity := ToFloat(body["quantity"])
	if quantity <= 0 {
		return nil, ErrText("数量必须大于 0")
	}
	var product *WarehouseProduct
	if pid := OptInt(body, "product_id"); pid != nil && *pid != 0 {
		p, err := GetWarehouseProduct(ctx, q, *pid)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		product = p
	}
	rec.ProductID = nil
	switch {
	case product != nil:
		rec.ProductID = &product.ID
		rec.ProductName = product.Name
		rec.Category = product.Category
	case strings.TrimSpace(ToStr(body["product_name"])) != "":
		rec.ProductName = strings.TrimSpace(ToStr(body["product_name"]))
		rec.Category = strings.TrimSpace(ToStr(body["category"]))
	}
	unit := strings.TrimSpace(whStr(body["unit"]))
	if unit == "" {
		unit = "袋"
	}
	rec.Unit = unit
	rec.PurchaseNo = strings.TrimSpace(ToStr(body["purchase_no"]))
	rec.Center = strings.TrimSpace(ToStr(body["center"]))
	rec.Quantity = quantity
	rec.BoxCount = ToFloat(body["box_count"])
	rec.BoxSpec = ToFloat(body["box_spec"])
	rec.UnitPrice = ToFloat(body["unit_price"])
	rec.Freight = ToFloat(body["freight"])
	if d := strings.TrimSpace(whStr(body["date"])); d != "" {
		rec.Date = d
	}
	rec.Remark = strings.TrimSpace(ToStr(body["remark"]))
	rec.PayStatus = "paid"
	if strings.TrimSpace(ToStr(body["pay_status"])) == "unpaid" {
		rec.PayStatus = "unpaid"
	}
	if rec.PayStatus == "unpaid" {
		rec.PaidAt = ""
	} else if rec.PaidAt == "" {
		rec.PaidAt = rec.Date
	}

	// 成本重算：关联库存商品 / 每袋净重 / 代发成本变化时同步成本口径
	stockID := rec.StockProductID
	if product != nil {
		stockID = product.StockProductID
	}
	sp, _, _, unitCost, err := WhStockInfo(ctx, q, stockID)
	if err != nil {
		return nil, err
	}
	rec.StockProductID = nil
	if sp != nil {
		rec.StockProductID = &sp.ID
	}
	bagWeight := ToFloat(body["bag_weight"])
	if bagWeight == 0 {
		if product != nil {
			bagWeight = product.BagWeight
		}
		if bagWeight == 0 {
			bagWeight = rec.BagWeight
		}
	}
	rec.BagWeight = bagWeight
	rec.UnitCost = unitCost
	rec.BagCost = WhBagCost(product, bagWeight, unitCost)
	deduction, err := WarehouseDeduction(ctx, q)
	if err != nil {
		return nil, err
	}
	rec.DeductionPct = deduction
	rec.Amount = Round(rec.Quantity*rec.UnitPrice*(1-deduction/100), 2)
	rec.COGS = Round(rec.Quantity*rec.BagCost, 2)
	rec.FreightTotal = Round(rec.Quantity*rec.Freight, 2)

	// 随货包材：先清除旧结算流水，再按新入仓品/数量重算
	oldAffected, err := whClearPackSettlement(ctx, q, rec.ID)
	if err != nil {
		return nil, err
	}
	packItems, packCost, err := whSettlePackItems(ctx, q, product, quantity)
	if err != nil {
		return nil, err
	}
	rec.PackItems, rec.PackCost = packItems, packCost
	rec.Profit = Round(rec.Amount-rec.COGS-rec.FreightTotal-rec.PackCost, 2)
	if err := whApplyPackSettlement(ctx, q, rec); err != nil {
		return nil, err
	}
	for _, pid := range oldAffected { // 从清单里移除的旧包材也要重算回库存
		if err := RecomputeProduct(ctx, q, pid); err != nil {
			return nil, err
		}
	}
	if _, err := q.ExecContext(ctx,
		`UPDATE warehouse_ins SET product_id=?, product_name=?, category=?, unit=?, purchase_no=?, center=?,
			quantity=?, box_count=?, box_spec=?, unit_price=?, freight=?, date=?, remark=?, pay_status=?, paid_at=?,
			stock_product_id=?, bag_weight=?, unit_cost=?, bag_cost=?, deduction_percent=?, amount=?, cogs=?,
			freight_total=?, pack_items=?, pack_cost=?, profit=? WHERE id=?`,
		AsInt(rec.ProductID), rec.ProductName, rec.Category, rec.Unit, rec.PurchaseNo, rec.Center,
		rec.Quantity, rec.BoxCount, rec.BoxSpec, rec.UnitPrice, rec.Freight, rec.Date, rec.Remark,
		rec.PayStatus, rec.PaidAt, AsInt(rec.StockProductID), rec.BagWeight, rec.UnitCost, rec.BagCost,
		rec.DeductionPct, rec.Amount, rec.COGS, rec.FreightTotal, encodeWhList(rec.PackItems),
		rec.PackCost, rec.Profit, rec.ID); err != nil {
		return nil, err
	}
	return WarehouseInJSON(ctx, q, rec)
}

// DeleteWarehouseIn 删除入仓记录并回滚其随货包材流水。
func DeleteWarehouseIn(ctx context.Context, q Querier, id int) error {
	rec, err := GetWarehouseIn(ctx, q, id)
	if errors.Is(err, ErrNotFound) {
		return Err404("入仓记录不存在")
	} else if err != nil {
		return err
	}
	affected, err := whClearPackSettlement(ctx, q, rec.ID)
	if err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx, "DELETE FROM warehouse_ins WHERE id = ?", rec.ID); err != nil {
		return err
	}
	for _, pid := range affected {
		if err := RecomputeProduct(ctx, q, pid); err != nil {
			return err
		}
	}
	return nil
}

// BatchDeleteWarehouseIn 批量删除入仓记录，返回 {ok, deleted}。
func BatchDeleteWarehouseIn(ctx context.Context, q Querier, ids []int) (map[string]any, error) {
	deleted := 0
	affectedSet := map[int]bool{}
	var affected []int
	for _, rid := range ids {
		rec, err := GetWarehouseIn(ctx, q, rid)
		if errors.Is(err, ErrNotFound) {
			continue
		} else if err != nil {
			return nil, err
		}
		list, err := whClearPackSettlement(ctx, q, rec.ID)
		if err != nil {
			return nil, err
		}
		for _, pid := range list {
			if !affectedSet[pid] {
				affectedSet[pid] = true
				affected = append(affected, pid)
			}
		}
		if _, err := q.ExecContext(ctx, "DELETE FROM warehouse_ins WHERE id = ?", rec.ID); err != nil {
			return nil, err
		}
		deleted++
	}
	for _, pid := range affected {
		if err := RecomputeProduct(ctx, q, pid); err != nil {
			return nil, err
		}
	}
	return map[string]any{"ok": true, "deleted": deleted}, nil
}
