#!/usr/bin/env python3
"""Build the standalone offline version of the QC tool: one self-contained .html file.

    python3 tools/build-standalone.py            # -> dist/AOC-QC-Tool-YYYYMMDD.html + .zip

Why this exists: GitHub Pages goes down occasionally, and the tool is what the branch uses to QC a
flight. The output is a single file anyone can keep on a laptop or a share drive and open by
double-clicking, with every capability of the live site: .nc upload, QC engine, charts, 2D/3D map,
Error Summary, Track PDF, Gap Report, NC-to-TXT, and the interactive HTML export.

The one rule this script follows: it does NOT modify anything the site serves. Every difference
between the site and the offline version is produced here, in the generated file. The app's own
js/*.js are inlined byte for byte, so the live version cannot regress because of anything below.

A page opened from disk has an opaque origin, which costs three things the app relies on:

  1. fetch() is refused outright, so the basemap geography, airport codes, and the interactive
     HTML export (which re-reads css/app.css, the chart libs, and the fonts) all fail.
  2. new Worker('js/parse-worker.js') is refused, and a blob worker cannot resolve the relative
     importScripts() the worker uses, so parsing would fall back to the main thread and freeze
     the page on a large file.
  3. an <img> pointing at data/etopo-heightmap.png has nothing to point at in a single file, so
     3D terrain elevation is lost.

So the generated file carries a prelude that shims fetch, Worker, and HTMLImageElement.src against
an embedded asset payload. The app source calls them exactly as it always has and never knows.

Drift guard: the script scans the app source, the parse worker, and the stylesheets for asset
references and WARNS about any it did not embed, so a newly added fetch() or @font-face is visible
at build time. It warns rather than failing because this runs inside the Pages deploy, where a
non-zero exit would take the live site's deploy down. It is a best-effort net, not a proof: a path
assembled at runtime ('data/' + name) is invisible to any static scan, so a structural change still
deserves opening the built file once.
"""

import base64
import datetime
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')

# text assets the app reads at runtime through fetch()
TEXT_ASSETS = [
    'data/airports.json',
    'data/us-states.json',
    'data/ne_50m_admin_0_countries.geojson',
    'data/ne_50m_lakes.geojson',
    'css/app.css',
]
# binary assets, embedded base64 for data: URIs
BIN_ASSETS = [
    'data/etopo-heightmap.png',
    'assets/noaa-emblem-64.png',
    'assets/noaa-emblem-72.png',
]
FONTS = [
    'fonts/Manrope-400.woff2',
    'fonts/IBMPlexMono-400.woff2', 'fonts/IBMPlexMono-500.woff2', 'fonts/IBMPlexMono-600.woff2',
    'fonts/Inter-400.woff2', 'fonts/Inter-500.woff2', 'fonts/Inter-600.woff2', 'fonts/Inter-700.woff2',
    'fonts/RobotoMono-400.woff2', 'fonts/RobotoMono-500.woff2', 'fonts/RobotoMono-700.woff2',
]
# the parse worker's importScripts targets, concatenated ahead of it into one blob-able bundle
WORKER = 'js/parse-worker.js'
WORKER_IMPORTS = ['lib/netcdfjs.min.js', 'js/00b-qc-catalog.js', 'js/11b-parser-core.js']


