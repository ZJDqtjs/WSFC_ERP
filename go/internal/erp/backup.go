package erp

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	sqlite "modernc.org/sqlite"
)

// 本文件是「数据库备份与恢复」业务层，逐段对齐 app/routers/backup.py。
// 备份对象是 SQLite 分仓库文件（data/erp.db 与 data/warehouses/*.db），产物在 data/backups/；
// 配置在 data/backup_config.json、远程推送状态在 data/backup_remote_status.json。
// 与 Python 一样，备份/恢复走 SQLite 在线备份接口（sqlite3_backup_*），天然兼容 WAL：
// 不是「先 checkpoint 再拷文件」，而是在线把源库页复制进目标库，运行中的写事务不会被打断。

// BackupDataDir / BackupJSONDir 由接口层在启动时注入（等于 Python 的 DATA_DIR 与 backend/json）。
var (
	BackupDataDir = ""
	BackupJSONDir = ""
)

const (
	// backupDefaultWarehouseKey 与 database.DefaultWarehouseKey 同值（奥斯迪仓沿用 erp_backup_* 前缀）。
	backupDefaultWarehouseKey = "aosidi"
	jsonBackupPrefixConst     = "json_backup_"
	remoteAppDirConst         = "/opt/erp-backup-receiver"
)

// autoBackupRE / jsonAutoRE：只匹配系统自动生成的文件名，手动丢进备份目录的文件不参与清理。
var (
	autoBackupRE = regexp.MustCompile(`^([A-Za-z0-9_-]+)_backup_\d{8}_\d{6}\.db$`)
	jsonAutoRE   = regexp.MustCompile(`^json_backup_\d{8}_\d{6}\.tar\.gz$`)
)

// json 目录打包时的忽略清单（与 Python JSON_SKIP_* 一致）。
var (
	jsonSkipNames    = map[string]bool{".DS_Store": true}
	jsonSkipSuffixes = []string{".tmp", ".part", "~"}
	jsonSkipDirs     = map[string]bool{"__pycache__": true}
)

// ---- 路径 ----

// BackupDir 返回 data/backups。
func BackupDir() string { return filepath.Join(BackupDataDir, "backups") }

// BackupConfigFile 返回 data/backup_config.json。
func BackupConfigFile() string { return filepath.Join(BackupDataDir, "backup_config.json") }

// BackupStatusFile 返回 data/backup_remote_status.json。
func BackupStatusFile() string { return filepath.Join(BackupDataDir, "backup_remote_status.json") }

// backupJSONHashFile 返回 data/json_backup_hash.txt（json 目录内容指纹，用于「无变化则跳过」）。
func backupJSONHashFile() string { return filepath.Join(BackupDataDir, "json_backup_hash.txt") }

// ---- 配置 ----

// DefaultBackupConfig 与 Python DEFAULT_CONFIG 同值；数字用 json.Number 保留 Python 的整数/浮点形态，
// 这样 interval_hours 默认 2（整数）在响应里就是 2，而文件里的 4.0 读回来仍是 4.0。
func DefaultBackupConfig() map[string]any {
	return map[string]any{
		"enabled":             true,
		"interval_hours":      json.Number("2"),
		"keep":                json.Number("30"),
		"remote_enabled":      false,
		"remote_url":          "",
		"remote_token":        "",
		"remote_keep":         json.Number("100"),
		"json_backup_enabled": true,
	}
}

// LoadBackupConfig 读配置：文件缺失/JSON 非法/不是对象时全部回退默认值（与 Python 的 try/except 一致）。
func LoadBackupConfig() map[string]any {
	cfg := DefaultBackupConfig()
	raw, err := os.ReadFile(BackupConfigFile())
	if err != nil {
		return cfg
	}
	for k, v := range decodeJSONObject(raw) {
		cfg[k] = v
	}
	return cfg
}

