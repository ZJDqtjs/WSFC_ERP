import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../fluent_theme.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';

/// 桌面端「商品资料」，1:1 复刻 web #page-products（商品 / 关联结算 / 包材 / 人工
/// 四个侧边栏入口共用这一页，只是进来时预置了筛选条件，见 [DesktopProductsScreen.preset]）。
///
/// 数据口径与网页端一致：
/// - `/api/products` 一次拉全量（含停用），Tab（product_type: stock/order）、分类、关键字、
///   状态全部在本页面过滤，表头点击排序也只动本地列表，不重新请求；
/// - 参考成本（avg_cost）与库存（stock）这两列显示的是换算后的值，排序按显示值算
///   （网页端 `renderProducts` 里的 `t._sortVal` 同一口径）；
/// - 增改都走 `/api/products` + `/api/products/{id}`（PUT 全量覆盖：pack_items / stock_links
///   必须整表带回，否则会被清空）；批量走 batch-update / batch-delete；
/// - 换基础单位（计数「个」↔ 重量「克」）时后端 `_rescale_base_unit_change` 要求已有流水的
///   商品必须给 `unit_change_ratio`，这里按是否有历史数据判定：有历史就必填，
///   确实没有出入库流水可以勾选跳过（与网页端「留空即可」一致）。
class DesktopProductsScreen extends StatefulWidget {
  const DesktopProductsScreen({super.key, required this.auth, required this.onNavigate, this.preset});
  final AuthProvider auth;
  final void Function(String route) onNavigate;

  /// 'stock'=商品、'order'=关联结算、'pack'=包材、'labor'=人工、null=不预设
  final String? preset;

  @override
  State<DesktopProductsScreen> createState() => _DesktopProductsScreenState();
}

// ================================================================ 数据小工具

Map<String, dynamic> _asMap(dynamic v) =>
    v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

List<Map<String, dynamic>> _asMapList(dynamic v) {
  if (v is! List) return const [];
  return [for (final e in v) _asMap(e)];
}

/// 与网页端 fmtNum 一致：整数不带小数，小数最多 4 位且去尾零
String _qty(dynamic v) {
  final double d = wsD(v);
  if ((d - d.roundToDouble()).abs() < 1e-6) return d.round().toString();
  return double.parse(d.toStringAsFixed(4)).toString();
}

/// 输入框文本：整数不带小数点，其余原样（0 显示空，避免一堆 0.00 要手删）
String _plain(double v) {
  if (v == 0) return '';
  final double r = double.parse(v.toStringAsFixed(8));
  if (r == r.roundToDouble()) return r.round().toString();
  return r.toString();
}

double _textNum(TextEditingController c) => double.tryParse(c.text.trim()) ?? 0;

/// 商品类型（老数据可能没有 product_type，按库存商品处理，与网页端一致）
String _typeOf(Map<String, dynamic> p) {
  final String t = wsS(p['product_type']);
  return t.isEmpty ? 'stock' : t;
}

/// 展示单位（web 的 defaultUnit）
String _unitOf(Map<String, dynamic> p) {
  final String du = wsS(p['default_unit']);
  if (du.isNotEmpty) return du;
  return wsS(p['base_unit']);
}

Map<String, double> _convOf(Map<String, dynamic> p) {
  final raw = p['conversions'];
  if (raw is! Map) return const {};
  final out = <String, double>{};
  raw.forEach((k, v) => out[k.toString()] = wsD(v, fallback: 1));
  return out;
}

/// 展示单位 → 基础单位的系数（web 的 unitFactor）
double _factorOf(Map<String, dynamic> p, String unit) {
  final conv = _convOf(p);
  final double f = conv[unit] ?? 1;
  return f == 0 ? 1 : f;
}

/// 默认单位下的库存量（web 的 fmtStock）
double _dispStock(Map<String, dynamic> p) => wsD(p['stock']) / _factorOf(p, _unitOf(p));

/// 参考成本（默认单位）：有库存均价优先用均价，没有才用手填参考成本（web 的 refCostValue）
double? _refCostOf(Map<String, dynamic> p) {
  final double f = _factorOf(p, _unitOf(p));
  final double avg = wsD(p['avg_cost']);
  if (avg > 0) return avg * f;
  final double uc = wsD(p['unit_cost']);
  if (uc > 0) return uc * f;
  return null;
}

String _refCostTip(Map<String, dynamic> p) {
  final String du = _unitOf(p);
  final double f = _factorOf(p, du);
  final String ref = wsD(p['unit_cost']) > 0 ? '${wsMoney(wsD(p['unit_cost']) * f)}/$du' : '未设置';
  if (wsD(p['avg_cost']) > 0) {
    return '显示的是库存均价 ${wsMoney(wsD(p['avg_cost']) * f)}/$du（随出入库自动重算）；'
        '手填的参考成本：$ref';
  }
  if (wsD(p['unit_cost']) > 0) {
    return '该商品还没有入库均价，显示的是手填的参考成本 $ref';
  }
  return '未设置成本：可到编辑页按默认单位填「参考成本」，或入库后自动形成均价';
}

/// 扣减库存关联清单（多关联；兼容旧的单关联字段，与网页端 prodStockLinks 一致）
List<Map<String, dynamic>> _linksOf(Map<String, dynamic> p, Map<int, Map<String, dynamic>> byId) {
  final raw = p['stock_links'];
  List<dynamic> src;
  if (raw is List && raw.isNotEmpty) {
    src = raw;
  } else {
    final int spId = wsI(p['stock_product_id']);
    src = spId > 0 ? [<String, dynamic>{'product_id': spId, 'multiplier': wsD(p['multiplier'], fallback: 1)}] : const [];
  }
  final out = <Map<String, dynamic>>[];
  for (final dynamic e in src) {
    final m = _asMap(e);
    final int id = wsI(m['product_id']);
    if (id <= 0) continue;
    final Map<String, dynamic>? sp = byId[id];
    out.add(<String, dynamic>{
      'product_id': id,
      'multiplier': wsD(m['multiplier'], fallback: 1),
      'name': wsS(m['name']).isNotEmpty ? wsS(m['name']) : (sp == null ? '?' : wsS(sp['name'])),
      'unit': wsS(m['default_unit']).isNotEmpty
          ? wsS(m['default_unit'])
          : (sp == null ? '' : _unitOf(sp)),
    });
  }
  return out;
}

/// 关联结算（组合装）清单：[{product_id, quantity, unit}]
List<Map<String, dynamic>> _packsOf(Map<String, dynamic> p) {
  final raw = p['pack_items'];
  if (raw is! List) return const [];
  return [for (final e in raw) _asMap(e)];
}

/// 库存那一列的排序值（web 的 stockSortValue）：
/// 订单商品显示的是「经库存商品」→ 取首个关联库存商品的库存；人工显示工作量；其余按默认单位折算。
double _stockSortValue(Map<String, dynamic> p, Map<int, Map<String, dynamic>> byId) {
  if (_typeOf(p) == 'order') {
    final links = _linksOf(p, byId);
    if (links.isEmpty) return 0;
    final sp = byId[wsI(links.first['product_id'])];
    if (sp == null) return 0;
    return wsD(sp['stock']) / _factorOf(sp, _unitOf(sp));
  }
  if (wsS(p['category']) == '人工') return wsD(p['workload']);
  return _dispStock(p);
}

final RegExp _dateRe = RegExp(r'^\d{4}-\d{2}-\d{2}');

/// 表头排序比较器：空值最小、日期按字典序、可 parse 的按数值、其余按中文码位
/// （复刻网页端 compareVal）
int _cmpVal(dynamic a, dynamic b) {
  final bool ea = a == null || (a is String && a.isEmpty);
  final bool eb = b == null || (b is String && b.isEmpty);
  if (ea && eb) return 0;
  if (ea) return -1;
  if (eb) return 1;
  if (a is num && b is num) return a.compareTo(b);
  final String sa = a.toString();
  final String sb = b.toString();
  if (_dateRe.hasMatch(sa) && _dateRe.hasMatch(sb)) return sa.compareTo(sb);
  final double? na = double.tryParse(sa.replaceAll(',', ''));
  final double? nb = double.tryParse(sb.replaceAll(',', ''));
  if (na != null && nb != null) return na.compareTo(nb);
  return sa.compareTo(sb);
}

/// 基础单位归属类别（后端 _base_unit_category：重量类记「克」、计数类记「个」）
String _baseCat(String unit) {
  final u = unit.trim().toLowerCase();
  return (u == '克' || u == 'g') ? 'weight' : 'count';
}

// ====================================================================== 页面

class _DesktopProductsScreenState extends State<DesktopProductsScreen> {
  static const List<String> _tabNames = ['库存商品', '订单商品'];
  static const List<String> _fixedCategories = [
    '蔬菜', '水果', '水产', '肉禽', '蛋品', '干货', '调料', '包材', '人工', '快递', '其他',
  ];

  int _tab = 0;

  List<Map<String, dynamic>> _products = const [];
  List<Map<String, dynamic>> _units = const [];
  List<Map<String, dynamic>> _stocks = const [];
  final Map<int, Map<String, dynamic>> _byId = {};

  bool _loading = false;
  bool _loaded = false;
  bool _busy = false;
  String? _error;

  String _category = '';
  String _status = 'all';
  final TextEditingController _kwCtl = TextEditingController();
  String _keyword = '';

  String _sortKey = 'stock';
  bool _sortAsc = true;
  bool _sortTouched = false;

  /// 行勾选（跨页签保留，切换页签时清空，避免批量结果对不上眼）
  final Set<int> _selected = {};

  @override
  void initState() {
    super.initState();
    // preset 只是「进来时的预置筛选」，用户仍可自己改
    switch (widget.preset) {
      case 'order':
        _tab = 1;
        _sortKey = 'name';
      case 'pack':
        _category = '包材';
      case 'labor':
        _category = '人工';
      default:
        _sortKey = 'stock';
    }
    _load();
  }

  @override
  void dispose() {
    _kwCtl.dispose();
    super.dispose();
  }

