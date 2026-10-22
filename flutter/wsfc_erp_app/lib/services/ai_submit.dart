import 'api_service.dart';

/// 把 /api/ai/* 识别出来的单据落库，口径与网页端 submitDocRows 一致：
/// 识别阶段后端不写库，点提交时才先把「新物品」建成商品档案，再按业务类型分单。
///
/// 出库的包材/快递/固定成本是整单口径，一旦按日期或付款状态拆成多张单就没法分摊，
/// 所以只在单张单时才挂附加项，避免同一笔包材重复计费。
class AiSubmit {
  static Future<int> doc(Map<String, dynamic> r) async {
    final type = _txt(r['type']);
    final lines = <Map<String, dynamic>>[
      for (final e in (r['lines'] as List? ?? const [])) Map<String, dynamic>.from(e as Map),
    ];
    final remark = _txt(r['remark']);
    final imageUrl = _txt(r['image_url']);
    final invoice = imageUrl.isEmpty ? '' : '[票据] $imageUrl';
    final party = switch (type) {
      'outbound' => _txt(r['customer']),
      'inbound' => _txt(r['supplier']),
      _ => '',
    };

    final pending =
        lines.where((e) => _id(e['product_id']) == null && e['new_product'] is Map).toList();
    if (pending.isNotEmpty) {
      final created = await ApiService.aiMaterialize([
        for (final e in pending) _newProductOf(e),
      ]);
      for (var i = 0; i < pending.length && i < created.length; i++) {
        final c = created[i];
        if (c is Map) pending[i]['product_id'] = c['product_id'];
      }
    }

    final ok = lines.where((e) => _id(e['product_id']) != null).toList();
    if (ok.isEmpty) throw ApiException(null, '商品创建失败，请稍后重试');

    switch (type) {
      case 'stocktake':
        return _submitStocktake(ok, r, remark, invoice);
      case 'inbound':
        return _submitInbound(ok, r, remark, invoice, party);
      default:
        return _submitOutbound(ok, r, remark, invoice, party);
    }
  }

  static Future<int> _submitStocktake(
    List<Map<String, dynamic>> ok,
    Map<String, dynamic> r,
    String remark,
    String invoice,
  ) async {
    var n = 0;
    for (final e in ok) {
      // 后端算好的增减量（实盘 − 当前库存）；识别接口没给时退回原始数量
      final delta = e.containsKey('stock_adjust') ? _num(e['stock_adjust']) : _num(e['quantity']);
      if (delta == 0) continue; // 增减为 0 等于没调整
      final rmk = _join([remark, invoice]);
      await ApiService.adjust(
        productId: _id(e['product_id'])!,
        date: _dateOf(e, r),
        quantity: '${delta > 0 ? '+' : ''}${_trim(delta)}',
        unit: _txt(e['unit']),
        remark: rmk.isEmpty ? 'AI盘点' : rmk,
      );
      n++;
    }
    return n;
  }

  static Future<int> _submitInbound(
    List<Map<String, dynamic>> ok,
    Map<String, dynamic> r,
    String remark,
    String invoice,
    String party,
  ) async {
    for (final e in ok) {
      await ApiService.post('/api/inbounds', data: {
        'product_id': _id(e['product_id']),
        'unit': _txt(e['unit']),
        'quantity': _num(e['quantity']),
        'unit_price': _num(e['unit_price']),
        'supplier': party,
        'date': _dateOf(e, r),
        'remark': _join([
          invoice,
          if (e['auto_created'] == true) '[AI自动新增]',
          remark,
        ]),
        'pay_status': e['paid'] == true ? 'paid' : 'unpaid',
      });
    }
    return ok.length;
  }

  static Future<int> _submitOutbound(
    List<Map<String, dynamic>> ok,
    Map<String, dynamic> r,
    String remark,
    String invoice,
    String party,
  ) async {
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final e in ok) {
      final key = '${_dateOf(e, r)}|${e['paid'] == true ? 'paid' : 'unpaid'}';
      groups.putIfAbsent(key, () => []).add(e);
    }
    final charges = groups.length == 1 ? _chargesOf(r) : null;

