// Token Radar v3 dashboard. Reads window.RADAR (written beside dashboard/
// by main.ts) and renders the cover first — one-line headline, ledger bar,
// one-row KPI strip, the board beside a rail with the scatter and the
// compact evidence — then the detail view and the full evidence below.
// No network: every byte shown comes from data.js. Every number the page
// shows is recomputed in the page from the snapshot figures: implied value
// from the fitted curve and the logistic odds, farm net from the live
// controls, the checksum from the board. The self-audit chips say whether
// the recompute matches board.json.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var params = new URLSearchParams(window.location.search);
  var state = {
    q: params.get('q') || '',
    group: params.get('group') || 'all',
    verdict: params.get('verdict') || 'all',
    sort: 'implied',
    poolPct: 0.1,
    horizonMult: 1,
    detailSlug: params.get('view') === 'detail' ? params.get('slug') : null,
  };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  /** A share of TVL in percent; tiny shares get four decimals, never 0.00%. */
  function fmtSharePct(share) {
    var pct = share * 100;
    return (pct >= 0.01 ? pct.toFixed(2) : pct.toFixed(4)) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function round4(n) { return Math.round(n * 1e4) / 1e4; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }
  function dot(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

  // --- The recompute mirror: byte-for-byte the same arithmetic as
  // lib/model.ts, so the audit can catch any drift between the page and
  // board.json. ---
  function impliedOf(r) {
    var fit = DATA.fit;
    var valueIf = Math.pow(10, fit.intercept + fit.slope * Math.log10(r.tvl_usd));
    var age = r.age_days === null || r.age_days === undefined ? 365 : r.age_days;
    var growth = typeof r.change_7d === 'number' && isFinite(r.change_7d) ? Math.max(-50, Math.min(100, r.change_7d)) / 100 : 0;
    var lg = DATA.odds.logistic;
    var raw = [age / 365, Math.log10(r.tvl_usd), growth];
    var x = [1];
    for (var i = 0; i < 3; i++) x.push((raw[i] - lg.mu[i]) / lg.sd[i]);
    var p = sigmoid(dot(x, lg.beta));
    var odds = round4(Math.max(0.05, Math.min(0.98, (0.94 - p) / (1 - p))));
    var implied = Math.max(1, Math.round(valueIf * odds));
    var lo = Math.max(1, Math.round(valueIf * Math.pow(10, fit.rangeP25) * odds));
    var hi = Math.max(1, Math.round(valueIf * Math.pow(10, fit.rangeP75) * odds));
    return { valueIf: valueIf, odds: odds, implied: implied, lo: lo, hi: hi };
  }
  function holdDays(ageDays) {
    if (ageDays === null || ageDays === undefined) return 56;
    if (ageDays < 180) return 42;
    if (ageDays < 365) return 63;
    if (ageDays < 1095) return 90;
    return 120;
  }
  function farmOf(r, poolPct, horizonMult) {
    var implied = impliedOf(r).implied;
    var deposit = Math.min(20000, Math.max(100, r.tvl_usd * 0.0002));
    var share = deposit / r.tvl_usd;
    var chainsTouched = Math.max(1, Math.min(r.chains.length, 4));
    var weeks = (holdDays(r.age_days) / 7) * horizonMult;
    var setupGas = (4 + 2 * chainsTouched) * 1.5;
    var weeklyGas = 2 * chainsTouched * 1.5;
    var claimGas = 5 * 1.5;
    var fees = setupGas + weeklyGas * weeks + claimGas;
    var hours = 0.25 + weeks * 0.17 + 0.17;
    var gross = poolPct * implied * share;
    var net = gross - fees;
    var netPerHour = net / hours;
    var returnOnCapital = net / deposit;
    var verdict =
      net > 0 && returnOnCapital >= 0.025 && netPerHour >= 25 ? 'FARM'
        : net > 0 && returnOnCapital >= 0.005 ? 'THIN' : 'SKIP';
    return {
      deposit: Math.round(deposit), share: round4(share), chainsTouched: chainsTouched,
      weeks: round2(weeks), setupGas: round2(setupGas), weeklyGas: round2(weeklyGas),
      claimGas: round2(claimGas), fees: round2(fees), hours: round2(hours),
      gross: round2(gross), net: round2(net), netPerHour: round2(netPerHour),
      returnOnCapital: round4(returnOnCapital), verdict: verdict,
    };
  }
  function checksum(rows) {
    var h = 2166136261;
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i].slug + ':' + rows[i].implied_value_usd + ';';
      for (var j = 0; j < s.length; j++) {
        h ^= s.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // --- Self-audit: recompute every row at the default controls and
  // compare with board.json. ---
  function audit() {
    var ok = 0;
    for (var i = 0; i < DATA.board.length; i++) {
      var r = DATA.board[i];
      var imp = impliedOf(r);
      var f = farmOf(r, 0.1, 1);
      if (imp.implied === r.implied_value_usd && imp.odds === r.odds && f.verdict === r.farm.verdict && f.netPerHour === r.farm.netPerHour) ok++;
    }
    var ledgerTotal = DATA.ledger.reduce(function (s, g) { return s + g.count; }, 0);
    return {
      recompute: ok + '/' + DATA.board.length,
      recomputeOk: ok === DATA.board.length,
      ledger: ledgerTotal + '/' + DATA.counts.total,
      ledgerOk: ledgerTotal === DATA.counts.total,
      checksum: checksum(DATA.board),
      checksumOk: checksum(DATA.board) === DATA.checksum,
    };
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.board.filter(function (r) {
      if (state.group !== 'all' && r.group !== state.group) return false;
      var f = farmOf(r, state.poolPct, state.horizonMult);
      if (state.verdict !== 'all' && f.verdict !== state.verdict) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var key = state.sort;
    rows.sort(function (a, b) {
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'odds') return impliedOf(b).odds - impliedOf(a).odds;
      if (key === 'net') return farmOf(b, state.poolPct, state.horizonMult).netPerHour - farmOf(a, state.poolPct, state.horizonMult).netPerHour;
      if (key === 'return') return farmOf(b, state.poolPct, state.horizonMult).returnOnCapital - farmOf(a, state.poolPct, state.horizonMult).returnOnCapital;
      return b.implied_value_usd - a.implied_value_usd;
    });
    return rows;
  }

  function scatterSvg() {
    var pts = DATA.scatter;
    var W = 320, H = 210, padL = 34, padB = 22, padT = 8, padR = 6;
    var xs = pts.map(function (p) { return Math.log10(p.valueIf); });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    // Zoom the odds axis to the board's own range: every row sits between
    // 0.85 and 0.98, so a 0–1 axis would crush them into one band.
    var os = pts.map(function (p) { return p.odds; });
    var loO = Math.max(0, Math.min.apply(null, os) - 0.02);
    var hiO = Math.min(1, Math.max.apply(null, os) + 0.02);
    var color = { FARM: '#2fd6a3', THIN: '#f2b84b', SKIP: '#f26d6d' };
    function X(v) { return padL + ((v - minX) / (maxX - minX || 1)) * (W - padL - padR); }
    function Y(o) { return padT + (1 - (o - loO) / (hiO - loO || 1)) * (H - padT - padB); }
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of implied value against odds">';
    out += '<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '" stroke="#22303a"/>';
    out += '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '" stroke="#22303a"/>';
    out += '<text x="' + padL + '" y="' + (H - 6) + '" fill="#8fa1ad" font-size="10">value if launches (log)</text>';
    out += '<text x="4" y="' + (padT + 8) + '" fill="#8fa1ad" font-size="10">' + hiO.toFixed(2) + '</text>';
    out += '<text x="4" y="' + (H - padB) + '" fill="#8fa1ad" font-size="10">' + loO.toFixed(2) + '</text>';
    var bySlug = {};
    DATA.board.forEach(function (r) { bySlug[r.slug] = r; });
    pts.forEach(function (p) {
      var r = bySlug[p.slug];
      var v = r ? r.farm.verdict : 'SKIP';
      out += '<circle cx="' + X(Math.log10(p.valueIf)).toFixed(1) + '" cy="' + Y(p.odds).toFixed(1) + '" r="3" fill="' + color[v] + '" opacity="0.85"/>';
    });
    // One label only — the top row. The top five sit on top of each other
    // (all high value, all odds near 0.90), so labelling all five overlaps.
    var top1 = DATA.board[0];
    if (top1) {
      var imp1 = impliedOf(top1);
      var cx1 = X(Math.log10(imp1.valueIf));
      var cy1 = Y(imp1.odds);
      if (cx1 > W - 64) out += '<text x="' + (cx1 - 5).toFixed(1) + '" y="' + (cy1 - 6).toFixed(1) + '" fill="#e6edf2" font-size="9" text-anchor="end">' + esc(top1.slug) + '</text>';
      else out += '<text x="' + (cx1 + 5).toFixed(1) + '" y="' + (cy1 - 6).toFixed(1) + '" fill="#e6edf2" font-size="9">' + esc(top1.slug) + '</text>';
    }
    out += '</svg>';
    return out;
  }

  function kpiStrip() {
    var totalImplied = DATA.board.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var top = DATA.board[0];
    var oddsSorted = DATA.board.map(function (r) { return r.odds; }).sort(function (a, b) { return a - b; });
    var medOdds = oddsSorted[Math.floor(oddsSorted.length / 2)];
    var farmCount = DATA.board.filter(function (r) { return r.farm.verdict === 'FARM'; }).length;
    var kpis = [
      { label: 'Total implied', value: fmtUsd(totalImplied), note: DATA.board.length + ' rows ranked' },
      { label: 'Top implied', value: fmtUsd(top.implied_value_usd), note: esc(top.name) },
      { label: 'Median odds', value: medOdds.toFixed(2), note: DATA.oddsSpread.distinct + ' distinct odds' },
      { label: 'Worth farming', value: String(farmCount), note: 'FARM verdicts of ' + DATA.board.length },
      { label: 'Watchlist', value: DATA.counts.watchlist + '/' + DATA.counts.watchlist, note: 'all covered' },
      { label: 'Protocols', value: String(DATA.counts.total), note: DATA.counts.preToken + ' pre-token' },
    ];
    return '<div class="kpi-strip">' + kpis.map(function (k) {
      return '<div class="kpi"><div class="k-label">' + k.label + '</div><div class="k-value">' + k.value + '</div><div class="k-note">' + k.note + '</div></div>';
    }).join('') + '</div>';
  }

  function boardTable(rows) {
    var maxImplied = DATA.board[0] ? DATA.board[0].implied_value_usd : 1;
    var html = '<table><thead><tr><th class="num">#</th><th>Protocol</th><th class="num">TVL</th><th class="num">7d</th><th class="num">Age</th><th class="num">Odds</th><th class="num">Implied</th><th>Verdict</th><th class="num">Net/h</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var f = farmOf(r, state.poolPct, state.horizonMult);
      var imp = impliedOf(r);
      var pct = Math.max(4, Math.round((imp.implied / maxImplied) * 100));
      var badge = r.group === 'watchlist' ? 'W' : r.group === 'early' ? 'E' : 'O';
      html += '<tr data-slug="' + esc(r.slug) + '"' + (state.detailSlug === r.slug ? ' class="sel"' : '') + '>'
        + '<td class="num">' + r.rank + '</td>'
        + '<td><b>' + esc(r.name) + '</b></td>'
        + '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>'
        + '<td class="num">' + fmtPct(r.change_7d) + '</td>'
        + '<td class="num">' + fmtAge(r.age_days) + '</td>'
        + '<td class="num">' + imp.odds.toFixed(2) + '</td>'
        + '<td class="num">' + fmtUsd(imp.implied) + '<span class="range"><i style="width:' + pct + '%"></i></span></td>'
        + '<td><span class="verdict verdict-' + f.verdict + '">' + f.verdict + '</span></td>'
        + '<td class="num">' + fmtMoney(f.netPerHour) + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function detailHtml() {
    var r = null;
    for (var i = 0; i < DATA.board.length; i++) if (DATA.board[i].slug === state.detailSlug) { r = DATA.board[i]; break; }
    if (!r) return '';
    var imp = impliedOf(r);
    var f = farmOf(r, state.poolPct, state.horizonMult);
    var fit = DATA.fit;
    var row = function (k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; };
    return '<section class="panel" id="detail"><h2>Detail — ' + esc(r.name) + ' (rank ' + r.rank + ', ' + r.group + ')</h2>'
      + '<p class="fine">' + esc(r.category || 'protocol') + ' · ' + esc(r.chains.join(', ')) + ' · TVL ' + fmtUsd(r.tvl_usd) + ' · 7d ' + fmtPct(r.change_7d) + ' · age ' + fmtAge(r.age_days) + '</p>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">'
      + '<div><h3>Model breakdown</h3><dl class="kv">'
      + row('Value if launches', fmtUsd(imp.valueIf) + ' — 10^(' + fit.intercept + ' + ' + fit.slope + ' × log10(' + fmtUsd(r.tvl_usd) + '))')
      + row('Odds', imp.odds.toFixed(4) + ' — logistic on age, TVL, growth; cohort anchor ' + r.cohort_odds.toFixed(4))
      + row('Implied value', '<b>' + fmtUsd(imp.implied) + '</b> = value if × odds')
      + row('Range P25–P75', fmtUsd(imp.lo) + ' – ' + fmtUsd(imp.hi))
      + row('Range P10–P90', fmtUsd(Math.max(1, Math.round(imp.valueIf * Math.pow(10, fit.rangeP10) * imp.odds))) + ' – ' + fmtUsd(Math.max(1, Math.round(imp.valueIf * Math.pow(10, fit.rangeP90) * imp.odds))))
      + '</dl></div>'
      + '<div><h3>Farm arithmetic (pro-rata)</h3><dl class="kv">'
      + row('Deposit', fmtMoney(f.deposit) + ' — 0.02% of TVL, capped $20,000, floored $100')
      + row('Share of TVL', fmtSharePct(f.deposit / r.tvl_usd))
      + row('Drop pool', Math.round(state.poolPct * 100) + '% of implied = ' + fmtMoney(state.poolPct * imp.implied))
      + row('Gross share', fmtMoney(f.gross) + ' = pool × share')
      + row('Gas', fmtMoney(f.fees) + ' — setup ' + fmtMoney(f.setupGas) + ', weekly ' + fmtMoney(f.weeklyGas) + ' × ' + f.weeks + 'w, claim ' + fmtMoney(f.claimGas))
      + row('Hours', String(f.hours) + ' over ' + f.weeks + ' weeks')
      + row('Net', '<b>' + fmtMoney(f.net) + '</b> = gross − gas')
      + row('Net per hour', fmtMoney(f.netPerHour))
      + row('Return on capital', (f.returnOnCapital * 100).toFixed(2) + '% on ' + fmtMoney(f.deposit))
      + row('Verdict', '<span class="verdict verdict-' + f.verdict + '">' + f.verdict + '</span> — FARM needs 2.5% return and $25/h; THIN needs 0.5% and a positive net')
      + '</dl></div></div>'
      + '<h3>Farm plan</h3><ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>'
      + '<p><button class="close" id="close-detail" type="button">Close detail</button></p></section>';
  }

  function evidenceHtml() {
    var a = audit();
    var top1 = DATA.board[0];
    var f1 = farmOf(top1, 0.1, 1);
    var termsRows = DATA.terms.map(function (t) {
      return '<tr><td>' + esc(t.term) + '</td><td class="num">×' + t.looMiss + '</td><td class="num">×' + t.wfMiss + '</td><td class="num">×' + t.geoLooMiss + '</td><td class="num">×' + t.geoWfMiss + '</td><td>' + (t.kept ? 'kept' : 'dropped') + '</td><td>' + esc(t.note) + '</td></tr>';
    }).join('');
    var cohortRows = DATA.odds.cohorts.map(function (c) {
      return '<tr><td>' + esc(c.label) + '</td><td class="num">' + c.n + '</td><td class="num">' + c.share.toFixed(4) + '</td></tr>';
    }).join('');
    var liveRows = DATA.live.map(function (r) {
      return '<tr><td class="num">' + r.rank + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.category || 'protocol') + '</td><td class="num">' + fmtUsd(r.tvl_usd) + '</td><td class="num">' + fmtUsd(r.mcap_usd) + '</td></tr>';
    }).join('');
    return '<section class="panel evidence"><h2>Evidence — how the numbers were earned</h2>'
      + '<div class="chips">'
      + '<span class="chip ' + (a.recomputeOk ? 'ok' : 'warn') + '">recomputed = board.json: ' + a.recompute + '</span>'
      + '<span class="chip ' + (a.ledgerOk ? 'ok' : 'warn') + '">ledger ' + a.ledger + '</span>'
      + '<span class="chip ' + (a.checksumOk ? 'ok' : 'warn') + '">checksum ' + a.checksum + '</span>'
      + '<span class="chip">fit n=' + DATA.fit.n + ' · LOO ×' + DATA.fit.looMiss + ' · WF ×' + DATA.fit.wfMiss + ' · flat ×' + DATA.fit.flatLooMiss + ' / ×' + DATA.fit.flatWfMiss + '</span>'
      + '<span class="chip">range honesty P25–P75 ' + Math.round(DATA.fit.honesty2575 * 100) + '% · P10–P90 ' + Math.round(DATA.fit.honesty1090 * 100) + '%</span>'
      + '</div>'
      + '<h3>Ledger — all ' + DATA.counts.total + ' protocols accounted for</h3>'
      + '<table><thead><tr><th>Group</th><th class="num">Count</th><th>Why it is there</th></tr></thead><tbody>'
      + DATA.ledger.map(function (g) { return '<tr><td>' + esc(g.label) + '</td><td class="num">' + g.count + '</td><td>' + esc(g.note) + '</td></tr>'; }).join('')
      + '</tbody></table>'
      + '<h3>Extra-term tests — kept only on both tests, both measures</h3>'
      + '<p class="fine">Base curve: log10(mcap) = ' + DATA.fit.intercept + ' + ' + DATA.fit.slope + ' × log10(TVL), R² ' + DATA.fit.r2 + ', n=' + DATA.fit.n + '. LOO ×' + DATA.fit.looMiss + ' and walk-forward ×' + DATA.fit.wfMiss + ' (geometric-mean ×' + DATA.fit.looGeoMiss + ' / ×' + DATA.fit.wfGeoMiss + '). The 128-comparable fit is worse on walk-forward (×' + DATA.fit128.wfMiss + ' vs ×' + DATA.fit.wfMiss + '), so the 94-comparable base stays.</p>'
      + '<table><thead><tr><th>Term</th><th class="num">LOO</th><th class="num">WF</th><th class="num">Geo LOO</th><th class="num">Geo WF</th><th>Kept</th><th>Why</th></tr></thead><tbody>' + termsRows + '</tbody></table>'
      + '<h3>Odds — age cohorts anchor, logistic spreads</h3>'
      + '<p class="fine">The logistic (age + log TVL + growth, IRLS, L2=1) on ' + DATA.odds.logistic.n + ' dated protocols: Brier ' + DATA.odds.logistic.brierLoo + ' leave-one-out vs cohort ' + DATA.odds.brierCohort + ' and base ' + DATA.odds.logistic.brierBase + '. It does NOT beat the cohorts on calibration — it is kept because it gives every protocol its own odds (' + DATA.oddsSpread.distinct + ' distinct values; the largest share at one value is ' + Math.round(DATA.oddsSpread.maxShare * 100) + '%) instead of five shared values. Odds = (0.94 − p) / (1 − p), clipped to [0.05, 0.98]. ' + esc(DATA.odds.tvlSplitNote) + ' ' + esc(DATA.odds.growthSplitNote) + '</p>'
      + '<table><thead><tr><th>Cohort</th><th class="num">n</th><th class="num">Share recording a token</th></tr></thead><tbody>' + cohortRows + '</tbody></table>'
      + '<h3>Worked example — rank 1, ' + esc(top1.name) + '</h3>'
      + '<p>Deposit ' + fmtMoney(f1.deposit) + ' (0.02% of ' + fmtUsd(top1.tvl_usd) + ' TVL) is a ' + fmtSharePct(f1.deposit / top1.tvl_usd) + ' share; a 10% drop pool on ' + fmtUsd(top1.implied_value_usd) + ' implied value pays ' + fmtMoney(f1.gross) + ' gross. Gas ' + fmtMoney(f1.fees) + ' over ' + f1.weeks + ' weeks leaves a net of ' + fmtMoney(f1.net) + ', ' + fmtMoney(f1.netPerHour) + ' an hour, ' + (f1.returnOnCapital * 100).toFixed(2) + '% on the deposit — verdict ' + f1.verdict + '.</p>'
      + '<h3>Live-token protocols set aside (top ' + DATA.live.length + ' by market cap)</h3>'
      + '<p class="fine">These already trade, so they are not on the board; they price the curve instead.</p>'
      + '<table><thead><tr><th class="num">#</th><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th></tr></thead><tbody>' + liveRows + '</tbody></table>'
      + '<h3>Farm assumptions</h3>'
      + '<p class="fine">Deposit 0.02% of TVL, capped at $20,000, floored at $100. Drop pool ' + Math.round(DATA.farmAssumptions.poolPct * 100) + '% of implied value, shared pro-rata by deposit against TVL (farming deposits assumed to total the TVL). Gas $1.50 an action. Verdicts: FARM at 2.5% return on capital with net per hour at least $25, THIN at 0.5% with a positive net, else SKIP. A protocol "records no token" when its snapshot entry carries no market cap, no CoinGecko id and no symbol.</p>'
      + '</section>';
  }

  function render() {
    var rows = filteredRows();
    var c = DATA.counts;
    var html = '<h1>Token Radar — ' + DATA.board.length + ' pre-token protocols ranked by fitted implied value</h1>'
      + '<p class="sub">DefiLlama snapshot as of ' + esc(DATA.asOf) + ' · floor ' + fmtUsd(DATA.floorUsd) + ' · model ' + esc(DATA.model) + ' · deterministic, no network</p>'
      + '<div class="ledger-bar"><span><b>' + c.total + '</b> total</span><span><b>' + c.live + '</b> live-token</span><span><b>' + c.preToken + '</b> pre-token</span><span><b>' + c.ranked + '</b> ranked</span><span><b>' + c.watchlist + '/' + c.watchlist + '</b> watchlist</span><span class="muted">ledger ' + DATA.ledger.reduce(function (s, g) { return s + g.count; }, 0) + '/' + c.total + '</span></div>'
      + kpiStrip()
      + '<div class="controls">'
      + '<input type="search" id="q" placeholder="Search name or slug" value="' + esc(state.q) + '" aria-label="Search">'
      + '<select id="group" aria-label="Group"><option value="all">All groups</option><option value="watchlist"' + (state.group === 'watchlist' ? ' selected' : '') + '>Watchlist</option><option value="early"' + (state.group === 'early' ? ' selected' : '') + '>Early</option><option value="off-list"' + (state.group === 'off-list' ? ' selected' : '') + '>Off-list</option></select>'
      + '<select id="verdict" aria-label="Verdict"><option value="all">All verdicts</option><option value="FARM"' + (state.verdict === 'FARM' ? ' selected' : '') + '>FARM</option><option value="THIN"' + (state.verdict === 'THIN' ? ' selected' : '') + '>THIN</option><option value="SKIP"' + (state.verdict === 'SKIP' ? ' selected' : '') + '>SKIP</option></select>'
      + '<select id="sort" aria-label="Sort"><option value="implied"' + (state.sort === 'implied' ? ' selected' : '') + '>Sort: implied</option><option value="tvl"' + (state.sort === 'tvl' ? ' selected' : '') + '>Sort: TVL</option><option value="odds"' + (state.sort === 'odds' ? ' selected' : '') + '>Sort: odds</option><option value="net"' + (state.sort === 'net' ? ' selected' : '') + '>Sort: net/hour</option><option value="return"' + (state.sort === 'return' ? ' selected' : '') + '>Sort: return</option></select>'
      + '<select id="pool" aria-label="Drop pool"><option value="0.05"' + (state.poolPct === 0.05 ? ' selected' : '') + '>Drop pool 5%</option><option value="0.1"' + (state.poolPct === 0.1 ? ' selected' : '') + '>Drop pool 10%</option><option value="0.2"' + (state.poolPct === 0.2 ? ' selected' : '') + '>Drop pool 20%</option></select>'
      + '<select id="horizon" aria-label="Horizon"><option value="0.5"' + (state.horizonMult === 0.5 ? ' selected' : '') + '>Hold ×0.5</option><option value="1"' + (state.horizonMult === 1 ? ' selected' : '') + '>Hold ×1</option><option value="2"' + (state.horizonMult === 2 ? ' selected' : '') + '>Hold ×2</option></select>'
      + '<span class="count">' + rows.length + ' rows shown</span></div>'
      + '<div class="cover"><div class="panel"><h2>Board — ranked by implied value</h2>' + boardTable(rows) + '</div>'
      + '<div class="rail"><div class="panel"><h2>Implied value vs odds</h2>' + scatterSvg()
      + '<p class="fine">Each bubble is a board row from its own numbers. Colour is the farm verdict at the 10% pool: green FARM, amber THIN, red SKIP.</p></div>'
      + '<div class="panel"><h2>Evidence, compact</h2>'
      + '<p>Fit on ' + DATA.fit.n + ' comparables: log10(mcap) = ' + DATA.fit.intercept + ' + ' + DATA.fit.slope + ' × log10(TVL), R² ' + DATA.fit.r2 + '.</p>'
      + '<p>Held-out miss ×' + DATA.fit.looMiss + ' leave-one-out, ×' + DATA.fit.wfMiss + ' older-to-newer; flat median ×' + DATA.fit.flatLooMiss + ' / ×' + DATA.fit.flatWfMiss + '.</p>'
      + '<p>Odds Brier ' + DATA.odds.logistic.brierLoo + ' leave-one-out vs cohort ' + DATA.odds.brierCohort + ' and base ' + DATA.odds.logistic.brierBase + ' — the logistic spreads the odds, it does not beat the cohorts.</p>'
      + '<p>Verdicts at the 10% pool: FARM ' + DATA.board.filter(function (r) { return r.farm.verdict === 'FARM'; }).length + ' · THIN ' + DATA.board.filter(function (r) { return r.farm.verdict === 'THIN'; }).length + ' · SKIP ' + DATA.board.filter(function (r) { return r.farm.verdict === 'SKIP'; }).length + '.</p>'
      + '</div></div></div>'
      + detailHtml()
      + evidenceHtml()
      + '<footer>Token Radar ' + esc(DATA.model) + ' · snapshot ' + esc(DATA.asOf) + ' · board checksum ' + esc(DATA.checksum) + ' · the dashboard recomputes every number from data.js; the model card below the page carries the headline numbers as text.</footer>';
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; render(); var q = document.getElementById('q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); });
    document.getElementById('group').addEventListener('change', function (e) { state.group = e.target.value; render(); });
    document.getElementById('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; render(); });
    document.getElementById('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
    document.getElementById('pool').addEventListener('change', function (e) { state.poolPct = parseFloat(e.target.value); render(); });
    document.getElementById('horizon').addEventListener('change', function (e) { state.horizonMult = parseFloat(e.target.value); render(); });
    var tbody = app.querySelector('tbody');
    if (tbody) tbody.addEventListener('click', function (e) {
      var tr = e.target.closest('tr');
      if (!tr) return;
      state.detailSlug = tr.getAttribute('data-slug');
      render();
      var d = document.getElementById('detail');
      if (d) d.scrollIntoView();
    });
    var close = document.getElementById('close-detail');
    if (close) close.addEventListener('click', function () { state.detailSlug = null; render(); });
  }

  render();
  // On a deep link (?view=detail&slug=…), bring the detail panel into
  // view once, so a screenshot of the detail view shows the detail.
  if (state.detailSlug && !window.__radarScrolledToDetail) {
    window.__radarScrolledToDetail = true;
    var d0 = document.getElementById('detail');
    if (d0) d0.scrollIntoView();
  }
})();
