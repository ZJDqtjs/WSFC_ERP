import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';
import '../services/api_service.dart';

/// 我的：身份 + 分仓切换 + 各业务页入口 + 服务状态。
class MineScreen extends StatefulWidget {
  const MineScreen({super.key});

  @override
  State<MineScreen> createState() => _MineScreenState();
}

class _MineScreenState extends State<MineScreen> {
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


  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('我的'),
        centerTitle: true,
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(12),
          children: [
            _buildUserCard(auth),
            const SizedBox(height: 12),
            _buildWarehouseCard(auth),
            const SizedBox(height: 12),
            _buildEntries(),
            const SizedBox(height: 12),
            _buildServiceCard(),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              height: 44,
              child: ElevatedButton(
                onPressed: _logout,
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red,
                  foregroundColor: Colors.white,
                ),
                child: const Text('退出登录'),
              ),
            ),
            const SizedBox(height: 16),
            Center(
              child: Text(
                '企业台账 · Flutter 移动端 · 接口由 Go 服务提供',
                style: TextStyle(color: Colors.grey[600], fontSize: 12),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildUserCard(AuthProvider auth) {
    final role = (auth.user['role'] ?? '').toString() == 'admin' ? '管理员' : '业务员';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const CircleAvatar(
              radius: 26,
              backgroundColor: Color(0xFF1989FA),
              child: Icon(Icons.person, size: 30, color: Colors.white),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(auth.displayName,
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
                  const SizedBox(height: 4),
                  Text('$role · ${auth.user['username'] ?? ''}',
                      style: TextStyle(color: Colors.grey[600], fontSize: 12)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 分仓切换：切仓会重签会话 cookie，之后所有页面都读新仓的数据
  Widget _buildWarehouseCard(AuthProvider auth) {
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            leading: const Icon(Icons.warehouse_outlined),
            title: Text('当前分仓：${auth.warehouseName.isEmpty ? auth.warehouseKey : auth.warehouseName}'),
            subtitle: auth.warehouses.isEmpty
                ? null
                : Text('共 ${auth.warehouses.length} 个仓'),
            trailing: IconButton(
              icon: const Icon(Icons.swap_horiz),
              tooltip: '切换分仓',
              onPressed: () => _pickWarehouse(auth),
            ),
          ),
          if ((auth.user['role'] ?? '').toString() != 'admin')
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Text('只有管理员可以切换分仓',
                  style: TextStyle(fontSize: 12, color: Colors.grey[600])),
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
    final key = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('切换分仓'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ...list.map((w) {
              final key = (w['key'] ?? '').toString();
              final current = key == auth.warehouseKey;
              return ListTile(
                leading: Icon(current ? Icons.check_circle : Icons.circle_outlined,
                    color: current ? const Color(0xFF1989FA) : Colors.grey),
                title: Text((w['name'] ?? '').toString()),
                subtitle: Text(key),
                onTap: () => Navigator.pop(context, key),
              );
            }),
          ],
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消'))],
      ),
    );
    if (key == null || key == auth.warehouseKey) return;
    try {
      await auth.switchWarehouse(key);
      _toast('已切换到新分仓');
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Widget _buildEntries() {
    const items = <_Entry>[
      _Entry('商品', '建品 / 改价 / 停用 / 批量', '/products', Icons.category_outlined),
      _Entry('待付款', '入库·出库·开支的挂账与代发账单', '/payables', Icons.account_balance_wallet_outlined),
      _Entry('其他开支', '房租水电装卸等零星支出', '/expenses', Icons.receipt_long_outlined),
      _Entry('财务流水', '收入支出台账与手动记账', '/finance', Icons.show_chart),
      _Entry('规则设置', '扣点 / 店铺扣点 / 快递 / 打包规则', '/rules', Icons.tune),
      _Entry('鲜货现采', '鲜货清单与今日需求预演算', '/fresh', Icons.storefront_outlined),
    ];
    return Card(
      child: Column(
        children: [
          for (final e in items)
            ListTile(
              leading: Icon(e.icon),
              title: Text(e.title),
              subtitle: Text(e.subtitle, style: const TextStyle(fontSize: 12)),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push(e.route),
            ),
          const Divider(height: 1),
          ListTile(
            leading: const Icon(Icons.inventory_2_outlined),
            title: const Text('库存与盘点'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.go('/stock'),
          ),
        ],
      ),
    );
  }

  /// 后端维护状态（Go 直供）：正在执行备份/同步时给出提示
  Widget _buildServiceCard() {
    final running = _maintenance['running'] == true;
    final label = _maintenance['task'] ?? _maintenance['stage'] ?? '';
    return Card(
      child: ListTile(
        leading: Icon(running ? Icons.build_circle_outlined : Icons.check_circle_outline,
            color: running ? Colors.orange : Colors.green),
        title: Text(running ? '服务端正在执行：$label' : '服务正常'),
        subtitle: Text(
          '接口地址：${ApiService.resolveUrl('/health').replaceFirst('/health', '')}'
          '${_maintenance['message'] is String && (_maintenance['message'] as String).isNotEmpty ? ' · ${_maintenance['message']}' : ''}',
          style: const TextStyle(fontSize: 12),
        ),
      ),
    );
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Colors.red.shade600 : null,
    ));
  }

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('确认退出当前账号？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('确认')),
        ],
      ),
    );
    if (ok != true) return;
    if (!mounted) return;
    await context.read<AuthProvider>().logout();
    if (mounted) context.go('/login');
  }
}

class _Entry {
  const _Entry(this.title, this.subtitle, this.route, this.icon);

  final String title;
  final String subtitle;
  final String route;
  final IconData icon;
}



