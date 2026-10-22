package erp

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 流式 agent 的工具调用：name 只在第一个分片到达，之后只有 arguments 增量。
// 回写给模型的 tool 消息必须带上真正的 name，否则 AIRunTool 每次都收到空工具名，
// 商品资料永远查不到，识别结果会整体跑偏（日期/品名都只能靠模型自己猜）。
func TestAIStreamAgentKeepsToolName(t *testing.T) {
	var rounds int
	var toolContents []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("请求体解析失败: %v", err)
		}
		if msgs, ok := body["messages"].([]any); ok {
			for _, m := range msgs {
				if mm, ok := m.(map[string]any); ok && mm["role"] == "tool" {
					toolContents = append(toolContents, ToStr(mm["content"]))
				}
			}
		}
		rounds++
		w.Header().Set("Content-Type", "text/event-stream")
		if rounds == 1 {
			sseChunk(w, `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_products","arguments":""}}]}}]}`)
			sseChunk(w, `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"keyword\":\"芦笋\"}"}}]}}]}`)
			fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		sseChunk(w, `{"choices":[{"delta":{"content":"{\"type\":\"inbound\"}"}}]}`)
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()

	cfg := map[string]any{"base_url": srv.URL, "api_key": "test-key", "model": "test-model"}
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	var stages []string
	err = AIStreamAgent(context.Background(), cfg, "系统提示", "票据文字", db, 3, 400, true,
		func(p AIPiece) error {
			if p.Kind == "tool" {
				stages = append(stages, p.Text)
			}
			return nil
		})
	if err != nil {
		t.Fatalf("流式 agent 调用失败: %v", err)
	}
	if rounds != 2 {
		t.Fatalf("应该跑两轮（首轮工具调用 + 次轮结论），实际 %d 轮", rounds)
	}
	joined := strings.Join(stages, "|")
	if !strings.Contains(joined, "正在查本仓商品资料：search_products…") {
		t.Errorf("进度提示该带上工具名，实际 stages=%q", stages)
	}
	if len(toolContents) != 1 {
		t.Fatalf("次轮请求该有 1 条 tool 消息，实际 %d 条", len(toolContents))
	}
	if strings.Contains(toolContents[0], "没有这个工具") {
		t.Errorf("工具名在回写时丢了，AIRunTool 收到空名字: %s", toolContents[0])
	}
}

func sseChunk(w http.ResponseWriter, payload string) {
	fmt.Fprintf(w, "data: %s\n\n", payload)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}
