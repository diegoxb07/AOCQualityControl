/* Mission Visualizer, noaa-recon-api plumbing (shared by the archive browser)
   Part of index.html, split into modules so a failure in one file does not break the others.
   Loaded as a classic (non-module) script; all parts share one global scope, in order.

   The recon archive (js/12b-recon-archive.js) loads missions and best-tracks from the noaa-recon-api.
   This module holds the small shared pieces that talk to that API: the base url + token, the auth
   header helper, the escapeHtml used on API-sourced strings, and the "API offline" health state that
   greys the archive UI when the host is unreachable. When the recon API host moves off joshmurdock.net
   update RECON_API_BASE here and the CSP in index.html (see CLAUDE.md / README). */

    // Escapes a string for safe interpolation into an innerHTML template that also carries real
    // markup (<br>/<b>/<span>), for the handful of badges that mix that markup with text sourced from
    // the noaa-recon-api (storm names), so an unexpected API response can't inject elements into the
    // page. Used by js/12b-recon-archive.js (loads after this file).
    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    // noaa-recon-api base url. Async jobs return a key we poll on, and the archive fetches mission
    // NetCDF + best-track from here.
    const RECON_API_BASE = 'https://joshmurdock.net/api';

    // Public-facing API token for the noaa-recon-api. The API owner issued this specifically to be
    // embedded in this open, client-side tool so archive loading keeps working for everyone with no
    // sign-in. Like a publishable key it is MEANT to be visible in the page source, it is not a secret,
    // and is scoped and revocable by the owner. A user with their own token can override it by setting
    // localStorage 'reconApiToken' (there is deliberately no UI: the default just works for all users).
    const RECON_API_TOKEN = '1zjFKbV0yJGWyX5drvrE5ajBEow_trThEemiRAtLJQo';
    function getReconApiToken() {
        try { return localStorage.getItem('reconApiToken') || RECON_API_TOKEN; }
        catch (_) { return RECON_API_TOKEN; }
    }
    // Merge the Bearer header into any existing fetch init headers, so every recon-api call carries
    // the token. Harmless while the API runs open (the server ignores it); required once the owner
    // turns token auth on. Note: sending Authorization makes these non-simple CORS requests, so the
    // API must allow the header in its CORS policy, which it does since the token is issued for this
    // in-browser use.
    function reconAuthHeaders(extra) {
        const t = getReconApiToken();
        return t ? Object.assign({}, extra, { Authorization: 'Bearer ' + t }) : Object.assign({}, extra || {});
    }

    // --- API health: greys the archive UI when the host is unreachable -------------------------
    let reconApiHealthChecked = false;
    let reconApiHealthOk = true;
    let reconApiHealthReason = '';

    function isReconApiDown() {
        return true; // DEMO: forces the API-offline UI for preview. DELETE THIS LINE to restore.
        return reconApiHealthChecked ? !reconApiHealthOk : false;
    }
    function isReconApiAvailable() {
        return !isReconApiDown();
    }

    function updateReconApiUiState() {
        const reconBtn = document.getElementById('reconLoadBtn');
        const reconMissionSelect = document.getElementById('reconMissionSelect');
        const reconStormSelect = document.getElementById('reconStormSelect');
        const reconYearSelect = document.getElementById('reconYearSelect');
        const uploadZone = document.getElementById('dataDropZone');
        const uploadLabel = document.getElementById('dataDropLabel');
        const uploadApiOfflineToastWrapper = document.getElementById('uploadApiOfflineToastWrapper');
        const apiDown = isReconApiDown();

        if (reconBtn) {
            if (!reconBtn.dataset.defaultTitle) reconBtn.dataset.defaultTitle = reconBtn.title;
            reconBtn.classList.toggle('grayscale', apiDown);
            reconBtn.classList.toggle('opacity-60', apiDown);
            reconBtn.classList.toggle('saturate-0', apiDown);
            reconBtn.classList.toggle('pointer-events-none', apiDown);
            reconBtn.disabled = apiDown || (reconMissionSelect ? !reconMissionSelect.value : false);
            reconBtn.title = apiDown ? 'Archive flight loading is unavailable while the API is offline' : reconBtn.dataset.defaultTitle;
        }
        // The "Load a Mission" header deliberately keeps its accent color and full opacity while
        // the API is down: loading a mission still works fine offline (manual upload and the
        // previously-loaded list), so the header must not read as disabled.
        [reconYearSelect, reconStormSelect, reconMissionSelect].forEach(sel => {
            if (!sel) return;
            // Remember whatever disabled state the cascading Year->Storm->Mission handlers had already
            // set (e.g. Storm/Mission legitimately disabled because no options are loaded yet) so
            // recovery restores that instead of force-enabling an empty select.
            if (apiDown) {
                if (sel.dataset.apiDownForced === undefined) sel.dataset.apiDownForced = sel.disabled ? '0' : '1';
                sel.disabled = true;
            } else if (sel.dataset.apiDownForced === '1') {
                sel.disabled = false;
                delete sel.dataset.apiDownForced;
            } else {
                delete sel.dataset.apiDownForced;
            }
            sel.classList.toggle('grayscale', apiDown);
            sel.classList.toggle('saturate-0', apiDown);
            sel.classList.toggle('opacity-60', apiDown);
        });
        // Grey out the ↓ .nc source link with the rest of the archive block. The offline
        // overlay covering the block is pointer-events-none, so without this the dimmed
        // link would still take clicks through it.
        const srcLink = document.getElementById('reconSourceLink');
        if (srcLink) {
            srcLink.classList.toggle('grayscale', apiDown);
            srcLink.classList.toggle('saturate-0', apiDown);
            srcLink.classList.toggle('opacity-40', apiDown);
            srcLink.classList.toggle('pointer-events-none', apiDown);
        }
        // The static SEB-archive hint invites a search, which is disabled while the API is down;
        // grey its yellow (text and circled ? alike, via the filter) with the rest of the block.
        const sebHint = document.getElementById('sebArchiveHint');
        if (sebHint) {
            sebHint.classList.toggle('grayscale', apiDown);
            sebHint.classList.toggle('saturate-0', apiDown);
            sebHint.classList.toggle('opacity-60', apiDown);
        }
        if (uploadZone) {
            uploadZone.classList.toggle('border-accent', apiDown);
            uploadZone.classList.toggle('border-2', apiDown);
            uploadZone.classList.toggle('bg-accent-soft', apiDown);
            uploadZone.classList.toggle('bg-panel-strip', !apiDown);
            uploadZone.classList.toggle('grayscale-0', apiDown);
            uploadZone.classList.toggle('grayscale', !apiDown);
            uploadZone.classList.toggle('data-drop-emph', apiDown);   // enlarge it while the api is the only way in
        }
        if (uploadLabel) {
            uploadLabel.classList.toggle('text-ink', apiDown);
            uploadLabel.classList.toggle('text-muted', !apiDown);
            uploadLabel.classList.toggle('font-semibold', apiDown);
            uploadLabel.classList.toggle('font-medium', !apiDown);
        }
        if (uploadApiOfflineToastWrapper) {
            uploadApiOfflineToastWrapper.classList.toggle('hidden', !apiDown);
        }
        // the "use manual upload instead" hint sits below the upload button, only while offline
        const manualUploadHint = document.getElementById('manualUploadHint');
        if (manualUploadHint) manualUploadHint.classList.toggle('hidden', !apiDown);
        // when offline, relocate the manual-upload cluster to cover the dead archive pickers (next to the
        // "API Offline" pill) instead of leaving it up in the label row; move it back when online.
        const manualUploadWrap = document.getElementById('manualUploadWrap');
        const loadGroup = document.getElementById('loadFlightDataGroup');
        if (manualUploadWrap && loadGroup && uploadApiOfflineToastWrapper) {
            const target = apiDown ? uploadApiOfflineToastWrapper : loadGroup;
            if (manualUploadWrap.parentElement !== target) {
                manualUploadWrap.style.pointerEvents = apiDown ? 'auto' : '';
                target.appendChild(manualUploadWrap);
            }
        }
        // "API Offline" cover over the season dropdown in the batch load flight data modal
        const preloadApiOfflineToast = document.getElementById('preloadApiOfflineToast');
        if (preloadApiOfflineToast) preloadApiOfflineToast.classList.toggle('hidden', !apiDown);
        // "Preload selected" only downloads the checked ARCHIVE missions, so it's dead while the API is
        // offline. Disable it then, so users don't click it expecting it to preload their own uploaded
        // files (those go through the modal's file picker, a separate path). Same apiDownForced dance as
        // the selects above, so recovery doesn't stomp a disable runPreload set for its own run.
        const preloadStartBtn = document.getElementById('preloadStartBtn');
        if (preloadStartBtn) {
            if (apiDown) {
                if (preloadStartBtn.dataset.apiDownForced === undefined) preloadStartBtn.dataset.apiDownForced = preloadStartBtn.disabled ? '0' : '1';
                if (!preloadStartBtn.dataset.defaultTitle) preloadStartBtn.dataset.defaultTitle = preloadStartBtn.title || '';
                preloadStartBtn.disabled = true;
                preloadStartBtn.title = 'Archive preloading is unavailable while the API is offline. Uploaded files still preload from the file picker.';
            } else {
                if (preloadStartBtn.dataset.apiDownForced === '1') preloadStartBtn.disabled = false;
                delete preloadStartBtn.dataset.apiDownForced;
                preloadStartBtn.title = preloadStartBtn.dataset.defaultTitle || '';
            }
        }
    }

    function setReconApiHealth(healthy, reason) {
        reconApiHealthChecked = true;
        reconApiHealthOk = !!healthy;
        reconApiHealthReason = reason || '';
        updateReconApiUiState();
    }

    // Archive-side health probe: a lightweight /v1/recon/years poll that flips the "API Offline" state,
    // greying or restoring the archive UI. populateReconYears() in js/12b sets the initial state (it
    // already fetches years); this interval keeps a mid-session outage or recovery reflected.
    function probeReconApiHealth() {
        fetch(RECON_API_BASE + '/v1/recon/years', { cache: 'no-store', headers: reconAuthHeaders() })
            .then(r => setReconApiHealth(r.ok, r.ok ? 'ok' : ('HTTP ' + r.status)))
            .catch(e => setReconApiHealth(false, String(e)));
    }
    setInterval(() => { if (document.visibilityState === 'visible') probeReconApiHealth(); }, 60000);
