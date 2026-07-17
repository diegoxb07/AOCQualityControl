/* QC Mode, the QC engine (checks + statistics)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   Pure functions over the parsed raw arrays and timeAxis (js/11b-parser-core.js parseFlightRawQC).
   Reproduces the statistics the qc_plots_with_map_v2.py script computed: presence + gaps down to
   one second, takeoff / mid-flight / landing max-mean-median, redundant-member differences with
   their whole-flight mean, the derived pressure-altitude / standard-SLP / Willoughby-SLP block, and
   the whole-flight UWZ mean. Everything here returns plain data the report (js/23) and the charts
   (js/22) consume; nothing touches the DOM. */

    function qcRound(x, n) { if (x === null || x === undefined || Number.isNaN(x)) return NaN; const p = Math.pow(10, n); return Math.round(x * p) / p; }
    function qcMean(arr) { let s = 0, c = 0; for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (!Number.isNaN(v)) { s += v; c++; } } return c ? s / c : NaN; }

    // gaps: runs of missing seconds INSIDE a channel's active window, i.e. holes strictly between its
    // first and last real sample. the lead-in before a sensor comes online and the tail after it stops
    // are not gaps (a sensor that simply starts late is not "missing data"). returns { from, to, secs }.
    function qcGaps(v, t) {
        let a = -1, b = -1;
        for (let i = 0; i < v.length; i++) if (!Number.isNaN(v[i])) { if (a < 0) a = i; b = i; }
        if (a < 0) return [];                          // no data at all -> handled as nodata upstream
        const out = []; let s = -1;
        for (let i = a; i <= b; i++) {
            const bad = Number.isNaN(v[i]);
            if (bad && s < 0) s = i;
            if (!bad && s >= 0) { out.push({ from: t[s], to: t[i - 1], fromIdx: s, toIdx: i - 1, secs: i - s }); s = -1; }
        }
        return out;
    }

    // max / mean / median over the non-NaN values of a slice.
    function qcStat(a) {
        const f = []; for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) f.push(a[i]);
        if (!f.length) return { max: NaN, mean: NaN, median: NaN, n: 0 };
        f.sort((p, q) => p - q);
        const mean = f.reduce((s, x) => s + x, 0) / f.length, mid = f.length >> 1;
        return { max: f[f.length - 1], mean: qcRound(mean, 2), median: f.length % 2 ? f[mid] : (f[mid - 1] + f[mid]) / 2, n: f.length };
    }

    // three-phase statistics. takeoff = [0, toIdx), which after the pre-takeoff trim is exactly
    // the five minutes before takeoff; mid = +/-300 s around the in-air midpoint; landing = the
    // last ~600 s before touchdown [landIdx-600, landIdx] (matches the script's last-600-points window).
    function qcPhaseStats(v, toIdx, landIdx, midIdx) {
        const slice = (a, b) => v.slice(Math.max(0, a), Math.min(v.length, b));
        return {
            takeoff: qcStat(slice(0, toIdx > 0 ? toIdx : Math.min(v.length, 600))),
            mid: qcStat(slice(midIdx - 300, midIdx + 300)),
            landing: qcStat(slice(landIdx - 600, landIdx + 1))
        };
    }

    // difference series between two redundant members, with its whole-flight mean (kept for the
    // cross-flight store, the script's semantics) and the signed value of its largest magnitude
    // difference (shown in the ui as Max Diff: one big spike matters more than the flight average).
    function qcDiff(a, b) {
        const n = Math.min(a.length, b.length); const d = new Float32Array(n);
        let mi = -1, mv = -1;
        for (let i = 0; i < n; i++) { d[i] = a[i] - b[i]; const m = Math.abs(d[i]); if (m === m && m > mv) { mv = m; mi = i; } }
        return { series: d, mean: qcRound(qcMean(d), 5), max: mi >= 0 ? qcRound(d[mi], 5) : NaN };
    }

    // erroneous-value detection ("Check"): physically implausible readings that mean the sensor
    // itself is suspect, prioritized over gaps. flagged seconds merge into regions (anything
    // within 60 s joins the same region) so one event is one mark, not a spray. rules so far:
    //   relative humidity above 200 percent
    //   wind speed or vertical wind changing 100 m/s or more within 15 seconds
    //   vertical wind beyond 40 m/s either way
    function qcDetectChecks(name, arr) {
        if (!arr) return [];
        const hum = /^HUM_REL/.test(name), vw = /^UWZ\.|^DPJ_WSZ/.test(name), ws = /^WS\./.test(name);
        // position sensors (case sensitive on purpose: LATref/LONref stay out, like every ref)
        const geo = /^(Lat|Lon)/.test(name);
        if (!hum && !vw && !ws && !geo) return [];
        // wording matters: the wind rules are about SUDDENNESS (even an eye passage is gradual),
        // the humidity rule is about physical absurdity
        const marks = [];
        if (geo) {
            // a 5 degree move inside 30 minutes is beyond any of these airframes. sliding-window
            // range via monotonic deques, O(n); ranges near 360 are the dateline wrapping on a
            // longitude, not a sensor fault, so those pass.
            const W = 1800, THR = 5;
            const minq = [], maxq = [];
            for (let i = 0; i < arr.length; i++) {
                const v = arr[i]; if (Number.isNaN(v)) continue;
                while (minq.length && arr[minq[minq.length - 1]] >= v) minq.pop(); minq.push(i);
                while (maxq.length && arr[maxq[maxq.length - 1]] <= v) maxq.pop(); maxq.push(i);
                while (minq[0] < i - W) minq.shift();
                while (maxq[0] < i - W) maxq.shift();
                const rng = arr[maxq[0]] - arr[minq[0]];
                if (rng > THR && rng < 350) marks.push({ i: i, reason: 'sudden ' + name + ' change of more than 5 degrees within 30 minutes' });
            }
            if (!marks.length) return [];
        }
        for (let i = 0; i < arr.length; i++) {
            const v = arr[i]; if (Number.isNaN(v)) continue;
            if (hum && v > 200) { marks.push({ i: i, reason: 'impossible ' + name + ' above 200 percent' }); continue; }
            if (vw && Math.abs(v) > 40) { marks.push({ i: i, reason: 'sudden ' + name + ' above 40 m/s detected' }); continue; }
            if (vw || ws) {
                for (let b = 1; b <= 15 && i - b >= 0; b++) {
                    const p = arr[i - b]; if (Number.isNaN(p)) continue;
                    if (Math.abs(v - p) >= 100) { marks.push({ i: i, reason: 'sudden ' + name + ' change of 100 m/s in under 15 seconds' }); break; }
                }
            }
        }
        if (!marks.length) return [];
        const out = []; let s = marks[0].i, e = marks[0].i, reason = marks[0].reason;
        for (let k = 1; k < marks.length; k++) {
            if (marks[k].i - e <= 60) e = marks[k].i;
            else { out.push({ fromIdx: s, toIdx: e, reason: reason }); s = marks[k].i; e = s; reason = marks[k].reason; }
        }
        out.push({ fromIdx: s, toIdx: e, reason: reason });
        return out;
    }

    // auto-detect the in-air window. takeoff = first climb through field elevation + 100 m that
    // KEEPS climbing; landing = last second the altitude is above field + 200 ft. optional
    // overrides let the UI pin exact takeoff/landing seconds.
    //
    // hardened against pre-takeoff sensor noise (a single GPS unit oscillating 0 -> 200+ m -> 0 on
    // the ramp used to fool the old running-min + 45 s rule). four independent defenses:
    //   1. the altitude series is the BLENDED INS-GPS altitude (inertially damped, so it carries
    //      none of the raw-GPS ramp spikes), reduced to the per-second MEDIAN when several units
    //      exist so a spike on one unit is outvoted by the healthy ones;
    //   2. field elevation is the median of the lowest decile of samples (the ground cluster), not
    //      a running/global min that one downward glitch drags low enough to break the bar;
    //   3. a candidate must HOLD above the bar for 90% of the next two minutes, be a real climb
    //      (still >= 60 m higher at the window's end), and STILL be above the bar five minutes on:
    //      an oscillation fails the hold, a lone spike fails both horizons;
    //   4. when an airspeed channel exists, the aircraft must actually be at flying speed just
    //      after the candidate -- altitude climbing while airspeed reads taxi is a sensor problem,
    //      not a takeoff, and the scan continues past it. (airspeed is used here instead of the
    //      x-acceleration burst of the takeoff roll on purpose: sustained speed IS that
    //      acceleration integrated, without the taxi-bump/turbulence spikes raw AccX carries.)
    function qcDetectPhases(raw, timeAxis, override) {
        const n = timeAxis.length;
        const pick = names => { for (const nm of names) if (raw[nm]) return raw[nm]; return null; };
        // composite altitude (defense 1): blended INS-GPS altitude first (AltI-GPS.* on the P-3s,
        // AltI.* on the G-IV), pure GPS units when no blended channel exists, then ALTref (a
        // GPS-derived ref that can switch source), then ALTPA.d (pressure alt, drifts) last resort.
        // whichever family is used, multiple units collapse to their per-second median.
        const unitsOf = names => names.map(nm => raw[nm]).filter(Boolean);
        const blendUnits = unitsOf(['AltI-GPS.1', 'AltI-GPS.2', 'AltI.1', 'AltI.2', 'AltI.3']);
        const gpsUnits = blendUnits.length ? blendUnits : unitsOf(['AltGPS.1', 'AltGPS.2', 'AltGPS.3', 'AltGPS.4']);
        let alt = null;
        if (gpsUnits.length === 1) alt = gpsUnits[0];
        else if (gpsUnits.length > 1) {
            alt = new Float32Array(n);
            const vals = [];
            for (let i = 0; i < n; i++) {
                vals.length = 0;
                for (const u of gpsUnits) { const v = u[i]; if (!Number.isNaN(v)) vals.push(v); }
                if (!vals.length) { alt[i] = NaN; continue; }
                vals.sort((a, b) => a - b);
                alt[i] = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
            }
        } else alt = pick(['ALTref', 'ALTPA.d']);
        const spd = pick(['TAS.d', 'TasADDU.1', 'CasADDU.1', 'IAS.d']);
        let toIdx = 0, landIdx = n - 1;

        const secToIdx = sec => { if (sec == null) return null; const i = Math.round(sec - timeAxis[0]); return (i >= 0 && i < n) ? i : null; };
        const ovTo = override && secToIdx(override.takeoffSec);
        const ovLand = override && secToIdx(override.landingSec);

        // field elevation (defense 2): median of the lowest tenth of finite samples. the ground
        // minutes before takeoff and after landing dominate that low cluster, and a handful of
        // negative glitch samples sit in its tail without moving the median.
        const fieldElev = a => {
            const fin = [];
            for (let i = 0; i < a.length; i++) { const v = a[i]; if (!Number.isNaN(v)) fin.push(v); }
            if (!fin.length) return NaN;
            fin.sort((x, y) => x - y);
            const dec = fin.slice(0, Math.max(1, Math.floor(fin.length / 10)));
            return dec[Math.floor(dec.length / 2)];
        };
        const fld = alt ? fieldElev(alt) : NaN;

        // median airspeed over the three minutes after k, or null when the channel is absent or too
        // patchy to judge. 40 clears any taxi and is well under any climb-out in both unit systems
        // this channel appears in (40 kt, or 40 m/s = 78 kt), so no unit sniffing is needed.
        const flyingAt = k => {
            if (!spd) return null;
            const b = Math.min(n - 1, k + 180), vals = [];
            for (let i = k; i <= b; i++) { const v = spd[i]; if (!Number.isNaN(v)) vals.push(v); }
            if (vals.length < 30) return null;
            vals.sort((x, y) => x - y);
            return vals[Math.floor(vals.length / 2)];
        };

        // defense 3 + 4. the axis is a continuous 1 Hz series (js/11b), so one index == one second.
        const SUSTAIN = 120, HOLD = 0.9, RECHECK = 300, KEEP_CLIMBING = 60;
        const sustainedClimb = (a, rise) => {
            if (Number.isNaN(fld)) return -1;
            const bar = fld + rise;
            for (let i = 0; i < n; i++) {
                const v = a[i]; if (Number.isNaN(v) || v <= bar) continue;
                const end = Math.min(n - 1, i + SUSTAIN);
                let fin = 0, above = 0, last = NaN;
                for (let k = i; k <= end; k++) { const w = a[k]; if (Number.isNaN(w)) continue; fin++; if (w > bar) above++; last = w; }
                if (!fin || above / fin < HOLD) continue;         // oscillated back down: not a takeoff
                if (!(last >= v + KEEP_CLIMBING)) continue;       // held but stopped rising: not a climb-out
                // five-minute horizon: a real departure is far above the field by now
                const rk = Math.min(n - 1, i + RECHECK);
                let rv = NaN;
                for (let k = rk; k >= Math.max(i, rk - 30); k--) { if (!Number.isNaN(a[k])) { rv = a[k]; break; } }
                if (!Number.isNaN(rv) && rv <= bar) continue;
                const ms = flyingAt(i);
                if (ms != null && ms < 40) continue;              // airspeed says taxi: sensor spike, keep scanning
                return i;
            }
            return -1;
        };

        if (ovTo != null) { toIdx = ovTo; }
        else if (alt) {
            let i = sustainedClimb(alt, 100);
            if (i < 0) i = sustainedClimb(alt, 60.96);          // a flight that never gains 100 m
            if (i < 0 && spd) { for (let k = 0; k < n; k++) if (!Number.isNaN(spd[k]) && spd[k] > 30) { i = k; break; } }
            if (i < 0) {                                          // last resort: single crossing of the robust bar
                const thr = (Number.isNaN(fld) ? 0 : fld) + 60.96;
                for (let k = 0; k < n; k++) if (!Number.isNaN(alt[k]) && alt[k] > thr) { i = k; break; }
            }
            if (i >= 0) toIdx = i;
        } else if (spd) {
            for (let i = 0; i < n; i++) { if (!Number.isNaN(spd[i]) && spd[i] > 30) { toIdx = i; break; } }
        }

        if (ovLand != null) { landIdx = ovLand; }
        else if (alt) {
            // same robust field elevation for touchdown, plus a trailing-minute hold so one high
            // glitch during the post-landing taxi can't stretch the flight to it
            const thr = (Number.isNaN(fld) ? 0 : fld) + 60.96;
            for (let i = n - 1; i >= 0; i--) {
                const v = alt[i]; if (Number.isNaN(v) || v <= thr) continue;
                const s = Math.max(0, i - 60);
                let fin = 0, above = 0;
                for (let k = s; k <= i; k++) { const w = alt[k]; if (Number.isNaN(w)) continue; fin++; if (w > thr) above++; }
                if (fin && above / fin >= 0.6) { landIdx = i; break; }
            }
        } else if (spd) {
            for (let i = n - 1; i >= 0; i--) { if (!Number.isNaN(spd[i]) && spd[i] > 30) { landIdx = i; break; } }
        }

        if (landIdx <= toIdx) { toIdx = 0; landIdx = n - 1; }
        const midIdx = Math.floor((toIdx + landIdx) / 2);
        return { toIdx: toIdx, landIdx: landIdx, midIdx: midIdx, takeoffSec: timeAxis[toIdx], landingSec: timeAxis[landIdx] };
    }

    // the derived pressure block, ported verbatim from qc_plots_with_map_v2.py (Dr. Willoughby SLP).
    // inputs are raw channels: ALTPA.d (pa), ALTGA.d (ga, m), TVIRT.d (tv, K), PS.c (pfl, mb).
    // returns { slps, DrWslp31, DrWslp348 } as Float32Arrays aligned to the axis, NaN where inputs miss.
    function qcDerivedSLP(raw, n) {
        const pa = raw['ALTPA.d'], ga = raw['ALTGA.d'], tv = raw['TVIRT.d'], pfl = raw['PS.c'];
        const slps = new Float32Array(n), w31 = new Float32Array(n), w348 = new Float32Array(n);
        slps.fill(NaN); w31.fill(NaN); w348.fill(NaN);
        for (let i = 0; i < n; i++) {
            const PA = pa ? pa[i] : NaN, GA = ga ? ga[i] : NaN, TV = tv ? tv[i] : NaN, PF = pfl ? pfl[i] : NaN;
            if (!Number.isNaN(PA) && !Number.isNaN(GA) && !Number.isNaN(TV) && TV !== 0) {
                const tsa = 288.15 - 0.0065 * PA;          // standard-atmosphere temperature at pa
                const pas = PA - GA * tsa / TV;            // ga in metres here (script divides by 1000 only after)
                slps[i] = 1013.25 * Math.pow(1 - pas / 44331, 5.255883);
            }
            if (!Number.isNaN(PF) && !Number.isNaN(GA) && !Number.isNaN(TV) && TV !== 0) {
                const gakm = GA / 1000;
                w31[i] = PF * Math.pow(304.15 / TV, (34.12 * gakm) / (304.15 - TV));
                w348[i] = PF * Math.pow(307.95 / TV, (34.12 * gakm) / (307.95 - TV));
            }
        }
        return { slps: slps, DrWslp31: w31, DrWslp348: w348 };
    }

    // coverage: which seconds have data on ANY catalog channel. seconds where nothing recorded are
    // the recorder's fault, not any one sensor's, so per-sensor gaps must not be blamed for them.
    function qcComputeCoverage(raw, n) {
        const covered = new Uint8Array(n);
        Object.keys(raw).forEach(name => { const a = raw[name]; for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) covered[i] = 1; });
        let firstAny = -1, lastAny = -1;
        for (let i = 0; i < n; i++) if (covered[i]) { if (firstAny < 0) firstAny = i; lastAny = i; }
        return { covered: covered, firstAny: firstAny, lastAny: lastAny };
    }

    // recording gaps: interior runs where NO channel has data. these are flight-level events (the
    // data system, not a sensor) and are reported once, instead of flagging every sensor.
    function qcRecordingGaps(covered, t, firstAny, lastAny) {
        if (firstAny < 0) return [];
        const out = []; let s = -1;
        for (let i = firstAny; i <= lastAny; i++) {
            const bad = !covered[i];
            if (bad && s < 0) s = i;
            if (!bad && s >= 0) { out.push({ from: t[s], to: t[i - 1], fromIdx: s, toIdx: i - 1, secs: i - s }); s = -1; }
        }
        return out;
    }

    // the script's per-flight stats line, column for column. order, rounding (5 places), the
    // 'nan' spelling, and even the script's quirks are replicated so an exported file continues
    // users' historical N42/N43/N49_Stats.txt seamlessly. known replicated quirks:
    //   both airframes: the column labeled AltGPS.3-2 actually computes AltGPS.3 minus AltGPS.1
    //   G-IV: acczi2 is read from AccZI.3, so both AccZI diff columns compute AccZI.1 minus AccZI.3
    const QC_SCRIPT_PAIRS = {
        HI: [
            ['AccAXI.1','AccAXI.2'],['AccXI-GPS.1','AccXI-GPS.2'],['AccAYI.1','AccAYI.2'],['AccYI-GPS.1','AccYI-GPS.2'],
            ['AccAZI.1','AccAZI.2'],['AccZI-GPS.1','AccZI-GPS.2'],['AccZfilterI-GPS.1','AccZfilterI-GPS.2'],
            ['AltGPS.3','AltGPS.1'],['AltGPS.3','AltGPS.1'],['AltGPS.3','AltGPS.4'],['AltI-GPS.1','AltI-GPS.2'],
            ['AltPaADDU.1','AltBCADDU.1'],['AltRa.1','AltRa.2'],['AltRa1.c','AltRa2.c'],
            ['GsXI-GPS.1','GsXI-GPS.2'],['GsYI-GPS.1','GsYI-GPS.2'],['GsZI-GPS.1','GsZI-GPS.2'],
            ['PDALPHA.1','PDALPHA.2'],['PDBETA.1','PDBETA.2'],
            ['PQM.3','PQM.1'],['PQM.3','PQM.2'],['PQM.3','PQM.4'],['PSM.1','PSM.2'],
            ['PitchI.1','PitchI.2'],['PitchRateI.1','PitchRateI.2'],['RollI.1','RollI.2'],['RollRateI.1','RollRateI.2'],
            ['TTM.1','TTM.2'],['TDM.2','TDM.1'],['TDM.2','TDM.3'],
            ['ASfmrWS.1','SfmrWS.1'],['ASfmrRainRate.1','SfmrRainRate.1']
        ],
        N: [
            ['AccAXI.1','AccAXI.2'],['AccAXI.1','AccAXI.3'],['AccAYI.1','AccAYI.2'],['AccAYI.1','AccAYI.3'],
            ['AccAZI.1','AccAZI.2'],['AccAZI.1','AccAZI.3'],['AccZI.1','AccZI.3'],['AccZI.1','AccZI.3'],
            ['AltGPS.3','AltGPS.1'],['AltGPS.3','AltGPS.1'],['AltI.1','AltI.2'],['AltI.1','AltI.3'],
            ['AltBCADDU.1','AltBCADDU.2'],['AltPaADDU.1','AltPaADDU.2'],
            ['GsXI.1','GsXI.2'],['GsXI.1','GsXI.3'],['GsYI.1','GsYI.2'],['GsYI.1','GsYI.3'],['GsZI.1','GsZI.2'],['GsZI.1','GsZI.3'],
            ['GsXGPS.1','GsXGPS.2'],['GsYGPS.1','GsYGPS.2'],['GsZGPS.1','GsZGPS.2'],['GsGPS.1','GsGPS.2'],
            ['PDALPHA.1','PDALPHA.2'],['PDBETA.1','PDBETA.2'],['PQALPHA.1','PQALPHA.2'],['PQBETA.1','PQBETA.2'],
            ['PQM.1','PQM.2'],['PSM.1','PSM.2'],['CasADDU.1','CasADDU.2'],['TasADDU.1','TasADDU.2'],
            ['PitchI.1','PitchI.2'],['PitchI.1','PitchI.3'],['PitchRateI.1','PitchRateI.2'],['PitchRateI.1','PitchRateI.3'],
            ['RollI.1','RollI.2'],['RollI.1','RollI.3'],['RollRateI.1','RollRateI.2'],['RollRateI.1','RollRateI.3'],
            ['TTM.1','TTM.2'],['TTM.1','TTM.3'],['TTM.1','TTM.4'],['TDM.2','TDM.1']
        ]
    };
    // means run from takeoff to the end of the recording, matching the script's [startdata:] slice
    // (netCDF masked means skip missing samples, so NaNs are skipped here too)
    function qcScriptStatsLine(rawPlus, n, fromIdx, aircraft, missionId) {
        const pairs = aircraft === 'N' ? QC_SCRIPT_PAIRS.N : QC_SCRIPT_PAIRS.HI;
        const start = Math.max(0, fromIdx || 0);
        const vals = pairs.map(pr => {
            const av = rawPlus[pr[0]], bv = rawPlus[pr[1]];
            if (!av || !bv) return 'nan';
            let s = 0, c = 0;
            for (let i = start; i < n; i++) { const d = av[i] - bv[i]; if (d === d) { s += d; c++; } }
            return c ? String(qcRound(s / c, 5)) : 'nan';
        });
        return missionId + ',' + vals.join(',');
    }

    // the header row for the plane-stats CSV: one column per difference, in the same order as
    // qcScriptStatsLine. each value is the flight-average difference (first sensor minus second)
    // over takeoff to landing, so every column is tagged "avg diff" to say what the number is.
    // same-sensor pairs compact to the script's plot notation (AccAXI.1-2); cross-sensor pairs
    // keep both full names (AltPaADDU.1-AltBCADDU.1).
    function qcScriptStatsHeader(aircraft) {
        const pairs = aircraft === 'N' ? QC_SCRIPT_PAIRS.N : QC_SCRIPT_PAIRS.HI;
        const lbl = (a, b) => { const ma = /^(.*)\.(\d+)$/.exec(a), mb = /^(.*)\.(\d+)$/.exec(b); return (ma && mb && ma[1] === mb[1]) ? ma[1] + '.' + ma[2] + '-' + mb[2] : a + '-' + b; };
        return 'Mission,' + pairs.map(pr => lbl(pr[0], pr[1]) + ' avg diff').join(',');
    }

    // which sensor is the ref channel actually carrying? a ref (ALTref, PSMref, ...) duplicates the
    // chosen sensor's values exactly, so equality-matching the series identifies the source. a full
    // match names it; several partial matches mean the operators switched the ref mid-flight.
    function qcMatchRefSource(refArr, candidates) {
        const n = refArr.length;
        let refValid = 0; for (let i = 0; i < n; i++) if (!Number.isNaN(refArr[i])) refValid++;
        if (!refValid || !candidates.length) return null;
        const stats = candidates.map(c => {
            const a = c.series; let both = 0, eq = 0, firstEq = -1;
            for (let i = 0; i < n; i++) {
                const r = refArr[i], v = a[i];
                if (Number.isNaN(r) || Number.isNaN(v)) continue;
                both++;
                const tol = Math.max(1e-9, Math.abs(r) * 1e-6);
                if (Math.abs(r - v) <= tol) { eq++; if (firstEq < 0) firstEq = i; }
            }
            return { name: c.name, both: both, eq: eq, frac: both ? eq / both : 0, firstEq: firstEq };
        }).filter(s => s.eq > 30).sort((p, q) => q.eq - p.eq);
        if (!stats.length) return { source: null, switched: false, sources: [], segments: [] };
        const best = stats[0];

        // per-second attribution: which candidate the ref is riding at each moment, as ordered
        // segments. the running source keeps the tie when several sensors agree, and flickers
        // under 20 s are absorbed so operator switches read clean, not noisy
        const segs = [];
        let cur = null, segStart = -1, lastSeen = -1;
        for (let i = 0; i < n; i++) {
            const r = refArr[i]; if (Number.isNaN(r)) continue;
            const tol = Math.max(1e-9, Math.abs(r) * 1e-6);
            let match = null;
            if (cur) { const v = cur.series[i]; if (!Number.isNaN(v) && Math.abs(r - v) <= tol) match = cur; }
            if (!match) for (let k = 0; k < candidates.length; k++) { const v = candidates[k].series[i]; if (!Number.isNaN(v) && Math.abs(r - v) <= tol) { match = candidates[k]; break; } }
            if (!match) { lastSeen = i; continue; }
            if (!cur || match.name !== cur.name) {
                if (cur) segs.push({ source: cur.name, fromIdx: segStart, toIdx: lastSeen });
                cur = match; segStart = i;
            }
            lastSeen = i;
        }
        if (cur) segs.push({ source: cur.name, fromIdx: segStart, toIdx: lastSeen });
        const merged = [];
        segs.forEach(s => {
            const prev = merged[merged.length - 1];
            if (prev && (s.toIdx - s.fromIdx + 1) < 20) { prev.toIdx = s.toIdx; return; }
            if (prev && prev.source === s.source) { prev.toIdx = s.toIdx; return; }
            merged.push({ source: s.source, fromIdx: s.fromIdx, toIdx: s.toIdx });
        });
        const segSources = []; merged.forEach(s => { if (!segSources.includes(s.source)) segSources.push(s.source); });

        if (best.frac >= 0.995 && merged.length <= 1) return { source: best.name, switched: false, sources: [best.name], segments: merged };
        const parts = stats.filter(s => s.frac >= 0.02).sort((p, q) => p.firstEq - q.firstEq);
        return {
            source: best.name,
            switched: merged.length > 1 || parts.length > 1,
            sources: segSources.length ? segSources : parts.map(p => p.name),
            segments: merged
        };
    }

    // top-level: turn a parseFlightRawQC result into the full QC report model. `aircraft` is the
    // airframe letter (H/I/N) from the mission id; `override` optionally pins takeoff/landing seconds.
    function computeQCReport(qc, aircraft, override) {
        if (!qc || !qc.timeAxis || qc.timeAxis.length === 0) return null;
        let t = qc.timeAxis, raw = qc.raw, present = qc.present;
        let phases = qcDetectPhases(raw, t, override);
        // trim only the recording BEFORE five minutes ahead of takeoff, so it never reaches the
        // graphs, gaps, or stats. the detected takeoff itself is NOT moved: its absolute time is
        // preserved and its index just shifts onto the shorter axis. those five kept minutes
        // before takeoff are exactly the takeoff phase for the stats.
        const trim = Math.max(0, phases.toIdx - 300);
        if (trim > 0) {
            t = Array.prototype.slice.call(t, trim);
            const cutRaw = {};
            Object.keys(raw).forEach(k => { const a = raw[k]; cutRaw[k] = (a && a.subarray) ? a.subarray(trim) : a; });
            raw = cutRaw;
            present = null;   // the stored per-channel counts refer to the untrimmed arrays
            // reindex the already-detected phases onto the trimmed axis; do NOT re-detect (that
            // could drift the takeoff off the real detected moment)
            phases = { toIdx: phases.toIdx - trim, landIdx: phases.landIdx - trim, midIdx: phases.midIdx - trim, takeoffSec: phases.takeoffSec, landingSec: phases.landingSec };
        }
        const n = t.length;
        const cov = qcComputeCoverage(raw, n);
        const recordingGaps = qcRecordingGaps(cov.covered, t, cov.firstAny, cov.lastAny);

        // synthesize the derived channels and expose them as if they were raw members of 'slp'
        const derived = qcDerivedSLP(raw, n);
        const rawPlus = Object.assign({}, raw, { DrWslp31: derived.DrWslp31, DrWslp348: derived.DrWslp348, slps: derived.slps });

        const fams = qcFamiliesFor(aircraft);
        const summary = { total: 0, ok: 0, gap: 0, nodata: 0, check: 0 };
        const crossFlightRow = { aircraft: aircraft, missionId: (flightMetaData && flightMetaData.id) || 'Unknown', date: (flightMetaData && flightMetaData.date) || 'Unknown' };

        const families = fams.map(fam => {
            const memberNames = qcFamilyMembers(fam, aircraft);
            const members = memberNames.map(name => {
                const arr = rawPlus[name];
                const isDerived = QC_CATALOG.derivedVars.includes(name);
                // a raw NaN run counts against THIS sensor for the seconds where other channels were
                // recording (else it is the recorder's gap, reported once at flight level). EVERY
                // such gap counts, one second included, regardless of flight phase. a sensor that
                // came online late or died early is reported as that, not as a gap.
                // derived channels are ordinary members with a "(deriv.)" name suffix in the UI:
                // computed -> ok, inputs absent -> nodata; not gap-scanned (their holes mirror the
                // input sensors' own gaps).
                let presence, gaps = [], count = 0, earlyStop = null;
                if (!arr) { presence = 'nodata'; }
                else {
                    count = (present && present[name]) || (function () { let c = 0; for (let i = 0; i < arr.length; i++) if (!Number.isNaN(arr[i])) c++; return c; })();
                    if (count === 0) presence = 'nodata';
                    else if (isDerived) presence = 'ok';
                    else {
                        qcGaps(arr, t).forEach(g => {
                            let eff = 0; for (let i = g.fromIdx; i <= g.toIdx; i++) if (cov.covered[i]) eff++;
                            if (eff === 0) return;                                     // recorder-level, not this sensor
                            g.effSecs = eff;
                            gaps.push(g);
                        });
                        presence = gaps.length ? 'gap' : 'ok';
                        // last sample vs the recording window (small slack absorbs alignment jitter).
                        // no late start flagging: the recording is trimmed to takeoff minus five
                        // minutes, so a channel absent early is either a gap or a real dropout
                        let lastI = -1;
                        for (let i = 0; i < arr.length; i++) if (!Number.isNaN(arr[i])) lastI = i;
                        if (cov.lastAny - lastI > 5) earlyStop = { secs: cov.lastAny - lastI, at: t[lastI] };
                    }
                }
                // implausible-value regions outrank gaps: a sensor that reads impossible values is
                // not ok even when it never dropped out
                const checks = (arr && !isDerived) ? qcDetectChecks(name, arr) : [];
                if (checks.length && presence !== 'nodata') presence = 'check';
                summary.total++;
                if (presence === 'ok') summary.ok++;
                else if (presence === 'gap') summary.gap++;
                else if (presence === 'check') summary.check++;
                else summary.nodata++;
                return { name: name, presence: presence, count: count, gaps: gaps, earlyStop: earlyStop, checks: checks, flags: [], series: arr || null, isRef: name === fam.ref, isDerived: isDerived };
            });

            // redundant-member difference series + stats, and roll each mean into the cross-flight row
            const diffs = qcFamilyDiffs(fam, aircraft).map(([a, b], k) => {
                const av = rawPlus[a], bv = rawPlus[b];
                if (!av || !bv) return { id: a + ' ≠ ' + b, a: a, b: b, series: null, mean: NaN, max: NaN };
                const d = qcDiff(av, bv);
                crossFlightRow[fam.key + '_d' + (k + 1)] = d.mean;
                return { id: a + ' ≠ ' + b, a: a, b: b, series: d.series, mean: d.mean, max: d.max };
            });

            const famOut = { key: fam.key, label: fam.label, unit: fam.unit, ref: fam.ref || null, derived: !!fam.derived, p3only: !!fam.p3only, members: members, diffs: diffs, groups: (fam.groups && fam.groups[qcAirframeKey(aircraft)]) || null };

            // identify (and watch) the ref channel's source sensor
            if (fam.ref && rawPlus[fam.ref]) {
                famOut.refInfo = qcMatchRefSource(rawPlus[fam.ref], members.filter(m => !m.isRef && !m.isDerived && m.series));
            }

            // family-specific statistics carried in the script's plot titles
            if (fam.phaseStat) {
                famOut.phaseStat = {};
                fam.phaseStat.forEach(nm => { if (rawPlus[nm]) famOut.phaseStat[nm] = qcPhaseStats(rawPlus[nm], phases.toIdx, phases.landIdx, phases.midIdx); });
            }
            if (fam.flightMean && rawPlus[fam.flightMean]) {
                // whole-flight mean over the in-air window (the script's averageuwz, i..arraytotal)
                const arr = rawPlus[fam.flightMean].slice(phases.toIdx, phases.landIdx + 1);
                famOut.flightMean = { var: fam.flightMean, value: qcRound(qcMean(arr), 2) };
                crossFlightRow[fam.key + '_mean'] = famOut.flightMean.value;
            }
            return famOut;
        });

        // the exact stats line the script would have appended to N42/N43/N49_Stats.txt
        crossFlightRow.scriptLine = qcScriptStatsLine(rawPlus, n, phases ? phases.toIdx : 0, aircraft, crossFlightRow.missionId);

        return {
            aircraft: aircraft, timeAxis: t, t0: t[0], t1: qc.t1, n: n,
            phases: phases, families: families, derived: derived, summary: summary,
            recordingGaps: recordingGaps, crossFlightRow: crossFlightRow
        };
    }
