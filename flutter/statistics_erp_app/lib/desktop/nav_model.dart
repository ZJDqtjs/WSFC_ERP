import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一个侧边栏条目。[route] 为 null 表示该项不是页面（如「切换分仓」），
/// 由 [special] 动作处理；两者都为 null 时渲染为禁用项。
class DesktopNavItem {
  const DesktopNavItem({
    required this.title,
    required this.icon,
    this.route,
    this.special,
  });

  final String title;
  final IconData icon;

  /// 路由；桌面壳内点击时跳转。
  final String? route;

  /// 非路由动作（如「切换分仓」弹层），由壳层单独处理。
  final SpecialAction? special;

  bool get enabled => route != null || special != null;
}

enum SpecialAction { switchWarehouse, logout }

/// 一个分组（对应 web 的 .nav-group 标题）。
class DesktopNavSection {
  const DesktopNavSection({required this.title, required this.items});
  final String title;
  final List<DesktopNavItem> items;
}

/// 桌面侧边栏结构，1:1 复刻 web/static/index.html 的 .sidebar。
/// 显隐偏好（web 模块显示）由 [filterDesktopNav] 在壳层应用。
const List<DesktopNavSection> kDesktopNav = [
  DesktopNavSection(
    title: '',
    items: [
      DesktopNavItem(title: '工作台', icon: Icons.home_outlined, route: '/home'),
    ],
  ),
  DesktopNavSection(
    title: '业务管理',
    items: [
      DesktopNavItem(title: '库存管理', icon: Icons.inventory_2_outlined, route: '/stock'),
      DesktopNavItem(title: '入库', icon: Icons.download_outlined, route: '/inbound'),
      DesktopNavItem(title: '出库 / 销售', icon: Icons.upload_outlined, route: '/outbound'),
      DesktopNavItem(title: '入仓', icon: Icons.storefront_outlined, route: '/warehouse-in'),
    ],
  ),
  DesktopNavSection(
    title: '商品资料',
    items: [
      DesktopNavItem(title: '商品', icon: Icons.tag_outlined, route: '/products'),
      DesktopNavItem(title: '关联结算', icon: Icons.receipt_long_outlined, route: '/products/order'),
      DesktopNavItem(title: '包材', icon: Icons.inventory_outlined, route: '/products/pack'),
      DesktopNavItem(title: '人工', icon: Icons.groups_outlined, route: '/products/labor'),
      DesktopNavItem(title: '快递费', icon: Icons.local_shipping_outlined, route: '/express'),
      DesktopNavItem(title: '一单多货', icon: Icons.link, route: '/rules'),
    ],
  ),
  DesktopNavSection(
    title: '经营分析',
    items: [
      DesktopNavItem(title: '财务报表', icon: Icons.insert_chart_outlined_outlined, route: '/report'),
      DesktopNavItem(title: '其他开支', icon: Icons.account_balance_outlined, route: '/expenses'),
      DesktopNavItem(title: '待付款账单', icon: Icons.credit_card_outlined, route: '/payables'),
    ],
  ),
  DesktopNavSection(
    title: '数据工具',
    items: [
      DesktopNavItem(title: '鲜货现采', icon: Icons.shopping_cart_outlined, route: '/fresh'),
      DesktopNavItem(title: '扣点', icon: Icons.calculate_outlined, route: '/deduction'),
    ],
  ),
  DesktopNavSection(
    title: '设置',
    items: [
      DesktopNavItem(title: '切换分仓', icon: Icons.storage_outlined, special: SpecialAction.switchWarehouse),
      DesktopNavItem(title: '设置', icon: Icons.settings_outlined, route: '/settings'),
    ],
  ),
];

/// 侧边栏条目的稳定标识（web navModKey 的桌面版）：有路由的项去掉开头斜杠，
/// 特殊动作用 action:<name>。设置页「模块显示」与壳层显隐过滤共用这里的 key。
String desktopNavModKey(DesktopNavItem item) {
  final special = item.special;
  if (special != null) return 'action:${special.name}';
  final route = item.route;
  if (route != null && route.isNotEmpty) return route.replaceFirst('/', '');
  return item.title;
}

/// 「设置」入口固定显示，不可隐藏（web applyNavVisibility 的 locked 判断）。
bool desktopNavLocked(DesktopNavItem item) => item.route == '/settings';

/// 按本机偏好过滤侧边栏：隐藏项连同空分组一起剔除。
List<DesktopNavSection> filterDesktopNav(
    List<DesktopNavSection> sections, Set<String> hidden) {
  final result = <DesktopNavSection>[];
  for (final s in sections) {
    final items = [
      for (final i in s.items)
        if (desktopNavLocked(i) || !hidden.contains(desktopNavModKey(i))) i,
    ];
    if (items.isEmpty) continue;
    result.add(DesktopNavSection(title: s.title, items: items));
  }
  return result;
}

/// 侧边栏显隐偏好（web NAV_HIDDEN_KEY 的桌面版）：本机存储、按分仓各自独立。
/// 设置页「模块显示」写入，壳层监听本对象即时重算菜单。
class DesktopNavVisibility extends ChangeNotifier {
  DesktopNavVisibility._();

  static final DesktopNavVisibility instance = DesktopNavVisibility._();

  static const String _baseKey = 'erp_nav_hidden';

  Set<String> _hidden = <String>{};
  Set<String> get hidden => _hidden;

  String _keyFor(String warehouseKey) =>
      warehouseKey.isEmpty ? _baseKey : '$_baseKey:$warehouseKey';

  Future<void> load(String warehouseKey) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_keyFor(warehouseKey));
    Set<String> next = <String>{};
    if (raw != null) {
      try {
        next = (jsonDecode(raw) as List).map((e) => e.toString()).toSet();
      } catch (_) {
        // 解析失败视为没有隐藏项（web getHiddenNavMods 同款兜底）
      }
    }
    _hidden = next;
    notifyListeners();
  }

  Future<void> save(String warehouseKey, Set<String> hidden) async {
    _hidden = hidden;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyFor(warehouseKey), jsonEncode(hidden.toList()));
    notifyListeners();
  }
}

