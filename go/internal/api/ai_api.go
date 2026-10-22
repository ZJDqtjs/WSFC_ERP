package api

// AI 智能录入模块（routers/ai.py）的接口层：文本解析、流式解析、票据图片流式解析、
// 出库确认框重算、新商品建档、最近单价回填。识别/匹配/换算的重活都在 internal/erp/ai_*.go，
// 这里只做「参数校验 → 调用 → 按 Python 的状态码与文案写响应」。
//
// 沙箱环境没有 LLM key，流式与 LLM 分支只能验证到 400「未配置 LLM」；
// 本地快速解析（_quick_parse_text）不走大模型，是可与 Python 逐字节比对的确定性路径。

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// registerAI 挂 AI 模块全部接口。
func (s *Server) registerAI(rt *router) {
	// erp 侧的 LLM 配置/票据目录是包级变量（对齐 Python 的 REPO_ROOT、backend/data/uploads），
	// 不在这里接上就一直是大写空串 → AILLMConfig 永远返回空 → 所有识别接口都报「未配置 LLM」。
	erp.AIRulesFile = filepath.Join(s.Cfg.RepoRoot(), "product_rules.json")
	erp.AILocalFile = filepath.Join(s.Cfg.RepoRoot(), "config.local.json")
	erp.AIUploadDir = s.Cfg.UploadDir()
	rt.Post("/api/ai/parse", s.AIParse)
	rt.Post("/api/ai/parse/stream", s.AIParseStream)
	rt.Post("/api/ai/parse-image/stream", s.AIParseImageStream)
	rt.Post("/api/ai/outbound-preview", s.AIOutboundPreview)
	rt.Post("/api/ai/products", s.AIMaterializeProducts)
	rt.Get("/api/ai/last-price", s.AILastPrice)
	rt.Get("/api/ai/memories", s.AIListMemories)
	rt.Post("/api/ai/memories", s.AIAddMemory)
	rt.Delete("/api/ai/memories/{mem_id}", s.AIDeleteMemory)
	rt.Delete("/api/ai/memories", s.AIClearMemories)
}

// ---- 公共小工具 ----

// aiHasLLMKey 等价 Python 的 `if not cfg.get("api_key")`（空串/缺失/False 都算没配）。
func aiHasLLMKey(cfg map[string]any) bool {
	switch v := cfg["api_key"].(type) {
	case nil:
		return false
	case string:
		return v != ""
	case bool:
		return v
	}
	return true
}

// aiLLMConfigOr400 取 llm 配置，没配 key 时按 Python 文案回 400（返回 false 表示已写完响应）。
func aiLLMConfigOr400(w http.ResponseWriter) (map[string]any, bool) {
	cfg := erp.AILLMConfig()
	if !aiHasLLMKey(cfg) {
		web.Error(w, http.StatusBadRequest, "未配置 LLM（product_rules.json 的 llm 段）")
		return nil, false
	}
	return cfg, true
}

// aiIsBiz 判断错误是不是 Python 的 HTTPException（业务 400/404），它不该被包成 502。
func aiIsBiz(err error) bool {
	var be *erp.BizError
	return errors.As(err, &be)
}

// aiLLMFail502 等价 Python 的 `raise HTTPException(502, f"调用/解析大模型失败：{type(e).__name__}: {e}")`。
func aiLLMFail502(w http.ResponseWriter, r *http.Request, err error) {
	if aiIsBiz(err) {
		web.WriteValue(w, r, err)
		return
	}
	web.Error(w, http.StatusBadGateway, "调用/解析大模型失败：%s", erp.ErrTextOf(err))
}

// aiErrorText 流式里的错误文案：HTTPException 给原文案，其它给「类型名: 文案」。
func aiErrorText(err error) string {
	var be *erp.BizError
	if errors.As(err, &be) {
		return be.Msg
	}
	return erp.ErrTextOf(err)
}

