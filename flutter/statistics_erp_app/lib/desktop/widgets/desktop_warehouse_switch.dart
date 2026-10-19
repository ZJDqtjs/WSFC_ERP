import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../fluent_theme.dart';
import 'desktop_ui.dart';

/// 「切换分仓」弹层（web openWarehouseModal / loadWarehouses / switchWarehouse /
/// createWarehouse 的桌面复刻）。
///
/// 切换通过 [AuthProvider.switchWarehouse]：后端会重签 erp_token 会话 cookie
/// （只影响当前登录会话，其他在线用户不受影响、无需重新登录），
/// AuthProvider 随后 notifyListeners()——桌面壳（desktop_shell）监听 auth 即可
/// 感知分仓变化并刷新数据；壳层若未监听，请在 `await showWarehouseSwitcher(...)`
/// 返回后自行 setState 触发各页重取。
Future<void> showWarehouseSwitcher(BuildContext context, AuthProvider auth) async {
  await showDialog<void>(
    context: context,
    builder: (_) => _WarehouseSwitchDialog(auth: auth),
  );
}

class _WarehouseSwitchDialog extends StatefulWidget {
  const _WarehouseSwitchDialog({required this.auth});

  final AuthProvider auth;

  @override
  State<_WarehouseSwitchDialog> createState() => _WarehouseSwitchDialogState();
}

class _WarehouseSwitchDialogState extends State<_WarehouseSwitchDialog> {
  final TextEditingController _nameCtrl = TextEditingController();
  List<dynamic> _list = const [];
  String _current = '';
  String _error = '';
  bool _loading = true;
  bool _busy = false;

  bool get _isAdmin => widget.auth.user['role'].toString() == 'admin';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final d = await ApiService.warehouses();
      if (!mounted) return;
      setState(() {
        _list = (d['warehouses'] as List?) ?? const [];
        _current = (d['current'] ?? '').toString();
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _switch(String key, String name) async {
    // 分仓只作用于当前登录会话：不登出、不影响其他在线用户（与 web 相同文案）
    final ok = await wsConfirm(
      context,
      title: '切换分仓',
      message: '切换到「${name.isEmpty ? key : name}」？'
          '仅你的登录会切到该分仓，其他在线用户不受影响，也无需重新登录。',
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    try {
      await widget.auth.switchWarehouse(key);
      if (!mounted) return;
      wsToast(context, '已切换到 ${name.isEmpty ? key : name}');
      Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
      });
    }
  }

  Future<void> _create() async {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty) {
      setState(() => _error = '请输入分仓名称');
      return;
    }
    final ok = await wsConfirm(
      context,
      title: '新建分仓',
      message: '新建「$name」并把你的登录切过去？无需重新登录，也不影响其他在线用户。',
    );
    if (!ok || !mounted) return;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      // key 传空串：后端自动生成 whNN；创建会重签会话 cookie，登录即切到新仓
      await ApiService.createWarehouse('', name);
      await widget.auth.refreshWarehouses();
      if (!mounted) return;
      wsToast(context, '已创建并切换到 $name');
      Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Dialog(
      backgroundColor: dark ? WsTokens.cardDark : WsTokens.cardLight,
      insetPadding: const EdgeInsets.all(28),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(WsTokens.radiusLg)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480, maxHeight: 620),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 18, 22, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Expanded(
                    child: Text('切换分仓',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  ),
                  DesktopIconButton(
                    icon: Icons.close,
                    color: WsTokens.mutedLight,
                    tooltip: '关闭',
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              if (_error.isNotEmpty) DesktopNotice(_error, kind: DesktopNoticeKind.error),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Center(
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2.2),
                    ),
                  ),
                )
              else if (_list.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 16),
                  child: Text('暂无分仓',
                      style: TextStyle(fontSize: 13, color: WsTokens.mutedLight)),
                )
              else
                Flexible(
                  child: SingleChildScrollView(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (final w in _list.whereType<Map>())
                          Container(
                            padding: const EdgeInsets.symmetric(vertical: 9),
                            decoration: BoxDecoration(
                              border: Border(
                                bottom: BorderSide(
                                    color: dark ? WsTokens.borderDark : WsTokens.borderLight),
                              ),
                            ),
                            child: Row(
                              children: [
                                Flexible(
                                  child: Text(wsS(w['name']),
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                          fontSize: 13.5, fontWeight: FontWeight.w600)),
                                ),
                                const SizedBox(width: 8),
                                Text(wsS(w['key']),
                                    style: const TextStyle(
                                        fontSize: 12, color: WsTokens.mutedLight)),
                                const Spacer(),
                                if (wsS(w['key']) == _current)
                                  const DesktopTag('当前', color: WsTokens.primary)
                                else
                                  DesktopButton(
                                    label: '切换',
                                    small: true,
                                    onPressed: _busy
                                        ? null
                                        : () => _switch(wsS(w['key']), wsS(w['name'])),
                                  ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                if (_isAdmin) ...[
                  const Divider(),
                  const SizedBox(height: 8),
                  const Text('新建分仓名称',
                      style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                  const SizedBox(height: 6),
                  DesktopTextField(
                    controller: _nameCtrl,
                    hintText: '如：昆明仓',
                    onSubmitted: _busy ? null : (_) => _create(),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      DesktopButton(
                        label: '＋ 新建并切换',
                        icon: Icons.add,
                        kind: DesktopButtonKind.success,
                        onPressed: _busy ? null : _create,
                      ),
                    ],
                  ),
                ] else
                  const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Text('仅管理员可新建分仓',
                        style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                  ),
            ],
          ),
        ),
      ),
    );
  }
}
