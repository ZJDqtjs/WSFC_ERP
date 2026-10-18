import '../mobile/widgets/mobile_page.dart';
import '../mobile/widgets/parts.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../services/api_service.dart';

/// 主色/成功色，和 main.dart 的 AppBar、出库页保持一致
const Color _brand = Color(0xFF1989FA);
const Color _ok = Color(0xFF07C160);

// 后端 /api/products 回的是裸数组，字段时有时无（没入过库就没有 last_in_*），
// 这里统一收成可直接用的值，省得每个地方都写 ?? 和 as。
String _str(dynamic v) => v?.toString() ?? '';

double _num(dynamic v, {double fallback = 0}) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v.trim()) ?? fallback;
  return fallback;
}

int _id(dynamic v) {
  if (v is num) return v.toInt();
  return int.tryParse(_str(v)) ?? 0;
}

/// 数量展示：整数不带小数点，其余保留 2 位（库存和扣减倍数都会出现 2.5 这种）
String _qty(num v) => v == v.roundToDouble() ? v.toInt().toString() : v.toStringAsFixed(2);

/// 商品管理页：库存商品（大类）/ 订单商品（小类）两页签 + 搜索 + 批量操作 + 新增编辑。
///
/// 列表直接按接口返回的 Map 取字段，不套 Product 模型：接口字段比模型多
/// （last_in_* / stock_links / conversions / stock_value 等），按 Map 取才「以接口为准」，
/// 后端加字段也不用改模型。
class ProductsScreen extends StatefulWidget {
  const ProductsScreen({super.key});

  @override
  State<ProductsScreen> createState() => _ProductsScreenState();
}

class _ProductsScreenState extends State<ProductsScreen> with SingleTickerProviderStateMixin {
  /// 页签下标 → 后端 product_type 取值，顺序必须和 TabBar 文案一一对应
  static const List<String> _typeKeys = ['stock', 'order'];

