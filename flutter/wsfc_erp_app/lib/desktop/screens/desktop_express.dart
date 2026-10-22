import 'package:flutter/material.dart';

import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../desktop_style.dart';
import '../widgets/desktop_motion.dart';
import '../widgets/desktop_ui.dart';
import '../widgets/ws_card.dart';
import 'package:solar_icons/solar_icons.dart';

/// 桌面端「快递费」页：1:1 复刻 web `#page-express`。
///
/// 这是一份单例 JSON 配置：GET /api/express/rule 读、PUT 写（实时生效）。
/// 计费口径全部以后端 backend/app/routers/express.py + app.js exprFee 为准：
///   tiered（首重+续重）：fee = first + ceil(max(0, 毛重-1)) × per_extra（不取整时用实际差值）
///   flat（每 kg 单价）：  fee = 毛重 × rate
class DesktopExpressScreen extends StatefulWidget {
  const DesktopExpressScreen({super.key, required this.auth, required this.onNavigate});

  final AuthProvider auth;
  final void Function(String route) onNavigate;

  @override
  State<DesktopExpressScreen> createState() => _DesktopExpressScreenState();
}

/// 数字输入（金额允许小数）
const TextInputType _kNum = TextInputType.numberWithOptions(decimal: true);

/// 整单毛重口径（后端 build_order 写死：商品净重之和 + 每单箱体 0.1kg）
const String _kWeightHint =
    '整单毛重 = 商品净重之和 + 每单箱体 0.1kg';

double _parse(TextEditingController c) => wsD(double.tryParse(c.text.trim()));

/// 预览档位：1 / 2 / 3 / 5 / 10 kg
const List<int> _kPreviewWeights = [1, 2, 3, 5, 10];

class _DesktopExpressScreenState extends State<DesktopExpressScreen> {
  final TextEditingController _firstCtrl = TextEditingController();
  final TextEditingController _extraCtrl = TextEditingController();
  final TextEditingController _rateCtrl = TextEditingController();

