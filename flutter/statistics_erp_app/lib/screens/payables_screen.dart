import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../services/api_service.dart';

/// 待付款账单页。
///
/// 「常规账单」= 后端 /api/payables 聚合出来的入库 / 入仓 / 出库 / 其他开支 / 手动记账
/// 未结清单据，可多选后批量标记「已付款 / 未付款」；
/// 「代发账单」= /api/payables/dropship，按「商品 + 规格 + 出库日期」分行的代发应付，
/// 一行可能对应多张出库单，所以逐条调 /api/payables/pay。
class PayablesScreen extends StatefulWidget {
  const PayablesScreen({super.key});

  @override
  State<PayablesScreen> createState() => _PayablesScreenState();
}

class _PayablesScreenState extends State<PayablesScreen> with SingleTickerProviderStateMixin {
  /// 天数下拉的可选值；后端语义是「只查最近 N 天」（勾了显示已结时按结清日过滤）
  static const List<int> _dayOptions = <int>[7, 15, 30, 90];

  /// kind → 中文名，批量失败时用来提示是哪一类账单出错
  static const Map<String, String> _kindLabels = <String, String>{
    'inbound': '入库单',
    'warehouse_in': '入仓单',
    'outbound': '出库单',
    'otherexp': '其他开支',
    'finance': '手动记账',
    'dropship': '代发',
  };

  /// 代发一次最多取多少组（后端上限 2000，取 300 组够手机端翻）
  static const int _dropshipLimit = 300;

  late TabController _tabController;

