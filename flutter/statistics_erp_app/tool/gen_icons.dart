// 统一三端应用图标：以 capacitor 的 432px 前景为唯一源，其余尺寸全部下采样生成。
//
// 用法（在 flutter/statistics_erp_app 目录下）：
//   dart run tool/gen_icons.dart
//
// 源图 <repo>/capacitor/.../mipmap-xxxhdpi/ic_launcher_foreground.png 是一个「双色蓝几何 mark」，
// 但上面烘焙了一层白色斜网格水印，且 mark 只占画布 ~45%。
// 所以这里先把 mark 的字形（高饱和蓝像素）抠成掩膜、补掉被网格切断的洞，
// 并保留每个像素的原始蓝色（连续渐变），按两种配色重绘：
//   - 安卓 / Windows 桌面：白底 + 蓝色 mark（原版配色）
//   - web 目录（flutter web、老 web 的 brand-dot）：蓝渐变底 + 白色 mark
//
// 产物：
//   - Android  mipmap-*/ic_launcher.png + ic_launcher_round.png + ic_launcher_foreground.png
//              + mipmap-anydpi-v26/*.xml + drawable/ic_launcher_background.xml（白底）
//   - Web      web/favicon.png + web/icons/Icon-192/512.png + Icon-maskable-192/512.png（蓝底白 X）
//   - 老 Web   <repo>/web/static/brand-icon.png（蓝底白 X，侧边栏 brand-dot 用）
//   - Windows  windows/runner/resources/app_icon.ico (16..256 多尺寸，圆角，白底蓝 X)

import 'dart:io';
import 'dart:typed_data';
import 'package:image/image.dart' as img;

final Directory _scriptDir = File.fromUri(Platform.script).parent; // .../tool
final Directory _projRoot = _scriptDir.parent; // .../statistics_erp_app
final Directory _repoRoot = _projRoot.parent.parent; // .../WSFC_ERP

const int kMaster = 432;

/// 背景渐变：品牌蓝 #1989FA 家族，左上亮 → 右下深
const List<int> kBgTop = [61, 160, 255];
const List<int> kBgBottom = [9, 88, 205];

/// 源图的 mark 本身就是一段连续蓝色渐变（不是两档色），所以墨色也按亮度连续映射：
/// 白色不透明度在 0.80~1.00 之间跟着原图走，叠在蓝底上是一层柔光，硬切两档反而露锯齿。
const double kInkMin = 0.90;
const double kInkMax = 1.00;

class Glyph {
  Glyph(this.mask, this.ink, this.rgb, this.w, this.h, this.box);

  final Uint8List mask; // 0 = 背景，255 = mark
  final Uint8List ink; // mark 内的亮度映射 0..255（白 X 模式用）
  final Uint8List rgb; // mark 像素的原始颜色，3 字节/像素（蓝 X 模式用）
  final int w;
  final int h;
  final List<int> box; // x0,y0,x1,y1

  int at(int x, int y) => mask[y * w + x];
  int inkAt(int x, int y) => ink[y * w + x];
}

/// 从源图抠出 mark：只认高饱和蓝像素，白色网格水印天然被丢弃；再补掉被网格切断的洞。
Glyph extractGlyph(img.Image src) {
  final w = src.width, h = src.height;
  final mask = Uint8List(w * h);
  final ink = Uint8List(w * h);
  final rgb = Uint8List(w * h * 3);
  final lum = List<int>.filled(w * h, 0);
  final samples = <int>[];

  var i = 0;
  for (final p in src) {
    if (p.a > 128) {
      final mx = p.r > p.g ? (p.r > p.b ? p.r : p.b) : (p.g > p.b ? p.g : p.b);
      final mn = p.r < p.g ? (p.r < p.b ? p.r : p.b) : (p.g < p.b ? p.g : p.b);
      if (mx - mn > 40) {
        // 高饱和 → 属于 mark
        final l = (p.r * 299 + p.g * 587 + p.b * 114) ~/ 1000;
        lum[i] = l;
        samples.add(l);
        mask[i] = 255;
        rgb[i * 3] = p.r.toInt();
        rgb[i * 3 + 1] = p.g.toInt();
        rgb[i * 3 + 2] = p.b.toInt();
      }
    }
    i++;
  }

  // 用 5%/95% 分位而不是 min/max 做归一化端点，避免抗锯齿边缘的离群值压扁层次
  samples.sort();
  final lo = samples[(samples.length * 0.05).floor()];
  final hi = samples[(samples.length * 0.95).floor()];
  final span = (hi - lo) == 0 ? 1 : hi - lo;

  var x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final k = y * w + x;
      if (mask[k] == 0) continue;
      final t = ((lum[k] - lo) / span).clamp(0.0, 1.0);
      ink[k] = (t * 255).round();
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }

  _fillHoles(mask, ink, rgb, w, h);
  return Glyph(mask, ink, rgb, w, h, [x0, y0, x1, y1]);
}

