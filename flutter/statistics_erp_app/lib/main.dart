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

void main() {
  runApp(const StatisticsErpApp());
}

class StatisticsErpApp extends StatelessWidget {
  const StatisticsErpApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthProvider()),
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

final GoRouter _router = GoRouter(
  initialLocation: '/login',
  routes: [
    GoRoute(
      path: '/login',
      name: 'login',
      builder: (context, state) => const LoginScreen(),
    ),
    ShellRoute(
      builder: (context, state, child) {
        return MainLayout(child: child);
      },
      routes: [
        GoRoute(
          path: '/home',
          name: 'home',
          builder: (context, state) => const HomeScreen(),
        ),
        GoRoute(
          path: '/fresh',
          name: 'fresh',
          builder: (context, state) => const FreshScreen(),
        ),
        GoRoute(
          path: '/outbound',
          name: 'outbound',
          builder: (context, state) => const OutboundScreen(),
        ),
        GoRoute(
          path: '/inbound',
          name: 'inbound',
          builder: (context, state) => const InboundScreen(),
        ),
        GoRoute(
          path: '/stock',
          name: 'stock',
          builder: (context, state) => const StockScreen(),
        ),
        GoRoute(
          path: '/mine',
          name: 'mine',
          builder: (context, state) => const MineScreen(),
        ),
      ],
    ),
  ],
);

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
