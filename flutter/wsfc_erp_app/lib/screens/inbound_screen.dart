import '../mobile/widgets/mobile_page.dart';
import '../mobile/widgets/parts.dart';
import '../mobile/mobile_style.dart';
import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import 'dart:async';

import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../providers/product_provider.dart';
import '../services/api_service.dart';
import '../models/product.dart';

class InboundScreen extends StatefulWidget {
  const InboundScreen({super.key});

  @override
  State<InboundScreen> createState() => _InboundScreenState();
}

class _InboundScreenState extends State<InboundScreen> {
  final _formKey = GlobalKey<FormState>();
  String _date = DateFormat('yyyy-MM-dd').format(DateTime.now());
  String _supplier = '';
  final List<_InboundRow> _rows = [_InboundRow()];
  bool _isLoading = false;

  int _tab = 0;

  // ---------- 入库记录 ----------
  final NumberFormat _money =
      NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);
  final DateFormat _day = DateFormat('yyyy-MM-dd');
  final TextEditingController _kwCtrl = TextEditingController();
  List<Map<String, dynamic>> _records = [];
  bool _recLoading = false;
  String? _recError;
  late String _from;
  late String _to;

  @override
  void initState() {
    super.initState();
    final DateTime now = DateTime.now();
    _to = _day.format(now);
    _from = _day.format(now.subtract(const Duration(days: 6)));
  }

  @override
  void dispose() {
    _kwCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MobilePage(
      title: '入库',
      tabIndex: 2,
      underBar: GlassSegmentedControl(
        height: 38,
        selectedIndex: _tab,
        onSegmentSelected: (i) {
          setState(() => _tab = i);
          if (i == 1) _loadRecords();
        },
        segments: const [
          GlassSegment(label: '入库单'),
          GlassSegment(label: '入库记录'),
        ],
      ),
      onRefresh: _tab == 1 ? _loadRecords : null,
      body: _tab == 0 ? _buildEntry() : _buildRecords(),
    );
  }

  Widget _buildEntry() {
    return SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 28),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              GCard(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '快捷入库',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Expanded(
                            child: FormCell(
                              label: '日期',
                              child: CellInput(
                                initialValue: _date,
                                onTap: () async {
                                  final picked = await showDatePicker(
                                    context: context,
                                    initialDate: DateTime.now(),
                                    firstDate: DateTime(2020),
                                    lastDate: DateTime(2030),
                                  );
                                  if (picked != null) {
                                    setState(() {
                                      _date = DateFormat('yyyy-MM-dd').format(picked);
                                    });
                                  }
                                },
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: FormCell(
                              label: '供应商',
                              child: CellInput(
                                hint: '供应商名称',
                                onChanged: (v) => _supplier = v,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      ..._rows.asMap().entries.map((entry) {
                        final i = entry.key;
                        final row = entry.value;
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Expanded(
                                child: FormCell(
                                  label: '商品',
                                  child: CellTapBox(
                                    onTap: () => _openProductPicker(i),
                                    background: row.product == null
                                        ? const Color(0xFFF0F8FF)
                                        : Colors.grey[100],
                                    child: Text(
                                      row.product == null
                                          ? '＋ 选择商品'
                                          : '[库存] ${row.product!.name}',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 13,
                                        color: row.product == null
                                            ? const Color(0xFF1989FA)
                                            : Mc.ink,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              SizedBox(
                                width: 62,
                                child: FormCell(
                                  label: '数量',
                                  child: CellInput(
                                    initialValue: '1',
                                    keyboardType: TextInputType.number,
                                    onChanged: (v) => row.quantity = v,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              SizedBox(
                                width: 70,
                                child: FormCell(
                                  label: '单价',
                                  child: CellInput(
                                    initialValue: '0',
                                    keyboardType: TextInputType.number,
                                    onChanged: (v) => row.price = v,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 2),
                              Padding(
                                padding: const EdgeInsets.only(top: 17),
                                child: IconButton(
                                  visualDensity: VisualDensity.compact,
                                  constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                                  padding: EdgeInsets.zero,
                                  icon: const Icon(Icons.delete_outline,
                                      size: 22, color: Colors.red),
                                  onPressed: _rows.length > 1
                                      ? () => setState(() => _rows.removeAt(i))
                                      : null,
                                ),
                              ),
                            ],
                          ),
                        );
                      }),
                      OutlinedButton.icon(
                        onPressed: () => setState(() => _rows.add(_InboundRow())),
                        icon: const Icon(Icons.add),
                        label: const Text('加一行'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFF1989FA),
                        ),
                      ),
                      const SizedBox(height: 16),
                      SizedBox(
                        height: 44,
                        width: double.infinity,
                        child: ElevatedButton(
                          onPressed: _isLoading ? null : _submit,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF1989FA),
                            foregroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(20),
                            ),
                          ),
                          child: _isLoading
                              ? const SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                                  ),
                                )
                              : const Text('确认入库', style: TextStyle(fontSize: 16)),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      );
  }

  Future<void> _openProductPicker(int rowIndex) async {
    final product = await Navigator.push<Product>(
      context,
      MaterialPageRoute(
        builder: (context) => const _ProductPickerScreen(),
      ),
    );

    if (product != null && mounted) {
      setState(() {
        _rows[rowIndex].product = product;
        _rows[rowIndex].unit = product.defaultUnit ?? product.baseUnit;
      });
    }
  }

  /// 原始商品表（含 last_in_price / conversions），用于入库单价变动确认
  List<Map<String, dynamic>> _rawProducts = [];

  Future<void> _ensureRawProducts() async {
    if (_rawProducts.isNotEmpty) return;
    try {
      final List<dynamic> rows = await ApiService.products();
      _rawProducts = [
        for (final p in rows)
          if (p is Map) Map<String, dynamic>.from(p),
      ];
    } on ApiException {
      // 拿不到商品表就不拦录入
    }
  }

  /// 本次录入价 vs 最近一次入库价：不同就列出来让用户二次确认
  List<String> _priceWarnings() {
    final out = <String>[];
    for (final row in _rows.where((r) => r.product != null)) {
      final Map<String, dynamic> p = _rawProducts.firstWhere(
        (x) => _i(x['id']) == row.product!.id,
        orElse: () => const {},
      );
      if (p.isEmpty) continue;
      final double cur = _d(row.price);
      if (!(cur > 0)) continue;
      final double lastBase = _d(p['last_in_price']);
      if (!(lastBase > 0)) continue;
      final String unit = row.unit ?? _s(p['default_unit']);
      final Object? conv = (p['conversions'] as Map?)?[unit];
      final double f = conv == null ? 1 : _d(conv);
      final double last = lastBase * f;
      if ((cur - last).abs() <= 1e-4) continue;
      final double pct = last == 0 ? 0 : (cur - last) / last * 100;
      out.add('${_s(p['name'])}：最近入库 ${_money.format(last)}/$unit'
          ' → 本次 ${_money.format(cur)}/$unit'
          '（${pct >= 0 ? '涨' : '降'} ${pct.abs().toStringAsFixed(1)}%）');
    }
    return out;
  }

  Future<void> _submit() async {
    if (_rows.every((r) => r.product == null)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请至少选择一条商品')),
      );
      return;
    }

    // 单价与最近一次入库价不同：先让用户确认（价格录错会连带批次成本与毛利）
    await _ensureRawProducts();
    final List<String> warns = _priceWarnings();
    if (warns.isNotEmpty) {
      if (!mounted) return;
      final List<String> list = warns.take(8).toList();
      final String more =
          warns.length > list.length ? '\n…另有 ${warns.length - list.length} 个商品存在差异' : '';
      final bool? go = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: const Text('入库单价与最近一次不同'),
          content: Text('${list.join('\n')}$more\n\n确认价格无误、仍按本次单价入库吗？'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('取消')),
            TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('确认入库')),
          ],
        ),
      );
      if (go != true) return;
    }

    setState(() => _isLoading = true);

    try {
      for (final row in _rows.where((r) => r.product != null)) {
        await ApiService.post('/api/inbounds', data: {
          'product_id': row.product!.id,
          'unit': row.unit ?? '个',
          'quantity': double.tryParse(row.quantity ?? '0') ?? 0,
          'unit_price': double.tryParse(row.price ?? '0') ?? 0,
          'supplier': _supplier,
          'date': _date,
          'remark': '',
        });
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('入库成功'), backgroundColor: Colors.green),
        );
        setState(() {
          _rows.clear();
          _rows.add(_InboundRow());
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('入库失败：${e.toString()}'), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  // ================= 入库记录（与 PWA / 桌面端同口径） =================

  static String _s(dynamic v) => v?.toString() ?? '';
  static double _d(dynamic v) {
    if (v is num) return v.toDouble();
    return double.tryParse(v?.toString() ?? '') ?? 0;
  }

  static int _i(dynamic v) {
    if (v is num) return v.toInt();
    return int.tryParse(v?.toString() ?? '') ?? 0;
  }

  static double _round2(dynamic v) => (_d(v) * 100).roundToDouble() / 100;

  Future<void> _loadRecords() async {
    setState(() {
      _recLoading = true;
      _recError = null;
    });
    try {
      final List<dynamic> rows =
          await ApiService.inbounds(dateFrom: _from, dateTo: _to);
      if (!mounted) return;
      setState(() {
        _records = [
          for (final r in rows)
            if (r is Map) Map<String, dynamic>.from(r),
        ];
        _recLoading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _recLoading = false;
        _recError = e.message;
      });
    }
  }

  List<Map<String, dynamic>> _visibleRecords() {
    final String kw = _kwCtrl.text.trim().toLowerCase();
    if (kw.isEmpty) return _records;
    return _records.where((r) {
      final String text =
          '${_s(r['code'])} ${_s(r['product_name'])} ${_s(r['supplier'])} ${_s(r['operator'])}'
              .toLowerCase();
      return text.contains(kw);
    }).toList();
  }

  /// 筛选实时汇总：数量按单位分组，金额按应付口径
  ({
    int n,
    String qtyText,
    double goods,
    double due,
    double paid,
    double unpaid,
    int pend,
    String extras,
  }) _sumOf(List<Map<String, dynamic>> rows) {
    final Map<String, double> qtyMap = <String, double>{};
    double goods = 0, adjust = 0, freight = 0, handling = 0, fee = 0;
    double due = 0, paid = 0, unpaid = 0;
    int pend = 0;
    for (final r in rows) {
      final String u = _s(r['unit']).trim();
      qtyMap[u] = (qtyMap[u] ?? 0) + _d(r['quantity']);
      goods += _d(r['total_amount']);
      adjust += _d(r['adjust_amount']);
      freight += _d(r['freight']);
      handling += _d(r['handling']);
      fee += _d(r['fee']);
      due += _d(r['due_amount']);
      paid += _d(r['paid_amount']);
      unpaid += _d(r['unpaid_amount']);
      if (_s(r['pay_status']) != 'paid') pend += 1;
    }
    final String qtyText = qtyMap.entries
        .map((e) => '${_trim(e.value)}${e.key.isEmpty ? '' : ' ${e.key}'}')
        .join(' / ');
    final String extras = [
      if (adjust != 0) '调整 ${adjust > 0 ? '+' : '-'}${_money.format(adjust.abs())}',
      if (freight != 0) '运费 ${_money.format(freight)}',
      if (handling != 0) '装卸 ${_money.format(handling)}',
      if (fee != 0) '手续费 ${_money.format(fee)}',
    ].join(' · ');
    return (
      n: rows.length,
      qtyText: qtyText.isEmpty ? '0' : qtyText,
      goods: goods,
      due: due,
      paid: paid,
      unpaid: unpaid,
      pend: pend,
      extras: extras,
    );
  }

  /// 数量文本：整数不留小数，其余最多 4 位
  static String _trim(double v) {
    if (v == v.roundToDouble()) return v.toStringAsFixed(0);
    return v.toStringAsFixed(4).replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');
  }

  Future<void> _pickRecDate(bool isFrom) async {
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
    await _loadRecords();
  }

  Widget _buildRecords() {
    final List<Map<String, dynamic>> rows = _visibleRecords();
    final s = _sumOf(rows);
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 6, 14, 28),
      children: [
        GlassPanel(
          padding: const EdgeInsets.fromLTRB(10, 4, 10, 10),
          child: Column(
            children: [
              Row(
                children: [
                  TextButton(
                    onPressed: () => _pickRecDate(true),
                    child: Text(_from, style: const TextStyle(fontSize: 13)),
                  ),
                  const Text('~', style: TextStyle(color: Mc.inkThird)),
                  TextButton(
                    onPressed: () => _pickRecDate(false),
                    child: Text(_to, style: const TextStyle(fontSize: 13)),
                  ),
                  const Spacer(),
                  TextButton(
                    onPressed: _loadRecords,
                    child: const Text('查询', style: TextStyle(fontSize: 13)),
                  ),
                ],
              ),
              TextField(
                controller: _kwCtrl,
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  isDense: true,
                  hintText: '筛选单号 / 商品 / 供应商',
                  prefixIcon: const Icon(Icons.search, size: 18),
                  filled: true,
                  fillColor: Colors.white.withValues(alpha: 0.7),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ],
          ),
        ),
        if (rows.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 10, bottom: 10),
            child: GlassPanel(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          '${_kwCtrl.text.trim().isNotEmpty || _from.isNotEmpty ? '筛选结果' : '当前列表'} '
                          '${s.n} 笔${s.n == _records.length ? '' : ' / 共 ${_records.length} 笔'}',
                          style: const TextStyle(
                              fontSize: 13, fontWeight: FontWeight.w600, color: Mc.ink),
                        ),
                      ),
                      Text('应付 ${_money.format(s.due)}',
                          style: const TextStyle(
                              fontSize: 13, fontWeight: FontWeight.w700, color: Mc.brand)),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text('数量合计 ${s.qtyText}',
                      style: const TextStyle(fontSize: 12, color: Mc.inkSecond)),
                  Text(
                    '已付 ${_money.format(s.paid)} ／ 未付 ${_money.format(s.unpaid)}'
                    '${s.pend > 0 ? '（待结算 ${s.pend} 笔）' : ''}',
                    style: const TextStyle(fontSize: 12, color: Mc.inkSecond),
                  ),
                  Text(
                    '货款 ${_money.format(s.goods)}${s.extras.isEmpty ? '' : ' · ${s.extras}'}',
                    style: const TextStyle(fontSize: 12, color: Mc.inkSecond),
                  ),
                ],
              ),
            ),
          ),
        if (_recLoading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 32),
            child: Center(
              child: Text('正在读取入库记录…',
                  style: TextStyle(fontSize: 13, color: Mc.inkThird)),
            ),
          )
        else if (_recError != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text('加载失败：$_recError',
                style: const TextStyle(fontSize: 13, color: Mc.warn)),
          )
        else if (rows.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 32),
            child: Center(
              child: Text('该区间没有入库记录',
                  style: TextStyle(fontSize: 13, color: Mc.inkThird)),
            ),
          )
        else
          for (final r in rows) _recordCard(r),
      ],
    );
  }

  Widget _recordCard(Map<String, dynamic> r) {
    final double amount =
        _d(r['final_amount'] != null ? r['final_amount'] : r['total_amount']);
    final String pay = _s(r['pay_status']);
    final double adjust = _d(r['adjust_amount']);
    return GlassPanel(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(_s(r['product_name']),
                    style: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w600, color: Mc.ink)),
              ),
              if (pay == 'partial')
                const Text('部分付款',
                    style: TextStyle(fontSize: 11, color: Mc.warn))
              else if (pay == 'unpaid')
                const Text('待付款', style: TextStyle(fontSize: 11, color: Mc.warn)),
              const SizedBox(width: 6),
              Text(_money.format(amount),
                  style: const TextStyle(
                      fontSize: 14, fontWeight: FontWeight.w700, color: Mc.ink)),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${_s(r['code'])} · ${_trim(_d(r['quantity']))}${_s(r['unit'])} × '
            '${_money.format(_d(r['unit_price']))} · ${_s(r['date'])}',
            style: const TextStyle(fontSize: 12, color: Mc.inkSecond),
          ),
          if (adjust != 0)
            Text(
              '调整 ${adjust > 0 ? '+' : '−'}${_money.format(adjust.abs())} · '
              '商品金额 ${_money.format(_d(r['total_amount']))}',
              style: const TextStyle(fontSize: 12, color: Mc.warn),
            ),
          if (pay == 'partial')
            Text(
              '已付 ${_money.format(_d(r['paid_amount']))} · 未付 ${_money.format(_d(r['unpaid_amount']))}'
              '（应付 ${_money.format(_d(r['due_amount']))}，余额在待付款账单）',
              style: const TextStyle(fontSize: 12, color: Mc.warn),
            ),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Text(
                  '${_s(r['supplier']).isEmpty ? '无供应商' : _s(r['supplier'])}'
                  '${_s(r['operator']).isEmpty ? '' : ' · ${_s(r['operator'])}'}',
                  style: const TextStyle(fontSize: 12, color: Mc.inkThird),
                ),
              ),
              TextButton(
                onPressed: () => _openEdit(r),
                style: TextButton.styleFrom(
                  foregroundColor: Mc.brand,
                  minimumSize: const Size(0, 32),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                ),
                child: const Text('改', style: TextStyle(fontSize: 13)),
              ),
              TextButton(
                onPressed: () => _deleteRecord(r),
                style: TextButton.styleFrom(
                  foregroundColor: Mc.danger,
                  minimumSize: const Size(0, 32),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                ),
                child: const Text('删除', style: TextStyle(fontSize: 13)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _deleteRecord(Map<String, dynamic> r) async {
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('删除入库单'),
        content: Text('确认删除 ${_s(r['code'])}（${_s(r['product_name'])}）？库存与成本会自动回退。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('取消')),
          TextButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('删除', style: TextStyle(color: Mc.danger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ApiService.deleteInbound(_i(r['id']));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已删除'), backgroundColor: Colors.green),
      );
      await _loadRecords();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('删除失败：${e.message}'), backgroundColor: Colors.red),
      );
    }
  }

  /// 改单：数量 / 单价 / 日期 / 供应商 / 付款状态；改前核算影响范围
  Future<void> _openEdit(Map<String, dynamic> r) async {
    final int id = _i(r['id']);
    final String unit = _s(r['unit']);
    final double originQty = _d(r['quantity']);
    final double originPrice = _d(r['unit_price']);
    final String originDate = _s(r['date']);
    final TextEditingController qtyCtl =
        TextEditingController(text: _trim(originQty));
    final TextEditingController priceCtl =
        TextEditingController(text: _trim(originPrice));
    final TextEditingController supplierCtl =
        TextEditingController(text: _s(r['supplier']));
    final TextEditingController paidCtl = TextEditingController(
        text: _d(r['paid_amount']) > 0 ? _trim(_d(r['paid_amount'])) : '');
    String date = originDate.isEmpty ? _day.format(DateTime.now()) : originDate;
    String pay = ['paid', 'partial', 'unpaid'].contains(_s(r['pay_status']))
        ? _s(r['pay_status'])
        : 'paid';
    Map<String, dynamic>? impact;
    bool impactLoading = false;
    String impactErr = '';
    Timer? timer;
    bool closed = false;

    Future<void> fetchImpact(StateSetter setSheet) async {
      if (closed) return;
      final double qty = _d(qtyCtl.text);
      final double price = _d(priceCtl.text);
      if (!(qty > 0) || price < 0) {
        setSheet(() {
          impact = null;
          impactErr = qty > 0 ? '单价不能为负数' : '数量必须大于 0';
          impactLoading = false;
        });
        return;
      }
      setSheet(() {
        impactLoading = true;
        impactErr = '';
      });
      try {
        final Map<String, dynamic> res = await ApiService.inboundImpact(
          id,
          quantity: qty,
          unitPrice: price,
          date: date,
        );
        if (closed) return;
        setSheet(() {
          impact = res;
          impactLoading = false;
        });
      } on ApiException catch (e) {
        if (closed) return;
        setSheet(() {
          impact = null;
          impactErr = '影响核算失败：${e.message}';
          impactLoading = false;
        });
      }
    }

    final bool? saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (c) {
        return StatefulBuilder(
          builder: (c2, setSheet) {
            Widget impactView() {
              if (impactLoading) {
                return const Text('正在核算影响范围…',
                    style: TextStyle(fontSize: 12, color: Mc.inkThird));
              }
              if (impactErr.isNotEmpty) {
                return Text(impactErr,
                    style: const TextStyle(fontSize: 12, color: Mc.danger));
              }
              final Map<String, dynamic>? d = impact;
              if (d == null) return const SizedBox.shrink();
              final double f = _d(d['unit_factor']) == 0 ? 1 : _d(d['unit_factor']);
              final String du = _s(d['unit']).isNotEmpty ? _s(d['unit']) : _s(d['base_unit']);
              final int affected = _i(d['affected_count']);
              final List<String> outs = [
                for (final o in ((d['affected_outbounds'] as List?) ?? const []))
                  if (o is Map)
                    '${_s(o['code'])}（${_s(o['date'])}，成本 '
                        '${_d(o['delta']) >= 0 ? '+' : '-'}${_money.format(_d(o['delta']).abs())}）',
              ];
              final List<String> warns = [
                for (final w in ((d['warnings'] as List?) ?? const [])) _s(w),
              ].where((e) => e.isNotEmpty).toList();
              final Color tone = affected > 0 ? Mc.warn : Mc.fresh;
              return Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: tone.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      affected > 0
                          ? '会影响 $affected 张出库单，保存后按 FIFO 重算成本与毛利'
                          : (d['used'] == true
                              ? '这批货已有出库用到，但按当前改动订单成本没有变化'
                              : '可快速更改：这批货还没有被出库/包装消耗用到'),
                      style: TextStyle(
                          fontSize: 12.5, fontWeight: FontWeight.w600, color: tone),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '本单金额 ${_money.format(_d(d['old_total_amount']))} → '
                      '${_money.format(_d(d['new_total_amount']))}；'
                      '库存 ${_trim(_d(d['stock_before']) / f)}$du → '
                      '${_trim(_d(d['stock_after']) / f)}$du；'
                      '均价 ${_money.format(_d(d['avg_cost_before']) * f)} → '
                      '${_money.format(_d(d['avg_cost_after']) * f)}/$du',
                      style: const TextStyle(fontSize: 11.5, color: Mc.inkSecond),
                    ),
                    for (final o in outs.take(5))
                      Text(o,
                          style: const TextStyle(fontSize: 11.5, color: Mc.inkSecond)),
                    if (affected > outs.length)
                      Text('…等共 $affected 张',
                          style: const TextStyle(fontSize: 11.5, color: Mc.inkSecond)),
                    if (warns.isNotEmpty)
                      Text('⚠ ${warns.join('；')}',
                          style: const TextStyle(fontSize: 11.5, color: Mc.danger)),
                  ],
                ),
              );
            }

            return Padding(
              padding: EdgeInsets.only(
                left: 16,
                right: 16,
                top: 16,
                bottom: MediaQuery.of(c2).viewInsets.bottom + 16,
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('修改入库单',
                        style: const TextStyle(
                            fontSize: 17, fontWeight: FontWeight.w700, color: Mc.ink)),
                    const SizedBox(height: 4),
                    Text(
                      '${_s(r['code'])} · ${_s(r['product_name'])} · '
                      '商品金额 ${_money.format(_d(r['total_amount']))}',
                      style: const TextStyle(fontSize: 12, color: Mc.inkThird),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: FormCell(
                            label: '数量（$unit）',
                            child: CellInput(
                              controller: qtyCtl,
                              keyboardType:
                                  const TextInputType.numberWithOptions(decimal: true),
                              onChanged: (_) {
                                timer?.cancel();
                                timer = Timer(const Duration(milliseconds: 400),
                                    () => fetchImpact(setSheet));
                              },
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: FormCell(
                            label: '单价（元/$unit）',
                            child: CellInput(
                              controller: priceCtl,
                              keyboardType:
                                  const TextInputType.numberWithOptions(decimal: true),
                              onChanged: (_) {
                                timer?.cancel();
                                timer = Timer(const Duration(milliseconds: 400),
                                    () => fetchImpact(setSheet));
                              },
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    impactView(),
                    const SizedBox(height: 10),
                    FormCell(
                      label: '供应商',
                      child: CellInput(controller: supplierCtl, hint: '可留空'),
                    ),
                    const SizedBox(height: 10),
                    FormCell(
                      label: '入库日期',
                      child: CellTapBox(
                        background: Colors.grey[100],
                        onTap: () async {
                          final DateTime? picked = await showDatePicker(
                            context: c2,
                            initialDate: DateTime.tryParse(date) ?? DateTime.now(),
                            firstDate: DateTime(2020),
                            lastDate: DateTime(2100),
                          );
                          if (picked == null) return;
                          setSheet(() => date = _day.format(picked));
                          timer?.cancel();
                          timer = Timer(const Duration(milliseconds: 300),
                              () => fetchImpact(setSheet));
                        },
                        child: Text(date, style: const TextStyle(fontSize: 13)),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        const Text('付款状态',
                            style: TextStyle(fontSize: 12, color: Mc.inkSecond)),
                        for (final (v, label) in [
                          ('paid', '已付款'),
                          ('partial', '部分付款'),
                          ('unpaid', '待付款'),
                        ])
                          ChoiceChip(
                            label: Text(label, style: const TextStyle(fontSize: 12)),
                            selected: pay == v,
                            onSelected: (_) => setSheet(() => pay = v),
                          ),
                      ],
                    ),
                    if (pay == 'partial') ...[
                      const SizedBox(height: 8),
                      FormCell(
                        label: '已付金额',
                        child: CellInput(
                          controller: paidCtl,
                          keyboardType:
                              const TextInputType.numberWithOptions(decimal: true),
                          onChanged: (_) {},
                        ),
                      ),
                      Text(
                        '应付 ${_money.format(_d(r['due_amount']))}；未付余额进待付款账单',
                        style: const TextStyle(fontSize: 11.5, color: Mc.inkThird),
                      ),
                    ],
                    const SizedBox(height: 8),
                    const Text(
                      '数量 / 单价可直接修改；保存前会再核算影响范围，已有出库用到这批货时会列出受影响订单并重算成本。',
                      style: TextStyle(fontSize: 11.5, color: Mc.inkThird),
                    ),
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () => Navigator.pop(c2, false),
                            child: const Text('取消'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: ElevatedButton(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Mc.brand,
                              foregroundColor: Colors.white,
                            ),
                            onPressed: () async {
                              final double qty = _d(qtyCtl.text);
                              final double price = _d(priceCtl.text);
                              if (!(qty > 0)) {
                                ScaffoldMessenger.of(c2).showSnackBar(
                                    const SnackBar(content: Text('数量必须大于 0')));
                                return;
                              }
                              if (price < 0) {
                                ScaffoldMessenger.of(c2).showSnackBar(
                                    const SnackBar(content: Text('单价不能为负数')));
                                return;
                              }
                              if (date.isEmpty) {
                                ScaffoldMessenger.of(c2).showSnackBar(
                                    const SnackBar(content: Text('请选择入库日期')));
                                return;
                              }
                              final bool qtyChanged =
                                  (qty - originQty).abs() > 1e-9 ||
                                      (price - originPrice).abs() > 1e-9;
                              final bool dateChanged = date != originDate;
                              int affected = 0;
                              if (qtyChanged || dateChanged) {
                                try {
                                  final Map<String, dynamic> imp =
                                      await ApiService.inboundImpact(
                                    id,
                                    quantity: qtyChanged ? qty : originQty,
                                    unitPrice: qtyChanged ? price : originPrice,
                                    date: date,
                                  );
                                  affected = _i(imp['affected_count']);
                                  final List<String> warns = [
                                    for (final w
                                        in ((imp['warnings'] as List?) ?? const []))
                                      _s(w),
                                  ].where((e) => e.isNotEmpty).toList();
                                  if (affected > 0) {
                                    final bool? go = await showDialog<bool>(
                                      context: c2,
                                      builder: (cc) => AlertDialog(
                                        title: const Text('该批次已被出库使用'),
                                        content: Text(
                                            '保存后会重算 $affected 张出库单的成本与毛利，确认修改？'),
                                        actions: [
                                          TextButton(
                                              onPressed: () => Navigator.pop(cc, false),
                                              child: const Text('取消')),
                                          TextButton(
                                              onPressed: () => Navigator.pop(cc, true),
                                              child: const Text('确认修改')),
                                        ],
                                      ),
                                    );
                                    if (go != true) return;
                                  } else if (warns.isNotEmpty) {
                                    final bool? go = await showDialog<bool>(
                                      context: c2,
                                      builder: (cc) => AlertDialog(
                                        title: const Text('注意'),
                                        content: Text('${warns.join('；')}\n\n确认继续？'),
                                        actions: [
                                          TextButton(
                                              onPressed: () => Navigator.pop(cc, false),
                                              child: const Text('取消')),
                                          TextButton(
                                              onPressed: () => Navigator.pop(cc, true),
                                              child: const Text('继续')),
                                        ],
                                      ),
                                    );
                                    if (go != true) return;
                                  }
                                } on ApiException catch (e) {
                                  ScaffoldMessenger.of(c2).showSnackBar(
                                      SnackBar(content: Text('影响核算失败：${e.message}')));
                                  return;
                                }
                              }
                              final double due = _round2(qty * price + _d(r['adjust_amount']));
                              double paidAmount = 0;
                              if (pay == 'partial') {
                                paidAmount = _round2(paidCtl.text);
                                if (!(paidAmount > 0)) {
                                  ScaffoldMessenger.of(c2).showSnackBar(SnackBar(
                                      content: Text(
                                          '部分付款请填已付金额（应付 ${_money.format(due)}）')));
                                  return;
                                }
                                if (paidAmount >= due - 0.005) {
                                  ScaffoldMessenger.of(c2).showSnackBar(const SnackBar(
                                      content: Text('已付已够应付合计，付款状态请选「已付款」')));
                                  return;
                                }
                              }
                              try {
                                await ApiService.updateInbound(id, {
                                  'supplier': supplierCtl.text.trim(),
                                  'date': date,
                                  'pay_status': pay,
                                  'paid_amount': paidAmount,
                                  if (qtyChanged) 'quantity': qty,
                                  if (qtyChanged) 'unit_price': price,
                                });
                                if (closed) return;
                                Navigator.pop(c2, true);
                                if (mounted) {
                                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                                    content: Text('已保存'
                                        '${qtyChanged ? '；数量/单价已更新' : ''}'
                                        '${affected > 0 ? '；已重算 $affected 张出库单成本' : ''}'),
                                    backgroundColor: Colors.green,
                                  ));
                                }
                              } on ApiException catch (e) {
                                ScaffoldMessenger.of(c2).showSnackBar(
                                    SnackBar(content: Text('保存失败：${e.message}')));
                              }
                            },
                            child: const Text('保存'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );

    closed = true;
    timer?.cancel();
    qtyCtl.dispose();
    priceCtl.dispose();
    supplierCtl.dispose();
    paidCtl.dispose();
    if (saved == true) await _loadRecords();
  }
}

class _InboundRow {
  Product? product;
  String? unit;
  String? quantity = '1';
  String? price = '0';
}

class _ProductPickerScreen extends StatefulWidget {
  const _ProductPickerScreen();

  @override
  State<_ProductPickerScreen> createState() => _ProductPickerScreenState();
}

class _ProductPickerScreenState extends State<_ProductPickerScreen> {
  String _searchKeyword = '';
  String _filterCategory = '';

  @override
  void initState() {
    super.initState();
    // 商品表由 ProductProvider 统一持有：只有全 App 第一次要它时才真的走网络
    context.read<ProductProvider>().ensureLoaded();
  }

  List<Product> _visible(List<Product> source) {
    final k = _searchKeyword.toLowerCase();
    return source.where((p) {
      if (k.isNotEmpty &&
          !p.name.toLowerCase().contains(k) &&
          !p.category.toLowerCase().contains(k)) {
        return false;
      }
      if (_filterCategory.isNotEmpty && p.category != _filterCategory) return false;
      return true;
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ProductProvider>();
    final source = provider.getStockProducts();
    final shown = _visible(source);
    final categories = source.map((p) => p.category).where((c) => c.isNotEmpty).toSet();
    return MobilePage(
      title: '选择入库商品',
      back: true,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
            child: TextField(
              decoration: const InputDecoration(
                hintText: '搜索商品名称 / 分类',
                prefixIcon: Icon(Icons.search),
                isDense: true,
              ),
              onChanged: (v) => setState(() => _searchKeyword = v),
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(
              children: [
                const Padding(
                  padding: EdgeInsets.only(right: 8),
                  child: FilterChip(label: Text('全部'), selected: true, onSelected: null),
                ),
                ...categories.map((c) => Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: FilterChip(
                        label: Text(c),
                        selected: _filterCategory == c,
                        onSelected: (selected) {
                          setState(() => _filterCategory = selected ? c : '');
                        },
                      ),
                    )),
              ],
            ),
          ),
          const Divider(),
          Expanded(
            child: shown.isEmpty
                ? Center(
                    child: Text(
                      provider.error != null
                          ? '商品加载失败：${provider.error}'
                          : provider.isLoading
                              ? '加载中…'
                              : '无匹配商品',
                    ),
                  )
                : ListView.builder(
                    itemCount: shown.length,
                    itemBuilder: (context, index) {
                      final p = shown[index];
                      return ListTile(
                        title: Text('[库存] ${p.name}'),
                        subtitle: Text(
                          '${p.category.isEmpty ? '—' : p.category} · 库存 ${p.stockText}',
                        ),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => Navigator.pop(context, p),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