/// 网格水印把 mark 切成若干条白缝。做法：从画布边缘漫填「非 mark」区域，
/// 漫填不到的非 mark 像素就是缝；再用多源 BFS 用最近的 mark 像素把缝染回去。
void _fillHoles(Uint8List mask, Uint8List ink, Uint8List rgb, int w, int h) {
  final outside = Uint8List(w * h);
  final queue = <int>[];
  void seed(int k) {
    if (mask[k] == 0 && outside[k] == 0) {
      outside[k] = 1;
      queue.add(k);
    }
  }
  for (var x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (var y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  var head = 0;
  while (head < queue.length) {
    final k = queue[head++];
    final x = k % w, y = k ~/ w;
    if (x > 0) seed(k - 1);
    if (x < w - 1) seed(k + 1);
    if (y > 0) seed(k - w);
    if (y < h - 1) seed(k + w);
  }

  // 洞 = mask==0 且不在「与边缘连通的外部」里
  final holes = <int>[];
  for (var k = 0; k < mask.length; k++) {
    if (mask[k] == 0 && outside[k] == 0) holes.add(k);
  }
  if (holes.isEmpty) return;

  final dist = Uint32List(w * h);
  for (var k = 0; k < dist.length; k++) {
    dist[k] = mask[k] != 0 ? 0 : 0xFFFFFFFF;
  }
  final src2 = <int>[];
  for (var k = 0; k < mask.length; k++) {
    if (mask[k] != 0) src2.add(k);
  }
  var front = src2;
  var step = 0;
  final remaining = holes.toSet();
  while (front.isNotEmpty && remaining.isNotEmpty && step < 24) {
    final next = <int>[];
    for (final k in front) {
      final x = k % w, y = k ~/ w;
      for (final n in [
        if (x > 0) k - 1,
        if (x < w - 1) k + 1,
        if (y > 0) k - w,
        if (y < h - 1) k + w
      ]) {
        if (dist[n] == 0xFFFFFFFF) {
          dist[n] = step + 1;
          mask[n] = 255;
          ink[n] = ink[k];
          rgb[n * 3] = rgb[k * 3];
          rgb[n * 3 + 1] = rgb[k * 3 + 1];
          rgb[n * 3 + 2] = rgb[k * 3 + 2];
          remaining.remove(n);
          next.add(n);
        }
      }
    }
    front = next;
    step++;
  }
}

/// 把字形按 glyphRatio 缩放后画到 kMaster 画布上；gradientBg=false 时输出透明底前景。
/// blueInk=true：白底（或透明底）+ mark 原始蓝色；false：品牌蓝渐变底 + 白色 mark。
img.Image render(
    {required Glyph glyph,
    required double glyphRatio,
    required bool gradientBg,
    bool blueInk = false,
    int size = kMaster}) {
  final canvas = img.Image(width: size, height: size, numChannels: 4);
  final radius = size * 0.22;

  if (gradientBg) {
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (blueInk) {
          canvas.setPixelRgba(x, y, 255, 255, 255, 255);
          continue;
        }
        final t = (x + y) / (2 * (size - 1));
        final r = (kBgTop[0] + (kBgBottom[0] - kBgTop[0]) * t).round();
        final gg = (kBgTop[1] + (kBgBottom[1] - kBgTop[1]) * t).round();
        final b = (kBgTop[2] + (kBgBottom[2] - kBgTop[2]) * t).round();
        canvas.setPixelRgba(x, y, r, gg, b, 255);
      }
    }
  }

  final bx0 = glyph.box[0], by0 = glyph.box[1];
  final bw = glyph.box[2] - bx0 + 1, bh = glyph.box[3] - by0 + 1;
  final target = (size * glyphRatio).round();
  final scale = target / (bw > bh ? bw : bh);
  final gw = (bw * scale).round(), gh = (bh * scale).round();
  final ox = ((size - gw) / 2).round(), oy = ((size - gh) / 2).round();

  // 二值掩膜三次插值后直接当 alpha → 边缘自带抗锯齿；墨色用连续亮度，避免分档硬边
  final mask = img.Image(width: bw, height: bh, numChannels: 4);
  final tone = img.Image(width: bw, height: bh, numChannels: 4);
  // 蓝 X 模式下掩膜外若填黑色，cubic 插值会在 mark 边缘带出黑边 → 用 mark 平均色垫底
  var avgR = 0, avgG = 0, avgB = 0, avgN = 0;
  if (blueInk) {
    for (var k = 0; k < glyph.mask.length; k++) {
      if (glyph.mask[k] != 0) {
        avgR += glyph.rgb[k * 3];
        avgG += glyph.rgb[k * 3 + 1];
        avgB += glyph.rgb[k * 3 + 2];
        avgN++;
      }
    }
    avgR = avgN == 0 ? 82 : avgR ~/ avgN;
    avgG = avgN == 0 ? 175 : avgG ~/ avgN;
    avgB = avgN == 0 ? 255 : avgB ~/ avgN;
  }
  for (var y = 0; y < bh; y++) {
    for (var x = 0; x < bw; x++) {
      final on = glyph.at(bx0 + x, by0 + y);
      mask.setPixelRgba(x, y, on, 0, 0, 255);
      if (blueInk) {
        final k = ((by0 + y) * glyph.w + bx0 + x) * 3;
        tone.setPixelRgba(
            x,
            y,
            on == 0 ? avgR : glyph.rgb[k],
            on == 0 ? avgG : glyph.rgb[k + 1],
            on == 0 ? avgB : glyph.rgb[k + 2],
            255);
      } else {
        tone.setPixelRgba(x, y, on == 0 ? 0 : glyph.inkAt(bx0 + x, by0 + y), 0, 0, 255);
      }
    }
  }
  final maskBig =
      img.copyResize(mask, width: gw, height: gh, interpolation: img.Interpolation.cubic);
  final toneBig =
      img.copyResize(tone, width: gw, height: gh, interpolation: img.Interpolation.cubic);

  for (var y = 0; y < gh; y++) {
    for (var x = 0; x < gw; x++) {
      final a = maskBig.getPixel(x, y).r.toInt();
      if (a < 8) continue;
      final px = ox + x, py = oy + y;
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      final tp = toneBig.getPixel(x, y);
      if (blueInk) {
        // 原始蓝色直接作为墨色，掩膜 alpha 决定边缘过渡
        if (!gradientBg) {
          canvas.setPixelRgba(px, py, tp.r.toInt(), tp.g.toInt(), tp.b.toInt(), a);
          continue;
        }
        final bg = canvas.getPixel(px, py);
        final t = a / 255.0;
        canvas.setPixelRgba(
          px,
          py,
          (bg.r + (tp.r - bg.r) * t).round(),
          (bg.g + (tp.g - bg.g) * t).round(),
          (bg.b + (tp.b - bg.b) * t).round(),
          255,
        );
        continue;
      }
      final toneW = tp.r.toInt() / 255.0;
      final ink = kInkMin + (kInkMax - kInkMin) * toneW;
      final wgt = (a / 255.0) * ink;
      if (!gradientBg) {
        canvas.setPixelRgba(
            px, py, 255, 255, 255, (wgt * 255).round().clamp(0, 255));
        continue;
      }
      final bg = canvas.getPixel(px, py);
      canvas.setPixelRgba(
        px,
        py,
        (bg.r + (255 - bg.r) * wgt).round(),
        (bg.g + (255 - bg.g) * wgt).round(),
        (bg.b + (255 - bg.b) * wgt).round(),
        255,
      );
    }
  }
  return canvas;
}

