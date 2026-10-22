package api

// 本文件是「商品主数据解耦」接口层，路径/文案与 Python routers/product_data.py 逐一对齐。
// 注意注册顺序：/kinds、/status 必须先于 /{kind}，否则详情通配路由会吃掉前两个。

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"path/filepath"

	"wsfc-erp-go/internal/database"
	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// registerProductData 由主控在 routes.go 里调用。
func (s *Server) registerProductData(rt *router) {
	rt.Get("/api/product-data/kinds", s.ProductDataKinds)
	rt.Get("/api/product-data/status", s.ProductDataStatus)
	rt.Post("/api/product-data/export", s.ProductDataExport)
	rt.Post("/api/product-data/import", s.ProductDataImportAllHandler)
	rt.Post("/api/product-data/import-one", s.ProductDataImportOne)
	rt.Get("/api/product-data/{kind}", s.ProductDataGetPayload)
	rt.Post("/api/product-data/import/{kind}", s.ProductDataImportKind)
}

// productDataDir 本请求分仓的 json 目录（奥斯迪用 backend/json，其余用 backend/json/{key}）。
func (s *Server) productDataDir(r *http.Request) (string, error) {
	base := s.Cfg.JSONDir()
	dir := base
	key := web.Warehouse(r)
	// Python 的 _json_dir 比较的是常量 DEFAULT_WAREHOUSE_KEY("aosidi")，不是注册表里的默认分仓。
	if key != "" && key != database.DefaultWarehouseKey {
		dir = filepath.Join(base, key)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// ProductDataKinds GET /api/product-data/kinds —— 类目枚举。
func (s *Server) ProductDataKinds(w http.ResponseWriter, r *http.Request) {
	ks := erp.ProductDataKinds()
	arr := make([]map[string]any, 0, len(ks))
	for _, k := range ks {
		arr = append(arr, map[string]any{"kind": k.Kind, "file": k.File, "label": k.Label})
	}
	web.Write(w, http.StatusOK, map[string]any{"kinds": arr})
}

// ProductDataStatus GET /api/product-data/status —— json 目录与数据库对照状态。
func (s *Server) ProductDataStatus(w http.ResponseWriter, r *http.Request) {
	dir, err := s.productDataDir(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := erp.ProductDataStatus(r.Context(), MustDB(r), dir)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ProductDataGetPayload GET /api/product-data/{kind} —— 返回某一类导出内容（不落盘）。
func (s *Server) ProductDataGetPayload(w http.ResponseWriter, r *http.Request) {
	kind := PathValue(r, "kind")
	if _, ok := erp.ProductDataKindBy(kind); !ok {
		arr := []string{}
		for _, k := range erp.ProductDataKinds() {
			arr = append(arr, k.Kind)
		}
		web.Write(w, http.StatusOK, map[string]any{"error": "未知类型 " + kind, "kinds": arr})
		return
	}
	out, err := erp.ProductDataExportPayload(r.Context(), MustDB(r), kind)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ProductDataExport POST /api/product-data/export —— 一键导出全部 5 类到 json 目录。
func (s *Server) ProductDataExport(w http.ResponseWriter, r *http.Request) {
	dir, err := s.productDataDir(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out, err := erp.ProductDataExportAll(r.Context(), MustDB(r), dir)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ProductDataImportAllHandler POST /api/product-data/import —— 从 json 目录一键导入全部 5 类。
// 逐类各自落库（等价 Python 每类一次 commit），失败记进该类 warnings。
func (s *Server) ProductDataImportAllHandler(w http.ResponseWriter, r *http.Request) {
	dir, err := s.productDataDir(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	out := erp.ProductDataImportAll(r.Context(), MustDB(r), dir)
	web.Write(w, http.StatusOK, out)
}

// ProductDataImportOne POST /api/product-data/import-one —— 接收前端单个 json 载荷并导入。
func (s *Server) ProductDataImportOne(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	payload, _ := body["payload"].(map[string]any)
	if payload == nil {
		payload = map[string]any{}
	}
	kindVal := payload["kind"]
	kindStr, _ := kindVal.(string)
	if _, ok := erp.ProductDataKindBy(kindStr); !ok {
		// 对齐 Python import_payload 的 raise ValueError(...) -> HTTPException(400, str(e))
		web.Error(w, http.StatusBadRequest, "未知的商品资料类型: %s", pdKindStr(kindVal))
		return
	}
	res, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		return erp.ProductDataImportPayload(ctx, tx, payload)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, res)
}

// ProductDataImportKind POST /api/product-data/import/{kind} —— 从 json 目录导入某一类。
func (s *Server) ProductDataImportKind(w http.ResponseWriter, r *http.Request) {
	kind := PathValue(r, "kind")
	if _, ok := erp.ProductDataKindBy(kind); !ok {
		arr := []string{}
		for _, k := range erp.ProductDataKinds() {
			arr = append(arr, k.Kind)
		}
		web.Write(w, http.StatusOK, map[string]any{"error": "未知类型 " + kind, "kinds": arr})
		return
	}
	dir, err := s.productDataDir(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	meta, _ := erp.ProductDataKindBy(kind)
	fp := filepath.Join(dir, meta.File)
	if _, err := os.Stat(fp); err != nil {
		// Python: import_from_file 缺文件 -> FileNotFoundError -> HTTPException(400, "缺少 {fname}")
		web.Error(w, http.StatusBadRequest, "缺少 %s", meta.File)
		return
	}
	res, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		return erp.ProductDataImportFromFile(ctx, tx, dir, kind)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, res)
}

// pdKindStr 复刻 Python f-string 对 kind 取 str：None->"None"，字符串原样。
func pdKindStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return "None"
	}
	return web.ToStr(v)
}
