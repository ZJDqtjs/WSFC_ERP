import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';

class MineScreen extends StatefulWidget {
  const MineScreen({super.key});

  @override
  State<MineScreen> createState() => _MineScreenState();
}

class _MineScreenState extends State<MineScreen> {
  Map<String, dynamic> _user = {};
  int _backupInterval = 2;

  @override
  void initState() {
    super.initState();
    _loadUserInfo();
  }

  Future<void> _loadUserInfo() async {
    try {
      final authProvider = context.read<AuthProvider>();
      final user = await authProvider.fetchUserInfo();
      setState(() => _user = user);
    } catch (e) {
      // 忽略错误
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('我的'),
        centerTitle: true,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 用户信息卡片
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    const CircleAvatar(
                      radius: 30,
                      backgroundColor: Color(0xFF1989FA),
                      child: Icon(Icons.person, size: 40, color: Colors.white),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _user['name']?.isNotEmpty == true
                                ? _user['name']
                                : (_user['username'] ?? '用户'),
                            style: const TextStyle(
                              fontWeight: FontWeight.bold,
                              fontSize: 17,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '${_user['role'] == 'admin' ? '管理员' : '业务员'} · 企业台账系统',
                            style: TextStyle(color: Colors.grey[600], fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // 快捷入口
            Card(
              child: Column(
                children: [
                  ListTile(
                    leading: const Text('📷', style: TextStyle(fontSize: 20)),
                    title: const Text('拍单识别'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.go('/home'),
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Text('💾', style: TextStyle(fontSize: 20)),
                    title: const Text('备份与恢复'),
                    subtitle: Text('桌面端「备份与恢复」页可管理，自动备份每 $_backupInterval 小时一次'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.go('/home'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // 退出登录按钮
            SizedBox(
              width: double.infinity,
              height: 44,
              child: ElevatedButton(
                onPressed: _logout,
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(20),
                  ),
                ),
                child: const Text('退出登录', style: TextStyle(fontSize: 16)),
              ),
            ),
            const SizedBox(height: 24),

            // 版本信息
            Center(
              child: Text(
                '企业台账 · 移动端 Flutter · v0.1',
                style: TextStyle(color: Colors.grey[600], fontSize: 12),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _logout() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('确认退出当前账号？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            child: const Text('确认'),
          ),
        ],
      ),
    );

    if (confirmed == true && mounted) {
      final authProvider = context.read<AuthProvider>();
      await authProvider.logout();
      if (mounted) {
        context.go('/login');
      }
    }
  }
}
