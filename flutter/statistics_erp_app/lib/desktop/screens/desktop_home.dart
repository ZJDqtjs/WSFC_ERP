import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../fluent_theme.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/ws_card.dart';

/// 桌面工作台，复刻 web #page-home：欢迎卡 / KPI / 缺货预警 / 快捷入口。
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

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final data = await ApiService.get('/api/dashboard');
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
    final dark = wsIsDark(context);
    final name = widget.auth.displayName;
    return SingleChildScrollView(
      padding: WsTokens.contentPadding,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: WsTokens.contentMaxWidth),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // 欢迎卡
              DesktopRise(
                index: 0,
                child: WsCard(
                gradient: dark ? null : WsTokens.welcomeGradient,
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${_greeting()} 👋 ${name.isEmpty ? '' : name}',
                            style: TextStyle(
                              fontSize: 22,
                              fontWeight: FontWeight.w600,
                              color: dark ? WsTokens.textDark : WsTokens.textLight,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            _formatDate(),
                            style: const TextStyle(fontSize: 13, color: WsTokens.textSecondaryLight),
                          ),
                        ],
                      ),
                    ),
                    Wrap(
                      spacing: 12,
                      runSpacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        if (_loading)
                          const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        _actionButton('快速入库', Icons.download_outlined, false,
                            () => widget.onNavigate('/inbound')),
                        _actionButton('快速出库', Icons.upload_outlined, true,
                            () => widget.onNavigate('/outbound')),
                        _actionButton('新增商品', Icons.add, null,
                            () => widget.onNavigate('/products')),
                      ],
                    ),
                  ],
                ),
              ),
              ),
              // KPI
              DesktopRise(
                index: 1,
                child: Row(
                children: [
                  Expanded(child: _kpi('今日收入', _money.format(_today['revenue'] ?? 0),
                      '${_today['orders'] ?? 0} 单', null)),
                  const SizedBox(width: 16),
                  Expanded(child: _kpi('本月毛利', _money.format(_month['gross'] ?? 0),
                      '净利 ${_money.format(_month['net'] ?? 0)}', WsTokens.green)),
                  const SizedBox(width: 16),
                  Expanded(child: _kpi('库存总值', _money.format(_stockValue),
                      '$_productCount 种商品', null)),
                ],
              ),
              ),
              // 缺货预警 + 快捷入口
              DesktopRise(
                index: 2,
                child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: WsCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          WsCardHead(
                            title: '缺货预警',
                            icon: Icons.warning_amber,
                            trailing: TextButton(
                              onPressed: () => widget.onNavigate('/stock'),
                              child: const Text('去补货 →', style: TextStyle(fontSize: 12.5)),
                            ),
                          ),
                          if (_lowStock.isEmpty)
                            const Padding(
                              padding: EdgeInsets.symmetric(vertical: 12),
                              child: Text('暂无缺货商品', style: TextStyle(color: WsTokens.mutedLight)),
                            )
                          else
                            ..._lowStock.take(6).map((p) => _lowStockRow(p)),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 20),
                  Expanded(
                    child: WsCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const WsCardHead(title: '快捷入口', icon: Icons.arrow_forward),
                          Wrap(
                            spacing: 10,
                            runSpacing: 10,
                            children: [
                              _quickEntry('商品', Icons.tag_outlined, () => widget.onNavigate('/products')),
                              _quickEntry('待付款', Icons.credit_card_outlined, () => widget.onNavigate('/payables')),
                              _quickEntry('其他开支', Icons.account_balance_outlined, () => widget.onNavigate('/expenses')),
                              _quickEntry('财务流水', Icons.payments_outlined, () => widget.onNavigate('/finance')),
                              _quickEntry('鲜货现采', Icons.shopping_cart_outlined, () => widget.onNavigate('/fresh')),
                              _quickEntry('库存盘点', Icons.inventory_2_outlined, () => widget.onNavigate('/stock')),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _actionButton(String label, IconData icon, bool? green, VoidCallback onPressed) {
    final Color bg = green == true
        ? WsTokens.green
        : green == false
            ? WsTokens.primary
            : (wsIsDark(context) ? WsTokens.cardDark : WsTokens.cardLight);
    final Color fg = green == null
        ? (wsIsDark(context) ? WsTokens.textDark : WsTokens.textLight)
        : Colors.white;
    return ElevatedButton(
      onPressed: onPressed,
      style: ElevatedButton.styleFrom(
        backgroundColor: bg,
        foregroundColor: fg,
        elevation: 0,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(WsTokens.radius)),
          side: BorderSide(color: WsTokens.borderLight),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15),
          const SizedBox(width: 8),
          Text(label, style: const TextStyle(fontSize: 13)),
        ],
      ),
    );
  }

  Widget _kpi(String label, String value, String sub, Color? valueColor) {
    final dark = wsIsDark(context);
    return WsCard(
      marginBottom: 20,
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
          const SizedBox(height: 8),
          Text(
            value,
            style: TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w600,
              color: valueColor ?? (dark ? WsTokens.textDark : WsTokens.textLight),
            ),
          ),
          const SizedBox(height: 4),
          Text(sub, style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
        ],
      ),
    );
  }

  Widget _lowStockRow(dynamic p) {
    final stock = (p['stock'] ?? 0).toDouble();
    final unit = p['default_unit'] ?? p['base_unit'] ?? '';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          const Icon(Icons.error_outline, size: 14, color: WsTokens.red),
          const SizedBox(width: 10),
          Expanded(child: Text(p['name'] ?? '', style: const TextStyle(fontSize: 13.5))),
          Text('${stock.toStringAsFixed(0)} $unit',
              style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          const SizedBox(width: 12),
          TextButton(
            onPressed: () => widget.onNavigate('/inbound'),
            child: const Text('补货', style: TextStyle(fontSize: 12.5)),
          ),
        ],
      ),
    );
  }

  Widget _quickEntry(String label, IconData icon, VoidCallback onPressed) {
    final dark = wsIsDark(context);
    return SizedBox(
      width: 96,
      child: OutlinedButton(
        onPressed: onPressed,
        style: OutlinedButton.styleFrom(
          foregroundColor: dark ? WsTokens.textDark : WsTokens.textLight,
          side: BorderSide(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(WsTokens.radius),
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 34,
              height: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: dark
                    ? WsTokens.primary.withValues(alpha: 0.18)
                    : WsTokens.primaryLight,
                borderRadius: BorderRadius.circular(11),
              ),
              child: Icon(icon, size: 18, color: WsTokens.primary),
            ),
            const SizedBox(height: 8),
            Text(label, style: const TextStyle(fontSize: 12)),
          ],
        ),
      ),
    );
  }
}
