/* Mission Visualizer, geo math + measurement hit-testing
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    // True point-in-polygon (ray casting) so each shape can be selected/moved individually.
    function pointInPolygon(pts, lat, lon) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i].lon, yi = pts[i].lat, xj = pts[j].lon, yj = pts[j].lat;
            const intersect = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    // Pixel distance from a point to a segment (used to hover-select 2-point "line" polygons).
    function distToSegmentPx(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay; const len2 = dx*dx + dy*dy;
        let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
    }
    function pointInOneShape(type, pts, g) {
        if (!pts || pts.length === 0) return false;
        if (type === 'circle' && pts.length === 2) {
            const rNM = getDistanceNM(pts[0].lat, pts[0].lon, pts[1].lat, pts[1].lon);
            return getDistanceNM(pts[0].lat, pts[0].lon, g.lat, g.lon) <= rNM;
        }
        if (type === 'rectangle' && pts.length === 2) {
            const minLat = Math.min(pts[0].lat, pts[1].lat), maxLat = Math.max(pts[0].lat, pts[1].lat);
            const minLon = Math.min(pts[0].lon, pts[1].lon), maxLon = Math.max(pts[0].lon, pts[1].lon);
            return g.lat >= minLat && g.lat <= maxLat && g.lon >= minLon && g.lon <= maxLon;
        }
        if (type === 'polygon') {
            if (pts.length >= 3) return pointInPolygon(pts, g.lat, g.lon);
            if (pts.length === 2) {
                // 2-point polygon = a line: hit if within ~14px of the segment (generous so the
                // thin line is easy to grab/hover).
                const ax = getX(pts[0].lon)*mapScale + mapOffsetX, ay = getY(pts[0].lat)*mapScale + mapOffsetY;
                const bx = getX(pts[1].lon)*mapScale + mapOffsetX, by = getY(pts[1].lat)*mapScale + mapOffsetY;
                const px = getX(g.lon)*mapScale + mapOffsetX, py = getY(g.lat)*mapScale + mapOffsetY;
                return distToSegmentPx(px, py, ax, ay, bx, by) <= 14;
            }
        }
        return false;
    }
    // Returns the index of the top-most committed shape under a geo point, or -1.
    function shapeIndexAtGeo(g) {
        for (let i = drawnShapes.length - 1; i >= 0; i--) {
            if (pointInOneShape(drawnShapes[i].type, drawnShapes[i].points, g)) return i;
        }
        return -1;
    }
    // Hit-test the on-canvas ✓/✕ buttons (positions are in canvas/CSS pixels).
    function measureButtonAt(mx, my) {
        for (const b of measureButtons) { if (Math.hypot(mx - b.sx, my - b.sy) <= b.r) return b; }
        return null;
    }
    function commitActivePolygon() {
        if (measureShape === 'polygon' && measurePointsGeo.length >= 2) {
            drawnShapes.push({ type: 'polygon', points: [...measurePointsGeo] });
        } else if ((measureShape === 'circle' || measureShape === 'rectangle') && measurePointsGeo.length >= 2) {
            drawnShapes.push({ type: measureShape, points: [measurePointsGeo[0], measurePointsGeo[1]] });
        }
        measurePointsGeo = []; liveMouseGeo = null;
    }

    function getDistanceNM(lat1, lon1, lat2, lon2) {
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
        return EARTH_RADIUS_NM * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
    }

    function screenToGeo(screenX, screenY) {
        const rect = canvas.getBoundingClientRect();
        const x = screenX - rect.left, y = screenY - rect.top;
        const baseCanvasX = (x - mapOffsetX) / mapScale;
        const baseCanvasY = (y - mapOffsetY) / mapScale;
        const lon = plotMinLon + (baseCanvasX / cssW) * deltaLon;
        const lat = plotMinLat - ((baseCanvasY - cssH) / cssH) * deltaLat;
        return { lat, lon };
    }
