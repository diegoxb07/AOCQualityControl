/* Mission Visualizer, bundled low-res terrain (ETOPO) for the 3D basemap
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   data/etopo-heightmap.png is a 721x361 (0.5 deg) global ETOPO elevation grid, source NOAA NCEI via
   the CoastWatch ERDDAP (etopo180). Elevation in metres is packed into the R and G channels:
   elev = (R*256 + G) - 11000. Row 0 is the north edge (+90 lat), columns run west (-180) to east.
   It gives the 3D basemap real land height and tells land from sea, so a flight over high ground sits
   at the correct height relative to the terrain. */

    const TERRAIN_OFFSET = 11000;   // packed value = elev + this; see data/etopo-heightmap.png
    let _terrain = null;            // { w, h, data: Float32Array } once the png decodes, else null

    function isTerrainLoaded() { return !!_terrain; }

    // Bilinearly sampled ground elevation (metres) at a lat/lon; 0 until the grid loads.
    function terrainElevationMeters(lat, lon) {
        if (!_terrain) return 0;
        const w = _terrain.w, h = _terrain.h, data = _terrain.data;
        const L = ((lon + 180) % 360 + 360) % 360 - 180;   // wrap to -180..180
        const fx = (L + 180) / 360 * (w - 1);
        const fy = (90 - lat) / 180 * (h - 1);             // row 0 = north (+90)
        const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
        const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        const e00 = data[y0 * w + x0], e10 = data[y0 * w + x1], e01 = data[y1 * w + x0], e11 = data[y1 * w + x1];
        return (e00 * (1 - tx) + e10 * tx) * (1 - ty) + (e01 * (1 - tx) + e11 * tx) * ty;
    }

    // The padded box the terrain covers. Kept close to the flight: relief far from it carries no
    // information about the mission and competes with the track for the eye. Shared, so build3DScene
    // can prime the land mask from it before it drapes anything on the surface.
    const TERRAIN_PAD = 0.4;
    function terrainExtent() {
        if (typeof plotMinLon === 'undefined' || plotMinLon == null) return null;
        const spanLon = (plotMaxLon - plotMinLon) || 1, spanLat = (plotMaxLat - plotMinLat) || 1;
        return {
            lon0: plotMinLon - spanLon * TERRAIN_PAD, lon1: plotMaxLon + spanLon * TERRAIN_PAD,
            lat0: plotMinLat - spanLat * TERRAIN_PAD, lat1: plotMaxLat + spanLat * TERRAIN_PAD
        };
    }
    function refreshTerrainMask() {
        const e = terrainExtent();
        if (e) buildLandMask(e.lon0, e.lon1, e.lat0, e.lat1);
    }

    // Land is what the country borders enclose, not what sits above sea level, so ground inside a
    // coastline reads as land at any height. The borders are rasterised once per extent into a mask
    // and sampled per vertex: testing 14,400 vertices against 242 country outlines of ~100k points
    // between them runs to tens of millions of crossings, while a fill is one native raster and the
    // lookups are then flat.
    let _landMask = null;
    function buildLandMask(lon0, lon1, lat0, lat1) {
        if (typeof mapFeatures === 'undefined' || !mapFeatures.length) { _landMask = null; return null; }
        // The feature count is part of the key, so a mask raised before the basemap finished loading
        // is rebuilt once it has.
        if (_landMask && _landMask.lon0 === lon0 && _landMask.lon1 === lon1
            && _landMask.lat0 === lat0 && _landMask.lat1 === lat1 && _landMask.n === mapFeatures.length) return _landMask;
        const W = 512, H = 512;
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const c = cv.getContext('2d', { willReadFrequently: true });
        c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
        c.fillStyle = '#fff';
        c.beginPath();
        traceLandPath(c, lon => (lon - lon0) / (lon1 - lon0) * W, lat => (lat1 - lat) / (lat1 - lat0) * H);
        c.fill('evenodd');   // later rings are holes, the same rule the 2D basemap fills by
        const px = c.getImageData(0, 0, W, H).data;
        const data = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) data[i] = px[i * 4] > 127 ? 1 : 0;
        _landMask = { w: W, h: H, lon0, lon1, lat0, lat1, n: mapFeatures.length, data };
        return _landMask;
    }

    // True inside a country outline. Falls back to sea level while the basemap has not loaded, so a
    // terrain built before the borders arrive still tells land from water.
    function isLandAt(lat, lon) {
        const m = _landMask;
        if (!m) return terrainElevationMeters(lat, lon) >= 0;
        const x = Math.round((lon - m.lon0) / (m.lon1 - m.lon0) * (m.w - 1));
        const y = Math.round((m.lat1 - lat) / (m.lat1 - m.lat0) * (m.h - 1));
        if (x < 0 || x >= m.w || y < 0 || y >= m.h) return false;
        return m.data[y * m.w + x] === 1;
    }

    // One flat tone per theme for water. Depth is not shaded, the sea floor's shape being no part of
    // what this map is read for. Pitched to hold against the 3D scene background (scene3DBgColor in
    // js/07-ui-controls.js) rather than against the 2D basemap's darker ocean, which it would sink into.
    function waterColorCss() {
        return (document.documentElement.dataset.theme === 'light') ? 'rgb(148,184,217)' : 'rgb(18,51,82)';
    }

    // Land color (0..1 rgb) by height: green->tan->snow. One ramp across themes, its mid-tones
    // holding against both, and it starts at green, so ground below sea level inside a coastline
    // still reads as land.
    function landColorRGB(e) {
        const t = Math.max(0, Math.min(1, e / 4000));
        if (t < 0.5) { const s = t / 0.5; return [0.17 + 0.36 * s, 0.42 - 0.05 * s, 0.20 - 0.01 * s]; }   // green -> tan
        const s = (t - 0.5) / 0.5; return [0.53 + 0.30 * s, 0.37 + 0.34 * s, 0.18 + 0.55 * s];             // tan -> snow
    }

    // Trace the country outlines into the current path, in the given lon/lat to pixel frame. States
    // are skipped: their country's outline already encloses them.
    function traceLandPath(c, X, Y) {
        mapFeatures.forEach(f => {
            if (f.properties && f.properties.isState) return;
            const g = f.geometry; if (!g) return;
            const polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : []);
            polys.forEach(poly => poly.forEach(ring => ring.forEach((p, i) => {
                const x = X(p[0]), y = Y(p[1]);
                if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
            })));
        });
    }

    // The surface's colour, painted rather than taken per-vertex, so the coastline comes from the
    // vector outlines at texture resolution instead of the mesh's ~23 km vertex spacing. Shading is
    // rasterised at TERRAIN_SHADE and scaled up, the elevation source being half-degree; only the
    // coastline needs TERRAIN_TEX.
    const TERRAIN_TEX = 2048, TERRAIN_SHADE = 256;

    // Held across rebuilds and keyed on everything it draws from. build3DScene runs on a dozen
    // events and drops the old mesh without disposing it, so raising a fresh 2048 texture each time
    // would hand the GPU a new one per rebuild and never give the last back.
    let _terrainTex = null;
    function terrainTexture(lon0, lon1, lat0, lat1) {
        const key = [lon0, lon1, lat0, lat1, document.documentElement.dataset.theme,
                     (typeof mapFeatures !== 'undefined' ? mapFeatures.length : 0)].join('|');
        if (_terrainTex && _terrainTex.key === key) return _terrainTex.tex;
        if (_terrainTex) _terrainTex.tex.dispose();
        _terrainTex = { key, tex: buildTerrainTexture(lon0, lon1, lat0, lat1) };
        return _terrainTex.tex;
    }

    function buildTerrainTexture(lon0, lon1, lat0, lat1) {
        const shadeCv = document.createElement('canvas');
        shadeCv.width = TERRAIN_SHADE; shadeCv.height = TERRAIN_SHADE;
        const sctx = shadeCv.getContext('2d');
        const img = sctx.createImageData(TERRAIN_SHADE, TERRAIN_SHADE);
        for (let y = 0; y < TERRAIN_SHADE; y++) {
            for (let x = 0; x < TERRAIN_SHADE; x++) {
                const lon = lon0 + (lon1 - lon0) * x / (TERRAIN_SHADE - 1);
                const lat = lat1 - (lat1 - lat0) * y / (TERRAIN_SHADE - 1);
                const c = landColorRGB(terrainGroundMeters(lat, lon));
                const i = (y * TERRAIN_SHADE + x) * 4;
                img.data[i] = c[0] * 255; img.data[i + 1] = c[1] * 255; img.data[i + 2] = c[2] * 255; img.data[i + 3] = 255;
            }
        }
        sctx.putImageData(img, 0, 0);

        const cv = document.createElement('canvas');
        cv.width = TERRAIN_TEX; cv.height = TERRAIN_TEX;
        const c = cv.getContext('2d');
        c.fillStyle = waterColorCss();
        c.fillRect(0, 0, TERRAIN_TEX, TERRAIN_TEX);
        if (typeof mapFeatures !== 'undefined' && mapFeatures.length) {
            const X = lon => (lon - lon0) / (lon1 - lon0) * TERRAIN_TEX;
            const Y = lat => (lat1 - lat) / (lat1 - lat0) * TERRAIN_TEX;
            c.save();
            c.beginPath();
            traceLandPath(c, X, Y);
            c.clip('evenodd');   // later rings are holes, the same rule the 2D basemap fills by
            c.drawImage(shadeCv, 0, 0, TERRAIN_TEX, TERRAIN_TEX);
            c.restore();
        }
        const tex = new THREE.CanvasTexture(cv);
        // The surface is read at a grazing angle from a low camera, which is what smears a texture
        tex.anisotropy = (typeof renderer3D !== 'undefined' && renderer3D && renderer3D.capabilities)
            ? renderer3D.capabilities.getMaxAnisotropy() : 1;
        tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
        return tex;
    }

    // How far from an end the ground is pulled toward the aircraft, and how far off the grid may be
    // before that end is taken as airborne rather than on a field.
    const TERRAIN_PIN_DEG = 1.5;
    const TERRAIN_PIN_MAX_M = 300;

    // The track's ends, each with the gap between the aircraft and the ground under it. The grid
    // averages a field's elevation into its half-degree cell, so the two touch by tens of metres.
    // A gap over TERRAIN_PIN_MAX_M means the aircraft is airborne there, not on a field, and is left
    // alone (the parser drops rows under 20 kt, so a track can open already climbing).
    function terrainPins() {
        if (typeof filteredData === 'undefined' || filteredData.length < 2) return [];
        if (typeof track3DAltMeters !== 'function') return [];
        const out = [];
        [filteredData[0], filteredData[filteredData.length - 1]].forEach(d => {
            if (!d || d.lat == null || d.lon == null) return;
            const delta = track3DAltMeters(d) - terrainElevationMeters(d.lat, d.lon);
            if (Math.abs(delta) > TERRAIN_PIN_MAX_M) return;
            out.push({ lat: d.lat, lon: d.lon, delta });
        });
        return out;
    }

    // The pins in force for the current scene. Refreshed by refreshTerrainPins() at each build, so
    // the surface and everything draped on it read one ground.
    let _terrainPins = [];
    function refreshTerrainPins() { _terrainPins = terrainPins(); }

    // Ground elevation with the ends pinned to the aircraft, fading out over TERRAIN_PIN_DEG. Only
    // the nearest pin applies, so a there-and-back mission that starts and ends on the same field
    // corrects once rather than twice. This is the raw ground, which runs below sea level over
    // water; terrainSurfaceMeters below is what the map is drawn at.
    function terrainGroundMeters(lat, lon) {
        const e = terrainElevationMeters(lat, lon);
        if (!_terrainPins.length) return e;
        let best = null, bestD = Infinity;
        for (let i = 0; i < _terrainPins.length; i++) {
            const p = _terrainPins[i], dLon = (lon - p.lon) * Math.cos(lat * Math.PI / 180), dLat = lat - p.lat;
            const d = Math.hypot(dLon, dLat);
            if (d < bestD) { bestD = d; best = p; }
        }
        if (!best || bestD >= TERRAIN_PIN_DEG) return e;
        const t = bestD / TERRAIN_PIN_DEG;
        return e + best.delta * (1 - t * t * (3 - 2 * t));   // smoothstep out to the radius
    }

    // The height the map is drawn at. Land keeps its ground whatever it reads, so a coastline that
    // encloses ground below sea level dips rather than flooding and the aircraft stays over it.
    // Water lies flat at sea level, but for a pin's reach of a field, where the ground rides up to
    // meet the aircraft: an island small enough for the borders to miss still gets its ground.
    // Anything laid on the surface reads this rather than the raw ground.
    function terrainSurfaceMeters(lat, lon) {
        const g = terrainGroundMeters(lat, lon);
        return isLandAt(lat, lon) ? g : Math.max(0, g);
    }

    // A terrain surface over the flight's horizontal extent (plus margin), sampled from the grid and
    // placed with the SAME mapping as the track (get3DCoord). Returns a THREE.Group, or null if the
    // grid has not loaded or three.js / plot bounds are not ready.
    function buildTerrainMesh3D() {
        if (!_terrain || typeof THREE === 'undefined' || typeof get3DCoord !== 'function') return null;
        const ext = terrainExtent(); if (!ext) return null;
        const lon0 = ext.lon0, lon1 = ext.lon1, lat0 = ext.lat0, lat1 = ext.lat1;
        // This mesh is the colored surface in 3D (the flat land fills only build when the grid is
        // absent). The grid stays finer than the source's own 0.5 degree spacing at a typical
        // storm's span, so the sampling costs no detail.
        const NX = 120, NY = 120;
        const grp = new THREE.Group();
        buildLandMask(lon0, lon1, lat0, lat1);   // no-op when build3DScene already primed this extent
        const verts = [], uvs = [], idx = [];
        for (let iy = 0; iy < NY; iy++) {
            for (let ix = 0; ix < NX; ix++) {
                const lon = lon0 + (lon1 - lon0) * ix / (NX - 1);
                const lat = lat0 + (lat1 - lat0) * iy / (NY - 1);
                // The mesh carries height only; the texture carries land, water and shading. The mask
                // still decides here whether the ground may dip below sea level.
                const p = get3DCoord(lon, lat, terrainSurfaceMeters(lat, lon));
                verts.push(p.x, p.y, p.z);
                // CanvasTexture flips Y by default, so the canvas's top row (lat1) reads at v=1,
                // which is the north edge, where iy runs out.
                uvs.push(ix / (NX - 1), iy / (NY - 1));
            }
        }
        for (let iy = 0; iy < NY - 1; iy++) {
            for (let ix = 0; ix < NX - 1; ix++) {
                const a = iy * NX + ix, b = a + 1, c = a + NX, d = c + 1;
                idx.push(a, c, b, b, c, d);
            }
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geom.setIndex(idx);
        const terrain = new THREE.Mesh(geom,
            new THREE.MeshBasicMaterial({ map: terrainTexture(lon0, lon1, lat0, lat1), side: THREE.DoubleSide }));
        terrain.renderOrder = -2;   // draw under the track, storm ribbon and plane
        grp.add(terrain);
        return grp;
    }

    // Decode the packed elevation png into a Float32Array once, on window load (so assetVer and the
    // 3D scene helpers exist). Rebuilds a live 3D flight so the terrain shows without a manual nudge.
    function loadTerrainGrid() {
        const img = new Image();
        img.onload = () => {
            try {
                const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
                const c = cv.getContext('2d'); c.drawImage(img, 0, 0);
                const id = c.getImageData(0, 0, img.width, img.height).data;
                const w = img.width, h = img.height, data = new Float32Array(w * h);
                for (let i = 0; i < w * h; i++) data[i] = (id[i * 4] * 256 + id[i * 4 + 1]) - TERRAIN_OFFSET;
                _terrain = { w, h, data };
                // if a flight is already up in 3D, rebuild so the terrain appears immediately.
                if (typeof threeDInitialized !== 'undefined' && threeDInitialized && typeof filteredData !== 'undefined'
                    && filteredData.length && typeof build3DScene === 'function') build3DScene();
            } catch (e) { _terrain = null; }
        };
        img.onerror = () => { _terrain = null; };
        img.src = 'data/etopo-heightmap.png' + (typeof assetVer === 'function' ? assetVer() : '');
    }
    window.addEventListener('load', loadTerrainGrid);
