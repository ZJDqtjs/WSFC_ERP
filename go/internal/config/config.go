package config

import (
	"os"
	"path/filepath"
	"strings"
)

// Config 是 Go 服务的运行配置：所有字段都可以用环境变量覆盖，
// 目的是让 Go 能与现有 Python 后端共用同一份数据目录（backend/data、backend/json），
// 迁移期两者可以并跑（Go 原生接口 + 未实现接口回源代理）。
type Config struct {
	// Addr Go 服务监听地址，默认 :8100（与旧版网关保持一致）
	Addr string
	// LegacyBackendURL 未原生实现的业务接口回源地址（Python 后端）
	LegacyBackendURL string
	// BackendDir Python 后端的 backend 目录；数据与 json 配置都相对它定位
	BackendDir string
	// GatewayEnabled 是否启用回源代理（Python 已下线时置 0，未实现接口直接 501）
	GatewayEnabled bool
	// ReadRoots 只读模式：写接口一律拒绝，用于灰度期只验证读路径
	ReadRootsOnly bool
}

// repoRoot 返回仓库根目录（backend 的上级）。
func (c *Config) RepoRoot() string { return filepath.Dir(c.BackendDir) }

// DataDir 返回会话密钥、分仓注册表、维护状态、登录锁定文件所在目录。
func (c *Config) DataDir() string { return filepath.Join(c.BackendDir, "data") }

// JSONDir 返回业务 json 配置目录（快递规则等），与 Python 的 backend/json 一致。
func (c *Config) JSONDir() string { return filepath.Join(c.BackendDir, "json") }

// RootJSONDir 返回仓库根的 json 目录（扣点店铺规则、快递规则历史位置都在这里有副本）。
func (c *Config) RootJSONDir() string { return filepath.Join(c.RepoRoot(), "json") }

// UploadDir 返回附件目录，与 Python 的 backend/data/uploads 共用，/uploads 直接可访问同一批文件。
func (c *Config) UploadDir() string { return filepath.Join(c.DataDir(), "uploads") }

// Load 读取配置：环境变量优先，其次按当前工作目录/可执行文件位置推断 backend 目录。
func Load() *Config {
	cfg := &Config{
		Addr:             env("GO_API_ADDR", ":8100"),
		LegacyBackendURL: env("LEGACY_BACKEND_URL", "http://127.0.0.1:8000"),
		GatewayEnabled:   env("GO_GATEWAY_ENABLED", "1") != "0",
		ReadRootsOnly:    env("GO_READ_ONLY", "0") == "1",
	}
	cfg.BackendDir = env("ERP_BACKEND_DIR", guessBackendDir())
	return cfg
}

// guessBackendDir 依次尝试：cwd 下的 backend、cwd 本身、可执行文件同级的 ../backend。
func guessBackendDir() string {
	candidates := []string{}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "backend"), cwd)
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates, filepath.Join(dir, "backend"), filepath.Join(dir, "..", "backend"))
	}
	for _, p := range candidates {
		if st, err := os.Stat(filepath.Join(p, "data")); err == nil && st.IsDir() {
			abs, _ := filepath.Abs(p)
			return abs
		}
	}
	abs, _ := filepath.Abs(filepath.Join("backend"))
	return abs
}

func env(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}
