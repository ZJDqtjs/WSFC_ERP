
import 'package:flutter/material.dart';

import '../services/api_service.dart';

/// 「规则设置」：分类扣点 / 店铺扣点 / 快递计费 / 打包规则 四合一。
///
/// 只用 ApiService 已有的静态方法；失败统一是 ApiException（message 就是后端
/// 返回的中文 detail），页面一律红色 SnackBar 原样展示，不再自己拼文案。
class RulesScreen extends StatefulWidget {
  const RulesScreen({super.key});

  @override
  State<RulesScreen> createState() => _RulesScreenState();
}

class _RulesScreenState extends State<RulesScreen> with SingleTickerProviderStateMixin {
  static const List<String> _titles = <String>['分类扣点', '店铺扣点', '快递计费', '打包规则'];

  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: _titles.length, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('规则设置'),
        centerTitle: true,
        bottom: TabBar(
          controller: _tabController,
          isScrollable: true,
          tabs: <Widget>[
            for (final String t in _titles) Tab(text: t),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: const <Widget>[
          _CategoryDeductionTab(),
          _ShopDeductionTab(),
          _ExpressRuleTab(),
          _PackRuleTab(),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 通用工具与小组件
// ---------------------------------------------------------------------------

/// 换行符（避免源码里出现反斜杠写法，统一用字符码取）。
final String _nl = String.fromCharCode(10);

/// 异常 → 展示文案：后端 detail 已是中文，直接原样给出。
String _errorText(Object e) => e is ApiException ? e.message : '请求失败：$e';

String _textOf(dynamic v) => (v ?? '').toString();

double _doubleOf(dynamic v, [double fallback = 0]) {
  if (v is num) {
    return v.toDouble();
  }
  if (v is String) {
    return double.tryParse(v.trim()) ?? fallback;
  }
  return fallback;
}

int? _intOf(dynamic v) {
  if (v is num) {
    return v.toInt();
  }
  if (v is String) {
    return int.tryParse(v.trim());
  }
  return null;
}

bool _boolOf(dynamic v, {bool fallback = true}) {
  if (v is bool) {
    return v;
  }
  if (v is num) {
    return v != 0;
  }
  if (v is String) {
    return v == '1' || v.toLowerCase() == 'true';
  }
  return fallback;
}

Map<String, dynamic> _mapOf(dynamic v) =>
    v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

List<dynamic> _listOf(dynamic v) => v is List ? v : const <dynamic>[];

/// 数字显示：整数不带小数点，小数最多两位。null → blank。
String _numText(dynamic value, {String blank = '—'}) {
  if (value == null) {
    return blank;
  }
  final double d = _doubleOf(value);
  if (d == d.roundToDouble()) {
    return d.toStringAsFixed(0);
  }
  final String s = d.toStringAsFixed(2);
  if (s.endsWith('0')) {
    return s.substring(0, s.length - 1);
  }
  return s;
}

String _pctText(dynamic value, {String blank = '0'}) => '${_numText(value, blank: blank)}%';

String _moneyText(dynamic value) => '¥${_numText(value, blank: '0')}';

/// 删除类操作统一走二次确认 Dialog。
Future<bool> _confirmDialog(BuildContext context, {required String title, required String message}) async {
  final bool? ok = await showDialog<bool>(
    context: context,
    builder: (BuildContext ctx) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: <Widget>[
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
        TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确认删除')),
      ],
    ),
  );
  return ok ?? false;
}

/// 页签顶部/底部的小字说明。
class _Hint extends StatelessWidget {
  const _Hint(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(fontSize: 12, color: Colors.grey),
    );
  }
}

/// 空数据占位。
class _EmptyBox extends StatelessWidget {
  const _EmptyBox(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 56, 24, 32),
      child: Column(
        children: <Widget>[
          const Icon(Icons.inbox_outlined, size: 40, color: Colors.grey),
          const SizedBox(height: 10),
          Text(text, textAlign: TextAlign.center, style: const TextStyle(fontSize: 13, color: Colors.grey)),
        ],
      ),
    );
  }
}

/// 小圆角标签（启用/停用、箱型、人工等）。
class _Tag extends StatelessWidget {
  const _Tag({required this.text, this.color = const Color(0xFF1989FA)});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(text, style: TextStyle(fontSize: 11, color: color)),
    );
  }
}

/// 表单内联错误条（除了 SnackBar，再就地提示一次，方便对着字段改）。
class _ErrorBox extends StatelessWidget {
  const _ErrorBox(this.text);

  final String? text;

  @override
  Widget build(BuildContext context) {
    final String msg = text ?? '';
    if (msg.isEmpty) {
      return const SizedBox.shrink();
    }
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF1F0),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFFFFC7C2)),
      ),
      child: Text(msg, style: const TextStyle(fontSize: 12.5, color: Color(0xFFD4380D))),
    );
  }
}

/// 列表类页签的通用外壳：下拉刷新 + 加载中占位。
class _TabBody extends StatelessWidget {
  const _TabBody({
    required this.loading,
    required this.onRefresh,
    required this.header,
    required this.children,
  });

  final bool loading;
  final Future<void> Function() onRefresh;
  final Widget header;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 28),
        children: <Widget>[
          header,
          ...children,
        ],
      ),
    );
  }
}

/// 列表页签顶部：说明文字 + 新增按钮。
class _Toolbar extends StatelessWidget {
  const _Toolbar({required this.tip, required this.label, required this.onAdd});

  final String tip;
  final String label;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(child: _Hint(tip)),
          const SizedBox(width: 8),
          OutlinedButton.icon(
            onPressed: onAdd,
            icon: const Icon(Icons.add, size: 18),
            label: Text(label),
            style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFF1989FA)),
          ),
        ],
      ),
    );
  }
}

/// 主按钮（保存/提交），带 loading 占位。
class _SubmitButton extends StatelessWidget {
  const _SubmitButton({required this.label, required this.busy, required this.onPressed});

  final String label;
  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 46,
      child: ElevatedButton(
        onPressed: busy ? null : onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: const Color(0xFF1989FA),
          foregroundColor: Colors.white,
        ),
        child: busy
            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
            : Text(label, style: const TextStyle(fontSize: 16)),
      ),
    );
  }
}

/// 数值输入框（费用/百分比/倍数都用它）。
class _NumField extends StatelessWidget {
  const _NumField({
    required this.controller,
    required this.label,
    this.suffix,
    this.helper,
    this.hint,
    this.validator,
  });

  final TextEditingController controller;
  final String label;
  final String? suffix;
  final String? helper;
  final String? hint;
  final String? Function(String?)? validator;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: controller,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      decoration: InputDecoration(
        labelText: label,
        suffixText: suffix,
        helperText: helper,
        hintText: hint,
        border: const OutlineInputBorder(),
      ),
      validator: validator,
    );
  }
}

