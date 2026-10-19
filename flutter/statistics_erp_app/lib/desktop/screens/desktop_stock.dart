import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';
import 'package:solar_icons/solar_icons.dart';

/// 桌面端「库存管理」，1:1 复刻 web #page-stock 的四个分区：
/// 库存总览 / 库存流水 / 盘点记录 / 工作量统计。
///
/// 数据口径沿用移动端 StockScreen（同一套后端接口）：
/// - /api/stock-overview 只返回「启用」的库存商品，规格 / 参考成本 / 最近入库要从
///   /api/products 合并过来，停用的库存商品也在那份全量里补上（置灰展示）；
/// - /api/movements 返回分页对象（total / rows / truncated），合并出库、关键字、
///   排序都在后端做，前端点表头只能带 sort/dir 重新请求（否则只有当页有序）；
/// - /api/adjust 的三个调整值必须是 +/- 开头的相对值（后端正则 `^[+-]\d+(\.\d+)?$`）。
class DesktopStockScreen extends StatefulWidget {
  const DesktopStockScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopStockScreen> createState() => _DesktopStockScreenState();
}

// ================================================================ 公共辅助

final RegExp _signedRe = RegExp(r'^[+-]\d+(\.\d+)?\$');
final RegExp _bareNumRe = RegExp(r'^\d+(\.\d+)?\$');
final RegExp _docCodeRe = RegExp(r'CK\S+');

/// 与网页端 fmtNum 一致：整数不带小数，小数最多 4 位且去尾零
String _num(dynamic v) {
  final double d = wsD(v);
  if ((d - d.roundToDouble()).abs() < 1e-6) return d.round().toString();
  return double.parse(d.toStringAsFixed(4)).toString();
}

/// 带正号的变动量（负数本身已带 -）
String _signed(dynamic v) {
  final double d = wsD(v);
  return d > 0 ? '+${_num(d)}' : _num(d);
}