  String _mode = 'tiered';
  bool _roundUp = true;
  bool _loading = true;
  String? _error;
  String _info = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _firstCtrl.dispose();
    _extraCtrl.dispose();
    _rateCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await ApiService.expressRule();
      if (!mounted) return;
      setState(() {
        _mode = wsS(data['mode']) == 'flat' ? 'flat' : 'tiered';
        _roundUp = (data['round_up'] as bool?) ?? true;
        _firstCtrl.text = _numText(wsD(data['first_kg_fee'], fallback: 3.6));
        _extraCtrl.text = _numText(wsD(data['per_extra_kg'], fallback: 1));
        _rateCtrl.text = _numText(wsD(data['rate_per_kg'], fallback: 3.6));
        _info = '已加载当前计费规则';
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载规则失败：${e.message}';
        _loading = false;
      });
      wsToast(context, e.message, error: true);
    }
  }

  /// 整数不带小数点，0 显示空（与网页输入框一致）
  String _numText(double v) {
    if (v == 0) return '';
    return v == v.roundToDouble() ? v.toStringAsFixed(0) : '$v';
  }

  /// 照后端 exprFee 的公式：flat = w × rate；tiered = first + over × per_extra
  double _feeFor(double w) {
    if (_mode == 'flat') {
      return ((w * _parse(_rateCtrl)) * 100).roundToDouble() / 100;
    }
    double over = w - 1;
    if (over < 0) over = 0;
    if (_roundUp && over > 0) over = over.ceilToDouble();
    return ((_parse(_firstCtrl) + over * _parse(_extraCtrl)) * 100).roundToDouble() / 100;
  }

  Future<void> _save() async {
    // 校验：当前模式涉及的字段必须是可解析且 ≥0 的数字（对齐 saveExpressRule）
    final raw = _mode == 'tiered' ? [_firstCtrl.text, _extraCtrl.text] : [_rateCtrl.text];
    final bad = raw.any((t) => double.tryParse(t.trim()) == null || double.parse(t.trim()) < 0);
    if (bad) {
      wsToast(context, '请填写正确的费用（≥0）', error: true);
      return;
    }
    final body = <String, dynamic>{
      'mode': _mode,
      'first_kg_fee': _parse(_firstCtrl),
      'per_extra_kg': _parse(_extraCtrl),
      'rate_per_kg': _parse(_rateCtrl),
      'round_up': _roundUp,
    };
    try {
      await ApiService.saveExpressRule(body);
      await _load(); // 保存后回读一次配置
      if (!mounted) return;
      setState(() => _info = '已保存，实时生效');
      wsToast(context, '快递费规则已保存');
    } on ApiException catch (e) {
      if (!mounted) return;
      wsToast(context, e.message, error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = wsIsDark(context);
    return DesktopPage(
      title: '快递费规则',
      subtitle: '出库时按「整单毛重」自动计算快递费并计入销售成本；$_kWeightHint，商品净重由「扣减库存量」推导（重量类）。',
      body: DesktopStateView(
        loading: _loading,
        error: _error,
        onRetry: _load,
        loadingText: '加载计费规则…',
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            const DesktopRise(
              index: 0,
              child: DesktopNotice(
                '这一份计费配置会影响出库单的自动快递费行：出库时系统按「整单毛重」算出快递费，'
                '作为一条快递成本写进销售成本，实时生效。',
              ),
            ),
            DesktopRise(
              index: 1,
              child: WsCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const WsCardHead(title: '计费方式', icon: SolarIconsOutline.scooter),
                    Wrap(
                      spacing: 20,
                      runSpacing: 16,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        DesktopLabeled(
                          label: '计费模式',
                          child: DesktopSelect<String>(
                            width: 240,
                            value: _mode,
                            options: const [
                              DesktopOption('tiered', '首重 + 续重（1kg 内多少钱，每超 1kg 加收）'),
                              DesktopOption('flat', '每 kg 单价'),
                            ],
                            onChanged: (v) => setState(() => _mode = v ?? 'tiered'),
                          ),
                        ),
                        if (_mode == 'tiered') ...[
                          DesktopLabeled(
                            label: '1kg 以内（元）',
                            child: DesktopTextField(
                              controller: _firstCtrl,
                              width: 140,
                              hintText: '首重，如 3.6',
                              keyboardType: _kNum,
                              inputFormatters: DesktopTextField.decimalOnly,
                              onChanged: (_) => setState(() {}),
                            ),
                          ),
                          DesktopLabeled(
                            label: '每超 1kg 加收（元）',
                            child: DesktopTextField(
                              controller: _extraCtrl,
                              width: 140,
                              hintText: '续重，如 1',
                              keyboardType: _kNum,
                              inputFormatters: DesktopTextField.decimalOnly,
                              onChanged: (_) => setState(() {}),
                            ),
                          ),
                          _roundUpToggle(),
                        ] else
                          DesktopLabeled(
                            label: '每 1kg 单价（元）',
                            child: DesktopTextField(
                              controller: _rateCtrl,
                              width: 140,
                              hintText: '每 kg 单价',
                              keyboardType: _kNum,
                              inputFormatters: DesktopTextField.decimalOnly,
                              onChanged: (_) => setState(() {}),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        DesktopButton(
                          label: '保存计费规则',
                          icon: SolarIconsOutline.diskette,
                          kind: DesktopButtonKind.success,
                          onPressed: _save,
                        ),
                        const SizedBox(width: 10),
                        DesktopButton(label: '刷新', icon: SolarIconsOutline.refresh, onPressed: _load),
                        if (_info.isNotEmpty) ...[
                          const SizedBox(width: 14),
                          Text(_info,
                              style: const TextStyle(fontSize: 12.5, color: WsTokens.mutedLight)),
                        ],
                      ],
                    ),
                    const SizedBox(height: 10),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        '口径：$_kWeightHint（重量单位：kg）',
                        style: TextStyle(
                          fontSize: 12,
                          color: dark ? WsTokens.mutedDark : WsTokens.mutedLight,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            DesktopRise(
              index: 2,
              child: WsCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    WsCardHead(
                      title: '计费预览（毛重 = 净重 + 0.1kg 箱重）',
                      icon: SolarIconsOutline.eye,
                      trailing: Text(
                        _mode == 'flat' ? '每 kg 单价' : (_roundUp ? '首重+续重（续重整 kg 向上取整）' : '首重+续重（续重按实际差值）'),
                        style: const TextStyle(fontSize: 12, color: WsTokens.mutedLight),
                      ),
                    ),
                    DesktopGrid(
                      dense: true,
                      cols: const [
                        DesktopCol('毛重', width: 160),
                        DesktopCol('快递费', width: 160, right: true),
                      ],
                      rows: [
                        for (final w in _kPreviewWeights)
                          DesktopRow(
                            cells: [
                              wsCell('毛重 ${w}kg'),
                              wsCell(wsMoney(_feeFor(w.toDouble())), bold: true),
                            ],
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _roundUpToggle() {
    return InkWell(
      borderRadius: BorderRadius.circular(WsTokens.radius),
      onTap: () => setState(() => _roundUp = !_roundUp),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Checkbox(
              value: _roundUp,
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              onChanged: (v) => setState(() => _roundUp = v ?? true),
            ),
            const Text('续重按整 kg 向上取整', style: TextStyle(fontSize: 12.5)),
            const SizedBox(width: 6),
            const Text('（如 1.5kg 按 2kg 计费）',
                style: TextStyle(fontSize: 11.5, color: WsTokens.mutedLight)),
          ],
        ),
      ),
    );
  }
}
