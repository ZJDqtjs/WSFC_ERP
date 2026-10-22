import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../desktop_style.dart';

/// 桌面端的"面板"。默认走半透明雾面（[WsTokens.fill]）而不是玻璃 shader：
/// 一个页面动辄七八张卡片，全上折射等于桌面窗口那么大面积逐帧跑滤镜，
/// 手机端的卡顿教训已经给过一次。真正需要折射的 hero 面板用 [WsCard.glass]，
/// 一页最多一张。
class WsCard extends StatelessWidget {
  const WsCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
    this.gradient,
    this.marginBottom = 16,
  }) : hero = false;

  /// 主玻璃面板：整页只放一层，折射/色散才有意义，也才跑得动。
  const WsCard.glass({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
    this.marginBottom = 16,
  })  : hero = true,
        gradient = null;

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Gradient? gradient;
  final double marginBottom;
  final bool hero;

  @override
  Widget build(BuildContext context) {
    if (hero) {
      return Padding(
        padding: EdgeInsets.only(bottom: marginBottom),
        child: GlassCard(
          padding: padding,
          shape: const LiquidRoundedSuperellipse(
              borderRadius: WsTokens.radiusPanel),
          child: child,
        ),
      );
    }
    return Container(
      margin: EdgeInsets.only(bottom: marginBottom),
      padding: padding,
      decoration: BoxDecoration(
        color: gradient == null ? WsTokens.fill(context, alpha: 0.82) : null,
        gradient: gradient,
        borderRadius: BorderRadius.circular(WsTokens.radiusLg),
        border: Border.all(color: WsTokens.line(context, alpha: 0.85)),
        boxShadow: [
          BoxShadow(
            color:
                Colors.black.withValues(alpha: wsIsDark(context) ? 0.3 : 0.05),
            blurRadius: 10,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: child,
    );
  }
}

/// 面板标题行：图标 + 标题 + 右侧操作。
class WsCardHead extends StatelessWidget {
  const WsCardHead({super.key, required this.title, this.icon, this.trailing});
  final String title;
  final IconData? icon;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        children: [
          if (icon != null) ...[
            Icon(icon, size: 18, color: WsTokens.primary),
            const SizedBox(width: 8),
          ],
          Expanded(
            child: Text(
              title,
              style: TextStyle(
                fontSize: 15.5,
                fontWeight: FontWeight.w600,
                color: WsTokens.inkOf(context),
              ),
            ),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}
