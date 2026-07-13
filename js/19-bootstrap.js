/* Mission Visualizer, remaining wiring, map geojson fetch, clip recorder
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    ['startTimeInput', 'endTimeInput', 'videoStartInput'].forEach(id => { 
        const el = document.getElementById(id);
        const handleChange = () => {
            if (id === 'videoStartInput' && videoLoaded) updateEndWindowFromVideo(false);
            else if (allParsedData.length > 0) applyFiltersAndInit(false); 
        };
        el.addEventListener('change', handleChange);
        el.addEventListener('keyup', (e) => { if (e.key === 'Enter') el.blur(); });
    });
    
    // The old "Apply & Run" button is gone, the Play button folds it in (see the play handler below).

    // Batch satellite cache modal (works across many storms without loading each flight into the app).
    (function wireBatchCache() {
        const btn = document.getElementById('batchCacheBtn');
        const modal = document.getElementById('batchCacheModal');
        const fileInput = document.getElementById('batchFileInput');
        const startBtn = document.getElementById('batchCacheStartBtn');
        if (!btn || !modal || !fileInput || !startBtn) return;
        let picked = [];
        // Closing the modal only HIDES it, caching keeps running in the background (progress shows on
        // the on-map pill), so the user can close it and keep working. Stopping is explicit (Stop button
        // or the pill's Cancel).
        const closeModal = () => { modal.style.display = 'none'; };
        btn.addEventListener('click', () => { populateBatchSatSelect(); populateBatchBandChecks(); modal.style.display = 'flex'; });
        document.getElementById('batchCacheCloseBtn').addEventListener('click', closeModal);
        document.getElementById('batchCacheCloseX').addEventListener('click', closeModal);
        const satSelect = document.getElementById('batchSatSelect');
        if (satSelect) satSelect.addEventListener('change', populateBatchBandChecks);   // bands differ per satellite
        // Set the cancel flag AND abort whatever request/poll is currently in flight, so the pass
        // actually stops within a tick instead of finishing out its current (up to 30s) poll wait.
        const requestCacheCancel = () => {
            if (!batchCaching) return;
            // full, immediate teardown so the user can use the satellite controls right away instead of
            // waiting for the loop to unwind. bumping the pass invalidates the running loop (it stops on
            // its next check and skips its own teardown), and the abort kills the in-flight tile fetch.
            batchCacheCancel = true;
            batchCachePass++;
            if (batchCacheAbortController) { try { batchCacheAbortController.abort(); } catch (e) {} }
            batchCaching = false; batchCacheAbortController = null;
            if (typeof setSatelliteControlsLocked === 'function') setSatelliteControlsLocked(false);
            const sb = document.getElementById('batchCacheStartBtn'); if (sb) sb.textContent = 'Start caching';
            const pl = document.getElementById('satPrefetchLabel'); if (pl) pl.textContent = 'Stopped';
            const ml = document.getElementById('batchCacheStatus'); if (ml) ml.textContent = 'Cache stopped.';
            if (typeof hideSatPrefetchBar === 'function') setTimeout(hideSatPrefetchBar, 800);
        };
        const pillCancel = document.getElementById('satPrefetchCancel');
        if (pillCancel) pillCancel.addEventListener('click', () => { if (batchCaching) requestCacheCancel(); });
        fileInput.addEventListener('change', (e) => {
            picked = Array.from(e.target.files || []);
            document.getElementById('batchCacheStatus').textContent = picked.length ? `${picked.length} file(s) selected.` : 'No files selected.';
        });
        startBtn.addEventListener('click', () => {
            if (batchCaching) { requestCacheCancel(); return; }
            const bands = Array.from(document.querySelectorAll('#batchBandChecks input:checked')).map(c => c.value);
            batchCacheFlights(picked, bands, satSelect ? satSelect.value : '');
        });
    })();

    // Jump the playhead by N flight-minutes (10-min steps line up with the GOES scan cadence).
    function skipFlightMinutes(mins) {
        if (!filteredData.length || !filteredData[currentIdx]) return;
        const targetSec = filteredData[currentIdx].absSeconds + mins * 60;
        let bestIdx = currentIdx, bestDiff = Infinity;
        for (let i = 0; i < filteredData.length; i++) {
            const diff = Math.abs(filteredData[i].absSeconds - targetSec);
            if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
        }
        if (bestIdx === currentIdx) return;
        currentIdx = bestIdx;
        timelineSlider.value = currentIdx;
        if (videoLoaded && filteredData[currentIdx]) {
            let vt = Math.max(0, filteredData[currentIdx].absSeconds - videoStartSeconds);
            if (video.duration) vt = Math.min(vt, video.duration);
            video.currentTime = vt;
        }
        updateVisualComponents(currentIdx);
    }
    document.getElementById('skipBack10Btn').addEventListener('click', () => skipFlightMinutes(-10));
    document.getElementById('skipFwd10Btn').addEventListener('click', () => skipFlightMinutes(10));

    // resets the app to its fresh-load state in place, without a page reload, so real (page) fullscreen
    // is kept (re-entering fullscreen needs a user gesture a reload can't carry). tears down the loaded
    // flight, video, satellite overlay, charts and map/3d view via the same helpers used when switching
    // flights. things that persist across an F5 are left alone: display prefs (aocVizPrefs), the
    // preloaded-mission list, the satellite tile cache, and the basemap geojson.
    function resetAppToDefault() {
        // drop the shareable ?mission=/t=/view= params so a later manual F5 also lands on a clean session.
        try { const u = new URL(window.location.href); ['mission', 't', 'view'].forEach(k => u.searchParams.delete(k)); history.replaceState(null, '', u); } catch (e) {}

        // stop playback and any pending sync/render timers.
        isPlaying = false; playPauseBtn.innerText = 'Play';
        if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
        [scrubSyncTimeout, scrubDebounceTimer, slideSyncTimer, satDebounceTimer].forEach(t => { if (t) clearTimeout(t); });
        scrubSyncTimeout = null; scrubDebounceTimer = null; slideSyncTimer = null; satDebounceTimer = null;
        playbackAccumulator = 0; lastTickTime = 0; videoPlaybackAccumulator = 0; videoStartSeconds = 0;

        // stop any running multi-flight satellite cache pass (requestCacheCancel is trapped in the batch
        // IIFE, so replicate its teardown here) and clear the tile preloader queue.
        if (batchCaching) {
            batchCacheCancel = true; batchCachePass++;
            if (batchCacheAbortController) { try { batchCacheAbortController.abort(); } catch (e) {} }
            batchCaching = false; batchCacheAbortController = null;
            if (typeof setSatelliteControlsLocked === 'function') setSatelliteControlsLocked(false);
            if (typeof hideSatPrefetchBar === 'function') hideSatPrefetchBar();
        }
        if (typeof resetSatPreload === 'function') resetSatPreload();

        // unload the MMR video (revokes its object URL, resets both drop zones + speeds) and drop its zoom/pan.
        if (typeof clearLoadedMedia === 'function') clearLoadedMedia();
        currentSpeedIdx = 0; if (typeof updateSpeedDisplay === 'function') updateSpeedDisplay();
        vidZoom = 1; vidPanX = 0; vidPanY = 0; if (radarVid) radarVid.style.transform = '';

        // tear down every chart (master + per-metric sub-charts + any clip-preview charts).
        if (masterChartInstance) { try { masterChartInstance.destroy(); } catch (e) {} }
        masterChartInstance = null;
        Object.values(customCharts).forEach(c => { try { c.destroy(); } catch (e) {} }); customCharts = {};
        if (typeof destroyClipPreviews === 'function') destroyClipPreviews();

        // clear the loaded flight, storm-track, analysis and scrub state.
        allParsedData = []; filteredData = []; availableMetrics.clear(); currentIdx = 0; _lastStaticIdx = -1;
        customMarkers = []; tempBaseline = []; lastParseStats = null;
        flightMetaData = { id: 'Unknown', date: 'Unknown', aircraft: 'Unknown' };
        if (typeof qcResetToEmpty === 'function') qcResetToEmpty();
        reconArchiveMeta = null; stormTrackPoints = []; stormTrackMeta = null;
        showStormTrack = false; hoveredStormIdx = -1; currentPointAnalysisData = null;
        window._appliedWindow = undefined;
        isScrubbing = false; activeScrubChart = null;
        hasInitialSyncOccurred = false; forceOcrSyncNextTick = false; lastOcrVideoTime = 0;

        // reset the map view + satellite draw state, and put the satellite picker back to Off.
        mapScale = 1; mapOffsetX = 0; mapOffsetY = 0; followAircraft2D = true; bgNeedsUpdate = true;
        satImageLoaded = false; satImage = new Image(); satLoadedInfo = null; satImageBox = null; lastSatFetchTime = '';
        satTileOpacity = 0.92;
        const opSlider = document.getElementById('satOpacitySlider'); if (opSlider) opSlider.value = 92;
        const opVal = document.getElementById('satOpacityVal'); if (opVal) opVal.textContent = '92%';
        const satSel = document.getElementById('satelliteSelect'); if (satSel) satSel.value = 'none';
        const bandSel = document.getElementById('satBandSelect'); if (bandSel) bandSel.value = '';
        if (typeof updateSatelliteOptions === 'function') updateSatelliteOptions();   // repopulate for "no flight": hides band + legend, refreshes the picker button

        // wipe the tracker canvases; clear the 3d scene's dynamic content if it was ever built.
        try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (e) {}
        if (threeDInitialized) {
            while (threeMapGroup.children.length > 0) threeMapGroup.remove(threeMapGroup.children[0]);
            if (typeof sync3DMarkers === 'function') sync3DMarkers();   // customMarkers is [] now, so this empties the marker group
            [planeGroup3D, trackArrow3D, headingArrow3D, stormFixRing3D].forEach(o => { if (o) o.visible = false; });
            attitudeHud.innerHTML = '';
        }

        // restore the fresh-load UI: show placeholders, hide the flight-only overlays, re-disable controls.
        mapPlaceholder.style.display = '';
        const stormLbl = document.getElementById('stormTrackToggleLabel'); if (stormLbl) stormLbl.style.display = 'none';
        const stormCb = document.getElementById('toggleStormTrack'); if (stormCb) stormCb.checked = false;
        const dataLine = document.getElementById('dataReportLine'); if (dataLine) dataLine.classList.add('hidden');
        const srcLink = document.getElementById('reconSourceLink'); if (srcLink) srcLink.classList.add('hidden');
        const badge = document.getElementById('satTimeBadge'); if (badge) badge.classList.add('hidden');
        if (ocrIndicator) ocrIndicator.style.display = 'none';
        ['replayBtn','playPauseBtn','markBtn','clearMarksBtn','timelineSlider','skipBack10Btn','skipFwd10Btn','startTimeInput','endTimeInput','exportClipBtn'].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });
        const startI = document.getElementById('startTimeInput'); if (startI) startI.value = '';
        const endI = document.getElementById('endTimeInput'); if (endI) endI.value = '';
        const vsi = document.getElementById('videoStartInput'); if (vsi) { vsi.value = '000000'; vsi.disabled = true; }
        timelineSlider.min = 0; timelineSlider.max = 100; timelineSlider.value = 0;
        if (timelineTimeDisplay) timelineTimeDisplay.textContent = '00:00:00 UTC';
        updateMissionHeader();            // blanks the header chips + resets document.title
        updateMasterGraphVisibility();    // master chart gone -> show the "create a graph" prompt

        // put the dropdowns back to their default state (as a fresh reload would): the previously-loaded
        // picker back to its "Previously Loaded Missions…" label (the saved list itself stays), the
        // archive Year->Storm->Mission cascade back to unpicked, and close any open popovers.
        if (typeof updatePreloadedSelect === 'function') updatePreloadedSelect('');
        if (typeof closeLoadedPicker === 'function') closeLoadedPicker();
        if (typeof closeSatPicker === 'function') closeSatPicker();
        const reconYearSel = document.getElementById('reconYearSelect');
        if (reconYearSel && reconYearSel.value) { reconYearSel.value = ''; reconYearSel.dispatchEvent(new Event('change')); }

        if (typeof syncMediaGridLayout === 'function') syncMediaGridLayout();
    }

    document.getElementById('resetAppBtn').addEventListener('click', resetAppToDefault);

    // Mini playback bar (shown in the collapsed media strip): keeps play/pause, scrubbing, marking and
    // S.I. usable when the full playback bar is collapsed away with the media. The controls proxy the
    // real ones (so all their logic runs unchanged), and syncMiniPlaybackBar mirrors state back each frame.
    (function wireMiniPlayback() {
        const $ = id => document.getElementById(id);
        const miniSlider = $('miniTimelineSlider');
        if (!miniSlider) return;
        const mainSlider = $('timelineSlider'), mainTime = $('timelineTimeDisplay');
        const miniTime = $('miniTimeDisplay'), miniPlay = $('miniPlayBtn'), miniSI = $('miniToggleSI');
        // scrubbing: forward to the real slider (its own handlers scrub; the window mouseup ends it).
        miniSlider.addEventListener('mousedown', () => mainSlider.dispatchEvent(new Event('mousedown')));
        miniSlider.addEventListener('touchstart', () => mainSlider.dispatchEvent(new Event('touchstart')), { passive: true });
        miniSlider.addEventListener('input', () => { mainSlider.value = miniSlider.value; mainSlider.dispatchEvent(new Event('input')); });
        miniPlay.addEventListener('click', () => $('playPauseBtn').click());
        $('miniMarkBtn').addEventListener('click', () => $('markBtn').click());
        $('miniClearBtn').addEventListener('click', () => $('clearMarksBtn').click());
        miniSI.addEventListener('change', () => { const t = $('toggleSI'); t.checked = miniSI.checked; t.dispatchEvent(new Event('change')); });
        // main -> mini mirror; called each frame from updateVisualComponents and on collapse toggle.
        window.syncMiniPlaybackBar = function () {
            miniSlider.min = mainSlider.min;
            if (miniSlider.max !== mainSlider.max) miniSlider.max = mainSlider.max;
            if (!isScrubbing) miniSlider.value = mainSlider.value;
            miniSlider.disabled = mainSlider.disabled;
            if (miniTime && mainTime) miniTime.textContent = mainTime.innerText;
            if (miniPlay) miniPlay.textContent = isPlaying ? 'Pause' : 'Play';
            if (miniSI) miniSI.checked = $('toggleSI').checked;
        };
    })();

    // Fullscreen any graph: inject a ⛶ button into each chart panel's title row that fills the viewport
    // with just that graph and hides the top-right sticky cluster (like the media panel fullscreens).
    // Toggle off with the button again or Esc.
    (function wireChartFullscreen() {
        const resizeChartIn = (panel) => setTimeout(() => {
            const cv = panel.querySelector('canvas');
            const ch = cv && typeof Chart !== 'undefined' && Chart.getChart(cv);
            if (ch) ch.resize();
        }, 60);
        const topRight = () => document.getElementById('topRightControls');
        function toggleChartFullscreen(panel) {
            const tr = topRight();
            if (panel.classList.contains('chart-fs')) {
                panel.classList.remove('chart-fs');
                if (tr && !document.querySelector('.fake-fs')) tr.style.display = '';
                if (document.fullscreenElement && !document.querySelector('.fake-fs')) document.exitFullscreen().catch(() => {});
                resizeChartIn(panel);
                return;
            }
            if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
            panel.classList.add('chart-fs');
            if (tr) tr.style.display = 'none';
            resizeChartIn(panel);
        }
        document.querySelectorAll('[id^="title-"]').forEach(titleRow => {
            const group = titleRow.querySelector('.flex.items-center.gap-2');
            const panel = titleRow.parentElement;
            if (!group || !panel) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'reset-scale-btn text-muted text-base hover:text-accent hover:scale-110 transition-all focus:outline-none';
            btn.title = 'Fullscreen this graph';
            btn.textContent = '⛶';
            btn.addEventListener('click', (e) => { e.stopPropagation(); toggleChartFullscreen(panel); });
            group.insertBefore(btn, group.firstChild);
        });
        // Esc / leaving real fullscreen drops any fullscreened graph too.
        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement) document.querySelectorAll('.chart-fs').forEach(p => { p.classList.remove('chart-fs'); resizeChartIn(p); });
        });
    })();

    playPauseBtn.addEventListener('click', function() {
        // Fold the old "Apply & Run" into Play: when starting playback in manual mode, if the start/end
        // time window was edited since it was last applied, apply it (from the window start) then play.
        if (!isPlaying && allParsedData.length && videoSyncMode.value !== 'auto') {
            const win = document.getElementById('startTimeInput').value + '|' + document.getElementById('endTimeInput').value + '|' + document.getElementById('videoStartInput').value;
            if (win !== window._appliedWindow) { applyFiltersAndInit(true); return; }
        }
        if (filteredData.length === 0) return;
        if (isPlaying) {
            isPlaying = false; playPauseBtn.innerText = "Play"; 
            if (videoLoaded) video.pause(); 
            if (animationFrameId) cancelAnimationFrame(animationFrameId); 
        } else { 
            isPlaying = true; playPauseBtn.innerText = "Pause"; 
            playbackAccumulator = 0; lastTickTime = performance.now(); 
            
            if (videoSyncMode.value === 'auto' && !hasInitialSyncOccurred) {
                setTimeout(() => {
                    forceOcrSyncNextTick = true;
                    hasInitialSyncOccurred = true;
                }, 2000);
            }

            if (videoLoaded && speeds[currentSpeedIdx] <= 16) { 
                try { video.playbackRate = speeds[currentSpeedIdx]; } catch(e) {}
                video.play().catch(e=>{}); 
            } 
            masterSyncEngineTick(); 
        }
    });

    speedUpBtn.addEventListener('click', function() { currentSpeedIdx = Math.min(currentSpeedIdx + 1, speeds.length - 1); updateSpeedDisplay(); });
    speedDownBtn.addEventListener('click', function() { currentSpeedIdx = Math.max(currentSpeedIdx - 1, 0); updateSpeedDisplay(); });
    
    replayBtn.addEventListener('click', function() {
        if (filteredData.length === 0) return;
        isPlaying = false; playPauseBtn.innerText = "Play"; currentSpeedIdx = 0; updateSpeedDisplay();
        updateSatelliteOptions();
        satImageLoaded = false; lastSatFetchTime = ''; bgNeedsUpdate = true;

        if (videoLoaded) { video.pause(); video.playbackRate = speeds[currentSpeedIdx]; } if (animationFrameId) cancelAnimationFrame(animationFrameId);
        
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0,0, canvas.width, canvas.height);
        [masterChartInstance, ...Object.values(customCharts)].forEach(c => { if(c) { c.resetZoom(); c.draw(); } });
        
        resetMapView(); if (trackerModeSelect.value === '3d') build3DScene(); updateMasterGraphVisibility();
        

        hasInitialSyncOccurred = false; clearTimeout(scrubSyncTimeout); clearTimeout(slideSyncTimer);
        satImageLoaded = false; lastSatFetchTime = ''; bgNeedsUpdate = true;

        if (videoLoaded) { video.currentTime = 0; currentIdx = 0; syncTelemetryToVideoClock(); } 
        else { setTimeout(() => { currentIdx = 0; isPlaying = true; playPauseBtn.innerText = "Pause"; playbackAccumulator = 0; lastTickTime = performance.now(); masterSyncEngineTick(); }, 30); }
    });

    function calculateFeatureBBox(feature) {
        let minX = 180, maxX = -180, minY = 90, maxY = -90;
        const checkCoord = (c) => {
            if(c[0] < minX) minX = c[0]; if(c[0] > maxX) maxX = c[0];
            if(c[1] < minY) minY = c[1]; if(c[1] > maxY) maxY = c[1];
        };
        if(feature.geometry && feature.geometry.coordinates) {
            if(feature.geometry.type === 'Polygon') feature.geometry.coordinates.forEach(ring => ring.forEach(checkCoord));
            else if(feature.geometry.type === 'MultiPolygon') feature.geometry.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(checkCoord)));
        }
        return [minX, minY, maxX, maxY];
    }

    // Local copies first (data/ ships with the app, so the basemap works offline);
    // fall back to the original remote sources if the local fetch fails (e.g. file://).
    const fetchGeo = (localPath, remoteUrl) =>
        fetch(localPath).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
            .catch(() => fetch(remoteUrl).then(r => r.json()));
    Promise.all([
        fetchGeo('data/ne_50m_admin_0_countries.geojson', 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson'),
        fetchGeo('data/us-states.json', 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json')
    ]).then(([world, us]) => {
        if (world && world.features) {
            world.features.forEach(f => {
                f.properties = f.properties || {}; f.properties.bbox = calculateFeatureBBox(f);
                mapFeatures.push(f);
            });
        }
        if (us && us.features) {
            us.features.forEach(f => { 
                f.properties = f.properties || {}; f.properties.isState = true; f.properties.bbox = calculateFeatureBBox(f);
                mapFeatures.push(f);
            });
        }
        bgNeedsUpdate = true; if (filteredData.length > 0 && trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
    }).catch(e => {});

    // --- MP4 Video Zoom & Pan Logic ---
    let vidZoom = 1;
    let vidPanX = 0;
    let vidPanY = 0;
    let isVidDragging = false;
    let vidStartX = 0;
    let vidStartY = 0;

    const radarVid = document.getElementById('radarVideo');
    const vidWrapper = radarVid.parentElement;

    // Set up CSS for bounds and smooth zooming
    radarVid.style.transformOrigin = 'center center';
    radarVid.style.transition = 'transform 0.1s ease-out';
    vidWrapper.style.overflow = 'hidden';

    // The video panel's ⟲ button drops zoom and pan back to the native fit.
    document.getElementById('resetVideoZoomBtn').addEventListener('click', () => {
        vidZoom = 1; vidPanX = 0; vidPanY = 0;
        radarVid.style.transform = '';
    });

    // Mouse Wheel: Zoom in/out
    vidWrapper.addEventListener('wheel', (e) => {
        if (!videoLoaded) return;
        e.preventDefault();
        const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
        vidZoom = Math.max(1, Math.min(vidZoom * zoomDelta, 8)); // Limits zoom from 1x to 8x
        
        // Snap back to center if fully zoomed out
        if (vidZoom === 1) { 
            vidPanX = 0; 
            vidPanY = 0; 
        }
        radarVid.style.transform = `translate(${vidPanX}px, ${vidPanY}px) scale(${vidZoom})`;
    });

    // Mouse Down: Start Pan
    vidWrapper.addEventListener('mousedown', (e) => {
        if (!videoLoaded || vidZoom <= 1) return;
        isVidDragging = true;
        vidStartX = e.clientX - vidPanX;
        vidStartY = e.clientY - vidPanY;
        vidWrapper.style.cursor = 'grabbing';
    });

    // Mouse Move: Drag Pan
    window.addEventListener('mousemove', (e) => {
        if (!isVidDragging) return;
        
        // Let the user pan, but keep it constrained inside the zoom area
        let maxX = (radarVid.clientWidth * vidZoom - radarVid.clientWidth) / 2;
        let maxY = (radarVid.clientHeight * vidZoom - radarVid.clientHeight) / 2;

        vidPanX = Math.max(-maxX, Math.min(maxX, e.clientX - vidStartX));
        vidPanY = Math.max(-maxY, Math.min(maxY, e.clientY - vidStartY));

        radarVid.style.transform = `translate(${vidPanX}px, ${vidPanY}px) scale(${vidZoom})`;
    });

    // Mouse Up: Stop Pan
    window.addEventListener('mouseup', () => {
        isVidDragging = false;
        vidWrapper.style.cursor = 'default';
    });

    // Double Click: Reset View
    vidWrapper.addEventListener('dblclick', () => {
        vidZoom = 1; 
        vidPanX = 0; 
        vidPanY = 0;
        radarVid.style.transform = `translate(0px, 0px) scale(1)`;
    });

    // --- Composite Clip Recorder ---------------------------------------------------------------
    // Records a single 1080p WebM by compositing the live tracker (2D/3D + satellite) on the left and
    // the user-selected graphs stacked down the right onto an offscreen canvas, no screen sharing.
    // The recorder drives playback through the chosen segment; the user can keep adjusting the view.
    const recordCanvas = document.getElementById('recordCanvas');
    let clipGraphEntries = [];   // graphs offered in the modal this open
    let clipCustomDefs = [];     // user-built metric combos for this clip only: [{ keys:[...] }]; ids are 'cust:<i>'
    let recState = null;         // active recording state, or null when idle

    const CLIP_NAME_FALLBACK = {
        tempChart: 'Temperature', navChart: 'Navigation Angles', attChart: 'Attitude / Flow',
        altChart: 'Altitude', tasChart: 'Speed', vertWindChart: 'Vertical Wind & Accel',
        sfcChart: 'Pressure', thermoChart: 'Thermodynamics', parameterChart: 'Custom Graph'
    };
    function clipChartFor(id) { return id === 'parameterChart' ? masterChartInstance : customCharts[id]; }
    function clipCustomDef(id) { return (typeof id === 'string' && id.indexOf('cust:') === 0) ? clipCustomDefs[+id.slice(5)] : null; }
    function clipGraphName(id) {
        const cd = clipCustomDef(id);
        if (cd) {
            if (!cd.keys.length) return 'Custom graph';
            const isImp = !document.getElementById('toggleSI').checked;
            return cd.keys.map(k => getMetricLabel(k, isImp).replace(/\s*\([^)]*\)\s*$/, '')).join(', ');
        }
        const titleEl = document.getElementById('title-' + id);
        if (titleEl && titleEl.childNodes[0] && titleEl.childNodes[0].nodeValue) {
            const t = titleEl.childNodes[0].nodeValue.trim();
            if (t) return t;
        }
        return CLIP_NAME_FALLBACK[id] || id;
    }
    function clipTimeline() { return filteredData.map(d => `${d.time.slice(0, 2)}:${d.time.slice(2, 4)}:${d.time.slice(4)}`); }
    function clipDatasetsFor(keys) {
        const isImp = !document.getElementById('toggleSI').checked;
        return keys.filter(k => availableMetrics.has(k)).map(k => {
            const ds = createDatasetConfig(k);
            ds.data = filteredData.map(d => getConvertedVal(d[k], k, isImp));
            return ds;
        });
    }
    // Build a throwaway Chart for a custom metric combo, offscreen, for the recording only.
    function buildClipCustomChart(keys, name) {
        const cv = document.createElement('canvas'); cv.width = 760; cv.height = 320;
        const opts = getBaseChartOptions(name, { enforceIntegers: false, minRange: 0 });
        opts.responsive = false; opts.maintainAspectRatio = false;
        return new Chart(cv.getContext('2d'), { type: 'line', data: { labels: clipTimeline(), datasets: clipDatasetsFor(keys) }, options: opts, plugins: [markerPlugin] });
    }
    let clipPreviewCharts = [];   // live preview charts in the custom-graph builders; torn down each rebuild
    function destroyClipPreviews() { clipPreviewCharts.forEach(c => { try { c.destroy(); } catch (e) {} }); clipPreviewCharts = []; }
    function updateClipCustomChart(chart, keys) { chart.data.datasets = clipDatasetsFor(keys); chart.update('none'); }
    // Each custom graph is a builder card: variable checkboxes on the left, a live preview on the right.
    function renderClipCustomList() {
        const box = document.getElementById('clipCustomList'); if (!box) return;
        destroyClipPreviews();
        box.innerHTML = '';
        const isImp = !document.getElementById('toggleSI').checked;
        const metrics = [...availableMetrics];
        clipCustomDefs.forEach((def, i) => {
            const card = document.createElement('div');
            card.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:8px;display:flex;flex-direction:column;';
            const top = document.createElement('div'); top.style.cssText = 'display:flex;gap:10px;';
            const checks = document.createElement('div');
            checks.style.cssText = 'flex:0 0 44%;max-height:150px;overflow-y:auto;display:flex;flex-direction:column;gap:1px;';
            const prev = document.createElement('div'); prev.style.cssText = 'flex:1;position:relative;height:150px;min-width:0;';
            const cv = document.createElement('canvas'); prev.appendChild(cv);
            const opts = getBaseChartOptions('', { enforceIntegers: false, minRange: 0 });
            if (opts.plugins && opts.plugins.zoom) { opts.plugins.zoom.zoom.wheel.enabled = false; opts.plugins.zoom.zoom.pinch.enabled = false; opts.plugins.zoom.pan.enabled = false; }
            if (opts.plugins && opts.plugins.legend) opts.plugins.legend.onClick = () => {};
            const chart = new Chart(cv.getContext('2d'), { type: 'line', data: { labels: clipTimeline(), datasets: clipDatasetsFor(def.keys) }, options: opts, plugins: [] });
            clipPreviewCharts.push(chart);
            metrics.forEach(k => {
                const lbl = document.createElement('label'); lbl.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;';
                const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'accent-accent'; cb.style.cssText = 'width:13px;height:13px;flex:none;'; cb.checked = def.keys.includes(k);
                const span = document.createElement('span'); span.textContent = getMetricLabel(k, isImp);
                if (typeof METRIC_DEFS !== 'undefined' && METRIC_DEFS[k]) span.style.color = METRIC_DEFS[k].color;
                cb.addEventListener('change', () => {
                    if (cb.checked) { if (!def.keys.includes(k)) def.keys.push(k); }
                    else def.keys = def.keys.filter(x => x !== k);
                    updateClipCustomChart(chart, def.keys);
                });
                lbl.appendChild(cb); lbl.appendChild(span); checks.appendChild(lbl);
            });
            top.appendChild(checks); top.appendChild(prev);
            const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '✕ Remove graph';
            rm.className = 'clip-remove-graph'; rm.style.cssText = 'align-self:flex-end;background:none;border:none;cursor:pointer;padding:6px 2px 0;font-size:11px;';
            rm.addEventListener('click', () => { clipCustomDefs.splice(i, 1); renderClipCustomList(); });
            card.appendChild(top); card.appendChild(rm);
            box.appendChild(card);
        });
    }
    function populateClipGraphList() {
        const list = document.getElementById('clipGraphList');
        // detach the persistent "+ add customized graphs" button before the innerhtml reset so its
        // click listener survives. it is re-appended inside this container as a full width cell below.
        const addBtn = document.getElementById('clipAddCustomBtn');
        if (addBtn && addBtn.parentElement) addBtn.parentElement.removeChild(addBtn);
        clipGraphEntries = [];
        Object.keys(customCharts).forEach(id => {
            if (customCharts[id] && customCharts[id].data.datasets.length > 0) clipGraphEntries.push(id);
        });
        if (masterChartInstance && masterChartInstance.data.datasets.length > 0) clipGraphEntries.push('parameterChart');
        // Custom graphs are NOT listed here as checkboxes; they live in their own "Custom graphs" editor
        // below and are always recorded (counted toward the 4-graph total).
        if (clipGraphEntries.length === 0) {
            list.innerHTML = '<div class="text-[11px] text-faint italic py-1" style="grid-column:1/-1;">No page graphs with data yet. Use the tracker alone, or add a custom graph below.</div>';
        } else {
            list.innerHTML = clipGraphEntries.map((id, i) => {
                let col = '#38bdf8';
                const ch = clipChartFor(id);
                const ds = ch && ch.data && ch.data.datasets.length ? ch.data.datasets[0] : null;
                if (ds && ds.borderColor) col = ds.borderColor;
                return `<label class="flex items-center gap-2 text-xs text-ink py-1 cursor-pointer">` +
                    `<input type="checkbox" class="clip-graph-chk accent-accent w-3.5 h-3.5" value="${id}">` +
                    `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${col};flex:none;"></span>` +
                    `${clipGraphName(id)}</label>`;
            }).join('');
        }
        if (addBtn) {
            const cell = document.createElement('div');
            cell.style.cssText = 'grid-column:1/-1;margin-top:4px;';
            cell.appendChild(addBtn);
            list.appendChild(cell);
        }
    }

    document.getElementById('exportClipBtn').addEventListener('click', () => {
        if (filteredData.length === 0) return;
        document.getElementById('clipRecordModal').style.display = 'flex';

        const startSlider = document.getElementById('clipStartSlider');
        const endSlider = document.getElementById('clipEndSlider');
        startSlider.max = endSlider.max = filteredData.length - 1;
        startSlider.value = 0;
        endSlider.value = filteredData.length - 1;
        document.getElementById('clipStartTime').value = clipColonTime(filteredData[0].time);
        document.getElementById('clipEndTime').value = clipColonTime(filteredData[filteredData.length - 1].time);

        // Mirror the live tracker mode + satellite menu so they can be chosen here.
        document.getElementById('clipTrackerMode').value = trackerModeSelect.value;
        const liveSat = document.getElementById('satelliteSelect');
        const clipSat = document.getElementById('clipSatSelect');
        if (liveSat) { clipSat.innerHTML = liveSat.innerHTML; clipSat.value = liveSat.value; }

        renderClipCustomList();
        populateClipGraphList();
        initClipFramePreviews();
    });

    // Total graphs to record = checked page graphs + custom graphs that have metrics picked.
    function clipTotalGraphs() {
        // count every custom card (even an empty one) so the builder can't push the total past the cap
        return document.querySelectorAll('.clip-graph-chk:checked').length + clipCustomDefs.length;
    }

    document.getElementById('clipAddCustomBtn').addEventListener('click', () => {
        if (clipTotalGraphs() >= 4) { showToast('You can record up to 4 graphs (page + custom).', 2500); return; }
        clipCustomDefs.push({ keys: [] });
        renderClipCustomList();
    });

    // Cap the total at 4 (page graphs + custom); delegate off the stable container.
    document.getElementById('clipGraphList').addEventListener('change', (e) => {
        if (!e.target || !e.target.classList || !e.target.classList.contains('clip-graph-chk')) return;
        if (clipTotalGraphs() > 4) {
            e.target.checked = false;
            showToast('You can record up to 4 graphs (page + custom).', 2500);
        }
    });

    // --- start/end time fields: colon-formatted while sliding, and typable as HH:MM:SS to jump ---
    function clipColonTime(t) { t = String(t || '000000').padStart(6, '0'); return t.slice(0, 2) + ':' + t.slice(2, 4) + ':' + t.slice(4, 6); }
    function clipTimeToSec(t) { t = String(t || '000000').padStart(6, '0'); return (+t.slice(0, 2)) * 3600 + (+t.slice(2, 4)) * 60 + (+t.slice(4, 6)); }
    function clipParseHHMMSS(str) {
        const parts = String(str).trim().split(':');
        if (parts.length < 2) return null;
        const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10), s = parts.length > 2 ? parseInt(parts[2], 10) : 0;
        if ([h, m, s].some(n => isNaN(n))) return null;
        return h * 3600 + m * 60 + s;
    }
    function clipNearestIdx(sec) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < filteredData.length; i++) { const d = Math.abs(clipTimeToSec(filteredData[i].time) - sec); if (d < bestD) { bestD = d; best = i; } }
        return best;
    }
    function wireClipTimeField(sliderId, fieldId) {
        const slider = document.getElementById(sliderId), field = document.getElementById(fieldId);
        if (!slider || !field) return;
        const sync = () => { const d = filteredData[slider.value]; if (d) field.value = clipColonTime(d.time); };
        slider.addEventListener('input', sync);
        const apply = () => {
            const sec = clipParseHHMMSS(field.value);
            if (sec == null || !filteredData.length) { sync(); return; }
            slider.value = clipNearestIdx(sec);
            sync();
        };
        field.addEventListener('change', apply);
        field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { apply(); field.blur(); } });
    }
    wireClipTimeField('clipStartSlider', 'clipStartTime');
    wireClipTimeField('clipEndSlider', 'clipEndTime');

    // start and end frame previews: a self contained 2d mini tracker plus mmr still at each chosen
    // point, so the range can be dialed in without leaving the modal to scrub the main view.
    let clipFrameProj = null;   // lon/lat bounds of the loaded flight, fit once per modal open

    function buildClipFrameProjection() {
        clipFrameProj = null;
        if (!filteredData.length) return;
        let loMin = Infinity, loMax = -Infinity, laMin = Infinity, laMax = -Infinity;
        for (const d of filteredData) {
            if (d.lon < loMin) loMin = d.lon; if (d.lon > loMax) loMax = d.lon;
            if (d.lat < laMin) laMin = d.lat; if (d.lat > laMax) laMax = d.lat;
        }
        const cosLat = Math.max(0.1, Math.cos(((laMin + laMax) / 2) * Math.PI / 180));
        clipFrameProj = { loMin, loMax, laMin, laMax, cosLat };
    }

    // draws the whole track faint plus the flown portion (colored like the live tracker) with a plane
    // dot at idx, into a small canvas. independent of the live map engine, so it never disturbs it
    // and is always 2d regardless of the live tracker mode.
    function drawClipFrameTrack(cv, idx) {
        if (!cv) return;
        const rctx = cv.getContext('2d');
        const pal = recPalette();
        const dpr = window.devicePixelRatio || 1;
        const rect = cv.getBoundingClientRect();
        const W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));
        if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
        rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rctx.clearRect(0, 0, W, H);
        rctx.fillStyle = pal.trackBg; rctx.fillRect(0, 0, W, H);
        if (!clipFrameProj || !filteredData.length) return;

        const pad = 10, p = clipFrameProj;
        const lonSpan = Math.max(1e-4, (p.loMax - p.loMin) * p.cosLat);
        const latSpan = Math.max(1e-4, (p.laMax - p.laMin));
        const s = Math.min((W - 2 * pad) / lonSpan, (H - 2 * pad) / latSpan);
        const drawW = lonSpan * s, drawH = latSpan * s;
        const ox = (W - drawW) / 2, oy = (H - drawH) / 2;
        const px = lon => ox + (lon - p.loMin) * p.cosLat * s;
        const py = lat => oy + drawH - (lat - p.laMin) * s;

        rctx.lineJoin = rctx.lineCap = 'round';
        // whole track, faint
        rctx.strokeStyle = pal.name; rctx.globalAlpha = 0.3; rctx.lineWidth = 1.25;
        rctx.beginPath();
        for (let i = 0; i < filteredData.length; i++) { const x = px(filteredData[i].lon), y = py(filteredData[i].lat); i ? rctx.lineTo(x, y) : rctx.moveTo(x, y); }
        rctx.stroke();
        // flown portion up to idx, colored like the live path
        rctx.globalAlpha = 0.95; rctx.lineWidth = 2;
        let lx = px(filteredData[0].lon), ly = py(filteredData[0].lat);
        for (let i = 1; i <= idx && i < filteredData.length; i++) {
            const x = px(filteredData[i].lon), y = py(filteredData[i].lat);
            rctx.beginPath(); rctx.strokeStyle = getPathColorHex(filteredData[i], i); rctx.moveTo(lx, ly); rctx.lineTo(x, y); rctx.stroke();
            lx = x; ly = y;
        }
        // plane marker at idx
        const d = filteredData[Math.min(idx, filteredData.length - 1)];
        const mx = px(d.lon), my = py(d.lat);
        const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#38bdf8').trim();
        rctx.globalAlpha = 1;
        rctx.beginPath(); rctx.arc(mx, my, 4.5, 0, Math.PI * 2);
        rctx.fillStyle = accent; rctx.fill();
        rctx.lineWidth = 2; rctx.strokeStyle = pal.trackBg; rctx.stroke();
    }

    // seek a preview video element to the mmr time that lines up with flight index idx (same offset
    // the real recording uses). waits for metadata if the element hasn't loaded yet.
    function seekClipFrameVideo(vEl, idx) {
        if (!vEl || !filteredData[idx]) return;
        const doSeek = () => {
            const dur = vEl.duration || 0;
            let t = filteredData[idx].absSeconds - videoStartSeconds;
            if (t < 0) t = 0;
            if (dur && t > dur - 0.05) t = Math.max(0, dur - 0.05);
            try { vEl.currentTime = t; } catch (e) {}
        };
        if (vEl.readyState >= 1 && !isNaN(vEl.duration)) doSeek();
        else vEl.addEventListener('loadedmetadata', doSeek, { once: true });
    }

    function updateClipFramePreview(which) {
        if (!filteredData.length) return;
        const isStart = which === 'start';
        const slider = document.getElementById(isStart ? 'clipStartSlider' : 'clipEndSlider');
        const idx = Math.max(0, Math.min(filteredData.length - 1, parseInt(slider.value) || 0));
        const d = filteredData[idx]; if (!d) return;
        document.getElementById(isStart ? 'clipPreviewStartTime' : 'clipPreviewEndTime').textContent = clipColonTime(d.time);
        drawClipFrameTrack(document.getElementById(isStart ? 'clipPreviewStartTrack' : 'clipPreviewEndTrack'), idx);
        if (videoLoaded) seekClipFrameVideo(document.getElementById(isStart ? 'clipPreviewStartVideo' : 'clipPreviewEndVideo'), idx);
    }

    function initClipFramePreviews() {
        buildClipFrameProjection();
        const row = document.getElementById('clipPreviewRow');
        row.classList.toggle('no-video', !videoLoaded);
        const sv = document.getElementById('clipPreviewStartVideo'), ev = document.getElementById('clipPreviewEndVideo');
        const src = videoLoaded ? (video.currentSrc || video.src) : '';
        [sv, ev].forEach(v => {
            if (src) { if (v.getAttribute('src') !== src) { v.src = src; v.load(); } v.muted = true; }
            else { try { v.removeAttribute('src'); v.load(); } catch (e) {} }
        });
        updateClipFramePreview('start');
        updateClipFramePreview('end');
    }

    function pauseClipFramePreviews() {
        ['clipPreviewStartVideo', 'clipPreviewEndVideo'].forEach(id => { const v = document.getElementById(id); if (v) { try { v.pause(); } catch (e) {} } });
    }

    // keep end at or after start: dragging or typing one past the other clamps it to the other instead
    // of crossing, so the end point can never sit before the start point. runs after wireClipTimeField's
    // own sync, then rewrites the moved time field to the clamped value and refreshes that side's preview.
    function clipSyncField(which) {
        const slider = document.getElementById(which === 'start' ? 'clipStartSlider' : 'clipEndSlider');
        const field = document.getElementById(which === 'start' ? 'clipStartTime' : 'clipEndTime');
        const d = filteredData[parseInt(slider.value) || 0];
        if (d && field) field.value = clipColonTime(d.time);
    }
    function onClipRangeInput(which) {
        const ss = document.getElementById('clipStartSlider'), es = document.getElementById('clipEndSlider');
        const sv = parseInt(ss.value) || 0, ev = parseInt(es.value) || 0;
        if (which === 'start' && sv > ev) ss.value = ev;        // start can't pass end
        else if (which === 'end' && ev < sv) es.value = sv;      // end can't fall before start
        clipSyncField(which);
        updateClipFramePreview(which);
    }
    document.getElementById('clipStartSlider').addEventListener('input', () => onClipRangeInput('start'));
    document.getElementById('clipEndSlider').addEventListener('input', () => onClipRangeInput('end'));
    document.getElementById('clipStartTime').addEventListener('change', () => onClipRangeInput('start'));
    document.getElementById('clipEndTime').addEventListener('change', () => onClipRangeInput('end'));

    // --- compositor helpers ---
    function drawImageContain(rctx, img, x, y, w, h) {
        const iw = img.videoWidth || img.width, ih = img.videoHeight || img.height;
        if (!iw || !ih || w <= 0 || h <= 0) return;
        const s = Math.min(w / iw, h / ih), dw = iw * s, dh = ih * s;
        rctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }
    function roundRectPath(rctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        rctx.beginPath();
        rctx.moveTo(x + r, y);
        rctx.arcTo(x + w, y, x + w, y + h, r);
        rctx.arcTo(x + w, y + h, x, y + h, r);
        rctx.arcTo(x, y + h, x, y, r);
        rctx.arcTo(x, y, x + w, y, r);
        rctx.closePath();
    }
    function drawTrackerInto(rctx, x, y, w, h) {
        const is3D = trackerModeSelect.value === '3d';
        const src = is3D ? (typeof renderer3D !== 'undefined' && renderer3D ? renderer3D.domElement : null) : canvas;
        rctx.fillStyle = (recState && recState.pal) ? recState.pal.trackBg : '#0b1220';
        roundRectPath(rctx, x, y, w, h, 12); rctx.fill();
        rctx.save(); roundRectPath(rctx, x, y, w, h, 12); rctx.clip();
        if (src && src.width && src.height) drawImageContain(rctx, src, x, y, w, h);
        rctx.restore();
    }
    function drawVideoInto(rctx, x, y, w, h) {
        rctx.fillStyle = (recState && recState.pal) ? recState.pal.videoBg : '#000';
        roundRectPath(rctx, x, y, w, h, 12); rctx.fill();
        rctx.save(); roundRectPath(rctx, x, y, w, h, 12); rctx.clip();
        if (video && video.videoWidth) drawImageContain(rctx, video, x, y, w, h);
        rctx.restore();
    }

    function clipFmtVal(v) { return Math.abs(v) >= 100 ? v.toFixed(0) : (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)); }

    // The recording follows the app theme so a light-mode chart (whose captured legend text is dark)
    // reads on a light backing, and a dark-mode chart reads on a dark backing. Fixed once per capture.
    function recPalette() {
        const light = document.documentElement.dataset.theme === 'light';
        return light
            ? { page: '#e9ebee', slot: '#f6f7f9', slotStroke: '#d3d8dd', name: '#334155', trackBg: '#dfe3e7', videoBg: '#c9ced3', value: '#1e293b' }
            : { page: '#0b0e13', slot: '#14191f', slotStroke: '#232b35', name: '#aab4be', trackBg: '#0b1220', videoBg: '#000000', value: '#e6edf3' };
    }

    // Recording-window bounds on each graph: subtle yellow lines at the clip's start/end indices.
    function annotateGraph(rctx, ch, dx, dy, kx, ky, startIdx, endIdx) {
        const ca = ch.chartArea; if (!ca) return;
        const N = ch.data.labels.length;
        const xCss = idx => ca.left + (ca.right - ca.left) * (N > 1 ? Math.min(1, Math.max(0, idx / (N - 1))) : 0.5);
        const top = dy + ca.top * ky, bot = dy + ca.bottom * ky;
        rctx.lineWidth = 1.5; rctx.strokeStyle = 'rgba(250,204,21,0.5)'; rctx.setLineDash([]);
        [startIdx, endIdx].forEach(idx => { const X = dx + xCss(idx) * kx; rctx.beginPath(); rctx.moveTo(X, top); rctx.lineTo(X, bot); rctx.stroke(); });
    }

    // Clean readout of each visible series' CURRENT value, top-right of the graph, tracking the
    // playhead so it updates as the clip plays. Colors match the chart legend; no min/max clutter.
    function drawCurrentValues(rctx, ch, gx, y, gw) {
        if (!ch || !ch.data || !ch.data.datasets.length) return;
        const pal = (recState && recState.pal) || { value: '#e6edf3' };
        const idx = Math.max(0, Math.min(currentIdx, ch.data.labels.length - 1));
        const rightX = gx + gw - 14;
        let ty = y + 9;
        rctx.textAlign = 'right'; rctx.textBaseline = 'top';
        rctx.font = '700 16px Inter, system-ui, sans-serif';
        ch.data.datasets.forEach((ds, i) => {
            if (!ch.isDatasetVisible(i)) return;
            const v = ds.data[idx];
            if (v == null || !isFinite(v)) return;
            const txt = clipFmtVal(v);
            // value in the theme ink (always legible), with a series-color dot so it still maps to the line
            rctx.fillStyle = pal.value;
            rctx.fillText(txt, rightX, ty);
            const tw = rctx.measureText(txt).width;
            rctx.fillStyle = ds.borderColor || pal.value;
            rctx.beginPath(); rctx.arc(rightX - tw - 9, ty + 8, 4, 0, Math.PI * 2); rctx.fill();
            ty += 21;
        });
    }

    function drawRecordFrame() {
        if (!recState) return;
        const rctx = recState.ctx, W = recordCanvas.width, H = recordCanvas.height, pad = 20;
        const pal = recState.pal || recPalette();
        const graphs = recState.graphs, hasGraphs = graphs.length > 0;
        rctx.fillStyle = pal.page;
        rctx.fillRect(0, 0, W, H);

        const mapAreaW = hasGraphs ? Math.round(W * 0.62) : W;
        const colAreaW = W - mapAreaW;
        const lx = pad, lw = mapAreaW - (hasGraphs ? pad * 1.5 : pad * 2), lTop = pad, lH = H - pad * 2;

        // Left column: tracker, optionally stacked with the MMR video above or below it.
        const stack = recState.videoStack;
        if (videoLoaded && (stack === 'above' || stack === 'below')) {
            const vGap = 14, trackerH = Math.round(lH * 0.6) - vGap / 2, videoH = lH - trackerH - vGap;
            const trackerY = stack === 'above' ? lTop + videoH + vGap : lTop;
            const videoY = stack === 'above' ? lTop : lTop + trackerH + vGap;
            drawTrackerInto(rctx, lx, trackerY, lw, trackerH);
            drawVideoInto(rctx, lx, videoY, lw, videoH);
        } else {
            drawTrackerInto(rctx, lx, lTop, lw, lH);
        }

        // Right column: stacked graphs with crisp value/bound annotations.
        if (hasGraphs) {
            const gx = mapAreaW + pad * 0.5, gw = colAreaW - pad * 1.5, gapV = 16;
            const slotH = (H - pad * 2 - gapV * (graphs.length - 1)) / graphs.length;
            graphs.forEach((g, i) => {
                const y = pad + i * (slotH + gapV);
                rctx.fillStyle = pal.slot;
                roundRectPath(rctx, gx, y, gw, slotH, 10); rctx.fill();
                rctx.strokeStyle = pal.slotStroke; rctx.lineWidth = 1;
                roundRectPath(rctx, gx, y, gw, slotH, 10); rctx.stroke();
                rctx.fillStyle = pal.name; rctx.font = '600 15px Inter, system-ui, sans-serif';
                rctx.textBaseline = 'top'; rctx.textAlign = 'left';
                rctx.fillText(g.name, gx + 14, y + 11);
                const ch = g.chart || clipChartFor(g.id);
                if (g.chart) g.chart.render();   // custom charts aren't driven by playback; redraw for the moving playhead
                const cv = ch && ch.canvas;
                if (cv && cv.width && cv.height) {
                    const bx = gx + 10, by = y + 38, bw = gw - 20, bh = slotH - 48;
                    const s = Math.min(bw / cv.width, bh / cv.height), dw = cv.width * s, dh = cv.height * s;
                    const dxi = bx + (bw - dw) / 2, dyi = by + (bh - dh) / 2;
                    rctx.drawImage(cv, dxi, dyi, dw, dh);
                    const kx = (cv.width / ch.width) * s, ky = (cv.height / ch.height) * s;
                    annotateGraph(rctx, ch, dxi, dyi, kx, ky, recState.startIdx, recState.endIdx);
                    drawCurrentValues(rctx, ch, gx, y, gw);
                }
            });
        }

        // Downscale the 2x supersampled composite into the 1080p capture (stream) canvas.
        recState.captureCtx.drawImage(recState.superCanvas, 0, 0, W, H);
    }

    function setRecordProgress(frac) {
        frac = Math.max(0, Math.min(1, frac));
        document.getElementById('recordProgressFill').style.width = (frac * 100).toFixed(1) + '%';
        document.getElementById('recordProgressLabel').innerText = `Recording… ${Math.round(frac * 100)}%`;
    }

    function recordCompositeLoop() {
        if (!recState) return;
        if (videoLoaded && video.ended && currentIdx < recState.endIdx) { finishRecording(); return; }
        drawRecordFrame();
        const span = Math.max(1, recState.endIdx - recState.startIdx);
        setRecordProgress((currentIdx - recState.startIdx) / span);
        if (currentIdx >= recState.endIdx) { finishRecording(); return; }
        recState.raf = requestAnimationFrame(recordCompositeLoop);
    }

    function finishRecording() {
        if (!recState || recState.finishing) return;
        recState.finishing = true;
        if (recState.raf) cancelAnimationFrame(recState.raf);
        isPlaying = false; playPauseBtn.innerText = "Play";
        if (videoLoaded) video.pause();
        try { recState.recorder.stop(); } catch (e) {}
    }

    function pickClipMime() {
        // Prefer MP4/H.264 (plays everywhere, more shareable) when the browser can record it, else WebM.
        const opts = [
            'video/mp4;codecs=avc1.640029,mp4a.40.2', 'video/mp4;codecs=avc1.640029', 'video/mp4;codecs=avc1', 'video/mp4',
            'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'
        ];
        for (const o of opts) { if (window.MediaRecorder && MediaRecorder.isTypeSupported(o)) return o; }
        return 'video/webm';
    }

    document.getElementById('startClipRecordBtn').addEventListener('click', () => {
        if (filteredData.length === 0 || recState) return;
        document.getElementById('clipRecordModal').style.display = 'none';
        destroyClipPreviews();   // the builder previews are done; free them before recording
        pauseClipFramePreviews();   // stop the start and end frame stills too

        let startIdx = parseInt(document.getElementById('clipStartSlider').value);
        let endIdx = parseInt(document.getElementById('clipEndSlider').value);
        if (startIdx > endIdx) { const t = startIdx; startIdx = endIdx; endIdx = t; }

        // Record the checked page graphs plus every custom graph that has metrics, capped at 4 total.
        const fixedGraphs = Array.from(document.querySelectorAll('.clip-graph-chk:checked')).map(c => ({ id: c.value, name: clipGraphName(c.value) }));
        const customGraphs = clipCustomDefs.map((def, i) => def.keys.length ? { id: 'cust:' + i, name: clipGraphName('cust:' + i) } : null).filter(Boolean);
        const graphs = fixedGraphs.concat(customGraphs).slice(0, 4);
        const videoStack = document.getElementById('clipVideoStack').value;

        // Apply the chosen tracker mode + satellite to the live view (the recorder captures it live).
        const wantMode = document.getElementById('clipTrackerMode').value;
        if (trackerModeSelect.value !== wantMode) { trackerModeSelect.value = wantMode; trackerModeSelect.dispatchEvent(new Event('change')); }
        const liveSat = document.getElementById('satelliteSelect');
        const wantSat = document.getElementById('clipSatSelect').value;
        if (liveSat && liveSat.value !== wantSat) { liveSat.value = wantSat; liveSat.dispatchEvent(new Event('change')); }

        // Wait for any satellite fetch to finish, then run a 3-second countdown so the user can frame the tracker.
        waitForSatThenCountdown(() => startClipCapture(startIdx, endIdx, graphs, videoStack));
    });

    function waitForSatThenCountdown(cb) {
        const overlay = document.getElementById('satLoadingOverlay');
        const satOn = document.getElementById('satelliteSelect').value !== 'none';
        const deadline = performance.now() + 8000;
        function waitSat() {
            const fetching = overlay && overlay.classList.contains('show');
            if (satOn && fetching && performance.now() < deadline) { setTimeout(waitSat, 150); return; }
            runRecordCountdown(3, cb);
        }
        setTimeout(waitSat, 250);   // let the 2D/3D switch + satellite fetch kick off first
    }

    function runRecordCountdown(n, cb) {
        const pill = document.getElementById('recordProgress');
        const label = document.getElementById('recordProgressLabel');
        const bar = pill.querySelector('.rec-bar');
        const stopBtn = document.getElementById('recordStopBtn');
        pill.classList.add('show');
        if (bar) bar.style.display = 'none';
        stopBtn.style.display = 'none';
        (function tick() {
            if (!pill.classList.contains('show')) return;   // aborted
            if (n <= 0) { if (bar) bar.style.display = ''; stopBtn.style.display = ''; cb(); return; }
            label.innerText = `Recording in ${n}…  frame the tracker`;
            n--;
            setTimeout(tick, 1000);
        })();
    }

    function startClipCapture(startIdx, endIdx, graphs, videoStack) {
        // Supersample: draw the composite into an offscreen canvas at 2x, then downscale each frame
        // into the 1080p capture canvas. Crisper text/edges and cleaner source downsampling, while the
        // encoder still runs at a reliable 1080p (real-time 4K encode tends to drop frames).
        const SS = 2;
        const superCanvas = document.createElement('canvas');
        superCanvas.width = recordCanvas.width * SS; superCanvas.height = recordCanvas.height * SS;
        const superCtx = superCanvas.getContext('2d');
        superCtx.imageSmoothingEnabled = true; superCtx.imageSmoothingQuality = 'high';
        superCtx.setTransform(SS, 0, 0, SS, 0, 0);   // draw in 1080p logical coords, rasterized at 2x
        const captureCtx = recordCanvas.getContext('2d');
        captureCtx.imageSmoothingEnabled = true; captureCtx.imageSmoothingQuality = 'high';
        let stream;
        try { stream = recordCanvas.captureStream(30); }
        catch (e) { showToast('Recording is not supported in this browser.', 4000); return; }

        // Fold in the MMR audio track if a video is loaded, so cockpit audio is captured too.
        if (videoLoaded) {
            try {
                const vs = video.captureStream ? video.captureStream() : (video.mozCaptureStream ? video.mozCaptureStream() : null);
                if (vs) vs.getAudioTracks().forEach(t => stream.addTrack(t));
            } catch (e) {}
        }

        // High bitrate keeps the 1080p composite (upscaled tracker + graphs) crisp instead of mushy.
        let recorder;
        const mime = pickClipMime();
        try { recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 25000000 }); }
        catch (e) {
            try { recorder = new MediaRecorder(stream, { mimeType: mime }); }
            catch (e2) { showToast('Could not start the recorder: ' + e2.message, 4000); return; }
        }

        const chunks = [];
        recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
            stream.getVideoTracks().forEach(t => t.stop());
            const isMp4 = mime.indexOf('mp4') !== -1;
            const blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `MissionClip_${flightMetaData.id}_${filteredData[recState.startIdx].time}.${isMp4 ? 'mp4' : 'webm'}`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            document.getElementById('recordProgress').classList.remove('show');
            recState.graphs.forEach(g => { if (g.chart) { try { g.chart.destroy(); } catch (e) {} } });
            recState = null;
            showToast('Recording saved to your downloads.', 4000);
        };

        // Build a throwaway chart per selected custom graph now that the recorder exists (the early
        // returns above would otherwise leak these offscreen charts). recState.onstop destroys them.
        graphs.forEach(g => { const cd = clipCustomDef(g.id); if (cd && cd.keys.length) g.chart = buildClipCustomChart(cd.keys, g.name); });
        recState = { recorder, stream, ctx: superCtx, superCanvas, captureCtx, pal: recPalette(), startIdx, endIdx, graphs, videoStack, raf: null, finishing: false };

        // Seek the playhead to the clip start and begin playback.
        currentIdx = startIdx;
        timelineSlider.value = currentIdx;
        if (videoLoaded && filteredData[currentIdx]) video.currentTime = Math.max(0, filteredData[currentIdx].absSeconds - videoStartSeconds);
        updateVisualComponents(currentIdx, false);

        isPlaying = true; playPauseBtn.innerText = "Pause";
        playbackAccumulator = 0; lastTickTime = performance.now();
        if (videoLoaded && speeds[currentSpeedIdx] <= 16) video.play().catch(e => {});

        document.getElementById('recordProgress').classList.add('show');
        setRecordProgress(0);
        recorder.start();
        masterSyncEngineTick();
        recState.raf = requestAnimationFrame(recordCompositeLoop);
    }

    document.getElementById('recordStopBtn').addEventListener('click', finishRecording);
    document.getElementById('clipRecordCloseX').addEventListener('click', () => { destroyClipPreviews(); pauseClipFramePreviews(); });   // free builder and frame previews on close

    // Click anywhere on a modal's dimmed backdrop (not its card) to close it, so the ✕ is never the
    // only way out of a long dialog. mousedown target === the overlay means the card was not clicked.
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('mousedown', (e) => {
            if (e.target !== overlay) return;
            overlay.style.display = 'none';
            if (overlay.id === 'clipRecordModal') { destroyClipPreviews(); pauseClipFramePreviews(); }
        });
    });


    /* ---- Remembered display preferences ----
       View settings only (no flight data), restored on open, saved on every change.
       Restoring dispatches 'change' so each control's normal handler runs; all of them
       no-op safely when no flight is loaded yet. */
    (function persistDisplayPrefs() {
        // only controls that still exist persist; the 8hz and pfd toggles left with their modules.
        const PREF_IDS = ['toggleSI', 'simpleTrackerIcon', 'toggleRealScale', 'trackerModeSelect', 'pathColorSelect', 'barbColorSelect', 'trackAltSelect'];
        const KEY = 'aocVizPrefs';
        try {
            const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
            PREF_IDS.forEach(id => {
                const el = document.getElementById(id); if (!el || !(id in saved)) return;
                if (el.type === 'checkbox') {
                    if (el.checked !== !!saved[id]) { el.checked = !!saved[id]; el.dispatchEvent(new Event('change')); }
                } else if (el.value !== saved[id] && (!el.options || [...el.options].some(o => o.value === saved[id]))) {
                    el.value = saved[id]; el.dispatchEvent(new Event('change'));
                }
            });
            const save = () => {
                const out = {};
                PREF_IDS.forEach(id => { const el = document.getElementById(id); if (el) out[id] = el.type === 'checkbox' ? el.checked : el.value; });
                localStorage.setItem(KEY, JSON.stringify(out));
            };
            PREF_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('change', save); });
        } catch (e) { /* localStorage unavailable (private mode), defaults stand */ }
    })();

    /* ---- Light/dark theme toggle ----
       documentElement[data-theme] is what css/app.css keys its tokens off; the inline <head>
       script sets it before first paint (from the same aocVizPrefs blob) so there's no flash.
       Stored under its own 'theme' key in aocVizPrefs rather than PREF_IDS above, since the
       toggle isn't a form control that fires a 'change' event. */
    (function themeToggle() {
        const KEY = 'aocVizPrefs';
        const btn = document.getElementById('themeToggleBtn');
        if (!btn) return;
        // The switch itself (knob position, lit icon) is CSS-driven off [data-theme]; only the
        // ARIA state is mirrored here (checked = light). Do not write btn.textContent, it would
        // wipe the knob/icon spans.
        const syncAria = () => btn.setAttribute('aria-checked', document.documentElement.dataset.theme === 'light' ? 'true' : 'false');
        syncAria();
        let themeAnimTimer = null;
        btn.addEventListener('click', () => {
            const root = document.documentElement;
            // Fade the token-driven colors across the switch (see css/app.css .theme-anim), then drop
            // the class so it never affects ordinary hover/focus color changes.
            root.classList.add('theme-anim');
            clearTimeout(themeAnimTimer);
            themeAnimTimer = setTimeout(() => root.classList.remove('theme-anim'), 420);
            const next = root.dataset.theme === 'light' ? 'dark' : 'light';
            root.dataset.theme = next;
            syncAria();
            // the 2D basemap palette is theme-aware now, so drop its cached render and repaint the tracker.
            bgNeedsUpdate = true;
            if (filteredData.length && trackerModeSelect.value === '2d' && typeof renderMapEngineFrame === 'function') {
                renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
            }
            // Legend label colors are theme-aware (js/17-charts.js generateLabels), baked at build
            // time, so rebuild the legends on toggle. update('none') re-runs generateLabels without
            // animation; the zoom plugin preserves any pan/zoom across it.
            try {
                if (typeof customCharts !== 'undefined') Object.values(customCharts).forEach(c => c && c.update('none'));
            } catch (e) { /* charts not built yet */ }
            try {
                const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
                saved.theme = next;
                localStorage.setItem(KEY, JSON.stringify(saved));
            } catch (e) { /* localStorage unavailable (private mode) */ }
        });
    })();
