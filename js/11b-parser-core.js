/* Mission Visualizer, pure parser core (no DOM, no globals written)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Everything in this file is a pure function of its inputs, so the SAME code runs in three places:
   the page (js/12-file-parsing.js), the parse worker (js/parse-worker.js via importScripts), and
   the node test runner (tests/run-tests.js). Keep it free of document/window references. */

    function timeToSeconds(timeStr) {
        if (!timeStr) return 0;
        let cleanStr = String(timeStr).replace(/[^0-9]/g, '');
        if (cleanStr.length === 4) cleanStr = cleanStr + "00";
        if (cleanStr.length < 6) cleanStr = cleanStr.padStart(6, '0');
        return parseInt(cleanStr.slice(0,2))*3600 + parseInt(cleanStr.slice(2,4))*60 + parseInt(cleanStr.slice(4,6));
    }

    function toHHMMSS(secs) {
        let secNum = parseInt(secs, 10);
        let h = Math.floor(secNum / 3600), m = Math.floor((secNum % 3600) / 60), s = secNum % 60;
        return String(h).padStart(2,'0') + String(m).padStart(2,'0') + String(s).padStart(2,'0');
    }

    // AOC flight files are named YYYYMMDD<plane>..., pull the UTC date the same way the loader does.
    function flightDateFromFilename(fName) {
        const match = fName.match(/^(\d{4})(\d{2})(\d{2})([a-zA-Z])(.*)\./i);
        return match ? `${match[1]}-${match[2]}-${match[3]}` : 'Unknown';
    }

    // Convert a NetCDF ArrayBuffer into the same tab-separated text the .txt parser consumes.
    // Shared by the single-file .nc loader, the parse worker, and the multi-flight batch sat-cache.
    // onProgress (optional): called with { phase, ... } as decoding advances, so the loader overlay
    // can show which variable is being processed. no-op for the tests, batch, and main thread callers.
    function ncArrayBufferToTsv(data, onProgress) {
        const report = (typeof onProgress === 'function') ? onProgress : function () {};
        const nc = new netcdfjs(data);
        const varNames = nc.variables.map(v => v.name); const varsData = {}; let numRows = 0;
        report({ phase: 'open', total: varNames.length });

        varNames.forEach((name, vi) => {
            report({ phase: 'var', name: name, index: vi + 1, total: varNames.length });
            let rawData = nc.getDataVariable(name); let variableDef = nc.variables.find(v => v.name === name);
            let scaleFactor = 1, addOffset = 0, fillValues = [];
            if (variableDef && variableDef.attributes) {
                variableDef.attributes.forEach(a => {
                    const lowerName = a.name.toLowerCase(); const val = Array.isArray(a.value) ? a.value[0] : a.value;
                    if (lowerName === 'scale_factor') scaleFactor = val; if (lowerName === 'add_offset') addOffset = val;
                    if (lowerName === '_fillvalue' || lowerName === 'missing_value') { if (Array.isArray(a.value)) fillValues.push(...a.value); else fillValues.push(a.value); }
                });
            }
            let unpacked = new Array(rawData.length);
            for(let k = 0; k < rawData.length; k++) { let rawVal = rawData[k]; if (fillValues.some(fv => Math.abs(fv - rawVal) < 0.0001)) { unpacked[k] = -9999; } else { unpacked[k] = (rawVal * scaleFactor) + addOffset; } }
            varsData[name] = unpacked; if (varsData[name].length > numRows) numRows = varsData[name].length;
        });

        let startSecs = -1, endSecs = -1;
        if (nc.globalAttributes) { nc.globalAttributes.forEach(attr => { if (attr.name === 'TimeInterval' && typeof attr.value === 'string') { const m = attr.value.match(/(\d{2}):(\d{2}):(\d{2})-(\d{2}):(\d{2}):(\d{2})/); if (m) { startSecs = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]); endSecs = parseInt(m[4])*3600 + parseInt(m[5])*60 + parseInt(m[6]); } } }); }
        if (startSecs === -1) { const decoder = new TextDecoder("utf-8"); const rawStr = decoder.decode(data.slice(0, Math.min(data.byteLength, 15000))); const tiMatch = rawStr.match(/TimeInterval.*?(\d{2}):(\d{2}):(\d{2})-(\d{2}):(\d{2}):(\d{2})/i); if (tiMatch) { startSecs = parseInt(tiMatch[1])*3600 + parseInt(tiMatch[2])*60 + parseInt(tiMatch[3]); endSecs = parseInt(tiMatch[4])*3600 + parseInt(tiMatch[5])*60 + parseInt(tiMatch[6]); } }

        let finalVarNames = varNames;
        if (startSecs !== -1 && endSecs !== -1 && numRows > 0) {
            if (endSecs < startSecs) endSecs += 86400;
            let totalDuration = endSecs - startSecs;
            finalVarNames = varNames.filter(n => n.toLowerCase() !== 'time'); finalVarNames.unshift('time');
            let timeArr = new Array(numRows);
            for (let i = 0; i < numRows; i++) {
                let curSecs = startSecs + (i / Math.max(1, numRows - 1)) * totalDuration;
                let h = Math.floor(curSecs / 3600) % 24, m = Math.floor((curSecs % 3600) / 60), s = Math.round(curSecs % 60);
                if (s === 60) { s = 0; m += 1; } if (m === 60) { m = 0; h += 1; }
                timeArr[i] = String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(s).padStart(2, '0');
            }
            varsData['time'] = timeArr;
        }

        report({ phase: 'rows', numRows: numRows });
        let tsvStr = finalVarNames.join('\t') + '\n';
        for (let i = 0; i < numRows; i++) { let row = []; for (let j = 0; j < finalVarNames.length; j++) { let val = varsData[finalVarNames[j]][i]; row.push(val !== undefined && val !== null ? val : ''); } tsvStr += row.join('\t') + '\n'; }
        return tsvStr;
    }

    // Parse + clean an AOC flight-log TSV string into rows, with NO globals/UI side effects.
    // The ONE parser: the live loader, the parse worker, the batch sat-cache, and the tests all run
    // through it, so every consumer derives the same rows, flight extents, and satellite tile IDs.
    //
    // Returns { rows, stats }. `stats` is the honesty ledger: every row the cleaner drops and every
    // value the parser derives (rather than reads) is counted, so the UI can disclose exactly what
    // was done to the data instead of silently modifying the record.
    function parseFlightTextToRows(rawText) {
        const stats = {
            dataLines: 0, parsed: 0, rows: 0, timeSource: null,
            dropped: { shortLine: 0, noTime: 0, badPosition: 0, noSpeed: 0, error: 0, preTakeoff: 0, dupTime: 0, glitch: 0, gapReset: 0, belowMinAlt: 0 },
            derived: { pAltFromPressure: 0, windFromMs: 0, tasFromMs: 0, iasFromMs: 0, radAltFromFeet: 0 }
        };
        const lines = rawText.split('\n');
        if (lines.length < 2) return { rows: [], stats };
        const headers = lines[0].replace(/\r/g, '').split('\t').map(h => h.trim());
        const hMap = {}; headers.forEach((h, idx) => { if (h) hMap[h.toLowerCase()] = idx; });
        const getVal = (row, key) => { let k = key.toLowerCase(); if (hMap[k] !== undefined && row[hMap[k]] !== undefined && row[hMap[k]].trim() !== '') { const val = parseFloat(row[hMap[k]]); if (isNaN(val) || val <= -990) return null; return val; } return null; };

        let timeMax = -1; const tIdx = hMap['time'];
        if (tIdx !== undefined) { for (let i = 1; i < lines.length; i++) { const parts = lines[i].replace(/\r/g, '').split('\t'); if (parts.length > tIdx) { const v = parseFloat(parts[tIdx]); if (!isNaN(v) && v > timeMax) timeMax = v; } } }

        let firstSec = -1; let tempParsedData = [];
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i] || !lines[i].trim()) continue;
            stats.dataLines++;
            const parts = lines[i].replace(/\r/g, '').split('\t');
            if (parts.length < 10) { stats.dropped.shortLine++; continue; }
            try {
                let timeStr = "", timeSrc = null;
                const hhVal = getVal(parts, 'HH'); const mmVal = getVal(parts, 'MM'); const ssVal = getVal(parts, 'SS'); const mdsHour = getVal(parts, 'MDSHOUR.1');
                if (hhVal !== null && mmVal !== null && ssVal !== null) { timeStr = String(Math.floor(hhVal)).padStart(2, '0') + String(Math.floor(mmVal)).padStart(2, '0') + String(Math.floor(ssVal)).padStart(2, '0'); timeSrc = 'HH/MM/SS columns'; }
                else if (mdsHour !== null && mdsHour > 1000) { timeStr = String(Math.floor(mdsHour)).padStart(6, '0'); timeSrc = 'MDSHOUR.1'; }
                else {
                    const timeRaw = getVal(parts, 'time');
                    if (timeRaw !== null) {
                        if (timeMax > 1000000000000) { let d = new Date(timeRaw); let h = d.getUTCHours(); let m = d.getUTCMinutes(); let s = d.getUTCSeconds(); timeStr = String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(s).padStart(2, '0'); timeSrc = 'epoch milliseconds'; }
                        else if (timeMax > 100000000) { let d = new Date(timeRaw * 1000); let h = d.getUTCHours(); let m = d.getUTCMinutes(); let s = d.getUTCSeconds(); timeStr = String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(s).padStart(2, '0'); timeSrc = 'epoch seconds'; }
                        else if (timeMax > 100000) { let h = Math.floor(timeRaw / 10000); let m = Math.floor((timeRaw % 10000) / 100); let s = Math.floor(timeRaw % 100); timeStr = String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(s).padStart(2, '0'); timeSrc = 'HHMMSS numbers'; }
                        else { let secs = timeRaw; if (timeMax <= 24 && timeMax > 0) { secs = timeRaw * 3600; timeSrc = 'fractional hours'; } else if (timeMax > 24 && timeMax <= 1000) { secs = timeRaw * 60; timeSrc = 'minutes since 0Z'; } else { timeSrc = 'seconds since 0Z'; } let h = Math.floor(secs / 3600) % 24; let m = Math.floor((secs % 3600) / 60); let s = Math.floor(secs % 60); timeStr = String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(s).padStart(2, '0'); }
                    } else { stats.dropped.noTime++; continue; }
                }

                let currentSec = timeToSeconds(timeStr); if (firstSec === -1 && currentSec > 0) firstSec = currentSec;
                let absSeconds = currentSec; if (firstSec !== -1 && currentSec < firstSec - 43200) absSeconds += 86400;

                const lat = getVal(parts, 'LATref') ?? getVal(parts, 'LatGPS.1') ?? getVal(parts, 'LatGPS.2') ?? getVal(parts, 'LatGPS.3');
                const lon = getVal(parts, 'LONref') ?? getVal(parts, 'LonGPS.1') ?? getVal(parts, 'LonGPS.2') ?? getVal(parts, 'LonGPS.3');
                if (lat === null || lon === null || (Math.abs(lat) < 0.1 && Math.abs(lon) < 0.1) || lat < -90 || lat > 90 || lon < -180 || lon > 180) { stats.dropped.badPosition++; continue; }

                let rawTas = getVal(parts, 'TAS.d') ?? getVal(parts, 'TASref'); let rawWs = getVal(parts, 'WS.d'); let rawVz = getVal(parts, 'UWZ.d'); let pressureVal = getVal(parts, 'PS.c') ?? getVal(parts, 'PSM.1') ?? getVal(parts, 'PSMref') ?? null;
                let altpa_d = getVal(parts, 'ALTPA.d'); let pAlt = altpa_d !== null ? altpa_d : (pressureVal !== null ? (1 - Math.pow(pressureVal / 1013.25, 0.190284)) * 44307.69 : null);
                if (altpa_d === null && pressureVal !== null) stats.derived.pAltFromPressure++;
                let windSpdKt = getVal(parts, 'WSkt.d') ?? getVal(parts, 'WsIkt.1');
                if (windSpdKt === null && rawWs !== null) { windSpdKt = rawWs * 1.94384; stats.derived.windFromMs++; }
                let tasKt = getVal(parts, 'TASkt.d') ?? getVal(parts, 'TASkt.1');
                if (tasKt === null && rawTas !== null) { tasKt = rawTas * 1.94384; stats.derived.tasFromMs++; }
                let iasKt = getVal(parts, 'IASkt.d') ?? getVal(parts, 'CasADDUkt.1');
                if (iasKt === null && getVal(parts, 'IAS.d') !== null) { iasKt = getVal(parts, 'IAS.d') * 1.94384; stats.derived.iasFromMs++; }
                // Mixing ratio: MR.d is already g/kg; MRkg.d is kg/kg by definition, so the x1000 is
                // a unit identity, not a derivation, and is not counted in the ledger.
                let finalMixRate = getVal(parts, 'MR.d');
                if (finalMixRate === null) { const mrKgKg = getVal(parts, 'MRkg.d'); if (mrKgKg !== null) finalMixRate = mrKgKg * 1000; }
                let radAlt = getVal(parts, 'AltRa.1');
                if (radAlt === null && getVal(parts, 'AltRaft.1') !== null) { radAlt = getVal(parts, 'AltRaft.1') * 0.3048; stats.derived.radAltFromFeet++; }

                if (!stats.timeSource && timeSrc) stats.timeSource = timeSrc;
                stats.parsed++;
                tempParsedData.push({
                    time: timeStr, absSeconds: absSeconds, lat: lat, lon: lon, pressure: pressureVal, pAlt: pAlt,
                    windDir: getVal(parts, 'WD.d') ?? getVal(parts, 'WdI.1') ?? null, windSpd: windSpdKt, tempr: getVal(parts, 'TA.d') ?? getVal(parts, 'TaADDU.1') ?? null, dewpt: getVal(parts, 'TD.c') ?? getVal(parts, 'TDM.1') ?? getVal(parts, 'TDMref') ?? null,
                    sfcPr: getVal(parts, 'PSURF.d') ?? getVal(parts, 'SfmrAP.1') ?? null, driftAngle: getVal(parts, 'DA.d') ?? getVal(parts, 'DAI.1') ?? null, gTrack: getVal(parts, 'TRK.d') ?? getVal(parts, 'TrkI.1') ?? getVal(parts, 'TrkGPS.1') ?? null,
                    th: getVal(parts, 'THDGref') ?? getVal(parts, 'THdgI.1') ?? null, pitch: getVal(parts, 'PITCHref') ?? getVal(parts, 'PitchI.1') ?? null, roll: getVal(parts, 'ROLLref') ?? getVal(parts, 'RollI.1') ?? null,
                    alpha: getVal(parts, 'AA.1') ?? getVal(parts, 'AAref') ?? getVal(parts, 'PDALPHA.1') ?? getVal(parts, 'PDALPHAref') ?? null, beta: getVal(parts, 'SA.1') ?? getVal(parts, 'SAref') ?? getVal(parts, 'PDBETA.1') ?? getVal(parts, 'PDBETAref') ?? null,
                    tas: tasKt, ias: iasKt, gpsAlt: getVal(parts, 'ALTref') ?? getVal(parts, 'AltGPS.1') ?? getVal(parts, 'AltGPS.2') ?? getVal(parts, 'AltGPS.3') ?? getVal(parts, 'AltGPS.4') ?? null, radAlt: radAlt,
                    dValue: getVal(parts, 'DV.d') ?? null, vtWnd: rawVz, mixRate: finalMixRate, thetaE: getVal(parts, 'THETAE.d') ?? null, accZ: getVal(parts, 'ACCZref') ?? getVal(parts, 'AccZI.1') ?? null
                });
            } catch (err) { stats.dropped.error++; continue; }
        }

        if (tempParsedData.length === 0) return { rows: [], stats };
        tempParsedData.sort((a,b) => a.absSeconds - b.absSeconds);
        let cleaned = [];
        // Cleanup drops rows below 20 kt airspeed (ramp idle, normally unused, and it slows playback),
        // rows below 200 ft GPS altitude (ground, taxi, and low approach),
        // rows with NO airspeed reading when the file carries an airspeed channel (unfilled .nc
        // padding; positionless rows are already gone via badPosition above), and erroneous rows
        // (duplicate timestamps, GPS teleports, hour-plus gaps); everything else, including slow
        // taxi above 20 kt, is part of the record. A file with no airspeed channel at all (the
        // archive's decimated fallback track) keeps every row, there is no basis to filter it.
        const hasSpeedChannel = ['tas.d', 'tasref', 'taskt.d', 'taskt.1', 'iaskt.d', 'casaddukt.1', 'ias.d']
            .some(k => hMap[k] !== undefined);
        for (let i = 0; i < tempParsedData.length; i++) {
            let current = tempParsedData[i];
            const spd = current.tas !== null ? current.tas : current.ias;
            if (hasSpeedChannel && spd === null) { stats.dropped.noSpeed++; continue; }
            if (spd !== null && spd < 20) { stats.dropped.preTakeoff++; continue; }
            // Drop anything below 200 ft (60.96 m) GPS altitude; rows with no GPS-altitude channel
            // are kept, there is no basis to judge them.
            if (current.gpsAlt !== null && current.gpsAlt < 60.96) { stats.dropped.belowMinAlt++; continue; }
            if (cleaned.length === 0) { current.computedVsi = 0; cleaned.push(current); continue; }
            let prev = cleaned[cleaned.length - 1]; let dt = current.absSeconds - prev.absSeconds;
            if (dt <= 0) { stats.dropped.dupTime++; continue; }
            if (dt > 3600) { stats.dropped.gapReset += cleaned.length; cleaned = []; current.computedVsi = 0; cleaned.push(current); continue; }

            // Longitude delta the short way round: a dateline crossing (-179.99 -> +179.99)
            // is a 0.02deg step, not a 360deg teleport, without this the glitch filter below
            // silently drops the entire post-crossing half of a Pacific flight.
            let dLonWrap = Math.abs(current.lon - prev.lon); if (dLonWrap > 180) dLonWrap = 360 - dLonWrap;
            let latSpeed = Math.abs(current.lat - prev.lat) / dt; let lonSpeed = dLonWrap / dt;
            if (latSpeed > 0.02 || lonSpeed > 0.02) { stats.dropped.glitch++; continue; }

            if (current.pAlt !== null && prev.pAlt !== null) current.computedVsi = ((current.pAlt - prev.pAlt) / dt);
            else if (current.gpsAlt !== null && prev.gpsAlt !== null) current.computedVsi = ((current.gpsAlt - prev.gpsAlt) / dt);
            else if (current.radAlt !== null && prev.radAlt !== null) current.computedVsi = ((current.radAlt - prev.radAlt) / dt);
            else current.computedVsi = 0;
            cleaned.push(current);
        }
        stats.rows = cleaned.length;
        return { rows: cleaned, stats };
    }

    // QC-Mode parser fork. Where parseFlightTextToRows above CLEANS the record (drops taxi, ground,
    // teleports, gaps) for smooth playback, this keeps EVERY raw sample and every catalog variable,
    // then indexes them onto a continuous 1-second axis so any missing second becomes an explicit
    // gap (a NaN run). No value is filtered or derived here; that is the whole point of QC Mode.
    //
    // Returns { timeAxis, raw, t0, t1, present, dropped } where:
    //   timeAxis  Float64Array of seconds, continuous t0..t1 step 1 (may roll past 86400 across UTC midnight)
    //   raw       { 'PSM.1': Float32Array, ... } one array per catalog var present, NaN where no sample
    //   t0,t1     first/last second on the axis
    //   present   { varName: sampleCount } how many real (non-NaN) samples each var carried
    //   dropped   { noTime } rows that could not be placed for lack of a time
    function parseFlightRawQC(rawText, keepVars) {
        const keep = keepVars || (typeof qcCatalogVars === 'function' ? qcCatalogVars() : null);
        const lines = rawText.split('\n');
        const out = { timeAxis: new Float64Array(0), raw: {}, t0: null, t1: null, present: {}, dropped: { noTime: 0 } };
        if (lines.length < 2) return out;
        const headers = lines[0].replace(/\r/g, '').split('\t').map(h => h.trim());
        const hMap = {}; headers.forEach((h, idx) => { if (h) hMap[h.toLowerCase()] = idx; });
        const getVal = (row, key) => { const k = key.toLowerCase(); const i = hMap[k]; if (i !== undefined && row[i] !== undefined && row[i].trim() !== '') { const v = parseFloat(row[i]); if (isNaN(v) || v <= -990) return null; return v; } return null; };

        // same time-max probe the cleaner uses, to pick the right epoch/HHMMSS interpretation
        let timeMax = -1; const tIdx = hMap['time'];
        if (tIdx !== undefined) { for (let i = 1; i < lines.length; i++) { const parts = lines[i].replace(/\r/g, '').split('\t'); if (parts.length > tIdx) { const v = parseFloat(parts[tIdx]); if (!isNaN(v) && v > timeMax) timeMax = v; } } }

        // first pass: split every row and derive its absolute second (same logic as the cleaner)
        let firstSec = -1; const parsed = [];
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i] || !lines[i].trim()) continue;
            const parts = lines[i].replace(/\r/g, '').split('\t');
            if (parts.length < 2) continue;
            let timeStr = '';
            const hhVal = getVal(parts, 'HH'), mmVal = getVal(parts, 'MM'), ssVal = getVal(parts, 'SS'), mdsHour = getVal(parts, 'MDSHOUR.1');
            if (hhVal !== null && mmVal !== null && ssVal !== null) { timeStr = String(Math.floor(hhVal)).padStart(2,'0') + String(Math.floor(mmVal)).padStart(2,'0') + String(Math.floor(ssVal)).padStart(2,'0'); }
            else if (mdsHour !== null && mdsHour > 1000) { timeStr = String(Math.floor(mdsHour)).padStart(6,'0'); }
            else {
                const timeRaw = getVal(parts, 'time');
                if (timeRaw === null) { out.dropped.noTime++; continue; }
                if (timeMax > 1000000000000) { const d = new Date(timeRaw); timeStr = String(d.getUTCHours()).padStart(2,'0') + String(d.getUTCMinutes()).padStart(2,'0') + String(d.getUTCSeconds()).padStart(2,'0'); }
                else if (timeMax > 100000000) { const d = new Date(timeRaw * 1000); timeStr = String(d.getUTCHours()).padStart(2,'0') + String(d.getUTCMinutes()).padStart(2,'0') + String(d.getUTCSeconds()).padStart(2,'0'); }
                else if (timeMax > 100000) { const h = Math.floor(timeRaw/10000), m = Math.floor((timeRaw%10000)/100), s = Math.floor(timeRaw%100); timeStr = String(h).padStart(2,'0') + String(m).padStart(2,'0') + String(s).padStart(2,'0'); }
                else { let secs = timeRaw; if (timeMax <= 24 && timeMax > 0) secs = timeRaw*3600; else if (timeMax > 24 && timeMax <= 1000) secs = timeRaw*60; const h = Math.floor(secs/3600)%24, m = Math.floor((secs%3600)/60), s = Math.floor(secs%60); timeStr = String(h).padStart(2,'0') + String(m).padStart(2,'0') + String(s).padStart(2,'0'); }
            }
            let cur = timeToSeconds(timeStr); if (firstSec === -1 && cur > 0) firstSec = cur;
            let absSec = cur; if (firstSec !== -1 && cur < firstSec - 43200) absSec += 86400;
            parsed.push({ absSec: absSec, parts: parts });
        }
        if (parsed.length === 0) return out;

        // continuous 1-second axis spanning the flight; any second with no sample stays NaN -> a gap
        let t0 = Infinity, t1 = -Infinity;
        for (const p of parsed) { if (p.absSec < t0) t0 = p.absSec; if (p.absSec > t1) t1 = p.absSec; }
        const n = Math.max(0, Math.round(t1 - t0) + 1);
        const axis = new Float64Array(n);
        for (let i = 0; i < n; i++) axis[i] = t0 + i;

        // allocate one array per catalog var that actually has a column in this file
        const cols = [];
        headers.forEach(h => {
            if (!h) return;
            if (keep && !keep.has(h)) return;               // catalog is the allow-list; skip everything else
            if (h.toLowerCase() === 'time') return;
            const arr = new Float32Array(n); arr.fill(NaN);
            out.raw[h] = arr; out.present[h] = 0;
            cols.push({ name: h, idx: hMap[h.toLowerCase()], arr: arr });
        });

        // place each raw sample on its nearest second. last write wins on a duplicate timestamp.
        for (const p of parsed) {
            const slot = Math.round(p.absSec - t0);
            if (slot < 0 || slot >= n) continue;
            for (const c of cols) {
                const cell = p.parts[c.idx];
                if (cell === undefined || cell.trim() === '') continue;
                const v = parseFloat(cell);
                if (isNaN(v) || v <= -990) continue;
                if (Number.isNaN(c.arr[slot])) out.present[c.name]++;   // count first real sample per second
                c.arr[slot] = v;
            }
        }
        out.timeAxis = axis; out.t0 = t0; out.t1 = t1;
        return out;
    }

    // One human-readable line disclosing what the parser did to the file: how many rows survived,
    // what was filtered and why, and which values are derived rather than measured.
    function summarizeParseStats(stats) {
        const fmt = n => n.toLocaleString('en-US');
        const d = stats.dropped, out = [fmt(stats.rows) + ' samples'];
        const drops = [];
        if (d.preTakeoff) drops.push(fmt(d.preTakeoff) + ' below 20 kt airspeed');
        if (d.belowMinAlt) drops.push(fmt(d.belowMinAlt) + ' below 200 ft GPS altitude');
        if (d.glitch) drops.push(fmt(d.glitch) + ' GPS position glitches');
        if (d.dupTime) drops.push(fmt(d.dupTime) + ' duplicate timestamps');
        if (d.gapReset) drops.push(fmt(d.gapReset) + ' before a data gap over 1 hr');
        if (d.noTime) drops.push(fmt(d.noTime) + ' with no valid time');
        if (d.badPosition) drops.push(fmt(d.badPosition) + ' with no valid position');
        if (d.noSpeed) drops.push(fmt(d.noSpeed) + ' with no airspeed reading');
        if (d.shortLine) drops.push(fmt(d.shortLine) + ' malformed lines');
        if (d.error) drops.push(fmt(d.error) + ' unreadable lines');
        if (drops.length) out.push('filtered out: ' + drops.join(', '));
        const v = stats.derived, der = [];
        if (v.pAltFromPressure) der.push('pressure altitude computed from static pressure (' + fmt(v.pAltFromPressure) + ' rows)');
        if (v.windFromMs) der.push('wind speed converted from m/s');
        if (v.tasFromMs) der.push('TAS converted from m/s');
        if (v.iasFromMs) der.push('IAS converted from m/s');
        if (v.radAltFromFeet) der.push('radar altitude converted from feet');
        if (der.length) out.push('derived: ' + der.join('; '));
        return out.join(' · ');
    }
