/* Mission Visualizer, 2D map projection + render engine
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    // Shift a longitude into the flight-centered window [lonDomainCenter-180, lonDomainCenter+180)
    // so a dateline-crossing flight (e.g. Hawaii -> Asia) projects continuously instead of
    // snapping across the whole map. Identity (lonDomainCenter 0) for normal flights.
    function wrapLon(lon) {
        if (!lonDomainCenter) return lon;
        return ((lon - lonDomainCenter) % 360 + 540) % 360 - 180 + lonDomainCenter;
    }

    function calculateMapScales() {
        const rawLons = filteredData.map(d => d.lon); const lats = filteredData.map(d => d.lat);
        // A dateline crosser reads as a ~360-degree raw span "the wrong way round". Re-center
        // the longitude domain on the flight's circular-mean longitude so bounds, zoom, and
        // every layer projected through getX stay continuous.
        lonDomainCenter = 0;
        if (rawLons.length && Math.max(...rawLons) - Math.min(...rawLons) > 180) {
            let sx = 0, sy = 0;
            rawLons.forEach(l => { const r = l * Math.PI / 180; sx += Math.cos(r); sy += Math.sin(r); });
            lonDomainCenter = Math.atan2(sy, sx) * 180 / Math.PI;
        }
        const lons = rawLons.map(wrapLon);
        const minLon = Math.min(...lons), maxLon = Math.max(...lons), minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const centerLon = (minLon + maxLon)/2; const centerLat = (minLat + maxLat)/2;
        deltaLon = (maxLon - minLon)*1.6 || 0.2; deltaLat = (maxLat - minLat)*1.6 || 0.2;
        const cosLat = Math.cos(centerLat * Math.PI/180);
        // Default framing is never tighter than a 200 km radius around the flight; wheel/drag
        // (mapScale/mapOffset) still override it for closer looks.
        const minSpanDeg = 400 / 111;
        deltaLat = Math.max(deltaLat, minSpanDeg);
        deltaLon = Math.max(deltaLon, minSpanDeg / Math.max(0.2, cosLat));
        const canvasRatio = cssW / cssH; const dataRatio = (deltaLon * cosLat) / deltaLat;
        if (dataRatio > canvasRatio) deltaLat = (deltaLon * cosLat) / canvasRatio; else deltaLon = (deltaLat * canvasRatio) / cosLat;
        plotMinLon = centerLon - deltaLon/2; plotMaxLon = centerLon + deltaLon/2; plotMinLat = centerLat - deltaLat/2; plotMaxLat = centerLat + deltaLat/2;
    }

    // The user's live pan/zoom is stored as pixel offsets (mapOffsetX/Y) and a scale relative to
    // the current canvas size and base frame; a resize or a base reframe (fullscreen, window
    // resize) changes both and the same pixels then point at a different place, so the view jumps.
    // Capturing the viewport as geography (its center lon/lat and visible lon span) and re-applying
    // it after keeps what the user was looking at fixed across the change.
    function isMapPanned() { return mapScale !== 1 || mapOffsetX !== 0 || mapOffsetY !== 0; }
    function getMapViewportGeo() {
        if (!deltaLon || !deltaLat || !cssW || !cssH) return null;
        const lxC = (cssW / 2 - mapOffsetX) / mapScale, lyC = (cssH / 2 - mapOffsetY) / mapScale;
        return {
            cLon: plotMinLon + (lxC / cssW) * deltaLon,
            cLat: plotMinLat + ((cssH - lyC) / cssH) * deltaLat,
            spanLon: deltaLon / mapScale   // visible degrees of longitude, the zoom level in geo terms
        };
    }
    function applyMapViewportGeo(v) {
        if (!v || !deltaLon || !cssW || !cssH) return;
        mapScale = deltaLon / v.spanLon;
        mapOffsetX = cssW / 2 - mapScale * getX(v.cLon);
        mapOffsetY = cssH / 2 - mapScale * getY(v.cLat);
    }

    // Follow-the-aircraft: the 2D map keeps the current plane position at screen center until the
    // user pans or zooms (which flips followAircraft2D off and reveals the recenter button).
    const FOLLOW_SPAN_KM = 360;   // visible width, in km, when following (framed around the plane)
    function centerMapOnPlane2D(d) {
        if (!d || !cssW || !cssH) return;
        mapOffsetX = cssW / 2 - mapScale * getX(d.lon);
        mapOffsetY = cssH / 2 - mapScale * getY(d.lat);
    }
    // Engage follow and zoom into the plane. Called on load and by the recenter button.
    function engageFollowAircraft() {
        followAircraft2D = true;
        if (filteredData.length && deltaLon) {
            const d = filteredData[Math.max(0, Math.min(currentIdx, filteredData.length - 1))];
            const spanDeg = FOLLOW_SPAN_KM / (111.32 * Math.max(0.2, Math.cos(d.lat * Math.PI / 180)));
            mapScale = Math.min(400, Math.max(0.06, deltaLon / spanDeg));
            centerMapOnPlane2D(d);
        }
        bgNeedsUpdate = true;
        if (typeof updateFollowButton === 'function') updateFollowButton();
        if (filteredData.length && trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
    }
    // Called by the pan/zoom handlers: stop following and surface the recenter button.
    function disengageFollowAircraft() {
        if (!followAircraft2D) return;
        followAircraft2D = false;
        if (typeof updateFollowButton === 'function') updateFollowButton();
    }

    // Projection works in LOGICAL css pixels; the renderers apply the DPR base transform.
    function getX(lon) { return ((wrapLon(lon) - plotMinLon) / deltaLon) * cssW; }
    function getY(lat) { return cssH - ((lat - plotMinLat) / deltaLat) * cssH; }

    // Geographic bounds currently visible (depends on pan/zoom). Used to draw the WHOLE world map
    // but only the parts on screen, so Africa etc. appear when you zoom out, with no perf hit when
    // zoomed into the flight.
    function getVisibleGeoBounds() {
        if (!cssW || !cssH || !deltaLon) return null;
        const x0 = (0 - mapOffsetX) / mapScale, x1 = (cssW - mapOffsetX) / mapScale;
        const y0 = (0 - mapOffsetY) / mapScale, y1 = (cssH - mapOffsetY) / mapScale;
        const lonAt = bx => plotMinLon + (bx / cssW) * deltaLon;
        const latAt = by => plotMinLat + ((cssH - by) / cssH) * deltaLat;
        return { minLon: lonAt(Math.min(x0, x1)), maxLon: lonAt(Math.max(x0, x1)),
                 minLat: latAt(Math.max(y0, y1)), maxLat: latAt(Math.min(y0, y1)) };
    }
    function isBoxInView(bbox, lonShift = 0) {
        if (!bbox) return true;
        const v = getVisibleGeoBounds(); if (!v) return true;
        const m = 3;
        return !(bbox[0] + lonShift > v.maxLon + m || bbox[2] + lonShift < v.minLon - m || bbox[1] > v.maxLat + m || bbox[3] < v.minLat - m);
    }

    function getHurricaneColorRGB(spd) {
        if (spd === null || spd === undefined || spd < 0) spd = 0;
        if (spd <= 63) return [0, 0, 0];
        if (spd <= 82) return [1, 1, 0.8];
        if (spd <= 95) return [1, 0.91, 0.46];
        if (spd <= 112) return [1, 0.76, 0.25];
        if (spd <= 136) return [1, 0.56, 0.13];
        return [1, 0.38, 0.38];
    }

    function getBarbColorMode() {
        return barbColorSelect.value === 'hurricane' ? 'hurricane' : 'wind';
    }

    function getPathColorRGB(d, idx) {
        const mode = pathColorSelect.value;
        if (mode === 'temp') {
            let t = d.tempr; if (t === null || tempBaseline[idx] === null) return [1, 1, 1];
            let delta = t - tempBaseline[idx]; let f = Math.min(Math.abs(delta) / 3.0, 1);
            if (delta > 0) return [1, 1 - f, 1 - f]; else return [1 - f, 1 - f, 1];
        }
        if (getBarbColorMode() === 'hurricane') return getHurricaneColorRGB(d.windSpd);
        return getSpdColorRGB(d.windSpd);
    }

    function getSpdColorRGB(spd) {
        if (!spd || spd < 0) spd = 0; let r, g, b;
        if (spd < 50) { let f = spd / 50; r = 0; g = 255 * f; b = 255; } 
        else if (spd < 80) { let f = (spd - 50) / 30; r = 0; g = 255; b = 255 - (255 * f); } 
        else if (spd < 100) { let f = (spd - 80) / 20; r = 255 * f; g = 255; b = 0; } 
        else if (spd < 130) { let f = (spd - 100) / 30; r = 255; g = 255 - (127 * f); b = 0; } 
        else { let f = Math.min((spd - 130) / 30, 1); r = 255; g = 128 - (128 * f); b = 0; }
        return [r/255, g/255, b/255];
    }
    
    function getBarbColorRGB(spd) {
        return getBarbColorMode() === 'hurricane' ? getHurricaneColorRGB(spd) : getSpdColorRGB(spd);
    }

    function getBarbColor(spd) { const [r, g, b] = getBarbColorRGB(spd); return `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`; }

    function getBarbSpacingPx() {
        // Screen-px gap between barbs along the track. The zoomed-out cap sets density at
        // low zoom (was 30, too sparse); zoomed in this converges to the same 8px floor.
        const zoom = Math.max(mapScale, 0.35);
        return Math.min(16, Math.max(8, 30 / zoom));
    }

    // Best-track overlay for the storm the loaded mission belongs to (js/12b-recon-archive.js), spanning
    // its whole life, not just the flight's window. Drawn UNDER the flight track/plane so the flight
    // stays the visually dominant element; getX/getY project it exactly like everything else on this
    // map (they're linear in lon/lat, not tied to the flight's own bounds).
    function drawStormTrack2D() {
        if (!showStormTrack || stormTrackPoints.length < 2) return;
        ctx.save();
        ctx.lineWidth = 2 / mapScale; ctx.globalAlpha = 0.95; ctx.setLineDash([6 / mapScale, 4 / mapScale]);
        for (let i = 1; i < stormTrackPoints.length; i++) {
            const a = stormTrackPoints[i - 1], b = stormTrackPoints[i];
            ctx.beginPath(); ctx.strokeStyle = stormWindColor(b.windKt); ctx.moveTo(getX(a.lon), getY(a.lat)); ctx.lineTo(getX(b.lon), getY(b.lat)); ctx.stroke();
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1.0;
        // Each fix is a small tropical-cyclone map symbol: category-colored disc with the
        // category written inside (TD/TS/1-5), spiral arms from TS strength up, drawn
        // slightly translucent so the basemap stays readable underneath.
        stormTrackPoints.forEach((p, i) => {
            const hovered = i === hoveredStormIdx;
            const col = stormWindColor(p.windKt), lbl = stormCatLabel(p.windKt);
            ctx.save(); ctx.translate(getX(p.lon), getY(p.lat)); ctx.scale(1 / mapScale, 1 / mapScale);
            ctx.globalAlpha = hovered ? 1.0 : 0.9;
            if (!lbl) {   // unknown intensity: keep a plain small fix marker
                ctx.beginPath(); ctx.arc(0, 0, hovered ? 6 : 4, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill();
                ctx.strokeStyle = hovered ? '#ffffff' : 'rgba(0,0,0,0.85)'; ctx.lineWidth = 1.2; ctx.stroke();
                ctx.restore(); return;
            }
            const r = hovered ? 8 : 6;
            if (p.windKt >= 34) {
                ctx.strokeStyle = col; ctx.lineWidth = r * 0.5; ctx.lineCap = 'round';
                ctx.beginPath(); ctx.moveTo(0, -r * 0.9); ctx.quadraticCurveTo(r * 1.9, -r * 1.35, r * 1.55, r * 0.45); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0, r * 0.9); ctx.quadraticCurveTo(-r * 1.9, r * 1.35, -r * 1.55, -r * 0.45); ctx.stroke();
            }
            ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill();
            ctx.strokeStyle = hovered ? '#ffffff' : 'rgba(0,0,0,0.85)'; ctx.lineWidth = hovered ? 2 : 1.2; ctx.stroke();
            // the fix the status card currently refers to carries a white label; every other fix dark
            const isCurrent = typeof currentStormFixIdx !== 'undefined' && i === currentStormFixIdx;
            ctx.fillStyle = isCurrent ? '#ffffff' : '#111827';
            ctx.font = '700 ' + (lbl.length > 1 ? r : r * 1.25) + 'px Inter, ui-sans-serif, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(lbl, 0, 0.5);
            ctx.restore();
        });
        ctx.restore();
    }

    function getPathColorHex(d, idx) {
        const [r, g, b] = getPathColorRGB(d, idx);
        return `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
    }

    function drawWindBarbFrame(x, y, dir, spd, scale, isDynamic = false) {
        const strokeColor = getBarbColor(spd);
        ctx.save(); ctx.translate(x, y); let mult = isDynamic ? 1.4 : 1; ctx.scale(mult / scale, mult / scale); ctx.rotate((dir - 90) * Math.PI/180);
        const drawShapes = () => {
            const shaftLength = 18; const featherBase = 6; const featherSpread = 0.85;
            ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(shaftLength, 0); ctx.stroke();
            let k = Math.round(spd/5)*5; let hx = shaftLength; const xa = Math.cos(60*Math.PI/180)*featherBase; const ya = Math.sin(60*Math.PI/180)*featherBase;
            while (k >= 50) { ctx.beginPath(); ctx.moveTo(hx,0); ctx.lineTo(hx-xa,ya); ctx.lineTo(hx-(3 * featherSpread),0); ctx.closePath(); ctx.fill(); ctx.stroke(); hx-=4 * featherSpread; k-=50; }
            while (k >= 10) { ctx.beginPath(); ctx.moveTo(hx,0); ctx.lineTo(hx-xa,ya); ctx.stroke(); hx-=3 * featherSpread; k-=10; }
            if (k >= 5) { ctx.beginPath(); ctx.moveTo(hx,0); ctx.lineTo(hx-xa/2,ya/2); ctx.stroke(); }
        };
        const isBlackBarb = strokeColor === 'rgb(0, 0, 0)';
        if (isBlackBarb) {
            ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; drawShapes();
        }
        if (isDynamic) { ctx.strokeStyle = '#000000'; ctx.fillStyle = '#000000'; ctx.lineWidth = 2.0; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; drawShapes(); }
        ctx.strokeStyle = strokeColor; ctx.fillStyle = strokeColor; ctx.lineWidth = 1.0; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter'; drawShapes();
        ctx.restore();
    }
    
    // Sutherland-Hodgman ring clip against a lon/lat box in the plot's lon domain (shift applied
    // first). Zoomed in far, the raw world rings project to paths millions of device px across
    // and the rasterizer silently drops them whole, visible land included; clipping every ring
    // to a padded view box keeps path extents small. The pad puts the clip's artificial box-edge
    // segments (and their strokes) outside the visible area.
    function clipRingToBox(ring, shift, box) {
        let out = [];
        for (const c of ring) out.push([c[0] + shift, c[1]]);
        const planes = [[1, 0, box.minLon], [-1, 0, -box.maxLon], [0, 1, box.minLat], [0, -1, -box.maxLat]];
        for (const [a, b, k] of planes) {
            if (!out.length) return out;
            const inp = out; out = [];
            for (let i = 0; i < inp.length; i++) {
                const P = inp[i], Q = inp[(i + 1) % inp.length];
                const dP = a * P[0] + b * P[1] - k, dQ = a * Q[0] + b * Q[1] - k;
                if (dP >= 0) out.push(P);
                if ((dP >= 0) !== (dQ >= 0)) { const t = dP / (dP - dQ); out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]); }
            }
        }
        return out;
    }

    // Geometry clipping kicks in past this zoom; below it the raw paths are small enough for the
    // rasterizer and the draw stays byte-identical to the unclipped output.
    const MAP_CLIP_MIN_SCALE = 6;
    function mapClipBox() {
        if (mapScale <= MAP_CLIP_MIN_SCALE) return null;
        const v = getVisibleGeoBounds(); if (!v) return null;
        const padLon = (v.maxLon - v.minLon) * 0.5, padLat = (v.maxLat - v.minLat) * 0.5;
        return { minLon: v.minLon - padLon, maxLon: v.maxLon + padLon, minLat: v.minLat - padLat, maxLat: v.maxLat + padLat };
    }

    // Airfield codes: the flight's takeoff and landing fields (the airfield nearest each end of the
    // track), each drawn while the plane is within AIRPORT_RADIUS_NM of it, plus the home field (LAL)
    // drawn whenever it is within the map view, as a fixed geographic reference. Drawn on the live
    // foreground so they follow the playhead. Home + military take the accent.
    const AIRPORT_HOME_CODE = 'LAL';   // Lakeland Linder, the AOC's home field
    const AIRPORT_RADIUS_NM = 60;      // show a takeoff/landing field only within this of the plane
    // The home field object (once airports load), cached; drawn as a constant geographic reference.
    let _homeAirport = null, _homeSet = false;
    function homeAirport() {
        if (!_homeSet && airports.length) { _homeAirport = airports.find(a => a.code === AIRPORT_HOME_CODE) || null; _homeSet = true; }
        return _homeAirport;
    }
    // The takeoff + landing fields: the airfield nearest each end of the track, within the radius of that
    // end (so a track that opens/closes already far from any field yields none). Cached per flight.
    let _endpointAirports = null, _endpointKey = '';
    function endpointAirports() {
        if (!airports.length || filteredData.length === 0) return [];
        const n = filteredData.length, a0 = filteredData[0], aN = filteredData[n - 1];
        const key = n + '|' + a0.lon + ',' + a0.lat + '|' + aN.lon + ',' + aN.lat;
        if (key === _endpointKey && _endpointAirports) return _endpointAirports;
        const rad2 = (AIRPORT_RADIUS_NM / 60) * (AIRPORT_RADIUS_NM / 60);
        const nearest = (lat, lon) => {
            if (!isFinite(lat) || !isFinite(lon)) return null;
            const cosLat = Math.cos(lat * Math.PI / 180) || 1;
            let best = null, bd = rad2;
            for (let i = 0; i < airports.length; i++) {
                const a = airports[i], dLat = a.lat - lat, dLon = (a.lon - lon) * cosLat, dd = dLat * dLat + dLon * dLon;
                if (dd < bd) { bd = dd; best = a; }
            }
            return best;
        };
        const out = [], seen = new Set();
        [nearest(a0.lat, a0.lon), nearest(aN.lat, aN.lon)].forEach(a => { if (a && !seen.has(a.code)) { seen.add(a.code); out.push(a); } });
        _endpointAirports = out; _endpointKey = key;
        return out;
    }
    function drawAirportsNearPlane(cLat, cLon) {
        if (!airports.length) return;
        const rad2 = (AIRPORT_RADIUS_NM / 60) * (AIRPORT_RADIUS_NM / 60);
        // draw set: the takeoff/landing fields within the radius of the plane, plus the home field
        // whenever it is within the map view. deduped by code.
        const drawn = new Set(), toDraw = [];
        if (isFinite(cLat) && isFinite(cLon)) {
            const cosLat = Math.cos(cLat * Math.PI / 180) || 1;
            endpointAirports().forEach(a => {
                const dLat = a.lat - cLat, dLon = (a.lon - cLon) * cosLat;
                if (dLat * dLat + dLon * dLon <= rad2 && !drawn.has(a.code)) { drawn.add(a.code); toDraw.push(a); }
            });
        }
        const home = homeAirport(), v = getVisibleGeoBounds();
        if (home && !drawn.has(home.code) && v && home.lat >= v.minLat && home.lat <= v.maxLat && home.lon >= v.minLon && home.lon <= v.maxLon) {
            drawn.add(home.code); toDraw.push(home);
        }
        if (!toDraw.length) return;
        const lightMap = document.documentElement.dataset.theme === 'light';
        ctx.save();
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 2.5 / mapScale; ctx.lineJoin = 'round';
        const r = 2.2 / mapScale, pad = 4 / mapScale;
        for (let i = 0; i < toDraw.length; i++) {
            const a = toDraw[i], home2 = a.code === AIRPORT_HOME_CODE;
            const x = getX(a.lon), y = getY(a.lat);
            // home + military in the accent, civil in a neutral ink; all keylined to read over land/water.
            const col = (home2 || a.mil) ? '#38bdf8' : (lightMap ? '#1f2937' : '#e2e8f0');
            ctx.font = '600 ' + ((home2 ? 12 : 10) / mapScale) + 'px Inter, ui-sans-serif, sans-serif';
            ctx.beginPath(); ctx.arc(x, y, home2 ? r * 1.5 : r, 0, 2 * Math.PI);
            ctx.fillStyle = col; ctx.fill();
            ctx.strokeStyle = lightMap ? 'rgba(255,255,255,0.9)' : 'rgba(5,12,20,0.85)';
            ctx.stroke();
            ctx.strokeText(a.code, x + pad, y);
            ctx.fillStyle = col; ctx.fillText(a.code, x + pad, y);
        }
        ctx.restore();
    }

    function renderBackground() {
        if (!bgCanvas.width || !bgCanvas.height) return;
        // theme-aware basemap palette (ocean base fill here; land and lines below)
        const lightMap = document.documentElement.dataset.theme === 'light';
        bgCtx.setTransform(1, 0, 0, 1, 0, 0); bgCtx.fillStyle = lightMap ? '#d4e3f0' : '#0e1a29'; bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
        bgCtx.save(); bgCtx.setTransform(DPR, 0, 0, DPR, 0, 0); bgCtx.translate(mapOffsetX, mapOffsetY); bgCtx.scale(mapScale, mapScale);

        const clipBox = mapClipBox();
        const xOf = lon => ((lon - plotMinLon) / deltaLon) * cssW;   // lon already in the plot domain
        if (mapFeatures.length > 0) {
            // muted land over the ocean base, soft coastlines, and fainter internal (state) borders.
            const landFill = lightMap ? '#e4ebdd' : '#22463a';
            const coastCol = lightMap ? '#5e6f7c' : '#7ea8bf';
            const borderCol = lightMap ? 'rgba(94,111,124,0.50)' : 'rgba(126,168,191,0.40)';
            bgCtx.fillStyle = landFill;
            const strokeFor = isState => { bgCtx.strokeStyle = isState ? borderCol : coastCol; bgCtx.lineWidth = (isState ? 1.0 : 1.5) / mapScale; };
            // Draw the whole world, cull off-screen, and repeat it shifted ±360 so a dateline-centered
            // or zoomed-out view shows continuous land instead of an empty seam. Projects with the
            // raw (unwrapped) x, wrapping would cancel the shift.
            const getXShift = (lon, shift) => xOf(lon + shift);
            // Clipped rings lose the data's repeated closing point, so close the subpath for the
            // stroke; the unclipped branch keeps the original untouched draw.
            const traceRing = (ring, shift) => {
                if (!clipBox) {
                    ring.forEach((coord, i) => { const x = getXShift(coord[0], shift); const y = getY(coord[1]); if (i === 0) bgCtx.moveTo(x, y); else bgCtx.lineTo(x, y); });
                    return;
                }
                const pts = clipRingToBox(ring, shift, clipBox);
                pts.forEach((p, i) => { const x = xOf(p[0]); const y = getY(p[1]); if (i === 0) bgCtx.moveTo(x, y); else bgCtx.lineTo(x, y); });
                if (pts.length) bgCtx.closePath();
            };
            for (const shift of [0, -360, 360]) {
                mapFeatures.forEach(feature => {
                    if (!isBoxInView(feature.properties.bbox, shift)) return;
                    const geom = feature.geometry; if (!geom) return;
                    const isState = feature.properties && feature.properties.isState === true;
                    strokeFor(isState);
                    if (geom.type === 'Polygon') {
                        bgCtx.beginPath(); geom.coordinates.forEach(ring => traceRing(ring, shift));
                        if (!isState) bgCtx.fill('evenodd'); bgCtx.stroke();
                    } else if (geom.type === 'MultiPolygon') {
                        geom.coordinates.forEach(poly => { bgCtx.beginPath(); poly.forEach(ring => traceRing(ring, shift));
                        if (!isState) bgCtx.fill('evenodd'); bgCtx.stroke(); });
                    }
                });
            }
        }
        bgCtx.restore(); bgNeedsUpdate = false;
    }

    function renderMapEngineFrame(idx, visualRow) {
        if (!canvas.width || !canvas.height) return;
        // Follow mode keeps the plane centered every frame; recenter (and mark the background dirty
        // since the pan moved) before drawing.
        if (followAircraft2D && (visualRow || filteredData[idx])) { centerMapOnPlane2D(visualRow || filteredData[idx]); bgNeedsUpdate = true; }
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1.0; ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (bgNeedsUpdate) renderBackground();
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bgCanvas, 0, 0);   // bgCanvas is already device-res
        // Base transform = devicePixelRatio, then the map pan/zoom. Everything below draws in logical px.
        ctx.save(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.translate(mapOffsetX, mapOffsetY); ctx.scale(mapScale, mapScale);

        drawStormTrack2D();

        // flight track drawn as a uniform catmull-rom curve, one cubic bezier per 1 Hz segment,
        // so the line stays smooth through turns. control points are computed in screen space; cp
        // is a single reused object (setSeg
        // mutates it) so a long flight doesn't allocate per segment per frame.
        const _n = filteredData.length;
        const _gx = j => getX(filteredData[j < 0 ? 0 : (j > _n - 1 ? _n - 1 : j)].lon);
        const _gy = j => getY(filteredData[j < 0 ? 0 : (j > _n - 1 ? _n - 1 : j)].lat);
        const cp = { x1: 0, y1: 0, c1x: 0, c1y: 0, c2x: 0, c2y: 0, x2: 0, y2: 0 };
        const setSeg = (i) => {   // fills cp for the curve filteredData[i-1] -> filteredData[i]
            const p0x = _gx(i - 2), p0y = _gy(i - 2), p1x = _gx(i - 1), p1y = _gy(i - 1);
            const p2x = _gx(i), p2y = _gy(i), p3x = _gx(i + 1), p3y = _gy(i + 1);
            cp.x1 = p1x; cp.y1 = p1y; cp.x2 = p2x; cp.y2 = p2y;
            cp.c1x = p1x + (p2x - p0x) / 6; cp.c1y = p1y + (p2y - p0y) / 6;
            cp.c2x = p2x - (p3x - p1x) / 6; cp.c2y = p2y - (p3y - p1y) / 6;
        };

        // flown track: in QC Mode a single solid accent color so "already past this point" reads at a
        // glance against the faint-grey not-yet-flown track (the visualizer's metric gradient instead
        // blends into the plane). elsewhere keep the metric-colored path.
        // sub-pixel segments are merged, not dropped: skipping each tiny segment on its own erased
        // whole slow-flown stretches (the track looked like it vanished behind the plane)
        ctx.lineWidth = 2.5/mapScale; ctx.globalAlpha = window.QC_MODE ? 0.95 : 0.8;
        let flx = null, fly = null;
        for (let i = 1; i <= idx; i++) {
            setSeg(i);
            if (flx === null) { flx = cp.x1; fly = cp.y1; }
            if (Math.abs(cp.x2 - flx) < 1 && Math.abs(cp.y2 - fly) < 1 && i !== idx) continue;
            ctx.beginPath(); ctx.strokeStyle = window.QC_MODE ? '#5b9dff' : getPathColorHex(filteredData[i], i);
            ctx.moveTo(flx, fly); ctx.bezierCurveTo(cp.c1x, cp.c1y, cp.c2x, cp.c2y, cp.x2, cp.y2); ctx.stroke();
            flx = cp.x2; fly = cp.y2;
        }

        // Future (not-yet-flown) track, faint grey, same smooth curve. Normally one continuous path, but
        // zoomed in far that single path spans a device-pixel extent the rasterizer drops whole (the same
        // failure the polygon clip fixes), so past the clip threshold stroke it per on-screen segment.
        ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.5/mapScale; ctx.globalAlpha = 0.3;
        const clipHi = mapScale > MAP_CLIP_MIN_SCALE;
        const onScreen = (x, y) => { const sx = mapOffsetX + mapScale * x, sy = mapOffsetY + mapScale * y; return sx > -cssW && sx < 2 * cssW && sy > -cssH && sy < 2 * cssH; };
        if (clipHi) {
            for (let i = idx + 1; i < filteredData.length; i++) {
                setSeg(i);
                if (onScreen(cp.x2, cp.y2) || onScreen(cp.x1, cp.y1)) { ctx.beginPath(); ctx.moveTo(cp.x1, cp.y1); ctx.bezierCurveTo(cp.c1x, cp.c1y, cp.c2x, cp.c2y, cp.x2, cp.y2); ctx.stroke(); }
            }
        } else {
            ctx.beginPath(); let started = false;
            for (let i = idx + 1; i < filteredData.length; i++) {
                setSeg(i);
                if (!started) { ctx.moveTo(cp.x1, cp.y1); started = true; }
                ctx.bezierCurveTo(cp.c1x, cp.c1y, cp.c2x, cp.c2y, cp.x2, cp.y2);
            }
            if (started) ctx.stroke();
        }
        ctx.globalAlpha = 1.0;

        const targetSpacing = getBarbSpacingPx();
        let lastBarbIdx = -1;
        let lastBarbX = null;
        let lastBarbY = null;
        for (let i = 0; i <= idx; i++) {
            const d = filteredData[i];
            if (d.windDir === null || d.windSpd === null) continue;
            if (lastBarbIdx < 0) {
                drawWindBarbFrame(getX(d.lon), getY(d.lat), d.windDir, d.windSpd, mapScale);
                lastBarbIdx = i;
                lastBarbX = getX(d.lon);
                lastBarbY = getY(d.lat);
                continue;
            }
            const x = getX(d.lon), y = getY(d.lat);
            const distPx = Math.hypot((x - lastBarbX) * mapScale, (y - lastBarbY) * mapScale);
            if (distPx >= targetSpacing) {
                drawWindBarbFrame(x, y, d.windDir, d.windSpd, mapScale);
                lastBarbIdx = i;
                lastBarbX = x;
                lastBarbY = y;
            }
        }
        if (idx >= 0 && filteredData[idx] && filteredData[idx].windDir !== null && filteredData[idx].windSpd !== null && lastBarbIdx !== idx) {
            const d = filteredData[idx]; drawWindBarbFrame(getX(d.lon), getY(d.lat), d.windDir, d.windSpd, mapScale);
        }

        let dPlane = visualRow || filteredData[idx];
        if (dPlane) drawAirportsNearPlane(dPlane.lat, dPlane.lon);
        if (dPlane) {
            const d = dPlane; ctx.save(); ctx.translate(getX(d.lon), getY(d.lat)); ctx.scale(1/mapScale, 1/mapScale);
            const zoomFactor = Math.max(1, Math.pow(mapScale, 0.6));
            if (document.getElementById('simpleTrackerIcon').checked) {
                ctx.beginPath(); ctx.arc(0, 0, 3 * zoomFactor, 0, 2 * Math.PI); ctx.fillStyle = '#e2e4e8'; ctx.fill(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 * zoomFactor; ctx.stroke();
            } else {
                const planeScale = 0.15 * zoomFactor; let t_th = d.th ?? 0; let t_track = d.gTrack ?? 0;
                // ground-track (blue) and true-heading (yellow) arrows ahead of the plane, the
                // same pair the 3D tracker flies: translucent so the dynamic wind barb stays
                // readable through them, the heading arrow nesting inside the track arrow
                // whenever the two agree
                const arrow2D = (deg, color, s1, lw) => {
                    ctx.save(); ctx.rotate((deg - 90) * Math.PI / 180); ctx.globalAlpha = 0.55;
                    ctx.beginPath(); ctx.moveTo(14 * zoomFactor, 0); ctx.lineTo(s1 * zoomFactor, 0);
                    ctx.strokeStyle = color; ctx.lineWidth = lw * zoomFactor; ctx.stroke();
                    ctx.beginPath(); ctx.moveTo((s1 + 8) * zoomFactor, 0);
                    ctx.lineTo(s1 * zoomFactor, -3.2 * zoomFactor); ctx.lineTo(s1 * zoomFactor, 3.2 * zoomFactor);
                    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
                    ctx.restore();
                };
                // ground-track + true-heading arrows are visualizer chrome; QC Mode hides them to
                // keep the track clean (window.QC_MODE set by js/23-qc-report.js).
                if (!window.QC_MODE) { arrow2D(t_track, '#3da5ff', 30, 2.6); arrow2D(t_th, '#ffd400', 26, 2); }
                ctx.save(); ctx.rotate((t_th - 90) * Math.PI/180); ctx.scale(planeScale, planeScale); (isGulfstreamFlight() ? drawGulfstreamIV : drawP3Orion)(ctx); ctx.restore();
            }
            ctx.restore(); 

            if (d.windDir !== null && d.windSpd !== null) {
                let headOffset = (d.th !== null ? d.th : (d.gTrack || 0)) * (Math.PI / 180);
                // sit just off the glyph's nose tip (glyph nose is at ~x=25 in its local frame, so
                // the tip in the scaled frame tracks planeScale); the barb itself keeps its own
                // size (drawWindBarbFrame's isDynamic scale is independent of the glyph scale).
                const noseDist = 3.75 * zoomFactor / mapScale; let noseX = getX(d.lon) + Math.sin(headOffset) * noseDist; let noseY = getY(d.lat) - Math.cos(headOffset) * noseDist;
                drawWindBarbFrame(noseX, noseY, d.windDir, d.windSpd, mapScale, true);
            }
        }

        customMarkers.forEach(marker => {
            if (marker.idx <= idx && filteredData[marker.idx]) {
                const mx = getX(filteredData[marker.idx].lon); const my = getY(filteredData[marker.idx].lat);
                ctx.save(); ctx.translate(mx, my); ctx.scale(1/mapScale, 1/mapScale); ctx.beginPath(); ctx.arc(0, 0, 8, 0, 2 * Math.PI); ctx.fillStyle = marker.color; ctx.fill(); ctx.strokeStyle = '#000000'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
            }
        });

        ctx.restore();
    }

