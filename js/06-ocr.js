/* Mission Visualizer, OCR worker init + drop-zone helper
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    let ocrWorker = null, isOcrRunning = false, lastOcrTime = 0, lastOcrVideoTime = 0, ocrHistory = [], ocrAvailable = false;
    async function initOCR() {
        if (ocrWorker) return;
        if (typeof Tesseract === 'undefined') { ocrAvailable = false; return; }
        try {
            // Worker, wasm core, and eng language data are all vendored in lib/tesseract/ so
            // Auto-Sync OCR works with no internet. Absolute URLs (resolved against the page)
            // because the worker resolves relative corePath/langPath against ITS OWN location.
            const base = new URL('lib/tesseract/', window.location.href).href;
            ocrWorker = await Tesseract.createWorker({
                workerPath: base + 'worker.min.js',
                corePath: base.replace(/\/$/, ''),
                langPath: base.replace(/\/$/, '')
            });
            await ocrWorker.loadLanguage('eng'); await ocrWorker.initialize('eng');
            await ocrWorker.setParameters({ tessedit_char_whitelist: '0123456789:;.,|IloOZS ', tessjs_create_hocr: '0', tessjs_create_tsv: '0', tessjs_create_osd: '0' });
            ocrAvailable = true;
        } catch(e) { ocrAvailable = false; ocrWorker = null; console.warn("Auto-sync OCR unavailable."); }
    }
    window.addEventListener('load', initOCR);

    // --- Non-blocking "Syncing…" badge, shown while Auto-Sync is hunting for the MMR timestamp ---
    // State-driven (not a counter) so the multi-scan drift hunt stays solid instead of flickering.
    // Visible whenever Auto-Sync has a video and is either actively scanning (isOcrRunning) or
    // still has a pending (re)lock queued (forceOcrSyncNextTick). Hidden once a lock settles.
    function refreshSyncingIndicator() {
        const el = document.getElementById('syncingIndicator');
        if (!el) return;
        const hunting = videoLoaded
            && videoSyncMode && videoSyncMode.value === 'auto'
            && ocrAvailable && (isOcrRunning || forceOcrSyncNextTick);
        el.classList.toggle('show', !!hunting);
    }

    // Inverse of markDropZoneLoaded: returns a drop zone to its dashed waiting state.
    function resetDropZone(zoneId, labelId, text) {
        const zone = document.getElementById(zoneId);
        const label = document.getElementById(labelId);
        if (!zone || !label) return;
        zone.classList.add('bg-panel-strip', 'border-dashed', 'hover:border-accent', 'hover:bg-elevated');
        zone.classList.remove('bg-[color-mix(in_oklab,var(--bg)_40%,transparent)]', 'border-solid', 'hover:border-hairline-strong', 'hover:bg-[color-mix(in_oklab,var(--bg)_60%,transparent)]');
        label.classList.add('text-muted', 'group-hover:text-accent');
        label.classList.remove('text-ink', 'group-hover:text-ink');
        label.textContent = text;
        label.removeAttribute('title');
    }

    // --- Mark a drop zone as "file loaded": turn it gray + show the filename small ---
    function markDropZoneLoaded(zoneId, labelId, filename) {
        const zone = document.getElementById(zoneId);
        const label = document.getElementById(labelId);
        if (!zone || !label) return;
        zone.classList.remove('bg-panel-strip', 'border-hairline-strong', 'border-dashed', 'hover:border-accent', 'hover:bg-elevated');
        zone.classList.add('bg-[color-mix(in_oklab,var(--bg)_40%,transparent)]', 'border-hairline-strong', 'border-solid', 'hover:border-hairline-strong', 'hover:bg-[color-mix(in_oklab,var(--bg)_60%,transparent)]');
        label.classList.remove('text-muted', 'group-hover:text-accent');
        label.classList.add('text-ink', 'group-hover:text-ink');
        label.textContent = filename;
        label.title = filename;
    }
