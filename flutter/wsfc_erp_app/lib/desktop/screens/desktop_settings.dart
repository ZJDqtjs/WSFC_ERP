import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData, FilteringTextInputFormatter;

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../nav_model.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';
import 'package:solar_icons/solar_icons.dart';

/// 「设置」页（web page-settings 六合一）：
/// 商品资料备份 / 备份与恢复 / 批量导入 / 聚水潭关联 / 自动出库设置 / 模块显示。
/// 复刻 web/static/app.js 中 loadPdataPage / loadBackupPage / 批量导入弹窗 /
/// loadMappingPage / loadJstAutoPage / renderNavModulesPanel 的行为与文案。
class DesktopSettingsScreen extends StatefulWidget {
  const DesktopSettingsScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopSettingsScreen> createState() => _DesktopSettingsScreenState();
}

class _DesktopSettingsScreenState extends State<DesktopSettingsScreen> {
  static const List<String> _tabs = [
    '商品资料备份',
    '备份与恢复',
    '批量导入',
    '聚水潭关联',
    '自动出库设置',
    '模块显示',
  ];

  int _tab = 0;

  Widget _panel() {
    switch (_tab) {
      case 1:
        return const _BackupPanel();
      case 2:
        return _ImportPanel(onNavigate: widget.onNavigate);
      case 3:
        return _MappingPanel(onNavigate: widget.onNavigate);
      case 4:
        return _JstAutoPanel(onNavigate: widget.onNavigate);
      case 5:
        return _ModulesPanel(auth: widget.auth);
      default:
        return const _PdataPanel();
    }
  }

  @override
  Widget build(BuildContext context) {
    return DesktopPage(
      title: '设置',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: DesktopTabs(
              items: _tabs,
              index: _tab,
              onChanged: (i) => setState(() => _tab = i),
            ),
          ),
          const SizedBox(height: 16),
          Expanded(
            child: DesktopPageTransition(
              routeKey: 'settings-tab-$_tab',
              // routeKey 变化会重建面板：与网页 switchSettingsTab 一致，切页即重新拉取
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    DesktopRise(index: 0, child: _panel()),
                    const SizedBox(height: 8),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ================================================================ 公共小件

/// 商品资料 5 类的 json 文件名（web PDATA_KINDS）
const Map<String, String> _pdataKinds = {
  'units': 'units.json',
  'products_stock': 'products_stock.json',
  'products_order': 'products_order.json',
  'pack_rules': 'pack_rules.json',
  'code_mappings': 'code_mappings.json',
};

/// 通用弹窗外壳（与 desktopDialog 同款观感；主体自管布局与按钮）
Future<T?> _wsDialog<T>(
  BuildContext context, {
  required String title,
  required Widget body,
  double width = 520,
  double maxHeight = 640,
}) {
  final dark = wsIsDark(context);
  return showDialog<T>(
    context: context,
    builder: (dialogContext) => Dialog(
      backgroundColor: dark ? WsTokens.cardDark : WsTokens.cardLight,
      insetPadding: const EdgeInsets.all(28),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(WsTokens.radiusLg)),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: width, maxHeight: maxHeight),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 18, 22, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: dark ? WsTokens.textDark : WsTokens.textLight,
                      ),
                    ),
                  ),
                  DesktopIconButton(
                    icon: SolarIconsOutline.closeCircle,
                    color: WsTokens.mutedLight,
                    tooltip: '关闭',
                    onPressed: () => Navigator.of(dialogContext).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Flexible(child: body),
            ],
          ),
        ),
      ),
    ),
  );
}

/// 「☑ 文案」一行（web .check-inline）
class _CheckLine extends StatelessWidget {
  const _CheckLine({
    required this.label,
    required this.value,
    this.onChanged,
    this.tip,
    this.enabled = true,
  });

  final String label;
  final bool value;
  final ValueChanged<bool>? onChanged;
  final String? tip;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final box = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 28,
          height: 28,
          child: Checkbox(
            value: value,
            onChanged: enabled && onChanged != null ? (v) => onChanged!(v ?? false) : null,
            visualDensity: VisualDensity.compact,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
        ),
        Text(label, style: const TextStyle(fontSize: 12.5)),
      ],
    );
    return tip == null ? box : Tooltip(message: tip!, child: box);
  }
}

class _PickedFile {
  const _PickedFile(this.path, this.name);
  final String path;
  final String name;
}

Future<_PickedFile?> _pickFile(List<String> exts) async {
  final r = await FilePicker.platform.pickFiles(
    type: FileType.custom,
    allowedExtensions: exts,
    dialogTitle: '选择文件',
  );
  if (r == null || r.files.isEmpty) return null;
  final path = r.files.first.path;
  if (path == null) return null;
  return _PickedFile(path, r.files.first.name);
}

/// 数字 → 输入框文本（去掉多余的 .0）
String _numText(dynamic v) {
  final d = wsD(v);
  if (d == d.roundToDouble() && d.abs() < 1e15) return d.round().toString();
  return d.toString();
}

/// 可空的运费/装卸类字段：0 或空显示为空（让用户自己决定要不要填）
String _optNumText(dynamic v) {
  if (v == null) return '';
  final d = wsD(v);
  if (d == 0) return '';
  return _numText(v);
}

String _dstr(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

String _nowStr() {
  final n = DateTime.now();
  return '${_dstr(n)} ${n.hour.toString().padLeft(2, '0')}:${n.minute.toString().padLeft(2, '0')}:${n.second.toString().padLeft(2, '0')}';
}

/// 解析「跳过」map → 「原因 n单、原因 n单」（web skip 文案）
String _skipText(dynamic skip) {
  if (skip is! Map) return '';
  final parts = <String>[];
  skip.forEach((k, v) {
    final n = wsI(v);
    if (n > 0) parts.add('$k $n单');
  });
  return parts.join('、');
}

/// 导入确认后的结果提示块（web submitDraftOrders 结果区）
class _DraftResultBox extends StatefulWidget {
  const _DraftResultBox({super.key});

  @override
  State<_DraftResultBox> createState() => _DraftResultBoxState();
}

class _DraftResultBoxState extends State<_DraftResultBox> {
  Map<String, dynamic>? _r;

  void show(Map<String, dynamic>? r) => setState(() => _r = r);

  @override
  Widget build(BuildContext context) {
    final r = _r;
    if (r == null) return const SizedBox.shrink();
    final failed = (r['failed'] as List?) ?? const [];
    final warnings = ((r['warnings'] as List?) ?? const []).map(wsS).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 10),
        DesktopNotice(
          '✓ 已创建 ${wsI(r['created'])} 个出库单'
          '${wsI(r['failed_count']) > 0 ? '，失败 ${wsI(r['failed_count'])}' : ''}',
          kind: DesktopNoticeKind.success,
        ),
        if (warnings.isNotEmpty)
          DesktopNotice('⚠ ${warnings.join('；')}', kind: DesktopNoticeKind.warn),
        if (failed.isNotEmpty)
          DesktopNotice(
            '失败：${failed.map((f) => wsS((f as Map)['reason'])).join('；')}',
            kind: DesktopNoticeKind.error,
          ),
      ],
    );
  }
}
// ================================================================ A 商品资料备份

class _PdataPanel extends StatefulWidget {
  const _PdataPanel();

  @override
  State<_PdataPanel> createState() => _PdataPanelState();
}

class _PdataPanelState extends State<_PdataPanel> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _status = const {};
  List<Map<String, dynamic>> _results = const [];
  _PickedFile? _uploadFile;
  bool _busy = false;

  List get _rows => (_status['rows'] as List?) ?? const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final s = await ApiService.productDataStatus();
      if (!mounted) return;
      setState(() {
        _status = s;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载商品资料状态失败：${e.message}';
        _loading = false;
      });
    }
  }

  Future<void> _exportAll() async {
    try {
      final r = await ApiService.productDataExport();
      if (!mounted) return;
      final files = (r['files'] as List?) ?? const [];
      wsToast(context, '已导出 ${files.length} 个 json 到服务器目录');
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '导出失败：${e.message}', error: true);
    }
  }

  Future<void> _importAll() async {
    final ok = await wsConfirm(
      context,
      title: '一键导入',
      message: '从 json 目录一键导入全部 5 类？将按名称新增/更新（upsert），不会删除已有数据。',
    );
    if (!ok || !mounted) return;
    try {
      final r = await ApiService.productDataImport();
      if (!mounted) return;
      setState(() => _results = ((r['results'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => e.cast<String, dynamic>())
          .toList());
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '导入失败：${e.message}', error: true);
    }
  }

  Future<void> _importOne(String kind) async {
    final ok = await wsConfirm(
      context,
      title: '导入',
      message: '从 json 目录导入「$kind」？将按名称新增/更新，不会删除已有数据。',
    );
    if (!ok || !mounted) return;
    try {
      final r = await ApiService.productDataImportKind(kind);
      if (!mounted) return;
      setState(() => _results = [r]);
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '导入失败：${e.message}', error: true);
    }
  }

  Future<void> _downloadKind(String kind) async {
    try {
      final data = await ApiService.productDataPayload(kind);
      if (data is Map && data['error'] != null) {
        if (!mounted) return;
        wsToast(context, wsS(data['error']), error: true);
        return;
      }
      final fileName = _pdataKinds[kind] ?? '$kind.json';
      final savePath = await FilePicker.platform.saveFile(dialogTitle: '保存 $fileName', fileName: fileName);
      if (savePath == null || !mounted) return;
      await File(savePath).writeAsString(const JsonEncoder.withIndent('  ').convert(data));
      if (mounted) wsToast(context, '已保存到：$savePath');
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '导出失败：${e.message}', error: true);
    }
  }

  Future<void> _uploadImport() async {
    final picked = await _pickFile(['json', 'txt']);
    if (picked == null || !mounted) return;
    setState(() => _uploadFile = picked);
    dynamic payload;
    try {
      payload = jsonDecode(File(picked.path).readAsStringSync());
    } catch (e) {
      wsToast(context, 'JSON 解析失败：$e', error: true);
      return;
    }
    if (payload is! Map) {
      wsToast(context, '无法识别文件类型：json 需含 kind 字段（可在本页下载对应 json 参考结构）', error: true);
      return;
    }
    final kind = payload['kind']?.toString() ?? '';
    if (kind.isEmpty || !_pdataKinds.containsKey(kind)) {
      wsToast(context, '无法识别文件类型：json 需含 kind 字段（可在本页下载对应 json 参考结构）', error: true);
      return;
    }
    if (!mounted) return;
    final ok = await wsConfirm(
      context,
      title: '上传导入',
      message: '本地上传导入「$kind」？将按名称新增/更新，不会删除已有数据。',
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    try {
      final r = await ApiService.productDataImportOne(payload.cast<String, dynamic>());
      if (!mounted) return;
      setState(() {
        _busy = false;
        _results = [r];
      });
      _load();
      wsToast(context, '导入完成');
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '导入失败：${e.message}', error: true);
    }
  }

  Widget _resultCard() {
    if (_results.isEmpty) return const SizedBox.shrink();
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DesktopNotice('导入完成', kind: DesktopNoticeKind.success),
          DesktopGrid(
            dense: true,
            cols: const [
              DesktopCol('类型', width: 150),
              DesktopCol('新增', width: 90, right: true),
              DesktopCol('更新', width: 90, right: true),
              DesktopCol('备注', width: 320),
            ],
            rows: [
              for (final s in _results)
                DesktopRow(
                  cells: [
                    wsCell(wsS(s['label'])),
                    wsCell('${wsI(s['created'])} 新增'),
                    wsCell('${wsI(s['updated'])} 更新'),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (s['loaded'] == false) const DesktopTag('未加载'),
                        for (final w in ((s['warnings'] as List?) ?? const []))
                          Text(wsS(w), style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight)),
                      ],
                    ),
                  ],
                ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              WsCardHead(
                title: '商品资料备份（解耦维护）',
                icon: SolarIconsOutline.archive,
                trailing: Wrap(
                  spacing: 10,
                  children: [
                    DesktopButton(
                      label: '一键导出到 json 目录',
                      icon: SolarIconsOutline.diskette,
                      kind: DesktopButtonKind.success,
                      onPressed: _busy ? null : _exportAll,
                    ),
                    DesktopButton(
                      label: '从 json 目录一键导入',
                      icon: SolarIconsOutline.refresh,
                      onPressed: _busy ? null : _importAll,
                    ),
                  ],
                ),
              ),
              Text('json 目录：${wsS(_status['dir'], fallback: '—')}',
                  style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              const SizedBox(height: 8),
              const Text(
                '商品资料按「数据表」拆分为 5 个 JSON 独立保存于 backend/json（后端项目中，商品资料备份目录），'
                '商品间相互引用用「名称」表达，可跨库/跨设备迁移。各业务页也提供单独的「导出 JSON」按钮。',
                style: TextStyle(fontSize: 12.5, height: 1.6),
              ),
              const SizedBox(height: 8),
              const DesktopNotice(
                '独立脚本命令：cd backend && uv run python sync_product_data.py export|import|status'
                '（在 backend 目录执行，存在 json 时一键导入）。',
              ),
            ],
          ),
        ),
        WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              WsCardHead(
                title: '5 类商品资料',
                trailing: Text('json 目录与数据库对照；点击「下载」保存单个 json，"导入"从 json 目录读入该类',
                    style: TextStyle(fontSize: 12, color: dark ? WsTokens.mutedDark : WsTokens.mutedLight)),
              ),
              DesktopStateView(
                loading: _loading,
                error: _error,
                onRetry: _load,
                child: DesktopGrid(
                  cols: const [
                    DesktopCol('类型', width: 150),
                    DesktopCol('json 文件', width: 210),
                    DesktopCol('库内数', width: 80, right: true),
                    DesktopCol('json 数', width: 80, right: true),
                    DesktopCol('备份状态', width: 190),
                    DesktopCol('操作', width: 130),
                  ],
                  rows: [
                    for (final r in _rows.whereType<Map>())
                      DesktopRow(
                        cells: [
                          wsCell(wsS(r['label'])),
                          wsCell(wsS(r['file'])),
                          wsCell(wsS(r['count_in_db'])),
                          wsCell(r['exists'] == true ? wsS(r['count_in_file']) : '-'),
                          r['exists'] == true
                              ? DesktopTag('已备份 ${wsS(r['mtime'])}', color: WsTokens.green)
                              : const DesktopTag('未备份'),
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              DesktopLink('下载', onPressed: () => _downloadKind(wsS(r['kind']))),
                              DesktopLink(
                                '导入',
                                onPressed: r['exists'] == true ? () => _importOne(wsS(r['kind'])) : null,
                              ),
                            ],
                          ),
                        ],
                      ),
                  ],
                  emptyText: '暂无数据',
                ),
              ),
            ],
          ),
        ),
        WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              WsCardHead(
                title: '从本地上传 json 导入',
                trailing: Wrap(
                  spacing: 10,
                  children: [
                    DesktopButton(label: '选择 json 文件', icon: SolarIconsOutline.uploadSquare, onPressed: _busy ? null : _uploadImport),
                    DesktopButton(label: '刷新状态', icon: SolarIconsOutline.refresh, onPressed: _load),
                  ],
                ),
              ),
              const Text('可在任意电脑编辑 json 后上传，按名称导入（upsert），便于手动维护与迁移',
                  style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              const SizedBox(height: 6),
              Text(_uploadFile == null ? '未选择文件' : '已选择：${_uploadFile!.name}',
                  style: const TextStyle(fontSize: 12.5)),
            ],
          ),
        ),
        _resultCard(),
      ],
    );
  }
}
// ================================================================ B 备份与恢复

