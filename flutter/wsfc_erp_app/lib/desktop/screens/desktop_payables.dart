import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';
import 'package:solar_icons/solar_icons.dart';

/// 桌面端「待付款账单」页：1:1 复刻 web `#page-payables`（统计卡 + 账单 / 代发两个页签）。
///
/// 口径（backend/app/routers/payables.py）：
/// - 账单列表 = 入库 / 入仓 / 出库 / 其他开支 / 手动记账 里勾了「待付款」的单据；
///   代发**不进这张通用列表**，只在「代发」页签按「商品 + 规格 + 出库日期」分行；
/// - 点「已支付」= 按原日期计入财务报表，撤销则移出（代发只影响付款核对）；
/// - 已结清只返回最近 30 天（可撤销）；关键词与起止日期都是前端筛选。
class DesktopPayablesScreen extends StatefulWidget {
  const DesktopPayablesScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopPayablesScreen> createState() => _DesktopPayablesScreenState();
}

/// web PAY_SRC_BADGE：来源文字 → 徽标配色（in/income 绿、out/expense 红、pack 黄、adjust 蓝）
Color _srcColor(String source) => switch (source) {
      '入库' => WsTokens.green,
      '入仓' => WsTokens.green,
      '出库' => WsTokens.red,
      '其他开支' => WsTokens.red,
      '手动记账' => WsTokens.primary,
      '代发' => WsTokens.amber,
      _ => DesktopTag.off,
    };

/// 后端 SOURCE_PAGE → 桌面端路由（未移植的落到工作台，不让「查看」点了没反应）
String _routeOf(String page) => switch (page) {
      'inbound' => '/inbound',
      'warehouse-in' => '/warehouse-in',
      'outbound' => '/outbound',
      'otherexp' => '/expenses',
      'report' => '/finance',
      _ => '/home',
    };

const List<DesktopCol> _billCols = <DesktopCol>[
  DesktopCol('', width: 56, center: true, tip: '勾选后可批量标记已支付 / 撤销'),
  DesktopCol('日期', width: 104),
  DesktopCol('来源', width: 96),
  DesktopCol('具体事物 / 款项', width: 360),
  DesktopCol('金额', width: 210, right: true, tip: 'direction=in 为应收，direction=out 为应付'),
  DesktopCol('操作员', width: 90),
  DesktopCol('状态', width: 150),
  DesktopCol('操作', width: 150),
];

const List<DesktopCol> _dsCols = <DesktopCol>[
  DesktopCol('', width: 56, center: true, tip: '勾选后可批量标记已支付 / 撤销'),
  DesktopCol('日期', width: 104, right: true),
  DesktopCol('商品 / 规格', width: 340),
  DesktopCol('单量', width: 100, right: true, tip: '按下单单位的数量，4 位小数去尾零'),
  DesktopCol('单价', width: 100, right: true, tip: '成本单价 = 代发成本 ÷ 单量'),
  DesktopCol('应付金额', width: 130, right: true),
  DesktopCol('单据', width: 80, right: true, tip: '跨多张出库单合并，点开可看单号'),
  DesktopCol('操作', width: 130),
];

class _DesktopPayablesScreenState extends State<DesktopPayablesScreen> {
  final TextEditingController _searchCtl = TextEditingController();
  final TextEditingController _dsSearchCtl = TextEditingController();

  /// 0 = 账单，1 = 代发（web payTabSeg）
  int _tab = 0;

  // ---------------- 账单 ----------------
  bool _includePaid = false;
  String _keyword = '';
  String _dateFrom = '';
  String _dateTo = '';
  List<Map<String, dynamic>> _rows = const <Map<String, dynamic>>[];
  Map<String, dynamic> _total = const <String, dynamic>{};
  final Set<String> _picked = <String>{};
  bool _loading = false;
  bool _busy = false;
  String? _error;

  // ---------------- 代发 ----------------
  bool _dsIncludePaid = false;
  String _dsKeyword = '';
  String _dsFrom = '';
  String _dsTo = '';
  List<Map<String, dynamic>> _dsGroups = const <Map<String, dynamic>>[];
  Map<String, dynamic> _dsTotal = const <String, dynamic>{};
  bool _dsTruncated = false;
  int _dsLimit = 0;
  bool _dsLoaded = false;
  bool _dsLoading = false;
  String? _dsError;
  final Set<int> _dsPicked = <int>{};

  @override
  void initState() {
    super.initState();
    _loadBills();
  }

