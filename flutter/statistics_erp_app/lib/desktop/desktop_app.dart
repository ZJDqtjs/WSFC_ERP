import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';
import '../providers/product_provider.dart';
import 'desktop_login.dart';
import 'desktop_shell.dart';
import 'desktop_style.dart';

/// 桌面端根：极光底板 + 玻璃导航条/工具条 + 命令面板。
/// 业务逻辑与移动端共用，只有这层壳是桌面专属。
class DesktopApp extends StatelessWidget {
  const DesktopApp({super.key, required this.auth});
  final AuthProvider auth;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthProvider>.value(value: auth),
        ChangeNotifierProvider(create: (_) => ProductProvider()),
      ],
      child: LiquidGlassWidgets.wrap(
        // 与移动端同理：adaptiveQuality 会按帧耗时在档位间来回切，
        // 切档瞬间玻璃层重排。桌面窗口更大，重排更明显，所以固定档位。
        adaptiveQuality: false,
        brightnessResolver: Theme.maybeBrightnessOf,
        theme: desktopGlassTheme(),
        child: MaterialApp(
          title: '企业台账',
          debugShowCheckedModeBanner: false,
          theme: wsMaterialTheme(Brightness.light),
          darkTheme: wsMaterialTheme(Brightness.dark),
          themeMode: ThemeMode.light,
          home: const _AuthGate(),
        ),
      ),
    );
  }
}

class _AuthGate extends StatelessWidget {
  const _AuthGate();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    return auth.isLoggedIn
        ? DesktopShell(auth: auth)
        : DesktopLogin(auth: auth);
  }
}