String _dateStr(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

String _monthOf(String date) => date.length >= 7 ? date.substring(5) : date;

/// 商品默认展示 / 出库单位（web 的 defaultUnit）
String _unitOf(Map<String, dynamic> row) {
  final String du = wsS(row['default_unit']);
  if (du.isNotEmpty) return du;
  return wsS(row['base_unit']);
}

/// 展示单位 → 基础单位的换算系数（web 的 unitFactor）
double _factor(Map<String, dynamic> row, String unit) {
  final conv = row['conversions'];
  if (conv is Map && conv.isNotEmpty) {
    final double f = wsD(conv[unit], fallback: 1);
    if (f != 0) return f;
  }
  return 1;
}

/// 默认单位下的库存量
double _dispStock(Map<String, dynamic> row) => wsD(row['stock']) / _factor(row, _unitOf(row));

/// 参考成本（默认单位）：优先库存均价，无均价才用手填参考成本（web 的 refCostValue）
double? _refCost(Map<String, dynamic> row) {
  final double du = _factor(row, _unitOf(row));
  final double avg = wsD(row['avg_cost']);
  if (avg > 0) return avg * du;
  final double uc = wsD(row['unit_cost']);
  if (uc > 0) return uc * du;
  return null;
}

String _refCostText(Map<String, dynamic> row) {
  final double? v = _refCost(row);
  if (v == null) return '—';
  final bool fromAvg = wsD(row['avg_cost']) > 0;
  return '${wsMoney(v)}/${_unitOf(row)}${fromAvg ? '' : '（参考）'}';
}

String _refCostTip(Map<String, dynamic> row) {
  final String du = _unitOf(row);
  final double f = _factor(row, du);
  final String ref = wsD(row['unit_cost']) > 0 ? '${wsMoney(wsD(row['unit_cost']) * f)}/$du' : '未设置';
  if (wsD(row['avg_cost']) > 0) {
    return '显示的是库存均价 ${wsMoney(wsD(row['avg_cost']) * f)}/$du（随出入库自动重算）；手填参考成本：$ref';
  }
  if (wsD(row['unit_cost']) > 0) return '该商品还没有入库均价，显示的是手填参考成本 $ref';
  return '未设置成本：可到商品编辑页按默认单位填「参考成本」，或入库后自动形成均价';
}

/// 排序值比较：数字按大小、其余按文本（与后端 /movements 的码位排序口径一致）
int _cmpValues(dynamic a, dynamic b) {
  if (a is num && b is num) return a.compareTo(b);
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a.toString().compareTo(b.toString());
}

List<T> _sortedBy<T>(List<T> src, dynamic Function(T) keyOf, bool asc) {
  final List<T> out = src.toList();
  out.sort((x, y) {
    final int r = _cmpValues(keyOf(x), keyOf(y));
    return asc ? r : -r;
  });
  return out;
}

String _moveTypeLabel(String t) => switch (t) {
      'in' => '入库',
      'out' => '出库',
      'pack_out' => '包装消耗',
      'pack' => '打包',
      'work' => '工作量',
      'adjust' => '盘点',
      'cost' => '均价重估',
      'avg' => '均价重估',
      'ucost' => '成本单价',
      _ => t.isEmpty ? '其他' : t,
    };

Color _moveTypeColor(String t) => switch (t) {
      'in' => WsTokens.green,
      'out' => WsTokens.red,
      'adjust' => WsTokens.primary,
      'cost' || 'avg' || 'ucost' => WsTokens.amber,
      'work' || 'pack' || 'pack_out' => DesktopTag.expense,
      _ => DesktopTag.off,
    };

Map<String, dynamic> _asMap(dynamic v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

List<Map<String, dynamic>> _asMapList(dynamic v) {
  if (v is! List) return const [];
  return [for (final e in v) _asMap(e)];
}

/// 正数裸数字替用户补 +（手机/桌面数字键盘打 + 不方便）；其余原样交给前置校验
String _normalizeSigned(String raw) {
  final String s = raw.trim();
  if (s.isEmpty || _signedRe.hasMatch(s)) return s;
  if (_bareNumRe.hasMatch(s)) return '+$s';
  return s;
}

// ====================================================================== 页面

class _DesktopStockScreenState extends State<DesktopStockScreen> {
  static const List<String> _tabNames = ['库存总览', '库存流水', '盘点记录', '工作量统计'];

  int _tab = 0;

  // ---------------- 库存总览 ----------------
  List<Map<String, dynamic>> _ovRows = [];
  List<dynamic> _products = [];
  bool _ovLoading = false;
  bool _ovLoaded = false;
  String? _ovError;
  final TextEditingController _ovKwCtl = TextEditingController();
  String _ovKeyword = '';
  String _ovCategory = '';
  String _ovStatus = 'all';
  String _ovSortKey = 'stock_value';
  bool _ovSortAsc = false;

  // ---------------- 库存流水 ----------------
  List<Map<String, dynamic>> _mvRows = [];
  Map<String, dynamic> _mvChart = const {};
  bool _mvLoading = false;
  bool _mvLoaded = false;
  String? _mvError;
  int? _mvProductId;
  String _mvFrom = '';
  String _mvTo = '';
  final TextEditingController _mvKwCtl = TextEditingController();
  String _mvKeyword = '';
  bool _mvMergeOut = true;
  String _mvSort = 'date';
  bool _mvDirDesc = true;
  int _mvLimit = 100;
  int _mvOffset = 0;
  int _mvTotal = 0;
  bool _mvTruncated = false;
  bool _mvMergedFlag = true;

  // ---------------- 盘点记录 ----------------
  List<Map<String, dynamic>> _adjRows = [];
  bool _adjLoading = false;
  bool _adjLoaded = false;
  String? _adjError;
  String _adjFrom = '';
  String _adjTo = '';
  final TextEditingController _adjKwCtl = TextEditingController();
  String _adjKeyword = '';
  String _adjSortKey = 'date';
  bool _adjSortAsc = false;

  // ---------------- 工作量统计 ----------------
  Map<String, dynamic> _wl = const {};
  bool _wlLoading = false;
  bool _wlLoaded = false;
  String? _wlError;
  String _wlFrom = '';
  String _wlTo = '';
  String _wlSortKey = 'workload';
  bool _wlSortAsc = false;

  @override
  void initState() {
    super.initState();
    final DateTime now = DateTime.now();
    _mvFrom = _dateStr(now.subtract(const Duration(days: 29)));
    _mvTo = wsToday();
    _wlFrom = wsMonthStart();
    _wlTo = wsToday();
    _loadOverview();
    _loadMovements();
  }

  @override
  void dispose() {
    _ovKwCtl.dispose();
    _mvKwCtl.dispose();
    _adjKwCtl.dispose();
    super.dispose();
  }

  // ---------------- 数据加载 ----------------

  Future<void> _loadOverview() async {
    setState(() => _ovLoading = true);
    try {
      final List<List<dynamic>> results = await Future.wait<List<dynamic>>(
          [ApiService.stockOverview(), ApiService.products()]);
      _products = results[1];
      _ovRows = _buildOverviewRows(results[0]);
      _ovError = null;
      _ovLoaded = true;
    } on ApiException catch (e) {
      _ovError = e.message;
      if (mounted) wsToast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _ovLoading = false);
    }
  }

  /// 总览接口只给库存与均价，规格 / 参考成本 / 最近入库 / 是否启用都要从商品全量表合并
  List<Map<String, dynamic>> _buildOverviewRows(List<dynamic> overview) {
    final Map<int, Map<String, dynamic>> byId = {};
    for (final dynamic raw in _products) {
      final Map<String, dynamic> p = _asMap(raw);
      byId[wsI(p['id'])] = p;
    }
    final List<Map<String, dynamic>> rows = [];
    final Set<int> picked = {};
    for (final dynamic raw in overview) {
      final Map<String, dynamic> m = _asMap(raw);
      final int id = wsI(m['id']);
      picked.add(id);
      final Map<String, dynamic>? p = byId[id];
      if (p != null) {
        m['spec'] = p['spec'];
        m['unit_cost'] = p['unit_cost'];
        m['last_in_date'] = p['last_in_date'];
        m['last_in_unit'] = p['last_in_unit'];
        m['last_in_unit_price'] = p['last_in_unit_price'];
        m['last_in_price'] = p['last_in_price'];
      }
      m['is_active'] = true;
      rows.add(m);
    }
    // 后端总览不含停用商品：从商品全量表补进来，让「停用置灰」这一状态看得到
    for (final Map<String, dynamic> p in byId.values) {
      final int id = wsI(p['id']);
      if (picked.contains(id)) continue;
      if (wsS(p['product_type']) != 'stock') continue;
      if (p['is_active'] == true) continue;
      final String cat = wsS(p['category']);
      if (cat == '人工' || cat == '快递') continue;
      rows.add(Map<String, dynamic>.from(p));
    }
    return rows;
  }

  Future<void> _loadMovements() async {
    setState(() => _mvLoading = true);
    try {
      final Map<String, dynamic> data = await ApiService.movements(
        productId: _mvProductId,
        dateFrom: _mvFrom,
        dateTo: _mvTo,
        keyword: _mvKeyword,
        mergeOut: _mvMergeOut,
        sort: _mvSort,
        dir: _mvDirDesc ? 'desc' : 'asc',
        limit: _mvLimit,
        offset: _mvOffset,
      );
      _mvRows = _asMapList(data['rows']);
      _mvTotal = wsI(data['total'], fallback: _mvRows.length);
      _mvLimit = wsI(data['limit'], fallback: _mvLimit);
      _mvOffset = wsI(data['offset']);
      _mvTruncated = data['truncated'] == true;
      _mvMergedFlag = data['merged'] == true;
      _mvError = null;
      _mvLoaded = true;
      // 图表与明细分开取：图表走聚合接口，口径只含真实库存进出，且不受分页影响
      _mvChart = await ApiService.movementsChart(
          productId: _mvProductId, dateFrom: _mvFrom, dateTo: _mvTo);
    } on ApiException catch (e) {
      _mvError = e.message;
      if (mounted) wsToast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _mvLoading = false);
    }
  }

  Future<void> _loadAdjustments() async {
    setState(() => _adjLoading = true);
    try {
      final List<dynamic> data =
          await ApiService.adjustments(dateFrom: _adjFrom, dateTo: _adjTo);
      _adjRows = _asMapList(data);
      _adjError = null;
      _adjLoaded = true;
    } on ApiException catch (e) {
      _adjError = e.message;
      if (mounted) wsToast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _adjLoading = false);
    }
  }

  Future<void> _loadWorkload() async {
    setState(() => _wlLoading = true);
    try {
      _wl = await ApiService.workload(dateFrom: _wlFrom, dateTo: _wlTo);
      _wlError = null;
      _wlLoaded = true;
    } on ApiException catch (e) {
      _wlError = e.message;
      if (mounted) wsToast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _wlLoading = false);
    }
  }

  void _switchTab(int i) {
    setState(() => _tab = i);
    if (i == 0 && !_ovLoaded) _loadOverview();
    if (i == 1 && !_mvLoaded) _loadMovements();
    if (i == 2 && !_adjLoaded) _loadAdjustments();
    if (i == 3 && !_wlLoaded) _loadWorkload();
  }

  void _reloadCurrent() {
    if (_tab == 0) {
      _loadOverview();
    } else if (_tab == 1) {
      _mvOffset = 0;
      _loadMovements();
    } else if (_tab == 2) {
      _loadAdjustments();
    } else {
      _loadWorkload();
    }
  }

  // ---------------- 盘点 / 回退 ----------------

  /// 新增盘点（preset 为总览里的商品行，可直接带出商品与单位）
  void _openAdjust([Map<String, dynamic>? preset]) {
    if (_products.isEmpty) _loadOverview();
    desktopDialog<void>(
      context,
      title: '盘点调整（相对增减）',
      width: 660,
      maxHeight: 780,
      builder: (_) => _AdjustForm(
        stock: _adjustableProducts(),
        preset: preset,
        operator: widget.auth.displayName,
        onDone: (String message) {
          wsToast(context, message);
          _loadOverview();
          _loadAdjustments();
          _loadMovements();
        },
      ),
    );
  }

  /// 可盘点商品：与网页端同口径（启用 + 库存商品 + 排除人工/快递）
  List<Map<String, dynamic>> _adjustableProducts() {
    final List<Map<String, dynamic>> out = [];
    for (final dynamic raw in _products) {
      final Map<String, dynamic> p = _asMap(raw);
      if (p['is_active'] != true) continue;
      if (wsS(p['product_type']) != 'stock') continue;
      final String cat = wsS(p['category']);
      if (cat == '人工' || cat == '快递') continue;
      out.add(p);
    }
    out.sort((a, b) => wsS(a['name']).compareTo(wsS(b['name'])));
    return out;
  }

  Future<void> _revertAdjustment(Map<String, dynamic> g) async {
    final int gid = wsI(g['id']);
    final bool ok = await wsConfirm(
      context,
      title: '回退这次盘点？',
      message: '确认删除第 $gid 组盘点调整记录？\n'
          '将回退「${wsS(g['product_name'])}」在 ${wsS(g['date'])} 产生的库存、平均成本与成本单价变动，'
          '相关流水与台账一并撤销，操作不可恢复。',
      okLabel: '删除并回退',
      danger: true,
    );
    if (!ok) return;
    try {
      await ApiService.deleteAdjustment(gid);
      if (!mounted) return;
      wsToast(context, '已删除并回退调整');
      _loadAdjustments();
      _loadOverview();
      _loadMovements();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '删除失败：${e.message}', error: true);
    }
  }

  void _showDetail(Map<String, dynamic> row) {
    desktopDialog<void>(
      context,
      title: '商品库存详情 · ${wsS(row['name'])}',
      width: 800,
      maxHeight: 720,
      builder: (_) => _StockDetail(
        row: row,
        onAdjust: () {
          Navigator.of(context).pop();
          _openAdjust(row);
        },
        onMovements: () {
          Navigator.of(context).pop();
          setState(() {
            _mvProductId = wsI(row['id']);
            _mvOffset = 0;
            _tab = 1;
          });
          _loadMovements();
        },
      ),
    );
  }

  // ================================================================== 构建

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '库存管理',
      subtitle: '分仓「${widget.auth.warehouseName.isEmpty ? '当前分仓' : widget.auth.warehouseName}」'
          '的库存总览、出入库流水、盘点记录与工作量统计；数量与成本都按商品默认单位展示',
      actions: [
        DesktopButton(label: '刷新', icon: SolarIconsOutline.refresh, onPressed: _reloadCurrent),
        DesktopButton(
          label: '盘点调整',
          icon: SolarIconsOutline.pen,
          kind: DesktopButtonKind.primary,
          onPressed: _openAdjust,
        ),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: DesktopTabs(items: _tabNames, index: _tab, onChanged: _switchTab),
          ),
          Expanded(child: _buildTab()),
        ],
      ),
    );
  }

  Widget _buildTab() => switch (_tab) {
        0 => _buildOverview(),
        1 => _buildMovements(),
        2 => _buildAdjustments(),
        _ => _buildWorkload(),
      };

  // ---------------- 库存总览 ----------------

  List<Map<String, dynamic>> get _ovFiltered {
    final String kw = _ovKeyword.trim().toLowerCase();
    final List<Map<String, dynamic>> rows = _ovRows.where((p) {
      if (_ovCategory.isNotEmpty && wsS(p['category']) != _ovCategory) return false;
      final bool active = p['is_active'] != false;
      final double stock = _dispStock(p);
      if (_ovStatus == 'in' && (!active || stock <= 0)) return false;
      if (_ovStatus == 'low' && (!active || stock > 0)) return false;
      if (_ovStatus == 'off' && active) return false;
      if (kw.isEmpty) return true;
      return wsS(p['name']).toLowerCase().contains(kw) ||
          wsS(p['category']).toLowerCase().contains(kw) ||
          wsS(p['spec']).toLowerCase().contains(kw);
    }).toList();
    return _sortedBy(rows, (e) => _ovSortValue(e, _ovSortKey), _ovSortAsc);
  }

  dynamic _ovSortValue(Map<String, dynamic> p, String key) => switch (key) {
        'name' => wsS(p['name']),
        'category' => wsS(p['category']),
        'spec' => wsS(p['spec']),
        'stock' => _dispStock(p),
        'cost' => _refCost(p),
        'stock_value' => wsD(p['stock_value']),
        'last_in_date' => wsS(p['last_in_date']),
        'is_active' => p['is_active'] == false ? 0 : 1,
        _ => wsD(p['stock_value']),
      };

  Widget _buildOverview() {
    final List<Map<String, dynamic>> rows = _ovFiltered;
    final double totalValue = _ovRows.fold<double>(0, (s, p) => s + wsD(p['stock_value']));
    final int lowCount = _ovRows.where((p) => p['is_active'] != false && _dispStock(p) <= 0).length;
    final int offCount = _ovRows.where((p) => p['is_active'] == false).length;
    final List<String> cats = (_ovRows.map((p) => wsS(p['category']))
            .where((c) => c.isNotEmpty)
            .toSet()
            .toList())
          ..sort();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopFilterBar(
          right: DesktopButton(label: '盘点调整', icon: SolarIconsOutline.pen, small: true, onPressed: _openAdjust),
          children: [
            DesktopLabeled(
              label: '分类',
              child: DesktopSelect<String>(
                width: 150,
                value: _ovCategory,
                options: [
                  const DesktopOption<String>('', '全部分类'),
                  for (final c in cats) DesktopOption<String>(c, c),
                ],
                onChanged: (v) => setState(() => _ovCategory = v ?? ''),
              ),
            ),
            DesktopLabeled(
              label: '状态',
              child: DesktopSelect<String>(
                width: 140,
                value: _ovStatus,
                options: const [
                  DesktopOption<String>('all', '全部商品'),
                  DesktopOption<String>('in', '只看有货'),
                  DesktopOption<String>('low', '只看缺货'),
                  DesktopOption<String>('off', '只看停用'),
                ],
                onChanged: (v) => setState(() => _ovStatus = v ?? 'all'),
              ),
            ),
            DesktopLabeled(
              label: '搜索',
              child: DesktopTextField(
                controller: _ovKwCtl,
                width: 260,
                hintText: '搜索商品名称 / 分类 / 规格…',
                onChanged: (v) => setState(() => _ovKeyword = v),
              ),
            ),
            Text('共 ${rows.length} 项（本页面过滤，不重新请求）',
                style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ],
        ),
        Expanded(
          child: DesktopStateView(
            loading: _ovLoading && _ovRows.isEmpty,
            loadingText: '正在读取库存总览…',
            error: _ovError,
            onRetry: _loadOverview,
            child: DesktopScrollBody(
              children: [
                DesktopRise(
                  index: 0,
                  child: DesktopStatGrid(
                    children: [
                      DesktopStatCard(
                          label: '商品种类',
                          value: wsNum(_ovRows.length),
                          sub: '启用 ${_ovRows.length - offCount} · 停用 $offCount'),
                      DesktopStatCard(
                          label: '库存总值',
                          value: wsMoney(totalValue),
                          sub: '${_num(totalValue)} 元库存成本',
                          color: WsTokens.primary),
                      DesktopStatCard(
                          label: '缺货预警',
                          value: wsNum(lowCount),
                          sub: lowCount > 0 ? '需要及时补货' : '库存充足',
                          color: lowCount > 0 ? WsTokens.red : WsTokens.green),
                      DesktopStatCard(
                          label: '停用商品',
                          value: wsNum(offCount),
                          sub: offCount > 0 ? '总览里已置灰，可在商品页恢复' : '无停用商品'),
                    ],
                  ),
                ),
                const SizedBox(height: 18),
                DesktopRise(
                  index: 1,
                  child: WsCard(
                    padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const WsCardHead(
                          title: '库存明细',
                          icon: SolarIconsOutline.boxMinimalistic,
                          trailing: Text('点击任意一行查看商品库存详情',
                              style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                        ),
                        if (rows.isEmpty)
                          _emptyHint(_ovKeyword.isEmpty && _ovStatus == 'all' && _ovCategory.isEmpty
                              ? '暂无数据，请先到「商品管理」添加商品'
                              : '没有符合筛选条件的商品（清空关键词或换个筛选试试）',
                              onGoProducts: _ovRows.isEmpty)
                        else
                          DesktopGrid(
                            cols: const [
                              DesktopCol('商品', width: 210, sortKey: 'name'),
                              DesktopCol('分类', width: 92, sortKey: 'category', center: true),
                              DesktopCol('规格', width: 110, sortKey: 'spec'),
                              DesktopCol('当前库存', width: 132, sortKey: 'stock', right: true),
                              DesktopCol('均价/单位成本', width: 168, sortKey: 'cost', right: true),
                              DesktopCol('库存值', width: 122, sortKey: 'stock_value', right: true),
                              DesktopCol('最近入库', width: 168, sortKey: 'last_in_date'),
                              DesktopCol('状态', width: 84, sortKey: 'is_active', center: true),
                              DesktopCol('操作', width: 148),
                            ],
                            rows: [
                              for (final p in rows)
                                DesktopRow(
                                  dim: p['is_active'] == false,
                                  tag: wsI(p['id']),
                                  onTap: () => _showDetail(p),
                                  cells: [
                                    _nameCell(p),
                                    wsS(p['category']).isEmpty
                                        ? wsCell('—')
                                        : DesktopTag(wsS(p['category']), color: WsTokens.primary),
                                    wsCell(wsS(p['spec'], fallback: '—'), tip: wsS(p['spec'])),
                                    wsCell('${_num(_dispStock(p))} ${_unitOf(p)}',
                                        bold: true,
                                        color: _dispStock(p) <= 0 ? WsTokens.red : null),
                                    Tooltip(
                                      message: _refCostTip(p),
                                      child: Text(_refCostText(p),
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(fontSize: 13)),
                                    ),
                                    wsCell(wsMoney(wsD(p['stock_value']))),
                                    wsCell(_lastInText(p), tip: _lastInText(p)),
                                    p['is_active'] == false
                                        ? const DesktopTag('停用', color: DesktopTag.off)
                                        : (_dispStock(p) <= 0
                                            ? const DesktopTag('缺货', color: WsTokens.red)
                                            : const DesktopTag('在售', color: WsTokens.green)),
                                    Row(
                                      children: [
                                        DesktopLink('流水', onPressed: () => _gotoMovements(wsI(p['id']))),
                                        DesktopLink('盘点', onPressed: () => _openAdjust(p)),
                                      ],
                                    ),
                                  ],
                                ),
                            ],
                            footer: [
                              '合计 ${rows.length} 项',
                              '',
                              '',
                              '',
                              '',
                              wsMoney(rows.fold<double>(0, (s, p) => s + wsD(p['stock_value']))),
                              '',
                              '',
                              '',
                            ],
                            sortKey: _ovSortKey,
                            sortAsc: _ovSortAsc,
                            onSort: (key) => setState(() {
                              if (_ovSortKey == key) {
                                _ovSortAsc = !_ovSortAsc;
                              } else {
                                _ovSortKey = key;
                                _ovSortAsc = false;
                              }
                            }),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _nameCell(Map<String, dynamic> p) {
    final bool low = p['is_active'] != false && _dispStock(p) <= 0;
    return Row(
      children: [
        Flexible(
          child: Text(wsS(p['name']),
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        ),
        if (low) ...[
          const SizedBox(width: 6),
          const DesktopTag('缺货', color: WsTokens.red),
        ],
      ],
    );
  }

  String _lastInText(Map<String, dynamic> p) {
    final String d = wsS(p['last_in_date']);
    if (d.isEmpty) return '—';
    final double price = wsD(p['last_in_unit_price']);
    if (price <= 0) return d;
    final String unit = wsS(p['last_in_unit']);
    return '$d · ¥${price.toStringAsFixed(2)}${unit.isEmpty ? '' : '/$unit'}';
  }

  void _gotoMovements(int productId) {
    setState(() {
      _tab = 1;
      _mvProductId = productId;
      _mvOffset = 0;
    });
    _loadMovements();
  }

  Widget _emptyHint(String text, {bool onGoProducts = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 26),
      child: Column(
        children: [
          const Icon(SolarIconsOutline.inbox, size: 30, color: WsTokens.mutedLight),
          const SizedBox(height: 10),
          Text(text, style: const TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
          if (onGoProducts) ...[
            const SizedBox(height: 10),
            DesktopButton(
                label: '去商品管理',
                icon: SolarIconsOutline.tag,
                onPressed: () => widget.onNavigate('/products')),
          ],
        ],
      ),
    );
  }

  // ---------------- 库存流水 ----------------

  List<DesktopOption<String>> get _mvProductOptions => [
        const DesktopOption<String>('', '全部商品'),
        for (final p in _adjustableProducts())
          DesktopOption<String>('${wsI(p['id'])}', '${wsS(p['name'])}（${wsS(p['category'], fallback: '未分类')}）'),
      ];

  Future<void> _onMvSort(String key) async {
    setState(() {
      if (_mvSort == key) {
        _mvDirDesc = !_mvDirDesc;
      } else {
        _mvSort = key;
        _mvDirDesc = true;
      }
      _mvOffset = 0;
    });
    // 合并 / 关键字 / 排序都在后端做，点表头必须重新请求才能全局有序
    await _loadMovements();
  }

  Widget _buildMovements() {
    final List<Map<String, dynamic>> series = _asMapList(_mvChart['series']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopFilterBar(
          children: [
            DesktopLabeled(
              label: '商品',
              child: DesktopSearchField(
                title: '选择商品',
                width: 230,
                value: _mvProductId == null ? '' : '${_mvProductId!}',
                options: _mvProductOptions,
                hint: '全部商品',
                onChanged: (v) {
                  _mvProductId = int.tryParse(v ?? '');
                  _mvOffset = 0;
                  _loadMovements();
                },
              ),
            ),
            const Text('日期', style: TextStyle(fontSize: 12.5, color: WsTokens.textSecondaryLight)),
            DesktopDateField(
                value: _mvFrom,
                width: 132,
                onChanged: (v) => setState(() => _mvFrom = v)),
            const Text('-', style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
            DesktopDateField(
                value: _mvTo,
                width: 132,
                onChanged: (v) => setState(() => _mvTo = v)),
            DesktopLabeled(
              label: '关键字',
              child: DesktopTextField(
                controller: _mvKwCtl,
                width: 230,
                hintText: '品名 / 单号 / 操作员 / 备注',
                onChanged: (v) => setState(() => _mvKeyword = v),
                onSubmitted: (_) {
                  _mvOffset = 0;
                  _loadMovements();
                },
              ),
            ),
            _toggle(
              '合并出库',
              _mvMergeOut,
              (v) {
                _mvMergeOut = v;
                _mvOffset = 0;
                _loadMovements();
              },
              tip: '把同一商品、同一每单扣减量的出库行合并成一行（显示单数与合计出库量）',
            ),
            DesktopButton(
              label: '查询',
              icon: SolarIconsOutline.magnifier,
              kind: DesktopButtonKind.primary,
              onPressed: () {
                _mvKeyword = _mvKwCtl.text.trim();
                _mvOffset = 0;
                _loadMovements();
              },
            ),
            DesktopButton(
              label: '重置',
              onPressed: () {
                _mvKwCtl.clear();
                setState(() {
                  _mvKeyword = '';
                  _mvProductId = null;
                  _mvSort = 'date';
                  _mvDirDesc = true;
                  _mvOffset = 0;
                  _mvMergeOut = true;
                  _mvFrom = _dateStr(DateTime.now().subtract(const Duration(days: 29)));
                  _mvTo = wsToday();
                });
                _loadMovements();
              },
            ),
          ],
        ),
        Expanded(
          child: DesktopStateView(
            loading: _mvLoading && _mvRows.isEmpty,
            loadingText: '正在读取库存流水…',
            error: _mvError,
            onRetry: _loadMovements,
            child: DesktopScrollBody(
              children: [
                DesktopRise(index: 0, child: _movementsChartCard(series)),
                if (_mvTruncated)
                  const DesktopNotice(
                    '区间内流水过多，本次只处理了最新的一部分，请缩小时间范围',
                    kind: DesktopNoticeKind.warn,
                  ),
                DesktopRise(
                  index: 1,
                  child: WsCard(
                    padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        WsCardHead(
                          title: '流水明细',
                          icon: SolarIconsOutline.transferVertical,
                          trailing: Text(
                            '第 ${_mvTotal == 0 ? 0 : _mvOffset + 1}–${_mvOffset.clamp(0, _mvTotal) + _mvRows.length} 条，'
                            '共 $_mvTotal 条${_mvMergedFlag ? '（出库已合并）' : ''} · 点表头在服务端重排',
                            style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight),
                          ),
                        ),
                        DesktopGrid(
                          dense: true,
                          cols: const [
                            DesktopCol('日期', width: 168, sortKey: 'date'),
                            DesktopCol('单号', width: 150),
                            DesktopCol('商品', width: 190, sortKey: 'product_name'),
                            DesktopCol('类型', width: 108, sortKey: 'move_type', center: true),
                            DesktopCol('变动（真实单位）', width: 178, sortKey: 'quantity_base', right: true),
                            DesktopCol('单位', width: 70, center: true),
                            DesktopCol('单价', width: 108, right: true),
                            DesktopCol('金额', width: 122, sortKey: 'amount', right: true),
                            DesktopCol('操作员', width: 116, sortKey: 'operator'),
                            DesktopCol('备注', width: 260),
                          ],
                          rows: [for (final m in _mvRows) _movementRow(m)],
                          sortKey: _mvSort,
                          sortAsc: !_mvDirDesc,
                          onSort: _onMvSort,
                          emptyText: _mvKeyword.isEmpty ? '该条件暂无流水' : '没有匹配「$_mvKeyword」的流水',
                        ),
                        DesktopPager(
                          total: _mvTotal,
                          limit: _mvLimit,
                          offset: _mvOffset,
                          onChanged: (offset) {
                            _mvOffset = offset;
                            _loadMovements();
                          },
                          onLimitChanged: (size) {
                            _mvLimit = size;
                            _mvOffset = 0;
                            _loadMovements();
                          },
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  DesktopRow _movementRow(Map<String, dynamic> m) {
    final Map<String, dynamic>? merged =
        m['_merged'] is Map ? _asMap(m['_merged']) : null;
    final double display = m['quantity_display'] == null
        ? wsD(m['quantity_base'])
        : wsD(m['quantity_display']);
    final String unit = wsS(m['unit']);
    final String type = wsS(m['move_type']);
    final double amount = wsD(m['amount']);
    final String remark = wsS(m['remark']);

    Widget changeCell;
    if (merged != null) {
      final double per = wsD(merged['per']);
      changeCell = Tooltip(
        message: '合计 -${_num(wsD(merged['total']))} $unit（${wsI(merged['count'])} 单）',
        child: Text('-${_num(per.abs())} $unit/单 × ${wsI(merged['count'])} 单',
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12.5, color: WsTokens.red, fontWeight: FontWeight.w600)),
      );
    } else {
      changeCell = Text('${_signed(display)} $unit',
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: display >= 0 ? WsTokens.green : WsTokens.red));
    }

    final String codes = merged != null
        ? (merged['codes'] as List?)?.join('、') ?? ''
        : (_docCodeRe.firstMatch(remark)?.group(0) ?? '');

    final double qtyForPrice = merged != null ? wsD(merged['per']) : display;
    final String priceText =
        qtyForPrice.abs() < 1e-9 ? '—' : wsMoney(amount / qtyForPrice.abs());

    return DesktopRow(
      tag: wsI(m['id']),
      onTap: () => _showDetailFromMovement(m),
      highlight: merged != null,
      cells: [
        wsCell(wsS(m['date'], fallback: '—'), tip: wsS(m['date'])),
        wsCell(codes.isEmpty ? '—' : codes, tip: codes),
        wsCell(wsS(m['product_name']), bold: true, tip: wsS(m['product_name'])),
        DesktopTag(_moveTypeLabel(type),
            color: merged != null ? WsTokens.red : _moveTypeColor(type),
            tip: merged != null ? '出库 × ${wsI(merged['count'])} 单' : type),
        changeCell,
        wsCell(unit),
        wsCell(priceText),
        wsCell(wsMoney(amount)),
        wsCell(wsS(m['operator'], fallback: '—')),
        wsCell(
          merged != null
              ? '已合并 ${wsI(merged['count'])} 笔${wsI(merged['days']) > 1 ? '（跨 ${wsI(merged['days'])} 天）' : ''}'
              : (remark.isEmpty ? '—' : remark),
          tip: merged != null
              ? '${(merged['codes'] as List?)?.join('、') ?? ''}'
                  '${wsI(merged['more']) > 0 ? '（另有 ${wsI(merged['more'])} 个单号）' : ''}'
              : remark,
          color: merged != null ? WsTokens.mutedLight : null,
        ),
      ],
    );
  }

  void _showDetailFromMovement(Map<String, dynamic> m) {
    final int pid = wsI(m['product_id']);
    final Map<String, dynamic>? row =
        _ovRows.where((p) => wsI(p['id']) == pid).isEmpty ? null : _ovRows.firstWhere((p) => wsI(p['id']) == pid);
    if (row == null) {
      wsToast(context, '该商品不在库存总览里（人工 / 快递 / 已删除），无库存详情', error: true);
      return;
    }
    _showDetail(row);
  }

  Widget _toggle(String label, bool selected, ValueChanged<bool> onChanged, {String? tip}) {
    final Widget chip = ChoiceChip(
      label: Text(label, style: const TextStyle(fontSize: 12)),
      selected: selected,
      onSelected: onChanged,
      selectedColor: WsTokens.primaryLight,
      labelStyle: TextStyle(color: selected ? WsTokens.primary : WsTokens.mutedLight),
      visualDensity: VisualDensity.compact,
    );
    return tip == null ? chip : Tooltip(message: tip, child: chip);
  }

  /// 按日柱状图：每个展示单位一组、各自成图（单位不同不能相加）
  Widget _movementsChartCard(List<Map<String, dynamic>> series) {
    final String from = wsS(_mvChart['date_from'], fallback: _mvFrom);
    final String to = wsS(_mvChart['date_to'], fallback: _mvTo);
    return WsCard(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCardHead(
            title: '库存变动趋势',
            icon: SolarIconsOutline.chart,
            trailing: Text('$from ~ $to · 只统计真实库存进出',
                style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
          ),
          if (series.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 14),
              child: Text('该区间没有库存变动流水',
                  style: TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
            )
          else
            for (final Map<String, dynamic> s in series.take(2)) _chartSeries(s),
          if (series.length > 2)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                  '另有 ${series.length - 2} 个单位（${series.skip(2).map((s) => '${wsS(s['unit'])}：入 ${_num(wsD(s['total_in']))} / 出 ${_num(wsD(s['total_out']))}').join('、')}）'
                  '，量级小或只有零星几天有变动，未绘图，明细见下表',
                  style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5)),
            ),
          const SizedBox(height: 8),
          const DesktopNotice(
            '口径：绿柱=入库、红柱=出库，上下各按自己的峰值铺满（两向高度不能直接比）；'
            '不含人工/快递工作量、均价与成本单价流水，也不含单位为「单」的单数流水。',
          ),
        ],
      ),
    );
  }

  Widget _chartSeries(Map<String, dynamic> s) {
    final List<Map<String, dynamic>> days = _asMapList(s['days']);
    final List<String> labels = [
      for (final d in days) _monthOf(wsS(d['date']))
    ];
    final List<({String label, double value})> inItems = [
      for (final d in days) (label: wsS(d['date']), value: wsD(d['in']))
    ];
    final List<({String label, double value})> outItems = [
      for (final d in days) (label: wsS(d['date']), value: wsD(d['out']))
    ];
    final String unit = wsS(s['unit'], fallback: '未知单位');
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              DesktopTag('单位：$unit', color: WsTokens.primary),
              const SizedBox(width: 12),
              _legendBox('入库', WsTokens.green),
              const SizedBox(width: 10),
              _legendBox('出库', WsTokens.red),
              const Spacer(),
              Text(
                '区间合计：入 ${_num(wsD(s['total_in']))} $unit / 出 ${_num(wsD(s['total_out']))} $unit · '
                '金额 ${wsMoney(wsD(s['total_amount']))}',
                style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight),
              ),
            ],
          ),
          const SizedBox(height: 10),
          DesktopBars(items: inItems, height: 92, color: WsTokens.green),
          DesktopBarLabels(labels: labels),
          const SizedBox(height: 8),
          DesktopBars(items: outItems, height: 92, color: WsTokens.red),
          DesktopBarLabels(labels: labels),
        ],
      ),
    );
  }

  Widget _legendBox(String label, Color color) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.85),
                  borderRadius: BorderRadius.circular(2))),
          const SizedBox(width: 5),
          Text(label, style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
        ],
      );

  // ---------------- 盘点记录 ----------------

  List<Map<String, dynamic>> get _adjFiltered {
    final String kw = _adjKeyword.trim().toLowerCase();
    final List<Map<String, dynamic>> rows = _adjRows.where((r) {
      if (kw.isEmpty) return true;
      return [
        r['product_name'],
        r['remark'],
        r['operator'],
        r['date'],
        r['created_at'],
      ].join(' ').toLowerCase().contains(kw);
    }).toList();
    return _sortedBy(rows, (e) => _adjSortValue(e, _adjSortKey), _adjSortAsc);
  }

  dynamic _adjSortValue(Map<String, dynamic> r, String key) => switch (key) {
        'date' => wsS(r['date']),
        'product_name' => wsS(r['product_name']),
        'quantity' => wsD(r['quantity']),
        'avg_cost_delta' => wsD(r['avg_cost_delta']),
        'unit_cost_delta' => wsD(r['unit_cost_delta']),
        'operator' => wsS(r['operator']),
        _ => wsS(r['date']),
      };

  Widget _buildAdjustments() {
    final List<Map<String, dynamic>> rows = _adjFiltered;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopFilterBar(
          right: DesktopButton(
              label: '新增盘点', icon: SolarIconsOutline.plus, kind: DesktopButtonKind.success, onPressed: () => _openAdjust()),
          children: [
            DesktopLabeled(
              label: '关键字',
              child: DesktopTextField(
                controller: _adjKwCtl,
                width: 260,
                hintText: '商品名称 / 备注 / 操作员 / 日期',
                onChanged: (v) => setState(() => _adjKeyword = v),
              ),
            ),
            const Text('日期', style: TextStyle(fontSize: 12.5, color: WsTokens.textSecondaryLight)),
            DesktopDateField(value: _adjFrom, width: 132, onChanged: (v) => setState(() => _adjFrom = v)),
            const Text('-', style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
            DesktopDateField(value: _adjTo, width: 132, onChanged: (v) => setState(() => _adjTo = v)),
            DesktopButton(label: '查询', icon: SolarIconsOutline.magnifier, kind: DesktopButtonKind.primary, onPressed: _loadAdjustments),
            Text('共 ${rows.length} 组（一次盘点算一组，关键字在本页面过滤）',
                style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ],
        ),
        Expanded(
          child: DesktopStateView(
            loading: _adjLoading && _adjRows.isEmpty,
            loadingText: '正在读取盘点记录…',
            error: _adjError,
            onRetry: _loadAdjustments,
            child: DesktopScrollBody(
              children: [
                DesktopRise(
                  index: 0,
                  child: WsCard(
                    padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const WsCardHead(title: '盘点调整记录', icon: SolarIconsOutline.clipboardCheck),
                        const DesktopNotice(
                          '一次盘点可能同时写入 库存变动 + 均价重估 + 成本单价 三条流水，这里按分组号（gid）合并成一行；'
                          '「删除回退」会整组撤销，同时回退库存、平均成本与成本单价。',
                        ),
                        DesktopGrid(
                          cols: const [
                            DesktopCol('日期', width: 150, sortKey: 'date'),
                            DesktopCol('商品', width: 200, sortKey: 'product_name'),
                            DesktopCol('库存变动', width: 150, sortKey: 'quantity', right: true),
                            DesktopCol('均价调整', width: 140, sortKey: 'avg_cost_delta', right: true),
                            DesktopCol('成本单价', width: 140, sortKey: 'unit_cost_delta', right: true),
                            DesktopCol('操作员', width: 116, sortKey: 'operator'),
                            DesktopCol('备注', width: 300),
                            DesktopCol('操作', width: 150, center: true),
                          ],
                          rows: [
                            for (final g in rows)
                              DesktopRow(
                                tag: wsI(g['id']),
                                onTap: () => _showAdjustmentGroup(g),
                                cells: [
                                  wsCell(wsS(g['date']),
                                      tip: '${wsS(g['date'])}\n记账时间：${wsS(g['created_at'], fallback: '—')}'),
                                  wsCell(wsS(g['product_name']), bold: true, tip: wsS(g['product_name'])),
                                  wsCell(
                                    wsD(g['quantity']) == 0
                                        ? '—'
                                        : '${_signed(wsD(g['quantity']))} ${wsS(g['unit'])}',
                                    color: wsD(g['quantity']) > 0
                                        ? WsTokens.green
                                        : (wsD(g['quantity']) < 0 ? WsTokens.red : null),
                                  ),
                                  wsCell(wsD(g['avg_cost_delta']) == 0
                                      ? '—'
                                      : '${_signed(wsD(g['avg_cost_delta']))}元/${wsS(g['unit'])}',
                                  color: wsD(g['avg_cost_delta']) > 0
                                      ? WsTokens.green
                                      : (wsD(g['avg_cost_delta']) < 0 ? WsTokens.red : null)),
                                  wsCell(wsD(g['unit_cost_delta']) == 0
                                      ? '—'
                                      : '${_signed(wsD(g['unit_cost_delta']))}元/${wsS(g['unit'])}',
                                  color: wsD(g['unit_cost_delta']) > 0
                                      ? WsTokens.green
                                      : (wsD(g['unit_cost_delta']) < 0 ? WsTokens.red : null)),
                                  wsCell(wsS(g['operator'], fallback: '—')),
                                  wsCell(wsS(g['remark'], fallback: '—'), tip: wsS(g['remark'])),
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.end,
                                    children: [
                                      DesktopLink('明细', onPressed: () => _showAdjustmentGroup(g)),
                                      DesktopLink(
                                        '回退',
                                        color: WsTokens.red,
                                        onPressed: () => _revertAdjustment(g),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                          ],
                          sortKey: _adjSortKey,
                          sortAsc: _adjSortAsc,
                          onSort: (key) => setState(() {
                            if (_adjSortKey == key) {
                              _adjSortAsc = !_adjSortAsc;
                            } else {
                              _adjSortKey = key;
                              _adjSortAsc = false;
                            }
                          }),
                          emptyText: _adjRows.isEmpty
                              ? '暂无盘点调整记录'
                              : '没有符合筛选条件的盘点记录（清空关键词试试）',
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  void _showAdjustmentGroup(Map<String, dynamic> g) {
    final String unit = wsS(g['unit']);
    final List<List<String>> lines = [
      ['库存变动', wsD(g['quantity']) == 0 ? '—' : '${_signed(wsD(g['quantity']))} $unit', '盘点写入的 adjust 流水，按展示单位折算'],
      ['均价调整', wsD(g['avg_cost_delta']) == 0 ? '—' : '${_signed(wsD(g['avg_cost_delta']))} 元/$unit',
          '平均成本（库存均价）的相对增减，影响库存价值与后续出库成本结转'],
      ['成本单价', wsD(g['unit_cost_delta']) == 0 ? '—' : '${_signed(wsD(g['unit_cost_delta']))} 元/$unit',
          '手填参考成本的相对增减，只影响参考成本，不影响库存价值'],
    ];
    desktopDialog<void>(
      context,
      title: '盘点明细 · 第 ${wsI(g['id'])} 组',
      width: 640,
      builder: (_) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final List<String> l in lines)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                      width: 84,
                      child: Text(l[0],
                          style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight))),
                  SizedBox(
                      width: 150,
                      child: Text(l[1],
                          style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600))),
                  Expanded(
                      child: Text(l[2],
                          style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5))),
                ],
              ),
            ),
          const Divider(height: 22),
          _detailLine('商品', wsS(g['product_name'])),
          _detailLine('盘点日期', wsS(g['date'])),
          _detailLine('操作员', wsS(g['operator'], fallback: '—')),
          _detailLine('记账时间', wsS(g['created_at'], fallback: '—')),
          _detailLine('备注', wsS(g['remark'], fallback: '—')),
          const SizedBox(height: 12),
          Row(
            children: [
              DesktopLink('查看该商品流水', onPressed: () {
                Navigator.of(context).pop();
                _gotoMovements(wsI(g['product_id']));
              }),
              const Spacer(),
              DesktopButton(
                label: '删除整组并回退',
                kind: DesktopButtonKind.danger,
                small: true,
                onPressed: () {
                  Navigator.of(context).pop();
                  _revertAdjustment(g);
                },
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _detailLine(String label, String value) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(width: 84, child: Text(label, style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight))),
            Expanded(
                child: Text(value,
                    style: const TextStyle(fontSize: 13, height: 1.5),
                    overflow: TextOverflow.ellipsis,
                    maxLines: 3)),
          ],
        ),
      );

  // ---------------- 工作量统计 ----------------

  Widget _buildWorkload() {
    final List<Map<String, dynamic>> byProduct = _asMapList(_wl['by_product']);
    final List<Map<String, dynamic>> byDate = _asMapList(_wl['by_date']);
    final List<Map<String, dynamic>> products =
        _sortedBy(byProduct, (e) => switch (_wlSortKey) {
              'name' => wsS(e['name']),
              'workload' => wsD(e['workload']),
              'rate' => wsD(e['rate']),
              'cost' => wsD(e['cost']),
              _ => wsD(e['workload']),
            }, _wlSortAsc);
    final List<Map<String, dynamic>> recent =
        byDate.length <= 31 ? byDate : byDate.sublist(byDate.length - 31);
    final double maxWork = products.isEmpty
        ? 1
        : products.map((e) => wsD(e['workload'])).reduce((a, b) => a > b ? a : b);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopFilterBar(
          children: [
            const Text('日期', style: TextStyle(fontSize: 12.5, color: WsTokens.textSecondaryLight)),
            DesktopDateField(value: _wlFrom, width: 140, onChanged: (v) => setState(() => _wlFrom = v)),
            const Text('-', style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
            DesktopDateField(value: _wlTo, width: 140, onChanged: (v) => setState(() => _wlTo = v)),
            DesktopButton(
                label: '查询',
                icon: SolarIconsOutline.magnifier,
                kind: DesktopButtonKind.primary,
                onPressed: () {
                  setState(() => _wlLoaded = false);
                  _loadWorkload();
                }),
            DesktopLabeled(
              label: '快捷',
              child: Wrap(
                spacing: 6,
                children: [
                  _toggle('本月', _wlFrom == wsMonthStart() && _wlTo == wsToday(), (v) {
                    setState(() {
                      _wlFrom = wsMonthStart();
                      _wlTo = wsToday();
                    });
                    _loadWorkload();
                  }),
                  _toggle('近 7 天', false, (v) {
                    setState(() {
                      _wlFrom = _dateStr(DateTime.now().subtract(const Duration(days: 6)));
                      _wlTo = wsToday();
                    });
                    _loadWorkload();
                  }),
                  _toggle('全部', _wlFrom.isEmpty && _wlTo.isEmpty, (v) {
                    setState(() {
                      _wlFrom = '';
                      _wlTo = '';
                    });
                    _loadWorkload();
                  }),
                ],
              ),
            ),
          ],
        ),
        Expanded(
          child: DesktopStateView(
            loading: _wlLoading && !_wlLoaded,
            loadingText: '正在统计工作量…',
            error: _wlError,
            onRetry: _loadWorkload,
            child: DesktopScrollBody(
              children: [
                DesktopRise(
                  index: 0,
                  child: DesktopStatGrid(
                    children: [
                      DesktopStatCard(
                        label: '总工作量',
                        value: '${_num(wsD(_wl['total_workload']))} 单',
                        sub: '成本 ${wsMoney(wsD(_wl['total_cost']))} · ${products.length} 个打包工种',
                        color: WsTokens.primary,
                      ),
                      DesktopStatCard(
                          label: '总成本', value: wsMoney(wsD(_wl['total_cost'])), sub: '按各工种均价合计'),
                      DesktopStatCard(
                          label: '有工作量的天数', value: '${byDate.length} 天', sub: '区间内按日聚合'),
                      DesktopStatCard(
                          label: '日均工作量',
                          value: byDate.isEmpty
                              ? '0 单'
                              : '${_num(wsD(_wl['total_workload']) / byDate.length)} 单',
                          sub: '总工作量 / 有工作量天数'),
                    ],
                  ),
                ),
                const SizedBox(height: 18),
                DesktopRise(
                  index: 1,
                  child: WsCard(
                    padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        WsCardHead(
                          title: '按日工作量',
                          icon: SolarIconsOutline.chart,
                          trailing: Text('绿柱=当天完成的人工工作量（单位：单）${byDate.length > recent.length ? ' · 仅显示最近 ${recent.length} 天' : ''}',
                              style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                        ),
                        if (recent.isEmpty)
                          const Padding(
                            padding: EdgeInsets.symmetric(vertical: 12),
                            child: Text('该时间段暂无人工作量',
                                style: TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
                          )
                        else ...[
                          DesktopBars(
                            items: [
                              for (final d in recent)
                                (label: wsS(d['date']), value: wsD(d['workload']))
                            ],
                            height: 120,
                            color: WsTokens.green,
                          ),
                          DesktopBarLabels(labels: [for (final d in recent) _monthOf(wsS(d['date']))]),
                        ],
                      ],
                    ),
                  ),
                ),
                DesktopRise(
                  index: 2,
                  child: WsCard(
                    padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const WsCardHead(
                          title: '按工种汇总',
                          icon: SolarIconsOutline.usersGroupRounded,
                          trailing: Text('工作量条：绿=各工种相对量（以最大值为满格）',
                              style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                        ),
                                        if (products.isEmpty)
                                          _emptyHint('该时间段无人工工作量')
                                        else
                                          Column(
                                            crossAxisAlignment: CrossAxisAlignment.stretch,
                                            children: [
                                              DesktopGrid(
                                cols: const [
                                  DesktopCol('人工工种', width: 220, sortKey: 'name'),
                                  DesktopCol('工作量(单)', width: 150, sortKey: 'workload', right: true),
                                  DesktopCol('单位', width: 90, center: true),
                                  DesktopCol('相对量', width: 220),
                                  DesktopCol('单位单价', width: 150, sortKey: 'rate', right: true),
                                  DesktopCol('成本', width: 150, sortKey: 'cost', right: true),
                                ],
                                rows: [
                                  for (final e in products)
                                    DesktopRow(tag: wsI(e['id']), cells: [
                                      wsCell(wsS(e['name']), bold: true, tip: wsS(e['name'])),
                                      wsCell('${_num(wsD(e['workload']))} ${wsS(e['unit'])}'),
                                      wsCell(wsS(e['unit'], fallback: '单')),
                                      Padding(
                                        padding: const EdgeInsets.symmetric(vertical: 12),
                                        child: ClipRRect(
                                          borderRadius: BorderRadius.circular(5),
                                          child: LinearProgressIndicator(
                                            value: maxWork <= 0 ? 0 : wsD(e['workload']) / maxWork,
                                            minHeight: 8,
                                            backgroundColor: WsTokens.borderLighter,
                                            valueColor:
                                                const AlwaysStoppedAnimation<Color>(WsTokens.green),
                                          ),
                                        ),
                                      ),
                                      wsCell('${wsMoney(wsD(e['rate']))}/${wsS(e['unit'], fallback: '单')}'),
                                      wsCell(wsMoney(wsD(e['cost']))),
                                    ]),
                                ],
                                footer: [
                                  '合计',
                                  '${_num(wsD(_wl['total_workload']))} 单',
                                  '',
                                  '',
                                  '',
                                  wsMoney(wsD(_wl['total_cost'])),
                                ],
                                sortKey: _wlSortKey,
                                sortAsc: _wlSortAsc,
                                onSort: (key) => setState(() {
                                  if (_wlSortKey == key) {
                                    _wlSortAsc = !_wlSortAsc;
                                  } else {
                                    _wlSortKey = key;
                                    _wlSortAsc = false;
                                  }
                                }),
                              ),
                              const SizedBox(height: 16),
                              const Text('按日明细',
                                  style: TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w600,
                                      color: WsTokens.mutedLight)),
                              const SizedBox(height: 8),
                              DesktopGrid(
                                dense: true,
                                cols: const [
                                  DesktopCol('日期', width: 150),
                                  DesktopCol('工作量(单)', width: 150, right: true),
                                  DesktopCol('占区间比', width: 150, right: true),
                                ],
                                rows: [
                                  for (final d in byDate.reversed)
                                    DesktopRow(tag: wsS(d['date']), cells: [
                                      wsCell(wsS(d['date'])),
                                      wsCell(_num(wsD(d['workload']))),
                                      wsCell(wsD(_wl['total_workload']) <= 0
                                          ? '—'
                                          : wsPct(wsD(d['workload']) / wsD(_wl['total_workload']))),
                                    ]),
                                ],
                                emptyText: '该时间段无人工工作量',
                              ),
                            ],
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

// ============================================================ 商品库存详情

class _StockDetail extends StatefulWidget {
  const _StockDetail({required this.row, required this.onAdjust, required this.onMovements});

  final Map<String, dynamic> row;
  final VoidCallback onAdjust;
  final VoidCallback onMovements;

  @override
  State<_StockDetail> createState() => _StockDetailState();
}

class _StockDetailState extends State<_StockDetail> {
  static const int _recent = 15;
  List<Map<String, dynamic>> _moves = [];
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final data = await ApiService.movements(productId: wsI(widget.row['id']), limit: _recent);
      _moves = _asMapList(data['rows']);
      _error = null;
    } on ApiException catch (e) {
      _error = e.message;
      if (mounted) wsToast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic> p = widget.row;
    final String du = _unitOf(p);
    final double f = _factor(p, du);
    final Map<String, dynamic> conv = p['conversions'] is Map
        ? _asMap(p['conversions'])
        : <String, dynamic>{};

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const WsCardHead(title: '基本信息', icon: SolarIconsOutline.infoCircle),
        Wrap(
          spacing: 26,
          runSpacing: 8,
          children: [
            _kv('商品', wsS(p['name'])),
            _kv('分类', wsS(p['category'], fallback: '未分类')),
            _kv('规格', wsS(p['spec'], fallback: '—')),
            _kv('默认单位', du.isEmpty ? '—' : du),
            _kv('当前库存', '${_num(wsD(p['stock']) / f)} $du'),
            _kv('平均成本', '${wsMoney(wsD(p['avg_cost']) * f)}/$du'),
            _kv('参考成本', wsD(p['unit_cost']) > 0 ? '${wsMoney(wsD(p['unit_cost']) * f)}/$du' : '未设置'),
            _kv('库存值', wsMoney(wsD(p['stock_value']))),
            _kv('最近入库', _lastInOf(p)),
            _kv('状态', p['is_active'] == false ? '停用' : '在售'),
          ],
        ),
        const SizedBox(height: 16),
        const WsCardHead(
            title: '换算关系',
            icon: SolarIconsOutline.transferHorizontal,
            trailing: Text('1 个大单位 = 系数 × 基础单位',
                style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight))),
        if (conv.isEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text('该商品没有配置单位换算，库存直接按默认单位「${du.isEmpty ? '—' : du}」记录',
                style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
          )
        else
          DesktopGrid(
            dense: true,
            cols: const [
              DesktopCol('单位', width: 130),
              DesktopCol('换算系数', width: 130, right: true),
              DesktopCol('折合', width: 260),
              DesktopCol('该单位下的库存', width: 170, right: true),
            ],
            rows: [
              for (final String k in conv.keys)
                DesktopRow(
                  tag: k,
                  highlight: k == du,
                  cells: [
                    wsCell(k, bold: k == du),
                    wsCell('× ${_num(wsD(conv[k], fallback: 1))}'),
                    wsCell('1 $k = ${_num(wsD(conv[k], fallback: 1))} ${wsS(p['base_unit'])}'),
                    wsCell('${_num(wsD(p['stock']) / (wsD(conv[k], fallback: 1) == 0 ? 1 : wsD(conv[k])))} $k'),
                  ],
                ),
            ],
            emptyText: '无换算关系',
          ),
        const SizedBox(height: 16),
        const WsCardHead(
          title: '最近 $_recent 条库存流水',
          icon: SolarIconsOutline.history,
          trailing: Text('流水金额按真实进出记账，均价/成本调整金额为增量',
              style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
        ),
        DesktopStateView(
          loading: _loading,
          error: _error,
          onRetry: _load,
          child: DesktopGrid(
            dense: true,
            cols: const [
              DesktopCol('日期', width: 130),
              DesktopCol('类型', width: 100, center: true),
              DesktopCol('变动', width: 150, right: true),
              DesktopCol('金额', width: 120, right: true),
              DesktopCol('操作员', width: 110),
              DesktopCol('备注', width: 220),
            ],
            rows: [
              for (final m in _moves)
                DesktopRow(tag: wsI(m['id']), cells: [
                  wsCell(wsS(m['date'])),
                  DesktopTag(_moveTypeLabel(wsS(m['move_type'])), color: _moveTypeColor(wsS(m['move_type']))),
                  wsCell('${_signed(m['quantity_display'] ?? m['quantity_base'])} ${wsS(m['unit'])}',
                      color: wsD(m['quantity_base']) >= 0 ? WsTokens.green : WsTokens.red),
                  wsCell(wsMoney(wsD(m['amount']))),
                  wsCell(wsS(m['operator'], fallback: '—')),
                  wsCell(wsS(m['remark'], fallback: '—'), tip: wsS(m['remark'])),
                ]),
            ],
            emptyText: '该商品暂无库存流水',
          ),
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            DesktopLink('查看全部流水', onPressed: widget.onMovements),
            const Spacer(),
            DesktopButton(label: '盘点调整', icon: SolarIconsOutline.pen, small: true, onPressed: widget.onAdjust),
          ],
        ),
      ],
    );
  }

  String _lastInOf(Map<String, dynamic> p) {
    final String d = wsS(p['last_in_date']);
    if (d.isEmpty) return '—';
    final double price = wsD(p['last_in_unit_price']);
    final String unit = wsS(p['last_in_unit']);
    return price > 0 ? '$d · ¥${price.toStringAsFixed(2)}${unit.isEmpty ? '' : '/$unit'}' : d;
  }

  Widget _kv(String label, String value) => SizedBox(
        width: 250,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
                width: 86,
                child: Text(label,
                    style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight))),
            Expanded(
                child: Text(value,
                    style: const TextStyle(fontSize: 13, height: 1.4),
                    overflow: TextOverflow.ellipsis,
                    maxLines: 2)),
          ],
        ),
      );
}

// ==================================================================== 盘点表单

class _AdjustForm extends StatefulWidget {
  const _AdjustForm({
    required this.stock,
    required this.operator,
    required this.onDone,
    this.preset,
  });

  final List<Map<String, dynamic>> stock;
  final Map<String, dynamic>? preset;
  final String operator;
  final void Function(String message) onDone;

  @override
  State<_AdjustForm> createState() => _AdjustFormState();
}

class _AdjustFormState extends State<_AdjustForm> {
  final TextEditingController _qtyCtl = TextEditingController();
  final TextEditingController _avgCtl = TextEditingController();
  final TextEditingController _ucostCtl = TextEditingController();
  final TextEditingController _remarkCtl = TextEditingController();
  late final TextEditingController _operatorCtl;
  int? _productId;
  String _unit = '';
  String _date = wsToday();
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _operatorCtl = TextEditingController(text: widget.operator.isEmpty ? '当前登录账号' : widget.operator);
    final Map<String, dynamic>? preset = widget.preset;
    if (preset != null) {
      _productId = wsI(preset['id']);
      _unit = _unitOf(preset);
    }
  }

  @override
  void dispose() {
    _qtyCtl.dispose();
    _avgCtl.dispose();
    _ucostCtl.dispose();
    _remarkCtl.dispose();
    _operatorCtl.dispose();
    super.dispose();
  }

  Map<String, dynamic>? get _product {
    final int? id = _productId;
    if (id == null) return null;
    for (final p in widget.stock) {
      if (wsI(p['id']) == id) return p;
    }
    return null;
  }

  List<String> get _units {
    final Map<String, dynamic>? p = _product;
    if (p == null) return _unit.isEmpty ? const [] : [_unit];
    final Set<String> set = {wsS(p['base_unit']), _unitOf(p)};
    final conv = p['conversions'];
    if (conv is Map) {
      for (final k in conv.keys) {
        set.add(k.toString());
      }
    }
    set.remove('');
    final List<String> out = set.toList()..sort();
    if (_unit.isNotEmpty && !out.contains(_unit)) out.insert(0, _unit);
    return out;
  }

  Future<void> _submit() async {
    final Map<String, dynamic>? p = _product;
    if (p == null) {
      wsToast(context, '请先选择商品', error: true);
      return;
    }
    final String qty = _normalizeSigned(_qtyCtl.text);
    final String avg = _normalizeSigned(_avgCtl.text);
    final String uc = _normalizeSigned(_ucostCtl.text);
    if (qty.isNotEmpty && !_signedRe.hasMatch(qty)) {
      wsToast(context, '调整数量必须以 + 或 - 开头（如 +100 增加 / -100 减少），留空则不调整', error: true);
      return;
    }
    if (avg.isNotEmpty && !_signedRe.hasMatch(avg)) {
      wsToast(context, '平均成本必须以 + 或 - 开头（如 +2 调高 / -1 调低），留空则不调整', error: true);
      return;
    }
    if (uc.isNotEmpty && !_signedRe.hasMatch(uc)) {
      wsToast(context, '成本单价必须以 + 或 - 开头（如 +2 调高 / -1 调低），留空则不调整', error: true);
      return;
    }
    if (qty.isNotEmpty && double.parse(qty) == 0) {
      wsToast(context, '调整数量不能为 0（需要不调整请留空）', error: true);
      return;
    }
    if (avg.isNotEmpty && double.parse(avg) == 0) {
      wsToast(context, '平均成本不能为 0（需要不调整请留空）', error: true);
      return;
    }
    if (uc.isNotEmpty && double.parse(uc) == 0) {
      wsToast(context, '成本单价不能为 0（需要不调整请留空）', error: true);
      return;
    }
    setState(() => _busy = true);
    try {
      final Map<String, dynamic> data = await ApiService.adjust(
        productId: wsI(p['id']),
        date: _date,
        quantity: qty,
        unit: _unit,
        avgCostAdj: avg,
        unitCostAdj: uc,
        remark: _remarkCtl.text.trim(),
      );
      if (!mounted) return;
      Navigator.of(context).pop();
      widget.onDone(wsS(data['message'], fallback: qty.isEmpty && avg.isEmpty && uc.isEmpty ? '无调整' : '盘点调整成功'));
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '操作失败：${e.message}', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final Map<String, dynamic>? p = _product;
    final List<String> units = _units;
    if (_unit.isNotEmpty && !units.contains(_unit)) units.insert(0, _unit);
    final String dispUnit = p == null ? _unit : (_unit.isEmpty ? _unitOf(p) : _unit);
    final double now = p == null ? 0 : wsD(p['stock']) / _factor(p, _unitOf(p));
    final double nowAvg = p == null ? 0 : wsD(p['avg_cost']) * _factor(p, _unitOf(p));
    final double nowUc = p == null ? 0 : wsD(p['unit_cost']) * _factor(p, _unitOf(p));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const DesktopNotice(
          '数量、均价、成本单价都填增减值（如 +2.5 / -1；正数会自动补 +），全部留空则不做调整。'
          '数量按所选单位计，均价与成本单价按商品默认单位（元/默认单位）计。',
        ),
        DesktopFormRow(
          label: '商品',
          required: true,
          width: 300,
          child: DesktopSearchField(
            title: '选择商品',
            width: 300,
            hint: '点击选择商品',
            value: _productId == null ? null : '${_productId!}',
            options: [
              for (final e in widget.stock)
                DesktopOption<String>('${wsI(e['id'])}',
                    '${wsS(e['name'])}（现库存 ${e['stock_display'] ?? '${_num(wsD(e['stock']))} ${_unitOf(e)}'}）')
            ],
            onChanged: (v) => setState(() {
              _productId = int.tryParse(v ?? '');
              final Map<String, dynamic>? np = _product;
              _unit = np == null ? '' : _unitOf(np);
            }),
          ),
        ),
        DesktopFormRow(
          label: '当前库存',
          width: 320,
          child: Text(
            p == null ? '—（请先选择商品）' : '${_num(now)} ${_unitOf(p)}',
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
          ),
        ),
        DesktopFormRow(
          label: '调整数量',
          width: 300,
          tip: '必带 +/-，按所选单位；留空不调整',
          child: DesktopTextField(
            controller: _qtyCtl,
            width: 300,
            hintText: '如 +100 增加 / -100 减少',
            onChanged: (_) => setState(() {}),
          ),
        ),
        DesktopFormRow(
          label: '调整后',
          width: 320,
          child: Text(_previewStock(now, dispUnit),
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: WsTokens.primary)),
        ),
        DesktopFormRow(
          label: '单位',
          width: 200,
          child: DesktopSelect<String>(
            width: 200,
            value: _unit,
            hint: '默认单位',
            options: [for (final u in units) DesktopOption<String>(u, u)],
            onChanged: (v) => setState(() => _unit = v ?? ''),
          ),
        ),
        DesktopFormRow(
          label: '平均成本',
          width: 300,
          tip: '元/${p == null ? '默认单位' : _unitOf(p)}，必带 +/-；留空不调整',
          child: DesktopTextField(
            controller: _avgCtl,
            width: 300,
            hintText: '如 +2 调高 / -1 调低',
            onChanged: (_) => setState(() {}),
          ),
        ),
        DesktopFormRow(
          label: '当前均价',
          width: 320,
          child: Text(
            p == null
                ? '—'
                : '${nowAvg > 0 ? '${wsMoney(nowAvg)}/${_unitOf(p)}' : '—（无均价）'}　→　${_previewAvg(nowAvg, _unitOf(p))}',
            style: const TextStyle(fontSize: 12.5),
          ),
        ),
        DesktopFormRow(
          label: '成本单价',
          width: 300,
          tip: '参考成本，元/${p == null ? '默认单位' : _unitOf(p)}；只影响参考成本不计入库存价值',
          child: DesktopTextField(
            controller: _ucostCtl,
            width: 300,
            hintText: '如 +2 调高 / -1 调低',
            onChanged: (_) => setState(() {}),
          ),
        ),
        DesktopFormRow(
          label: '当前成本单价',
          width: 320,
          child: Text(
            p == null
                ? '—'
                : '${nowUc > 0 ? '${wsMoney(nowUc)}/${_unitOf(p)}' : '—（无成本单价）'}　→　${_previewUc(nowUc, _unitOf(p))}',
            style: const TextStyle(fontSize: 12.5),
          ),
        ),
        DesktopFormRow(
          label: '日期',
          width: 160,
          child: DesktopDateField(
            value: _date,
            width: 160,
            allowClear: false,
            lastDate: DateTime.now().add(const Duration(days: 1)),
            onChanged: (v) => setState(() => _date = v.isEmpty ? wsToday() : v),
          ),
        ),
        DesktopFormRow(
          label: '操作员',
          width: 200,
          tip: '默认当前登录账号，后端不接收前端指定',
          child: DesktopTextField(controller: _operatorCtl, readonly: true, width: 200),
        ),
        DesktopFormRow(
          label: '原因/备注',
          width: 360,
          child: DesktopTextField(
            controller: _remarkCtl,
            width: 360,
            maxLines: 3,
            hintText: '如：盘点差异 / 损耗',
          ),
        ),
        const SizedBox(height: 4),
        Row(
          children: [
            TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('取消')),
            const Spacer(),
            DesktopButton(
              label: _busy ? '提交中…' : '确认调整',
              kind: DesktopButtonKind.primary,
              icon: SolarIconsOutline.checkCircle,
              onPressed: _busy ? null : _submit,
            ),
          ],
        ),
      ],
    );
  }

  String _previewStock(double now, String unit) {
    if (_product == null) return '—';
    final String raw = _normalizeSigned(_qtyCtl.text);
    if (raw.isEmpty) return '${_num(now)} $unit（不调整）';
    if (!_signedRe.hasMatch(raw)) return '⚠ 需以 + 或 - 开头，如 +100 / -100';
    return '${_num(now + (double.tryParse(raw) ?? 0))} $unit';
  }

  String _previewAvg(double nowAvg, String unit) {
    final String raw = _normalizeSigned(_avgCtl.text);
    if (raw.isEmpty) return '不调整';
    if (!_signedRe.hasMatch(raw)) return '⚠ 需以 + 或 - 开头，如 +2 / -1';
    return '${wsMoney((nowAvg + (double.tryParse(raw) ?? 0)).clamp(0, double.maxFinite))}/$unit';
  }

  String _previewUc(double nowUc, String unit) {
    final String raw = _normalizeSigned(_ucostCtl.text);
    if (raw.isEmpty) return '不调整';
    if (!_signedRe.hasMatch(raw)) return '⚠ 需以 + 或 - 开头，如 +2 / -1';
    return '${wsMoney((nowUc + (double.tryParse(raw) ?? 0)).clamp(0, double.maxFinite))}/$unit';
  }
}
