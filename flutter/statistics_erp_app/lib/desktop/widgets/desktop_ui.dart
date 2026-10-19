import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

import '../fluent_theme.dart';

/// 桌面端通用控件层：把 web 端的表格 / 筛选栏 / 弹窗表单 / 提示语，
/// 用 Material 复刻成 Fluent 观感的一套组件，供各业务页复用。

// ---------------------------------------------------------------- 格式化

final NumberFormat _moneyFmt = NumberFormat('#,##0.00', 'en_US');
final NumberFormat _intFmt = NumberFormat('#,##0', 'en_US');

/// 金额：¥1,234.56（不带符号用 [wsNum]）
String wsMoney(num? v) => '¥${_moneyFmt.format(v ?? 0)}';

/// 数字：千分位 + 原样小数位
String wsNum(num? v, {int? maxFractions}) {
  if (maxFractions != null) return v!.toStringAsFixed(maxFractions);
  return _intFmt.format(v ?? 0);
}

/// 百分比，保留一位
String wsPct(num? ratio) => ratio == null ? '—' : '${(ratio * 100).toStringAsFixed(1)}%';

/// 后端 JSON 取值（值可能是 int/double/String/null）
double wsD(dynamic v, {double fallback = 0}) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v) ?? fallback;
  return fallback;
}

int wsI(dynamic v, {int fallback = 0}) {
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? fallback;
  return fallback;
}

String wsS(dynamic v, {String fallback = ''}) => v == null ? fallback : v.toString();

String wsToday() {
  final now = DateTime.now();
  return '${now.year.toString().padLeft(4, '0')}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
}

String wsMonthStart() {
  final now = DateTime.now();
  return '${now.year.toString().padLeft(4, '0')}-${now.month.toString().padLeft(2, '0')}-01';
}

/// 去掉小数尾零：代发单价那类 4 位小数列用
String wsTrim(num v, {int digits = 4}) {
  String s = v.toStringAsFixed(digits);
  if (!s.contains('.')) return s;
  while (s.endsWith('0')) {
    s = s.substring(0, s.length - 1);
  }
  if (s.endsWith('.')) s = s.substring(0, s.length - 1);
  return s.isEmpty ? '0' : s;
}

// ---------------------------------------------------------------- 页面骨架

/// 页面标题行：标题 + 说明 + 右侧按钮组（对应 web .page-head）。
class DesktopPageHead extends StatelessWidget {
  const DesktopPageHead({
    super.key,
    required this.title,
    this.subtitle,
    this.actions = const [],
    this.trailing,
  });

  final String title;
  final String? subtitle;
  final List<Widget> actions;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontSize: 21,
                    fontWeight: FontWeight.w600,
                    color: dark ? WsTokens.textDark : WsTokens.textLight,
                  ),
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    subtitle!,
                    style: TextStyle(
                        fontSize: 12.5,
                        color: dark ? WsTokens.mutedDark : WsTokens.mutedLight),
                  ),
                ],
              ],
            ),
          ),
          if (actions.isNotEmpty)
            Wrap(spacing: 10, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: actions),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

/// 页面外框：固定内边距 + 最大宽度 + 标题行，body 自己决定滚不滚。
class DesktopPage extends StatelessWidget {
  const DesktopPage({
    super.key,
    required this.title,
    required this.body,
    this.subtitle,
    this.actions = const [],
    this.headBottom = 18,
  });

  final String title;
  final Widget body;
  final String? subtitle;
  final List<Widget> actions;
  final double headBottom;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: WsTokens.contentPadding,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: WsTokens.contentMaxWidth),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DesktopPageHead(title: title, subtitle: subtitle, actions: actions),
              SizedBox(height: headBottom - 18),
              Expanded(child: body),
            ],
          ),
        ),
      ),
    );
  }
}

/// 页面正文的默认滚动容器（表格页想固定表头时可自己换成 Column+Expanded）。
class DesktopScrollBody extends StatelessWidget {
  const DesktopScrollBody({super.key, required this.children, this.bottom = 24});
  final List<Widget> children;
  final double bottom;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [...children, SizedBox(height: bottom)],
      ),
    );
  }
}

/// 筛选条：日期、关键字、下拉等（对应 web .toolbar / .filters）。
class DesktopFilterBar extends StatelessWidget {
  const DesktopFilterBar({super.key, required this.children, this.right});
  final List<Widget> children;
  final Widget? right;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: dark ? WsTokens.cardDark : WsTokens.cardLight,
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
      ),
      child: Wrap(
        spacing: 12,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        alignment: right == null ? WrapAlignment.start : WrapAlignment.spaceBetween,
        children: [
          Wrap(spacing: 12, runSpacing: 12, crossAxisAlignment: WrapCrossAlignment.center, children: children),
          if (right != null) right!,
        ],
      ),
    );
  }
}

/// 「标签: 控件」小组合，横向筛选条里用。
class DesktopLabeled extends StatelessWidget {
  const DesktopLabeled({super.key, required this.label, required this.child});
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label,
            style: TextStyle(
                fontSize: 12.5, color: dark ? WsTokens.textSecondaryDark : WsTokens.textSecondaryLight)),
        const SizedBox(width: 8),
        child,
      ],
    );
  }
}

