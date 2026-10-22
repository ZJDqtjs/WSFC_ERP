package erp

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"
)

// 本包是 Go 端的业务内核：表结构读写 + 库存成本算法，
// 口径与 Python 端 app/services.py 逐条对齐（FIFO、单位换算、快递费、金额调整、代发包材等）。

// Querier 让同一段逻辑既能跑在 *sql.DB 上，也能跑在事务 *sql.Tx 上。
type Querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// ErrNotFound 记录不存在（handler 会翻成 404）。
var ErrNotFound = errors.New("记录不存在")

// PackItem 商品「关联结算（随货包材/人工）」清单项：每销售 1 单消耗 quantity 个 unit。
type PackItem struct {
	ProductID int     `json:"product_id"`
	Quantity  float64 `json:"quantity"`
	Unit      string  `json:"unit"`
}

// StockLink 订单商品 → 库存商品（大类）的扣减关联。
type StockLink struct {
	ProductID  int     `json:"product_id"`
	Multiplier float64 `json:"multiplier"`
}

// StockScheme 一套扣减方案（配了多套时，出库按「方案内库存商品最近一次采购入库」自动选一套）。
type StockScheme struct {
	Name  string      `json:"name"`
	Links []StockLink `json:"links"`
}

// Product 商品（库存大类 stock / 订单小类 order）。
type Product struct {
	ID             int
	Code           string
	Name           string
	Category       string
	ProductType    string
	BaseUnit       string
	DefaultUnit    string
	Spec           string
	SalePrice      float64
	UnitCost       float64
	WeightKg       float64
	FreeShipping   bool
	Conversions    map[string]float64
	PackItems      []PackItem
	PackFee        float64
	IsActive       bool
	StockProductID *int
	Multiplier     float64
	StockLinks     []StockLink
	StockSchemes   []StockScheme
	Stock          float64
	AvgCost        float64
	StockValue     float64
	Workload       float64
}

// DisplayUnit 展示/出库单位（默认单位为空时回退基础单位）。
func (p *Product) DisplayUnit() string {
	if p.DefaultUnit != "" {
		return p.DefaultUnit
	}
	return p.BaseUnit
}

// Factor 某展示单位 → 基础单位的换算系数（缺失按 1 处理，与 Python 的 .get(du, 1) 一致）。
func (p *Product) Factor(unit string) float64 {
	f, ok := p.Conversions[unit]
	if !ok || f == 0 {
		return 1
	}
	return f
}

// IsService 人工/快递这类服务型商品：不记真实库存。
func (p *Product) IsService() bool {
	return p.Category == "人工" || p.Category == "快递"
}

const productColumns = `id, code, name, category, product_type, base_unit, default_unit, spec,
	sale_price, unit_cost, conversions, pack_items, pack_fee, is_active,
	stock_product_id, multiplier, stock, avg_cost, stock_value, created_at,
	workload, weight_kg, stock_links, free_shipping, stock_schemes`

func scanProduct(scan func(dest ...any) error) (*Product, error) {
	var p Product
	var code, category, productType, baseUnit, defaultUnit, spec sql.NullString
	var conversions, packItems, stockLinks, stockSchemes sql.NullString
	var stockProductID sql.NullInt64
	var createdAt time.Time
	targets := []any{&p.ID, &code, &p.Name, &category, &productType, &baseUnit, &defaultUnit, &spec,
		&p.SalePrice, &p.UnitCost, &conversions, &packItems, &p.PackFee, &p.IsActive,
		&stockProductID, &p.Multiplier, &p.Stock, &p.AvgCost, &p.StockValue, &createdAt,
		&p.Workload, &p.WeightKg, &stockLinks, &p.FreeShipping, &stockSchemes}
	if err := scan(targets...); err != nil {
		return nil, err
	}
	p.Code = code.String
	p.Category = category.String
	p.ProductType = productType.String
	if p.ProductType == "" {
		p.ProductType = "stock"
	}
	p.BaseUnit = baseUnit.String
	p.DefaultUnit = defaultUnit.String
	p.Spec = spec.String
	p.Conversions = decodeFloatMap(conversions.String)
	p.PackItems = decodePackItems(packItems.String)
	p.StockLinks = decodeStockLinks(stockLinks.String)
	p.StockSchemes = decodeStockSchemes(stockSchemes.String)
	if stockProductID.Valid {
		v := int(stockProductID.Int64)
		p.StockProductID = &v
	}
	return &p, nil
}

