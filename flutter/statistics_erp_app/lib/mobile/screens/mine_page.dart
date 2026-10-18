import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:provider/provider.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../mobile_style.dart';
import '../widgets/mobile_page.dart';
import '../widgets/motion.dart';
import '../widgets/parts.dart';

/// 我的：身份、分仓、业务入口、服务状态。
class MobileMinePage extends StatefulWidget {
  const MobileMinePage({super.key});

  @override
  State<MobileMinePage> createState() => _MobileMinePageState();
}

class _MobileMinePageState extends State<MobileMinePage> {
  Map<String, dynamic> _maintenance = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final auth = context.read<AuthProvider>();
    try {
      await auth.fetchUserInfo();
      await auth.refreshWarehouses();
      _maintenance = await ApiService.maintenanceStatus();
    } on ApiException catch (_) {
      // 未登录或维护状态取不到都不影响这一页
    }
    if (mounted) setState(() {});
  }

  void _toast(String msg, {bool error = false}) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Mc.danger : null,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final role = (auth.user['role'] ?? '').toString() == 'admin' ? '管理员' : '业务员';
    final isAdmin = (auth.user['role'] ?? '').toString() == 'admin';
    final whName = auth.warehouseName.isEmpty ? auth.warehouseKey : auth.warehouseName;
    final running = _maintenance['running'] == true;

    return MobilePage(
      title: '我的',
      subtitle: whName.isEmpty ? null : whName,
      tabIndex: 4,
      onRefresh: _load,
      actions: [pageAction(Icons.refresh_rounded, _load, tooltip: '刷新')],
      body: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 32),
        children: [
        StaggerItem(
          index: 0,
          child: BrandCard(
            onTap: isAdmin ? () => _pickWarehouse(auth) : null,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Container(
                    width: 52,
                    height: 52,
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.22),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.person, color: Colors.white, size: 28),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(auth.displayName,
                            style: const TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w700,
                                color: Colors.white)),
                        const SizedBox(height: 4),
                        Text('$role · ${auth.user['username'] ?? ''}',
                            style: TextStyle(
                                fontSize: 12,
                                color: Colors.white.withValues(alpha: 0.85))),
                      ],
                    ),
                  ),
                  if (isAdmin)
                    const Icon(Icons.swap_horiz, color: Colors.white, size: 22),
                ],
              ),
            ),
          ),
        ),
        const SectionHeader(title: '当前分仓', top: 20),
        StaggerItem(
          index: 1,
          child: GlassPanel(
            padding: EdgeInsets.zero,
            child: TileRow(
              title: whName.isEmpty ? '未指定' : whName,
              subtitle: auth.warehouses.isEmpty
                  ? null
                  : '共 ${auth.warehouses.length} 个仓 · 切仓后所有页面读新仓数据',
              icon: Icons.warehouse_outlined,
              trailing: isAdmin
                  ? TextButton(
                      onPressed: () => _pickWarehouse(auth),
                      child: const Text('切换'),
                    )
                  : const Text('仅管理员可切',
                      style: TextStyle(fontSize: 12, color: Mc.inkThird)),
              onTap: isAdmin ? () => _pickWarehouse(auth) : null,
            ),
          ),
        ),
        const SectionHeader(title: '业务', top: 20),
        const StaggerItem(
          index: 2,
          child: GlassPanel(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                _EntryTile(title: '商品', subtitle: '建品 / 改价 / 停用 / 批量', route: '/products', icon: Icons.category_outlined),
                _EntryTile(title: '待付款', subtitle: '入库·出库·开支的挂账与代发账单', route: '/payables', icon: Icons.account_balance_wallet_outlined),
                _EntryTile(title: '其他开支', subtitle: '房租水电装卸等零星支出', route: '/expenses', icon: Icons.receipt_long_outlined),
                _EntryTile(title: '财务流水', subtitle: '收入支出台账与手动记账', route: '/finance', icon: Icons.show_chart),
                _EntryTile(title: '规则设置', subtitle: '扣点 / 店铺扣点 / 快递 / 打包', route: '/rules', icon: Icons.tune),
                _EntryTile(title: '鲜货现采', subtitle: '鲜货清单与今日需求预演算', route: '/fresh', icon: Icons.storefront_outlined, push: false),
              ],
            ),
          ),
        ),
        const SectionHeader(title: '服务', top: 20),
        StaggerItem(
          index: 3,
          child: GlassPanel(
            padding: EdgeInsets.zero,
            child: TileRow(
              title: running ? '服务端正在执行：${_maintenance['task'] ?? _maintenance['stage']}' : '服务正常',
              subtitle: '接口地址 ${ApiService.baseUrl}',
              icon: running ? Icons.build_circle_outlined : Icons.check_circle_outline,
              iconColor: running ? Mc.warn : Mc.fresh,
            ),
          ),
        ),
        const SizedBox(height: 26),
        StaggerItem(
          index: 4,
          child: SizedBox(
            height: 46,
            child: OutlinedButton(
              onPressed: _logout,
              style: OutlinedButton.styleFrom(
                foregroundColor: Mc.danger,
                side: BorderSide(color: Mc.danger.withValues(alpha: 0.5)),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(Mc.radiusTile)),
              ),
              child: const Text('退出登录'),
            ),
          ),
        ),
        const SizedBox(height: 14),
        const Center(
          child: Text('企业台账 · 移动端',
              style: TextStyle(fontSize: 11, color: Mc.inkThird)),
        ),
      ],
      ),
    );
  }

  Future<void> _pickWarehouse(AuthProvider auth) async {
    if (auth.warehouses.isEmpty) await auth.refreshWarehouses();
    if (!mounted) return;
    final list = auth.warehouses;
    if (list.isEmpty) {
      _toast('没有可用分仓', error: true);
      return;
    }
    final key = await GlassModalSheet.show<String>(
      context: context,
      initialState: GlassSheetState.half,
      builder: (sheetContext) {
        final close = Navigator.of(sheetContext);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(4, 4, 4, 12),
              child: Text('切换分仓',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            ),
            for (final w in list)
              _WarehouseOption(
                name: (w['name'] ?? '').toString(),
                keyName: (w['key'] ?? '').toString(),
                current: (w['key'] ?? '').toString() == auth.warehouseKey,
                onTap: () => close.pop((w['key'] ?? '').toString()),
              ),
          ],
        );
      },
    );
    if (key == null || key == auth.warehouseKey) return;
    try {
      await auth.switchWarehouse(key);
      _toast('已切换到新分仓');
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('确认退出当前账号？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('确认')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    await context.read<AuthProvider>().logout();
    if (mounted) context.go('/login');
  }
}

class _WarehouseOption extends StatelessWidget {
  const _WarehouseOption({
    required this.name,
    required this.keyName,
    required this.current,
    required this.onTap,
  });

  final String name;
  final String keyName;
  final bool current;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Mc.radiusTile),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 12),
        child: Row(
          children: [
            Icon(
              current ? Icons.radio_button_checked : Icons.radio_button_off,
              size: 20,
              color: current ? Mc.brand : Mc.inkThird,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name.isEmpty ? keyName : name,
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  if (name.isNotEmpty)
                    Text(keyName,
                        style: const TextStyle(fontSize: 11, color: Mc.inkThird)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EntryTile extends StatelessWidget {
  const _EntryTile({
    required this.title,
    required this.subtitle,
    required this.route,
    required this.icon,
    this.push = true,
  });

  final String title;
  final String subtitle;
  final String route;
  final IconData icon;
  final bool push;

  @override
  Widget build(BuildContext context) {
    return TileRow(
      title: title,
      subtitle: subtitle,
      icon: icon,
      onTap: () => push ? context.push(route) : context.go(route),
    );
  }
}
