import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';

/// 桌面端「入库」页，1:1 复刻 web #page-inbound（web/static/index.html + app.js）。
///
/// 两个子页：
///  - 录入入库单：一行 = 一张入库单，多行批量提交 /api/inbounds/batch；
///  - 入库记录：按日期区间 / 关键字 / 付款状态筛选，支持改单、删除、批量删除、标记已付。
/// 业务口径（金额、调整、运费/装卸计入批次成本、扣点折算、校验文案）与网页端一致。
class DesktopInboundScreen extends StatefulWidget {
  const DesktopInboundScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopInboundScreen> createState() => _DesktopInboundState();
}

// ---------------------------------------------------------------- 行模型

/// 录入区的一行（= 一张待提交的入库单）。文本用 controller 常驻，删行时才 dispose。
class _InRow {
  _InRow({required this.date});

  String date;
  int? productId;
  String unit = '';
  String pay = 'paid';
  final TextEditingController qty = TextEditingController();
  final TextEditingController price = TextEditingController();
  final TextEditingController adjust = TextEditingController();
  final TextEditingController freight = TextEditingController();
  final TextEditingController handling = TextEditingController();
  final TextEditingController supplier = TextEditingController();
  final TextEditingController remark = TextEditingController();

  /// 单价旁的折算/参考价提示（扣点命中时为「已按 原价×(1−扣点%) 折算」）
  String priceHint = '';
  String stockHint = '';

  double get qtyV => _textNum(qty);
  double get priceV => _textNum(price);
  double get adjustV => _textNum(adjust);
  double get freightV => _textNum(freight);
  double get handlingV => _textNum(handling);
  double get amount => qtyV * priceV;

  void clearAmounts() {
    qty.clear();
    price.clear();
    adjust.clear();
    freight.clear();
    handling.clear();
    pay = 'paid';
  }

  _InRow cloned() {
    final r = _InRow(date: date)
      ..productId = productId
      ..unit = unit
      ..pay = pay
      ..priceHint = priceHint
      ..stockHint = stockHint;
    r.qty.text = qty.text;
    r.price.text = price.text;
    r.adjust.text = adjust.text;
    r.freight.text = freight.text;
    r.handling.text = handling.text;
    r.supplier.text = supplier.text;
    r.remark.text = remark.text;
    return r;
  }

  void dispose() {
    qty.dispose();
    price.dispose();
    adjust.dispose();
    freight.dispose();
    handling.dispose();
    supplier.dispose();
    remark.dispose();
  }
}

/// Excel 导入预览的一行（勾选 + 可改数量/单价/运费/装卸）
class _ImportRow {
  _ImportRow(this.src)
      : qty = TextEditingController(text: _textNumOf(src['quantity']).toString()),
        price = TextEditingController(text: _textNumOf(src['unit_price']).toString()),
        freight = TextEditingController(text: _plain(_textNumOf(src['freight']))),
        handling = TextEditingController(text: _plain(_textNumOf(src['handling'])));

  final Map<String, dynamic> src;
  bool on = true;
  final TextEditingController qty;
  final TextEditingController price;
  final TextEditingController freight;
  final TextEditingController handling;

  String get productName => wsS(src['product_name']);
  String get unit => wsS(src['unit']);
  String get supplier => wsS(src['supplier']);
  String get date => wsS(src['date']);

  double get qtyV => _textNum(qty);
  double get amount => qtyV * _textNum(price);
  double get freightV => _nonNeg(_textNum(freight));
  double get handlingV => _nonNeg(_textNum(handling));
  double get fee => freightV + handlingV;

  /// 运费/装卸负数钳到 0（与后端 preview 的口径一致）
  Map<String, dynamic> toPayload() {
    final out = Map<String, dynamic>.from(src);
    out['quantity'] = qtyV;
    out['unit_price'] = _textNum(price);
    out['freight'] = _nonNeg(_textNum(freight));
    out['handling'] = _nonNeg(_textNum(handling));
    return out;
  }

  void dispose() {
    qty.dispose();
    price.dispose();
    freight.dispose();
    handling.dispose();
  }
}

/// 录入区合计
class _Totals {
  int count = 0;
  double goods = 0;
  double freight = 0;
  double handling = 0;
  double adjust = 0;
  double get fee => freight + handling;
  double get pay => goods + fee + adjust;
}

// ---------------------------------------------------------------- 小工具

double _textNumOf(dynamic v) => v is num ? v.toDouble() : double.tryParse('$v') ?? 0;
double _textNum(TextEditingController c) => double.tryParse(c.text.trim()) ?? 0;
double _nonNeg(double v) => v < 0 ? 0 : v;

/// 0 显示成空串（运费/装卸这类选填金额）
String _plain(double v) => v == 0 ? '' : wsTrim(v, digits: 2);

// ---------------------------------------------------------------- State

class _DesktopInboundState extends State<DesktopInboundScreen> {
  static const List<String> _tabItems = ['录入入库单', '入库记录'];
  int _tab = 0;

  // 元数据
  List<DesktopOption<String>> _productOptions = const [];
  final Map<int, Map<String, dynamic>> _productById = <int, Map<String, dynamic>>{};
  Map<String, double> _deductMap = <String, double>{};

  // 录入
  final List<_InRow> _rows = <_InRow>[];
  bool _submitting = false;
  String? _entryError;

  // 记录
  bool _recLoading = false;
  String? _recError;
  List<Map<String, dynamic>> _records = <Map<String, dynamic>>[];
  String _dateFrom = wsToday();
  String _dateTo = wsToday();
  String _payFilter = '';
  final TextEditingController _keyword = TextEditingController();
  final Set<int> _sel = <int>{};
  String? _sortKey;
  bool _sortAsc = true;

  String get _operator => widget.auth.displayName;

  static const List<DesktopCol> _entryCols = [
    DesktopCol('#', width: 48, center: true),
    DesktopCol('商品', width: 220),
    DesktopCol('进货单位', width: 110),
    DesktopCol('数量', width: 92, right: true),
    DesktopCol('单价（所选单位）', width: 120, right: true, tip: '按所选单位计价；商品类别命中扣点时自动按 原价 × (1 − 扣点%) 折算（见单价下方绿字），可手工改'),
    DesktopCol('金额', width: 108, right: true, tip: '金额 = 数量 × 单价，实时计算'),
    DesktopCol('调整', width: 92, right: true, tip: '正=多付，负=少付；差额自动记「金额调整」其他开支，商品成本不变'),
    DesktopCol('运费', width: 88, right: true, tip: '计入该批次成本 → 体现在这个品的毛利；并自动记入「其他开支」备查'),
    DesktopCol('装卸费', width: 88, right: true, tip: '同运费：入成本、进「其他开支」，不强制填'),
    DesktopCol('供应商', width: 132),
    DesktopCol('日期', width: 132),
    DesktopCol('操作员', width: 110, tip: '默认当前登录账号，不可修改'),
    DesktopCol('付款状态', width: 168),
    DesktopCol('备注', width: 160),
    DesktopCol('操作', width: 72, center: true),
  ];

