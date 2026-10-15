import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../services/api_service.dart';

/// 登录态：只关心「会话是否有效」和「当前在哪个分仓」。
///
/// 后端用 erp_token cookie 承载身份（Go 与 Python 两端同签名），
/// 所以这里不存 token，只存一个本地标记 erp_authed，真正的校验走 /api/auth/me。
class AuthProvider extends ChangeNotifier {
  Map<String, dynamic> _user = {};
  bool _isLoggedIn = false;
  bool _isLoading = false;
  String _warehouseKey = '';
  String _warehouseName = '';
  List<dynamic> _warehouses = [];
  String _error = '';

  Map<String, dynamic> get user => _user;
  bool get isLoggedIn => _isLoggedIn;
  bool get isLoading => _isLoading;
  String get warehouseKey => _warehouseKey;
  String get warehouseName => _warehouseName;
  List<dynamic> get warehouses => _warehouses;
  String get error => _error;
  String get displayName {
    final name = (_user['name'] ?? '').toString();
    if (name.isNotEmpty) return name;
    return (_user['username'] ?? '用户').toString();
  }

  AuthProvider() {
    // 401 统一在这里收敛：清登录态，由路由的 refreshListenable 把用户送回登录页
    ApiService.setOnUnauthorized(() {
      if (_isLoggedIn) {
        _isLoggedIn = false;
        _user = {};
        _error = '登录已过期，请重新登录';
        notifyListeners();
      }
    });
    _checkAuth();
  }

  Future<void> _checkAuth() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool('erp_authed') ?? false) {
      await fetchUserInfo();
    }
  }

  Future<void> login(String username, String password) async {
    _isLoading = true;
    _error = '';
    notifyListeners();
    try {
      final response = await ApiService.login(username, password);
      await _applySession(response);
    } on ApiException catch (e) {
      _error = e.message;
      rethrow;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  /// 私钥登录（与网页端同一套凭据，Android 端只需粘贴私钥文本）
  Future<void> loginWithKey(String username, String privateKey) async {
    _isLoading = true;
    _error = '';
    notifyListeners();
    try {
      final response = await ApiService.loginWithKey(username, privateKey);
      await _applySession(response);
    } on ApiException catch (e) {
      _error = e.message;
      rethrow;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> _applySession(Map<String, dynamic> response) async {
    _user = (response['user'] as Map?)?.cast<String, dynamic>() ?? const {};
    final wh = (response['warehouse'] as Map?);
    _warehouseKey = (wh?['key'] ?? '').toString();
    _warehouseName = (wh?['name'] ?? '').toString();
    _isLoggedIn = true;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('erp_authed', true);
    refreshWarehouses();
  }

  Future<Map<String, dynamic>> fetchUserInfo() async {
    try {
      final response = await ApiService.me();
      _user = response;
      final wh = (response['warehouse'] as Map?);
      if (wh != null) {
        _warehouseKey = (wh['key'] ?? '').toString();
        _warehouseName = (wh['name'] ?? '').toString();
      }
      _isLoggedIn = true;
      notifyListeners();
      return _user;
    } on ApiException catch (e) {
      _isLoggedIn = false;
      _error = e.message;
      notifyListeners();
      rethrow;
    }
  }

  /// 分仓清单：登录态下才能取（未登录时后端 401，这里直接吞掉）
  Future<void> refreshWarehouses() async {
    try {
      final data = await ApiService.warehouses();
      _warehouses = (data['warehouses'] as List?) ?? const [];
      _warehouseKey = (data['current'] ?? _warehouseKey).toString();
      for (final w in _warehouses) {
        if (w is Map && w['key'].toString() == _warehouseKey) {
          _warehouseName = (w['name'] ?? '').toString();
        }
      }
      notifyListeners();
    } on ApiException catch (_) {
      // 未登录或无权限：保持原样
    }
  }

  /// 切仓：后端重签会话 cookie，之后所有接口都打到新仓；同时清空商品缓存。
  Future<void> switchWarehouse(String key) async {
    _isLoading = true;
    _error = '';
    notifyListeners();
    try {
      final data = await ApiService.switchWarehouse(key);
      final wh = (data['warehouse'] as Map?);
      _warehouseKey = (wh?['key'] ?? key).toString();
      _warehouseName = (wh?['name'] ?? '').toString();
      await refreshWarehouses();
    } on ApiException catch (e) {
      _error = e.message;
      rethrow;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> logout() async {
    try {
      await ApiService.logout();
    } on ApiException catch (_) {
      // 登出失败也要清本地状态
    }
    _user = {};
    _isLoggedIn = false;
    _warehouses = [];
    _warehouseKey = '';
    _warehouseName = '';
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('erp_authed');
    notifyListeners();
  }
}