// ---------------------------------------------------------------------------
// 页签 1：分类扣点（存 deductions 表，按类别名 upsert）
// ---------------------------------------------------------------------------

class _CategoryDeductionTab extends StatefulWidget {
  const _CategoryDeductionTab();

  @override
  State<_CategoryDeductionTab> createState() => _CategoryDeductionTabState();
}

class _CategoryDeductionTabState extends State<_CategoryDeductionTab> {
  List<dynamic> _rows = <dynamic>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final List<dynamic> data = await ApiService.deductions();
      if (!mounted) {
        return;
      }
      setState(() {
        _rows = data;
        _loading = false;
      });
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  void _fail(Object e) {
    if (!mounted) {
      return;
    }
    setState(() => _loading = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(_errorText(e)), backgroundColor: Colors.red),
    );
  }

  Future<void> _openSheet(dynamic row) async {
    final bool? saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) => _DeductionSheet(row: row),
    );
    if (saved == true) {
      _load();
    }
  }

  Future<void> _delete(dynamic row) async {
    final int? id = _intOf(row['id']);
    final String category = _textOf(row['category']);
    final bool ok = await _confirmDialog(
      context,
      title: '删除分类扣点',
      message: '确定删除「$category」的扣点规则？删除后批量导入 / 入库折算不再扣点。',
    );
    if (!ok || id == null) {
      return;
    }
    if (!mounted) {
      return;
    }
    try {
      await ApiService.deleteDeduction(id);
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已删除「$category」'), backgroundColor: Colors.green),
      );
      _load();
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _TabBody(
      loading: _loading,
      onRefresh: _load,
      header: _Toolbar(
        tip: '按商品类别设置入库扣点；批量导入解析「进货单价」时按 原价 ×（1 − 扣点%）折算入库成本。',
        label: '新增',
        onAdd: () => _openSheet(null),
      ),
      children: <Widget>[
        if (_rows.isEmpty)
          const _EmptyBox('暂无分类扣点规则，点右上角「新增」按商品类别添加（类别名唯一，重复提交即覆盖）')
        else
          for (final dynamic row in _rows) _rowCard(row),
      ],
    );
  }

  Widget _rowCard(dynamic row) {
    final String category = _textOf(row['category']);
    final String remark = _textOf(row['remark']);
    final String percent = _pctText(row['percent']);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        onTap: () => _openSheet(row),
        title: Text(category, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text('扣点 $percent${remark.isEmpty ? '' : ' · $remark'}',
            style: const TextStyle(fontSize: 12.5)),
        trailing: IconButton(
          tooltip: '删除',
          icon: const Icon(Icons.delete_outline, color: Colors.red),
          onPressed: () => _delete(row),
        ),
      ),
    );
  }
}

/// 分类扣点表单：类别名 + 百分比 + 备注。只有 POST upsert，没有独立 PUT。
class _DeductionSheet extends StatefulWidget {
  const _DeductionSheet({this.row});

  final dynamic row;

  @override
  State<_DeductionSheet> createState() => _DeductionSheetState();
}

