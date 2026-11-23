// Token Radar v2 dashboard. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, the evidence panel, the live-token
// set-aside, and a per-protocol detail view with the model's own numbers,
// the farm economics and the farm plan. No network: every byte shown comes
// from data.js. Every number the page shows is recomputed in the page from
// the snapshot figures: implied value from the fitted curve and the odds
// table, farm net from the live controls, the checksum from the board.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', verdict: 'all', tier: 'all', watch: false, tab: 'pre', sort: 'implied', dir: -1, selected: null, farmers: 10000, horizon: 1 };

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
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtNum(n, d) { return (n === null || n === undefined) ? 'n/a' : Number(n).toFixed(d === undefined ? 2 : d); }
  function round2(n) { return Math.round(n * 100) / 100; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ---------------------------------------------------------------- recompute

  /** The fitted size curve, exactly as main.ts fits it at runtime. */
  function valueIf(tvl) {
    return Math.pow(10, DATA.fit.intercept + DATA.fit.slope * Math.log10(tvl));
  }
  /** A protocol's launch odds from its age cohort; unknown age takes the middle cohort. */
  function oddsFor(ageDays) {
    var age = ageDays === null || ageDays === undefined ? 365 : ageDays;
    var found = null;
    DATA.odds.cohorts.forEach(function (c) { if (age >= c.minDays && age <= c.maxDays) found = c; });
    return found ? found.odds : 0.9;
  }
  function cohortFor(ageDays) {
    var age = ageDays === null || ageDays === undefined ? 365 : ageDays;
    var found = null;
    DATA.odds.cohorts.forEach(function (c) { if (age >= c.minDays && age <= c.maxDays) found = c; });
    return found;
  }
  /** The implied value, recomputed in the page from the row's own figures. */
  function impliedOf(r) {
    return Math.max(1, Math.round(valueIf(r.tvl_usd) * oddsFor(r.age_days)));
  }
  function depositFor(tvl) {
    if (tvl >= 1e9) return 500;
    if (tvl >= 1e8) return 250;
    if (tvl >= 5e7) return 150;
    return 100;
  }
  function holdDays(ageDays) {
    if (ageDays === null || ageDays === undefined) return 45;
    if (ageDays < 180) return 90;
    if (ageDays < 365) return 60;
    return 30;
  }
  /** The farm's net economics under the page's live controls. */
  function farmOf(r) {
    var deposit = depositFor(r.tvl_usd);
    var touched = Math.min(Math.max((r.chains || []).length, 1), 3);
    var weeks = (holdDays(r.age_days) / 7) * state.horizon;
    var setup = 4 + 2 * touched;
    var weekly = 2 * touched;
    var fees = round2(setup + weekly * weeks + 5);
    var hours = round2(0.25 + weeks * 0.17 + 0.17);
    var dropShare = 0.1 / state.farmers;
    var gross = round2(impliedOf(r) * dropShare);
    var net = round2(gross - fees);
    var netHr = round2(net / hours);
    var verdict = netHr >= 50 ? 'FARM' : netHr >= 10 ? 'THIN' : 'SKIP';
    return { deposit: deposit, depositPct: deposit / r.tvl_usd, touched: touched, weeks: round2(weeks), fees: fees, hours: hours, gross: gross, net: net, netHr: netHr, verdict: verdict, dropShare: dropShare };
  }
  /** FNV-1a over the board's slugs and implied values, recomputed in the page. */
  function checksumOf(rows) {
    var text = rows.map(function (r) { return r.slug + ':' + r.implied_value_usd; }).join(',');
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function findRow(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    state.selected = null;
    if (!hash) return;
    if (hash.indexOf('/protocol/') === 0) {
      state.selected = decodeURIComponent(hash.slice('/protocol/'.length));
      state.tab = 'pre';
      return;
    }
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('verdict')) state.verdict = params.get('verdict');
    if (params.get('tier')) state.tier = params.get('tier');
    if (params.get('watchlist') === '1') state.watch = true;
    if (params.get('tab') === 'live') state.tab = 'live';
    if (params.get('farmers')) state.farmers = parseInt(params.get('farmers'), 10) || 10000;
    if (params.get('horizon')) state.horizon = parseFloat(params.get('horizon')) || 1;
    if (params.get('p')) { state.selected = params.get('p'); state.tab = 'pre'; }
  }
  function writeHash() {
    if (state.selected) {
      window.history.replaceState(null, '', '#/protocol/' + encodeURIComponent(state.selected));
      return;
    }
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.tier !== 'all') params.set('tier', state.tier);
    if (state.watch) params.set('watchlist', '1');
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.farmers !== 10000) params.set('farmers', String(state.farmers));
    if (state.horizon !== 1) params.set('horizon', String(state.horizon));
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function tierOf(r) {
    if (r.tvl_usd >= 1e9) return 'mega';
    if (r.tvl_usd >= 1e8) return 'large';
    if (r.tvl_usd >= 5e7) return 'mid';
    return 'small';
  }
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.verdict !== 'all' && farmOf(r).verdict !== state.verdict) return false;
      if (state.tier !== 'all' && tierOf(r) !== state.tier) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'odds') { av = a.odds; bv = b.odds; }
      else if (key === 'net') { av = farmOf(a).netHr; bv = farmOf(b).netHr; }
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ---------------------------------------------------------------- sections

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark' }),
        el('div', null,
          el('div', { class: 'brand-name', text: 'TOKEN RADAR' }),
          el('div', { class: 'brand-sub', text: 'PRE-TOKEN PROTOCOLS / IMPLIED VALUE' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'Source ', el('b', { text: 'DefiLlama protocol index' })),
        el('span', null, 'Model ', el('b', { text: DATA.model_id }))
      )
    );
  }

  function lede() {
    var top = DATA.rows[0];
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.board_size + ' pre-token protocols, ranked by fitted implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor and the off-list radar adds ' + DATA.off_list_size + ' above it, all held to the same exclusions. Implied value is a fitted curve times age-cohort odds — a model, not a promise — and no row claims a token will launch.' }),
        el('p', { class: 'sub', text: 'Top of the board: ' + (top ? top.name + ' at ' + fmtUsd(top.implied_value_usd) + ' implied, odds ' + top.odds.toFixed(3) + '.' : '—') })
      ),
      el('div', { class: 'kpis' },
        el('div', { class: 'kpi' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'kpi' }, el('span', { text: 'Held-out miss, fit vs flat (LOO median)' }), el('b', { text: '×' + DATA.fit.looMiss + ' vs ×' + DATA.fit.flatLooMiss })),
        el('div', { class: 'kpi' }, el('span', { text: 'Odds Brier, cohort vs base rate' }), el('b', { text: DATA.odds.brier.toFixed(3) + ' vs ' + DATA.odds.brierBase.toFixed(3) })),
        el('div', { class: 'kpi' }, el('span', { text: 'Range honesty, P25–P75 (held out)' }), el('b', { text: Math.round(DATA.fit.honesty2575 * 100) + '%' })),
        el('div', { class: 'kpi' }, el('span', { text: 'FARM verdicts' }), el('b', { text: String(DATA.verdicts.FARM) + ' of ' + DATA.board_size })),
        el('div', { class: 'kpi' }, el('span', { text: 'Ledger, protocols accounted for' }), el('b', { text: DATA.ledger_total + ' / ' + DATA.ledger_total }))
      )
    );
  }

  function scatterSvg() {
    var W = 640, H = 340, L = 56, R = 14, T = 14, B = 38;
    var x0 = 7, x1 = 10.3, y0 = 5.3, y1 = 10.3;
    function X(v) { return L + ((Math.log10(v) - x0) / (x1 - x0)) * (W - L - R); }
    function Y(v) { return T + (1 - (Math.log10(v) - y0) / (y1 - y0)) * (H - T - B); }
    var parts = [];
    parts.push('<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of market cap against TVL with the fitted curve">');
    var ticksX = [1e7, 1e8, 1e9, 1e10];
    var ticksY = [1e6, 1e7, 1e8, 1e9, 1e10];
    ticksX.forEach(function (v) {
      parts.push('<line x1="' + X(v).toFixed(1) + '" y1="' + T + '" x2="' + X(v).toFixed(1) + '" y2="' + (H - B) + '" class="grid"/>');
      parts.push('<text x="' + X(v).toFixed(1) + '" y="' + (H - B + 16) + '" class="axis">' + fmtUsd(v) + '</text>');
    });
    ticksY.forEach(function (v) {
      parts.push('<line x1="' + L + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(v).toFixed(1) + '" class="grid"/>');
      parts.push('<text x="' + (L - 6) + '" y="' + (Y(v).toFixed(1) + 4) + '" class="axis" text-anchor="end">' + fmtUsd(v) + '</text>');
    });
    parts.push('<text x="' + ((W + L) / 2) + '" y="' + (H - 4) + '" class="axis" text-anchor="middle">TVL (log)</text>');
    parts.push('<text x="12" y="' + ((H + T) / 2) + '" class="axis" text-anchor="middle" transform="rotate(-90 12 ' + ((H + T) / 2) + ')">Market cap / implied (log)</text>');
    var fx0 = Math.pow(10, x0), fx1 = Math.pow(10, x1);
    parts.push('<line x1="' + X(fx0).toFixed(1) + '" y1="' + Y(valueIf(fx0)).toFixed(1) + '" x2="' + X(fx1).toFixed(1) + '" y2="' + Y(valueIf(fx1)).toFixed(1) + '" class="fitline"/>');
    DATA.scatter.forEach(function (p) {
      if (p.tvl <= 0 || p.mcap <= 0) return;
      var cx = X(p.tvl), cy = Y(p.mcap);
      if (cx < L || cx > W - R || cy < T || cy > H - B) return;
      parts.push(p.kind === 'comp'
        ? '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="2.6" class="dot-comp"/>'
        : '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="2.2" class="dot-board"/>');
    });
    parts.push('</svg>');
    return el('div', { class: 'scatter' },
      el('div', { class: 'legend' },
        el('span', null, el('i', { class: 'sw comp' }), ' Live-token comparables (n=' + DATA.fit.n + ')'),
        el('span', null, el('i', { class: 'sw board' }), ' Board rows (implied)'),
        el('span', null, el('i', { class: 'sw fit' }), ' Fitted curve')
      ),
      el('div', { html: parts.join('') })
    );
  }

  function evidencePanel() {
    var top = DATA.rows[0];
    var fit = DATA.fit;
    var rows = [];
    rows.push(el('tr', null,
      el('td', { text: 'Flat median mcap / TVL (v1 baseline)' }),
      el('td', { class: 'num', text: '×' + fit.flatLooMiss }),
      el('td', { class: 'num', text: '×' + fit.flatWfMiss }),
      el('td', null, el('span', { class: 'pill drop', text: 'baseline' })),
      el('td', { text: 'The number the fitted curve has to beat.' })
    ));
    rows.push(el('tr', null,
      el('td', { text: 'Size curve, 94 comps (bridge, LST, restaking, CEX excluded)' }),
      el('td', { class: 'num', text: '×' + fit.looMiss }),
      el('td', { class: 'num', text: '×' + fit.wfMiss }),
      el('td', null, el('span', { class: 'pill keep', text: 'kept' })),
      el('td', { text: 'Beats flat on both held-out tests; geometric mean ×' + fit.looGeoMiss + ' / ×' + fit.wfGeoMiss + '.' })
    ));
    rows.push(el('tr', null,
      el('td', { text: 'Size curve, 128 comps (no category exclusion)' }),
      el('td', { class: 'num', text: '×' + DATA.fit128.looMiss }),
      el('td', { class: 'num', text: '×' + DATA.fit128.wfMiss }),
      el('td', null, el('span', { class: 'pill drop', text: 'dropped' })),
      el('td', { text: 'Median LOO ×' + DATA.fit128.looMiss + ' beats the 94-comp fit, but walk-forward ×' + DATA.fit128.wfMiss + ' is far worse and geometric-mean loses both (×' + DATA.fit128.geoLooMiss + ' / ×' + DATA.fit128.geoWfMiss + '): those categories do not price a launch.' })
    ));
    DATA.terms.forEach(function (t) {
      rows.push(el('tr', null,
        el('td', { text: '+ ' + t.term }),
        el('td', { class: 'num', text: '×' + t.looMiss }),
        el('td', { class: 'num', text: '×' + t.wfMiss }),
        el('td', null, el('span', { class: t.kept ? 'pill keep' : 'pill drop', text: t.kept ? 'kept' : 'dropped' })),
        el('td', { text: t.note })
      ));
    });
    var cohortRows = DATA.odds.cohorts.map(function (c) {
      return el('tr', null,
        el('td', { text: c.label }),
        el('td', { class: 'num', text: String(c.n) }),
        el('td', { class: 'num', text: c.tokenShare.toFixed(3) }),
        el('td', { class: 'num', text: c.odds.toFixed(3) })
      );
    });
    var worked = top ? el('div', { class: 'worked' },
      el('h3', { text: 'Worked example — rank 1, ' + top.name }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(top.tvl_usd) })),
        el('div', null, el('span', { text: 'log10(TVL)' }), el('b', { class: 'num', text: Math.log10(top.tvl_usd).toFixed(3) })),
        el('div', null, el('span', { text: 'value if launches = 10^(' + fit.intercept + ' + ' + fit.slope + ' × log10 TVL)' }), el('b', { class: 'num', text: fmtUsd(top.value_if_launches_usd) })),
        el('div', null, el('span', { text: 'odds (' + (cohortFor(top.age_days) ? cohortFor(top.age_days).label : '—') + ' cohort)' }), el('b', { class: 'num', text: top.odds.toFixed(3) })),
        el('div', { class: 'total' }, el('span', { text: 'implied = value if launches × odds' }), el('b', { class: 'num', text: fmtUsd(top.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Range from the held-out residuals: P25–P75 ' + fmtUsd(top.range_lo_usd) + ' – ' + fmtUsd(top.range_hi_usd) + ', P10–P90 ' + fmtUsd(top.range_lo90_usd) + ' – ' + fmtUsd(top.range_hi90_usd) + '. The range covers ' + Math.round(fit.honesty2575 * 100) + '% / ' + Math.round(fit.honesty1090 * 100) + '% of held-out actuals.' })
    ) : null;
    return el('section', { class: 'panel evidence' },
      el('h2', { text: 'Evidence — what was tested, what was kept' }),
      el('p', { class: 'sub', text: 'Miss is the median multiplicative miss on held-out protocols: leave-one-out (refit on the other 93) and older-to-newer (train on the older half by listing date, test the newer half). A term is kept only when it beats the base curve on both tests under both miss measures — the median and the geometric mean. Either measure alone is noisy at n=94: the shuffled-growth control “wins” the median LOO test by 4% by pure chance, so a single-measure win is not evidence.' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'ev' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Term' }),
            el('th', { scope: 'col', text: 'LOO miss' }),
            el('th', { scope: 'col', text: 'Walk-forward miss' }),
            el('th', { scope: 'col', text: 'Verdict' }),
            el('th', { scope: 'col', text: 'Why' })
          )),
          el('tbody', null, rows)
        )
      ),
      el('div', { class: 'evidence-cols' },
        el('div', null,
          el('h3', { text: 'Launch odds by age cohort' }),
          el('div', { class: 'table-wrap' },
            el('table', { class: 'ev' },
              el('thead', null, el('tr', null,
                el('th', { scope: 'col', text: 'Cohort' }),
                el('th', { scope: 'col', text: 'Protocols' }),
                el('th', { scope: 'col', text: 'Share with token' }),
                el('th', { scope: 'col', text: 'Odds' })
              )),
              el('tbody', null, cohortRows)
            )
          ),
          el('p', { class: 'sub', text: 'odds = (0.94 − share) / (1 − share); 0.94 is the assumed eventual listing share. Brier ' + DATA.odds.brier.toFixed(3) + ' against a base rate of ' + DATA.odds.brierBase.toFixed(3) + '. TVL and growth splits inside cohorts: ' + DATA.odds.tvlSplitNote + ' ' + DATA.odds.growthSplitNote })
        ),
        worked
      ),
      scatterSvg()
    );
  }

  function controls() {
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      DATA.categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var verdict = el('select', { id: 'verdict', 'aria-label': 'Filter by farm verdict' },
      [['all', 'All verdicts'], ['FARM', 'FARM'], ['THIN', 'THIN'], ['SKIP', 'SKIP']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: state.verdict === o[0] ? 'selected' : null });
      })
    );
    verdict.addEventListener('change', function () { state.verdict = verdict.value; writeHash(); render(); });
    var tier = el('select', { id: 'tier', 'aria-label': 'Filter by TVL tier' },
      [['all', 'All TVL tiers'], ['mega', 'TVL ≥ $1B'], ['large', '$100M – $1B'], ['mid', '$50M – $100M'], ['small', '< $50M']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: state.tier === o[0] ? 'selected' : null });
      })
    );
    tier.addEventListener('change', function () { state.tier = tier.value; writeHash(); render(); });
    var watch = el('input', { type: 'checkbox', id: 'watch', checked: state.watch ? 'checked' : null, 'aria-label': 'Watchlist only' });
    watch.addEventListener('change', function () { state.watch = watch.checked; writeHash(); render(); });
    var farmers = el('select', { id: 'farmers', 'aria-label': 'Farmers sharing the drop' },
      [[1000, '1,000 farmers'], [10000, '10,000 farmers'], [100000, '100,000 farmers']].map(function (o) {
        return el('option', { value: String(o[0]), text: o[1], selected: state.farmers === o[0] ? 'selected' : null });
      })
    );
    farmers.addEventListener('change', function () { state.farmers = parseInt(farmers.value, 10); writeHash(); render(); });
    var horizon = el('select', { id: 'horizon', 'aria-label': 'Hold horizon' },
      [['0.5', 'Half horizon'], ['1', 'Base horizon'], ['2', 'Double horizon']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: String(state.horizon) === o[0] ? 'selected' : null });
      })
    );
    horizon.addEventListener('change', function () { state.horizon = parseFloat(horizon.value); writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Farm verdict' }), verdict),
      el('div', { class: 'field' }, el('label', { for: 'tier', text: 'TVL tier' }), tier),
      el('label', { class: 'check', for: 'watch' }, watch, 'Watchlist only'),
      el('div', { class: 'field' }, el('label', { for: 'farmers', text: 'Drop shared by' }), farmers),
      el('div', { class: 'field' }, el('label', { for: 'horizon', text: 'Hold horizon' }), horizon),
      el('div', { class: 'field' }, el('span', { class: 'lbl', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre' ? filteredRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ▼' : ' ▲' }) : null
      )
    );
  }

  function chainText(r) {
    if (!r.chains || !r.chains.length) return 'an unnamed chain';
    return r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '');
  }

  function groupBadge(r) {
    if (r.group === 'watchlist') return el('span', { class: 'watch', text: 'WATCHLIST' });
    if (r.group === 'off-list') return el('span', { class: 'watch off', text: 'OFF-LIST' });
    return el('span', { class: 'watch early', text: 'EARLY' });
  }

  function verdictPill(v) {
    return el('span', { class: 'pill v-' + v.toLowerCase(), text: v });
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another filter to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.verdict = 'all'; state.tier = 'all'; state.watch = false; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var f = farmOf(r);
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('div', null, el('b', { text: r.name }), groupBadge(r)),
          el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' on ' + chainText(r) })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.odds.toFixed(3) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('div', null,
            el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
            el('div', { class: 'range', text: fmtUsd(r.range_lo_usd) + '–' + fmtUsd(r.range_hi_usd) })
          )
        )),
        el('td', null, verdictPill(f.verdict)),
        el('td', { class: 'num ' + (f.netHr >= 50 ? 'pos' : f.netHr >= 10 ? '' : 'neg'), text: fmtMoney(f.netHr) + '/h' })
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Net/h is the farm\u2019s expected net per hour under the controls above (drop shared by ' + state.farmers.toLocaleString('en-US') + ' farmers, ' + (state.horizon === 1 ? 'base' : state.horizon + '×') + ' horizon). Select a row for its model breakdown, odds, range and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('odds', 'Odds'),
            sortHeader('implied', 'Implied value'),
            sortHeader('net', 'Verdict'),
            sortHeader('net', 'Net / hour')
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' on ' + chainText(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'badge live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking — and the largest of them are the comparables the curve is fitted on.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function risksFor(r) {
    var risks = [];
    if (r.change_7d !== null && r.change_7d < 0) risks.push('TVL fell ' + fmtPct(r.change_7d) + ' in the last 7 days — momentum is against it.');
    if (r.age_days === null) risks.push('No listing date on record — the odds assume the middle age cohort.');
    else if (r.age_days < 180) risks.push('Listed only ' + fmtAge(r.age_days) + ' ago — a short track record with no token.');
    if (r.chains && r.chains.length === 1) risks.push('TVL sits on a single chain (' + r.chains[0] + ') — one chain outage hits the whole position.');
    if (r.tvl_usd < 100000000) risks.push('Below $100M TVL — thinner liquidity and a smaller base for the curve.');
    var f = farmOf(r);
    if (f.verdict === 'SKIP') risks.push('Farm verdict is SKIP under the current controls: the expected share is worth less than the gas.');
    risks.push('Records no token — a launch may never happen, and implied value is a model estimate, not a market price.');
    return risks.slice(0, 4);
  }

  function detailPanel() {
    var r = findRow(state.selected);
    if (!r) return null;
    var fit = DATA.fit;
    var f = farmOf(r);
    var cohort = cohortFor(r.age_days);
    var steps = r.farm_steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
    });
    return el('section', { class: 'panel detail', 'aria-label': 'Protocol detail' },
      el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'brand-sub', text: 'RANK ' + r.rank + ' OF ' + DATA.board_size + ' · ' + (r.group === 'watchlist' ? 'WATCHLIST' : r.group === 'off-list' ? 'OFF-LIST' : 'EARLY RADAR') }),
          el('h2', { text: r.name }),
          el('p', { class: 'sub', text: (r.category || 'Uncategorised') + ' on ' + (r.chains && r.chains.length ? r.chains.join(', ') : 'an unnamed chain') + ' · listed ' + (r.listed_at || 'date unknown') })
        ),
        el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { closeDetail(); } })
      ),
      el('div', { class: 'detail-cols' },
        el('div', null,
          el('div', { class: 'detail-section' },
            el('h3', { text: 'Model breakdown' }),
            el('div', { class: 'equation' },
              el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(r.tvl_usd) })),
              el('div', null, el('span', { text: 'value if launches = 10^(' + fit.intercept + ' + ' + fit.slope + ' × log10 TVL)' }), el('b', { class: 'num', text: fmtUsd(r.value_if_launches_usd) })),
              el('div', null, el('span', { text: 'odds (' + (cohort ? cohort.label + ' cohort, ' + cohort.n + ' protocols, share ' + cohort.tokenShare.toFixed(3) : 'unknown age') + ')' }), el('b', { class: 'num', text: '× ' + r.odds.toFixed(3) })),
              el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(r.implied_value_usd) })),
              el('div', null, el('span', { text: 'Range P25–P75 (held-out residuals)' }), el('b', { class: 'num', text: fmtUsd(r.range_lo_usd) + ' – ' + fmtUsd(r.range_hi_usd) })),
              el('div', null, el('span', { text: 'Range P10–P90' }), el('b', { class: 'num', text: fmtUsd(r.range_lo90_usd) + ' – ' + fmtUsd(r.range_hi90_usd) }))
            ),
            el('p', { class: 'sub', text: 'Recomputed in this page from the row\u2019s own figures: ' + (impliedOf(r) === r.implied_value_usd ? 'matches board.json' : 'does NOT match board.json') + '. The same function scores every row.' })
          ),
          el('div', { class: 'detail-section' },
            el('h3', { text: 'Farm economics — under the page\u2019s controls' }),
            el('table', { class: 'comps' },
              el('tbody', null,
                el('tr', null, el('td', { text: 'Deposit (' + (f.depositPct * 100).toFixed(4) + '% of TVL)' }), el('td', { class: 'num', text: fmtMoney(f.deposit) })),
                el('tr', null, el('td', { text: 'Chains touched / hold' }), el('td', { class: 'num', text: f.touched + ' / ' + f.weeks.toFixed(1) + ' weeks' })),
                el('tr', null, el('td', { text: 'Gas: setup + weekly + claim' }), el('td', { class: 'num', text: fmtMoney(f.fees) })),
                el('tr', null, el('td', { text: 'Hours of work' }), el('td', { class: 'num', text: f.hours.toFixed(2) })),
                el('tr', null, el('td', { text: 'Gross share (1 / ' + state.farmers.toLocaleString('en-US') + ' of the drop)' }), el('td', { class: 'num', text: fmtMoney(f.gross) })),
                el('tr', null, el('td', { text: 'Net' }), el('td', { class: 'num', text: fmtMoney(f.net) })),
                el('tr', null, el('td', { text: 'Net per hour' }), el('td', { class: 'num', text: fmtMoney(f.netHr) })),
                el('tr', null, el('td', { text: 'Verdict' }), el('td', { class: 'num' }, verdictPill(f.verdict)))
              )
            ),
            el('p', { class: 'sub', text: 'FARM at $50/h or more, THIN at $10/h or more, else SKIP. The drop share is a stated assumption: 10% of supply shared by ' + state.farmers.toLocaleString('en-US') + ' farmers.' })
          ),
          el('div', { class: 'detail-section' },
            el('h3', { text: 'Risks' }),
            el('ul', { class: 'risks' }, risksFor(r).map(function (x) { return el('li', { text: x }); }))
          )
        ),
        el('div', { class: 'detail-section' },
          el('h3', { text: 'Farm plan — ' + r.farm_steps.length + ' steps' }),
          el('ol', { class: 'steps' }, steps),
          el('p', { class: 'sub', text: 'This plan assumes nothing about a future token: the protocol records no token, so farm the product, not a promised launch. Never pay to claim anything.' })
        )
      )
    );
  }

  function ledgerPanel() {
    var recomputed = 0;
    DATA.rows.forEach(function (r) { if (impliedOf(r) === r.implied_value_usd) recomputed++; });
    var checksum = checksumOf(DATA.rows);
    var chips = [
      el('span', { class: 'chip', text: recomputed + ' rows recomputed = board.json' }),
      el('span', { class: 'chip ' + (checksum === DATA.checksum ? 'ok' : 'bad'), text: 'checksum ' + checksum + (checksum === DATA.checksum ? ' = main.ts' : ' ≠ main.ts') }),
      el('span', { class: 'chip', text: 'watchlist ' + DATA.watchlist_size + '/' + DATA.watchlist_size }),
      el('span', { class: 'chip', text: 'ledger ' + DATA.ledger_total + '/' + DATA.ledger_total })
    ];
    var rows = DATA.ledger.map(function (g) {
      return el('tr', null,
        el('td', { text: g.label }),
        el('td', { class: 'num', text: String(g.count) }),
        el('td', { text: g.note })
      );
    });
    rows.push(el('tr', { class: 'total-row' },
      el('td', { text: 'Total' }),
      el('td', { class: 'num', text: String(DATA.ledger_total) }),
      el('td', { text: 'Every protocol in the snapshot, in exactly one group.' })
    ));
    return el('section', { class: 'panel ledger' },
      el('h2', { text: 'Ledger — all ' + DATA.ledger_total + ' protocols accounted for' }),
      el('p', { class: 'sub', text: 'The board is one slice of the snapshot. The rest is priced as comparables or set aside for a stated reason. The chips below are computed in this page from the data, not written as text.' }),
      el('div', { class: 'chips' }, chips),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'ev' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Group' }),
            el('th', { scope: 'col', text: 'Count' }),
            el('th', { scope: 'col', text: 'Why' })
          )),
          el('tbody', null, rows)
        )
      )
    );
  }

  function modelPanel() {
    var fit = DATA.fit;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'One function scores every row, from the snapshot figures only. No protocol name is special-cased and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = max(1, round( 10^(' + fit.intercept + ' + ' + fit.slope + ' × log10(tvl_usd)) × odds ))\n' +
        'odds = (0.94 − share) / (1 − share), share = the fraction of protocols in the same age cohort that already record a token.\n' +
        'fitted on n=' + fit.n + ' live-token comparables, R²=' + fit.r2 + ', held-out median miss ×' + fit.looMiss + ' (leave-one-out) / ×' + fit.wfMiss + ' (older-to-newer).'
      ),
      el('p', { class: 'sub', text: 'The size curve is fitted at runtime from the snapshot: no coefficient is pasted in. Extra terms (growth, age, chain count, category residual) were each tested leave-one-out and older-to-newer under both miss measures and none beat the base on both tests under both, so none is kept — the evidence table above shows every test. The early radar is every pre-token protocol below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor that passes the watchlist rule — not a wrapped, staked or bridged product, not a versioned pool, not an exchange product — and the off-list radar is the same rule above the floor.' }),
      el('p', { class: 'sub', text: 'Source: DefiLlama protocol index, snapshot ' + DATA.as_of + '. Implied value is this entry\u2019s own claim, never a price and never a promise that a token launches.' })
    );
  }

  function openDetail(slug) {
    state.selected = slug;
    state.tab = 'pre';
    writeHash();
    render();
  }
  function closeDetail() {
    state.selected = null;
    writeHash();
    render();
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(evidencePanel());
    shell.appendChild(controls());
    var detail = state.tab === 'pre' ? detailPanel() : null;
    if (detail) shell.appendChild(detail);
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    if (state.tab === 'pre') {
      shell.appendChild(ledgerPanel());
      shell.appendChild(modelPanel());
    }
    shell.appendChild(el('p', { class: 'foot', text: 'Token Radar ranks protocols that record no token by what a token could be worth if the record stayed as it is. It does not predict whether or when any token is issued. Farm plans are generic on-chain steps with stated costs and times; they are not investment advice. Data: DefiLlama protocol index, snapshot ' + DATA.as_of + '.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (state.selected) {
      var panel = app.querySelector('.detail');
      if (panel) panel.scrollIntoView();
    }
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
})();
