package erp

import (
	"sync"
	"time"
)

// 重汇总的「并发闸 + 单飞 + 短缓存」，对齐 routers/report.py 的 _heavy_cached。
//
// 背景：/report/summary（尤其 wh=all）、/report/all-warehouses、/finance?wh=all 都会逐仓跑重查询。
// 手机端打开「全仓合计」会一次发多个；若并发执行，CPU/内存/数据库连接池会被同时打满，
// 1.6G 小内存机器直接 OOM 崩溃（2026-10-13 事故）。三层保护：
//   ① 单飞：同一 key（接口+区间+分仓+口径）并发时只算一次，其余等待复用；
//   ② 并发闸：全局同一时刻只跑一个重汇总，其余排队，绝不叠加；
//   ③ 短缓存：结果缓存 60 秒，反复刷新秒回。
const (
	heavyTTL     = 60.0
	heavyMax     = 32
	heavyWait    = 300 * time.Second
	heavyGateCap = 1
)

type heavyEntry struct {
	at  time.Time
	val any
}

var (
	heavyGate     = make(chan struct{}, heavyGateCap)
	heavyMu       sync.Mutex
	heavyCache    = map[string]heavyEntry{}
	heavyInflight = map[string]chan struct{}{}
)

// HeavyCached 按 key 取「同一次结果」：60 秒内复用缓存，并发同 key 只算一次。
// compute 报错时不写缓存（与 Python 一致），此时等待方各自兜底重算一次。
func HeavyCached(key string, compute func() (any, error)) (any, error) {
	heavyMu.Lock()
	if hit, ok := heavyCache[key]; ok && time.Since(hit.at).Seconds() < heavyTTL {
		v := hit.val
		heavyMu.Unlock()
		return v, nil
	}
	// 等待方必须挂在「领导者那一个」channel 上（Python 的 ev = _HEAVY_INFLIGHT.get(key)），
	// 各等各的新 channel 会导致谁都等不到、白等满 300 秒。
	done := make(chan struct{})
	leader := false
	if busy, taken := heavyInflight[key]; taken {
		done = busy
	} else {
		heavyInflight[key] = done
		leader = true
	}
	heavyMu.Unlock()

	if !leader {
		// 已在算同一个 key：等它算完复用，绝不再算一遍
		select {
		case <-done:
		case <-time.After(heavyWait):
		}
		heavyMu.Lock()
		if hit, ok := heavyCache[key]; ok {
			v := hit.val
			heavyMu.Unlock()
			return v, nil
		}
		heavyMu.Unlock()
		// 领导者异常退出且无缓存：退回自己算一次兜底（放弃单飞，避免死等）
		heavyGate <- struct{}{}
		defer func() { <-heavyGate }()
		return compute()
	}

	defer func() {
		heavyMu.Lock()
		delete(heavyInflight, key)
		heavyMu.Unlock()
		close(done)
	}()
	heavyGate <- struct{}{}
	result, err := compute()
	<-heavyGate
	if err != nil {
		return nil, err
	}
	heavyMu.Lock()
	heavyCache[key] = heavyEntry{at: time.Now(), val: result}
	for len(heavyCache) > heavyMax {
		oldest := ""
		var oldestAt time.Time
		for k, v := range heavyCache {
			if oldest == "" || v.at.Before(oldestAt) {
				oldest, oldestAt = k, v.at
			}
		}
		delete(heavyCache, oldest)
	}
	heavyMu.Unlock()
	return result, nil
}
