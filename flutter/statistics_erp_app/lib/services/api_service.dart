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

/// 与 Go 后端（wsfc-erp-go）对接的唯一入口。
///
/// 后端地址在编译期注入，不要写死在这里（仓库是公开的，内网/生产地址不进代码）：
///   flutter run       --dart-define-from-file=dart_defines.local.json
///   flutter build apk --release --dart-define-from-file=dart_defines.local.json
/// 等价写法：--dart-define=API_BASE_URL=http://<服务器地址>
/// 下面的默认值只是本机联调的兜底（Go 默认监听 :8100）。
class ApiService {
  static const String _defaultApiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://127.0.0.1:8100',
  );

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

  /// 401 时的回调（跳登录页由 AuthProvider 注册，service 不依赖 UI）。
  static void setOnUnauthorized(void Function()? cb) => _onUnauthorized = cb;

  static Future<void> init() async {
    if (_initialized) return;
    _dio.interceptors.add(CookieManager(_cookieJar));
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        options.headers['Content-Type'] = 'application/json';
        return handler.next(options);
      },
    ));
    _initialized = true;
  }

  static Future<void> _clearAuth() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('erp_authed');
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
      throw ApiException(e.response?.statusCode, _detailOf(e.response) ?? ('网络异常：${e.message}'));
    }
    final int code = response.statusCode ?? 0;
    if (code == 401) {
      await _clearAuth();
      _onUnauthorized?.call();
    }
    if (code >= 400) {
      throw ApiException(code, _detailOf(response) ?? '请求失败（HTTP $code）');
    }
    return response.data;
  }

  static String? _detailOf(Response? response) {
    final data = response?.data;
    if (data is! Map) return null;
    final d = data['detail'];
    if (d is String && d.isNotEmpty) return d;
    // Python 的 422 会回数组；Go 统一回中文文案，这里兜底取第一条
    if (d is List && d.isNotEmpty) return d.first.toString();
    if (d != null) return d.toString();
    return null;
  }

  /// 去掉空查询参数（后端按「传了就过滤」处理，空串会被当成有效过滤值）
  static Map<String, dynamic>? _clean(Map<String, dynamic> query) {
    query.removeWhere((k, v) => v == null || (v is String && v.isEmpty) || k.isEmpty);
    return query.isEmpty ? null : query;
  }

  // ---------------- 会话 / 分仓 ----------------

  /// 口令登录（安卓端不在手机里管私钥文件）。返回 {id, username, name, role, warehouse}。
  static Future<Map<String, dynamic>> login(String username, String password) async {
    final data = await post('/api/auth/login', data: {'username': username, 'password': password});
    return Map<String, dynamic>.from(data as Map);
  }

  /// 私钥登录（与网页端同一套凭据：粘贴 OpenSSH Ed25519 私钥全文）。
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
}
