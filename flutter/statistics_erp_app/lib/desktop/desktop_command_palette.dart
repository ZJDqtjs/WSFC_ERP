import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';
import '../providers/product_provider.dart';
import 'desktop_style.dart';
import 'nav_model.dart';
import 'widgets/desktop_warehouse_switch.dart';

/// 一条命令：标题 + 说明 + 图标 + 执行动作。
class _Cmd {
  const _Cmd({
    required this.label,
    required this.icon,
    required this.run,
    this.hint = '',
    this.group = '',
  });

  final String label;
  final IconData icon;
  final VoidCallback run;
  final String hint;
  final String group;

  bool matches(String q) =>
      q.isEmpty ||
      label.toLowerCase().contains(q) ||
      hint.toLowerCase().contains(q) ||
      group.toLowerCase().contains(q);
}

/// Ctrl+K 全局命令面板：跳页面、找商品、直接发起动作。
///
/// 桌面端有 16 个一级页面，光靠侧边栏找路很慢；这里把"我要去哪 / 我要找哪个商品"
/// 收进一个输入框，商品数据直接复用 ProductProvider 那份缓存，不额外发请求。
Future<void> showDesktopCommandPalette(
  BuildContext context, {
  required void Function(String route) onNavigate,
  required AuthProvider auth,
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _PaletteDialog(onNavigate: onNavigate, auth: auth),
  );
}

class _PaletteDialog extends StatefulWidget {
  const _PaletteDialog({required this.onNavigate, required this.auth});

  final void Function(String route) onNavigate;
  final AuthProvider auth;

  @override
  State<_PaletteDialog> createState() => _PaletteDialogState();
}

class _PaletteDialogState extends State<_PaletteDialog> {
  final TextEditingController _q = TextEditingController();
  final FocusNode _field = FocusNode();
  int _sel = 0;
  List<_Cmd> _items = const [];

  @override
  void initState() {
    super.initState();
    // 节点级回调先于 EditableText 自己的方向键处理，才能把 ↑↓ 抢过来选结果
    _field.onKeyEvent = _onKey;
    context.read<ProductProvider>().ensureLoaded();
    _rebuild();
  }

  @override
  void dispose() {
    _field.dispose();
    _q.dispose();
    super.dispose();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      setState(() => _sel = _items.isEmpty ? 0 : (_sel + 1) % _items.length);
      return KeyEventResult.skipRemainingHandlers;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      setState(() => _sel =
          _items.isEmpty ? 0 : (_sel - 1 + _items.length) % _items.length);
      return KeyEventResult.skipRemainingHandlers;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter) {
      _run(_sel);
      return KeyEventResult.skipRemainingHandlers;
    }
    return KeyEventResult.ignored;
  }

  void _close() => Navigator.of(context).pop();

  void _rebuild() {
    final q = _q.text.trim().toLowerCase();
    final items = <_Cmd>[
      for (final section in kDesktopNav)
        for (final item in section.items)
          if (item.route != null)
            _Cmd(
              label: item.title,
              group: section.title,
              icon: item.icon,
              hint: item.route!,
              run: () {
                _close();
                widget.onNavigate(item.route!);
              },
            ),
      _Cmd(
        label: '切换分仓',
        group: '动作',
        icon: Icons.storage_outlined,
        run: () {
          _close();
          showWarehouseSwitcher(context, widget.auth);
        },
      ),
      ..._products(q),
    ];
    final filtered =
        q.isEmpty ? items : items.where((c) => c.matches(q)).toList();
    setState(() {
      _items = filtered;
      _sel = 0;
    });
  }

  List<_Cmd> _products(String q) {
    if (q.isEmpty) return const [];
    return context
        .read<ProductProvider>()
        .products
        .where((p) =>
            p.name.toLowerCase().contains(q) ||
            p.code.toLowerCase().contains(q) ||
            p.category.toLowerCase().contains(q))
        .take(8)
        .map((p) => _Cmd(
              label: p.name,
              group: '商品',
              icon: p.productType == 'order'
                  ? Icons.receipt_long_outlined
                  : Icons.inventory_2_outlined,
              hint:
                  '${p.category.isEmpty ? '未分类' : p.category} · 库存 ${p.stock} · ${p.defaultUnit ?? p.baseUnit}',
              run: () {
                _close();
                widget.onNavigate('/products');
              },
            ))
        .toList();
  }

  void _run(int index) {
    if (index < 0 || index >= _items.length) return;
    _items[index].run();
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.symmetric(horizontal: 40, vertical: 80),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 620, maxHeight: 520),
          child: GlassContainer(
            settings: kGlassSoft,
            shape: const LiquidRoundedSuperellipse(borderRadius: 20),
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _SearchField(
                  controller: _q,
                  focusNode: _field,
                  onChanged: (_) => _rebuild(),
                ),
                const SizedBox(height: 10),
                if (_items.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 34),
                    child: Text('没有匹配的页面或商品', style: TextStyle(fontSize: 13)),
                  )
                else
                  Flexible(
                    child: ListView.builder(
                      shrinkWrap: true,
                      padding: EdgeInsets.zero,
                      itemCount: _items.length,
                      itemBuilder: (_, i) => _CmdTile(
                        cmd: _items[i],
                        selected: i == _sel,
                        onHover: () {
                          if (_sel != i) setState(() => _sel = i);
                        },
                        onTap: () => _run(i),
                      ),
                    ),
                  ),
                const SizedBox(height: 6),
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text('↑↓ 选择 · Enter 打开 · Esc 关闭',
                      style: TextStyle(
                          fontSize: 11,
                          color: WsTokens.inkOf(context, level: 3))),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SearchField extends StatelessWidget {
  const _SearchField({
    required this.controller,
    required this.focusNode,
    required this.onChanged,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: WsTokens.fill(context, alpha: 0.8),
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: WsTokens.primary.withValues(alpha: 0.55)),
      ),
      child: Row(
        children: [
          const Padding(
            padding: EdgeInsets.only(left: 10, right: 8),
            child:
                Icon(Icons.search_rounded, size: 18, color: WsTokens.primary),
          ),
          Expanded(
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              autofocus: true,
              onChanged: onChanged,
              style: const TextStyle(fontSize: 15),
              decoration: const InputDecoration(
                isDense: true,
                filled: false,
                contentPadding: EdgeInsets.symmetric(vertical: 12),
                border: InputBorder.none,
                hintText: '跳转到页面，或搜商品名称 / 编码…',
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CmdTile extends StatelessWidget {
  const _CmdTile({
    required this.cmd,
    required this.selected,
    required this.onHover,
    required this.onTap,
  });

  final _Cmd cmd;
  final bool selected;
  final VoidCallback onHover;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => onHover(),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: selected
                ? WsTokens.primary.withValues(alpha: 0.12)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(WsTokens.radiusSm),
          ),
          child: Row(
            children: [
              Icon(cmd.icon,
                  size: 17, color: WsTokens.inkOf(context, level: 2)),
              const SizedBox(width: 10),
              Expanded(
                child: Text(cmd.label,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 13.5,
                        fontWeight:
                            selected ? FontWeight.w600 : FontWeight.w400,
                        color: WsTokens.inkOf(context))),
              ),
              if (cmd.group.isNotEmpty)
                Text(cmd.group,
                    style: TextStyle(
                        fontSize: 11,
                        color: WsTokens.inkOf(context, level: 3))),
              if (cmd.hint.isNotEmpty) ...[
                const SizedBox(width: 10),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 210),
                  child: Text(cmd.hint,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 11,
                          color: WsTokens.inkOf(context, level: 3))),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
