import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

/**
 * Chart-Station — Risiko-Journal
 * 1–4 Kachel-Charts (Krypto via Binance keyless, Aktien via Yahoo (CORS-Proxy)).
 * Cursor-verankerter Zoom, exaktes Fadenkreuz (getScreenCTM), Pan.
 * Claude-Vision-Analyse pro Chart, Direct-Browser-Access (kein Server).
 */

const C = {
  bg: "#0B0E14", panel: "#121722", panel2: "#0F141D", line: "#222A39",
  text: "#E6E9EF", dim: "#8A93A6", faint: "#566076",
  accent: "#4DD4C0", up: "#46C77E", down: "#F0616D", warn: "#E3B341",
  ma20: "#E3B341", ma50: "#7AA2F7",
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
const DEFAULT_PROXY = "https://api.allorigins.win/raw?url=";
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
async function fetchStockCandles(symbol, tf, proxy) {
  const yurl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${YF_IV[tf]}&range=${YF_RANGE[tf]}`;
  const url = (proxy || DEFAULT_PROXY) + encodeURIComponent(yurl);
  let d;
  try { const r = await fetch(url); d = await r.json(); }
  catch (e) { throw new Error("Netzwerk/CORS — Yahoo nur über CORS-Proxy erreichbar (⚙︎)"); }
  const res = d && d.chart && d.chart.result && d.chart.result[0];
  if (!res || (d.chart && d.chart.error)) throw new Error((d && d.chart && d.chart.error && d.chart.error.description) || "Symbol bei Yahoo nicht gefunden");
  const ts = res.timestamp || [], q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  let candles = ts.map((t, i) => ({ t: t * 1000, o: q.open && q.open[i], h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i], v: (q.volume && q.volume[i]) || 0 }))
    .filter((c) => c.o != null && c.h != null && c.l != null && c.c != null);
  if (tf === "4h") candles = resample(candles, 4);
  return candles.slice(-LOAD);
}

function fetchCandles(market, symbol, tf, cfg) {
  return market === "stock" ? fetchStockCandles(symbol, tf, cfg.yahooProxy) : fetchCryptoCandles(symbol, tf);
}

function sma(vals, p) { const out = new Array(vals.length).fill(null); let s = 0; for (let i = 0; i < vals.length; i++) { s += vals[i]; if (i >= p) s -= vals[i - p]; if (i >= p - 1) out[i] = s / p; } return out; }
function fmtPrice(p) { if (p == null || isNaN(p)) return "—"; const d = p >= 1000 ? 2 : p >= 1 ? 2 : p >= 0.01 ? 4 : 6; return p.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtPct(v) { return (v >= 0 ? "+" : "") + v.toLocaleString("de-DE", { maximumFractionDigits: 2 }) + "%"; }
function fmtVol(v) { if (!v) return "—"; if (v >= 1e9) return (v / 1e9).toFixed(2) + "B"; if (v >= 1e6) return (v / 1e6).toFixed(2) + "M"; if (v >= 1e3) return (v / 1e3).toFixed(1) + "K"; return v.toFixed(0); }
function fmtTime(ms, tf) { const d = new Date(ms); if (tf === "1d" || tf === "1w") return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }); return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }

// ── Chart ──────────────────────────────────────────────────────────
function Chart({ all, view, setView, tf, symbol, mas, height }) {
  const wrapRef = useRef(null), svgRef = useRef(null), drag = useRef(null), geo = useRef(null), panAccum = useRef(0);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((es) => { for (const e of es) setW(Math.max(280, e.contentRect.width)); });
    ro.observe(wrapRef.current); return () => ro.disconnect();
  }, []);

  const H = height, padT = 12, padB = 22, padR = 60, padL = 6, volH = height > 360 ? 60 : 42, gap = 8;
  const len = all.length, end = len - view.offset, start = Math.max(0, end - view.count);
  const vis = all.slice(start, end);

  const layout = useMemo(() => {
    if (!vis.length) return null;
    const plotW = w - padL - padR, priceH = H - padT - padB - volH - gap;
    let lo = Math.min(...vis.map((c) => c.l)), hi = Math.max(...vis.map((c) => c.h));
    [mas.ma20, mas.ma50].forEach((arr) => { if (!arr) return; for (let i = start; i < end; i++) if (arr[i] != null) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); } });
    const pad = (hi - lo || 1) * 0.06; lo -= pad; hi += pad;
    const y = (p) => padT + ((hi - p) / (hi - lo)) * priceH;
    const n = vis.length, step = plotW / n, cx = (i) => padL + step * (i + 0.5), bw = Math.max(1, Math.min(11, step * 0.66));
    const volMax = Math.max(...vis.map((c) => c.v)) || 1, volTop = padT + priceH + gap, vy = (vv) => volTop + volH - (vv / volMax) * volH;
    return { plotW, priceH, lo, hi, y, n, step, cx, bw, volTop, vy };
  }, [vis, w, mas, start, end, H, volH]);
  geo.current = layout;

  const vbX = (clientX) => { const svg = svgRef.current; if (!svg) return null; const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = 0; const m = svg.getScreenCTM(); if (!m) return null; return pt.matrixTransform(m.inverse()).x; };

  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const g = geo.current; if (!g) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Quer-Wischen am Trackpad -> Pan
        panAccum.current += e.deltaX / g.step;
        const whole = Math.trunc(panAccum.current);
        if (whole !== 0) {
          panAccum.current -= whole;
          setView((v) => ({ ...v, offset: Math.max(0, Math.min(len - v.count, v.offset + whole)) }));
        }
      } else {
        // Vertikal -> sanfter, cursor-verankerter Zoom (proportional zur Wischstaerke)
        const x = vbX(e.clientX); if (x == null) return;
        const frac = Math.max(0, Math.min(1, (x - padL) / g.plotW));
        const factor = Math.exp(e.deltaY * 0.0016);
        setView((v) => {
          const count = Math.min(LOAD, Math.max(20, Math.round(v.count * factor)));
          const curStart = len - v.offset - v.count;
          const idxUnder = curStart + frac * v.count;
          const newStart = Math.round(idxUnder - frac * count);
          const offset = Math.max(0, Math.min(len - count, len - newStart - count));
          return { count, offset };
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [len, padL]);

  const onDown = (e) => { drag.current = { x: vbX(e.clientX), offset: view.offset }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    const g = geo.current; if (!g) return;
    const x = vbX(e.clientX); if (x == null) return;
    if (drag.current && drag.current.x != null) {
      const dc = Math.round((x - drag.current.x) / g.step);
      setView((v) => ({ ...v, offset: Math.max(0, Math.min(len - v.count, drag.current.offset + dc)) }));
      return;
    }
    setHover(Math.max(0, Math.min(vis.length - 1, Math.round((x - padL) / g.step - 0.5))));
  };
  const onUp = (e) => { drag.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId); };

  if (!layout || !vis.length) return <div style={{ height: H, display: "grid", placeItems: "center", color: C.faint, fontFamily: MONO, fontSize: 12 }}>lade Kerzen …</div>;
  const { y, n, step, cx, bw, volTop, vy } = layout;
  const yTicks = Array.from({ length: 5 }, (_, i) => layout.lo + ((layout.hi - layout.lo) * i) / 4);
  const xEvery = Math.max(1, Math.floor(n / 6));
  const last = vis[n - 1], hc = hover != null && hover < vis.length ? vis[hover] : last, hIdx = start + (hover != null ? hover : n - 1);
  const maLine = (arr, color) => { if (!arr) return null; let d = ""; for (let i = 0; i < vis.length; i++) { const v = arr[start + i]; if (v == null) continue; d += (d ? " L" : "M") + cx(i).toFixed(1) + "," + y(v).toFixed(1); } return d ? <path d={d} fill="none" stroke={color} strokeWidth={1.2} opacity={0.9} /> : null; };
  const chg = (hc.c / hc.o - 1) * 100;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", touchAction: "none", overscrollBehavior: "contain" }}>
      <div style={{ position: "absolute", top: 7, left: 9, zIndex: 2, fontFamily: MONO, fontSize: 11, lineHeight: 1.45, pointerEvents: "none" }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 12 }}>{symbol} · {tf}</div>
        <div style={{ color: C.dim }}>O <span style={{ color: C.text }}>{fmtPrice(hc.o)}</span> H <span style={{ color: C.text }}>{fmtPrice(hc.h)}</span> L <span style={{ color: C.text }}>{fmtPrice(hc.l)}</span> C <span style={{ color: chg >= 0 ? C.up : C.down }}>{fmtPrice(hc.c)} {fmtPct(chg)}</span></div>
        <div style={{ color: C.dim }}>{mas.ma20 && mas.ma20[hIdx] != null && <span style={{ color: C.ma20 }}>MA20 {fmtPrice(mas.ma20[hIdx])} </span>}{mas.ma50 && mas.ma50[hIdx] != null && <span style={{ color: C.ma50 }}>MA50 {fmtPrice(mas.ma50[hIdx])} </span>}<span style={{ color: C.faint }}>Vol {fmtVol(hc.v)}</span></div>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${w} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block", cursor: drag.current ? "grabbing" : "crosshair" }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        {yTicks.map((p, i) => (<g key={i}><line x1={padL} x2={w - padR} y1={y(p)} y2={y(p)} stroke={C.line} strokeWidth={1} /><text x={w - padR + 5} y={y(p) + 3.5} fill={C.faint} fontSize={10} fontFamily={MONO}>{fmtPrice(p)}</text></g>))}
        {vis.map((c, i) => i % xEvery === 0 ? <text key={i} x={cx(i)} y={H - 6} fill={C.faint} fontSize={9.5} fontFamily={MONO} textAnchor="middle">{fmtTime(c.t, tf)}</text> : null)}
        {vis.map((c, i) => { const up = c.c >= c.o; return <rect key={"v" + i} x={cx(i) - bw / 2} y={vy(c.v)} width={bw} height={Math.max(0.5, volTop + volH - vy(c.v))} fill={up ? C.up : C.down} opacity={0.3} />; })}
        {maLine(mas.ma20, C.ma20)}{maLine(mas.ma50, C.ma50)}
        <line x1={padL} x2={w - padR} y1={y(last.c)} y2={y(last.c)} stroke={C.accent} strokeDasharray="3 3" strokeWidth={1} opacity={0.7} />
        <rect x={w - padR} y={y(last.c) - 8} width={padR} height={16} fill={C.accent} rx={2} /><text x={w - padR + 4} y={y(last.c) + 3.5} fill={C.bg} fontSize={10} fontFamily={MONO} fontWeight={700}>{fmtPrice(last.c)}</text>
        {vis.map((c, i) => { const up = c.c >= c.o, col = up ? C.up : C.down, bx = cx(i), top = Math.min(y(c.o), y(c.c)), h = Math.max(1, Math.abs(y(c.c) - y(c.o))); return (<g key={i}><line x1={bx} x2={bx} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} /><rect x={bx - bw / 2} y={top} width={bw} height={h} fill={col} /></g>); })}
        {hover != null && !drag.current && (<g pointerEvents="none"><line x1={cx(hover)} x2={cx(hover)} y1={padT} y2={H - padB} stroke={C.dim} strokeDasharray="2 3" strokeWidth={1} opacity={0.6} /><line x1={padL} x2={w - padR} y1={y(hc.c)} y2={y(hc.c)} stroke={C.dim} strokeDasharray="2 3" strokeWidth={1} opacity={0.6} /><rect x={w - padR} y={y(hc.c) - 8} width={padR} height={16} fill={C.panel2} stroke={C.line} rx={2} /><text x={w - padR + 4} y={y(hc.c) + 3.5} fill={C.text} fontSize={10} fontFamily={MONO}>{fmtPrice(hc.c)}</text></g>)}
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

function Card({ title, accent, children }) { return (<div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 13px" }}><div style={{ fontSize: 9.5, letterSpacing: 1, color: accent || C.faint, fontFamily: MONO, marginBottom: 5 }}>{title}</div><div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5 }}>{children}</div></div>); }
function Analysis({ a }) {
  const sig = (a.signal || "flat").toLowerCase(), col = sig === "long" ? C.up : sig === "short" ? C.down : C.dim;
  return (<div style={{ display: "grid", gap: 8, marginTop: 12 }}>
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderLeft: `3px solid ${C.accent}`, borderRadius: 10, padding: "11px 14px" }}><div style={{ fontSize: 9.5, letterSpacing: 1, color: C.accent, fontFamily: MONO, marginBottom: 4 }}>REGIME</div><div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{a.regime}</div></div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 }}><Card title="LANGFRISTIG">{a.langfristig}</Card><Card title="MITTELFRISTIG">{a.mittelfristig}</Card></div>
    <div style={{ display: "flex", gap: 10, alignItems: "center", background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 13px" }}><span style={{ background: col, color: C.bg, fontFamily: MONO, fontWeight: 700, fontSize: 11.5, padding: "4px 11px", borderRadius: 6, textTransform: "uppercase" }}>{sig}</span><span style={{ fontSize: 12.5, lineHeight: 1.5 }}>{a.signal_begruendung}</span></div>
    <Card title="VOLUMEN">{a.volumen}</Card><Card title="LEVELS">{a.levels}</Card><Card title="ZU PRÜFEN — TREIBER">{a.treiber}</Card>
    <div style={{ background: "rgba(227,179,65,0.06)", border: `1px solid rgba(227,179,65,0.25)`, borderRadius: 10, padding: "10px 13px" }}><div style={{ fontSize: 9.5, letterSpacing: 1, color: C.warn, fontFamily: MONO, marginBottom: 5 }}>CAVEAT</div><div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>{a.caveat}</div></div>
  </div>);
}

// ── Einzel-Chart-Kachel ────────────────────────────────────────────
function ChartPane({ cfg, cryptoSymbols, compact, initial }) {
  const [symbol, setSymbol] = useState(initial.symbol);
  const [market, setMarket] = useState(initial.market);
  const [tf, setTf] = useState(initial.tf);
  const [all, setAll] = useState([]);
  const [err, setErr] = useState(null);
  const [view, setView] = useState({ count: 130, offset: 0 });
  const [showMA, setShowMA] = useState({ ma20: true, ma50: true });
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false);
  const [analysis, setAnalysis] = useState(null); const [busy, setBusy] = useState(false); const [aErr, setAErr] = useState(null);
  const boxRef = useRef(null);

  useEffect(() => {
    let alive = true; setErr(null);
    const run = async () => {
      try { const c = await fetchCandles(market, symbol, tf, cfg); if (alive) { setAll(c); } }
      catch (e) { if (alive) { setAll([]); setErr((e.message || "Fehler") + (market === "crypto" ? " · ggf. Sandbox/Hosting prüfen" : "")); } }
    };
    run(); const id = setInterval(run, market === "stock" ? 60000 : 30000);
    return () => { alive = false; clearInterval(id); };
  }, [symbol, market, tf, cfg]);
  useEffect(() => { setView((v) => ({ ...v, offset: 0 })); setAnalysis(null); }, [symbol, market, tf]);

  const mas = useMemo(() => { if (!all.length) return {}; const cl = all.map((c) => c.c); return { ma20: showMA.ma20 ? sma(cl, 20) : null, ma50: showMA.ma50 ? sma(cl, 50) : null }; }, [all, showMA]);
  const last = all[all.length - 1];
  const ch = last && all.length > 25 ? (last.c / all[all.length - 25].c - 1) * 100 : 0;
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
      const ctx = `Chart: ${symbol} (${market === "stock" ? "Aktie" : "Krypto"}), Zeitebene ${tf}. ${last ? "Letzter Kurs ungefähr " + fmtPrice(last.c) + "." : ""} Gelbe Linie = MA20, blaue Linie = MA50, Balken unten = Volumen, türkis gestrichelt = letzter Kurs. Analysiere genau dieses Chartbild nach dem Schema.`;
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
          {open && (<div style={{ position: "absolute", top: 36, left: 0, right: 0, zIndex: 6, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 9, maxHeight: 300, overflowY: "auto", boxShadow: "0 12px 30px rgba(0,0,0,.55)" }}>
            {results.length ? results.map((s) => (<div key={s.market + s.s} className="cs-opt" onMouseDown={() => { setSymbol(s.s); setMarket(s.market); setOpen(false); }}>
              <span style={{ color: C.text }}>{s.market === "stock" ? s.s : <>{s.b}<span style={{ color: C.faint }}>/USDT</span></>}{s.name ? <span style={{ color: C.faint }}> · {s.name}</span> : null}</span>
              <span style={{ fontSize: 9, color: s.market === "stock" ? C.ma50 : C.accent, border: `1px solid ${C.line}`, borderRadius: 4, padding: "1px 5px" }}>{s.market === "stock" ? "AKTIE" : "KRYPTO"}</span>
            </div>)) : <div style={{ padding: 11, color: C.faint, fontFamily: MONO, fontSize: 12 }}>kein Treffer</div>}
          </div>)}
        </div>
        <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 14 }}>{symbol}</span>
        {last && <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{fmtPrice(last.c)}</span>}
        {last && <span style={{ fontFamily: MONO, fontSize: 11.5, color: ch >= 0 ? C.up : C.down }}>{fmtPct(ch)}</span>}
      </div>
      {/* Pane-Toolbar */}
      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        {TFS.map((t) => <button key={t.id} className="cs-tf" data-on={t.id === tf ? 1 : 0} onClick={() => setTf(t.id)}>{t.l}</button>)}
        <button className="cs-ma" style={{ color: showMA.ma20 ? C.ma20 : C.faint }} onClick={() => setShowMA((m) => ({ ...m, ma20: !m.ma20 }))}>MA20</button>
        <button className="cs-ma" style={{ color: showMA.ma50 ? C.ma50 : C.faint }} onClick={() => setShowMA((m) => ({ ...m, ma50: !m.ma50 }))}>MA50</button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
          <button className="cs-ico" title="rauszoomen" onClick={() => setView((v) => ({ ...v, count: Math.min(LOAD, Math.round(v.count * 1.25)) }))}>−</button>
          <button className="cs-ico" title="reinzoomen" onClick={() => setView((v) => ({ ...v, count: Math.max(20, Math.round(v.count / 1.25)) }))}>+</button>
          <button className="cs-ico" title="zur Gegenwart" onClick={() => setView((v) => ({ ...v, offset: 0 }))}>⟩</button>
        </div>
      </div>
      {/* Chart */}
      <div ref={boxRef} style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 9, padding: "4px 2px" }}>
        {err ? <div style={{ height: chartH, display: "grid", placeItems: "center", textAlign: "center", color: C.warn, fontFamily: MONO, fontSize: 12, padding: 14 }}>{err}</div> : <Chart all={all} view={view} setView={setView} tf={tf} symbol={symbol} mas={mas} height={chartH} />}
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
  const [cfg, setCfg] = useState({ anthropicKey: store.get("cs_anthropic") || "", model: store.get("cs_model") || DEFAULT_MODEL, yahooProxy: store.get("cs_yahoo") || DEFAULT_PROXY });
  const [showCfg, setShowCfg] = useState(false);
  const [layout, setLayout] = useState(parseInt(store.get("cs_layout") || "1", 10));

  useEffect(() => { fetchCryptoSymbols().then(setCryptoSymbols).catch(() => {}); }, []);
  useEffect(() => { store.set("cs_layout", String(layout)); }, [layout]);
  const saveCfg = () => { store.set("cs_anthropic", cfg.anthropicKey.trim()); store.set("cs_model", (cfg.model || DEFAULT_MODEL).trim()); store.set("cs_yahoo", (cfg.yahooProxy || DEFAULT_PROXY).trim()); setCfg((c) => ({ anthropicKey: c.anthropicKey.trim(), model: (c.model || DEFAULT_MODEL).trim(), yahooProxy: (c.yahooProxy || DEFAULT_PROXY).trim() })); setShowCfg(false); };

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
    .cs-btn{background:${C.accent};color:${C.bg};border:none;border-radius:8px;padding:8px 16px;font:700 12.5px ${SANS};cursor:pointer}
    .cs-btn:disabled{background:${C.line};color:${C.faint};cursor:not-allowed}
    .cs-lay{background:${C.panel2};color:${C.dim};border:1px solid ${C.line};border-radius:7px;padding:5px 12px;font:700 12px ${MONO};cursor:pointer}
    .cs-lay[data-on="1"]{background:${C.accent};color:${C.bg};border-color:${C.accent}}
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
        <span style={{ fontSize: 11, letterSpacing: 1.5, color: C.accent, fontFamily: MONO, fontWeight: 700 }}>CHART-STATION</span>
        <div style={{ display: "flex", gap: 5, marginLeft: 4 }}>
          {[1, 2, 3, 4].map((n) => <button key={n} className="cs-lay" data-on={layout === n ? 1 : 0} onClick={() => setLayout(n)} title={`${n} Chart${n > 1 ? "s" : ""}`}>{n}</button>)}
        </div>
        <span style={{ fontSize: 11.5, color: C.faint }}>{layout === 1 ? "Einzelchart" : `${layout} Kacheln`}</span>
        <button className="cs-ico" style={{ marginLeft: "auto" }} title="Keys einrichten" onClick={() => setShowCfg((s) => !s)}>⚙︎</button>
      </div>

      {showCfg && (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginBottom: 14, display: "grid", gap: 9, maxWidth: 560 }}>
          <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>Keys bleiben nur im <b style={{ color: C.text }}>localStorage dieses Browsers</b> — nie im Repo/Bundle. Nur auf deinem eigenen Gerät nutzen.</div>
          <input className="cs-inp" type="password" placeholder="Anthropic-Key (sk-ant-…) — für die Analyse" value={cfg.anthropicKey} onChange={(e) => setCfg({ ...cfg, anthropicKey: e.target.value })} />
          <input className="cs-inp" placeholder={`Modell (Standard: ${DEFAULT_MODEL})`} value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} />
          <input className="cs-inp" placeholder="CORS-Proxy für Yahoo (Aktien) — Default: allorigins" value={cfg.yahooProxy} onChange={(e) => setCfg({ ...cfg, yahooProxy: e.target.value })} />
          <div><button className="cs-btn" onClick={saveCfg}>Speichern</button></div>
        </div>
      )}

      <div className="cs-grid" data-n={layout}>
        {PANE_DEFAULTS.slice(0, layout).map((d, i) => <ChartPane key={i} cfg={cfg} cryptoSymbols={cryptoSymbols} compact={layout > 1} initial={d} />)}
      </div>

      <div style={{ marginTop: 14, fontSize: 10.5, color: C.faint, lineHeight: 1.6, fontFamily: MONO }}>Krypto: Binance (keyless). Aktien: Yahoo Finance über CORS-Proxy. Ziehen = Pan, Rad/±-Buttons = cursor-verankerter Zoom. Analyse liest das jeweilige Chartbild. Keine Anlageempfehlung.</div>
    </div>
  );
}
