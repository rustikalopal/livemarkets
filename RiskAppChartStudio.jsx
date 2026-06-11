import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

/**
 * Chart-Station — Risiko-Journal
 * 1–4 Kachel-Charts (Krypto via Binance keyless, Aktien via Yahoo (CORS-Proxy)).
 * Cursor-verankerter Zoom, exaktes Fadenkreuz (getScreenCTM), Pan.
 * Claude-Vision-Analyse pro Chart, Direct-Browser-Access (kein Server).
 */

const C = {
  bg: "#ECEFF3", panel: "#FFFFFF", panel2: "#F7F9FC", line: "#E2E6EC",
  text: "#2C313A", dim: "#69707D", faint: "#A2A9B4",
  accent: "#5274A6", up: "#4E9A77", down: "#CB6E5B", warn: "#C2974B",
  ma20: "#C2974B", ma50: "#8A7CB0",
};
const MONO = "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const TFS = [{ id: "15m", l: "15m" }, { id: "1h", l: "1H" }, { id: "4h", l: "4H" }, { id: "1d", l: "1D" }, { id: "1w", l: "1W" }];
const LOAD = 500;
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Kuratierte Aktien/ETFs für die Suche (Freitext für beliebige Ticker bleibt möglich)
const STOCKS = [
  ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "Nvidia"], ["GOOGL", "Alphabet"], ["AMZN", "Amazon"],
  ["META", "Meta"], ["TSLA", "Tesla"], ["AMD", "AMD"], ["NFLX", "Netflix"], ["AVGO", "Broadcom"],
  ["INTC", "Intel"], ["MU", "Micron"], ["PLTR", "Palantir"], ["COIN", "Coinbase"], ["MSTR", "MicroStrategy"],
  ["JPM", "JPMorgan"], ["BAC", "Bank of America"], ["V", "Visa"], ["MA", "Mastercard"], ["BRK.B", "Berkshire B"],
  ["XOM", "ExxonMobil"], ["CVX", "Chevron"], ["UNH", "UnitedHealth"], ["JNJ", "Johnson & Johnson"], ["PG", "Procter & Gamble"],
  ["KO", "Coca-Cola"], ["PEP", "PepsiCo"], ["DIS", "Disney"], ["BA", "Boeing"], ["CAT", "Caterpillar"],
  ["WMT", "Walmart"], ["HD", "Home Depot"], ["MCD", "McDonald's"], ["NKE", "Nike"], ["CRM", "Salesforce"],
  ["ORCL", "Oracle"], ["ADBE", "Adobe"], ["CSCO", "Cisco"], ["QCOM", "Qualcomm"], ["TXN", "Texas Instruments"],
  ["ASML", "ASML"], ["TSM", "TSMC"], ["SPY", "S&P 500 ETF"], ["QQQ", "Nasdaq 100 ETF"], ["IWM", "Russell 2000 ETF"],
  ["DIA", "Dow Jones ETF"], ["VTI", "Total Market ETF"], ["GLD", "Gold ETF"], ["SLV", "Silver ETF"], ["TLT", "20Y Treasury ETF"],
  ["ARKK", "ARK Innovation"], ["SMH", "Semiconductor ETF"], ["XLE", "Energy ETF"], ["XLF", "Financials ETF"], ["XLK", "Technology ETF"],
].map(([s, name]) => ({ market: "stock", s, b: s, name }));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ── Datenquellen ───────────────────────────────────────────────────
async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
async function fetchCryptoSymbols() {
  const cached = store.get("binance_symbols");
  if (cached) { try { const o = JSON.parse(cached); if (Date.now() - o.ts < 864e5 && o.list?.length) return o.list; } catch {} }
  const d = await j("https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT");
  const list = d.symbols.filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
    .map((s) => ({ market: "crypto", s: s.symbol, b: s.baseAsset })).sort((a, b) => a.b.localeCompare(b.b));
  store.set("binance_symbols", JSON.stringify({ ts: Date.now(), list }));
  return list;
}
async function fetchCryptoCandles(symbol, tf) {
  const d = await j(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${LOAD}`);
  return d.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}
const PROXIES = [
  "https://api.codetabs.com/v1/proxy/?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?url=",
];
const YF_IV = { "15m": "15m", "1h": "1h", "4h": "1h", "1d": "1d", "1w": "1wk" };
const YF_RANGE = { "15m": "1mo", "1h": "1y", "4h": "1y", "1d": "3y", "1w": "10y" };
function resample(candles, n) {
  const out = [];
  for (let i = 0; i < candles.length; i += n) {
    const g = candles.slice(i, i + n); if (!g.length) break;
    out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((c) => c.h)), l: Math.min(...g.map((c) => c.l)), c: g[g.length - 1].c, v: g.reduce((su, c) => su + (c.v || 0), 0) });
  }
  return out;
}
async function fetchStockCandles(symbol, tf, proxyOverride) {
  const yurl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${YF_IV[tf]}&range=${YF_RANGE[tf]}`;
  const chain = [proxyOverride, ...PROXIES].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  // Alle Proxys parallel anstoßen, den ersten validen nehmen — kein sequentielles Warten.
  const attempts = chain.map((px) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4500);
    return fetch(px + encodeURIComponent(yurl), { signal: ctrl.signal })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((got) => { clearTimeout(to); if (!got || !got.chart || !got.chart.result) throw new Error("ungültig"); return got; })
      .catch((e) => { clearTimeout(to); throw e; });
  });
  let d;
  try { d = await Promise.any(attempts); }
  catch (e) { throw new Error("Yahoo gerade nicht erreichbar — Proxys fehlgeschlagen (⚙︎ eigenen Proxy setzen)"); }
  const res = d.chart.result[0];
  if (!res || d.chart.error) throw new Error((d.chart.error && d.chart.error.description) || "Symbol bei Yahoo nicht gefunden");
  const ts = res.timestamp || [], q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  let candles = ts.map((t, i) => ({ t: t * 1000, o: q.open && q.open[i], h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i], v: (q.volume && q.volume[i]) || 0 }))
    .filter((c) => c.o != null && c.h != null && c.l != null && c.c != null);
  if (tf === "4h") candles = resample(candles, 4);
  return candles.slice(-LOAD);
}

