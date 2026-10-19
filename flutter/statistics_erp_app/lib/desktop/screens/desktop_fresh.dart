import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';
import 'package:solar_icons/solar_icons.dart';

/// 桌面端「数据工具 · 鲜货」页，复刻 web `#page-fresh`（鲜货现采）+ `#page-fresh-in`（鲜货入库二级页）。
///
/// 真源：web/static/app.js 的 loadFresh / freshPlan / openFreshConfig / fcToggle·fcMove·fcDel /
/// saveFreshConfig / loadFreshInbound / renderFreshInbound / finRowCalc / fillInboundRowPrice /
/// submitFreshInbound；后端 backend/app/routers/fresh.py + inbound.py。
///
/// 两个子页共用一份「展示清单」（backend/json/fresh_config_{分仓key}.json）：
///  - 鲜货现采：看全量鲜货库存 + 导入今日订单预演算需求（**不扣库存，只出建议**）；
///  - 鲜货入库：只有清单里挑过的商品才会出现在表格里，填数量即逐行生成入库单。
class DesktopFreshScreen extends StatefulWidget {
  const DesktopFreshScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopFreshScreen> createState() => _DesktopFreshScreenState();
}

const TextInputType _kNum = TextInputType.numberWithOptions(decimal: true);

/// 「今日已入库」在本机的存储 key 前缀（与网页端 localStorage 同名，按分仓隔离）
const String _kDoneKeyPrefix = 'wsfc_fin_done';

List<Map<String, dynamic>> _mapList(dynamic v) {
  if (v is! List) return <Map<String, dynamic>>[];
  return <Map<String, dynamic>>[
    for (final Object? e in v)
      if (e is Map) Map<String, dynamic>.from(e),
  ];
}

/// 库存/数量展示：整数不带小数，其余按原样（最多 4 位）——同网页端 fmtNum
String _num(dynamic v) {
  final double n = wsD(v);
  if (n == 0) return '0';
  if ((n - n.roundToDouble()).abs() < 1e-6) return n.round().toString();
  return wsTrim(n, digits: 4);
}

double _textNum(TextEditingController c) => double.tryParse(c.text.trim()) ?? 0;

// ---------------------------------------------------------------- 鲜货入库行

/// 鲜货入库表格的一行（= 一张待提交的入库单）。
/// controller 常驻在 State 里，刷新/筛选/切子页都不丢已填内容（对应网页端 FIN_VALS）。
class _FinRow {
  _FinRow({required this.id, required this.name, required this.unit});

  final int id;
  String name;
  String unit;
  bool pick = false;

  final TextEditingController qty = TextEditingController();
  final TextEditingController price = TextEditingController();
  final TextEditingController freight = TextEditingController();
  final TextEditingController handling = TextEditingController();
  final TextEditingController remark = TextEditingController();

  /// 单价自动带出的口径说明（最近入库价 / 参考成本 / 扣点折算）
  String priceHint = '';

  double get qtyV => _textNum(qty);
  double get priceV => _textNum(price);
  double get freightV => _textNum(freight);
  double get handlingV => _textNum(handling);
  double get amount => qtyV * priceV;
  double get fee => freightV + handlingV;

  void clearInput() {
    qty.clear();
    price.clear();
    freight.clear();
    handling.clear();
    remark.clear();
    pick = false;
  }

  void dispose() {
    qty.dispose();
    price.dispose();
    freight.dispose();
    handling.dispose();
    remark.dispose();
  }
}

// ---------------------------------------------------------------- 展示清单草稿

class _FcDraft {
  _FcDraft({
    required this.all,
    required List<int> ids,
    required this.freshCats,
  })  : selected = <int>[...ids],
        byId = <int, Map<String, dynamic>>{
          for (final p in all) wsI(p['id']): p,
        };

  /// 候选池（scope=all：全部在用库存商品，后端已排除 包材/人工/快递）
  final List<Map<String, dynamic>> all;
  final Map<int, Map<String, dynamic>> byId;

  /// 鲜货分类（蔬菜 / 干货），供「只看鲜货分类」筛选
  final List<String> freshCats;

  /// 当前展示清单（有序商品 id）
  final List<int> selected;

  final TextEditingController search = TextEditingController();
  bool freshOnly = false;

  List<Map<String, dynamic>> matched() {
    final String kw = search.text.trim().toLowerCase();
    return <Map<String, dynamic>>[
      for (final p in all)
        if ((!freshOnly || freshCats.contains(wsS(p['category']))) &&
            (kw.isEmpty ||
                wsS(p['name']).toLowerCase().contains(kw) ||
                wsS(p['category']).toLowerCase().contains(kw)))
          p,
    ];
  }

  void toggle(int id) {
    if (selected.contains(id)) {
      selected.remove(id);
    } else {
      selected.add(id);
    }
  }

  void move(int i, int d) {
    final int j = i + d;
    if (j < 0 || j >= selected.length) return;
    final int t = selected[i];
    selected[i] = selected[j];
    selected[j] = t;
  }

  void dispose() => search.dispose();
}

// ---------------------------------------------------------------- State

class _DesktopFreshScreenState extends State<DesktopFreshScreen> {
  static const List<String> _tabItems = ['鲜货现采', '鲜货入库'];
  int _tab = 0;

  // 公共元数据
  final Map<int, Map<String, dynamic>> _productById = <int, Map<String, dynamic>>{};
  Map<String, double> _deductMap = <String, double>{};

  // 子页 1：鲜货现采
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _items = <Map<String, dynamic>>[];
  List<int> _listIds = <int>[];
  Map<int, Map<String, dynamic>> _plan = <int, Map<String, dynamic>>{};
  Map<String, dynamic>? _planMeta;
  bool _planning = false;

  // 子页 2：鲜货入库
  final List<_FinRow> _rows = <_FinRow>[];
  String _finDate = wsToday();
  String _pay = 'paid';
  final TextEditingController _supplierCtrl = TextEditingController();
  final TextEditingController _remarkCtrl = TextEditingController();
  final TextEditingController _keywordCtrl = TextEditingController();
  bool _showDone = false;
  Set<int> _doneIds = <int>{};
  bool _submitting = false;
  String? _finError;
  String _finResult = '';

