/* QC Mode, flight-track map PDF export
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Mirrors the qc_plots_with_map script's flight-track map: the ref lat/lon path over a faint
   country/state basemap with names, directional heading arrows at a chosen interval, and time
   markers at a chosen interval, plus takeoff and landing markers. Rendered client-side into a
   landscape PDF through the shared qcPdfDoc writer (js/25), no libraries, no internet. */

    // ref lat/lon over the flight; the map panel already fused these, else fall back to the report
    function qcTrackLatLon() {
        if (!qcResult) return null;
        const mc = (typeof qcCharts !== 'undefined') && qcCharts['qc_latlon'];
        if (mc && mc.$qcMapLat && mc.$qcMapLon) return { lat: mc.$qcMapLat, lon: mc.$qcMapLon };
        const fam = k => qcResult.families.find(f => f.key === k);
        const pick = f => { if (!f) return null; const m = f.members.find(x => x.isRef && x.series) || f.members.find(x => x.series); return m ? m.series : null; };
        const la = pick(fam('lat')), lo = pick(fam('lon'));
        return (la && lo) ? { lat: la, lon: lo } : null;
    }

    // where to drop a country label so it lands on the visible part: the mean of the feature's
    // vertices inside the view; if the view sits wholly inside the country, its center; else none
    function qcGeoLabelInView(f, mnLo, mxLo, mnLa, mxLa) {
        const g = f.geometry; if (!g) return null;
        let sx = 0, sy = 0, k = 0;
        const scan = ring => { for (let i = 0; i < ring.length; i++) { const lo = ring[i][0], la = ring[i][1]; if (lo >= mnLo && lo <= mxLo && la >= mnLa && la <= mxLa) { sx += lo; sy += la; k++; } } };
        if (g.type === 'Polygon') g.coordinates.forEach(scan);
        else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(scan));
        else return null;
        if (k > 0) return { lon: sx / k, lat: sy / k };
        const bb = f.properties && f.properties.bbox;
        if (bb && bb[0] <= mnLo && bb[2] >= mxLo && bb[1] <= mnLa && bb[3] >= mxLa) return { lon: (mnLo + mxLo) / 2, lat: (mnLa + mxLa) / 2 };
        return null;
    }

    let qcTrackModal = null;
    function qcShowTrackPdf() {
        if (!qcResult || !qcTrackLatLon()) return;
        if (!qcTrackModal) {
            qcTrackModal = document.createElement('div');
            qcTrackModal.id = 'qcTrackModal'; qcTrackModal.className = 'modal-overlay';
            qcTrackModal.innerHTML =
                '<div class="modal-card" style="max-width:420px">' +
                  '<button id="qcTkClose" class="qc-cmd-x" style="position:absolute;top:14px;right:14px" title="Close">✕</button>' +
                  '<h2 class="text-ink text-lg font-bold border-b border-hairline pb-2">Flight Track Map (.pdf)</h2>' +
                  '<div class="qc-picker-note">Exports the map used for mission documents with directional arrows and their time markers.</div>' +
                  '<label class="qc-es-row"><span>Arrows and time markers</span><input id="qcTkCount" class="qc-ov-input" type="number" min="0" max="500" value="20"></label>' +
                  '<div class="qc-picker-foot"><span style="flex:1"></span><button id="qcTkGen" class="qc-ov-btn qc-ov-btn-accent">Generate PDF</button></div>' +
                '</div>';
            document.body.appendChild(qcTrackModal);
            document.getElementById('qcTkClose').addEventListener('click', () => { qcTrackModal.style.display = 'none'; });
            qcTrackModal.addEventListener('click', e => { if (e.target === qcTrackModal) qcTrackModal.style.display = 'none'; });
            document.addEventListener('keydown', e => { if (e.key === 'Escape' && qcTrackModal) qcTrackModal.style.display = 'none'; });
            document.getElementById('qcTkGen').addEventListener('click', qcGenerateTrackPdf);
        }
        qcTrackModal.style.display = 'flex';
    }

    function qcGenerateTrackPdf() {
        const ll = qcTrackLatLon(); if (!ll) return;
        const clampInt = (v, d) => { const x = parseInt(v, 10); return isFinite(x) && x >= 0 ? Math.min(500, x) : d; };
        // one count drives both: each directional arrow gets its own time marker beside it
        const count = clampInt(document.getElementById('qcTkCount').value, 20);
        const arrows = count, stamps = count;

        // valid track points only (finite lat and lon), carrying their axis index for the clock
        const pts = [];
        for (let i = 0; i < ll.lat.length; i++) { const a = ll.lat[i], o = ll.lon[i]; if (!Number.isNaN(a) && !Number.isNaN(o)) pts.push({ i: i, la: a, lo: o }); }
        if (pts.length < 2) return;

        let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
        pts.forEach(p => { if (p.la < mnLa) mnLa = p.la; if (p.la > mxLa) mxLa = p.la; if (p.lo < mnLo) mnLo = p.lo; if (p.lo > mxLo) mxLo = p.lo; });
        const padLa = (mxLa - mnLa) * 0.10 + 0.05, padLo = (mxLo - mnLo) * 0.10 + 0.05;
        mnLa -= padLa; mxLa += padLa; mnLo -= padLo; mxLo += padLo;

        const doc = qcPdfDoc(); const pg = doc.page(true);   // landscape letter
        const W = pg.w, H = pg.h, m = 40, topPad = 34;
        const aL = m, aR = W - m, aB = m, aT = H - topPad;   // map rect (y up)
        const midLa = (mnLa + mxLa) / 2;
        const kx = Math.cos(midLa * Math.PI / 180) || 1;     // longitude squeeze at this latitude
        const spanLo = Math.max(1e-6, (mxLo - mnLo) * kx), spanLa = Math.max(1e-6, mxLa - mnLa);
        const availW = aR - aL, availH = aT - aB;
        const sc = Math.min(availW / spanLo, availH / spanLa);
        const drawW = spanLo * sc, drawH = spanLa * sc;
        const ox = aL + (availW - drawW) / 2, oy = aB + (availH - drawH) / 2;
        const X = lo => ox + (lo - mnLo) * kx * sc;
        const Y = la => oy + (la - mnLa) * sc;

        // frame + geography, clipped to the map rect. the whole rect is water (blue), land fills
        // green on top, lakes blue — a classic green-land / blue-water map.
        doc.poly([[aL, aB], [aR, aB], [aR, aT], [aL, aT]], 0.8, [0.55, 0.6, 0.66], true);
        doc.save(); doc.clip(aL, aB, aR - aL, aT - aB);
        doc.fill([[aL, aB], [aR, aB], [aR, aT], [aL, aT]], [0.83, 0.91, 0.97]);
        const viewArea = (mxLo - mnLo) * (mxLa - mnLa);
        if (typeof mapFeatures !== 'undefined' && mapFeatures) {
            const inBox = bb => !bb || !(bb[2] < mnLo || bb[0] > mxLo || bb[3] < mnLa || bb[1] > mxLa);
            const toPix = r => { const pp = []; for (let i = 0; i < r.length; i++) pp.push([X(r[i][0]), Y(r[i][1])]); return pp; };
            const eachRing = (feats, cb) => feats.forEach(f => {
                if (!inBox(f.properties && f.properties.bbox)) return;
                const g = f.geometry; if (!g) return;
                if (g.type === 'Polygon') g.coordinates.forEach(cb);
                else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(cb));
                else if (g.type === 'LineString') cb(g.coordinates);
                else if (g.type === 'MultiLineString') g.coordinates.forEach(cb);
            });
            // fill land (countries) green, then lakes blue, so land vs water reads at a glance;
            // coastlines + borders stroke on top. (region NAME labels are drawn later, off the track.)
            eachRing(mapFeatures.filter(f => !(f.properties && f.properties.isState)), r => { const pp = toPix(r); if (pp.length > 2) doc.fill(pp, [0.87, 0.94, 0.83]); });
            if (typeof qcLakes !== 'undefined') eachRing(qcLakes, r => { const pp = toPix(r); if (pp.length > 2) doc.fill(pp, [0.80, 0.89, 0.97]); });
            const drawRing = r => { const pp = toPix(r); if (pp.length > 1) doc.poly(pp, 0.5, [0.45, 0.55, 0.48]); };
            eachRing(mapFeatures, drawRing);
            if (typeof qcLakes !== 'undefined') eachRing(qcLakes, r => { const pp = toPix(r); if (pp.length > 1) doc.poly(pp, 0.4, [0.4, 0.55, 0.78]); });
        }

        // the flight path
        const path = pts.map(p => [X(p.lo), Y(p.la)]);
        doc.poly(path, 1.4, [0.12, 0.32, 0.85]);

        // directional heading arrows at even intervals, pointing along the drawn track
        const arrowStep = arrows > 0 && pts.length > arrows ? Math.floor(pts.length / arrows) : 0;
        if (arrowStep > 1) {
            for (let a = 0; a < pts.length; a += arrowStep) {
                const p = path[a];
                let q = null;
                for (let j = a + 1; j < pts.length; j++) { if (Math.hypot(path[j][0] - p[0], path[j][1] - p[1]) > 2) { q = path[j]; break; } }
                if (!q) continue;
                const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1;
                const ux = dx / L, uy = dy / L, px = -uy, py = ux;
                const tip = [p[0] + ux * 8, p[1] + uy * 8], bc = [p[0] - ux * 2, p[1] - uy * 2];
                doc.fill([tip, [bc[0] + px * 4, bc[1] + py * 4], [bc[0] - px * 4, bc[1] - py * 4]], [0, 0, 0]);
            }
        }

        // time markers at even intervals. the label is offset PERPENDICULAR to the local track so it
        // never prints on top of the track (a vertical / 90-degree track would otherwise run the time
        // straight through the line); placed to the left, it right-aligns so the text stays clear.
        const stampStep = stamps > 0 && pts.length > stamps ? Math.floor(pts.length / stamps) : 0;
        if (stampStep > 1) {
            for (let s = 0; s < pts.length; s += stampStep) {
                const p = path[s];
                doc.dot(p[0], p[1], 1.6, [0.1, 0.1, 0.1]);
                const label = qcSecToLabel(qcAxisRef[pts[s].i]) + 'Z';
                let q = null;
                for (let j = s + 1; j < pts.length; j++) { if (Math.hypot(path[j][0] - p[0], path[j][1] - p[1]) > 2) { q = path[j]; break; } }
                let ox = 4, oy = 2;
                if (q) { const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1; ox = (-dy / L) * 6; oy = (dx / L) * 6; }
                let ax = p[0] + ox, ay = p[1] + oy;
                if (ox < 0) ax -= label.length * 3.2;   // right-align on the left side so text stays clear
                doc.mtext(ax, ay, label, 6.5, false, [0.1, 0.1, 0.1]);
            }
        }

        // takeoff / landing markers at the tool's in-force phase indices (manually pinned or
        // auto-detected), NOT the track's first/last GPS fix, so a manual takeoff/landing time
        // moves these dots and labels too. the marker sits on the nearest valid track point to the
        // phase second; the label always shows the exact phase time. falls back to the track ends
        // only when no phases exist.
        const ph = qcResult && qcResult.phases;
        const nearestPt = idx => {
            if (idx == null) return null;
            let best = null, bd = Infinity;
            for (let k = 0; k < pts.length; k++) { const d = Math.abs(pts[k].i - idx); if (d < bd) { bd = d; best = pts[k]; } }
            return best;
        };
        const toPt = (ph && nearestPt(ph.toIdx)) || pts[0];
        const landPt = (ph && nearestPt(ph.landIdx)) || pts[pts.length - 1];
        const to = [X(toPt.lo), Y(toPt.la)], land = [X(landPt.lo), Y(landPt.la)];
        const toT = qcSecToLabel(ph && ph.takeoffSec != null ? ph.takeoffSec : qcAxisRef[toPt.i]);
        const landT = qcSecToLabel(ph && ph.landingSec != null ? ph.landingSec : qcAxisRef[landPt.i]);
        // region NAME labels (state in the USA, else country/territory), pushed AWAY from the flight
        // track so they sit off to the side rather than over it, and larger than the time stamps
        if (typeof qcRegionLabels !== 'undefined' && qcRegionLabels.length) {
            let tcx = 0, tcy = 0; for (let i = 0; i < path.length; i++) { tcx += path[i][0]; tcy += path[i][1]; }
            tcx /= (path.length || 1); tcy /= (path.length || 1);
            const rplaced = [];
            for (let k = 0, shown = 0; k < qcRegionLabels.length && shown < 8; k++) {
                const rp = qcRegionLabels[k];
                if (rp.lon < mnLo || rp.lon > mxLo || rp.lat < mnLa || rp.lat > mxLa) continue;
                let lx = X(rp.lon), ly = Y(rp.lat);
                const dx = lx - tcx, dy = ly - tcy, L = Math.hypot(dx, dy) || 1;
                lx += (dx / L) * 18; ly += (dy / L) * 18;   // push outward, off the track
                lx = Math.max(aL + 6, Math.min(aR - 6, lx)); ly = Math.max(aB + 8, Math.min(aT - 6, ly));
                if (rplaced.some(z => z.name === rp.name || (Math.abs(z.lx - lx) < 66 && Math.abs(z.ly - ly) < 12))) continue;
                rplaced.push({ lx: lx, ly: ly, name: rp.name }); shown++;
                const nm = String(rp.name).toUpperCase();
                doc.mtext(lx - nm.length * 2.4, ly, nm, 9.5, true, [0.28, 0.32, 0.30]);
            }
        }

        // takeoff / landing dots + labels. when both are at the same field the two labels are STACKED
        // above the shared point instead of overprinting into one unreadable clump.
        doc.dot(to[0], to[1], 4, [0.16, 0.66, 0.33]);
        doc.dot(land[0], land[1], 4, [0.85, 0.24, 0.24]);
        if (Math.hypot(land[0] - to[0], land[1] - to[1]) < 12) {
            doc.mtext(to[0] + 6, to[1] + 13, 'Takeoff ' + toT + 'Z', 8, true, [0.11, 0.5, 0.24]);
            doc.mtext(to[0] + 6, to[1] + 4, 'Landing ' + landT + 'Z', 8, true, [0.72, 0.16, 0.16]);
        } else {
            doc.mtext(to[0] + 6, to[1] + 4, 'Takeoff ' + toT + 'Z', 8, true, [0.11, 0.5, 0.24]);
            doc.mtext(land[0] + 6, land[1] + 4, 'Landing ' + landT + 'Z', 8, true, [0.72, 0.16, 0.16]);
        }
        doc.restore();

        // title
        const mission = String((flightMetaData && flightMetaData.id) || 'flight').replace(/\s*\([^)]*\)/g, '').trim();
        doc.mtext(m, H - 22, mission + ' Flight Track', 13, true, [0.1, 0.1, 0.1]);
        doc.mtext(W - m - 220, H - 22, 'Takeoff ' + toT + 'Z   Landing ' + landT + 'Z', 10, false, [0.35, 0.35, 0.35]);

        const a = document.createElement('a');
        a.href = URL.createObjectURL(doc.blob());
        a.download = mission + '_Flight_Track.pdf'; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        if (qcTrackModal) qcTrackModal.style.display = 'none';
    }
