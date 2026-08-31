# 企业台账系统

库存 + 财务一体化的台账系统（FastAPI + SQLite），含桌面 Web 端与移动端 PWA。

## 目录结构

```
statistics_erp/          # 项目根（本地开发 = Linux 部署单元）
├── app/                 # 后端 FastAPI 应用（API，前后端分离后不托管前端）
│   └── routers/         #   auth / products / inbound / outbound / inventory / report /
│                        #   imports / backup / ai / fresh
├── static/              # 桌面 Web 前端（index.html / app.js / style.css，纯静态）
├── web/serve.py         # 本地前端预览服务器（托管 static/ + 反代 /api、/uploads 到后端）
├── data/                # 数据库 erp.db、上传图片 data/uploads、自动备份 data/backups
├── json/                # 包材 / 人工 / 鲜货展示清单 等 JSON 配置
├── product_rules.json   # 账号 / 单位 / LLM / 关联规则等配置
├── run.py               # 后端 API 启动脚本（默认 8000 端口）
├── dev.py               # 本地一键开发：后端 + 前端预览
├── deploy/              # Linux 部署：nginx.conf / erp.service / deploy.sh / deploy.ps1
├── mobile/              # 移动端 PWA（Vue3 + Vant4 + Vite）
├── requirements.txt     # Linux 部署依赖
└── pyproject.toml / uv.lock / .venv
```

## 端口说明

- **网页（前端）默认端口 80**（原 8000 改为 80）：本地用 `web/serve.py`，Linux 用 nginx 监听 80。
- **后端 API 端口 8000**（仅本机/内网）：本地 `uv run python run.py`，Linux 由 systemd 托管于 127.0.0.1:8000，nginx 反代对外。
- 根目录 `config.json` 集中管理绑定地址、端口以及 `/api`、`/uploads`、`/mobile` 前缀。修改前缀后重新部署，Nginx、后端和前端会同步使用新值。

## 本地开发（前后端分离）

**方式一：一键启动（推荐）**

```bash
uv run python dev.py      # 后端 :8000  +  前端 :80
```

- 前端：http://localhost/（Windows 非管理员绑定 80 会失败，自动改用 8001 并提示）
- 后端 API：http://127.0.0.1:8000

**方式二：分开启动**

```bash
uv run python run.py        # 终端 1：后端 API -> 127.0.0.1:8000
uv run python web/serve.py  # 终端 2：前端 -> localhost:80（WEB_PORT 可覆盖）
```

自定义端口：`API_PORT=9000`、`WEB_PORT=8001`、`API_TARGET=http://127.0.0.1:9000` 均为环境变量。

**单进程一体化预览**（不需要时忽略）：`SERVE_STATIC=1 uv run python run.py`，后端顺带托管 static/。

**移动端 PWA**（进入 mobile 目录，需 Node.js ≥ 18）：

```bash
cd mobile
npm install                 # 首次；国内建议 npm install --registry=https://registry.npmmirror.com
npm run dev                 # 开发：http://localhost:5173（已代理 /api 到 8000）
npm run build               # 生产构建 → mobile/dist
```

**Flutter Android 端**（`flutter/statistics_erp_app`，不参与 Web/PWA 部署）：

当前 Flutter 端已接入登录、工作台、库存总览/流水、入库、出库和我的页面，对应 Python 后端的认证、仪表盘、商品、库存、入库和出库接口。Android 真机不能使用 `localhost` 访问服务器，生产构建时请通过 `API_BASE_URL` 指定 Nginx 公网地址：

```powershell
cd flutter\statistics_erp_app
flutter pub get
flutter analyze
flutter test
flutter build apk --release --dart-define=API_BASE_URL=http://20.24.210.119
```

默认 API 地址也是 `http://20.24.210.119`；如部署了 HTTPS 或更换域名，使用新的地址覆盖 `API_BASE_URL`。Android 当前已允许 HTTP 明文连接，切换 HTTPS 后可移除该兼容设置。

## Linux 部署（nginx 反代 80）