  final _currencyFormat = NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);

  // ---------------- 常规账单 ----------------
  List<_PayableItem> _items = <_PayableItem>[];
  _PayableTotal _total = const _PayableTotal();
  bool _isLoading = false;
  bool _isSubmitting = false;
  bool _includePaid = false;
  int _days = 30;

  /// 多选勾选集合，键是 'kind#id'：不同 kind 的 id 会重复，必须带 kind 才唯一
  final Set<String> _selected = <String>{};

  // ---------------- 代发账单 ----------------
  List<_DropshipGroup> _groups = <_DropshipGroup>[];
  _DropshipTotal _dropTotal = const _DropshipTotal();
  bool _isDropLoading = false;
  bool _dropTruncated = false;
  int _dropShown = 0;
  String _dateFrom = '';
  String _dateTo = '';
  final Set<int> _selectedGroups = <int>{};

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _tabController.addListener(_onTabChanged);
    _loadAll();
  }

  @override
  void dispose() {
    _tabController.removeListener(_onTabChanged);
    _tabController.dispose();
    super.dispose();
  }

  /// 切页签时清掉勾选，避免在代发页误用常规账单的批量操作
  void _onTabChanged() {
    if (_selected.isEmpty && _selectedGroups.isEmpty) {
      return;
    }
    setState(() {
      _selected.clear();
      _selectedGroups.clear();
    });
  }

  Future<void> _loadAll() async {
    await Future.wait<void>(<Future<void>>[_loadPayables(), _loadDropship()]);
  }

  Future<void> _loadPayables() async {
    setState(() => _isLoading = true);
    try {
      final Map<String, dynamic> data =
          await ApiService.payables(includePaid: _includePaid, days: _days);
      final List<dynamic> rawItems =
          data['items'] is List ? data['items'] as List<dynamic> : <dynamic>[];
      setState(() {
        _items = rawItems
            .map((dynamic e) => _PayableItem.fromMap(Map<String, dynamic>.from(e as Map)))
            .toList();
        _total = _PayableTotal.fromMap(_asMap(data['total']));
        _selected.clear();
      });
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('待付款账单读取失败：$e');
    } finally {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  Future<void> _loadDropship() async {
    setState(() => _isDropLoading = true);
    try {
      final Map<String, dynamic> data = await ApiService.dropshipBills(
        dateFrom: _dateFrom,
        dateTo: _dateTo,
        includePaid: _includePaid,
        limit: _dropshipLimit,
      );
      final List<dynamic> rawGroups =
          data['groups'] is List ? data['groups'] as List<dynamic> : <dynamic>[];
      final List<_DropshipGroup> groups =
          rawGroups.map((dynamic e) => _DropshipGroup.fromMap(Map<String, dynamic>.from(e as Map))).toList();
      final int shown = _asInt(data['limit']);
      setState(() {
        _groups = groups;
        _dropTotal = _DropshipTotal.fromMap(_asMap(data['total']));
        _dropTruncated = data['truncated'] == true;
        _dropShown = shown > 0 ? shown : groups.length;
        _selectedGroups.clear();
      });
    } on ApiException catch (e) {
      _showError(e.message);
    } catch (e) {
      _showError('代发账单读取失败：$e');
    } finally {
      if (mounted) {
        setState(() => _isDropLoading = false);
      }
    }
  }

  // ---------------- 交互 ----------------

  void _onDaysChanged(int? value) {
    if (value == null || value == _days) {
      return;
    }
    setState(() {
      _days = value;
      _selected.clear();
    });
    _loadPayables();
  }

  void _onIncludePaidChanged(bool value) {
    setState(() {
      _includePaid = value;
      _selected.clear();
      _selectedGroups.clear();
    });
    // 「显示已结」两个页签共用：已结行也能撤销回未结，所以两边都要重新拉
    _loadAll();
  }

  Future<void> _pickDropshipDate(bool isFrom) async {
    final DateTime now = DateTime.now();
    final DateTime initial =
        DateTime.tryParse(isFrom ? _dateFrom : _dateTo) ?? now.subtract(const Duration(days: 30));
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2020),
      lastDate: now,
    );
    if (picked == null || !mounted) {
      return;
    }
    setState(() {
      final String value = DateFormat('yyyy-MM-dd').format(picked);
      if (isFrom) {
        _dateFrom = value;
      } else {
        _dateTo = value;
      }
      _selectedGroups.clear();
    });
    // 日期区间由服务端过滤，改完必须重新加载
    _loadDropship();
  }

  void _clearDropshipRange() {
    setState(() {
      _dateFrom = '';
      _dateTo = '';
      _selectedGroups.clear();
    });
    _loadDropship();
  }

  void _toggleItem(_PayableItem item) {
    setState(() {
      if (!_selected.add(item.key)) {
        _selected.remove(item.key);
      }
    });
  }

  void _toggleGroup(int index) {
    setState(() {
      if (!_selectedGroups.add(index)) {
        _selectedGroups.remove(index);
      }
    });
  }

  /// 批量标记要按 kind 分组，后端每种账单走不同的表（入库 inbounds、入仓 warehouse_ins、
  /// 出库 outbounds、其他开支 other_expenses、手动记账 finance_records），一次 pay-batch
  /// 只能带一个 kind；混着提交会更新错表或直接报「未知的账单类型」。
  Future<void> _markSelected(bool paid) async {
    if (_selected.isEmpty || _isSubmitting) {
      return;
    }
    final Map<String, List<int>> idsByKind = <String, List<int>>{};
    for (final String key in _selected) {
      final int sep = key.indexOf('#');
      final String kind = key.substring(0, sep);
      final int id = int.tryParse(key.substring(sep + 1)) ?? 0;
      idsByKind.putIfAbsent(kind, () => <int>[]).add(id);
    }

    setState(() => _isSubmitting = true);
    final String action = paid ? '已付款' : '未付款';
    int updated = 0;
    int missing = 0;
    final List<String> errors = <String>[];
    try {
      for (final MapEntry<String, List<int>> entry in idsByKind.entries) {
        try {
          final Map<String, dynamic> res =
              await ApiService.payBillsBatch(entry.key, entry.value, paid: paid);
          updated += _asInt(res['updated']);
          missing += _asInt(res['missing']);
        } on ApiException catch (e) {
          errors.add('${_kindLabels[entry.key] ?? entry.key}：${e.message}');
        }
      }
    } finally {
      if (mounted) {
        setState(() => _isSubmitting = false);
      }
    }

    if (errors.isNotEmpty) {
      _showError('标记$action失败：${errors.join('；')}');
    } else if (updated > 0) {
      // missing：单据已被删或 id 对不上，后端会跳过并计数，必须提示出来
      final String tail = missing > 0 ? '，另有 $missing 笔已不存在' : '';
      _showInfo('已标记 $updated 笔为$action$tail',
          background: missing > 0 ? Colors.orange : Colors.green);
    } else {
      _showError(missing > 0 ? '没有账单被更新（$missing 笔已不存在）' : '没有账单被更新');
    }
    await _loadPayables();
  }

  /// 代发不用 pay-batch：一行「商品 + 规格 + 日期」背后可能是多张出库单，
  /// 后端 kind='dropship' 认的是**出库单 id**（整单下的代发明细一起结清），
  /// 逐条 payBill 才能把失败精确落到某一张单上，最后汇总成功 / 失败笔数。
  Future<void> _markSelectedGroups(bool paid) async {
    if (_selectedGroups.isEmpty || _isSubmitting) {
      return;
    }
    setState(() => _isSubmitting = true);
    final String action = paid ? '已付款' : '未付款';
    int ok = 0;
    int fail = 0;
    String lastError = '';
    try {
      final List<int> indexes = _selectedGroups.toList()..sort();
      for (final int i in indexes) {
        if (i < 0 || i >= _groups.length) {
          continue;
        }
        final _DropshipGroup group = _groups[i];
        // 没有出库单 id 时退回账单行 id，此时 kind 要换成 dropship_item
        final bool byOrder = group.orderIds.isNotEmpty;
        final String kind = byOrder ? 'dropship' : 'dropship_item';
        final List<int> ids = byOrder ? group.orderIds : group.billIds;
        for (final int id in ids) {
          try {
            await ApiService.payBill(kind, id, paid: paid);
            ok++;
          } on ApiException catch (e) {
            fail++;
            lastError = e.message;
          }
        }
      }
    } finally {
      if (mounted) {
        setState(() => _isSubmitting = false);
      }
    }

    if (fail > 0) {
      _showError('标记$action：成功 $ok 笔，失败 $fail 笔（$lastError）');
    } else if (ok > 0) {
      _showInfo('已标记 $ok 笔代发账单为$action');
    } else {
      _showError('没有账单被更新');
    }
    await _loadDropship();
  }

  void _showError(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  void _showInfo(String message, {Color background = Colors.green}) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: background),
    );
  }

  // ---------------- 构建 ----------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('待付款'),
        centerTitle: true,
        bottom: TabBar(
          controller: _tabController,
          tabs: const <Tab>[
            Tab(text: '常规账单'),
            Tab(text: '代发账单'),
          ],
        ),
      ),
      body: Column(
        children: <Widget>[
          _buildSummaryBar(),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: <Widget>[
                _buildPayablesTab(),
                _buildDropshipTab(),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: _buildBatchBar(),
    );
  }

  /// 顶部汇总条：应收 / 应付 / 未结笔数 + 「显示已结」开关 + 天数下拉
  Widget _buildSummaryBar() {
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 4),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 2),
        child: Column(
          children: <Widget>[
            Row(
              children: <Widget>[
                _buildStatCard('应收', _currencyFormat.format(_total.receivablesAmount), '待收款', Colors.blue),
                const SizedBox(width: 8),
                _buildStatCard('应付', _currencyFormat.format(_total.payablesAmount), '待付款', Colors.deepOrange),
                const SizedBox(width: 8),
                _buildStatCard('未结笔数', '${_total.unpaidCount}', '已结 ${_total.paidCount} 笔', Colors.black87),
              ],
            ),
            Row(
              children: <Widget>[
                Switch(
                  value: _includePaid,
                  onChanged: _isSubmitting ? null : _onIncludePaidChanged,
                ),
                const Text('显示已结', style: TextStyle(fontSize: 13)),
                const Spacer(),
                const Text('天数', style: TextStyle(fontSize: 13, color: Colors.black54)),
                const SizedBox(width: 2),
                DropdownButton<int>(
                  value: _days,
                  isDense: true,
                  underline: const SizedBox.shrink(),
                  items: _dayOptions
                      .map((int d) => DropdownMenuItem<int>(value: d, child: Text('$d 天')))
                      .toList(),
                  onChanged: _onDaysChanged,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStatCard(String label, String value, String hint, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: Colors.grey.shade100,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(label, style: const TextStyle(fontSize: 12, color: Colors.black54)),
            const SizedBox(height: 2),
            Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 19, fontWeight: FontWeight.bold, color: color),
            ),
            Text(hint, style: const TextStyle(fontSize: 11, color: Colors.black45)),
          ],
        ),
      ),
    );
  }

  Widget _buildPayablesTab() {
    return RefreshIndicator(
      onRefresh: _loadPayables,
      child: _buildBillList(),
    );
  }

  Widget _buildBillList() {
    if (_isLoading && _items.isEmpty) {
      return _buildPlaceholder(const CircularProgressIndicator());
    }
    if (_items.isEmpty) {
      return _buildPlaceholder(const Text('暂无待结账单', style: TextStyle(color: Colors.black45)));
    }
    return ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(12, 2, 12, 12),
      itemCount: _items.length + 1,
      itemBuilder: (BuildContext context, int index) {
        // 第 0 行说明统计口径：days 只查最近 N 天，更早的账单不在列表里
        if (index == 0) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(2, 4, 2, 6),
            child: Text(
              '最近 $_days 天 · 共 ${_items.length} 笔${_includePaid ? '（含已结）' : '（只列未结）'} · 长按或点右侧方框可多选',
              style: const TextStyle(fontSize: 12, color: Colors.black45),
            ),
          );
        }
        return _buildBillCard(_items[index - 1]);
      },
    );
  }

  Widget _buildBillCard(_PayableItem item) {
    final bool selected = _selected.contains(item.key);
    final Color amountColor = item.isReceivable ? Colors.blue : Colors.deepOrange;
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: InkWell(
        onTap: () => _toggleItem(item),
        onLongPress: () => _toggleItem(item),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      item.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${item.source} · ${item.sub}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12, color: Colors.black54),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      item.remark.isEmpty
                          ? '${item.date} · ${item.operator}'
                          : '${item.date} · ${item.operator} · ${item.remark}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: Colors.black45),
                    ),
                    const SizedBox(height: 6),
                    _buildStatusChip(item.isUnpaid, item.paidAt),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: <Widget>[
                  Text(
                    _currencyFormat.format(item.amount),
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: amountColor),
                  ),
                  Text(
                    item.isReceivable ? '应收' : '应付',
                    style: TextStyle(fontSize: 12, color: amountColor),
                  ),
                ],
              ),
              Checkbox(
                value: selected,
                visualDensity: VisualDensity.compact,
                onChanged: (bool? value) => _toggleItem(item),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStatusChip(bool isUnpaid, String paidAt) {
    if (isUnpaid) {
      return _buildChip('未结', Colors.deepOrange, Colors.deepOrange.shade50);
    }
    return _buildChip(paidAt.isEmpty ? '已结' : '已结 $paidAt', Colors.teal, Colors.teal.shade50);
  }

  Widget _buildChip(String label, Color foreground, Color background) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: foreground, width: 0.5),
      ),
      child: Text(label, style: TextStyle(fontSize: 11, color: foreground)),
    );
  }

  Widget _buildDropshipTab() {
    return Column(
      children: <Widget>[
        _buildDropshipHeader(),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _loadDropship,
            child: _buildDropshipList(),
          ),
        ),
      ],
    );
  }

  Widget _buildDropshipHeader() {
    final bool hasRange = _dateFrom.isNotEmpty || _dateTo.isNotEmpty;
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 4),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(child: _buildDateButton('开始日期', _dateFrom, true)),
                const SizedBox(width: 6),
                Expanded(child: _buildDateButton('结束日期', _dateTo, false)),
                IconButton(
                  onPressed: hasRange && !_isDropLoading ? _clearDropshipRange : null,
                  icon: const Icon(Icons.clear, size: 20),
                  tooltip: '清除日期区间',
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: <Widget>[
                _buildStatCard(
                  '代发应付',
                  _currencyFormat.format(_dropTotal.amount),
                  '共 ${_dropTotal.groups} 组',
                  Colors.deepOrange,
                ),
                const SizedBox(width: 8),
                _buildStatCard(
                  '待结金额',
                  _currencyFormat.format(_dropTotal.pendingAmount),
                  '${_dropTotal.pendingGroups} 组待结',
                  Colors.blue,
                ),
                const SizedBox(width: 8),
                _buildStatCard('单数', '${_dropTotal.orders}', '数量 ${_fmtQty(_dropTotal.quantity)}', Colors.black87),
              ],
            ),
            if (_dropTruncated)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  '只取最近 $_dropShown 组，共 ${_dropTotal.groups} 组，请缩小日期范围',
                  style: const TextStyle(fontSize: 12, color: Colors.orange),
                ),
              ),
            if (!hasRange)
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text(
                  '未选日期区间＝全部日期（顶部「天数」只作用于常规账单）',
                  style: TextStyle(fontSize: 11, color: Colors.black45),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildDateButton(String label, String value, bool isFrom) {
    return OutlinedButton.icon(
      onPressed: _isDropLoading ? null : () => _pickDropshipDate(isFrom),
      icon: const Icon(Icons.calendar_today, size: 14),
      label: Text(
        value.isEmpty ? label : value.substring(5),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 12),
      ),
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 6),
        foregroundColor: Colors.black87,
      ),
    );
  }

  Widget _buildDropshipList() {
    if (_isDropLoading && _groups.isEmpty) {
      return _buildPlaceholder(const CircularProgressIndicator());
    }
    if (_groups.isEmpty) {
      return _buildPlaceholder(const Text('暂无待结账单', style: TextStyle(color: Colors.black45)));
    }
    return ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(12, 2, 12, 12),
      itemCount: _groups.length,
      itemBuilder: (BuildContext context, int index) => _buildGroupCard(_groups[index], index),
    );
  }

  Widget _buildGroupCard(_DropshipGroup group, int index) {
    final bool selected = _selectedGroups.contains(index);
    final String specText = group.spec.isEmpty ? group.unit : '${group.spec} · ${group.unit}';
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: InkWell(
        onTap: () => _toggleGroup(index),
        onLongPress: () => _toggleGroup(index),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(2, 8, 4, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              Checkbox(
                value: selected,
                visualDensity: VisualDensity.compact,
                onChanged: (bool? value) => _toggleGroup(index),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      group.productName,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 2),
                    Text(specText, style: const TextStyle(fontSize: 12, color: Colors.black54)),
                    const SizedBox(height: 2),
                    Text(
                      '${group.date} · ${group.orderCount} 单 · ${_fmtQty(group.quantity)}${group.unit}'
                      '${group.operator.isEmpty ? '' : ' · ${group.operator}'}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: Colors.black45),
                    ),
                    const SizedBox(height: 6),
                    _buildStatusChip(group.isUnpaid, group.paidAt),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: <Widget>[
                  Text(
                    _currencyFormat.format(group.amount),
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.bold, color: Colors.deepOrange),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    group.isUnpaid ? '应付 · 未结 ${group.unpaidCount} 笔' : '应付 · 已结',
                    style: const TextStyle(fontSize: 12, color: Colors.deepOrange),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPlaceholder(Widget child) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(top: 120),
      children: <Widget>[Center(child: child)],
    );
  }

  /// 多选后底部的批量操作条：常规账单按 kind 分组走 pay-batch，代发逐条走 payBill
  Widget? _buildBatchBar() {
    if (_tabController.index == 0) {
      if (_selected.isEmpty) {
        return null;
      }
      return _buildActionBar(
        '已选 ${_selected.length} 笔',
        () => _markSelected(true),
        () => _markSelected(false),
        () {
          setState(_selected.clear);
        },
      );
    }
    if (_selectedGroups.isEmpty) {
      return null;
    }
    return _buildActionBar(
      '已选 ${_selectedGroups.length} 组',
      () => _markSelectedGroups(true),
      () => _markSelectedGroups(false),
      () {
        setState(_selectedGroups.clear);
      },
    );
  }

  Widget _buildActionBar(
    String label,
    VoidCallback onMarkPaid,
    VoidCallback onMarkUnpaid,
    VoidCallback onCancel,
  ) {
    return Material(
      color: const Color(0xFF2F2F2F),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 6, 4),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(label, style: const TextStyle(color: Colors.white, fontSize: 14)),
              ),
              if (_isSubmitting)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 10),
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                    ),
                  ),
                )
              else
                ...<Widget>[
                  TextButton(
                    onPressed: onMarkPaid,
                    child: const Text('标记已付款', style: TextStyle(color: Colors.white)),
                  ),
                  TextButton(
                    onPressed: onMarkUnpaid,
                    child: const Text('标记未付款', style: TextStyle(color: Colors.white70)),
                  ),
                ],
              IconButton(
                onPressed: onCancel,
                icon: const Icon(Icons.close, size: 20, color: Colors.white),
                tooltip: '取消选择',
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _fmtQty(double value) {
    if (value == value.roundToDouble()) {
      return value.toStringAsFixed(0);
    }
    return value.toStringAsFixed(2);
  }
}

