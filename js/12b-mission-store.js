/* Mission Visualizer, on-device mission store + loaded-flight picker
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Every flight the user uploads is parsed once and kept here, so reopening it costs no parse.
   Records live in a session Map mirrored write-through into IndexedDB (db aocPreloadedMissions),
   so loaded flights survive reloads and open instantly on any later visit. Fully offline. */

    function storeEscapeHtml(str) {
        return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    // status line under the loader, for store-level messages (opened, removed, store gone).
    function setMissionStoreStatus(msg) {
        const el = document.getElementById('missionLoadStatus');
        if (el) el.textContent = msg || '';
    }

    const preloadedMissions = new Map();   // missionId -> { mission, parsed { rows, stats, qc }, isNc }; stored-only stubs carry no parsed, and the in-memory copy drops parsed.qcAll (every-variable set, disk-only)
    // oldest stored missions past this cap are evicted from IndexedDB on each new save. full
    // resolution missions run tens of MB each; desktop browsers allow gigabytes, so this keeps a
    // whole season on device without risking the quota
    const PRELOADED_STORE_MAX = 100;

    let missionDB = null;
    const missionStoreReady = new Promise(resolve => {
        try {
            const rq = indexedDB.open('aocPreloadedMissions', 1);
            rq.onupgradeneeded = () => {
                rq.result.createObjectStore('missions');   // missionId -> full record, rows included
                rq.result.createObjectStore('meta');       // missionId -> light listing entry for the picker
            };
            rq.onerror = () => resolve();
            rq.onsuccess = () => { missionDB = rq.result; resolve(); };
        } catch (e) { resolve(); }
    });

    function missionIdbDelete(id) {
        if (!missionDB) return;
        try {
            const tx = missionDB.transaction(['missions', 'meta'], 'readwrite');
            tx.objectStore('missions').delete(id); tx.objectStore('meta').delete(id);
        } catch (e) {}
    }

    function missionIdbGet(id) {
        return new Promise(resolve => {
            if (!missionDB) return resolve(null);
            try {
                const rq = missionDB.transaction('missions').objectStore('missions').get(id);
                rq.onsuccess = () => resolve(rq.result || null);
                rq.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }

    // A copy of a stored record WITHOUT the every-variable QC set (parsed.qcAll). qcAll can be tens of
    // MB per flight, so it is persisted to IndexedDB only; the in-memory list holds this lean copy so a
    // long list doesn't pin gigabytes of RAM. openPreloadedMission pulls the full record from disk when
    // a flight is actually opened, so the NC-to-TXT converter still sees every variable.
    function qcLeanRec(rec) {
        if (!rec || !rec.parsed || !rec.parsed.qcAll) return rec;
        const parsed = Object.assign({}, rec.parsed); delete parsed.qcAll;
        return Object.assign({}, rec, { parsed: parsed });
    }

    // Write-through save + prune: the oldest stored missions past the cap leave IndexedDB (an
    // in-memory copy, if the session holds one, stays usable until reload). The full record (incl.
    // qcAll) goes to disk; the session Map keeps only the lean copy.
    function savePreloadedMission(id, rec) {
        preloadedMissions.set(id, qcLeanRec(rec));
        missionStoreReady.then(() => {
            if (!missionDB) return;
            try {
                const tx = missionDB.transaction(['missions', 'meta'], 'readwrite');
                tx.objectStore('missions').put(rec, id);
                // hasQc marks this as a QC-processed flight. The store is shared with the sibling
                // Mission Visualizer on this origin, whose cached flights carry no QC data, so this
                // flag is what keeps its flights out of this tool's list (see metaHasQc below).
                tx.objectStore('meta').put({ missionId: id, stormName: (rec.mission && rec.mission.storm_name) || '', isNc: rec.isNc, uploaded: true, hasQc: !!(rec.parsed && rec.parsed.qc), savedAt: Date.now() }, id);
                const listRq = tx.objectStore('meta').getAll();
                listRq.onsuccess = () => {
                    // Prune only this tool's own (QC) flights. Counting or evicting the Visualizer's
                    // flights here would let one tool delete the other's cache from the shared store.
                    const metas = (listRq.result || []).filter(metaHasQc).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
                    metas.slice(0, Math.max(0, metas.length - PRELOADED_STORE_MAX)).forEach(m => {
                        missionIdbDelete(m.missionId);
                        const stub = preloadedMissions.get(m.missionId);
                        if (stub && !stub.parsed) { preloadedMissions.delete(m.missionId); updatePreloadedSelect(); }
                    });
                };
            } catch (e) {}
        });
    }

    // A QC-processed flight has QC data (parsed.qc), recorded by the hasQc flag on every save.
    // The IndexedDB store is shared with the sibling Mission Visualizer on this origin, whose
    // cached flights have no QC data, so the list keeps only flights that were processed here.
    function metaHasQc(m) { return !!(m && m.hasQc); }

    // Startup: list the QC flights the store already holds as light stubs; rows stay on disk until opened.
    missionStoreReady.then(() => {
        if (!missionDB) return;
        try {
            const rq = missionDB.transaction('meta').objectStore('meta').getAll();
            rq.onsuccess = () => {
                (rq.result || []).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0)).forEach(m => {
                    if (metaHasQc(m) && !preloadedMissions.has(m.missionId))
                        preloadedMissions.set(m.missionId, { mission: { mission_id: m.missionId, storm_name: m.stormName }, isNc: m.isNc });
                });
                if (preloadedMissions.size) updatePreloadedSelect();
                backfillHasQcFlag();
            };
        } catch (e) {}
    });

    // One-time backfill for flights saved before the hasQc flag existed (they would otherwise all
    // drop out of the list). Each unclassified record is peeked ONE at a time, so peak memory stays
    // a single flight, and only QC flights (parsed.qc present) get the flag and reappear. Foreign
    // Visualizer flights are read but left untouched, so this tool never writes to the other's
    // records. A localStorage guard keeps the pass from repeating on later visits.
    async function backfillHasQcFlag() {
        try { if (localStorage.getItem('aocQcListFlagV1')) return; } catch (e) { return; }
        try {
            const metas = await new Promise(res => {
                const rq = missionDB.transaction('meta').objectStore('meta').getAll();
                rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
            });
            let added = false;
            for (const m of metas) {
                if (!m || m.hasQc !== undefined) continue;   // already classified, skip
                const full = await missionIdbGet(m.missionId);
                if (!(full && full.parsed && full.parsed.qc)) continue;   // foreign flight, leave it hidden
                m.hasQc = true;
                await new Promise(res => { try { const tx = missionDB.transaction('meta', 'readwrite'); tx.objectStore('meta').put(m, m.missionId); tx.oncomplete = res; tx.onerror = res; } catch (e) { res(); } });
                if (!preloadedMissions.has(m.missionId)) {
                    preloadedMissions.set(m.missionId, { mission: { mission_id: m.missionId, storm_name: m.stormName }, isNc: m.isNc });
                    added = true;
                }
            }
            if (added) updatePreloadedSelect();
            try { localStorage.setItem('aocQcListFlagV1', '1'); } catch (e) {}
        } catch (e) {}
    }

    // Loaded-flights picker (custom popover, see index.html #loadedPickerPanel). Each row is a name
    // button (opens the flight) plus a red × that removes just that flight from this device.
    let loadedPickerSelectedId = '';   // mission whose row shows active + names the button, '' = none

    function loadedPickerRowLabel(id, rec) {
        return `${id}${(rec.mission && rec.mission.storm_name) ? ' · ' + rec.mission.storm_name : ''}`;
    }

    function renderLoadedPickerPanel() {
        const listEl = document.getElementById('loadedPickerList'); if (!listEl) return;
        if (preloadedMissions.size === 0) { listEl.innerHTML = '<div class="loaded-pick-empty">No flights loaded yet.</div>'; return; }
        let html = '';
        // chronological, latest first: mission ids lead with YYYYMMDD, so a reverse id sort is a date sort
        [...preloadedMissions.entries()].sort((a, b) => b[0].localeCompare(a[0])).forEach(([id, rec]) => {
            const active = id === loadedPickerSelectedId;
            html += `<div class="loaded-pick-row${active ? ' active' : ''}">`
                 +  `<button type="button" class="loaded-pick-open" data-open="${storeEscapeHtml(id)}" title="Open ${storeEscapeHtml(id)}">${storeEscapeHtml(loadedPickerRowLabel(id, rec))}</button>`
                 +  `<button type="button" class="loaded-pick-x" data-remove="${storeEscapeHtml(id)}" title="Remove this flight from this device" aria-label="Remove ${storeEscapeHtml(id)}">×</button>`
                 +  `</div>`;
        });
        listEl.innerHTML = html;
    }

    // drives the custom picker (button label, enabled state, and panel rows) from the loaded set.
    function updatePreloadedSelect(selectedId) {
        if (selectedId !== undefined) loadedPickerSelectedId = selectedId || '';
        if (!preloadedMissions.has(loadedPickerSelectedId)) loadedPickerSelectedId = '';
        const btn = document.getElementById('loadedPickerBtn');
        const lbl = document.getElementById('loadedPickerLabel');
        const empty = preloadedMissions.size === 0;
        if (btn) btn.disabled = empty;
        if (lbl) {
            const rec = loadedPickerSelectedId ? preloadedMissions.get(loadedPickerSelectedId) : null;
            lbl.textContent = empty ? 'No flights loaded yet'
                : rec ? loadedPickerRowLabel(loadedPickerSelectedId, rec) : 'Pick from already loaded flights';
        }
        renderLoadedPickerPanel();
    }

    function positionLoadedPicker() {
        const panel = document.getElementById('loadedPickerPanel'), btn = document.getElementById('loadedPickerBtn');
        if (!panel || !btn || panel.classList.contains('hidden')) return;
        const r = btn.getBoundingClientRect();
        panel.style.top = (r.bottom + 4) + 'px';
        panel.style.left = r.left + 'px';
        panel.style.right = 'auto';
        panel.style.width = Math.max(220, r.width) + 'px';
    }
    function openLoadedPicker() {
        const panel = document.getElementById('loadedPickerPanel'); if (!panel) return;
        renderLoadedPickerPanel();
        panel.classList.remove('hidden');
        panel.scrollTop = 0;
        positionLoadedPicker();
    }
    function closeLoadedPicker() { const p = document.getElementById('loadedPickerPanel'); if (p) p.classList.add('hidden'); }

    // An uploaded flight joins the loaded list, so it reopens instantly from the picker with no
    // re-parse. Called by the upload handler in js/12-file-parsing.js once its parse has fully
    // applied, so the globals captured here (rows, stats, QC sets) all belong to this upload.
    function rememberUploadedFlight(fileName) {
        const id = fileName.replace(/\.nc$/i, '');
        const parsed = { rows: allParsedData, stats: lastParseStats, qc: (typeof qcRawData !== 'undefined' ? qcRawData : null), qcAll: (typeof qcRawDataAll !== 'undefined' ? qcRawDataAll : null) };
        savePreloadedMission(id, {
            mission: { mission_id: id, storm_name: '', flight_date: flightMetaData.date === 'Unknown' ? '' : flightMetaData.date, aircraft: flightMetaData.aircraft === 'Unknown' ? '' : flightMetaData.aircraft },
            parsed, isNc: true
        });
        updatePreloadedSelect(id);   // the picker's active row and label now show this upload
    }

    // Remove one flight from this device: drop it from the session map and IndexedDB, then re-render.
    function removePreloadedMission(id) {
        if (!preloadedMissions.has(id)) return;
        preloadedMissions.delete(id);
        missionIdbDelete(id);
        if (loadedPickerSelectedId === id) loadedPickerSelectedId = '';
        updatePreloadedSelect();
        if (preloadedMissions.size === 0) closeLoadedPicker();
        setMissionStoreStatus('Removed ' + id + ' from the loaded flights list.');
    }

    // Open a stored mission: no re-parse. A stub from a previous visit pulls its record out of
    // IndexedDB first, then applies like a session-cached one.
    async function openPreloadedMission(missionId) {
        // The loaded list rehydrates from IndexedDB while later script files are still loading, so
        // on a slow connection a stub can be opened before the playback engine (js/18-engine.js and
        // beyond) has executed; wait out the page load first.
        if (document.readyState !== 'complete') await new Promise(r => window.addEventListener('load', r, { once: true }));
        let rec = preloadedMissions.get(missionId); if (!rec) return;
        // Pull the full record from disk when the in-memory copy can't drive the whole tool: a light
        // stub (no parsed at all), or a lean copy that dropped the every-variable QC set to save RAM.
        // Loading it here gives the NC-to-TXT converter every parameter, not just the catalog set.
        if (!rec.parsed || !rec.parsed.qcAll) {
            if (!rec.parsed) setMissionStoreStatus('Opening ' + missionId + ' from the on-device store…');
            const stored = await missionIdbGet(missionId);
            if (stored && stored.parsed) {
                rec = stored;                                          // full record (incl. qcAll) for this open
                preloadedMissions.set(missionId, qcLeanRec(stored));   // keep the session list lean
            } else if (!rec.parsed) {
                setMissionStoreStatus('The stored copy of ' + missionId + ' is gone. Upload the file again.');
                preloadedMissions.delete(missionId); missionIdbDelete(missionId); updatePreloadedSelect();
                return;
            }
            // else: lean copy but the store has no qcAll (an older cache) -> open with the catalog set
        }
        const mission = rec.mission;
        clearLoadedMedia();
        flightMetaData = { id: mission.mission_id, date: mission.flight_date || 'Unknown', aircraft: mission.aircraft || 'Unknown' };
        try {
            applyParsedFlight(rec.parsed);
        } catch (e) {
            setMissionStoreStatus('Could not open ' + missionId + ' (' + e.message + ').');
            return;
        }
        isNcFile = rec.isNc;
        updatePreloadedSelect(missionId);   // reflect the opened flight as the picker's active row + label
        updateMissionHeader();
        setMissionStoreStatus('Opened ' + mission.mission_id + ' (' + allParsedData.length + ' samples).');
    }

    // picker wiring: toggle the popover, open a flight on a row click, remove one on its red ×.
    (function wireLoadedPicker() {
        const pickBtn = document.getElementById('loadedPickerBtn');
        const pickPanel = document.getElementById('loadedPickerPanel');
        const pickList = document.getElementById('loadedPickerList');
        if (pickBtn) pickBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (pickPanel && pickPanel.classList.contains('hidden')) openLoadedPicker(); else closeLoadedPicker();
        });
        if (pickList) pickList.addEventListener('click', (e) => {
            const rm = e.target.closest('[data-remove]');
            if (rm) { e.stopPropagation(); removePreloadedMission(rm.getAttribute('data-remove')); return; }
            const op = e.target.closest('[data-open]');
            if (op) { closeLoadedPicker(); openPreloadedMission(op.getAttribute('data-open')); }
        });
        document.addEventListener('mousedown', (e) => {
            if (!pickPanel || pickPanel.classList.contains('hidden')) return;
            if (pickPanel.contains(e.target) || (pickBtn && pickBtn.contains(e.target))) return;
            closeLoadedPicker();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLoadedPicker(); });
        window.addEventListener('resize', positionLoadedPicker);
        window.addEventListener('scroll', positionLoadedPicker, true);
    })();