// aiJObjList 把请求里的 dict 数组转成按 Python 口径输出的有序对象列表。
func aiJObjList(v any) []*erp.JObj {
	out := []*erp.JObj{}
	for _, m := range erp.MapSlice(v) {
		out = append(out, erp.NewJFromMap(m))
	}
	return out
}

// aiWrite 用 starlette JSONResponse 的口径输出（紧凑分隔符 + Python 浮点 + 键的插入顺序）。
// 响应体里带 *erp.JObj 时必须走它：encoding/json 不认识 JObj，会写成空对象。
func aiWrite(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(erp.AIJSONCompact(v))
}

// aiSSE 是 StreamingResponse(media_type="text/event-stream") 的等价写出器。
type aiSSE struct {
	w  http.ResponseWriter
	fl http.Flusher
}

func aiNewSSE(w http.ResponseWriter) *aiSSE {
	fl, ok := w.(http.Flusher)
	if !ok {
		web.Error(w, http.StatusInternalServerError, "当前服务不支持流式响应")
		return nil
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	return &aiSSE{w: w, fl: fl}
}

// send 输出一条 `data: {json}\n\n`（json.dumps(obj, ensure_ascii=False) 口径）。
// 返回 error 表示客户端已断开，调用方据此停止后续大模型请求。
func (e *aiSSE) send(obj *erp.JObj) error {
	if _, err := e.w.Write(append([]byte("data: "), erp.AIJSONSpaced(obj)...)); err != nil {
		return err
	}
	if _, err := e.w.Write([]byte("\n\n")); err != nil {
		return err
	}
	e.fl.Flush()
	return nil
}

func (e *aiSSE) stage(text string) error { return e.send(erp.NewJ().Set("stage", text)) }

func (e *aiSSE) sendError(err error) error {
	return e.send(erp.NewJ().Set("error", aiErrorText(err)))
}

func (e *aiSSE) done() { _ = e.send(erp.NewJ().Set("done", true)) }

// aiNote 一条待记忆的「补充说明 → 来源」。
type aiNote struct {
	Text string
	Src  string
}

// aiRemember 逐条把规则型说明记进 AI 记忆，真正新增/恢复的才推 {"memory": …} 给前端。
// 返回 error 表示客户端已断开。
func aiRemember(ctx context.Context, db *sql.DB, sse *aiSSE, notes []aiNote) error {
	for _, n := range notes {
		mem := erp.AIRememberNote(ctx, db, n.Text, n.Src)
		if mem == nil || !(erp.ToBool(mem.Get("added")) || erp.ToBool(mem.Get("reactivated"))) {
			continue
		}
		if err := sse.send(erp.NewJ().Set("memory", mem)); err != nil {
			return err
		}
	}
	return nil
}

// ---- POST /api/ai/parse ----

func (s *Server) AIParse(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, aiParseInFields)
	if payload == nil {
		return
	}
	text := strings.TrimSpace(erp.ToStr(payload["text"]))
	if text == "" {
		web.Error(w, http.StatusBadRequest, "请输入描述文字")
		return
	}
	ctx, db := r.Context(), MustDB(r)
	// 本地快速解析命中：直接出结果（Python 里这一步的 HTTPException 会原样抛出，不再走大模型）
	if quick := erp.AIQuickParseText(text); quick != nil {
		res, err := erp.AIBuildResult(ctx, db, quick, text)
		if err != nil {
			web.WriteValue(w, r, err)
			return
		}
		aiWrite(w, http.StatusOK, res)
		return
	}
	cfg, ok := aiLLMConfigOr400(w)
	if !ok {
		return
	}
	content, err := erp.AIChatAgent(ctx, cfg, erp.SYSTEM_PROMPT, erp.AIUserMsg(text), db, 3, 1600)
	if err != nil {
		aiLLMFail502(w, r, err)
		return
	}
	parsed, err := erp.AIExtractJSON(content)
	if err != nil {
		aiLLMFail502(w, r, err)
		return
	}
	res, err := erp.AIBuildResult(ctx, db, parsed, text)
	if err != nil {
		aiLLMFail502(w, r, err)
		return
	}
	aiWrite(w, http.StatusOK, res)
}

