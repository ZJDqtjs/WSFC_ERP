import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../services/api_service.dart';

class AuthProvider extends ChangeNotifier {
  Map<String, dynamic> _user = {};
  bool _isLoggedIn = false;
  bool _isLoading = false;

  Map<String, dynamic> get user => _user;
  bool get isLoggedIn => _isLoggedIn;
  bool get isLoading => _isLoading;

  AuthProvider() {
    _checkAuth();
  }

  Future<void> _checkAuth() async {
    final prefs = await SharedPreferences.getInstance();
    final authed = prefs.getBool('erp_authed') ?? false;
    if (authed) {
      await fetchUserInfo();
    }
  }

  Future<void> login(String username, String password) async {
    _isLoading = true;
    notifyListeners();

    try {
      final response = await ApiService.post('/api/auth/login', data: {
        'username': username,
        'password': password,
      });

      if (response['ok'] == true) {
        _user = response['user'] ?? {};
        _isLoggedIn = true;

        final prefs = await SharedPreferences.getInstance();
        await prefs.setBool('erp_authed', true);
      } else {
        throw Exception('登录失败');
      }
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<Map<String, dynamic>> fetchUserInfo() async {
    try {
      final response = await ApiService.get('/api/auth/me');
      _user = response;
      _isLoggedIn = true;
      notifyListeners();
      return _user;
    } catch (e) {
      _isLoggedIn = false;
      notifyListeners();
      rethrow;
    }
  }

  Future<void> logout() async {
    try {
      await ApiService.post('/api/auth/logout');
    } catch (e) {
      // 忽略错误
    }

    _user = {};
    _isLoggedIn = false;

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('erp_authed');

    notifyListeners();
  }
}
