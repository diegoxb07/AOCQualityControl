/* Mission Visualizer, bundled low-res terrain (ETOPO) for the 3D basemap
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   data/etopo-heightmap.png is a 721x361 (0.5 deg) global ETOPO elevation grid, source NOAA NCEI via
   the CoastWatch ERDDAP (etopo180). Elevation in metres is packed into the R and G channels:
   elev = (R*256 + G) - 11000. Row 0 is the north edge (+90 lat), columns run west (-180) to east.
   It gives the 3D basemap real land and sea-floor height, so a flight over below-sea-level ground sits
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

    // Elevation-shaded color (0..1 rgb): a clear ocean blue below sea level, land green->tan->snow
    // above, so land and water read distinctly. Theme-aware (lighter on the light theme).
    function terrainColorRGB(e, light) {
        if (e < 0) {   // water: bright shore blue darkening with depth
            const t = Math.max(0, Math.min(1, -e / 4000));
            return light ? [0.60 - 0.18 * t, 0.76 - 0.18 * t, 0.90 - 0.14 * t]
                         : [0.11 - 0.05 * t, 0.34 - 0.16 * t, 0.55 - 0.24 * t];
        }
        const t = Math.max(0, Math.min(1, e / 4000));
        if (t < 0.5) {   // lowland green -> upland tan
            const s = t / 0.5;
            return light ? [0.63 + 0.21 * s, 0.79 - 0.02 * s, 0.49 + 0.09 * s]
                         : [0.22 + 0.39 * s, 0.50 - 0.06 * s, 0.26 - 0.02 * s];
        }
        const s = (t - 0.5) / 0.5;   // tan -> snow
        return light ? [0.84 + 0.14 * s, 0.77 + 0.20 * s, 0.58 + 0.40 * s]
                     : [0.61 + 0.28 * s, 0.44 + 0.30 * s, 0.24 + 0.52 * s];
    }

    // A terrain surface over the flight's horizontal extent (plus margin), sampled from the grid and
    // placed with the SAME mapping as the track (get3DCoord), plus a faint sea-level plane so ocean
    // reads as a surface with the bathymetry faintly beneath. Returns a THREE.Group, or null if the
    // grid has not loaded or three.js / plot bounds are not ready.
    function buildTerrainMesh3D() {
        if (!_terrain || typeof THREE === 'undefined' || typeof get3DCoord !== 'function') return null;
        if (typeof plotMinLon === 'undefined' || plotMinLon == null) return null;
        const spanLon = (plotMaxLon - plotMinLon) || 1, spanLat = (plotMaxLat - plotMinLat) || 1, pad = 0.25;
        const lon0 = plotMinLon - spanLon * pad, lon1 = plotMaxLon + spanLon * pad;
        const lat0 = plotMinLat - spanLat * pad, lat1 = plotMaxLat + spanLat * pad;
        const NX = 96, NY = 96;
        const light = document.documentElement.dataset.theme === 'light';
        const grp = new THREE.Group();
        const verts = [], colors = [], idx = [];
        for (let iy = 0; iy < NY; iy++) {
            for (let ix = 0; ix < NX; ix++) {
                const lon = lon0 + (lon1 - lon0) * ix / (NX - 1);
                const lat = lat0 + (lat1 - lat0) * iy / (NY - 1);
                const el = terrainElevationMeters(lat, lon);
                const p = get3DCoord(lon, lat, el);
                verts.push(p.x, p.y, p.z);
                const c = terrainColorRGB(el, light);
                colors.push(c[0], c[1], c[2]);
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
        geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geom.setIndex(idx);
        const terrain = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
        terrain.renderOrder = -2;   // draw under the track, storm ribbon and plane
        grp.add(terrain);
        // faint sea-level surface at y=0 (get3DCoord centers the flight on the origin).
        const seaGeom = new THREE.PlaneGeometry((lon1 - lon0) * 20, (lat1 - lat0) * 20); seaGeom.rotateX(-Math.PI / 2);
        const sea = new THREE.Mesh(seaGeom, new THREE.MeshBasicMaterial({ color: light ? 0x9fc4e8 : 0x2f6fa6, transparent: true, opacity: light ? 0.26 : 0.20, side: THREE.DoubleSide, depthWrite: false }));
        sea.position.set(0, 0, 0); sea.renderOrder = -1;
        grp.add(sea);
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
