import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

/// 桌面端设计令牌。原先叫 desktop_style.dart（照抄 web 的 Win11 Fluent 观感），
/// 现在桌面端改成玻璃语言、不再对齐网页端，所以整体搬到这里，令牌名保留 WsTokens
/// ——全项目有 500+ 处引用，改名的收益不值那个风险。
class WsTokens {
  WsTokens._();

  // 主色 / 状态色：与移动端 Mc 同一族（#1989FA），两端看起来是一个产品
  static const Color primary = Color(0xFF1989FA);
  static const Color primaryDark = Color(0xFF0958CD);
  static const Color primaryLight = Color(0xFFEAF4FF);
  static const Color brandTop = Color(0xFF3DA0FF);
  static const Color green = Color(0xFF07C160);
  static const Color greenLight = Color(0xFFE5F7EC);
  static const Color red = Color(0xFFF56C6C);
  static const Color redLight = Color(0xFFFDECEC);
  static const Color amber = Color(0xFFE6A23C);
  static const Color amberLight = Color(0xFFFDF3E3);

  // 墨色
  static const Color ink = Color(0xFF16181D);
  static const Color inkSecond = Color(0xFF52575E);
  static const Color inkThird = Color(0xFF8A9099);
  static const Color inkDark = Color(0xFFF2F5FA);
  static const Color inkSecondDark = Color(0xFFB9C2CF);
  static const Color inkThirdDark = Color(0xFF8C97A6);

  // 亮色表面
  static const Color bgLight = Color(0xFFE8EEF7);
  static const Color cardLight = Color(0xFFFFFFFF);
  static const Color textLight = ink;
  static const Color textSecondaryLight = inkSecond;
  static const Color mutedLight = inkThird;
  static const Color borderLight = Color(0xFFDFE6F0);
  static const Color borderLighter = Color(0xFFEAF0F8);

  // 暗色表面
  static const Color bgDark = Color(0xFF121620);
  static const Color cardDark = Color(0xFF1B2130);
  static const Color textDark = inkDark;
  static const Color textSecondaryDark = inkSecondDark;
  static const Color mutedDark = inkThirdDark;
  static const Color borderDark = Color(0xFF2C3547);

  // 圆角
  static const double radiusSm = 6;
  static const double radius = 10;
  static const double radiusLg = 16;
  static const double radiusPanel = 22;

  // 布局
  static const double railWidth = 248;
  static const double railCollapsed = 72;
  static const double toolbarHeight = 62;
  static const double contentMaxWidth = 1440;

  /// 内容区内边距。工具条自带 12px 外边距，这里只留一点点呼吸空间，
  /// 宽表页横向空间永远不够，别浪费。
  static const EdgeInsets contentPadding = EdgeInsets.fromLTRB(20, 16, 20, 20);

  // 欢迎卡渐变
  static const LinearGradient welcomeGradient = LinearGradient(
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
    colors: [Color(0xFFE6F3FF), Color(0xFFF0F8FF), Color(0xFFE6F6FF)],
    stops: [0.0, 0.6, 1.0],
  );

  /// 玻璃之上再铺一层的半透明表面（卡片、表格行、输入框都用它，不走 shader）
  static Color fill(BuildContext context, {double alpha = 0.72}) =>
      wsIsDark(context)
          ? cardDark.withValues(alpha: alpha)
          : Colors.white.withValues(alpha: alpha);

  static Color line(BuildContext context, {double alpha = 1}) =>
      (wsIsDark(context) ? borderDark : borderLight).withValues(alpha: alpha);

  /// 弹窗遮罩：把背景压暗，弹层才浮得起来。
  static Color scrim(bool dark) =>
      Colors.black.withValues(alpha: dark ? 0.62 : 0.4);

  static Color inkOf(BuildContext context, {int level = 1}) {
    if (wsIsDark(context)) {
      return switch (level) {
        1 => textDark,
        2 => textSecondaryDark,
        _ => mutedDark,
      };
    }
    return switch (level) {
      1 => textLight,
      2 => textSecondaryLight,
      _ => mutedLight,
    };
  }
}

/// 当前是否暗色：桌面壳统一用主题亮度判断。
bool wsIsDark(BuildContext context) =>
    Theme.of(context).brightness == Brightness.dark;

/// 主玻璃面板：折射 + 色散 + 发光全开，一页只放一层（或两三层）。
const GlassThemeSettings kGlassHero = GlassThemeSettings(
  blur: 7,
  frost: 0.44,
  frostOpacity: 0.7,
  thickness: 16,
  lightIntensity: 0.5,
  refractiveIndex: 1.15,
  chromaticAberration: 0.22,
  saturation: 1.18,
);

/// 次级表面（导航条、工具条、弹层）用的"雾面"：只模糊不折射。
/// 桌面窗口比手机大一个数量级，折射按像素算钱，多一层就多一层开销；
/// 而且这些条上全是小字号文字，折射会把笔画拉毛，反而看不清。
///
/// 单个控件的 `settings:` 只认 [LiquidGlassSettings]（[GlassThemeSettings] 是给
/// GlassThemeVariant 用的"可缺省覆盖"版本，字段全是 nullable，两者不能混用）。
const LiquidGlassSettings kGlassSoft = LiquidGlassSettings(
  blur: 9,
  frost: 0.58,
  frostOpacity: 0.88,
  thickness: 6,
  lightIntensity: 0.28,
  refractiveIndex: 1.0,
  chromaticAberration: 0.0,
  saturation: 1.05,
  glowIntensity: 0.35,
  shadowElevation: 0.5,
);

