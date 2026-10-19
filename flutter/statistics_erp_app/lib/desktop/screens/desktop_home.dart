import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';

/// 桌面工作台：一屏看清「今天怎么样 / 哪里要处理 / 我要去哪」。
///
/// 相比原来照抄网页的版本，这里按桌面操作习惯重排：
/// - KPI 卡片可点，点「库存总值」直接进库存页，不用再去侧边栏找；
/// - 缺货预警和常用入口并排，一屏不用滚；
/// - 只有一层玻璃（欢迎条），下面全是雾面，滚动时不会掉帧。
class DesktopHome extends StatefulWidget {
  const DesktopHome({super.key, required this.auth, required this.onNavigate});
  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopHome> createState() => _DesktopHomeState();
}

class _DesktopHomeState extends State<DesktopHome> {
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

  Future<void> _load({bool refresh = false}) async {
    setState(() => _loading = true);
    try {
      final data = await ApiService.get('/api/dashboard', refresh: refresh);
      if (!mounted) return;
      setState(() {
        _today = data['today_summary'] ?? {};
        _month = data['month_summary'] ?? {};
        _stockValue = (data['stock_value'] ?? 0).toDouble();
        _productCount = data['product_count'] ?? 0;
        _lowStock = data['low_stock'] ?? [];
      });
    } catch (_) {
      // 与移动端一致：失败显示空状态
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _greeting() {
    final h = DateTime.now().hour;
    if (h < 6) return '夜深了';
    if (h < 12) return '早上好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  /// 不用 DateFormat 的 EEEE + zh_CN（那要 initializeDateFormatting），自己拼星期。
  String _formatDate() {
    const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    final now = DateTime.now();
    final y = now.year.toString().padLeft(4, '0');
    final m = now.month.toString().padLeft(2, '0');
    final d = now.day.toString().padLeft(2, '0');
    return '$y 年 $m 月 $d 日 ${weekdays[now.weekday - 1]}';
  }

  @override
  Widget build(BuildContext context) {
    final name = widget.auth.displayName;
    return SingleChildScrollView(
      padding: WsTokens.contentPadding,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: WsTokens.contentMaxWidth),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _welcomeBar(name),
              const SizedBox(height: 16),
              _kpiRow(),
              const SizedBox(height: 4),
              _alertAndEntries(),
            ],
          ),
        ),
      ),
    );
  }

  /// 欢迎条：整页唯一一层玻璃。左边问候，右边三个高频动作。
  Widget _welcomeBar(String name) {
    return DesktopRise(
      index: 0,
      child: WsCard.glass(
        padding: const EdgeInsets.fromLTRB(22, 18, 20, 18),
        marginBottom: 0,
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${_greeting()}$name',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.2,
                      color: WsTokens.inkOf(context),
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    _loading ? '${_formatDate()} · 正在更新…' : _formatDate(),
                    style: TextStyle(
                        fontSize: 12.5, color: WsTokens.inkOf(context, level: 3)),
                  ),
                ],
              ),
            ),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                DesktopButton(
                  label: '快速入库',
                  icon: Icons.download_outlined,
                  kind: DesktopButtonKind.normal,
                  onPressed: () => widget.onNavigate('/inbound'),
                ),
                DesktopButton(
                  label: '快速出库',
                  icon: Icons.upload_outlined,
                  kind: DesktopButtonKind.primary,
                  onPressed: () => widget.onNavigate('/outbound'),
                ),
                DesktopButton(
                  label: '新增商品',
                  icon: Icons.add,
                  onPressed: () => widget.onNavigate('/products'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _kpiRow() {
    final lowCount = _lowStock.length;
    return DesktopRise(
      index: 1,
      child: Row(
        children: [
          Expanded(
            child: DesktopStatCard(
              label: '今日收入',
              value: _money.format(_today['revenue'] ?? 0),
              sub: '${_today['orders'] ?? 0} 单 · 今日出库',
              icon: Icons.trending_up,
              color: WsTokens.primary,
              onTap: () => widget.onNavigate('/outbound'),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: DesktopStatCard(
              label: '本月毛利',
              value: _money.format(_month['gross'] ?? 0),
              sub: '净利 ${_money.format(_month['net'] ?? 0)}',
              icon: Icons.savings_outlined,
              color: WsTokens.green,
              onTap: () => widget.onNavigate('/report'),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: DesktopStatCard(
              label: '库存总值',
              value: _money.format(_stockValue),
              sub: '$_productCount 种商品',
              icon: Icons.inventory_2_outlined,
              color: WsTokens.brandTop,
              onTap: () => widget.onNavigate('/stock'),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: DesktopStatCard(
              label: '缺货预警',
              value: '$lowCount',
              sub: lowCount == 0 ? '库存都够' : '需要补货',
              icon: Icons.warning_amber,
              color: lowCount == 0 ? WsTokens.green : WsTokens.red,
              onTap: () => widget.onNavigate('/stock'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _alertAndEntries() {
    return DesktopRise(
      index: 2,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(flex: 3, child: _lowStockCard()),
          const SizedBox(width: 16),
          Expanded(flex: 2, child: _entryCard()),
        ],
      ),
    );
  }

  Widget _lowStockCard() {
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCardHead(
            title: '缺货预警',
            icon: Icons.warning_amber,
            trailing: TextButton(
              onPressed: () => widget.onNavigate('/stock'),
              child: const Text('查看全部库存 →', style: TextStyle(fontSize: 12.5)),
            ),
          ),
          if (_lowStock.isEmpty)
            _emptyTip(_loading ? '正在加载…' : '库存都在安全线以上，暂时没有要补的货')
          else
            for (final p in _lowStock.take(8)) _lowStockRow(p),
        ],
      ),
    );
  }

  Widget _entryCard() {
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const WsCardHead(title: '常用入口', icon: Icons.apps),
          LayoutBuilder(
            builder: (BuildContext context, BoxConstraints c) {
              final double itemW = (c.maxWidth - 20) / 3;
              return Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  _quickEntry('商品资料', Icons.tag_outlined, '/products'),
                  _quickEntry('待付款', Icons.credit_card_outlined, '/payables'),
                  _quickEntry('其他开支', Icons.account_balance_outlined, '/expenses'),
                  _quickEntry('财务流水', Icons.payments_outlined, '/finance'),
                  _quickEntry('鲜货现采', Icons.shopping_cart_outlined, '/fresh'),
                  _quickEntry('入仓登记', Icons.storefront_outlined, '/warehouse-in'),
                ]
                    .map((Widget w) => SizedBox(width: itemW, height: 74, child: w))
                    .toList(),
              );
            },
          ),
        ],
      ),
    );
  }

  Widget _emptyTip(String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 18),
      child: Text(text,
          style: TextStyle(fontSize: 12.5, color: WsTokens.inkOf(context, level: 3))),
    );
  }

  Widget _lowStockRow(dynamic p) {
    final stock = (p['stock'] ?? 0).toDouble();
    final unit = p['default_unit'] ?? p['base_unit'] ?? '';
    return InkWell(
      onTap: () => widget.onNavigate('/inbound'),
      borderRadius: BorderRadius.circular(WsTokens.radius),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
        child: Row(
          children: [
            const Icon(Icons.error_outline, size: 14, color: WsTokens.red),
            const SizedBox(width: 10),
            Expanded(
              child: Text(p['name'] ?? '',
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 13.5, color: WsTokens.inkOf(context))),
            ),
            Text('${stock.toStringAsFixed(0)} $unit',
                style: TextStyle(
                    fontSize: 12,
                    color: WsTokens.inkOf(context, level: 3),
                    fontFeatures: const [FontFeature.tabularFigures()])),
            const SizedBox(width: 10),
            const Text('补货', style: TextStyle(fontSize: 12.5, color: WsTokens.primary)),
          ],
        ),
      ),
    );
  }

  Widget _quickEntry(String label, IconData icon, String route) {
    return OutlinedButton(
      onPressed: () => widget.onNavigate(route),
      style: OutlinedButton.styleFrom(
        foregroundColor: WsTokens.inkOf(context),
        side: BorderSide(color: WsTokens.line(context)),
        padding: const EdgeInsets.symmetric(vertical: 8),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WsTokens.radiusLg),
        ),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 30,
            height: 30,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: WsTokens.primary.withValues(alpha: wsIsDark(context) ? 0.24 : 0.1),
              borderRadius: BorderRadius.circular(WsTokens.radius),
            ),
            child: Icon(icon, size: 17, color: WsTokens.primary),
          ),
          const SizedBox(height: 6),
          Text(label, style: const TextStyle(fontSize: 12)),
        ],
      ),
    );
  }
}
