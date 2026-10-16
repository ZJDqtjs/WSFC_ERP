import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../services/api_service.dart';

/// 「其他开支」页：登记网线费 / 安装费 / 机器费 / 样品费这一类零散支出。
///
/// 口径（/api/other-expenses）：
/// - 明细里 ref_type 非空 = 这笔由单据自动带出（金额调整 / 入库运费·装卸费 / 出库费用），
///   后端禁止在本页改删（400），所以这类行打「自动」标签并禁用编辑、删除；
/// - 顶部「今日 / 本月」不受区间影响，「区间合计」跟随所选区间；
/// - 统计返回值兼容两种形状：today:{amount,count} 与扁平 today_total / today_count。
class ExpensesScreen extends StatefulWidget {
  const ExpensesScreen({super.key});

  @override
  State<ExpensesScreen> createState() => _ExpensesScreenState();
}

/// 统计区间的预设口径
enum _RangePreset { month, last30, custom }

// ---------------- 文件内共用工具（格式化 + 宽松取值） ----------------

final NumberFormat _moneyFmt =
    NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);
final DateFormat _dayFmt = DateFormat('yyyy-MM-dd');
final RegExp _dayRe = RegExp(r'^\d{4}-\d{2}-\d{2}$');

double _asDouble(dynamic value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '') ?? 0;
}

