import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../../providers/auth_provider.dart';
import '../desktop_style.dart';
import '../nav_model.dart';
import 'desktop_motion.dart';
import 'desktop_warehouse_switch.dart';

/// 桌面底板的"极光"：静态渐变 + 几团品牌色光斑，给玻璃层东西可折射。
/// 不参与逐帧动画，整块包在 RepaintBoundary 里，只在主题切换时重绘。
class DesktopBackdrop extends StatelessWidget {
  const DesktopBackdrop({super.key, required this.child, this.intensity = 1.0});

  final Widget child;
  final double intensity;

  @override
  Widget build(BuildContext context) {
    final bool dark = wsIsDark(context);
    final Color base = dark ? WsTokens.bgDark : WsTokens.bgLight;
    return RepaintBoundary(
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: dark
                ? [base, const Color(0xFF171D2B), const Color(0xFF121826)]
                : [const Color(0xFFF2F6FC), base, const Color(0xFFE4EBF6)],
          ),
        ),
        child: Stack(
          fit: StackFit.expand,
          children: [
            // 光斑贴在导航条和工具条背后，这两处玻璃最薄，靠光斑把层次顶出来
            _Blob(
              alignment: const Alignment(-1.05, -0.8),
              diameter: 620,
              color: WsTokens.brandTop
                  .withValues(alpha: (dark ? 0.2 : 0.3) * intensity),
            ),
            _Blob(
              alignment: const Alignment(1.15, -0.35),
              diameter: 520,
              color: WsTokens.green
                  .withValues(alpha: (dark ? 0.1 : 0.15) * intensity),
            ),
            _Blob(
              alignment: const Alignment(-0.25, 1.25),
              diameter: 700,
              color: WsTokens.primaryDark
                  .withValues(alpha: (dark ? 0.18 : 0.16) * intensity),
            ),
            child,
          ],
        ),
      ),
    );
  }
}

class _Blob extends StatelessWidget {
  const _Blob(
      {required this.alignment, required this.diameter, required this.color});

  final Alignment alignment;
  final double diameter;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: alignment,
      child: SizedBox(
        width: diameter,
        height: diameter,
        child: DecoratedBox(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient:
                RadialGradient(colors: [color, color.withValues(alpha: 0)]),
          ),
        ),
      ),
    );
  }
}

/// 左侧导航条：可折叠（248 ↔ 72）。折叠后只留图标 + 悬浮提示，
/// 小窗口下把横向空间还给表格——桌面端一半以上的页面是宽表，列宽永远不够。
class DesktopRail extends StatelessWidget {
  const DesktopRail({
    super.key,
    required this.sections,
    required this.currentRoute,
    required this.onSelect,
    required this.auth,
    required this.collapsed,
    required this.onToggleCollapse,
    this.badges = const <String, int>{},
  });

  final List<DesktopNavSection> sections;
  final String currentRoute;
  final ValueChanged<DesktopNavItem> onSelect;
  final AuthProvider auth;
  final bool collapsed;
  final VoidCallback onToggleCollapse;
  final Map<String, int> badges;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: Dm.base,
      curve: Dm.curve,
      width: collapsed ? WsTokens.railCollapsed : WsTokens.railWidth,
      margin: const EdgeInsets.fromLTRB(12, 12, 0, 12),
      child: GlassContainer(
        settings: kGlassSoft,
        shape: const LiquidRoundedSuperellipse(borderRadius: 18),
        padding: EdgeInsets.zero,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _RailHead(
                  collapsed: collapsed, onToggleCollapse: onToggleCollapse),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final section in sections) ...[
                        if (section.title.isNotEmpty)
                          _GroupHeader(
                              title: section.title, collapsed: collapsed),
                        for (final item in section.items)
                          _RailTile(
                            item: item,
                            collapsed: collapsed,
                            active: item.route != null &&
                                item.route == currentRoute,
                            badge: item.route == null
                                ? 0
                                : (badges[item.route!] ?? 0),
                            onTap: item.enabled ? () => onSelect(item) : null,
                          ),
                      ],
                    ],
                  ),
                ),
              ),
              _RailUser(auth: auth, collapsed: collapsed),
            ],
          ),
        ),
      ),
    );
  }
}

class _RailHead extends StatelessWidget {
  const _RailHead({required this.collapsed, required this.onToggleCollapse});

  final bool collapsed;
  final VoidCallback onToggleCollapse;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(collapsed ? 0 : 14, 14, 10, 10),
      child: Row(
        mainAxisAlignment:
            collapsed ? MainAxisAlignment.center : MainAxisAlignment.start,
        children: [
          const DesktopIconTile(
            icon: Icons.insights_outlined,
            colors: [WsTokens.brandTop, WsTokens.primary],
          ),
          if (!collapsed) ...[
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('企业台账',
                      style: TextStyle(
                          fontSize: 14.5,
                          fontWeight: FontWeight.w700,
                          color: WsTokens.inkOf(context))),
                  Text('库存 · 财务 · 一体化',
                      style: TextStyle(
                          fontSize: 11,
                          color: WsTokens.inkOf(context, level: 3))),
                ],
              ),
            ),
          ],
          IconButton(
            tooltip: collapsed ? '展开导航 (Ctrl+B)' : '折叠导航 (Ctrl+B)',
            onPressed: onToggleCollapse,
            iconSize: 17,
            visualDensity: VisualDensity.compact,
            icon: Icon(collapsed
                ? Icons.keyboard_double_arrow_right
                : Icons.keyboard_double_arrow_left),
          ),
        ],
      ),
    );
  }
}

