import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';

/// 桌面端「入仓」页：1:1 复刻 web `#page-warehouse-in`（入仓品资料 + 入仓记录）
/// 与二级页 `#page-wingroup`（导入批次折叠明细）两块内容。
///
/// 三个子页：
/// 1. 入仓记录 —— 日期区间 / 关键字筛选、统计卡、明细表（同 import_group 折叠成批次行，
///    点开看组内明细）、按入仓品汇总、手动入仓、Excel 贴单导入、批量删除、标记已付；
/// 2. 入仓品资料 —— ProductIn 全字段，含「随货包材（关联结算）」动态行；
/// 3. 成本口径说明 —— 把后端 warehouse_in.py 的公式写清楚，方便对账。
///
/// 口径全部以 `backend/app/routers/warehouse_in.py` 为准：页面里的收入 / 成本 / 毛利
/// 只是弹窗预估，落库时一律由后端重算。
class DesktopWarehouseInScreen extends StatefulWidget {
  const DesktopWarehouseInScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopWarehouseInScreen> createState() => _DesktopWarehouseInScreenState();
}

// ---------------------------------------------------------------- 表格列定义

/// 入仓明细列（照后端 _in_dict 字段；列多，DesktopGrid 自带横向滚动）
const List<DesktopCol> _kInCols = [
  DesktopCol('', width: 44, center: true),
  DesktopCol('单号/批次', width: 156, sortKey: 'code'),
  DesktopCol('日期', width: 116, sortKey: 'date'),
  DesktopCol('商品', width: 210, sortKey: 'product'),
  DesktopCol('分类', width: 110),
  DesktopCol('单位', width: 60, center: true),
  DesktopCol('数量', width: 84, right: true, sortKey: 'quantity'),
  DesktopCol('采购单价', width: 92, right: true, sortKey: 'unit_price', tip: '采购价（元/袋，收入单价）'),
  DesktopCol('扣点', width: 72, right: true, tip: '收入 = 数量 × 采购单价 ×（1 − 入仓扣点%）'),
  DesktopCol('收入', width: 104, right: true, sortKey: 'amount'),
  DesktopCol('每袋净重', width: 92, right: true, tip: 'bag_weight：每袋数量（按关联库存商品的默认单位）'),
  DesktopCol('单位成本', width: 92, right: true, tip: '库存单位成本（均价优先，无库存回退参考成本）'),
  DesktopCol('每袋成本', width: 92, right: true, tip: '关联库存 = 每袋净重 × 单位成本；代发 = 手填代发成本'),
  DesktopCol('商品成本', width: 104, right: true, sortKey: 'cogs'),
  DesktopCol('运费单价', width: 92, right: true, tip: 'freight（元/袋）'),
  DesktopCol('运费合计', width: 104, right: true, sortKey: 'freight'),
  DesktopCol('包材成本', width: 104, right: true, sortKey: 'pack_cost', tip: '随货包材：每袋用量 × 袋数，按 FIFO 结转'),
  DesktopCol('毛利', width: 104, right: true, sortKey: 'profit'),
  DesktopCol('毛利率', width: 84, right: true, sortKey: 'profit_rate'),
  DesktopCol('采购单号', width: 150, sortKey: 'purchase_no'),
  DesktopCol('中心', width: 120, sortKey: 'center'),
  DesktopCol('箱数', width: 70, right: true),
  DesktopCol('箱规', width: 76, right: true),
  DesktopCol('操作员', width: 96),
  DesktopCol('付款', width: 88, center: true),
  DesktopCol('备注', width: 150),
  DesktopCol('操作', width: 168),
];

/// 按入仓品汇总列（后端 by_product）
const List<DesktopCol> _kByProdCols = [
  DesktopCol('商品', width: 220, sortKey: 'product_name'),
  DesktopCol('SKU', width: 130),
  DesktopCol('分类', width: 120),
  DesktopCol('单位', width: 60, center: true),
  DesktopCol('记录数', width: 80, right: true, sortKey: 'records'),
  DesktopCol('数量', width: 100, right: true, sortKey: 'quantity'),
  DesktopCol('收入', width: 120, right: true, sortKey: 'amount'),
  DesktopCol('商品成本', width: 110, right: true, sortKey: 'cogs'),
  DesktopCol('运费', width: 100, right: true, sortKey: 'freight_total'),
  DesktopCol('包材成本', width: 100, right: true, sortKey: 'pack_cost'),
  DesktopCol('毛利', width: 110, right: true, sortKey: 'profit'),
  DesktopCol('毛利率', width: 90, right: true, sortKey: 'profit_rate'),
  DesktopCol('每袋收入', width: 92, right: true),
  DesktopCol('每袋毛利', width: 92, right: true),
  DesktopCol('最近日期', width: 110),
];

/// 入仓品资料列（后端 _product_dict）
const List<DesktopCol> _kWprodCols = [
  DesktopCol('名称', width: 200),
  DesktopCol('分类', width: 120),
  DesktopCol('SKU', width: 130),
  DesktopCol('条码', width: 140),
  DesktopCol('箱规', width: 80, right: true),
  DesktopCol('采购价', width: 96, right: true, tip: '元/袋，即给「我」的收入单价'),
  DesktopCol('运费', width: 90, right: true, tip: '元/袋'),
  DesktopCol('每袋净重', width: 120, right: true, tip: '重量统计口径（值 + 单位）'),
  DesktopCol('每袋数量', width: 100, right: true, tip: '成本口径：每袋含几个关联库存商品的默认单位'),
  DesktopCol('每袋成本', width: 100, right: true),
  DesktopCol('代发成本', width: 100, right: true),
  DesktopCol('关联库存商品', width: 190),
  DesktopCol('单位成本', width: 110, right: true),
  DesktopCol('随货包材', width: 220),
  DesktopCol('保质期', width: 90),
  DesktopCol('状态', width: 80, center: true),
  DesktopCol('备注', width: 150),
  DesktopCol('操作', width: 158),
];

/// 贴单导入预览列
const List<DesktopCol> _kImportCols = [
  DesktopCol('', width: 44, center: true),
  DesktopCol('行', width: 52, right: true),
  DesktopCol('贴单商品名称', width: 180),
  DesktopCol('入仓品', width: 176),
  DesktopCol('采购单号', width: 140),
  DesktopCol('中心', width: 110),
  DesktopCol('箱数', width: 74),
  DesktopCol('数量(袋)', width: 84),
  DesktopCol('每袋净重', width: 84),
  DesktopCol('采购价', width: 84),
  DesktopCol('运费', width: 78),
  DesktopCol('日期', width: 124),
  DesktopCol('商品成本', width: 100, right: true),
  DesktopCol('包材成本', width: 100, right: true),
  DesktopCol('收入', width: 104, right: true),
  DesktopCol('毛利', width: 104, right: true),
];

/// 每袋净重可选单位（与后端 NET_WEIGHT_UNITS 同源）
const Map<String, double> _kUnitGrams = {'克': 1, 'g': 1, '两': 50, '斤': 500, '公斤': 1000, '千克': 1000, 'kg': 1000};
const List<String> _kWeightUnits = ['克', 'g', '两', '斤', '公斤', '千克', 'kg'];

/// 数字输入（金额/数量一律允许小数）
const TextInputType _kNum = TextInputType.numberWithOptions(decimal: true);

// ---------------------------------------------------------------- 小工具

