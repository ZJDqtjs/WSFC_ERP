import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:provider/provider.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../mobile_style.dart';
import '../widgets/aurora.dart';
import '../widgets/motion.dart';

/// 登录方式：
/// - [privateKey]：生产通道。FastAPI 的 /api/auth/login 只接受 username + private_key，
///   与网页端同一套凭据——选择管理员分发的 Ed25519 私钥文件（id_ed25519 / .pem / .key）。
/// - [password]：Go 试验后端（wsfc-erp-go）独有的口令通道，这里保留只为本机联调；
///   对生产 FastAPI 使用会收到 422「缺少必填参数：私钥」。
enum _LoginMode { privateKey, password }

class MobileLoginPage extends StatefulWidget {
  const MobileLoginPage({super.key});

  @override
  State<MobileLoginPage> createState() => _MobileLoginPageState();
}

class _MobileLoginPageState extends State<MobileLoginPage> {
  final _formKey = GlobalKey<FormState>();
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _pasteKeyController = TextEditingController();
  _LoginMode _mode = _LoginMode.privateKey;

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
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? Mc.danger : null,
    ));
  }

  Future<void> _pickKeyFile() async {
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.any,
        withData: true,
      );
      if (result == null || result.files.isEmpty) return;

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

  /// 后端（backend/app/keys.py）只认 OpenSSH/PEM 的 Ed25519。
  String? _keyFileProblem(String text) {
    if (!text.contains('PRIVATE KEY')) {
      return '这个文件里没有私钥标记，请确认选的是私钥文件本身';
    }
    if (text.contains('RSA PRIVATE KEY')) return '后端只支持 Ed25519 私钥，这是 RSA 私钥';
    if (text.contains('EC PRIVATE KEY')) return '后端只支持 Ed25519 私钥，这是 EC 私钥';
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
      final auth = context.read<AuthProvider>();
      if (_mode == _LoginMode.privateKey) {
        await auth.loginWithKey(_usernameController.text.trim(), _keyContent.trim());
      } else {
        await auth.login(_usernameController.text.trim(), _passwordController.text);
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: AuroraBackground(
        intensity: 1.35,
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
              child: Column(
                children: [
                  const StaggerItem(index: 0, child: _Wordmark()),
                  const SizedBox(height: 26),
                  StaggerItem(
                    index: 1,
                    offset: 30,
                    child: GlassCard(
                      padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
                      shape: const LiquidRoundedSuperellipse(borderRadius: 26),
                      child: Form(
                        key: _formKey,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            _modeSwitch(),
                            const SizedBox(height: 18),
                            TextFormField(
                              controller: _usernameController,
                              enabled: !_isLoading,
                              decoration: const InputDecoration(
                                labelText: '用户名',
                                prefixIcon: Icon(Icons.person_outline, size: 20),
                              ),
                              validator: (v) =>
                                  v == null || v.isEmpty ? '请输入用户名' : null,
                            ),
                            const SizedBox(height: 14),
                            if (_mode == _LoginMode.privateKey)
                              _keyPicker()
                            else
                              TextFormField(
                                controller: _passwordController,
                                enabled: !_isLoading,
                                obscureText: true,
                                decoration: const InputDecoration(
                                  labelText: '密码',
                                  prefixIcon: Icon(Icons.lock_outline, size: 20),
                                  helperText: '口令通道仅 Go 试验后端支持，生产 FastAPI 请用私钥登录',
                                  helperMaxLines: 2,
                                ),
                                validator: (v) =>
                                    v == null || v.isEmpty ? '请输入密码' : null,
                              ),
                            const SizedBox(height: 20),
                            PressableScale(
                              onTap: _isLoading ? null : _doLogin,
                              child: Container(
                                height: 48,
                                decoration: BoxDecoration(
                                  gradient: const LinearGradient(
                                    colors: [Mc.brandTop, Mc.brandDeep],
                                  ),
                                  borderRadius: BorderRadius.circular(Mc.radiusTile),
                                  boxShadow: [
                                    BoxShadow(
                                      color: Mc.brand.withValues(alpha: 0.32),
                                      blurRadius: 18,
                                      offset: const Offset(0, 8),
                                    ),
                                  ],
                                ),
                                child: Center(
                                  child: _SubmitLabel(loading: _isLoading),
                                ),
                              ),
                            ),
                            const SizedBox(height: 14),
                            _baseUrlHint(),
                          ],
                        ),
                      ),
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

  Widget _modeSwitch() {
    return GlassSegmentedControl(
      height: 40,
      selectedIndex: _mode == _LoginMode.privateKey ? 0 : 1,
      onSegmentSelected: (i) {
        if (_isLoading) return;
        setState(() => _mode = i == 0 ? _LoginMode.privateKey : _LoginMode.password);
      },
      segments: const [
        GlassSegment(label: '私钥登录', icon: Icon(Icons.key_outlined)),
        GlassSegment(label: '密码登录', icon: Icon(Icons.password_outlined)),
      ],
    );
  }

  Widget _keyPicker() {
    final picked = _keyFileName != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          onTap: _isLoading ? null : _pickKeyFile,
          borderRadius: BorderRadius.circular(Mc.radiusTile),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(Mc.radiusTile),
              border: Border.all(
                color: picked ? Mc.fresh.withValues(alpha: 0.55) : Mc.inkThird.withValues(alpha: 0.4),
              ),
              color: Colors.white.withValues(alpha: 0.5),
            ),
            child: Row(
              children: [
                Icon(
                  picked ? Icons.check_circle : Icons.folder_open_outlined,
                  size: 20,
                  color: picked ? Mc.fresh : Mc.brand,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    _keyFileName ?? '选择私钥文件',
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      color: picked ? Mc.ink : Mc.inkThird,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 6),
        const Text(
          '管理员分发的 Ed25519 私钥：id_ed25519 / .pem / .key',
          style: TextStyle(fontSize: 11.5, color: Mc.inkThird),
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
            enabled: !_isLoading,
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

  /// 编译时没注入 API_BASE_URL 时，兜底值 127.0.0.1 在手机上指向手机自己，
  /// 必然「连接服务失败」——直接挑明，省得来回猜。
  Widget _baseUrlHint() {
    final host = Uri.tryParse(ApiService.baseUrl)?.host ?? '';
    final isMobile = defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS;
    final loopback = !kIsWeb && isMobile && (host == '127.0.0.1' || host == 'localhost');

    if (!loopback) {
      return Center(
        child: Text('后端：${ApiService.baseUrl}',
            style: const TextStyle(fontSize: 11, color: Mc.inkThird)),
      );
    }
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Mc.warn.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(10),
      ),
      child: const Text(
        '当前连的是本机回环地址，手机访问不到。请在 dart_defines.local.json 里填服务器地址'
        '（如 http://<服务器地址>），并用 --dart-define-from-file=dart_defines.local.json 重新打包。',
        style: TextStyle(fontSize: 11, color: Color(0xFFB45309), height: 1.45),
      ),
    );
  }
}

class _SubmitLabel extends StatelessWidget {
  const _SubmitLabel({required this.loading});

  final bool loading;

  @override
  Widget build(BuildContext context) {
    if (!loading) {
      return const Text('登 录',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: Colors.white));
    }
    return const SizedBox(
      width: 20,
      height: 20,
      child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white),
    );
  }
}

class _Wordmark extends StatelessWidget {
  const _Wordmark();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [Mc.brandTop, Mc.brandDeep],
            ),
            borderRadius: BorderRadius.circular(20),
            boxShadow: [
              BoxShadow(
                color: Mc.brandDeep.withValues(alpha: 0.35),
                blurRadius: 24,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: const Icon(Icons.insights_outlined, color: Colors.white, size: 34),
        ),
        const SizedBox(height: 14),
        const Text('企业台账',
            style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: Mc.ink)),
        const SizedBox(height: 4),
        const Text('库存 · 出库 · 财务，一个 App 管完',
            style: TextStyle(fontSize: 12.5, color: Mc.inkSecond)),
      ],
    );
  }
}
