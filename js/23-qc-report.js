/* QC Mode, report panel + CSV export + cross-flight store + mode controller
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   This owns the QC user surface: the always-on full-page app shell, with a per-sensor
   presence/gap/flag report down the side and the family charts (js/22) filling the
   rest. It also exports the current flight's report as CSV, keeps a cross-flight difference-stats
   store in IndexedDB (replacing the script's N42/N43/N49_Stats.txt files) with its own CSV export,
   and jumps the timeline (tracker, HUD, MMR, charts) to the exact second a sensor broke. */

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
        // the reused map becomes active on load; make sure it is sized to its QC slot
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
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
            const st = document.getElementById('qcSideToggle'); if (st) st.classList.remove('active');
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

    function qcSecToHHMM(sec) { let s = Math.round(sec) % 86400; if (s < 0) s += 86400; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return String(h).padStart(2, '0') + String(m).padStart(2, '0'); }

    function qcBuildReportTable() {
        const rep = document.getElementById('qcReportPanel'); if (!rep) return;
        let html = '';
        // recorder-level gaps first, reported once and phrased exactly like the archive's
        // GapReport.dat ("Data gap from HH:MM:SS - HH:MM:SS"): seconds where NO channel has data
        // are the data system's event, and blaming every sensor for them was pure noise.
        if (qcResult.recordingGaps && qcResult.recordingGaps.length) {
            const rg = qcResult.recordingGaps;
            html += '<div class="qc-recording" title="Seconds where no instrument recorded at all: a data-system event, not any one sensor. Same events the archive GapReport.dat documents.">' +
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
                if (m.lateStart) detail += (detail ? ' · ' : '') + 'started late by ' + m.lateStart.secs.toLocaleString() + ' s';
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
        body.innerHTML = rows.map(r =>
            '<div class="qc-row' + (kind === 'gap' ? ' qc-row-jump" data-jump="' + Math.round(r.m.gaps[0].from)
                : kind === 'check' ? ' qc-row-jump" data-jump="' + Math.round(qcResult.timeAxis[r.m.checks[0].fromIdx]) : '') + '">' +
            '<span class="qc-row-name">' + r.m.name + (r.m.isRef ? ' <em>ref</em>' : '') + (r.m.isDerived ? ' <em>(deriv.)</em>' : '') + '</span>' +
            '<span class="qc-row-detail">' + r.fam.label + ' · ' + r.detail + '</span></div>'
        ).join('') || '<div class="qc-empty">None.</div>';
        body.querySelectorAll('.qc-row-jump').forEach(row => row.addEventListener('click', () => { modal.style.display = 'none'; qcJumpToSecond(parseInt(row.dataset.jump, 10)); }));
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
        // the click wins over the context: a jump aimed OUTSIDE the takeoff..landing window (a
        // pre-takeoff gap, say) would be clamped while the sidebar player is open, so the sidebar
        // minimizes itself and the playhead goes exactly where the user clicked
        if (typeof qcPhaseMarks !== 'undefined' && qcPhaseMarks && (ai < qcPhaseMarks.toIdx || ai > qcPhaseMarks.landIdx)) {
            const qapp = document.getElementById('qcApp');
            if (qapp && qapp.classList.contains('qc-side-open')) {
                const st = document.getElementById('qcSideToggle');
                if (st) st.click(); else qapp.classList.remove('qc-side-open');
            }
        }
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
        const rows = [['mission', 'aircraft', 'family', 'sensor', 'is_ref', 'presence', 'samples_s', 'gaps', 'missing_s', 'late_start_s', 'early_stop_s', 'max_diff']];
        qcResult.families.forEach(fam => fam.members.forEach(m => {
            const missing = m.gaps.reduce((a, g) => a + (g.effSecs || g.secs), 0);
            rows.push([flightMetaData.id, qcResult.aircraft, fam.key, m.name, m.isRef ? 1 : 0, m.presence, m.count, m.gaps.length, missing, m.lateStart ? m.lateStart.secs : '', m.earlyStop ? m.earlyStop.secs : '', '']);
        }));
        // recorder-level gaps, one row each (sensor column marks them as the data system's)
        (qcResult.recordingGaps || []).forEach(g => rows.push([flightMetaData.id, qcResult.aircraft, '', 'recording', '', 'recording-gap', '', '', g.secs, '', '', '']));
        // per-pair max differences as extra rows, in their own labeled column
        qcResult.families.forEach(fam => fam.diffs.forEach(d => { if (d.series) rows.push([flightMetaData.id, qcResult.aircraft, fam.key, 'diff:' + d.id, '', 'diff', '', '', '', '', '', d.max]); }));
        qcDownloadCSV(rows, (flightMetaData.id || 'flight') + '_QC_report.csv');
    }

    // scroll the chart column to the family panel that carries a given variable, with a brief
    // highlight so the eye lands on the right graph (used by Phase Stats "View graph")
    function qcScrollToVar(name) {
        if (!qcResult || !name) return;
        const fam = qcResult.families.find(f => f.members.some(m => m.name === name));
        if (!fam) return;
        const panel = document.getElementById('qcpanel_' + fam.key); if (!panel) return;
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
            if (m.lateStart) lines.push(m.name + ' started late by ' + m.lateStart.secs + ' s');
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
    async function qcExportStoreCSV() {
        const all = await qcStoreAll();
        if (!all.length) return;   // nothing saved yet (rows are auto-saved on each flight load)
        // one file per airframe, byte for byte like the script's N42/N43/N49_Stats.txt: headerless
        // comma separated lines, one per flight, in the script's exact column order, so a download
        // can be appended straight onto a user's historical stats file. airframes with no stored
        // flights produce no file; rows saved by older builds (no scriptLine) regenerate when that
        // flight is reopened.
        const tails = { H: 'N42', I: 'N43', N: 'N49' };
        Object.keys(tails).forEach(letter => {
            const lines = all.filter(r => r.aircraft === letter && r.scriptLine)
                .sort((a, b) => String(a.missionId).localeCompare(String(b.missionId)))
                .map(r => r.scriptLine);
            if (!lines.length) return;
            const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = tails[letter] + '_Stats.txt'; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        });
    }

    // ---- QC clock (there is no timeslider: graphs and arrow keys are the scrubber) --------------
    // kept as a shim; older call sites just refresh the clock now
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
                '<button id="qcPhaseStatsBtn" class="qc-ov-btn" title="Takeoff / mid-flight / landing max, mean, median for a variable (the script\'s PSM statement, for any sensor)">Max/Mean/Median</button>' +
                '<button id="qcSideToggle" class="qc-ov-btn" title="Show or hide the 2D/3D flight-track map and per-sensor report sidebar">Flight 2D/3D</button>' +
                '<div class="qc-vdiv qc-vdiv-sm"></div>' +
                '<div class="qc-export-wrap">' +
                  '<button id="qcExportMenuBtn" class="qc-ov-btn" title="Download reports and stats">Export ▾</button>' +
                  '<div id="qcExportMenu" class="qc-menu hidden">' +
                    '<button class="qc-menu-item" id="qcExportReportBtn" title="This flight\'s per-sensor QC report">Indiv. Sensor Report CSV</button>' +
                    '<button class="qc-menu-item" id="qcGapReportBtn" title="Recording gaps in the archive GapReport.dat format">Gap Report (.dat)</button>' +
                    '<button class="qc-menu-item" id="qcExportStoreBtn" title="Downloads N42/N43/N49_Stats.txt in the script\'s exact format: headerless comma separated lines, one per flight, appendable straight onto your historical stats files. Every loaded flight saves automatically.">N42/3/9 Stats CSV</button>' +
                    '<button class="qc-menu-item" id="qcShareLinkBtn" title="Copy a link that reopens this mission in the QC tool at your current playhead, tracker view, and sidebar state (archive missions only)">Share QC Link</button>' +
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
            '<div class="modal-card" style="max-width:760px;max-height:88vh;overflow-y:auto">' +
              '<button id="qcHelpClose" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">✕</button>' +
              '<div class="border-b border-hairline pr-8" style="padding-bottom:10px;">' +
                '<h2 class="text-ink text-lg font-bold">Help &amp; Feature Guide</h2>' +
                '<p class="text-[11px] text-muted mt-1 leading-snug">Built for the NOAA Aircraft Operations Center &middot; Science Branch. Based on the qc_plots_with_map_v2.py workflow, automated into one tool.</p>' +
              '</div>' +
              '<div class="help-body">' +
                '<p class="help-lead">The QC Tool grades every sensor on a hurricane-hunter flight: it loads the raw flight-level data on a continuous 1-second axis, separates recorder gaps from per-sensor gaps, flags physically implausible values, reproduces the script\'s statistics, and exports the same reports the archive workflow expects. It runs entirely in your browser.</p>' +

                '<h3>Keyboard shortcuts</h3>' +
                '<ul>' +
                  '<li><kbd>Space</kbd> plays or pauses.</li>' +
                  '<li><kbd>Left</kbd> / <kbd>Right</kbd> arrows step the playhead 1 second, and holding <kbd>Shift</kbd> steps 10 seconds.</li>' +
                  '<li><kbd>Ctrl</kbd> + <kbd>Z</kbd> (<kbd>Cmd</kbd> + <kbd>Z</kbd> on Mac) steps one zoom back on the graph under the cursor.</li>' +
                  '<li><kbd>Esc</kbd> closes any open modal or panel.</li>' +
                '</ul>' +

                '<h3>1. Loading a mission</h3>' +
                '<ul>' +
                  '<li><b>Archive browser (needs API online):</b> type in the search box to find a mission by id, storm name, or date (YY-MM-DD), or pick <b>Year</b>, <b>Storm</b>, and <b>Flight</b>, then click <b>Load Flight + Storm Track</b>.</li>' +
                  '<li><b>Manual upload (always works, no internet):</b> drop a <b>.txt</b> or <b>.nc</b> file on the "or upload" zone. When the API is offline the archive greys out with an "API Offline" banner and recovers on its own.</li>' +
                  '<li><b>Already loaded missions:</b> every flight you load or preload is stored in your browser and reopens instantly, newest first. The red &times; on a row removes that flight from this device. The store keeps the 40 most recent missions.</li>' +
                  '<li><b>Pre-load Flight Data:</b> queue any season\'s missions for download; progress shows right under the button, and the flights survive page reloads.</li>' +
                '</ul>' +

                '<h3>2. Reading a graph</h3>' +
                '<ul>' +
                  '<li><b>Gaps:</b> yellow shading marks missing data, and every gap gets a caret on top (the caret grows to the gap\'s width; the legend row defines the marker once). Click a caret to jump to the exact second the gap starts, or hover the shading for its window. One second gaps draw as thin lines until you zoom in.</li>' +
                  '<li><b>Check regions:</b> red shading and red carets mark implausible sensor values. The Check warning occurs when the algorithm detects an erroneous and unusual value. Users should manually check when this happened in the context of the flight (eyewall penetration, etc.), to see if the value could be valid or totally unwarranted in its context (ex. a 20 m/s vertical wind while at cruise altitude with no visible effect on the plane would be more incorrect than a 20 m/s vertical wind in the eyewall of Hurricane Melissa). Current rules: humidity above 200 percent, a wind change of 100 m/s in under 15 seconds, vertical wind beyond 40 m/s, and a latitude or longitude change of more than 5 degrees within 30 minutes (no airframe here covers that distance so fast).</li>' +
                  '<li><b>Marks:</b> dotted vertical lines are the auto detected takeoff and landing; the solid line is the playhead. NO DATA appears in place when a family has nothing to plot.</li>' +
                  '<li><b>Hover:</b> the tooltip picks the point nearest the cursor in both axes, so aiming up at a spike grabs the spike. The picked sensor leads in bold; every other visible sensor\'s exact value at that second follows below.</li>' +
                '</ul>' +

                '<h3>3. Variables and the legend</h3>' +
                '<ul>' +
                  '<li>Each graph lists one checkbox per variable; click to select or unselect it.</li>' +
                  '<li><b>Group chips (glowing blue):</b> when a family mixes sensor kinds (direct vs GPS), each glowing chip carries its own variables beside it, and picking one group unselects the other.</li>' +
                  '<li><b>Standard deviation:</b> always listed at the bottom right of each graph block: the whole-flight mean sigma between the selected similar sensors, plus the worst disagreement and when it happened. Families with a single sensor list nothing.</li>' +
                  '<li><b>Ref linkage:</b> a pipe connector beside the ref variable chains it to every sensor it rode during the flight, in order; more than one name means the operators switched the ref mid-flight, and a red badge in the graph title calls that out too. Hover the ref entry for the takeover times.</li>' +
                '</ul>' +

                '<h3>4. Tools, zoom, and pan</h3>' +
                '<ul>' +
                  '<li><b>Toolbar:</b> scrub (drag anywhere and the playhead follows), pan (drag the window, vertically too), and select zoom (drag a box).</li>' +
                  '<li>The wheel zooms the time axis. <b>Reset Zoom</b> appears at the bottom right of a zoomed graph and returns to the default view; double click does the same.</li>' +
                  '<li>The top right of each graph holds <b>save as PNG</b> and <b>fullscreen</b>.</li>' +
                  '<li><b>Graph search</b> (status bar, far left): type a variable, sensor, or graph title and jump straight to its panel.</li>' +
                '</ul>' +

                '<h3>5. Issues, pills, and chips</h3>' +
                '<ul>' +
                  '<li><b>Summary pills:</b> Check (red, leads when present), OK, gaps, and no data. Click a pill to list exactly those sensors and jump to their first issue.</li>' +
                  '<li><b>Chip strip:</b> under each graph title, Check chips come first, then gaps, no data, and the late start / early stop notes. Click any chip to jump the map and timeline there.</li>' +
                  '<li><b>+N more</b> expands the full list in place (the toggle stays put), and the color coded totals pill counts every kind so nobody scrolls a thousand chips.</li>' +
                  '<li>Late starts and early stops are reported but never counted as gaps, since warm up on the ramp is normal ops.</li>' +
                '</ul>' +

                '<h3>6. Statistics</h3>' +
                '<ul>' +
                  '<li><b>Max/Mean/Median</b> opens the phase statistics dock: takeoff, mid-flight, and landing max, mean, and median for any variable (the script\'s PSM line); View graph scrolls to its panel.</li>' +
                  '<li><b>Difference Between Sensors</b> (with the small + graph chip) opens the family\'s difference graph: every combination within a sensor group is plotted, each combination\'s <b>Max Diff</b> is listed under the graph, and clicking a pair views it alone. Cross group pairs sit on their own legend row, selectable for curiosity\'s sake. The <b>Flight Context</b> button pulls the 2D/3D map up beside the graph so you can see where a difference occurred.</li>' +
                '</ul>' +

                '<h3>7. Flight track and playback</h3>' +
                '<ul>' +
                  '<li><b>Flight 2D/3D</b> opens the sidebar: the 2D/3D map tracker, the per-sensor report, <b>Play</b>, the playback speed, and the flight clock.</li>' +
                  '<li>The 2D map starts centered on the aircraft and follows it. Pan away and <b>Recenter on Aircraft</b> appears. The wheel zooms and dragging pans.</li>' +
                  '<li>Scrub from any graph, the arrow keys, or the play button; every surface follows the same playhead.</li>' +
                '</ul>' +

                '<h3>8. Exports and feedback</h3>' +
                '<ul>' +
                  '<li><b>Indiv. Sensor Report CSV:</b> one row per sensor (presence, gaps, missing seconds, late start, early stop) plus each pair\'s max difference in its own column.</li>' +
                  '<li><b>Gap Report (.dat):</b> recorder-level gaps in the archive\'s GapReport.dat wording.</li>' +
                  '<li><b>N42/3/9 Stats:</b> downloads N42/N43/N49_Stats.txt in the script\'s exact format (headerless comma separated lines, one per flight, same column order), so a download appends straight onto your historical stats files. Every loaded flight saves automatically.</li>' +
                  '<li><b>Share QC Link:</b> copies a link that reopens this archive mission in the QC tool for anyone, at your current playhead, tracker view, and sidebar state.</li>' +
                  '<li><b>Feedback:</b> the exclamation button opens a report form addressed to diegoxiaobarbero@gmail.com, with the mission id attached and the tool named in the subject. Send redirects to Gmail with everything prefilled. Your draft stays in the form until it is sent.</li>' +
                '</ul>' +
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
                  '<span class="qc-report-note">The loaded mission id is attached automatically. Your draft is kept here until it is sent.</span>' +
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
              '<p class="qc-report-confirm-text">Clicking \'Send\' again will redirect you to GMail, are you sure you want to do this?</p>' +
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
            if (rc.style.display === 'flex') rcClose(); else rmClose();
        });
        // opening the confirm bakes the draft into every send channel's target. the subject
        // names the tool, so reports are recognizable in the inbox.
        const qcReportDraft = () => {
            const subj = 'AOCQualityControl - ' + ((document.getElementById('qcReportSubject').value || '').trim() || 'feedback');
            const meta = '\n\nMission: ' + ((typeof flightMetaData !== 'undefined' && flightMetaData.id) || 'none loaded') + ' · QC Tool';
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
        // the flight library controls live under the QC Tool title, with the season preloader
        // (download whole seasons to this device) right beside them
        qcRelocate('loadedPickerWrap', 'qcBrandActions');
        qcRelocate('preloadBtnWrap', 'qcBrandActions');

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
        document.getElementById('qcExportStoreBtn').addEventListener('click', qcExportStoreCSV);
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
        document.getElementById('qcCmdClose').addEventListener('click', () => document.getElementById('qcCmdPanel').classList.add('hidden'));
        document.getElementById('qcCmdVar').addEventListener('change', qcRenderPhaseStats);
        // flight 2D/3D sidebar (map + per-sensor report): hidden by default, toggled on demand. the
        // map canvas needs a resize kick when it becomes visible so it sizes to its slot.
        document.getElementById('qcSideToggle').addEventListener('click', () => {
            const on = app.classList.toggle('qc-side-open');
            document.getElementById('qcSideToggle').classList.toggle('active', on);
            if (on) setTimeout(() => {
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
                // the player was not driven while hidden; pull a free-roaming playhead back into
                // the player's window and bring the map and clock to position
                try {
                    if (typeof qcScrubIdx !== 'undefined' && qcScrubIdx != null && typeof qcClampScrub === 'function') qcScrubIdx = qcClampScrub(qcScrubIdx);
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
                if (typeof qcClampScrub === 'function' && typeof qcScrubIdx !== 'undefined' && qcScrubIdx != null) qcScrubIdx = qcClampScrub(qcScrubIdx);
                currentIdx = qcPlayheadToRow();
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
        if (show) { qcPopulateCmdVars(); qcRenderPhaseStats(); }
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
        if (win) win.textContent = 'T/O ' + qcSecToLabel(ph.takeoffSec) + '  ·  mid ' + qcSecToLabel(qcResult.timeAxis[ph.midIdx]) + '  ·  land ' + qcSecToLabel(ph.landingSec) + '  (auto-detected from the flight data)';
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