/// 弹层（弹窗 / 命令面板）专用：先垫一块近乎不透明的背板，再上玻璃。
/// [kGlassSoft] 的雾面在这种大尺寸面板上压不住背景——出库单弹窗里，
/// 表格行文字会直接透到表单标签上，两层字叠在一起完全读不了。
/// 背板只挡在弹层这一块，边缘的折射和高光还在，通透感换成可读性。
LiquidGlassSettings wsOverlayGlass(bool dark) => LiquidGlassSettings(
      blur: 22,
      frost: 0.58,
      frostOpacity: 0.9,
      thickness: 6,
      lightIntensity: 0.24,
      refractiveIndex: 1.0,
      chromaticAberration: 0.0,
      saturation: 1.02,
      glowIntensity: 0.32,
      shadowElevation: 0.6,
      backerColor: dark
          ? const Color(0xF21B2130)
          : const Color(0xF0FFFFFF),
    );

/// 玻璃层主题：桌面用大圆角、低折射，品牌色只出现在发光和高亮上。
GlassThemeData desktopGlassTheme() {
  const glow = GlassGlowColors(
    primary: WsTokens.primary,
    secondary: WsTokens.green,
    success: WsTokens.green,
    warning: WsTokens.amber,
    danger: WsTokens.red,
    info: WsTokens.primary,
    glowBlurRadius: 8,
    glowOpacity: 0.6,
  );

  return const GlassThemeData(
    brightness: Brightness.light,
    light: GlassThemeVariant(
      settings: kGlassHero,
      glowColors: glow,
      borderRadius: WsTokens.radiusPanel,
    ),
    dark: GlassThemeVariant(
      settings: GlassThemeSettings(
        blur: 8,
        frost: 0.52,
        frostOpacity: 0.66,
        thickness: 16,
        lightIntensity: 0.4,
        refractiveIndex: 1.15,
        chromaticAberration: 0.22,
        saturation: 1.12,
      ),
      glowColors: glow,
      borderRadius: WsTokens.radiusPanel,
    ),
    interaction: GlassInteractionSettings(
      interactionScale: 0.985,
      stretch: 0.3,
    ),
  );
}

/// 桌面 Material 主题。玻璃只负责"壳"，控件本体仍是 Material，
/// 所以下面这些 control theme 决定了没被玻璃包住的部分长什么样。
ThemeData wsMaterialTheme(Brightness brightness) {
  final bool dark = brightness == Brightness.dark;
  final ColorScheme scheme = ColorScheme.fromSeed(
    seedColor: WsTokens.primary,
    brightness: brightness,
  ).copyWith(
    primary: WsTokens.primary,
    error: WsTokens.red,
    surface: dark ? WsTokens.cardDark : Colors.white,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: dark ? WsTokens.bgDark : WsTokens.bgLight,
    visualDensity: VisualDensity.standard,
    fontFamilyFallback: const ['Segoe UI', 'Microsoft YaHei'],
    iconTheme: IconThemeData(
        color: dark ? WsTokens.inkSecondDark : WsTokens.inkSecond),
    textTheme: TextTheme(
      titleLarge: TextStyle(
        fontSize: 21,
        fontWeight: FontWeight.w700,
        color: dark ? WsTokens.textDark : WsTokens.textLight,
      ),
      titleMedium: TextStyle(
        fontSize: 15.5,
        fontWeight: FontWeight.w600,
        color: dark ? WsTokens.textDark : WsTokens.textLight,
      ),
      bodyMedium: TextStyle(
        fontSize: 13.5,
        color: dark ? WsTokens.textSecondaryDark : WsTokens.textSecondaryLight,
      ),
    ),
    dividerTheme: const DividerThemeData(space: 1, thickness: 0.8),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: dark ? WsTokens.cardDark : Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(WsTokens.radius),
        borderSide: BorderSide(
            color: dark ? WsTokens.borderDark : WsTokens.borderLight),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(WsTokens.radius),
        borderSide: BorderSide(
            color: dark ? WsTokens.borderDark : WsTokens.borderLight),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(WsTokens.radius),
        borderSide: const BorderSide(color: WsTokens.primary, width: 1.6),
      ),
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF30394B) : const Color(0xFF2B303B),
        borderRadius: BorderRadius.circular(WsTokens.radiusSm),
      ),
      textStyle: const TextStyle(fontSize: 12, color: Colors.white),
      waitDuration: const Duration(milliseconds: 450),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: dark ? const Color(0xFF2A3346) : const Color(0xFF262B33),
      contentTextStyle: const TextStyle(fontSize: 13, color: Colors.white),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(WsTokens.radius),
      ),
    ),
    scrollbarTheme: ScrollbarThemeData(
      thickness: WidgetStateProperty.all(9),
      radius: const Radius.circular(6),
      thumbColor: WidgetStatePropertyAll(
        (dark ? Colors.white : Colors.black).withValues(alpha: 0.18),
      ),
    ),
  );
}
