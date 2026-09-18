import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../services/api_service.dart';

class FreshScreen extends StatefulWidget {
  const FreshScreen({super.key});

  @override
  State<FreshScreen> createState() => _FreshScreenState();
}

class _FreshScreenState extends State<FreshScreen> {
  List<dynamic> _items = [];
  bool _loading = false;
  int? _draggingId;

  @override
  void initState() {
    super.initState();
    _loadFresh();
  }

  Future<void> _loadFresh() async {
    setState(() => _loading = true);
    try {
      final data = await ApiService.get('/api/fresh');
      setState(() => _items = (data['items'] ?? []) as List<dynamic>);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('加载鲜货现采失败')),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _saveOrder() async {
    final ids = _items.map((item) => item['id'] as int).toList();
    try {
      await ApiService.post('/api/fresh/config', data: {'ids': ids});
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('保存顺序失败')),
        );
      }
    }
  }

  String _fmtNum(dynamic value) {
    final n = (value ?? 0).toDouble();
    if (n % 1 == 0) return n.toStringAsFixed(0);
    return n.toStringAsFixed(2);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('鲜货现采'),
        centerTitle: true,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded),
          onPressed: () => context.go('/home'),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _loadFresh,
        child: _loading && _items.isEmpty
            ? const Center(child: CircularProgressIndicator())
            : ListView.builder(
                padding: const EdgeInsets.all(12),
                itemCount: _items.length,
                itemBuilder: (context, index) {
                  final item = _items[index];
                  return LongPressDraggable<int>(
                    data: (item['id'] as int?) ?? index,
                    feedback: Material(
                      elevation: 4,
                      borderRadius: BorderRadius.circular(12),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 320),
                        child: Container(
                          width: MediaQuery.of(context).size.width - 48,
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text(item['name'] ?? ''),
                        ),
                      ),
                    ),
                    childWhenDragging: Opacity(
                      opacity: 0.4,
                      child: _buildCard(item, index),
                    ),
                    onDragStarted: () => setState(() => _draggingId = item['id'] as int?),
                    onDraggableCanceled: (_, __) => setState(() => _draggingId = null),
                    onDragCompleted: () => setState(() => _draggingId = null),
                    child: DragTarget<int>(
                      onAcceptWithDetails: (details) {
                        final fromId = details.data;
                        final fromIndex = _items.indexWhere((e) => (e['id'] ?? -1) == fromId);
                        if (fromIndex < 0 || fromIndex == index) return;
                        setState(() {
                          final moved = _items.removeAt(fromIndex);
                          _items.insert(index, moved);
                        });
                        _saveOrder();
                      },
                      builder: (context, candidateData, rejectedData) => _buildCard(item, index),
                    ),
                  );
                },
              ),
      ),
    );
  }

  Widget _buildCard(dynamic item, int index) {
    final stock = (item['stock'] ?? 0).toDouble();
    final avgCost = (item['avg_cost'] ?? 0).toDouble();
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.drag_indicator, color: Colors.grey),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    item['name'] ?? '',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: const Color(0xFFEAF7FF),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    item['category'] ?? '',
                    style: const TextStyle(color: Color(0xFF1989FA), fontSize: 11),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('库存 ${_fmtNum(stock)} ${item['unit'] ?? ''}'),
                Text('均价 ¥${avgCost.toStringAsFixed(2)}/${item['unit'] ?? ''}'),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              '展示顺序 ${index + 1}',
              style: const TextStyle(fontSize: 12, color: Colors.grey),
            ),
          ],
        ),
      ),
    );
  }
}