class _GroupHeader extends StatelessWidget {
  const _GroupHeader({required this.title, required this.collapsed});

  final String title;
  final bool collapsed;

  @override
  Widget build(BuildContext context) {
    if (collapsed) {
      // 折叠态分组只留一道分隔，不然 6 组小灰点反而更乱
      return const Padding(
        padding: EdgeInsets.fromLTRB(16, 10, 16, 6),
        child: Divider(height: 1),
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 12, 6),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 10.5,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.1,
          color: WsTokens.inkOf(context, level: 3),
        ),
      ),
    );
  }
}

class _RailTile extends StatefulWidget {
  const _RailTile({
    required this.item,
    required this.collapsed,
    required this.active,
    required this.badge,
    this.onTap,
  });

  final DesktopNavItem item;
  final bool collapsed;
  final bool active;
  final int badge;
  final VoidCallback? onTap;

  @override
  State<_RailTile> createState() => _RailTileState();
}

class _RailTileState extends State<_RailTile> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final bool enabled = widget.onTap != null;
    final bool dark = wsIsDark(context);
    final Color fg = !enabled
        ? WsTokens.inkOf(context, level: 3)
        : widget.active
            ? WsTokens.primary
            : WsTokens.inkOf(context);
    final Color bg = widget.active
        ? WsTokens.primary.withValues(alpha: dark ? 0.2 : 0.11)
        : _hover && enabled
            ? WsTokens.inkOf(context).withValues(alpha: 0.055)
            : Colors.transparent;

    final Widget tile = AnimatedContainer(
      duration: Dm.quick,
      curve: Dm.curve,
      height: widget.collapsed ? 44 : 36,
      margin: EdgeInsets.symmetric(
          horizontal: widget.collapsed ? 12 : 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(WsTokens.radius),
      ),
      child: widget.collapsed
          ? Center(
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  Icon(widget.item.icon, size: 20, color: fg),
                  if (widget.badge > 0)
                    Positioned(
                      right: -6,
                      top: -4,
                      child: Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: const Color(0xFFF97316),
                          shape: BoxShape.circle,
                          border: Border.all(
                              color: dark ? WsTokens.cardDark : Colors.white,
                              width: 1.4),
                        ),
                      ),
                    ),
                ],
              ),
            )
          : Row(
              children: [
                // 选中项左侧强调条
                AnimatedContainer(
                  duration: Dm.quick,
                  curve: Dm.curve,
                  width: 3,
                  height: widget.active ? 18 : 0,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [WsTokens.brandTop, WsTokens.primary],
                    ),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(width: 10),
                Icon(widget.item.icon, size: 18, color: fg),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(widget.item.title,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 13.5,
                          fontWeight:
                              widget.active ? FontWeight.w600 : FontWeight.w400,
                          color: fg)),
                ),
                if (widget.badge > 0) ...[
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF97316),
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: Text('${widget.badge}',
                        style: const TextStyle(
                            fontSize: 11,
                            height: 1.35,
                            color: Colors.white,
                            fontWeight: FontWeight.w600)),
                  ),
                  const SizedBox(width: 8),
                ],
              ],
            ),
    );

    final Widget tappable = MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: enabled ? (_) => setState(() => _hover = true) : null,
      onExit: enabled ? (_) => setState(() => _hover = false) : null,
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: tile,
      ),
    );

    return Tooltip(message: widget.item.title, child: tappable);
  }
}

class _RailUser extends StatelessWidget {
  const _RailUser({required this.auth, required this.collapsed});

  final AuthProvider auth;
  final bool collapsed;

  @override
  Widget build(BuildContext context) {
    final name = auth.displayName;
    final initial = name.isNotEmpty ? name.characters.first : '管';
    final warehouse =
        auth.warehouseName.isNotEmpty ? auth.warehouseName : auth.warehouseKey;

    final avatar = Container(
      width: 32,
      height: 32,
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [WsTokens.brandTop, WsTokens.primary],
        ),
        shape: BoxShape.circle,
      ),
      child: Text(initial,
          style: const TextStyle(
              color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
    );

    return Container(
      padding: EdgeInsets.fromLTRB(collapsed ? 0 : 12, 10, 8, 10),
      decoration: BoxDecoration(
        border:
            Border(top: BorderSide(color: WsTokens.line(context, alpha: 0.6))),
      ),
      child: Row(
        mainAxisAlignment:
            collapsed ? MainAxisAlignment.center : MainAxisAlignment.start,
        children: [
          avatar,
          if (!collapsed) ...[
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name.isEmpty ? '未登录' : name,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                          color: WsTokens.inkOf(context))),
                  Text(warehouse,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 11,
                          color: WsTokens.inkOf(context, level: 3))),
                ],
              ),
            ),
          ],
          PopupMenuButton<String>(
            tooltip: '账户 / 分仓',
            icon: const Icon(Icons.more_horiz, size: 18),
            padding: EdgeInsets.zero,
            onSelected: (String action) async {
              switch (action) {
                case 'warehouse':
                  await showWarehouseSwitcher(context, auth);
                case 'logout':
                  await auth.logout();
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'warehouse', child: Text('切换分仓')),
              const PopupMenuItem(value: 'logout', child: Text('退出登录')),
            ],
          ),
        ],
      ),
    );
  }
}
