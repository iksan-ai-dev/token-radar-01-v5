// Token launch radar v5 — fresh build for token-radar-01.
// Reads the sealed DefiLlama snapshot, ranks pre-token protocols by implied
// launch value, and writes board.json + an offline dashboard + dossier.
//
// Model (all fitted at runtime from the snapshot, no hardcoded names):
//   implied = TVL x curve(TVL) x categoryEffect x ageFactor x growthFactor x breadthFactor
//   curve: OLS of log10(mcap/TVL) on log10(TVL) over the 128 tokened comparables.
//   categoryEffect: a category's mean log-residual off the curve, shrunk toward
//     1.0 with 8 pseudo-comparables (the same shrinkage for every category:
//     single-comparable effects such as Risk Curators (api3) and Prediction
//     Market (Rain, mcap/TVL ~400x on $6.6M TVL) are the least trusted numbers
//     in the model, so they are shrunk the hardest, uniformly).
//   ageFactor: 0.55 rising to 1.00 over 730 days with no token (unknown age = 365d).
//   growthFactor: 1 + 0.75 x 7-day TVL change, clamped to [0.6, 1.6].
//   breadthFactor: 1 + 0.08 x ln(chains), capped at 1.25.
//   P25-P75: point value x 10^(+/-0.6745 x sigma), sigma = robust (MAD) spread
//     of the log-residuals after the shrunk category effects.
//   slice/$1K: the farmer's slice per $1,000 deployed, assuming 7.5% of the
//     implied value reaches farmers.
// Run: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DAY_MS = 86_400_000;
const SHRINK_K = 8; // pseudo-comparables each category effect is shrunk with

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar v5: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const snap = JSON.parse(readFileSync(inputFile, 'utf8'));
const asOfMs = Date.parse(snap.as_of);
const floorUsd = snap.floor_usd;
const watchlist: string[] = snap.watchlist;
const protocols = snap.protocols;

// ---- curve fit over tokened comparables ------------------------------------
const comps = protocols.filter((p: any) => p.mcap_usd > 0 && p.tvl_usd > 0);
const xs = comps.map((p: any) => Math.log10(p.tvl_usd));
const ys = comps.map((p: any) => Math.log10(p.mcap_usd / p.tvl_usd));
function ols(X: number[], Y: number[]): [number, number] {
  const m = X.length;
  const mx = X.reduce((a, b) => a + b, 0) / m;
  const my = Y.reduce((a, b) => a + b, 0) / m;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) { sxy += (X[i] - mx) * (Y[i] - my); sxx += (X[i] - mx) ** 2; }
  const b = sxy / sxx;
  return [my - b * mx, b];
}
const [curveA, curveB] = ols(xs, ys);
const curveMult = (tvl: number) => 10 ** (curveA + curveB * Math.log10(tvl));
// Leave-one-out median error factor of the curve.
const looErrs: number[] = [];
for (let i = 0; i < xs.length; i++) {
  const [a2, b2] = ols(xs.filter((_, j) => j !== i), ys.filter((_, j) => j !== i));
  const pred = a2 + b2 * xs[i];
  looErrs.push(Math.max(10 ** (pred - ys[i]), 10 ** (ys[i] - pred)));
}
looErrs.sort((x, y) => x - y);
const loo = (looErrs[63] + looErrs[64]) / 2;
// Flat baseline LOO (one global multiple): refit the mean each fold.
const flatErrs: number[] = [];
for (let i = 0; i < ys.length; i++) {
  const rest = ys.filter((_, j) => j !== i);
  const mu = rest.reduce((a, b) => a + b, 0) / rest.length;
  flatErrs.push(Math.max(10 ** (mu - ys[i]), 10 ** (ys[i] - mu)));
}
flatErrs.sort((x, y) => x - y);
const flatLoo = (flatErrs[63] + flatErrs[64]) / 2;

