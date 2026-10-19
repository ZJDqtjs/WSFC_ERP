import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../desktop_style.dart';
import 'desktop_motion.dart';

/// 桌面端通用控件层：页面骨架 / 表格 / 筛选条 / 弹窗表单 / 提示语。
///
/// 观感语言只有三种表面，按"离用户视线多远"分工：
/// - 玻璃（[kGlassSoft]）：壳层，导航条 / 工具条 / 弹层，整屏同时不超过三四个；
/// - 半透明雾面（[WsTokens.fill]）：卡片、筛选条、表格容器，数量多但不吃 shader；
/// - 品牌色实底：主按钮、选中态、强调条。
/// 各业务页不直接碰这三层，只组合这里的原语，所以改这里等于改全部页面。

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
String wsPct(num? ratio) =>
    ratio == null ? '—' : '${(ratio * 100).toStringAsFixed(1)}%';

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

String wsS(dynamic v, {String fallback = ''}) =>
    v == null ? fallback : v.toString();

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

/// 页面标题行：标题 + 说明 + 右侧按钮组。
///
/// 工具条已经写了「分组 › 页面」，这里再摆一行 21px 大标题纯属重复占高度，
/// 所以改成一行紧凑排布：标题 + 同行淡色说明，动作按钮靠右垂直居中。
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
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Flexible(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Flexible(
                  child: Text(
                    title,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.2,
                      color: WsTokens.inkOf(context),
                    ),
                  ),
                ),
                if (subtitle != null) ...[
                  const SizedBox(width: 10),
                  Flexible(
                    child: Text(
                      subtitle!,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 12.5,
                          color: WsTokens.inkOf(context, level: 3)),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          if (actions.isNotEmpty)
            Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: actions),
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
              DesktopPageHead(
                  title: title, subtitle: subtitle, actions: actions),
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
  const DesktopScrollBody(
      {super.key, required this.children, this.bottom = 24});
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

/// 筛选条：日期、关键字、下拉等。
/// 用雾面而不是玻璃——筛选条里全是输入框和下拉，再叠一层折射只会让文字发虚。
class DesktopFilterBar extends StatelessWidget {
  const DesktopFilterBar({super.key, required this.children, this.right});
  final List<Widget> children;
  final Widget? right;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: WsTokens.fill(context, alpha: 0.74),
        borderRadius: BorderRadius.circular(WsTokens.radiusLg),
        border: Border.all(color: WsTokens.line(context, alpha: 0.8)),
      ),
      child: Wrap(
        spacing: 12,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        alignment:
            right == null ? WrapAlignment.start : WrapAlignment.spaceBetween,
        children: [
          Wrap(
              spacing: 12,
              runSpacing: 12,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: children),
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
                fontSize: 12.5,
                color: dark
                    ? WsTokens.textSecondaryDark
                    : WsTokens.textSecondaryLight)),
        const SizedBox(width: 8),
        child,
      ],
    );
  }
}

// ---------------------------------------------------------------- 按钮

enum DesktopButtonKind { normal, primary, success, danger }

class DesktopButton extends StatefulWidget {
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
  State<DesktopButton> createState() => _DesktopButtonState();
}