def read_text(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def read_bytes(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return f.read()


def b64(rel):
    return base64.b64encode(read_bytes(rel)).decode('ascii')


def js_string(s):
    """A JS string literal that is safe inside <script>: no raw </script, no line breaks."""
    out = (s.replace('\\', '\\\\').replace('"', '\\"')
            .replace('\r', '\\r').replace('\n', '\\n')
            .replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))
    return '"' + out.replace('</', '<\\/') + '"'


def scrub_script_close(s):
    """Inline JS/CSS may contain the literal </script in a string; neutralise it."""
    return re.sub(r'</(script)', r'<\\/\1', s, flags=re.I)


def git_sha():
    try:
        return subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'],
                                       cwd=ROOT, stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return 'local'


def parse_index_scripts(html):
    """The css and js the page loads, in order, straight from index.html so this script never
    holds a second copy of the load order that could drift out of step with the real one."""
    css = re.findall(r'<link[^>]+rel="stylesheet"[^>]+href="([^"?]+)', html)
    js = re.findall(r'<script[^>]+src="([^"?]+)', html)
    return css, js


def strip_js_comments(src):
    """Drop // and /* */ comments while leaving string and template literals intact, so a path
    written in a comment is not mistaken for a load. Regex literals are not tokenised, so a regex
    containing a quote can still confuse it; that is why the caller only warns."""
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c in '"\'`':
            out.append(c); i += 1
            while i < n:
                if src[i] == '\\':
                    out.append(src[i:i + 2]); i += 2; continue
                out.append(src[i])
                if src[i] == c:
                    i += 1; break
                i += 1
            continue
        if c == '/' and i + 1 < n:
            if src[i + 1] == '/':
                while i < n and src[i] != '\n':
                    i += 1
                continue
            if src[i + 1] == '*':
                i += 2
                while i + 1 < n and not (src[i] == '*' and src[i + 1] == '/'):
                    i += 1
                i += 2
                continue
        out.append(c); i += 1
    return ''.join(out)


# a quoted or backticked repo path, and a css url(); '../' is normalised away so fonts.css matches
REF_JS = re.compile(r"""["'`](?:\./)?((?:data|assets|fonts|lib|css|js)/[A-Za-z0-9._-]+)["'`]""")
REF_CSS = re.compile(r"""url\(\s*['"]?(?:\.\./)?((?:data|assets|fonts)/[A-Za-z0-9._-]+)""")


def warn_unembedded_assets(sources, embedded):
    """Report asset references this build did not embed, so a newly added fetch() or @font-face
    is visible instead of silently shipping a standalone version with a dead feature.

    This WARNS and keeps going on purpose. The build runs inside the Pages deploy, so exiting
    non-zero here would take the live site's deploy down over a cosmetic drift, which is a worse
    failure than an offline version missing one asset. It is a best-effort net, not a proof:
    a path built by concatenation ('data/' + name) cannot be seen by any static scan."""
    missing = {}
    for rel in sources:
        text = read_text(rel)
        hits = (REF_CSS.findall(text) if rel.endswith('.css')
                else REF_JS.findall(strip_js_comments(text)))
        for hit in hits:
            if hit not in embedded:
                missing.setdefault(hit, set()).add(rel)
    if missing:
        print('WARNING: asset(s) referenced by the app but not embedded in this build:', file=sys.stderr)
        for path, files in sorted(missing.items()):
            print('  %-45s referenced by %s' % (path, ', '.join(sorted(files))), file=sys.stderr)
        print('  The offline version will be missing them. Add to TEXT_ASSETS / BIN_ASSETS / FONTS\n'
              '  in tools/build-standalone.py.', file=sys.stderr)
    return missing


def build():
    index = read_text('index.html')
    css_files, js_files = parse_index_scripts(index)
    app_js = [p for p in js_files if p.startswith('js/')]

    stamp_date = datetime.date.today().isoformat()
    sha = git_sha()

    # ---- payload -----------------------------------------------------------------------------
    text_payload = {}
    for rel in TEXT_ASSETS:
        text_payload[rel] = read_text(rel)

    bin_payload = {}
    for rel in BIN_ASSETS + FONTS:
        bin_payload[rel] = b64(rel)

    # the chart libs the interactive HTML export re-reads to inline into its own output
    for rel in ['lib/chart.umd.min.js', 'lib/hammer.min.js', 'lib/chartjs-plugin-zoom.min.js']:
        text_payload[rel] = read_text(rel)

    # one blob-able worker: its importScripts targets first, then the worker with that call removed
    worker_src = read_text(WORKER)
    worker_src = re.sub(r'^\s*importScripts\([^)]*\);\s*$', '', worker_src, flags=re.M)
    bundle = '\n;\n'.join([read_text(p) for p in WORKER_IMPORTS] + [worker_src])
    text_payload['js/parse-worker.bundle.js'] = bundle

    embedded = set(text_payload) | set(bin_payload)
    # the worker imports are reachable through the bundle, and the page loads every lib and app
    # script as an inline <script>, so none of those needs its own payload entry to count as present
    embedded |= set(WORKER_IMPORTS) | set(js_files) | set(css_files) | {WORKER}
    # every source that can name an asset: the page's own scripts, the worker (which index.html
    # never lists), and the stylesheets (fonts.css names each woff2 in a url())
    warn_unembedded_assets(app_js + [WORKER] + css_files, embedded)

    payload = ['window.AOC_EMBED={text:{']
    payload.append(','.join('%s:%s' % (js_string(k), js_string(v)) for k, v in text_payload.items()))
    payload.append('},b64:{')
    payload.append(','.join('%s:%s' % (js_string(k), js_string(v)) for k, v in bin_payload.items()))
    payload.append('}};')
    payload.append('window.AOC_BUILD={date:%s,sha:%s};' % (js_string(stamp_date), js_string(sha)))

    # ---- shims -------------------------------------------------------------------------------
    shims = r"""
(function () {
  var E = window.AOC_EMBED, T = E.text, B = E.b64;
  var MIME = { png: 'image/png', woff2: 'font/woff2', svg: 'image/svg+xml', json: 'application/json' };
  // the app asks with repo-relative paths ('data/airports.json'); an absolute or nested URL is
  // matched by the longest embedded path it ends with, so both forms resolve to one payload key
  function key(u) {
    u = String(u).split('?')[0].split('#')[0].replace(/^\.\//, '');
    if (T[u] !== undefined || B[u] !== undefined) return u;
    var best = '', k;
    for (k in T) if (k.length > best.length && u.length >= k.length && u.slice(-k.length) === k) best = k;
    for (k in B) if (k.length > best.length && u.length >= k.length && u.slice(-k.length) === k) best = k;
    return best || u;
  }
  function bytes(s) {
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function dataURI(k) {
    var ext = k.split('.').pop().toLowerCase();
    return 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + B[k];
  }

  // fetch: a page opened from disk has an opaque origin and the browser refuses fetch() for any
  // local file, so every asset read is answered from the embedded payload instead.
  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    var k = key(input && input.url ? input.url : input);
    if (T[k] !== undefined) return Promise.resolve(new Response(T[k], { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    if (B[k] !== undefined) return Promise.resolve(new Response(bytes(B[k]), { status: 200 }));
    if (/^(https?|blob|data):/i.test(String(input))) return nativeFetch.apply(this, arguments);
    return Promise.reject(new TypeError('offline version: no embedded asset for ' + k));
  };

  // Worker: a file:// document cannot spawn a worker from disk, and a blob worker cannot resolve
  // the relative importScripts the parse worker uses, so it runs the pre-concatenated bundle.
  var NativeWorker = window.Worker;
  window.Worker = function (url, opts) {
    var k = key(url), bundle = T[k.replace(/\.js$/, '.bundle.js')];
    if (bundle) url = URL.createObjectURL(new Blob([bundle], { type: 'text/javascript' }));
    return new NativeWorker(url, opts);
  };

  // <img src="data/etopo-heightmap.png"> has no file to reach in a single-file build. A data URI
  // also keeps the canvas untainted, so the terrain's getImageData still works.
  var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true, enumerable: d.enumerable,
    get: function () { return d.get.call(this); },
    set: function (v) { var k = key(v); d.set.call(this, B[k] !== undefined ? dataURI(k) : v); }
  });

  // build stamp, bottom right, so an old copy is identifiable without opening anything else
  window.addEventListener('load', function () {
    var s = document.createElement('div');
    s.textContent = 'Local version \u00b7 Build date: ' + window.AOC_BUILD.date;
    s.setAttribute('style', 'position:fixed;right:8px;bottom:6px;z-index:2147483647;pointer-events:none;'
      + 'font:400 10px/1.4 "IBM Plex Mono",monospace;color:rgba(140,150,165,0.55);letter-spacing:0.02em;');
    document.body.appendChild(s);
  });
})();
"""

    # ---- assemble ----------------------------------------------------------------------------
    # fonts.css points at ../fonts/*.woff2; nothing can resolve that in a single file
    def inline_css(rel):
        css = read_text(rel)
        if rel.endswith('fonts.css'):
            for f in FONTS:
                css = css.replace('../' + f, 'data:font/woff2;base64,' + bin_payload[f])
        return scrub_script_close(css)

    head_css = '\n'.join('<style>\n%s\n</style>' % inline_css(c) for c in css_files)
    all_js = '\n'.join('<script>\n%s\n</script>' % scrub_script_close(read_text(j)) for j in js_files)

    out = index

    # CSP: 'self' does not match a file:// origin, and the worker now comes from a blob
    out = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>',
                 '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
                 'script-src \'unsafe-inline\' blob:; style-src \'unsafe-inline\'; '
                 'img-src data: blob:; font-src data:; connect-src data: blob:; '
                 'worker-src blob:; object-src \'none\'; form-action \'none\'">', out, count=1)

    # every external reference becomes inline content
    out = re.sub(r'\s*<link[^>]+rel="stylesheet"[^>]*>', '', out)
    out = re.sub(r'\s*<script[^>]+src="[^"]+"[^>]*></script>', '', out)
    out = out.replace('</head>', head_css + '\n</head>', 1)
    out = out.replace('</body>', all_js + '\n</body>', 1)

    # static markup references: favicon and the header emblem
    out = out.replace('href="assets/noaa-emblem-64.png"',
                      'href="data:image/png;base64,' + bin_payload['assets/noaa-emblem-64.png'] + '"')
    out = out.replace('src="assets/noaa-emblem-72.png"',
                      'src="data:image/png;base64,' + bin_payload['assets/noaa-emblem-72.png'] + '"')

    # the offline version is the download, so drop its own download button and the service worker
    out = re.sub(r'\s*<script>\s*if \(\'serviceWorker\' in navigator.*?</script>', '', out, flags=re.S)

    # payload and shims run before any app script
    out = out.replace('<head>', '<head>\n<script>' + ''.join(payload) + '</script>\n<script>'
                      + scrub_script_close(shims) + '</script>', 1)
    out = out.replace('<title>AOC QC Tool</title>',
                      '<title>AOC QC Tool (offline version ' + stamp_date + ')</title>', 1)

    os.makedirs(DIST, exist_ok=True)
    name = 'AOC-QC-Tool-' + stamp_date.replace('-', '')
    html_path = os.path.join(DIST, name + '.html')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(out)
    # a .zip too: .html attachments are routinely stripped by enterprise mail filters
    zip_path = os.path.join(DIST, name + '.zip')
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(html_path, name + '.html')

    # a stable copy for the site's download button to point at
    stable = os.path.join(DIST, 'AOC-QC-Tool.html')
    shutil.copyfile(html_path, stable)

    mb = lambda p: os.path.getsize(p) / 1e6
    print('built %s' % os.path.relpath(html_path, ROOT))
    print('  %-34s %6.2f MB' % (name + '.html', mb(html_path)))
    print('  %-34s %6.2f MB   (for email; .html attachments are often blocked)' % (name + '.zip', mb(zip_path)))
    print('  %-34s %6.2f MB   (stable name for the site download button)' % ('AOC-QC-Tool.html', mb(stable)))
    print('  embedded: %d text, %d binary, build %s %s' % (len(text_payload), len(bin_payload), stamp_date, sha))


if __name__ == '__main__':
    build()
