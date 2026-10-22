package database

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// DefaultWarehouseKey 是历史默认仓（奥斯迪），它的库文件是老文件名 data/erp.db。
const DefaultWarehouseKey = "aosidi"

// ErrUnknownWarehouse 分仓 key 不在注册表里。
var ErrUnknownWarehouse = errors.New("分仓不存在")

// Warehouse 是分仓注册表条目（与 Python warehouses.json 的字段完全一致）。
type Warehouse struct {
	Key       string `json:"key"`
	Name      string `json:"name"`
	DB        string `json:"db"`
	CreatedAt string `json:"created_at"`
	IsCurrent bool   `json:"is_current,omitempty"`
}

// Registry 读写 backend/data/warehouses.json，语义与 Python app/database.py 对齐。
type Registry struct {
	mu            sync.RWMutex
	dataDir       string
	file          string
	warehousesDir string
}

func NewRegistry(dataDir string) *Registry {
	return &Registry{
		dataDir:       dataDir,
		file:          filepath.Join(dataDir, "warehouses.json"),
		warehousesDir: filepath.Join(dataDir, "warehouses"),
	}
}

// DBPath 返回某分仓库文件路径：aosidi 用 erp.db，其余用 warehouses/{key}.db。
func (r *Registry) DBPath(key string) string {
	if key == "" {
		key = DefaultWarehouseKey
	}
	if key == DefaultWarehouseKey {
		return filepath.Join(r.dataDir, "erp.db")
	}
	return filepath.Join(r.warehousesDir, key+".db")
}

type registryFile struct {
	Current string      `json:"current"`
	List    []Warehouse `json:"list"`
}

func (r *Registry) load() registryFile {
	raw, err := os.ReadFile(r.file)
	if err != nil {
		// 文件缺失时按 Python 的行为建出默认注册表
		d := registryFile{Current: DefaultWarehouseKey, List: []Warehouse{{
			Key: DefaultWarehouseKey, Name: "奥斯迪仓", DB: "erp.db", CreatedAt: nowISO(),
		}}}
		_ = r.save(d)
		return d
	}
	var d registryFile
	if err := json.Unmarshal(raw, &d); err != nil {
		return registryFile{Current: DefaultWarehouseKey, List: []Warehouse{}}
	}
	return d
}

func (r *Registry) save(d registryFile) error {
	if err := os.MkdirAll(filepath.Dir(r.file), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	tmp := r.file + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, r.file) // 原子替换，断电也不会损坏注册表
}

// List 返回全部分仓。
func (r *Registry) List() []Warehouse {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Warehouse, len(r.load().List))
	copy(out, r.load().List)
	return out
}

// DefaultKey 返回默认分仓（新登录会话从这里起步），带非法值兜底。
func (r *Registry) DefaultKey() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	d := r.load()
	keys := make(map[string]bool)
	for _, w := range d.List {
		keys[w.Key] = true
	}
	if !keys[d.Current] {
		if len(d.List) > 0 {
			d.Current = d.List[0].Key
		} else {
			d.Current = DefaultWarehouseKey
		}
		_ = r.save(d)
	}
	return d.Current
}