// ---- POST /api/ai/parse/stream ----

func (s *Server) AIParseStream(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, aiParseInFields)
	if payload == nil {
		return
	}
	text := strings.TrimSpace(erp.ToStr(payload["text"]))
	if text == "" {
		web.Error(w, http.StatusBadRequest, "请输入描述文字")
		return
	}
	cfg, ok := aiLLMConfigOr400(w)
	if !ok {
		return
	}
	hint := strings.TrimSpace(erp.ToStr(payload["hint"]))
	prev := erp.ToStr(payload["prev"])
	sse := aiNewSSE(w)
	if sse == nil {
		return
	}
	defer sse.done()

	ctx, db := r.Context(), MustDB(r)
	// 记忆：这次说的若是「别名对应 / 装箱换算」这类规则，自动记下来（回执推给前端提示）
	if err := aiRemember(ctx, db, sse, []aiNote{{text, "text"}, {erp.ToStr(payload["hint"]), "hint"}}); err != nil {
		return
	}
	// 追问（连续对话）时不走本地快速识别：用户要的是按他的要求重新识别
	if hint == "" {
		if quick := erp.AIQuickParseText(text); quick != nil {
			if res, err := erp.AIBuildResult(ctx, db, quick, text); err == nil {
				_ = sse.send(erp.NewJ().Set("result", res).Set("source", "quick").Set("confidence", "high"))
				return
			}
		}
	}
	stage := "正在调用大模型识别…"
	if hint != "" {
		stage = "正在按你的要求重新识别…"
	}
	if err := sse.stage(stage); err != nil {
		return
	}

	userMsg := erp.AIUserMsg(text) + erp.AIMemoryBlock(ctx, db, text) + erp.AIFollowupBlock(prev, hint)
	buf := ""
	err := erp.AIStreamAgent(ctx, cfg, erp.SYSTEM_PROMPT, erp.AITextContent(userMsg), db, 3, 1600, true,
		func(p erp.AIPiece) error {
			switch p.Kind {
			case "think":
				return sse.send(erp.NewJ().Set("think", p.Text))
			case "content":
				buf += p.Text
				return sse.send(erp.NewJ().Set("delta", p.Text))
			}
			return sse.stage("🤖 " + p.Text)
		})
	if err != nil {
		if aiIsBiz(err) || errors.Is(err, context.Canceled) {
			_ = sse.sendError(err)
			return
		}
		_ = sse.sendError(err)
		return
	}

	parsed, perr := erp.AIExtractJSON(buf)
	if perr != nil {
		parsed = nil
	}
	if len(parsed) == 0 || len(erp.MapSlice(parsed["lines"])) == 0 {
		// 工具没查到、模型也没给出明细 → 再跑一次「不用工具」，让它照原始内容输出（走新建流程）
		if err := sse.stage("没对上库存资料，再按原始内容识别一次…"); err != nil {
			return
		}
		buf2 := ""
		if err := erp.AIStreamAgent(ctx, cfg, erp.SYSTEM_PROMPT, erp.AITextContent(userMsg), db, 3, 4200, false,
			func(p erp.AIPiece) error {
				if p.Kind == "content" {
					buf2 += p.Text
				}
				return nil
			}); err != nil {
			_ = sse.sendError(err)
			return
		}
		if strings.TrimSpace(buf2) != "" {
			if p2, e2 := erp.AIExtractJSON(buf2); e2 == nil {
				parsed = p2
			}
		}
	}
	if parsed == nil {
		parsed = map[string]any{}
	}
	res, err := erp.AIBuildResult(ctx, db, parsed, text)
	if err != nil {
		_ = sse.sendError(err)
		return
	}
	_ = sse.send(erp.NewJ().Set("result", res).Set("source", "llm").Set("confidence", "high"))
}

