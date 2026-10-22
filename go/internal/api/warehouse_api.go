package api

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"

	"wsfc-erp-go/internal/database"
	"wsfc-erp-go/internal/erp"
	"wsfc-erp-go/internal/web"
)

// ---------------- 分仓：列表 / 新建 / 切换 ----------------
// 分仓是「会话级」的：切换或新建只重签调用者自己的令牌，不写全局状态，
// 其他在线用户完全不受影响（历史上「一人切仓、全员被登出」的根因已消除）。

var warehouseKeyRE = regexp.MustCompile("^[a-z0-9][a-z0-9_-]{1,31}$")

// Warehouses GET /api/warehouses —— 全员可见（用于切换选择），current 是本会话所在分仓。
func (s *Server) Warehouses(w http.ResponseWriter, r *http.Request) {
	current := web.Warehouse(r)
	items := s.warehouseJSON(current)
	web.Write(w, http.StatusOK, map[string]any{"current": current, "warehouses": items})
}

func (s *Server) warehouseJSON(current string) []map[string]any {
	out := []map[string]any{}
	for _, wh := range s.Mgr.Registry.List() {
		out = append(out, map[string]any{
			"key": wh.Key, "name": wh.Name, "db": wh.DB, "created_at": wh.CreatedAt,
			"is_current": wh.Key == current,
		})
	}
	return out
}

// CreateWarehouse POST /api/warehouses —— 新建分仓（初始化独立库 + 复制本会话所在仓的用户 + 把本会话切过去）。仅管理员。
func (s *Server) CreateWarehouse(w http.ResponseWriter, r *http.Request) {
	user := MustUser(r)
	if !user.IsAdmin() {
		web.Error(w, http.StatusForbidden, "仅管理员可操作分仓")
		return
	}
	var body struct {
		Name string "json:\"name\""
		Key  string "json:\"key\""
	}
	if err := web.Bind(r, &body); err != nil {
		web.WriteValue(w, r, err)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		web.Error(w, http.StatusBadRequest, "请输入分仓名称")
		return
	}
	if len([]rune(name)) > 32 {
		web.Error(w, http.StatusBadRequest, "分仓名称过长（≤32 字）")
		return
	}
	key := strings.ToLower(strings.TrimSpace(body.Key))
	if key != "" && !warehouseKeyRE.MatchString(key) {
		web.Error(w, http.StatusBadRequest, "key 仅允许小写字母/数字/下划线/连字符")
		return
	}
	used := map[string]bool{}
	for _, wh := range s.Mgr.Registry.List() {
		used[wh.Key] = true
	}
	if key == "" {
		for n := 1; n < 10000; n++ {
			cand := fmt.Sprintf("wh%02d", n)
			if !used[cand] {
				key = cand
				break
			}
		}
	}
	if used[key] {
		web.Error(w, http.StatusBadRequest, "分仓 key 已存在: %s", key)
		return
	}
	path := s.Mgr.Registry.DBPath(key)
	if _, err := os.Stat(path); err == nil {
		web.Error(w, http.StatusBadRequest, "分仓库文件已存在: %s", baseName(path))
		return
	}
	if err := s.initWarehouse(key, web.Warehouse(r)); err != nil {
		web.Error(w, http.StatusInternalServerError, "分仓创建失败: %s", err.Error())
		return
	}
	if err := s.Mgr.Registry.Register(key, name); err != nil {
		web.Error(w, http.StatusInternalServerError, "分仓创建失败: %s", err.Error())
		return
	}
	if _, err := s.issueToken(w, user.ID, key); err != nil {
		web.Error(w, http.StatusInternalServerError, "分仓创建失败: %s", err.Error())
		return
	}
	web.Write(w, http.StatusOK, map[string]any{
		"ok": true, "current": key,
		"warehouse": map[string]any{"key": key, "name": name, "db": "warehouses/" + key + ".db"},
	})
}

