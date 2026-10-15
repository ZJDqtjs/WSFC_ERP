import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../services/api_service.dart';

/// 「财务流水」页：收入 / 支出统一视图。
///
/// 口径（/api/finance）：
/// - ref_type == 'manual' 才是手动记账，可以在本页删除；入库 / 出库等单据自动生成的流水
///   后端会拒绝删除（400「该记录由入库/出库自动生成，请在对应单据中删除」），
///   所以这些行禁用删除、并标出来源；
/// - wh = 'all' 合并各分仓流水，每行多一个 warehouse（分仓名）字段；
/// - 接口只返回明细，收入 / 支出合计在前端按 type 累加。
class FinanceScreen extends StatefulWidget {
  const FinanceScreen({super.key});

  @override
  State<FinanceScreen> createState() => _FinanceScreenState();
}

/// 统计区间的预设口径
enum _RangePreset { month, last30, custom }

// ---------------- 文件内共用工具（格式化 + 宽松取值） ----------------

final NumberFormat _moneyFmt =
    NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);
final DateFormat _dayFmt = DateFormat('yyyy-MM-dd');
final RegExp _dayRe = RegExp(r'^\d{4}-\d{2}-\d{2}$');

const Color _incomeColor = Color(0xFF07C160);
const Color _expenseColor = Color(0xFFFA541C);

/// 手动记账常用类别（留空时后端按类型给默认值，这里只是快捷入口）
const List<String> _categoryPresets = [
  '销售收入',
  '退款',
  '其他收入',
  '采购支出',
  '运费',
  '装卸费',
  '水电费',
  '办公用品',
  '其他支出',
];

double _asDouble(dynamic value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '') ?? 0;
}

