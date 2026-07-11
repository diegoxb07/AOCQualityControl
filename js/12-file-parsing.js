/* Mission Visualizer, file/video upload + flight-load pipeline
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   The parsing itself lives in js/11b-parser-core.js (pure, shared with the parse worker, the
   batch sat-cache, and the node tests). This file owns the DOM side: upload wiring, the worker
   round-trip, the data report, and the post-parse UI/global setup. */

    let lastParseStats = null;   // stats ledger from the most recent load (see parseFlightTextToRows)

    function showLoadingOverlay() {
        const l = document.getElementById('loadingOverlay'); l.classList.remove('hidden'); l.classList.add('flex');
        const s = document.getElementById('loadingSpinner'); if (s) s.classList.remove('done');   // spin fresh, never open on the previous load's checkmark
        const st = document.getElementById('loadingOverlaySubtext'); if (st) st.textContent = 'Pulling variables...';
        // clear any stale download-progress state from a previous load (the leftover 100% bar / percent)
        const pw = document.getElementById('loadingProgressWrap'); if (pw) pw.classList.add('hidden');
        const pb = document.getElementById('loadingProgressBar'); if (pb) pb.style.width = '0%';
        const pp = document.getElementById('loadingProgressPct'); if (pp) pp.textContent = '0%';
        const ps = document.getElementById('loadingProgressSpeed'); if (ps) ps.textContent = '';
    }
    function hideLoadingOverlay() { const l = document.getElementById('loadingOverlay'); l.classList.add('hidden'); l.classList.remove('flex'); }

    document.getElementById('videoInput').addEventListener('change', function(e) {
        if (!e.target.files[0]) return;
        markDropZoneLoaded('videoDropZone', 'videoDropLabel', e.target.files[0].name);
        video.src = URL.createObjectURL(e.target.files[0]); document.getElementById('videoPlaceholder').style.display = 'none'; videoLoaded = true;
        syncMediaGridLayout();
        speeds = [1, 4, 8, 16]; currentSpeedIdx = 0; updateSpeedDisplay();
        videoSyncMode.disabled = false; document.getElementById('videoStartInput').disabled = false;
        if (allParsedData.length > 0) document.getElementById('videoStartInput').value = allParsedData[0].time;
        video.addEventListener('loadedmetadata', () => { updateEndWindowFromVideo(true); }, { once: true });
        video.addEventListener('seeking', syncTelemetryToVideoClock);
        evaluateAutoSyncDefault();
        video.addEventListener('loadeddata', () => { if (videoSyncMode.value === 'auto' && ocrAvailable && typeof performImmediateOcrLock === 'function') performImmediateOcrLock({ silent: true }); }, { once: true });
        setTimeout(() => { if (videoSyncMode.value === 'auto' && ocrAvailable && !isPlaying && typeof performImmediateOcrLock === 'function') performImmediateOcrLock({ silent: true }); }, 1000);
    });

    document.getElementById('fileInput').addEventListener('change', function(e) {
        if (!e.target.files[0]) return;
        markDropZoneLoaded('dataDropZone', 'dataDropLabel', e.target.files[0].name);
        showLoadingOverlay();
        setTimeout(() => {
            currentSpeedIdx = 0; updateSpeedDisplay();
            const file = e.target.files[0]; const fName = file.name;
            const match = fName.match(/^(\d{4})(\d{2})(\d{2})([a-zA-Z])(.*)\./i);
            if (match) {
                flightMetaData.date = `${match[1]}-${match[2]}-${match[3]}`; const planeType = match[4].toUpperCase();
                if (planeType === 'H') flightMetaData.aircraft = 'NOAA42 (WP-3D Orion)'; else if (planeType === 'I') flightMetaData.aircraft = 'NOAA43 (WP-3D Orion)'; else if (planeType === 'N') flightMetaData.aircraft = 'NOAA49 (Gulfstream IV-SP)'; else flightMetaData.aircraft = 'Unknown';
                flightMetaData.id = match[0].replace('.', '');
            } else { flightMetaData.id = file.name; flightMetaData.date = 'Unknown'; flightMetaData.aircraft = 'Unknown'; }

            const isNc = fName.split('.').pop().toLowerCase() === 'nc';
            isNcFile = isNc; if (videoLoaded) videoSyncMode.disabled = false;
            const reader = new FileReader();
            reader.onload = (evt) => {
                parseEntireFile(evt.target.result).catch(err => {
                    hideLoadingOverlay();
                    showToast('Could not load ' + fName + ': ' + err.message, 10000);
                });
            };
            reader.onerror = () => { hideLoadingOverlay(); showToast('Could not read ' + fName + ' from disk.', 8000); };
            if (isNc) reader.readAsArrayBuffer(file); else reader.readAsText(file);
        }, 50);
    });

    // Unloads the MMR video and clears both upload drop zones. Switching flights from the archive
    // or the preloaded list starts clean; a stale video belongs to the previous flight and its
    // sync offset is meaningless against the new one.
    function clearLoadedMedia() {
        document.getElementById('fileInput').value = '';
        resetDropZone('dataDropZone', 'dataDropLabel', 'Choose File/Drag & Drop');
        if (!videoLoaded) return;
        video.pause();
        try { URL.revokeObjectURL(video.src); } catch (e) {}
        video.removeAttribute('src'); video.load();
        videoLoaded = false;
        document.getElementById('videoPlaceholder').style.display = '';
        document.getElementById('videoInput').value = '';
        resetDropZone('videoDropZone', 'videoDropLabel', 'Choose File/Drag & Drop');
        videoSyncMode.disabled = true;
        const vsi = document.getElementById('videoStartInput'); vsi.value = '000000'; vsi.disabled = true;
        speeds = [1, 2, 4, 8, 16, 32, 64, 128]; currentSpeedIdx = 0; updateSpeedDisplay();
        syncMediaGridLayout();
    }

    // The shared ?v= cache-buster, read off this page's own script tags so the worker URL stays in
    // step with the single version string in index.html.
    function assetVer() {
        const s = document.querySelector('script[src*="?v="]');
        const m = s && s.src.match(/\?v=[^&]+/);
        return m ? m[0] : '';
    }

    // Parse a flight source (TSV string, or an .nc ArrayBuffer) into { rows, stats }, off the main
    // thread so the page never freezes on a big file. Falls back to parsing on the main thread when
    // workers are unavailable (e.g. file://). Rejects with the parse error for the caller to report.
    // reflect the worker's decode progress in the loading overlay subtext (see ncArrayBufferToTsv).
    function updateParseProgress(p) {
        if (!p) return;
        const st = document.getElementById('loadingOverlaySubtext');
        const wrap = document.getElementById('loadingProgressWrap');
        const bar = document.getElementById('loadingProgressBar');
        const pct = document.getElementById('loadingProgressPct');
        const spd = document.getElementById('loadingProgressSpeed');
        // the worker decodes NetCDF variables one at a time, so index/total is a true fraction; fill the
        // bar with it so a manual upload shows real parse progress.
        let frac = null;
        if (p.phase === 'open') { if (st) st.textContent = `Reading ${p.total} NetCDF variables…`; frac = 0; }
        else if (p.phase === 'var') { if (st) st.textContent = `Processing variable ${p.index}/${p.total}: ${p.name}`; frac = p.total ? p.index / p.total : 0; }
        else if (p.phase === 'rows') { if (st) st.textContent = `Assembling ${Number(p.numRows).toLocaleString()} data rows…`; frac = 1; }
        if (frac === null) return;
        const percent = Math.round(Math.max(0, Math.min(1, frac)) * 100);
        if (wrap) wrap.classList.remove('hidden');
        if (bar) bar.style.width = percent + '%';
        if (pct) pct.textContent = (p.phase === 'var') ? `${p.index} / ${p.total} variables` : percent + '%';
        if (spd) spd.textContent = '';
    }

    // onProgress (optional) receives the same {phase,index,total,...} the loading overlay uses; callers
    // that draw their own bar (the preload modal) pass one, everyone else defaults to updateParseProgress.
    function parseFlightSource(source, onProgress) {
        const report = onProgress || updateParseProgress;
        const onMainThread = () => {
            if (source && typeof source !== 'string' && source.byteLength === 0)
                throw new Error('parse worker failed and the file buffer was already handed off, please re-select the file');
            const tsv = typeof source === 'string' ? source : ncArrayBufferToTsv(source, report);
            const result = parseFlightTextToRows(tsv);
            // QC Mode raw pass on the same tsv; best-effort so a QC failure never blocks playback.
            try { result.qc = (typeof parseFlightRawQC === 'function') ? parseFlightRawQC(tsv) : null; }
            catch (e) { result.qc = null; }
            return result;
        };
        return new Promise((resolve, reject) => {
            let w, settled = false;
            try { w = new Worker('js/parse-worker.js' + assetVer()); }
            catch (e) { try { resolve(onMainThread()); } catch (err) { reject(err); } return; }
            w.onmessage = (e) => {
                if (e.data && e.data.progress) { report(e.data.progress); return; }  // live decode feedback
                settled = true; w.terminate();
                if (e.data && e.data.error) reject(new Error(e.data.error)); else resolve(e.data);
            };
            // worker infrastructure failure (script blocked or failed to load) before a result: parse here.
            w.onerror = () => {
                if (settled) return;
                settled = true; w.terminate();
                try { resolve(onMainThread()); } catch (err) { reject(err); }
            };
            // transfer the .nc arraybuffer to the worker instead of cloning it. a structured clone copy of a
            // large netcdf buffer runs on the main thread and froze the loading spinner mid load. strings
            // (tsv) can't be transferred, so they're cloned, which is cheap.
            if (typeof source === 'string') w.postMessage({ tsv: source });
            else w.postMessage({ nc: source }, [source]);
        });
    }

    // Fill #dataReportLine with the parser's honesty ledger (rows filtered, values derived),
    // so what was done to the data is always disclosed under the mission header.
    function updateDataReport(stats) {
        const line = document.getElementById('dataReportLine');
        if (line) {
            line.textContent = 'Data info: ' + summarizeParseStats(stats);
            line.classList.remove('hidden');
        }
    }

    // Load a flight from a TSV string or an .nc ArrayBuffer. Throws (after cleaning up its own
    // state) when the file yields nothing usable; callers decide how to surface that.
    async function parseEntireFile(source) {
        applyParsedFlight(await parseFlightSource(source));
    }

    // Take an already-parsed { rows, stats } (fresh from the worker, or held by the mission
    // preloader) and make it the loaded flight: resets, globals, and the post-parse UI setup.
    // Throws when the rows are empty.
    function applyParsedFlight(parsed) {
        // New flight: KEEP the satellite tile cache (it accumulates across storms until the tab closes;
        // tiles are keyed by layer/band/time/box so they never collide between flights). Just reset the
        // preloader's neighborhood pointer so it re-warms around the new flight.
        if (typeof resetSatPreload === 'function') resetSatPreload();
        // Clear any storm best-track / archive-mission metadata from the previous flight, it's
        // re-set after this returns by loadReconMission for an archive load.
        stormTrackPoints = []; stormTrackMeta = null; reconArchiveMeta = null;
        // Same reasoning for the shareable ?mission= URL params, an archive load re-sets them after this returns.
        try { const u = new URL(window.location.href); ['mission', 't', 'view'].forEach(k => u.searchParams.delete(k)); history.replaceState(null, '', u); } catch (e) {}
        const stormToggleLabel = document.getElementById('stormTrackToggleLabel'); if (stormToggleLabel) stormToggleLabel.style.display = 'none';
        const srcLink = document.getElementById('reconSourceLink'); if (srcLink) srcLink.classList.add('hidden');

        allParsedData = parsed.rows; lastParseStats = parsed.stats;
        updateDataReport(parsed.stats);
        if (allParsedData.length === 0) {
            throw new Error('no usable rows (' + summarizeParseStats(parsed.stats) + ')');
        }

        availableMetrics.clear();
        allParsedData.forEach(row => { Object.keys(METRIC_DEFS).forEach(k => { if (row[k] !== null && row[k] !== undefined && !isNaN(row[k])) availableMetrics.add(k); }); });

        // QC Mode: hand the raw dataset (continuous 1-second axis, every catalog var) to the QC
        // engine/report/charts. Best-effort so any QC failure never disturbs the player.
        qcRawData = parsed.qc || null;
        try { if (typeof onFlightLoadedForQC === 'function') onFlightLoadedForQC(); } catch (e) { console.warn('QC processing failed:', e); }

        updateMissionHeader();

        ['startTimeInput', 'endTimeInput', 'playPauseBtn', 'exportClipBtn'].forEach(id => document.getElementById(id).disabled = false);
        document.getElementById('startTimeInput').value = allParsedData[0].time;
        document.getElementById('endTimeInput').value = allParsedData[allParsedData.length-1].time;

        if (videoLoaded) {
            document.getElementById('videoStartInput').value = allParsedData[0].time;
            updateEndWindowFromVideo(false);
        } else {
            document.getElementById('videoStartInput').value = "000000";
            document.getElementById('videoStartInput').disabled = true;
            videoSyncMode.disabled = true;
            applyFiltersAndInit(false);
        }

        evaluateAutoSyncDefault();
        applySyncModeLock();

        // New flight: start zoomed in on the aircraft and following it (js/15-map-render.js).
        if (typeof engageFollowAircraft === 'function') engageFollowAircraft();

        if (filteredData.length > 0 && !isPlaying) {
            isPlaying = true; playPauseBtn.innerText = "Pause"; playbackAccumulator = 0; lastTickTime = performance.now();
            if (videoLoaded && speeds[currentSpeedIdx] <= 16) video.play().catch(e=>{});
            masterSyncEngineTick();
        }

        // Success: this runs only once processing is fully done, so morph the spinner to a checkmark
        // right here and close almost immediately (just long enough for the check to draw), no lingering.
        const spin = document.getElementById('loadingSpinner');
        if (spin) {
            spin.classList.add('done');
            const st = document.getElementById('loadingOverlaySubtext'); if (st) st.textContent = 'Parsed successfully';
            setTimeout(hideLoadingOverlay, 480);
        } else {
            hideLoadingOverlay();
        }
    }
