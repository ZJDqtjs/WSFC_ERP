# 企业台账系统（WSFC_ERP）

库存 + 财务一体化的台账系统（FastAPI + SQLite），含桌面 Web 端、移动端 PWA、Capacitor Android 套壳，
以及 Flutter 原生客户端（Windows 桌面 / Android / iOS）。Windows 与 Android 客户端通过 GitHub Releases 分发。

## 目录结构

```
WSFC_ERP/                # 项目根（本地开发 = Linux 部署单元）
├── backend/             # 后端（FastAPI API + 私钥管理后台 + 维护脚本）
│   ├── app/             #   FastAPI 应用包：auth / config / database / keys / login_guard
│   │                    #   models / services / product_master / jst / initdb + routers/（22 个路由模块）
│   ├── keyadmin/        #   私钥管理后台（独立进程，默认 8001 端口）
│   ├── data/            #   SQLite erp.db、上传 data/uploads、自动备份 data/backups（不入库）
│   ├── json/            #   商品资料 5 类 JSON + 鲜货/人工/包材/装箱规则/关联扣减/SKU 成本默认值
│   ├── tests/           #   Pytest（聚水潭出库单解析等）
│   ├── run.py           #   后端 API 启动脚本（默认 8000 端口）
│   ├── keyadmin.py      #   私钥后台启动脚本（默认 8001 端口）
│   └── *.py             #   维护脚本：rebuild_products / sync_product_data / sync_categories / seed_pack_rules 等
├── web/                 # 桌面 Web 端（纯静态前端 + 本地预览服务器）
│   ├── serve.py         #   本地预览：托管 web/static，并反代 /api、/uploads 到后端
│   └── static/          #   index.html / app.js / style.css / brand-icon.png / sku-costs-test.html
├── mobile/              # 移动端 PWA（Vue3 + Vant4 + Vite，构建产物 mobile/dist 已入库）
├── capacitor/           # Android 套壳（远程加载已部署的 /mobile/ PWA）
│   ├── capacitor.config.template.json #   入库模板（server.url 为占位地址）
│   └── capacitor.config.local.json    #   本机私有真实地址（已 gitignore，需自建）
├── flutter/wsfc_erp_app/ # Flutter 客户端（桌面 Fluent 壳 + 移动玻璃壳，共用一套 API 层）
├── deploy/              # 部署：deploy.sh / service.sh / nginx.conf / erp.service（+ Windows 侧 deploy.bat、win_stop.ps1）
├── scripts/             # 独立脚本：备份推送 backup_push.py / backup_receiver.py、月度商品发货统计、箱子及薪水支出统计
├── docs/                # API.md（后端接口文档）、Go 试验版设计/对比文档
├── config.json          # 根路由/端口集中配置（路由前后端共用，勿随意改）
├── product_rules.json   # 非敏感默认配置：单位 / 箱规 / 类别 / LLM 参数 / 关联规则
├── config.local.json    # 本机私有配置（LLM api_key、初始账号口令、对外接口令牌）：已 gitignore，每台机器各存一份
└── dev.py               # 本地一键开发：后端 + 桌面 Web 前端
```

## 端口与路由

- **网页（前端）默认端口 80**：本地用 `web/serve.py`，Linux 用 nginx 监听 80。
- **后端 API 端口 8000**（仅本机/内网）：`cd backend && uv run python run.py`，Linux 由 systemd 托管于 127.0.0.1:8000。
- **私钥管理后台端口 8001**：`cd backend && uv run python keyadmin.py`。
- 根目录 `config.json` 集中管理绑定地址、端口以及 `/api`、`/uploads`、`/mobile` 前缀。

## 配置文件（product_rules.json + config.local.json）

配置分两层，后者按**深合并**覆盖前者（只写要覆盖的字段即可，dict 递归合并、列表整体替换）：

| 文件 | 是否入库 | 内容 |
| --- | --- | --- |
| `product_rules.json` | 是 | 单位换算、箱规、类别、LLM 的 `base_url` / `model`、编码关联等**非敏感**默认配置 |
| `config.local.json` | 否（已 gitignore） | **本机私有**：`llm.api_key`、`accounts`（初始账号与口令）、`open_api.token` 等敏感项 |

```json
{
  "llm": { "api_key": "在这里填你的密钥" },
  "accounts": [
    { "username": "admin1", "password": "改成强口令", "name": "管理员", "role": "admin" }
  ],
  "open_api": { "token": "给外部工具用的只读令牌" }
}
```

