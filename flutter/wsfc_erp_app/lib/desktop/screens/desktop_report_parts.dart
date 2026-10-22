import 'package:flutter/material.dart';

import '../desktop_style.dart';
import '../widgets/desktop_ui.dart';

/// 桌面端「财务报表」页专用的私有部件（[DesktopReportScreen] 拆分出来的部分）。
///
/// 这里只放报表这一页要用的东西：成本/费用构成的行模型、支出下钻弹窗、
/// 手动记账表单，以及几个表格单元格里的小字组合。
/// 网页端真源：web/static/app.js 的 renderCostBreakdown / openExpDrill / openFinanceModal。

/// 逐笔支出的来源色（网页端 REP_EXP_SRC_COLORS）
const Map<String, Color> kReportExpSrcColors = {
  '采购': Color(0xFF1989FA),
  '其他开支': Color(0xFFF97316),
  '手工记账': Color(0xFF6366F1),
  '刷单成本': Color(0xFFE11D48),
};

/// 收入 / 支出（含毛利、净利）的正负色
const Color kReportIncome = Color(0xFF07C160);
const Color kReportExpense = Color(0xFFD13438);

/// 成本构成里的一类颜色（网页端 renderCostBreakdown 的 COLORS）
const Map<String, Color> kReportCostColors = {
  '包材耗材': Color(0xFFFF976A),
  '人工打包费': Color(0xFF7232DD),
  '快递运费': Color(0xFF07C160),
  '其他关联结算': Color(0xFF969799),
  '刷单成本': Color(0xFFEE0A24),
  '入仓运费': Color(0xFF00B8D9),
  '入仓包材': Color(0xFFFFC400),
};

Color kReportCostColorOf(String name) =>
    kReportCostColors[name] ?? const Color(0xFF969799);

/// 成本构成 / 费用清单里的一条（名称 + 金额 + 颜色 + 徽标 + 说明）
class ReportCostItem {
  const ReportCostItem({
    required this.name,
    required this.value,
    required this.color,
    this.tag = '',
    this.desc = '',
    this.source = '',
  });

  final String name;
  final double value;
  final Color color;

  /// 行尾徽标：自动结算 / 入仓 / 放单仓
  final String tag;

  /// 「说明」列文案（成本构成表用）
  final String desc;

  /// 「来源」列文案（期间费用构成表用：其他开支 / 手工记账）
  final String source;
}

/// 色点（网页端 .cost-dot）：成本 / 费用表里标记来源
class ReportColorDot extends StatelessWidget {
  const ReportColorDot(this.color, {super.key});
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        width: 9,
        height: 9,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      );
}

/// 表格单元格：主文本 + 一行灰色小字（网页 td 里那个 `<div class="muted">`）
class ReportStackedCell extends StatelessWidget {
  const ReportStackedCell({
    super.key,
    required this.main,
    this.sub,
    this.color,
    this.bold = false,
    this.subColor,
    this.maxLines = 2,
  });

  final String main;
  final String? sub;
  final Color? color;
  final bool bold;

  /// 小字颜色（下钻/代收那类带语义的用色，默认灰）
  final Color? subColor;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          main,
          maxLines: maxLines,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 12.5,
            height: 1.25,
            fontWeight: bold ? FontWeight.w600 : null,
            color: color ?? (dark ? WsTokens.textDark : WsTokens.textLight),
          ),
        ),
        if (sub != null && sub!.isNotEmpty)
          Text(
            sub!,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 11,
              height: 1.25,
              color: subColor ?? (dark ? WsTokens.mutedDark : WsTokens.mutedLight),
            ),
          ),
      ],
    );
  }
}

/// 右对齐的「主数字 + 小字」单元格（金额列用）
class ReportMoneyCell extends StatelessWidget {
  const ReportMoneyCell({
    super.key,
    required this.text,
    this.sub,
    this.color,
    this.bold = false,
    this.onTap,
    this.tip,
  });