class _DeductionSheetState extends State<_DeductionSheet> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  late final TextEditingController _categoryCtrl;
  late final TextEditingController _percentCtrl;
  late final TextEditingController _remarkCtrl;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final Map<String, dynamic> m = _mapOf(widget.row);
    _categoryCtrl = TextEditingController(text: _textOf(m['category']));
    _percentCtrl = TextEditingController(text: m.containsKey('percent') ? _numText(m['percent'], blank: '') : '');
    _remarkCtrl = TextEditingController(text: _textOf(m['remark']));
  }

  @override
  void dispose() {
    _categoryCtrl.dispose();
    _percentCtrl.dispose();
    _remarkCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_saving || !(_formKey.currentState?.validate() ?? false)) {
      return;
    }
    setState(() => _saving = true);
    try {
      await ApiService.upsertDeduction(
        _categoryCtrl.text.trim(),
        _doubleOf(_percentCtrl.text),
        remark: _remarkCtrl.text.trim(),
      );
      if (!mounted) {
        return;
      }
      Navigator.pop(context, true);
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  void _fail(Object e) {
    if (!mounted) {
      return;
    }
    setState(() => _saving = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(_errorText(e)), backgroundColor: Colors.red),
    );
  }

  String? _validateCategory(String? v) => (v ?? '').trim().isEmpty ? '商品类别不能为空' : null;

  String? _validatePercent(String? v) {
    final double? p = double.tryParse((v ?? '').trim());
    if (p == null) {
      return '请填写数字';
    }
    if (p < 0 || p >= 100) {
      return '扣点百分比必须在 0 ~ 100 之间（不含 100）';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final bool isEdit = widget.row != null;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 18),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(isEdit ? '编辑分类扣点' : '新增分类扣点',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                const SizedBox(height: 14),
                TextFormField(
                  controller: _categoryCtrl,
                  enabled: !isEdit,
                  decoration: InputDecoration(
                    labelText: '商品类别',
                    hintText: '如：蔬菜 / 水果',
                    helperText: isEdit ? '类别名是唯一键：改类别名等于新建一条，原规则请删除' : null,
                    border: const OutlineInputBorder(),
                  ),
                  validator: _validateCategory,
                ),
                const SizedBox(height: 12),
                _NumField(
                  controller: _percentCtrl,
                  label: '扣点百分比',
                  suffix: '%',
                  helper: '0 ~ 100，可填 0，不能填 100',
                  validator: _validatePercent,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _remarkCtrl,
                  decoration: const InputDecoration(labelText: '备注（可留空）', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 16),
                _SubmitButton(label: '保存', busy: _saving, onPressed: _submit),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 页签 2：店铺扣点（存在 json 配置文件里，与电脑端同一份）
// ---------------------------------------------------------------------------

class _ShopDeductionTab extends StatefulWidget {
  const _ShopDeductionTab();

  @override
  State<_ShopDeductionTab> createState() => _ShopDeductionTabState();
}

class _ShopDeductionTabState extends State<_ShopDeductionTab> {
  List<dynamic> _rules = <dynamic>[];
  String _configFile = '';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final Map<String, dynamic> data = await ApiService.shopDeductions();
      if (!mounted) {
        return;
      }
      setState(() {
        _configFile = _textOf(data['file']);
        _rules = _listOf(data['rules']);
        _loading = false;
      });
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  void _fail(Object e) {
    if (!mounted) {
      return;
    }
    setState(() => _loading = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(_errorText(e)), backgroundColor: Colors.red),
    );
  }

  Future<void> _openSheet(dynamic rule) async {
    // 写接口直接返回整份 rules，拿它回显，省一次 GET。
    final List<dynamic>? rules = await showModalBottomSheet<List<dynamic>>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) => _ShopDeductionSheet(rule: rule),
    );
    if (rules == null || !mounted) {
      return;
    }
    setState(() => _rules = rules);
  }

  Future<void> _delete(dynamic rule) async {
    final String shop = _textOf(rule['shop']);
    final bool ok = await _confirmDialog(
      context,
      title: '删除店铺扣点',
      message: '确定删除「$shop」的扣点规则？（删除接口幂等，不存在也会成功）',
    );
    if (!ok) {
      return;
    }
    if (!mounted) {
      return;
    }
    try {
      final Map<String, dynamic> res = await ApiService.deleteShopDeduction(shop);
      if (!mounted) {
        return;
      }
      setState(() => _rules = _listOf(res['rules']));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已删除「$shop」'), backgroundColor: Colors.green),
      );
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final String fileText = _configFile.isEmpty ? '—' : _configFile;
    return _TabBody(
      loading: _loading,
      onRefresh: _load,
      header: _Toolbar(
        tip: '聚水潭订单导入时按「店铺名称」扣减订单收入（卖家实收），保存后立即生效。',
        label: '新增',
        onAdd: () => _openSheet(null),
      ),
      children: <Widget>[
        if (_rules.isEmpty) const _EmptyBox('暂无店铺扣点规则，点「新增」按店铺名配置'),
        for (final dynamic rule in _rules) _ruleCard(rule),
        const SizedBox(height: 4),
        _Hint('配置文件：$fileText$_nl与电脑端共用同一份配置文件，改动两边同时生效。'),
      ],
    );
  }

  Widget _ruleCard(dynamic rule) {
    final String shop = _textOf(rule['shop']);
    final Object? percent = rule['percent'];
    final Map<String, dynamic> categories = _mapOf(rule['categories']);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        onTap: () => _openSheet(rule),
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(child: Text(shop, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
                  if (percent == null && categories.isEmpty) const _Tag(text: '未设置', color: Colors.grey),
                  IconButton(
                    tooltip: '编辑',
                    icon: const Icon(Icons.edit_outlined, size: 20, color: Color(0xFF1989FA)),
                    onPressed: () => _openSheet(rule),
                  ),
                  IconButton(
                    tooltip: '删除',
                    icon: const Icon(Icons.delete_outline, size: 20, color: Colors.red),
                    onPressed: () => _delete(rule),
                  ),
                ],
              ),
              if (percent != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text('统一扣点 ${_pctText(percent)}',
                      style: const TextStyle(fontSize: 13, color: Color(0xFF1989FA))),
                ),
              if (categories.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: <Widget>[
                      for (final MapEntry<String, dynamic> e in categories.entries)
                        _Tag(text: '${e.key} ${_pctText(e.value)}', color: const Color(0xFF8A6D3B)),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 「类别:百分比」多行文本的解析结果。
class _CatParse {
  const _CatParse(this.cats, this.error);

  final Map<String, double> cats;
  final String? error;

  bool get ok => error == null && cats.isNotEmpty;
}

/// 逐行解析「类别:百分比」（兼容全角冒号与结尾的 %）。
_CatParse _parseCategoryLines(String text) {
  final Map<String, double> out = <String, double>{};
  final List<String> lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  for (int i = 0; i < lines.length; i++) {
    final String line = lines[i].trim();
    if (line.isEmpty) {
      continue;
    }
    final String no = (i + 1).toString();
    int pos = line.indexOf(':');
    final int full = line.indexOf('：');
    if (full >= 0 && (pos < 0 || full < pos)) {
      pos = full;
    }
    if (pos <= 0) {
      return _CatParse(out, '第 $no 行「$line」解析失败，请按「蔬菜:7」一行一条填写');
    }
    final String name = line.substring(0, pos).trim();
    String valueText = line.substring(pos + 1).trim();
    if (valueText.endsWith('%')) {
      valueText = valueText.substring(0, valueText.length - 1).trim();
    }
    final double? value = double.tryParse(valueText);
    if (name.isEmpty || value == null) {
      return _CatParse(out, '第 $no 行「$line」解析失败，百分比要是数字，例如 蔬菜:7');
    }
    if (value <= 0 || value >= 100) {
      return _CatParse(out, '「$name」的扣点需在 0 ~ 100 之间（填 0 会被后端忽略，不能填 100）');
    }
    out[name] = value;
  }
  if (out.isEmpty) {
    return _CatParse(out, '请至少填写一行「类别:百分比」，例如 蔬菜:7');
  }
  return _CatParse(out, null);
}

/// 店铺扣点表单：按店铺统一扣点 / 按类别分别设置。
/// 后端按店铺名整条覆盖（percent 优先），所以一次只能保存其中一种方式。
class _ShopDeductionSheet extends StatefulWidget {
  const _ShopDeductionSheet({this.rule});

  final dynamic rule;

  @override
  State<_ShopDeductionSheet> createState() => _ShopDeductionSheetState();
}

class _ShopDeductionSheetState extends State<_ShopDeductionSheet> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  late final TextEditingController _shopCtrl;
  late final TextEditingController _percentCtrl;
  late final TextEditingController _catsCtrl;
  late bool _byPercent;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final Map<String, dynamic> m = _mapOf(widget.rule);
    final Object? percent = m['percent'];
    final Map<String, dynamic> categories = _mapOf(m['categories']);
    _shopCtrl = TextEditingController(text: _textOf(m['shop']));
    _percentCtrl = TextEditingController(text: percent == null ? '' : _numText(percent, blank: ''));
    _catsCtrl = TextEditingController(
      text: categories.entries.map((MapEntry<String, dynamic> e) => '${e.key}:${_numText(e.value, blank: '')}').join(_nl),
    );
    // percent 与 categories 同时存在时，后端按 percent 生效，这里也按统一扣点打开。
    _byPercent = percent != null;
  }

  @override
  void dispose() {
    _shopCtrl.dispose();
    _percentCtrl.dispose();
    _catsCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_saving || !(_formKey.currentState?.validate() ?? false)) {
      return;
    }
    final Map<String, dynamic> body = <String, dynamic>{'shop': _shopCtrl.text.trim()};
    if (_byPercent) {
      final double? p = double.tryParse(_percentCtrl.text.trim());
      if (p == null) {
        setState(() => _error = '请填写数字百分比，例如 8');
        return;
      }
      if (p < 0 || p >= 100) {
        setState(() => _error = '固定扣点百分比需在 0 ~ 100 之间（不含 100）');
        return;
      }
      body['percent'] = p;
    } else {
      final _CatParse parsed = _parseCategoryLines(_catsCtrl.text);
      if (!parsed.ok) {
        setState(() => _error = parsed.error);
        return;
      }
      body['categories'] = parsed.cats;
    }

    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> res = await ApiService.upsertShopDeduction(body);
      if (!mounted) {
        return;
      }
      Navigator.pop(context, _listOf(res['rules']));
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  void _fail(Object e) {
    if (!mounted) {
      return;
    }
    setState(() {
      _saving = false;
      _error = _errorText(e);
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(_errorText(e)), backgroundColor: Colors.red),
    );
  }

  String? _validateShop(String? v) => (v ?? '').trim().isEmpty ? '店铺名称不能为空' : null;

  @override
  Widget build(BuildContext context) {
    final bool isEdit = widget.rule != null;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.92),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 18),
            child: Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Text(isEdit ? '编辑店铺扣点' : '新增店铺扣点',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _shopCtrl,
                    enabled: !isEdit,
                    decoration: InputDecoration(
                      labelText: '店铺名称',
                      hintText: '与聚水潭店铺名保持一致',
                      helperText: isEdit ? '按店铺名整条覆盖：改店名等于新建一条，原规则请删除' : null,
                      border: const OutlineInputBorder(),
                    ),
                    validator: _validateShop,
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: <Widget>[
                      ChoiceChip(
                        label: const Text('按店铺统一扣点'),
                        selected: _byPercent,
                        onSelected: (bool _) => setState(() => _byPercent = true),
                      ),
                      const SizedBox(width: 8),
                      ChoiceChip(
                        label: const Text('按类别分别设置'),
                        selected: !_byPercent,
                        onSelected: (bool _) => setState(() => _byPercent = false),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  if (_byPercent)
                    _NumField(
                      controller: _percentCtrl,
                      label: '统一扣点',
                      suffix: '%',
                      helper: '0 ~ 100（不含 100）',
                    )
                  else
                    TextFormField(
                      controller: _catsCtrl,
                      maxLines: 5,
                      decoration: const InputDecoration(
                        labelText: '分类扣点',
                        alignLabelWithHint: true,
                        hintText: '蔬菜:7（每行一条）',
                        helperText: '一行一条「类别:百分比」；填 0 会被后端忽略',
                        border: OutlineInputBorder(),
                      ),
                    ),
                  const SizedBox(height: 12),
                  _ErrorBox(_error),
                  _SubmitButton(label: '保存', busy: _saving, onPressed: _submit),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 页签 3：快递计费（一份全局配置，出库算费实时生效）
// ---------------------------------------------------------------------------

class _ExpressRuleTab extends StatefulWidget {
  const _ExpressRuleTab();

  @override
  State<_ExpressRuleTab> createState() => _ExpressRuleTabState();
}

class _ExpressRuleTabState extends State<_ExpressRuleTab> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _firstCtrl = TextEditingController();
  final TextEditingController _extraCtrl = TextEditingController();
  final TextEditingController _rateCtrl = TextEditingController();

  String _mode = 'tiered';
  bool _roundUp = true;
  bool _loading = true;
  bool _loaded = false;
  bool _saving = false;
  String? _error;

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
    try {
      final Map<String, dynamic> data = await ApiService.expressRule();
      if (!mounted) {
        return;
      }
      _apply(data);
      setState(() {
        _loading = false;
        _loaded = true;
        _error = null;
      });
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  /// 用后端返回（已补全默认值）的配置回填表单。
  void _apply(Map<String, dynamic> cfg) {
    _mode = _textOf(cfg['mode']) == 'flat' ? 'flat' : 'tiered';
    _roundUp = _boolOf(cfg['round_up']);
    _firstCtrl.text = _numText(cfg['first_kg_fee'], blank: '');
    _extraCtrl.text = _numText(cfg['per_extra_kg'], blank: '');
    _rateCtrl.text = _numText(cfg['rate_per_kg'], blank: '');
  }

  void _fail(Object e) {
    if (!mounted) {
      return;
    }
    setState(() {
      _loading = false;
      _saving = false;
      _error = _errorText(e);
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(_errorText(e)), backgroundColor: Colors.red),
    );
  }

  Future<void> _save() async {
    if (_saving || !(_formKey.currentState?.validate() ?? false)) {
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final Map<String, dynamic> res = await ApiService.saveExpressRule(<String, dynamic>{
        'mode': _mode,
        'first_kg_fee': _doubleOf(_firstCtrl.text),
        'per_extra_kg': _doubleOf(_extraCtrl.text),
        'rate_per_kg': _doubleOf(_rateCtrl.text),
        'round_up': _roundUp,
      });
      if (!mounted) {
        return;
      }
      _apply(res);
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('快递计费已保存，出库算费实时生效'), backgroundColor: Colors.green),
      );
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  String? _validateFee(String? v) {
    final double? fee = double.tryParse((v ?? '').trim());
    if (fee == null) {
      return '请填写数字';
    }
    if (fee < 0 || fee > 10000) {
      return '费用需在 0 ~ 10000 之间';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: Form(
        key: _formKey,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 28),
          children: <Widget>[
            _ErrorBox(_error),
            if (!_loaded)
              const _EmptyBox('未读取到快递计费配置，下拉可重试')
            else ...<Widget>[
              _modeCard(),
              const SizedBox(height: 10),
              _feeCard(),
              const SizedBox(height: 10),
              const _Hint('计费方式只能是分段计费或按重量单价；三项费用取值范围 0 ~ 10000，保存后按后端补全值回显。'),
              _SubmitButton(label: '保存计费规则', busy: _saving, onPressed: _save),
            ],
          ],
        ),
      ),
    );
  }

  Widget _modeCard() {
    final String tieredTip = _roundUp ? '；勾选取整时不足 1kg 按 1kg 续重' : '';
    final String tip = _mode == 'tiered'
        ? '分段计费 = 首重价 +（超出 1kg 的部分，每超 1kg 加收一次$tieredTip）'
        : '按重量单价 = 重量 × 每 kg 单价';
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text('计费方式', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Row(
              children: <Widget>[
                ChoiceChip(
                  label: const Text('分段计费（tiered）'),
                  selected: _mode == 'tiered',
                  onSelected: (bool _) => setState(() => _mode = 'tiered'),
                ),
                const SizedBox(width: 8),
                ChoiceChip(
                  label: const Text('按重量单价（flat）'),
                  selected: _mode == 'flat',
                  onSelected: (bool _) => setState(() => _mode = 'flat'),
                ),
              ],
            ),
            const SizedBox(height: 6),
            _Hint(tip),
          ],
        ),
      ),
    );
  }

  Widget _feeCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _NumField(
              controller: _firstCtrl,
              label: '首重价（1kg 以内）',
              suffix: '元',
              helper: '仅分段计费使用',
              validator: _validateFee,
            ),
            const SizedBox(height: 12),
            _NumField(
              controller: _extraCtrl,
              label: '每超 1kg 加收',
              suffix: '元',
              helper: '仅分段计费使用',
              validator: _validateFee,
            ),
            const SizedBox(height: 12),
            _NumField(
              controller: _rateCtrl,
              label: '每 kg 单价',
              suffix: '元',
              helper: '仅按重量单价使用',
              validator: _validateFee,
            ),
            SwitchListTile(
              value: _roundUp,
              onChanged: (bool v) => setState(() => _roundUp = v),
              contentPadding: EdgeInsets.zero,
              title: const Text('续重按整 kg 向上取整'),
              subtitle: const Text('仅分段计费生效，例如 1.2kg 按 2kg 的续重收'),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 页签 4：打包规则（一单多货）
// ---------------------------------------------------------------------------

/// 选择列表的一项。
class _PickOption {
  const _PickOption(this.id, this.title, this.subtitle);

  final int id;
  final String title;
  final String subtitle;
}

/// 选择结果：cleared = 选「取消关联」。
class _PickResult {
  const _PickResult(this.cleared, this.option);

  final bool cleared;
  final _PickOption? option;
}

/// 通用单选列表（带搜索），订单商品 / 库存大类 / 包材都用它。
class _PickSheet extends StatefulWidget {
  const _PickSheet({required this.title, required this.options, this.allowClear = false});

  final String title;
  final List<_PickOption> options;
  final bool allowClear;

  @override
  State<_PickSheet> createState() => _PickSheetState();
}

class _PickSheetState extends State<_PickSheet> {
  String _keyword = '';

  List<_PickOption> get _filtered {
    final String kw = _keyword.trim().toLowerCase();
    if (kw.isEmpty) {
      return widget.options;
    }
    return widget.options.where((_PickOption o) => o.title.toLowerCase().contains(kw)).toList();
  }

  @override
  Widget build(BuildContext context) {
    final List<_PickOption> rows = _filtered;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
        child: Column(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Text(widget.title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: TextField(
                decoration: const InputDecoration(
                  hintText: '搜索名称',
                  prefixIcon: Icon(Icons.search),
                  isDense: true,
                  border: OutlineInputBorder(),
                ),
                onChanged: (String v) => setState(() => _keyword = v),
              ),
            ),
            if (widget.allowClear)
              ListTile(
                dense: true,
                leading: const Icon(Icons.link_off, size: 20),
                title: const Text('取消关联'),
                onTap: () => Navigator.pop(context, const _PickResult(true, null)),
              ),
            const Divider(height: 1),
            Expanded(
              child: rows.isEmpty
                  ? const _EmptyBox('没有匹配项')
                  : ListView.builder(
                      itemCount: rows.length,
                      itemBuilder: (BuildContext ctx, int i) => ListTile(
                        title: Text(rows[i].title),
                        subtitle: Text(rows[i].subtitle, style: const TextStyle(fontSize: 12)),
                        onTap: () => Navigator.pop(context, _PickResult(false, rows[i])),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 组合商品行：product_id 可为空（表示手填名称），stock_product_id 必须是库存大类。
class _PackItemDraft {
  _PackItemDraft({
    this.productId,
    this.stockProductId,
    this.stockName = '',
    String name = '',
    String quantity = '1',
    String multiplier = '1',
  })  : nameCtrl = TextEditingController(text: name),
        quantityCtrl = TextEditingController(text: quantity),
        multiplierCtrl = TextEditingController(text: multiplier);

  final TextEditingController nameCtrl;
  final TextEditingController quantityCtrl;
  final TextEditingController multiplierCtrl;
  int? productId;
  int? stockProductId;
  String stockName;

  void dispose() {
    nameCtrl.dispose();
    quantityCtrl.dispose();
    multiplierCtrl.dispose();
  }
}

/// 随货箱行（包材纸箱）。
class _PackBoxDraft {
  _PackBoxDraft({this.productId, String name = '', String quantity = '1'})
      : nameCtrl = TextEditingController(text: name),
        quantityCtrl = TextEditingController(text: quantity);

  final TextEditingController nameCtrl;
  final TextEditingController quantityCtrl;
  int? productId;

  void dispose() {
    nameCtrl.dispose();
    quantityCtrl.dispose();
  }
}

class _PackRuleTab extends StatefulWidget {
  const _PackRuleTab();

  @override
  State<_PackRuleTab> createState() => _PackRuleTabState();
}

class _PackRuleTabState extends State<_PackRuleTab> {
  List<dynamic> _rules = <dynamic>[];
  List<dynamic> _stocks = <dynamic>[];
  List<dynamic> _orderProducts = <dynamic>[];
  bool _optionsLoaded = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final List<dynamic> data = await ApiService.packRules();
      if (!mounted) {
        return;
      }
      setState(() {
        _rules = data;
        _loading = false;
      });
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  void _fail(Object e) {
    if (!mounted) {
      return;
    }
    setState(() => _loading = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(_errorText(e)), backgroundColor: Colors.red),
    );
  }

  /// 选择器数据源只在第一次打开表单时各拉一次。
  Future<void> _ensureOptions() async {
    if (_optionsLoaded) {
      return;
    }
    final List<dynamic> stocks = await ApiService.stocks();
    final List<dynamic> products = await ApiService.products();
    if (!mounted) {
      return;
    }
    setState(() {
      _stocks = stocks;
      _orderProducts = products.where((dynamic p) {
        final Map<String, dynamic> m = _mapOf(p);
        return m['product_type'] == 'order' && _boolOf(m['is_active']);
      }).toList();
      _optionsLoaded = true;
    });
  }

  Future<void> _openSheet(dynamic rule) async {
    try {
      await _ensureOptions();
    } on ApiException catch (e) {
      _fail(e);
      return;
    } catch (e) {
      _fail(e);
      return;
    }
    if (!mounted) {
      return;
    }
    final bool? saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) => _PackRuleSheet(
        rule: rule,
        stocks: _stocks,
        orderProducts: _orderProducts,
      ),
    );
    if (saved == true) {
      _load();
    }
  }

  Future<void> _delete(dynamic rule) async {
    final int? id = _intOf(rule['id']);
    final String name = _textOf(rule['name']);
    final bool ok = await _confirmDialog(
      context,
      title: '删除打包规则',
      message: '确定删除「$name」？已生成的出库单不受影响。',
    );
    if (!ok || id == null) {
      return;
    }
    if (!mounted) {
      return;
    }
    try {
      await ApiService.deletePackRule(id);
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已删除「$name」'), backgroundColor: Colors.green),
      );
      _load();
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  String _stockNameOf(dynamic id) {
    final int? sid = _intOf(id);
    if (sid == null) {
      return '';
    }
    for (final dynamic s in _stocks) {
      if (_intOf(s['id']) == sid) {
        return _textOf(s['name']);
      }
    }
    return '#$sid';
  }

  @override
  Widget build(BuildContext context) {
    return _TabBody(
      loading: _loading,
      onRefresh: _load,
      header: _Toolbar(
        tip: '一单多货打包规则：一张订单同时含这组商品时，按此规则计纸箱/包材与人工。点卡片可编辑。',
        label: '新增',
        onAdd: () => _openSheet(null),
      ),
      children: <Widget>[
        if (_rules.isEmpty) const _EmptyBox('暂无一单多货规则，点「新增」配置一组订单商品的打包方式')
        else
          for (final dynamic rule in _rules) _ruleCard(rule),
      ],
    );
  }

  Widget _ruleCard(dynamic rule) {
    final String name = _textOf(rule['name']);
    final String boxType = _textOf(rule['box_type']);
    final Object? labor = rule['labor_price'];
    final bool active = _boolOf(rule['is_active']);
    final String ratio = _numText(rule['box_ratio'], blank: '1');
    final String remark = _textOf(rule['remark']);
    final List<dynamic> items = _listOf(rule['items']);

    String combo = '';
    String deduct = '';
    for (final dynamic e in items) {
      final Map<String, dynamic> m = _mapOf(e);
      final String itemName = _textOf(m['name']);
      final String qty = _numText(m['quantity'], blank: '1');
      combo = combo.isEmpty ? itemName : '$combo + $itemName';
      if (qty != '1') {
        combo = '$combo × $qty';
      }
      final String target = _stockNameOf(m['stock_product_id']);
      final String base = target.isEmpty ? itemName : target;
      final String part = '$base × ${_numText(m['multiplier'], blank: '1')}';
      deduct = deduct.isEmpty ? part : '$deduct、$part';
    }

    final String laborText = labor == null ? '人工 未设置' : '人工 ${_moneyText(labor)}/单';
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        onTap: () => _openSheet(rule),
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(name, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600)),
                  ),
                  _Tag(text: active ? '启用' : '停用', color: active ? const Color(0xFF07C160) : Colors.grey),
                  IconButton(
                    tooltip: '编辑',
                    icon: const Icon(Icons.edit_outlined, size: 20, color: Color(0xFF1989FA)),
                    onPressed: () => _openSheet(rule),
                  ),
                  IconButton(
                    tooltip: '删除',
                    icon: const Icon(Icons.delete_outline, size: 20, color: Colors.red),
                    onPressed: () => _delete(rule),
                  ),
                ],
              ),
              const SizedBox(height: 2),
              Text('组合：${combo.isEmpty ? '—' : combo}',
                  style: const TextStyle(fontSize: 12.5, color: Colors.black54)),
              Text('扣减：${deduct.isEmpty ? '—' : deduct}',
                  style: const TextStyle(fontSize: 12.5, color: Colors.black54)),
              const SizedBox(height: 4),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: <Widget>[
                  _Tag(text: '箱型 ${boxType.isEmpty ? '—' : boxType}', color: Colors.black54),
                  _Tag(text: laborText, color: Colors.black54),
                  _Tag(text: '箱比 $ratio', color: Colors.black54),
                ],
              ),
              if (remark.isNotEmpty) ...<Widget>[
                const SizedBox(height: 4),
                _Hint(remark),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 打包规则表单（新增 / 编辑同一套）。
///
/// 关键约束：规则名 name 由后端按 items 里的商品真名与数量自动生成（数量不为 1 时拼成
/// 「名*2.0」），前端传什么都不算，所以这里不提交 name；组合重名后端会 400
/// 「该一单多货组合「xxx」已存在」，原样提示给用户。
class _PackRuleSheet extends StatefulWidget {
  const _PackRuleSheet({this.rule, required this.stocks, required this.orderProducts});

  final dynamic rule;
  final List<dynamic> stocks;
  final List<dynamic> orderProducts;

  @override
  State<_PackRuleSheet> createState() => _PackRuleSheetState();
}

class _PackRuleSheetState extends State<_PackRuleSheet> {
  final List<_PackItemDraft> _items = <_PackItemDraft>[];
  final List<_PackBoxDraft> _boxes = <_PackBoxDraft>[];
  final TextEditingController _boxTypeCtrl = TextEditingController();
  final TextEditingController _laborCtrl = TextEditingController();
  final TextEditingController _ratioCtrl = TextEditingController(text: '1');
  final TextEditingController _remarkCtrl = TextEditingController();

  bool _active = true;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final Map<String, dynamic> m = _mapOf(widget.rule);
    if (m.isEmpty) {
      _items.add(_PackItemDraft());
      return;
    }
    for (final dynamic e in _listOf(m['items'])) {
      final Map<String, dynamic> it = _mapOf(e);
      _items.add(_PackItemDraft(
        productId: _intOf(it['product_id']),
        stockProductId: _intOf(it['stock_product_id']),
        stockName: _stockNameOf(_intOf(it['stock_product_id'])),
        name: _textOf(it['name']),
        quantity: _numText(it['quantity'], blank: '1'),
        multiplier: _numText(it['multiplier'], blank: '1'),
      ));
    }
    if (_items.isEmpty) {
      _items.add(_PackItemDraft());
    }
    for (final dynamic e in _listOf(m['box_items'])) {
      final Map<String, dynamic> bx = _mapOf(e);
      _boxes.add(_PackBoxDraft(
        productId: _intOf(bx['product_id']),
        name: _textOf(bx['name']),
        quantity: _numText(bx['quantity'], blank: '1'),
      ));
    }
    _boxTypeCtrl.text = _textOf(m['box_type']);
    _laborCtrl.text = m['labor_price'] == null ? '' : _numText(m['labor_price'], blank: '');
    _ratioCtrl.text = _numText(m['box_ratio'], blank: '1');
    _remarkCtrl.text = _textOf(m['remark']);
    _active = _boolOf(m['is_active']);
  }

  @override
  void dispose() {
    for (final _PackItemDraft it in _items) {
      it.dispose();
    }
    for (final _PackBoxDraft bx in _boxes) {
      bx.dispose();
    }
    _boxTypeCtrl.dispose();
    _laborCtrl.dispose();
    _ratioCtrl.dispose();
    _remarkCtrl.dispose();
    super.dispose();
  }

  String _stockNameOf(int? id) {
    if (id == null) {
      return '';
    }
    for (final dynamic s in widget.stocks) {
      if (_intOf(s['id']) == id) {
        return _textOf(s['name']);
      }
    }
    return '#$id';
  }

  String _unitOf(Map<String, dynamic> m) {
    final String def = _textOf(m['default_unit']);
    return def.isEmpty ? _textOf(m['base_unit']) : def;
  }

  List<_PickOption> _stockOptions() {
    return widget.stocks.map((dynamic s) {
      final Map<String, dynamic> m = _mapOf(s);
      return _PickOption(
        _intOf(m['id']) ?? 0,
        _textOf(m['name']),
        "${_textOf(m['category'])} · 库存 ${_numText(m['stock'], blank: '0')}${_unitOf(m)}",
      );
    }).toList();
  }

  List<_PickOption> _orderOptions() {
    return widget.orderProducts.map((dynamic p) {
      final Map<String, dynamic> m = _mapOf(p);
      return _PickOption(_intOf(m['id']) ?? 0, _textOf(m['name']), "${_textOf(m['category'])} · ${_unitOf(m)}");
    }).toList();
  }

  List<_PickOption> _boxOptions() {
    // 包材走库存大类的「包材/耗材/包装」分类；不选也行，后端会按箱型号名自动匹配。
    const List<String> cats = <String>['包材', '耗材', '包装'];
    return widget.stocks
        .map((dynamic s) => _mapOf(s))
        .where((Map<String, dynamic> m) => cats.contains(_textOf(m['category'])))
        .map((Map<String, dynamic> m) => _PickOption(_intOf(m['id']) ?? 0, _textOf(m['name']), _textOf(m['category'])))
        .toList();
  }

  Future<_PickResult?> _openPicker(String title, List<_PickOption> options, {bool allowClear = false}) {
    return showModalBottomSheet<_PickResult>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext ctx) => _PickSheet(title: title, options: options, allowClear: allowClear),
    );
  }

  Future<void> _pickStock(_PackItemDraft it) async {
    final _PickResult? res = await _openPicker('选择扣减的库存大类', _stockOptions(), allowClear: true);
    if (res == null || !mounted) {
      return;
    }
    setState(() {
      _error = null;
      if (res.cleared) {
        it.stockProductId = null;
        it.stockName = '';
      } else if (res.option != null) {
        it.stockProductId = res.option!.id;
        it.stockName = res.option!.title;
      }
    });
  }

  Future<void> _pickOrderProduct(_PackItemDraft it) async {
    final List<_PickOption> options = _orderOptions();
    if (options.isEmpty) {
      setState(() => _error = '当前分仓没有可用的订单商品，可直接手填商品名称');
      return;
    }
    final _PickResult? res = await _openPicker('选择订单商品（也可手填名称）', options);
    if (res == null || res.cleared || res.option == null || !mounted) {
      return;
    }
    setState(() {
      it.productId = res.option!.id;
      it.nameCtrl.text = res.option!.title;
      _error = null;
    });
  }

  Future<void> _pickBoxProduct(_PackBoxDraft bx) async {
    final List<_PickOption> options = _boxOptions();
    if (options.isEmpty) {
      setState(() => _error = '没有包材类库存商品，可直接手填箱型号（如 3号）');
      return;
    }
    final _PickResult? res = await _openPicker('选择随货箱（包材纸箱）', options);
    if (res == null || res.cleared || res.option == null || !mounted) {
      return;
    }
    setState(() {
      bx.productId = res.option!.id;
      bx.nameCtrl.text = res.option!.title;
      _error = null;
    });
  }

  /// 校验并组 body；返回 null 表示有本地校验没过（错误已写进 _error）。
  Map<String, dynamic>? _buildBody() {
    final List<Map<String, dynamic>> items = <Map<String, dynamic>>[];
    for (int i = 0; i < _items.length; i++) {
      final _PackItemDraft it = _items[i];
      final String name = it.nameCtrl.text.trim();
      if (name.isEmpty) {
        final String no = (i + 1).toString();
        setState(() => _error = '第 $no 条组合商品名称不能为空');
        return null;
      }
      final double? qty = double.tryParse(it.quantityCtrl.text.trim());
      if (qty == null || qty <= 0) {
        setState(() => _error = '商品「$name」的数量必须大于 0');
        return null;
      }
      final String multText = it.multiplierCtrl.text.trim();
      final double mult = multText.isEmpty ? 1 : _doubleOf(multText);
      if (mult <= 0) {
        setState(() => _error = '商品「$name」的扣减倍数必须大于 0');
        return null;
      }
      items.add(<String, dynamic>{
        'product_id': it.productId,
        'name': name,
        'quantity': qty,
        'stock_product_id': it.stockProductId,
        'multiplier': mult,
      });
    }
    if (items.isEmpty) {
      setState(() => _error = '至少需要一条组合商品');
      return null;
    }

    final List<Map<String, dynamic>> boxItems = <Map<String, dynamic>>[];
    for (int i = 0; i < _boxes.length; i++) {
      final _PackBoxDraft bx = _boxes[i];
      final String name = bx.nameCtrl.text.trim();
      if (name.isEmpty) {
        continue;
      }
      final String qtyText = bx.quantityCtrl.text.trim();
      final double qty = qtyText.isEmpty ? 1 : _doubleOf(qtyText);
      if (qty <= 0) {
        setState(() => _error = '随货箱「$name」的数量必须大于 0');
        return null;
      }
      boxItems.add(<String, dynamic>{'product_id': bx.productId, 'name': name, 'quantity': qty});
    }

    final String laborText = _laborCtrl.text.trim();
    double? labor;
    if (laborText.isNotEmpty) {
      labor = double.tryParse(laborText);
      if (labor == null || labor < 0) {
        setState(() => _error = '人工价请填写不小于 0 的数字（留空表示不按单计人工）');
        return null;
      }
    }

    double ratio = 1;
    final String ratioText = _ratioCtrl.text.trim();
    if (ratioText.isNotEmpty) {
      final double? r = double.tryParse(ratioText);
      if (r == null || r <= 0) {
        setState(() => _error = '箱规比例需为大于 0 的数字');
        return null;
      }
      ratio = r;
    }

    return <String, dynamic>{
      'items': items,
      'box_items': boxItems,
      'box_type': _boxTypeCtrl.text.trim(),
      'labor_price': labor,
      'box_ratio': ratio,
      'remark': _remarkCtrl.text.trim(),
      'is_active': _active,
    };
  }

  Future<void> _submit() async {
    if (_saving) {
      return;
    }
    final Map<String, dynamic>? body = _buildBody();
    if (body == null) {
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final int? id = _intOf(_mapOf(widget.rule)['id']);
      if (id == null) {
        await ApiService.createPackRule(body);
      } else {
        await ApiService.updatePackRule(id, body);
      }
      if (!mounted) {
        return;
      }
      Navigator.pop(context, true);
    } on ApiException catch (e) {
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  void _fail(Object e) {
    if (!mounted) {
      return;
    }
    setState(() {
      _saving = false;
      _error = _errorText(e);
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(_errorText(e)), backgroundColor: Colors.red),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool isEdit = widget.rule != null;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.92),
          child: Column(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(isEdit ? '编辑打包规则' : '新增打包规则（一单多货）',
                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                    ),
                    IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
                  ],
                ),
              ),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      _ErrorBox(_error),
                      const _Hint('规则名由后端按「商品真名 + 数量」自动生成，前端填的名称不作为键值。'),
                      const SizedBox(height: 6),
                      Row(
                        children: <Widget>[
                          const Expanded(
                              child: Text('组合商品', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                          TextButton.icon(
                            onPressed: () => setState(() => _items.add(_PackItemDraft())),
                            icon: const Icon(Icons.add, size: 18),
                            label: const Text('加一条'),
                          ),
                        ],
                      ),
                      for (int i = 0; i < _items.length; i++) _itemCard(_items[i], i),
                      const SizedBox(height: 6),
                      Row(
                        children: <Widget>[
                          const Expanded(
                              child: Text('随货箱（包材）', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                          TextButton.icon(
                            onPressed: () => setState(() => _boxes.add(_PackBoxDraft())),
                            icon: const Icon(Icons.add, size: 18),
                            label: const Text('加一箱'),
                          ),
                        ],
                      ),
                      if (_boxes.isEmpty) const _Hint('未配置随货箱时，只按下面的箱型文本计包材'),
                      for (int i = 0; i < _boxes.length; i++) _boxRow(_boxes[i], i),
                      const SizedBox(height: 10),
                      TextFormField(
                        controller: _boxTypeCtrl,
                        decoration: const InputDecoration(
                          labelText: '箱型文本（可留空）',
                          hintText: '如 7号 或 6号*2+7号*2',
                          helperText: '填了随货箱时，后端按箱条目自动生成箱型文本',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: _NumField(
                              controller: _laborCtrl,
                              label: '人工价/单',
                              suffix: '元',
                              hint: '留空 = 不计人工',
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: _NumField(controller: _ratioCtrl, label: '箱规比例', helper: '默认 1'),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _remarkCtrl,
                        decoration: const InputDecoration(labelText: '备注（可留空）', border: OutlineInputBorder()),
                      ),
                      SwitchListTile(
                        value: _active,
                        onChanged: (bool v) => setState(() => _active = v),
                        contentPadding: EdgeInsets.zero,
                        title: const Text('启用该规则'),
                        subtitle: const Text('停用后出库不再自动匹配这一单多货组合'),
                      ),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 12),
                child: _SubmitButton(
                  label: isEdit ? '保存修改' : '创建规则',
                  busy: _saving,
                  onPressed: _submit,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _itemCard(_PackItemDraft it, int index) {
    final String no = (index + 1).toString();
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(10, 8, 2, 8),
      decoration: BoxDecoration(
        color: const Color(0xFFF7F8FA),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text('$no.', style: const TextStyle(fontSize: 12, color: Colors.grey)),
              const SizedBox(width: 6),
              Expanded(
                child: TextFormField(
                  controller: it.nameCtrl,
                  decoration: const InputDecoration(
                    labelText: '商品名称',
                    isDense: true,
                    border: OutlineInputBorder(),
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                  ),
                ),
              ),
              IconButton(
                tooltip: '选订单商品',
                icon: const Icon(Icons.shopping_bag_outlined, size: 20, color: Color(0xFF1989FA)),
                onPressed: () => _pickOrderProduct(it),
              ),
              IconButton(
                tooltip: '删除这条',
                icon: const Icon(Icons.close, size: 20, color: Colors.red),
                onPressed: () => setState(() => _items.removeAt(index).dispose()),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: <Widget>[
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: TextFormField(
                    controller: it.quantityCtrl,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                      labelText: '数量',
                      isDense: true,
                      border: OutlineInputBorder(),
                      contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                    ),
                  ),
                ),
              ),
              Expanded(
                child: TextFormField(
                  controller: it.multiplierCtrl,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                    labelText: '扣减倍数',
                    isDense: true,
                    helperText: '1 单 = 几倍库存单位',
                    border: OutlineInputBorder(),
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                  ),
                ),
              ),
            ],
          ),
          InkWell(
            onTap: () => _pickStock(it),
            child: Padding(
              padding: const EdgeInsets.only(top: 8, left: 2),
              child: Row(
                children: <Widget>[
                  const Icon(Icons.inventory_2_outlined, size: 16, color: Colors.grey),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      it.stockName.isEmpty ? '扣减库存大类：未设置（按商品自身扣减）' : '扣减库存大类：${it.stockName}',
                      style: const TextStyle(fontSize: 12.5, color: Color(0xFF1989FA)),
                    ),
                  ),
                  const Icon(Icons.chevron_right, size: 18, color: Colors.grey),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _boxRow(_PackBoxDraft bx, int index) {
    final String no = (index + 1).toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: <Widget>[
          Text('$no.', style: const TextStyle(fontSize: 12, color: Colors.grey)),
          const SizedBox(width: 6),
          Expanded(
            child: TextFormField(
              controller: bx.nameCtrl,
              decoration: const InputDecoration(
                labelText: '箱型号',
                isDense: true,
                hintText: '如 3号 / 邮政6号',
                border: OutlineInputBorder(),
                contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 10),
              ),
            ),
          ),
          IconButton(
            tooltip: '选包材纸箱',
            icon: const Icon(Icons.widgets_outlined, size: 20, color: Color(0xFF1989FA)),
            onPressed: () => _pickBoxProduct(bx),
          ),
          const SizedBox(width: 6),
          SizedBox(
            width: 76,
            child: TextFormField(
              controller: bx.quantityCtrl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                labelText: '数量',
                isDense: true,
                border: OutlineInputBorder(),
                contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 10),
              ),
            ),
          ),
          IconButton(
            tooltip: '删除这一箱',
            icon: const Icon(Icons.close, size: 20, color: Colors.red),
            onPressed: () => setState(() => _boxes.removeAt(index).dispose()),
          ),
        ],
      ),
    );
  }
}
