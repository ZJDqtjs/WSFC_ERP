import '../mobile/widgets/mobile_page.dart';
import '../mobile/widgets/parts.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../services/api_service.dart';

/// 库存页：总览 / 流水 / 盘点记录，并提供盘点入口。
///
/// 流水接口返回的是分页对象（{total, rows, truncated…}），不是裸数组：
/// 后端一次取全量后再「合并出库 → 关键字 → 排序 → 切片」，前端必须读 rows。
class StockScreen extends StatefulWidget {
  const StockScreen({super.key});
  @override
  State<StockScreen> createState() => _StockScreenState();
}

class _RangeOption {
  const _RangeOption(this.label, this.value);
  final String label;
  final String value;
}

class _StockScreenState extends State<StockScreen> with SingleTickerProviderStateMixin {
  static const int _pageSize = 100;
  static const List<_RangeOption> _ranges = [
    _RangeOption('今日', '1'),
    _RangeOption('近 7 天', '7'),
    _RangeOption('近 30 天', '30'),
    _RangeOption('全部', ''),
  ];

  late final TabController _tabController;
  final NumberFormat _money = NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);

  List<dynamic> _stock = [];
  bool _stockLoading = false;
  String _stockKeyword = '';

  List<dynamic> _rows = [];
  int _total = 0;
  bool _truncated = false;
  bool _mvLoading = false;
  bool _mergeOut = true;
  String _mvKeyword = '';
  String _range = '7';
  String _sort = 'date';
  String _dir = 'desc';

  List<dynamic> _adjustments = [];
  bool _adjLoading = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _tabController.addListener(() {
      if (!_tabController.indexIsChanging) _loadTab(_tabController.index);
    });
    _loadStock();
    _loadMovements();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  void _loadTab(int index) {
    if (index == 0) {
      _loadStock();
    } else if (index == 1) {
      _loadMovements();
    } else {
      _loadAdjustments();
    }
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Colors.red.shade600 : null,
    ));
  }

  List<String> _dateRange() {
    if (_range.isEmpty) return ['', ''];
    final now = DateTime.now();
    final from = now.subtract(Duration(days: int.parse(_range) - 1));
    final f = DateFormat('yyyy-MM-dd');
    return [f.format(from), f.format(now)];
  }

  Future<void> _loadStock() async {
    setState(() => _stockLoading = true);
    try {
      final data = await ApiService.stockOverview();
      if (mounted) setState(() => _stock = data);
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } finally {
      if (mounted) setState(() => _stockLoading = false);
    }
  }

  Future<void> _loadMovements({bool append = false}) async {
    setState(() => _mvLoading = true);
    try {
      final range = _dateRange();
      final data = await ApiService.movements(
        dateFrom: range[0].isEmpty ? null : range[0],
        dateTo: range[1].isEmpty ? null : range[1],
        keyword: _mvKeyword,
        mergeOut: _mergeOut,
        sort: _sort,
        dir: _dir,
        limit: _pageSize,
        offset: append ? _rows.length : 0,
      );
      final rows = (data['rows'] as List?) ?? [];
      if (mounted) {
        setState(() {
          _rows = append ? _rows + rows : rows;
          _total = (data['total'] as num?)?.toInt() ?? _rows.length;
          _truncated = data['truncated'] == true;
        });
      }
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } finally {
      if (mounted) setState(() => _mvLoading = false);
    }
  }

  Future<void> _loadAdjustments() async {
    setState(() => _adjLoading = true);
    try {
      final range = _dateRange();
      final data = await ApiService.adjustments(
        dateFrom: range[0].isEmpty ? null : range[0],
        dateTo: range[1].isEmpty ? null : range[1],
      );
      if (mounted) setState(() => _adjustments = data);
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } finally {
      if (mounted) setState(() => _adjLoading = false);
    }
  }

  List<dynamic> get _filteredStock {
    if (_stockKeyword.isEmpty) return _stock;
    final k = _stockKeyword.toLowerCase();
    return _stock.where((p) =>
        (p['name'] ?? '').toString().toLowerCase().contains(k) ||
        (p['category'] ?? '').toString().toLowerCase().contains(k)).toList();
  }

  // ---------------- 盘点 / 回退 ----------------

  Future<void> _openAdjust([dynamic preset]) async {
    if (_stock.isEmpty) await _loadStock();
    if (!mounted) return;
    final result = await showModalBottomSheet<Map<String, String>>(
      context: context,
      isScrollControlled: true,
      builder: (context) => _AdjustSheet(_stock, preset),
    );
    if (result == null) return;
    try {
      final data = await ApiService.adjust(
        productId: int.parse(result['product_id']!),
        date: result['date']!,
        quantity: result['quantity'] ?? '',
        unit: result['unit'] ?? '',
        avgCostAdj: result['avg_cost_adj'] ?? '',
        unitCostAdj: result['unit_cost_adj'] ?? '',
        remark: result['remark'] ?? '',
      );
      _toast((data['message'] ?? '盘点已记录').toString());
      _loadStock();
      _loadMovements();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Future<void> _revertAdjustment(dynamic group) async {
    final id = (group['id'] as num).toInt();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('回退这次盘点？'),
        content: Text('将删除「${group['product_name']}」在 ${group['date']} 产生的'
            '库存与成本变动，相关流水和台账一并撤销。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('回退')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final data = await ApiService.deleteAdjustment(id);
      _toast((data['message'] ?? '已回退').toString());
      _loadAdjustments();
      _loadStock();
      _loadMovements();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Future<void> _pickSort() async {
    final key = await showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('流水排序'),
        children: [
          _sortItem('date', '按日期'),
          _sortItem('quantity', '按数量'),
          _sortItem('amount', '按金额'),
          _sortItem('product', '按商品'),
        ],
      ),
    );
    if (key == null || key == _sort) return;
    setState(() => _sort = key);
    _loadMovements();
  }

  Widget _sortItem(String value, String label) {
    return SimpleDialogOption(
      onPressed: () => Navigator.pop(context, value),
      child: Text(label),
    );
  }

  String _sortLabel() {
    if (_sort == 'quantity') return '数量';
    if (_sort == 'product') return '商品';
    if (_sort == 'amount') return '金额';
    return '日期';
  }

  @override
  Widget build(BuildContext context) {
    return MobilePage(
      title: '库存',
      tabIndex: 3,
      underBar: GlassSegmentedControl(
        height: 38,
        selectedIndex: _tabController.index,
        onSegmentSelected: (i) => _tabController.animateTo(i),
        segments: const [
          GlassSegment(label: '库存总览'),
          GlassSegment(label: '库存流水'),
          GlassSegment(label: '盘点记录'),
        ],
      ),
      floating: GlassButton(
        icon: const Icon(Icons.edit_note),
        label: '盘点',
        width: 112,
        height: 50,
        onTap: _openAdjust,
      ),
      body: Column(
        children: [
          _buildToolbar(),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildStockOverview(),
                _buildMovements(),
                _buildAdjustments(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 搜索框 + 区间/排序筛选条：总览在前端过滤，流水与盘点都带条件请求后端
  Widget _buildToolbar() {
    final tab = _tabController.index;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Column(
        children: [
          TextField(
            decoration: InputDecoration(
              hintText: tab == 0 ? '搜索商品（本页面过滤）' : '关键字：品名 / 经手人 / 备注',
              prefixIcon: const Icon(Icons.search),
              isDense: true,
              border: const OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(20))),
              contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            ),
            onChanged: tab == 0 ? (v) => setState(() => _stockKeyword = v) : null,
            onSubmitted: (v) {
              setState(() {
                if (tab == 0) {
                  _stockKeyword = v;
                } else {
                  _mvKeyword = v;
                }
              });
              if (tab != 0) _loadTab(tab);
            },
          ),
          if (tab != 0) _buildRangeChips(tab),
        ],
      ),
    );
  }

  Widget _buildRangeChips(int tab) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            ..._ranges.map((o) => Padding(
              padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(
                label: Text(o.label),
                selected: _range == o.value,
                onSelected: (_) {
                  setState(() => _range = o.value);
                  _loadTab(tab);
                },
              ),
            )),
            if (tab == 1) ...[
              FilterChip(
                label: const Text('合并出库'),
                selected: _mergeOut,
                onSelected: (v) {
                  setState(() => _mergeOut = v);
                  _loadMovements();
                },
              ),
              Padding(
                padding: const EdgeInsets.only(left: 6),
                child: ActionChip(
                  label: Text('排序：${_sortLabel()}'),
                  onPressed: _pickSort,
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(left: 6),
                child: ActionChip(
                  label: Text(_dir == 'desc' ? '倒序' : '正序'),
                  onPressed: () {
                    setState(() => _dir = _dir == 'desc' ? 'asc' : 'desc');
                    _loadMovements();
                  },
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildStockOverview() {
    final list = _filteredStock;
    if (_stockLoading && _stock.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (list.isEmpty) return _empty(_stockKeyword.isEmpty ? '暂无库存数据' : '没有匹配的商品', _loadStock);
    return RefreshIndicator(
      onRefresh: _loadStock,
      child: ListView.builder(
        itemCount: list.length,
        itemBuilder: (context, index) {
          final p = list[index];
          final stock = (p['stock'] as num?)?.toDouble() ?? 0;
          final unit = (p['default_unit'] ?? p['base_unit'] ?? '').toString();
          final avg = (p['avg_cost'] as num?)?.toDouble() ?? 0;
          final value = (p['stock_value'] as num?)?.toDouble() ?? 0;
          return GCard(
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: ListTile(
              title: Text((p['name'] ?? '').toString()),
              subtitle: Text('${p['category'] ?? '未分类'} · '
                  '均价 ${_money.format(avg)}/$unit · 价值 ${_money.format(value)}'),
              trailing: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text((p['stock_display'] ?? '${stock.toStringAsFixed(0)} $unit').toString(),
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        color: stock <= 0 ? Colors.red : Colors.black,
                      )),
                  TextButton(
                    onPressed: () => _openAdjust(p),
                    child: const Text('盘点'),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildMovements() {
    if (_mvLoading && _rows.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_rows.isEmpty) return _empty('该区间内没有库存流水', _loadMovements);
    return RefreshIndicator(
      onRefresh: _loadMovements,
      child: ListView.builder(
        itemCount: _rows.length + 1,
        itemBuilder: (context, index) {
          if (index == _rows.length) return _buildLoadMore();
          final m = _rows[index];
          final qty = (m['quantity_base'] as num?)?.toDouble() ?? 0;
          final positive = qty >= 0;
          final amount = (m['amount'] as num?)?.toDouble();
          final remark = (m['remark'] ?? '').toString();
          final subtitle = [
            (m['date'] ?? '').toString(),
            _moveTypeLabel((m['move_type'] ?? '').toString()),
            (m['unit'] ?? '').toString(),
            (m['operator'] ?? '').toString(),
            if (remark.isNotEmpty) remark,
          ].where((s) => s.isNotEmpty).join(' · ');
          return GCard(
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
            child: ListTile(
              dense: true,
              title: Text((m['product_name'] ?? '').toString()),
              subtitle: Text(subtitle),
              trailing: Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text('${positive ? '+' : ''}${_fmtQty(m['quantity_display'] ?? qty)}',
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        color: positive ? const Color(0xFF07C160) : Colors.red,
                      )),
                  if (amount != null)
                    Text(_money.format(amount),
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildLoadMore() {
    final hasMore = _rows.length < _total;
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Center(
        child: Column(
          children: [
            Text('已显示 ${_rows.length} / $_total 条',
                style: TextStyle(color: Colors.grey.shade600)),
            if (_truncated)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 4),
                child: Text('数据量较大，后端只返回了一部分，请缩小日期范围',
                    style: TextStyle(color: Colors.orange, fontSize: 12)),
              ),
            if (hasMore)
              TextButton(
                onPressed: _mvLoading ? null : () => _loadMovements(append: true),
                child: const Text('加载更多'),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildAdjustments() {
    if (_adjLoading && _adjustments.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_adjustments.isEmpty) return _empty('该区间内没有盘点记录', _loadAdjustments);
    return RefreshIndicator(
      onRefresh: _loadAdjustments,
      child: ListView.builder(
        itemCount: _adjustments.length,
        itemBuilder: (context, index) {
          final g = _adjustments[index];
          final qty = (g['quantity'] as num?)?.toDouble() ?? 0;
          final avg = (g['avg_cost_delta'] as num?)?.toDouble() ?? 0;
          final ucost = (g['unit_cost_delta'] as num?)?.toDouble() ?? 0;
          return GCard(
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: ListTile(
              title: Text((g['product_name'] ?? '').toString()),
              subtitle: Text('${g['date']} · ${g['operator'] ?? ''}'
                  ' · 库存 ${qty > 0 ? '+' : ''}${_fmtQty(g['quantity'])}${g['unit'] ?? ''}'
                  ' · 均价 ${avg > 0 ? '+' : ''}${avg.toStringAsFixed(2)}'
                  ' · 成本 ${ucost > 0 ? '+' : ''}${ucost.toStringAsFixed(2)}'),
              trailing: TextButton(
                onPressed: () => _revertAdjustment(g),
                child: const Text('回退'),
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _empty(String text, Future<void> Function() refresh) {
    return RefreshIndicator(
      onRefresh: refresh,
      child: ListView(
        children: [
          const SizedBox(height: 120),
          Center(child: Text(text, style: TextStyle(color: Colors.grey.shade600))),
        ],
      ),
    );
  }

  String _fmtQty(dynamic v) {
    if (v == null) return '0';
    if (v is! num) return v.toString();
    if (v == v.roundToDouble()) return v.toInt().toString();
    return v.toStringAsFixed(2);
  }

  /// move_type 的中文映射（与后端流水类型同名，见 go/internal/erp 与 backend/app/models.py）
  String _moveTypeLabel(String t) {
    switch (t) {
      case 'in':
        return '入库';
      case 'out':
        return '出库';
      case 'adjust':
        return '盘点';
      case 'cost':
        return '成本重估';
      case 'avg':
        return '均价调整';
      case 'ucost':
        return '成本单价';
      case 'work':
        return '工作量';
      case 'pack':
        return '打包';
      default:
        return t.isEmpty ? '其他' : t;
    }
  }
}

/// 盘点表单：数量 / 均价 / 成本单价都是「相对值」，必须以 + 或 - 开头，留空表示不动这一项。
/// 该约束来自后端（填裸数字会被 400 拒绝），文案与网页端一致。
class _AdjustSheet extends StatefulWidget {
  const _AdjustSheet(this.stock, [this.preset]);

  final List<dynamic> stock;
  final dynamic preset;

  @override
  State<_AdjustSheet> createState() => _AdjustSheetState();
}

class _AdjustSheetState extends State<_AdjustSheet> {
  final _qty = TextEditingController();
  final _avg = TextEditingController();
  final _ucost = TextEditingController();
  final _remark = TextEditingController();
  int? _productId;
  String _unit = '';
  late String _date = DateFormat('yyyy-MM-dd').format(DateTime.now());

  @override
  void initState() {
    super.initState();
    final p = widget.preset;
    if (p != null) {
      _productId = (p['id'] as num?)?.toInt();
      _unit = (p['default_unit'] ?? p['base_unit'] ?? '').toString();
    }
  }

  @override
  void dispose() {
    _qty.dispose();
    _avg.dispose();
    _ucost.dispose();
    _remark.dispose();
    super.dispose();
  }

  dynamic get _product {
    if (_productId == null) return null;
    for (final e in widget.stock) {
      if ((e['id'] as num?)?.toInt() == _productId) return e;
    }
    return null;
  }

  List<String> get _units {
    final p = _product;
    if (p == null) return _unit.isEmpty ? [] : [_unit];
    final set = <String>{
      (p['base_unit'] ?? '').toString(),
      (p['default_unit'] ?? '').toString(),
    };
    final conv = p['conversions'];
    if (conv is Map) {
      for (final k in conv.keys) {
        set.add(k.toString());
      }
    }
    set.remove('');
    return set.toList();
  }

  @override
  Widget build(BuildContext context) {
    final p = _product;
    final units = _units;
    if (_unit.isNotEmpty && !units.contains(_unit)) units.insert(0, _unit);
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('库存盘点',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text('数量、均价、成本单价都填增减值（如 +2.5 / -1；正数会自动补 +），全部留空则不做调整',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _pickProduct,
              icon: const Icon(Icons.inventory_2_outlined, size: 18),
              label: Text(p == null
                  ? '选择商品'
                  : '${p['name']}（现库存 ${p['stock_display'] ?? ''}）'),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(child: _field(_qty, '数量增减', '如 +2.5 / -1')),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: units.contains(_unit) ? _unit : (units.isEmpty ? null : units.first),
                    decoration: const InputDecoration(labelText: '单位', border: OutlineInputBorder()),
                    items: units
                        .map((u) => DropdownMenuItem<String>(value: u, child: Text(u)))
                        .toList(),
                    onChanged: (v) => setState(() => _unit = v ?? ''),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(child: _field(_avg, '均价增减', '元/基础单位')),
                const SizedBox(width: 8),
                Expanded(child: _field(_ucost, '成本单价增减', '元/单位')),
              ],
            ),
            const SizedBox(height: 12),
            _field(_remark, '备注', '为什么盘点'),
            const SizedBox(height: 4),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('盘点日期'),
              trailing: Text(_date),
              onTap: () async {
                final picked = await showDatePicker(
                  context: context,
                  initialDate: DateTime.tryParse(_date) ?? DateTime.now(),
                  firstDate: DateTime(2020),
                  lastDate: DateTime.now().add(const Duration(days: 1)),
                );
                if (picked != null) {
                  setState(() => _date = DateFormat('yyyy-MM-dd').format(picked));
                }
              },
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _submit,
              child: const Text('提交盘点'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _field(TextEditingController controller, String label, String hint) {
    return TextField(
      controller: controller,
      keyboardType: TextInputType.text,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        isDense: true,
        border: const OutlineInputBorder(),
      ),
    );
  }

  Future<void> _pickProduct() async {
    final picked = await showModalBottomSheet<dynamic>(
      context: context,
      isScrollControlled: true,
      builder: (context) => _StockPicker(widget.stock),
    );
    if (picked == null || !mounted) return;
    setState(() {
      _productId = (picked['id'] as num).toInt();
      _unit = (picked['default_unit'] ?? picked['base_unit'] ?? '').toString();
    });
  }

  /// 后端要求增减值必须带符号（+2 / -1），裸数字会被 400 挡下；
  /// 手机数字键盘不方便打「+」，正数这里替用户补上（0 和非法输入原样交给后端报错）。
  String _signed(String raw) {
    final s = raw.trim();
    if (s.isEmpty || s.startsWith('+') || s.startsWith('-')) return s;
    final v = double.tryParse(s);
    if (v == null || v == 0) return s;
    return '+$s';
  }

  void _submit() {
    if (_productId == null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请先选择商品')));
      return;
    }
    Navigator.pop(context, <String, String>{
      'product_id': '$_productId',
      'date': _date,
      'quantity': _signed(_qty.text),
      'unit': _unit,
      'avg_cost_adj': _signed(_avg.text),
      'unit_cost_adj': _signed(_ucost.text),
      'remark': _remark.text.trim(),
    });
  }
}

/// 商品选择弹层：库存总览行数有限（几十到几百），一次拉取后本地过滤。
class _StockPicker extends StatefulWidget {
  const _StockPicker(this.stock);

  final List<dynamic> stock;

  @override
  State<_StockPicker> createState() => _StockPickerState();
}

class _StockPickerState extends State<_StockPicker> {
  String _keyword = '';

  @override
  Widget build(BuildContext context) {
    final k = _keyword.toLowerCase();
    final list = _keyword.isEmpty
        ? widget.stock
        : widget.stock.where((e) =>
            (e['name'] ?? '').toString().toLowerCase().contains(k) ||
            (e['category'] ?? '').toString().toLowerCase().contains(k)).toList();
    return Padding(
      padding: EdgeInsets.only(top: 8, bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('选择商品',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextField(
              autofocus: true,
              decoration: const InputDecoration(
                hintText: '搜索商品',
                prefixIcon: Icon(Icons.search),
                isDense: true,
              ),
              onChanged: (v) => setState(() => _keyword = v),
            ),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: list.length,
              itemBuilder: (context, index) {
                final e = list[index];
                return ListTile(
                  title: Text((e['name'] ?? '').toString()),
                  subtitle: Text('${e['category'] ?? ''} · ${e['stock_display'] ?? ''}'),
                  trailing: Text('均价 ${e['avg_cost'] ?? 0}'),
                  onTap: () => Navigator.pop(context, e),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