// SetDefaultKey 设置默认分仓（只影响之后新登录的会话起点，与 Python 语义一致）。
func (r *Registry) SetDefaultKey(key string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	d := r.load()
	found := false
	for _, w := range d.List {
		if w.Key == key {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("分仓不存在: %s", key)
	}
	d.Current = key
	return r.save(d)
}

// KeyExists 判断分仓是否已注册（校验令牌里的 wh 时用，避免用废弃 key 建野库）。
func (r *Registry) KeyExists(key string) bool {
	if key == "" {
		return false
	}
	for _, w := range r.load().List {
		if w.Key == key {
			return true
		}
	}
	return false
}

// Name 返回分仓显示名，找不到就回退 key。
func (r *Registry) Name(key string) string {
	for _, w := range r.load().List {
		if w.Key == key {
			if w.Name != "" {
				return w.Name
			}
			return key
		}
	}
	if key == "" {
		return r.DefaultKey()
	}
	return key
}

// Register 新增分仓条目（库文件已由 Manager 初始化好后调用）。
func (r *Registry) Register(key, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	d := r.load()
	for _, w := range d.List {
		if w.Key == key {
			return fmt.Errorf("分仓 key 已存在: %s", key)
		}
	}
	d.List = append(d.List, Warehouse{Key: key, Name: name, DB: "warehouses/" + key + ".db", CreatedAt: nowISO()})
	return r.save(d)
}

// ResolveKey 把请求里的 ?wh= 解析为有效分仓：非法/未注册则回退到会话分仓。
func (r *Registry) ResolveKey(wh, sessionKey string) string {
	if wh != "" && r.KeyExists(wh) {
		return wh
	}
	if sessionKey != "" {
		return sessionKey
	}
	return r.DefaultKey()
}

// Manager 持有每个分仓的连接池，按 key 懒加载并确保表结构存在。
type Manager struct {
	Registry *Registry
	// AfterOpen 在每个分仓连接池建好后跑一次（种子账号/扣点种子/商品回填，见 erp.BootWarehouse）。
	// 由 api 层注入，避免 database 反过来依赖业务包。
	AfterOpen func(*sql.DB) error

	mu    sync.Mutex
	pools map[string]*sql.DB
}

func NewManager(reg *Registry) *Manager {
	return &Manager{Registry: reg, pools: map[string]*sql.DB{}}
}

// DB 返回某分仓的连接池（必要时打开并建表），并跑一次开机数据层。
func (m *Manager) DB(key string) (*sql.DB, error) { return m.open(key, true) }

// DBNoBoot 与 DB 相同，但跳过开机数据层。
// 新建分仓走这条路：Python 的 init_warehouse 是先 copy_users 再 ensure_seed_users，
// 若这里照常跑钩子，种子账号会让 users 非空，后面的 copy_users 会整表跳过。
func (m *Manager) DBNoBoot(key string) (*sql.DB, error) { return m.open(key, false) }

func (m *Manager) open(key string, runBoot bool) (*sql.DB, error) {
	if key == "" {
		key = m.Registry.DefaultKey()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if db, ok := m.pools[key]; ok {
		return db, nil
	}
	path := m.Registry.DBPath(key)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	dsn := "file:" + filepath.ToSlash(path) +
		"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite 单写者：并发写会靠 busy_timeout 排队，这里限制连接数避免长时间持锁。
	db.SetMaxOpenConns(4)
	db.SetConnMaxLifetime(time.Hour)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := ensureSchema(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("初始化分仓库 %s 失败: %w", key, err)
	}
	if err := seedUnits(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	// 开机数据层失败不阻断建池：Python 侧回填失败也只是打印后继续（见 initdb.migrate），
	// 这里再晚一步失败会让整个分仓读不出来，代价明显更大。
	if runBoot && m.AfterOpen != nil {
		if err := m.AfterOpen(db); err != nil {
			log.Printf("[warn] 分仓 %s 开机数据层未跑完: %v", key, err)
		}
	}
	m.pools[key] = db
	return db, nil
}

// DefaultDB 返回默认分仓的连接池。
func (m *Manager) DefaultDB() (*sql.DB, error) { return m.DB(m.Registry.DefaultKey()) }

// EnsureSchema 对外暴露建表入口（新建分仓时用）。
func (m *Manager) EnsureSchema(key string) error {
	_, err := m.DB(key)
	return err
}

// Close 关闭所有连接池。
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, db := range m.pools {
		_ = db.Close()
		delete(m.pools, k)
	}
}

func ensureSchema(db *sql.DB) error {
	if _, err := db.Exec(schemaDDL); err != nil {
		return err
	}
	return migrateExtraColumns(db)
}

// migrateExtraColumns 补齐缺失列（Python 侧新增字段后，老分仓库也能被 Go 正常使用）。
func migrateExtraColumns(db *sql.DB) error {
	for table, defs := range extraColumns {
		rows, err := db.Query("PRAGMA table_info(" + table + ")")
		if err != nil {
			return err
		}
		have := map[string]bool{}
		for rows.Next() {
			var cid int
			var name, typ string
			var notnull int
			var dflt sql.NullString
			var pk int
			if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
				rows.Close()
				return err
			}
			have[name] = true
		}
		rows.Close()
		for _, def := range defs {
			col := strings.Fields(def)[0]
			if have[col] {
				continue
			}
			if _, err := db.Exec("ALTER TABLE " + table + " ADD COLUMN " + def); err != nil {
				return fmt.Errorf("补齐 %s.%s 失败: %w", table, col, err)
			}
		}
	}
	return nil
}

// seedUnits 与 Python services.seed_units 一致：units 表为空时写入标准单位。
func seedUnits(db *sql.DB) error {
	var n int
	if err := db.QueryRow("SELECT COUNT(1) FROM units").Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	weight := []struct {
		name string
		gram float64
	}{{"克", 1}, {"斤", 500}, {"公斤", 1000}, {"千克", 1000}}
	count := []string{"个", "包", "袋", "盒", "箱", "件", "份"}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare("INSERT INTO units (name, category, gram_per_unit, is_standard) VALUES (?, ?, ?, 1)")
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, w := range weight {
		if _, err := stmt.Exec(w.name, "weight", w.gram); err != nil {
			return err
		}
	}
	for _, c := range count {
		if _, err := stmt.Exec(c, "count", nil); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func nowISO() string { return time.Now().Format("2006-01-02T15:04:05") }