  // ------------------------------------------------------------ 数据加载

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final List<List<dynamic>> results = await Future.wait<List<dynamic>>(
          [ApiService.products(), ApiService.units(), ApiService.stocks()]);
      if (!mounted) return;
      setState(() {
        _products = _asMapList(results[0]);
        _units = _asMapList(results[1]);
        _stocks = _asMapList(results[2]);
        _byId
          ..clear()
          ..addEntries([for (final p in _products) MapEntry(wsI(p['id']), p)]);
        _selected.removeWhere(_byId.containsKey);
        _loaded = true;
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
      wsToast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 单位管理弹窗改了单位表后只回灌单位，不必重拉商品
  Future<void> _reloadUnits() async {
    try {
      final List<dynamic> data = await ApiService.units();
      if (!mounted) return;
      setState(() => _units = _asMapList(data));
    } on ApiException catch (e) {
      if (mounted) wsToast(context, e.message, error: true);
    }
  }

  // ------------------------------------------------------------ 过滤 / 排序

  List<Map<String, dynamic>> get _tabRows =>
      _products.where((p) => _typeOf(p) == (_tab == 1 ? 'order' : 'stock')).toList();

  bool _kwHit(Map<String, dynamic> p, String kw) {
    if (wsS(p['name']).toLowerCase().contains(kw)) return true;
    if (wsS(p['category']).toLowerCase().contains(kw)) return true;
    if (wsS(p['code']).toLowerCase().contains(kw)) return true;
    if (wsS(p['spec']).toLowerCase().contains(kw)) return true;
    if (wsS(p['unit']).toLowerCase().contains(kw)) return true;
    if (_unitOf(p).toLowerCase().contains(kw)) return true;
    final links = _linksOf(p, _byId);
    final String way = _typeOf(p) == 'order'
        ? (links.isEmpty
            ? '订单 代发 外发'
            : '订单 扣减库存 ${links.map((l) => wsS(l['name'])).join(' ')}')
        : '库存商品';
    if (way.toLowerCase().contains(kw)) return true;
    final String packs =
        _packsOf(p).map((it) => wsS(_byId[wsI(it['product_id'])]?['name'])).join(' ');
    return packs.toLowerCase().contains(kw);
  }

  List<Map<String, dynamic>> get _filtered {
    final String kw = _keyword.trim().toLowerCase();
    final List<Map<String, dynamic>> rows = _tabRows.where((p) {
      if (_category.isNotEmpty && wsS(p['category']) != _category) return false;
      final bool active = p['is_active'] != false;
      if (_status == 'on' && !active) return false;
      if (_status == 'off' && active) return false;
      if (_status == 'low' && (!active || _stockSortValue(p, _byId) > 0)) return false;
      if (kw.isEmpty) return true;
      return _kwHit(p, kw);
    }).toList();
    rows.sort((a, b) {
      final int r = _cmpVal(_sortValue(a, _sortKey), _sortValue(b, _sortKey));
      return _sortAsc ? r : -r;
    });
    return rows;
  }

  dynamic _sortValue(Map<String, dynamic> p, String key) {
    final double f = _factorOf(p, _unitOf(p));
    switch (key) {
      case 'name':
        return wsS(p['name']);
      case 'code':
        return wsS(p['code']);
      case 'category':
        return wsS(p['category']);
      case 'spec':
        return wsS(p['spec']);
      case 'base_unit':
        return wsS(p['base_unit']);
      case 'default_unit':
        return _unitOf(p);
      case 'conversions':
        return _convOf(p).length;
      case 'sale_price':
        return wsD(p['sale_price']) * f;
      case 'avg_cost':
        return _refCostOf(p);
      case 'unit_cost':
        return wsD(p['unit_cost']) > 0 ? wsD(p['unit_cost']) * f : null;
      case 'stock':
        return _stockSortValue(p, _byId);
      case 'stock_value':
        return wsD(p['stock_value']);
      case 'pack_fee':
        return wsD(p['pack_fee']);
      case 'free_shipping':
        return p['free_shipping'] == true ? 1 : 0;
      case 'pack_items':
        return _packsOf(p).length;
      case 'stock_links':
        return _linksOf(p, _byId).length;
      case 'is_active':
        return p['is_active'] == false ? 0 : 1;
      default:
        return wsD(p['stock_value']);
    }
  }

  /// 分类候选：现有商品分类 + 常用固定值（与网页端下拉同源）
  List<String> get _categoryCandidates {
    final Set<String> set = {for (final p in _products) wsS(p['category']).trim()};
    set.addAll(_fixedCategories);
    set.removeWhere((c) => c.isEmpty);
    final List<String> out = set.toList();
    out.sort();
    return out;
  }

  List<String> get _unitNames {
    final Set<String> set = {for (final u in _units) wsS(u['name']).trim()};
    set.removeWhere((u) => u.isEmpty);
    final List<String> out = set.toList()..sort();
    if (out.isEmpty) return const ['克', '斤', '公斤', '个', '袋', '包', '盒', '箱', '件', '份', '单'];
    return out;
  }

  // ------------------------------------------------------------ 勾选 / 批量

  void _toggleSel(int id) {
    setState(() {
      if (_selected.contains(id)) {
        _selected.remove(id);
      } else {
        _selected.add(id);
      }
    });
  }

  void _selectAllVisible() {
    final List<int> ids = [for (final p in _filtered) wsI(p['id'])];
    final bool all = ids.isNotEmpty && ids.every(_selected.contains);
    setState(() {
      if (all) {
        _selected.removeAll(ids);
      } else {
        _selected.addAll(ids);
      }
    });
  }

  Future<void> _runBatch(Future<void> Function() body) async {
    setState(() => _busy = true);
    try {
      await body();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _batchActive(bool active) async {
    final List<int> ids = _selected.toList();
    if (ids.isEmpty) return;
    await _runBatch(() async {
      final data = await ApiService.batchUpdateProducts(ids, {'is_active': active});
      _selected.clear();
      await _load();
      if (!mounted) return;
      wsToast(context, '已${active ? '启用' : '停用'} ${wsI(data['updated'])} 个商品');
    });
  }

  Future<String?> _askCategory() {
    final ctl = TextEditingController();
    String err = '';
    BuildContext? dlg;
    void Function(void Function())? setDlg;
    final List<String> candidates = _categoryCandidates;

    return desktopDialog<String>(
      context,
      title: '批量改分类（${_selected.length} 个商品）',
      width: 560,
      builder: (c) {
        dlg = c;
        return StatefulBuilder(
          builder: (c2, sd) {
            setDlg = sd;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (err.isNotEmpty) DesktopNotice(err, kind: DesktopNoticeKind.error),
                const DesktopNotice('直接覆盖所选商品的分类；留空表示不改。', kind: DesktopNoticeKind.info),
                DesktopFormRow(
                  label: '新分类',
                  child: DesktopTextField(controller: ctl, hintText: '如：蔬菜 / 干货 / 包材', width: 300),
                ),
                DesktopFormRow(
                  label: '常用分类',
                  child: DesktopSearchField(
                    title: '选择已有分类',
                    width: 300,
                    value: '',
                    options: [for (final c in candidates) DesktopOption<String>(c, c)],
                    onChanged: (v) => ctl.text = v ?? '',
                  ),
                ),
              ],
            );
          },
        );
      },
      submitLabel: '✓ 确定',
      onSubmit: () {
        final String cat = ctl.text.trim();
        if (cat.isEmpty) {
          setDlg?.call(() => err = '请填写要改成的分类');
          return;
        }
        Navigator.of(dlg ?? context).pop(cat);
      },
    ).whenComplete(ctl.dispose);
  }

  Future<void> _batchCategory() async {
    final List<int> ids = _selected.toList();
    if (ids.isEmpty) return;
    final String? cat = await _askCategory();
    if (cat == null || cat.isEmpty || !mounted) return;
    await _runBatch(() async {
      final data = await ApiService.batchUpdateProducts(ids, {'category': cat});
      _selected.clear();
      await _load();
      if (!mounted) return;
      wsToast(context, '已把 ${wsI(data['updated'])} 个商品归入「$cat」');
    });
  }

  Future<String?> _askDefaultUnit() {
    String unit = _unitNames.first;
    BuildContext? dlg;
    return desktopDialog<String>(
      context,
      title: '批量改默认单位（${_selected.length} 个商品）',
      width: 560,
      builder: (c) {
        dlg = c;
        return StatefulBuilder(
          builder: (c2, sd) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const DesktopNotice(
                '后端只对「换算表里有这个单位」的商品改默认单位，其余商品原样不动'
                '（默认单位必须是该商品换算关系的键，否则库存与均价会算错）。',
                kind: DesktopNoticeKind.warn,
              ),
              DesktopFormRow(
                label: '默认单位',
                required: true,
                child: DesktopSelect<String>(
                  width: 260,
                  value: unit,
                  options: [for (final u in _unitNames) DesktopOption<String>(u, u)],
                  onChanged: (v) => sd(() => unit = v ?? unit),
                ),
              ),
            ],
          ),
        );
      },
      submitLabel: '✓ 确定',
      onSubmit: () => Navigator.of(dlg ?? context).pop(unit),
    );
  }

  Future<void> _batchUnit() async {
    final List<int> ids = _selected.toList();
    if (ids.isEmpty) return;
    final String? unit = await _askDefaultUnit();
    if (unit == null || unit.isEmpty || !mounted) return;
    await _runBatch(() async {
      final data = await ApiService.batchUpdateProducts(ids, {'default_unit': unit});
      _selected.clear();
      await _load();
      if (!mounted) return;
      wsToast(context, '已按「$unit」提交批量改默认单位，生效 ${wsI(data['updated'])} 个'
          '（换算表里没有该单位的商品不会变）');
    });
  }