前置：Linux 服务器（Ubuntu），已装 OpenSSH，本地能 `ssh -i <key> azureuser@<ip>`。

**一键部署（Windows PowerShell，在项目根目录执行）：**

```powershell
powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
# 自定义密钥/主机/用户：
deploy\deploy.ps1 -Key E:\other.pem -Srv 1.2.3.4 -User ubuntu
```

默认使用 `E:/ZJDqtjs_key..pem` 连接 `azureuser@20.24.210.119`。脚本会：合并本地数据库 → 在本地构建 `mobile/dist` → 上传代码和产物 → 在服务器安装 Python 依赖、Nginx（监听 80、托管桌面端和 `/mobile`、反代 API/上传）、systemd 服务并启动。服务器不需要 Node.js。

**部署后的架构：**

```
浏览器 --:80--> nginx (Ubuntu)
                ├── /        → /home/azureuser/WSFC_ERP/static（前端静态）
                ├── /mobile/ → /var/www/erp/mobile（PWA 构建产物）
                └── /api、/uploads → 127.0.0.1:8000（FastAPI systemd 服务）
```

**服务器手动部署**（上传代码到 /home/azureuser/WSFC_ERP 后）：

```bash
bash /home/azureuser/WSFC_ERP/deploy/deploy.sh
```

说明：`bash -n deploy/deploy.sh` 只检查脚本语法，不会启动服务。部署完成后由 systemd 管理后端服务，服务名为 `erp`；Nginx 管理网页入口。

**服务器服务管理**：

```bash
cd /home/azureuser/WSFC_ERP

# 仅检查部署脚本语法，不执行部署
bash -n deploy/deploy.sh

# 查看服务状态
sudo systemctl status erp
sudo systemctl status nginx

# 启动服务
sudo systemctl start erp
sudo systemctl start nginx

# 停止服务
sudo systemctl stop erp
sudo systemctl stop nginx

# 重启服务（修改后端代码或配置后使用）
sudo systemctl restart erp
sudo systemctl reload nginx

# 查看后端实时日志
sudo journalctl -u erp -f

# 查看最近的后端日志
sudo journalctl -u erp -n 100 --no-pager
```

通常不需要单独手动启动后端。服务器重启后，`erp` 已设置为自动启动；重新发布代码时，重新执行 `deploy.sh` 即可。

**账号系统**

- 默认账号：**admin1 / admin1**
- 不开放注册。账号在项目根目录 **`product_rules.json` 的 `accounts`** 中维护（用于数据库初始化，重启自动同步）。新增业务员示例：
  ```json
  { "username": "xiaowan", "password": "123456", "name": "小万", "role": "user" }
  ```
- 登录后可分配多个业务员各自记录（操作员自动填充为登录人）。

## 核心设计

### 两级商品模型（库存商品 ↔ 订单商品，解耦）

把**库存**与**订单**分开管理，实现三方信息解耦、灵活库存变更：

- **库存商品（大类）**：真实物理库存，如 `佛手柑大果 100个`、`纸箱5号`。可入库/盘点。
- **订单商品（小类）**：出库销售的具体 SKU，如 `佛手柑大果3个`，本身**不存库存**。
- **关联 + 倍数**：订单商品关联到一个库存商品，`倍数` = 每产生 1 单消耗的库存默认单位数。
  例如 `佛手柑大果3个` 关联 `佛手柑大果`、倍数 3 → 卖出 1 单，按标准单位 **1×3 = 3 个** 从 `佛手柑大果` 库存中扣除。
- **订单商品继续挂成本**：关联结算清单（纸箱/包材）+ 人工打包费等照常配置，出库时一并结算。
- 出库成本按**库存商品**的加权平均成本 × 扣减数量结转。

### 单位换算（完美映射方案）

每个商品定义一个**基础单位**，其他单位通过「换算系数」折算到基础单位，库存统一按基础单位记账：

- 重量类（基础单位=克）：1斤=500克、1公斤=1000克，固定换算；
- 计数类（基础单位=个）：1袋=几个、1包=几个，按商品自行设定；
- 跨维度（斤买、个卖）：给商品设「每个=XX克」即可。

