import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import 'desktop/desktop_app.dart';
import 'mobile/mobile_app.dart';
import 'providers/auth_provider.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 预编译玻璃着色器，避免首屏第一次上玻璃时掉帧
  await LiquidGlassWidgets.initialize();
  runApp(const StatisticsErpApp());
}

/// 应用根：AuthProvider 同时作为 GoRouter 的 refreshListenable，
/// 401（cookie 过期 / 被踢）时由 ApiService 清会话 → notifyListeners → redirect 自动回登录页。
class StatisticsErpApp extends StatefulWidget {
  const StatisticsErpApp({super.key});

  @override
  State<StatisticsErpApp> createState() => _StatisticsErpAppState();
}

class _StatisticsErpAppState extends State<StatisticsErpApp> {
  final AuthProvider _auth = AuthProvider();

  bool get _isDesktop {
    if (kIsWeb) return false;
    switch (defaultTargetPlatform) {
      case TargetPlatform.windows:
      case TargetPlatform.linux:
      case TargetPlatform.macOS:
        return true;
      default:
        return false;
    }
  }

  @override
  void dispose() {
    _auth.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // 桌面端（Windows/macOS/Linux）走 Fluent 壳，复刻 web 风格；
    // 移动端（Android/iOS）走玻璃壳，二者共用同一 AuthProvider。
    return _isDesktop ? DesktopApp(auth: _auth) : MobileApp(auth: _auth);
  }
}
