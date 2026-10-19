import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../../providers/auth_provider.dart';
import '../desktop_style.dart';
import 'desktop_motion.dart';
import 'desktop_warehouse_switch.dart';

/// 顶部玻璃工具条：全局只放"我在哪个仓 / 我在哪一页 / 我要找什么"。
/// 页面自己的动作按钮仍在页面头里，工具条不参与业务。
class DesktopToolbar extends StatelessWidget {
  const DesktopToolbar({
    super.key,
    required this.groupTitle,
    required this.pageTitle,
    required this.auth,
    required this.onOpenSearch,
    this.onRefresh,
  });

  final String groupTitle;
  final String pageTitle;
  final AuthProvider auth;
  final VoidCallback onOpenSearch;
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: WsTokens.toolbarHeight,
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      child: GlassContainer(
        settings: kGlassSoft,
        shape: const LiquidRoundedSuperellipse(borderRadius: 18),
        padding: const EdgeInsets.symmetric(horizontal: 10),
        child: Row(
          children: [
            _WarehouseChip(auth: auth),
            const SizedBox(width: 6),
            _Crumb(groupTitle: groupTitle, pageTitle: pageTitle),
            const Spacer(),
            _SearchBox(onTap: onOpenSearch),
            if (onRefresh != null) ...[
              const SizedBox(width: 4),
              IconButton(
                tooltip: '刷新本页数据',
                onPressed: onRefresh,
                icon: const Icon(Icons.refresh_rounded, size: 19),
              ),
            ],
            const SizedBox(width: 4),
          ],
        ),
      ),
    );
  }
}

class _WarehouseChip extends StatelessWidget {
  const _WarehouseChip({required this.auth});

  final AuthProvider auth;

  @override
  Widget build(BuildContext context) {
    final name =
        auth.warehouseName.isNotEmpty ? auth.warehouseName : auth.warehouseKey;
    return Tooltip(
      message: '切换分仓（所有页面读新仓数据）',
      child: InkWell(
        borderRadius: BorderRadius.circular(WsTokens.radius),
        onTap: () => showWarehouseSwitcher(context, auth),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
          child: Row(
            children: [
              Container(
                width: 26,
                height: 26,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: WsTokens.primary.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Icon(Icons.warehouse_outlined,
                    size: 15, color: WsTokens.primary),
              ),
              const SizedBox(width: 8),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 190),
                child: Text(
                  name.isEmpty ? '未选分仓' : name,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: WsTokens.inkOf(context)),
                ),
              ),
              Icon(Icons.unfold_more,
                  size: 15, color: WsTokens.inkOf(context, level: 3)),
            ],
          ),
        ),
      ),
    );
  }
}

class _Crumb extends StatelessWidget {
  const _Crumb({required this.groupTitle, required this.pageTitle});

  final String groupTitle;
  final String pageTitle;

  @override
  Widget build(BuildContext context) {
    final muted = WsTokens.inkOf(context, level: 3);
    return Row(
      children: [
        Container(width: 1, height: 20, color: WsTokens.line(context)),
        const SizedBox(width: 14),
        if (groupTitle.isNotEmpty) ...[
          Text(groupTitle, style: TextStyle(fontSize: 12.5, color: muted)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Text('›', style: TextStyle(fontSize: 12.5, color: muted)),
          ),
        ],
        Text(
          pageTitle,
          style: TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w600,
              color: WsTokens.inkOf(context)),
        ),
      ],
    );
  }
}

class _SearchBox extends StatefulWidget {
  const _SearchBox({required this.onTap});

  final VoidCallback onTap;

  @override
  State<_SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<_SearchBox> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final muted = WsTokens.inkOf(context, level: 3);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: Dm.quick,
          curve: Dm.curve,
          width: 250,
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color:
                WsTokens.fill(context, alpha: wsIsDark(context) ? 0.5 : 0.75),
            borderRadius: BorderRadius.circular(WsTokens.radius),
            border: Border.all(
              color: _hover ? WsTokens.primary : WsTokens.line(context),
            ),
          ),
          child: Row(
            children: [
              Icon(Icons.search_rounded, size: 17, color: muted),
              const SizedBox(width: 8),
              Expanded(
                child: Text('搜索页面 / 商品',
                    style: TextStyle(fontSize: 12.5, color: muted)),
              ),
              _KeyHint(label: 'Ctrl K', color: muted),
            ],
          ),
        ),
      ),
    );
  }
}

class _KeyHint extends StatelessWidget {
  const _KeyHint({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(label,
          style: TextStyle(
              fontSize: 10.5,
              color: color,
              fontFamily: 'Consolas',
              height: 1.2)),
    );
  }
}
