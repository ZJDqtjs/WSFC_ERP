import 'package:flutter/material.dart';

import '../desktop_style.dart';
import 'desktop_ui.dart';

/// 出库批次（同一 import_group 折叠出来的多张出库单）的聚合明细。
///
/// 口径逐条对齐 web `outgroup.vue`：先按「商品@@单位」聚合出销售 / 耗材 / 人工 /
/// 打包+耗材四类，再把每张单里的 pack 行成本摊回它归属的销售商品上——
/// 不摊的话销售商品的毛利会虚高，因为打包人工、耗材、快递费都记在 pack 行。
class OutBatchDetail extends StatefulWidget {
  const OutBatchDetail({
    super.key,
    required this.records,
    this.onOpenOrder,
  });

  final List<Map<String, dynamic>> records;

  /// 点开批次里某一张单的原行明细
  final void Function(Map<String, dynamic> order)? onOpenOrder;

  @override
  State<OutBatchDetail> createState() => _OutBatchDetailState();
}

class _OutBatchDetailState extends State<OutBatchDetail> {
  static const List<String> _segLabels = <String>['销售商品', '耗材/包装', '人工', '打包+耗材'];

  int _seg = 0;
  String _kw = '';

  late final List<OutAggRow> _sale = outAggregateSale(widget.records);
  late final List<OutAggRow> _pack = outAggregate(widget.records, OutAggPool.pack);
  late final List<OutAggRow> _labor = outAggregate(widget.records, OutAggPool.labor);
  late final List<OutAggRow> _laborPack = outAggregate(widget.records, OutAggPool.laborPack);
  late final OutBatchTotal _total = outBatchTotal(widget.records);

  List<OutAggRow> get _pool => switch (_seg) {
        0 => _sale,
        1 => _pack,
        2 => _labor,
        _ => _laborPack,
      };