入库按采购单位记，出库按销售单位记，系统自动折算。

### 出库关联结算（BOM/包装清单）

商品可配置「关联结算清单」+「固定费用」。卖1单该商品时，自动扣减关联商品的库存并计入成本，例如卖佛手柑中果1个，同时扣 1个佛手柑中果（大类库存）+ 1个纸箱5号 + 佛手柑中果1个打包费0.7元。

### 财务核算（自动）

- 入库按**加权平均成本**自动更新商品成本；
- 出库自动结转成本（库存商品成本 + 关联材料成本），自动算毛利/净利；
- 报表：销售收入、结转成本、毛利、费用、净利、库存总值、商品销售明细、财务流水。

## 批量操作

商品 / 入库 / 出库 页面均支持**多选批量操作**（勾选或全选后出现批量栏）：

- **商品**：批量删除（已被单据/关联引用的自动跳过）、批量修改属性（分类/启用停用/参考成本/默认售价/打包费，如把选中商品统一改成某分类）
- **入库记录 / 出库记录**：批量删除（自动回退库存、成本与财务）

## 批量导入

「批量导入」页提供：

- 下载自研模板（商品 / 入库 / 出库 .xlsx）
- 商品批量导入：**兼容「柠檬云商品导入模板.xlsx」**，自动识别 商品编码/类别/名称/规格/单位 等，已存在商品自动跳过
- 入库 / 出库批量导入：按「商品编码或名称」识别，同单号自动合并为一单

## 商品管理

- **商品类型**：库存商品（大类）/ 订单商品（小类），可按类型筛选、表格带类型徽标
- **库存关联**：订单商品可设置「关联库存商品 + 倍数」，出库按倍数扣减大类库存；可在商品编辑弹窗随时修改
- **分类筛选**：按 商品/干货/蔬菜/包材/人工/快递… 分类筛选
- **计量单位管理**：内置 克/斤/公斤/个/包/袋… 标准单位，可新增自定义单位
- **参考成本**：包材/人工等可填"参考成本"（如 纸箱5号 0.9元/个），未入库时关联结算按此成本计
- **独立打包费**：人工分类下每个商品对应一个「{商品名}打包」商品，成本即该商品工人单价
- **自动关联结算清单**：从七月统计表自动为商品挂上「纸箱 + 独立打包费」

## 商品重建（配置驱动）

`rebuild_products.py` 按 **`product_rules.json`**（代码层面配置，非数据库）重建商品档案：

- 规则：数据来源文件、排除词、单位规则、纸箱命名/单价、人工命名模板、分类名
- **两级映射**：柠檬云商品/包材/人工/快递 → 库存商品；七月 SKU → 订单商品，自动提炼大类并关联倍数
- **accounts**：账号初始化；**code_mappings**：商品编码关联（聚水潭商品名 → 系统商品）初始化；**product_overrides**：单商品手动覆盖
- 调整后执行 `uv run python rebuild_products.py`（幂等，已存在商品自动跳过）

## 聚水潭出库单自动结算

「编码关联」页两步完成：

1. **上传聚水潭销售出库单.xlsx → 解析**：自动识别「商品名称」（如 `2.京鲜生茯苓500g*1,山药片500g*1`）为外部编码，展示每件规格，并**自动推荐匹配**到系统商品（含匹配度），逐个核对后「保存全部关联」；
2. **导入出库单**：按关联自动生成出库单，**消耗量 = 件数 × 每件规格**，自动扣减库存商品与包装材料库存、计提打包费、核算成本利润。

只导入状态为「已出库」的单；未关联或未配置每件重量换算的商品会明确提示。

## 目录

```
app/          后端（模型、认证、核心逻辑、路由）
static/       前端页面（index.html / app.js / style.css）
data/         SQLite 数据库
product_rules.json   初始化配置（账号、编码关联、商品规则、单商品覆盖）
rebuild_products.py  商品档案重建脚本
```
