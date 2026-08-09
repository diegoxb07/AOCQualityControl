/* Mission Visualizer, filter window init
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    function applyFiltersAndInit(shouldPlay = false) {
        stopPlayback();

        const sLim = timeToSeconds(document.getElementById('startTimeInput').value); const eLim = timeToSeconds(document.getElementById('endTimeInput').value);
        // Remember the applied time window so the Play button (which folded in "Apply & Run") can tell
        // whether the manual window was edited since and needs re-applying before playing.
        window._appliedWindow = document.getElementById('startTimeInput').value + '|' + document.getElementById('endTimeInput').value;
        filteredData = allParsedData.filter(d => d.absSeconds >= sLim && (d.absSeconds <= eLim || eLim < sLim && d.absSeconds <= eLim + 86400));
        if (filteredData.length === 0) return;

        mapPlaceholder.style.display = 'none';
        setPlaybackReady(true);
        resizeCanvasLayout(); calculateMapScales(); resetMapView();
        if (trackerModeSelect.value === '3d') build3DScene();

        currentIdx = 0;
        bgNeedsUpdate = true;
        updateVisualComponents(currentIdx);

        if (shouldPlay === true) {
            startPlayback();
        }
    }