class _BackupPanel extends StatefulWidget {
  const _BackupPanel();

  @override
  State<_BackupPanel> createState() => _BackupPanelState();
}

class _BackupPanelState extends State<_BackupPanel> {
  final TextEditingController _interval = TextEditingController(text: '2');
  final TextEditingController _keep = TextEditingController(text: '30');
  final TextEditingController _remoteUrl = TextEditingController();
  bool _enabled = true;
  bool _remoteEnabled = false;
  bool _jsonEnabled = true;

  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _backups = const [];
  String _statusText = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _interval.dispose();
    _keep.dispose();
    _remoteUrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final d = await ApiService.backups();
      if (!mounted) return;
      final cfg = ((d['config'] as Map?) ?? const {}).cast<String, dynamic>();
      _interval.text = wsS(cfg['interval_hours'], fallback: '2');
      _keep.text = wsS(cfg['keep'], fallback: '30');
      _remoteUrl.text = wsS(cfg['remote_url']);
      setState(() {
        _enabled = cfg['enabled'] == true;
        _remoteEnabled = cfg['remote_enabled'] == true;
        _jsonEnabled = cfg['json_backup_enabled'] != false;
        _backups = ((d['backups'] as List?) ?? const [])
            .whereType<Map>()
            .map((e) => e.cast<String, dynamic>())
            .toList();
        _statusText = _buildStatus(d, cfg);
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载备份失败：${e.message}';
        _loading = false;
      });
    }
  }

  String _buildStatus(Map<String, dynamic> d, Map<String, dynamic> cfg) {
    final s = StringBuffer(cfg['enabled'] == true
        ? '自动备份已开启：每 ${wsS(cfg['interval_hours'], fallback: '2')} 小时一次，保留最近 ${wsS(cfg['keep'], fallback: '30')} 份'
        : '自动备份已关闭');
    if (cfg['remote_enabled'] == true && wsS(cfg['remote_url']).isNotEmpty) {
      s.write('；远程备份已开启 → ${wsS(cfg['remote_url'])}'
          '（远程保留 ${wsI(cfg['remote_keep'], fallback: 100)} 份）');
      final rs = (d['remote_status'] as Map?) ?? const {};
      if (wsS(rs['time']).isNotEmpty) {
        s.write('｜上次推送 ${wsS(rs['time'])}：'
            '${rs['ok'] == true ? '成功' : '失败 ${wsS(rs['message'])}'}');
      }
    }
    if (cfg['json_backup_enabled'] != false) {
      final jbs = (d['json_backups'] as List?) ?? const [];
      final jb = jbs.isNotEmpty ? (jbs.first as Map) : null;
      s.write(jb != null
          ? '｜json 目录：最近 ${wsS(jb['mtime'])}（${wsS(jb['size_human'])}，共 ${jbs.length} 份）'
          : '｜json 目录：暂无备份（内容无变化时不生成）');
    }
    return s.toString();
  }

  Future<void> _saveConfig() async {
    if (_remoteEnabled && _remoteUrl.text.trim().isEmpty) {
      wsToast(context, '请填写目标服务器地址，如 1.2.3.4:8080/cloudback');
      return;
    }
    final body = {
      'enabled': _enabled,
      'interval_hours': wsD(_interval.text) > 0 ? wsD(_interval.text) : 2.0,
      'keep': wsI(_keep.text) > 0 ? wsI(_keep.text) : 30,
      'remote_enabled': _remoteEnabled,
      'remote_url': _remoteUrl.text.trim(),
      'remote_keep': 100,
      'json_backup_enabled': _jsonEnabled,
    };
    try {
      await ApiService.saveBackupConfig(body);
      if (!mounted) return;
      wsToast(context, '自动备份设置已保存');
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '保存失败：${e.message}', error: true);
    }
  }

  Future<void> _backupNow() async {
    setState(() => _busy = true);
    try {
      final r = await ApiService.createBackup();
      if (!mounted) return;
      final jb = wsS(r['json_backup']);
      wsToast(context, jb.isNotEmpty ? '备份成功：${wsS(r['name'])}＋$jb' : '备份成功：${wsS(r['name'])}');
      setState(() => _busy = false);
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '备份失败：${e.message}', error: true);
    }
  }

  Future<void> _restore(String name) async {
    final ok1 = await wsConfirm(
      context,
      title: '恢复备份',
      message: '确认用「$name」恢复？\n当前数据库将被该备份覆盖，且不可撤销。',
      okLabel: '确定恢复',
      danger: true,
    );
    if (!ok1 || !mounted) return;
    final ok2 = await wsConfirm(
      context,
      title: '再次确认',
      message: '再次确认：恢复会覆盖现有全部数据，建议先「立即备份」一份。确定继续？',
      okLabel: '确定继续',
      danger: true,
    );
    if (!ok2 || !mounted) return;
    setState(() => _busy = true);
    try {
      await ApiService.restoreBackup(name);
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '恢复成功，正在刷新数据…');
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '恢复失败：${e.message}', error: true);
    }
  }

  Future<void> _delete(String name) async {
    final ok = await wsConfirm(context, title: '删除备份', message: '确认删除备份「$name」？', danger: true);
    if (!ok || !mounted) return;
    try {
      final r = await ApiService.deleteBackup(name);
      if (!mounted) return;
      setState(() => _backups = ((r['backups'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => e.cast<String, dynamic>())
          .toList());
      wsToast(context, '已删除备份');
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '删除失败：${e.message}', error: true);
    }
  }

  Future<void> _download(String name) async {
    // 注意：后端目前没有 GET /api/backup/{name} 下载端点（只有列表/创建/恢复/删除），
    // 这里按裸路径尝试；失败时 toast 后端返回的错误提示。
    final savePath = await FilePicker.platform.saveFile(dialogTitle: '保存备份文件', fileName: name);
    if (savePath == null) return;
    try {
      await ApiService.download('/api/backup/${Uri.encodeComponent(name)}', savePath);
      if (mounted) wsToast(context, '备份已保存到：$savePath');
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '下载失败：${e.message}', error: true);
    }
  }

  /// 远程收发脚本：拉取 → 另存为 .sh + 复制进剪贴板（web downloadRemoteScript）
  Future<void> _script(String which) async {
    final isStop = which == 'stop';
    if (!isStop && _remoteUrl.text.trim().isEmpty) {
      wsToast(context, '请先填写目标服务器地址');
      return;
    }
    final filename = isStop ? 'stop_erp_backup_receiver.sh' : 'deploy_erp_backup_receiver.sh';
    try {
      final text = await ApiService.remoteScript(which);
      final savePath = await FilePicker.platform.saveFile(dialogTitle: '保存 $filename', fileName: filename);
      if (savePath == null || !mounted) return;
      await File(savePath).writeAsString(text);
      await Clipboard.setData(ClipboardData(text: text));
      if (mounted) wsToast(context, '已下载 $filename，上传到备份服务器执行即可');
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '下载失败：${e.message}', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return DesktopStateView(
      loading: _loading,
      error: _error,
      onRetry: _load,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                WsCardHead(
                  title: '自动备份设置',
                  icon: SolarIconsOutline.shieldCheck,
                  trailing: Wrap(
                    spacing: 10,
                    children: [
                      DesktopButton(label: '保存设置', icon: SolarIconsOutline.diskette, onPressed: _busy ? null : _saveConfig),
                      DesktopButton(
                        label: '立即备份',
                        icon: SolarIconsOutline.diskette,
                        kind: DesktopButtonKind.success,
                        onPressed: _busy ? null : _backupNow,
                      ),
                    ],
                  ),
                ),
                const Text('默认开启，每 2 小时备份一次到 data/backups，超出保留份数自动清理旧备份',
                    style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 16,
                  runSpacing: 10,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    _CheckLine(label: '开启自动备份', value: _enabled, onChanged: (v) => setState(() => _enabled = v)),
                    DesktopLabeled(
                      label: '每',
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        DesktopTextField(
                          controller: _interval,
                          width: 72,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          inputFormatters: DesktopTextField.decimalOnly,
                        ),
                        const SizedBox(width: 6),
                        const Text('小时备份', style: TextStyle(fontSize: 12.5)),
                      ]),
                    ),
                    DesktopLabeled(
                      label: '保留',
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        DesktopTextField(
                          controller: _keep,
                          width: 72,
                          keyboardType: TextInputType.number,
                          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                        ),
                        const SizedBox(width: 6),
                        const Text('份', style: TextStyle(fontSize: 12.5)),
                      ]),
                    ),
                    _CheckLine(
                        label: '开启远程备份',
                        value: _remoteEnabled,
                        onChanged: (v) => setState(() => _remoteEnabled = v)),
                    _CheckLine(
                      label: '备份 json 目录',
                      value: _jsonEnabled,
                      onChanged: (v) => setState(() => _jsonEnabled = v),
                      tip: '把 backend/json 目录（含 jst_auto/店铺扣点/鲜货清单等不在数据库里的配置）打包，'
                          '随每次备份一并保存到 data/backups 并推送远程',
                    ),
                  ],
                ),
                if (_remoteEnabled) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(WsTokens.radius),
                      border: Border.all(color: dark ? WsTokens.borderDark : const Color(0xFFC9CED6)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: 12,
                          runSpacing: 10,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            DesktopLabeled(
                              label: '目标服务器',
                              child: DesktopTextField(
                                controller: _remoteUrl,
                                width: 280,
                                hintText: '如 1.2.3.4:8080/cloudback',
                              ),
                            ),
                            DesktopButton(label: '下载部署脚本', icon: SolarIconsOutline.diskette, onPressed: () => _script('deploy')),
                            DesktopButton(label: '下载停止脚本', onPressed: () => _script('stop')),
                          ],
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          '填写接收端地址：ip:端口/路径（如 1.2.3.4:8080/cloudback，对应接收端监听端口与路径前缀）。'
                          '保存设置后点「下载部署脚本」，上传到备份服务器执行即可一键部署接收端；'
                          '远程服务器最多保留 100 份，超出的旧备份自动清理。',
                          style: TextStyle(fontSize: 12, height: 1.6, color: WsTokens.mutedLight),
                        ),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                if (_statusText.isNotEmpty)
                  Text(_statusText,
                      style: const TextStyle(fontSize: 12.5, height: 1.6, color: WsTokens.mutedLight)),
              ],
            ),
          ),
          WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                WsCardHead(
                  title: '备份列表',
                  icon: SolarIconsOutline.folderOpen,
                  trailing: Text('恢复会用所选备份覆盖当前数据库，请谨慎操作',
                      style: TextStyle(fontSize: 12, color: dark ? WsTokens.mutedDark : WsTokens.mutedLight)),
                ),
                DesktopGrid(
                  cols: const [
                    DesktopCol('备份文件', width: 300),
                    DesktopCol('大小', width: 90, right: true),
                    DesktopCol('创建时间', width: 160),
                    DesktopCol('操作', width: 170),
                  ],
                  rows: [
                    for (final b in _backups)
                      DesktopRow(
                        cells: [
                          wsCell(wsS(b['name'])),
                          wsCell(wsS(b['size_human'])),
                          wsCell(wsS(b['mtime'])),
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              DesktopLink('恢复', color: WsTokens.amber, onPressed: _busy ? null : () => _restore(wsS(b['name']))),
                              DesktopLink('下载', onPressed: () => _download(wsS(b['name']))),
                              DesktopLink('删除', color: WsTokens.red, onPressed: () => _delete(wsS(b['name']))),
                            ],
                          ),
                        ],
                      ),
                  ],
                  emptyText: '暂无备份，点击右上角「立即备份」',
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
// ================================================================ C 批量导入

class _ImportPanel extends StatefulWidget {
  const _ImportPanel({required this.onNavigate});
  final void Function(String route) onNavigate;

  @override
  State<_ImportPanel> createState() => _ImportPanelState();
}

class _ImportPanelState extends State<_ImportPanel> {
  _PickedFile? _prodFile;
  _PickedFile? _inFile;
  _PickedFile? _outFile;
  _PickedFile? _jstFile;
  bool _busy = false;
  final GlobalKey<_DraftResultBoxState> _prodResult = GlobalKey<_DraftResultBoxState>();
  final GlobalKey<_DraftResultBoxState> _outResult = GlobalKey<_DraftResultBoxState>();
  final GlobalKey<_DraftResultBoxState> _jstResult = GlobalKey<_DraftResultBoxState>();
  Map<String, dynamic>? _inResult;

  Future<void> _downloadTemplate(String kind, String fileName) async {
    final savePath = await FilePicker.platform.saveFile(dialogTitle: '保存 $fileName', fileName: fileName);
    if (savePath == null) return;
    try {
      await ApiService.download(ApiService.templatePath(kind), savePath);
      if (mounted) wsToast(context, '模板已保存到：$savePath');
    } on ApiException catch (e) {
      if (mounted) wsToast(context, '下载模板失败：${e.message}', error: true);
    }
  }

  Future<void> _pick(String slot) async {
    final f = await _pickFile(['xlsx']);
    if (f == null || !mounted) return;
    setState(() {
      switch (slot) {
        case 'prod':
          _prodFile = f;
        case 'in':
          _inFile = f;
        case 'out':
          _outFile = f;
        default:
          _jstFile = f;
      }
    });
  }

  Future<void> _importProducts() async {
    final f = _prodFile;
    if (f == null) {
      wsToast(context, '请先选择 Excel 文件');
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await ApiService.importProducts(f.path);
      if (!mounted) return;
      setState(() => _busy = false);
      _prodResult.currentState?.show(r);
      final created = wsI(r['created']);
      final skipped = wsI(r['skipped']);
      final failedCount = wsI(r['failed_count']);
      wsToast(context, '✓ 导入完成：成功 $created 条'
          '${skipped > 0 ? '，跳过已存在 $skipped 条' : ''}'
          '${failedCount > 0 ? '，失败 $failedCount 条' : ''}');
      final warnings = ((r['warnings'] as List?) ?? const []).map(wsS).toList();
      if (warnings.isNotEmpty) {
        wsToast(context, '⚠ ${warnings.join('；')}', error: true);
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '导入失败：${e.message}', error: true);
    }
  }