const TF_MS = { "15m": 9e5, "1h": 36e5, "4h": 1.44e7, "1d": 8.64e7, "1w": 6.048e8 };
function genSynthetic(symbol, tf) {
  let seed = 0; for (const ch of symbol + tf) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const ms = TF_MS[tf] || 36e5, now = Date.now();
  let price = 15 + (seed % 60000) / 100, vol = 800 + rnd() * 6000, trend = (rnd() - 0.5) * 0.004;
  const out = [];
  for (let i = LOAD - 1; i >= 0; i--) {
    const t = now - i * ms;
    if (rnd() < 0.04) trend = (rnd() - 0.5) * 0.006;            // gelegentlicher Regimewechsel
    const o = price, c = Math.max(0.01, o * (1 + trend + (rnd() - 0.5) * 0.022));
    const h = Math.max(o, c) * (1 + rnd() * 0.012), l = Math.min(o, c) * (1 - rnd() * 0.012);
    out.push({ t, o, h, l, c, v: vol * (0.4 + rnd() * 1.6) });
    price = c;
  }
  return out;
}
const _cache = new Map();
function cacheGet(k, ttl) { const e = _cache.get(k); return e && Date.now() - e.ts < ttl ? e.data : null; }
function cacheSet(k, d) { _cache.set(k, { ts: Date.now(), data: d }); }
function fetchCandles(market, symbol, tf, cfg) {
  return market === "stock" ? fetchStockCandles(symbol, tf, cfg.yahooProxy) : fetchCryptoCandles(symbol, tf);
}

function sma(vals, p) { const out = new Array(vals.length).fill(null); let s = 0; for (let i = 0; i < vals.length; i++) { s += vals[i]; if (i >= p) s -= vals[i - p]; if (i >= p - 1) out[i] = s / p; } return out; }
function fmtPrice(p) { if (p == null || isNaN(p)) return "—"; const d = p >= 1000 ? 2 : p >= 1 ? 2 : p >= 0.01 ? 4 : 6; return p.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtPct(v) { return (v >= 0 ? "+" : "") + v.toLocaleString("de-DE", { maximumFractionDigits: 2 }) + "%"; }
function fmtVol(v) { if (!v) return "—"; if (v >= 1e9) return (v / 1e9).toFixed(2) + "B"; if (v >= 1e6) return (v / 1e6).toFixed(2) + "M"; if (v >= 1e3) return (v / 1e3).toFixed(1) + "K"; return v.toFixed(0); }
function fmtTime(ms, tf) { const d = new Date(ms); if (tf === "1d" || tf === "1w") return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }); return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }

// ── Chart ──────────────────────────────────────────────────────────
function clampCenter(center, g) { const ac = (g.autoLo + g.autoHi) / 2, as = (g.autoHi - g.autoLo) || 1; return Math.max(ac - 2 * as, Math.min(ac + 2 * as, center)); }
function niceStep(range, ticks) { const raw = (range || 1) / Math.max(1, ticks); const mag = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / mag; const sc = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10; return sc * mag; }

