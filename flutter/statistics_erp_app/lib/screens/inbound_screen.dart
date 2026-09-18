import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';

import '../services/api_service.dart';
import '../models/product.dart';

class InboundScreen extends StatefulWidget {
  const InboundScreen({super.key});

  @override
  State<InboundScreen> createState() => _InboundScreenState();
}

class _InboundScreenState extends State<InboundScreen> {
  final _formKey = GlobalKey<FormState>();
  String _date = DateFormat('yyyy-MM-dd').format(DateTime.now());
  String _supplier = '';
  final List<_InboundRow> _rows = [_InboundRow()];
  bool _isLoading = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('入库'),
        centerTitle: true,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(12),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '快捷入库',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Expanded(
                            child: TextFormField(
                              initialValue: _date,
                              decoration: const InputDecoration(
                                labelText: '日期',
                                prefixIcon: Icon(Icons.calendar_today),
                              ),
                              onTap: () async {
                                final picked = await showDatePicker(
                                  context: context,
                                  initialDate: DateTime.now(),
                                  firstDate: DateTime(2020),
                                  lastDate: DateTime(2030),
                                );
                                if (picked != null) {
                                  setState(() {
                                    _date = DateFormat('yyyy-MM-dd').format(picked);
                                  });
                                }
                              },
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextFormField(
                              decoration: const InputDecoration(
                                labelText: '供应商',
                                prefixIcon: Icon(Icons.business),
                              ),
                              onChanged: (v) => _supplier = v,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      ..._rows.asMap().entries.map((entry) {
                        final i = entry.key;
                        final row = entry.value;
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(
                                flex: 3,
                                child: InkWell(
                                  onTap: () => _openProductPicker(i),
                                  borderRadius: BorderRadius.circular(8),
                                  child: Container(
                                    padding: const EdgeInsets.all(12),
                                    decoration: BoxDecoration(
                                      color: row.product == null
                                          ? const Color(0xFFF0F8FF)
                                          : Colors.grey[100],
                                      borderRadius: BorderRadius.circular(8),
                                    ),
                                    child: row.product == null
                                        ? const Text('＋ 选择商品',
                                            style: TextStyle(color: Color(0xFF1989FA)))
                                        : Text(
                                            '[库存] ${row.product!.name}',
                                            style: const TextStyle(fontSize: 13),
                                          ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              SizedBox(
                                width: 70,
                                child: TextFormField(
                                  initialValue: '1',
                                  decoration: const InputDecoration(
                                    labelText: '数量',
                                    contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                                  ),
                                  keyboardType: TextInputType.number,
                                  onChanged: (v) => row.quantity = v,
                                ),
                              ),
                              const SizedBox(width: 8),
                              SizedBox(
                                width: 80,
                                child: TextFormField(
                                  initialValue: '0',
                                  decoration: const InputDecoration(
                                    labelText: '单价',
                                    contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                                  ),
                                  keyboardType: TextInputType.number,
                                  onChanged: (v) => row.price = v,
                                ),
                              ),
                              const SizedBox(width: 4),
                              IconButton(
                                icon: const Icon(Icons.delete_outline, color: Colors.red),
                                onPressed: _rows.length > 1
                                    ? () => setState(() => _rows.removeAt(i))
                                    : null,
                              ),
                            ],
                          ),
                        );
                      }),
                      OutlinedButton.icon(
                        onPressed: () => setState(() => _rows.add(_InboundRow())),
                        icon: const Icon(Icons.add),
                        label: const Text('加一行'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFF1989FA),
                        ),
                      ),
                      const SizedBox(height: 16),
                      SizedBox(
                        height: 44,
                        child: ElevatedButton(
                          onPressed: _isLoading ? null : _submit,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF1989FA),
                            foregroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(20),
                            ),
                          ),
                          child: _isLoading
                              ? const SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                                  ),
                                )
                              : const Text('确认入库', style: TextStyle(fontSize: 16)),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _openProductPicker(int rowIndex) async {
    final product = await Navigator.push<Product>(
      context,
      MaterialPageRoute(
        builder: (context) => _ProductPickerScreen(),
      ),
    );

    if (product != null && mounted) {
      setState(() {
        _rows[rowIndex].product = product;
        _rows[rowIndex].unit = product.defaultUnit ?? product.baseUnit;
      });
    }
  }