  Future<double?> _askSalePrice() {
    final ctl = TextEditingController();
    String err = '';
    BuildContext? dlg;
    void Function(void Function())? setDlg;
    return desktopDialog<double>(
      context,
      title: '批量改售价（${_selected.length} 个商品）',
      width: 600,
      builder: (c) {
        dlg = c;
        return StatefulBuilder(
          builder: (c2, sd) {
            setDlg = sd;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (err.isNotEmpty) DesktopNotice(err, kind: DesktopNoticeKind.error),
                const DesktopNotice(
                  '批量改价只能按基础单位算（重量类 = 元/克，计数类 = 元/个）；'
                  '单个商品的价建议在商品编辑页按默认单位填。',
                  kind: DesktopNoticeKind.info,
                ),
                DesktopFormRow(
                  label: '默认售价',
                  required: true,
                  tip: '元 / 基础单位',
                  child: DesktopTextField(
                    controller: ctl,
                    hintText: '如 0.016',
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: DesktopTextField.decimalOnly,
                    onChanged: (_) => sd(() {}),
                  ),
                ),
              ],
            );
          },
        );
      },
      submitLabel: '✓ 确定',
      onSubmit: () {
        final double v = _textNum(ctl);
        if (v <= 0) {
          setDlg?.call(() => err = '请填写大于 0 的售价');
          return;
        }
        Navigator.of(dlg ?? context).pop(v);
      },
    ).whenComplete(ctl.dispose);
  }

  Future<void> _batchPrice() async {
    final List<int> ids = _selected.toList();
    if (ids.isEmpty) return;
    final double? price = await _askSalePrice();
    if (price == null || !mounted) return;
    await _runBatch(() async {
      final data = await ApiService.batchUpdateProducts(ids, {'sale_price': price});
      _selected.clear();
      await _load();
      if (!mounted) return;
      wsToast(context, '已把 ${wsI(data['updated'])} 个商品售价改为 ${wsMoney(price)}/基础单位');
    });
  }

  Future<void> _batchDelete() async {
    final List<int> ids = _selected.toList();
    if (ids.isEmpty) return;
    final bool ok = await wsConfirm(
      context,
      title: '批量删除',
      message: '确认删除选中的 ${ids.length} 个商品？\n'
          '已有出入库记录、被其它商品或单据引用的会自动跳过，结果里会逐条说明原因。',
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    await _runBatch(() async {
      final data = await ApiService.batchDeleteProducts(ids);
      final int deleted = wsI(data['deleted']);
      List<Map<String, dynamic>> blocked = _asMapList(data['blocked_items']);
      if (blocked.isEmpty) {
        blocked = [for (final n in (data['blocked'] as List? ?? const [])) <String, dynamic>{'name': '$n', 'sources': const []}];
      }
      _selected.clear();
      await _load();
      if (!mounted) return;
      if (blocked.isEmpty) {
        wsToast(context, '已删除 $deleted 个商品');
        return;
      }
      await _showBlocked(deleted, blocked);
    });
  }

  /// 被引用挡住的条目必须逐个给出原因，否则用户只知道「删不掉」
  Future<void> _showBlocked(int deleted, List<Map<String, dynamic>> blocked) {
    const int limit = 20;
    return desktopDialog<void>(
      context,
      title: '已删除 $deleted 个，${blocked.length} 个被引用挡住',
      width: 760,
      maxHeight: 640,
      builder: (_) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DesktopNotice(
            '以下 ${blocked.length} 个商品仍被引用，已跳过未删除'
            '${blocked.length > limit ? '（只列前 $limit 个）' : ''}：',
            kind: DesktopNoticeKind.warn,
          ),
          for (final b in blocked.take(limit))
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  wsCell(wsS(b['name']), bold: true),
                  for (final s in (b['sources'] as List? ?? const []))
                    Padding(
                      padding: const EdgeInsets.only(left: 10, top: 2),
                      child: Text('· $s',
                          style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight, height: 1.5)),
                    ),
                ],
              ),
            ),
          const SizedBox(height: 4),
          const Text('提示：清掉上面的引用后即可删除；只想让它不再出现在列表里，也可以改成「停用」。',
              style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
        ],
      ),
      submitLabel: '知道了',
      onSubmit: () => Navigator.of(context).pop(),
    );
  }

  // ------------------------------------------------------------ 单条操作

  void _openNew() {
    _openForm(presetCategory: widget.preset == 'pack' ? '包材' : (widget.preset == 'labor' ? '人工' : ''));
  }

  void _openForm({Map<String, dynamic>? product, Map<String, dynamic>? copyFrom, String presetCategory = ''}) {
    desktopDialog<void>(
      context,
      title: product != null ? '编辑商品' : (copyFrom != null ? '复制新增商品' : '新增商品'),
      width: 1020,
      maxHeight: 860,
      builder: (_) => _ProductForm(
        product: product,
        copyFrom: copyFrom,
        units: _units,
        stocks: _stocks,
        products: _products,
        categories: _categoryCandidates,
        presetCategory: presetCategory,
        onSaved: (String message) {
          if (!mounted) return;
          wsToast(context, message);
          _load();
        },
      ),
    );
  }

  /// 复制新增：字段照抄，名称加 -副本，编码与成本类字段清空（新建本来就没有库存）
  void _copyOne(Map<String, dynamic> p) {
    final Map<String, dynamic> clone = Map<String, dynamic>.from(p);
    clone['name'] = '${wsS(p['name'])}-副本';
    clone['code'] = '';
    clone['unit_cost'] = 0;
    clone['avg_cost'] = 0;
    clone['stock'] = 0;
    clone['stock_value'] = 0;
    clone['last_in_date'] = '';
    clone['last_in_price'] = 0;
    clone['last_in_unit'] = '';
    clone['last_in_unit_price'] = 0;
    clone['is_active'] = true;
    _openForm(copyFrom: clone);
  }

  Future<void> _deleteOne(Map<String, dynamic> p) async {
    final int id = wsI(p['id']);
    if (id <= 0) return;
    final String name = wsS(p['name']);
    final bool ok = await wsConfirm(
      context,
      title: '删除「$name」？',
      message: '确认删除该商品？其历史单据会一并删除，请谨慎。\n被单据或其它商品引用时后端会拒绝，原因会原样显示。',
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      await ApiService.deleteProduct(id);
      if (!mounted) return;
      wsToast(context, '已删除');
      await _load();
    } on ApiException catch (e) {
      // detail 本身就是多行中文说明，原样展示比前端再拼一遍更准
      if (mounted) wsToast(context, e.message, error: true);
    }
  }

  // ------------------------------------------------------------ 单位 / 导入

  void _openUnits() {
    desktopDialog<void>(
      context,
      title: '计量单位管理',
      width: 820,
      maxHeight: 760,
      builder: (_) => _UnitsPanel(units: _units, onChanged: _reloadUnits),
    );
  }

  Future<void> _downloadTemplate() async {
    final String? savePath = await FilePicker.platform.saveFile(
      dialogTitle: '保存商品导入模板',
      fileName: 'products_template.xlsx',
    );
    if (savePath == null || !mounted) return;
    try {
      await ApiService.download(ApiService.templatePath('products'), savePath);
      if (!mounted) return;
      wsToast(context, '模板已保存到：$savePath');
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '下载失败：${e.message}', error: true);
    }
  }

  Future<void> _importExcel() async {
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
    final String? path = picked.files.first.path;
    if (path == null) {
      wsToast(context, '读不到所选文件路径', error: true);
      return;
    }
    Map<String, dynamic> data;
    try {
      data = await ApiService.importProducts(path);
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '导入失败：${e.message}', error: true);
      return;
    }
    await _load();
    if (!mounted) return;
    await _showImportResult(data);
  }

  Future<void> _showImportResult(Map<String, dynamic> data) {
    final int created = wsI(data['created']);
    final int skipped = wsI(data['skipped']);
    final List<Map<String, dynamic>> failed = _asMapList(data['failed']);
    final int failedCount = wsI(data['failed_count'], fallback: failed.length);
    final List<dynamic> warnings = (data['warnings'] as List?) ?? const [];
    return desktopDialog<void>(
      context,
      title: '商品导入结果',
      width: 760,
      maxHeight: 660,
      builder: (_) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DesktopNotice(
            '新建 $created 条 · 已存在跳过 $skipped 条 · 失败 $failedCount 条',
            kind: failedCount > 0 ? DesktopNoticeKind.warn : DesktopNoticeKind.success,
          ),
          if (warnings.isNotEmpty)
            DesktopNotice('提示：${warnings.join('；')}', kind: DesktopNoticeKind.info),
          if (failed.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text('没有失败行。模板兼容「柠檬云商品导入模板.xlsx」，编码/类别/名称/规格/单位整表识别。',
                  style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
            )
          else ...[
            wsCell('失败明细（行号为表格行号）', bold: true),
            const SizedBox(height: 8),
            DesktopGrid(
              dense: true,
              cols: const [
                DesktopCol('行', width: 70),
                DesktopCol('原因', width: 600),
              ],
              rows: [
                for (final f in failed)
                  DesktopRow(cells: [wsCell('${wsI(f['row'])}'), wsCell(wsS(f['reason']), tip: wsS(f['reason']))]),
              ],
            ),
          ],
        ],
      ),
      submitLabel: '知道了',
      onSubmit: () => Navigator.of(context).pop(),
    );
  }

  // ------------------------------------------------------------ 明细弹窗

  void _showDetail(Map<String, dynamic> p) {
    desktopDialog<void>(
      context,
      title: '商品资料 · ${wsS(p['name'])}',
      width: 860,
      maxHeight: 720,
      builder: (dlg) => _ProductDetail(
        product: p,
        byId: _byId,
        onEdit: () {
          Navigator.of(dlg).pop();
          _openForm(product: p);
        },
        onCopy: () {
          Navigator.of(dlg).pop();
          _copyOne(p);
        },
        onRules: () {
          Navigator.of(dlg).pop();
          widget.onNavigate('/rules');
        },
      ),
    );
  }

  // ================================================================== 构建

  String get _subtitle {
    final String view = switch (widget.preset) {
      'stock' => '当前视角「商品」：预置为只看库存商品（大类·真实库存）。',
      'order' => '当前视角「关联结算」：预置为只看订单商品（小类），可维护扣减库存与关联结算清单。',
      'pack' => '当前视角「包材」：预置分类＝包材。',
      'labor' => '当前视角「人工」：预置分类＝人工；人工类没有真实库存，库存列显示工作量。',
      _ => '商品 / 关联结算 / 包材 / 人工 四个入口都是这一页，只是进来时预置了筛选。',
    };
    final String wh = widget.auth.warehouseName.isEmpty ? '当前分仓' : widget.auth.warehouseName;
    return '$view 分类 / 关键字 / 状态与表头排序都在本页面完成（一次拉全量含停用，不重新请求）。'
        '分仓「$wh」，数量与成本一律按商品默认单位展示。';
  }

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '商品资料',
      subtitle: _subtitle,
      actions: [
        DesktopButton(label: '刷新', icon: Icons.refresh, onPressed: _loading ? null : _load),
        DesktopButton(label: '模板下载', icon: Icons.download_outlined, onPressed: _downloadTemplate),
        DesktopButton(label: 'Excel 导入', icon: Icons.upload_file_outlined, onPressed: _importExcel),
        DesktopButton(label: '单位管理', icon: Icons.straighten_outlined, onPressed: _openUnits),
        DesktopButton(
          label: '新增商品',
          icon: Icons.add,
          kind: DesktopButtonKind.primary,
          onPressed: _openNew,
        ),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: Row(
              children: [
                DesktopTabs(
                  items: _tabNames,
                  index: _tab,
                  onChanged: (i) => setState(() {
                    _tab = i;
                    _selected.clear();
                    if (!_sortTouched) {
                      _sortKey = i == 1 ? 'name' : 'stock';
                      _sortAsc = true;
                    }
                  }),
                ),
                const SizedBox(width: 14),
                if (_selected.isNotEmpty)
                  Text('已选 ${_selected.length} 项',
                      style: const TextStyle(fontSize: 12.5, color: WsTokens.primary)),
              ],
            ),
          ),
          _filterBar(),
          Expanded(
            child: DesktopStateView(
              loading: _loading && !_loaded,
              loadingText: '正在读取商品资料…',
              error: _error,
              onRetry: _load,
              child: DesktopScrollBody(
                children: [
                  DesktopRise(index: 0, child: _statGrid()),
                  const SizedBox(height: 18),
                  DesktopRise(index: 1, child: _tableCard()),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _filterBar() {
    final List<String> cats = _categoryCandidates;
    final int total = _tabRows.length;
    final int shown = _filtered.length;
    return DesktopFilterBar(
      right: _busy
          ? const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : null,
      children: [
        DesktopLabeled(
          label: '分类',
          child: DesktopSelect<String>(
            width: 160,
            value: _category,
            options: [
              const DesktopOption<String>('', '全部分类'),
              for (final c in cats) DesktopOption<String>(c, c),
            ],
            onChanged: (v) => setState(() => _category = v ?? ''),
          ),
        ),
        DesktopLabeled(
          label: '状态',
          child: DesktopSelect<String>(
            width: 150,
            value: _status,
            options: const [
              DesktopOption<String>('all', '全部状态'),
              DesktopOption<String>('on', '在用'),
              DesktopOption<String>('off', '停用'),
              DesktopOption<String>('low', '低库存（≤0）'),
            ],
            onChanged: (v) => setState(() => _status = v ?? 'all'),
          ),
        ),
        DesktopLabeled(
          label: '搜索',
          child: DesktopTextField(
            controller: _kwCtl,
            width: 300,
            hintText: '搜索商品 / 分类 / 规格 / 编码 / 代发…',
            onChanged: (v) => setState(() => _keyword = v),
            suffix: _keyword.isEmpty
                ? null
                : DesktopIconButton(
                    icon: Icons.close,
                    size: 26,
                    color: WsTokens.mutedLight,
                    tooltip: '清空',
                    onPressed: () {
                      _kwCtl.clear();
                      setState(() => _keyword = '');
                    },
                  ),
          ),
        ),
        Text('共 $shown 项 / 本页签 $total 项（本页面过滤，不重新请求）',
            style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
      ],
    );
  }

  Widget _statGrid() {
    final List<Map<String, dynamic>> rows = _filtered;
    final double totalValue = rows.fold<double>(0, (s, p) => s + wsD(p['stock_value']));
    final int offCount = rows.where((p) => p['is_active'] == false).length;
    final int dropCount = _products
        .where((p) => _typeOf(p) == 'order' && _linksOf(p, _byId).isEmpty)
        .length;
    final int kindCount = rows.map((p) => wsS(p['category'])).where((c) => c.isNotEmpty).length;
    return DesktopStatGrid(
      children: [
        DesktopStatCard(
          label: '商品种类',
          value: wsNum(rows.length),
          sub: '分类命中 $kindCount 项 · 停用 $offCount 个',
        ),
        DesktopStatCard(
          label: '库存总值',
          value: wsMoney(totalValue),
          sub: '按均价 × 库存折算（库存商品）',
          color: WsTokens.primary,
        ),
        DesktopStatCard(
          label: '代发商品',
          value: wsNum(dropCount),
          sub: '全部订单商品里没有扣减库存关联的个数',
          color: dropCount > 0 ? WsTokens.amber : WsTokens.green,
        ),
        DesktopStatCard(
          label: '停用商品',
          value: wsNum(offCount),
          sub: offCount > 0 ? '已保留在列表里（置灰）' : '无停用商品',
        ),
      ],
    );
  }

  Widget _tableCard() {
    final List<Map<String, dynamic>> rows = _filtered;
    return WsCard(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const WsCardHead(
            title: '商品列表',
            icon: Icons.tag_outlined,
            trailing: Text('点击任意一行查看全部资料；换算关系与关联结算点单元格展开',
                style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
          ),
          _batchBar(rows),
          DesktopGrid(
            cols: const [
              DesktopCol('选', width: 44, center: true),
              DesktopCol('商品名称', width: 210, sortKey: 'name'),
              DesktopCol('编码', width: 110, sortKey: 'code'),
              DesktopCol('分类', width: 96, sortKey: 'category', center: true),
              DesktopCol('规格', width: 130, sortKey: 'spec'),
              DesktopCol('基础单位', width: 84, sortKey: 'base_unit', center: true),
              DesktopCol('默认单位', width: 88, sortKey: 'default_unit', center: true),
              DesktopCol('换算关系', width: 132, sortKey: 'conversions', center: true),
              DesktopCol('售价', width: 116, sortKey: 'sale_price', right: true),
              DesktopCol('参考成本', width: 150, sortKey: 'avg_cost', right: true),
              DesktopCol('单位成本', width: 124, sortKey: 'unit_cost', right: true),
              DesktopCol('库存', width: 132, sortKey: 'stock', right: true),
              DesktopCol('库存值', width: 120, sortKey: 'stock_value', right: true),
              DesktopCol('打包费', width: 96, sortKey: 'pack_fee', right: true),
              DesktopCol('包邮', width: 74, sortKey: 'free_shipping', center: true),
              DesktopCol('关联结算', width: 118, sortKey: 'pack_items', center: true),
              DesktopCol('库存关联', width: 210, sortKey: 'stock_links'),
              DesktopCol('状态', width: 92, sortKey: 'is_active', center: true),
              DesktopCol('操作', width: 190),
            ],
            rows: [for (final p in rows) _row(p)],
            footer: _footer(rows),
            sortKey: _sortKey,
            sortAsc: _sortAsc,
            onSort: (key) => setState(() {
              _sortTouched = true;
              if (_sortKey == key) {
                _sortAsc = !_sortAsc;
              } else {
                _sortKey = key;
                _sortAsc = true;
              }
            }),
          ),
        ],
      ),
    );
  }

  /// 合计行：按列下标填，避免写错位置（1=商品名称，12=库存值）
  List<String> _footer(List<Map<String, dynamic>> rows) {
    final List<String> out = List<String>.filled(19, '');
    out[1] = '合计 ${rows.length} 项';
    out[12] = wsMoney(rows.fold<double>(0, (s, p) => s + wsD(p['stock_value'])));
    return out;
  }

  Widget _batchBar(List<Map<String, dynamic>> rows) {
    final bool dark = wsIsDark(context);
    final bool sel = _selected.isNotEmpty;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: sel
            ? WsTokens.primaryLight.withValues(alpha: dark ? 0.22 : 1)
            : (dark ? WsTokens.borderDark : WsTokens.borderLighter),
        borderRadius: BorderRadius.circular(WsTokens.radius),
      ),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          if (sel) ...[
            wsCell('已选 ${_selected.length} 项', bold: true, color: WsTokens.primary),
            DesktopButton(label: '批量启用', small: true, onPressed: _busy ? null : () => _batchActive(true)),
            DesktopButton(label: '批量停用', small: true, onPressed: _busy ? null : () => _batchActive(false)),
            DesktopButton(label: '批量改分类', small: true, onPressed: _busy ? null : _batchCategory),
            DesktopButton(label: '批量改默认单位', small: true, onPressed: _busy ? null : _batchUnit),
            DesktopButton(label: '批量改售价', small: true, onPressed: _busy ? null : _batchPrice),
            DesktopButton(
              label: '批量删除',
              small: true,
              kind: DesktopButtonKind.danger,
              onPressed: _busy ? null : _batchDelete,
            ),
            DesktopButton(label: '取消选择', small: true, onPressed: () => setState(_selected.clear)),
          ] else ...[
            DesktopButton(label: '全选本页', small: true, onPressed: rows.isEmpty ? null : _selectAllVisible),
            const Text('勾选行后可批量启用 / 停用、改分类、改默认单位、改售价、删除',
                style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ],
        ],
      ),
    );
  }

  DesktopRow _row(Map<String, dynamic> p) {
    final int id = wsI(p['id']);
    final bool active = p['is_active'] != false;
    final String du = _unitOf(p);
    final double f = _factorOf(p, du);
    final List<Map<String, dynamic>> convs = _convOf(p).entries.toList()
        .map((e) => <String, dynamic>{'unit': e.key, 'factor': e.value})
        .toList();
    final List<Map<String, dynamic>> packs = _packsOf(p);
    final List<Map<String, dynamic>> links = _linksOf(p, _byId);
    final bool isOrder = _typeOf(p) == 'order';
    final bool isLabor = wsS(p['category']) == '人工';
    final double stockV = _stockSortValue(p, _byId);

    return DesktopRow(
      dim: !active,
      tag: id,
      onTap: () => _showDetail(p),
      cells: [
        SizedBox(
          width: 20,
          child: Checkbox(
            value: _selected.contains(id),
            onChanged: _busy ? null : (_) => _toggleSel(id),
            visualDensity: VisualDensity.compact,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(3))),
          ),
        ),
        wsCell(wsS(p['name']), bold: true, tip: wsS(p['name'])),
        wsCell(wsS(p['code'], fallback: '—'), tip: wsS(p['code'])),
        wsS(p['category']).isEmpty
            ? wsCell('—')
            : DesktopTag(wsS(p['category']), color: WsTokens.primary),
        wsCell(wsS(p['spec'], fallback: '—'), tip: wsS(p['spec'])),
        wsCell(wsS(p['base_unit'], fallback: '—'), tip: '基础单位：库存与成本都按它存库'),
        wsCell(du.isEmpty ? '—' : du),
        _convCell(convs, du),
        wsCell(wsD(p['sale_price']) > 0 ? '${wsMoney(wsD(p['sale_price']) * f)}/$du' : '—',
            tip: '默认售价（按默认单位展示，存库按基础单位）'),
        Tooltip(
          message: _refCostTip(p),
          child: Text(
            _refCostOf(p) == null ? '—' : '${wsMoney(_refCostOf(p)!)}/$du',
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13),
          ),
        ),
        wsCell(wsD(p['unit_cost']) > 0 ? '${wsMoney(wsD(p['unit_cost']) * f)}/$du' : '—',
            tip: '手填参考成本（编辑页「参考成本」）：没有入库均价时列表与代发成本按它算'),
        _stockCell(p, isOrder, isLabor, links, stockV, du),
        wsCell(isOrder ? '—' : wsMoney(wsD(p['stock_value']))),
        wsCell(wsD(p['pack_fee']) > 0 ? wsMoney(wsD(p['pack_fee'])) : '—'),
        p['free_shipping'] == true
            ? const DesktopTag('包邮', color: DesktopTag.paid)
            : wsCell('—'),
        packs.isEmpty
            ? wsCell('—')
            : _packCell(packs),
        isOrder
            ? (links.isEmpty
                ? const Row(
                    children: [
                      DesktopTag('代发', color: WsTokens.amber),
                      SizedBox(width: 4),
                      Flexible(child: Text('不扣库存', overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight))),
                    ],
                  )
                : Tooltip(
                    message: '扣减：${links.map((l) => '${wsS(l['name'])} ×${_qty(l['multiplier'])}${wsS(l['unit'])}').join('、')}',
                    child: Text(
                      links.map((l) => '${wsS(l['name'])}×${_qty(l['multiplier'])}').take(2).join('、') +
                          (links.length > 2 ? ' +${links.length - 2}' : ''),
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12.5),
                    ),
                  ))
            : wsCell('—'),
        active
            ? (stockV <= 0 && !isOrder && !isLabor
                ? const DesktopTag('低库存', color: WsTokens.red)
                : const DesktopTag('在用', color: DesktopTag.paid))
            : const DesktopTag('停用', color: DesktopTag.off),
        Row(
          children: [
            DesktopLink('编辑', onPressed: () => _openForm(product: p)),
            DesktopLink('复制', onPressed: () => _copyOne(p)),
            DesktopLink('删除', color: WsTokens.red, onPressed: () => _deleteOne(p)),
          ],
        ),
      ],
    );
  }

  /// 换算关系：折叠展示，点单元格看全部
  Widget _convCell(List<Map<String, dynamic>> convs, String du) {
    if (convs.isEmpty) return wsCell('—');
    final String first = '${convs.first['unit']}=${_qty(convs.first['factor'])}';
    final String full = convs.map((c) => '${wsS(c['unit'])}=${_qty(c['factor'])}').join('；');
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _showAspect(
        title: '换算关系',
        cols: const [DesktopCol('单位', width: 160), DesktopCol('折基础单位', width: 160)],
        rows: [
          for (final c in convs)
            DesktopRow(cells: [wsCell(wsS(c['unit'])), wsCell(_qty(c['factor']))]),
        ],
        note: '基础单位恒等于 1；库存与均价都按基础单位存，展示时除以默认单位的系数（$du）。',
      ),
      child: Tooltip(
        message: full,
        child: Text(
          convs.length == 1 ? first : '$first +${convs.length - 1} 项',
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 12.5, color: WsTokens.primary),
        ),
      ),
    );
  }

  /// 关联结算清单：数量 > 0 显示「N 项」点开看
  Widget _packCell(List<Map<String, dynamic>> packs) {
    final String full = packs
        .map((it) => '${wsS(_byId[wsI(it['product_id'])]?['name'], fallback: '?')}×${_qty(it['quantity'])}${wsS(it['unit'])}')
        .join('、');
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _showAspect(
        title: '出库关联结算清单',
        cols: const [
          DesktopCol('商品', width: 240),
          DesktopCol('每单用量', width: 120, right: true),
          DesktopCol('单位', width: 90, center: true),
        ],
        rows: [
          for (final it in packs)
            DesktopRow(cells: [
              wsCell(wsS(_byId[wsI(it['product_id'])]?['name'], fallback: '?')),
              wsCell(_qty(it['quantity'])),
              wsCell(wsS(it['unit'])),
            ]),
        ],
        note: '卖 1 单本商品时自动扣减这些商品的库存（包材 / 人工等）；单位必须在该商品换算表里。',
      ),
      child: Tooltip(
        message: full,
        child: Text(
          '${packs.length} 项',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 12.5, color: WsTokens.primary),
        ),
      ),
    );
  }

  Widget _stockCell(Map<String, dynamic> p, bool isOrder, bool isLabor,
      List<Map<String, dynamic>> links, double stockV, String du) {
    if (isOrder && links.isNotEmpty) {
      return wsCell('经库存商品', color: WsTokens.mutedLight,
          tip: '订单商品不在本仓持有库存，扣减记在它关联的库存商品上');
    }
    if (isLabor) {
      return Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [DesktopTag('工作量 ${_qty(wsD(p['workload']))} 单', color: WsTokens.amber)],
      );
    }
    return wsCell('${_qty(_dispStock(p))} $du',
        bold: true, color: stockV <= 0 ? WsTokens.red : null);
  }

  Future<void> _showAspect({
    required String title,
    required List<DesktopCol> cols,
    required List<DesktopRow> rows,
    required String note,
  }) {
    double width = cols.fold<double>(0, (s, c) => s + c.width) + 60;
    if (width > 760) width = 760;
    return desktopDialog<void>(
      context,
      title: title,
      width: width,
      maxHeight: 560,
      builder: (_) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DesktopGrid(cols: cols, rows: rows, dense: true),
          const SizedBox(height: 10),
          Text(note, style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5)),
        ],
      ),
      submitLabel: '关闭',
      onSubmit: () => Navigator.of(context).pop(),
    );
  }
}