  List<OutAggRow> get _current {
    final String k = _kw.trim().toLowerCase();
    if (k.isEmpty) return _pool;
    return _pool.where((a) {
      final String mode = _seg == 0 ? (a.isDropship ? '代发 外发' : '库存出库') : '';
      return '${a.name} ${a.sub} $mode'.toLowerCase().contains(k);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final List<OutAggRow> rows = _current;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _Stat('批次单数', '${widget.records.length} 单'),
            _Stat('销售商品种数', '${_sale.length} 种'),
            _Stat('耗材种数', '${_pack.length} 种'),
            _Stat('人工种数', '${_labor.length} 种'),
            _Stat('销售收入', wsMoney(_total.amount)),
            _Stat('结转成本', wsMoney(_total.cogs)),
            if (_total.brush != 0) _Stat('刷单成本', wsMoney(_total.brush), color: WsTokens.red),
            _Stat('打包费', wsMoney(_total.fee)),
            _Stat('净利', wsMoney(_total.net), color: _total.net >= 0 ? WsTokens.green : WsTokens.red),
          ],
        ),
        if (widget.onOpenOrder != null) ...[
          const SizedBox(height: 12),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                '本批单据（${widget.records.length}）',
                style: TextStyle(fontSize: 12, color: WsTokens.inkOf(context, level: 3)),
              ),
              for (final o in widget.records)
                Tooltip(
                  message: '${wsS(o['date'])} · ${wsS(o['customer'], fallback: '—')}'
                      ' · 实收 ${wsMoney(wsD(o['final_amount']))}',
                  child: DesktopLink(wsS(o['code']), onPressed: () => widget.onOpenOrder!(o)),
                ),
            ],
          ),
        ],
        const SizedBox(height: 12),
        Row(
          children: [
            DesktopTabs(
              small: true,
              items: _segLabels,
              index: _seg,
              onChanged: (i) => setState(() => _seg = i),
            ),
            const SizedBox(width: 12),
            DesktopTextField(
              width: 220,
              hintText: '搜索商品${_seg == 0 ? '（可输「代发」/「库存」）' : ''}',
              onChanged: (v) => setState(() => _kw = v),
            ),
            const Spacer(),
            Text(
              '共 ${rows.length} 条',
              style: TextStyle(fontSize: 12, color: WsTokens.inkOf(context, level: 3)),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (rows.isEmpty)
          Container(
            height: 72,
            alignment: Alignment.center,
            child: Text(
              '无记录',
              style: TextStyle(fontSize: 12.5, color: WsTokens.inkOf(context, level: 3)),
            ),
          )
        else
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              for (final a in rows)
                SizedBox(width: _seg == 0 ? 352 : 288, child: _card(context, a)),
            ],
          ),
      ],
    );
  }

  Widget _card(BuildContext context, OutAggRow a) {
    final bool sale = _seg == 0;
    final double gross = a.amount - a.cogs;
    final String costSplit = outCostSplitText(a);
    final String second = switch (_seg) {
      0 => '${_qty(a.qty)} ${a.unit} · 金额 ${wsMoney(a.amount)}',
      1 => '${_qty(a.qty)} ${a.unit} · 成本 ${wsMoney(a.cogs)}',
      2 => '${_qty(a.qty)} ${a.unit} · 成本 ${wsMoney(a.cogs)}',
      _ => '成本 ${wsMoney(a.cogs)}',
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 11),
      decoration: BoxDecoration(
        color: WsTokens.fill(context, alpha: 0.55),
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: WsTokens.line(context, alpha: 0.9)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Tooltip(
                  message: a.name,
                  child: Text(
                    a.name,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              DesktopTag(
                '${a.orderCount} 单',
                color: sale ? WsTokens.primary : DesktopTag.off,
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Text(
                  second,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, color: WsTokens.inkOf(context, level: 2)),
                ),
              ),
              if (sale && a.dropshipQty > 0)
                const DesktopTag('代发', color: WsTokens.amber),
            ],
          ),
          if (sale && a.specs.isNotEmpty)
            _faint(context, '规格 ${a.specs.join(' / ')}'),
          if (sale) ...[
            const SizedBox(height: 2),
            Row(
              children: [
                Expanded(
                  child: Text.rich(
                    TextSpan(
                      style: TextStyle(
                          fontSize: 12.5, color: WsTokens.inkOf(context, level: 2)),
                      children: [
                        const TextSpan(text: '成本 '),
                        TextSpan(text: wsMoney(a.cogs)),
                        const TextSpan(text: ' · 毛利 '),
                        TextSpan(
                          text: wsMoney(gross),
                          style: TextStyle(
                            fontWeight: FontWeight.w700,
                            color: gross >= 0 ? WsTokens.green : WsTokens.red,
                          ),
                        ),
                        TextSpan(text: ' · 毛利率 ${a.gpRate.toStringAsFixed(1)}%'),
                      ],
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            if (costSplit.isNotEmpty) _faint(context, costSplit),
          ],
          if (!sale) ...[
            if (a.subSub.isNotEmpty) _faint(context, a.subSub),
            if (a.subSub.isEmpty && a.sub.isNotEmpty) _faint(context, a.sub),
          ],
        ],
      ),
    );
  }

  Widget _faint(BuildContext context, String text) => Padding(
        padding: const EdgeInsets.only(top: 3),
        child: Tooltip(
          message: text,
          child: Text(
            text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11.5, height: 1.45, color: WsTokens.inkOf(context, level: 3)),
          ),
        ),
      );
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value, {this.color});

  final String label;
  final String value;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: WsTokens.fill(context, alpha: 0.9),
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: WsTokens.line(context, alpha: 0.8)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(fontSize: 11.5, color: WsTokens.inkOf(context, level: 3)),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: color ?? WsTokens.inkOf(context),
            ),
          ),
        ],
      ),
    );
  }
}

// ------------------------------------------------------------------ 聚合逻辑

enum OutAggPool { sale, pack, labor, laborPack }

/// 聚合后的一行（对应 web 的 agg 对象）
class OutAggRow {
  OutAggRow({
    required this.key,
    required this.pid,
    required this.name,
    required this.sub,
    required this.unit,
  });

