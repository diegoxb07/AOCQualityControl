/* Mission Visualizer, "Create Your Own Graph" + temp baseline
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order. */

    function toggleMasterMetric(metricKey, isChecked) {
        if (isChecked) {
            const isImp = !document.getElementById('toggleSI').checked; const newDs = createDatasetConfig(metricKey, false); 
            newDs.data = filteredData.map(d => getConvertedVal(d[metricKey], metricKey, isImp));
            masterChartInstance.data.datasets.push(newDs);
        } else {
            const idx = masterChartInstance.data.datasets.findIndex(ds => ds.metricKey === metricKey); 
            if (idx > -1) masterChartInstance.data.datasets.splice(idx, 1);
        }
        updateMasterGraphVisibility(); masterChartInstance.update('none'); buildMasterMenu();
    }

    function mutedMetricColor(hex) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || ''); if (!m) return '#aab4be';
        const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16), mix = 0.42;
        const t = (c, target) => Math.round(c * (1 - mix) + target * mix);
        return `rgb(${t(r, 0xc9)}, ${t(g, 0xd2)}, ${t(b, 0xdc)})`;
    }

    function buildMasterMenu() {
        const menu = document.getElementById('menu-masterChart'); if (!menu) return;
        menu.innerHTML = ''; const isImp = !document.getElementById('toggleSI').checked;
        const activeKeys = masterChartInstance ? masterChartInstance.data.datasets.map(ds => ds.metricKey) : [];

        const clearAllItem = document.createElement('div'); clearAllItem.className = 'dropdown-item'; clearAllItem.style.color = '#ef4444'; clearAllItem.style.fontWeight = 'bold'; clearAllItem.innerText = '✕ Clear All';
        clearAllItem.onclick = (e) => { e.stopPropagation(); if (masterChartInstance) { masterChartInstance.data.datasets = []; masterChartInstance.update('none'); } updateMasterGraphVisibility(); buildMasterMenu(); };
        menu.appendChild(clearAllItem);

        const breakHr = document.createElement('div'); breakHr.style.borderTop = '1px solid #20262f'; breakHr.style.margin = '4px 0'; menu.appendChild(breakHr);

        Object.keys(METRIC_DEFS).forEach(key => {
            const isAvail = availableMetrics.has(key); const div = document.createElement('div');
            div.className = `dropdown-item ${activeKeys.includes(key) ? 'active' : ''}`; div.innerText = getMetricLabel(key, isImp); div.style.color = mutedMetricColor(METRIC_DEFS[key].color);
            if (isAvail) { div.onclick = (e) => { e.stopPropagation(); toggleMasterMetric(key, !activeKeys.includes(key)); }; } 
            else { div.style.opacity = '0.3'; div.style.cursor = 'not-allowed'; }
            menu.appendChild(div);
        });
    }

    function updateMasterGraphVisibility() {
        const wrapper = document.getElementById('masterGraphWrapper'), prompt = document.getElementById('masterCreatePrompt');
        const hasData = masterChartInstance && masterChartInstance.data.datasets.length > 0;
        if (hasData) { wrapper.classList.remove('hidden'); wrapper.classList.add('block'); if (prompt) prompt.classList.add('hidden'); masterChartInstance.resize(); } 
        else { wrapper.classList.remove('block'); wrapper.classList.add('hidden'); if (prompt) prompt.classList.remove('hidden'); }
    }

    // Rolling ±300-sample mean of ambient temp, kept as a sliding-window sum so a long flight
    // doesn't recompute 600 samples per row on every filter change.
    function computeTempBaseline() {
        const n = filteredData.length;
        tempBaseline = new Array(n).fill(null);
        let sum = 0, count = 0;
        const add = i => { const t = filteredData[i].tempr; if (t !== null) { sum += t; count++; } };
        const drop = i => { const t = filteredData[i].tempr; if (t !== null) { sum -= t; count--; } };
        for (let j = 0; j < Math.min(n, 300); j++) add(j);
        for (let i = 0; i < n; i++) {
            tempBaseline[i] = count > 0 ? sum / count : filteredData[i].tempr;
            if (i - 300 >= 0) drop(i - 300);
            if (i + 300 < n) add(i + 300);
        }
    }
