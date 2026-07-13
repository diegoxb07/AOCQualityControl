/* Mission Visualizer, filter window init + video-clock sync
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    function applyFiltersAndInit(shouldPlay = false) {
        isPlaying = false; playPauseBtn.innerText = "Play"; if (animationFrameId) cancelAnimationFrame(animationFrameId);

        const sLim = timeToSeconds(document.getElementById('startTimeInput').value); const eLim = timeToSeconds(document.getElementById('endTimeInput').value); videoStartSeconds = timeToSeconds(document.getElementById('videoStartInput').value);
        // Remember the applied time window so the Play button (which folded in "Apply & Run") can tell
        // whether the manual window was edited since and needs re-applying before playing.
        window._appliedWindow = document.getElementById('startTimeInput').value + '|' + document.getElementById('endTimeInput').value + '|' + document.getElementById('videoStartInput').value;
        filteredData = allParsedData.filter(d => d.absSeconds >= sLim && (d.absSeconds <= eLim || eLim < sLim && d.absSeconds <= eLim + 86400));
        if (filteredData.length === 0) return;

        customMarkers = []; computeTempBaseline(); mapPlaceholder.style.display = 'none';
        ['replayBtn','playPauseBtn','markBtn','clearMarksBtn','timelineSlider','skipBack10Btn','skipFwd10Btn'].forEach(id => document.getElementById(id).disabled = false);
        
        timelineSlider.min = 0; timelineSlider.max = filteredData.length - 1; timelineSlider.value = 0;
        resizeCanvasLayout(); calculateMapScales(); resetMapView(); buildChartLayout();
        
        masterChartInstance.data.datasets = []; buildMasterMenu(); updateMasterGraphVisibility();
        if (trackerModeSelect.value === '3d') build3DScene();
        
        currentIdx = 0; masterChartInstance.update('none');
        hasInitialSyncOccurred = false; clearTimeout(scrubSyncTimeout); lastOcrVideoTime = 0;

        updateSatelliteOptions(); satImageLoaded = false; lastSatFetchTime = ''; bgNeedsUpdate = true;

        if (videoLoaded) { video.pause(); if(speeds[currentSpeedIdx] <= 16) { try { video.playbackRate = speeds[currentSpeedIdx]; } catch(e){} } syncTelemetryToVideoClock(); } 
        else updateVisualComponents(currentIdx);

        if (shouldPlay === true) {
            isPlaying = true; playPauseBtn.innerText = "Pause"; playbackAccumulator = 0; lastTickTime = performance.now(); 
            if (videoSyncMode.value === 'auto' && !hasInitialSyncOccurred) { setTimeout(() => { forceOcrSyncNextTick = true; hasInitialSyncOccurred = true; }, 2000); }
            if (videoLoaded && speeds[currentSpeedIdx] <= 16) video.play().catch(e=>{}); 
            masterSyncEngineTick();
        }
    }

    async function syncTelemetryToVideoClock() {
        if (!videoLoaded || filteredData.length === 0 || isScrubbing) return;
        const mode = videoSyncMode.value, now = performance.now();
        
        if (mode === 'auto' && !isOcrRunning) { if (Math.abs(video.currentTime - lastOcrVideoTime) >= 60) forceOcrSyncNextTick = true; }

        if (mode === 'auto' && ocrAvailable && ocrWorker && !isOcrRunning && forceOcrSyncNextTick && (now - lastOcrTime > 500 || lastOcrTime === 0)) {
            isOcrRunning = true; lastOcrTime = now; refreshSyncingIndicator();
            if (!window.ocrCanvas) { window.ocrCanvas = document.createElement('canvas'); window.ocrCtx = window.ocrCanvas.getContext('2d', { willReadFrequently: true }); }
            
            const vw = video.videoWidth, vh = video.videoHeight;
            if (vw > 0 && vh > 0 && ocrWorker) {
                const scanW = vw, scanH = vh * 0.40;
                window.ocrCanvas.width = scanW; window.ocrCanvas.height = scanH;
                window.ocrCtx.fillStyle = "black"; window.ocrCtx.fillRect(0, 0, scanW, scanH);
                
                window.ocrCtx.drawImage(video, 0, 0, vw, vh * 0.15, 0, 0, scanW, vh * 0.15);
                window.ocrCtx.drawImage(video, 0, vh * 0.75, vw, vh * 0.25, 0, vh * 0.15, scanW, vh * 0.25);
                
                const imgData = window.ocrCtx.getImageData(0, 0, scanW, scanH); const data = imgData.data;
                for(let i = 0; i < data.length; i += 4) { let avg = data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114; data[i] = data[i+1] = data[i+2] = avg; }
                window.ocrCtx.putImageData(imgData, 0, 0);

                try {
                    const { data: { text } } = await ocrWorker.recognize(window.ocrCanvas);
                    let cleanText = text.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Z]/g, '2').replace(/[S]/g, '5').replace(/[,;.]/g, ':');
                    const timeRegex = /([0-2]?\d):([0-5]\d):([0-5]\d)/g;
                    let matches = [...cleanText.matchAll(timeRegex)], timeFoundAndVerified = false, currentVTime = video.currentTime;

                    for (const match of matches) {
                        const h = parseInt(match[1], 10), m = parseInt(match[2], 10), s = parseInt(match[3], 10); let ocrSecs = h * 3600 + m * 60 + s;
                        let minSecs = 0;
                        if (allParsedData.length > 0) {
                            minSecs = allParsedData[0].absSeconds;
                            const maxSecs = allParsedData[allParsedData.length - 1].absSeconds;
                            if (minSecs > 43200 && ocrSecs < 43200 && maxSecs > 86400) ocrSecs += 86400;
                            if (ocrSecs < minSecs - 14400 || ocrSecs > maxSecs + 14400) continue; 
                        }

                        for (let i = 0; i < ocrHistory.length; i++) {
                            const hist = ocrHistory[i], vTimeDelta = currentVTime - hist.vTime, ocrDelta = ocrSecs - hist.ocrSecs;
                            if (vTimeDelta >= 1.0 && Math.abs(ocrDelta - vTimeDelta) <= 1.0) {
                                const dynamicBase = ocrSecs - currentVTime;
                                const timeDiff = Math.abs(dynamicBase - videoStartSeconds);
                                lastOcrVideoTime = currentVTime; 
                                
                                if (timeDiff > 120 || (isManualSyncRequest && timeDiff > 1)) {
                                    videoStartSeconds = dynamicBase;

                                    document.getElementById('videoStartInput').value = toHHMMSS(videoStartSeconds);
                                    flashAutoSyncLabel(); forceOcrSyncNextTick = false; isManualSyncRequest = false; updateEndWindowFromVideo(true); 
                                } else { forceOcrSyncNextTick = false; isManualSyncRequest = false; }
                                
                                timeFoundAndVerified = true; ocrHistory = []; break;
                            }
                        }
                        if (timeFoundAndVerified) break;
                        ocrHistory.push({ vTime: currentVTime, ocrSecs: ocrSecs });
                    }
                    ocrHistory = ocrHistory.filter(h => (currentVTime - h.vTime) <= 10.0);
                } catch(e) { } finally { isOcrRunning = false; }
            } else { isOcrRunning = false; }
        }

        // Keep the non-blocking "Syncing…" badge in step with the hunt state every frame.
        refreshSyncingIndicator();

        const targetSec = videoStartSeconds + video.currentTime;
        // First row at/after the video clock. Binary search (filteredData is time-sorted), this
        // runs every animation frame during video playback so a full-array scan is too slow.
        let lo = 0, hi = filteredData.length - 1, newIdx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (filteredData[mid].absSeconds >= targetSec) { newIdx = mid; hi = mid - 1; } else lo = mid + 1;
        }
        if (newIdx === -1) newIdx = targetSec < filteredData[0].absSeconds ? 0 : filteredData.length - 1;
        
        if (newIdx !== currentIdx) { currentIdx = newIdx; updateVisualComponents(currentIdx); }
    }