class _DesktopButtonState extends State<DesktopButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final bool dark = wsIsDark(context);
    final bool enabled = widget.onPressed != null;
    Color bg;
    Color fg;
    Color border;
    switch (widget.kind) {
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
        bg = WsTokens.fill(context, alpha: dark ? 0.9 : 0.86);
        fg = WsTokens.inkOf(context);
        border = WsTokens.line(context, alpha: 0.95);
    }
    // 桌面端鼠标停留时间比点击间隔长得多，hover 必须有反馈，否则按钮看着像死的
    if (enabled && _hover) bg = Color.lerp(bg, fg, dark ? 0.16 : 0.07)!;
    if (!enabled) {
      bg = bg.withValues(alpha: dark ? 0.35 : 0.45);
      fg = fg.withValues(alpha: 0.55);
    }
    final bool colored = widget.kind != DesktopButtonKind.normal;
    return SizedBox(
      width: widget.width,
      height: widget.small ? 30 : 34,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        onEnter: enabled ? (_) => setState(() => _hover = true) : null,
        onExit: enabled ? (_) => setState(() => _hover = false) : null,
        child: ElevatedButton(
          onPressed: widget.onPressed,
          style: ElevatedButton.styleFrom(
            backgroundColor: bg,
            foregroundColor: fg,
            // 实底按钮给一点投影浮起来，描边只留给普通按钮
            elevation: colored && enabled ? (_hover ? 3 : 1.5) : 0,
            shadowColor: bg.withValues(alpha: 0.4),
            padding: EdgeInsets.symmetric(horizontal: widget.small ? 10 : 14),
            animationDuration: Dm.quick,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(WsTokens.radius),
              side: BorderSide(color: border),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (widget.icon != null) ...[
                Icon(widget.icon, size: widget.small ? 14 : 15),
                const SizedBox(width: 6),
              ],
              Flexible(
                  child: Text(widget.label,
                      style: TextStyle(
                          fontSize: widget.small ? 12 : 13,
                          fontWeight: colored ? FontWeight.w600 : null))),
            ],
          ),
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
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(WsTokens.radiusSm)),
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
        cursorColor: WsTokens.primary,
        style: TextStyle(fontSize: 13, color: WsTokens.inkOf(context)),
        decoration: InputDecoration(
          isDense: true,
          hintText: hintText,
          hintStyle:
              TextStyle(fontSize: 13, color: WsTokens.inkOf(context, level: 3)),
          suffixIcon: suffix,
          filled: true,
          fillColor: readonly
              ? WsTokens.line(context, alpha: 0.55)
              : WsTokens.fill(context, alpha: 0.92),
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(WsTokens.radius),
            borderSide: BorderSide(color: WsTokens.line(context)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(WsTokens.radius),
            borderSide: BorderSide(color: WsTokens.line(context)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(WsTokens.radius),
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
            borderRadius: BorderRadius.circular(WsTokens.radius),
            border: Border.all(color: WsTokens.line(context)),
            color: WsTokens.fill(context, alpha: 0.92),
          ),
          child: DropdownButton<T>(
            value: options.any((o) => o.value == value) ? value : null,
            isExpanded: true,
            hint: Text(hint ?? '请选择',
                style:
                    const TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
            itemHeight: 36,
            dropdownColor: dark ? WsTokens.cardDark : WsTokens.cardLight,
            menuMaxHeight: itemHeight,
            borderRadius: BorderRadius.circular(WsTokens.radius),
            style: TextStyle(
                fontSize: 13,
                color: dark ? WsTokens.textDark : WsTokens.textLight),
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
    return DateTime(int.tryParse(parts[0]) ?? 2020, int.tryParse(parts[1]) ?? 1,
        int.tryParse(parts[2]) ?? 1);
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
            color: WsTokens.fill(context, alpha: 0.92),
            borderRadius: BorderRadius.circular(WsTokens.radius),
            border: Border.all(color: WsTokens.line(context)),
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
                  child: const Icon(Icons.close,
                      size: 14, color: WsTokens.mutedLight),
                )
              else
                const Icon(Icons.event_outlined,
                    size: 15, color: WsTokens.mutedLight),
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
    return GestureDetector(
        onTap: onTap, behavior: HitTestBehavior.deferToChild, child: this);
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
      onTap: () async => onChanged(await desktopSearchSelect(context,
          title: title, options: options, value: value)),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: Container(
          width: width,
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: WsTokens.fill(context, alpha: 0.92),
            borderRadius: BorderRadius.circular(WsTokens.radius),
            border: Border.all(color: WsTokens.line(context)),
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
              const Icon(Icons.keyboard_arrow_down,
                  size: 16, color: WsTokens.mutedLight),
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
            .where((o) =>
                keyword.isEmpty ||
                o.label.toLowerCase().contains(keyword.toLowerCase()))
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
                      ? const Center(
                          child: Text('没有匹配项',
                              style: TextStyle(color: WsTokens.mutedLight)))
                      : ListView.builder(
                          itemCount:
                              all.length > maxLines ? maxLines : all.length,
                          itemBuilder: (_, i) => ListTile(
                            dense: true,
                            visualDensity: VisualDensity.compact,
                            title: Text(all[i].label,
                                style: const TextStyle(fontSize: 13)),
                            trailing: all[i].value == value
                                ? const Icon(Icons.check,
                                    size: 16, color: WsTokens.primary)
                                : null,
                            onTap: () =>
                                Navigator.of(dialogContext).pop(all[i].value),
                          ),
                        ),
                ),
                if (all.length > maxLines)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text('仅显示前 $maxLines 项，请继续搜索',
                        style: const TextStyle(
                            fontSize: 11, color: WsTokens.mutedLight)),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: const Text('取消')),
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
          border: Border.all(
              color: dark ? WsTokens.borderDark : WsTokens.borderLight),
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
  const DesktopPayRadios(
      {super.key, required this.value, required this.onChanged});

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
      labelStyle:
          TextStyle(color: value == v ? WsTokens.primary : WsTokens.mutedLight),
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

  TextAlign get align =>
      center ? TextAlign.center : (right ? TextAlign.end : TextAlign.start);
}

class DesktopRow {
  const DesktopRow({
    required this.cells,
    this.dim = false,
    this.highlight = false,
    this.onTap,
    this.tag,
    this.span,
  });

  /// 与 cols 等长；缺元素按空字符串渲染
  final List<Widget> cells;

  /// 非空则整行合并成一块自定义面板（批次展开的聚合明细这类），
  /// 不受 cols 宽度和行高约束，也不参与 hover。
  final Widget? span;

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
    final double h = widget.dense ? 32 : widget.rowHeight;
    final double total = widget.cols.fold<double>(0, (s, c) => s + c.width);
    final Color border = WsTokens.line(context, alpha: 0.7);

    Widget cellText(String text, TextAlign align, TextStyle style) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Text(text,
              textAlign: align, overflow: TextOverflow.ellipsis, style: style),
        );

    Widget headerRow() => Container(
          height: h + 2,
          decoration: BoxDecoration(
            color: WsTokens.primary
                .withValues(alpha: wsIsDark(context) ? 0.16 : 0.055),
            border: Border(
                bottom: BorderSide(color: WsTokens.line(context, alpha: 0.95))),
          ),
          padding: const EdgeInsets.symmetric(vertical: 0),
          child: Row(
            children: [
              for (final c in widget.cols)
                SizedBox(
                  width: c.width,
                  child: MouseRegion(
                    cursor: c.sortKey == null
                        ? MouseCursor.defer
                        : SystemMouseCursors.click,
                    child: GestureDetector(
                      onTap: c.sortKey == null
                          ? null
                          : () => widget.onSort?.call(c.sortKey!),
                      child: Padding(
                        // 表头也要和正文一样留 10px 横向内边距：不留的话
                        // 「金额」这类右对齐表头会紧贴下一列的左对齐表头，看着像挤成一列
                        padding: const EdgeInsets.symmetric(horizontal: 10),
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
                                    fontSize: 12,
                                    fontWeight: FontWeight.w600,
                                    letterSpacing: 0.2,
                                    color: WsTokens.inkOf(context, level: 2),
                                  ),
                                ),
                              ),
                            ),
                            if (c.sortKey != null && c.sortKey == widget.sortKey)
                              Icon(
                                widget.sortAsc
                                    ? Icons.arrow_upward
                                    : Icons.arrow_downward,
                                size: 12,
                                color: WsTokens.primary,
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );

    Widget bodyRow(DesktopRow r, int i) {
      final bool dark = wsIsDark(context);
      if (r.span case final Widget panel) {
        return Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 16),
          decoration: BoxDecoration(
            color: WsTokens.primary.withValues(alpha: dark ? 0.07 : 0.028),
            border: Border(bottom: BorderSide(color: border)),
          ),
          child: panel,
        );
      }
      final bg = r.highlight
          ? WsTokens.primary.withValues(alpha: dark ? 0.2 : 0.09)
          : (_hovered.contains(i)
              ? WsTokens.primary.withValues(alpha: dark ? 0.1 : 0.045)
              : Colors.transparent);
      final style = TextStyle(
        fontSize: 13,
        color:
            r.dim ? WsTokens.inkOf(context, level: 3) : WsTokens.inkOf(context),
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
          decoration: BoxDecoration(
            color: WsTokens.primary
                .withValues(alpha: wsIsDark(context) ? 0.2 : 0.075),
            border: Border(
                top: BorderSide(color: WsTokens.line(context, alpha: 0.95))),
          ),
          child: Row(
            children: [
              for (var k = 0; k < widget.cols.length; k++)
                SizedBox(
                  width: widget.cols[k].width,
                  child: cellText(
                    k < (widget.footer?.length ?? 0) ? widget.footer![k] : '',
                    widget.cols[k].align,
                    const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: WsTokens.primary),
                  ),
                ),
            ],
          ),
        );

    return Container(
      decoration: BoxDecoration(
        color: WsTokens.fill(context, alpha: 0.8),
        borderRadius: BorderRadius.circular(WsTokens.radiusLg),
        border: Border.all(color: WsTokens.line(context, alpha: 0.9)),
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
                  color: Colors.transparent,
                  child: Text(widget.emptyText,
                      style: TextStyle(
                          fontSize: 12.5,
                          color: WsTokens.inkOf(context, level: 3))),
                )
              else
                for (var i = 0; i < widget.rows.length; i++)
                  bodyRow(widget.rows[i], i),
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
    style: TextStyle(
        fontSize: 13, fontWeight: bold ? FontWeight.w600 : null, color: color),
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
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: c.withValues(alpha: 0.24)),
      ),
      child: Text(text,
          style:
              TextStyle(fontSize: 11.5, color: c, fontWeight: FontWeight.w600)),
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

/// 指标卡。桌面端一屏能摆 6-8 张，所以做得很紧凑：
/// 数值用等宽数字（fontFeatures tabularFigures），刷新时数字不会左右抖。
class DesktopStatCard extends StatelessWidget {
  const DesktopStatCard({
    super.key,
    required this.label,
    required this.value,
    this.sub,
    this.color,
    this.gradient,
    this.icon,
    this.onTap,
  });

  final String label;
  final String value;
  final String? sub;
  final Color? color;
  final Gradient? gradient;
  final IconData? icon;

  /// 点击整张卡跳到对应页面（工作台常用：点「今日出库」进出库页）
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final Color tint = color ?? WsTokens.primary;
    final Widget body = Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
      decoration: BoxDecoration(
        color: gradient != null ? null : WsTokens.fill(context, alpha: 0.8),
        gradient: gradient,
        borderRadius: BorderRadius.circular(WsTokens.radiusLg),
        border: Border.all(color: WsTokens.line(context, alpha: 0.8)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (icon != null) ...[
            Container(
              width: 38,
              height: 38,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: tint.withValues(alpha: 0.13),
                borderRadius: BorderRadius.circular(WsTokens.radius),
              ),
              child: Icon(icon, size: 19, color: tint),
            ),
            const SizedBox(width: 13),
          ],
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 12.5,
                        color: WsTokens.inkOf(context, level: 3))),
                const SizedBox(height: 4),
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(
                    value,
                    style: TextStyle(
                      fontSize: 22,
                      height: 1.15,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.4,
                      color: color ?? WsTokens.inkOf(context),
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ),
                if (sub != null) ...[
                  const SizedBox(height: 3),
                  Text(sub!,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 11.5,
                          color: WsTokens.inkOf(context, level: 3))),
                ],
              ],
            ),
          ),
        ],
      ),
    );
    if (onTap == null) return body;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
          onTap: onTap, behavior: HitTestBehavior.opaque, child: body),
    );
  }
}

