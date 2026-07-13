/* Mission Visualizer, metric definitions + map state
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    let scene3D, camera3D, renderer3D, controls3D;
    let planeGroup3D, trackArrow3D, headingArrow3D;
    let threeMapGroup = new THREE.Group();
    let threeMarkersGroup = new THREE.Group();
    let threeDInitialized = false;

    // Console redesign: neon data palette (equal-weight lines, no gradient fills).
    const METRIC_DEFS = {
        'pAlt': { label: 'Press Altitude (m)', color: '#c2beb5', yAxisID: 'y' },
        'gpsAlt': { label: 'GPS Altitude (m)', color: '#9aa1ad', yAxisID: 'y' },
        'radAlt': { label: 'Radar Altitude (m)', color: '#38bdf8', yAxisID: 'y' },
        'dValue': { label: 'D-Value (m)', color: '#7c93ff', yAxisID: 'y' },
        'sfcPr': { label: 'Surface Press (mb)', color: '#4cc3ff', yAxisID: 'y' },
        'tempr': { label: 'Ambient Temp (°C)', color: '#e0847b', yAxisID: 'y1' },
        'dewpt': { label: 'Dew Point (°C)', color: '#e0a566', yAxisID: 'y1' },
        'tas': { label: 'TAS (kt)', color: '#fbbf24', yAxisID: 'y1' },
        'ias': { label: 'IAS (kt)', color: '#7dd3fc', yAxisID: 'y1' },
        'windSpd': { label: 'Wind Speed (kt)', color: '#aeb4bf', yAxisID: 'y1' },
        'driftAngle': { label: 'Drift Angle (Deg)', color: '#7ad9ff', yAxisID: 'y1' },
        'th': { label: 'True Heading (Deg)', color: '#6ea8ff', yAxisID: 'y1' },
        'gTrack': { label: 'Ground Track (Deg)', color: '#22d0ee', yAxisID: 'y1' },
        'pitch': { label: 'Pitch (°)', color: '#ff5c5c', yAxisID: 'y1' },
        'roll': { label: 'Roll (°)', color: '#4cc3ff', yAxisID: 'y1' },
        'alpha': { label: 'Alpha (AOA °)', color: '#93c5fd', yAxisID: 'y1' },
        'beta': { label: 'Beta (Slip °)', color: '#8f97a3', yAxisID: 'y1' },
        'vtWnd': { label: 'Vert Wind (m/s)', color: '#ff3d71', yAxisID: 'y1' },
        'accZ': { label: 'Vertical Accel (m/s²)', color: '#fb7185', yAxisID: 'y1' },
        'mixRate': { label: 'Mixing Ratio (g/kg)', color: '#ffd84d', yAxisID: 'y1' },
        'thetaE': { label: 'Theta E (K)', color: '#c2c8d1', yAxisID: 'y1' },
        'pressure': { label: 'Static Press (mb)', color: '#bae6fd', yAxisID: 'y' }
    };

    let customCharts = {}; 
    let masterChartInstance = null;
    let animationFrameId = null;
    let videoLoaded = false;
    let videoStartSeconds = 0;
    let lastTickTime = 0;
    let videoPlaybackAccumulator = 0;

    let mapScale = 1, mapOffsetX = 0, mapOffsetY = 0;
    let isDraggingMap = false, dragStartX = 0, dragStartY = 0;
    let followAircraft2D = true;   // 2D map keeps the plane centered until the user pans/zooms away
    let playbackAccumulator = 0;
    let speeds = [1, 2, 4, 8, 16, 32, 64, 128]; 
    let currentSpeedIdx = 0;
    let plotMinLon, plotMaxLon, plotMinLat, plotMaxLat, deltaLon, deltaLat;
    let lonDomainCenter = 0;   // 0 for normal flights; the flight's circular-mean lon for dateline crossers (see wrapLon)

    let isScrubbing = false, activeScrubChart = null, wasPlayingBeforeScrub = false;
    let hasInitialSyncOccurred = false, scrubSyncTimeout = null, forceOcrSyncNextTick = false;
    let isManualSyncRequest = false, scrubDebounceTimer = null;