// SwitchWarehouse POST /api/warehouses/switch —— 切换本会话的分仓（重签令牌，立即生效）。仅管理员。
func (s *Server) SwitchWarehouse(w http.ResponseWriter, r *http.Request) {
	user := MustUser(r)
	if !user.IsAdmin() {
		web.Error(w, http.StatusForbidden, "仅管理员可操作分仓")
		return
	}
	var body struct {
		Key string "json:\"key\""
	}
	if err := web.Bind(r, &body); err != nil {
		web.WriteValue(w, r, err)
		return
	}
	key := strings.TrimSpace(body.Key)
	if !s.Mgr.Registry.KeyExists(key) {
		web.Error(w, http.StatusNotFound, "分仓不存在")
		return
	}
	if _, err := s.issueToken(w, user.ID, key); err != nil {
		web.Error(w, http.StatusInternalServerError, "切换分仓失败: %s", err.Error())
		return
	}
	web.Write(w, http.StatusOK, map[string]any{
		"ok": true, "current": key,
		"warehouse": map[string]any{"key": key, "name": s.Mgr.Registry.Name(key)},
	})
}

// initWarehouse 建库 + 灌模板数据 + 从源仓复制账号（等价 Python initdb.init_warehouse）。
func (s *Server) initWarehouse(key, copyUsersFrom string) error {
	// 建池时先不跑开机数据层：顺序要跟 Python init_warehouse 一致
	// （copy_users 在前、种子账号在后），否则 users 先被种子账号占住，整表复制会被跳过。
	db, err := s.Mgr.DBNoBoot(key)
	if err != nil {
		return err
	}
	if err := s.Mgr.EnsureSchema(key); err != nil {
		return err
	}
	if copyUsersFrom != "" {
		src, err := s.Mgr.DB(copyUsersFrom)
		if err == nil {
			if err := copyUsers(src, db); err != nil {
				return err
			}
		}
	}
	if err := seedCatalog(db, key); err != nil {
		return err
	}
	// 与 Python 同序：复制账号、建好目录之后再补种子账号 / 扣点种子 / 商品回填。
	if err := erp.BootWarehouse(db); err != nil {
		log.Printf("[warn] 新分仓 %s 开机数据层未跑完: %v", key, err)
	}
	return nil
}

// copyUsers 整表复制 users（保持 id），新仓的登录指纹与账号跟源仓一致。
func copyUsers(src, dst *sql.DB) error {
	var count int
	if err := dst.QueryRow("SELECT COUNT(1) FROM users").Scan(&count); err == nil && count > 0 {
		return nil
	}
	rows, err := src.Query("SELECT id, username, password_hash, name, role, is_active, public_key, fingerprint, key_created_at, created_at FROM users ORDER BY id")
	if err != nil {
		return err
	}
	defer rows.Close()
	ctx := context.Background()
	for rows.Next() {
		var (
			id                          int
			username, passwordHash, name string
			role                         string
			isActive                     int
			publicKey, fingerprint       sql.NullString
			keyCreatedAt, createdAt      sql.NullString
		)
		if err := rows.Scan(&id, &username, &passwordHash, &name, &role, &isActive, &publicKey, &fingerprint, &keyCreatedAt, &createdAt); err != nil {
			return err
		}
		if _, err := dst.ExecContext(ctx,
			"INSERT OR REPLACE INTO users (id, username, password_hash, name, role, is_active, public_key, fingerprint, key_created_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
			id, username, passwordHash, name, role, isActive, publicKey, fingerprint, keyCreatedAt, createdAt); err != nil {
			return err
		}
	}
	return rows.Err()
}

// seedCatalog 奥斯迪（默认仓）播「入仓品资料」模板，其它分仓只播标准单位。
func seedCatalog(db *sql.DB, key string) error {
	if key != database.DefaultWarehouseKey {
		return nil
	}
	_, err := db.Exec("UPDATE products SET is_active = is_active WHERE 1 = 0")
	return err
}

func baseName(p string) string {
	if i := strings.LastIndexAny(p, "/\\"); i >= 0 {
		return p[i+1:]
	}
	return p
}