  Future<void> _previewInbound() async {
    final f = _inFile;
    if (f == null) {
      wsToast(context, '请先选择 Excel 文件');
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await ApiService.previewImportInbounds(f.path);
      if (!mounted) return;
      setState(() => _busy = false);
      final res = await _wsDialog<Map<String, dynamic>>(
        context,
        title: '批量入库 — 确认入库',
        width: 1020,
        maxHeight: 720,
        body: _InboundReviewBody(preview: r),
      );
      if (res != null && mounted) setState(() => _inResult = res);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '解析失败：${e.message}', error: true);
    }
  }

  Future<void> _previewOutbound() async {
    final f = _outFile;
    if (f == null) {
      wsToast(context, '请先选择 Excel 文件');
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await ApiService.previewImportOutbounds(f.path);
      if (!mounted) return;
      setState(() => _busy = false);
      final res = await _wsDialog<Map<String, dynamic>>(
        context,
        title: '批量出库 — 确认出库',
        width: 1080,
        maxHeight: 720,
        body: _OutboundReviewBody(preview: r, fileName: f.name),
      );
      if (res != null) _outResult.currentState?.show(res);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '解析失败：${e.message}', error: true);
    }
  }

  Future<void> _previewJushuitan() async {
    final f = _jstFile;
    if (f == null) {
      wsToast(context, '请先选择 Excel 文件');
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await ApiService.previewImportJushuitan(f.path);
      if (!mounted) return;
      setState(() => _busy = false);
      final res = await _wsDialog<Map<String, dynamic>>(
        context,
        title: '导入聚水潭出库单 — 商品汇总预览',
        width: 1180,
        maxHeight: 780,
        body: _JstReviewBody(
            preview: r, fileName: f.name, filePath: f.path, onNavigate: widget.onNavigate),
      );
      if (res != null) _jstResult.currentState?.show(res);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '解析失败：${e.message}', error: true);
    }
  }

  Widget _fileLine(_PickedFile? f) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text('文件：${f == null ? '未选择文件' : f.name}',
            style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
      );

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const WsCardHead(title: '导入模板下载', icon: SolarIconsOutline.documentText),
              Wrap(
                spacing: 10,
                children: [
                  DesktopButton(label: '商品导入模板', icon: SolarIconsOutline.download, onPressed: () => _downloadTemplate('products', '商品导入模板.xlsx')),
                  DesktopButton(label: '入库导入模板', icon: SolarIconsOutline.download, onPressed: () => _downloadTemplate('inbounds', '入库批量导入模板.xlsx')),
                  DesktopButton(label: '出库导入模板', icon: SolarIconsOutline.download, onPressed: () => _downloadTemplate('outbounds', '出库批量导入模板.xlsx')),
                ],
              ),
              const SizedBox(height: 10),
              const DesktopNotice('商品模板兼容「柠檬云商品导入模板.xlsx」，整表上传自动识别（编码/类别/名称/规格/单位）。'),
            ],
          ),
        ),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: WsCard(
                marginBottom: 12,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const WsCardHead(title: '商品批量导入', icon: SolarIconsOutline.uploadSquare),
                    _fileLine(_prodFile),
                    Wrap(
                      spacing: 10,
                      children: [
                        DesktopButton(label: '选择 Excel 文件', onPressed: _busy ? null : () => _pick('prod')),
                        DesktopButton(label: '导入商品', kind: DesktopButtonKind.primary, onPressed: _busy ? null : _importProducts),
                      ],
                    ),
                    _DraftResultBox(key: _prodResult),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: WsCard(
                marginBottom: 12,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const WsCardHead(title: '入库批量导入', icon: SolarIconsOutline.uploadSquare),
                    const Text(
                      '按模板填写后上传，先解析预览（可勾选、改数量/单价/运费/装卸），确认后才真正入库并更新库存。'
                      '若商品类别配置了扣点，单价将按 原价×(1-扣点%) 自动折算。',
                      style: TextStyle(fontSize: 12, height: 1.6, color: WsTokens.mutedLight),
                    ),
                    const SizedBox(height: 6),
                    _fileLine(_inFile),
                    Wrap(
                      spacing: 10,
                      children: [
                        DesktopButton(label: '选择 Excel 文件', onPressed: _busy ? null : () => _pick('in')),
                        DesktopButton(label: '导入入库（预览确认）', kind: DesktopButtonKind.primary, onPressed: _busy ? null : _previewInbound),
                      ],
                    ),
                    if (_inResult != null) ...[
                      const SizedBox(height: 10),
                      DesktopNotice(
                        '✓ 已入库 ${wsI(_inResult!['created'])} 条'
                        '${wsI(_inResult!['failed_count']) > 0 ? '，失败 ${wsI(_inResult!['failed_count'])}' : ''}',
                        kind: DesktopNoticeKind.success,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
        WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              WsCardHead(
                title: '出库批量导入',
                icon: SolarIconsOutline.uploadSquare,
                trailing: Text('同「单号」自动合并为一单，自动结转关联材料与费用',
                    style: TextStyle(fontSize: 12, color: dark ? WsTokens.mutedDark : WsTokens.mutedLight)),
              ),
              _fileLine(_outFile),
              Wrap(
                spacing: 10,
                children: [
                  DesktopButton(label: '选择 Excel 文件', onPressed: _busy ? null : () => _pick('out')),
                  DesktopButton(label: '导入出库（预览确认）', kind: DesktopButtonKind.primary, onPressed: _busy ? null : _previewOutbound),
                ],
              ),
              _DraftResultBox(key: _outResult),
            ],
          ),
        ),
        WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const WsCardHead(title: '导入聚水潭出库单（自动结算）', icon: SolarIconsOutline.scooter),
              const Text(
                '上传聚水潭导出的「销售出库单_*.xlsx」，自动识别商品并按件数×每件规格结算。'
                '先解析预览，确认后才出库。「仓储方」为芳谊放单仓的订单，'
                '确认框里会逐单让你填刷单成本，并核算结算价与最终利润。',
                style: TextStyle(fontSize: 12, height: 1.6, color: WsTokens.mutedLight),
              ),
              const SizedBox(height: 6),
              _fileLine(_jstFile),
              Wrap(
                spacing: 10,
                children: [
                  DesktopButton(label: '选择 Excel 文件', onPressed: _busy ? null : () => _pick('jst')),
                  DesktopButton(
                    label: '导入出库单（预览确认）',
                    kind: DesktopButtonKind.success,
                    onPressed: _busy ? null : _previewJushuitan,
                  ),
                ],
              ),
              _DraftResultBox(key: _jstResult),
            ],
          ),
        ),
      ],
    );
  }
}
// ------------------------------------------------ 批量入库预览（web renderInboundReview）

class _InboundRowDraft {
  _InboundRowDraft(this.item)
      : checked = true,
        qty = TextEditingController(text: _numText(item['quantity'])),
        price = TextEditingController(text: _numText(item['unit_price'])),
        freight = TextEditingController(text: _optNumText(item['freight'])),
        handling = TextEditingController(text: _optNumText(item['handling']));

  final Map<String, dynamic> item;
  bool checked;
  final TextEditingController qty;
  final TextEditingController price;
  final TextEditingController freight;
  final TextEditingController handling;

  double get qtyV => double.tryParse(qty.text) ?? 0;
  double get priceV => double.tryParse(price.text) ?? 0;

  void dispose() {
    qty.dispose();
    price.dispose();
    freight.dispose();
    handling.dispose();
  }
}

class _InboundReviewBody extends StatefulWidget {
  const _InboundReviewBody({required this.preview});
  final Map<String, dynamic> preview;

  @override
  State<_InboundReviewBody> createState() => _InboundReviewBodyState();
}

class _InboundReviewBodyState extends State<_InboundReviewBody> {
  final List<_InboundRowDraft> _rows = [];
  bool _busy = false;
  String _error = '';

  @override
  void initState() {
    super.initState();
    for (final it in (widget.preview['items'] as List?) ?? const []) {
      _rows.add(_InboundRowDraft((it as Map).cast<String, dynamic>()));
    }
  }

  @override
  void dispose() {
    for (final r in _rows) {
      r.dispose();
    }
    super.dispose();
  }

  int get _checkedCount => _rows.where((r) => r.checked).length;