- 加载逻辑见 `backend/app/config.py`；也支持环境变量覆盖：`ERP_LLM_API_KEY` / `ERP_LLM_BASE_URL` / `ERP_LLM_MODEL`。
- `accounts` 的口令在每次启动时与数据库比对并**强制同步**，因此改完 `config.local.json` 重启即完成管理员改密。
- **新机器/新服务器克隆后必须自建 `config.local.json`**，否则 AI 录入不可用、也不会创建任何初始账号。

### 对外只读接口（open_api）

`GET /api/open/sku-costs` 给外部投放工具按 SKU 取单件成本，鉴权用请求头 `X-Api-Token`（兼容 `Authorization: Bearer`）。

- 令牌读 `config.local.json` 的 `open_api.token`；**未配置时接口返回 503**（不会无鉴权裸奔）。
- 令牌缺失或错误返回 401，连续错误会按 IP 逐步锁定（429）。
- 联调测试页：部署后访问 `/sku-costs-test.html`。

### 客户端后端地址（不入库）

客户端不允许把服务器地址写死在代码里，统一在构建期注入：

| 端 | 私有文件（已 gitignore） | 入库模板 |
| --- | --- | --- |
| Flutter | `flutter/wsfc_erp_app/dart_defines.local.json`（`{"API_BASE_URL": "http://<服务器地址>"}`） | `dart_defines.template.json` |
| Capacitor | `capacitor/capacitor.config.local.json`（`{"server":{"url":"http://<服务器地址>/mobile/"}}`） | `capacitor.config.template.json` |

Capacitor CLI 只读 `capacitor/capacitor.config.json`，该文件由脚本从模板 + 本机私有配置合成（同样已 gitignore）：

```bash
cd capacitor && npm install
npm run sync          # 先合成配置再 cap sync；copy / open:android 同理
```

## 客户端发布（GitHub Releases）