/// 数字显示：整数不带小数点
String _n(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : '$v';

/// 输入框文本：0 显示空
String _numText(double v) => v == 0 ? '' : _n(v);

/// 金额为 0 显示「—」，与网页端一致
String _dashMoney(double v) => v == 0 ? '—' : wsMoney(v);

Color? _profitColor(double v) => v == 0 ? null : (v >= 0 ? WsTokens.green : WsTokens.red);

String _pct(double percent) => '${percent.toStringAsFixed(2)}%';

Map<String, dynamic> _asMap(dynamic v) => (v as Map).cast<String, dynamic>();

double _parse(TextEditingController c) => wsD(double.tryParse(c.text));

// ---------------------------------------------------------------- 主 State

class _DesktopWarehouseInScreenState extends State<DesktopWarehouseInScreen> {
  int _tab = 0;

  // 筛选：默认今天（网页端进入时默认本月，这里保留「本月」快捷按钮）
  String _dateFrom = wsToday();
  String _dateTo = wsToday();
  final TextEditingController _qCtrl = TextEditingController();

  // 入仓记录
  List<dynamic> _items = [];
  List<dynamic> _byProduct = [];
  Map<String, dynamic> _total = {};
  int _count = 0;
  bool _insLoading = false;
  String? _insError;
  bool _viewByProduct = false;
  String? _sortKey;
  bool _sortAsc = false;
  final Set<int> _sel = {};
  final Set<String> _openGroups = {};

  // 入仓品资料 / 库存商品 / 扣点
  List<dynamic> _wproducts = [];
  bool _prodLoading = false;
  String? _prodError;
  List<dynamic> _sproducts = [];
  bool _stockLoaded = false;
  double _deduction = 0;
  String _autoSheet = '常温贴单';

  @override
  void initState() {
    super.initState();
    _loadAll();
  }

  @override
  void dispose() {
    _qCtrl.dispose();
    super.dispose();
  }

  // ---------------- 数据加载 ----------------

  Future<void> _loadAll() async {
    await _loadDeduction();
    await _loadIns();
    await _loadWProducts();
  }

  /// 扣点 + 本分仓默认贴单表（奥斯迪/昆明蔬菜仓=常温贴单，wh02=冷冻贴单）
  Future<void> _loadDeduction() async {
    try {
      final d = await ApiService.warehouseDeduction();
      if (!mounted) return;
      setState(() {
        _deduction = wsD(d['percent']);
        _autoSheet = wsS(d['sheet'], fallback: '常温贴单');
      });
    } on ApiException catch (e) {
      if (mounted) wsToast(context, e.message, error: true);
    }
  }

  Future<void> _loadIns() async {
    setState(() => _insLoading = true);
    try {
      final d = await ApiService.warehouseIns(dateFrom: _dateFrom, dateTo: _dateTo, q: _qCtrl.text.trim());
      if (!mounted) return;
      final items = (d['items'] as List?) ?? const [];
      setState(() {
        _items = items;
        _byProduct = (d['by_product'] as List?) ?? const [];
        _total = (d['total'] as Map?)?.cast<String, dynamic>() ?? const {};
        _count = wsI(d['count']);
        _insError = null;
        _insLoading = false;
        _sel.removeWhere((id) => items.any((raw) => wsI(_asMap(raw)['id']) == id));
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _insError = e.message;
        _insLoading = false;
      });
      wsToast(context, '加载入仓记录失败：${e.message}', error: true);
    }
  }

  Future<void> _loadWProducts() async {
    setState(() => _prodLoading = true);
    try {
      final rows = await ApiService.warehouseProducts();
      if (!mounted) return;
      setState(() {
        _wproducts = rows;
        _prodError = null;
        _prodLoading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _prodError = e.message;
        _prodLoading = false;
      });
      wsToast(context, '加载入仓品失败：${e.message}', error: true);
    }
  }

  /// 库存商品（含 conversions / avg_cost）：入仓品表单「关联库存商品」「随货包材」的数据源
  Future<void> _ensureStockProducts() async {
    if (_stockLoaded) return;
    try {
      final rows = await ApiService.products();
      _sproducts = rows;
      _stockLoaded = true;
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '加载商品失败：${e.message}', error: true);
    }
  }

  List<Map<String, dynamic>> get _stockMaps => [for (final raw in _sproducts) _asMap(raw)];

  Map<String, dynamic>? _byId(List<dynamic> source, int? id) {
    if (id == null) return null;
    for (final raw in source) {
      final m = _asMap(raw);
      if (wsI(m['id']) == id) return m;
    }
    return null;
  }

  Map<String, dynamic>? _wproductById(int? id) => _byId(_wproducts, id);

  Map<String, dynamic>? _stockById(int? id) => _byId(_sproducts, id);

  /// 可作成本来源的库存大类商品（与网页端 stockProductOptions 同过滤条件）
  List<Map<String, dynamic>> _stockCandidates() => [
        for (final p in _stockMaps)
          if (p['is_active'] == true && wsS(p['product_type']) == 'stock' && wsS(p['category']) != '人工' && wsS(p['category']) != '快递') p,
      ];

  // ---------------- 前端预估口径（与后端一致，只用于弹窗提示） ----------------

  /// 每袋商品成本：关联库存 = 每袋净重 × 库存单位成本；未关联（代发）= 手填代发成本
  double _bagCostOf(Map<String, dynamic>? p, double bagWeight) {
    if (p == null) return 0;
    if (wsI(p['stock_product_id']) == 0) return wsD(p['dropship_cost']);
    return bagWeight * wsD(p['stock_unit_cost']);
  }

  /// 随货包材预估：每袋用量 × 袋数 ×（单位→基础单位系数）× 库存均价（回退参考成本）
  double _packCostOf(Map<String, dynamic>? p, double qty) {
    if (p == null) return 0;
    double cost = 0;
    for (final raw in (p['pack_items'] as List?) ?? const []) {
      final it = _asMap(raw);
      final m = _stockById(wsI(it['product_id'], fallback: -1));
      if (m == null) continue;
      final factor = wsD((m['conversions'] as Map?)?[wsS(it['unit'])], fallback: 1);
      final base = wsD(m['avg_cost']) > 0 ? wsD(m['avg_cost']) : wsD(m['unit_cost']);
      cost += wsD(it['quantity']) * qty * factor * base;
    }
    return cost;
  }

  String _packTextOf(Map<String, dynamic>? p) {
    final list = (p?['pack_items'] as List?) ?? const [];
    if (list.isEmpty) return '—';
    return [
      for (final raw in list)
        _asMap(raw),
    ].map((it) => '${wsS(it['name'], fallback: '?')}×${_n(wsD(it['quantity']))}${wsS(it['unit'])}').join('、');
  }

  /// 库存商品的「默认单位成本」：均价优先，无库存回退参考成本
  double _stockUnitCost(Map<String, dynamic>? sp) {
    if (sp == null) return 0;
    final du = _stockDefaultUnit(sp);
    final factor = wsD((sp['conversions'] as Map?)?[du], fallback: 1);
    final base = wsD(sp['avg_cost']) > 0 ? wsD(sp['avg_cost']) : wsD(sp['unit_cost']);
    return base * factor;
  }

  String _stockDefaultUnit(Map<String, dynamic> sp) {
    final du = wsS(sp['default_unit']);
    return du.isEmpty ? wsS(sp['base_unit']) : du;
  }

  double _netKg(double value, String unit) => value * (_kUnitGrams[unit] ?? 0) / 1000;

  // ---------------- 子页 1：手动 / 编辑入仓 ----------------

  Future<void> _openInboundForm({Map<String, dynamic>? rec}) async {
    if (_wproducts.isEmpty) await _loadWProducts();
    if (!mounted) return;
    if (rec == null && _wproducts.isEmpty) {
      wsToast(context, '请先新增入仓品资料');
      return;
    }
    final draft = _InboundDraft(rec: rec, operator: widget.auth.displayName);
    final saved = await desktopDialog<bool>(
      context,
      title: draft.isEdit ? '编辑入仓记录' : '手动入仓',
      width: 760,
      maxHeight: 820,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) {
          final picked = _wproductById(draft.productId);
          final calc = _inboundCalc(draft, picked);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DesktopNotice(
                '收入 = 数量 × 采购单价 ×（1 − 入仓扣点%），当前入仓品扣点 ${_pct(_deduction)}；'
                '毛利 = 收入 − 商品成本 − 运费合计 − 随货包材成本。下面是预估，保存时由后端重算。',
              ),
              DesktopFormRow(
                label: '入仓品',
                width: 260,
                tip: '选择后自动带出名称 / 采购价 / 运费 / 箱规 / 每袋净重',
                child: DesktopSelect<int?>(
                  value: draft.productId,
                  width: 260,
                  options: [
                    const DesktopOption<int?>(null, '（不关联入仓品）'),
                    for (final raw in _wproducts)
                      DesktopOption<int?>(wsI(_asMap(raw)['id']), wsS(_asMap(raw)['name'])),
                  ],
                  onChanged: (v) => setDialogState(() => draft.pickProduct(v, _wproductById(v))),
                ),
              ),
              DesktopFormRow(
                label: '商品名称',
                required: true,
                width: 260,
                child: DesktopTextField(controller: draft.name, hintText: '选择入仓品后自动带出'),
              ),
              DesktopFormRow(label: '分类', width: 240, child: DesktopTextField(controller: draft.category, hintText: '如 半加工叶梅')),
              DesktopFormRow(label: '单位', width: 120, tip: '默认「袋」', child: DesktopTextField(controller: draft.unit, width: 120)),
              DesktopFormRow(
                label: '日期',
                required: true,
                width: 160,
                child: DesktopDateField(value: draft.date, allowClear: false, onChanged: (v) => setDialogState(() => draft.date = v)),
              ),
              DesktopFormRow(label: '采购单号', width: 220, child: DesktopTextField(controller: draft.purchaseNo)),
              DesktopFormRow(label: '配送中心', width: 220, child: DesktopTextField(controller: draft.center)),
              DesktopFormRow(
                label: '数量',
                required: true,
                width: 140,
                tip: '袋',
                child: DesktopTextField(controller: draft.quantity, width: 140, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly, onChanged: (_) => setDialogState(() {})),
              ),
              DesktopFormRow(
                label: '采购单价',
                width: 140,
                tip: '元/袋（收入单价）',
                child: DesktopTextField(controller: draft.unitPrice, width: 140, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly, onChanged: (_) => setDialogState(() {})),
              ),
              DesktopFormRow(
                label: '运费',
                width: 140,
                tip: '元/袋，可留空后续维护',
                child: DesktopTextField(controller: draft.freight, width: 140, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly, onChanged: (_) => setDialogState(() {})),
              ),
              DesktopFormRow(
                label: '每袋净重',
                width: 140,
                tip: '留空则用入仓品维护值',
                child: DesktopTextField(controller: draft.bagWeight, width: 140, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly, onChanged: (_) => setDialogState(() {})),
              ),
              DesktopFormRow(
                label: '箱数',
                width: 120,
                child: DesktopTextField(controller: draft.boxCount, width: 120, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly),
              ),
              DesktopFormRow(
                label: '箱规',
                width: 120,
                tip: '袋/箱',
                child: DesktopTextField(controller: draft.boxSpec, width: 120, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly),
              ),
              DesktopFormRow(
                label: '操作员',
                width: 200,
                tip: '固定取当前登录人',
                child: DesktopTextField(controller: draft.operatorCtrl, width: 200, readonly: true),
              ),
              DesktopFormRow(
                label: '付款状态',
                width: 240,
                tip: DesktopPayRadios.hint,
                child: DesktopPayRadios(value: draft.payStatus, onChanged: (v) => setDialogState(() => draft.payStatus = v)),
              ),
              DesktopFormRow(label: '备注', width: 420, child: DesktopTextField(controller: draft.remark, width: 420)),
              const SizedBox(height: 4),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  color: wsIsDark(context) ? WsTokens.bgDark : const Color(0xFFF7F9FC),
                  borderRadius: BorderRadius.circular(WsTokens.radius),
                  border: Border.all(color: wsIsDark(context) ? WsTokens.borderDark : WsTokens.borderLight),
                ),
                child: Wrap(
                  spacing: 18,
                  runSpacing: 8,
                  children: [
                    _kv('数量', '${_n(draft.quantityValue)} ${draft.unitValue}'),
                    _kv('收入', wsMoney(calc.revenue)),
                    _kv('每袋成本', wsMoney(calc.bagCost)),
                    _kv('商品成本', wsMoney(calc.cogs)),
                    _kv('运费合计', wsMoney(calc.freightTotal)),
                    _kv('随货包材', wsMoney(calc.packCost)),
                    _kvText('毛利', wsMoney(calc.profit), _profitColor(calc.profit)),
                    _kvText('毛利率', _pct(calc.profitRate), _profitColor(calc.profit)),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              DesktopNotice('成本来源：${_sourceText(picked)}；随货包材：${_packTextOf(picked)}'),
              const SizedBox(height: 6),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  DesktopButton(label: '取消', onPressed: () => Navigator.of(dialogContext).pop(false)),
                  const SizedBox(width: 10),
                  DesktopButton(
                    label: draft.isEdit ? '保存修改' : '确认入仓',
                    kind: DesktopButtonKind.primary,
                    onPressed: () async {
                      final navigator = Navigator.of(dialogContext);
                      final message = draft.validate();
                      if (message != null) {
                        wsToast(dialogContext, message, error: true);
                        return;
                      }
                      final ok = await wsConfirm(
                        dialogContext,
                        title: draft.isEdit ? '确认提交修改' : '确认入仓',
                        message: '收入 = ${_n(draft.quantityValue)} × ${wsMoney(draft.unitPriceValue)} ×（1 − ${_pct(_deduction)}）'
                            '= ${wsMoney(calc.revenue)}；预估毛利 ${wsMoney(calc.profit)}。'
                            '${draft.isEdit ? '修改会重算商品成本、运费与随货包材流水。' : ''}确认提交？',
                      );
                      if (!ok) return;
                      try {
                        if (draft.isEdit) {
                          await ApiService.updateWarehouseIn(wsI(draft.rec!['id']), draft.body());
                        } else {
                          await ApiService.createWarehouseIn(draft.body());
                        }
                        navigator.pop(true);
                      } on ApiException catch (e) {
                        if (!dialogContext.mounted) return;
                        wsToast(dialogContext, '保存失败：${e.message}', error: true);
                      }
                    },
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
    draft.dispose();
    if (saved == true) await _loadIns();
  }

  _Calc _inboundCalc(_InboundDraft d, Map<String, dynamic>? p) {
    final qty = d.quantityValue;
    final bagWeight = d.bagWeightValue > 0 ? d.bagWeightValue : wsD(p?['bag_weight']);
    final bagCost = _bagCostOf(p, bagWeight);
    final revenue = qty * d.unitPriceValue * (1 - _deduction / 100);
    final cogs = qty * bagCost;
    final freightTotal = qty * d.freightValue;
    final packCost = _packCostOf(p, qty);
    final profit = revenue - cogs - freightTotal - packCost;
    return _Calc(revenue, cogs, freightTotal, packCost, profit, bagCost, revenue > 0 ? profit / revenue * 100 : 0);
  }

  String _sourceText(Map<String, dynamic>? p) {
    if (p == null) return '未选择入仓品，商品成本按 0 计';
    if (wsI(p['stock_product_id']) > 0) {
      return '${wsS(p['stock_product_name'])}，单位成本 ${wsMoney(wsD(p['stock_unit_cost']))}/'
          '${wsS(p['stock_default_unit'], fallback: '单位')}，每袋成本 ${wsMoney(wsD(p['bag_cost']))}';
    }
    return '未关联库存商品（代发），每袋成本取代发成本 ${wsMoney(wsD(p['dropship_cost']))}';
  }

  // ---------------- 子页 1：删除 / 批量 / 付款 ----------------

  Future<void> _deleteIn(List<Map<String, dynamic>> recs, {bool isGroup = false}) async {
    final ok = await wsConfirm(
      context,
      title: isGroup ? '删除整个批次' : '删除入仓记录',
      message: '确认删除 ${recs.length} 条入仓记录？\n'
          '删除会同时撤销这些记录产生的「随货包材出库」流水，并重算相关包材商品的库存与均价。',
      okLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    final ids = [for (final r in recs) wsI(r['id'])];
    try {
      if (ids.length > 1) {
        final r = await ApiService.batchDeleteWarehouseIns(ids);
        _sel.removeAll(ids);
        if (mounted) wsToast(context, '已删除 ${wsI(r['deleted'])} 条');
      } else {
        await ApiService.deleteWarehouseIn(ids.first);
        _sel.remove(ids.first);
        if (mounted) wsToast(context, '已删除');
      }
      await _loadIns();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '删除失败：${e.message}', error: true);
    }
  }

  Future<void> _batchDelete() async {
    if (_sel.isEmpty) {
      wsToast(context, '请先勾选要删除的记录');
      return;
    }
    final recs = <Map<String, dynamic>>[
      for (final raw in _items)
        if (_sel.contains(wsI(_asMap(raw)['id']))) _asMap(raw),
    ];
    await _deleteIn(recs);
  }

  Future<void> _togglePaid(Map<String, dynamic> r) async {
    final unpaid = wsS(r['pay_status']) == 'unpaid';
    try {
      await ApiService.payBill('warehouse_in', wsI(r['id']), paid: !unpaid);
      if (!mounted) return;
      wsToast(context, !unpaid ? '已改回待付款' : '已标记付款');
      await _loadIns();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '操作失败：${e.message}', error: true);
    }
  }

  // ---------------- 子页 1：Excel 贴单导入 ----------------

  Future<void> _openImport() async {
    FilePickerResult? picked;
    try {
      picked = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['xlsx']);
    } catch (e) {
      if (mounted) wsToast(context, '选择文件失败：$e', error: true);
      return;
    }
    if (picked == null || picked.files.isEmpty) return;
    final path = picked.files.first.path;
    if (path == null) {
      if (mounted) wsToast(context, '没拿到文件路径，请重新选择');
      return;
    }
    await _showImportDialog(path);
    await _loadIns();
  }

  Future<void> _showImportDialog(String path) async {
    final head = <String, dynamic>{};
    final rows = <_ImportRow>[];
    String currentSheet = '';

    /// sheet 留空 = 后端按分仓自动选（奥斯迪/昆明蔬菜仓=常温贴单，wh02=冷冻贴单）
    Future<bool> parse(String wanted) async {
      for (final r in rows) {
        r.dispose();
      }
      rows.clear();
      try {
        final d = await ApiService.warehouseImportPreview(path, sheet: wanted);
        head.addAll(d);
        currentSheet = wanted;
        for (final raw in (d['items'] as List?) ?? const []) {
          rows.add(_ImportRow(_asMap(raw), wsS(d['date'], fallback: wsToday())));
        }
        return true;
      } on ApiException catch (e) {
        if (mounted) wsToast(context, '解析失败：${e.message}', error: true);
        return false;
      }
    }

    if (!await parse('')) return;
    if (!mounted) return;

    final message = await desktopDialog<String>(
      context,
      title: 'Excel 贴单导入 ·《入仓配送明细》',
      width: 1200,
      maxHeight: 820,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) {
          final summary = _importSummary(rows);
          final checked = rows.where((r) => r.checked).length;
          final dateValue = wsS(head['date'], fallback: wsToday());
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DesktopNotice(
                '工作表 ${wsS(head['sheet'])}${head['sheet_auto'] == true ? '（按分仓自动）' : ''} · '
                '解析 ${rows.length} 行 · 匹配 ${wsI(head['matched'])} · 未匹配 ${wsI(head['unmatched'])}。'
                '未匹配的行可手动选入仓品；勾选要入仓的行，数量 / 采购价 / 运费 / 每袋净重 / 日期均可修正。',
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    DesktopLabeled(
                      label: '工作表',
                      child: DesktopSelect<String>(
                        value: currentSheet,
                        width: 200,
                        options: [
                          const DesktopOption<String>('', '自动（按分仓）'),
                          for (final s in (head['sheets'] as List?) ?? const []) DesktopOption<String>(wsS(s), wsS(s)),
                        ],
                        onChanged: (v) async {
                          await parse(v ?? '');
                          setDialogState(() {});
                        },
                      ),
                    ),
                    DesktopLabeled(
                      label: '入仓日期',
                      child: DesktopDateField(
                        value: dateValue,
                        allowClear: false,
                        width: 150,
                        onChanged: (v) => setDialogState(() {
                          head['date'] = v;
                          for (final r in rows) {
                            r.date = v;
                          }
                        }),
                      ),
                    ),
                    DesktopLink(
                      checked == rows.length && rows.isNotEmpty ? '取消全选' : '全选',
                      onPressed: rows.isEmpty
                          ? null
                          : () => setDialogState(() {
                                final on = checked != rows.length;
                                for (final r in rows) {
                                  r.checked = on;
                                }
                              }),
                    ),
                    wsCell(
                      '已选 $checked 行 · 数量 ${_n(summary.quantity)} 袋 · 收入 ${wsMoney(summary.revenue)} · '
                      '成本 ${wsMoney(summary.cogs)} · 运费 ${wsMoney(summary.freight)} · '
                      '包材 ${wsMoney(summary.packCost)} · 毛利 ${wsMoney(summary.profit)}',
                      bold: true,
                    ),
                  ],
                ),
              ),
              DesktopGrid(
                cols: _kImportCols,
                rows: [for (final r in rows) _importRow(r, setDialogState)],
                emptyText: '没有可导入的行',
                rowHeight: 44,
              ),
              if (wsI(head['failed_count'], fallback: -1) == 0) const SizedBox.shrink() else _failedNotice(head),
              const SizedBox(height: 12),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  DesktopButton(label: '取消', onPressed: () => Navigator.of(dialogContext).pop()),
                  const SizedBox(width: 10),
                  DesktopButton(
                    label: '确认入仓（$checked 行）',
                    kind: DesktopButtonKind.success,
                    onPressed: checked == 0
                        ? null
                        : () async {
                            final navigator = Navigator.of(dialogContext);
                            final items = [for (final r in rows) if (r.usable) r.body(dateValue)];
                            try {
                              final res = await ApiService.warehouseImportConfirm(items, date: dateValue);
                              final failed = wsI(res['failed_count']);
                              navigator.pop(
                                '已入仓 ${wsI(res['created'])} 条'
                                '${failed > 0 ? '，$failed 条失败' : ''}（批次 ${wsS(res['group'])}）',
                              );
                            } on ApiException catch (e) {
                              if (!dialogContext.mounted) return;
                              wsToast(dialogContext, '入仓失败：${e.message}', error: true);
                            }
                          },
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
    for (final r in rows) {
      r.dispose();
    }
    if (message != null && mounted) wsToast(context, message);
  }

  Widget _failedNotice(Map<String, dynamic> head) {
    final failed = (head['failed'] as List?) ?? const [];
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: DesktopNotice(
        [for (final raw in failed) '第 ${wsI(_asMap(raw)['row'])} 行：${wsS(_asMap(raw)['reason'])}'].join('；'),
        kind: DesktopNoticeKind.error,
      ),
    );
  }

  _Calc _importCalc(_ImportRow r) {
    final p = _wproductById(r.productId);
    final bagCost = _bagCostOf(p, r.bagWeight);
    final revenue = r.quantity * r.unitPrice * (1 - r.deduction / 100);
    final cogs = r.quantity * bagCost;
    final freightTotal = r.quantity * r.freight;
    final packCost = _packCostOf(p, r.quantity);
    final profit = revenue - cogs - freightTotal - packCost;
    return _Calc(revenue, cogs, freightTotal, packCost, profit, bagCost, revenue > 0 ? profit / revenue * 100 : 0);
  }

  _ImportSummary _importSummary(List<_ImportRow> rows) {
    double q = 0, rev = 0, cogs = 0, fr = 0, pack = 0;
    for (final r in rows.where((r) => r.checked)) {
      final c = _importCalc(r);
      q += r.quantity;
      rev += c.revenue;
      cogs += c.cogs;
      fr += c.freightTotal;
      pack += c.packCost;
    }
    return _ImportSummary(q, rev, cogs, fr, pack, rev - cogs - fr - pack);
  }

  DesktopRow _importRow(_ImportRow r, StateSetter setDialogState) {
    final c = _importCalc(r);
    return DesktopRow(
      tag: r.row,
      cells: [
        Checkbox(
          value: r.checked,
          onChanged: (v) => setDialogState(() => r.checked = v ?? false),
          visualDensity: VisualDensity.compact,
          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(3))),
        ),
        wsCell('${r.row}'),
        wsCell(r.productName, tip: r.productName),
        DesktopSelect<int?>(
          value: r.productId,
          width: 170,
          options: [
            const DesktopOption<int?>(null, '（不关联）'),
            for (final raw in _wproducts)
              DesktopOption<int?>(wsI(_asMap(raw)['id']), wsS(_asMap(raw)['name'])),
          ],
          onChanged: (v) => setDialogState(() => r.pickProduct(v, _wproductById(v))),
        ),
        wsCell(wsS(r.purchaseNo, fallback: '—'), tip: wsS(r.purchaseNo)),
        wsCell(wsS(r.center, fallback: '—')),
        DesktopTextField(controller: r.boxCountCtrl, width: 64, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly),
        DesktopTextField(
          controller: r.quantityCtrl,
          width: 74,
          keyboardType: _kNum,
          inputFormatters: DesktopTextField.decimalOnly,
          onChanged: (_) => setDialogState(() {}),
        ),
        DesktopTextField(
          controller: r.weightCtrl,
          width: 74,
          keyboardType: _kNum,
          inputFormatters: DesktopTextField.decimalOnly,
          onChanged: (_) => setDialogState(() {}),
        ),
        DesktopTextField(
          controller: r.priceCtrl,
          width: 76,
          keyboardType: _kNum,
          inputFormatters: DesktopTextField.decimalOnly,
          onChanged: (_) => setDialogState(() {}),
        ),
        DesktopTextField(
          controller: r.freightCtrl,
          width: 68,
          keyboardType: _kNum,
          inputFormatters: DesktopTextField.decimalOnly,
          onChanged: (_) => setDialogState(() {}),
        ),
        DesktopDateField(value: r.date, width: 118, allowClear: false, onChanged: (v) => setDialogState(() => r.date = v)),
        wsCell(wsMoney(c.cogs)),
        wsCell(_dashMoney(c.packCost)),
        wsCell(wsMoney(c.revenue), bold: true),
        wsCell(wsMoney(c.profit), color: _profitColor(c.profit)),
      ],
    );
  }

  // ---------------- 子页 2：入仓品资料 ----------------

  Future<void> _openWProductForm({Map<String, dynamic>? rec}) async {
    await _ensureStockProducts();
    if (!mounted) return;
    final units = (rec?['net_weight_units'] as List?)?.map(wsS).toList();
    final draft = _WprodDraft(
      rec: rec,
      netUnits: units == null || units.isEmpty ? const ['克', '两', '斤', '公斤'] : units,
      stockProducts: _stockMaps,
    );
    final saved = await desktopDialog<bool>(
      context,
      title: draft.isEdit ? '编辑入仓品' : '新增入仓品',
      width: 820,
      maxHeight: 860,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) {
          final sp = _stockById(draft.stockProductId);
          final du = sp == null ? '' : _stockDefaultUnit(sp);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DesktopFormRow(
                label: '名称',
                required: true,
                width: 260,
                child: DesktopTextField(controller: draft.name, hintText: '入仓品名称'),
              ),
              DesktopFormRow(label: '分类', width: 220, child: DesktopTextField(controller: draft.category, hintText: '如 半加工叶梅')),
              DesktopFormRow(label: 'SKU', width: 180, child: DesktopTextField(controller: draft.sku)),
              DesktopFormRow(label: '69 码', width: 180, child: DesktopTextField(controller: draft.barcode)),
              DesktopFormRow(
                label: '箱规',
                width: 120,
                tip: '袋/箱',
                child: DesktopTextField(controller: draft.boxSpec, width: 120, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly),
              ),
              DesktopFormRow(
                label: '采购价',
                width: 140,
                tip: '元/袋，即给「我」的收入单价',
                child: DesktopTextField(controller: draft.purchasePrice, width: 140, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly),
              ),
              DesktopFormRow(
                label: '运费',
                width: 140,
                tip: '元/袋，可留空后续维护',
                child: DesktopTextField(controller: draft.freight, width: 140, keyboardType: _kNum, inputFormatters: DesktopTextField.decimalOnly),
              ),
              DesktopFormRow(
                label: '关联库存商品',
                width: 300,
                tip: '成本来源：每袋数量 × 库存单位成本；不关联则按下面「代发成本」计',
                child: DesktopSearchField(
                  title: '选择关联库存商品（成本来源）',
                  hint: '（不关联库存商品 = 代发）',
                  width: 300,
                  value: draft.stockProductId == null ? null : '${draft.stockProductId}',
                  options: [
                    for (final p in _stockCandidates())
                      DesktopOption<String>('${wsI(p['id'])}', '${wsS(p['name'])}（${wsS(p['category'], fallback: '—')}）'),
                  ],
                  onChanged: (v) => setDialogState(() => draft.stockProductId = v == null || v.isEmpty ? null : int.tryParse(v)),
                ),
              ),
              DesktopFormRow(
                label: '每袋数量',
                width: 140,
                tip: '成本口径，按库存默认单位${du.isEmpty ? '' : '（$du）'}；每袋成本 = 本值 × 单位成本',
                child: DesktopTextField(
                  controller: draft.bagWeight,
                  width: 140,
                  keyboardType: _kNum,
                  inputFormatters: DesktopTextField.decimalOnly,
                  onChanged: (_) => setDialogState(() {}),
                ),
              ),
              DesktopFormRow(
                label: '代发成本',
                width: 140,
                tip: sp == null ? '未关联库存商品时，商品成本 = 数量 × 本值' : '已关联库存商品，本值忽略',
                child: DesktopTextField(
                  controller: draft.dropshipCost,
                  width: 140,
                  readonly: sp != null,
                  keyboardType: _kNum,
                  inputFormatters: DesktopTextField.decimalOnly,
                  onChanged: (_) => setDialogState(() {}),
                ),
              ),
              DesktopFormRow(
                label: '每袋净重',
                width: 140,
                tip: '重量统计口径。库存单位是 瓶/个 这类非重量单位时必须填这里（如花生按瓶入、每瓶 228g 就填 228 克），'
                    '否则报表的重量统计算不出来；留空则回退按「每袋数量」折算',
                child: DesktopTextField(
                  controller: draft.bagNetWeight,
                  width: 140,
                  keyboardType: _kNum,
                  inputFormatters: DesktopTextField.decimalOnly,
                  onChanged: (_) => setDialogState(() {}),
                ),
              ),
              DesktopFormRow(
                label: '净重单位',
                width: 120,
                child: DesktopSelect<String>(
                  value: draft.bagNetUnit,
                  width: 120,
                  options: [for (final u in draft.netUnits) DesktopOption<String>(u, u)],
                  onChanged: (v) => setDialogState(() => draft.bagNetUnit = v ?? '克'),
                ),
              ),
              DesktopFormRow(label: '保质期', width: 180, tip: '如 半年 / 一年', child: DesktopTextField(controller: draft.shelfLife, width: 180)),
              DesktopFormRow(label: '备注', width: 420, child: DesktopTextField(controller: draft.remark, width: 420)),
              DesktopFormRow(
                label: '启用',
                width: 70,
                tip: '停用后不再出现在手动入仓的入仓品列表',
                child: Switch(value: draft.isActive, onChanged: (v) => setDialogState(() => draft.isActive = v)),
              ),
              DesktopNotice(_wprodCostHint(draft, sp, du)),
              const SizedBox(height: 4),
              WsCardHead(
                title: '随货包材（关联结算）',
                icon: Icons.inventory_2_outlined,
                trailing: DesktopLink(
                  '＋ 添加',
                  onPressed: () => setDialogState(() => draft.packs.add(_PackRow())),
                ),
              ),
              const Text(
                '每袋入仓品配套消耗的包材：入仓时按「每袋用量 × 袋数」扣减包材库存并计入入仓成本（FIFO 结转）。',
                style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
              ),
              const SizedBox(height: 10),
              for (final row in draft.packs) _packRowWidget(row, draft, setDialogState),
              const SizedBox(height: 12),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  DesktopButton(label: '取消', onPressed: () => Navigator.of(dialogContext).pop(false)),
                  const SizedBox(width: 10),
                  DesktopButton(
                    label: '保存',
                    kind: DesktopButtonKind.success,
                    onPressed: () async {
                      final navigator = Navigator.of(dialogContext);
                      final message = draft.validate();
                      if (message != null) {
                        wsToast(dialogContext, message, error: true);
                        return;
                      }
                      final body = draft.body();
                      if (wsI(body['stock_product_id'], fallback: -1) == 0 && wsD(body['dropship_cost']) == 0) {
                        final ok = await wsConfirm(
                          dialogContext,
                          title: '未关联库存商品且未填代发成本',
                          message: '入仓时商品成本将按 0 计（毛利会虚高）。仍要保存？',
                          okLabel: '仍要保存',
                        );
                        if (!ok) return;
                      }
                      try {
                        if (draft.isEdit) {
                          await ApiService.updateWarehouseProduct(wsI(draft.rec!['id']), body);
                        } else {
                          await ApiService.createWarehouseProduct(body);
                        }
                        navigator.pop(true);
                      } on ApiException catch (e) {
                        if (!dialogContext.mounted) return;
                        wsToast(dialogContext, '保存失败：${e.message}', error: true);
                      }
                    },
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
    draft.dispose();
    if (saved == true) await _loadWProducts();
  }

  String _wprodCostHint(_WprodDraft d, Map<String, dynamic>? sp, String du) {
    final parts = <String>[];
    final bagWeight = _parse(d.bagWeight);
    if (sp == null) {
      final dc = _parse(d.dropshipCost);
      parts.add(dc > 0
          ? '未关联库存商品（代发）：商品成本 = 数量 × 代发成本 ${wsMoney(dc)}/袋'
          : '未关联库存商品（代发）：请填「代发成本」，否则入仓时商品成本按 0 计（毛利会虚高）');
    } else {
      final uc = _stockUnitCost(sp);
      parts.add('库存单位成本 ${wsMoney(uc)}/${du.isEmpty ? '单位' : du}（均价优先，无库存回退参考成本）；'
          '每袋成本 = ${_n(bagWeight)} × ${wsMoney(uc)} = ${wsMoney(bagWeight * uc)}');
    }
    final net = _parse(d.bagNetWeight);
    final netKg = _netKg(net, d.bagNetUnit);
    if (netKg > 0) {
      parts.add('重量统计：每袋 ${netKg.toStringAsFixed(3)} kg（报表「重量(kg)」= 袋数 × 该值）');
    } else if (bagWeight > 0 && du.isNotEmpty && !_kWeightUnits.contains(du)) {
      parts.add('库存单位「$du」不是重量单位，报表里算不出重量 —— 请填「每袋净重」');
    }
    return parts.join('　·　');
  }

  Widget _packRowWidget(_PackRow row, _WprodDraft draft, StateSetter setDialogState) {
    final product = _stockById(row.productId);
    final units = (product?['conversions'] as Map?)?.keys.map(wsS).toList() ?? const <String>[];
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          DesktopSearchField(
            title: '选择随货包材',
            hint: '选择随货包材…',
            width: 260,
            value: row.productId == null ? null : '${row.productId}',
            options: [
              for (final p in _stockMaps)
                if (p['is_active'] == true) DesktopOption<String>('${wsI(p['id'])}', '${wsS(p['name'])}（${wsS(p['category'], fallback: '—')}）'),
            ],
            onChanged: (v) {
              final id = v == null || v.isEmpty ? null : int.tryParse(v);
              setDialogState(() => row.pick(id, _stockById(id)));
            },
          ),
          const SizedBox(width: 10),
          DesktopSelect<String>(
            value: row.unit,
            width: 110,
            options: [for (final u in units) DesktopOption<String>(u, u)],
            onChanged: (v) => setDialogState(() => row.unit = v ?? '个'),
          ),
          const SizedBox(width: 10),
          DesktopTextField(
            controller: row.quantityCtrl,
            width: 110,
            hintText: '每袋用量',
            keyboardType: _kNum,
            inputFormatters: DesktopTextField.decimalOnly,
            onChanged: (_) => setDialogState(() {}),
          ),
          const SizedBox(width: 8),
          wsCell('每袋'),
          const SizedBox(width: 8),
          DesktopLink('删', color: WsTokens.red, onPressed: () => setDialogState(() => draft.packs.remove(row))),
        ],
      ),
    );
  }

  Future<void> _deleteWProduct(Map<String, dynamic> p) async {
    final ok = await wsConfirm(
      context,
      title: '删除入仓品',
      message: '确认删除「${wsS(p['name'])}」？已产生的入仓记录不受影响。',
      okLabel: '删除',
      danger: true,
    );
    if (!ok) return;
    if (!mounted) return;
    try {
      await ApiService.deleteWarehouseProduct(wsI(p['id']));
      if (!mounted) return;
      wsToast(context, '已删除');
      await _loadWProducts();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '删除失败：${e.message}', error: true);
    }
  }

  /// 启用 / 停用：后端 PUT 收全字段 ProductIn，所以按当前行回传其余字段
  Future<void> _toggleWProductActive(Map<String, dynamic> p) async {
    await _ensureStockProducts();
    if (!mounted) return;
    final draft = _WprodDraft(rec: p, netUnits: const ['克', '两', '斤', '公斤'], stockProducts: _stockMaps);
    final body = draft.body();
    draft.dispose();
    final active = p['is_active'] != true;
    body['is_active'] = active;
    try {
      await ApiService.updateWarehouseProduct(wsI(p['id']), body);
      if (!mounted) return;
      wsToast(context, active ? '已启用' : '已停用');
      await _loadWProducts();
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '操作失败：${e.message}', error: true);
    }
  }

  // ---------------- 明细表：批次折叠 + 排序 ----------------

  List<_WinEntry> _entries() {
    final groups = <String, List<Map<String, dynamic>>>{};
    final out = <_WinEntry>[];
    for (final raw in _items) {
      final r = _asMap(raw);
      final key = wsS(r['import_group']);
      if (key.isEmpty) {
        out.add(_WinEntry.record(r));
      } else {
        (groups[key] ??= <Map<String, dynamic>>[]).add(r);
      }
    }
    for (final e in groups.entries) {
      out.add(_WinEntry.group(e.key, e.value));
    }
    final key = _sortKey;
    if (key != null) {
      out.sort((a, b) {
        final r = _compare(a.sortBy(key), b.sortBy(key));
        return _sortAsc ? r : -r;
      });
    }
    return out;
  }

  int _compare(Object? a, Object? b) {
    if (a is num && b is num) return a.compareTo(b);
    return wsS(a).compareTo(wsS(b));
  }

  List<DesktopRow> _inRows(List<_WinEntry> entries) {
    final rows = <DesktopRow>[];
    for (final e in entries) {
      if (!e.isGroup) {
        rows.add(_recordRow(e.recs.first));
        continue;
      }
      final open = _openGroups.contains(e.groupKey);
      rows.add(
        DesktopRow(
          tag: e.groupKey,
          highlight: open,
          cells: [
            _groupCheck([for (final r in e.recs) wsI(r['id'])]),
            wsCell('${open ? '▾' : '▸'} ${e.code}', bold: true, tip: '批次 ${e.groupKey}'),
            wsCell(e.date),
            wsCell(e.product, tip: e.product),
            wsCell('—'),
            wsCell('袋'),
            wsCell('${_n(e.quantity)} 袋'),
            wsCell('—'),
            wsCell(_pct(wsD(e.recs.first['deduction_percent']))),
            wsCell(wsMoney(e.amount), bold: true),
            wsCell('—'),
            wsCell('—'),
            wsCell('—'),
            wsCell(wsMoney(e.cogs)),
            wsCell('—'),
            wsCell(_dashMoney(e.freight)),
            wsCell(_dashMoney(e.packCost)),
            wsCell(wsMoney(e.profit), color: _profitColor(e.profit)),
            wsCell(_pct(e.profitRate), color: _profitColor(e.profit)),
            wsCell(e.purchaseNo),
            wsCell(e.center),
            wsCell('—'),
            wsCell('—'),
            wsCell('—'),
            wsCell('—'),
            wsCell('Excel 贴单导入', tip: '同一 import_group 折叠为一行，点「明细」看组内记录'),
            Row(
              children: [
                DesktopLink(
                  open ? '收起' : '明细',
                  onPressed: () => setState(() {
                    if (open) {
                      _openGroups.remove(e.groupKey);
                    } else {
                      _openGroups.add(e.groupKey);
                    }
                  }),
                ),
                DesktopLink('改', onPressed: () => _openInboundForm(rec: e.recs.first)),
                DesktopLink('删批', color: WsTokens.red, onPressed: () => _deleteIn(e.recs, isGroup: true)),
              ],
            ),
          ],
        ),
      );
      if (open) {
        for (final r in e.recs) {
          rows.add(_recordRow(r, indent: true));
        }
      }
    }
    return rows;
  }

  DesktopRow _recordRow(Map<String, dynamic> r, {bool indent = false}) {
    final id = wsI(r['id']);
    final unpaid = wsS(r['pay_status']) == 'unpaid';
    final picked = _wproductById(r['product_id'] == null ? null : wsI(r['product_id']));
    final pack = (r['pack_items'] as List?) ?? const [];
    final stockName = wsS(r['stock_product_name']);
    return DesktopRow(
      tag: id,
      cells: [
        _check(id),
        wsCell(indent ? '    ${wsS(r['code'])}' : wsS(r['code'])),
        wsCell(wsS(r['date'])),
        wsCell(
          '${wsS(r['product_name'])}${picked == null && r['product_id'] == null ? '（未关联）' : ''}',
          bold: !indent,
          tip: (stockName.isEmpty
                  ? '未关联库存商品（代发）· 每袋成本 ${wsMoney(wsD(r['bag_cost']))}/袋'
                  : '$stockName · 单位成本 ${wsMoney(wsD(r['unit_cost']))}/${wsS(r['stock_default_unit'], fallback: '单位')}') +
              (pack.isEmpty ? '' : ' · 随货包材：${_packTextOf(r)}'),
        ),
        wsCell(wsS(r['category'], fallback: '—')),
        wsCell(wsS(r['unit'], fallback: '袋')),
        wsCell(_n(wsD(r['quantity']))),
        wsCell(wsMoney(wsD(r['unit_price']))),
        wsCell(wsD(r['deduction_percent']) == 0 ? '—' : _pct(wsD(r['deduction_percent']))),
        wsCell(wsMoney(wsD(r['amount'])), bold: true),
        wsCell(_n(wsD(r['bag_weight']))),
        wsCell(wsMoney(wsD(r['unit_cost']))),
        wsCell(wsMoney(wsD(r['bag_cost'])), tip: '每袋商品成本'),
        wsCell(wsMoney(wsD(r['cogs']))),
        wsCell(wsMoney(wsD(r['freight']))),
        wsCell(_dashMoney(wsD(r['freight_total']))),
        wsCell(_dashMoney(wsD(r['pack_cost']))),
        wsCell(wsMoney(wsD(r['profit'])), color: _profitColor(wsD(r['profit']))),
        wsCell(_pct(wsD(r['profit_rate'])), color: _profitColor(wsD(r['profit']))),
        wsCell(wsS(r['purchase_no'], fallback: '—'), tip: wsS(r['purchase_no'])),
        wsCell(wsS(r['center'], fallback: '—')),
        wsCell(_n(wsD(r['box_count']))),
        wsCell(_n(wsD(r['box_spec']))),
        wsCell(wsS(r['operator'], fallback: '—')),
        DesktopTag(unpaid ? '待付款' : '已付款', color: unpaid ? DesktopTag.unpaid : DesktopTag.paid),
        wsCell(wsS(r['remark'], fallback: '—'), tip: wsS(r['remark'])),
        Row(
          children: [
            DesktopLink('改', onPressed: () => _openInboundForm(rec: r)),
            DesktopLink(
              unpaid ? '已付' : '转待付',
              color: unpaid ? WsTokens.green : WsTokens.amber,
              onPressed: () => _togglePaid(r),
            ),
            DesktopLink('删', color: WsTokens.red, onPressed: () => _deleteIn([r])),
          ],
        ),
      ],
    );
  }

  Widget _check(int id) => Checkbox(
        value: _sel.contains(id),
        onChanged: (v) => setState(() {
          if (v == true) {
            _sel.add(id);
          } else {
            _sel.remove(id);
          }
        }),
        visualDensity: VisualDensity.compact,
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(3))),
      );

  Widget _groupCheck(List<int> ids) {
    final all = ids.isNotEmpty && ids.every(_sel.contains);
    return Checkbox(
      value: all,
      onChanged: (v) => setState(() {
        for (final id in ids) {
          if (v == true) {
            _sel.add(id);
          } else {
            _sel.remove(id);
          }
        }
      }),
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(3))),
    );
  }

  List<DesktopRow> _byProductRows() {
    final rows = [for (final raw in _byProduct) _asMap(raw)];
    final key = _sortKey;
    if (key != null) {
      rows.sort((a, b) {
        final r = key == 'product_name' ? wsS(a['product_name']).compareTo(wsS(b['product_name'])) : wsD(a[key]).compareTo(wsD(b[key]));
        return _sortAsc ? r : -r;
      });
    }
    return [
      for (final b in rows)
        DesktopRow(
          cells: [
            wsCell(wsS(b['product_name']), bold: true),
            wsCell(wsS(b['sku'], fallback: '—')),
            wsCell(wsS(b['category'], fallback: '—')),
            wsCell(wsS(b['unit'], fallback: '袋')),
            wsCell('${wsI(b['records'])}'),
            wsCell(_n(wsD(b['quantity']))),
            wsCell(wsMoney(wsD(b['amount'])), bold: true),
            wsCell(wsMoney(wsD(b['cogs']))),
            wsCell(_dashMoney(wsD(b['freight_total']))),
            wsCell(_dashMoney(wsD(b['pack_cost']))),
            wsCell(wsMoney(wsD(b['profit'])), color: _profitColor(wsD(b['profit']))),
            wsCell(_pct(wsD(b['profit_rate'])), color: _profitColor(wsD(b['profit']))),
            wsCell(wsMoney(wsD(b['unit_revenue']))),
            wsCell(wsMoney(wsD(b['unit_profit']))),
            wsCell(wsS(b['last_date'], fallback: '—')),
          ],
        ),
    ];
  }

  List<DesktopRow> _wprodRows() {
    return [
      for (final raw in _wproducts) _wprodRow(_asMap(raw)),
    ];
  }

  DesktopRow _wprodRow(Map<String, dynamic> p) {
    final linked = wsI(p['stock_product_id']) > 0;
    final active = p['is_active'] == true;
    final net = wsD(p['bag_net_weight']);
    final du = wsS(p['stock_default_unit']);
    final bagWeight = wsD(p['bag_weight']);
    final netText = net > 0
        ? '${_n(net)} ${wsS(p['bag_net_unit'], fallback: '克')}'
        : (du.isNotEmpty && _kWeightUnits.contains(du) ? '${_n(bagWeight)} $du' : '—');
    return DesktopRow(
      tag: wsI(p['id']),
      dim: !active,
      cells: [
        wsCell(wsS(p['name']), bold: true),
        wsCell(wsS(p['category'], fallback: '—')),
        wsCell(wsS(p['sku'], fallback: '—')),
        wsCell(wsS(p['barcode'], fallback: '—')),
        wsCell(_n(wsD(p['box_spec']))),
        wsCell(wsMoney(wsD(p['purchase_price']))),
        wsCell(_dashMoney(wsD(p['freight']))),
        wsCell(
          netText,
          tip: net > 0
              ? '重量统计口径：每袋 ${_netKg(net, wsS(p['bag_net_unit'], fallback: '克')).toStringAsFixed(3)} kg'
              : '留空则回退按「每袋数量 × 库存单位」折算',
        ),
        wsCell(_n(bagWeight), tip: '成本口径：每袋含几个${du.isEmpty ? '库存默认单位' : du}'),
        wsCell(wsD(p['bag_cost']) == 0 ? '—' : wsMoney(wsD(p['bag_cost']))),
        wsCell(wsD(p['dropship_cost']) == 0 ? '—' : wsMoney(wsD(p['dropship_cost']))),
        wsCell(linked ? wsS(p['stock_product_name']) : '未关联（代发）'),
        wsCell(linked ? '${wsMoney(wsD(p['stock_unit_cost']))}/$du' : '—'),
        wsCell(_packTextOf(p), tip: '入仓时按每袋用量扣减包材库存并计入成本'),
        wsCell(wsS(p['shelf_life'], fallback: '—')),
        DesktopTag(active ? '在用' : '停用', color: active ? DesktopTag.paid : DesktopTag.off),
        wsCell(wsS(p['remark'], fallback: '—'), tip: wsS(p['remark'])),
        Row(
          children: [
            DesktopLink('改', onPressed: () => _openWProductForm(rec: p)),
            DesktopLink(
              active ? '停用' : '启用',
              color: active ? WsTokens.amber : WsTokens.green,
              onPressed: () => _toggleWProductActive(p),
            ),
            DesktopLink('删', color: WsTokens.red, onPressed: () => _deleteWProduct(p)),
          ],
        ),
      ],
    );
  }

  // ---------------- 子页 1 build ----------------

  Widget _tabRecords() {
    final entries = _entries();
    final grouped = entries.where((e) => e.isGroup).length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopRise(index: 0, child: _statCards()),
        const SizedBox(height: 14),
        DesktopRise(
          index: 1,
          child: DesktopFilterBar(
            right: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                DesktopTabs(
                  small: true,
                  items: const ['明细', '按入仓品汇总'],
                  index: _viewByProduct ? 1 : 0,
                  onChanged: (i) => setState(() {
                    _viewByProduct = i == 1;
                    _sortKey = null;
                  }),
                ),
                const SizedBox(width: 10),
                DesktopButton(label: '刷新', icon: Icons.refresh, small: true, onPressed: _loadIns),
              ],
            ),
            children: [
              DesktopDateField(value: _dateFrom, onChanged: (v) => setState(() => _dateFrom = v)),
              wsCell('~'),
              DesktopDateField(value: _dateTo, onChanged: (v) => setState(() => _dateTo = v)),
              DesktopLabeled(
                label: '关键字',
                child: DesktopTextField(
                  controller: _qCtrl,
                  width: 240,
                  hintText: '单号 / 商品 / 采购单号 / 中心 / 操作员',
                  onSubmitted: (_) => _loadIns(),
                ),
              ),
              DesktopButton(label: '筛选', icon: Icons.filter_alt_outlined, small: true, onPressed: _loadIns),
              DesktopButton(
                label: '本月',
                small: true,
                onPressed: () {
                  setState(() {
                    _dateFrom = wsMonthStart();
                    _dateTo = wsToday();
                  });
                  _loadIns();
                },
              ),
              DesktopButton(
                label: '今天',
                small: true,
                onPressed: () {
                  setState(() {
                    _dateFrom = wsToday();
                    _dateTo = wsToday();
                  });
                  _loadIns();
                },
              ),
              DesktopLink('待付款账单 →', onPressed: () => widget.onNavigate('/payables')),
            ],
          ),
        ),
        if (_sel.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Row(
              children: [
                wsCell('已选 ${_sel.length} 条', bold: true),
                const SizedBox(width: 12),
                DesktopButton(
                  label: _sel.length >= _items.length ? '取消选择' : '全选当前结果',
                  small: true,
                  onPressed: () => setState(() {
                    if (_sel.length >= _items.length) {
                      _sel.clear();
                    } else {
                      _sel.addAll([for (final raw in _items) wsI(_asMap(raw)['id'])]);
                    }
                  }),
                ),
                const SizedBox(width: 10),
                DesktopButton(
                  label: '批量删除',
                  icon: Icons.delete_outline,
                  kind: DesktopButtonKind.danger,
                  small: true,
                  onPressed: _batchDelete,
                ),
              ],
            ),
          ),
        Expanded(
          child: DesktopStateView(
            loading: _insLoading,
            error: _insError,
            onRetry: _loadIns,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_viewByProduct)
                    DesktopGrid(
                      cols: _kByProdCols,
                      rows: _byProductRows(),
                      footer: _byProductFooter(),
                      sortKey: _sortKey,
                      sortAsc: _sortAsc,
                      onSort: _onSort,
                      emptyText: '该时间段暂无入仓记录',
                    )
                  else
                    DesktopGrid(
                      cols: _kInCols,
                      rows: _inRows(entries),
                      footer: _inFooter(),
                      sortKey: _sortKey,
                      sortAsc: _sortAsc,
                      onSort: _onSort,
                      emptyText: '该时间段暂无入仓记录，可点「导入$_autoSheet」或「手动入仓」',
                    ),
                  const SizedBox(height: 8),
                  wsCell(
                    '共 $_count 条，合并 ${entries.length} 行（其中导入批次 $grouped 个）· '
                    '毛利率 = 合计毛利 ÷ 合计收入，不是各条毛利率的平均',
                  ),
                  const SizedBox(height: 16),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  void _onSort(String key) => setState(() {
        if (_sortKey == key) {
          _sortAsc = !_sortAsc;
        } else {
          _sortKey = key;
          _sortAsc = false;
        }
      });

  Widget _statCards() => DesktopStatGrid(
        minTileWidth: 180,
        children: [
          DesktopStatCard(
            label: '收入合计',
            value: wsMoney(wsD(_total['amount'])),
            sub: '$_count 条 · ${_n(wsD(_total['quantity']))} 袋',
          ),
          DesktopStatCard(label: '商品成本', value: wsMoney(wsD(_total['cogs'])), sub: '数量 × 每袋成本'),
          DesktopStatCard(label: '运费', value: wsMoney(wsD(_total['freight'])), sub: '数量 × 每袋运费'),
          DesktopStatCard(label: '随货包材', value: wsMoney(wsD(_total['pack_cost'])), sub: 'FIFO 结转并扣库存'),
          DesktopStatCard(
            label: '毛利',
            value: wsMoney(wsD(_total['profit'])),
            color: _profitColor(wsD(_total['profit'])),
            sub: '收入 − 成本 − 运费 − 包材',
          ),
          DesktopStatCard(
            label: '毛利率',
            value: _pct(wsD(_total['profit_rate'])),
            color: _profitColor(wsD(_total['profit'])),
            sub: '合计毛利 ÷ 合计收入',
          ),
        ],
      );

  /// 合计行（tfoot）：下标与 _kInCols 对齐
  List<String> _inFooter() {
    final cells = List<String>.filled(_kInCols.length, '');
    cells[1] = '合计';
    cells[6] = _n(wsD(_total['quantity']));
    cells[9] = wsMoney(wsD(_total['amount']));
    cells[13] = wsMoney(wsD(_total['cogs']));
    cells[15] = wsMoney(wsD(_total['freight']));
    cells[16] = wsMoney(wsD(_total['pack_cost']));
    cells[17] = wsMoney(wsD(_total['profit']));
    cells[18] = _pct(wsD(_total['profit_rate']));
    return cells;
  }

  /// 合计行：下标与 _kByProdCols 对齐；毛利率按合计毛利 ÷ 合计收入重算
  List<String> _byProductFooter() {
    final cells = List<String>.filled(_kByProdCols.length, '');
    double sum(String key) => _byProduct.fold<double>(0, (s, raw) => s + wsD(_asMap(raw)[key]));
    cells[0] = '合计（${_byProduct.length} 种）';
    cells[5] = _n(sum('quantity'));
    cells[6] = wsMoney(sum('amount'));
    cells[7] = wsMoney(sum('cogs'));
    cells[8] = wsMoney(sum('freight_total'));
    cells[9] = wsMoney(sum('pack_cost'));
    cells[10] = wsMoney(sum('profit'));
    final amount = sum('amount');
    cells[11] = amount == 0 ? '—' : _pct(sum('profit') / amount * 100);
    return cells;
  }

  // ---------------- 子页 2 build ----------------

  Widget _tabProducts() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopFilterBar(
          right: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              DesktopButton(label: '新增入仓品', icon: Icons.add, kind: DesktopButtonKind.success, small: true, onPressed: () => _openWProductForm()),
              const SizedBox(width: 10),
              DesktopButton(label: '刷新', icon: Icons.refresh, small: true, onPressed: _loadWProducts),
            ],
          ),
          children: [
            SizedBox(
              width: 720,
              child: wsCell(
                '共 ${_wproducts.length} 个入仓品 · 采购价是给「我」的收入单价；商品成本按「关联库存商品单位成本 × 每袋数量」，'
                '未关联时取手填「代发成本」',
              ),
            ),
          ],
        ),
        Expanded(
          child: DesktopStateView(
            loading: _prodLoading,
            error: _prodError,
            onRetry: _loadWProducts,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  DesktopGrid(cols: _kWprodCols, rows: _wprodRows(), emptyText: '暂无入仓品，可点「新增入仓品」录入'),
                  const SizedBox(height: 16),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  // ---------------- 子页 3 build ----------------

  Widget _tabNotes() {
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DesktopNotice(
            '口径来自后端 backend/app/routers/warehouse_in.py。入仓页里的收入 / 成本 / 毛利只是弹窗预估，'
            '落库时一律由后端重算；对账以这里为准。',
          ),
          WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const WsCardHead(title: '入仓口径（成本与毛利）', icon: Icons.functions),
                _formulaRow(
                  '收入',
                  '数量 × 采购单价 ×（1 − 入仓扣点%）',
                  note: '采购单价即「元/袋」的收入单价；扣点统一在「扣点」页维护，类别名「入仓品」。',
                ),
                _formulaRow(
                  '商品成本',
                  '数量 × 每袋成本',
                  note: '每袋成本：关联库存 = 每袋净重 × 库存单位成本；未关联（代发）= 入仓品手填的代发成本。',
                ),
                _formulaRow('库存单位成本', '库存均价优先，无库存时回退参考成本', note: '按关联库存商品的「默认单位」取价，与库存管理展示口径一致。'),
                _formulaRow('运费合计', '数量 × 每袋运费'),
                _formulaRow(
                  '随货包材成本',
                  'Σ（每袋用量 × 袋数 × FIFO 结转单价）',
                  note: '按 FIFO 结转并真实扣减包材库存（人工 / 快递类记为正向工作量）；删除入仓记录会撤销这些出库流水并重算库存。',
                ),
                _formulaRow('毛利', '收入 − 商品成本 − 运费合计 − 随货包材成本'),
                _formulaRow(
                  '毛利率',
                  '毛利 ÷ 收入',
                  note: '合计毛利率 = 合计毛利 ÷ 合计收入，不是各条毛利率的平均（避免小额记录被放大）。',
                ),
                _formulaRow(
                  '重量统计',
                  '袋数 × 每袋净重（带单位）',
                  note: '库存单位是 瓶/个 这类非重量单位时必须维护「每袋净重」，否则报表的重量列算不出来。',
                ),
                _formulaRow('入仓记录独立于库存商品', '不改变现有库存数量', note: '只有随货包材会真实扣减包材库存。'),
              ],
            ),
          ),
          WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const WsCardHead(title: '当前分仓与本页合计', icon: Icons.storefront_outlined),
                _formulaRow('分仓', widget.auth.warehouseName.isEmpty ? widget.auth.warehouseKey : widget.auth.warehouseName),
                _formulaRow('入仓品扣点', _pct(_deduction), note: 'GET /api/warehouse-in/deduction'),
                _formulaRow(
                  '默认贴单表',
                  _autoSheet,
                  note: '奥斯迪 / 昆明蔬菜仓 = 常温贴单，wh02 = 冷冻贴单；不显式指定时由后端按分仓自动选。',
                ),
                _formulaRow('操作员', widget.auth.displayName, note: '入仓记录的操作人固定取当前登录人，表单里只读。'),
                _formulaRow('本页收入合计', wsMoney(wsD(_total['amount'])), note: '随「入仓记录」子页的日期区间与关键字变化'),
                _formulaRow('本页商品成本', wsMoney(wsD(_total['cogs']))),
                _formulaRow('本页毛利', wsMoney(wsD(_total['profit'])), note: '收入 − 商品成本 − 运费 − 包材'),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],
      ),
    );
  }

  Widget _formulaRow(String name, String value, {String? note}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: 150, child: wsCell(name, bold: true)),
              Expanded(child: wsCell(value, color: WsTokens.primary)),
            ],
          ),
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(left: 150, top: 3),
              child: Text(note, style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5)),
            ),
        ],
      ),
    );
  }

  Widget _kv(String label, String value) => wsCell('$label  $value');

  Widget _kvText(String label, String value, Color? color) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [wsCell('$label  '), wsCell(value, bold: true, color: color)],
      );

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '入仓',
      subtitle: '按「袋」采购的备货商品（半加工等）入仓台账：收入 = 数量 × 采购价 ×（1 − 扣点%），'
          '成本按关联库存商品或手填代发成本，随货包材按 FIFO 结转并扣减库存',
      actions: [
        DesktopButton(label: '导入$_autoSheet', icon: Icons.download_outlined, onPressed: _openImport),
        DesktopButton(label: '手动入仓', icon: Icons.add, kind: DesktopButtonKind.primary, onPressed: () => _openInboundForm()),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              DesktopTabs(
                items: const ['入仓记录', '入仓品资料', '成本口径说明'],
                index: _tab,
                onChanged: (i) => setState(() => _tab = i),
              ),
              const Spacer(),
              if (_tab == 0)
                wsCell('合计 ${wsMoney(wsD(_total['amount']))} · 毛利 ${wsMoney(wsD(_total['profit']))} · '
                    '毛利率 ${_pct(wsD(_total['profit_rate']))}')
              else if (_tab == 1)
                wsCell('入仓品扣点 ${_pct(_deduction)} · 贴单表 $_autoSheet'),
            ],
          ),
          const SizedBox(height: 14),
          Expanded(child: _tab == 0 ? _tabRecords() : (_tab == 1 ? _tabProducts() : _tabNotes())),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- 模型 / 草稿