/// 圆角遮罩：Win 桌面/任务栏直接按 .ico 的形状显示，方角会显得生硬。
img.Image roundCorners(img.Image src, double radiusFactor) {
  final size = src.width;
  final out = img.Image(width: size, height: size, numChannels: 4);
  final r = size * radiusFactor;
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      final dx = x + 0.5 - (x < r ? r : (x > size - 1 - r ? size - r : x + 0.5));
      final dy = y + 0.5 - (y < r ? r : (y > size - 1 - r ? size - r : y + 0.5));
      var a = 255;
      if (dx.abs() > 0.5 || dy.abs() > 0.5) {
        final d = _sqrt(dx * dx + dy * dy);
        a = ((r - d) * 255).round().clamp(0, 255);
      }
      final p = src.getPixel(x, y);
      out.setPixelRgba(x, y, p.r.toInt(), p.g.toInt(), p.b.toInt(), a);
    }
  }
  return out;
}

img.Image circleMask(img.Image src) {
  final size = src.width;
  final out = img.Image(width: size, height: size, numChannels: 4);
  final c = size / 2.0;
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      final d = _sqrt((x + 0.5 - c) * (x + 0.5 - c) + (y + 0.5 - c) * (y + 0.5 - c));
      final a = ((size / 2.0 - d) * 255).round().clamp(0, 255);
      final p = src.getPixel(x, y);
      out.setPixelRgba(x, y, p.r.toInt(), p.g.toInt(), p.b.toInt(), a);
    }
  }
  return out;
}

