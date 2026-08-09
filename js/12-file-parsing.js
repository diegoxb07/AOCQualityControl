/* Mission Visualizer, file upload + flight-load pipeline
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   The parsing itself lives in js/11b-parser-core.js (pure, shared with the parse worker and the
   node tests). This file owns the DOM side: upload wiring, the worker round-trip, the data
   report, and the post-parse UI/global setup. */

    let lastParseStats = null;   // stats ledger from the most recent load (see parseFlightTextToRows)

    function showLoadingOverlay() {
        // flags the QC skeleton placeholders as live: they pulse only while this overlay is up
        // (an actual load/parse in progress), and sit static while just waiting on the user
        document.body.classList.add('qc-skel-live');
        const l = document.getElementById('loadingOverlay'); l.classList.remove('hidden'); l.classList.add('flex');
        const s = document.getElementById('loadingSpinner'); if (s) s.classList.remove('done');   // spin fresh, never open on the previous load's checkmark
        const st = document.getElementById('loadingOverlaySubtext'); if (st) st.textContent = 'Pulling variables...';
        // clear any stale download-progress state from a previous load (the leftover 100% bar / percent)
        const pw = document.getElementById('loadingProgressWrap'); if (pw) pw.classList.add('hidden');
        const pb = document.getElementById('loadingProgressBar'); if (pb) pb.style.width = '0%';
        const pp = document.getElementById('loadingProgressPct'); if (pp) pp.textContent = '0%';
        const ps = document.getElementById('loadingProgressSpeed'); if (ps) ps.textContent = '';
    }
    function hideLoadingOverlay() { document.body.classList.remove('qc-skel-live'); const l = document.getElementById('loadingOverlay'); l.classList.add('hidden'); l.classList.remove('flex'); }

    document.getElementById('fileInput').addEventListener('change', function(e) {
        if (!e.target.files[0]) return;
        // .nc only. The accept attribute filters the browse dialog but not a drag-and-drop, so this
        // is the check that actually holds, and it clears the input so re-picking the same file fires.
        if (!/\.nc$/i.test(e.target.files[0].name)) {
            showToast('Only .nc flight-level files can be loaded. "' + e.target.files[0].name + '" was not loaded.', 8000);
            e.target.value = '';
            return;
        }
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

            isNcFile = true;
            const reader = new FileReader();
            reader.onload = (evt) => {
                parseEntireFile(evt.target.result).then(() => {
                    // the flight joins the loaded list so it reopens instantly. best effort, the
                    // list bookkeeping must never take down a load that succeeded.
                    try { rememberUploadedFlight(fName); } catch (e) {}
                }).catch(err => {
                    hideLoadingOverlay();
                    showToast('Could not load ' + fName + ': ' + err.message, 10000);
                });
            };
            reader.onerror = () => { hideLoadingOverlay(); showToast('Could not read ' + fName + ' from disk.', 8000); };
            reader.readAsArrayBuffer(file);
        }, 50);
    });

    // Clears the upload drop zone. Reopening a stored flight starts clean, so the zone never
    // keeps naming the file from the previous flight.
    function clearLoadedMedia() {
        document.getElementById('fileInput').value = '';
        resetDropZone('dataDropZone', 'dataDropLabel');
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
    // wantAll (optional): also produce result.qcAll, an every-variable raw parse for the NC-to-TXT
    // converter. Only the interactive single-flight load passes it; batch preloads skip the cost.
    function parseFlightSource(source, onProgress, wantAll) {
        const report = onProgress || updateParseProgress;
        const onMainThread = () => {
            if (source && typeof source !== 'string' && source.byteLength === 0)
                throw new Error('parse worker failed and the file buffer was already handed off, please re-select the file');
            const tsv = typeof source === 'string' ? source : ncArrayBufferToTsv(source, report);
            const result = parseFlightTextToRows(tsv);
            // QC Mode raw pass on the same tsv; best-effort so a QC failure never blocks playback.
            try { result.qc = (typeof parseFlightRawQC === 'function') ? parseFlightRawQC(tsv) : null; }
            catch (e) { result.qc = null; }
            if (wantAll) { try { result.qcAll = (typeof parseFlightRawQC === 'function') ? parseFlightRawQC(tsv, '*') : null; } catch (e) { result.qcAll = null; } }
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
            if (typeof source === 'string') w.postMessage({ tsv: source, wantAll: !!wantAll });
            else w.postMessage({ nc: source, wantAll: !!wantAll }, [source]);
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
        // wantAll: this is the interactive single-flight load (manual upload or archive), the only
        // path that feeds the NC-to-TXT converter its every-variable dataset.
        applyParsedFlight(await parseFlightSource(source, undefined, true));
    }

    // Take an already-parsed { rows, stats } (fresh from the worker, or held by the mission
    // preloader) and make it the loaded flight: resets, globals, and the post-parse UI setup.
    // Throws when the rows are empty.
    function applyParsedFlight(parsed) {
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
        // Every-variable dataset for the NC-to-TXT converter (memory-only, current flight). Absent for
        // batch-preloaded / reopened-from-store flights, which fall back to the catalog set + a note.
        qcRawDataAll = parsed.qcAll || null;
        try { if (typeof onFlightLoadedForQC === 'function') onFlightLoadedForQC(); }
        catch (e) { console.warn('QC processing failed:', e); if (typeof qcRenderError === 'function') qcRenderError('QC processing failed: ' + ((e && e.message) || e)); }

        updateMissionHeader();

        ['startTimeInput', 'endTimeInput'].forEach(id => document.getElementById(id).disabled = false);
        document.getElementById('startTimeInput').value = allParsedData[0].time;
        document.getElementById('endTimeInput').value = allParsedData[allParsedData.length-1].time;
        applyFiltersAndInit(false);

        // New flight: start zoomed in on the aircraft and following it (js/15-map-render.js).
        if (typeof engageFollowAircraft === 'function') engageFollowAircraft();

        if (filteredData.length > 0 && !isPlaying) {
            startPlayback();
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