  final String text;
  final String? sub;
  final Color? color;
  final bool bold;

  /// 非空表示可点（网页端 .exp-link：点金额下钻到该时段该来源的逐笔）
  final VoidCallback? onTap;
  final String? tip;

  @override
  Widget build(BuildContext context) {
    final bool clickable = onTap != null;
    Widget child = clickable
        ? MouseRegion(
            cursor: SystemMouseCursors.click,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: bold ? FontWeight.w600 : null,
                    color: color ?? WsTokens.primary,
                    decoration: TextDecoration.underline,
                  ),
                ),
                if (sub != null && sub!.isNotEmpty)
                  Text(sub!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight)),
              ],
            ),
          )
        : ReportStackedCell(main: text, sub: sub, color: color, bold: bold, maxLines: 1);
    child = Tooltip(message: tip ?? text, child: child);
    return clickable ? GestureDetector(onTap: onTap, behavior: HitTestBehavior.opaque, child: child) : child;
  }
}

/// 支出下钻的筛选项（网页端 REP_SRC_TABS）
const List<(String, String)> kReportDrillSources = [
  ('', '全部来源'),
  ('采购', '采购（进货）'),
  ('其他开支', '其他开支'),
  ('手工记账', '手工记账'),
  ('刷单成本', '刷单成本'),
];

/// 支出下钻弹窗主体：某天 / 某月的逐笔构成（网页端 renderExpDrill）。
///
/// 数据是父页面已缓存的逐笔支出，只在前端过滤，不再请求接口。
class ReportExpDrillView extends StatefulWidget {
  const ReportExpDrillView({
    super.key,
    required this.title,
    required this.items,
    required this.periodKey,
    required this.withWarehouse,
    required this.initialSource,
    required this.onOpenItems,
  });

  /// 「2026-10-01（整月）支出明细」/「本期（查询区间）支出明细」
  final String title;

  /// 已按日期 / 月份筛出的行
  final List<Map<String, dynamic>> items;

  /// 下钻的日期 / 月份（空串 = 整个查询区间）；回填逐笔筛选时当关键词用
  final String periodKey;

  /// 全仓视角：逐笔来自多个分仓，需要多一列来源分仓
  final bool withWarehouse;

  final String initialSource;

  /// 「在『支出明细（逐笔）』中查看」：把筛选回填到支出分区
  final void Function(String source, String key) onOpenItems;

  @override
  State<ReportExpDrillView> createState() => _ReportExpDrillViewState();
}

class _ReportExpDrillViewState extends State<ReportExpDrillView> {
  String _source = '';

  @override
  void initState() {
    super.initState();
    _source = widget.initialSource;
  }