/// 常规账单行（/api/payables 的 items 元素）。
class _PayableItem {
  const _PayableItem({
    required this.kind,
    required this.id,
    required this.title,
    required this.sub,
    required this.amount,
    required this.direction,
    required this.source,
    required this.page,
    required this.payStatus,
    required this.paidAt,
    required this.date,
    required this.operator,
    required this.remark,
  });

  factory _PayableItem.fromMap(Map<String, dynamic> map) {
    return _PayableItem(
      kind: _asText(map['kind']),
      id: _asInt(map['id']),
      title: _asText(map['title']),
      sub: _asText(map['sub']),
      amount: _asDouble(map['amount']),
      direction: _asText(map['direction']),
      source: _asText(map['source']),
      page: _asText(map['page']),
      payStatus: _asText(map['pay_status'], fallback: 'unpaid'),
      paidAt: _asText(map['paid_at']),
      date: _asText(map['date']),
      operator: _asText(map['operator']),
      remark: _asText(map['remark']),
    );
  }

  final String kind;
  final int id;
  final String title;
  final String sub;
  final double amount;

  /// 'in' = 别人欠我（应收），'out' = 我欠别人（应付）
  final String direction;
  final String source;

  /// 后端给的网页端锚点（inbound / outbound / warehouse_in / other_expense / finance）
  final String page;
  final String payStatus;
  final String paidAt;
  final String date;
  final String operator;
  final String remark;