/// 等宽 N 列的统计卡网格（换行时自动按 min 宽度折行）
class DesktopStatGrid extends StatelessWidget {
  const DesktopStatGrid(
      {super.key,
      required this.children,
      this.minTileWidth = 210,
      this.spacing = 14});
  final List<Widget> children;
  final double minTileWidth;
  final double spacing;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      if (children.isEmpty) return const SizedBox.shrink();
      final cross = (c.maxWidth / (minTileWidth + spacing))
          .ceil()
          .clamp(1, children.length);
      final w = (c.maxWidth - spacing * (cross - 1)) / cross;
      return Wrap(
        spacing: spacing,
        runSpacing: spacing,
        children: [
          for (final child in children) SizedBox(width: w, child: child)
        ],
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
                  child: Tooltip(
                      message: '${p.label} ${wsMoney(p.value)}',
                      child: Container(color: p.color)),
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
    final maxV =
        items.map((e) => e.value).fold<double>(0, (a, b) => a > b ? a : b);
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
                                  color: color.withValues(
                                      alpha: it.value <= 0 ? 0.15 : 0.85),
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
              style: style ??
                  const TextStyle(fontSize: 10.5, color: WsTokens.mutedLight),
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
              style:
                  const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
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
            onPressed:
                current > 1 ? () => onChanged(((current - 2) * limit)) : null,
          ),
          const SizedBox(width: 6),
          DesktopIconButton(
            icon: Icons.chevron_right,
            tooltip: '下一页',
            onPressed:
                current < pages ? () => onChanged(current * limit) : null,
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
            const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2.4)),
            if (loadingText != null) ...[
              const SizedBox(height: 10),
              Text(loadingText!,
                  style: const TextStyle(
                      fontSize: 12.5, color: WsTokens.mutedLight)),
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
            const Icon(Icons.cloud_off_outlined,
                size: 32, color: WsTokens.mutedLight),
            const SizedBox(height: 10),
            Text('$error',
                style:
                    const TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
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
  const DesktopNotice(this.text,
      {super.key, this.kind = DesktopNoticeKind.info});
  final String text;
  final DesktopNoticeKind kind;

  @override
  Widget build(BuildContext context) {
    late final Color tone;
    late final IconData icon;
    switch (kind) {
      case DesktopNoticeKind.info:
        tone = WsTokens.primary;
        icon = Icons.info_outline;
      case DesktopNoticeKind.success:
        tone = WsTokens.green;
        icon = Icons.check_circle_outline;
      case DesktopNoticeKind.warn:
        tone = WsTokens.amber;
        icon = Icons.warning_amber;
      case DesktopNoticeKind.error:
        tone = WsTokens.red;
        icon = Icons.error_outline;
    }
    // 淡色底 + 同色系描边比"贴一张浅黄块"更稳：暗色主题下浅黄块直接把文字吃掉
    final bool dark = wsIsDark(context);
    final Color fg = dark ? Color.lerp(tone, Colors.white, 0.35)! : tone;
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: dark ? 0.16 : 0.08),
        borderRadius: BorderRadius.circular(WsTokens.radiusLg),
        border: Border.all(color: tone.withValues(alpha: 0.28)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: fg),
          const SizedBox(width: 8),
          Expanded(
              child: Text(text,
                  style: TextStyle(fontSize: 12.5, color: fg, height: 1.5))),
        ],
      ),
    );
  }
}