// ================================================================== 明细弹窗

class _ProductDetail extends StatelessWidget {
  const _ProductDetail({
    required this.product,
    required this.byId,
    required this.onEdit,
    required this.onCopy,
    required this.onRules,
  });

  final Map<String, dynamic> product;
  final Map<int, Map<String, dynamic>> byId;
  final VoidCallback onEdit;
  final VoidCallback onCopy;
  final VoidCallback onRules;

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = product;
    final String du = _unitOf(p);
    final double f = _factorOf(p, du);
    final List<Map<String, dynamic>> links = _linksOf(p, byId);
    final List<Map<String, dynamic>> packs = _packsOf(p);
    final bool isOrder = _typeOf(p) == 'order';

    final List<Widget> body = [
      _kv('商品编码', wsS(p['code'], fallback: '—')),
      _kv('分类', wsS(p['category'], fallback: '—')),
      _kv('商品类型', isOrder ? '订单商品（小类·出库销售）' : '库存商品（大类·真实库存）'),
      _kv('规格', wsS(p['spec'], fallback: '—')),
      _kv('基础单位 / 默认单位', '${wsS(p['base_unit'], fallback: '—')} / $du'),
      _kv('默认售价', wsD(p['sale_price']) > 0 ? '${wsMoney(wsD(p['sale_price']) * f)}/$du' : '—'),
      _kv('参考成本', _refCostOf(p) == null ? '—' : '${wsMoney(_refCostOf(p)!)} / $du'),
      _kv('手填单位成本', wsD(p['unit_cost']) > 0 ? '${wsMoney(wsD(p['unit_cost']) * f)}/$du' : '—'),
      _kv('库存', isOrder
          ? (links.isEmpty ? '代发（本仓不持有库存）' : '记在关联的库存商品上')
          : '${_qty(_dispStock(p))} $du（基础单位 ${_qty(wsD(p['stock']))} ${wsS(p['base_unit'])}）'),
      _kv('库存值', wsMoney(wsD(p['stock_value']))),
      _kv('打包费 / 包邮', '${wsMoney(wsD(p['pack_fee']))} · ${p['free_shipping'] == true ? '包邮' : '不包邮'}'),
      _kv('单件净重', wsD(p['weight_kg']) > 0 ? '${wsTrim(wsD(p['weight_kg']), digits: 3)} kg' : '—'),
      _kv('状态', p['is_active'] == false ? '停用' : '在用'),
      _kv('最近入库', _lastInText(p)),
      const SizedBox(height: 12),
    ];

