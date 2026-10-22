# Go 新后端（`wsfc-erp-go`）

> 这份文档记的是**根 README 里还没有的 Go 侧信息**：两套后端的关系、怎么起 Go、端点覆盖与核对方法、
> Python↔Go 差分回归套件与判读约定。根 README 保持现状（仍以 Python 为主视角），等 Go 真的转正再并回去。

## 1. 两套后端是什么关系

- Python（FastAPI，`backend/`，默认 :8000）是**基准**；Go（`go/`，默认 :8100）是**逐接口移植**。
- 两者是**平替**，不是叠加层：`go/internal/gateway` + `internal/proxy` 那层回源只是迁移期兜底，
  置 `GO_GATEWAY_ENABLED=0` 后未覆盖接口直接 501，用来暴露漏项。
- **同一个分仓一次只启用一套**（SQLite 单写），换着起，别同时写同一个仓。
- 共用同一批资源，所以切换后端不需要迁数据、不需要换配置：

  | 共用项 | 位置 |
  | --- | --- |
  | 业务库 | 默认仓 `backend/data/erp.db`，分仓 `backend/data/warehouses/whNN.db`，仓清单 `backend/data/warehouses.json` |
  | 附件 | `backend/data/uploads`（Go 也只挂 `/uploads`，**不托管前端页面**） |
  | 登录密钥 | `backend/data/.secret`（32 字节，首次运行生成） |
  | 登录锁定 | `backend/data/login_locks.json` |
  | 商品/规则 json | `backend/json/`（扣减、鲜货、装箱、编码映射…）；快递规则在仓库根 `json/express_config.json`（目录按需创建，本机可能还没有） |
  | 导入模板 | `backend/docs/*.xlsx`（`/api/templates/*` 优先直发同名文件，没有才按代码动态生成） |
  | 配置 | `product_rules.json` 默认值 ← `config.local.json` 深合并 ← 环境变量（`ERP_LLM_API_KEY` / `ERP_LLM_BASE_URL` / `ERP_LLM_MODEL`）；`llm.enabled=false` 视为整段未配置；每次调用现读文件，无 TTL 缓存 |

- 登录令牌**两边互认**：`go/internal/auth/auth.go` 的签发/校验与 Python `make_token` 逐字节一致（同一份 `.secret` 下），
  所以切后端不必重新登录；失效只发生在换分仓 / 新建分仓时。

## 2. 跑起来

```bash
cd go && ERP_BACKEND_DIR=<仓库绝对路径>/backend GO_GATEWAY_ENABLED=0 go run .   # Go API -> :8100
cd web && API_TARGET=http://127.0.0.1:8100 uv run python serve.py                # 前端指向 Go
```

`ERP_BACKEND_DIR` **必须显式给**。`guessBackendDir()` 只依次试 `cwd/backend`、`cwd`、可执行文件同级 `../backend`
（判据是该目录下有 `data/`），在 `go/` 里直接 `go run .` 全都匹配不上，会兜底成 `go/backend` 这个不存在的目录：
实测它照样把服务起起来、日志打印「数据目录 D:/…/go/backend」、自动出库调度器照常跑，并顺手建出 `go/backend/data/backups/`，
**等于开了一个空库**（还会顺带读不到 `product_rules.json`，AI 接口表现为「未配置」）。启动日志会打印实际数据目录，起完先看一眼。
沙箱 `_gosb/go` 能省略这个变量，只是因为那个目录里自带一份 `backend/`。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `GO_API_ADDR` | `:8100` | 监听地址 |
| `LEGACY_BACKEND_URL` | `http://127.0.0.1:8000` | 回源目标（Python） |
| `GO_GATEWAY_ENABLED` | `1` | 置 `0` 关回源，未实现接口 501 |
| `GO_READ_ONLY` | `0` | 置 `1` 只读灰度，写接口一律拒绝 |
| `ERP_BACKEND_DIR` | 自动推导（不可靠，见上） | Python 的 `backend` 目录，数据与 json 相对它定位 |

其余目录结构、模块划分见 `go/README.md`。

## 3. 端点覆盖度怎么核对

