/* Mission Visualizer, cross-flight metric search
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Scans every loaded/preloaded flight (or a chosen subset) for the highest or lowest value of one
   metric at any point, ranks them, and reports each flight's peak with its time, altitude, and
   position plus an overlaid comparison graph. Rows come straight from the preloadedMissions store
   (hydrating IndexedDB stubs on demand); the active-flight globals are never touched, so a search
   leaves the open flight untouched. Groundwork for the planned QC mode, which will compare sensors
   across flights the same way. */
(function flightSearch() {
    // Per-flight line colors for the comparison graph (the rank-1 flight is drawn boldest).
    const FS_PALETTE = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#34d399', '#fb7185', '#60a5fa', '#f97316', '#2dd4bf'];
    const DASH = 'n/a';   // no-value placeholder (name kept, the dash glyph is not used here)

    let fsChartInstance = null;
    let fsFlights = [];        // metadata-only descriptors, rebuilt each time the modal opens
    let cameFromSearch = false; // set while the preload modal is opened from here, to return on close

    const $ = (id) => document.getElementById(id);
    const isImperial = () => { const el = $('toggleSI'); return !(el && el.checked); };
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function fsLabel(id, rec) {
        const m = (rec && rec.mission) || {};
        const bits = [m.mission_id || id];
        if (m.storm_name) bits.push(m.storm_name);
        return bits.join(' · ');
    }

    // Metadata list of everything searchable: the multi-flight store plus the currently open flight.
    // Full rows are pulled lazily at scan time (fsGetRows). Deduped by the 10-char mission id
    // (YYYYMMDD + plane + flight number): the store keys by mission id but a manual/archive load
    // derives flightMetaData.id from the FILENAME (e.g. 20250829H2_A), so a plain id compare would
    // list the same flight twice. When both exist, the open flight (live rows) wins.
    const fsMissionKey = id => String(id || '').slice(0, 10).toUpperCase();
    function fsSearchableFlights() {
        const out = new Map();
        if (typeof preloadedMissions !== 'undefined' && preloadedMissions && preloadedMissions.forEach) {
            preloadedMissions.forEach((rec, id) => {
                out.set(fsMissionKey(id), {
                    id,
                    label: fsLabel(id, rec),
                    preview: (rec.isNc === false && !rec.uploaded),
                    rows: (rec.parsed && rec.parsed.rows) || null
                });
            });
        }
        if (typeof allParsedData !== 'undefined' && allParsedData && allParsedData.length &&
            typeof flightMetaData !== 'undefined' && flightMetaData && flightMetaData.id) {
            out.set(fsMissionKey(flightMetaData.id), {
                id: flightMetaData.id,
                label: fsLabel(flightMetaData.id, { mission: { mission_id: flightMetaData.id } }) + ' (open)',
                preview: false,
                rows: allParsedData
            });
        }
        return [...out.values()];
    }

    // Rows for one flight: in-memory if present, else hydrated from IndexedDB (reload leaves stubs
    // with no parsed rows until opened). Returns null if the record has no readable rows.
    async function fsGetRows(t) {
        if (t.rows && t.rows.length) return t.rows;
        try {
            const rec = (typeof preloadedMissions !== 'undefined' && preloadedMissions) ? preloadedMissions.get(t.id) : null;
            if (rec && rec.parsed && rec.parsed.rows) { t.rows = rec.parsed.rows; return t.rows; }
            if (typeof missionIdbGet === 'function') {
                const full = await missionIdbGet(t.id);
                if (full && full.parsed && full.parsed.rows) { t.rows = full.parsed.rows; return t.rows; }
            }
        } catch (e) { /* unreadable record */ }
        return null;
    }

    function firstValidAbs(rows, key) {
        for (const r of rows) { if (r[key] != null && !isNaN(r[key]) && r.absSeconds != null) return r.absSeconds; }
        return null;
    }

    // Full-resolution superlative: raw (SI) row value, so ranking is unit-independent.
    function findPeak(rows, key, mode) {
        let best = null, bestRow = null;
        for (const r of rows) {
            const v = r[key];
            if (v == null || isNaN(v)) continue;
            if (best === null || (mode === 'max' ? v > best : v < best)) { best = v; bestRow = r; }
        }
        return bestRow ? { value: best, row: bestRow } : null;
    }

    // Down-sampled {x:elapsedMin, y:displayValue} series for the comparison graph (peaks are found
    // on the full-resolution rows separately, so thinning the line never moves a reported peak).
    function fsLine(rows, key, t0, isImp) {
        const pts = [];
        const valid = rows.filter((r) => r[key] != null && !isNaN(r[key]) && r.absSeconds != null);
        if (!valid.length) return pts;
        const stride = Math.max(1, Math.ceil(valid.length / 600));
        for (let i = 0; i < valid.length; i += stride) {
            const r = valid[i];
            pts.push({ x: (r.absSeconds - t0) / 60, y: getConvertedVal(r[key], key, isImp) });
        }
        const last = valid[valid.length - 1];
        pts.push({ x: (last.absSeconds - t0) / 60, y: getConvertedVal(last[key], key, isImp) });
        return pts;
    }

    function fmtVal(rawVal, key, isImp) {
        const v = getConvertedVal(rawVal, key, isImp);
        if (v == null || isNaN(v)) return DASH;
        return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1);
    }
    function fmtTime(row) { const t = row.time || '000000'; return `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}Z`; }
    function fmtAlt(row, isImp) {
        const m = (row.gpsAlt != null && !isNaN(row.gpsAlt)) ? row.gpsAlt : row.pAlt;
        if (m == null || isNaN(m)) return DASH;
        return isImp ? `${Math.round(m * 3.28084).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`;
    }
    function fmtPos(row) {
        if (row.lat == null || row.lon == null || isNaN(row.lat) || isNaN(row.lon)) return DASH;
        const la = `${Math.abs(row.lat).toFixed(2)}° ${row.lat >= 0 ? 'N' : 'S'}`;
        const lo = `${Math.abs(row.lon).toFixed(2)}° ${row.lon >= 0 ? 'E' : 'W'}`;
        return `${la}, ${lo}`;
    }

    function populateMetricSelect() {
        const sel = $('fsMetricSelect');
        if (!sel || typeof METRIC_DEFS === 'undefined') return;
        const isImp = isImperial();
        const cur = sel.value;
        sel.innerHTML = '';
        Object.keys(METRIC_DEFS).forEach((k) => {
            const o = document.createElement('option');
            o.value = k;
            o.textContent = getMetricLabel(k, isImp);
            sel.appendChild(o);
        });
        if (cur && METRIC_DEFS[cur]) sel.value = cur;
        else if (METRIC_DEFS.alpha) sel.value = 'alpha';
    }

    function populateFlightChecks() {
        const box = $('fsFlightChecks');
        if (!box) return;
        // detach the persistent "load more flights" button before the innerhtml reset so its listener
        // survives, then re-append it inside this container below the checkboxes.
        const moreBtn = $('fsPreloadBtn');
        if (moreBtn && moreBtn.parentElement) moreBtn.parentElement.removeChild(moreBtn);
        box.innerHTML = '';
        fsFlights = fsSearchableFlights();
        if (!fsFlights.length) {
            box.innerHTML = '<div style="color:var(--text-faint);padding:4px 0;">No flights loaded yet. Load a mission or use Batch Load Flight Data, then search across them.</div>';
        } else {
            fsFlights.forEach((f) => {
                const label = document.createElement('label');
                label.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;min-width:0;padding:1px 0;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = f.id;
                cb.checked = true;
                cb.className = 'fs-check accent-accent flex-none';
                const span = document.createElement('span');
                span.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);';
                span.textContent = f.label + (f.preview ? '   (preview: limited metrics)' : '');
                label.appendChild(cb);
                label.appendChild(span);
                box.appendChild(label);
            });
        }
        if (moreBtn) { moreBtn.style.marginTop = '6px'; box.appendChild(moreBtn); }
    }

    function openModal() {
        populateMetricSelect();
        populateFlightChecks();
        const sa = $('fsSelectAll'); if (sa) sa.checked = true;
        const res = $('fsResults'); if (res) res.style.display = 'none';
        const st = $('fsStatus');
        if (st) st.textContent = fsFlights.length ? `${fsFlights.length} flight${fsFlights.length > 1 ? 's' : ''} available to search.` : '';
        const modal = $('flightSearchModal'); if (modal) modal.style.display = 'flex';
    }

    function closeModal() {
        const modal = $('flightSearchModal'); if (modal) modal.style.display = 'none';
        if (fsChartInstance) { fsChartInstance.destroy(); fsChartInstance = null; }
    }

    async function runSearch() {
        const sel = $('fsMetricSelect');
        const modeSel = $('fsModeSelect');
        if (!sel) return;
        const key = sel.value;
        const mode = (modeSel && modeSel.value === 'min') ? 'min' : 'max';
        const isImp = isImperial();
        const chosen = [...document.querySelectorAll('#fsFlightChecks .fs-check:checked')].map((cb) => cb.value);
        const st = $('fsStatus');
        if (!chosen.length) { if (st) st.textContent = 'Select at least one flight to search.'; return; }
        if (st) st.textContent = `Scanning ${chosen.length} flight${chosen.length > 1 ? 's' : ''} for ${getMetricLabel(key, isImp)}…`;
        const runBtn = $('fsRunBtn'); if (runBtn) runBtn.disabled = true;

        const results = [];
        for (const id of chosen) {
            const t = fsFlights.find((f) => f.id === id);
            if (!t) continue;
            const rows = await fsGetRows(t);
            if (!rows || !rows.length) { results.push({ id, label: t.label, peak: null }); continue; }
            const peak = findPeak(rows, key, mode);
            results.push({ id, label: t.label, rows, peak, t0: peak ? firstValidAbs(rows, key) : null });
        }
        if (runBtn) runBtn.disabled = false;

        const ranked = results.filter((r) => r.peak).sort((a, b) => mode === 'max' ? b.peak.value - a.peak.value : a.peak.value - b.peak.value);
        ranked.forEach((r, i) => { r.color = FS_PALETTE[i % FS_PALETTE.length]; });
        const missing = results.filter((r) => !r.peak);

        renderResults(ranked, missing, key, mode, isImp);
        if (st) {
            st.textContent = ranked.length
                ? `Ranked ${ranked.length} flight${ranked.length > 1 ? 's' : ''} by ${mode === 'max' ? 'highest' : 'lowest'} ${getMetricLabel(key, isImp)}.`
                : 'None of the selected flights recorded that metric.';
        }
    }

    function renderResults(ranked, missing, key, mode, isImp) {
        const res = $('fsResults'); if (!res) return;
        if (!ranked.length) {
            res.style.display = 'none';
            if (fsChartInstance) { fsChartInstance.destroy(); fsChartInstance = null; }
            return;
        }
        res.style.display = 'block';
        const label = getMetricLabel(key, isImp);

        const win = $('fsWinner');
        if (win) {
            if (ranked.length) {
                const w = ranked[0];
                win.style.cssText = 'padding:10px 12px;border:1px solid var(--accent);background:var(--accent-soft);border-radius:6px;';
                win.innerHTML =
                    `<div style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-muted);">${mode === 'max' ? 'Highest' : 'Lowest'} ${escapeHtml(label)}</div>` +
                    `<div style="font-size:20px;font-weight:700;color:var(--text);margin-top:2px;font-variant-numeric:tabular-nums;">${fmtVal(w.peak.value, key, isImp)}</div>` +
                    `<div style="font-size:12px;font-weight:600;color:var(--text);margin-top:2px;">${escapeHtml(w.label)}</div>` +
                    `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${fmtTime(w.peak.row)} · ${fmtAlt(w.peak.row, isImp)} · ${fmtPos(w.peak.row)}</div>`;
            } else {
                win.style.cssText = '';
                win.innerHTML = '';
            }
        }

        renderChart(ranked, key, isImp, label);
        renderTable(ranked, missing, key, isImp);
    }

    function renderTable(ranked, missing, key, isImp) {
        const box = $('fsTable'); if (!box) return;
        if (!ranked.length) { box.innerHTML = ''; return; }
        let html = '<table style="width:100%;border-collapse:collapse;font-size:11px;white-space:nowrap;">';
        html += '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border);">' +
            '<th style="padding:5px 6px;">#</th><th style="padding:5px 6px;">Flight</th>' +
            '<th style="padding:5px 6px;text-align:right;">Peak</th>' +
            '<th style="padding:5px 6px;">Time (UTC)</th><th style="padding:5px 6px;">Altitude</th><th style="padding:5px 6px;">Position</th></tr></thead><tbody>';
        ranked.forEach((r, i) => {
            const winRow = i === 0;
            html += `<tr style="border-bottom:1px solid var(--border);${winRow ? 'background:var(--accent-soft);' : ''}">` +
                `<td style="padding:5px 6px;color:var(--text-muted);">${i + 1}</td>` +
                `<td style="padding:5px 6px;color:var(--text);"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${r.color};margin-right:6px;vertical-align:middle;"></span>${escapeHtml(r.label)}</td>` +
                `<td style="padding:5px 6px;text-align:right;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;">${fmtVal(r.peak.value, key, isImp)}</td>` +
                `<td style="padding:5px 6px;color:var(--text-muted);font-variant-numeric:tabular-nums;">${fmtTime(r.peak.row)}</td>` +
                `<td style="padding:5px 6px;color:var(--text-muted);font-variant-numeric:tabular-nums;">${fmtAlt(r.peak.row, isImp)}</td>` +
                `<td style="padding:5px 6px;color:var(--text-muted);font-variant-numeric:tabular-nums;">${fmtPos(r.peak.row)}</td></tr>`;
        });
        html += '</tbody></table>';
        if (missing.length) {
            html += `<div style="margin-top:8px;font-size:10px;color:var(--text-faint);">Metric not recorded in: ${missing.map((m) => escapeHtml(m.label)).join(', ')}</div>`;
        }
        box.innerHTML = html;
    }

    function renderChart(ranked, key, isImp, label) {
        const canvas = $('fsChart');
        if (fsChartInstance) { fsChartInstance.destroy(); fsChartInstance = null; }
        if (!canvas || typeof Chart === 'undefined' || !ranked.length) return;
        const light = document.documentElement.dataset.theme === 'light';
        const axC = light ? '#334155' : '#94a3b8';
        const gridC = light ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.07)';

        const datasets = ranked.map((r, i) => ({
            label: r.label,
            data: fsLine(r.rows, key, r.t0 != null ? r.t0 : firstValidAbs(r.rows, key), isImp),
            borderColor: r.color,
            backgroundColor: r.color,
            borderWidth: i === 0 ? 2.6 : 1.3,
            pointRadius: 0,
            fill: false,
            tension: 0.15,
            order: i === 0 ? 2 : 1   // rank-1 line drawn above the rest
        }));
        // A single marker at the winner's peak, kept off the legend.
        const w = ranked[0];
        const wt0 = w.t0 != null ? w.t0 : firstValidAbs(w.rows, key);
        datasets.push({
            label: 'Peak',
            data: [{ x: (w.peak.row.absSeconds - wt0) / 60, y: getConvertedVal(w.peak.value, key, isImp) }],
            borderColor: w.color,
            backgroundColor: w.color,
            pointRadius: 5,
            pointHoverRadius: 6,
            showLine: false,
            order: 3
        });

        fsChartInstance = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
                interaction: { mode: 'nearest', intersect: false },
                scales: {
                    x: { type: 'linear', title: { display: true, text: 'Elapsed flight time (min)', color: axC, font: { size: 11, family: "'Manrope', sans-serif", weight: '600' } }, ticks: { color: axC, font: { family: "'IBM Plex Mono', monospace", size: 10 }, maxTicksLimit: 10 }, grid: { color: gridC } },
                    y: { title: { display: true, text: label, color: axC, font: { size: 11, family: "'Manrope', sans-serif", weight: '600' } }, ticks: { color: axC, font: { family: "'IBM Plex Mono', monospace", size: 10 } }, grid: { color: gridC } }
                },
                plugins: {
                    legend: { display: true, labels: { color: axC, boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: 'line', font: { size: 10, family: "'IBM Plex Mono', monospace" }, filter: (item) => item.text !== 'Peak' } },
                    tooltip: { callbacks: { title: (items) => items.length ? `${items[0].parsed.x.toFixed(1)} min` : '', label: (it) => `${it.dataset.label}: ${it.parsed.y != null ? it.parsed.y.toFixed(1) : ''}` } }
                }
            }
        });
    }

    // Wiring. Elements are static in index.html; scripts run at end of body, so they exist now.
    const openBtn = $('flightSearchBtn'); if (openBtn) openBtn.addEventListener('click', openModal);
    const closeX = $('fsCloseX'); if (closeX) closeX.addEventListener('click', closeModal);
    const closeBtn = $('fsCloseBtn'); if (closeBtn) closeBtn.addEventListener('click', closeModal);
    const runBtn = $('fsRunBtn'); if (runBtn) runBtn.addEventListener('click', () => { runSearch(); });
    const selAll = $('fsSelectAll');
    if (selAll) selAll.addEventListener('change', () => { document.querySelectorAll('#fsFlightChecks .fs-check').forEach((c) => { c.checked = selAll.checked; }); });
    const modal = $('flightSearchModal');
    if (modal) modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

    // "Load more flights" hands off to the Batch Load Flight Data modal (which also takes uploads), then
    // reopens this modal when that one closes so the newly loaded flights show up in the checklist.
    const preloadJump = $('fsPreloadBtn');
    if (preloadJump) preloadJump.addEventListener('click', () => {
        cameFromSearch = true;
        closeModal();
        const rp = document.getElementById('reconPreloadBtn');
        if (rp && !rp.disabled) rp.click();                     // its handler populates + opens the modal
        else { const pm = document.getElementById('preloadModal'); if (pm) pm.style.display = 'flex'; }
    });
    ['preloadCloseX', 'preloadCloseBtn'].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.addEventListener('click', () => { if (cameFromSearch) { cameFromSearch = false; openModal(); } });
    });
})();
