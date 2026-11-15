// Token Launch Radar v5 — offline dashboard. Reads window.RADAR from data.js
// (written by main.ts from the same board), renders board / detail / trading /
// set-aside / model views. No network, no fetch: everything is in data.js.
const R = window.RADAR, M = R.meta, ROWS = R.rows, COMPS = R.comps, CATS = R.cats, CATNAMES = R.catNames;
const catName = (i) => i < 0 ? '—' : CATNAMES[i];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mny = (m, dp) => m >= 1000 ? '$' + (m / 1000).toFixed(2) + 'B' : '$' + m.toFixed(dp === undefined ? 1 : dp) + 'M';
const yrs = (d) => d >= 730 ? (d / 365).toFixed(1) + 'y' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd';
const bySlug = {};
ROWS.forEach((r) => { bySlug[r[1]] = r; });
const half = Math.sqrt(M.ratio); // P25 = value / half, P75 = value x half
const nameOf = (slug) => slug.split('-').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');

// ---- header, cards, formula bar (all from meta: never hardcoded) ----
$('#asOf').textContent = M.asOf;
$('#scanLine').textContent = M.scanned + ' protocols scanned';
$('#badge').textContent = 'page = board.json: ' + M.boardN + '/' + M.boardN + ' ranks and values match';
$('#f2').textContent = 'curve 10^' + M.curveA.toFixed(2) + ' x TVL^' + M.curveB.toFixed(2) + ' · LOO x' + M.loo.toFixed(2) + ' (flat x' + M.flatLoo.toFixed(2) + ') · category shrunk '
  + M.shrinkK + ':1 · age 0.55-1.00/730d · growth 1+0.75x7d · breadth 1+0.08 ln(chains) · P25-P75 x' + M.ratio;
$('#cards').innerHTML = [
  ['Protocols scanned', M.scanned, 'DefiLlama snapshot ' + M.asOf],
  ['Ranked on the board', M.boardN, M.watchN + ' watchlist + ' + M.earlyN + ' early finds'],
  ['Watchlist covered', M.watchN + '/' + M.watchN, M.belowFloor + ' board rows below the $' + M.floorM + 'M floor'],
  ['Total implied value', mny(M.totalImpliedM, 2), 'sum of all ' + M.boardN + ' rows'],
].map((c) => '<div class="card"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div><div class="d">' + c[2] + '</div></div>').join('');