img.Image _down(img.Image src, int size) => img.copyResize(src,
    width: size, height: size, interpolation: img.Interpolation.cubic);

void _writePng(String path, img.Image image) {
  File(path).parent.createSync(recursive: true);
  File(path).writeAsBytesSync(img.encodePng(image));
  stdout.writeln('  PNG  $path  (${image.width}x${image.height})');
}

/// 手写多尺寸 .ico：每个尺寸一张独立 PNG 作为目录项，兼容 Win11 桌面/任务栏。
void _writeIco(String path, Map<int, img.Image> bySize) {
  final sizes = bySize.keys.toList()..sort();
  final bytes = BytesBuilder();
  bytes.add(_u16(0)); // reserved
  bytes.add(_u16(1)); // type = icon
  bytes.add(_u16(sizes.length));
  final datas = <int, Uint8List>{};
  var offset = 6 + sizes.length * 16;
  for (final s in sizes) {
    final png = img.encodePng(bySize[s]!);
    datas[s] = png;
    final w = s >= 256 ? 0 : s;
    bytes.add([w, w, 0, 0]);
    bytes.add(_u16(1)); // planes
    bytes.add(_u16(32)); // bit count
    bytes.add(_u32(png.length));
    bytes.add(_u32(offset));
    offset += png.length;
  }
  for (final s in sizes) {
    bytes.add(datas[s]!);
  }
  File(path).writeAsBytesSync(bytes.toBytes());
  stdout.writeln('  ICO  $path  (${sizes.join(",")}px)');
}

List<int> _u16(int v) => [v & 0xFF, (v >> 8) & 0xFF];
List<int> _u32(int v) =>
    [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];

double _sqrt(double x) {
  if (x <= 0) return 0;
  var g = x;
  for (var i = 0; i < 30; i++) {
    g = 0.5 * (g + x / g);
  }
  return g;
}

