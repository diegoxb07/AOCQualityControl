/* QC Mode, report panel + CSV export + cross-flight store + mode controller
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   This owns the QC user surface: a full-page overlay (opened from the QC button in #topRightControls)
   with a per-sensor presence/gap/flag report down the side and the family charts (js/22) filling the
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

    // ---- QC app is the primary, always-on view (not a dismissible overlay) -----------------------
    function qcRenderEmpty() {
        const rep = document.getElementById('qcReportPanel'), ch = document.getElementById('qcChartsPanel');
        if (rep) rep.innerHTML = '<div class="qc-empty">No flight loaded.</div>';
        if (ch) ch.innerHTML = '';
        const nm = document.getElementById('qcMissionName'); if (nm) nm.textContent = '';
        const sp = document.getElementById('qcSummaryPills'); if (sp) sp.innerHTML = '';
    }

    const QC_PILL = { ok: 'ok', gap: 'gap', nodata: 'nodata' };
    function qcPill(kind, label) { return '<span class="qc-pill qc-pill-' + kind + '" data-kind="' + kind + '">' + label + '</span>'; }

    function qcRenderReport() {
        if (!qcResult) { qcRenderEmpty(); return; }
        const s = qcResult.summary;
        const nm = document.getElementById('qcMissionName');
        if (nm) nm.textContent = (flightMetaData.id || 'flight') + '  ·  ' + qcAircraftLabel(qcResult.aircraft);
        const sp = document.getElementById('qcSummaryPills');
        if (sp) {
            const noun = n => n === 1 ? ' sensor' : ' sensors';
            sp.innerHTML = qcPill('ok', s.ok + noun(s.ok) + ' OK') +
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
                if (m.lateStart) detail += (detail ? ' · ' : '') + 'started late by ' + m.lateStart.secs.toLocaleString() + ' s';
                if (m.earlyStop) detail += (detail ? ' · ' : '') + 'stopped early by ' + m.earlyStop.secs.toLocaleString() + ' s';
                // clicking a gap jumps the timeline + map to where it starts
                const jump = m.gaps.length ? ' data-jump="' + Math.round(m.gaps[0].from) + '"' : '';
                html += '<div class="qc-row' + (jump ? ' qc-row-jump' : '') + '"' + jump + '>' +
                    qcPill(kind, m.presence === 'nodata' ? 'NO DATA' : m.presence.toUpperCase()) +
                    '<span class="qc-row-name">' + m.name + (m.isRef ? ' <em>ref</em>' : '') + (m.isDerived ? ' <em>(deriv.)</em>' : '') + '</span>' +
                    '<span class="qc-row-detail">' + detail + '</span></div>';
            });
            // difference means, the script's per-plot Avg Diff
            fam.diffs.forEach(d => {
                if (d.series) html += '<div class="qc-row qc-row-diff"><span class="qc-row-name">' + d.id + '</span><span class="qc-row-detail">Avg Diff: ' + (Number.isNaN(d.mean) ? 'n/a' : d.mean) + '</span></div>';
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
        if (!app || !app.classList.contains('qc-side-open')) return;
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
            else if (kind === 'ok') detail = m.count.toLocaleString() + ' s';
            else detail = 'absent from this file';
            rows.push({ fam: fam, m: m, detail: detail });
        }));
        const noun = 'sensor' + (rows.length === 1 ? '' : 's');
        document.getElementById('qcStatusModalTitle').textContent =
            kind === 'gap' ? rows.length + ' ' + noun + ' with in-flight gap' + (rows.length === 1 ? '' : 's')
            : kind === 'nodata' ? rows.length + ' ' + noun + ' with no data'
            : rows.length + ' ' + noun + ' OK';
        const body = document.getElementById('qcStatusModalBody');
        body.innerHTML = rows.map(r =>
            '<div class="qc-row' + (kind === 'gap' ? ' qc-row-jump" data-jump="' + Math.round(r.m.gaps[0].from) : '') + '">' +
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
        const rows = [['mission', 'aircraft', 'family', 'sensor', 'is_ref', 'presence', 'samples_s', 'gaps', 'missing_s', 'late_start_s', 'early_stop_s']];
        qcResult.families.forEach(fam => fam.members.forEach(m => {
            const missing = m.gaps.reduce((a, g) => a + (g.effSecs || g.secs), 0);
            rows.push([flightMetaData.id, qcResult.aircraft, fam.key, m.name, m.isRef ? 1 : 0, m.presence, m.count, m.gaps.length, missing, m.lateStart ? m.lateStart.secs : '', m.earlyStop ? m.earlyStop.secs : '']);
        }));
        // recorder-level gaps, one row each (sensor column marks them as the data system's)
        (qcResult.recordingGaps || []).forEach(g => rows.push([flightMetaData.id, qcResult.aircraft, '', 'recording', '', 'recording-gap', '', '', g.secs, '']));
        // difference means as extra rows
        qcResult.families.forEach(fam => fam.diffs.forEach(d => { if (d.series) rows.push([flightMetaData.id, qcResult.aircraft, fam.key, 'diff:' + d.id, '', 'diff', '', '', '', '', d.mean]); }));
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

    // one self-contained HTML file: header, recording gaps, the per-sensor table, and every graph
    // as an embedded image. no external references, so it mails and archives cleanly.
    function qcExportHtmlReport() {
        if (!qcResult) return;
        const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const id = flightMetaData.id || 'flight';
        const s = qcResult.summary;
        // graphs snapshot with the page's current background so theme-colored ticks stay readable
        const chartBg = getComputedStyle(document.body).backgroundColor || '#17181a';
        const parts = [];
        parts.push('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(id) + ' QC Report</title><style>' +
            'body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:24px;color:#1a202c;background:#fff;max-width:1650px}' +
            'h1{font-size:20px}h2{font-size:15px;margin:26px 0 4px}img{max-width:100%;background:' + chartBg + ';border:1px solid #d7dce3;border-radius:6px;margin:4px 0}' +
            'table{border-collapse:collapse;font-size:12px;margin:10px 0}td,th{border:1px solid #d7dce3;padding:3px 8px;text-align:left}' +
            '.meta{color:#5a6472;font-size:12px}.gap{color:#9a6700}.nodata{color:#8a919b}.ok{color:#1a7f37}</style></head><body>');
        parts.push('<h1>' + esc(id) + ' QC Report</h1>');
        parts.push('<p class="meta">' + esc(flightMetaData.aircraft) + ' · ' + esc(flightMetaData.date) +
            ' · generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z · ' +
            s.ok + ' ok, ' + s.gap + ' gap' + (s.gap === 1 ? '' : 's') + ', ' + s.nodata + ' no data · T/O ' +
            qcSecToLabel(qcResult.phases.takeoffSec) + ' · Land ' + qcSecToLabel(qcResult.phases.landingSec) + '</p>');
        (qcResult.recordingGaps || []).forEach(g => parts.push('<p class="gap">Data gap from ' + qcSecToLabel(g.from) + ' - ' + qcSecToLabel(g.to) + '</p>'));
        parts.push('<table><tr><th>Status</th><th>Sensor</th><th>Family</th><th>Detail</th></tr>');
        qcResult.families.forEach(fam => fam.members.forEach(m => {
            const gapSecs = m.gaps.reduce((a, g) => a + (g.effSecs || g.secs), 0);
            let detail = m.presence === 'gap' ? gapSecs + ' s missing, ' + m.gaps.length + ' gap' + (m.gaps.length > 1 ? 's' : '')
                : m.presence === 'ok' ? m.count + ' s' : 'absent';
            if (m.lateStart) detail += ' · started late by ' + m.lateStart.secs + ' s';
            if (m.earlyStop) detail += ' · stopped early by ' + m.earlyStop.secs + ' s';
            parts.push('<tr><td class="' + m.presence + '">' + m.presence.toUpperCase() + '</td><td>' + esc(m.name) +
                (m.isRef ? ' (ref)' : '') + (m.isDerived ? ' (deriv.)' : '') + '</td><td>' + esc(fam.label) + '</td><td>' + esc(detail) + '</td></tr>');
        }));
        parts.push('</table>');
        qcResult.families.forEach(fam => {
            const main = qcCharts['qc_' + fam.key];
            let diff = qcCharts['qc_' + fam.key + '_d'];   // present only while the diff modal is open
            const hasDiffData = fam.diffs && fam.diffs.some(d => d.series);
            if (!main && !diff && !hasDiffData) return;
            parts.push('<h2>' + esc(fam.label) + ' (' + esc(typeof qcUnitLabel === 'function' ? qcUnitLabel(fam.unit) : fam.unit) + ')</h2>');
            try { if (main) parts.push('<img src="' + main.toBase64Image() + '">'); } catch (e) {}
            if (diff) { try { parts.push('<img src="' + diff.toBase64Image() + '">'); } catch (e) {} }
            else if (hasDiffData && typeof qcBuildDiffChart === 'function') {
                // diff graphs live in a modal now; render one offscreen just for the report
                const holder = document.createElement('div');
                holder.style.cssText = 'position:fixed;left:-2200px;top:0;width:1400px;height:300px;';
                const cv = document.createElement('canvas'); holder.appendChild(cv);
                document.body.appendChild(holder);
                try { const tmp = qcBuildDiffChart(cv, fam, fam); parts.push('<img src="' + tmp.toBase64Image() + '">'); tmp.destroy(); } catch (e) {}
                holder.remove();
            }
        });
        parts.push('</body></html>');
        const blob = new Blob([parts.join('\n')], { type: 'text/html' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = id.slice(0, 10) + '_QC_Report.html'; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
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
        a.download = ((flightMetaData.id || 'flight').slice(0, 10)) + '_GapReport.dat'; a.click();
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
        // union of all keys across rows so airframes with different families still line up
        const keys = []; const seen = new Set();
        ['missionId', 'aircraft', 'date'].forEach(k => { keys.push(k); seen.add(k); });
        all.forEach(r => Object.keys(r).forEach(k => { if (!seen.has(k)) { seen.add(k); keys.push(k); } }));
        const rows = [keys]; all.forEach(r => rows.push(keys.map(k => r[k])));
        qcDownloadCSV(rows, 'AOC_QC_cross_flight_stats.csv');
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
              '<div class="qc-brand">' +
                '<img src="assets/noaa-emblem-72.png" alt="NOAA emblem" class="qc-brand-logo">' +
                '<div class="qc-vdiv"></div>' +
                '<div class="qc-brand-col">' +
                  '<span class="qc-brand-txt">QC Tool<small>Aircraft Operations Center · Flight-Level Data Quality Control</small></span>' +
                  '<div class="qc-brand-actions" id="qcBrandActions"></div>' +
                '</div>' +
              '</div>' +
              '<div class="qc-vdiv"></div>' +
              '<div class="qc-loader-slot" id="qcLoaderSlot"></div>' +
              '<div class="qc-head-controls" id="qcHeadControls"></div>' +
            '</header>' +
            '<div class="qc-actionbar">' +
              '<div class="qc-ov-title" id="qcMissionName"></div>' +
              '<div class="qc-summary" id="qcSummaryPills"></div>' +
              '<div class="qc-ov-actions">' +
                '<button id="qcPhaseStatsBtn" class="qc-ov-btn" title="Takeoff / mid-flight / landing max, mean, median for a variable (the script\'s PSM statement, for any sensor)">Max/Mean/Median</button>' +
                '<button id="qcSideToggle" class="qc-ov-btn" title="Show or hide the 2D/3D flight-track map and per-sensor report sidebar">Flight 2D/3D</button>' +
                '<div class="qc-vdiv qc-vdiv-sm"></div>' +
                '<div class="qc-export-wrap">' +
                  '<button id="qcExportMenuBtn" class="qc-ov-btn" title="Download reports and stats">Export ▾</button>' +
                  '<div id="qcExportMenu" class="qc-menu hidden">' +
                    '<button class="qc-menu-item" id="qcExportReportBtn" title="This flight\'s per-sensor QC report">Report CSV</button>' +
                    '<button class="qc-menu-item" id="qcGapReportBtn" title="Recording gaps in the archive GapReport.dat format">Gap Report (.dat)</button>' +
                    '<button class="qc-menu-item" id="qcExportStoreBtn" title="The cross-flight stats store. Every loaded flight is saved automatically (replaces N42/N43/N49_Stats.txt)">Cross-flight CSV</button>' +
                    '<button class="qc-menu-item" id="qcHtmlReportBtn" title="The whole QC session (report and every graph) as one self-contained file">HTML Report</button>' +
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

        document.body.appendChild(app);

        // relocate the reused visualizer subsystems into the QC app (moving a node keeps its wiring):
        //  - the mission loader console (archive search + upload + previously-loaded)
        //  - the 2D/3D map tracker panel (spatial context for the data)
        //  - the top-right controls (theme / help / fullscreen)
        qcRelocate('missionLoadConsole', 'qcLoaderSlot');
        qcRelocate('mapPanel', 'qcMapSlot');
        qcRelocate('topRightControls', 'qcHeadControls');
        // the flight library controls live under the QC Tool title
        qcRelocate('loadedPickerWrap', 'qcBrandActions');

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
        document.getElementById('qcHtmlReportBtn').addEventListener('click', qcExportHtmlReport);
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
