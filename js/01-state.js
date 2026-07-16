/* Mission Visualizer, global playback/render state
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    let allParsedData = [];
    let filteredData = [];
    // parseFlightRawQC output for the loaded flight: the catalog set (qcRawData, set in js/12) drives
    // the QC engine; the every-variable set (qcRawDataAll) feeds the NC-to-TXT converter (js/27) and is
    // present only for the currently open, interactively-loaded flight (never persisted).
    let qcRawDataAll = null;
    let availableMetrics = new Set();
    let currentIdx = 0;
    let isPlaying = false;
    let isNcFile = false;
    
    let slideSyncTimer = null;
    let isResizingMedia = false; 

    let mapFeatures = [];
    // Extra basemap detail for the QC flight-track map only (js/22 overlay, js/24 export, js/26 pdf),
    // kept OUT of mapFeatures so the visualizer's 2D/3D map and terrain land-mask are untouched.
    // qcLakes: lake polygons (ne_50m_lakes). qcRegionLabels: { name, lon, lat, n } one entry per
    // labelable landmass — the US state name, else the country/territory name — built in js/19 from
    // the loaded country + state features, filtered/capped at draw time. Both empty until they land.
    let qcLakes = [];
    let qcRegionLabels = [];
    // Airfields for the 2D basemap: { code, name, lat, lon, big, mil }, filled by loadAirports()
    // (js/19-bootstrap.js) from data/airports.json. Empty until it lands, and stays empty if it fails.
    let airports = [];
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
