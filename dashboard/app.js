// Token Radar dashboard. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, the live-token set-aside, and a
// per-protocol detail view with the model's own numbers and the farm plan.
// No network: every byte shown comes from data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', watch: false, tab: 'pre', sort: 'implied', dir: -1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
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
  function fmtMult(n) { return (n === null || n === undefined) ? 'n/a' : Number(n).toFixed(4); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
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

  function findRow(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    if (hash.indexOf('/protocol/') === 0) {
      state.selected = decodeURIComponent(hash.slice('/protocol/'.length));
      state.tab = 'pre';
      return;
    }
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('watchlist') === '1') state.watch = true;
    if (params.get('tab') === 'live') state.tab = 'live';
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
    if (state.watch) params.set('watchlist', '1');
    if (state.tab === 'live') params.set('tab', 'live');
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
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
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

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
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor, held to the same exclusions. Implied value is a model, not a promise — and no row claims a token will launch.' }),
        el('p', { class: 'sub', text: 'Top of the board: ' + (top ? top.name + ' at ' + fmtUsd(top.implied_value_usd) + ' implied.' : '—') })
      ),
      el('div', { class: 'kpis' },
        el('div', { class: 'kpi' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'kpi' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'kpi' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'kpi' }, el('span', { text: 'Global mcap / TVL median' }), el('b', { text: fmtMult(DATA.global_multiple) }))
      )
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
    var watch = el('input', { type: 'checkbox', id: 'watch', checked: state.watch ? 'checked' : null, 'aria-label': 'Watchlist only' });
    watch.addEventListener('change', function () { state.watch = watch.checked; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('label', { class: 'check', for: 'watch' }, watch, 'Watchlist only'),
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

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.watch = false; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('div', null,
            el('b', { text: r.name }),
            r.watchlist ? el('span', { class: 'watch', text: 'WATCHLIST' }) : null
          ),
          el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' on ' + chainText(r) })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'badge', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown, comparables, risks and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
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
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking — and they are the comparables the model is priced from.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function risksFor(r) {
    var risks = [];
    if (r.change_7d !== null && r.change_7d < 0) risks.push('TVL fell ' + fmtPct(r.change_7d) + ' in the last 7 days — momentum is against it.');
    if (r.age_days === null) risks.push('No listing date on record — the model assumes 365 days of age.');
    else if (r.age_days < 180) risks.push('Listed only ' + fmtAge(r.age_days) + ' ago — a short track record with no token.');
    if (r.chains && r.chains.length === 1) risks.push('TVL sits on a single chain (' + r.chains[0] + ') — one chain outage or bridge issue hits the whole position.');
    if (r.model.comp_category_n < 3) risks.push('Fewer than 3 live comparables in its category — the multiple leans on the global median.');
    if (r.tvl_usd < 100000000) risks.push('Below $100M TVL — thinner liquidity and a smaller base for the multiple.');
    risks.push('Records no token — a launch may never happen, and implied value is a model estimate, not a market price.');
    return risks.slice(0, 4);
  }

  function detailPanel() {
    var r = findRow(state.selected);
    if (!r) return null;
    var m = r.model;
    var steps = r.farm_steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
    });
    var catMedian = m.comp_category_median === null ? 'n/a — fewer than 3 live comparables' : fmtMult(m.comp_category_median);
    return el('section', { class: 'panel detail', 'aria-label': 'Protocol detail' },
      el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'brand-sub', text: 'RANK ' + r.rank + ' OF ' + DATA.board_size + (r.watchlist ? ' · WATCHLIST' : ' · EARLY RADAR') }),
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
              el('div', null, el('span', { text: 'Comparable multiple applied' }), el('b', { class: 'num', text: '× ' + fmtMult(m.comp_applied) })),
              el('div', null, el('span', { text: '7-day growth (' + fmtPct(r.change_7d) + ')' }), el('b', { class: 'num', text: '× ' + fmtMult(m.growth_mult) })),
              el('div', null, el('span', { text: 'Maturity (' + fmtAge(r.age_days) + ' with no token)' }), el('b', { class: 'num', text: '× ' + fmtMult(m.maturity_mult) })),
              el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(r.implied_value_usd) }))
            ),
            el('p', { class: 'sub', text: 'implied = round(TVL × comparable multiple × growth multiplier × maturity multiplier). The same function scores every row.' })
          ),
          el('div', { class: 'detail-section' },
            el('h3', { text: 'Comparables' }),
            el('table', { class: 'comps' },
              el('tbody', null,
                el('tr', null, el('td', { text: 'Category median mcap / TVL' }), el('td', { class: 'num', text: catMedian })),
                el('tr', null, el('td', { text: 'Live comparables in category' }), el('td', { class: 'num', text: String(m.comp_category_n) })),
                el('tr', null, el('td', { text: 'Global median mcap / TVL' }), el('td', { class: 'num', text: fmtMult(m.comp_global) })),
                el('tr', null, el('td', { text: 'Multiple applied (shrunk, clamped 0.05–0.80)' }), el('td', { class: 'num', text: fmtMult(m.comp_applied) }))
              )
            )
          ),
          el('div', { class: 'detail-section' },
            el('h3', { text: 'Risks' }),
            el('ul', { class: 'risks' }, risksFor(r).map(function (x) { return el('li', { text: x }); }))
          )
        ),
        el('div', { class: 'detail-section' },
          el('h3', { text: 'Farm plan — 6 steps' }),
          el('ol', { class: 'steps' }, steps),
          el('p', { class: 'sub', text: 'This plan assumes nothing about a future token: the protocol records no token, so farm the product, not a promised launch. Never pay to claim anything.' })
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'One function scores every row, from the snapshot figures only. No protocol name is special-cased and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd × comp × (1 + clamp(change_7d, ' + m.growth_min + ', ' + m.growth_max + ') / 100 × ' + m.growth_weight + ') × (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' × ' + m.maturity_range + ') )'
      ),
      el('p', { class: 'sub', text: 'comp is the category median of market-cap / TVL across live-token protocols with at least ' + m.min_category_comps + ' comparables, shrunk toward the global median (' + fmtMult(DATA.global_multiple) + ') with a prior weight of ' + m.shrink_prior + ', then clamped to [' + m.multiple_min + ', ' + m.multiple_max + ']. Age is the time since the protocol was first listed; an unknown listing date uses ' + m.unknown_age_days + ' days. The early radar is every pre-token protocol below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor that passes the watchlist rule — not a wrapped, staked or bridged product, not a versioned pool, not an exchange product.' }),
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
    shell.appendChild(controls());
    var detail = state.tab === 'pre' ? detailPanel() : null;
    if (detail) shell.appendChild(detail);
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    if (state.tab === 'pre') shell.appendChild(modelPanel());
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