  String get _operator => widget.auth.displayName;

  static const List<DesktopCol> _freshCols = [
    DesktopCol('蔬菜', width: 180),
    DesktopCol('当前库存', width: 130, right: true),
    DesktopCol('今日订单需求', width: 130, right: true),
    DesktopCol('预计剩余', width: 120, right: true),
    DesktopCol('建议采购', width: 110, right: true),
    DesktopCol('参考成本', width: 130, right: true),
    DesktopCol('库存值', width: 130, right: true),
  ];

  static const List<DesktopCol> _finCols = [
    DesktopCol('', width: 44, center: true, tip: '全选 / 全不选（勾选后只入库勾中的那些）'),
    DesktopCol('商品', width: 230),
    DesktopCol('进货单位', width: 108),
    DesktopCol('数量', width: 90, right: true),
    DesktopCol('单价', width: 120, right: true, tip: '自动带出：最近入库价 → 参考成本；类别配了扣点时按 原价 × (1 − 扣点%) 折算，可改'),
    DesktopCol('金额', width: 130, right: true, tip: '金额 = 数量 × 单价；有小字时是含运费/装卸的批次成本'),
    DesktopCol('运费', width: 90, right: true, tip: '默认留空：填了计入该行批次成本，并同步「其他开支」备查'),
    DesktopCol('装卸费', width: 90, right: true, tip: '同运费'),
    DesktopCol('行备注', width: 180),
    DesktopCol('操作', width: 110),
  ];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final _FinRow r in _rows) {
      r.dispose();
    }
    _supplierCtrl.dispose();
    _remarkCtrl.dispose();
    _keywordCtrl.dispose();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (silent) {
      _error = null;
    } else {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final Map<String, dynamic> fresh = await ApiService.fresh();
      final List<dynamic> products = await ApiService.products();
      final List<dynamic> deducs = await ApiService.deductions();
      if (!mounted) return;
      final byId = <int, Map<String, dynamic>>{};
      for (final Map<String, dynamic> p in _mapList(products)) {
        byId[wsI(p['id'])] = p;
      }
      final deductMap = <String, double>{};
      for (final Map<String, dynamic> d in _mapList(deducs)) {
        final String cat = wsS(d['category']);
        if (cat.isEmpty) continue;
        deductMap[cat] = wsD(d['percent']);
      }
      setState(() {
        _productById
          ..clear()
          ..addAll(byId);
        _deductMap = deductMap;
        _items = _mapList(fresh['items']);
        _listIds = <int>[for (final Object? x in (fresh['ids'] as List?) ?? const <Object?>[]) wsI(x)];
        _loading = false;
      });
      await _loadFinList();
      await _loadDone();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
      wsToast(context, e.message, error: true);
    }
  }

  // ------------------------------------------------ 商品换算 / 单价带出

  String _defaultUnitOf(Map<String, dynamic> p) {
    final String du = wsS(p['default_unit']);
    return du.isNotEmpty ? du : wsS(p['base_unit']);
  }

  double _factorOf(Map<String, dynamic> p, String unit) {
    final Object? conv = p['conversions'];
    if (conv is Map) {
      final Object? v = conv[unit];
      if (v is num) return v.toDouble();
      if (v != null) return double.tryParse(v.toString()) ?? 1;
    }
    return 1;
  }

  /// 可选进货单位（网页端 unitOptions 取 conversions 的 key，默认单位一定给上）
  List<String> _unitsOf(Map<String, dynamic> p) {
    final Object? conv = p['conversions'];
    final units = <String>[
      if (conv is Map) for (final Object? k in conv.keys) wsS(k),
    ];
    final String du = _defaultUnitOf(p);
    if (du.isNotEmpty && !units.contains(du)) units.insert(0, du);
    return units.isEmpty ? <String>[du] : units;
  }

  /// 单价自动带出：最近入库价 → 参考成本；类别命中扣点时按 原价 × (1 − 扣点%) 折算
  void _fillRowPrice(_FinRow r, {bool overwrite = false}) {
    final Map<String, dynamic>? p = _productById[r.id];
    if (p == null) return;
    final double f = _factorOf(p, r.unit);
    final double lastBase = wsD(p['last_in_price']);
    final double refBase = wsD(p['unit_cost']);
    final double base = lastBase > 0 ? lastBase : refBase;
    if (base <= 0) {
      if (overwrite) r.price.clear();
      r.priceHint = '该商品还没入库过、也没设参考成本，请手动填单价';
      return;
    }
    final double raw = double.parse((base * f).toStringAsFixed(6));
    final String cat = wsS(p['category']);
    final double percent = _deductMap[cat] ?? 0;
    final double price =
        percent > 0 ? double.parse((raw * (1 - percent / 100)).toStringAsFixed(4)) : raw;
    if (overwrite || r.price.text.trim().isEmpty) {
      r.price.text = wsTrim(price, digits: 6);
    }
    if (percent > 0) {
      r.priceHint = '类别「$cat」扣点 ${_pctText(percent)}：入库单价 = 原价 ${wsMoney(raw)} × (1 − ${_pctText(percent)}) = ${wsMoney(price)}/${r.unit}';
    } else if (lastBase > 0) {
      r.priceHint = '最近入库价 ${wsMoney(raw)}/${r.unit}（${wsS(p['last_in_date'], fallback: '—')}）'
          '${refBase > 0 ? '；参考成本 ${wsMoney(base * f)}/${r.unit}' : ''}';
    } else {
      r.priceHint = '按参考成本填 ${wsMoney(raw)}/${r.unit}（该商品还没入库过）';
    }
  }

  static String _pctText(num v) => '${v.toStringAsFixed(2)}%';

  /// 商品列小字：分类 +（换了单位时）换算系数
  String _unitHintText(_FinRow r, Map<String, dynamic> p) {
    final double f = _factorOf(p, r.unit);
    final String base = wsS(p['base_unit']);
    final String cat = wsS(p['category'], fallback: '—');
    if (r.unit.isNotEmpty && r.unit != base && f != 1) {
      return '$cat · 1${r.unit} = ${wsTrim(f, digits: 4)}$base';
    }
    return cat;
  }

  // ------------------------------------------------ 子页 1：今日订单演算

  Future<void> _importPlan() async {
    FilePickerResult? picked;
    try {
      picked = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: const ['xlsx'],
        dialogTitle: '选择今日聚水潭订单 Excel',
      );
    } catch (e) {
      if (!mounted) return;
      wsToast(context, '选择文件失败：$e', error: true);
      return;
    }
    final String? path = picked == null || picked.files.isEmpty ? null : picked.files.first.path;
    if (path == null || path.isEmpty) return;
    if (!mounted) return;
    setState(() => _planning = true);
    wsToast(context, '正在演算今日订单需求…');
    try {
      final Map<String, dynamic> d = await ApiService.freshPlan(path);
      if (!mounted) return;
      setState(() {
        _plan = <int, Map<String, dynamic>>{
          for (final Map<String, dynamic> i in _mapList(d['items'])) wsI(i['id']): i,
        };
        _planMeta = d;
        _planning = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _planning = false);
      wsToast(context, '演算失败：${e.message}', error: true);
    }
  }

  void _clearPlan() {
    setState(() {
      _plan = <int, Map<String, dynamic>>{};
      _planMeta = null;
    });
  }

  // ------------------------------------------------ 子页 1：管理展示商品

  Future<void> _openFreshConfig() async {
    List<Map<String, dynamic>> opts;
    List<int> ids;
    List<String> freshCats;
    try {
      // 与网页端 Promise.all 一致：候选池 + 当前清单并行取
      final List<Map<String, dynamic>> both = await Future.wait(<Future<Map<String, dynamic>>>[
        ApiService.freshOptions(scope: 'all'),
        ApiService.fresh(),
      ]);
      final Map<String, dynamic> options = both[0];
      final Map<String, dynamic> cur = both[1];
      opts = _mapList(options['items']);
      freshCats = <String>[for (final Object? c in (options['fresh_cats'] as List?) ?? const <Object?>[]) wsS(c)];
      ids = <int>[for (final Object? x in (cur['ids'] as List?) ?? const <Object?>[]) wsI(x)];
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, e.message, error: true);
      return;
    }
    if (!mounted) return;
    final _FcDraft draft = _FcDraft(all: opts, ids: ids, freshCats: freshCats);
    final bool? saved = await desktopDialog<bool>(
      context,
      title: '管理展示商品',
      width: 1000,
      maxHeight: 760,
      builder: (BuildContext dialogContext) => StatefulBuilder(
        builder: (BuildContext context, StateSetter setDialogState) => _configBody(dialogContext, draft, setDialogState),
      ),
    );
    draft.dispose();
    if (saved != true) return;
    if (!mounted) return;
    wsToast(context, '已保存 ${draft.selected.length} 个展示商品');
    await _load();
  }

  Widget _configBody(BuildContext dialogContext, _FcDraft draft, StateSetter setDialogState) {
    final List<Map<String, dynamic>> pool = draft.matched();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const DesktopNotice(
          '左边是全部在用商品（与「商品」页口径一致，不含 包材/人工/快递，可搜索）：点一下即加入展示清单，'
          '点第二次取消；右边的顺序就是「鲜货现采」和「鲜货入库」的展示顺序。'
          '清单里的商品才会出现在「鲜货入库」的表格里。',
        ),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Text('候选商品（${pool.length} 个）',
                          style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
                      const Spacer(),
                      Checkbox(
                        value: draft.freshOnly,
                        visualDensity: VisualDensity.compact,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        onChanged: (bool? v) => setDialogState(() => draft.freshOnly = v ?? false),
                      ),
                      const Text('只看鲜货分类（蔬菜/干货）', style: TextStyle(fontSize: 12)),
                    ],
                  ),
                  const SizedBox(height: 8),
                  DesktopTextField(
                    controller: draft.search,
                    width: double.infinity,
                    hintText: '🔍 搜索名称 / 分类…',
                    onChanged: (_) => setDialogState(() {}),
                  ),
                  const SizedBox(height: 8),
                  SizedBox(
                    height: 340,
                    child: Container(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(WsTokens.radiusSm),
                        border: Border.all(color: WsTokens.borderLight),
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: pool.isEmpty
                          ? const Center(
                              child: Text('无匹配商品',
                                  style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                            )
                          : ListView(
                              children: [
                                for (final Map<String, dynamic> p in pool)
                                  _fcOption(
                                    label: wsS(p['name']),
                                    sub: wsS(p['category'], fallback: '—'),
                                    on: draft.selected.contains(wsI(p['id'])),
                                    onTap: () => setDialogState(() => draft.toggle(wsI(p['id']))),
                                  ),
                              ],
                            ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('当前展示顺序（${draft.selected.length} 个）',
                      style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 8),
                  SizedBox(
                    height: 378,
                    child: Container(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(WsTokens.radiusSm),
                        border: Border.all(color: WsTokens.borderLight),
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: draft.selected.isEmpty
                          ? const Center(
                              child: Text('未选择（将展示全部鲜货）',
                                  style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                            )
                          : ListView(
                              children: [
                                for (var i = 0; i < draft.selected.length; i++)
                                  _fcSelected(
                                    index: i,
                                    total: draft.selected.length,
                                    label: draft.byId[draft.selected[i]] == null
                                        ? '（已停用或不在候选里 #${draft.selected[i]}）'
                                        : wsS(draft.byId[draft.selected[i]]!['name']),
                                    onUp: () => setDialogState(() => draft.move(i, -1)),
                                    onDown: () => setDialogState(() => draft.move(i, 1)),
                                    onDel: () => setDialogState(() => draft.selected.removeAt(i)),
                                  ),
                              ],
                            ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            DesktopButton(label: '取消', onPressed: () => Navigator.of(dialogContext).pop(false)),
            const SizedBox(width: 10),
            DesktopButton(
              label: '✓ 保存清单',
              kind: DesktopButtonKind.success,
              onPressed: () async {
                try {
                  await ApiService.saveFreshConfig(draft.selected);
                  if (!dialogContext.mounted) return;
                  Navigator.of(dialogContext).pop(true);
                } on ApiException catch (e) {
                  setDialogState(() {});
                  wsToast(dialogContext, '保存失败：${e.message}', error: true);
                }
              },
            ),
          ],
        ),
      ],
    );
  }

  Widget _fcOption({
    required String label,
    required String sub,
    required bool on,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        decoration: BoxDecoration(
          color: on ? WsTokens.primaryLight.withValues(alpha: 0.6) : null,
          border: const Border(bottom: BorderSide(color: WsTokens.borderLighter)),
        ),
        child: Row(
          children: [
            Icon(on ? SolarIconsOutline.checkCircle : SolarIconsOutline.minusCircle,
                size: 15, color: on ? WsTokens.primary : WsTokens.mutedLight),
            const SizedBox(width: 8),
            Expanded(child: Text(label, style: const TextStyle(fontSize: 12.5))),
            Text(sub, style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
          ],
        ),
      ),
    );
  }

  Widget _fcSelected({
    required int index,
    required int total,
    required String label,
    required VoidCallback onUp,
    required VoidCallback onDown,
    required VoidCallback onDel,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: WsTokens.borderLighter))),
      child: Row(
        children: [
          SizedBox(
            width: 26,
            child: Text('${index + 1}.', style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ),
          Expanded(child: Text(label, style: const TextStyle(fontSize: 12.5))),
          DesktopIconButton(
            icon: SolarIconsOutline.arrowUp,
            tooltip: '上移',
            size: 26,
            onPressed: index == 0 ? null : onUp,
          ),
          const SizedBox(width: 4),
          DesktopIconButton(
            icon: SolarIconsOutline.arrowDown,
            tooltip: '下移',
            size: 26,
            onPressed: index == total - 1 ? null : onDown,
          ),
          const SizedBox(width: 4),
          DesktopIconButton(
            icon: SolarIconsOutline.closeCircle,
            tooltip: '移除',
            size: 26,
            color: WsTokens.red,
            onPressed: onDel,
          ),
        ],
      ),
    );
  }

  // ------------------------------------------------ 子页 2：鲜货入库清单

  Future<void> _loadFinList() async {
    try {
      final Map<String, dynamic> cur = await ApiService.fresh(onlyList: true);
      if (!mounted) return;
      _syncRows(_mapList(cur['items']));
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '加载鲜货清单失败：${e.message}', error: true);
    }
  }

  /// 按展示清单同步表格行：已存在的行保留已填内容，新增行自动带出单价，下架行 dispose。
  void _syncRows(List<Map<String, dynamic>> items) {
    final kept = <int, _FinRow>{for (final _FinRow r in _rows) r.id: r};
    final next = <_FinRow>[];
    for (final Map<String, dynamic> it in items) {
      final int id = wsI(it['id']);
      // 网页端同样按 PRODUCTS 取商品资料（换算/最近入库价都在商品里），取不到就跳过
      final Map<String, dynamic>? p = _productById[id];
      if (p == null) continue;
      final _FinRow? old = kept.remove(id);
      if (old != null) {
        // 复用行：名字跟着清单走，单价空着就重新带出（同网页端 renderFreshInbound）
        old.name = wsS(it['name']);
        if (old.price.text.trim().isEmpty) _fillRowPrice(old, overwrite: true);
        next.add(old);
        continue;
      }
      final _FinRow row = _FinRow(id: id, name: wsS(it['name']), unit: _defaultUnitOf(p));
      _fillRowPrice(row, overwrite: true);
      next.add(row);
    }
    for (final _FinRow r in kept.values) {
      r.dispose();
    }
    setState(() {
      _rows
        ..clear()
        ..addAll(next);
    });
  }

  // 「今日已入库」：只记本机、按分仓隔离、日期不是今天就清空
  String get _doneKey {
    final String wh = widget.auth.warehouseKey;
    return wh.isEmpty ? _kDoneKeyPrefix : '$_kDoneKeyPrefix:$wh';
  }

  Future<void> _loadDone() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    final String? raw = prefs.getString(_doneKey);
    final Set<int> ids = <int>{};
    bool stale = false;
    if (raw != null && raw.isNotEmpty) {
      try {
        final Object? d = jsonDecode(raw);
        if (d is Map && wsS(d['date']) == wsToday()) {
          for (final Object? x in (d['ids'] as List?) ?? const <Object?>[]) {
            final int? v = int.tryParse('$x');
            if (v != null && v != 0) ids.add(v);
          }
        } else {
          stale = true;
        }
      } catch (_) {
        stale = true;
      }
    }
    if (stale) await prefs.remove(_doneKey);
    if (!mounted) return;
    setState(() => _doneIds = ids);
  }

  Future<void> _saveDone(Set<int> ids) async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setString(_doneKey, jsonEncode(<String, Object>{'date': wsToday(), 'ids': ids.toList()}));
  }

  void _clearQty() {
    int n = 0;
    setState(() {
      for (final _FinRow r in _rows) {
        if (r.qtyV > 0) n++;
        r.qty.clear();
        r.freight.clear();
        r.handling.clear();
      }
    });
    wsToast(context, n > 0 ? '已清空 $n 个商品的数量' : '本来就没填数量');
  }

  /// 已填数量（且当前可见）的行合计
  ({int rows, double goods, double fee, int picked}) _finTotals() {
    int rows = 0;
    double goods = 0;
    double fee = 0;
    int picked = 0;
    for (final _FinRow r in _rows) {
      if (r.pick) picked++;
      if (!_rowVisible(r)) continue;
      if (r.qtyV <= 0) continue;
      rows++;
      goods += r.amount;
      fee += r.fee;
    }
    return (rows: rows, goods: goods, fee: fee, picked: picked);
  }

  /// 关键字只影响显示（已填数量不会丢）——同网页端 finSearch
  bool _keywordMatch(_FinRow r) {
    final String kw = _keywordCtrl.text.trim().toLowerCase();
    if (kw.isEmpty) return true;
    final Map<String, dynamic>? p = _productById[r.id];
    final String hay = p == null ? r.name : '${r.name} ${wsS(p['category'])}';
    return hay.toLowerCase().contains(kw);
  }

  bool _rowVisible(_FinRow r) {
    if (!_keywordMatch(r)) return false;
    if (_doneIds.contains(r.id) && !_showDone) return false;
    return true;
  }

  /// 今日已入库、被这条关键字筛出来的行数（决定要不要显示那条提示）
  int get _doneCount => <int>[
        for (final _FinRow r in _rows)
          if (_doneIds.contains(r.id) && _keywordMatch(r)) r.id,
      ].length;

  List<_FinRow> get _shownRows => <_FinRow>[
        for (final _FinRow r in _rows)
          if (_rowVisible(r)) r,
      ];

  /// 行尾「入库」只提交这一行；不传就按网页端口径提交（勾了只入勾的，否则入当前可见的全部行）
  Future<void> _submitFin({_FinRow? only}) async {
    if (_submitting) return;
    if (only != null) {
      if (only.qtyV <= 0) {
        wsToast(context, '先把这一行要入库的数量填上', error: true);
        return;
      }
      await _submitRows(<_FinRow>[only]);
      return;
    }
    final List<_FinRow> visible = <_FinRow>[
      for (final _FinRow r in _rows)
        if (_rowVisible(r)) r,
    ];
    final List<_FinRow> picked = <_FinRow>[
      for (final _FinRow r in visible)
        if (r.pick) r,
    ];
    await _submitRows(picked.isNotEmpty ? picked : visible);
  }

  Future<void> _submitRows(List<_FinRow> targets) async {
    final items = <Map<String, dynamic>>[];
    final names = <String>[];
    final bad = <String>[];
    for (final _FinRow r in targets) {
      if (r.qtyV <= 0) continue; // 没填数量 = 今天不入库
      if (r.price.text.trim().isEmpty) {
        bad.add(r.name);
        continue;
      }
      final String rowRemark = r.remark.text.trim();
      final String common = _remarkCtrl.text.trim();
      names.add(r.name);
      items.add(<String, dynamic>{
        'product_id': r.id,
        'unit': r.unit,
        'quantity': r.qtyV,
        'unit_price': r.priceV,
        'supplier': _supplierCtrl.text.trim(),
        'operator': _operator,
        'date': _finDate,
        'remark': <String>[rowRemark, common].where((String s) => s.isNotEmpty).join('\n'),
        'pay_status': _pay,
        'adjust_amount': 0,
        'freight': r.freightV,
        'handling': r.handlingV,
      });
    }
    if (bad.isNotEmpty) {
      wsToast(context, '这些商品没填单价：${bad.take(5).join('、')}${bad.length > 5 ? ' 等' : ''}', error: true);
      return;
    }
    if (items.isEmpty) {
      wsToast(context, '还没填数量：先把今天要入库的数量填进「数量」列', error: true);
      return;
    }
    final double goods = items.fold<double>(0, (double s, Map<String, dynamic> it) => s + wsD(it['quantity']) * wsD(it['unit_price']));
    final double fee = items.fold<double>(0, (double s, Map<String, dynamic> it) => s + wsD(it['freight']) + wsD(it['handling']));
    final bool ok = await wsConfirm(
      context,
      title: '确认入库',
      message: '确认入库 ${items.length} 个商品？\n日期 $_finDate，货款 ${wsMoney(goods)}'
          '${fee > 0 ? ' + 运费/装卸 ${wsMoney(fee)}' : ''}，共 ${items.length} 张入库单',
      okLabel: '入库',
    );
    if (!ok || !mounted) return;
    setState(() {
      _submitting = true;
      _finError = null;
      _finResult = '';
    });
    try {
      final Map<String, dynamic> res = await ApiService.batchCreateInbounds(items);
      final int created = wsI(res['created']);
      final List<Map<String, dynamic>> failed = _mapList(res['failed']);
      final Set<int> submitted = <int>{
        for (final Map<String, dynamic> it in items) wsI(it['product_id']),
      };
      // 入库成功的商品记成「今日已入库」：先从列表隐藏，第二天 0 点自动回来（只记本机）
      final Set<int> done = <int>{..._doneIds}..addAll(submitted);
      for (final _FinRow r in targets) {
        // 清空数量 / 运费 / 装卸 / 行备注（单价保留，方便重填）
        if (submitted.contains(r.id)) r.clearInput();
      }
      await _saveDone(done);
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _doneIds = done;
        _finError = null;
        _finResult = '✅ 已入库 $created 张单（货款 ${wsMoney(goods)}'
            '${fee > 0 ? ' ＋ 运费/装卸 ${wsMoney(fee)}' : ''}）';
      });
      wsToast(context, '已入库 $created 张单${failed.isNotEmpty ? '，${failed.length} 行失败' : ''}',
          error: failed.isNotEmpty);
      if (failed.isNotEmpty) await _showFailed(failed, names);
      await _load(silent: true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      wsToast(context, '入库失败：${e.message}', error: true);
    }
  }

  /// 批量入库里失败的那几行（后端按 1 起始行号返回）单独弹窗列出来，别只丢一句 toast
  Future<void> _showFailed(List<Map<String, dynamic>> failed, List<String> names) async {
    await desktopDialog<void>(
      context,
      title: '有 ${failed.length} 行没入进去',
      width: 620,
      builder: (BuildContext dialogContext) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DesktopNotice(
            '这些行已经跳过，其余商品照常入库了；改完这一行再点行尾「入库」补一次就行。',
            kind: DesktopNoticeKind.warn,
          ),
          for (final Map<String, dynamic> f in failed)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 68,
                    child: Text('第 ${wsI(f['row'])} 行',
                        style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                  ),
                  Expanded(
                    child: Text(
                      '${names.length >= wsI(f['row']) && wsI(f['row']) > 0 ? names[wsI(f['row']) - 1] : ''}'
                      '　${wsS(f['reason'], fallback: '入库失败')}',
                      style: const TextStyle(fontSize: 12.5, height: 1.5),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
      submitLabel: '知道了',
    );
  }

  /// 表头那个「全选」：勾了就全取消，没勾满就把当前可见行都勾上
  void _toggleAllPick() {
    final List<_FinRow> visible = <_FinRow>[
      for (final _FinRow r in _rows)
        if (_rowVisible(r)) r,
    ];
    if (visible.isEmpty) return;
    final bool allOn = visible.every((_FinRow r) => r.pick);
    setState(() {
      for (final _FinRow r in visible) {
        r.pick = !allOn;
      }
    });
  }

  Future<void> _restoreRow(_FinRow r) async {
    final Set<int> done = <int>{..._doneIds}..remove(r.id);
    await _saveDone(done);
    if (!mounted) return;
    setState(() => _doneIds = done);
    wsToast(context, '已把「${r.name}」放回列表');
  }

  // ---------------------------------------------------------------- 渲染

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '鲜货现采',
      subtitle: '两个子页共用同一份「展示清单」：鲜货现采看全量鲜货库存、导入今日订单预演算需求（不扣库存，只出建议）；'
          '鲜货入库只列清单里挑过的商品，填数量即可逐行生成入库单。',
      actions: <Widget>[
        DesktopButton(
            label: '刷新', icon: SolarIconsOutline.refresh, onPressed: _loading ? null : () => _load(silent: true)),
        DesktopButton(label: '管理展示商品', icon: SolarIconsOutline.sliderHorizontal, onPressed: _openFreshConfig),
        if (_tab == 0)
          DesktopButton(
            label: _planning ? '⏳ 演算中…' : '导入今日订单',
            icon: SolarIconsOutline.fileDownload,
            kind: DesktopButtonKind.success,
            onPressed: _planning ? null : _importPlan,
          )
        else
          DesktopButton(
              label: '← 返回出库列表', onPressed: () => widget.onNavigate('/outbound')),
      ],
      body: DesktopStateView(
        loading: _loading,
        error: _error,
        onRetry: () => _load(),
        loadingText: '正在加载鲜货数据…',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Row(
                children: [
                  DesktopTabs(
                    items: _tabItems,
                    index: _tab,
                    onChanged: (int i) => setState(() => _tab = i),
                  ),
                  const Spacer(),
                  if (_tab == 1)
                    DesktopLink(
                        '去入库列表查看', onPressed: () => widget.onNavigate('/inbound')),
                ],
              ),
            ),
            Expanded(child: _tab == 0 ? _buildPlanView() : _buildInboundView()),
          ],
        ),
      ),
    );
  }

  // ------------------------------------------------ 子页 1：鲜货现采

  /// 有演算结果时按「预计剩余」升序排（缺货的排最前），没演算就按展示清单顺序
  List<Map<String, dynamic>> _sortedFreshItems() {
    final List<Map<String, dynamic>> list = <Map<String, dynamic>>[..._items];
    if (_plan.isEmpty) return list;
    double remainOf(Map<String, dynamic> it) {
      final Map<String, dynamic>? pl = _plan[wsI(it['id'])];
      return pl == null ? double.infinity : wsD(pl['remain']);
    }

    list.sort((Map<String, dynamic> a, Map<String, dynamic> b) {
      final int c = remainOf(a).compareTo(remainOf(b));
      return c != 0 ? c : wsS(a['name']).compareTo(wsS(b['name']));
    });
    return list;
  }

  String _planSummaryText(Map<String, dynamic> d) {
    final int orderCount = wsI(d['order_count']);
    final int needKinds = _mapList(d['items']).length;
    final int failed = wsI(d['failed_count']);
    final List<Object?> unmapped = (d['unmapped'] as List?) ?? const <Object?>[];
    final String head = '今日订单 $orderCount 单，涉及 $needKinds 种蔬菜采购需求；'
        '${failed > 0 ? '另有 $failed 单因未配置换算跳过；' : ''}';
    final String tail = unmapped.isEmpty
        ? '全部已关联 ✔'
        : '未关联编码：${unmapped.map((Object? x) => wsS(x)).join('、')}';
    return '$head$tail';
  }

  Widget _buildPlanView() {
    final List<Map<String, dynamic>> items = _sortedFreshItems();
    final Map<String, dynamic>? meta = _planMeta;
    double totalValue = 0;
    for (final Map<String, dynamic> it in items) {
      totalValue += wsD(it['stock_value']);
    }
    final List<Object?> unmapped = (meta?['unmapped'] as List?) ?? const <Object?>[];

    return SingleChildScrollView(
      child: DesktopRise(
        index: 0,
        child: WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              WsCardHead(
                title: '鲜货现采',
                icon: SolarIconsOutline.leaf,
                trailing: Text('${items.length} 个鲜货商品',
                    style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
              ),
              const DesktopNotice(
                  '展示鲜货库存；导入今日订单可预演算消耗需求（仅采购参考，不实际扣库存）。'
                  '「管理展示商品」决定下面（以及「鲜货入库」）显示哪些商品、按什么顺序显示。'),
              if (meta != null) ...[
                DesktopNotice(
                  _planSummaryText(meta),
                  kind: unmapped.isEmpty ? DesktopNoticeKind.success : DesktopNoticeKind.warn,
                ),
                DesktopStatGrid(
                  children: <Widget>[
                    DesktopStatCard(
                        label: '今日订单',
                        value: '${wsI(meta['order_count'])} 单',
                        sub: '已排除作废单，其余状态都算需求',
                        color: WsTokens.primary),
                    DesktopStatCard(
                        label: '有需求的蔬菜',
                        value: '${_mapList(meta['items']).length} 种',
                        sub: '按预计剩余升序'),
                    DesktopStatCard(
                        label: '未配置换算跳过',
                        value: '${wsI(meta['failed_count'])} 单',
                        sub: '订单解析失败、算不出需求',
                        color: wsI(meta['failed_count']) > 0 ? WsTokens.amber : null),
                    DesktopStatCard(
                        label: '倍数缺失跳过',
                        value: '${wsI(meta['skip'])} 行',
                        sub: '一单多货没配换算，需求没统计进来',
                        color: wsI(meta['skip']) > 0 ? WsTokens.amber : null),
                    DesktopStatCard(
                        label: '未关联编码',
                        value: '${unmapped.length} 个',
                        sub: unmapped.isEmpty ? '全部已关联 ✔' : unmapped.map((Object? x) => wsS(x)).join('、'),
                        color: unmapped.isEmpty ? WsTokens.green : WsTokens.red),
                  ],
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    DesktopButton(label: '清除演算结果', onPressed: _clearPlan),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Text('演算结果只存在这台电脑上，刷新或重开就没了；库存一点没动，要入库请切到「鲜货入库」。',
                          style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
              ],
              DesktopGrid(
                cols: _freshCols,
                rows: <DesktopRow>[
                  for (final Map<String, dynamic> it in items) _freshRow(it),
                ],
                rowHeight: 44,
                emptyText: '暂无鲜货商品，可点「管理展示商品」添加',
                footer: <String>[
                  '合计 ${items.length} 种',
                  '',
                  '',
                  '',
                  '',
                  '',
                  wsMoney(totalValue),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  DesktopRow _freshRow(Map<String, dynamic> it) {
    final int id = wsI(it['id']);
    final Map<String, dynamic>? pl = _plan[id];
    final String unit = wsS(it['unit']);
    final double remain = pl == null ? 0 : wsD(pl['remain']);
    final double suggest = pl == null ? 0 : wsD(pl['suggest']);
    final bool shortOf = pl != null && remain < 0;
    return DesktopRow(
      tag: id,
      // 有演算结果时，清单外、今天又没订单需求的商品淡显，好让要采购的跳出来
      dim: pl == null && _plan.isNotEmpty && _listIds.isNotEmpty && !_listIds.contains(id),
      highlight: pl != null && suggest > 0,
      cells: <Widget>[
        wsCell(wsS(it['name'], fallback: '—'),
            bold: true, tip: '${wsS(it['category'], fallback: '—')} · ${wsS(it['name'])}'),
        wsCell('${_num(it['stock'])} $unit'),
        wsCell(pl == null ? '—' : _num(pl['need'])),
        wsCell(pl == null ? '—' : _num(remain), color: shortOf ? WsTokens.red : null, bold: shortOf),
        wsCell(pl == null ? '—' : (suggest > 0 ? _num(suggest) : '0'),
            color: suggest > 0 ? WsTokens.red : null, bold: suggest > 0),
        wsCell('${wsMoney(wsD(it['avg_cost']))}/$unit'),
        wsCell(wsMoney(wsD(it['stock_value']))),
      ],
    );
  }

  // ------------------------------------------------ 子页 2：鲜货入库

  String _finEmptyText() {
    if (_rows.isEmpty) {
      return '还没挑商品：点右上「管理展示商品」把要入库的商品挑进来（候选含全部在用商品，不限分类），这里就会出现';
    }
    if (_doneCount > 0 && _shownRows.isEmpty) {
      return '今天的鲜货都入完啦 ✅（$_doneCount 个商品已入库、先从列表隐藏，'
          '明天 0 点自动回来；也可以点上面「显示今日已入库」核对）';
    }
    return '没有匹配的商品：把上面的关键字清空再看看';
  }

  String _finSummaryText(({int rows, double goods, double fee, int picked}) t) {
    return '${t.picked > 0 ? '勾选 ${t.picked} 个' : '已填 ${t.rows} 个商品'}：货款 ${wsMoney(t.goods)}'
        '${t.fee > 0 ? ' ＋ 运费/装卸 ${wsMoney(t.fee)}' : ''} ＝ 实付 ${wsMoney(t.goods + t.fee)}'
        '（每个填了数量的商品各生成一张入库单；只勾了几个就只入那几个，也可以点行尾「入库」单独入一行）';
  }

  String get _submitLabel {
    if (_submitting) return '⏳ 正在入库…';
    final ({int rows, double goods, double fee, int picked}) t = _finTotals();
    if (t.picked > 0) return '✓ 入库选中的 ${t.picked} 个商品';
    if (t.rows > 0) return '✓ 全部入库（${t.rows} 个商品）';
    return '✓ 全部入库';
  }

  Widget _buildInboundView() {
    final ({int rows, double goods, double fee, int picked}) totals = _finTotals();

    return SingleChildScrollView(
      child: DesktopRise(
        index: 0,
        child: WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              WsCardHead(
                title: '鲜货入库',
                icon: SolarIconsOutline.cartPlus,
                trailing: Text('${_rows.length} 个商品在展示清单里',
                    style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
              ),
              const DesktopNotice(
                  '只有在「管理展示商品」里挑过的商品才会出现在下面表格（候选商品与「商品」页一致，不含 包材/人工/快递）；'
                  '填数量即可入库，单价自动带出（最近入库价 → 参考成本，可改），运费 / 装卸费默认空。'),
              _finForm(),
              DesktopFilterBar(
                right: const Text('填了数量的行会高亮；没填数量的行不会入库',
                    style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                children: <Widget>[
                  DesktopTextField(
                    controller: _keywordCtrl,
                    width: 340,
                    hintText: '🔍 筛选下面表格里的商品（只影响显示，已填数量不会丢）',
                    onChanged: (_) => setState(() {}),
                  ),
                  DesktopButton(label: '清空已填数量', small: true, onPressed: _clearQty),
                  DesktopButton(
                    small: true,
                    label: _shownRows.isNotEmpty && _shownRows.every((_FinRow r) => r.pick)
                        ? '取消勾选'
                        : '全选可见行',
                    onPressed: _toggleAllPick,
                  ),
                ],
              ),
              if (_doneCount > 0) _doneBar(),
              DesktopGrid(
                cols: _finCols,
                rows: _finRows(),
                rowHeight: 58,
                emptyText: _finEmptyText(),
              ),
              if (totals.rows > 0) ...[
                const SizedBox(height: 14),
                DesktopNotice(_finSummaryText(totals)),
              ],
              if (_finResult.isNotEmpty)
                DesktopNotice(
                  '$_finResult　${_doneCount > 0 ? '这些商品今天已隐藏，明天 0 点自动回来。' : ''}',
                  kind: DesktopNoticeKind.success,
                ),
              if (_finError != null)
                DesktopNotice(_finError!, kind: DesktopNoticeKind.error),
              const SizedBox(height: 14),
              _remarkField(),
              const SizedBox(height: 6),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  const Expanded(
                    child: Text(
                        '运费 / 装卸费默认留空：填了会算进该商品的批次成本（体现在它的毛利上），并同步「其他开支」备查；'
                        '商品类别若配了扣点，入库单价会自动按 原价 × (1 − 扣点%) 折算。',
                        style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5)),
                  ),
                  const SizedBox(width: 16),
                  DesktopButton(
                    label: _submitLabel,
                    icon: SolarIconsOutline.checkCircle,
                    kind: DesktopButtonKind.success,
                    onPressed: _submitting ? null : () => _submitFin(),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 顶部公共信息：日期* / 供应商 / 操作员（锁定当前登录人）/ 付款状态
  Widget _finForm() {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 22,
            runSpacing: 12,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              DesktopLabeled(
                label: '日期',
                child: DesktopDateField(
                  value: _finDate,
                  allowClear: false,
                  onChanged: (String v) => setState(() => _finDate = v.isEmpty ? wsToday() : v),
                ),
              ),
              DesktopLabeled(
                label: '供应商',
                child: DesktopTextField(
                    controller: _supplierCtrl, width: 190, hintText: '供应商名称（选填）'),
              ),
              DesktopLabeled(label: '操作员', child: _lockedField(_operator)),
              DesktopLabeled(
                label: '付款状态',
                child: DesktopPayRadios(value: _pay, onChanged: (String v) => setState(() => _pay = v)),
              ),
            ],
          ),
          const SizedBox(height: 8),
          const Text('待付款：先进「待付款账单」，点「已支付」后才计入财务报表',
              style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
        ],
      ),
    );
  }

  /// 操作员：默认当前登录账号，不可修改（后端也按登录人落库）
  Widget _lockedField(String text) {
    final bool dark = wsIsDark(context);
    return Tooltip(
      message: '默认当前登录账号，不可修改',
      child: Container(
        width: 170,
        height: 34,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: dark ? WsTokens.borderDark : WsTokens.borderLighter,
          borderRadius: BorderRadius.circular(WsTokens.radiusSm),
          border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                text,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: 13, color: dark ? WsTokens.textDark : WsTokens.textLight),
              ),
            ),
            const Icon(SolarIconsOutline.lock, size: 14, color: WsTokens.mutedLight),
          ],
        ),
      ),
    );
  }

  /// 共用备注：提交时写进每一张入库单
  Widget _remarkField() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('备注', style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
        const SizedBox(height: 6),
        DesktopTextField(
          controller: _remarkCtrl,
          width: double.infinity,
          maxLines: 2,
          hintText: '可选：本次入库的每一张单共用',
        ),
      ],
    );
  }

  /// 那条「今日已入库」提示 + 显示/隐藏开关（只记本机，按分仓隔离）
  Widget _doneBar() {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: WsTokens.greenLight.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: WsTokens.green.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              _showDone
                  ? '已显示今日已入库的 $_doneCount 个商品（灰显，点行尾「恢复」可放回列表）'
                  : '今日已入库 $_doneCount 个商品，已从列表隐藏（明天 0 点自动回来）'
                    '　——只记在这台电脑上，按分仓隔离，与手机端各存各的、互不覆盖',
              style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight, height: 1.5),
            ),
          ),
          const SizedBox(width: 10),
          DesktopButton(
            small: true,
            label: _showDone ? '隐藏它们' : '显示今日已入库',
            onPressed: () => setState(() => _showDone = !_showDone),
          ),
        ],
      ),
    );
  }

  List<DesktopRow> _finRows() {
    final List<DesktopRow> out = <DesktopRow>[];
    for (final _FinRow r in _rows) {
      if (!_rowVisible(r)) continue;
      final Map<String, dynamic>? p = _productById[r.id];
      final bool done = _doneIds.contains(r.id);
      final List<String> units = p == null ? <String>[r.unit] : _unitsOf(p);
      out.add(
        DesktopRow(
          tag: r.id,
          dim: done,
          highlight: r.qtyV > 0,
          cells: <Widget>[
            Center(
              child: Checkbox(
                value: r.pick,
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                onChanged: (bool? v) => setState(() => r.pick = v ?? false),
              ),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Flexible(
                        child: Text(r.name,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                      ),
                      if (done) ...<Widget>[
                        const SizedBox(width: 6),
                        const DesktopTag('今日已入库', color: DesktopTag.income),
                      ],
                    ],
                  ),
                  Text(
                    p == null ? '—' : _unitHintText(r, p),
                    style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            DesktopSelect<String>(
              value: r.unit,
              width: 84,
              options: <DesktopOption<String>>[
                for (final String u in units) DesktopOption<String>(u, u),
              ],
              onChanged: (String? v) {
                final String u = v ?? r.unit;
                if (u == r.unit) return;
                setState(() {
                  r.unit = u;
                  r.price.clear(); // 换单位后单价要按新单位重算
                  _fillRowPrice(r, overwrite: true);
                });
              },
            ),
            DesktopTextField(
              controller: r.qty,
              width: 66,
              hintText: '0',
              keyboardType: _kNum,
              textAlign: TextAlign.end,
              inputFormatters: DesktopTextField.decimalOnly,
              onChanged: (_) => setState(() {}),
            ),
            Tooltip(
              message: r.priceHint.isEmpty ? '单价：自动带出最近入库价 / 参考成本，可手改' : r.priceHint,
              child: DesktopTextField(
                controller: r.price,
                width: 96,
                hintText: '0.00',
                keyboardType: _kNum,
                textAlign: TextAlign.end,
                inputFormatters: DesktopTextField.decimalOnly,
                onChanged: (_) => setState(() {}),
              ),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: <Widget>[
                  Text(wsMoney(r.amount),
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  if (r.fee > 0)
                    Text('批次成本 ${wsMoney(r.amount + r.fee)}',
                        style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight)),
                ],
              ),
            ),
            DesktopTextField(
              controller: r.freight,
              width: 66,
              hintText: '留空',
              keyboardType: _kNum,
              textAlign: TextAlign.end,
              inputFormatters: DesktopTextField.decimalOnly,
              onChanged: (_) => setState(() {}),
            ),
            DesktopTextField(
              controller: r.handling,
              width: 66,
              hintText: '留空',
              keyboardType: _kNum,
              textAlign: TextAlign.end,
              inputFormatters: DesktopTextField.decimalOnly,
              onChanged: (_) => setState(() {}),
            ),
            DesktopTextField(
              controller: r.remark,
              width: 156,
              hintText: '这一行的备注',
              onChanged: (_) => setState(() {}),
            ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                DesktopLink('入库',
                    onPressed: _submitting ? null : () => _submitFin(only: r)),
                if (done)
                  DesktopLink('恢复', color: WsTokens.green, onPressed: () => _restoreRow(r)),
              ],
            ),
          ],
        ),
      );
    }
    return out;
  }
}