// GetProduct 按 id 取商品；不存在返回 ErrNotFound。
func GetProduct(ctx context.Context, q Querier, id int) (*Product, error) {
	row := q.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products WHERE id = ?", id)
	p, err := scanProduct(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// ListProducts 全量商品（排序与 Python /api/products 一致：在用优先，再按分类、名称）。
func ListProducts(ctx context.Context, q Querier) ([]*Product, error) {
	return listProductsOrdered(ctx, q, "ORDER BY is_active DESC, category, name, id")
}

// ListProductsByID 全量商品按 id（= rowid）升序。
// Python 工作台/报表用的是没有 ORDER BY 的 select(Product)，SQLite 即按 rowid 返回，
// 之后的稳定排序依赖这个顺序，所以这里不能复用 ListProducts 的排序。
func ListProductsByID(ctx context.Context, q Querier) ([]*Product, error) {
	return listProductsOrdered(ctx, q, "ORDER BY id")
}

func listProductsOrdered(ctx context.Context, q Querier, orderBy string) ([]*Product, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+productColumns+" FROM products "+orderBy)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Product
	for rows.Next() {
		p, err := scanProduct(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ---------------- JSON 列编解码 ----------------

func decodeFloatMap(s string) map[string]float64 {
	out := map[string]float64{}
	s = strings.TrimSpace(s)
	if s == "" {
		return out
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return out
	}
	for k, v := range raw {
		if f, ok := toFloat(v); ok {
			out[k] = f
		}
	}
	return out
}

func decodePackItems(s string) []PackItem {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	var raw []map[string]any
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return nil
	}
	out := make([]PackItem, 0, len(raw))
	for _, m := range raw {
		pid, _ := toInt(m["product_id"])
		qty, _ := toFloat(m["quantity"])
		unit, _ := m["unit"].(string)
		if unit == "" {
			unit = "个"
		}
		out = append(out, PackItem{ProductID: pid, Quantity: qty, Unit: unit})
	}
	return out
}

func decodeStockLinks(s string) []StockLink {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	var raw []map[string]any
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return nil
	}
	out := make([]StockLink, 0, len(raw))
	for _, m := range raw {
		pid, ok := toInt(m["product_id"])
		if !ok || pid == 0 {
			continue
		}
		mult, _ := toFloat(m["multiplier"])
		if mult == 0 {
			mult = 1
		}
		out = append(out, StockLink{ProductID: pid, Multiplier: mult})
	}
	return out
}

// decodeStockSchemes 解析「多套扣减方案」列：[{name, links:[{product_id, multiplier}]}]。
// 与 Python 的 _scheme_list 同口径：没有扣减项的方案直接丢掉。
func decodeStockSchemes(s string) []StockScheme {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	var raw []map[string]any
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return nil
	}
	out := make([]StockScheme, 0, len(raw))
	for _, m := range raw {
		var links []StockLink
		if arr, ok := m["links"].([]any); ok {
			for _, it := range arr {
				one, _ := it.(map[string]any)
				pid, ok := toInt(one["product_id"])
				if !ok || pid == 0 {
					continue
				}
				mult, _ := toFloat(one["multiplier"])
				if mult == 0 {
					mult = 1
				}
				links = append(links, StockLink{ProductID: pid, Multiplier: mult})
			}
		}
		if len(links) == 0 {
			continue
		}
		name, _ := m["name"].(string)
		out = append(out, StockScheme{Name: name, Links: links})
	}
	return out
}

// EncodeJSONColumn 把结构体序列化成 SQLite TEXT 列（空值统一存 "[]" / "{}"，与 Python 一致）。
func EncodeJSONColumn(v any) string {
	if v == nil {
		return "null"
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		return f, err == nil
	}
	return 0, false
}

func toInt(v any) (int, bool) {
	f, ok := toFloat(v)
	if !ok {
		return 0, false
	}
	return int(f), true
}

// ---------------- 数值/文本工具 ----------------

// Round 与 Python 的 round(v, places) 一致：对 float64 的「精确二进制值」做十进制四舍六入、
// 恰好一半时取偶（banker's rounding）。
// 不能只用 v*10^places 再取整：缩放本身会把 185.925 这类值推到半分位上，
// 让 Go 落进「取偶」分支而 Python 按真实值进位，金额差 1 分。
// 因此只在离半分位足够远时走浮点快路径，其余交给 big.Rat 精确舍入。
func Round(v float64, places int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	if places < 0 {
		places = 0
	}
	pow := math.Pow(10, float64(places))
	scaled := v * pow
	fl := math.Floor(scaled)
	diff := scaled - fl
	if math.Abs(diff-0.5) > 1e-6 && diff < 1-1e-6 {
		rounded := fl
		if diff > 0.5 {
			rounded = fl + 1
		}
		out := rounded / pow
		if out == 0 {
			return 0
		}
		return out
	}
	out := roundExact(v, places)
	if out == 0 {
		return 0
	}
	return out
}

// roundExact 用 big.Rat 还原 float64 的精确十进制值后做 half-even 取整，等价 CPython 的 round()。
func roundExact(v float64, places int) float64 {
	r := new(big.Rat).SetFloat64(v)
	if r == nil {
		return v
	}
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(places)), nil)
	r.Mul(r, new(big.Rat).SetInt(pow))
	num, den := r.Num(), r.Denom()
	q := new(big.Int)
	rem := new(big.Int)
	q.QuoRem(num, den, rem)
	switch new(big.Int).Lsh(new(big.Int).Abs(rem), 1).Cmp(den) {
	case 1:
		q = stepAway(q, num.Sign())
	case 0:
		if q.Bit(0) == 1 {
			q = stepAway(q, num.Sign())
		}
	}
	res, _ := new(big.Rat).SetFrac(q, pow).Float64()
	return res
}

