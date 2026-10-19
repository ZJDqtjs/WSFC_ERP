import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';
import 'desktop_report_parts.dart';
import 'package:solar_icons/solar_icons.dart';

/// 桌面端「财务报表」：1:1 复刻 web `#page-report`，含四个分区
/// （汇总 / 支出 / 商品 / 流水），「财务流水」作为第 4 个分区并入本页。
///
/// 口径全部以后端 backend/app/routers/report.py 为准：
/// - `/api/report/summary`：只含「已付款」单据；`wh=all` 时后端把各分仓（独立账套）结果合并成全仓合计；
/// - `exclude_other=1`：不计入「其他开支」的款项，只看商品售卖利润（本机偏好，默认开启）；
/// - 收入 = 销售收入 + 客户代收的关联结算（settle_income）；毛利 = 收入 − 结转成本 − 刷单成本；
///   净利 = 毛利 − 期间费用（期间费用 = 其他开支 + 手工记账，采购已进成本、刷单已在毛利扣过）；
/// - `/api/report/sales-by-spec`：出库明细不区分是否已收款（只看实际发出的货）。
/// 网页端真源：web/static/app.js 的 loadReport / renderCostBreakdown / renderExpenseSummary /
/// renderFeeBreakdown / renderExpenseTables / renderExpenseItems / renderReportGoods /
/// renderSalesBySpec / loadAllWarehouses / openExpDrill / openFinanceModal。
class DesktopReportScreen extends StatefulWidget {
  const DesktopReportScreen({
    super.key,
    required this.auth,
    required this.onNavigate,
    this.initialPanel,
  });

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  /// 'summary' | 'expense' | 'goods' | 'flow'，null=汇总
  final String? initialPanel;

  @override
  State<DesktopReportScreen> createState() => _DesktopReportScreenState();
}

/// 口径开关的持久化键（与网页端 localStorage 同名语义）
const String _kExcludeOtherPref = 'erp_exclude_other';

/// 支出统计「按日」最多列多少天（超出只列最近这些，与网页端一致）
const int _kMaxDayRows = 90;

/// 逐笔支出明细最多列多少笔
const int _kMaxItemRows = 200;

/// 支出柱图最多画几根（仅影响图形，表格仍是全量）
const int _kMaxChartBars = 30;

const List<String> _kPanelNames = ['汇总', '支出', '商品', '流水'];

/// 商品明细的一组合计值（销量 / 重量 / 收入 / 客户代收 / 总成本）
typedef _GoodsSum = ({double qty, double weight, double amount, double settle, double cogs});

/// 下钻 kind → 来源名（网页端 REP_DRILL_SRC）
const Map<String, String> _kDrillSourceOf = {
  'purchase': '采购',
  'other': '其他开支',
  'manual': '手工记账',
  'brush': '刷单成本',
};

/// 数字文本：整数不带小数，其余最多 4 位（网页端 fmtNum）
String _qty(dynamic v) => wsTrim(wsD(v), digits: 4);

/// 比率文本：base 为 0 时显示 —
String _rate(double value, double base) =>
    base == 0 ? '—' : '${(value / base * 100).toStringAsFixed(1)}%';

/// 排序值比较：数字按大小、其余按文本
int _cmpValues(dynamic a, dynamic b) {
  if (a is num && b is num) return a.compareTo(b);
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a.toString().compareTo(b.toString());
}

List<T> _sorted<T>(List<T> src, dynamic Function(T) keyOf, bool asc) {
  final List<T> out = src.toList();
  out.sort((x, y) {
    final int r = _cmpValues(keyOf(x), keyOf(y));
    return asc ? r : -r;
  });
  return out;
}

/// 日期/月份前缀（下钻回填逐笔筛选的关键词用）
final RegExp _monthRe = RegExp(r'^\d{4}-\d{2}$');

class _DesktopReportScreenState extends State<DesktopReportScreen> {
  final TextEditingController _goodsKwCtrl = TextEditingController();
  final TextEditingController _expKwCtrl = TextEditingController();
  final TextEditingController _flowKwCtrl = TextEditingController();

  // ---------------- 工具条状态 ----------------
  bool _excludeOther = true; // 排除其他开支（默认开）
  bool _allWh = false; // 视角：true = 全仓总览（wh=all）
  String _wh = ''; // 单仓总览查看的分仓 key（'' = 当前分仓）
  String _dateFrom = wsToday(); // 首次进入默认只看今天
  String _dateTo = wsToday();
  int _panel = 0;

  // ---------------- 数据 ----------------
  Map<String, dynamic> _summary = const {};
  List<dynamic> _flow = const [];
  Map<String, dynamic> _allWhData = const {};
  Map<String, dynamic> _specData = const {};
  List<dynamic> _prodRows = const [];
  List<Map<String, dynamic>> _expItems = const [];
  List<dynamic> _whOptions = const [];

  bool _loading = false;
  String? _error;

  // ---------------- 分区内筛选 / 排序 ----------------
  String _expSrc = ''; // 逐笔来源
  bool _expByMonth = false; // 支出统计：按日 / 按月
  String _goodsSortKey = '';
  bool _goodsSortAsc = false;
  String _flowSortKey = '';
  bool _flowSortAsc = false;

  @override
  void initState() {
    super.initState();
    _panel = switch (widget.initialPanel) {
      'expense' => 1,
      'goods' => 2,
      'flow' => 3,
      _ => 0,
    };
    _boot();
  }

  @override
  void dispose() {
    _goodsKwCtrl.dispose();
    _expKwCtrl.dispose();
    _flowKwCtrl.dispose();
    super.dispose();
  }

  // ---------------- 数据加载 ----------------

