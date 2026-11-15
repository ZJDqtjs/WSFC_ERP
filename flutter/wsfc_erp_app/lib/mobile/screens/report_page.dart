import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../../services/api_service.dart';
import '../mobile_style.dart';
import '../widgets/mobile_page.dart';
import '../widgets/parts.dart';

/// 移动端「财务报表」：与桌面端 / PWA 对齐的三张表 —— 利润表 / 现金流量表 / 余额表。
///
/// 口径全部以后端 report.py 为准：
/// - `/api/report/summary`：只含已付款单据，期间费用 = 其他收支 + 手工记账；
/// - `/api/report/cashflow`：直接法·实收实付，只认已经收/付的钱；
/// - `/api/report/balances`：截至截止日的库存 / 往来 / 广告预付 / 盘点差异。
class MobileReportPage extends StatefulWidget {
  const MobileReportPage({super.key});

  @override
  State<MobileReportPage> createState() => _MobileReportPageState();
}

class _MobileReportPageState extends State<MobileReportPage> {
  final NumberFormat _money =
      NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);
  final DateFormat _day = DateFormat('yyyy-MM-dd');

  int _tab = 0;
  late String _from;
  late String _to;

  Map<String, dynamic> _summary = const {};
  Map<String, dynamic> _cash = const {};
  Map<String, dynamic> _balance = const {};
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _from = _day.format(DateTime(now.year, now.month));
    _to = _day.format(now);
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> summary = await ApiService.reportSummary(
          dateFrom: _from, dateTo: _to);
      Map<String, dynamic> cash = _cash;
      Map<String, dynamic> balance = _balance;
      if (_tab == 1) {
        cash = await ApiService.reportCashflow(dateFrom: _from, dateTo: _to);
      } else if (_tab == 2) {
        balance = await ApiService.reportBalances(dateFrom: _from, dateTo: _to);
      }
      if (!mounted) return;
      setState(() {
        _summary = summary;
        _cash = cash;
        _balance = balance;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.message;
      });
    }
  }

  Future<void> _switchTab(int i) async {
    setState(() => _tab = i);
    if (i == 1 && _cash.isEmpty) {
      await _loadCash();
    } else if (i == 2 && _balance.isEmpty) {
      await _loadBalance();
    }
  }

  Future<void> _loadCash() async {
    try {
      final Map<String, dynamic> d =
          await ApiService.reportCashflow(dateFrom: _from, dateTo: _to);
      if (!mounted) return;
      setState(() {
        _cash = d;
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = '现金流量表加载失败：${e.message}');
    }
  }

  Future<void> _loadBalance() async {
    try {
      final Map<String, dynamic> d =
          await ApiService.reportBalances(dateFrom: _from, dateTo: _to);
      if (!mounted) return;
      setState(() {
        _balance = d;
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = '余额表加载失败：${e.message}');
    }
  }

  Future<void> _pickDate(bool isFrom) async {
    final DateTime initial =
        DateTime.tryParse(isFrom ? _from : _to) ?? DateTime.now();
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (picked == null) return;
    setState(() {
      if (isFrom) {
        _from = _day.format(picked);
      } else {
        _to = _day.format(picked);
      }
    });
    await _load();
  }

  double _d(dynamic v) {
    if (v is num) return v.toDouble();
    return double.tryParse(v?.toString() ?? '') ?? 0;
  }

  int _i(dynamic v) {
    if (v is num) return v.toInt();
    return int.tryParse(v?.toString() ?? '') ?? 0;
  }

  String _s(dynamic v) => v?.toString() ?? '';

  Widget _statPair(List<Widget> cards) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (int i = 0; i < cards.length; i++) ...[
            if (i > 0) const SizedBox(width: 10),
            Expanded(child: cards[i]),
          ],
        ],
      ),
    );
  }

  Widget _stat(String label, double value, {String? foot, Color? accent}) =>
      StatCard(
        label: label,
        value: value,
        format: _money.format,
        foot: foot,
        accent: accent,
      );

  Widget _row(String title, String? subtitle, {String? amount, Color? color}) =>
      TileRow(
        title: title,
        subtitle: subtitle,
        trailing: amount == null
            ? null
            : Text(
                amount,
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: color ?? Mc.ink,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
      );

  @override
  Widget build(BuildContext context) {
    return MobilePage(
      title: '财务报表',
      back: true,
      onRefresh: _load,
      underBar: GlassSegmentedControl(
        height: 38,
        selectedIndex: _tab,
        onSegmentSelected: _switchTab,
        segments: const [
          GlassSegment(label: '利润表'),
          GlassSegment(label: '现金流'),
          GlassSegment(label: '余额'),
        ],
      ),
      body: Stack(
        children: [
          ListView(
            padding: const EdgeInsets.fromLTRB(14, 4, 14, 28),
            children: [
              _rangeBar(),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: GlassPanel(
                    padding: const EdgeInsets.all(12),
                    child: Text(_error!,
                        style: const TextStyle(fontSize: 12.5, color: Mc.warn)),
                  ),
                ),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 40),
                  child: Center(
                    child: Text('正在汇总报表数据…',
                        style: TextStyle(fontSize: 13, color: Mc.inkThird)),
                  ),
                )
              else if (_tab == 0)
                ..._summaryView()
              else if (_tab == 1)
                ..._cashView()
              else
                ..._balanceView(),
            ],
          ),
        ],
      ),
    );
  }

  Widget _rangeBar() {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: GlassPanel(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          children: [
            TextButton(
              onPressed: () => _pickDate(true),
              child: Text(_from, style: const TextStyle(fontSize: 13)),
            ),
            const Text('~', style: TextStyle(color: Mc.inkThird)),
            TextButton(
              onPressed: () => _pickDate(false),
              child: Text(_to, style: const TextStyle(fontSize: 13)),
            ),
            const Spacer(),
            TextButton(
              onPressed: _load,
              child: const Text('查询', style: TextStyle(fontSize: 13)),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _summaryView() {
    final Map<String, dynamic> s = _summary;
    final double revenue = _d(s['revenue']);
    final double cogs = _d(s['cogs']);
    final double gross = _d(s['gross_profit']);
    final double expense = _d(s['expense']);
    final double net = _d(s['net_profit']);
    final double rate = revenue == 0 ? 0 : gross / revenue * 100;
    return [
      _statPair([
        _stat('销售收入', revenue, foot: '${_i(s['order_count'])} 单'),
        _stat('结转成本', cogs, accent: Mc.warn),
      ]),
      _statPair([
        _stat('毛利', gross,
            foot: revenue == 0 ? '—' : '毛利率 ${rate.toStringAsFixed(1)}%'),
        _stat('期间费用', expense,
            accent: Mc.danger,
            foot: '其他收支 ${_money.format(_d(s['other_expense']))} · 手工 ${_money.format(_d(s['manual_expense']))}'),
      ]),
      _statPair([
        _stat('净利润', net, accent: net >= 0 ? Mc.fresh : Mc.danger),
        _stat('本期进货', _d(s['purchase'])),
      ]),
      _statPair([
        _stat('本期总支出', _d(s['total_expense']), accent: Mc.danger),
        _stat('当前库存总值', _d(s['stock_value'])),
      ]),
    ];
  }

  List<Widget> _cashView() {
    final Map<String, dynamic> d = _cash;
    if (d.isEmpty) return const [];
    final Map<String, dynamic> inf =
        (d['inflow'] as Map?)?.cast<String, dynamic>() ?? const {};
    final Map<String, dynamic> out =
        (d['outflow'] as Map?)?.cast<String, dynamic>() ?? const {};
    final Map<String, dynamic> rng =
        (d['range'] as Map?)?.cast<String, dynamic>() ?? const {};
    final double net = _d(d['net']);
    final String range =
        '${_s(rng['date_from']).isEmpty ? '最早' : _s(rng['date_from'])} ~ '
        '${_s(rng['date_to']).isEmpty ? '最新' : _s(rng['date_to'])}';

    final List<(String, double, String)> inRows = [
      ('销售回款（退货已净掉）', _d(inf['sales']), '已回款出库单的实收金额'),
      ('入仓结算回款', _d(inf['warehouse_in']), '京东支付入仓货款'),
      ('手工记账收入', _d(inf['manual_income']), '财务流水页登记的收入'),
      ('其他收入（补偿/退款）', _d(inf['other_income']), '供应商补偿、负数其他收支'),
    ];
    final List<(String, double, String)> outRows = [
      ('采购付款', _d(out['purchase']), '已付入库单（含运费/装卸/手续费/金额调整）'),
      ('代发付款', _d(out['dropship']), '已付代发账单'),
      ('广告充值', _d(out['ad_prepay']), '充进京准通账户的预付款'),
      ('其他收支支出', _d(out['other_expense']), '手工登记的其他支出与赔付'),
      ('人工打包费', _d(out['pack_fee']), '出库带出的打包人工费'),
      ('手工记账支出', _d(out['manual_expense']), '财务流水页登记的支出'),
    ];

    return [
      _statPair([
        _stat('期初账面现金', _d(d['opening_cash']), foot: range),
        _stat('本期净现金流', net, accent: net >= 0 ? Mc.fresh : Mc.danger),
      ]),
      _statPair([
        _stat('经营流入', _d(inf['total']), accent: Mc.fresh),
        _stat('经营流出', _d(out['total']), accent: Mc.danger),
      ]),
      _statPair([
        _stat('期末账面现金', _d(d['closing_cash']), foot: '期初 + 本期净现金流'),
      ]),
      const SectionHeader(title: '经营活动现金流入'),
      GlassPanel(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Column(
          children: [
            for (final r in inRows)
              _row(r.$1, r.$3,
                  amount: _money.format(r.$2),
                  color: r.$2 < 0 ? Mc.danger : Mc.fresh),
            _row('流入合计', null,
                amount: _money.format(_d(inf['total'])), color: Mc.ink),
          ],
        ),
      ),
      const SectionHeader(title: '经营活动现金流出'),
      GlassPanel(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Column(
          children: [
            for (final r in outRows)
              _row(r.$1, r.$3, amount: _money.format(r.$2), color: Mc.danger),
            _row('流出合计', null,
                amount: _money.format(_d(out['total'])), color: Mc.ink),
          ],
        ),
      ),
    ];
  }

  List<Widget> _balanceView() {
    final Map<String, dynamic> d = _balance;
    if (d.isEmpty) return const [];
    final Map<String, dynamic> inv =
        (d['inventory'] as Map?)?.cast<String, dynamic>() ?? const {};
    final Map<String, dynamic> pay =
        (d['payables'] as Map?)?.cast<String, dynamic>() ?? const {};
    final Map<String, dynamic> rec =
        (d['receivables'] as Map?)?.cast<String, dynamic>() ?? const {};
    final Map<String, dynamic> ad =
        (d['ad_prepay'] as Map?)?.cast<String, dynamic>() ?? const {};
    final Map<String, dynamic> cd =
        (d['count_diff'] as Map?)?.cast<String, dynamic>() ?? const {};
    final int neg = _i(inv['negative_count']);
    final bool asOf = _s(inv['basis']) == 'as_of';

    String srcText(dynamic m) {
      final Map<String, dynamic> map =
          (m as Map?)?.cast<String, dynamic>() ?? const {};
      return map.entries
          .where((e) => _d(e.value).abs() >= 0.005)
          .map((e) => '${e.key} ${_money.format(_d(e.value))}')
          .join(' · ');
    }

    final String adDesc = ad['balance'] == null
        ? 'jdfenxi 广告费流水读取失败，可稍后刷新重试'
        : '来源 jdfenxi 广告费流水；当前可用余额 ${_money.format(_d(ad['balance_current']))}；'
            '区间充值 ${_money.format(_d(ad['recharged_period']))} − 消费 ${_money.format(_d(ad['spent_total']))}';

    final List<String> warnings = [
      for (final w in (d['warnings'] as List?) ?? const []) _s(w),
      for (final w in (ad['warnings'] as List?) ?? const []) _s(w),
    ].where((e) => e.isNotEmpty).toList();

    return [
      _statPair([
        _stat('库存结存总值', _d(inv['stock_value']),
            foot: '${_i(inv['product_count'])} 种商品'),
        _stat('广告账户余额', _d(ad['balance'])),
      ]),
      _statPair([
        _stat('应付未付', _d(pay['total']), accent: Mc.danger, foot: '要付出去'),
        _stat('应收未收', _d(rec['total']), accent: Mc.fresh, foot: '要收进来'),
      ]),
      const SectionHeader(title: '余额明细'),
      GlassPanel(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Column(
          children: [
            _row(
              '库存结存总值',
              '${neg > 0 ? '其中 $neg 个商品为负库存，需盘点冲正；' : ''}'
                  '${asOf ? '按 FIFO 回算到 ${_s(d['as_of'])}' : '按 FIFO 批次结存（当前库存）'}',
              amount: _money.format(_d(inv['stock_value'])),
            ),
            _row('广告账户可用余额', adDesc,
                amount: ad['balance'] == null
                    ? '—'
                    : _money.format(_d(ad['balance']))),
            _row('应付未付（要付出去）',
                srcText(pay['by_source']).isEmpty ? '没有未结清的应付款' : srcText(pay['by_source']),
                amount: _money.format(_d(pay['total'])), color: Mc.danger),
            _row('应收未收（要收进来）',
                srcText(rec['by_source']).isEmpty ? '没有未回款的应收款' : srcText(rec['by_source']),
                amount: _money.format(_d(rec['total'])), color: Mc.fresh),
            _row(
              '区间内盘点差异（未计入损益）',
              '盘盈 ${_money.format(_d(cd['gain_value']))}（${_i(cd['gain_lines'])} 笔） / '
                  '盘亏 ${_money.format(_d(cd['loss_value']))}（${_i(cd['loss_lines'])} 笔）'
                  '${_d(cd['booked_expense']) != 0 ? '；已记「库存损耗」' : '；盘亏只冲库存'}',
              amount: _money.format(_d(cd['net_value'])),
            ),
          ],
        ),
      ),
      if (warnings.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Text(
            '提示：${warnings.join('；')}',
            style: const TextStyle(fontSize: 11.5, color: Mc.warn),
          ),
        ),
    ];
  }
}