    body.add(wsCell('换算关系', bold: true));
    body.add(const SizedBox(height: 6));
    body.add(DesktopGrid(
      dense: true,
      cols: const [DesktopCol('单位', width: 150), DesktopCol('折基础单位', width: 150)],
      rows: [
        for (final e in _convOf(p).entries)
          DesktopRow(cells: [wsCell(e.key), wsCell(_qty(e.value))]),
        if (_convOf(p).isEmpty) DesktopRow(cells: [wsCell('未配置'), wsCell('—')]),
      ],
    ));
    body.add(const SizedBox(height: 14));

    body.add(wsCell('扣减库存关联（${isOrder ? (links.isEmpty ? '无 = 代发' : links.length) : 0}）', bold: true));
    body.add(const SizedBox(height: 6));
    if (isOrder) {
      body.add(DesktopGrid(
        dense: true,
        cols: const [
          DesktopCol('库存商品', width: 220),
          DesktopCol('倍数', width: 90, right: true),
          DesktopCol('单位', width: 80, center: true),
        ],
        rows: [
          for (final l in links)
            DesktopRow(cells: [
              wsCell(wsS(l['name'])),
              wsCell(_qty(l['multiplier'])),
              wsCell(wsS(l['unit'], fallback: '—')),
            ]),
          if (links.isEmpty)
            const DesktopRow(cells: [
              Text('代发：不扣库存，只统计代发数量与代发成本（按参考成本计）',
                  style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
              Text(''),
              Text(''),
            ]),
        ],
      ));
    } else {
      body.add(const Text('库存大类本身不扣减别的商品。',
          style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)));
    }
    body.add(const SizedBox(height: 14));

    body.add(wsCell('出库关联结算清单（${packs.length}）', bold: true));
    body.add(const SizedBox(height: 6));
    body.add(DesktopGrid(
      dense: true,
      cols: const [
        DesktopCol('商品', width: 220),
        DesktopCol('每单用量', width: 100, right: true),
        DesktopCol('单位', width: 80, center: true),
      ],
      rows: [
        for (final it in packs)
          DesktopRow(cells: [
            wsCell(wsS(byId[wsI(it['product_id'])]?['name'], fallback: '?')),
            wsCell(_qty(it['quantity'])),
            wsCell(wsS(it['unit'])),
          ]),
        if (packs.isEmpty)
          DesktopRow(cells: [wsCell('未关联'), wsCell('—'), wsCell('—')]),
      ],
    ));
    body.add(const SizedBox(height: 16));
    body.add(Row(
      children: [
        DesktopButton(label: '编辑', icon: Icons.edit_outlined, kind: DesktopButtonKind.primary, onPressed: onEdit),
        const SizedBox(width: 10),
        DesktopButton(label: '复制新增', icon: Icons.content_copy_outlined, onPressed: onCopy),
        if (isOrder) ...[
          const SizedBox(width: 10),
          DesktopButton(label: '一单多货规则', icon: Icons.link, onPressed: onRules),
        ],
      ],
    ));

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: body);
  }

  String _lastInText(Map<String, dynamic> p) {
    final String d = wsS(p['last_in_date']);
    final double unitPrice = wsD(p['last_in_unit_price']);
    final String unit = wsS(p['last_in_unit']);
    if (d.isEmpty && wsD(p['last_in_price']) <= 0) return '还没有入库记录';
    if (unit.isEmpty) return '$d ${wsMoney(wsD(p['last_in_price']))}（基础单位）';
    return '$d · ${wsMoney(unitPrice)}/$unit';
  }

  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 120,
              child: Text(k, style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
            ),
            Expanded(child: Text(v, style: const TextStyle(fontSize: 13, height: 1.5))),
          ],
        ),
      );
}

// ================================================================ 商品表单

/// 换算表一行：1 [unit] = 系数 个基础单位（基础单位自己不建行，恒等于 1）
class _ConvRow {
  _ConvRow({this.unit = '', String? factor})
      : factorCtl = TextEditingController(text: factor ?? '');

  String unit;
  final TextEditingController factorCtl;

  void dispose() {
    unit = '';
    factorCtl.dispose();
  }
}

/// 订单商品 → 库存商品 的扣减关联行
class _LinkRow {
  _LinkRow({this.productId = 0, this.name = '', String? multiplier})
      : multCtl = TextEditingController(text: multiplier ?? '1');

  int productId;
  String name;
  final TextEditingController multCtl;

  void dispose() => multCtl.dispose();
}

/// 关联结算（组合装）行
class _PackRow {
  _PackRow({this.productId = 0, this.name = '', this.unit = '', String? quantity})
      : qtyCtl = TextEditingController(text: quantity ?? '1');

  int productId;
  String name;
  String unit;
  final TextEditingController qtyCtl;

  void dispose() => qtyCtl.dispose();
}

/// 新增 / 编辑商品表单，字段与网页端 productForm 逐项对应。
/// 保存动作在本组件里直接调接口：失败时把后端 detail 留在弹窗内（网页端也是不关弹窗只提示）。
class _ProductForm extends StatefulWidget {
  const _ProductForm({
    required this.units,
    required this.stocks,
    required this.products,
    required this.categories,
    required this.presetCategory,
    required this.onSaved,
    this.product,
    this.copyFrom,
  });

