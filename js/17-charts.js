/* Mission Visualizer, Chart.js layout + per-frame fan-out
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    function createDatasetConfig(metricKey, hidden = false) { 
        const isImp = !document.getElementById('toggleSI').checked;
        const def = METRIC_DEFS[metricKey]; 
        let label = getMetricLabel(metricKey, isImp);
        return { 
            label: label, 
            data: [], 
            borderColor: def.color, 
            borderWidth: 1.5, 
            pointRadius: 0, 
            fill: false, 
            yAxisID: def.yAxisID, 
            hidden: hidden, 
            metricKey: metricKey, 
            spanGaps: false
        }; 
    }

    function getBaseChartOptions(titleText, config = {}) {
        const enforceIntegers = config.enforceIntegers || false; const minRange = config.minRange || 0;
        const limitCallback = (scale) => { if (minRange > 0) { const range = scale.max - scale.min; if (range < minRange) { const mid = (scale.max + scale.min) / 2; scale.max = mid + (minRange / 2); scale.min = mid - (minRange / 2); } } };
        const tickConfig = { color: '#94a3b8', font: { family: "'IBM Plex Mono', monospace", size: 10 } }; if (enforceIntegers) tickConfig.precision = 0; const tickConfigY1 = { color: '#7ad9ff', font: { family: "'IBM Plex Mono', monospace", size: 10 } }; if (enforceIntegers) tickConfigY1.precision = 0;
        return {
            responsive: true, maintainAspectRatio: false, animation: false,
            // tooltips trigger for the nearest sample at the cursor's x, so hovering anywhere
            // near the plot reads values without having to land exactly on the thin line
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            onHover: (e, elements, chart) => {
                if (filteredData.length === 0) return;
                const xAxis = chart.scales.x;
                const xPixel = e.native ? e.native.offsetX : e.offsetX;
                const playheadPx = xAxis.getPixelForValue(currentIdx);
                if (Math.abs(xPixel - playheadPx) < 15) chart.canvas.style.cursor = 'ew-resize';
                else chart.canvas.style.cursor = 'crosshair';
            },
            scales: { x: { grid: { color: 'rgba(226,232,240,0.05)' }, ticks: { color: '#94a3b8', font: { family: "'IBM Plex Mono', monospace", size: 10 }, maxTicksLimit: 8 } }, y: { type: 'linear', position: 'left', display: 'auto', grid: { color: 'rgba(226,232,240,0.07)' }, ticks: tickConfig, title: { display: true, text: titleText, color: '#94a3b8', font: { family: "'Manrope', sans-serif", size: 11, weight: '600' } }, afterDataLimits: limitCallback }, y1: { type: 'linear', position: 'right', display: 'auto', grid: { drawOnChartArea: false }, ticks: tickConfigY1, afterDataLimits: limitCallback } },
            plugins: { tooltip: { callbacks: { afterTitle: (items) => {
                // the tooltip title is the sample's time; add its lat/lon underneath (same hover).
                const d = items.length && filteredData[items[0].dataIndex];
                if (!d || d.lat == null || d.lon == null) return '';
                const ns = d.lat >= 0 ? 'N' : 'S', ew = d.lon >= 0 ? 'E' : 'W';
                return `${Math.abs(d.lat).toFixed(2)}°${ns}, ${Math.abs(d.lon).toFixed(2)}°${ew}`;
            } } }, zoom: { zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }, pan: { enabled: true, mode: 'x' } }, legend: { display: !config.isMaster, labels: { color: '#e2e8f0', font: { size: 10, family: "'IBM Plex Mono', monospace" }, boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: 'rectRounded',
                // Each variable gets a checkbox-style swatch: a filled square in its series color
                // when plotted, an empty outlined square when not, so it reads as clickable either
                // way. Never struck through; deselected text dims to a calm slate instead.
                generateLabels: (chart) => {
                    const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                    // Selected labels sit near-white for the dark panel; in light mode that washes
                    // out on the near-white chart panel, so flip them to a dark ink. Deselected stay
                    // a calm slate in both themes (readable on either panel).
                    const selColor = document.documentElement.dataset.theme === 'light' ? '#1e293b' : '#e2e8f0';
                    items.forEach(it => {
                        const off = it.hidden;
                        it.hidden = false;
                        it.lineWidth = 1.5;
                        // strokeStyle carries the series (line) color from the default builder; fill
                        // the swatch with it when selected, leave it hollow (outline only) when not.
                        if (off) { it.fontColor = '#64748b'; it.fillStyle = 'rgba(0,0,0,0)'; it.strokeStyle = '#64748b'; }
                        else { it.fontColor = selColor; it.fillStyle = it.strokeStyle; }
                    });
                    return items;
                } }, onClick: function(e, legendItem, legend) { const ci = legend.chart; const isVisible = ci.isDatasetVisible(legendItem.datasetIndex); ci.setDatasetVisibility(legendItem.datasetIndex, !isVisible); ci.update('none'); if (ci.canvas.id !== 'parameterChart') buildDropdownMenus(); } } }
        };
    }

    const markerPlugin = { 
        id: 'markerPlugin', 
        afterDraw: (chart) => { 
            if (filteredData.length === 0) return; 
            const ctx = chart.ctx; const xAxis = chart.scales.x; 
            ctx.save(); ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); 
            customMarkers.forEach(marker => { 
                const x = xAxis.getPixelForValue(marker.idx); 
                if (x >= xAxis.left && x <= xAxis.right) { 
                    ctx.strokeStyle = marker.color; ctx.beginPath(); ctx.moveTo(x, chart.chartArea.top); ctx.lineTo(x, chart.chartArea.bottom); ctx.stroke(); 
                } 
            }); 
            if (currentIdx >= 0 && currentIdx < filteredData.length) {
                const px = xAxis.getPixelForValue(currentIdx);
                if (px >= xAxis.left && px <= xAxis.right) {
                    ctx.strokeStyle = '#ffffff'; 
                    ctx.lineWidth = 2;
                    ctx.setLineDash([]);
                    ctx.beginPath(); ctx.moveTo(px, chart.chartArea.top); ctx.lineTo(px, chart.chartArea.bottom); ctx.stroke();
                }
            }
            ctx.restore();
        }
    };

    function buildChartLayout() {
        if (masterChartInstance) masterChartInstance.destroy(); Object.values(customCharts).forEach(c => c.destroy()); customCharts = {};
        const labelsTimeline = filteredData.map(d => `${d.time.slice(0,2)}:${d.time.slice(2,4)}:${d.time.slice(4)}`);
        const isImp = !document.getElementById('toggleSI').checked;

        masterChartInstance = new Chart(document.getElementById('parameterChart').getContext('2d'), { type: 'line', data: { labels: labelsTimeline, datasets: [] }, options: getBaseChartOptions('Master Scale Comparison', { enforceIntegers: false, minRange: 2, isMaster: true }), plugins: [markerPlugin] });
        buildMasterMenu();

        const buildSubChart = (id, keys, title, config) => { 
            const activeKeys = keys.filter(k => availableMetrics.has(k.key));
            const chartCanvas = document.getElementById(id);
            const panel = chartCanvas.closest('.min-h-\\[240px\\]');
            
            if (activeKeys.length === 0) {
                if (panel) panel.style.display = 'none';
                return;
            } else {
                if (panel) panel.style.display = 'flex';
                document.getElementById(`title-${id}`).childNodes[0].nodeValue = title + " ";
            }
            
            const datasets = activeKeys.map(k => {
                const ds = createDatasetConfig(k.key, k.hidden);
                ds.data = filteredData.map(d => getConvertedVal(d[k.key], k.key, isImp));
                return ds;
            });

            customCharts[id] = new Chart(chartCanvas.getContext('2d'), {
                type: 'line',
                data: { labels: labelsTimeline, datasets: datasets },
                options: getBaseChartOptions(title, config),
                plugins: [markerPlugin]
            });
        };
        
        buildSubChart('tempChart', [{key:'tempr'}, {key:'dewpt'}], `Temperature (${isImp ? '°F' : '°C'})`, { enforceIntegers: true, minRange: 5 });
        buildSubChart('navChart', [{key:'driftAngle', hidden:false}, {key:'th', hidden:true}, {key:'gTrack', hidden:true}], 'Angles (Deg)', { enforceIntegers: true, minRange: 10 });
        buildSubChart('attChart', [{key:'pitch'}, {key:'roll'}, {key:'alpha', hidden:true}, {key:'beta', hidden:true}], 'Flow Angles (°)', { enforceIntegers: true, minRange: 5 });
        buildSubChart('altChart', [{key:'pAlt'}, {key:'gpsAlt', hidden:true}, {key:'dValue', hidden:true}, {key:'radAlt', hidden:true}], `Altitude Profile (${isImp ? 'ft' : 'm'})`, { enforceIntegers: true, minRange: 100 });
        buildSubChart('tasChart', [{key:'tas'}, {key:'windSpd'}, {key:'ias'}], 'Speed Profiles (kt)', { enforceIntegers: true, minRange: 20 });
        buildSubChart('vertWindChart', [{key:'vtWnd'}, {key:'accZ', hidden:true}], `Vertical Speeds & Accel (${isImp ? 'mph' : 'm/s'})`, { enforceIntegers: false, minRange: 2 });
        buildSubChart('sfcChart', [{key:'sfcPr'}, {key:'pressure', hidden:true}], 'Pressure Profiles (mb)', { enforceIntegers: false, minRange: 1 });
        buildSubChart('thermoChart', [{key:'thetaE'}, {key:'mixRate', hidden:true}], 'Thermodynamics & Moisture', { enforceIntegers: false, minRange: 2 });
        buildDropdownMenus();
        updateMasterGraphVisibility();
    }

    function buildDropdownMenus() {
        const isImp = !document.getElementById('toggleSI').checked;
        Object.keys(customCharts).forEach(id => {
            const menu = document.getElementById(`menu-${id}`); if(!menu) return; menu.innerHTML = ''; const chart = customCharts[id]; if(!chart) return;
            const activeKeys = chart.data.datasets.map(ds => ds.metricKey);
            
            const unselectAllItem = document.createElement('div'); unselectAllItem.className = 'dropdown-item'; unselectAllItem.style.color = '#ef4444'; unselectAllItem.style.fontWeight = 'bold'; unselectAllItem.innerText = '✕ Unselect All';
            unselectAllItem.onclick = (e) => { e.stopPropagation(); chart.data.datasets = []; chart.update('none'); buildDropdownMenus(); }; menu.appendChild(unselectAllItem);
            const breakHr = document.createElement('div'); breakHr.style.borderTop = '1px solid #20262f'; breakHr.style.margin = '4px 0'; menu.appendChild(breakHr);
            
            Object.keys(METRIC_DEFS).forEach(key => { 
                const isAvail = availableMetrics.has(key);
                const div = document.createElement('div'); 
                div.className = `dropdown-item ${activeKeys.includes(key) ? 'active' : ''}`; 
                div.innerText = getMetricLabel(key, isImp); 
                div.style.color = mutedMetricColor(METRIC_DEFS[key].color);
                if (isAvail) {
                    div.onclick = (e) => { e.stopPropagation(); toggleMetricInSubChart(id, key); }; 
                } else {
                    div.style.opacity = '0.3';
                    div.style.cursor = 'not-allowed';
                }
                menu.appendChild(div); 
            });
        });
    }

    function toggleMetricInSubChart(chartId, metricKey) {
        const isImp = !document.getElementById('toggleSI').checked;
        const chart = customCharts[chartId]; const existIdx = chart.data.datasets.findIndex(ds => ds.metricKey === metricKey);
        if (existIdx > -1) chart.data.datasets.splice(existIdx, 1); 
        else { 
            const newDs = createDatasetConfig(metricKey); 
            newDs.data = filteredData.map(d => getConvertedVal(d[metricKey], metricKey, isImp));
            chart.data.datasets.push(newDs); 
        }
        chart.update('none'); buildDropdownMenus(); 
    }

    let _lastStaticIdx = -1;   // last idx the badges/charts were rendered for
    function updateVisualComponents(idx, skipCharts = false) {
        const currentRow = filteredData[idx]; if (!currentRow) return;

        // the storm badge and chart playheads depend only on idx, so a same-idx refresh
        // (skipCharts=true, from sliding) skips rebuilding them; any idx change or full
        // update (unit toggle, marker add) still redraws everything.
        const skipStatic = skipCharts && idx === _lastStaticIdx;

        if (trackerModeSelect.value === '2d') renderMapEngineFrame(idx, currentRow); else update3DFrame(idx, currentRow);
        if (!isScrubbing) timelineSlider.value = idx; 

        let displayStr = `${currentRow.time.slice(0,2)}:${currentRow.time.slice(2,4)}:${currentRow.time.slice(4)} UTC`;
        if (flightMetaData.date !== 'Unknown') {
            let d = new Date(flightMetaData.date + "T00:00:00Z");
            d.setUTCSeconds(currentRow.absSeconds);
            let yyyy = d.getUTCFullYear(); let mm = String(d.getUTCMonth()+1).padStart(2, '0'); let dd = String(d.getUTCDate()).padStart(2, '0');
            let hh = String(d.getUTCHours()).padStart(2, '0'); let min = String(d.getUTCMinutes()).padStart(2, '0'); let ss = String(d.getUTCSeconds()).padStart(2, '0');
            displayStr = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} UTC`;
        }
        timelineTimeDisplay.innerText = displayStr;
        if (typeof syncMiniPlaybackBar === 'function') syncMiniPlaybackBar();   // mirror into the collapsed-media mini bar

        if (skipStatic) return;
        updateStormTrackBadge();

        if (masterChartInstance) masterChartInstance.draw();
        Object.values(customCharts).forEach(c => {
            if(c) c.draw();
        });
        _lastStaticIdx = idx;
    }