int _asInt(dynamic value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

String _asString(dynamic value) => value?.toString() ?? '';

/// 备注：后端字段是 remark，接口文档 / 网页端也叫 note，两个键都兼容读。
String _noteOf(dynamic row) {
  final remark = _asString(row['remark']);
  if (remark.isNotEmpty) return remark;
  return _asString(row['note']);
}

List<dynamic> _asList(dynamic value) => value is List ? value : const <dynamic>[];

/// 用「 · 」拼一行说明文本，空片段自动跳过。
String _joinLine(List<String> parts) =>
    parts.where((p) => p.isNotEmpty).join(' · ');

/// ref_type → 人类可读的来源名
String _sourceName(String refType) {
  const labels = {
    'adjust': '金额调整',
    'inbound_fee': '入库运费·装卸费',
    'outbound_fee': '出库费用',
    'inbound': '入库单',
    'outbound': '出库单',
  };
  return labels[refType] ?? refType;
}

class _ExpensesScreenState extends State<ExpensesScreen> {
  _RangePreset _preset = _RangePreset.month;
  String _dateFrom = '';
  String _dateTo = '';
  String _category = ''; // 明细的类型过滤，'' = 全部

  List<dynamic> _items = [];
  Map<String, dynamic> _stats = {};
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
      final results = await Future.wait<Object?>([
        ApiService.otherExpenses(
            dateFrom: _dateFrom, dateTo: _dateTo, category: _category),
        ApiService.otherExpenseStats(dateFrom: _dateFrom, dateTo: _dateTo),
      ]);
      if (!mounted) return;
      setState(() {
        _items = results[0] as List<dynamic>;
        _stats = Map<String, dynamic>.from(results[1] as Map);
      });
    } on ApiException catch (e) {
      _showError(e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 统计卡取数：兼容 today:{amount,count} 与扁平 today_total / today_count 两种形状
  double _statAmount(String nodeKey, String flatKey) {
    final node = _stats[nodeKey];
    if (node is Map) return _asDouble(node['amount']);
    return _asDouble(_stats[flatKey]);
  }

  int _statCount(String nodeKey, String flatKey) {
    final node = _stats[nodeKey];
    if (node is Map) return _asInt(node['count']);
    return _asInt(_stats[flatKey]);
  }

  /// 今日 / 本月笔数：后端没给 *_count 时退一步从 by_day、by_month 里捞（这两项含 count）
  int _todayCount() {
    final direct = _statCount('today', 'today_count');
    if (direct > 0) return direct;
    final today = _dayFmt.format(DateTime.now());
    for (final row in _asList(_stats['by_day'])) {
      if (_asString(row['date']) == today) return _asInt(row['count']);
    }
    return 0;
  }

  int _monthCount() {
    final direct = _statCount('month', 'month_count');
    if (direct > 0) return direct;
    final month = _dayFmt.format(DateTime.now()).substring(0, 7);
    for (final row in _asList(_stats['by_month'])) {
      if (_asString(row['month']) == month) return _asInt(row['count']);
    }
    return 0;
  }

  int _rangeCount() => _statCount('range', 'range_count');

  int _statDays() {
    final node = _stats['range'];
    if (node is Map) return _asInt(node['days']);
    return _asInt(_stats['range_days']);
  }

  List<dynamic> get _byCategory => _asList(_stats['by_category']);

  /// 过滤 chips = 后端 presets（预设类型 + 用过的自定义类型）+ 当前区间出现过的类型
  List<String> get _categoryOptions {
    final options = <String>[];
    final presets = _stats['presets'];
    if (presets is List) {
      for (final p in presets) {
        final name = _asString(p);
        if (name.isNotEmpty && !options.contains(name)) options.add(name);
      }
    }
    for (final row in _byCategory) {
      final name = _asString(row['category']);
      if (name.isNotEmpty && !options.contains(name)) options.add(name);
    }
    for (final item in _items) {
      final name = _asString(item['category']);
      if (name.isNotEmpty && !options.contains(name)) options.add(name);
    }
    return options;
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

  void _setCategory(String value) {
    setState(() => _category = value);
    _load();
  }

  /// item 为空 = 新增；否则 = 编辑这条手工开支
  Future<void> _openEditor({dynamic item}) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (sheetContext) =>
          _ExpenseEditor(item: item, presets: _categoryOptions),
    );
    if (saved == true) await _load();
  }

  Future<void> _showLockedHint(String refType) async {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) {
        final source = _sourceName(refType);
        return AlertDialog(
          title: const Text('这笔开支由单据自动带出'),
          content: Text(
              '来源：$source\n金额与日期跟着单据走，要改动请到对应的入库 / 出库 / 盘点单据里操作。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('知道了'),
            ),
          ],
        );
      },
    );
  }

  /// 删除（带确认）。始终返回 false：列表交给 _load() 重建，
  /// 避免「滑动动画已完成、后端却拒绝删除」造成界面与真实数据不一致。
  Future<bool> _confirmDelete(dynamic item) async {
    final category = _asString(item['category']);
    final date = _asString(item['date']);
    final amountText = _moneyFmt.format(_asDouble(item['amount']));
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除这笔开支？'),
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
    if (confirmed != true) return false;
    try {
      await ApiService.deleteOtherExpense(_asInt(item['id']));
      _showToast('已删除这笔开支');
    } on ApiException catch (e) {
      _showError(e.message);
    }
    await _load();
    return false;
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
      SnackBar(content: Text(message), backgroundColor: const Color(0xFF07C160)),
    );
  }

  // ---------------- 构建 ----------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('其他开支'),
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
        icon: const Icon(Icons.add),
        label: const Text('记一笔'),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(child: _buildRangeBar()),
            SliverToBoxAdapter(child: _buildStatCards()),
            SliverToBoxAdapter(child: _buildCategorySummary()),
            SliverToBoxAdapter(child: _buildDetailHeader()),
            SliverToBoxAdapter(child: _buildFilterChips()),
            if (_loading && _items.isEmpty)
              const SliverFillRemaining(
                hasScrollBody: false,
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_items.isEmpty)
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
                    childCount: _items.length,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildRangeBar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Row(
        children: [
          _presetChip('本月', _preset == _RangePreset.month,
              () => _applyPreset(_RangePreset.month)),
          const SizedBox(width: 6),
          _presetChip('近30天', _preset == _RangePreset.last30,
              () => _applyPreset(_RangePreset.last30)),
          const SizedBox(width: 6),
          _presetChip('自定义', _preset == _RangePreset.custom, _pickCustomRange),
          const Spacer(),
          Text(_rangeLabel, style: TextStyle(fontSize: 11, color: Colors.grey[600])),
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

  Widget _buildStatCards() {
    final todayCount = _todayCount();
    final monthCount = _monthCount();
    final rangeCount = _rangeCount();
    final rangeDays = _statDays();
    final dailyAvg = _asDouble(_stats['range_daily_avg']);
    final todaySub = '$todayCount 笔';
    final monthSub = '$monthCount 笔';
    final rangeSub = rangeDays > 0
        ? '$rangeDays 天 · 日均 ${_moneyFmt.format(dailyAvg)}'
        : '$rangeCount 笔';
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Row(
        children: [
          _statCard('今日', _statAmount('today', 'today_total'), todaySub,
              const Color(0xFF1989FA)),
          const SizedBox(width: 8),
          _statCard('本月', _statAmount('month', 'month_total'), monthSub,
              const Color(0xFF07C160)),
          const SizedBox(width: 8),
          _statCard('区间合计', _statAmount('range', 'range_total'), rangeSub,
              const Color(0xFFFA8C16)),
        ],
      ),
    );
  }

  Widget _statCard(String title, double amount, String sub, Color color) {
    return Expanded(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: TextStyle(fontSize: 12, color: Colors.grey[600])),
              const SizedBox(height: 4),
              Text(
                _moneyFmt.format(amount),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style:
                    TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: color),
              ),
              const SizedBox(height: 2),
              Text(sub,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, color: Colors.grey[600])),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildCategorySummary() {
    final rows = _byCategory;
    if (rows.isEmpty) return const SizedBox.shrink();
    double max = 0;
    for (final row in rows) {
      final amount = _asDouble(row['amount']);
      if (amount > max) max = amount;
    }
    final rangeCount = _rangeCount();
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text('按类别汇总',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
                const Spacer(),
                Text('区间 $rangeCount 笔',
                    style: TextStyle(fontSize: 12, color: Colors.grey[600])),
              ],
            ),
            const SizedBox(height: 12),
            for (final row in rows) _categoryBar(row, max),
          ],
        ),
      ),
    );
  }

  Widget _categoryBar(dynamic row, double maxAmount) {
    final raw = _asString(row['category']);
    final name = raw.isEmpty ? '未分类' : raw;
    final amount = _asDouble(row['amount']);
    final count = _asInt(row['count']);
    final ratio = maxAmount <= 0 ? 0.0 : (amount / maxAmount).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13)),
              ),
              Text(_moneyFmt.format(amount),
                  style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFFFA541C))),
              const SizedBox(width: 6),
              Text('$count 笔',
                  style: TextStyle(fontSize: 11, color: Colors.grey[500])),
            ],
          ),
          const SizedBox(height: 5),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: Stack(
              children: [
                Container(height: 6, color: const Color(0xFFF0F2F5)),
                FractionallySizedBox(
                  widthFactor: ratio,
                  child: Container(height: 6, color: const Color(0xFF1989FA)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDetailHeader() {
    final category = _category;
    final total = _items.length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 2),
      child: Row(
        children: [
          const Text('开支明细',
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              category.isEmpty ? '' : '已筛选：$category',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, color: Colors.grey[600]),
            ),
          ),
          Text('共 $total 条',
              style: TextStyle(fontSize: 12, color: Colors.grey[600])),
        ],
      ),
    );
  }

  Widget _buildFilterChips() {
    final options = _categoryOptions;
    if (options.isEmpty) return const SizedBox.shrink();
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          _filterChip('全部', _category.isEmpty, () => _setCategory('')),
          for (final name in options)
            _filterChip(name, _category == name, () => _setCategory(name)),
        ],
      ),
    );
  }

  Widget _filterChip(String label, bool selected, VoidCallback onTap) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(label),
        selected: selected,
        onSelected: (_) => onTap(),
        visualDensity: VisualDensity.compact,
      ),
    );
  }

  Widget _buildEmpty() {
    final category = _category;
    final hint = category.isEmpty
        ? '所选区间没有开支记录\n换个月份，或点右下角「记一笔」'
        : '当前筛选「$category」下没有记录\n可以切回「全部」看看';
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.receipt_long_outlined, size: 48, color: Colors.grey[400]),
            const SizedBox(height: 12),
            Text(hint,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13, color: Colors.grey[600])),
          ],
        ),
      ),
    );
  }

  Widget _buildRow(int index) {
    final item = _items[index];
    final id = _asInt(item['id']);
    final refType = _asString(item['ref_type']);
    final locked = refType.isNotEmpty; // 单据自动带出：本页只读
    final rawCategory = _asString(item['category']);
    final category = rawCategory.isEmpty ? '未分类' : rawCategory;
    final amount = _moneyFmt.format(_asDouble(item['amount']));
    final note = _noteOf(item);
    final unpaid = _asString(item['pay_status']) == 'unpaid';
    final subtitle = _joinLine(
        [_asString(item['date']), _asString(item['operator']), note]);

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Dismissible(
        key: ValueKey<int>(id),
        direction: locked ? DismissDirection.none : DismissDirection.endToStart,
        background: _buildSwipeBackground(),
        confirmDismiss: (_) => _confirmDelete(item),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () {
            if (locked) {
              _showLockedHint(refType);
            } else {
              _openEditor(item: item);
            }
          },
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              category,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  fontSize: 15, fontWeight: FontWeight.w600),
                            ),
                          ),
                          if (locked) const _AutoTag(),
                          if (unpaid) const _UnpaidTag(),
                          const Spacer(),
                          Text('-$amount',
                              style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                  color: Color(0xFFFA541C))),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(subtitle,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: Colors.grey[600])),
                    ],
                  ),
                ),
                const SizedBox(width: 4),
                IconButton(
                  onPressed: locked ? null : () => _confirmDelete(item),
                  icon: Icon(
                    locked ? Icons.lock_outline : Icons.delete_outline,
                    size: 20,
                    color: locked ? Colors.grey : const Color(0xFFFA541C),
                  ),
                  tooltip: locked
                      ? '由${_sourceName(refType)}带出，请到来源单据修改'
                      : '删除这笔开支',
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildSwipeBackground() {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      alignment: Alignment.centerRight,
      padding: const EdgeInsets.only(right: 20),
      decoration: BoxDecoration(
        color: const Color(0xFFFA541C),
        borderRadius: BorderRadius.circular(10),
      ),
      child: const Icon(Icons.delete_outline, color: Colors.white),
    );
  }
}