  Future<void> _confirm() async {
    final items = <Map<String, dynamic>>[];
    for (final r in _rows) {
      if (!r.checked) continue;
      final qty = double.tryParse(r.qty.text) ?? 0;
      if (qty <= 0) continue;
      items.add({
        ...r.item,
        'quantity': qty,
        'unit_price': double.tryParse(r.price.text) ?? 0,
        'freight': (double.tryParse(r.freight.text) ?? 0).clamp(0, double.infinity),
        'handling': (double.tryParse(r.handling.text) ?? 0).clamp(0, double.infinity),
      });
    }
    if (items.isEmpty) {
      wsToast(context, '没有可入库的数据');
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await ApiService.confirmImportInbounds(items);
      if (!mounted) return;
      Navigator.of(context).pop(r);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = '确认入库失败：${e.message}';
      });
    }
  }

  Widget _head(String text, double before) => Padding(
        padding: EdgeInsets.only(left: before),
        child: Text(text, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
      );

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    final failed = (widget.preview['failed'] as List?) ?? const [];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopNotice(
          '解析出 ${_rows.length} 行。可勾选、修改数量/单价/运费/装卸后点击「确认入库」；'
          '运费与装卸费会计入批次成本并同步「其他开支」。',
          kind: _rows.isEmpty ? DesktopNoticeKind.warn : DesktopNoticeKind.success,
        ),
        if (failed.isNotEmpty)
          DesktopNotice(
            '解析失败 ${failed.length} 条：${failed.take(5).map((f) => wsS((f as Map)['reason'])).join('；')}',
            kind: DesktopNoticeKind.error,
          ),
        if (_error.isNotEmpty) DesktopNotice(_error, kind: DesktopNoticeKind.error),
        if (_rows.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 6, top: 2),
            child: Row(children: [
              SizedBox(width: 34, child: _head('选', 0)),
              _head('商品', 6),
              _head('单位', 130),
              _head('数量', 66),
              _head('单价', 70),
              _head('金额', 76),
              _head('运费', 70),
              _head('装卸', 66),
              _head('供应商 · 日期', 66),
            ]),
          ),
        Expanded(
          child: _rows.isEmpty
              ? const Center(child: Text('未解析出可入库的数据。', style: TextStyle(color: WsTokens.mutedLight)))
              : ListView.builder(
                  shrinkWrap: true,
                  itemCount: _rows.length,
                  itemBuilder: (_, i) {
                    final r = _rows[i];
                    return Opacity(
                      opacity: r.checked ? 1 : 0.45,
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 5),
                        decoration: BoxDecoration(
                          border: Border(bottom: BorderSide(color: dark ? WsTokens.borderDark : WsTokens.borderLight)),
                        ),
                        child: Row(
                          children: [
                            SizedBox(
                              width: 28,
                              height: 28,
                              child: Checkbox(
                                value: r.checked,
                                visualDensity: VisualDensity.compact,
                                onChanged: (v) => setState(() => r.checked = v ?? false),
                              ),
                            ),
                            SizedBox(
                              width: 160,
                              child: Text(wsS(r.item['product_name']),
                                  overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                            ),
                            SizedBox(
                              width: 52,
                              child: Text(wsS(r.item['unit']), style: const TextStyle(fontSize: 12.5)),
                            ),
                            DesktopTextField(
                                controller: r.qty, width: 80, keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                inputFormatters: DesktopTextField.decimalOnly, onChanged: (_) => setState(() {})),
                            const SizedBox(width: 6),
                            DesktopTextField(
                                controller: r.price, width: 84, keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                inputFormatters: DesktopTextField.decimalOnly, onChanged: (_) => setState(() {})),
                            const SizedBox(width: 8),
                            SizedBox(
                              width: 88,
                              child: Text(wsMoney(r.qtyV * r.priceV), style: const TextStyle(fontSize: 12.5)),
                            ),
                            const SizedBox(width: 6),
                            DesktopTextField(controller: r.freight, width: 70, hintText: '0',
                                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                inputFormatters: DesktopTextField.decimalOnly),
                            const SizedBox(width: 6),
                            DesktopTextField(controller: r.handling, width: 70, hintText: '0',
                                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                inputFormatters: DesktopTextField.decimalOnly),
                            Expanded(
                              child: Padding(
                                padding: const EdgeInsets.only(left: 8),
                                child: Text(
                                  '${wsS(r.item['supplier'], fallback: '—')} · ${wsS(r.item['date'])}',
                                  style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            DesktopButton(label: '取消', onPressed: _busy ? null : () => Navigator.of(context).pop()),
            const SizedBox(width: 10),
            DesktopButton(
              label: '✓ 确认入库（$_checkedCount 行）',
              kind: DesktopButtonKind.success,
              onPressed: (_busy || _rows.isEmpty) ? null : _confirm,
            ),
          ],
        ),
      ],
    );
  }
}

// ------------------------------------------------ 出库单据行模型（批量出库 / 聚水潭共用）

class _OrderLineDraft {
  _OrderLineDraft(this.line, {required this.editable})
      : qty = TextEditingController(text: _numText(line['quantity'])),
        price = TextEditingController(text: _numText(line['price']));

  final Map<String, dynamic> line;
  final bool editable;
  final TextEditingController qty;
  final TextEditingController price;

  double get qtyV => double.tryParse(qty.text) ?? wsD(line['quantity']);
  double get priceV => double.tryParse(price.text) ?? wsD(line['price']);
  double get amount => qtyV * priceV;

  void dispose() {
    qty.dispose();
    price.dispose();
  }
}

class _OrderDraft {
  _OrderDraft(this.order, {required bool lineEditable})
      : checked = true,
        lines = [
          for (final l in (order['lines'] as List?) ?? const [])
            _OrderLineDraft((l as Map).cast<String, dynamic>(), editable: lineEditable),
        ];

  final Map<String, dynamic> order;
  bool checked;
  final List<_OrderLineDraft> lines;

  /// 结算收入：按后端解析金额求和（聚水潭放单仓核算用）
  double get income => lines.fold<double>(0, (s, l) => s + wsD(l.line['amount']));

  Map<String, dynamic> payload({double brushCost = 0, double brushFee = 0}) {
    final out = <Map<String, dynamic>>[];
    for (final l in lines) {
      final pid = l.line['product_id'];
      final unit = wsS(l.line['unit']);
      final qty = l.qtyV;
      if (pid == null || unit.isEmpty || qty <= 0) continue;
      out.add({
        'product_id': pid,
        'unit': unit,
        'quantity': qty,
        'price': l.priceV,
        'gross_sales': wsD(l.line['gross_sales']),
      });
    }
    return {
      'doc_no': order['doc_no'],
      'date': order['date'],
      'customer': wsS(order['customer']),
      'operator': wsS(order['operator']),
      'remark': wsS(order['remark']),
      'pack_fee': wsD(order['pack_fee']),
      'warehouse': wsS(order['warehouse']),
      'brush_cost': brushCost,
      'brush_fee': brushFee,
      'pack_rule_id': order['pack_rule_id'],
      'pack_rule_name': wsS(order['pack_rule_name']),
      'pack_lines': (order['pack_lines'] as List?) ?? const [],
      'lines': out,
    };
  }

  void dispose() {
    for (final l in lines) {
      l.dispose();
    }
  }
}

// ------------------------------------------------ 批量出库预览（web renderDraftReview）

class _OutboundReviewBody extends StatefulWidget {
  const _OutboundReviewBody({required this.preview, required this.fileName});
  final Map<String, dynamic> preview;
  final String fileName;

  @override
  State<_OutboundReviewBody> createState() => _OutboundReviewBodyState();
}

class _OutboundReviewBodyState extends State<_OutboundReviewBody> {
  final List<_OrderDraft> _orders = [];
  bool _busy = false;
  String _error = '';

  @override
  void initState() {
    super.initState();
    for (final o in (widget.preview['orders'] as List?) ?? const []) {
      _orders.add(_OrderDraft((o as Map).cast<String, dynamic>(), lineEditable: true));
    }
  }

  @override
  void dispose() {
    for (final o in _orders) {
      o.dispose();
    }
    super.dispose();
  }

  int get _checkedCount => _orders.where((o) => o.checked).length;

  Future<void> _confirm() async {
    final orders = <Map<String, dynamic>>[];
    for (final o in _orders) {
      if (!o.checked) continue;
      final p = o.payload();
      if ((p['lines'] as List).isEmpty) continue;
      orders.add(p);
    }
    if (orders.isEmpty) {
      wsToast(context, '没有勾选任何单据');
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await ApiService.confirmImportOutbounds(orders, source: widget.fileName);
      if (!mounted) return;
      Navigator.of(context).pop(r);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = '确认出库失败：${e.message}';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    final unmapped = (widget.preview['unmapped_codes'] as List?) ?? const [];
    final skip = _skipText(widget.preview['skip']);
    final failed = (widget.preview['failed'] as List?) ?? const [];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DesktopNotice(
          '解析出 ${_orders.length} 单。可勾选、修改数量/单价后点击「确认出库」。',
          kind: _orders.isEmpty ? DesktopNoticeKind.warn : DesktopNoticeKind.success,
        ),
        if (unmapped.isNotEmpty)
          DesktopNotice(
            '⚠ 未关联商品：${unmapped.map(wsS).join('、')}（请到「编码关联」关联后重新解析）',
            kind: DesktopNoticeKind.warn,
          ),
        if (skip.isNotEmpty) DesktopNotice('⚠ 跳过：$skip', kind: DesktopNoticeKind.warn),
        if (failed.isNotEmpty)
          DesktopNotice(
            '解析失败 ${failed.length} 条：${failed.take(5).map((f) => wsS((f as Map)['reason'])).join('；')}',
            kind: DesktopNoticeKind.error,
          ),
        if (_error.isNotEmpty) DesktopNotice(_error, kind: DesktopNoticeKind.error),
        Expanded(
          child: _orders.isEmpty
              ? const Center(child: Text('未解析出可出库的单据。', style: TextStyle(color: WsTokens.mutedLight)))
              : ListView(
                  shrinkWrap: true,
                  children: [
                    for (final o in _orders)
                      Container(
                        margin: const EdgeInsets.only(bottom: 10),
                        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(WsTokens.radius),
                          border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
                        ),
                        child: Opacity(
                          opacity: o.checked ? 1 : 0.45,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  _CheckLine(
                                    label: '出库',
                                    value: o.checked,
                                    onChanged: (v) => setState(() => o.checked = v),
                                  ),
                                  const SizedBox(width: 8),
                                  Text(wsS(o.order['doc_no'], fallback: '（无单号）'),
                                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Text(
                                      '${wsS(o.order['customer'], fallback: '—')} · ${wsS(o.order['date'])}'
                                      '${wsD(o.order['pack_fee']) > 0 ? ' · 打包费 ${wsMoney(wsD(o.order['pack_fee']))}' : ''}',
                                      style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 4),
                              for (final l in o.lines)
                                Padding(
                                  padding: const EdgeInsets.symmetric(vertical: 3),
                                  child: Row(
                                    children: [
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Text(wsS(l.line['product_name']),
                                                style: const TextStyle(fontSize: 12.5),
                                                overflow: TextOverflow.ellipsis),
                                            if (wsS(l.line['deduct']).isNotEmpty)
                                              Text(wsS(l.line['deduct']),
                                                  style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight)),
                                          ],
                                        ),
                                      ),
                                      SizedBox(width: 50, child: Text(wsS(l.line['unit']), style: const TextStyle(fontSize: 12.5))),
                                      DesktopTextField(controller: l.qty, width: 80,
                                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                          inputFormatters: DesktopTextField.decimalOnly, onChanged: (_) => setState(() {})),
                                      const SizedBox(width: 6),
                                      DesktopTextField(controller: l.price, width: 88,
                                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                          inputFormatters: DesktopTextField.decimalOnly, onChanged: (_) => setState(() {})),
                                      const SizedBox(width: 8),
                                      SizedBox(width: 96, child: Text(wsMoney(l.amount), style: const TextStyle(fontSize: 12.5))),
                                    ],
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            DesktopButton(label: '重新选择文件', onPressed: _busy ? null : () => Navigator.of(context).pop()),
            const SizedBox(width: 10),
            DesktopButton(
              label: '✓ 确认出库（$_checkedCount 单）',
              kind: DesktopButtonKind.success,
              onPressed: (_busy || _orders.isEmpty) ? null : _confirm,
            ),
          ],
        ),
      ],
    );
  }
}
// ------------------------------------------------ 聚水潭汇总预览（web renderAggregateReview）

class _JstAggRow {
  _JstAggRow(this.name, this.unit);

  final String name;
  final String unit;
  String deduct = '';
  final Set<String> docs = {};
  double qty = 0;
  double amount = 0;

  double get price => qty > 0 ? amount / qty : 0;
  double get perOrder => docs.isNotEmpty ? amount / docs.length : 0;
}

/// 与 web aggregateDraftLines 一致：按「商品名+单位」汇总，订单数按单号去重。
List<_JstAggRow> _aggregateDraftLines(List<Map<String, dynamic>> orders) {
  final map = <String, _JstAggRow>{};
  for (final o in orders) {
    final doc = wsS(o['doc_no']);
    for (final l in (o['lines'] as List?) ?? const []) {
      final line = (l as Map).cast<String, dynamic>();
      final name = wsS(line['product_name']);
      final unit = wsS(line['unit']);
      final key = '$name\u{0}$unit';
      final g = map.putIfAbsent(key, () => _JstAggRow(name, unit));
      g.docs.add(doc);
      g.qty += wsD(line['quantity']);
      g.amount += wsD(line['amount']);
      if (g.deduct.isEmpty && line['deduct'] != null) g.deduct = wsS(line['deduct']);
    }
  }
  final rows = map.values.toList()..sort((a, b) => b.amount.compareTo(a.amount));
  return rows;
}

class _JstReviewBody extends StatefulWidget {
  const _JstReviewBody({
    required this.preview,
    required this.fileName,
    required this.filePath,
    required this.onNavigate,
  });

  final Map<String, dynamic> preview;
  final String fileName;
  final String filePath;
  final void Function(String route) onNavigate;

  @override
  State<_JstReviewBody> createState() => _JstReviewBodyState();
}

class _JstReviewBodyState extends State<_JstReviewBody> {
  late Map<String, dynamic> _preview;
  List<_OrderDraft> _orders = [];
  List<String> _brushWh = [];
  /// 与 _orders 对齐：放单仓单据的「刷单成本 / 快递+包装固定费」输入框，其余为 null
  final List<TextEditingController?> _brushCost = [];
  final List<TextEditingController?> _brushFee = [];
  final TextEditingController _batchCost = TextEditingController();
  final TextEditingController _batchTotal = TextEditingController();
  String _splitMode = 'revenue';
  bool _busy = false;
  bool _submitting = false;
  String? _submitError;

  double get _defaultFee => wsD(_preview['brush_default_fee']);

  bool _isBrush(int i) {
    final wh = wsS(_orders[i].order['warehouse']);
    return wh.isNotEmpty && _brushWh.contains(wh);
  }

  List<int> get _brushIdx =>
      [for (var i = 0; i < _orders.length; i++) if (_isBrush(i)) i];

  double _orderIncome(int i) => _orders[i].income;

  double _costOf(int i) {
    final c = _brushCost[i];
    if (c == null) return 0;
    final v = double.tryParse(c.text);
    return (v != null && v > 0) ? v : 0;
  }

  double _feeOf(int i) {
    final c = _brushFee[i];
    if (c == null) return 0;
    return double.tryParse(c.text) ?? 0;
  }

  @override
  void initState() {
    super.initState();
    _preview = widget.preview;
    _buildDrafts();
  }

  void _buildDrafts() {
    for (final c in _brushCost) {
      c?.dispose();
    }
    for (final c in _brushFee) {
      c?.dispose();
    }
    _brushCost.clear();
    _brushFee.clear();
    for (final d in _orders) {
      d.dispose();
    }
    _orders = [
      for (final o in (_preview['orders'] as List?) ?? const [])
        _OrderDraft((o as Map).cast<String, dynamic>(), lineEditable: false),
    ];
    _brushWh = [
      for (final w in (_preview['brush_warehouse_names'] as List?) ?? const []) wsS(w),
    ];
    for (var i = 0; i < _orders.length; i++) {
      if (_isBrush(i)) {
        final fee = wsD(_orders[i].order['brush_fee_auto']) > 0
            ? wsD(_orders[i].order['brush_fee_auto'])
            : _defaultFee;
        _brushCost.add(TextEditingController());
        _brushFee.add(TextEditingController(text: fee.toStringAsFixed(2)));
      } else {
        _brushCost.add(null);
        _brushFee.add(null);
      }
    }
  }

  @override
  void dispose() {
    for (final d in _orders) {
      d.dispose();
    }
    for (final c in _brushCost) {
      c?.dispose();
    }
    for (final c in _brushFee) {
      c?.dispose();
    }
    _batchCost.dispose();
    _batchTotal.dispose();
    super.dispose();
  }

  /// web brushApply：一键把同一个刷单成本填到各单（onlyBlank 时只补没填过的）
  void _applyBatch(bool onlyBlank) {
    final v = double.tryParse(_batchCost.text.trim());
    if (v == null || v < 0) {
      wsToast(context, '请先填一个刷单成本，如 1475');
      return;
    }
    var n = 0;
    for (final i in _brushIdx) {
      if (onlyBlank && _costOf(i) > 0) continue;
      setState(() => _brushCost[i]!.text = v.toStringAsFixed(2));
      n++;
    }
    wsToast(context, n > 0 ? '已把刷单成本 ${wsMoney(v)} 填到 $n 单' : '没有需要填的单（都已填过）');
  }

  /// web brushDistribute：只填总成本，按结算收入占比（默认）或平均分摊，尾差落在最大的一单
  void _distribute() {
    final total = double.tryParse(_batchTotal.text.trim());
    if (total == null || total < 0) {
      wsToast(context, '请先填本次刷单总成本，如 3000');
      return;
    }
    final rows = _brushIdx;
    if (rows.isEmpty) return;
    final w = [for (final i in rows) _splitMode == 'avg' ? 1.0 : _orderIncome(i)];
    if (_splitMode != 'avg' && !w.any((x) => x > 0)) {
      wsToast(context, '这些单没有结算收入，请改用「平均分摊」');
      return;
    }
    final sum = w.fold<double>(0, (s, x) => s + x);
    final safeSum = sum > 0 ? sum : 1;
    final vals = [for (final x in w) (total * x / safeSum * 100).roundToDouble() / 100];
    final diff = ((total - vals.fold<double>(0, (s, x) => s + x)) * 100).roundToDouble() / 100;
    if (diff != 0) {
      var k = 0;
      for (var i = 0; i < vals.length; i++) {
        if (vals[i] > vals[k]) k = i;
      }
      vals[k] = ((vals[k] + diff) * 100).roundToDouble() / 100;
    }
    setState(() {
      for (var i = 0; i < rows.length; i++) {
        _brushCost[rows[i]]!.text = vals[i].toStringAsFixed(2);
      }
    });
    wsToast(context,
        '已按${_splitMode == "avg" ? "平均" : "结算收入占比"}把总额 ${wsMoney(total)} 分摊到 ${rows.length} 单');
  }

  /// web brushApplyBlankClear：清空全部刷单成本
  void _clearCost() {
    var n = 0;
    setState(() {
      for (final i in _brushIdx) {
        if (_costOf(i) > 0) {
          _brushCost[i]!.clear();
          n++;
        }
      }
    });
    wsToast(context, n > 0 ? '已清空 $n 单的刷单成本' : '本来就没填');
  }

  /// web runBatchModal('jushuitan')：同一文件重新解析
  Future<void> _reparse() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await ApiService.previewImportJushuitan(widget.filePath);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _preview = r;
        _submitError = null;
        _buildDrafts();
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '解析失败：${e.message}', error: true);
    }
  }

  /// web confirmAggregate：不逐单编辑，按原单据整批出库；放单仓带上刷单成本/固定费
  Future<void> _confirm() async {
    if (_busy || _submitting) return;
    final orders = <Map<String, dynamic>>[];
    for (var i = 0; i < _orders.length; i++) {
      final isBrush = _isBrush(i);
      final p = _orders[i].payload(
        brushCost: isBrush ? _costOf(i) : 0,
        brushFee: isBrush ? _feeOf(i) : 0,
      );
      if ((p['lines'] as List).isEmpty) continue;
      orders.add(p);
    }
    if (orders.isEmpty) {
      wsToast(context, '没有可出库的单据');
      return;
    }
    setState(() => _submitting = true);
    try {
      final r = await ApiService.confirmImportJushuitan(orders, source: widget.fileName);
      if (!mounted) return;
      Navigator.of(context).pop(r);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _submitError = '确认出库失败：${e.message}';
      });
    }
  }

  /// web unmappedChip：商品名 + 缺小类说明 + 「去新增商品」
  Widget _unmappedChip(String code, Map<String, dynamic>? info) {
    final stockName = info == null ? '' : wsS(info['stock_product_name']);
    final reason = info == null ? '' : wsS(info['reason']);
    Widget chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: WsTokens.amberLight.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(WsTokens.radiusSm),
        border: Border.all(color: WsTokens.amber.withValues(alpha: 0.4)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(code, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          if (stockName.isNotEmpty) ...[
            const SizedBox(width: 6),
            Text('缺关联结算小类（只匹配到大类：$stockName）',
                style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
          ],
          DesktopLink(
            '＋ 去新增商品',
            onPressed: () {
              Navigator.of(context).pop();
              widget.onNavigate('/products');
            },
          ),
        ],
      ),
    );
    if (reason.isNotEmpty) chip = Tooltip(message: reason, child: chip);
    return chip;
  }

  List<Widget> _warnWidgets() {
    final out = <Widget>[];
    final codes = [for (final c in (_preview['unmapped_codes'] as List?) ?? const []) wsS(c)];
    final details = <String, Map<String, dynamic>>{
      for (final u in (_preview['unmapped'] as List?) ?? const [])
        wsS((u as Map)['external_code']): u.cast<String, dynamic>(),
    };
    if (codes.isNotEmpty) {
      final hasStockOnly = details.values.any((d) => wsS(d['stock_product_name']).isNotEmpty);
      out.add(DesktopNotice(
          '⚠ 未关联商品 ${codes.length} 个。点「＋ 去新增商品」按该名称新建商品（保存后回到本页点「↻ 重新解析（同一文件）」即按名称自动匹配）：',
          kind: DesktopNoticeKind.warn));
      if (hasStockOnly) {
        out.add(const DesktopNotice(
            '带「缺关联结算小类」标签的，是平台商品名只匹配到了库存大类（未扣任何库存）—— 新建订单小类并关联该大类后重新解析即可正常结算。',
            kind: DesktopNoticeKind.info));
      }
      out.add(Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [for (final c in codes) _unmappedChip(c, details[c])],
        ),
      ));
    }
    final skip = _skipText(_preview['skip']);
    if (skip.isNotEmpty) out.add(DesktopNotice('⚠ 跳过：$skip', kind: DesktopNoticeKind.warn));
    final failed = (_preview['failed'] as List?) ?? const [];
    if (failed.isNotEmpty) {
      final reasons = failed.take(5).map((f) => wsS((f as Map)['reason'])).join('；');
      out.add(DesktopNotice('解析失败 ${failed.length} 条：$reasons', kind: DesktopNoticeKind.error));
    }
    return out;
  }

  /// web brushRowsHtml + brushCalc：逐单刷单结算表（实时利润与合计）
  Widget _brushSection(List<int> idx) {
    var sumIncome = 0.0, sumFee = 0.0, sumCost = 0.0, sumProfit = 0.0;
    final rows = <DesktopRow>[];
    for (final i in idx) {
      final o = _orders[i];
      final income = _orderIncome(i);
      final fee = _feeOf(i);
      final cost = _costOf(i);
      final profit = income - fee - cost;
      sumIncome += income;
      sumFee += fee;
      sumCost += cost;
      sumProfit += profit;
      final goods = [
        for (final l in o.lines)
          '${wsS(l.line['product_name'])} × ${_numText(l.line['quantity'])}${wsS(l.line['unit'])}',
      ].join(' ／ ');
      rows.add(DesktopRow(
        cells: [
          wsCell(wsS(o.order['doc_no']).isEmpty ? '（无单号）' : wsS(o.order['doc_no'])),
          wsCell(wsS(o.order['date'])),
          wsCell(goods.isEmpty ? '—' : goods),
          wsCell(wsMoney(income)),
          DesktopTextField(
            controller: _brushFee[i],
            width: 84,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: DesktopTextField.decimalOnly,
            onChanged: (_) => setState(() {}),
          ),
          DesktopTextField(
            controller: _brushCost[i],
            width: 112,
            hintText: '我刷这单的成本',
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: DesktopTextField.decimalOnly,
            onChanged: (_) => setState(() {}),
          ),
          wsCell(wsMoney(profit), color: profit >= 0 ? WsTokens.green : WsTokens.red, bold: true),
        ],
        tag: i,
      ));
    }
    final filled = idx.where((i) => _costOf(i) > 0).length;
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(WsTokens.radius),
        border: Border.all(color: WsTokens.amber.withValues(alpha: 0.35)),
        color: WsTokens.amberLight.withValues(alpha: 0.18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('💳 芳谊放单仓 · 逐单刷单结算（共 ${idx.length} 单）',
              style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text('结算价 = 结算收入（已扣店铺扣点） − 快递+包装固定费；利润 = 结算价 − 我刷这单的成本',
              style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          const SizedBox(height: 6),
          Text(
            '下面每一单都要填「刷单成本」（也可以只填本次总成本、用下面的「按总额分摊」自动摊到各单）；'
            '「快递+包装」已按默认值 ${wsMoney(_defaultFee)}/单预填（可逐单改），只影响这一单的结算口径。'
            '已填 $filled / ${idx.length} 单。这些金额会写进出库单，报表里一并从利润扣掉。',
            style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight, height: 1.5),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Text('每单同一个成本', style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              DesktopTextField(
                controller: _batchCost,
                width: 120,
                hintText: '如 1475',
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: DesktopTextField.decimalOnly,
              ),
              DesktopButton(label: '应用到全部 ${idx.length} 单', small: true, onPressed: () => _applyBatch(false)),
              DesktopButton(label: '只填未填的', small: true, onPressed: () => _applyBatch(true)),
              DesktopButton(label: '清空成本', small: true, onPressed: _clearCost),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Text('本次刷单总成本', style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
              DesktopTextField(
                controller: _batchTotal,
                width: 120,
                hintText: '如 3000',
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: DesktopTextField.decimalOnly,
              ),
              DesktopSelect<String>(
                value: _splitMode,
                options: const [
                  DesktopOption('revenue', '按结算收入占比分摊'),
                  DesktopOption('avg', '平均分摊'),
                ],
                width: 190,
                onChanged: (v) => setState(() => _splitMode = v ?? 'revenue'),
              ),
              DesktopButton(label: '按总额分摊到 ${idx.length} 单', small: true, onPressed: _distribute),
            ],
          ),
          const SizedBox(height: 10),
          DesktopGrid(
            cols: const [
              DesktopCol('出库单号', width: 150),
              DesktopCol('日期', width: 90),
              DesktopCol('商品', width: 320),
              DesktopCol('结算收入', width: 96, right: true),
              DesktopCol('快递+包装', width: 104, right: true),
              DesktopCol('刷单成本', width: 132, right: true),
              DesktopCol('利润', width: 96, right: true),
            ],
            rows: rows,
            footer: [
              '合计 ${idx.length} 单',
              '',
              '',
              wsMoney(sumIncome),
              wsMoney(sumFee),
              wsMoney(sumCost),
              wsMoney(sumProfit),
            ],
            rowHeight: 48,
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_submitting) {
      return Center(
        child: SizedBox(
          width: 460,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const DesktopNotice('⏳ 正在提交出库，操作运行中…', kind: DesktopNoticeKind.success),
              Text('共 ${_orders.length} 单，一般数秒内完成；请勿关闭窗口或重复点击。完成后将自动展示结果。',
                  style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
            ],
          ),
        ),
      );
    }
    final rows = _aggregateDraftLines([for (final o in _orders) o.order]);
    final sumQty = rows.fold<double>(0, (s, x) => s + x.qty);
    final sumAmt = rows.fold<double>(0, (s, x) => s + x.amount);
    final packFee = _orders.fold<double>(0, (s, o) => s + wsD(o.order['pack_fee']));
    final dates = [for (final o in _orders) wsS(o.order['date'])]
        .where((d) => d.isNotEmpty)
        .toList()
      ..sort();
    final range = dates.isEmpty
        ? ''
        : (dates.first == dates.last ? dates.first : '${dates.first} ~ ${dates.last}');
    final brushIdx = _brushIdx;
    final head = '共 ${_orders.length} 单'
        '${range.isNotEmpty ? '（$range）' : ''}，'
        '商品 ${rows.length} 种，合计金额 ${wsMoney(sumAmt)}'
        '${packFee > 0 ? '（另有打包费 ${wsMoney(packFee)}）' : ''}。确认后按原单据整批出库。';
    final aggRows = <DesktopRow>[
      for (final x in rows)
        DesktopRow(
          cells: [
            Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                wsCell(x.name, bold: true),
                if (x.deduct.isNotEmpty)
                  Text(x.deduct,
                      style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
              ],
            ),
            wsCell(x.unit.isEmpty ? '—' : x.unit),
            wsCell('${x.docs.length}'),
            wsCell(_numText(x.qty)),
            wsCell(wsMoney(x.price)),
            wsCell(wsMoney(x.perOrder)),
            wsCell(wsMoney(x.amount), bold: true),
          ],
        ),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_orders.isEmpty)
                  const DesktopNotice('未解析出可出库的单据。', kind: DesktopNoticeKind.warn)
                else
                  DesktopNotice(head, kind: DesktopNoticeKind.success),
                ..._warnWidgets(),
                if (_submitError != null)
                  DesktopNotice(_submitError!, kind: DesktopNoticeKind.error),
                if (brushIdx.isNotEmpty && _orders.isNotEmpty) _brushSection(brushIdx),
                if (_orders.isNotEmpty)
                  DesktopGrid(
                    cols: const [
                      DesktopCol('商品', width: 260),
                      DesktopCol('单位', width: 70),
                      DesktopCol('订单数', width: 70, right: true),
                      DesktopCol('总数量', width: 100, right: true),
                      DesktopCol('均价', width: 96, right: true),
                      DesktopCol('每单金额', width: 110, right: true),
                      DesktopCol('总金额', width: 110, right: true),
                    ],
                    rows: aggRows,
                    footer: [
                      '合计 ${rows.length} 种商品 · ${_orders.length} 单',
                      '',
                      '',
                      _numText(sumQty),
                      '—',
                      '—',
                      wsMoney(sumAmt),
                    ],
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            DesktopButton(label: '重新选择文件', onPressed: _busy ? null : () => Navigator.of(context).pop()),
            const SizedBox(width: 10),
            DesktopButton(label: '↻ 重新解析（同一文件）', onPressed: _busy ? null : _reparse),
            if (_orders.isNotEmpty) ...[
              const SizedBox(width: 10),
              DesktopButton(
                label: '✓ 确认出库（${_orders.length} 单）',
                kind: DesktopButtonKind.success,
                onPressed: _busy ? null : _confirm,
              ),
            ],
          ],
        ),
      ],
    );
  }
}

