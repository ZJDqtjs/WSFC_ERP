// 联调冒烟：用 Dart 客户端（dio，与 App 同一套依赖）真实打 Go 服务，
// 断言每个页面用到的接口状态码与关键字段，顺便用 Product.fromJson 解析真实响应。
//
// 用法：
//   dart run tool/api_smoke.dart <baseUrl> <token>
// 退出码非 0 表示有断言失败。
import 'dart:io';

import 'package:dio/dio.dart';

import 'package:statistics_erp_app/models/product.dart';

final List<String> _failures = [];
int _checked = 0;

Future<void> main(List<String> args) async {
  final base = args.isNotEmpty ? args[0] : 'http://127.0.0.1:8123';
  final token = args.length > 1 ? args[1] : (Platform.environment['ERP_TOKEN'] ?? '');
  if (token.isEmpty) {
    stderr.writeln('缺少 token：dart run tool/api_smoke.dart <baseUrl> <token>');
    exit(2);
  }
  final dio = Dio(BaseOptions(
    baseUrl: base,
    headers: {'cookie': 'erp_token=$token'},
    responseType: ResponseType.json,
    validateStatus: (_) => true,
    followRedirects: false,
  ));
  final today = DateTime.now().toIso8601String().substring(0, 10);

  // 1) 会话
  final me = await _get(dio, '/api/auth/me');
  _need(me, ['id', 'username', 'role']);

  // 2) 工作台
  final dash = await _get(dio, '/api/dashboard');
  _need(dash, ['today_summary', 'month_summary', 'stock_value', 'product_count']);

  // 3) 商品：真实响应直接走模型，验证 conversions 是 1 还是 1.0 都不会崩
  final products = await _getList(dio, '/api/products');
  _need(products.isEmpty ? null : products.first,
      ['id', 'name', 'product_type', 'base_unit', 'conversions', 'stock_links']);
  var parsed = 0;
  for (final p in products) {
    Product.fromJson(Map<String, dynamic>.from(p));
    parsed++;
  }
  _ok(parsed > 0, 'Product.fromJson 解析 $parsed 条商品');

  final stocks = await _getList(dio, '/api/stocks');
  _need(stocks.isEmpty ? null : stocks.first, ['id', 'name', 'default_unit']);
  await _getList(dio, '/api/units');

  // 4) 库存三件套
  final overview = await _getList(dio, '/api/stock-overview');
  _need(overview.isEmpty ? null : overview.first,
      ['id', 'name', 'stock', 'stock_display', 'avg_cost', 'default_unit']);
  final movements = await _get(dio, '/api/movements?limit=5');
  _need(movements, ['rows', 'total', 'truncated']);
  final rows = (movements['rows'] as List);
  if (rows.isNotEmpty) {
    _need(rows.first as Map, ['date', 'move_type', 'quantity_base', 'product_name']);
  }
  await _get(dio, '/api/movements/chart?limit=30');
  await _getList(dio, '/api/adjustments?limit=5');
  await _get(dio, '/api/workload?date_from=2026-01-01&date_to=$today');

  // 5) 单据与账单
  await _getList(dio, '/api/inbounds?limit=3');
  final outbounds = await _get(dio, '/api/outbounds?date_from=2026-01-01&date_to=$today&limit=2');
  final outList = outbounds is List ? outbounds : (outbounds['rows'] as List? ?? const []);
  _ok(outList.isNotEmpty || outbounds is List, '出库列表可解析');
  await _get(dio, '/api/payables?days=30');
  await _get(dio, '/api/payables/dropship?limit=5');

  // 6) 开销 / 财务 / 规则 / 鲜货
  await _getList(dio, '/api/other-expenses?date_from=2026-01-01&date_to=$today');
  final stats = await _get(dio, '/api/other-expenses/stats?date_from=2026-01-01&date_to=$today');
  _need(stats, ['range_total', 'range_count', 'by_category', 'presets']);
  await _getList(dio, '/api/finance?date_from=2026-01-01&date_to=$today');
  await _getList(dio, '/api/deductions');
  await _get(dio, '/api/deductions/shops');
  final express = await _get(dio, '/api/express/rule');
  _need(express, ['mode']);
  await _getList(dio, '/api/pack-rules');
  await _get(dio, '/api/fresh?date=$today');
  await _get(dio, '/api/fresh/options');
  final warehouses = await _get(dio, '/api/warehouses');
  _need(warehouses, ['current', 'warehouses']);
  await _get(dio, '/api/maintenance/status');
  await _get(dio, '/api/_meta/routes');

  // 7) 错误信封：Go 必须给中文 detail
  final missing = await dio.delete('/api/products/999999');
  _ok(missing.statusCode == 404 && (missing.data['detail'] is String),
      '删不存在的商品 → ${missing.statusCode} ${missing.data['detail']}');

  if (_failures.isEmpty) {
    stdout.writeln('✓ Dart 客户端联调通过：$_checked 项断言全部成立（$base）');
  } else {
    stderr.writeln('✗ 失败 ${_failures.length} 项：');
    for (final f in _failures) {
      stderr.writeln('  - $f');
    }
    exit(1);
  }
}

Future<dynamic> _get(Dio dio, String path) async {
  final res = await dio.get<dynamic>(path);
  _ok(res.statusCode == 200, 'GET $path → ${res.statusCode}');
  if (res.statusCode == 200 && res.data is Map && res.data['detail'] != null) {
    _failures.add('GET $path 返回了 detail：${res.data['detail']}');
  }
  return res.data;
}

Future<List<Map<String, dynamic>>> _getList(Dio dio, String path) async {
  final data = await _get(dio, path);
  if (data is List) {
    return data.map((e) => Map<String, dynamic>.from(e as Map)).toList();
  }
  _failures.add('GET $path 期望裸数组，实际是 ${data.runtimeType}');
  return const [];
}

void _need(dynamic obj, List<String> keys) {
  if (obj is! Map) {
    _failures.add('响应不是对象：$obj');
    return;
  }
  for (final k in keys) {
    _checked++;
    if (!obj.containsKey(k)) {
      _failures.add('响应缺少字段 $k（实际字段：${obj.keys.take(8).join(',')}…）');
    }
  }
}

void _ok(bool cond, String label) {
  _checked++;
  if (!cond) {
    _failures.add(label);
  } else {
    stdout.writeln('  ✓ $label');
  }
}