// ---- category effects, shrunk toward 1.0 -----------------------------------
const catResid: Record<string, number[]> = {};
comps.forEach((p: any, i: number) => {
  const c = p.category ?? '(none)';
  (catResid[c] ??= []).push(ys[i] - (curveA + curveB * xs[i]));
});
const catEffect: Record<string, { n: number; raw: number; eff: number }> = {};
for (const c of Object.keys(catResid)) {
  const r = catResid[c];
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  catEffect[c] = { n: r.length, raw: 10 ** mean, eff: 10 ** (mean * (r.length / (r.length + SHRINK_K))) };
}
const effectOf = (cat: string | null) => (cat && catEffect[cat] ? catEffect[cat].eff : 1);
// Robust spread of residuals after the shrunk effects (MAD sigma).
const residAfter = comps.map((p: any, i: number) => ys[i] - (curveA + curveB * xs[i]) - Math.log10(effectOf(p.category)));
const sortedResid = [...residAfter].sort((a, b) => a - b);
const medResid = sortedResid[Math.floor(sortedResid.length / 2)];
const absDev = residAfter.map((r) => Math.abs(r - medResid)).sort((a, b) => a - b);
const sigma = 1.4826 * absDev[Math.floor(absDev.length / 2)];
const rangeHalf = 10 ** (0.6745 * sigma); // P75/P25 ratio = rangeHalf^2

// ---- factors ----------------------------------------------------------------
function ageDays(p: any): number {
  return p.listed_at ? Math.round((asOfMs - Date.parse(p.listed_at)) / DAY_MS) : 365;
}
const ageFactor = (d: number) => 0.55 + 0.45 * (Math.min(d, 730) / 730);
const growthFactor = (p: any) => (p.change_7d == null ? 1 : Math.max(0.6, Math.min(1.6, 1 + 0.75 * (p.change_7d / 100))));
const breadthFactor = (p: any) => Math.min(1.25, 1 + 0.08 * Math.log(Math.max(1, p.chains.length)));

