import 'package:flutter/material.dart';

/// 桌面端动效时长，和 web 的 .2s/.3s 过渡对齐。
abstract final class Dm {
  static const Duration quick = Duration(milliseconds: 160);
  static const Duration base = Duration(milliseconds: 240);
  static const Duration stagger = Duration(milliseconds: 60);
  static const Curve curve = Curves.easeOutCubic;
}

/// 首次挂载时淡入 + 轻微上浮，用 [index] 做交错。桌面首页各区块用它排出场节奏。
class DesktopRise extends StatefulWidget {
  const DesktopRise({
    super.key,
    required this.child,
    this.index = 0,
    this.offset = 14,
  });

  final Widget child;
  final int index;
  final double offset;

  @override
  State<DesktopRise> createState() => _DesktopRiseState();
}

class _DesktopRiseState extends State<DesktopRise>
    with SingleTickerProviderStateMixin {
  late final Duration _delay = Dm.stagger * widget.index;
  late final Duration _total = Dm.base + _delay;
  late final AnimationController _c =
      AnimationController(vsync: this, duration: _total)..forward();

  late final Animation<double> _fade = CurvedAnimation(
    parent: _c,
    curve: Interval(_delay.inMilliseconds / _total.inMilliseconds, 1, curve: Dm.curve),
  );

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: FadeTransition(
        opacity: _fade,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: Offset(0, widget.offset / 100),
            end: Offset.zero,
          ).animate(_fade),
          child: widget.child,
        ),
      ),
    );
  }
}

/// 内容区切页：淡入 + 横向轻移，替代 Material 默认的大范围滑动。
class DesktopPageTransition extends StatelessWidget {
  const DesktopPageTransition({super.key, required this.routeKey, required this.child});

  final String routeKey;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: Dm.base,
      switchInCurve: Dm.curve,
      switchOutCurve: Curves.easeInCubic,
      transitionBuilder: (child, animation) => FadeTransition(
        opacity: animation,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0.015, 0),
            end: Offset.zero,
          ).animate(animation),
          child: child,
        ),
      ),
      child: KeyedSubtree(key: ValueKey<String>(routeKey), child: child),
    );
  }
}

/// 品牌渐变图标底板：替代原来一块纯色方砖，边缘有高光、下面有投影。
class DesktopIconTile extends StatelessWidget {
  const DesktopIconTile({
    super.key,
    required this.icon,
    this.size = 30,
    this.iconSize,
    this.colors,
  });

  final IconData icon;
  final double size;
  final double? iconSize;
  final List<Color>? colors;

  @override
  Widget build(BuildContext context) {
    final List<Color> gradient = colors ?? const [Color(0xFF4FAAFF), Color(0xFF1989FA)];
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: gradient,
        ),
        borderRadius: BorderRadius.circular(size * 0.3),
        boxShadow: [
          BoxShadow(
            color: gradient.last.withValues(alpha: 0.32),
            blurRadius: size * 0.42,
            offset: Offset(0, size * 0.16),
          ),
        ],
      ),
      child: Icon(icon,
          size: iconSize ?? size * 0.58, color: Colors.white),
    );
  }
}
