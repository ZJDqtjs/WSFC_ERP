import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';
import '../providers/product_provider.dart';
import '../screens/expenses_screen.dart';
import '../screens/finance_screen.dart';
import '../screens/fresh_screen.dart';
import '../screens/inbound_screen.dart';
import '../screens/outbound_screen.dart';
import '../screens/payables_screen.dart';
import '../screens/products_screen.dart';
import '../screens/rules_screen.dart';
import '../screens/stock_screen.dart';
import 'mobile_style.dart';
import 'screens/ai_entry_screen.dart';
import 'screens/home_page.dart';
import 'screens/login_page.dart';
import 'screens/mine_page.dart';

/// 移动端外壳：玻璃主题 + 五段底部导航（StatefulShellRoute 保留各 Tab 状态）。
/// 桌面端不走这里，见 desktop/DesktopApp。
class MobileApp extends StatefulWidget {
  const MobileApp({super.key, required this.auth});

  final AuthProvider auth;

  @override
  State<MobileApp> createState() => _MobileAppState();
}

class _MobileAppState extends State<MobileApp> {
  late final GoRouter _router = buildMobileRouter(widget.auth);

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthProvider>.value(value: widget.auth),
        ChangeNotifierProvider(create: (_) => ProductProvider()),
      ],
      child: LiquidGlassWidgets.wrap(
        // 组件库把 adaptiveQuality 标为 experimental（默认 false）：它会按帧耗时
        // 在 premium/balanced/minimal 之间来回切档，切换瞬间玻璃层会退化成
        // 一块不透明的灰矩形并把背板重排，实测在手机上是"界面错位"的主要来源。
        adaptiveQuality: false,
        brightnessResolver: Theme.maybeBrightnessOf,
        theme: mobileGlassTheme(),
        child: MaterialApp.router(
          title: '企业台账',
          debugShowCheckedModeBanner: false,
          theme: mobileLightTheme(),
          routerConfig: _router,
        ),
      ),
    );
  }
}

GoRouter buildMobileRouter(AuthProvider auth) => GoRouter(
      initialLocation: '/login',
      refreshListenable: auth,
      redirect: (context, state) {
        final loggingIn = state.uri.path == '/login';
        if (!auth.isLoggedIn) return loggingIn ? null : '/login';
        // 已登录还停在登录页（含冷启动读本地会话成功）就直接进工作台
        return loggingIn ? '/home' : null;
      },
      routes: [
        GoRoute(
          path: '/login',
          name: 'login',
          builder: (context, state) => const MobileLoginPage(),
        ),
        StatefulShellRoute.indexedStack(
          builder: (context, state, shell) => shell,
          branches: [
            StatefulShellBranch(
              routes: [
                GoRoute(
                    path: '/home',
                    name: 'home',
                    builder: (c, s) => const MobileHomePage()),
              ],
            ),
            StatefulShellBranch(
              routes: [
                GoRoute(
                    path: '/outbound',
                    name: 'outbound',
                    builder: (c, s) => const OutboundScreen()),
              ],
            ),
            StatefulShellBranch(
              routes: [
                GoRoute(
                    path: '/inbound',
                    name: 'inbound',
                    builder: (c, s) => const InboundScreen()),
              ],
            ),
            StatefulShellBranch(
              routes: [
                GoRoute(
                    path: '/stock',
                    name: 'stock',
                    builder: (c, s) => const StockScreen()),
              ],
            ),
            StatefulShellBranch(
              routes: [
                GoRoute(
                    path: '/mine',
                    name: 'mine',
                    builder: (c, s) => const MobileMinePage()),
              ],
            ),
          ],
        ),
        // 二级页：整屏 push，返回即回到来源 Tab。
        // 转场沿用 Material 默认的淡入 + 缩放（go_router 13.x 没有自定义转场钩子）。
        GoRoute(path: '/fresh', name: 'fresh', builder: (c, s) => const FreshScreen()),
        GoRoute(path: '/products', name: 'products', builder: (c, s) => const ProductsScreen()),
        GoRoute(path: '/payables', name: 'payables', builder: (c, s) => const PayablesScreen()),
        GoRoute(path: '/expenses', name: 'expenses', builder: (c, s) => const ExpensesScreen()),
        GoRoute(path: '/finance', name: 'finance', builder: (c, s) => const FinanceScreen()),
        GoRoute(path: '/rules', name: 'rules', builder: (c, s) => const RulesScreen()),
        GoRoute(
          path: '/ai-entry',
          name: 'ai-entry',
          builder: (c, s) {
            final extra = s.extra;
            final args = extra is Map ? Map<String, dynamic>.from(extra) : const {};
            return AiEntryScreen(
              initialText: (args['text'] ?? '').toString(),
              pickImageFirst: args['image'] == true,
            );
          },
        ),
      ],
    );