// ---------------------------------------------------------------- 按钮

enum DesktopButtonKind { normal, primary, success, danger }

class DesktopButton extends StatelessWidget {
  const DesktopButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.kind = DesktopButtonKind.normal,
    this.small = false,
    this.width,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final DesktopButtonKind kind;
  final bool small;
  final double? width;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    final bool enabled = onPressed != null;
    Color bg;
    Color fg;
    Color border;
    switch (kind) {
      case DesktopButtonKind.primary:
        bg = WsTokens.primary;
        fg = Colors.white;
        border = WsTokens.primaryDark;
      case DesktopButtonKind.success:
        bg = WsTokens.green;
        fg = Colors.white;
        border = WsTokens.green;
      case DesktopButtonKind.danger:
        bg = WsTokens.red;
        fg = Colors.white;
        border = WsTokens.red;
      case DesktopButtonKind.normal:
        bg = dark ? WsTokens.cardDark : WsTokens.cardLight;
        fg = dark ? WsTokens.textDark : WsTokens.textLight;
        border = dark ? WsTokens.borderDark : WsTokens.borderLight;
    }
    if (!enabled) {
      bg = bg.withValues(alpha: dark ? 0.35 : 0.45);
      fg = fg.withValues(alpha: 0.55);
    }
    return SizedBox(
      width: width,
      height: small ? 30 : 34,
      child: ElevatedButton(
        onPressed: onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: bg,
          foregroundColor: fg,
          elevation: 0,
          padding: EdgeInsets.symmetric(horizontal: small ? 10 : 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(WsTokens.radius),
            side: BorderSide(color: border),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: small ? 14 : 15),
              const SizedBox(width: 6),
            ],
            Flexible(child: Text(label, style: TextStyle(fontSize: small ? 12 : 13))),
          ],
        ),
      ),
    );
  }
}

class DesktopIconButton extends StatelessWidget {
  const DesktopIconButton({
    super.key,
    required this.icon,
    this.onPressed,
    this.tooltip,
    this.color,
    this.size = 30,
  });

  final IconData icon;
  final VoidCallback? onPressed;
  final String? tooltip;
  final Color? color;
  final double size;

  @override
  Widget build(BuildContext context) {
    final btn = IconButton(
      onPressed: onPressed,
      icon: Icon(icon, size: size * 0.55, color: color),
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: BoxConstraints.tightFor(width: size, height: size),
      style: IconButton.styleFrom(
        backgroundColor: (color ?? WsTokens.primary).withValues(alpha: 0.10),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(WsTokens.radiusSm)),
      ),
    );
    return tooltip == null ? btn : Tooltip(message: tooltip!, child: btn);
  }
}

// ---------------------------------------------------------------- 输入控件

class DesktopTextField extends StatelessWidget {
  const DesktopTextField({
    super.key,
    this.controller,
    this.hintText,
    this.width,
    this.readonly = false,
    this.obscureText = false,
    this.keyboardType,
    this.inputFormatters,
    this.maxLines = 1,
    this.textAlign = TextAlign.start,
    this.onChanged,
    this.onSubmitted,
    this.autofocus = false,
    this.suffix,
  });

  final TextEditingController? controller;
  final String? hintText;
  final double? width;
  final bool readonly;
  final bool obscureText;
  final TextInputType? keyboardType;
  final List<TextInputFormatter>? inputFormatters;
  final int maxLines;
  final TextAlign textAlign;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;
  final Widget? suffix;

  /// 只允许数字（可带一个小数点）；金额、数量输入框用
  static List<TextInputFormatter> decimalOnly = [
    FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
  ];

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return SizedBox(
      width: width,
      child: TextField(
        controller: controller,
        readOnly: readonly,
        obscureText: obscureText,
        keyboardType: keyboardType,
        inputFormatters: inputFormatters,
        maxLines: obscureText ? 1 : maxLines,
        textAlign: textAlign,
        onChanged: onChanged,
        onSubmitted: onSubmitted,
        autofocus: autofocus,
        style: TextStyle(fontSize: 13, color: dark ? WsTokens.textDark : WsTokens.textLight),
        decoration: InputDecoration(
          isDense: true,
          hintText: hintText,
          hintStyle: const TextStyle(fontSize: 13, color: WsTokens.mutedLight),
          suffixIcon: suffix,
          filled: true,
          fillColor: readonly
              ? (dark ? WsTokens.borderDark : WsTokens.borderLighter)
              : (dark ? WsTokens.bgDark : const Color(0xFFFBFBFB)),
          contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(WsTokens.radiusSm),
            borderSide: BorderSide(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(WsTokens.radiusSm),
            borderSide: BorderSide(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(WsTokens.radiusSm),
            borderSide: const BorderSide(color: WsTokens.primary, width: 1.5),
          ),
        ),
      ),
    );
  }
}

class DesktopOption<T> {
  const DesktopOption(this.value, this.label);
  final T value;
  final String label;
}

class DesktopSelect<T> extends StatelessWidget {
  const DesktopSelect({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    this.width,
    this.hint,
    this.itemHeight = 300,
  });