  bool get isUnpaid => payStatus != 'paid';
  bool get isReceivable => direction == 'in';

  /// 批量操作要按 kind 分组，所以选择键必须带 kind
  String get key => '$kind#$id';
}

/// 常规账单汇总（/api/payables 的 total）。
class _PayableTotal {
  const _PayableTotal({
    this.unpaidCount = 0,
    this.payablesAmount = 0,
    this.receivablesAmount = 0,
    this.paidCount = 0,
  });

  factory _PayableTotal.fromMap(Map<String, dynamic> map) {
    return _PayableTotal(
      unpaidCount: _asInt(map['unpaid_count']),
      payablesAmount: _asDouble(map['payables_amount']),
      receivablesAmount: _asDouble(map['receivables_amount']),
      paidCount: _asInt(map['paid_count']),
    );
  }

  final int unpaidCount;
  final double payablesAmount;
  final double receivablesAmount;
  final int paidCount;
}

/// 代发账单行：按「商品 + 规格 + 单位 + 出库日期」聚合，一行可含多张出库单。
class _DropshipGroup {
  const _DropshipGroup({
    required this.productId,
    required this.productName,
    required this.spec,
    required this.unit,
    required this.date,
    required this.orderCount,
    required this.quantity,
    required this.amount,
    required this.payStatus,
    required this.paidAt,
    required this.unpaidCount,
    required this.operator,
    required this.orderIds,
    required this.billIds,
  });

