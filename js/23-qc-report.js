/* QC Mode, report panel + CSV export + cross-flight store + mode controller
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   This owns the QC user surface: the always-on full-page app shell, with a per-sensor
   presence/gap/flag report down the side and the family charts (js/22) filling the rest. It
   exports the current flight's report as CSV, keeps a cross-flight difference-stats store in
   IndexedDB with its own CSV export, and jumps the map and charts to the exact second a sensor broke. */

    // this is the QC tool, not the visualizer: tells the reused map to drop its player chrome
    // (ground-track + true-heading arrows) so the track reads clean. see js/15-map-render.js.
    window.QC_MODE = true;

    // parseFlightRawQC output for the loaded flight, set by js/12-file-parsing.js applyParsedFlight.
    // declared here so reads before the first flight load return null instead of throwing.
    var qcRawData = (typeof qcRawData !== 'undefined') ? qcRawData : null;
    let qcResult = null;                     // the computed QC model for the loaded flight (js/21)
    let qcOverride = null;                    // { takeoffSec, landingSec } user pin, or null for auto
    let qcOverlayBuilt = false;

    // display name for an airframe letter: tail number plus airframe type
    function qcAircraftLabel(a) {
        return a === 'H' ? 'NOAA42 WP-3D' : a === 'I' ? 'NOAA43 WP-3D' : a === 'N' ? 'NOAA49 G-IV SP' : String(a || '');
    }

    // airframe letter from the mission id (YYYYMMDD<letter>...), falling back to the aircraft name.
    function qcAircraftLetter() {
        const id = (flightMetaData && flightMetaData.id) || '';
        const c = id.charAt(8).toUpperCase();
        if (c === 'H' || c === 'I' || c === 'N') return c;
        const a = (flightMetaData && flightMetaData.aircraft) || '';
        if (/42/.test(a)) return 'H'; if (/43/.test(a)) return 'I'; if (/49/.test(a)) return 'N';
        return 'H';
    }

    // called by js/12-file-parsing.js applyParsedFlight after every flight load.
    function onFlightLoadedForQC() {
        if (!qcRawData) { qcResult = null; qcRenderEmpty(); return; }
        qcOverride = null;
        qcResult = computeQCReport(qcRawData, qcAircraftLetter(), null);
        // the playhead starts at takeoff on every new flight
        if (typeof qcScrubIdx !== 'undefined' && qcResult && qcResult.phases) qcScrubIdx = qcResult.phases.toIdx;
        qcStoreSaveCurrent();   // auto-save this flight's difference stats (silent, idempotent)
        qcRefreshTimeline();
        qcRenderReport();
        qcSyncPhaseInputs();
        // the reused map becomes active on load; make sure it is sized to its QC slot
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    }

    // rerun the whole report pipeline (trim, phases, stats, graphs) with the current override.
    // manual recomputes never touch the saved cross-flight row: that row stays the script's
    // own automatic detection, byte for byte.
    function qcRecomputeReport() {
        if (!qcRawData) return;
        qcResult = computeQCReport(qcRawData, qcAircraftLetter(), qcOverride);
        if (typeof qcScrubIdx !== 'undefined' && qcResult && qcResult.phases) qcScrubIdx = qcResult.phases.toIdx;
        qcRefreshTimeline();
        qcRenderReport();
        qcSyncPhaseInputs();
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    }

    // shared by the header pins and the error summary modal: parse HHMMSS strings, pin the
    // phases, and rerun the whole pipeline. returns true when a recompute actually ran.
    function qcApplyManualPhases(toStr, ldStr, toEl, ldEl) {
        if (!qcRawData) return false;
        const parseHMS = v => { const m = /^(\d{2})(\d{2})(\d{2})$/.exec(String(v || '').trim()); if (!m) return null; const h = +m[1], mi = +m[2], se = +m[3]; return (h > 23 || mi > 59 || se > 59) ? null : h * 3600 + mi * 60 + se; };
        const to = parseHMS(toStr), ld = parseHMS(ldStr);
        // bad fields turn red in place instead of announcing anything
        const toBad = String(toStr || '').trim() !== '' && to == null, ldBad = String(ldStr || '').trim() !== '' && ld == null;
        if (toEl) toEl.classList.toggle('qc-bad', toBad);
        if (ldEl) ldEl.classList.toggle('qc-bad', ldBad);
        if (toBad || ldBad) return false;
        // map hhmmss onto the recording's absolute axis (flights can cross midnight)
        const t0 = (qcRawData.timeAxis && qcRawData.timeAxis.length) ? qcRawData.timeAxis[0] : 0;
        const onAxis = hms => { if (hms == null) return null; let s2 = Math.floor(t0 / 86400) * 86400 + hms; if (s2 < t0) s2 += 86400; return s2; };
        qcOverride = (to == null && ld == null) ? null : { takeoffSec: onAxis(to), landingSec: onAxis(ld) };
        qcRecomputeReport();
        return true;
    }

    // the inputs always show the times actually in force, detected or pinned
    function qcSyncPhaseInputs() {
        const toEl = document.getElementById('qcToInput'), ldEl = document.getElementById('qcLandInput');
        if (!toEl || !ldEl) return;
        toEl.classList.remove('qc-bad'); ldEl.classList.remove('qc-bad');
        if (!qcResult || !qcResult.phases) { toEl.value = ''; ldEl.value = ''; return; }
        toEl.value = qcSecToLabel(qcResult.phases.takeoffSec).replace(/:/g, '');
        ldEl.value = qcSecToLabel(qcResult.phases.landingSec).replace(/:/g, '');
    }

    // called by resetAppToDefault (js/19-bootstrap.js) so reset all clears the qc surfaces too:
    // report, charts, status bar, and clock all return to their waiting state.
    function qcResetToEmpty() {
        qcRawData = null; qcResult = null; qcOverride = null;
        qcRenderEmpty(); qcRefreshTimeline();
    }

    // ---- QC app is the primary, always-on view (not a dismissible overlay) -----------------------
    // the report controls only exist once there is a flight: pre-flight there is nothing to
    // search, view on the map, summarize, or export
    function qcToggleReportControls(show) {
        const d = show ? '' : 'none';
        ['qcPhaseStatsBtn', 'qcSideToggle'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = d; });
        const gsWrap = document.querySelector('.qc-graph-search'); if (gsWrap) gsWrap.style.display = d;
        const exWrap = document.querySelector('.qc-export-wrap'); if (exWrap) exWrap.style.display = d;
    }

    function qcRenderEmpty() {
        const rep = document.getElementById('qcReportPanel'), ch = document.getElementById('qcChartsPanel');
        if (rep) rep.innerHTML = '<div class="qc-empty">No flight loaded.</div>';
        if (ch) ch.innerHTML = '<div class="qc-empty qc-charts-empty">Waiting for flight file&hellip;</div>';
        const nm = document.getElementById('qcMissionName'); if (nm) nm.textContent = '';
        const sp = document.getElementById('qcSummaryPills'); if (sp) sp.innerHTML = '';
        const ex = document.getElementById('qcExportMenuBtn'); if (ex) ex.disabled = true;
        qcToggleReportControls(false);
        // a cleared flight also closes the sidebar, since its toggle is hidden now
        const qapp = document.getElementById('qcApp');
        if (qapp && qapp.classList.contains('qc-side-open')) {
            qapp.classList.remove('qc-side-open');
            const st = document.getElementById('qcSideToggle'); if (st) st.classList.remove('qc-ov-sel');
        }
    }

    const QC_PILL = { ok: 'ok', gap: 'gap', nodata: 'nodata', check: 'check' };
    function qcPill(kind, label) { return '<span class="qc-pill qc-pill-' + kind + '" data-kind="' + kind + '">' + label + '</span>'; }

    function qcRenderReport() {
        if (!qcResult) { qcRenderEmpty(); return; }
        const s = qcResult.summary;
        const ex = document.getElementById('qcExportMenuBtn'); if (ex) ex.disabled = false;
        qcToggleReportControls(true);
        const nm = document.getElementById('qcMissionName');
        if (nm) nm.textContent = (flightMetaData.id || 'flight') + '  ·  ' + qcAircraftLabel(qcResult.aircraft);
        const sp = document.getElementById('qcSummaryPills');
        if (sp) {
            const noun = n => n === 1 ? ' sensor' : ' sensors';
            // the red Check pill leads and only appears when the detector fired: it outranks gaps
            sp.innerHTML = (s.check ? qcPill('check', s.check + noun(s.check) + ' to Check') : '') +
                qcPill('ok', s.ok + noun(s.ok) + ' OK') +
                qcPill('gap', s.gap + noun(s.gap) + ' with gap' + (s.gap === 1 ? '' : 's')) +
                qcPill('nodata', s.nodata + noun(s.nodata) + ' no data');
            // each pill opens a modal listing exactly which sensors are behind that count
            sp.querySelectorAll('.qc-pill').forEach(p => { p.classList.add('qc-pill-click'); p.title = 'List these sensors'; p.addEventListener('click', () => qcShowStatusModal(p.dataset.kind)); });
        }

        qcBuildReportTable();
        qcRenderCharts(document.getElementById('qcChartsPanel'), qcResult);
        qcRefreshTimeline();
    }

    function qcBuildReportTable() {
        const rep = document.getElementById('qcReportPanel'); if (!rep) return;
        let html = '';
        // recorder-level gaps first, reported once and phrased exactly like the archive's
        // GapReport.dat ("Data gap from HH:MM:SS - HH:MM:SS"): seconds where NO channel has data
        // are the data system's event, and blaming every sensor for them was pure noise.
        if (qcResult.recordingGaps && qcResult.recordingGaps.length) {
            const rg = qcResult.recordingGaps;
            html += '<div class="qc-recording" title="Seconds where no instrument recorded at all">' +
                '<span class="qc-pill qc-pill-gap">DATA GAP' + (rg.length > 1 ? 'S' : '') + '</span>' +
                '<span>' + rg.slice(0, 4).map(g => 'Data gap from ' + qcSecToLabel(g.from) + ' - ' + qcSecToLabel(g.to)).join('<br>') +
                (rg.length > 4 ? '<br>plus ' + (rg.length - 4) + ' more (see Gap Report)' : '') + '</span></div>';
        }
        qcResult.families.forEach(fam => {
            const anyIssue = fam.members.some(m => m.presence !== 'ok' && m.presence !== 'derived') || fam.members.some(m => m.flags.length);
            html += '<div class="qc-fam ' + (anyIssue ? 'qc-fam-issue' : '') + '">';
            html += '<div class="qc-fam-head">' + fam.label + ' <span class="qc-fam-unit">' + (typeof qcUnitLabel === 'function' ? qcUnitLabel(fam.unit) : fam.unit) + '</span></div>';
            fam.members.forEach(m => {
                const kind = QC_PILL[m.presence] || 'nodata';
                const gapSecs = m.gaps.reduce((a, g) => a + (g.effSecs || g.secs), 0);
                let detail = '';
                if (m.presence === 'ok') detail = m.count.toLocaleString() + ' s';
                else if (m.presence === 'gap') detail = gapSecs.toLocaleString() + ' s missing, ' + m.gaps.length + ' gap' + (m.gaps.length > 1 ? 's' : '');
                else if (m.presence === 'nodata') detail = 'absent';
                else if (m.presence === 'check') detail = m.checks.length + ' region' + (m.checks.length === 1 ? '' : 's') + ' to check: ' + m.checks[0].reason;
                if (m.earlyStop) detail += (detail ? ' · ' : '') + 'stopped early by ' + m.earlyStop.secs.toLocaleString() + ' s';
                // clicking a flagged row jumps the timeline + map to where the issue starts
                const jumpSec = m.presence === 'check' && m.checks.length ? Math.round(qcResult.timeAxis[m.checks[0].fromIdx])
                    : m.gaps.length ? Math.round(m.gaps[0].from) : null;
                const jump = jumpSec != null ? ' data-jump="' + jumpSec + '"' : '';
                html += '<div class="qc-row' + (jump ? ' qc-row-jump' : '') + '"' + jump + '>' +
                    qcPill(kind, m.presence === 'nodata' ? 'NO DATA' : m.presence.toUpperCase()) +
                    '<span class="qc-row-name">' + m.name + (m.isRef ? ' <em>ref</em>' : '') + (m.isDerived ? ' <em>(deriv.)</em>' : '') + '</span>' +
                    '<span class="qc-row-detail">' + detail + '</span></div>';
            });
            // per-pair largest magnitude difference (the mean still feeds the cross-flight store)
            fam.diffs.forEach(d => {
                if (d.series) html += '<div class="qc-row qc-row-diff"><span class="qc-row-name">' + d.id + '</span><span class="qc-row-detail">Max Diff: ' + (Number.isNaN(d.max) ? 'n/a' : d.max) + '</span></div>';
            });
            if (fam.phaseStat) Object.keys(fam.phaseStat).forEach(k => {
                const st = fam.phaseStat[k], f = v => Number.isNaN(v) ? 'n/a' : qcRound(v, 1);
                html += '<div class="qc-row qc-row-stat"><span class="qc-row-name">' + k + ' T/O·Land</span><span class="qc-row-detail">max ' + f(st.takeoff.max) + '/' + f(st.landing.max) + '</span></div>';
            });
            html += '</div>';
        });
        rep.innerHTML = html;
        // wire jump-to-second
        rep.querySelectorAll('.qc-row-jump').forEach(row => row.addEventListener('click', () => qcJumpToSecond(parseInt(row.dataset.jump, 10))));
    }

    // THE playhead-to-player contract: the one function allowed to translate the playhead (axis
    // seconds since recording start) into a player row (rows exist takeoff..landing only). a
    // playhead before takeoff maps to row 0, after landing to the last row; in between it is the
    // nearest row by absolute clock time (binary search, rows are sorted).
    function qcPlayheadToRow() {
        if (!filteredData || !filteredData.length || typeof qcScrubIdx === 'undefined' || qcScrubIdx == null || !qcAxisRef) return 0;
        const sec = qcAxisRef[qcScrubIdx];
        let lo = 0, hi = filteredData.length - 1;
        if (sec <= filteredData[0].absSeconds) return 0;
        if (sec >= filteredData[hi].absSeconds) return hi;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (filteredData[mid].absSeconds <= sec) lo = mid; else hi = mid; }
        return (sec - filteredData[lo].absSeconds <= filteredData[hi].absSeconds - sec) ? lo : hi;
    }

    // the follower: drives the player to the playhead through the contract above and renders only
    // the map frame + clock, throttled. the full player pipeline never runs from here, which is
    // what keeps scrubbing free of ghosting. a no-op while the 2d/3d context is hidden.
    let qcDriveAt = 0;
    function qcDrivePlayer(force) {
        const app = document.getElementById('qcApp');
        if (!app) return;
        // the map is drivable when its panel is visible: in the open sidebar, or relocated into
        // the diff modal's flight context card
        const ctx = document.getElementById('qcDiffContext');
        const ctxOpen = ctx && ctx.style.display !== 'none';
        if (!app.classList.contains('qc-side-open') && !ctxOpen) return;
        if (!filteredData || !filteredData.length || typeof qcScrubIdx === 'undefined' || qcScrubIdx == null || !qcAxisRef) return;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        if (!force && now - qcDriveAt < 150) return;
        qcDriveAt = now;
        currentIdx = qcPlayheadToRow();
        try {
            const row = filteredData[currentIdx];
            if (typeof trackerModeSelect !== 'undefined' && trackerModeSelect.value === '2d') { if (typeof renderMapEngineFrame === 'function') renderMapEngineFrame(currentIdx, row); }
            else if (typeof update3DFrame === 'function') update3DFrame(currentIdx, row);
        } catch (e) {}
        qcSyncTimeLabel();
    }

    // modal listing every sensor behind a summary pill (clicking "15 GAPS" shows the 15 sensors)
    function qcShowStatusModal(kind) {
        if (!qcResult) return;
        const modal = document.getElementById('qcStatusModal'); if (!modal) return;
        const rows = [];
        qcResult.families.forEach(fam => fam.members.forEach(m => {
            if (m.presence !== kind) return;
            let detail = '';
            if (kind === 'gap') { const secs = m.gaps.reduce((a, g) => a + (g.effSecs || g.secs), 0); detail = secs.toLocaleString() + ' s missing, first at ' + qcSecToLabel(m.gaps[0].from); }
            else if (kind === 'check') detail = m.checks[0].reason + ', first at ' + qcSecToLabel(qcResult.timeAxis[m.checks[0].fromIdx]);
            else if (kind === 'ok') detail = m.count.toLocaleString() + ' s';
            else detail = 'absent from this file';
            rows.push({ fam: fam, m: m, detail: detail });
        }));
        const noun = 'sensor' + (rows.length === 1 ? '' : 's');
        document.getElementById('qcStatusModalTitle').textContent =
            kind === 'gap' ? rows.length + ' ' + noun + ' with in-flight gap' + (rows.length === 1 ? '' : 's')
            : kind === 'nodata' ? rows.length + ' ' + noun + ' with no data'
            : kind === 'check' ? rows.length + ' ' + noun + ' to Check'
            : rows.length + ' ' + noun + ' OK';
        const body = document.getElementById('qcStatusModalBody');
        body.innerHTML = rows.map(r => {
            const jump = kind === 'gap' ? Math.round(r.m.gaps[0].from) : kind === 'check' ? Math.round(qcResult.timeAxis[r.m.checks[0].fromIdx]) : null;
            const full = r.fam.label + ' · ' + r.detail;
            return '<div class="qc-row qc-row-jump" data-var="' + r.m.name + '"' + (jump != null ? ' data-jump="' + jump + '"' : '') + ' title="View this sensor\'s graph">' +
                '<span class="qc-row-name">' + r.m.name + (r.m.isRef ? ' <em>ref</em>' : '') + (r.m.isDerived ? ' <em>(deriv.)</em>' : '') + '</span>' +
                '<span class="qc-row-detail" title="' + full.replace(/"/g, '&quot;') + '">' + full + '</span></div>';
        }).join('') || '<div class="qc-empty">None.</div>';
        body.querySelectorAll('.qc-row-jump').forEach(row => row.addEventListener('click', () => {
            modal.style.display = 'none';
            if (row.dataset.jump) qcJumpToSecond(parseInt(row.dataset.jump, 10));
            qcScrollToVar(row.dataset.var);
        }));
        modal.style.display = 'flex';
    }

    // ---- flag -> context jump -------------------------------------------------------------------
    // set the playhead to the cleaned row nearest a given absolute second, then drive the same update
    // path the timeline uses so tracker, PFD/HUD, MMR, and charts all move to that moment.
    // move the playhead to an absolute second. sets the single source of truth (qcScrubIdx),
    // pauses playback, drives the follower map once, and redraws the graphs. nothing else.
    function qcJumpToSecond(sec) {
        if (!qcAxisRef || !qcAxisRef.length) return;
        const ai = Math.round(sec - qcAxisRef[0]);
        // a jump before takeoff (or after landing) keeps the sidebar open; the playhead goes
        // exactly there and the player shows the boundary frame through qcPlayheadToRow
        qcScrubIdx = (typeof qcClampScrub === 'function') ? qcClampScrub(ai) : Math.max(0, Math.min(qcAxisRef.length - 1, ai));
        if (typeof isPlaying !== 'undefined' && isPlaying) {
            const pb = document.getElementById('playPauseBtn');
            if (pb && /pause/i.test(pb.innerText)) pb.click(); else isPlaying = false;
        }
        qcDrivePlayer(true);
        if (typeof qcSyncPlayhead === 'function') qcSyncPlayhead(true);
    }

    // ---- CSV: current-flight per-sensor report --------------------------------------------------
    function qcExportReportCSV() {
        if (!qcResult) return;
        const rows = [['mission', 'aircraft', 'family', 'sensor', 'is_ref', 'presence', 'samples_s', 'gaps', 'missing_s', 'early_stop_s', 'max_diff']];
        qcResult.families.forEach(fam => fam.members.forEach(m => {
            const missing = m.gaps.reduce((a, g) => a + (g.effSecs || g.secs), 0);
            rows.push([flightMetaData.id, qcResult.aircraft, fam.key, m.name, m.isRef ? 1 : 0, m.presence, m.count, m.gaps.length, missing, m.earlyStop ? m.earlyStop.secs : '', '']);
        }));
        // recorder-level gaps, one row each (sensor column marks them as the data system's)
        (qcResult.recordingGaps || []).forEach(g => rows.push([flightMetaData.id, qcResult.aircraft, '', 'recording', '', 'recording-gap', '', '', g.secs, '', '']));
        // per-pair max differences as extra rows, in their own labeled column
        qcResult.families.forEach(fam => fam.diffs.forEach(d => { if (d.series) rows.push([flightMetaData.id, qcResult.aircraft, fam.key, 'diff:' + d.id, '', 'diff', '', '', '', '', d.max]); }));
        qcDownloadCSV(rows, (flightMetaData.id || 'flight') + '_QC_report.csv');
    }

    // scroll the chart column to the family panel that carries a given variable, with a brief
    // highlight so the eye lands on the right graph (used by Phase Stats "View graph")
    function qcScrollToVar(name) {
        if (!qcResult || !name) return;
        const fam = qcResult.families.find(f => f.members.some(m => m.name === name));
        if (!fam) return;
        const panel = document.getElementById('qcpanel_' + fam.key) || (fam.key === 'lon' ? document.getElementById('qcpanel_lat') : null); if (!panel) return;
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        panel.classList.remove('qc-panel-flash'); void panel.offsetWidth; panel.classList.add('qc-panel-flash');
    }

    // gap report in the archive's own GapReport.dat format: the source file on the first line, then
    // one "Data gap from HH:MM:SS - HH:MM:SS" line per recorder-level gap. per-sensor gaps follow,
    // same phrasing prefixed with the sensor name, so the report is never an empty shell.
    function qcExportGapReport() {
        if (!qcResult) return;
        const src = (typeof reconArchiveMeta !== 'undefined' && reconArchiveMeta && reconArchiveMeta.sourceUrl) || ((flightMetaData.id || 'flight') + '.nc');
        const lines = [src];
        (qcResult.recordingGaps || []).forEach(g => lines.push('Data gap from ' + qcSecToLabel(g.from) + ' - ' + qcSecToLabel(g.to)));
        const seen = new Set();
        qcResult.families.forEach(fam => fam.members.forEach(m => {
            if (seen.has(m.name)) return; seen.add(m.name);
            (m.gaps || []).forEach(g => lines.push(m.name + ' data gap from ' + qcSecToLabel(g.from) + ' - ' + qcSecToLabel(g.to)));
            if (m.earlyStop) lines.push(m.name + ' stopped early by ' + m.earlyStop.secs + ' s');
        }));
        if (lines.length === 1) lines.push('No data gaps detected.');
        const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        // the archive names this document GapReport.dat inside each mission's directory; the
        // download keeps that exact name
        a.download = 'GapReport.dat'; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    function qcDownloadCSV(rows, filename) {
        const esc = v => { const s = (v === null || v === undefined) ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const csv = rows.map(r => r.map(esc).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    // ---- cross-flight difference-stats store (IndexedDB) ----------------------------------------
    // one row per flight: mission id + every family's mean difference, keyed by airframe. replaces
    // the script's N42/N43/N49_Stats.txt append-only files, queryable in-app and exportable as CSV.
    const QC_DB = 'aocQC', QC_STORE = 'qcFlights';
    function qcDBOpen() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(QC_DB, 1);
            req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(QC_STORE)) db.createObjectStore(QC_STORE, { keyPath: 'missionId' }); };
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
    }
    // saves silently and automatically on every flight load (put is keyed by missionId, so
    // reloading a flight just refreshes its row). no button, no toast.
    async function qcStoreSaveCurrent() {
        if (!qcResult) return;
        try {
            const db = await qcDBOpen();
            await new Promise((res, rej) => { const tx = db.transaction(QC_STORE, 'readwrite'); tx.objectStore(QC_STORE).put(qcResult.crossFlightRow); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        } catch (e) { console.warn('cross-flight store save failed:', e); }
    }
    async function qcStoreAll() {
        try { const db = await qcDBOpen(); return await new Promise((res, rej) => { const tx = db.transaction(QC_STORE, 'readonly'); const rq = tx.objectStore(QC_STORE).getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error); }); }
        catch (e) { return []; }
    }
    async function qcExportStoreCSV(onlyIds) {
        let all = await qcStoreAll();
        if (onlyIds && onlyIds.size) all = all.filter(r => onlyIds.has(String(r.missionId)));
        if (!all.length) return;   // nothing saved yet (rows are auto-saved on each flight load)
        // one .csv per airframe: a header row naming every difference column, then one row per
        // flight in the script's exact column order. the data cells stay byte identical to the
        // legacy N42/N43/N49_Stats values (drop the header row and it appends onto a historical
        // file), the header just makes flights easy to compare column by column. airframes with no
        // stored flights produce no file; rows saved by older builds regenerate when reopened.
        const tails = { H: 'N42', I: 'N43', N: 'N49' };
        Object.keys(tails).forEach(letter => {
            const rows = all.filter(r => r.aircraft === letter && r.scriptLine)
                .sort((a, b) => String(a.missionId).localeCompare(String(b.missionId)))
                .map(r => r.scriptLine);
            if (!rows.length) return;
            const csv = qcScriptStatsHeader(letter) + '\n' + rows.join('\n') + '\n';
            const blob = new Blob([csv], { type: 'text/csv' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = tails[letter] + '_Stats.csv'; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        });
    }

    // flight picker for the stats export: choose exactly which stored flights go into each
    // plane's Stats file, so nobody has to delete cached flights just to shape the download
    let qcStatsPicker = null;
    async function qcShowStatsPicker() {
        if (!qcStatsPicker) {
            qcStatsPicker = document.createElement('div');
            qcStatsPicker.id = 'qcStatsPicker'; qcStatsPicker.className = 'modal-overlay';
            qcStatsPicker.innerHTML =
                '<div class="modal-card" style="max-height:80vh;max-width:520px">' +
                  '<button id="qcStatsPickerClose" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">✕</button>' +
                  '<h2 class="text-ink text-lg font-bold border-b border-hairline pb-2">Indiv. Plane Stats CSV</h2>' +
                  '<div class="qc-picker-note">Every flight opened in this tool saves its stats row on this device automatically, so this list holds all flights of each plane, including flights from earlier sessions. Check the flights to include; one Stats file downloads per plane, in the script\'s exact format.</div>' +
                  '<div id="qcStatsPickerBody" style="overflow-y:auto;min-height:0"></div>' +
                  '<div class="qc-picker-foot">' +
                    '<button id="qcStatsPickerAll" class="qc-ov-btn">All</button>' +
                    '<button id="qcStatsPickerNone" class="qc-ov-btn">None</button>' +
                    '<span style="flex:1"></span>' +
                    '<button id="qcStatsPickerGo" class="qc-ov-btn qc-ov-btn-accent">Download Selected</button>' +
                  '</div>' +
                '</div>';
            document.body.appendChild(qcStatsPicker);
            document.getElementById('qcStatsPickerClose').addEventListener('click', () => { qcStatsPicker.style.display = 'none'; });
            qcStatsPicker.addEventListener('click', e => { if (e.target === qcStatsPicker) qcStatsPicker.style.display = 'none'; });
            document.addEventListener('keydown', e => { if (e.key === 'Escape') qcStatsPicker.style.display = 'none'; });
            const setAll = on => qcStatsPicker.querySelectorAll('.qc-picker-row input').forEach(cb => { cb.checked = on; });
            document.getElementById('qcStatsPickerAll').addEventListener('click', () => setAll(true));
            document.getElementById('qcStatsPickerNone').addEventListener('click', () => setAll(false));
            document.getElementById('qcStatsPickerGo').addEventListener('click', () => {
                const ids = new Set(Array.from(qcStatsPicker.querySelectorAll('.qc-picker-row input:checked')).map(cb => cb.dataset.id));
                if (!ids.size) return;   // nothing checked, nothing to download
                qcStatsPicker.style.display = 'none';
                qcExportStoreCSV(ids);
            });
        }
        const all = await qcStoreAll();
        const tails = { H: 'N42', I: 'N43', N: 'N49' };
        let html = '';
        Object.keys(tails).forEach(letter => {
            const rows = all.filter(r => r.aircraft === letter).sort((a, b) => String(a.missionId).localeCompare(String(b.missionId)));
            if (!rows.length) return;
            html += '<div class="qc-picker-group">' + tails[letter] + '_Stats.csv (' + rows.length + ' flight' + (rows.length === 1 ? '' : 's') + ')</div>';
            html += rows.map(r => r.scriptLine
                ? '<label class="qc-picker-row"><input type="checkbox" checked data-id="' + String(r.missionId).replace(/"/g, '&quot;') + '">' + r.missionId + '</label>'
                : '<div class="qc-picker-row qc-picker-stale">' + r.missionId + ' (reopen this flight once to refresh its saved row)</div>').join('');
        });
        document.getElementById('qcStatsPickerBody').innerHTML = html || '<div class="qc-empty">No flights saved yet. Load a flight and its row saves on its own.</div>';
        qcStatsPicker.style.display = 'flex';
    }

    // ---- QC clock (graphs and arrow keys are the scrubber; there is no timeslider) --------------
    function qcRefreshTimeline() { qcSyncTimeLabel(); }
    function qcSyncTimeLabel() {
        const lbl = document.getElementById('qcTimeLabel'); if (!lbl) return;
        // the clock reads from the single source of truth (the playhead), not the player row
        if (typeof qcScrubIdx !== 'undefined' && qcScrubIdx != null && typeof qcTimeLabels !== 'undefined' && qcTimeLabels && qcTimeLabels[qcScrubIdx]) {
            lbl.textContent = qcTimeLabels[qcScrubIdx] + ' UTC';
            return;
        }
        const row = filteredData && filteredData[currentIdx];
        lbl.textContent = row ? (row.time.slice(0, 2) + ':' + row.time.slice(2, 4) + ':' + row.time.slice(4) + ' UTC') : '--:--:--';
    }

    // ---- UI construction: the QC app is the whole page ------------------------------------------
    function qcInitUI() {
        if (qcOverlayBuilt) return; qcOverlayBuilt = true;

        const app = document.createElement('div');
        app.id = 'qcApp'; app.className = 'qc-app';
        app.innerHTML =
            '<header class="qc-app-head">' +
              // the corner border wraps only the emblem + title (.qc-brand); the flight library
              // sits below it in the same column, outside the cornered area
              '<div class="qc-brand-block">' +
                '<div class="qc-brand">' +
                  '<img src="assets/noaa-emblem-72.png" alt="NOAA emblem" class="qc-brand-logo">' +
                  '<div class="qc-vdiv"></div>' +
                  '<div class="qc-brand-col">' +
                    '<span class="qc-brand-txt">QC Tool<small>Aircraft Operations Center · Science Branch</small></span>' +
                  '</div>' +
                '</div>' +
                '<div class="qc-brand-actions" id="qcBrandActions"></div>' +
              '</div>' +
              '<div class="qc-loader-slot" id="qcLoaderSlot"></div>' +
              '<div class="qc-head-controls" id="qcHeadControls"></div>' +
            '</header>' +
            '<div class="qc-actionbar">' +
              '<div class="qc-graph-search">' +
                '<input type="text" id="qcGraphSearch" placeholder="Search graphs by variable, sensor, or title" autocomplete="off" />' +
                '<div id="qcGraphSearchResults" class="qc-menu hidden"></div>' +
              '</div>' +
              '<div class="qc-ov-title" id="qcMissionName"></div>' +
              '<div class="qc-summary" id="qcSummaryPills"></div>' +
              '<div class="qc-ov-actions">' +
                '<button id="qcPhaseStatsBtn" class="qc-ov-btn" title="Takeoff, mid-flight, and landing max, mean, and median for a variable">Max/Mean/Median</button>' +
                '<button id="qcSideToggle" class="qc-ov-btn qc-ov-btn-flight" title="Show or hide the flight-track map and sensor report sidebar">Flight Context</button>' +
                '<div class="qc-vdiv qc-vdiv-sm"></div>' +
                '<div class="qc-export-wrap">' +
                  '<button id="qcExportMenuBtn" class="qc-ov-btn" title="Download reports and stats">Export ▾</button>' +
                  '<div id="qcExportMenu" class="qc-menu hidden">' +
                    '<button class="qc-menu-item" id="qcErrorSummaryBtn" title="Fill out and download the Error Summary PDF">Error Summary (.pdf)</button>' +
                    '<button class="qc-menu-item" id="qcTrackPdfBtn" title="Download a PDF map of the flight track">Flight Track Map (.pdf)</button>' +
                    '<button class="qc-menu-item" id="qcGapReportBtn" title="Recording gaps in the archive GapReport.dat format">Gap Report (.dat)</button>' +
                    '<button class="qc-menu-item" id="qcExportHtmlBtn" title="Download an interactive report as one self-contained HTML file">Interactive Report (.html)</button>' +
                    '<button class="qc-menu-item" id="qcExportReportBtn" title="This flight\'s per-sensor QC stats">Indiv. Sensor Stats CSV</button>' +
                    '<button class="qc-menu-item" id="qcExportStoreBtn" title="Pick which stored flights go into each plane\'s Stats file">Indiv. Plane Stats CSV</button>' +
                    '<div class="qc-menu-sep"></div>' +
                    '<button class="qc-menu-item qc-menu-share" id="qcShareLinkBtn" title="Copy a shareable link to this view">Share QC Link</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="qc-app-body">' +
              '<main class="qc-charts" id="qcChartsPanel"></main>' +
              '<aside class="qc-side">' +
                '<div class="qc-context">' +
                  '<div class="qc-context-head">Flight Track <span>context</span></div>' +
                  '<div class="qc-map-slot" id="qcMapSlot"></div>' +
                  '<div class="qc-timeline">' +
                    '<button id="qcPlayBtn" class="qc-ov-btn" title="Play / pause" style="min-width:52px">Play</button>' +
                '<button id="qcSpeedBtn" class="qc-ov-btn" title="Playback speed, click to cycle" style="min-width:44px">1x</button>' +
                    '<span id="qcTimeLabel" class="qc-time-label">--:--:--</span>' +
                  '</div>' +
                  '<div class="qc-context-note">scrub by clicking or dragging on any graph, or with the arrow keys (shift for 10 s steps); playback stays between takeoff and landing</div>' +
                '</div>' +
                '<div class="qc-report" id="qcReportPanel"></div>' +
              '</aside>' +
            '</div>';
        // the "command" dock (bottom-right): request takeoff / mid-flight / landing max·mean·median
        // for any present variable, on demand. reproduces the script's PSM stat line for any sensor.
        const cmd = document.createElement('div');
        cmd.id = 'qcCmdPanel'; cmd.className = 'qc-cmd hidden';
        cmd.innerHTML =
            '<div class="qc-cmd-head"><span>Max/Mean/Median</span><button id="qcCmdClose" class="qc-cmd-x" title="Close">✕</button></div>' +
            '<div class="qc-cmd-row"><label>Variable</label><select id="qcCmdVar" class="qc-ov-input" style="width:auto;flex:1"></select>' +
            '<button id="qcCmdViewGraph" class="qc-ov-btn" title="Scroll to this variable\'s graph">View graph</button></div>' +
            '<div class="qc-cmd-win" id="qcCmdWindow"></div>' +
            '<table class="qc-cmd-table"><thead><tr><th>Phase</th><th>Max</th><th>Mean</th><th>Median</th><th>n</th></tr></thead><tbody id="qcCmdBody"></tbody></table>';
        app.appendChild(cmd);

        // status modal: opened by clicking a summary pill, lists every sensor behind that count
        const sm = document.createElement('div');
        sm.id = 'qcStatusModal'; sm.className = 'modal-overlay';
        sm.innerHTML =
            '<div class="modal-card" style="max-height:80vh">' +
              '<button id="qcStatusModalClose" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">✕</button>' +
              '<h2 id="qcStatusModalTitle" class="text-ink text-lg font-bold border-b border-hairline pb-2"></h2>' +
              '<div id="qcStatusModalBody" style="overflow-y:auto;min-height:0"></div>' +
            '</div>';
        document.body.appendChild(sm);
        document.getElementById('qcStatusModalClose').addEventListener('click', () => { sm.style.display = 'none'; });
        sm.addEventListener('click', e => { if (e.target === sm) sm.style.display = 'none'; });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') sm.style.display = 'none'; });

        // help modal: the qc manual, opened from the reused top-right help button
        const hm = document.createElement('div');
        hm.id = 'qcHelpModal'; hm.className = 'modal-overlay';
        hm.innerHTML =
            '<div class="modal-card" style="max-width:860px;max-height:88vh;overflow-y:auto">' +
              '<button id="qcHelpClose" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">\u2715</button>' +
              '<div class="border-b border-hairline pr-8" style="padding-bottom:10px;">' +
                '<h2 class="text-ink text-lg font-bold">Help &amp; Feature Guide</h2>' +
                '<p class="text-[11px] text-muted mt-1 leading-snug">Built for the NOAA Aircraft Operations Center &middot; Science Branch. Based on the qc_plots_with_map_v2.py workflow, automated into one tool.</p>' +
              '</div>' +
              '<div class="help-body">' +
                '<p class="help-lead" style="margin-top:10px">The QC Tool grades every sensor on a hurricane-hunter flight: raw flight-level data on a continuous 1 second axis, recorder gaps separated from per-sensor gaps, implausible values flagged, the legacy script statistics reproduced, and the same reports the archive workflow expects.</p>' +
                '<div class="qc-help-toc">' +
                  ['Load a mission','Reading a graph','Check regions','Legend and groups','Tools and zoom','Issues and pills','Statistics','Takeoff and landing','Flight context','Exports','Shortcuts'].map(function (t, i) { return '<button onclick="document.getElementById(\'qchs' + i + '\').scrollIntoView({behavior:\'smooth\',block:\'start\'})">' + t + '</button>'; }).join('') +
                '</div>' +
                '<div class="qc-help-grid">' +

                '<div class="qc-help-card wide" id="qchs1">' +
                  '<h3>Reading a graph</h3>' +
                  '<svg class="qc-help-fig" width="320" height="84" viewBox="0 0 320 84">' +
                    '<rect x="0.5" y="0.5" width="319" height="83" rx="6" fill="none" stroke="var(--border)"/>' +
                    '<rect x="160" y="3" width="36" height="78" fill="rgba(240,190,60,0.18)"/>' +
                    '<path d="M173 6 L183 6 L178 14 Z" fill="rgba(240,190,60,0.95)"/>' +
                    '<path d="M12 54 C 60 40, 110 62, 158 50" stroke="#5b9dff" fill="none" stroke-width="1.6"/>' +
                    '<path d="M198 48 C 230 42, 270 60, 308 50" stroke="#5b9dff" fill="none" stroke-width="1.6"/>' +
                    '<line x1="70" y1="4" x2="70" y2="80" stroke="var(--text)" stroke-width="1.3"/>' +
                    '<text x="70" y="76" text-anchor="middle">playhead</text>' +
                    '<text x="178" y="30" text-anchor="middle">gap marker</text>' +
                    '<text x="178" y="76" text-anchor="middle">missing s</text>' +
                  '</svg>' +
                  '<ul>' +
                    '<li><b>Gap markers:</b> the small triangle in the top strip marks a gap; the faint yellow pillar under it spans the missing seconds. Click the triangle itself to jump the playhead there AND zoom into the gap; clicking anywhere else just moves the playhead. Hover the pillar for the exact window and length.</li>' +
                    '<li><b>Lines:</b> dotted verticals are takeoff and landing, the solid white line is the playhead, and NO DATA appears in place when a family has nothing to plot.</li>' +
                    '<li><b>Hover:</b> the tooltip picks the point nearest the cursor in both axes, so aiming at a spike grabs the spike; every other visible sensor at that second lists below it.</li>' +
                    '<li><b>Flight Track:</b> latitude and longitude share one map panel (longitude across, latitude up) with faint geography behind the tracks and takeoff, landing, and playhead dots; click a track to jump the playhead there.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs0">' +
                  '<h3>Load a mission</h3>' +
                  '<ul>' +
                    '<li><b>Archive (API online):</b> search by id, storm, or date, or pick Year, Storm, Flight, then Load Flight + Storm Track.</li>' +
                    '<li><b>Manual upload:</b> drop a .txt or .nc on the upload zone; works with no internet.</li>' +
                    '<li><b>Already loaded:</b> every flight is stored on this device and reopens instantly; the red cross removes one. The store keeps the 40 most recent.</li>' +
                    '<li><b>Batch Load Flight Data:</b> download whole seasons for instant, offline reopening.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs2">' +
                  '<h3>Check regions</h3>' +
                  '<ul>' +
                    '<li>Red shading and red markers flag implausible values. Judge them in flight context: a 20 m/s vertical wind at cruise is suspect, the same value inside an eyewall may be real.</li>' +
                    '<li>Current rules: humidity above 200 percent, a 100 m/s wind change in under 15 s, vertical wind beyond 40 m/s, and a 5 degree position change within 30 minutes.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs3">' +
                  '<h3>Legend and groups</h3>' +
                  '<ul>' +
                    '<li>One checkbox per variable; click to select or unselect it.</li>' +
                    '<li><b>Group chips:</b> a chip toggles its whole sensor group on or off, and several groups can be lit on one graph at the same time.</li>' +
                    '<li><b>Standard deviation and coefficient of variation</b> for the selected sensors sit under each graph, with the worst moment named.</li>' +
                    '<li><b>Ref linkage:</b> the pipe connector chains the ref to every sensor it rode; the source in force at the playhead reads blue as you scrub. A badge in the title lists each switch; click a switch time to jump there.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs4">' +
                  '<h3>Tools and zoom</h3>' +
                  '<ul>' +
                    '<li><b>Scrub</b> drags the playhead, <b>pan</b> moves the window (vertically too), <b>select zoom</b> drags a box. The wheel always zooms time.</li>' +
                    '<li><b>Reset Zoom</b> floats on a zoomed graph; double click does the same and hands the mouse back to scrub.</li>' +
                    '<li>Each graph carries <b>save as PNG</b> and <b>fullscreen</b> at its top right; <b>graph search</b> (far left of the status bar) jumps to any panel.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs5">' +
                  '<h3>Issues and pills</h3>' +
                  '<ul>' +
                    '<li><b>Summary pills:</b> Check, OK, gaps, and no data; click one to list exactly those sensors and jump to their first issue.</li>' +
                    '<li><b>Chip strip:</b> Check chips lead, then gaps, no data, and early stop notes; click any chip to jump the map and timeline there.</li>' +
                    '<li><b>+N more</b> expands in place, with the color coded flag counts in parentheses beside it.</li>' +
                    '<li>Early stops are reported but never counted as gaps.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs6">' +
                  '<h3>Statistics</h3>' +
                  '<ul>' +
                    '<li><b>Max/Mean/Median</b> pops out under its button: takeoff, mid-flight, and landing max, mean, and median for any variable; View graph scrolls to its panel.</li>' +
                    '<li>The takeoff phase is the five minutes before takeoff; landing covers the last 600 seconds of the flight.</li>' +
                    '<li><b>Difference Between Sensors</b> opens the family difference graph: every in-group pair plots with its Max Diff listed; cross group pairs sit on their own row.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs7">' +
                  '<h3>Takeoff and landing</h3>' +
                  '<ul>' +
                    '<li>Takeoff and landing are detected automatically from altitude (or airspeed as fallback).</li>' +
                    '<li><b>Manual pins:</b> the T/O and LND boxes under the top right buttons take HHMMSS times; Apply recomputes everything with them, Auto returns to detection.</li>' +
                    '<li>Everything recorded before five minutes ahead of takeoff is trimmed away and never reaches the graphs, gaps, or stats.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs8">' +
                  '<h3>Flight context</h3>' +
                  '<ul>' +
                    '<li><b>Flight Context</b> opens the sidebar: the 2D/3D tracker, the per-sensor report, Play, speed, and the flight clock.</li>' +
                    '<li>The 2D map follows the aircraft; pan away and Recenter on Aircraft appears.</li>' +
                    '<li>Scrub from any graph, the arrow keys, or Play; every surface follows the same playhead.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs9">' +
                  '<h3>Exports</h3>' +
                  '<ul>' +
                    '<li><b>Indiv. Sensor Stats CSV:</b> one row per sensor (presence, gaps, missing seconds, early stop) plus each pair max difference.</li>' +
                    '<li><b>Gap Report (.dat):</b> recorder gaps in the archive GapReport.dat wording.</li>' +
                    '<li><b>Interactive Report (.html):</b> one self-contained file with every graph interactive, the gap markers, the track, and the summary; send it to anyone, no flight load needed.</li>' +
                    '<li><b>Error Summary (.pdf):</b> the qc_Error_Summary script form, prefilled by the tool (flight id, times, sensor designations) and editable before download; the PDF layout matches the script exactly.</li>' +
                    '<li><b>Indiv. Plane Stats CSV:</b> pick which stored flights go into each plane .csv. Each value is the flight-average difference between a sensor pair (first sensor minus second, over takeoff to landing); a value near zero means the two sensors agree. Columns are labeled and match the legacy script values.</li>' +
                    '<li><b>Share QC Link:</b> reopens an archive mission at your playhead, view, and sidebar state.</li>' +
                  '</ul>' +
                '</div>' +

                '<div class="qc-help-card" id="qchs10">' +
                  '<h3>Shortcuts and feedback</h3>' +
                  '<ul>' +
                    '<li><kbd>Space</kbd> play or pause &middot; <kbd>Left</kbd>/<kbd>Right</kbd> step 1 s (<kbd>Shift</kbd> for 10 s) &middot; <kbd>Ctrl</kbd>+<kbd>Z</kbd> steps a zoom back &middot; <kbd>Esc</kbd> closes panels.</li>' +
                    '<li><b>Feedback:</b> the exclamation button opens a report form; Send hands the prefilled draft to Gmail. The draft stays until sent.</li>' +
                  '</ul>' +
                '</div>' +

                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(hm);
        document.getElementById('qcHelpClose').addEventListener('click', () => { hm.style.display = 'none'; });
        hm.addEventListener('click', e => { if (e.target === hm) hm.style.display = 'none'; });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') hm.style.display = 'none'; });
        const hb = document.getElementById('helpBtn');
        if (hb) { hb.onclick = () => { hm.style.display = hm.style.display === 'flex' ? 'none' : 'flex'; }; hb.title = 'Help and keyboard shortcuts'; }

        // report a problem / ask a question: subject + body handed to the user's own mail app
        // (static page, no server; mailto is the only channel that works everywhere)
        const rm = document.createElement('div');
        rm.id = 'qcReportModal'; rm.className = 'modal-overlay';
        rm.innerHTML =
            '<div class="modal-card" style="max-width:560px">' +
              '<button id="qcReportClose" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">✕</button>' +
              '<h2 class="text-ink text-lg font-bold border-b border-hairline pb-2">Report a Problem or Ask a Question</h2>' +
              '<div class="qc-report-form" id="qcReportForm">' +
                '<label for="qcReportSubject">Subject</label>' +
                '<input type="text" id="qcReportSubject" autocomplete="off" />' +
                '<label for="qcReportBody">Details</label>' +
                '<textarea id="qcReportBody" rows="7"></textarea>' +
                '<div class="qc-report-actions">' +
                  '<span class="qc-report-note">Sends as an email to <b class="text-muted" style="font-weight:600">diegoxiaobarbero@gmail.com</b>. The loaded mission id is attached automatically; your draft is kept here until it is sent.</span>' +
                  '<button id="qcReportSend" type="button" class="qc-ov-btn" style="background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:700">Send</button>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(rm);
        // the redirect notice is its own small overlay STACKED ON TOP of the form (an are you
        // sure step), never replacing it. closing anything keeps the typed draft; only a
        // completed send clears it.
        const rc = document.createElement('div');
        rc.id = 'qcReportConfirm'; rc.className = 'modal-overlay'; rc.style.zIndex = '5100';
        rc.innerHTML =
            '<div class="modal-card" style="max-width:420px">' +
              '<p class="qc-report-confirm-text">Clicking \'Send\' again will open Gmail with your report prefilled, addressed to diegoxiaobarbero@gmail.com. Are you sure you want to do this?</p>' +
              '<div class="qc-report-actions" style="justify-content:flex-end">' +
                '<button id="qcReportBack" type="button" class="qc-ov-btn">Back</button>' +
                // a real link, not a scripted navigation: a genuine user click is never blocked
                '<a id="qcReportGmail" class="qc-ov-btn" href="https://mail.google.com/" target="_blank" rel="noopener" style="background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:700;text-decoration:none;display:inline-block">Send</a>' +
              '</div>' +
            '</div>';
        document.body.appendChild(rc);
        const rcClose = () => { rc.style.display = 'none'; };
        const rmClose = () => { rm.style.display = 'none'; rcClose(); };
        document.getElementById('qcReportClose').addEventListener('click', rmClose);
        rm.addEventListener('click', e => { if (e.target === rm) rmClose(); });
        rc.addEventListener('click', e => { if (e.target === rc) rcClose(); });
        // escape peels one layer at a time: the confirm first, then the form
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if (rc.style.display === 'flex') rcClose();
            else if (rm.style.display === 'flex') rmClose();
        });
        // opening the confirm bakes the draft into every send channel's target. the subject
        // names the tool, so reports are recognizable in the inbox.
        const qcReportDraft = () => {
            const subj = 'AOCQualityControl - ' + ((document.getElementById('qcReportSubject').value || '').trim() || 'feedback');
            const id = (typeof flightMetaData !== 'undefined' && flightMetaData.id && flightMetaData.id !== 'Unknown') ? flightMetaData.id : 'none loaded';
            const meta = '\n\nMission: ' + id + ' · QC Tool';
            return { subj: subj, body: (document.getElementById('qcReportBody').value || '') + meta };
        };
        const qcReportClear = () => {
            document.getElementById('qcReportSubject').value = '';
            document.getElementById('qcReportBody').value = '';
            rmClose();
        };
        document.getElementById('qcReportSend').addEventListener('click', () => {
            const d = qcReportDraft();
            document.getElementById('qcReportGmail').href =
                'https://mail.google.com/mail/?view=cm&fs=1&to=diegoxiaobarbero@gmail.com&su=' + encodeURIComponent(d.subj) + '&body=' + encodeURIComponent(d.body);
            rc.style.display = 'flex';
        });
        document.getElementById('qcReportBack').addEventListener('click', rcClose);
        // gmail composes in a new tab; the delivered draft clears once it is handed over
        document.getElementById('qcReportGmail').addEventListener('click', () => setTimeout(qcReportClear, 80));
        const rb = document.getElementById('reportProblemBtn');
        if (rb) rb.onclick = () => { if (rm.style.display === 'flex') rmClose(); else rm.style.display = 'flex'; };

        document.body.appendChild(app);

        // relocate the reused visualizer subsystems into the QC app (moving a node keeps its wiring):
        //  - the mission loader console (archive search + upload + previously-loaded)
        //  - the 2D/3D map tracker panel (spatial context for the data)
        //  - the top-right controls (theme / help / fullscreen)
        qcRelocate('missionLoadConsole', 'qcLoaderSlot');
        qcRelocate('mapPanel', 'qcMapSlot');
        qcRelocate('topRightControls', 'qcHeadControls');
        // flight library row: the loaded-mission picker and the batch flight-data loader, stacked
        // in the right column above the manual takeoff/landing pins
        const lib = document.createElement('div'); lib.className = 'qc-flight-lib'; lib.id = 'qcFlightLib';
        document.getElementById('qcHeadControls').appendChild(lib);
        qcRelocate('loadedPickerWrap', 'qcFlightLib');
        qcRelocate('preloadBtnWrap', 'qcFlightLib');
        // manual takeoff/landing pins, below the flight library. apply reruns the report with the
        // pinned seconds; auto returns to detection.
        const ovr = document.createElement('div');
        ovr.className = 'qc-phase-override';
        ovr.innerHTML =
            '<span class="qc-ov-field">T/O <input id="qcToInput" class="qc-ov-input" maxlength="6" placeholder="HHMMSS" title="Manual takeoff time (HHMMSS UTC)"></span>' +
            '<span class="qc-ov-field">LND <input id="qcLandInput" class="qc-ov-input" maxlength="6" placeholder="HHMMSS" title="Manual landing time (HHMMSS UTC)"></span>' +
            '<button id="qcPhaseApply" class="qc-ov-btn" title="Recompute with these takeoff and landing times">Apply</button>' +
            '<button id="qcPhaseAuto" class="qc-ov-btn" title="Back to automatic takeoff and landing detection">Auto</button>';
        document.getElementById('qcHeadControls').appendChild(ovr);
        document.getElementById('qcPhaseApply').addEventListener('click', () => {
            const toEl = document.getElementById('qcToInput'), ldEl = document.getElementById('qcLandInput');
            qcApplyManualPhases(toEl.value, ldEl.value, toEl, ldEl);
        });
        document.getElementById('qcPhaseAuto').addEventListener('click', () => {
            if (!qcRawData) return;
            qcOverride = null;
            qcRecomputeReport();
        });

        // relabel the reused map panel for a QC context, and hide the player-only map controls
        const sub = document.querySelector('#qcMapSlot .panel-subhead'); if (sub) sub.textContent = 'Flight Track';

        // everything else of the visualizer stays in the DOM (so its bootstrap never throws) but is
        // covered by the opaque QC app; stop the page behind from scrolling.
        document.documentElement.classList.add('qc-app-on');
        document.body.classList.add('qc-app-on');

        // the map canvas sizes to its container; relocating it changed that container, so nudge the
        // visualizer's resize handling to recompute for the new slot.
        const kick = () => { try { window.dispatchEvent(new Event('resize')); } catch (e) {} };
        setTimeout(kick, 60); setTimeout(kick, 400);

        // the QC app is up and opaque now; drop the boot cover that hid the visualizer during load.
        const cover = document.getElementById('qcBootCover'); if (cover) setTimeout(() => cover.remove(), 80);

        // wire actions
        document.getElementById('qcExportReportBtn').addEventListener('click', qcExportReportCSV);
        document.getElementById('qcGapReportBtn').addEventListener('click', qcExportGapReport);
        document.getElementById('qcExportHtmlBtn').addEventListener('click', () => { if (typeof qcExportInteractiveHTML === 'function') qcExportInteractiveHTML(); });
        document.getElementById('qcErrorSummaryBtn').addEventListener('click', () => { if (typeof qcShowErrorSummary === 'function') qcShowErrorSummary(); });
        document.getElementById('qcTrackPdfBtn').addEventListener('click', () => { if (typeof qcShowTrackPdf === 'function') qcShowTrackPdf(); });
        document.getElementById('qcExportStoreBtn').addEventListener('click', qcShowStatsPicker);
        // share qc link: copies a url that reopens this archive mission in the qc tool at the
        // current playhead, tracker view, and sidebar state. feedback shows in place on the
        // export button; uploaded files have no mission id to share.
        document.getElementById('qcShareLinkBtn').addEventListener('click', async () => {
            const ex = document.getElementById('qcExportMenuBtn');
            const say = msg => { if (!ex) return; ex.textContent = msg; setTimeout(() => { ex.textContent = 'Export ▾'; }, 2200); };
            if (typeof reconArchiveMeta === 'undefined' || !reconArchiveMeta || !qcResult) { say('Archive missions only'); return; }
            let url = '';
            try {
                const u = new URL(window.location.href);
                ['mission', 't', 'view', 'side'].forEach(k => u.searchParams.delete(k));
                u.searchParams.set('mission', reconArchiveMeta.missionId);
                if (qcScrubIdx != null && typeof qcAxisRef !== 'undefined' && qcAxisRef && qcAxisRef[qcScrubIdx] != null)
                    u.searchParams.set('t', qcSecToLabel(qcAxisRef[qcScrubIdx]).replace(/:/g, ''));
                if (typeof trackerModeSelect !== 'undefined') u.searchParams.set('view', trackerModeSelect.value);
                if (app.classList.contains('qc-side-open')) u.searchParams.set('side', '1');
                url = u.toString();
            } catch (e) { return; }
            try { await navigator.clipboard.writeText(url); say('Link copied'); }
            catch (e) { try { history.replaceState(null, '', url); } catch (e2) {} say('Link in address bar'); }
        });
        document.getElementById('qcCmdViewGraph').addEventListener('click', () => qcScrollToVar(document.getElementById('qcCmdVar').value));
        document.getElementById('qcPhaseStatsBtn').addEventListener('click', qcToggleCmdPanel);
        document.getElementById('qcCmdClose').addEventListener('click', () => {
            document.getElementById('qcCmdPanel').classList.add('hidden');
            document.getElementById('qcPhaseStatsBtn').classList.remove('qc-ov-sel');
        });
        document.getElementById('qcCmdVar').addEventListener('change', qcRenderPhaseStats);
        // flight 2D/3D sidebar (map + per-sensor report): hidden by default, toggled on demand. the
        // map canvas needs a resize kick when it becomes visible so it sizes to its slot.
        document.getElementById('qcSideToggle').addEventListener('click', () => {
            const on = app.classList.toggle('qc-side-open');
            document.getElementById('qcSideToggle').classList.toggle('qc-ov-sel', on);
            if (on) setTimeout(() => {
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
                // the player was not driven while hidden; bring the map and clock to the playhead.
                // the playhead may sit before takeoff, the player just shows the takeoff frame.
                try {
                    qcDrivePlayer(true);
                    if (typeof qcSyncPlayhead === 'function') qcSyncPlayhead(true);
                    // the flight loaded while this panel was hidden, so the on-load centering ran
                    // against a zero-size canvas; center on the plane now that the map has a size
                    if (typeof followAircraft2D !== 'undefined' && followAircraft2D
                        && typeof engageFollowAircraft === 'function'
                        && typeof trackerModeSelect !== 'undefined' && trackerModeSelect.value === '2d') engageFollowAircraft();
                } catch (e) {}
            }, 60);
        });
        // export dropdown: opens under the button, closes on pick or on any outside click
        const exMenu = document.getElementById('qcExportMenu'), exBtn = document.getElementById('qcExportMenuBtn');
        exBtn.addEventListener('click', e => { e.stopPropagation(); exMenu.classList.toggle('hidden'); });
        exMenu.querySelectorAll('.qc-menu-item').forEach(b => b.addEventListener('click', () => exMenu.classList.add('hidden')));
        document.addEventListener('click', e => { if (!exMenu.classList.contains('hidden') && !exMenu.contains(e.target) && e.target !== exBtn) exMenu.classList.add('hidden'); });

        // every play start is seeded FROM the playhead through the contract: a playhead parked
        // before takeoff starts playback at row 0 (takeoff), never "x hours in". capture phase, so
        // this runs before the visualizer's own play handler reads currentIdx.
        const realPb = document.getElementById('playPauseBtn');
        if (realPb) realPb.addEventListener('click', () => {
            if (typeof isPlaying !== 'undefined' && !isPlaying && filteredData && filteredData.length) {
                currentIdx = qcPlayheadToRow();   // a pre-takeoff playhead starts playback at takeoff (row 0)
            }
        }, true);

        // play/pause borrows the visualizer engine via its real button; there is no timeslider
        // (the graphs and the arrow keys are the scrubber)
        document.getElementById('qcPlayBtn').addEventListener('click', () => {
            const pb = document.getElementById('playPauseBtn'); if (!pb || pb.disabled) return;
            pb.click();
            document.getElementById('qcPlayBtn').textContent = /pause/i.test(pb.innerText) ? 'Pause' : 'Play';
        });
        // playback speed rides the visualizer's speed engine; one button cycles through its steps
        document.getElementById('qcSpeedBtn').addEventListener('click', () => {
            if (typeof speeds === 'undefined' || typeof currentSpeedIdx === 'undefined') return;
            currentSpeedIdx = (currentSpeedIdx + 1) % speeds.length;
            if (typeof updateSpeedDisplay === 'function') updateSpeedDisplay();
        });

        // graph search: type a variable, sensor, or graph title and jump to its panel
        const gs = document.getElementById('qcGraphSearch'), gr = document.getElementById('qcGraphSearchResults');
        const qcSearchMatches = q => {
            if (!qcResult || !q) return [];
            q = q.toLowerCase();
            const out = [];
            qcResult.families.forEach(f => {
                if (f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q)) out.push({ label: f.label, sub: 'graph', key: f.key, name: null });
                f.members.forEach(m => { if (m.name.toLowerCase().includes(q)) out.push({ label: m.name, sub: f.label, key: f.key, name: m.name }); });
            });
            return out.slice(0, 12);
        };
        const qcSearchJump = (key, name) => {
            if (gr) { gr.classList.add('hidden'); gr.innerHTML = ''; }
            if (gs) gs.value = '';   // the jump happened, the query has done its job
            if (name && typeof qcScrollToVar === 'function') { qcScrollToVar(name); return; }
            const p = document.getElementById('qcpanel_' + key); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        if (gs && gr) {
            gs.addEventListener('input', () => {
                const ms = qcSearchMatches(gs.value.trim());
                if (!ms.length) { gr.classList.add('hidden'); gr.innerHTML = ''; return; }
                gr.innerHTML = ms.map((m, i) => '<button class="qc-menu-item" data-i="' + i + '">' + m.label + ' <span class="qc-search-sub">' + m.sub + '</span></button>').join('');
                gr.classList.remove('hidden');
                gr.querySelectorAll('.qc-menu-item').forEach(b => b.addEventListener('click', () => { const m = ms[parseInt(b.dataset.i, 10)]; qcSearchJump(m.key, m.name); }));
            });
            gs.addEventListener('keydown', e => {
                if (e.key === 'Enter') { const ms = qcSearchMatches(gs.value.trim()); if (ms.length) qcSearchJump(ms[0].key, ms[0].name); }
                if (e.key === 'Escape') gr.classList.add('hidden');
            });
            document.addEventListener('click', e => { if (!gr.contains(e.target) && e.target !== gs) gr.classList.add('hidden'); });
        }

        qcRenderEmpty();
    }

    // move a node by id into a target container by id, if both exist and it is not already there.
    function qcRelocate(srcId, dstId) {
        const src = document.getElementById(srcId), dst = document.getElementById(dstId);
        if (src && dst && src.parentNode !== dst) dst.appendChild(src);
    }

    // ---- phase-statistics command dock ----------------------------------------------------------
    function qcToggleCmdPanel() {
        const p = document.getElementById('qcCmdPanel');
        const show = p.classList.contains('hidden');
        p.classList.toggle('hidden', !show);
        const b = document.getElementById('qcPhaseStatsBtn');
        if (b) b.classList.toggle('qc-ov-sel', show);
        if (show) {
            // the dock pops out right under its button
            if (b) {
                const r = b.getBoundingClientRect(), w = p.offsetWidth || 340;
                p.style.left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - w - 8)) + 'px';
                p.style.top = Math.round(r.bottom + 8) + 'px';
                p.style.right = 'auto'; p.style.bottom = 'auto';
            }
            qcPopulateCmdVars(); qcRenderPhaseStats();
        }
    }

    // find a variable's raw/derived series in the current result (members carry the arrays)
    function qcSeriesByName(name) {
        if (!qcResult) return null;
        for (const fam of qcResult.families) for (const m of fam.members) if (m.name === name && m.series) return m.series;
        return null;
    }

    function qcPopulateCmdVars() {
        const sel = document.getElementById('qcCmdVar'); if (!sel || !qcResult) return;
        const prev = sel.value;
        const names = [];
        qcResult.families.forEach(f => f.members.forEach(m => { if (m.series && names.indexOf(m.name) < 0) names.push(m.name); }));
        sel.innerHTML = names.map(n => '<option value="' + n + '">' + n + '</option>').join('');
        // keep the prior pick, else default to PSM.1 (the script's headline stat), else the first
        sel.value = (names.indexOf(prev) >= 0) ? prev : (names.indexOf('PSM.1') >= 0 ? 'PSM.1' : names[0] || '');
    }

    function qcRenderPhaseStats() {
        const body = document.getElementById('qcCmdBody'), win = document.getElementById('qcCmdWindow');
        if (!body || !qcResult) return;
        const name = document.getElementById('qcCmdVar').value;
        const series = qcSeriesByName(name);
        const ph = qcResult.phases;
        if (win) win.textContent = 'T/O ' + qcSecToLabel(ph.takeoffSec) + '  ·  mid ' + qcSecToLabel(qcResult.timeAxis[ph.midIdx]) + '  ·  land ' + qcSecToLabel(ph.landingSec) + (qcOverride ? '  (manually pinned)' : '  (auto-detected from the flight data)');
        if (!series) { body.innerHTML = '<tr><td colspan="5">no data for ' + name + '</td></tr>'; return; }
        const st = qcPhaseStats(series, ph.toIdx, ph.landIdx, ph.midIdx);
        const f = v => Number.isNaN(v) ? 'n/a' : qcRound(v, 2);
        const row = (label, s) => '<tr><td>' + label + '</td><td>' + f(s.max) + '</td><td>' + f(s.mean) + '</td><td>' + f(s.median) + '</td><td>' + s.n + '</td></tr>';
        body.innerHTML = row('Takeoff', st.takeoff) + row('Mid-flight', st.mid) + row('Landing', st.landing);
    }

    // keep the QC chart playheads + timeline slider in step with the live player. wraps the
    // visualizer's per-frame update so the QC charts, slider, and clock all track the map.
    (function wireQCPlayheadSync() {
        const attach = () => {
            if (typeof updateVisualComponents !== 'function' || updateVisualComponents.__qcWrapped) return false;
            const orig = updateVisualComponents;
            updateVisualComponents = function () {
                const r = orig.apply(this, arguments);
                try {
                    // ACTIVE PLAYBACK is the one thing allowed to move the playhead automatically:
                    // mirror the player's row into the single source of truth so the line follows
                    if (typeof isPlaying !== 'undefined' && isPlaying &&
                        typeof qcScrubIdx !== 'undefined' && qcAxisRef && qcAxisRef.length &&
                        filteredData && filteredData[currentIdx]) {
                        const i = Math.round(filteredData[currentIdx].absSeconds - qcAxisRef[0]);
                        if (i >= 0 && i < qcAxisRef.length) qcScrubIdx = i;
                    }
                    if (typeof qcSyncPlayhead === 'function') qcSyncPlayhead();
                    qcSyncTimeLabel();
                    const pb = document.getElementById('playPauseBtn'), qb = document.getElementById('qcPlayBtn');
                    if (pb && qb) qb.textContent = /pause/i.test(pb.innerText) ? 'Pause' : 'Play';
                } catch (e) {}
                return r;
            };
            updateVisualComponents.__qcWrapped = true;
            return true;
        };
        if (!attach()) {
            document.addEventListener('DOMContentLoaded', () => { attach(); });
            setTimeout(attach, 1500);
        }
    })();

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', qcInitUI); else qcInitUI();
