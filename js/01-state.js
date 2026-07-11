/* Mission Visualizer, global playback/render state
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    let allParsedData = [];
    let filteredData = [];
    let availableMetrics = new Set();
    let currentIdx = 0;
    let isPlaying = false;
    let isNcFile = false;
    
    let satImage = new Image();
    let satImageLoaded = false;
    let satTileOpacity = 0.92;   // satellite tile draw opacity, controlled by the opacity slider in the sat picker
    let lastSatFetchTime = "";
    let satLoadedInfo = null;
    let satImageBox = null;
    let satDebounceTimer = null;
    // Two-tier satellite tile cache, both keyed by fetchId (layer||band||time||box). HOT = decoded
    // drawables for instant display. COLD = compressed PNG blobs, surviving across flights until the
    // tab closes. A COLD hit decodes into HOT on demand; the preloader pre-decodes upcoming buckets.
    const satTileCache = new Map();          // HOT: fetchId -> { canvas, box, scanStartMs }
    const SAT_CACHE_MAX = 24;                // just the playback neighborhood (decoded = RAM-heavy)
    const satBlobStore = new Map();          // COLD: fetchId -> { blob, box, scanStartMs }
    const SAT_BLOB_MAX = 1500;               // ≈ 30 storm-bands of 10-min tiles (LRU-evicted)
    let batchCaching = false;                // a multi-flight local sat-cache pass is running
    let batchCacheCancel = false;            // user asked to stop the current pass
    let batchCacheAbortController = null;    // aborts the in-flight recon-api request/poll on Cancel
    let batchCachePass = 0;                  // bumped per pass; a Cancel invalidates the running pass so its teardown no-ops
    // Smooth scrubbing: a background preloader warms the buckets around the playhead into the cache.
    const satFetchInFlight = new Map();      // fetchId -> in-flight Promise (dedupe live + preload + prefetch)
    let satPreloadQueue = [];                // upcoming buckets queued to warm around the playhead
    let satPreloadActive = false;            // the preload worker loop is running
    let _satPreloadBucket = null;            // last playhead bucket we queued neighbors for (avoids requeue spam)
    let slideSyncTimer = null;  
    let isResizingMedia = false; 

    let mapFeatures = [];
    let customMarkers = [];
    let flightMetaData = { id: 'Unknown', date: 'Unknown', aircraft: 'Unknown' };

    // --- NOAA Recon Archive (noaa-recon-api: https://joshmurdock.net/api) -----------------------
    // Year/storm/mission browser + best-track overlay, so a flight can be loaded straight from the
    // archive instead of a manual file upload. See js/12b-recon-archive.js.
    let reconArchiveMeta = null;      // { missionId, stormName, stormId, aircraft, tailNum, sourceUrl } of the loaded mission, or null
    let stormTrackPoints = [];        // Best-track fixes for the WHOLE storm life: [{ms, lat, lon, windKt, pressureMb, category, status}]
    let stormTrackMeta = null;        // { year, name, basin, atcfId } for the loaded best-track, or null
    let showStormTrack = false;       // "Storm Track" toggle; off until the user turns it on
    let hoveredStormIdx = -1;         // index into stormTrackPoints currently under the mouse (2D map hover), -1 = none
    let currentPointAnalysisData = null; 
    let tempBaseline = [];
    
    let bgNeedsUpdate = true;
    let bgCanvas = document.createElement('canvas');
    let bgCtx = bgCanvas.getContext('2d');

    // HiDPI: the canvas backing store is sized cssW*DPR x cssH*DPR (sharp on Retina), while all
    // projection + mouse math works in LOGICAL css pixels (cssW/cssH). DPR is applied as the base
    // transform in the renderers. Set by resizeCanvasLayout.
    let cssW = 0, cssH = 0, DPR = 1;
