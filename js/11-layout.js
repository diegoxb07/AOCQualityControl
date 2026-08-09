/* Mission Visualizer, canvas/layout resize
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
        }
    });

    // timeToSeconds/toHHMMSS live in js/11b-parser-core.js (shared with the parse worker and tests).