// ------------------------------------------------ 聚水潭关联（web loadMappingPage / renderMappings）

class _MappingPanel extends StatefulWidget {
  const _MappingPanel({required this.onNavigate});
  final void Function(String route) onNavigate;

  @override
  State<_MappingPanel> createState() => _MappingPanelState();
}

class _MappingPanelState extends State<_MappingPanel> {
  bool _loading = true;
  String _error = '';
  Map<String, dynamic> _data = const {'summary': {}, 'items': []};
  List<dynamic> _products = [];
  final TextEditingController _search = TextEditingController();
  String _filter = '';
  _PickedFile? _parseFile;
  _PickedFile? _importFile;
  Map<String, dynamic>? _parseInfo;
  String _parseError = '';
  final GlobalKey<_DraftResultBoxState> _importResult = GlobalKey<_DraftResultBoxState>();
  bool _busy = false;

  List<Map<String, dynamic>> get _items =>
      ((_data['items'] as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();

  Map<String, dynamic> get _summary =>
      ((_data['summary'] as Map?) ?? const {}).cast<String, dynamic>();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await ApiService.mappings();
      if (!mounted) return;
      setState(() {
        _data = d;
        _loading = false;
        _error = '';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '加载关联明细失败：${e.message}';
      });
    }
  }

  Future<void> _ensureProducts() async {
    if (_products.isNotEmpty) return;
    try {
      _products = await ApiService.products();
    } on ApiException {
      // 拉不到候选不影响编辑已有映射的展示
    }
  }

  List<DesktopOption<String>> get _productOptions => [
        const DesktopOption('', '（不关联 / 清空）'),
        for (final p in _products)
          DesktopOption(
            wsS((p as Map)['id']),
            '${wsS(p['name'])}（${p['product_type'] == 'order' ? '订单' : '库存'} · ${wsS(p['category'], fallback: '—')}）',
          ),
      ];

