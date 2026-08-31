// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.

import 'package:flutter_test/flutter_test.dart';

import 'package:statistics_erp_app/main.dart';

void main() {
  testWidgets('显示登录页面', (WidgetTester tester) async {
    await tester.pumpWidget(const StatisticsErpApp());
    await tester.pumpAndSettle();

    expect(find.text('企业台账'), findsOneWidget);
    expect(find.text('登 录'), findsOneWidget);
  });
}
