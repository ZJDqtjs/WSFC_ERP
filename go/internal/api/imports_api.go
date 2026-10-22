package api

// 本文件是批量导入模块（imports）的接口层：模板下载、商品/入库/出库导入、
// 聚水潭出库单解析与确认、编码关联维护。路径、方法、字段名与错误文案与
// Python routers/imports.py 逐一对齐。

import (
	"context"
	"database/sql"
	"io"
	"log"
	"net/http"
	"strings"

	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// maxImpUploadBytes 导入文件上限（与入仓贴单导入同量级，够放上万行明细）。
const maxImpUploadBytes = 50 * 1024 * 1024

// registerImports 挂导入模块全部接口。
//
// /api/mappings/{mid} 是 DELETE 通配段，必须注册在字面量路径（bulk/auto/ai-suggest）之后，
// 否则 DELETE /api/mappings 会被它抢走。
func (s *Server) registerImports(rt *router) {
	// 模板下载
	rt.Get("/api/templates/products", s.TplProducts)
	rt.Get("/api/templates/inbounds", s.TplInbounds)
	rt.Get("/api/templates/outbounds", s.TplOutbounds)
	// 商品 / 入库 / 出库批量导入
	rt.Post("/api/import/products", s.ImportProducts)
	rt.Post("/api/import/inbounds/preview", s.ImportInboundPreview)
	rt.Post("/api/import/inbounds/confirm", s.ImportInboundConfirm)
	rt.Post("/api/import/inbounds", s.ImportInbounds)
	rt.Post("/api/import/outbounds/preview", s.ImportOutboundPreview)
	rt.Post("/api/import/outbounds/confirm", s.ImportOutboundConfirm)
	rt.Post("/api/import/outbounds", s.ImportOutbounds)
	// 聚水潭出库单
	rt.Post("/api/jushuitan/import/preview", s.JstImportPreview)
	rt.Post("/api/jushuitan/import/confirm", s.JstImportConfirm)
	rt.Post("/api/jushuitan/import", s.JstImportOneShot)
	rt.Post("/api/jushuitan/parse", s.JstParse)
	rt.Post("/api/pack-rules/from-jushuitan", s.RuleFromJst)
	// 编码关联
	rt.Get("/api/mappings", s.Mappings)
	rt.Post("/api/mappings", s.SetMapping)
	rt.Post("/api/mappings/bulk", s.BulkMappings)
	rt.Post("/api/mappings/auto", s.AutoMappings)
	rt.Post("/api/mappings/ai-suggest", s.AiSuggestMappings)
	rt.Delete("/api/mappings", s.ClearMappings)
	rt.Delete("/api/mappings/{mid}", s.DeleteMapping)
}

// ---- 模板下载 ----

// impWriteXlsxResponse 输出 xlsx 附件。中文名走 RFC 5987 的 filename*=UTF-8''（Python 的
// _xlsx_response 也改成了同一种写法，直接拼 filename="..." 会让 Starlette 编响应头 500）。
func impWriteXlsxResponse(w http.ResponseWriter, r *http.Request, data []byte, filename string) {
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition",
		`attachment; filename="template.xlsx"; filename*=UTF-8''`+webEscapeFilename(filename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// webEscapeFilename 按 RFC 5987 的 attr-char 规则百分号编码（保留字母数字与 -_.~）。
func webEscapeFilename(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '-' || c == '.' || c == '_' || c == '~' {
			b.WriteByte(c)
			continue
		}
		const hex = "0123456789abcdef"
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0xf])
	}
	return b.String()
}

func (s *Server) TplProducts(w http.ResponseWriter, r *http.Request) {
	impServeTpl(w, r, "商品导入模板.xlsx", erp.ImpTplProducts)
}
func (s *Server) TplInbounds(w http.ResponseWriter, r *http.Request) {
	impServeTpl(w, r, "入库批量导入模板.xlsx", erp.ImpTplInbounds)
}
func (s *Server) TplOutbounds(w http.ResponseWriter, r *http.Request) {
	impServeTpl(w, r, "出库批量导入模板.xlsx", erp.ImpTplOutbounds)
}

func impServeTpl(w http.ResponseWriter, r *http.Request, filename string, factory func() erp.ImpXlsxSheet) {
	data, name, err := erp.ImpTemplate(filename, factory)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	impWriteXlsxResponse(w, r, data, name)
}

// ---- 上传读取 ----

