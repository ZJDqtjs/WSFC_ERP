import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import 'providers/auth_provider.dart';
import 'providers/product_provider.dart';
import 'screens/login_screen.dart';
import 'screens/home_screen.dart';
import 'screens/fresh_screen.dart';
import 'screens/outbound_screen.dart';
import 'screens/inbound_screen.dart';
import 'screens/stock_screen.dart';
import 'screens/mine_screen.dart';
import 'screens/payables_screen.dart';
import 'screens/expenses_screen.dart';
import 'screens/finance_screen.dart';
import 'screens/products_screen.dart';
import 'screens/rules_screen.dart';

void main() {
  runApp(const StatisticsErpApp());
}

/// 应用根：AuthProvider 同时作为 GoRouter 的 refreshListenable，
/// 401（cookie 过期 / 被踢）时由 ApiService 清会话 → notifyListeners → redirect 自动回登录页。
class StatisticsErpApp extends StatefulWidget {
  const StatisticsErpApp({super.key});

  @override
  State<StatisticsErpApp> createState() => _StatisticsErpAppState();
}

class _StatisticsErpAppState extends State<StatisticsErpApp> {
  final AuthProvider _auth = AuthProvider();

  late final GoRouter _router = GoRouter(
    initialLocation: '/login',
    refreshListenable: _auth,
    redirect: (context, state) {
      final loggingIn = state.uri.path == '/login';
      if (!_auth.isLoggedIn) {
        return loggingIn ? null : '/login';
      }
      // 已登录还停在登录页（含冷启动读本地会话成功）就直接进工作台
      return loggingIn ? '/home' : null;
    },
    routes: [
      GoRoute(
        path: '/login',
        name: 'login',
        builder: (context, state) => const LoginScreen(),
      ),
      ShellRoute(
        builder: (context, state, child) => MainLayout(child: child),
        routes: [
          GoRoute(path: '/home', name: 'home', builder: (c, s) => const HomeScreen()),
          GoRoute(path: '/fresh', name: 'fresh', builder: (c, s) => const FreshScreen()),
          GoRoute(
              path: '/outbound',
              name: 'outbound',
              builder: (c, s) => const OutboundScreen()),
          GoRoute(
              path: '/inbound',
              name: 'inbound',
              builder: (c, s) => const InboundScreen()),
          GoRoute(path: '/stock', name: 'stock', builder: (c, s) => const StockScreen()),
          GoRoute(path: '/mine', name: 'mine', builder: (c, s) => const MineScreen()),
          GoRoute(
              path: '/products',
              name: 'products',
              builder: (c, s) => const ProductsScreen()),
          GoRoute(
              path: '/payables',
              name: 'payables',
              builder: (c, s) => const PayablesScreen()),
          GoRoute(
              path: '/expenses',
              name: 'expenses',
              builder: (c, s) => const ExpensesScreen()),
          GoRoute(
              path: '/finance',
              name: 'finance',
              builder: (c, s) => const FinanceScreen()),
          GoRoute(path: '/rules', name: 'rules', builder: (c, s) => const RulesScreen()),
        ],
      ),
    ],
  );

  @override
  void dispose() {
    _auth.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthProvider>.value(value: _auth),
        ChangeNotifierProvider(create: (_) => ProductProvider()),
      ],
      child: MaterialApp.router(
        title: '企业台账',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(
            seedColor: const Color(0xFF1989FA),
            brightness: Brightness.light,
          ),
          appBarTheme: const AppBarTheme(
            backgroundColor: Color(0xFF1989FA),
            foregroundColor: Colors.white,
            elevation: 0,
          ),
          cardTheme: CardThemeData(
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
            ),
          ),
          inputDecorationTheme: InputDecorationTheme(
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
            ),
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          ),
        ),
        routerConfig: _router,
      ),
    );
  }
}


class MainLayout extends StatelessWidget {
  final Widget child;
  const MainLayout({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final location = GoRouterState.of(context).uri.path;
    final isTabBarVisible = [
      '/home',
      '/outbound',
      '/inbound',
      '/stock',
      '/mine'
    ].contains(location);

    return Scaffold(
      body: child,
      bottomNavigationBar: isTabBarVisible
          ? BottomNavigationBar(
              type: BottomNavigationBarType.fixed,
              currentIndex: _getIndex(location),
              selectedItemColor: const Color(0xFF1989FA),
              unselectedItemColor: Colors.grey,
              onTap: (index) => _onTap(context, index),
              items: const [
                BottomNavigationBarItem(
                    icon: Icon(Icons.home_outlined), label: '工作台'),
                BottomNavigationBarItem(
                    icon: Icon(Icons.local_shipping_outlined), label: '出库'),
                BottomNavigationBarItem(
                    icon: Icon(Icons.arrow_downward_outlined), label: '入库'),
                BottomNavigationBarItem(
                    icon: Icon(Icons.shopping_cart_outlined), label: '库存'),
                BottomNavigationBarItem(
                    icon: Icon(Icons.person_outline), label: '我的'),
              ],
            )
          : null,
    );
  }

  int _getIndex(String location) {
    if (location == '/home') return 0;
    if (location == '/outbound') return 1;
    if (location == '/inbound') return 2;
    if (location == '/stock') return 3;
    if (location == '/mine') return 4;
    return 0;
  }

  void _onTap(BuildContext context, int index) {
    final routes = ['/home', '/outbound', '/inbound', '/stock', '/mine'];
    context.go(routes[index]);
  }
}