  Future<void> _autoMatch() async {
    try {
      final r = await ApiService.autoMapping();
      if (!mounted) return;
      wsToast(context, '自动匹配 ${wsI(r['matched'])}/${wsI(r['total'])} 条');
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '匹配失败：${e.message}', error: true);
    }
  }

  Future<void> _clearAll() async {
    final ok1 = await wsConfirm(context, title: '清空关联', message: '确认清空全部编码关联？', danger: true);
    if (!ok1 || !mounted) return;
    final ok2 = await wsConfirm(
      context,
      title: '再次确认',
      message: '再次确认：清空后所有聚水潭商品名都不再自动关联，需重新维护。确定继续？',
      danger: true,
    );
    if (!ok2 || !mounted) return;
    try {
      await ApiService.clearMappings();
      if (!mounted) return;
      wsToast(context, '已清空');
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '清空失败：${e.message}', error: true);
    }
  }

  Future<void> _delete(Map<String, dynamic> m) async {
    final ok = await wsConfirm(context,
        title: '删除关联', message: '确认删除关联「${wsS(m['external_code'])}」？', danger: true);
    if (!ok || !mounted) return;
    try {
      await ApiService.deleteMapping(wsI(m['id']));
      if (!mounted) return;
      wsToast(context, '已删除');
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '删除失败：${e.message}', error: true);
    }
  }

  Future<void> _openEdit([Map<String, dynamic>? m]) async {
    await _ensureProducts();
    if (!mounted) return;
    final saved = await _wsDialog<bool>(
      context,
      title: m == null ? '新增聚水潭关联' : '编辑聚水潭关联',
      width: 560,
      body: _MappingEditDialog(
        mapping: m,
        options: _productOptions,
        onNavigate: widget.onNavigate,
      ),
    );
    if (saved == true) _load();
  }

  /// web parseJushuitan：解析并自动新增（只建关联，不出库）
  Future<void> _parse() async {
    final f = _parseFile;
    if (f == null) {
      wsToast(context, '请先选择聚水潭出库单文件');
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await ApiService.parseJushuitan(f.path);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _parseInfo = r;
        _parseError = '';
      });
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _parseError = '解析失败：${e.message}';
      });
    }
  }

  /// web batchFromImport('jushuitan')：导入出库单（预览确认）
  Future<void> _importPreview() async {
    final f = _importFile;
    if (f == null) {
      wsToast(context, '请先选择聚水潭出库单文件');
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await ApiService.previewImportJushuitan(f.path);
      if (!mounted) return;
      setState(() => _busy = false);
      final res = await _wsDialog<Map<String, dynamic>>(
        context,
        title: '导入聚水潭出库单 — 商品汇总预览',
        width: 1180,
        maxHeight: 780,
        body: _JstReviewBody(
            preview: r,
            fileName: f.name,
            filePath: f.path,
            onNavigate: widget.onNavigate),
      );
      if (res != null) _importResult.currentState?.show(res);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '解析失败：${e.message}', error: true);
    }
  }

  List<Map<String, dynamic>> get _filteredItems {
    final kw = _search.text.trim().toLowerCase();
    final f = _filter;
    var items = _items;
    if (kw.isNotEmpty) {
      items = items
          .where((m) =>
              wsS(m['external_code']).toLowerCase().contains(kw) ||
              wsS(m['product_name']).toLowerCase().contains(kw))
          .toList();
    }
    if (f == 'linked') {
      items = items.where((m) => m['product_id'] != null).toList();
    } else if (f == 'unlinked') {
      items = items.where((m) => m['product_id'] == null).toList();
    } else if (f == 'order') {
      items = items.where((m) => m['product_type'] == 'order').toList();
    } else if (f == 'stock') {
      items = items.where((m) => m['product_type'] == 'stock').toList();
    }
    return items;
  }

  Widget _sumItem(String label, int v, Color color) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
          const SizedBox(width: 4),
          Text('$v', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: color)),
        ],
      );

  Widget _parseSummary() {
    final errs = <Widget>[
      if (_parseError.isNotEmpty) DesktopNotice(_parseError, kind: DesktopNoticeKind.error),
    ];
    final r = _parseInfo;
    if (r == null) {
      if (errs.isEmpty) return const SizedBox.shrink();
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: errs);
    }
    final codes = (r['codes'] as List?) ?? const [];
    final list = codes.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
    final skip = _skipText(r['skip']);
    final created = list.where((c) => wsS(c['status']) == '自动新增').toList();
    final existed = list.where((c) => wsS(c['status']) == '已存在').toList();
    final linked = list.where((c) => wsS(c['stock_product_name']).isNotEmpty).toList();
    final unlinked = list.where((c) => wsS(c['stock_product_name']).isEmpty).toList();
    final out = <Widget>[
      DesktopNotice(
          '共 ${wsI(r['total_orders'])} 单已出库，解析出 ${list.length} 种订单商品'
          '${skip.isNotEmpty ? '，跳过（$skip）' : ''}。',
          kind: DesktopNoticeKind.success),
      DesktopNotice(
          '${linked.length} 种已关联库存商品'
          '${linked.isEmpty ? '' : '（${linked.map((c) => '${wsS(c['product_name'])} → ${wsS(c['stock_product_name'])}').join('、')}）'}'
          ' ｜ 本次自动新增 ${created.length} 种订单商品'
          '${existed.isNotEmpty ? '，已存在未新增 ${existed.length} 种' : ''}',
          kind: DesktopNoticeKind.info),
      if (unlinked.isNotEmpty)
        DesktopNotice(
            '未匹配库存 ${unlinked.length} 种：${unlinked.map((c) => wsS(c['product_name'])).join('、')}'
            '（可在出库页「关联结算」中维护）',
            kind: DesktopNoticeKind.warn),
    ];
    if (_parseError.isNotEmpty) out.addAll(errs);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: out);
  }

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return DesktopStateView(
      loading: _loading,
      error: _loading ? null : (_error.isEmpty ? null : _error),
      onRetry: _load,
      loadingText: '正在加载关联明细…',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const WsCardHead(
                  title: '① 上传聚水潭销售出库单并自动新增关联',
                  trailing: Flexible(
                    child: Text('自动新增不存在的订单商品并关键词关联库存商品；明细维护见下方「③ 关联明细维护」',
                        style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                  ),
                ),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    DesktopButton(
                        label: _parseFile == null ? '选择出库单（xlsx）' : _parseFile!.name,
                        icon: SolarIconsOutline.paperclip,
                        onPressed: _busy
                            ? null
                            : () async {
                                final f = await _pickFile(['xlsx']);
                                if (f != null && mounted) setState(() => _parseFile = f);
                              }),
                    DesktopButton(label: '解析并自动新增', kind: DesktopButtonKind.primary, onPressed: _busy ? null : _parse),
                    DesktopButton(label: '自动匹配未关联', onPressed: _busy ? null : _autoMatch),
                    DesktopButton(label: '清空关联', kind: DesktopButtonKind.danger, onPressed: _busy ? null : _clearAll),
                  ],
                ),
                const SizedBox(height: 12),
                _parseSummary(),
              ],
            ),
          ),
          WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const WsCardHead(
                  title: '② 导入聚水潭出库单（自动结算）',
                  trailing: Flexible(
                    child: Text('按已保存的关联生成出库单并核算成本',
                        style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                  ),
                ),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    DesktopButton(
                        label: _importFile == null ? '选择出库单（xlsx）' : _importFile!.name,
                        icon: SolarIconsOutline.paperclip,
                        onPressed: _busy
                            ? null
                            : () async {
                                final f = await _pickFile(['xlsx']);
                                if (f != null && mounted) setState(() => _importFile = f);
                              }),
                    DesktopButton(
                        label: '导入出库单（预览确认）',
                        kind: DesktopButtonKind.success,
                        onPressed: _busy ? null : _importPreview),
                  ],
                ),
                const SizedBox(height: 12),
                _DraftResultBox(key: _importResult),
              ],
            ),
          ),
          WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const WsCardHead(
                  title: '③ 关联明细维护',
                  trailing: Flexible(
                    child: Text('查看每条「聚水潭商品名 → 系统商品」映射，可编辑 / 删除 / 手动新增；顶部统计关联结算（订单商品）占比',
                        style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                  ),
                ),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    _sumItem('关联总数', wsI(_summary['total']), dark ? WsTokens.textDark : WsTokens.textLight),
                    _sumItem('已关联', wsI(_summary['linked']), WsTokens.green),
                    _sumItem('未关联', wsI(_summary['unlinked']), WsTokens.amber),
                    _sumItem('→ 关联结算（订单商品）', wsI(_summary['linked_order']), WsTokens.primary),
                    _sumItem('→ 库存商品', wsI(_summary['linked_stock']), WsTokens.primary),
                  ],
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    DesktopTextField(
                      controller: _search,
                      hintText: '🔍 搜索聚水潭商品名 / 系统商品...',
                      width: 300,
                      onChanged: (_) => setState(() {}),
                    ),
                    DesktopSelect<String>(
                      value: _filter,
                      width: 210,
                      options: const [
                        DesktopOption('', '全部关联'),
                        DesktopOption('linked', '已关联'),
                        DesktopOption('unlinked', '未关联（待匹配）'),
                        DesktopOption('order', '指向关联结算（订单商品）'),
                        DesktopOption('stock', '指向库存商品'),
                      ],
                      onChanged: (v) => setState(() => _filter = v ?? ''),
                    ),
                    DesktopButton(label: '＋ 手动新增关联', kind: DesktopButtonKind.primary, onPressed: () => _openEdit()),
                  ],
                ),
                const SizedBox(height: 12),
                DesktopGrid(
                  cols: const [
                    DesktopCol('聚水潭商品名', width: 300),
                    DesktopCol('关联系统商品', width: 220),
                    DesktopCol('类型', width: 90),
                    DesktopCol('扣减库存商品', width: 170),
                    DesktopCol('操作', width: 130),
                  ],
                  rows: [
                    for (final m in _filteredItems)
                      DesktopRow(
                        tag: m['id'],
                        cells: [
                          Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              wsCell(wsS(m['external_code']), bold: true),
                              if (wsS(m['external_name']).isNotEmpty && wsS(m['external_name']) != wsS(m['external_code']))
                                Text(wsS(m['external_name']),
                                    style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                            ],
                          ),
                          m['product_id'] == null
                              ? wsCell('—', color: WsTokens.mutedLight)
                              : Column(
                                  mainAxisSize: MainAxisSize.min,
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    wsCell(wsS(m['product_name'], fallback: '（已删除商品）'), bold: true),
                                    if (wsS(m['product_category']).isNotEmpty)
                                      Text(wsS(m['product_category']),
                                          style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                                  ],
                                ),
                          m['product_id'] == null
                              ? const DesktopTag('未关联', color: DesktopTag.off)
                              : (m['product_name'] == null
                                  ? const DesktopTag('已失效', color: DesktopTag.off)
                                  : (m['product_type'] == 'order'
                                      ? const DesktopTag('订单', color: DesktopTag.income)
                                      : const DesktopTag('库存'))),
                          m['product_id'] == null
                              ? wsCell('—', color: WsTokens.mutedLight)
                              : (m['product_type'] == 'order'
                                  ? (wsS(m['stock_product_name']).isEmpty
                                      ? wsCell('未关联库存', color: WsTokens.red)
                                      : wsCell(wsS(m['stock_product_name'])))
                                  : wsCell('—', color: WsTokens.mutedLight)),
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              DesktopLink('编辑', onPressed: () => _openEdit(m)),
                              DesktopLink('删除', color: WsTokens.red, onPressed: () => _delete(m)),
                            ],
                          ),
                        ],
                      ),
                  ],
                  rowHeight: 48,
                  emptyText: '暂无关联，可上传聚水潭出库单自动生成，或点击「手动新增关联」',
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ================================================================ E 自动出库设置（web loadJstAutoPage）

/// 聚水潭关联的新增/编辑弹窗主体（web mappingEdit / mappingSave）。
/// 前一位同事的 _MappingPanel 引用了本类但没落文件，这里按网页端行为补齐。
class _MappingEditDialog extends StatefulWidget {
  const _MappingEditDialog({
    this.mapping,
    required this.options,
    required this.onNavigate,
  });

  final Map<String, dynamic>? mapping;
  final List<DesktopOption<String>> options;
  final void Function(String route) onNavigate;

  @override
  State<_MappingEditDialog> createState() => _MappingEditDialogState();
}

class _MappingEditDialogState extends State<_MappingEditDialog> {
  late final TextEditingController _code;
  String _productId = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final m = widget.mapping;
    _code = TextEditingController(text: m == null ? '' : wsS(m['external_code']));
    _productId = (m == null || m['product_id'] == null) ? '' : wsI(m['product_id']).toString();
  }

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final code = _code.text.trim();
    if (code.isEmpty) {
      wsToast(context, '请填写聚水潭商品名');
      return;
    }
    setState(() => _busy = true);
    try {
      await ApiService.saveMapping(
        externalCode: code,
        productId: _productId.isEmpty ? null : wsI(_productId),
      );
      if (!mounted) return;
      wsToast(context, '已保存');
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '保存失败：${e.message}', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        DesktopFormRow(
          label: '聚水潭商品名',
          required: true,
          child: DesktopTextField(controller: _code, hintText: '如：新鲜香蕈菌250g'),
        ),
        DesktopFormRow(
          label: '关联系统商品',
          tip: '导入出库单时，聚水潭商品名将按此映射结算；选「清空」= 不关联',
          child: DesktopSearchField(
            title: '选择系统商品',
            value: _productId.isEmpty ? null : _productId,
            options: widget.options,
            hint: '（不关联 / 清空）',
            onChanged: (v) => setState(() => _productId = v ?? ''),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Row(
            children: [
              const Text('找不到系统商品？',
                  style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
              DesktopLink('＋ 去新增商品', onPressed: () {
                Navigator.of(context).pop();
                widget.onNavigate('/products');
              }),
            ],
          ),
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            DesktopButton(label: '取消', onPressed: _busy ? null : () => Navigator.of(context).pop()),
            const SizedBox(width: 10),
            DesktopButton(
              label: '保存',
              kind: DesktopButtonKind.primary,
              onPressed: _busy ? null : _save,
            ),
          ],
        ),
      ],
    );
  }
}

/// 只读「日期时间」输入框（web input[type=datetime-local]）。
/// 值统一为 "YYYY-MM-DD HH:MM" 字符串，空串 = 未填；提交时由调用方补 ":00" 秒。
class _JstDateTimeBox extends StatelessWidget {
  const _JstDateTimeBox({required this.value, required this.onChanged});

  final String value;
  final ValueChanged<String> onChanged;

  static final RegExp _pat = RegExp(r'^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})');

  static String _two(int v) => v.toString().padLeft(2, '0');

  DateTime? get _parsed {
    final m = _pat.firstMatch(value);
    if (m == null) return null;
    return DateTime(int.parse(m.group(1)!), int.parse(m.group(2)!), int.parse(m.group(3)!),
        int.parse(m.group(4)!), int.parse(m.group(5)!));
  }

  Future<void> _open(BuildContext context) async {
    final init = _parsed ?? DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: init,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
      helpText: '选择日期',
    );
    if (date == null || !context.mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: init.hour, minute: init.minute),
      helpText: '选择时间',
    );
    if (time == null) return;
    onChanged('${_dstr(date)} ${_two(time.hour)}:${_two(time.minute)}');
  }

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    final cleared = value.isEmpty;
    return GestureDetector(
      onTap: () => _open(context),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: Container(
          width: 172,
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: dark ? WsTokens.bgDark : const Color(0xFFFBFBFB),
            borderRadius: BorderRadius.circular(WsTokens.radiusSm),
            border: Border.all(color: dark ? WsTokens.borderDark : WsTokens.borderLight),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  cleared ? '不限' : value,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    color: cleared
                        ? WsTokens.mutedLight
                        : (dark ? WsTokens.textDark : WsTokens.textLight),
                  ),
                ),
              ),
              if (!cleared)
                GestureDetector(
                  onTap: () => onChanged(''),
                  child: const Icon(SolarIconsOutline.closeCircle, size: 14, color: WsTokens.mutedLight),
                )
              else
                const Icon(SolarIconsOutline.clockCircle, size: 15, color: WsTokens.mutedLight),
            ],
          ),
        ),
      ),
    );
  }
}

class _JstAutoPanel extends StatefulWidget {
  const _JstAutoPanel({required this.onNavigate});
  final void Function(String route) onNavigate;

  @override
  State<_JstAutoPanel> createState() => _JstAutoPanelState();
}

class _JstAutoPanelState extends State<_JstAutoPanel> {
  // ---- 全局（跨分仓共享，写进 globals） ----
  final TextEditingController _account = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _cookie = TextEditingController();
  final TextEditingController _owner = TextEditingController(text: '13662884');
  final TextEditingController _minInterval = TextEditingController(text: '10');
  final TextEditingController _timeout = TextEditingController(text: '120');
  final TextEditingController _retries = TextEditingController(text: '3');
  final TextEditingController _webhook = TextEditingController();
  final TextEditingController _notifyUsers = TextEditingController();
  bool _hasPassword = false;
  bool _hasCookie = false;
  int _cookieLen = 0;
  String _ioDateField = 'io_date'; // 表单不回显，保存时原样带回
  String _filenameTemplate = '';

  // ---- 本仓（写进 warehouse） ----
  final TextEditingController _schedule = TextEditingController();
  final TextEditingController _jitter = TextEditingController(text: '0');
  final TextEditingController _operator = TextEditingController();
  bool _enabled = false;
  bool _autoImport = true;
  bool _skipImported = true;
  String _window = 'yesterday';
  List<DesktopOption<String>> _windowOptions = const [
    DesktopOption('yesterday', '昨天 00:00 ~ 今天 00:00'),
  ];
  String _windowHelp = '';
  String _fixedFrom = ''; // "YYYY-MM-DD HH:MM"，空 = 未填
  String _fixedTo = '';
  final Map<String, String> _whOpts = {}; // 聚水潭分仓 co_id → 名称（已保存的 + 拉取到的）
  final Set<String> _pickedTargets = {}; // 勾选中的 co_id
  String _whName = '—';
  String _nextRunsText = '';

  // ---- 状态 / 待办 / 历史 ----
  Map<String, dynamic> _statusMap = const {};
  Map<String, dynamic> _lastRun = const {};
  List<Map<String, dynamic>> _pending = const [];
  int _pendingCount = 0;
  List<Map<String, dynamic>> _runs = const [];
  Timer? _poll;