// SaveBackupConfig 落盘配置（json.dumps(indent=2, ensure_ascii=False) 的等价写法），返回原对象。
func SaveBackupConfig(cfg map[string]any) (map[string]any, error) {
	raw, err := marshalJSONNoEscape(cfg)
	if err != nil {
		return cfg, err
	}
	if err := os.WriteFile(BackupConfigFile(), raw, 0o644); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// marshalJSONNoEscape 等价 json.dumps(v, ensure_ascii=False, indent=2)：
// 不转义 < > &、两空格缩进、不补尾随换行；json.Number 原样输出（保住 4.0 的小数形态）。
func marshalJSONNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// LoadRemoteStatus 读远程推送状态；文件缺失或损坏时返回空对象（响应里是 {} 而不是 null）。
func LoadRemoteStatus() map[string]any {
	out := map[string]any{}
	raw, err := os.ReadFile(BackupStatusFile())
	if err != nil {
		return out
	}
	for k, v := range decodeJSONObject(raw) {
		out[k] = v
	}
	return out
}

// decodeJSONObject 等价 json.loads(text) 后必须是对象：非法 JSON、非对象、文件里有多余内容都返回 nil，
// 由调用方按 Python 的 try/except 回退默认值。数字用 json.Number 保住原样（4.0 不会被压成 4）。
func decodeJSONObject(raw []byte) map[string]any {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil // json.loads 会对「一个值之后还有内容」报错
	}
	data, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return data
}

// ---- 文件名归属 ----

// BackupPrefix 奥斯迪仓沿用历史 erp_backup_* 前缀，其他仓用仓 key。
func BackupPrefix(key string) string {
	if key == backupDefaultWarehouseKey {
		return "erp"
	}
	return key
}

// BackupBelongsTo 备份文件是否属于指定分仓（前缀匹配）。
func BackupBelongsTo(name, key string) bool {
	return strings.HasPrefix(name, BackupPrefix(key)+"_")
}

// IsAutoBackup 是否是系统自动生成的备份名（只有它参与自动清理）。
func IsAutoBackup(name string) bool { return autoBackupRE.MatchString(name) }

// ---- 备份 / 恢复（SQLite 在线备份接口） ----

// sqliteBackupConn 是 modernc.org/sqlite 连接对象上的在线备份能力。
// 它的 conn 类型未导出，只能按导出的方法名做接口断言（database/sql 的 Conn.Raw 拿到底层驱动连接）。
type sqliteBackupConn interface {
	NewBackup(dstUri string) (*sqlite.Backup, error)
	NewRestore(srcUri string) (*sqlite.Backup, error)
}

// runSQLiteBackup 从本请求分仓的连接池借一条连接执行备份/恢复，把整库页一次性复制过去。
func runSQLiteBackup(ctx context.Context, db *sql.DB, open func(sqliteBackupConn) (*sqlite.Backup, error)) error {
	if db == nil {
		return fmt.Errorf("分仓数据库不可用")
	}
	c, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	return c.Raw(func(dc any) error {
		b, ok := dc.(sqliteBackupConn)
		if !ok {
			return fmt.Errorf("SQLite 驱动不支持在线备份")
		}
		bk, err := open(b)
		if err != nil {
			return err
		}
		for {
			more, err := bk.Step(-1) // -1 = 一次拷完剩余页
			if err != nil {
				_ = bk.Finish()
				return err
			}
			if !more {
				break
			}
		}
		return bk.Finish()
	})
}

// CreateBackupFile 备份指定分仓（key 为本登录会话的分仓），返回备份文件名。
// 与 Python 一致：建目录 → 在线备份 → 按 keep 清理本仓旧备份 →（远程推送在 Go 里不执行）。
func CreateBackupFile(ctx context.Context, db *sql.DB, key string) (string, error) {
	if err := os.MkdirAll(BackupDir(), 0o755); err != nil {
		return "", err
	}
	name := BackupPrefix(key) + "_backup_" + time.Now().Format("20060102_150405") + ".db"
	target := filepath.Join(BackupDir(), name)
	if err := runSQLiteBackup(ctx, db, func(b sqliteBackupConn) (*sqlite.Backup, error) {
		return b.NewBackup(target)
	}); err != nil {
		return "", err
	}
	PruneBackups(key)
	return name, nil
}