enum DesktopNoticeKind { info, success, warn, error }

// ---------------------------------------------------------------- 分段 Tab

/// 分段 Tab：库存 4 个子页、报表 4 个分区都用它。
/// 玻璃轨道 + 品牌色滑块，选中态一眼可见。
class DesktopTabs extends StatelessWidget {
  const DesktopTabs(
      {super.key,
      required this.items,
      required this.index,
      required this.onChanged,
      this.small = false});

  final List<String> items;
  final int index;
  final ValueChanged<int> onChanged;
  final bool small;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: WsTokens.fill(context, alpha: 0.6),
        borderRadius: BorderRadius.circular(WsTokens.radiusLg),
        border: Border.all(color: WsTokens.line(context, alpha: 0.8)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < items.length; i++)
            Padding(
              padding: const EdgeInsets.only(right: 3),
              child: Material(
                color: i == index
                    ? WsTokens.primary
                        .withValues(alpha: wsIsDark(context) ? 0.28 : 0.1)
                    : Colors.transparent,
                borderRadius: BorderRadius.circular(WsTokens.radius),
                child: InkWell(
                  borderRadius: BorderRadius.circular(WsTokens.radius),
                  onTap: () => onChanged(i),
                  child: AnimatedContainer(
                    duration: Dm.quick,
                    curve: Dm.curve,
                    padding: EdgeInsets.symmetric(
                        horizontal: small ? 11 : 15, vertical: small ? 5 : 7),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(WsTokens.radius),
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
                        fontWeight:
                            i == index ? FontWeight.w600 : FontWeight.w400,
                        color: i == index
                            ? WsTokens.primary
                            : WsTokens.inkOf(context, level: 2),
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

/// 通用弹窗：标题 + 主体 + 底部按钮，宽表用 900，普通表单 480。
/// 弹层是「暂时盖住工作台」的东西，用玻璃正好——背后的内容若隐若现，
/// 用户知道关掉之后会回到哪里。用雾面（[kGlassSoft]）不折射，
/// 因为弹窗里全是表单文字，折射会把笔画拉糊。
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
  return showDialog<T>(
    context: context,
    builder: (dialogContext) => Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.all(28),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: width, maxHeight: maxHeight),
        child: GlassContainer(
          settings: kGlassSoft,
          shape: const LiquidRoundedSuperellipse(borderRadius: 20),
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
                            color: WsTokens.inkOf(dialogContext))),
                  ),
                  DesktopIconButton(
                    icon: Icons.close,
                    color: WsTokens.inkOf(dialogContext, level: 3),
                    tooltip: '关闭',
                    onPressed: () => Navigator.of(dialogContext).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Divider(
                  height: 1,
                  thickness: 1,
                  color: WsTokens.line(dialogContext, alpha: 0.7)),
              const SizedBox(height: 14),
              Flexible(
                  child: SingleChildScrollView(child: builder(dialogContext))),
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
                      : (dark
                          ? WsTokens.textSecondaryDark
                          : WsTokens.textSecondaryLight),
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
                    style: const TextStyle(
                        fontSize: 11.5,
                        color: WsTokens.mutedLight,
                        height: 1.4)),
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
    builder: (dialogContext) => Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      child: GlassContainer(
        settings: kGlassSoft,
        shape: const LiquidRoundedSuperellipse(borderRadius: 20),
        padding: const EdgeInsets.fromLTRB(22, 20, 20, 16),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    danger ? Icons.delete_forever_outlined : Icons.help_outline,
                    size: 19,
                    color: danger ? WsTokens.red : WsTokens.primary,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(title,
                        style: TextStyle(
                            fontSize: 15.5,
                            fontWeight: FontWeight.w600,
                            color: WsTokens.inkOf(dialogContext))),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(message,
                  style: TextStyle(
                      fontSize: 13,
                      height: 1.6,
                      color: WsTokens.inkOf(dialogContext, level: 2))),
              const SizedBox(height: 18),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  DesktopButton(
                      label: cancelLabel,
                      onPressed: () => Navigator.pop(dialogContext, false)),
                  const SizedBox(width: 10),
                  DesktopButton(
                    label: okLabel,
                    kind: danger
                        ? DesktopButtonKind.danger
                        : DesktopButtonKind.primary,
                    onPressed: () => Navigator.pop(dialogContext, true),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
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
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WsTokens.radius)),
    ),
  );
}

/// 复制一段文本（备份远程脚本、导入 JSON 那类）
Future<void> wsCopy(BuildContext context, String text) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (context.mounted) wsToast(context, '已复制到剪贴板');
}
