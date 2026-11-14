'use strict';
// Standby UI — vanilla JS, no build step. Talks to the JSON API in server.js.
// 0.3.0: the app does one thing — broadcast a pre-signed Bitcoin
// transaction at release. There is no message delivery any more.
(function () {
  var S = null; // cached state

  function $(id) { return document.getElementById(id); }

  function setMsg(el, text, ok) {
    el.textContent = text;
    // ok is true (fine, default colour), false (red — an error, or
    // nothing will happen), or 'warn' (amber — a warning, e.g. a
    // timelocked dry-run: nothing will land yet, but it is not a
    // failure and the release will retry it).
    el.style.color = ok === false ? '#f87171' : ok === 'warn' ? '#fbbf24' : '';
  }

  async function api(method, path, body) {
    var res = await fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('request failed: ' + res.status));
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  // The check-in status dates: no seconds, e.g. "11/11/2026, 9:00 AM".
  // toLocaleString() includes seconds in this browser, and the
  // check-in rows do not want them.
  function fmtDateShort(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString() + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // Whole days from now until an ISO timestamp, rounded up, never
  // below zero — the countdown on the "Next check-in due" row.
  function daysUntil(iso) {
    if (!iso) return 0;
    return Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 86400000));
  }

  function fmtDays(n) {
    if (n === null || n === undefined) return '—';
    return n + (n === 1 ? ' day' : ' days');
  }

  // Satoshis (a decimal string) -> BTC with up to 8 decimals,
  // trailing zeros trimmed: "100000" -> "0.001", "12500000" ->
  // "0.125". BigInt, so no float ever touches the amount.
  function fmtBtc(satsStr) {
    var sats = BigInt(satsStr || '0');
    var whole = sats / 100000000n;
    var frac = sats % 100000000n;
    if (frac === 0n) return whole.toString();
    return whole.toString() + '.' + frac.toString().padStart(8, '0').replace(/0+$/, '');
  }

  // Satoshis with thousands separators: "100000" -> "100,000".
  function fmtSats(satsStr) {
    return String(satsStr == null ? '0' : satsStr).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // A fee rate in sat/vB, ONE decimal at most, trailing zeros
  // trimmed: 588.235294... -> "588.2", 2.635294... -> "2.6",
  // 1000 -> "1000". One decimal keeps the Fee row short enough to
  // fit on one line on a phone.
  function fmtRate(rate) {
    if (rate === null || rate === undefined || !isFinite(rate)) return '—';
    var r = Math.round(rate * 10) / 10;
    return String(r);
  }

  // The fee verdict (0.7.20, extended 0.7.21 with Critical Risk):
  // is this tx's FIXED fee good enough for a long-term hold?
  // Ryan's ladder, against the 90-day peak (the 90th percentile
  // of block medians over 3 months, served as S.bitcoin.feePeak):
  // Low Risk at 2x the peak, Medium Risk at 1x–2x, High Risk
  // below the peak. 0.7.21 adds the CURRENT check first: a fee
  // below the current economy fee (served as
  // S.bitcoin.currentFees.economyFee) would not confirm within a
  // day right now, so it is Critical Risk whatever the history
  // says. When the economy fee is not supplied the Critical check
  // is skipped and only the historical ladder runs. Mirrors
  // lib/bitcoin.js feeVerdict exactly (the frontend cannot import
  // that module). Returns null when there is no peak or no fee
  // rate, so the caller shows no verdict instead of a wrong one.
  function feeVerdict(rate, peak, economyFee) {
    if (typeof rate !== 'number' || !isFinite(rate) || rate < 0) return null;
    if (typeof peak !== 'number' || !isFinite(peak) || peak <= 0) return null;
    if (typeof economyFee === 'number' && isFinite(economyFee) && economyFee >= 0 && rate < economyFee) return 'Critical Risk';
    if (rate >= 2 * peak) return 'Low Risk';
    if (rate >= peak) return 'Medium Risk';
    return 'High Risk';
  }

  // The pill class for a fee verdict: Low green, Medium amber,
  // High a LIGHTER red (0.7.21), Critical the current red — so
  // the worst level is visibly the deepest red.
  function feeVerdictCls(v) {
    if (v === 'Low Risk') return 'ok';
    if (v === 'Medium Risk') return 'warn';
    if (v === 'High Risk') return 'bad-soft';
    return 'bad';
  }

  // The fee-risk pop-out (0.7.21): the Fee line is clickable and
  // opens the shared showDetails pop-out with HOW the verdict was
  // calculated — the 90-day peak, your fee, the current economy
  // fee, and the reason for the level — so the verdict is
  // explainable, not a black box. The numbers use the app's own
  // one-decimal rate formatting, so they match the Fee line.
  function showFeePopout(tx, verdict) {
    var peak = S.bitcoin.feePeak;
    var econ = S.bitcoin.currentFees && S.bitcoin.currentFees.economyFee;
    var rate = tx.feeRateSatVb;
    var body;
    if (verdict === 'Critical Risk') {
      body = 'Your fee is ' + fmtRate(rate) + ' sat/vB, but the current economy fee is ' + fmtRate(econ) + ' sat/vB — it would not confirm within a day right now. Because it is below the current market fee, it is ranked Critical Risk.';
    } else if (verdict === 'Low Risk') {
      body = 'The 90-day peak is ' + fmtRate(peak) + ' sat/vB. Your fee is ' + fmtRate(rate) + ' sat/vB. Because it is at least 2× the peak (' + fmtRate(2 * peak) + ' sat/vB), it is ranked Low Risk.';
    } else if (verdict === 'Medium Risk') {
      body = 'The 90-day peak is ' + fmtRate(peak) + ' sat/vB. Your fee is ' + fmtRate(rate) + ' sat/vB. Low Risk needs ' + fmtRate(2 * peak) + ' sat/vB (2× the peak). Your fee meets the peak but is below 2× the peak, so it is ranked Medium Risk.';
    } else { // High Risk
      body = 'The 90-day peak is ' + fmtRate(peak) + ' sat/vB. Your fee is ' + fmtRate(rate) + ' sat/vB. Because it is below the peak (' + fmtRate(peak) + ' sat/vB), it is ranked High Risk.';
    }
    var html = '<dl class="kv">'
      + '<dt>90-day peak</dt><dd>' + escapeHtml(fmtRate(peak) + ' sat/vB') + '</dd>'
      + '<dt>Your fee</dt><dd>' + escapeHtml(fmtRate(rate) + ' sat/vB') + '</dd>'
      + ((typeof econ === 'number')
        ? '<dt>Current economy fee</dt><dd>' + escapeHtml(fmtRate(econ) + ' sat/vB') + '</dd>' : '')
      + '</dl>';
    showDetails('Fee risk', body, html);
  }

  // ---------- tabs ----------
  // Each tab is its own subpage: the URL hash names it (#dashboard,
  // #transactions, #settings, #logs), so refreshing the page lands
  // back on the tab you were on instead of the Dashboard, and the
  // browser's Back / Forward steps through tabs. The Transaction(s)
  // tab reads #transactions in the address bar (the internal tab key
  // is still 'bitcoin'; #bitcoin is accepted as an alias).
  var TAB_HASH = { dashboard: 'dashboard', bitcoin: 'transactions', settings: 'settings', logs: 'logs' };
  var HASH_TAB = { dashboard: 'dashboard', transactions: 'bitcoin', bitcoin: 'bitcoin', settings: 'settings', logs: 'logs' };
  var currentTab = 'dashboard';
  function tabFromHash() {
    var h = '';
    try { h = (window.location.hash || '').replace(/^#\/?/, ''); } catch (e) { h = ''; }
    return HASH_TAB[h] || 'dashboard';
  }
  function showTab(name, updateHash) {
    if (!TAB_HASH[name]) name = 'dashboard';
    currentTab = name;
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    document.querySelectorAll('section.tab').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + name); });
    if (updateHash !== false) {
      try {
        var want = '#' + TAB_HASH[name];
        if (window.location.hash !== want) window.location.hash = want;
      } catch (e) { /* no window (tests) — the tab still switches */ }
    }
  }
  document.getElementById('tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    showTab(btn.dataset.tab);
  });
  // Back / Forward (and a pasted link) switch tabs without a reload.
  try {
    window.addEventListener('hashchange', function () {
      var t = tabFromHash();
      if (t !== currentTab) showTab(t, false);
    });
  } catch (e) { /* no window (tests) */ }
  // The first paint is the tab the URL names, not always Dashboard.
  showTab(tabFromHash(), false);

  // ---------- header burger menu ----------
  // Exit App goes back to the Umbrel home screen on the same host,
  // whatever host this app was reached on (umbrel.local, LAN IP, Tailscale).
  // Protocol-relative root of the request host, so it works with no
  // hardcoded address.
  var exitLink = $('exit-app');
  if (exitLink) exitLink.href = '//' + window.location.hostname + '/';
  // The menu also holds the app's main tabs, with Exit App at the
  // bottom — the whole app is reachable from it. Tapping a tab
  // switches to it and closes the menu. The links carry the tab's
  // hash, so they work as plain links too (a long-press copies a
  // link straight to that tab).
  document.querySelectorAll('#burger-menu a[data-tab-link]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var menu = $('burger-menu');
      if (menu) menu.open = false;
      showTab(a.dataset.tabLink);
    });
  });
  // Tapping anywhere outside the open menu closes it.
  document.addEventListener('click', function (e) {
    var menu = $('burger-menu');
    if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
  });

  // ---------- load & render ----------
  async function load() {
    S = await api('GET', '/api/state');
    var status = await api('GET', '/api/status');
    var checkins = await api('GET', '/api/checkins');
    var blog = await api('GET', '/api/broadcast/log');
    try { apiKeys = await api('GET', '/api/checkin-keys'); } catch (e) { apiKeys = []; }
    renderDashboard(status);
    renderLogs(checkins, blog);
    renderBitcoin();
    renderSettings();
    refreshConfirmations(); // fire-and-forget: the sent lines show the last known count, then update
  }

  var PILL_CLASS = {
    'on-track': 'ok', 'release-due': 'bad', 'broadcasted': 'bad',
    'paused': 'warn', 'vacation': 'warn', 'not-started': 'muted',
  };

  function renderDashboard(status) {
    var pill = $('status-pill');
    pill.textContent = status.label;
    pill.className = 'pill ' + (PILL_CLASS[status.state] || 'muted');
    // On track, there is nothing to say below the pill — the line
    // only appears when the state needs explaining (release due,
    // paused, vacation, broadcasted, not started).
    var line = $('status-line');
    line.textContent =
      status.checkinReadError ? 'Warning: the check-in receiver state could not be read — releases are held until it can be read again.'
      : status.state === 'not-started' ? 'No check-in recorded yet. Tap “Check in” to start the clock.'
      : status.state === 'vacation' ? 'Vacation mode is on' + (status.vacationUntil ? ' until ' + status.vacationUntil : '') + '. Releases are held.'
      : status.state === 'paused' ? 'Releases are paused. Check in to resume automatically.'
      : status.state === 'broadcasted' ? 'A broadcast went out. Check in to start a new cycle.'
      : status.state === 'release-due' ? 'Release is due — the stored transaction will be broadcast unless you check in.'
      : '';
    line.style.display = line.textContent ? '' : 'none';
    // The countdown + progress bar (0.7.19): how much of the
    // check-in window is used. The window is the configured
    // threshold (S.settings.thresholdDays) — never a hardcoded
    // number. The bar fills as days elapse; its colour is by how
    // much time is LEFT: green while more than 3/4 of the window
    // remains, amber past that, red in the last quarter. Overdue
    // is a full red bar. With no check-in yet there is no window
    // to measure, so the whole block hides and the status line
    // above the dates explains instead.
    var threshold = S.settings.thresholdDays;
    var showCountdown = !!status.lastCheckinAt && typeof threshold === 'number' && threshold > 0;
    [$('checkin-countdown'), $('checkin-countdown-sub'), $('checkin-progress'), $('checkin-progress-label')].forEach(function (el) {
      el.style.display = showCountdown ? '' : 'none';
    });
    if (showCountdown) {
      var daysSince = status.daysSince || 0;
      var overdue = status.state === 'release-due' || (status.nextDue && new Date(status.nextDue) <= Date.now());
      $('checkin-countdown').textContent = overdue
        ? 'Overdue'
        : fmtDays(daysUntil(status.nextDue)) + ' left';
      var fill = $('checkin-progress-fill');
      fill.style.width = (Math.min(1, Math.max(0, daysSince / threshold)) * 100) + '%';
      var remaining = (threshold - daysSince) / threshold;
      fill.style.background = remaining > 0.75 ? 'var(--ok)' : remaining > 0.25 ? 'var(--warn)' : 'var(--bad)';
      $('checkin-progress-label').textContent = daysSince + ' of ' + threshold + ' days elapsed';
    }
    // Last check-in: the absolute date only. The relative elapsed
    // time is already in the progress-bar caption, so no "Checked
    // in X days ago" line. Next due is the absolute date only —
    // the countdown above carries the day count now.
    var lastEl = $('last-checkin');
    lastEl.textContent = status.lastCheckinAt ? fmtDateShort(status.lastCheckinAt) : '—';
    $('next-due').textContent = status.nextDue ? fmtDateShort(status.nextDue) : '—';
    // The transactions, one row each (0.7.19): the label with its
    // status pill — the same pill the transaction's own card shows
    // ("Ready + armed", "Timelocked + unarmed", ...), via
    // txPillText(tx, txStatus(tx)). Only the active ones: pending
    // and archived transactions live in their own cards and will
    // never broadcast at release, so they are not listed here.
    // (No shared-input pill tweak here — that stays on the tx cards.)
    // (0.7.20) Each row also carries the fee verdict as a second
    // pill next to the status pill ("Ready + armed" + "Medium Risk"),
    // colour-coded like the status pill. No verdict when the fee
    // rate is unknown or the 90-day peak has not been fetched — the
    // row then shows only the status pill.
    var activeTxs = (S.bitcoin.txs || []).filter(function (t) { return !txStatus(t).settled && !txStatus(t).pending; });
    var txsEl = $('readiness-txs');
    txsEl.innerHTML = '';
    if (activeTxs.length) {
      activeTxs.forEach(function (t) {
        var st = txStatus(t);
        var row = document.createElement('div');
        row.className = 'tx-row';
        var label = document.createElement('b');
        label.textContent = t.label || 'Untitled transaction';
        var pill = document.createElement('span');
        pill.className = 'pill ' + st.cls;
        pill.textContent = txPillText(t, st);
        row.appendChild(label);
        row.appendChild(pill);
        var fv = feeVerdict(t.feeRateSatVb, S.bitcoin.feePeak, S.bitcoin.currentFees && S.bitcoin.currentFees.economyFee);
        if (fv) {
          var fpill = document.createElement('span');
          fpill.className = 'pill fee-pill ' + feeVerdictCls(fv);
          fpill.textContent = fv;
          row.appendChild(fpill);
        }
        txsEl.appendChild(row);
      });
    } else {
      txsEl.textContent = (S.bitcoin.txs || []).length
        ? 'No active transactions — every stored transaction is pending or archived'
        : 'No transactions stored (no broadcast at release)';
    }
    // One "Node Status" item, with the Primary and Secondary lines
    // listed below it (each with its own status pill). The status comes
    // from the last connection test — the Test connection button, a
    // check-in, or the hourly check. A result only counts for the
    // endpoint it was measured against: if the settings changed since
    // the test ran, the pill goes back to Not tested.
    var conn = S.bitcoin.connection || {};
    renderNodeStatus('readiness-', 'primary', status.primaryApiUrl, conn);
    renderNodeStatus('readiness-', 'secondary', status.secondaryApiUrl, conn);
    $('readiness-checked').textContent = conn.checkedAt
      ? 'Nodes last checked ' + fmtDate(conn.checkedAt) + '.'
      : '';
  }

  // The Logs tab: the broadcast log and the recent check-ins. They
  // used to live on the Dashboard; they are here now so the Dashboard
  // is only the status and the check-in — one view, no scroll.
  function renderLogs(checkins, blog) {
    var tbody = $('broadcast-log');
    tbody.innerHTML = '';
    if (!blog.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">Nothing logged yet.</td></tr>';
    } else {
      blog.forEach(function (e) {
        var tr = document.createElement('tr');
        tr.className = 'log-row';
        tr.innerHTML = '<td></td><td></td><td></td><td></td>';
        tr.children[0].textContent = fmtDate(e.ts);
        tr.children[1].textContent = e.kind || '';
        tr.children[2].textContent = (e.txid || '').slice(0, 4) + '…';
        tr.children[3].textContent = (e.status || '') + (e.method ? ' (' + e.method + ')' : '');
        tr.title = 'Click for details';
        tr.addEventListener('click', function () { showBroadcastDetails(e); });
        tbody.appendChild(tr);
      });
    }
    var cbody = $('recent-checkins');
    cbody.innerHTML = '';
    if (!checkins.length) {
      cbody.innerHTML = '<tr><td colspan="3" class="muted">None yet.</td></tr>';
    } else {
      checkins.forEach(function (c) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td></td><td></td>';
        tr.children[0].textContent = fmtDate(c.ts);
        tr.children[1].textContent = c.method || 'app';
        tr.children[2].textContent = c.sourceIp || '\u2014';
        cbody.appendChild(tr);
      });
    }
  }

  // A check-in (0.7.20): no success message below the button — the
  // refreshed countdown, progress bar and last-check-in date ARE the
  // confirmation, so the "Checked in just now." line was redundant.
  // A FAILED check-in still reports its error here.
  $('btn-checkin').addEventListener('click', async function () {
    try {
      await api('POST', '/api/checkin', { method: 'app' });
      await load();
      // A check-in also re-tests the nodes, so their status on the
      // Dashboard is fresh when the owner looks at it. Best-effort:
      // the check-in already landed either way.
      try { await api('POST', '/api/bitcoin/connection/test', {}); } catch (e) { /* node test failed; check-in stands */ }
      await load();
    } catch (e) { setMsg($('checkin-msg'), e.message, false); }
  });

  // ---------- bitcoin ----------
  // Pre-signed transactions: a LIST. Each has its OWN enable toggle,
  // its own label + notes, and its own release record. Adding one arms
  // it by default — the toggle unarms it. The dry-run buttons check
  // the inputs are still unspent and NEVER broadcast. Notes say what
  // each tx is for, at a glance, in the list.
  var editingId = null; // id of the tx loaded into the add form, or null
  var dryRunResults = {}; // tx id -> { text, ok, verdict, spent, unknown, error }: the last dry-run result per transaction, shown in its own card. The *line* is page memory only — but a spent verdict is also recorded on the transaction server-side (a stale release record), a conflict verdict the same way (a conflict release record — a warning, not a verdict), and an own-txid verdict as a broadcast record, so the Stale / Conflict / Broadcasted status itself survives a refresh.
  // Per-card expandable state, kept across re-renders (0.7.18):
  // clicking a card button (Dry-run, the arm toggle, ...) reloads
  // the list and rebuilds every card's DOM — without this map the
  // rebuild resets each <details> to its default, so using a
  // button would open or close the Details the user had set.
  // Keyed by tx id; an entry exists only once the user has
  // toggled something on that card (a fresh card uses the
  // defaults: Details open for Active/Pending, closed for
  // Archived; nested Inputs/Outputs closed). The render reads
  // the map, and each <details> toggle listener writes the user's
  // choice back into it — so a re-render restores exactly what
  // the user left, on every card. The TXID and the Inputs/Outputs
  // entries do not live in this map: tapping one opens a pop-out
  // with the full info instead of expanding inline, so there is
  // no inline state to preserve.
  var txUiState = {};
  // The public fallback (0.7.17): a per-transaction opt-in timer on a
  // Slipstream-route transaction — if MARA has not confirmed it
  // within the chosen days, Standby broadcasts it publicly instead.
  // The same seven durations the server accepts, plus Never (null).
  var FALLBACK_DAYS = [1, 3, 7, 14, 30, 60, 90];
  // The one-sentence explainer under the Add form's fallback select
  // (0.7.17): what the chosen duration means. Never means MARA
  // holds it until it is mined or dropped — no automatic fallback.
  function fallbackAddNote(days) {
    if (days === null || days === undefined || days === '') return 'No automatic fallback \u2014 it stays with MARA until mined or dropped.';
    return 'If MARA hasn\u2019t confirmed it within ' + fallbackLabel(days) + ', Standby broadcasts it publicly instead.';
  }
  function fallbackLabel(days) {
    if (days === null || days === undefined || days === '') return 'Never';
    return days + (days === 1 ? ' day' : ' days');
  }
  // Days left before a Slipstream-pending tx's public fallback fires
  // — from the deadline (submittedAt + duration) to now, rounded up,
  // so a deadline later today still reads as a day left. Never (null)
  // has no deadline; a passed deadline reads as due.
  function fallbackCountdown(tx) {
    var days = tx.publicFallbackDays;
    if (days === null || days === undefined) return '(No automatic fallback)';
    var submittedAt = tx.release && tx.release.submittedAt;
    if (!submittedAt) return '(No automatic fallback)';
    var deadline = new Date(submittedAt).getTime() + days * 86400000;
    var left = Math.ceil((deadline - Date.now()) / 86400000);
    if (left <= 0) return '(fallback due \u2014 broadcasts publicly on the next hourly check)';
    return '(' + left + (left === 1 ? ' day' : ' days') + ' left before fallback)';
  }
  var txCardEls = {}; // tx id -> { row, sentLine }: the rendered card, so the confirmations poll can update the sent line in place

  function hostOf(u) { try { return new URL(u).host; } catch (e) { return u || ''; } }
  // One node's row — the host, plus a pill for the last test of that
  // endpoint (OK / Failed / Not tested). `prefix` is 'readiness-' on the
  // Dashboard and 'btc-' on the Settings tab; both render the same
  // data. A blank URL means no secondary node is set.
  function renderNodeStatus(prefix, label, url, conn) {
    var host = $(prefix + label);
    var pill = $(prefix + label + '-status');
    if (!url) {
      host.textContent = 'Not set';
      pill.textContent = 'Not set';
      pill.className = 'pill muted';
      return;
    }
    host.textContent = hostOf(url);
    var res = (conn.results || []).find(function (r) { return r.endpoint === label && r.base === url; });
    if (!res) {
      pill.textContent = 'Not tested';
      pill.className = 'pill muted';
      pill.title = '';
    } else if (res.ok) {
      pill.textContent = 'OK';
      pill.className = 'pill ok';
      pill.title = res.detail || '';
    } else {
      pill.textContent = 'Failed';
      pill.className = 'pill bad';
      pill.title = res.detail || '';
    }
  }
  // Which endpoint broadcast it — 'primary'/'secondary' today, and the
  // pre-0.5.4 values ('node'/'api'/'both') for records from older builds.
  function methodLabel(m) {
    return m === 'primary' ? 'primary node'
      : m === 'secondary' ? 'secondary node'
      : m === 'node' ? 'own node'
      : m === 'api' ? 'public API'
      : m === 'both' ? 'own node + public API'
      : m === 'slipstream' ? 'Slipstream (MARA)'
      : (m || '');
  }

  // The MARA queue line for a Slipstream-submitted transaction:
  // where it sits in MARA's queue and how likely it is to be mined
  // soon, from the last status check. Only shown while waiting.
  function txMaraLine(tx) {
    var rel = tx.release;
    if (!rel || rel.status !== 'submitted-slipstream') return '';
    var m = rel.mara || {};
    var bits = [];
    if (typeof m.position === 'number') bits.push('position ' + m.position + ' in MARA\u2019s queue');
    if (m.isNextBlock === true) bits.push('likely in the next block');
    else if (typeof m.last24hOdds === 'number') bits.push(Math.round(m.last24hOdds * 100) + '% mined in the last 24h');
    else if (typeof m.last7dOdds === 'number') bits.push(Math.round(m.last7dOdds * 100) + '% mined in the last 7 days');
    if (!bits.length) return '';
    return 'Slipstream queue: ' + bits.join(', ') + '.';
  }

  // The broadcasted line for a sent transaction: when it went out, via
  // which node, and how deep it is. confirmations === null means it
  // has not been checked yet (or the check failed — the checkedAt stays
  // old then, so the number reads as stale rather than wrong).
  function txBroadcastLine(tx) {
    var b = tx.broadcasted;
    if (!b) return '';
    var conf = b.confirmations === null
      ? (b.found === false ? 'not found on the network — it may have been dropped from the mempool or replaced' : 'confirmations not checked yet')
      : b.confirmations === 0 ? '0 confirmations — in the mempool, unconfirmed'
      : b.confirmations + (b.confirmations === 1 ? ' confirmation' : ' confirmations');
    return 'Broadcast ' + fmtDate(b.broadcastedAt) + ' via ' + methodLabel(b.method) + ' — ' + conf + '.';
  }

  function txReleaseLine(tx) {
    // A sent transaction shows the broadcast line (with confirmations),
    // not the cycle's release record — the broadcast is an on-chain
    // fact that survives check-ins. A stale record survives check-ins
    // too (the inputs are spent for good); the other release records
    // do not.
    if (tx.broadcasted) return txBroadcastLine(tx);
    var rel = tx.release;
    if (!rel) return '';
    if (rel.status === 'broadcast') return 'Broadcast ' + fmtDate(rel.broadcastedAt) + ' via ' + methodLabel(rel.method) + '.';
    if (rel.status === 'stale') return 'Stale — ' + (rel.error || 'inputs spent') + '.';
    // A Slipstream submission is a pseudo-pending-but-success state:
    // it went to MARA, it is not in the public mempool yet, and it
    // becomes Broadcasted once the public nodes see it — or Failed
    // if MARA drops it. The queue line (when the last status check
    // brought one back) says where it sits.
    if (rel.status === 'submitted-slipstream') {
      // The queue position lives on its own row (txMaraLine), not
      // in this line — the card shows the submission and the queue
      // as two rows.
      return 'Submitted to Slipstream (MARA) ' + fmtDate(rel.submittedAt) + ' — waiting for MARA to mine it.';
    }
    return 'Failed — ' + (rel.error || 'unknown error') + '. Will retry on the next hourly check.';
  }

  // The overall status of one transaction, shown as a pill at the
  // top-right of its label row. Precedence: a broadcasted tx the
  // network no longer knows is Failed — the node accepted it, then
  // it was dropped from the mempool (or replaced by the other
  // transaction sharing its inputs); the broadcast line on the card
  // says so. A broadcasted tx that is CONFIRMED (confirmations > 0,
  // or a block height set) is Broadcasted (green, archived); a
  // broadcasted tx that is NOT yet confirmed — in the mempool, or
  // not checked yet (confirmations null) — is Broadcast (amber,
  // pending): it is out the door but not settled yet. A release
  // record that says 'broadcast' counts as Broadcasted even without
  // the broadcasted fact — a restore can carry one half of the
  // pair, and there is no confirmation count to consult for it.
  // Inputs declared spent is Stale — the spent verdict is recorded
  // on the transaction (by the release, a manual broadcast, or a
  // dry-run), so it survives refreshes and check-ins and the card
  // stays in the Archived Transactions card; an input spent by
  // another transaction that is NOT confirmed yet is Conflict — a
  // warning, not a verdict: the card stays active (not archived,
  // not stale) and a broadcast is still attempted, and a later
  // clean check clears it; a dry-run that could not reach the
  // nodes is Node Failure; a failed release is Failed; a dry-run
  // that could not say either way is Unverified; otherwise an armed
  // tx is Ready and an unarmed one is "unarmed" (0.7.20 — the pill
  // reads just "unarmed", not "Disabled + unarmed"). `settled` marks a
  // card whose body is collapsed and whose dry-run button is
  // disabled — a broadcasted-and-confirmed, failed, or stale
  // transaction (the Archived card). `pending` marks a card that is
  // broadcast/submitted but not yet confirmed — the Pending card.
  // A pending card takes the archived-card format (collapsed
  // details, no arm toggle) but its Edit button stays available
  // (label and notes only — the hex is locked) and a
  // Slipstream-pending card carries a "Broadcast publicly" escape
  // hatch. The route toggle is locked once broadcast: it appears
  // only on Active cards.
  // The status pill carries the armed state as text ("Ready +
  // armed") on an Active card — the toggle next to it is the
  // control, green when armed. An unarmed card's pill reads just
  // "unarmed" (0.7.20 — "Disabled + unarmed" was silly: the arm
  // state is the whole status, not a prefix on another one). A
  // settled or pending card has no arm state, so it keeps its
  // plain label.
  function txPillText(tx, st) {
    if (st.settled || st.pending) return st.label;
    if (!tx.enabled) return 'unarmed';
    return st.label + ' + armed';
  }

  // One label/value row inside a card's Details: "Label: value".
  // The row is flex: the label is a fixed 120px column and the
  // value takes the rest, so every row's value starts at exactly
  // the same x — and a long value wraps inside its own column
  // instead of running under the label. `cls` is the row's own
  // class (tx-route, tx-fallback, ...) so a row can be found by
  // name. Every value is sans like every other Details value
  // (round 9 took the TXID off monospace, round 13 the Input
  // entries — no monospace value remains). The space between
  // label and value lives at the END of the label span: the label
  // is sans for every row, so that space is the same width on all
  // of them. The label's trailing space is not rendered (it sits
  // inside the 120px column) but it is in textContent, so the row
  // still reads "Label: value".
  function kvRow(cls, label, value) {
    var r = document.createElement('div');
    r.className = 'tx-kv' + (cls ? ' ' + cls : '');
    var k = document.createElement('span');
    k.className = 'tx-kv-k';
    k.textContent = label + ': ';
    var v = document.createElement('span');
    v.className = 'tx-kv-v';
    v.textContent = value;
    r.appendChild(k);
    r.appendChild(v);
    return r;
  }

  // One Inputs/Outputs entry row (0.7.18 round 8): a kv row like
  // every other Details row — the label ("Input 1", "Output 1")
  // in the 120px label column, the content on the same line in
  // the value column. The content is truncated to one line (an
  // ellipsis if it still does not fit) and clickable: tapping it
  // opens a pop-out with the full info instead of expanding
  // inline, so the card never grows or shifts. `openFn` opens
  // that pop-out.
  function ioEntryRow(label, shortText, valueClass, title, openFn) {
    var r = document.createElement('div');
    r.className = 'tx-kv tx-io-line';
    var k = document.createElement('span');
    k.className = 'tx-kv-k';
    k.textContent = label + ': ';
    var v = document.createElement('span');
    v.className = 'tx-kv-v ' + valueClass;
    v.textContent = shortText;
    v.title = title;
    v.addEventListener('click', openFn);
    r.appendChild(k);
    r.appendChild(v);
    return r;
  }

  // The pop-outs for the TXID and the Inputs/Outputs entries
  // (0.7.18 round 8): the shared showDetails pop-out (X, Close,
  // backdrop to dismiss) with the full info in a kv list — the
  // card itself never changes, so nothing shifts or wraps.
  function showTxidPopout(tx) {
    showDetails('Transaction ID', 'The full 64-character transaction ID.',
      '<dl class="kv"><dt>TXID</dt><dd>' + escapeHtml(tx.txid) + '</dd></dl>');
  }
  function showInputPopout(tx, inp, i) {
    var html = '<dl class="kv"><dt>UTXO</dt><dd>' + escapeHtml(inp.prevTxid + ':' + inp.prevVout) + '</dd>'
      + ((inp.valueSats !== null && inp.valueSats !== undefined)
        ? '<dt>Value</dt><dd>' + escapeHtml(fmtBtc(inp.valueSats) + ' BTC (' + fmtSats(inp.valueSats) + ' sats)') + '</dd>' : '')
      + '</dl>';
    showDetails('Input ' + (i + 1), 'The UTXO this input spends.', html);
  }
  function showOutputPopout(tx, out, i) {
    var html = '<dl class="kv"><dt>Value</dt><dd>' + escapeHtml(fmtBtc(out.valueSats) + ' BTC (' + fmtSats(out.valueSats) + ' sats)') + '</dd>'
      + (out.address ? '<dt>Address</dt><dd>' + escapeHtml(out.address) + '</dd>'
        : '<dt>Type</dt><dd>' + escapeHtml(out.type) + '</dd>')
      + '</dl>';
    showDetails('Output ' + (i + 1), 'The full value and destination for this output.', html);
  }

  function txStatus(tx) {
    var dr = dryRunResults[tx.id] || null;
    if (tx.broadcasted || (tx.release && tx.release.status === 'broadcast')) {
      if (tx.broadcasted && tx.broadcasted.found === false) return { label: 'Failed', cls: 'bad', settled: true, pending: false };
      // Confirmed (or a restore-carried 'broadcast' record with no
      // broadcasted fact to consult) -> Archived, green. Broadcast
      // but unconfirmed (0 confirmations, or not checked yet) ->
      // Pending, amber.
      if (!tx.broadcasted) return { label: 'Broadcasted', cls: 'ok', settled: true, pending: false };
      var conf = tx.broadcasted.confirmations;
      if ((typeof conf === 'number' && conf > 0) || tx.broadcasted.blockHeight != null) {
        return { label: 'Broadcasted', cls: 'ok', settled: true, pending: false };
      }
      return { label: 'Broadcast', cls: 'warn', settled: false, pending: true };
    }
    if ((tx.release && tx.release.status === 'stale') || (dr && dr.spent)) {
      return { label: 'Stale', cls: 'bad', settled: true, pending: false };
    }
    // Slipstream Pending (0.7.16): submitted to Slipstream, not yet
    // visible in the public mempool. A pseudo-pending-but-success
    // state — the card lives in the Pending Transactions card, with
    // its own amber pill, distinct from Broadcasted and from Failed.
    // It takes precedence over a timelock or conflict warning: the
    // transaction is already submitted, so that is the state that
    // matters.
    if (tx.release && tx.release.status === 'submitted-slipstream') {
      return { label: 'Slipstream Pending', cls: 'warn', settled: false, pending: true };
    }
    // Absolute-locktime warning (0.7.14): the transaction carries a
    // locktime that has not passed yet, so the node would reject it as
    // non-final. The card stays active with a warning pill — and the
    // broadcast is not gated on it, the retry fix retakes the
    // transaction once the locktime passes. Precedence matches the
    // dry-run: a timelock beats a conflict.
    if (dr && dr.verdict === 'timelocked') {
      return { label: 'Timelocked', cls: 'warn', settled: false, pending: false };
    }
    if (dr && dr.error) return { label: 'Node Failure', cls: 'warn', settled: false, pending: false };
    // Unconfirmed-spend warning (0.7.12, finding 1): another
    // transaction spends an input, but it is not confirmed yet and
    // may still be evicted — so the card stays active with a warning
    // pill, and Broadcast Now / a release run still attempt it. The
    // server re-derives the warning on every fresh check: a clean
    // verdict clears it, a confirmed spend turns it stale.
    if ((tx.release && tx.release.status === 'conflict') || (dr && dr.verdict === 'conflict')) {
      return { label: 'Conflict', cls: 'warn', settled: false, pending: false };
    }
    if (tx.release && tx.release.status === 'failed') {
      var e = tx.release.error || '';
      var node = e.indexOf('input check failed') !== -1 || e.indexOf('could not reach') !== -1;
      return node
        ? { label: 'Node Failure', cls: 'warn', settled: false, pending: false }
        : { label: 'Failed', cls: 'warn', settled: false, pending: false };
    }
    if (dr && dr.unknown) return { label: 'Unverified', cls: 'muted', settled: false, pending: false };
    // Unarmed (0.7.20): the pill reads just "unarmed" — the label
    // here is the pill's text, and txPillText returns it plainly
    // for an unarmed tx instead of appending " + unarmed" to it.
    if (!tx.enabled) return { label: 'unarmed', cls: 'muted', settled: false, pending: false };
    return { label: 'Ready', cls: 'ok', settled: false, pending: false };
  }

  // 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16:1'
  // -> 'f4184fc59640:1': short enough to fit a card line, long enough
  // to tell two inputs apart.
  function shortInput(input) {
    var parts = String(input || '').split(':');
    return parts[0].slice(0, 12) + (parts.length > 1 ? ':' + parts[1] : '');
  }

  function renderBitcoin() {
    $('btc-primary-url').value = S.settings.primaryApiUrl || 'https://mempool.space';
    $('btc-secondary-url').value = S.settings.secondaryApiUrl || '';
    var conn = S.bitcoin.connection || {};
    renderNodeStatus('btc-', 'primary', S.settings.primaryApiUrl, conn);
    renderNodeStatus('btc-', 'secondary', S.settings.secondaryApiUrl, conn);

    var txs = S.bitcoin.txs || [];
    // Shared-input warnings, derived from the stored transactions on
    // every load (the state carries the shared inputs, computed
    // server-side), so the warning persists across refreshes — it is
    // not page memory, and no Dry-run all is needed for it to appear.
    // A settled or pending card gets no warning: its fate is already
    // decided. The server-side detection already excludes archived
    // transactions (round 12); the skip here is belt-and-braces for
    // a settled or pending card. Editing a transaction to spend a
    // different input removes it from the shared set, and the warning
    // clears on the next load.
    var overlapsByTx = {};
    (S.bitcoin.overlaps || []).forEach(function (ov) {
      ov.txIds.forEach(function (tid) {
        var tx = (S.bitcoin.txs || []).find(function (y) { return y.id === tid; });
        if (tx && (txStatus(tx).settled || txStatus(tx).pending)) return;
        var others = ov.txIds.filter(function (x) { return x !== tid; }).map(function (x) {
          var t = (S.bitcoin.txs || []).find(function (y) { return y.id === x; });
          return t ? ('"' + (t.label || 'Untitled transaction') + '"') : x;
        }).join(', ');
        (overlapsByTx[tid] = overlapsByTx[tid] || []).push({ input: ov.input, others: others });
      });
    });
    // The three lists: the ones still waiting live inside the
    // Pre-signed Bitcoin transactions card, below the Dry-run All /
    // Broadcast All buttons; the ones broadcast or submitted but not
    // yet confirmed live in the Pending Transactions card; the
    // settled ones (broadcasted-and-confirmed, or stale) live in the
    // Archived Transactions card.
    var activeList = $('btc-active-list');
    var pendingList = $('btc-pending-list');
    var archivedList = $('btc-archived-list');
    activeList.innerHTML = '';
    pendingList.innerHTML = '';
    archivedList.innerHTML = '';
    txCardEls = {};
    // Newest first. The sort is render-time only: the release still
    // evaluates stored transactions in stored order. Active first,
    // then pending, then archived.
    function bucketRank(t) {
      var st = txStatus(t);
      return st.settled ? 2 : (st.pending ? 1 : 0);
    }
    var sorted = txs.slice().reverse().sort(function (a, b) {
      return bucketRank(a) - bucketRank(b);
    });
    sorted.forEach(function (tx) {
      var row = document.createElement('div');
      row.className = 'tx-card tx-sub';
      var st = txStatus(tx);
      var settled = st.settled;
      var pending = st.pending;
      // Header: label (bold) + status pill, and on an Active card
      // the arm/disarm toggle immediately to the right of the pill.
      // The pill carries the armed state as text ("Ready + armed" /
      // "Ready + unarmed") — the toggle is the control, green when
      // armed. Pending and settled cards have no toggle (the tx is
      // already out the door).
      var head = document.createElement('div');
      head.className = 'tx-head';
      var title = document.createElement('b');
      title.textContent = tx.label || 'Untitled transaction';
      var pill = document.createElement('span');
      // A warned-about tx keeps its "Ready" label but gets an amber
      // pill (0.7.16 amendment, Ryan): the tx is still ready to
      // broadcast, but the warning — a shared input, only one of
      // them can ever be confirmed — deserves attention. Only the
      // green pill changes: Conflict/Timelocked/Node Failure are
      // already amber, and settled/pending cards never carry a
      // warning line (overlapsByTx skips them), so 'ok' + a warning
      // can only be a Ready card.
      var pillCls = st.cls;
      if (pillCls === 'ok' && overlapsByTx[tx.id] && overlapsByTx[tx.id].length) pillCls = 'warn';
      pill.className = 'pill ' + pillCls;
      pill.textContent = txPillText(tx, st);
      head.appendChild(title); head.appendChild(pill);
      if (!settled && !pending) {
        var tog = document.createElement('label');
        tog.className = 'switch green';
        tog.title = tx.enabled ? 'Armed — will broadcast at release' : 'Unarmed — will not broadcast at release';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!tx.enabled;
        cb.addEventListener('change', function () { toggleTx(tx.id, cb.checked); });
        var slider = document.createElement('span');
        slider.className = 'slider';
        tog.appendChild(cb); tog.appendChild(slider);
        head.appendChild(tog);
      }
      row.appendChild(head);
      // The amount, prominent below the header: the BTC figure
      // large, the sats beside it smaller.
      var amount = document.createElement('div');
      amount.className = 'tx-amount';
      var btcAmt = document.createElement('span');
      btcAmt.textContent = fmtBtc(tx.totalOutSats) + ' BTC';
      var satsAmt = document.createElement('span');
      satsAmt.className = 'tx-amount-sats';
      satsAmt.textContent = fmtSats(tx.totalOutSats) + ' sats';
      amount.appendChild(btcAmt); amount.appendChild(satsAmt);
      row.appendChild(amount);
      // The Details — collapsed by default on every card (round 12:
      // Ryan decided all cards start collapsed). Everything but the
      // title, status, amount, and actions lives here, one
      // label/value row per piece of info. The open state is the
      // user's when they have toggled it (txUiState), the default
      // otherwise — a re-render restores it instead of resetting.
      var ui = txUiState[tx.id] || {};
      var details = document.createElement('details');
      details.className = 'tx-details';
      details.open = ui.detailsOpen !== undefined ? ui.detailsOpen : false;
      details.addEventListener('toggle', function () {
        (txUiState[tx.id] = txUiState[tx.id] || {}).detailsOpen = details.open;
      });
      var sum = document.createElement('summary');
      sum.textContent = 'Details';
      details.appendChild(sum);
      row.appendChild(details);
      var body = details;
      // The Inputs and Outputs (0.7.18 refinement): a drop-down
      // only when there is more than one entry on that side —
      // with exactly one input (or output) there is no drop-down
      // at all, just the single entry as a normal kv row inline
      // (round 10). Each drop-down is collapsed by default, its
      // summary shows only its count — no BTC amount in a summary
      // — and expanding one lists every entry as a kv row
      // (round 8): the label ("Input 1", "Output 1") in the 120px
      // label column, the content on the same line in the value
      // column, left-aligned with every other Details value. The
      // content is truncated to one line and clickable — tapping
      // it opens a pop-out with the full info instead of expanding
      // inline. Inputs list each input's outpoint (and its value
      // when known); Outputs list each output's value and
      // destination address (or its script type when no address
      // can be derived). The detail comes from the server (GET
      // /api/state derives it from the stored hex); without it
      // the rows fall back to the plain counts.
      var io = tx.detail;
      if (io && Array.isArray(io.inputs) && Array.isArray(io.outputs)) {
        if (io.inputs.length === 1) {
          var inp0 = io.inputs[0];
          var shortIn = shortInput(inp0.prevTxid + ':' + inp0.prevVout) + '…'
            + ((inp0.valueSats !== null && inp0.valueSats !== undefined) ? ' · ' + fmtBtc(inp0.valueSats) + ' BTC' : '');
          body.appendChild(ioEntryRow('Input', shortIn, 'tx-io-value', 'Click to show full input', function () { showInputPopout(tx, inp0, 0); }));
        } else {
          var inDet = document.createElement('details');
          inDet.className = 'tx-io';
          inDet.open = ui.inputsOpen === true;
          inDet.addEventListener('toggle', function () {
            (txUiState[tx.id] = txUiState[tx.id] || {}).inputsOpen = inDet.open;
          });
          var inSum = document.createElement('summary');
          inSum.textContent = 'Inputs: ' + tx.inputs;
          inDet.appendChild(inSum);
          io.inputs.forEach(function (inp, i) {
            var shortText = shortInput(inp.prevTxid + ':' + inp.prevVout) + '…'
              + ((inp.valueSats !== null && inp.valueSats !== undefined) ? ' · ' + fmtBtc(inp.valueSats) + ' BTC' : '');
            inDet.appendChild(ioEntryRow('Input ' + (i + 1), shortText, 'tx-io-value', 'Click to show full input', function () { showInputPopout(tx, inp, i); }));
          });
          body.appendChild(inDet);
        }
        if (io.outputs.length === 1) {
          var out0 = io.outputs[0];
          var shortOut = fmtBtc(out0.valueSats) + ' BTC (' + fmtSats(out0.valueSats) + ' sats)'
            + (out0.address ? ' → ' + out0.address.slice(0, 12) + '…' : ' · ' + out0.type);
          body.appendChild(ioEntryRow('Output', shortOut, 'tx-io-value', 'Click to show full output', function () { showOutputPopout(tx, out0, 0); }));
        } else {
          var outDet = document.createElement('details');
          outDet.className = 'tx-io';
          outDet.open = ui.outputsOpen === true;
          outDet.addEventListener('toggle', function () {
            (txUiState[tx.id] = txUiState[tx.id] || {}).outputsOpen = outDet.open;
          });
          var outSum = document.createElement('summary');
          outSum.textContent = 'Outputs: ' + tx.outputs;
          outDet.appendChild(outSum);
          io.outputs.forEach(function (out, i) {
            var shortText = fmtBtc(out.valueSats) + ' BTC (' + fmtSats(out.valueSats) + ' sats)'
              + (out.address ? ' → ' + out.address.slice(0, 12) + '…' : ' · ' + out.type);
            outDet.appendChild(ioEntryRow('Output ' + (i + 1), shortText, 'tx-io-value', 'Click to show full output', function () { showOutputPopout(tx, out, i); }));
          });
          body.appendChild(outDet);
        }
      } else {
        body.appendChild(kvRow('', 'Inputs', String(tx.inputs)));
        body.appendChild(kvRow('', 'Outputs', String(tx.outputs)));
      }
      // The fee (0.7.18): stored at add time when the node could
      // answer the parent lookup. The row hides entirely when the
      // fee is unknown — no "—" fee. The row uses the standard
      // 120px label column like every other Details row (round 7),
      // so its value starts exactly where the others' do. The
      // value drops the redundant "sats" — the rate's "sat/vB"
      // carries the unit — so even a 50,000-sat fee fits on one
      // line in the 162px left after the column on a phone.
      // (0.7.20) The fee verdict rides on the same line as a short
      // colour-coded suffix — " — Low Risk" / " — Medium Risk" /
      // " — High Risk" — for an ACTIVE tx only (a broadcast or
      // archived tx's fee is moot, and a pending one is already
      // submitted). No verdict when the fee rate is unknown or the
      // 90-day peak has not been fetched: the line stays exactly
      // as it was, rather than showing a wrong one.
      if (tx.feeSats !== null && tx.feeSats !== undefined) {
        var feeRow = kvRow('tx-fee', 'Fee', fmtSats(tx.feeSats) + ' · ' + fmtRate(tx.feeRateSatVb) + ' sat/vB');
        var fv = (!settled && !pending) ? feeVerdict(tx.feeRateSatVb, S.bitcoin.feePeak, S.bitcoin.currentFees && S.bitcoin.currentFees.economyFee) : null;
        if (fv) {
          var fvs = document.createElement('span');
          fvs.className = 'fee-verdict ' + feeVerdictCls(fv);
          fvs.textContent = ' — ' + fv;
          feeRow.children[1].appendChild(fvs);
          // The Fee line is clickable (0.7.21): tapping it opens
          // the fee-risk pop-out, which explains how the verdict
          // was calculated. The pointer cursor and the title say
          // it is clickable, like the TXID value below. Only
          // when there is a verdict to explain — a tx with no
          // verdict has nothing to pop out.
          feeRow.children[1].className = 'tx-kv-v tx-fee-value';
          feeRow.children[1].title = 'Click to see how this risk was calculated';
          feeRow.children[1].addEventListener('click', function () { showFeePopout(tx, fv); });
        }
        body.appendChild(feeRow);
      }
      // The TXID, truncated — clickable to open a pop-out with the
      // full 64-hex value (0.7.18 round 8: it used to expand inline,
      // which grew the card and wrapped the hex under the label;
      // the pop-out leaves the card exactly as it is). A display
      // action only: it changes nothing about the tx. The pointer
      // cursor and the title say it is clickable.
      var txidRow = document.createElement('div');
      txidRow.className = 'tx-kv tx-txid';
      var txidK = document.createElement('span');
      txidK.className = 'tx-kv-k';
      txidK.textContent = 'TXID: ';
      var txidV = document.createElement('span');
      txidV.className = 'tx-kv-v tx-txid-value';
      txidV.textContent = tx.txid.slice(0, 16) + '…';
      txidV.title = 'Click to show full TXID';
      txidV.addEventListener('click', function () { showTxidPopout(tx); });
      txidRow.appendChild(txidK);
      txidRow.appendChild(txidV);
      body.appendChild(txidRow);
      body.appendChild(kvRow('tx-route', 'Broadcast via', tx.broadcastVia === 'slipstream' ? 'Slipstream (MARA)' : 'Public mempool'));
      // The public fallback (0.7.17): a per-transaction opt-in
      // timer, shown only while the route is Slipstream AND a
      // fallback is set — when the route is public the setting is
      // stored but ignored, and when it is Never there is nothing
      // to show. On a Slipstream-pending card the countdown rides
      // on the same row. The duration is changed in the Edit popup,
      // not on the card. Changing it only moves the deadline: it is
      // counted from when MARA first received the transaction, and
      // setting it sooner or later does not change the count.
      if (tx.broadcastVia === 'slipstream' && tx.publicFallbackDays !== null && tx.publicFallbackDays !== undefined) {
        var fbText = fallbackLabel(tx.publicFallbackDays);
        if (pending && tx.release && tx.release.status === 'submitted-slipstream') {
          fbText += ' ' + fallbackCountdown(tx);
        } else if (!pending && !settled) {
          // Not yet broadcast (Active): the duration runs from the
          // broadcast, not from now — "7 days from broadcast".
          fbText += ' from broadcast';
        }
        body.appendChild(kvRow('tx-fallback', 'Public Fallback', fbText));
      }
      if (tx.locktime > 0) {
        body.appendChild(kvRow('', 'Locktime', String(tx.locktime)));
      }
      body.appendChild(kvRow('', 'Created', fmtDate(tx.createdAt)));
      // The MARA queue line for a Slipstream-pending card: where
      // it sits in MARA's queue and how likely it is to be mined
      // soon. Its own row, not folded into the submission line.
      if (pending && tx.release && tx.release.status === 'submitted-slipstream') {
        var mara = txMaraLine(tx);
        if (mara) {
          var maraLine = document.createElement('p');
          maraLine.className = 'tx-mara';
          maraLine.textContent = mara;
          body.appendChild(maraLine);
        }
      }
      if (tx.notes) {
        var notes = document.createElement('p');
        notes.className = 'tx-notes';
        notes.textContent = tx.notes;
        body.appendChild(notes);
      }
      var sentLine = null;
      if (tx.release || tx.broadcasted) {
        var rel = document.createElement('p');
        rel.className = tx.broadcasted ? 'tx-sent' : 'muted';
        rel.textContent = txReleaseLine(tx);
        body.appendChild(rel);
        if (tx.broadcasted) sentLine = rel;
      }
      var actions = document.createElement('div');
      actions.className = 'tx-actions';
      var dryBtn = document.createElement('button');
      dryBtn.textContent = 'Dry-run';
      dryBtn.disabled = settled || pending;
      if (settled || pending) dryBtn.title = 'Transaction already broadcast or submitted';
      dryBtn.addEventListener('click', function () { dryRunTx(tx.id); });
      // Edit stays available on every card — including Pending and
      // Archived ones — but for those it may change only the label
      // and notes: the hex field is disabled in edit mode (and the
      // server rejects a hex change on a broadcasted or
      // Slipstream-pending tx). See startEdit.
      var editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { startEdit(tx); });
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'danger';
      delBtn.addEventListener('click', function () {
        // The confirm must say what deleting actually does. For an
        // Active tx it stops a future broadcast — but a tx already
        // out the door cannot be recalled: deleting it only removes
        // Standby's record of it, and it can still confirm on the
        // network. Branched on the same txStatus() classification
        // the card itself uses (st is in scope here).
        var label = tx.label || 'Untitled transaction';
        var delBody;
        if (tx.release && tx.release.status === 'submitted-slipstream') {
          delBody = 'This deletes "' + label + '" from Standby. It has already been submitted to MARA Slipstream and is waiting to be mined — deleting it here does NOT cancel or recall it, and MARA can still mine it. Its history on this card goes with it.';
        } else if (tx.broadcasted) {
          var conf = tx.broadcasted.confirmations;
          if (tx.broadcasted.found === false) {
            delBody = 'This deletes "' + label + '" from Standby. It was already broadcast, but the network no longer reports it — deleting it here only removes it from Standby; it does not undo the broadcast. Its history on this card goes with it.';
          } else if ((typeof conf === 'number' && conf > 0) || tx.broadcasted.blockHeight != null) {
            delBody = 'This deletes "' + label + '" from Standby. It has already been broadcast and confirmed on the network — deleting it here does NOT undo the broadcast. Its history on this card goes with it.';
          } else {
            delBody = 'This deletes "' + label + '" from Standby. It is already in the public mempool waiting for its first confirmation — deleting it here does NOT stop or recall it, and it can still confirm on the network. Its history on this card goes with it.';
          }
        } else if (st.label === 'Stale') {
          delBody = 'This deletes "' + label + '" from Standby. Its inputs were spent, so it will never broadcast — deleting it here only removes the record from Standby. Its history on this card goes with it.';
        } else if (st.label === 'Broadcasted') {
          // A restore-carried 'broadcast' record with no broadcasted
          // fact to consult: it was broadcast, but we cannot say
          // whether it has confirmed yet.
          delBody = 'This deletes "' + label + '" from Standby. It has already been broadcast — deleting it here only removes it from Standby; it does not undo the broadcast. Its history on this card goes with it.';
        } else {
          delBody = 'This deletes "' + label + '" from Standby. It will no longer be broadcast if the release runs, and its history on this card goes with it.';
        }
        showConfirm('Delete this transaction?',
          delBody,
          function () { deleteTx(tx.id); },
          'Delete');
      });
      // Broadcast Now: send this transaction immediately, on the owner's
      // say-so — same path as the release, after a confirmation dialog.
      // A sent or stale transaction cannot be broadcast from its card,
      // and neither can one already submitted to Slipstream — it is
      // waiting on MARA, and re-submitting it would be a duplicate.
      // A pending public tx is already out the door too.
      var bcBtn = document.createElement('button');
      bcBtn.textContent = 'Broadcast Now';
      bcBtn.className = 'danger';
      var waitingMara = !!(tx.release && tx.release.status === 'submitted-slipstream');
      bcBtn.disabled = settled || pending || waitingMara;
      if (tx.broadcasted) bcBtn.title = 'Already broadcast';
      else if (waitingMara) bcBtn.title = 'Already submitted to Slipstream — waiting on MARA';
      else if (settled) bcBtn.title = 'Stale — inputs spent';
      else bcBtn.addEventListener('click', function () { broadcastNow(tx.id); });
      actions.appendChild(dryBtn); actions.appendChild(editBtn); actions.appendChild(delBtn); actions.appendChild(bcBtn);
      // The escape hatch for a slow MARA tx (0.7.16, Pending card):
      // a Slipstream-pending tx can be broadcast publicly instead,
      // by hand. It is NOT part of Broadcast All or the release —
      // only this button, after a confirmation that names the
      // privacy cost (the tx becomes visible in the public mempool).
      if (waitingMara) {
        var pubBtn = document.createElement('button');
        pubBtn.textContent = 'Broadcast publicly';
        pubBtn.className = 'danger';
        pubBtn.addEventListener('click', function () { broadcastPublic(tx.id); });
        actions.appendChild(pubBtn);
      }
      row.appendChild(actions);
      // The last dry-run result for THIS transaction, rendered in its own
      // card — not in the add-transaction card below. The line itself is
      // kept in page memory; the spent verdict behind it is recorded
      // on the transaction server-side, so the Stale status survives
      // a refresh even though this line does not reappear.
      var dr = dryRunResults[tx.id];
      if (dr) {
        var dryLine = document.createElement('p');
        // A timelocked dry-run is a warning, not a pass or a failure:
        // yellow/orange (the same warn colour as the Timelocked
        // pill), never green and never red. Keyed off the verdict,
        // not wouldBroadcast — the release WILL attempt the
        // broadcast, so wouldBroadcast is true here, and the line
        // must not read as 'ready'. The line lives BELOW the buttons
        // (0.7.18 refinement, as in 0.7.17) — never inside the
        // Details, so it is visible without expanding anything.
        dryLine.className = dr.verdict === 'timelocked' ? 'tx-dryrun tx-warn' : 'tx-dryrun muted';
        dryLine.textContent = dr.text;
        row.appendChild(dryLine);
      }
      // Shared-input warnings from the state (see renderBitcoin):
      // this tx spends an input another stored tx also spends, so
      // only one of them can ever be confirmed. The input is shown
      // short so the line cannot overflow the card. Like the
      // dry-run line, warnings live BELOW the buttons (0.7.18
      // refinement, as in 0.7.17) — never inside the Details.
      var ow = overlapsByTx[tx.id];
      if (ow && ow.length) {
        ow.forEach(function (w) {
          var warnLine = document.createElement('p');
          warnLine.className = 'tx-warn';
          warnLine.textContent = 'Warning: shares input ' + shortInput(w.input) + ' with ' + w.others + ' — only one of them can ever be confirmed.';
          row.appendChild(warnLine);
        });
      }
      txCardEls[tx.id] = { row: row, sentLine: sentLine, pill: pill };
      (settled ? archivedList : (pending ? pendingList : activeList)).appendChild(row);
    });
    // A list with nothing in it yet says so, instead of sitting empty.
    if (!activeList.children.length) {
      var noneActive = document.createElement('p');
      noneActive.className = 'muted';
      noneActive.textContent = 'No active transactions — add one below.';
      activeList.appendChild(noneActive);
    }
    if (!pendingList.children.length) {
      var nonePending = document.createElement('p');
      nonePending.className = 'muted';
      nonePending.textContent = 'No pending transactions yet.';
      pendingList.appendChild(nonePending);
    }
    if (!archivedList.children.length) {
      var noneArchived = document.createElement('p');
      noneArchived.className = 'muted';
      noneArchived.textContent = 'No archived transactions yet.';
      archivedList.appendChild(noneArchived);
    }
  }

  async function toggleTx(id, enabled) {
    try {
      await api('PUT', '/api/bitcoin/txs/' + encodeURIComponent(id), { enabled: enabled });
      setMsg($('btc-msg'), enabled ? 'Transaction armed.' : 'Transaction unarmed.', true);
      await load();
    } catch (e) { setMsg($('btc-msg'), e.message, false); await load(); }
  }

  // The ids of the transactions that are NOT active right now
  // (pending or archived) — the ones no longer in the Active list.
  // Used to detect, after a dry-run, which transactions just left
  // the Active list.
  function inactiveIds() {
    var ids = {};
    (S.bitcoin.txs || []).forEach(function (t) {
      var st = txStatus(t);
      if (st.settled || st.pending) ids[t.id] = true;
    });
    return ids;
  }
  // After a dry-run, pop up the transactions that just left the
  // Active list — one line each, naming the transaction and the
  // reason (its inputs are spent, or it is already out there). Only
  // the ones that moved in this run; if none moved, no pop-up. The
  // broadcast cases do not need one: Broadcast All already lists
  // each transaction and its outcome, and Broadcast Now shows the
  // sent line on the card. A move can land in the Pending
  // Transactions card (a dry-run discovering the tx is already out
  // there, unconfirmed) or the Archived Transactions card (inputs
  // spent, or already out there and confirmed) — the pop-up names
  // the destination it actually landed in, and opens that card so
  // the move is visible the moment the pop-up closes.
  function noticeMovedToArchive(before, moved, why) {
    var fresh = (moved || []).filter(function (m) { return !before[m.id]; });
    if (!fresh.length) return;
    // `why` is 'broadcast' when the move is a dry-run discovering
    // the transaction is already out there (0.7.12, finding 1) —
    // the wording must not say its inputs are spent.
    var broadcast = why === 'broadcast';
    var pend = [], arch = [];
    fresh.forEach(function (m) {
      var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === m.id; });
      var st = tx ? txStatus(tx) : null;
      if (st && st.pending) pend.push(m);
      else arch.push(m);
    });
    if (!pend.length && !arch.length) return;
    var pendingCard = $('pending-card');
    if (pendingCard && pend.length) pendingCard.open = true;
    var archived = $('archived-card');
    if (archived && arch.length) archived.open = true;
    var title = pend.length && arch.length ? 'Transactions moved'
      : pend.length ? 'Moved to Pending Transactions'
      : 'Moved to Archived Transactions';
    var parts = [];
    if (pend.length) parts.push(pend.length + ' transaction' + (pend.length === 1 ? '' : 's') + ' moved to Pending Transactions — ' + (broadcast
      ? 'already out there (the network reports its own txid), so recorded as broadcast, waiting for its first confirmation.'
      : (pend.length === 1 ? 'its' : 'their') + ' inputs are spent.'));
    if (arch.length) parts.push(arch.length + ' transaction' + (arch.length === 1 ? '' : 's') + ' moved to Archived Transactions — ' + (broadcast
      ? 'already out there (the network reports its own txid), so recorded as broadcast.'
      : (arch.length === 1 ? 'its' : 'their') + ' inputs are spent.'));
    showDetails(title, parts.join(' '),
      '<ul class="plain-list">' + fresh.map(function (m) {
        var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === m.id; });
        var dest = tx && txStatus(tx).pending ? 'pending' : 'archived';
        return '<li>' + escapeHtml(m.label || 'Untitled transaction') + ' — ' + (broadcast ? 'already broadcast' : 'inputs spent') + ' (' + dest + ')</li>';
      }).join('') + '</ul>');
  }

  async function dryRunTx(id) {
    var before = inactiveIds();
    try {
      var r = await api('POST', '/api/broadcast/test', { id: id });
      var one = (r.results || [])[0] || {};
      dryRunResults[id] = { text: 'Dry-run: ' + (one.note || one.error || r.note || ''), ok: !!one.wouldBroadcast,
        verdict: one.verdict || '',
        spent: !!(one.spent && one.spent.length), unknown: !!(one.unknown && one.unknown.length), error: !!one.error };
      await load();
      if (one.spent && one.spent.length) {
        noticeMovedToArchive(before, [{ id: id, label: one.label || '' }]);
      } else if (one.verdict === 'broadcast') {
        // A dry-run discovering the tx is already out there moves it
        // to Archived too — with the broadcast wording, not the spent
        // wording (0.7.12, finding 1).
        noticeMovedToArchive(before, [{ id: id, label: one.label || '' }], 'broadcast');
      }
    } catch (e) {
      dryRunResults[id] = { text: 'Dry-run failed: ' + e.message, ok: false, error: true };
      await load();
    }
  }

  // A transaction is locked once it is out the door — broadcasted,
  // or submitted to Slipstream and waiting on MARA. Its hex (and
  // its route) cannot change; only the label and notes can.
  function isTxLocked(tx) {
    var st = txStatus(tx);
    return st.settled || st.pending;
  }

  // Edit in a popup (0.7.16 amendment): editing used to hijack the
  // Add-transaction card at the bottom of the tab, which scrolled
  // the page all the way down on a phone. The popup carries the
  // same fields; the Add card stays "Add" only and never switches
  // to edit mode. editingId is the single source of truth for "an
  // edit is open" — the popup's Save button keys off it.
  function startEdit(tx) {
    editingId = tx.id;
    $('edit-label').value = tx.label || '';
    $('edit-notes').value = tx.notes || '';
    $('edit-hex').value = tx.hex || '';
    // The route selector follows the transaction being edited, so
    // saving keeps its route unless the owner changes it.
    $('edit-route').value = tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public';
    // The fallback select (0.7.17): it follows the transaction's
    // route — shown for Active and Pending txs while the route is
    // Slipstream, hidden for settled/archived txs (it is meaningless
    // there) and while the route is public. Changing the route in
    // the popup toggles the row (see the edit-route listener below).
    // A Pending tx's title names the fallback too: its hex and route
    // are locked, but the label, notes, and fallback can change.
    $('edit-fallback').value = (tx.publicFallbackDays === null || tx.publicFallbackDays === undefined) ? '' : String(tx.publicFallbackDays);
    var stEdit = txStatus(tx);
    $('edit-fallback-row').style.display = (!stEdit.settled && tx.broadcastVia === 'slipstream') ? '' : 'none';
    // The deadline warning (0.7.17 follow-up): it lives ONLY in
    // the Edit popup, and ONLY for a Pending tx — the deadline is
    // already running there, counted from when MARA first received
    // the transaction. An Active tx has no deadline yet, and a
    // settled tx has no fallback at all, so neither shows it.
    $('edit-fallback-note').style.display = (stEdit.pending && tx.broadcastVia === 'slipstream') ? '' : 'none';
    // A locked tx (Pending or Archived) may change only its label
    // and notes: the hex box, the route selector and the Import
    // button are disabled (import would only populate a hex that
    // cannot change), and a note says so. The server enforces the
    // same rule (PUT rejects a hex change on a locked tx).
    var locked = isTxLocked(tx);
    $('edit-hex').disabled = locked;
    $('edit-hex').title = locked ? 'The transaction hex cannot be changed once it has been broadcast' : '';
    $('edit-route').disabled = locked;
    $('edit-route').title = locked ? 'The broadcast route is locked once the transaction is out the door' : '';
    $('btn-edit-import-file').disabled = locked;
    $('edit-locked-note').style.display = locked ? '' : 'none';
    $('edit-form-title').textContent = !locked ? 'Edit transaction'
      : stEdit.settled ? 'Edit transaction — label and notes only'
      : 'Edit transaction — label, notes and fallback only';
    $('edit-msg').textContent = '';
    $('edit-modal').classList.add('open');
    $('edit-label').focus();
  }

  function cancelEdit() {
    editingId = null;
    $('edit-label').value = '';
    $('edit-notes').value = '';
    $('edit-hex').value = '';
    $('edit-route').value = 'public';
    $('edit-fallback').value = '';
    $('edit-fallback-row').style.display = 'none';
    $('edit-fallback-note').style.display = 'none';
    // Re-enable the fields a locked edit disabled.
    $('edit-hex').disabled = false;
    $('edit-hex').title = '';
    $('edit-route').disabled = false;
    $('edit-route').title = '';
    $('btn-edit-import-file').disabled = false;
    $('edit-locked-note').style.display = 'none';
    $('edit-form-title').textContent = 'Edit transaction';
    $('edit-msg').textContent = '';
    $('edit-modal').classList.remove('open');
  }

  // The edit popup closes like the confirm modal: Cancel, the X,
  // or a click on the backdrop. Guarded like modal-x: a mixed tree
  // (new script, old page) must degrade to a missing X, not a dead
  // page.
  $('btn-edit-cancel').addEventListener('click', function () { cancelEdit(); });
  // The edit popup's fallback row follows the route selector
  // (0.7.17): it shows while the route is Slipstream and hides
  // while it is public — the same rule as the Add form and the card.
  $('edit-route').addEventListener('change', function () {
    $('edit-fallback-row').style.display = $('edit-route').value === 'slipstream' ? '' : 'none';
  });
  var editModalX = $('edit-modal-x');
  if (editModalX) editModalX.addEventListener('click', function () { cancelEdit(); });
  $('edit-modal').addEventListener('click', function (e) {
    if (e.target === $('edit-modal')) cancelEdit();
  });

  // Save the open edit: the PUT the Add button used to do. Errors
  // stay in the popup (edit-msg) so the owner can fix them; on
  // success the popup closes and the message lands on the Add
  // card, which is visible after the popup closes.
  $('btn-edit-save').addEventListener('click', async function () {
    if (!editingId) return;
    var hex = $('edit-hex').value.trim();
    if (!hex) { setMsg($('edit-msg'), 'Paste the signed transaction hex first.', false); return; }
    try {
      await saveBitcoinSettings();
      var oldTx = (S.bitcoin.txs || []).find(function (t) { return t.id === editingId; });
      var editFbVal = $('edit-fallback').value;
      var body = { txHex: hex, label: $('edit-label').value, notes: $('edit-notes').value, broadcastVia: $('edit-route').value, publicFallbackDays: editFbVal === '' ? null : parseInt(editFbVal, 10) };
      var r = await api('PUT', '/api/bitcoin/txs/' + encodeURIComponent(editingId), body);
      // A replaced hex makes the old dry-run result stale (the
      // shared-input warning clears on its own — the server
      // recomputes it from the new hexes on the next load).
      if (oldTx && oldTx.hex !== hex) { delete dryRunResults[editingId]; }
      setMsg($('btc-msg'), 'Transaction updated. TXID ' + r.tx.txid + '.', true);
      cancelEdit();
      await load();
    } catch (e) { setMsg($('edit-msg'), e.message, false); }
  });

  async function deleteTx(id) {
    try {
      await api('DELETE', '/api/bitcoin/txs/' + encodeURIComponent(id));
      delete dryRunResults[id];
      if (editingId === id) cancelEdit();
      setMsg($('btc-msg'), 'Transaction removed.', true);
      await load();
    } catch (e) { setMsg($('btc-msg'), e.message, false); }
  }

  async function saveBitcoinSettings() {
    var s = await api('PUT', '/api/settings', {
      primaryApiUrl: $('btc-primary-url').value,
      secondaryApiUrl: $('btc-secondary-url').value,
    });
    S.settings = s;
  }

  $('btn-btc-save-nodes').addEventListener('click', async function () {
    try {
      await saveBitcoinSettings();
      setMsg($('btc-nodes-msg'), 'Nodes saved.', true);
      await load();
    } catch (e) { setMsg($('btc-nodes-msg'), e.message, false); }
  });

  $('btn-btc-test-conn').addEventListener('click', async function () {
    try {
      await saveBitcoinSettings();
      await api('POST', '/api/bitcoin/connection/test', {});
      setMsg($('btc-nodes-msg'), '', true);
      await load();
    } catch (e) { setMsg($('btc-nodes-msg'), e.message, false); }
  });

  // The Add form's fallback row (0.7.17): shown only while the route
  // is Slipstream — when the route is public the setting is stored
  // but ignored, and the row hides. The note under the select says
  // what the chosen duration means.
  function syncAddFallbackRow() {
    var slip = $('btc-route').value === 'slipstream';
    $('btc-fallback-row').style.display = slip ? '' : 'none';
    if (slip) {
      var v = $('btc-fallback').value;
      $('btc-fallback-note').textContent = fallbackAddNote(v === '' ? null : parseInt(v, 10));
    }
  }
  $('btc-route').addEventListener('change', syncAddFallbackRow);
  $('btc-fallback').addEventListener('change', syncAddFallbackRow);

  // The Add card is add-only now (0.7.16 amendment): editing lives
  // in the popup, so this button always POSTs a new transaction.
  // After a successful add the form clears, ready for the next one.
  $('btn-btc-add').addEventListener('click', async function () {
    var hex = $('btc-hex').value.trim();
    if (!hex) { setMsg($('btc-msg'), 'Paste the signed transaction hex first.', false); return; }
    try {
      await saveBitcoinSettings();
      var fbVal = $('btc-fallback').value;
      var body = { txHex: hex, label: $('btc-label').value, notes: $('btc-notes').value, broadcastVia: $('btc-route').value, publicFallbackDays: fbVal === '' ? null : parseInt(fbVal, 10) };
      var r = await api('POST', '/api/bitcoin/txs', body);
      setMsg($('btc-msg'), 'Transaction added and armed. TXID ' + r.tx.txid + ' — use the toggle to unarm it.', true);
      $('btc-label').value = '';
      $('btc-notes').value = '';
      $('btc-hex').value = '';
      $('btc-route').value = 'public';
      $('btc-fallback').value = '';
      syncAddFallbackRow();
      await load();
    } catch (e) { setMsg($('btc-msg'), e.message, false); }
  });

  // Import a signed transaction from a file: the file's hex is put
  // in the "Signed transaction" box — it does NOT add the
  // transaction. The user adds a label/note in the fields and clicks
  // "+ Add transaction" (the normal paste path) to add it, or Save
  // changes in the edit popup. A hex file goes straight in the box;
  // a PSBT file is finalized server-side (preview endpoint) first
  // and the extracted raw hex goes in the box. A PSBT that is not
  // fully signed is rejected by the server with the inputs named,
  // and the box is left alone. Shared by the Add card (btc-*) and
  // the edit popup (edit-*) — hexId/msgId/fileId name the targets.
  // A successful import just fills the hex box; there is no success
  // message (the filled box is the confirmation). Errors still
  // report through msgId.
  function base64OfBytes(bytes) {
    var bin = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function importTxFile(file, hexId, msgId, fileId) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        var bytes = new Uint8Array(reader.result);
        var text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
        if (/^[0-9a-fA-F]+$/.test(text) && text.length > 0 && text.length % 2 === 0) {
          // Hex file: put the hex straight in the box.
          $(hexId).value = text;
        } else if (bytes.length >= 5 && bytes[0] === 0x70 && bytes[1] === 0x73 && bytes[2] === 0x62 && bytes[3] === 0x74 && bytes[4] === 0xff) {
          // Raw binary PSBT: finalize it server-side, then put the
          // extracted hex in the box. Base64-encoded here so it
          // survives the JSON body.
          var r = await api('POST', '/api/bitcoin/txs/preview', { format: 'psbt', data: base64OfBytes(bytes) });
          $(hexId).value = r.hex;
        } else {
          // Base64 PSBT text: finalize it server-side the same way.
          var b64 = text.replace(/\s+/g, '');
          var decodesToPsbt = false;
          if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0) {
            try { var raw = atob(b64); decodesToPsbt = raw.slice(0, 4) === 'psbt' && raw.charCodeAt(4) === 0xff; } catch (e) { /* not base64 */ }
          }
          if (decodesToPsbt) {
            var r2 = await api('POST', '/api/bitcoin/txs/preview', { format: 'psbt', data: text });
            $(hexId).value = r2.hex;
          } else {
            // Neither hex nor a PSBT — say so plainly instead of
            // sending it as a PSBT and getting a PSBT error back.
            setMsg($(msgId), 'This file does not look like a signed transaction. Import a plain hex file or a fully-signed PSBT (.psbt).', false);
          }
        }
      } catch (e) { setMsg($(msgId), e.message, false); }
      $(fileId).value = '';
    };
    reader.onerror = function () { setMsg($(msgId), 'Could not read that file.', false); $(fileId).value = ''; };
    reader.readAsArrayBuffer(file);
  }
  $('btn-btc-import-file').addEventListener('click', function () { $('btc-file').click(); });
  $('btc-file').addEventListener('change', function () {
    importTxFile($('btc-file').files && $('btc-file').files[0], 'btc-hex', 'btc-msg', 'btc-file');
  });
  $('btn-edit-import-file').addEventListener('click', function () { $('edit-file').click(); });
  $('edit-file').addEventListener('change', function () {
    importTxFile($('edit-file').files && $('edit-file').files[0], 'edit-hex', 'edit-msg', 'edit-file');
  });

  // The modal does double duty: a confirmation dialog (Broadcast Now,
  // Broadcast All, Delete — Proceed + Cancel) and a details pop-out
  // (a broadcast log entry — no Proceed, Cancel reads "Close").
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var confirmPending = null;
  function showConfirm(title, body, onProceed, proceedLabel) {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('modal-details').innerHTML = '';
    $('confirm-proceed').style.display = '';
    $('confirm-proceed').textContent = proceedLabel || 'Proceed';
    $('confirm-cancel').textContent = 'Cancel';
    confirmPending = onProceed;
    $('confirm-modal').classList.add('open');
  }
  function showDetails(title, body, detailsHtml) {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('modal-details').innerHTML = detailsHtml;
    $('confirm-proceed').style.display = 'none';
    $('confirm-cancel').textContent = 'Close';
    confirmPending = null;
    $('confirm-modal').classList.add('open');
  }
  function hideConfirm() {
    $('confirm-modal').classList.remove('open');
    confirmPending = null;
    // A new API key lives only in this page's memory, and only while
    // its pop-out is open: closing the pop-out any way (the X, the
    // Close button, or the backdrop) drops the plaintext and empties
    // the pop-out, so the key is never shown again — not even on this
    // page. Harmless for the other modal uses (their details are
    // rebuilt on every open).
    newKeyPlain = null;
    $('modal-details').innerHTML = '';
  }
  $('confirm-proceed').addEventListener('click', function () {
    var fn = confirmPending;
    hideConfirm();
    if (fn) fn();
  });
  $('confirm-cancel').addEventListener('click', hideConfirm);
  $('confirm-modal').addEventListener('click', function (e) {
    if (e.target === $('confirm-modal')) hideConfirm();
  });
  // The X in the modal's top-right corner closes it, like Cancel.
  // Guarded: a mixed tree (new script, old page) must degrade to a
  // missing X, not a dead page — the modal still closes via Cancel
  // or the backdrop.
  var modalX = $('modal-x');
  if (modalX) modalX.addEventListener('click', hideConfirm);

  // The "Your connection IP is:" line fills itself in from the host this
  // page was opened on — that host IS this Pi (LAN IP, umbrel.local,
  // or Tailscale IP), so the receiver address is always right and
  // nothing needs typing in by hand. The server can't know the LAN
  // address (the container only sees its own bridge IP), which is
  // why the page does it. Called once at startup; the line is static
  // HTML, so nothing re-renders it. One address for every connection
  // method — the check-in endpoint, the health check, and any client
  // all hang off it, so the card shows only the address and the key.
  function fillConnectLine() {
    var host = window.location.hostname || 'localhost';
    var el = $('api-keys-receiver-url');
    if (el) el.textContent = 'http://' + host + ':3101';
  }
  fillConnectLine();

  // A broadcast log entry, clicked: the full details of that entry in
  // a pop-out — the full TXID, what happened, and the full signed hex
  // of the transaction (looked up from the stored list by TXID; the
  // log itself still only carries a short preview). If the transaction
  // is no longer stored, the preview is all that is left.
  function showBroadcastDetails(e) {
    var tx = (S.bitcoin.txs || []).find(function (t) { return t.txid === e.txid; });
    var hex = tx ? tx.hex : null;
    var body = (e.kind || '') + ' — ' + (e.status || '') + (e.method ? ' (' + methodLabel(e.method) + ')' : '');
    var html = '<dl class="kv">'
      + '<dt>TXID</dt><dd>' + escapeHtml(e.txid || '') + '</dd>'
      + '<dt>Kind</dt><dd>' + escapeHtml(e.kind || '') + '</dd>'
      + '<dt>Status</dt><dd>' + escapeHtml(e.status || '') + '</dd>'
      + '<dt>Method</dt><dd>' + escapeHtml(e.method ? methodLabel(e.method) : '—') + '</dd>'
      + '<dt>When</dt><dd>' + escapeHtml(fmtDate(e.ts)) + '</dd>'
      + '</dl>'
      + (e.note ? '<p class="muted">' + escapeHtml(e.note) + '</p>' : '')
      + '<h3>Signed transaction (hex)</h3>'
      + '<pre>' + escapeHtml(hex || ((e.hexPreview || '') + ' — this transaction is no longer stored, so only the logged preview is available.')) + '</pre>';
    showDetails('Broadcast log entry', body, html);
  }

  function broadcastResultText(r) {
    if (!r) return '';
    if (r.action === 'broadcast') return 'Broadcast via the ' + methodLabel(r.method) + ' node.';
    if (r.action === 'stale') return 'Not broadcast — stale: ' + (r.error || 'inputs spent') + '.';
    if (r.action === 'skipped') return 'Skipped — ' + (r.reason || 'already broadcast') + '.';
    return 'Broadcast failed: ' + (r.error || 'unknown error') + '.';
  }

  // Broadcast Now: one transaction, immediately, on the owner's word.
  // The dialog says plainly that the funds move for real.
  async function broadcastNow(id) {
    var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === id; });
    if (!tx || tx.broadcasted) return;
    var label = tx.label || 'Untitled transaction';
    showConfirm('Broadcast this transaction?',
      'This will broadcast "' + label + '" to the network for real — the funds move and it cannot be undone. The inputs are re-checked first (a stale transaction is not sent), then it broadcasts via the primary node, falling back to the secondary if the primary does not answer.',
      async function () {
        try {
          var r = await api('POST', '/api/bitcoin/txs/' + encodeURIComponent(id) + '/broadcast', {});
          setMsg($('btc-all-msg'), broadcastResultText(r), r.action === 'broadcast');
          await load();
          await refreshConfirmations();
        } catch (e) { setMsg($('btc-all-msg'), e.message, false); }
      },
      'Broadcast — I understand');
  }

  // The manual escape hatch for a slow MARA tx (0.7.16, Pending
  // card): broadcast a Slipstream-pending transaction publicly
  // instead. MANUAL ONLY — it is not part of Broadcast All or the
  // release. The confirm names the privacy cost: the tx is
  // currently private in MARA's mempool, and broadcasting it
  // publicly puts it in the public mempool, visible to everyone.
  // On success the tx becomes public-pending (and follows the
  // normal path from there: confirmed -> Archived). On failure the
  // error is surfaced and the tx stays Slipstream-pending.
  async function broadcastPublic(id) {
    var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === id; });
    if (!tx || !(tx.release && tx.release.status === 'submitted-slipstream')) return;
    var label = tx.label || 'Untitled transaction';
    showConfirm('Broadcast this transaction publicly?',
      'This will broadcast "' + label + '" to the PUBLIC mempool for real — the funds move and it cannot be undone. It is currently waiting on MARA Slipstream, where it stays private until MARA mines it. Broadcasting publicly makes it visible to everyone in the public mempool — it gives up the Slipstream privacy. The inputs are re-checked first (a stale transaction is not sent), then it broadcasts via the primary node, falling back to the secondary if the primary does not answer.',
      async function () {
        try {
          var r = await api('POST', '/api/bitcoin/txs/' + encodeURIComponent(id) + '/broadcast-public', {});
          setMsg($('btc-all-msg'), broadcastResultText(r), r.action === 'broadcast');
          await load();
          await refreshConfirmations();
        } catch (e) { setMsg($('btc-all-msg'), e.message, false); }
      },
      'Broadcast publicly — I understand');
  }

  // Broadcast All (round 12, revised): two separate buttons on the
  // main card — "Broadcast all" and "Broadcast armed" — each with
  // its own confirmation dialog. "Broadcast all" sends every
  // unbroadcasted transaction including unarmed ones; "Broadcast
  // armed" sends only the armed ones; Cancel sends nothing. Each
  // dialog names the count, and once the owner proceeds, a status
  // pop-out says what is being attempted and then what completed,
  // one line per transaction, so a mixed result (one broadcast, one
  // stale) is legible instead of a single aggregate line. The
  // pop-out stays open until the owner closes it; closing it
  // mid-run leaves it closed and lets the aggregate line below the
  // buttons speak. The archived and pending ones are never
  // attempted or counted: their ids are not sent, and the server
  // skips them too. A Slipstream-pending tx is never broadcast
  // publicly by Broadcast All — the public escape hatch is a
  // separate manual button on its card.
  async function broadcastAll() {
    var pending = (S.bitcoin.txs || []).filter(function (t) { return !txStatus(t).settled && !txStatus(t).pending; });
    if (!pending.length) {
      setMsg($('btc-all-msg'),
        (S.bitcoin.txs || []).length
          ? 'Nothing to broadcast — every transaction is already archived or pending.'
          : 'Nothing to broadcast — no transactions stored.',
        true);
      return;
    }
    showConfirm('Broadcast all transactions?',
      'This will broadcast for real — the funds move and it cannot be undone. This sends all ' + pending.length + ' unbroadcasted transaction(s), including unarmed ones. Each one is checked first (a stale one is skipped, not sent) and broadcasts via the primary node, falling back to the secondary if the primary does not answer.',
      function () { runBroadcastAll(pending, false, 'Broadcast all'); },
      'Broadcast — I understand');
  }

  // Broadcast Armed: the same path as Broadcast All, but only the
  // armed unbroadcasted transactions — the unarmed ones are left
  // alone. The armed-only filter is applied client-side (which ids
  // are sent) AND server-side (the armedOnly flag), so a stale or
  // disarmed id in the request is still never broadcast.
  async function broadcastArmed() {
    var pending = (S.bitcoin.txs || []).filter(function (t) { return !txStatus(t).settled && !txStatus(t).pending; });
    if (!pending.length) {
      setMsg($('btc-all-msg'),
        (S.bitcoin.txs || []).length
          ? 'Nothing to broadcast — every transaction is already archived or pending.'
          : 'Nothing to broadcast — no transactions stored.',
        true);
      return;
    }
    var armed = pending.filter(function (t) { return t.enabled; });
    if (!armed.length) {
      setMsg($('btc-all-msg'), 'Nothing to broadcast — no armed transactions to broadcast.', true);
      return;
    }
    showConfirm('Broadcast armed transactions?',
      'This will broadcast for real — the funds move and it cannot be undone. This sends only the ' + armed.length + ' armed transaction(s); unarmed ones are left alone. Each one is checked first (a stale one is skipped, not sent) and broadcasts via the primary node, falling back to the secondary if the primary does not answer.',
      function () { runBroadcastAll(armed, true, 'Broadcast armed'); },
      'Broadcast — I understand');
  }

  // The actual Broadcast All run, shared by both buttons: the same
  // progress pop-out, the same POST (armedOnly only for the armed
  // button), the same per-transaction results. Nothing is broadcast
  // until the owner confirms in the dialog.
  async function runBroadcastAll(targets, armedOnly, label) {
    if (!targets.length) {
      setMsg($('btc-all-msg'), 'Nothing to broadcast — no armed transactions to broadcast.', true);
      return;
    }
    var names = targets.map(function (t) { return t.label || 'Untitled transaction'; });
    showDetails(label + ' — broadcasting',
      'Attempting to broadcast ' + targets.length + ' transaction(s)…',
      '<ul class="plain-list">' + names.map(function (n) {
        return '<li>' + escapeHtml(n) + ' — pending…</li>';
      }).join('') + '</ul>');
    try {
      var body = { ids: targets.map(function (t) { return t.id; }) };
      if (armedOnly) body.armedOnly = true;
      var r = await api('POST', '/api/broadcast/all', body);
      var sent = (r.results || []).filter(function (x) { return x.action === 'broadcast'; }).length;
      var stale = (r.results || []).filter(function (x) { return x.action === 'stale'; }).length;
      var failed = (r.results || []).filter(function (x) { return x.action === 'failed'; }).length;
      var summary = label + ': ' + sent + ' broadcast' + (stale ? ', ' + stale + ' stale' : '') + (failed ? ', ' + failed + ' failed' : '') + '.';
      setMsg($('btc-all-msg'), summary, failed === 0);
      await load();
      await refreshConfirmations();
      if ($('confirm-modal').classList.contains('open')) {
        showDetails(label + ' — ' + (failed ? 'finished with failures' : 'complete'),
          summary,
          '<ul class="plain-list">' + (r.results || []).map(function (x) {
            return '<li>' + escapeHtml(x.label || 'Untitled transaction') + ' — ' + escapeHtml(broadcastResultText(x)) + '</li>';
          }).join('') + '</ul>');
      }
    } catch (e) {
      setMsg($('btc-all-msg'), e.message, false);
      if ($('confirm-modal').classList.contains('open')) showDetails(label + ' — failed', e.message, '');
    }
  }

  $('btn-btc-broadcast-all').addEventListener('click', broadcastAll);
  $('btn-btc-broadcast-armed').addEventListener('click', broadcastArmed);

  $('btn-btc-test-all').addEventListener('click', async function () {
    var before = inactiveIds();
    try {
      var r = await api('POST', '/api/broadcast/test', {});
      // Each transaction's own result goes in its own card; the line
      // below is only the aggregate.
      (r.results || []).forEach(function (one) {
        if (one.id) dryRunResults[one.id] = { text: 'Dry-run: ' + (one.note || one.error || ''), ok: !!one.wouldBroadcast,
          verdict: one.verdict || '',
          spent: !!(one.spent && one.spent.length), unknown: !!(one.unknown && one.unknown.length), error: !!one.error };
      });
      // The shared-input warnings come from the state on the next
      // load (renderBitcoin derives them from the stored
      // transactions), so there is nothing to keep from this run —
      // the aggregate note below still names the shared inputs.
      // The aggregate line is amber (not red) when the only reason
      // nothing would broadcast is timelocks: a timelocked dry-run
      // is a warning, not a failure, and the release will retry it.
      var anyTimelocked = (r.results || []).some(function (one) { return one.verdict === 'timelocked'; });
      setMsg($('btc-all-msg'), 'Dry-run: ' + (r.note || '') + ' Nothing was broadcast.', r.wouldBroadcast ? true : (anyTimelocked ? 'warn' : false));
      await load();
      // The ones this run found spent move to Archived — pop up a
      // notice naming them (only the ones that moved in this run).
      var moved = (r.results || []).filter(function (one) { return one.spent && one.spent.length; })
        .map(function (one) { return { id: one.id, label: one.label || '' }; });
      noticeMovedToArchive(before, moved);
      // Same for the ones this run found already out there (own txid)
      // — a different notice, with the broadcast wording.
      var movedOut = (r.results || []).filter(function (one) { return one.verdict === 'broadcast'; })
        .map(function (one) { return { id: one.id, label: one.label || '' }; });
      noticeMovedToArchive(before, movedOut, 'broadcast');
    } catch (e) { setMsg($('btc-all-msg'), e.message, false); }
  });

  // Confirmation counts for broadcast transactions, refreshed from the
  // network. The UI polls this every minute while any transaction is
  // broadcast, so the number stays accurate without a reload; the
  // server also refreshes it on the hourly tick. Best-effort: a failed
  // refresh keeps the last known value on the card.
  async function refreshConfirmations() {
    var txs = (S && S.bitcoin.txs || []).filter(function (t) { return t.broadcasted; });
    if (!txs.length) return;
    try {
      var r = await api('GET', '/api/bitcoin/confirmations');
      var bucketChanged = false;
      (r.confirmations || []).forEach(function (c) {
        var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === c.id; });
        if (tx && tx.broadcasted) {
          var before = txStatus(tx);
          tx.broadcasted.confirmations = c.confirmations;
          tx.broadcasted.blockHeight = c.blockHeight;
          tx.broadcasted.found = c.found;
          tx.broadcasted.checkedAt = c.checkedAt;
          var after = txStatus(tx);
          if (before.settled !== after.settled || before.pending !== after.pending) bucketChanged = true;
        }
        var card = txCardEls[c.id];
        if (card && card.sentLine && tx) card.sentLine.textContent = txBroadcastLine(tx);
        // The pill follows the network verdict too: a broadcast the
        // network no longer knows flips Broadcasted -> Failed (and
        // back if it shows up again) without waiting for a reload.
        if (card && card.pill && tx) {
          var pst = txStatus(tx);
          card.pill.textContent = pst.label;
          card.pill.className = 'pill ' + pst.cls;
        }
      });
      // A tx that changed buckets (pending -> archived on its first
      // confirmation, or back if it drops out of the mempool) needs
      // a re-render so its card moves lists — the in-place pill
      // update above cannot move it. load() is safe here: the bucket
      // is stable after the move (confirmations only go up, and a
      // Failed card stays archived), and the server caches a
      // confirmation check for 60s, so the re-render's own refresh
      // reads the same values and does not loop.
      if (bucketChanged) await load();
    } catch (e) { /* the last known value stays on the card */ }
  }
  setInterval(refreshConfirmations, 60 * 1000);

  // ---------- settings ----------
  function renderSettings() {
    $('set-threshold').value = S.settings.thresholdDays;
    $('set-vacation').checked = !!S.settings.vacationMode;
    $('set-vacation-until').value = S.settings.vacationUntil || '';
    var ps = $('pause-state');
    if (S.settings.paused) { ps.textContent = 'Paused'; ps.className = 'pill warn'; }
    else if (S.settings.vacationMode) { ps.textContent = 'Vacation mode'; ps.className = 'pill muted'; }
    else { ps.textContent = 'Active'; ps.className = 'pill ok'; }
    renderApiKeys();
  }

  $('btn-save-settings').addEventListener('click', async function () {
    try {
      var s = await api('PUT', '/api/settings', {
        thresholdDays: parseInt($('set-threshold').value, 10),
      });
      S.settings = s;
      setMsg($('settings-msg'), 'Settings saved.', true);
      await load();
    } catch (e) { setMsg($('settings-msg'), e.message, false); }
  });

  $('btn-save-vacation').addEventListener('click', async function () {
    try {
      var s = await api('PUT', '/api/settings', {
        vacationMode: $('set-vacation').checked,
        vacationUntil: $('set-vacation-until').value,
      });
      S.settings = s;
      setMsg($('vacation-msg'), 'Vacation settings saved.', true);
      await load();
    } catch (e) { setMsg($('vacation-msg'), e.message, false); }
  });

  $('btn-pause').addEventListener('click', async function () {
    try {
      await api('POST', '/api/pause', {});
      setMsg($('pause-msg'), 'Releases paused.', true);
      await load();
    } catch (e) { setMsg($('pause-msg'), e.message, false); }
  });

  $('btn-resume').addEventListener('click', async function () {
    try {
      await api('POST', '/api/resume', {});
      setMsg($('pause-msg'), 'Resumed.', true);
      await load();
    } catch (e) { setMsg($('pause-msg'), e.message, false); }
  });

  // ---------- check-in API keys ----------
  // One labelled key per service that may check in for the owner. The
  // plaintext key is shown ONCE, when it is created, in a pop-out —
  // it lives only in this page's memory afterwards (closing the
  // pop-out drops it for good; a reload hides it too; the list keeps
  // showing the key's label and last-used time, never the key
  // itself). Revoking one key leaves the others working.
  var apiKeys = []; // { id, label, createdAt, lastUsedAt }
  var newKeyPlain = null; // the plaintext of the key just created, until its pop-out closes

  function renderApiKeys() {
    var list = $('api-keys-list');
    list.innerHTML = '';
    if (!apiKeys.length) {
      var none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'No API keys yet.';
      list.appendChild(none);
      return;
    }
    apiKeys.forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'api-key-row';
      var name = document.createElement('b');
      name.textContent = k.label || 'Untitled key';
      var meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = 'created ' + fmtDate(k.createdAt) + ' · last used ' + (k.lastUsedAt ? fmtDate(k.lastUsedAt) : 'never');
      var del = document.createElement('button');
      del.textContent = 'Revoke';
      del.className = 'danger';
      del.addEventListener('click', function () { revokeApiKey(k.id, k.label); });
      row.appendChild(name); row.appendChild(meta); row.appendChild(del);
      list.appendChild(row);
    });
  }

  function revokeApiKey(id, label) {
    showConfirm('Revoke this key?',
      'This revokes the key labelled "' + (label || 'Untitled key') + '". The service using it will no longer be able to check in. Other keys are unaffected.',
      async function () {
        try {
          await api('DELETE', '/api/checkin-keys/' + encodeURIComponent(id));
          apiKeys = apiKeys.filter(function (k) { return k.id !== id; });
          renderApiKeys();
          setMsg($('api-keys-msg'), 'Key revoked.', true);
        } catch (e) { setMsg($('api-keys-msg'), e.message, false); }
      },
      'Revoke');
  }

  // The new-key pop-out: the key, a Copy key button, and an X to
  // close it (the modal's own X, the Close button, or the backdrop —
  // all go through hideConfirm, which drops the plaintext and
  // empties the pop-out, so the key is never shown again). Built
  // from real elements, not an HTML string, so the Copy button has
  // a real click handler.
  function showNewKeyModal() {
    $('confirm-title').textContent = 'Your new key';
    $('confirm-body').textContent = 'Your new key — copy it now, it will not be shown again.';
    var details = $('modal-details');
    details.innerHTML = '';
    var input = document.createElement('input');
    input.id = 'new-key-value';
    input.type = 'text';
    input.readOnly = true;
    input.value = newKeyPlain || '';
    details.appendChild(input);
    var copyBtn = document.createElement('button');
    copyBtn.id = 'btn-key-copy';
    copyBtn.className = 'primary';
    copyBtn.textContent = 'Copy key';
    copyBtn.addEventListener('click', copyNewKey);
    details.appendChild(copyBtn);
    $('confirm-proceed').style.display = 'none';
    $('confirm-cancel').textContent = 'Close';
    confirmPending = null;
    $('confirm-modal').classList.add('open');
  }

  async function copyNewKey() {
    var el = $('new-key-value');
    var copied = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(newKeyPlain || (el && el.value) || '');
        copied = true;
      }
    } catch (e) { copied = false; }
    if (!copied && el && typeof el.select === 'function' && typeof document.execCommand === 'function') {
      try { el.select(); document.execCommand('copy'); copied = true; } catch (e) { copied = false; }
    }
    setMsg($('api-keys-msg'), copied ? 'Key copied.' : 'Copy failed — select the key and copy it by hand.', copied);
  }

  $('btn-api-key-create').addEventListener('click', async function () {
    try {
      var r = await api('POST', '/api/checkin-keys', { label: $('api-key-label').value });
      apiKeys.push(r.key);
      $('api-key-label').value = '';
      newKeyPlain = r.plain;
      showNewKeyModal();
      renderApiKeys();
      setMsg($('api-keys-msg'), 'Key created — copy it now. It will not be shown again.', true);
    } catch (e) { setMsg($('api-keys-msg'), e.message, false); }
  });

  // ---------- data backup ----------
  $('btn-backup-download').addEventListener('click', async function () {
    try {
      var backup = await api('GET', '/api/backup');
      var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'standby-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      if (document.body) document.body.appendChild(a);
      a.click();
      if (document.body) document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMsg($('backup-msg'), 'Backup downloaded.', true);
    } catch (e) { setMsg($('backup-msg'), e.message, false); }
  });

  $('btn-backup-restore').addEventListener('click', function () { $('backup-file').click(); });

  $('backup-file').addEventListener('change', async function () {
    var file = $('backup-file').files && $('backup-file').files[0];
    if (!file) return;
    try {
      var text = await new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(new Error('could not read the backup file')); };
        reader.readAsText(file);
      });
      var backup = JSON.parse(text);
      var r = await api('POST', '/api/restore', backup);
      setMsg($('backup-msg'), 'Restored ' + r.restoredTxs + ' transaction(s) and settings from the backup.', true);
      $('backup-file').value = '';
      await load();
    } catch (e) { setMsg($('backup-msg'), e.message, false); }
  });

  load().catch(function (e) {
    document.querySelector('main').insertAdjacentHTML('afterbegin',
      '<div class="notice bad">Could not load Standby state: ' + e.message + '</div>');
  });
})();