// RestoreBackupFile 把备份文件覆盖写回当前分仓库（src.backup(dst) 的反向用法）。
func RestoreBackupFile(ctx context.Context, db *sql.DB, srcPath string) error {
	return runSQLiteBackup(ctx, db, func(b sqliteBackupConn) (*sqlite.Backup, error) {
		return b.NewRestore(srcPath)
	})
}

// PruneBackups 仅清理指定分仓的自动生成备份（按 mtime 倒序保留 keep 份），手动放入的文件不动。
func PruneBackups(key string) {
	cfg := LoadBackupConfig()
	keep := BackupKeepCount(cfg)
	files := listBackupDir(BackupDir(), func(n string) bool {
		return strings.HasSuffix(n, ".db") && BackupBelongsTo(n, key) && IsAutoBackup(n)
	})
	for _, f := range dropHead(files, keep) {
		_ = os.Remove(filepath.Join(BackupDir(), f.name))
	}
}

// BackupKeepCount 与 Python max(1, int(cfg.get("keep", 30))) 一致。
func BackupKeepCount(cfg map[string]any) int {
	keep := ToInt(cfg["keep"])
	if keep < 1 {
		return 1
	}
	return keep
}

// ---- 列表 ----

type backupFile struct {
	name  string
	size  int64
	mtime time.Time
}

// listBackupDir 按 mtime 倒序列出目录里符合条件的普通文件（先排序再过滤，和 Python 的 glob+sorted 同序）。
func listBackupDir(dir string, matchAll func(name string) bool) []backupFile {
	out := []backupFile{}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, ent := range ents {
		if ent.IsDir() {
			continue
		}
		if !matchAll(ent.Name()) {
			continue
		}
		info, err := ent.Info()
		if err != nil {
			continue
		}
		out = append(out, backupFile{name: ent.Name(), size: info.Size(), mtime: info.ModTime()})
	}
	// 稳定排序，保持并列 mtime 时的目录读取顺序（Python sorted(...) 也是稳定的）
	sort.SliceStable(out, func(i, j int) bool { return out[i].mtime.After(out[j].mtime) })
	return out
}

func dropHead(files []backupFile, n int) []backupFile {
	if n < 0 {
		n = 0
	}
	if len(files) <= n {
		return nil
	}
	return files[n:]
}

func backupRow(f backupFile) map[string]any {
	return map[string]any{
		"name":       f.name,
		"size":       f.size,
		"size_human": HumanSize(f.size),
		"mtime":      f.mtime.Format("2006-01-02 15:04:05"),
	}
}

// ListBackups 只展示指定分仓的备份（隔离语义），按 mtime 倒序。
func ListBackups(key string) []map[string]any {
	rows := []map[string]any{}
	for _, f := range listBackupDir(BackupDir(), func(n string) bool { return strings.HasSuffix(n, ".db") }) {
		if !BackupBelongsTo(f.name, key) {
			continue
		}
		rows = append(rows, backupRow(f))
	}
	return rows
}

// ListJSONBackups 列出 json 目录备份（只认自动生成的文件名格式），按 mtime 倒序。
func ListJSONBackups() []map[string]any {
	rows := []map[string]any{}
	for _, f := range listBackupDir(BackupDir(), func(n string) bool {
		return strings.HasPrefix(n, jsonBackupPrefixConst) && strings.HasSuffix(n, ".tar.gz") && jsonAutoRE.MatchString(n)
	}) {
		rows = append(rows, backupRow(f))
	}
	return rows
}

// HumanSize 与 Python _human_size 一致：B / KB / MB 三档，一位小数，超过 1GB 仍按 MB 展示。
func HumanSize(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	if n < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(n)/1024/1024)
}

// ---- 路径安全 ----

// SafeBackupPath 校验备份文件名，防止路径穿越；返回绝对路径。
// 与 Python _safe_path 同语义：拼到备份目录后解析，仍必须在备份目录内，否则「非法文件名」。
func SafeBackupPath(name string) (string, error) {
	root := BackupDir()
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	p, err := filepath.Abs(filepath.Join(abs, filepath.FromSlash(name)))
	if err != nil {
		return "", err
	}
	if !pathWithin(abs, p) {
		return "", ErrText("非法文件名")
	}
	return p, nil
}

