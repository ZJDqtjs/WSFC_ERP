package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// ---------------- 附件上传 ----------------
// 与 Python routers/uploads.py 同一目录、同一命名规则：AI 识别出来的单据把 url 追加进备注
// （换行分隔），列表按扩展名渲染缩略图/下载链接，所以文件名与 URL 前缀都必须一致。

const maxUploadBytes = 20 * 1024 * 1024 // 20MiB，与 nginx client_max_body_size 20m 对齐

var imageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true, ".svg": true}

// 文件名里只保留 字母/数字/下划线/点/连字符/汉字，其它字符逐段替换成 _（Python 用的正则等价）。
var stemIllegal = regexp.MustCompile(`[^\w.\-\p{Han}]+`)

// Uploads POST /api/uploads —— multipart 字段名固定 file。
func (s *Server) Uploads(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		web.Error(w, http.StatusUnprocessableEntity, "请求需为 multipart/form-data，字段名 file")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		web.Error(w, http.StatusUnprocessableEntity, "缺少上传文件字段 file")
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, int64(maxUploadBytes)+1))
	if err != nil {
		web.Error(w, http.StatusBadRequest, "读取文件失败")
		return
	}
	if len(raw) == 0 {
		web.Error(w, http.StatusBadRequest, "未读取到文件内容")
		return
	}
	if len(raw) > maxUploadBytes {
		web.Error(w, http.StatusBadRequest, "文件超过 20MB 上限")
		return
	}
	name := cleanFilename(header.Filename)
	stem, ext := splitExt(name)
	stem = truncateRunes(strings.Trim(stemIllegal.ReplaceAllString(stem, "_"), "._-"), 40)
	if stem == "" {
		stem = "file"
	}
	ext = truncateRunes(cleanExt(ext), 10)
	dir := s.Cfg.UploadDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		web.Error(w, http.StatusInternalServerError, "附件目录不可写：%s", err.Error())
		return
	}
	// 时间戳精确到微秒，天然不重名；同名不覆盖。
	fname := fmt.Sprintf("attach_%s_%s%s", time.Now().Format("20060102_150405_000000"), stem, ext)
	if err := os.WriteFile(filepath.Join(dir, fname), raw, 0o644); err != nil {
		web.Error(w, http.StatusInternalServerError, "写入附件失败：%s", err.Error())
		return
	}
	web.Write(w, http.StatusOK, map[string]any{
		"url": "/uploads/" + fname, "name": stem + ext, "size": len(raw), "is_image": imageExts[ext],
	})
}

// UploadStatic GET /uploads/{filename} —— 与 Python StaticFiles 挂载等价（Range/条件请求由标准库负责）。
// 文件名（时间戳+微秒）就是事实上的访问凭证，没有列表接口。
func (s *Server) UploadStatic(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(strings.TrimPrefix(r.URL.Path, "/uploads/"))
	if name == "." || name == "" || strings.ContainsRune(name, os.PathSeparator) {
		web.Error(w, http.StatusNotFound, "Not Found")
		return
	}
	path := filepath.Join(s.Cfg.UploadDir(), name)
	if _, err := os.Stat(path); err != nil {
		web.Error(w, http.StatusNotFound, "Not Found")
		return
	}
	http.ServeFile(w, r, path)
}

func splitExt(name string) (string, string) {
	ext := filepath.Ext(name)
	return strings.TrimSuffix(name, ext), strings.ToLower(ext)
}

var extIllegal = regexp.MustCompile(`[^\w.\-]+`)

func cleanExt(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return ""
	}
	if !strings.HasPrefix(s, ".") {
		s = "." + s
	}
	return extIllegal.ReplaceAllString(s, "")
}

// cleanFilename 去掉路径部分，防目录穿越（Python 用 Path(filename).name）。
func cleanFilename(name string) string {
	if strings.TrimSpace(name) == "" {
		return "file"
	}
	return filepath.Base(filepath.FromSlash(strings.TrimSpace(name)))
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// ---------------- 维护状态 / 健康检查 ----------------

// MaintenanceStatus GET /api/maintenance/status —— 免登录（服务维护时用户还没法登录，必须先看到提示）。
// 口径与 Python app/maintenance.py 的 load_state + public_status 一致：状态文件缺失或字段残缺时
// 一律回退到「正常服务」的默认值（lead 10 分钟、eta 30 分钟），绝不因文件问题影响接口。
func (s *Server) MaintenanceStatus(w http.ResponseWriter, r *http.Request) {
	st := map[string]any{"mode": "off", "message": "", "lead_minutes": 10, "eta_minutes": 30, "deadline": nil}
	if raw, err := os.ReadFile(filepath.Join(s.Cfg.DataDir(), "maintenance.json")); err == nil {
		var file map[string]any
		if json.Unmarshal(raw, &file) == nil {
			for k, v := range file {
				if _, ok := st[k]; ok {
					st[k] = v
				}
			}
		}
	}
	mode, _ := st["mode"].(string)
	switch mode {
	case "off", "announce", "maintenance":
	default:
		mode = "off"
		st["mode"] = "off"
	}
	deadline := erp.ToFloat(st["deadline"])
	now := float64(time.Now().UnixNano()) / 1e9
	if mode == "announce" && deadline > 0 && now >= deadline {
		mode = "maintenance" // 公告倒计时归零即视为「维护中」
	}
	var remaining any
	if mode0, _ := st["mode"].(string); mode0 == "announce" && deadline > 0 {
		left := int(deadline - now)
		if left < 0 {
			left = 0
		}
		remaining = left
	}
	web.Write(w, http.StatusOK, map[string]any{
		"mode": mode, "raw_mode": st["mode"], "message": erp.ToStr(orEmpty(st["message"])),
		"eta_minutes": int(erp.ToFloat(st["eta_minutes"])),
		"lead_minutes": int(erp.ToFloat(st["lead_minutes"])),
		"remaining_seconds": remaining,
		"server_time": now,
	})
}

// orEmpty 把 null 字段折成空串（对齐 Python 的 `x or ""`）。
func orEmpty(v any) any {
	if v == nil {
		return ""
	}
	return v
}

// Health GET /health —— Go 侧自己的探活（不依赖 Python 是否在线）。
func (s *Server) Health(w http.ResponseWriter, r *http.Request) {
	web.Write(w, http.StatusOK, map[string]any{"ok": true, "service": "wsfc-erp-go", "warehouse": web.Warehouse(r)})
}
