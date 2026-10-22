package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"
)

import (
	"wsfc-erp-go/internal/api"
	"wsfc-erp-go/internal/config"
	"wsfc-erp-go/internal/proxy"
)

// wsfc-erp-go 主入口：Go 原生实现已覆盖 Python 后端解析出的全部 139 个业务端点。
// GO_GATEWAY_ENABLED=1 时，万一有漏掉的路径仍回源到 Python 兜底；置 0 则未实现接口直接 501，
// 用来验证移植完整度。两套后端是平替关系，同一个分仓一次只启用一个（SQLite 单写）。
func main() {
	cfg := config.Load()
	srv, err := api.New(cfg)
	if err != nil {
		log.Fatalf("初始化失败: %v", err)
	}
	defer srv.Close()

	if cfg.GatewayEnabled {
		target, perr := url.Parse(cfg.LegacyBackendURL)
			if perr != nil || target.Scheme == "" || target.Host == "" {
			log.Printf("[warn] LEGACY_BACKEND_URL 不可用（%q），未实现接口将直接 404", cfg.LegacyBackendURL)
		} else {
			srv.Fallback = proxy.New(target)
			log.Printf("未实现接口回源到 %s", target.String())
		}
	}

	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      300 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(ctx); err != nil {
			log.Printf("优雅退出失败: %v", err)
		}
	}()

	log.Printf("Go ERP 服务监听 %s，数据目录 %s", cfg.Addr, cfg.BackendDir)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	log.Printf("服务已停止")
}