```bash
# Python 侧：数路由装饰器
grep -rho "@router\.\(get\|post\|put\|delete\|patch\)" backend/app/routers/*.py | wc -l   # -> 139
# Go 侧：路由表在 go/internal/api/routes.go，逐条 rt.<verb>("<路径>")
grep -rhoE 'rt\.(Get|Post|Put|Delete|Patch)\("' go/internal/api/*.go | wc -l              # -> 141
```

141 = 139 业务端点 + `/health` + `/api/_meta/routes`（后两个是 Go 侧辅助接口）。
别用宽松的 `Get("` 之类的正则，会误匹配到非路由调用（实测能数出 153）。

## 4. Python ↔ Go 差分回归（`go/_diff/`）

对齐与否以差分结果为准，不靠读代码的印象。验证用三端口沙箱（`_gosb/` 是本机脚手架，不入库）：

| 端口 | 角色 |
| --- | --- |
| :8050 | Python 基准 oracle（`_gosb/py`，`RELOAD=0`，改代码要重启，启动约 37s） |
| :8100 | Go 移植（`_gosb/go`，`GO_GATEWAY_ENABLED=0`，无回源兜底） |
| :8088 | web 桥 `_gosb/webgo.mjs`：注入 `erp_token` cookie，把 `/api`、`/uploads` 代理到 :8100 |

| 套件 | 覆盖 | 备注 |
| --- | --- | --- |
| `diff.mjs` | 全部 GET 端点（端点表直接解析 `backend/app/routers/*.py`，当前 48 条） | `--module=<mod>` / `--path=` 可单跑一条 |
| `write.mjs` | 124 条写用例 + 21 个最终状态快照 | `--module` / `--snap` / `--only` / `--verbose` |
| `upload.mjs` | 32 条 Excel 上传 | fixture 由 `gen_import_fixtures.py` 生成 |
| `ai.mjs` | 57 条 AI 接口断言 | 断言的是「未配置密钥」分支，**真 key 在位时不要跑**（有成本且不确定） |

跑法：token 用 `go/cmd/mktoken` 现签，harness 通过环境变量取配置——`PY_BASE` / `GO_BASE` / `ERP_TOKEN`
（注意不是 `ERPTOK`，写错了整批用例会以 `BOTH_401` 收场）/ `REPO` / `DIFF_OUT`。

判读约定（踩过的坑，别把噪声写成移植差异）：

- 全部测试只在 `_gosb/*` 的沙箱库里跑，**绝不写真实 `backend/data`**；沙箱的 `config.local.json` 会置空
  `llm.api_key` 并关闭自动备份与远端推送——起因是一次沙箱启动把备份 db 推到了真实远端。起沙箱前先确认这个中和生效。
- 各库独立生成的随机字段要在 `write.mjs` 的 `IGNORE_SNAP` 里屏蔽（`id`、批量导入批次号 `import_group`、
  回显绝对路径的 `file`），否则每次报警都是伪差异。
- `PY=0`、`status 0 vs 200`、`ECONNRESET`、`fetch failed` 多是 Python oracle 在大响应（`/api/outbounds` 单次可达数十 MB）下的抖动，
  单跑那一条重判再定性；取快照的超时要给足（`snapGet` 用 180s，30s 通用超时会把「还没跑完」误报成 status 0）。
- openpyxl 动态生成的 xlsx 不保证逐字节稳定（docProps 里带时间戳，同一内容 5342/5343 浮动），二进制接口比到**内容级**即可；
  逐字节一致只有走 `backend/docs/` 静态文件直发那条分支能做到。

## 5. 与 dev README 的差异（下次并回去时照这个清单改）

- 端口与路由缺 Go :8100，也没有「同一分仓一次只启用一套后端」的提醒。
- 本地开发缺 `SERVE_STATIC=1`（Python 单进程一体化预览）和「换成 Go 后端」那两条命令。
- 目录结构缺 `go/` 与 `backend/docs/`；`backend/data` 那行写的是 `erp.db`，实际是默认仓 + `warehouses/whNN.db` 多库结构。
- 账号系统里「分仓库 `backend/data/*.db`」的说法含糊，应写成默认仓 `data/erp.db` / 分仓 `data/warehouses/whNN.db`，
  并补上「Go 与 Python 共用 `.secret`，令牌互认」。
