import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';

/// 桌面端「其他开支」页：1:1 复刻 web `#page-otherexp`（登记区 / 统计区 / 开支明细）。
///
/// 口径（backend/app/routers/others.py）：
/// - 明细里 ref_type 非空 = 这笔由单据自动带出（入库运费·装卸 / 金额调整 / 出库费用），
///   后端禁止本页改删（400 原文提示），操作列改成「随单据自动维护」；
/// - 今日 / 本月两项不受区间影响，区间合计跟随所选区间；
/// - 保存的日期若落在当前区间外，自动把区间扩展包住它（避免「存了却看不见」）。
class DesktopExpensesScreen extends StatefulWidget {
  const DesktopExpensesScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopExpensesScreen> createState() => _DesktopExpensesScreenState();
}

/// 后端 PRESET_CATEGORIES：stats.presets 缺失时兜底用
const List<String> kOePresetCategories = <String>[
  '金额调整',
  '运费',
  '装卸费',
  '网线费',
  '安装费',
  '机器费',
  '样品费',
  '设备维修',
  '水电费',
  '搬运费',
  '办公用品',
  '其他',
];

final RegExp _dayRe = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final RegExp _uploadRe = RegExp(r'/uploads/[A-Za-z0-9_.\-\u4e00-\u9fff]+');
final RegExp _attachPrefixRe = RegExp(r'^attach_\d{8}_\d{6}_\d+_');
final RegExp _imageUrlRe = RegExp(r'\.(png|jpe?g|gif|webp|bmp|svg)$', caseSensitive: false);

const TextInputType _kNum = TextInputType.numberWithOptions(decimal: true);