// pathWithin 判断 p 是否等于或位于 root 之内（Windows 上路径大小写不敏感）。
func pathWithin(root, p string) bool {
	r, q := filepath.Clean(root), filepath.Clean(p)
	if runtime.GOOS == "windows" {
		r, q = strings.ToLower(r), strings.ToLower(q)
	}
	if r == q {
		return true
	}
	return strings.HasPrefix(q, r+string(os.PathSeparator))
}

// ---- backend/json 目录整体备份 ----

type jsonEntry struct {
	abs   string
	rel   string
	parts []string
}

// normPathPart 复刻 Python 的路径比较键：Windows 上 normcase 会转小写，类 Unix 上原样。
func normPathPart(s string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(s)
	}
	return s
}

// compareJSONPathParts 逐段比较（Python 排序 WindowsPath 就是按路径分段逐个比，且整条路径同前缀）。
func compareJSONPathParts(a, b []string) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		x, y := normPathPart(a[i]), normPathPart(b[i])
		if x != y {
			return x < y
		}
	}
	return len(a) < len(b)
}

// iterJSONFiles 列出 json 目录下要纳入备份的文件（跳过临时/缓存），顺序与 Python sorted(rglob("*")) 一致。
func iterJSONFiles() []jsonEntry {
	root := BackupJSONDir
	if root == "" {
		return nil
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return nil
	}
	var out []jsonEntry
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) == 0 || parts[0] == "" || parts[0] == ".." {
			return nil
		}
		// 父目录里出现 __pycache__ 就整段跳过（只看父段，末段是文件名）
		for _, d := range parts[:len(parts)-1] {
			if jsonSkipDirs[d] {
				return nil
			}
		}
		base := parts[len(parts)-1]
		if jsonSkipNames[base] {
			return nil
		}
		for _, s := range jsonSkipSuffixes {
			if strings.HasSuffix(base, s) {
				return nil
			}
		}
		out = append(out, jsonEntry{abs: p, rel: strings.Join(parts, "/"), parts: parts})
		return nil
	})
	sort.SliceStable(out, func(i, j int) bool { return compareJSONPathParts(out[i].parts, out[j].parts) })
	return out
}