  bool _loading = true;
  String? _error;
  bool _busy = false;
  String _checkText = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _stopPoll();
    _account.dispose();
    _password.dispose();
    _cookie.dispose();
    _owner.dispose();
    _minInterval.dispose();
    _timeout.dispose();
    _retries.dispose();
    _webhook.dispose();
    _notifyUsers.dispose();
    _schedule.dispose();
    _jitter.dispose();
    _operator.dispose();
    super.dispose();
  }

  // ------------------------------------------------ 数据装载 / 回填

  Future<void> _load() async {
    _stopPoll();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final d = await ApiService.jstSettings();
      if (!mounted) return;
      setState(() => _loading = false);
      _fill(d);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载自动出库设置失败：${e.message}';
        _loading = false;
      });
    }
  }

  /// web fillJstAuto：用返回值重填表单（口令类永不回显）
  void _fill(Map<String, dynamic> d) {
    final g = ((d['globals'] as Map?) ?? const {}).cast<String, dynamic>();
    final wh = ((d['warehouse'] as Map?) ?? const {}).cast<String, dynamic>();
    _hasPassword = g['has_password'] == true;
    _hasCookie = g['has_cookie'] == true;
    _cookieLen = wsI(g['cookie_len']);
    _ioDateField = wsS(g['io_date_field'], fallback: 'io_date');
    _filenameTemplate = wsS(g['filename_template']);
    _account.text = wsS(g['account']);
    _password.clear();
    _cookie.clear();
    _owner.text = wsS(g['owner_co_id'], fallback: '13662884');
    _minInterval.text = _numText(g['min_interval'] ?? 10);
    _timeout.text = _numText(g['timeout'] ?? 120);
    _retries.text = _numText(g['max_retries'] ?? 3);
    _webhook.text = wsS(g['notify_webhook']);
    _notifyUsers.text = ((g['notify_users'] as List?) ?? const []).map(wsS).join(',');

    _enabled = wh['enabled'] == true;
    _autoImport = wh['auto_import'] != false;
    _skipImported = wh['skip_imported'] != false;
    final wins = ((d['windows'] as List?) ?? const []).whereType<Map>().toList();
    if (wins.isNotEmpty) {
      _windowOptions = [
        for (final w in wins) DesktopOption<String>(wsS(w['value']), wsS(w['label'])),
      ];
    }
    _window = wsS(wh['window']);
    if (!_windowOptions.any((o) => o.value == _window)) {
      _window = _windowOptions.isNotEmpty ? _windowOptions.first.value : 'yesterday';
    }
    _windowHelp = wsS(d['window_help']);
    _fixedFrom = _toMinuteText(wsS(wh['fixed_from']));
    _fixedTo = _toMinuteText(wsS(wh['fixed_to']));
    _schedule.text = ((wh['schedule'] as List?) ?? const []).map(wsS).join(',');
    final jit = wsI(wh['jitter_minutes']);
    _jitter.text = '$jit';
    _operator.text = wsS(wh['operator']);
    // web renderJstTargets：合并「已保存的 targets」和「已拉取到的列表」，勾选状态以已保存为准
    _pickedTargets.clear();
    for (final t in (wh['targets'] as List?) ?? const []) {
      final m = (t as Map).cast<String, dynamic>();
      final co = wsS(m['co_id']);
      if (co.isEmpty) continue;
      if (!_whOpts.containsKey(co)) _whOpts[co] = wsS(m['name'], fallback: co);
      _pickedTargets.add(co);
    }
    _whName = wsS(d['warehouse_name'], fallback: wsS(d['warehouse_key'], fallback: '—'));
    final nextRuns = ((d['next_runs'] as List?) ?? const []).map(wsS).toList();
    _nextRunsText = nextRuns.isNotEmpty
        ? '下次执行：${nextRuns.join('、')}${jit > 0 ? '（已开启 ±$jit 分钟随机浮动）' : ''}'
        : (_enabled ? '⚠ 已启用定时但没填执行时间，不会自动跑' : '未启用定时（仍可手动执行）');
    _statusMap = ((d['status'] as Map?) ?? const {}).cast<String, dynamic>();
    _lastRun = ((d['last_run'] as Map?) ?? const {}).cast<String, dynamic>();
    _pending = ((d['pending'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => e.cast<String, dynamic>())
        .toList();
    _pendingCount = wsI(d['pending_count']);
    setState(() {});
    if (_statusMap['running'] == true) {
      _startPoll();
    } else {
      _loadHistory();
    }
  }

  /// "2026-10-05 07:30:00" → "2026-10-05 07:30"（web 用 datetime-local，分钟精度）
  String _toMinuteText(String s) {
    final t = s.replaceFirst(' ', 'T');
    if (t.length < 16) return s;
    return '${t.substring(0, 10)} ${t.substring(11, 16)}';
  }

  static double _jstNum(String t, double dft) {
    final v = wsD(t);
    return v > 0 ? v : dft;
  }

  static int _jstInt(String t, int dft) {
    final v = wsI(t);
    return v > 0 ? v : dft;
  }

  static List<String> _splitCsv(String raw) =>
      raw.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();

  // ------------------------------------------------ 执行状态（web renderJstStatus）

  Map<String, dynamic> get _effectiveLast {
    final lastRaw = ((_statusMap['last'] as Map?) ?? const {}).cast<String, dynamic>();
    return wsS(lastRaw['message']).isNotEmpty ? lastRaw : _lastRun;
  }

  List<String> _statusLines() {
    final st = _statusMap;
    final lines = <String>[];
    if (st['scheduler'] == false) {
      lines.add('⚠ 定时调度未启动：重启一次后端服务即可恢复（手动「立即执行一次」不受影响）');
    }
    if (st['running'] == true) {
      lines.add('⏳ 正在执行：${wsS(st['warehouse'])} · ${wsS(st['step'])}'
          '（${wsS(st['started_at'])} 开始，触发：${wsS(st['trigger'])}）');
    }
    final r = _effectiveLast;
    if (wsS(r['message']).isNotEmpty) {
      lines.add('${r['ok'] == true ? '✅' : '❌'} 最近一次（${wsS(r['at'])} · ${wsS(r['trigger'])}）：'
          '${wsS(r['message'])}');
      if (wsS(r['window']).isNotEmpty) lines.add('　　区间：${wsS(r['window'])}');
      final files = ((r['files'] as List?) ?? const []).map(wsS).toList();
      if (files.isNotEmpty) lines.add('　　文件：${files.join('、')}');
      final s = ((r['stats'] as Map?) ?? const {}).cast<String, dynamic>();
      final unmapped = ((s['unmapped'] as List?) ?? const []).map(wsS).toList();
      if (unmapped.isNotEmpty) {
        lines.add('　　未关联商品 ${unmapped.length} 种：${unmapped.take(6).join('、')}'
            '${unmapped.length > 6 ? ' …' : ''}（到「聚水潭关联」页补关联）');
      }
      final failed = ((s['failed'] as List?) ?? const []).whereType<Map>().toList();
      if (failed.isNotEmpty) {
        final parts = failed
            .take(3)
            .map((f) => '${wsS(f['doc'])} ${wsS(f['reason'])}')
            .join('；');
        lines.add('　　失败 ${failed.length} 条：$parts');
      }
    }
    return lines;
  }

  /// web 出库记录直达按钮：从区间串解析起止日期，结束日期回退一天（区间右端是次日 00:00）
  ({String from, String to})? _statusJump() {
    final m = RegExp(r'(\d{4}-\d{2}-\d{2})[^~]*~\s*(\d{4}-\d{2}-\d{2})')
        .firstMatch(wsS(_effectiveLast['window']));
    if (m == null) return null;
    final from = m.group(1)!;
    final endDay = DateTime.parse('${m.group(2)}T00:00:00').subtract(const Duration(days: 1));
    final end = _dstr(endDay);
    if (end.compareTo(from) < 0) return null;
    return (from: from, to: end);
  }

  void _startPoll() {
    _stopPoll();
    _poll = Timer.periodic(const Duration(seconds: 3), (timer) async {
      try {
        final st = await ApiService.jstStatus();
        if (!mounted) {
          timer.cancel();
          return;
        }
        setState(() => _statusMap = st);
        if (st['running'] != true) {
          timer.cancel();
          _loadHistory();
        }
      } catch (_) {
        timer.cancel(); // 轮询出错也停掉，避免刷屏（web startJstPoll）
      }
    });
  }

  void _stopPoll() {
    _poll?.cancel();
    _poll = null;
  }

  Future<void> _loadHistory() async {
    try {
      final d = await ApiService.jstHistory(limit: 20);
      if (!mounted) return;
      setState(() => _runs = ((d['runs'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => e.cast<String, dynamic>())
          .toList());
    } catch (_) {
      // 历史读不到不影响设置（与网页端一致，静默）
    }
  }

  // ------------------------------------------------ 动作

  Future<void> _save({bool clearCookie = false}) async {
    if (clearCookie) {
      final ok = await wsConfirm(
        context,
        title: '清空 Cookie',
        message: '确认清空已保存的聚水潭 Cookie？（下次执行会用账号密码重新登录）',
      );
      if (!ok || !mounted) return;
    }
    // 字段名严格按后端 SaveIn / GlobalSettingsIn / WhSettingsIn 模型
    final body = {
      'globals': {
        'account': _account.text.trim(),
        'password': _password.text, // 留空 = 不修改（口令永不回显）
        'cookie': _cookie.text.trim(), // 留空 = 不修改
        'owner_co_id': _owner.text.trim(),
        'min_interval': _jstNum(_minInterval.text, 10),
        'timeout': _jstNum(_timeout.text, 120),
        'max_retries': _jstInt(_retries.text, 3),
        'io_date_field': _ioDateField,
        'filename_template': _filenameTemplate,
        'clear_cookie': clearCookie,
        'notify_webhook': _webhook.text.trim(),
        'notify_users': _splitCsv(_notifyUsers.text),
      },
      'warehouse': {
        'enabled': _enabled,
        'targets': [
          for (final e in _whOpts.entries)
            if (_pickedTargets.contains(e.key)) {'co_id': e.key, 'name': e.value},
        ],
        'window': _window.isEmpty ? 'yesterday' : _window,
        'fixed_from': _fixedFrom.isEmpty ? '' : '$_fixedFrom:00',
        'fixed_to': _fixedTo.isEmpty ? '' : '$_fixedTo:00',
        'schedule': _splitCsv(_schedule.text),
        'jitter_minutes': wsI(_jitter.text).clamp(0, 120),
        'auto_import': _autoImport,
        'skip_imported': _skipImported,
        'operator': _operator.text.trim(),
      },
    };
    setState(() => _busy = true);
    try {
      final d = await ApiService.saveJstSettings(body);
      if (!mounted) return;
      setState(() => _busy = false);
      _fill(d);
      wsToast(context, clearCookie ? '已清空 Cookie' : '已保存自动出库设置');
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      wsToast(context, '保存失败：${e.message}', error: true);
    }
  }

  Future<void> _checkLogin() async {
    setState(() => _checkText = '检查中…（聚水潭有限速，可能要十几秒）');
    try {
      final r = await ApiService.jstCheck();
      if (!mounted) return;
      setState(() => _checkText = '${r['ok'] == true ? '✅' : '❌'} ${wsS(r['message'])}');
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _checkText = '❌ ${e.message}');
    }
  }

  Future<void> _fetchWarehouses() async {
    setState(() => _checkText = '正在拉取聚水潭分仓列表…');
    try {
      final r = await ApiService.jstWarehouses();
      if (!mounted) return;
      if (r['ok'] != true) {
        setState(() => _checkText = '❌ ${wsS(r['message'], fallback: '拉取失败')}');
        return;
      }
      final list = ((r['warehouses'] as List?) ?? const []).whereType<Map>().toList();
      setState(() {
        for (final w in list) {
          final co = wsS(w['co_id']);
          if (co.isEmpty) continue;
          _whOpts[co] = wsS(w['name'], fallback: co); // 拉到的名字覆盖旧的，勾选保持不变
        }
        _checkText = '✅ 拉到 ${list.length} 个聚水潭分仓；勾选后点「保存设置」';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _checkText = '❌ ${e.message}');
    }
  }

  Future<void> _run(bool dry) async {
    final ok = await wsConfirm(
      context,
      title: dry ? '只导出试跑' : '立即执行',
      message: dry
          ? '只导出试跑：会真的去聚水潭导出文件，但不会在本分仓建出库单。继续？'
          : '立即执行：按当前设置导出并直接在本分仓建出库单。继续？',
    );
    if (!ok || !mounted) return;
    try {
      final r = await ApiService.jstRun(doImport: !dry);
      if (!mounted) return;
      wsToast(context, wsS(r['message'], fallback: '已开始执行'));
      setState(() {
        _statusMap = {
          'running': true,
          'warehouse': wsS(r['warehouse']),
          'step': '已启动',
          'trigger': dry ? '手动试跑' : '手动',
          'started_at': _nowStr(),
        };
      });
      _startPoll();
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '启动失败：${e.message}', error: true);
    }
  }

  Future<void> _refreshStatus() async {
    try {
      final st = await ApiService.jstStatus();
      if (!mounted) return;
      setState(() => _statusMap = st);
      if (st['running'] == true) {
        _startPoll();
      } else {
        _loadHistory();
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '读取状态失败：${e.message}', error: true);
    }
  }

  /// 忽略一条待办。后端 id 是字符串（如 pt-unmapped-20261005123456），
  /// jstDismissPending(int) 会把它转成 0 打不中，这里走通用 post 按原样拼路径。
  /// 「补关联 / 重新匹配」两个重动作本轮未做（弹层表单较重），需要时人工去「聚水潭关联」页处理。
  Future<void> _dismissPending(String id) async {
    try {
      await ApiService.post('/api/jst-auto/pending/${Uri.encodeComponent(id)}/dismiss');
      if (!mounted) return;
      setState(() {
        _pending = _pending.where((t) => wsS(t['id']) != id).toList();
        if (_pendingCount > 0) _pendingCount--;
      });
      wsToast(context, '已忽略该待办');
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, '忽略失败：${e.message}', error: true);
    }
  }

  static String _pendingTypeLabel(String type) => type == 'unmapped' ? '新商品没规则' : '要验证码';

  // ------------------------------------------------ 渲染

  static Color _lineColor(String line) {
    if (line.startsWith('⚠')) return WsTokens.amber;
    if (line.startsWith('❌')) return WsTokens.red;
    if (line.startsWith('✅')) return WsTokens.green;
    return WsTokens.mutedLight;
  }

  Widget _globalCard() {
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          WsCardHead(
            title: '自动出库设置',
            icon: SolarIconsOutline.scooter,
            trailing: Text('设置按分仓隔离，当前分仓：$_whName',
                style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ),
          const Text(
            '定时从聚水潭自动导出销售出库单（xlsx），下载后直接在当前分仓建出库单。'
            '下面账号区是所有分仓共用的全局配置。',
            style: TextStyle(fontSize: 12.5, height: 1.6),
          ),
          const SizedBox(height: 10),
          const Text('聚水潭账号（所有分仓共用）',
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 14,
            runSpacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DesktopLabeled(
                label: '账号',
                child: DesktopTextField(controller: _account, width: 160, hintText: '登录 erp321 的账号'),
              ),
              DesktopLabeled(
                label: '密码',
                child: DesktopTextField(
                  controller: _password,
                  width: 160,
                  obscureText: true,
                  hintText: _hasPassword ? '已设置（留空 = 不修改）' : '留空 = 不修改',
                ),
              ),
              DesktopLabeled(
                label: '主账号 co_id',
                child: DesktopTextField(controller: _owner, width: 120, hintText: '默认 13662884'),
              ),
              DesktopLabeled(
                label: '请求间隔（秒）',
                child: DesktopTextField(
                  controller: _minInterval,
                  width: 72,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                ),
              ),
              DesktopLabeled(
                label: '超时（秒）',
                child: DesktopTextField(
                  controller: _timeout,
                  width: 72,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                ),
              ),
              DesktopLabeled(
                label: '重试次数',
                child: DesktopTextField(
                  controller: _retries,
                  width: 60,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          DesktopLabeled(
            label: 'Cookie（可选）',
            child: DesktopTextField(
              controller: _cookie,
              width: 360,
              maxLines: 2,
              hintText: '留空 = 用账号密码自动登录；也可粘贴浏览器里 erp321 的 Cookie',
            ),
          ),
          const SizedBox(height: 4),
          Text(
            _hasCookie
                ? '已保存 Cookie（$_cookieLen 字符），留空 = 继续用它；点「清空 Cookie」可删除'
                : '还没保存 Cookie：填好账号密码保存后，执行时会自动登录并把 Cookie 存下来',
            style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight, height: 1.5),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 14,
            runSpacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DesktopLabeled(
                label: '待办通知 webhook',
                child: DesktopTextField(
                  controller: _webhook,
                  width: 300,
                  hintText: '企业微信 / 钉钉机器人、Server酱、Bark 的地址',
                ),
              ),
              DesktopLabeled(
                label: '弹窗提醒的账号',
                child: DesktopTextField(
                  controller: _notifyUsers,
                  width: 200,
                  hintText: '如 小王,老孔；留空 = 所有管理员',
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: [
              DesktopButton(
                label: '保存设置',
                icon: SolarIconsOutline.diskette,
                kind: DesktopButtonKind.success,
                onPressed: _busy ? null : () => _save(),
              ),
              DesktopButton(label: '检查登录态', onPressed: () => _checkLogin()),
              DesktopButton(label: '拉取聚水潭分仓列表', onPressed: () => _fetchWarehouses()),
              DesktopButton(
                label: '清空 Cookie',
                onPressed: _busy ? null : () => _save(clearCookie: true),
              ),
            ],
          ),
          if (_checkText.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(_checkText,
                style: TextStyle(
                    fontSize: 12.5, height: 1.5, color: _lineColor(_checkText))),
          ],
        ],
      ),
    );
  }

  Widget _statusSection() {
    final lines = _statusLines();
    final jump = _statusJump();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 10),
        if (lines.isEmpty)
          const Text('还没有执行记录',
              style: TextStyle(fontSize: 12.5, color: WsTokens.mutedLight))
        else
          for (final l in lines)
            Text(l,
                style: TextStyle(
                    fontSize: 12.5, height: 1.7, color: _lineColor(l))),
        if (jump != null) ...[
          const SizedBox(height: 6),
          Row(
            children: [
              DesktopButton(
                label: '▸ 去出库记录看这批单（${jump.from} ~ ${jump.to}）',
                small: true,
                onPressed: () => widget.onNavigate('/outbound'),
              ),
              const SizedBox(width: 8),
              const Flexible(
                child: Text('出库记录默认只看今天，记得把日期改到这天',
                    style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
              ),
            ],
          ),
        ],
      ],
    );
  }

  Widget _whCard() {
    final fixedWarn = _fixedFrom.isNotEmpty && _fixedTo.isNotEmpty;
    Widget windowInfo = const Text('关于区间规则',
        style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight));
    if (_windowHelp.isNotEmpty) windowInfo = Tooltip(message: _windowHelp, child: windowInfo);
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const WsCardHead(
            title: '本分仓的自动出库',
            icon: SolarIconsOutline.clockCircle,
            trailing: Text('勾选要从哪些聚水潭分仓导出、导出哪个时间段、每天几点执行',
                style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ),
          Wrap(
            spacing: 14,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              _CheckLine(
                label: '启用定时自动出库',
                value: _enabled,
                onChanged: (v) => setState(() => _enabled = v),
                tip: '关闭后不再定时执行，仍可手动「立即执行一次」',
              ),
              Text(_nextRunsText,
                  style: TextStyle(
                      fontSize: 12, height: 1.5, color: _lineColor(_nextRunsText))),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 20,
            runSpacing: 12,
            crossAxisAlignment: WrapCrossAlignment.start,
            children: [
              DesktopLabeled(
                label: '要导入本分仓的聚水潭分仓',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    DesktopCheckList<String>(
                      options: [
                        for (final e in _whOpts.entries)
                          DesktopOption<String>(e.key, '${e.value}（${e.key}）'),
                      ],
                      selected: _pickedTargets,
                      onToggle: (v, on) => setState(() {
                        if (on) {
                          _pickedTargets.add(v);
                        } else {
                          _pickedTargets.remove(v);
                        }
                      }),
                    ),
                    if (_whOpts.isEmpty)
                      const Padding(
                        padding: EdgeInsets.only(top: 6),
                        child: Text('先点「拉取聚水潭分仓列表」',
                            style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
                      ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  DesktopLabeled(
                    label: '导出时间段',
                    child: DesktopSelect<String>(
                      value: _window,
                      width: 240,
                      options: _windowOptions,
                      onChanged: (v) => setState(() => _window = v ?? 'yesterday'),
                    ),
                  ),
                  const SizedBox(height: 4),
                  windowInfo,
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 20,
            runSpacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DesktopLabeled(
                label: '固定区间（补数据 / 试跑用）',
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _JstDateTimeBox(
                      value: _fixedFrom,
                      onChanged: (v) => setState(() => _fixedFrom = v),
                    ),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 6),
                      child: Text('-'),
                    ),
                    _JstDateTimeBox(
                      value: _fixedTo,
                      onChanged: (v) => setState(() => _fixedTo = v),
                    ),
                    if (fixedWarn)
                      const Padding(
                        padding: EdgeInsets.only(left: 8),
                        child: Text('　⚠ 已填固定区间，将覆盖上面的时间段规则',
                            style: TextStyle(fontSize: 11.5, color: WsTokens.amber)),
                      ),
                  ],
                ),
              ),
              DesktopLabeled(
                label: '定时时间',
                child: DesktopTextField(
                  controller: _schedule,
                  width: 220,
                  hintText: '07:30,19:30',
                ),
              ),
              DesktopLabeled(
                label: '随机浮动（分钟）',
                child: DesktopTextField(
                  controller: _jitter,
                  width: 72,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  hintText: '0~120',
                ),
              ),
              DesktopLabeled(
                label: '操作员',
                child: DesktopTextField(
                    controller: _operator, width: 130, hintText: '留空 = 用第一个管理员账号'),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text('定时时间逗号分隔；可写 HH:MM:区间规则 单独指定区间（如 07:30:yesterday、19:30:today），留空 = 不定时执行',
              style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
          const SizedBox(height: 10),
          Wrap(
            spacing: 14,
            runSpacing: 8,
            children: [
              _CheckLine(
                label: '下载后直接建出库单',
                value: _autoImport,
                onChanged: (v) => setState(() => _autoImport = v),
                tip: '不勾选则只下载 xlsx，不建出库单',
              ),
              _CheckLine(
                label: '跳过已导入过的单据号',
                value: _skipImported,
                onChanged: (v) => setState(() => _skipImported = v),
                tip: '按出库单号跳过已导入过的单据，避免重复建单',
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: [
              DesktopButton(
                label: '保存设置',
                icon: SolarIconsOutline.diskette,
                kind: DesktopButtonKind.success,
                onPressed: _busy ? null : () => _save(),
              ),
              DesktopButton(
                label: '立即执行一次（导出并建单）',
                onPressed: _busy ? null : () => _run(false),
              ),
              DesktopButton(
                label: '只导出试跑（不建单）',
                onPressed: _busy ? null : () => _run(true),
              ),
              DesktopButton(label: '刷新状态', icon: SolarIconsOutline.refresh, onPressed: _refreshStatus),
            ],
          ),
          _statusSection(),
        ],
      ),
    );
  }

  Widget _pendingCard() {
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const WsCardHead(
            title: '待办处理',
            icon: SolarIconsOutline.dangerTriangle,
            trailing: Text('商品资料待补全 / 需要验证码；本轮桌面端先支持「忽略」，补关联请到「聚水潭关联」页',
                style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
          ),
          for (final t in _pending)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  DesktopTag(_pendingTypeLabel(wsS(t['type'])),
                      color: wsS(t['type']) == 'unmapped' ? WsTokens.amber : WsTokens.red),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(wsS(t['message']), style: const TextStyle(fontSize: 12.5)),
                        Text('${wsS(t['id'])} · ${wsS(t['created_at'])}',
                            style: const TextStyle(fontSize: 11, color: WsTokens.mutedLight)),
                      ],
                    ),
                  ),
                  DesktopLink('忽略', onPressed: () => _dismissPending(wsS(t['id']))),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _histNoteCell(Map<String, dynamic> r) {
    final s = ((r['stats'] as Map?) ?? const {}).cast<String, dynamic>();
    final files = ((r['files'] as List?) ?? const []).map(wsS).join('、');
    final unmapped = (s['unmapped'] as List?) ?? const [];
    final failed = (s['failed'] as List?) ?? const [];
    final sub = [
      if (files.isNotEmpty) files,
      if (unmapped.isNotEmpty) '未关联 ${unmapped.length} 种',
      if (failed.isNotEmpty) '失败 ${failed.length} 条',
    ].join('；');
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        wsCell(wsS(r['message'], fallback: '—')),
        if (sub.isNotEmpty)
          Text(sub,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
      ],
    );
  }

  Widget _historyCard() {
    return WsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WsCardHead(
            title: '执行记录',
            icon: SolarIconsOutline.history,
            trailing: DesktopButton(label: '刷新', icon: SolarIconsOutline.refresh, onPressed: _loadHistory),
          ),
          DesktopGrid(
            cols: const [
              DesktopCol('时间', width: 140),
              DesktopCol('触发', width: 110),
              DesktopCol('结果', width: 70),
              DesktopCol('导出区间', width: 200),
              DesktopCol('建单', width: 70, right: true),
              DesktopCol('跳过重复', width: 90, right: true),
              DesktopCol('文件 · 说明', width: 380),
            ],
            rows: [
              for (final r in _runs)
                DesktopRow(
                  cells: [
                    wsCell(wsS(r['at'])),
                    wsCell(wsS(r['trigger'])),
                    r['ok'] == true
                        ? const DesktopTag('成功', color: WsTokens.green)
                        : const DesktopTag('失败', color: WsTokens.red),
                    wsCell(wsS(r['window'])),
                    wsCell((r['stats'] is Map && (r['stats'] as Map)['created'] != null)
                        ? wsS((r['stats'] as Map)['created'])
                        : '—'),
                    wsCell((r['stats'] is Map && (r['stats'] as Map)['duplicate_skipped'] != null)
                        ? wsS((r['stats'] as Map)['duplicate_skipped'])
                        : '—'),
                    _histNoteCell(r),
                  ],
                ),
            ],
            rowHeight: 48,
            emptyText: '还没有执行记录',
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return DesktopStateView(
      loading: _loading,
      error: _error,
      onRetry: _load,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_pendingCount > 0) ...[
            DesktopNotice('⚠ 有 $_pendingCount 项待办要处理', kind: DesktopNoticeKind.warn),
            _pendingCard(),
          ],
          _globalCard(),
          _whCard(),
          _historyCard(),
        ],
      ),
    );
  }
}

