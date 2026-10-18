import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

/// 移动端品牌色板。与桌面端 / web 端同源（#1989FA 家族 + 生鲜绿），
/// 但移动端全部观感只从这里取值，避免各页面各写一套。
abstract final class Mc {
  static const Color brand = Color(0xFF1989FA);
  static const Color brandTop = Color(0xFF3DA0FF);
  static const Color brandDeep = Color(0xFF0958CD);
  static const Color fresh = Color(0xFF07C160);
  static const Color danger = Color(0xFFF56C6C);
  static const Color warn = Color(0xFFE6A23C);

  static const Color ink = Color(0xFF16181D);
  static const Color inkSecond = Color(0xFF52575E);
  static const Color inkThird = Color(0xFF8A9099);

  static const Color pageBase = Color(0xFFEDF2FA);

  static const double radiusCard = 22;
  static const double radiusTile = 16;

  static const LinearGradient pageGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFFF3F7FD), Color(0xFFE7EEF9), Color(0xFFEFF3FB)],
  );
}

/// 动效时长与曲线。整站统一，改一处就能整体调快慢。
abstract final class Motion {
  static const Duration fast = Duration(milliseconds: 180);
  static const Duration base = Duration(milliseconds: 320);
  static const Duration slow = Duration(milliseconds: 520);
  static const Duration stagger = Duration(milliseconds: 70);
  static const Curve curve = Curves.easeOutCubic;
  static const Curve springish = Curves.easeOutBack;
}

/// 移动端 Material 主题（玻璃层由 [GlassThemeData] 单独管）。
ThemeData mobileLightTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: Mc.brand,
    brightness: Brightness.light,
  ).copyWith(
    primary: Mc.brand,
    error: Mc.danger,
    surface: Colors.white,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: Mc.pageBase,
    // 弹窗 / 选择器等二级 Material 面仍要走浅色系，避免和玻璃壳脱节
    appBarTheme: const AppBarTheme(
      backgroundColor: Mc.pageBase,
      surfaceTintColor: Colors.transparent,
      foregroundColor: Mc.ink,
      elevation: 0,
      centerTitle: true,
      titleTextStyle: TextStyle(
        fontSize: 17,
        fontWeight: FontWeight.w600,
        color: Mc.ink,
      ),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Mc.radiusTile),
      ),
    ),
    dividerTheme: const DividerThemeData(space: 1, thickness: 0.6),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white.withValues(alpha: 0.86),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Mc.radiusTile),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Mc.radiusTile),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Mc.radiusTile),
        borderSide: const BorderSide(color: Mc.brand, width: 1.6),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(14)),
      ),
    ),
    textTheme: const TextTheme(
      titleLarge: TextStyle(fontWeight: FontWeight.w700, fontSize: 22),
      titleMedium: TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
      bodyMedium: TextStyle(fontSize: 14),
    ),
  );
}

/// 玻璃层主题：亮度略高于默认（底色偏浅，玻璃要看得见），
/// 品牌色只用于发光/高亮，不改变玻璃本身的通透感。
GlassThemeData mobileGlassTheme() {
  const settings = GlassThemeSettings(
    blur: 12,
    frost: 0.42,
    frostOpacity: 0.72,
    thickness: 22,
    lightIntensity: 0.55,
    refractiveIndex: 1.6,
    saturation: 1.5,
  );

  const glow = GlassGlowColors(
    primary: Mc.brand,
    secondary: Mc.fresh,
    success: Mc.fresh,
    warning: Mc.warn,
    danger: Mc.danger,
    info: Mc.brand,
    glowBlurRadius: 6,
    glowOpacity: 0.75,
  );

  return const GlassThemeData(
    brightness: Brightness.light,
    light: GlassThemeVariant(
      settings: settings,
      glowColors: glow,
      borderRadius: Mc.radiusCard,
    ),
    dark: GlassThemeVariant(
      settings: GlassThemeSettings(
        blur: 14,
        frost: 0.5,
        frostOpacity: 0.6,
        thickness: 22,
        lightIntensity: 0.45,
        refractiveIndex: 1.6,
        saturation: 1.4,
      ),
      glowColors: glow,
      borderRadius: Mc.radiusCard,
    ),
    interaction: GlassInteractionSettings(
      interactionScale: 0.97,
      stretch: 0.42,
    ),
  );
}