function Chart({ all, view, setView, tf, symbol, mas, height, hoverBus, index }) {
  const wrapRef = useRef(null), svgRef = useRef(null), drag = useRef(null), geo = useRef(null);
  const idxRef = useRef(index); idxRef.current = index;
  const tfRef = useRef(tf); tfRef.current = tf;
  const syncG = useRef(null), syncV = useRef(null), syncH = useRef(null), syncPB = useRef(null), syncPT = useRef(null), syncTB = useRef(null), syncTT = useRef(null);
  const viewRef = useRef(view);
  const clipId = useRef("clip" + Math.random().toString(36).slice(2)).current;
  const [w, setW] = useState(720);
  const [hoverGi, setHoverGi] = useState(null);
  const [cursor, setCursor] = useState("crosshair");
  viewRef.current = view;

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((es) => { for (const e of es) setW(Math.max(280, e.contentRect.width)); });
    ro.observe(wrapRef.current); return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!hoverBus) return;
    const fn = (t, src) => {
      const g = geo.current, G = syncG.current; if (!G) return;
      if (t == null || src === idxRef.current || !g || !g.syncAt) { G.style.display = "none"; return; }
      const r = g.syncAt(t); if (!r) { G.style.display = "none"; return; }
      G.style.display = "";
      syncV.current.setAttribute("x1", r.sx); syncV.current.setAttribute("x2", r.sx); syncV.current.setAttribute("y1", g.top); syncV.current.setAttribute("y2", g.bot);
      const sW = (g.tf === "1d" || g.tf === "1w") ? 62 : 96, sX = Math.max(g.padL, Math.min(g.wR - sW, r.sx - sW / 2));
      syncTB.current.setAttribute("x", sX); syncTB.current.setAttribute("width", sW); syncTB.current.setAttribute("y", g.bot + 3); syncTT.current.setAttribute("x", sX + sW / 2); syncTT.current.setAttribute("y", g.bot + 14); syncTT.current.textContent = r.label;
      if (r.inData) {
        syncH.current.style.display = ""; syncPB.current.style.display = ""; syncPT.current.style.display = "";
        syncH.current.setAttribute("x1", g.padL); syncH.current.setAttribute("x2", g.wR); syncH.current.setAttribute("y1", r.py); syncH.current.setAttribute("y2", r.py);
        syncPB.current.setAttribute("y", r.py - 8); syncPT.current.setAttribute("y", r.py + 3.5); syncPT.current.textContent = r.price;
      } else { syncH.current.style.display = "none"; syncPB.current.style.display = "none"; syncPT.current.style.display = "none"; }
    };
    return hoverBus.subscribe(fn);
  }, [hoverBus]);

  const H = height, padT = 12, padB = 22, padR = 60, padL = 6, volH = height > 360 ? 60 : 42, gap = 8;
  const len = all.length;
  const plotW = w - padL - padR, priceH = H - padT - padB - volH - gap;
  const rightGap = Math.min(70, plotW * 0.08), usableW = Math.max(10, plotW - rightGap);
  const cntF = Math.max(20, view.count), offset = view.offset;
  const step = usableW / cntF;
  const eIdx = (len - 1) - offset;              // fraktionaler globaler Index am rechten Slot
  const leftIdx = eIdx - (cntF - 1);
  const xOf = (gi) => padL + (gi - leftIdx + 0.5) * step;
  const giAtX = (x) => leftIdx + (x - padL) / step - 0.5;
  const barMs = len >= 2 ? Math.max(1, all[len - 1].t - all[len - 2].t) : 6e4;
  const timeAtGi = (gi) => { if (!len) return null; if (gi <= 0) return all[0].t + gi * barMs; if (gi >= len - 1) return all[len - 1].t + (gi - (len - 1)) * barMs; const i = Math.floor(gi), f = gi - i; return all[i].t + (all[i + 1].t - all[i].t) * f; };
  const giAtTime = (t) => { if (t == null || !len) return null; if (t <= all[0].t) return (t - all[0].t) / barMs; if (t >= all[len - 1].t) return (len - 1) + (t - all[len - 1].t) / barMs; let lo2 = 0, hi2 = len - 1; while (hi2 - lo2 > 1) { const m = (lo2 + hi2) >> 1; if (all[m].t <= t) lo2 = m; else hi2 = m; } const sp = (all[hi2].t - all[lo2].t) || 1; return lo2 + (t - all[lo2].t) / sp; };
  const vFrom = Math.max(0, Math.floor(leftIdx) - 1), vTo = Math.min(len - 1, Math.ceil(eIdx) + 1);
  const aFrom = Math.max(0, Math.round(leftIdx)), aTo = Math.min(len - 1, Math.round(eIdx));

  // Auto-Fit der Preisachse ueber die on-screen Kerzen
  let aLo = Infinity, aHi = -Infinity;
  for (let gi = aFrom; gi <= aTo; gi++) { const c = all[gi]; if (!c) continue; if (c.l < aLo) aLo = c.l; if (c.h > aHi) aHi = c.h; }
  [mas.ma20, mas.ma50].forEach((arr) => { if (!arr) return; for (let gi = aFrom; gi <= aTo; gi++) { const v = arr[gi]; if (v != null) { if (v < aLo) aLo = v; if (v > aHi) aHi = v; } } });
  if (!isFinite(aLo) || !isFinite(aHi)) { const lc = all[len - 1]; aLo = lc ? lc.l : 0; aHi = lc ? lc.h : 1; }
  const MARG = 0.12; const padp = (aHi - aLo || 1) * (MARG / (1 - 2 * MARG)); aLo -= padp; aHi += padp;   // Hoch/Tief je 12% vom Rand
  let lo, hi;
  if (view.pSpan != null && view.pCenter != null) { lo = view.pCenter - view.pSpan / 2; hi = view.pCenter + view.pSpan / 2; }
  else { lo = aLo; hi = aHi; }
  const y = (p) => padT + ((hi - p) / (hi - lo)) * priceH;
  const bw = Math.max(1, Math.min(11, step * 0.66));
  let volMax = 1; for (let gi = aFrom; gi <= aTo; gi++) { const c = all[gi]; if (c && c.v > volMax) volMax = c.v; }
  const volTop = padT + priceH + gap, vy = (vv) => volTop + volH - (vv / volMax) * volH;
  const maxOff = Math.max(0, len - cntF), minOff = -cntF * 0.55;   // negativ = juengste Kerze nach links (Leerraum rechts)
  const syncAt = (t) => {
    if (t == null || !len) return null;
    const gi = giAtTime(t), sx = xOf(gi);
    if (sx < padL || sx > w - padR) return null;
    const inData = t >= all[0].t && t <= all[len - 1].t, ni = Math.max(0, Math.min(len - 1, Math.round(gi)));
    return { sx, inData, py: y(all[ni].c), price: fmtPrice(all[ni].c), label: fmtTime(t, tf) };
  };
  geo.current = { step, usableW, priceH, lo, hi, autoLo: aLo, autoHi: aHi, maxOff, minOff, syncAt, top: padT, bot: H - padB, wR: w - padR, padL, tf };

  const vbPoint = (cx, cy) => { const svg = svgRef.current; if (!svg) return null; const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy; const m = svg.getScreenCTM(); if (!m) return null; return pt.matrixTransform(m.inverse()); };
  const vbX = (cx) => { const p = vbPoint(cx, 0); return p ? p.x : null; };

  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const g = geo.current; if (!g) return;
      if (e.ctrlKey) {
        // Pinch -> Zoom (cursor-verankert)
        const pt = vbPoint(e.clientX, e.clientY);
        const fracX = pt ? Math.max(0, Math.min(1, (pt.x - padL) / g.usableW)) : 1;
        const cursorPrice = pt ? g.hi - ((pt.y - padT) / g.priceH) * (g.hi - g.lo) : (g.lo + g.hi) / 2;
        const zf = Math.exp(e.deltaY * 0.01);
        const v = viewRef.current;
        const count = Math.min(LOAD, Math.max(20, v.count * zf)), minOff = -count * 0.55;
        const idxUnder = (len - v.offset - v.count) + fracX * v.count;
        const offset = Math.max(minOff, Math.min(Math.max(0, len - count), len - (idxUnder - fracX * count) - count));
        const curSpan = v.pSpan != null ? v.pSpan : (g.hi - g.lo);
        const curCenter = v.pCenter != null ? v.pCenter : (g.lo + g.hi) / 2;
        const curLo = curCenter - curSpan / 2, curHi = curCenter + curSpan / 2;
        const newSpan = Math.max((g.autoHi - g.autoLo) * 0.02, curSpan * zf);
        const fy = (curHi - cursorPrice) / ((curHi - curLo) || 1);
        setView((pv) => ({ ...pv, count, offset, pSpan: newSpan, pCenter: (cursorPrice + fy * newSpan) - newSpan / 2 }));
      } else {
        // Zwei-Finger-Scroll -> 2D-Pan, hart an den Raendern geklemmt (kein Banding)
        // Wischen: deltaX = links/rechts schieben, deltaY = zoom (hoch = rein, runter = raus); Mischformen moeglich
        const zf = Math.exp(e.deltaY * 0.0014);
        setView((v) => {
          const count = Math.min(LOAD, Math.max(20, v.count * zf));
          const minOff = -count * 0.55, maxOff = Math.max(0, len - count);
          const offset = Math.max(minOff, Math.min(maxOff, v.offset - e.deltaX / g.step));
          return { ...v, offset, count };
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [len, padL]);

  const onDown = (e) => {
    const g = geo.current, pt = vbPoint(e.clientX, e.clientY); if (!pt) return;
    const v = viewRef.current;
    const center = v.pCenter != null ? v.pCenter : (g ? (g.lo + g.hi) / 2 : 0);
    const span = v.pSpan != null ? v.pSpan : (g ? g.hi - g.lo : 1);
    if (pt.x >= w - padR) drag.current = { mode: "scaleY", y: pt.y, center, span };
    else if (pt.y >= H - padB) drag.current = { mode: "scaleX", x: pt.x, count: v.count, offset: v.offset };
    else drag.current = { mode: "pan", x: pt.x, y: pt.y, offset: v.offset, center, span, auto: v.pSpan == null };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setHoverGi(null); if (hoverBus) hoverBus.publish(null, index);
  };
  const onMove = (e) => {
    const g = geo.current; if (!g) return;
    const pt = vbPoint(e.clientX, e.clientY); if (!pt) return;
    const d = drag.current;
    if (d) {
      if (d.mode === "scaleY") {
        const span = Math.max((g.autoHi - g.autoLo) * 0.02, d.span * Math.exp((pt.y - d.y) * 0.004));
        setView((v) => ({ ...v, pCenter: d.center, pSpan: span }));
      } else if (d.mode === "scaleX") {
        const count = Math.min(LOAD, Math.max(20, d.count * Math.exp((pt.x - d.x) * 0.004)));
        setView((v) => ({ ...v, count, offset: d.offset }));
      } else {
        const offset = Math.max(g.minOff, Math.min(g.maxOff, d.offset + (pt.x - d.x) / g.step));
        if (d.auto) { setView((v) => ({ ...v, offset })); }                  // Auto-Fit bleibt aktiv -> nur Zeit
        else {
          const center = clampCenter(d.center + (pt.y - d.y) * (d.span / g.priceH), g);
          setView((v) => ({ ...v, offset, pCenter: center, pSpan: d.span }));
        }
      }
      return;
    }
    setHoverGi(Math.max(0, Math.min(len - 1, Math.round(giAtX(pt.x)))));
    setCursor(pt.x >= w - padR ? "ns-resize" : pt.y >= H - padB ? "ew-resize" : "crosshair");
    if (hoverBus) hoverBus.publish(timeAtGi(giAtX(pt.x)), index);
  };
  const onUp = (e) => { drag.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId); };
    const onDouble = () => setView((v) => ({ ...v, pCenter: null, pSpan: null }));

  if (len < 2) return <div style={{ height: H, display: "grid", placeItems: "center", color: C.faint, fontFamily: MONO, fontSize: 12 }}>lade Kerzen …</div>;
  const idxs = []; for (let gi = vFrom; gi <= vTo; gi++) idxs.push(gi);
  const pStep = niceStep(hi - lo, 5);
  const pTicks = [];
  for (let pv = Math.ceil(lo / pStep) * pStep; pv <= hi && pTicks.length < 40; pv += pStep) pTicks.push(pv);
  const tzMs = -new Date().getTimezoneOffset() * 60000;
  const TSTEPS = [6e4, 3e5, 9e5, 1.8e6, 3.6e6, 7.2e6, 1.44e7, 2.16e7, 4.32e7, 8.64e7, 1.728e8, 3.456e8, 6.048e8, 2.628e9, 7.884e9, 3.154e10];
  const tAt = (gi) => gi < len ? all[gi].t : all[len - 1].t + (gi - (len - 1)) * barMs;   // jenseits der letzten Kerze: extrapoliert
  const giL = Math.max(0, Math.floor(leftIdx)), giR = Math.ceil(eIdx);
  const tSpan = Math.max(1, tAt(giR) - tAt(giL));
  let tStep = TSTEPS[TSTEPS.length - 1];
  for (const st of TSTEPS) { if (tSpan / st <= 8) { tStep = st; break; } }
  const tTicks = []; let lastB = null, lastDay = null;
  for (let gi = giL; gi <= giR; gi++) {
    const x = xOf(gi); if (x < padL || x > w - padR) continue;
    const t = tAt(gi), b = Math.floor((t + tzMs) / tStep);
    if (b === lastB) continue; lastB = b;
    const dt = new Date(t); let label;
    if (tStep >= 2.628e9) label = dt.toLocaleDateString("de-DE", { month: "2-digit", year: "2-digit" });
    else if (tStep >= 8.64e7) label = dt.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
    else { const dk = dt.toLocaleDateString("de-DE"); if (dk !== lastDay) { label = dt.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }); lastDay = dk; } else label = dt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
    tTicks.push({ x, label, fut: gi > len - 1 });
  }
  const last = all[len - 1];
  const hg = hoverGi != null && hoverGi >= 0 && hoverGi < len ? hoverGi : len - 1;
  const hc = all[hg];
  const showHover = hoverGi != null && !drag.current && hg >= aFrom - 1 && hg <= aTo + 1;
  const maLine = (arr, color) => { if (!arr) return null; let d = ""; for (const gi of idxs) { const v = arr[gi]; if (v == null) continue; d += (d ? " L" : "M") + xOf(gi).toFixed(1) + "," + y(v).toFixed(1); } return d ? <path d={d} fill="none" stroke={color} strokeWidth={1.2} opacity={0.9} /> : null; };
  const chg = (hc.c / hc.o - 1) * 100;
  const tlW = (tf === "1d" || tf === "1w") ? 62 : 96;
  const tlX = Math.max(padL, Math.min(w - padR - tlW, xOf(hg) - tlW / 2));

  const body = useMemo(() => (<>
    {idxs.map((gi) => { const c = all[gi], up = c.c >= c.o; return <rect key={"v" + gi} x={xOf(gi) - bw / 2} y={vy(c.v)} width={bw} height={Math.max(0.5, volTop + volH - vy(c.v))} fill={up ? C.up : C.down} opacity={0.3} />; })}
    {maLine(mas.ma20, C.ma20)}{maLine(mas.ma50, C.ma50)}
    {idxs.map((gi) => { const c = all[gi], up = c.c >= c.o, col = up ? C.up : C.down, bx = xOf(gi), top = Math.min(y(c.o), y(c.c)), h = Math.max(1, Math.abs(y(c.c) - y(c.o))); return (<g key={gi}><line x1={bx} x2={bx} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} /><rect x={bx - bw / 2} y={top} width={bw} height={h} fill={col} /></g>); })}
  </>), [all, view, mas, w, H]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", touchAction: "none", overscrollBehavior: "contain" }}>
      <div style={{ position: "absolute", top: 7, left: 9, zIndex: 2, fontFamily: MONO, fontSize: 11, lineHeight: 1.45, pointerEvents: "none" }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 12 }}>{symbol} · {tf}</div>
        <div style={{ color: C.dim }}>O <span style={{ color: C.text }}>{fmtPrice(hc.o)}</span> H <span style={{ color: C.text }}>{fmtPrice(hc.h)}</span> L <span style={{ color: C.text }}>{fmtPrice(hc.l)}</span> C <span style={{ color: chg >= 0 ? C.up : C.down }}>{fmtPrice(hc.c)} {fmtPct(chg)}</span></div>
        <div style={{ color: C.dim }}>{mas.ma20 && mas.ma20[hg] != null && <span style={{ color: C.ma20 }}>MA20 {fmtPrice(mas.ma20[hg])} </span>}{mas.ma50 && mas.ma50[hg] != null && <span style={{ color: C.ma50 }}>MA50 {fmtPrice(mas.ma50[hg])} </span>}<span style={{ color: C.faint }}>Vol {fmtVol(hc.v)}</span></div>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${w} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block", cursor: drag.current ? (drag.current.mode === "scaleY" ? "ns-resize" : drag.current.mode === "scaleX" ? "ew-resize" : "grabbing") : cursor }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={(e) => { onUp(e); setHoverGi(null); if (hoverBus) hoverBus.publish(null, index); }} onDoubleClick={onDouble}>
        <defs><clipPath id={clipId}><rect x={padL} y={0} width={usableW} height={H} /></clipPath></defs>
        {pTicks.map((pv, i) => (<g key={"p" + i}><line x1={padL} x2={w - padR} y1={y(pv)} y2={y(pv)} stroke={C.line} strokeWidth={1} opacity={0.7} /><text x={w - padR + 5} y={y(pv) + 3.5} fill={C.faint} fontSize={10} fontFamily={MONO}>{fmtPrice(pv)}</text></g>))}
        <g clipPath={`url(#${clipId})`}>
          {tTicks.map((tk, i) => <line key={"tg" + i} x1={tk.x} x2={tk.x} y1={padT} y2={H - padB} stroke={C.line} strokeWidth={1} opacity={0.45} strokeDasharray={tk.fut ? "2 3" : undefined} />)}
          {tTicks.map((tk, i) => <text key={"tl" + i} x={tk.x} y={H - 6} fill={C.faint} fontSize={9.5} fontFamily={MONO} textAnchor="middle" opacity={tk.fut ? 0.55 : 1}>{tk.label}</text>)}
          {body}
        </g>
        <line x1={padL} x2={w - padR} y1={y(last.c)} y2={y(last.c)} stroke={C.accent} strokeDasharray="3 3" strokeWidth={1} opacity={0.7} />
        <rect x={w - padR} y={y(last.c) - 8} width={padR} height={16} fill={C.accent} rx={2} /><text x={w - padR + 4} y={y(last.c) + 3.5} fill="#fff" fontSize={10} fontFamily={MONO} fontWeight={700}>{fmtPrice(last.c)}</text>
        {showHover && (<g pointerEvents="none">
          <line x1={xOf(hg)} x2={xOf(hg)} y1={padT} y2={H - padB} stroke={C.dim} strokeDasharray="2 3" strokeWidth={1} opacity={0.6} />
          <line x1={padL} x2={w - padR} y1={y(hc.c)} y2={y(hc.c)} stroke={C.dim} strokeDasharray="2 3" strokeWidth={1} opacity={0.6} />
          <rect x={w - padR} y={y(hc.c) - 8} width={padR} height={16} fill={C.panel2} stroke={C.line} rx={2} /><text x={w - padR + 4} y={y(hc.c) + 3.5} fill={C.text} fontSize={10} fontFamily={MONO}>{fmtPrice(hc.c)}</text>
          <rect x={tlX} y={H - 19} width={tlW} height={16} fill={C.panel2} stroke={C.line} rx={3} /><text x={tlX + tlW / 2} y={H - 8} fill={C.text} fontSize={9.5} fontFamily={MONO} textAnchor="middle">{fmtTime(hc.t, tf)}</text>
        </g>)}
        <g ref={syncG} pointerEvents="none" style={{ display: "none" }}>
          <line ref={syncV} stroke={C.accent} strokeDasharray="2 3" strokeWidth={1} opacity={0.55} />
          <line ref={syncH} stroke={C.accent} strokeDasharray="1 4" strokeWidth={1} opacity={0.32} style={{ display: "none" }} />
          <rect ref={syncPB} x={w - padR} width={padR} height={16} fill={C.panel2} stroke={C.accent} rx={2} style={{ display: "none" }} />
          <text ref={syncPT} x={w - padR + 4} fill={C.accent} fontSize={10} fontFamily={MONO} style={{ display: "none" }} />
          <rect ref={syncTB} height={16} fill={C.panel2} stroke={C.accent} rx={3} />
          <text ref={syncTT} fill={C.accent} fontSize={9.5} fontFamily={MONO} textAnchor="middle" />
        </g>
      </svg>
    </div>
  );
}

