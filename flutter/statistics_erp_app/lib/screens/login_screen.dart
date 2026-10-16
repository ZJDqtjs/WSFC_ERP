import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';

/// 登录方式：
/// - [privateKey]：生产通道。FastAPI 的 /api/auth/login 只接受 username + private_key，
///   与网页端同一套凭据（管理员分发的 Ed25519 私钥文件全文）。
/// - [password]：Go 试验后端（wsfc-erp-go）独有的口令通道，这里保留只为本机联调；
///   对生产 FastAPI 使用会收到 422「缺少必填参数：私钥」。
enum _LoginMode { privateKey, password }

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _keyController = TextEditingController();
  _LoginMode _mode = _LoginMode.privateKey;
  bool _isLoading = false;

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    _keyController.dispose();
    super.dispose();
  }

  Future<void> _doLogin() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isLoading = true);

    try {
      final authProvider = context.read<AuthProvider>();
      if (_mode == _LoginMode.privateKey) {
        // 私钥粘贴时可能带首尾空行 / 多余空白，这里统一去掉（后端也会 strip）
        await authProvider.loginWithKey(
          _usernameController.text.trim(),
          _keyController.text.trim(),
        );
      } else {
        await authProvider.login(
          _usernameController.text.trim(),
          _passwordController.text,
        );
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('登录成功'), backgroundColor: Colors.green),
        );
        context.go('/home');
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('登录失败：${e.toString()}'), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  /// 私钥输入框：多行、等宽，粘贴整份文件即可
  Widget _buildKeyField() {
    return TextFormField(
      controller: _keyController,
      minLines: 3,
      maxLines: 6,
      autocorrect: false,
      enableSuggestions: false,
      keyboardType: TextInputType.multiline,
      style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
      decoration: const InputDecoration(
        labelText: '私钥',
        alignLabelWithHint: true,
        hintText: '粘贴私钥文件全文\n（-----BEGIN OPENSSH PRIVATE KEY----- 开头）',
        helperText: '与网页端同一套凭据：管理员分发的 id_ed25519 / .pem 文件',
        helperMaxLines: 2,
      ),
      validator: (v) => (v == null || v.trim().isEmpty) ? '请粘贴私钥内容' : null,
    );
  }

  Widget _buildPasswordField() {
    return TextFormField(
      controller: _passwordController,
      obscureText: true,
      decoration: const InputDecoration(
        labelText: '密码',
        prefixIcon: Icon(Icons.lock_outline),
        helperText: '口令通道仅 Go 试验后端支持，生产 FastAPI 请用私钥登录',
        helperMaxLines: 2,
      ),
      validator: (v) => (v == null || v.isEmpty) ? '请输入密码' : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF1989FA), Color(0xFF0D6EFD)],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Card(
                elevation: 8,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(28),
                  child: Form(
                    key: _formKey,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text(
                          '企业台账',
                          style: TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.bold,
                            color: Color(0xFF1989FA),
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '库存 · 财务 · 一体化',
                          style: TextStyle(
                            fontSize: 12,
                            color: Colors.grey[600],
                          ),
                        ),
                        const SizedBox(height: 18),
                        SegmentedButton<_LoginMode>(
                          segments: const [
                            ButtonSegment(
                              value: _LoginMode.privateKey,
                              label: Text('私钥登录'),
                              icon: Icon(Icons.key_outlined),
                            ),
                            ButtonSegment(
                              value: _LoginMode.password,
                              label: Text('密码登录'),
                              icon: Icon(Icons.password_outlined),
                            ),
                          ],
                          selected: {_mode},
                          showSelectedIcon: false,
                          onSelectionChanged: _isLoading
                              ? null
                              : (selection) => setState(() => _mode = selection.first),
                          style: const ButtonStyle(
                            visualDensity: VisualDensity.compact,
                          ),
                        ),
                        const SizedBox(height: 18),
                        TextFormField(
                          controller: _usernameController,
                          decoration: const InputDecoration(
                            labelText: '用户名',
                            prefixIcon: Icon(Icons.person_outline),
                          ),
                          validator: (v) => v == null || v.isEmpty ? '请输入用户名' : null,
                        ),
                        const SizedBox(height: 16),
                        if (_mode == _LoginMode.privateKey) _buildKeyField() else _buildPasswordField(),
                        const SizedBox(height: 20),
                        SizedBox(
                          height: 44,
                          child: ElevatedButton(
                            onPressed: _isLoading ? null : _doLogin,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFF1989FA),
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(20),
                              ),
                            ),
                            child: _isLoading
                                ? const SizedBox(
                                    width: 20,
                                    height: 20,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                                    ),
                                  )
                                : const Text('登 录', style: TextStyle(fontSize: 16)),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
