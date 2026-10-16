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
├── main.dart                 # 应用入口
├── screens/                  # 页面
│   ├── login_screen.dart     # 登录页
│   ├── home_screen.dart      # 工作台
│   ├── outbound_screen.dart  # 出库页
│   ├── inbound_screen.dart   # 入库页
│   ├── stock_screen.dart     # 库存页
│   └── mine_screen.dart      # 我的
├── models/                   # 数据模型
│   └── product.dart          # 商品模型
├── services/                 # 服务层
│   └── api_service.dart      # API 服务
├── providers/                # 状态管理
│   ├── auth_provider.dart    # 认证状态
│   └── product_provider.dart # 商品状态
└── widgets/                  # 可复用组件
```

## 技术栈

- **Flutter SDK**: >=3.0.0 <4.0.0
- **状态管理**: Provider
- **路由**: GoRouter
- **HTTP 请求**: Dio + CookieManager
- **本地存储**: SharedPreferences
- **UI 组件**: Material Design

## 登录方式（重要）

生产后端是 `backend/` 下的 **FastAPI**（不是 `go/` 里的试验实现）。
它的 `POST /api/auth/login` **只接受 `username` + `private_key`**（管理员分发的 Ed25519
私钥文件全文），所以登录页默认是「私钥登录」：把 `id_ed25519` / `.pem` 文件内容整段粘贴进
输入框即可（后端只认 `ssh-ed25519`，其它类型会回 400）。

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

1. 安装 Flutter SDK (3.0+)
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
- 手机真机 / 生产：填 nginx 地址，如 `http://47.108.13.20`（80 端口，nginx 把 `/api`、
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
