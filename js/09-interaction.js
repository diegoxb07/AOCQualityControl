/* Mission Visualizer, menus, scrub, keyboard, canvas input
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    function toggleMenu(event, menuId) { 
        event.stopPropagation(); 
        document.querySelectorAll('.dropdown-menu').forEach(m => { 
            if(m.id !== menuId) {
                m.classList.remove('show');
                const card = m.closest('.bg-panel');
                if(card) card.classList.remove('elevated-card');
            } 
        }); 
        
        const menu = document.getElementById(menuId);
        menu.classList.toggle('show'); 
        
        const parentCard = menu.closest('.bg-panel');
        if (parentCard) {
            if (menu.classList.contains('show')) parentCard.classList.add('elevated-card');
            else parentCard.classList.remove('elevated-card');
        }
    }
    
    window.onclick = function(event) { 
        if (!event.target.matches('.add-btn') && !event.target.matches('.dropdown-menu *')) {
            document.querySelectorAll('.dropdown-menu').forEach(menu => { 
                menu.classList.remove('show'); 
                const card = menu.closest('.bg-panel');
                if (card) card.classList.remove('elevated-card');
            }); 
        }
    };

    function resetChartScale(chartId) { const c = (chartId === 'masterChart') ? masterChartInstance : customCharts[chartId]; if (c) { try { c.resetZoom(); } catch(e){} c.draw(); } }

    timelineSlider.addEventListener('mousedown', () => { isScrubbing = true; wasPlayingBeforeScrub = isPlaying; if (isPlaying) { isPlaying = false; if (videoLoaded) video.pause(); } });
    timelineSlider.addEventListener('touchstart', () => { isScrubbing = true; wasPlayingBeforeScrub = isPlaying; if (isPlaying) { isPlaying = false; if (videoLoaded) video.pause(); } }, {passive: true});

    // Only treat a click as a scrub if it lands inside the chart's plotting area.
    // The legend strip above chartArea acts as the per-variable filter toggles, so
    // clicking a variable there must NOT jump the playhead (start a drag).
    const pointInChartPlotArea = (chart, xPixel, yPixel) => {
        const a = chart.chartArea; if (!a) return false;
        return xPixel >= a.left && xPixel <= a.right && yPixel >= a.top && yPixel <= a.bottom;
    };

    window.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'CANVAS') {
            const chart = Chart.getChart(e.target);
            if (chart && chart.scales && chart.scales.x && filteredData.length > 0) {
                const rect = e.target.getBoundingClientRect(); const xPixel = e.clientX - rect.left; const yPixel = e.clientY - rect.top;
                if (!pointInChartPlotArea(chart, xPixel, yPixel)) return;
                isScrubbing = true; activeScrubChart = chart; wasPlayingBeforeScrub = isPlaying; if (isPlaying) { isPlaying = false; if (videoLoaded) video.pause(); }
                let clickedIdx = Math.round(chart.scales.x.getValueForPixel(xPixel)); clickedIdx = Math.max(0, Math.min(filteredData.length - 1, clickedIdx));
                if (clickedIdx !== currentIdx) { currentIdx = clickedIdx; if (videoLoaded) video.currentTime = Math.max(0, filteredData[currentIdx].absSeconds - videoStartSeconds); updateVisualComponents(currentIdx, true); }
            }
        }
    });

    window.addEventListener('touchstart', (e) => {
        if (e.target.tagName === 'CANVAS') {
            const chart = Chart.getChart(e.target);
            if (chart && chart.scales && chart.scales.x && filteredData.length > 0) {
                const rect = e.target.getBoundingClientRect(); const xPixel = e.touches[0].clientX - rect.left; const yPixel = e.touches[0].clientY - rect.top;
                if (!pointInChartPlotArea(chart, xPixel, yPixel)) return;
                isScrubbing = true; activeScrubChart = chart; wasPlayingBeforeScrub = isPlaying; if (isPlaying) { isPlaying = false; if (videoLoaded) video.pause(); }
                let clickedIdx = Math.round(chart.scales.x.getValueForPixel(xPixel)); clickedIdx = Math.max(0, Math.min(filteredData.length - 1, clickedIdx));
                if (clickedIdx !== currentIdx) { currentIdx = clickedIdx; if (videoLoaded) video.currentTime = Math.max(0, filteredData[currentIdx].absSeconds - videoStartSeconds); updateVisualComponents(currentIdx, true); }
            }
        }
    }, {passive: true});

    const handleChartDrag = (clientX) => {
        if (isScrubbing && activeScrubChart && filteredData.length > 0) {
            const rect = activeScrubChart.canvas.getBoundingClientRect(); const xPixel = clientX - rect.left;
            let dragIdx = Math.round(activeScrubChart.scales.x.getValueForPixel(xPixel)); dragIdx = Math.max(0, Math.min(filteredData.length - 1, dragIdx));
            if (dragIdx !== currentIdx) {
                currentIdx = dragIdx;
                if (videoLoaded) {
                    let targetVideoTime = filteredData[currentIdx].absSeconds - videoStartSeconds;
                    if (targetVideoTime < 0) targetVideoTime = 0; if (video.duration && targetVideoTime > video.duration) targetVideoTime = video.duration; video.currentTime = targetVideoTime;
                }
                if (!scrubDebounceTimer) { requestAnimationFrame(() => { updateVisualComponents(currentIdx, true); scrubDebounceTimer = null; }); scrubDebounceTimer = true; }
            }
        }
    };

    window.addEventListener('mousemove', (e) => { if (isScrubbing && activeScrubChart) handleChartDrag(e.clientX); });
    window.addEventListener('touchmove', (e) => { if (isScrubbing && activeScrubChart) handleChartDrag(e.touches[0].clientX); }, {passive: true});

    const commitScrub = () => {
        if(isScrubbing) {
            isScrubbing = false; activeScrubChart = null; clearTimeout(slideSyncTimer);
            if (videoLoaded && filteredData[currentIdx]) {
                let targetVT = Math.max(0, filteredData[currentIdx].absSeconds - videoStartSeconds);
                if (video.duration) targetVT = Math.min(targetVT, video.duration);
                video.currentTime = targetVT;
                if (videoLoaded && ocrAvailable && videoSyncMode.value === 'auto') {
                    clearTimeout(scrubSyncTimeout); scrubSyncTimeout = setTimeout(() => { if (typeof performImmediateOcrLock === 'function') performImmediateOcrLock({ silent: true, gateGapSeconds: 30 }); }, 650);
                }
            }
            if (wasPlayingBeforeScrub) { isPlaying = true; if (videoLoaded && speeds[currentSpeedIdx] <= 16) video.play().catch(e=>{}); lastTickTime = performance.now(); masterSyncEngineTick(); }
            updateVisualComponents(currentIdx, false);
        }
    };
    window.addEventListener('mouseup', commitScrub); window.addEventListener('touchend', commitScrub);

    timelineSlider.addEventListener('input', function(e) {
        if (filteredData.length === 0) return;
        currentIdx = parseInt(e.target.value, 10);
        if (!scrubDebounceTimer) { requestAnimationFrame(() => { updateVisualComponents(currentIdx, true); scrubDebounceTimer = null; }); scrubDebounceTimer = true; }
        if (videoLoaded && filteredData[currentIdx]) { clearTimeout(slideSyncTimer); slideSyncTimer = setTimeout(() => { let targetVT = Math.max(0, filteredData[currentIdx].absSeconds - videoStartSeconds); if (video.duration) targetVT = Math.min(targetVT, video.duration); video.currentTime = targetVT; }, 80); }
    });
    
    let arrowSkipSpeed = 1;
    document.addEventListener('keydown', (e) => {
        if (!filteredData || filteredData.length === 0) return; if (e.target.tagName === 'INPUT' && (e.target.type === 'text' || e.target.type === 'number')) return;
        // Space = play/pause. Skipped when a button/select/checkbox has focus, space already
        // activates those natively and hijacking it would double-fire (a focused range slider is
        // fine though: space is a no-op there, and scrub-then-space is a common flow).
        if (e.code === 'Space' && !/SELECT|BUTTON|TEXTAREA/.test(e.target.tagName)
            && !(e.target.tagName === 'INPUT' && /checkbox|radio/.test(e.target.type))) {
            e.preventDefault(); if (!playPauseBtn.disabled) playPauseBtn.click(); return;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            // the qc app owns arrow scrubbing (js/22 steps the raw-axis playhead); stepping the
            // cleaned-row index here too would fight it and judder a held-key scrub
            if (document.body.classList.contains('qc-app-on')) return;
            // Shift+arrow = jump 10 flight-minutes (same step as the satellite scan buttons).
            if (e.shiftKey) { e.preventDefault(); skipFlightMinutes(e.key === 'ArrowRight' ? 10 : -10); return; }
            e.preventDefault(); if (e.repeat) arrowSkipSpeed = Math.min(arrowSkipSpeed + 1, 50); else arrowSkipSpeed = 1;
            let dir = e.key === 'ArrowRight' ? 1 : -1; let newIdx = currentIdx + (dir * arrowSkipSpeed); newIdx = Math.max(0, Math.min(filteredData.length - 1, newIdx)); 
            if (newIdx !== currentIdx) { currentIdx = newIdx; if (videoLoaded) video.currentTime = Math.max(0, filteredData[currentIdx].absSeconds - videoStartSeconds); updateVisualComponents(currentIdx); }
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
    
    canvas.addEventListener('mouseup', (e) => {
        isDraggingMap = false; if (trackerModeSelect.value === '3d') return;
        const totalDist = Math.sqrt(Math.pow(e.clientX - parseFloat(canvas.dataset.downX || 0), 2) + Math.pow(e.clientY - parseFloat(canvas.dataset.downY || 0), 2));
        if (totalDist < 5) handleTrackerCoordinatesClick(e);
    });

    canvas.addEventListener('mouseleave', () => { isDraggingMap = false; });
    canvas.addEventListener('dblclick', () => { resetMapView(); });
    
    canvas.addEventListener('wheel', (e) => {
        if (trackerModeSelect.value === '3d') return;
        e.preventDefault(); disengageFollowAircraft(); const delta = e.deltaY > 0 ? 0.9 : 1.1; const rect = canvas.getBoundingClientRect(); const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
        const newScale = Math.min(Math.max(0.06, mapScale * delta), 400);  // way out for a synoptic/whole-basin view, way in to individual track samples
        mapOffsetX = mouseX - (mouseX - mapOffsetX) * (newScale / mapScale); mapOffsetY = mouseY - (mouseY - mapOffsetY) * (newScale / mapScale);
        mapScale = newScale; bgNeedsUpdate = true; if (filteredData.length > 0) renderMapEngineFrame(currentIdx, filteredData[currentIdx]);
    }, { passive: false });

    function handleTrackerCoordinatesClick(e) {
        if (filteredData.length === 0) return;
        const rect = canvas.getBoundingClientRect(); const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
        for (let i = 0; i < customMarkers.length; i++) {
            const mIdx = customMarkers[i].idx; const dataPoint = filteredData[mIdx]; if (!dataPoint) continue;
            const markerX = getX(dataPoint.lon) * mapScale + mapOffsetX; const markerY = getY(dataPoint.lat) * mapScale + mapOffsetY;
            // point-analysis module is not shipped in the QC tool; marker clicks are inert without it
            if (Math.sqrt((mouseX - markerX)**2 + (mouseY - markerY)**2) <= 14) { if (typeof processPointAnalysisPlotting === 'function') processPointAnalysisPlotting(dataPoint); break; }
        }
    }