- 配置文件一节没说 Go 读同一对 `product_rules.json` + `config.local.json`、同样认 `ERP_LLM_*`。
- 核心设计摘要缺：商品编码一对一（409 + `code_takeover`）、跨类别改基础单位（`unit_change_ratio`）、
  请求级分仓（`main.py` 的 `WarehouseScopeMiddleware`）、AI 流式识别 + `search_products`/`get_product` 两个只读工具 +
  AI 记忆（入口在「待办处理」页）、`backend/app/brush.py` 的刷单口径（不出货、不耗包材、商品成本按 0）、
  报表重汇总的单飞 + 并发闸 + 60s 短缓存（`report.py` 的 `_heavy_cached`）。
- 部署仍只有 Python 路径。换 Go 上服务器要同步改三处：`deploy/erp.service` 的 `ExecStart`/`WorkingDirectory`（并给 `ERP_BACKEND_DIR`）、
  nginx 反代的 upstream 端口、以 `GO_GATEWAY_ENABLED=0` 起服务。这条路径目前只在本地沙箱验过，没上过服务器。

## 6. 开机数据层：`weight_kg` 差异的根因，以及 Go 补上的那三层

Python 每次启动对**每个分仓**跑一遍 `initdb.init_warehouse()`：建表 → 补列 → `seed_units` → `ensure_seed_users`
→ `_backfill_products` → `ensure_warehouse_deduction`，之后再两个 marker 文件控制的一次性迁移（FIFO 全量重算、入仓品每袋净重）。
Go 原先只移植了「建表 + 补列 + `seedUnits` + 新仓拷 users」，**没有数据回填层**。逐项核实与处置：

| 开机动作 | Python | Go（现在） | 影响 |
| --- | --- | --- | --- |
| `seed_units`（units 表空时播标准单位） | ✅ | ✅ | 无 |
| `ensure_seed_users`（读 `config.local.json` 的 `accounts`，建号 + 每次启动强制同步口令/姓名/角色） | ✅ | ✅ `erp.bootSeedUsers` | 补上后：全新空库起 Go 有账号，改 `config.local.json` 口令重启即生效 |
| `_backfill_products`（① `default_unit` 空的按换算表补；② 类别「人工」的重算工作量；③ **基础单位是克/g 且 `weight_kg==0` 的，按 `conversions[default_unit]/1000` 补净重**） | ✅ 每次开机 | ✅ ①③ `erp.bootBackfillProducts`；②不做（见下） | 克类新商品的净重不再长期为 0 |
| `ensure_warehouse_deduction`（入仓品扣点 6% 行） | ✅ | ✅ `erp.bootWarehouseDeduction` | 全新仓不再缺这行 |
| `_fifo_recompute_once` / `_migrate_warehouse_bag_weight` | marker 文件控制，只跑一次 | ❌ 有意不移植 | 生产上两个 marker 都在（`data/.cost_method_fifo_v5_*`、`data/.wh_bag_weight_kg_*`），已跑完，重复跑反而危险 |

### 落地方式（2026-10-22 实现）

代码在 `go/internal/erp/boot.go`，入口 `BootWarehouse(db)`，按 Python 的相对顺序跑
`bootSeedUsers → bootBackfillProducts → bootWarehouseDeduction`。挂载点有两处：

1. `database.Manager` 新增可选钩子 `AfterOpen`（`database.go`），在 `ensureSchema`+`seedUnits` 之后、把池放进 `pools` 之前跑一次；
   由 `api.New` 注入 `mgr.AfterOpen = erp.BootWarehouse`（`api.go`）。失败只 `[warn]` 打日志、不阻断建池。
2. 新建分仓走 `Manager.DBNoBoot(key)`（`warehouse_api.go:initWarehouse`）：这条路径**必须**先 `copy_users` 再跑种子账号，
   顺序照 Python；若照常跑钩子，种子账号会让 `users` 非空，`copyUsers` 的 `count>0` 判断会把整表复制跳过（新仓只剩一个账号）。

两点与最初建议不同，说明理由：

- **每次开机跑，不加 marker**（原话提过「用 marker 控制更干净」）：Python 就是每次跑，跑一次即收敛；
  加 marker 会让 Go 与 Python 在同一份 data 上交替启动时行为不一致（谁先跑谁定），照抄最省心。
