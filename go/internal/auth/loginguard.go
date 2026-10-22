package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 登录失败分级锁定：规则与 Python app/login_guard.py 完全一致，且共用同一份
// data/login_locks.json（Go 与 Python 两个进程同时跑也互相看得见，重启不清零，
// 删文件即可应急解锁）。

// ScopeERP 主系统登录的计数作用域。
const ScopeERP = "erp"

// ScopeKeyadmin 私钥管理后台的计数作用域（共用同一份状态文件）。
const ScopeKeyadmin = "keyadmin"

const failsPerStep = 3

var ladderSeconds = []int{60, 180, 300, 3600, 86400}

const staleSeconds = 7 * 86400.0

type lockRecord struct {
	Fails int     "json:\"fails\""
	Until float64 "json:\"until\""
	Level int     "json:\"level\""
	TS    float64 "json:\"ts\""
}

// LockGuard 登录失败锁定状态（文件 + 进程内互斥）。
type LockGuard struct {
	file string
	mu   sync.Mutex
}

// NewLockGuard 使用 dataDir 下的 login_locks.json。
func NewLockGuard(dataDir string) *LockGuard {
	return &LockGuard{file: filepath.Join(dataDir, "login_locks.json")}
}

func lockKey(scope, username string) string {
	return scope + ":" + strings.ToLower(strings.TrimSpace(username))
}

func (g *LockGuard) load() map[string]lockRecord {
	raw, err := os.ReadFile(g.file)
	if err != nil {
		return map[string]lockRecord{}
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(raw, &data); err != nil {
		return map[string]lockRecord{}
	}
	out := make(map[string]lockRecord, len(data))
	for k, v := range data {
		var rec lockRecord
		if err := json.Unmarshal(v, &rec); err == nil {
			out[k] = rec
		}
	}
	return out
}

// save 原子写盘，并顺手丢弃「fails 已清零」或「7 天无新失败」的条目。
// 写失败就算了：锁定是尽力而为的防护，不能因为磁盘问题让登录整体失败。
func (g *LockGuard) save(records map[string]lockRecord) {
	now := float64(time.Now().UnixNano()) / 1e9
	keep := map[string]lockRecord{}
	for k, rec := range records {
		if rec.Fails > 0 && now-rec.TS < staleSeconds {
			keep[k] = rec
		}
	}
	raw, err := json.MarshalIndent(keep, "", "  ")
	if err != nil {
		return
	}
	raw = append(raw, byte(10))
	tmp := g.file + ".tmp"
	if err := os.MkdirAll(filepath.Dir(g.file), 0o755); err != nil {
		return
	}
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, g.file)
}

// LockedLeft 剩余锁定秒数；0 表示当前未锁定（失败次数保留，下次再错继续进档）。
func (g *LockGuard) LockedLeft(scope, username string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	rec, ok := g.load()[lockKey(scope, username)]
	if !ok {
		return 0
	}
	left := int(rec.Until - float64(time.Now().Unix()))
	if left > 0 {
		return left
	}
	return 0
}

// RecordFail 记一次失败，返回本次新触发的锁定秒数（0 = 还没到档位）。
func (g *LockGuard) RecordFail(scope, username string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	key := lockKey(scope, username)
	records := g.load()
	rec := records[key]
	rec.Fails++
	rec.TS = float64(time.Now().Unix())
	wait := 0
	if rec.Fails%failsPerStep == 0 {
		level := rec.Fails / failsPerStep
		if level > len(ladderSeconds) {
			level = len(ladderSeconds)
		}
		wait = ladderSeconds[level-1]
		rec.Level = level
		rec.Until = float64(time.Now().Unix()) + float64(wait)
	}
	records[key] = rec
	g.save(records)
	return wait
}

// Reset 登录成功：清零，回到起始状态。
func (g *LockGuard) Reset(scope, username string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	key := lockKey(scope, username)
	records := g.load()
	if _, ok := records[key]; !ok {
		return
	}
	delete(records, key)
	g.save(records)
}

// Humanize 把秒数写成中文时长，用于错误提示（与 Python humanize 一致）。
func Humanize(seconds int) string {
	if seconds < 1 {
		seconds = 1
	}
	switch {
	case seconds >= 86400:
		days, rest := seconds/86400, seconds%86400
		if rest == 0 {
			return fmt.Sprintf("%d 天", days)
		}
		return fmt.Sprintf("%d 天 %d 小时", days, rest/3600)
	case seconds >= 3600:
		h, rest := seconds/3600, seconds%3600
		if rest == 0 {
			return fmt.Sprintf("%d 小时", h)
		}
		return fmt.Sprintf("%d 小时 %d 分钟", h, rest/60)
	case seconds >= 60:
		m, rest := seconds/60, seconds%60
		if rest == 0 {
			return fmt.Sprintf("%d 分钟", m)
		}
		return fmt.Sprintf("%d 分 %d 秒", m, rest)
	}
	return fmt.Sprintf("%d 秒", seconds)
}

