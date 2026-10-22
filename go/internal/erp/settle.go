package erp

import (
	"sort"
	"strings"
)

// ---------------- 「实收」口径：客户承担的关联结算 + 放单仓刷单 ----------------

// SettleCatLabel 关联结算类别 key → 中文。
var SettleCatLabel = map[string]string{"material": "包材", "labor": "人工", "express": "快递费", "fee": "固定成本"}

// SettleCatOrder 归一化后的固定展示顺序。
var SettleCatOrder = []string{"material", "labor", "express", "fee"}

// SettleFeeCat 「固定成本」（人工打包费/工时/胶带）也由客户随货款付回时的键。
const SettleFeeCat = "fee"

// PackSettleCat 关联结算行归到哪一类（与报表 PACK_COST_CATS 口径一致）：
// 人工 → labor；快递 → express；包材/耗材/包装/其他 → material；名称以「打包」结尾兜底算人工。
func PackSettleCat(category, name string) string {
	c := strings.TrimSpace(category)
	if c == "人工" {
		return "labor"
	}
	if c == "快递" {
		return "express"
	}
	if strings.HasSuffix(strings.TrimSpace(name), "打包") {
		return "labor"
	}
	return "material"
}

// NormalizeSettleCats 把前端/导入传来的类别归一：去重、丢未知项、按固定顺序排列。
// 未显式提供（provided=false）= 默认「客户不承担」。
func NormalizeSettleCats(cats any, provided bool) []string {
	if !provided || cats == nil {
		return []string{}
	}
	var list []string
	switch v := cats.(type) {
	case string:
		for _, s := range strings.Split(strings.ReplaceAll(v, "，", ","), ",") {
			list = append(list, s)
		}
	case []any:
		for _, it := range v {
			list = append(list, ToStr(it))
		}
	case []string:
		list = v
	default:
		return []string{}
	}
	out := []string{}
	for _, x := range list {
		k := strings.ToLower(strings.TrimSpace(x))
		if _, ok := SettleCatLabel[k]; ok && !ContainsStr(out, k) {
			out = append(out, k)
		}
	}
	sorted := []string{}
	for _, k := range SettleCatOrder {
		if ContainsStr(out, k) {
			sorted = append(sorted, k)
		}
	}
	return sorted
}

// SettleCatsLabel 类别 key → 中文串（提示文案 / 图表注用）。
func SettleCatsLabel(cats any, provided bool) string {
	return strings.Join(MapLabels(NormalizeSettleCats(cats, provided)), "、")
}

// MapLabels 按 SettleCatLabel 映射。
func MapLabels(keys []string) []string {
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, SettleCatLabel[k])
	}
	return out
}

// BrushWarehouses 需要刷单成本核算的「仓储方」（聚水潭出库单里的「仓储方」列）。
var BrushWarehouses = []string{"芳谊放单仓"}

// IsBrushWarehouse 该仓储方是否属于「放单仓」。
func IsBrushWarehouse(name string) bool {
	return ContainsStr(BrushWarehouses, strings.TrimSpace(name))
}

// BrushFeeOf 该单结算用的「快递+包装固定费」：填了 brush_fee 就用它，否则用系统自动值。
func BrushFeeOf(o *Outbound) float64 {
	if o.BrushFee > 0 {
		return o.BrushFee
	}
	return o.BrushAutoFee
}

// BrushAdjust 该单因刷单结算应从利润里额外扣掉的金额 = 刷单成本 + 固定费覆盖差（非放单单为 0）。
func BrushAdjust(o *Outbound) float64 {
	if o.BrushCost == 0 && o.BrushFee == 0 {
		return 0
	}
	return Round(o.BrushCost+BrushFeeOf(o)-o.BrushAutoFee, 2)
}

// BrushAdjustSQL 报表聚合用的 SQL 片段（NULLIF：brush_fee=0 表示没覆盖 → 差额记 0）。
const BrushAdjustSQL = "COALESCE(brush_cost,0) + COALESCE(NULLIF(COALESCE(brush_fee,0),0) - COALESCE(brush_auto_fee,0), 0)"

// SortByFloatDesc 按某个数值字段降序（报表排序口径与 Python sorted(reverse=True) 一致，稳定排序）。
func SortByFloatDesc(rows []map[string]any, key string) {
	sort.SliceStable(rows, func(i, j int) bool {
		return ToFloat(rows[i][key]) > ToFloat(rows[j][key])
	})
}

