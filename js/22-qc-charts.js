/* QC Mode, family panels + difference sub-plots (forked from js/17-charts.js style)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   For each catalog family we emit one main panel that overlays every member + reference, plus a
   difference sub-panel whose badges carry each pair's max diff, following the script's p / pa
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
    // uniform sampler for the deviation band pair: both edges must land on the SAME x points or
    // the fill between them tears; min/max bucket picking (qcDecimate) chooses different indices
    function qcDecimateUniform(full, start, end) {
        const out = []; const n = end - start + 1;
        if (n <= QC_DECIMATE_BUCKETS * 2) { for (let i = start; i <= end; i++) out.push({ x: i, y: full[i] }); return out; }
        const step = n / QC_DECIMATE_BUCKETS;
        for (let b = 0; b < QC_DECIMATE_BUCKETS; b++) { const i = start + Math.floor(b * step); out.push({ x: i, y: full[i] }); }
        out.push({ x: end, y: full[end] });
        return out;
    }

    function qcRefreshResolution(chart) {
        const x = chart.scales && chart.scales.x; if (!x || !qcAxisRef) return;
        const last = qcAxisRef.length - 1;
        const start = Math.max(0, Math.floor(x.min)), end = Math.min(last, Math.ceil(x.max));
        if (end <= start) return;
        const showSamples = (end - start) <= 1200;    // roughly under 20 min visible at 1 Hz
        let changed = false;
        chart.data.datasets.forEach(ds => {
            if (!ds.$full) return;
            ds.data = ds.$qcBand ? qcDecimateUniform(ds.$full, start, end) : qcDecimate(ds.$full, start, end);
            ds.pointRadius = ds.$qcBand ? 0 : (showSamples ? 1.7 : 0);
            if (ds.$qcBaseWidth != null && !ds.$qcBand) ds.borderWidth = showSamples ? ds.$qcBaseWidth + 0.4 : ds.$qcBaseWidth;
            changed = true;
        });
        if (changed) chart.update('none');
    }

    // distinct series colors that read on both the dark and light QC panels
    const QC_SERIES_COLORS = ['#5b9dff', '#28c76f', '#ff9f43', '#ea5455', '#a66bff', '#00cfe8', '#ff6fb5', '#c0ca33', '#8d99ae', '#f6c945'];
    // the ref line follows the theme: pure white vanishes on the light panel
    const qcRefColor = () => document.documentElement.dataset.theme === 'light' ? '#0f172a' : '#ffffff';
    // one opacity for every gap pillar, wide or one second thin, so no gap looks heavier than
    // another; strong enough that a 2px line still reads down the whole panel
    const QC_GAP_FILL = 'rgba(240, 190, 60, 0.26)';

    function qcAxisTickColor() { return document.documentElement.dataset.theme === 'light' ? '#475569' : '#94a3b8'; }

    // unchecked-legend swatch: an outlined box with a neutral gray line corner to corner
    // (top right to bottom left), so it reads as "currently off" without shouting a color
    const qcUncheckedIconCache = new Map();
    function qcUncheckedIcon(color) {
        let cv = qcUncheckedIconCache.get(color);
        if (cv) return cv;
        const s = 12;
        cv = document.createElement('canvas'); cv.width = s; cv.height = s;
        const c = cv.getContext('2d');
        c.strokeStyle = '#7a8494'; c.lineWidth = 1.3;
        c.strokeRect(1, 1, s - 2, s - 2);
        c.lineWidth = 1.8; c.lineCap = 'round';
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
            // gap shading: seconds where no member of the panel carries data. every pillar shares
            // one opacity; a one second gap draws as a thin 2px line (zooming in grows it to its
            // true width)
            const gapRanges = chart.$qcGapRanges || [];
            ctx.fillStyle = QC_GAP_FILL;
            gapRanges.forEach(g => {
                const x0 = xa.getPixelForValue(g.fromIdx), x1 = xa.getPixelForValue(g.toIdx);
                if (x1 < area.left || x0 > area.right) return;
                const left = Math.max(x0, area.left);
                ctx.fillRect(left, area.top, Math.max(2, Math.min(x1, area.right) - left), area.bottom - area.top);
            });
            // red shading for Check regions: implausible values the engine flagged on this family
            (chart.$qcCheckMarks || []).forEach(g => {
                const x0 = xa.getPixelForValue(g.fromIdx), x1 = xa.getPixelForValue(g.toIdx);
                if (x1 < area.left || x0 > area.right) return;
                const left = Math.max(x0, area.left);
                ctx.fillStyle = 'rgba(234, 84, 85, 0.14)';
                ctx.fillRect(left, area.top, Math.max(4, Math.min(x1, area.right) - left), area.bottom - area.top);
            });
            // carets on top of each marked range. per-member gaps are marked too (the shading only
            // covers seconds every member misses). EVERY range gets its caret, none skipped; when
            // hundreds sit close they simply merge into a band. only the tiny word underneath is
            // spaced out, so the labels stay legible instead of smearing
            const drawCarets = (ranges, fill, word) => {
                ctx.fillStyle = fill;
                ctx.font = "8px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                let lastWordX = -Infinity;
                ranges.forEach(g => {
                    const x0 = Math.max(xa.getPixelForValue(g.fromIdx), area.left), x1 = Math.min(xa.getPixelForValue(g.toIdx), area.right);
                    if (x1 < x0) return;
                    const cx = (x0 + x1) / 2;
                    // the caret spans the whole range when it is wider than the default marker,
                    // so the marker itself tells how wide the gap is; narrow gaps keep the default
                    const hw = Math.max(5, (x1 - x0) / 2);
                    ctx.beginPath();
                    ctx.moveTo(cx - hw, area.top + 1); ctx.lineTo(cx + hw, area.top + 1); ctx.lineTo(cx, area.top + 9);
                    ctx.closePath(); ctx.fill();
                    if (cx - lastWordX >= 22) { ctx.fillText(word, cx, area.top + 11); lastWordX = cx; }
                });
                ctx.textAlign = 'left';
            };
            const light = document.documentElement.dataset.theme === 'light';
            const gapCarets = gapRanges.concat(chart.$qcGapMarks || []).slice().sort((a, b) => a.fromIdx - b.fromIdx);
            drawCarets(gapCarets, light ? 'rgba(170, 120, 20, 0.95)' : 'rgba(240, 190, 60, 0.95)', 'gap');
            drawCarets(chart.$qcCheckMarks || [], light ? 'rgba(198, 40, 40, 0.95)' : 'rgba(234, 84, 85, 0.95)', 'check');
            // a graph whose members carry zero finite samples says so in place, centered in the
            // takeoff to landing window so the empty frame cannot be mistaken for a render bug
            if (chart.$qcAllEmpty) {
                ctx.fillStyle = light ? 'rgba(71, 85, 105, 0.7)' : 'rgba(148, 163, 184, 0.7)';
                ctx.font = "700 26px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                let cx = (area.left + area.right) / 2;
                if (qcPhaseMarks) {
                    const x0 = xa.getPixelForValue(qcPhaseMarks.toIdx), x1 = xa.getPixelForValue(qcPhaseMarks.landIdx);
                    if (x1 > x0) cx = Math.max(area.left + 40, Math.min(area.right - 40, (x0 + x1) / 2));
                }
                ctx.fillText('NO DATA', cx, (area.top + area.bottom) / 2);
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            }
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

    // the floating reset zoom button exists only while the graph is zoomed
    function qcZoomVisual(chart) {
        let zoomed = false;
        try { zoomed = chart.isZoomedOrPanned(); } catch (e) {}
        if (chart.$qcResetBtn) chart.$qcResetBtn.classList.toggle('show', zoomed);
    }

    // y extent of the visible, non-band datasets over the current x window (NaN ignored), with a
    // little breathing room. this is the "correct" y window: reset jumps straight to it, and the
    // flatness guard below compares against it
    function qcVisibleYExtent(chart) {
        const x = chart.scales.x; if (!x || !qcAxisRef) return null;
        const last = qcAxisRef.length - 1;
        const start = Math.max(0, Math.floor(x.min)), end = Math.min(last, Math.ceil(x.max));
        if (end <= start) return null;
        let mn = Infinity, mx = -Infinity;
        chart.data.datasets.forEach((d, k) => {
            if (d.$qcBand || !d.$full || !chart.isDatasetVisible(k)) return;
            const a = d.$full;
            for (let i = start; i <= end; i++) { const v = a[i]; if (v === v) { if (v < mn) mn = v; if (v > mx) mx = v; } }
        });
        if (mn === Infinity) return null;
        if (mn === mx) { mn -= 1; mx += 1; }
        const pad = (mx - mn) * 0.06;
        return { min: mn - pad, max: mx + pad };
    }

    // after any gesture: re-slice to the new window and update the toolbar. an xy wheel-out (or a
    // stale box zoom) can leave the y window grossly wider than the visible data, which flattens
    // every line; whenever that happens the y axis snaps back to fit the data
    function qcZoomChanged(chart) {
        qcActiveChart = chart;
        qcRefreshResolution(chart);
        try {
            const ext = qcVisibleYExtent(chart);
            if (ext) {
                const y = chart.scales.y, span = y.max - y.min, fit = ext.max - ext.min;
                if (span > fit * 1.7) { chart.zoomScale('y', ext, 'none'); chart.update('none'); }
            }
        } catch (e) {}
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

    // reset zoom: back to the default view, deterministically. resetZoom and option juggling both
    // proved unreliable (the options resolver treats undefined as "fall through to the previous
    // pinned value"), so the home window is set with concrete numbers through the plugin's own
    // zoomScale api: full flight on x, then y fitted to the data actually visible
    function qcResetChart(chart) {
        try { chart.resetZoom('none'); } catch (e) {}
        const last = qcAxisRef ? qcAxisRef.length - 1 : null;
        try { if (last != null) chart.zoomScale('x', { min: 0, max: last }, 'none'); } catch (e) {}
        qcRefreshResolution(chart);
        try { const ext = qcVisibleYExtent(chart); if (ext) chart.zoomScale('y', ext, 'none'); } catch (e) {}
        chart.$qcHist = [];
        chart.update('none');
        qcZoomVisual(chart);
        // the home window is set with explicit limits, which the plugin counts as "zoomed";
        // the float staying up after a reset would read as a failed reset
        if (chart.$qcResetBtn) chart.$qcResetBtn.classList.remove('show');
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
            // nearest in BOTH axes: aiming the cursor up at a spike grabs the spike, instead of
            // whatever sits at that x. the decimation keeps every extreme as a real point, so
            // spikes are always grabbable even when one pixel spans many seconds
            interaction: { mode: 'nearest', axis: 'xy', intersect: false },
            elements: { point: { radius: 0 }, line: { borderWidth: 1.2, tension: 0 } },
            scales: {
                // the graphs show the FULL recording (pre-takeoff included); only the scrubber is
                // clamped to takeoff..landing, since the 2d/3d player has no rows outside it
                x: { type: 'linear', bounds: 'data', grid: { color: 'rgba(148,163,184,0.08)' }, ticks: xTicks },
                // the top tenth of every graph is reserved: data that reaches its ceiling would
                // otherwise sit under the gap carets and their labels, so the scale grows itself
                y: { type: 'linear', position: 'left', grid: { color: 'rgba(148,163,184,0.10)' }, ticks: tick, title: { display: true, text: titleText, color: qcAxisTickColor(), font: { family: "'Manrope', sans-serif", size: 11, weight: '600' } },
                     afterDataLimits: s => { const r = s.max - s.min; if (r > 0 && isFinite(r)) s.max += r * 0.10; } }
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
                            // two invisible spacers up front push the row right, fully past the
                            // y axis title and tick labels
                            const spacer = () => ({ text: '', datasetIndex: -1, hidden: false, pointStyle: 'line', lineWidth: 0, fillStyle: 'rgba(0,0,0,0)', strokeStyle: 'rgba(0,0,0,0)', fontColor: 'rgba(0,0,0,0)' });
                            items.unshift(spacer(), spacer());
                            return items;
                        } },
                    onClick: (e, item, legend) => { if (item.datasetIndex == null || item.datasetIndex < 0) return; const ci = legend.chart; ci.setDatasetVisibility(item.datasetIndex, !ci.isDatasetVisible(item.datasetIndex)); ci.update('none'); } },
                // parsed.x is the axis-second index even on decimated data (dataIndex is not).
                // the deviation band datasets are scenery, not sensors; keep them out of the tooltip.
                // the picked sensor leads in bold; the other visible sensors' raw values at that
                // same second follow in the footer, so the cross-sensor comparison stays
                tooltip: {
                    filter: item => !item.dataset.$qcBand,
                    bodyFont: { family: "'IBM Plex Mono', monospace", size: 11, weight: '700' },
                    footerFont: { family: "'IBM Plex Mono', monospace", size: 10, weight: '400' },
                    footerColor: '#94a3b8',
                    callbacks: {
                        title: (items) => items.length ? ((qcTimeLabels && qcTimeLabels[Math.round(items[0].parsed.x)]) || '') + ' UTC' : '',
                        label: item => (item.dataset.label || '') + ': ' + (item.parsed.y === item.parsed.y ? qcRound(item.parsed.y, 3) : 'no data'),
                        footer: (items) => {
                            if (!items.length) return '';
                            const it = items[0], ch = it.chart, i = Math.round(it.parsed.x);
                            const lines = [];
                            ch.data.datasets.forEach((d, k) => {
                                if (d.$qcBand || k === it.datasetIndex || !d.$full || !ch.isDatasetVisible(k)) return;
                                const v = d.$full[i];
                                lines.push((d.label || '') + ': ' + (v === v ? qcRound(v, 3) : 'no data'));
                            });
                            return lines;
                        }
                    }
                },
                zoom: {
                    zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x',
                            drag: { enabled: false, backgroundColor: 'rgba(91,157,255,0.14)', borderColor: '#5b9dff', borderWidth: 1 },
                            onZoomStart: ({ chart }) => qcPushZoomState(chart),
                            onZoomComplete: ({ chart }) => qcZoomChanged(chart) },
                    pan: { enabled: true, mode: 'xy',
                           onPanStart: ({ chart }) => qcPushZoomState(chart),
                           onPanComplete: ({ chart }) => qcZoomChanged(chart) },
                    // pan/zoom stay inside the flight window on x; y roams free (reset brings it back)
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

    // ---- html legend bar: group chips, per-variable checkboxes, std dev toggle -----------------
    // flip to false to fall back to the chart.js canvas legend exactly as before
    const QC_HTML_LEGEND = true;
    const qcBandPrefs = {};            // fam.key -> band on/off, remembered for the session
    const QC_BAND_FILL = 'rgba(148, 163, 184, 0.20)';

    // split a family's direct sensors from their blended GPS counterparts (the same heuristic the
    // auto-uncheck logic uses); null when the family has only one kind
    function qcSplitGroups(names) {
        let test = null;
        if (names.some(n => /I-GPS/.test(n)) && names.some(n => !/I-GPS/.test(n))) test = n => /I-GPS/.test(n);
        else if (names.some(n => /GPS/.test(n)) && names.some(n => !/GPS/.test(n))) test = n => /GPS/.test(n);
        if (!test) return null;
        const a = names.filter(n => !test(n)), b = names.filter(test);
        return [{ label: qcNameStem(a), names: a }, { label: qcNameStem(b), names: b }];
    }
    function qcNameStem(names) {
        let p = names[0] || '';
        names.forEach(n => { let i = 0; while (i < p.length && p[i] === n[i]) i++; p = p.slice(0, i); });
        return p.replace(/[.\-_]+$/, '') || 'group';
    }

    // mean plus/minus one standard deviation at each second across the given series; NaN (band
    // break) wherever fewer than two sensors carry a value
    function qcBandSeries(seriesList, n) {
        const up = new Float32Array(n), lo = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            let s = 0, s2 = 0, c = 0;
            for (let k = 0; k < seriesList.length; k++) { const v = seriesList[k][i]; if (!Number.isNaN(v)) { s += v; s2 += v * v; c++; } }
            if (c >= 2) { const m = s / c, sd = Math.sqrt(Math.max(0, s2 / c - m * m)); up[i] = m + sd; lo[i] = m - sd; }
            else { up[i] = NaN; lo[i] = NaN; }
        }
        return { up: up, lo: lo };
    }

    // rebuild the band datasets from the currently visible similar sensors (ref and derived lines
    // are excluded: the ref duplicates a member and would double-count it)
    function qcUpdateBand(chart) {
        const ds = chart.data.datasets;
        for (let i = ds.length - 1; i >= 0; i--) if (ds[i].$qcBand) ds.splice(i, 1);
        chart.$qcBandStats = null;
        if (chart.$qcBandOn) {
            const series = [];
            ds.forEach((d, k) => { if (!d.$qcIsRef && !d.$qcIsDerived && d.$full && chart.isDatasetVisible(k)) series.push(d.$full); });
            if (series.length >= 2) {
                const band = qcBandSeries(series, qcTimeLabels.length);
                // headline numbers for the legend: mean sigma over the flight and the worst moment
                let sSum = 0, sN = 0, sMax = -1, sMaxI = -1;
                for (let i = 0; i < band.up.length; i++) {
                    const sd = (band.up[i] - band.lo[i]) / 2;
                    if (sd === sd) { sSum += sd; sN++; if (sd > sMax) { sMax = sd; sMaxI = i; } }
                }
                if (sN) chart.$qcBandStats = { mean: (sSum / sN).toFixed(2), max: sMax.toFixed(2), at: (qcTimeLabels && qcTimeLabels[sMaxI]) || '' };
                const common = { parsing: false, normalized: true, pointRadius: 0, pointHitRadius: 0, borderWidth: 0, spanGaps: false, $qcBand: true, borderColor: 'rgba(0,0,0,0)' };
                ds.push(Object.assign({ label: 'std dev upper', data: [], $full: band.up, fill: false }, common));
                ds.push(Object.assign({ label: 'std dev', data: [], $full: band.lo, fill: '-1', backgroundColor: QC_BAND_FILL }, common));
            }
        }
        qcRefreshResolution(chart);
        chart.update('none');
    }

    function qcRenderHtmlLegend(chart, fam) {
        const bar = chart.$qcLegendBar; if (!bar) return;
        bar.innerHTML = '';
        // inset the row by the chart's measured y axis width, so the first entry always starts
        // past the axis title and tick labels no matter how wide the numbers run
        const yw = chart.scales && chart.scales.y && chart.scales.y.width;
        if (yw) bar.style.paddingLeft = Math.round(yw + 6) + 'px';
        const ds = chart.data.datasets;
        const rerender = () => { qcUpdateBand(chart); qcRenderHtmlLegend(chart, fam); };
        const mkItem = (d, k) => {
            const on = chart.isDatasetVisible(k);
            const it = document.createElement('button'); it.type = 'button'; it.className = 'qc-lg-item' + (on ? '' : ' off');
            it.title = (on ? 'Unselect ' : 'Select ') + (d.$qcName || d.label);
            const box = document.createElement('span'); box.className = 'qc-lg-box' + (on ? '' : ' off');
            if (on) { box.style.background = String(d.borderColor); box.style.borderColor = String(d.borderColor); }
            const txt = document.createElement('span'); txt.textContent = d.label;
            it.appendChild(box); it.appendChild(txt); it.$txt = txt;
            it.addEventListener('click', () => { chart.setDatasetVisibility(k, !chart.isDatasetVisible(k)); rerender(); });
            return it;
        };
        // each group is one cluster: its chip with that group's own variables right after it,
        // instead of every variable pooling at the end of the row. chips swap exclusively.
        const grouped = new Set();
        (chart.$qcGroups || []).forEach(g => g.names.forEach(n => grouped.add(n)));
        (chart.$qcGroups || []).forEach(g => {
            const cluster = document.createElement('span'); cluster.className = 'qc-lg-group';
            const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'qc-lg-chip';
            chip.textContent = g.label;
            chip.title = 'Show only the ' + g.label + ' sensors (the other group unselects)';
            const idx = []; ds.forEach((d, k) => { if (!d.$qcBand && g.names.includes(d.$qcName)) idx.push(k); });
            chip.classList.toggle('active', idx.length > 0 && idx.every(k => chart.isDatasetVisible(k)));
            chip.addEventListener('click', () => {
                ds.forEach((d, k) => {
                    if (d.$qcBand || d.$qcIsRef || d.$qcIsDerived || !d.$qcName) return;
                    chart.setDatasetVisibility(k, g.names.includes(d.$qcName));
                });
                rerender();
            });
            cluster.appendChild(chip);
            ds.forEach((d, k) => { if (!d.$qcBand && g.names.includes(d.$qcName)) cluster.appendChild(mkItem(d, k)); });
            bar.appendChild(cluster);
        });
        // ref, derived, and ungrouped variables follow on their own. the ref gets its source
        // sequence right beside it: one chip per segment in ride order, clickable to jump to the
        // takeover moment, with the segment under the playhead highlighted live (qcSyncRefSources)
        ds.forEach((d, k) => {
            if (d.$qcBand || grouped.has(d.$qcName)) return;
            const it = mkItem(d, k);
            bar.appendChild(it);
            if (d.$qcIsRef && chart.$qcRefSegs && chart.$qcRefSegs.length) {
                chart.$qcRefName = d.$qcName; chart.$qcRefTxt = it.$txt; chart.$qcRefActive = null;
                const seq = document.createElement('span'); seq.className = 'qc-ref-seq';
                chart.$qcRefSegs.forEach((s, si) => {
                    const src = document.createElement('button'); src.type = 'button'; src.className = 'qc-ref-src';
                    src.textContent = (chart.$qcRefSegs.length > 1 ? (si + 1) + ' ' : '') + s.source;
                    src.title = 'Ref rides ' + s.source + ' from ' + ((qcTimeLabels && qcTimeLabels[s.fromIdx]) || '') + ' to ' + ((qcTimeLabels && qcTimeLabels[s.toIdx]) || '') + '. Click to jump there.';
                    src.addEventListener('click', () => { if (typeof qcJumpToSecond === 'function' && qcAxisRef) qcJumpToSecond(Math.round(qcAxisRef[s.fromIdx])); });
                    seq.appendChild(src);
                });
                bar.appendChild(seq);
                chart.$qcRefSeqEl = seq;
            }
        });
        // std dev toggle: a family with a single sensor has nothing to compare, so no button at all
        let totalMembers = 0, visMembers = 0;
        ds.forEach((d, k) => { if (!d.$qcBand && !d.$qcIsRef && !d.$qcIsDerived) { totalMembers++; if (chart.isDatasetVisible(k)) visMembers++; } });
        if (totalMembers >= 2) {
            const bt = document.createElement('button'); bt.type = 'button'; bt.className = 'qc-lg-chip qc-lg-band';
            bt.textContent = 'std dev';
            bt.title = 'Shade the mean plus or minus one standard deviation across the visible similar sensors';
            bt.classList.toggle('active', !!chart.$qcBandOn);
            if (visMembers < 2) { bt.disabled = true; bt.title = 'Needs at least 2 similar sensors selected'; }
            bt.addEventListener('click', () => {
                chart.$qcBandOn = !chart.$qcBandOn;
                if (fam) qcBandPrefs[fam.key] = chart.$qcBandOn;
                rerender();
            });
            bar.appendChild(bt);
            // the band earns its keep with numbers: whole-flight average disagreement plus the
            // worst moment, so a widening band has a figure and a timestamp behind it
            if (chart.$qcBandOn && chart.$qcBandStats) {
                const st = chart.$qcBandStats;
                const info = document.createElement('span'); info.className = 'qc-lg-bandinfo';
                info.textContent = 'mean σ ' + st.mean + ' · max σ ' + st.max + ' at ' + st.at;
                info.title = 'Average disagreement (one standard deviation) across the flight, and the worst moment';
                bar.appendChild(info);
            }
        }
        qcSyncRefSources();   // seed the ref source highlight for the current playhead
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
        // the ref linkage lives in the legend bar (source sequence chips + a live label that
        // follows the playhead), so the dataset label itself stays plain for tooltips
        const refInfo = famModel.refInfo;
        const refLabel = m => m.name + ' (ref)';
        const datasets = plotted.map((m, k) => ({
            label: m.isRef ? refLabel(m) : m.name + (m.isDerived ? ' (deriv.)' : ''),
            $qcName: m.name, $qcIsRef: !!m.isRef, $qcIsDerived: !!m.isDerived,
            data: qcDecimate(m.series, first, last), $full: m.series, parsing: false, normalized: true,
            borderColor: m.isRef ? qcRefColor() : QC_SERIES_COLORS[k % QC_SERIES_COLORS.length],
            $qcBaseWidth: m.isRef ? 1.9 : 1.4, borderWidth: m.isRef ? 1.9 : 1.4,
            borderDash: m.isDerived ? [4, 3] : [], pointRadius: 0, pointHitRadius: 6, fill: false, spanGaps: false,
            hidden: !!(startUnchecked && !m.isRef && !m.isDerived && startUnchecked(m.name))
        }));
        const opts = qcChartOptions(fam.label + ' (' + qcUnitLabel(fam.unit) + ')');
        if (QC_HTML_LEGEND) opts.plugins.legend.display = false;
        const chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: datasets }, options: opts, plugins: [qcOverlayPlugin] });
        chart.$qcGapRanges = qcFamilyGapRanges(plotted.map(m => m.series), qcTimeLabels.length);
        // per-member in-flight gaps, for the caret markers drawn by the overlay plugin
        const gapMarks = [];
        plotted.forEach(m => (m.gaps || []).forEach(g => { if (g.fromIdx != null) gapMarks.push({ fromIdx: g.fromIdx, toIdx: g.toIdx }); }));
        chart.$qcGapMarks = gapMarks;
        // implausible-value regions (the engine's Check flags), shaded red by the overlay
        const checkMarks = [];
        plotted.forEach(m => (m.checks || []).forEach(g => checkMarks.push({ fromIdx: g.fromIdx, toIdx: g.toIdx })));
        checkMarks.sort((a, b) => a.fromIdx - b.fromIdx);
        chart.$qcCheckMarks = checkMarks;
        chart.$qcAllEmpty = plotted.length > 0 && plotted.every(m => !m.count);
        chart.$qcRefSegs = (refInfo && refInfo.segments) || [];
        chart.$qcFam = fam;
        if (QC_HTML_LEGEND) {
            chart.$qcGroups = qcSplitGroups(groupNames);
            chart.$qcBandOn = !!qcBandPrefs[fam.key];
            chart.$qcLegendBar = document.createElement('div');
            chart.$qcLegendBar.className = 'qc-legend-bar';
            if (chart.$qcBandOn) qcUpdateBand(chart);
            qcRenderHtmlLegend(chart, fam);
        }
        qcWireCanvas(canvas, chart);
        return chart;
    }

    function qcBuildDiffChart(canvas, fam, famModel) {
        // every combination WITHIN a sensor group (3 sensors -> 1-2, 1-3, 2-3), plus cross-group
        // pairs for curiosity's sake (unchecked by default, labeled as cross group). the ref and
        // derived channels stay out: the ref duplicates a member and would compare as zero.
        const members = famModel.members.filter(m => m.series && !m.isRef && !m.isDerived);
        const names = members.map(m => m.name);
        const bySensor = {}; members.forEach(m => { bySensor[m.name] = m.series; });
        const groups = (typeof qcSplitGroups === 'function' && qcSplitGroups(names)) || null;
        const groupOf = n => (groups && groups[1] && groups[1].names.includes(n)) ? 1 : 0;
        const pairs = [];
        for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++)
            pairs.push({ a: names[i], b: names[j], cross: groupOf(names[i]) !== groupOf(names[j]) });
        pairs.sort((p, q) => (p.cross ? 1 : 0) - (q.cross ? 1 : 0));   // within-group first
        const plotted = pairs.map(p => {
            const d = qcDiff(bySensor[p.a], bySensor[p.b]);
            return { id: p.a + ' ≠ ' + p.b, series: d.series, max: d.max, cross: p.cross };
        });
        const last = qcTimeLabels.length - 1, first = 0;
        // one pair at a time: the first within-group pair starts checked, the rest unchecked.
        // max diffs live in the list under the graph, so legend entries stay short.
        const datasets = plotted.map((d, k) => ({
            label: d.id + (d.cross ? ' (cross group)' : ''),
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
            if (k == null || k < 0) return;
            if (ci.isDatasetVisible(k)) ci.setDatasetVisibility(k, false);
            else ci.data.datasets.forEach((_, j) => ci.setDatasetVisibility(j, j === k));
            ci.update('none');
        };
        const chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: datasets }, options: opts, plugins: [qcOverlayPlugin] });
        chart.$qcDiffPairs = plotted;
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
              '<div id="qcDiffModalBody"></div>' +
              '<div id="qcDiffModalBadges" class="qc-badge-stack" style="margin-top:8px"></div>' +
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
        const body = m.querySelector('#qcDiffModalBody'); body.innerHTML = '';
        const bar = document.createElement('div'); bar.className = 'qc-graph-bar';
        const wrap = document.createElement('div'); wrap.className = 'qc-canvas-wrap'; wrap.style.height = '52vh';
        const cv = document.createElement('canvas'); wrap.appendChild(cv);
        body.appendChild(bar); body.appendChild(wrap);
        m.style.display = 'flex';
        const chart = qcBuildDiffChart(cv, fam, fam);
        qcDiffModalChartKey = 'qc_' + fam.key + '_d';
        qcCharts[qcDiffModalChartKey] = chart;      // joins playhead sync, linked zoom, theming
        // every within-group combination's max diff, listed under the graph
        m.querySelector('#qcDiffModalBadges').innerHTML = (chart.$qcDiffPairs || []).filter(p => !p.cross)
            .map(p => '<span class="qc-badge">' + p.id + ' Max Diff: ' + (Number.isNaN(p.max) ? 'n/a' : p.max) + '</span>').join('');
        const hint = document.createElement('span'); hint.className = 'qc-legend-hint';
        hint.textContent = 'Click a pair to view it alone, click again to unselect it';
        const tools = document.createElement('div'); tools.className = 'qc-graph-tools-group';
        bar.appendChild(hint); bar.appendChild(tools);
        tools.appendChild(qcBuildToolbar(chart));
        wrap.appendChild(qcBuildCornerTools(chart, fam.key + '_diff.png'));
        wrap.appendChild(qcBuildResetFloat(chart));
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

        // sfmr families sink to the bottom of the column; everything else keeps catalog order
        const famsOrdered = qcResult.families.slice().sort((a, b) => (/^sfmr/.test(a.key) ? 1 : 0) - (/^sfmr/.test(b.key) ? 1 : 0));
        famsOrdered.forEach(fam => {
            const hasMain = fam.members.some(m => m.series);
            const hasDiff = fam.diffs.some(d => d.series);
            if (!hasMain && !hasDiff) {
                // whole family absent: say so in place instead of silently skipping the panel
                const empty = document.createElement('div'); empty.className = 'qc-chart-panel';
                empty.id = 'qcpanel_' + fam.key;
                empty.innerHTML = '<div class="qc-chart-head"><span class="qc-chart-title">' + fam.label + '</span>' +
                    '<span class="qc-unit">' + qcUnitLabel(fam.unit) + '</span></div>' +
                    '<div class="qc-nodata-box">NO DATA</div>';
                container.appendChild(empty);
                return;
            }

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
                hint.textContent = 'You can click on any group or individual sensor to select/unselect it.';
                const tools = document.createElement('div'); tools.className = 'qc-graph-tools-group';
                bar.appendChild(hint); bar.appendChild(tools);
                panel.appendChild(bar); panel.appendChild(c);
                const chart = qcCharts[key] = build(cv);
                // the html legend row (group chips, variable checkboxes, std dev) sits between
                // the toolbar row and the canvas
                if (chart.$qcLegendBar) panel.insertBefore(chart.$qcLegendBar, c);
                tools.appendChild(qcBuildToolbar(chart));
                c.appendChild(qcBuildCornerTools(chart, pngName));
                c.appendChild(qcBuildResetFloat(chart));
            };
            container.appendChild(panel);
            if (hasMain) addGraph('qc-canvas-wrap', 'qc_' + fam.key, fam.key + '.png', cv => qcBuildMainChart(cv, fam, fam));
            if (hasDiff) {
                // the difference graph opens in a modal (space saver); max diffs stay visible here
                const dh = document.createElement('div'); dh.className = 'qc-diff-head';
                // the button and its small + graph prompt stack in one column, so the prompt sits
                // right under the button and reads as "this builds a graph"
                const btnCol = document.createElement('div'); btnCol.className = 'qc-diff-btncol';
                const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'qc-ov-btn';
                btn.textContent = 'Difference Between Sensors';
                btn.title = 'Open this family\'s difference graph';
                btn.addEventListener('click', () => qcOpenDiffModal(fam.key));
                btnCol.appendChild(btn);
                const dp = document.createElement('button'); dp.type = 'button'; dp.className = 'qc-diff-create';
                dp.innerHTML = '<span class="qc-diff-plus">＋</span><span>graph</span>';
                dp.title = 'Open this family\'s difference graph';
                dp.addEventListener('click', () => qcOpenDiffModal(fam.key));
                btnCol.appendChild(dp);
                dh.appendChild(btnCol);
                // no max diffs out here: the full within-group combination list lives under the
                // graph inside the modal, so the corner hugs just the button pair
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
    function qcBuildToolbar(chart) {
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
        setActive(scrubBtn);
        qcSetTool(chart, 'scrub');
        return tb;
    }

    // reset zoom floats at the bottom of the graph and only appears while the view is zoomed,
    // recenter-on-aircraft style; living inside the canvas wrap it stays reachable in fullscreen
    function qcBuildResetFloat(chart) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'qc-reset-float';
        b.textContent = '⟲ Reset Zoom';
        b.title = 'Zoom all the way back out to the default full flight view (double-click the graph, or ctrl+z steps back)';
        b.addEventListener('click', () => qcResetChart(chart));
        chart.$qcResetBtn = b;
        return b;
    }

    // fullscreen + png save ride the top right corner of the graph itself, apart from the toolbar
    // (and, living inside the canvas wrap, they stay reachable in fullscreen)
    function qcBuildCornerTools(chart, pngName) {
        const c = document.createElement('div'); c.className = 'qc-graph-corner';
        const png = document.createElement('button'); png.type = 'button'; png.className = 'qc-fs-btn';
        png.innerHTML = QC_TOOL_ICONS.png; png.title = 'Save this graph as a PNG image';
        png.addEventListener('click', () => { try { const a = document.createElement('a'); a.href = chart.toBase64Image(); a.download = pngName; a.click(); } catch (e) {} });
        const fs = document.createElement('button'); fs.type = 'button'; fs.className = 'qc-fs-btn';
        fs.textContent = '⛶'; fs.title = 'Fullscreen this graph';
        fs.addEventListener('click', () => qcToggleGraphFullscreen(chart));
        c.appendChild(png); c.appendChild(fs);
        return c;
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
                // the ref line follows the theme too (white on dark, ink on light)
                c.data.datasets.forEach(d => { if (d.$qcIsRef) d.borderColor = qcRefColor(); });
                c.update('none');
                if (c.$qcLegendBar) qcRenderHtmlLegend(c, c.$qcFam);
            } catch (e) {}
        });
    }
    // the theme toggle stamps data-theme on <html>; recolor whenever it changes
    new MutationObserver(qcApplyChartTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // compact issue strip under a chart head: absent members, in-flight gaps (clickable jump),
    // ground gaps (dimmed, informational). shows the first few, the rest behind a "+N more" toggle.
    function qcBuildIssueStrip(fam) {
        const chips = [];
        const counts = { check: 0, gap: 0, nodata: 0, late: 0, early: 0 };
        fam.members.forEach(m => {
            // the reason already names the sensor, so the chip does not repeat it
            (m.checks || []).forEach(c => { counts.check++; chips.push({ rank: 0, cls: 'qc-issue-check', jump: Math.round(qcAxisRef ? qcAxisRef[c.fromIdx] : 0), text: 'Check: ' + c.reason + ' at ' + (qcTimeLabels ? qcTimeLabels[c.fromIdx] : '') }); });
            if (m.presence === 'nodata') { counts.nodata++; chips.push({ rank: 2, cls: 'qc-issue-nodata', text: m.name + ' no data' }); }
            (m.gaps || []).forEach(g => { counts.gap++; chips.push({ rank: 1, cls: 'qc-issue-gap', jump: Math.round(g.from), text: m.name + ' gap ' + qcSecToLabel(g.from) + ' - ' + qcSecToLabel(g.to) + ' (' + (g.effSecs || g.secs) + ' s)' }); });
            if (m.lateStart) { counts.late++; chips.push({ rank: 3, cls: 'qc-issue-note', jump: Math.round(m.lateStart.at), text: m.name + ' started late by ' + m.lateStart.secs + ' s' }); }
            if (m.earlyStop) { counts.early++; chips.push({ rank: 3, cls: 'qc-issue-note', jump: Math.round(m.earlyStop.at), text: m.name + ' stopped early by ' + m.earlyStop.secs + ' s' }); }
        });
        if (!chips.length) return null;
        // check regions outrank everything, then real gaps, absent members, and the late start /
        // early stop notes, so the important chips never hide behind the "+N more" toggle
        chips.sort((a, b) => a.rank - b.rank);
        const wrap = document.createElement('div'); wrap.className = 'qc-issues';
        const VISIBLE = 3;
        const mkChip = (c, hidden) => {
            const el = document.createElement('span');
            el.className = 'qc-issue ' + c.cls + (hidden ? ' qc-issue-hidden' : '');
            el.textContent = c.text;
            if (c.jump != null) { el.classList.add('qc-issue-jump'); el.title = 'Jump the map and timeline to this moment'; el.addEventListener('click', () => qcJumpToSecond(c.jump)); }
            wrap.appendChild(el);
        };
        chips.slice(0, VISIBLE).forEach(c => mkChip(c, false));
        if (chips.length > VISIBLE) {
            // the toggle sits BEFORE the expandable chips, so with thousands expanded "less" is
            // still right here at the top, no scrolling back down to collapse them
            const more = document.createElement('span');
            more.className = 'qc-issue qc-issue-more'; more.textContent = '+' + (chips.length - VISIBLE) + ' more';
            more.addEventListener('click', () => {
                const open = wrap.classList.toggle('qc-issues-open');
                more.textContent = open ? 'less' : '+' + (chips.length - VISIBLE) + ' more';
                // expanded: the totals move to the very top, clear of the toggle and the chip
                // flood; collapsed: back to their spot under the toggle row
                if (open) wrap.insertBefore(sumEl, wrap.firstChild);
                else wrap.insertBefore(sumEl, more.nextSibling);
            });
            wrap.appendChild(more);
            // totals at a glance, so nobody scrolls a thousand chips just to count them; each
            // kind wears its own issue color. rides directly under the toggle, above the flood
            const totals = [];
            if (counts.check) totals.push('<span class="qc-tot-check">' + counts.check + ' check region' + (counts.check === 1 ? '' : 's') + '</span>');
            if (counts.gap) totals.push('<span class="qc-tot-gap">' + counts.gap + ' gap' + (counts.gap === 1 ? '' : 's') + '</span>');
            if (counts.nodata) totals.push('<span class="qc-tot-nodata">' + counts.nodata + ' with no data</span>');
            if (counts.late) totals.push('<span class="qc-tot-note">' + counts.late + ' late start' + (counts.late === 1 ? '' : 's') + '</span>');
            if (counts.early) totals.push('<span class="qc-tot-note">' + counts.early + ' early stop' + (counts.early === 1 ? '' : 's') + '</span>');
            const sumEl = document.createElement('div');
            sumEl.className = 'qc-issue-totals';
            sumEl.innerHTML = '<span class="qc-totals-pill">all flags: ' + totals.join(', ') + '</span>';
            wrap.appendChild(sumEl);
            chips.slice(VISIBLE).forEach(c => mkChip(c, true));
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
        qcSyncRefSources();
    }

    // live ref linkage: the source chip whose segment sits under the playhead is highlighted, and
    // the ref's legend label names it. cheap no-op when the active segment has not changed.
    function qcSyncRefSources() {
        if (qcScrubIdx == null) return;
        Object.values(qcCharts).forEach(c => {
            if (!c || !c.$qcRefSeqEl || !c.$qcRefSegs || !c.$qcRefSegs.length) return;
            let ai = -1;
            for (let k = 0; k < c.$qcRefSegs.length; k++) { const s = c.$qcRefSegs[k]; if (qcScrubIdx >= s.fromIdx && qcScrubIdx <= s.toIdx) { ai = k; break; } }
            if (c.$qcRefActive === ai) return;
            c.$qcRefActive = ai;
            [...c.$qcRefSeqEl.children].forEach((el, k) => el.classList.toggle('active', k === ai));
            if (c.$qcRefTxt) c.$qcRefTxt.textContent = (c.$qcRefName || 'ref') + (ai >= 0 ? ': ' + c.$qcRefSegs[ai].source : ' (ref)');
        });
    }

    function qcDestroyCharts() { Object.values(qcCharts).forEach(c => { try { c.destroy(); } catch (e) {} }); qcCharts = {}; }