// ── Chart → PNG (Vision) ───────────────────────────────────────────
async function svgToPng(svg, scale = 2) {
  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
  const clone = svg.cloneNode(true); clone.setAttribute("width", w); clone.setAttribute("height", h);
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("fill", C.bg);
  clone.insertBefore(bg, clone.firstChild);
  const xml = new XMLSerializer().serializeToString(clone);
  const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("SVG-Rasterung fehlgeschlagen")); img.src = url; });
  const cv = document.createElement("canvas"); cv.width = w * scale; cv.height = h * scale;
  const ctx = cv.getContext("2d"); ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/png").split(",")[1];
}

const SYSTEM = `Du bist ein systematischer, datengetriebener Chart-Analyst. Du bekommst das BILD eines Candlestick-Charts und liest es rein VISUELL: Trendstruktur (höhere Hochs/Tiefs intakt oder gebrochen?), Lage des Kurses zu den gleitenden Durchschnitten, die Volumenbalken unten, sichtbare Support-/Resistance-Zonen, Kerzenmuster und Momentum. Lies Preisniveaus näherungsweise von der Achse rechts ab.

Gib AUSSCHLIESSLICH gültiges JSON nach diesem Schema zurück — kein Fließtext, keine Markdown-Fences:
{
 "regime": "ein Satz zur Lage, die das Bild zeigt",
 "langfristig": "Struktur über den ganzen sichtbaren Verlauf: höhere Hochs/Tiefs? Lage zur MA50",
 "mittelfristig": "jüngste Kerzen: Momentum-Richtung, Lage zu MA20/MA50",
 "volumen": "was die Volumenbalken zeigen (Bestätigung, Divergenz, Spitzen)",
 "signal": "long | flat | short",
 "signal_begruendung": "warum, anhand des Bildes, inkl. ob ein Trend-/Regime-Filter dieses Signal feuern ließe",
 "levels": "sichtbare Linie im Sand (ungefähres Niveau) plus was ein Bruch öffnet",
 "treiber": "welcher Flow-/Fundamental-Kontext wäre als nächstes zu prüfen — offene Fragen, erfinde KEINE Zahlen/News",
 "caveat": "die Falle bei genau diesem Setup, plus ausdrücklich: keine Anlageempfehlung"
}
Antworte auf Deutsch. Trenne Lang- von Mittelfrist sauber; sie dürfen sich widersprechen.`;