  Future<void> _submit() async {
    if (_rows.every((r) => r.product == null)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请至少选择一条商品')),
      );
      return;
    }

    setState(() => _isLoading = true);

    try {
      for (final row in _rows.where((r) => r.product != null)) {
        await ApiService.post('/api/inbounds', data: {
          'product_id': row.product!.id,
          'unit': row.unit ?? '个',
          'quantity': double.tryParse(row.quantity ?? '0') ?? 0,
          'unit_price': double.tryParse(row.price ?? '0') ?? 0,
          'supplier': _supplier,
          'date': _date,
          'remark': '',
        });
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('入库成功'), backgroundColor: Colors.green),
        );
        setState(() {
          _rows.clear();
          _rows.add(_InboundRow());
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('入库失败：${e.toString()}'), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }
}

class _InboundRow {
  Product? product;
  String? unit;
  String? quantity = '1';
  String? price = '0';
}

class _ProductPickerScreen extends StatefulWidget {
  const _ProductPickerScreen();

  @override
  State<_ProductPickerScreen> createState() => _ProductPickerScreenState();
}

class _ProductPickerScreenState extends State<_ProductPickerScreen> {
  String _searchKeyword = '';
  String _filterCategory = '';
  List<Product> _products = [];
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _loadProducts();
  }

  Future<void> _loadProducts() async {
    setState(() => _isLoading = true);
    try {
      final data = await ApiService.get('/api/products');
      setState(() {
        _products = (data as List)
            .where((p) => p['is_active'] == true && p['product_type'] == 'stock')
            .where((p) => !['人工', '快递'].contains(p['category']))
            .map((p) => Product.fromJson(p))
            .toList();
      });
    } catch (e) {
      // 忽略错误
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  List<Product> get _filteredProducts {
    return _products.where((p) {
      if (_searchKeyword.isNotEmpty &&
          !p.name.toLowerCase().contains(_searchKeyword.toLowerCase()) &&
          !(p.category ?? '').toLowerCase().contains(_searchKeyword.toLowerCase())) {
        return false;
      }
      if (_filterCategory.isNotEmpty && p.category != _filterCategory) return false;
      return true;
    }).toList();
  }

  Set<String> get _categories {
    return _products.map((p) => p.category ?? '').where((c) => c.isNotEmpty).toSet();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('选择入库商品'),
        centerTitle: true,
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              decoration: const InputDecoration(
                hintText: '搜索商品名称 / 分类',
                prefixIcon: Icon(Icons.search),
                border: OutlineInputBorder(),
              ),
              onChanged: (v) => setState(() => _searchKeyword = v),
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(
              children: [
                const Padding(
                  padding: EdgeInsets.only(right: 8),
                  child: FilterChip(label: Text('全部'), selected: true, onSelected: null),
                ),
                ..._categories.map((c) => Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: FilterChip(
                        label: Text(c),
                        selected: _filterCategory == c,
                        onSelected: (selected) {
                          setState(() => _filterCategory = selected ? c : '');
                        },
                      ),
                    )),
              ],
            ),
          ),
          const Divider(),
          Expanded(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : _filteredProducts.isEmpty
                    ? const Center(child: Text('无匹配商品'))
                    : ListView.builder(
                        itemCount: _filteredProducts.length,
                        itemBuilder: (context, index) {
                          final p = _filteredProducts[index];
                          return ListTile(
                            title: Text('[库存] ${p.name}'),
                            subtitle: Text(
                              '${p.category ?? '—'} · 单位 ${p.defaultUnit ?? p.baseUnit} · 库存 ${p.stock}',
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => Navigator.pop(context, p),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}