- **跳过「人工」类工作量重算那条腿**：Go 的建档/入库/出库/调整各写路径本来就调 `erp.RecomputeProduct`
  （`adjust.go:189/414`、`imports_outbound.go:265`、`inbound.go:206/276/312/386`、`outbound.go:510/719`、`product.go:641`），
  观测到的 workload 两边一致；开机再全量扫一遍只是把成本重算的写放大搬到启动。

懒加载带来的时序差别（不影响终态）：Python 在启动那一刻把 6 个仓全跑一遍；Go 是**某个仓第一次被请求打开连接池时**跑。
所以「起了 Go 但没人访问某仓」时那仓的日志里没有 `[warn]`/回填记录，属正常。

### weight_kg 这条的定性（2026-10-22 查清）

**不是建档/改档的移植偏差，是 Go 少了开机回填。** 证据（`wh01.db`，两库同源于一次拷贝）：

- Python 侧 48 条 `base_unit in (克,g)` 的商品里 47 条 `weight_kg != 0`，唯一为 0 的是 id 382（它的 `conversions["公斤"]=0`，正好是回填规则该跳过的那条）——**与 `_backfill_products` 的规则逐条吻合**。
- Go 侧同样 48 条，id ≤ 349 的 43 条有值（拷贝来的），差分套件新建的 381/383/384/385 是 0。
- 算术也对得上：381 `default_unit=克, conversions[克]=1` → 0.001；383/384 `default_unit=公斤, conversions[公斤]=1000` → 1.0；385 同 381。
- 建档/改档两侧一致：Python `products.py:372/489` 与 Go `product.go:479/634` 都是照抄请求里的 `weight_kg`（没传就 0）。
  所以**同一次运行内 Python 也是 0**，只有下次重启才被补上——这正差分套件当时绿、事后库里显形原因：
  写侧快照比的是重启前的状态，而 `_gosb/py` 为了验证模板修复重启过、`_gosb/go` 没有。

真实影响面：`weight_kg` 只喂两处——快递费 `services.compute_express_fee`（`services.py:218`，走 `line_weight_kg`）和报表重量列（`report.py:684` 直接取 `pr.weight_kg`）。
批量导入 / 商品资料同步 / 聚水潭建档这些路径**都不写 `weight_kg`**，全靠这次开机回填兜底；补上之前，Go 下新建的克类商品净重会**一直是 0**，
表现为快递费按 0 重量走首重、报表重量少算。现在这层已经在 Go 里跑起来了（见上面的落地方式）。

现有数据不受影响：生产两库（`data/erp.db` 203 商品、`data/warehouses/wh01.db` 343 商品）里克类商品 `weight_kg` 已全部非 0，
「下次开机将被回填」的数量是 **0**，所以现在切 Go 不会丢任何东西。差异只在**以后新建的克类商品**。

当初三个选项里选了 ①（照抄开机回填），已实现。验证结果（全部只在 `_gosb/*` 沙箱库上跑，没碰 `backend/data`）：

- **净重回填**：Go 侧 `wh01.db` 开机后 381/383/384/385 = `0.001 / 1.0 / 1.0 / 0.001`，与 Python 库逐字节一致；
  id 382（`conversions["公斤"]=0`）按规则跳过，两侧「待回填」计数都变成 1。
- **新建分仓**：`POST /api/warehouses` 各建一个仓（Go→wh06、PY→wh06），两库对齐比较
  users 10 行 / deductions 1 行 / units 11 行、`users`·`deductions`·`units` 三张表内容完全一致；
  确认 `copy_users` 先于种子账号（新仓拿到源仓全部 10 个账号，不是只有一个种子账号）。
- **口令双向互通**：Python 散列留在 Go 库里时，Go 的 `VerifyPassword` 认它（不重散列，两侧 hash 逐字节相同）；
  反向把沙箱 aosidi 的 `admin1` hash 清空，Go 开机重散列出 `salt$hex`（97 字符、随机 salt），
  Python 的 `verify_password` 验它 = True、错口令 = False。测完已还原成基线值。
