package erp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// ---------------- LLM 接入（对齐 app/routers/ai.py + app/config.py） ----------------
//
// 配置口径：product_rules.json 的 llm 段是默认值，config.local.json 深合并覆盖，
// 环境变量 ERP_LLM_API_KEY / ERP_LLM_BASE_URL / ERP_LLM_MODEL 最后覆盖（Python 的 _ENV_OVERRIDES）。
// enabled 缺失按 true；显式 false 时整个 llm 段视为未配置（返回空 map，调用方报「未配置 LLM」）。
//
// 调用口径：Python 用官方 openai SDK（base_url 会自动补 /chat/completions，timeout=300s、
// max_retries=2、temperature=0.1）。这里用标准库 net/http 实现同一套 OpenAI 兼容协议，
// 并把失败映射成 SDK 的异常「类型名 + 文案」，让 502/SSE error 事件与原实现逐字一致。

// AIRulesFile / AILocalFile 是仓库根的配置文件；由 api.registerAI 按 config.RepoRoot() 赋值。
var (
	AIRulesFile = ""
	AILocalFile = ""
)

// AIUploadDir 票据图片目录（Python: backend/data/uploads），由 api.registerAI 赋值。
var AIUploadDir = ""

// AIStreamIdleTimeout 流式响应两次数据之间的最长静默（对应 httpx 的 read timeout）。
var AIStreamIdleTimeout = 300 * time.Second

// AIError 复刻 Python/openai 异常的 type(e).__name__ + str(e) 两段信息。
type AIError struct {
	Type string
	Msg  string
}

func (e *AIError) Error() string { return e.Msg }

// Format 给出 Python f"{type(e).__name__}: {e}" 的等价串。
func (e *AIError) Format() string { return e.Type + ": " + e.Msg }

func aiErr(typ, format string, args ...any) *AIError {
	msg := format
	if len(args) > 0 {
		msg = fmt.Sprintf(format, args...)
	}
	return &AIError{Type: typ, Msg: msg}
}

// ErrTextOf 把任意 error 折成「类型名: 消息」（未知错误按 Go 的默认类型名兜底）。
func ErrTextOf(err error) string {
	var ae *AIError
	if errors.As(err, &ae) {
		return ae.Format()
	}
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%T: %s", err, err.Error())
}

// readRulesJSON 读 JSON；文件不存在/格式错误 → 空 map（Python _read_json 的容错）。
func readRulesJSON(path string) map[string]any {
	if path == "" {
		return map[string]any{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}
	}
	if out == nil {
		return map[string]any{}
	}
	return out
}

// deepMergeJSON 深合并：dict 递归、列表与标量整体覆盖（Python config._deep_merge）。
func deepMergeJSON(base, override map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range override {
		if sub, ok := v.(map[string]any); ok {
			if cur, ok2 := out[k].(map[string]any); ok2 {
				out[k] = deepMergeJSON(cur, sub)
				continue
			}
		}
		out[k] = v
	}
	return out
}

// AILoadRules 完整配置（默认 + 本机私有 + 环境变量）。
func AILoadRules() map[string]any {
	cfg := deepMergeJSON(readRulesJSON(AIRulesFile), readRulesJSON(AILocalFile))
	for envName, path := range map[string][2]string{
		"ERP_LLM_API_KEY": {"llm", "api_key"},
		"ERP_LLM_BASE_URL": {"llm", "base_url"},
		"ERP_LLM_MODEL":   {"llm", "model"},
	} {
		v := os.Getenv(envName)
		if v == "" {
			continue
		}
		node := cfg
		// Python 只在中间层已是 dict 时复用，否则新建空 dict；这里等价实现两层路径。
		child, ok := node[path[0]].(map[string]any)
		if !ok {
			child = map[string]any{}
			node[path[0]] = child
		}
		child[path[1]] = v
	}
	return cfg
}