/// 「自动」标签：这笔开支由单据带出，本页只读
class _AutoTag extends StatelessWidget {
  const _AutoTag();

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: const Color(0xFFEAF7FF),
        borderRadius: BorderRadius.circular(4),
      ),
      child: const Text('自动', style: TextStyle(fontSize: 10, color: Color(0xFF1989FA))),
    );
  }
}

/// 待付款标记（后端 pay_status = unpaid 时先进「待付款账单」）
class _UnpaidTag extends StatelessWidget {
  const _UnpaidTag();

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF1E6),
        borderRadius: BorderRadius.circular(4),
      ),
      child: const Text('待付', style: TextStyle(fontSize: 10, color: Color(0xFFFA8C16))),
    );
  }
}

/// 新增 / 修改开支的底部表单；保存成功 pop(true)，由上层刷新列表。
class _ExpenseEditor extends StatefulWidget {
  const _ExpenseEditor({this.item, required this.presets});

  /// 非空表示编辑已有开支（上层已确保不是自动带出的行）
  final dynamic item;

  /// 可选的费用类型（后端 presets）
  final List<String> presets;

  @override
  State<_ExpenseEditor> createState() => _ExpenseEditorState();
}

class _ExpenseEditorState extends State<_ExpenseEditor> {
  final TextEditingController _categoryCtl = TextEditingController();
  final TextEditingController _amountCtl = TextEditingController();
  final TextEditingController _noteCtl = TextEditingController();
  String _date = '';
  bool _saving = false;