  late final TabController _tabController;
  final NumberFormat _money = NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);

  List<dynamic> _products = [];
  List<dynamic> _units = [];
  List<dynamic> _stocks = [];
  bool _loading = false;
  bool _batchRunning = false;
  String _keyword = '';

  /// 空集合即普通模式；长按列表项进入多选
  final Set<int> _selected = {};

  bool get _selecting => _selected.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: _typeKeys.length, vsync: this);
    // 切页签就退出多选：勾的是另一个页签的商品时，批量结果对用户来说莫名其妙
    _tabController.addListener(_onTabChanged);
    _loadProducts();
    _loadRefs();
  }

  @override
  void dispose() {
    _tabController.removeListener(_onTabChanged);
    _tabController.dispose();
    super.dispose();
  }

  void _onTabChanged() {
    if (_tabController.indexIsChanging && _selected.isNotEmpty) _exitSelect();
  }

  /// 异常统一走这里：ApiException.message 就是后端给的中文 detail，可直接展示
  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Colors.red.shade600 : Colors.grey.shade700,
      duration: Duration(seconds: msg.length > 40 ? 6 : 3),
    ));
  }

  // ---------------- 数据 ----------------

  Future<void> _loadProducts() async {
    setState(() => _loading = true);
    try {
      final data = await ApiService.products();
      if (!mounted) return;
      setState(() {
        _products = data;
        // 刷新后把已经不存在的勾选剔掉，免得把已删除的 id 再发给批量接口
        final alive = data.map((p) => _id(p['id'])).toSet();
        _selected.removeWhere((id) => !alive.contains(id));
      });
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 单位表 + 库存大类表只有表单要用，失败不影响列表，所以不占用 loading
  Future<void> _loadRefs() async {
    try {
      final refs = await Future.wait(<Future<List<dynamic>>>[
        ApiService.units(),
        ApiService.stocks(),
      ]);
      if (mounted) {
        setState(() {
          _units = refs[0];
          _stocks = refs[1];
        });
      }
    } on ApiException catch (e) {
      _toast('表单需要的单位/大类数据加载失败：${e.message}', error: true);
    }
  }

  /// 当前页签 + 关键字（名称 / 类别 / 编码）过滤；后端没有搜索参数，前端过滤够用
  List<dynamic> _visible(int tabIndex) {
    final type = _typeKeys[tabIndex];
    final k = _keyword.trim().toLowerCase();
    return _products.where((p) {
      final pt = _str(p['product_type']);
      if ((pt.isEmpty ? 'stock' : pt) != type) return false;
      if (k.isEmpty) return true;
      return _str(p['name']).toLowerCase().contains(k) ||
          _str(p['category']).toLowerCase().contains(k) ||
          _str(p['code']).toLowerCase().contains(k);
    }).toList();
  }

  /// 已有类别：批量改类别和表单类别的候选，免得手打错字造出「疏菜 / 蔬菜」两个类别
  List<String> get _categories {
    final set = <String>{};
    for (final p in _products) {
      final c = _str(p['category']).trim();
      if (c.isNotEmpty) set.add(c);
    }
    return set.toList()..sort();
  }

  // ---------------- 多选 ----------------

  void _toggle(int id) {
    setState(() {
      if (_selected.contains(id)) {
        _selected.remove(id);
      } else {
        _selected.add(id);
      }
    });
  }

  void _exitSelect() {
    if (_selected.isNotEmpty) setState(() => _selected.clear());
  }

  void _selectAll(int tabIndex) {
    final ids = _visible(tabIndex).map((p) => _id(p['id'])).toList();
    final allSelected = ids.isNotEmpty && ids.every(_selected.contains);
    setState(() {
      if (allSelected) {
        _selected.removeAll(ids);
      } else {
        _selected.addAll(ids);
      }
    });
  }

  // ---------------- 批量操作 ----------------

  Future<void> _batchActive(bool active) async {
    final ids = _selected.toList();
    if (ids.isEmpty) return;
    setState(() => _batchRunning = true);
    try {
      final data = await ApiService.batchUpdateProducts(ids, {'is_active': active});
      final verb = active ? '启用' : '停用';
      _toast('已$verb ${_id(data['updated'])} 个商品');
      _exitSelect();
      await _loadProducts();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } finally {
      if (mounted) setState(() => _batchRunning = false);
    }
  }

  Future<void> _batchDelete() async {
    final ids = _selected.toList();
    if (ids.isEmpty) return;
    final count = ids.length;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('批量删除'),
        content: Text('删除选中的 $count 个商品？被单据或其它商品引用的不会被删掉，结果里会说明原因。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade600),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _batchRunning = true);
    try {
      final data = await ApiService.batchDeleteProducts(ids);
      final deleted = _id(data['deleted']);
      final blocked = (data['blocked_items'] as List?) ?? const [];
      _exitSelect();
      await _loadProducts();
      if (blocked.isEmpty) {
        _toast('已删除 $deleted 个商品');
      } else {
        // 被引用挡住的条目必须逐个给出原因：只说「删了 3 个」而用户勾了 5 个，
        // 没人能猜出剩下两个为什么还在，只能回网页端查。
        await _showBlockedDialog(deleted, blocked);
      }
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } finally {
      if (mounted) setState(() => _batchRunning = false);
    }
  }

  Future<void> _showBlockedDialog(int deleted, List<dynamic> blocked) async {
    if (!mounted) return;
    final blockedCount = blocked.length;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('已删除 $deleted 个，$blockedCount 个被引用挡住'),
        content: SizedBox(
          width: MediaQuery.of(dialogContext).size.width - 72,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final b in blocked) ...[
                  Text(_str(b['name']), style: const TextStyle(fontWeight: FontWeight.w600)),
                  for (final s in ((b['sources'] as List?) ?? const []))
                    Padding(
                      padding: const EdgeInsets.only(left: 8, bottom: 2),
                      child: Text('· ${_str(s)}',
                          style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                    ),
                  const SizedBox(height: 8),
                ],
              ],
            ),
          ),
        ),
        actions: [
          FilledButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('知道了')),
        ],
      ),
    );
  }

  Future<void> _batchCategory() async {
    final ids = _selected.toList();
    if (ids.isEmpty) return;
    final cat = await _askCategory(ids.length);
    if (cat == null || cat.isEmpty) return;
    setState(() => _batchRunning = true);
    try {
      final data = await ApiService.batchUpdateProducts(ids, {'category': cat});
      _toast('已把 ${_id(data['updated'])} 个商品归入「$cat」');
      _exitSelect();
      await _loadProducts();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    } finally {
      if (mounted) setState(() => _batchRunning = false);
    }
  }

  Future<String?> _askCategory(int count) async {
    final controller = TextEditingController();
    final candidates = _categories;
    final result = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('批量改类别（$count 个）'),
        content: SizedBox(
          width: MediaQuery.of(dialogContext).size.width - 72,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: controller,
                autofocus: true,
                decoration: const InputDecoration(
                  labelText: '新类别',
                  helperText: '直接覆盖所选商品的类别',
                  isDense: true,
                  border: OutlineInputBorder(),
                ),
              ),
              if (candidates.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text('已有类别', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                const SizedBox(height: 4),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final c in candidates)
                      ActionChip(
                        label: Text(c),
                        visualDensity: VisualDensity.compact,
                        onPressed: () => controller.text = c,
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, controller.text.trim()),
            child: const Text('确定'),
          ),
        ],
      ),
    );
    controller.dispose();
    return result;
  }

  /// 单个商品启停：后端只有 batch-update（没有单条 PATCH），所以复用批量接口传一个 id
  Future<void> _toggleActive(dynamic p) async {
    final id = _id(p['id']);
    if (id <= 0) return;
    final active = p['is_active'] != false;
    try {
      await ApiService.batchUpdateProducts([id], {'is_active': !active});
      _toast(active ? '已停用' : '已启用');
      await _loadProducts();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Future<void> _deleteOne(dynamic p) async {
    final id = _id(p['id']);
    if (id <= 0) return;
    final name = _str(p['name']);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('删除「$name」？'),
        content: const Text('删除后不可恢复；被单据引用时后端会拒绝，原因会原样显示。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade600),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ApiService.deleteProduct(id);
      _toast('已删除');
      await _loadProducts();
    } on ApiException catch (e) {
      // detail 本身就是多行中文说明，原样展示比前端再拼一遍更准
      _toast(e.message, error: true);
    }
  }

  // ---------------- 表单入口 ----------------

  Future<void> _openForm([dynamic preset]) async {
    // 单位表 / 库存大类可能还没回来（首屏那次失败过），打开表单前兜一次
    if (_units.isEmpty || _stocks.isEmpty) await _loadRefs();
    if (!mounted) return;
    final maxHeight = MediaQuery.of(context).size.height * 0.92;
    final units = _units;
    final stocks = _stocks;
    final categories = _categories;
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: Colors.white,
      constraints: BoxConstraints(maxHeight: maxHeight),
      builder: (sheetContext) => _ProductFormSheet(
        product: preset,
        units: units,
        stocks: stocks,
        categories: categories,
      ),
    );
    if (saved == true) {
      _toast(preset == null ? '已新增商品' : '已保存修改');
      await _loadProducts();
    }
  }

  /// 搜索框自己的控制器：清空按钮要能真的把输入清掉（只改 _keyword 的话文字还在框里）
  final TextEditingController _searchCtrl = TextEditingController();

  // ---------------- 界面 ----------------

  @override
  Widget build(BuildContext context) {
    return MobilePage(
      title: _selecting ? '已选 ${_selected.length} 项' : '商品',
      back: true,
      actions: _selecting
          ? [
              pageAction(
                Icons.select_all,
                () => _selectAll(_tabController.index),
                tooltip: '全选 / 取消全选',
              ),
              pageAction(Icons.sell_outlined, _batchCategory, tooltip: '批量改类别'),
              pageAction(
                  Icons.play_circle_outline, () => _batchActive(true), tooltip: '批量启用'),
              pageAction(
                  Icons.pause_circle_outline, () => _batchActive(false), tooltip: '批量停用'),
              pageAction(Icons.delete_outline, _batchDelete, tooltip: '批量删除'),
              pageAction(Icons.close_rounded, _exitSelect, tooltip: '退出多选'),
            ]
          : [
              pageAction(Icons.refresh_rounded, _loadProducts, tooltip: '刷新'),
            ],
      underBar: AnimatedBuilder(
        animation: _tabController,
        builder: (BuildContext context, Widget? child) => GlassSegmentedControl(
          height: 38,
          selectedIndex: _tabController.index,
          onSegmentSelected: (int i) => _tabController.animateTo(i),
          segments: const <GlassSegment>[
            GlassSegment(label: '库存商品'),
            GlassSegment(label: '订单商品'),
          ],
        ),
      ),
      floating: _selecting
          ? null
          : GlassButton(
              icon: const Icon(Icons.add),
              label: '新增商品',
              width: 124,
              height: 50,
              onTap: () => _openForm(),
            ),
      body: Column(
        children: [
          _searchBar(),
          if (_batchRunning) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [_buildList(0), _buildList(1)],
            ),
          ),
        ],
      ),
    );
  }

  Widget _searchBar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 2),
      child: TextField(
        controller: _searchCtrl,
        onChanged: (v) => setState(() => _keyword = v),
        textInputAction: TextInputAction.search,
        decoration: InputDecoration(
          hintText: '搜索名称 / 类别 / 编码',
          prefixIcon: const Icon(Icons.search, size: 20),
          isDense: true,
          suffixIcon: _keyword.isEmpty
              ? null
              : IconButton(
                  icon: const Icon(Icons.clear, size: 18),
                  tooltip: '清空',
                  onPressed: () {
                    _searchCtrl.clear();
                    setState(() => _keyword = '');
                  },
                ),
        ),
      ),
    );
  }

  Widget _buildList(int tabIndex) {
    if (_loading && _products.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    final rows = _visible(tabIndex);
    return RefreshIndicator(
      onRefresh: _loadProducts,
      child: rows.isEmpty
          ? ListView(
              children: [
                const SizedBox(height: 120),
                Center(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 32),
                    child: Text(
                      _keyword.trim().isEmpty
                          ? '这个页签还没有商品，点右下角「新增商品」开始建品'
                          : '没有匹配「${_keyword.trim()}」的商品',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.grey.shade600),
                    ),
                  ),
                ),
              ],
            )
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 96),
              itemCount: rows.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (_, i) => _productCard(rows[i]),
            ),
    );
  }

  Widget _productCard(dynamic p) {
    final id = _id(p['id']);
    final selected = _selected.contains(id);
    final active = p['is_active'] != false;
    final name = _str(p['name']);
    final category = _str(p['category']);
    final code = _str(p['code']);
    final unit = _unitText(p);
    final stock = _num(p['stock']);
    final isOrder = _str(p['product_type']) == 'order';
    final packs = (p['pack_items'] as List?) ?? const [];
    return GCard(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: _selecting ? () => _toggle(id) : () => _openForm(p),
        onLongPress: _selecting ? null : () => _toggle(id),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (_selecting)
                Padding(
                  padding: const EdgeInsets.only(top: 2, right: 4),
                  child: Icon(
                    selected ? Icons.check_circle : Icons.circle_outlined,
                    color: selected ? _brand : Colors.grey.shade400,
                    size: 20,
                  ),
                ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontWeight: FontWeight.w600, fontSize: 15),
                          ),
                        ),
                        if (!active)
                          _tag('停用', const Color(0xFFF2F2F2), Colors.grey.shade700),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        _tag(category.isEmpty ? '未分类' : category,
                            const Color(0xFFEAF7FF), _brand),
                        if (code.isNotEmpty)
                          _tag(code, const Color(0xFFF5F5F5), Colors.grey.shade700),
                        if (p['free_shipping'] == true)
                          _tag('包邮', const Color(0xFFEFFAF2), _ok),
                        if (packs.isNotEmpty)
                          _tag('打包 ${packs.length} 项', const Color(0xFFFFF7E6),
                              const Color(0xFFD48806)),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        _tag('库存 ${_qty(stock)} $unit', const Color(0xFFF2F6FF),
                            const Color(0xFF2F54EB)),
                        _tag('均价 ${_money.format(_num(p['avg_cost']))}/$unit',
                            const Color(0xFFF2F6FF), const Color(0xFF2F54EB)),
                        _tag('售价 ${_money.format(_num(p['sale_price']))}',
                            const Color(0xFFEFFAF2), active ? _ok : Colors.grey.shade500),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      _lastInText(p),
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                    ),
                    if (isOrder)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          _deductText(p),
                          style: TextStyle(
                              fontSize: 12, color: Colors.grey.shade700),
                        ),
                      ),
                  ],
                ),
              ),
              if (!_selecting)
                PopupMenuButton<String>(
                  tooltip: '更多',
                  onSelected: (v) {
                    if (v == 'edit') {
                      _openForm(p);
                    } else if (v == 'toggle') {
                      _toggleActive(p);
                    } else if (v == 'delete') {
                      _deleteOne(p);
                    }
                  },
                  itemBuilder: (_) => [
                    const PopupMenuItem(value: 'edit', child: Text('编辑')),
                    PopupMenuItem(
                        value: 'toggle', child: Text(active ? '停用' : '启用')),
                    const PopupMenuItem(
                        value: 'delete', child: Text('删除')),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// 商品默认单位（表单/列表都按它显示数量；缺了退回基础单位）
  String _unitText(dynamic p) {
    final d = _str(p['default_unit']);
    if (d.isNotEmpty) return d;
    final b = _str(p['base_unit']);
    return b.isEmpty ? '个' : b;
  }

  /// 最近入库价：后端给的是「基础单位价」和「最近一次录入的单位价」两套口径
  String _lastInText(dynamic p) {
    final date = _str(p['last_in_date']);
    final basePrice = _num(p['last_in_price']);
    final unitPrice = _num(p['last_in_unit_price']);
    final unit = _str(p['last_in_unit']);
    if (date.isEmpty && basePrice <= 0) return '还没有入库记录';
    final prefix = date.isEmpty ? '最近入库' : '最近入库 $date';
    if (unit.isEmpty) return '$prefix ${_money.format(basePrice)}';
    return '$prefix ${_money.format(unitPrice)}/$unit';
  }

  /// 订单商品的扣减口径：多关联时逐条列出「大类 ×倍数 单位」
  String _deductText(dynamic p) {
    final links = (p['stock_links'] as List?) ?? const [];
    if (links.isEmpty) return '扣减：未关联库存大类（下单不会扣库存）';
    final parts = <String>[];
    for (final it in links) {
      final m = it is Map ? it : const {};
      final name = _str(m['name']);
      final mult = _num(m['multiplier'], fallback: 1);
      final u = _str(m['default_unit']);
      parts.add(u.isEmpty ? '$name ×${_qty(mult)}' : '$name ×${_qty(mult)} $u');
    }
    return '扣减 ${parts.join('、')}';
  }

  Widget _tag(String text, Color background, Color foreground) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(text, style: TextStyle(fontSize: 11, color: foreground)),
    );
  }
}
/// 换算表的一行：1 [unit] = [factor] 个基础单位
class _ConvRow {
  _ConvRow({String unit = '', String factor = ''})
      : unitCtrl = TextEditingController(text: unit),
        factorCtrl = TextEditingController(text: factor);