  final T value;
  final List<DesktopOption<T>> options;
  final ValueChanged<T?> onChanged;
  final double? width;
  final String? hint;
  final double itemHeight;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return SizedBox(
      width: width,
      height: 34,
      child: DropdownButtonHideUnderline(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(WsTokens.radiusSm),
            border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
            color: dark ? WsTokens.bgDark : const Color(0xFFFBFBFB),
          ),
          child: DropdownButton<T>(
            value: options.any((o) => o.value == value) ? value : null,
            isExpanded: true,
            hint: Text(hint ?? '请选择', style: const TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
            itemHeight: 36,
            dropdownColor: dark ? WsTokens.cardDark : WsTokens.cardLight,
            menuMaxHeight: itemHeight,
            borderRadius: BorderRadius.circular(WsTokens.radius),
            style: TextStyle(fontSize: 13, color: dark ? WsTokens.textDark : WsTokens.textLight),
            icon: const Icon(Icons.keyboard_arrow_down, size: 18),
            onChanged: onChanged,
            items: [
              for (final o in options)
                DropdownMenuItem<T>(
                  value: o.value,
                  child: Text(o.label, overflow: TextOverflow.ellipsis),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 日期选择（web 的 input[type=date]）：值统一用 YYYY-MM-DD 字符串，空串表示不限。
class DesktopDateField extends StatelessWidget {
  const DesktopDateField({
    super.key,
    required this.value,
    required this.onChanged,
    this.width = 150,
    this.allowClear = true,
    this.firstDate,
    this.lastDate,
  });

  final String value;
  final ValueChanged<String> onChanged;
  final double width;
  final bool allowClear;
  final DateTime? firstDate;
  final DateTime? lastDate;

  static DateTime _parse(String s) {
    final parts = s.split('-');
    if (parts.length != 3) return DateTime.now();
    return DateTime(int.tryParse(parts[0]) ?? 2020, int.tryParse(parts[1]) ?? 1, int.tryParse(parts[2]) ?? 1);
  }

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    final bool cleared = value.isEmpty;
    return GestureDetector(
      onTap: () async {
        if (!cleared && allowClear) {
          // 已有值时先问一句：清空（回到「不限」）还是换一天
          final doClear = await wsConfirm(
            context,
            title: '日期',
            message: '当前是 $value，要清空还是重新选？',
            okLabel: '清空',
            cancelLabel: '重新选',
          );
          if (!doClear) return;
          onChanged('');
          return;
        }
        final picked = await showDatePicker(
          context: context,
          initialDate: cleared ? DateTime.now() : _parse(value),
          firstDate: firstDate ?? DateTime(2020),
          lastDate: lastDate ?? DateTime(2100),
          helpText: '选择日期',
        );
        if (picked != null) {
          onChanged('${picked.year.toString().padLeft(4, '0')}-'
              '${picked.month.toString().padLeft(2, '0')}-'
              '${picked.day.toString().padLeft(2, '0')}');
        }
      },
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: Container(
          width: width,
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: dark ? WsTokens.bgDark : const Color(0xFFFBFBFB),
            borderRadius: BorderRadius.circular(WsTokens.radiusSm),
            border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  cleared ? '不限' : value,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    color: cleared
                        ? WsTokens.mutedLight
                        : (dark ? WsTokens.textDark : WsTokens.textLight),
                  ),
                ),
              ),
              if (!cleared && allowClear)
                GestureDetector(
                  onTap: () => onChanged(''),
                  child: const Icon(Icons.close, size: 14, color: WsTokens.mutedLight),
                )
              else
                const Icon(Icons.event_outlined, size: 15, color: WsTokens.mutedLight),
            ],
          ),
        ),
      ),
    );
  }
}

extension DesktopTapX on Widget {
  /// 给只读控件套一层点击区域（日期 / 可搜索下拉那类自绘控件用）
  Widget withTap(Future<void> Function() onTap) {
    return GestureDetector(onTap: onTap, behavior: HitTestBehavior.deferToChild, child: this);
  }
}

/// 商品 / 分类这类长列表的选择器：弹窗搜索 + 单选。
/// 对应 web 的 .searchable combobox（中文输入法友好）。
class DesktopSearchField extends StatelessWidget {
  const DesktopSearchField({
    super.key,
    required this.title,
    required this.value,
    required this.options,
    required this.onChanged,
    this.width = 220,
    this.hint = '点击选择',
  });

  final String title;
  final String? value;
  final List<DesktopOption<String>> options;
  final ValueChanged<String?> onChanged;
  final double width;
  final String hint;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    String label = hint;
    for (final o in options) {
      if (o.value == value) label = o.label;
    }
    return GestureDetector(
      onTap: () async =>
          onChanged(await desktopSearchSelect(context, title: title, options: options, value: value)),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: Container(
          width: width,
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: dark ? WsTokens.bgDark : const Color(0xFFFBFBFB),
            borderRadius: BorderRadius.circular(WsTokens.radiusSm),
            border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    color: label == hint
                        ? WsTokens.mutedLight
                        : (dark ? WsTokens.textDark : WsTokens.textLight),
                  ),
                ),
              ),
              const Icon(Icons.keyboard_arrow_down, size: 16, color: WsTokens.mutedLight),
            ],
          ),
        ),
      ),
    );
  }
}