// stepAway 把截断结果朝远离 0 的方向推一格（sign 是原数符号）。
func stepAway(q *big.Int, sign int) *big.Int {
	one := big.NewInt(1)
	if sign < 0 {
		return new(big.Int).Sub(q, one)
	}
	return new(big.Int).Add(q, one)
}

// Round2 金额常用两位小数。
func Round2(v float64) float64 { return Round(v, 2) }

// FmtQty 与 Python services.fmt_qty 一致：整数不带小数，否则最多 4 位并去尾零。
func FmtQty(qty float64) string {
	if math.Abs(qty-math.Round(qty)) < 1e-6 {
		return strconv.FormatInt(int64(math.Round(qty)), 10)
	}
	s := strconv.FormatFloat(qty, 'f', 4, 64)
	s = strings.TrimRight(s, "0")
	s = strings.TrimRight(s, ".")
	return s
}

// Today 返回 YYYY-MM-DD（本地时区，与 Python date.today().isoformat() 一致）。
func Today() string { return time.Now().Format("2006-01-02") }

// MonthStart 返回本月 1 号。
func MonthStart() string { return time.Now().Format("2006-01") + "-01" }

// ValidDate 校验 YYYY-MM-DD。
func ValidDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

// BizError 业务错误：自带 HTTP 状态码，最终由 web.WriteValue 落成 FastAPI 风格 {"detail": msg}。
// Python 端对应的就是 raise HTTPException(400/404, ...)，这样任何 erp 层直接 return ErrText 的位置
// 都不会再被当成 500（之前 500 会丢文案，前端只能看到 Internal Server Error）。
type BizError struct {
	Code int
	Msg  string
}

func (e *BizError) Error() string { return e.Msg }

// Detail 给 web 层取文案用（接口方法，避免 web 反向依赖 erp）。
func (e *BizError) Detail() string { return e.Msg }

// StatusCode 给 web 层取状态码用。
func (e *BizError) StatusCode() int {
	if e.Code == 0 {
		return 400
	}
	return e.Code
}

// ErrText 业务校验失败（HTTP 400），文案直接给前端。
func ErrText(format string, args ...any) error {
	return &BizError{Code: 400, Msg: fmt.Sprintf(format, args...)}
}

// DetailError 等价 Python 的 `raise HTTPException(status, detail={<对象>})`：
// detail 不是字符串而是 JSON 对象（前端读 detail.message，其余字段给机器判断，如编码冲突的占用方）。
// 写出时必须用 AIJSON 保序序列化，所以由 api 层识别后单独落盘。
type DetailError struct {
	Code int
	Body *JObj
}

func (e *DetailError) Error() string { return e.Body.Str("message") }

// DetailValue 结构化 detail。
func (e *DetailError) DetailValue() any { return e.Body }

// Detail 纯文案兜底（万一某个 handler 没识别出结构化 detail）。
func (e *DetailError) Detail() string { return e.Error() }

func (e *DetailError) StatusCode() int {
	if e.Code == 0 {
		return 400
	}
	return e.Code
}

// ErrMessage 错误的纯文案，等价 Python 的 str(e) / f"{e}"（导入 failed 明细用它；
// ErrTextOf 是 AI 报错那种「类型名: 文案」的口径，别混用）。
func ErrMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// Err404 记录不存在（HTTP 404），与 Python 的 HTTPException(404, ...) 对齐。
func Err404(format string, args ...any) error {
	return &BizError{Code: 404, Msg: fmt.Sprintf(format, args...)}
}


