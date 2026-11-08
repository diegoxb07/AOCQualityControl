/* Mission Visualizer, bundled low-res terrain (ETOPO) for the 3D basemap
   part of index.html, split into modules so a failure in one file does not break the others.
   loaded as a classic (non-module) script; all parts share one global scope, in order.

   data/etopo-heightmap.png is a 721x361 (0.5 deg) global ETOPO elevation grid, source NOAA NCEI via
   the CoastWatch ERDDAP (etopo180). elevation in metres is packed into the R and G channels:
   elev = (R*256 + G) - 11000. row 0 is the north edge (+90 lat), columns run west (-180) to east.
   it gives the 3D basemap real land height and tells land from sea, so a flight over high ground sits
   at the correct height relative to the terrain. */

    const TERRAIN_OFFSET = 11000;   // packed value = elev + this; see data/etopo-heightmap.png
    let _terrain = null;            // { w, h, data: Float32Array } once the png decodes, else null

    function isTerrainLoaded() { return !!_terrain; }

    // bilinearly sampled ground elevation (metres) at a lat/lon; 0 until the grid loads.
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

    // the padded box the terrain covers. kept close to the flight: relief far from it carries no
    // information about the mission and competes with the track for the eye. shared, so build3DScene
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

    // land is what the country borders enclose, not what sits above sea level, so ground inside a
    // coastline reads as land at any height. the borders are rasterised once per extent into a mask
    // and sampled per vertex: testing 14,400 vertices against 242 country outlines of ~100k points
    // between them runs to tens of millions of crossings, while a fill is one native raster and the
    // lookups are then flat.
    let _landMask = null;
    function buildLandMask(lon0, lon1, lat0, lat1) {
        if (typeof mapFeatures === 'undefined' || !mapFeatures.length) { _landMask = null; return null; }
        // the feature count is part of the key, so a mask raised before the basemap finished loading
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

    // true inside a country outline. falls back to sea level while the basemap has not loaded, so a
    // terrain built before the borders arrive still tells land from water.
    function isLandAt(lat, lon) {
        const m = _landMask;
        if (!m) return terrainElevationMeters(lat, lon) >= 0;
        const x = Math.round((lon - m.lon0) / (m.lon1 - m.lon0) * (m.w - 1));
        const y = Math.round((m.lat1 - lat) / (m.lat1 - m.lat0) * (m.h - 1));
        if (x < 0 || x >= m.w || y < 0 || y >= m.h) return false;
        return m.data[y * m.w + x] === 1;
    }

    // the ground takes the 2D basemap's palette (its pale land and light ocean) so the two views read
    // alike, with relief on top: land warms toward tan with height and the ocean darkens with depth,
    // so high ground, the continental shelf, and deep water show from any camera angle. hill shading
    // from the northwest is added as the view tilts toward the horizon (terrainShadeK).
    // a light green land, dimmer and greener than the 2D basemap's land: the 3D ground fills most of
    // the view and the shading below brightens slopes facing the light, so the 2D tone itself would glare
    const TERRAIN_LAND_RGB = [0xc6, 0xd6, 0xb4];
    const TERRAIN_HIGH_RGB = [0xc2, 0xb7, 0x9c];      // high ground warms toward this tan
    const TERRAIN_SHALLOW_RGB = [0xd4, 0xe3, 0xf0];   // the 2D basemap's ocean, over the shelf
    const TERRAIN_DEEP_RGB = [0x86, 0xa8, 0xc8];      // deep water
    // relief light from the northwest, 45 degrees up (the cartographic convention), as an east,
    // north, up vector. slopes are stretched by the scene's own altitude exaggeration (about 8x in
    // get3DCoord), so the shading matches the heights the mesh draws.
    const TERRAIN_LIGHT = [Math.sin(315 * Math.PI / 180) * Math.SQRT1_2, Math.cos(315 * Math.PI / 180) * Math.SQRT1_2, Math.SQRT1_2];
    const TERRAIN_RELIEF_Z = 8;
    // the hill shading is kept in its own small texture, one byte per cell holding the shade factor
    // as TERRAIN_SHADE_MIN + byte / 255 * TERRAIN_SHADE_SPAN, and the terrain material multiplies it in
    // at terrainShadeK of full strength. animate3D (js/07-ui-controls.js) sets terrainShadeK each frame
    // from the camera's angle above the horizon: 0 looking down from above, where shaded slopes read
    // as dark patches on flat ground, up to 1 with the camera low and the mesh's height in view.
    const TERRAIN_SHADE_MIN = 0.6, TERRAIN_SHADE_SPAN = 0.5;
    const terrainShadeK = { value: 0 };

    // land color (0..255 rgb) at an elevation
    function landColorAt(e) {
        const t = Math.max(0, Math.min(1, e / 3000)) * 0.7;
        return [0, 1, 2].map(k => TERRAIN_LAND_RGB[k] + (TERRAIN_HIGH_RGB[k] - TERRAIN_LAND_RGB[k]) * t);
    }
    // water color (0..255 rgb) by depth in metres: the 2D ocean over the shelf, darkening to deep water
    function waterColorAt(depth) {
        const t = Math.sqrt(Math.max(0, Math.min(1, depth / 4000)));
        return [0, 1, 2].map(k => TERRAIN_SHALLOW_RGB[k] + (TERRAIN_DEEP_RGB[k] - TERRAIN_SHALLOW_RGB[k]) * t);
    }

    // trace the country outlines into the current path, in the given lon/lat to pixel frame. states
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

    // the surface's colour, painted rather than taken per-vertex, so the coastline comes from the
    // vector outlines at texture resolution instead of the mesh's ~23 km vertex spacing. colour and
    // relief are rasterised at TERRAIN_SHADE and scaled up, the elevation source being half-degree;
    // only the coastline needs TERRAIN_TEX.
    const TERRAIN_TEX = 2048, TERRAIN_SHADE = 256;

    // held across rebuilds and keyed on everything it draws from. build3DScene runs on a dozen
    // events and drops the old mesh without disposing it, so raising a fresh 2048 texture each time
    // would hand the GPU a new one per rebuild and never give the last back.
    let _terrainTex = null;
    function terrainTexture(lon0, lon1, lat0, lat1) {
        const key = [lon0, lon1, lat0, lat1, document.documentElement.dataset.theme,
                     (typeof mapFeatures !== 'undefined' ? mapFeatures.length : 0)].join('|');
        if (_terrainTex && _terrainTex.key === key) return _terrainTex;
        if (_terrainTex) { _terrainTex.tex.dispose(); _terrainTex.shadeTex.dispose(); }
        _terrainTex = Object.assign({ key }, buildTerrainTexture(lon0, lon1, lat0, lat1));
        return _terrainTex;
    }

    function buildTerrainTexture(lon0, lon1, lat0, lat1) {
        const N = TERRAIN_SHADE;
        // raw elevation on the shading grid, lightly smoothed so the half-degree source cells shade
        // as slopes instead of facets. the field pins (terrainGroundMeters) are left out here: they
        // lift the mesh to meet the aircraft, and shading them would draw a bump around each field.
        let E = new Float32Array(N * N);
        for (let y = 0; y < N; y++) {
            const lat = lat1 - (lat1 - lat0) * y / (N - 1);
            for (let x = 0; x < N; x++) E[y * N + x] = terrainElevationMeters(lat, lon0 + (lon1 - lon0) * x / (N - 1));
        }
        const R = 2;
        for (let pass = 0; pass < 2; pass++) {
            const out = new Float32Array(N * N);
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                let sum = 0, cnt = 0;
                for (let k = -R; k <= R; k++) {
                    const xx = pass ? x : Math.max(0, Math.min(N - 1, x + k)), yy = pass ? Math.max(0, Math.min(N - 1, y + k)) : y;
                    sum += E[yy * N + xx]; cnt++;
                }
                out[y * N + x] = sum / cnt;
            }
            E = out;
        }
        const dLonM = (lon1 - lon0) / (N - 1) * 111320, dLatM = (lat1 - lat0) / (N - 1) * 110540;
        const landCv = document.createElement('canvas'), waterCv = document.createElement('canvas'), shadeCv = document.createElement('canvas');
        landCv.width = waterCv.width = shadeCv.width = N; landCv.height = waterCv.height = shadeCv.height = N;
        const landImg = landCv.getContext('2d').createImageData(N, N), waterImg = waterCv.getContext('2d').createImageData(N, N);
        const shadeImg = shadeCv.getContext('2d').createImageData(N, N);
        for (let y = 0; y < N; y++) {
            const lat = lat1 - (lat1 - lat0) * y / (N - 1);
            const dx = dLonM * Math.max(0.2, Math.cos(lat * Math.PI / 180));
            for (let x = 0; x < N; x++) {
                const e = E[y * N + x];
                const eE = E[y * N + Math.min(N - 1, x + 1)], eW = E[y * N + Math.max(0, x - 1)];
                const eN = E[Math.max(0, y - 1) * N + x], eS = E[Math.min(N - 1, y + 1) * N + x];
                // surface normal from the slope east and north, then the share of the light it faces,
                // normalised so flat ground is 1
                const nx = -TERRAIN_RELIEF_Z * (eE - eW) / (2 * dx), ny = -TERRAIN_RELIEF_Z * (eN - eS) / (2 * dLatM);
                const len = Math.hypot(nx, ny, 1);
                const lit = Math.max(0, (nx * TERRAIN_LIGHT[0] + ny * TERRAIN_LIGHT[1] + TERRAIN_LIGHT[2]) / len) / TERRAIN_LIGHT[2];
                // slopes facing away darken more than lit ones brighten, so relief shows without glare
                const shade = Math.max(0.68, Math.min(1.05, lit));
                const lc = landColorAt(e), wc = waterColorAt(-e);
                const i = (y * N + x) * 4;
                landImg.data[i] = lc[0]; landImg.data[i + 1] = lc[1]; landImg.data[i + 2] = lc[2]; landImg.data[i + 3] = 255;
                waterImg.data[i] = wc[0]; waterImg.data[i + 1] = wc[1]; waterImg.data[i + 2] = wc[2]; waterImg.data[i + 3] = 255;
                const sb = Math.round((shade - TERRAIN_SHADE_MIN) / TERRAIN_SHADE_SPAN * 255);
                shadeImg.data[i] = shadeImg.data[i + 1] = shadeImg.data[i + 2] = sb; shadeImg.data[i + 3] = 255;
            }
        }
        landCv.getContext('2d').putImageData(landImg, 0, 0);
        waterCv.getContext('2d').putImageData(waterImg, 0, 0);
        shadeCv.getContext('2d').putImageData(shadeImg, 0, 0);

        // water under everything, then the land clipped to the country outlines at full resolution
        const cv = document.createElement('canvas');
        cv.width = TERRAIN_TEX; cv.height = TERRAIN_TEX;
        const c = cv.getContext('2d');
        c.drawImage(waterCv, 0, 0, TERRAIN_TEX, TERRAIN_TEX);
        if (typeof mapFeatures !== 'undefined' && mapFeatures.length) {
            const X = lon => (lon - lon0) / (lon1 - lon0) * TERRAIN_TEX;
            const Y = lat => (lat1 - lat) / (lat1 - lat0) * TERRAIN_TEX;
            c.save();
            c.beginPath();
            traceLandPath(c, X, Y);
            c.clip('evenodd');   // later rings are holes, the same rule the 2D basemap fills by
            c.drawImage(landCv, 0, 0, TERRAIN_TEX, TERRAIN_TEX);
            c.restore();
        }
        const tex = new THREE.CanvasTexture(cv);
        // the surface is read at a grazing angle from a low camera, which is what smears a texture
        tex.anisotropy = (typeof renderer3D !== 'undefined' && renderer3D && renderer3D.capabilities)
            ? renderer3D.capabilities.getMaxAnisotropy() : 1;
        tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
        const shadeTex = new THREE.CanvasTexture(shadeCv);
        shadeTex.minFilter = THREE.LinearFilter; shadeTex.magFilter = THREE.LinearFilter; shadeTex.generateMipmaps = false;
        return { tex, shadeTex };
    }

    // the terrain's material: the colour texture with the hill shading multiplied in at terrainShadeK,
    // on land only. a pixel greener than it is blue is land (every land tone is, and every water tone
    // is bluer), so the shading never darkens the ocean next to a steep coast.
    function terrainMaterial(t) {
        const mat = new THREE.MeshBasicMaterial({ map: t.tex, side: THREE.DoubleSide });
        mat.onBeforeCompile = shader => {
            shader.uniforms.uTerrShade = { value: t.shadeTex };
            shader.uniforms.uTerrShadeK = terrainShadeK;
            shader.fragmentShader = 'uniform sampler2D uTerrShade;\nuniform float uTerrShadeK;\n'
                + shader.fragmentShader.replace('#include <map_fragment>', [
                    '#include <map_fragment>',
                    'float terrLand = clamp((diffuseColor.g - diffuseColor.b) * 12.0, 0.0, 1.0);',
                    'float terrShade = ' + TERRAIN_SHADE_MIN.toFixed(3) + ' + texture2D(uTerrShade, vUv).r * ' + TERRAIN_SHADE_SPAN.toFixed(3) + ';',
                    'diffuseColor.rgb *= mix(1.0, terrShade, uTerrShadeK * terrLand);'
                ].join('\n'));
        };
        return mat;
    }

    // how far from an end the ground is pulled toward the aircraft, and how far off the grid may be
    // before that end is taken as airborne rather than on a field.
    const TERRAIN_PIN_DEG = 1.5;
    const TERRAIN_PIN_MAX_M = 300;

    // the track's ends, each with the gap between the aircraft and the ground under it. the grid
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

    // the pins in force for the current scene. refreshed by refreshTerrainPins() at each build, so
    // the surface and everything draped on it read one ground.
    let _terrainPins = [];
    function refreshTerrainPins() { _terrainPins = terrainPins(); }

    // ground elevation with the ends pinned to the aircraft, fading out over TERRAIN_PIN_DEG. only
    // the nearest pin applies, so a there-and-back mission that starts and ends on the same field
    // corrects once rather than twice. this is the raw ground, which runs below sea level over
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

    // the height the map is drawn at. land keeps its ground whatever it reads, so a coastline that
    // encloses ground below sea level dips rather than flooding and the aircraft stays over it.
    // water lies flat at sea level, but for a pin's reach of a field, where the ground rides up to
    // meet the aircraft: an island small enough for the borders to miss still gets its ground.
    // anything laid on the surface reads this rather than the raw ground.
    function terrainSurfaceMeters(lat, lon) {
        const g = terrainGroundMeters(lat, lon);
        return isLandAt(lat, lon) ? g : Math.max(0, g);
    }

    // A terrain surface over the flight's horizontal extent (plus margin), sampled from the grid and
    // placed with the SAME mapping as the track (get3DCoord). returns a THREE.Group, or null if the
    // grid has not loaded or three.js / plot bounds are not ready.
    function buildTerrainMesh3D() {
        if (!_terrain || typeof THREE === 'undefined' || typeof get3DCoord !== 'function') return null;
        const ext = terrainExtent(); if (!ext) return null;
        const lon0 = ext.lon0, lon1 = ext.lon1, lat0 = ext.lat0, lat1 = ext.lat1;
        // this mesh is the colored surface in 3D (the flat land fills only build when the grid is
        // absent). the grid stays finer than the source's own 0.5 degree spacing at a typical
        // storm's span, so the sampling costs no detail.
        const NX = 120, NY = 120;
        const grp = new THREE.Group();
        buildLandMask(lon0, lon1, lat0, lat1);   // no-op when build3DScene already primed this extent
        const verts = [], uvs = [], idx = [];
        for (let iy = 0; iy < NY; iy++) {
            for (let ix = 0; ix < NX; ix++) {
                const lon = lon0 + (lon1 - lon0) * ix / (NX - 1);
                const lat = lat0 + (lat1 - lat0) * iy / (NY - 1);
                // the mesh carries height only; the texture carries land, water and shading. the mask
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
            terrainMaterial(terrainTexture(lon0, lon1, lat0, lat1)));
        terrain.renderOrder = -2;   // draw under the track, storm ribbon and plane
        grp.add(terrain);
        return grp;
    }

    // decode the packed elevation png into a Float32Array once, on window load (so assetVer and the
    // 3D scene helpers exist). rebuilds a live 3D flight so the terrain shows without a manual nudge.
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