// AILLMConfig llm 段；enabled 显式为 false 或缺失段时返回空 map（Python llm_config()）。
func AILLMConfig() map[string]any {
	raw, ok := AILoadRules()["llm"]
	if !ok {
		return map[string]any{}
	}
	cfg, ok := raw.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	if v, exists := cfg["enabled"]; exists && !ToBool(v) {
		return map[string]any{}
	}
	return cfg
}

// AILLMKey 是否配置了 api_key（Python: if not cfg.get("api_key")）。
func AILLMKey(cfg map[string]any) string { return strings.TrimSpace(ToStr(cfg["api_key"])) }

// AISDKBase 去掉配置里多余的 /chat/completions 后缀（SDK 会自己补）。
func AISDKBase(base string) string {
	return strings.TrimSuffix(base, "/chat/completions")
}

const aiChatPath = "/chat/completions"

// aitoolCallText 工具调用增量。
type AIToolDelta struct {
	Index int
	ID    string
	Name  string
	Args  string
}

// AIPiece 流式片段：kind = think / content / tool。
type AIPiece struct {
	Kind   string
	Text   string
	Deltas []AIToolDelta
}

// AIChatMessage OpenAI 协议里的一条消息。
type AIChatMessage struct {
	Role       string
	Content    any    // string、[]map[string]any（多模态）或 nil
	ToolCalls  []*JObj
	ToolCallID string
}

// JSON 按 Python 构造消息时的键序输出。
func (m AIChatMessage) JSON() *JObj {
	o := NewJ().Set("role", m.Role)
	c := m.Content
	if c == nil && m.ToolCalls == nil && m.ToolCallID == "" {
		c = nil
	}
	if m.ToolCallID != "" { // role=tool：role, tool_call_id, content
		o.Set("tool_call_id", m.ToolCallID).Set("content", c)
		return o
	}
	o.Set("content", c)
	if m.ToolCalls != nil {
		calls := make([]*JObj, 0, len(m.ToolCalls))
		calls = append(calls, m.ToolCalls...)
		o.Set("tool_calls", calls)
	}
	return o
}

// AITextContent 纯文本 user 消息内容。
func AITextContent(s string) any { return s }

// AIImageContent 多模态 user 消息内容（文本 + data URI 图片）。
func AIImageContent(text, dataURI string) any {
	return []map[string]any{
		{"type": "text", "text": text},
		{"type": "image_url", "image_url": map[string]any{"url": dataURI}},
	}
}

// aiStatusErrName openai SDK 的状态码 → 异常类名映射。
func aiStatusErrName(code int) string {
	switch {
	case code == http.StatusBadRequest:
		return "BadRequestError"
	case code == http.StatusUnauthorized:
		return "AuthenticationError"
	case code == http.StatusForbidden:
		return "PermissionDeniedError"
	case code == http.StatusNotFound:
		return "NotFoundError"
	case code == http.StatusMethodNotAllowed:
		return "MethodNotAllowedError"
	case code == http.StatusConflict:
		return "ConflictError"
	case code == http.StatusUnprocessableEntity:
		return "UnprocessableEntityError"
	case code == http.StatusTooManyRequests:
		return "RateLimitError"
	case code >= 500:
		return "InternalServerError"
	}
	return "APIStatusError"
}

// aiShouldRetry SDK 的重试条件：连接/超时错误、409、429、5xx。
func aiShouldRetry(err *AIError, status int) bool {
	if err == nil {
		return false
	}
	switch err.Type {
	case "APIConnectionError", "APITimeoutError":
		return true
	}
	return status == 409 || status == 429 || status >= 500
}

// AIClient 一次 LLM 调用所需的 HTTP 客户端（超时口径同 Python：300s、重试 2 次）。
type AIClient struct {
	http   *http.Client
	base   string
	apiKey string
	model  string
}

const (
	aiTimeout      = 300 * time.Second
	aiMaxRetries   = 2
	aiMaxBodyLog   = 2048
	aiMaxErrBody   = 4096
)