async function analyzeChart(svg, ctxText, cfg) {
  const data = await svgToPng(svg, 2);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: cfg.model || DEFAULT_MODEL, max_tokens: 1300, system: SYSTEM, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }, { type: "text", text: ctxText }] }] }),
  });
  if (!r.ok) { let m = "HTTP " + r.status; try { const e = await r.json(); if (e.error?.message) m = e.error.message; } catch {} throw new Error(m); }
  const d = await r.json();
  let t = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

function Card({ title, accent, children }) { return (<div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px" }}><div style={{ fontSize: 11.5, color: accent || C.dim, fontFamily: SANS, fontWeight: 600, marginBottom: 5 }}>{title}</div><div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5 }}>{children}</div></div>); }
function Analysis({ a }) {
  const sig = (a.signal || "flat").toLowerCase(), col = sig === "long" ? C.up : sig === "short" ? C.down : C.dim;
  return (<div style={{ display: "grid", gap: 8, marginTop: 12 }}>
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderLeft: `3px solid ${C.accent}`, borderRadius: 10, padding: "11px 14px" }}><div style={{ fontSize: 11.5, color: C.accent, fontFamily: SANS, fontWeight: 600, marginBottom: 4 }}>Regime</div><div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{a.regime}</div></div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 }}><Card title="Langfristig">{a.langfristig}</Card><Card title="Mittelfristig">{a.mittelfristig}</Card></div>
    <div style={{ display: "flex", gap: 10, alignItems: "center", background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 13px" }}><span style={{ background: col, color: "#fff", fontFamily: MONO, fontWeight: 700, fontSize: 11.5, padding: "4px 11px", borderRadius: 6, textTransform: "uppercase" }}>{sig}</span><span style={{ fontSize: 12.5, lineHeight: 1.5 }}>{a.signal_begruendung}</span></div>
    <Card title="Volumen">{a.volumen}</Card><Card title="Levels">{a.levels}</Card><Card title="Zu prüfen — Treiber">{a.treiber}</Card>
    <div style={{ background: "rgba(194,151,75,0.08)", border: `1px solid rgba(194,151,75,0.28)`, borderRadius: 12, padding: "12px 14px" }}><div style={{ fontSize: 11.5, color: C.warn, fontFamily: SANS, fontWeight: 600, marginBottom: 5 }}>Caveat</div><div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>{a.caveat}</div></div>
  </div>);
}

