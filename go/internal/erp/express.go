package erp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// ---------------- 快递费（多段计费，规则页可实时维护） ----------------

// BoxWeightKg 每个包裹在净重基础上统一加的箱重（kg）。
const BoxWeightKg = 0.1

// ExpressConfig 快递费计费配置；文件缺失/异常时回退 DefaultExpressConfig。
type ExpressConfig struct {
	Mode       string  `json:"mode"`
	FirstKgFee float64 `json:"first_kg_fee"`
	PerExtraKg float64 `json:"per_extra_kg"`
	RatePerKg  float64 `json:"rate_per_kg"`
	RoundUp    bool    `json:"round_up"`
}

// DefaultExpressConfig 与 Python DEFAULT_EXPRESS_CONFIG 同值。
func DefaultExpressConfig() ExpressConfig {
	return ExpressConfig{Mode: "tiered", FirstKgFee: 3.6, PerExtraKg: 1.0, RatePerKg: 3.6, RoundUp: true}
}

// ExpressConfigPath 快递费配置文件（默认在仓库根 json/ 下，与 Python 路径一致，由 main 注入）。
var ExpressConfigPath = ""

// LoadExpressConfig 读取计费配置（缺键用默认值补齐）。
func LoadExpressConfig() ExpressConfig {
	cfg := DefaultExpressConfig()
	if ExpressConfigPath == "" {
		return cfg
	}
	raw, err := os.ReadFile(ExpressConfigPath)
	if err != nil {
		return cfg
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return cfg
	}
	if v, ok := data["mode"]; ok {
		cfg.Mode = ToStr(v)
	}
	if v, ok := data["first_kg_fee"]; ok {
		cfg.FirstKgFee = ToFloat(v)
	}
	if v, ok := data["per_extra_kg"]; ok {
		cfg.PerExtraKg = ToFloat(v)
	}
	if v, ok := data["rate_per_kg"]; ok {
		cfg.RatePerKg = ToFloat(v)
	}
	if v, ok := data["round_up"]; ok {
		cfg.RoundUp = ToBool(v)
	}
	return cfg
}

// SaveExpressConfig 保存计费配置（实时生效），返回补全后的配置。
func SaveExpressConfig(in map[string]any) (ExpressConfig, error) {
	merged := DefaultExpressConfig()
	if len(in) > 0 {
		if v, ok := in["mode"]; ok {
			merged.Mode = ToStr(v)
		}
		if v, ok := in["first_kg_fee"]; ok {
			merged.FirstKgFee = ToFloat(v)
		}
		if v, ok := in["per_extra_kg"]; ok {
			merged.PerExtraKg = ToFloat(v)
		}
		if v, ok := in["rate_per_kg"]; ok {
			merged.RatePerKg = ToFloat(v)
		}
		if v, ok := in["round_up"]; ok {
			merged.RoundUp = ToBool(v)
		}
	}
	if merged.Mode != "tiered" && merged.Mode != "flat" {
		return merged, ErrText("计费方式需为 tiered 或 flat")
	}
	for _, kv := range [][2]string{{"first_kg_fee", FormatFloat(merged.FirstKgFee)}, {"per_extra_kg", FormatFloat(merged.PerExtraKg)}, {"rate_per_kg", FormatFloat(merged.RatePerKg)}} {
		_ = kv[1]
	}
	if bad, ok := expressOutOfRange(merged); ok {
		return merged, ErrText("费用「%s」需在 0 ~ 10000 之间", bad)
	}
	if ExpressConfigPath != "" {
		if err := os.MkdirAll(filepath.Dir(ExpressConfigPath), 0o755); err != nil {
			return merged, err
		}
		raw, err := json.MarshalIndent(merged, "", "  ")
		if err != nil {
			return merged, err
		}
		raw = append(raw, byte(10))
		if err := os.WriteFile(ExpressConfigPath, raw, 0o644); err != nil {
			return merged, err
		}
	}
	return merged, nil
}