// AINewClient 按配置建客户端。
func AINewClient(cfg map[string]any) *AIClient {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = func(d ctxer, network, addr string) (net.Conn, error) {
		return (&net.Dialer{Timeout: aiTimeout, KeepAlive: 30 * time.Second}).DialContext(d, network, addr)
	}
	tr.ResponseHeaderTimeout = aiTimeout
	return &AIClient{
		http:   &http.Client{Transport: tr},
		base:   AISDKBase(ToStr(cfg["base_url"])),
		apiKey: ToStr(cfg["api_key"]),
		model:  ToStr(cfg["model"]),
	}
}

type ctxer = context.Context

// AIRequest 一次 chat/completions 请求的参数。
type AIRequest struct {
	System    string
	Messages  []AIChatMessage
	MaxTokens int
	Tools     []*JObj // nil / 空 = 不带工具
	Stream    bool
}

func (c *AIClient) body(r AIRequest) *JObj {
	msgs := make([]*JObj, 0, len(r.Messages)+1)
	msgs = append(msgs, NewJ().Set("role", "system").Set("content", r.System))
	for _, m := range r.Messages {
		msgs = append(msgs, m.JSON())
	}
	mt := r.MaxTokens
	if mt == 0 {
		mt = 1600
	}
	b := NewJ().
		Set("model", c.model).
		Set("messages", msgs).
		Set("temperature", F(0.1)).
		Set("max_tokens", mt)
	if r.Stream {
		b.Set("stream", true)
	}
	if len(r.Tools) > 0 {
		b.Set("tools", r.Tools).Set("tool_choice", "auto")
	}
	return b
}

// do 发送请求（含 SDK 口径的重试与退避），返回响应体 reader。
func (c *AIClient) do(ctx context.Context, r AIRequest, stream bool) (io.ReadCloser, *AIError) {
	payload := AIJSONCompact(c.body(r))
	url := c.base + aiChatPath
	var lastErr *AIError
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(payload)))
		if err != nil {
			return nil, aiErr("APIConnectionError", "Connection error.")
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
		accept := "application/json"
		if stream {
			accept = "text/event-stream"
		}
		req.Header.Set("Accept", accept)
		req.Header.Set("User-Agent", "OpenAI/Go 5.0.0")
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = c.mapTransportError(err)
			if attempt < aiMaxRetries {
				if !aiSleep(ctx, attempt, 0) {
					return nil, lastErr
				}
				continue
			}
			return nil, lastErr
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return resp.Body, nil
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, aiMaxErrBody))
		resp.Body.Close()
		text := strings.TrimSpace(string(raw))
		if len(text) > aiMaxBodyLog {
			text = text[:aiMaxBodyLog]
		}
		lastErr = aiErr(aiStatusErrName(resp.StatusCode), "Error code: %d - %s", resp.StatusCode, text)
		retryAfter := resp.Header.Get("Retry-After")
		if attempt < aiMaxRetries && aiShouldRetry(lastErr, resp.StatusCode) {
			if !aiSleep(ctx, attempt, parseRetryAfter(retryAfter)) {
				return nil, lastErr
			}
			continue
		}
		return nil, lastErr
	}
}

// mapTransportError 连接失败 / 超时的异常名与文案（对齐 SDK 的 APIConnectionError / APITimeoutError）。
func (c *AIClient) mapTransportError(err error) *AIError {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return aiErr("APITimeoutError", "Request timed out.")
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return aiErr("APITimeoutError", "Request timed out.")
	}
	if strings.Contains(strings.ToLower(err.Error()), "timeout") {
		return aiErr("APITimeoutError", "Request timed out.")
	}
	return aiErr("APIConnectionError", "Connection error.")
}

// aiSleep 指数退避（0.5s 起，翻倍，上限 8s；Retry-After 优先）。
func aiSleep(ctx context.Context, attempt int, retryAfter time.Duration) bool {
	d := time.Duration(mathPow2(attempt)) * 500 * time.Millisecond
	if d > 8*time.Second {
		d = 8 * time.Second
	}
	if retryAfter > 0 {
		d = retryAfter
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func mathPow2(n int) float64 {
	p := 1.0
	for i := 0; i < n; i++ {
		p *= 2
	}
	return p
}

func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
		return time.Duration(f * float64(time.Second))
	}
	return 0
}

