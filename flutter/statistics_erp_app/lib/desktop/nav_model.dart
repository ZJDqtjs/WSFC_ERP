import 'package:flutter/material.dart';

/// 一个侧边栏条目。[route] 为 null 表示该页尚未移植到桌面端（渲染为禁用项）。
class DesktopNavItem {
  const DesktopNavItem({
    required this.title,
    required this.icon,
    this.route,
    this.special,
  });

  final String title;
  final IconData icon;

  /// 路由；桌面壳内点击时跳转。null = 未移植。
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
/// 未移植页面先占位禁用，后续轮次补 route 即可点亮。
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
      DesktopNavItem(title: '入仓', icon: Icons.storefront_outlined),
    ],
  ),
  DesktopNavSection(
    title: '商品资料',
    items: [
      DesktopNavItem(title: '商品', icon: Icons.tag_outlined, route: '/products'),
      DesktopNavItem(title: '关联结算', icon: Icons.receipt_long_outlined),
      DesktopNavItem(title: '包材', icon: Icons.inventory_outlined),
      DesktopNavItem(title: '人工', icon: Icons.groups_outlined),
      DesktopNavItem(title: '快递费', icon: Icons.local_shipping_outlined),
      DesktopNavItem(title: '一单多货', icon: Icons.link, route: '/rules'),
    ],
  ),
  DesktopNavSection(
    title: '经营分析',
    items: [
      DesktopNavItem(title: '财务报表', icon: Icons.insert_chart_outlined_outlined),
      DesktopNavItem(title: '财务流水', icon: Icons.payments_outlined, route: '/finance'),
      DesktopNavItem(title: '其他开支', icon: Icons.account_balance_outlined, route: '/expenses'),
      DesktopNavItem(title: '待付款账单', icon: Icons.credit_card_outlined, route: '/payables'),
    ],
  ),
  DesktopNavSection(
    title: '数据工具',
    items: [
      DesktopNavItem(title: '鲜货现采', icon: Icons.shopping_cart_outlined, route: '/fresh'),
      DesktopNavItem(title: '扣点', icon: Icons.calculate_outlined),
    ],
  ),
  DesktopNavSection(
    title: '设置',
    items: [
      DesktopNavItem(title: '切换分仓', icon: Icons.storage_outlined, special: SpecialAction.switchWarehouse),
      DesktopNavItem(title: '设置', icon: Icons.settings_outlined),
    ],
  ),
];

/// 展平后的可导航项（不含分组标题），供侧边栏计算选中索引。
class FlatNav {
  FlatNav(List<DesktopNavSection> sections) : items = [
        for (final s in sections)
          for (final i in s.items) i,
      ];
  final List<DesktopNavItem> items;

  int? indexOfRoute(String route) {
    for (var k = 0; k < items.length; k++) {
      if (items[k].route == route) return k;
    }
    return null;
  }
}

