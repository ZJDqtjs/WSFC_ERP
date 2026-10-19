import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../providers/auth_provider.dart';
import 'desktop_style.dart';
import 'widgets/desktop_motion.dart';
import 'widgets/desktop_rail.dart';

enum _LoginMode { privateKey, password }

/// 桌面登录页。底板与主壳同一套极光 + 玻璃，登录后视觉不跳。
/// 复用与移动端同一套 AuthProvider（私钥 / 口令两条通道）。
class DesktopLogin extends StatefulWidget {
  const DesktopLogin({super.key, required this.auth});
  final AuthProvider auth;

  @override
  State<DesktopLogin> createState() => _DesktopLoginState();
}

class _DesktopLoginState extends State<DesktopLogin> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _pasteKey = TextEditingController();
  _LoginMode _mode = _LoginMode.privateKey;
  String _keyContent = '';
  String? _keyFileName;
  bool _showPaste = false;
  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _pasteKey.dispose();
    super.dispose();
  }

  String? _keyFileProblem(String text) {
    if (!text.contains('PRIVATE KEY')) return '文件里没有私钥标记，请确认选的是私钥文件本身';
    if (text.contains('RSA PRIVATE KEY')) return '后端只支持 Ed25519 私钥，这是 RSA 私钥';
    if (text.contains('EC PRIVATE KEY')) return '后端只支持 Ed25519 私钥，这是 EC 私钥';
    if (text.contains('ENCRYPTED PRIVATE KEY')) {
      return '后端不支持带口令加密的私钥，请用未加密的 id_ed25519';
    }
    return null;
  }

  Future<void> _pickKeyFile() async {
    setState(() => _error = null);
    try {
      final result = await FilePicker.platform
          .pickFiles(type: FileType.any, withData: true);
      if (result == null || result.files.isEmpty) return;
      final file = result.files.first;
      final bytes = file.bytes;
      if (bytes == null) {
        setState(() => _error = '读取私钥文件失败，请改用「粘贴私钥内容」');
        return;
      }
      final text = utf8.decode(bytes, allowMalformed: true);
      final problem = _keyFileProblem(text);
      if (problem != null) {
        setState(() => _error = '$problem（${file.name}）');
        return;
      }
      setState(() {
        _keyContent = text;
        _keyFileName = file.name;
      });
    } catch (e) {
      setState(() => _error = '选择私钥文件失败：$e');
    }
  }

  Future<void> _submit() async {
    final username = _username.text.trim();
    if (username.isEmpty) {
      setState(() => _error = '请输入用户名');
      return;
    }
    if (_mode == _LoginMode.privateKey && _keyContent.trim().isEmpty) {
      setState(() => _error = _showPaste ? '请先粘贴私钥内容' : '请先选择私钥文件');
      return;
    }
    if (_mode == _LoginMode.password && _password.text.isEmpty) {
      setState(() => _error = '请输入密码');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (_mode == _LoginMode.privateKey) {
        await widget.auth.loginWithKey(username, _keyContent.trim());
      } else {
        await widget.auth.login(username, _password.text);
      }
    } catch (e) {
      if (mounted) setState(() => _error = '登录失败：$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: DesktopBackdrop(
        child: Center(
          child: SingleChildScrollView(
            child: GlassCard(
              width: 400,
              padding: const EdgeInsets.all(28),
              shape: const LiquidRoundedSuperellipse(
                  borderRadius: WsTokens.radiusPanel),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Row(
                    children: [
                      DesktopIconTile(
                        icon: Icons.insights_outlined,
                        colors: [WsTokens.brandTop, WsTokens.primary],
                      ),
                      SizedBox(width: 10),
                      Text('企业台账',
                          style: TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.w700,
                              color: WsTokens.primary)),
                    ],
                  ),
                  const SizedBox(height: 4),
                  const Text('库存 · 财务 · 一体化',
                      style:
                          TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                  const SizedBox(height: 18),
                  Row(
                    children: [
                      _ModeChip(
                        label: '私钥登录',
                        selected: _mode == _LoginMode.privateKey,
                        onTap: () =>
                            setState(() => _mode = _LoginMode.privateKey),
                      ),
                      const SizedBox(width: 8),
                      _ModeChip(
                        label: '密码登录',
                        selected: _mode == _LoginMode.password,
                        onTap: () =>
                            setState(() => _mode = _LoginMode.password),
                      ),
                    ],
                  ),
                  const SizedBox(height: 18),
                  TextFormField(
                    controller: _username,
                    decoration: const InputDecoration(
                      hintText: '用户名',
                      prefixIcon: Icon(Icons.person_outline, size: 18),
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_mode == _LoginMode.privateKey)
                    _buildKeyArea()
                  else
                    TextFormField(
                      controller: _password,
                      obscureText: true,
                      decoration: const InputDecoration(
                        hintText: '密码（仅 Go 试验后端）',
                        prefixIcon: Icon(Icons.lock_outline, size: 18),
                      ),
                    ),
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    _ErrorBar(message: _error!),
                  ],
                  const SizedBox(height: 20),
                  SizedBox(
                    height: 40,
                    child: ElevatedButton(
                      onPressed: _loading ? null : _submit,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: WsTokens.primary,
                        foregroundColor: Colors.white,
                        elevation: 0,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(WsTokens.radius),
                        ),
                      ),
                      child: _loading
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2, color: Colors.white),
                            )
                          : const Text('登 录', style: TextStyle(fontSize: 15)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildKeyArea() {
    final picked = _keyFileName != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            OutlinedButton(
              onPressed: _loading ? null : _pickKeyFile,
              style: OutlinedButton.styleFrom(
                foregroundColor: WsTokens.textLight,
                side: const BorderSide(color: WsTokens.borderLight),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(WsTokens.radius),
                ),
              ),
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.folder_open, size: 15),
                  SizedBox(width: 8),
                  Text('选择私钥文件'),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                _keyFileName ?? '未选择文件',
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  color: picked ? WsTokens.green : WsTokens.mutedLight,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 6),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: () => setState(() => _showPaste = !_showPaste),
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              minimumSize: const Size(0, 32),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text(_showPaste ? '收起粘贴框' : '或直接粘贴私钥内容',
                style: const TextStyle(fontSize: 12)),
          ),
        ),
        if (_showPaste) ...[
          const SizedBox(height: 8),
          TextFormField(
            controller: _pasteKey,
            minLines: 3,
            maxLines: 6,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            decoration: const InputDecoration(
              hintText: '粘贴私钥全文（-----BEGIN OPENSSH PRIVATE KEY----- 开头）',
              isDense: true,
            ),
            onChanged: (v) => setState(() {
              _keyContent = v;
              _keyFileName = null;
            }),
          ),
        ],
      ],
    );
  }
}

class _ModeChip extends StatelessWidget {
  const _ModeChip(
      {required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: BoxDecoration(
            color: selected ? WsTokens.primary : Colors.transparent,
            borderRadius: BorderRadius.circular(WsTokens.radius),
            border: Border.all(
                color: selected ? WsTokens.primary : WsTokens.borderLight),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 13,
              color: selected ? Colors.white : WsTokens.textLight,
            ),
          ),
        ),
      ),
    );
  }
}

/// 复刻 fluent InfoBar.error 的红底提示条。
class _ErrorBar extends StatelessWidget {
  const _ErrorBar({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: WsTokens.redLight,
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: const Color(0xFFF1BBBD)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline, size: 16, color: WsTokens.red),
          const SizedBox(width: 8),
          Expanded(
            child: Text(message,
                style:
                    const TextStyle(fontSize: 12.5, color: Color(0xFF7A0C10))),
          ),
        ],
      ),
    );
  }
}
