import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../mobile_style.dart';
import '../widgets/mobile_page.dart';
import '../widgets/motion.dart';
import '../widgets/parts.dart';

/// 工作台：一屏看完"今天赚了多少、库里压了多少、哪些货要补"，
/// 其余功能都从这里的一宫格入口进去。
class MobileHomePage extends StatefulWidget {
  const MobileHomePage({super.key});

  @override
  State<MobileHomePage> createState() => _MobileHomePageState();
}

class _MobileHomePageState extends State<MobileHomePage> {
  Map<String, dynamic> _today = {};
  Map<String, dynamic> _month = {};
  double _stockValue = 0;
  int _productCount = 0;
  List<dynamic> _lowStock = [];
  bool _loading = false;

  final _money = NumberFormat.currency(locale: 'zh_CN', symbol: '¥', decimalDigits: 2);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final data = await ApiService.dashboard();
      if (!mounted) return;
      setState(() {
        _today = data['today_summary'] ?? {};
        _month = data['month_summary'] ?? {};
        _stockValue = (data['stock_value'] ?? 0).toDouble();
        _productCount = data['product_count'] ?? 0;
        _lowStock = data['low_stock'] ?? [];
      });
    } on ApiException catch (e) {
      if (mounted) _toast(e.message, error: true);
    } catch (_) {
      // 首屏取不到数据留空态即可，不打断使用
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toast(String msg, {bool error = false}) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Mc.danger : null,
    ));
  }

  String get _who {
    final auth = context.watch<AuthProvider>();
    final wh = auth.warehouseName.isEmpty ? auth.warehouseKey : auth.warehouseName;
    return wh.isEmpty ? auth.displayName : '$wh · ${auth.displayName}';
  }

  @override
  Widget build(BuildContext context) {
    final orders = (_today['orders'] ?? 0).toDouble();

    return MobilePage(
      title: '工作台',
      tabIndex: 0,
      onRefresh: _load,
      actions: [
        pageAction(Icons.refresh_rounded, _loading ? null : _load, tooltip: '刷新'),
        pageAction(Icons.person_outline, () => context.go('/mine'), tooltip: '我的'),
      ],
      body: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
            sliver: SliverList(
              delegate: SliverChildListDelegate([
                StaggerItem(index: 0, child: _hero(orders)),
                StaggerItem(
                  index: 1,
                  child: Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(
                          child: StatCard(
                            label: '本月毛利',
                            value: (_month['gross'] ?? 0).toDouble(),
                            format: _money.format,
                            foot: '净利 ${_money.format((_month['net'] ?? 0).toDouble())}',
                            accent: Mc.fresh,
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: StatCard(
                            label: '库存总值',
                            value: _stockValue,
                            format: _money.format,
                            foot: '$_productCount 种商品',
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const StaggerItem(index: 2, child: SectionHeader(title: '业务办理', top: 22)),
                StaggerItem(index: 3, child: _entries()),
                const StaggerItem(index: 4, child: SectionHeader(title: '智能录入', top: 22)),
                const StaggerItem(index: 5, child: _AiInput()),
                if (_lowStock.isNotEmpty) ...[
                  StaggerItem(
                    index: 6,
                    child: SectionHeader(
                      title: '缺货预警',
                      top: 22,
                      trailing: Text('${_lowStock.length} 项',
                          style: const TextStyle(fontSize: 12, color: Mc.danger)),
                    ),
                  ),
                  StaggerItem(index: 7, child: _lowStockCard()),
                ],
                const SizedBox(height: 28),
              ]),
            ),
          ),
        ],
      ),
    );
  }

  Widget _hero(double orders) {
    return BrandCard(
      onTap: _load,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(_who,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 12, color: Colors.white.withValues(alpha: 0.82))),
                ),
                if (_loading)
                  const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: Colors.white70),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            const Text('今日收入',
                style: TextStyle(fontSize: 12, color: Colors.white70)),
            const SizedBox(height: 4),
            DefaultTextStyle(
              style: const TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.w700,
                color: Colors.white,
                height: 1.05,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
              child: CountUp(
                  value: (_today['revenue'] ?? 0).toDouble(),
                  builder: _money.format),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                _heroChip('${orders.toStringAsFixed(0)} 单'),
                const SizedBox(width: 8),
                _heroChip('本月净利 ${_money.format((_month['net'] ?? 0).toDouble())}'),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _heroChip(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(text,
          style: const TextStyle(fontSize: 11.5, color: Colors.white)),
    );
  }

  Widget _entries() {
    const items = [
      ('商品', Icons.category_outlined, '/products', Mc.brand),
      ('出库', Icons.outbox_outlined, '/outbound', Mc.brand),
      ('入库', Icons.inbox_outlined, '/inbound', Mc.brand),
      ('库存', Icons.inventory_2_outlined, '/stock', Mc.brand),
      ('待付款', Icons.account_balance_wallet_outlined, '/payables', Mc.warn),
      ('其他开支', Icons.receipt_long_outlined, '/expenses', Mc.danger),
      ('财务流水', Icons.show_chart, '/finance', Mc.fresh),
      ('规则设置', Icons.tune, '/rules', Mc.inkSecond),
    ];
    return GlassPanel(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
      child: GridView.count(
        crossAxisCount: 4,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        childAspectRatio: 0.86,
        children: [
          for (final (label, icon, route, color) in items)
            QuickEntry(
              label: label,
              icon: icon,
              color: color,
              onTap: () => context.push(route),
            ),
        ],
      ),
    );
  }

  Widget _lowStockCard() {
    return GlassPanel(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
      child: Column(
        children: [
          for (final p in _lowStock.take(6))
            TileRow(
              title: (p['name'] ?? '').toString(),
              subtitle: '剩余 ${(p['stock'] ?? 0).toDouble().toStringAsFixed(0)} '
                  '${p['default_unit'] ?? p['base_unit'] ?? ''}',
              icon: Icons.warning_amber_rounded,
              iconColor: Mc.danger,
              trailing: TextButton(
                onPressed: () => context.go('/inbound'),
                style: TextButton.styleFrom(
                  foregroundColor: Mc.brand,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  minimumSize: const Size(0, 34),
                ),
                child: const Text('补货', style: TextStyle(fontSize: 13)),
              ),
            ),
        ],
      ),
    );
  }
}

class _AiInput extends StatefulWidget {
  const _AiInput();

  @override
  State<_AiInput> createState() => _AiInputState();
}

class _AiInputState extends State<_AiInput> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _soon(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    return GlassPanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _controller,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(
              hintText: '例如：今天入库 100 斤木耳，25 一斤；或出库 2 单七彩土豆 3 斤，每单 15 元',
              hintStyle: TextStyle(fontSize: 13, color: Mc.inkThird),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: () => _soon('AI 识别功能开发中...'),
                  icon: const Icon(Icons.auto_awesome, size: 18),
                  label: const Text('识别并录入'),
                  style: FilledButton.styleFrom(
                    backgroundColor: Mc.brand,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => _soon('拍单识别功能开发中...'),
                  icon: const Icon(Icons.photo_camera_outlined, size: 18),
                  label: const Text('拍单识别'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Mc.fresh,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
