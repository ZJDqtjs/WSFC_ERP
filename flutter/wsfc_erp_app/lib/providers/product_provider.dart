import 'package:flutter/material.dart';

import '../models/product.dart';
import '../services/api_service.dart';

/// 商品表的唯一数据源：出库 / 入库的商品选择页都只认它。
///
/// 之前两个选择页各自在 initState 里 GET 一遍 /api/products 再逐条 fromJson，
/// 打开一次选择要串行等一个完整往返，切来切去还得重拉。这里解析结果全 App 共享一份：
/// 命中 ApiService 的短时缓存时既不请求也不重新解析，只有那份数据被换过（回源或写操作作废）
/// 才重算一次。
class ProductProvider extends ChangeNotifier {
  static const String _source = '/api/products';

  List<Product> _all = const [];
  int _version = 0;
  bool _isLoading = false;
  String? _error;
  Future<void>? _inFlight;

  List<Product> get products => _all;
  bool get isLoading => _isLoading;
  String? get error => _error;

  /// 有数据且后端那份没换过就立刻返回；否则回源，并发调用共用同一个请求。
  Future<void> ensureLoaded() {
    if (_version != 0 && _version == ApiService.dataVersion(_source)) return Future.value();
    return _inFlight ??= _load();
  }

  Future<void> _load() async {
    _isLoading = true;
    _error = null;
    notifyListeners();
    try {
      final data = await ApiService.products();
      _all = data
          .whereType<Map>()
          .where((p) => p['is_active'] == true)
          .map((p) => Product.fromJson(Map<String, dynamic>.from(p)))
          .toList();
      _version = ApiService.dataVersion(_source);
    } on ApiException catch (e) {
      // 原来这里直接吞掉异常，选择页只会显示「无匹配商品」，看不出是没连上后端
      _error = e.message;
      _version = 0;
    } finally {
      _inFlight = null;
      _isLoading = false;
      notifyListeners();
    }
  }

  /// 入库只选库存商品
  List<Product> getStockProducts() => _where((p) => p.productType == 'stock');

  /// 出库销售：订单商品也允许
  List<Product> getSaleProducts() => _where((_) => true);

  Product? getProductById(int id) {
    for (final p in _all) {
      if (p.id == id) return p;
    }
    return null;
  }

  List<Product> _where(bool Function(Product p) test) =>
      _all.where((p) => !['人工', '快递'].contains(p.category) && test(p)).toList();
}