Future<String?> desktopSearchSelect(
  BuildContext context, {
  required String title,
  required List<DesktopOption<String>> options,
  String? value,
  String hint = '搜索',
  int maxLines = 400,
}) async {
  final controller = TextEditingController();
  String keyword = '';
  final selected = await showDialog<String>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) {
        final all = options
            .where((o) => keyword.isEmpty || o.label.toLowerCase().contains(keyword.toLowerCase()))
            .toList();
        return AlertDialog(
          title: Text(title, style: const TextStyle(fontSize: 16)),
          content: SizedBox(
            width: 460,
            height: 420,
            child: Column(
              children: [
                DesktopTextField(
                  controller: controller,
                  hintText: hint,
                  autofocus: true,
                  width: 420,
                  onChanged: (v) => setDialogState(() => keyword = v),
                ),
                const SizedBox(height: 12),
                Expanded(
                  child: all.isEmpty
                      ? const Center(child: Text('没有匹配项', style: TextStyle(color: WsTokens.mutedLight)))
                      : ListView.builder(
                          itemCount: all.length > maxLines ? maxLines : all.length,
                          itemBuilder: (_, i) => ListTile(
                            dense: true,
                            visualDensity: VisualDensity.compact,
                            title: Text(all[i].label, style: const TextStyle(fontSize: 13)),
                            trailing: all[i].value == value
                                ? const Icon(Icons.check, size: 16, color: WsTokens.primary)
                                : null,
                            onTap: () => Navigator.of(dialogContext).pop(all[i].value),
                          ),
                        ),
                ),
                if (all.length > maxLines)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text('仅显示前 $maxLines 项，请继续搜索',
                        style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight)),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('取消')),
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, ''),
              child: const Text('清空'),
            ),
          ],
        );
      },
    ),
  );
  controller.dispose();
  return selected;
}

/// 多选下拉（聚水潭分仓目标那类）
class DesktopCheckList<T> extends StatelessWidget {
  const DesktopCheckList({
    super.key,
    required this.options,
    required this.selected,
    required this.onToggle,
    this.height = 170,
    this.width = 300,
  });

  final List<DesktopOption<T>> options;
  final Set<T> selected;
  final void Function(T value, bool on) onToggle;
  final double height;
  final double width;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return SizedBox(
      width: width,
      height: height,
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(WsTokens.radiusSm),
          border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
        ),
        child: ListView(
          children: [
            for (final o in options)
              CheckboxListTile(
                value: selected.contains(o.value),
                onChanged: (v) => onToggle(o.value, v ?? false),
                dense: true,
                visualDensity: VisualDensity.compact,
                controlAffinity: ListTileControlAffinity.leading,
                checkboxShape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.all(Radius.circular(3))),
                title: Text(o.label, style: const TextStyle(fontSize: 12.5)),
              ),
          ],
        ),
      ),
    );
  }
}

/// 付款状态单选：全站只有 paid / unpaid 两态，默认已付款
class DesktopPayRadios extends StatelessWidget {
  const DesktopPayRadios({super.key, required this.value, required this.onChanged});

  final String value;
  final ValueChanged<String> onChanged;

  static const String hint = '待付款：登记后先进「待付款账单」，点「已支付」才计入期间费用';

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _one('已付款', 'paid'),
        const SizedBox(width: 6),
        _one('待付款', 'unpaid'),
      ],
    );
  }

  Widget _one(String label, String v) {
    return ChoiceChip(
      label: Text(label, style: const TextStyle(fontSize: 12)),
      selected: value == v,
      onSelected: (_) => onChanged(v),
      selectedColor: WsTokens.primaryLight,
      labelStyle: TextStyle(color: value == v ? WsTokens.primary : WsTokens.mutedLight),
      visualDensity: VisualDensity.compact,
    );
  }
}

// ---------------------------------------------------------------- 表格

class DesktopCol {
  const DesktopCol(
    this.title, {
    this.width = 120,
    this.sortKey,
    this.right = false,
    this.center = false,
    this.tip,
  });

  final String title;
  final double width;

  /// 非空表示该列可点表头排序（前端排序，和网页端一致）
  final String? sortKey;
  final bool right;
  final bool center;
  final String? tip;

  TextAlign get align => center ? TextAlign.center : (right ? TextAlign.end : TextAlign.start);
}

class DesktopRow {
  const DesktopRow({
    required this.cells,
    this.dim = false,
    this.highlight = false,
    this.onTap,
    this.tag,
  });

  /// 与 cols 等长；缺元素按空字符串渲染
  final List<Widget> cells;

  /// 灰行（已失效 / 已结清）
  final bool dim;

  /// 当前行高亮（如全仓表里的当前分仓）
  final bool highlight;
  final VoidCallback? onTap;

  /// 给外层做 key / 勾选状态用
  final Object? tag;
}

