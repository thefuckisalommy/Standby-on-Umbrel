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
    // The day counts ride on the date rows instead of their own row:
    // "11/11/2026, 9:00 AM (0 days)" and "12/16/2026, 9:00 AM
    // (35 days)". No seconds on either time.
    $('last-checkin').textContent = status.lastCheckinAt
      ? fmtDateShort(status.lastCheckinAt) + ' (' + fmtDays(status.daysSince) + ')'
      : '—';
    $('next-due').textContent = status.nextDue
      ? fmtDateShort(status.nextDue) + ' (' + fmtDays(daysUntil(status.nextDue)) + ')'
      : '—';
    // The count is the transactions NOT in the Archived Transactions
    // card (broadcasted or stale) — the archived ones will never
    // broadcast at release, so they are not counted here.
    var activeTxs = (S.bitcoin.txs || []).filter(function (t) { return !txStatus(t).settled; });
    var armedActive = activeTxs.filter(function (t) { return t.enabled; }).length;
    $('readiness-btc').textContent = activeTxs.length
      ? armedActive + ' of ' + activeTxs.length + ' transaction(s) armed'
      : (S.bitcoin.txs || []).length
        ? 'No active transactions — every stored transaction is archived'
        : 'No transactions stored (no broadcast at release)';
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

  $('btn-checkin').addEventListener('click', async function () {
    try {
      var r = await api('POST', '/api/checkin', { method: 'app' });
      setMsg($('checkin-msg'), 'Checked in just now.' + (r.autoResumed ? ' Pause cleared automatically.' : ''), true);
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
  // it by default — the toggle disarms it. The dry-run buttons check
  // the inputs are still unspent and NEVER broadcast. Notes say what
  // each tx is for, at a glance, in the list.
  var editingId = null; // id of the tx loaded into the add form, or null
  var dryRunResults = {}; // tx id -> { text, ok, verdict, spent, unknown, error }: the last dry-run result per transaction, shown in its own card. The *line* is page memory only — but a spent verdict is also recorded on the transaction server-side (a stale release record), a conflict verdict the same way (a conflict release record — a warning, not a verdict), and an own-txid verdict as a broadcast record, so the Stale / Conflict / Broadcasted status itself survives a refresh.
  var txCardEls = {}; // tx id -> { row, sentLine }: the rendered card, so the confirmations poll can update the sent line in place

  function txStats(tx) {
    return tx.inputs + ' in / ' + tx.outputs + ' out, ' + tx.totalOutSats + ' sats out, locktime ' + tx.locktime
      + (tx.segwit ? ', segwit' : '') + ', stored ' + fmtDate(tx.createdAt);
  }

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
      : (m || '');
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
    if (rel.status === 'stale') return 'Stale — ' + (rel.error || 'inputs spent') + '. Replace the transaction to re-arm.';
    return 'Failed — ' + (rel.error || 'unknown error') + '. Will retry on the next hourly check.';
  }

  // The overall status of one transaction, shown as a pill at the
  // top-right of its label row. Precedence: a broadcasted tx the
  // network no longer knows is Failed — the node accepted it, then
  // it was dropped from the mempool (or replaced by the other
  // transaction sharing its inputs); the broadcast line on the card
  // says so. A broadcasted tx the network knows is Broadcasted (and
  // a release record that says 'broadcast' counts as Broadcasted
  // even without the broadcasted fact — a restore can carry one half
  // of the pair); inputs declared spent is Stale — the spent verdict
  // is recorded on the transaction (by the release, a manual
  // broadcast, or a dry-run), so it survives refreshes and check-ins
  // and the card stays in the Archived Transactions card; an input
  // spent by another transaction that is NOT confirmed yet is
  // Conflict — a warning, not a verdict: the card stays active (not
  // archived, not stale) and a broadcast is still attempted, and a
  // later clean check clears it; a dry-run that could not reach the
  // nodes is Node Failure; a failed release is Failed; a dry-run
  // that could not say either way is Unverified; otherwise an armed
  // tx is Ready and a disarmed one is Disabled. `settled` marks a
  // card whose body is collapsed and whose dry-run / edit buttons
  // are disabled — a broadcasted, failed, or stale transaction.
  function txStatus(tx) {
    var dr = dryRunResults[tx.id] || null;
    if (tx.broadcasted || (tx.release && tx.release.status === 'broadcast')) {
      if (tx.broadcasted && tx.broadcasted.found === false) return { label: 'Failed', cls: 'bad', settled: true };
      return { label: 'Broadcasted', cls: 'ok', settled: true };
    }
    if ((tx.release && tx.release.status === 'stale') || (dr && dr.spent)) {
      return { label: 'Stale', cls: 'bad', settled: true };
    }
    // Absolute-locktime warning (0.7.14): the transaction carries a
    // locktime that has not passed yet, so the node would reject it as
    // non-final. The card stays active with a warning pill — and the
    // broadcast is not gated on it, the retry fix retakes the
    // transaction once the locktime passes. Precedence matches the
    // dry-run: a timelock beats a conflict.
    if (dr && dr.verdict === 'timelocked') {
      return { label: 'Timelocked', cls: 'warn', settled: false };
    }
    if (dr && dr.error) return { label: 'Node Failure', cls: 'warn', settled: false };
    // Unconfirmed-spend warning (0.7.12, finding 1): another
    // transaction spends an input, but it is not confirmed yet and
    // may still be evicted — so the card stays active with a warning
    // pill, and Broadcast Now / a release run still attempt it. The
    // server re-derives the warning on every fresh check: a clean
    // verdict clears it, a confirmed spend turns it stale.
    if ((tx.release && tx.release.status === 'conflict') || (dr && dr.verdict === 'conflict')) {
      return { label: 'Conflict', cls: 'warn', settled: false };
    }
    if (tx.release && tx.release.status === 'failed') {
      var e = tx.release.error || '';
      var node = e.indexOf('input check failed') !== -1 || e.indexOf('could not reach') !== -1;
      return node
        ? { label: 'Node Failure', cls: 'warn', settled: false }
        : { label: 'Failed', cls: 'warn', settled: false };
    }
    if (dr && dr.unknown) return { label: 'Unverified', cls: 'muted', settled: false };
    if (!tx.enabled) return { label: 'Disabled', cls: 'muted', settled: false };
    return { label: 'Ready', cls: 'ok', settled: false };
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
    // A settled card gets no warning: its fate is already decided.
    // The detection itself still looks at every stored transaction,
    // because a broadcasted one is exactly why another one sharing
    // its input can never broadcast. Editing a transaction to spend
    // a different input removes it from the shared set, and the
    // warning clears on the next load.
    var overlapsByTx = {};
    (S.bitcoin.overlaps || []).forEach(function (ov) {
      ov.txIds.forEach(function (tid) {
        var tx = (S.bitcoin.txs || []).find(function (y) { return y.id === tid; });
        if (tx && txStatus(tx).settled) return;
        var others = ov.txIds.filter(function (x) { return x !== tid; }).map(function (x) {
          var t = (S.bitcoin.txs || []).find(function (y) { return y.id === x; });
          return t ? ('"' + (t.label || 'Untitled transaction') + '"') : x;
        }).join(', ');
        (overlapsByTx[tid] = overlapsByTx[tid] || []).push({ input: ov.input, others: others });
      });
    });
    // The two lists: the ones still waiting live inside the
    // Pre-signed Bitcoin transactions card, below the Dry-run All /
    // Broadcast All buttons; the settled ones (broadcasted or stale)
    // live in the Archived Transactions card.
    var activeList = $('btc-active-list');
    var archivedList = $('btc-archived-list');
    activeList.innerHTML = '';
    archivedList.innerHTML = '';
    txCardEls = {};
    // Newest first. The sort is render-time only: the release still
    // evaluates stored transactions in stored order.
    var sorted = txs.slice().reverse().sort(function (a, b) {
      return (txStatus(a).settled ? 1 : 0) - (txStatus(b).settled ? 1 : 0);
    });
    sorted.forEach(function (tx) {
      var row = document.createElement('div');
      row.className = 'tx-card tx-sub';
      var st = txStatus(tx);
      var settled = st.settled;
      // The status pill lives in the label row, top-right. The label
      // takes the space that is left and wraps inside it, so it can
      // never run over the pill — and the pill is in the same spot
      // (the card's top-right corner) no matter how long the label is.
      var head = document.createElement('div');
      head.className = 'tx-head';
      var title = document.createElement('b');
      title.textContent = tx.label || 'Untitled transaction';
      var txid = document.createElement('span');
      txid.className = 'txid';
      txid.textContent = tx.txid.slice(0, 16) + '…';
      var pill = document.createElement('span');
      pill.className = 'pill ' + st.cls;
      pill.textContent = st.label;
      head.appendChild(title); head.appendChild(txid); head.appendChild(pill);
      row.appendChild(head);
      // The arm/disarm toggle is always its own row below the label
      // — never sharing the label row. It is gone entirely on a
      // settled card (broadcasted or stale).
      if (!settled) {
        var armRow = document.createElement('div');
        armRow.className = 'tx-arm';
        var tog = document.createElement('label');
        tog.className = 'switch';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!tx.enabled;
        cb.addEventListener('change', function () { toggleTx(tx.id, cb.checked); });
        var slider = document.createElement('span');
        slider.className = 'slider';
        var state = document.createElement('span');
        state.textContent = tx.enabled ? 'Armed' : 'Disabled';
        tog.appendChild(cb); tog.appendChild(slider); tog.appendChild(state);
        armRow.appendChild(tog);
        row.appendChild(armRow);
      }
      // A settled transaction hides everything but its label and
      // status into a collapsible, collapsed by default. The action
      // buttons stay outside it — with dry-run and edit disabled.
      var details = null, body = row;
      if (settled) {
        details = document.createElement('details');
        details.className = 'tx-details';
        var sum = document.createElement('summary');
        sum.textContent = 'Details';
        details.appendChild(sum);
        row.appendChild(details);
        body = details;
      }
      var stats = document.createElement('p');
      stats.className = 'muted';
      stats.textContent = txStats(tx);
      body.appendChild(stats);
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
      dryBtn.disabled = settled;
      if (settled) dryBtn.title = 'Transaction already broadcast or spent';
      dryBtn.addEventListener('click', function () { dryRunTx(tx.id); });
      var editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.disabled = settled;
      if (settled) editBtn.title = 'Transaction already broadcast or spent';
      editBtn.addEventListener('click', function () { startEdit(tx); });
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'danger';
      delBtn.addEventListener('click', function () {
        showConfirm('Delete this transaction?',
          'This deletes "' + (tx.label || 'Untitled transaction') + '" from Standby. It will no longer be broadcast if the release runs, and its history on this card goes with it.',
          function () { deleteTx(tx.id); },
          'Delete');
      });
      // Broadcast Now: send this transaction immediately, on the owner's
      // say-so — same path as the release, after a confirmation dialog.
      // A sent or stale transaction cannot be broadcast from its card.
      var bcBtn = document.createElement('button');
      bcBtn.textContent = 'Broadcast Now';
      bcBtn.className = 'danger';
      bcBtn.disabled = settled;
      if (tx.broadcasted) bcBtn.title = 'Already broadcast';
      else if (settled) bcBtn.title = 'Stale — inputs spent';
      else bcBtn.addEventListener('click', function () { broadcastNow(tx.id); });
      actions.appendChild(dryBtn); actions.appendChild(editBtn); actions.appendChild(delBtn); actions.appendChild(bcBtn);
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
        // must not read as 'ready'.
        dryLine.className = dr.verdict === 'timelocked' ? 'tx-dryrun tx-warn' : 'tx-dryrun muted';
        dryLine.textContent = dr.text;
        body.appendChild(dryLine);
      }
      // Shared-input warnings from the state (see renderBitcoin):
      // this tx spends an input another stored tx also spends, so
      // only one of them can ever broadcast. The input is shown
      // short so the line cannot overflow the card.
      var ow = overlapsByTx[tx.id];
      if (ow && ow.length) {
        ow.forEach(function (w) {
          var warnLine = document.createElement('p');
          warnLine.className = 'tx-warn';
          warnLine.textContent = 'Warning: shares input ' + shortInput(w.input) + ' with ' + w.others + ' — only one of them can ever broadcast.';
          body.appendChild(warnLine);
        });
      }
      txCardEls[tx.id] = { row: row, sentLine: sentLine, pill: pill };
      (settled ? archivedList : activeList).appendChild(row);
    });
    // A list with nothing in it yet says so, instead of sitting empty.
    if (!activeList.children.length) {
      var noneActive = document.createElement('p');
      noneActive.className = 'muted';
      noneActive.textContent = 'No active transactions — add one below.';
      activeList.appendChild(noneActive);
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
      setMsg($('btc-msg'), enabled ? 'Transaction armed.' : 'Transaction disarmed.', true);
      await load();
    } catch (e) { setMsg($('btc-msg'), e.message, false); await load(); }
  }

  // The ids of the transactions that are settled right now (broadcasted
  // or stale) — the ones already in the Archived Transactions card.
  function settledIds() {
    var ids = {};
    (S.bitcoin.txs || []).forEach(function (t) {
      if (txStatus(t).settled) ids[t.id] = true;
    });
    return ids;
  }
  // After a dry-run, pop up the transactions that just moved to the
  // Archived Transactions card — one line each, naming the transaction
  // and the reason (its inputs are spent). Only the ones that moved in
  // this run; if none moved, no pop-up. The broadcast cases do not
  // need one: Broadcast All already lists each transaction and its
  // outcome, and Broadcast Now shows the sent line on the card.
  function noticeMovedToArchive(before, moved, why) {
    var fresh = (moved || []).filter(function (m) { return !before[m.id]; });
    if (!fresh.length) return;
    // The moved card lands in the Archived Transactions card, which
    // is collapsed by default — open it, so the move is visible the
    // moment the pop-up closes instead of needing a refresh (and a
    // hunt for the collapsed section) to see it.
    var archived = $('archived-card');
    if (archived) archived.open = true;
    var n = fresh.length;
    // `why` is 'broadcast' when the move is a dry-run discovering
    // the transaction is already out there (0.7.12, finding 1) —
    // the wording must not say its inputs are spent.
    var broadcast = why === 'broadcast';
    showDetails('Moved to Archived Transactions',
      n + ' transaction' + (n === 1 ? '' : 's') + ' moved to Archived Transactions — ' + (broadcast
        ? 'already out there (the network reports its own txid), so recorded as broadcast.'
        : (n === 1 ? 'its' : 'their') + ' inputs are spent.'),
      '<ul class="plain-list">' + fresh.map(function (m) {
        return '<li>' + escapeHtml(m.label || 'Untitled transaction') + ' — ' + (broadcast ? 'already broadcast' : 'inputs spent') + '</li>';
      }).join('') + '</ul>');
  }

  async function dryRunTx(id) {
    var before = settledIds();
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

  function startEdit(tx) {
    editingId = tx.id;
    $('btc-label').value = tx.label || '';
    $('btc-notes').value = tx.notes || '';
    $('btc-hex').value = tx.hex || '';
    $('btc-form-title').textContent = 'Edit transaction';
    $('btn-btc-add').textContent = 'Save changes';
    $('btn-btc-cancel-edit').style.display = '';
    $('btc-label').focus();
  }

  function cancelEdit() {
    editingId = null;
    $('btc-label').value = '';
    $('btc-notes').value = '';
    $('btc-hex').value = '';
    $('btc-form-title').textContent = 'Add a transaction';
    $('btn-btc-add').textContent = '+ Add transaction';
    $('btn-btc-cancel-edit').style.display = 'none';
  }

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

  $('btn-btc-add').addEventListener('click', async function () {
    var hex = $('btc-hex').value.trim();
    if (!hex) { setMsg($('btc-msg'), 'Paste the signed transaction hex first.', false); return; }
    try {
      await saveBitcoinSettings();
      var body = { txHex: hex, label: $('btc-label').value, notes: $('btc-notes').value };
      var r;
      if (editingId) {
        var oldTx = (S.bitcoin.txs || []).find(function (t) { return t.id === editingId; });
        r = await api('PUT', '/api/bitcoin/txs/' + encodeURIComponent(editingId), body);
        // A replaced hex makes the old dry-run result stale (the
        // shared-input warning clears on its own — the server
        // recomputes it from the new hexes on the next load).
        if (oldTx && oldTx.hex !== hex) { delete dryRunResults[editingId]; }
        setMsg($('btc-msg'), 'Transaction updated. TXID ' + r.tx.txid + '.', true);
      } else {
        r = await api('POST', '/api/bitcoin/txs', body);
        setMsg($('btc-msg'), 'Transaction added and armed. TXID ' + r.tx.txid + ' — use the toggle to disarm it.', true);
      }
      cancelEdit();
      await load();
    } catch (e) { setMsg($('btc-msg'), e.message, false); }
  });

  $('btn-btc-cancel-edit').addEventListener('click', function () { cancelEdit(); });

  // Import a signed transaction from a file: the file's hex is put
  // in the "Signed transaction" box — it does NOT add the
  // transaction. The user adds a label/note in the fields and clicks
  // "+ Add transaction" (the normal paste path) to add it. A hex file
  // goes straight in the box; a PSBT file is finalized server-side
  // (preview endpoint) first and the extracted raw hex goes in the
  // box. A PSBT that is not fully signed is rejected by the server
  // with the inputs named, and the box is left alone.
  function base64OfBytes(bytes) {
    var bin = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  $('btn-btc-import-file').addEventListener('click', function () { $('btc-file').click(); });
  $('btc-file').addEventListener('change', function () {
    var file = $('btc-file').files && $('btc-file').files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        var bytes = new Uint8Array(reader.result);
        var text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
        if (/^[0-9a-fA-F]+$/.test(text) && text.length > 0 && text.length % 2 === 0) {
          // Hex file: put the hex straight in the box.
          $('btc-hex').value = text;
          setMsg($('btc-msg'), 'Hex loaded from file — add a label, then Add transaction.', true);
        } else if (bytes.length >= 5 && bytes[0] === 0x70 && bytes[1] === 0x73 && bytes[2] === 0x62 && bytes[3] === 0x74 && bytes[4] === 0xff) {
          // Raw binary PSBT: finalize it server-side, then put the
          // extracted hex in the box. Base64-encoded here so it
          // survives the JSON body.
          var r = await api('POST', '/api/bitcoin/txs/preview', { format: 'psbt', data: base64OfBytes(bytes) });
          $('btc-hex').value = r.hex;
          setMsg($('btc-msg'), 'PSBT loaded from file — add a label, then Add transaction.', true);
        } else {
          // Base64 PSBT text: finalize it server-side the same way.
          var b64 = text.replace(/\s+/g, '');
          var decodesToPsbt = false;
          if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0) {
            try { var raw = atob(b64); decodesToPsbt = raw.slice(0, 4) === 'psbt' && raw.charCodeAt(4) === 0xff; } catch (e) { /* not base64 */ }
          }
          if (decodesToPsbt) {
            var r2 = await api('POST', '/api/bitcoin/txs/preview', { format: 'psbt', data: text });
            $('btc-hex').value = r2.hex;
            setMsg($('btc-msg'), 'PSBT loaded from file — add a label, then Add transaction.', true);
          } else {
            // Neither hex nor a PSBT — say so plainly instead of
            // sending it as a PSBT and getting a PSBT error back.
            setMsg($('btc-msg'), 'This file does not look like a signed transaction. Import a plain hex file or a fully-signed PSBT (.psbt).', false);
          }
        }
      } catch (e) { setMsg($('btc-msg'), e.message, false); }
      $('btc-file').value = '';
    };
    reader.onerror = function () { setMsg($('btc-msg'), 'Could not read that file.', false); $('btc-file').value = ''; };
    reader.readAsArrayBuffer(file);
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

  // Broadcast All: the transactions NOT in the Archived Transactions
  // card (broadcasted or stale), each through the same path. The
  // dialog names the count — and once the owner proceeds, a status
  // pop-out says what is being attempted and then what completed,
  // one line per transaction, so a mixed result (one broadcast, one
  // stale) is legible instead of a single aggregate line. The pop-out
  // stays open until the owner closes it; closing it mid-run leaves
  // it closed and lets the aggregate line below the buttons speak.
  // The archived ones are never attempted or counted: their ids are
  // not sent, and the server skips them too.
  async function broadcastAll() {
    var pending = (S.bitcoin.txs || []).filter(function (t) { return !txStatus(t).settled; });
    if (!pending.length) {
      setMsg($('btc-all-msg'),
        (S.bitcoin.txs || []).length
          ? 'Nothing to broadcast — every transaction is already archived.'
          : 'Nothing to broadcast — no transactions stored.',
        true);
      return;
    }
    showConfirm('Broadcast all transactions?',
      'This will broadcast ' + pending.length + ' transaction(s) for real — the funds move and it cannot be undone. This will send all armed and disarmed transactions. Each one is checked first (a stale one is skipped, not sent) and broadcasts via the primary node, falling back to the secondary if the primary does not answer.',
      async function () {
        var names = pending.map(function (t) { return t.label || 'Untitled transaction'; });
        showDetails('Broadcasting all transactions',
          'Attempting to broadcast ' + pending.length + ' transaction(s)…',
          '<ul class="plain-list">' + names.map(function (n) {
            return '<li>' + escapeHtml(n) + ' — pending…</li>';
          }).join('') + '</ul>');
        try {
          var r = await api('POST', '/api/broadcast/all', { ids: pending.map(function (t) { return t.id; }) });
          var sent = (r.results || []).filter(function (x) { return x.action === 'broadcast'; }).length;
          var stale = (r.results || []).filter(function (x) { return x.action === 'stale'; }).length;
          var failed = (r.results || []).filter(function (x) { return x.action === 'failed'; }).length;
          var summary = 'Broadcast all: ' + sent + ' broadcast' + (stale ? ', ' + stale + ' stale' : '') + (failed ? ', ' + failed + ' failed' : '') + '.';
          setMsg($('btc-all-msg'), summary, failed === 0);
          await load();
          await refreshConfirmations();
          if ($('confirm-modal').classList.contains('open')) {
            showDetails('Broadcast all — ' + (failed ? 'finished with failures' : 'complete'),
              summary,
              '<ul class="plain-list">' + (r.results || []).map(function (x) {
                return '<li>' + escapeHtml(x.label || 'Untitled transaction') + ' — ' + escapeHtml(broadcastResultText(x)) + '</li>';
              }).join('') + '</ul>');
          }
        } catch (e) {
          setMsg($('btc-all-msg'), e.message, false);
          if ($('confirm-modal').classList.contains('open')) showDetails('Broadcast all — failed', e.message, '');
        }
      },
      'Broadcast — I understand');
  }

  $('btn-btc-broadcast-all').addEventListener('click', broadcastAll);

  $('btn-btc-test-all').addEventListener('click', async function () {
    var before = settledIds();
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
      (r.confirmations || []).forEach(function (c) {
        var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === c.id; });
        if (tx && tx.broadcasted) {
          tx.broadcasted.confirmations = c.confirmations;
          tx.broadcasted.blockHeight = c.blockHeight;
          tx.broadcasted.found = c.found;
          tx.broadcasted.checkedAt = c.checkedAt;
        }
        var card = txCardEls[c.id];
        if (card && card.sentLine && tx) card.sentLine.textContent = txBroadcastLine(tx);
        // The pill follows the network verdict too: a broadcast the
        // network no longer knows flips Broadcasted -> Failed (and
        // back if it shows up again) without waiting for a reload.
        // Only the pill changes — the card stays put, settled, in
        // the Archived card either way.
        if (card && card.pill && tx) {
          var pst = txStatus(tx);
          card.pill.textContent = pst.label;
          card.pill.className = 'pill ' + pst.cls;
        }
      });
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
