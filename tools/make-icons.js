/* make-icons.js — regenerate the PNG app icons from pure maths.
   No dependencies: raw RGBA -> zlib -> PNG.   Run: node tools/make-icons.js */

var fs = require('fs');
var zlib = require('zlib');
var path = require('path');

var OUT = path.join(__dirname, '..', 'icons');

/* ---------- tiny PNG writer ---------- */

var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  var sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  // One filter byte (0 = None) in front of every scanline.
  var raw = Buffer.alloc(height * (width * 4 + 1));
  for (var y = 0; y < height; y++) {
    var src = y * width * 4;
    var dst = y * (width * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + width * 4);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- the artwork ---------- */

var BG     = [0x0e, 0x0e, 0x13];
var RING   = [0x24, 0x36, 0x5c];
var ACCENT = [0x7a, 0xa7, 0xf7];
var WARN   = [0xee, 0xc0, 0x6a];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

/** A phase wheel: dim ring, bright active arc, and an alert pip. */
function draw(size, maskable, round) {
  var rgba = Buffer.alloc(size * size * 4);
  var c = size / 2;
  // Maskable icons get squeezed by the launcher's mask, so shrink the art.
  var art = maskable ? 0.62 : 0.80;
  var rOut = (size / 2) * art;
  var rIn = rOut * 0.60;
  var corner = size * 0.22;
  var pipR = rOut * 0.155;
  var pipD = (rOut + rIn) / 2;
  var pipX = c + pipD * Math.cos(-Math.PI / 4);
  var pipY = c + pipD * Math.sin(-Math.PI / 4);

  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      var px = x + 0.5, py = y + 0.5;
      var i = (y * size + x) * 4;

      // Rounded-square background (full bleed when maskable).
      var alpha;
      if (maskable) { alpha = 1; }
      else if (round) {
        // Circular mask for ic_launcher_round.
        var rd = Math.sqrt((px - c) * (px - c) + (py - c) * (py - c));
        alpha = 1 - smooth(rd, size / 2 - 1, size / 2);
      } else { alpha = roundedRectCoverage(px, py, size, corner); }
      var col = BG;

      var dx = px - c, dy = py - c;
      var d = Math.sqrt(dx * dx + dy * dy);

      // Ring body, antialiased on both edges.
      var ringA = band(d, rIn, rOut);
      if (ringA > 0) {
        // Angle measured clockwise from 12 o'clock.
        var ang = Math.atan2(dx, -dy);
        if (ang < 0) { ang += Math.PI * 2; }
        // Highlight the first third of the wheel: "the turn so far".
        var lit = ang < Math.PI * 0.72 ? 1 : 0;
        col = mix(col, lit ? ACCENT : RING, ringA);
      }

      // Alert pip riding on the ring.
      var pd = Math.sqrt((px - pipX) * (px - pipX) + (py - pipY) * (py - pipY));
      var pipA = 1 - smooth(pd, pipR - 1.2, pipR + 1.2);
      if (pipA > 0) { col = mix(col, WARN, pipA); }

      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

function smooth(v, a, b) {
  if (v <= a) { return 0; }
  if (v >= b) { return 1; }
  var t = (v - a) / (b - a);
  return t * t * (3 - 2 * t);
}

/** 1 inside [inner, outer], fading over ~1.2px at each edge. */
function band(d, inner, outer) {
  return smooth(d, inner - 1.2, inner + 1.2) * (1 - smooth(d, outer - 1.2, outer + 1.2));
}

function roundedRectCoverage(px, py, size, r) {
  var qx = Math.abs(px - size / 2) - (size / 2 - r);
  var qy = Math.abs(py - size / 2) - (size / 2 - r);
  var dist;
  if (qx > 0 && qy > 0) { dist = Math.sqrt(qx * qx + qy * qy) - r; }
  else { dist = Math.max(qx, qy) - r; }
  return 1 - smooth(dist, -1, 1);
}

/* ---------- write them out ---------- */

fs.mkdirSync(OUT, { recursive: true });

[
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true }
].forEach(function (spec) {
  var png = encodePNG(spec.size, spec.size, draw(spec.size, spec.maskable));
  fs.writeFileSync(path.join(OUT, spec.file), png);
  console.log('wrote icons/' + spec.file + '  (' + png.length + ' bytes)');
});

/* ---------- Chrome extension toolbar icons ---------- */

var EXT = path.join(__dirname, '..', 'extension', 'icons');
if (fs.existsSync(path.join(__dirname, '..', 'extension'))) {
  fs.mkdirSync(EXT, { recursive: true });
  [16, 48, 128].forEach(function (size) {
    // Toolbar icons are tiny, so drop the rounded-square plate and let the
    // wheel fill the space.
    fs.writeFileSync(path.join(EXT, 'icon-' + size + '.png'),
      encodePNG(size, size, draw(size, true)));
    console.log('wrote extension/icons/icon-' + size + '.png');
  });
}

/* ---------- Android launcher icons ---------- */

var RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
var DENSITIES = [
  { dir: 'mipmap-mdpi',    size: 48 },
  { dir: 'mipmap-hdpi',    size: 72 },
  { dir: 'mipmap-xhdpi',   size: 96 },
  { dir: 'mipmap-xxhdpi',  size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 }
];

if (fs.existsSync(path.join(__dirname, '..', 'android'))) {
  DENSITIES.forEach(function (d) {
    var dir = path.join(RES, d.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'),
      encodePNG(d.size, d.size, draw(d.size, false)));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'),
      encodePNG(d.size, d.size, draw(d.size, false, true)));
    console.log('wrote ' + d.dir + '/ic_launcher*.png  (' + d.size + 'px)');
  });
}
