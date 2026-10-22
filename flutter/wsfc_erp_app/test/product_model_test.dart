import 'package:flutter_test/flutter_test.dart';
import 'package:wsfc_erp/models/product.dart';

/// 契约测试：样例数据取自 Go 服务 /api/products 的真实响应片段。
///
/// 关键点：Go 的 JSON 编码器会把 1.0 写成 1（整数形态），
/// 模型层若假设一定是 double 就会在真机上崩，所以这里专门覆盖。
void main() {
  group('Product.fromJson', () {
    test('整数值换算表可以解析为 double', () {
      final p = Product.fromJson({
        'id': 229,
        'code': '',
        'name': '10号纸箱',
        'category': '包材',
        'product_type': 'stock',
        'base_unit': '个',
        'default_unit': '个',
        'spec': '',
        'sale_price': 0,
        'unit_cost': 1.5,
        'avg_cost': 1.25,
        'conversions': {'个': 1, '打': 12},
        'pack_items': [],
        'pack_fee': 0,
        'is_active': true,
        'stock_product_id': null,
        'multiplier': 1,
        'stock': 0,
        'stock_value': 0,
      });
      expect(p.id, 229);
      expect(p.conversions, {'个': 1.0, '打': 12.0});
      expect(p.conversions!['打'], isA<double>());
      expect(p.salePrice, 0.0);
      expect(p.avgCost, 1.25);
      expect(p.multiplier, 1.0);
      expect(p.isActive, isTrue);
      expect(p.stockProductId, isNull);
    });

    test('缺字段时给安全默认值', () {
      final p = Product.fromJson({'id': 1, 'name': '土豆'});
      expect(p.productType, 'stock');
      expect(p.multiplier, 1.0);
      expect(p.conversions, isNull);
      expect(p.packItems, isEmpty);
    });

    test('数字以字符串返回时也不会崩', () {
      final p = Product.fromJson({
        'id': 7,
        'name': '西兰苔',
        'stock': '3',
        'avg_cost': '2.5',
        'conversions': {'公斤': '1000'},
      });
      expect(p.stock, 3.0);
      expect(p.avgCost, 2.5);
      expect(p.conversions, {'公斤': 1000.0});
    });
  });
}