/// 明细表一行：单条记录，或同一 import_group 的批次聚合行（复刻 page-wingroup）
class _WinEntry {
  _WinEntry.record(Map<String, dynamic> r)
      : isGroup = false,
        groupKey = '',
        recs = [r],
        code = wsS(r['code']),
        date = wsS(r['date']),
        purchaseNo = wsS(r['purchase_no'], fallback: '—'),
        center = wsS(r['center'], fallback: '—'),
        product = wsS(r['product_name']),
        quantity = wsD(r['quantity']),
        amount = wsD(r['amount']),
        cogs = wsD(r['cogs']),
        freight = wsD(r['freight_total']),
        packCost = wsD(r['pack_cost']),
        profit = wsD(r['profit']),
        profitRate = wsD(r['profit_rate']);

  _WinEntry.group(String key, List<Map<String, dynamic>> recs)
      : isGroup = true,
        groupKey = key,
        recs = recs,
        code = '批量 · ${recs.length}条',
        date = _dateRange(recs),
        purchaseNo = _joinFirst(recs, 'purchase_no'),
        center = _joinFirst(recs, 'center'),
        product = _joinProducts(recs),
        quantity = _sum(recs, 'quantity'),
        amount = _sum(recs, 'amount'),
        cogs = _sum(recs, 'cogs'),
        freight = _sum(recs, 'freight_total'),
        packCost = _sum(recs, 'pack_cost'),
        profit = _sum(recs, 'profit'),
        profitRate = _rate(_sum(recs, 'profit'), _sum(recs, 'amount'));