// ── Einzel-Chart-Kachel ────────────────────────────────────────────
function ChartPane({ cfg, cryptoSymbols, compact, initial, index, register, hoverBus, demo }) {
  const [symbol, setSymbol] = useState(initial.symbol);
  const [market, setMarket] = useState(initial.market);
  const [tf, setTf] = useState(initial.tf);
  const [all, setAll] = useState([]);
  const [err, setErr] = useState(null);
  const [view, setView] = useState({ count: 130, offset: 0, pCenter: null, pSpan: null });
  const [showMA, setShowMA] = useState({ ma20: true, ma50: true });
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false);
  const [analysis, setAnalysis] = useState(null); const [busy, setBusy] = useState(false); const [aErr, setAErr] = useState(null);
  const boxRef = useRef(null);
  const tfRef = useRef(tf); tfRef.current = tf;
  const vRef = useRef(view); vRef.current = view;
  const pendingSync = useRef(null);

  useEffect(() => {
    let alive = true; setErr(null);
    if (demo) { setAll(genSynthetic(symbol, tf)); return () => { alive = false; }; }
    const key = market + ":" + symbol + ":" + tf, ttl = market === "stock" ? 120000 : 30000;
    const run = async (force) => {
      if (!force) { const c0 = cacheGet(key, ttl); if (c0) { setAll(c0); return; } }
      try { const c = await fetchCandles(market, symbol, tf, cfg); cacheSet(key, c); if (alive) setAll(c); }
      catch (e) { if (alive) { const cached = cacheGet(key, 1e12); if (cached) { setAll(cached); } else { setAll([]); setErr((e.message || "Fehler") + (market === "crypto" ? " · ggf. Sandbox/Hosting prüfen" : "")); } } }
    };
    run(false); const id = setInterval(() => run(true), ttl);
    return () => { alive = false; clearInterval(id); };
  }, [symbol, market, tf, cfg, demo]);
  useEffect(() => {
    setView((v) => { const p = pendingSync.current; pendingSync.current = null; return p ? { ...v, count: p.count, offset: p.offset, pCenter: null, pSpan: null } : { ...v, offset: 0, pCenter: null, pSpan: null }; });
    setAnalysis(null);
  }, [symbol, market, tf]);
  useEffect(() => {
    if (!register) return;
    register(index, {
      get: () => ({ tf: tfRef.current, count: vRef.current.count, offset: vRef.current.offset }),
      apply: (s) => {
        pendingSync.current = { count: s.count, offset: s.offset };
        if (s.tf !== tfRef.current) setTf(s.tf);
        else { const p = pendingSync.current; pendingSync.current = null; setView((v) => ({ ...v, count: p.count, offset: p.offset, pCenter: null, pSpan: null })); }
      },
    });
    return () => register(index, null);
  }, [index, register]);

  const mas = useMemo(() => { if (!all.length) return {}; const cl = all.map((c) => c.c); return { ma20: showMA.ma20 ? sma(cl, 20) : null, ma50: showMA.ma50 ? sma(cl, 50) : null }; }, [all, showMA]);
  const last = all[all.length - 1];
  const dayBase = (() => {
    if (!last) return null;
    const d = new Date(), midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    let base = last.o;                                  // Fallback: Open der aktuellen Kerze
    for (let i = all.length - 1; i >= 0; i--) { if (all[i].t >= midnight) base = all[i].o; else break; }   // Open der ersten Kerze ab 00:00
    return base;
  })();
  const ch = last && dayBase ? (last.c / dayBase - 1) * 100 : 0;
  const results = useMemo(() => {
    const u = q.toUpperCase().replace(/\s/g, "");
    const cr = (q.trim() ? cryptoSymbols.filter((s) => s.b.startsWith(u) || s.s.includes(u)) : cryptoSymbols).slice(0, 24);
    const st = (q.trim() ? STOCKS.filter((s) => s.s.includes(u) || s.name.toUpperCase().includes(q.toUpperCase())) : STOCKS).slice(0, 16);
    return [...st, ...cr];
  }, [q, cryptoSymbols]);
  const canA = !!cfg.anthropicKey && all.length > 50 && !err;

  const analyze = useCallback(async () => {
    const svg = boxRef.current?.querySelector("svg"); if (!svg) return;
    setBusy(true); setAErr(null); setAnalysis(null);
    try {
      const ctx = `Chart: ${symbol} (${market === "stock" ? "Aktie" : "Krypto"}), Zeitebene ${tf}. ${last ? "Letzter Kurs ungefähr " + fmtPrice(last.c) + "." : ""} MA20 = goldene Linie, MA50 = violette Linie, Balken unten = Volumen, blau gestrichelt = letzter Kurs. Analysiere genau dieses Chartbild nach dem Schema.`;
      setAnalysis(await analyzeChart(svg, ctx, cfg));
    } catch (e) { setAErr("Analyse fehlgeschlagen: " + (e.message || e) + (cfg.anthropicKey ? "" : " — API-Key unter ⚙︎.")); }
    finally { setBusy(false); }
  }, [symbol, market, tf, last, cfg]);

  const chartH = compact ? 290 : 430;

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 10 }}>
      {/* Pane-Kopf */}
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginBottom: 7 }}>
        <div style={{ position: "relative", flex: "1 1 150px", minWidth: 130 }}>
          <input className="cs-inp" style={{ padding: "6px 9px", fontSize: 12 }} placeholder="Suchen: SOL, AAPL, SPY …" value={open ? q : ""} onFocus={() => { setOpen(true); setQ(""); }} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
          {open && (<div style={{ position: "absolute", top: 36, left: 0, right: 0, zIndex: 6, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 9, maxHeight: 300, overflowY: "auto", boxShadow: "0 10px 28px rgba(40,52,74,0.14)" }}>
            {results.length ? results.map((s) => (<div key={s.market + s.s} className="cs-opt" onMouseDown={() => { setSymbol(s.s); setMarket(s.market); setOpen(false); }}>
              <span style={{ color: C.text }}>{s.market === "stock" ? s.s : <>{s.b}<span style={{ color: C.faint }}>/USDT</span></>}{s.name ? <span style={{ color: C.faint }}> · {s.name}</span> : null}</span>
              <span style={{ fontSize: 9, color: s.market === "stock" ? C.ma50 : C.accent, border: `1px solid ${C.line}`, borderRadius: 4, padding: "1px 5px" }}>{s.market === "stock" ? "AKTIE" : "KRYPTO"}</span>
            </div>)) : <div style={{ padding: 11, color: C.faint, fontFamily: MONO, fontSize: 12 }}>kein Treffer</div>}
          </div>)}
        </div>
        <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 14 }}>{symbol}</span>
        {last && <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{fmtPrice(last.c)}</span>}
        {last && <span title="seit 00:00 Uhr (Tagesanfang)" style={{ fontFamily: MONO, fontSize: 11.5, color: ch >= 0 ? C.up : C.down }}>{fmtPct(ch)}</span>}
      </div>
      {/* Pane-Toolbar */}
      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        {TFS.map((t) => <button key={t.id} className="cs-tf" data-on={t.id === tf ? 1 : 0} onClick={() => setTf(t.id)}>{t.l}</button>)}
        <button className="cs-ma" style={{ color: showMA.ma20 ? C.ma20 : C.faint }} onClick={() => setShowMA((m) => ({ ...m, ma20: !m.ma20 }))}>MA20</button>
        <button className="cs-ma" style={{ color: showMA.ma50 ? C.ma50 : C.faint }} onClick={() => setShowMA((m) => ({ ...m, ma50: !m.ma50 }))}>MA50</button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
          <button className="cs-ico" title="rauszoomen" onClick={() => setView((v) => ({ ...v, count: Math.min(LOAD, Math.round(v.count * 1.25)) }))}>−</button>
          <button className="cs-ico" title="reinzoomen" onClick={() => setView((v) => ({ ...v, count: Math.max(20, Math.round(v.count / 1.25)) }))}>+</button>
          <button className="cs-ico" title="zurück & einpassen" onClick={() => setView((v) => ({ ...v, offset: 0, pCenter: null, pSpan: null }))}>⟩</button>
        </div>
      </div>
      {/* Chart */}
      <div ref={boxRef} style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 9, padding: "4px 2px" }}>
        {err ? <div style={{ height: chartH, display: "grid", placeItems: "center", textAlign: "center", color: C.warn, fontFamily: MONO, fontSize: 12, padding: 14 }}>{err}</div> : <Chart all={all} view={view} setView={setView} tf={tf} symbol={symbol} mas={mas} height={chartH} hoverBus={hoverBus} index={index} />}
      </div>
      {/* Analyse */}
      <div style={{ display: "flex", gap: 9, alignItems: "center", marginTop: 11, flexWrap: "wrap" }}>
        <button className="cs-btn" disabled={!canA || busy} onClick={analyze}>{busy ? "liest Chart …" : "Mit Claude analysieren"}</button>
        {busy && <span style={{ width: 15, height: 15, border: `2px solid ${C.line}`, borderTopColor: C.accent, borderRadius: "50%", display: "inline-block", animation: "cs-spin .8s linear infinite" }} />}
        {!cfg.anthropicKey && <span style={{ fontSize: 11.5, color: C.faint }}>API-Key unter ⚙︎</span>}
      </div>
      {aErr && <div style={{ marginTop: 9, color: C.warn, fontSize: 12, fontFamily: MONO }}>{aErr}</div>}
      {analysis && <Analysis a={analysis} />}
    </div>
  );
}

