/* Mission Visualizer, remaining wiring, map geojson fetch, display prefs, theme
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    ['startTimeInput', 'endTimeInput'].forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('change', () => { if (allParsedData.length > 0) applyFiltersAndInit(false); });
        el.addEventListener('keyup', (e) => { if (e.key === 'Enter') el.blur(); });
    });

    // Jump the playhead by N flight-minutes.
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

    // resets the app to its fresh-load state in place, without a page reload, so real (page) fullscreen
    // is kept (re-entering fullscreen needs a user gesture a reload can't carry). tears down the loaded
    // flight and the map/3d view via the same helpers used when switching flights. things that persist
    // across an F5 are left alone: display prefs (aocVizPrefs), the loaded-mission list, and the
    // basemap geojson.
    function resetAppToDefault() {
        // stop playback and any pending render timer.
        stopPlayback(); setPlaybackReady(false);
        playbackAccumulator = 0; lastTickTime = 0;
        currentSpeedIdx = 0; if (typeof updateSpeedDisplay === 'function') updateSpeedDisplay();

        // clear the loaded flight and sliding state.
        allParsedData = []; filteredData = []; currentIdx = 0; _lastStaticIdx = -1;
        lastParseStats = null;
        flightMetaData = { id: 'Unknown', date: 'Unknown', aircraft: 'Unknown' };
        if (typeof qcResetToEmpty === 'function') qcResetToEmpty();
        window._appliedWindow = undefined;

        // reset the map view.
        mapScale = 1; mapOffsetX = 0; mapOffsetY = 0; followAircraft2D = true; bgNeedsUpdate = true;

        // wipe the tracker canvas; clear the 3d scene's dynamic content if it was ever built.
        try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (e) {}
        if (threeDInitialized) {
            while (threeMapGroup.children.length > 0) threeMapGroup.remove(threeMapGroup.children[0]);
            [planeGroup3D, trackArrow3D, headingArrow3D].forEach(o => { if (o) o.visible = false; });
        }

        // restore the fresh-load UI: show the placeholder, hide the flight-only overlays, re-disable controls.
        mapPlaceholder.style.display = '';
        resetDropZone('dataDropZone', 'dataDropLabel');
        const dataLine = document.getElementById('dataReportLine'); if (dataLine) dataLine.classList.add('hidden');
        ['startTimeInput','endTimeInput'].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });
        const startI = document.getElementById('startTimeInput'); if (startI) startI.value = '';
        const endI = document.getElementById('endTimeInput'); if (endI) endI.value = '';
        updateMissionHeader();            // blanks the header chips + resets document.title

        // put the loaded-mission picker back to its default label (the saved list itself stays)
        // and close any open popover.
        if (typeof updatePreloadedSelect === 'function') updatePreloadedSelect('');
        if (typeof closeLoadedPicker === 'function') closeLoadedPicker();
    }

    document.getElementById('resetAppBtn').addEventListener('click', resetAppToDefault);

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

    // Local copies first (data/ ships with the app, so the basemap works offline);
    // Airfields for the 2D basemap, as [ident, iata, lat, lon, name, isLarge, isMil]. Local-only:
    // a failed fetch just leaves the layer off. Loads after the basemap and marks the map dirty so
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

    // Click anywhere on a modal's dimmed backdrop (not its card) to close it, so the ✕ is never the
    // only way out of a long dialog. mousedown target === the overlay means the card was not clicked.
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('mousedown', (e) => {
            if (e.target !== overlay) return;
            overlay.style.display = 'none';
        });
    });


    /* Remembered display preferences
       View settings only (no flight data), restored on open, saved on every change.
       Restoring dispatches 'change' so each control's normal handler runs; all of them
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

    /* Light/dark theme toggle
       documentElement[data-theme] is what css/app.css keys its tokens off; the inline <head>
       script sets it before first paint so there's no flash: a saved manual pick from the
       aocVizPrefs blob when one exists, else the computer's own light/dark setting.
       Stored under its own 'theme' key in aocVizPrefs rather than PREF_IDS above, since the
       toggle isn't a form control that fires a 'change' event. */
    (function themeToggle() {
        const KEY = 'aocVizPrefs';
        const btn = document.getElementById('themeToggleBtn');
        if (!btn) return;
        // The switch itself (knob position, lit icon) is CSS-driven off [data-theme]; only the
        // ARIA state is mirrored here (checked = light). Do not write btn.textContent, it would
        // wipe the knob/icon spans.
        const syncAria = () => btn.setAttribute('aria-checked', document.documentElement.dataset.theme === 'light' ? 'true' : 'false');
        syncAria();
        let themeAnimTimer = null;
        // Everything a theme change repaints, shared by the toggle click and the OS follower below.
        function applyTheme(next) {
            const root = document.documentElement;
            // Fade the token-driven colors across the switch (see css/app.css .theme-anim), then drop
            // the class so it never affects ordinary hover/focus color changes.
            root.classList.add('theme-anim');
            clearTimeout(themeAnimTimer);
            themeAnimTimer = setTimeout(() => root.classList.remove('theme-anim'), 420);
            root.dataset.theme = next;
            syncAria();
            // the 2D basemap palette is theme-aware now, so drop its cached render and repaint the tracker.
            bgNeedsUpdate = true;
            if (filteredData.length && trackerModeSelect.value === '2d' && typeof renderMapEngineFrame === 'function') {
                renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
            }
            // the 3D terrain/coastline colors are baked per-vertex/per-material, so rebuild the scene
            // when it is showing to recolor land, water, and borders for the new theme.
            if (filteredData.length && trackerModeSelect.value === '3d' && typeof build3DScene === 'function') build3DScene();
        }
        btn.addEventListener('click', () => {
            const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
            applyTheme(next);
            // A click is a manual pick: persist it, so the app stops following the computer's
            // setting from here on (the head script and the follower below both honor it).
            try {
                const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
                saved.theme = next;
                localStorage.setItem(KEY, JSON.stringify(saved));
            } catch (e) { /* localStorage unavailable (private mode) */ }
        });
        // With no manual pick saved, the theme keeps following the computer's light/dark setting
        // live, so an OS-level switch mid-session re-themes the app. The first toggle click above
        // writes saved.theme and this goes quiet for good.
        try {
            const mq = matchMedia('(prefers-color-scheme: light)');
            const followOs = (e) => {
                let manual = false;
                try { const t = JSON.parse(localStorage.getItem(KEY) || '{}').theme; manual = t === 'light' || t === 'dark'; } catch (err) {}
                if (!manual) applyTheme(e.matches ? 'light' : 'dark');
            };
            // addListener fallback: Safari before 14 has no addEventListener on MediaQueryList
            if (mq.addEventListener) mq.addEventListener('change', followOs); else if (mq.addListener) mq.addListener(followOs);
        } catch (e) { /* matchMedia unavailable, the head script's pick stands */ }
    })();
