import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:cookie_jar/cookie_jar.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 后端返回的业务错误（FastAPI / Go 都是 detail=中文提示 的形状）。
/// 页面里 catch ApiException 就能直接拿到可展示的文案，不必自己解析 dio 异常。
class ApiException implements Exception {
  ApiException(this.statusCode, this.message);

  final int? statusCode;
  final String message;

  bool get isUnauthorized => statusCode == 401;

  @override
  String toString() => message;
}

/// 与后端（FastAPI，backend/ 下的 uvicorn）对接的唯一入口。
///
/// 后端地址在编译期注入，不要写死在这里（仓库是公开的，内网/生产地址不进代码）：
///   flutter run       --dart-define-from-file=dart_defines.local.json
///   flutter build apk --release --dart-define-from-file=dart_defines.local.json
/// 等价写法：--dart-define=API_BASE_URL=http://<服务器地址>
///
/// 下面的默认值只是本机联调的兜底（FastAPI 监听 127.0.0.1:8000，见 config.json）。
/// 手机真机/生产环境请填 nginx 地址（80 端口，nginx 把 /api、/uploads 反代到后端），
/// 不要直连 8000——后端只绑本机回环。
class ApiService {
  static const String _defaultApiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://127.0.0.1:8000',
  );

  /// 当前生效的后端地址（「我的」页展示、排查连错环境用）
  static String get baseUrl => _defaultApiBaseUrl;

  /// 会话 cookie 名（与 Go / Python 两端一致）
  static const String cookieName = 'erp_token';

  static final Dio _dio = Dio(BaseOptions(
    baseUrl: _defaultApiBaseUrl,
    connectTimeout: const Duration(seconds: 30),
    receiveTimeout: const Duration(seconds: 60),
  ));

  static final CookieJar _cookieJar = CookieJar();
  static bool _initialized = false;
  static void Function()? _onUnauthorized;

  /// CookieJar 只有内存态，冷启动必掉登录；网页端靠浏览器存 cookie，
  /// App 得自己把 erp_token 另存一份到 SharedPreferences 再灌回去。
  static const String _cookiePrefsKey = 'erp_cookie';
  static final Uri _cookieUri = Uri.parse('$_defaultApiBaseUrl/');

  /// 401 时的回调（跳登录页由 AuthProvider 注册，service 不依赖 UI）。
  static void setOnUnauthorized(void Function()? cb) => _onUnauthorized = cb;

  static Future<void> init() async {
    if (_initialized) return;
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(_cookiePrefsKey);
    if (saved != null && saved.isNotEmpty) {
      await _cookieJar.saveFromResponse(_cookieUri, [Cookie.fromSetCookieValue(saved)]);
    }
    _dio.interceptors.add(CookieManager(_cookieJar));
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        // FormData 得留给 Dio 自己写 multipart boundary 和 Content-Type，
        // 这里无脑覆盖成 json 会让后端 /api/ai/parse-image 直接 422。
        if (options.data is! FormData) options.headers['Content-Type'] = 'application/json';
        return handler.next(options);
      },
    ));
    _initialized = true;
  }

  static Future<void> _clearAuth() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('erp_authed');
    await prefs.remove(_cookiePrefsKey);
    await _cookieJar.deleteAll();
  }

  // ---------------- 低层通用方法（保留给页面直接拼路径的用法） ----------------

  static Future<dynamic> get(String path, {Map<String, dynamic>? queryParameters}) async {
    return _send(() => _dio.get(path, queryParameters: queryParameters));
  }

  static Future<dynamic> post(String path, {dynamic data}) async {
    return _send(() => _dio.post(path, data: data));
  }

  static Future<dynamic> put(String path, {dynamic data}) async {
    return _send(() => _dio.put(path, data: data));
  }

  static Future<dynamic> delete(String path, {dynamic data}) async {
    return _send(() => _dio.delete(path, data: data));
  }

  /// multipart 上传（附件 / 聚水潭表格 / AI 识图）
  static Future<dynamic> upload(String path, String filePath, {String field = 'file'}) async {
    await init();
    final formData = FormData.fromMap({
      field: await MultipartFile.fromFile(filePath),
    });
    return _send(() => _dio.post(path, data: formData));
  }

  static Future<dynamic> _send(Future<Response> Function() action) async {
    await init();
    final Response response;
    try {
      response = await action();
    } on DioException catch (e) {
      final int? status = e.response?.statusCode;
      // Dio 默认 validateStatus 只放过 2xx，401 是直接抛异常进来的，
      // 走不到下面那段——所以掉线清理必须写在 catch 里，否则「登录已过期」永远不会跳登录页。
      if (status == 401) {
        await _clearAuth();
        _onUnauthorized?.call();
      }
      throw ApiException(status, _networkMessage(e));
    }
    final int code = response.statusCode ?? 0;
    if (code >= 400) {
      throw ApiException(code, _detailOf(response) ?? '请求失败（HTTP $code）');
    }
    final setCookie = response.headers.value('set-cookie');
    if (setCookie != null && setCookie.contains('$cookieName=')) {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getString(_cookiePrefsKey) != setCookie) {
        await prefs.setString(_cookiePrefsKey, setCookie);
      }
    }
    return response.data;
  }

  /// 网络层失败（请求根本没到后端）单独给文案，并带上当前后端地址——
  /// 真机最常见的坑就是打包时没注入 API_BASE_URL，落到了兜底的 127.0.0.1。
  static String _networkMessage(DioException e) {
    final detail = _detailOf(e.response);
    if (detail != null) return detail; // 后端已经回话了（4xx/5xx），优先用它的 detail
    return switch (e.type) {
      DioExceptionType.connectionTimeout => '连接后端超时（$baseUrl），请检查网络后重试',
      DioExceptionType.sendTimeout => '上传超时（$baseUrl），请检查网络后重试',
      DioExceptionType.receiveTimeout => '后端响应超时（$baseUrl），请稍后重试',
      DioExceptionType.connectionError =>
        '无法连接后端（$baseUrl），请确认后端在运行、手机能访问该地址',
      DioExceptionType.badCertificate => '证书校验失败（$baseUrl）',
      DioExceptionType.cancel => '请求已取消',
      // badResponse / unknown / 未来新增的枚举值都归到这里
      _ => '请求失败（$baseUrl）：${e.message ?? e.error ?? '未知错误'}',
    };
  }

  /// 错误信封是 {"detail": ...}：
  /// - 业务错误（400/401/404…）detail 是中文文案，直接用；
  /// - 请求体校验失败（FastAPI 422）detail 是 [{loc:[...,字段], msg:'Field required', …}]，
  ///   取第一条并转成中文，否则登录页会弹出一整块 Map 字符串。
  static String? _detailOf(Response? response) {
    final data = response?.data;
    if (data is! Map) return null;
    final d = data['detail'];
    if (d is String && d.isNotEmpty) return d;
    if (d is List && d.isNotEmpty) {
      final first = d.first;
      if (first is Map) {
        final loc = first['loc'];
        final field = (loc is List && loc.isNotEmpty) ? loc.last.toString() : '';
        final msg = _humanizePydantic(first['msg']?.toString() ?? '', field);
        if (msg.isNotEmpty) return msg;
      }
      return first.toString();
    }
    if (d != null) return d.toString();
    return null;
  }

  /// pydantic 的英文校验文案 → 中文（带上字段名）；认不出的原样返回，便于排查
  static String _humanizePydantic(String msg, String field) {
    final label = _fieldLabels[field] ?? field;
    switch (msg) {
      case 'Field required':
        return label.isEmpty ? '缺少必填参数' : '缺少必填参数：$label';
      case 'Input should be a valid integer':
        return label.isEmpty ? '参数必须是整数' : '$label 必须是整数';
      case 'Input should be a valid number':
        return label.isEmpty ? '参数必须是数字' : '$label 必须是数字';
      case 'Input should be a valid string':
        return label.isEmpty ? '参数必须是文本' : '$label 必须是文本';
      case 'Input should be a valid list':
        return label.isEmpty ? '参数必须是数组' : '$label 必须是数组';
      case 'String should have at least 1 character':
        return label.isEmpty ? '参数不能为空' : '$label 不能为空';
      case 'JSON decode error':
        return '请求体不是合法 JSON';
      default:
        return label.isEmpty ? msg : '$label：$msg';
    }
  }

  /// 后端字段名 → 界面中文名（只列 Flutter 真实会提交的键）
  static const Map<String, String> _fieldLabels = {
    'username': '用户名',
    'private_key': '私钥',
    'password': '密码',
    'date': '日期',
    'product_id': '商品',
    'quantity': '数量',
    'unit': '单位',
    'ids': '条目',
    'key': '分仓标识',
    'name': '名称',
    'file': '文件',
  };

  /// 去掉空查询参数（后端按「传了就过滤」处理，空串会被当成有效过滤值）
  static Map<String, dynamic>? _clean(Map<String, dynamic> query) {
    query.removeWhere((k, v) => v == null || (v is String && v.isEmpty) || k.isEmpty);
    return query.isEmpty ? null : query;
  }

  // ---------------- 会话 / 分仓 ----------------

  /// 口令登录：**仅 Go 试验后端（wsfc-erp-go）支持**。
  /// 生产 FastAPI 的 /api/auth/login 只接受 username + private_key，
  /// 走这条会因缺 private_key 收到 422「缺少必填参数：私钥」；保留只为本机连 Go 联调。
  static Future<Map<String, dynamic>> login(String username, String password) async {
    final data = await post('/api/auth/login', data: {'username': username, 'password': password});
    return Map<String, dynamic>.from(data as Map);
  }

  /// 私钥登录（**生产通道**）：与网页端同一套凭据——粘贴管理员分发的私钥文件全文。
  /// backend/app/keys.py 只接受 OpenSSH/PEM 的 Ed25519（ssh-ed25519），
  /// 其它类型或格式错误由后端回 400「私钥无法解析，请确认是 Ed25519 私钥文件内容」。
  static Future<Map<String, dynamic>> loginWithKey(String username, String privateKey) async {
    final data = await post('/api/auth/login', data: {'username': username, 'private_key': privateKey});
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<void> logout() async {
    await post('/api/auth/logout');
  }

  static Future<Map<String, dynamic>> me() async {
    return Map<String, dynamic>.from(await get('/api/auth/me') as Map);
  }

  /// 分仓：{current, warehouses:[{key, name, db, created_at, is_current}]}
  static Future<Map<String, dynamic>> warehouses() async {
    return Map<String, dynamic>.from(await get('/api/warehouses') as Map);
  }

  static Future<Map<String, dynamic>> createWarehouse(String key, String name) async {
    final data = await post('/api/warehouses', data: {'key': key, 'name': name});
    return Map<String, dynamic>.from(data as Map);
  }

  /// 切仓会重签会话 cookie，后续所有请求自动落到新仓
  static Future<Map<String, dynamic>> switchWarehouse(String key) async {
    final data = await post('/api/warehouses/switch', data: {'key': key});
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> maintenanceStatus() async {
    return Map<String, dynamic>.from(await get('/api/maintenance/status') as Map);
  }

  // ---------------- 工作台 ----------------

  /// 9 个键：today/month 汇总、低库存、最近出入库、鲜货提示等
  static Future<Map<String, dynamic>> dashboard() async {
    return Map<String, dynamic>.from(await get('/api/dashboard') as Map);
  }

  // ---------------- 商品 / 单位 ----------------

  /// 全量商品（含停用项，字段与后端 _to_dict 一致：last_in_* / stock_links / conversions 等）
  static Future<List<dynamic>> products() async {
    return await get('/api/products') as List<dynamic>;
  }

  static Future<List<dynamic>> stocks() async {
    return await get('/api/stocks') as List<dynamic>;
  }

  static Future<Map<String, dynamic>> createProduct(Map<String, dynamic> body) async {
    return Map<String, dynamic>.from(await post('/api/products', data: body) as Map);
  }

  static Future<Map<String, dynamic>> updateProduct(int id, Map<String, dynamic> body) async {
    return Map<String, dynamic>.from(await put('/api/products/$id', data: body) as Map);
  }

  /// 被单据引用时后端返回 400（detail 是多行说明），前端直接展示即可
  static Future<void> deleteProduct(int id) async {
    await delete('/api/products/$id');
  }

  /// {ok, deleted, blocked[], blocked_items[]}
  static Future<Map<String, dynamic>> batchDeleteProducts(List<int> ids) async {
    final data = await post('/api/products/batch-delete', data: {'ids': ids});
    return Map<String, dynamic>.from(data as Map);
  }

  /// 批量改字段：只传需要改的键（category / is_active / default_unit / sale_price 等）
  static Future<Map<String, dynamic>> batchUpdateProducts(List<int> ids, Map<String, dynamic> patch) async {
    final body = Map<String, dynamic>.from(patch);
    body['ids'] = ids;
    final data = await post('/api/products/batch-update', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<List<dynamic>> units() async {
    return await get('/api/units') as List<dynamic>;
  }

  static Future<Map<String, dynamic>> createUnit(Map<String, dynamic> body) async {
    return Map<String, dynamic>.from(await post('/api/units', data: body) as Map);
  }

  static Future<void> deleteUnit(int id) async {
    await delete('/api/units/$id');
  }

  // ---------------- 入库 ----------------

  /// 裸数组，按 id 倒序
  static Future<List<dynamic>> inbounds({String? dateFrom, String? dateTo}) async {
    return await get('/api/inbounds', queryParameters: _clean({'date_from': dateFrom, 'date_to': dateTo})) as List<dynamic>;
  }

  static Future<Map<String, dynamic>> createInbound(Map<String, dynamic> body) async {
    return Map<String, dynamic>.from(await post('/api/inbounds', data: body) as Map);
  }

  /// 批量入库：{ok, created, failed:[{row, reason}], failed_count, ids}
  static Future<Map<String, dynamic>> batchCreateInbounds(List<Map<String, dynamic>> items) async {
    final data = await post('/api/inbounds/batch', data: {'items': items});
    return Map<String, dynamic>.from(data as Map);
  }

  /// 只能改 供应商 / 日期 / 付款状态 / 运费 / 装卸费；freight、handling 传 null 表示按 0
  static Future<Map<String, dynamic>> updateInbound(int id, Map<String, dynamic> body) async {
    return Map<String, dynamic>.from(await put('/api/inbounds/$id', data: body) as Map);
  }

  static Future<void> deleteInbound(int id) async {
    await delete('/api/inbounds/$id');
  }

  static Future<Map<String, dynamic>> batchDeleteInbounds(List<int> ids) async {
    final data = await post('/api/inbounds/batch-delete', data: {'ids': ids});
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- 出库 ----------------

  /// 预览（不落库）：后端按 FIFO 算成本 / 快递费 / 预警，与提交同一套口径
  static Future<Map<String, dynamic>> previewOutbound({
    required List<Map<String, dynamic>> lines,
    List<Map<String, dynamic>> extraPackLines = const [],
    bool autoExpress = true,
    List<String>? settleCats,
  }) async {
    final data = await post('/api/outbounds/preview', data: {
      'lines': lines,
      'auto_express': autoExpress,
      'extra_pack_lines': extraPackLines,
      'settle_cats': settleCats,
    });
    return Map<String, dynamic>.from(data as Map);
  }

  /// 建单：返回 {order: {...}, warnings: [...]}
  static Future<Map<String, dynamic>> createOutbound(Map<String, dynamic> body) async {
    return Map<String, dynamic>.from(await post('/api/outbounds', data: body) as Map);
  }

  static Future<List<dynamic>> outbounds({String? dateFrom, String? dateTo, String? g}) async {
    return await get('/api/outbounds', queryParameters: _clean({'date_from': dateFrom, 'date_to': dateTo, 'g': g})) as List<dynamic>;
  }

  /// 改 客户 / 日期 / 付款状态 / 实收口径（settle_cats）
  static Future<Map<String, dynamic>> updateOutbound(int id, Map<String, dynamic> body) async {
    return Map<String, dynamic>.from(await put('/api/outbounds/$id', data: body) as Map);
  }

  static Future<void> deleteOutbound(int id) async {
    await delete('/api/outbounds/$id');
  }

  static Future<Map<String, dynamic>> batchDeleteOutbounds(List<int> ids) async {
    final data = await post('/api/outbounds/batch-delete', data: {'ids': ids});
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- 库存流水 / 盘点 ----------------

  /// 明细表：后端一次取全量再「合并出库 → 关键字 → 排序 → 切片」，返回
  /// {total, offset, limit, merged, keyword, sort, dir, truncated, rows}
  static Future<Map<String, dynamic>> movements({
    int? productId,
    String? dateFrom,
    String? dateTo,
    String? keyword,
    bool mergeOut = true,
    String sort = 'date',
    String dir = 'desc',
    int limit = 100,
    int offset = 0,
  }) async {
    final data = await get('/api/movements', queryParameters: _clean({
      'product_id': productId,
      'date_from': dateFrom,
      'date_to': dateTo,
      'keyword': keyword,
      'merge_out': mergeOut,
      'sort': sort,
      'dir': dir,
      'limit': limit,
      'offset': offset,
    }));
    return Map<String, dynamic>.from(data as Map);
  }

  /// 柱状图（日期 × 单位聚合，只统计真实库存进出，默认最近 30 天、最多 62 天）
  static Future<Map<String, dynamic>> movementsChart({int? productId, String? dateFrom, String? dateTo}) async {
    final data = await get('/api/movements/chart',
        queryParameters: _clean({'product_id': productId, 'date_from': dateFrom, 'date_to': dateTo}));
    return Map<String, dynamic>.from(data as Map);
  }

  /// 盘点：quantity / avg_cost_adj / unit_cost_adj 都只接受 +、- 开头的相对值，留空表示不调整
  static Future<Map<String, dynamic>> adjust({
    required int productId,
    required String date,
    String quantity = '',
    String unit = '',
    String avgCostAdj = '',
    String unitCostAdj = '',
    String remark = '',
  }) async {
    final data = await post('/api/adjust', data: {
      'product_id': productId,
      'date': date,
      'quantity': quantity,
      'unit': unit,
      'avg_cost_adj': avgCostAdj,
      'unit_cost_adj': unitCostAdj,
      'remark': remark,
    });
    return Map<String, dynamic>.from(data as Map);
  }

  /// 盘点调整记录（按一次盘点分组，可整组回退）
  static Future<List<dynamic>> adjustments({int? productId, String? dateFrom, String? dateTo}) async {
    final data = await get('/api/adjustments',
        queryParameters: _clean({'product_id': productId, 'date_from': dateFrom, 'date_to': dateTo}));
    return data as List<dynamic>;
  }

  static Future<Map<String, dynamic>> deleteAdjustment(int groupId) async {
    final data = await delete('/api/adjustments/$groupId');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<List<dynamic>> stockOverview() async {
    final data = await get('/api/stock-overview');
    return data as List<dynamic>;
  }

  /// 人工 / 快递工作量统计
  static Future<Map<String, dynamic>> workload({String? dateFrom, String? dateTo}) async {
    final data = await get('/api/workload', queryParameters: _clean({'date_from': dateFrom, 'date_to': dateTo}));
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- 鲜货 ----------------

  /// {items:[{id,name,category,unit,stock,avg_cost,stock_value}], ids:[…]}
  static Future<Map<String, dynamic>> fresh({bool onlyList = false}) async {
    final data = await get('/api/fresh', queryParameters: _clean({'only_list': onlyList ? '1' : null}));
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> freshOptions({String scope = ''}) async {
    final data = await get('/api/fresh/options', queryParameters: _clean({'scope': scope}));
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> saveFreshConfig(List<int> ids) async {
    final data = await post('/api/fresh/config', data: {'ids': ids});
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- 其他开支 ----------------

  static Future<List<dynamic>> otherExpenses({String? dateFrom, String? dateTo, String? category}) async {
    final data = await get('/api/other-expenses',
        queryParameters: _clean({'date_from': dateFrom, 'date_to': dateTo, 'category': category}));
    return data as List<dynamic>;
  }

  /// 今日/本月（不受区间影响）+ 区间合计 + 分类/按日/按月聚合 + 预设类别
  static Future<Map<String, dynamic>> otherExpenseStats({String? dateFrom, String? dateTo}) async {
    final data = await get('/api/other-expenses/stats',
        queryParameters: _clean({'date_from': dateFrom, 'date_to': dateTo}));
    return Map<String, dynamic>.from(data as Map);
  }

  /// 返回 {ok, item}
  static Future<Map<String, dynamic>> createOtherExpense(Map<String, dynamic> body) async {
    final data = await post('/api/other-expenses', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> updateOtherExpense(int id, Map<String, dynamic> body) async {
    final data = await put('/api/other-expenses/$id', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<void> deleteOtherExpense(int id) async {
    await delete('/api/other-expenses/$id');
  }

  // ---------------- 扣点 / 快递 / 打包规则 ----------------

  static Future<List<dynamic>> deductions() async {
    final data = await get('/api/deductions');
    return data as List<dynamic>;
  }

  static Future<Map<String, dynamic>> upsertDeduction(String category, double percent, {String remark = ''}) async {
    final data = await post('/api/deductions', data: {'category': category, 'percent': percent, 'remark': remark});
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<void> deleteDeduction(int id) async {
    await delete('/api/deductions/$id');
  }

  /// 店铺扣点：GET 返回 {file, rules}，写接口返回 {ok, rules}
  static Future<Map<String, dynamic>> shopDeductions() async {
    final data = await get('/api/deductions/shops');
    return Map<String, dynamic>.from(data as Map);
  }

  /// body: {shop, percent} 或 {shop, categories:{蔬菜:7, 水果:9}}
  static Future<Map<String, dynamic>> upsertShopDeduction(Map<String, dynamic> body) async {
    final data = await post('/api/deductions/shops', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> deleteShopDeduction(String shop) async {
    final data = await delete('/api/deductions/shops/${Uri.encodeComponent(shop)}');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> expressRule() async {
    final data = await get('/api/express/rule');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> saveExpressRule(Map<String, dynamic> body) async {
    final data = await put('/api/express/rule', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<List<dynamic>> packRules() async {
    final data = await get('/api/pack-rules');
    return data as List<dynamic>;
  }

  /// 组合名（name）由后端按商品真名与数量生成，前端传什么都不影响键值
  static Future<Map<String, dynamic>> createPackRule(Map<String, dynamic> body) async {
    final data = await post('/api/pack-rules', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> updatePackRule(int id, Map<String, dynamic> body) async {
    final data = await put('/api/pack-rules/$id', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<void> deletePackRule(int id) async {
    await delete('/api/pack-rules/$id');
  }

  // ---------------- 账单 / 财务 ----------------

  /// {items:[{kind,id,title,sub,amount,direction,source,page,pay_status,paid_at,date,operator}],
  ///  total:{unpaid_count,payables_amount,receivables_amount,paid_count}}
  static Future<Map<String, dynamic>> payables({bool includePaid = false, int days = 30}) async {
    final data = await get('/api/payables', queryParameters: {'include_paid': includePaid ? 1 : 0, 'days': days});
    return Map<String, dynamic>.from(data as Map);
  }

  /// kind: inbound / outbound / warehouse_in / otherexp / finance
  static Future<Map<String, dynamic>> payBill(String kind, int id, {bool paid = true}) async {
    final data = await post('/api/payables/pay', data: {'kind': kind, 'id': id, 'paid': paid});
    return Map<String, dynamic>.from(data as Map);
  }

  /// {ok, kind, updated, missing}
  static Future<Map<String, dynamic>> payBillsBatch(String kind, List<int> ids, {bool paid = true}) async {
    final data = await post('/api/payables/pay-batch', data: {'kind': kind, 'ids': ids, 'paid': paid});
    return Map<String, dynamic>.from(data as Map);
  }

  /// 代发应付：{groups:[…], truncated, limit, total:{…}}
  static Future<Map<String, dynamic>> dropshipBills({String? dateFrom, String? dateTo, bool includePaid = false, int limit = 300}) async {
    final data = await get('/api/payables/dropship', queryParameters: _clean({
      'date_from': dateFrom,
      'date_to': dateTo,
      'include_paid': includePaid ? 1 : null,
      'limit': limit,
    }));
    return Map<String, dynamic>.from(data as Map);
  }

  /// 财务流水；wh=all 时合并各分仓（每条多一个 warehouse 名字段）
  static Future<List<dynamic>> finance({String? dateFrom, String? dateTo, String wh = ''}) async {
    final data = await get('/api/finance', queryParameters: _clean({'date_from': dateFrom, 'date_to': dateTo, 'wh': wh}));
    return data as List<dynamic>;
  }

  static Future<Map<String, dynamic>> createFinance(Map<String, dynamic> body) async {
    final data = await post('/api/finance', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<void> deleteFinance(int id) async {
    await delete('/api/finance/$id');
  }

  // ---------------- 附件 ----------------

  /// 返回 {url, name, size, is_image}；url 形如 /uploads/attach_xxx.png
  static Future<Map<String, dynamic>> uploadAttachment(String filePath) async {
    final data = await upload('/api/uploads', filePath);
    return Map<String, dynamic>.from(data as Map);
  }

  /// 把后端返回的相对附件地址拼成可访问的完整 URL
  static String resolveUrl(String? url) {
    if (url == null || url.isEmpty) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return _defaultApiBaseUrl + (url.startsWith('/') ? '' : '/') + url;
  }

  /// 带会话 Cookie 下载二进制（导入模板、备份文件、导出 JSON）
  static Future<void> download(String path, String savePath, {Map<String, dynamic>? query}) async {
    await init();
    try {
      final response = await _dio.get(
        path,
        queryParameters: query == null ? null : _clean(query),
        options: Options(responseType: ResponseType.bytes),
      );
      await File(savePath).writeAsBytes(response.data as List<int>);
    } on DioException catch (e) {
      throw ApiException(e.response?.statusCode, _networkMessage(e));
    }
  }

  /// 带会话 Cookie 拉一段文本（远程备份收发脚本）
  static Future<String> getText(String path) async {
    await init();
    try {
      final response = await _dio.get(path, options: Options(responseType: ResponseType.plain));
      if ((response.statusCode ?? 0) >= 400) {
        throw ApiException(response.statusCode, '拉取失败');
      }
      return response.data.toString();
    } on DioException catch (e) {
      throw ApiException(e.response?.statusCode, _networkMessage(e));
    }
  }

  // ---------------- 报表 ----------------

  /// 报表汇总。[wh] 传 'all' 合并各分仓；空串=当前工作分仓
  static Future<Map<String, dynamic>> reportSummary({
    String dateFrom = '',
    String dateTo = '',
    String wh = '',
    bool excludeOther = true,
  }) async {
    final data = await get('/api/report/summary', queryParameters: _clean({
      'date_from': dateFrom,
      'date_to': dateTo,
      'wh': wh,
      'exclude_other': excludeOther ? '1' : '0',
    }));
    return Map<String, dynamic>.from(data as Map);
  }

  /// 各分仓总览（全仓视角的那张表）
  static Future<Map<String, dynamic>> reportAllWarehouses({
    String dateFrom = '',
    String dateTo = '',
    bool excludeOther = true,
  }) async {
    final data = await get('/api/report/all-warehouses', queryParameters: _clean({
      'date_from': dateFrom,
      'date_to': dateTo,
      'exclude_other': excludeOther ? '1' : '0',
    }));
    return Map<String, dynamic>.from(data as Map);
  }

  /// 出库明细（按天 × 规格）
  static Future<Map<String, dynamic>> reportSalesBySpec({String dateFrom = '', String dateTo = '', String wh = ''}) async {
    final data = await get('/api/report/sales-by-spec',
        queryParameters: _clean({'date_from': dateFrom, 'date_to': dateTo, 'wh': wh}));
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- 入仓 ----------------

  /// {items, by_product, total, count}
  static Future<Map<String, dynamic>> warehouseIns({String dateFrom = '', String dateTo = '', String q = ''}) async {
    final data = await get('/api/warehouse-in',
        queryParameters: _clean({'date_from': dateFrom, 'date_to': dateTo, 'q': q}));
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> createWarehouseIn(Map<String, dynamic> body) async {
    final data = await post('/api/warehouse-in', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> updateWarehouseIn(int id, Map<String, dynamic> body) async {
    final data = await put('/api/warehouse-in/$id', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<void> deleteWarehouseIn(int id) async {
    await delete('/api/warehouse-in/$id');
  }

  static Future<Map<String, dynamic>> batchDeleteWarehouseIns(List<int> ids) async {
    final data = await post('/api/warehouse-in/batch-delete', data: {'ids': ids});
    return Map<String, dynamic>.from(data as Map);
  }

  /// 入仓品资料
  static Future<List<dynamic>> warehouseProducts() async {
    return await get('/api/warehouse-in/products') as List<dynamic>;
  }

  static Future<Map<String, dynamic>> createWarehouseProduct(Map<String, dynamic> body) async {
    final data = await post('/api/warehouse-in/products', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> updateWarehouseProduct(int id, Map<String, dynamic> body) async {
    final data = await put('/api/warehouse-in/products/$id', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<void> deleteWarehouseProduct(int id) async {
    await delete('/api/warehouse-in/products/$id');
  }

  /// 入仓品扣点（单值，存的是 category=入仓品 那条规则）
  static Future<Map<String, dynamic>> warehouseDeduction() async {
    final data = await get('/api/warehouse-in/deduction');
    return Map<String, dynamic>.from(data as Map);
  }

  /// Excel 贴单导入：preview 返回待确认行，confirm 才落库
  static Future<Map<String, dynamic>> warehouseImportPreview(String filePath, {String sheet = '', String date = ''}) async {
    await init();
    final formData = FormData.fromMap({
      'file': await MultipartFile.fromFile(filePath),
      'sheet': sheet,
      'date': date,
    });
    return Map<String, dynamic>.from(await _send(() => _dio.post('/api/warehouse-in/import/preview', data: formData)) as Map);
  }

  static Future<Map<String, dynamic>> warehouseImportConfirm(List<Map<String, dynamic>> items, {String date = ''}) async {
    final data = await post('/api/warehouse-in/import/confirm', data: {'items': items, 'date': date});
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- 批量导入 / 模板 ----------------

  static String templatePath(String kind) => '/api/templates/$kind';

  /// {created, skipped, failed_count, failed:[{row,reason}], warnings:[]}
  static Future<Map<String, dynamic>> importProducts(String filePath) async {
    final data = await upload('/api/import/products', filePath);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> previewImportInbounds(String filePath) async {
    final data = await upload('/api/import/inbounds/preview', filePath);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> confirmImportInbounds(List<Map<String, dynamic>> items) async {
    final data = await post('/api/import/inbounds/confirm', data: {'items': items});
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> previewImportOutbounds(String filePath) async {
    final data = await upload('/api/import/outbounds/preview', filePath);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> confirmImportOutbounds(List<Map<String, dynamic>> orders, {String source = ''}) async {
    final data = await post('/api/import/outbounds/confirm', data: {'orders': orders, 'source': source});
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> previewImportJushuitan(String filePath) async {
    final data = await upload('/api/jushuitan/import/preview', filePath);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> confirmImportJushuitan(List<Map<String, dynamic>> orders, {String source = ''}) async {
    final data = await post('/api/jushuitan/import/confirm', data: {'orders': orders, 'source': source});
    return Map<String, dynamic>.from(data as Map);
  }

  /// 只解析建编码关联、不建出库单
  static Future<Map<String, dynamic>> parseJushuitan(String filePath) async {
    final data = await upload('/api/jushuitan/parse', filePath);
    return Map<String, dynamic>.from(data as Map);
  }

  /// 鲜货现采：今日订单需求 vs 库存（不扣库存，只出建议）
  static Future<Map<String, dynamic>> freshPlan(String filePath) async {
    final data = await upload('/api/fresh/plan', filePath);
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- 聚水潭编码关联 ----------------

  /// {summary:{total,linked,unlinked,linked_order,linked_stock}, items:[…]}
  static Future<Map<String, dynamic>> mappings() async {
    final data = await get('/api/mappings');
    return Map<String, dynamic>.from(data as Map);
  }

  /// product_id 传 null 表示清空关联
  static Future<Map<String, dynamic>> saveMapping({String externalCode = '', int? productId, String source = 'jushuitan'}) async {
    final data = await post('/api/mappings',
        data: {'source': source, 'external_code': externalCode, 'product_id': productId});
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> autoMapping() async {
    final data = await post('/api/mappings/auto');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<void> deleteMapping(int id) async {
    await delete('/api/mappings/$id');
  }

  static Future<void> clearMappings() async {
    await delete('/api/mappings');
  }

  /// 把聚水潭一单多货写成组合规则
  static Future<Map<String, dynamic>> packRuleFromJushuitan({
    required String docNo,
    required List<Map<String, dynamic>> items,
  }) async {
    final data = await post('/api/pack-rules/from-jushuitan', data: {'doc_no': docNo, 'items': items});
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- 备份 / 商品资料 JSON ----------------

  /// {config, backups, json_backups, remote_status}
  static Future<Map<String, dynamic>> backups() async {
    final data = await get('/api/backups');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> createBackup() async {
    final data = await post('/api/backup');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> saveBackupConfig(Map<String, dynamic> body) async {
    final data = await post('/api/backup/config', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<void> restoreBackup(String name) async {
    await post('/api/backup/restore', data: {'name': name});
  }

  static Future<Map<String, dynamic>> deleteBackup(String name) async {
    final data = await delete('/api/backup/${Uri.encodeComponent(name)}');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<String> remoteScript(String which) async =>
      getText('/api/backup/remote/$which-script');

  /// {dir, rows:[{kind,label,file,count_in_db,count_in_file,exists,mtime}]}
  static Future<Map<String, dynamic>> productDataStatus() async {
    final data = await get('/api/product-data/status');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<dynamic> productDataPayload(String kind) async => get('/api/product-data/$kind');

  static Future<Map<String, dynamic>> productDataExport() async {
    final data = await post('/api/product-data/export');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> productDataImport() async {
    final data = await post('/api/product-data/import');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> productDataImportKind(String kind) async {
    final data = await post('/api/product-data/import/$kind');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> productDataImportOne(Map<String, dynamic> payload) async {
    final data = await post('/api/product-data/import-one', data: {'payload': payload});
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- 聚水潭自动出库 ----------------

  static Future<Map<String, dynamic>> jstSettings() async {
    final data = await get('/api/jst-auto/settings');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> saveJstSettings(Map<String, dynamic> body) async {
    final data = await post('/api/jst-auto/settings', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> jstCheck() async {
    final data = await post('/api/jst-auto/check');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> jstWarehouses() async {
    final data = await post('/api/jst-auto/jst-warehouses');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> jstRun({bool doImport = true, String window = '', String start = '', String end = ''}) async {
    final data = await post('/api/jst-auto/run',
        data: _clean({'do_import': doImport, 'window': window, 'start': start, 'end': end}));
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> jstStatus() async {
    final data = await get('/api/jst-auto/status');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> jstHistory({int limit = 20}) async {
    final data = await get('/api/jst-auto/history', queryParameters: {'limit': limit});
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> jstPending() async {
    final data = await get('/api/jst-auto/pending');
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> jstResolvePending(int taskId, Map<String, dynamic> body) async {
    final data = await post('/api/jst-auto/pending/$taskId/resolve', data: body);
    return Map<String, dynamic>.from(data as Map);
  }

  static Future<Map<String, dynamic>> jstDismissPending(int taskId) async {
    final data = await post('/api/jst-auto/pending/$taskId/dismiss');
    return Map<String, dynamic>.from(data as Map);
  }

  // ---------------- AI 智能录入（/api/ai） ----------------

  /// 文本识别。后端先走本地规则快速解析，不中再调大模型，返回规范化单据。
  static Future<Map<String, dynamic>> aiParse(String text) async {
    final data = await post('/api/ai/parse', data: {'text': text});
    return Map<String, dynamic>.from(data as Map);
  }

  /// 票据图片识别。后端这条只有 SSE 流式接口，真正的单据只在最后一条
  /// `data: {"result": …}` 事件里；中间的 stage/think/delta 只够用来刷进度文案。
  /// 大模型识别一张票据要几十秒，接收超时单独放宽到 5 分钟。
  static Future<Map<String, dynamic>> aiParseImage(
    String filePath, {
    String text = '',
    void Function(String stage)? onStage,
  }) async {
    await init();
    final form = FormData.fromMap({
      'file': await MultipartFile.fromFile(
        filePath,
        filename: filePath.split(RegExp(r'[/\\]')).last,
      ),
      'text': text,
    });
    final Response<ResponseBody> res;
    try {
      res = await _dio.post<ResponseBody>(
        '/api/ai/parse-image/stream',
        data: form,
        options: Options(
          responseType: ResponseType.stream,
          receiveTimeout: const Duration(minutes: 5),
          headers: {'Accept': 'text/event-stream'},
        ),
      );
    } on DioException catch (e) {
      throw ApiException(e.response?.statusCode, _networkMessage(e));
    }

    Map<String, dynamic>? result;
    String? failure;
    // 按字节块解码会把跨块的汉字截断，所以先过一遍 utf8 decoder 再切事件
    var buf = '';
    await for (final piece in utf8.decoder.bind(res.data!.stream)) {
      buf += piece;
      var cut = buf.indexOf('\n\n');
      while (cut >= 0) {
        for (final line in buf.substring(0, cut).split('\n')) {
          if (!line.startsWith('data:')) continue;
          final payload = line.substring(5).trim();
          if (payload.isEmpty) continue;
          final dynamic obj;
          try {
            obj = jsonDecode(payload);
          } catch (_) {
            continue;
          }
          if (obj is! Map) continue;
          final m = Map<String, dynamic>.from(obj);
          if (m['error'] != null) {
            failure = m['error'].toString();
          } else if (m['result'] is Map) {
            result = Map<String, dynamic>.from(m['result'] as Map);
          } else if (m['stage'] != null) {
            onStage?.call(m['stage'].toString());
          }
        }
        buf = buf.substring(cut + 2);
        cut = buf.indexOf('\n\n');
      }
    }
    if (result == null) {
      throw ApiException(502, failure ?? '识别失败：后端未返回结果');
    }
    return result;
  }

  /// 把识别出的「新物品」真正写进商品档案（识别阶段不写库，确认提交时才建）。
  /// 返回与入参同序的 `[{name, product_id, category, created}]`。
  static Future<List<dynamic>> aiMaterialize(List<Map<String, dynamic>> items) async {
    if (items.isEmpty) return const [];
    final data = await post('/api/ai/products', data: {'items': items});
    return (data as Map)['items'] as List<dynamic>? ?? const [];
  }
}
