// Command mktoken 是联调用的小工具：直接在 data/.secret 上签一个合法会话令牌，
// 方便用 curl / Node 脚本打 Go 接口而不必先走私钥登录。仅用于本地测试。
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
)

import (
	"wsfc-erp-go/internal/auth"
	"wsfc-erp-go/internal/config"
	"wsfc-erp-go/internal/database"
)

func main() {
	wh := flag.String("wh", "", "分仓 key（默认取注册表 current）")
	uid := flag.Int("uid", 0, "账号 id（0 = 取第一个启用账号）")
	flag.Parse()
	cfg := config.Load()
	reg := database.NewRegistry(cfg.DataDir())
	mgr := database.NewManager(reg)
	defer mgr.Close()
	key := *wh
	if key == "" {
		key = reg.DefaultKey()
	}
	sec, err := auth.NewSecretStore(cfg.DataDir()).Secret()
	if err != nil {
		log.Fatal(err)
	}
	db, err := mgr.DB(reg.DefaultKey())
	if err != nil {
		log.Fatal(err)
	}
	var id int
	var name string
	q := "SELECT id, name FROM users ORDER BY id LIMIT 1"
	if *uid > 0 {
		q = fmt.Sprintf("SELECT id, name FROM users WHERE id = %d", *uid)
	}
	if err := db.QueryRowContext(context.Background(), q).Scan(&id, &name); err != nil {
		log.Fatalf("读取账号失败: %v", err)
	}
	token, err := auth.MakeToken(sec, id, key)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("uid=%d name=%s wh=%s\n", id, name, key)
	fmt.Printf("token=%s\n", token)
}
