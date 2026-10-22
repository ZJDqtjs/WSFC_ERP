package erp

// jst_util.go：自动出库模块内部用的小工具（文件、错误链、字符串裁剪、日志）。

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// mkdirAll / writeFile / joinPath：薄封装，保持导出器代码与 Python 的行文一一对应。
func mkdirAll(dir string) error { return os.MkdirAll(dir, 0o755) }

func writeFile(p string, data []byte) error { return os.WriteFile(p, data, 0o644) }

func joinPath(parts ...string) string { return filepath.Join(parts...) }

// errorsAs：错误链类型判定。
func errorsAs(err error, target any) bool { return errors.As(err, target) }

// jstClip 截断响应片段（Python 里到处是 text[:300]，用来把异常文案控制在同一长度）。
func jstClip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// jstUnquote 等价 urllib.parse.unquote。
func jstUnquote(s string) string {
	if out, err := url.QueryUnescape(s); err == nil {
		return out
	}
	return s
}

// jsonScanObject 等价 Python json.JSONDecoder().raw_decode()：只解第一个 JSON 值。
func jsonScanObject(raw []byte) (int, any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	var v any
	if err := dec.Decode(&v); err != nil {
		return 0, nil, err
	}
	return int(dec.InputOffset()), v, nil
}

// jstLogf 走服务日志，前缀与 Python 的 [自动出库] 一致。
func jstLogf(format string, args ...any) {
	log.Printf("[自动出库] "+format, args...)
}

// jstTrimAllSpace 去掉所有空白（含全角空格以外的那些，与 Python \s+ 一致）。
func jstTrimAllSpace(s string) string {
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' || r == 0x85 || r == 0xA0 ||
			r == 0x1680 || (r >= 0x2000 && r <= 0x200A) || r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000
	}), "")
}
