import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';
import '../providers/product_provider.dart';
import 'desktop_login.dart';
import 'desktop_shell.dart';
import 'fluent_theme.dart';

/// 桌面端根：MaterialApp（复刻 Fluent 观感）+ 登录/主壳门控。业务逻辑与移动端共用。
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
      child: MaterialApp(
        title: '企业台账',
        debugShowCheckedModeBanner: false,
        theme: wsMaterialTheme(Brightness.light),
        darkTheme: wsMaterialTheme(Brightness.dark),
        themeMode: ThemeMode.light,
        home: const _AuthGate(),
      ),
    );
  }
}

class _AuthGate extends StatelessWidget {
  const _AuthGate();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    return auth.isLoggedIn ? DesktopShell(auth: auth) : DesktopLogin(auth: auth);
  }
}
