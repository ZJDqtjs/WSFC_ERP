import 'package:flutter/material.dart';

import '../fluent_theme.dart';

/// 复刻 web .card：白底、12 圆角、1px 边框、柔和阴影、24 内边距、下间距 20。
class WsCard extends StatelessWidget {
  const WsCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(24),
    this.gradient,
    this.marginBottom = 20,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Gradient? gradient;
  final double marginBottom;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Container(
      margin: EdgeInsets.only(bottom: marginBottom),
      padding: padding,
      decoration: BoxDecoration(
        color: dark ? WsTokens.cardDark : WsTokens.cardLight,
        gradient: gradient,
        borderRadius: BorderRadius.circular(WsTokens.radiusLg),
        border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
        boxShadow: dark
            ? null
            : const [
                BoxShadow(color: Color(0x0A000000), blurRadius: 6, offset: Offset(0, 1.5)),
              ],
      ),
      child: child,
    );
  }
}

/// 卡片标题行（web .card-head：图标 + 标题 + 右侧操作）。
class WsCardHead extends StatelessWidget {
  const WsCardHead({super.key, required this.title, this.icon, this.trailing});
  final String title;
  final IconData? icon;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
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
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: dark ? WsTokens.textDark : WsTokens.textLight,
              ),
            ),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}