Flutter 客户端的正式包走 [GitHub Releases](https://github.com/ZJDqtjs/WSFC_ERP/releases) 分发，版本标签与 `pubspec.yaml` 的 `version` 对应（当前 `1.0.0+1` → `v1.0.0`）。

| 资产 | 说明 |
| --- | --- |
| `wsfc_erp-<版本>-windows-x64.zip` | 免安装便携包，解压后运行 `wsfc_erp.exe`；需系统装有 VC++ 2015-2022 运行库 |
| `wsfc_erp-<版本>-arm64.apk` | Android `arm64-v8a`，versionName / versionCode 同 `pubspec.yaml` |

应用身份：Dart 包名 `wsfc_erp`，Android `applicationId` / iOS Bundle ID 均为 `com.wsfc.erp`，显示名 `WSFC_ERP`。

> Android 包名已由历史的 `com.example.statistics_erp_app` 变更为 `com.wsfc.erp`，两者不能覆盖升级，安装前请先卸载旧版；
> 当前 release 使用 debug 签名（`android/app/build.gradle` 里 `signingConfig = signingConfigs.debug`），如需正式签名请自行配置 keystore。
> iOS 产物需在 macOS 上打包，暂不随 Release 提供。

## 客户端构建（Flutter）

要求 **Flutter 3.41+**（实测 3.47.7；更低版本会因为 `solar_icons 0.2.0` 的 SDK 约束导致 `pub get` 失败），Dart 3。

```powershell
cd flutter\wsfc_erp_app
flutter pub get
flutter analyze

# 打包（务必带 dart-define，否则会落到兜底的 127.0.0.1）
flutter build windows --release --dart-define-from-file=dart_defines.local.json
flutter build apk --release --target-platform android-arm64 --dart-define-from-file=dart_defines.local.json
```

产物位置：`build/windows/x64/runner/Release/wsfc_erp.exe`、`build/app/outputs/flutter-apk/app-release.apk`。
统一图标可用 `dart run tool/gen_icons.dart` 重新生成三端图标。

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
后端 Python 版本见 `backend/.python-version`（3.12），依赖见 `backend/requirements.txt` / `pyproject.toml`。

**移动端 PWA**（在 mobile 目录，需 Node.js ≥ 18）：

```bash
cd mobile
npm install                 # 首次；国内建议 npm install --registry=https://registry.npmmirror.com
npm run dev                 # 开发：http://localhost:5173（已代理 /api 到 8000）
npm run build               # 生产构建 → mobile/dist（构建前会自动生成图标）
```

**Flutter 客户端**：见上一节「客户端构建」。

## Linux 部署（nginx 反代 80）

前置：代码与移动端构建产物已同步到服务器部署目录（下称 `$APP_DIR`），服务器装有 Python3/nginx。
`deploy/deploy.sh` 内部使用 `sudo`，请以 **root 或具备免密 sudo 的账号**执行：

```bash
bash "$APP_DIR/deploy/deploy.sh"
```

脚本会依次：停旧服务 → 装 nginx/python 依赖 → 在 `backend/` 下建 venv 并安装 `requirements.txt`
→ 修正目录属主 → 把 `web/static`、`mobile/dist` 同步到 `/var/www/erp`（并给 `app.js`/`style.css` 追加部署时间戳）
→ 写入 nginx 站点 → 安装并重启 systemd 服务 `erp`。

> `mobile/dist` 已随仓库入库；若改动了 `mobile/` 源码，请本地 `npm --prefix mobile run build` 后再提交。

部署后架构：

```
浏览器 --:80--> nginx (Ubuntu)
                ├── /        → /var/www/erp（来自 WSFC_ERP/web/static）
                ├── /mobile/ → /var/www/erp/mobile（PWA 构建产物）
                └── /api、/uploads → 127.0.0.1:8000（FastAPI systemd 服务 erp，WorkingDirectory=backend）
```

服务管理请见 `deploy/service.sh`（start|stop|restart|status）。

## 账号系统

登录方式是 **Ed25519 私钥文件**，不是密码：前端选私钥文件 → 后端由私钥推导公钥、比对库中保存的
`users.fingerprint`（SHA256）。因此**用户名必须与私钥一一对应**，用户名写错、或用别人的私钥，都会返回
`401 用户名或私钥不匹配`。

- 账号与私钥的对应关系可用分仓库 `backend/data/*.db` 的 `users` 表查看：
  `username / name / role / fingerprint / is_active`。
- ⚠️ **`admin1` 是历史遗留账号，`fingerprint` 为 NULL，无法用私钥登录**（旧密码登录已废弃）。
  日常使用请走私钥管理工具分发的账号；账号名单由管理员在后台维护，不在文档里列出。
- `accounts`（建议写在 `config.local.json`，见「配置文件」）每次启动都会同步口令与姓名/角色，但**不会给已有账号补发私钥**。
- 私钥管理后台：`cd backend && uv run python keyadmin.py`（端口 8001）——用它生成/重发私钥，
  生成的私钥文件只在当时一次性下载，请妥善保管。进后台需输入「管理员账号 + 密码」：账号口令取自
  `config.local.json` 的 `accounts`（`role` 必须为 `admin`），同时兼容库里已有口令的管理员账号。
  启动时建议显式绑本机：`KEYADMIN_HOST=127.0.0.1`。
- **登录失败分级锁定**（主系统 Web 端 / 移动端 PWA / 私钥管理工具共用同一套，规则见 `backend/app/login_guard.py`）：
  每个账号累计失败 **3 次等 1 分钟 → 再 3 次等 3 分钟 → 再 3 次等 5 分钟 → 再 3 次等 1 小时 → 再 3 次等 24 小时**，
  之后每再失败 3 次继续等 24 小时；**登录成功立即清零**，回到起始状态。锁定期内即使凭证正确也一律拒绝（返回 429）。
  状态落在 `backend/data/login_locks.json`（已 gitignore），重启服务不会清零；管理员可在私钥管理工具的
  「登录管理」面板里查看锁定状态并手动解锁（含主系统被锁的账号）。
- 换分仓 / 新建分仓后旧 token 立即失效，需要重新登录（登录页会提示"登录状态已失效"）。

## 核心设计摘要

- **两级商品模型**：库存商品（大类）与订单商品（小类）解耦，关联 + 倍数控制库存扣减与成本结转。
- **单位换算**：基础单位 + 换算系数，入库按采购单位、出库按销售单位自动折算。
- **出库关联结算（BOM）**：商品可配置关联结算清单（纸箱/包材）+ 人工打包费，出库自动结算；支持多套扣减方案，出库按「最近采购入库」自动选一套。
- **财务核算（自动）**：先进先出(FIFO)成本、出库结转成本、毛利/净利、报表与财务流水。

- **批量操作 / 批量导入 / 商品重建 / 聚水潭出库单自动结算** 等能力沿用沉淀逻辑，见 `docs/API.md`。
