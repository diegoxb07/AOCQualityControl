/* QC Mode, family panels + difference sub-plots
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Each catalog family draws one main panel overlaying every member and its reference, plus a
   difference sub-panel whose badges carry each pair's max diff. Charts read the raw arrays on
   the continuous 1-second axis, so gaps render as real breaks. Chart.js overlay plugins draw
   the gap shading and markers, the check regions, and the playhead line. */

    let qcCharts = {};                 // canvasId -> Chart instance
    let qcTimeLabels = null;           // HH:MM:SS label per axis second, built once per flight
    let qcAxisRef = null;              // the active qcResult.timeAxis, for playhead second->index mapping
    let qcActiveChart = null;          // chart under the cursor / last interacted, for ctrl+z undo
    let qcPhaseMarks = null;           // { toIdx, landIdx }: takeoff/landing markers + slide bounds
    // ONE playhead, one owner: qcScrubIdx is the single source of truth for "the current second".
    // the graph line draws from it, the map and clock FOLLOW it (qcDrivePlayer), and the only thing
    // that moves it automatically is active playback (the player wrapper mirrors its row into it).
    let qcScrubIdx = null;             // playhead axis index (seconds since recording start)
    let qcMiniRange = null, qcMiniTime = null;   // the flight-track map's mini timeslider (a follower)

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
    // another; kept very faint so the pillar marks the spot without covering the traces
    const QC_GAP_FILL = 'rgba(240, 190, 60, 0.10)';

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

    // arrow keys slide the playhead: left/right one second, shift for ten
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
            // gap shading: ONE pillar per gap region (whole-family holes + every per-member gap
            // merged into clusters), so two sensors sharing a gap read as a single band. a one
            // second gap draws as a thin 2px line (zooming in grows it to its true width).
            const clusters = chart.$qcGapClusters || [];
            ctx.fillStyle = QC_GAP_FILL;
            clusters.forEach(g => {
                const x0 = xa.getPixelForValue(g.fromIdx), x1 = xa.getPixelForValue(g.toIdx);
                if (x1 < area.left || x0 > area.right) return;
                const left = Math.max(x0, area.left);
                ctx.fillRect(left, area.top, Math.max(2, Math.min(x1, area.right) - left), area.bottom - area.top);
            });
            // darker where 2+ sensors gap at the SAME time: sweep the per-member gaps into depth
            // segments and lay extra fills (capped) over the overlaps, so a shared gap reads darker
            // than a single sensor's. the base pillars above already cover every gap once.
            const memMarks = chart.$qcGapMarks || [];
            if (memMarks.length > 1) {
                const evs = [];
                memMarks.forEach(g => { if (g.fromIdx != null && g.toIdx >= g.fromIdx) { evs.push([g.fromIdx, 1]); evs.push([g.toIdx + 1, -1]); } });
                evs.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
                let depth = 0, segStart = null;
                for (let si = 0; si < evs.length; si++) {
                    if (segStart != null && evs[si][0] > segStart && depth >= 2) {
                        const x0 = xa.getPixelForValue(segStart), x1 = xa.getPixelForValue(evs[si][0]);
                        if (x1 >= area.left && x0 <= area.right) {
                            const left = Math.max(x0, area.left), w = Math.max(1, Math.min(x1, area.right) - left);
                            for (let k = 0, layers = Math.min(depth - 1, 2); k < layers; k++) ctx.fillRect(left, area.top, w, area.bottom - area.top);
                        }
                    }
                    depth += evs[si][1];
                    segStart = evs[si][0];
                }
            }
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
            // hundreds sit close they simply merge into a band. gap carets carry NO word (the
            // legend row defines the marker once instead of spamming the plot); check carets keep
            // theirs since they are rare and urgent
            const drawCarets = (ranges, fill, word) => {
                ctx.fillStyle = fill;
                ctx.font = "8px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                let lastWordX = -Infinity;
                ranges.forEach(g => {
                    const x0 = Math.max(xa.getPixelForValue(g.fromIdx), area.left), x1 = Math.min(xa.getPixelForValue(g.toIdx), area.right);
                    if (x1 < x0) return;
                    const cx = (x0 + x1) / 2;
                    // fixed HEIGHT, but the base spreads to the ends of a wide gap so a large gap
                    // gets a wide marker (small gaps keep the 5px minimum); the apex depth is constant
                    const hw = Math.max(5, (x1 - x0) / 2);
                    ctx.beginPath();
                    ctx.moveTo(cx - hw, area.top + 1); ctx.lineTo(cx + hw, area.top + 1); ctx.lineTo(cx, area.top + 9);
                    ctx.closePath(); ctx.fill();
                    if (word && cx - lastWordX >= 22) { ctx.fillText(word, cx, area.top + 11); lastWordX = cx; }
                });
                ctx.textAlign = 'left';
            };
            const light = document.documentElement.dataset.theme === 'light';
            // one caret per merged cluster (not one per sensor); the hover names the sensor(s)
            drawCarets(clusters, light ? 'rgba(170, 120, 20, 0.95)' : 'rgba(240, 190, 60, 0.95)', '');
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
                    // takeoff sits just right of its line; landing is right-aligned just LEFT of its
                    // line so the text clears the dotted line (purely cosmetic — line and time unchanged)
                    if (mk[1] === 'landing') {
                        ctx.textAlign = 'right';
                        ctx.fillText(mk[1], Math.max(x - 3, area.left + 42), area.top + 2);
                        ctx.textAlign = 'left';
                    } else {
                        ctx.fillText(mk[1], Math.min(x + 3, area.right - 42), area.top + 2);
                    }
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
        // a click on a gap or check marker (the triangle in the top strip) jumps the playhead to
        // that range AND zooms the graph into it. only the triangle itself counts (half width
        // 5px, plus a hair): clicking near a marker but not on it just moves the playhead.
        if (a && py != null && py <= a.top + 12) {
            const marks = (chart.$qcGapClusters || []).concat(chart.$qcCheckMarks || []);
            let best = null, bd = Infinity;
            marks.forEach(g => {
                const x0 = Math.max(xa.getPixelForValue(g.fromIdx), a.left), x1 = Math.min(xa.getPixelForValue(g.toIdx), a.right);
                if (x1 < x0) return;
                // the whole (possibly widened) marker is clickable: hit anywhere within its base
                const cx = (x0 + x1) / 2, hw = Math.max(6.5, (x1 - x0) / 2), d = Math.abs(px - cx);
                if (d <= hw && d < bd) { bd = d; best = g; }
            });
            if (best) {
                if (typeof qcJumpToSecond === 'function') qcJumpToSecond(Math.round(qcAxisRef[best.fromIdx]));
                qcZoomToRange(chart, best);
                return;
            }
        }
        const i = qcClampScrub(Math.round(xa.getValueForPixel(px)));
        if (typeof qcJumpToSecond === 'function') qcJumpToSecond(Math.round(qcAxisRef[i]));
    }

    // slide bounds: the playhead can slide through the whole recording, before takeoff included, so the graphs and
    // the flight-track map roam the full range. the flight-context player clamps ITSELF to
    // takeoff..landing through qcPlayheadToRow (a pre-takeoff playhead just shows the takeoff
    // frame), so nothing is pinned here.
    function qcClampScrub(i) {
        return Math.max(0, Math.min(qcAxisRef.length - 1, i));
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
            // slide tool: the playhead follows the cursor from the moment the button goes down.
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
            const area = chart.chartArea;
            if (!area || !qcAxisRef) { tip.classList.add('hidden'); return; }
            const rect = canvas.getBoundingClientRect();
            const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
            // pointer cursor over the caret strip whenever a marker sits under the cursor (the
            // same hit test the click jump uses), so jumpable markers advertise themselves
            let overMark = false;
            const clusters = chart.$qcGapClusters || [];
            if (py >= area.top && py <= area.top + 12 && px >= area.left && px <= area.right) {
                const marks = clusters.concat(chart.$qcCheckMarks || []);
                const xs = chart.scales.x;
                overMark = marks.some(g => {
                    const x0 = Math.max(xs.getPixelForValue(g.fromIdx), area.left), x1 = Math.min(xs.getPixelForValue(g.toIdx), area.right);
                    return x1 >= x0 && Math.abs(px - (x0 + x1) / 2) <= Math.max(6.5, (x1 - x0) / 2);
                });
            }
            canvas.style.cursor = overMark ? 'pointer' : qcToolCursor(chart.$qcTool || 'scrub');
            if (!clusters.length) { tip.classList.add('hidden'); return; }
            if (px < area.left || px > area.right || py < area.top || py > area.bottom) { tip.classList.add('hidden'); return; }
            const x = chart.scales.x;
            const v = x.getValueForPixel(px);
            const tol = Math.max(0.5, (x.max - x.min) / Math.max(1, area.right - area.left));   // a gap thinner than a pixel still hits
            const g = clusters.find(r => v >= r.fromIdx - tol && v <= r.toIdx + tol);
            if (!g) { tip.classList.add('hidden'); return; }
            // name the sensor(s) the marker covers (a few by name, otherwise a count)
            const names = g.names ? Array.from(g.names) : [];
            const who = !names.length ? '' : names.length <= 3 ? names.join(', ') + ' ' : names.length + ' sensors ';
            tip.textContent = who + 'data gap from ' + qcSecToLabel(qcAxisRef[g.fromIdx]) + ' - ' + qcSecToLabel(qcAxisRef[g.toIdx]) + ' (' + (g.toIdx - g.fromIdx + 1) + ' s)';
            tip.style.left = (ev.clientX + 14) + 'px'; tip.style.top = (ev.clientY + 14) + 'px';
            tip.classList.remove('hidden');
        });
        canvas.addEventListener('mouseleave', () => { qcGapTip().classList.add('hidden'); });
    }

    // tool switch on one chart. slide (default): dragging moves the playhead under the cursor.
    // pan: dragging moves the time window. select zoom: dragging draws a zoom box (both axes,
    // like bokeh's BoxZoomTool). wheel zoom stays on in every mode.
    const qcToolCursor = t => t === 'scrub' ? 'ew-resize' : t === 'pan' ? 'grab' : 'crosshair';
    function qcSetTool(chart, tool) {
        chart.$qcTool = tool;
        const z = chart.options.plugins.zoom;
        z.pan.enabled = tool === 'pan';
        z.zoom.drag.enabled = tool === 'box';
        z.zoom.mode = (tool === 'box' || chart.$qcIsMap) ? 'xy' : 'x';
        chart.canvas.style.cursor = qcToolCursor(tool);
        chart.update('none');
    }

    // live slide, atomic: while the button is down ONLY the playhead line moves (pure canvas
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
        // extra pad on top keeps the gap-marker strip clear of the data
        const r = mx - mn;
        return { min: mn - r * 0.06, max: mx + r * 0.16 };
    }

    // after a gesture: re-slice to the new window. a wide y window that flattens every line snaps
    // back to fit the visible data, except after a pan, which must leave the axes where the user put them
    function qcZoomChanged(chart, panned) {
        qcActiveChart = chart;
        qcRefreshResolution(chart);
        if (!panned) {
            try {
                const ext = qcVisibleYExtent(chart);
                if (ext) {
                    const y = chart.scales.y, span = y.max - y.min, fit = ext.max - ext.min;
                    if (span > fit * 1.7) { chart.zoomScale('y', ext, 'none'); chart.update('none'); }
                }
            } catch (e) {}
        }
        qcZoomVisual(chart);
    }

    // zoom the x window into a marked range with breathing room on both sides, y refit to match
    function qcZoomToRange(chart, g) {
        if (!qcAxisRef) return;
        const last = qcAxisRef.length - 1;
        const span = Math.max(1, g.toIdx - g.fromIdx);
        const pad = Math.max(30, Math.round(span * 0.75));
        qcPushZoomState(chart);
        try { chart.zoomScale('x', { min: Math.max(0, g.fromIdx - pad), max: Math.min(last, g.toIdx + pad) }, 'none'); } catch (e) {}
        try { const ext = qcVisibleYExtent(chart); if (ext) chart.zoomScale('y', ext, 'none'); } catch (e) {}
        qcRefreshResolution(chart);
        chart.update('none');
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

    // reset zoom: set the home window with concrete numbers through the plugin's zoomScale api,
    // full flight on x, then y fitted to the data actually visible
    function qcResetChart(chart) {
        if (chart.$qcIsMap) {
            // the map's home is its own lat/lon extents, not the time axis
            try { chart.resetZoom('none'); } catch (e) {}
            try { if (chart.$qcHome) { chart.zoomScale('x', chart.$qcHome.x, 'none'); chart.zoomScale('y', chart.$qcHome.y, 'none'); } } catch (e) {}
            chart.$qcHist = [];
            chart.update('none');
            qcZoomVisual(chart);
            if (chart.$qcResetBtn) chart.$qcResetBtn.classList.remove('show');
            if (chart.$qcSelectTool) chart.$qcSelectTool('pan');
            qcActiveChart = chart;
            return;
        }
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
        // a reset also hands the mouse back to the slide tool, the default
        if (chart.$qcSelectTool) chart.$qcSelectTool('scrub'); else qcSetTool(chart, 'scrub');
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
                // the graphs show the FULL recording (pre-takeoff included); only the playhead is
                // clamped to takeoff..landing, since the 2d/3d player has no rows outside it
                x: { type: 'linear', bounds: 'data', grid: { color: 'rgba(148,163,184,0.08)' }, ticks: xTicks },
                // the top tenth of every graph is reserved: data that reaches its ceiling would
                // otherwise sit under the gap carets and their labels, so the scale grows itself
                y: { type: 'linear', position: 'left', grid: { color: 'rgba(148,163,184,0.10)' }, ticks: tick, title: { display: true, text: titleText, color: qcAxisTickColor(), font: { family: "'Manrope', sans-serif", size: 11, weight: '600' } },
                     // headroom only while the scale is free: once pan or zoom pins explicit
                     // min/max the plugin re-reads the computed range on every gesture step, so
                     // growing it here would compound ten percent per mouse move
                     afterDataLimits: s => { const o = s.options; if (typeof o.min === 'number' || typeof o.max === 'number') return; const r = s.max - s.min; if (r > 0 && isFinite(r)) s.max += r * 0.10; } }
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
                           onPanComplete: ({ chart }) => qcZoomChanged(chart, true) },
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

    // merge overlapping/touching gaps (whole-family holes + every per-member gap) into ONE cluster
    // per gap region, each carrying the SET of sensor names that gap inside it. the overlay draws a
    // single marker per cluster (so two sensors sharing a gap show one marker, not two), and the
    // hover/click read the same clusters so a marker can name which sensor(s) it covers.
    function qcClusterGaps(memMarks, famRanges) {
        const all = (famRanges || []).map(g => ({ fromIdx: g.fromIdx, toIdx: g.toIdx, name: null }))
            .concat(memMarks || [])
            .filter(g => g.fromIdx != null && g.toIdx != null)
            .sort((a, b) => a.fromIdx - b.fromIdx);
        const out = [];
        all.forEach(g => {
            const c = out[out.length - 1];
            if (c && g.fromIdx <= c.toIdx + 1) {          // overlapping or touching -> same cluster
                if (g.toIdx > c.toIdx) c.toIdx = g.toIdx;
                if (g.name) c.names.add(g.name);
            } else {
                out.push({ fromIdx: g.fromIdx, toIdx: g.toIdx, names: new Set(g.name ? [g.name] : []) });
            }
        });
        return out;
    }

    // ---- html legend bar: group chips, per-variable checkboxes, std dev toggle -----------------
    // flip to false to fall back to the chart.js canvas legend exactly as before
    const QC_HTML_LEGEND = true;

    // split a family's direct sensors from their blended GPS counterparts (the same heuristic the
    // auto-uncheck logic uses); null when the family has only one kind
    function qcSplitGroups(names) {
        let test = null;
        if (names.some(n => /I-GPS/.test(n)) && names.some(n => !/I-GPS/.test(n))) test = n => /I-GPS/.test(n);
        else if (names.some(n => /GPS/.test(n)) && names.some(n => !/GPS/.test(n))) test = n => /GPS/.test(n);
        if (!test) return null;
        const a = names.filter(n => !test(n)), b = names.filter(test);
        // one big group is not a split: chips would toggle nothing, so no chips at all
        if (!a.length || !b.length) return null;
        return [{ label: qcNameStem(a), names: a }, { label: qcNameStem(b), names: b }];
    }
    // explicit catalog groups (fam.groups from js/00b) win; the direct-vs-GPS name heuristic
    // covers families without one. group entries filter down to the sensors actually present.
    function qcFamilyLegendGroups(famModel, names) {
        const g = famModel && famModel.groups;
        if (g && g.length === 2) {
            const a = g[0].names.filter(n => names.includes(n)), b = g[1].names.filter(n => names.includes(n));
            if (a.length && b.length) return [{ label: g[0].label, names: a }, { label: g[1].label, names: b }];
            return null;
        }
        return qcSplitGroups(names);
    }

    function qcNameStem(names) {
        if (names.length === 1) return (names[0] || '').replace(/\.[^.]*$/, '') || names[0];
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

    // standard deviation between the visible similar sensors, always computed (no toggle, no
    // shaded band datasets): whole-flight mean sigma plus the worst disagreement moment. ref and
    // derived lines are excluded, since the ref duplicates a member and would double-count it.
    function qcBandStats(chart) {
        const series = [];
        chart.data.datasets.forEach((d, k) => { if (!d.$qcIsRef && !d.$qcIsDerived && d.$full && chart.isDatasetVisible(k)) series.push(d.$full); });
        if (series.length < 2 || !qcTimeLabels) return null;
        const band = qcBandSeries(series, qcTimeLabels.length);
        let sSum = 0, sN = 0, sMax = -1, sMaxI = -1, mSum = 0;
        for (let i = 0; i < band.up.length; i++) {
            const sd = (band.up[i] - band.lo[i]) / 2;
            if (sd === sd) { sSum += sd; sN++; mSum += (band.up[i] + band.lo[i]) / 2; if (sd > sMax) { sMax = sd; sMaxI = i; } }
        }
        if (!sN) return null;
        // coefficient of variation: mean sigma relative to the mean of the measured signal, as a
        // percent. meaningless when the signal averages near zero (vertical wind), so n/a there.
        const grand = Math.abs(mSum / sN);
        const cv = grand > 1e-6 ? ((sSum / sN) / grand * 100).toFixed(4) : null;
        return { mean: (sSum / sN).toFixed(2), max: sMax.toFixed(2), at: qcTimeLabels[sMaxI] || '', cv: cv };
    }

    // a blacked-out legend chip with a small UNAVAILABLE tag, for a sensor with no data this flight —
    // reused both inline in a graph's legend and for a whole graph that has no data in any variable
    function qcUnavailItem(name) {
        const it = document.createElement('span'); it.className = 'qc-lg-item qc-lg-unavail';
        it.title = name + ' — no data for this flight';
        const box = document.createElement('span'); box.className = 'qc-lg-box';
        const txt = document.createElement('span'); txt.textContent = name;
        const tag = document.createElement('span'); tag.className = 'qc-lg-unavail-tag'; tag.textContent = 'UNAVAILABLE';
        it.appendChild(box); it.appendChild(txt); it.appendChild(tag);
        return it;
    }

    function qcRenderHtmlLegend(chart, fam) {
        const bar = chart.$qcLegendBar; if (!bar) return;
        bar.innerHTML = '';
        // inset the row by the chart's measured y axis width, so the first entry always starts
        // past the axis title and tick labels no matter how wide the numbers run
        const yw = chart.scales && chart.scales.y && chart.scales.y.width;
        if (yw) bar.style.paddingLeft = Math.round(yw + 6) + 'px';
        const ds = chart.data.datasets;
        const rerender = () => { chart.update('none'); qcRenderHtmlLegend(chart, fam); };
        const mkItem = (d, k) => {
            const on = chart.isDatasetVisible(k);
            const it = document.createElement('button'); it.type = 'button'; it.className = 'qc-lg-item' + (on ? '' : ' off');
            it.title = (on ? 'Unselect ' : 'Select ') + (d.$qcName || d.label);
            const box = document.createElement('span'); box.className = 'qc-lg-box' + (on ? '' : ' off');
            if (on) { box.style.background = String(d.borderColor); box.style.borderColor = String(d.borderColor); }
            const txt = document.createElement('span'); txt.textContent = d.label;
            it.appendChild(box); it.appendChild(txt);
            it.addEventListener('click', () => { chart.setDatasetVisibility(k, !chart.isDatasetVisible(k)); rerender(); });
            return it;
        };
        // each group is one cluster: its chip with that group's own variables right after it,
        // instead of every variable pooling at the end of the row. chips toggle their own group
        // only, so several groups can be lit on one graph at the same time.
        const grouped = new Set();
        (chart.$qcGroups || []).forEach(g => g.names.forEach(n => grouped.add(n)));
        (chart.$qcGroups || []).forEach(g => {
            const cluster = document.createElement('span'); cluster.className = 'qc-lg-group';
            const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'qc-lg-chip';
            chip.textContent = g.label;
            chip.title = 'Select or unselect the ' + g.label + ' sensors';
            const idx = []; ds.forEach((d, k) => { if (!d.$qcBand && g.names.includes(d.$qcName)) idx.push(k); });
            const allOn = idx.length > 0 && idx.every(k => chart.isDatasetVisible(k));
            chip.classList.toggle('active', allOn);
            chip.addEventListener('click', () => {
                idx.forEach(k => chart.setDatasetVisibility(k, !allOn));
                rerender();
            });
            cluster.appendChild(chip);
            ds.forEach((d, k) => { if (!d.$qcBand && g.names.includes(d.$qcName)) cluster.appendChild(mkItem(d, k)); });
            bar.appendChild(cluster);
        });
        // ref, derived, and ungrouped variables follow on their own. the ref carries a static
        // pipe connector naming every sensor it rode across the flight, in segment order: one
        // name means one source the whole flight, more than one means it switched.
        ds.forEach((d, k) => {
            if (d.$qcBand || grouped.has(d.$qcName)) return;
            const it = mkItem(d, k);
            if (d.$qcIsRef && chart.$qcRefSegs && chart.$qcRefSegs.length) {
                it.classList.add('qc-ref-boxed');   // one box around the ref and its sources
                // pipe glyphs and source names alternate as separate spans, so only the pipes
                // carry the transfer pulse animation while the names stay solid
                chart.$qcRefNameEls = [];
                chart.$qcRefSegs.forEach(seg => {
                    const dash = document.createElement('span'); dash.className = 'qc-ref-pipe'; dash.textContent = '───';
                    const nm = document.createElement('span'); nm.className = 'qc-ref-src-name'; nm.textContent = seg.source;
                    nm.dataset.from = seg.fromIdx;   // the playhead lights the source in force (see qcRefLiveHighlight)
                    it.appendChild(dash); it.appendChild(nm);
                    chart.$qcRefNameEls.push(nm);
                });
                qcRefLiveHighlight();
                it.title += '. This ref rode: ' + chart.$qcRefSegs.map(s => s.source + ' from ' + ((qcTimeLabels && qcTimeLabels[s.fromIdx]) || '')).join(', then ') + '.';
            }
            bar.appendChild(it);
        });
        // no-data members still get a legend slot, blacked out with a small UNAVAILABLE tag, so a
        // missing sensor stays visible instead of silently vanishing (skipped on the fused map legend)
        if (!chart.$qcIsMap && fam && fam.members) {
            const shownNames = new Set(ds.map(d => d.$qcName));
            fam.members.forEach(m => {
                if (shownNames.has(m.name) || m.count) return;   // only members with zero samples
                bar.appendChild(qcUnavailItem(m.name));
            });
        }
        // the standard deviation between the selected sensors, at the right end of the panel's
        // bottom strip. families with fewer than two similar sensors selected list nothing.
        const bandHost = chart.$qcBandSlot || bar;
        if (chart.$qcBandSlot) chart.$qcBandSlot.innerHTML = '';
        const st = qcBandStats(chart);
        if (st) {
            const info = document.createElement('span'); info.className = 'qc-lg-bandinfo';
            const lbl = document.createElement('span'); lbl.textContent = 'Standard Deviation between Selected Sensors: ';
            const val = document.createElement('span'); val.className = 'qc-lg-bandval';
            val.textContent = 'mean σ ' + st.mean + ' · max σ ' + st.max + ' at ' + st.at;
            info.appendChild(lbl); info.appendChild(val);
            info.title = 'Std deviation between the selected sensors';
            bandHost.appendChild(info);
            // coefficient of variation rides right below: disagreement relative to the size of
            // what is being measured, so sensors on big signals compare fairly with small ones
            const cv = document.createElement('span'); cv.className = 'qc-lg-bandinfo';
            const cl = document.createElement('span'); cl.textContent = 'Coefficient of Variation: ';
            const cval = document.createElement('span'); cval.className = 'qc-lg-bandval';
            cval.textContent = st.cv != null ? st.cv + '%' : 'n/a (mean near zero)';
            cv.appendChild(cl); cv.appendChild(cval);
            cv.title = 'Mean sigma as a percent of the mean value';
            bandHost.appendChild(cv);
            // caret note pointing up at the std-dev / coefficient-of-variation figures above, spelling
            // out that both are computed only over the variables currently selected on the graph
            const cvNote = document.createElement('span'); cvNote.className = 'qc-lg-bandnote';
            cvNote.textContent = '^^ (of selected variables)';
            bandHost.appendChild(cvNote);
        }
        // the gap marker is defined ONCE here instead of a word under every caret on the plot
        if ((chart.$qcGapMarks && chart.$qcGapMarks.length) || (chart.$qcGapRanges && chart.$qcGapRanges.length)) {
            const gn = document.createElement('span'); gn.className = 'qc-lg-gapnote';
            gn.innerHTML = '<span class="qc-lg-caret"></span> means there is a gap at that time (click one to jump there and zoom in)';
            bar.appendChild(gn);
        }
    }

    // map panel overlay: faint geography (the visualizer's basemap geojson) under the tracks,
    // takeoff / landing / playhead dots on top. the geography renders into an offscreen cache
    // keyed by the view window, so playhead redraws just blit it.
    const qcMapOverlayPlugin = {
        id: 'qcMapOverlay',
        beforeDatasetsDraw: chart => {
            const area = chart.chartArea, x = chart.scales.x, y = chart.scales.y, ctx = chart.ctx;
            if (!area || typeof mapFeatures === 'undefined' || !mapFeatures.length) return;
            const light = document.documentElement.dataset.theme === 'light';
            // the lake count is in the key so a late async lake load rebuilds the cached geography
            const key = [x.min, x.max, y.min, y.max, chart.width, chart.height, light, (typeof qcLakes !== 'undefined' ? qcLakes.length : 0)].join('|');
            if (chart.$qcGeoKey !== key) {
                chart.$qcGeoKey = key;
                const off = chart.$qcGeoCv || (chart.$qcGeoCv = document.createElement('canvas'));
                off.width = Math.max(1, Math.round(chart.width)); off.height = Math.max(1, Math.round(chart.height));
                const c2 = off.getContext('2d');
                const inView = bb => !bb || !(bb[2] < x.min || bb[0] > x.max || bb[3] < y.min || bb[1] > y.max);
                const addRing = pts => { for (let i = 0; i < pts.length; i++) { const px = x.getPixelForValue(pts[i][0]), py = y.getPixelForValue(pts[i][1]); if (i) c2.lineTo(px, py); else c2.moveTo(px, py); } };
                // fill a feature's polygons, even-odd so inner rings read as holes
                const fillGeom = (g, color) => {
                    if (!g) return; c2.fillStyle = color; c2.beginPath();
                    if (g.type === 'Polygon') g.coordinates.forEach(r => { addRing(r); c2.closePath(); });
                    else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(r => { addRing(r); c2.closePath(); }));
                    else return;
                    c2.fill('evenodd');
                };
                const stroke = g => {
                    if (!g) return;
                    const ring = pts => { c2.beginPath(); addRing(pts); c2.stroke(); };
                    if (g.type === 'Polygon') g.coordinates.forEach(ring);
                    else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(ring));
                    else if (g.type === 'LineString') ring(g.coordinates);
                    else if (g.type === 'MultiLineString') g.coordinates.forEach(ring);
                };
                // classic map look: the whole panel is water (blue), land filled green on top, lakes
                // carved back to water, then coastlines/borders and lake outlines. states are borders
                // over the same land, so they are stroked but not filled (no double-fill).
                const water = light ? '#cfe3f5' : '#122a3e';
                const landFill = light ? '#d6e8cc' : '#1a3622';
                const lakeFill = light ? '#c2ddf2' : '#153a52';
                c2.fillStyle = water; c2.fillRect(0, 0, off.width, off.height);
                mapFeatures.forEach(f => {
                    if (f.properties && f.properties.isState) return;
                    if (!inView(f.properties && f.properties.bbox)) return;
                    fillGeom(f.geometry, landFill);
                });
                if (typeof qcLakes !== 'undefined') qcLakes.forEach(f => { if (inView(f.properties && f.properties.bbox)) fillGeom(f.geometry, lakeFill); });
                // coastlines + country/state borders (a neutral line that reads over both green and blue)
                c2.strokeStyle = light ? 'rgba(60, 90, 75, 0.5)' : 'rgba(150, 190, 165, 0.35)';
                c2.lineWidth = 1;
                mapFeatures.forEach(f => { if (inView(f.properties && f.properties.bbox)) stroke(f.geometry); });
                if (typeof qcLakes !== 'undefined') {
                    c2.strokeStyle = light ? 'rgba(37, 99, 235, 0.35)' : 'rgba(96, 150, 235, 0.32)';
                    qcLakes.forEach(f => { if (inView(f.properties && f.properties.bbox)) stroke(f.geometry); });
                }
            }
            ctx.save();
            ctx.beginPath(); ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top); ctx.clip();
            ctx.drawImage(chart.$qcGeoCv, 0, 0, chart.width, chart.height);
            ctx.restore();
        },
        afterDraw: chart => {
            const area = chart.chartArea, x = chart.scales.x, y = chart.scales.y, ctx = chart.ctx;
            if (!area) return;
            const light = document.documentElement.dataset.theme === 'light';
            // region labels: the state name in the USA, otherwise the country/territory name, one per
            // landmass in view. capped and de-collided (also by name) so the map never clutters.
            if (typeof qcRegionLabels !== 'undefined' && qcRegionLabels.length) {
                ctx.save();
                ctx.beginPath(); ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top); ctx.clip();
                ctx.font = "600 10.5px 'Manrope', ui-sans-serif, system-ui, sans-serif"; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
                const txtC = light ? '#1e293b' : '#e2e8f0', halo = light ? 'rgba(255,255,255,0.9)' : 'rgba(8,15,25,0.85)';
                const placed = [];
                for (let k = 0, shown = 0; k < qcRegionLabels.length && shown < 9; k++) {
                    const p = qcRegionLabels[k];
                    if (p.lon < x.min || p.lon > x.max || p.lat < y.min || p.lat > y.max) continue;
                    const px = x.getPixelForValue(p.lon), py = y.getPixelForValue(p.lat);
                    if (px < area.left + 4 || px > area.right - 4 || py < area.top + 4 || py > area.bottom - 4) continue;
                    if (placed.some(q => q.name === p.name || (Math.abs(q.px - px) < 72 && Math.abs(q.py - py) < 16))) continue;
                    placed.push({ px: px, py: py, name: p.name }); shown++;
                    ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.strokeText(p.name, px, py);
                    ctx.fillStyle = txtC; ctx.fillText(p.name, px, py);
                }
                ctx.textAlign = 'left';
                ctx.restore();
            }
            const la = chart.$qcMapLat, lo = chart.$qcMapLon;
            if (!la || !lo) return;
            const dot = (i, fill, r) => {
                if (i == null || i < 0 || i >= la.length) return;
                const a = la[i], b = lo[i];
                if (Number.isNaN(a) || Number.isNaN(b)) return;
                const px = x.getPixelForValue(b), py = y.getPixelForValue(a);
                if (px < area.left || px > area.right || py < area.top || py > area.bottom) return;
                ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI);
                ctx.fillStyle = fill; ctx.fill();
                ctx.strokeStyle = light ? '#ffffff' : '#0d1117'; ctx.lineWidth = 1.4; ctx.stroke();
            };
            if (qcPhaseMarks) { dot(qcPhaseMarks.toIdx, '#28c76f', 4); dot(qcPhaseMarks.landIdx, '#ea5455', 4); }
            dot(qcScrubIdx, light ? '#0f172a' : '#ffffff', 5);
        }
    };

    // combined latitude + longitude panel: one map style graph like the script's flight track
    // plot. each lat sensor pairs with its lon partner as one track; the ref pair rides on top.
    function qcBuildMapChart(canvas, latFam, lonFam) {
        const lonName = nm => nm === 'LATref' ? 'LONref' : nm.replace(/^Lat/, 'Lon');
        const lonBy = {}; lonFam.members.forEach(m => { lonBy[m.name] = m; });
        const n = qcTimeLabels.length;
        const step = Math.max(1, Math.ceil(n / 3000));
        const pairs = [];
        latFam.members.forEach(m => {
            const lm = lonBy[lonName(m.name)];
            if (m.series && m.count > 0 && lm && lm.series && lm.count > 0) pairs.push({ la: m, lo: lm, isRef: !!m.isRef });
        });
        pairs.sort((a, b) => (b.isRef ? 1 : 0) - (a.isRef ? 1 : 0));   // ref first, drawn on top
        let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
        const mkPts = p => {
            const pts = [];
            for (let i = 0; i < n; i += step) {
                const a = p.la.series[i], b = p.lo.series[i];
                if (Number.isNaN(a) || Number.isNaN(b)) { pts.push({ x: NaN, y: NaN }); continue; }
                if (b < mnx) mnx = b; if (b > mxx) mxx = b; if (a < mny) mny = a; if (a > mxy) mxy = a;
                pts.push({ x: b, y: a, i: i });
            }
            return pts;
        };
        // pair labels match the script's legends exactly: Lat/LonGPS.1, Lat/LonI-GPS.1, Lat/Lonref
        const pairName = p => p.isRef ? 'Lat/Lonref' : 'Lat/' + lonName(p.la.name);
        const datasets = pairs.map((p, k) => ({
            label: pairName(p),
            $qcName: pairName(p), $qcIsRef: p.isRef,
            data: mkPts(p), parsing: false,
            borderColor: p.isRef ? qcRefColor() : QC_SERIES_COLORS[(k + QC_SERIES_COLORS.length - 1) % QC_SERIES_COLORS.length],
            $qcBaseWidth: p.isRef ? 1.9 : 1.4, borderWidth: p.isRef ? 1.9 : 1.4,
            pointRadius: 0, pointHitRadius: 6, fill: false, spanGaps: false, showLine: true, tension: 0
        }));
        if (mnx === Infinity) { mnx = -100; mxx = -60; mny = 0; mxy = 40; }
        const padX = Math.max(0.2, (mxx - mnx) * 0.08), padY = Math.max(0.2, (mxy - mny) * 0.08);
        const tick = { color: qcAxisTickColor(), font: { family: "'IBM Plex Mono', monospace", size: 10 } };
        const axTitle = t => ({ display: true, text: t, color: qcAxisTickColor(), font: { family: "'Manrope', sans-serif", size: 11, weight: '600' } });
        const opts = {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: 'nearest', axis: 'xy', intersect: false },
            // clicking a spot on a track jumps the playhead (and the 2d/3d map) to that moment
            onClick: (e, els, chart) => {
                const ne = e && e.native;
                if (ne && chart.$qcDownX != null && (Math.abs(ne.clientX - chart.$qcDownX) > 5 || Math.abs(ne.clientY - chart.$qcDownY) > 5)) return;
                let best = null, bd = 18;
                chart.data.datasets.forEach((d, k) => {
                    if (!chart.isDatasetVisible(k)) return;
                    d.data.forEach(pt => {
                        if (pt.i == null || Number.isNaN(pt.x)) return;
                        const dist = Math.hypot(chart.scales.x.getPixelForValue(pt.x) - e.x, chart.scales.y.getPixelForValue(pt.y) - e.y);
                        if (dist < bd) { bd = dist; best = pt; }
                    });
                });
                if (best && typeof qcJumpToSecond === 'function') qcJumpToSecond(Math.round(qcAxisRef[best.i]));
            },
            scales: {
                x: { type: 'linear', min: mnx - padX, max: mxx + padX, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: Object.assign({ maxTicksLimit: 9 }, tick), title: axTitle('Longitude (degrees)') },
                y: { type: 'linear', min: mny - padY, max: mxy + padY, grid: { color: 'rgba(148,163,184,0.10)' }, ticks: tick, title: axTitle('Latitude (degrees)') }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    bodyFont: { family: "'IBM Plex Mono', monospace", size: 11, weight: '700' },
                    callbacks: {
                        title: items => (items.length && items[0].raw && items[0].raw.i != null) ? ((qcTimeLabels[items[0].raw.i] || '') + ' UTC') : '',
                        label: item => (item.dataset.label || '') + ': ' + qcRound(item.parsed.y, 4) + ', ' + qcRound(item.parsed.x, 4)
                    }
                },
                zoom: {
                    zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'xy',
                            drag: { enabled: false, backgroundColor: 'rgba(91,157,255,0.14)', borderColor: '#5b9dff', borderWidth: 1 },
                            onZoomStart: ({ chart }) => qcPushZoomState(chart),
                            onZoomComplete: ({ chart }) => qcZoomChanged(chart) },
                    pan: { enabled: true, mode: 'xy',
                           onPanStart: ({ chart }) => qcPushZoomState(chart),
                           onPanComplete: ({ chart }) => qcZoomChanged(chart, true) }
                }
            }
        };
        const chart = new Chart(canvas.getContext('2d'), { type: 'scatter', data: { datasets: datasets }, options: opts, plugins: [qcMapOverlayPlugin] });
        chart.$qcIsMap = true;
        chart.$qcHome = { x: { min: mnx - padX, max: mxx + padX }, y: { min: mny - padY, max: mxy + padY } };
        const refPair = pairs.find(p => p.isRef) || pairs[0];
        chart.$qcMapLat = refPair ? refPair.la.series : null;
        chart.$qcMapLon = refPair ? refPair.lo.series : null;
        chart.$qcFam = latFam;
        // the script splits these tracks across two plots (pure gps p12, blended inertial p13);
        // one map carries every pair here, with a group chip per set so either toggles at once
        const gpsNames = datasets.filter(d => !d.$qcIsRef && /^Lat\/LonGPS\./.test(d.$qcName)).map(d => d.$qcName);
        const ineNames = datasets.filter(d => !d.$qcIsRef && /^Lat\/Lon(I-GPS|I)\./.test(d.$qcName)).map(d => d.$qcName);
        const mapGroups = [];
        if (gpsNames.length > 1) mapGroups.push({ label: 'GPS', names: gpsNames });
        if (ineNames.length > 1) mapGroups.push({ label: 'Blended Inertial', names: ineNames });
        if (mapGroups.length) chart.$qcGroups = mapGroups;
        if (QC_HTML_LEGEND) {
            chart.$qcLegendBar = document.createElement('div');
            chart.$qcLegendBar.className = 'qc-legend-bar';
            qcRenderHtmlLegend(chart, latFam);
        }
        qcWireCanvas(canvas, chart);
        return chart;
    }

    function qcBuildMainChart(canvas, fam, famModel) {
        const plotted = famModel.members.filter(m => m.series && m.count > 0);   // only members with VALID data (not all-NaN)
        const last = qcTimeLabels.length - 1, first = 0;
        // a family can split into two sensor groups (explicit catalog groups like AccAZI vs
        // AccZI or AltPaADDU vs AltBCADDU, or the direct-vs-GPS name heuristic). every group
        // starts checked; the group chips let the user isolate one when needed.
        const groupNames = plotted.filter(m => !m.isRef && !m.isDerived).map(m => m.name);
        const legendGroups = qcFamilyLegendGroups(famModel, groupNames);
        // the ref linkage lives in the legend bar (source sequence chips + a live label that
        // follows the playhead), so the dataset label itself stays plain for tooltips
        const refInfo = famModel.refInfo;
        // names like ALTref already say ref, so no "(ref)" suffix on top of them
        const refLabel = m => /ref/i.test(m.name) ? m.name : m.name + ' (ref)';
        const datasets = plotted.map((m, k) => ({
            label: m.isRef ? refLabel(m) : m.name + (m.isDerived ? ' (deriv.)' : ''),
            $qcName: m.name, $qcIsRef: !!m.isRef, $qcIsDerived: !!m.isDerived,
            data: qcDecimate(m.series, first, last), $full: m.series, parsing: false, normalized: true,
            borderColor: m.isRef ? qcRefColor() : QC_SERIES_COLORS[k % QC_SERIES_COLORS.length],
            $qcBaseWidth: m.isRef ? 1.9 : 1.4, borderWidth: m.isRef ? 1.9 : 1.4,
            borderDash: m.isDerived ? [4, 3] : [], pointRadius: 0, pointHitRadius: 6, fill: false, spanGaps: false,
            hidden: false
        }));
        const opts = qcChartOptions(fam.label + ' (' + qcUnitLabel(fam.unit) + ')');
        if (QC_HTML_LEGEND) opts.plugins.legend.display = false;
        const chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: datasets }, options: opts, plugins: [qcOverlayPlugin] });
        chart.$qcGapRanges = qcFamilyGapRanges(plotted.map(m => m.series), qcTimeLabels.length);
        // per-member in-flight gaps: the overlay draws their carets and pillars, and the hover
        // tip names the sensor
        const gapMarks = [];
        plotted.forEach(m => (m.gaps || []).forEach(g => { if (g.fromIdx != null) gapMarks.push({ fromIdx: g.fromIdx, toIdx: g.toIdx, name: m.name }); }));
        chart.$qcGapMarks = gapMarks;
        // one merged marker per gap region (across sensors + family holes); overlay/hover/click use it
        chart.$qcGapClusters = qcClusterGaps(gapMarks, chart.$qcGapRanges);
        // implausible-value regions (the engine's Check flags), shaded red by the overlay
        const checkMarks = [];
        plotted.forEach(m => (m.checks || []).forEach(g => checkMarks.push({ fromIdx: g.fromIdx, toIdx: g.toIdx })));
        checkMarks.sort((a, b) => a.fromIdx - b.fromIdx);
        chart.$qcCheckMarks = checkMarks;
        chart.$qcAllEmpty = plotted.length > 0 && plotted.every(m => !m.count);
        chart.$qcRefSegs = (refInfo && refInfo.segments) || [];
        chart.$qcFam = fam;
        if (QC_HTML_LEGEND) {
            chart.$qcGroups = legendGroups;
            chart.$qcLegendBar = document.createElement('div');
            chart.$qcLegendBar.className = 'qc-legend-bar';
            qcRenderHtmlLegend(chart, fam);
        }
        qcWireCanvas(canvas, chart);
        return chart;
    }

    function qcBuildDiffChart(canvas, fam, famModel) {
        // every combination WITHIN a sensor group (3 sensors -> 1-2, 1-3, 2-3), plus cross-group
        // pairs for curiosity's sake (unchecked by default, labeled as cross group). the ref and
        // derived channels stay out: the ref duplicates a member and would compare as zero.
        const members = famModel.members.filter(m => m.series && m.count > 0 && !m.isRef && !m.isDerived);
        const names = members.map(m => m.name);
        const bySensor = {}; members.forEach(m => { bySensor[m.name] = m.series; });
        const groups = qcFamilyLegendGroups(famModel, names);
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
            label: d.id, $qcCross: d.cross, $qcName: d.id,
            data: qcDecimate(d.series, first, last), $full: d.series, parsing: false, normalized: true,
            borderColor: QC_SERIES_COLORS[k % QC_SERIES_COLORS.length],
            $qcBaseWidth: 1.3, borderWidth: 1.3, pointRadius: 0, pointHitRadius: 6, fill: false, spanGaps: false,
            hidden: k > 0
        }));
        const opts = qcChartOptions('Difference (' + qcUnitLabel(fam.unit) + ')');
        // the modal draws its own two-row html legend (within-group / cross-group), so the canvas
        // legend stays off here just like on the family graphs
        opts.plugins.legend.display = false;
        const chart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets: datasets }, options: opts, plugins: [qcOverlayPlugin] });
        chart.$qcDiffPairs = plotted;
        qcWireCanvas(canvas, chart);
        return chart;
    }

    // two aligned rows for the diff modal legend: within-group pairs on top, cross-group pairs
    // (curiosity comparisons) on their own labeled row underneath, so wrapping never mixes them.
    // solo semantics: checking an unchecked pair shows it alone, unchecking only unchecks itself.
    function qcRenderDiffLegend(chart, holder) {
        holder.innerHTML = '';
        const yw = chart.scales && chart.scales.y && chart.scales.y.width;
        if (yw) holder.style.paddingLeft = Math.round(yw + 6) + 'px';
        const ds = chart.data.datasets;
        const mkRow = (cross, labelText) => {
            const has = ds.some(d => !!d.$qcCross === cross);
            if (!has) return;
            const row = document.createElement('div'); row.className = 'qc-lg-row';
            if (labelText) { const lb = document.createElement('span'); lb.className = 'qc-lg-rowlabel'; lb.textContent = labelText; row.appendChild(lb); }
            ds.forEach((d, k) => {
                if (!!d.$qcCross !== cross) return;
                const on = chart.isDatasetVisible(k);
                const it = document.createElement('button'); it.type = 'button'; it.className = 'qc-lg-item' + (on ? '' : ' off');
                it.title = on ? 'Unselect ' + d.label : 'View ' + d.label + ' alone';
                const box = document.createElement('span'); box.className = 'qc-lg-box' + (on ? '' : ' off');
                if (on) { box.style.background = String(d.borderColor); box.style.borderColor = String(d.borderColor); }
                const txt = document.createElement('span'); txt.textContent = d.label;
                it.appendChild(box); it.appendChild(txt);
                it.addEventListener('click', () => {
                    if (chart.isDatasetVisible(k)) chart.setDatasetVisibility(k, false);
                    else ds.forEach((_, j) => chart.setDatasetVisibility(j, j === k));
                    chart.update('none');
                    qcRenderDiffLegend(chart, holder);
                });
                row.appendChild(it);
            });
            holder.appendChild(row);
        };
        mkRow(false, '');
        mkRow(true, 'cross group:');
    }

    // ---- difference modal: one shared overlay, the chart is built on open and destroyed on close
    let qcCurrentResult = null;        // the rendered qcResult, for modal lookups
    let qcDiffModalChartKey = null;
    function qcDiffModalEl() {
        let m = document.getElementById('qcDiffModal');
        if (m) return m;
        m = document.createElement('div'); m.id = 'qcDiffModal'; m.className = 'modal-overlay';
        // the graph card, with the max diff list bottom left and the Flight Context BUTTON bottom
        // right; the context panel itself opens as the right-side dock beside the card
        m.style.gap = '14px';
        m.innerHTML =
            '<div class="modal-card" id="qcDiffMainCard" style="max-width:1500px;width:96%;max-height:92vh;overflow-y:auto">' +
              '<button id="qcDiffModalClose" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">✕</button>' +
              '<h2 id="qcDiffModalTitle" class="text-ink text-lg font-bold border-b border-hairline pb-2"></h2>' +
              '<div id="qcDiffModalBody"></div>' +
              '<div class="qc-diff-bottom">' +
                '<div id="qcDiffModalBadges" class="qc-badge-stack"></div>' +
                '<div id="qcDiffCtxBtnSlot"></div>' +
              '</div>' +
            '</div>' +
            '<div class="modal-card qc-diff-context" id="qcDiffContext" style="display:none">' +
              '<div class="qc-context-head">Flight Track <span>context</span></div>' +
              '<div class="qc-map-slot" id="qcDiffMapSlot"></div>' +
              '<div class="qc-context-note">the map follows the graph playhead, so slide to the moment the difference occurs</div>' +
            '</div>';
        document.body.appendChild(m);
        m.addEventListener('click', e => { if (e.target === m) qcCloseDiffModal(); });
        m.querySelector('#qcDiffModalClose').addEventListener('click', qcCloseDiffModal);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') qcCloseDiffModal(); });
        return m;
    }

    // toggle the flight context card beside the diff graph: the ONE map panel relocates in (and
    // back to the sidebar slot on close), keeping all of its wiring
    function qcToggleDiffContext(on) {
        const ctx = document.getElementById('qcDiffContext'), main = document.getElementById('qcDiffMainCard');
        if (!ctx || !main) return;
        const open = on != null ? on : ctx.style.display === 'none';
        ctx.style.display = open ? '' : 'none';
        main.style.width = open ? 'calc(96% - 480px)' : '96%';
        const src = document.getElementById('mapPanel');
        const dst = document.getElementById(open ? 'qcDiffMapSlot' : 'qcMapSlot');
        if (src && dst && src.parentNode !== dst) dst.appendChild(src);
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        if (open && typeof followAircraft2D !== 'undefined' && followAircraft2D
            && typeof engageFollowAircraft === 'function'
            && typeof trackerModeSelect !== 'undefined' && trackerModeSelect.value === '2d') engageFollowAircraft();
        if (typeof qcDrivePlayer === 'function') qcDrivePlayer(true);
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
        // flight context toggle lives at the BOTTOM RIGHT of the card, next to the max diff list
        const ctxBtn = document.createElement('button'); ctxBtn.type = 'button'; ctxBtn.className = 'qc-ov-btn';
        ctxBtn.textContent = 'Flight Context';
        ctxBtn.title = 'Show the flight track map beside this graph';
        ctxBtn.addEventListener('click', () => { qcToggleDiffContext(); ctxBtn.classList.toggle('active', document.getElementById('qcDiffContext').style.display !== 'none'); });
        const ctxSlot = m.querySelector('#qcDiffCtxBtnSlot'); if (ctxSlot) { ctxSlot.innerHTML = ''; ctxSlot.appendChild(ctxBtn); }
        tools.appendChild(qcBuildToolbar(chart));
        wrap.appendChild(qcBuildCornerTools(chart, fam.key + '_diff.png'));
        wrap.appendChild(qcBuildResetFloat(chart));
        // the two-row legend (within-group / cross-group) sits between the toolbar and the canvas
        const lg = document.createElement('div'); lg.className = 'qc-legend-bar qc-diff-legend';
        body.insertBefore(lg, wrap);
        qcRenderDiffLegend(chart, lg);
    }
    function qcCloseDiffModal() {
        const m = document.getElementById('qcDiffModal');
        // the map goes home to the sidebar slot before the modal hides
        try { qcToggleDiffContext(false); } catch (e) {}
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
        qcMiniRange = null; qcMiniTime = null;   // the old slider DOM is about to be cleared
        qcAxisRef = qcResult.timeAxis;
        qcTimeLabels = new Array(qcResult.n);
        for (let i = 0; i < qcResult.n; i++) qcTimeLabels[i] = qcSecToLabel(qcResult.timeAxis[i]);
        // detected (or pinned) takeoff/landing indices, drawn as quiet markers on every graph
        qcPhaseMarks = qcResult.phases ? { toIdx: qcResult.phases.toIdx, landIdx: qcResult.phases.landIdx } : null;
        container.innerHTML = '';

        // sfmr families sink to the bottom of the column; everything else keeps catalog order
        const famsOrdered = qcResult.families.slice().sort((a, b) => (/^sfmr/.test(a.key) ? 1 : 0) - (/^sfmr/.test(b.key) ? 1 : 0));
        famsOrdered.forEach(fam => {
          try {
            // latitude and longitude fuse into ONE map style panel (x = longitude, y = latitude),
            // like the script's flight track plot; the lon family folds into the lat panel
            const latFamAll = qcResult.families.find(f => f.key === 'lat');
            // "has data" means at least one VALID sample (count > 0): a channel present in the file
            // but all-NaN has a truthy .series yet no data, and must read as UNAVAILABLE, not plotted.
            if (fam.key === 'lon' && latFamAll && latFamAll.members.some(m => m.count > 0) && fam.members.some(m => m.count > 0)) return;
            const lonFam = fam.key === 'lat' ? qcResult.families.find(f => f.key === 'lon') : null;
            const isMapPanel = !!(lonFam && lonFam.members.some(m => m.count > 0) && fam.members.some(m => m.count > 0));
            const hasMain = fam.members.some(m => m.count > 0);
            const hasDiff = fam.diffs.some(d => d.series && !Number.isNaN(d.max));
            if (!hasMain && !hasDiff) {
                // whole family absent: instead of a bare NO DATA box, list every sensor blacked out
                // with an UNAVAILABLE tag, so a graph with no data in any variable reads the same as
                // a partially-missing graph's legend.
                const empty = document.createElement('div'); empty.className = 'qc-chart-panel';
                empty.id = 'qcpanel_' + fam.key;
                empty.innerHTML = '<div class="qc-chart-head"><span class="qc-chart-title">' + fam.label + '</span>' +
                    '<span class="qc-unit">' + qcUnitLabel(fam.unit) + '</span></div>';
                const box = document.createElement('div'); box.className = 'qc-nodata-box qc-nodata-unavail';
                const lead = document.createElement('span'); lead.className = 'qc-nodata-lead'; lead.textContent = 'NO DATA';
                box.appendChild(lead);
                const row = document.createElement('div'); row.className = 'qc-nodata-chips';
                (fam.members || []).forEach(m => row.appendChild(qcUnavailItem(m.name)));
                if (row.childNodes.length) box.appendChild(row);
                empty.appendChild(box);
                container.appendChild(empty);
                return;
            }

            const panel = document.createElement('div'); panel.className = 'qc-chart-panel';
            panel.id = 'qcpanel_' + fam.key;   // navigation target (Phase Stats "view graph")
            const head = document.createElement('div'); head.className = 'qc-chart-head';
            // the ref channel is supposed to ride one sensor all flight; call it out when it
            // moved. every switch is named with its clickable moment, no ambiguous "mid flight".
            const switchedBadge = f => {
                if (!f || !f.refInfo || !f.refInfo.switched) return '';
                const segs = f.refInfo.segments || [];
                if (segs.length <= 1) return ' <span class="qc-badge qc-badge-warn qc-switch-badge">' + f.ref + ' switched sources: ' + f.refInfo.sources.join(' then ') + '</span>';
                // the first source is inline; each later switch is its own span so the fit pass can
                // fold the switches that would overflow the row into a +N more toggle, and only
                // then (when there is no horizontal room for another switch)
                let ride = segs[0].source;
                for (let i = 1; i < segs.length; i++) {
                    const t = (qcTimeLabels && qcTimeLabels[segs[i].fromIdx]) || '?';
                    ride += '<span class="qc-ref-switch">, then ' + segs[i].source + ' at <span class="qc-ref-jump" data-idx="' + segs[i].fromIdx + '" title="Jump to this switch">' + t + '</span></span>';
                }
                ride += '<button type="button" class="qc-ref-morebtn" style="display:none"></button>';
                return ' <span class="qc-badge qc-badge-warn qc-switch-badge">' + f.ref + ' switched sources: ' + ride + '</span>';
            };
            let statBits = '';
            if (fam.phaseStat) statBits += qcPhaseStatBadge(fam);
            if (fam.flightMean) statBits += ' <span class="qc-badge">avg ' + fam.flightMean.var + ': ' + fam.flightMean.value + '</span>';
            statBits += switchedBadge(fam);
            if (isMapPanel) statBits += switchedBadge(lonFam);
            head.innerHTML = '<span class="qc-chart-title">' + (isMapPanel ? 'Flight Track' : fam.label) + '</span>' +
                '<span class="qc-unit">' + (isMapPanel ? 'degrees' : qcUnitLabel(fam.unit)) + '</span>' +
                '<span class="qc-chart-meta">' + statBits + '</span>';
            head.querySelectorAll('.qc-ref-jump').forEach(el => el.addEventListener('click', () => {
                const i = parseInt(el.dataset.idx, 10);
                if (qcAxisRef && qcAxisRef[i] != null && typeof qcJumpToSecond === 'function') qcJumpToSecond(Math.round(qcAxisRef[i]));
            }));
            head.querySelectorAll('.qc-ref-morebtn').forEach(btn => btn.addEventListener('click', () => {
                const badge = btn.closest('.qc-switch-badge'); if (!badge) return;
                const open = badge.classList.toggle('qc-switch-open');   // css reveals the folded switches
                btn.textContent = open ? 'less' : (btn.dataset.n || '');
            }));
            panel.appendChild(head);
            // issues are visible on the panel itself, no interaction needed: one chip per absent
            // member and per in-flight gap (click a gap chip to jump there), ground gaps dimmed.
            const issuesEl = qcBuildIssueStrip(fam);
            if (issuesEl) panel.appendChild(issuesEl);
            if (isMapPanel) { const lonIssues = qcBuildIssueStrip(lonFam); if (lonIssues) panel.appendChild(lonIssues); }

            // each graph gets a slim control bar directly ABOVE it (tools never cover the plot);
            // fullscreen sits apart at the bar's far right
            const addGraph = (cls, key, pngName, build) => {
                const c = document.createElement('div'); c.className = cls;
                const cv = document.createElement('canvas'); c.appendChild(cv);
                const bar = document.createElement('div'); bar.className = 'qc-graph-bar';
                // tiny reminder sitting right over the variable checkboxes
                const hint = document.createElement('span'); hint.className = 'qc-legend-hint';
                hint.textContent = 'Click on any group or individual sensor to select/unselect it.';
                const tools = document.createElement('div'); tools.className = 'qc-graph-tools-group';
                bar.appendChild(hint); bar.appendChild(tools);
                panel.appendChild(bar); panel.appendChild(c);
                const chart = qcCharts[key] = build(cv);
                // the html legend row (group chips, variable checkboxes, ref chips) sits between
                // the toolbar row and the canvas
                if (chart.$qcLegendBar) panel.insertBefore(chart.$qcLegendBar, c);
                tools.appendChild(qcBuildToolbar(chart));
                // fullscreen + png ride the top right of the whole graph BLOCK, and fullscreen
                // takes the block with them (title, legend, and toolbar included)
                panel.appendChild(qcBuildCornerTools(chart, pngName, chart.$qcFam && chart.$qcFam.key));
                c.appendChild(qcBuildResetFloat(chart));
            };
            container.appendChild(panel);
            if (isMapPanel) { addGraph('qc-canvas-wrap qc-canvas-map', 'qc_latlon', 'flight-track.png', cv => qcBuildMapChart(cv, fam, lonFam)); panel.appendChild(qcBuildMiniSlider()); }
            else if (hasMain) addGraph('qc-canvas-wrap', 'qc_' + fam.key, fam.key + '.png', cv => qcBuildMainChart(cv, fam, fam));
            // bottom strip of the graph block: the fused diff button inside its corner on the
            // left, and the std dev control sitting to the RIGHT of the corner lines
            const bottom = document.createElement('div'); bottom.className = 'qc-fam-bottom';
            // one fused button per family: the label line and the + graph line share a single
            // click handler on the wrapper, one glow border around both. the map panel carries
            // both families' difference graphs side by side.
            const mkDiffCol = (label, famKey) => {
                const btnCol = document.createElement('div'); btnCol.className = 'qc-diff-btncol';
                const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'qc-ov-btn';
                btn.textContent = label;
                btnCol.appendChild(btn);
                const dp = document.createElement('button'); dp.type = 'button'; dp.className = 'qc-diff-create';
                dp.innerHTML = '<span class="qc-diff-plus">＋</span><span>graph</span>';
                btnCol.appendChild(dp);
                btnCol.title = 'Open this family\'s difference graph';
                btnCol.addEventListener('click', () => qcOpenDiffModal(famKey));
                return btnCol;
            };
            const lonDiff = isMapPanel && lonFam.diffs.some(d => d.series);
            if (hasDiff || lonDiff) {
                const dh = document.createElement('div'); dh.className = 'qc-diff-head';
                if (hasDiff) dh.appendChild(mkDiffCol(isMapPanel ? 'Latitude Differences' : 'Difference Between Sensors', fam.key));
                if (lonDiff) dh.appendChild(mkDiffCol('Longitude Differences', 'lon'));
                bottom.appendChild(dh);
            }
            const bandSlot = document.createElement('div'); bandSlot.className = 'qc-band-slot';
            bottom.appendChild(bandSlot);
            panel.appendChild(bottom);
            const mainChart = qcCharts[isMapPanel ? 'qc_latlon' : 'qc_' + fam.key];
            if (mainChart) { mainChart.$qcBandSlot = bandSlot; qcRenderHtmlLegend(mainChart, fam); }
          } catch (famErr) {
            // one bad family must not blank every other graph: drop an error tile in its place
            // (with the panel id graph-search/jump expect) and carry on with the rest.
            console.warn('QC family "' + fam.key + '" failed to render:', famErr);
            const errEl = document.createElement('div'); errEl.className = 'qc-chart-panel'; errEl.id = 'qcpanel_' + fam.key;
            errEl.innerHTML = '<div class="qc-chart-head"><span class="qc-chart-title">' + (fam.label || fam.key) + '</span></div>' +
                '<div class="qc-nodata-box">Could not render this graph (see console)</div>';
            container.appendChild(errEl);
          }
        });
        // charts scrolled back into view would otherwise show the playhead where it was when they
        // scrolled out; refresh the visible ones as the column scrolls
        if (!container.$qcScrollWired) { container.$qcScrollWired = true; container.addEventListener('scroll', () => qcSyncPlayhead(), { passive: true }); }
        // fold each switched-sources flag to whatever fits its row, and re-fit on window resize
        qcFitSwitchBadges(container);
        if (!container.$qcFitWired) {
            container.$qcFitWired = true;
            let ft; window.addEventListener('resize', () => { clearTimeout(ft); ft = setTimeout(() => qcFitSwitchBadges(container), 150); });
        }
    }

    // show as many switches as fit the badge's row; fold the overflow into a +N more toggle, and
    // only then (badges the user has expanded are left alone)
    function qcFitSwitchBadges(root) {
        (root || document).querySelectorAll('.qc-switch-badge').forEach(badge => {
            const switches = Array.prototype.slice.call(badge.querySelectorAll('.qc-ref-switch'));
            const more = badge.querySelector('.qc-ref-morebtn');
            if (!switches.length || !more) return;
            if (badge.classList.contains('qc-switch-open')) return;   // user expanded it
            if (!badge.clientWidth) return;                           // not laid out yet
            switches.forEach(s => s.classList.remove('qc-ref-ovf'));
            more.style.display = 'none';
            if (badge.scrollWidth <= badge.clientWidth + 1) return;   // all switches fit
            more.style.display = '';
            let hidden = 0;
            for (let i = switches.length - 1; i >= 0; i--) {
                switches[i].classList.add('qc-ref-ovf');   // folded until the badge is opened
                hidden++;
                more.textContent = '+' + hidden + ' more';
                if (badge.scrollWidth <= badge.clientWidth + 1) break;
            }
            more.dataset.n = '+' + hidden + ' more';
        });
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
        // the map panel has no time axis to slide through: pan is its resting tool
        const scrubBtn = chart.$qcIsMap ? null : mk('scrub', 'scrub', 'Drag anywhere on the graph and the playhead follows the cursor', () => { qcSetTool(chart, 'scrub'); setActive(scrubBtn); });
        const panBtn = mk('pan', 'pan', chart.$qcIsMap ? 'Drag moves the map, wheel zooms' : 'Drag moves the time window, wheel zooms', () => { qcSetTool(chart, 'pan'); setActive(panBtn); });
        const boxBtn = mk('box', 'select zoom', 'Drag a box to zoom into that area', () => { qcSetTool(chart, 'box'); setActive(boxBtn); });
        if (scrubBtn) modeBtns.push(scrubBtn);
        modeBtns.push(panBtn, boxBtn);
        setActive(chart.$qcIsMap ? panBtn : scrubBtn);
        qcSetTool(chart, chart.$qcIsMap ? 'pan' : 'scrub');
        // reset zoom snaps the tool back to the resting mode; the toolbar must show that switch
        chart.$qcSelectTool = tool => {
            if (tool === 'scrub' && chart.$qcIsMap) tool = 'pan';
            qcSetTool(chart, tool); setActive(tool === 'pan' ? panBtn : tool === 'box' ? boxBtn : scrubBtn);
        };
        return tb;
    }

    // reset zoom floats at the bottom of the graph and only appears while the view is zoomed,
    // recenter-on-aircraft style; living inside the canvas wrap it stays reachable in fullscreen
    function qcBuildResetFloat(chart) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'qc-reset-float';
        b.textContent = '⟲ Reset Zoom';
        b.title = 'Reset the zoom';
        b.addEventListener('click', () => qcResetChart(chart));
        chart.$qcResetBtn = b;
        return b;
    }

    // fullscreen + png save ride the top right corner of the graph itself, apart from the toolbar
    // (and, living inside the canvas wrap, they stay reachable in fullscreen)
    function qcBuildCornerTools(chart, pngName, htmlKey) {
        const c = document.createElement('div'); c.className = 'qc-graph-corner';
        // one download button on the same icon the png used: family panels download the
        // interactive html (the graph travels with zoom, pan, hover, and the playhead); the diff
        // modal, which has no standalone panel to rebuild, keeps the flat png on the same icon.
        const dl = document.createElement('button'); dl.type = 'button'; dl.className = 'qc-fs-btn';
        dl.innerHTML = QC_TOOL_ICONS.png;
        if (htmlKey && typeof qcExportSingleGraphHTML === 'function') {
            dl.title = 'Download this graph as an interactive HTML file';
            dl.addEventListener('click', () => qcExportSingleGraphHTML(htmlKey));
        } else {
            dl.title = 'Save this graph as a PNG';
            dl.addEventListener('click', () => { try { const a = document.createElement('a'); a.href = chart.toBase64Image(); a.download = pngName; a.click(); } catch (e) {} });
        }
        const fs = document.createElement('button'); fs.type = 'button'; fs.className = 'qc-fs-btn';
        fs.textContent = '⛶'; fs.title = 'Fullscreen this graph';
        fs.addEventListener('click', () => qcToggleGraphFullscreen(chart));
        c.appendChild(dl); c.appendChild(fs);
        return c;
    }

    function qcToggleGraphFullscreen(chart) {
        // family graphs fullscreen their whole block (title, legend, toolbar, canvas); the diff
        // modal graph, which has no block, fullscreens its canvas wrap as before
        const target = (chart.canvas && chart.canvas.closest('.qc-chart-panel')) || (chart.canvas && chart.canvas.parentElement);
        if (!target) return;
        if (document.fullscreenElement === target) { if (document.exitFullscreen) document.exitFullscreen().catch(() => {}); }
        else if (target.requestFullscreen) target.requestFullscreen().catch(() => {});
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
        const counts = { check: 0, gap: 0, nodata: 0, early: 0 };
        fam.members.forEach(m => {
            // the reason already names the sensor, so the chip does not repeat it
            (m.checks || []).forEach(c => { counts.check++; chips.push({ rank: 0, cls: 'qc-issue-check', jump: Math.round(qcAxisRef ? qcAxisRef[c.fromIdx] : 0), text: 'Check: ' + c.reason + ' at ' + (qcTimeLabels ? qcTimeLabels[c.fromIdx] : '') }); });
            if (m.presence === 'nodata') { counts.nodata++; chips.push({ rank: 2, cls: 'qc-issue-nodata', text: m.name + ' no data' }); }
            (m.gaps || []).forEach(g => { counts.gap++; chips.push({ rank: 1, cls: 'qc-issue-gap', jump: Math.round(g.from), text: m.name + ' gap ' + qcSecToLabel(g.from) + ' - ' + qcSecToLabel(g.to) + ' (' + (g.effSecs || g.secs) + ' s)' }); });
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
            });
            wrap.appendChild(more);
            // the flag breakdown rides its own row right under the toggle, in parentheses; each
            // kind wears its own issue color. the expanded chips flood in AFTER it in the dom,
            // so it stays pinned above the list either way
            const totals = [];
            if (counts.check) totals.push('<span class="qc-tot-check">' + counts.check + ' check region' + (counts.check === 1 ? '' : 's') + '</span>');
            if (counts.gap) totals.push('<span class="qc-tot-gap">' + counts.gap + ' gap' + (counts.gap === 1 ? '' : 's') + '</span>');
            if (counts.nodata) totals.push('<span class="qc-tot-nodata">' + counts.nodata + ' with no data</span>');
            if (counts.early) totals.push('<span class="qc-tot-note">' + counts.early + ' early stop' + (counts.early === 1 ? '' : 's') + '</span>');
            const sumEl = document.createElement('div');
            sumEl.className = 'qc-issue-totals';
            // "total" spells out that these parenthetical counts are the full tallies (not just the
            // three chips shown before the +N more toggle)
            sumEl.innerHTML = '(' + totals.join(', ') + ') total';
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
        qcUpdateMiniSlider();   // cheap; reflects the playhead even when the redraw below is throttled
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
        qcRefLiveHighlight();
    }

    // the flight-track map's mini timeslider: a follower of qcScrubIdx that slides through the WHOLE
    // recording. dragging it sets the one source of truth and drives the same sync path as the
    // white-bar slider; qcSyncPlayhead pushes playhead moves from elsewhere back to it.
    function qcBuildMiniSlider() {
        const n = qcAxisRef ? qcAxisRef.length : 0;
        const wrap = document.createElement('div'); wrap.className = 'qc-mini-slider';
        const range = document.createElement('input'); range.type = 'range'; range.className = 'qc-mini-range';
        range.min = '0'; range.max = String(Math.max(0, n - 1)); range.step = '1';
        range.value = String(qcScrubIdx != null ? qcScrubIdx : 0);
        range.title = 'Slide through the flight timeline';
        const time = document.createElement('span'); time.className = 'qc-mini-time';
        const scrub = hard => {
            qcScrubIdx = qcClampScrub(Math.round(range.valueAsNumber));
            if (typeof isPlaying !== 'undefined' && isPlaying) {
                const pb = document.getElementById('playPauseBtn');
                if (pb && /pause/i.test(pb.innerText)) pb.click(); else isPlaying = false;
            }
            time.textContent = (qcTimeLabels && qcTimeLabels[qcScrubIdx]) || '';
            if (typeof qcDrivePlayer === 'function') qcDrivePlayer(hard);
            qcSyncPlayhead(true);
        };
        range.addEventListener('input', () => scrub(false));
        range.addEventListener('change', () => scrub(true));
        wrap.appendChild(range); wrap.appendChild(time);
        qcMiniRange = range; qcMiniTime = time;
        time.textContent = (qcTimeLabels && qcTimeLabels[qcScrubIdx != null ? qcScrubIdx : 0]) || '';
        return wrap;
    }
    function qcUpdateMiniSlider() {
        if (!qcMiniRange || qcScrubIdx == null) return;
        qcMiniRange.value = String(qcScrubIdx);   // equals the current value during the slider's own drag, so no jump
        if (qcMiniTime) qcMiniTime.textContent = (qcTimeLabels && qcTimeLabels[qcScrubIdx]) || '';
    }

    // in every ref pipe, the source the ref is riding at the playhead's second reads blue; the
    // blue hands off to the next name the moment the playhead crosses its takeover point
    function qcRefLiveHighlight() {
        if (typeof qcScrubIdx === 'undefined' || qcScrubIdx == null) return;
        Object.values(qcCharts).forEach(c => {
            const els = c && c.$qcRefNameEls; if (!els || !els.length) return;
            let active = -1;
            els.forEach((el, k) => { if (qcScrubIdx >= +el.dataset.from) active = k; });
            els.forEach((el, k) => el.classList.toggle('qc-ref-live', k === active));
        });
    }

    function qcDestroyCharts() { Object.values(qcCharts).forEach(c => { try { c.destroy(); } catch (e) {} }); qcCharts = {}; }
