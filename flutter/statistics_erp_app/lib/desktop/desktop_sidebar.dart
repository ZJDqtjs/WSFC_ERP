import 'package:flutter/material.dart';

import '../providers/auth_provider.dart';
import 'fluent_theme.dart';
import 'nav_model.dart';
import 'widgets/desktop_motion.dart';

/// 桌面侧边栏，忠实复刻 web/static/index.html 的 .sidebar：
/// 顶部 logo、分组导航（.nav-group + .nav-item）、底部用户卡（.side-user）。
class DesktopSidebar extends StatelessWidget {
  const DesktopSidebar({
    super.key,
    required this.currentRoute,
    required this.onSelect,
    required this.auth,
  });

  final String currentRoute;
  final ValueChanged<DesktopNavItem> onSelect;
  final AuthProvider auth;

  @override
  Widget build(BuildContext context) {
    final bool dark = wsIsDark(context);
    return Container(
      width: WsTokens.sidebarWidth,
      decoration: BoxDecoration(
        color: dark ? WsTokens.cardDark : WsTokens.cardLight,
        border: Border(
          right: BorderSide(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _LogoHeader(dark: dark),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.only(bottom: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final section in kDesktopNav) ...[
                    if (section.title.isNotEmpty)
                      _GroupHeader(title: section.title, dark: dark),
                    for (final item in section.items)
                      _NavTile(
                        item: item,
                        active: item.route != null && item.route == currentRoute,
                        dark: dark,
                        onTap: item.enabled ? () => onSelect(item) : null,
                      ),
                  ],
                ],
              ),
            ),
          ),
          _UserFooter(auth: auth, dark: dark),
        ],
      ),
    );
  }
}

class _LogoHeader extends StatelessWidget {
  const _LogoHeader({required this.dark});
  final bool dark;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 14),
      child: Row(
        children: [
          const DesktopIconTile(
            icon: Icons.insights_outlined,
            colors: [Color(0xFF4FAAFF), Color(0xFF0D6EFD)],
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '企业台账',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: dark ? WsTokens.textDark : WsTokens.textLight,
                ),
              ),
              Text(
                '库存 · 财务 · 一体化',
                style: TextStyle(
                  fontSize: 11,
                  color: dark ? WsTokens.mutedDark : WsTokens.mutedLight,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _GroupHeader extends StatelessWidget {
  const _GroupHeader({required this.title, required this.dark});
  final String title;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 12, 6),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.5,
          color: dark ? WsTokens.mutedDark : WsTokens.mutedLight,
        ),
      ),
    );
  }
}

class _NavTile extends StatefulWidget {
  const _NavTile({
    required this.item,
    required this.active,
    required this.dark,
    this.onTap,
  });
  final DesktopNavItem item;
  final bool active;
  final bool dark;
  final VoidCallback? onTap;

  @override
  State<_NavTile> createState() => _NavTileState();
}

class _NavTileState extends State<_NavTile> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final bool enabled = widget.onTap != null;
    final Color fg = !enabled
        ? (widget.dark ? WsTokens.mutedDark : WsTokens.mutedLight)
        : widget.active
            ? WsTokens.primary
            : (widget.dark ? WsTokens.textDark : WsTokens.textLight);
    final Color bg = widget.active
        ? (widget.dark ? const Color(0xFF323232) : WsTokens.primaryLight)
        : _hover && enabled
            ? (widget.dark ? const Color(0xFF2F2F2F) : const Color(0xFFF5F5F5))
            : Colors.transparent;

    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: enabled ? (_) => setState(() => _hover = true) : null,
      onExit: enabled ? (_) => setState(() => _hover = false) : null,
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: Dm.quick,
          curve: Dm.curve,
          height: 36,
          margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(WsTokens.radius),
          ),
          child: Row(
            children: [
              // active 左侧强调条（web .nav-item.active::before）
              AnimatedContainer(
                duration: Dm.quick,
                curve: Dm.curve,
                width: 3,
                height: widget.active ? 18 : 0,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Color(0xFF4FAAFF), WsTokens.primary],
                  ),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 9),
              TweenAnimationBuilder<Color?>(
                duration: Dm.quick,
                curve: Dm.curve,
                tween: ColorTween(end: fg),
                builder: (BuildContext context, Color? color, Widget? child) =>
                    Icon(widget.item.icon, size: 17, color: color),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: AnimatedDefaultTextStyle(
                  duration: Dm.quick,
                  curve: Dm.curve,
                  style: TextStyle(fontSize: 13.5, color: fg),
                  child: Text(
                    widget.item.title,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _UserFooter extends StatelessWidget {
  const _UserFooter({required this.auth, required this.dark});
  final AuthProvider auth;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    final name = auth.displayName;
    final initial = name.isNotEmpty ? name.substring(0, 1) : '管';
    final warehouse = auth.warehouseName.isNotEmpty
        ? auth.warehouseName
        : auth.warehouseKey;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: dark ? WsTokens.borderDark : WsTokens.borderLighter),
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [Color(0xFF4FAAFF), Color(0xFF1989FA)],
              ),
              shape: BoxShape.circle,
            ),
            child: Text(
              initial,
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name.isEmpty ? '未登录' : name,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: dark ? WsTokens.textDark : WsTokens.textLight,
                  ),
                ),
                Text(
                  warehouse,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    color: dark ? WsTokens.mutedDark : WsTokens.mutedLight,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: '退出登录',
            onPressed: auth.logout,
            icon: const Icon(Icons.logout, size: 16),
          ),
        ],
      ),
    );
  }
}
