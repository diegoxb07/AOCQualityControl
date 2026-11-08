/* Mission Visualizer, remaining wiring, map geojson fetch, display prefs, theme
   part of index.html, split into modules so a failure in one file does not break the others.
   loaded as a classic (non-module) script; all parts share one global scope, in order. */

    ['startTimeInput', 'endTimeInput'].forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('change', () => { if (allParsedData.length > 0) applyFiltersAndInit(false); });
        el.addEventListener('keyup', (e) => { if (e.key === 'Enter') el.blur(); });
    });

    // jump the playhead by N flight-minutes.
    function skipFlightMinutes(mins) {
        if (!filteredData.length || !filteredData[currentIdx]) return;
        const targetSec = filteredData[currentIdx].absSeconds + mins * 60;
        let bestIdx = currentIdx, bestDiff = Infinity;
        for (let i = 0; i < filteredData.length; i++) {
            const diff = Math.abs(filteredData[i].absSeconds - targetSec);
            if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
        }
        if (bestIdx === currentIdx) return;
        currentIdx = bestIdx;
        updateVisualComponents(currentIdx);
    }

    function calculateFeatureBBox(feature) {
        let minX = 180, maxX = -180, minY = 90, maxY = -90;
        const checkCoord = (c) => {
            if(c[0] < minX) minX = c[0]; if(c[0] > maxX) maxX = c[0];
            if(c[1] < minY) minY = c[1]; if(c[1] > maxY) maxY = c[1];
        };
        if(feature.geometry && feature.geometry.coordinates) {
            if(feature.geometry.type === 'Polygon') feature.geometry.coordinates.forEach(ring => ring.forEach(checkCoord));
            else if(feature.geometry.type === 'MultiPolygon') feature.geometry.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(checkCoord)));
        }
        return [minX, minY, maxX, maxY];
    }

    // local copies first (data/ ships with the app, so the basemap works offline);
    // airfields for the 2D basemap, as [ident, iata, lat, lon, name, isLarge, isMil]. local-only:
    // a failed fetch just leaves the layer off. loads after the basemap and marks the map dirty so
    // the codes appear as soon as they land.
    function loadAirports() {
        fetch('data/airports.json' + (typeof assetVer === 'function' ? assetVer() : ''))
            .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(rows => {
                if (!Array.isArray(rows)) return;
                airports = rows.map(a => ({ code: a[1] || a[0], name: a[4], lat: a[2], lon: a[3], big: a[5] === 1, mil: a[6] === 1 }));
                bgNeedsUpdate = true;
                if (filteredData.length > 0 && trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
            })
            .catch(() => {});
    }

    // city names for the 3D basemap, as [name, lat, lon, tier] (tier 1 = major). local-only like the
    // airfields: a failed fetch just leaves the names off.
    function loadCities() {
        fetch('data/cities.json' + (typeof assetVer === 'function' ? assetVer() : ''))
            .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(rows => {
                if (!Array.isArray(rows)) return;
                cities = rows.map(c => ({ name: c[0], lat: c[1], lon: c[2], big: c[3] === 1 }));
                if (filteredData.length > 0 && trackerModeSelect.value === '3d') build3DScene();
            })
            .catch(() => {});
    }

    // data/ ships with the app, so the basemap is local-only and works offline.
    const fetchGeo = (localPath) =>
        fetch(localPath).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    Promise.all([
        fetchGeo('data/ne_50m_admin_0_countries.geojson'),
        fetchGeo('data/us-states.json')
    ]).then(([world, us]) => {
        if (world && world.features) {
            world.features.forEach(f => {
                f.properties = f.properties || {}; f.properties.bbox = calculateFeatureBBox(f);
                mapFeatures.push(f);
            });
        }
        if (us && us.features) {
            us.features.forEach(f => {
                f.properties = f.properties || {}; f.properties.isState = true; f.properties.bbox = calculateFeatureBBox(f);
                mapFeatures.push(f);
            });
        }
        buildQcRegionLabels();
        bgNeedsUpdate = true; if (filteredData.length > 0 && trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
        loadAirports();
        loadCities();
    }).catch(e => {});

    // one region label per labelable landmass for the QC flight map: the US state name (us-states),
    // else the country/territory name (ne_50m countries, excluding the mainland-USA feature since its
    // states carry the label). a MultiPolygon labels each sizeable landmass, so overseas islands get
    // their country's name placed near them too. one representative point = its largest ring's centroid.
    function buildQcRegionLabels() {
        qcRegionLabels.length = 0;
        const titleCase = s => String(s || '').replace(/\b\w/g, c => c.toUpperCase());
        mapFeatures.forEach(f => {
            const pr = f.properties || {};
            let name;
            if (pr.isState) name = titleCase(pr.name);
            else { const nm = pr.NAME || pr.name || pr.ADMIN; name = (nm && !/^united states of america$/i.test(nm)) ? nm : null; }
            if (!name) return;
            const g = f.geometry; if (!g) return;
            const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
            const rings = polys.map(poly => poly[0]).filter(r => r && r.length).sort((a, b) => b.length - a.length);
            rings.forEach((ring, idx) => {
                if (idx > 0 && ring.length < 40) return;   // biggest landmass always; others only if sizeable
                let sx = 0, sy = 0; for (let i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; }
                qcRegionLabels.push({ name: name, lon: sx / ring.length, lat: sy / ring.length, n: ring.length });
            });
        });
        qcRegionLabels.sort((a, b) => b.n - a.n);   // bigger landmasses first, so de-collision keeps them
    }

    // inland water bodies for the QC flight map, loaded independently so a failure never blocks geography
    fetchGeo('data/ne_50m_lakes.geojson').then(lk => {
        if (lk && lk.features) lk.features.forEach(f => { f.properties = f.properties || {}; f.properties.bbox = calculateFeatureBBox(f); qcLakes.push(f); });
        bgNeedsUpdate = true;
    }).catch(() => {});

    // click anywhere on a modal's dimmed backdrop (not its card) to close it, so the ✕ is never the
    // only way out of a long dialog. mousedown target === the overlay means the card was not clicked.
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('mousedown', (e) => {
            if (e.target !== overlay) return;
            overlay.style.display = 'none';
        });
    });


    /* remembered display preferences
       view settings only (no flight data), restored on open, saved on every change.
       restoring dispatches 'change' so each control's normal handler runs; all of them
       no-op safely when no flight is loaded yet. */
    (function persistDisplayPrefs() {
        const PREF_IDS = ['trackerModeSelect'];
        const KEY = 'aocVizPrefs';
        try {
            const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
            PREF_IDS.forEach(id => {
                const el = document.getElementById(id); if (!el || !(id in saved)) return;
                if (el.type === 'checkbox') {
                    if (el.checked !== !!saved[id]) { el.checked = !!saved[id]; el.dispatchEvent(new Event('change')); }
                } else if (el.value !== saved[id] && (!el.options || [...el.options].some(o => o.value === saved[id]))) {
                    el.value = saved[id]; el.dispatchEvent(new Event('change'));
                }
            });
            const save = () => {
                const out = {};
                PREF_IDS.forEach(id => { const el = document.getElementById(id); if (el) out[id] = el.type === 'checkbox' ? el.checked : el.value; });
                localStorage.setItem(KEY, JSON.stringify(out));
            };
            PREF_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('change', save); });
        } catch (e) { /* localStorage unavailable (private mode), defaults stand */ }
    })();