  final List<Map<String, dynamic>> units;
  final List<Map<String, dynamic>> stocks;
  final List<Map<String, dynamic>> products;
  final List<String> categories;

  /// 独立入口（包材 / 人工）新增时自动带上分类
  final String presetCategory;
  final void Function(String message) onSaved;

  /// 编辑目标（null = 新增）
  final Map<String, dynamic>? product;

  /// 复制新增来源（product 为 null 时生效）
  final Map<String, dynamic>? copyFrom;

  @override
  State<_ProductForm> createState() => _ProductFormState();
}

class _ProductFormState extends State<_ProductForm> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _nameCtl = TextEditingController();
  final TextEditingController _codeCtl = TextEditingController();
  final TextEditingController _categoryCtl = TextEditingController();
  final TextEditingController _specCtl = TextEditingController();
  final TextEditingController _saleCtl = TextEditingController();
  final TextEditingController _costCtl = TextEditingController();
  final TextEditingController _weightCtl = TextEditingController();
  final TextEditingController _feeCtl = TextEditingController();
  final TextEditingController _ratioCtl = TextEditingController();

  final List<_ConvRow> _convs = [];
  final List<_LinkRow> _links = [];
  final List<_PackRow> _packs = [];

  String _category = '';
  String _type = 'stock';
  String _baseUnit = '克';
  String _defaultUnit = '克';
  bool _freeShipping = false;
  bool _active = true;
  bool _noHistory = false;
  bool _saving = false;
  String _err = '';

  /// 存库口径（元/基础单位）与当前展示口径的系数
  double _saleBase = 0;
  double _costBase = 0;
  double _curFactor = 1;

  bool get _isEdit => widget.product != null;
  Map<String, dynamic>? get _source => widget.product ?? widget.copyFrom;

  @override
  void initState() {
    super.initState();
    final Map<String, dynamic>? p = _source;
    if (p != null) {
      _type = _typeOf(p);
      _nameCtl.text = wsS(p['name']);
      _codeCtl.text = wsS(p['code']);
      _category = wsS(p['category']);
      _categoryCtl.text = _category;
      _specCtl.text = wsS(p['spec']);
      final String base = wsS(p['base_unit']);
      _baseUnit = base.isEmpty ? '克' : base;
      _defaultUnit = wsS(p['default_unit']);
      if (_defaultUnit.isEmpty) _defaultUnit = _baseUnit;
      _saleBase = wsD(p['sale_price']);
      _costBase = wsD(p['unit_cost']);
      _weightCtl.text = _plain(wsD(p['weight_kg']));
      _feeCtl.text = _plain(wsD(p['pack_fee']));
      _freeShipping = p['free_shipping'] == true;
      _active = p['is_active'] != false;
      final double f = _factorOf(p, _defaultUnit);
      _curFactor = f;
      _saleCtl.text = _plain(_saleBase * f);
      _costCtl.text = _plain(_costBase * f);
      _convOf(p).forEach((unit, factor) {
        if (unit == _baseUnit) return;
        _convs.add(_ConvRow(unit: unit, factor: _plain(factor)));
      });
      for (final l in _linksOf(p, _productIndex)) {
        _links.add(_LinkRow(
          productId: wsI(l['product_id']),
          name: wsS(l['name']),
          multiplier: _plain(wsD(l['multiplier'], fallback: 1)),
        ));
      }
      for (final it in _packsOf(p)) {
        _packs.add(_PackRow(
          productId: wsI(it['product_id']),
          name: wsS(_productIndex[wsI(it['product_id'])]?['name']),
          unit: wsS(it['unit']),
          quantity: _qty(it['quantity']),
        ));
      }
    } else {
      _category = widget.presetCategory;
      _categoryCtl.text = _category;
      _curFactor = 1;
    }
    if (_convs.isEmpty) _convs.add(_ConvRow());
  }

  Map<int, Map<String, dynamic>> get _productIndex {
    final out = <int, Map<String, dynamic>>{};
    for (final p in widget.products) {
      out[wsI(p['id'])] = p;
    }
    return out;
  }

  /// 可选单位：后端单位表 + 本商品已填的换算单位 + 常用兜底，去重排序
  List<String> get _unitOptions {
    final Set<String> set = <String>{
      for (final u in widget.units) wsS(u['name']).trim(),
      for (final r in _convs) r.unit.trim(),
      _baseUnit,
    }..removeWhere((u) => u.isEmpty);
    if (set.isEmpty) {
      set.addAll(const ['克', '斤', '公斤', '个', '袋', '包', '盒', '箱', '件', '份', '单']);
    }
    final List<String> out = set.toList()..sort();
    return out;
  }

  @override
  void dispose() {
    _nameCtl.dispose();
    _codeCtl.dispose();
    _categoryCtl.dispose();
    _specCtl.dispose();
    _saleCtl.dispose();
    _costCtl.dispose();
    _weightCtl.dispose();
    _feeCtl.dispose();
    _ratioCtl.dispose();
    for (final r in _convs) {
      r.dispose();
    }
    for (final r in _links) {
      r.dispose();
    }
    for (final r in _packs) {
      r.dispose();
    }
    super.dispose();
  }

  // ------------------------------------------------------------ 单位换算

  /// 当前换算表：基础单位恒为 1 + 各行
  Map<String, double> _convMap() {
    final out = <String, double>{_baseUnit: 1};
    for (final r in _convs) {
      final String u = r.unit.trim();
      if (u.isEmpty || u == _baseUnit) continue;
      out[u] = _textNum(r.factorCtl);
    }
    return out;
  }

  /// 换默认单位 / 换算系数后：把手填值先折回基础单位，再按新单位显示（网页端 pUnitChanged 同逻辑）
  void _rescalePrices(double newFactor) {
    if (_curFactor <= 0) _curFactor = 1;
    _saleBase = _textNum(_saleCtl) / _curFactor;
    _costBase = _textNum(_costCtl) / _curFactor;
    _curFactor = newFactor <= 0 ? 1 : newFactor;
    _saleCtl.text = _plain(_saleBase * _curFactor);
    _costCtl.text = _plain(_costBase * _curFactor);
  }

  List<String> get _defaultUnitOptions {
    final Set<String> set = {_baseUnit};
    for (final r in _convs) {
      final String u = r.unit.trim();
      if (u.isNotEmpty) set.add(u);
    }
    final List<String> out = set.toList()..sort();
    return out;
  }

  /// 跨类别换基础单位（计数「个」↔ 重量「克」）才需要折算关系
  bool get _unitChanged {
    if (!_isEdit) return false;
    final String old = wsS(widget.product!['base_unit']);
    if (old.isEmpty || _baseUnit.isEmpty) return false;
    if (old == _baseUnit) return false;
    return _baseCat(old) != _baseCat(_baseUnit);
  }

  bool get _historySuspect {
    final Map<String, dynamic>? p = widget.product;
    if (p == null) return false;
    return wsD(p['stock']) != 0 || wsS(p['last_in_date']).isNotEmpty || wsD(p['stock_value']) != 0;
  }

  // ------------------------------------------------------------ 保存

  Map<String, dynamic>? _collect() {
    final String name = _nameCtl.text.trim();
    if (name.isEmpty) {
      setState(() => _err = '请填写商品名称');
      return null;
    }
    if (_baseUnit.trim().isEmpty) {
      setState(() => _err = '请选择基础单位');
      return null;
    }
    final Map<String, double> conversions = {};
    for (final r in _convs) {
      final String u = r.unit.trim();
      if (u.isEmpty) continue;
      if (u == _baseUnit) continue;
      final double? factor = double.tryParse(r.factorCtl.text.trim());
      if (factor == null || factor <= 0) {
        setState(() => _err = '换算「$u」的系数要填大于 0 的数字');
        return null;
      }
      conversions[u] = factor;
    }
    conversions[_baseUnit] = 1;

    final String def = _defaultUnit.trim().isEmpty ? _baseUnit : _defaultUnit.trim();
    // 后端把 default_unit 当换算表的键来折算库存与均价，缺键会算错，这里拦住
    if (!conversions.containsKey(def)) {
      setState(() => _err = '默认单位「$def」不在换算表里，请补一行换算');
      return null;
    }
    final double f = conversions[def] ?? 1;

    final List<Map<String, dynamic>> links = [];
    if (_type == 'order') {
      for (final l in _links) {
        if (l.productId <= 0) continue;
        final double? m = double.tryParse(l.multCtl.text.trim());
        if (m == null || m <= 0) {
          setState(() => _err = '「${l.name}」的扣减倍数要大于 0');
          return null;
        }
        links.add(<String, dynamic>{'product_id': l.productId, 'multiplier': m});
      }
    }

    final List<Map<String, dynamic>> packItems = [];
    for (final r in _packs) {
      if (r.productId <= 0) continue;
      final double? q = double.tryParse(r.qtyCtl.text.trim());
      if (q == null || q <= 0) {
        setState(() => _err = '「${r.name}」的关联结算数量要大于 0');
        return null;
      }
      final Map<String, dynamic>? target = _productIndex[r.productId];
      final List<String> units = _unitsOf(target);
      if (r.unit.isEmpty || !units.contains(r.unit)) {
        setState(() => _err = '请为「${r.name}」选择其换算表里的结算单位');
        return null;
      }
      packItems.add(<String, dynamic>{
        'product_id': r.productId,
        'quantity': q,
        'unit': r.unit,
      });
    }

    double? ratio;
    if (_unitChanged && !_noHistory) {
      final double v = _textNum(_ratioCtl);
      if (v > 0) {
        ratio = v;
      } else if (_historySuspect) {
        // 后端此时会 400（_rescale_base_unit_change），前端先拦住并说清怎么解开
        final String old = wsS(widget.product!['base_unit']);
        setState(() => _err = '从「$old」改成「$_baseUnit」不是一个类别，该商品已有 '
            '${_qty(widget.product!['stock'])} ${_qty(old)} 库存或出入库记录，'
            '必须填写换算关系：1 $old = ? $_baseUnit；'
            '否则历史数量与成本会被按新单位重新解读、均价会被放大倍数。'
            '如果它确实还没有入库/出库记录，勾选下方「该商品还没有出入库流水」。');
        return null;
      }
      // 没有历史数据时留空即可（后端不做折算），与网页端一致
    }

    final double unitCostBase = _textNum(_costCtl) / f;
    return <String, dynamic>{
      'code': _codeCtl.text.trim(),
      'name': name,
      'category': _category.trim(),
      'product_type': _type,
      'base_unit': _baseUnit,
      'default_unit': def,
      'spec': _specCtl.text.trim(),
      // 界面上售价/成本按默认单位填，存库要折回基础单位
      'sale_price': _textNum(_saleCtl) / f,
      'unit_cost': unitCostBase,
      'weight_kg': _textNum(_weightCtl),
      'pack_fee': _textNum(_feeCtl),
      'free_shipping': _freeShipping,
      'is_active': _active,
      'conversions': conversions,
      'pack_items': packItems,
      'stock_links': links,
      // 旧的两个单关联键后端会按第一条 links 回填，一并给上，避免旧口径读出来是空
      'stock_product_id': links.isEmpty ? null : wsI(links.first['product_id']),
      'multiplier': links.isEmpty ? 1.0 : wsD(links.first['multiplier'], fallback: 1),
      'unit_change_ratio': ratio,
    };
  }

  List<String> _unitsOf(Map<String, dynamic>? p) {
    if (p == null) return const [];
    final Map<String, double> conv = _convOf(p);
    if (conv.isNotEmpty) return conv.keys.toList();
    final String du = _unitOf(p);
    return du.isEmpty ? const [] : [du];
  }

  Future<void> _submit() async {
    if (_saving) return;
    final Map<String, dynamic>? body = _collect();
    if (body == null) return;

    // 代发商品成本按「参考成本」计，没填会算成 0 —— 与网页端一样先确认一次（不拦保存）
    if (wsS(body['product_type']) == 'order' &&
        (body['stock_links'] as List).isEmpty &&
        wsD(body['unit_cost']) <= 0) {
      final bool go = await wsConfirm(
        context,
        title: '代发商品没有参考成本',
        message: '该订单商品未关联库存商品（= 代发），但「参考成本」为 0，代发成本会按 0 计。仍要保存吗？',
        okLabel: '仍然保存',
      );
      if (!go || !mounted) return;
    }

    setState(() {
      _saving = true;
      _err = '';
    });
    try {
      final int id = _isEdit ? wsI(widget.product!['id']) : 0;
      if (id > 0) {
        await ApiService.updateProduct(id, body);
      } else {
        await ApiService.createProduct(body);
      }
      if (!mounted) return;
      Navigator.of(context).pop();
      widget.onSaved(id > 0 ? '已保存修改' : '已新增商品');
    } on ApiException catch (e) {
      // 同名 / 类型非法 / 关联的大类不存在 / 换单位缺换算关系，都用后端中文原因
      if (mounted) setState(() => _err = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // ------------------------------------------------------------ 构建

  @override
  Widget build(BuildContext context) {
    final List<String> unitNames = _unitOptions;
    final List<String> defUnits = _defaultUnitOptions;
    final String priceUnit = _defaultUnit.isEmpty ? _baseUnit : _defaultUnit;

    return Form(
      key: _formKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_err.isNotEmpty) DesktopNotice(_err, kind: DesktopNoticeKind.error),
          if (_unitChanged) ...[
            DesktopNotice(
              '换基础单位：「${wsS(widget.product?['base_unit'])}」→「$_baseUnit」跨了类别（计数 ↔ 重量）。'
              '历史数量与成本要按下面的换算关系折算（如 1 个 = 300 克）：'
              '${_historySuspect ? '该商品已有库存或出入库记录，必填' : '留空即可（该商品看起来还没有出入库单据）'}'
              '，否则同一个数字的含义会悄悄变掉、均价被放大倍数。',
              kind: DesktopNoticeKind.warn,
            ),
          ],
          _section('基本信息'),
          DesktopFormRow(
            label: '商品名称',
            required: true,
            width: 360,
            child: DesktopTextField(controller: _nameCtl, hintText: '如：佛手柑大果2个', width: 360),
          ),
          DesktopFormRow(
            label: '商品编码',
            width: 360,
            tip: '平台货号，可留空',
            child: DesktopTextField(controller: _codeCtl, hintText: '如 ydj001', width: 360),
          ),
          DesktopFormRow(
            label: '分类',
            width: 360,
            tip: '候选取自现有商品分类 + 常用固定值',
            child: Row(
              children: [
                DesktopSearchField(
                  title: '选择分类',
                  width: 200,
                  value: _category,
                  options: [
                    for (final c in _categoryWithCurrent(widget.categories, _category))
                      DesktopOption<String>(c, c),
                  ],
                  onChanged: (v) => setState(() {
                    _category = v ?? _category;
                    _categoryCtl.text = _category;
                  }),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 140,
                  child: DesktopTextField(
                    hintText: '或手输新分类',
                    controller: _categoryCtl,
                    onChanged: (v) => _category = v,
                  ),
                ),
              ],
            ),
          ),
          DesktopFormRow(
            label: '商品类型',
            required: true,
            width: 460,
            tip: _type == 'order' ? '订单商品固定基础单位「单」，出库时按倍数扣减库存商品' : '库存商品：真实库存，可入库 / 盘点',
            child: Row(
              children: [
                ChoiceChip(
                  label: const Text('库存商品（大类）', style: TextStyle(fontSize: 12)),
                  selected: _type == 'stock',
                  onSelected: (_) => setState(() {
                    _type = 'stock';
                  }),
                ),
                const SizedBox(width: 8),
                ChoiceChip(
                  label: const Text('订单商品（小类）', style: TextStyle(fontSize: 12)),
                  selected: _type == 'order',
                  onSelected: (_) => setState(() {
                    _type = 'order';
                    _setBaseUnit('单');
                  }),
                ),
              ],
            ),
          ),
          DesktopFormRow(
            label: '规格说明',
            width: 360,
            child: DesktopTextField(
                controller: _specCtl, hintText: '如：每个约150克；或每袋5斤', width: 360),
          ),
          const SizedBox(height: 6),
          _section('单位与换算'),
          DesktopFormRow(
            label: '基础单位',
            required: true,
            width: 260,
            tip: '库存与成本都按它记账：重量类 = 克，计数类 = 个，订单商品 = 单',
            child: DesktopSearchField(
              title: '选择基础单位',
              width: 240,
              value: _baseUnit,
              options: [for (final u in unitNames) DesktopOption<String>(u, u)],
              onChanged: (v) => setState(() => _setBaseUnit(v ?? _baseUnit)),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 108, bottom: 10),
            child: Text(
              '基础单位「$_baseUnit」恒等于 1，其它单位填 1 个它等于几个基础单位',
              style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 108, bottom: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final r in _convs)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      children: [
                        DesktopSearchField(
                          title: '选择单位',
                          width: 160,
                          value: r.unit,
                          hint: '选择单位…',
                          options: [for (final u in unitNames) DesktopOption<String>(u, u)],
                          onChanged: (v) => setState(() {
                            r.unit = v ?? '';
                            _syncDefaultUnit();
                          }),
                        ),
                        const SizedBox(width: 8),
                        const Text('=', style: TextStyle(fontSize: 13)),
                        const SizedBox(width: 8),
                        DesktopTextField(
                          controller: r.factorCtl,
                          width: 120,
                          hintText: '$_baseUnit 数',
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          inputFormatters: DesktopTextField.decimalOnly,
                          onChanged: (_) => setState(() => _syncPriceFactor()),
                        ),
                        const SizedBox(width: 8),
                        wsCell(_baseUnit, color: WsTokens.mutedLight),
                        const Spacer(),
                        DesktopIconButton(
                          icon: Icons.remove_circle_outline,
                          color: WsTokens.red,
                          tooltip: '删除这一行',
                          onPressed: () => setState(() {
                            r.dispose();
                            _convs.remove(r);
                            _syncDefaultUnit();
                          }),
                        ),
                      ],
                    ),
                  ),
                DesktopButton(
                  label: '＋ 加一行换算',
                  small: true,
                  onPressed: () => setState(() => _convs.add(_ConvRow())),
                ),
              ],
            ),
          ),
          DesktopFormRow(
            label: '默认单位',
            required: true,
            width: 260,
            tip: '库存与均价都按它展示，必须是换算表里的键',
            child: DesktopSelect<String>(
              width: 240,
              value: defUnits.contains(priceUnit) ? priceUnit : _baseUnit,
              options: [for (final u in defUnits) DesktopOption<String>(u, u)],
              onChanged: (v) {
                final String next = v ?? _baseUnit;
                final double nf = _convMap()[next] ?? 1;
                setState(() {
                  _defaultUnit = next;
                  _rescalePrices(nf);
                });
              },
            ),
          ),
          const SizedBox(height: 6),
          _section('价格与费用'),
          DesktopFormRow(
            label: '默认售价',
            width: 220,
            tip: '元/$priceUnit（${_curFactor == 1 ? '与基础单位一致' : '1$priceUnit = ${_qty(_curFactor)}$_baseUnit'}）；出库时按这个价带出',
            child: DesktopTextField(
              controller: _saleCtl,
              width: 200,
              hintText: '0.00',
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: DesktopTextField.decimalOnly,
            ),
          ),
          DesktopFormRow(
            label: '参考成本',
            width: 220,
            tip: _costHintText(priceUnit),
            child: DesktopTextField(
              controller: _costCtl,
              width: 200,
              hintText: '0.00',
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: DesktopTextField.decimalOnly,
            ),
          ),
          DesktopFormRow(
            label: '单件净重',
            width: 220,
            tip: 'kg/默认单位，用于算快递费；库存类按扣减量推导不出来时靠这里兜底，代发商品填了也按净重结算',
            child: DesktopTextField(
              controller: _weightCtl,
              width: 200,
              hintText: '如 0.2',
              keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
            ),
          ),
          DesktopFormRow(
            label: '打包费',
            width: 220,
            tip: '每单固定人工 / 包装费（元）',
            child: DesktopTextField(
              controller: _feeCtl,
              width: 200,
              hintText: '0.00',
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: DesktopTextField.decimalOnly,
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 108, bottom: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: _freeShipping,
                  onChanged: (v) => setState(() => _freeShipping = v),
                  title: const Text('包邮（出库不计快递费）', style: TextStyle(fontSize: 13)),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: _active,
                  onChanged: (v) => setState(() => _active = v),
                  title: const Text('在用（停用后不再出现在选择列表）', style: TextStyle(fontSize: 13)),
                ),
                if (_unitChanged)
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    value: _noHistory,
                    onChanged: (v) => setState(() => _noHistory = v),
                    title: const Text('该商品还没有出入库流水（无需折算历史数量）',
                        style: TextStyle(fontSize: 13)),
                  ),
              ],
            ),
          ),
          if (_unitChanged)
            DesktopFormRow(
              label: '换算关系',
              required: !_noHistory && _historySuspect,
              width: 220,
              tip: '1 ${wsS(widget.product?['base_unit'])} = ？ $_baseUnit',
              child: DesktopTextField(
                controller: _ratioCtl,
                width: 200,
                hintText: _noHistory ? '无需填写' : (_historySuspect ? '必填，如 300' : '如 300，无单据可留空'),
                readonly: _noHistory,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: DesktopTextField.decimalOnly,
              ),
            ),
          const SizedBox(height: 6),
          _section('扣减库存关联（订单商品）'),
          if (_type == 'order')
            Padding(
              padding: const EdgeInsets.only(left: 108, bottom: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (widget.stocks.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(bottom: 8),
                      child: Text('库存商品为空，请先到「库存商品」页签新增',
                          style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                    ),
                  for (final l in _links)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 240,
                            child: DesktopSearchField(
                              title: '选择库存商品（大类）',
                              width: 240,
                              value: '${l.productId}',
                              hint: '选择库存商品…',
                              options: [
                                for (final s in widget.stocks)
                                  DesktopOption<String>(
                                    '${wsI(s['id'])}',
                                    '${wsS(s['name'])}（${wsS(s['category'], fallback: '—')}·单位${_unitOf(s)}）',
                                  ),
                              ],
                              onChanged: (v) {
                                final int id = int.tryParse(v ?? '') ?? 0;
                                setState(() {
                                  l.productId = id;
                                  l.name = wsS(_productIndex[id]?['name'], fallback: '所选商品');
                                });
                              },
                            ),
                          ),
                          const SizedBox(width: 8),
                          wsCell('×', color: WsTokens.mutedLight),
                          const SizedBox(width: 8),
                          DesktopTextField(
                            controller: l.multCtl,
                            width: 96,
                            hintText: '倍数',
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            inputFormatters: DesktopTextField.decimalOnly,
                          ),
                          const SizedBox(width: 8),
                          DesktopIconButton(
                            icon: Icons.link_off,
                            color: WsTokens.red,
                            tooltip: '不再关联',
                            onPressed: () => setState(() {
                              l.dispose();
                              _links.remove(l);
                            }),
                          ),
                        ],
                      ),
                    ),
                  DesktopButton(
                    label: '＋ 添加扣减库存商品',
                    small: true,
                    onPressed: () => setState(() => _links.add(_LinkRow())),
                  ),
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Text(
                      '卖 1 单本商品时，从下面每个库存商品按其倍数扣减库存（如 礼盒 = 苹果1斤 + 梨1斤）；'
                      '一个都不填 = 代发：本仓不扣任何库存，只统计代发数量与代发成本（按参考成本计）。',
                      style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
                    ),
                  ),
                ],
              ),
            )
          else
            const Padding(
              padding: EdgeInsets.only(left: 108, bottom: 12),
              child: Text('库存大类本身不扣减别的商品；切到「订单商品」才能配扣减关联。',
                  style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
            ),
          _section('出库关联结算清单'),
          Padding(
            padding: const EdgeInsets.only(left: 108, bottom: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final r in _packs)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 240,
                          child: DesktopSearchField(
                            title: '选择关联商品',
                            width: 240,
                            value: '${r.productId}',
                            hint: '选择关联商品…',
                            options: [
                              for (final p in widget.products)
                                if (p['is_active'] != false)
                                  DesktopOption<String>(
                                    '${wsI(p['id'])}',
                                    '${wsS(p['name'])}（${wsS(p['category'], fallback: '—')}）',
                                  ),
                            ],
                            onChanged: (v) {
                              final int id = int.tryParse(v ?? '') ?? 0;
                              final Map<String, dynamic>? t = _productIndex[id];
                              setState(() {
                                r.productId = id;
                                r.name = wsS(t?['name'], fallback: '所选商品');
                                final List<String> us = _unitsOf(t);
                                r.unit = us.isEmpty ? '' : us.first;
                              });
                            },
                          ),
                        ),
                        const SizedBox(width: 8),
                        DesktopTextField(
                          controller: r.qtyCtl,
                          width: 96,
                          hintText: '每单用量',
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          inputFormatters: DesktopTextField.decimalOnly,
                        ),
                        const SizedBox(width: 8),
                        DesktopSelect<String>(
                          width: 110,
                          value: r.unit,
                          hint: '单位',
                          options: [for (final u in _unitsOf(_productIndex[r.productId])) DesktopOption<String>(u, u)],
                          onChanged: (v) => setState(() => r.unit = v ?? ''),
                        ),
                        const SizedBox(width: 8),
                        DesktopIconButton(
                          icon: Icons.delete_outline,
                          color: WsTokens.red,
                          tooltip: '删除这一行',
                          onPressed: () => setState(() {
                            r.dispose();
                            _packs.remove(r);
                          }),
                        ),
                      ],
                    ),
                  ),
                DesktopButton(
                  label: '＋ 添加关联结算商品',
                  small: true,
                  onPressed: () => setState(() => _packs.add(_PackRow())),
                ),
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text(
                    '卖 1 单本商品时自动扣减这些商品的库存（包材 / 人工等）；'
                    '结算单位必须在该商品的换算表里。',
                    style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              DesktopButton(label: '取消', onPressed: _saving ? null : () => Navigator.of(context).pop()),
              const SizedBox(width: 10),
              DesktopButton(
                label: _saving ? '保存中…' : (_isEdit ? '✓ 保存修改' : '✓ 新增商品'),
                kind: DesktopButtonKind.primary,
                onPressed: _saving ? null : _submit,
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _setBaseUnit(String unit) {
    final double oldF = _curFactor <= 0 ? 1 : _curFactor;
    _baseUnit = unit;
    // 基础单位行不入换算表行；把与新基础单位重名的行去掉
    _convs.removeWhere((r) => r.unit.trim() == unit);
    if (!_defaultUnitOptions.contains(_defaultUnit)) _defaultUnit = unit;
    final double nf = _convMap()[_defaultUnit] ?? 1;
    _curFactor = oldF;
    _rescalePrices(nf);
  }

  void _syncPriceFactor() {
    final double nf = _convMap()[_defaultUnit] ?? 1;
    _rescalePrices(nf);
  }

  /// 换算表改完后，若当前默认单位已经不在表里就退回基础单位（用实时选项，避免用构建期的旧列表）
  void _syncDefaultUnit() {
    if (!_defaultUnitOptions.contains(_defaultUnit)) _defaultUnit = _baseUnit;
  }

  String _costHintText(String priceUnit) {
    final double avg = wsD(widget.product?['avg_cost']);
    final String conv = _curFactor == 1 ? '' : '（1$priceUnit = ${_qty(_curFactor)}$_baseUnit）';
    String t = '按默认单位填$conv；包材 / 人工等无入库时按此成本结算（如纸箱 0.9 元/个）';
    if (avg > 0) {
      t += '。注意：该商品已有库存均价 ${wsMoney(avg * _curFactor)}/$priceUnit（由出入库自动形成），'
          '列表「参考成本」优先显示它、出库成本也按它算，改这里不会立刻改变均价';
    }
    return t;
  }

  Widget _section(String title) => Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 10),
        child: Row(
          children: [
            Container(width: 3, height: 14, color: WsTokens.primary),
            const SizedBox(width: 8),
            Text(title, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
          ],
        ),
      );
}