- **差分回归**：`diff.mjs` 48 个 GET 全绿；`write.mjs` 124 条写用例全绿、21 个状态快照全绿
  （首轮 `/api/movements` 报 `PY=0`、`/api/warehouses` 名字乱码，前者是 Python 基准侧抖动重跑即过，
  后者是我手工建仓时 curl 用了控制台码页发出去的脏字节，与移植无关，已把沙箱注册表名字改齐）。

## 7. 已定与未定

已定（2026-10-22）—— **分支口径：一条 `feature-go`，先 PR 非 Go 的部分，之后继续装 Go**：

- 本分支从 dev tip `71eea8a` 直接分出，**没有 merge 提交**。前三个提交是与 Go 无关的修复，
  **PR 就开到这里**（给 dev，dev 再并 main）：
  `c94262f` 模板中文文件名改走 RFC 5987 响应头（修 `/api/templates/products` 的 500）、
  `7f8242a` 三份 `backend/docs/*.xlsx` 入库、`8eb9f7a` `.gitignore` 收口
  （沙箱目录 `/_gosb/` 等 5 条 + `!backend/docs/*.xlsx`，**`/go/` 这条通配原样保留**）。这三个的净 diff 是 5 个文件、零 Go 内容。
- PR 合掉之后，才是 `feature-go` 自己的东西：`36542f9`（112 个 `go/` 文件 + 把 `/go/` 换成本机产物细规则）+ 本文档。
  **Go 不并回 dev**：dev 侧 `.gitignore` 里 `/go/` 仍是整目录忽略，所以 Go 永远不会被 dev 的 `git add -A` 顺手带上去。
  139 个接口对齐、开机数据层补齐、差分全绿这些结论都成立，只是它们属于这个分支。
