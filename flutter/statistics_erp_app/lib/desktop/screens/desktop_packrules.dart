import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../fluent_theme.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';

/// 桌面端「一单多货」页：1:1 复刻 web `#page-packrules`。
///
/// 数据源 backend/app/routers/pack_rules.py：GET/POST/PUT/DELETE /api/pack-rules。
/// 规则名（name）由后端按 items 的真实商品名 + 数量自动生成（_gen_name），
/// 前端传什么都不影响键值，所以提交体里不带 name。
class DesktopPackRulesScreen extends StatefulWidget {
  const DesktopPackRulesScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopPackRulesScreen> createState() => _DesktopPackRulesScreenState();
}

// ---------------------------------------------------------------- 常量 / 小工具

const TextInputType _kNum = TextInputType.numberWithOptions(decimal: true);

/// 列表列（对齐 web renderPackRules 表头）
const List<DesktopCol> _kCols = [
  DesktopCol('组合名称', width: 200, sortKey: 'name'),
  DesktopCol('组合内商品', width: 300),
  DesktopCol('纸箱', width: 220),
  DesktopCol('箱型号', width: 140, sortKey: 'box_type'),
  DesktopCol('打包费', width: 96, right: true, sortKey: 'labor'),
  DesktopCol('箱比', width: 72, right: true),
  DesktopCol('在用', width: 80, center: true),
  DesktopCol('备注', width: 160),
  DesktopCol('操作', width: 150),
];

Map<String, dynamic> _asMap(dynamic v) => v is Map ? v.cast<String, dynamic>() : <String, dynamic>{};

