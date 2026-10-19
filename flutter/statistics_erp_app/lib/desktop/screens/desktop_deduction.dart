import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../fluent_theme.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';

/// 桌面端「扣点」页，1:1 复刻 web `#page-deduction`（三张卡：扣点设置 / 入仓品扣点 / 店铺扣点规则）。
///
/// 真源：web/static/app.js 的 loadDeductionPage / deducSave / whDeducSave / shopDeducSave，
/// 后端 backend/app/routers/deductions.py：
///  - 分类扣点、入仓品扣点 → Deduction 表（按 category 唯一 upsert），入库/批量导入时折算入库成本；
///  - 入仓品扣点固定用 category == '入仓品' 这一条（backend/app/routers/warehouse_in.py 读它算收入）；
///  - 店铺扣点 → backend/json/deduction_config.json（**不是数据库**），聚水潭订单导入按店铺名扣卖家实收。
class DesktopDeductionScreen extends StatefulWidget {
  const DesktopDeductionScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopDeductionScreen> createState() => _DesktopDeductionScreenState();
}

const TextInputType _kNum = TextInputType.numberWithOptions(decimal: true);

/// 入仓品扣点在后端就是 Deduction 表里的一条特殊类别（WAREHOUSE_DEDUCTION_CATEGORY）
const String _kWhCategory = '入仓品';

/// 入仓品扣点默认值（backend/app/initdb.py 种的种子也是 6%）
const String _kWhDefaultPercent = '6';

double? _parsePercent(String text) {
  final v = double.tryParse(text.trim());
  if (v == null || v < 0 || v >= 100) return null;
  return v;
}

String _pctText(num v) => '${v.toStringAsFixed(2)}%';

/// 后端 JSON 数组 → List<Map>，脏数据直接跳过
List<Map<String, dynamic>> _asMapList(dynamic v) {
  if (v is! List) return <Map<String, dynamic>>[];
  return <Map<String, dynamic>>[
    for (final Object? e in v)
      if (e is Map) Map<String, dynamic>.from(e),
  ];
}

/// ISO 时间戳 → 「YYYY-MM-DD HH:mm」（列表里太长的原始串没法看）
String _fmtTime(dynamic v) {
  final s = wsS(v);
  if (s.length >= 16 && s.contains('T')) return '${s.substring(0, 10)} ${s.substring(11, 16)}';
  return s.isEmpty ? '—' : s;
}

// ---------------------------------------------------------------- 店铺扣点草稿

/// 店铺扣点弹窗的输入草稿：类别行可加可删，出弹窗时统一 dispose。
class _ShopDraft {
  _ShopDraft({
    required Map<String, dynamic>? rule,
    required List<String> shops,
  })  : shop = TextEditingController(text: wsS(rule?['shop'])),
        percent = TextEditingController(),
        shopOptions = [
          for (final s in shops) DesktopOption<String>(s, s),
        ] {
    final Object? p = rule?['percent'];
    if (p != null) {
      percent.text = wsTrim(wsD(p), digits: 4);
      type = 'fixed';
    } else {
      type = 'category';
    }
    final Object? cats = rule?['categories'];
    if (cats is Map) {
      for (final Object? k in cats.keys) {
        catRows.add(_ShopCatRow(
          category: wsS(k),
          percent: wsTrim(wsD(cats[k]), digits: 4),
        ));
      }
    }
  }

  final TextEditingController shop;
  final TextEditingController percent;

  /// 「按分类扣点」的动态行
  final List<_ShopCatRow> catRows = <_ShopCatRow>[];

  /// 已配置过的店铺名（避免同名新建）
  final List<DesktopOption<String>> shopOptions;

  String type = 'fixed';

  bool get isFixed => type == 'fixed';

  void dispose() {
    shop.dispose();
    percent.dispose();
    for (final _ShopCatRow r in catRows) {
      r.dispose();
    }
  }
}

class _ShopCatRow {
  _ShopCatRow({String category = '', String percent = ''})
      : category = TextEditingController(text: category),
        percent = TextEditingController(text: percent);

  final TextEditingController category;
  final TextEditingController percent;

  void dispose() {
    category.dispose();
    percent.dispose();
  }
}

// ---------------------------------------------------------------- State

class _DesktopDeductionScreenState extends State<DesktopDeductionScreen> {
  bool _loading = true;
  String? _error;

