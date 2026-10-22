package api

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// 本文件是「数据库备份与恢复」接口层，对齐 app/routers/backup.py（7 个接口）。
// 「当前分仓」= 本次登录会话所在分仓（web.Warehouse(r)），列表/自动清理/恢复都只针对它。

// registerBackup 由主控在 routes.go 里调用。
func (s *Server) registerBackup(rt *router) {
	// 备份模块的目录锚点：data/（备份、配置、状态）与 backend/json（整目录打包）
	erp.BackupDataDir = s.Cfg.DataDir()
	erp.BackupJSONDir = s.Cfg.JSONDir()
	// 与 Python 模块导入时的 BACKUP_DIR.mkdir(exist_ok=True) 等价
	_ = os.MkdirAll(erp.BackupDir(), 0o755)

	rt.Get("/api/backups", s.Backups)
	rt.Post("/api/backup", s.CreateBackup)
	rt.Post("/api/backup/restore", s.RestoreBackup)
	rt.Delete("/api/backup/{name}", s.DeleteBackup)
	rt.Post("/api/backup/config", s.UpdateBackupConfig)
	rt.Get("/api/backup/remote/deploy-script", s.RemoteDeployScript)
	rt.Get("/api/backup/remote/stop-script", s.RemoteStopScript)
}

// Backups GET /api/backups —— 配置 + 本分仓备份清单 + json 备份清单 + 远程推送状态。
func (s *Server) Backups(w http.ResponseWriter, r *http.Request) {
	key := web.Warehouse(r)
	web.Write(w, http.StatusOK, map[string]any{
		"config":        erp.LoadBackupConfig(),
		"backups":       erp.ListBackups(key),
		"json_backups":  erp.ListJSONBackups(),
		"remote_status": erp.LoadRemoteStatus(),
	})
}

// CreateBackup POST /api/backup —— 在线备份当前分仓，再按开关决定是否打包 json 目录。
func (s *Server) CreateBackup(w http.ResponseWriter, r *http.Request) {
	key := web.Warehouse(r)
	name, err := erp.CreateBackupFile(r.Context(), MustDB(r), key)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	// json_backup 为 null 的两种情况：开关关闭、或目录内容与上次备份无变化（Python 同语义）
	var jsonBackup any
	cfg := erp.LoadBackupConfig()
	if erp.ToBool(cfg["json_backup_enabled"]) {
		if jb, jerr := erp.CreateJSONBackupFile(false); jerr != nil {
			log.Printf("[json备份] 失败：%v", jerr)
		} else if jb != "" {
			jsonBackup = jb
		}
	}
	web.Write(w, http.StatusOK, map[string]any{
		"ok":          true,
		"name":        name,
		"json_backup": jsonBackup,
		"backups":     erp.ListBackups(key),
	})
}

// RestoreBackup POST /api/backup/restore —— 用备份文件覆盖当前分仓库（不可逆，界面二次确认）。
func (s *Server) RestoreBackup(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	key := web.Warehouse(r)
	name := erp.ToStr(body["name"])
	if !erp.BackupBelongsTo(name, key) {
		web.Error(w, http.StatusBadRequest, "备份文件不属于当前分仓，无法恢复")
		return
	}
	srcPath, err := erp.SafeBackupPath(name)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	if _, err := os.Stat(srcPath); err != nil {
		web.Error(w, http.StatusNotFound, "备份文件不存在")
		return
	}
	if err := erp.RestoreBackupFile(r.Context(), MustDB(r), srcPath); err != nil {
		web.Error(w, http.StatusInternalServerError, "恢复失败：%s", err.Error())
		return
	}
	web.Write(w, http.StatusOK, map[string]any{"ok": true})
}

// DeleteBackup DELETE /api/backup/{name} —— 删除一个备份文件（不校验归属，列表按当前分仓返回）。
func (s *Server) DeleteBackup(w http.ResponseWriter, r *http.Request) {
	name := PathValue(r, "name")
	srcPath, err := erp.SafeBackupPath(name)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	if _, err := os.Stat(srcPath); err != nil {
		web.Error(w, http.StatusNotFound, "备份文件不存在")
		return
	}
	if err := os.Remove(srcPath); err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, map[string]any{"ok": true, "backups": erp.ListBackups(web.Warehouse(r))})
}