/// 数量显示：整数不带小数点
String _qty(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : '$v';

/// 照抄 web prModelOf / 后端 _model_from_box_product：按名称剥离型号前缀。
/// '3号纸箱'→'3号'；'松茸6号箱'→'松茸6号'；其余保持原样。
String _prModelOf(String name) {
  final n = name;
  if (n.endsWith('纸箱')) return n.substring(0, n.length - 2);
  if (n.endsWith('号箱')) return n.substring(0, n.length - 1);
  return n;
}

/// 把 '7号*2+8号' 这类历史 box_type 解析成 [{name, quantity}]（照 _box_type_to_items）。
List<({String name, double qty})> _boxTypeToItems(String boxType) {
  final out = <({String name, double qty})>[];
  for (final raw in boxType.split('+')) {
    final part = raw.trim();
    if (part.isEmpty) continue;
    final m = RegExp(r'\*(\d+)$').firstMatch(part);
    if (m != null) {
      final name = part.substring(0, m.start).trim();
      if (name.isNotEmpty) out.add((name: name, qty: double.parse(m.group(1)!)));
    } else {
      out.add((name: part, qty: 1));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 主 State

class _DesktopPackRulesScreenState extends State<DesktopPackRulesScreen> {
  List<dynamic> _rules = <dynamic>[];
  List<dynamic> _products = <dynamic>[];
  bool _loading = true;
  String? _error;

  final TextEditingController _searchCtrl = TextEditingController();
  String _boxFilter = '';
  String _sortKey = 'name';
  bool _sortAsc = true;
  final Set<int> _expanded = <int>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        ApiService.packRules(),
        ApiService.products(),
      ]);
      if (!mounted) return;
      setState(() {
        _rules = results[0];
        _products = results[1];
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载失败：${e.message}';
        _loading = false;
      });
      wsToast(context, e.message, error: true);
    }
  }

  // -------------------------------------------------- 商品分类（照 web prOrderProducts 等）

  List<Map<String, dynamic>> get _orderProducts => _products
      .map(_asMap)
      .where((p) => p['product_type'] == 'order' && p['is_active'] == true)
      .toList();

  List<Map<String, dynamic>> get _stockProducts => _products
      .map(_asMap)
      .where((p) =>
          p['is_active'] == true &&
          p['product_type'] == 'stock' &&
          !['人工', '包材', '快递'].contains(wsS(p['category'])))
      .toList();

  /// 纸箱只能进「分类为包材且名称含「箱」或「纸」」的商品（照 web prBoxProducts）。
  List<Map<String, dynamic>> get _boxProducts => _products
      .map(_asMap)
      .where((p) =>
          p['is_active'] == true &&
          wsS(p['category']) == '包材' &&
          (wsS(p['name']).contains('箱') || wsS(p['name']).contains('纸')))
      .toList();

  Map<String, dynamic>? _productById(int? id) {
    if (id == null) return null;
    for (final p in _products.map(_asMap)) {
      if (wsI(p['id']) == id) return p;
    }
    return null;
  }

  String _stockUnit(Map<String, dynamic> m) {
    final du = wsS(m['default_unit']);
    return du.isEmpty ? wsS(m['base_unit']) : du;
  }

  // -------------------------------------------------- 列表展示文本

  String _itemsText(Map<String, dynamic> rule) {
    final parts = <String>[];
    for (final e in (rule['items'] as List?) ?? const []) {
      final it = _asMap(e);
      final linked = _productById(it['product_id'] == null ? null : wsI(it['product_id']));
      final name = linked != null ? wsS(linked['name']) : wsS(it['name']);
      final q = wsD(it['quantity'], fallback: 1);
      var label = q != 1 ? '$name×${_qty(q)}' : name;
      final sid = it['stock_product_id'] == null ? null : wsI(it['stock_product_id']);
      if (sid != null) {
        final sp = _productById(sid);
        final mult = wsD(it['multiplier'], fallback: 1);
        label += '（扣${sp != null ? wsS(sp['name']) : '?'}×${_qty(mult)}）';
      }
      parts.add(label);
    }
    return parts.isEmpty ? '—' : parts.join('、');
  }

  List<({String name, double qty, int? pid})> _boxesOf(Map<String, dynamic> rule) {
    final boxItems = (rule['box_items'] as List?) ?? const [];
    if (boxItems.isNotEmpty) {
      return [
        for (final e in boxItems)
          (() {
            final bx = _asMap(e);
            final pid = bx['product_id'] == null ? null : wsI(bx['product_id']);
            final linked = _productById(pid);
            final name = linked != null ? wsS(linked['name']) : wsS(bx['name'], fallback: '—');
            return (name: name, qty: wsD(bx['quantity'], fallback: 1), pid: pid);
          })(),
      ];
    }
    return [
      for (final p in _boxTypeToItems(wsS(rule['box_type']))) (name: p.name, qty: p.qty, pid: null),
    ];
  }

  String _boxText(Map<String, dynamic> rule) {
    final boxes = _boxesOf(rule);
    if (boxes.isEmpty) return '—';
    return boxes.map((b) => b.qty != 1 ? '${b.name}×${_qty(b.qty)}' : b.name).join('、');
  }

  // -------------------------------------------------- 过滤 + 统计

  List<Map<String, dynamic>> _visibleRules() {
    final kw = _searchCtrl.text.trim().toLowerCase();
    final rows = _rules.map(_asMap).where((r) {
      final matchKw = kw.isEmpty ||
          wsS(r['name']).toLowerCase().contains(kw) ||
          _itemsText(r).toLowerCase().contains(kw) ||
          wsS(r['box_type']).toLowerCase().contains(kw) ||
          _boxText(r).toLowerCase().contains(kw);
      final matchBox = _boxFilter.isEmpty || wsS(r['box_type']) == _boxFilter;
      return matchKw && matchBox;
    }).toList();

    int cmp(Map<String, dynamic> a, Map<String, dynamic> b) {
      final int res;
      switch (_sortKey) {
        case 'box_type':
          res = wsS(a['box_type']).compareTo(wsS(b['box_type']));
        case 'labor':
          res = wsD(a['labor_price']).compareTo(wsD(b['labor_price']));
        default:
          res = wsS(a['name']).compareTo(wsS(b['name']));
      }
      return _sortAsc ? res : -res;
    }

    rows.sort(cmp);
    return rows;
  }

  List<String> _distinctBoxTypes() {
    final set = <String>{};
    for (final r in _rules.map(_asMap)) {
      final bt = wsS(r['box_type']);
      if (bt.isNotEmpty) set.add(bt);
    }
    final list = set.toList()..sort();
    return list;
  }

  int _activeCount() => _rules.map(_asMap).where((r) => r['is_active'] == true).length;

  int _boxKindCount() {
    final set = <String>{};
    for (final r in _rules.map(_asMap)) {
      for (final b in _boxesOf(r)) {
        set.add(b.pid != null ? 'p${b.pid}' : b.name);
      }
    }
    return set.length;
  }

  // -------------------------------------------------- 增 / 改 / 删

  Future<void> _openEditor([dynamic rule]) async {
    final draft = _PackRuleDraft(
      rec: rule == null ? null : _asMap(rule),
      orderProducts: _orderProducts,
      stockProducts: _stockProducts,
      boxProducts: _boxProducts,
    );
    final saved = await desktopDialog<bool>(
      context,
      title: draft.isEdit ? '编辑一单多货规则' : '新增一单多货规则',
      width: 920,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => _editorBody(dialogContext, draft, setDialogState),
      ),
    );
    draft.dispose();
    if (saved == true) await _load();
  }

  Widget _editorBody(BuildContext dialogContext, _PackRuleDraft draft, StateSetter setDialogState) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DesktopNotice(
          draft.isEdit ? '规则名「${wsS(draft.rec!['name'])}」由后端按真实商品名与数量自动生成。' : '保存后规则名由后端按真实商品名与数量自动生成。',
          kind: DesktopNoticeKind.info,
        ),
        const Text('组合商品（一张订单同时含以下多种商品时按此规则打包）',
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        for (final row in draft.items) _itemRow(row, draft, setDialogState),
        DesktopLink('＋ 添加组合商品', onPressed: () => setDialogState(() => draft.items.add(_ItemRow()))),
        const SizedBox(height: 14),
        const Text('纸箱型号（关联包材纸箱，仅可选名称含「箱 / 纸」的包材）',
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        for (final row in draft.boxes) _boxRow(row, draft, setDialogState),
        DesktopLink('＋ 添加箱型', onPressed: () => setDialogState(() => draft.boxes.add(_BoxRow()))),
        const SizedBox(height: 14),
        const Divider(height: 1),
        const SizedBox(height: 14),
        DesktopFormRow(
          label: '工人单价',
          width: 160,
          tip: '元 / 单，留空表示不按单计人工',
          child: DesktopTextField(
            controller: draft.laborCtrl,
            width: 160,
            keyboardType: _kNum,
            inputFormatters: DesktopTextField.decimalOnly,
            hintText: '可空',
          ),
        ),
        DesktopFormRow(
          label: '箱单比',
          width: 160,
          tip: '一单折算多少箱（默认 1）',
          child: DesktopTextField(
            controller: draft.ratioCtrl,
            width: 160,
            keyboardType: _kNum,
            inputFormatters: DesktopTextField.decimalOnly,
          ),
        ),
        DesktopFormRow(
          label: '备注',
          width: 460,
          child: DesktopTextField(controller: draft.remarkCtrl, width: 460, hintText: '可选'),
        ),
        DesktopFormRow(
          label: '启用',
          width: 160,
          tip: '停用后出库不再自动匹配这一单多货组合',
          child: Align(
            alignment: Alignment.centerLeft,
            child: Switch(
              value: draft.active,
              onChanged: (v) => setDialogState(() => draft.active = v),
            ),
          ),
        ),
        const SizedBox(height: 4),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            DesktopButton(label: '取消', onPressed: () => Navigator.of(dialogContext).pop(false)),
            const SizedBox(width: 10),
            DesktopButton(
              label: '保存',
              kind: DesktopButtonKind.primary,
              onPressed: () => _submit(dialogContext, draft),
            ),
          ],
        ),
      ],
    );
  }

  Widget _itemRow(_ItemRow row, _PackRuleDraft draft, StateSetter setDialogState) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          DesktopSearchField(
            title: '选择订单商品',
            hint: '订单商品…',
            width: 200,
            value: row.productId == null ? null : '${row.productId}',
            options: [for (final p in draft.orderProducts) DesktopOption<String>('${wsI(p['id'])}', wsS(p['name']))],
            onChanged: (v) {
              final id = (v == null || v.isEmpty) ? null : int.tryParse(v);
              setDialogState(() => row.pickProduct(id, _nameById(draft.orderProducts, id)));
            },
          ),
          DesktopTextField(controller: row.nameCtrl, width: 180, hintText: '商品名称（未关联时原文）'),
          DesktopTextField(
            controller: row.qtyCtrl,
            width: 80,
            hintText: '数量',
            textAlign: TextAlign.center,
            keyboardType: _kNum,
            inputFormatters: DesktopTextField.decimalOnly,
          ),
          DesktopSearchField(
            title: '扣减库存商品（可选）',
            hint: '扣减库存大类…',
            width: 190,
            value: row.stockProductId == null ? null : '${row.stockProductId}',
            options: [
              for (final p in draft.stockProducts)
                DesktopOption<String>('${wsI(p['id'])}', '${wsS(p['name'])}（${wsS(p['category'], fallback: '—')}·${_stockUnit(p)}）'),
            ],
            onChanged: (v) => setDialogState(() => row.stockProductId = (v == null || v.isEmpty) ? null : int.tryParse(v)),
          ),
          DesktopTextField(
            controller: row.multCtrl,
            width: 80,
            hintText: '倍数',
            textAlign: TextAlign.center,
            keyboardType: _kNum,
            inputFormatters: DesktopTextField.decimalOnly,
          ),
          DesktopLink('删', color: WsTokens.red, onPressed: () => setDialogState(() => draft.items.remove(row))),
        ],
      ),
    );
  }

  Widget _boxRow(_BoxRow row, _PackRuleDraft draft, StateSetter setDialogState) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          DesktopSearchField(
            title: '选择纸箱（包材）',
            hint: '包材纸箱…',
            width: 220,
            value: row.productId == null ? null : '${row.productId}',
            options: [for (final p in draft.boxProducts) DesktopOption<String>('${wsI(p['id'])}', wsS(p['name']))],
            onChanged: (v) {
              final id = (v == null || v.isEmpty) ? null : int.tryParse(v);
              // 关联包材时把型号名剥掉前缀（照 prBoxLinked / prModelOf）
              final nm = id == null ? null : _prModelOf(_nameById(draft.boxProducts, id) ?? '');
              setDialogState(() => row.pick(id, nm));
            },
          ),
          DesktopTextField(controller: row.nameCtrl, width: 170, hintText: '箱型号，如 3号 / 邮政6号'),
          DesktopTextField(
            controller: row.qtyCtrl,
            width: 100,
            hintText: '每单数量',
            textAlign: TextAlign.center,
            keyboardType: _kNum,
            inputFormatters: DesktopTextField.decimalOnly,
          ),
          DesktopLink('删', color: WsTokens.red, onPressed: () => setDialogState(() => draft.boxes.remove(row))),
        ],
      ),
    );
  }

  String? _nameById(List<Map<String, dynamic>> list, int? id) {
    if (id == null) return null;
    for (final p in list) {
      if (wsI(p['id']) == id) return wsS(p['name']);
    }
    return null;
  }

  Future<void> _submit(BuildContext dialogContext, _PackRuleDraft draft) async {
    final message = draft.validate();
    if (message != null) {
      wsToast(dialogContext, message, error: true);
      return;
    }
    final body = draft.body();
    final navigator = Navigator.of(dialogContext);
    try {
      if (draft.editId != null) {
        await ApiService.updatePackRule(draft.editId!, body);
      } else {
        await ApiService.createPackRule(body);
      }
      navigator.pop(true);
    } on ApiException catch (e) {
      if (!dialogContext.mounted) return;
      wsToast(dialogContext, e.message, error: true);
    }
  }

  Future<void> _delete(Map<String, dynamic> rule) async {
    final id = wsI(rule['id']);
    final name = wsS(rule['name']);
    final ok = await wsConfirm(
      context,
      title: '删除打包规则',
      message: '确定删除「$name」？已生成的出库单不受影响。',
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      await ApiService.deletePackRule(id);
      if (!mounted) return;
      setState(() => _expanded.remove(id));
      wsToast(context, '已删除「$name」');
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, e.message, error: true);
    }
  }

  // -------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    final rows = _visibleRules();
    final boxes = _distinctBoxTypes();
    return DesktopPage(
      title: '一单多货（多货打包规则）',
      subtitle: '区别于「关联结算 / 人工」的一单一货；此处维护一张订单含多种商品时的合并打包规则（纸箱 + 人工）。',
      actions: [
        DesktopButton(label: '刷新', icon: Icons.refresh, onPressed: _loading ? null : _load),
        DesktopButton(
          label: '新增一单多货规则',
          icon: Icons.add,
          kind: DesktopButtonKind.primary,
          onPressed: _loading ? null : () => _openEditor(),
        ),
      ],
      body: DesktopStateView(
        loading: _loading,
        error: _error,
        onRetry: _load,
        loadingText: '加载打包规则…',
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            DesktopRise(
              index: 0,
              child: DesktopStatGrid(
                children: [
                  DesktopStatCard(label: '规则数', value: '${_rules.length}', sub: '全部一单多货组合'),
                  DesktopStatCard(
                      label: '启用数', value: '${_activeCount()}', sub: '停用不参与出库匹配', color: WsTokens.green),
                  DesktopStatCard(
                      label: '涉及包材种类', value: '${_boxKindCount()}', sub: '去重后的纸箱型号数', color: WsTokens.primary),
                ],
              ),
            ),
            DesktopRise(
              index: 1,
              child: WsCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    DesktopFilterBar(
                      right: Text('共 ${rows.length} 条',
                          style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                      children: [
                        DesktopSearchFieldLike(
                          controller: _searchCtrl,
                          width: 260,
                          onChanged: (_) => setState(() {}),
                        ),
                        DesktopLabeled(
                          label: '纸箱型号',
                          child: DesktopSelect<String>(
                            width: 180,
                            value: _boxFilter,
                            options: [
                              const DesktopOption('', '全部纸箱型号'),
                              for (final b in boxes) DesktopOption(b, b),
                            ],
                            onChanged: (v) => setState(() => _boxFilter = v ?? ''),
                          ),
                        ),
                      ],
                    ),
                    DesktopGrid(
                      cols: _kCols,
                      sortKey: _sortKey,
                      sortAsc: _sortAsc,
                      onSort: (k) => setState(() {
                        if (_sortKey == k) {
                          _sortAsc = !_sortAsc;
                        } else {
                          _sortKey = k;
                          _sortAsc = true;
                        }
                      }),
                      emptyText: '暂无一单多货规则，点「新增一单多货规则」配置一组订单商品的打包方式',
                      rows: [
                        for (final r in rows)
                          DesktopRow(
                            onTap: () => setState(() {
                              final id = wsI(r['id']);
                              if (_expanded.contains(id)) {
                                _expanded.remove(id);
                              } else {
                                _expanded.add(id);
                              }
                            }),
                            cells: [
                              wsCell(wsS(r['name']), bold: true, tip: wsS(r['name'])),
                              wsCell(_itemsText(r), tip: _itemsText(r)),
                              wsCell(_boxText(r), tip: _boxText(r)),
                              wsCell(wsS(r['box_type'], fallback: '—')),
                              wsCell(r['labor_price'] == null ? '—' : wsMoney(wsD(r['labor_price']))),
                              wsCell(_qty(wsD(r['box_ratio'], fallback: 1))),
                              DefaultTextStyle(
                                style: const TextStyle(),
                                child: DesktopTag(wsS(r['is_active']) == 'false' ? '停用' : '启用',
                                    color: r['is_active'] == true ? DesktopTag.paid : DesktopTag.off),
                              ),
                              wsCell(wsS(r['remark'], fallback: '—'), tip: wsS(r['remark'])),
                              Row(
                                children: [
                                  DesktopLink('编辑', onPressed: () => _openEditor(r)),
                                  DesktopLink('删除', color: WsTokens.red, onPressed: () => _delete(r)),
                                ],
                              ),
                            ],
                          ),
                      ],
                    ),
                    for (final r in rows.where((r) => _expanded.contains(wsI(r['id'])))) _detailCard(r),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _detailCard(Map<String, dynamic> rule) {
    final boxes = _boxesOf(rule);
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      decoration: BoxDecoration(
        color: WsTokens.primaryLight.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: WsTokens.primary.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('展开明细 · ${wsS(rule['name'])}',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text('组合商品：${_itemsText(rule)}', style: const TextStyle(fontSize: 12.5, height: 1.6)),
          Text(
            '纸箱清单：${boxes.isEmpty ? '—' : boxes.map((b) {
                  final tag = b.pid != null ? '已关联包材' : '未关联';
                  return b.qty != 1 ? '${b.name}×${_qty(b.qty)}（$tag）' : '${b.name}（$tag）';
                }).join('、')}',
            style: const TextStyle(fontSize: 12.5, height: 1.6),
          ),
          if (wsS(rule['remark']).isNotEmpty)
            Text('备注：${wsS(rule['remark'])}', style: const TextStyle(fontSize: 12.5, height: 1.6)),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- 表单草稿 / 行模型

/// 组合商品行：product_id 可空（手填名称），stock_product_id 为出库扣减目标（库存大类）。
class _ItemRow {
  _ItemRow({this.productId, this.stockProductId, String name = '', String quantity = '1', String multiplier = '1'})
      : nameCtrl = TextEditingController(text: name),
        qtyCtrl = TextEditingController(text: quantity),
        multCtrl = TextEditingController(text: multiplier);

  final TextEditingController nameCtrl;
  final TextEditingController qtyCtrl;
  final TextEditingController multCtrl;
  int? productId;
  int? stockProductId;

  /// 关联订单商品时以真实商品名覆盖手填名称
  void pickProduct(int? id, String? name) {
    productId = id;
    if (id != null && name != null && name.isNotEmpty) nameCtrl.text = name;
  }

  void dispose() {
    nameCtrl.dispose();
    qtyCtrl.dispose();
    multCtrl.dispose();
  }
}

/// 纸箱行（包材纸箱）：product_id 可空（自定义箱型号）。
class _BoxRow {
  _BoxRow({this.productId, String name = '', String quantity = '1'})
      : nameCtrl = TextEditingController(text: name),
        qtyCtrl = TextEditingController(text: quantity);

  final TextEditingController nameCtrl;
  final TextEditingController qtyCtrl;
  int? productId;

  /// 关联包材时把型号名设为剥前缀后的名称；清空关联则保留原文
  void pick(int? id, String? model) {
    productId = id;
    if (id != null && model != null && model.isNotEmpty) nameCtrl.text = model;
  }

  void dispose() {
    nameCtrl.dispose();
    qtyCtrl.dispose();
  }
}

/// 打包规则草稿：字段 = 后端 PackRuleIn；校验文案沿用 web / 移动端。
class _PackRuleDraft {
  _PackRuleDraft({
    this.rec,
    required this.orderProducts,
    required this.stockProducts,
    required this.boxProducts,
  }) {
    final old = rec;
    if (old == null) {
      items.add(_ItemRow());
      return;
    }
    for (final e in (old['items'] as List?) ?? const []) {
      final it = _asMap(e);
      items.add(_ItemRow(
        productId: it['product_id'] == null ? null : wsI(it['product_id']),
        stockProductId: it['stock_product_id'] == null ? null : wsI(it['stock_product_id']),
        name: wsS(it['name']),
        quantity: it['quantity'] == null ? '1' : _qty(wsD(it['quantity'], fallback: 1)),
        multiplier: it['multiplier'] == null ? '1' : _qty(wsD(it['multiplier'], fallback: 1)),
      ));
    }
    if (items.isEmpty) items.add(_ItemRow());

    final boxItems = (old['box_items'] as List?) ?? const [];
    if (boxItems.isNotEmpty) {
      for (final e in boxItems) {
        final bx = _asMap(e);
        boxes.add(_BoxRow(
          productId: bx['product_id'] == null ? null : wsI(bx['product_id']),
          name: wsS(bx['name']),
          quantity: bx['quantity'] == null ? '1' : _qty(wsD(bx['quantity'], fallback: 1)),
        ));
      }
    } else {
      // 旧数据：把 box_type（形如 7号*2+8号）解析成行
      for (final p in _boxTypeToItems(wsS(old['box_type']))) {
        boxes.add(_BoxRow(name: p.name, quantity: _qty(p.qty)));
      }
    }

    laborCtrl.text = old['labor_price'] == null ? '' : _qty(wsD(old['labor_price']));
    ratioCtrl.text = _qty(wsD(old['box_ratio'], fallback: 1));
    remarkCtrl.text = wsS(old['remark']);
    active = (old['is_active'] as bool?) ?? true;
  }

  final Map<String, dynamic>? rec;
  final List<Map<String, dynamic>> orderProducts;
  final List<Map<String, dynamic>> stockProducts;
  final List<Map<String, dynamic>> boxProducts;

  final List<_ItemRow> items = <_ItemRow>[];
  final List<_BoxRow> boxes = <_BoxRow>[];
  final TextEditingController laborCtrl = TextEditingController();
  final TextEditingController ratioCtrl = TextEditingController(text: '1');
  final TextEditingController remarkCtrl = TextEditingController();
  bool active = true;

  bool get isEdit => rec != null;
  int? get editId => rec == null ? null : wsI(rec!['id']);

  String? validate() {
    final names = <String>[];
    for (final row in items) {
      final name = row.nameCtrl.text.trim();
      if (name.isEmpty) continue;
      names.add(name);
      final qty = double.tryParse(row.qtyCtrl.text.trim());
      if (qty == null || qty <= 0) return '商品「$name」的数量必须大于 0';
      final multText = row.multCtrl.text.trim();
      final mult = multText.isEmpty ? 1 : (double.tryParse(multText) ?? 0);
      if (mult <= 0) return '商品「$name」的扣减倍数必须大于 0';
    }
    if (names.isEmpty) return '至少需要一条组合商品';

    for (final row in boxes) {
      final name = row.nameCtrl.text.trim();
      if (name.isEmpty) continue;
      final qtyText = row.qtyCtrl.text.trim();
      final qty = qtyText.isEmpty ? 1 : (double.tryParse(qtyText) ?? 0);
      if (qty <= 0) return '纸箱「$name」的数量必须大于 0';
    }

    final laborText = laborCtrl.text.trim();
    if (laborText.isNotEmpty) {
      final labor = double.tryParse(laborText);
      if (labor == null || labor < 0) return '工人单价请填写不小于 0 的数字（留空表示不按单计人工）';
    }
    final ratioText = ratioCtrl.text.trim();
    if (ratioText.isNotEmpty) {
      final r = double.tryParse(ratioText);
      if (r == null || r <= 0) return '箱单比需为大于 0 的数字';
    }
    return null;
  }

  Map<String, dynamic> body() {
    // 不带 name：组合名由后端 _gen_name 按真实商品名 + 数量生成
    return <String, dynamic>{
      'items': [
        for (final row in items)
          if (row.nameCtrl.text.trim().isNotEmpty)
            <String, dynamic>{
              'product_id': row.productId,
              'name': row.nameCtrl.text.trim(),
              'quantity': double.tryParse(row.qtyCtrl.text.trim()) ?? 1,
              'stock_product_id': row.stockProductId,
              'multiplier': double.tryParse(row.multCtrl.text.trim()) ?? 1,
            },
      ],
      'box_items': [
        for (final row in boxes)
          if (row.nameCtrl.text.trim().isNotEmpty)
            <String, dynamic>{
              'product_id': row.productId,
              'name': row.nameCtrl.text.trim(),
              'quantity': double.tryParse(row.qtyCtrl.text.trim()) ?? 1,
            },
      ],
      'labor_price': laborCtrl.text.trim().isEmpty ? null : double.tryParse(laborCtrl.text.trim()),
      'box_ratio': double.tryParse(ratioCtrl.text.trim()) ?? 1,
      'remark': remarkCtrl.text.trim(),
      'is_active': active,
    };
  }

  void dispose() {
    for (final row in items) {
      row.dispose();
    }
    for (final row in boxes) {
      row.dispose();
    }
    laborCtrl.dispose();
    ratioCtrl.dispose();
    remarkCtrl.dispose();
  }
}

/// 列表关键字搜索框（复用 DesktopTextField，仅包一层方便筛选栏排版）。
class DesktopSearchFieldLike extends StatelessWidget {
  const DesktopSearchFieldLike({super.key, required this.controller, required this.onChanged, this.width});
  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final double? width;

  @override
  Widget build(BuildContext context) {
    return DesktopTextField(
      controller: controller,
      width: width,
      hintText: '🔍 搜索组合 / 商品 / 纸箱…',
      onChanged: onChanged,
    );
  }
}