// jsonFingerprint 目录内容指纹（相对路径 + 大小 + 整秒 mtime 逐文件 sha256）；目录空/不存在返回空串。
func jsonFingerprint() string {
	h := sha256.New()
	anyFile := false
	for _, e := range iterJSONFiles() {
		anyFile = true
		st, err := os.Stat(e.abs)
		if err != nil {
			continue
		}
		fmt.Fprintf(h, "%s\x00%d\x00%d\n", e.rel, st.Size(), st.ModTime().Unix())
	}
	if !anyFile {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

// PruneJSONBackups json 备份单独清理，保留份数沿用 keep 配置。
func PruneJSONBackups() {
	cfg := LoadBackupConfig()
	keep := BackupKeepCount(cfg)
	files := listBackupDir(BackupDir(), func(n string) bool {
		return strings.HasPrefix(n, jsonBackupPrefixConst) && strings.HasSuffix(n, ".tar.gz") && jsonAutoRE.MatchString(n)
	})
	for _, f := range dropHead(files, keep) {
		_ = os.Remove(filepath.Join(BackupDir(), f.name))
	}
}

// CreateJSONBackupFile 把 backend/json 整目录打成 data/backups/json_backup_时间戳.tar.gz。
// 目录内容相比上次备份没变化就跳过（force 可强制）；跳过时返回空串（接口层给出 null）。
// 远程推送在 Go 侧不执行（见模块说明），其余流程与 Python 一致。
func CreateJSONBackupFile(force bool) (string, error) {
	digest := jsonFingerprint()
	if digest == "" {
		log.Printf("[json备份] 未找到 backend/json 目录或目录为空，跳过")
		return "", nil
	}
	last := ""
	if raw, err := os.ReadFile(backupJSONHashFile()); err == nil {
		last = strings.TrimSpace(string(raw))
	}
	if digest == last && !force {
		return "", nil // 无变化，不产文件也不推送
	}
	if err := os.MkdirAll(BackupDir(), 0o755); err != nil {
		return "", err
	}
	name := jsonBackupPrefixConst + time.Now().Format("20060102_150405") + ".tar.gz"
	target := filepath.Join(BackupDir(), name)
	tmp := target + ".part"
	if err := writeJSONTar(tmp); err != nil {
		_ = os.Remove(tmp)
		log.Printf("[json备份] 打包失败：%v", err)
		return "", nil
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		log.Printf("[json备份] 打包失败：%v", err)
		return "", nil
	}
	_ = os.WriteFile(backupJSONHashFile(), []byte(digest), 0o644)
	PruneJSONBackups()
	return name, nil
}

// writeJSONTar 先写 .part 临时文件再改名，避免半个包被当成有效备份（与 Python 同）。
// 成员顺序、arcname（相对路径、正斜杠）都与 tarfile.add(arcname=rel, recursive=False) 一致；
// 压缩档位取 BestCompression，尽量贴近 Python tarfile 的 gzip 默认级别（9）。
func writeJSONTar(tmp string) error {
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	gz, err := gzip.NewWriterLevel(f, gzip.BestCompression)
	if err != nil {
		_ = f.Close()
		return err
	}
	tw := tar.NewWriter(gz)
	for _, e := range iterJSONFiles() {
		st, err := os.Stat(e.abs)
		if err != nil {
			continue // 打包途中文件被删：跳过该文件（Python 也是 except OSError: pass）
		}
		if err := tarAddFile(tw, e.abs, e.rel, st); err != nil {
			continue
		}
	}
	cerr := tw.Close()
	gerr := gz.Close()
	ferr := f.Close()
	if cerr != nil {
		return cerr
	}
	if gerr != nil {
		return gerr
	}
	return ferr
}

// tarAddFile 以普通文件写入 tar 成员（GNU 格式，避免 PAX 扩展头，贴近 Python tarfile 的 Windows 产物）。
func tarAddFile(tw *tar.Writer, abs, rel string, st os.FileInfo) error {
	src, err := os.Open(abs)
	if err != nil {
		return err
	}
	defer src.Close()
	mode := int64(0o644)
	if m := st.Mode().Perm(); m != 0 {
		mode = int64(m)
	}
	hdr := &tar.Header{
		Name:     rel,
		Size:     st.Size(),
		Mode:     mode,
		ModTime:  st.ModTime(),
		Typeflag: tar.TypeReg,
		Format:   tar.FormatGNU,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err = io.Copy(tw, src)
	return err
}

// ---- 远程接收端参数（只用于生成脚本文本，不发起任何网络请求） ----

// RemoteTarget 远程接收端地址拆解结果。
type RemoteTarget struct {
	Scheme string
	Host   string
	Port   int
	Path   string
}

// ErrBackupRemoteURL 对应 Python urlparse()/.port 抛出的 ValueError：
// Python 不捕获它，所以 deploy-script 接口会直接 500，Go 用同一个错误走同样的分支。
var ErrBackupRemoteURL = errors.New("非法的远程备份地址")

// ParseRemoteURL 把用户输入的 ip:port/path（或完整 URL）拆成 scheme/host/port/path。
// 逐条复刻 CPython 3.12 urllib.parse 的行为（_parse_remote_url + urlsplit + SplitResult.hostname/.port）：
//   - 左剥 C0 控制符与空格、删除所有 \t\r\n；
//   - scheme 必须是 字母 开头且只含 [A-Za-z0-9+-.]，转小写；
//   - "//" 后到第一个 / ? # 之间是 netloc，方括号不成对或括号内含非法字符 → 抛错；
//   - host 取最后一个 '@' 之后的部分，'[' 存在时按 IPv6 处理，host 截到 '%' 前并小写；
//   - 非 IPv6 时端口是「第一个 ':' 之后的全部」，所以 1.2.3.4:8080:9 的端口是 "8080:9"（Python 同样报错）；
//   - 端口必须是纯 ASCII 数字且在 0-65535，否则抛错；空端口/0 端口回落到 443|80；
//   - host 为空则返回 (nil,false)，对应 Python 的 return None（用兜底值），这条判断在端口校验之前。
func ParseRemoteURL(raw string) (*RemoteTarget, bool, error) {
	raw = pyStrip(raw)
	if raw == "" {
		return nil, false, nil
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	scheme, netloc, path, query, err := splitURLLikeCPython(raw)
	if err != nil {
		return nil, false, err
	}
	host, portStr := hostPortOf(netloc)
	if host == "" {
		return nil, false, nil
	}
	if scheme == "" {
		scheme = "http"
	}
	port := 0
	if portStr != "" {
		if !isASCIIDigits(portStr) {
			return nil, false, ErrBackupRemoteURL
		}
		n, cerr := strconv.Atoi(portStr)
		if cerr != nil || n < 0 || n > 65535 {
			return nil, false, ErrBackupRemoteURL
		}
		port = n
	}
	if port == 0 {
		if scheme == "https" {
			port = 443
		} else {
			port = 80
		}
	}
	p := path
	if p == "" {
		p = "/"
	}
	if query != "" {
		p += "?" + query
	}
	return &RemoteTarget{Scheme: scheme, Host: host, Port: port, Path: p}, true, nil
}

// splitURLLikeCPython 拆出 scheme/netloc/path/query，fragment 直接丢掉（Python 的 path 也不含 fragment）。
func splitURLLikeCPython(raw string) (scheme, netloc, path, query string, err error) {
	raw = strings.TrimLeftFunc(raw, func(r rune) bool { return r <= 0x20 })
	raw = strings.NewReplacer("\t", "", "\r", "", "\n", "").Replace(raw)
	if i := strings.IndexByte(raw, ':'); i > 0 && isASCIILetterByte(raw[0]) {
		if isSchemeChars(raw[:i]) {
			scheme = strings.ToLower(raw[:i])
			raw = raw[i+1:]
		}
	}
	if strings.HasPrefix(raw, "//") {
		rest := raw[2:]
		end := len(rest)
		for _, c := range []byte{'/', '?', '#'} {
			if k := strings.IndexByte(rest, c); k >= 0 && k < end {
				end = k
			}
		}
		netloc, raw = rest[:end], rest[end:]
		if strings.Contains(netloc, "[") != strings.Contains(netloc, "]") {
			return "", "", "", "", ErrBackupRemoteURL
		}
		if strings.Contains(netloc, "[") && strings.Contains(netloc, "]") {
			if err := checkBracketedNetloc(netloc); err != nil {
				return "", "", "", "", err
			}
		}
	}
	if k := strings.IndexByte(raw, '#'); k >= 0 {
		raw = raw[:k]
	}
	if k := strings.IndexByte(raw, '?'); k >= 0 {
		query, raw = raw[k+1:], raw[:k]
	}
	return scheme, netloc, raw, query, nil
}

// checkBracketedNetloc 复刻 Python 的 _check_bracketed_netloc：'[' 前不允许有内容、']' 与 ':' 之间
// 不允许有内容，括号里的内容必须是合法 IPv6（IPv4 进括号也不行），否则 Python 抛 ValueError → 接口 500。
func checkBracketedNetloc(netloc string) error {
	hostinfo := netloc
	if k := strings.LastIndexByte(netloc, '@'); k >= 0 {
		hostinfo = netloc[k+1:]
	}
	open := strings.IndexByte(hostinfo, '[')
	if open > 0 {
		return ErrBackupRemoteURL
	}
	bracketed := hostinfo[open+1:]
	j := strings.IndexByte(bracketed, ']')
	if j < 0 {
		return ErrBackupRemoteURL
	}
	after := bracketed[j+1:]
	if after != "" && after[0] != ':' {
		return ErrBackupRemoteURL
	}
	h := bracketed[:j]
	if strings.HasPrefix(h, "v") { // IPvFuture：v<hex>+ '.' + 至少一个字符
		if !ipvFutureRE.MatchString(h) {
			return ErrBackupRemoteURL
		}
		return nil
	}
	host, zone, hasZone := strings.Cut(h, "%")
	if !strings.Contains(host, ":") {
		return ErrBackupRemoteURL // 括号里的 IPv4，Python 明确拒绝
	}
	if net.ParseIP(host) == nil {
		return ErrBackupRemoteURL
	}
	if hasZone {
		if zone == "" || strings.HasSuffix(zone, ".") {
			return ErrBackupRemoteURL
		}
		for _, r := range zone {
			if !(r >= '0' && r <= '9') && !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') &&
				strings.IndexRune("_.:-+", r) < 0 {
				return ErrBackupRemoteURL
			}
		}
	}
	return nil
}

// hostPortOf 返回 (小写后的 host, 端口原文)；端口为空字符串表示 Python 的 None。
func hostPortOf(netloc string) (string, string) {
	hostinfo := netloc
	if k := strings.LastIndexByte(netloc, '@'); k >= 0 {
		hostinfo = netloc[k+1:]
	}
	var host, port string
	if k := strings.IndexByte(hostinfo, '['); k >= 0 {
		bracketed := hostinfo[k+1:]
		if j := strings.IndexByte(bracketed, ']'); j >= 0 {
			host = bracketed[:j]
			rest := bracketed[j+1:]
			if c := strings.IndexByte(rest, ':'); c >= 0 {
				port = rest[c+1:]
			}
		}
	} else if c := strings.IndexByte(hostinfo, ':'); c >= 0 {
		host, port = hostinfo[:c], hostinfo[c+1:]
	} else {
		host = hostinfo
	}
	if k := strings.IndexByte(host, '%'); k >= 0 { // IPv6 zone id 不转小写
		host = strings.ToLower(host[:k]) + host[k:]
	} else {
		host = strings.ToLower(host)
	}
	return host, port
}

func pyStrip(s string) string { return strings.TrimFunc(s, unicode.IsSpace) }

func isASCIILetterByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func isSchemeChars(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isASCIILetterByte(c) || (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.' {
			continue
		}
		return false
	}
	return len(s) > 0
}

func isASCIIDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// Python 侧是 re.match(r"\Av[a-fA-F0-9]+\..+\Z")；Go RE2 里 ^/$（非 multiline）等价于 \A/\Z。
var ipvFutureRE = regexp.MustCompile(`^v[a-fA-F0-9]+\..+$`)

// RemoteScriptParams 生成部署脚本用的 (端口, 前缀路径, token, keep)；地址没配好时用 Python 的兜底值。
func RemoteScriptParams(cfg map[string]any) (port int, prefix, token string, keep int, err error) {
	t, ok, perr := ParseRemoteURL(ToStr(cfg["remote_url"]))
	if perr != nil {
		return 0, "", "", 0, perr
	}
	if !ok {
		port, prefix = 8080, "/cloudback"
	} else {
		port, prefix = t.Port, t.Path
	}
	token = ToStr(cfg["remote_token"])
	if token == "" {
		token = TokenURLSafe(24)
	}
	keep = orInt(cfg["remote_keep"], 100)
	if !strings.HasPrefix(prefix, "/") {
		prefix = "/" + prefix
	}
	return port, prefix, token, keep, nil
}

// orInt 复刻 Python 的 int(x or 100)：None/false/0/空串都走缺省值。
func orInt(v any, def int) int {
	switch x := v.(type) {
	case nil:
		return def
	case bool:
		if !x {
			return def
		}
	case string:
		if strings.TrimSpace(x) == "" {
			return def
		}
	}
	n := ToInt(v)
	if n == 0 {
		return def
	}
	return n
}

// TokenURLSafe 等价于 secrets.token_urlsafe(n)：n 字节随机数的 base64url（去掉 = 填充）。
func TokenURLSafe(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		// 兜底用时间派生，保证接口不因随机源异常而 500
		copy(buf, []byte(strconv.FormatInt(time.Now().UnixNano(), 10)))
		for len(buf) < n {
			buf = append(buf, 0)
		}
		buf = buf[:n]
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

// RemoteAppDir 接收端在备份服务器上的安装目录（脚本里写死，与 Python _REMOTE_APP_DIR 一致）。
func RemoteAppDir() string { return remoteAppDirConst }
