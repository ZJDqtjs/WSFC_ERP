package erp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 本文件是「鲜货现采」的读侧与展示清单，对齐 Python routers/fresh.py。
// 展示清单不是数据库表，而是按分仓隔离的文件 backend/json/fresh_config_{key}.json。

// FreshConfigDir 配置目录（由 api 层注入 backend/json）。
var FreshConfigDir = ""

// FreshCats 鲜货分类。
var FreshCats = []string{"蔬菜", "干货"}

// FreshExcludedCats 候选清单里排除的分类（各有独立入口，不该混进鲜货入库）。
var FreshExcludedCats = []string{"包材", "人工", "快递"}

func freshConfigPath(key string) string {
	return filepath.Join(FreshConfigDir, "fresh_config_"+key+".json")
}

// LoadFreshConfig 读展示清单（有序商品 id）；文件缺失/损坏返回空，此时展示全部鲜货。
func LoadFreshConfig(key string) []int {
	raw, err := os.ReadFile(freshConfigPath(key))
	if err != nil {
		return []int{}
	}
	var doc struct {
		IDs []any "json:\"ids\""
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return []int{}
	}
	out := []int{}
	for _, v := range doc.IDs {
		if n, ok := toFloat(v); ok {
			out = append(out, int(n))
		}
	}
	return out
}

// SaveFreshConfig 保存展示清单（原样保存，不去重、不校验存在性，与 Python 一致）。
func SaveFreshConfig(key string, ids []int) error {
	if FreshConfigDir == "" {
		return ErrText("未配置鲜货清单目录")
	}
	if err := os.MkdirAll(FreshConfigDir, 0o755); err != nil {
		return err
	}
	if ids == nil {
		ids = []int{}
	}
	raw, err := marshalIndentJSON(map[string]any{"ids": ids})
	if err != nil {
		return err
	}
	return os.WriteFile(freshConfigPath(key), raw, 0o644)
}

// FreshStock 鲜货库存：按展示清单顺序返回；onlyList=true 时只返回清单内商品（不限分类）。
func FreshStock(ctx context.Context, q Querier, key string, onlyList bool) (map[string]any, error) {
	items, err := ListProducts(ctx, q)
	if err != nil {
		return nil, err
	}
	fresh := map[int]*Product{}
	byID := map[int]*Product{}
	for _, p := range items {
		byID[p.ID] = p
		if p.ProductType == "stock" && p.IsActive && ContainsStr(FreshCats, p.Category) {
			fresh[p.ID] = p
		}
	}
	ids := LoadFreshConfig(key)
	ordered := []*Product{}
	if onlyList {
		for _, id := range ids {
			p := byID[id];
			if p != nil && p.ProductType == "stock" && p.IsActive {
				ordered = append(ordered, p)
			}
		}
	} else if len(ids) > 0 {
		inList := map[int]bool{}
		for _, id := range ids {
			inList[id] = true
		}
		for _, id := range ids {
			if p := fresh[id]; p != nil {
				ordered = append(ordered, p)
			}
		}
		rest := []*Product{}
		for pid, p := range fresh {
			if !inList[pid] {
				rest = append(rest, p)
			}
		}
		sort.SliceStable(rest, func(i, j int) bool { return rest[i].Name < rest[j].Name })
		ordered = append(ordered, rest...)
	} else {
		for _, p := range fresh {
			ordered = append(ordered, p)
		}
		sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Name < ordered[j].Name })
	}
	out := []map[string]any{}
	for _, p := range ordered {
		du := p.DisplayUnit()
		f := p.Factor(du)
		out = append(out, map[string]any{"id": p.ID, "name": p.Name, "category": p.Category, "unit": du,
			"stock": Round(p.Stock/f, 2), "avg_cost": Round(p.AvgCost*f, 4), "stock_value": p.StockValue})
	}
	if ids == nil {
		ids = []int{}
	}
	return map[string]any{"items": out, "ids": ids}, nil
}

// FreshOptions 可加入展示清单的候选商品。
func FreshOptions(ctx context.Context, q Querier, scope string) (map[string]any, error) {
	items, err := ListProducts(ctx, q)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, p := range items {
		if p.ProductType != "stock" || !p.IsActive {
			continue
		}
		if scope == "all" {
			if ContainsStr(FreshExcludedCats, p.Category) {
				continue
			}
		} else if !ContainsStr(FreshCats, p.Category) {
			continue
		}
		out = append(out, map[string]any{"id": p.ID, "name": p.Name, "category": p.Category, "unit": p.DisplayUnit()})
	}
	// 排序：分类、名称（ListProducts 已是 is_active DESC, category, name, id）
	sort.SliceStable(out, func(i, j int) bool {
		if ToStr(out[i]["category"]) != ToStr(out[j]["category"]) {
			return ToStr(out[i]["category"]) < ToStr(out[j]["category"])
		}
		return ToStr(out[i]["name"]) < ToStr(out[j]["name"])
	})
	return map[string]any{"items": out, "scope": scope, "fresh_cats": FreshCats}, nil
}

// ParseIDs 解析 {"ids":[...]} 请求体。
func ParseIDs(body map[string]any) []int {
	out := []int{}
	if arr, ok := body["ids"].([]any); ok {
		for _, v := range arr {
			if n, ok := toFloat(v); ok {
				out = append(out, int(n))
			}
		}
	}
	return out
}

// SortedStrings 去重排序（鲜货候选/单号列表用）。
func SortedStrings(in []string) []string {
	set := map[string]bool{}
	for _, s := range in {
		if strings.TrimSpace(s) != "" {
			set[s] = true
		}
	}
	out := make([]string, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}