  /// Deduction 表全量（含「入仓品」那条，卡 1 渲染时才过滤掉）
  List<Map<String, dynamic>> _deducs = <Map<String, dynamic>>[];
  List<Map<String, dynamic>> _shopRules = <Map<String, dynamic>>[];
  String _shopFile = '';
  double _whEffective = -1;

  /// 商品分类候选（web deducCategories()：取 PRODUCTS 的 category 去重排序）
  List<String> _categories = <String>[];

  final TextEditingController _whCtrl = TextEditingController(text: _kWhDefaultPercent);

  static const List<DesktopCol> _deducCols = [
    DesktopCol('商品类别', width: 160),
    DesktopCol('扣点 %', width: 110, right: true, tip: '入库单价 = 进货单价 × (1 − 扣点%)'),
    DesktopCol('备注', width: 300),
    DesktopCol('更新时间', width: 160),
    DesktopCol('操作', width: 130, center: true),
  ];

  static const List<DesktopCol> _shopCols = [
    DesktopCol('店铺名称', width: 240),
    DesktopCol('规则类型', width: 140),
    DesktopCol('扣点', width: 430),
    DesktopCol('操作', width: 130, center: true),
  ];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _whCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final List<dynamic> deducs = await ApiService.deductions();
      final Map<String, dynamic> shops = await ApiService.shopDeductions();
      final List<dynamic> products = await ApiService.products();
      final Map<String, dynamic> wh = await ApiService.warehouseDeduction();
      if (!mounted) return;
      final rows = _asMapList(deducs);
      final cats = <String>{
        for (final p in products)
          if (p is Map) wsS(p['category']),
      }.toList()
        ..removeWhere((String c) => c.isEmpty)
        ..sort();
      setState(() {
        _deducs = rows;
        _shopFile = wsS(shops['file']);
        _shopRules = _asMapList(shops['rules']);
        _categories = cats;
        _whEffective = wsD(wh['percent']);
        // 初值取 deductions() 里「入仓品」那条；没配过就按默认 6%
        final whRow = rows.where((Map<String, dynamic> d) => wsS(d['category']) == _kWhCategory).toList();
        _whCtrl.text = whRow.isEmpty
            ? _kWhDefaultPercent
            : wsTrim(wsD(whRow.first['percent']), digits: 4);
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
      wsToast(context, e.message, error: true);
    }
  }

  // ------------------------------------------------ 分类扣点（卡 1）

  List<Map<String, dynamic>> get _catRows =>
      _deducs.where((Map<String, dynamic> d) => wsS(d['category']) != _kWhCategory).toList();