/// 数据表格：1px 边框、行 hover、表头点击排序、可选合计行。
class DesktopGrid extends StatefulWidget {
  const DesktopGrid({
    super.key,
    required this.cols,
    required this.rows,
    this.footer,
    this.sortKey,
    this.sortAsc = false,
    this.onSort,
    this.emptyText = '暂无数据',
    this.rowHeight = 40,
    this.dense = false,
  });

  final List<DesktopCol> cols;
  final List<DesktopRow> rows;

  /// 合计行（tfoot）：与 cols 等长
  final List<String>? footer;
  final String? sortKey;
  final bool sortAsc;
  final void Function(String key)? onSort;
  final String emptyText;
  final double rowHeight;
  final bool dense;

  @override
  State<DesktopGrid> createState() => _DesktopGridState();
}

class _DesktopGridState extends State<DesktopGrid> {
  final Set<Object?> _hovered = {};

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    final double h = widget.dense ? 32 : widget.rowHeight;
    final double total = widget.cols.fold<double>(0, (s, c) => s + c.width);
    final Color border = dark ? WsTokens.borderDark : WsTokens.borderLight;

    Widget cellText(String text, TextAlign align, TextStyle style) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Text(text, textAlign: align, overflow: TextOverflow.ellipsis, style: style),
        );

    Widget headerRow() => Container(
          height: h,
          color: dark ? const Color(0xFF262626) : const Color(0xFFF7F9FC),
          padding: const EdgeInsets.symmetric(vertical: 0),
          child: Row(
            children: [
              for (final c in widget.cols)
                SizedBox(
                  width: c.width,
                  child: MouseRegion(
                    cursor: c.sortKey == null ? MouseCursor.defer : SystemMouseCursors.click,
                    child: GestureDetector(
                      onTap: c.sortKey == null ? null : () => widget.onSort?.call(c.sortKey!),
                      child: Row(
                        mainAxisAlignment: switch (c.align) {
                          TextAlign.end => MainAxisAlignment.end,
                          TextAlign.center => MainAxisAlignment.center,
                          _ => MainAxisAlignment.start,
                        },
                        children: [
                          Flexible(
                            child: Tooltip(
                              message: c.tip ?? c.title,
                              child: Text(
                                c.title,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 12.5,
                                  fontWeight: FontWeight.w600,
                                  color: dark ? WsTokens.textSecondaryDark : WsTokens.textSecondaryLight,
                                ),
                              ),
                            ),
                          ),
                          if (c.sortKey != null && c.sortKey == widget.sortKey)
                            Icon(
                              widget.sortAsc ? Icons.arrow_upward : Icons.arrow_downward,
                              size: 12,
                              color: WsTokens.primary,
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );

    Widget bodyRow(DesktopRow r, int i) {
      final bg = r.highlight
          ? WsTokens.primaryLight.withValues(alpha: dark ? 0.22 : 1)
          : (_hovered.contains(i)
              ? (dark ? const Color(0xFF333333) : const Color(0xFFF5F8FC))
              : Colors.transparent);
      final style = TextStyle(
        fontSize: 13,
        color: r.dim
            ? WsTokens.mutedLight
            : (dark ? WsTokens.textDark : WsTokens.textLight),
      );
      return MouseRegion(
        onEnter: (_) => setState(() => _hovered.add(i)),
        onExit: (_) => setState(() => _hovered.remove(i)),
        child: GestureDetector(
          onTap: r.onTap,
          behavior: HitTestBehavior.opaque,
          child: Container(
            height: h,
            decoration: BoxDecoration(
              color: bg,
              border: Border(bottom: BorderSide(color: border)),
            ),
            child: Row(
              children: [
                for (var k = 0; k < widget.cols.length; k++)
                  SizedBox(
                    width: widget.cols[k].width,
                    child: k < r.cells.length
                        ? Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 10),
                            child: DefaultTextStyle(
                              style: style,
                              child: Align(
                                alignment: switch (widget.cols[k].align) {
                                  TextAlign.end => Alignment.centerRight,
                                  TextAlign.center => Alignment.center,
                                  _ => Alignment.centerLeft,
                                },
                                child: r.cells[k],
                              ),
                            ),
                          )
                        : const SizedBox.shrink(),
                  ),
              ],
            ),
          ),
        ),
      );
    }

    Widget footerRow() => Container(
          height: h,
          color: dark ? const Color(0xFF262626) : const Color(0xFFF7F9FC),
          child: Row(
            children: [
              for (var k = 0; k < widget.cols.length; k++)
                SizedBox(
                  width: widget.cols[k].width,
                  child: cellText(
                    k < (widget.footer?.length ?? 0) ? widget.footer![k] : '',
                    widget.cols[k].align,
                    const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: WsTokens.primary),
                  ),
                ),
            ],
          ),
        );

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: border),
      ),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: SizedBox(
          width: total,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              headerRow(),
              if (widget.rows.isEmpty)
                Container(
                  height: 96,
                  alignment: Alignment.center,
                  color: dark ? WsTokens.cardDark : WsTokens.cardLight,
                  child: Text(widget.emptyText,
                      style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                )
              else
                for (var i = 0; i < widget.rows.length; i++) bodyRow(widget.rows[i], i),
              if (widget.footer != null) footerRow(),
            ],
          ),
        ),
      ),
    );
  }
}