  final TextEditingController unitCtrl;
  final TextEditingController factorCtrl;
}

/// 一条「订单商品 → 库存大类」的扣减关联（倍数 = 卖 1 个订单商品扣多少个库存默认单位）
class _LinkRow {
  _LinkRow({required this.id, required this.name, String multiplier = '1'})
      : multiplierCtrl = TextEditingController(text: multiplier);

  final int id;
  final String name;
  final TextEditingController multiplierCtrl;
}

/// 新增 / 编辑商品表单。product 为 null 表示新增，否则是 /api/products 里的一条 Map。
/// 保存成功 pop(true)，由列表页提示并刷新。
class _ProductFormSheet extends StatefulWidget {
  const _ProductFormSheet({
    required this.units,
    required this.stocks,
    required this.categories,
    this.product,
  });

  final List<dynamic> units;
  final List<dynamic> stocks;
  final List<String> categories;
  final dynamic product;

  @override
  State<_ProductFormSheet> createState() => _ProductFormSheetState();
}

class _ProductFormSheetState extends State<_ProductFormSheet> {
  static const TextInputType _numKeyboard =
      TextInputType.numberWithOptions(decimal: true, signed: false);

  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _code = TextEditingController();
  final _category = TextEditingController();
  final _spec = TextEditingController();
  final _baseUnit = TextEditingController(text: '克');
  final _sale = TextEditingController();
  final _cost = TextEditingController();
  final _weight = TextEditingController();
  final _packFee = TextEditingController();
  final List<_ConvRow> _convs = [];
  final List<_LinkRow> _links = [];