    for (final entry in groups.entries) {
      final parts = entry.key.split('|');
      final payload = <String, dynamic>{
        'customer': party,
        'date': parts[0],
        'pay_status': parts[1],
        'remark': _join([invoice, remark, if (charges != null) charges['remark']]),
        'lines': [
          for (final e in entry.value)
          {
              'product_id': _id(e['product_id']),
              'unit': _txt(e['unit']),
              'quantity': _num(e['quantity']),
              'price': _num(e['unit_price']),
            }
        ],
        'pack_lines': charges?['pack_lines'] ?? const [],
        'auto_express': charges?['auto_express'] ?? true,
      };
      if (charges != null) {
        payload['pack_fee_total'] = charges['fee_total'];
        payload['settle_cats'] = charges['settle_cats'];
      }
      await ApiService.post('/api/outbounds', data: payload);
    }
    return ok.length;
  }

  /// 识别结果里的附加项 → 提交口径（服务端会按 pack_lines 重算成本）。
  static Map<String, dynamic>? _chargesOf(Map<String, dynamic> r) {
    if (r['type'] != 'outbound') return null;
    List<Map<String, dynamic>> src(String key) => [
          for (final p in (r[key] as List? ?? const [])) Map<String, dynamic>.from(p as Map),
        ];
    // 商品包装清单自动带出的行：cogs 交回服务端重算，别把识别时的旧成本写死
    final auto = [
      for (final p in src('pack_lines'))
        if (p['source'] != '识别')
          {'product_id': p['product_id'], 'unit': p['unit'], 'quantity': p['quantity'], 'cogs': null}
    ];
    // 识别/用户改过的项目：按金额记的要用服务端算好的显式成本，才和结算表一致
    final extra = [
      for (final p in src('extra_pack_lines'))
        {
          'product_id': p['product_id'],
          'unit': p['unit'],
          'quantity': p['quantity'],
          'cogs': p['cogs'],
        }
    ];
    final cats = _txt(r['settle_cats']).split(',').where((s) => s.isNotEmpty).toList();
    final feeNote = _txt(r['fee_note']);
    return {
      'pack_lines': [...auto, ...extra],
      'fee_total': _num(r['fee_total']),
      // 出库是手动单，客户随货款一起付回包材/人工/快递；没识别到口径时兜底全勾
      'settle_cats': cats.isEmpty ? const ['material', 'labor', 'express'] : cats,
      'auto_express': r['auto_express'] != false,
      'remark': feeNote.isEmpty ? '' : '【包材人工固定成本】$feeNote',
    };
  }

  static Map<String, dynamic> _newProductOf(Map<String, dynamic> e) {
    final np = Map<String, dynamic>.from(e['new_product'] as Map);
    final unit = _txt(e['unit']).isNotEmpty
        ? _txt(e['unit'])
        : (_txt(np['unit']).isNotEmpty ? _txt(np['unit']) : '个');
    final category = _txt(np['category']);
    return {
      'name': _txt(np['name']).trim(),
      'category': category.isEmpty ? 'stock' : category,
      'unit': unit,
    };
  }

  static String _dateOf(Map<String, dynamic> e, Map<String, dynamic> r) {
    final d = _txt(e['date']);
    return d.isEmpty ? _txt(r['date']) : d;
  }

  static int? _id(dynamic v) {
    final n = v is num ? v.toInt() : int.tryParse(_txt(v));
    return (n == null || n <= 0) ? null : n;
  }

  static double _num(dynamic v) => v is num ? v.toDouble() : double.tryParse(_txt(v)) ?? 0;

  static String _txt(dynamic v) => (v ?? '').toString();

  static String _join(Iterable<String> parts) => parts.where((s) => s.isNotEmpty).join(' ');

  /// /api/adjust 要带符号的相对值串，去掉 toStringAsFixed 补出来的尾零。
  static String _trim(double v) {
    var s = v.toStringAsFixed(6);
    if (s.contains('.')) {
      s = s.replaceAll(RegExp(r'0+$'), '').replaceAll(RegExp(r'\.$'), '');
    }
    return s == '-0' ? '0' : s;
  }
}