/// 单元格文本快捷构造
Widget wsCell(String text, {Color? color, bool bold = false, String? tip}) {
  final w = Text(
    text,
    overflow: TextOverflow.ellipsis,
    style: TextStyle(fontSize: 13, fontWeight: bold ? FontWeight.w600 : null, color: color),
  );
  return tip == null ? w : Tooltip(message: tip, child: w);
}

/// 状态徽标（web .tag / .badge）
class DesktopTag extends StatelessWidget {
  const DesktopTag(this.text, {super.key, this.color, this.tip});
  final String text;
  final Color? color;
  final String? tip;

  static const Color paid = WsTokens.green;
  static const Color unpaid = WsTokens.amber;
  static const Color off = Color(0xFF969799);
  static const Color income = WsTokens.primary;
  static const Color expense = Color(0xFFF97316);

  @override
  Widget build(BuildContext context) {
    final c = color ?? off;
    final tag = Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(WsTokens.radiusSm),
      ),
      child: Text(text, style: TextStyle(fontSize: 11.5, color: c, fontWeight: FontWeight.w600)),
    );
    return tip == null ? tag : Tooltip(message: tip, child: tag);
  }
}

/// 迷你按钮（表格行内的「编辑 / 删除」）
class DesktopLink extends StatelessWidget {
  const DesktopLink(this.label, {super.key, this.onPressed, this.color});
  final String label;
  final VoidCallback? onPressed;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: color ?? WsTokens.primary,
        padding: const EdgeInsets.symmetric(horizontal: 6),
        visualDensity: VisualDensity.compact,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        minimumSize: Size.zero,
      ),
      child: Text(label, style: const TextStyle(fontSize: 12)),
    );
  }
}

// ---------------------------------------------------------------- 统计卡

class DesktopStatCard extends StatelessWidget {
  const DesktopStatCard({
    super.key,
    required this.label,
    required this.value,
    this.sub,
    this.color,
    this.gradient,
  });

  final String label;
  final String value;
  final String? sub;
  final Color? color;
  final Gradient? gradient;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
      decoration: BoxDecoration(
        color: dark ? WsTokens.cardDark : WsTokens.cardLight,
        gradient: gradient,
        borderRadius: BorderRadius.circular(WsTokens.radiusLg),
        border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
          const SizedBox(height: 8),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              value,
              style: TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w700,
                color: color ?? (dark ? WsTokens.textDark : WsTokens.textLight),
              ),
            ),
          ),
          if (sub != null) ...[
            const SizedBox(height: 5),
            Text(sub!, style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
          ],
        ],
      ),
    );
  }
}

/// 等宽 N 列的统计卡网格（换行时自动按 min 宽度折行）
class DesktopStatGrid extends StatelessWidget {
  const DesktopStatGrid({super.key, required this.children, this.minTileWidth = 210, this.spacing = 14});
  final List<Widget> children;
  final double minTileWidth;
  final double spacing;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      if (children.isEmpty) return const SizedBox.shrink();
      final cross = (c.maxWidth / (minTileWidth + spacing)).ceil().clamp(1, children.length);
      final w = (c.maxWidth - spacing * (cross - 1)) / cross;
      return Wrap(
        spacing: spacing,
        runSpacing: spacing,
        children: [for (final child in children) SizedBox(width: w, child: child)],
      );
    });
  }
}

/// 横向堆叠成本条（报表「成本构成」用，网页端也是 div 宽度百分比画的，不是图表库）
class DesktopStackBar extends StatelessWidget {
  const DesktopStackBar({super.key, required this.parts, this.height = 14});
  final List<({Color color, double value, String label})> parts;
  final double height;

  @override
  Widget build(BuildContext context) {
    final total = parts.fold<double>(0, (s, p) => s + p.value);
    if (total <= 0) return const SizedBox.shrink();
    return ClipRRect(
      borderRadius: BorderRadius.circular(height / 2),
      child: SizedBox(
        height: height,
        child: Row(
          children: [
            for (final p in parts)
              if (p.value > 0)
                Expanded(
                  flex: (p.value / total * 1000).round().clamp(1, 1000),
                  child: Tooltip(message: '${p.label} ${wsMoney(p.value)}', child: Container(color: p.color)),
                ),
          ],
        ),
      ),
    );
  }
}

/// 纯 CSS 柱状图（其他开支按日/按月那类）
class DesktopBars extends StatelessWidget {
  const DesktopBars({
    super.key,
    required this.items,
    this.height = 150,
    this.color = WsTokens.primary,
    this.labelWidth = 74,
  });

