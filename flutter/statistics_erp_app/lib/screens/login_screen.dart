import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';
import '../services/api_service.dart';

/// 登录方式：
/// - [privateKey]：生产通道。FastAPI 的 /api/auth/login 只接受 username + private_key，
///   与网页端同一套凭据——选择管理员分发的 Ed25519 私钥文件（id_ed25519 / .pem / .key）。
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
  final _pasteKeyController = TextEditingController();
  _LoginMode _mode = _LoginMode.privateKey;

  /// 私钥文件内容（选文件或粘贴都落到这里，提交时只认它）
  String _keyContent = '';
  String? _keyFileName;
  bool _showPasteKey = false;
  bool _isLoading = false;

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    _pasteKeyController.dispose();
    super.dispose();
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Colors.red.shade600 : null,
    ));
  }

  /// 选择私钥文件：Android/iOS 走系统文件选择器（SAF / UIDocumentPicker），无需存储权限。
  /// withData: true 直接把内容读进来，避免某些平台拿不到可读路径。
  Future<void> _pickKeyFile() async {
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.any,
        withData: true,
      );
      if (result == null || result.files.isEmpty) return; // 用户取消，不算错误

      final file = result.files.first;
      final bytes = file.bytes;
      if (bytes == null) {
        _toast('读取私钥文件失败：拿不到文件内容，请换用「粘贴私钥内容」', error: true);
        return;
      }

      final text = utf8.decode(bytes, allowMalformed: true);
      final problem = _keyFileProblem(text);
      if (problem != null) {
        _toast('$problem（${file.name}）', error: true);
        return;
      }

      setState(() {
        _keyContent = text;
        _keyFileName = file.name;
      });
      _toast('已选择：${file.name}');
    } catch (e) {
      _toast('选择私钥文件失败：$e', error: true);
    }
  }

  /// 选到的文件是不是能用的私钥：null = 没问题，否则返回给人看的说明。
  /// 后端（backend/app/keys.py）只认 OpenSSH/PEM 的 Ed25519。
  String? _keyFileProblem(String text) {
    if (!text.contains('PRIVATE KEY')) {
      return '这个文件里没有私钥标记，请确认选的是私钥文件本身';
    }
    if (text.contains('RSA PRIVATE KEY')) {
      return '后端只支持 Ed25519 私钥，这是 RSA 私钥';
    }
    if (text.contains('EC PRIVATE KEY')) {
      return '后端只支持 Ed25519 私钥，这是 EC 私钥';
    }
    if (text.contains('ENCRYPTED PRIVATE KEY')) {
      return '后端不支持带口令加密的私钥，请用未加密的 id_ed25519';
    }
    return null;
  }

  Future<void> _doLogin() async {
    if (!_formKey.currentState!.validate()) return;

    if (_mode == _LoginMode.privateKey && _keyContent.trim().isEmpty) {
      _toast(_showPasteKey ? '请先粘贴私钥内容' : '请先选择私钥文件', error: true);
      return;
    }

    setState(() => _isLoading = true);

    try {
      final authProvider = context.read<AuthProvider>();
      if (_mode == _LoginMode.privateKey) {
        await authProvider.loginWithKey(
          _usernameController.text.trim(),
          _keyContent.trim(),
        );
      } else {
        await authProvider.login(
          _usernameController.text.trim(),
          _passwordController.text,
        );
      }

      if (mounted) {
        _toast('登录成功');
        context.go('/home');
      }
    } catch (e) {
      _toast('登录失败：$e', error: true);
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  // ---------------- 私钥文件选择区 ----------------

  Widget _buildKeyPicker() {
    final picked = _keyFileName != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            OutlinedButton.icon(
              onPressed: _isLoading ? null : _pickKeyFile,
              icon: const Icon(Icons.folder_open_outlined, size: 18),
              label: const Text('选择私钥文件'),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                _keyFileName ?? '未选择文件',
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  color: picked ? Colors.black87 : Colors.grey[600],
                ),
              ),
            ),
            if (picked)
              Icon(Icons.check_circle, size: 18, color: Colors.green.shade600),
          ],
        ),
        const SizedBox(height: 6),
        Text(
          '管理员分发的 Ed25519 私钥文件：id_ed25519 / .pem / .key',
          style: TextStyle(fontSize: 12, color: Colors.grey[600]),
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: _isLoading
                ? null
                : () => setState(() => _showPasteKey = !_showPasteKey),
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              minimumSize: const Size(0, 32),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text(
              _showPasteKey ? '收起粘贴框' : '或直接粘贴私钥内容',
              style: const TextStyle(fontSize: 12),
            ),
          ),
        ),
        if (_showPasteKey)
          TextField(
            controller: _pasteKeyController,
            minLines: 3,
            maxLines: 6,
            autocorrect: false,
            enableSuggestions: false,
            keyboardType: TextInputType.multiline,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            decoration: const InputDecoration(
              hintText: '粘贴私钥文件全文\n（-----BEGIN OPENSSH PRIVATE KEY----- 开头）',
              isDense: true,
            ),
            onChanged: (v) => setState(() {
              _keyContent = v;
              _keyFileName = null;
            }),
          ),
      ],
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

  // ---------------- 后端地址提示 ----------------

  /// 编译时没注入 API_BASE_URL 时，兜底值 127.0.0.1 在手机上指向手机自己，
  /// 必然「连接服务失败」——这里直接把它挑明，省得来回猜。
  bool get _needsBaseUrlHint {
    if (kIsWeb) return false;
    final isMobile = defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS;
    if (!isMobile) return false;
    final host = Uri.tryParse(ApiService.baseUrl)?.host ?? '';
    return host == '127.0.0.1' || host == 'localhost';
  }

  Widget _buildBaseUrlHint() {
    if (_needsBaseUrlHint) {
      return Container(
        width: double.infinity,
        margin: const EdgeInsets.only(top: 16),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: const Color(0xFFFFF3E0),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0xFFFFCC80)),
        ),
        child: const Text(
          '当前连的是本机回环地址，手机访问不到。请在 dart_defines.local.json 里填服务器地址'
          '（如 http://47.108.13.20），并用 --dart-define-from-file=dart_defines.local.json 重新运行/打包。',
          style: TextStyle(fontSize: 11, color: Color(0xFFE65100)),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Text(
        '后端：${ApiService.baseUrl}',
        style: TextStyle(fontSize: 11, color: Colors.grey[600]),
      ),
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
                        if (_mode == _LoginMode.privateKey) _buildKeyPicker() else _buildPasswordField(),
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
                        _buildBaseUrlHint(),
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
