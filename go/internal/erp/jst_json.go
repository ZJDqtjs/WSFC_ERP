package erp

// jst_json.go 是「自动出库」模块用的 JSON 读写小工具：
// Python 侧用 json.dumps(ensure_ascii=False)，既不转义中文也不转义 <>&，
// Go 标准库默认会转义 <>&，这里统一走不转义的编码器。

import (
	"bytes"
	"encoding/json"
)

// jsonMarshalNoEscape 紧凑序列化（不转义 HTML 字符）。
func jsonMarshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// jsonIndentNoEscape 缩进 2、不转义（写 json/jst_auto.json 用，与 Python 一致）。
func jsonIndentNoEscape(v any) ([]byte, error) {
	raw, err := jsonMarshalNoEscape(v)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// jsonUseNumber 解 JSON 到 map（数字按 float64，与 Python json 的数值语义一致）。
func jsonUseNumber(raw []byte, dst *map[string]any) error {
	return json.Unmarshal(raw, dst)
}

// jsonAny 解任意 JSON 值（ASP.NET 的 ReturnValue 对象用）。
func jsonAny(raw []byte) (any, error) {
	var v any
	err := json.Unmarshal(raw, &v)
	return v, err
}
