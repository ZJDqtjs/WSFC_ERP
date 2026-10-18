import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../mobile_style.dart';
import 'motion.dart';

/// 页面分节标题：小字距、灰阶，压住下面的玻璃卡片。
class SectionHeader extends StatelessWidget {
  const SectionHeader({super.key, required this.title, this.trailing, this.top = 18});

  final String title;
  final Widget? trailing;
  final double top;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(6, top, 6, 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: Mc.inkSecond,
                letterSpacing: 0.4,
              ),
            ),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

/// 玻璃卡片：统一圆角与内边距，页面里所有"块"都用它。
class GlassPanel extends StatelessWidget {
  const GlassPanel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.margin,
    this.onTap,
    this.clipBehavior = Clip.none,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;
  final VoidCallback? onTap;
  final Clip clipBehavior;

  @override
  Widget build(BuildContext context) {
    final card = GlassCard(
      padding: EdgeInsets.zero,
      margin: margin,
      clipBehavior: clipBehavior,
      shape: const LiquidRoundedSuperellipse(borderRadius: Mc.radiusCard),
      child: Padding(padding: padding, child: child),
    );
    if (onTap == null) return card;
    return PressableScale(onTap: onTap, child: card);
  }
}

/// 指标卡：标题 + 滚动数字 + 补充说明。首页三块并排用。
class StatCard extends StatelessWidget {
  const StatCard({
    super.key,
    required this.label,
    required this.value,
    required this.format,
    this.foot,
    this.accent,
    this.stress = false,
  });

  final String label;
  final double value;
  final String Function(double v) format;
  final String? foot;

  /// 数字颜色，默认近黑；利润类传 [Mc.fresh]。
  final Color? accent;

  /// true 时数字放大一号，用于页面上的主指标。
  final bool stress;

  @override
  Widget build(BuildContext context) {
    return GlassPanel(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 12, color: Mc.inkThird)),
          const SizedBox(height: 6),
          DefaultTextStyle(
            style: TextStyle(
              fontSize: stress ? 22 : 17,
              fontWeight: FontWeight.w700,
              color: accent ?? Mc.ink,
              height: 1.1,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
            child: CountUp(value: value, builder: format),
          ),
          if (foot != null) ...[
            const SizedBox(height: 4),
            Text(foot!,
                style: const TextStyle(fontSize: 11, color: Mc.inkSecond),
                maxLines: 1,
                overflow: TextOverflow.ellipsis),
          ],
        ],
      ),
    );
  }
}

/// 与 Material `Card(child:, margin:)` 用法等价的玻璃卡片，
/// 便于把旧页面里的 Card 逐个替换成玻璃观感。
class GCard extends StatelessWidget {
  const GCard({
    super.key,
    required this.child,
    this.margin,
    this.clipBehavior = Clip.none,
  });

  final Widget child;
  final EdgeInsetsGeometry? margin;
  final Clip clipBehavior;

  @override
  Widget build(BuildContext context) {
    return GlassPanel(
      margin: margin,
      padding: EdgeInsets.zero,
      clipBehavior: clipBehavior,
      child: child,
    );
  }
}

/// 品牌色实底卡：和周围玻璃拉开层次，用来放最需要被看见的那一个数字。
class BrandCard extends StatelessWidget {
  const BrandCard({
    super.key,
    required this.child,
    this.colors,
    this.onTap,
  });

  final Widget child;
  final List<Color>? colors;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final card = Container(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: colors ?? const [Mc.brandTop, Mc.brandDeep],
        ),
        borderRadius: BorderRadius.circular(Mc.radiusCard),
        boxShadow: [
          BoxShadow(
            color: (colors?.last ?? Mc.brandDeep).withValues(alpha: 0.28),
            blurRadius: 22,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(borderRadius: BorderRadius.circular(Mc.radiusCard), onTap: onTap, child: child),
      ),
    );
    return card;
  }
}

/// 九宫格业务入口。图标自带小玻璃底，按下去整体缩放。
class QuickEntry extends StatelessWidget {
  const QuickEntry({
    super.key,
    required this.label,
    required this.icon,
    required this.onTap,
    this.color,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final tint = color ?? Mc.brand;
    return PressableScale(
      onTap: onTap,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: tint.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(icon, size: 22, color: tint),
          ),
          const SizedBox(height: 7),
          Text(label,
              style: const TextStyle(fontSize: 12, color: Mc.ink),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
        ],
      ),
    );
  }
}

/// 列表行：玻璃分组里的"我的"这类设置项。
class TileRow extends StatelessWidget {
  const TileRow({
    super.key,
    required this.title,
    this.subtitle,
    this.icon,
    this.trailing,
    this.onTap,
    this.iconColor,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final Widget? trailing;
  final VoidCallback? onTap;
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            if (icon != null)
              Container(
                width: 32,
                height: 32,
                margin: const EdgeInsets.only(right: 12),
                decoration: BoxDecoration(
                  color: (iconColor ?? Mc.brand).withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(icon, size: 18, color: iconColor ?? Mc.brand),
              ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(
                          fontSize: 15, fontWeight: FontWeight.w600, color: Mc.ink)),
                  if (subtitle != null) ...[
                    const SizedBox(height: 3),
                    Text(subtitle!,
                        style: const TextStyle(fontSize: 12, color: Mc.inkThird)),
                  ],
                ],
              ),
            ),
            if (trailing != null) trailing!,
            if (onTap != null)
              const Padding(
                padding: EdgeInsets.only(left: 4),
                child: Icon(Icons.arrow_forward_ios, size: 13, color: Mc.inkThird),
              ),
          ],
        ),
      ),
    );
  }
}

/// 空状态：图标 + 一句话 + 可选操作。
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.text, this.icon, this.action});

  final String text;
  final IconData? icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 42, horizontal: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon ?? Icons.inbox_outlined, size: 40, color: Mc.inkThird),
            const SizedBox(height: 12),
            Text(text,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13, color: Mc.inkSecond)),
            if (action != null) ...[const SizedBox(height: 14), action!],
          ],
        ),
      ),
    );
  }
}