// impUploadFile 读取 multipart 的 file 字段。缺字段按 Python 的校验口径回 422。
func impUploadFile(w http.ResponseWriter, r *http.Request) ([]byte, string, bool) {
	if err := r.ParseMultipartForm(maxImpUploadBytes); err != nil {
		web.Error(w, http.StatusUnprocessableEntity, "请求需为 multipart/form-data，字段名 file")
		return nil, "", false
	}
	defer r.MultipartForm.RemoveAll()
	file, hdr, err := r.FormFile("file")
	if err != nil {
		web.Error(w, http.StatusUnprocessableEntity, "缺少上传文件字段 file")
		return nil, "", false
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, int64(maxImpUploadBytes)+1))
	if err != nil {
		web.Error(w, http.StatusBadRequest, "读取文件失败")
		return nil, "", false
	}
	return raw, strings.TrimSpace(hdr.Filename), true
}

// ---- 商品导入 ----

// ImportProducts POST /api/import/products
func (s *Server) ImportProducts(w http.ResponseWriter, r *http.Request) {
	raw, _, ok := impUploadFile(w, r)
	if !ok {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpImportProducts(ctx, tx, raw)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ---- 入库导入 ----

// ImportInboundPreview POST /api/import/inbounds/preview
func (s *Server) ImportInboundPreview(w http.ResponseWriter, r *http.Request) {
	raw, _, ok := impUploadFile(w, r)
	if !ok {
		return
	}
	out, err := erp.ImpInboundPreview(r.Context(), MustDB(r), raw, Operator(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ImportInboundConfirm POST /api/import/inbounds/confirm
func (s *Server) ImportInboundConfirm(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, impConfirmInboundFields)
	if payload == nil {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpInboundConfirm(ctx, tx, erp.MapSlice(payload["items"]), Operator(r))
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ImportInbounds POST /api/import/inbounds（直传：解析 + 立即建单）
func (s *Server) ImportInbounds(w http.ResponseWriter, r *http.Request) {
	raw, _, ok := impUploadFile(w, r)
	if !ok {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpImportInbounds(ctx, tx, raw, Operator(r))
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ---- 出库导入（标准模板）----

// ImportOutboundPreview POST /api/import/outbounds/preview
func (s *Server) ImportOutboundPreview(w http.ResponseWriter, r *http.Request) {
	raw, _, ok := impUploadFile(w, r)
	if !ok {
		return
	}
	out, err := erp.ImpOutboundPreview(r.Context(), MustDB(r), raw, Operator(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ImportOutboundConfirm POST /api/import/outbounds/confirm
func (s *Server) ImportOutboundConfirm(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, impConfirmOutFields)
	if payload == nil {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpConfirmOrders(ctx, tx, erp.ImpDraftOrdersFromPayload(payload), Operator(r))
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ImportOutbounds POST /api/import/outbounds（直传：解析 + 立即建单）
func (s *Server) ImportOutbounds(w http.ResponseWriter, r *http.Request) {
	raw, _, ok := impUploadFile(w, r)
	if !ok {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpImportOutbounds(ctx, tx, raw, Operator(r))
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ---- 聚水潭出库单 ----

// JstImportPreview POST /api/jushuitan/import/preview
func (s *Server) JstImportPreview(w http.ResponseWriter, r *http.Request) {
	raw, _, ok := impUploadFile(w, r)
	if !ok {
		return
	}
	res, err := erp.ImpParseJstDraft(r.Context(), MustDB(r), raw, Operator(r), []string{"已出库"})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	orders := make([]map[string]any, 0, len(res.Drafts))
	for _, d := range res.Drafts {
		orders = append(orders, d.JSON())
	}
	notices := make([]map[string]any, 0)
	for _, f := range res.Failed {
		if f["level"] == "warn" {
			notices = append(notices, f)
		}
	}
	web.Write(w, http.StatusOK, map[string]any{
		"orders": orders, "skip": res.Skip.JSON(), "failed": res.Failed, "failed_count": len(res.Failed),
		"notices":               notices,
		"unmapped_codes":        res.UnmappedCodes,
		"unmapped":              res.Unmapped,
		"unmatched_multi":       res.UnmatchedMulti,
		"brush_warehouses":      res.BrushWarehouses(),
		"brush_warehouse_names": erp.BrushWarehouses,
		"brush_default_fee":     erp.ImpBrushDefaultFee(),
	})
}

// JstImportConfirm POST /api/jushuitan/import/confirm（确认后建单，并在「自动出库设置 → 执行记录」留痕）
func (s *Server) JstImportConfirm(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, impConfirmOutFields)
	if payload == nil {
		return
	}
	op := Operator(r)
	orders := erp.ImpDraftOrdersFromPayload(payload)
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpConfirmOrders(ctx, tx, orders, op)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	res, _ := out.(map[string]any)
	dates := make([]string, 0, len(orders))
	for _, o := range orders {
		dates = append(dates, o.Date)
	}
	s.impLogManualJst(r, strings.TrimSpace(erp.ToStr(payload["source"])), res, dates,
		"由「出库/销售 → 导入聚水潭出库单」逐单确认")
	web.Write(w, http.StatusOK, out)
}

// JstImportOneShot POST /api/jushuitan/import（设置页的旧「一键导入」入口，与出库页同一套解析+落库）
func (s *Server) JstImportOneShot(w http.ResponseWriter, r *http.Request) {
	raw, filename, ok := impUploadFile(w, r)
	if !ok {
		return
	}
	var body, logRes map[string]any
	var dates []string
	var note string
	err := WithTxMust(r, func(ctx context.Context, tx *sql.Tx) error {
		res, l, d, n, err := erp.ImpJstOneShot(ctx, tx, raw, Operator(r))
		if err != nil {
			return Err400(err)
		}
		body, logRes, dates, note = res, l, d, n
		return nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	s.impLogManualJst(r, filename, logRes, dates, note)
	web.Write(w, http.StatusOK, body)
}

// JstParse POST /api/jushuitan/parse（关联页：发现商品并自动新增品类，会写库）
func (s *Server) JstParse(w http.ResponseWriter, r *http.Request) {
	raw, _, ok := impUploadFile(w, r)
	if !ok {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpJstDiscoverCodes(ctx, tx, raw)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// RuleFromJst POST /api/pack-rules/from-jushuitan（把手动补选的组合写成一单多货规则）
func (s *Server) RuleFromJst(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, impJstRuleInFields)
	if payload == nil {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpRuleFromJst(ctx, tx, erp.MapSlice(payload["items"]))
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// impLogManualJst 古法导入执行记录。Python 整段包在 try/except 里：记失败不能影响导入本身。
func (s *Server) impLogManualJst(r *http.Request, source string, res map[string]any, dates []string, note string) {
	if res == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[imports] 古法导入执行记录写入失败: %v", rec)
		}
	}()
	key := web.Warehouse(r)
	erp.ImpLogManualJstImport(key, s.Mgr.Registry.Name(key), source, res, dates, note)
}

// ---- 编码关联 ----

// Mappings GET /api/mappings
func (s *Server) Mappings(w http.ResponseWriter, r *http.Request) {
	out, err := erp.ImpListMappings(r.Context(), MustDB(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// SetMapping POST /api/mappings
func (s *Server) SetMapping(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, impMappingInFields)
	if payload == nil {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpSetMapping(ctx, tx, erp.ToStr(payload["source"]), erp.ToStr(payload["external_code"]),
			erp.OptInt(payload, "product_id"))
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// BulkMappings POST /api/mappings/bulk
func (s *Server) BulkMappings(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, impMappingBulkInFields)
	if payload == nil {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpBulkMappings(ctx, tx, erp.ToStr(payload["source"]), erp.MapSlice(payload["items"]))
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// AutoMappings POST /api/mappings/auto
func (s *Server) AutoMappings(w http.ResponseWriter, r *http.Request) {
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpAutoMappings(ctx, tx)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// AiSuggestMappings POST /api/mappings/ai-suggest（apply=false 只试算，true 才落库）
func (s *Server) AiSuggestMappings(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, impAiMappingsInFields)
	if payload == nil {
		return
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpAiSuggestMappings(ctx, tx, payload)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// ClearMappings DELETE /api/mappings
func (s *Server) ClearMappings(w http.ResponseWriter, r *http.Request) {
	source := r.URL.Query().Get("source")
	if source == "" {
		source = "jushuitan"
	}
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpClearMappings(ctx, tx, source)
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}

// DeleteMapping DELETE /api/mappings/{mid}
func (s *Server) DeleteMapping(w http.ResponseWriter, r *http.Request) {
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		res, err := erp.ImpDeleteMapping(ctx, tx, PathInt(r, "mid"))
		return res, Err400(err)
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, out)
}
