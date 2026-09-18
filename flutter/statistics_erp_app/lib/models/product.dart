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

  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      id: json['id'] ?? 0,
      code: json['code'] ?? '',
      name: json['name'] ?? '',
      category: json['category'] ?? '',
      productType: json['product_type'] ?? 'stock',
      baseUnit: json['base_unit'] ?? '',
      defaultUnit: json['default_unit'],
      spec: json['spec'] ?? '',
      salePrice: (json['sale_price'] ?? 0).toDouble(),
      unitCost: (json['unit_cost'] ?? 0).toDouble(),
      avgCost: (json['avg_cost'] ?? 0).toDouble(),
      conversions: json['conversions'] != null
          ? Map<String, double>.from(json['conversions'])
          : null,
      packItems: json['pack_items'] ?? [],
      packFee: (json['pack_fee'] ?? 0).toDouble(),
      isActive: json['is_active'] ?? true,
      stockProductId: json['stock_product_id'],
      multiplier: (json['multiplier'] ?? 1).toDouble(),
      stock: (json['stock'] ?? 0).toDouble(),
      stockValue: (json['stock_value'] ?? 0).toDouble(),
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
