import 'package:flutter/material.dart';

/// 从 web/static/style.css 的 :root 令牌平移过来的设计变量。
/// 桌面壳的所有自定义表面（卡片、侧栏、KPI）都引用这里，保证与网页端一致。
/// 注：fluent_ui 与当前 Flutter 3.35 SDK 不兼容，改用 Material 复刻 Fluent 观感。
class WsTokens {
  WsTokens._();

  // 主色 / 状态色
  static const Color primary = Color(0xFF0067C0);
  static const Color primaryDark = Color(0xFF005A9E);
  static const Color primaryLight = Color(0xFFE6F3FF);
  static const Color green = Color(0xFF107C10);
  static const Color greenLight = Color(0xFFDFF6DD);
  static const Color red = Color(0xFFD13438);
  static const Color redLight = Color(0xFFFDE7E9);
  static const Color amber = Color(0xFFFFB900);
  static const Color amberLight = Color(0xFFFFF4CE);

  // 亮色表面
  static const Color bgLight = Color(0xFFF3F3F3);
  static const Color cardLight = Color(0xFFFFFFFF);
  static const Color textLight = Color(0xFF1A1A1A);
  static const Color textSecondaryLight = Color(0xFF5D5D5D);
  static const Color mutedLight = Color(0xFF767676);
  static const Color borderLight = Color(0xFFE5E5E5);
  static const Color borderLighter = Color(0xFFF0F0F0);

  // 暗色表面
  static const Color bgDark = Color(0xFF202020);
  static const Color cardDark = Color(0xFF2D2D2D);
  static const Color textDark = Color(0xFFFFFFFF);
  static const Color textSecondaryDark = Color(0xFFC7C7C7);
  static const Color mutedDark = Color(0xFFA0A0A0);
  static const Color borderDark = Color(0xFF3D3D3D);

  // 圆角
  static const double radiusSm = 4;
  static const double radius = 8;
  static const double radiusLg = 12;

  // 布局
  static const double sidebarWidth = 240;
  static const double contentMaxWidth = 1400;
  static const EdgeInsets contentPadding = EdgeInsets.fromLTRB(32, 28, 32, 28);

  // 欢迎卡渐变（web .welcome）
  static const LinearGradient welcomeGradient = LinearGradient(
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
    colors: [Color(0xFFE6F3FF), Color(0xFFF0F8FF), Color(0xFFE6F6FF)],
    stops: [0.0, 0.6, 1.0],
  );
}

/// 当前是否暗色：桌面壳统一用主题亮度判断，替代原先的 FluentTheme.of。
bool wsIsDark(BuildContext context) =>
    Theme.of(context).brightness == Brightness.dark;

/// 构造 Material 主题，色板对齐 web Fluent 令牌。
ThemeData wsMaterialTheme(Brightness brightness) {
  final bool dark = brightness == Brightness.dark;
  final ColorScheme scheme = ColorScheme.fromSeed(
    seedColor: WsTokens.primary,
    brightness: brightness,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: dark ? WsTokens.bgDark : WsTokens.bgLight,
    visualDensity: VisualDensity.standard,
    fontFamilyFallback: const ['Segoe UI', 'Microsoft YaHei'],
  );
}