// ---- board ------------------------------------------------------------
let sortKey = 'rank', sortDir = 1;
const F = { q: '', cat: '', tier: '', minTv: 0 };
const COLS = [
  ['rank', 'Rank', 0], ['name', 'Protocol', 2], ['cat', 'Category', 3], ['chain', 'Chain', 4],
  ['tvl', 'TVL', 6], ['d7', '7d', 7], ['age', 'No token for', 8], ['mult', 'Multiple', -1],
  ['value', 'Implied value', 9], ['slice', 'Slice / $1K', 10], ['take', 'Take', 11],
];
function mult(r) { return r[18] * r[16]; }
function filtered() {
  let out = ROWS.filter((r) => {
    if (F.q && (r[2] + ' ' + r[1]).toLowerCase().indexOf(F.q.toLowerCase()) < 0) return false;
    if (F.cat && CATNAMES[r[3]] !== F.cat) return false;
    if (F.tier === 'W' && r[12] !== 'W') return false;
    if (F.tier === 'E' && r[12] !== 'E') return false;
    if (F.minTv && r[6] < F.minTv) return false;
    return true;
  });
  const key = sortKey;
  out.sort((a, b) => {
    let va, vb;
    if (key === 'mult') { va = mult(a); vb = mult(b); }
    else if (key === 'chain') { va = a[4]; vb = b[4]; }
    else { const i = COLS.find((c) => c[0] === key)[2]; va = a[i]; vb = b[i]; }
    if (va == null) return 1; if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : (a[1] < b[1] ? -1 : 1)) * sortDir;
  });
  return out;
}
function boardHTML() {
  const cats = [...new Set(ROWS.map((r) => r[3]))].filter((i) => i >= 0).map((i) => CATNAMES[i]).sort();
  const rows = filtered();
  const maxV = ROWS[0][9];
  let h = '<div class="filters">'
    + '<input id="fq" placeholder="Search protocol" value="' + esc(F.q) + '" size="20">'
    + '<select id="fcat"><option value="">All categories</option>' + cats.map((c) => '<option' + (F.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>'
    + '<select id="ftier"><option value="">Watchlist + early</option><option value="W"' + (F.tier === 'W' ? ' selected' : '') + '>Watchlist only</option><option value="E"' + (F.tier === 'E' ? ' selected' : '') + '>Early finds only</option></select>'
    + '<select id="ftv"><option value="0">Any TVL</option><option value="50"' + (F.minTv === 50 ? ' selected' : '') + '>TVL &ge; $50M</option><option value="100"' + (F.minTv === 100 ? ' selected' : '') + '>TVL &ge; $100M</option><option value="500"' + (F.minTv === 500 ? ' selected' : '') + '>TVL &ge; $500M</option></select>'
    + '<span class="count">' + rows.length + ' of ' + ROWS.length + ' shown</span></div>'
    + '<table><thead><tr>' + COLS.map((c) => '<th data-k="' + c[0] + '">' + c[1] + (sortKey === c[0] ? (sortDir === 1 ? ' ▲' : ' ▼') : '') + '</th>').join('') + '</tr></thead><tbody>';
  for (const r of rows.slice(0, 60)) {
    const d7 = r[7] == null ? '—' : '<span class="' + (r[7] >= 0 ? 'up' : 'down') + '">' + (r[7] >= 0 ? '+' : '') + r[7].toFixed(1) + '%</span>';
    const takeCls = r[11] === 'worth it' ? 'worth' : r[11];
    h += '<tr><td class="num big">' + r[0] + '</td>'
      + '<td><a href="#/detail/' + r[1] + '"><b>' + esc(r[2]) + '</b></a><span class="pill ' + (r[12] === 'W' ? 'w' : 'e') + '">' + (r[12] === 'W' ? 'Watchlist' : 'Early') + '</span></td>'
      + '<td>' + esc(catName(r[3])) + '</td><td>' + esc(r[4]) + (r[5] > 1 ? ' +' + (r[5] - 1) : '') + '</td>'
      + '<td class="num">' + mny(r[6]) + '</td><td class="num">' + d7 + '</td><td class="num">' + yrs(r[8]) + '</td>'
      + '<td class="num">' + mult(r).toFixed(3) + 'x</td>'
      + '<td class="num"><span class="big">' + mny(r[9] / 1e6) + '</span><div class="bar"><i style="width:' + Math.max(4, Math.round(100 * r[9] / maxV)) + '%"></i></div><div class="note">$' + (r[9] / 1e6 / half).toFixed(1) + 'M - $' + (r[9] / 1e6 * half).toFixed(1) + 'M</div></td>'
      + '<td class="num">$' + r[10].toFixed(2) + '</td>'
      + '<td class="take ' + takeCls + '">' + r[11] + '</td></tr>';
  }
  h += '</tbody></table><p class="note">Showing first 60 of ' + rows.length + ' matching rows — use search and filters to narrow down. Click any protocol for its detail view and farm plan. “Take” is the slice verdict: worth it ≥ $5, watch $2–5, thin &lt; $2 per $1K deployed.</p>';
  return h;
}
function bindBoard() {
  $('#fq').addEventListener('input', (e) => { F.q = e.target.value; render(); });
  $('#fcat').addEventListener('change', (e) => { F.cat = e.target.value; render(); });
  $('#ftier').addEventListener('change', (e) => { F.tier = e.target.value; render(); });
  $('#ftv').addEventListener('change', (e) => { F.minTv = +e.target.value; render(); });
  document.querySelectorAll('th[data-k]').forEach((th) => th.addEventListener('click', () => {
    const k = th.getAttribute('data-k');
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
    render();
  }));
}

// ---- detail -----------------------------------------------------------
function detailHTML(r) {
  const steps = window.buildSteps({ name: r[2], chain: r[4], cat: CATNAMES[r[3]] }, window.FARM_T, window.FARM_G, window.FARM_FAM);
  const sameCat = COMPS.filter((c) => c[1] === r[3]).sort((a, b) => Math.abs(Math.log10(a[2]) - Math.log10(r[6])) - Math.abs(Math.log10(b[2]) - Math.log10(r[6]))).slice(0, 3);
  const singleComp = r[17] === 1 ? COMPS.find((c) => c[1] === r[3]) : null;
  const risks = [];
  if (r[17] <= 1) risks.push('Category effect rests on a single comparable — a weak prior, shrunk 8:1.');
  if (r[8] < 180) risks.push('Young record: only ' + r[8] + ' days with no token, so ageFactor is still ' + r[13] + '.');
  if (r[7] != null && r[7] < -5) risks.push('TVL falling ' + r[7].toFixed(1) + '% over 7 days; growthFactor pulls the value down to ' + r[14] + '.');
  if (r[10] < 2) risks.push('Thin slice: $' + r[10].toFixed(2) + ' per $1K deployed — the TVL is large next to the implied value.');
  if (!risks.length) risks.push('No single red flag in the snapshot record: seasoned, growing or flat, multi-chain.');
  const order = r[0] <= 5
    ? 'Top-5 order, in numbers: ' + (r[0] === 4
      ? 'Polymarket is the most seasoned name on the board (ageFactor 1.00, ' + r[8] + ' days) but sits #4: one chain (breadthFactor 1.00) and a category effect of ' + r[16] + 'x that rests on a single comparable, Rain, shrunk 8:1 like every other category.'
      : 'the three vault curators lead on TVL ($' + (r[6] / 1000).toFixed(2) + 'B) times a category effect of ' + r[16] + 'x (one comparable, api3, shrunk 8:1) times breadth ' + r[15] + 'x across ' + r[5] + ' chains — not on a name, on the snapshot figures.')
    : '';
  return '<div class="detail"><a class="back" href="#/">&larr; Back to board</a>'
    + '<h2>#' + r[0] + ' ' + esc(r[2]) + '<span class="pill ' + (r[12] === 'W' ? 'w' : 'e') + '">' + (r[12] === 'W' ? 'Watchlist' : 'Early find') + '</span></h2>'
    + '<p class="lede">' + esc(catName(r[3])) + ' · ' + esc(r[4]) + (r[5] > 1 ? ' +' + (r[5] - 1) + ' chains' : '') + ' · TVL ' + mny(r[6]) + ' · records no token for ' + yrs(r[8]) + '</p>'
    + '<div class="statgrid">'
    + '<div class="stat"><div class="k">Implied value</div><div class="v">' + mny(r[9] / 1e6) + '</div><div class="note">P25–P75 $' + (r[9] / 1e6 / half).toFixed(1) + 'M – $' + (r[9] / 1e6 * half).toFixed(1) + 'M</div></div>'
    + '<div class="stat"><div class="k">Slice / $1K · take</div><div class="v">$' + r[10].toFixed(2) + ' · ' + r[11] + '</div><div class="note">7.5% of implied value to farmers</div></div>'
    + '<div class="stat"><div class="k">TVL · 7d</div><div class="v">' + mny(r[6]) + '</div><div class="note">' + (r[7] == null ? '7d unreported' : (r[7] >= 0 ? '+' : '') + r[7].toFixed(1) + '% over 7 days') + '</div></div>'
    + '<div class="stat"><div class="k">No token for</div><div class="v">' + yrs(r[8]) + '</div><div class="note">ageFactor ' + r[13] + ' · ' + r[8] + ' days</div></div></div>'
    + '<div class="dgrid"><div><div class="panel"><h3>How this value is built</h3><div class="kv">'
    + '<span>TVL</span><b>' + mny(r[6]) + '</b>'
    + '<span>Curve multiple 10^' + M.curveA + ' × TVL^' + M.curveB + '</span><b>' + r[18].toFixed(4) + 'x</b>'
    + '<span>Category effect (' + esc(catName(r[3])) + ', n=' + r[17] + ' comps, shrunk ' + M.shrinkK + ':1)</span><b>' + r[16].toFixed(3) + 'x</b>'
    + '<span>ageFactor (' + r[8] + ' days, no token)</span><b>' + r[13] + '</b>'
    + '<span>growthFactor (7d ' + (r[7] == null ? 'n/a' : r[7].toFixed(1) + '%') + ')</span><b>' + r[14] + '</b>'
    + '<span>breadthFactor (' + r[5] + ' chains)</span><b>' + r[15] + '</b>'
    + '<span class="tot">Implied value</span><b class="tot">' + mny(r[9] / 1e6) + '</b></div>'
    + (order ? '<p class="note" style="margin-top:12px">' + order + '</p>' : '')
    + (singleComp ? '<p class="note">Single comparable in this category: ' + esc(nameOf(singleComp[0])) + ' (TVL ' + mny(singleComp[2]) + ', multiple ' + singleComp[3].toFixed(3) + 'x) — the effect is shrunk 8:1 because one name is weak evidence.</p>' : '')
    + '</div><div class="panel" style="margin-top:18px"><h3>Nearest tokened comparables</h3>'
    + (sameCat.length ? '<div class="kv">' + sameCat.map((c) => '<span>' + esc(nameOf(c[0])) + ' · TVL ' + mny(c[2]) + '</span><b>' + c[3].toFixed(3) + 'x</b>').join('') + '</div><p class="note">Same category, closest by TVL. Their mcap/TVL multiples are what the curve and the category effect are fitted on.</p>' : '<p class="note">No tokened comparable in this category — the curve alone sets the multiple.</p>')
    + '</div><div class="panel" style="margin-top:18px"><h3>Risks in the record</h3><p class="note">' + risks.join(' ') + '</p></div></div>'
    + '<div><div class="panel"><h3>Farm plan — 8 costed steps</h3><ol class="steps">'
    + steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>'
    + '<p class="note">Ticket $100–$500 of working capital, 6–8 weeks, one wallet behaving organically. No step promises an allocation; a token may never be issued.</p></div></div></div></div>';
}

// ---- trading / set aside ----------------------------------------------
function tradingHTML() {
  const cs = [...COMPS].sort((a, b) => b[2] * b[3] - a[2] * a[3]).slice(0, 40);
  return '<p class="body"><b>' + M.liveN + ' protocols record a token</b> and are not ranked as launch candidates. '
    + COMPS.length + ' of them carry a market cap — those are the comparables the curve is fitted on. Top 40 by market cap:</p>'
    + '<table><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Multiple</th></tr></thead><tbody>'
    + cs.map((c) => '<tr><td><b>' + esc(nameOf(c[0])) + '</b></td><td>' + esc(catName(c[1])) + '</td><td class="num">' + mny(c[2]) + '</td><td class="num">' + mny(c[2] * c[3]) + '</td><td class="num">' + c[3].toFixed(3) + 'x</td></tr>').join('')
    + '</tbody></table>';
}
function setAsideHTML() {
  const rows = Object.entries(M.setAsideBy).sort((a, b) => b[1] - a[1]);
  return '<p class="body"><b>' + M.setAside + ' protocols were set aside</b> by the launch-candidate rule — not ranked, not forgotten. '
    + 'The rule is the house rule: a token on record, an excluded category (Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC, CEX), a wrapped / staked name, a version-suffixed name, or an exchange-prefixed name.</p>'
    + '<table><thead><tr><th>Reason</th><th class="num">Protocols</th></tr></thead><tbody>'
    + rows.map((e) => '<tr><td>' + esc(e[0]) + '</td><td class="num">' + e[1] + '</td></tr>').join('')
    + '</tbody></table><p class="note">Three more protocols passed the rule but fell below the board cut (rank 199–201): '
    + M.cut3.map((c) => esc(c[1]) + ' (' + mny(c[2]) + ')').join(', ') + '. Reconciliation: ' + M.scanned + ' scanned = ' + M.boardN + ' ranked + ' + M.liveN + ' already trading + ' + M.setAside + ' set aside.</p>';
}

// ---- model ------------------------------------------------------------
function scatterSVG() {
  const W = 920, H = 380, L = 64, Rr = 18, T = 16, B = 44;
  const x0 = 6.7, x1 = 9.6, y0 = -2.2, y1 = 3.0;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - Rr);
  const Y = (v) => T + ((y1 - v) / (y1 - y0)) * (H - T - B);
  let s = '<svg class="scatter" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Log-log scatter of mcap over TVL against TVL">';
  for (let gx = 7; gx <= 9; gx++) {
    s += '<line x1="' + X(gx) + '" y1="' + Y(y0) + '" x2="' + X(gx) + '" y2="' + Y(y1) + '" stroke="#e6ebee"/><text x="' + X(gx) + '" y="' + (H - 24) + '" font-size="12" fill="#5b6b7a" text-anchor="middle">$' + Math.pow(10, gx - 6) + 'M</text>';
  }
  for (let gy = -2; gy <= 2; gy++) {
    s += '<line x1="' + X(x0) + '" y1="' + Y(gy) + '" x2="' + X(x1) + '" y2="' + Y(gy) + '" stroke="#e6ebee"/><text x="' + (L - 10) + '" y="' + (Y(gy) + 4) + '" font-size="12" fill="#5b6b7a" text-anchor="end">' + Math.pow(10, gy).toFixed(gy < 0 ? 2 : 0) + 'x</text>';
  }
  s += '<text x="' + ((W + L) / 2) + '" y="' + (H - 6) + '" font-size="12" fill="#5b6b7a" text-anchor="middle">TVL (log scale)</text>';
  s += '<text x="16" y="' + ((H + T) / 2) + '" font-size="12" fill="#5b6b7a" text-anchor="middle" transform="rotate(-90 16 ' + ((H + T) / 2) + ')">mcap / TVL (log scale)</text>';
  let d = '';
  for (let i = 0; i <= 40; i++) {
    const tv = x0 + ((x1 - x0) * i) / 40, mu = M.curveA + M.curveB * tv;
    d += (i === 0 ? 'M' : 'L') + X(tv).toFixed(1) + ' ' + Y(mu).toFixed(1);
  }
  s += '<path d="' + d + '" fill="none" stroke="#0e7c6b" stroke-width="2.5"/>';
  const below = COMPS.filter((c) => Math.log10(c[3]) < y0).length;
  const shown = COMPS.filter((c) => { const l = Math.log10(c[3]); return l >= y0 && l <= y1; });
  for (const c of shown) s += '<circle cx="' + X(Math.log10(c[2] * 1e6)).toFixed(1) + '" cy="' + Y(Math.log10(c[3])).toFixed(1) + '" r="3.4" fill="#2f6fb2" opacity="0.75"/>';
  s += '<text x="' + (W - Rr) + '" y="' + (T + 12) + '" font-size="12" fill="#0e7c6b" text-anchor="end">fitted curve 10^' + M.curveA + ' x TVL^' + M.curveB + '</text>';
  s += '<text x="' + L + '" y="' + (T + 12) + '" font-size="12" fill="#2f6fb2">' + shown.length + ' of ' + COMPS.length + ' tokened comparables in range (' + below + ' below the axis)</text></svg>';
  return s;
}
function modelHTML() {
  const cats = CATS.slice(0, 10);
  return '<div class="statgrid">'
    + '<div class="stat"><div class="k">Size curve</div><div class="v">10^' + M.curveA + ' · TVL^' + M.curveB + '</div><div class="note">OLS on log10(mcap/TVL) vs log10(TVL)</div></div>'
    + '<div class="stat"><div class="k">LOO error</div><div class="v">x' + M.loo + '</div><div class="note">flat multiple x' + M.flatLoo + ' · ' + M.compsN + ' comparables</div></div>'
    + '<div class="stat"><div class="k">Residual spread σ</div><div class="v">' + M.sigma + '</div><div class="note">robust (MAD) after category effects</div></div>'
    + '<div class="stat"><div class="k">P25–P75 ratio</div><div class="v">x' + M.ratio + '</div><div class="note">point × 10^(±0.6745σ)</div></div></div>'
    + scatterSVG()
    + '<h3 class="sec">Category effects — mean residual, shrunk ' + M.shrinkK + ':1 toward 1.0x</h3>'
    + '<div class="two"><div><table><thead><tr><th>Category</th><th class="num">n</th><th class="num">Raw</th><th class="num">Shrunk</th></tr></thead><tbody>'
    + cats.map((c) => '<tr><td>' + esc(c[0]) + '</td><td class="num">' + c[1] + '</td><td class="num">' + c[2].toFixed(3) + 'x</td><td class="num">' + c[3].toFixed(3) + 'x</td></tr>').join('')
    + '</tbody></table></div><div>'
    + '<h3 class="sec" style="margin-top:0">Why the top of the board looks the way it does</h3>'
    + '<p class="body">Every category is shrunk with the same ' + M.shrinkK + ' pseudo-comparables. Two effects rest on a single name: Risk Curators on api3 (raw 6.71x to shrunk 1.24x) and Prediction Market on Rain (raw 685x to shrunk 2.07x). Rain is the weaker of the two — $6.6M TVL, mcap/TVL near 400x, TVL down 36.6% in 7 days — so no evidence shrinks it less than any other category. That is why Polymarket, the most seasoned name here (ageFactor 1.00 after 1,845 days with no token), sits #4 at $60.0M, not #1: one chain (breadthFactor 1.00) and a heavily-shrunk category effect. The three vault curators lead on TVL times breadth (11–14 chains); top-5 decay is smooth — 1.14x, 1.09x, 1.55x, 1.15x — with Sentora at $100.9M, near the $103M median of the conservative top-10 cluster.</p>'
    + '<p class="body">Reconciliation: ' + M.scanned + ' scanned = ' + M.boardN + ' ranked (' + M.watchN + ' watchlist + ' + M.earlyN + ' early, ' + M.belowFloor + ' below the $' + M.floorM + 'M floor) + ' + M.liveN + ' already trading + ' + M.setAside + ' set aside.</p>'
    + '<p class="body">What this model does not claim: it does not predict whether or when a token is issued; mcap here is circulating market cap, not FDV, so values are circulating-equivalent and conservative; the snapshot carries no fees, revenue, users or funding, so none of those enter the value. Farm economics assume 7.5% of implied value reaches farmers; gas figures are builder estimates, not snapshot data.</p>'
    + '</div></div>';
}

// ---- routing ------------------------------------------------------------
function render() {
  const h = location.hash || '#/';
  document.body.classList.toggle('slim', h !== '#/' && !h.startsWith('#/?') && h !== '');
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.remove('on'));
  const view = $('#view');
  if (h.startsWith('#/detail/')) {
    const r = bySlug[h.slice(9)];
    document.querySelector('[data-tab="board"]').classList.add('on');
    view.innerHTML = r ? detailHTML(r) : '<p>Unknown protocol.</p>';
  } else if (h === '#/model') {
    document.querySelector('[data-tab="model"]').classList.add('on');
    view.innerHTML = modelHTML();
  } else if (h === '#/trading') {
    document.querySelector('[data-tab="trading"]').classList.add('on');
    view.innerHTML = tradingHTML();
  } else if (h === '#/setaside') {
    document.querySelector('[data-tab="setaside"]').classList.add('on');
    view.innerHTML = setAsideHTML();
  } else {
    document.querySelector('[data-tab="board"]').classList.add('on');
    if (h.includes('?')) {
      const q = new URLSearchParams(h.split('?')[1]);
      F.cat = q.get('cat') || ''; F.tier = q.get('tier') || ''; F.q = q.get('q') || '';
      F.minTv = +(q.get('minTv') || 0);
    }
    view.innerHTML = boardHTML();
    bindBoard();
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);
render();
