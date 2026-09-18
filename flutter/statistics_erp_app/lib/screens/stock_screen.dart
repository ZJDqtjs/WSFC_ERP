import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../services/api_service.dart';

class StockScreen extends StatefulWidget {
  const StockScreen({super.key});

  @override
  State<StockScreen> createState() => _StockScreenState();
}

class _StockScreenState extends State<StockScreen> with SingleTickerProviderStateMixin {
  late TabController _tabController;
  String _searchKeyword = '';
  List<dynamic> _stockList = [];
  List<dynamic> _movementList = [];
  bool _isRefreshing = false;

  final _currencyFormat = NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadData();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    setState(() => _isRefreshing = true);
    try {
      await Future.wait([
        _loadStock(),
        _loadMovements(),
      ]);
    } catch (e) {
      // 忽略错误
    } finally {
      if (mounted) setState(() => _isRefreshing = false);
    }
  }

  Future<void> _loadStock() async {
    try {
      final data = await ApiService.get('/api/stock-overview');
      setState(() {
        _stockList = (data as List)
            .where((p) => !['人工', '快递'].contains(p['category']))
            .toList();
      });
    } catch (e) {
      // 忽略错误
    }
  }

  Future<void> _loadMovements() async {
    try {
      final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
      final data = await ApiService.get('/api/movements?date_from=$today&date_to=$today');
      setState(() {
        _movementList = data as List;
      });
    } catch (e) {
      // 忽略错误
    }
  }

  String _fmtStock(dynamic p) {
    final stock = (p['stock'] ?? 0).toDouble();
    final unit = p['default_unit'] ?? p['base_unit'] ?? '';
    return '${stock.toStringAsFixed(0)} $unit';
  }

  List<dynamic> get _filteredStock {
    if (_searchKeyword.isEmpty) return _stockList;
    return _stockList.where((p) {
      final name = (p['name'] ?? '').toLowerCase();
      final category = (p['category'] ?? '').toLowerCase();
      final keyword = _searchKeyword.toLowerCase();
      return name.contains(keyword) || category.contains(keyword);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('库存'),
        centerTitle: true,
        bottom: TabBar(
          controller: _tabController,
          tabs: const [
            Tab(text: '库存总览'),
            Tab(text: '库存流水'),
          ],
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              decoration: const InputDecoration(
                hintText: '搜索商品',
                prefixIcon: Icon(Icons.search),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.all(Radius.circular(20)),
                ),
                contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              ),
              onChanged: (v) => setState(() => _searchKeyword = v),
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildStockOverview(),
                _buildStockMovements(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStockOverview() {
    return RefreshIndicator(
      onRefresh: _loadData,
      child: _stockList.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : ListView.builder(
              itemCount: _filteredStock.length,
              itemBuilder: (context, index) {
                final p = _filteredStock[index];
                final isLowStock = (p['stock'] ?? 0) <= 0;
                return Card(
                  margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: ListTile(
                    title: Text(p['name'] ?? ''),
                    subtitle: Text(
                      '平均成本 ${_currencyFormat.format((p['avg_cost'] ?? 0))}/${p['default_unit'] ?? p['base_unit']} · 价值 ${_currencyFormat.format(p['stock_value'] ?? 0)}',
                    ),
                    trailing: Text(
                      _fmtStock(p),
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        color: isLowStock ? Colors.red : Colors.black,
                      ),
                    ),
                  ),
                );
              },
            ),
    );
  }

  Widget _buildStockMovements() {
    return RefreshIndicator(
      onRefresh: _loadData,
      child: _movementList.isEmpty
          ? const Center(child: Text('暂无流水'))
          : ListView.builder(
              itemCount: _movementList.length,
              itemBuilder: (context, index) {
                final m = _movementList[index];
                final qty = (m['quantity_base'] ?? 0).toDouble();
                final isPositive = qty >= 0;
                return Card(
                  margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: ListTile(
                    title: Text(m['product_name'] ?? ''),
                    subtitle: Text(
                      '${m['date']} · ${m['move_type']} · ${m['remark'] ?? ''}',
                    ),
                    trailing: Text(
                      '${isPositive ? '+' : ''}${qty.toStringAsFixed(0)} ${m['unit'] ?? ''}',
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        color: isPositive ? const Color(0xFF07C160) : Colors.red,
                      ),
                    ),
                  ),
                );
              },
            ),
    );
  }
}