  Future<void> _openDeducEditor([Map<String, dynamic>? row]) async {
    final TextEditingController catCtrl = TextEditingController(text: wsS(row?['category']));
    final TextEditingController pctCtrl = TextEditingController(
      text: row == null ? '' : wsTrim(wsD(row['percent']), digits: 4),
    );
    final TextEditingController remarkCtrl = TextEditingController(text: wsS(row?['remark']));
    String error = '';
    final bool isEdit = row != null;
    final bool? saved = await desktopDialog<bool>(
      context,
      title: isEdit ? '编辑扣点' : '新增扣点',
      width: 620,
      builder: (BuildContext dialogContext) => StatefulBuilder(
        builder: (BuildContext context, StateSetter setDialogState) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DesktopFormRow(
              label: '商品类别',
              required: true,
              width: 250,
              tip: '候选是现有商品分类，也可直接手输新分类；类别名唯一，重复保存即覆盖',
              child: Row(
                children: [
                  DesktopTextField(
                    controller: catCtrl,
                    width: 168,
                    hintText: '如 蔬菜 / 干货',
                    onChanged: (_) => setDialogState(() {}),
                  ),
                  const SizedBox(width: 6),
                  DesktopIconButton(
                    icon: Icons.search,
                    tooltip: '从商品分类里选',
                    onPressed: () async {
                      final String? picked = await desktopSearchSelect(
                        context,
                        title: '选择商品类别',
                        options: [for (final String c in _categories) DesktopOption<String>(c, c)],
                        value: catCtrl.text.trim().isEmpty ? null : catCtrl.text.trim(),
                        hint: '搜索分类',
                      );
                      if (picked == null || picked.isEmpty) return;
                      setDialogState(() => catCtrl.text = picked);
                    },
                  ),
                ],
              ),
            ),
            DesktopFormRow(
              label: '扣点 %',
              required: true,
              width: 160,
              tip: '入库单价 = 进货单价 × (1 − 扣点%)，如 7% → 3.5 元按 3.255 元入库（0 ~ 99.99）',
              child: DesktopTextField(
                controller: pctCtrl,
                width: 150,
                hintText: '如 7',
                keyboardType: _kNum,
                inputFormatters: DesktopTextField.decimalOnly,
                onChanged: (_) => setDialogState(() {}),
              ),
            ),
            DesktopFormRow(
              label: '备注',
              width: 320,
              child: DesktopTextField(controller: remarkCtrl, width: 320, hintText: '可选'),
            ),
            if (error.isNotEmpty)
              DesktopNotice(error, kind: DesktopNoticeKind.error)
            else
              const DesktopNotice('扣点只影响「批量导入→入库」解析出的进货单价，已经入过库的单据不会追溯重算。'),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                DesktopButton(
                  label: '取消',
                  onPressed: () => Navigator.of(dialogContext).pop(false),
                ),
                const SizedBox(width: 10),
                DesktopButton(
                  label: '保存',
                  kind: DesktopButtonKind.primary,
                  onPressed: () async {
                    final String category = catCtrl.text.trim();
                    if (category.isEmpty) {
                      setDialogState(() => error = '商品类别不能为空');
                      return;
                    }
                    final double? percent = _parsePercent(pctCtrl.text);
                    if (percent == null) {
                      setDialogState(() => error = '扣点百分比必须在 0 ~ 100 之间（不含 100）');
                      return;
                    }
                    try {
                      await ApiService.upsertDeduction(category, percent, remark: remarkCtrl.text.trim());
                      if (!dialogContext.mounted) return;
                      Navigator.of(dialogContext).pop(true);
                    } on ApiException catch (e) {
                      setDialogState(() => error = e.message);
                    }
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
    catCtrl.dispose();
    pctCtrl.dispose();
    remarkCtrl.dispose();
    if (saved != true) return;
    if (!mounted) return;
    wsToast(context, '已保存扣点规则');
    await _load();
  }

  Future<void> _deleteDeduc(Map<String, dynamic> row) async {
    final String category = wsS(row['category']);
    final int id = wsI(row['id']);
    final bool ok = await wsConfirm(
      context,
      title: '删除扣点规则',
      message: '确认删除「$category」的扣点规则？删除后该类别入库将不再折算。',
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      await ApiService.deleteDeduction(id);
      if (!mounted) return;
      wsToast(context, '已删除');
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '删除失败：${e.message}', error: true);
    }
  }

  // ------------------------------------------------ 入仓品扣点（卡 2）

  Future<void> _saveWh() async {
    final double? percent = _parsePercent(_whCtrl.text);
    if (percent == null) {
      wsToast(context, '入仓品扣点需在 0 ~ 100 之间', error: true);
      return;
    }
    try {
      await ApiService.upsertDeduction(_kWhCategory, percent, remark: '入仓品采购价（收入）扣点');
      if (!mounted) return;
      wsToast(context, '入仓品扣点已保存（实时生效）');
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '保存失败：${e.message}', error: true);
    }
  }

  // ------------------------------------------------ 店铺扣点（卡 3）

  List<String> get _shopNames {
    final set = <String>{for (final r in _shopRules) wsS(r['shop']).trim()};
    set.removeWhere((String s) => s.isEmpty);
    return set.toList()..sort();
  }

  Future<void> _openShopEditor([Map<String, dynamic>? rule]) async {
    final _ShopDraft draft = _ShopDraft(rule: rule, shops: _shopNames);
    String error = '';
    final bool? saved = await desktopDialog<bool>(
      context,
      title: rule == null ? '新增店铺扣点' : '编辑店铺扣点',
      width: 760,
      maxHeight: 760,
      builder: (BuildContext dialogContext) => StatefulBuilder(
        builder: (BuildContext context, StateSetter setDialogState) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DesktopFormRow(
              label: '店铺名称',
              required: true,
              width: 300,
              tip: '聚水潭出库单按「店铺名称」自动扣减订单收入，要和聚水潭里的店名一字不差',
              child: Row(
                children: [
                  DesktopTextField(
                    controller: draft.shop,
                    width: 218,
                    hintText: '如：梓云茶蔬菜源头直发京东自营专区',
                    onChanged: (_) => setDialogState(() {}),
                  ),
                  const SizedBox(width: 6),
                  DesktopIconButton(
                    icon: Icons.search,
                    tooltip: '从已配置的店铺里选',
                    onPressed: draft.shopOptions.isEmpty
                        ? null
                        : () async {
                            final String? picked = await desktopSearchSelect(
                              context,
                              title: '选择店铺',
                              options: draft.shopOptions,
                              value: draft.shop.text.trim().isEmpty ? null : draft.shop.text.trim(),
                              hint: '搜索店铺名',
                            );
                            if (picked == null || picked.isEmpty) return;
                            setDialogState(() => draft.shop.text = picked);
                          },
                  ),
                ],
              ),
            ),
            DesktopFormRow(
              label: '规则类型',
              width: 340,
              child: DesktopSelect<String>(
                width: 340,
                value: draft.type,
                options: const [
                  DesktopOption<String>('fixed', '固定扣点（该店所有商品统一扣 %）'),
                  DesktopOption<String>('category', '按扣减库存分类扣点'),
                ],
                onChanged: (String? v) => setDialogState(() => draft.type = v ?? 'fixed'),
              ),
            ),
            if (draft.isFixed)
              DesktopFormRow(
                label: '固定扣点 %',
                required: true,
                width: 160,
                tip: '0 ~ 99.99；从「卖家实收」里扣掉的百分比',
                child: DesktopTextField(
                  controller: draft.percent,
                  width: 150,
                  hintText: '如 8',
                  keyboardType: _kNum,
                  inputFormatters: DesktopTextField.decimalOnly,
                  onChanged: (_) => setDialogState(() {}),
                ),
              )
            else ...[
              const Padding(
                padding: EdgeInsets.only(left: 108, bottom: 6),
                child: Text('按分类扣点（后端会忽略填 0 的分类）',
                    style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              ),
              for (final _ShopCatRow row in draft.catRows)
                Padding(
                  padding: const EdgeInsets.only(left: 108, bottom: 8),
                  child: Row(
                    children: [
                      DesktopTextField(
                        controller: row.category,
                        width: 180,
                        hintText: '分类，如 蔬菜',
                        onChanged: (_) => setDialogState(() {}),
                      ),
                      const SizedBox(width: 8),
                      DesktopTextField(
                        controller: row.percent,
                        width: 90,
                        hintText: '%',
                        textAlign: TextAlign.end,
                        keyboardType: _kNum,
                        inputFormatters: DesktopTextField.decimalOnly,
                        onChanged: (_) => setDialogState(() {}),
                      ),
                      const SizedBox(width: 4),
                      DesktopLink(
                        '删',
                        color: WsTokens.red,
                        onPressed: () => setDialogState(() {
                          final int i = draft.catRows.indexOf(row);
                          if (i < 0) return;
                          draft.catRows.removeAt(i).dispose();
                        }),
                      ),
                    ],
                  ),
                ),
              Padding(
                padding: const EdgeInsets.only(left: 108, bottom: 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: DesktopButton(
                    label: '＋ 加一行分类',
                    small: true,
                    icon: Icons.add,
                    onPressed: () => setDialogState(() => draft.catRows.add(_ShopCatRow())),
                  ),
                ),
              ),
            ],
            if (error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(left: 108),
                child: DesktopNotice(error, kind: DesktopNoticeKind.error),
              ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                DesktopButton(label: '取消', onPressed: () => Navigator.of(dialogContext).pop(false)),
                const SizedBox(width: 10),
                DesktopButton(
                  label: '保存',
                  kind: DesktopButtonKind.primary,
                  onPressed: () async {
                    final String shop = draft.shop.text.trim();
                    if (shop.isEmpty) {
                      setDialogState(() => error = '店铺名称不能为空');
                      return;
                    }
                    final Map<String, dynamic> body = <String, dynamic>{'shop': shop};
                    if (draft.isFixed) {
                      final double? percent = _parsePercent(draft.percent.text);
                      if (percent == null) {
                        setDialogState(() => error = '固定扣点百分比需在 0 ~ 100 之间（不含 100）');
                        return;
                      }
                      body['percent'] = percent;
                    } else {
                      final Map<String, double> cats = <String, double>{};
                      for (final _ShopCatRow row in draft.catRows) {
                        final String k = row.category.text.trim();
                        final double? v = double.tryParse(row.percent.text.trim());
                        if (k.isEmpty || v == null || v <= 0) continue;
                        cats[k] = v;
                      }
                      if (cats.isEmpty) {
                        setDialogState(() => error = '请至少填写一个分类扣点');
                        return;
                      }
                      body['categories'] = cats;
                    }
                    try {
                      final Map<String, dynamic> res = await ApiService.upsertShopDeduction(body);
                      if (!dialogContext.mounted) return;
                      Navigator.of(dialogContext).pop(true);
                      // 写接口直接回整份 rules，省一次 GET
                      if (mounted) setState(() => _shopRules = _asMapList(res['rules']));
                    } on ApiException catch (e) {
                      setDialogState(() => error = e.message);
                    }
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
    draft.dispose();
    if (saved != true) return;
    if (!mounted) return;
    wsToast(context, '店铺扣点已保存（实时生效）');
  }

  Future<void> _deleteShop(Map<String, dynamic> rule) async {
    final String shop = wsS(rule['shop']).trim();
    final bool ok = await wsConfirm(
      context,
      title: '删除店铺扣点',
      message: '确认删除店铺「$shop」的扣点规则？删除后该店订单不再折算。',
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      final Map<String, dynamic> res = await ApiService.deleteShopDeduction(shop);
      if (!mounted) return;
      setState(() => _shopRules = _asMapList(res['rules']));
      wsToast(context, '已删除');
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '删除失败：${e.message}', error: true);
    }
  }

  // ------------------------------------------------ 渲染

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '扣点',
      subtitle: '三处扣点用在三条不同链路上，互不影响：分类扣点在「批量导入 → 入库」时把进货单价折算成入库成本；'
          '入仓品扣点在「入仓结算」时把采购价折算成实际收入；店铺扣点在「聚水潭订单导入」时从卖家实收里扣。',
      actions: [
        DesktopButton(label: '刷新', icon: Icons.refresh, onPressed: _load),
      ],
      body: DesktopStateView(
        loading: _loading,
        error: _error,
        onRetry: _load,
        loadingText: '加载扣点规则…',
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            _buildCatCard(context),
            _buildWhCard(context),
            _buildShopCard(context),
          ],
        ),
      ),
    );
  }

  Widget _buildCatCard(BuildContext context) {
    final rows = _catRows;
    return DesktopRise(
      index: 0,
      child: WsCard(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            WsCardHead(
              title: '扣点设置',
              icon: Icons.calculate_outlined,
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('共 ${rows.length} 条 · 存 Deduction 表（按分类唯一）',
                      style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                  const SizedBox(width: 12),
                  DesktopButton(
                    label: '＋ 新增扣点',
                    icon: Icons.add,
                    kind: DesktopButtonKind.success,
                    small: true,
                    onPressed: () => _openDeducEditor(),
                  ),
                ],
              ),
            ),
            const DesktopNotice(
              '批量导入→入库解析「进货单价」时按 原价 × (1 − 扣点%) 折算为入库成本（影响库存均价与利润）',
            ),
            DesktopGrid(
              cols: _deducCols,
              rows: [
                for (final d in rows)
                  DesktopRow(
                    cells: [
                      wsCell(wsS(d['category']), bold: true),
                      wsCell(_pctText(wsD(d['percent'])), color: WsTokens.primary, bold: true),
                      wsCell(wsS(d['remark'], fallback: '—'), color: WsTokens.mutedLight),
                      wsCell(_fmtTime(d['updated_at']), color: WsTokens.mutedLight),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          DesktopLink('编辑', onPressed: () => _openDeducEditor(d)),
                          DesktopLink(
                            '删除',
                            color: WsTokens.red,
                            onPressed: () => _deleteDeduc(d),
                          ),
                        ],
                      ),
                    ],
                  ),
              ],
              emptyText: '暂无扣点规则，点击「新增扣点」配置（如 蔬菜 7%）',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildWhCard(BuildContext context) {
    final double? percent = _parsePercent(_whCtrl.text);
    final bool dirty = percent != null && (percent - _whEffective).abs() > 0.0001;
    return DesktopRise(
      index: 1,
      child: WsCard(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            WsCardHead(
              title: '入仓品扣点',
              icon: Icons.storefront_outlined,
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  DesktopButton(
                    label: '保存',
                    icon: Icons.save_outlined,
                    kind: DesktopButtonKind.success,
                    small: true,
                    onPressed: _saveWh,
                  ),
                ],
              ),
            ),
            const DesktopNotice(
              '实际收入 = 采购价 × (1 − 扣点%)，保存后入仓结算立即生效',
            ),
            Wrap(
              spacing: 16,
              runSpacing: 12,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                DesktopLabeled(
                  label: '入仓品扣点 %（0 ~ 99.99）',
                  child: DesktopTextField(
                    controller: _whCtrl,
                    width: 140,
                    hintText: _kWhDefaultPercent,
                    textAlign: TextAlign.end,
                    keyboardType: _kNum,
                    inputFormatters: DesktopTextField.decimalOnly,
                    onChanged: (_) => setState(() {}),
                  ),
                ),
                wsCell(
                  _whEffective < 0
                      ? '入仓结算当前生效扣点：读取中…'
                      : '入仓结算当前生效扣点：${_pctText(_whEffective)}（后端 /api/warehouse-in/deduction 核对）',
                  color: WsTokens.mutedLight,
                ),
              ],
            ),
            if (dirty)
              const Padding(
                padding: EdgeInsets.only(top: 10),
                child: DesktopNotice(
                  '框里的值和生效值不一致：点「保存」写入「$_kWhCategory」这条扣点规则即可生效。',
                  kind: DesktopNoticeKind.warn,
                ),
              ),
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                '这条规则也是 Deduction 表里的一条记录（类别名「$_kWhCategory」），所以它不出现在上面「扣点设置」列表里；'
                '备注固定写「入仓品采购价（收入）扣点」。',
                style: TextStyle(
                  fontSize: 12,
                  height: 1.5,
                  color: wsIsDark(context) ? WsTokens.mutedDark : WsTokens.mutedLight,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildShopCard(BuildContext context) {
    final bool dark = wsIsDark(context);
    return DesktopRise(
      index: 2,
      child: WsCard(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            WsCardHead(
              title: '店铺扣点规则',
              icon: Icons.store_outlined,
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('共 ${_shopRules.length} 家店铺',
                      style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                  const SizedBox(width: 12),
                  DesktopButton(
                    label: '＋ 新增店铺扣点',
                    icon: Icons.add,
                    kind: DesktopButtonKind.success,
                    small: true,
                    onPressed: () => _openShopEditor(),
                  ),
                ],
              ),
            ),
            const DesktopNotice(
              '聚水潭订单导入时按「店铺名称」扣减订单收入（卖家实收），保存后立即生效',
            ),
            DesktopGrid(
              cols: _shopCols,
              rowHeight: 52,
              rows: [
                for (final r in _shopRules)
                  DesktopRow(
                    cells: [
                      wsCell(wsS(r['shop']), bold: true, tip: wsS(r['shop'])),
                      wsCell(r['percent'] != null ? '固定扣点' : '按分类扣点',
                          color: WsTokens.mutedLight),
                      Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          wsCell(
                            _ruleText(r),
                            color: WsTokens.green,
                            bold: true,
                            tip: _ruleText(r),
                          ),
                          const SizedBox(height: 2),
                          const Text(
                            '聚水潭订单导入时按「店铺名称」从「卖家实收」中扣除',
                            style: TextStyle(fontSize: 11, color: WsTokens.mutedLight),
                          ),
                        ],
                      ),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          DesktopLink('编辑', onPressed: () => _openShopEditor(r)),
                          DesktopLink('删除', color: WsTokens.red, onPressed: () => _deleteShop(r)),
                        ],
                      ),
                    ],
                  ),
              ],
              emptyText: '未配置店铺扣点规则',
            ),
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                '存储说明：上面三类扣点里，只有「分类扣点 / 入仓品扣点」存在数据库（Deduction 表）；'
                '这几条店铺扣点规则不在数据库里，而是写在分仓服务同机的 json 配置文件中，保存即整份覆盖、实时生效：'
                '${_shopFile.isEmpty ? '—' : _shopFile}',
                style: TextStyle(
                  fontSize: 12,
                  height: 1.5,
                  color: dark ? WsTokens.mutedDark : WsTokens.mutedLight,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 扣点列文案（照抄网页端 renderShopDeducTable：固定扣 X% / 按扣减库存分类 蔬菜 7.00%、干货 5.00%）
  String _ruleText(Map<String, dynamic> r) {
    if (r['percent'] != null) return '固定扣 ${_pctText(wsD(r['percent']))}';
    final Object? cats = r['categories'];
    if (cats is! Map || cats.isEmpty) return '按扣减库存分类（还没填分类）';
    return '按扣减库存分类 ${cats.entries.map((MapEntry<dynamic, dynamic> e) => '${wsS(e.key)} ${_pctText(wsD(e.value))}').join('、')}';
  }
}