// UpdateBackupConfig POST /api/backup/config —— 覆盖式保存自动备份配置；远程 token 只增不改。
func (s *Server) UpdateBackupConfig(w http.ResponseWriter, r *http.Request) {
	body, err := BindBody(r)
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	old := erp.LoadBackupConfig()
	remoteURL := strings.TrimSpace(erp.ToStr(body["remote_url"]))
	token := erp.ToStr(old["remote_token"])
	// 开启远程备份但尚无密钥时，自动生成一个作为收发双方的共享密钥
	if backupBoolOr(body, "remote_enabled", false) && remoteURL != "" && token == "" {
		token = erp.TokenURLSafe(24)
	}
	interval := 2.0
	if v := erp.OptFloat(body, "interval_hours"); v != nil {
		interval = *v
	}
	if interval < 0.5 {
		interval = 0.5
	}
	keep := 30
	if v := erp.OptInt(body, "keep"); v != nil {
		keep = *v
	}
	if keep < 1 {
		keep = 1
	}
	remoteKeep := 100
	if v := erp.OptInt(body, "remote_keep"); v != nil && *v != 0 {
		remoteKeep = *v
	}
	if remoteKeep < 1 {
		remoteKeep = 1
	}
	// 键值顺序与类型形态都对齐 Python：interval_hours 是 float（2 → 2.0），keep/remote_keep 是 int
	cfg, err := erp.SaveBackupConfig(map[string]any{
		"enabled":             backupBoolOr(body, "enabled", true),
		"interval_hours":      jsonFloat(interval),
		"keep":                json.Number(strconv.Itoa(keep)),
		"remote_enabled":      backupBoolOr(body, "remote_enabled", false),
		"remote_url":          remoteURL,
		"remote_token":        token,
		"remote_keep":         json.Number(strconv.Itoa(remoteKeep)),
		"json_backup_enabled": backupBoolOr(body, "json_backup_enabled", true),
	})
	if err != nil {
		web.WriteValue(w, r, err)
		return
	}
	web.Write(w, http.StatusOK, map[string]any{"ok": true, "config": cfg})
}

// RemoteDeployScript GET /api/backup/remote/deploy-script —— 下载接收端一键部署脚本（纯文本，逐字符对齐 Python）。
func (s *Server) RemoteDeployScript(w http.ResponseWriter, r *http.Request) {
	cfg := erp.LoadBackupConfig()
	// token 缺失时补一个并落盘，保证「部署脚本里的密钥」和「配置里的密钥」是同一个
	if erp.ToStr(cfg["remote_token"]) == "" {
		cfg["remote_token"] = erp.TokenURLSafe(24)
		if _, err := erp.SaveBackupConfig(cfg); err != nil {
			web.WriteValue(w, r, err)
			return
		}
	}
	script, err := erp.DeployScript(cfg)
	if err != nil {
		// Python 里 _remote_params() 的 .port 会抛 ValueError，FastAPI 未捕获 → 500 "Internal Server Error"
		writeBackupInternalError(w)
		return
	}
	writeBackupPlainText(w, script, "deploy_erp_backup_receiver.sh")
}

// RemoteStopScript GET /api/backup/remote/stop-script —— 下载一键停止脚本。
func (s *Server) RemoteStopScript(w http.ResponseWriter, r *http.Request) {
	writeBackupPlainText(w, erp.StopScript(erp.LoadBackupConfig()), "stop_erp_backup_receiver.sh")
}

// writeBackupPlainText 等价 FastAPI 的 PlainTextResponse + Content-Disposition 附件名。
func writeBackupPlainText(w http.ResponseWriter, text, filename string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(text))
}

// writeBackupInternalError 复刻 Starlette ServerErrorMiddleware 的兜底响应：
// 500 + text/plain; charset=utf-8 + 正文 "Internal Server Error"（21 字节，无结尾换行，不带附件头）。
func writeBackupInternalError(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte("Internal Server Error"))
}

// backupBoolOr 取布尔字段，缺键回退 pydantic 的默认值（ToBool(nil) 是 false，不能直接用）。
func backupBoolOr(body map[string]any, k string, def bool) bool {
	v, ok := body[k]
	if !ok || v == nil {
		return def
	}
	return erp.ToBool(v)
}

// jsonFloat 用 Python json.dumps 的 float 形态（整数也带 .0）写出，避免响应里 2.0 变成 2。
func jsonFloat(v float64) json.Number { return json.Number(erp.PyFloat(v)) }