  final bool isGroup;
  final String groupKey;
  final List<Map<String, dynamic>> recs;
  final String code;
  final String date;
  final String purchaseNo;
  final String center;
  final String product;
  final double quantity;
  final double amount;
  final double cogs;
  final double freight;
  final double packCost;
  final double profit;

  /// 批次毛利率按「本批次毛利 ÷ 本批次收入」重算，不是各条毛利率的平均
  final double profitRate;

  static double _sum(List<Map<String, dynamic>> recs, String key) => recs.fold<double>(0, (s, r) => s + wsD(r[key]));

  static double _rate(double profit, double amount) => amount == 0 ? 0 : double.parse((profit / amount * 100).toStringAsFixed(2));

  static String _dateRange(List<Map<String, dynamic>> recs) {
    final dates = recs.map((r) => wsS(r['date'])).toList()..sort();
    if (dates.isEmpty) return '—';
    return dates.first == dates.last ? dates.first : '${dates.first} ~ ${dates.last}';
  }

  static String _joinFirst(List<Map<String, dynamic>> recs, String key) {
    final values = recs.map((r) => wsS(r[key])).where((v) => v.isNotEmpty).toSet().toList();
    if (values.isEmpty) return '—';
    return values.length == 1 ? values.first : '${values.first} 等${values.length}个';
  }

