/* build-assets.js — copy the web app into the Android project's assets folder.
   The APK carries every file, so the app needs no hosting and no connection
   beyond the one Scryfall lookup per new deck.
   Run: node tools/build-assets.js */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var DEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');

// sw.js is deliberately absent: inside the APK the files are already local, and
// a service worker would only add a second, staler cache layer.
var ITEMS = ['index.html', 'manifest.webmanifest', 'css', 'js', 'img', 'icons'];

function rmrf(target) {
  if (fs.existsSync(target)) { fs.rmSync(target, { recursive: true, force: true }); }
}

function copy(src, dst) {
  var stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    fs.readdirSync(src).forEach(function (name) {
      copy(path.join(src, name), path.join(dst, name));
    });
    return;
  }
  fs.copyFileSync(src, dst);
}

function countFiles(dir) {
  var n = 0;
  fs.readdirSync(dir).forEach(function (name) {
    var p = path.join(dir, name);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  });
  return n;
}

rmrf(DEST);
fs.mkdirSync(DEST, { recursive: true });

var missing = [];
ITEMS.forEach(function (item) {
  var src = path.join(ROOT, item);
  if (!fs.existsSync(src)) { missing.push(item); return; }
  copy(src, path.join(DEST, item));
});

if (missing.length) {
  console.error('missing from the web build: ' + missing.join(', '));
  process.exitCode = 1;
} else {
  console.log('bundled ' + countFiles(DEST) + ' files into android/app/src/main/assets');
}
