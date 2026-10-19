import 'package:flutter/material.dart';

import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import 'desktop_sidebar.dart';
import 'fluent_theme.dart';
import 'nav_model.dart';
import 'screens/desktop_deduction.dart';
import 'screens/desktop_express.dart';
import 'screens/desktop_fresh.dart';
import 'screens/desktop_home.dart';
import 'screens/desktop_inbound.dart';
import 'screens/desktop_outbound.dart';
import 'screens/desktop_packrules.dart';
import 'screens/desktop_payables.dart';
import 'screens/desktop_expenses.dart';
import 'screens/desktop_products.dart';
import 'screens/desktop_report.dart';
import 'screens/desktop_settings.dart';
import 'screens/desktop_stock.dart';
import 'screens/desktop_warehouse_in.dart';
import 'widgets/desktop_motion.dart';
import 'widgets/desktop_warehouse_switch.dart';

/// 桌面主壳：左侧 [DesktopSidebar] + 右侧内容区。
/// 路由与 [kDesktopNav] 的 route 一一对应；侧边栏显隐读本机偏好（[DesktopNavVisibility]）。
class DesktopShell extends StatefulWidget {
  const DesktopShell({super.key, required this.auth});
  final AuthProvider auth;

  @override
  State<DesktopShell> createState() => _DesktopShellState();
}

class _DesktopShellState extends State<DesktopShell> {
  final DesktopNavVisibility _nav = DesktopNavVisibility.instance;
  String _route = '/home';
  int _unpaidPayables = 0;

  @override
  void initState() {
    super.initState();
    // 401 / 切仓 / 模块显隐都要重算菜单，切仓还要让各页重新取数
    widget.auth.addListener(_onAuthChanged);
    _nav.addListener(_onNavPrefChanged);
    _nav.load(widget.auth.warehouseKey);
    _refreshPayBadge();
  }

  @override
  void dispose() {
    widget.auth.removeListener(_onAuthChanged);
    _nav.removeListener(_onNavPrefChanged);
    super.dispose();
  }

  void _onAuthChanged() {
    if (!mounted) return;
    _nav.load(widget.auth.warehouseKey);
    setState(() {});
    _refreshPayBadge();
  }

  void _onNavPrefChanged() {
    if (mounted) setState(() {});
  }

  /// 侧边栏「待付款账单」角标（web refreshPayBadge）：失败忽略，不影响主流程。
  Future<void> _refreshPayBadge() async {
    try {
      final d = await ApiService.get('/api/payables');
      final total = d['total'];
      final n = total is Map ? int.tryParse('${total['unpaid_count']}') ?? 0 : 0;
      if (mounted) setState(() => _unpaidPayables = n);
    } catch (_) {
      if (mounted) setState(() => _unpaidPayables = 0);
    }
  }

  void _onSelect(DesktopNavItem item) {
    if (item.special != null) {
      _handleSpecial(item.special!);
      return;
    }
    if (item.route != null) _go(item.route!);
  }

  Future<void> _handleSpecial(SpecialAction action) async {
    switch (action) {
      case SpecialAction.switchWarehouse:
        await showWarehouseSwitcher(context, widget.auth);
        break;
      case SpecialAction.logout:
        await widget.auth.logout();
        break;
    }
  }

  void _go(String route) {
    setState(() => _route = route);
    // 结账等操作后回到列表时角标可能是旧的，进页面顺手刷新一次
    if (route == '/payables' || route == '/home') _refreshPayBadge();
  }

  /// 路由 → 页面。`/products/<preset>` 复用商品页并预置分类。
  Widget _buildContent() {
    final String route = _route;
    if (route.startsWith('/products/')) {
      return DesktopProductsScreen(
        auth: widget.auth,
        onNavigate: _go,
        preset: route.substring('/products/'.length),
      );
    }
    switch (route) {
      case '/home':
        return DesktopHome(auth: widget.auth, onNavigate: _go);
      case '/stock':
        return DesktopStockScreen(auth: widget.auth, onNavigate: _go);
      case '/inbound':
        return DesktopInboundScreen(auth: widget.auth, onNavigate: _go);
      case '/outbound':
        return DesktopOutboundScreen(auth: widget.auth, onNavigate: _go);
      case '/warehouse-in':
        return DesktopWarehouseInScreen(auth: widget.auth, onNavigate: _go);
      case '/products':
        return DesktopProductsScreen(auth: widget.auth, onNavigate: _go);
      case '/express':
        return DesktopExpressScreen(auth: widget.auth, onNavigate: _go);
      case '/rules':
        return DesktopPackRulesScreen(auth: widget.auth, onNavigate: _go);
      // 财务流水在网页端就是报表页的「流水」面板，没有独立页面
      case '/finance':
        return DesktopReportScreen(
            auth: widget.auth, onNavigate: _go, initialPanel: 'flow');
      case '/report':
        return DesktopReportScreen(auth: widget.auth, onNavigate: _go);
      case '/expenses':
        return DesktopExpensesScreen(auth: widget.auth, onNavigate: _go);
      case '/payables':
        return DesktopPayablesScreen(auth: widget.auth, onNavigate: _go);
      case '/fresh':
        return DesktopFreshScreen(auth: widget.auth, onNavigate: _go);
      case '/deduction':
        return DesktopDeductionScreen(auth: widget.auth, onNavigate: _go);
      case '/settings':
        return DesktopSettingsScreen(auth: widget.auth, onNavigate: _go);
      default:
        return _PlaceholderPage(title: _titleOf(route));
    }
  }

  String _titleOf(String route) {
    for (final s in kDesktopNav) {
      for (final i in s.items) {
        if (i.route == route) return i.title;
      }
    }
    return '页面';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: Row(
        children: [
          DesktopSidebar(
            sections: filterDesktopNav(kDesktopNav, _nav.hidden),
            badges: <String, int>{'/payables': _unpaidPayables},
            currentRoute: _route,
            onSelect: _onSelect,
            auth: widget.auth,
          ),
          Expanded(
            child: Container(
              color: Theme.of(context).scaffoldBackgroundColor,
              child: DesktopPageTransition(
                // 切分仓后整页重建，各页 initState 重新取数（与网页端切仓后刷新一致）
                routeKey: '$_route@${widget.auth.warehouseKey}',
                child: _buildContent(),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PlaceholderPage extends StatelessWidget {
  const _PlaceholderPage({required this.title});
  final String title;

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Container(
      padding: WsTokens.contentPadding,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.add_box_outlined, size: 40, color: WsTokens.mutedLight),
          const SizedBox(height: 14),
          Text('$title · 桌面版待移植',
              style: TextStyle(
                  fontSize: 15,
                  color: dark ? WsTokens.textDark : WsTokens.textSecondaryLight)),
          const SizedBox(height: 6),
          const Text('如仍显示此页，说明该路由尚未接上对应页面。',
              style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
        ],
      ),
    );
  }
}