  bool get _isCreate => widget.item == null;

  @override
  void initState() {
    super.initState();
    final today = _dayFmt.format(DateTime.now());
    final item = widget.item;
    if (item == null) {
      _date = today;
    } else {
      _categoryCtl.text = _asString(item['category']);
      _amountCtl.text = _amountText(_asDouble(item['amount']));
      _noteCtl.text = _noteOf(item);
      final raw = _asString(item['date']);
      _date = _dayRe.hasMatch(raw) ? raw : today;
    }
  }

  @override
  void dispose() {
    _categoryCtl.dispose();
    _amountCtl.dispose();
    _noteCtl.dispose();
    super.dispose();
  }

  /// 金额回填：整数不带小数，其余保留两位
  String _amountText(double value) {
    if (value % 1 == 0) return value.toStringAsFixed(0);
    return value.toStringAsFixed(2);
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
    // 本地先按后端同一套校验跑一遍，省一次往返
    final category = _categoryCtl.text.trim();
    if (category.isEmpty) {
      _showError('请填写费用类型（如 网线费 / 安装费 / 机器费 / 样品费）');
      return;
    }
    if (category.length > 32) {
      _showError('费用类型过长（≤32 字）');
      return;
    }
    final amount = double.tryParse(_amountCtl.text.trim()) ?? 0;
    if (amount <= 0) {
      _showError('金额必须大于 0');
      return;
    }
    if (!_dayRe.hasMatch(_date)) {
      _showError('日期格式应为 YYYY-MM-DD');
      return;
    }
    final note = _noteCtl.text.trim();
    final id = _isCreate ? 0 : _asInt(widget.item['id']);
    if (!_isCreate && id <= 0) {
      _showError('缺少记录编号，无法修改');
      return;
    }
    final body = <String, dynamic>{
      'date': _date,
      'category': category,
      'amount': amount,
      // 后端字段名是 remark；note 是同义键，两个一起传，多余键后端会忽略
      'remark': note,
      'note': note,
    };

    setState(() => _saving = true);
    try {
      if (_isCreate) {
        await ApiService.createOtherExpense(body);
      } else {
        await ApiService.updateOtherExpense(id, body);
      }
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
    final title = _isCreate ? '记一笔其他开支' : '修改这笔开支';
    final submitText = _isCreate ? '保存' : '保存修改';
    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
              const SizedBox(height: 14),
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
                controller: _categoryCtl,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(
                  labelText: '费用类型',
                  hintText: '网线费 / 安装费 / 机器费 / 样品费…',
                  prefixIcon: Icon(Icons.label_outline),
                ),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final preset in widget.presets)
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
              TextField(
                controller: _noteCtl,
                maxLines: 2,
                decoration: const InputDecoration(
                  labelText: '备注（选填）',
                  hintText: '比如：3 楼机房拉网线，师傅上门',
                  prefixIcon: Icon(Icons.notes),
                ),
              ),
              const SizedBox(height: 18),
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
                      : Text(submitText),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