- **PR 已开：[#2](https://github.com/ZJDqtjs/WSFC_ERP/pull/2)（`feature-go` → `dev`，GitHub 判为可自动合并）**，
  2026-10-22 提交，内容正是上面那三个提交：远端 `origin/feature-go` 就停在 `8eb9f7a`（用 `git push origin 8eb9f7a:feature-go` 只推这一段），
  本地 `feature-go` 头是 `b910a09`，比远端多 `36542f9` + 本文档两个提交。**这两个提交在 PR 合掉之前不要 push。**
- **一个 GitHub 的使用注意**：PR 跟着源分支的头走。如果你在 PR 还没合的时候就把 `36542f9` push 上去了，
  Go 那 112 个文件会一起涌进同一个 PR。所以顺序要是：**先 push 到 `8eb9f7a` 开 PR（已做完，就是 #2）、合掉，再 push 后面的 Go 提交**。
  合完 `dev` 后本地补一次 `git push origin feature-go`，远端 `feature-go` 才会跟上 Go 内容。
- **连带影响**：差分套件在 `go/_diff/`，跟着 `/go/` 一起不进 dev，所以**从 dev clone 出来的机器没有这套脚本**；
  要跑回归就切 `feature-go`，或把 `go/_diff/` + `_gosb/seed.sh` 手动带过去。同理，dev 上也没有本文档。
- **`feature-go` 会落后于 dev。** backend 语义以后在 dev 上再变（新接口、口径修正），这个分支就跟着过期，
  真要再对齐得重做一次移植级核对，不是简单 merge。方向也别再反过来：上一轮那条 `d22e109`（dev → feature-go）是走错了，
  已经废弃，旧链暂时留在本地分支 `go-port`（确认新分支没问题后可删）。
- **开机数据层已补齐**（第 6 节）。

还没定：

1. ~~Go 要不要加 SPA 静态挂载~~ **已定：不加。** 生产上前端由 nginx 托管（`deploy/nginx.conf`：`root /var/www/erp` +
   `try_files $uri $uri/ /index.html`，`/mobile/` 走 PWA alias），后端只被反代 `/api` 和 `/uploads`，
   所以「只起 Go 打不开页面」不是移植缺口，是拓扑本来如此；Python 侧那个 `SERVE_STATIC` 开关默认也是 `0`，
   Go 只是没抄这个开发期便利用的开关。真要本机连页面一起起，跑 `web/` 的 dev server 或 `vite preview` 就行。
2. 是否反向修掉 Python 侧那些与 Go 无关的老问题（模板中文文件名的 `Content-Disposition` 已经修了，就在本分支 `c94262f`，随 PR 进 dev）。
3. ~~`/docs/go_*.md` 要不要放开~~：**本篇留在 `feature-go`，不进 dev**（它整篇讲的都是 Go 侧，跟着 `/go/` 一起不进 dev 才对）；
   `docs/go_*.md` 那几篇早期过程文档也按原样忽略。dev 上想要一个指路条的话，另写一句 README 提示「Go 移植见 feature-go 分支」即可，别把全文塞进 dev。

## 8. 沙箱收尾状态（下次要再跑差分，先读这段）

2026-10-22 收尾时把沙箱**消毒**了，24 个文件：

- 13 份 `backup_config.json` → `enabled=false`、`remote_enabled=false`、`remote_url=""`、`remote_token=""`。
  动机：`_gosb/{ai,imports,jst_auto,openfresh,product_data,report,warehouse_in}` 和 `_gosandbox`、`_port/backup/_scratch/data-snapshot`
  里那些副本原本还是 `enabled=true + remote_enabled=true + remote_url=<备份服务器>/cloudback`（真实地址不写进公开仓库），
  一起沙箱、定时器一跑就把库推到**真实云备份**（历史上真发生过一次）。
- 11 份 `config.local.json` → `llm.api_key=""`。这正是 `go/_diff/ai.mjs` 需要的状态（它断言的是无 key 走大模型时的
  400「未配置 LLM」，见 `ai.mjs:2`），所以置空之后 AI 差分反而能跑；反过来**要手工验证真识别链路时必须先把 key 填回
  `_gosb/{go,py}/config.local.json`**，验完再清空（原件在仓库根 `config.local.json`，从没动过）。
  `accounts` 里的本地测试口令保留，种子账号那条链路还要用。

三个端口进程（Go :8100、Python 基准 :8050、web 桥 :8088）已停；`:8000` 上那个无关 Node 进程（`node dev/preview/server.mjs 8000`）没碰。
收尾时另外挖出 10-19 为单模块差分起的 9 对 oracle（:8301-:8375）和 4 个 Go 实例也在跑，一并停干净了——原因和危险见第 10 节。
下次重起环境的顺序见第 4 节，唯一多出来的注意点是：**起之前先确认 `backup_config.json` 仍是关的**，
消毒过的值如果哪次从真实 `backend/data` 重新拷库，会把开着的配置又带回来。

上面那些被点名的目录（`_gosandbox`、`_port*`、`_gosb/<模块>`）已经在第 9 节的物理清理里删掉了，
这份清单现在只是历史动因记录，别按它去找文件。**重建沙箱只有一条路：`bash _gosb/seed.sh`**，
它从真实 `backend/` 拷 `py`/`go` 两份同源副本，并在同一步里把自动备份、远端推送、聚水潭定时导出、LLM key 全部置掉。

## 9. 保留下来的移植口径：Excel 单元格 → Python 字符串

imports 是整个移植里最容易「看着对、其实口径不同」的一块，因为 Python 读表拿到的是**原生对象**，
再统一 `str(v).strip()`；Go 必须先还原出同一个字符串，后面所有比较才有意义。
`_port2/IMPORTS_BRIEF.md` 那张表是这个口径的唯一记录，随沙箱删除前抄录于此，落点都在 `go/internal/erp/`：

| 单元格 | openpyxl (`data_only=True`) 给的值 | `str(v).strip()` 期望结果 | Go 侧 |
| --- | --- | --- | --- |
| 空 | `None` | 走 `default`（一般 `""`） | `ImpCell(row, idx, def)` |
| 整数型数字（原始串无 `.`/`E`） | `int` | `"3"` | `impOpen` 走 `RawCellValue` + `GetCellType` 判原始串 |
| 小数/科学计数 | `float` | CPython repr：`"3.0"`、`"50.25"`、`"1e-05"` | `PyFloat()`（`crud.go:19`） |
| 布尔 | `bool` | `"True"` / `"False"` | `ImpCellText` |
| 日期/时间格式的数值 | `datetime`/`date`/`time` | `"2026-10-12 00:00:00"` / `"2026-10-12"` / `"12:34:56"` | `isDateStyle` + `fmtIsDate` + `impSerialToTime` |
| 公式 | 缓存值，没缓存则 `None` | 同上 | 只认缓存，不重算 |

三条踩过的坑，改这块之前先看：

1. **日期判定不能只看类型**，要看样式 `numFmt`（`isDateStyle`），且序列号转换按 1900 纪元时要处理
   Excel 那个不存在的 `1900-02-29`：60 号之前起点往后挪一天（`imports_xlsx.go:486` 附近）。
2. **`ImpNormDate` / `ImpToFloat` 是逐行照搬 Python 的**（`(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})` 取前缀补零；
   去 `￥¥元`、全角逗号分号转半角、去空格/NBSP，失败再 `[^\d\-+\.]+` 兜底，`"" - + . -. ` 认默认值）。
   这两处「顺手改进」会直接改变导入结果，别动。
3. 名称相似度走的是 CPython `difflib.SequenceMatcher.ratio` 的移植（`ImportsDifflibRatio`），
   不是编辑距离；`erp.Round2` 用 `big.Rat` 复刻 CPython 半分位取偶，金标准在 `internal/erp/round_test.go`。

## 10. 物理清理（2026-10-22 收尾）

原则：**能再生的删，取证用的留，生产数据一律不碰。** 删之前用 `du -sh backend/data` + 文件数记下生产侧指纹，删之后再比一次确认没走火。

删掉的（都可再生）：

- 各沙箱的 `data/backups/` 共 **8.0G / 367 个** `*backup*.db`——历次沙箱启动的滚动自动快照，零取证价值；
- `_gosb/{ai,product_data,openfresh,warehouse_in,report,imports,jst_auto,backup}` 共 **7.9G**——单模块对齐用的一次性沙箱，结论早已落进本文档和提交；
- `_gosandbox`（120M，被 `_gosb/{py,go}` 结构取代）、`_port`/`_port2`（220M，里面的 `go/README.md` 十份同一个样板，已被 `go/README.md` 取代）、`_gosb_bin/wsfc-erp-go.check.exe`（24M，可重建）。

实际回收 **8.6G**（D 盘可用 56G → 64.6G）。清理前我按「备份 8.0G + 模块沙箱 7.9G」估成 15.9G 是把同一批数据数了两遍——
那 7.9G 里绝大部分就是各模块自己的 `data/backups`，两档本来就重叠。

**收尾时挖出来的一件事，比磁盘更要紧：** `rm` 报 `Device or resource busy`，追下去发现 10-19 为单模块差分起的
**9 对 Python oracle（:8301-:8375）和 4 个 Go 实例（:8302/8322/8342/8362）一直没停，跑了整整三天。**
它们的危险在于：配置是**开机那一刻读进内存的**，而消毒发生在 10-22——磁盘上的 `backup_config.json` 已经被我置成
`enabled=false/remote_enabled=false`，进程里的值却还是 `true` 加真实 `remote_url`，4 小时一轮的定时器有充分的时间窗
把沙箱库推到公司备份服务器。**结论：消毒脚本改的是文件，管不住已经在跑的进程；下次收尾要先停进程再消毒，
或者干脆停完进程再确认端口为空（`netstat -ano | grep ':83'`）。** 这 22 个进程已全部终止，`:8000` 上那个
无关的 `node dev/preview/server.mjs` 没碰。建议在备份服务器上按 10-19 ~ 10-22 这个时间窗核一下有没有来源不明的沙箱库。


留下的（下次回归要直接用）：

- `_gosb/py`、`_gosb/go`（差分基准 + Go 侧，各约 117M `data`，含这次验完的 wh06 对照库和消毒过的配置）；
- `_gosb/fixtures`（`upload.mjs` 的 32 个上传用例读它）、`_gosb/seed.sh`、`go/_diff/`；
- `_gosb_bin/mktoken.exe`（11.5M，签 `erp_token` 用，比重新构建省事）。

`.gitignore` 的沙箱块要等 PR 合进 dev 才生效，所以清理同时把同样的规则写进 **dev 工作树的 `.git/info/exclude`**
（纯本地，不产生提交），让合并前那次 `git add -A` 也不会把 `_gosb` 带上去。
