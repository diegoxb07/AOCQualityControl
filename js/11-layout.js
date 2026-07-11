/* Mission Visualizer, canvas/layout resize + time helpers
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    function resizeCanvasLayout() {
        const rect = canvas.parentElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // HiDPI: render the backing store at devicePixelRatio so text/lines are crisp on Retina.
        // CSS size stays `rect` (the element is width/height:100%); logical coords use cssW/cssH.
        const dpr = window.devicePixelRatio || 1;
        const wCss = Math.round(rect.width), hCss = Math.round(rect.height);
        const bw = Math.round(wCss * dpr), bh = Math.round(hCss * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
            // A panned/zoomed 2D view is stored in pixels against the old canvas size; capture it as
            // geography first so the same place stays centered after the resize instead of jumping.
            const keepView = (filteredData.length > 0 && trackerModeSelect.value === '2d' && isMapPanned()) ? getMapViewportGeo() : null;
            DPR = dpr; cssW = wCss; cssH = hCss;
            canvas.width = bgCanvas.width = bw;
            canvas.height = bgCanvas.height = bh;
            if (keepView) applyMapViewportGeo(keepView);
            bgNeedsUpdate = true;
            if (threeDInitialized && camera3D) {
                camera3D.aspect = wCss / hCss;
                camera3D.updateProjectionMatrix();
                renderer3D.setSize(wCss, hCss);
                if (renderer3D.setPixelRatio) renderer3D.setPixelRatio(dpr);
            }
        }

        // PFD backing store is DPR-scaled too (CSS keeps the display size at 100%); renderPFD
        // draws in logical CSS pixels through a setTransform(dpr) base, so its text stays crisp.
        const pfdC = document.getElementById('pfdCanvas');
        if (pfdC && pfdC.parentElement && pfdC.parentElement.style.display !== 'none') {
            const pRect = pfdC.parentElement.getBoundingClientRect();
            const pbw = Math.round(pRect.width * dpr), pbh = Math.round(pRect.height * dpr);
            if (pRect.width > 0 && pRect.height > 0 && (pfdC.width !== pbw || pfdC.height !== pbh)) {
                pfdC.width = pbw; pfdC.height = pbh;
                // PFD module is not shipped in the QC tool; guard every call so layout keeps working
                if(filteredData.length > 0 && typeof renderPFD === 'function') renderPFD(filteredData[currentIdx]);
            }
        }
    }
    window.addEventListener('resize', () => {
        if (filteredData.length > 0) {
            resizeCanvasLayout();
            if(trackerModeSelect.value === '2d') {
                // calculateMapScales reframes the base to fit the flight; preserve a user-panned view
                // across that reframe so a window resize doesn't yank them back to the default frame.
                const keepView = isMapPanned() ? getMapViewportGeo() : null;
                calculateMapScales();
                if (keepView) applyMapViewportGeo(keepView);
                bgNeedsUpdate = true; renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
            }
            if (typeof renderPFD === 'function' && document.getElementById('togglePfd').checked) renderPFD(filteredData[currentIdx]);
        }
    });

    // collapses the mmr panel out of the media bar whenever no video is loaded, so the
    // flight player spans the full media width at the same height. called after a video
    // loads or clears, and re-runs the map resize and redraw to fill the new width.
    function syncMediaGridLayout() {
        const grid = document.getElementById('mediaGrid');
        if (!grid) return;
        grid.classList.toggle('no-video', !videoLoaded);
        resizeCanvasLayout();
        if (filteredData.length > 0 && trackerModeSelect.value === '2d') {
            const keepView = isMapPanned() ? getMapViewportGeo() : null;
            calculateMapScales();
            if (keepView) applyMapViewportGeo(keepView);
            bgNeedsUpdate = true;
            renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
        }
        if (filteredData.length > 0 && typeof renderPFD === 'function' && document.getElementById('togglePfd').checked) renderPFD(filteredData[currentIdx]);
    }

    (function setupMediaResize() {
        const handle = document.getElementById('mediaResizeHandle'), bar = document.getElementById('stickyMediaBar');
        if (!handle || !bar) return;
        const MIN_H = 240, MAX_H = 900;  // keep the players usable when dragging; use the collapse button to fully hide them
        // The hard ceiling: the panels must never grow under the sticky bottom bar, or the
        // drag handle ends up unreachable and the layout is stuck big with no way to shrink.
        // 60px ≈ media-bar padding + the handle itself + a small breathing gap above the bar.
        const maxMediaH = () => {
            const bb = document.getElementById('stickyBottomBar');
            const bbH = bb ? bb.getBoundingClientRect().height : 90;
            return Math.max(MIN_H, Math.min(MAX_H, window.innerHeight - bbH - 60));
        };
        let dragging = false, startY = 0, startH = 0, rafPending = false;
        const pointerY = (e) => (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
        const applyMediaH = (h) => {
            document.documentElement.style.setProperty('--media-h', h + 'px');
            document.documentElement.style.setProperty('--hud-scale', Math.max(0.55, Math.min(1, h / 480)).toFixed(3));
        };

        function onDown(e) { dragging = true; isResizingMedia = true; startY = pointerY(e); startH = document.getElementById('mapPanel').getBoundingClientRect().height; bar.classList.add('resizing'); e.preventDefault(); }
        function onMove(e) {
            if (!dragging) return;
            const h = Math.max(MIN_H, Math.min(maxMediaH(), startH + (pointerY(e) - startY)));
            applyMediaH(h);
            if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false; resizeCanvasLayout();
                    if (filteredData.length > 0 && trackerModeSelect.value === '2d') { calculateMapScales(); bgNeedsUpdate = true; renderMapEngineFrame(currentIdx, filteredData[currentIdx]); }
                });
            }
            if (e.cancelable) e.preventDefault();
        }
        function onUp() { if (!dragging) return; dragging = false; isResizingMedia = false; bar.classList.remove('resizing'); resizeCanvasLayout(); if (filteredData.length > 0) { if (trackerModeSelect.value === '2d') { calculateMapScales(); bgNeedsUpdate = true; renderMapEngineFrame(currentIdx, filteredData[currentIdx]); } if (typeof renderPFD === 'function' && document.getElementById('togglePfd').checked) renderPFD(filteredData[currentIdx]); } }
        handle.addEventListener('mousedown', onDown); handle.addEventListener('touchstart', onDown, { passive: false });
        window.addEventListener('mousemove', onMove); window.addEventListener('touchmove', onMove, { passive: false }); window.addEventListener('mouseup', onUp); window.addEventListener('touchend', onUp);

        // Re-clamp if the window shrinks around an already-tall layout (and once at startup,
        // for short screens where even the default height would bury the handle). Pinned
        // (.fake-fs) panels are viewport-sized by design and skip this.
        function clampMediaToViewport() {
            const mapPanelEl = document.getElementById('mapPanel'), videoPanelEl = document.getElementById('videoPanel');
            if (mapPanelEl.classList.contains('fake-fs') || (videoPanelEl && videoPanelEl.classList.contains('fake-fs'))) return;
            const mx = maxMediaH();
            if (mapPanelEl.getBoundingClientRect().height > mx + 1) {
                applyMediaH(mx);
                resizeCanvasLayout();
                if (filteredData.length > 0 && trackerModeSelect.value === '2d') { calculateMapScales(); bgNeedsUpdate = true; renderMapEngineFrame(currentIdx, filteredData[currentIdx]); }
            }
        }
        window.addEventListener('resize', clampMediaToViewport);
        clampMediaToViewport();
    })();

    // collapser button above the player titles: toggles a collapsed class that hides the media
    // players. on expand the map was display:none, so recompute its size and redraw.
    (function setupMediaCollapse() {
        const btn = document.getElementById('mediaCollapseBtn'), bar = document.getElementById('stickyMediaBar');
        if (!btn || !bar) return;
        btn.addEventListener('click', () => {
            const collapsed = bar.classList.toggle('collapsed');
            btn.setAttribute('aria-expanded', String(!collapsed));
            btn.innerHTML = collapsed ? '&#9660; Show media' : '&#9650; Collapse media';
            // while the media is collapsed the full playback bar is hidden; the mini bar in the strip covers play/scrub/mark.
            const bottom = document.getElementById('stickyBottomBar');
            if (bottom) bottom.style.display = collapsed ? 'none' : '';
            if (typeof syncMiniPlaybackBar === 'function') syncMiniPlaybackBar();
            if (!collapsed) {
                resizeCanvasLayout();
                if (filteredData.length > 0 && trackerModeSelect.value === '2d') { calculateMapScales(); bgNeedsUpdate = true; renderMapEngineFrame(currentIdx, filteredData[currentIdx]); }
                if (filteredData.length > 0 && typeof renderPFD === 'function' && document.getElementById('togglePfd').checked) renderPFD(filteredData[currentIdx]);
            }
        });
    })();

    // timeToSeconds/toHHMMSS live in js/11b-parser-core.js (shared with the parse worker and tests).

    function updateEndWindowFromVideo(preservePlayback = false) {
        if (videoLoaded && video.duration && !isNaN(video.duration)) {
            let startSecs = timeToSeconds(document.getElementById('videoStartInput').value);
            if (startSecs > 0) {
                let endSecs = startSecs + video.duration;
                document.getElementById('startTimeInput').value = toHHMMSS(startSecs);
                document.getElementById('endTimeInput').value = toHHMMSS(endSecs);
                if (allParsedData.length > 0) {
                    let wasPlaying = isPlaying, targetSec = startSecs + video.currentTime, savedSyncFlag = hasInitialSyncOccurred; 
                    applyFiltersAndInit(false);
                    hasInitialSyncOccurred = savedSyncFlag; 
                    if (preservePlayback) {
                        currentIdx = filteredData.findIndex(d => d.absSeconds >= targetSec);
                        if (currentIdx === -1) currentIdx = 0;
                        updateVisualComponents(currentIdx);
                        if (wasPlaying) {
                            isPlaying = true; playPauseBtn.innerText = "Pause"; lastTickTime = performance.now();
                            if (videoLoaded && speeds[currentSpeedIdx] <= 16) video.play().catch(e=>{});
                            masterSyncEngineTick();
                        }
                    }
                }
                showToast(`tracker window auto-adjusted to synced video timeframe (${toHHMMSS(video.duration)})`, 5000);
            }
        }
    }
