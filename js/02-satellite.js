/* Mission Visualizer, satellite overlay (NASA GIBS / CMR)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    // Escapes a string for safe interpolation into an innerHTML template that also carries real
    // markup (<br>/<b>/<span>), for the handful of badges below that mix that markup with text
    // sourced from the noaa-recon-api (band/storm names), so an unexpected API response can't inject
    // elements into the page. Reused by js/12b-recon-archive.js (loads after this file).
    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function showSatLoader() { const ov=document.getElementById('satLoadingOverlay'); if(ov) ov.classList.add('show'); }
    function hideSatLoader() { const ov=document.getElementById('satLoadingOverlay'); if(ov) ov.classList.remove('show'); }

    // --- Tile cache (LRU) --------------------------------------------------------------
    // Re-use a tile we already rendered instead of re-fetching it. On a hit we re-insert the
    // key so it counts as most-recently-used; on insert we evict the oldest entry past the cap.
    function satCacheGet(id) {
        const e = satTileCache.get(id);
        if (e) { satTileCache.delete(id); satTileCache.set(id, e); }
        return e || null;
    }
    function satCacheSet(id, entry) {
        if (satTileCache.has(id)) satTileCache.delete(id);
        satTileCache.set(id, entry);
        while (satTileCache.size > SAT_CACHE_MAX) satTileCache.delete(satTileCache.keys().next().value);
    }
    // COLD store (compressed PNG blobs), same LRU discipline, much larger cap.
    function satBlobGet(id) {
        const e = satBlobStore.get(id);
        if (e) { satBlobStore.delete(id); satBlobStore.set(id, e); }
        return e || null;
    }
    function satBlobPut(id, entry) {
        if (satBlobStore.has(id)) satBlobStore.delete(id);
        entry.t = Date.now();
        satBlobStore.set(id, entry);
        satIdbPut(id, entry);
        while (satBlobStore.size > SAT_BLOB_MAX) {
            const oldest = satBlobStore.keys().next().value;
            satBlobStore.delete(oldest); satIdbDelete(oldest);
        }
    }
    function clearSatTileCache() { satTileCache.clear(); satBlobStore.clear(); satFetchInFlight.clear(); satIdbClear(); }

    // --- Persistent cold store -----------------------------------------------------------
    // The blob store is mirrored into IndexedDB so cached tiles survive reloads and browser
    // restarts (pre-cached flights replay with zero network on a later visit). The in-memory Map
    // stays the working set; IndexedDB is write-through on put and rehydrated once at startup.
    // Everything is try/catch-guarded so environments without IndexedDB (some file:// contexts)
    // just run tab-lifetime caching as before.
    let satDB = null;
    const satStoreReady = (function rehydrateSatStore() {
        return new Promise(resolve => {
            try {
                const rq = indexedDB.open('aocSatTiles', 1);
                rq.onupgradeneeded = () => rq.result.createObjectStore('tiles');
                rq.onerror = () => resolve();
                rq.onsuccess = () => {
                    satDB = rq.result;
                    try {
                        const store = satDB.transaction('tiles').objectStore('tiles');
                        const keysRq = store.getAllKeys(), valsRq = store.getAll();
                        valsRq.onsuccess = () => {
                            const keys = keysRq.result || [], vals = valsRq.result || [];
                            // Oldest-first insertion keeps Map iteration order = LRU order.
                            keys.map((k, i) => [k, vals[i]])
                                .sort((a, b) => ((a[1] && a[1].t) || 0) - ((b[1] && b[1].t) || 0))
                                .forEach(([k, v]) => { if (v && v.blob && !satBlobStore.has(k)) satBlobStore.set(k, v); });
                            while (satBlobStore.size > SAT_BLOB_MAX) {
                                const oldest = satBlobStore.keys().next().value;
                                satBlobStore.delete(oldest); satIdbDelete(oldest);
                            }
                            resolve();
                        };
                        valsRq.onerror = () => resolve();
                    } catch (e) { resolve(); }
                };
            } catch (e) { resolve(); }
        });
    })();
    function satIdbPut(id, entry) { if (!satDB) return; try { satDB.transaction('tiles', 'readwrite').objectStore('tiles').put(entry, id); } catch (e) {} }
    function satIdbDelete(id) { if (!satDB) return; try { satDB.transaction('tiles', 'readwrite').objectStore('tiles').delete(id); } catch (e) {} }
    function satIdbClear() { if (!satDB) return; try { satDB.transaction('tiles', 'readwrite').objectStore('tiles').clear(); } catch (e) {} }

    // Encode a rendered (already equirect-reprojected) canvas to a lossless PNG blob for the cold store.
    function canvasToPngBlob(cv) { return new Promise(res => { if (cv && cv.toBlob) cv.toBlob(res, 'image/png'); else res(null); }); }
    // Decode a cold blob entry back into a drawable (ImageBitmap) for display. Resolves null on failure.
    function decodeBlobEntry(be) {
        if (!be || !be.blob) return Promise.resolve(null);
        return createImageBitmap(be.blob)
            .then(bmp => ({ canvas: bmp, box: be.box, scanStartMs: be.scanStartMs }))
            .catch(() => null);
    }

    // Solar elevation (deg) at a lat/lon and UTC instant, good to ~0.5deg, enough to tell day from
    // night. Standard low-precision NOAA solar-position approximation (declination + equation of time).
    function solarElevationDeg(latDeg, lonDeg, dateUtc) {
        const rad = Math.PI / 180;
        const N = (dateUtc.getTime() - Date.UTC(dateUtc.getUTCFullYear(), 0, 0)) / 86400000;   // fractional day of year
        const utcH = dateUtc.getUTCHours() + dateUtc.getUTCMinutes() / 60 + dateUtc.getUTCSeconds() / 3600;
        const decl = -23.44 * Math.cos(rad * (360 / 365) * (N + 10));
        const B = rad * (360 / 365) * (N - 81);
        const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);   // minutes
        const ha = 15 * ((utcH + lonDeg / 15 + eot / 60) - 12);   // hour angle, deg
        return Math.asin(Math.sin(rad * latDeg) * Math.sin(rad * decl) + Math.cos(rad * latDeg) * Math.cos(rad * decl) * Math.cos(rad * ha)) / rad;
    }

    function updateSatTimeBadge() {
        const badge = document.getElementById('satTimeBadge');
        if (!badge) return;
        const satSel = document.getElementById('satelliteSelect');
        const on2d = satSel && satSel.value !== 'none' && (!trackerModeSelect || trackerModeSelect.value === '2d');
        if (!on2d) { satUnavailableNote = null; badge.classList.add('hidden'); return; }
        // GOES requested for a date outside the GIBS rolling archive, explain instead of showing nothing.
        if (satUnavailableNote) { badge.innerHTML = satUnavailableNote; badge.classList.remove('hidden'); return; }
        if (!satLoadedInfo || !satImageLoaded || !satSel || satSel.value === 'none') {
            badge.classList.add('hidden');
            return;
        }
        const row = filteredData[currentIdx];
        if (!row || flightMetaData.date === 'Unknown') { badge.classList.add('hidden'); return; }
        const flightMs = new Date(flightMetaData.date + 'T00:00:00Z').getTime() + row.absSeconds * 1000;

        const imgMs = satLoadedInfo.imageTimeMs;
        const fmt = (ms, withTime) => {
            const d = new Date(ms);
            const Y=d.getUTCFullYear(), M=String(d.getUTCMonth()+1).padStart(2,'0'), D=String(d.getUTCDate()).padStart(2,'0'),
                  h=String(d.getUTCHours()).padStart(2,'0'), m=String(d.getUTCMinutes()).padStart(2,'0');
            return withTime ? `${Y}-${M}-${D} ${h}:${m}Z` : `${Y}-${M}-${D}`;
        };

        let imgLabel;
        if (satLoadedInfo.isModis) {
            if (satLoadedInfo.modisTimePending) {
                imgLabel = fmt(imgMs, false) + ' (looking up overpass time…)';
            } else if (satLoadedInfo.modisExact) {
                imgLabel = fmt(imgMs, true) + ' (actual overpass)';
            } else {
                imgLabel = fmt(imgMs, false) + ' (daily composite)';
            }
        } else if (satLoadedInfo.isReconApi) {
            imgLabel = fmt(imgMs, true) + ' (archive GOES, nearest scan)';
        } else if (satLoadedInfo.isGoes) {
            imgLabel = fmt(imgMs, true) + ` (new frame every ${satLoadedInfo.cadenceMin || 10} minutes)`;
        } else {
            imgLabel = fmt(imgMs, true);
        }

        const diffMs = imgMs - flightMs;
        const absMin = Math.abs(diffMs) / 60000;
        let offStr;
        if (satLoadedInfo.isModis && satLoadedInfo.modisTimePending) {
            offStr = '';
        } else if (absMin < 1) {
            offStr = 'matches flight time';
        } else if (absMin < 60) {
            offStr = `${Math.round(absMin)} min ${diffMs >= 0 ? 'AFTER' : 'BEFORE'} this point`;
        } else if (absMin < 1440) {
            offStr = `${(absMin/60).toFixed(1)} hr ${diffMs >= 0 ? 'AFTER' : 'BEFORE'} this point`;
        } else {
            offStr = `${Math.round(absMin/1440)} day(s) ${diffMs >= 0 ? 'AFTER' : 'BEFORE'} this point`;
        }

        const closeThresh = satLoadedInfo.isModis ? 90 : 15;
        const within = absMin <= closeThresh;
        badge.innerHTML = `${escapeHtml(satLoadedInfo.layerLabel)}<br>`
            + `Image: <b>${imgLabel}</b><br>`
            + (offStr ? `<span style="color:${within ? 'var(--accent)' : 'var(--text-muted)'}">${offStr}</span>` : '');
        // reflective GOES bands (1-6) are daylight-only; warn if the flight point is in darkness now.
        const nightBandSel = document.getElementById('satBandSelect');
        const nightLayerDef = (typeof GIBS_LAYERS !== 'undefined') ? GIBS_LAYERS.find(d => d.value === satSel.value) : null;
        const nightBandObj = (nightLayerDef && nightLayerDef.bands && nightBandSel) ? nightLayerDef.bands.find(b => b.id === nightBandSel.value) : null;
        if (nightBandObj && nightBandObj.band >= 1 && nightBandObj.band <= 6 && row.lat != null && row.lon != null
            && solarElevationDeg(row.lat, row.lon, new Date(flightMs)) < -6) {
            badge.innerHTML += `<br><span style="color:#fbbf24">⚠ daytime band, it's night at this point (imagery will be dark)</span>`;
        }
        badge.classList.remove('hidden');
    }

    const GIBS_LAYERS = [
        { value:'MODIS-TERRA',  baseLabel:'Terra Pass', wmsPrefix:'MODIS_Terra_', shortName:'MOD09', swath:true,
          bands: [
              {id:'CorrectedReflectance_TrueColor', name:'True Color'},
              {id:'CorrectedReflectance_Bands721', name:'False Color (Bands 7-2-1)'},
              {id:'CorrectedReflectance_Bands367', name:'False Color (Bands 3-6-7)'},
              {id:'Brightness_Temp_Band31_Day', name:'Infrared (Band 31, Day)'},
              {id:'Brightness_Temp_Band31_Night', name:'Infrared (Band 31, Night)'}
          ]
        },
        { value:'VIIRS-SNPP',   baseLabel:'SNPP Pass', wmsPrefix:'VIIRS_SNPP_', shortName:'VNP09', swath:true, minDate:'2015-11-24',
          bands: [
              {id:'CorrectedReflectance_TrueColor', name:'True Color'},
              {id:'CorrectedReflectance_BandsM11-I2-I1', name:'False Color (M11-I2-I1)'},
              {id:'CorrectedReflectance_BandsM3-I3-M11', name:'False Color (M3-I3-M11)'},
              {id:'Brightness_Temp_BandM15_Day', name:'Infrared (Band M15)'},
              {id:'DayNightBand_ENCC', name:'Day/Night Band (Night Lights)'}
          ]
        },
        { value:'VIIRS-NOAA20', baseLabel:'NOAA20 Pass', wmsPrefix:'VIIRS_NOAA20_', shortName:'VJ109', swath:true, minDate:'2018-01-05',
          bands: [
              {id:'CorrectedReflectance_TrueColor', name:'True Color'},
              {id:'CorrectedReflectance_BandsM11-I2-I1', name:'False Color (M11-I2-I1)'},
              {id:'CorrectedReflectance_BandsM3-I3-M11', name:'False Color (M3-I3-M11)'},
              {id:'Brightness_Temp_BandM15_Day', name:'Infrared (Band M15)'}
          ]
        },
        { value:'MODIS-AQUA',   baseLabel:'Aqua Pass', wmsPrefix:'MODIS_Aqua_', shortName:'MYD09', swath:true,
          bands: [
              {id:'CorrectedReflectance_TrueColor', name:'True Color'},
              {id:'CorrectedReflectance_Bands721', name:'False Color (Bands 7-2-1)'},
              {id:'Brightness_Temp_Band31_Day', name:'Infrared (Band 31, Day)'},
              {id:'Brightness_Temp_Band31_Night', name:'Infrared (Band 31, Night)'}
          ]
        },
        // GOES geostationary imagery, ARCHIVE, via the noaa-recon-api. Renders GOES ABI tiles from
        // NOAA's S3 archive for any historical date. `isReconApi:true` routes it through
        // fetchReconApiSat; each "band" carries `band`+`cmap` (or `product` for a composite).
        // `cadenceMin` buckets fetches to the playback clock; `subLon` drives the Earth-disk coverage
        // test that greys the layer out when the flight is outside that satellite's disk. The API
        // auto-resolves the spacecraft from the date, so only `satellite` needs to be passed. The
        // `bands` list is a fallback until loadSatelliteProducts() replaces it with the live list from
        // GET /v1/satellite/products, don't hardcode new bands/products here, use that endpoint.
        { value:'GOES-RECON', baseLabel:'GOES-East (Archive)', isReconApi:true, cadenceMin:10,
          satellite:'goes-east', subLon:-75.0, minDate:'2017-07-10',
          bands: [
              {id:'ir13',     band:13, cmap:'abi13', name:'Band 13: Clean IR',            bboxSupported:true},
              {id:'ir13_ir4', band:13, cmap:'ir4',   name:'Band 13: IR Enhanced (ir4)',   bboxSupported:true},
              {id:'wv9',      band:9,  cmap:'abi9',  name:'Band 9: Water Vapor',          bboxSupported:true}
          ]
        },
        // GOES-West (GOES-17/18, sub-point ~137°W), added once the recon-api gained `goes-west`.
        // Covers east/central-Pacific recon (greyed out for Atlantic flights via the coverage test).
        { value:'GOES-RECON-WEST', baseLabel:'GOES-West (Archive)', isReconApi:true, cadenceMin:10,
          satellite:'goes-west', subLon:-137.0, minDate:'2018-08-28',
          bands: [
              {id:'ir13',     band:13, cmap:'abi13', name:'Band 13: Clean IR',            bboxSupported:true},
              {id:'ir13_ir4', band:13, cmap:'ir4',   name:'Band 13: IR Enhanced (ir4)',   bboxSupported:true},
              {id:'wv9',      band:9,  cmap:'abi9',  name:'Band 9: Water Vapor',          bboxSupported:true}
          ]
        }
    ];

    const SAT_DAY_RANGE = 2;
    let satDayOffset = 0;
    let satFetchBox = null;

    // The layer def currently chosen in the dropdown (or null).
    function selectedSatLayerDef() {
        const s = document.getElementById('satelliteSelect');
        return s ? GIBS_LAYERS.find(d => d.value === s.value) : null;
    }
    // Format an epoch-ms as a GIBS full-timestamp TIME value: YYYY-MM-DDTHH:MM:00Z.
    function goesTimeStr(ms) {
        const d = new Date(ms);
        const Y=d.getUTCFullYear(), M=String(d.getUTCMonth()+1).padStart(2,'0'), D=String(d.getUTCDate()).padStart(2,'0'),
              h=String(d.getUTCHours()).padStart(2,'0'), m=String(d.getUTCMinutes()).padStart(2,'0');
        return `${Y}-${M}-${D}T${h}:${m}:00Z`;
    }
    // Flight UTC time of a sample, rounded DOWN to the layer's scan cadence (e.g. nearest 10 min).
    // dateStr defaults to the loaded flight's date; batch caching passes each file's own date.
    function goesBucketMs(layerDef, absSeconds, dateStr) {
        const d = dateStr || flightMetaData.date;
        if (d === 'Unknown') return null;
        const cadMs = (layerDef.cadenceMin || 10) * 60000;
        const ms = new Date(d + 'T00:00:00Z').getTime() + absSeconds * 1000;
        return Math.floor(ms / cadMs) * cadMs;
    }
    // When set, the sat time-badge shows this note instead of imagery info (e.g. "out of view").
    let satUnavailableNote = null;
    let _goesLabelMs = null;  // last 10-min bucket reflected in the GOES dropdown label
    let reconApiHealthChecked = false;
    let reconApiHealthOk = true;
    let reconApiHealthReason = '';

    function isReconApiDown() {
        return reconApiHealthChecked ? !reconApiHealthOk : false;
    }

    function updateReconApiUiState() {
        const reconBtn = document.getElementById('reconLoadBtn');
        const reconMissionSelect = document.getElementById('reconMissionSelect');
        const reconStormSelect = document.getElementById('reconStormSelect');
        const reconYearSelect = document.getElementById('reconYearSelect');
        const loadFlightDataGroup = document.getElementById('loadFlightDataGroup');
        const loadFlightDataLabel = document.getElementById('loadFlightDataLabel');
        const uploadZone = document.getElementById('dataDropZone');
        const uploadLabel = document.getElementById('dataDropLabel');
        const uploadApiOfflineToastWrapper = document.getElementById('uploadApiOfflineToastWrapper');
        const apiDown = isReconApiDown();

        if (reconBtn) {
            if (!reconBtn.dataset.defaultTitle) reconBtn.dataset.defaultTitle = reconBtn.title;
            reconBtn.classList.toggle('grayscale', apiDown);
            reconBtn.classList.toggle('opacity-60', apiDown);
            reconBtn.classList.toggle('saturate-0', apiDown);
            reconBtn.classList.toggle('pointer-events-none', apiDown);
            reconBtn.disabled = apiDown || (reconMissionSelect ? !reconMissionSelect.value : false);
            reconBtn.title = apiDown ? 'Archive flight loading is unavailable while the API is offline' : reconBtn.dataset.defaultTitle;
        }
        if (loadFlightDataGroup) {
            loadFlightDataGroup.classList.toggle('opacity-70', apiDown);
        }
        if (loadFlightDataLabel) {
            loadFlightDataLabel.classList.toggle('text-accent', !apiDown);
            loadFlightDataLabel.classList.toggle('text-faint', apiDown);
        }
        [reconYearSelect, reconStormSelect, reconMissionSelect].forEach(sel => {
            if (!sel) return;
            // Remember whatever disabled state the cascading Year->Storm->Mission handlers had already
            // set (e.g. Storm/Mission legitimately disabled because no options are loaded yet) so
            // recovery restores that instead of force-enabling an empty select.
            if (apiDown) {
                if (sel.dataset.apiDownForced === undefined) sel.dataset.apiDownForced = sel.disabled ? '0' : '1';
                sel.disabled = true;
            } else if (sel.dataset.apiDownForced === '1') {
                sel.disabled = false;
                delete sel.dataset.apiDownForced;
            } else {
                delete sel.dataset.apiDownForced;
            }
            sel.classList.toggle('grayscale', apiDown);
            sel.classList.toggle('saturate-0', apiDown);
            sel.classList.toggle('opacity-60', apiDown);
        });
        // Grey out the ↓ .nc source link with the rest of the archive block. The offline
        // overlay covering the block is pointer-events-none, so without this the dimmed
        // link would still take clicks through it.
        const srcLink = document.getElementById('reconSourceLink');
        if (srcLink) {
            srcLink.classList.toggle('grayscale', apiDown);
            srcLink.classList.toggle('saturate-0', apiDown);
            srcLink.classList.toggle('opacity-40', apiDown);
            srcLink.classList.toggle('pointer-events-none', apiDown);
        }
        if (uploadZone) {
            uploadZone.classList.toggle('border-accent', apiDown);
            uploadZone.classList.toggle('border-2', apiDown);
            uploadZone.classList.toggle('bg-accent-soft', apiDown);
            uploadZone.classList.toggle('bg-panel-strip', !apiDown);
            uploadZone.classList.toggle('grayscale-0', apiDown);
            uploadZone.classList.toggle('grayscale', !apiDown);
            uploadZone.classList.toggle('data-drop-emph', apiDown);   // enlarge it while the api is the only way in
        }
        if (uploadLabel) {
            uploadLabel.classList.toggle('text-ink', apiDown);
            uploadLabel.classList.toggle('text-muted', !apiDown);
            uploadLabel.classList.toggle('font-semibold', apiDown);
            uploadLabel.classList.toggle('font-medium', !apiDown);
        }
        if (uploadApiOfflineToastWrapper) {
            uploadApiOfflineToastWrapper.classList.toggle('hidden', !apiDown);
        }
        // the "use manual upload instead" hint sits below the upload button, only while offline
        const manualUploadHint = document.getElementById('manualUploadHint');
        if (manualUploadHint) manualUploadHint.classList.toggle('hidden', !apiDown);
        // when offline, relocate the manual-upload cluster to cover the dead archive pickers (next to the
        // "API Offline" pill) instead of leaving it up in the label row; move it back when online.
        const manualUploadWrap = document.getElementById('manualUploadWrap');
        const loadGroup = document.getElementById('loadFlightDataGroup');
        if (manualUploadWrap && loadGroup && uploadApiOfflineToastWrapper) {
            const target = apiDown ? uploadApiOfflineToastWrapper : loadGroup;
            if (manualUploadWrap.parentElement !== target) {
                manualUploadWrap.style.pointerEvents = apiDown ? 'auto' : '';
                target.appendChild(manualUploadWrap);
            }
        }
        // "API Offline" cover over the season dropdown in the pre-load flight data modal
        const preloadApiOfflineToast = document.getElementById('preloadApiOfflineToast');
        if (preloadApiOfflineToast) preloadApiOfflineToast.classList.toggle('hidden', !apiDown);
        // "Preload selected" only downloads the checked ARCHIVE missions, so it's dead while the API is
        // offline. Disable it then, so users don't click it expecting it to preload their own uploaded
        // files (those go through the modal's file picker, a separate path). Same apiDownForced dance as
        // the selects above, so recovery doesn't stomp a disable runPreload set for its own run.
        const preloadStartBtn = document.getElementById('preloadStartBtn');
        if (preloadStartBtn) {
            if (apiDown) {
                if (preloadStartBtn.dataset.apiDownForced === undefined) preloadStartBtn.dataset.apiDownForced = preloadStartBtn.disabled ? '0' : '1';
                if (!preloadStartBtn.dataset.defaultTitle) preloadStartBtn.dataset.defaultTitle = preloadStartBtn.title || '';
                preloadStartBtn.disabled = true;
                preloadStartBtn.title = 'Archive preloading is unavailable while the API is offline. Uploaded files still preload from the file picker.';
            } else {
                if (preloadStartBtn.dataset.apiDownForced === '1') preloadStartBtn.disabled = false;
                delete preloadStartBtn.dataset.apiDownForced;
                preloadStartBtn.title = preloadStartBtn.dataset.defaultTitle || '';
            }
        }
        // The batch modal, if already open, has its own satellite dropdown/band checks/Start button
        // that need the same API-down treatment, refresh them in place rather than waiting for the
        // user to close and reopen the modal.
        const batchCacheModal = document.getElementById('batchCacheModal');
        if (batchCacheModal && batchCacheModal.style.display === 'flex') {
            if (typeof populateBatchSatSelect === 'function') populateBatchSatSelect();
            if (typeof populateBatchBandChecks === 'function') populateBatchBandChecks();
        }
    }

    function setReconApiHealth(healthy, reason) {
        const transition = !reconApiHealthChecked || reconApiHealthOk !== !!healthy;
        reconApiHealthChecked = true;
        reconApiHealthOk = !!healthy;
        reconApiHealthReason = reason || '';
        updateReconApiUiState();
        // Rebuild the satellite dropdowns only when the health state actually flips,
        // doing it on every 60s "still ok" poll wiped the picked product + loaded overlay.
        if (transition && typeof updateSatelliteOptions === 'function') updateSatelliteOptions();
    }

    function isReconApiAvailable() {
        return !isReconApiDown();
    }

    // --- GOES Earth-disk coverage: a geostationary sat at `subLon` can only usefully see points
    // within ~65° (geocentric angle) of its sub-point; past that it's extreme limb / no data.
    const GOES_VIEW_LIMIT_DEG = 65;
    function flightToSubSatAngle(subLon) {
        if (!filteredData || filteredData.length === 0) return 999;
        const c = filteredData[Math.floor(filteredData.length / 2)];
        const latR = c.lat * Math.PI / 180, dLonR = (c.lon - subLon) * Math.PI / 180;
        let cosA = Math.cos(latR) * Math.cos(dLonR);
        cosA = Math.max(-1, Math.min(1, cosA));
        return Math.acos(cosA) * 180 / Math.PI;
    }
    function goesInCoverage(layerDef) {
        return layerDef.subLon == null || flightToSubSatAngle(layerDef.subLon) <= GOES_VIEW_LIMIT_DEG;
    }
    // Coverage test for an arbitrary lat/lon extent (used by batch caching, which never loads the flight).
    function extentInGoesCoverage(layerDef, extent) {
        if (layerDef.subLon == null) return true;
        const cLat = (extent.minLat + extent.maxLat) / 2, cLon = (extent.minLon + extent.maxLon) / 2;
        const latR = cLat * Math.PI / 180, dLonR = (cLon - layerDef.subLon) * Math.PI / 180;
        let cosA = Math.max(-1, Math.min(1, Math.cos(latR) * Math.cos(dLonR)));
        return (Math.acos(cosA) * 180 / Math.PI) <= GOES_VIEW_LIMIT_DEG;
    }
    // Label a GOES dropdown option: disable + "out of view" if the flight isn't in this sat's disk,
    // otherwise show the ~scan time for the current playback position (ticks as the clock advances).
    function setGoesOptionState(opt, layerDef) {
        if (layerDef.isReconApi && !isReconApiAvailable()) {
            opt.disabled = true;
            opt.style.color = '#f87171';
            opt.style.fontWeight = '600';
            opt.textContent = `${layerDef.baseLabel} (API Offline)`;
            return;
        }
        opt.style.color = '';
        opt.style.fontWeight = '';
        const inCov = goesInCoverage(layerDef);
        opt.disabled = !inCov;
        if (!inCov) { opt.textContent = `${layerDef.baseLabel}, out of view`; return; }
        // archive goes streams a frame on a fixed scan cadence, so label the interval rather than an
        // estimated scan time.
        const cad = layerDef.cadenceMin || 10;
        opt.textContent = `${layerDef.baseLabel} [${cad}min intervals]`;
    }

    function computeSatFetchBox(extent) {
        // Region sized to the flight extent + margin (clamped ~18x14 to ~44x30 degrees) instead of a
        // whole-hemisphere composite. Deterministic from the cleaned flight extent (not canvas/zoom/
        // time-filter) so batch caching and live playback compute the same fetchId. Batch caching
        // passes an explicit extent since it never loads the flight; live calls pass none.
        const ex = extent || flightLatLonExtent();
        if (!ex) return null;
        const cLon = (ex.minLon + ex.maxLon) / 2, cLat = (ex.minLat + ex.maxLat) / 2;
        const halfLon = Math.min(22, Math.max(9, (ex.maxLon - ex.minLon) / 2 + 6));
        const halfLat = Math.min(15, Math.max(7, (ex.maxLat - ex.minLat) / 2 + 5));
        const box = {
            minLon: Math.max(-180, cLon - halfLon), maxLon: Math.min(180, cLon + halfLon),
            minLat: Math.max(-85,  cLat - halfLat), maxLat: Math.min(85,  cLat + halfLat),
        };
        if (!extent) satFetchBox = box;   // live path reads the global; batch uses the return value
        return box;
    }

    const _satChk = document.createElement('canvas');
    _satChk.width = _satChk.height = 32;
    const _satChkCtx = _satChk.getContext('2d', { willReadFrequently: true });
    
    function satImageHasContent(src) {
        try {
            _satChkCtx.clearRect(0, 0, 32, 32);
            _satChkCtx.drawImage(src, 0, 0, 32, 32);
            const d = _satChkCtx.getImageData(0, 0, 32, 32).data;
            let alphaHits = 0, lumSum = 0, lumMin = 255, lumMax = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i+3] > 10) alphaHits++;
                const lum = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
                lumSum += lum; if (lum < lumMin) lumMin = lum; if (lum > lumMax) lumMax = lum;
                n++;
            }
            return alphaHits > 4 && ((lumMax - lumMin) > 8 || (lumSum / n) > 6);
        } catch(e) {}
        return false;
    }

    function satDateForOffset(offset) {
        if (flightMetaData.date === 'Unknown') return null;
        const d = new Date(flightMetaData.date + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + offset);
        const Y=d.getUTCFullYear(), M=String(d.getUTCMonth()+1).padStart(2,'0'), D=String(d.getUTCDate()).padStart(2,'0');
        return Y+'-'+M+'-'+D;
    }

    function updateSatelliteDropdownTimes() {
        const satSelect = document.getElementById('satelliteSelect');
        if (!satSelect || flightMetaData.date === 'Unknown' || filteredData.length === 0) return;
        
        const dateStr = satDateForOffset(satDayOffset);
        if (!dateStr) return;
        
        const centerRow = filteredData[Math.floor(filteredData.length / 2)];
        const lon = centerRow.lon;
        const lat = centerRow.lat;

        for (let i = 0; i < satSelect.options.length; i++) {
            const opt = satSelect.options[i];
            if (opt.value === 'none') continue;
            
            const layerDef = GIBS_LAYERS.find(d => d.value === opt.value);
            if (!layerDef) continue;
            // GOES has no polar overpass to look up, label it with coverage + ~scan time instead.
            if (layerDef.isGoes || layerDef.isReconApi) { setGoesOptionState(opt, layerDef); continue; }

            opt.textContent = `${layerDef.baseLabel} (Searching...)`;

            lookupModisGranuleTime(layerDef.shortName, dateStr, lon, lat).then(g => {
                if (g && g.timeStart) {
                    const s = new Date(g.timeStart).getTime(), e = new Date(g.timeEnd).getTime();
                    const midMs = s + (e - s) / 2;
                    const fmtDate = new Date(midMs);
                    const hh = String(fmtDate.getUTCHours()).padStart(2, '0');
                    const mm = String(fmtDate.getUTCMinutes()).padStart(2, '0');
                    opt.textContent = `${layerDef.baseLabel} [${hh}:${mm}Z]`;

                    if (satSelect.value === layerDef.value && satLoadedInfo) {
                        satLoadedInfo.imageTimeMs = midMs;
                        satLoadedInfo.modisTimePending = false;
                        satLoadedInfo.modisExact = true;
                        updateSatTimeBadge();
                    }
                    if (typeof refreshSatPicker === 'function') refreshSatPicker();
                } else {
                    opt.textContent = `${layerDef.baseLabel} [Daily]`;
                    if (satSelect.value === layerDef.value && satLoadedInfo) {
                        satLoadedInfo.modisTimePending = false;
                        updateSatTimeBadge();
                    }
                    if (typeof refreshSatPicker === 'function') refreshSatPicker();
                }
            });
        }
    }

    function updateSatelliteOptions() {
        const satSelect = document.getElementById('satelliteSelect');
        const bandSelect = document.getElementById('satBandSelect');
        if (!satSelect || !bandSelect) return;
        
        const prevVal = satSelect.value;
        satSelect.innerHTML = '<option value="none">Sat: Off</option>';
        const fDate = flightMetaData.date;  
        
        GIBS_LAYERS.forEach(def => {
            if (def.minDate && fDate !== 'Unknown' && fDate < def.minDate) return;
            const el = document.createElement('option');
            el.value = def.value;
            el.textContent = def.baseLabel;
            if (def.isGoes || def.isReconApi) {
                setGoesOptionState(el, def);
            } else {
                el.disabled = false;
            }
            satSelect.appendChild(el);
        });
        // Keep the previous choice only if it's still selectable (present and not disabled).
        const stillOk = [...satSelect.options].some(o => o.value === prevVal && !o.disabled);
        satSelect.value = stillOk ? prevVal : 'none';
        if (satSelect.value !== 'none') {
            const selectedLayer = GIBS_LAYERS.find(d => d.value === satSelect.value);
            if (selectedLayer && selectedLayer.isReconApi && !isReconApiAvailable()) {
                satSelect.value = 'none';
            }
        }

        updateBandOptions();

        satDayOffset = 0;
        _goesLabelMs = null;
        buildSatDayStepper();
        const in2dMode = !trackerModeSelect || trackerModeSelect.value === '2d';
        satSelect.style.display = in2dMode ? '' : 'none';
        bandSelect.style.display = (in2dMode && satSelect.value !== 'none') ? '' : 'none';

        satImageLoaded = false; lastSatFetchTime = ''; bgNeedsUpdate = true; resetSatPreload();

        updateSatelliteDropdownTimes();
        maybeAutoPrecacheSatellite();   // flight (re)loaded with a GOES-archive layer already selected, build its full timeframe now
        if (typeof refreshSatPicker === 'function') refreshSatPicker();
        if (typeof updateSatColorLegend === 'function') updateSatColorLegend();
    }

    // Keeps the satellite cluster's footprint constant (the .split rule in app.css): the layer
    // select gives up half its width to the product picker instead of the header row growing
    // and wrapping. Call after any change to #satBandSelect's display.
    function syncSatSplit() {
        const grp = document.getElementById('satControlGroup');
        const band = document.getElementById('satBandSelect');
        if (grp && band) grp.classList.toggle('split', band.style.display !== 'none');
    }

    function updateBandOptions() {
        const satSelect = document.getElementById('satelliteSelect');
        const bandSelect = document.getElementById('satBandSelect');
        if (!satSelect || !bandSelect) return;
        _goesLabelMs = null;  // re-sync the GOES scan-time label after a layer/band change
        const prevBand = bandSelect.value;   // restored below if the option still exists

        if (satSelect.value === 'none') {
            bandSelect.innerHTML = '';
            bandSelect.style.display = 'none';
            syncSatSplit();
            return;
        }

        const layerDef = GIBS_LAYERS.find(d => d.value === satSelect.value);
        if (layerDef && layerDef.bands) {
            bandSelect.innerHTML = '';
            if (layerDef.isReconApi && !isReconApiAvailable()) {
                bandSelect.style.display = 'none';
                syncSatSplit();
                return;
            }
            // Archive-GOES layers can trigger a full-timeframe cache build (maybeAutoPrecacheSatellite),
            // force an explicit pick via a blank placeholder rather than silently defaulting to the first
            // product, so caching never starts before the user has actually chosen what to build.
            if (layerDef.isReconApi) {
                const ph = document.createElement('option');
                ph.value = ''; ph.textContent = 'Choose a product…';
                bandSelect.appendChild(ph);
            }
            if (layerDef.isReconApi) {
                // Spectral bands and multi-band composites in separate groups, so a blend like
                // "IR/VIS Sandwich" can't be misread as just another band.
                const addGroup = (label, defs) => {
                    if (!defs.length) return;
                    const og = document.createElement('optgroup');
                    og.label = label;
                    defs.forEach(b => {
                        const opt = document.createElement('option');
                        opt.value = b.id;
                        // a product the api isn't currently serving stays listed but disabled, labelled
                        // "unavailable", so it reads as temporarily offline rather than silently vanishing.
                        opt.textContent = b.available === false ? b.name + ' (unavailable)' : b.name;
                        opt.title = b.name;   // full name on hover, the closed select ellipsizes long ones (CSS max-width)
                        if (b.available === false) opt.disabled = true;
                        og.appendChild(opt);
                    });
                    bandSelect.appendChild(og);
                };
                addGroup('Spectral Bands', layerDef.bands.filter(b => !b.isComposite));
                addGroup('Composites (multi-band)', layerDef.bands.filter(b => b.isComposite));
            } else {
                layerDef.bands.forEach(b => {
                    const opt = document.createElement('option');
                    opt.value = b.id;
                    opt.textContent = b.available === false ? b.name + ' (unavailable)' : b.name;
                    opt.title = b.name;
                    if (b.available === false) opt.disabled = true;
                    bandSelect.appendChild(opt);
                });
            }
            bandSelect.style.display = '';
            syncSatSplit();
            // a rebuild must not silently drop an active selection (the 60s product list poll and flight
            // reloads land here), the placeholder is only for fresh picks. skip restoring a now unavailable
            // product so we don't re-select a disabled option.
            if (prevBand && [...bandSelect.options].some(o => o.value === prevBand && !o.disabled)) bandSelect.value = prevBand;
        }
        if (typeof refreshSatPicker === 'function') refreshSatPicker();
    }

    let _satStepperWired = false;
    function buildSatDayStepper() {
        const wrap = document.getElementById('satDayStepper');
        const satSelect = document.getElementById('satelliteSelect');
        const bandSelect = document.getElementById('satBandSelect');
        if (!wrap || !satSelect) return;
        if (!_satStepperWired) {
            const prev = document.getElementById('satDayPrev');
            const next = document.getElementById('satDayNext');
            if (prev) prev.addEventListener('click', () => stepSatDay(-1));
            if (next) next.addEventListener('click', () => stepSatDay(1));
            _satStepperWired = true;
        }
        const in2d = !trackerModeSelect || trackerModeSelect.value === '2d';
        const layerDef = GIBS_LAYERS.find(d => d.value === satSelect.value);
        const isGoesLike = !!(layerDef && (layerDef.isGoes || layerDef.isReconApi));
        const satOn = satSelect.value !== 'none';
        // Band picker is shown for any active 2D layer (including GOES); the day-stepper is
        // for browsing polar-orbiter calendar days, so it stays hidden for GOES.
        bandSelect.style.display = (in2d && satOn) ? '' : 'none';
        const active = in2d && satOn && flightMetaData.date !== 'Unknown' && !isGoesLike;
        if (active) { wrap.classList.remove('hidden'); wrap.classList.add('flex'); }
        else { wrap.classList.add('hidden'); wrap.classList.remove('flex'); }
        // The 10-min stepper only makes sense for GOES (10-min scan cadence); hide it otherwise.
        const stepCluster = document.getElementById('satStepCluster');
        if (stepCluster) stepCluster.style.display = (in2d && satOn && isGoesLike) ? '' : 'none';
        updateSatDayLabel();
    }
    
    function updateSatDayLabel() {
        const lbl = document.getElementById('satDayLabel');
        if (!lbl) return;
        const ds = satDateForOffset(satDayOffset) || '';
        const tag = satDayOffset === 0 ? 'flight day' : (satDayOffset < 0 ? satDayOffset + 'd' : '+' + satDayOffset + 'd');
        lbl.innerHTML = ds + '<br>' + tag;
        const prev = document.getElementById('satDayPrev'), next = document.getElementById('satDayNext');
        if (prev) prev.disabled = satDayOffset <= -SAT_DAY_RANGE;
        if (next) next.disabled = satDayOffset >=  SAT_DAY_RANGE;
    }
    
    function stepSatDay(dir) {
        const n = satDayOffset + dir;
        if (n < -SAT_DAY_RANGE || n > SAT_DAY_RANGE) return;
        satDayOffset = n;
        updateSatDayLabel();
        updateSatelliteDropdownTimes();
        satImageLoaded = false; lastSatFetchTime = ''; bgNeedsUpdate = true; resetSatPreload();
        if (filteredData.length > 0 && trackerModeSelect.value === '2d') {
            fetchSatelliteImage(filteredData[currentIdx].absSeconds);
        }
    }

    // Generic GIBS EPSG:4326 GetMap → canvas. `timeStr` is a date (polar) or full timestamp (GOES).
    function fetchGibsWMS(wmsLayerName, timeStr, box, pxW, pxH) {
        const url = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
            + '?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1'
            + '&LAYERS=' + encodeURIComponent(wmsLayerName)
            + '&FORMAT=image%2Fjpeg&TRANSPARENT=false'
            + '&WIDTH=' + pxW + '&HEIGHT=' + pxH
            + '&SRS=EPSG:4326'
            + '&BBOX=' + box.minLon + ',' + box.minLat + ',' + box.maxLon + ',' + box.maxLat
            + '&TIME=' + encodeURIComponent(timeStr);
        return new Promise(res => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = pxW; c.height = pxH;
                c.getContext('2d').drawImage(img, 0, 0);
                res(c);
            };
            img.onerror = () => res(null);
            img.src = url;
        });
    }

    // --- Archive GOES via the noaa-recon-api (https://joshmurdock.net/api): server-side renders of
    // NOAA's S3 GOES NetCDF, so historical dates work (NASA GIBS only keeps ~90 days). The /tile
    // request is an async job, it returns a key, then we poll /status until the PNG is ready.
    const RECON_API_BASE = 'https://joshmurdock.net/api';

    // Public-facing API token for the noaa-recon-api. The API owner issued this specifically to be
    // embedded in this open, client-side tool so archive loading and GOES imagery keep working for
    // everyone with no sign-in. Like a publishable key it is MEANT to be visible in the page source,
    // it is not a secret, and is scoped and revocable by the owner. A user with their own token can
    // override it by setting localStorage 'reconApiToken' (there is deliberately no UI: the default
    // just works for all users).
    const RECON_API_TOKEN = '1zjFKbV0yJGWyX5drvrE5ajBEow_trThEemiRAtLJQo';
    function getReconApiToken() {
        try { return localStorage.getItem('reconApiToken') || RECON_API_TOKEN; }
        catch (_) { return RECON_API_TOKEN; }
    }
    // Merge the Bearer header into any existing fetch init headers, so every recon-api call carries
    // the token. Harmless while the API runs open (the server ignores it); required once the owner
    // turns token auth on. Note: sending Authorization makes these non-simple CORS requests, so the
    // API must allow the header in its CORS policy, which it does since the token is issued for this
    // in-browser use.
    function reconAuthHeaders(extra) {
        const t = getReconApiToken();
        return t ? Object.assign({}, extra, { Authorization: 'Bearer ' + t }) : Object.assign({}, extra || {});
    }
    // <img> elements can't send an Authorization header, so for the GOES tile PNG we try a normal
    // (fast, cache-friendly) image load first and, only if that fails (e.g. the endpoint starts
    // requiring the token), retry by fetching the bytes WITH the header and decoding them via a blob
    // url. Resolves a canvas, or null on failure (same contract as loadImageToCanvas).
    async function loadReconImageToCanvas(url) {
        const direct = await loadImageToCanvas(url);
        if (direct) return direct;
        try {
            const resp = await fetch(url, { headers: reconAuthHeaders() });
            if (!resp.ok) return null;
            const obj = URL.createObjectURL(await resp.blob());
            try { return await loadImageToCanvas(obj); } finally { URL.revokeObjectURL(obj); }
        } catch (_) { return null; }
    }

    // Discovery endpoint: every band/composite the API can render, plus each spacecraft's active date
    // range. Fetched once at startup; replaces the archive-GOES `bands` fallback in GIBS_LAYERS and
    // refines `minDate`. Falls back to the hardcoded list if the fetch fails.
    async function loadSatelliteProducts() {
        try {
            const res = await fetch(`${RECON_API_BASE}/v1/satellite/products`, { cache: 'no-store', headers: reconAuthHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            // every band the api returns becomes a product option automatically (no allowlist here), so
            // new bands like band 2 show up on their own; label each "band n" and sort by band number,
            // composites are tagged so the dropdown groups them separately from single-band products.
            const bandDefs = (data.bands || [])
                .slice().sort((a, b) => a.band - b.band)
                .map(b => ({
                    id: 'band' + b.band, band: b.band, cmap: b.default_cmap,
                    name: 'Band ' + b.band + ': ' + b.name,
                    bboxSupported: b.bbox_supported !== false
                }));
            // Band-13 enhancement variants (ir4 = enhanced-IR curve, bd = Dvorak BD curve), added only
            // when the API lists the cmap. Short allowlist on purpose, every cmap x band combination
            // would triple the dropdown.
            const b13 = (data.bands || []).find(b => b.band === 13 && Array.isArray(b.cmaps));
            if (b13) [['ir4', 'IR Enhanced (ir4)'], ['bd', 'IR BD Curve (Dvorak)']].forEach(([cmap, label]) => {
                if (b13.cmaps.includes(cmap)) bandDefs.push({ id: 'band13_' + cmap, band: 13, cmap: cmap, name: 'Band 13: ' + label, bboxSupported: b13.bbox_supported !== false });
            });
            const productDefs = (data.products || []).map(p => ({
                id: p.product, product: p.product, name: p.name,
                bboxSupported: p.bbox_supported === true,
                isComposite: true
            }));
            const allProducts = bandDefs.concat(productDefs);
            if (!allProducts.length) throw new Error('empty payload');
            // per product availability, fully driven by the api (nothing hardcoded): keep the union of
            // every product the api has served this session and flag each by whether it's in the current
            // response. a product that drops out is kept but marked unavailable, so when the api is online
            // but one product is offline, only that product greys out while the satellite and its other
            // products stay usable. a fully down api disables the whole satellite (isReconApiAvailable).
            const availableIds = new Set(allProducts.map(p => p.id));
            allProducts.forEach(p => { p.available = true; reconProductUnion.set(p.id, p); });
            reconProductUnion.forEach((def, id) => { if (!availableIds.has(id)) def.available = false; });
            const unionProducts = [...reconProductUnion.values()].sort((a, b) => {
                if (!!a.isComposite !== !!b.isComposite) return a.isComposite ? 1 : -1;   // bands first, composites last
                return (a.band || 0) - (b.band || 0);
            });
            GIBS_LAYERS.forEach(layerDef => {
                if (!layerDef.isReconApi) return;
                layerDef.bands = unionProducts;
                const spacecraft = data.satellites && data.satellites[layerDef.satellite];
                if (spacecraft && spacecraft.length && spacecraft[0].start) layerDef.minDate = spacecraft[0].start;
            });
            // include availability in the fingerprint so the dropdown rebuilds when a product goes on or offline.
            const fp = JSON.stringify([unionProducts.map(p => [p.id, p.available]), data.satellites]);
            const changed = fp !== _lastProductsFingerprint;
            _lastProductsFingerprint = fp;
            setReconApiHealth(true, 'ok');   // rebuilds the dropdowns itself on a health transition
            // Rebuilding resets the loaded overlay, so outside a transition only do it when the
            // product list actually changed, not on every 60s poll, which would wipe the user's
            // product pick mid-caching.
            if (changed && typeof updateSatelliteOptions === 'function') updateSatelliteOptions();
        } catch (e) {
            setReconApiHealth(false, String(e));
        }
    }
    let _lastProductsFingerprint = '';
    const reconProductUnion = new Map();   // id to product def (with .available), union across api polls
    loadSatelliteProducts();
    setInterval(() => {
        if (document.visibilityState === 'visible') loadSatelliteProducts();
    }, 60000);

    // --- satellite product color-scale legend -------------------------------------------------
    // fetches the api colortable for the active recon product's cmap (cached) and renders a compact
    // vertical legend on the 2d player, so the color scale (brightness temp, reflectance, water vapor,
    // etc.) and its unit are labeled. composites and polar layers have no cmap, so no legend for them.
    const _satColorTableCache = {};
    async function fetchSatColorTable(cmap) {
        if (cmap in _satColorTableCache) return _satColorTableCache[cmap];
        try {
            const res = await fetch(`${RECON_API_BASE}/v1/satellite/colortable?cmap=${encodeURIComponent(cmap)}`, { headers: reconAuthHeaders() });
            if (!res.ok) throw new Error('http ' + res.status);
            const data = await res.json();
            if (!data || !Array.isArray(data.stops) || !data.stops.length) throw new Error('no stops');
            // each stop is { <valueKey>, hex }; the value key is temp_c, reflectance_pct, etc.
            const valKey = Object.keys(data.stops[0]).find(k => k !== 'hex');
            const stops = data.stops.map(s => ({ v: Number(s[valKey]), hex: s.hex })).filter(s => isFinite(s.v));
            const ct = stops.length ? { unit: data.unit || '', stops } : null;
            _satColorTableCache[cmap] = ct;
            return ct;
        } catch (e) { _satColorTableCache[cmap] = null; return null; }
    }
    function _legendTicks(min, max) {
        const out = [];
        for (let i = 0; i <= 4; i++) out.push(Math.round(min + (max - min) * i / 4));
        return out.filter((v, i) => out.indexOf(v) === i);   // dedupe if the range is tiny
    }
    function renderSatColorLegend(legend, bandObj, ct) {
        const stops = ct.stops.slice().sort((a, b) => a.v - b.v);
        const min = stops[0].v, max = stops[stops.length - 1].v, span = (max - min) || 1;
        // gradient top to bottom = min to max value (stop 0 at top)
        const grad = stops.map(s => `${s.hex} ${(((s.v - min) / span) * 100).toFixed(1)}%`).join(', ');
        const ticks = _legendTicks(min, max).map(v => {
            const pos = ((v - min) / span) * 100;   // 0 top, 100 bottom
            return `<span style="top:${pos.toFixed(1)}%">${v}</span>`;
        }).join('');
        const title = (bandObj.name || 'Satellite').replace(/\s*\(.*/, '');   // drop any trailing parenthetical
        // prefix a degree sign for temperature units (c/f); leave % and others as-is
        const unit = (ct.unit === 'C' || ct.unit === 'F') ? ('°' + ct.unit) : (ct.unit || '');
        legend.innerHTML =
            `<div class="leg-title">${escapeHtml(title)}</div>`
          + `<div class="leg-body"><div class="leg-bar" style="background:linear-gradient(to bottom, ${grad})"></div>`
          + `<div class="leg-ticks">${ticks}</div></div>`
          + `<div class="leg-unit">${escapeHtml(unit)}</div>`;
    }
    let _satLegendReqId = 0;
    async function updateSatColorLegend() {
        const legend = document.getElementById('satColorLegend');
        if (!legend) return;
        const satSel = document.getElementById('satelliteSelect');
        const bandSel = document.getElementById('satBandSelect');
        const in2d = !trackerModeSelect || trackerModeSelect.value === '2d';
        const layerDef = satSel ? GIBS_LAYERS.find(d => d.value === satSel.value) : null;
        const bandObj = (layerDef && layerDef.bands && bandSel) ? layerDef.bands.find(b => b.id === bandSel.value) : null;
        // legend only for recon goes products that carry a cmap colortable, in 2d
        if (!in2d || !layerDef || !layerDef.isReconApi || !bandObj || !bandObj.cmap) { legend.classList.add('hidden'); return; }
        const reqId = ++_satLegendReqId;
        const ct = await fetchSatColorTable(bandObj.cmap);
        if (reqId !== _satLegendReqId) return;   // selection changed while awaiting
        if (!ct || !ct.stops.length || (trackerModeSelect && trackerModeSelect.value !== '2d')) { legend.classList.add('hidden'); return; }
        renderSatColorLegend(legend, bandObj, ct);
        legend.classList.remove('hidden');
    }

    // Load a (CORS-enabled) image URL into a fresh canvas at its natural size. Resolves null on error.
    function loadImageToCanvas(url) {
        return new Promise(res => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                c.getContext('2d').drawImage(img, 0, 0);
                res(c);
            };
            img.onerror = () => res(null);
            img.src = url;
        });
    }

    // recon-api tiles are Web Mercator (rows linear in Mercator Y); our 2D map is equirectangular
    // (getY linear in lat). Reproject once here so rows aren't vertically misplaced. Longitude is
    // linear in both, so only rows (Y) need resampling, columns (X) copy straight across.
    function reprojectMercatorToEquirect(src, box) {
        const W = src.width, H = src.height;
        if (!W || !H) return src;
        const mercY = lat => Math.log(Math.tan(Math.PI/4 + (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI/180) / 2));
        const yTop = mercY(box.maxLat), yBot = mercY(box.minLat), span = yTop - yBot;
        if (!isFinite(span) || span === 0) return src;

        // Vertical remap only (Mercator-Y → latitude); X is identity. Do it as ONE getImageData +
        // whole-row 32-bit copies + ONE putImageData, instead of H separate drawImage() calls, the
        // per-row drawImage overhead was the slow part (H can be >1000 px, ×N tiles when pre-caching).
        let srcData;
        try { srcData = src.getContext('2d').getImageData(0, 0, W, H); }
        catch (e) { return src; }   // tainted canvas (shouldn't happen, CORS image) → leave as-is
        const out = document.createElement('canvas');
        out.width = W; out.height = H;
        const octx = out.getContext('2d');
        const outData = octx.createImageData(W, H);
        const srcU32 = new Uint32Array(srcData.data.buffer);   // one pixel = one 32-bit word
        const outU32 = new Uint32Array(outData.data.buffer);
        const dLat = box.maxLat - box.minLat;
        for (let j = 0; j < H; j++) {
            const lat = box.maxLat - ((j + 0.5) / H) * dLat;     // equirect: row j is linear in latitude
            let srcRow = ((yTop - mercY(lat)) / span * H) | 0;   // matching Mercator-Y source row
            if (srcRow < 0) srcRow = 0; else if (srcRow > H - 1) srcRow = H - 1;
            outU32.set(srcU32.subarray(srcRow * W, srcRow * W + W), j * W);  // contiguous row memcpy
        }
        octx.putImageData(outData, 0, 0);
        return out;
    }

    // Request a recon-api GOES tile and poll until it renders. Resolves to
    // { canvas, box:{minLon,minLat,maxLon,maxLat}, scanStartMs } or { error }.
    // `product` (e.g. 'sandwich'/'geocolor') is a composite, when given, band/cmap are ignored
    // server-side. Composites accept the same center/dims bbox as a single band now, so send it
    // whenever one was computed (caller only computes it for bbox-capable products).
    async function fetchReconApiTile({ band, cmap, product, timeIso, center, dims, unit, satellite }) {
        const params = new URLSearchParams({ time: timeIso });
        if (product) { params.set('product', product); } else { params.set('band', band); params.set('cmap', cmap); }
        if (satellite) params.set('satellite', satellite);
        if (center) { params.set('center', center); params.set('dims', dims); params.set('unit', unit || 'km'); }
        // While a batch/precache pass is running, ride its AbortController so a Cancel click kills any
        // in-flight request immediately instead of waiting out the current poll tick.
        const signal = (batchCaching && batchCacheAbortController) ? batchCacheAbortController.signal : undefined;
        if (batchCaching && batchCacheCancel) return { error: 'cancelled' };
        try {
            let data = await fetch(`${RECON_API_BASE}/v1/satellite/tile?${params}`, { signal, headers: reconAuthHeaders() }).then(r => r.json());
            // Poll while the job renders. Cap total wait so playback never hangs on a slow/stuck render.
            // Checked both before AND after the sleep so a mid-batch Cancel is noticed within ~3s.
            for (let waited = 0; data && data.status === 'generating' && waited < 30000; waited += 3000) {
                if (batchCaching && batchCacheCancel) return { error: 'cancelled' };
                // Abort-aware sleep: a Cancel click resolves it immediately instead of
                // waiting out the remainder of the 3s tick.
                await new Promise(r => {
                    const t = setTimeout(r, 3000);
                    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
                });
                if (batchCaching && batchCacheCancel) return { error: 'cancelled' };
                data = await fetch(`${RECON_API_BASE}/v1/satellite/status/${data.key}`, { signal, headers: reconAuthHeaders() }).then(r => r.json());
            }
            if (!data || data.status !== 'ready') return { error: (data && (data.message || data.status)) || 'no response' };
            // bounds come back as [[lat_s, lon_w], [lat_n, lon_e]] → our {minLon,minLat,maxLon,maxLat}.
            const b = data.bounds;
            const box = { minLat: b[0][0], minLon: b[0][1], maxLat: b[1][0], maxLon: b[1][1] };
            const c = await loadReconImageToCanvas(RECON_API_BASE + data.png_url);
            if (!c) return { error: 'image load failed' };
            // Reproject the Mercator PNG to equirectangular so it aligns with our lat-linear map.
            const eq = reprojectMercatorToEquirect(c, box);
            return { canvas: eq, box, scanStartMs: data.scan_start ? new Date(data.scan_start).getTime() : null };
        } catch (e) { return { error: String(e) }; }
    }

    // Cache-first, deduped fetch for one recon tile. Used by the live display, the background
    // preloader, AND the "Cache flight" pass so a given tile is only ever pulled from the server
    // ONCE even if all three want it at the same moment. Resolves to { canvas, box, scanStartMs }
    // (cached on success) or { error }.
    function getOrFetchReconTile(fetchId, params) {
        const hot = satCacheGet(fetchId);
        if (hot) return Promise.resolve(hot);                    // decoded already → instant
        // In our local cold store (pre-cached / seen earlier this session)? Decode the PNG blob
        // (fast, no network) and promote it into the hot cache.
        const cold = satBlobGet(fetchId);
        if (cold) return decodeBlobEntry(cold).then(dec => {
            if (dec) { satCacheSet(fetchId, dec); return dec; }
            return { error: 'decode failed' };
        });
        if (satFetchInFlight.has(fetchId)) return satFetchInFlight.get(fetchId);
        const p = fetchReconApiTile(params).then(r => {
            satFetchInFlight.delete(fetchId);
            if (r && r.canvas) {
                const entry = { canvas: r.canvas, box: r.box, scanStartMs: r.scanStartMs };
                satCacheSet(fetchId, entry);                     // hot (decoded) for instant display
                // Cold (compressed) copy, stored async so the display isn't blocked on PNG encoding.
                canvasToPngBlob(r.canvas).then(b => { if (b) satBlobPut(fetchId, { blob: b, box: r.box, scanStartMs: r.scanStartMs }); });
                return entry;
            }
            return { error: (r && r.error) || 'no scan' };
        }).catch(e => { satFetchInFlight.delete(fetchId); return { error: String(e) }; });
        satFetchInFlight.set(fetchId, p);
        return p;
    }

    let _cmrCache = {};
    async function lookupModisGranuleTime(shortName, dateStr, pointLon, pointLat) {
        if (!dateStr) return null;
        const pad = 0.1;
        const bbox = (pointLon - pad).toFixed(3) + ',' + (pointLat - pad).toFixed(3) + ','
                   + (pointLon + pad).toFixed(3) + ',' + (pointLat + pad).toFixed(3);
        const cacheKey = shortName + '|' + dateStr + '|' + bbox;
        if (_cmrCache[cacheKey] !== undefined) return _cmrCache[cacheKey];
        const url = 'https://cmr.earthdata.nasa.gov/search/granules.json'
            + '?short_name=' + shortName
            + '&temporal=' + dateStr + 'T00:00:00Z,' + dateStr + 'T23:59:59Z'
            + '&bounding_box=' + bbox
            + '&page_size=20&sort_key=start_date';
        try {
            const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
            if (!resp.ok) { _cmrCache[cacheKey] = null; return null; }
            const data = await resp.json();
            const entries = (data.feed && data.feed.entry) || [];
            if (!entries.length) { _cmrCache[cacheKey] = null; return null; }
            
            let best = null, bestDist = Infinity;
            entries.forEach(e => {
                if (!e.time_start) return;
                let gLon = pointLon, gLat = pointLat;
                if (e.boxes && e.boxes[0]) {
                    const p = e.boxes[0].split(' ').map(parseFloat);
                    if (p.length === 4) { gLat = (p[0]+p[2])/2; gLon = (p[1]+p[3])/2; }
                }
                const dist = Math.abs(gLon - pointLon) + Math.abs(gLat - pointLat);
                if (dist < bestDist) { bestDist = dist; best = e; }
            });
            const result = best ? { timeStart: best.time_start, timeEnd: best.time_end || best.time_start } : null;
            _cmrCache[cacheKey] = result;
            return result;
        } catch(e) { _cmrCache[cacheKey] = null; return null; }
    }

    function fetchSatelliteImage(absSeconds) {
        const satSelect = document.getElementById('satelliteSelect');
        const bandSelect = document.getElementById('satBandSelect');
        if (!satSelect || satSelect.value === 'none' || !bandSelect) return;
        if (flightMetaData.date === 'Unknown') return;
        if (!canvas.width || !canvas.height) return;

        const layerDef = GIBS_LAYERS.find(d => d.value === satSelect.value);
        if (!layerDef) return;
        const bandId = bandSelect.value;

        // Archive GOES (noaa-recon-api) takes a separate async render+poll path. bandId is '' until the
        // user explicitly picks a product from the placeholder-first dropdown (updateBandOptions), don't
        // fall back to a default product, or caching/fetching would start before they've actually chosen.
        if (layerDef.isReconApi) {
            if (!isReconApiAvailable()) {
                satUnavailableNote = 'GOES archive API unavailable';
                satImageLoaded = false; bgNeedsUpdate = true;
                satLoadedInfo = null; updateSatTimeBadge();
                return;
            }
            if (!bandId) return;
            const bandObj = layerDef.bands.find(b => b.id === bandId);
            if (!bandObj) return;
            fetchReconApiSat(layerDef, bandObj, absSeconds);
            return;
        }

        computeSatFetchBox();
        const box = satFetchBox;
        if (!box) return;
        const dateStr = satDateForOffset(satDayOffset);
        if (!dateStr) return;

        // Polar layers (MODIS/VIIRS) use the calendar day picked by the day-stepper.
        const wmsLayer = layerDef.wmsPrefix + bandId, wmsTime = dateStr, idTimePart = dateStr;
        satUnavailableNote = null;  // a fetchable layer/date, clear any prior "unavailable" note

        const boxLonSpan = box.maxLon - box.minLon, boxLatSpan = box.maxLat - box.minLat;
        const aspect = boxLonSpan / boxLatSpan;
        const NATIVE_PX_PER_DEG = 111320 / 250;
        const SAT_PX_CAP = 3072;                   // capped lower than before (was 4096), fewer pixels to fetch/decode per frame
        const nativeW = Math.round(boxLonSpan * NATIVE_PX_PER_DEG);
        let pxW = Math.min(SAT_PX_CAP, Math.max(canvas.width, nativeW));
        let pxH = Math.round(pxW / aspect);
        if (pxH > SAT_PX_CAP) { pxH = SAT_PX_CAP; pxW = Math.round(pxH * aspect); }

        const fetchId = layerDef.value + '||' + bandId + '||' + idTimePart + '||' +
            box.minLon.toFixed(2)+','+box.minLat.toFixed(2)+','+box.maxLon.toFixed(2)+','+box.maxLat.toFixed(2);
        // Attempt each distinct target once. Mark it SYNCHRONOUSLY (not inside the debounce) so the
        // per-frame calls during playback don't keep resetting the timer. Layer/band/day changes
        // reset lastSatFetchTime to ''.
        if (lastSatFetchTime === fetchId) return;
        lastSatFetchTime = fetchId;

        // Already decoded in the HOT cache? Re-show instantly.
        const cached = satCacheGet(fetchId);
        if (cached) { applyPolarSatResult(cached.canvas, cached.box, layerDef, dateStr); return; }

        // In the local COLD blob store (pre-cached / seen earlier this session)? Decode it, no network.
        if (satBlobStore.has(fetchId)) {
            getOrFetchPolarTile(fetchId, { wmsLayer, dateStr, box, pxW, pxH })
                .then(r => { if (lastSatFetchTime === fetchId && r && r.canvas) applyPolarSatResult(r.canvas, r.box, layerDef, dateStr); });
            return;
        }

        clearTimeout(satDebounceTimer);
        satDebounceTimer = setTimeout(async () => {
            // Don't flash "Fetching satellite…" when we're caching locally / the tile is already being
            // pulled into the local cache, the background pill covers that and playback stays quiet.
            if (!batchCaching && !satFetchInFlight.has(fetchId)) showSatLoader();
            try {
                const r = await getOrFetchPolarTile(fetchId, { wmsLayer, dateStr, box, pxW, pxH });
                hideSatLoader();
                if (lastSatFetchTime !== fetchId) return;
                if (r && r.canvas) {
                    applyPolarSatResult(r.canvas, r.box, layerDef, dateStr);
                } else {
                    satImageLoaded = false; bgNeedsUpdate = true;
                    satLoadedInfo = null; updateSatTimeBadge();
                    showToast('Satellite: No imagery found for ' + idTimePart + ' in this band/area.', 6000);
                }
            } catch(e) {
                hideSatLoader(); satImageLoaded = false; bgNeedsUpdate = true;
            }
        }, 350);
    }

    // Cache-first, deduped fetch for one polar (MODIS/VIIRS GIBS) tile. Two-tier like the GOES path:
    // hot decoded -> cold blob (decode) -> network (fetchGibsWMS). Returns { canvas, box } or { error }.
    function getOrFetchPolarTile(fetchId, p) {
        const hot = satCacheGet(fetchId);
        if (hot) return Promise.resolve(hot);
        const cold = satBlobGet(fetchId);
        if (cold) return decodeBlobEntry(cold).then(dec => {
            if (dec) { satCacheSet(fetchId, dec); return dec; }
            return { error: 'decode failed' };
        });
        if (satFetchInFlight.has(fetchId)) return satFetchInFlight.get(fetchId);
        const prom = fetchGibsWMS(p.wmsLayer, p.dateStr, p.box, p.pxW, p.pxH).then(c => {
            satFetchInFlight.delete(fetchId);
            if (c && satImageHasContent(c)) {
                const box = { minLon: p.box.minLon, minLat: p.box.minLat, maxLon: p.box.maxLon, maxLat: p.box.maxLat };
                const entry = { canvas: c, box };
                satCacheSet(fetchId, entry);
                canvasToPngBlob(c).then(b => { if (b) satBlobPut(fetchId, { blob: b, box }); });
                return entry;
            }
            return { error: 'no imagery' };
        }).catch(e => { satFetchInFlight.delete(fetchId); return { error: String(e) }; });
        satFetchInFlight.set(fetchId, prom);
        return prom;
    }

    // Place a (freshly fetched OR cached) polar tile and refresh the badge/map. The image time is
    // derived from the dropdown option's [HH:MMZ]/[Daily] label, same as a live fetch.
    function applyPolarSatResult(canvasImg, box, layerDef, dateStr) {
        const satSelect = document.getElementById('satelliteSelect');
        satImage = canvasImg;
        satImageBox = { minLon: box.minLon, minLat: box.minLat, maxLon: box.maxLon, maxLat: box.maxLat };
        satImageLoaded = true;
        bgNeedsUpdate = true;

        const opt = satSelect.options[satSelect.selectedIndex];
        let defaultTimeMs = new Date(dateStr + 'T00:00:00Z').getTime();
        let exact = false;
        let pending = true;
        const timeMatch = opt ? opt.textContent.match(/\[(\d{2}):(\d{2})Z\]/) : null;
        if (timeMatch) {
            const d = new Date(dateStr + 'T00:00:00Z');
            d.setUTCHours(parseInt(timeMatch[1], 10));
            d.setUTCMinutes(parseInt(timeMatch[2], 10));
            defaultTimeMs = d.getTime();
            exact = true;
            pending = false;
        } else if (opt && opt.textContent.includes('[Daily]')) {
            pending = false;
        }
        satLoadedInfo = {
            layerLabel: layerDef.baseLabel,
            imageTimeMs: defaultTimeMs,
            isModis: true,
            modisTimePending: pending,
            modisExact: exact,
            dayOffset: satDayOffset
        };

        updateSatTimeBadge();
        if (trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
    }

    // Lat/lon extent of the WHOLE cleaned flight (not the time-filtered window, not canvas-derived),
    // so the GOES tile box is stable no matter the zoom, window size, or start/end-time filter.
    function flightLatLonExtent() {
        const src = (allParsedData && allParsedData.length) ? allParsedData : filteredData;
        if (!src || !src.length) return null;
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (const d of src) {
            if (d.lat < minLat) minLat = d.lat; if (d.lat > maxLat) maxLat = d.lat;
            if (d.lon < minLon) minLon = d.lon; if (d.lon > maxLon) maxLon = d.lon;
        }
        return { minLat, maxLat, minLon, maxLon };
    }

    // Square bbox (km) centered on the flight extent + margin, snapped to a coarse grid (center 0.5°,
    // dims 500 km) so live playback, preloading, and batch caching all build the same fetchId.
    function computeReconTileGeom(extent) {
        const ex = extent || flightLatLonExtent();
        if (!ex) return { centerStr: '0.000,0.000', dimsKm: 800 };
        let cLon = (ex.minLon + ex.maxLon) / 2, cLat = (ex.minLat + ex.maxLat) / 2;
        const latSpanKm = (ex.maxLat - ex.minLat) * 111;
        const lonSpanKm = (ex.maxLon - ex.minLon) * 111 * Math.cos(cLat * Math.PI / 180);
        let dimsKm = Math.max(800, Math.min(4000, Math.max(latSpanKm, lonSpanKm) * 1.4 + 600));
        cLat = Math.round(cLat * 2) / 2;                       // snap center to 0.5°
        cLon = Math.round(cLon * 2) / 2;
        dimsKm = Math.min(4000, Math.ceil(dimsKm / 500) * 500); // snap size up to 500 km (keeps coverage)
        const centerStr = cLat.toFixed(3) + ',' + cLon.toFixed(3);
        return { centerStr, dimsKm };
    }

    // Archive GOES path: pick the playback-clock 10-min bucket, request a bbox tile centered on the
    // flight from the recon-api, and place it by the API's returned bounds. Mirrors the polar path's
    // synchronous-lastSatFetchTime debounce so per-frame playback calls don't reset the timer.
    function fetchReconApiSat(layerDef, bandObj, absSeconds) {
        const satSelect = document.getElementById('satelliteSelect');
        const bandName = bandObj.name || bandObj.id;
        const shortLabel = layerDef.baseLabel.replace(' (Archive)', ' Archive');

        // Outside this satellite's Earth disk, bail with a clear note (the option is disabled too).
        if (!goesInCoverage(layerDef)) {
            satImageLoaded = false; satImage = new Image(); satLoadedInfo = null; satImageBox = null; bgNeedsUpdate = true;
            satUnavailableNote = `${shortLabel} can't see this area<br><span style="color:#fbbf24">flight is outside the satellite's Earth-disk view</span>`;
            updateSatTimeBadge();
            if (trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
            return;
        }

        const bucketMs = goesBucketMs(layerDef, absSeconds);
        if (bucketMs == null) return;
        // Keep the dropdown label's ~scan time in step with the playback clock.
        if (bucketMs !== _goesLabelMs) {
            _goesLabelMs = bucketMs;
            const selOpt = satSelect.options[satSelect.selectedIndex];
            if (selOpt) setGoesOptionState(selOpt, layerDef);
        }
        satUnavailableNote = null;

        // Warm the buckets around the playhead in the background so scrubbing stays smooth.
        // bboxSupported is read from the /products discovery endpoint (bands and composites both
        // report it); a false there means a genuinely full-disk-only product, none current.
        const bboxSupported = bandObj.bboxSupported !== false;
        if (bboxSupported) preloadSatAround(absSeconds);

        // Square bbox (km) centered on the flight, covering its extent + margin, within the API's range.
        // Only a full-disk-only product (bboxSupported false) skips this and renders the whole disk.
        const geom = bboxSupported ? computeReconTileGeom() : null;
        const centerStr = geom ? geom.centerStr : null, dimsKm = geom ? geom.dimsKm : null;
        const timeIso = goesTimeStr(bucketMs);

        // One request per distinct target; mark SYNCHRONOUSLY (like the polar path) so per-frame
        // playback calls don't keep resetting the debounce timer.
        const fetchId = layerDef.value + '||' + bandObj.id + '||' + timeIso + '||' + (centerStr || 'fulldisk') + '||' + (dimsKm || '');
        if (lastSatFetchTime === fetchId) return;
        lastSatFetchTime = fetchId;

        const fetchParams = { band: bandObj.band, cmap: bandObj.cmap, product: bandObj.product, timeIso,
            center: centerStr, dims: dimsKm, unit: 'km', satellite: layerDef.satellite };

        // Already decoded in the HOT cache? Re-show it INSTANTLY, no network, no decode, no debounce.
        // This is what makes scrubbing across preloaded buckets smooth.
        const cached = satCacheGet(fetchId);
        if (cached) { applyReconSatResult(cached, layerDef, shortLabel, bandName, bucketMs); return; }

        // Not hot, but present in the local COLD blob store (pre-cached / seen earlier this session)?
        // Decode it (~ms, no network) and show, no debounce needed.
        if (satBlobStore.has(fetchId)) {
            getOrFetchReconTile(fetchId, fetchParams)
                .then(r => { if (lastSatFetchTime === fetchId && r && r.canvas) applyReconSatResult(r, layerDef, shortLabel, bandName, bucketMs); });
            return;
        }

        // True cold miss: fetch from the API (deduped, then cached). Debounced so rapid scrubbing doesn't
        // fire a display fetch for every bucket it flies past, only the one it settles on.
        clearTimeout(satDebounceTimer);
        satDebounceTimer = setTimeout(async () => {
            // Don't flash "Fetching satellite…" when we're caching locally / the tile is already being
            // pulled into the local cache, the background pill covers that and playback stays quiet.
            if (!batchCaching && !satFetchInFlight.has(fetchId)) showSatLoader();
            try {
                const r = await getOrFetchReconTile(fetchId, fetchParams);
                hideSatLoader();
                // User may have changed layer/band, or the clock crossed a new bucket, while we polled.
                if (lastSatFetchTime !== fetchId) return;
                if (r && r.canvas) {
                    applyReconSatResult(r, layerDef, shortLabel, bandName, bucketMs);
                } else {
                    // Keep the last good tile on screen instead of blanking, so the user always sees
                    // imagery even when a bucket has no scan / errors. (attempt-once: lastSatFetchTime is
                    // already set to this bucket, so we won't hammer the API retrying it.)
                    showToast(`GOES Archive ${bandName}: ${(r && r.error) || 'no scan'} near ${timeIso.slice(11,16)}Z, keeping previous image.`, 5000);
                }
            } catch(e) {
                hideSatLoader();   // transient error, leave the previous tile up rather than blanking
            }
        }, 350);
    }

    // --- Background preloader ----------------------------------------------------------
    // As the playhead moves, queue the surrounding 10-min buckets (forward-weighted) and warm any
    // that aren't already local. Cache-first: cached buckets are skipped; the rest are pulled from
    // the API ONE AT A TIME (gentle on the server) and stored, so by the time the slider reaches
    // them they re-show instantly. GOES only, polar layers are a single image per day.
    const SAT_PRELOAD_AHEAD = 6, SAT_PRELOAD_BEHIND = 2;
    function resetSatPreload() { satPreloadQueue = []; _satPreloadBucket = null; }

    function preloadSatAround(absSeconds) {
        const satSelect = document.getElementById('satelliteSelect');
        const bandSelect = document.getElementById('satBandSelect');
        if (!satSelect || satSelect.value === 'none' || !bandSelect) return;
        if (flightMetaData.date === 'Unknown' || filteredData.length === 0) return;
        if (!trackerModeSelect || trackerModeSelect.value !== '2d') return;
        const layerDef = GIBS_LAYERS.find(d => d.value === satSelect.value);
        if (!layerDef || !layerDef.isReconApi || !goesInCoverage(layerDef)) return;

        const baseBucket = goesBucketMs(layerDef, absSeconds);
        if (baseBucket == null || baseBucket === _satPreloadBucket) return;  // same neighborhood already queued
        _satPreloadBucket = baseBucket;

        const bandObj = layerDef.bands.find(b => b.id === bandSelect.value) || layerDef.bands[0];
        const { centerStr, dimsKm } = computeReconTileGeom();
        const cadMs = (layerDef.cadenceMin || 10) * 60000;
        const flightStart = goesBucketMs(layerDef, filteredData[0].absSeconds);
        const flightEnd   = goesBucketMs(layerDef, filteredData[filteredData.length - 1].absSeconds);

        const order = [];
        for (let k = 0; k <= SAT_PRELOAD_AHEAD; k++)  order.push(baseBucket + k * cadMs);  // current + ahead first
        for (let k = 1; k <= SAT_PRELOAD_BEHIND; k++) order.push(baseBucket - k * cadMs);  // then behind

        const q = [], seen = new Set();
        order.forEach(ms => {
            if (ms < flightStart || ms > flightEnd) return;
            const timeIso = goesTimeStr(ms);
            const fetchId = layerDef.value + '||' + bandObj.id + '||' + timeIso + '||' + centerStr + '||' + dimsKm;
            if (seen.has(fetchId)) return; seen.add(fetchId);
            if (satTileCache.has(fetchId)) return;   // already decoded in the hot cache, nothing to warm
            q.push({ fetchId, params: { band: bandObj.band, cmap: bandObj.cmap, timeIso,
                                        center: centerStr, dims: dimsKm, unit: 'km', satellite: layerDef.satellite } });
        });
        satPreloadQueue = q;   // replace: the worker always drains toward the newest neighborhood
        runSatPreloadWorker();
    }

    async function runSatPreloadWorker() {
        if (satPreloadActive) return;
        satPreloadActive = true;
        try {
            while (satPreloadQueue.length) {
                const t = satPreloadQueue.shift();
                if (satTileCache.has(t.fetchId)) continue;
                await getOrFetchReconTile(t.fetchId, t.params);  // caches on success; dedupes vs live/prefetch
            }
        } finally { satPreloadActive = false; }
    }

    // Place a (freshly fetched OR cached) archive-GOES tile and refresh the badge/map.
    function applyReconSatResult(r, layerDef, shortLabel, bandName, bucketMs) {
        satImage = r.canvas;
        satImageBox = r.box;
        satImageLoaded = true; bgNeedsUpdate = true;
        satLoadedInfo = {
            layerLabel: shortLabel + ' · ' + bandName,
            imageTimeMs: r.scanStartMs || bucketMs,
            isModis: false,
            isReconApi: true,
            cadenceMin: layerDef.cadenceMin || 10
        };
        updateSatTimeBadge();
        if (trackerModeSelect.value === '2d') renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
    }

    // --- Background progress pill (2D map, top-center) ---------------------------------
    // Non-blocking indicator for the local satellite cache, so the user can close the modal and keep
    // working while it fills in the background. Driven by the batch cache via setBatchProgress().
    function showSatPrefetchBar() {
        const b = document.getElementById('satPrefetchBar'); if (b) b.classList.remove('hidden');
        const pl = document.getElementById('satPrefetchLabel'); if (pl) pl.textContent = 'Preparing satellite cache…';
        setPrefetchIndeterminate(true);   // bounce until the first tile actually lands
    }
    function hideSatPrefetchBar() {
        const b = document.getElementById('satPrefetchBar'); if (b) b.classList.add('hidden');
        setPrefetchIndeterminate(false);
    }

    // --- Multi-flight batch cache ------------------------------------------------------
    // Pre-downloads archive-GOES imagery for many storms without loading each flight into the app.
    // Each file is parsed (same pipeline as playback) to get the same deterministic tile IDs, then
    // every 10-min tile for the chosen bands is pulled into the shared blob store.

    // Read one flight file to cleaned rows + its date (date comes from the filename, like the loader).
    function readFlightFileForBatch(file) {
        return new Promise(resolve => {
            const date = (typeof flightDateFromFilename === 'function') ? flightDateFromFilename(file.name) : 'Unknown';
            const isNc = file.name.split('.').pop().toLowerCase() === 'nc';
            const reader = new FileReader();
            reader.onload = (evt) => {
                try {
                    const tsv = isNc ? ncArrayBufferToTsv(evt.target.result) : evt.target.result;
                    resolve({ name: file.name, date, rows: parseFlightTextToRows(tsv).rows });
                } catch (e) { resolve({ name: file.name, date, rows: [] }); }
            };
            reader.onerror = () => resolve({ name: file.name, date, rows: [] });
            if (isNc) reader.readAsArrayBuffer(file); else reader.readAsText(file);
        });
    }

    function rowsLatLonExtent(rows) {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (const d of rows) {
            if (d.lat < minLat) minLat = d.lat; if (d.lat > maxLat) maxLat = d.lat;
            if (d.lon < minLon) minLon = d.lon; if (d.lon > maxLon) maxLon = d.lon;
        }
        return { minLat, maxLat, minLon, maxLon };
    }

    // Until the first tile lands there is no meaningful percentage (the first server-side
    // render can take ~30s), so the fills bounce indeterminately, like the flight-data
    // loading overlay, and switch to the real bar on the first setBatchProgress(done>0).
    function setPrefetchIndeterminate(on) {
        ['batchCacheFill', 'satPrefetchFill'].forEach(id => {
            const el = document.getElementById(id); if (!el) return;
            el.classList.toggle('indeterminate', on);
            if (on) el.style.width = '';
        });
    }

    function setBatchProgress(done, total, note) {
        const pct = total ? Math.round((done / total) * 100) : 0;
        if (done > 0) setPrefetchIndeterminate(false);
        // Modal progress (visible when the modal is open).
        const fill = document.getElementById('batchCacheFill'); if (fill && done > 0) fill.style.width = pct + '%';
        const lbl = document.getElementById('batchCacheStatus'); if (lbl && note) lbl.textContent = note;
        // Background pill (visible on the 2D map when the modal is closed).
        const pf = document.getElementById('satPrefetchFill'); if (pf && done > 0) pf.style.width = pct + '%';
        const pl = document.getElementById('satPrefetchLabel'); if (pl && note) pl.textContent = note;
    }

    // Build the list of {fetchId, run} tiles to cache for one storm's rows+date, for the USER-CHOSEN
    // satellite (layerValue) and bands. GOES layers cache every 10-min bucket; polar layers cache one
    // daily tile per band. Returns [] if the storm is out of that satellite's view / before its data.
    function batchTargetsForFlight(rows, dateStr, bandIds, layerValue) {
        if (!rows || rows.length === 0) return [];
        const layerDef = GIBS_LAYERS.find(d => d.value === layerValue);
        if (!layerDef) return [];
        if (layerDef.minDate && dateStr < layerDef.minDate) return [];
        const extent = rowsLatLonExtent(rows);
        const out = [], seen = new Set();

        if (layerDef.isReconApi) {
            if (!extentInGoesCoverage(layerDef, extent)) return [];   // storm outside this GOES disk
            const { centerStr, dimsKm } = computeReconTileGeom(extent);
            const cadMs = (layerDef.cadenceMin || 10) * 60000;
            const startMs = goesBucketMs(layerDef, rows[0].absSeconds, dateStr);
            const endMs   = goesBucketMs(layerDef, rows[rows.length - 1].absSeconds, dateStr);
            if (startMs == null || endMs == null) return [];
            for (const bandId of bandIds) {
                const bandObj = layerDef.bands.find(b => b.id === bandId); if (!bandObj) continue;
                // Composite products (sandwich/geocolor) don't support bbox, a full-timeframe build
                // would mean a slow full-disk render per bucket, which isn't what "cache this flight's
                // area" is for. They're still viewable live (fetchReconApiSat), just not pre-built here.
                if (bandObj.bboxSupported === false) continue;
                for (let ms = startMs; ms <= endMs; ms += cadMs) {
                    const timeIso = goesTimeStr(ms);
                    const fetchId = layerDef.value + '||' + bandObj.id + '||' + timeIso + '||' + centerStr + '||' + dimsKm;
                    if (seen.has(fetchId)) continue; seen.add(fetchId);
                    const params = { band: bandObj.band, cmap: bandObj.cmap, timeIso, center: centerStr, dims: dimsKm, unit: 'km', satellite: layerDef.satellite };
                    out.push({ fetchId, run: () => getOrFetchReconTile(fetchId, params) });
                }
            }
        } else {
            // Polar (MODIS/VIIRS GIBS): one daily tile per band for the flight's date.
            const box = computeSatFetchBox(extent);
            if (!box) return [];
            const boxLonSpan = box.maxLon - box.minLon, boxLatSpan = box.maxLat - box.minLat;
            const aspect = boxLonSpan / boxLatSpan;
            const NATIVE_PX_PER_DEG = 111320 / 250, SAT_PX_CAP = 3072;
            let pxW = Math.min(SAT_PX_CAP, Math.round(boxLonSpan * NATIVE_PX_PER_DEG));
            let pxH = Math.round(pxW / aspect);
            if (pxH > SAT_PX_CAP) { pxH = SAT_PX_CAP; pxW = Math.round(pxH * aspect); }
            for (const bandId of bandIds) {
                if (!layerDef.bands.find(b => b.id === bandId)) continue;
                const fetchId = layerDef.value + '||' + bandId + '||' + dateStr + '||' +
                    box.minLon.toFixed(2)+','+box.minLat.toFixed(2)+','+box.maxLon.toFixed(2)+','+box.maxLat.toFixed(2);
                if (seen.has(fetchId)) continue; seen.add(fetchId);
                const params = { wmsLayer: layerDef.wmsPrefix + bandId, dateStr, box, pxW, pxH };
                out.push({ fetchId, run: () => getOrFetchPolarTile(fetchId, params) });
            }
        }
        return out;
    }

    // Lock/unlock the satellite + band pickers while a cache pass owns them, so the user can't switch
    // products mid-build (which would orphan the in-progress fetch/poll), they must Cancel first.
    function setSatelliteControlsLocked(locked) {
        const satSelect = document.getElementById('satelliteSelect');
        const bandSelect = document.getElementById('satBandSelect');
        if (satSelect) satSelect.disabled = locked;
        if (bandSelect) bandSelect.disabled = locked;
    }

    // Pre-caches the currently loaded flight's tiles for a satellite/bands, building the same
    // deterministic tile list live playback will request, so playback never pauses on the API.
    // Triggered by maybeAutoPrecacheSatellite() or the "Pre-Cache Satellite Imagery" modal.
    async function precacheCurrentFlight(layerValue, bandIds) {
        if (batchCaching) { showToast('A cache pass is already running.', 4000); return; }
        if (!allParsedData || !allParsedData.length) { showToast('Load a flight first.', 4000); return; }
        const layerDefForCheck = GIBS_LAYERS.find(d => d.value === layerValue);
        if (layerDefForCheck && layerDefForCheck.isReconApi && !isReconApiAvailable()) {
            showToast('Archive GOES caching is unavailable while the API is offline.', 5000); return;
        }
        const targets = batchTargetsForFlight(allParsedData, flightMetaData.date, bandIds, layerValue);
        if (!targets.length) { showToast('Nothing to pre-cache for this satellite/flight.', 5000); return; }
        const myPass = ++batchCachePass;
        batchCaching = true; batchCacheCancel = false; batchCacheAbortController = new AbortController();
        setSatelliteControlsLocked(true);
        showSatPrefetchBar();   // background pill (has its own Cancel) so playback stays usable
        const total = targets.length;
        let done = 0, fetched = 0;
        for (const t of targets) {
            if (batchCacheCancel || myPass !== batchCachePass) break;
            if (satBlobStore.has(t.fetchId)) { done++; setBatchProgress(done, total, `Caching ${done}/${total} (${fetched} new)…`); continue; }
            try { const r = await t.run(); if (r && r.canvas) fetched++; } catch (e) {}
            done++;
            setBatchProgress(done, total, `Caching ${done}/${total} (${fetched} new)…`);
        }
        if (myPass !== batchCachePass) return;   // a Cancel already tore this pass down (and maybe started a new one)
        batchCaching = false; batchCacheCancel = false; batchCacheAbortController = null;
        setSatelliteControlsLocked(false);
        const doneMsg = `Pre-cache done: ${fetched} new tile(s) cached for smooth playback.`;
        setBatchProgress(done, total || 1, doneMsg);
        setTimeout(hideSatPrefetchBar, 2500);
        showToast(doneMsg, 6000);
        // Tiles are warm now: draw the current frame's imagery straight from cache.
        if (filteredData.length > 0 && trackerModeSelect.value === '2d') fetchSatelliteImage(filteredData[currentIdx].absSeconds);
    }

    // Auto-triggers the full-timeframe pre-cache whenever an archive-GOES layer is active, so imagery
    // is ready before playback needs it. Called after a flight (re)loads and on satellite/band change.
    // Rechecks the actual cold cache every call (not a session flag): if every tile is already in
    // satBlobStore, stays silent with no network requests; a cancelled/partial pass is retried
    // automatically next time since "missing" is recomputed fresh, not remembered.
    async function maybeAutoPrecacheSatellite() {
        // Wait for the persisted (IndexedDB) tiles to rehydrate first, otherwise a fresh page load
        // with a fully cached flight would look cold and start a needless rebuild pass.
        await satStoreReady;
        const satSelect = document.getElementById('satelliteSelect');
        const bandSelect = document.getElementById('satBandSelect');
        if (!satSelect || satSelect.value === 'none' || !allParsedData.length) return;
        if (batchCaching) return;   // a pass (this combo or another) is already running, let it finish, don't pile on
        const layerDef = GIBS_LAYERS.find(d => d.value === satSelect.value);
        if (!layerDef || !layerDef.isReconApi) return;   // polar (MODIS/VIIRS) is a single daily image, nothing to build ahead
        if (!goesInCoverage(layerDef)) return;           // out of this satellite's Earth-disk view

        // bandId is '' until the user explicitly picks a product from the placeholder-first dropdown
        // (updateBandOptions), no fallback to "all bands"; caching is scoped to exactly what they chose.
        const bandId = bandSelect ? bandSelect.value : '';
        if (!bandId) return;
        const bandObj = (layerDef.bands || []).find(b => b.id === bandId);
        if (!bandObj || bandObj.bboxSupported === false) return;   // unknown product, or a full-disk-only composite (streams live instead, see fetchReconApiSat)

        const targets = batchTargetsForFlight(allParsedData, flightMetaData.date, [bandId], layerDef.value);
        if (targets.length === 0) return;                            // out of view / before this satellite's data
        if (targets.every(t => satBlobStore.has(t.fetchId))) return;  // already cached locally, don't prompt, don't submit new queries

        showToast(`Building ${layerDef.baseLabel} ${bandObj.name} imagery for the full flight timeframe…`, 4000);
        precacheCurrentFlight(layerDef.value, [bandId]);
    }

    async function batchCacheFlights(files, bandIds, layerValue) {
        if (batchCaching) return;
        if (!files || !files.length) { showToast('Pick one or more flight files first.', 5000); return; }
        if (!layerValue) { showToast('Pick a satellite to cache.', 5000); return; }
        if (!bandIds || !bandIds.length) { showToast('Pick at least one band to cache.', 5000); return; }
        const layerDefForCheck = GIBS_LAYERS.find(d => d.value === layerValue);
        if (layerDefForCheck && layerDefForCheck.isReconApi && !isReconApiAvailable()) {
            showToast('Archive GOES caching is unavailable while the API is offline.', 5000); return;
        }
        const myPass = ++batchCachePass;
        batchCaching = true; batchCacheCancel = false; batchCacheAbortController = new AbortController();
        setSatelliteControlsLocked(true);
        const startBtn = document.getElementById('batchCacheStartBtn');
        if (startBtn) { startBtn.textContent = 'Stop'; }
        showSatPrefetchBar();   // background pill so progress is visible even if the modal is closed

        // Pass 1: parse every file (sequentially) and build the tile list.
        let allTargets = [], skipped = 0;
        for (let i = 0; i < files.length; i++) {
            if (batchCacheCancel || myPass !== batchCachePass) break;
            setBatchProgress(0, 1, `Reading ${i + 1}/${files.length}: ${files[i].name}…`);
            const f = await readFlightFileForBatch(files[i]);
            if (myPass !== batchCachePass) break;
            if (f.date === 'Unknown' || f.rows.length === 0) { skipped++; continue; }
            const t = batchTargetsForFlight(f.rows, f.date, bandIds, layerValue);
            if (t.length === 0) { skipped++; continue; }   // out of view / before this satellite's data
            allTargets = allTargets.concat(t);
        }

        // Pass 2: pull each tile once (skip anything already cached), gently one at a time.
        const total = allTargets.length;
        let done = 0, fetched = 0, failed = 0;
        for (const t of allTargets) {
            if (batchCacheCancel || myPass !== batchCachePass) break;
            if (satBlobStore.has(t.fetchId)) { done++; setBatchProgress(done, total, `Caching ${done}/${total} (${fetched} new)…`); continue; }
            try {
                const r = await t.run();
                if (r && r.canvas) fetched++; else failed++;
            } catch (e) { failed++; }
            done++;
            setBatchProgress(done, total, `Caching ${done}/${total} (${fetched} new)…`);
        }

        if (myPass !== batchCachePass) return;   // a Cancel already tore this pass down (and maybe started a new one)
        batchCaching = false; batchCacheCancel = false; batchCacheAbortController = null;
        setSatelliteControlsLocked(false);
        if (startBtn) startBtn.textContent = 'Start caching';
        const msg = `Local cache done: ${fetched} new tile(s) from ${files.length - skipped} flight(s)${skipped ? `, ${skipped} skipped (out of view / before this satellite's data / no date)` : ''}.`;
        setBatchProgress(done, total || 1, msg);
        setTimeout(hideSatPrefetchBar, 2500);   // leave the pill up briefly with the final count
        showToast(msg, 7000);
    }

    // Fill the batch modal's satellite dropdown (all layers) and the band checkboxes for the chosen sat.
    function populateBatchSatSelect() {
        const satSel = document.getElementById('batchSatSelect'); if (!satSel) return;
        const cur = satSel.value;
        const mapSat = (document.getElementById('satelliteSelect') || {}).value;
        satSel.innerHTML = '';
        GIBS_LAYERS.forEach(d => {
            const o = document.createElement('option'); o.value = d.value; o.textContent = d.baseLabel;
            // Archive-GOES options need the API to render any tile, gray them out (with an "API
            // Offline" label, same as the main satellite dropdown) rather than letting a batch pass
            // start against a satellite it can't actually fetch.
            if (d.isReconApi && !isReconApiAvailable()) { o.disabled = true; o.textContent = `${d.baseLabel} (API Offline)`; }
            satSel.appendChild(o);
        });
        // Keep the current pick if valid and selectable, else mirror the map's selected layer, else first available.
        const stillOk = cur && [...satSel.options].some(o => o.value === cur && !o.disabled);
        if (stillOk) satSel.value = cur;
        else if (mapSat && mapSat !== 'none' && [...satSel.options].some(o => o.value === mapSat && !o.disabled)) satSel.value = mapSat;
        else { const firstOk = [...satSel.options].find(o => !o.disabled); if (firstOk) satSel.value = firstOk.value; }
    }

    // Band checkboxes for whichever satellite is chosen in the batch modal (defaults to all checked).
    function populateBatchBandChecks() {
        const wrap = document.getElementById('batchBandChecks'); if (!wrap) return;
        const startBtn = document.getElementById('batchCacheStartBtn');
        const satVal = (document.getElementById('batchSatSelect') || {}).value;
        const layerDef = GIBS_LAYERS.find(d => d.value === satVal);
        // Capture existing ticks BEFORE clearing, rebuilds (health poll with the modal
        // open) must not reset the user's selection.
        const prevChecked = [...wrap.querySelectorAll('input[type="checkbox"]')].map(c => ({ id: c.value, on: c.checked }));
        wrap.innerHTML = '';
        if (layerDef && layerDef.isReconApi && !isReconApiAvailable()) {
            wrap.innerHTML = '<span class="text-danger font-semibold">API offline: archive GOES caching unavailable</span>';
            if (startBtn) { startBtn.disabled = true; startBtn.classList.add('opacity-50', 'cursor-not-allowed'); }
            return;
        }
        if (startBtn) { startBtn.disabled = false; startBtn.classList.remove('opacity-50', 'cursor-not-allowed'); }
        // Full-disk-only composites (sandwich/geocolor) can't be cached by area like everything else
        // here, batch caching is always a bbox around each flight. They're still viewable live.
        const bands = ((layerDef && layerDef.bands) ? layerDef.bands : []).filter(b => b.bboxSupported !== false && b.available !== false);
        const curBand = (document.getElementById('satBandSelect') || {}).value;
        bands.forEach((b, i) => {
            const lbl = document.createElement('label'); lbl.className = 'flex items-center gap-1 cursor-pointer';
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = b.id; cb.className = 'accent-accent w-3.5 h-3.5';
            const prev = prevChecked.find(p => p.id === b.id);
            if (prev) cb.checked = prev.on;
            else cb.checked = bands.some(x => x.id === curBand) ? (b.id === curBand) : true;
            lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' ' + b.name));
            wrap.appendChild(lbl);
        });
    }
