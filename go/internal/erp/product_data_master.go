package erp

// 本文件是「商品主数据解耦」的业务内核，逐条对齐 Python app/product_master.py。
// 商品资料以 5 个 JSON 备份在按分仓隔离的 json 目录，可用名称跨库迁移；
// 导入时按名称把引用解析回数据库 id。

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ProductDataJSONDir 由 api 层注入 backend/json 目录（与 Python 的 JSON_DIR 对应）。
var ProductDataJSONDir = ""

// ProductDataKind 一类商品主数据的元信息：kind -> (文件名, 显示名, 列表字段名)。
type ProductDataKind struct {
	Kind    string
	File    string
	Label   string
	ListKey string
}

// productDataKinds 顺序即 Python KINDS 的插入顺序（/kinds 与错误回显 list(KINDS) 都按它）。
var productDataKinds = []ProductDataKind{
	{"units", "units.json", "计量单位", "units"},
	{"products_stock", "products_stock.json", "库存商品", "items"},
	{"products_order", "products_order.json", "订单商品", "items"},
	{"pack_rules", "pack_rules.json", "一单多货规则", "rules"},
	{"code_mappings", "code_mappings.json", "聚水潭编码关联", "mappings"},
}

// ProductDataImportOrder 导入先后顺序（被引用的先导入，名称解析才不会缺目标）。
var ProductDataImportOrder = []string{"units", "products_stock", "products_order", "pack_rules", "code_mappings"}

// ProductDataKinds 返回 kinds 元信息（/api/product-data/kinds 用）。
func ProductDataKinds() []ProductDataKind { return productDataKinds }

// ProductDataKindBy 按 kind 查元信息。
func ProductDataKindBy(kind string) (ProductDataKind, bool) {
	for _, k := range productDataKinds {
		if k.Kind == kind {
			return k, true
		}
	}
	return ProductDataKind{}, false
}

// productDataKindsList 返回 /kinds 里的 kind 名清单（错误回显 list(KINDS) 用）。
func productDataKindsList() []string {
	out := make([]string, 0, len(productDataKinds))
	for _, k := range productDataKinds {
		out = append(out, k.Kind)
	}
	return out
}

// ---------------- 有序 JSON（照抄 Python dict 插入顺序 + ensure_ascii=False） ----------------

// om 是一个保留键插入顺序的 JSON 对象，序列化时不转义 < > &。
type om struct {
	keys []string
	vals map[string]any
}

func newOM() *om { return &om{vals: map[string]any{}} }

// set 写一个键（重复键保留首次出现位置）。
func (o *om) set(k string, v any) {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o *om) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, err := marshalNoEscape(k)
		if err != nil {
			return nil, err
		}
		b.Write(kb)
		b.WriteByte(':')
		vb, err := marshalNoEscape(o.vals[k])
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// pyNum 是「Python 风格浮点」的 JSON 叶子：整数值渲染成 1.0/500.0，小数最短表示。
// 用于 SQLAlchemy Float 列（gram_per_unit/sale_price/.../auto_score），与 json.dumps(float) 对齐。
type pyNum float64

func (n pyNum) MarshalJSON() ([]byte, error) {
	return []byte(pyFloatStr(float64(n))), nil
}

// marshalNoEscape 序列化任意值但不做 HTML 转义（等价 json.dumps ensure_ascii=False）。
func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// jsonRaw 把库里存的 JSON 文本原样塞进输出（空/坏 → 回退 def），保留键顺序。
func jsonRaw(text string, def string) json.RawMessage {
	t := strings.TrimSpace(text)
	if t == "" || t == "null" {
		return json.RawMessage(def)
	}
	if !json.Valid([]byte(t)) {
		return json.RawMessage(def)
	}
	return json.RawMessage(t)
}

// ---------------- 通用取值（严格模仿 Python str()/float()/.get(k,default)/or 链） ----------------

// pyStr 等价 Python str(x)：None->"None"、bool->"True/False"、数字->最短表示、字符串原样。
func pyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case float64:
		return pyFloatStr(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case json.Number:
		return x.String()
	}
	return fmt.Sprintf("%v", v)
}