  @override
  void dispose() {
    _searchCtl.dispose();
    _dsSearchCtl.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------- 数据

  /// 拉账单列表；include_paid 切换时重新拉取，关键词 / 日期条件保留
  Future<void> _loadBills({bool clearPicked = false}) async {
    setState(() => _loading = true);
    try {
      final d = await ApiService.payables(includePaid: _includePaid);
      final items = (d['items'] as List?) ?? const <dynamic>[];
      final rows = items
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList(growable: false);
      if (!mounted) return;
      setState(() {
        _rows = rows;
        _total = Map<String, dynamic>.from((d['total'] as Map?) ?? const <dynamic, dynamic>{});
        _error = null;
        _loading = false;
        if (clearPicked) _picked.clear();
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '加载待付款账单失败：${e.message}';
      });
      wsToast(context, '加载待付款账单失败：${e.message}', error: true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '加载待付款账单失败：$e';
      });
      wsToast(context, '加载待付款账单失败：$e', error: true);
    }
  }

  /// 拉代发列表（日期由服务端过滤，改日期必须重新请求）
  Future<void> _loadDropship() async {
    setState(() => _dsLoading = true);
    try {
      final d = await ApiService.dropshipBills(
        dateFrom: _dsFrom.isEmpty ? null : _dsFrom,
        dateTo: _dsTo.isEmpty ? null : _dsTo,
        includePaid: _dsIncludePaid,
        limit: 300,
      );
      final groups = (d['groups'] as List?) ?? const <dynamic>[];
      final list = groups.map((e) => Map<String, dynamic>.from(e as Map)).toList(growable: false);
      if (!mounted) return;
      setState(() {
        _dsGroups = list;
        _dsTotal = Map<String, dynamic>.from((d['total'] as Map?) ?? const <dynamic, dynamic>{});
        _dsTruncated = d['truncated'] == true;
        _dsLimit = wsI(d['limit']);
        _dsLoaded = true;
        _dsLoading = false;
        _dsError = null;
        _dsPicked.clear();
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _dsLoading = false;
        _dsLoaded = true;
        _dsError = '加载代发应付失败：${e.message}';
      });
      wsToast(context, '加载代发应付失败：${e.message}', error: true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _dsLoading = false;
        _dsError = '加载代发应付失败：$e';
      });
      wsToast(context, '加载代发应付失败：$e', error: true);
    }
  }

  void _refresh() {
    _loadBills();
    if (_tab == 1 || _dsLoaded) _loadDropship();
  }

  // ---------------------------------------------------------------- 筛选

  /// 先关键词、再日期区间（date 为空的单据无法证明落在区间内，不计入合计）
  ({List<Map<String, dynamic>> rows, int undated, bool active}) _bills() {
    final kw = _keyword.toLowerCase();
    var list = _rows;
    if (kw.isNotEmpty) {
      list = list
          .where((r) => _billHaystack(r).toLowerCase().contains(kw))
          .toList(growable: false);
    }
    var undated = 0;
    if (_dateFrom.isNotEmpty || _dateTo.isNotEmpty) {
      final keep = <Map<String, dynamic>>[];
      for (final r in list) {
        final date = wsS(r['date']);
        if (date.isEmpty) {
          undated += 1;
          continue;
        }
        if (_dateFrom.isNotEmpty && date.compareTo(_dateFrom) < 0) continue;
        if (_dateTo.isNotEmpty && date.compareTo(_dateTo) > 0) continue;
        keep.add(r);
      }
      list = keep;
    }
    final active = kw.isNotEmpty || _dateFrom.isNotEmpty || _dateTo.isNotEmpty;
    return (rows: list, undated: undated, active: active);
  }

  String _billHaystack(Map<String, dynamic> r) => <Object?>[
        r['date'],
        r['source'],
        r['title'],
        r['sub'],
        r['code'],
        r['remark'],
        r['operator'],
      ].join(' ');

  ({List<Map<String, dynamic>> groups, bool active}) _dropshipRows() {
    final kw = _dsKeyword.toLowerCase();
    var list = _dsGroups;
    if (kw.isNotEmpty) {
      list = list.where((g) {
        final hay = <Object?>[g['product_name'], g['spec'], g['unit'], g['operator']].join(' ');
        return hay.toLowerCase().contains(kw);
      }).toList(growable: false);
    }
    if (_dsFrom.isNotEmpty || _dsTo.isNotEmpty) {
      // 日期已由服务端过滤，这里再兜一次防漏
      list = list.where((g) {
        final a = wsS(g['date_from']).isEmpty ? wsS(g['date_to']) : wsS(g['date_from']);
        final b = wsS(g['date_to']).isEmpty ? wsS(g['date_from']) : wsS(g['date_to']);
        if (a.isEmpty || b.isEmpty) return false;
        if (_dsTo.isNotEmpty && a.compareTo(_dsTo) > 0) return false;
        if (_dsFrom.isNotEmpty && b.compareTo(_dsFrom) < 0) return false;
        return true;
      }).toList(growable: false);
    }
    return (groups: list, active: kw.isNotEmpty || _dsFrom.isNotEmpty || _dsTo.isNotEmpty);
  }

  void _clearFilter() {
    _searchCtl.clear();
    setState(() {
      _keyword = '';
      _dateFrom = '';
      _dateTo = '';
      _picked.clear();
    });
  }

  void _clearDsFilter() {
    _dsSearchCtl.clear();
    setState(() {
      _dsKeyword = '';
      _dsFrom = '';
      _dsTo = '';
    });
    _loadDropship();
  }

  // ---------------------------------------------------------------- 动作

  bool _paid(Map<String, dynamic> r) => wsS(r['pay_status']) != 'unpaid';

  String _key(Map<String, dynamic> r) => '${wsS(r['kind'])}#${wsI(r['id'])}';

  /// 可见行里被勾选的账单（与网页端一致：只处理表格里勾着的行）
  List<Map<String, dynamic>> _pickedBills() =>
      _bills().rows.where((r) => _picked.contains(_key(r))).toList(growable: false);

  List<Map<String, dynamic>> _pickedGroups() {
    final shown = _dropshipRows().groups;
    final out = <Map<String, dynamic>>[];
    for (var i = 0; i < shown.length; i++) {
      if (_dsPicked.contains(i)) out.add(shown[i]);
    }
    return out;
  }

  void _togglePick(Map<String, dynamic> r, bool on) {
    setState(() {
      final k = _key(r);
      if (on) {
        _picked.add(k);
      } else {
        _picked.remove(k);
      }
    });
  }

  void _toggleAllBills() {
    final visible = _bills().rows;
    final allOn = visible.isNotEmpty && visible.every((r) => _picked.contains(_key(r)));
    setState(() {
      for (final r in visible) {
        if (allOn) {
          _picked.remove(_key(r));
        } else {
          _picked.add(_key(r));
        }
      }
    });
  }

  void _toggleAllGroups() {
    final shown = _dropshipRows().groups;
    final allOn = shown.isNotEmpty && List.generate(shown.length, (i) => i).every(_dsPicked.contains);
    setState(() {
      _dsPicked.clear();
      if (!allOn) {
        for (var i = 0; i < shown.length; i++) {
          _dsPicked.add(i);
        }
      }
    });
  }

  List<int> _billIdsOf(Map<String, dynamic> g) =>
      ((g['bill_ids'] as List?) ?? const <dynamic>[]).map((e) => wsI(e)).where((v) => v > 0).toList();

  /// 单笔标记已支付 / 撤销
  Future<void> _payOne(Map<String, dynamic> r, bool paid) async {
    final kind = wsS(r['kind']);
    final id = wsI(r['id']);
    final label = '${wsS(r['source'])}「${wsS(r['title'])}」${wsMoney(wsD(r['amount']))}';
    final isDs = kind == 'dropship';
    final ok = await wsConfirm(
      context,
      title: paid ? '确认已支付？' : '确认撤销？',
      message: '$label\n${isDs ? (paid ? '（代发成本只做付款核对，不影响财务报表）' : '（只撤销付款核对标记）') : (paid ? '确认后这笔将按原日期计入财务报表。' : '撤销后它会移出财务报表，回到待付款账单。')}',
      okLabel: paid ? '已支付' : '撤销',
      danger: !paid,
    );
    if (!ok) return;
    setState(() => _busy = true);
    try {
      await ApiService.payBill(kind, id, paid: paid);
      if (!mounted) return;
      wsToast(context, paid
          ? (isDs ? '已标记代发成本已支付' : '已标记已支付，已按原日期计入财务报表')
          : (isDs ? '已撤销付款标记' : '已撤销，已移出财务报表'));
      await _loadBills();
      if (_dsLoaded) await _loadDropship();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '操作失败：${e.message}', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 批量：按 kind 分组提交，代发行按出库单整单结清
  Future<void> _batchBills(bool paid) async {
    final picked = _pickedBills();
    if (picked.isEmpty) {
      wsToast(context, '请先勾选要处理的账单', error: true);
      return;
    }
    final amount = picked.fold<double>(0, (a, r) => a + wsD(r['amount']));
    final tip = paid
        ? '确认后这些将按原日期计入财务报表（代发只做付款核对、不进报表）。'
        : '撤销后会从财务报表移出（代发只撤销付款标记）。';
    final ok = await wsConfirm(
      context,
      title: paid ? '批量标记已支付' : '批量撤销',
      message: '${picked.length} 笔，合计 ${wsMoney(amount)}？\n$tip',
      okLabel: paid ? '已支付' : '撤销',
      danger: !paid,
    );
    if (!ok) return;
    final byKind = <String, List<int>>{};
    for (final r in picked) {
      byKind.putIfAbsent(wsS(r['kind']), () => <int>[]).add(wsI(r['id']));
    }
    setState(() => _busy = true);
    var updated = 0;
    var missing = 0;
    try {
      for (final entry in byKind.entries) {
        final res = await ApiService.payBillsBatch(entry.key, entry.value, paid: paid);
        updated += wsI(res['updated']);
        missing += wsI(res['missing']);
      }
      if (!mounted) return;
      wsToast(context, '已处理 $updated 笔${missing > 0 ? '，$missing 笔已不存在' : ''}');
      await _loadBills(clearPicked: true);
      if (_dsLoaded) await _loadDropship();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '批量操作失败：${e.message}', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 代发：一行可能跨多张出库单，单笔和批量都是 dropship_item + 扁平化 bill_ids
  Future<void> _dsMark(Map<String, dynamic> g, bool paid) async {
    final ids = _billIdsOf(g);
    if (ids.isEmpty) {
      wsToast(context, '这行没有可操作的代发账单', error: true);
      return;
    }
    final spec = wsS(g['spec']);
    final label = '${wsS(g['product_name'])}${spec.isEmpty ? '' : ' · $spec'}'
        '（${wsI(g['order_count'])} 单，代发成本 ${wsMoney(wsD(g['amount']))}）';
    final ok = await wsConfirm(
      context,
      title: paid ? '确认这批代发成本已付清？' : '确认撤销已付标记？',
      message: '$label\n（只影响代发付款核对，不影响财务报表）',
      okLabel: paid ? '已支付' : '撤销',
      danger: !paid,
    );
    if (!ok) return;
    setState(() => _busy = true);
    try {
      final res = await ApiService.payBillsBatch('dropship_item', ids, paid: paid);
      final missing = wsI(res['missing']);
      if (!mounted) return;
      wsToast(context, '${paid ? '已标记代发成本已支付' : '已撤销'}'
          '${missing > 0 ? '，$missing 行已不存在' : ''}');
      await _loadDropship();
      await _loadBills();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '操作失败：${e.message}', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _dsBatch(bool paid) async {
    final picked = _pickedGroups();
    final ids = picked.expand(_billIdsOf).toList();
    if (ids.isEmpty) {
      wsToast(context, '请先勾选要处理的商品规格', error: true);
      return;
    }
    final amount = picked.fold<double>(0, (a, g) => a + wsD(g['amount']));
    final orders = picked.fold<int>(0, (a, g) => a + wsI(g['order_count']));
    final ok = await wsConfirm(
      context,
      title: paid ? '批量标记已支付' : '批量撤销',
      message: '${picked.length} 款商品规格 / $orders 张出库单，'
          '代发成本合计 ${wsMoney(amount)}？\n（只影响代发付款核对，不影响财务报表）',
      okLabel: paid ? '已支付' : '撤销',
      danger: !paid,
    );
    if (!ok) return;
    setState(() => _busy = true);
    try {
      final res = await ApiService.payBillsBatch('dropship_item', ids, paid: paid);
      final updated = wsI(res['updated'], fallback: ids.length);
      final missing = wsI(res['missing']);
      if (!mounted) return;
      wsToast(context, '已处理 $updated 行${missing > 0 ? '，$missing 行已不存在' : ''}');
      await _loadDropship();
      await _loadBills();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '批量操作失败：${e.message}', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _showOrders(Map<String, dynamic> g) async {
    final ids = ((g['order_ids'] as List?) ?? const <dynamic>[]).map((e) => wsI(e)).toList();
    if (!mounted) return;
    await desktopDialog<void>(
      context,
      title: '涉及出库单（${ids.length} 张）',
      width: 400,
      builder: (dialogContext) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final id in ids)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: wsCell('#$id', tip: '出库单 id $id'),
            ),
          const SizedBox(height: 6),
          Align(
            alignment: Alignment.centerRight,
            child: DesktopLink(
              '去出库 / 销售',
              onPressed: () {
                Navigator.of(dialogContext).pop();
                widget.onNavigate('/outbound');
              },
            ),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------- 渲染

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '待付款账单',
      subtitle: '入库 / 入仓 / 出库 / 其他开支 / 手动记账 里勾了「待付款」的单据都汇总在这里；'
          '点「已支付」后按原日期纳入财务报表，已结清只载入最近 30 天',
      actions: [
        DesktopButton(
          label: '其他开支',
          icon: SolarIconsOutline.banknote,
          onPressed: () => widget.onNavigate('/expenses'),
        ),
        DesktopButton(label: '刷新', icon: SolarIconsOutline.refresh, onPressed: _busy ? null : _refresh),
      ],
      body: ListView(
        padding: EdgeInsets.zero,
        children: <Widget>[
          DesktopRise(index: 0, child: _buildStatGrid()),
          DesktopRise(index: 1, child: _buildMainCard()),
        ],
      ),
    );
  }

  /// 顶部四张统计卡（web renderPayStats）
  Widget _buildStatGrid() {
    final payable = wsD(_total['payables_amount']);
    final recv = wsD(_total['receivables_amount']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopStatGrid(
          minTileWidth: 230,
          children: [
            DesktopStatCard(
              label: '待付款（应付）',
              value: wsMoney(payable),
              sub: '要付出去的钱',
              color: WsTokens.red,
            ),
            DesktopStatCard(
              label: '待收款（应收）',
              value: wsMoney(recv),
              sub: '要收进来的钱',
              color: WsTokens.green,
            ),
            DesktopStatCard(
              label: '待结清笔数',
              value: '${wsI(_total['unpaid_count'])}',
              sub: '合计 ${wsMoney(payable + recv)}',
              color: WsTokens.amber,
            ),
            DesktopStatCard(
              label: '最近已结清',
              value: '${wsI(_total['paid_count'])}',
              sub: '最近 30 天内（可撤销）',
            ),
          ],
        ),
        const SizedBox(height: 16),
      ],
    );
  }

  Widget _buildMainCard() {
    final unpaid = wsI(_total['unpaid_count']);
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const WsCardHead(title: '待付款账单', icon: SolarIconsOutline.billList),
          _hintText('入库 / 入仓 / 出库 / 其他开支 / 手动记账 里勾了「待付款」的单据，以及出库单里代发商品自动带出的'
              '「代发成本」，都汇总在这里；点「已支付」后按原日期纳入财务报表。'
              '上方统计卡是全部待结清，下方「合计」随日期 / 关键词筛选实时更新；已结清只载入最近 30 天'),
          const SizedBox(height: 14),
          Row(
            children: [
              DesktopTabs(
                items: const ['账单', '代发'],
                index: _tab,
                small: true,
                onChanged: (i) {
                  setState(() => _tab = i);
                  if (i == 1) _loadDropship();
                },
              ),
              const SizedBox(width: 14),
              if (unpaid > 0) DesktopTag('待结清 $unpaid 笔', color: WsTokens.amber),
              const SizedBox(width: 14),
              Expanded(
                child: _hintText(_tab == 1
                    ? '代发：按「商品 + 规格 + 出库日期」分行，按天核对「单价 × 单量 = 代发成本」'
                    : '账单：入库 / 入仓 / 出库 / 其他开支 / 手动记账的待结清项；代发应付在「代发」页签里单独看'),
              ),
            ],
          ),
          const SizedBox(height: 14),
          if (_tab == 0) _buildBillPanel() else _buildDropshipPanel(),
        ],
      ),
    );
  }

  Widget _hintText(String text) => Text(
        text,
        style: const TextStyle(fontSize: 12, height: 1.6, color: WsTokens.mutedLight),
      );

  // ---------------- 账单页签 ----------------

  Widget _buildBillPanel() {
    final f = _bills();
    final rows = f.rows;
    final outSum = rows.where((r) => wsS(r['direction']) != 'in').fold<double>(0, (a, r) => a + wsD(r['amount']));
    final inSum = rows.where((r) => wsS(r['direction']) == 'in').fold<double>(0, (a, r) => a + wsD(r['amount']));
    final cond = <String>[
      if (_dateFrom.isNotEmpty || _dateTo.isNotEmpty)
        '日期 ${_dateFrom.isEmpty ? '最早' : _dateFrom} ~ ${_dateTo.isEmpty ? '最新' : _dateTo}',
      if (_keyword.isNotEmpty) '关键词「$_keyword」',
    ].join(' + ');
    final allOn = rows.isNotEmpty && rows.every((r) => _picked.contains(_key(r)));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopFilterBar(
          right: Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DesktopButton(
                label: allOn ? '取消全选' : '全选',
                small: true,
                onPressed: rows.isEmpty ? null : _toggleAllBills,
              ),
              Text('已选 ${_picked.length} 笔',
                  style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              DesktopButton(
                label: '批量标记已支付',
                icon: SolarIconsOutline.checkCircle,
                kind: DesktopButtonKind.success,
                small: true,
                onPressed: _busy ? null : () => _batchBills(true),
              ),
              DesktopButton(
                label: '批量撤销',
                small: true,
                onPressed: _busy ? null : () => _batchBills(false),
              ),
            ],
          ),
          children: [
            DesktopTabs(
              items: const ['待结清', '含最近已结清'],
              index: _includePaid ? 1 : 0,
              small: true,
              onChanged: (i) {
                setState(() {
                  _includePaid = i == 1;
                  _picked.clear();
                });
                _loadBills();
              },
            ),
            DesktopTextField(
              controller: _searchCtl,
              hintText: '筛选 款项 / 单据 / 客户 / 操作员...',
              width: 260,
              onChanged: (v) => setState(() {
                _keyword = v.trim();
                _picked.clear();
              }),
            ),
            DesktopLabeled(
              label: '开始',
              child: DesktopDateField(
                value: _dateFrom,
                width: 140,
                onChanged: (v) => setState(() {
                  _dateFrom = v;
                  _picked.clear();
                }),
              ),
            ),
            DesktopLabeled(
              label: '结束',
              child: DesktopDateField(
                value: _dateTo,
                width: 140,
                onChanged: (v) => setState(() {
                  _dateTo = v;
                  _picked.clear();
                }),
              ),
            ),
            DesktopButton(label: '清空筛选', small: true, onPressed: _clearFilter),
          ],
        ),
        _sumBar(
          scope: f.active ? '筛选结果' : '当前列表',
          parts: [
            '${rows.length} 笔',
            if (rows.length != _rows.length) '/ 共 ${_rows.length} 笔',
            '合计 ${wsMoney(outSum + inSum)}',
            '应付 ${wsMoney(outSum)} ／ 应收 ${wsMoney(inSum)}',
            if (f.undated > 0) '${f.undated} 笔无日期未计入',
            if (cond.isNotEmpty) '已按 $cond 筛选',
          ],
        ),
        DesktopStateView(
          loading: _loading && _rows.isEmpty,
          error: _error,
          onRetry: _loadBills,
          loadingText: '正在读取待付款账单…',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const DesktopNotice(
                '金额口径：入库 = 实付（货款 + 金额调整 + 运费 + 装卸费，运费 / 装卸不再单列）；'
                '入仓 = 入仓金额（应收）；出库 = 实收（销售收入 + 金额调整 + 代收包材·人工·快递费，应收）；'
                '其他开支只列手工登记的（单据带出的随主单结算）；手动记账只列手工记的流水。',
                kind: DesktopNoticeKind.info,
              ),
              DesktopGrid(
                cols: _billCols,
                rowHeight: 46,
                emptyText: f.active && _rows.isNotEmpty
                    ? '没有符合筛选条件的账单（可点「清空筛选」看全部）'
                    : (_includePaid ? '没有账单' : '没有待结清的账单'),
                footer: rows.isEmpty
                    ? null
                    : <String>[
                        '',
                        f.active ? '筛选合计' : '列出合计',
                        '',
                        '${rows.length} 笔${_includePaid ? '（含已结清）' : ''} · '
                            '应付 ${wsMoney(outSum)} ／ 应收 ${wsMoney(inSum)}',
                        wsMoney(outSum + inSum),
                        '',
                        '',
                        '',
                      ],
                rows: [for (final r in rows) _billRow(r)],
              ),
            ],
          ),
        ),
      ],
    );
  }

  DesktopRow _billRow(Map<String, dynamic> r) {
    final paid = _paid(r);
    final dir = wsS(r['direction']);
    final amount = wsD(r['amount']);
    final kind = wsS(r['kind']);
    final src = wsS(r['source']);
    final rid = wsI(r['id']);
    final remark = wsS(r['remark']);
    final sub = wsS(r['sub']);
    final subLine = <String>[
      if (sub.isNotEmpty) sub,
      if (remark.isNotEmpty) remark,
    ].join(' · ');
    final code = wsS(r['code']);
    final operator = wsS(r['operator']);
    final paidAt = wsS(r['paid_at']);
    final title = wsS(r['title']);

    return DesktopRow(
      tag: _key(r),
      dim: paid,
      cells: <Widget>[
        Checkbox(
          value: _picked.contains(_key(r)),
          onChanged: _busy ? null : (v) => _togglePick(r, v ?? false),
          visualDensity: VisualDensity.compact,
          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          activeColor: WsTokens.primary,
        ),
        wsCell(wsS(r['date'])),
        DesktopTag(src.isEmpty ? kind : src, color: _srcColor(src), tip: '$kind #$rid'),
        Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            wsCell(code.isEmpty ? title : '$title  $code', bold: true, tip: title),
            if (subLine.isNotEmpty) wsCell(subLine, color: WsTokens.mutedLight, tip: subLine),
          ],
        ),
        Tooltip(
          message: '${dir == 'in' ? '应收（要收进来）' : '应付（要付出去）'} · ${wsMoney(amount)}',
          child: wsCell(
            '${dir == 'in' ? '应收' : '应付'} ${wsMoney(amount)}',
            color: dir == 'in' ? WsTokens.green : WsTokens.red,
            bold: true,
          ),
        ),
        wsCell(operator.isEmpty ? '—' : operator),
        paid
            ? DesktopTag(paidAt.isEmpty ? '已结清' : '已结清 $paidAt', color: DesktopTag.paid)
            : const DesktopTag('待结清', color: DesktopTag.unpaid),
        paid
            ? Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  DesktopLink('撤销', color: WsTokens.red, onPressed: _busy ? null : () => _payOne(r, false)),
                ],
              )
            : Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  DesktopLink('查看', onPressed: () => widget.onNavigate(_routeOf(wsS(r['page'])))),
                  const SizedBox(width: 2),
                  DesktopLink(
                    '已支付',
                    color: WsTokens.green,
                    onPressed: _busy ? null : () => _payOne(r, true),
                  ),
                ],
              ),
      ],
    );
  }

  // ---------------- 代发页签 ----------------

  Widget _buildDropshipPanel() {
    final f = _dropshipRows();
    final groups = f.groups;
    final sum = groups.fold<double>(0, (a, g) => a + wsD(g['amount']));
    final pendAmt = groups
        .where((g) => wsS(g['pay_status']) == 'unpaid')
        .fold<double>(0, (a, g) => a + wsD(g['amount']));
    final orders = groups.fold<int>(0, (a, g) => a + wsI(g['order_count']));
    final days = groups.map((g) => wsS(g['date'])).where((d) => d.isNotEmpty).toSet().length;
    final pendCount = groups.where((g) => wsS(g['pay_status']) == 'unpaid').length;
    final allOn = groups.isNotEmpty && _dsPicked.length >= groups.length;
    final dsCond = <String>[
      if (_dsFrom.isNotEmpty || _dsTo.isNotEmpty) '日期',
      if (_dsKeyword.isNotEmpty) '关键词',
    ].join(' + ');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopStatGrid(
          minTileWidth: 230,
          children: [
            DesktopStatCard(
              label: '代发分行数',
              value: '${wsI(_dsTotal['groups'])}',
              sub: '共 ${wsI(_dsTotal['orders'])} 单 · 数量 ${wsTrim(wsD(_dsTotal['quantity']), digits: 4)}',
            ),
            DesktopStatCard(
              label: '应付合计',
              value: wsMoney(wsD(_dsTotal['amount'])),
              sub: '已结清 ${wsMoney(wsD(_dsTotal['paid_amount']))}',
              color: WsTokens.red,
            ),
            DesktopStatCard(
              label: '待结清行数',
              value: '${wsI(_dsTotal['pending_groups'])}',
              sub: '待结清金额 ${wsMoney(wsD(_dsTotal['pending_amount']))}',
              color: WsTokens.amber,
            ),
            DesktopStatCard(
              label: '列表口径',
              value: _dsTruncated ? '仅最近 $_dsLimit 行' : '全部 ${groups.length} 行',
              sub: '合计按全部算，不受截断影响',
            ),
          ],
        ),
        const SizedBox(height: 16),
        DesktopFilterBar(
          right: Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DesktopButton(
                label: allOn ? '取消全选' : '全选',
                small: true,
                onPressed: groups.isEmpty ? null : _toggleAllGroups,
              ),
              Text('已选 ${_dsPicked.length} 行',
                  style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              DesktopButton(
                label: '批量标记已支付',
                icon: SolarIconsOutline.checkCircle,
                kind: DesktopButtonKind.success,
                small: true,
                onPressed: _busy ? null : () => _dsBatch(true),
              ),
              DesktopButton(
                label: '批量撤销',
                small: true,
                onPressed: _busy ? null : () => _dsBatch(false),
              ),
            ],
          ),
          children: [
            DesktopTabs(
              items: const ['待结清', '含已结清'],
              index: _dsIncludePaid ? 1 : 0,
              small: true,
              onChanged: (i) {
                setState(() => _dsIncludePaid = i == 1);
                _loadDropship();
              },
            ),
            DesktopTextField(
              controller: _dsSearchCtl,
              hintText: '筛选 商品 / 规格 / 出库单 / 操作员...',
              width: 260,
              onChanged: (v) => setState(() {
                _dsKeyword = v.trim();
                _dsPicked.clear();
              }),
            ),
            DesktopLabeled(
              label: '开始',
              child: DesktopDateField(
                value: _dsFrom,
                width: 140,
                onChanged: (v) {
                  setState(() {
                    _dsFrom = v;
                    _dsPicked.clear();
                  });
                  _loadDropship();
                },
              ),
            ),
            DesktopLabeled(
              label: '结束',
              child: DesktopDateField(
                value: _dsTo,
                width: 140,
                onChanged: (v) {
                  setState(() {
                    _dsTo = v;
                    _dsPicked.clear();
                  });
                  _loadDropship();
                },
              ),
            ),
            DesktopButton(label: '清空筛选', small: true, onPressed: _clearDsFilter),
          ],
        ),
        _sumBar(
          scope: f.active ? '筛选结果' : '当前列表',
          parts: [
            '${groups.length} 行 / $days 天 / $orders 单',
            '合计 ${wsMoney(sum)}',
            '待结清 ${wsMoney(pendAmt)}',
            if (_dsIncludePaid) '已结清 ${wsMoney(sum - pendAmt)}',
            if (dsCond.isNotEmpty) '已按 $dsCond 筛选',
          ],
        ),
        if (_dsTruncated)
          DesktopNotice(
            '结果已达上限，请缩小日期区间：共 ${wsI(_dsTotal['groups'])} 行（按商品 + 规格 + 日期分行），'
                '这里只列最近 $_dsLimit 行；待结清合计 ${wsMoney(wsD(_dsTotal['pending_amount']))}。',
            kind: DesktopNoticeKind.warn,
          ),
        if (_dsError != null && _dsGroups.isNotEmpty)
          DesktopNotice(_dsError!, kind: DesktopNoticeKind.error),
        _hintText('同一种商品和规格按「出库日期」分别成行，方便按天核对：应付 = 成本单价 × 单量 = 代发成本'
            '（出库单里代发商品的成本，已计入结转成本、毛利口径不变）；一次导入多个日期时就按各天分别统计，'
            '不会再合并成一个日期区间。这里只做「付给代发方」的核对，付款状态不影响财务报表。'),
        const SizedBox(height: 12),
        DesktopStateView(
          loading: _dsLoading && _dsGroups.isEmpty,
          error: _dsGroups.isEmpty ? _dsError : null,
          onRetry: _loadDropship,
          child: DesktopGrid(
            cols: _dsCols,
            rowHeight: 46,
            emptyText: f.active
                ? '没有符合筛选条件的代发应付（可点「清空筛选」看全部）'
                : (_dsIncludePaid ? '还没有代发应付账单' : '没有待结清的代发应付'),
            footer: groups.isEmpty
                ? null
                : <String>[
                    '',
                    f.active ? '筛选合计' : '列出合计',
                    '${groups.length} 行 · $days 天 · 待结清 $pendCount 行 · $orders 单',
                    '',
                    '',
                    '应付 ${wsMoney(sum)}',
                    '',
                    '',
                  ],
            rows: <DesktopRow>[
              for (var i = 0; i < groups.length; i++) _dsRow(i, groups[i]),
            ],
          ),
        ),
      ],
    );
  }

  DesktopRow _dsRow(int index, Map<String, dynamic> g) {
    final paid = wsS(g['pay_status']) != 'unpaid';
    final name = wsS(g['product_name']);
    final spec = wsS(g['spec']);
    final unit = wsS(g['unit']);
    final showSpec = spec.isNotEmpty && !name.contains(spec);
    final amount = wsD(g['amount']);
    final date = wsS(g['date']).isEmpty
        ? (wsS(g['date_from']).isEmpty ? wsS(g['date_to']) : wsS(g['date_from']))
        : wsS(g['date']);
    final orderCount = wsI(g['order_count']);
    final paidAt = wsS(g['paid_at']);

    return DesktopRow(
      tag: index,
      dim: paid,
      cells: <Widget>[
        Checkbox(
          value: _dsPicked.contains(index),
          onChanged: _busy ? null : (v) => setState(() {
                if (v ?? false) {
                  _dsPicked.add(index);
                } else {
                  _dsPicked.remove(index);
                }
              }),
          visualDensity: VisualDensity.compact,
          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          activeColor: WsTokens.primary,
        ),
        wsCell(date),
        Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            wsCell(name.isEmpty ? '代发商品' : name, bold: true, tip: name),
            wsCell('代发成本 ${wsMoney(amount)}${showSpec ? ' · 规格 $spec' : ''}',
                color: WsTokens.red, tip: '应付 = 成本单价 × 单量'),
          ],
        ),
        wsCell('${wsTrim(wsD(g['quantity']), digits: 4)}$unit'),
        wsCell(wsTrim(wsD(g['unit_price']), digits: 4)),
        wsCell(wsMoney(amount), color: WsTokens.red, bold: true),
        orderCount <= 1
            ? wsCell('$orderCount 单', color: WsTokens.mutedLight)
            : Align(
                alignment: Alignment.centerRight,
                child: DesktopLink('$orderCount 单', onPressed: () => _showOrders(g)),
              ),
        paid
            ? Tooltip(
                message: paidAt.isEmpty ? '点此撤销已付标记' : '已付 $paidAt，点此撤销',
                child: DesktopLink(
                  '已付·撤销',
                  color: WsTokens.mutedLight,
                  onPressed: _busy ? null : () => _dsMark(g, false),
                ),
              )
            : DesktopLink(
                '已支付',
                color: WsTokens.green,
                onPressed: _busy ? null : () => _dsMark(g, true),
              ),
      ],
    );
  }

  /// 实时合计条（web .pay-sum）
  Widget _sumBar({required String scope, required List<String> parts}) {
    final dark = wsIsDark(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF262626) : const Color(0xFFF7F9FC),
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
      ),
      child: Wrap(
        spacing: 16,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(scope, style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          for (final part in parts)
            Text(
              part,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: part.startsWith('合计') ? FontWeight.w700 : FontWeight.w400,
                color: _sumColor(part, dark),
              ),
            ),
        ],
      ),
    );
  }
}

/// 合计条按文案前缀上色：合计=主色，应付 / 待结清=红，应收 / 已结清=绿
Color _sumColor(String part, bool dark) {
  if (part.startsWith('合计')) return WsTokens.primary;
  if (part.startsWith('应付') || part.startsWith('待结清')) return WsTokens.red;
  if (part.startsWith('应收') || part.startsWith('已结清')) return WsTokens.green;
  return dark ? WsTokens.textSecondaryDark : WsTokens.textSecondaryLight;
}