// AIChatOnce 非流式调用，返回 message.content（空内容时抛 RuntimeError，同 Python）。
func AIChatOnce(ctx context.Context, cfg map[string]any, r AIRequest) (string, []*JObj, error) {
	c := AINewClient(cfg)
	r.Stream = false
	body, aerr := c.do(ctx, r, false)
	if aerr != nil {
		return "", nil, aerr
	}
	defer body.Close()
	raw, err := io.ReadAll(io.LimitReader(body, 8<<20))
	if err != nil {
		return "", nil, aiErr("APIConnectionError", "Connection error.")
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", nil, aiErr("APIConnectionError", "Connection error.")
	}
	choices := mapSliceAt(parsed, "choices")
	if len(choices) == 0 {
		return "", nil, aiErr("RuntimeError", "大模型返回异常：%s", string(AIJSONSpaced(parsed)))
	}
	msg := mapAt(choices[0], "message")
	if msg == nil {
		return "", nil, aiErr("RuntimeError", "大模型返回异常：%s", string(AIJSONSpaced(parsed)))
	}
	content := StrPtrAt(msg, "content")
	tcs := jObjSliceAt(msg, "tool_calls")
	if content == "" && len(tcs) == 0 {
		return "", nil, aiErr("RuntimeError", "大模型返回异常：%s", string(AIJSONSpaced(parsed)))
	}
	return content, tcs, nil
}

// AIStream 流式调用：解析上游 SSE，按 ('think'|'content'|'tool') 回调（对齐 _stream_call）。
// emit 返回错误会中断读取（客户端断开时用它停止上游请求）。
func AIStream(ctx context.Context, cfg map[string]any, r AIRequest, emit func(AIPiece) error) error {
	c := AINewClient(cfg)
	r.Stream = true
	body, aerr := c.do(ctx, r, true)
	if aerr != nil {
		return aerr
	}
	defer body.Close()

	// httpx 的 read timeout 是「两次数据之间」的静默上限；Go 用看门狗取消请求来等价实现。
	idle := int64(0)
	watchCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		last := time.Now()
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-t.C:
				if atomic.LoadInt64(&idle) == 1 {
					return
				}
				if time.Since(last) > AIStreamIdleTimeout {
					cancel()
					return
				}
				last = time.Now()
			}
		}
	}()

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		atomic.StoreInt64(&idle, 0)
		line := scanner.Text()
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimPrefix(line, "data:")
		payload = strings.TrimPrefix(payload, " ")
		if payload == "" || payload == "[DONE]" {
			if payload == "[DONE]" {
				break
			}
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if d := aiStreamToolDeltas(chunk); len(d) > 0 {
			if err := emit(AIPiece{Kind: "tool", Deltas: d}); err != nil {
				atomic.StoreInt64(&idle, 1)
				return err
			}
		}
		for _, p := range aiStreamPieces(chunk) {
			if err := emit(p); err != nil {
				atomic.StoreInt64(&idle, 1)
				return err
			}
		}
	}
	atomic.StoreInt64(&idle, 1)
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return aiErr("APITimeoutError", "Request timed out.")
	}
	return nil
}

