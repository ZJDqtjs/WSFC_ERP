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

## 后端 API

参考 `D:/code/statistics_erp/backend/docs/` 目录下的 API 文档。

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
2. 配置后端 API 地址（修改 `lib/services/api_service.dart` 中的 `baseUrl`）
3. 运行 `flutter pub get`
4. 运行 `flutter run`

## 配置

修改 `lib/services/api_service.dart` 中的 `baseUrl` 为实际后端地址：

```dart
static final Dio _dio = Dio(BaseOptions(
  baseUrl: 'http://your-server:8000', // 修改这里
  ...
));
```

## 注意事项

- AI 识别功能（文字/图片）需要后端支持，当前为占位实现
- 需要后端服务运行且可访问
- 首次使用需要登录
