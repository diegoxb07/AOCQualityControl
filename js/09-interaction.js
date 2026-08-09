/* Mission Visualizer, timeline sliding, keyboard, canvas input
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    let arrowSkipSpeed = 1;
    document.addEventListener('keydown', (e) => {
        if (!filteredData || filteredData.length === 0) return; if (e.target.tagName === 'INPUT' && (e.target.type === 'text' || e.target.type === 'number')) return;
        // Space = play/pause. Skipped when a button/select/checkbox has focus, space already
        // activates those natively and hijacking it would double-fire (a focused range slider is
        // fine though: space is a no-op there, and slide-then-space is a common flow).
        if (e.code === 'Space' && !/SELECT|BUTTON|TEXTAREA/.test(e.target.tagName)
            && !(e.target.tagName === 'INPUT' && /checkbox|radio/.test(e.target.type))) {
            e.preventDefault(); togglePlayback(); return;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            // the qc app owns arrow sliding (js/22 steps the raw-axis playhead); stepping the
            // cleaned-row index here too would fight it and judder a held-key slide
            if (document.body.classList.contains('qc-app-on')) return;
            // Shift+arrow = jump 10 flight-minutes.
            if (e.shiftKey) { e.preventDefault(); skipFlightMinutes(e.key === 'ArrowRight' ? 10 : -10); return; }
            e.preventDefault(); if (e.repeat) arrowSkipSpeed = Math.min(arrowSkipSpeed + 1, 50); else arrowSkipSpeed = 1;
            let dir = e.key === 'ArrowRight' ? 1 : -1; let newIdx = currentIdx + (dir * arrowSkipSpeed); newIdx = Math.max(0, Math.min(filteredData.length - 1, newIdx));
            if (newIdx !== currentIdx) { currentIdx = newIdx; updateVisualComponents(currentIdx); }
        }
    });
    document.addEventListener('keyup', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') arrowSkipSpeed = 1; });

    // Reset the 2D view = re-engage follow (zoom in and re-center on the aircraft).
    function resetMapView() { engageFollowAircraft(); }
    // The tracker's ⟲ button resets whichever view is active: 2D pan/zoom, or the 3D orbit
    // camera back to its home offset on the aircraft.
    document.getElementById('resetMapZoomBtn').addEventListener('click', () => {
        if (trackerModeSelect.value === '3d') { if (typeof reset3DView === 'function') reset3DView(); }
        else resetMapView();
    });

    // The recenter button only surfaces in 2D once the user has panned/zoomed off the aircraft.
    function updateFollowButton() {
        const btn = document.getElementById('recenterPlaneBtn');
        if (!btn) return;
        btn.style.display = (!followAircraft2D && filteredData.length > 0 && trackerModeSelect.value === '2d') ? '' : 'none';
    }
    const recenterBtn = document.getElementById('recenterPlaneBtn');
    if (recenterBtn) recenterBtn.addEventListener('click', () => engageFollowAircraft());

    canvas.addEventListener('mousedown', (e) => {
        if (trackerModeSelect.value === '3d') return;
        isDraggingMap = true; dragStartX = e.clientX - mapOffsetX; dragStartY = e.clientY - mapOffsetY; canvas.dataset.downX = e.clientX; canvas.dataset.downY = e.clientY;
    });

    canvas.addEventListener('mousemove', (e) => {
        if (trackerModeSelect.value === '3d') return;
        if (isDraggingMap) { disengageFollowAircraft(); mapOffsetX = e.clientX - dragStartX; mapOffsetY = e.clientY - dragStartY; bgNeedsUpdate = true; renderMapEngineFrame(currentIdx, filteredData[currentIdx]); }
    });

    canvas.addEventListener('mouseup', () => { isDraggingMap = false; });
    canvas.addEventListener('mouseleave', () => { isDraggingMap = false; });
    canvas.addEventListener('dblclick', () => { resetMapView(); });

    canvas.addEventListener('wheel', (e) => {
        if (trackerModeSelect.value === '3d') return;
        e.preventDefault(); disengageFollowAircraft(); const delta = e.deltaY > 0 ? 0.9 : 1.1; const rect = canvas.getBoundingClientRect(); const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
        const newScale = Math.min(Math.max(0.06, mapScale * delta), 400);  // way out for a synoptic/whole-basin view, way in to individual track samples
        mapOffsetX = mouseX - (mouseX - mapOffsetX) * (newScale / mapScale); mapOffsetY = mouseY - (mouseY - mapOffsetY) * (newScale / mapScale);
        mapScale = newScale; bgNeedsUpdate = true; if (filteredData.length > 0) renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
    }, { passive: false });
