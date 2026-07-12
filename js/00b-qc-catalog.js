/* QC Mode, sensor catalog (the allow-list + families)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   This is the data model for QC Mode. Every variable the qc_plots_with_map_v2.py script plots
   is listed here, grouped into families of redundant members with their chosen reference and the
   difference pairs the script draws. The catalog IS the allow-list: any file variable not named
   here (voltages, board/status channels, GPS housekeeping) is skipped and never plotted.

   Members are split by airframe. The python script branches on mission_file[8]: H or I is a P-3
   (NOAA42 / NOAA43, keyed 'HI' here since they share a member set), N is the G-IV (NOAA49). Names
   are the raw NetCDF variable names, verbatim from the script's qcfile.variables[...] calls.
   Suffixes: .d derived, .c corrected, ref = the sensor chosen to best represent the group. */

    // resolve an airframe letter to its member-list key. H and I share the P-3 catalog.
    function qcAirframeKey(aircraft) { return aircraft === 'N' ? 'N' : 'HI'; }

    const QC_CATALOG = {
        // panel order mirrors the script's column(...) call: acceleration, altitude, velocity,
        // position, pressure, air data, attitude, temperature, moisture/wind, sfmr, derived.
        families: [
            // --- acceleration (m/s^2) ---
            { key: 'accx', label: 'X Acceleration', unit: 'm/s²',
              members: { HI: ['AccAXI.1','AccAXI.2','AccXI-GPS.1','AccXI-GPS.2'], N: ['AccAXI.1','AccAXI.2','AccAXI.3'] },
              diffs: { HI: [['AccAXI.1','AccAXI.2'],['AccXI-GPS.1','AccXI-GPS.2']], N: [['AccAXI.1','AccAXI.2'],['AccAXI.1','AccAXI.3']] } },
            { key: 'accy', label: 'Y Acceleration', unit: 'm/s²',
              members: { HI: ['AccAYI.1','AccAYI.2','AccYI-GPS.1','AccYI-GPS.2'], N: ['AccAYI.1','AccAYI.2','AccAYI.3'] },
              diffs: { HI: [['AccAYI.1','AccAYI.2'],['AccYI-GPS.1','AccYI-GPS.2']], N: [['AccAYI.1','AccAYI.2'],['AccAYI.1','AccAYI.3']] } },
            { key: 'accz', label: 'Z Acceleration', unit: 'm/s²', ref: 'ACCZref',
              members: { HI: ['AccAZI.1','AccAZI.2','AccZI-GPS.1','AccZI-GPS.2','AccZfilterI-GPS.1','AccZfilterI-GPS.2'], N: ['AccAZI.1','AccAZI.2','AccAZI.3','AccZI.1','AccZI.2','AccZI.3'] },
              diffs: { HI: [['AccAZI.1','AccAZI.2'],['AccZI-GPS.1','AccZI-GPS.2'],['AccZfilterI-GPS.1','AccZfilterI-GPS.2']], N: [['AccAZI.1','AccAZI.2'],['AccAZI.1','AccAZI.3'],['AccZI.1','AccZI.2'],['AccZI.1','AccZI.3']] },
              // explicit sensor groups (legend swap chips); families without a groups entry fall
              // back to the direct-vs-GPS name heuristic
              groups: { N: [{ label: 'AccAZI', names: ['AccAZI.1','AccAZI.2','AccAZI.3'] }, { label: 'AccZI', names: ['AccZI.1','AccZI.2','AccZI.3'] }] } },

            // --- altitude (m) ---
            { key: 'altgps', label: 'Pure GPS Altitude', unit: 'm', ref: 'ALTref',
              members: { HI: ['AltGPS.1','AltGPS.2','AltGPS.3','AltGPS.4'], N: ['AltGPS.1','AltGPS.2','AltGPS.3'] },
              diffs: { HI: [['AltGPS.3','AltGPS.1'],['AltGPS.3','AltGPS.2'],['AltGPS.3','AltGPS.4']], N: [['AltGPS.3','AltGPS.1'],['AltGPS.3','AltGPS.2']] } },
            { key: 'altblend', label: 'Blended GPS Altitude', unit: 'm',
              members: { HI: ['AltI-GPS.1','AltI-GPS.2'], N: ['AltI.1','AltI.2','AltI.3'] },
              diffs: { HI: [['AltI-GPS.1','AltI-GPS.2']], N: [['AltI.1','AltI.2'],['AltI.1','AltI.3']] } },
            { key: 'altpabc', label: 'PA and Baro-Corrected PA', unit: 'm',
              members: { HI: ['AltPaADDU.1','AltBCADDU.1'], N: ['AltPaADDU.1','AltBCADDU.1','AltPaADDU.2','AltBCADDU.2'] },
              diffs: { HI: [['AltPaADDU.1','AltBCADDU.1']], N: [['AltBCADDU.1','AltBCADDU.2'],['AltPaADDU.1','AltPaADDU.2']] },
              // pa vs baro-corrected, matching the script's within-kind diffs on the G-IV; the
              // P-3 has one of each, so no swap there
              groups: { N: [{ label: 'AltPaADDU', names: ['AltPaADDU.1','AltPaADDU.2'] }, { label: 'AltBCADDU', names: ['AltBCADDU.1','AltBCADDU.2'] }] } },
            { key: 'altra', label: 'Radar Altitude', unit: 'm',
              members: { HI: ['AltRa.1','AltRa.2','AltRa1.c','AltRa2.c'], N: ['AltRa.1'] },
              diffs: { HI: [['AltRa.1','AltRa.2'],['AltRa1.c','AltRa2.c']], N: [] } },
            { key: 'altsci', label: 'Scientific Derived Pres Alt & Geopotential Alt', unit: 'm',
              members: { HI: ['ALTPA.d','ALTGA.d'], N: ['ALTPA.d','ALTGA.d'] }, diffs: { HI: [], N: [] } },

            // --- velocity (m/s) ---
            { key: 'velx', label: 'East-West Velocity', unit: 'm/s', ref: 'GSXref',
              members: { HI: ['GsXI-GPS.1','GsXI-GPS.2'], N: ['GsXI.1','GsXI.2','GsXI.3','GsXGPS.1','GsXGPS.2'] },
              diffs: { HI: [['GsXI-GPS.1','GsXI-GPS.2']], N: [['GsXI.1','GsXI.2'],['GsXI.1','GsXI.3'],['GsXGPS.1','GsXGPS.2']] } },
            { key: 'vely', label: 'North-South Velocity', unit: 'm/s', ref: 'GSYref',
              members: { HI: ['GsYI-GPS.1','GsYI-GPS.2'], N: ['GsYI.1','GsYI.2','GsYI.3','GsYGPS.1','GsYGPS.2'] },
              diffs: { HI: [['GsYI-GPS.1','GsYI-GPS.2']], N: [['GsYI.1','GsYI.2'],['GsYI.1','GsYI.3'],['GsYGPS.1','GsYGPS.2']] } },
            { key: 'velz', label: 'Vertical Velocity', unit: 'm/s', ref: 'GSZref',
              members: { HI: ['GsZI-GPS.1','GsZI-GPS.2'], N: ['GsZI.1','GsZI.2','GsZI.3','GsZGPS.1','GsZGPS.2'] },
              diffs: { HI: [['GsZI-GPS.1','GsZI-GPS.2']], N: [['GsZI.1','GsZI.2'],['GsZI.1','GsZI.3'],['GsZGPS.1','GsZGPS.2']] } },
            { key: 'gsgps', label: 'Blended Ground Speed (GPS)', unit: 'm/s',
              members: { HI: [], N: ['GsGPS.1','GsGPS.2','GsGPS.3'] },
              diffs: { HI: [], N: [['GsGPS.1','GsGPS.2']] } },

            // --- position (deg). plotted as time series here; the map carries the geometry ---
            { key: 'lat', label: 'Latitude', unit: 'deg', ref: 'LATref',
              members: { HI: ['LatGPS.1','LatGPS.2','LatGPS.3','LatGPS.4','LatI-GPS.1','LatI-GPS.2'], N: ['LatGPS.1','LatGPS.2','LatGPS.3','LatI.1','LatI.2','LatI.3'] },
              diffs: { HI: [], N: [] } },
            { key: 'lon', label: 'Longitude', unit: 'deg', ref: 'LONref',
              members: { HI: ['LonGPS.1','LonGPS.2','LonGPS.3','LonGPS.4','LonI-GPS.1','LonI-GPS.2'], N: ['LonGPS.1','LonGPS.2','LonGPS.3','LonI.1','LonI.2','LonI.3'] },
              diffs: { HI: [], N: [] } },

            // --- pressure (mb) ---
            { key: 'pdalpha', label: 'Attack Differential Pressure', unit: 'mb', ref: 'PDALPHAref',
              members: { HI: ['PDALPHA.1','PDALPHA.2'], N: ['PDALPHA.1','PDALPHA.2'] },
              diffs: { HI: [['PDALPHA.1','PDALPHA.2']], N: [['PDALPHA.1','PDALPHA.2']] } },
            { key: 'pdbeta', label: 'Sideslip Differential Pressure', unit: 'mb', ref: 'PDBETAref',
              members: { HI: ['PDBETA.1','PDBETA.2'], N: ['PDBETA.1','PDBETA.2'] },
              diffs: { HI: [['PDBETA.1','PDBETA.2']], N: [['PDBETA.1','PDBETA.2']] } },
            { key: 'pqalpha', label: 'Attack Dynamic Pressure', unit: 'mb', ref: 'PQALPHAref',
              members: { HI: ['PQALPHA.1'], N: ['PQALPHA.1','PQALPHA.2'] },
              diffs: { HI: [], N: [['PQALPHA.1','PQALPHA.2']] } },
            { key: 'pqbeta', label: 'Sideslip Dynamic Pressure', unit: 'mb', ref: 'PQBETAref',
              members: { HI: ['PQBETA.1'], N: ['PQBETA.1','PQBETA.2'] },
              diffs: { HI: [], N: [['PQBETA.1','PQBETA.2']] } },
            { key: 'pqm', label: 'Dynamic Pressure', unit: 'mb', ref: 'PQMref',
              members: { HI: ['PQM.1','PQM.2','PQM.3','PQM.4','PQ.c'], N: ['PQM.1','PQM.2'] },
              diffs: { HI: [['PQM.3','PQM.1'],['PQM.3','PQM.2'],['PQM.3','PQM.4']], N: [['PQM.1','PQM.2']] } },
            { key: 'psm', label: 'Static Pressure', unit: 'mb', ref: 'PSMref', phaseStat: ['PSM.1','PSM.2'],
              members: { HI: ['PSM.1','PSM.2','PS.c'], N: ['PSM.1','PSM.2','PS.c'] },
              diffs: { HI: [['PSM.1','PSM.2']], N: [['PSM.1','PSM.2']] } },
            { key: 'ptm', label: 'Total Pressure', unit: 'mb',
              members: { HI: ['PTM.1'], N: ['PTM.1'] }, diffs: { HI: [], N: [] } },

            // --- air data (kt / m·s, mixed; overlaid as the script does) ---
            { key: 'airspeed', label: 'Air Speed', unit: 'kt',
              members: { HI: ['CasADDU.1','TasADDU.1','IasADDU.1','IAS.d','TAS.d'], N: ['CasADDU.1','CasADDU.2','TasADDU.1','TasADDU.2','IAS.d','TAS.d'] },
              diffs: { HI: [], N: [['CasADDU.1','CasADDU.2'],['TasADDU.1','TasADDU.2']] },
              // calibrated/indicated speeds vs true airspeed
              groups: { HI: [{ label: 'CAS/IAS', names: ['CasADDU.1','IasADDU.1','IAS.d'] }, { label: 'TAS', names: ['TasADDU.1','TAS.d'] }],
                        N: [{ label: 'CAS/IAS', names: ['CasADDU.1','CasADDU.2','IAS.d'] }, { label: 'TAS', names: ['TasADDU.1','TasADDU.2','TAS.d'] }] } },

            // --- attitude (deg / deg per s) ---
            { key: 'pitch', label: 'Pitch', unit: 'deg', ref: 'PITCHref',
              members: { HI: ['PitchI.1','PitchI.2'], N: ['PitchI.1','PitchI.2','PitchI.3'] },
              diffs: { HI: [['PitchI.1','PitchI.2']], N: [['PitchI.1','PitchI.2'],['PitchI.1','PitchI.3']] } },
            { key: 'pitchrate', label: 'Pitch Rate', unit: 'deg/s',
              members: { HI: ['PitchRateI.1','PitchRateI.2'], N: ['PitchRateI.1','PitchRateI.2','PitchRateI.3'] },
              diffs: { HI: [['PitchRateI.1','PitchRateI.2']], N: [['PitchRateI.1','PitchRateI.2'],['PitchRateI.1','PitchRateI.3']] } },
            { key: 'roll', label: 'Roll', unit: 'deg', ref: 'ROLLref',
              members: { HI: ['RollI.1','RollI.2'], N: ['RollI.1','RollI.2','RollI.3'] },
              diffs: { HI: [['RollI.1','RollI.2']], N: [['RollI.1','RollI.2'],['RollI.1','RollI.3']] } },
            { key: 'rollrate', label: 'Roll Rate', unit: 'deg/s',
              members: { HI: ['RollRateI.1','RollRateI.2'], N: ['RollRateI.1','RollRateI.2','RollRateI.3'] },
              diffs: { HI: [['RollRateI.1','RollRateI.2']], N: [['RollRateI.1','RollRateI.2'],['RollRateI.1','RollRateI.3']] } },

            // --- temperature & moisture (degC / % ) ---
            { key: 'ttm', label: 'Measured Total Temperature', unit: '°C', ref: 'TTMref',
              members: { HI: ['TTM.1','TTM.2','TA.d'], N: ['TTM.1','TTM.2','TTM.3','TTM.4','TA.d'] },
              diffs: { HI: [['TTM.1','TTM.2']], N: [['TTM.1','TTM.2'],['TTM.1','TTM.3'],['TTM.1','TTM.4']] } },
            { key: 'radiometer', label: 'Radiometer', unit: '°C', p3only: true,
              members: { HI: ['TRadD.1','TRadS.1','TRadU.1'], N: [] }, diffs: { HI: [], N: [] } },
            { key: 'dewpoint', label: 'Dewpoint Temperature', unit: '°C', ref: 'TDMref',
              members: { HI: ['TDM.1','TDM.2','TDM.3','TD.c'], N: ['TDM.1','TDM.2','TD.c'] },
              diffs: { HI: [['TDM.2','TDM.1'],['TDM.2','TDM.3']], N: [['TDM.2','TDM.1']] } },
            { key: 'vertwind', label: 'Vertical Winds', unit: 'm/s', flightMean: 'UWZ.d',
              members: { HI: ['UWZ.d','DPJ_WSZ'], N: ['UWZ.d','DPJ_WSZ'] }, diffs: { HI: [], N: [] } },
            { key: 'humidity', label: 'Humidity', unit: '%',
              members: { HI: ['HUM_REL.d'], N: ['HUM_REL.d'] }, diffs: { HI: [], N: [] } },
            { key: 'windspeed', label: 'Flight Level Wind Speed', unit: 'm/s',
              members: { HI: ['WS.d'], N: ['WS.d'] }, diffs: { HI: [], N: [] } },
            { key: 'winddir', label: 'Flight Level Wind Direction', unit: 'deg',
              members: { HI: ['WD.d'], N: ['WD.d'] }, diffs: { HI: [], N: [] } },

            // --- SFMR (P-3 only) ---
            { key: 'sfmrws', label: 'SFMR Windspeed', unit: 'm/s', p3only: true,
              members: { HI: ['SfmrWS.1','ASfmrWS.1'], N: [] }, diffs: { HI: [['ASfmrWS.1','SfmrWS.1']], N: [] } },
            { key: 'sfmrrr', label: 'SFMR Rainrate', unit: 'mm/hr', p3only: true,
              members: { HI: ['SfmrRainRate.1','ASfmrRainRate.1'], N: [] }, diffs: { HI: [['ASfmrRainRate.1','SfmrRainRate.1']], N: [] } },
            { key: 'sfmrtb', label: 'AOC SFMR Brightness Temps', unit: 'K', p3only: true,
              members: { HI: ['ASfmrTB.1','ASfmrTB.2','ASfmrTB.3','ASfmrTB.4','ASfmrTB.5','ASfmrTB.6'], N: [] }, diffs: { HI: [], N: [] } },

            // --- derived surface-pressure family (computed by the QC engine, not read) ---
            { key: 'slp', label: 'Standard Surface Pressure vs Willoughby SLP', unit: 'mb', derived: true,
              members: { HI: ['DrWslp31','DrWslp348','slps','PSURF.d'], N: ['DrWslp31','DrWslp348','slps','PSURF.d'] }, diffs: { HI: [], N: [] } }
        ],

        // the derived channels the engine synthesizes (see js/21-qc-engine.js). they are members of
        // the 'slp' family above but never exist in the file, so they are flagged DERIVED not NO DATA.
        derivedVars: ['DrWslp31','DrWslp348','slps'],
        // raw inputs the derived formulas read
        derivedInputs: ['ALTPA.d','ALTGA.d','TVIRT.d','PS.c','PSURF.d'],

        suffixMeaning: { '.d': 'derived', '.c': 'corrected', 'ref': 'chosen reference' }
    };

    // every raw variable this catalog can plot for a given airframe, plus refs and the derived
    // inputs. used by the parser fork as the keep-list, and by the engine/report as the universe.
    // aircraft omitted -> the union across both airframes (the parser worker does not know the
    // airframe yet, so it keeps the union and the engine narrows it later).
    function qcCatalogVars(aircraft) {
        const keys = aircraft ? [qcAirframeKey(aircraft)] : ['HI', 'N'];
        const set = new Set();
        QC_CATALOG.families.forEach(fam => {
            keys.forEach(k => (fam.members[k] || []).forEach(v => { if (!QC_CATALOG.derivedVars.includes(v)) set.add(v); }));
            if (fam.ref) set.add(fam.ref);
        });
        QC_CATALOG.derivedInputs.forEach(v => set.add(v));
        // Time is always needed to build the axis
        set.add('Time');
        return set;
    }

    // expose to the parse worker (which importScripts this file). in a worker `self` is the global;
    // on the page these are already globals, so the assignment is a harmless no-op guard.
    if (typeof self !== 'undefined' && typeof window === 'undefined') {
        self.QC_CATALOG = QC_CATALOG; self.qcCatalogVars = qcCatalogVars; self.qcAirframeKey = qcAirframeKey;
    }

    // the full list of members (raw names) that make up a family's main panel for an airframe,
    // reference appended last so it overlays on top like the script draws it.
    function qcFamilyMembers(fam, aircraft) {
        const k = qcAirframeKey(aircraft);
        const list = (fam.members[k] || []).slice();
        if (fam.ref) list.push(fam.ref);
        return list;
    }

    function qcFamilyDiffs(fam, aircraft) { return fam.diffs[qcAirframeKey(aircraft)] || []; }

    // families visible for an airframe: skip p3-only families on the G-IV, and skip families with
    // no members for this airframe at all.
    function qcFamiliesFor(aircraft) {
        const k = qcAirframeKey(aircraft);
        return QC_CATALOG.families.filter(fam => {
            if (fam.p3only && k === 'N') return false;
            return (fam.members[k] && fam.members[k].length) || fam.derived;
        });
    }