String _fmtDay(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// 2026-10-18 → 10-18（图表横轴）
String _shortDay(String date) => date.length >= 10 ? date.substring(5) : date;

/// 附件展示名：去掉 attach_<日期>_<时间>_ 前缀
String _attachName(String url) {
  final name = url.split('/').last;
  if (name.isEmpty) return '附件';
  final stripped = name.replaceAll(_attachPrefixRe, '');
  return stripped.isEmpty ? name : stripped;
}

/// 备注里的一段：纯文本，或一个附件（图片 / 其他文件）
class _RemarkSeg {
  const _RemarkSeg.text(String value)
      : text = value,
        url = '',
        name = '',
        isImage = false;

  const _RemarkSeg.attach(this.url, this.name, this.isImage) : text = '';

  final String text;
  final String url;
  final String name;
  final bool isImage;
}

/// 备注 → 有序段落（与网页端 splitRemark 同一套正则）
List<_RemarkSeg> _splitRemark(String rmk) {
  final segs = <_RemarkSeg>[];
  var last = 0;
  for (final m in _uploadRe.allMatches(rmk)) {
    if (m.start > last) segs.add(_RemarkSeg.text(rmk.substring(last, m.start)));
    final url = m.group(0) ?? '';
    segs.add(_RemarkSeg.attach(url, _attachName(url), _imageUrlRe.hasMatch(url)));
    last = m.end;
  }
  if (last < rmk.length) segs.add(_RemarkSeg.text(rmk.substring(last)));
  return segs.where((s) => s.url.isNotEmpty || s.text.trim().isNotEmpty).toList();
}

class _DesktopExpensesScreenState extends State<DesktopExpensesScreen> {
  final TextEditingController _categoryCtl = TextEditingController();
  final TextEditingController _amountCtl = TextEditingController();
  final TextEditingController _remarkCtl = TextEditingController();
  final TextEditingController _searchCtl = TextEditingController();

  /// 操作员只读展示（后端固定用当前登录账号，不接受前端传值）
  late final TextEditingController _operatorCtl = TextEditingController(text: widget.auth.displayName);

  // ---------- 登记区 ----------
  bool _formOpen = true;
  bool _saving = false;
  int? _editId;
  String _oeDate = wsToday();
  String _payStatus = 'paid';
  String _alert = '';

  // ---------- 统计区间 ----------
  String _dateFrom = wsMonthStart();
  String _dateTo = wsToday();

  // ---------- 明细 ----------
  String _category = '';
  String _keyword = '';
  int _chartTab = 0;

  List<dynamic> _items = const <dynamic>[];
  Map<String, dynamic> _stats = const <String, dynamic>{};
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _categoryCtl.dispose();
    _amountCtl.dispose();
    _remarkCtl.dispose();
    _searchCtl.dispose();
    _operatorCtl.dispose();
    super.dispose();
  }

  // ---------------- 数据 ----------------

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait<Object?>(<Future<Object?>>[
        ApiService.otherExpenses(dateFrom: _dateFrom, dateTo: _dateTo, category: _category),
        ApiService.otherExpenseStats(dateFrom: _dateFrom, dateTo: _dateTo),
      ]);
      if (!mounted) return;
      setState(() {
        _items = results[0] as List<dynamic>;
        _stats = Map<String, dynamic>.from(results[1] as Map);
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载其他开支失败：${e.message}';
        _loading = false;
      });
      wsToast(context, e.message, error: true);
    }
  }

  /// 统计兼容两种形状：today:{amount,count} 与扁平 today_total / today_count
  double _statAmount(String nodeKey, String flatKey) {
    final node = _stats[nodeKey];
    if (node is Map) return wsD(node['amount']);
    return wsD(_stats[flatKey]);
  }

  int _statCount(String nodeKey, String flatKey) {
    final node = _stats[nodeKey];
    if (node is Map) return wsI(node['count']);
    return wsI(_stats[flatKey]);
  }

  List<dynamic> _list(String key) {
    final v = _stats[key];
    return v is List ? v : const <dynamic>[];
  }

  int _todayCount() {
    final direct = _statCount('today', 'today_count');
    if (direct > 0) return direct;
    final today = wsToday();
    for (final row in _list('by_day')) {
      if (wsS(row['date']) == today) return wsI(row['count']);
    }
    return 0;
  }

  int _monthCount() {
    final direct = _statCount('month', 'month_count');
    if (direct > 0) return direct;
    final month = wsToday().substring(0, 7);
    for (final row in _list('by_month')) {
      if (wsS(row['month']) == month) return wsI(row['count']);
    }
    return 0;
  }

  /// 下拉建议 = 后端 presets（预设 + 用过的自定义）∪ 明细里出现的类型
  List<String> get _categoryOptions {
    final options = <String>[];
    final presets = _stats['presets'];
    if (presets is List) {
      for (final p in presets) {
        final name = wsS(p);
        if (name.isNotEmpty && !options.contains(name)) options.add(name);
      }
    }
    for (final row in _list('by_category')) {
      final name = wsS(row['category']);
      if (name.isNotEmpty && !options.contains(name)) options.add(name);
    }
    for (final item in _items) {
      final name = wsS(item['category']);
      if (name.isNotEmpty && !options.contains(name)) options.add(name);
    }
    if (options.isEmpty) options.addAll(kOePresetCategories);
    return options;
  }

  /// 明细的类型下拉（精确匹配）：只列数据里真实出现过的类型
  List<String> get _usedCategories {
    final used = <String>[];
    for (final item in _items) {
      final name = wsS(item['category']);
      if (name.isNotEmpty && !used.contains(name)) used.add(name);
    }
    for (final row in _list('by_category')) {
      final name = wsS(row['category']);
      if (name.isNotEmpty && !used.contains(name)) used.add(name);
    }
    return used;
  }

  String get _scopeLabel =>
      '统计区间 ${_dateFrom.isEmpty ? '最早' : _dateFrom} ~ ${_dateTo.isEmpty ? '至今' : _dateTo}（日均按区间天数计算）';

  /// 前端关键字过滤：类型 / 备注 / 操作员 / 日期
  List<dynamic> get _filteredRows {
    final kw = _keyword.trim().toLowerCase();
    if (kw.isEmpty) return _items;
    return _items
        .where((r) => <String>[wsS(r['category']), wsS(r['remark']), wsS(r['operator']), wsS(r['date'])]
            .join(' ')
            .toLowerCase()
            .contains(kw))
        .toList();
  }

  double get _rangeSum {
    var sum = 0.0;
    for (final r in _filteredRows) {
      sum += wsD(r['amount']);
    }
    return sum;
  }

  // ---------------- 交互：区间 ----------------

  void _quick(String kind) {
    final now = DateTime.now();
    final t = wsToday();
    var from = _dateFrom;
    var to = _dateTo;
    switch (kind) {
      case 'today':
        from = t;
        to = t;
      case 'week':
        from = _fmtDay(now.subtract(const Duration(days: 6)));
        to = t;
      case 'month':
        from = wsMonthStart();
        to = t;
      case 'lastmonth':
        final first = DateTime(now.year, now.month - 1, 1);
        final last = DateTime(now.year, now.month, 0);
        from = _fmtDay(first);
        to = _fmtDay(last);
      default:
        from = '';
        to = '';
    }
    setState(() {
      _dateFrom = from;
      _dateTo = to;
    });
    _load();
  }

  void _setCategory(String value) {
    setState(() => _category = value);
    _load();
  }

  // ---------------- 交互：登记 / 编辑 / 删除 ----------------

  void _resetForm() {
    _editId = null;
    _categoryCtl.clear();
    _amountCtl.clear();
    _remarkCtl.clear();
    _oeDate = wsToday();
    _payStatus = 'paid';
    _alert = '';
  }

  /// 网页端 oeEdit：编辑不用弹窗，直接回填顶部登记区
  void _edit(dynamic item) {
    setState(() {
      _editId = wsI(item['id']);
      _categoryCtl.text = wsS(item['category']);
      final amount = wsD(item['amount']);
      _amountCtl.text = amount % 1 == 0 ? amount.toStringAsFixed(0) : amount.toStringAsFixed(2);
      _remarkCtl.text = wsS(item['remark']);
      final raw = wsS(item['date']);
      _oeDate = _dayRe.hasMatch(raw) ? raw : wsToday();
      _payStatus = wsS(item['pay_status'], fallback: 'paid') == 'unpaid' ? 'unpaid' : 'paid';
      _formOpen = true;
      _alert = '正在修改 $_oeDate「${wsS(item['category'])}」${wsMoney(wsD(item['amount']))}（保存后覆盖原记录）';
    });
  }

  Future<void> _pickCategory() async {
    final picked = await desktopSearchSelect(
      context,
      title: '选择费用类型',
      options: <DesktopOption<String>>[
        for (final c in _categoryOptions) DesktopOption<String>(c, c),
      ],
      value: _categoryCtl.text.isEmpty ? null : _categoryCtl.text,
      hint: '搜索 / 直接输入新类型',
    );
    if (picked == null) return;
    if (!mounted) return;
    setState(() => _categoryCtl.text = picked);
  }

  /// 网页端 oeSubmit：登记（新增/编辑都走顶部这一张卡）
  Future<void> _submit() async {
    final category = _categoryCtl.text.trim();
    if (category.isEmpty) {
      setState(() => _alert = '请填写费用类型（如 网线费 / 安装费 / 机器费 / 样品费）');
      return;
    }
    if (category.length > 32) {
      setState(() => _alert = '费用类型过长（≤32 字）');
      return;
    }
    final rawAmount = _amountCtl.text.trim();
    final amount = double.tryParse(rawAmount);
    if (rawAmount.isEmpty || amount == null) {
      setState(() => _alert = '金额格式不正确');
      return;
    }
    if (amount <= 0) {
      setState(() => _alert = '金额必须大于 0');
      return;
    }
    if (_oeDate.isEmpty) {
      setState(() => _alert = '请选择日期');
      return;
    }
    if (!_dayRe.hasMatch(_oeDate)) {
      setState(() => _alert = '日期格式应为 YYYY-MM-DD');
      return;
    }
    final id = _editId;
    final editing = id != null;
    final body = <String, dynamic>{
      'category': category,
      'amount': amount,
      'date': _oeDate,
      'remark': _remarkCtl.text.trim(),
      'pay_status': _payStatus,
    };
    setState(() => _saving = true);
    try {
      if (editing) {
        await ApiService.updateOtherExpense(id, body);
      } else {
        await ApiService.createOtherExpense(body);
      }
      // 保存的日期落在当前区间外 → 扩展区间把它包进来
      if (_dateFrom.isNotEmpty && _oeDate.compareTo(_dateFrom) < 0) _dateFrom = _oeDate;
      if (_dateTo.isNotEmpty && _oeDate.compareTo(_dateTo) > 0) _dateTo = _oeDate;
      if (!mounted) return;
      final tail = _payStatus == 'unpaid' ? '（待付款，已进待付款账单）' : '';
      wsToast(context, (editing ? '已保存修改' : '已登记 $category ${wsMoney(amount)}') + tail);
      setState(() {
        _saving = false;
        _alert = '';
        _resetForm();
      });
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _alert = '保存失败：${e.message}';
      });
      wsToast(context, e.message, error: true);
    }
  }

  Future<void> _delete(dynamic item) async {
    final id = wsI(item['id']);
    final ok = await wsConfirm(
      context,
      title: '删除这笔开支',
      message: '确认删除 ${wsS(item['date'])}「${wsS(item['category'])}」${wsMoney(wsD(item['amount']))}？',
      okLabel: '删除',
      danger: true,
    );
    if (!ok) return;
    if (!mounted) return;
    try {
      await ApiService.deleteOtherExpense(id);
    } on ApiException catch (e) {
      if (!mounted) return;
      // ref_type 非空时后端 400：原文展示「该笔开支由单据自动带出…请在来源单据中修改或删除」
      wsToast(context, e.message, error: true);
      return;
    }
    if (!mounted) return;
    if (_editId == id) setState(_resetForm);
    wsToast(context, '已删除');
    await _load();
  }

  // ---------------- 交互：附件预览 ----------------

  Future<void> _previewAttachment(String url, String name) async {
    final full = ApiService.resolveUrl(url);
    if (full.isEmpty) return;
    if (!_imageUrlRe.hasMatch(url)) {
      // 非图片附件（PDF / Excel）桌面端不内嵌预览，复制完整地址交给浏览器
      if (!mounted) return;
      await wsCopy(context, full);
      return;
    }
    await desktopDialog<void>(
      context,
      title: '附件预览 · $name',
      width: 880,
      maxHeight: 780,
      builder: (_) => SizedBox(
        height: 620,
        width: 840,
        child: Center(
          child: Image.network(
            full,
            fit: BoxFit.contain,
            loadingBuilder: (BuildContext c, Widget child, ImageChunkEvent? progress) {
              if (progress == null) return child;
              return const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2.4),
              );
            },
            errorBuilder: (BuildContext c, Object err, StackTrace? trace) => Padding(
              padding: const EdgeInsets.all(20),
              child: Text(
                '图片加载失败：$name\n$full',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight, height: 1.6),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ---------------- 构建 ----------------

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '其他开支',
      subtitle: '仓库 / 经营中的零散支出：网线费、安装费、机器费、样品费等。保存后计入财务报表「期间费用」，'
          '并从毛利中扣减得到净利（无需再到「手动记账」重复登记）。',
      actions: <Widget>[
        DesktopButton(
          label: '待付款账单',
          icon: Icons.credit_card_outlined,
          onPressed: () => widget.onNavigate('/payables'),
        ),
        DesktopButton(label: '刷新', icon: Icons.refresh, onPressed: _loading ? null : _load),
        DesktopButton(
          label: _editId == null ? '记一笔' : '取消编辑',
          icon: _editId == null ? Icons.add : Icons.close,
          kind: DesktopButtonKind.primary,
          onPressed: () => setState(() {
            _formOpen = true;
            if (_editId != null) _resetForm();
          }),
        ),
      ],
      body: DesktopStateView(
        loading: _loading && _items.isEmpty,
        loadingText: '加载其他开支…',
        error: _error,
        onRetry: _load,
        child: ListView(
          padding: EdgeInsets.zero,
          children: <Widget>[
            DesktopRise(index: 0, child: _buildFormCard()),
            DesktopRise(index: 1, child: _buildFilterBar()),
            DesktopRise(index: 2, child: _buildStatGrid()),
            DesktopRise(index: 3, child: _buildChartCard()),
            DesktopRise(index: 4, child: _buildDetailCard()),
          ],
        ),
      ),
    );
  }

  /// 登记区（可折叠）：新增与「改」都走这里（与网页端 oeEdit/oeSubmit 同一套交互）
  Widget _buildFormCard() {
    final editing = _editId != null;
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          WsCardHead(
            title: '登记其他开支${editing ? '（修改中）' : ''}',
            icon: Icons.account_balance_wallet_outlined,
            trailing: DesktopButton(
              label: _formOpen ? '收起' : '展开登记',
              small: true,
              icon: _formOpen ? Icons.expand_less : Icons.expand_more,
              onPressed: () => setState(() => _formOpen = !_formOpen),
            ),
          ),
          const Text(
            '费用类型可自由输入（保存后自动进入下拉建议）；操作员固定为当前登录账号，不可修改；'
            '保存后计入财务报表「期间费用」，并从毛利中扣减得到净利（无需再到「手动记账」重复登记）。',
            style: TextStyle(fontSize: 12, color: WsTokens.mutedLight),
          ),
          if (_alert.isNotEmpty) ...[
            const SizedBox(height: 12),
            DesktopNotice(_alert, kind: editing ? DesktopNoticeKind.info : DesktopNoticeKind.error),
          ],
          if (_formOpen) ...[
            const SizedBox(height: 16),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      DesktopFormRow(
                        label: '费用类型',
                        required: true,
                        width: 220,
                        tip: '可输入，也可从预设 / 已用类型里挑',
                        child: DesktopTextField(
                          controller: _categoryCtl,
                          hintText: '如：网线费 / 安装费',
                          width: 220,
                          suffix: DesktopIconButton(
                            icon: Icons.keyboard_arrow_down,
                            tooltip: '选择费用类型',
                            onPressed: _pickCategory,
                          ),
                        ),
                      ),
                      DesktopFormRow(
                        label: '金额（元）',
                        required: true,
                        width: 180,
                        tip: '大于 0',
                        child: DesktopTextField(
                          controller: _amountCtl,
                          hintText: '0.00',
                          width: 180,
                          keyboardType: _kNum,
                          inputFormatters: DesktopTextField.decimalOnly,
                        ),
                      ),
                      DesktopFormRow(
                        label: '日期',
                        required: true,
                        width: 160,
                        tip: '默认今天',
                        child: DesktopDateField(
                          value: _oeDate,
                          allowClear: false,
                          width: 160,
                          onChanged: (v) => setState(() => _oeDate = v.isEmpty ? wsToday() : v),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 18),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      DesktopFormRow(
                        label: '操作员',
                        width: 180,
                        tip: '默认当前登录账号，不可修改',
                        child: DesktopTextField(controller: _operatorCtl, readonly: true, width: 180),
                      ),
                      DesktopFormRow(
                        label: '付款状态',
                        width: 190,
                        child: DesktopPayRadios(
                          value: _payStatus,
                          onChanged: (v) => setState(() => _payStatus = v),
                        ),
                      ),
                      const Padding(
                        padding: EdgeInsets.only(left: 108, bottom: 12),
                        child: Text(DesktopPayRadios.hint,
                            style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            DesktopFormRow(
              label: '备注',
              width: 560,
              tip: '可选，如 收款方 / 用途 / 数量；备注里的图片附件（/uploads/…）'
                  '会在明细里显示成可点击预览的小图标',
              child: DesktopTextField(
                controller: _remarkCtl,
                hintText: '可选，如 收款方 / 用途 / 数量',
                width: 560,
                maxLines: 3,
              ),
            ),
            Row(
              children: <Widget>[
                DesktopButton(
                  label: _saving ? '保存中…' : (editing ? '保存修改' : '保存开支'),
                  icon: Icons.check,
                  kind: DesktopButtonKind.success,
                  onPressed: _saving ? null : _submit,
                ),
                const SizedBox(width: 10),
                DesktopButton(
                  label: '清空',
                  icon: Icons.clear,
                  onPressed: _saving ? null : () => setState(_resetForm),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildFilterBar() {
    return DesktopFilterBar(
      right: Text(
        _scopeLabel,
        style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight),
      ),
      children: <Widget>[
        DesktopLabeled(
          label: '起',
          child: DesktopDateField(value: _dateFrom, onChanged: (v) => setState(() => _dateFrom = v)),
        ),
        const Text('至', style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
        DesktopLabeled(
          label: '止',
          child: DesktopDateField(value: _dateTo, onChanged: (v) => setState(() => _dateTo = v)),
        ),
        DesktopButton(label: '查询', icon: Icons.search, small: true, onPressed: _loading ? null : _load),
        DesktopButton(label: '今天', small: true, onPressed: () => _quick('today')),
        DesktopButton(label: '近7天', small: true, onPressed: () => _quick('week')),
        DesktopButton(label: '本月', small: true, onPressed: () => _quick('month')),
        DesktopButton(label: '上月', small: true, onPressed: () => _quick('lastmonth')),
        DesktopButton(label: '全部', small: true, onPressed: () => _quick('all')),
      ],
    );
  }

  Widget _buildStatGrid() {
    final rangeDays = _statCount('range', 'range_days');
    final rangeCount = _statCount('range', 'range_count');
    final top = _list('by_category').isNotEmpty ? _list('by_category').first : null;
    return DesktopStatGrid(
      minTileWidth: 210,
      children: <Widget>[
        DesktopStatCard(
          label: '今日开支',
          value: wsMoney(_statAmount('today', 'today_total')),
          sub: '${wsS(_stats['today'], fallback: wsToday())} · ${_todayCount()} 笔',
          color: WsTokens.red,
        ),
        DesktopStatCard(
          label: '本月开支',
          value: wsMoney(_statAmount('month', 'month_total')),
          sub: '${wsS(_stats['month'])} 月合计 · ${_monthCount()} 笔',
          color: WsTokens.red,
        ),
        DesktopStatCard(
          label: '所选区间合计',
          value: wsMoney(_statAmount('range', 'range_total')),
          sub: _dateRangeText,
          color: WsTokens.amber,
        ),
        DesktopStatCard(label: '区间笔数', value: '$rangeCount', sub: '所选区间共 $_dateRangeText'),
        DesktopStatCard(
          label: '区间天数',
          value: '$rangeDays',
          sub: top == null ? '最大类型：—' : '最大类型：${wsS(top['category'])} ${wsMoney(wsD(top['amount']))}',
        ),
        DesktopStatCard(
          label: '区间日均',
          value: wsMoney(_statAmount('range', 'range_daily_avg')),
          sub: '日均按区间天数计算',
        ),
      ],
    );
  }

  String get _dateRangeText =>
      '${_dateFrom.isEmpty ? '最早' : _dateFrom} ~ ${_dateTo.isEmpty ? '至今' : _dateTo}';

  Widget _buildChartCard() {
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          WsCardHead(
            title: '开支统计',
            icon: Icons.bar_chart_outlined,
            trailing: Text('区间 ${wsI(_stats['range_count'])} 笔 · 合计 ${wsMoney(wsD(_stats['range_total']))}',
                style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: DesktopTabs(
              items: const <String>['按日统计', '按月统计', '按类型统计'],
              index: _chartTab,
              small: true,
              onChanged: (i) => setState(() => _chartTab = i),
            ),
          ),
          const SizedBox(height: 16),
          switch (_chartTab) {
            1 => _buildMonthGrid(),
            2 => _buildCategoryGrid(),
            _ => _buildDayChart(),
          },
        ],
      ),
    );
  }

  Widget _emptyText(String text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 18),
        child: Text(text,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
      );

  Widget _buildDayChart() {
    final days = _list('by_day');
    if (days.isEmpty) return _emptyText('该区间暂无开支');
    final show = days.length > 31 ? days.sublist(0, 31) : days;
    final asc = show.reversed.toList();
    final bars = <({String label, double value})>[
      for (final d in asc) (label: _shortDay(wsS(d['date'])), value: wsD(d['amount'])),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          '每日开支（元，共 ${days.length} 天有支出${days.length > 31 ? '，图里只显示最近 31 天' : ''}）',
          style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight),
        ),
        const SizedBox(height: 8),
        DesktopBars(items: bars, color: WsTokens.red),
        DesktopBarLabels(labels: <String>[for (final b in bars) b.label]),
        const SizedBox(height: 16),
        DesktopGrid(
          dense: true,
          cols: const <DesktopCol>[
            DesktopCol('日期', width: 140),
            DesktopCol('笔数', width: 90, right: true),
            DesktopCol('金额', width: 150, right: true),
          ],
          rows: <DesktopRow>[
            for (final d in days)
              DesktopRow(
                cells: <Widget>[
                  wsCell(wsS(d['date'])),
                  wsCell('${wsI(d['count'])}'),
                  wsCell(wsMoney(wsD(d['amount'])), color: WsTokens.red),
                ],
              ),
          ],
          footer: <String>['合计', '${wsI(_stats['range_count'])}', wsMoney(wsD(_stats['range_total']))],
        ),
      ],
    );
  }

  Widget _buildMonthGrid() {
    final months = _list('by_month');
    if (months.isEmpty) return _emptyText('该区间暂无开支');
    return DesktopGrid(
      cols: const <DesktopCol>[
        DesktopCol('月份', width: 130),
        DesktopCol('笔数', width: 90, right: true),
        DesktopCol('金额', width: 150, right: true),
        DesktopCol('环比', width: 110, right: true, tip: '与上一个月比较（倒序列表里的下一项）'),
      ],
      rows: <DesktopRow>[
        for (var i = 0; i < months.length; i++)
          DesktopRow(
            cells: <Widget>[
              wsCell(wsS(months[i]['month'])),
              wsCell('${wsI(months[i]['count'])}'),
              wsCell(wsMoney(wsD(months[i]['amount'])), color: WsTokens.red),
              _momCell(months, i),
            ],
          ),
      ],
      footer: <String>[
        '合计',
        '${wsI(_stats['range_count'])}',
        wsMoney(wsD(_stats['range_total'])),
        '',
      ],
    );
  }

  /// 环比：by_month 是倒序（最新在前），所以上一个月是列表里的下一项
  Widget _momCell(List<dynamic> months, int i) {
    if (i + 1 >= months.length) return wsCell('—', color: WsTokens.mutedLight);
    final prev = wsD(months[i + 1]['amount']);
    if (prev <= 0) return wsCell('—', color: WsTokens.mutedLight);
    final delta = (wsD(months[i]['amount']) - prev) / prev * 100;
    return wsCell(
      '${delta >= 0 ? '+' : ''}${delta.toStringAsFixed(1)}%',
      color: delta >= 0 ? WsTokens.red : WsTokens.green,
    );
  }

  Widget _buildCategoryGrid() {
    final cats = _list('by_category');
    if (cats.isEmpty) return _emptyText('该区间暂无开支');
    final total = wsD(_stats['range_total']);
    return DesktopGrid(
      cols: const <DesktopCol>[
        DesktopCol('费用类型', width: 180),
        DesktopCol('笔数', width: 90, right: true),
        DesktopCol('金额', width: 150, right: true),
        DesktopCol('占比', width: 100, right: true),
      ],
      rows: <DesktopRow>[
        for (final c in cats)
          DesktopRow(
            cells: <Widget>[
              wsCell(wsS(c['category'], fallback: '未分类'), bold: true),
              wsCell('${wsI(c['count'])}'),
              wsCell(wsMoney(wsD(c['amount'])), color: WsTokens.red),
              wsCell(total > 0 ? '${(wsD(c['amount']) / total * 100).toStringAsFixed(1)}%' : '—'),
            ],
          ),
      ],
      footer: <String>[
        '合计',
        '${wsI(_stats['range_count'])}',
        wsMoney(total),
        '100%',
      ],
    );
  }

  Widget _buildDetailCard() {
    final rows = _filteredRows;
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          WsCardHead(
            title: '开支明细',
            icon: Icons.receipt_long_outlined,
            trailing: DesktopButton(
              label: '刷新',
              small: true,
              icon: Icons.refresh,
              onPressed: _loading ? null : _load,
            ),
          ),
          DesktopFilterBar(
            right: Text(
              '$_scopeLabel · 共 ${rows.length} 笔 · 合计 ${wsMoney(_rangeSum)}',
              style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight),
            ),
            children: <Widget>[
              DesktopLabeled(
                label: '类别',
                child: DesktopSelect<String>(
                  width: 180,
                  value: _category,
                  options: <DesktopOption<String>>[
                    const DesktopOption<String>('', '全部类型'),
                    for (final c in _usedCategories) DesktopOption<String>(c, c),
                  ],
                  onChanged: (v) => _setCategory(v ?? ''),
                ),
              ),
              DesktopLabeled(
                label: '关键字',
                child: DesktopTextField(
                  controller: _searchCtl,
                  hintText: '搜索类型 / 备注 / 操作员…',
                  width: 240,
                  onChanged: (v) => setState(() => _keyword = v),
                ),
              ),
              DesktopButton(
                label: '清空筛选',
                small: true,
                icon: Icons.filter_alt_off_outlined,
                onPressed: (_category.isEmpty && _keyword.isEmpty)
                    ? null
                    : () => setState(() {
                          _category = '';
                          _keyword = '';
                          _searchCtl.clear();
                        }),
              ),
            ],
          ),
          DesktopGrid(
            cols: const <DesktopCol>[
              DesktopCol('日期', width: 104),
              DesktopCol('费用类型', width: 260),
              DesktopCol('金额', width: 120, right: true),
              DesktopCol('操作员', width: 96),
              DesktopCol('备注', width: 300),
              DesktopCol('操作', width: 140),
            ],
            emptyText: _category.isEmpty
                ? '所选区间没有开支记录，先在上方登记一笔'
                : '当前筛选「$_category」下没有记录，可以切回「全部类型」看看',
            rows: <DesktopRow>[
              for (final r in rows) DesktopRow(tag: wsI(r['id']), cells: _detailCells(r)),
            ],
            footer: <String>[
              '共 ${rows.length} 笔',
              '合计',
              wsMoney(_rangeSum),
              '',
              '',
              '',
            ],
          ),
        ],
      ),
    );
  }

  List<Widget> _detailCells(dynamic r) {
    final refType = wsS(r['ref_type']);
    final locked = refType.isNotEmpty;
    final unpaid = wsS(r['pay_status']) == 'unpaid';
    final badge = _refBadge(refType);
    return <Widget>[
      wsCell(wsS(r['date'])),
      Row(
        children: <Widget>[
          Flexible(
            child: Text(
              wsS(r['category'], fallback: '未分类'),
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 6),
          if (unpaid) const DesktopTag('待付', color: DesktopTag.unpaid),
          if (badge != null)
            Padding(
              padding: const EdgeInsets.only(left: 4),
              child: DesktopTag(badge.$1, color: badge.$2, tip: badge.$3),
            ),
        ],
      ),
      wsCell(wsMoney(wsD(r['amount'])), color: WsTokens.red, bold: true),
      wsCell(wsS(r['operator'], fallback: '—')),
      _remarkCell(wsS(r['remark'])),
      if (locked)
        const _MutedCell('随单据自动维护')
      else
        Row(
          children: <Widget>[
            DesktopLink('改', onPressed: () => _edit(r)),
            DesktopLink('删', color: WsTokens.red, onPressed: () => _delete(r)),
          ],
        ),
    ];
  }

  /// ref_type → badge 文案 / 颜色 / 提示（非空即自动镜像行）
  (String, Color, String)? _refBadge(String refType) {
    switch (refType) {
      case 'inbound_fee':
        return (
          '来自入库单·成本',
          WsTokens.primary,
          '入库运费/装卸费，报表期间费用里已剔除，只在待付款账单出现'
        );
      case 'inbound':
        return ('来自入库单', WsTokens.amber, '单据自动带出的金额调整，只影响开支、不改成本');
      case '':
        return null;
      default:
        return ('来自出库单', WsTokens.amber, '出库单自动带出的金额调整 / 费用，随出库单维护');
    }
  }

  /// 备注单元格：文本 + 附件小图标（图片点开看图弹窗）
  Widget _remarkCell(String remark) {
    final segs = _splitRemark(remark);
    if (segs.isEmpty) return wsCell('—', color: WsTokens.mutedLight);
    final text = segs.map((s) => s.text).join(' ').trim();
    final attaches = segs.where((s) => s.url.isNotEmpty).toList();
    return Row(
      children: <Widget>[
        Expanded(
          child: wsCell(text.isEmpty ? (attaches.isEmpty ? '—' : '（附件）') : text,
              color: text.isEmpty ? WsTokens.mutedLight : null),
        ),
        for (final a in attaches.take(3))
          Padding(
            padding: const EdgeInsets.only(left: 2),
            child: DesktopIconButton(
              icon: a.isImage ? Icons.image_outlined : Icons.attach_file,
              size: 22,
              tooltip: a.isImage ? '图片：${a.name}（点击预览）' : '附件：${a.name}（点击复制完整链接）',
              onPressed: () => _previewAttachment(a.url, a.name),
            ),
          ),
        if (attaches.length > 3)
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: Text('+${attaches.length - 3}',
                style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight)),
          ),
      ],
    );
  }
}

/// 只读的灰色说明格（自动镜像行的操作列）
class _MutedCell extends StatelessWidget {
  const _MutedCell(this.text);
  final String text;

  @override
  Widget build(BuildContext context) =>
      Text(text, style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight));
}