  static const List<DesktopCol> _recordCols = [
    DesktopCol('', width: 40, center: true),
    DesktopCol('单号', width: 132, sortKey: 'code'),
    DesktopCol('日期', width: 104, sortKey: 'date'),
    DesktopCol('商品', width: 160, sortKey: 'product_name'),
    DesktopCol('数量', width: 100, sortKey: 'quantity', right: true),
    DesktopCol('单价', width: 112, sortKey: 'unit_price', right: true),
    DesktopCol('金额', width: 112, sortKey: 'total_amount', right: true),
    DesktopCol('调整', width: 90, right: true),
    DesktopCol('运费', width: 88, right: true),
    DesktopCol('装卸费', width: 88, right: true),
    DesktopCol('供应商', width: 120, sortKey: 'supplier'),
    DesktopCol('操作员', width: 100, sortKey: 'operator'),
    DesktopCol('付款状态', width: 88, center: true),
    DesktopCol('备注', width: 160),
    DesktopCol('操作', width: 176),
  ];

  @override
  void initState() {
    super.initState();
    _rows.add(_InRow(date: wsToday()));
    _loadMeta();
    _loadDeductions();
    _loadRecords();
  }

  @override
  void dispose() {
    for (final r in _rows) {
      r.dispose();
    }
    _keyword.dispose();
    super.dispose();
  }

  Future<void> _refreshAll() async {
    await _loadMeta();
    await _loadDeductions();
    await _loadRecords();
    if (!mounted) return;
    wsToast(context, '已刷新');
  }

  // ------------------------------------------------ 元数据 / 扣点

