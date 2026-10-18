import 'package:flutter/material.dart';

import '../providers/auth_provider.dart';
import 'desktop_sidebar.dart';
import 'fluent_theme.dart';
import 'nav_model.dart';
import 'screens/desktop_home.dart';
import 'widgets/desktop_motion.dart';

/// 桌面主壳：左侧 [DesktopSidebar] + 右侧内容区。
/// 本轮只把「工作台」接成真实 Fluent 页，其余已注册路由先显示占位页。
class DesktopShell extends StatefulWidget {
  const DesktopShell({super.key, required this.auth});
  final AuthProvider auth;

  @override
  State<DesktopShell> createState() => _DesktopShellState();
}

class _DesktopShellState extends State<DesktopShell> {
  String _route = '/home';

  void _onSelect(DesktopNavItem item) {
    if (item.special != null) {
      _handleSpecial(item.special!);
      return;
    }
    if (item.route != null) setState(() => _route = item.route!);
  }

  void _handleSpecial(SpecialAction action) {
    switch (action) {
      case SpecialAction.switchWarehouse:
        // TODO(desktop): 分仓切换弹层，后续轮次补
        break;
      case SpecialAction.logout:
        widget.auth.logout();
        break;
    }
  }

  Widget _buildContent() {
    switch (_route) {
      case '/home':
        return DesktopHome(
          auth: widget.auth,
          onNavigate: (r) => setState(() => _route = r),
        );
      default:
        return _PlaceholderPage(title: _titleOf(_route));
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
            currentRoute: _route,
            onSelect: _onSelect,
            auth: widget.auth,
          ),
          Expanded(
            child: Container(
              color: Theme.of(context).scaffoldBackgroundColor,
              child: DesktopPageTransition(
                routeKey: _route,
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
          const Text('当前轮次先打通「工作台」，其余页面后续按同一套 Fluent 壳复刻。',
              style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
        ],
      ),
    );
  }
}
