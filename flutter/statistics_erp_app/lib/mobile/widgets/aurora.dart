import 'package:flutter/material.dart';

import '../mobile_style.dart';

/// 玻璃要有东西可折射才看得见，所以每个页面底下铺一层"极光"：
/// 浅色底 + 三团品牌色光斑。全部是静态渐变，不参与逐帧动画。
class AuroraBackground extends StatelessWidget {
  const AuroraBackground({super.key, this.child, this.intensity = 1.0});

  final Widget? child;
  final double intensity;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: DecoratedBox(
        decoration: const BoxDecoration(gradient: Mc.pageGradient),
        child: Stack(
          fit: StackFit.expand,
          children: [
            _Blob(
              alignment: const Alignment(-0.9, -0.75),
              diameter: 380,
              color: Mc.brandTop.withValues(alpha: 0.34 * intensity),
            ),
            _Blob(
              alignment: const Alignment(1.05, -0.15),
              diameter: 300,
              color: Mc.fresh.withValues(alpha: 0.18 * intensity),
            ),
            _Blob(
              alignment: const Alignment(-0.35, 1.15),
              diameter: 420,
              color: Mc.brandDeep.withValues(alpha: 0.22 * intensity),
            ),
            if (child != null) child!,
          ],
        ),
      ),
    );
  }
}

class _Blob extends StatelessWidget {
  const _Blob({
    required this.alignment,
    required this.diameter,
    required this.color,
  });

  final Alignment alignment;
  final double diameter;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: alignment,
      child: SizedBox(
        width: diameter,
        height: diameter,
        child: DecoratedBox(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: RadialGradient(
              colors: [color, color.withValues(alpha: 0)],
            ),
          ),
        ),
      ),
    );
  }
}