  final String key;
  final int pid;
  final String name;
  String sub;
  final String unit;

  final Set<int> orders = {};
  final Set<String> specs = {};
  final Set<String> boxes = {};

  bool hasBox = false;
  bool isDropship = false;

  double qty = 0;
  double amount = 0;
  double cogs = 0;
  double grossSales = 0;
  double dropshipQty = 0;

  /// 从 pack 行摊回销售商品的成本构成，只有销售池会填
  double laborCogs = 0;
  double materialCogs = 0;
  double otherCogs = 0;
  double expressCogs = 0;
  double brushCogs = 0;
  double baseCogs = 0;
  double packCogs = 0;
  double gpRate = 0;

  int get orderCount => orders.length;

  String get subSub {
    if (!hasBox || boxes.isEmpty) return '';
    final String bx = boxes.join(' + ');
    return sub.isEmpty ? '纸箱:$bx' : '$sub · 纸箱:$bx';
  }
}

class OutBatchTotal {
  OutBatchTotal({
    required this.amount,
    required this.cogs,
    required this.fee,
    required this.brush,
  });

  final double amount;
  final double cogs;
  final double fee;
  final double brush;

  double get net => amount - cogs - fee - brush;
}

OutBatchTotal outBatchTotal(List<Map<String, dynamic>> records) => OutBatchTotal(
      amount: records.fold<double>(0, (s, o) => s + wsD(o['total_amount'])),
      cogs: records.fold<double>(0, (s, o) => s + wsD(o['total_cogs'])),
      fee: records.fold<double>(0, (s, o) => s + wsD(o['total_fee'])),
      brush: records.fold<double>(0, (s, o) => s + wsD(o['brush_adjust'])),
    );

List<Map<String, dynamic>> _linesOf(Map<String, dynamic> o) => [
      for (final l in ((o['lines'] as List?) ?? const []))
        if (l is Map) Map<String, dynamic>.from(l),
    ];

/// 按池聚合：销售 / 耗材 / 人工 / 打包+耗材，键分别是「商品@@单位」或归属人键
List<OutAggRow> outAggregate(List<Map<String, dynamic>> records, OutAggPool pool) {
  final bool isPackPool = pool == OutAggPool.pack;
  final Map<String, OutAggRow> map = {};
  for (final o in records) {
    final List<Map<String, dynamic>> lines = _linesOf(o);
    final List<Map<String, dynamic>> saleLines =
        lines.where((l) => wsS(l['line_type']) == 'sale').toList();
    final String ruleName =
        wsS(o['pack_rule_name']).isNotEmpty ? wsS(o['pack_rule_name']) : wsS(o['multi_rule']);
    final int orderId = wsI(o['id']);
    for (final l in lines) {
      final bool isLabor = l['is_labor'] == true;
      final String lineType = wsS(l['line_type']);
      final bool keep = switch (pool) {
        OutAggPool.sale => lineType == 'sale',
        OutAggPool.pack => lineType == 'pack' && !isLabor,
        OutAggPool.labor => lineType == 'pack' && isLabor,
        OutAggPool.laborPack => lineType == 'pack',
      };
      if (!keep) continue;

      final String unit = wsS(l['unit']);
      String k;
      String name;
      String sub;
      if (pool == OutAggPool.sale || isPackPool) {
        k = '${wsI(l['product_id'])}@@$unit';
        name = wsS(l['product_name']);
        sub = '';
      } else {
        final _Owner own = _packOwner(o, l, saleLines, ruleName);
        k = own.key;
        name = own.name;
        sub = own.sub;
      }
      final OutAggRow a = map.putIfAbsent(
        k,
        () => OutAggRow(
          key: k,
          pid: wsI(l['product_id']),
          name: name,
          sub: sub,
          unit: unit,
        ),
      );
      a.orders.add(orderId);
      a.qty += wsD(l['quantity']);
      a.amount += wsD(l['amount']);
      a.cogs += wsD(l['cogs']);
      final double gs = wsD(l['gross_sales']);
      a.grossSales += gs != 0 ? gs : wsD(l['amount']);
      if (pool == OutAggPool.sale) {
        final String spec = wsS(l['spec']);
        if (spec.isNotEmpty) a.specs.add(spec);
        if (l['is_dropship'] == true) {
          a.isDropship = true;
          // 代发不扣库存，只记代发数量
          a.dropshipQty += wsD(l['quantity']);
        }
      }
      if (a.sub.isEmpty && sub.isNotEmpty) a.sub = sub;
      if (pool == OutAggPool.laborPack && lineType == 'pack' && !isLabor) {
        a.hasBox = true;
        a.boxes.add(wsS(l['product_name']));
      }
    }
  }
  final List<OutAggRow> rows = map.values.toList()
    ..sort((x, y) => (y.amount + y.cogs).compareTo(x.amount + x.cogs));
  return rows;
}