List<String> _categoryWithCurrent(List<String> candidates, String current) {
  final List<String> out = [
    for (final c in candidates)
      if (c != current) c,
  ];
  if (current.trim().isNotEmpty) out.insert(0, current.trim());
  return out;
}

// ================================================================== 单位管理

class _UnitsPanel extends StatefulWidget {
  const _UnitsPanel({required this.units, required this.onChanged});

  final List<Map<String, dynamic>> units;
  final VoidCallback onChanged;

  @override
  State<_UnitsPanel> createState() => _UnitsPanelState();
}

class _UnitsPanelState extends State<_UnitsPanel> {
  late List<Map<String, dynamic>> _rows = widget.units;
  final TextEditingController _nameCtl = TextEditingController();
  final TextEditingController _gramCtl = TextEditingController();
  String _category = 'count';
  String _err = '';
  bool _busy = false;

  @override
  void dispose() {
    _nameCtl.dispose();
    _gramCtl.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final List<dynamic> data = await ApiService.units();
      if (!mounted) return;
      setState(() => _rows = _asMapList(data));
    } on ApiException catch (e) {
      if (mounted) setState(() => _err = e.message);
    }
    widget.onChanged();
  }

  Future<void> _create() async {
    final String name = _nameCtl.text.trim();
    if (name.isEmpty) {
      setState(() => _err = '单位名称不能为空');
      return;
    }
    setState(() {
      _busy = true;
      _err = '';
    });
    try {
      await ApiService.createUnit(<String, dynamic>{
        'name': name,
        'category': _category,
        'gram_per_unit': _category == 'weight' ? (_textNum(_gramCtl) > 0 ? _textNum(_gramCtl) : null) : null,
      });
      _nameCtl.clear();
      _gramCtl.clear();
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) setState(() => _err = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete(Map<String, dynamic> u) async {
    final int id = wsI(u['id']);
    final String name = wsS(u['name']);
    if (id <= 0) return;
    final bool ok = await wsConfirm(
      context,
      title: '删除单位「$name」？',
      message: '标准单位删不掉（后端会拒绝）；删除后已用到它的商品换算关系不会自动补。',
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      await ApiService.deleteUnit(id);
      await _refresh();
      if (!mounted) return;
      wsToast(context, '已删除');
    } on ApiException catch (e) {
      // 被引用 / 标准单位时后端回 400，detail 原样展示
      if (mounted) wsToast(context, '删除失败：${e.message}', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_err.isNotEmpty) DesktopNotice(_err, kind: DesktopNoticeKind.error),
        const DesktopNotice(
          '重量类单位需填写「每单位克数」，如 斤=500克；计数类按商品自行设置换算。标准单位不可删除。',
          kind: DesktopNoticeKind.info,
        ),
        DesktopGrid(
          dense: true,
          cols: const [
            DesktopCol('单位', width: 160),
            DesktopCol('类型', width: 110, center: true),
            DesktopCol('每单位克数', width: 150, right: true),
            DesktopCol('操作', width: 90),
          ],
          rows: [
            for (final u in _rows)
              DesktopRow(cells: [
                wsCell(wsS(u['name']), bold: true),
                wsS(u['category']) == 'weight'
                    ? const DesktopTag('重量', color: WsTokens.primary)
                    : const DesktopTag('计数', color: DesktopTag.off),
                wsCell(wsD(u['gram_per_unit']) > 0 ? '${_qty(u['gram_per_unit'])} 克' : '—'),
                DesktopLink('删除', color: WsTokens.red, onPressed: () => _delete(u)),
              ]),
          ],
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            const Text('新增单位', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            const SizedBox(width: 12),
            DesktopTextField(controller: _nameCtl, width: 150, hintText: '单位名称，如：提、扎'),
            const SizedBox(width: 10),
            DesktopSelect<String>(
              width: 190,
              value: _category,
              options: const [
                DesktopOption<String>('count', '计数（个/袋/包…）'),
                DesktopOption<String>('weight', '重量（克/斤/公斤…）'),
              ],
              onChanged: (v) => setState(() => _category = v ?? _category),
            ),
            const SizedBox(width: 10),
            DesktopTextField(
              controller: _gramCtl,
              width: 150,
              hintText: _category == 'weight' ? '每单位克数，如 500' : '计数类无需填',
              readonly: _category != 'weight',
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: DesktopTextField.decimalOnly,
            ),
            const SizedBox(width: 10),
            DesktopButton(
              label: '＋ 新增单位',
              kind: DesktopButtonKind.primary,
              onPressed: _busy ? null : _create,
            ),
          ],
        ),
      ],
    );
  }
}
