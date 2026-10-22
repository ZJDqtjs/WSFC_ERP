package erp

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 重汇总的并发保护（对齐 report.py 的 _heavy_cached：单飞 + 全局并发闸 + 60 秒短缓存）。

func TestHeavyCachedSingleFlight(t *testing.T) {
	var calls int32
	var running int32
	var peak int32
	compute := func() (any, error) {
		if n := atomic.AddInt32(&running, 1); n > atomic.LoadInt32(&peak) {
			atomic.StoreInt32(&peak, n)
		}
		atomic.AddInt32(&calls, 1)
		time.Sleep(30 * time.Millisecond) // 给并发请求排队的时间
		atomic.AddInt32(&running, -1)
		return "结果", nil
	}

	const n = 8
	wg := sync.WaitGroup{}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err := HeavyCached("summary|wh01|2026-10-01|2026-10-31|0", compute)
			if err != nil || v != "结果" {
				t.Errorf("并发取到 v=%v err=%v", v, err)
			}
		}()
	}
	wg.Wait()
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("同 key 并发应只算一次（单飞），实际 %d 次", got)
	}
	if got := atomic.LoadInt32(&peak); got != 1 {
		t.Errorf("并发闸应让同一时刻只有一个重汇总，实际峰值 %d", got)
	}

	// 60 秒内的第二次请求直接复用缓存，不再计算
	if _, err := HeavyCached("summary|wh01|2026-10-01|2026-10-31|0", compute); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("TTL 内不该重算，实际 %d 次", got)
	}
	// key 不同（口径/区间/分仓变了）必须重算
	if _, err := HeavyCached("summary|wh01|2026-10-01|2026-10-31|1", compute); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("换 key 应重算，实际 %d 次", got)
	}
}

func TestHeavyCachedErrorNotCached(t *testing.T) {
	boom := errors.New("读库失败")
	calls := 0
	compute := func() (any, error) { calls++; return nil, boom }
	key := "finance|all|||"
	if _, err := HeavyCached(key, compute); !errors.Is(err, boom) {
		t.Fatalf("错误应原样上抛，实际 %v", err)
	}
	if _, err := HeavyCached(key, compute); err == nil {
		t.Fatal("失败结果不该被缓存后继续返回")
	}
	if calls != 2 {
		t.Errorf("失败后每次请求各自兜底重算，实际 %d 次", calls)
	}
}
