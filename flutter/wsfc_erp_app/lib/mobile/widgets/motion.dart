import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../mobile_style.dart';

/// 交错入场：第 [index] 个元素延迟 index*70ms 淡入上滑。
/// 只负责"进场一次"，之后不再重播（页面回退/切 Tab 不会重新抖一遍）。
class StaggerItem extends StatefulWidget {
  const StaggerItem({
    super.key,
    required this.child,
    this.index = 0,
    this.offset = 22,
  });

  final Widget child;
  final int index;
  final double offset;

  @override
  State<StaggerItem> createState() => _StaggerItemState();
}

class _StaggerItemState extends State<StaggerItem>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    final delay = Motion.stagger.inMilliseconds * widget.index;
    final total = Motion.base.inMilliseconds + delay;
    _controller = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: total),
    );
    _animation = CurvedAnimation(
      parent: _controller,
      curve: Interval(
        math.min(delay / total, 0.9),
        1.0,
        curve: Motion.curve,
      ),
    );
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _animation,
      child: widget.child,
      builder: (context, child) {
        final t = _animation.value;
        return RepaintBoundary(
          child: Opacity(
            opacity: t,
            child: Transform.translate(
              offset: Offset(0, widget.offset * (1 - t)),
              child: child,
            ),
          ),
        );
      },
    );
  }
}

/// 数字滚动：值变化时从上一个显示值补间到新值，首次进场从 0 起。
class CountUp extends StatelessWidget {
  const CountUp({
    super.key,
    required this.value,
    required this.builder,
    this.duration = Motion.slow,
  });

  final double value;
  final String Function(double value) builder;
  final Duration duration;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: value),
      duration: duration,
      curve: Motion.curve,
      builder: (context, v, _) => Text(builder(v)),
    );
  }
}

/// 点击时轻微下压缩放，给玻璃按钮/卡片一个"按得下去"的手感。
class PressableScale extends StatefulWidget {
  const PressableScale({
    super.key,
    required this.child,
    this.onTap,
    this.scale = 0.965,
  });

  final Widget child;
  final VoidCallback? onTap;
  final double scale;

  @override
  State<PressableScale> createState() => _PressableScaleState();
}

class _PressableScaleState extends State<PressableScale> {
  bool _down = false;

  void _set(bool v) {
    if (_down != v) setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: (_) => _set(true),
      onTapCancel: () => _set(false),
      onTapUp: (_) => _set(false),
      onTap: widget.onTap,
      child: AnimatedScale(
        scale: _down ? widget.scale : 1,
        duration: Motion.fast,
        curve: Motion.curve,
        child: widget.child,
      ),
    );
  }
}