  static String _joinProducts(List<Map<String, dynamic>> recs) {
    final names = recs.map((r) => wsS(r['product_name'])).where((v) => v.isNotEmpty).toSet().toList();
    if (names.isEmpty) return '—';
    if (names.length <= 3) return names.join('、');
    return '${names.take(3).join('、')} 等${names.length}种';
  }

  Object? sortBy(String key) => switch (key) {
        'code' => code,
        'date' => date,
        'purchase_no' => purchaseNo,
        'center' => center,
        'product' => product,
        'quantity' => quantity,
        'unit_price' => quantity == 0 ? 0 : amount / quantity,
        'amount' => amount,
        'cogs' => cogs,
        'freight' => freight,
        'pack_cost' => packCost,
        'profit' => profit,
        'profit_rate' => profitRate,
        _ => null,
      };
}

/// 弹窗里的一组预估数字
class _Calc {
  _Calc(this.revenue, this.cogs, this.freightTotal, this.packCost, this.profit, this.bagCost, this.profitRate);

  final double revenue;
  final double cogs;
  final double freightTotal;
  final double packCost;
  final double profit;
  final double bagCost;
  final double profitRate;
}

/// 导入预览的合计预估
class _ImportSummary {
  _ImportSummary(this.quantity, this.revenue, this.cogs, this.freight, this.packCost, this.profit);