  String _type = 'stock';
  String _defaultUnit = '';
  bool _freeShipping = false;
  bool _active = true;
  bool _saving = false;

  /// 组合装清单不在移动端维护，但 PUT 是全量覆盖，所以编辑时必须原样带回
  List<dynamic> _packItems = [];

  bool get _isEdit => widget.product is Map;

  @override
  void initState() {
    super.initState();
    final p = widget.product;
    if (p is Map) {
      final t = _str(p['product_type']);
      _type = t.isEmpty ? 'stock' : t;
      _name.text = _str(p['name']);
      _code.text = _str(p['code']);
      _category.text = _str(p['category']);
      _spec.text = _str(p['spec']);
      final base = _str(p['base_unit']);
      _baseUnit.text = base.isEmpty ? '克' : base;
      _defaultUnit = _str(p['default_unit']);
      _sale.text = _numText(p['sale_price']);
      _cost.text = _numText(p['unit_cost']);
      _weight.text = _numText(p['weight_kg']);
      _packFee.text = _numText(p['pack_fee']);
      _freeShipping = p['free_shipping'] == true;
      _active = p['is_active'] != false;
      _packItems = (p['pack_items'] as List?) ?? const [];
      final conv = p['conversions'];
      if (conv is Map) {
        conv.forEach((k, v) {
          final unit = _str(k);
          if (unit.isEmpty || unit == _baseUnit.text) return;
          _convs.add(_ConvRow(unit: unit, factor: _numText(v)));
        });
      }
      final links = (p['stock_links'] as List?) ?? const [];
      for (final it in links) {
        final m = it is Map ? it : const <String, dynamic>{};
        _links.add(_LinkRow(
          id: _id(m['product_id']),
          name: _str(m['name']),
          multiplier: _numText(m['multiplier'], fallback: 1),
        ));
      }
    }
    if (_defaultUnit.isEmpty) _defaultUnit = _baseUnit.text;
    if (_convs.isEmpty) _convs.add(_ConvRow());
  }

