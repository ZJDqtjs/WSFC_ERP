class Product {
  final int id;
  final String code;
  final String name;
  final String category;
  final String productType;
  final String baseUnit;
  final String? defaultUnit;
  final String spec;
  final double salePrice;
  final double unitCost;
  final double avgCost;
  final Map<String, double>? conversions;
  final List<dynamic> packItems;
  final double packFee;
  final bool isActive;
  final int? stockProductId;
  final double multiplier;
  final double stock;
  final double stockValue;

  Product({
    required this.id,
    required this.code,
    required this.name,
    required this.category,
    required this.productType,
    required this.baseUnit,
    this.defaultUnit,
    required this.spec,
    required this.salePrice,
    required this.unitCost,
    required this.avgCost,
    this.conversions,
    required this.packItems,
    required this.packFee,
    required this.isActive,
    this.stockProductId,
    required this.multiplier,
    required this.stock,
    required this.stockValue,
  });

  /// 后端两种实现（Go / Python）都把 conversions 存成 JSON 文本，
  /// 而 Go 的编码器会把 1.0 写成 1，直接用 Map<String,double>.from 会在真机上抛
  /// "type 'int' is not a subtype of type 'double'"，所以这里统一按 num 转 double。
  static Map<String, double> _units(dynamic raw) {
    if (raw is! Map) return {};
    final out = <String, double>{};
    raw.forEach((k, v) {
      if (v is num) {
        out[k.toString()] = v.toDouble();
      } else if (v != null) {
        out[k.toString()] = double.tryParse(v.toString()) ?? 0;
      }
    });
    return out;
  }

  static double _num(dynamic v, [double fallback = 0]) {
    if (v is num) return v.toDouble();
    if (v == null) return fallback;
    return double.tryParse(v.toString()) ?? fallback;
  }

  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      id: (json['id'] as num?)?.toInt() ?? 0,
      code: json['code'] ?? '',
      name: json['name'] ?? '',
      category: json['category'] ?? '',
      productType: json['product_type'] ?? 'stock',
      baseUnit: json['base_unit'] ?? '',
      defaultUnit: json['default_unit'],
      spec: json['spec'] ?? '',
      salePrice: _num(json['sale_price']),
      unitCost: _num(json['unit_cost']),
      avgCost: _num(json['avg_cost']),
      conversions: json['conversions'] == null ? null : _units(json['conversions']),
      packItems: json['pack_items'] ?? const [],
      packFee: _num(json['pack_fee']),
      isActive: json['is_active'] ?? true,
      stockProductId: (json['stock_product_id'] as num?)?.toInt(),
      multiplier: _num(json['multiplier'], 1),
      stock: _num(json['stock']),
      stockValue: _num(json['stock_value']),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'code': code,
      'name': name,
      'category': category,
      'product_type': productType,
      'base_unit': baseUnit,
      'default_unit': defaultUnit,
      'spec': spec,
      'sale_price': salePrice,
      'unit_cost': unitCost,
      'avg_cost': avgCost,
      'conversions': conversions,
      'pack_items': packItems,
      'pack_fee': packFee,
      'is_active': isActive,
      'stock_product_id': stockProductId,
      'multiplier': multiplier,
      'stock': stock,
      'stock_value': stockValue,
    };
  }
}