const PANE_DEFAULTS = [
  { symbol: "BTCUSDT", market: "crypto", tf: "1h" },
  { symbol: "ETHUSDT", market: "crypto", tf: "1h" },
  { symbol: "SOLUSDT", market: "crypto", tf: "4h" },
  { symbol: "NVDA", market: "stock", tf: "1d" },
];

export default function ChartStudio() {
  const [cryptoSymbols, setCryptoSymbols] = useState([]);
  const [cfg, setCfg] = useState({ anthropicKey: store.get("cs_anthropic") || "", model: store.get("cs_model") || DEFAULT_MODEL, yahooProxy: store.get("cs_yahoo") || "" });
  const [showCfg, setShowCfg] = useState(false);
  const [layout, setLayout] = useState(parseInt(store.get("cs_layout") || "1", 10));
  const [synced, setSynced] = useState(false);
  const [demo, setDemo] = useState(false);
  const hoverSubs = useRef(new Set());
  const hoverBus = useMemo(() => ({
    publish: (t, src) => { hoverSubs.current.forEach((fn) => fn(t, src)); },
    subscribe: (fn) => { hoverSubs.current.add(fn); return () => hoverSubs.current.delete(fn); },
  }), []);
  const paneApis = useRef([]);
  const register = useCallback((i, api) => { paneApis.current[i] = api; }, []);
  const syncTiles = () => {
    const src = paneApis.current[0] && paneApis.current[0].get(); if (!src) return;
    for (let i = 1; i < layout; i++) { const p = paneApis.current[i]; if (p) p.apply(src); }
    setSynced(true); setTimeout(() => setSynced(false), 1300);
  };

  useEffect(() => { fetchCryptoSymbols().then(setCryptoSymbols).catch(() => {}); }, []);
  useEffect(() => { store.set("cs_layout", String(layout)); }, [layout]);
  const saveCfg = () => { store.set("cs_anthropic", cfg.anthropicKey.trim()); store.set("cs_model", (cfg.model || DEFAULT_MODEL).trim()); store.set("cs_yahoo", (cfg.yahooProxy || "").trim()); setCfg((c) => ({ anthropicKey: c.anthropicKey.trim(), model: (c.model || DEFAULT_MODEL).trim(), yahooProxy: (c.yahooProxy || "").trim() })); setShowCfg(false); };

  const css = `
    .cs-tf{background:transparent;color:${C.dim};border:1px solid ${C.line};border-radius:6px;padding:3px 9px;font:600 11px ${MONO};cursor:pointer}
    .cs-tf[data-on="1"]{background:${C.panel2};color:${C.accent};border-color:${C.accent}}
    .cs-ma{background:transparent;border:1px solid ${C.line};border-radius:6px;padding:3px 8px;font:600 10.5px ${MONO};cursor:pointer}
    .cs-ico{background:${C.panel2};color:${C.dim};border:1px solid ${C.line};border-radius:6px;width:28px;height:26px;cursor:pointer;font-size:13px}
    .cs-ico:hover{color:${C.text}}
    .cs-inp{background:${C.panel2};color:${C.text};border:1px solid ${C.line};border-radius:8px;padding:8px 11px;font:13px ${MONO};width:100%;box-sizing:border-box}
    .cs-inp:focus{outline:2px solid ${C.accent};outline-offset:-1px;border-color:${C.accent}}
    .cs-opt{padding:6px 10px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;font-family:${MONO};font-size:12px}
    .cs-opt:hover{background:${C.panel}}
    .cs-btn{background:${C.accent};color:#fff;border:none;border-radius:8px;padding:8px 16px;font:700 12.5px ${SANS};cursor:pointer}
    .cs-btn:disabled{background:${C.line};color:${C.faint};cursor:not-allowed}
    .cs-lay{background:${C.panel2};color:${C.dim};border:1px solid ${C.line};border-radius:7px;padding:5px 12px;font:700 12px ${MONO};cursor:pointer}
    .cs-lay[data-on="1"]{background:${C.accent};color:#fff;border-color:${C.accent}}
    .cs-lay:disabled{opacity:.45;cursor:not-allowed}
    @keyframes cs-spin{to{transform:rotate(360deg)}}
    .cs-grid{display:grid;gap:14px}
    .cs-grid[data-n="1"]{grid-template-columns:1fr}
    .cs-grid[data-n="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
    .cs-grid[data-n="3"]{grid-template-columns:repeat(2,minmax(0,1fr))}
    .cs-grid[data-n="4"]{grid-template-columns:repeat(2,minmax(0,1fr))}
    @media(max-width:760px){.cs-grid{grid-template-columns:1fr !important}}
  `;

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: SANS, padding: 16, borderRadius: 14, maxWidth: layout === 1 ? 920 : 1340, margin: "0 auto" }}>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <span style={{ fontSize: 16, color: C.text, fontFamily: SANS, fontWeight: 700 }}>Chart-Station</span>
        <div style={{ display: "flex", gap: 5, marginLeft: 4 }}>
          {[1, 2, 3, 4].map((n) => <button key={n} className="cs-lay" data-on={layout === n ? 1 : 0} onClick={() => setLayout(n)} title={`${n} Chart${n > 1 ? "s" : ""}`}>{n}</button>)}
        </div>
        <span style={{ fontSize: 11.5, color: C.faint }}>{layout === 1 ? "Einzelchart" : `${layout} Kacheln`}</span>
        <button className="cs-lay" onClick={syncTiles} disabled={layout < 2} title="Zeitebene & Zoomfenster von Kachel 1 auf die anderen Kacheln übertragen">Sync</button>
        {synced && <span style={{ fontSize: 11.5, color: C.up }}>übertragen ✓</span>}
        {layout < 2 && <span style={{ fontSize: 11.5, color: C.faint }}>ab 2 Kacheln</span>}
        <button className="cs-lay" data-on={demo ? 1 : 0} onClick={() => setDemo((d) => !d)} title="Demo-Daten zum Testen/Debuggen (ohne Netzwerk)">Demo</button>
        {demo && <span style={{ fontSize: 11.5, color: C.warn }}>synthetische Kurse</span>}
        <button className="cs-ico" style={{ marginLeft: "auto" }} title="Keys einrichten" onClick={() => setShowCfg((s) => !s)}>⚙︎</button>
      </div>

      {showCfg && (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginBottom: 14, display: "grid", gap: 9, maxWidth: 560 }}>
          <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>Keys bleiben nur im <b style={{ color: C.text }}>localStorage dieses Browsers</b> — nie im Repo/Bundle. Nur auf deinem eigenen Gerät nutzen.</div>
          <input className="cs-inp" type="password" placeholder="Anthropic-Key (sk-ant-…) — für die Analyse" value={cfg.anthropicKey} onChange={(e) => setCfg({ ...cfg, anthropicKey: e.target.value })} />
          <input className="cs-inp" placeholder={`Modell (Standard: ${DEFAULT_MODEL})`} value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} />
          <input className="cs-inp" placeholder="optional: eigener CORS-Proxy für Yahoo (sonst Auto-Kette)" value={cfg.yahooProxy} onChange={(e) => setCfg({ ...cfg, yahooProxy: e.target.value })} />
          <div><button className="cs-btn" onClick={saveCfg}>Speichern</button></div>
        </div>
      )}

      <div className="cs-grid" data-n={layout}>
        {PANE_DEFAULTS.slice(0, layout).map((d, i) => <ChartPane key={i} index={i} register={register} cfg={cfg} cryptoSymbols={cryptoSymbols} compact={layout > 1} initial={d} hoverBus={hoverBus} demo={demo} />)}
      </div>

      <div style={{ marginTop: 14, fontSize: 10.5, color: C.faint, lineHeight: 1.6, fontFamily: MONO }}>Krypto: Binance (keyless). Aktien: Yahoo über CORS-Proxy. Trackpad: zwei Finger schieben = frei bewegen (Zeit + Preis), Pinch = zoomen am Cursor. Doppelklick = Preis einpassen. Keine Anlageempfehlung.</div>
    </div>
  );
}
