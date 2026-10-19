import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../models/product.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/out_batch_detail.dart';
import '../widgets/ws_card.dart';
import 'package:solar_icons/solar_icons.dart';

/// 桌面端「出库 / 销售」，复刻 web #page-outbound（出库录单 + 出库记录 + 批量/聚水潭导入）。
///
/// 业务口径与移动端 lib/screens/outbound_screen.dart 一致（字段名、settle_cats 语义、
/// 成本/快递费以后端 preview 为准、固定费用、警告文案），这里按宽屏桌面重做 UI。
class DesktopOutboundScreen extends StatefulWidget {
  const DesktopOutboundScreen({super.key, required this.auth, required this.onNavigate});
  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopOutboundScreen> createState() => _DesktopOutboundState();
}

class _DesktopOutboundState extends State<DesktopOutboundScreen> {
  /// 子页：0 = 开单（出库录单），1 = 出库记录
  int _tab = 0;

  // ---------------------------------------------------------------- 元数据
  final Map<int, Product> _productById = {};
  final Map<int, Map<String, dynamic>> _productRaw = {};
  List<DesktopOption<String>> _saleOptions = const [];
  List<DesktopOption<String>> _packOptions = const [];
  Map<String, dynamic> _expressRule = const {};

  /// 实收口径（settle_cats）：客户随货款一起付回来的关联结算类别，
  /// 键与文案同后端 services.SETTLE_CAT_LABEL / 网页端 SETTLE_LABEL。
  static const List<DesktopOption<String>> _settleOpts = [
    DesktopOption<String>('material', '包材 / 耗材'),
    DesktopOption<String>('labor', '人工（打包费）'),
    DesktopOption<String>('express', '快递费'),
    DesktopOption<String>('fee', '固定成本'),
  ];

  /// 编辑出库单只提供前三项（与网页端 editOutbound 一致）
  static const List<DesktopOption<String>> _editSettleOpts = [
    DesktopOption<String>('material', '包材'),
    DesktopOption<String>('labor', '人工'),
    DesktopOption<String>('express', '快递费'),
  ];

  static const Map<String, String> _settleLabels = {
    'material': '包材',
    'labor': '人工',
    'express': '快递费',
    'fee': '固定成本',
  };

  /// 桌面端自己的持久化键：移动端 outbound_screen 的 _settleCats 只在内存里、
  /// 网页端存 localStorage('settleCats')，三端各存各的。这里加 desktop_ 前缀，
  /// 免得和移动端将来要用的 prefs 键互相覆盖。
  static const String _settlePrefsKey = 'desktop_settle_cats';

  // ---------------------------------------------------------------- 开单表单
  final List<_SaleRow> _rows = [];
  String _date = wsToday();
  String _customer = '';
  String _remark = '';
  String _payStatus = 'paid';
  bool _autoExpress = true;
  List<String> _settleCats = const ['material', 'labor', 'express'];
  final TextEditingController _adjustCtl = TextEditingController();
  final TextEditingController _feeCtl = TextEditingController();
  bool _feeManual = false;

  Map<String, dynamic>? _preview;
  final List<_PackRow> _packRows = [];
  List<dynamic> _warnings = const [];
  List<dynamic> _previewSaleLines = const [];
  bool _previewing = false;
  bool _submitting = false;

  // ---------------------------------------------------------------- 出库记录
  String _from = wsToday();
  String _to = wsToday();
  String _kw = '';
  String _payFilter = '';
  bool _groupBy = true;
  bool _summaryView = false;
  int _sumDim = 0;
  String _sortKey = 'date';
  bool _sortAsc = false;
  List<Map<String, dynamic>> _records = const [];
  final Set<int> _selected = {};
  final Set<String> _expanded = {};
  bool _loadingRecords = false;
  Object? _recordsError;

  static const List<String> _sumDims = ['按商品', '按规格', '按日期', '按客户'];

  @override
  void initState() {
    super.initState();
    _rows.add(_newRow());
    _loadMeta();
    _restoreSettleCats();
    _loadRecords();
  }

  @override
  void dispose() {
    for (final r in _rows) {
      r.dispose();
    }
    for (final r in _packRows) {
      r.dispose();
    }
    _adjustCtl.dispose();
    _feeCtl.dispose();
    super.dispose();
  }

  _SaleRow _newRow() {
    final row = _SaleRow();
    row.qty.addListener(_rowChanged);
    row.price.addListener(_rowChanged);
    return row;
  }

  void _rowChanged() {
    if (mounted) setState(() {});
  }

  // ---------------------------------------------------------------- 元数据