/// 销售池 + 把每张单的 pack 行成本摊回所属销售商品（毛利口径）
List<OutAggRow> outAggregateSale(List<Map<String, dynamic>> records) {
  final List<OutAggRow> data = outAggregate(records, OutAggPool.sale);
  final Map<int, List<OutAggRow>> byPid = {};
  for (final a in data) {
    (byPid[a.pid] ??= <OutAggRow>[]).add(a);
  }

  void spread(int pid, double amt, _CostField field) {
    final List<OutAggRow>? arr = byPid[pid];
    if (arr == null || arr.isEmpty || amt == 0) return;
    final double each = amt / arr.length;
    for (final a in arr) {
      switch (field) {
        case _CostField.labor:
          a.laborCogs += each;
        case _CostField.material:
          a.materialCogs += each;
        case _CostField.other:
          a.otherCogs += each;
        case _CostField.express:
          a.expressCogs += each;
        case _CostField.brush:
          a.brushCogs += each;
      }
    }
  }

  for (final o in records) {
    final List<Map<String, dynamic>> lines = _linesOf(o);
    final List<Map<String, dynamic>> saleLines =
        lines.where((l) => wsS(l['line_type']) == 'sale').toList();
    final double totalAmt = saleLines.fold<double>(0, (s, l) => s + wsD(l['amount']));
    final List<Map<String, dynamic>> unowned = [];
    for (final l in lines) {
      if (wsS(l['line_type']) != 'pack') continue;
      // 没有明确归属商品的 pack 行，按销售金额占比摊
      if (l['sale_product_id'] == null) {
        unowned.add(l);
        continue;
      }
      spread(wsI(l['sale_product_id']), wsD(l['cogs']), _packField(l));
    }
    if (unowned.isNotEmpty && saleLines.isNotEmpty) {
      for (final l in unowned) {
        for (final sl in saleLines) {
          final double share =
              totalAmt != 0 ? wsD(sl['amount']) / totalAmt : 1 / saleLines.length;
          spread(wsI(sl['product_id']), wsD(l['cogs']) * share, _packField(l));
        }
      }
    }
    // 刷单结算：整单金额按该单销售金额占比分摊到商品
    final double brush = wsD(o['brush_adjust']);
    if (brush != 0 && saleLines.isNotEmpty) {
      for (final sl in saleLines) {
        final double share =
            totalAmt != 0 ? wsD(sl['amount']) / totalAmt : 1 / saleLines.length;
        spread(wsI(sl['product_id']), brush * share, _CostField.brush);
      }
    }
  }

  for (final a in data) {
    a.baseCogs = a.cogs;
    a.packCogs = a.laborCogs + a.materialCogs + a.otherCogs;
    a.cogs = a.baseCogs + a.packCogs + a.expressCogs + a.brushCogs;
    final double denom = a.grossSales != 0 ? a.grossSales : a.amount;
    a.gpRate = denom == 0 ? 0 : (a.amount - a.cogs) / denom * 100;
  }
  data.sort((x, y) => y.amount.compareTo(x.amount));
  return data;
}

