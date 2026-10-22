# 企业台账 Flutter 移动端应用

基于 PWA 移动页面设计的企业台账 Flutter 应用，提供完整的库存、出入库管理功能。

## 功能特性

- 🔐 用户登录/登出
- 📊 工作台概览（今日收入、本月毛利、库存总值）
- 📤 快捷出库/销售
- 📥 快捷入库
- 📦 库存总览与流水
- 👤 个人中心

## 项目结构

```
lib/
├── main.dart                 # 应用入口（按平台分发桌面壳 / 移动壳）
├── desktop/                  # 桌面端（Fluent 风格）
│   ├── desktop_app.dart      #   桌面壳入口
│   ├── desktop_shell.dart    #   导航栏 + 工具栏布局
│   ├── desktop_login.dart    #   桌面登录页
│   ├── screens/              #   工作台、出库、入库、库存、商品、报表、设置等
│   └── widgets/              #   卡片、侧边栏、工具栏等桌面组件
├── mobile/                   # 移动端（玻璃风格）
│   ├── mobile_app.dart       #   移动壳入口
│   ├── screens/              #   登录页、工作台、我的、AI 录入
│   └── widgets/              #   标签栏、页面骨架、动效等移动组件
├── screens/                  # 两端共用业务页：商品/出库/入库/库存/鲜货/开支/待付款/财务/规则
├── models/                   # 数据模型
├── services/                 # API 服务、AI 提交
└── providers/                # 状态管理（AuthProvider / ProductProvider）
```

## 技术栈

- **Flutter SDK**: 3.41+（实测 3.47.7；更低版本因 `solar_icons 0.2.0` 的 SDK 约束会解析失败）
- **状态管理**: Provider
- **路由**: GoRouter
- **HTTP 请求**: Dio + CookieManager
- **本地存储**: SharedPreferences
- **UI 组件**: Material Design

## 登录方式（重要）

生产后端是 `backend/` 下的 **FastAPI**（不是 `go/` 里的试验实现）。
它的 `POST /api/auth/login` **只接受 `username` + `private_key`**（管理员分发的 Ed25519
私钥文件全文），所以登录页默认是「私钥登录」：点「选择私钥文件」，在系统文件选择器里选中
`id_ed25519` / `.pem` / `.key` 即可（Android 走 SAF，不需要存储权限）。
后端只认 `ssh-ed25519`，选到 RSA/EC 私钥或加密私钥时 App 会当场提示。

私钥文件不在手机上时，可以点「或直接粘贴私钥内容」把文本贴进输入框。

登录页还留了一个「密码登录」切换项，那是 Go 试验后端的独有通道；
打 FastAPI 会返回 422「缺少必填参数：私钥」，正常场景用不到。

## 后端 API

参考仓库根目录的 `docs/API.md`。

主要接口：
- `POST /api/auth/login` - 登录
- `POST /api/auth/logout` - 登出
- `GET /api/auth/me` - 获取当前用户
- `GET /api/dashboard` - 工作台概览
- `GET /api/products` - 商品列表
- `POST /api/inbounds` - 入库
- `POST /api/outbounds` - 出库
- `GET /api/stock-overview` - 库存总览
- `GET /api/movements` - 库存流水

## 运行步骤

1. 安装 Flutter SDK (3.41+，实测 3.47.7)
2. 运行 `flutter pub get`
3. 自建 `dart_defines.local.json`（见下），然后运行
   `flutter run --dart-define-from-file=dart_defines.local.json`

## 配置（后端地址）

后端地址**不要写死在代码里**，统一用编译期变量 `API_BASE_URL` 注入，
避免把内网/生产地址提交进仓库：

```dart
// lib/services/api_service.dart
static const String _defaultApiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://127.0.0.1:8000', // 只是本机联调兜底
);
```

地址放在本机私有的 JSON 里（已被 .gitignore 忽略，格式见入库的 `dart_defines.template.json`）：

```json
{ "API_BASE_URL": "http://<你的服务器地址>" }
```

地址怎么填：

- 模拟器 / 桌面调试：`http://127.0.0.1:8000`（本机 uvicorn，只绑回环，仅本机可达）。
- 手机真机 / 生产：填 nginx 地址，如 `http://<服务器地址>`（80 端口，nginx 把 `/api`、
  `/uploads` 反代到后端）。**不要直连 `:8000`**——后端只监听 `127.0.0.1`，手机打不通。

```powershell
flutter run       --dart-define-from-file=dart_defines.local.json
flutter build apk --release --dart-define-from-file=dart_defines.local.json

# 等价写法（不落文件）：
flutter build apk --release --dart-define=API_BASE_URL=http://<服务器地址>
```

> 打包发给人用之前务必带上参数，否则会连到兜底的本机地址。
> Flutter < 3.7 不支持 `--dart-define-from-file`，改用 `--dart-define=API_BASE_URL=...`。

## 注意事项

- AI 识别功能（文字/图片）需要后端支持，当前为占位实现
- 需要后端服务运行且可访问
- 首次使用需要登录