  factory _DropshipGroup.fromMap(Map<String, dynamic> map) {
    List<int> orderIds = _asIntList(map['order_ids']);
    if (orderIds.isEmpty) {
      // 兼容返回字段名叫 ids 的情况
      orderIds = _asIntList(map['ids']);
    }
    final int count = _asInt(map['order_count']);
    return _DropshipGroup(
      productId: _asInt(map['product_id']),
      productName: _asText(map['product_name']),
      spec: _asText(map['spec']),
      unit: _asText(map['unit']),
      date: _asText(map['date']),
      orderCount: count > 0 ? count : orderIds.length,
      quantity: _asDouble(map['quantity']),
      amount: _asDouble(map['amount']),
      payStatus: _asText(map['pay_status'], fallback: 'unpaid'),
      paidAt: _asText(map['paid_at']),
      unpaidCount: _asInt(map['unpaid_count']),
      operator: _asText(map['operator']),
      orderIds: orderIds,
      billIds: _asIntList(map['bill_ids']),
    );
  }

  final int productId;
  final String productName;
  final String spec;
  final String unit;
  final String date;
  final int orderCount;
  final double quantity;
  final double amount;
  final String payStatus;
  final String paidAt;
  final int unpaidCount;
  final String operator;

  /// 出库单 id（payBill kind='dropship' 用的是这个）
  final List<int> orderIds;

