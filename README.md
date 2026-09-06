# 企业台账系统（WSFC_ERP）

库存 + 财务一体化的台账系统（FastAPI + SQLite），含桌面 Web 端、移动端 PWA、Capacitor Android 套壳与 Flutter 移动端。

## 目录结构

```
WSFC_ERP/                # 项目根（本地开发 = Linux 部署单元）
├── backend/             # 后端端（FastAPI API + 私钥后台 + 维护脚本）
│   ├── app/             #   FastAPI 应用包（auth/database/keys/main/models/services/product_master + routers/）
│   ├── keyadmin/        #   私钥管理后台（独立端口 8001）
│   ├── data/            #   SQLite erp.db、上传 data/uploads、自动备份 data/backups
│   ├── json/            #   商品资料备份 5 类 JSON + 鲜货/labor/packaging 等配置
│   ├── docs/            #   批量导入模板（入库/出库）
│   ├── tests/           #   Pytest 测试
│   ├── run.py           #   后端 API 启动脚本（默认 8000 端口）
│   ├── keyadmin.py      #   私钥后台启动脚本（默认 8001 端口）
│   └── *.py             #   维护脚本：rebuild_products / sync_product_data / sync_categories 等
├── web/                 # 桌面 Web 端（前后端分离，纯静态前端）
│   ├── serve.py         #   本地前端预览服务器（托管 web/static + 反代 /api、/uploads 到后端）
│   └── static/          #   index.html / app.js / style.css
├── mobile/              # 移动端 PWA（Vue3 + Vant4 + Vite，构建产物 mobile/dist）
├── capacitor/           # 移动端 Capacitor Android 套壳（远程加载已部署的 /mobile/ PWA）
├── flutter/             # 移动端 Flutter 应用（statistics_erp_app）
├── deploy/              # Linux 部署：nginx.conf / erp.service / deploy.sh / service.sh
├── data-src/            # 商品源数据（七月份干货/蔬菜统计表等）
├── scripts/             # 独立分析脚本（月度商品发货统计 / 箱子及薪水支出统计）
├── docs/                # API.md 等文档
├── config.json          # 根路由/端口集中配置（路由前后端共用，勿随意改）
├── product_rules.json   # 账号 / 单位 / LLM / 关联规则等配置
├── dev.py               # 本地一键开发：后端 + 桌面 Web 前端
└── requirements.txt / pyproject.toml / uv.lock（位于 backend/ 内）
```

## 端口与路由

- **网页（前端）默认端口 80**：本地用 `web/serve.py`，Linux 用 nginx 监听 80。
- **后端 API 端口 8000**（仅本机/内网）：`cd backend && uv run python run.py`，Linux 由 systemd 托管于 127.0.0.1:8000。
- **私钥管理后台端口 8001**：`cd backend && uv run python keyadmin.py`。
- 根目录 `config.json` 集中管理绑定地址、端口以及 `/api`、`/uploads`、`/mobile` 前缀。

## 本地开发（前后端分离）

**方式一：一键启动（推荐）**，在项目根目录执行：

```bash
uv run python dev.py      # 后端 :8000  +  桌面前端 :80（Windows 非管理员改 8001 并提示）
```

**方式二：分开启动**

```bash
cd backend && uv run python run.py        # 终端 1：后端 API -> 127.0.0.1:8000
cd web     && uv run python serve.py      # 终端 2：桌面前端 -> localhost:80
```

自定义端口：`API_PORT=9000`、`WEB_PORT=8001`、`API_TARGET=http://127.0.0.1:9000` 均为环境变量。

**移动端 PWA**（在 mobile 目录，需 Node.js ≥ 18）：

```bash
cd mobile
npm install                 # 首次；国内建议 npm install --registry=https://registry.npmmirror.com
npm run dev                 # 开发：http://localhost:5173（已代理 /api 到 8000）
npm run build               # 生产构建 → mobile/dist
```

**Flutter Android 端**（`flutter/statistics_erp_app`，不参与 Web/PWA 部署）：默认 API 为 `http://***REMOVED-IP***`，可用 `API_BASE_URL` 覆盖：

```powershell
cd flutter\statistics_erp_app
flutter pub get
flutter analyze
flutter build apk --release --dart-define=API_BASE_URL=http://***REMOVED-IP***
```

## Linux 部署（nginx 反代 80）

前置：代码与移动端构建产物已同步到服务器 `/home/azureuser/WSFC_ERP`，服务器装有 Python3/nginx。

```bash
bash /home/azureuser/WSFC_ERP/deploy/deploy.sh
```

> 部署前请在本地执行 `npm --prefix mobile run build` 并上传 `mobile/dist`；脚本会在服务器端 `backend/` 下创建虚拟环境并安装依赖。

部署后架构：

```
浏览器 --:80--> nginx (Ubuntu)
                ├── /        → /var/www/erp（来自 WSFC_ERP/web/static）
                ├── /mobile/ → /var/www/erp/mobile（PWA 构建产物）
                └── /api、/uploads → 127.0.0.1:8000（FastAPI systemd 服务 erp，WorkingDirectory=backend）
```

服务管理请见 `deploy/service.sh`（start|stop|restart|status）。

## 账号系统

- 默认账号：*****REMOVED-DEFAULT-PASSWORD*****
- 账号在根目录 **`product_rules.json` 的 `accounts`** 中维护（数据库初始化时同步）。
- 私钥管理后台：`cd backend && uv run python keyadmin.py`（端口 8001，复用用户表与密钥算法）。

## 核心设计摘要

- **两级商品模型**：库存商品（大类）与订单商品（小类）解耦，关联 + 倍数控制库存扣减与成本结转。
- **单位换算**：基础单位 + 换算系数，入库按采购单位、出库按销售单位自动折算。
- **出库关联结算（BOM）**：商品可配置关联结算清单（纸箱/包材）+ 人工打包费，出库自动结算。
- **财务核算（自动）**：加权平均成本、出库结转成本、毛利/净利、报表与财务流水。
- **批量操作 / 批量导入 / 商品重建 / 聚水潭出库单自动结算** 等能力沿用沉淀逻辑，见 `docs/API.md`。