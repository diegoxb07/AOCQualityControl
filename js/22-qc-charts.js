/* QC Mode, family panels + difference sub-plots (forked from js/17-charts.js style)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   For each catalog family we emit one main panel that overlays every member + reference, plus a
   difference sub-panel whose title carries each pair's mean diff, exactly like the script's p / pa
   pairing. Charts read the raw arrays on the continuous 1-second axis (not the cleaned playback
   rows), so gaps render as real breaks. Two Chart.js plugins add QC signal on top: gapShade fills
   whole-family data holes, flagMarks dots isolated spikes, and a playhead line tracks the timeline. */

    let qcCharts = {};                 // canvasId -> Chart instance
    let qcTimeLabels = null;           // HH:MM:SS label per axis second, built once per flight
    let qcAxisRef = null;              // the active qcResult.timeAxis, for playhead second->index mapping
    let qcActiveChart = null;          // chart under the cursor / last interacted, for ctrl+z undo
    let qcPhaseMarks = null;           // { toIdx, landIdx }: takeoff/landing markers + scrub bounds
    // ONE playhead, one owner: qcScrubIdx is the single source of truth for "the current second".
    // the graph line draws from it, the map and clock FOLLOW it (qcDrivePlayer), and the only thing
    // that moves it automatically is active playback (the player wrapper mirrors its row into it).
    let qcScrubIdx = null;             // playhead axis index (seconds since recording start)

    // min/max decimation: at wide views each series is reduced to at most ~2 points per pixel
    // bucket, keeping every extreme (a QC tool must never smooth away a spike) and breaking the
    // line wherever a bucket contains missing seconds, so gaps stay visible even zoomed out.
    // full resolution returns automatically as the window narrows (qcRefreshResolution).
    const QC_DECIMATE_BUCKETS = 1600;
    function qcDecimate(full, start, end) {
        const out = []; const n = end - start + 1;
        if (n <= QC_DECIMATE_BUCKETS * 2) { for (let i = start; i <= end; i++) out.push({ x: i, y: full[i] }); return out; }
        const step = n / QC_DECIMATE_BUCKETS;
        for (let b = 0; b < QC_DECIMATE_BUCKETS; b++) {
            const i0 = start + Math.floor(b * step), i1 = Math.min(end, start + Math.floor((b + 1) * step) - 1);
            let mn = Infinity, mnI = -1, mx = -Infinity, mxI = -1, sawNaN = false, sawVal = false;
            for (let i = i0; i <= i1; i++) {
                const v = full[i];
                if (Number.isNaN(v)) { sawNaN = true; continue; }
                sawVal = true;
                if (v < mn) { mn = v; mnI = i; }
                if (v > mx) { mx = v; mxI = i; }
            }
            if (!sawVal) { out.push({ x: i0, y: NaN }); continue; }
            if (sawNaN) out.push({ x: i0, y: NaN });
            if (mnI <= mxI) { out.push({ x: mnI, y: mn }); if (mxI !== mnI) out.push({ x: mxI, y: mx }); }
            else { out.push({ x: mxI, y: mx }); out.push({ x: mnI, y: mn }); }
        }
        return out;
    }

    // re-slice every dataset of a chart to the visible window at display resolution, and adapt the
    // line style to the zoom: zoomed in far enough to resolve individual seconds, the samples get
    // visible point markers and a slightly heavier line, so oscillations read as data not fuzz.
    function qcRefreshResolution(chart) {
        const x = chart.scales && chart.scales.x; if (!x || !qcAxisRef) return;
        const last = qcAxisRef.length - 1;
        const start = Math.max(0, Math.floor(x.min)), end = Math.min(last, Math.ceil(x.max));
        if (end <= start) return;
        const showSamples = (end - start) <= 1200;    // roughly under 20 min visible at 1 Hz
        let changed = false;
        chart.data.datasets.forEach(ds => {
            if (!ds.$full) return;
            ds.data = qcDecimate(ds.$full, start, end);
            ds.pointRadius = showSamples ? 1.7 : 0;
            if (ds.$qcBaseWidth != null) ds.borderWidth = showSamples ? ds.$qcBaseWidth + 0.4 : ds.$qcBaseWidth;
            changed = true;
        });
        if (changed) chart.update('none');
    }

    // distinct series colors that read on both the dark and light QC panels
    const QC_SERIES_COLORS = ['#5b9dff', '#28c76f', '#ff9f43', '#ea5455', '#a66bff', '#00cfe8', '#ff6fb5', '#c0ca33', '#8d99ae', '#f6c945'];
    const QC_REF_COLOR = '#ffffff';
    const QC_GAP_FILL = 'rgba(240, 190, 60, 0.16)';

    function qcAxisTickColor() { return document.documentElement.dataset.theme === 'light' ? '#475569' : '#94a3b8'; }

    // unchecked-legend swatch: the variable's own box with its line running corner to corner
    // (top right to bottom left), so it reads as "this variable's line, currently off"
    const qcUncheckedIconCache = new Map();
    function qcUncheckedIcon(color) {
        let cv = qcUncheckedIconCache.get(color);
        if (cv) return cv;
        const s = 12;
        cv = document.createElement('canvas'); cv.width = s; cv.height = s;
        const c = cv.getContext('2d');
        c.strokeStyle = '#7a8494'; c.lineWidth = 1.3;
        c.strokeRect(1, 1, s - 2, s - 2);
        c.strokeStyle = color; c.lineWidth = 1.8; c.lineCap = 'round';
        c.beginPath(); c.moveTo(s - 2.2, 2.2); c.lineTo(2.2, s - 2.2); c.stroke();
        qcUncheckedIconCache.set(color, cv);
        return cv;
    }

    // spelled-out unit names: one-letter units next to a title read like typos ("m"), so the short
    // forms are expanded wherever a unit is shown. compound units (m/s, mm/hr) already read as units.
    function qcUnitLabel(u) {
        const map = { 'm': 'meters', 'deg': 'degrees', 'mb': 'millibars', 'kt': 'knots', 'K': 'Kelvin', '%': 'percent' };
        return map[u] || u;
    }

    function qcSecToLabel(sec) {
        let s = Math.round(sec) % 86400; if (s < 0) s += 86400;
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    }

    // arrow keys scrub the playhead: left/right one second, shift for ten
    document.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const t = e.target; if (t && /input|textarea|select/i.test(t.tagName)) return;
        if (!qcAxisRef || !qcAxisRef.length || qcScrubIdx == null) return;
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
        qcScrubIdx = qcClampScrub(qcScrubIdx + step);
        if (typeof isPlaying !== 'undefined' && isPlaying) {
            const pb = document.getElementById('playPauseBtn');
            if (pb && /pause/i.test(pb.innerText)) pb.click(); else isPlaying = false;
        }
        if (typeof qcDrivePlayer === 'function') qcDrivePlayer(false);
        qcSyncPlayhead(true);
    });

    // combined overlay plugin: gap shading (whole-family holes) and the playhead line.
    const qcOverlayPlugin = {
        id: 'qcOverlay',
        afterDraw: (chart) => {
            const ctx = chart.ctx, xa = chart.scales.x;
            const area = chart.chartArea; if (!area) return;
            ctx.save();
            // gap shading: seconds where no member of the panel carries data
            const gapRanges = chart.$qcGapRanges || [];
            ctx.fillStyle = QC_GAP_FILL;
            gapRanges.forEach(g => {
                const x0 = xa.getPixelForValue(g.fromIdx), x1 = xa.getPixelForValue(g.toIdx);
                if (x1 >= area.left && x0 <= area.right) ctx.fillRect(Math.max(x0, area.left), area.top, Math.max(1, Math.min(x1, area.right) - Math.max(x0, area.left)), area.bottom - area.top);
            });
            // takeoff / landing markers: a quiet dotted line with a tiny label, nothing louder
            if (qcPhaseMarks) {
                const faint = document.documentElement.dataset.theme === 'light' ? 'rgba(71,85,105,0.45)' : 'rgba(148,163,184,0.4)';
                ctx.strokeStyle = faint; ctx.fillStyle = faint;
                ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
                ctx.font = "8.5px 'IBM Plex Mono', monospace"; ctx.textBaseline = 'top';
                [[qcPhaseMarks.toIdx, 'takeoff'], [qcPhaseMarks.landIdx, 'landing']].forEach(mk => {
                    const x = xa.getPixelForValue(mk[0]);
                    if (x < area.left || x > area.right) return;
                    ctx.beginPath(); ctx.moveTo(x, area.top); ctx.lineTo(x, area.bottom); ctx.stroke();
                    ctx.fillText(mk[1], Math.min(x + 3, area.right - 42), area.top + 2);
                });
                ctx.setLineDash([]);
            }
            // the playhead: drawn from the single source of truth, nothing else
            const ph = qcScrubIdx;
            if (ph != null && ph >= 0) {
                const x = xa.getPixelForValue(ph);
                if (x >= area.left && x <= area.right) { ctx.strokeStyle = document.documentElement.dataset.theme === 'light' ? '#0f172a' : '#ffffff'; ctx.lineWidth = 1.5; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x, area.top); ctx.lineTo(x, area.bottom); ctx.stroke(); }
            }
            ctx.restore();
        }
    };

    // click anywhere on a chart to move the playhead (and the map) to that second. the x scale maps
    // the cursor pixel straight to a catalog-axis index, so the playhead lands exactly under the
    // click. a pan or box-zoom drag also ends in a click event, so real drags (moved more than a few
    // px since mousedown) are ignored instead of teleporting the playhead.
    function qcChartClick(e, els, chart) {
        if (!qcAxisRef || !qcAxisRef.length) return;
        const ne = e && e.native;
        if (ne && chart.$qcDownX != null && (Math.abs(ne.clientX - chart.$qcDownX) > 5 || Math.abs(ne.clientY - chart.$qcDownY) > 5)) return;
        const xa = chart.scales.x;
        const px = (e && e.x != null) ? e.x : (ne ? ne.offsetX : null);
        if (px == null) return;
        // clicks outside the plot area (the legend row) must not move the playhead
        const a = chart.chartArea, py = (e && e.y != null) ? e.y : (ne ? ne.offsetY : null);
        if (a && (px < a.left || px > a.right || (py != null && (py < a.top || py > a.bottom)))) return;
        const i = qcClampScrub(Math.round(xa.getValueForPixel(px)));
        if (typeof qcJumpToSecond === 'function') qcJumpToSecond(Math.round(qcAxisRef[i]));
    }

    // scrub bounds: with the 2d/3d context open the scrubber stays inside takeoff..landing (the
    // player has no rows outside it); with the context hidden the whole recording is scrubbable.
    function qcClampScrub(i) {
        i = Math.max(0, Math.min(qcAxisRef.length - 1, i));
        const app = document.getElementById('qcApp');
        if (qcPhaseMarks && app && app.classList.contains('qc-side-open')) {
            i = Math.max(qcPhaseMarks.toIdx, Math.min(qcPhaseMarks.landIdx, i));
        }
        return i;
    }

    // floating tooltip for the shaded gap regions, phrased exactly like the GapReport entries
    let qcGapTipEl = null;
    function qcGapTip() {
        if (!qcGapTipEl) { qcGapTipEl = document.createElement('div'); qcGapTipEl.className = 'qc-gap-tip hidden'; document.body.appendChild(qcGapTipEl); }
        return qcGapTipEl;
    }

    // per-chart interaction wiring shared by main + diff charts: drag-distance tracking for the
    // click-jump suppression above, double-click to reset the zoom (bokeh-style), hover tracking
    // so ctrl+z knows which graph to undo, and the gap-length tooltip over shaded gap regions.
    function qcWireCanvas(canvas, chart) {
        canvas.addEventListener('mousedown', ev => {
            chart.$qcDownX = ev.clientX; chart.$qcDownY = ev.clientY; qcActiveChart = chart;
            // scrub tool: the playhead follows the cursor from the moment the button goes down.
            // engages only inside the plot area, so legend clicks stay legend clicks.
            if (ev.button === 0 && (chart.$qcTool || 'scrub') === 'scrub' && chart.chartArea) {
                const rect = canvas.getBoundingClientRect();
                const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
                const a = chart.chartArea;
                if (px >= a.left && px <= a.right && py >= a.top && py <= a.bottom) {
                    chart.$qcScrubbing = true;
                    // pause playback right away, or the player keeps advancing under the drag
                    if (typeof isPlaying !== 'undefined' && isPlaying) {
                        const pb = document.getElementById('playPauseBtn');
                        if (pb && /pause/i.test(pb.innerText)) pb.click(); else isPlaying = false;
                    }
                    qcScrubMove(chart, canvas, ev, false);
                }
            }
        });
        canvas.addEventListener('mouseup', ev => { if (chart.$qcScrubbing) { chart.$qcScrubbing = false; qcScrubMove(chart, canvas, ev, true); } });
        canvas.addEventListener('mouseout', ev => { if (chart.$qcScrubbing) { chart.$qcScrubbing = false; qcScrubMove(chart, canvas, ev, true); } });
        canvas.addEventListener('mouseenter', () => { qcActiveChart = chart; });
        canvas.addEventListener('dblclick', () => { qcResetChart(chart); });
        canvas.addEventListener('mousemove', ev => {
            if (chart.$qcScrubbing) { qcScrubMove(chart, canvas, ev, false); return; }
            const tip = qcGapTip();
            const ranges = chart.$qcGapRanges, area = chart.chartArea;
            if (!ranges || !ranges.length || !area || !qcAxisRef) { tip.classList.add('hidden'); return; }
            const rect = canvas.getBoundingClientRect();
            const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
            if (px < area.left || px > area.right || py < area.top || py > area.bottom) { tip.classList.add('hidden'); return; }
            const x = chart.scales.x;
            const v = x.getValueForPixel(px);
            const tol = Math.max(0.5, (x.max - x.min) / Math.max(1, area.right - area.left));   // a gap thinner than a pixel still hits
            const g = ranges.find(r => v >= r.fromIdx - tol && v <= r.toIdx + tol);
            if (!g) { tip.classList.add('hidden'); return; }
            tip.textContent = 'Data gap from ' + qcSecToLabel(qcAxisRef[g.fromIdx]) + ' - ' + qcSecToLabel(qcAxisRef[g.toIdx]) + ' (' + (g.toIdx - g.fromIdx + 1) + ' s)';
            tip.style.left = (ev.clientX + 14) + 'px'; tip.style.top = (ev.clientY + 14) + 'px';
            tip.classList.remove('hidden');
        });
        canvas.addEventListener('mouseleave', () => { qcGapTip().classList.add('hidden'); });
    }

    // tool switch on one chart. scrub (default): dragging moves the playhead under the cursor.
    // pan: dragging moves the time window. select zoom: dragging draws a zoom box (both axes,
    // like bokeh's BoxZoomTool). wheel zoom stays on in every mode.
    function qcSetTool(chart, tool) {
        chart.$qcTool = tool;
        const z = chart.options.plugins.zoom;
        z.pan.enabled = tool === 'pan';
        z.zoom.drag.enabled = tool === 'box';
        z.zoom.mode = tool === 'box' ? 'xy' : 'x';
        chart.canvas.style.cursor = tool === 'scrub' ? 'ew-resize' : tool === 'pan' ? 'grab' : 'crosshair';
        chart.update('none');
    }

    // live scrub, atomic: while the button is down ONLY the scrubber line moves (pure canvas
    // redraws, the player is never touched, so nothing else can flash). the map, sliders, and
    // player sync exactly once, on release.
    function qcScrubMove(chart, canvas, ev, hard) {
        const area = chart.chartArea; if (!area || !qcAxisRef || !qcAxisRef.length) return;
        const rect = canvas.getBoundingClientRect();
        const px = Math.max(area.left, Math.min(area.right, ev.clientX - rect.left));
        let i = qcClampScrub(Math.round(chart.scales.x.getValueForPixel(px)));
        qcScrubIdx = i;   // the line follows every move
        if (hard && typeof qcJumpToSecond === 'function') qcJumpToSecond(Math.round(qcAxisRef[i]));
        if (!chart.$qcScrubRaf) chart.$qcScrubRaf = requestAnimationFrame(() => {
            chart.$qcScrubRaf = null;
            try { chart.draw(); } catch (e) {}
            // the tracker follows at full frame rate DURING the drag, same as the chart line
            // (the map renderer runs per-frame in normal playback anyway; rAF caps the cost)
            if (!hard && typeof qcDrivePlayer === 'function') qcDrivePlayer(true);
            qcSyncPlayhead();   // other visible graphs follow on their own light throttle
        });
    }

    // ---- zoom history: every pan/zoom gesture pushes the prior window, ctrl+z walks back --------
    function qcPushZoomState(chart) {
        const now = Date.now();
        // wheel zooming fires a burst of events; merge anything within half a second into one step
        if (chart.$qcHistAt && now - chart.$qcHistAt < 500) return;
        chart.$qcHistAt = now;
        const h = chart.$qcHist || (chart.$qcHist = []);
        const x = chart.scales.x, y = chart.scales.y;
        h.push({ x: { min: x.min, max: x.max }, y: { min: y.min, max: y.max } });
        if (h.length > 60) h.shift();
    }

    // reflect zoom state on the toolbar: the reset button lights up while the graph is zoomed
    function qcZoomVisual(chart) {
        let zoomed = false;
        try { zoomed = chart.isZoomedOrPanned(); } catch (e) {}
        if (chart.$qcResetBtn) chart.$qcResetBtn.classList.toggle('qc-tool-hot', zoomed);
    }

    // after any gesture: re-slice to the new window and update the toolbar
    function qcZoomChanged(chart) {
        qcActiveChart = chart;
        qcRefreshResolution(chart);
        qcZoomVisual(chart);
    }

    function qcUndoZoom(chart) {
        if (!chart) return;
        const h = chart.$qcHist;
        if (h && h.length) {
            const prev = h.pop();
            try { chart.zoomScale('x', prev.x, 'none'); chart.zoomScale('y', prev.y, 'none'); } catch (e) {}
            qcZoomChanged(chart);
        } else {
            qcResetChart(chart);
        }
    }

    // reset returns this graph to the full flight window
    function qcResetChart(chart) {
        try { chart.resetZoom(); } catch (e) {}
        chart.$qcHist = [];
        qcRefreshResolution(chart);
        qcZoomVisual(chart);
        qcActiveChart = chart;
    }

    // ctrl+z / cmd+z undoes the last zoom or pan on the graph under the cursor
    document.addEventListener('keydown', e => {
        if ((e.key !== 'z' && e.key !== 'Z') || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
        const t = e.target; if (t && /input|textarea|select/i.test(t.tagName)) return;
        if (!qcActiveChart) return;
        e.preventDefault();
        qcUndoZoom(qcActiveChart);
    });

    function qcChartOptions(titleText) {
        const tick = { color: qcAxisTickColor(), font: { family: "'IBM Plex Mono', monospace", size: 10 } };
        // x is LINEAR over the axis index (numeric labels), not a category scale: the zoom plugin
        // pans category scales in whole-label steps, which never tracks the cursor; a linear scale
        // pans 1:1 under the pointer. ticks format the index back to HH:MM:SS.
        const xTicks = Object.assign({ maxTicksLimit: 10, callback: v => { const i = Math.round(v); return (qcTimeLabels && qcTimeLabels[i]) || ''; } }, tick);
        return {
            responsive: true, maintainAspectRatio: false, animation: false,
            onClick: qcChartClick,
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            elements: { point: { radius: 0 }, line: { borderWidth: 1.2, tension: 0 } },
            scales: {
                // the graphs show the FULL recording (pre-takeoff included); only the scrubber is
                // clamped to takeoff..landing, since the 2d/3d player has no rows outside it
                x: { type: 'linear', bounds: 'data', grid: { color: 'rgba(148,163,184,0.08)' }, ticks: xTicks },
                y: { type: 'linear', position: 'left', grid: { color: 'rgba(148,163,184,0.10)' }, ticks: tick, title: { display: true, text: titleText, color: qcAxisTickColor(), font: { family: "'Manrope', sans-serif", size: 11, weight: '600' } } }
            },
            plugins: {
                legend: { display: true, align: 'start',
                    labels: { color: document.documentElement.dataset.theme === 'light' ? '#1e293b' : '#e2e8f0', font: { size: 10, family: "'IBM Plex Mono', monospace" }, boxWidth: 12, boxHeight: 12, padding: 16, usePointStyle: true, pointStyle: 'rectRounded',
                        // checkbox-style entries: a filled swatch in the series color when checked;
                        // unchecked keeps the box with the variable's line drawn corner to corner
                        // through it. the text is never struck through.
                        generateLabels: (chart) => {
                            const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                            items.forEach(it => {
                                const off = it.hidden;
                                it.hidden = false;
                                if (off) { const color = String((chart.data.datasets[it.datasetIndex] || {}).borderColor || '#7a8494'); it.pointStyle = qcUncheckedIcon(color); it.fillStyle = 'rgba(0,0,0,0)'; it.strokeStyle = 'rgba(0,0,0,0)'; }
                                else { it.pointStyle = 'rectRounded'; it.fillStyle = it.strokeStyle; }
                            });
                            return items;
                        } },
                    onClick: (e, item, legend) => { const ci = legend.chart; ci.setDatasetVisibility(item.datasetIndex, !ci.isDatasetVisible(item.datasetIndex)); ci.update('none'); } },
                // parsed.x is the axis-second index even on decimated data (dataIndex is not)
                tooltip: { callbacks: { title: (items) => items.length ? ((qcTimeLabels && qcTimeLabels[Math.round(items[0].parsed.x)]) || '') + ' UTC' : '' } },
                zoom: {
                    zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x',
                            drag: { enabled: false, backgroundColor: 'rgba(91,157,255,0.14)', borderColor: '#5b9dff', borderWidth: 1 },
                            onZoomStart: ({ chart }) => qcPushZoomState(chart),
                            onZoomComplete: ({ chart }) => qcZoomChanged(chart) },
                    pan: { enabled: true, mode: 'x',
                           onPanStart: ({ chart }) => qcPushZoomState(chart),
                           onPanComplete: ({ chart }) => qcZoomChanged(chart) },
                    // pan/zoom stay inside the flight window
                    limits: { x: { min: 'original', max: 'original' } }
                }
            }
        };
    }

    // whole-family gap ranges: seconds INSIDE the family's active window where none of its members
    // has a value. the lead-in before the family comes online and the tail after it stops are not
    // shaded (a late start is not a gap), matching the interior-only gaps in the report.
    function qcFamilyGapRanges(seriesList, n) {
        const has = i => { for (let k = 0; k < seriesList.length; k++) { const a = seriesList[k]; if (a && !Number.isNaN(a[i])) return true; } return false; };
        let a = -1, b = -1;
        for (let i = 0; i < n; i++) if (has(i)) { if (a < 0) a = i; b = i; }
        if (a < 0) return [];
        const ranges = []; let s = -1;
        for (let i = a; i <= b; i++) {
            const empty = !has(i);
            if (empty && s < 0) s = i;
            if (!empty && s >= 0) { ranges.push({ fromIdx: s, toIdx: i - 1 }); s = -1; }
        }
        return ranges;
    }

    function qcBuildMainChart(canvas, fam, famModel) {
        const plotted = famModel.members.filter(m => m.series);              // only members with data
        const last = qcTimeLabels.length - 1, first = 0;
        // when a family mixes direct sensors with their blended GPS counterparts (AccAZI.x vs
        // AccZI-GPS.x, GsXI.x vs GsXGPS.x), start the GPS group unchecked so the graph opens
        // readable; the reference always starts checked. one click on the legend brings them back.
        const groupNames = plotted.filter(m => !m.isRef && !m.isDerived).map(m => m.name);
        let startUnchecked = null;
        if (groupNames.some(n => /I-GPS/.test(n)) && groupNames.some(n => !/I-GPS/.test(n))) startUnchecked = n => /I-GPS/.test(n);
        else if (groupNames.some(n => /GPS/.test(n)) && groupNames.some(n => !/GPS/.test(n))) startUnchecked = n => /GPS/.test(n);
        // the ref entry names its source sensor with a pipe (ALTref | AltGPS.3), found by the
        // engine's equality match
        const refSource = famModel.refInfo && famModel.refInfo.source;
        const datasets = plotted.map((m, k) => ({
            label: m.isRef ? (refSource ? m.name + ' | ' + refSource : m.name + ' (ref)') : m.name + (m.isDerived ? ' (deriv.)' : ''),
            data: qcDecimate(m.series, first, last), $full: m.series, parsing: false, normalized: true,
            borderColor: m.isRef ? QC_REF_COLOR : QC_SERIES_COLORS[k % QC_SERIES_COLORS.length],
            $qcBaseWidth: m.isRef ? 1.9 : 1.4, borderWidth: m.isRef ? 1.9 : 1.4,
            borderDash: m.isDerived ? [4, 3] : [], pointRadius: 0, pointHitRadius: 6, fill: false, spanGaps: false,
            hidden: !!(startUnchecked && !m.isRef && !m.isDerived && startUnchecked(m.name))
        }));
        const chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: datasets }, options: qcChartOptions(fam.label + ' (' + qcUnitLabel(fam.unit) + ')'), plugins: [qcOverlayPlugin] });
        chart.$qcGapRanges = qcFamilyGapRanges(plotted.map(m => m.series), qcTimeLabels.length);
        qcWireCanvas(canvas, chart);
        return chart;
    }

    function qcBuildDiffChart(canvas, fam, famModel) {
        const plotted = famModel.diffs.filter(d => d.series);
        const last = qcTimeLabels.length - 1, first = 0;
        // one pair at a time: the first pair starts checked, the rest unchecked. avg diffs live in
        // the section header above, so legend entries stay short.
        const datasets = plotted.map((d, k) => ({
            label: d.id,
            data: qcDecimate(d.series, first, last), $full: d.series, parsing: false, normalized: true,
            borderColor: QC_SERIES_COLORS[k % QC_SERIES_COLORS.length],
            $qcBaseWidth: 1.3, borderWidth: 1.3, pointRadius: 0, pointHitRadius: 6, fill: false, spanGaps: false,
            hidden: k > 0
        }));
        const opts = qcChartOptions('Difference (' + qcUnitLabel(fam.unit) + ')');
        // one pair at a time, without surprises: checking an unchecked pair solos it, while
        // unchecking a checked pair only unchecks that pair (never touches the others).
        opts.plugins.legend.onClick = (e, item, legend) => {
            const ci = legend.chart, k = item.datasetIndex;
            if (ci.isDatasetVisible(k)) ci.setDatasetVisibility(k, false);
            else ci.data.datasets.forEach((_, j) => ci.setDatasetVisibility(j, j === k));
            ci.update('none');
        };
        const chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: datasets }, options: opts, plugins: [qcOverlayPlugin] });
        qcWireCanvas(canvas, chart);
        return chart;
    }

    // ---- difference modal: one shared overlay, the chart is built on open and destroyed on close
    let qcCurrentResult = null;        // the rendered qcResult, for modal lookups
    let qcDiffModalChartKey = null;
    function qcDiffModalEl() {
        let m = document.getElementById('qcDiffModal');
        if (m) return m;
        m = document.createElement('div'); m.id = 'qcDiffModal'; m.className = 'modal-overlay';
        m.innerHTML =
            '<div class="modal-card" style="max-width:1500px;width:96%">' +
              '<button id="qcDiffModalClose" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">✕</button>' +
              '<h2 id="qcDiffModalTitle" class="text-ink text-lg font-bold border-b border-hairline pb-2"></h2>' +
              '<div id="qcDiffModalBadges" class="qc-diff-head" style="border-top:none;margin-top:0;padding-top:0"></div>' +
              '<div id="qcDiffModalBody"></div>' +
            '</div>';
        document.body.appendChild(m);
        m.addEventListener('click', e => { if (e.target === m) qcCloseDiffModal(); });
        m.querySelector('#qcDiffModalClose').addEventListener('click', qcCloseDiffModal);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') qcCloseDiffModal(); });
        return m;
    }
    function qcOpenDiffModal(famKey) {
        if (!qcCurrentResult) return;
        const fam = qcCurrentResult.families.find(f => f.key === famKey); if (!fam) return;
        qcCloseDiffModal();
        const m = qcDiffModalEl();
        m.querySelector('#qcDiffModalTitle').textContent = fam.label + ': Difference Between Sensors (' + qcUnitLabel(fam.unit) + ')';
        m.querySelector('#qcDiffModalBadges').innerHTML = fam.diffs.filter(d => d.series)
            .map(d => '<span class="qc-badge">' + d.id + ' Avg Diff: ' + (Number.isNaN(d.mean) ? 'n/a' : d.mean) + '</span>').join('<span class="qc-diff-sep"></span>');
        const body = m.querySelector('#qcDiffModalBody'); body.innerHTML = '';
        const bar = document.createElement('div'); bar.className = 'qc-graph-bar';
        const wrap = document.createElement('div'); wrap.className = 'qc-canvas-wrap'; wrap.style.height = '52vh';
        const cv = document.createElement('canvas'); wrap.appendChild(cv);
        body.appendChild(bar); body.appendChild(wrap);
        m.style.display = 'flex';
        const chart = qcBuildDiffChart(cv, fam, fam);
        qcDiffModalChartKey = 'qc_' + fam.key + '_d';
        qcCharts[qcDiffModalChartKey] = chart;      // joins playhead sync, linked zoom, theming
        const hint = document.createElement('span'); hint.className = 'qc-legend-hint';
        hint.textContent = 'click a pair to view it alone, click again to unselect it';
        const tools = document.createElement('div'); tools.className = 'qc-graph-tools-group';
        bar.appendChild(hint); bar.appendChild(tools);
        tools.appendChild(qcBuildToolbar(chart, fam.key + '_diff.png'));
        tools.appendChild(qcBuildFsButton(chart));
    }
    function qcCloseDiffModal() {
        const m = document.getElementById('qcDiffModal');
        if (qcDiffModalChartKey) {
            const c = qcCharts[qcDiffModalChartKey];
            if (c) { try { c.destroy(); } catch (e) {} delete qcCharts[qcDiffModalChartKey]; }
            qcDiffModalChartKey = null;
        }
        if (m) m.style.display = 'none';
    }

    // build every family panel into `container` (diff graphs open from their modal buttons).
    // panel order follows the catalog, which follows the script's column(...) order.
    function qcRenderCharts(container, qcResult) {
        qcCloseDiffModal();
        qcDestroyCharts();
        qcCurrentResult = qcResult;
        qcAxisRef = qcResult.timeAxis;
        qcTimeLabels = new Array(qcResult.n);
        for (let i = 0; i < qcResult.n; i++) qcTimeLabels[i] = qcSecToLabel(qcResult.timeAxis[i]);
        // detected (or pinned) takeoff/landing indices, drawn as quiet markers on every graph
        qcPhaseMarks = qcResult.phases ? { toIdx: qcResult.phases.toIdx, landIdx: qcResult.phases.landIdx } : null;
        container.innerHTML = '';

        qcResult.families.forEach(fam => {
            const hasMain = fam.members.some(m => m.series);
            const hasDiff = fam.diffs.some(d => d.series);
            if (!hasMain && !hasDiff) return;                                 // whole family absent -> skip panel

            const panel = document.createElement('div'); panel.className = 'qc-chart-panel';
            panel.id = 'qcpanel_' + fam.key;   // navigation target (Phase Stats "view graph")
            const head = document.createElement('div'); head.className = 'qc-chart-head';
            let statBits = '';
            if (fam.phaseStat) statBits += qcPhaseStatBadge(fam);
            if (fam.flightMean) statBits += ' <span class="qc-badge">avg ' + fam.flightMean.var + ': ' + fam.flightMean.value + '</span>';
            // the ref channel is supposed to ride one sensor all flight; call it out when it moved
            if (fam.refInfo && fam.refInfo.switched) statBits += ' <span class="qc-badge qc-badge-warn">' + fam.ref + ' switched sources mid-flight: ' + fam.refInfo.sources.join(' then ') + '</span>';
            head.innerHTML = '<span class="qc-chart-title">' + fam.label + '</span>' +
                '<span class="qc-unit">' + qcUnitLabel(fam.unit) + '</span>' +
                '<span class="qc-chart-meta">' + statBits + '</span>';
            panel.appendChild(head);
            // issues are visible on the panel itself, no interaction needed: one chip per absent
            // member and per in-flight gap (click a gap chip to jump there), ground gaps dimmed.
            const issuesEl = qcBuildIssueStrip(fam);
            if (issuesEl) panel.appendChild(issuesEl);

            // each graph gets a slim control bar directly ABOVE it (tools never cover the plot);
            // fullscreen sits apart at the bar's far right
            const addGraph = (cls, key, pngName, build) => {
                const c = document.createElement('div'); c.className = cls;
                const cv = document.createElement('canvas'); c.appendChild(cv);
                const bar = document.createElement('div'); bar.className = 'qc-graph-bar';
                // tiny reminder sitting right over the variable checkboxes
                const hint = document.createElement('span'); hint.className = 'qc-legend-hint';
                hint.textContent = 'click a variable to unselect it, click again to add it back';
                const tools = document.createElement('div'); tools.className = 'qc-graph-tools-group';
                bar.appendChild(hint); bar.appendChild(tools);
                panel.appendChild(bar); panel.appendChild(c);
                const chart = qcCharts[key] = build(cv);
                tools.appendChild(qcBuildToolbar(chart, pngName));
                tools.appendChild(qcBuildFsButton(chart));
            };
            container.appendChild(panel);
            if (hasMain) addGraph('qc-canvas-wrap', 'qc_' + fam.key, fam.key + '.png', cv => qcBuildMainChart(cv, fam, fam));
            if (hasDiff) {
                // the difference graph opens in a modal (space saver); avg diffs stay visible here
                const dh = document.createElement('div'); dh.className = 'qc-diff-head';
                const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'qc-ov-btn';
                btn.textContent = 'Difference Between Sensors';
                btn.title = 'Open this family\'s difference graph';
                btn.addEventListener('click', () => qcOpenDiffModal(fam.key));
                dh.appendChild(btn);
                dh.insertAdjacentHTML('beforeend', '<span class="qc-diff-sep"></span>' +
                    fam.diffs.filter(d => d.series).map(d => '<span class="qc-badge">' + d.id + ' Avg Diff: ' + (Number.isNaN(d.mean) ? 'n/a' : d.mean) + '</span>').join('<span class="qc-diff-sep"></span>'));
                panel.appendChild(dh);
            }
        });
        // charts scrolled back into view would otherwise show the playhead where it was when they
        // scrolled out; refresh the visible ones as the column scrolls
        if (!container.$qcScrollWired) { container.$qcScrollWired = true; container.addEventListener('scroll', () => qcSyncPlayhead(), { passive: true }); }
    }

    // small stroke icons for the graph toolbar, drawn in the button's current text color
    const QC_TOOL_ICONS = {
        scrub: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M8 12H3M3 12l2.5-2.5M3 12l2.5 2.5M16 12h5M21 12l-2.5-2.5M21 12l-2.5 2.5"/></svg>',
        pan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/></svg>',
        box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5.5" width="13" height="11" rx="1" stroke-dasharray="3 2.2"/><circle cx="17" cy="16" r="3.4"/><path d="M19.5 18.5L22 21"/></svg>',
        reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.5v4.6h-4.6"/></svg>',
        full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
        png: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7.5 11l4.5 4.5L16.5 11M5 19.5h14"/></svg>'
    };

    // bokeh-style toolbar, one per graph, floating inside the graph's top-right corner so it is
    // unmistakably that graph's: pan / box zoom / reset scale / fullscreen / png. each button
    // carries an icon plus its label; reset scale lights up while the graph is zoomed.
    function qcBuildToolbar(chart, pngName) {
        const tb = document.createElement('div'); tb.className = 'qc-chart-tools';
        const mk = (icon, label, title, onClick) => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'qc-tool';
            b.innerHTML = QC_TOOL_ICONS[icon] + '<span>' + label + '</span>';
            b.title = title; b.addEventListener('click', onClick); tb.appendChild(b); return b;
        };
        const modeBtns = [];
        const setActive = btn => { modeBtns.forEach(b => b.classList.toggle('active', b === btn)); };
        const scrubBtn = mk('scrub', 'scrub', 'Drag anywhere on the graph and the playhead follows the cursor', () => { qcSetTool(chart, 'scrub'); setActive(scrubBtn); });
        const panBtn = mk('pan', 'pan', 'Drag moves the time window, wheel zooms', () => { qcSetTool(chart, 'pan'); setActive(panBtn); });
        const boxBtn = mk('box', 'select zoom', 'Drag a box to zoom into that area', () => { qcSetTool(chart, 'box'); setActive(boxBtn); });
        modeBtns.push(scrubBtn, panBtn, boxBtn);
        chart.$qcResetBtn = mk('reset', 'reset scale', 'Return to the full flight window (double-click the graph, or ctrl+z steps back)', () => qcResetChart(chart));
        mk('png', 'png', 'Save this graph as a PNG image', () => { try { const a = document.createElement('a'); a.href = chart.toBase64Image(); a.download = pngName; a.click(); } catch (e) {} });
        setActive(scrubBtn);
        qcSetTool(chart, 'scrub');
        return tb;
    }

    // standalone fullscreen control, set apart from the toolbar at the very corner of the graph
    // (same glyph the visualizer's map fullscreen button uses)
    function qcBuildFsButton(chart) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'qc-fs-btn';
        b.textContent = '⛶'; b.title = 'Fullscreen this graph';
        b.addEventListener('click', () => qcToggleGraphFullscreen(chart));
        return b;
    }

    function qcToggleGraphFullscreen(chart) {
        const wrap = chart.canvas && chart.canvas.parentElement; if (!wrap) return;
        if (document.fullscreenElement === wrap) { if (document.exitFullscreen) document.exitFullscreen().catch(() => {}); }
        else if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
    }

    // recolor the chart scaffolding when the page theme flips, so tick, axis-title, and legend text
    // follow the light/dark switch like the rest of the page (the canvas cannot inherit css vars).
    function qcApplyChartTheme() {
        const tickColor = qcAxisTickColor();
        const legendColor = document.documentElement.dataset.theme === 'light' ? '#1e293b' : '#e2e8f0';
        Object.values(qcCharts).forEach(c => {
            if (!c) return;
            try {
                c.options.scales.x.ticks.color = tickColor;
                c.options.scales.y.ticks.color = tickColor;
                c.options.scales.y.title.color = tickColor;
                c.options.plugins.legend.labels.color = legendColor;
                c.update('none');
            } catch (e) {}
        });
    }
    // the theme toggle stamps data-theme on <html>; recolor whenever it changes
    new MutationObserver(qcApplyChartTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // compact issue strip under a chart head: absent members, in-flight gaps (clickable jump),
    // ground gaps (dimmed, informational). shows the first few, the rest behind a "+N more" toggle.
    function qcBuildIssueStrip(fam) {
        const chips = [];
        fam.members.forEach(m => {
            if (m.presence === 'nodata') chips.push({ cls: 'qc-issue-nodata', text: m.name + ' no data' });
            (m.gaps || []).forEach(g => chips.push({ cls: 'qc-issue-gap', jump: Math.round(g.from), text: m.name + ' gap ' + qcSecToLabel(g.from) + ' - ' + qcSecToLabel(g.to) + ' (' + (g.effSecs || g.secs) + ' s)' }));
            if (m.lateStart) chips.push({ cls: 'qc-issue-note', jump: Math.round(m.lateStart.at), text: m.name + ' started late by ' + m.lateStart.secs + ' s' });
            if (m.earlyStop) chips.push({ cls: 'qc-issue-note', jump: Math.round(m.earlyStop.at), text: m.name + ' stopped early by ' + m.earlyStop.secs + ' s' });
        });
        if (!chips.length) return null;
        const wrap = document.createElement('div'); wrap.className = 'qc-issues';
        const VISIBLE = 3;
        chips.forEach((c, i) => {
            const el = document.createElement('span');
            el.className = 'qc-issue ' + c.cls + (i >= VISIBLE ? ' qc-issue-hidden' : '');
            el.textContent = c.text;
            if (c.jump != null) { el.classList.add('qc-issue-jump'); el.title = 'Jump the map and timeline to this moment'; el.addEventListener('click', () => qcJumpToSecond(c.jump)); }
            wrap.appendChild(el);
        });
        if (chips.length > VISIBLE) {
            const more = document.createElement('span');
            more.className = 'qc-issue qc-issue-more'; more.textContent = '+' + (chips.length - VISIBLE) + ' more';
            more.addEventListener('click', () => {
                const open = wrap.classList.toggle('qc-issues-open');
                more.textContent = open ? 'less' : '+' + (chips.length - VISIBLE) + ' more';
            });
            wrap.appendChild(more);
        }
        return wrap;
    }

    function qcPhaseStatBadge(fam) {
        // compact takeoff/landing max·mean·median, the script's PSM title line
        let out = '';
        Object.keys(fam.phaseStat).forEach(nm => {
            const s = fam.phaseStat[nm];
            const f = v => Number.isNaN(v) ? 'n/a' : qcRound(v, 1);
            out += ' <span class="qc-badge">' + nm + ' T/O ' + f(s.takeoff.max) + '/' + f(s.takeoff.mean) + '/' + f(s.takeoff.median) +
                   ' · Land ' + f(s.landing.max) + '/' + f(s.landing.mean) + '/' + f(s.landing.median) + '</span>';
        });
        return out;
    }

    // redraw the playhead as the timeline moves. redrawing every family chart each frame would jank
    // on long flights, so only charts scrolled into view are redrawn, and at most ~7x/second.
    let _qcLastPlayheadDraw = 0;
    function qcSyncPlayhead(force) {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        if (!force && now && now - _qcLastPlayheadDraw < 140) return;
        _qcLastPlayheadDraw = now;
        const panel = document.getElementById('qcChartsPanel');
        const pr = panel ? panel.getBoundingClientRect() : null;
        Object.values(qcCharts).forEach(c => {
            if (!c || !c.canvas) return;
            if (pr) { const r = c.canvas.getBoundingClientRect(); if (r.bottom < pr.top || r.top > pr.bottom) return; }  // off-screen: skip
            c.draw();
        });
    }

    function qcDestroyCharts() { Object.values(qcCharts).forEach(c => { try { c.destroy(); } catch (e) {} }); qcCharts = {}; }
