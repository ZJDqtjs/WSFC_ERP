import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../services/ai_submit.dart';
import '../../services/api_service.dart';
import '../mobile_style.dart';
import '../widgets/mobile_page.dart';
import '../widgets/parts.dart';

/// 工作台「智能录入」二级页：文本 / 票据照片 → 后端 AI 识别 → 核对 → 落单。
///
/// 识别结果不直接写库：先摊开成可改的确认卡（数量、单价、付款状态），
/// 用户点提交才走 [AiSubmit]（新物品建档 + 按业务类型分单），口径与网页端一致。
class AiEntryScreen extends StatefulWidget {
  const AiEntryScreen({super.key, this.initialText = '', this.pickImageFirst = false});

  /// 工作台输入框里已经敲好的内容，带进来直接识别。
  final String initialText;

  /// 从「拍单识别」进来：落地即弹拍照/相册选择，省一步点击。
  final bool pickImageFirst;

  @override
  State<AiEntryScreen> createState() => _AiEntryScreenState();
}

class _AiEntryScreenState extends State<AiEntryScreen> {
  final _text = TextEditingController();
  bool _busy = false;
  String _stage = '';
  String? _error;
  _AiDoc? _doc;

  @override
  void initState() {
    super.initState();
    _text.text = widget.initialText;
    if (widget.pickImageFirst || widget.initialText.trim().isNotEmpty) {
      // 等这一帧布局完再发起，否则 build 里 setState 会抛
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        if (widget.pickImageFirst) {
          _pickAndParse();
        } else {
          _parseText();
        }
      });
    }
  }

  @override
  void dispose() {
    _text.dispose();
    _doc?.dispose();
    super.dispose();
  }

  Future<void> _run(Future<Map<String, dynamic>> Function() call) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _stage = '识别中…';
      _doc?.dispose();
      _doc = null;
    });
    try {
      final raw = await call();
      if (!mounted) return;
      setState(() => _doc = _AiDoc(raw));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _parseText() async {
    final t = _text.text.trim();
    if (t.isEmpty) {
      setState(() => _error = '请先输入或粘贴要识别的内容');
      return;
    }
    await _run(() => ApiService.aiParse(t));
  }

  Future<void> _pickAndParse() async {
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('拍照'),
              onTap: () => Navigator.pop(context, ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('从相册选择'),
              onTap: () => Navigator.pop(context, ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (source == null) return;
    final picked = await ImagePicker().pickImage(
      source: source,
      maxWidth: 1600,
      imageQuality: 88,
    );
    if (picked == null) return;
    await _run(
      () => ApiService.aiParseImage(picked.path, text: _text.text.trim(), onStage: (s) {
        if (mounted) setState(() => _stage = s);
      }),
    );
  }

  Future<void> _submit() async {
    final doc = _doc;
    if (doc == null || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _stage = '提交中…';
    });
    try {
      final n = await AiSubmit.doc(doc.toResult());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已录入 $n 行'), backgroundColor: Colors.green.shade600),
      );
      context.pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = '提交失败：${e.message}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return MobilePage(
      title: '智能录入',
      subtitle: '说一句话或拍张票据，自动识别成入库 / 出库 / 盘点',
      back: true,
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 28),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            GCard(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: _text,
                      minLines: 3,
                      maxLines: 6,
                      decoration: const InputDecoration(
                        hintText: '例如：今天入库 100 斤木耳，25 一斤；或出库 2 单七彩土豆 3 斤，每单 15 元\n'
                            '拍单识别时，这里可以写补充说明，如「京东8号->8号纸箱」',
                        hintStyle: TextStyle(fontSize: 13, color: Mc.inkThird, height: 1.5),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: FilledButton.icon(
                            onPressed: _busy ? null : _parseText,
                            icon: const Icon(Icons.auto_awesome, size: 18),
                            label: const Text('识别并录入'),
                            style: FilledButton.styleFrom(
                              backgroundColor: Mc.brand,
                              padding: const EdgeInsets.symmetric(vertical: 12),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _busy ? null : _pickAndParse,
                            icon: const Icon(Icons.photo_camera_outlined, size: 18),
                            label: const Text('拍单识别'),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: Mc.fresh,
                              padding: const EdgeInsets.symmetric(vertical: 12),
                            ),
                          ),
                        ),
                      ],
                    ),
                    if (_busy)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: Row(
                          children: [
                            const SizedBox(
                              width: 14,
                              height: 14,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(_stage,
                                  style: const TextStyle(fontSize: 12, color: Mc.inkSecond)),
                            ),
                          ],
                        ),
                      ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: Text(_error!,
                            style: const TextStyle(fontSize: 12.5, color: Mc.danger)),
                      ),
                  ],
                ),
              ),
            ),
            if (_doc != null) _buildConfirm(_doc!),
          ],
        ),
      ),
    );
  }

  Widget _buildConfirm(_AiDoc doc) {
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: GCard(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('识别结果：${doc.typeLabel}',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                  const Spacer(),
                  Text(doc.date, style: const TextStyle(fontSize: 12, color: Mc.inkSecond)),
                ],
              ),
              if (doc.party.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('${doc.partyLabel}：${doc.party}',
                      style: const TextStyle(fontSize: 12.5, color: Mc.inkSecond)),
                ),
              if (doc.remark.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('备注：${doc.remark}',
                      style: const TextStyle(fontSize: 12.5, color: Mc.inkSecond)),
                ),
              const SizedBox(height: 10),
              for (final line in doc.lines) _buildLine(line, doc),
              if (doc.isOutbound || doc.isInbound)
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: doc.paid,
                  title: const Text('已付款', style: TextStyle(fontSize: 13.5)),
                  subtitle: Text(
                    doc.paid ? '直接计入财务报表' : '先进「待付款」账单，标记已付后才计入报表',
                    style: const TextStyle(fontSize: 11.5),
                  ),
                  onChanged: doc.setPaid,
                ),
              const SizedBox(height: 8),
              SizedBox(
                height: 44,
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _busy ? null : _submit,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Mc.brand,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                  ),
                  child: Text('确认${doc.typeLabel}', style: const TextStyle(fontSize: 16)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildLine(_AiLine line, _AiDoc doc) {
    final isStocktake = doc.isStocktake;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Text(
                  line.name.isEmpty ? '（未识别到名称）' : line.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 64,
                child: FormCell(
                  label: isStocktake ? '增减' : '数量',
                  child: CellInput(
                    controller: line.qty,
                    keyboardType: const TextInputType.numberWithOptions(signed: true, decimal: true),
                  ),
                ),
              ),
              if (!isStocktake) ...[
                const SizedBox(width: 8),
                SizedBox(
                  width: 70,
                  child: FormCell(
                    label: doc.isInbound ? '单价' : '售价',
                    child: CellInput(
                      controller: line.price,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    ),
                  ),
                ),
              ],
            ],
          ),
          if (line.hint.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(line.hint,
                  style: const TextStyle(fontSize: 11.5, color: Mc.inkThird, height: 1.4)),
            ),
        ],
      ),
    );
  }
}