  final List<({String label, double value})> items;
  final double height;
  final Color color;
  final double labelWidth;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    final maxV = items.map((e) => e.value).fold<double>(0, (a, b) => a > b ? a : b);
    if (maxV <= 0) return const SizedBox.shrink();
    return SizedBox(
      height: height,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  for (final it in items)
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 3),
                        child: Tooltip(
                          message: '${it.label} · ${wsMoney(it.value)}',
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.end,
                            children: [
                              Container(
                                height: (height - 22) * (it.value / maxV),
                                decoration: BoxDecoration(
                                  color: color.withValues(alpha: it.value <= 0 ? 0.15 : 0.85),
                                  borderRadius: const BorderRadius.vertical(
                                      top: Radius.circular(3)),
                                ),
                              ),
                              const SizedBox(height: 4),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 坐标轴标签行（与 DesktopBars 配对，等分同一批 label）
class DesktopBarLabels extends StatelessWidget {
  const DesktopBarLabels({super.key, required this.labels, this.style});
  final List<String> labels;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (final l in labels)
          Expanded(
            child: Text(
              l,
              textAlign: TextAlign.center,
              overflow: TextOverflow.ellipsis,
              style: style ?? const TextStyle(fontSize: 10.5, color: WsTokens.mutedLight),
            ),
          ),
      ],
    );
  }
}

// ---------------------------------------------------------------- 分页

class DesktopPager extends StatelessWidget {
  const DesktopPager({
    super.key,
    required this.total,
    required this.limit,
    required this.offset,
    required this.onChanged,
    this.unit = '条',
    this.sizes = const [50, 100, 200, 500, 1000],
    this.onLimitChanged,
  });

  final int total;
  final int limit;
  final int offset;
  final void Function(int offset) onChanged;
  final String unit;
  final List<int> sizes;
  final ValueChanged<int>? onLimitChanged;

  @override
  Widget build(BuildContext context) {
    final pages = (total / limit).ceil();
    final current = limit > 0 ? (offset / limit).floor() + 1 : 1;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        children: [
          Text('共 $total $unit · 第 $current / ${pages < 1 ? 1 : pages} 页',
              style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
          const Spacer(),
          if (onLimitChanged != null) ...[
            DesktopLabeled(
              label: '每页',
              child: DesktopSelect<int>(
                width: 84,
                value: limit,
                options: [for (final s in sizes) DesktopOption(s, '$s')],
                onChanged: (v) => onLimitChanged!(v ?? limit),
              ),
            ),
            const SizedBox(width: 12),
          ],
          DesktopIconButton(
            icon: Icons.chevron_left,
            tooltip: '上一页',
            onPressed: current > 1 ? () => onChanged(((current - 2) * limit)) : null,
          ),
          const SizedBox(width: 6),
          DesktopIconButton(
            icon: Icons.chevron_right,
            tooltip: '下一页',
            onPressed: current < pages ? () => onChanged(current * limit) : null,
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- 加载 / 空 / 错误

/// 数据页三态壳：加载中转圈、失败给重试按钮、成功渲染 child
class DesktopStateView extends StatelessWidget {
  const DesktopStateView({
    super.key,
    required this.child,
    this.loading = false,
    this.error,
    this.onRetry,
    this.loadingText,
  });

  final Widget child;
  final bool loading;
  final Object? error;
  final VoidCallback? onRetry;
  final String? loadingText;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4)),
            if (loadingText != null) ...[
              const SizedBox(height: 10),
              Text(loadingText!, style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
            ],
          ],
        ),
      );
    }
    if (error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_outlined, size: 32, color: WsTokens.mutedLight),
            const SizedBox(height: 10),
            Text('$error', style: const TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
            const SizedBox(height: 10),
            DesktopButton(label: '重试', icon: Icons.refresh, onPressed: onRetry),
          ],
        ),
      );
    }
    return child;
  }
}

/// 页内提示条（web .alert）
class DesktopNotice extends StatelessWidget {
  const DesktopNotice(this.text, {super.key, this.kind = DesktopNoticeKind.info});
  final String text;
  final DesktopNoticeKind kind;

  @override
  Widget build(BuildContext context) {
    late final Color fg;
    late final Color bg;
    late final IconData icon;
    switch (kind) {
      case DesktopNoticeKind.info:
        fg = WsTokens.primary;
        bg = WsTokens.primaryLight;
        icon = Icons.info_outline;
      case DesktopNoticeKind.success:
        fg = WsTokens.green;
        bg = WsTokens.greenLight;
        icon = Icons.check_circle_outline;
      case DesktopNoticeKind.warn:
        fg = const Color(0xFF8A5A00);
        bg = WsTokens.amberLight;
        icon = Icons.warning_amber;
      case DesktopNoticeKind.error:
        fg = WsTokens.red;
        bg = WsTokens.redLight;
        icon = Icons.error_outline;
    }
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: bg.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: fg.withValues(alpha: 0.25)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: fg),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: TextStyle(fontSize: 12.5, color: fg, height: 1.5))),
        ],
      ),
    );
  }
}

enum DesktopNoticeKind { info, success, warn, error }

// ---------------------------------------------------------------- 分段 Tab

/// 分组 Tab（对应 web .seg）：库存 4 个子页、报表 4 个分区都用它
class DesktopTabs extends StatelessWidget {
  const DesktopTabs({super.key, required this.items, required this.index, required this.onChanged, this.small = false});