// ---- POST /api/ai/parse-image/stream ----

func (s *Server) AIParseImageStream(w http.ResponseWriter, r *http.Request) {
	// FastAPI 先做参数校验（file 必填），所以缺文件是 422，未配置 LLM 才是 400
	if err := r.ParseMultipartForm(maxImpUploadBytes); err != nil {
		aiFileMissing422(w)
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, hdr, err := r.FormFile("file")
	if err != nil {
		// 段在但没有文件名：Go 与 FastAPI 一样把它当普通字符串字段（只是报错文案不同）
		if vals := r.MultipartForm.Value["file"]; len(vals) > 0 {
			aiFileNotUpload422(w, vals[0])
			return
		}
		aiFileMissing422(w)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(file, int64(maxImpUploadBytes)+1))
	_ = file.Close()
	if err != nil {
		web.Error(w, http.StatusBadRequest, "读取文件失败")
		return
	}
	cfg, ok := aiLLMConfigOr400(w)
	if !ok {
		return
	}
	if len(raw) == 0 {
		web.Error(w, http.StatusBadRequest, "未读取到图片内容")
		return
	}
	filename := hdr.Filename
	if filename == "" {
		filename = "invoice.jpg" // Python: file.filename or "invoice.jpg"
	}
	imageURL, err := erp.AISaveInvoice(raw, filename)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	text := r.FormValue("text")
	hint := r.FormValue("hint")
	prev := r.FormValue("prev")

	sse := aiNewSSE(w)
	if sse == nil {
		return
	}
	defer sse.done()

	ctx, db := r.Context(), MustDB(r)
	// 补充说明里若有「别名 -> 正式名称」，先记进 AI 记忆（回执推给前端提示）
	if err := aiRemember(ctx, db, sse, []aiNote{{text, "image"}, {hint, "hint"}}); err != nil {
		return
	}
	userMsg := erp.AIImageUserMsg(text) + erp.AIMemoryBlock(ctx, db, text) + erp.AIFollowupBlock(prev, hint)
	userContent := erp.AIImageContent(userMsg, erp.AIImageDataURI(raw, filename))

	stage := "正在调用大模型识别票据…"
	if strings.TrimSpace(hint) != "" {
		stage = "正在按你的要求重新识别票据…"
	}
	if err := sse.stage(stage); err != nil {
		return
	}
	buf := ""
	if err := erp.AIStreamAgent(ctx, cfg, erp.IMAGE_SYSTEM_PROMPT, userContent, db, 3, 3200, true,
		func(p erp.AIPiece) error {
			switch p.Kind {
			case "think":
				return sse.send(erp.NewJ().Set("think", p.Text))
			case "content":
				buf += p.Text
				return sse.send(erp.NewJ().Set("delta", p.Text))
			}
			return sse.stage("🤖 " + p.Text)
		}); err != nil {
		_ = sse.sendError(err)
		return
	}
	parsed, perr := erp.AIExtractJSON(buf)
	if perr != nil {
		parsed = nil
	}
	if len(parsed) == 0 || len(erp.MapSlice(parsed["lines"])) == 0 {
		if err := sse.stage("没对上库存资料，再按票据原文识别一次…"); err != nil {
			return
		}
		buf2 := ""
		if err := erp.AIStreamAgent(ctx, cfg, erp.IMAGE_SYSTEM_PROMPT, userContent, db, 3, 4200, false,
			func(p erp.AIPiece) error {
				if p.Kind == "content" {
					buf2 += p.Text
				}
				return nil
			}); err != nil {
			_ = sse.sendError(err)
			return
		}
		if strings.TrimSpace(buf2) != "" {
			if p2, e2 := erp.AIExtractJSON(buf2); e2 == nil {
				parsed = p2
			}
		}
	}
	if parsed == nil {
		parsed = map[string]any{}
	}
	fallback := text
	if fallback == "" {
		fallback = "(图片票据识别)"
	}
	res, err := erp.AIBuildResult(ctx, db, parsed, fallback)
	if err != nil {
		_ = sse.sendError(err)
		return
	}
	res.Set("image_url", imageURL) // 供前端确认框展示与备注挂图
	_ = sse.send(erp.NewJ().Set("result", res))
}

// aiFileMissing422 复刻 FastAPI 对缺失必填 File 参数的校验响应。
func aiFileMissing422(w http.ResponseWriter) {
	web.Write(w, http.StatusUnprocessableEntity, map[string]any{"detail": []any{map[string]any{
		"type": "missing", "loc": []any{"body", "file"}, "msg": "Field required", "input": nil,
	}}})
}

// aiFileNotUpload422：带 file 段但没有文件名时，FastAPI 把它当字符串字段并报 value_error。
// input 是那一节的原始内容（Python 按文本解码，这里同样尽力还原为字符串）。
func aiFileNotUpload422(w http.ResponseWriter, val string) {
	web.Write(w, http.StatusUnprocessableEntity, map[string]any{"detail": []any{map[string]any{
		"type": "value_error", "loc": []any{"body", "file"},
		"msg":   "Value error, Expected UploadFile, received: <class 'str'>",
		"input": val, "ctx": map[string]any{"error": map[string]any{}},
	}}})
}

// ---- POST /api/ai/outbound-preview ----

func (s *Server) AIOutboundPreview(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, aiOutboundPreviewFields)
	if payload == nil {
		return
	}
	result := erp.NewJ().Set("type", "outbound").Set("lines", aiJObjList(payload["lines"]))
	var feeOverride *float64
	if v := payload["fee_total"]; v != nil {
		f := erp.ToFloat(v)
		feeOverride = &f
	}
	erp.AIAttachOutboundCharges(r.Context(), MustDB(r), result,
		map[string]any{"charges": payload["charges"]}, feeOverride)

	get := func(k string, def any) any {
		v := result.Get(k)
		if v == nil {
			return def
		}
		return v
	}
	autoExpress := true
	if v, ok := result.Get("auto_express").(bool); ok {
		autoExpress = v
	}
	aiWrite(w, http.StatusOK, erp.NewJ().
		Set("pack_lines", orEmptyList(get("pack_lines", nil))).
		Set("preview", result.Get("preview")).
		Set("preview_hint", orEmptyStr(get("preview_hint", nil))).
		Set("fee_total", result.Get("fee_total")).
		Set("fee_note", orEmptyStr(get("fee_note", nil))).
		Set("charges", orEmptyList(get("charges", nil))).
		Set("settle_cats", orEmptyStr(get("settle_cats", nil))).
		Set("auto_express", autoExpress).
		Set("extra_pack_lines", orEmptyList(get("extra_pack_lines", nil))).
		Set("warnings", orEmptyList(get("warnings", nil))))
}

