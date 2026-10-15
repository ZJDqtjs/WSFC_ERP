import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:statistics_erp_app/main.dart';
import 'package:statistics_erp_app/providers/auth_provider.dart';
import 'package:statistics_erp_app/providers/product_provider.dart';
import 'package:statistics_erp_app/screens/home_screen.dart';
import 'package:statistics_erp_app/screens/mine_screen.dart';
import 'package:statistics_erp_app/screens/products_screen.dart';

void main() {
  setUp(() {
    // shared_preferences 在测试环境没有平台通道，给一份空内存实现
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('冷启动落到登录页', (tester) async {
    await tester.pumpWidget(const StatisticsErpApp());
    await tester.pump();

    expect(find.text('企业台账'), findsOneWidget);
    expect(find.text('登 录'), findsOneWidget);
  });

  testWidgets('工作台带业务入口宫格', (tester) async {
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthProvider()),
        ChangeNotifierProvider(create: (_) => ProductProvider()),
      ],
      child: const MaterialApp(home: HomeScreen()),
    ));
    // 首帧会拉 /api/dashboard；测试里网络必然失败并被页面吞掉，
    // 所以只推几帧，不用 pumpAndSettle（加载指示器会一直动）。
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    expect(find.text('工作台'), findsWidgets);
    for (final label in ['商品', '待付款', '其他开支', '财务流水', '规则设置']) {
      expect(find.text(label), findsWidgets, reason: '缺少入口：$label');
    }
  });

  testWidgets('商品页：两个页签与新增表单校验', (tester) async {
    await tester.pumpWidget(MultiProvider(
      providers: [ChangeNotifierProvider(create: (_) => AuthProvider())],
      child: const MaterialApp(home: ProductsScreen()),
    ));
    // 首屏会拉 /api/products；测试环境里请求必然失败并被页面吞掉，只推几帧
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    expect(find.text('库存商品（大类）'), findsOneWidget);
    expect(find.text('订单商品（小类）'), findsOneWidget);

    await tester.tap(find.text('新增商品'));
    await tester.pumpAndSettle();
    expect(find.text('保存'), findsOneWidget);

    // 名称必填：空着点保存要被表单拦住，不能发请求
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(find.text('请填写商品名称'), findsOneWidget);
  });

  testWidgets('我的页：业务入口与退出登录', (tester) async {
    await tester.pumpWidget(MultiProvider(
      providers: [ChangeNotifierProvider(create: (_) => AuthProvider())],
      child: const MaterialApp(home: MineScreen()),
    ));
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    for (final label in ['商品', '待付款', '财务流水', '规则设置']) {
      expect(find.text(label), findsWidgets, reason: '缺少：$label');
    }
    // 退出登录在列表底部，先滑到可见再断言
    await tester.scrollUntilVisible(find.text('退出登录'), 200,
        scrollable: find.byType(Scrollable).first);
    expect(find.text('退出登录'), findsOneWidget);
  });
}