  List<Map<String, dynamic>> get _rows =>
      _source.isEmpty ? widget.items : widget.items.where((r) => wsS(r['source']) == _source).toList();

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    final double sum = rows.fold<double>(0, (s, r) => s + wsD(r['amount']));
    final bool withWh = widget.withWarehouse || rows.any((r) => wsS(r['warehouse']).isNotEmpty);
    final cols = <DesktopCol>[
      if (withWh) const DesktopCol('分仓', width: 110),
      const DesktopCol('日期', width: 100),
      const DesktopCol('来源', width: 130),
      const DesktopCol('项目', width: 220),
      const DesktopCol('金额', width: 110, right: true),
      const DesktopCol('操作员', width: 100),
      const DesktopCol('备注', width: 240),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(
            children: [
              Expanded(
                child: Text(widget.title,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
              ),
              Text('共 ${rows.length} 笔 · 合计 ${wsMoney(sum)}',
                  style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
            ],
          ),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final (value, label) in kReportDrillSources)
              ChoiceChip(
                label: Text(label, style: const TextStyle(fontSize: 12)),
                selected: _source == value,
                onSelected: (_) => setState(() => _source = value),
                selectedColor: WsTokens.primaryLight,
                labelStyle: TextStyle(
                    fontSize: 12, color: _source == value ? WsTokens.primary : WsTokens.mutedLight),
                visualDensity: VisualDensity.compact,
              ),
          ],
        ),
        const SizedBox(height: 12),
        DesktopGrid(
          dense: true,
          cols: cols,
          emptyText: rows.isEmpty ? '该时段没有此类支出' : '暂无数据',
          rows: [
            for (final r in rows)
              DesktopRow(
                cells: [
                  if (withWh) wsCell(wsS(r['warehouse']).isEmpty ? '—' : wsS(r['warehouse'])),
                  wsCell(wsS(r['date'])),
                  ReportSourceCell(source: wsS(r['source']), auto: r['auto'] == true),
                  wsCell(
                    [wsS(r['item']), wsS(r['ref'])].where((x) => x.isNotEmpty).join(' '),
                    tip: wsS(r['item']),
                  ),
                  ReportMoneyCell(text: wsMoney(wsD(r['amount'])), bold: true),
                  wsCell(wsS(r['operator']).isEmpty ? '—' : wsS(r['operator'])),
                  wsCell(wsS(r['remark']), tip: wsS(r['remark'])),
                ],
              ),
            if (rows.isNotEmpty)
              DesktopRow(
                highlight: true,
                cells: [
                  if (withWh) wsCell(''),
                  wsCell('合计', bold: true),
                  wsCell(_source.isEmpty ? '全部来源' : _source),
                  wsCell('${rows.length} 笔'),
                  ReportMoneyCell(text: wsMoney(sum), bold: true),
                  wsCell(''),
                  wsCell(''),
                ],
              ),
          ],
        ),
        const SizedBox(height: 14),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            DesktopButton(
              label: '在「支出明细（逐笔）」中查看',
              onPressed: () => widget.onOpenItems(_source, widget.periodKey),
            ),
            const SizedBox(width: 10),
            DesktopButton(
              label: '关闭',
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ],
    );
  }
}

/// 「来源」单元格：色点 + 名称（+ 自动标记）
class ReportSourceCell extends StatelessWidget {
  const ReportSourceCell({super.key, required this.source, this.auto = false});
  final String source;
  final bool auto;

  @override
  Widget build(BuildContext context) {
    final color = kReportExpSrcColors[source] ?? WsTokens.mutedLight;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        ReportColorDot(color),
        const SizedBox(width: 6),
        Flexible(child: Text(source, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5))),
        if (auto) const Text(' 自动', style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
      ],
    );
  }
}

/// 手动记账表单的提交结果（[ReportFinanceForm] 交给上层去调接口）
class ReportFinanceInput {
  const ReportFinanceInput({
    required this.type,
    required this.category,
    required this.amount,
    required this.date,
    required this.operator,
    required this.remark,
    required this.payStatus,
  });

  final String type;
  final String category;
  final double amount;
  final String date;
  final String operator;
  final String remark;
  final String payStatus;

  Map<String, dynamic> toBody() => <String, dynamic>{
        'type': type,
        'category': category,
        'amount': amount,
        'date': date,
        'operator': operator,
        'remark': remark,
        'pay_status': payStatus,
      };
}

/// 手动记账表单（网页端 openFinanceModal 的桌面版）。
///
/// `onSubmit` 返回 null 表示保存成功（表单随即关闭），返回错误文案则留在表单里显示。
class ReportFinanceForm extends StatefulWidget {
  const ReportFinanceForm({
    super.key,
    required this.operator,
    required this.onSubmit,
  });

  /// 只读：当前登录人（后端也只认登录账号）
  final String operator;
  final Future<String?> Function(ReportFinanceInput input) onSubmit;

  @override
  State<ReportFinanceForm> createState() => _ReportFinanceFormState();
}

class _ReportFinanceFormState extends State<ReportFinanceForm> {
  static const List<String> _kCategories = ['人工费', '房租', '水电', '运输费', '包装耗材', '其他支出'];