// ---- launch-candidate rule (the house rule, replicated for non-watchlist) ----
const EXCLUDED_CAT = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini|HTX|KuCoin|Crypto\.com|Deribit|Bitstamp)/;
function isCandidate(p: any): boolean {
  if (!(p.gecko_id == null && p.symbol == null)) return false;
  if (p.category && EXCLUDED_CAT.has(p.category)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  if (/ (V2|v2|2\.0|V3|v3|3\.0)$/.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return p.tvl_usd > 0;
}

// ---- farm plans: one pure builder, shared with the dashboard ---------------
// Templates are data: {family: [8 steps]}. Placeholders: {N} name, {C} main
// chain, {G} gas per tx, {GT} total gas for 8 weeks. main.ts uses this exact
// function for board.json and embeds its source in data.js, so the page
// renders the same steps the board carries.
const FARM_TEMPLATES: Record<string, string[]> = {
  curator: [
    'Connect one wallet to {N} on {C}; bridging funds in costs ~{G} and takes about 15 minutes.',
    "Deposit a first $100-$250 into {N}'s main vault on {C} (gas ~{G}) and save the receipt hash.",
    'Keep the deposit in for a full 6-8 week season: vault points reward time in the vault, not day trips.',
    'Add $50-$150 once a week for 6 weeks, varying the day and amount (gas ~{G} each time).',
    'Open a second {N} vault or strategy, ideally on another chain (gas ~{G}).',
    'Log every deposit date, amount and tx hash; snapshots are usually announced days ahead.',
    "Check {N}'s announcements weekly for a points program or claim window; ignore links in DMs.",
    "If a claim opens, claim only on {N}'s official page, then unwind slowly; total gas for 8 weeks ~{GT}.",
  ],
  lending: [
    'Connect one wallet to {N} on {C}; bridging funds in costs ~{G} and takes about 15 minutes.',
    'Supply $100-$250 of a stablecoin to {N} on {C} first, the lowest-risk way in (gas ~{G}).',
    'Borrow a small amount against the supply, keeping health factor above 2; never borrow to the limit.',
    'Hold supply plus borrow for 6-8 weeks; repay a slice and re-supply once a month (gas ~{G} each).',
    'Repeat in smaller varied amounts weekly; steady repeat use beats one big deposit.',
    'Log every position date, amount and tx hash; snapshots are usually announced days ahead.',
    "Check {N}'s announcements weekly for a points program or claim window; ignore links in DMs.",
    "If a claim opens, claim only on {N}'s official page, then repay and withdraw; total gas ~{GT} for 8 weeks.",
  ],
  dex: [
    'Connect one wallet to {N} on {C}; bridging funds in costs ~{G} and takes about 15 minutes.',
    "Swap $25-$75 on {N}'s cheapest route on {C} (gas ~{G}); keep the receipt hash.",
    "Add $100-$250 of liquidity to {N}'s main pool for 6-8 weeks; fees accrue while you wait.",
    'Swap $25-$100 once or twice a week for 6 weeks, varying pairs and amounts (gas ~{G} each time).',
    "Try {N}'s limit order or DCA feature once, with a small amount, to touch a second surface.",
    'Log every swap date, pair, amount and tx hash; snapshots are usually announced days ahead.',
    "Check {N}'s announcements weekly for a points program or claim window; ignore links in DMs.",
    "If a claim opens, claim only on {N}'s official page, then remove liquidity slowly; total gas ~{GT}.",
  ],
  perps: [
    'Connect one wallet to {N} on {C}; bridging funds in costs ~{G} and takes about 15 minutes.',
    'Open a first small position on {N}: 1-2x leverage only, $50-$150 notional (gas ~{G}).',
    'Trade small weekly for 6-8 weeks, not one big trade; vary size and direction.',
    'Keep margin well above liquidation at all times; a liquidation wipes the position and the record.',
    'If {N} has a vault or LP side, deposit $50-$100 there too for a second surface (gas ~{G}).',
    'Log every trade date, size and tx hash; snapshots are usually announced days ahead.',
    "Check {N}'s announcements weekly for a points program or claim window; ignore links in DMs.",
    "If a claim opens, claim only on {N}'s official page, then close positions; total gas ~{GT} for 8 weeks.",
  ],
  rwa: [
    'Connect one wallet to {N} on {C}; bridging funds in costs ~{G} and takes about 15 minutes.',
    "Buy or mint $100-$250 of {N}'s core asset on {C} (gas ~{G}); save the receipt hash.",
    'Hold the position for a full 6-8 weeks; redeeming and re-minting weekly counts as repeat use.',
    'Use the product a second way - mint, redeem, or transfer - at least twice (gas ~{G}).',
    'Keep collateral or backing ratios comfortably above the minimum if {N} is a CDP-style product.',
    'Log every mint or buy date, amount and tx hash; snapshots are usually announced days ahead.',
    "Check {N}'s announcements weekly for a points program or claim window; ignore links in DMs.",
    "If a claim opens, claim only on {N}'s official page, then unwind slowly; total gas ~{GT} for 8 weeks.",
  ],
  yield: [
    'Connect one wallet to {N} on {C}; bridging funds in costs ~{G} and takes about 15 minutes.',
    "Deposit $100-$250 into {N}'s main vault or strategy on {C} (gas ~{G}); save the receipt hash.",
    'Compound or re-stake rewards every 1-2 weeks for 6-8 weeks; compounding is the signal.',
    'Try a second {N} strategy with $50-$100 so the record shows two surfaces, not one (gas ~{G}).',
    'Hold through one full points season if {N} runs one; early exits usually forfeit the season.',
    'Log every deposit date, amount and tx hash; snapshots are usually announced days ahead.',
    "Check {N}'s announcements weekly for a points program or claim window; ignore links in DMs.",
    "If a claim opens, claim only on {N}'s official page, then unwind slowly; total gas ~{GT} for 8 weeks.",
  ],
  other: [
    'Connect one wallet to {N} on {C}; bridging funds in costs ~{G} and takes about 15 minutes.',
    "Use {N}'s core feature once with $50-$150 on {C} (gas ~{G}) and save the receipt hash.",
    'Repeat the core action weekly for 6-8 weeks, varied amounts; steady use beats one big day.',
    'Try a second feature of {N} - a different pool, market or tool - at least twice (gas ~{G}).',
    'Keep the position live for the whole season; gaps of weeks read as abandonment.',
    'Log every action date, amount and tx hash; snapshots are usually announced days ahead.',
    "Check {N}'s announcements weekly for a points program or claim window; ignore links in DMs.",
    "If a claim opens, claim only on {N}'s official page, then unwind slowly; total gas ~{GT} for 8 weeks.",
  ],
};
const FARM_FAMILY: Record<string, string> = {
  'Risk Curators': 'curator', 'Onchain Capital Allocator': 'curator',
  'Yield Aggregator': 'curator', 'Liquidity Manager': 'curator', 'Collateral Management': 'curator',
  'Yield': 'yield', 'Lending': 'lending', 'CDP': 'lending', 'Dexs': 'dex',
  'Derivatives': 'perps', 'Basis Trading': 'perps', 'Options': 'perps', 'Leveraged Farming': 'perps',
  'RWA': 'rwa', 'Payments': 'rwa', 'Indexes': 'rwa',
};
const GAS_USD: Record<string, number> = {
  'Ethereum': 5, 'Polygon': 0.05, 'Arbitrum': 0.1, 'Optimism': 0.05, 'Base': 0.05,
  'Solana': 0.01, 'Binance': 0.3, 'Tron': 0.5, 'Avalanche': 0.2, 'Sonic': 0.05,
  'Berachain': 0.05, 'Hyperliquid L1': 0.01, 'Sui': 0.02, 'Aptos': 0.02, 'Ink': 0.05,
  'Monad': 0.05, 'Katana': 0.05, 'Unichain': 0.05, 'Robinhood Chain': 0.05, 'Arc': 0.05,
  'Corn': 0.05, 'Tempo': 0.05, 'Stable': 0.05, 'Morph': 0.1, 'Plume Mainnet': 0.1,
  'Bittensor': 0.05, 'BSquared': 0.1, 'Stellar': 0.01, 'Flare': 0.05, 'Citrea': 0.05,
  'Mezo': 0.05, 'Scroll': 0.05, 'BOB': 0.05, 'Sei': 0.05, 'Pharos': 0.05, 'Hemi': 0.05,
  'Bitlayer': 0.1, 'CORE': 0.1, 'Fluent': 0.05, 'Plasma': 0.05, 'Etherlink': 0.05,
};
// Pure: the same function builds board.json steps and, embedded in data.js,
// the steps the dashboard renders. No closure over module scope.
function farmSteps(p: { name: string; chain: string; cat: string | null }, T: Record<string, string[]>, G: Record<string, number>, FAM: Record<string, string>): string[] {
  const fam = (p.cat && FAM[p.cat]) || 'other';
  const steps = T[fam] || T.other;
  const g = G[p.chain] === undefined ? 0.5 : G[p.chain];
  const gs = '$' + (g >= 1 ? String(Math.round(g)) : g.toFixed(2));
  const tot = g * 8;
  const gt = '$' + (tot >= 1 ? String(Math.round(tot)) : tot.toFixed(2));
  const out: string[] = [];
  for (const s of steps) {
    out.push(s.replaceAll('{GT}', gt).replaceAll('{G}', gs).replaceAll('{N}', p.name).replaceAll('{C}', p.chain));
  }
  return out;
}

// ---- score every candidate ---------------------------------------------------
const scored = protocols.filter(isCandidate).map((p: any) => {
  const cm = curveMult(p.tvl_usd);
  const ce = effectOf(p.category);
  const d = ageDays(p);
  const af = ageFactor(d);
  const gf = growthFactor(p);
  const bf = breadthFactor(p);
  const value = Math.round(p.tvl_usd * cm * ce * af * gf * bf);
  const slice = (value * 0.075) / (p.tvl_usd / 1000);
  const take = slice >= 5 ? 'worth it' : slice >= 2 ? 'watch' : 'thin';
  return {
    slug: p.slug, name: p.name, category: p.category, chains: p.chains,
    tvl_usd: p.tvl_usd, change_7d: p.change_7d, age_days: d,
    age_factor: Math.round(af * 1000) / 1000, growth_factor: Math.round(gf * 1000) / 1000,
    breadth_factor: Math.round(bf * 1000) / 1000, cat_effect: Math.round(ce * 1000) / 1000,
    cat_n: p.category && catEffect[p.category] ? catEffect[p.category].n : 0,
    curve_multiple: Math.round(cm * 10000) / 10000,
    implied_value_usd: value,
    p25_usd: Math.round(value / rangeHalf), p75_usd: Math.round(value * rangeHalf),
    slice_per_1k: Math.round(slice * 100) / 100, verdict: take,
    watchlist: watchlist.includes(p.slug),
    farm_steps: farmSteps({ name: p.name, chain: p.chains[0], cat: p.category }, FARM_TEMPLATES, GAS_USD, FARM_FAMILY),
  };
});
scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
const watchRows = scored.filter((r) => r.watchlist);
const earlyRows = scored.filter((r) => !r.watchlist).slice(0, 158);
const board = [...watchRows, ...earlyRows].sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
board.forEach((r, i) => { (r as any).rank = i + 1; (r as any).tier = r.watchlist ? 'Watchlist' : 'Early find'; });
const belowFloor = board.filter((r) => r.tvl_usd < floorUsd).length;
const alreadyTrading = protocols.filter((p: any) => p.gecko_id != null || p.symbol != null).length;
const setAside = protocols.length - board.length - alreadyTrading;
// Why each set-aside protocol was set aside (first matching rule), for the tab.
const setAsideBy: Record<string, number> = {};
const boardSlugs = new Set(board.map((r) => r.slug));
for (const p of protocols) {
  if (boardSlugs.has(p.slug)) continue;
  if (p.gecko_id != null || p.symbol != null) continue;
  let reason = 'below the board cut';
  if (p.category && EXCLUDED_CAT.has(p.category)) reason = 'excluded category: ' + p.category;
  else if (/\b(wrapped|staked|staking)\b/i.test(p.name)) reason = 'wrapped / staked name';
  else if (/ (V2|v2|2\.0|V3|v3|3\.0)$/.test(p.name)) reason = 'version-suffixed name';
  else if (EXCHANGE_PREFIX.test(p.name)) reason = 'exchange-prefixed name';
  else if (!(p.tvl_usd > 0)) reason = 'no TVL';
  setAsideBy[reason] = (setAsideBy[reason] ?? 0) + 1;
}
const cut3 = scored.filter((r) => !r.watchlist).slice(158, 161)
  .map((r) => [r.slug, r.name, Math.round(r.implied_value_usd / 1e6 * 10) / 10]);
const totalImplied = board.reduce((s, r) => s + r.implied_value_usd, 0);

// ---- gate self-check ---------------------------------------------------------
function boardIssue(): string | null {
  if (board.length < 100 || board.length > 4000) return `rows ${board.length}`;
  for (const w of watchlist) if (!board.some((r) => r.slug === w)) return `watchlist missing ${w}`;
  for (let i = 0; i < board.length; i++) {
    if ((board[i] as any).rank !== i + 1) return `rank ${i}`;
    if (i > 0 && board[i].implied_value_usd > board[i - 1].implied_value_usd) return 'not monotonic';
    if (board[i].farm_steps.length < 3 || board[i].farm_steps.length > 12) return `steps ${board[i].slug}`;
    for (const s of board[i].farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `step length ${board[i].slug}`;
  }
  return null;
}
const issue = boardIssue();
if (issue) { process.stderr.write(`token radar v5: board refused: ${issue}\n`); process.exit(1); }

// ---- dashboard data.js -------------------------------------------------------
// Compact rows: [rank, slug, name, category, mainChain, nChains, tvlM(1dp),
// change7d(1dp|null), ageDays, value, slice, take, tier(W/E), ageF, growF,
// breadthF, catEff, catN, curveMult]. P25/P75 are derived on the page from
// value and meta.ratio (point x 10^(+/-0.6745 sigma)), so they cost no bytes.
const r1 = (x: number) => Math.round(x * 10) / 10;
// Category names are stored once and referenced by index in rows/comps:
// the same string repeated 198 times would cost ~2KB of dossier text.
const catNames = [...new Set([...board.map((r: any) => r.category), ...comps.map((p: any) => p.category)].filter((c) => c != null))].sort();
const catIndex = (c: string | null) => (c == null ? -1 : catNames.indexOf(c));
const dataRows = board.map((r: any) => [
  r.rank, r.slug, r.name, catIndex(r.category), r.chains[0], r.chains.length,
  r1(r.tvl_usd / 1e6), r.change_7d == null ? null : r1(r.change_7d), r.age_days,
  r.implied_value_usd, r.slice_per_1k, r.verdict, r.watchlist ? 'W' : 'E',
  r.age_factor, r.growth_factor, r.breadth_factor, r.cat_effect, r.cat_n, r.curve_multiple,
]);
// Comparables for the detail view: [slug, categoryIdx, tvlM, multiple].
// Names are derived from the slug on the page; the page picks the 3 nearest
// by log-TVL in the same category at render time.
const dataComps = comps.map((p: any) => [
  p.slug, catIndex(p.category), r1(p.tvl_usd / 1e6), Math.round((p.mcap_usd / p.tvl_usd) * 10000) / 10000,
]);
// Category effects table for the Model tab: [category, n, raw, shrunk].
const dataCats = Object.keys(catEffect).sort((a, b) => catEffect[b].n - catEffect[a].n || (a < b ? -1 : 1))
  .map((c) => [c, catEffect[c].n, Math.round(catEffect[c].raw * 1000) / 1000, Math.round(catEffect[c].eff * 1000) / 1000]);
const meta = {
  asOf: snap.as_of, floorM: floorUsd / 1e6, scanned: protocols.length,
  boardN: board.length, watchN: watchlist.length, earlyN: earlyRows.length,
  belowFloor, liveN: alreadyTrading, setAside, totalImpliedM: Math.round(totalImplied / 1e6),
  curveA: Math.round(curveA * 10000) / 10000, curveB: Math.round(curveB * 10000) / 10000,
  loo: Math.round(loo * 10000) / 10000, flatLoo: Math.round(flatLoo * 10000) / 10000,
  sigma: Math.round(sigma * 10000) / 10000, ratio: Math.round(rangeHalf * rangeHalf * 100) / 100,
  shrinkK: SHRINK_K, compsN: comps.length, setAsideBy, cut3,
};
const dataJs = [
  `window.buildSteps = ${farmSteps.toString()};`,
  `window.FARM_T = ${JSON.stringify(FARM_TEMPLATES)};`,
  `window.FARM_G = ${JSON.stringify(GAS_USD)};`,
  `window.FARM_FAM = ${JSON.stringify(FARM_FAMILY)};`,
  `window.RADAR=${JSON.stringify({ meta, catNames, rows: dataRows, comps: dataComps, cats: dataCats })};`,
  '',
].join('\n');
if (dataJs.includes('};', dataJs.indexOf('window.RADAR'))) {
  // The validator regexes window.RADAR={...}; greedily; a "};" inside a
  // string would break its parse. Guard the build instead of shipping it.
  const tail = dataJs.slice(dataJs.indexOf('window.RADAR'));
  if (tail.indexOf('};') !== tail.lastIndexOf('};')) {
    process.stderr.write('token radar v5: data.js RADAR literal contains an inner "};", refusing to ship\n');
    process.exit(1);
  }
}

// ---- write out/ ---------------------------------------------------------------
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}
copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
writeFileSync(join(out, 'dashboard', 'data.js'), dataJs);
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar v5: screenshots/ holds ${shots.length}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) { process.stderr.write(`token radar v5: bad screenshot name ${name}\n`); process.exit(1); }
}
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));
const dossierTextBytes = Buffer.byteLength(JSON.parse(readFileSync(join(out, 'dossier.json'), 'utf8')).text, 'utf8');
const top5 = board.slice(0, 5).map((r: any) => `#${r.rank} ${r.slug} $${(r.implied_value_usd / 1e6).toFixed(1)}M ${r.verdict}`).join(' | ');
const sent = board.find((r: any) => r.slug === 'sentora-curator');
process.stdout.write(
  `token radar v5: ${protocols.length} scanned = ${board.length} ranked (${watchRows.length} watchlist + ${earlyRows.length} early, ${belowFloor} below floor) + ${alreadyTrading} already trading + ${setAside} set aside\n` +
  `token radar v5: LOO x${loo.toFixed(4)} (flat x${flatLoo.toFixed(2)}), curve 10^${curveA.toFixed(4)} x TVL^${curveB.toFixed(4)}, sigma ${sigma.toFixed(4)}, P25-P75 ratio x${(rangeHalf * rangeHalf).toFixed(2)}\n` +
  `token radar v5: Sentora $${(sent.implied_value_usd / 1e6).toFixed(1)}M rank ${sent.rank}, P25-P75 $${(sent.p25_usd / 1e6).toFixed(1)}M-$${(sent.p75_usd / 1e6).toFixed(1)}M\n` +
  `token radar v5: top5: ${top5}\n` +
  `token radar v5: dossier text ${dossierTextBytes} / 65536 bytes, data.js ${Buffer.byteLength(dataJs, 'utf8')} bytes\n` +
  `token radar v5: wrote ${join(out, 'board.json')}, ${join(out, 'dashboard')} (${shots.length} screenshots) and ${join(out, 'dossier.json')}\n`,
);