  Future<void> _loadMeta() async {
    try {
      final raw = await ApiService.products();
      final byId = <int, Map<String, dynamic>>{};
      final list = <Map<String, dynamic>>[];
      for (final item in raw) {
        if (item is! Map) continue;
        final p = Map<String, dynamic>.from(item);
        byId[wsI(p['id'])] = p;
        // 入库商品池：库存商品（含包材），排除 订单/人工/快递
        if (p['is_active'] == false) continue;
        if (wsS(p['product_type'], fallback: 'stock') != 'stock') continue;
        final cat = wsS(p['category']);
        if (cat == '人工' || cat == '快递') continue;
        list.add(p);
      }
      list.sort((a, b) => wsS(a['name']).compareTo(wsS(b['name'])));
      if (!mounted) return;
      setState(() {
        _productById
          ..clear()
          ..addAll(byId);
        _productOptions = [
          for (final p in list)
            DesktopOption<String>(
              '${wsI(p['id'])}',
              '[库存] ${wsS(p['name'])}（${wsS(p['category'], fallback: '—')}）',
            ),
        ];
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, e.message, error: true);
    }
  }

  Future<void> _loadDeductions() async {
    try {
      final raw = await ApiService.deductions();
      final map = <String, double>{};
      for (final item in raw) {
        if (item is! Map) continue;
        final cat = wsS(item['category']);
        if (cat.isEmpty) continue;
        map[cat] = wsD(item['percent']);
      }
      if (!mounted) return;
      setState(() => _deductMap = map);
    } on ApiException catch (_) {
      // 扣点规则取不到不拦录入：单价按原价填，用户自己折算
    }
  }

  Map<String, dynamic>? _productOf(_InRow r) =>
      r.productId == null ? null : _productById[r.productId];

  List<String> _unitsOf(Map<String, dynamic>? p) {
    final conv = p?['conversions'];
    if (conv is! Map) return const [];
    return [for (final k in conv.keys) k.toString()];
  }

  double _factorOf(Map<String, dynamic>? p, String unit) {
    final conv = p?['conversions'];
    if (conv is Map) {
      final v = conv[unit];
      if (v is num) return v.toDouble();
      if (v != null) return double.tryParse(v.toString()) ?? 1;
    }
    return 1;
  }

  String _defaultUnitOf(Map<String, dynamic> p) {
    final du = wsS(p['default_unit']);
    return du.isNotEmpty ? du : wsS(p['base_unit']);
  }

  /// 当前库存 + 换算提示（web 的 .in-stock-hint）
  void _applyStockHint(_InRow r, Map<String, dynamic> p) {
    final du = _defaultUnitOf(p);
    final f = _factorOf(p, r.unit.isEmpty ? du : r.unit);
    final stock = wsD(p['stock']);
    final shown = (f != 1 && du.isNotEmpty) ? wsTrim(stock / f, digits: 2) : wsTrim(stock, digits: 2);
    final unit = (f != 1 && du.isNotEmpty) ? du : wsS(p['base_unit']);
    r.stockHint = '当前库存 $shown$unit；1${r.unit.isEmpty ? du : r.unit} = ${wsTrim(f, digits: 4)} ${wsS(p['base_unit'])}';
  }

  /// 单价自动带出：优先「最近一次入库价」，没有则参考成本；类别命中扣点时按 原价×(1−扣点%) 折算
  void _fillRowPrice(_InRow r, Map<String, dynamic> p) {
    final unit = r.unit.isNotEmpty ? r.unit : _defaultUnitOf(p);
    final f = _factorOf(p, unit);
    final lastBase = wsD(p['last_in_price']);
    final refBase = wsD(p['unit_cost']);
    final base = lastBase > 0 ? lastBase : refBase;
    if (base <= 0) {
      r.price.clear();
      r.priceHint = '该商品还没入库过、也没设参考成本，请手动填单价';
      return;
    }
    final raw = base * f;
    final cat = wsS(p['category']);
    final percent = _deductMap[cat] ?? 0;
    final price = percent > 0 ? double.parse((raw * (1 - percent / 100)).toStringAsFixed(4)) : raw;
    r.price.text = wsTrim(price, digits: 6);
    final sb = StringBuffer();
    if (percent > 0) {
      sb.write('类别「$cat」扣点 ${wsTrim(percent, digits: 2)}%，入库单价 = 原价 ${wsMoney(raw)} × (1 − ${wsTrim(percent, digits: 2)}%) = ${wsMoney(price)}/$unit');
    } else if (lastBase > 0) {
      sb.write('最近入库价 ${wsMoney(raw)}/$unit（${wsS(p['last_in_date'], fallback: '—')}）');
      if (refBase > 0) sb.write('；参考成本 ${wsMoney(refBase * f)}/$unit');
    } else {
      sb.write('按参考成本填 ${wsMoney(raw)}/$unit（该商品还没入库过）');
    }
    sb.write('。可改可清，改了下次入库自动用新价');
    r.priceHint = sb.toString();
  }

  void _pickProduct(_InRow r, String? value) {
    setState(() {
      if (value == null || value.isEmpty) {
        r.productId = null;
        r.unit = '';
        r.priceHint = '';
        r.stockHint = '';
        return;
      }
      final p = _productById[int.tryParse(value)];
      if (p == null) return;
      r.productId = wsI(p['id']);
      final conv = _unitsOf(p);
      final du = _defaultUnitOf(p);
      r.unit = conv.contains(du) ? du : (conv.isNotEmpty ? conv.first : du);
      _fillRowPrice(r, p);
      _applyStockHint(r, p);
    });
  }

  void _changeUnit(_InRow r, String? unit) {
    setState(() {
      r.unit = unit ?? '';
      final p = _productOf(r);
      if (p != null) {
        _fillRowPrice(r, p);
        _applyStockHint(r, p);
      }
    });
  }

  // ------------------------------------------------ 录入行操作

  void _addRow() {
    setState(() {
      final last = _rows.isNotEmpty ? _rows.last : null;
      final r = _InRow(date: last?.date ?? wsToday());
      if (last != null) {
        r.supplier.text = last.supplier.text;
        r.pay = last.pay;
      }
      _rows.add(r);
    });
  }

  void _duplicateLastRow() {
    if (_rows.isEmpty) {
      _addRow();
      return;
    }
    setState(() => _rows.add(_rows.last.cloned()));
  }

  void _removeRow(int index) {
    setState(() {
      _rows.removeAt(index).dispose();
      if (_rows.isEmpty) _rows.add(_InRow(date: wsToday()));
    });
  }

  Future<void> _clearRows() async {
    final ok = await wsConfirm(
      context,
      title: '清空录入行',
      message: '确定清空当前所有录入行？未提交的填写内容会丢失。',
      okLabel: '清空',
    );
    if (!ok || !mounted) return;
    setState(() {
      for (final r in _rows) {
        r.dispose();
      }
      _rows
        ..clear()
        ..add(_InRow(date: wsToday()));
      _entryError = null;
    });
  }

  _Totals _totals() {
    final t = _Totals();
    for (final r in _rows) {
      if (r.productId == null) continue;
      if (!(r.qtyV > 0)) continue;
      t.count++;
      t.goods += r.amount;
      t.freight += r.freightV;
      t.handling += r.handlingV;
      t.adjust += r.adjustV;
    }
    return t;
  }

  /// 校验 + 组装批量入库条目（文案与网页端 submitInbound 一致）
  ({List<Map<String, dynamic>> items, List<String> bad}) _collect() {
    final items = <Map<String, dynamic>>[];
    final bad = <String>[];
    for (var i = 0; i < _rows.length; i++) {
      final no = i + 1;
      final r = _rows[i];
      final pid = r.productId;
      if (pid == null) {
        if (r.qtyV > 0) bad.add('第 $no 行没选商品');
        continue;
      }
      if (r.unit.isEmpty || !(r.qtyV > 0)) {
        bad.add('第 $no 行数量/单位没填全');
        continue;
      }
      if (r.price.text.trim().isEmpty) {
        bad.add('第 $no 行没填单价');
        continue;
      }
      if (r.date.isEmpty) {
        bad.add('第 $no 行没选日期');
        continue;
      }
      if (r.freightV < 0 || r.handlingV < 0) {
        bad.add('第 $no 行运费/装卸费不能为负');
        continue;
      }
      items.add({
        'product_id': pid,
        'unit': r.unit,
        'quantity': r.qtyV,
        'unit_price': r.priceV,
        'supplier': r.supplier.text.trim(),
        'operator': _operator,
        'date': r.date,
        'remark': r.remark.text.trim(),
        'pay_status': r.pay,
        'adjust_amount': r.adjustV,
        'freight': r.freightV,
        'handling': r.handlingV,
      });
    }
    return (items: items, bad: bad);
  }

  Future<void> _submitBatch() async {
    if (_submitting) return;
    final res = _collect();
    if (res.bad.isNotEmpty) {
      final msg = res.bad.first + (res.bad.length > 1 ? ' 等 ${res.bad.length} 处要改' : '');
      setState(() => _entryError = msg);
      wsToast(context, msg, error: true);
      return;
    }
    if (res.items.isEmpty) {
      wsToast(context, '请先选商品并填数量（一行 = 一张入库单）', error: true);
      return;
    }
    final t = _totals();
    setState(() {
      _submitting = true;
      _entryError = null;
    });
    try {
      final r = await ApiService.batchCreateInbounds(res.items);
      final created = wsI(r['created']);
      final failed = <Map<String, dynamic>>[
        for (final f in ((r['failed'] as List?) ?? const []))
          if (f is Map) Map<String, dynamic>.from(f),
      ];
      final badRows = <int>{for (final f in failed) wsI(f['row'])};
      // 成功行清空数量/单价/调整/运费/装卸（失败行原样保留好改），商品/单位/供应商/日期不动
      for (var i = 0; i < _rows.length; i++) {
        if (!badRows.contains(i + 1)) _rows[i].clearAmounts();
      }
      final empties = _rows.where((x) => x.productId == null).toList();
      if (empties.length > 1) {
        for (final r2 in empties.skip(1)) {
          _rows.remove(r2);
          r2.dispose();
        }
      }
      final tips = <String>[];
      if (created > 0) {
        tips.add('已入库 $created 张单（货款 ${wsMoney(t.goods)}'
            '${t.fee > 0 ? ' + 运费/装卸 ${wsMoney(t.fee)}' : ''}'
            '${t.adjust != 0 ? ' ${t.adjust > 0 ? '+' : '-'} 调整 ${wsMoney(t.adjust.abs())}' : ''}）');
      }
      if (failed.isNotEmpty) tips.add('${failed.length} 行失败');
      if (res.items.any((it) => it['pay_status'] == 'unpaid')) tips.add('待付款已进「待付款账单」');
      if (!mounted) return;
      setState(() {
        _submitting = false;
        if (failed.isNotEmpty) {
          _entryError = '以下行没入库成功（已保留，改完可再提交）：'
              '${failed.map((f) => '第 ${wsI(f['row'])} 行 ${f['reason']}').join('；')}';
        }
      });
      wsToast(context, tips.isEmpty ? '已提交' : tips.join('，'), error: failed.isNotEmpty);
      if (failed.isNotEmpty) await _showFailedDialog(failed, rowLabel: '行');
      if (created > 0) {
        await _loadRecords();
        await _loadMeta();
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      wsToast(context, '入库失败：${e.message}', error: true);
    }
  }

  /// 提交结果里的失败行：弹窗列「行 / 原因」
  Future<void> _showFailedDialog(List<Map<String, dynamic>> failed, {String rowLabel = '行'}) async {
    await desktopDialog<void>(
      context,
      title: '部分行未成功',
      width: 560,
      builder: (_) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DesktopNotice('以下 ${failed.length} $rowLabel没有落库，成功部分已照常入库；改完可再提交。',
              kind: DesktopNoticeKind.warn),
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              children: [
                SizedBox(width: 92, child: wsCell(rowLabel, bold: true, color: WsTokens.mutedLight)),
                const SizedBox(width: 8),
                Expanded(child: wsCell('原因', bold: true, color: WsTokens.mutedLight)),
              ],
            ),
          ),
          for (final f in failed)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 92,
                    child: wsCell('${f['row'] ?? ''}', bold: true),
                  ),
                  const SizedBox(width: 8),
                  Expanded(child: wsCell('${f['reason'] ?? '未知原因'}')),
                ],
              ),
            ),
        ],
      ),
    );
  }

  // ------------------------------------------------ Excel 导入 / 模板下载

  Future<void> _openExcelImport() async {
    FilePickerResult? picked;
    try {
      picked = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['xlsx'],
        dialogTitle: '选择入库导入 Excel',
      );
    } catch (e) {
      if (!mounted) return;
      wsToast(context, '选择文件失败：$e', error: true);
      return;
    }
    if (picked == null || picked.files.isEmpty) return;
    final path = picked.files.first.path;
    if (path == null || path.isEmpty) {
      if (!mounted) return;
      wsToast(context, '未能读取所选文件路径，请重试', error: true);
      return;
    }
    Map<String, dynamic> data;
    try {
      data = await ApiService.previewImportInbounds(path);
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '解析失败：${e.message}', error: true);
      return;
    }
    final items = <Map<String, dynamic>>[
      for (final it in ((data['items'] as List?) ?? const []))
        if (it is Map) Map<String, dynamic>.from(it),
    ];
    final failed = <Map<String, dynamic>>[
      for (final f in ((data['failed'] as List?) ?? const []))
        if (f is Map) Map<String, dynamic>.from(f),
    ];
    if (!mounted) return;
    if (items.isEmpty) {
      await desktopDialog<void>(
        context,
        title: '批量入库',
        width: 520,
        builder: (_) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const DesktopNotice('未解析出可入库的数据。', kind: DesktopNoticeKind.warn),
            if (failed.isNotEmpty)
              DesktopNotice('解析失败 ${failed.length} 条：'
                  '${failed.take(5).map((f) => f['reason']).join('；')}', kind: DesktopNoticeKind.error),
          ],
        ),
      );
      return;
    }
    final draft = <_ImportRow>[for (final it in items) _ImportRow(it)];
    final payload = await _showImportDialog(draft, failed);
    for (final r in draft) {
      r.dispose();
    }
    if (payload == null || payload.isEmpty || !mounted) return;
    await _confirmImport(payload);
  }

  Future<List<Map<String, dynamic>>?> _showImportDialog(
    List<_ImportRow> draft,
    List<Map<String, dynamic>> failed,
  ) {
    BuildContext? dlg;
    const cols = [
      DesktopCol('入库', width: 56, center: true),
      DesktopCol('商品', width: 170),
      DesktopCol('单位', width: 74),
      DesktopCol('数量', width: 96, right: true),
      DesktopCol('单价', width: 104, right: true),
      DesktopCol('金额', width: 104, right: true),
      DesktopCol('运费', width: 92, right: true, tip: '计入批次成本，同步「其他开支」；负数按 0 处理'),
      DesktopCol('装卸', width: 92, right: true, tip: '同运费；负数按 0 处理'),
      DesktopCol('供应商 · 日期', width: 190),
    ];
    return desktopDialog<List<Map<String, dynamic>>>(
      context,
      title: '批量入库 — 确认入库',
      width: 1000,
      maxHeight: 760,
      builder: (c) {
        dlg = c;
        return StatefulBuilder(
          builder: (c2, setDlg) {
            final onRows = draft.where((r) => r.on).toList();
            double sum = 0;
            double fee = 0;
            for (final r in onRows) {
              sum += r.amount;
              fee += r.fee;
            }
            void swap(int i) => setDlg(() => draft[i].on = !draft[i].on);
            void setAll(bool v) {
              for (final r in draft) {
                r.on = v;
              }
              setDlg(() {});
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DesktopNotice(
                  '解析出 ${draft.length} 行，已勾选 ${onRows.length} 行（货款 ${wsMoney(sum)}'
                  '${fee > 0 ? ' + 运费/装卸 ${wsMoney(fee)}' : ''}）。'
                  '可勾选、修改数量/单价/运费/装卸；确认后才真正入库并更新库存。'
                  '运费与装卸费会计入批次成本并同步「其他开支」。',
                ),
                if (failed.isNotEmpty)
                  DesktopNotice('解析失败 ${failed.length} 条：'
                      '${failed.take(5).map((f) => '${f['row']}：${f['reason']}').join('；')}',
                      kind: DesktopNoticeKind.error),
                Row(
                  children: [
                    DesktopButton(label: '全选', small: true, onPressed: () => setAll(true)),
                    const SizedBox(width: 8),
                    DesktopButton(label: '全不选', small: true, onPressed: () => setAll(false)),
                    const Spacer(),
                    Flexible(
                      child: wsCell(
                        '合计：货款 ${wsMoney(sum)}'
                        '${fee > 0 ? ' ＋ 运费/装卸 ${wsMoney(fee)}' : ''} ＝ 实付 ${wsMoney(sum + fee)}',
                        bold: true,
                        color: WsTokens.primary,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                DesktopGrid(
                  cols: cols,
                  rowHeight: 48,
                  rows: [
                    for (var i = 0; i < draft.length; i++)
                      DesktopRow(
                        dim: !draft[i].on,
                        cells: [
                          SizedBox(
                            width: 18,
                            child: Checkbox(
                              value: draft[i].on,
                              onChanged: (_) => swap(i),
                              visualDensity: VisualDensity.compact,
                              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              shape: const RoundedRectangleBorder(
                                  borderRadius: BorderRadius.all(Radius.circular(3))),
                            ),
                          ),
                          wsCell(draft[i].productName, bold: true, tip: draft[i].productName),
                          wsCell(draft[i].unit),
                          DesktopTextField(
                            controller: draft[i].qty,
                            width: 76,
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            inputFormatters: DesktopTextField.decimalOnly,
                            textAlign: TextAlign.end,
                            onChanged: (_) => setDlg(() {}),
                          ),
                          DesktopTextField(
                            controller: draft[i].price,
                            width: 84,
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            inputFormatters: DesktopTextField.decimalOnly,
                            textAlign: TextAlign.end,
                            onChanged: (_) => setDlg(() {}),
                          ),
                          wsCell(wsMoney(draft[i].amount), color: WsTokens.primary),
                          DesktopTextField(
                            controller: draft[i].freight,
                            width: 72,
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            inputFormatters: DesktopTextField.decimalOnly,
                            textAlign: TextAlign.end,
                            onChanged: (_) => setDlg(() {}),
                          ),
                          DesktopTextField(
                            controller: draft[i].handling,
                            width: 72,
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            inputFormatters: DesktopTextField.decimalOnly,
                            textAlign: TextAlign.end,
                            onChanged: (_) => setDlg(() {}),
                          ),
                          wsCell('${draft[i].supplier.isEmpty ? '—' : draft[i].supplier} · ${draft[i].date}'),
                        ],
                      ),
                  ],
                ),
                const SizedBox(height: 10),
                wsCell('提示：商品类别命中扣点时，后端解析已按 原价 × (1 − 扣点%) 折算单价，可再手工修改。',
                    color: WsTokens.mutedLight),
              ],
            );
          },
        );
      },
      submitLabel: '✓ 确认入库',
      onSubmit: () {
        final items = [
          for (final r in draft)
            if (r.on && r.qtyV > 0) r.toPayload(),
        ];
        if (items.isEmpty) {
          wsToast(dlg ?? context, '没有可入库的数据：请勾选行并填写数量', error: true);
          return;
        }
        Navigator.of(dlg ?? context).pop(items);
      },
    );
  }

  Future<void> _confirmImport(List<Map<String, dynamic>> items) async {
    try {
      final r = await ApiService.confirmImportInbounds(items);
      final created = wsI(r['created']);
      final failed = <Map<String, dynamic>>[
        for (final f in ((r['failed'] as List?) ?? const []))
          if (f is Map) Map<String, dynamic>.from(f),
      ];
      if (!mounted) return;
      wsToast(context, '✓ 已入库 $created 条${failed.isNotEmpty ? '，失败 ${failed.length}' : ''}',
          error: failed.isNotEmpty);
      if (failed.isNotEmpty) await _showFailedDialog(failed, rowLabel: '商品');
      await _loadRecords();
      await _loadMeta();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '确认入库失败：${e.message}', error: true);
    }
  }

  Future<void> _downloadTemplate() async {
    String? savePath;
    try {
      savePath = await FilePicker.platform.saveFile(
        dialogTitle: '保存入库导入模板',
        fileName: '入库批量导入模板.xlsx',
      );
    } catch (e) {
      if (!mounted) return;
      wsToast(context, '保存路径选择失败：$e', error: true);
      return;
    }
    if (savePath == null || savePath.isEmpty) return;
    try {
      await ApiService.download(ApiService.templatePath('inbounds'), savePath);
      if (!mounted) return;
      wsToast(context, '模板已保存到 $savePath');
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '模板下载失败：${e.message}', error: true);
    }
  }

  // ------------------------------------------------ 入库记录

  Future<void> _loadRecords() async {
    setState(() {
      _recLoading = true;
      _recError = null;
    });
    try {
      final raw = await ApiService.inbounds(dateFrom: _dateFrom, dateTo: _dateTo);
      final rows = <Map<String, dynamic>>[
        for (final r in raw)
          if (r is Map) Map<String, dynamic>.from(r),
      ];
      if (!mounted) return;
      setState(() {
        _records = rows;
        _sel.removeWhere((id) => !rows.any((r) => wsI(r['id']) == id));
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _recError = e.message);
    } finally {
      if (mounted) setState(() => _recLoading = false);
    }
  }

  /// 关键字（单号/商品/供应商/操作员）+ 付款状态过滤，再按表头排序（与网页端同口径）
  List<Map<String, dynamic>> _visibleRecords() {
    final kw = _keyword.text.trim().toLowerCase();
    var rows = _records.where((r) {
      if (_payFilter.isNotEmpty && wsS(r['pay_status'], fallback: 'paid') != _payFilter) return false;
      if (kw.isEmpty) return true;
      return '${wsS(r['code'])} ${wsS(r['product_name'])} ${wsS(r['supplier'])} ${wsS(r['operator'])}'
          .toLowerCase()
          .contains(kw);
    }).toList();
    final key = _sortKey;
    if (key != null) {
      rows.sort((a, b) => _compareValues(a[key], b[key]) * (_sortAsc ? 1 : -1));
    }
    return rows;
  }

  static int _compareValues(dynamic a, dynamic b) {
    final sa = '$a';
    final sb = '$b';
    final dateRe = RegExp(r'^\d{4}-\d{2}-\d{2}');
    if (dateRe.hasMatch(sa) && dateRe.hasMatch(sb)) return sa.compareTo(sb);
    final na = double.tryParse(sa);
    final nb = double.tryParse(sb);
    if (na != null && nb != null) return na.compareTo(nb);
    return sa.compareTo(sb);
  }

  void _onSort(String key) {
    setState(() {
      if (_sortKey == key) {
        _sortAsc = !_sortAsc;
      } else {
        _sortKey = key;
        _sortAsc = true;
      }
    });
  }

  String _payLabel(String status) => status == 'unpaid' ? '待付款' : '已付款';

  Future<void> _openEdit(Map<String, dynamic> r) async {
    final id = wsI(r['id']);
    final total = wsD(r['total_amount']);
    final adjust = wsD(r['adjust_amount']);
    final supplierCtl = TextEditingController(text: wsS(r['supplier']));
    final freightCtl = TextEditingController(text: _plain(wsD(r['freight'])));
    final handlingCtl = TextEditingController(text: _plain(wsD(r['handling'])));
    String date = wsS(r['date'], fallback: wsToday());
    String pay = wsS(r['pay_status'], fallback: 'paid');
    String err = '';
    BuildContext? dlg;
    void Function(void Function())? setDlgState;

    final patch = await desktopDialog<Map<String, dynamic>>(
      context,
      title: '修改入库单',
      width: 640,
      builder: (c) {
        dlg = c;
        return StatefulBuilder(
          builder: (c2, setDlg) {
            setDlgState = setDlg;
            final fee = _textNum(freightCtl) + _textNum(handlingCtl);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                wsCell(
                  '${wsS(r['code'])} · ${wsS(r['product_name'])} ${wsTrim(wsD(r['quantity']), digits: 4)}'
                  '${wsS(r['unit'])} · 金额 ${wsMoney(total)}'
                  '${adjust != 0 ? '（调整 ${adjust > 0 ? '+' : '-'}${wsMoney(adjust.abs())}）' : ''}',
                  color: WsTokens.mutedLight,
                ),
                const SizedBox(height: 12),
                if (err.isNotEmpty) DesktopNotice(err, kind: DesktopNoticeKind.error),
                const DesktopNotice(
                  '数量 / 单价不可修改，请删除后重新入库（商品与金额一并保留）。'
                  '这里只改 供应商 / 入库日期 / 付款状态 / 运费 / 装卸费。',
                  kind: DesktopNoticeKind.warn,
                ),
                DesktopFormRow(
                  label: '供应商',
                  child: DesktopTextField(controller: supplierCtl, hintText: '供应商名称'),
                ),
                DesktopFormRow(
                  label: '入库日期',
                  required: true,
                  child: DesktopDateField(
                    value: date,
                    allowClear: false,
                    onChanged: (v) => setDlg(() => date = v.isEmpty ? date : v),
                  ),
                ),
                DesktopFormRow(
                  label: '运费',
                  tip: '选填；计入该批次成本（体现在这个品的毛利），并同步记入「其他开支」',
                  child: DesktopTextField(
                    controller: freightCtl,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: DesktopTextField.decimalOnly,
                    hintText: '0.00',
                    onChanged: (_) => setDlg(() {}),
                  ),
                ),
                DesktopFormRow(
                  label: '装卸费',
                  tip: '选填；日期随入库单日期，清零即删掉对应的「其他开支」',
                  child: DesktopTextField(
                    controller: handlingCtl,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: DesktopTextField.decimalOnly,
                    hintText: '0.00',
                    onChanged: (_) => setDlg(() {}),
                  ),
                ),
                DesktopFormRow(
                  label: '付款状态',
                  tip: DesktopPayRadios.hint,
                  child: DesktopPayRadios(value: pay, onChanged: (v) => setDlg(() => pay = v)),
                ),
                wsCell(
                  fee > 0
                      ? '批次成本 = 货款 ${wsMoney(total)} + 运费/装卸 ${wsMoney(fee)} = ${wsMoney(total + fee)}'
                          '（按 FIFO 随销量扣减，同步更新该品毛利与「其他开支」）'
                      : '不填=没有运费/装卸费（对应「其他开支」里的运费、装卸费记录会一并清掉）',
                  color: WsTokens.mutedLight,
                ),
                const SizedBox(height: 8),
                wsCell('保存后操作员记为当前登录账号（$_operator）。数量 / 单价 / 商品如需更正，请删除后重新入库。',
                    color: WsTokens.mutedLight),
              ],
            );
          },
        );
      },
      submitLabel: '✓ 保存',
      onSubmit: () {
        final freight = _textNum(freightCtl);
        final handling = _textNum(handlingCtl);
        if (date.isEmpty) {
          setDlgState?.call(() => err = '请选择入库日期');
          return;
        }
        if (freight < 0 || handling < 0) {
          setDlgState?.call(() => err = '运费 / 装卸费不能为负数');
          return;
        }
        Navigator.of(dlg ?? context).pop({
          'supplier': supplierCtl.text.trim(),
          'date': date,
          'pay_status': pay,
          'freight': _nonNeg(freight),
          'handling': _nonNeg(handling),
        });
      },
    );

    supplierCtl.dispose();
    freightCtl.dispose();
    handlingCtl.dispose();
    if (patch == null) return;
    try {
      await ApiService.updateInbound(id, patch);
      if (!mounted) return;
      final fee = _textNumOf(patch['freight']) + _textNumOf(patch['handling']);
      wsToast(context, '已保存，操作员记为 $_operator'
          '${fee > 0 ? '；运费/装卸 ${wsMoney(fee)} 已计入成本' : ''}');
      await _loadRecords();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '保存失败：${e.message}', error: true);
    }
  }

  Future<void> _deleteOne(Map<String, dynamic> r) async {
    final ok = await wsConfirm(
      context,
      title: '删除入库单',
      message: '确认删除该入库单？将回退库存与成本。',
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      await ApiService.deleteInbound(wsI(r['id']));
      if (!mounted) return;
      wsToast(context, '已删除');
      await _loadRecords();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '删除失败：${e.message}', error: true);
    }
  }

  Future<void> _batchDelete() async {
    if (_sel.isEmpty) return;
    final ids = _sel.toList();
    final ok = await wsConfirm(
      context,
      title: '批量删除入库单',
      message: '确认删除选中的 ${ids.length} 条入库单？将回退库存与成本。',
      okLabel: '批量删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      final r = await ApiService.batchDeleteInbounds(ids);
      if (!mounted) return;
      setState(_sel.clear);
      wsToast(context, '已删除 ${wsI(r['deleted'])} 条入库单');
      await _loadRecords();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '批量删除失败：${e.message}', error: true);
    }
  }

  Future<void> _markPaid(Map<String, dynamic> r, {required bool paid}) async {
    try {
      await ApiService.payBill('inbound', wsI(r['id']), paid: paid);
      if (!mounted) return;
      wsToast(context, paid ? '已标记为已付款' : '已标记为待付款，进「待付款账单」');
      await _loadRecords();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '操作失败：${e.message}', error: true);
    }
  }

  Future<void> _markPaidBatch(bool paid) async {
    if (_sel.isEmpty) return;
    final ids = _sel.toList();
    try {
      final r = await ApiService.payBillsBatch('inbound', ids, paid: paid);
      if (!mounted) return;
      setState(_sel.clear);
      wsToast(context, '已${paid ? '标记已付' : '标记待付'} ${wsI(r['updated'])} 条');
      await _loadRecords();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '批量标记失败：${e.message}', error: true);
    }
  }

  // ------------------------------------------------ build

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '入库',
      subtitle: '按采购单位录入，一行 = 一张入库单；入库自动更新库存与批次成本。',
      headBottom: 14,
      actions: [
        DesktopButton(label: 'Excel 导入', icon: Icons.table_view_outlined, onPressed: _openExcelImport),
        DesktopButton(label: '模板下载', icon: Icons.download_outlined, onPressed: _downloadTemplate),
        DesktopButton(label: '刷新', icon: Icons.refresh, onPressed: _refreshAll),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              DesktopTabs(
                items: _tabItems,
                index: _tab,
                onChanged: (i) => setState(() => _tab = i),
              ),
              const Spacer(),
              DesktopLink('库存管理 →', onPressed: () => widget.onNavigate('/stock')),
            ],
          ),
          const SizedBox(height: 14),
          Expanded(child: _tab == 0 ? _buildEntry(context) : _buildRecords(context)),
        ],
      ),
    );
  }

  Widget _buildEntry(BuildContext context) {
    final t = _totals();
    final dark = wsIsDark(context);
    return SingleChildScrollView(
      child: DesktopRise(
        index: 0,
        child: WsCard(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              WsCardHead(
                title: '新增入库单',
                icon: Icons.download_outlined,
                trailing: Text('一行 = 一张入库单 · 共 ${_rows.length} 行',
                    style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              ),
              if (_entryError != null) DesktopNotice(_entryError!, kind: DesktopNoticeKind.error),
              const DesktopNotice(
                '商品 / 进货单位 / 数量 / 单价 / 金额 / 调整 / 运费 / 装卸费 / 供应商 / 日期 / 操作员 / 付款状态 / 备注 逐行独立填写；'
                '运费与装卸费计入该批次成本（体现在这个品的毛利），并自动镜像进「其他开支」备查。',
              ),
              DesktopFilterBar(
                right: DesktopButton(
                  label: _submitting ? '提交中…' : '✓ 批量入库',
                  kind: DesktopButtonKind.success,
                  icon: Icons.check,
                  onPressed: _submitting ? null : _submitBatch,
                ),
                children: [
                  DesktopButton(label: '＋ 加一行', icon: Icons.add, onPressed: _addRow),
                  DesktopButton(label: '复制最后一行', icon: Icons.copy_all_outlined, onPressed: _duplicateLastRow),
                  DesktopButton(label: '清空', icon: Icons.delete_sweep_outlined, onPressed: _clearRows),
                  const SizedBox(width: 6),
                  Text('没选商品或没填数量的行不会入库',
                      style: TextStyle(fontSize: 12, color: dark ? WsTokens.mutedDark : WsTokens.mutedLight)),
                ],
              ),
              DesktopGrid(
                cols: _entryCols,
                rowHeight: 56,
                rows: [
                  for (var i = 0; i < _rows.length; i++) DesktopRow(cells: _entryCells(_rows[i], i, dark)),
                ],
                footer: [
                  '合计',
                  '本次 ${t.count} 张入库单',
                  '',
                  '',
                  '',
                  wsMoney(t.goods),
                  '${t.adjust > 0 ? '+' : t.adjust < 0 ? '-' : ''}${wsMoney(t.adjust.abs())}',
                  wsMoney(t.freight),
                  wsMoney(t.handling),
                  '',
                  '',
                  '',
                  '',
                  '',
                  '',
                ],
              ),
              const SizedBox(height: 14),
              if (t.count > 0)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    color: dark ? WsTokens.borderDark : WsTokens.primaryLight.withValues(alpha: 0.5),
                    borderRadius: BorderRadius.circular(WsTokens.radius),
                  ),
                  child: Text(
                    '本次填了 ${t.count} 张入库单：货款 ${wsMoney(t.goods)}'
                    '${t.fee > 0 ? ' ＋ 运费/装卸 ${wsMoney(t.fee)}' : ''}'
                    '${t.adjust != 0 ? ' ${t.adjust > 0 ? '＋' : '－'} 调整 ${wsMoney(t.adjust.abs())}' : ''}'
                    ' ＝ 实付 ${wsMoney(t.pay)}'
                    '（运费 / 装卸费计入批次成本并镜像进「其他开支」）',
                    style: TextStyle(
                      fontSize: 12.5,
                      height: 1.5,
                      color: dark ? WsTokens.textDark : WsTokens.textLight,
                    ),
                  ),
                ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: Text('金额 = 数量 × 单价；商品类别命中扣点时，单价按 原价 × (1 − 扣点%) 自动折算。',
                        style: TextStyle(fontSize: 12, color: dark ? WsTokens.mutedDark : WsTokens.mutedLight)),
                  ),
                  DesktopButton(
                    label: _submitting ? '提交中…' : '✓ 批量入库',
                    kind: DesktopButtonKind.success,
                    icon: Icons.check,
                    width: 150,
                    onPressed: _submitting ? null : _submitBatch,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _entryCells(_InRow r, int index, bool dark) {
    final p = _productOf(r);
    final units = _unitsOf(p);
    return [
      wsCell('${index + 1}', color: WsTokens.mutedLight),
      Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DesktopSearchField(
            title: '选择入库商品',
            width: 200,
            hint: '＋ 点击选择商品',
            value: r.productId == null ? null : '${r.productId}',
            options: _productOptions,
            onChanged: (v) => _pickProduct(r, v),
          ),
          if (r.stockHint.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(r.stockHint,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 10.5, color: WsTokens.mutedLight)),
            ),
        ],
      ),
      DesktopSelect<String>(
        width: 90,
        value: r.unit,
        hint: units.isEmpty ? '先选商品' : '单位',
        options: [for (final u in units) DesktopOption<String>(u, u)],
        onChanged: (v) => _changeUnit(r, v),
      ),
      DesktopTextField(
        controller: r.qty,
        width: 72,
        hintText: '0',
        textAlign: TextAlign.end,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        inputFormatters: DesktopTextField.decimalOnly,
        onChanged: (_) => setState(() {}),
      ),
      Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          DesktopTextField(
            controller: r.price,
            width: 100,
            hintText: '0.00',
            textAlign: TextAlign.end,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: DesktopTextField.decimalOnly,
            onChanged: (_) => setState(() {}),
          ),
          if (r.priceHint.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Tooltip(
                message: r.priceHint,
                child: Text(
                  r.priceHint.contains('扣点') ? r.priceHint.split('，').first : '参考价',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 10.5, color: WsTokens.green),
                ),
              ),
            ),
        ],
      ),
      Tooltip(
        message: '金额 = 数量 × 单价',
        child: wsCell(r.productId == null ? '—' : wsMoney(r.amount), bold: true),
      ),
      DesktopTextField(
        controller: r.adjust,
        width: 72,
        hintText: '0.00',
        textAlign: TextAlign.end,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        inputFormatters: DesktopTextField.decimalOnly,
        onChanged: (_) => setState(() {}),
      ),
      DesktopTextField(
        controller: r.freight,
        width: 68,
        hintText: '0.00',
        textAlign: TextAlign.end,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        inputFormatters: DesktopTextField.decimalOnly,
        onChanged: (_) => setState(() {}),
      ),
      DesktopTextField(
        controller: r.handling,
        width: 68,
        hintText: '0.00',
        textAlign: TextAlign.end,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        inputFormatters: DesktopTextField.decimalOnly,
        onChanged: (_) => setState(() {}),
      ),
      DesktopTextField(controller: r.supplier, width: 112, hintText: '供应商名称'),
      DesktopDateField(
        value: r.date,
        width: 112,
        allowClear: false,
        onChanged: (v) => setState(() => r.date = v),
      ),
      Tooltip(
        message: '默认当前登录账号，不可修改',
        child: _LockedBox(text: _operator, width: 90),
      ),
      SizedBox(
        width: 148,
        child: FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: DesktopPayRadios(value: r.pay, onChanged: (v) => setState(() => r.pay = v)),
        ),
      ),
      DesktopTextField(controller: r.remark, width: 140, hintText: '可选'),
      DesktopIconButton(
        icon: Icons.delete_outline,
        color: WsTokens.red,
        tooltip: '删除这一行',
        size: 28,
        onPressed: () => _removeRow(index),
      ),
    ];
  }

  Widget _buildRecords(BuildContext context) {
    final rows = _visibleRecords();
    double amount = 0, adjust = 0, freight = 0, handling = 0;
    for (final r in rows) {
      amount += wsD(r['final_amount'] ?? r['total_amount']);
      adjust += wsD(r['adjust_amount']);
      freight += wsD(r['freight']);
      handling += wsD(r['handling']);
    }
    final total = amount + freight + handling;
    return SingleChildScrollView(
      child: DesktopRise(
        index: 0,
        child: WsCard(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              WsCardHead(
                title: '入库记录',
                icon: Icons.history,
                trailing: Text(
                  '共 ${rows.length} 条 · 货款 ${wsMoney(amount)} · 运费/装卸 ${wsMoney(freight + handling)}'
                  ' · 总计支出 ${wsMoney(total)}',
                  style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight),
                ),
              ),
              DesktopFilterBar(
                right: _sel.isEmpty
                    ? null
                    : Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text('已选 ${_sel.length} 条',
                              style: const TextStyle(fontSize: 12.5, color: WsTokens.primary)),
                          const SizedBox(width: 10),
                          DesktopButton(label: '标记已付', small: true, onPressed: () => _markPaidBatch(true)),
                          const SizedBox(width: 8),
                          DesktopButton(label: '标记待付', small: true, onPressed: () => _markPaidBatch(false)),
                          const SizedBox(width: 8),
                          DesktopButton(label: '批量删除', small: true, kind: DesktopButtonKind.danger, onPressed: _batchDelete),
                          const SizedBox(width: 8),
                          DesktopButton(label: '取消选择', small: true, onPressed: () => setState(_sel.clear)),
                        ],
                      ),
                children: [
                  DesktopLabeled(label: '日期', child: DesktopDateField(value: _dateFrom, onChanged: (v) => setState(() => _dateFrom = v))),
                  wsCell('—'),
                  DesktopDateField(value: _dateTo, onChanged: (v) => setState(() => _dateTo = v)),
                  DesktopButton(label: '今天', small: true, onPressed: () => setState(() {
                        _dateFrom = wsToday();
                        _dateTo = wsToday();
                        _loadRecords();
                      })),
                  DesktopTextField(
                    controller: _keyword,
                    width: 240,
                    hintText: '🔍 筛选单号 / 商品 / 供应商…',
                    onChanged: (_) => setState(() {}),
                  ),
                  DesktopLabeled(
                    label: '付款状态',
                    child: DesktopSelect<String>(
                      width: 120,
                      value: _payFilter,
                      options: const [
                        DesktopOption<String>('', '全部'),
                        DesktopOption<String>('paid', '已付款'),
                        DesktopOption<String>('unpaid', '待付款'),
                      ],
                      onChanged: (v) => setState(() => _payFilter = v ?? ''),
                    ),
                  ),
                  DesktopButton(label: '查询', icon: Icons.search, small: true, onPressed: _loadRecords),
                ],
              ),
              DesktopStateView(
                loading: _recLoading,
                error: _recError,
                onRetry: _loadRecords,
                loadingText: '正在读取入库记录…',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    DesktopGrid(
                      cols: _recordCols,
                      sortKey: _sortKey,
                      sortAsc: _sortAsc,
                      onSort: _onSort,
                      rowHeight: 44,
                      emptyText: '该日期区间没有入库记录（默认只看今天，可放宽日期后点「查询」）',
                      rows: [
                        for (final r in rows)
                          DesktopRow(
                            dim: wsS(r['pay_status'], fallback: 'paid') == 'unpaid',
                            cells: _recordCells(r),
                          ),
                      ],
                      footer: [
                        '',
                        '共 ${rows.length} 条',
                        '',
                        '合计',
                        '',
                        '',
                        wsMoney(amount),
                        wsMoney(adjust),
                        wsMoney(freight),
                        wsMoney(handling),
                        '总计支出',
                        '',
                        '',
                        wsMoney(total),
                        '',
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Text(
                          '金额 ${wsMoney(amount)} · 调整 ${wsMoney(adjust)} · 运费 ${wsMoney(freight)} · '
                          '装卸 ${wsMoney(handling)} · 总计支出 ${wsMoney(total)}（货款＋运费＋装卸＋调整）',
                          style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: WsTokens.primary),
                        ),
                        const Spacer(),
                        const Text('运费与装卸已计入批次成本，并同步「其他开支」',
                            style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        DesktopButton(label: '全选当前列表', small: true, onPressed: () => setState(() {
                              for (final r in rows) {
                                _sel.add(wsI(r['id']));
                              }
                            })),
                        const SizedBox(width: 8),
                        DesktopButton(label: '清空选择', small: true, onPressed: () => setState(_sel.clear)),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _recordCells(Map<String, dynamic> r) {
    final id = wsI(r['id']);
    final paid = wsS(r['pay_status'], fallback: 'paid') != 'unpaid';
    final unit = wsS(r['unit']);
    final amount = wsD(r['final_amount'] ?? r['total_amount']);
    final adjust = wsD(r['adjust_amount']);
    final freight = wsD(r['freight']);
    final handling = wsD(r['handling']);
    final selected = _sel.contains(id);
    return [
      SizedBox(
        width: 18,
        child: Checkbox(
          value: selected,
          onChanged: (v) => setState(() {
            if (v == true) {
              _sel.add(id);
            } else {
              _sel.remove(id);
            }
          }),
          visualDensity: VisualDensity.compact,
          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(3))),
        ),
      ),
      wsCell(wsS(r['code'], fallback: '—'), tip: wsS(r['code'])),
      wsCell(wsS(r['date'])),
      wsCell(wsS(r['product_name'], fallback: '—'), bold: true, tip: wsS(r['product_name'])),
      wsCell('${wsTrim(wsD(r['quantity']), digits: 4)} $unit'),
      wsCell('${wsMoney(wsD(r['unit_price']))}/$unit'),
      Tooltip(
        message: '货款${adjust != 0 ? '（含金额调整）' : ''}'
            '${freight + handling > 0 ? ' · 批次成本 ${wsMoney(amount + freight + handling)}（含运费/装卸）' : ''}',
        child: wsCell(wsMoney(amount), bold: true),
      ),
      wsCell(adjust == 0 ? '—' : '${adjust > 0 ? '+' : '-'}${wsMoney(adjust.abs())}'),
      wsCell(freight == 0 ? '—' : wsMoney(freight)),
      wsCell(handling == 0 ? '—' : wsMoney(handling)),
      wsCell(wsS(r['supplier'], fallback: '—'), tip: wsS(r['supplier'])),
      wsCell(wsS(r['operator'], fallback: '—')),
      DesktopTag(_payLabel(wsS(r['pay_status'], fallback: 'paid')),
          color: paid ? DesktopTag.paid : DesktopTag.unpaid),
      wsCell(wsS(r['remark'], fallback: '—'), tip: wsS(r['remark']), color: WsTokens.mutedLight),
      FittedBox(
        fit: BoxFit.scaleDown,
        alignment: Alignment.centerLeft,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            DesktopLink('改', onPressed: () => _openEdit(r)),
            DesktopLink(
              paid ? '标记待付' : '标记已付',
              color: WsTokens.mutedLight,
              onPressed: () => _markPaid(r, paid: !paid),
            ),
            DesktopLink('删', color: WsTokens.red, onPressed: () => _deleteOne(r)),
          ],
        ),
      ),
    ];
  }
}

/// 只读的「锁定」输入框外观（操作员这类不可改字段）
class _LockedBox extends StatelessWidget {
  const _LockedBox({required this.text, required this.width});

  final String text;
  final double width;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Container(
      width: width,
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      alignment: Alignment.centerLeft,
      decoration: BoxDecoration(
        color: dark ? WsTokens.borderDark : WsTokens.borderLighter,
        borderRadius: BorderRadius.circular(WsTokens.radiusSm),
        border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              text,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, color: dark ? WsTokens.mutedDark : WsTokens.mutedLight),
            ),
          ),
          const Icon(Icons.lock_outline, size: 13, color: WsTokens.mutedLight),
        ],
      ),
    );
  }
}