  final List<String> items;
  final int index;
  final ValueChanged<int> onChanged;
  final bool small;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: dark ? WsTokens.borderDark : WsTokens.borderLighter,
        borderRadius: BorderRadius.circular(WsTokens.radius),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < items.length; i++)
            Padding(
              padding: const EdgeInsets.only(right: 3),
              child: Material(
                color: i == index
                    ? (dark ? WsTokens.cardDark : WsTokens.cardLight)
                    : Colors.transparent,
                borderRadius: BorderRadius.circular(WsTokens.radiusSm),
                child: InkWell(
                  borderRadius: BorderRadius.circular(WsTokens.radiusSm),
                  onTap: () => onChanged(i),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 140),
                    padding: EdgeInsets.symmetric(horizontal: small ? 10 : 14, vertical: small ? 5 : 7),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(WsTokens.radiusSm),
                      border: Border.all(
                        color: i == index
                            ? WsTokens.primary.withValues(alpha: 0.35)
                            : Colors.transparent,
                      ),
                    ),
                    child: Text(
                      items[i],
                      style: TextStyle(
                        fontSize: small ? 12 : 13,
                        fontWeight: i == index ? FontWeight.w600 : FontWeight.w400,
                        color: i == index
                            ? WsTokens.primary
                            : (dark ? WsTokens.textSecondaryDark : WsTokens.textSecondaryLight),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- 弹窗

/// 通用弹窗：标题 + 主体 + 底部按钮，宽表用 900，普通表单 480
Future<T?> desktopDialog<T>(
  BuildContext context, {
  required String title,
  required Widget Function(BuildContext context) builder,
  double width = 480,
  double maxHeight = 720,
  List<Widget> actions = const [],
  VoidCallback? onSubmit,
  String? submitLabel,
}) {
  final dark = wsIsDark(context);
  return showDialog<T>(
    context: context,
    builder: (dialogContext) => Dialog(
      backgroundColor: dark ? WsTokens.cardDark : WsTokens.cardLight,
      insetPadding: const EdgeInsets.all(28),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(WsTokens.radiusLg)),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: width, maxHeight: maxHeight),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 18, 22, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(title,
                        style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: dark ? WsTokens.textDark : WsTokens.textLight)),
                  ),
                  DesktopIconButton(
                    icon: Icons.close,
                    color: WsTokens.mutedLight,
                    tooltip: '关闭',
                    onPressed: () => Navigator.of(dialogContext).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Flexible(child: SingleChildScrollView(child: builder(dialogContext))),
              if (actions.isNotEmpty || submitLabel != null) ...[
                const SizedBox(height: 16),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    ...actions,
                    if (submitLabel != null) ...[
                      const SizedBox(width: 10),
                      DesktopButton(
                        label: submitLabel,
                        kind: DesktopButtonKind.primary,
                        onPressed: onSubmit,
                      ),
                    ],
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );
}

/// 表单弹窗里的一行：右侧控件区、左侧标签（必填带 *）
class DesktopFormRow extends StatelessWidget {
  const DesktopFormRow({
    super.key,
    required this.label,
    required this.child,
    this.required = false,
    this.tip,
    this.width = 250,
  });

  final String label;
  final Widget child;
  final bool required;
  final String? tip;
  final double width;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 96,
            child: Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                required ? '$label *' : label,
                textAlign: TextAlign.right,
                style: TextStyle(
                  fontSize: 12.5,
                  color: required
                      ? WsTokens.primary
                      : (dark ? WsTokens.textSecondaryDark : WsTokens.textSecondaryLight),
                ),
              ),
            ),
          ),
          const SizedBox(width: 12),
          SizedBox(width: width, child: child),
          if (tip != null) ...[
            const SizedBox(width: 10),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(tip!,
                    style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.4)),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 两段式确认（web 的 confirm），返回 true 表示用户点了确定
Future<bool> wsConfirm(
  BuildContext context, {
  required String title,
  required String message,
  String okLabel = '确定',
  String cancelLabel = '取消',
  bool danger = false,
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title, style: const TextStyle(fontSize: 15.5)),
      content: SizedBox(
        width: 420,
        child: Text(message, style: const TextStyle(fontSize: 13, height: 1.6)),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: Text(cancelLabel)),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: danger ? WsTokens.red : WsTokens.primary,
          ),
          onPressed: () => Navigator.pop(dialogContext, true),
          child: Text(okLabel),
        ),
      ],
    ),
  );
  return result ?? false;
}

/// 轻提示（web toast）。桌面端用 SnackBar，底部右侧出现，不打断操作。
void wsToast(BuildContext context, String message, {bool error = false}) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  if (messenger == null) return;
  messenger.clearSnackBars();
  messenger.showSnackBar(
    SnackBar(
      content: Text(message, style: const TextStyle(fontSize: 13)),
      behavior: SnackBarBehavior.floating,
      width: 420,
      backgroundColor: error ? WsTokens.red : const Color(0xFF2B2B2B),
      duration: Duration(milliseconds: error ? 3200 : 2200),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(WsTokens.radius)),
    ),
  );
}

/// 复制一段文本（备份远程脚本、导入 JSON 那类）
Future<void> wsCopy(BuildContext context, String text) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (context.mounted) wsToast(context, '已复制到剪贴板');
}