  final double quantity;
  final double revenue;
  final double cogs;
  final double freight;
  final double packCost;
  final double profit;
}

/// 手动 / 编辑入仓表单草稿（字段 = 后端 InboundIn / InboundUpdate）
class _InboundDraft {
  _InboundDraft({this.rec, this.operator = ''}) {
    final old = rec;
    isEdit = old != null;
    productId = old == null ? null : (old['product_id'] == null ? null : wsI(old['product_id']));
    unit.text = '袋';
    date = wsToday();
    if (old != null) {
      name.text = wsS(old['product_name']);
      category.text = wsS(old['category']);
      unit.text = wsS(old['unit'], fallback: '袋');
      purchaseNo.text = wsS(old['purchase_no']);
      center.text = wsS(old['center']);
      quantity.text = _numText(wsD(old['quantity']));
      boxCount.text = _numText(wsD(old['box_count']));
      boxSpec.text = _numText(wsD(old['box_spec']));
      unitPrice.text = _numText(wsD(old['unit_price']));
      freight.text = _numText(wsD(old['freight']));
      bagWeight.text = _numText(wsD(old['bag_weight']));
      remark.text = wsS(old['remark']);
      date = wsS(old['date'], fallback: wsToday());
      payStatus = wsS(old['pay_status'], fallback: 'paid');
    }
    operatorCtrl.text = operator;
  }