// pyFloatStr 尽量贴近 Python str(float)：整值带 .0，其余最短。
func pyFloatStr(f float64) string {
	if f == float64(int64(f)) && f > -1e15 && f < 1e15 {
		return strconv.FormatFloat(f, 'f', 1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// getOr 等价 it.get(key, default)：键缺失或值为 nil 时返回 default（区分「传了」与「没传」用 ok 版）。
// 注意 Python 的 .get 只要键存在就返回其值（哪怕是 None），这里对齐「键存在」语义。
func getOr(it map[string]any, key string, def any) any {
	if it == nil {
		return def
	}
	if v, ok := it[key]; ok {
		return v
	}
	return def
}

// hasKey 键是否存在。
func hasKey(it map[string]any, key string) bool {
	if it == nil {
		return false
	}
	_, ok := it[key]
	return ok
}

// pyFloat 等价 Python float(x)：bool->0/1、字符串解析、nil->报错(这里回退 0)。
func pyFloat(v any) float64 { return ToFloat(v) }

// orFallback 等价 Python (v or fallback)：v 为 None/空串/0/false/空容器时返回 fallback。
func orFallback(v any, fallback any) any {
	if truthyPy(v) {
		return v
	}
	return fallback
}

// truthyPy Python 真值判定（用于 or 链）。
func truthyPy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case int:
		return x != 0
	case int64:
		return x != 0
	case json.Number:
		f, err := x.Float64()
		return err == nil && f != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

// floatOr 计算 float(it.get(k, cur) or dflt)：键缺失用 cur，然后走 or 链（0->dflt）。
func floatOr(it map[string]any, key string, cur float64, dflt float64) float64 {
	raw := getOr(it, key, cur)
	return pyFloat(orFallback(raw, dflt))
}

// ---------------- json 目录（按分仓隔离） ----------------

// ProductDataDir 返回本请求分仓的 json 目录并保证存在（等价 _json_dir()）。
func ProductDataDir(key, defaultKey string) (string, error) {
	if ProductDataJSONDir == "" {
		return "", ErrText("未配置 json 目录")
	}
	d := ProductDataJSONDir
	if key != "" && key != defaultKey {
		d = filepath.Join(d, key)
	}
	if err := os.MkdirAll(d, 0o755); err != nil {
		return "", err
	}
	return d, nil
}

// ---------------- 商品名解析辅助 ----------------

// productNamesByID 全量商品 id->名称（导出时按 id 反查名称，避免 N+1）。
func productNamesByID(ctx context.Context, q Querier) (map[int]string, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, name FROM products")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]string{}
	for rows.Next() {
		var id int
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

// ---------------- 导出 ----------------

const pdProductExportCols = `id, COALESCE(code,''), name, COALESCE(category,''), COALESCE(product_type,'stock'),
	COALESCE(base_unit,''), COALESCE(default_unit,''), COALESCE(spec,''), sale_price, unit_cost,
	COALESCE(conversions,''), COALESCE(pack_items,''), COALESCE(pack_fee,0), is_active,
	stock_product_id, COALESCE(multiplier,1), COALESCE(stock_links,'')`

type pdProductRow struct {
	id             int
	code, name     string
	category       string
	productType    string
	baseUnit       string
	defaultUnit    string
	spec           string
	salePrice      float64
	unitCost       float64
	conversions    string
	packItems      string
	packFee        float64
	isActive       int
	stockProductID sql.NullInt64
	multiplier     float64
	stockLinks     string
}

// pdExportProduct 商品导出字典：引用一律用名称，避免依赖 id（对齐 _product_dict）。
func pdExportProduct(p pdProductRow, names map[int]string) *om {
	spName := ""
	if p.stockProductID.Valid {
		if n, ok := names[int(p.stockProductID.Int64)]; ok {
			spName = n
		}
	}
	// pack_items：[{name, quantity, unit}]，product_id 解析名称，缺失回退条目自带 name
	packItems := []*om{}
	for _, it := range decodeObjList(p.packItems) {
		name := ""
		if pid, ok := toInt(getOr(it, "product_id", nil)); ok && pid != 0 {
			if n, has := names[pid]; has {
				name = n
			}
		}
		if name == "" {
			name = pyStr(orFallback(getOr(it, "name", ""), ""))
		}
		q := getOr(it, "quantity", float64(1))
		un := getOr(it, "unit", "个")
		item := newOM()
		item.set("name", name)
		item.set("quantity", q)
		item.set("unit", un)
		packItems = append(packItems, item)
	}
	// stock_links：多扣减关联（按名称），解析不到商品的条目跳过
	stockLinks := []*om{}
	for _, it := range decodeObjList(p.stockLinks) {
		pid, ok := toInt(getOr(it, "product_id", nil))
		if !ok || pid == 0 {
			continue
		}
		nm, has := names[pid]
		if !has {
			continue
		}
		item := newOM()
		item.set("product", nm)
		item.set("multiplier", getOr(it, "multiplier", float64(1)))
		stockLinks = append(stockLinks, item)
	}
	if len(stockLinks) == 0 && spName != "" {
		item := newOM()
		item.set("product", spName)
		item.set("multiplier", p.multiplier)
		stockLinks = append(stockLinks, item)
	}

	d := newOM()
	d.set("code", p.code)
	d.set("name", p.name)
	d.set("category", p.category)
	d.set("product_type", p.productType)
	d.set("base_unit", p.baseUnit)
	du := p.defaultUnit
	if du == "" {
		du = p.baseUnit
	}
	d.set("default_unit", du)
	d.set("spec", p.spec)
	d.set("sale_price", p.salePrice)
	d.set("unit_cost", p.unitCost)
	d.set("conversions", jsonRaw(p.conversions, "{}"))
	d.set("pack_items", packItems)
	d.set("pack_fee", p.packFee)
	d.set("stock_product", spName)
	d.set("multiplier", p.multiplier)
	d.set("stock_links", stockLinks)
	d.set("is_active", p.isActive != 0)
	return d
}

// decodeObjList 把 JSON 文本解析成 []map[string]any（非数组/坏 -> nil）。
// 用 UseNumber 保留数字原始写法（如 1.0 不会被压成 1），导出时与 Python 逐字段一致。
func decodeObjList(text string) []map[string]any {
	t := strings.TrimSpace(text)
	if t == "" || t == "null" {
		return nil
	}
	dec := json.NewDecoder(strings.NewReader(t))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(arr))
	for _, e := range arr {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		} else {
			out = append(out, map[string]any{})
		}
	}
	return out
}

// ProductDataExportPayload 生成某一类商品资料的导出内容（不落盘）。
// 未知 kind 返回 error（ValueError 文案），由 api 层处理。
func ProductDataExportPayload(ctx context.Context, q Querier, kind string) (*om, error) {
	meta, ok := ProductDataKindBy(kind)
	if !ok {
		return nil, fmt.Errorf("未知的商品资料类型: %s", kind)
	}
	var data any
	switch kind {
	case "units":
		rows, err := q.QueryContext(ctx, "SELECT COALESCE(name,''), COALESCE(category,''), gram_per_unit, COALESCE(is_standard,0) FROM units ORDER BY id")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []*om{}
		for rows.Next() {
			var name, category string
			var gram sql.NullFloat64
			var std int
			if err := rows.Scan(&name, &category, &gram, &std); err != nil {
				return nil, err
			}
			item := newOM()
			item.set("name", name)
			item.set("category", category)
			var g any
			if gram.Valid {
				g = gram.Float64
			}
			item.set("gram_per_unit", g)
			item.set("is_standard", std != 0)
			out = append(out, item)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		data = out
	case "products_stock", "products_order":
		typ := "stock"
		if kind == "products_order" {
			typ = "order"
		}
		names, err := productNamesByID(ctx, q)
		if err != nil {
			return nil, err
		}
		rows, err := q.QueryContext(ctx, "SELECT "+pdProductExportCols+" FROM products WHERE COALESCE(product_type,'stock') = ? ORDER BY category, name", typ)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []*om{}
		for rows.Next() {
			var p pdProductRow
			if err := rows.Scan(&p.id, &p.code, &p.name, &p.category, &p.productType, &p.baseUnit, &p.defaultUnit,
				&p.spec, &p.salePrice, &p.unitCost, &p.conversions, &p.packItems, &p.packFee, &p.isActive,
				&p.stockProductID, &p.multiplier, &p.stockLinks); err != nil {
				return nil, err
			}
			out = append(out, pdExportProduct(p, names))
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		data = out
	case "pack_rules":
		names, err := productNamesByID(ctx, q)
		if err != nil {
			return nil, err
		}
		rows, err := q.QueryContext(ctx, "SELECT COALESCE(name,''), COALESCE(items,'[]'), COALESCE(box_items,'[]'), COALESCE(box_type,''), labor_price, COALESCE(box_ratio,1), COALESCE(remark,''), COALESCE(is_active,0) FROM pack_rules ORDER BY id")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []*om{}
		for rows.Next() {
			var name, items, boxItems, boxType, remark string
			var lp sql.NullFloat64
			var boxRatio float64
			var act int
			if err := rows.Scan(&name, &items, &boxItems, &boxType, &lp, &boxRatio, &remark, &act); err != nil {
				return nil, err
			}
			itemOut := []*om{}
			for _, it := range decodeObjList(items) {
				spName := ""
				if spid, ok := toInt(getOr(it, "stock_product_id", nil)); ok && spid != 0 {
					if n, has := names[spid]; has {
						spName = n
					}
				}
				item := newOM()
				item.set("name", getOr(it, "name", ""))
				item.set("quantity", getOr(it, "quantity", float64(1)))
				item.set("stock_product", spName)
				item.set("multiplier", getOr(it, "multiplier", float64(1)))
				itemOut = append(itemOut, item)
			}
			boxOut := []*om{}
			for _, b := range decodeObjList(boxItems) {
				prodName := ""
				if pid, ok := toInt(getOr(b, "product_id", nil)); ok && pid != 0 {
					if n, has := names[pid]; has {
						prodName = n
					}
				}
				item := newOM()
				item.set("name", pyStr(orFallback(getOr(b, "name", ""), "")))
				item.set("product", prodName)
				item.set("quantity", getOr(b, "quantity", float64(1)))
				boxOut = append(boxOut, item)
			}
			var lpv any
			if lp.Valid {
				lpv = lp.Float64
			}
			d := newOM()
			d.set("name", name)
			d.set("items", itemOut)
			d.set("box_items", boxOut)
			d.set("box_type", boxType)
			d.set("labor_price", lpv)
			d.set("box_ratio", boxRatio)
			d.set("remark", remark)
			d.set("is_active", act != 0)
			out = append(out, d)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		data = out
	case "code_mappings":
		names, err := productNamesByID(ctx, q)
		if err != nil {
			return nil, err
		}
		rows, err := q.QueryContext(ctx, "SELECT COALESCE(source,'jushuitan'), COALESCE(external_code,''), COALESCE(external_name,''), product_id, COALESCE(auto_score,0) FROM code_mappings ORDER BY id")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []*om{}
		for rows.Next() {
			var source, extCode, extName string
			var pid sql.NullInt64
			var score float64
			if err := rows.Scan(&source, &extCode, &extName, &pid, &score); err != nil {
				return nil, err
			}
			prodName := ""
			if pid.Valid {
				if n, has := names[int(pid.Int64)]; has {
					prodName = n
				}
			}
			d := newOM()
			d.set("source", source)
			d.set("external_code", extCode)
			d.set("external_name", extName)
			d.set("product", prodName)
			d.set("auto_score", score)
			out = append(out, d)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		data = out
	}
	payload := newOM()
	payload.set("kind", kind)
	payload.set("label", meta.Label)
	payload.set("file", meta.File)
	payload.set("exported_at", pdNow())
	payload.set(meta.ListKey, data)
	return payload, nil
}

// pdNow 等价 datetime.now().strftime("%Y-%m-%d %H:%M:%S")。
func pdNow() string { return time.Now().Format("2006-01-02 15:04:05") }

// ProductDataWriteFile 导出并写入 json 目录，返回 {kind, file, count}。
func ProductDataWriteFile(ctx context.Context, q Querier, dir, kind string) (map[string]any, error) {
	meta, _ := ProductDataKindBy(kind)
	payload, err := ProductDataExportPayload(ctx, q, kind)
	if err != nil {
		return nil, err
	}
	count := 0
	if arr, ok := payload.vals[meta.ListKey].([]*om); ok {
		count = len(arr)
	}
	raw, err := marshalIndentNoEscape(payload)
	if err != nil {
		return nil, err
	}
	fp := filepath.Join(dir, meta.File)
	if err := os.WriteFile(fp, raw, 0o644); err != nil {
		return nil, err
	}
	return map[string]any{"kind": kind, "file": meta.File, "count": count}, nil
}

// marshalIndentNoEscape 缩进 2、保留中文、无尾换行（对齐 json.dumps(payload, ensure_ascii=False, indent=2)）。
func marshalIndentNoEscape(v any) ([]byte, error) {
	b, err := marshalNoEscape(v)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, b, "", "  "); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ProductDataExportAll 一键导出全部 5 类到 json 目录。
func ProductDataExportAll(ctx context.Context, q Querier, dir string) (map[string]any, error) {
	files := []map[string]any{}
	for _, k := range ProductDataImportOrder {
		f, err := ProductDataWriteFile(ctx, q, dir, k)
		if err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return map[string]any{"ok": true, "exported_at": pdNow(), "files": files}, nil
}

// ---------------- 状态对照 ----------------

// ProductDataStatus json 目录与数据库的对照状态。
func ProductDataStatus(ctx context.Context, q Querier, dir string) (map[string]any, error) {
	rows := []map[string]any{}
	for _, kind := range ProductDataImportOrder {
		meta, _ := ProductDataKindBy(kind)
		fp := filepath.Join(dir, meta.File)
		row := map[string]any{}
		if st, err := os.Stat(fp); err == nil {
			countInFile := 0
			if raw, err := os.ReadFile(fp); err == nil {
				var payload map[string]any
				if json.Unmarshal(raw, &payload) == nil {
					if arr, ok := payload[meta.ListKey].([]any); ok {
						countInFile = len(arr)
					}
				}
			}
			mtime := time.Unix(st.ModTime().Unix(), 0).Format("2006-01-02 15:04:05")
			row["kind"] = kind
			row["file"] = meta.File
			row["label"] = meta.Label
			row["count_in_db"] = pdCountDB(ctx, q, kind)
			row["exists"] = true
			row["size"] = int(st.Size())
			row["mtime"] = mtime
			row["count_in_file"] = countInFile
		} else {
			row["kind"] = kind
			row["file"] = meta.File
			row["label"] = meta.Label
			row["count_in_db"] = pdCountDB(ctx, q, kind)
			row["exists"] = false
			row["count_in_file"] = 0
		}
		rows = append(rows, row)
	}
	return map[string]any{"dir": dir, "rows": rows}, nil
}

func pdCountDB(ctx context.Context, q Querier, kind string) int {
	var n int
	switch kind {
	case "units":
		_ = q.QueryRowContext(ctx, "SELECT COUNT(1) FROM units").Scan(&n)
	case "products_stock":
		_ = q.QueryRowContext(ctx, "SELECT COUNT(1) FROM products WHERE COALESCE(product_type,'stock') = 'stock'").Scan(&n)
	case "products_order":
		_ = q.QueryRowContext(ctx, "SELECT COUNT(1) FROM products WHERE COALESCE(product_type,'stock') = 'order'").Scan(&n)
	case "pack_rules":
		_ = q.QueryRowContext(ctx, "SELECT COUNT(1) FROM pack_rules").Scan(&n)
	case "code_mappings":
		_ = q.QueryRowContext(ctx, "SELECT COUNT(1) FROM code_mappings").Scan(&n)
	}
	return n
}