  /// 代发账单行 id（payBill kind='dropship_item' 用的是这个）
  final List<int> billIds;

  bool get isUnpaid => payStatus == 'unpaid';
}

/// 代发账单汇总（/api/payables/dropship 的 total）。
class _DropshipTotal {
  const _DropshipTotal({
    this.groups = 0,
    this.orders = 0,
    this.quantity = 0,
    this.amount = 0,
    this.pendingGroups = 0,
    this.pendingAmount = 0,
    this.paidAmount = 0,
  });

  factory _DropshipTotal.fromMap(Map<String, dynamic> map) {
    return _DropshipTotal(
      groups: _asInt(map['groups']),
      orders: _asInt(map['orders']),
      quantity: _asDouble(map['quantity']),
      amount: _asDouble(map['amount']),
      pendingGroups: _asInt(map['pending_groups']),
      pendingAmount: _asDouble(map['pending_amount']),
      paidAmount: _asDouble(map['paid_amount']),
    );
  }

  final int groups;
  final int orders;
  final double quantity;
  final double amount;
  final int pendingGroups;
  final double pendingAmount;
  final double paidAmount;
}

// ---------------- JSON 宽松取值（后端字段可能是 null / 数字 / 字符串混着给） ----------------

Map<String, dynamic> _asMap(dynamic value) {
  return value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};
}

String _asText(dynamic value, {String fallback = ''}) {
  if (value == null) {
    return fallback;
  }
  return '$value';
}

int _asInt(dynamic value) {
  if (value is int) {
    return value;
  }
  if (value is num) {
    return value.round();
  }
  return int.tryParse('$value') ?? 0;
}

double _asDouble(dynamic value) {
  if (value is num) {
    return value.toDouble();
  }
  return double.tryParse('$value') ?? 0;
}

List<int> _asIntList(dynamic value) {
  if (value is! List) {
    return <int>[];
  }
  return value.map((dynamic e) => _asInt(e)).where((int id) => id > 0).toList();
}
