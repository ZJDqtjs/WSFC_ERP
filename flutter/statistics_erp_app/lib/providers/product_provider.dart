import 'package:flutter/material.dart';

import '../models/product.dart';
import '../services/api_service.dart';

class ProductProvider extends ChangeNotifier {
  List<Product> _products = [];
  bool _isLoading = false;

  List<Product> get products => _products;
  bool get isLoading => _isLoading;

  Future<void> loadProducts() async {
    _isLoading = true;
    notifyListeners();

    try {
      final data = await ApiService.get('/api/products');
      _products = (data as List)
          .where((p) => p['is_active'] == true)
          .map((p) => Product.fromJson(p))
          .toList();
    } catch (e) {
      // 忽略错误
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  List<Product> getStockProducts() {
    return _products
        .where((p) => p.productType == 'stock' && !['人工', '快递'].contains(p.category))
        .toList();
  }

  List<Product> getSaleProducts() {
    return _products
        .where((p) => !['人工', '快递'].contains(p.category))
        .toList();
  }

  Product? getProductById(int id) {
    try {
      return _products.firstWhere((p) => p.id == id);
    } catch (e) {
      return null;
    }
  }
}