/// 一次识别出来的单据。数量/单价用 controller 承载，改完在 [toResult] 里回填。
class _AiDoc {
  _AiDoc(this.raw) {
    lines = [
      for (final e in (raw['lines'] as List? ?? const []))
        _AiLine(Map<String, dynamic>.from(e as Map)),
    ];
  }

  final Map<String, dynamic> raw;
  late final List<_AiLine> lines;
  bool paid = true;

  String get type => (raw['type'] ?? '').toString();
  bool get isStocktake => type == 'stocktake';
  bool get isOutbound => type == 'outbound';
  bool get isInbound => type == 'inbound';
  String get typeLabel => switch (type) {
        'inbound' => '入库',
        'outbound' => '出库',
        'stocktake' => '盘点',
        _ => '单据',
      };
  String get date => (raw['date'] ?? '').toString();
  String get remark => (raw['remark'] ?? '').toString();
  String get party =>
      (isOutbound ? raw['customer'] : isInbound ? raw['supplier'] : '').toString();
  String get partyLabel => isOutbound ? '客户' : '供应商';

  void setPaid(bool v) => paid = v;

  void dispose() {
    for (final l in lines) {
      l.dispose();
    }
  }

  /// 把用户改过的数量/单价与付款状态写回识别结果，交给 [AiSubmit] 落单。
  Map<String, dynamic> toResult() {
    final out = Map<String, dynamic>.from(raw);
    out['lines'] = [for (final l in lines) l.apply(paid)];
    return out;
  }
}

class _AiLine {
  _AiLine(this.raw)
      : qty = TextEditingController(text: _plain(raw['quantity'])),
        price = TextEditingController(text: _plain(raw['unit_price']));

  final Map<String, dynamic> raw;
  final TextEditingController qty;
  final TextEditingController price;

  String get name => (raw['product_name'] ?? raw['recognized_name'] ?? '').toString();
  String get hint => (raw['hint'] ?? '').toString();

  Map<String, dynamic> apply(bool paid) {
    final out = Map<String, dynamic>.from(raw);
    final q = double.tryParse(qty.text.trim());
    final p = double.tryParse(price.text.trim());
    if (q != null) {
      out['quantity'] = q;
      if (out.containsKey('stock_adjust')) out['stock_adjust'] = q;
    }
    if (p != null) out['unit_price'] = p;
    out['paid'] = paid;
    return out;
  }

  void dispose() {
    qty.dispose();
    price.dispose();
  }

  static String _plain(dynamic v) {
    if (v is num) {
      return v == v.roundToDouble() ? v.toInt().toString() : v.toString();
    }
    return (v ?? '').toString();
  }
}