int _asInt(dynamic value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

String _asString(dynamic value) => value?.toString() ?? '';

String _joinLine(List<String> parts) =>
    parts.where((p) => p.isNotEmpty).join(' · ');

/// 数量类文本：整数不留小数，其余保留两位
String _numText(double value) {
  if (value % 1 == 0) return value.toStringAsFixed(0);
  return value.toStringAsFixed(2);
}

/// ref_type → 人类可读来源
String _sourceLabel(String refType) {
  if (refType.isEmpty) return '历史流水';
  const labels = {
    'manual': '手动记账',
    'finance': '手动记账',
    'inbound': '入库单',
    'outbound': '出库单',
    'warehouse_in': '入仓单',
    'otherexp': '其他开支',
    'adjust': '盘点调整',
  };
  return labels[refType] ?? refType;
}

class _FinanceScreenState extends State<FinanceScreen> {
  _RangePreset _preset = _RangePreset.month;
  String _dateFrom = '';
  String _dateTo = '';
  bool _allWh = false; // false = 仅本仓库（wh 不传），true = 全部仓库（wh=all）

  List<dynamic> _rows = [];
  Map<String, dynamic> _workload = {};
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _dateFrom = _dayFmt.format(DateTime(now.year, now.month));
    _dateTo = _dayFmt.format(now);
    _load();
  }

  // ---------------- 数据 ----------------

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final rows = await ApiService.finance(
          dateFrom: _dateFrom, dateTo: _dateTo, wh: _allWh ? 'all' : '');
      // 接口按 id 倒序；全仓合并后统一按日期倒序、同日按 id 倒序
      rows.sort((a, b) {
        final left = _asString(a['date']);
        final right = _asString(b['date']);
        if (left != right) return right.compareTo(left);
        return _asInt(b['id']).compareTo(_asInt(a['id']));
      });
      if (!mounted) return;
      setState(() => _rows = rows);
    } on ApiException catch (e) {
      _showError(e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
    _loadWorkload();
  }

  /// 工作量卡片是附加信息：全仓视图下后端只算本仓，直接隐藏；取不到就不显示
  Future<void> _loadWorkload() async {
    if (_allWh) {
      if (mounted) setState(() => _workload = {});
      return;
    }
    try {
      final data = await ApiService.workload(dateFrom: _dateFrom, dateTo: _dateTo);
      if (!mounted) return;
      setState(() => _workload = data);
    } catch (_) {
      if (!mounted) return;
      setState(() => _workload = {});
    }
  }

  double _sumByType(String type) {
    double total = 0;
    for (final row in _rows) {
      if (_asString(row['type']) == type) total += _asDouble(row['amount']);
    }
    return total;
  }

  int _countByType(String type) {
    int count = 0;
    for (final row in _rows) {
      if (_asString(row['type']) == type) count += 1;
    }
    return count;
  }

  String get _rangeLabel {
    final from = _dateFrom;
    final to = _dateTo;
    return '$from ~ $to';
  }

  // ---------------- 交互 ----------------

  void _applyPreset(_RangePreset preset) {
    final now = DateTime.now();
    String from = _dateFrom;
    String to = _dateTo;
    if (preset == _RangePreset.month) {
      from = _dayFmt.format(DateTime(now.year, now.month));
      to = _dayFmt.format(now);
    } else if (preset == _RangePreset.last30) {
      from = _dayFmt.format(now.subtract(const Duration(days: 29)));
      to = _dayFmt.format(now);
    }
    setState(() {
      _preset = preset;
      _dateFrom = from;
      _dateTo = to;
    });
    _load();
  }

  Future<void> _pickCustomRange() async {
    final now = DateTime.now();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: DateTime(now.year + 2, 12, 31),
      initialDateRange: DateTimeRange(
        start: DateTime.tryParse(_dateFrom) ?? now,
        end: DateTime.tryParse(_dateTo) ?? now,
      ),
    );
    if (picked == null || !mounted) return;
    setState(() {
      _preset = _RangePreset.custom;
      _dateFrom = _dayFmt.format(picked.start);
      _dateTo = _dayFmt.format(picked.end);
    });
    _load();
  }

  void _setWh(bool all) {
    if (_allWh == all) return;
    setState(() => _allWh = all);
    _load();
  }

  Future<void> _openEditor() async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (sheetContext) => const _FinanceEditor(),
    );
    if (saved == true) {
      _showToast('已记一笔');
      await _load();
    }
  }

  Future<void> _showDetail(dynamic row) async {
    final income = _asString(row['type']) == 'income';
    final refType = _asString(row['ref_type']);
    final manual = refType == 'manual';
    final warehouse = _asString(row['warehouse']);
    final product = _asString(row['product_name']);
    final result = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(income ? '收入流水' : '支出流水'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _detailLine('类别', _asString(row['category'])),
            _detailLine('金额', _moneyFmt.format(_asDouble(row['amount']))),
            _detailLine('日期', _asString(row['date'])),
            _detailLine('商品', product),
            _detailLine('经手人', _asString(row['operator'])),
            _detailLine('备注', _asString(row['remark'])),
            _detailLine('收付状态', _payLabel(row)),
            _detailLine('来源', _sourceLabel(refType)),
            _detailLine('分仓', warehouse),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('关闭'),
          ),
          if (manual)
            FilledButton.tonal(
              onPressed: () => Navigator.pop(dialogContext, 'delete'),
              child: const Text('删除'),
            ),
        ],
      ),
    );
    if (result == 'delete') await _confirmDelete(row);
  }

  Widget _detailLine(String label, String value) {
    final shown = value.isEmpty ? '—' : value;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(label,
                style: TextStyle(fontSize: 12, color: Colors.grey[600])),
          ),
          Expanded(
            child: Text(shown, style: const TextStyle(fontSize: 13)),
          ),
        ],
      ),
    );
  }

  /// 删除（带确认）；单据自动生成的流水后端会拒绝，按钮已提前禁用
  Future<void> _confirmDelete(dynamic row) async {
    final date = _asString(row['date']);
    final category = _asString(row['category']);
    final amountText = _moneyFmt.format(_asDouble(row['amount']));
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除这条流水？'),
        content: Text('$date · $category · $amountText\n删除后无法恢复。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ApiService.deleteFinance(_asInt(row['id']));
      _showToast('已删除这条流水');
    } on ApiException catch (e) {
      _showError(e.message);
    }
    await _load();
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  void _showToast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: _incomeColor),
    );
  }

  // ---------------- 构建 ----------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('财务流水'),
        centerTitle: true,
        actions: [
          IconButton(
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openEditor(),
        icon: const Icon(Icons.account_balance_wallet_outlined),
        label: const Text('手动记账'),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(child: _buildRangeBar()),
            SliverToBoxAdapter(child: _buildSummaryCards()),
            SliverToBoxAdapter(child: _buildWorkloadCard()),
            SliverToBoxAdapter(child: _buildListHeader()),
            if (_loading && _rows.isEmpty)
              const SliverFillRemaining(
                hasScrollBody: false,
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_rows.isEmpty)
              SliverFillRemaining(
                hasScrollBody: false,
                child: _buildEmpty(),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.only(bottom: 88),
                sliver: SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) => _buildRow(index),
                    childCount: _rows.length,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildRangeBar() {
    final scopeHint = _allWh ? '已合并各分仓流水' : '只统计当前登录分仓';
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _presetChip('本月', _preset == _RangePreset.month,
                  () => _applyPreset(_RangePreset.month)),
              const SizedBox(width: 6),
              _presetChip('近30天', _preset == _RangePreset.last30,
                  () => _applyPreset(_RangePreset.last30)),
              const SizedBox(width: 6),
              _presetChip('自定义', _preset == _RangePreset.custom,
                  _pickCustomRange),
              const Spacer(),
              Text(_rangeLabel,
                  style: TextStyle(fontSize: 11, color: Colors.grey[600])),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              _presetChip('仅本仓库', !_allWh, () => _setWh(false)),
              const SizedBox(width: 6),
              _presetChip('全部仓库', _allWh, () => _setWh(true)),
              const Spacer(),
              Text(scopeHint,
                  style: TextStyle(fontSize: 11, color: Colors.grey[600])),
            ],
          ),
        ],
      ),
    );
  }

  Widget _presetChip(String label, bool selected, VoidCallback onTap) {
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onTap(),
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );
  }

  Widget _buildSummaryCards() {
    final income = _sumByType('income');
    final expense = _sumByType('expense');
    final incomeCount = _countByType('income');
    final expenseCount = _countByType('expense');
    final net = income - expense;
    final netText = _moneyFmt.format(net);
    final incomeSub = '$incomeCount 笔';
    final expenseSub = '$expenseCount 笔';
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Column(
        children: [
          Row(
            children: [
              _summaryCard('收入合计', income, incomeSub, _incomeColor),
              const SizedBox(width: 8),
              _summaryCard('支出合计', expense, expenseSub, _expenseColor),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text('净收支 ',
                  style: TextStyle(fontSize: 12, color: Colors.grey[600])),
              Text(netText,
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.bold,
                      color: net >= 0 ? _incomeColor : _expenseColor)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _summaryCard(String title, double amount, String sub, Color color) {
    return Expanded(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: TextStyle(fontSize: 12, color: Colors.grey[600])),
              const SizedBox(height: 4),
              Text(
                _moneyFmt.format(amount),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: 17, fontWeight: FontWeight.bold, color: color),
              ),
              const SizedBox(height: 2),
              Text(sub, style: TextStyle(fontSize: 11, color: Colors.grey[600])),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildWorkloadCard() {
    final data = _workload;
    if (data.isEmpty) return const SizedBox.shrink();
    final workload = _asDouble(data['total_workload']);
    final cost = _asDouble(data['total_cost']);
    if (workload == 0 && cost == 0) return const SizedBox.shrink();
    final workloadText = _numText(workload);
    final costText = _moneyFmt.format(cost);
    final products = _asList(data['by_product']);
    final productText = products.isEmpty
        ? ''
        : '涉及 ${products.length} 个人工 / 快递商品';
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        child: Row(
          children: [
            const Icon(Icons.groups_outlined, color: Color(0xFF1989FA)),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('人工 / 快递工作量（本仓）',
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  Text('总量 $workloadText · 成本 $costText',
                      style: TextStyle(fontSize: 12, color: Colors.grey[700])),
                  if (productText.isNotEmpty)
                    Text(productText,
                        style: TextStyle(
                            fontSize: 11, color: Colors.grey[500])),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<dynamic> _asList(dynamic value) =>
      value is List ? value : const <dynamic>[];

  Widget _buildListHeader() {
    final total = _rows.length;
    final scope = _allWh ? '全部仓库' : '仅本仓库';
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 4),
      child: Row(
        children: [
          const Text('流水明细',
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
          const SizedBox(width: 8),
          Expanded(
            child: Text('$scope · 按日期倒序',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: Colors.grey[600])),
          ),
          Text('共 $total 条',
              style: TextStyle(fontSize: 12, color: Colors.grey[600])),
        ],
      ),
    );
  }

  Widget _buildEmpty() {
    final scope = _allWh ? '全部仓库' : '本仓库';
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.swap_vert_outlined, size: 48, color: Colors.grey[400]),
            const SizedBox(height: 12),
            Text(
              '$scope在这个区间没有流水\n点右下角「手动记账」补一笔，或换个区间看看',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: Colors.grey[600]),
            ),
          ],
        ),
      ),
    );
  }

  /// 收付状态文案：收入看「已收 / 未收」，支出看「已付 / 未付」
  String _payLabel(dynamic row) {
    final income = _asString(row['type']) == 'income';
    final unpaid = _asString(row['pay_status']) == 'unpaid';
    if (unpaid) return income ? '未收' : '未付';
    return income ? '已收' : '已付';
  }

  Widget _buildRow(int index) {
    final row = _rows[index];
    final income = _asString(row['type']) == 'income';
    final refType = _asString(row['ref_type']);
    final manual = refType == 'manual';
    final rawCategory = _asString(row['category']);
    final category = rawCategory.isEmpty ? (income ? '收入' : '支出') : rawCategory;
    final amount = _moneyFmt.format(_asDouble(row['amount']));
    final color = income ? _incomeColor : _expenseColor;
    final product = _asString(row['product_name']);
    final warehouse = _asString(row['warehouse']);
    final remark = _asString(row['remark']);
    final sourceName = _sourceLabel(refType);
    final detail = _joinLine([
      _asString(row['date']),
      _asString(row['operator']),
      if (warehouse.isNotEmpty) warehouse,
      if (product.isNotEmpty) product,
    ]);
    final sourceTag = manual ? '手动' : '自动·$sourceName';
    final payTag = _payLabel(row);

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => _showDetail(row),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              CircleAvatar(
                radius: 16,
                backgroundColor: income
                    ? const Color(0xFFEAF7EC)
                    : const Color(0xFFFFEDE6),
                child: Icon(
                  income ? Icons.arrow_upward : Icons.arrow_downward,
                  size: 16,
                  color: color,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(category,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(detail,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, color: Colors.grey[600])),
                    if (remark.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(remark,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style:
                              TextStyle(fontSize: 12, color: Colors.grey[600])),
                    ],
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        _tag(payTag,
                            unpaid: _asString(row['pay_status']) == 'unpaid'),
                        if (!manual) _tag(sourceTag, warn: true),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    income ? '+$amount' : '-$amount',
                    style: TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w700, color: color),
                  ),
                  IconButton(
                    onPressed: manual ? () => _confirmDelete(row) : null,
                    icon: Icon(
                      manual ? Icons.delete_outline : Icons.lock_outline,
                      size: 20,
                      color: manual ? _expenseColor : Colors.grey,
                    ),
                    tooltip: manual
                        ? '删除这条流水'
                        : '由$sourceName生成，请到对应单据里删除',
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _tag(String text, {bool warn = false, bool unpaid = false}) {
    final foreground =
        unpaid ? const Color(0xFFFA8C16) : (warn ? const Color(0xFF1989FA) : const Color(0xFF67C23A));
    final background = unpaid
        ? const Color(0xFFFFF1E6)
        : (warn ? const Color(0xFFEAF7FF) : const Color(0xFFEAF7EC));
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(text, style: TextStyle(fontSize: 10, color: foreground)),
    );
  }
}

/// 手动记账的底部表单；保存成功 pop(true)，由上层刷新列表。
class _FinanceEditor extends StatefulWidget {
  const _FinanceEditor();

  @override
  State<_FinanceEditor> createState() => _FinanceEditorState();
}

class _FinanceEditorState extends State<_FinanceEditor> {
  final TextEditingController _categoryCtl = TextEditingController();
  final TextEditingController _amountCtl = TextEditingController();
  final TextEditingController _remarkCtl = TextEditingController();
  String _type = 'expense';
  String _date = '';
  bool _paid = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _date = _dayFmt.format(DateTime.now());
  }

  @override
  void dispose() {
    _categoryCtl.dispose();
    _amountCtl.dispose();
    _remarkCtl.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime.tryParse(_date) ?? now,
      firstDate: DateTime(2020),
      lastDate: DateTime(now.year + 2, 12, 31),
    );
    if (picked == null || !mounted) return;
    setState(() => _date = _dayFmt.format(picked));
  }

  Future<void> _submit() async {
    final amount = double.tryParse(_amountCtl.text.trim()) ?? 0;
    if (amount <= 0) {
      _showError('金额必须大于 0');
      return;
    }
    if (!_dayRe.hasMatch(_date)) {
      _showError('日期格式应为 YYYY-MM-DD');
      return;
    }
    // 类别留空时后端按类型给默认值（销售收入 / 其他支出），Python 端字段必填，所以这里补上
    var category = _categoryCtl.text.trim();
    if (category.isEmpty) {
      category = _type == 'income' ? '销售收入' : '其他支出';
    }
    final body = <String, dynamic>{
      'type': _type,
      'category': category,
      'amount': amount,
      'date': _date,
      'remark': _remarkCtl.text.trim(),
      'pay_status': _paid ? 'paid' : 'unpaid',
    };

    setState(() => _saving = true);
    try {
      await ApiService.createFinance(body);
      if (!mounted) return;
      Navigator.pop(context, true);
    } on ApiException catch (e) {
      _showError(e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final income = _type == 'income';
    final payLabel = _paid ? (income ? '已收' : '已付') : (income ? '未收' : '未付');
    final typeText = income ? '收入' : '支出';
    final defaultCategory = income ? '销售收入' : '其他支出';
    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('手动记账',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
              const SizedBox(height: 6),
              Text('这笔是$typeText',
                  style: TextStyle(fontSize: 12, color: Colors.grey[600])),
              const SizedBox(height: 12),
              Row(
                children: [
                  ChoiceChip(
                    label: const Text('收入'),
                    selected: income,
                    onSelected: (_) => setState(() => _type = 'income'),
                  ),
                  const SizedBox(width: 8),
                  ChoiceChip(
                    label: const Text('支出'),
                    selected: !income,
                    onSelected: (_) => setState(() => _type = 'expense'),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _categoryCtl,
                textInputAction: TextInputAction.next,
                decoration: InputDecoration(
                  labelText: '类别（留空默认$defaultCategory）',
                  hintText: '销售收入 / 运费 / 水电费…',
                  prefixIcon: const Icon(Icons.label_outline),
                ),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final preset in _categoryPresets)
                    ActionChip(
                      label: Text(preset),
                      visualDensity: VisualDensity.compact,
                      onPressed: () => setState(() {
                        _categoryCtl.text = preset;
                        _categoryCtl.selection = TextSelection.collapsed(
                            offset: preset.length);
                      }),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _amountCtl,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                textInputAction: TextInputAction.done,
                decoration: const InputDecoration(
                  labelText: '金额',
                  hintText: '大于 0',
                  prefixText: '¥ ',
                  prefixIcon: Icon(Icons.paid_outlined),
                ),
              ),
              const SizedBox(height: 12),
              InkWell(
                onTap: _pickDate,
                borderRadius: BorderRadius.circular(8),
                child: InputDecorator(
                  decoration: const InputDecoration(
                    labelText: '日期',
                    prefixIcon: Icon(Icons.calendar_today),
                  ),
                  child: Text(_date, style: const TextStyle(fontSize: 15)),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _remarkCtl,
                maxLines: 2,
                decoration: const InputDecoration(
                  labelText: '备注（选填）',
                  hintText: '比如：客户张三尾款、京东代发运费',
                  prefixIcon: Icon(Icons.notes),
                ),
              ),
              const SizedBox(height: 8),
              SwitchListTile(
                value: _paid,
                onChanged: (v) => setState(() => _paid = v),
                contentPadding: EdgeInsets.zero,
                title: Text(payLabel),
                subtitle: Text(income
                    ? '关掉表示款还没收到，会先进「待收款账单」'
                    : '关掉表示款还没付出，会先进「待付款账单」'),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 46,
                child: FilledButton(
                  onPressed: _saving ? null : _submit,
                  child: _saving
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            valueColor:
                                AlwaysStoppedAnimation<Color>(Colors.white),
                          ),
                        )
                      : const Text('保存'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
