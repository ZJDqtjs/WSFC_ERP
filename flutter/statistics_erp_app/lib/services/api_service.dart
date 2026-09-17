import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:cookie_jar/cookie_jar.dart';
import 'package:shared_preferences/shared_preferences.dart';

class ApiService {
  // 后端地址在编译期注入，不要写死在这里（仓库是公开的，内网/生产地址不进代码）：
  //   flutter run       --dart-define-from-file=dart_defines.local.json
  //   flutter build apk --release --dart-define-from-file=dart_defines.local.json
  // 等价写法：--dart-define=API_BASE_URL=http://<服务器地址>
  // 下面的 defaultValue 只是本机联调的兜底，不是给正式包用的。
  static const String _defaultApiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://127.0.0.1:8000',
  );

  static final Dio _dio = Dio(BaseOptions(
    baseUrl: _defaultApiBaseUrl,
    connectTimeout: const Duration(seconds: 30),
    receiveTimeout: const Duration(seconds: 30),
  ));

  static final _cookieJar = CookieJar();

  static bool _initialized = false;

  static Future<void> init() async {
    if (_initialized) return;

    _dio.interceptors.add(CookieManager(_cookieJar));
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        // 添加请求头
        options.headers['Content-Type'] = 'application/json';
        return handler.next(options);
      },
      onResponse: (response, handler) {
        return handler.next(response);
      },
      onError: (error, handler) {
        if (error.response?.statusCode == 401) {
          // 未登录，清除本地状态
          _clearAuth();
        }
        return handler.next(error);
      },
    ));

    _initialized = true;
  }

  static Future<void> _clearAuth() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('erp_authed');
  }

  static Future<dynamic> get(String path,
      {Map<String, dynamic>? queryParameters}) async {
    await init();
    final response = await _dio.get(path, queryParameters: queryParameters);
    return response.data;
  }

  static Future<dynamic> post(String path, {dynamic data}) async {
    await init();
    final response = await _dio.post(path, data: data);
    return response.data;
  }

  static Future<dynamic> put(String path, {dynamic data}) async {
    await init();
    final response = await _dio.put(path, data: data);
    return response.data;
  }

  static Future<dynamic> delete(String path) async {
    await init();
    final response = await _dio.delete(path);
    return response.data;
  }

  /// 上传文件（用于 AI 图片识别）
  static Future<dynamic> upload(String path, String filePath) async {
    await init();
    final formData = FormData.fromMap({
      'file': await MultipartFile.fromFile(filePath),
    });
    final response = await _dio.post(path, data: formData);
    return response.data;
  }
}
