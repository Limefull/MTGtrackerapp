/* build-extension.js — copy the web app into extension/app/ so the side panel
   can load it directly. Run: node tools/build-extension.js */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var DEST = path.join(ROOT, 'extension', 'app');

// sw.js is left out: inside the extension the files are already local, and the
// app skips service-worker registration on chrome-extension:// anyway.
var ITEMS = ['index.html', 'css', 'js', 'img', 'icons'];

function copy(src, dst) {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    fs.readdirSync(src).forEach(function (n) { copy(path.join(src, n), path.join(dst, n)); });
    return;
  }
  fs.copyFileSync(src, dst);
}

function countFiles(dir) {
  return fs.readdirSync(dir).reduce(function (n, name) {
    var p = path.join(dir, name);
    return n + (fs.statSync(p).isDirectory() ? countFiles(p) : 1);
  }, 0);
}

if (fs.existsSync(DEST)) { fs.rmSync(DEST, { recursive: true, force: true }); }
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
  // The PWA manifest and apple-touch tags mean nothing to an extension page and
  // only produce console warnings, so drop them from this copy.
  var indexPath = path.join(DEST, 'index.html');
  var html = fs.readFileSync(indexPath, 'utf8')
    .replace(/^.*rel="manifest".*\n?/m, '')
    .replace(/^.*apple-(touch-icon|mobile-web-app).*\n?/gm, '');
  fs.writeFileSync(indexPath, html);

  console.log('bundled ' + countFiles(DEST) + ' files into extension/app');
}