// ComputeExpressFee 快递费：tiered = 1kg 内首重价 + 每超 1kg 加收（round_up 时按整 kg 向上取整）；
// flat = 重量 × 每 kg 单价。
func ComputeExpressFee(weightKg float64, cfg ExpressConfig) float64 {
	w := weightKg
	if w < 0 {
		w = 0
	}
	if cfg.Mode == "flat" {
		return Round(w*cfg.RatePerKg, 2)
	}
	over := w - 1.0
	if over < 0 {
		over = 0
	}
	if cfg.RoundUp && over > 0 {
		over = CeilFloat(over)
	}
	return Round(cfg.FirstKgFee+over*cfg.PerExtraKg, 2)
}

// DeductionNetWeightKg 由扣减库存量推导净重(kg)：重量类库存按基础单位克数折算。
func DeductionNetWeightKg(target *Product, deductionBase float64) float64 {
	if target != nil && (target.BaseUnit == "克" || target.BaseUnit == "g") && deductionBase > 0 {
		return Round(deductionBase/1000.0, 4)
	}
	return 0
}

// LineWeightKg 某销售行折成「默认单位」后的净重(kg)；weight_kg 是每默认单位的净重。
// 仅用于基础单位非克（计数类）且未关联重量的兜底。
func LineWeightKg(p *Product, quantityBase float64) float64 {
	w := p.WeightKg
	if w <= 0 {
		return 0
	}
	refUnit := p.DefaultUnit
	if refUnit == "" {
		refUnit = p.BaseUnit
	}
	factor := p.Factor(refUnit)
	if factor <= 0 {
		factor = 1
	}
	return Round(quantityBase/factor*w, 4)
}

// ExpressProductName 快递费结算载体商品名（取「快递」分类里 id 最小的商品，没有则自动创建）。
const ExpressProductName = "快递费(自动)"

// GetOrCreateExpressProduct 返回用于挂快递费的商品 id 与名称。
func GetOrCreateExpressProduct(ctx context.Context, q Querier) (int, string, error) {
	var id int
	var name string
	err := q.QueryRowContext(ctx,
		"SELECT id, name FROM products WHERE category = ? ORDER BY id LIMIT 1", "快递").Scan(&id, &name)
	if err == nil {
		return id, name, nil
	}
	if err.Error() != "sql: no rows in result set" {
		return 0, "", err
	}
	conv := EncodeJSONColumn(map[string]float64{"单": 1})
	res, err := q.ExecContext(ctx,
		"INSERT INTO products (code, name, category, product_type, base_unit, default_unit, spec, sale_price, unit_cost, conversions, pack_items, pack_fee, is_active, multiplier, stock, avg_cost, stock_value, created_at, workload, weight_kg, free_shipping) VALUES ('',?,'快递','stock','单','单','',0,0,?,?,'[]',0,1,1,0,0,0,?,0,0,0)",
		ExpressProductName, conv, EncodeJSONColumn([]PackItem{}), nowDB())
	if err != nil {
		return 0, "", err
	}
	newID, err := res.LastInsertId()
	if err != nil {
		return 0, "", err
	}
	return int(newID), ExpressProductName, nil
}

// TrimName 去掉首尾空白（Python strip 语义）。
func TrimName(s string) string { return strings.TrimSpace(s) }


// expressOutOfRange 三项费用里第一个越界的字段名（0 ~ 10000 之外）。
func expressOutOfRange(cfg ExpressConfig) (string, bool) {
	checks := []struct {
		name string
		val  float64
	}{{"first_kg_fee", cfg.FirstKgFee}, {"per_extra_kg", cfg.PerExtraKg}, {"rate_per_kg", cfg.RatePerKg}}
	for _, c := range checks {
		if c.val < 0 || c.val > 10000 {
			return c.name, true
		}
	}
	return "", false
}
