/* Mission Visualizer, speed display + master playback loop
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    function updateSpeedDisplay() {
        speedDisplayBtn.innerText = `${speeds[currentSpeedIdx]}x`;
        // the qc timeline's speed button mirrors the same engine state
        const qs = document.getElementById('qcSpeedBtn'); if (qs) qs.textContent = speeds[currentSpeedIdx] + 'x';
        if (videoLoaded && isPlaying) {
            if (speeds[currentSpeedIdx] <= 16) {
                try { video.playbackRate = speeds[currentSpeedIdx]; } catch(e) {}
                if (video.paused) video.play().catch(e=>{});
            } else {
                if (!video.paused) video.pause();
            }
        }
    }

    function masterSyncEngineTick() {
        if (!isPlaying) return;
        const now = performance.now(); 
        const deltaMs = now - lastTickTime; 
        lastTickTime = now;

        if (videoLoaded) {
            if (video.ended) { isPlaying = false; playPauseBtn.innerText = "Play"; syncTelemetryToVideoClock(); return; }
            
            const curSpeed = speeds[currentSpeedIdx];
            if (curSpeed <= 16) {
                if (video.paused && isPlaying) video.play().catch(e => {});
            } else {
                if (!video.paused) video.pause();
                videoPlaybackAccumulator += (deltaMs / 1000) * curSpeed;
                if (videoPlaybackAccumulator > 0.25 || !window.lastVideoSeek) {
                    video.currentTime += videoPlaybackAccumulator;
                    videoPlaybackAccumulator = 0;
                    window.lastVideoSeek = performance.now();
                }
            }

            syncTelemetryToVideoClock(); 
            animationFrameId = requestAnimationFrame(masterSyncEngineTick);
        } else {
            if (deltaMs < 1000) {
                playbackAccumulator += (deltaMs / 1000) * speeds[currentSpeedIdx];
                
                let updatedIdx = false;
                while (true) {
                    if (currentIdx >= filteredData.length - 1) break;
                    let dt = filteredData[currentIdx+1].absSeconds - filteredData[currentIdx].absSeconds || 1;
                    if (playbackAccumulator >= dt) {
                        playbackAccumulator -= dt;
                        currentIdx++;
                        updatedIdx = true;
                    } else {
                        break;
                    }
                }
                
                if (currentIdx >= filteredData.length - 1) { 
                    currentIdx = filteredData.length - 1; 
                    playbackAccumulator = 0;
                    updateVisualComponents(currentIdx); 
                    isPlaying = false; 
                    playPauseBtn.innerText = "Play"; 
                    return; 
                } 
                
                let force8HzUpdate = document.getElementById('toggle8Hz') && document.getElementById('toggle8Hz').checked;
                
                if (updatedIdx) {
                    updateVisualComponents(currentIdx);
                } else if (force8HzUpdate) {
                    updateVisualComponents(currentIdx, true);
                }
            }
            animationFrameId = requestAnimationFrame(masterSyncEngineTick); 
        }
    }
