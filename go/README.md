# WSFC ERP Go 服务（wsfc-erp-go）

Python 后端（`backend/`）的逐接口移植：Go 原生实现覆盖 `backend/app/routers/` 解析出的**全部 139 个业务端点**，
与 Python 共用同一份数据目录（`backend/data`、`backend/json`）和同一对配置文件（`product_rules.json` + `config.local.json`）。
两套后端是**平替关系**，不是叠加层——同一个分仓一次只启用一个（SQLite 单写）。

## 运行

```powershell
cd go
# ERP_BACKEND_DIR 必须显式给：自动推导只试 cwd/backend、cwd、exe 同级 ../backend，
# 在 go/ 里直接跑会落到 go/backend 这个空目录上（等于新库），启动日志会打印实际数据目录。
ERP_BACKEND_DIR=D:/code/WSFC_ERP/backend go run .   # 监听 :8100，未原生实现的路径回源到 Python
ERP_BACKEND_DIR=D:/code/WSFC_ERP/backend GO_GATEWAY_ENABLED=0 go run .  # 关闭回源：未覆盖接口直接 501（证明移植完整度）

go build -o ../_gosb/go/wsfc-erp-go.exe .   # Windows 会锁住正在运行的 exe，先停旧进程再构建
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GO_API_ADDR` | `:8100` | 监听地址 |
| `LEGACY_BACKEND_URL` | `http://127.0.0.1:8000` | 回源目标（Python 后端） |
| `GO_GATEWAY_ENABLED` | `1` | 置 `0` 关闭回源代理，未实现接口返回 501 |
| `GO_READ_ONLY` | `0` | 置 `1` 为只读灰度：写接口一律拒绝 |
| `ERP_BACKEND_DIR` | 自动推导 | Python 的 `backend` 目录；数据与 json 配置相对它定位（依次尝试 `cwd/backend`、`cwd`、可执行文件同级 `../backend`） |
| `ERP_LLM_API_KEY` / `ERP_LLM_BASE_URL` / `ERP_LLM_MODEL` | — | 覆盖 LLM 配置，与 Python 侧同规则 |

配置解析口径与 Python 一致：`product_rules.json` 的 `llm` 段是默认值，`config.local.json` 深合并覆盖，环境变量最后压；
`llm.enabled=false` 视为整段未配置。LLM 配置每次调用现读文件，没有 TTL 缓存。

## 目录

```
go/
├── main.go              # 入口：装配路由 + 可选回源代理
├── internal/api/        # 路由表与各模块 handler（按业务域分文件，见 *_api.go）
├── internal/erp/        # 业务实现（报表汇总、Excel 导入、聚水潭、AI 流式、备份、分仓…）
├── internal/{auth,database,config,web}/  # 鉴权、SQLite/分仓、配置、HTTP 工具
├── internal/{gateway,proxy}/             # 回源代理（迁移期兜底）
├── cmd/mktoken          # 生成本机调试用 erp_token（差分/冒烟测试用）
├── cmd/xlsxprobe        # xlsx 解析排查工具
└── _diff/               # Python↔Go 差分回归套件（用法见仓库根 README）
```

## 与前端/客户端的关系

- Go **不托管前端页面**（只挂 `/uploads`），桌面 Web 仍需 `web/serve.py` 或 nginx；把 `API_TARGET` 指向 `http://127.0.0.1:8100` 即可让前端走 Go。
- Flutter / PWA 端只要接口地址指对，两套后端可无感切换。

## 已知与 Python 的差异

- xlsx 类响应（导入模板）由 Go 自己的写库生成，zip 压缩元数据与 openpyxl 不同，**字节数不等但内容一致**（sheet 名、单元格、冻结窗格、列宽逐层比对通过）。`backend/docs/` 下有同名静态模板时两边都直发同一份文件，此时字节一致。
- `GET /api/warehouses/all-warehouses` 会把 `"current"` 一起缓存——这是**故意镜像** Python 的行为，不是移植缺陷。
- 其余口径以差分套件为准：`write.mjs` 124 例 + 21 项快照、`diff.mjs` 48 条 GET、`upload.mjs` 32 例。