  Future<void> _loadMeta() async {
    try {
      final data = await ApiService.products();
      final byId = <int, Product>{};
      final raw = <int, Map<String, dynamic>>{};
      final sale = <DesktopOption<String>>[];
      final pack = <DesktopOption<String>>[];
      for (final e in data) {
        if (e is! Map) continue;
        final m = Map<String, dynamic>.from(e);
        final p = Product.fromJson(m);
        byId[p.id] = p;
        raw[p.id] = m;
        if (p.isActive && !['人工', '快递'].contains(p.category)) {
          sale.add(DesktopOption<String>('${p.id}', _saleLabel(p)));
        }
        if (p.isActive) {
          pack.add(DesktopOption<String>('${p.id}', _packLabel(p)));
        }
      }
      Map<String, dynamic> rule = const {};
      try {
        rule = await ApiService.expressRule();
      } on ApiException catch (_) {
        rule = const {};
      }
      if (!mounted) return;
      setState(() {
        _productById
          ..clear()
          ..addAll(byId);
        _productRaw
          ..clear()
          ..addAll(raw);
        _saleOptions = sale;
        _packOptions = pack;
        _expressRule = rule;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, e.message, error: true);
    }
  }

  String _saleLabel(Product p) {
    final type = p.productType == 'order' ? '[订单]' : '[库存]';
    final ds = _isDropship(p) ? '（代发）' : '';
    return '$type ${p.name}$ds（${p.category.isEmpty ? '—' : p.category}）· 库存 ${_q(p.stockInUnit)} ${p.unit}';
  }

  String _packLabel(Product p) =>
      '${p.name}（${p.category.isEmpty ? '—' : p.category}）· 单位 ${p.unit} · 库存 ${_q(p.stockInUnit)} ${p.unit}';

  /// 订单商品没有关联任何库存大类 = 代发（不扣本仓库存，只记代发数量/成本）
  bool _isDropship(Product p) {
    if (p.productType != 'order') return false;
    if (p.stockProductId != null) return false;
    final links = _productRaw[p.id]?['stock_links'];
    return links is! List || links.isEmpty;
  }

  Future<void> _restoreSettleCats() async {
    final prefs = await SharedPreferences.getInstance();
    final v = prefs.getString(_settlePrefsKey);
    if (v == null) return;
    final cats = v.split(',').where((e) => e.isNotEmpty).toList();
    if (!mounted) return;
    setState(() => _settleCats = cats);
  }

  Future<void> _saveSettleCats() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_settlePrefsKey, _settleCats.join(','));
  }

  // ---------------------------------------------------------------- 开单：行编辑

  void _addRow() => setState(() => _rows.add(_newRow()));

  void _removeRow(int i) {
    if (_rows.length <= 1) return;
    final row = _rows.removeAt(i);
    row.dispose();
    setState(() {});
  }

  void _pickSaleProduct(_SaleRow row, String? idText) {
    setState(() {
      final p = _productById[int.tryParse(idText ?? '') ?? 0];
      if (p == null) {
        row.product = null;
        row.unit = '';
        row.price.text = '0';
        return;
      }
      row.product = p;
      final units = _unitsOf(p);
      final du = p.productType == 'order' ? '单' : p.unit;
      row.unit = units.any((o) => o.value == du) ? du : units.first.value;
      _fillSalePrice(row);
    });
  }

  /// 自动带出参考单价（同网页端 fillSalePrice：售价 → 均价 → 参考成本）
  void _fillSalePrice(_SaleRow row) {
    final p = row.product;
    if (p == null) return;
    final factor = p.conversions?[row.unit] ?? 1.0;
    double price = 0;
    if (p.salePrice > 0) {
      price = p.salePrice * factor;
    } else if (p.avgCost > 0) {
      price = p.avgCost * factor;
    } else if (p.unitCost > 0) {
      price = p.unitCost * factor;
    }
    if (price > 0) row.price.text = price.toStringAsFixed(2);
  }

  List<DesktopOption<String>> _unitsOf(Product? p) {
    if (p == null) return const [DesktopOption<String>('', '—')];
    final convs = p.conversions ?? const <String, double>{};
    var keys = (convs.isNotEmpty ? convs.keys.toList() : <String>[p.unit])
        .where((k) => k.isNotEmpty)
        .toList();
    if (keys.isEmpty) keys = const ['个'];
    return [for (final k in keys) DesktopOption<String>(k, k)];
  }

  List<Map<String, dynamic>> _saleLines() {
    final out = <Map<String, dynamic>>[];
    for (final r in _rows) {
      final p = r.product;
      final qty = double.tryParse(r.qty.text) ?? 0;
      if (p == null || r.unit.isEmpty || qty <= 0) continue;
      out.add({
        'product_id': p.id,
        'unit': r.unit,
        'quantity': qty,
        'price': double.tryParse(r.price.text) ?? 0,
      });
    }
    return out;
  }

  /// 手动挑选的关联物品：从当前结算表回收，重新预览时交回后端一起按 FIFO 算成本
  List<Map<String, dynamic>> _extraPackLines() {
    final out = <Map<String, dynamic>>[];
    for (final r in _packRows) {
      if (!r.manual) continue;
      final qty = double.tryParse(r.qty.text) ?? 0;
      if (qty <= 0) continue;
      out.add({'product_id': r.productId, 'unit': r.unit, 'quantity': qty});
    }
    return out;
  }

  // ---------------------------------------------------------------- 开单：预览 / 提交

  /// 快递费不本地重算：整单毛重（Σ 净重 + 箱体 0.1kg）与 tiered/flat 计费都由后端
  /// /api/outbounds/preview 的 pack_lines（express 行带整单毛重）给出，本页只展示 + 联动合计。
  Future<void> _doPreview() async {
    final lines = _saleLines();
    if (lines.isEmpty) {
      wsToast(context, '请至少添加一行销售商品', error: true);
      return;
    }
    setState(() => _previewing = true);
    try {
      final data = await ApiService.previewOutbound(
        lines: lines,
        extraPackLines: _extraPackLines(),
        autoExpress: _autoExpress,
        settleCats: _settleCats.isEmpty ? null : _settleCats,
      );
      if (!mounted) return;
      _applyPreview(data);
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '预览失败：${e.message}', error: true);
    } finally {
      if (mounted) setState(() => _previewing = false);
    }
  }

  void _applyPreview(Map<String, dynamic> data) {
    for (final r in _packRows) {
      r.dispose();
    }
    _packRows.clear();
    for (final raw in (data['pack_lines'] as List? ?? const [])) {
      if (raw is! Map) continue;
      final pid = wsI(raw['product_id']);
      final name = wsS(raw['product_name']);
      final p = _productById[pid];
      final express = (p?.category ?? '') == '快递' || name.contains('快递');
      final ctl = TextEditingController(text: _q(wsD(raw['quantity'])));
      ctl.addListener(_rowChanged);
      _packRows.add(
        _PackRow(
          productId: pid,
          name: name,
          unit: wsS(raw['unit'], fallback: '个'),
          unitPrice: wsD(raw['unit_price']),
          settleCat: wsS(raw['settle_cat'], fallback: 'material'),
          manual: raw['manual'] == true,
          express: express,
          note: express ? '整单毛重 ${wsS(raw['spec'])}' : '',
          qty: ctl,
        ),
      );
    }
    if (!_feeManual) _feeCtl.text = wsD(data['total_fee']).toStringAsFixed(2);
    _preview = data;
    _previewSaleLines = (data['sale_lines'] as List?) ?? const [];
    _warnings = (data['warnings'] as List?) ?? const [];
    setState(() {});
  }

  void _clearPreview() {
    for (final r in _packRows) {
      r.dispose();
    }
    setState(() {
      _packRows.clear();
      _preview = null;
      _previewSaleLines = const [];
      _warnings = const [];
      _feeManual = false;
      _feeCtl.text = '';
      _adjustCtl.text = '';
    });
  }

  /// 删掉「快递费」行 → 同步取消自动计快递费，避免再次预览/提交又被算上
  void _removePackRow(int i) {
    final r = _packRows[i];
    if (r.express) {
      _autoExpress = false;
      wsToast(context, '已取消「自动计快递费」，这笔出库不再计快递费');
    }
    r.dispose();
    setState(() => _packRows.removeAt(i));
  }

  Future<void> _addManualPackItem() async {
    if (_preview == null) {
      wsToast(context, '先点「🔍 预览结算」，再挑关联出库物品', error: true);
      return;
    }
    final picked = await desktopSearchSelect(
      context,
      title: '选择关联出库物品',
      options: _packOptions,
      hint: '搜索商品名称 / 分类',
    );
    if (!mounted) return;
    final p = _productById[int.tryParse(picked ?? '') ?? 0];
    if (p == null) return;
    final unit = p.unit;
    final ctl = TextEditingController(text: '1');
    ctl.addListener(_rowChanged);
    setState(() {
      _packRows.add(
        _PackRow(
          productId: p.id,
          name: p.name,
          unit: unit,
          unitPrice: p.avgCost * (p.conversions?[unit] ?? 1.0),
          settleCat: _packSettleCat(p),
          manual: true,
          express: p.category == '快递',
          note: '均价估算，重新预览后按 FIFO 实算',
          qty: ctl,
        ),
      );
    });
    wsToast(context, '已添加关联物品：${p.name}（数量按本单用量改）');
    _doPreview();
  }

  /// 关联结算行归哪一类（同后端 services.pack_settle_cat / 网页端 packSettleCat）
  String _packSettleCat(Product p) {
    final cat = p.category.trim();
    if (cat == '人工') return 'labor';
    if (cat == '快递') return 'express';
    if (p.name.trim().endsWith('打包')) return 'labor';
    return 'material';
  }

  _Totals _calcTotals() {
    final t = _Totals();
    var vi = 0;
    for (final r in _rows) {
      final p = r.product;
      final qty = double.tryParse(r.qty.text) ?? 0;
      final price = double.tryParse(r.price.text) ?? 0;
      if (p == null || r.unit.isEmpty || qty <= 0) continue;
      t.amount += qty * price;
      // 与最近一次服务端预览一致时直接采用后端 FIFO 结转成本，否则按均价兜底
      final sl = vi < _previewSaleLines.length ? _previewSaleLines[vi] : null;
      final matched = sl is Map &&
          wsI(sl['product_id']) == p.id &&
          wsS(sl['unit']) == r.unit &&
          (wsD(sl['quantity']) - qty).abs() < 1e-9;
      t.cogs += matched ? wsD(sl['cogs']) : qty * (p.conversions?[r.unit] ?? 1.0) * p.avgCost;
      vi++;
    }
    for (final r in _packRows) {
      t.cogs += r.amount;
    }
    t.fee = double.tryParse(_feeCtl.text) ?? 0;
    t.adjust = double.tryParse(_adjustCtl.text) ?? 0;
    for (final r in _packRows) {
      if (_settleCats.contains(r.settleCat)) t.settle += r.amount;
    }
    if (_settleCats.contains('fee')) t.settle += t.fee;
    t.settle = (t.settle * 100).roundToDouble() / 100;
    return t;
  }

  /// 自动算出来的快递费行不提交：后端会按整单毛重再算一次，交上去会重复计费。
  List<Map<String, dynamic>> _submitPackLines() {
    final out = <Map<String, dynamic>>[];
    for (final r in _packRows) {
      if (r.express) continue;
      final qty = double.tryParse(r.qty.text) ?? 0;
      if (qty <= 0) continue;
      out.add({'product_id': r.productId, 'unit': r.unit, 'quantity': qty});
    }
    return out;
  }

  Future<void> _submit() async {
    final lines = _saleLines();
    if (lines.isEmpty) {
      wsToast(context, '请至少添加一行销售商品', error: true);
      return;
    }
    if (_preview == null) {
      wsToast(context, '请先点「🔍 预览结算」，确认成本与快递费后再出库', error: true);
      return;
    }
    final t = _calcTotals();
    setState(() => _submitting = true);
    try {
      final result = await ApiService.createOutbound({
        'customer': _customer,
        'operator': widget.auth.displayName,
        'date': _date,
        'remark': _remark,
        'lines': lines,
        'pack_lines': _submitPackLines(),
        'pack_fee_total': t.fee,
        'auto_express': _autoExpress,
        'pay_status': _payStatus,
        'adjust_amount': t.adjust,
        'settle_cats': _settleCats,
      });
      if (!mounted) return;
      final order = (result['order'] as Map?) ?? const {};
      final warns = (result['warnings'] as List?) ?? const [];
      wsToast(
        context,
        '出库成功：实收 ${wsMoney(wsD(order['final_amount']))}'
        '${t.adjust != 0 ? '（调整 ${t.adjust > 0 ? '+' : '-'}${wsMoney(t.adjust.abs())}，已记其他开支）' : ''}'
        '${t.settle > 0 ? '（实收含${_settleCatsLabel(_settleCats)} ${wsMoney(t.settle)}）' : ''}'
        '${_payStatus == 'unpaid' ? '（待付款，已进待付款账单）' : ''}',
      );
      _resetForm();
      await _loadRecords();
      if (warns.isNotEmpty) await _showWarningsDialog(warns);
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '出库失败：${e.message}', error: true);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _showWarningsDialog(List<dynamic> warns) {
    return desktopDialog(
      context,
      title: '出库已完成，但有库存预警',
      width: 560,
      builder: (ctx) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final w in warns) DesktopNotice('⚠ $w（仍可继续，可先补货）', kind: DesktopNoticeKind.warn),
          const DesktopNotice(
            '库存不足也可继续出库（出库后留负库存），可先补货或再盘点',
            kind: DesktopNoticeKind.info,
          ),
          Align(
            alignment: Alignment.centerRight,
            child: DesktopButton(label: '知道了', onPressed: () => Navigator.of(ctx).pop()),
          ),
        ],
      ),
    );
  }

  void _resetForm() {
    for (final r in _rows) {
      r.dispose();
    }
    for (final r in _packRows) {
      r.dispose();
    }
    setState(() {
      _rows
        ..clear()
        ..add(_newRow());
      _packRows.clear();
      _preview = null;
      _previewSaleLines = const [];
      _warnings = const [];
      _customer = '';
      _remark = '';
      _payStatus = 'paid';
      _autoExpress = true;
      _feeManual = false;
      _feeCtl.text = '';
      _adjustCtl.text = '';
    });
  }

  // ---------------------------------------------------------------- 出库记录

  Future<void> _loadRecords() async {
    setState(() {
      _loadingRecords = true;
      _recordsError = null;
    });
    try {
      final data = await ApiService.outbounds(dateFrom: _from, dateTo: _to);
      if (!mounted) return;
      setState(() {
        _records = [for (final e in data) Map<String, dynamic>.from(e as Map)];
        _selected.clear();
        _expanded.clear();
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _recordsError = e.message);
    } finally {
      if (mounted) setState(() => _loadingRecords = false);
    }
  }

  List<Map<String, dynamic>> get _filteredRecords {
    final kw = _kw.trim().toLowerCase();
    return _records.where((o) {
      if (_payFilter.isNotEmpty && wsS(o['pay_status'], fallback: 'paid') != _payFilter) return false;
      if (kw.isEmpty) return true;
      final hay = <String>[
        wsS(o['code']),
        wsS(o['customer']),
        wsS(o['date']),
        wsS(o['operator']),
        wsS(o['remark']),
        _productsSummary(o),
      ].join(' ').toLowerCase();
      return hay.contains(kw);
    }).toList();
  }

  String _productsSummary(Map<String, dynamic> o) {
    final names = <String>{};
    for (final l in ((o['lines'] as List?) ?? const [])) {
      if (l is Map && wsS(l['line_type']) == 'sale') names.add(wsS(l['product_name']));
    }
    return names.join(' ');
  }

  /// 筛选结果整理成可排序的展示条目（同一 import_group 折叠成一条批次行）
  List<_OutEntry> _entries() {
    final out = <_OutEntry>[];
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final o in _filteredRecords) {
      final g = wsS(o['import_group']);
      if (!_groupBy || g.isEmpty) {
        out.add(_OutEntry.of(o));
      } else {
        (groups[g] ??= <Map<String, dynamic>>[]).add(o);
      }
    }
    groups.forEach((key, members) => out.add(_OutEntry.group(key, members)));
    out.sort((a, b) {
      final d = _cmp(a.sortValue(_sortKey), b.sortValue(_sortKey));
      return _sortAsc ? d : -d;
    });
    return out;
  }

  int _cmp(Object a, Object b) {
    if (a is num && b is num) return a.compareTo(b);
    return '$a'.compareTo('$b');
  }

  void _onSort(String key) {
    setState(() {
      if (_sortKey == key) {
        _sortAsc = !_sortAsc;
      } else {
        _sortKey = key;
        _sortAsc = false;
      }
    });
  }

  void _toggleExpand(String key) {
    setState(() {
      if (_expanded.contains(key)) {
        _expanded.remove(key);
      } else {
        _expanded.add(key);
      }
    });
  }

  Future<void> _deleteEntry(_OutEntry e) async {
    final message = e.isGroup
        ? '确认删除批次 ${e.importGroup}（${e.orders} 单，合计 ${wsMoney(e.amount)}）？\n'
            '删除会回滚库存流水、财务流水、金额调整与代发应付账单。'
        : '确认删除 ${e.code}（${e.customer.isEmpty ? '—' : e.customer}，${wsMoney(e.amount)}）？\n'
            '删除会回滚库存流水、财务流水、金额调整与代发应付账单。';
    final ok = await wsConfirm(
      context,
      title: e.isGroup ? '删除整批出库单' : '删除出库单',
      message: message,
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      if (e.isGroup) {
        final all = await ApiService.outbounds(g: e.importGroup);
        final ids = [for (final o in all) wsI((o as Map)['id'])];
        final r = await ApiService.batchDeleteOutbounds(ids);
        if (!mounted) return;
        wsToast(context, '已删除批次（${wsI(r['deleted'])} 单）');
      } else {
        await ApiService.deleteOutbound(wsI(e.records.first['id']));
        if (!mounted) return;
        wsToast(context, '已删除');
      }
      await _loadRecords();
      await _loadMeta();
    } on ApiException catch (ex) {
      if (!mounted) return;
      wsToast(context, '删除失败：${ex.message}', error: true);
    }
  }

  Future<void> _batchDelete() async {
    if (_selected.isEmpty) return;
    final ok = await wsConfirm(
      context,
      title: '批量删除出库单',
      message: '确认删除选中的 ${_selected.length} 张出库单？'
          '库存流水、财务流水、金额调整与代发应付账单会一并回滚。',
      okLabel: '批量删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      final r = await ApiService.batchDeleteOutbounds(_selected.toList());
      if (!mounted) return;
      final missing = wsI(r['missing']);
      wsToast(context, '已删除 ${wsI(r['deleted'])} 张${missing > 0 ? '，跳过 $missing 张' : ''}');
      _selected.clear();
      await _loadRecords();
      await _loadMeta();
    } on ApiException catch (ex) {
      if (!mounted) return;
      wsToast(context, '批量删除失败：${ex.message}', error: true);
    }
  }

  Future<void> _markPaid(_OutEntry e) async {
    final ids = [for (final o in e.records) wsI(o['id'])];
    if (ids.isEmpty) return;
    final toPaid = wsS(e.records.first['pay_status'], fallback: 'paid') != 'paid';
    try {
      if (ids.length == 1) {
        await ApiService.payBill('outbound', ids.first, paid: toPaid);
      } else {
        await ApiService.payBillsBatch('outbound', ids, paid: toPaid);
      }
      if (!mounted) return;
      wsToast(context, toPaid ? '已标记为已付款，计入财务报表' : '已撤销为待付款');
      await _loadRecords();
    } on ApiException catch (ex) {
      if (!mounted) return;
      wsToast(context, '操作失败：${ex.message}', error: true);
    }
  }

  Future<void> _openEdit(_OutEntry e) async {
    final o = e.records.first;
    final customerCtl = TextEditingController(text: wsS(o['customer']));
    var date = wsS(o['date'], fallback: wsToday());
    var pay = wsS(o['pay_status'], fallback: 'paid');
    var saving = false;
    final selected = wsS(o['settle_cats'])
        .split(',')
        .where((x) => x.isNotEmpty)
        .toSet();
    final saved = await desktopDialog<bool>(
      context,
      title: '修改出库单',
      width: 660,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDlg) {
          Future<void> submit() async {
            if (date.isEmpty) {
              wsToast(ctx, '请选择出库日期', error: true);
              return;
            }
            setDlg(() => saving = true);
            try {
              await ApiService.updateOutbound(wsI(o['id']), {
                'customer': customerCtl.text.trim(),
                'date': date,
                'pay_status': pay,
                'settle_cats': _editSettleOpts.map((x) => x.value).where(selected.contains).toList(),
              });
              if (!ctx.mounted) return;
              Navigator.of(ctx).pop(true);
            } on ApiException catch (err) {
              if (!ctx.mounted) return;
              setDlg(() => saving = false);
              wsToast(ctx, '保存失败：${err.message}', error: true);
            }
          }

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${wsS(o['code'])} · 销售收入 ${wsMoney(wsD(o['total_amount']))}'
                '${wsD(o['adjust_amount']) != 0 ? '（调整 ${wsD(o['adjust_amount']) > 0 ? '+' : '-'}${wsMoney(wsD(o['adjust_amount']).abs())}）' : ''}'
                '${wsD(o['settle_income']) > 0 ? ' · 客户代收 ${wsMoney(wsD(o['settle_income']))}' : ''}'
                ' · 实收 ${wsMoney(wsD(o['final_amount']))}',
                style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight, height: 1.6),
              ),
              const SizedBox(height: 14),
              Wrap(
                spacing: 18,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  DesktopLabeled(
                    label: '客户',
                    child: DesktopTextField(
                      controller: customerCtl,
                      width: 240,
                      hintText: '客户名称',
                    ),
                  ),
                  DesktopLabeled(
                    label: '出库日期 *',
                    child: DesktopDateField(
                      value: date,
                      width: 150,
                      allowClear: false,
                      onChanged: (v) => setDlg(() => date = v),
                    ),
                  ),
                  DesktopLabeled(
                    label: '付款状态',
                    child: DesktopPayRadios(value: pay, onChanged: (v) => setDlg(() => pay = v)),
                  ),
                ],
              ),
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('待付款：先进「待付款账单」，点「已支付」后才计入财务报表',
                    style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5)),
              ),
              const SizedBox(height: 14),
              const Text('实收金额包含（客户随货款一起付的关联结算）',
                  style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
              const SizedBox(height: 6),
              DesktopCheckList<String>(
                options: _editSettleOpts,
                selected: selected,
                onToggle: (v, on) => setDlg(() {
                  if (on) {
                    selected.add(v);
                  } else {
                    selected.remove(v);
                  }
                }),
                width: 300,
                height: 116,
              ),
              const SizedBox(height: 6),
              const SizedBox(
                width: 560,
                child: Text(
                  '改这里只影响「实收金额」与报表收入（实收 = 货款 + 调整 + 勾选项金额），成本与库存不变。'
                  '以上四项可改；保存后操作员记为当前登录账号。商品 / 数量 / 价格如需更正，请删除后重新出库。',
                  style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  DesktopButton(label: '取消', onPressed: () => Navigator.of(ctx).pop(false)),
                  const SizedBox(width: 10),
                  DesktopButton(
                    label: saving ? '保存中…' : '✓ 保存',
                    kind: DesktopButtonKind.success,
                    onPressed: saving ? null : () => submit(),
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
    customerCtl.dispose();
    if (saved != true || !mounted) return;
    wsToast(context, '已保存，操作员记为 ${widget.auth.displayName}');
    await _loadRecords();
  }

  Future<void> _openDetail(_OutEntry e) {
    if (e.isGroup) {
      return desktopDialog(
        context,
        title: '出库批次明细 · ${e.importGroup}',
        width: 1160,
        maxHeight: 820,
        builder: (ctx) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            OutBatchDetail(records: e.records, onOpenOrder: _openOrder),
            const SizedBox(height: 14),
            Align(
              alignment: Alignment.centerRight,
              child: DesktopButton(label: '关闭', onPressed: () => Navigator.of(ctx).pop()),
            ),
          ],
        ),
      );
    }
    return _openOrder(e.records.first);
  }

  /// 单张出库单的原行明细（批次聚合面板里点单号也走这里）
  Future<void> _openOrder(Map<String, dynamic> o) {
    return desktopDialog(
      context,
      title: '出库单明细 · ${wsS(o['code'])}',
      width: 980,
      maxHeight: 780,
      builder: (ctx) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _orderCard(o),
          Align(
            alignment: Alignment.centerRight,
            child: DesktopButton(label: '关闭', onPressed: () => Navigator.of(ctx).pop()),
          ),
        ],
      ),
    );
  }

  Widget _orderCard(Map<String, dynamic> o) {
    return WsCard(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
      marginBottom: 12,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '${wsS(o['code'])} · ${wsS(o['date'])} · ${wsS(o['customer'], fallback: '—')}'
            ' · 操作员 ${wsS(o['operator'], fallback: '—')}'
            ' · 实收 ${wsMoney(wsD(o['final_amount']))}'
            ' · ${wsS(o['pay_status'], fallback: 'paid') == 'paid' ? '已付款' : '待付款'}',
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 10),
          DesktopGrid(
            dense: true,
            cols: const <DesktopCol>[
              DesktopCol('商品', width: 240),
              DesktopCol('类型', width: 96, center: true),
              DesktopCol('数量', width: 120, right: true),
              DesktopCol('金额', width: 110, right: true),
              DesktopCol('成本', width: 110, right: true),
              DesktopCol('打包费', width: 96, right: true),
            ],
            rows: [
              for (final l in ((o['lines'] as List?) ?? const []))
                if (l is Map)
                  DesktopRow(
                    cells: [
                      wsCell(
                        '${wsS(l['product_name'])}${l['is_dropship'] == true ? '（代发）' : ''}',
                        tip: wsS(l['spec']),
                      ),
                      l['line_type'] == 'sale'
                          ? const DesktopTag('销售', color: WsTokens.primary)
                          : const DesktopTag('包装消耗', color: DesktopTag.off),
                      wsCell('${_q(wsD(l['quantity']))} ${wsS(l['unit'])}'),
                      wsCell(wsMoney(wsD(l['amount']))),
                      wsCell(wsMoney(wsD(l['cogs']))),
                      wsCell(wsD(l['pack_fee']) > 0 ? wsMoney(wsD(l['pack_fee'])) : '—'),
                    ],
                  ),
            ],
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------- 分组汇总

  List<_AggRow> _aggregate(int dim) {
    final map = <String, _AggRow>{};
    for (final o in _filteredRecords) {
      final date = wsS(o['date']);
      final customer = wsS(o['customer'], fallback: '—');
      for (final l in ((o['lines'] as List?) ?? const [])) {
        if (l is! Map || wsS(l['line_type']) != 'sale') continue;
        final spec = wsS(l['spec']);
        final label = switch (dim) {
          0 => wsS(l['product_name'], fallback: '—'),
          1 => spec.isEmpty ? '—' : spec,
          2 => date,
          _ => customer,
        };
        final agg = map.putIfAbsent(label, () => _AggRow(label));
        agg.orders.add(wsI(o['id']));
        agg.qty += wsD(l['quantity']);
        agg.units.add(wsS(l['unit']));
        agg.amount += wsD(l['amount']);
        agg.cogs += wsD(l['cogs']);
      }
    }
    return map.values.toList()..sort((a, b) => b.amount.compareTo(a.amount));
  }

  // ---------------------------------------------------------------- 模板 / 批量导入

  Future<void> _downloadTemplate() async {
    final savePath = await FilePicker.platform.saveFile(
      dialogTitle: '保存出库导入模板',
      fileName: 'outbounds_template.xlsx',
    );
    if (savePath == null || !mounted) return;
    try {
      await ApiService.download(ApiService.templatePath('outbounds'), savePath);
      if (!mounted) return;
      wsToast(context, '模板已保存到：$savePath');
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '下载失败：${e.message}', error: true);
    }
  }

  Future<void> _openBatchImport({required bool jushuitan}) async {
    FilePickerResult? picked;
    try {
      picked = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['xlsx']);
    } catch (e) {
      if (!mounted) return;
      wsToast(context, '选择文件失败：$e', error: true);
      return;
    }
    if (!mounted) return;
    if (picked == null || picked.files.isEmpty) {
      wsToast(context, '未选择文件');
      return;
    }
    final fileName = picked.files.first.name;
    final path = picked.files.first.path;
    if (path == null) {
      wsToast(context, '读不到所选文件路径', error: true);
      return;
    }
    Map<String, dynamic> data;
    try {
      data = jushuitan ? await ApiService.previewImportJushuitan(path) : await ApiService.previewImportOutbounds(path);
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '解析失败：${e.message}', error: true);
      return;
    }
    if (!mounted) return;
    await _showDraftReview(data, jushuitan: jushuitan, fileName: fileName);
  }

  Future<void> _showDraftReview(
    Map<String, dynamic> data, {
    required bool jushuitan,
    required String fileName,
  }) async {
    final drafts = <_Draft>[
      for (final raw in (data['orders'] as List? ?? const []))
        if (raw is Map) _Draft.fromMap(Map<String, dynamic>.from(raw)),
    ];
    final brushHit = [for (final w in (data['brush_warehouses'] as List? ?? const [])) w.toString()];
    final brushDefault = wsD(data['brush_default_fee']);
    final unmappedCodes = [for (final c in (data['unmapped_codes'] as List? ?? const [])) c.toString()];
    final unmapped = (data['unmapped'] as List?) ?? const [];
    final notices = (data['notices'] as List?) ?? const [];
    final failedRows = (data['failed'] as List?) ?? const [];
    final skip = (data['skip'] as Map?) ?? const {};
    var confirming = false;

    await desktopDialog<void>(
      context,
      title: jushuitan ? '导入聚水潭出库单 — 确认出库' : '批量出库 — 确认出库',
      width: 1080,
      maxHeight: 820,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDlg) {
          final included = drafts.where((d) => d.include).length;

          Future<void> confirm() async {
            if (confirming) return;
            final orders = <Map<String, dynamic>>[];
            for (final d in drafts) {
              if (!d.include) continue;
              final lines = d.lineMaps();
              if (lines.isEmpty) continue;
              orders.add({
                'doc_no': d.docNo,
                'date': d.date,
                'customer': d.customer,
                'operator': d.operator,
                'remark': d.remark,
                'pack_fee': d.packFee,
                'pack_rule_id': d.packRuleId,
                'pack_rule_name': d.packRuleName,
                'pack_lines': d.packLines,
                'warehouse': d.warehouse,
                'brush_cost': double.tryParse(d.brushCost.text) ?? 0,
                'brush_fee': double.tryParse(d.brushFee.text) ?? 0,
                'lines': lines,
              });
            }
            if (orders.isEmpty) {
              wsToast(ctx, '没有勾选任何单据', error: true);
              return;
            }
            setDlg(() => confirming = true);
            try {
              final res = jushuitan
                  ? await ApiService.confirmImportJushuitan(orders, source: fileName)
                  : await ApiService.confirmImportOutbounds(orders, source: fileName);
              if (!ctx.mounted) return;
              Navigator.of(ctx).pop();
              if (!mounted) return;
              await _showImportResult(res);
            } on ApiException catch (e) {
              if (!ctx.mounted) return;
              setDlg(() => confirming = false);
              wsToast(ctx, '出库失败：${e.message}', error: true);
            }
          }

          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                drafts.isEmpty
                    ? '未解析出可出库的单据。'
                    : '解析出 ${drafts.length} 单。可勾选、修改数量/单价后点击「确认出库」。',
                style: const TextStyle(fontSize: 13, color: WsTokens.green, height: 1.6),
              ),
              const SizedBox(height: 10),
              if (unmappedCodes.isNotEmpty) ...[
                DesktopNotice(
                  '⚠ 未关联商品 ${unmappedCodes.length} 个：${unmappedCodes.join('、')}\n'
                  '可点下面的「去新增商品」按该名称新建（保存后回到本页点「重新解析」即按名称自动匹配）。'
                  '${unmapped.any((u) => u is Map && wsS(u['stock_product_name']).isNotEmpty) ? '带「缺关联结算小类」的，是平台商品名只匹配到了库存大类（未扣任何库存）—— 新建订单小类并关联该大类后重新解析即可正常结算。' : ''}',
                  kind: DesktopNoticeKind.warn,
                ),
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      for (final c in unmappedCodes)
                        DesktopButton(
                          small: true,
                          label: '去新增商品：$c',
                          icon: SolarIconsOutline.plus,
                          onPressed: () {
                            Navigator.of(ctx).pop();
                            widget.onNavigate('/products');
                          },
                        ),
                    ],
                  ),
                ),
              ],
              if (skip.values.any((v) => wsD(v) > 0))
                DesktopNotice(
                  '⚠ 跳过：${skip.entries.where((e) => wsD(e.value) > 0).map((e) => '${e.key} ${wsI(e.value)}单').join('、')}',
                  kind: DesktopNoticeKind.warn,
                ),
              if (notices.isNotEmpty)
                DesktopNotice(
                  '提示 ${notices.length} 条（单子照建，只是某行没建出来）：'
                  '${notices.take(5).map((f) => f is Map ? wsS(f['reason']) : f.toString()).join('；')}',
                  kind: DesktopNoticeKind.warn,
                ),
              if (failedRows.isNotEmpty)
                DesktopNotice(
                  '解析失败 ${failedRows.length} 条：'
                  '${failedRows.take(5).map((f) => f is Map ? wsS(f['reason']) : f.toString()).join('；')}',
                  kind: DesktopNoticeKind.error,
                ),
              if (brushHit.isNotEmpty)
                DesktopNotice(
                  '本次命中放单仓（${brushHit.join('、')}）：这些单不结转本仓成本，'
                  '请逐单填「快递+包装固定费」（默认 ${wsMoney(brushDefault)}）与「刷单成本」，'
                  '利润 = 结算收入 − 固定费 − 刷单成本。',
                  kind: DesktopNoticeKind.info,
                ),
              if (drafts.isEmpty)
                Align(
                  alignment: Alignment.centerRight,
                  child: DesktopButton(label: '返回重新选择文件', onPressed: () => Navigator.of(ctx).pop()),
                )
              else ...[
                const SizedBox(height: 8),
                for (final d in drafts) _draftCard(d, setDlg, jushuitan, brushHit, brushDefault),
                const SizedBox(height: 12),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    Text('已勾选 $included 单',
                        style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                    const SizedBox(width: 14),
                    DesktopButton(label: '取消', onPressed: () => Navigator.of(ctx).pop()),
                    const SizedBox(width: 10),
                    DesktopButton(
                      label: confirming ? '提交中…' : '✓ 确认出库（$included 单）',
                      kind: DesktopButtonKind.success,
                      onPressed: confirming ? null : () => confirm(),
                    ),
                  ],
                ),
              ],
            ],
          );
        },
      ),
    );

    for (final d in drafts) {
      d.dispose();
    }
  }

  Widget _draftCard(
    _Draft d,
    void Function(void Function()) setDlg,
    bool jushuitan,
    List<String> brushHit,
    double brushDefault,
  ) {
    final isBrush = jushuitan && d.warehouse.isNotEmpty && brushHit.contains(d.warehouse);
    final income = d.lines.fold<double>(0, (s, l) => s + l.amount);
    final fee = isBrush ? (double.tryParse(d.brushFee.text) ?? brushDefault) : 0.0;
    final cost = double.tryParse(d.brushCost.text) ?? 0;
    final profit = income - fee - cost;
    return WsCard(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      marginBottom: 12,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 12,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Checkbox(
                value: d.include,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                onChanged: (v) => setDlg(() => d.include = v ?? false),
              ),
              Text(
                d.docNo.isEmpty ? '（无单号）' : d.docNo,
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
              ),
              if (d.warehouse.isNotEmpty) DesktopTag('仓储方 ${d.warehouse}', color: WsTokens.amber),
              if (d.packFee > 0) Text('打包费 ${wsMoney(d.packFee)}',
                  style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              if (d.packRuleName.isNotEmpty) Text('规则：${d.packRuleName}',
                  style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              DesktopDateField(
                value: d.date,
                width: 140,
                allowClear: false,
                onChanged: (v) => setDlg(() => d.date = v),
              ),
              DesktopTextField(
                controller: d.customerCtl,
                width: 160,
                hintText: '客户',
                onChanged: (_) => setDlg(() {}),
              ),
              if (isBrush)
                Text('结算收入 ${wsMoney(income)}',
                    style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
            ],
          ),
          const SizedBox(height: 10),
          DesktopGrid(
            dense: true,
            cols: const <DesktopCol>[
              DesktopCol('商品', width: 300),
              DesktopCol('单位', width: 90),
              DesktopCol('数量', width: 110),
              DesktopCol('单价', width: 110),
              DesktopCol('金额', width: 110, right: true),
            ],
            rows: [
              for (final l in d.lines)
                DesktopRow(
                  cells: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        wsCell(l.name, tip: l.deduct.isEmpty ? l.spec : '${l.deduct} · ${l.spec}'),
                        if (l.deduct.isNotEmpty)
                          Text(l.deduct, style: const TextStyle(fontSize: 10.5, color: WsTokens.mutedLight)),
                      ],
                    ),
                    wsCell(l.unit),
                    DesktopTextField(
                      controller: l.qty,
                      width: 90,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      inputFormatters: DesktopTextField.decimalOnly,
                      onChanged: (_) => setDlg(() {}),
                    ),
                    DesktopTextField(
                      controller: l.price,
                      width: 90,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      inputFormatters: DesktopTextField.decimalOnly,
                      onChanged: (_) => setDlg(() {}),
                    ),
                    wsCell(wsMoney(l.amount)),
                  ],
                ),
            ],
          ),
          if (isBrush) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 14,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                DesktopLabeled(
                  label: '快递+包装固定费',
                  child: DesktopTextField(
                    controller: d.brushFee,
                    width: 90,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: DesktopTextField.decimalOnly,
                    onChanged: (_) => setDlg(() {}),
                  ),
                ),
                DesktopLabeled(
                  label: '刷单成本',
                  child: DesktopTextField(
                    controller: d.brushCost,
                    width: 110,
                    hintText: '我刷这单的成本',
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: DesktopTextField.decimalOnly,
                    onChanged: (_) => setDlg(() {}),
                  ),
                ),
                Text(
                  '利润 ${wsMoney(profit)}',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: profit >= 0 ? WsTokens.green : WsTokens.red,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Future<void> _showImportResult(Map<String, dynamic> res) {
    final created = wsI(res['created']);
    final failedCount = wsI(res['failed_count']);
    final failed = (res['failed'] as List?) ?? const [];
    final warns = (res['warnings'] as List?) ?? const [];
    return desktopDialog(
      context,
      title: '导入结果',
      width: 780,
      builder: (ctx) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DesktopStatGrid(
            minTileWidth: 180,
            children: [
              DesktopStatCard(label: '成功出库', value: '$created 单', color: WsTokens.green),
              DesktopStatCard(
                label: '失败',
                value: '$failedCount',
                color: failedCount > 0 ? WsTokens.red : null,
              ),
              DesktopStatCard(
                label: '预警',
                value: '${warns.length}',
                color: warns.isNotEmpty ? WsTokens.amber : null,
              ),
            ],
          ),
          if (failed.isNotEmpty) ...[
            const SizedBox(height: 14),
            DesktopGrid(
              dense: true,
              cols: const <DesktopCol>[
                DesktopCol('行 / 单号', width: 170),
                DesktopCol('原因', width: 500),
              ],
              rows: [
                for (final f in failed)
                  if (f is Map)
                    DesktopRow(
                      cells: [
                        wsCell(wsS(f['doc']).isEmpty ? wsS(f['row']) : wsS(f['doc'])),
                        wsCell(wsS(f['reason'])),
                      ],
                    ),
              ],
            ),
          ],
          if (warns.isNotEmpty) ...[
            const SizedBox(height: 12),
            for (final w in warns) DesktopNotice('⚠ $w（仍可继续，可先补货）', kind: DesktopNoticeKind.warn),
          ],
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: DesktopButton(label: '关闭', onPressed: () => Navigator.of(ctx).pop()),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '出库 / 销售',
      subtitle: '卖商品自动结转关联包装材料与打包费；成本按先进先出（FIFO）结转，待付款单先进「待付款账单」',
      actions: [
        DesktopButton(label: '导入模板下载', icon: SolarIconsOutline.download, onPressed: _downloadTemplate),
        DesktopButton(
          label: 'Excel 导入',
          icon: SolarIconsOutline.fileText,
          onPressed: () => _openBatchImport(jushuitan: false),
        ),
        DesktopButton(
          label: '聚水潭出库单导入',
          icon: SolarIconsOutline.cloudDownload,
          onPressed: () => _openBatchImport(jushuitan: true),
        ),
        DesktopButton(
          label: '刷新',
          icon: SolarIconsOutline.refresh,
          onPressed: () {
            _loadMeta();
            _loadRecords();
          },
        ),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: DesktopTabs(
              items: const ['开单（出库录单）', '出库记录'],
              index: _tab,
              onChanged: (i) => setState(() => _tab = i),
            ),
          ),
          Expanded(child: _tab == 0 ? _buildCreateTab() : _buildRecordsTab()),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------- 子页 1：开单

  Widget _buildCreateTab() {
    final t = _calcTotals();
    return DesktopScrollBody(
      children: [
        DesktopRise(
          index: 0,
          child: WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const WsCardHead(title: '新增出库 / 销售单', icon: SolarIconsOutline.upload),
                Wrap(
                  spacing: 18,
                  runSpacing: 12,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    DesktopLabeled(
                      label: '日期 *',
                      child: DesktopDateField(
                        value: _date,
                        allowClear: false,
                        onChanged: (v) => setState(() => _date = v),
                      ),
                    ),
                    DesktopLabeled(
                      label: '客户',
                      child: DesktopTextField(
                        width: 200,
                        hintText: '客户名称',
                        onChanged: (v) => _customer = v,
                      ),
                    ),
                    const DesktopLabeled(
                      label: '操作员',
                      child: DesktopTextField(width: 150, readonly: true),
                    ),
                    DesktopLabeled(
                      label: '付款状态',
                      child: DesktopPayRadios(value: _payStatus, onChanged: (v) => setState(() => _payStatus = v)),
                    ),
                    DesktopLabeled(
                      label: '备注',
                      child: DesktopTextField(width: 340, hintText: '可选', onChanged: (v) => _remark = v),
                    ),
                  ],
                ),
                if (_payStatus == 'unpaid') ...[
                  const SizedBox(height: 10),
                  const Text('待付款（未回款）：整单先进「待付款账单」，收款后才计入财务报表',
                      style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                ],
                const SizedBox(height: 8),
                const Text('操作员锁定为当前登录账号（后端也会忽略前端传入的 operator）',
                    style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
              ],
            ),
          ),
        ),
        DesktopRise(
          index: 1,
          child: WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const WsCardHead(title: '销售商品行', icon: SolarIconsOutline.listCheck),
                DesktopGrid(
                  cols: const <DesktopCol>[
                    DesktopCol('商品', width: 280),
                    DesktopCol('销售单位', width: 100),
                    DesktopCol('数量', width: 100),
                    DesktopCol('单价', width: 110),
                    DesktopCol('小计', width: 120, right: true),
                    DesktopCol('当前库存', width: 160, right: true),
                    DesktopCol('', width: 56),
                  ],
                  rows: [for (var i = 0; i < _rows.length; i++) _saleRow(i, _rows[i])],
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 12,
                  runSpacing: 10,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    DesktopButton(label: '＋ 添加商品行', icon: SolarIconsOutline.plus, onPressed: _addRow),
                    DesktopButton(
                      label: _previewing ? '结算中…' : '🔍 预览结算',
                      icon: SolarIconsOutline.calculator,
                      kind: DesktopButtonKind.primary,
                      onPressed: _previewing || _submitting ? null : _doPreview,
                    ),
                    _check('自动计快递费', _autoExpress, (v) => setState(() {
                          _autoExpress = v;
                          if (!v) {
                            _packRows.removeWhere((r) {
                              if (!r.express) return false;
                              r.dispose();
                              return true;
                            });
                          }
                        })),
                    const SizedBox(
                      width: 460,
                      child: Text(
                        '自动带出泡沫箱 / 泡沫垫 / 打包费等关联结算项；勾选时再按整单毛重自动计快递费（不勾选则这笔不算快递费）',
                        style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
                      ),
                    ),
                  ],
                ),
                if (_expressRule.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(
                      '快递费计费规则：${_expressRuleText()}（整单毛重 = 商品净重合计 + 箱体 0.1kg，费用以后端预览实算，本页不本地重算）',
                      style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight),
                    ),
                  ),
              ],
            ),
          ),
        ),
        if (_preview != null)
          DesktopRise(
            index: 2,
            child: WsCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  WsCardHead(
                    title: '关联结算（包装材料 / 固定费用）',
                    icon: SolarIconsOutline.layers,
                    trailing: DesktopButton(label: '清除预览', small: true, onPressed: _clearPreview),
                  ),
                  for (final w in _warnings)
                    DesktopNotice('⚠ $w（仍可继续，可先补货）', kind: DesktopNoticeKind.warn),
                  if (_warnings.isNotEmpty)
                    const DesktopNotice(
                      '库存不足也可继续出库（出库后留负库存），可先补货或再盘点',
                      kind: DesktopNoticeKind.info,
                    ),
                  if (_packRows.isEmpty)
                    const DesktopNotice('无关联结算项（该商品未配置包装清单）', kind: DesktopNoticeKind.info)
                  else
                    DesktopGrid(
                      cols: const <DesktopCol>[
                        DesktopCol('商品', width: 280),
                        DesktopCol('单位', width: 100),
                        DesktopCol('数量', width: 110),
                        DesktopCol('类型', width: 110, center: true),
                        DesktopCol('成本', width: 140, right: true),
                        DesktopCol('小计', width: 120, right: true),
                        DesktopCol('', width: 56),
                      ],
                      rows: [for (var i = 0; i < _packRows.length; i++) _packRowRow(i, _packRows[i])],
                    ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 12,
                    runSpacing: 10,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      DesktopButton(
                        label: '＋ 添加关联物品',
                        small: true,
                        icon: SolarIconsOutline.plus,
                        onPressed: _addManualPackItem,
                      ),
                      const SizedBox(
                        width: 520,
                        child: Text(
                          '手动挑选本单实际用到的包材 / 人工 / 快递费等（任意商品都可选）；'
                          '数量按本单用量填，提交时与自动带出的结算项一起结转成本',
                          style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 18,
                    runSpacing: 12,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      DesktopLabeled(
                        label: '固定费用合计（人工打包费等）',
                        child: DesktopTextField(
                          controller: _feeCtl,
                          width: 120,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          inputFormatters: DesktopTextField.decimalOnly,
                          onChanged: (_) => setState(() => _feeManual = true),
                        ),
                      ),
                      if (_feeManual) DesktopLink('恢复建议值', onPressed: _feeReset),
                      DesktopLabeled(
                        label: '调整（给客户抹零 / 凑整）',
                        child: DesktopTextField(
                          controller: _adjustCtl,
                          width: 110,
                          hintText: '0.00',
                          keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                      const Text('正=加收，负=抹零；差额自动记「金额调整」其他开支，商品成本不变',
                          style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                    ],
                  ),
                  const SizedBox(height: 16),
                  const Text('实收金额包含（客户随货款一起付的关联结算）',
                      style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                  const SizedBox(height: 8),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      DesktopCheckList<String>(
                        options: _settleOpts,
                        selected: _settleCats.toSet(),
                        onToggle: (v, on) => setState(() {
                          _settleCats = on ? [..._settleCats, v] : _settleCats.where((e) => e != v).toList();
                          _saveSettleCats();
                        }),
                        width: 300,
                        height: 152,
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                DesktopButton(label: '全选', small: true, onPressed: () => _setSettleAll(true)),
                                const SizedBox(width: 8),
                                DesktopButton(label: '全不选', small: true, onPressed: () => _setSettleAll(false)),
                                const SizedBox(width: 14),
                                Expanded(
                                  child: Text(
                                    t.settle > 0
                                        ? '客户代收：${_settleCatsLabel(_settleCats)} ${wsMoney(t.settle)} → 实收 ${wsMoney(t.finalAmount)}'
                                        : '当前：实收 = 货款 + 调整（客户不承担关联结算）',
                                    style: const TextStyle(fontSize: 12, color: WsTokens.primary),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            const Text(
                              '勾选的类别会计入「实收金额」与报表收入（客户是付了这笔钱的）；成本照旧含包材/快递，'
                              '所以毛利不会被包材吃掉。「固定成本」= 上面的固定费用合计（工时/胶带这类按金额记的），客户付回时才勾。'
                              '不勾 = 实收只算货款 + 调整（旧口径）。选择会记住（SharedPreferences），下一单沿用。',
                              style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  DesktopStatGrid(
                    minTileWidth: 190,
                    children: [
                      DesktopStatCard(label: '销售收入', value: wsMoney(t.amount)),
                      DesktopStatCard(
                        label: '实收金额',
                        value: wsMoney(t.finalAmount),
                        sub: t.settle > 0 ? '含${_settleCatsLabel(_settleCats)} ${wsMoney(t.settle)}' : null,
                      ),
                      DesktopStatCard(label: '结转成本（FIFO）', value: wsMoney(t.cogs)),
                      DesktopStatCard(label: '固定费用', value: wsMoney(t.fee)),
                      DesktopStatCard(
                        label: '毛利',
                        value: wsMoney(t.gross),
                        color: t.gross >= 0 ? WsTokens.green : WsTokens.red,
                      ),
                      DesktopStatCard(
                        label: '净利',
                        value: wsMoney(t.net),
                        color: t.net >= 0 ? WsTokens.green : WsTokens.red,
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      DesktopButton(
                        label: _submitting ? '出库中…' : '✓ 确认出库',
                        icon: SolarIconsOutline.checkCircle,
                        kind: DesktopButtonKind.success,
                        onPressed: _submitting ? null : _submit,
                      ),
                      const SizedBox(width: 10),
                      DesktopButton(label: '取消', onPressed: _clearPreview),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Text(
                          '后端预览口径：成本 ${wsMoney(wsD(_preview?['total_cogs']))} · '
                          '关联结算代收 ${wsMoney(wsD(_preview?['settle_income']))} · '
                          '毛利 ${wsMoney(wsD(_preview?['gross_profit']))} · '
                          '净利 ${wsMoney(wsD(_preview?['net_profit']))}',
                          style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  void _feeReset() {
    if (_preview == null) return;
    setState(() {
      _feeManual = false;
      _feeCtl.text = wsD(_preview?['total_fee']).toStringAsFixed(2);
    });
  }

  void _setSettleAll(bool on) {
    setState(() {
      _settleCats = on ? [for (final o in _settleOpts) o.value] : const [];
      _saveSettleCats();
    });
  }

  String _settleCatsLabel(List<String> cats) => cats.map((k) => _settleLabels[k] ?? k).join('、');

  String _expressRuleText() {
    if (wsS(_expressRule['mode'], fallback: 'tiered') == 'flat') {
      return '按每 kg 单价 ${wsMoney(wsD(_expressRule['rate_per_kg']))}';
    }
    return '首重 1kg ${wsMoney(wsD(_expressRule['first_kg_fee']))}，'
        '每超 1kg 加收 ${wsMoney(wsD(_expressRule['per_extra_kg']))}'
        '${_expressRule['round_up'] == true ? '（按整 kg 向上取整）' : ''}';
  }

  Widget _check(String label, bool value, ValueChanged<bool> onChanged) {
    return InkWell(
      onTap: () => onChanged(!value),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Checkbox(
            value: value,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            onChanged: (v) => onChanged(v ?? false),
          ),
          const SizedBox(width: 4),
          Text(label, style: const TextStyle(fontSize: 12.5)),
        ],
      ),
    );
  }

  DesktopRow _saleRow(int i, _SaleRow row) {
    final p = row.product;
    final qty = double.tryParse(row.qty.text) ?? 0;
    final price = double.tryParse(row.price.text) ?? 0;
    final drop = p != null && _isDropship(p);
    final need = qty * (p?.conversions?[row.unit] ?? 1.0);
    final short = p != null && !drop && need > p.stock + 1e-6;
    final stockText = p == null ? '—' : (drop ? '代发·不扣库存' : '${_q(p.stockInUnit)} ${p.unit}');
    return DesktopRow(
      cells: [
        DesktopSearchField(
          title: '选择销售商品',
          value: p == null ? null : '${p.id}',
          options: _saleOptions,
          width: 260,
          hint: '＋ 点击选择商品',
          onChanged: (v) => _pickSaleProduct(row, v),
        ),
        DesktopSelect<String>(
          value: row.unit,
          options: _unitsOf(p),
          width: 80,
          onChanged: (v) => setState(() {
            row.unit = v ?? '';
            _fillSalePrice(row);
          }),
        ),
        DesktopTextField(
          controller: row.qty,
          width: 80,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: DesktopTextField.decimalOnly,
        ),
        DesktopTextField(
          controller: row.price,
          width: 90,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: DesktopTextField.decimalOnly,
        ),
        wsCell(wsMoney(qty * price), bold: true),
        wsCell(
          stockText,
          color: short ? WsTokens.red : (drop ? WsTokens.primary : null),
          tip: short
              ? '库存不足：需 ${_q(need)} ${p.baseUnit}（= ${_q(qty)} ${row.unit}），'
                  '现有 ${_q(p.stockInUnit)} ${p.unit}（仍可继续出库）'
              : null,
        ),
        DesktopLink(
          '✕',
          color: _rows.length > 1 ? WsTokens.red : WsTokens.mutedLight,
          onPressed: _rows.length > 1 ? () => _removeRow(i) : null,
        ),
      ],
    );
  }

  DesktopRow _packRowRow(int i, _PackRow r) {
    return DesktopRow(
      cells: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(child: wsCell(r.name, bold: true, tip: r.note.isEmpty ? null : r.note)),
            if (r.manual) ...[
              const SizedBox(width: 6),
              const DesktopTag('手动', color: WsTokens.primary),
            ],
          ],
        ),
        DesktopSelect<String>(
          value: r.unit,
          options: _unitsOf(_productById[r.productId]),
          width: 80,
          onChanged: (v) => setState(() => r.unit = v ?? r.unit),
        ),
        DesktopTextField(
          controller: r.qty,
          width: 90,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: DesktopTextField.decimalOnly,
        ),
        r.express
            ? const DesktopTag('快递费', color: DesktopTag.expense)
            : (r.settleCat == 'labor'
                ? const DesktopTag('人工', color: WsTokens.amber)
                : const DesktopTag('包装消耗', color: DesktopTag.off)),
        wsCell('${wsTrim(r.unitPrice)} / ${r.unit}'),
        wsCell(wsMoney(r.amount)),
        DesktopLink('✕', color: WsTokens.red, onPressed: () => _removePackRow(i)),
      ],
    );
  }

  // ---------------------------------------------------------------- 子页 2：出库记录

  Widget _buildRecordsTab() {
    final entries = _entries();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopFilterBar(
          right: DesktopTabs(
            small: true,
            items: const ['出库明细', '分组汇总'],
            index: _summaryView ? 1 : 0,
            onChanged: (i) => setState(() => _summaryView = i == 1),
          ),
          children: [
            const Text('日期区间', style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
            DesktopDateField(value: _from, onChanged: (v) => setState(() => _from = v)),
            const Text('—', style: TextStyle(color: WsTokens.mutedLight)),
            DesktopDateField(value: _to, onChanged: (v) => setState(() => _to = v)),
            DesktopButton(
              label: '今天',
              small: true,
              onPressed: () => setState(() {
                _from = wsToday();
                _to = wsToday();
              }),
            ),
            DesktopButton(
              label: '本月',
              small: true,
              onPressed: () => setState(() {
                _from = wsMonthStart();
                _to = wsToday();
              }),
            ),
            DesktopLabeled(
              label: '关键字',
              child: DesktopTextField(
                width: 200,
                hintText: '筛选单号 / 客户 / 商品 / 备注',
                onChanged: (v) => setState(() => _kw = v),
              ),
            ),
            DesktopLabeled(
              label: '付款状态',
              child: DesktopSelect<String>(
                width: 110,
                value: _payFilter,
                options: const <DesktopOption<String>>[
                  DesktopOption<String>('', '全部'),
                  DesktopOption<String>('paid', '已付款'),
                  DesktopOption<String>('unpaid', '待付款'),
                ],
                onChanged: (v) => setState(() => _payFilter = v ?? ''),
              ),
            ),
            DesktopButton(label: '筛选', icon: SolarIconsOutline.magnifier, onPressed: _loadRecords),
          ],
        ),
        if (!_summaryView)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Row(
              children: [
                DesktopTabs(
                  small: true,
                  items: const ['按单号分组', '逐行'],
                  index: _groupBy ? 0 : 1,
                  onChanged: (i) => setState(() => _groupBy = i == 0),
                ),
                const SizedBox(width: 14),
                Text(
                  '共 ${_filteredRecords.length} 单，合并 ${entries.length} 行',
                  style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight),
                ),
                const Spacer(),
                if (_selected.isNotEmpty) ...[
                  Text('已选 ${_selected.length} 张',
                      style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                  const SizedBox(width: 12),
                  DesktopButton(
                    label: '批量删除',
                    icon: SolarIconsOutline.trashBinTrash,
                    kind: DesktopButtonKind.danger,
                    small: true,
                    onPressed: _batchDelete,
                  ),
                  const SizedBox(width: 8),
                  DesktopButton(label: '取消选择', small: true, onPressed: () => setState(_selected.clear)),
                ],
              ],
            ),
          ),
        Expanded(
          child: DesktopStateView(
            loading: _loadingRecords,
            error: _recordsError,
            onRetry: _loadRecords,
            child: SingleChildScrollView(
              child: _summaryView ? _buildSummary() : _buildDetailGrid(entries),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildDetailGrid(List<_OutEntry> entries) {
    final rows = <DesktopRow>[];
    for (final e in entries) {
      rows.add(_entryRow(e));
      if (e.isGroup && _expanded.contains(e.key)) {
        rows.add(
          DesktopRow(
            tag: '${e.key}agg',
            cells: const <Widget>[],
            span: OutBatchDetail(
              records: e.records,
              onOpenOrder: _openOrder,
            ),
          ),
        );
      }
    }
    final totalAmount = entries.fold<double>(0, (s, e) => s + e.amount);
    final totalCogs = entries.fold<double>(0, (s, e) => s + e.cogs);
    final totalFee = entries.fold<double>(0, (s, e) => s + e.fee);
    final totalGross = entries.fold<double>(0, (s, e) => s + e.gross);
    return DesktopGrid(
      cols: const <DesktopCol>[
        DesktopCol('', width: 44, center: true),
        DesktopCol('单号 / 批次', width: 170, sortKey: 'code'),
        DesktopCol('日期', width: 110, sortKey: 'date'),
        DesktopCol('客户', width: 120, sortKey: 'customer'),
        DesktopCol('商品', width: 200),
        DesktopCol('数量(单位)', width: 130, right: true),
        DesktopCol('单价', width: 100, right: true),
        DesktopCol('金额', width: 120, right: true, sortKey: 'amount'),
        DesktopCol('打包费', width: 100, right: true, sortKey: 'fee'),
        DesktopCol('成本', width: 120, right: true, sortKey: 'cogs'),
        DesktopCol('毛利', width: 110, right: true),
        DesktopCol('操作员', width: 100),
        DesktopCol('付款状态', width: 84, center: true),
        DesktopCol('备注', width: 170),
        DesktopCol('操作', width: 230),
      ],
      rows: rows,
      sortKey: _sortKey,
      sortAsc: _sortAsc,
      onSort: _onSort,
      emptyText: '该日期区间没有出库记录',
      footer: <String>[
        '合计',
        '${entries.length} 行',
        '',
        '',
        '',
        '',
        '',
        wsMoney(totalAmount),
        wsMoney(totalFee),
        wsMoney(totalCogs),
        wsMoney(totalGross),
        '',
        '',
        '',
        '',
      ],
    );
  }

  DesktopRow _entryRow(_OutEntry e) {
    final sale = e.saleLines;
    final names = sale.map((l) => wsS(l['product_name'])).where((n) => n.isNotEmpty).toSet().toList();
    final qtyText = sale.map((l) => '${_q(wsD(l['quantity']))}${wsS(l['unit'])}').take(3).join(' / ');
    final prices = sale.map((l) => wsD(l['unit_price'])).toSet().toList();
    final first = e.records.first;
    final paid = wsS(first['pay_status'], fallback: 'paid') == 'paid';
    final ids = [for (final o in e.records) wsI(o['id'])];
    final allChecked = ids.isNotEmpty && ids.every(_selected.contains);
    final cats = wsS(first['settle_cats']).split(',').where((x) => x.isNotEmpty).toList();
    final tip = <String>[
      if (wsD(first['adjust_amount']) != 0)
        '调整 ${wsD(first['adjust_amount']) > 0 ? '+' : '-'}${wsMoney(wsD(first['adjust_amount']).abs())}',
      if (wsD(first['settle_income']) > 0)
        '含代收 ${wsMoney(wsD(first['settle_income']))}（${_settleCatsLabel(cats)}）',
      if (wsD(first['brush_adjust']) != 0) '刷单结算 ${wsMoney(wsD(first['brush_adjust']))}',
    ].join(' · ');
    return DesktopRow(
      tag: e.key,
      dim: !paid,
      onTap: e.isGroup ? () => _toggleExpand(e.key) : () => _openDetail(e),
      cells: [
        Checkbox(
          value: allChecked,
          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          onChanged: (v) => setState(() {
            if (v ?? false) {
              _selected.addAll(ids);
            } else {
              _selected.removeAll(ids);
            }
          }),
        ),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: wsCell(
                e.isGroup ? '${_expanded.contains(e.key) ? '▾' : '▸'} ${e.code}' : e.code,
                bold: true,
                tip: e.importGroup.isEmpty ? null : '批次号 ${e.importGroup}（点击展开聚合明细）',
              ),
            ),
            if (e.hasDropship) ...[
              const SizedBox(width: 4),
              const DesktopTag('含代发', color: WsTokens.primary),
            ],
          ],
        ),
        wsCell(e.date),
        wsCell(e.customer.isEmpty ? '—' : e.customer),
        wsCell(
          names.isEmpty ? '—' : (names.length == 1 ? names.first : '${names.first} 等 ${names.length} 种'),
          tip: names.join('、'),
        ),
        wsCell(qtyText.isEmpty ? '—' : qtyText, tip: '销售行 ${sale.length} 行'),
        wsCell(prices.isEmpty ? '—' : (prices.length == 1 ? wsMoney(prices.first) : '多价')),
        wsCell(wsMoney(e.amount), bold: true, tip: tip.isEmpty ? null : tip),
        wsCell(wsMoney(e.fee)),
        wsCell(wsMoney(e.cogs)),
        wsCell(wsMoney(e.gross), color: e.gross >= 0 ? WsTokens.green : WsTokens.red),
        wsCell(wsS(first['operator'], fallback: '—')),
        paid
            ? const DesktopTag('已付款', color: DesktopTag.paid)
            : const DesktopTag('待付款', color: DesktopTag.unpaid),
        wsCell(wsS(first['remark']), tip: wsS(first['remark'])),
        Wrap(
          spacing: 2,
          children: [
            DesktopLink('改', onPressed: () => _openEdit(e)),
            DesktopLink(e.isGroup ? '汇总' : '明细', onPressed: () => _openDetail(e)),
            DesktopLink(paid ? '转待付' : '标记已付', onPressed: () => _markPaid(e)),
            DesktopLink('删', color: WsTokens.red, onPressed: () => _deleteEntry(e)),
          ],
        ),
      ],
    );
  }

  Widget _buildSummary() {
    final agg = _aggregate(_sumDim);
    final totalAmount = agg.fold<double>(0, (s, r) => s + r.amount);
    final totalCogs = agg.fold<double>(0, (s, r) => s + r.cogs);
    final totalGross = agg.fold<double>(0, (s, r) => s + r.gross);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Row(
            children: [
              DesktopTabs(
                small: true,
                items: _sumDims,
                index: _sumDim,
                onChanged: (i) => setState(() => _sumDim = i),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  '本页内按「${_sumDims[_sumDim].replaceFirst('按', '')}」聚合当前筛选结果（${_filteredRecords.length} 单）的销售行，'
                  '只是本页的汇总视图，不落库、不影响其他报表。',
                  style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
                ),
              ),
            ],
          ),
        ),
        DesktopStatGrid(
          minTileWidth: 190,
          children: [
            DesktopStatCard(label: '维度数', value: '${agg.length}'),
            DesktopStatCard(label: '金额合计', value: wsMoney(totalAmount)),
            DesktopStatCard(label: '成本合计', value: wsMoney(totalCogs)),
            DesktopStatCard(
              label: '毛利合计',
              value: wsMoney(totalGross),
              color: totalGross >= 0 ? WsTokens.green : WsTokens.red,
            ),
          ],
        ),
        const SizedBox(height: 14),
        DesktopGrid(
          cols: const <DesktopCol>[
            DesktopCol('维度', width: 300),
            DesktopCol('单数', width: 90, right: true),
            DesktopCol('数量', width: 150, right: true),
            DesktopCol('金额', width: 130, right: true),
            DesktopCol('成本', width: 130, right: true),
            DesktopCol('毛利', width: 130, right: true),
          ],
          rows: [
            for (final r in agg)
              DesktopRow(
                cells: [
                  wsCell(r.label, tip: r.label),
                  wsCell('${r.orders.length}'),
                  wsCell('${_q(r.qty)} ${r.units.join('/')}'),
                  wsCell(wsMoney(r.amount)),
                  wsCell(wsMoney(r.cogs)),
                  wsCell(wsMoney(r.gross), color: r.gross >= 0 ? WsTokens.green : WsTokens.red),
                ],
              ),
          ],
          emptyText: '当前筛选结果没有销售行',
          footer: <String>[
            '合计',
            '',
            '',
            wsMoney(totalAmount),
            wsMoney(totalCogs),
            wsMoney(totalGross),
          ],
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------- 数据小类

/// 开单里的一行销售明细
class _SaleRow {
  final TextEditingController qty = TextEditingController(text: '1');
  final TextEditingController price = TextEditingController(text: '0');
  Product? product;
  String unit = '';

  void dispose() {
    qty.dispose();
    price.dispose();
  }
}

/// 预览带出 / 手动挑选的关联结算行（包材、人工、快递费）
class _PackRow {
  _PackRow({
    required this.productId,
    required this.name,
    required this.unit,
    required this.unitPrice,
    required this.settleCat,
    required this.manual,
    required this.express,
    required this.note,
    required this.qty,
  });

  final int productId;
  final String name;
  final String settleCat;
  final bool manual;
  final bool express;
  final String note;
  final double unitPrice;
  final TextEditingController qty;
  String unit;

  double get amount => unitPrice * (double.tryParse(qty.text) ?? 0);

  void dispose() => qty.dispose();
}

class _Totals {
  double amount = 0;
  double cogs = 0;
  double fee = 0;
  double settle = 0;
  double adjust = 0;

  double get finalAmount => amount + settle + adjust;
  double get gross => amount + settle - cogs;
  double get net => finalAmount - cogs - fee;
}

/// 分组汇总的一条聚合行
class _AggRow {
  _AggRow(this.label);

  final String label;
  final Set<int> orders = {};
  final Set<String> units = {};
  double qty = 0;
  double amount = 0;
  double cogs = 0;

  double get gross => amount - cogs;
}

/// 出库记录的一条展示行：单条出库单，或同一 import_group 折叠成的批次行
class _OutEntry {
  _OutEntry.of(Map<String, dynamic> o)
      : key = 'o${wsI(o['id'])}',
        isGroup = false,
        importGroup = wsS(o['import_group']),
        code = wsS(o['code']),
        date = wsS(o['date']),
        customer = wsS(o['customer']),
        orders = 1,
        records = [o],
        amount = wsD(o['final_amount'] ?? o['total_amount']),
        cogs = wsD(o['total_cogs']),
        fee = wsD(o['total_fee']),
        gross = wsD(o['gross_profit']),
        net = wsD(o['net_profit']),
        hasDropship = o['has_dropship'] == true;

  _OutEntry.group(String g, List<Map<String, dynamic>> recs)
      : key = 'g$g',
        isGroup = true,
        importGroup = g,
        code = '批量 · ${recs.length}单',
        date = _dateRangeOf(recs),
        customer = recs.map((r) => wsS(r['customer'])).where((c) => c.isNotEmpty).toSet().join(' / '),
        orders = recs.length,
        records = recs,
        amount = recs.fold<double>(0, (s, r) => s + wsD(r['final_amount'] ?? r['total_amount'])),
        cogs = recs.fold<double>(0, (s, r) => s + wsD(r['total_cogs'])),
        fee = recs.fold<double>(0, (s, r) => s + wsD(r['total_fee'])),
        gross = recs.fold<double>(0, (s, r) => s + wsD(r['gross_profit'])),
        net = recs.fold<double>(0, (s, r) => s + wsD(r['net_profit'])),
        hasDropship = recs.any((r) => r['has_dropship'] == true);

  final String key;
  final bool isGroup;
  final String importGroup;
  final String code;
  final String date;
  final String customer;
  final int orders;
  final List<Map<String, dynamic>> records;
  final double amount;
  final double cogs;
  final double fee;
  final double gross;
  final double net;
  final bool hasDropship;

  List<Map<String, dynamic>> get saleLines => [
        for (final o in records)
          for (final l in ((o['lines'] as List?) ?? const []))
            if (l is Map && wsS(l['line_type']) == 'sale') Map<String, dynamic>.from(l),
      ];

  static String _dateRangeOf(List<Map<String, dynamic>> recs) {
    final dates = recs.map((r) => wsS(r['date'])).toList()..sort();
    if (dates.first == dates.last) return dates.first;
    return '${dates.first} ~ ${dates.last}';
  }

  Object sortValue(String key) => switch (key) {
        'code' => code,
        'date' => date,
        'customer' => customer,
        'amount' => amount,
        'cogs' => cogs,
        'fee' => fee,
        'net' => net,
        _ => date,
      };
}

/// 批量出库 / 聚水潭出库单解析出来的一张草稿单（后端 DraftOrder）
class _Draft {
  _Draft({
    required this.docNo,
    required this.date,
    required this.operator,
    required this.remark,
    required this.warehouse,
    required this.packFee,
    required this.packRuleId,
    required this.packRuleName,
    required this.packLines,
    required this.lines,
    required this.customerCtl,
    required this.brushFee,
    required this.brushCost,
  });

  final String docNo;
  final String operator;
  final String remark;
  final String warehouse;
  final double packFee;
  final int? packRuleId;
  final String packRuleName;
  final List<dynamic> packLines;
  final List<_DraftLine> lines;
  final TextEditingController customerCtl;
  final TextEditingController brushFee;
  final TextEditingController brushCost;
  String date;
  bool include = true;

  String get customer => customerCtl.text.trim();

  factory _Draft.fromMap(Map<String, dynamic> m) {
    return _Draft(
      docNo: wsS(m['doc_no']),
      date: wsS(m['date'], fallback: wsToday()),
      operator: wsS(m['operator']),
      remark: wsS(m['remark']),
      warehouse: wsS(m['warehouse']),
      packFee: wsD(m['pack_fee']),
      packRuleId: m['pack_rule_id'] == null ? null : wsI(m['pack_rule_id']),
      packRuleName: wsS(m['pack_rule_name']),
      packLines: (m['pack_lines'] as List?) ?? const [],
      lines: [
        for (final l in ((m['lines'] as List?) ?? const []))
          if (l is Map) _DraftLine.fromMap(Map<String, dynamic>.from(l)),
      ],
      customerCtl: TextEditingController(text: wsS(m['customer'])),
      brushFee: TextEditingController(text: wsD(m['brush_fee_auto']).toStringAsFixed(2)),
      brushCost: TextEditingController(text: '0'),
    );
  }

  List<Map<String, dynamic>> lineMaps() => [
        for (final l in lines)
          if ((double.tryParse(l.qty.text) ?? 0) > 0) l.toMap(),
      ];

  void dispose() {
    customerCtl.dispose();
    brushFee.dispose();
    brushCost.dispose();
    for (final l in lines) {
      l.dispose();
    }
  }
}

class _DraftLine {
  _DraftLine({
    required this.productId,
    required this.name,
    required this.unit,
    required this.deduct,
    required this.spec,
    required this.gross,
    required this.qty,
    required this.price,
  });

  final int productId;
  final String name;
  final String unit;
  final String deduct;
  final String spec;
  final double gross;
  final TextEditingController qty;
  final TextEditingController price;

  double get amount => (double.tryParse(qty.text) ?? 0) * (double.tryParse(price.text) ?? 0);

  factory _DraftLine.fromMap(Map<String, dynamic> m) {
    return _DraftLine(
      productId: wsI(m['product_id']),
      name: wsS(m['product_name']),
      unit: wsS(m['unit']),
      deduct: wsS(m['deduct']),
      spec: wsS(m['spec']),
      gross: wsD(m['gross_sales']),
      qty: TextEditingController(text: wsTrim(wsD(m['quantity']), digits: 3)),
      price: TextEditingController(text: wsTrim(wsD(m['price']), digits: 2)),
    );
  }

  Map<String, dynamic> toMap() => {
        'product_id': productId,
        'unit': unit,
        'quantity': double.tryParse(qty.text) ?? 0,
        'price': double.tryParse(price.text) ?? 0,
        'gross_sales': gross,
      };

  void dispose() {
    qty.dispose();
    price.dispose();
  }
}

String _q(num? v) => wsTrim(wsD(v), digits: 3);