  final Map<String, dynamic>? rec;
  final String operator;
  late final bool isEdit;
  int? productId;
  late String date;
  String payStatus = 'paid';

  final name = TextEditingController();
  final category = TextEditingController();
  final unit = TextEditingController();
  final purchaseNo = TextEditingController();
  final center = TextEditingController();
  final quantity = TextEditingController();
  final boxCount = TextEditingController();
  final boxSpec = TextEditingController();
  final unitPrice = TextEditingController();
  final freight = TextEditingController();
  final bagWeight = TextEditingController();
  final remark = TextEditingController();
  final operatorCtrl = TextEditingController();

  double get quantityValue => _parse(quantity);
  double get unitPriceValue => _parse(unitPrice);
  double get freightValue => _parse(freight);
  double get bagWeightValue => _parse(bagWeight);
  String get unitValue => unit.text.trim().isEmpty ? '袋' : unit.text.trim();

  /// 选中入仓品后带出名称 / 采购价 / 运费 / 箱规 / 每袋净重（同网页端 wInPickProduct）
  void pickProduct(int? id, Map<String, dynamic>? p) {
    productId = id;
    if (p == null) return;
    name.text = wsS(p['name']);
    category.text = wsS(p['category']);
    unitPrice.text = _numText(wsD(p['purchase_price']));
    freight.text = _numText(wsD(p['freight']));
    boxSpec.text = _numText(wsD(p['box_spec']));
    bagWeight.text = _numText(wsD(p['bag_weight']));
  }