// aiChunkReasoning 取流式片段里的「思考内容」：字段名按网关差异依次尝试（同 _chunk_reasoning）。
func aiChunkReasoning(chunk map[string]any) string {
	delta := aiFirstDelta(chunk)
	if delta == nil {
		return ""
	}
	for _, k := range []string{"reasoning_content", "reasoning", "thinking"} {
		if s, ok := delta[k].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func aiFirstDelta(chunk map[string]any) map[string]any {
	choices := sliceAt(chunk, "choices")
	if len(choices) == 0 {
		return nil
	}
	return mapAt(choices[0], "delta")
}

// aiStreamPieces 把 chunk 拆成 ('think', 思考) / ('content', 正式回答)。
func aiStreamPieces(chunk map[string]any) []AIPiece {
	var out []AIPiece
	if think := aiChunkReasoning(chunk); think != "" {
		out = append(out, AIPiece{Kind: "think", Text: think})
	}
	delta := aiFirstDelta(chunk)
	if delta != nil {
		if content, ok := delta["content"].(string); ok && content != "" {
			out = append(out, AIPiece{Kind: "content", Text: content})
		}
	}
	return out
}

// aiStreamToolDeltas 取 tool_calls 增量（arguments 分片到达）。
func aiStreamToolDeltas(chunk map[string]any) []AIToolDelta {
	delta := aiFirstDelta(chunk)
	if delta == nil {
		return nil
	}
	raw := sliceAt(delta, "tool_calls")
	if len(raw) == 0 {
		return nil
	}
	out := make([]AIToolDelta, 0, len(raw))
	for _, t := range raw {
		fn := mapAt(t, "function")
		out = append(out, AIToolDelta{
			Index: ToInt(intAt(t, "index")),
			ID:    StrPtrAt(t, "id"),
			Name:  StrPtrAt(fn, "name"),
			Args:  StrPtrAt(fn, "arguments"),
		})
	}
	return out
}

// ---------------- 工具白名单（AI_TOOLS，逐字抄 Python） ----------------

// AIToolMaxCalls 单次识别允许的查询次数上限。
const AIToolMaxCalls = 8

// AIToolMaxLimit 单次查询返回条数上限。
const AIToolMaxLimit = 30

// AIToolKeywordMax 关键词/名称长度上限。
const AIToolKeywordMax = 40

// AITools 给模型的两个只读工具定义。
func AITools() []*JObj {
	search := NewJ().Set("type", "function").Set("function", NewJ().
		Set("name", "search_products").
		Set("description", "搜索当前分仓的在用商品资料（只读）。票据只写品名、或名字与商品档案不一致时用它找对应商品："+
			"如「哈斯」查到「哈斯牛油果大果 / 特大果 / 2斤礼盒 / 3斤礼盒」，"+
			"再按规格（等级 160-190、净重、礼盒规格）挑出最接近的那一个，用它的原名输出。").
		Set("parameters", NewJ().
			Set("type", "object").
			Set("properties", NewJ().
				Set("keyword", NewJ().Set("type", "string").Set("description", "要搜的关键词，如「哈斯」「纸箱」「礼盒」")).
				Set("category", NewJ().Set("type", "string").Set("description", "可选：库存商品 / 包材 / 人工")).
				Set("limit", NewJ().Set("type", "integer").Set("description", "最多返回几条，默认 10（上限 30）"))).
			Set("required", []string{"keyword"})))
	get := NewJ().Set("type", "function").Set("function", NewJ().
		Set("name", "get_product").
		Set("description", "按名称或 id 取当前分仓某个商品的详情（只读）：当前库存、默认单位、计量换算（如 1公斤=2斤）、分类。"+
			"用于确认「该用哪个单位/规格入账」。").
		Set("parameters", NewJ().
			Set("type", "object").
			Set("properties", NewJ().
				Set("name_or_id", NewJ().Set("type", "string").Set("description", "商品名称或商品 id"))).
			Set("required", []string{"name_or_id"})))
	return []*JObj{search, get}
}

// ---------------- agent 循环（_chat_stream_agent / _chat_agent） ----------------

// AIStreamAgent 带只读工具的流式识别循环；产出 think / content / tool 三种片段。
func AIStreamAgent(ctx context.Context, cfg map[string]any, system string, userContent any,
	q Querier, maxRounds, maxTokens int, useTools bool, emit func(AIPiece) error) error {
	if maxRounds == 0 {
		maxRounds = 3
	}
	msgs := []AIChatMessage{{Role: "user", Content: userContent}}
	var tools []*JObj
	if useTools {
		tools = AITools()
	}
	budget := AIToolMaxCalls
	for rnd := 0; rnd < maxRounds; rnd++ {
		calls := map[int]*AIToolCall{}
		var order []int
		text := ""
		err := AIStream(ctx, cfg, AIRequest{System: system, Messages: msgs, MaxTokens: maxTokens, Tools: tools},
			func(p AIPiece) error {
				switch p.Kind {
				case "think":
					return emit(AIPiece{Kind: "think", Text: p.Text})
				case "content":
					text += p.Text
					return emit(AIPiece{Kind: "content", Text: p.Text})
				}
				for _, d := range p.Deltas {
					c, ok := calls[d.Index]
					if !ok {
						c = &AIToolCall{ID: "", Name: "", Args: ""}
						calls[d.Index] = c
						order = append(order, d.Index)
					}
					if d.ID != "" {
						c.ID = d.ID
					}
					if d.Name != "" {
						c.Name = d.Name
					}
					c.Args += d.Args
				}
				return nil
			})
		if err != nil {
			return err
		}
		if len(calls) == 0 {
			return nil
		}
		idxs := sortedInts(order)
		tcs := make([]*JObj, 0, len(idxs))
		// 工具名/参数要直接带着走：tcs 里的 function 是 *JObj，用 map 断言取不回来（会拿到空串），
		// 那样 AIRunTool 每次都是空工具名，商品资料永远查不到，识别结果会整体跑偏。
		type aiResolvedCall struct{ id, name, args string }
		resolved := make([]aiResolvedCall, 0, len(idxs))
		for i, k := range idxs {
			c := calls[k]
			id := c.ID
			if id == "" {
				id = fmt.Sprintf("call_%d_%d", rnd, i)
			}
			name := c.Name
			if name == "" {
				name = "unknown"
			}
			args := c.Args
			if args == "" {
				args = "{}"
			}
			resolved = append(resolved, aiResolvedCall{id, name, args})
			tcs = append(tcs, NewJ().
				Set("id", id).
				Set("type", "function").
				Set("function", NewJ().Set("name", name).Set("arguments", args)))
		}
		var content any
		if text != "" {
			content = text
		}
		msgs = append(msgs, AIChatMessage{Role: "assistant", Content: content, ToolCalls: tcs})
		for _, cl := range resolved {
			if err := emit(AIPiece{Kind: "tool", Text: fmt.Sprintf("正在查本仓商品资料：%s…", cl.name)}); err != nil {
				return err
			}
			msgs = append(msgs, AIChatMessage{
				Role:       "tool",
				Content:    AIRunTool(ctx, q, cl.name, cl.args, &budget),
				ToolCallID: cl.id,
			})
		}
	}
	// 轮次用尽：让它基于已有信息给结论（不再给工具，避免绕圈）。
	// 注意 Python 这里把 think 也当 content 往外发，保持一致。
	return AIStream(ctx, cfg, AIRequest{System: system, Messages: msgs, MaxTokens: maxTokens},
		func(p AIPiece) error {
			if p.Kind != "tool" {
				return emit(AIPiece{Kind: "content", Text: p.Text})
			}
			return emit(p)
		})
}

// AIToolCall 聚合后的工具调用（id / name / 拼接的 arguments）。
type AIToolCall struct {
	ID   string
	Name string
	Args string
}

// AIChatAgent 带工具的非流式识别（POST /api/ai/parse 用），返回最终文本。
func AIChatAgent(ctx context.Context, cfg map[string]any, system, user string, q Querier, maxRounds, maxTokens int) (string, error) {
	if maxRounds == 0 {
		maxRounds = 3
	}
	msgs := []AIChatMessage{{Role: "user", Content: user}}
	budget := AIToolMaxCalls
	tools := AITools()
	for i := 0; i < maxRounds; i++ {
		content, tcs, err := AIChatOnce(ctx, cfg, AIRequest{
			System: system, Messages: msgs, MaxTokens: maxTokens, Tools: tools,
		})
		if err != nil {
			return "", err
		}
		if len(tcs) == 0 {
			return content, nil
		}
		calls := make([]*JObj, 0, len(tcs))
		for _, t := range tcs {
			fn := mapAtJ(t, "function")
			calls = append(calls, NewJ().
				Set("id", strAtJ(t, "id")).
				Set("type", "function").
				Set("function", NewJ().Set("name", StrPtrAt(fn, "name")).Set("arguments", StrPtrAt(fn, "arguments"))))
		}
		var c any
		if content != "" {
			c = content
		}
		msgs = append(msgs, AIChatMessage{Role: "assistant", Content: c, ToolCalls: calls})
		for _, t := range tcs {
			fn := mapAtJ(t, "function")
			msgs = append(msgs, AIChatMessage{
				Role:       "tool",
				Content:    AIRunTool(ctx, q, StrPtrAt(fn, "name"), StrPtrAt(fn, "arguments"), &budget),
				ToolCallID: strAtJ(t, "id"),
			})
		}
	}
	return "", nil
}

// ---------------- 小工具 ----------------

func sortedInts(in []int) []int {
	out := append([]int(nil), in...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func mapAt(m map[string]any, k string) map[string]any {
	if m == nil {
		return nil
	}
	if v, ok := m[k].(map[string]any); ok {
		return v
	}
	return nil
}

func mapSliceAt(m map[string]any, k string) []map[string]any {
	return sliceAt(m, k)
}

// jObjSliceAt 取数组并转成 *JObj（用于 tool_calls：要塞回请求体，需要保持键序的构造对象）。
func jObjSliceAt(m map[string]any, k string) []*JObj {
	raw := sliceAt(m, k)
	out := make([]*JObj, 0, len(raw))
	for _, x := range raw {
		out = append(out, NewJFromMap(x))
	}
	return out
}

func sliceAt(m map[string]any, k string) []map[string]any {
	if m == nil {
		return nil
	}
	switch v := m[k].(type) {
	case []map[string]any:
		return v
	case []any:
		out := make([]map[string]any, 0, len(v))
		for _, it := range v {
			if mm, ok := it.(map[string]any); ok {
				out = append(out, mm)
			}
		}
		return out
	case []*JObj:
		out := make([]map[string]any, 0, len(v))
		for _, it := range v {
			out = append(out, it.Map())
		}
		return out
	}
	return nil
}

// mapAtJ 是 *JObj 版 mapAt：取子对象（tool_calls 已转成 *JObj）。
func mapAtJ(o *JObj, k string) map[string]any {
	if o == nil {
		return nil
	}
	if v, ok := o.Get(k).(map[string]any); ok {
		return v
	}
	return nil
}

// strAtJ 是 *JObj 版 StrPtrAt。
func strAtJ(o *JObj, k string) string {
	if o == nil {
		return ""
	}
	if s, ok := o.Get(k).(string); ok {
		return s
	}
	return ""
}

// StrPtrAt 取字符串（Python 的 `x or ""` 语义：缺失/null/非字符串 → 空串）。
func StrPtrAt(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[k].(string); ok {
		return s
	}
	return ""
}

func intAt(m map[string]any, k string) any {
	if m == nil {
		return nil
	}
	return m[k]
}

// anyToStrOrEmpty 对齐 Python 的 `(v or "")`：null/False/0/"" → ""，数字转字符串。
func anyToStrOrEmpty(v any) string {
	if v == nil {
		return ""
	}
	if b, ok := v.(bool); ok {
		if b {
			return "True"
		}
		return ""
	}
	if f, ok := v.(float64); ok {
		if f == 0 {
			return ""
		}
		return ToStr(f)
	}
	return ToStr(v)
}

// AIUploadsPath 票据图片保存目录（未设置时回退到 <cwd>/data/uploads，同 Python 的相对路径）。
func AIUploadsPath() string {
	if AIUploadDir != "" {
		return AIUploadDir
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, "data", "uploads")
}