// ================================================================ F 模块显示（web renderNavModulesPanel）

/// 侧边栏条目的稳定标识：与壳层显隐过滤共用 [desktopNavModKey]（nav_model）。
String _navModKey(DesktopNavItem item) => desktopNavModKey(item);

/// 「设置」入口固定显示，不可隐藏（web applyNavVisibility 的 locked）。
bool _navLocked(DesktopNavItem item) => desktopNavLocked(item);

class _ModulesPanel extends StatefulWidget {
  const _ModulesPanel({required this.auth});
  final AuthProvider auth;

  @override
  State<_ModulesPanel> createState() => _ModulesPanelState();
}

class _ModulesPanelState extends State<_ModulesPanel> {
  /// 偏好本身存在 [DesktopNavVisibility]（web NAV_HIDDEN_KEY 同款语义：
  /// 隐藏项 key 的 JSON 数组，按分仓隔离），壳层监听同一对象过滤侧边栏。
  final DesktopNavVisibility _nav = DesktopNavVisibility.instance;

  Set<String> get _hidden => _nav.hidden;

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    await _nav.load(widget.auth.warehouseKey);
    if (mounted) setState(() {});
  }

  Future<void> _persist() => _nav.save(widget.auth.warehouseKey, _hidden);

  void _toggle(String key, bool visible) {
    setState(() {
      if (visible) {
        _nav.hidden.remove(key);
      } else {
        _nav.hidden.add(key);
      }
    });
    _persist();
    wsToast(context, visible ? '已显示该模块' : '已隐藏该模块');
  }

  void _reset() {
    _nav.hidden.clear();
    setState(() {});
    _persist();
    wsToast(context, '已恢复显示全部模块');
  }

  @override
  Widget build(BuildContext context) {
    final whName = widget.auth.warehouseName.isEmpty ? '未指定分仓' : widget.auth.warehouseName;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        WsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              WsCardHead(
                title: '模块显示调整',
                icon: SolarIconsOutline.sidebar,
                trailing: DesktopButton(label: '恢复显示全部', icon: SolarIconsOutline.refresh, onPressed: _reset),
              ),
              const Text(
                '勾选需要在左侧侧边栏显示的功能（如 入仓 / 鲜货现采 等）；'
                '设置按分仓独立保存在本机，下次打开自动生效。',
                style: TextStyle(fontSize: 12, height: 1.6, color: WsTokens.mutedLight),
              ),
            ],
          ),
        ),
        for (final sec in kDesktopNav)
          WsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                WsCardHead(
                  title: sec.title.isEmpty ? '其他' : sec.title,
                  trailing: const Text('勾选后在侧边栏显示',
                      style: TextStyle(fontSize: 12, color: WsTokens.mutedLight)),
                ),
                Wrap(
                  spacing: 18,
                  runSpacing: 6,
                  children: [
                    for (final it in sec.items)
                      if (_navLocked(it))
                        // 「设置」入口锁定常显（web locked），避免把自己藏掉回不来
                        _CheckLine(
                          label: it.title,
                          value: true,
                          enabled: false,
                          tip: '设置入口固定显示，不可隐藏',
                        )
                      else
                        _CheckLine(
                          label: it.title,
                          value: !_hidden.contains(_navModKey(it)),
                          onChanged: (v) => _toggle(_navModKey(it), v),
                        ),
                  ],
                ),
              ],
            ),
          ),
        Text(
          '当前分仓：$whName。显隐设置按分仓各自独立保存，切换分仓后互不影响；'
          '隐藏只影响左侧菜单的显示，不影响数据与权限；「设置」入口始终保留，方便随时回来调整。',
          style: const TextStyle(fontSize: 12, height: 1.6, color: WsTokens.mutedLight),
        ),
      ],
    );
  }
}