  Future<void> _boot() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    // 「无记录时默认开启」，与网页端 localStorage 判定一致
    final bool on = prefs.getString(_kExcludeOtherPref) != '0';
    if (!mounted) return;
    setState(() => _excludeOther = on);
    await _ensureWhOptions();
    await _load();
  }

  /// 分仓下拉数据（拿不到就按「当前分仓」看，不影响报表）
  Future<void> _ensureWhOptions() async {
    if (_whOptions.isNotEmpty) return;
    try {
      final Map<String, dynamic> data = await ApiService.warehouses();
      if (!mounted) return;
      setState(() {
        _whOptions = (data['warehouses'] as List?)?.cast<dynamic>() ?? const [];
        _wh = _wh.isEmpty ? wsS(data['current']) : _wh;
      });
    } on ApiException catch (_) {
      // 忽略：与网页端 repEnsureWhOptions 的兜底一致
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final String wh = _allWh ? 'all' : _wh;
    final List<Future<dynamic>> requests = <Future<dynamic>>[
      ApiService.reportSummary(
          dateFrom: _dateFrom, dateTo: _dateTo, wh: wh, excludeOther: _excludeOther),
      ApiService.finance(dateFrom: _dateFrom, dateTo: _dateTo, wh: wh),
      ApiService.reportSalesBySpec(dateFrom: _dateFrom, dateTo: _dateTo, wh: wh),
    ];
    if (_allWh) {
      requests.add(ApiService.reportAllWarehouses(
          dateFrom: _dateFrom, dateTo: _dateTo, excludeOther: _excludeOther));
    }
    try {
      final List<dynamic> res = await Future.wait(requests);
      if (!mounted) return;
      final Map<String, dynamic> summary = res[0] as Map<String, dynamic>;
      final List<dynamic> flow = (res[1] as List?)?.cast<dynamic>() ?? const [];
      final Map<String, dynamic> spec = (res[2] as Map?)?.cast<String, dynamic>() ?? const {};
      final Map<String, dynamic> allWh =
          (_allWh && res.length > 3 ? (res[3] as Map?) : null)?.cast<String, dynamic>() ?? const {};
      setState(() {
        _summary = summary;
        _flow = flow;
        _specData = spec;
        _allWhData = allWh;
        _prodRows = (summary['by_product'] as List?)?.cast<dynamic>() ?? const [];
        _expItems = _toMaps(summary['expense_items']);
        // 换区间后重置逐笔筛选，避免「看不到数据」的困惑（网页端 renderExpenseItems 同处理）
        _expSrc = '';
        _expKwCtrl.text = '';
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (_summary.isEmpty) _error = '加载报表失败：${e.message}';
      });
      wsToast(context, '加载报表失败：${e.message}', error: true);
    }
  }

  List<Map<String, dynamic>> _toMaps(dynamic list) =>
      list is List ? [for (final e in list) if (e is Map) e.cast<String, dynamic>()].toList() : const [];

  // ---------------- 交互 ----------------

  Future<void> _setExcludeOther(bool on) async {
    if (_excludeOther == on) return;
    setState(() => _excludeOther = on);
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kExcludeOtherPref, on ? '1' : '0');
    if (!mounted) return;
    wsToast(context, on ? '已排除其他开支：只看商品售卖利润' : '已计入其他开支：含全部期间费用');
    await _load();
  }

  void _setScope(bool all) {
    if (_allWh == all) return;
    setState(() => _allWh = all);
    _load();
  }

  /// 全仓总览点某分仓 → 回到单仓总览看它的明细（只换视角，不改工作分仓）
  void _viewWarehouse(String key) {
    setState(() {
      _wh = key;
      _allWh = false;
    });
    _load();
  }

  void _quickRange(String kind) {
    setState(() {
      switch (kind) {
        case 'today':
          _dateFrom = wsToday();
          _dateTo = wsToday();
        case 'month':
          _dateFrom = wsMonthStart();
          _dateTo = wsToday();
        default:
          _dateFrom = '';
          _dateTo = '';
      }
    });
    _load();
  }

  Future<void> _openFinanceDialog() async {
    final bool? saved = await desktopDialog<bool>(
      context,
      title: '手动记账',
      width: 640,
      builder: (dialogContext) => ReportFinanceForm(
        operator: widget.auth.displayName,
        onSubmit: _submitFinance,
      ),
    );
    if (saved == true) await _load();
  }

  /// 返回 null = 保存成功（表单自己关闭）；返回文案 = 留在表单里显示
  Future<String?> _submitFinance(ReportFinanceInput input) async {
    try {
      await ApiService.createFinance(input.toBody());
      if (!mounted) return null;
      wsToast(context, input.payStatus == 'unpaid' ? '已记入待付款账单' : '记账成功');
      return null;
    } on ApiException catch (e) {
      return '失败：${e.message}';
    }
  }

  Future<void> _deleteFinance(dynamic row) async {
    final bool ok = await wsConfirm(
      context,
      title: '删除流水',
      message: '确认删除该手动财务记录？',
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      await ApiService.deleteFinance(wsI(row['id']));
      if (!mounted) return;
      wsToast(context, '已删除');
      await _load();
    } on ApiException catch (e) {
      // 非 manual 的记录后端 400，原文展示
      if (!mounted) return;
      wsToast(context, '失败：${e.message}', error: true);
    }
  }

  /// 点按日 / 按月表里的日期或金额 → 展开该时段该来源的逐笔构成（用已缓存数据，不再请求）
  void _openDrill(String key, String kind) {
    final bool isMonth = _monthRe.hasMatch(key);
    final List<Map<String, dynamic>> items = _expItems.where((r) {
      if (key.isEmpty) return true;
      final String d = wsS(r['date']);
      final String v = isMonth ? (d.length >= 7 ? d.substring(0, 7) : d) : d;
      return v == key;
    }).toList();
    final String title = key.isEmpty
        ? '本期（查询区间）支出明细'
        : '$key${isMonth ? '（整月）' : ''} 支出明细';
    desktopDialog<void>(
      context,
      title: '支出明细',
      width: 1080,
      maxHeight: 660,
      builder: (dialogContext) => ReportExpDrillView(
        title: title,
        periodKey: key,
        items: items,
        withWarehouse: _allWh,
        initialSource: _kDrillSourceOf[kind] ?? '',
        onOpenItems: (source, periodKey) {
          Navigator.of(dialogContext).pop();
          setState(() {
            _panel = 1;
            _expSrc = source;
            _expKwCtrl.text = periodKey;
          });
        },
      ),
    );
  }

  // ---------------- 派生数据 ----------------

  Map<String, dynamic> get _s => _summary;
  bool get _isAll => _s['is_all'] == true || _allWh;

  String get _rangeHint {
    final String from = _dateFrom.isEmpty ? '最早' : _dateFrom;
    final String to = _dateTo.isEmpty ? '最新' : _dateTo;
    final Map? wh = _s['warehouse'] as Map?;
    final int whCount = wsI(_s['warehouse_count']);
    final String scope = _allWh
        ? ' · 全仓合计${whCount != 0 ? '（$whCount 个分仓）' : ''}'
        : (wh != null ? ' · ${wsS(wh['name'])}${_s['is_current'] == true ? '（当前分仓）' : ''}' : '');
    final double excluded = wsD(_s['excluded_other_expense']);
    final String caliber = _s['exclude_other_expense'] == true
        ? '已排除其他开支 ${wsMoney(excluded)}'
        : '含其他开支 ${wsMoney(excluded)}';
    return '统计区间 $from ~ $to$scope · $caliber';
  }

  String get _whHint {
    final Map? wh = _s['warehouse'] as Map?;
    if (wh != null && _s['is_current'] != true) {
      return '正在查看「${wsS(wh['name'])}」的数据（仅查看，不会改变你的工作分仓）';
    }
    return '默认是你当前所在分仓；换一个只是换看谁的数据，不会改变你的工作分仓';
  }

  // ---------------- 构建 ----------------

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '财务报表',
      subtitle: _summary.isEmpty ? '财务利润报表 · 加载中…' : _rangeHint,
      actions: [
        DesktopButton(
          label: '记账',
          icon: SolarIconsOutline.plus,
          kind: DesktopButtonKind.primary,
          onPressed: _loading ? null : _openFinanceDialog,
        ),
        DesktopButton(
          label: '刷新',
          icon: SolarIconsOutline.refresh,
          onPressed: _loading ? null : _load,
        ),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _toolbar(),
          Row(
            children: [
              DesktopTabs(
                items: _kPanelNames,
                index: _panel,
                onChanged: (i) => setState(() => _panel = i),
              ),
              const SizedBox(width: 14),
              if (_summary.isNotEmpty)
                Expanded(
                  child: Text(
                    _panelHint,
                    style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: DesktopStateView(
              loading: _loading && _summary.isEmpty,
              error: _error,
              onRetry: _load,
              loadingText: '加载报表…',
              child: ListView(
                padding: const EdgeInsets.only(bottom: 24),
                children: switch (_panel) {
                  1 => _expensePanel(),
                  2 => _goodsPanel(),
                  3 => _flowPanel(),
                  _ => _summaryPanel(),
                },
              ),
            ),
          ),
        ],
      ),
    );
  }

  String get _panelHint => switch (_panel) {
        0 => _allWh
            ? '全仓总览：各分仓独立账套合并合计，点「看单仓明细」可切回单仓视角'
            : '单仓总览：默认你当前所在分仓，换一个只是换看谁的数据',
        1 => '支出 ＝ 采购（进货）＋ 其他开支 ＋ 手工记账 ＋ 刷单成本；期间费用才是从毛利里扣的部分',
        2 => '商品销售明细的成本是「总成本」（商品成本 ＋ 打包人工/耗材 ＋ 快递费 ＋ 刷单结算）',
        _ => '流水只列财务记录（收入 / 支出），采购与其他开支在「支出」分区逐笔核对',
      };

  Widget _toolbar() {
    final dark = wsIsDark(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopFilterBar(
          right: DesktopTabs(
            small: true,
            items: const ['全仓总览', '单仓总览'],
            index: _allWh ? 0 : 1,
            onChanged: (i) => _setScope(i == 0),
          ),
          children: [
            DesktopLabeled(
              label: '统计区间',
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  DesktopDateField(
                    value: _dateFrom,
                    width: 140,
                    onChanged: (v) => setState(() => _dateFrom = v),
                  ),
                  const SizedBox(width: 6),
                  const Text('—', style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                  const SizedBox(width: 6),
                  DesktopDateField(
                    value: _dateTo,
                    width: 140,
                    onChanged: (v) => setState(() => _dateTo = v),
                  ),
                ],
              ),
            ),
            DesktopButton(label: '查询', icon: SolarIconsOutline.magnifier, kind: DesktopButtonKind.primary, onPressed: _load),
            DesktopButton(label: '今天', small: true, onPressed: () => _quickRange('today')),
            DesktopButton(label: '本月', small: true, onPressed: () => _quickRange('month')),
            DesktopButton(label: '全部', small: true, onPressed: () => _quickRange('all')),
            _excludeToggle(),
            if (!_allWh) ...[
              DesktopLabeled(
                label: '查看分仓',
                child: DesktopSelect<String>(
                  width: 190,
                  value: _wh,
                  options: [
                    for (final w in _whOptions)
                      DesktopOption<String>(
                        wsS(w['key']),
                        '${wsS(w['name'])}${w['is_current'] == true || wsS(w['key']) == _currentWhKey ? '（当前分仓）' : ''}',
                      ),
                  ],
                  onChanged: (v) {
                    if (v == null || v == _wh) return;
                    setState(() => _wh = v);
                    _load();
                  },
                ),
              ),
            ],
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: Wrap(
            spacing: 18,
            runSpacing: 6,
            children: [
              Text(
                '开启后本报表不计入「其他开支」的款项，只看商品售卖利润',
                style: TextStyle(fontSize: 11.5, color: dark ? WsTokens.mutedDark : WsTokens.mutedLight),
              ),
              if (!_allWh)
                Text(
                  _summary.isEmpty ? '默认是你当前所在分仓；换一个只是换看谁的数据，不会改变你的工作分仓' : _whHint,
                  style: TextStyle(fontSize: 11.5, color: dark ? WsTokens.mutedDark : WsTokens.mutedLight),
                ),
            ],
          ),
        ),
      ],
    );
  }

  String get _currentWhKey => widget.auth.warehouseKey;

  Widget _excludeToggle() {
    return InkWell(
      borderRadius: BorderRadius.circular(WsTokens.radius),
      onTap: () => _setExcludeOther(!_excludeOther),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Checkbox(
              value: _excludeOther,
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              onChanged: (v) => _setExcludeOther(v ?? true),
            ),
            const Text('排除其他开支', style: TextStyle(fontSize: 12.5)),
          ],
        ),
      ),
    );
  }

  // ==================== 分区 1：汇总 ====================

  List<Widget> _summaryPanel() {
    final Map<String, dynamic> s = _s;
    final String pre = _allWh ? '全仓' : '';
    final double revenue = wsD(s['revenue']);
    final double cogs = wsD(s['cogs']);
    final double brush = wsD(s['brush_cost']);
    final double gross = wsD(s['gross_profit']);
    final double expense = wsD(s['expense']);
    final double net = wsD(s['net_profit']);
    final double purchase = wsD(s['purchase']);
    final double totalExpense = wsD(s['total_expense']);
    final double packTotal = wsD(s['pack_cost_total']);
    final double wiRevenue = wsD(s['warehouse_in_revenue']);
    final double wiCogs = wsD(s['warehouse_in_cogs']);
    final int wiCount = wsI(s['warehouse_in_count']);

    final String wiParts = [
      if (wiCount != 0) '入仓 $wiCount 条',
      if (wiRevenue != 0) wsMoney(wiRevenue),
    ].join(' ');

    final List<Widget> cards = [
      DesktopStatCard(
        label: '$pre销售收入',
        value: wsMoney(revenue),
        color: WsTokens.primary,
        sub: [
          '${wsI(s['order_count'])} 单',
          if (wiParts.isNotEmpty) wiParts,
          if (_allWh) '${wsI(s['warehouse_count'])} 个分仓',
        ].join(' · '),
      ),
      DesktopStatCard(
        label: '$pre结转成本',
        value: wsMoney(cogs),
        color: WsTokens.amber,
        sub: '含关联结算 ${wsMoney(packTotal)} · 含入仓 ${wsMoney(wiCogs)}',
      ),
      if (brush != 0)
        DesktopStatCard(
          label: '$pre刷单成本',
          value: wsMoney(brush),
          color: WsTokens.red,
          sub: '芳谊放单仓 · 已从毛利扣减',
        ),
      DesktopStatCard(
        label: '$pre毛利',
        value: wsMoney(gross),
        color: WsTokens.green,
        sub: _rate(gross, revenue),
      ),
      DesktopStatCard(
        label: '$pre期间费用',
        value: wsMoney(expense),
        color: WsTokens.red,
        sub: '其他开支 ${wsMoney(wsD(s['other_expense']))} · 手工记账 ${wsMoney(wsD(s['manual_expense']))}',
      ),
      DesktopStatCard(
        label: '$pre净利润',
        value: wsMoney(net),
        color: net >= 0 ? WsTokens.green : WsTokens.red,
      ),
      DesktopStatCard(label: '$pre本期进货', value: wsMoney(purchase)),
      DesktopStatCard(
        label: '$pre本期总支出',
        value: wsMoney(totalExpense),
        color: WsTokens.red,
        sub: '含采购 ${wsMoney(purchase)} · 期间费用 ${wsMoney(expense)}',
      ),
      DesktopStatCard(
        label: '$pre当前库存总值',
        value: wsMoney(wsD(s['stock_value'])),
        color: WsTokens.primary,
        sub: '不受区间限制',
      ),
    ];

    return [
      DesktopRise(index: 0, child: DesktopStatGrid(children: cards)),
      DesktopRise(index: 1, child: _costBreakdownCard()),
      if (_allWh) DesktopRise(index: 2, child: _allWarehousesCard()),
    ];
  }

  /// 销售成本构成：商品成本 vs 出库自动结算的包材/人工/快递 + 入仓 + 刷单
  List<ReportCostItem> _costItems() {
    final Map<String, dynamic> s = _s;
    final double cogs = wsD(s['cogs']);
    final double packTotal = wsD(s['pack_cost_total']);
    final double brush = wsD(s['brush_cost']);
    final double goods = s['goods_cogs'] != null ? wsD(s['goods_cogs']) : cogs - packTotal;
    final double wiFreight = wsD(s['warehouse_in_freight']);
    final double wiPack = wsD(s['warehouse_in_pack']);
    final Map<String, dynamic> packs = (s['pack_costs'] as Map?)?.cast<String, dynamic>() ?? const {};

    String descOf(String tag, String name) {
      if (name == '刷单成本') {
        return '芳谊放单仓：导入确认时按单填写的刷单成本（+ 快递包装固定费覆盖差），已从毛利扣减';
      }
      if (tag == '入仓') return '入仓（入仓品卖到京东）：每袋运费 / 随货包材，已计入入仓成本';
      if (tag.isNotEmpty) return '出库时按包装清单自动结算，已计入结转成本';
      return '销售商品本身的先进先出成本';
    }

    final List<String> packKeys = packs.keys.toList()
      ..sort((a, b) => wsD(packs[b]).compareTo(wsD(packs[a])));

    return [
      ReportCostItem(name: '商品成本', value: goods, color: const Color(0xFF1989FA), desc: descOf('', '商品成本')),
      for (final k in packKeys)
        ReportCostItem(
          name: k,
          value: wsD(packs[k]),
          color: kReportCostColorOf(k),
          tag: '自动结算',
          desc: descOf('自动结算', k),
        ),
      if (wiFreight != 0)
        ReportCostItem(
          name: '入仓运费',
          value: wiFreight,
          color: kReportCostColors['入仓运费']!,
          tag: '入仓',
          desc: descOf('入仓', '入仓运费'),
        ),
      if (wiPack != 0)
        ReportCostItem(
          name: '入仓包材',
          value: wiPack,
          color: kReportCostColors['入仓包材']!,
          tag: '入仓',
          desc: descOf('入仓', '入仓包材'),
        ),
      if (brush != 0)
        ReportCostItem(
          name: '刷单成本',
          value: brush,
          color: kReportCostColors['刷单成本']!,
          tag: '放单仓',
          desc: descOf('放单仓', '刷单成本'),
        ),
    ];
  }

  Widget _costBreakdownCard() {
    final Map<String, dynamic> s = _s;
    final double cogs = wsD(s['cogs']);
    final double brush = wsD(s['brush_cost']);
    final double packTotal = wsD(s['pack_cost_total']);
    final double wiCost = wsD(s['warehouse_in_freight']) + wsD(s['warehouse_in_pack']);
    final double total = cogs + brush;
    final List<ReportCostItem> items = _costItems();

    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCardHead(
            title: '销售成本构成',
            icon: SolarIconsOutline.donut,
            trailing: total == 0
                ? null
                : Text(
                    '合计 ${wsMoney(total)}${brush != 0 ? '（含刷单 ${wsMoney(brush)}）' : ''}',
                    style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight),
                  ),
          ),
          if (total == 0)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Text('本期无销售成本', style: TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
            )
          else ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: DesktopStackBar(
                parts: [
                  for (final r in items)
                    if (r.value > 0) (color: r.color, value: r.value, label: r.name),
                ],
              ),
            ),
            DesktopGrid(
              cols: const [
                DesktopCol('成本项', width: 250),
                DesktopCol('金额', width: 140, right: true),
                DesktopCol('占比', width: 90, right: true),
                DesktopCol('说明', width: 460),
              ],
              rows: [
                for (final r in items)
                  DesktopRow(
                    cells: [
                      Row(
                        children: [
                          ReportColorDot(r.color),
                          const SizedBox(width: 8),
                          Flexible(child: Text(r.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
                          if (r.tag.isNotEmpty) ...[
                            const SizedBox(width: 8),
                            DesktopTag(r.tag, color: WsTokens.primary),
                          ],
                        ],
                      ),
                      ReportMoneyCell(text: wsMoney(r.value)),
                      wsCell(total == 0 ? '0.0%' : '${(r.value / total * 100).toStringAsFixed(1)}%'),
                      wsCell(r.desc, tip: r.desc),
                    ],
                  ),
                DesktopRow(
                  highlight: true,
                  cells: [
                    wsCell('成本合计', bold: true),
                    ReportMoneyCell(text: wsMoney(total), bold: true),
                    wsCell('100%', bold: true),
                    wsCell(
                      [
                        '关联结算 ${wsMoney(packTotal)}',
                        if (wiCost != 0) '入仓 ${wsMoney(wiCost)}',
                        if (brush != 0) '刷单 ${wsMoney(brush)}',
                      ].join(' · '),
                      tip: '合计 = 结转成本 + 刷单成本',
                    ),
                  ],
                ),
              ],
            ),
            if (packTotal == 0 && wiCost == 0)
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: DesktopNotice(
                  '本期没有包材 / 人工 / 快递等关联结算成本。若商品已配置包装清单，请确认出库时是否生成了关联结算行。',
                  kind: DesktopNoticeKind.warn,
                ),
              ),
          ],
        ],
      ),
    );
  }

  /// 全仓视角：各分仓收入 / 支出 / 利润
  Widget _allWarehousesCard() {
    final Map<String, dynamic> d = _allWhData;
    final List<Map<String, dynamic>> items = _toMaps(d['items']);
    final Map<String, dynamic> tot = (d['total'] as Map?)?.cast<String, dynamic>() ?? const {};
    final Map<String, dynamic> pend = (tot['pending'] as Map?)?.cast<String, dynamic>() ?? const {};
    final List<Map<String, dynamic>> bad = items.where((x) => wsS(x['error']).isNotEmpty).toList();
    final List<Map<String, dynamic>> rows = items.where((x) => wsS(x['error']).isEmpty).toList();
    final String current = wsS(d['current']);

    final String hint = '共 ${rows.length} 个分仓 · 每个分仓独立账套，只统计「已付款」单据'
        '${(wsD(pend['payables_amount']) != 0 || wsD(pend['receivables_amount']) != 0)
            ? '；另有 ${wsI(pend['payables_count'])} 笔待付款 ${wsMoney(wsD(pend['payables_amount']))}'
                '/ ${wsI(pend['receivables_count'])} 笔待收款 ${wsMoney(wsD(pend['receivables_amount']))} 未计入'
            : ''}';

    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCardHead(
            title: '各分仓收入 / 支出 / 利润',
            icon: SolarIconsOutline.buildings,
            trailing: Text(hint, style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ),
          if (bad.isNotEmpty)
            DesktopNotice(
              bad.map((x) => '${wsS(x['name'])}：${wsS(x['error'])}').join('；'),
              kind: DesktopNoticeKind.warn,
            ),
          DesktopGrid(
            cols: const [
              DesktopCol('分仓', width: 230),
              DesktopCol('销售收入', width: 140, right: true),
              DesktopCol('结转成本', width: 140, right: true),
              DesktopCol('毛利', width: 120, right: true),
              DesktopCol('毛利率', width: 84, right: true),
              DesktopCol('期间费用', width: 120, right: true),
              DesktopCol('本期进货', width: 120, right: true),
              DesktopCol('净利润', width: 130, right: true),
              DesktopCol('订单数', width: 84, right: true),
              DesktopCol('库存总值', width: 130, right: true),
              DesktopCol('操作', width: 116, center: true),
            ],
            emptyText: '暂无分仓数据',
            rows: [
              for (final w in rows) _warehouseRow(w, w['key'] == current),
              if (rows.isNotEmpty) _warehouseRow(tot, false, label: '全仓合计', total: true),
            ],
          ),
        ],
      ),
    );
  }

  DesktopRow _warehouseRow(Map<String, dynamic> w, bool isCurrent, {String? label, bool total = false}) {
    final Map<String, dynamic> pend = (w['pending'] as Map?)?.cast<String, dynamic>() ?? const {};
    final double pay = wsD(pend['payables_amount']);
    final double recv = wsD(pend['receivables_amount']);
    final String sub = (pay != 0 || recv != 0) && !total
        ? '待付款 ${wsMoney(pay)} · 待收款 ${wsMoney(recv)}（未计入）'
        : '';
    final double revenue = wsD(w['revenue']);
    final double net = wsD(w['net_profit']);
    final String name = label ?? wsS(w['name']);

    return DesktopRow(
      highlight: isCurrent || total,
      cells: [
        Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Flexible(
                  child: Text(name,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                ),
                if (isCurrent) ...[
                  const SizedBox(width: 6),
                  const DesktopTag('当前', color: WsTokens.primary),
                ],
              ],
            ),
            if (sub.isNotEmpty)
              Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight)),
          ],
        ),
        ReportMoneyCell(
          text: wsMoney(revenue),
          sub: wsD(w['warehouse_in_revenue']) != 0 ? '含入仓 ${wsMoney(wsD(w['warehouse_in_revenue']))}' : null,
          bold: total,
        ),
        ReportMoneyCell(
          text: wsMoney(wsD(w['cogs'])),
          sub: wsD(w['warehouse_in_cogs']) != 0 ? '含入仓 ${wsMoney(wsD(w['warehouse_in_cogs']))}' : null,
          bold: total,
        ),
        ReportMoneyCell(text: wsMoney(wsD(w['gross'])), bold: total),
        wsCell(_rate(wsD(w['gross']), revenue)),
        wsCell(wsMoney(wsD(w['expense']))),
        wsCell(wsMoney(wsD(w['purchase']))),
        ReportMoneyCell(text: wsMoney(net), color: net >= 0 ? WsTokens.green : WsTokens.red, bold: true),
        wsCell(wsI(w['orders']).toString()),
        wsCell(wsMoney(wsD(w['stock_value']))),
        total
            ? wsCell('')
            : DesktopLink(
                '看单仓明细',
                onPressed: () => _viewWarehouse(wsS(w['key'])),
              ),
      ],
    );
  }

  // ==================== 分区 2：支出 ====================

  List<Widget> _expensePanel() {
    final Map<String, dynamic> s = _s;
    final double purchase = wsD(s['purchase']);
    final double other = wsD(s['other_expense']);
    final double manual = wsD(s['manual_expense']);
    final double period = wsD(s['expense']);
    final double brush = wsD(s['brush_cost']);
    final double total = s['total_expense'] != null ? wsD(s['total_expense']) : purchase + period + brush;
    final String feeHint =
        '统计区间 ${wsS(s['date_from']).isEmpty ? '最早' : wsS(s['date_from'])} ~ '
        '${wsS(s['date_to']).isEmpty ? '最新' : wsS(s['date_to'])} · 支出合计 ${wsMoney(total)}';

    return [
      DesktopRise(
        index: 0,
        child: WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              WsCardHead(
                title: '支出汇总',
                icon: SolarIconsOutline.wallet,
                trailing: Row(
                  children: [
                    Text(feeHint, style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                    const SizedBox(width: 12),
                    DesktopButton(
                      label: '去登记其他开支 →',
                      small: true,
                      onPressed: () => widget.onNavigate('/expenses'),
                    ),
                  ],
                ),
              ),
              _expenseSummaryTable(
                purchase: purchase,
                other: other,
                manual: manual,
                period: period,
                brush: brush,
                total: total,
              ),
              const SizedBox(height: 18),
              _feeBreakdown(),
            ],
          ),
        ),
      ),
      DesktopRise(index: 1, child: _expenseTablesCard()),
      DesktopRise(index: 2, child: _expenseItemsCard()),
    ];
  }

  Widget _expenseSummaryTable({
    required double purchase,
    required double other,
    required double manual,
    required double period,
    required double brush,
    required double total,
  }) {
    final double brushFee = wsD(_s['brush_fee_cost']);
    final double brushInput = wsD(_s['brush_input_cost']);
    String pct(double v) => total == 0 ? '0.0%' : '${(v / total * 100).toStringAsFixed(1)}%';
    final List<ReportCostItem> rows = [
      ReportCostItem(
        name: '采购支出（进货）',
        value: purchase,
        color: const Color(0xFF1989FA),
        desc: '入库 / 进货金额（与「本期进货」同源，含入库运费/装卸费），已计入结转成本',
      ),
      ReportCostItem(
        name: '其他开支',
        value: other,
        color: const Color(0xFFF97316),
        desc: '网线费 / 安装费 / 机器费 / 样品费等（构成见下表）',
      ),
      ReportCostItem(
        name: '手工记账',
        value: manual,
        color: const Color(0xFF6366F1),
        desc: '财务流水里登记的支出（构成见下表）',
      ),
      ReportCostItem(
        name: '刷单成本',
        value: brush,
        color: const Color(0xFFE11D48),
        desc: '芳谊放单仓刷单单：快递+包装固定费 ＋ 刷单成本（逐单见「支出明细 / 来源=刷单成本」），已从毛利扣减，不重复计入期间费用',
      ),
    ];

    return DesktopGrid(
      cols: const [
        DesktopCol('支出项', width: 220),
        DesktopCol('金额', width: 140, right: true),
        DesktopCol('占全部支出', width: 110, right: true),
        DesktopCol('说明', width: 520),
      ],
      rows: [
        for (final ReportCostItem r in rows)
          DesktopRow(
            cells: [
              Row(
                children: [
                  ReportColorDot(r.color),
                  const SizedBox(width: 8),
                  Expanded(child: Text(r.name, style: const TextStyle(fontSize: 13))),
                ],
              ),
              ReportMoneyCell(text: wsMoney(r.value)),
              wsCell(pct(r.value)),
              wsCell(r.desc, tip: r.desc),
            ],
          ),
        DesktopRow(
          highlight: true,
          cells: [
            wsCell('支出合计', bold: true),
            ReportMoneyCell(text: wsMoney(total), bold: true),
            wsCell('100.0%', bold: true),
            wsCell('支出合计 ＝ 采购 ＋ 其他开支 ＋ 手工记账 ＋ 刷单成本'),
          ],
        ),
        DesktopRow(
          cells: [
            wsCell('其中：期间费用'),
            ReportMoneyCell(text: wsMoney(period)),
            wsCell(pct(period)),
            wsCell('其他开支 ＋ 手工记账；毛利 − 期间费用 = 净利（采购已计入结转成本、刷单成本已在毛利里扣过，都不重复扣）'),
          ],
        ),
        if (brush != 0)
          DesktopRow(
            cells: [
              wsCell('其中：刷单成本'),
              ReportMoneyCell(text: wsMoney(brush)),
              wsCell(pct(brush)),
              wsCell('快递+包装固定费 ${wsMoney(brushFee)} ＋ 刷单成本 ${wsMoney(brushInput)}'
                  '（放单仓刷单单，逐单可在「支出明细」按来源筛出）'),
            ],
          ),
      ],
    );
  }

  /// 期间费用构成：其他开支 + 手工记账 合并成按金额降序的一张表
  Widget _feeBreakdown() {
    final Map<String, dynamic> others = (_s['other_expenses'] as Map?)?.cast<String, dynamic>() ?? const {};
    final Map<String, dynamic> manuals = (_s['manual_fees'] as Map?)?.cast<String, dynamic>() ?? const {};
    final double otherTotal = wsD(_s['other_expense']);
    final double manualTotal = _s['manual_expense'] != null
        ? wsD(_s['manual_expense'])
        : manuals.values.fold<double>(0, (a, b) => a + wsD(b));
    final double total = _s['expense'] != null ? wsD(_s['expense']) : otherTotal + manualTotal;

    final List<ReportCostItem> items = [
      for (final e in others.entries)
        ReportCostItem(
          name: e.key,
          value: wsD(e.value),
          color: const Color(0xFFF97316),
          source: '其他开支',
        ),
      for (final e in manuals.entries)
        ReportCostItem(
          name: e.key,
          value: wsD(e.value),
          color: const Color(0xFF6366F1),
          source: '手工记账',
        ),
    ]..sort((a, b) => b.value.compareTo(a.value));

    if (items.isEmpty) {
      return const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('期间费用构成（从毛利中扣减）', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          SizedBox(height: 10),
          Text(
            '本期无期间费用。其他开支请到「经营分析 → 其他开支」登记；手工记账见「流水」分区的「＋ 手动记账」',
            style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight),
          ),
        ],
      );
    }

    String pct(double v) => total == 0 ? '0.0%' : '${(v / total * 100).toStringAsFixed(1)}%';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Padding(
          padding: EdgeInsets.only(bottom: 10),
          child: Text('期间费用构成（其他开支 ＋ 手工记账，从毛利中扣减）',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        ),
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: DesktopStackBar(
            parts: [
              for (final r in items)
                if (r.value > 0) (color: r.color, value: r.value, label: '${r.name}（${r.source}）'),
            ],
          ),
        ),
        DesktopGrid(
          dense: true,
          cols: const [
            DesktopCol('费用项', width: 220),
            DesktopCol('来源', width: 140),
            DesktopCol('金额', width: 140, right: true),
            DesktopCol('占比', width: 90, right: true),
          ],
          rows: [
            for (final r in items)
              DesktopRow(
                cells: [
                  Row(
                    children: [
                      ReportColorDot(r.color),
                      const SizedBox(width: 8),
                      Flexible(child: Text(r.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
                    ],
                  ),
                  wsCell(r.source),
                  ReportMoneyCell(text: wsMoney(r.value)),
                  wsCell(pct(r.value)),
                ],
              ),
            DesktopRow(
              highlight: true,
              cells: [
                wsCell('期间费用合计', bold: true),
                wsCell('其他开支 ${wsMoney(otherTotal)} + 手工记账 ${wsMoney(manualTotal)}'),
                ReportMoneyCell(text: wsMoney(total), bold: true),
                wsCell('100%', bold: true),
              ],
            ),
          ],
        ),
      ],
    );
  }

  /// 支出统计（按日 / 按月）+ 柱图 + 下钻
  Widget _expenseTablesCard() {
    final List<Map<String, dynamic>> days = _toMaps(_s['expense_by_day']);
    final List<Map<String, dynamic>> months = _toMaps(_s['expense_by_month']);
    final double purchase = wsD(_s['purchase']);
    final double brush = wsD(_s['brush_cost']);
    final double total = _s['total_expense'] != null ? wsD(_s['total_expense']) : purchase + wsD(_s['expense']) + brush;

    final bool stale = _s['expense_by_day'] is! List ||
        _s['expense_by_month'] is! List ||
        days.any((r) => r['purchase'] == null) ||
        months.any((r) => r['purchase'] == null);
    final String emptyText = stale ? '明细为空：后端未返回明细数据（请更新并重启后端服务）' : '本期无支出';

    final String hint = total != 0
        ? '按日 / 按月列出各项支出，合计 ${wsMoney(total)} ＝ 采购 ＋ 其他开支 ＋ 手工记账 ＋ 刷单成本'
            ' · 点日期或金额可展开该日/该月的构成明细'
        : '本期无支出';
    final Map<String, dynamic> pend = (_s['pending'] as Map?)?.cast<String, dynamic>() ?? const {};
    final double pAmt = wsD(pend['payables_amount']);
    final double rAmt = wsD(pend['receivables_amount']);
    final String pendText = (pAmt != 0 || rAmt != 0)
        ? ' · 另有 ${wsI(pend['payables_count'])} 笔待付款 ${wsMoney(pAmt)}'
            '${rAmt != 0 ? ' / ${wsI(pend['receivables_count'])} 笔待收款 ${wsMoney(rAmt)}' : ''}'
            ' 未计入（到「待付款账单」点「已支付」后按原日期计入）'
        : '';
    final bool withDayNotice = days.length > _kMaxDayRows;

    final List<Map<String, dynamic>> current = _expByMonth ? months : days;
    final List<Map<String, dynamic>> chartRows =
        current.length > _kMaxChartBars ? current.sublist(0, _kMaxChartBars) : current;

    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCardHead(
            title: '支出统计',
            icon: SolarIconsOutline.chart,
            trailing: DesktopTabs(
              small: true,
              items: const ['按日', '按月'],
              index: _expByMonth ? 1 : 0,
              onChanged: (i) => setState(() => _expByMonth = i == 1),
            ),
          ),
          Text('$hint$pendText${withDayNotice ? ' · 按日仅列最近 $_kMaxDayRows 天' : ''}',
              style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          const SizedBox(height: 12),
          if (stale)
            const DesktopNotice(
              '明细数据缺失：后端未返回「按日 / 按月支出明细」或缺少采购字段，说明后端服务还是旧版本。'
              '请更新并重启后端后刷新本页。',
              kind: DesktopNoticeKind.warn,
            ),
          if (withDayNotice)
            const DesktopNotice(
                '按日明细较多，这里只列最近 90 天；更早的支出请看「按月」或把区间缩短。',
                kind: DesktopNoticeKind.info),
          if (chartRows.isNotEmpty) ...[
            DesktopBars(
              height: 130,
              color: WsTokens.primary,
              items: [
                for (final r in chartRows.reversed)
                  (label: wsS(r['date'] ?? r['month']), value: wsD(r['total'])),
              ],
            ),
            DesktopBarLabels(
              labels: [
                for (final r in chartRows.reversed)
                  (_expByMonth ? wsS(r['month']) : wsS(r['date']).length >= 10 ? wsS(r['date']).substring(5) : wsS(r['date'])),
              ],
            ),
            const SizedBox(height: 16),
          ],
          _expenseTable(current, byMonth: _expByMonth, emptyText: emptyText, total: total),
        ],
      ),
    );
  }

  Widget _expenseTable(
    List<Map<String, dynamic>> rows, {
    required bool byMonth,
    required String emptyText,
    required double total,
  }) {
    int sumCount(List<Map<String, dynamic>> src) => src.fold<int>(0, (a, r) => a + wsI(r['count']));
    String keyOf(Map<String, dynamic> r) => wsS(r['date'] ?? r['month']).replaceAll(RegExp(r'[^0-9A-Za-z-]'), '');
    String pctOf(double v) => total == 0 ? '0.0%' : '${(v / total * 100).clamp(0, 100).toStringAsFixed(1)}%';

    Widget amountCell(Map<String, dynamic> r, String field, Color color, String kind, String tip) {
      final double v = wsD(r[field]);
      final String key = keyOf(r);
      return ReportMoneyCell(
        text: v == 0 ? '—' : wsMoney(v),
        color: color,
        onTap: v == 0 ? null : () => _openDrill(key, kind),
        tip: tip,
      );
    }

    Widget drilled(String text, String key, String kind, String tip, {bool bold = false}) => ReportMoneyCell(
          text: text,
          bold: bold,
          onTap: () => _openDrill(key, kind),
          tip: tip,
        );

    return DesktopGrid(
      dense: true,
      emptyText: rows.isEmpty ? emptyText : '暂无数据',
      cols: [
        DesktopCol(byMonth ? '月份' : '日期', width: 110),
        const DesktopCol('采购支出', width: 120, right: true),
        const DesktopCol('其他开支', width: 120, right: true),
        const DesktopCol('手工记账', width: 120, right: true),
        const DesktopCol('刷单成本', width: 120, right: true),
        const DesktopCol('支出合计', width: 130, right: true),
        DesktopCol(byMonth ? '环比' : '占比', width: 110, right: true),
        const DesktopCol('笔数', width: 80, right: true),
      ],
      rows: [
        for (var i = 0; i < rows.length; i++)
          DesktopRow(
            cells: [
              drilled(wsS(rows[i]['date'] ?? rows[i]['month']), keyOf(rows[i]), '', byMonth ? '展开当月全部支出明细' : '展开当天全部支出明细'),
              amountCell(rows[i], 'purchase', const Color(0xFF1989FA), 'purchase', '展开采购支出构成'),
              amountCell(rows[i], 'other_expense', const Color(0xFFF97316), 'other', '展开其他开支构成'),
              amountCell(rows[i], 'manual_expense', const Color(0xFF6366F1), 'manual', '展开手工记账构成'),
              amountCell(rows[i], 'brush_expense', const Color(0xFFE11D48), 'brush', '展开刷单成本构成（放单仓刷单单）'),
              () {
                final double t = wsD(rows[i]['total']);
                return ReportMoneyCell(
                  text: t == 0 ? '—' : wsMoney(t),
                  bold: true,
                  onTap: t == 0 ? null : () => _openDrill(keyOf(rows[i]), ''),
                  tip: '展开全部支出明细',
                );
              }(),
              byMonth
                  ? wsCell(_monthDelta(rows, i), color: _monthDeltaColor(rows, i))
                  : wsCell(pctOf(wsD(rows[i]['total']))),
              wsCell(wsI(rows[i]['count']).toString()),
            ],
          ),
        if (rows.isNotEmpty)
          DesktopRow(
            highlight: true,
            cells: [
              wsCell('合计（${rows.length} ${byMonth ? '个月' : '天'} · ${sumCount(rows)} 笔）', bold: true),
              drilled(wsMoney(wsD(_s['purchase'])), '', 'purchase', '展开本期采购构成', bold: true),
              drilled(wsMoney(wsD(_s['other_expense'])), '', 'other', '展开本期其他开支构成', bold: true),
              drilled(wsMoney(wsD(_s['manual_expense'])), '', 'manual', '展开本期手工记账构成', bold: true),
              drilled(wsMoney(wsD(_s['brush_cost'])), '', 'brush', '展开本期刷单成本明细', bold: true),
              drilled(wsMoney(total), '', '', '展开本期全部支出明细', bold: true),
              wsCell(''),
              wsCell(sumCount(rows).toString(), bold: true),
            ],
          ),
      ],
    );
  }

  /// 按月表里的环比：倒序排列，下一项即上一个月（首月无环比）
  String _monthDelta(List<Map<String, dynamic>> months, int i) {
    if (i + 1 >= months.length) return '—';
    final double prev = wsD(months[i + 1]['total']);
    if (prev == 0) return '—';
    final double delta = (wsD(months[i]['total']) - prev) / prev * 100;
    return '${delta >= 0 ? '+' : ''}${delta.toStringAsFixed(1)}%';
  }

  Color _monthDeltaColor(List<Map<String, dynamic>> months, int i) {
    if (i + 1 >= months.length) return WsTokens.mutedLight;
    final double prev = wsD(months[i + 1]['total']);
    if (prev == 0) return WsTokens.mutedLight;
    final double delta = (wsD(months[i]['total']) - prev) / prev * 100;
    return delta >= 0 ? WsTokens.red : WsTokens.green;
  }

  /// 支出明细（逐笔）：来源 + 关键字前端筛选，合计口径与「支出合计」一致
  Widget _expenseItemsCard() {
    final List<Map<String, dynamic>> all = _expItems;
    final bool apiOk = _s['expense_items'] is List;
    final String kw = _expKwCtrl.text.trim().toLowerCase();
    final List<Map<String, dynamic>> filtered = all.where((r) {
      if (_expSrc.isNotEmpty && wsS(r['source']) != _expSrc) return false;
      if (kw.isEmpty) return true;
      return [
        r['date'],
        r['source'],
        r['category'],
        r['item'],
        r['remark'],
        r['operator'],
        r['ref'],
        r['warehouse'],
      ].join(' ').toLowerCase().contains(kw);
    }).toList();
    final List<Map<String, dynamic>> shown =
        filtered.length > _kMaxItemRows ? filtered.sublist(0, _kMaxItemRows) : filtered;
    final double sum = filtered.fold<double>(0, (a, r) => a + wsD(r['amount']));
    const String needRestart = '后端未返回逐笔明细字段（expense_items）：请更新并重启后端服务后刷新';
    final String sumText = !apiOk
        ? needRestart
        : '共 ${filtered.length} 笔 · 合计 ${wsMoney(sum)}'
            '${filtered.length > _kMaxItemRows ? '（仅列最近 $_kMaxItemRows 笔，可用筛选缩小范围）' : ''}';
    final String emptyText = !apiOk
        ? needRestart
        : (all.isNotEmpty ? '没有符合筛选条件的支出' : '本期无支出');

    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const WsCardHead(
            title: '支出明细（逐笔）',
            icon: SolarIconsOutline.billList,
            trailing: Text('采购 / 其他开支 / 手工记账 / 刷单成本逐条列出，合计与「支出合计」一致',
                style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ),
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Wrap(
              spacing: 12,
              runSpacing: 10,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                DesktopLabeled(
                  label: '来源',
                  child: DesktopSelect<String>(
                    width: 170,
                    value: _expSrc,
                    options: [
                      const DesktopOption('', '全部来源'),
                      const DesktopOption('采购', '采购（进货）'),
                      DesktopOption('其他开支',
                          _s['exclude_other_expense'] == true ? '其他开支（已排除）' : '其他开支'),
                      const DesktopOption('手工记账', '手工记账'),
                      const DesktopOption('刷单成本', '刷单成本'),
                    ],
                    onChanged: (v) => setState(() => _expSrc = v ?? ''),
                  ),
                ),
                DesktopTextField(
                  controller: _expKwCtrl,
                  width: 260,
                  hintText: '筛选项目 / 备注 / 操作员…',
                  onChanged: (_) => setState(() {}),
                ),
                if (kw.isNotEmpty)
                  DesktopButton(label: '清空', small: true, onPressed: () => setState(() => _expKwCtrl.text = '')),
                Text(sumText, style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              ],
            ),
          ),
          DesktopGrid(
            dense: true,
            emptyText: emptyText,
            cols: [
              if (_isAll) const DesktopCol('分仓', width: 110),
              const DesktopCol('日期', width: 100),
              const DesktopCol('来源', width: 140),
              const DesktopCol('项目', width: 230),
              const DesktopCol('金额', width: 120, right: true),
              const DesktopCol('操作员', width: 110),
              const DesktopCol('备注', width: 260),
            ],
            rows: [
              for (final r in shown)
                DesktopRow(
                  cells: [
                    if (_isAll) wsCell(wsS(r['warehouse']).isEmpty ? '—' : wsS(r['warehouse'])),
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
              if (filtered.isNotEmpty)
                DesktopRow(
                  highlight: true,
                  cells: [
                    if (_isAll) wsCell(''),
                    wsCell('合计', bold: true),
                    wsCell(_expSrc.isEmpty ? '全部来源' : _expSrc),
                    wsCell('${filtered.length} 笔'),
                    ReportMoneyCell(text: wsMoney(sum), bold: true),
                    wsCell(''),
                    wsCell(''),
                  ],
                ),
            ],
          ),
        ],
      ),
    );
  }

  // ==================== 分区 3：商品 ====================

  List<Widget> _goodsPanel() => [
        DesktopRise(index: 0, child: _productTableCard()),
        DesktopRise(index: 1, child: _salesBySpecCard()),
      ];

  String _wayText(Map<String, dynamic> p) =>
      p['is_warehouse_in'] == true ? '入仓' : (p['is_dropship'] == true ? '代发' : '库存出库');

  Color _wayColor(Map<String, dynamic> p) => switch (_wayText(p)) {
        '入仓' => WsTokens.amber,
        '代发' => kReportIncome,
        _ => const Color(0xFF969799),
      };

  /// 总成本：后端 total_cogs 优先，缺失时退回商品成本 cogs
  double _totalCogs(Map<String, dynamic> p) => wsD(p['total_cogs'] ?? p['cogs']);

  /// 取第一个非 0 的数值（对应网页端 `Number(a) || Number(b) || 0`）
  double _orNum(dynamic a, dynamic b) {
    final double x = wsD(a);
    return x != 0 ? x : wsD(b);
  }

  /// 毛利率：（收入 + 代收 − 总成本）/（扣点前销售额 + 代收）；后端给了 gp_rate 就用它
  String _goodsRate(Map<String, dynamic> p) {
    final double settle = wsD(p['settle_income']);
    final double base = _orNum(p['gross_sales'], p['amount']) + settle;
    if (base == 0) return '—';
    if (p['gp_rate'] != null) return '${wsD(p['gp_rate']).toStringAsFixed(1)}%';
    final double total = _totalCogs(p);
    return '${((wsD(p['amount']) + settle - total) / base * 100).toStringAsFixed(1)}%';
  }

  /// 成本构成小字（网页端 costSplitText）
  String _costSplitText(Map<String, dynamic> p) {
    final double goods = wsD(p['goods_cogs'] ?? p['base_cogs'] ?? p['cogs']);
    final double express = wsD(p['express_cogs']);
    final double oldPack = wsD(p['pack_cogs']);
    final bool split = p['labor_cogs'] != null || p['material_cogs'] != null || p['other_cogs'] != null;
    final double labor = split ? wsD(p['labor_cogs']) : 0;
    final double material = split ? wsD(p['material_cogs']) : 0;
    final double other = split ? wsD(p['other_cogs']) : 0;
    final double brush = wsD(p['brush_cogs']);
    final bool isWi = p['is_warehouse_in'] == true;
    final bool isDrop = p['is_dropship'] == true;
    if (brush != 0) {
      final double brushFee = wsD(p['brush_fee_cogs']);
      final double brushCost = wsD(p['brush_cost_cogs']);
      return [
        if (brushFee != 0) '快递+包装 ${wsMoney(brushFee)}',
        if (brushCost != 0) '刷单成本 ${wsMoney(brushCost)}',
      ].join(' ＋ ');
    }
    if (!(isDrop || oldPack != 0 || express != 0 || labor != 0 || material != 0 || other != 0)) return '';
    final List<String> parts = ['${isDrop ? '代发成本' : '商品成本'} ${wsMoney(goods)}'];
    if (split) {
      if (labor != 0) parts.add('打包人工 ${wsMoney(labor)}');
      if (material != 0) parts.add('${isWi ? '包材' : '耗材'} ${wsMoney(material)}');
      if (other != 0) parts.add('其他关联结算 ${wsMoney(other)}');
    } else if (oldPack != 0) {
      parts.add('打包人工+耗材 ${wsMoney(oldPack)}');
    }
    if (express != 0) parts.add('${isWi ? '运费' : '快递费'} ${wsMoney(express)}');
    return parts.join(' ＋ ');
  }

  List<Map<String, dynamic>> get _goodsRows {
    final String kw = _goodsKwCtrl.text.trim().toLowerCase();
    final List<Map<String, dynamic>> all = _toMaps(_prodRows);
    final List<Map<String, dynamic>> hit = kw.isEmpty
        ? all
        : all
            .where((p) => '${wsS(p['name'])} ${wsS(p['spec'])} ${_wayText(p)} ${wsS(p['source'])}'
                .toLowerCase()
                .contains(kw))
            .toList();
    if (_goodsSortKey.isEmpty) return hit;
    return _sorted(hit, (p) => _goodsSortValue(p, _goodsSortKey), _goodsSortAsc);
  }

  dynamic _goodsSortValue(Map<String, dynamic> p, String key) => switch (key) {
        'name' => wsS(p['name']),
        'is_dropship' => p['is_warehouse_in'] == true ? 2 : (p['is_dropship'] == true ? 1 : 0),
        'qty' => wsD(p['qty']),
        'weight_kg' => wsD(p['weight_kg']),
        'amount' => wsD(p['amount']),
        'cogs' => _totalCogs(p),
        'gross' => wsD(p['gross_profit']),
        _ => wsD(p['amount']),
      };

  /// 合计：销量 / 重量 / 收入 / 客户代收 / 总成本（毛利率在渲染时按合计值现算）
  _GoodsSum _sumGoods(List<Map<String, dynamic>> rows) {
    double qty = 0, weight = 0, amount = 0, settle = 0, cogs = 0;
    for (final p in rows) {
      qty += wsD(p['qty']);
      weight += wsD(p['weight_kg']);
      amount += wsD(p['amount']);
      settle += wsD(p['settle_income']);
      cogs += _totalCogs(p);
    }
    return (qty: qty, weight: weight, amount: amount, settle: settle, cogs: cogs);
  }

  Widget _productTableCard() {
    final List<Map<String, dynamic>> all = _toMaps(_prodRows);
    final List<Map<String, dynamic>> rows = _goodsRows;
    final String kw = _goodsKwCtrl.text.trim();
    final String hint = all.isEmpty
        ? ''
        : (kw.isEmpty ? '共 ${all.length} 个商品' : '匹配 ${rows.length} / ${all.length} 个商品');
    final _GoodsSum filteredSum = _sumGoods(rows);
    final _GoodsSum wholeSum = _sumGoods(all);

    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCardHead(
            title: '商品销售明细',
            icon: SolarIconsOutline.bag,
            trailing: Row(
              children: [
                DesktopTextField(
                  controller: _goodsKwCtrl,
                  width: 250,
                  hintText: '筛选 商品名称 / 规格 / 出库方式（入仓、代发）…',
                  onChanged: (_) => setState(() {}),
                ),
                const SizedBox(width: 8),
                DesktopButton(
                  label: '清除',
                  small: true,
                  onPressed: () => setState(() => _goodsKwCtrl.text = ''),
                ),
                if (hint.isNotEmpty) ...[
                  const SizedBox(width: 10),
                  Text(hint, style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                ],
                const SizedBox(width: 10),
                const Text('成本为总成本',
                    style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              ],
            ),
          ),
          DesktopGrid(
            cols: const [
              DesktopCol('商品', width: 260, sortKey: 'name'),
              DesktopCol('出库方式', width: 110, sortKey: 'is_dropship'),
              DesktopCol('销量', width: 100, right: true, sortKey: 'qty'),
              DesktopCol('重量(kg)', width: 96, right: true, sortKey: 'weight_kg'),
              DesktopCol('收入', width: 130, right: true, sortKey: 'amount'),
              DesktopCol('总成本', width: 120, right: true, sortKey: 'cogs'),
              DesktopCol('毛利', width: 110, right: true, sortKey: 'gross'),
              DesktopCol('毛利率', width: 88, right: true),
            ],
            emptyText: all.isEmpty
                ? '本期无销售'
                : '没有匹配「$kw」的商品，换个关键词试试',
            sortKey: _goodsSortKey.isEmpty ? null : _goodsSortKey,
            sortAsc: _goodsSortAsc,
            onSort: (key) => setState(() {
              if (_goodsSortKey == key) {
                _goodsSortAsc = !_goodsSortAsc;
              } else {
                _goodsSortKey = key;
                _goodsSortAsc = false;
              }
            }),
            rows: [
              for (final p in rows) _productRow(p),
              if (rows.isNotEmpty) ...[
                _goodsFoot(kw.isEmpty ? '本期合计' : '筛选合计', filteredSum, rows.length, highlight: true),
                if (kw.isNotEmpty) _goodsFoot('本期合计', wholeSum, all.length),
              ],
            ],
          ),
        ],
      ),
    );
  }

  /// 底部合计行：商品数 / 销量 / 重量 / 收入（含代收）/ 总成本 / 毛利 / 毛利率
  /// 网页端只有一行；筛选生效时额外补一行「本期合计」，方便对比筛选占比。
  DesktopRow _goodsFoot(String label, _GoodsSum sum, int count, {bool highlight = false}) {
    final double income = sum.amount + sum.settle;
    final double gross = income - sum.cogs;
    final Color color = gross >= 0 ? WsTokens.green : WsTokens.red;
    return DesktopRow(
      highlight: highlight,
      cells: [
        wsCell('$label　$count 个商品', bold: highlight),
        wsCell(''),
        wsCell(_qty(sum.qty), bold: highlight),
        wsCell(sum.weight == 0 ? '—' : sum.weight.toStringAsFixed(2), bold: highlight),
        ReportMoneyCell(
          text: wsMoney(income),
          sub: sum.settle == 0 ? null : '含代收 ${wsMoney(sum.settle)}',
          bold: highlight,
          tip: sum.settle == 0
              ? null
              : '客户随货款一起付的包材/人工/快递费（成本里已含，收入侧也计一笔）',
        ),
        ReportMoneyCell(text: wsMoney(sum.cogs), bold: highlight),
        ReportMoneyCell(text: wsMoney(gross), color: color, bold: highlight),
        wsCell(_rate(gross, income), bold: highlight),
      ],
    );
  }

  DesktopRow _productRow(Map<String, dynamic> p) {
    final double settle = wsD(p['settle_income']);
    final double total = _totalCogs(p);
    final double gross = wsD(p['amount']) + settle - total;
    final Color color = gross >= 0 ? WsTokens.green : WsTokens.red;
    final String way = _wayText(p);
    final String spec = wsS(p['spec']).trim();
    final String source = wsS(p['source']).trim();
    final String split = _costSplitText(p);
    final double weight = wsD(p['weight_kg']);

    return DesktopRow(
      cells: [
        ReportStackedCell(
          main: wsS(p['name']).isEmpty ? '（未命名）' : wsS(p['name']),
          sub: [
            if (spec.isNotEmpty) '规格 $spec',
            if (split.isNotEmpty) split,
          ].join(' · '),
          maxLines: 1,
        ),
        Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DesktopTag(way, color: _wayColor(p)),
            if (source.isNotEmpty)
              Text(source,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight)),
          ],
        ),
        ReportMoneyCell(text: '${_qty(p['qty'])}${wsS(p['unit'])}'),
        ReportMoneyCell(text: weight == 0 ? '—' : weight.toStringAsFixed(2)),
        ReportMoneyCell(
          text: wsMoney(wsD(p['amount']) + settle),
          sub: settle == 0 ? null : '含代收 ${wsMoney(settle)}',
          tip: settle == 0
              ? null
              : '客户随货款一起付的包材/人工/快递费（成本里已含，收入侧也计一笔）',
        ),
        ReportMoneyCell(text: wsMoney(total)),
        ReportMoneyCell(text: wsMoney(gross), color: color),
        wsCell(_goodsRate(p), color: color),
      ],
    );
  }

  /// 单日 × 单规格单元格：「N 单」＋「数量单位 · 代发X」；当天该规格无出库时显示 —
  /// （对应网页端 renderSalesBySpec 的 cellTd）
  Widget _specCell(Map<String, dynamic> dayCells, String specName) {
    final Map<String, dynamic> c = (dayCells[specName] as Map?)?.cast<String, dynamic>() ?? const {};
    if (c.isEmpty) return wsCell('—');
    final double drop = wsD(c['dropship_qty']);
    return ReportStackedCell(
      main: '${wsI(c['orders'])} 单',
      sub: '${_qty(c['qty'])}${wsS(c['unit'])}${drop != 0 ? ' · 代发${_qty(drop)}' : ''}',
      maxLines: 1,
    );
  }

  /// 出库明细（按天 × 规格）
  Widget _salesBySpecCard() {
    final Map<String, dynamic> d = _specData;
    final List<dynamic> specs = (d['specs'] as List?)?.cast<dynamic>() ?? const [];
    final List<Map<String, dynamic>> rows = _toMaps(d['rows']);
    final Map<String, dynamic> tot = (d['totals'] as Map?)?.cast<String, dynamic>() ?? const {};
    final double dropQty = wsD(tot['dropship_qty']);
    final double dropCogs = wsD(tot['dropship_cogs']);
    final String hint = '共 ${wsI(tot['days'])} 天 · ${wsI(tot['orders'])} 单 · ${specs.length} 种规格'
        '${(dropQty != 0 || dropCogs != 0) ? ' · 其中代发 ${_qty(dropQty)} / 代发成本 ${wsMoney(dropCogs)}' : ''}'
        ' · 含全部出库单（不区分是否已收款）';

    final List<DesktopCol> cols = [
      const DesktopCol('日期', width: 110),
      for (final s in specs)
        DesktopCol(
          '${wsS(s['name'])}${wsD(s['dropship_qty']) != 0 ? '（代发）' : ''}',
          width: 104,
          right: true,
          tip: '${wsS(s['name'])}：${wsI(s['orders'])} 单 · ${_qty(s['qty'])}${wsS(s['unit'])}'
              '${wsD(s['dropship_qty']) != 0 ? ' · 代发${_qty(s['dropship_qty'])}' : ''}',
        ),
      const DesktopCol('当天单数', width: 90, right: true),
      const DesktopCol('当天数量', width: 100, right: true),
      const DesktopCol('当天金额', width: 110, right: true),
      const DesktopCol('代发数量', width: 100, right: true),
      const DesktopCol('代发成本', width: 110, right: true),
    ];

    Map<String, dynamic> cellsOf(Map<String, dynamic> r) =>
        (r['cells'] as Map?)?.cast<String, dynamic>() ?? const {};

    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCardHead(
            title: '出库明细：每天 × 每种规格卖了多少单',
            icon: SolarIconsOutline.calendarMinimalistic,
            trailing: Row(
              children: [
                Text(hint, style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                const SizedBox(width: 12),
                DesktopButton(
                  label: '去看出库记录 →',
                  small: true,
                  onPressed: () => widget.onNavigate('/outbound'),
                ),
              ],
            ),
          ),
          const Text('这里不区分是否已收款（只看实际发出的货）',
              style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
          const SizedBox(height: 12),
          DesktopGrid(
            dense: true,
            cols: cols,
            emptyText: rows.isEmpty ? '本期无出库' : '暂无数据',
            rows: [
              for (final r in rows)
                DesktopRow(
                  cells: [
                    wsCell(wsS(r['date'])),
                    for (final s in specs) _specCell(cellsOf(r), wsS(s['name'])),
                    wsCell(wsI(r['orders']).toString(), bold: true),
                    wsCell(_qty(r['qty'])),
                    wsCell(wsMoney(wsD(r['amount']))),
                    wsCell(wsD(r['dropship_qty']) == 0 ? '—' : _qty(r['dropship_qty']),
                        color: WsTokens.red),
                    wsCell(wsD(r['dropship_cogs']) == 0 ? '—' : wsMoney(wsD(r['dropship_cogs'])),
                        color: WsTokens.red),
                  ],
                ),
              if (rows.isNotEmpty)
                DesktopRow(
                  highlight: true,
                  cells: [
                    wsCell('合计', bold: true),
                    for (final s in specs)
                      ReportStackedCell(
                        main: '${wsI(s['orders'])} 单',
                        sub: '${_qty(s['qty'])}${wsS(s['unit'])}',
                        maxLines: 1,
                      ),
                    wsCell(wsI(tot['orders']).toString(), bold: true),
                    wsCell(_qty(tot['qty']), bold: true),
                    wsCell(wsMoney(wsD(tot['amount'])), bold: true),
                    wsCell(dropQty == 0 ? '—' : _qty(dropQty), bold: true),
                    wsCell(dropCogs == 0 ? '—' : wsMoney(dropCogs), bold: true),
                  ],
                ),
            ],
          ),
        ],
      ),
    );
  }

  // ==================== 分区 4：流水 ====================

  List<Widget> _flowPanel() {
    final String kw = _flowKwCtrl.text.trim().toLowerCase();
    final List<Map<String, dynamic>> all = _toMaps(_flow);
    final List<Map<String, dynamic>> hit = kw.isEmpty
        ? all
        : all
            .where((f) => [
                  f['category'],
                  f['product_name'],
                  f['remark'],
                  f['operator'],
                  f['type'],
                  f['warehouse'],
                ].join(' ')
                    .toLowerCase()
                    .contains(kw))
            .toList();
    final List<Map<String, dynamic>> rows = _flowSortKey.isEmpty
        ? hit
        : _sorted(hit, (f) => _flowSortValue(f, _flowSortKey), _flowSortAsc);
    final bool withWh = _isAll;

    return [
      DesktopRise(
        index: 0,
        child: WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              WsCardHead(
                title: '财务流水',
                icon: SolarIconsOutline.transferHorizontal,
                trailing: DesktopButton(
                  label: '＋ 手动记账',
                  icon: SolarIconsOutline.plus,
                  small: true,
                  onPressed: _openFinanceDialog,
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Wrap(
                  spacing: 12,
                  runSpacing: 10,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    DesktopTextField(
                      controller: _flowKwCtrl,
                      width: 280,
                      hintText: '筛选分类 / 商品 / 备注 / 操作员…',
                      onChanged: (_) => setState(() {}),
                    ),
                    if (kw.isNotEmpty)
                      DesktopButton(
                          label: '清空', small: true, onPressed: () => setState(() => _flowKwCtrl.text = '')),
                    Text(
                      kw.isEmpty
                          ? '共 ${all.length} 笔'
                          : '匹配 ${rows.length} / ${all.length} 笔',
                      style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight),
                    ),
                  ],
                ),
              ),
              DesktopGrid(
                cols: [
                  if (withWh) const DesktopCol('分仓', width: 110),
                  const DesktopCol('类型', width: 84, center: true),
                  const DesktopCol('分类', width: 130, sortKey: 'category'),
                  const DesktopCol('商品', width: 160, sortKey: 'product_name'),
                  const DesktopCol('金额', width: 130, right: true, sortKey: 'amount'),
                  const DesktopCol('操作员', width: 110, sortKey: 'operator'),
                  const DesktopCol('日期', width: 110, sortKey: 'date'),
                  const DesktopCol('备注', width: 260),
                  const DesktopCol('操作', width: 76, center: true),
                ],
                emptyText: '本期无财务流水',
                sortKey: _flowSortKey.isEmpty ? null : _flowSortKey,
                sortAsc: _flowSortAsc,
                onSort: (key) => setState(() {
                  if (_flowSortKey == key) {
                    _flowSortAsc = !_flowSortAsc;
                  } else {
                    _flowSortKey = key;
                    _flowSortAsc = false;
                  }
                }),
                rows: [for (final f in rows) _flowRow(f, withWh)],
              ),
            ],
          ),
        ),
      ),
    ];
  }

  dynamic _flowSortValue(Map<String, dynamic> f, String key) => switch (key) {
        'category' => wsS(f['category']),
        'product_name' => wsS(f['product_name']),
        'amount' => wsD(f['amount']),
        'operator' => wsS(f['operator']),
        'date' => wsS(f['date']),
        _ => wsI(f['id']),
      };

  DesktopRow _flowRow(Map<String, dynamic> f, bool withWh) {
    final bool income = wsS(f['type']) == 'income';
    final double amount = wsD(f['amount']);
    final bool manual = wsS(f['ref_type']) == 'manual';
    final Color color = income ? kReportIncome : kReportExpense;
    return DesktopRow(
      tag: f['id'],
      cells: [
        if (withWh) wsCell(wsS(f['warehouse']).isEmpty ? '—' : wsS(f['warehouse'])),
        DesktopTag(income ? '收入' : '支出', color: income ? DesktopTag.income : DesktopTag.expense),
        wsCell(wsS(f['category'])),
        wsCell(wsS(f['product_name']).isEmpty ? '—' : wsS(f['product_name'])),
        ReportMoneyCell(
          text: '${income ? '+' : '-'}${wsMoney(amount)}',
          color: color,
          bold: true,
        ),
        wsCell(wsS(f['operator']).isEmpty ? '—' : wsS(f['operator'])),
        wsCell(wsS(f['date'])),
        wsCell(wsS(f['remark']), tip: wsS(f['remark'])),
        manual
            ? DesktopLink('删', color: WsTokens.red, onPressed: () => _deleteFinance(f))
            : wsCell(''),
      ],
    );
  }
}
