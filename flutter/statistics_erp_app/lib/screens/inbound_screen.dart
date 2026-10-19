import '../mobile/widgets/mobile_page.dart';
import '../mobile/widgets/parts.dart';
import '../mobile/mobile_style.dart';
import 'package:flutter/material.dart';

import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../providers/product_provider.dart';
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
    return MobilePage(
      title: '入库',
      tabIndex: 2,
      body: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 28),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              GCard(
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
                            child: FormCell(
                              label: '日期',
                              child: CellInput(
                                initialValue: _date,
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
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: FormCell(
                              label: '供应商',
                              child: CellInput(
                                hint: '供应商名称',
                                onChanged: (v) => _supplier = v,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      ..._rows.asMap().entries.map((entry) {
                        final i = entry.key;
                        final row = entry.value;
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Expanded(
                                child: FormCell(
                                  label: '商品',
                                  child: CellTapBox(
                                    onTap: () => _openProductPicker(i),
                                    background: row.product == null
                                        ? const Color(0xFFF0F8FF)
                                        : Colors.grey[100],
                                    child: Text(
                                      row.product == null
                                          ? '＋ 选择商品'
                                          : '[库存] ${row.product!.name}',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 13,
                                        color: row.product == null
                                            ? const Color(0xFF1989FA)
                                            : Mc.ink,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              SizedBox(
                                width: 62,
                                child: FormCell(
                                  label: '数量',
                                  child: CellInput(
                                    initialValue: '1',
                                    keyboardType: TextInputType.number,
                                    onChanged: (v) => row.quantity = v,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              SizedBox(
                                width: 70,
                                child: FormCell(
                                  label: '单价',
                                  child: CellInput(
                                    initialValue: '0',
                                    keyboardType: TextInputType.number,
                                    onChanged: (v) => row.price = v,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 2),
                              Padding(
                                padding: const EdgeInsets.only(top: 17),
                                child: IconButton(
                                  visualDensity: VisualDensity.compact,
                                  constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                                  padding: EdgeInsets.zero,
                                  icon: const Icon(Icons.delete_outline,
                                      size: 22, color: Colors.red),
                                  onPressed: _rows.length > 1
                                      ? () => setState(() => _rows.removeAt(i))
                                      : null,
                                ),
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
                        width: double.infinity,
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
        builder: (context) => const _ProductPickerScreen(),
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

  @override
  void initState() {
    super.initState();
    // 商品表由 ProductProvider 统一持有：只有全 App 第一次要它时才真的走网络
    context.read<ProductProvider>().ensureLoaded();
  }

  List<Product> _visible(List<Product> source) {
    final k = _searchKeyword.toLowerCase();
    return source.where((p) {
      if (k.isNotEmpty &&
          !p.name.toLowerCase().contains(k) &&
          !p.category.toLowerCase().contains(k)) {
        return false;
      }
      if (_filterCategory.isNotEmpty && p.category != _filterCategory) return false;
      return true;
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ProductProvider>();
    final source = provider.getStockProducts();
    final shown = _visible(source);
    final categories = source.map((p) => p.category).where((c) => c.isNotEmpty).toSet();
    return MobilePage(
      title: '选择入库商品',
      back: true,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
            child: TextField(
              decoration: const InputDecoration(
                hintText: '搜索商品名称 / 分类',
                prefixIcon: Icon(Icons.search),
                isDense: true,
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
                ...categories.map((c) => Padding(
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
            child: shown.isEmpty
                ? Center(
                    child: Text(
                      provider.error != null
                          ? '商品加载失败：${provider.error}'
                          : provider.isLoading
                              ? '加载中…'
                              : '无匹配商品',
                    ),
                  )
                : ListView.builder(
                    itemCount: shown.length,
                    itemBuilder: (context, index) {
                      final p = shown[index];
                      return ListTile(
                        title: Text('[库存] ${p.name}'),
                        subtitle: Text(
                          '${p.category.isEmpty ? '—' : p.category} · 库存 ${p.stockText}',
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