void main() {
  final srcPath =
      '${_repoRoot.path}/capacitor/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png';
  final srcFile = File(srcPath);
  if (!srcFile.existsSync()) {
    stderr.writeln('找不到源图标：$srcPath');
    exit(1);
  }
  final src = img.decodePng(srcFile.readAsBytesSync())!;
  final glyph = extractGlyph(src);
  stdout.writeln('源：$srcPath  (${src.width}x${src.height})');
  stdout.writeln('字形包围盒 ${glyph.box}，已抠除网格水印并补缝');

  // 方形（web/旧版 launcher）与自适应前景：mark 占比不同，前景要留蒙版余量
  // 安卓/Windows：白底蓝 X（原版配色）；web 目录：蓝渐变底白 X
  final squareBlueBg = render(glyph: glyph, glyphRatio: 0.62, gradientBg: true);
  final squareWhiteBg =
      render(glyph: glyph, glyphRatio: 0.62, gradientBg: true, blueInk: true);
  final adaptiveFg = render(glyph: glyph, glyphRatio: 0.44, gradientBg: false, blueInk: true);
  final maskable = render(glyph: glyph, glyphRatio: 0.50, gradientBg: true);
  final round = circleMask(squareWhiteBg);
  final icoMaster = roundCorners(squareWhiteBg, 0.22);

  // ---- Android ----
  final androidRes = '${_projRoot.path}/android/app/src/main/res';
  const androidDensity = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
  };
  stdout.writeln('\n[Android] 白底蓝 X');
  androidDensity.forEach((dpi, px) {
    _writePng('$androidRes/mipmap-$dpi/ic_launcher.png', _down(squareWhiteBg, px));
    _writePng('$androidRes/mipmap-$dpi/ic_launcher_round.png', _down(round, px));
    // 自适应前景：透明底蓝色 mark，配纯白背景层
    _writePng('$androidRes/mipmap-$dpi/ic_launcher_foreground.png',
        _down(adaptiveFg, (px * 108 / 48).round()));
  });

  final anydpi = '$androidRes/mipmap-anydpi-v26';
  Directory(anydpi).createSync(recursive: true);
  const adaptive = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
''';
  File('$anydpi/ic_launcher.xml').writeAsStringSync(adaptive);
  File('$anydpi/ic_launcher_round.xml').writeAsStringSync(adaptive);
  final drawable = Directory('$androidRes/drawable')..createSync(recursive: true);
  File('${drawable.path}/ic_launcher_background.xml').writeAsStringSync('''<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <solid android:color="#FFFFFFFF" />
</shape>
''');
  final staleColor = File('$androidRes/values/ic_launcher_background.xml');
  if (staleColor.existsSync()) staleColor.deleteSync();
  stdout.writeln('  XML  adaptive-icon + drawable/ic_launcher_background.xml');

  // ---- Web（蓝底白 X）----
  stdout.writeln('\n[Web] 蓝底白 X');
  final webDir = '${_projRoot.path}/web';
  _writePng('$webDir/favicon.png', _down(squareBlueBg, 48));
  _writePng('$webDir/icons/Icon-192.png', _down(squareBlueBg, 192));
  // 512 比 432 源还大，直接从字形掩膜按 512 原生渲染，避免把 432 位图放大
  _writePng('$webDir/icons/Icon-512.png',
      render(glyph: glyph, glyphRatio: 0.62, gradientBg: true, size: 512));
  _writePng('$webDir/icons/Icon-maskable-192.png', _down(maskable, 192));
  _writePng('$webDir/icons/Icon-maskable-512.png',
      render(glyph: glyph, glyphRatio: 0.50, gradientBg: true, size: 512));

  // ---- 老 Web 前端 brand-dot ----
  _writePng(
      '${_repoRoot.path}/web/static/brand-icon.png',
      render(glyph: glyph, glyphRatio: 0.62, gradientBg: true, size: 256));

  // ---- Windows ----
  stdout.writeln('\n[Windows] 白底蓝 X');
  final icoSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  _writeIco('${_projRoot.path}/windows/runner/resources/app_icon.ico', {
    for (final s in icoSizes) s: _down(icoMaster, s),
  });

  stdout.writeln('\n完成：三端图标已按 432 源统一下采样生成。');
}
