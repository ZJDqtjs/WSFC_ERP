// 后端回来的裸 Map（/api/products、/api/dashboard 的 low_stock 等）统一走下面这几个口子：
// stock / avg_cost / sale_price 恒是基础单位口径，界面必须折算到默认单位再显示，
// 否则会出现「-1385000 公斤」这种数量配错单位的数。

/// 展示单位：默认单位，没配退回基础单位
String unitOf(Map row) =>
    (row['default_unit'] ?? row['base_unit'] ?? '').toString();

/// 1 个展示单位 = factorOf 个基础单位
double unitFactorOf(Map row) {
  final conv = row['conversions'];
  final f = conv is Map
      ? (num.tryParse('${conv[unitOf(row)]}')?.toDouble() ?? 1)
      : 1.0;
  return f == 0 ? 1 : f;
}

/// 「1365.25 公斤」：整数不带小数，小数最多 2 位
String stockTextOf(Map row) {
  final shown = ((row['stock'] as num?)?.toDouble() ?? 0) / unitFactorOf(row);
  final v = shown.toStringAsFixed(shown == shown.roundToDouble() ? 0 : 2);
  return '$v ${unitOf(row)}';
}

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

  /// 展示单位：默认单位，没配就退回基础单位
  String get unit {
    final du = defaultUnit ?? '';
    return du.isNotEmpty ? du : baseUnit;
  }

  /// 后端回来的 [stock] 恒是基础单位数量，界面上要按展示单位报数
  double get stockInUnit {
    final f = conversions?[unit] ?? 1;
    return f == 0 ? stock : stock / f;
  }

  /// 商品选择器用的「1365.25 公斤」：整数不带小数，小数最多 2 位
  String get stockText {
    final v = stockInUnit;
    return v == v.roundToDouble() ? '${v.toStringAsFixed(0)} $unit' : '${v.toStringAsFixed(2)} $unit';
  }

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
