import '../mobile/widgets/mobile_page.dart';
import '../mobile/widgets/parts.dart';
import '../mobile/mobile_style.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../providers/product_provider.dart';
import '../services/api_service.dart';
import '../models/product.dart';

class OutboundScreen extends StatefulWidget {
  const OutboundScreen({super.key});

  @override
  State<OutboundScreen> createState() => _OutboundScreenState();
}

class _OutboundScreenState extends State<OutboundScreen> {
  final _formKey = GlobalKey<FormState>();
  String _date = DateFormat('yyyy-MM-dd').format(DateTime.now());
  String _customer = '';
  final List<_OutboundRow> _rows = [_OutboundRow()];
  bool _isLoading = false;

  // 结算口径与网页端一致：先「预览结算」拿 FIFO 成本 / 快递费 / 预警，再提交
  String _payStatus = 'paid';
  String _adjust = '';
  String _remark = '';
  bool _autoExpress = true;
  List<String> _settleCats = [];
  Map<String, dynamic>? _preview;
  bool _previewing = false;

  final _currencyFormat = NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);

  @override
  Widget build(BuildContext context) {
    return MobilePage(
      title: '出库',
      tabIndex: 1,
      body: SingleChildScrollView(
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
                        '快捷出库 / 销售',
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
                              label: '客户',
                              child: CellInput(
                                hint: '客户名称',
                                onChanged: (v) => _customer = v,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      FormCell(
                        label: '备注 / 附件说明',
                        child: CellInput(
                          hint: '本单补充说明',
                          onChanged: (v) => _remark = v,
                        ),
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
                                          : '[${row.product!.productType == 'order' ? '订单' : '库存'}] ${row.product!.name}',
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
                                  label: '售价',
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
                        onPressed: () => setState(() => _rows.add(_OutboundRow())),
                        icon: const Icon(Icons.add),
                        label: const Text('加一行'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFF1989FA),
                        ),
                      ),
                      const SizedBox(height: 16),
                      _buildSettlePanel(),
                      if (_preview != null) _buildPreviewCard(),
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
                              : const Text('确认出库', style: TextStyle(fontSize: 16)),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
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
        _rows[rowIndex].unit = product.productType == 'order' ? '单' : (product.defaultUnit ?? product.baseUnit);
        
        // 自动带出价格
        final factor = product.conversions?[product.defaultUnit ?? product.baseUnit] ?? 1;
        double price = 0;
        if (product.salePrice > 0) {
          price = product.salePrice * factor;
        } else if (product.avgCost > 0) {
          price = product.avgCost * factor;
        }
        _rows[rowIndex].price = price.toStringAsFixed(2);
      });
    }
  }

  // ---------------- 结算 ----------------

  /// 实收口径（settle_cats）：客户随货款一起付回来的关联结算类别；
  /// 后端把 物料/人工/快递 归一，勾上的类别算作实收、不摊进毛利。
  static const List<MapEntry<String, String>> _settleOpts = [
    MapEntry('material', '物料'),
    MapEntry('labor', '人工'),
    MapEntry('express', '快递'),
  ];

  Widget _buildSettlePanel() {
    return GCard(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('结算',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            const SizedBox(height: 12),
            RadioGroup<String>(
              groupValue: _payStatus,
              onChanged: (v) => setState(() => _payStatus = v ?? 'paid'),
              child: const Row(
                children: [
                  Text('付款状态'),
                  SizedBox(width: 8),
                  Radio<String>(value: 'paid'),
                  Text('已付款'),
                  Radio<String>(value: 'unpaid'),
                  Text('待付款'),
                ],
              ),
            ),
            if (_payStatus == 'unpaid')
              Text('待付款的整单先进「待付款」账单，标记已付后才计入财务报表',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
            TextField(
              decoration: const InputDecoration(
                labelText: '抹零 / 凑整（可负数）',
                helperText: '差额会自动记一笔「金额调整」其他开支',
              ),
              keyboardType: const TextInputType.numberWithOptions(signed: true, decimal: true),
              onChanged: (v) => setState(() => _preview = null),
              onSubmitted: (v) => _adjust = v,
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('按整单毛重自动计快递费'),
              value: _autoExpress,
              onChanged: (v) => setState(() {
                _autoExpress = v;
                _preview = null;
              }),
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: _settleOpts.map((o) => FilterChip(
                label: Text('实收含：${o.value}'),
                selected: _settleCats.contains(o.key),
                onSelected: (v) => setState(() {
                  _preview = null;
                  _settleCats = v
                      ? [..._settleCats, o.key]
                      : _settleCats.where((e) => e != o.key).toList();
                }),
              )).toList(),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _previewing || _isLoading ? null : _previewSettle,
              icon: const Icon(Icons.calculate_outlined),
              label: Text(_previewing ? '结算中…' : '预览结算'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPreviewCard() {
    final p = _preview!;
    final warnings = (p['warnings'] as List?) ?? const [];
    final packLines = (p['pack_lines'] as List?) ?? const [];
    final total = (p['total_amount'] as num?)?.toDouble() ?? 0;
    final cogs = (p['total_cogs'] as num?)?.toDouble() ?? 0;
    final fee = (p['total_fee'] as num?)?.toDouble() ?? 0;
    final settle = (p['settle_income'] as num?)?.toDouble() ?? 0;
    final gross = (p['gross_profit'] as num?)?.toDouble() ?? 0;
    final net = (p['net_profit'] as num?)?.toDouble() ?? 0;
    final adjust = double.tryParse(_adjust) ?? 0;
    return GCard(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text('结算预览',
                    style: TextStyle(fontWeight: FontWeight.bold)),
                const Spacer(),
                TextButton(
                  onPressed: () => setState(() => _preview = null),
                  child: const Text('清除'),
                ),
              ],
            ),
            _line('销售额', total),
            _line('销售成本（FIFO）', cogs),
            if (fee > 0) _line('包材/人工等费用', fee),
            if (settle > 0) _line('实收关联结算', settle),
            if (adjust != 0) _line('抹零/凑整', adjust),
            _line('毛利', gross, bold: true),
            _line('净利', net, bold: true),
            const Divider(),
            _line('本单实收', total + adjust + settle, bold: true),
            if (packLines.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text('关联物品 ${packLines.length} 行',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
              ...packLines.map((pl) => Text(
                '  ${pl['product_name']} ${pl['quantity'] ?? ''}${pl['unit'] ?? ''}'
                ' 成本 ${_currencyFormat.format((pl['cogs'] as num?)?.toDouble() ?? 0)}',
                style: const TextStyle(fontSize: 12),
              ))
            ],
            if (warnings.isNotEmpty) ...[
              const SizedBox(height: 6),
              ...warnings.map((w) => Text('⚠ $w',
                  style: const TextStyle(fontSize: 12, color: Colors.orange))),
              Text('库存不足也可继续出库（出库后留负库存），可先补货或再盘点',
                  style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _line(String label, double value, {bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(
            child: Text(label,
                style: TextStyle(fontSize: 13, fontWeight: bold ? FontWeight.bold : FontWeight.normal)),
          ),
          Text(_currencyFormat.format(value),
              style: TextStyle(
                fontSize: 13,
                fontWeight: bold ? FontWeight.bold : FontWeight.normal,
              )),
        ],
      ),
    );
  }

  List<Map<String, dynamic>> _saleLines() {
    return _rows.where((r) => r.product != null).map((r) {
      return <String, dynamic>{
        'product_id': r.product!.id,
        'unit': r.unit ?? r.product!.defaultUnit ?? r.product!.baseUnit,
        'quantity': double.tryParse(r.quantity ?? '0') ?? 0,
        'price': double.tryParse(r.price ?? '0') ?? 0,
      };
    }).toList();
  }

  Future<void> _previewSettle() async {
    final lines = _saleLines();
    if (lines.isEmpty) {
      _toast('请至少添加一行销售商品', error: true);
      return;
    }
    setState(() => _previewing = true);
    try {
      final data = await ApiService.previewOutbound(
        lines: lines,
        autoExpress: _autoExpress,
        settleCats: _settleCats.isEmpty ? null : _settleCats,
      );
      if (mounted) setState(() => _preview = data);
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } finally {
      if (mounted) setState(() => _previewing = false);
    }
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Colors.red.shade600 : null,
    ));
  }

  Future<void> _submit() async {
    final lines = _saleLines();
    if (lines.isEmpty) {
      _toast('请至少添加一行销售商品', error: true);
      return;
    }
    if (_preview == null) {
      _toast('请先点「预览结算」，确认成本与快递费后再出库', error: true);
      return;
    }
    setState(() => _isLoading = true);
    try {
      final adjust = double.tryParse(_adjust) ?? 0;
      final result = await ApiService.createOutbound({
        'customer': _customer,
        'date': _date,
        'remark': _remark,
        'lines': lines,
        'pack_lines': _submitPackLines(_preview!),
        'auto_express': _autoExpress,
        'pay_status': _payStatus,
        'adjust_amount': adjust,
        'settle_cats': _settleCats,
      });
      final order = (result['order'] as Map?) ?? {};
      final warns = (result['warnings'] as List?) ?? const [];
      final finalAmount = (order['final_amount'] as num?)?.toDouble() ?? 0;
      final settle = (order['settle_income'] as num?)?.toDouble() ?? 0;
      _toast('出库成功：实收 ${_currencyFormat.format(finalAmount)}'
          '${adjust != 0 ? '（调整 ${adjust > 0 ? '+' : ''}${adjust.toStringAsFixed(2)}，已记其他开支）' : ''}'
          '${settle > 0 ? '（实收含关联结算 ${_currencyFormat.format(settle)}）' : ''}'
          '${_payStatus == 'unpaid' ? '（待付款，已进待付款账单）' : ''}'
          '${warns.isNotEmpty ? ' ⚠ ${warns.join('；')}' : ''}');
      _resetForm();
    } on ApiException catch (e) {
      _toast('出库失败：${e.message}', error: true);
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  /// 自动算出来的快递费行不提交：后端会按整单毛重再算一次，交上去会重复计费。
  List<Map<String, dynamic>> _submitPackLines(Map<String, dynamic> preview) {
    final out = <Map<String, dynamic>>[];
    for (final pl in (preview['pack_lines'] as List?) ?? const []) {
      if (pl is! Map) continue;
      final qty = (pl['quantity'] as num?)?.toDouble() ?? 0;
      if (qty <= 0) continue;
      final manual = pl['manual'] == true;
      // 非手选的快递类行就是 auto_express 生成的，跳过
      if (!manual && (pl['product_name'] ?? '').toString().contains('快递')) continue;
      out.add({
        'product_id': pl['product_id'],
        'unit': pl['unit'],
        'quantity': qty,
      });
    }
    return out;
  }

  void _resetForm() {
    setState(() {
      _rows
        ..clear()
        ..add(_OutboundRow());
      _customer = '';
      _remark = '';
      _adjust = '';
      _payStatus = 'paid';
      _autoExpress = true;
      _settleCats = [];
      _preview = null;
    });
  }
}
class _OutboundRow {
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
  String _filterType = '';
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
      if (_filterType.isNotEmpty && p.productType != _filterType) return false;
      if (_filterCategory.isNotEmpty && p.category != _filterCategory) return false;
      return true;
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ProductProvider>();
    final source = provider.getSaleProducts();
    final shown = _visible(source);
    final categories = source.map((p) => p.category).where((c) => c.isNotEmpty).toSet();
    return MobilePage(
      title: '选择销售商品',
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
                _filterChip('全部', ''),
                _filterChip('订单', 'order'),
                _filterChip('库存', 'stock'),
                const SizedBox(width: 8),
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
                        title: Text(
                          '[${p.productType == 'order' ? '订单' : '库存'}] ${p.name}',
                        ),
                        subtitle: Text(
                          '${p.category.isEmpty ? '—' : p.category} · 单位 ${p.defaultUnit ?? p.baseUnit} · 库存 ${p.stock}',
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

  Widget _filterChip(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: FilterChip(
        label: Text(label),
        selected: _filterType == value,
        onSelected: (selected) {
          setState(() => _filterType = selected ? value : '');
        },
      ),
    );
  }
}