  final TextEditingController _amountCtrl = TextEditingController();
  final TextEditingController _remarkCtrl = TextEditingController();
  late final TextEditingController _operatorCtrl = TextEditingController(text: widget.operator);

  String _type = 'expense';
  String _category = _kCategories.first;
  String _date = wsToday();
  String _pay = 'paid';
  bool _saving = false;
  String _error = '';

  @override
  void dispose() {
    _amountCtrl.dispose();
    _remarkCtrl.dispose();
    _operatorCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final double amount = wsD(double.tryParse(_amountCtrl.text.trim()));
    if (amount <= 0) {
      setState(() => _error = '金额必须大于 0');
      return;
    }
    setState(() {
      _saving = true;
      _error = '';
    });
    final String? failure = await widget.onSubmit(ReportFinanceInput(
      type: _type,
      category: _category,
      amount: amount,
      date: _date,
      operator: widget.operator,
      remark: _remarkCtrl.text.trim(),
      payStatus: _pay,
    ));
    if (!mounted) return;
    setState(() {
      _saving = false;
      _error = failure ?? '';
    });
    if (failure == null) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    const TextInputType numberKey = TextInputType.numberWithOptions(decimal: true);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopFormRow(
          label: '类型',
          tip: '收入 / 支出只影响符号与报表归集方向',
          child: DesktopSelect<String>(
            width: 250,
            value: _type,
            options: const [
              DesktopOption('expense', '支出'),
              DesktopOption('income', '收入'),
            ],
            onChanged: (v) => setState(() => _type = v ?? 'expense'),
          ),
        ),
        DesktopFormRow(
          label: '分类',
          tip: '留空由后端兜底：收入→销售收入、支出→其他支出',
          child: DesktopSelect<String>(
            width: 250,
            value: _category,
            options: [
              for (final c in _kCategories) DesktopOption<String>(c, c),
            ],
            onChanged: (v) => setState(() => _category = v ?? _category),
          ),
        ),
        DesktopFormRow(
          label: '金额',
          required: true,
          child: DesktopTextField(
            controller: _amountCtrl,
            width: 250,
            hintText: '0.00',
            keyboardType: numberKey,
            inputFormatters: DesktopTextField.decimalOnly,
            autofocus: true,
          ),
        ),
        DesktopFormRow(
          label: '日期',
          child: DesktopDateField(
            value: _date,
            allowClear: false,
            width: 250,
            onChanged: (v) => setState(() => _date = v.isEmpty ? wsToday() : v),
          ),
        ),
        DesktopFormRow(
          label: '操作员',
          tip: '默认当前登录账号，不可修改',
          child: Tooltip(
            message: '默认当前登录账号，不可修改',
            child: DesktopTextField(
              width: 250,
              readonly: true,
              controller: _operatorCtrl,
            ),
          ),
        ),
        DesktopFormRow(
          label: '付款状态',
          tip: '待付款：先进「待付款账单」，点「已支付」后才计入财务报表',
          child: DesktopPayRadios(value: _pay, onChanged: (v) => setState(() => _pay = v)),
        ),
        DesktopFormRow(
          label: '备注',
          width: 420,
          child: DesktopTextField(controller: _remarkCtrl, hintText: '如：客户张三尾款、京东代发运费'),
        ),
        if (_error.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Text(_error, style: const TextStyle(fontSize: 12.5, color: WsTokens.red)),
          ),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            DesktopButton(label: '取消', onPressed: () => Navigator.of(context).pop(false)),
            const SizedBox(width: 10),
            if (_saving)
              const SizedBox(
                width: 30,
                height: 30,
                child: Padding(
                  padding: EdgeInsets.all(6),
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              )
            else
              DesktopButton(
                label: '保存',
                kind: DesktopButtonKind.primary,
                onPressed: _submit,
              ),
          ],
        ),
      ],
    );
  }
}
