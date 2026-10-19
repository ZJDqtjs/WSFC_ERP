import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import 'desktop_command_palette.dart';
import 'desktop_style.dart';
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
import 'widgets/desktop_rail.dart';
import 'widgets/desktop_toolbar.dart';
import 'widgets/desktop_warehouse_switch.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 桌面主壳：极光底板 + 左侧玻璃导航条 + 顶部玻璃工具条 + 内容区。
///
/// 设计取舍：
/// - 导航条可折叠（Ctrl+B）。桌面端一半以上页面是宽表，列宽永远不够，
///   折叠把 176px 横向空间还给表格。
/// - Ctrl+K 命令面板。16 个一级页面靠眼睛找太慢，直接敲字跳转或搜商品。
/// - 工具条上的"刷新"用 [_reloadTick] 拼进路由 key，让页面重建后重新取数，
///   不用每个页面各自实现刷新按钮。
class DesktopShell extends StatefulWidget {
  const DesktopShell({super.key, required this.auth});
  final AuthProvider auth;

  @override
  State<DesktopShell> createState() => _DesktopShellState();
}

class _DesktopShellState extends State<DesktopShell> {
  static const String _railPrefKey = 'erp_rail_collapsed';

  final DesktopNavVisibility _nav = DesktopNavVisibility.instance;
  String _route = '/home';
  int _unpaidPayables = 0;
  int _reloadTick = 0;
  bool _railCollapsed = false;
  bool _paletteOpen = false;

  @override
  void initState() {
    super.initState();
    // 401 / 切仓 / 模块显隐都要重算菜单，切仓还要让各页重新取数
    widget.auth.addListener(_onAuthChanged);
    _nav.addListener(_onNavPrefChanged);
    _nav.load(widget.auth.warehouseKey);
    _refreshPayBadge();
    _loadRailPref();
    HardwareKeyboard.instance.addHandler(_onHardwareKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onHardwareKey);
    widget.auth.removeListener(_onAuthChanged);
    _nav.removeListener(_onNavPrefChanged);
    super.dispose();
  }

  /// 全局快捷键。
  ///
  /// 不用 CallbackShortcuts：它只在焦点落在自己子树内时才收到按键，而桌面端
  /// 一进来的默认焦点在 MaterialApp 根部（壳外面），导致 Ctrl+K 看起来"没反应"。
  /// HardwareKeyboard 挂在焦点系统之前，无论焦点在哪、输入框是否激活都能触发。
  bool _onHardwareKey(KeyEvent event) {
    if (!mounted) return false;
    if (event is! KeyDownEvent) return false;
    // 修饰键状态在 3.47 上已从 KeyEvent 挪到 HardwareKeyboard 单例
    final HardwareKeyboard kb = HardwareKeyboard.instance;
    if (!kb.isControlPressed ||
        kb.isAltPressed ||
        kb.isMetaPressed ||
        kb.isShiftPressed) {
      return false;
    }
    if (event.logicalKey == LogicalKeyboardKey.keyK) {
      _openPalette();
      return true;
    }
    if (event.logicalKey == LogicalKeyboardKey.keyB) {
      _toggleRail();
      return true;
    }
    return false;
  }

  Future<void> _loadRailPref() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() => _railCollapsed = prefs.getBool(_railPrefKey) ?? false);
  }

  Future<void> _toggleRail() async {
    final bool next = !_railCollapsed;
    setState(() => _railCollapsed = next);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_railPrefKey, next);
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
      final n =
          total is Map ? int.tryParse('${total['unpaid_count']}') ?? 0 : 0;
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

  void _openPalette() {
    if (_paletteOpen) return;
    _paletteOpen = true;
    showDesktopCommandPalette(context, onNavigate: _go, auth: widget.auth)
        .whenComplete(() => _paletteOpen = false);
  }

  /// 当前路由在导航模型里的位置，给工具条画「分组 › 页面」。
  ({String group, String title}) _crumb(String route) {
    for (final DesktopNavSection s in kDesktopNav) {
      for (final DesktopNavItem i in s.items) {
        if (i.route == route ||
            (i.route != null && route.startsWith('${i.route}/'))) {
          return (group: s.title, title: i.title);
        }
      }
    }
    return (group: '', title: '工作台');
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
        return _PlaceholderPage(title: _crumb(route).title);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ({String group, String title}) crumb = _crumb(_route);
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: DesktopBackdrop(
        child: Row(
          children: [
            DesktopRail(
              sections: filterDesktopNav(kDesktopNav, _nav.hidden),
              badges: <String, int>{'/payables': _unpaidPayables},
              currentRoute: _route,
              onSelect: _onSelect,
              auth: widget.auth,
              collapsed: _railCollapsed,
              onToggleCollapse: _toggleRail,
            ),
            Expanded(
              child: Column(
                children: [
                  DesktopToolbar(
                    groupTitle: crumb.group,
                    pageTitle: crumb.title,
                    auth: widget.auth,
                    onOpenSearch: _openPalette,
                    // 短时缓存 45s 内直接回旧数据，所以「刷新」必须先把缓存清掉，
                    // 再让页面重建重新取数，否则按钮点了像没反应。
                    onRefresh: () {
                      ApiService.invalidateCache();
                      setState(() => _reloadTick++);
                    },
                  ),
                  Expanded(
                    child: DesktopPageTransition(
                      // 切分仓 / 点刷新都要整页重建，各页 initState 重新取数
                      routeKey:
                          '$_route@${widget.auth.warehouseKey}@$_reloadTick',
                      child: _buildContent(),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PlaceholderPage extends StatelessWidget {
  const _PlaceholderPage({required this.title});
  final String title;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: WsTokens.contentPadding,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.add_box_outlined,
              size: 40, color: WsTokens.mutedLight),
          const SizedBox(height: 14),
          Text('$title · 桌面版待移植',
              style: TextStyle(
                  fontSize: 15, color: WsTokens.inkOf(context, level: 2))),
          const SizedBox(height: 6),
          const Text('如仍显示此页，说明该路由尚未接上对应页面。',
              style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
        ],
      ),
    );
  }
}
