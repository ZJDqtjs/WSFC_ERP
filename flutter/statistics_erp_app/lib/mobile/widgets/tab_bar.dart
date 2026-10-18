import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../mobile_style.dart';

/// 移动端五个一级 Tab。路径与旧版一致，redirect 与深链不用改。
class MobileTab {
  const MobileTab({
    required this.path,
    required this.label,
    required this.icon,
    required this.activeIcon,
  });

  final String path;
  final String label;
  final IconData icon;
  final IconData activeIcon;
}

const List<MobileTab> kMobileTabs = [
  MobileTab(path: '/home', label: '工作台', icon: Icons.space_dashboard_outlined, activeIcon: Icons.space_dashboard),
  MobileTab(path: '/outbound', label: '出库', icon: Icons.outbox_outlined, activeIcon: Icons.outbox),
  MobileTab(path: '/inbound', label: '入库', icon: Icons.inbox_outlined, activeIcon: Icons.inbox),
  MobileTab(path: '/stock', label: '库存', icon: Icons.inventory_2_outlined, activeIcon: Icons.inventory_2),
  MobileTab(path: '/mine', label: '我的', icon: Icons.person_outline, activeIcon: Icons.person),
];

int tabIndexOf(String path) {
  final i = kMobileTabs.indexWhere((t) => path.startsWith(t.path));
  return i < 0 ? 0 : i;
}

/// 底部玻璃标签栏。放在 [GlassScaffold.bottomBar] 里。
class MobileTabBar extends StatelessWidget {
  const MobileTabBar({super.key, required this.currentIndex});

  final int currentIndex;

  @override
  Widget build(BuildContext context) {
    return GlassTabBar.bottom(
      selectedIndex: currentIndex,
      onTabSelected: (i) => context.go(kMobileTabs[i].path),
      barHeight: 58,
      verticalPadding: 10,
      horizontalPadding: 14,
      iconSize: 23,
      labelFontSize: 11,
      magnification: 1.1,
      selectedIconColor: Mc.brand,
      selectedLabelColor: Mc.brand,
      unselectedIconColor: Mc.inkThird,
      unselectedLabelColor: Mc.inkThird,
      selectedLabelStyle: const TextStyle(fontWeight: FontWeight.w600),
      tabs: [
        for (final t in kMobileTabs)
          GlassTab(
            label: t.label,
            icon: Icon(t.icon),
            activeIcon: Icon(t.activeIcon),
            glowColor: Mc.brand.withValues(alpha: 0.5),
          ),
      ],
    );
  }
}
