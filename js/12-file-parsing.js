/* Mission Visualizer, file upload + flight-load pipeline
   part of index.html, split into modules so a failure in one file does not break the others.
   loaded as a classic (non-module) script; all parts share one global scope, in order.

   the parsing itself lives in js/11b-parser-core.js (pure, shared with the parse worker).
   this file owns the DOM side: upload wiring, the worker round-trip, the data
   report, and the post-parse UI/global setup. */

    let lastParseStats = null;   // stats ledger from the most recent load (see parseFlightTextToRows)

    function showLoadingOverlay() {
        // flags the QC skeleton placeholders as live: they pulse only while this overlay is up
        // (an actual load/parse in progress), and sit static while just waiting on the user
        document.body.classList.add('qc-skel-live');
        const l = document.getElementById('loadingOverlay'); l.classList.remove('hidden'); l.classList.add('flex');
        const st = document.getElementById('loadingOverlaySubtext'); if (st) st.textContent = 'Pulling variables...';
        // clear the previous load's percent
        const pw = document.getElementById('loadingProgressWrap'); if (pw) pw.classList.add('hidden');
        const pp = document.getElementById('loadingProgressPct'); if (pp) pp.textContent = '0%';
        parseShownPercent = 0;
        const ps = document.getElementById('loadingProgressSpeed'); if (ps) ps.textContent = '';
    }
    function hideLoadingOverlay() { document.body.classList.remove('qc-skel-live'); const l = document.getElementById('loadingOverlay'); l.classList.add('hidden'); l.classList.remove('flex'); }

    document.getElementById('fileInput').addEventListener('change', function(e) {
        if (!e.target.files[0]) return;
        // .nc only. the accept attribute filters the browse dialog but not a drag-and-drop, so this
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

    // clears the upload drop zone. reopening a stored flight starts clean, so the zone never
    // keeps naming the file from the previous flight.
    function clearLoadedMedia() {
        document.getElementById('fileInput').value = '';
        resetDropZone('dataDropZone', 'dataDropLabel');
    }

    // the shared ?v= cache-buster, read off this page's own script tags so the worker URL stays in
    // step with the single version string in index.html.
    function assetVer() {
        const s = document.querySelector('script[src*="?v="]');
        const m = s && s.src.match(/\?v=[^&]+/);
        return m ? m[0] : '';
    }

    // parse a flight source (TSV string, or an .nc ArrayBuffer) into { rows, stats }, off the main
    // thread so the page never freezes on a big file. falls back to parsing on the main thread when
    // workers are unavailable (e.g. file://). rejects with the parse error for the caller to report.
    // how far a parse is, 0 to 1, from a parser progress report. a NetCDF goes through the variable
    // decode, building the text rows, the cleaned-row parse, and the QC raw parse, plus the
    // every-variable raw parse when wantAll is set; a text file skips the first two. each share is
    // roughly that pass's time on a 30,000 row flight (a raw pass costs about what the parse does).
    const PARSE_SPANS = {
        nc:     { var: [0, 0.09], rows: [0.09, 0.21], parse: [0.21, 0.6], qc: [0.6, 1] },
        ncAll:  { var: [0, 0.06], rows: [0.06, 0.14], parse: [0.14, 0.41], qc: [0.41, 0.68], qcAll: [0.68, 1] },
        txt:    { parse: [0, 0.5], qc: [0.5, 1] },
        txtAll: { parse: [0, 0.34], qc: [0.34, 0.67], qcAll: [0.67, 1] }
    };
    function parseProgressFraction(p, fromNc, wantAll) {
        const f = (p.total && p.index) ? Math.min(1, p.index / p.total) : 0;
        const r = PARSE_SPANS[(fromNc ? 'nc' : 'txt') + (wantAll ? 'All' : '')][p.phase];
        return r ? r[0] + (r[1] - r[0]) * f : 0;
    }

    // reflect the worker's progress in the loading overlay: the current step, and one percent for the
    // whole parse that only climbs (reset by showLoadingOverlay).
    let parseShownPercent = 0;
    function updateParseProgress(p, fromNc, wantAll) {
        if (!p) return;
        const st = document.getElementById('loadingOverlaySubtext');
        const wrap = document.getElementById('loadingProgressWrap');
        const pct = document.getElementById('loadingProgressPct');
        const spd = document.getElementById('loadingProgressSpeed');
        if (p.phase === 'open' || p.phase === 'var') { if (st) st.textContent = `Reading ${p.total} NetCDF variables...`; }
        else if (p.phase === 'rows') { if (st) st.textContent = `Building ${Number(p.numRows).toLocaleString()} data rows...`; }
        else if (p.phase === 'parse') { if (st) st.textContent = 'Parsing data rows...'; }
        else if (p.phase === 'qc' || p.phase === 'qcAll') { if (st) st.textContent = 'Placing samples on the time axis...'; }
        else return;
        // the last raw pass reaching its end means the worker is done; drawing the flight then runs on
        // this thread with no reports, so that step shows without a percent
        if (p.phase === (wantAll ? 'qcAll' : 'qc') && p.index >= p.total) {
            if (st) st.textContent = 'Drawing the flight...';
            if (wrap) wrap.classList.add('hidden');
            return;
        }
        parseShownPercent = Math.max(parseShownPercent, Math.round(parseProgressFraction(p, fromNc, wantAll) * 100));
        if (wrap) wrap.classList.remove('hidden');
        if (pct) pct.textContent = parseShownPercent + '%';
        if (spd) spd.textContent = '';
    }

    // onProgress (optional) receives each parser report and whether the source is a NetCDF, for a
    // caller drawing its own bar; without one it defaults to updateParseProgress.
    // wantAll (optional): also produce result.qcAll, an every-variable raw parse for the NC-to-TXT
    // converter, which costs a third pass over the file.
    function parseFlightSource(source, onProgress, wantAll) {
        const fromNc = typeof source !== 'string';
        const report = (p) => (onProgress || updateParseProgress)(p, fromNc, !!wantAll);
        const onMainThread = () => {
            if (source && typeof source !== 'string' && source.byteLength === 0)
                throw new Error('parse worker failed and the file buffer was already handed off, please re-select the file');
            const tsv = typeof source === 'string' ? source : ncArrayBufferToTsv(source, report);
            const result = parseFlightTextToRows(tsv, report);
            // QC Mode raw pass on the same tsv; best-effort so a QC failure never blocks playback.
            try { result.qc = (typeof parseFlightRawQC === 'function') ? parseFlightRawQC(tsv, undefined, report) : null; }
            catch (e) { result.qc = null; }
            if (wantAll) { try { result.qcAll = (typeof parseFlightRawQC === 'function') ? parseFlightRawQC(tsv, '*', (p) => report(Object.assign({}, p, { phase: 'qcAll' }))) : null; } catch (e) { result.qcAll = null; } }
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

    // fill #dataReportLine with the parser's honesty ledger (rows filtered, values derived),
    // so what was done to the data is always disclosed under the mission header.
    function updateDataReport(stats) {
        const line = document.getElementById('dataReportLine');
        if (line) {
            line.textContent = 'Data info: ' + summarizeParseStats(stats);
            line.classList.remove('hidden');
        }
    }

    // load a flight from a TSV string or an .nc ArrayBuffer. throws (after cleaning up its own
    // state) when the file yields nothing usable; callers decide how to surface that.
    async function parseEntireFile(source) {
        // wantAll: this is the interactive single-flight load (manual upload or archive), the only
        // path that feeds the NC-to-TXT converter its every-variable dataset.
        applyParsedFlight(await parseFlightSource(source, undefined, true));
    }

    // take an already-parsed { rows, stats } (fresh from the worker, or held by the mission
    // preloader) and make it the loaded flight: resets, globals, and the post-parse UI setup.
    // throws when the rows are empty.
    function applyParsedFlight(parsed) {
        allParsedData = parsed.rows; lastParseStats = parsed.stats;
        updateDataReport(parsed.stats);
        if (allParsedData.length === 0) {
            throw new Error('no usable rows (' + summarizeParseStats(parsed.stats) + ')');
        }


        // QC Mode: hand the raw dataset (continuous 1-second axis, every catalog var) to the QC
        // engine/report/charts. best-effort so any QC failure never disturbs the player.
        qcRawData = parsed.qc || null;
        // every-variable dataset for the NC-to-TXT converter (memory-only, current flight). absent for
        // batch-preloaded / reopened-from-store flights, which fall back to the catalog set + a note.
        qcRawDataAll = parsed.qcAll || null;
        try { if (typeof onFlightLoadedForQC === 'function') onFlightLoadedForQC(); }
        catch (e) { console.warn('QC processing failed:', e); if (typeof qcRenderError === 'function') qcRenderError('QC processing failed: ' + ((e && e.message) || e)); }

        updateMissionHeader();

        ['startTimeInput', 'endTimeInput'].forEach(id => document.getElementById(id).disabled = false);
        document.getElementById('startTimeInput').value = allParsedData[0].time;
        document.getElementById('endTimeInput').value = allParsedData[allParsedData.length-1].time;
        applyFiltersAndInit(false);

        // new flight: start zoomed in on the aircraft and following it (js/15-map-render.js).
        if (typeof engageFollowAircraft === 'function') engageFollowAircraft();

        if (filteredData.length > 0 && !isPlaying) {
            startPlayback();
        }

        // success: this runs only once processing is fully done. the note reads "Parsed successfully"
        // for a moment, then the overlay clears and the flight shows.
        const st = document.getElementById('loadingOverlaySubtext'); if (st) st.textContent = 'Parsed successfully';
        setTimeout(hideLoadingOverlay, 400);
    }