func orEmptyList(v any) any {
	if v == nil {
		return []any{}
	}
	if arr, ok := v.([]*erp.JObj); ok && arr == nil {
		return []any{}
	}
	return v
}

func orEmptyStr(v any) any {
	s, _ := v.(string)
	if v == nil || s == "" {
		return ""
	}
	return v
}

// ---- POST /api/ai/products ----

func (s *Server) AIMaterializeProducts(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, aiMaterializeInFields)
	if payload == nil {
		return
	}
	items := erp.MapSlice(payload["items"])
	out, err := WithTx(r, func(ctx context.Context, tx *sql.Tx) (any, error) {
		list, err := erp.AIMaterialize(ctx, tx, items)
		if err != nil {
			return nil, Err400(err)
		}
		return map[string]any{"items": list}, nil
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	aiWrite(w, http.StatusOK, out)
}

// ---- GET /api/ai/last-price ----

func (s *Server) AILastPrice(w http.ResponseWriter, r *http.Request) {
	pid, ok := aiQueryIntRequired(w, r, "product_id")
	if !ok {
		return
	}
	// 缺省取 FastAPI 的参数默认值（显式传空串则原样回显空串）
	opType := "inbound"
	if vals, ok := r.URL.Query()["op_type"]; ok {
		opType = vals[0]
	}
	calcType := "inbound"
	if opType == "outbound" {
		calcType = "outbound"
	}
	p, err := erp.GetProduct(r.Context(), MustDB(r), pid)
	if err != nil {
		web.WriteValue(w, r, NotFoundOr(err, "商品不存在"))
		return
	}
	unit := p.DefaultUnit
	if unit == "" {
		unit = p.BaseUnit
	}
	aiWrite(w, http.StatusOK, erp.NewJ().
		Set("product_id", p.ID).
		Set("price", erp.F(erp.AILastPriceDefault(r.Context(), MustDB(r), p, calcType))).
		Set("unit", unit).
		Set("op_type", opType))
}

// aiQueryIntRequired 复刻 FastAPI 必填 int 查询参数：缺失 → 422 missing，无法解析 → 422 int_parsing。
func aiQueryIntRequired(w http.ResponseWriter, r *http.Request, name string) (int, bool) {
	vals, present := r.URL.Query()[name]
	if !present {
		web.Write(w, http.StatusUnprocessableEntity, map[string]any{"detail": []any{map[string]any{
			"type": "missing", "loc": []any{"query", name}, "msg": "Field required", "input": nil,
		}}})
		return 0, false
	}
	raw := vals[0]
	if s := strings.TrimSpace(raw); isPlainInt(s) {
		if n, err := strconv.Atoi(s); err == nil {
			return n, true
		}
	}
	web.Write(w, http.StatusUnprocessableEntity, map[string]any{"detail": []any{map[string]any{
		"type": "int_parsing", "loc": []any{"query", name},
		"msg":   "Input should be a valid integer, unable to parse string as an integer",
		"input": raw,
	}}})
	return 0, false
}

// ---- AI 记忆管理 /api/ai/memories ----

func (s *Server) AIListMemories(w http.ResponseWriter, r *http.Request) {
	rows, err := erp.AIMemoriesList(r.Context(), MustDB(r))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	aiWrite(w, http.StatusOK, rows)
}

func (s *Server) AIAddMemory(w http.ResponseWriter, r *http.Request) {
	payload := whBindOr422(w, r, aiMemoryInFields)
	if payload == nil {
		return
	}
	out, err := erp.AIAddMemory(r.Context(), MustDB(r), erp.ToStr(payload["text"]))
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	aiWrite(w, http.StatusOK, out)
}

func (s *Server) AIDeleteMemory(w http.ResponseWriter, r *http.Request) {
	id, ok := aiPathInt(w, r, "mem_id")
	if !ok {
		return
	}
	if err := erp.AIDeleteMemory(r.Context(), MustDB(r), id); err != nil {
		web.WriteValue(w, r, err)
		return
	}
	aiWrite(w, http.StatusOK, erp.NewJ().Set("ok", true))
}

func (s *Server) AIClearMemories(w http.ResponseWriter, r *http.Request) {
	if err := erp.AIClearMemories(r.Context(), MustDB(r)); err != nil {
		web.WriteValue(w, r, err)
		return
	}
	aiWrite(w, http.StatusOK, erp.NewJ().Set("ok", true))
}

// aiPathInt 复刻 FastAPI 的 int 路径参数：无法解析 → 422 int_parsing（loc 是 path）。
func aiPathInt(w http.ResponseWriter, r *http.Request, name string) (int, bool) {
	raw := PathValue(r, name)
	if s := strings.TrimSpace(raw); isPlainInt(s) {
		if n, err := strconv.Atoi(s); err == nil {
			return n, true
		}
	}
	web.Write(w, http.StatusUnprocessableEntity, map[string]any{"detail": []any{map[string]any{
		"type": "int_parsing", "loc": []any{"path", name},
		"msg":   "Input should be a valid integer, unable to parse string as an integer",
		"input": raw,
	}}})
	return 0, false
}