  @override
  void dispose() {
    for (final c in [_name, _code, _category, _spec, _baseUnit, _sale, _cost, _weight, _packFee]) {
      c.dispose();
    }
    for (final r in _convs) {
      r.unitCtrl.dispose();
      r.factorCtrl.dispose();
    }
    for (final l in _links) {
      l.multiplierCtrl.dispose();
    }
    super.dispose();
  }

  String get baseLabel => _baseUnit.text.trim().isEmpty ? '克' : _baseUnit.text.trim();

  String get unitLabel {
    final d = _defaultUnit.trim();
    return d.isEmpty ? baseLabel : d;
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Colors.red.shade600 : Colors.grey.shade700,
      duration: Duration(seconds: msg.length > 40 ? 6 : 3),
    ));
  }

  Widget _section(String title) {
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 8),
      child: Text(title,
          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
    );
  }

  String _stockName(int id) {
    for (final s in widget.stocks) {
      if (_id(s['id']) == id) return _str(s['name']);
    }
    return '商品 #$id';
  }

  /// 多选扣减关联：返回 null 表示用户取消（原样保留），返回空数组表示清空成「代发」
  Future<void> _pickStocks() async {
    final picked = await showModalBottomSheet<List<int>>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.8),
      builder: (_) => _StockMultiPicker(
        stocks: widget.stocks,
        selectedIds: _links.map((l) => l.id).toList(),
      ),
    );
    if (picked == null || !mounted) return;
    setState(() {
      final keep = <int, _LinkRow>{for (final l in _links) l.id: l};
      final next = <_LinkRow>[];
      for (final id in picked) {
        next.add(keep[id] ?? _LinkRow(id: id, name: _stockName(id)));
      }
      _links
        ..clear()
        ..addAll(next);
    });
  }

  Widget _convRow(_ConvRow r) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Expanded(
            flex: 3,
            child: TextField(
              controller: r.unitCtrl,
              decoration: const InputDecoration(
                labelText: '单位',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 6),
            child: Text('='),
          ),
          Expanded(
            flex: 3,
            child: TextField(
              controller: r.factorCtrl,
              keyboardType: _numKeyboard,
              decoration: InputDecoration(
                labelText: baseLabel,
                isDense: true,
                border: const OutlineInputBorder(),
              ),
            ),
          ),
          IconButton(
            tooltip: '删除这一行',
            icon: const Icon(Icons.remove_circle_outline, size: 20),
            onPressed: () => setState(() => _convs.remove(r)),
          ),
        ],
      ),
    );
  }

  Widget _linkRow(_LinkRow l) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(l.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13)),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 88,
            child: TextField(
              controller: l.multiplierCtrl,
              keyboardType: _numKeyboard,
              textAlign: TextAlign.right,
              decoration: const InputDecoration(
                labelText: '倍数',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
          ),
          IconButton(
            tooltip: '不再关联',
            icon: const Icon(Icons.link_off, size: 20),
            onPressed: () => setState(() => _links.remove(l)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final unitNames = <String>[];
    for (final u in widget.units) {
      final n = _str(u['name']);
      if (n.isNotEmpty && !unitNames.contains(n)) unitNames.add(n);
    }
    final defaultOptions = <String>{baseLabel};
    for (final r in _convs) {
      final u = r.unitCtrl.text.trim();
      if (u.isNotEmpty) defaultOptions.add(u);
    }
    if (_defaultUnit.isNotEmpty) defaultOptions.add(_defaultUnit);

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Form(
        key: _formKey,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(_isEdit ? '编辑商品' : '新增商品',
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.bold)),
                  ),
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('取消'),
                  ),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _section('基本信息'),
                    TextFormField(
                      controller: _name,
                      decoration: const InputDecoration(
                        labelText: '商品名称',
                        isDense: true,
                        border: OutlineInputBorder(),
                      ),
                      validator: (v) =>
                          (v ?? '').trim().isEmpty ? '请填写商品名称' : null,
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: TextFormField(
                            controller: _code,
                            decoration: const InputDecoration(
                              labelText: '商品编码',
                              helperText: '平台货号可留空',
                              isDense: true,
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: TextFormField(
                            controller: _spec,
                            decoration: const InputDecoration(
                              labelText: '规格',
                              isDense: true,
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    TextFormField(
                      controller: _category,
                      decoration: const InputDecoration(
                        labelText: '类别',
                        helperText: '用于筛选与汇总，建议复用已有类别',
                        isDense: true,
                        border: OutlineInputBorder(),
                      ),
                    ),
                    if (widget.categories.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final c in widget.categories.take(12))
                            ActionChip(
                              label: Text(c),
                              visualDensity: VisualDensity.compact,
                              onPressed: () =>
                                  setState(() => _category.text = c),
                            ),
                        ],
                      ),
                    ],
                    const SizedBox(height: 10),
                    Text('商品类型', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 8,
                      children: [
                        ChoiceChip(
                          label: const Text('库存商品（大类）'),
                          selected: _type == 'stock',
                          onSelected: (_) => setState(() => _type = 'stock'),
                        ),
                        ChoiceChip(
                          label: const Text('订单商品（小类）'),
                          selected: _type == 'order',
                          onSelected: (_) => setState(() => _type = 'order'),
                        ),
                      ],
                    ),
                    const Divider(height: 24),
                    _section('单位与换算'),
                    TextFormField(
                      controller: _baseUnit,
                      decoration: const InputDecoration(
                        labelText: '基础单位',
                        isDense: true,
                        border: OutlineInputBorder(),
                      ),
                      onChanged: (_) => setState(() {}),
                    ),
                    if (unitNames.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final u in unitNames.take(12))
                            ActionChip(
                              label: Text(u),
                              visualDensity: VisualDensity.compact,
                              onPressed: () => setState(() {
                                _baseUnit.text = u;
                                _defaultUnit = u;
                              }),
                            ),
                        ],
                      ),
                    ],
                    const SizedBox(height: 10),
                    Text(
                      '基础单位「$baseLabel」恒等于 1，其它单位填 1 个它等于几个基础单位',
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                    ),
                    const SizedBox(height: 6),
                    for (final r in _convs) _convRow(r),
                    OutlinedButton.icon(
                      onPressed: () => setState(() => _convs.add(_ConvRow())),
                      icon: const Icon(Icons.add, size: 18),
                      label: const Text('加一行换算'),
                    ),
                    const SizedBox(height: 10),
                    DropdownButtonFormField<String>(
                      initialValue: defaultOptions.contains(_defaultUnit)
                          ? _defaultUnit
                          : baseLabel,
                      decoration: const InputDecoration(
                        labelText: '默认单位',
                        helperText: '库存与均价都按默认单位展示，必须出现在换算表里',
                        isDense: true,
                        border: OutlineInputBorder(),
                      ),
                      items: [
                        for (final u in defaultOptions.toList()..sort())
                          DropdownMenuItem(value: u, child: Text(u)),
                      ],
                      onChanged: (v) => setState(() => _defaultUnit = v ?? baseLabel),
                    ),
                    const Divider(height: 24),
                    _section('价格与规格'),
                    Row(
                      children: [
                        Expanded(
                          child: TextFormField(
                            controller: _sale,
                            keyboardType: _numKeyboard,
                            decoration: InputDecoration(
                              labelText: '售价 / $unitLabel',
                              isDense: true,
                              border: const OutlineInputBorder(),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: TextFormField(
                            controller: _cost,
                            keyboardType: _numKeyboard,
                            decoration: InputDecoration(
                              labelText: '成本 / $unitLabel',
                              isDense: true,
                              border: const OutlineInputBorder(),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: TextFormField(
                            controller: _weight,
                            keyboardType: _numKeyboard,
                            decoration: const InputDecoration(
                              labelText: '重量 kg',
                              isDense: true,
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: TextFormField(
                            controller: _packFee,
                            keyboardType: _numKeyboard,
                            decoration: const InputDecoration(
                              labelText: '打包费',
                              isDense: true,
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                      ],
                    ),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _freeShipping,
                      onChanged: (v) => setState(() => _freeShipping = v),
                      title: const Text('包邮（快递费不由客户承担）'),
                      dense: true,
                    ),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _active,
                      onChanged: (v) => setState(() => _active = v),
                      title: const Text('启用（停用后不再出现在选择列表）'),
                      dense: true,
                    ),
                    const Divider(height: 24),
                    _section('关联库存商品'),
                    if (_type == 'order') ...[
                      if (widget.stocks.isEmpty)
                        Text('库存大类为空，请先到「库存商品（大类）」页签新增',
                            style: TextStyle(
                                fontSize: 12, color: Colors.grey.shade600)),
                      for (final l in _links) _linkRow(l),
                      const SizedBox(height: 4),
                      OutlinedButton.icon(
                        onPressed: _pickStocks,
                        icon: const Icon(Icons.add_link, size: 18),
                        label: Text(_links.isEmpty ? '选择库存商品' : '继续添加关联'),
                      ),
                    ] else
                      Text('库存大类本身不扣减别的商品；切到「订单商品（小类）」才能配扣减关联。',
                          style:
                              TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                    const SizedBox(height: 14),
                    Text('打包商品（组合装）请在网页端维护；这里保存时原样带回，不会被清空。',
                        style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                  ],
                ),
              ),
            ),
            _buildFooter(),
          ],
        ),
      ),
    );
  }

  Widget _buildFooter() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: _saving ? null : () => Navigator.pop(context),
                child: const Text('取消'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: 2,
              child: FilledButton(
                onPressed: _saving ? null : _submit,
                style: FilledButton.styleFrom(backgroundColor: _brand),
                child: Text(_saving ? '保存中…' : '保存'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  double _numOr(String s) => double.tryParse(s.trim()) ?? 0;

  Map<String, dynamic>? _collect() {
    final base = baseLabel;
    final conversions = <String, double>{base: 1};
    for (final r in _convs) {
      final unit = r.unitCtrl.text.trim();
      if (unit.isEmpty || unit == base) continue;
      final factor = double.tryParse(r.factorCtrl.text.trim());
      if (factor == null || factor <= 0) {
        _toast('换算「$unit」的系数要填大于 0 的数字', error: true);
        return null;
      }
      conversions[unit] = factor;
    }

    var def = _defaultUnit.trim();
    if (def.isEmpty) def = base;
    // 后端把 default_unit 当换算表的键来折算库存与均价，缺键会算错，这里拦住
    if (!conversions.containsKey(def)) {
      _toast('默认单位「$def」不在换算表里，请补一行换算', error: true);
      return null;
    }

    final links = <Map<String, dynamic>>[];
    if (_type == 'order') {
      for (final l in _links) {
        final m = double.tryParse(l.multiplierCtrl.text.trim());
        if (m == null || m <= 0) {
          _toast('「${l.name}」的扣减倍数要大于 0', error: true);
          return null;
        }
        links.add(<String, dynamic>{'product_id': l.id, 'multiplier': m});
      }
    }

    return <String, dynamic>{
      'code': _code.text.trim(),
      'name': _name.text.trim(),
      'category': _category.text.trim(),
      'product_type': _type,
      'base_unit': base,
      'default_unit': def,
      'spec': _spec.text.trim(),
      'sale_price': _numOr(_sale.text),
      'unit_cost': _numOr(_cost.text),
      'weight_kg': _numOr(_weight.text),
      'pack_fee': _numOr(_packFee.text),
      'free_shipping': _freeShipping,
      'is_active': _active,
      'conversions': conversions,
      // PUT 是全量覆盖：组合装清单不在移动端编辑，也必须原样带回
      'pack_items': _packItems,
      'stock_links': links,
      // 旧的两个单关联键后端会按第一条 links 回填，这里一并给上，避免旧口径读出来是空
      'stock_product_id': links.isEmpty ? 0 : _id(links.first['product_id']),
      'multiplier': links.isEmpty ? 1.0 : _num(links.first['multiplier'], fallback: 1),
    };
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final body = _collect();
    if (body == null) return;
    setState(() => _saving = true);
    try {
      final id = _id(widget.product is Map ? widget.product['id'] : null);
      if (id > 0) {
        await ApiService.updateProduct(id, body);
      } else {
        await ApiService.createProduct(body);
      }
      if (!mounted) return;
      Navigator.pop(context, true);
    } on ApiException catch (e) {
      // 同名 / 类型非法 / 关联的大类不存在 都是后端给的中文原因，别自己编
      _toast(e.message, error: true);
      if (mounted) setState(() => _saving = false);
    }
  }
}

/// 库存大类多选弹层：一次拉全量后本地过滤（大类只有几十到几百条）
class _StockMultiPicker extends StatefulWidget {
  const _StockMultiPicker({required this.stocks, required this.selectedIds});

  final List<dynamic> stocks;
  final List<int> selectedIds;

  @override
  State<_StockMultiPicker> createState() => _StockMultiPickerState();
}

class _StockMultiPickerState extends State<_StockMultiPicker> {
  late final List<int> _picked = [...widget.selectedIds];
  String _keyword = '';

  List<dynamic> get _filtered {
    final k = _keyword.trim().toLowerCase();
    if (k.isEmpty) return widget.stocks;
    return widget.stocks
        .where((s) =>
            _str(s['name']).toLowerCase().contains(k) ||
            _str(s['category']).toLowerCase().contains(k))
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final list = _filtered;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('选择库存商品（${_picked.length} 已选）',
                  style: const TextStyle(
                      fontSize: 16, fontWeight: FontWeight.bold)),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextField(
              autofocus: true,
              onChanged: (v) => setState(() => _keyword = v),
              decoration: const InputDecoration(
                hintText: '搜索名称 / 类别',
                prefixIcon: Icon(Icons.search),
                isDense: true,
              ),
            ),
          ),
          const SizedBox(height: 4),
          Flexible(
            child: list.isEmpty
                ? const Padding(
                    padding: EdgeInsets.symmetric(vertical: 32),
                    child: Text('没有匹配的库存商品'),
                  )
                : ListView.builder(
                    shrinkWrap: true,
                    itemCount: list.length,
                    itemBuilder: (_, i) {
                      final s = list[i];
                      final id = _id(s['id']);
                      final checked = _picked.contains(id);
                      final category = _str(s['category']);
                      final unit = _str(s['default_unit']).isEmpty
                          ? _str(s['base_unit'])
                          : _str(s['default_unit']);
                      return CheckboxListTile(
                        value: checked,
                        dense: true,
                        title: Text(_str(s['name'])),
                        subtitle: Text(
                          '${category.isEmpty ? '未分类' : category} · 单位 $unit',
                          style: const TextStyle(fontSize: 12),
                        ),
                        onChanged: (v) => setState(() {
                          if (v == true) {
                            _picked.add(id);
                          } else {
                            _picked.remove(id);
                          }
                        }),
                      );
                    },
                  ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: _brand),
                  onPressed: () => Navigator.pop(context, _picked),
                  child: const Text('确定'),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 数字转输入框文本：整数不带小数点，其余去掉多余的 0
String _numText(dynamic v, {double fallback = 0}) {
  final d = _num(v, fallback: fallback);
  if (d == d.roundToDouble()) return d.toInt().toString();
  return d.toString();
}
