import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../mobile_style.dart';
import 'aurora.dart';
import 'tab_bar.dart';

/// 移动端统一的玻璃页面骨架：极光背景 + 玻璃 AppBar + 可选底部 Tab。
/// 所有重做过的页面都走它，观感只在这一处定义。
class MobilePage extends StatelessWidget {
  const MobilePage({
    super.key,
    required this.title,
    required this.body,
    this.subtitle,
    this.actions,
    this.onRefresh,
    this.tabIndex,
    this.floating,
    this.hideAppBar = false,
    this.back = false,
    this.underBar,
  });

  final String title;
  final String? subtitle;
  final List<Widget>? actions;
  final Widget body;
  final Future<void> Function()? onRefresh;
  final int? tabIndex;
  final Widget? floating;
  final bool hideAppBar;

  /// 二级页显示返回键；不能 pop 时（深链直接进来了）退回工作台。
  final bool back;

  /// AppBar 之下、正文之上的固定条（分段切换 / 筛选栏）。
  final Widget? underBar;

  @override
  Widget build(BuildContext context) {
    Widget content = body;
    if (onRefresh != null) {
      content = RefreshIndicator(
        color: Mc.brand,
        onRefresh: onRefresh!,
        child: content,
      );
    }
    if (underBar != null) {
      content = Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 6, 14, 6),
            child: underBar,
          ),
          Expanded(child: content),
        ],
      );
    }
    if (floating != null) {
      content = Stack(
        fit: StackFit.expand,
        children: [
          content,
          Align(
            alignment: Alignment.bottomRight,
            child: Padding(
              // 正文已经排在底部导航之上（extendBody: false），这里只需留出自身边距
              padding: const EdgeInsets.only(right: 18, bottom: 18),
              child: floating!,
            ),
          ),
        ],
      );
    }

    return GlassScaffold(
      background: const AuroraBackground(),
      enableBackgroundSampling: true,
      // 正文不铺到导航条底下：这些页面都是表单/列表，不是「内容穿过玻璃」的滚动设计，
      // extendBody 还会顺带打开边缘渐隐，实测会把首屏下方的卡片整段抹掉。
      extendBody: false,
      appBar: hideAppBar
          ? null
          : GlassAppBar(
              centerTitle: true,
              // 标题带副标题时两行文字放不下默认 44 的工具条，会被裁掉半截
              toolbarHeight: subtitle == null ? 46 : 62,
              leading: back
                  ? IconButton(
                      onPressed: () =>
                          context.canPop() ? context.pop() : context.go('/home'),
                      icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19),
                      color: Mc.ink,
                      splashRadius: 20,
                    )
                  : null,
              title: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      color: Mc.ink,
                    ),
                  ),
                  if (subtitle != null)
                    Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w400,
                        color: Mc.inkSecond,
                      ),
                    ),
                ],
              ),
              actions: actions,
            ),
      bottomBar: tabIndex != null ? MobileTabBar(currentIndex: tabIndex!) : null,
      bottomBarHeight: 58,
      // 正文盒子已经精确排在两条导航之间，滚动组件再自动加一次系统内边距会变成双倍留白
      body: MediaQuery.removePadding(
        context: context,
        removeTop: true,
        removeBottom: true,
        child: content,
      ),
    );
  }
}

/// AppBar 右侧的普通图标按钮（GlassAppBar 会把 actions 收进同一层背板）。
Widget pageAction(IconData icon, VoidCallback? onTap, {String? tooltip}) {
  final button = IconButton(
    onPressed: onTap,
    icon: Icon(icon, size: 21),
    color: Mc.inkSecond,
    splashRadius: 20,
  );
  return tooltip == null ? button : Tooltip(message: tooltip, child: button);
}
