import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';

import '../services/api_service.dart';
import '../providers/auth_provider.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Map<String, dynamic> _todayData = {};
  Map<String, dynamic> _monthData = {};
  double _stockValue = 0;
  int _productCount = 0;
  List<dynamic> _lowStock = [];
  bool _isLoading = false;

  final _currencyFormat =
      NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);

  @override
  void initState() {
    super.initState();
    _loadDashboard();
  }

  Future<void> _loadDashboard() async {
    setState(() => _isLoading = true);
    try {
      final data = await ApiService.get('/api/dashboard');
      setState(() {
        _todayData = data['today_summary'] ?? {};
        _monthData = data['month_summary'] ?? {};
        _stockValue = (data['stock_value'] ?? 0).toDouble();
        _productCount = data['product_count'] ?? 0;
        _lowStock = data['low_stock'] ?? [];
      });
    } catch (e) {
      // 忽略错误，显示空状态
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  String _fmtStock(dynamic p) {
    final stock = (p['stock'] ?? 0).toDouble();
    final unit = p['default_unit'] ?? p['base_unit'] ?? '';
    return '${stock.toStringAsFixed(0)} $unit';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('工作台'),
        centerTitle: true,
      ),
      body: RefreshIndicator(
        onRefresh: _loadDashboard,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 概览卡片
              Row(
                children: [
                  _buildStatCard(
                    '今日收入',
                    _currencyFormat.format(_todayData['revenue'] ?? 0),
                    '${_todayData['orders'] ?? 0} 单',
                  ),
                  const SizedBox(width: 10),
                  _buildStatCard(
                    '本月毛利',
                    _currencyFormat.format(_monthData['gross'] ?? 0),
                    '净利 ${_currencyFormat.format(_monthData['net'] ?? 0)}',
                    isGreen: true,
                  ),
                  const SizedBox(width: 10),
                  _buildStatCard(
                    '库存总值',
                    _currencyFormat.format(_stockValue),
                    '$_productCount 种商品',
                  ),
                ],
              ),
              const SizedBox(height: 12),

              Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: SizedBox(
                    width: double.infinity,
                    child: ElevatedButton.icon(
                      onPressed: () => context.go('/fresh'),
                      icon: const Icon(Icons.storefront_outlined),
                      label: const Text('鲜货现采'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF07C160),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 12),

              // AI 智能录入（占位）
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'AI 智能录入',
                        style: TextStyle(
                            fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        maxLines: 2,
                        decoration: const InputDecoration(
                          hintText:
                              '例如：今天入库了 100 斤木耳，25 一斤；或 出库 2 单七彩土豆 3 斤，每单 15 元',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: ElevatedButton.icon(
                              onPressed: () {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                      content: Text('AI 识别功能开发中...')),
                                );
                              },
                              icon: const Icon(Icons.smart_button),
                              label: const Text('🤖 识别并录入'),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFF1989FA),
                                foregroundColor: Colors.white,
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: () {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(content: Text('拍照识别功能开发中...')),
                                );
                              },
                              icon: const Icon(Icons.camera_alt),
                              label: const Text('📷 拍单识别'),
                              style: OutlinedButton.styleFrom(
                                foregroundColor: const Color(0xFF07C160),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),

              // 缺货预警
              if (_lowStock.isNotEmpty)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          '缺货预警',
                          style: TextStyle(
                              fontWeight: FontWeight.bold, fontSize: 16),
                        ),
                        const SizedBox(height: 10),
                        ...(_lowStock.take(6).map((p) => Padding(
                              padding: const EdgeInsets.symmetric(vertical: 8),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: Text(p['name'] ?? ''),
                                  ),
                                  Text(
                                    _fmtStock(p),
                                    style: TextStyle(
                                        color: Colors.grey[600], fontSize: 12),
                                  ),
                                  const SizedBox(width: 8),
                                  OutlinedButton(
                                    onPressed: () => context.go('/inbound'),
                                    style: OutlinedButton.styleFrom(
                                      minimumSize: const Size(0, 32),
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 12),
                                      foregroundColor: Colors.red,
                                    ),
                                    child: const Text('补货',
                                        style: TextStyle(fontSize: 12)),
                                  ),
                                ],
                              ),
                            ))),
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

  Widget _buildStatCard(String label, String value, String sub,
      {bool isGreen = false}) {
    return Expanded(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              Text(label,
                  style: TextStyle(fontSize: 12, color: Colors.grey[600])),
              const SizedBox(height: 4),
              Text(
                value,
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: isGreen ? const Color(0xFF07C160) : Colors.black,
                ),
              ),
              const SizedBox(height: 2),
              Text(sub,
                  style: TextStyle(fontSize: 11, color: Colors.grey[600])),
            ],
          ),
        ),
      ),
    );
  }
}