/// 关联结算行归类：快递 / 人工 / 耗材 / 其他（与后端 report.py 的 PACK_FIELD_OF_CAT 对齐）
_CostField _packField(Map<String, dynamic> l) {
  final String category = wsS(l['category']);
  if (category == '快递') return _CostField.express;
  if (l['is_labor'] == true) return _CostField.labor;
  if (category == '包材' || category == '耗材' || category == '包装') return _CostField.material;
  return _CostField.other;
}

enum _CostField { labor, material, other, express, brush }

/// 成本构成小字：商品/代发成本 ＋ 打包人工 ＋ 耗材 ＋ 其他关联结算 ＋ 快递费 ＋ 刷单成本
String outCostSplitText(OutAggRow a) {
  if (!(a.isDropship ||
      a.laborCogs != 0 ||
      a.materialCogs != 0 ||
      a.otherCogs != 0 ||
      a.expressCogs != 0 ||
      a.brushCogs != 0)) {
    return '';
  }
  final List<String> parts = <String>[
    '${a.isDropship ? '代发成本' : '商品成本'} ${wsMoney(a.baseCogs)}',
    if (a.laborCogs != 0) '打包人工 ${wsMoney(a.laborCogs)}',
    if (a.materialCogs != 0) '耗材 ${wsMoney(a.materialCogs)}',
    if (a.otherCogs != 0) '其他关联结算 ${wsMoney(a.otherCogs)}',
    if (a.expressCogs != 0) '快递费 ${wsMoney(a.expressCogs)}',
    if (a.brushCogs != 0) '刷单成本 ${wsMoney(a.brushCogs)}',
  ];
  return parts.join(' ＋ ');
}

class _Owner {
  _Owner(this.key, this.name, this.sub);
  final String key;
  final String name;
  final String sub;
}

/// pack 行归属哪个销售商品：优先 sale_product_id，其次整单打包规则
_Owner _packOwner(
  Map<String, dynamic> o,
  Map<String, dynamic> l,
  List<Map<String, dynamic>> saleLines,
  String ruleName,
) {
  final dynamic spRaw = l['sale_product_id'];
  if (spRaw != null) {
    final int spId = wsI(spRaw);
    Map<String, dynamic>? sp;
    for (final x in saleLines) {
      if (wsI(x['product_id']) == spId) {
        sp = x;
        break;
      }
    }
    final String sname = _firstOf([
      wsS(l['sale_product_name']),
      if (sp != null) wsS(sp['product_name']),
      wsS(l['product_name']),
    ]);
    final String sub = [
      if (ruleName.isNotEmpty) '规则:$ruleName',
      if (sp != null) wsS(sp['spec']),
    ].where((x) => x.isNotEmpty).join(' · ');
    final String ruleKey = ruleName.isEmpty ? '' : '@@${_ruleIdOf(o, ruleName)}';
    return _Owner('sp$spId$ruleKey', sname, sub);
  }
  if (ruleName.isNotEmpty) {
    final String names =
        saleLines.map((s) => wsS(s['product_name'])).where((n) => n.isNotEmpty).join(' + ');
    final String detail = [
      for (final s in saleLines)
        if (wsS(s['product_name']).isNotEmpty) '${wsS(s['product_name'])}:${wsS(s['spec'])}',
    ].join('；');
    return _Owner(
      'rule${_ruleIdOf(o, ruleName)}',
      names.isEmpty ? ruleName : names,
      ['规则:$ruleName', if (detail.isNotEmpty) detail].join(' · '),
    );
  }
  return _Owner('p${wsI(l['product_id'])}', wsS(l['product_name']), '');
}

String _ruleIdOf(Map<String, dynamic> o, String ruleName) {
  final dynamic raw = o['pack_rule_id'];
  return (raw == null || wsI(raw) == 0) ? ruleName : wsS(raw);
}

String _firstOf(List<String> values) {
  for (final v in values) {
    if (v.isNotEmpty) return v;
  }
  return '';
}

String _qty(double v) => wsTrim(v, digits: 3);
