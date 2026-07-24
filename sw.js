// Offline app shell. Registered from index.html with a *relative* path so the scope stays
// /AOCQualityControl/ on the shared diegoxb07.github.io origin (sibling project pages live on
// the same origin, so both the scope and the cache cleanup below must stay app-prefixed).
//
// CACHE_VERSION keeps the '?v=' shape so the same sed in .github/workflows/static.yml that
// stamps index.html's cache-busters rewrites it to the deploy's commit SHA: every deploy
// installs a fresh cache, and activate() deletes the previous one.
const CACHE_VERSION = '?v=20260724a';
const CACHE_NAME = 'aoc-qc-' + CACHE_VERSION.replace(/[^0-9A-Za-z._-]/g, '');

// Every same-origin file the app needs at runtime. Fetches are matched with ignoreSearch, so the
// ?v= tokens on index.html's includes (and assetVer()'d runtime fetches) hit these entries.
// cache.addAll() rejects if ANY entry 404s: when adding or renaming a css/js/font/data file,
// add it here too, or the precache silently fails and the app just stays online-only.
const PRECACHE = [
    './',

    'css/app.css',
    'css/fonts.css',
    'css/tailwind.css',

    'lib/OrbitControls.js',
    'lib/chart.umd.min.js',
    'lib/chartjs-plugin-zoom.min.js',
    'lib/hammer.min.js',
    'lib/netcdfjs.min.js',
    'lib/three.min.js',

    'js/00b-qc-catalog.js',
    'js/01-state.js',
    'js/02-recon-api.js',
    'js/03-metrics.js',
    'js/06-ocr.js',
    'js/07-ui-controls.js',
    'js/07b-plane-models.js',
    'js/07c-terrain.js',
    'js/09-interaction.js',
    'js/11-layout.js',
    'js/11b-parser-core.js',
    'js/12-file-parsing.js',
    'js/12b-recon-archive.js',
    'js/13-charts-master.js',
    'js/14-filters-sync.js',
    'js/15-map-render.js',
    'js/17-charts.js',
    'js/18-engine.js',
    'js/18b-flight-search.js',
    'js/19-bootstrap.js',
    'js/20-ui-polish.js',
    'js/21-qc-engine.js',
    'js/22-qc-charts.js',
    'js/23-qc-report.js',
    'js/24-qc-export-html.js',
    'js/25-qc-error-summary.js',
    'js/26-qc-track-pdf.js',
    'js/27-nc-txt-converter.js',
    'js/parse-worker.js',

    'fonts/IBMPlexMono-400.woff2',
    'fonts/IBMPlexMono-500.woff2',
    'fonts/IBMPlexMono-600.woff2',
    'fonts/Inter-400.woff2',
    'fonts/Inter-500.woff2',
    'fonts/Inter-600.woff2',
    'fonts/Inter-700.woff2',
    'fonts/Manrope-400.woff2',
    'fonts/RobotoMono-400.woff2',
    'fonts/RobotoMono-500.woff2',
    'fonts/RobotoMono-700.woff2',

    'assets/noaa-bird.svg',
    'assets/noaa-emblem-64.png',
    'assets/noaa-emblem-72.png',
    'assets/noaa-emblem.png',

    'data/airports.json',
    'data/etopo-heightmap.png',
    'data/ne_50m_admin_0_countries.geojson',
    'data/ne_50m_lakes.geojson',
    'data/us-states.json'
];

self.addEventListener('install', (e) => {
    // 'no-cache' forces every precache fetch to revalidate with the server (ETag -> 304 when
    // unchanged, so installs stay cheap). Without it, addAll's default-mode fetches are answered
    // by the browser HTTP cache, and GitHub Pages serves everything with max-age=600 -- a deploy
    // installed inside that window would fill the NEW cache with the PREVIOUS deploy's bytes
    // (whole or torn), and cache-first serving would pin users there until the deploy after next.
    //
    // skipWaiting: the new deploy takes over without waiting for every tab to close. The load
    // that discovers the new sw.js still renders from the old cache; the refresh after that
    // shows the new version. The cache is a complete per-deploy snapshot, so the only skew
    // window is a page from deploy N runtime-fetching from deploy N+1's cache (data files,
    // parse-worker), which is harmless here and better than pinned tabs staying stale for days.
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'no-cache' }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    // Only touch this app's own caches: Cache Storage is origin-wide and other project pages
    // share diegoxb07.github.io.
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k.startsWith('aoc-qc-') && k !== CACHE_NAME)
                    .map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;

    // Cross-origin goes straight to the network, never cached here: the recon-api health check
    // (docs/CONNECTIVITY.md) must see real failures to flip the UI offline, and GIBS/GitHub
    // fallbacks manage their own freshness.
    const url = new URL(e.request.url);
    if (url.origin !== self.location.origin) return;

    e.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(e.request, { ignoreSearch: true });
        if (hit) return hit;
        try {
            return await fetch(e.request);
        } catch (err) {
            // Offline hard-refresh of any in-scope URL still gets the app shell.
            if (e.request.mode === 'navigate') {
                const shell = await cache.match('./');
                if (shell) return shell;
            }
            throw err;
        }
    })());
});