  String? validate() {
    if (productId == null && name.text.trim().isEmpty) return '请选择入仓品或填写商品名称';
    if (date.isEmpty) return '请选择日期';
    if (quantityValue <= 0) return '请填写有效数量（大于 0）';
    return null;
  }

  Map<String, dynamic> body() => {
        'product_id': productId,
        'product_name': name.text.trim(),
        'category': category.text.trim(),
        'unit': unitValue,
        'purchase_no': purchaseNo.text.trim(),
        'center': center.text.trim(),
        'quantity': quantityValue,
        'box_count': _parse(boxCount),
        'box_spec': _parse(boxSpec),
        'unit_price': unitPriceValue,
        'freight': freightValue,
        'bag_weight': bagWeightValue,
        'date': date,
        if (!isEdit) 'operator': operator,
        'remark': remark.text.trim(),
        'pay_status': payStatus,
      };

  void dispose() {
    name.dispose();
    category.dispose();
    unit.dispose();
    purchaseNo.dispose();
    center.dispose();
    quantity.dispose();
    boxCount.dispose();
    boxSpec.dispose();
    unitPrice.dispose();
    freight.dispose();
    bagWeight.dispose();
    remark.dispose();
    operatorCtrl.dispose();
  }
}

/// 随货包材（关联结算）动态行：包材商品 + 每袋数量 + 单位
class _PackRow {
  _PackRow({this.productId, this.unit = '个', double qty = 1}) : quantityCtrl = TextEditingController(text: _numText(qty));

  int? productId;
  String unit;
  final TextEditingController quantityCtrl;

  /// 换包材时把单位切到该商品默认单位（必须落在 conversions 里，否则后端会拒绝）
  void pick(int? id, Map<String, dynamic>? product) {
    productId = id;
    final units = (product?['conversions'] as Map?)?.keys.map(wsS).toList() ?? const <String>[];
    if (units.isEmpty) {
      unit = '个';
      return;
    }
    final fallback = wsS(product?['default_unit']).isEmpty ? wsS(product?['base_unit']) : wsS(product?['default_unit']);
    unit = units.contains(fallback) ? fallback : units.first;
  }

  void dispose() => quantityCtrl.dispose();
}

/// 入仓品表单草稿（字段 = 后端 ProductIn，校验也按后端 _clean_pack_items 来）
class _WprodDraft {
  _WprodDraft({this.rec, List<String>? netUnits, List<Map<String, dynamic>>? stockProducts})
      : netUnits = netUnits ?? const ['克', '两', '斤', '公斤'],
        _stockProducts = stockProducts ?? const [] {
    final old = rec;
    isEdit = old != null;
    if (old == null) return;
    name.text = wsS(old['name']);
    category.text = wsS(old['category']);
    sku.text = wsS(old['sku']);
    barcode.text = wsS(old['barcode']);
    boxSpec.text = _numText(wsD(old['box_spec']));
    purchasePrice.text = _numText(wsD(old['purchase_price']));
    freight.text = _numText(wsD(old['freight']));
    bagWeight.text = _numText(wsD(old['bag_weight']));
    bagNetWeight.text = _numText(wsD(old['bag_net_weight']));
    bagNetUnit = wsS(old['bag_net_unit'], fallback: '克');
    dropshipCost.text = _numText(wsD(old['dropship_cost']));
    shelfLife.text = wsS(old['shelf_life']);
    remark.text = wsS(old['remark']);
    isActive = old['is_active'] == true;
    stockProductId = old['stock_product_id'] == null ? null : wsI(old['stock_product_id']);
    for (final raw in (old['pack_items'] as List?) ?? const []) {
      final it = _asMap(raw);
      packs.add(_PackRow(productId: wsI(it['product_id']), unit: wsS(it['unit'], fallback: '个'), qty: wsD(it['quantity'])));
    }
  }

  final Map<String, dynamic>? rec;
  final List<String> netUnits;
  final List<Map<String, dynamic>> _stockProducts;
  late final bool isEdit;
  int? stockProductId;
  String bagNetUnit = '克';
  bool isActive = true;
  final List<_PackRow> packs = [];

  final name = TextEditingController();
  final category = TextEditingController();
  final sku = TextEditingController();
  final barcode = TextEditingController();
  final boxSpec = TextEditingController();
  final purchasePrice = TextEditingController();
  final freight = TextEditingController();
  final bagWeight = TextEditingController();
  final bagNetWeight = TextEditingController();
  final dropshipCost = TextEditingController();
  final shelfLife = TextEditingController();
  final remark = TextEditingController();

  Map<String, dynamic>? _stock(int? id) {
    if (id == null) return null;
    for (final p in _stockProducts) {
      if (wsI(p['id']) == id) return p;
    }
    return null;
  }

  String? validate() {
    if (name.text.trim().isEmpty) return '请填写入仓品名称';
    if (!_kUnitGrams.containsKey(bagNetUnit)) return '每袋净重单位必须是重量单位（${netUnits.join(' / ')}）';
    for (final row in packs) {
      final product = _stock(row.productId);
      if (product == null) return '随货包材存在未选商品 / 商品不存在的行';
      if (_parse(row.quantityCtrl) <= 0) return '随货包材「每袋用量」必须大于 0';
      final units = (product['conversions'] as Map?)?.keys.map(wsS) ?? const <String>[];
      if (!units.contains(row.unit)) return '随货包材「${wsS(product['name'])}」不支持单位「${row.unit}」';
    }
    return null;
  }

  Map<String, dynamic> body() => {
        'name': name.text.trim(),
        'category': category.text.trim(),
        'sku': sku.text.trim(),
        'barcode': barcode.text.trim(),
        'box_spec': _parse(boxSpec),
        'purchase_price': _parse(purchasePrice),
        'freight': _parse(freight),
        'stock_product_id': stockProductId,
        'bag_weight': _parse(bagWeight),
        'bag_net_weight': _parse(bagNetWeight),
        'bag_net_unit': bagNetUnit,
        'dropship_cost': _parse(dropshipCost),
        'shelf_life': shelfLife.text.trim(),
        'remark': remark.text.trim(),
        'is_active': isActive,
        'pack_items': [
          for (final row in packs)
            if (row.productId != null)
              {'product_id': row.productId, 'quantity': _parse(row.quantityCtrl), 'unit': row.unit},
        ],
      };

  void dispose() {
    name.dispose();
    category.dispose();
    sku.dispose();
    barcode.dispose();
    boxSpec.dispose();
    purchasePrice.dispose();
    freight.dispose();
    bagWeight.dispose();
    bagNetWeight.dispose();
    dropshipCost.dispose();
    shelfLife.dispose();
    remark.dispose();
    for (final p in packs) {
      p.dispose();
    }
  }
}

/// 贴单导入预览的一行：可勾选，可改数量 / 采购价 / 运费 / 每袋净重 / 日期
class _ImportRow {
  _ImportRow(this.item, String defaultDate)
      : row = wsI(item['row']),
        productName = wsS(item['product_name']),
        purchaseNo = wsS(item['purchase_no']),
        center = wsS(item['center']),
        matchedName = wsS(item['matched_name']),
        productId = item['product_id'] == null ? null : wsI(item['product_id']),
        deduction = wsD(item['deduction_percent']),
        boxCountCtrl = TextEditingController(text: _numText(wsD(item['box_count']))),
        quantityCtrl = TextEditingController(text: _numText(wsD(item['quantity']))),
        weightCtrl = TextEditingController(text: _numText(wsD(item['bag_weight']))),
        priceCtrl = TextEditingController(text: _numText(wsD(item['unit_price']))),
        freightCtrl = TextEditingController(text: _numText(wsD(item['freight']))) {
    date = wsS(item['date']).isEmpty ? defaultDate : wsS(item['date']);
  }

  final Map<String, dynamic> item;
  final int row;
  final String productName;
  final String purchaseNo;
  final String center;
  final String matchedName;
  final double deduction;
  int? productId;
  bool checked = true;
  late String date;

  final TextEditingController boxCountCtrl;
  final TextEditingController quantityCtrl;
  final TextEditingController weightCtrl;
  final TextEditingController priceCtrl;
  final TextEditingController freightCtrl;

  double get quantity => _parse(quantityCtrl);
  double get unitPrice => _parse(priceCtrl);
  double get freight => _parse(freightCtrl);
  double get bagWeight => _parse(weightCtrl);
  bool get usable => checked && quantity > 0;

  /// 手动改选入仓品时同步带出采购价 / 运费 / 每袋净重
  void pickProduct(int? id, Map<String, dynamic>? p) {
    productId = id;
    if (p == null) return;
    priceCtrl.text = _numText(wsD(p['purchase_price']));
    freightCtrl.text = _numText(wsD(p['freight']));
    if (wsD(p['bag_weight']) > 0) weightCtrl.text = _numText(wsD(p['bag_weight']));
  }

  Map<String, dynamic> body(String fallbackDate) => {
        'product_id': productId,
        'product_name': matchedName.isEmpty ? productName : matchedName,
        'category': wsS(item['category']),
        'unit': '袋',
        'purchase_no': purchaseNo,
        'center': center,
        'quantity': quantity,
        'box_count': _parse(boxCountCtrl),
        'box_spec': wsD(item['box_spec']),
        'unit_price': unitPrice,
        'freight': freight,
        'bag_weight': bagWeight,
        'date': date.isEmpty ? fallbackDate : date,
        'remark': '',
      };

  void dispose() {
    boxCountCtrl.dispose();
    quantityCtrl.dispose();
    weightCtrl.dispose();
    priceCtrl.dispose();
    freightCtrl.dispose();
  }
}
