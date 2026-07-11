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

    // presence: 'nodata' if the channel is entirely absent, 'gap' if it has holes, 'ok' if full.
    function qcPresence(v) {
        let n = 0; for (let i = 0; i < v.length; i++) if (!Number.isNaN(v[i])) n++;
        return n === 0 ? 'nodata' : n < v.length ? 'gap' : 'ok';
    }

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

    // three-phase statistics. takeoff = the pre-takeoff/climb ground samples [0, toIdx) (matches the
    // script's 1..i static-pressure window); mid = +/-300 s around the in-air midpoint; landing = the
    // last ~600 s before touchdown [landIdx-600, landIdx] (matches the script's last-600-points window).
    function qcPhaseStats(v, toIdx, landIdx, midIdx) {
        const slice = (a, b) => v.slice(Math.max(0, a), Math.min(v.length, b));
        return {
            takeoff: qcStat(slice(0, toIdx > 0 ? toIdx : Math.min(v.length, 600))),
            mid: qcStat(slice(midIdx - 300, midIdx + 300)),
            landing: qcStat(slice(landIdx - 600, landIdx + 1))
        };
    }

    // difference series between two redundant members, with its whole-flight mean (the script's
    // "Avg Diff" that rides in each difference plot's title).
    function qcDiff(a, b) {
        const n = Math.min(a.length, b.length); const d = new Float32Array(n);
        for (let i = 0; i < n; i++) d[i] = a[i] - b[i];
        return { series: d, mean: qcRound(qcMean(d), 5) };
    }

    // isolated discontinuity: one second that jumps far and returns with no sloped transition
    // (2 -> 200 -> 2 is a sensor fault, a ramp is not). the one erroneous-value check that needs
    // no per-regime baseline (see spec: general thresholds are deferred until a flight corpus lands).
    function qcIsolatedSpike(v, i, jump) {
        const a = v[i - 1], b = v[i], c = v[i + 1];
        if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) return false;
        return Math.abs(b - a) > jump && Math.abs(b - c) > jump && Math.sign(b - a) !== Math.sign(c - b);
    }

    // scan a channel for isolated spikes. the jump threshold auto-scales to the channel: it is a
    // large multiple of the channel's typical second-to-second step (median absolute first
    // difference), so it fires the same way on a 1000 mb pressure and a 10 m/s wind without a fixed
    // bound that would misfire across regimes.
    function qcScanSpikes(v) {
        // typical step = median of |v[i]-v[i-1]| over consecutive real samples
        const steps = [];
        for (let i = 1; i < v.length; i++) { const a = v[i - 1], b = v[i]; if (!Number.isNaN(a) && !Number.isNaN(b)) steps.push(Math.abs(b - a)); }
        if (steps.length < 8) return [];
        steps.sort((p, q) => p - q);
        const medStep = steps[steps.length >> 1];
        // guard against a flat channel (medStep ~ 0): fall back to a fraction of the value range
        let range = 0; { let lo = Infinity, hi = -Infinity; for (let i = 0; i < v.length; i++) { const x = v[i]; if (!Number.isNaN(x)) { if (x < lo) lo = x; if (x > hi) hi = x; } } if (hi > lo) range = hi - lo; }
        const jump = Math.max(medStep * 20, range * 0.25, 1e-6);
        const flags = [];
        for (let i = 1; i < v.length - 1; i++) if (qcIsolatedSpike(v, i, jump)) flags.push(i);
        return flags;
    }

    // auto-detect the in-air window. takeoff = first second the aircraft is clearly airborne, landing
    // = last such second. driven by GPS altitude (rises above ground + 60.96 m / 200 ft) with an
    // airspeed fallback. optional overrides let the UI pin exact takeoff/landing seconds.
    function qcDetectPhases(raw, timeAxis, override) {
        const pick = names => { for (const nm of names) if (raw[nm]) return raw[nm]; return null; };
        const alt = pick(['ALTref', 'AltGPS.1', 'AltGPS.3', 'AltGPS.2', 'ALTPA.d']);
        const spd = pick(['TAS.d', 'TasADDU.1', 'CasADDU.1', 'IAS.d']);
        const n = timeAxis.length;
        let toIdx = 0, landIdx = n - 1;

        const secToIdx = sec => { if (sec == null) return null; const i = Math.round(sec - timeAxis[0]); return (i >= 0 && i < n) ? i : null; };
        const ovTo = override && secToIdx(override.takeoffSec);
        const ovLand = override && secToIdx(override.landingSec);

        if (ovTo != null) { toIdx = ovTo; }
        else if (alt) {
            let lo = Infinity; for (let i = 0; i < n; i++) if (!Number.isNaN(alt[i]) && alt[i] < lo) lo = alt[i];
            const thr = (Number.isFinite(lo) ? lo : 0) + 60.96;
            for (let i = 0; i < n; i++) { if (!Number.isNaN(alt[i]) && alt[i] > thr) { toIdx = i; break; } }
        } else if (spd) {
            for (let i = 0; i < n; i++) { if (!Number.isNaN(spd[i]) && spd[i] > 30) { toIdx = i; break; } }
        }

        if (ovLand != null) { landIdx = ovLand; }
        else if (alt) {
            let lo = Infinity; for (let i = 0; i < n; i++) if (!Number.isNaN(alt[i]) && alt[i] < lo) lo = alt[i];
            const thr = (Number.isFinite(lo) ? lo : 0) + 60.96;
            for (let i = n - 1; i >= 0; i--) { if (!Number.isNaN(alt[i]) && alt[i] > thr) { landIdx = i; break; } }
        } else if (spd) {
            for (let i = n - 1; i >= 0; i--) { if (!Number.isNaN(spd[i]) && spd[i] > 30) { landIdx = i; break; } }
        }

        if (landIdx <= toIdx) { toIdx = 0; landIdx = n - 1; }
        const midIdx = Math.floor((toIdx + landIdx) / 2);
        return { toIdx: toIdx, landIdx: landIdx, midIdx: midIdx, takeoffSec: timeAxis[toIdx], landingSec: timeAxis[landIdx], altChannel: alt ? true : false };
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
        if (!stats.length) return { source: null, switched: false, sources: [] };
        const best = stats[0];
        if (best.frac >= 0.995) return { source: best.name, switched: false, sources: [best.name] };
        const parts = stats.filter(s => s.frac >= 0.02).sort((p, q) => p.firstEq - q.firstEq);
        return { source: best.name, switched: parts.length > 1, sources: parts.map(p => p.name) };
    }

    // top-level: turn a parseFlightRawQC result into the full QC report model. `aircraft` is the
    // airframe letter (H/I/N) from the mission id; `override` optionally pins takeoff/landing seconds.
    function computeQCReport(qc, aircraft, override) {
        if (!qc || !qc.timeAxis || qc.timeAxis.length === 0) return null;
        const t = qc.timeAxis, n = t.length, raw = qc.raw;
        const phases = qcDetectPhases(raw, t, override);
        const cov = qcComputeCoverage(raw, n);
        const recordingGaps = qcRecordingGaps(cov.covered, t, cov.firstAny, cov.lastAny);

        // synthesize the derived channels and expose them as if they were raw members of 'slp'
        const derived = qcDerivedSLP(raw, n);
        const rawPlus = Object.assign({}, raw, { DrWslp31: derived.DrWslp31, DrWslp348: derived.DrWslp348, slps: derived.slps });

        const fams = qcFamiliesFor(aircraft);
        const summary = { total: 0, ok: 0, gap: 0, nodata: 0 };
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
                let presence, gaps = [], count = 0, lateStart = null, earlyStop = null;
                if (!arr) { presence = 'nodata'; }
                else {
                    count = qc.present[name] || (function () { let c = 0; for (let i = 0; i < arr.length; i++) if (!Number.isNaN(arr[i])) c++; return c; })();
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
                        // first/last sample vs the recording window (small slack absorbs alignment jitter)
                        let first = -1, lastI = -1;
                        for (let i = 0; i < arr.length; i++) if (!Number.isNaN(arr[i])) { if (first < 0) first = i; lastI = i; }
                        if (first - cov.firstAny > 5) lateStart = { secs: first - cov.firstAny, at: t[first] };
                        if (cov.lastAny - lastI > 5) earlyStop = { secs: cov.lastAny - lastI, at: t[lastI] };
                    }
                }
                summary.total++;
                if (presence === 'ok') summary.ok++;
                else if (presence === 'gap') summary.gap++;
                else summary.nodata++;
                return { name: name, presence: presence, count: count, gaps: gaps, lateStart: lateStart, earlyStop: earlyStop, flags: [], series: arr || null, isRef: name === fam.ref, isDerived: isDerived };
            });

            // redundant-member difference series + mean, and roll each mean into the cross-flight row
            const diffs = qcFamilyDiffs(fam, aircraft).map(([a, b], k) => {
                const av = rawPlus[a], bv = rawPlus[b];
                if (!av || !bv) return { id: a + ' ≠ ' + b, a: a, b: b, series: null, mean: NaN };
                const d = qcDiff(av, bv);
                crossFlightRow[fam.key + '_d' + (k + 1)] = d.mean;
                return { id: a + ' ≠ ' + b, a: a, b: b, series: d.series, mean: d.mean };
            });

            const famOut = { key: fam.key, label: fam.label, unit: fam.unit, ref: fam.ref || null, derived: !!fam.derived, p3only: !!fam.p3only, members: members, diffs: diffs };

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

        return {
            aircraft: aircraft, timeAxis: t, t0: qc.t0, t1: qc.t1, n: n,
            phases: phases, families: families, derived: derived, summary: summary,
            recordingGaps: recordingGaps, crossFlightRow: crossFlightRow
        };
    }
