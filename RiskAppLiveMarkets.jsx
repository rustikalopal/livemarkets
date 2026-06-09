import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

/**
 * Chart-Station — Risiko-Journal
 * TradingView-artiger Candlestick-Chart (Binance) mit Symbolsuche,
 * Volumen, MA20/50, Fadenkreuz, Zoom & Pan.
 * Claude-Analyse liest das CHARTBILD (Vision), keyless via Direct-Browser-Access.
 * Reines GitHub Pages — kein Server, kein Proxy.
 */

const C = {
  bg: "#0B0E14", panel: "#121722", panel2: "#0F141D", line: "#222A39",
  text: "#E6E9EF", dim: "#8A93A6", faint: "#566076",
  accent: "#4DD4C0", up: "#46C77E", down: "#F0616D", warn: "#E3B341",
  ma20: "#E3B341", ma50: "#7AA2F7",
};
const MONO = "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const TFS = [{ id: "15m", label: "15m" }, { id: "1h", label: "1H" }, { id: "4h", label: "4H" }, { id: "1d", label: "1D" }, { id: "1w", label: "1W" }];
const LOAD = 500;
const DEFAULT_MODEL = "claude-sonnet-4-6";

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
async function fetchSymbols() {
  const cached = store.get("binance_symbols");
  if (cached) { try { const o = JSON.parse(cached); if (Date.now() - o.ts < 864e5 && o.list?.length) return o.list; } catch {} }
  const d = await j("https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT");
  const list = d.symbols.filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
    .map((s) => ({ s: s.symbol, b: s.baseAsset })).sort((a, b) => a.b.localeCompare(b.b));
  store.set("binance_symbols", JSON.stringify({ ts: Date.now(), list }));
  return list;
}
async function fetchCandles(symbol, tf) {
  const d = await j(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${LOAD}`);
  return d.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}
function sma(vals, p) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) { sum += vals[i]; if (i >= p) sum -= vals[i - p]; if (i >= p - 1) out[i] = sum / p; }
  return out;
}

function fmtPrice(p) { if (p == null || isNaN(p)) return "—"; const d = p >= 1000 ? 2 : p >= 1 ? 2 : p >= 0.01 ? 4 : 6; return p.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtPct(v) { return (v >= 0 ? "+" : "") + v.toLocaleString("de-DE", { maximumFractionDigits: 2 }) + "%"; }
function fmtVol(v) { if (v >= 1e9) return (v / 1e9).toFixed(2) + "B"; if (v >= 1e6) return (v / 1e6).toFixed(2) + "M"; if (v >= 1e3) return (v / 1e3).toFixed(1) + "K"; return v.toFixed(0); }
function fmtTime(ms, tf) { const d = new Date(ms); if (tf === "1d" || tf === "1w") return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }); return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }

// ── Chart ──────────────────────────────────────────────────────────
function Chart({ all, view, setView, tf, symbol, mas }) {
  const wrapRef = useRef(null), svgRef = useRef(null), drag = useRef(null), geo = useRef(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((es) => { for (const e of es) setW(Math.max(320, e.contentRect.width)); });
    ro.observe(wrapRef.current); return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e) => { e.preventDefault(); const dir = Math.sign(e.deltaY); setView((v) => ({ ...v, count: Math.min(LOAD, Math.max(24, v.count + dir * Math.max(2, Math.round(v.count * 0.12)))) })); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setView]);

  const H = 430, padT = 12, padB = 22, padR = 66, padL = 6, volH = 64, gap = 10;
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
  }, [vis, w, mas, start, end]);
  geo.current = layout;

  const onDown = (e) => { drag.current = { x: e.clientX, offset: view.offset }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    const g = geo.current; if (!g) return;
    if (drag.current) {
      const rectW = e.currentTarget.getBoundingClientRect().width;
      const dc = Math.round(((e.clientX - drag.current.x) / rectW) * w / g.step);
      setView((v) => ({ ...v, offset: Math.max(0, Math.min(len - v.count, drag.current.offset + dc)) }));
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    let i = Math.round((((e.clientX - rect.left) / rect.width) * w - padL) / g.step - 0.5);
    setHover(Math.max(0, Math.min(vis.length - 1, i)));
  };
  const onUp = (e) => { drag.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId); };

  if (!layout || !vis.length) return <div style={{ height: H, display: "grid", placeItems: "center", color: C.faint, fontFamily: MONO, fontSize: 12 }}>lade Kerzen …</div>;
  const { y, n, step, cx, bw, volTop, vy } = layout;
  const yTicks = Array.from({ length: 5 }, (_, i) => layout.lo + ((layout.hi - layout.lo) * i) / 4);
  const xEvery = Math.max(1, Math.floor(n / 6));
  const last = vis[n - 1], hc = hover != null && hover < vis.length ? vis[hover] : last, hIdx = start + (hover != null ? hover : n - 1);

  const maLine = (arr, color) => {
    if (!arr) return null;
    let d = "";
    for (let i = 0; i < vis.length; i++) { const v = arr[start + i]; if (v == null) continue; d += (d ? " L" : "M") + cx(i).toFixed(1) + "," + y(v).toFixed(1); }
    return d ? <path d={d} fill="none" stroke={color} strokeWidth={1.2} opacity={0.9} /> : null;
  };
  const chg = (hc.c / hc.o - 1) * 100;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", touchAction: "none" }}>
      <div style={{ position: "absolute", top: 8, left: 10, zIndex: 2, fontFamily: MONO, fontSize: 11.5, lineHeight: 1.5, pointerEvents: "none" }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 12.5 }}>{symbol} · {tf}</div>
        <div style={{ color: C.dim }}>O <span style={{ color: C.text }}>{fmtPrice(hc.o)}</span>　H <span style={{ color: C.text }}>{fmtPrice(hc.h)}</span>　L <span style={{ color: C.text }}>{fmtPrice(hc.l)}</span>　C <span style={{ color: chg >= 0 ? C.up : C.down }}>{fmtPrice(hc.c)}</span><span style={{ color: chg >= 0 ? C.up : C.down }}>　{fmtPct(chg)}</span></div>
        <div style={{ color: C.dim }}>
          {mas.ma20 && mas.ma20[hIdx] != null && <span style={{ color: C.ma20 }}>MA20 {fmtPrice(mas.ma20[hIdx])}　</span>}
          {mas.ma50 && mas.ma50[hIdx] != null && <span style={{ color: C.ma50 }}>MA50 {fmtPrice(mas.ma50[hIdx])}　</span>}
          <span style={{ color: C.faint }}>Vol {fmtVol(hc.v)}</span>
        </div>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${w} ${H}`} width="100%" height={H} style={{ display: "block", cursor: drag.current ? "grabbing" : "crosshair" }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        {yTicks.map((p, i) => (<g key={i}><line x1={padL} x2={w - padR} y1={y(p)} y2={y(p)} stroke={C.line} strokeWidth={1} /><text x={w - padR + 6} y={y(p) + 3.5} fill={C.faint} fontSize={10.5} fontFamily={MONO}>{fmtPrice(p)}</text></g>))}
        {vis.map((c, i) => i % xEvery === 0 ? <text key={i} x={cx(i)} y={H - 6} fill={C.faint} fontSize={10} fontFamily={MONO} textAnchor="middle">{fmtTime(c.t, tf)}</text> : null)}
        {vis.map((c, i) => { const up = c.c >= c.o; return <rect key={"v" + i} x={cx(i) - bw / 2} y={vy(c.v)} width={bw} height={Math.max(0.5, volTop + 64 - vy(c.v))} fill={up ? C.up : C.down} opacity={0.32} />; })}
        {maLine(mas.ma20, C.ma20)}
        {maLine(mas.ma50, C.ma50)}
        <line x1={padL} x2={w - padR} y1={y(last.c)} y2={y(last.c)} stroke={C.accent} strokeDasharray="3 3" strokeWidth={1} opacity={0.7} />
        <rect x={w - padR} y={y(last.c) - 8} width={padR} height={16} fill={C.accent} rx={2} />
        <text x={w - padR + 5} y={y(last.c) + 3.5} fill={C.bg} fontSize={10.5} fontFamily={MONO} fontWeight={700}>{fmtPrice(last.c)}</text>
        {vis.map((c, i) => { const up = c.c >= c.o, col = up ? C.up : C.down, bx = cx(i), top = Math.min(y(c.o), y(c.c)), h = Math.max(1, Math.abs(y(c.c) - y(c.o))); return (<g key={i}><line x1={bx} x2={bx} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} /><rect x={bx - bw / 2} y={top} width={bw} height={h} fill={col} /></g>); })}
        {hover != null && !drag.current && (<g pointerEvents="none"><line x1={cx(hover)} x2={cx(hover)} y1={padT} y2={H - padB} stroke={C.dim} strokeDasharray="2 3" strokeWidth={1} opacity={0.5} /><line x1={padL} x2={w - padR} y1={y(hc.c)} y2={y(hc.c)} stroke={C.dim} strokeDasharray="2 3" strokeWidth={1} opacity={0.5} /><rect x={w - padR} y={y(hc.c) - 8} width={padR} height={16} fill={C.panel2} stroke={C.line} rx={2} /><text x={w - padR + 5} y={y(hc.c) + 3.5} fill={C.text} fontSize={10.5} fontFamily={MONO}>{fmtPrice(hc.c)}</text></g>)}
      </svg>
    </div>
  );
}

// ── Chart → PNG (für Vision) ───────────────────────────────────────
async function chartToPng(scale = 2) {
  const svg = document.querySelector("#cs-chart svg");
  if (!svg) throw new Error("Kein Chart sichtbar");
  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
  const clone = svg.cloneNode(true);
  clone.setAttribute("width", w); clone.setAttribute("height", h);
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", 0); bg.setAttribute("y", 0); bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("fill", C.bg);
  clone.insertBefore(bg, clone.firstChild);
  const xml = new XMLSerializer().serializeToString(clone);
  const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("SVG-Rasterung fehlgeschlagen")); img.src = url; });
  const cv = document.createElement("canvas");
  cv.width = w * scale; cv.height = h * scale;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/png").split(",")[1];
}

// ── Claude-Vision-Aufruf (Direct Browser Access) ───────────────────
const SYSTEM = `Du bist ein systematischer, datengetriebener Chart-Analyst. Du bekommst das BILD eines Candlestick-Charts und liest es rein VISUELL: Trendstruktur (höhere Hochs/Tiefs intakt oder gebrochen?), Lage des Kurses zu den gleitenden Durchschnitten, die Volumenbalken unten, sichtbare Support-/Resistance-Zonen, Kerzenmuster und Momentum. Lies Preisniveaus näherungsweise von der Achse rechts ab.

Gib AUSSCHLIESSLICH gültiges JSON nach diesem Schema zurück — kein Fließtext, keine Markdown-Fences, nichts davor oder danach:
{
 "regime": "ein Satz zur grundsätzlichen Lage, die das Bild zeigt",
 "langfristig": "Struktur über den ganzen sichtbaren Verlauf: höhere Hochs/Tiefs? Lage zur MA50",
 "mittelfristig": "jüngste Kerzen: Momentum-Richtung, Lage zu MA20/MA50",
 "volumen": "was die Volumenbalken zeigen (Bestätigung, Divergenz, Spitzen)",
 "signal": "long | flat | short",
 "signal_begruendung": "warum, anhand des Bildes, inkl. ob ein Trend-/Regime-Filter dieses Signal feuern ließe",
 "levels": "sichtbare Linie im Sand (ungefähres Niveau von der Achse) plus was ein Bruch öffnet",
 "treiber": "welcher Flow-/Fundamental-Kontext wäre als nächstes zu prüfen — benenne offene Fragen, erfinde KEINE Zahlen oder News, die nicht im Bild stehen",
 "caveat": "die Falle bei genau diesem Setup, plus ausdrücklich: keine Anlageempfehlung"
}
Antworte auf Deutsch. Trenne Lang- von Mittelfrist sauber; sie dürfen sich widersprechen.`;

async function analyzeChart(ctxText, cfg) {
  const data = await chartToPng(2);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: cfg.model || DEFAULT_MODEL,
      max_tokens: 1300,
      system: SYSTEM,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
        { type: "text", text: ctxText },
      ] }],
    }),
  });
  if (!r.ok) {
    let msg = "HTTP " + r.status;
    try { const e = await r.json(); if (e.error?.message) msg = e.error.message; } catch {}
    throw new Error(msg);
  }
  const d = await r.json();
  let t = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

function Card({ title, accent, children }) {
  return (<div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "11px 14px" }}><div style={{ fontSize: 10, letterSpacing: 1, color: accent || C.faint, fontFamily: MONO, marginBottom: 5 }}>{title}</div><div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{children}</div></div>);
}
function Analysis({ a }) {
  const sig = (a.signal || "flat").toLowerCase(), sigCol = sig === "long" ? C.up : sig === "short" ? C.down : C.dim;
  return (
    <div style={{ display: "grid", gap: 9, marginTop: 14 }}>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderLeft: `3px solid ${C.accent}`, borderRadius: 10, padding: "12px 15px" }}><div style={{ fontSize: 10, letterSpacing: 1, color: C.accent, fontFamily: MONO, marginBottom: 4 }}>REGIME</div><div style={{ fontSize: 14, color: C.text, lineHeight: 1.5 }}>{a.regime}</div></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 9 }}><Card title="LANGFRISTIG">{a.langfristig}</Card><Card title="MITTELFRISTIG">{a.mittelfristig}</Card></div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "11px 14px" }}><span style={{ background: sigCol, color: C.bg, fontFamily: MONO, fontWeight: 700, fontSize: 12, padding: "4px 12px", borderRadius: 6, textTransform: "uppercase" }}>{sig}</span><span style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{a.signal_begruendung}</span></div>
      <Card title="VOLUMEN">{a.volumen}</Card>
      <Card title="LEVELS">{a.levels}</Card>
      <Card title="ZU PRÜFEN — TREIBER">{a.treiber}</Card>
      <div style={{ background: "rgba(227,179,65,0.06)", border: `1px solid rgba(227,179,65,0.25)`, borderRadius: 10, padding: "11px 14px" }}><div style={{ fontSize: 10, letterSpacing: 1, color: C.warn, fontFamily: MONO, marginBottom: 5 }}>CAVEAT</div><div style={{ fontSize: 12.5, color: C.dim, lineHeight: 1.5 }}>{a.caveat}</div></div>
    </div>
  );
}

export default function ChartStudio() {
  const [symbol, setSymbol] = useState(store.get("cs_symbol") || "BTCUSDT");
  const [tf, setTf] = useState(store.get("cs_tf") || "1h");
  const [all, setAll] = useState([]);
  const [err, setErr] = useState(null);
  const [view, setView] = useState({ count: 140, offset: 0 });
  const [showMA, setShowMA] = useState({ ma20: true, ma50: true });
  const [symbols, setSymbols] = useState([]);
  const [q, setQ] = useState("");
  const [openSearch, setOpenSearch] = useState(false);
  const [cfg, setCfg] = useState({ apiKey: store.get("cs_apikey") || "", model: store.get("cs_model") || DEFAULT_MODEL });
  const [showCfg, setShowCfg] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [aErr, setAErr] = useState(null);

  useEffect(() => { fetchSymbols().then(setSymbols).catch(() => {}); }, []);
  useEffect(() => { store.set("cs_symbol", symbol); store.set("cs_tf", tf); }, [symbol, tf]);
  useEffect(() => {
    let alive = true; setErr(null);
    const run = async () => { try { const c = await fetchCandles(symbol, tf); if (alive) { setAll(c); setView((v) => ({ ...v, offset: 0 })); } } catch { if (alive) { setAll([]); setErr(`${symbol} bei Binance nicht erreichbar. Symbol prüfen oder gehostet öffnen (Sandbox blockt Live-Daten).`); } } };
    run(); const id = setInterval(run, 30000); return () => { alive = false; clearInterval(id); };
  }, [symbol, tf]);

  const mas = useMemo(() => { if (!all.length) return {}; const cl = all.map((c) => c.c); return { ma20: showMA.ma20 ? sma(cl, 20) : null, ma50: showMA.ma50 ? sma(cl, 50) : null }; }, [all, showMA]);
  const last = all[all.length - 1];
  const dayChg = last && all.length > 25 ? (last.c / all[all.length - 25].c - 1) * 100 : 0;
  const results = useMemo(() => { if (!q.trim()) return symbols.slice(0, 40); const u = q.toUpperCase().replace(/\s/g, ""); return symbols.filter((s) => s.b.startsWith(u) || s.s.includes(u)).slice(0, 40); }, [q, symbols]);
  const canAnalyze = !!cfg.apiKey && all.length > 50 && !err;

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true); setAErr(null); setAnalysis(null);
    try {
      const lines = [
        `Chart: ${symbol}, Zeitebene ${tf}.`,
        last ? `Letzter Kurs ungefähr ${fmtPrice(last.c)} USDT.` : "",
        `Gelbe Linie = MA20, blaue Linie = MA50. Die Balken im unteren Bereich sind das Volumen. Die gestrichelte türkise Linie markiert den letzten Kurs.`,
        `Analysiere genau dieses Chartbild nach dem Schema.`,
      ].filter(Boolean).join(" ");
      const a = await analyzeChart(lines, cfg);
      setAnalysis(a);
    } catch (e) {
      setAErr("Analyse fehlgeschlagen: " + (e.message || e) + (cfg.apiKey ? "" : " — API-Key unter ⚙︎ eintragen."));
    } finally { setAnalyzing(false); }
  }, [symbol, tf, last, cfg]);

  const saveCfg = () => { store.set("cs_apikey", cfg.apiKey.trim()); store.set("cs_model", (cfg.model || DEFAULT_MODEL).trim()); setCfg((c) => ({ ...c, apiKey: c.apiKey.trim() })); setShowCfg(false); };

  const css = `
    .cs-tf{background:transparent;color:${C.dim};border:1px solid ${C.line};border-radius:6px;padding:4px 11px;font:600 11.5px ${MONO};cursor:pointer}
    .cs-tf[data-on="1"]{background:${C.panel2};color:${C.accent};border-color:${C.accent}}
    .cs-ma{background:transparent;border:1px solid ${C.line};border-radius:6px;padding:4px 10px;font:600 11px ${MONO};cursor:pointer}
    .cs-ico{background:${C.panel2};color:${C.dim};border:1px solid ${C.line};border-radius:6px;width:30px;height:28px;cursor:pointer;font-size:14px}
    .cs-ico:hover{color:${C.text}}
    .cs-inp{background:${C.panel2};color:${C.text};border:1px solid ${C.line};border-radius:8px;padding:8px 11px;font:13px ${MONO};width:100%;box-sizing:border-box}
    .cs-inp:focus{outline:2px solid ${C.accent};outline-offset:-1px;border-color:${C.accent}}
    .cs-opt{padding:7px 11px;cursor:pointer;display:flex;justify-content:space-between;font-family:${MONO};font-size:12.5px}
    .cs-opt:hover{background:${C.panel2}}
    .cs-btn{background:${C.accent};color:${C.bg};border:none;border-radius:8px;padding:9px 18px;font:700 13px ${SANS};cursor:pointer}
    .cs-btn:disabled{background:${C.line};color:${C.faint};cursor:not-allowed}
    @keyframes cs-spin{to{transform:rotate(360deg)}}
  `;

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: SANS, padding: 18, borderRadius: 14, maxWidth: 900, margin: "0 auto" }}>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ position: "relative", flex: "1 1 240px", minWidth: 220 }}>
          <input className="cs-inp" placeholder="Symbol suchen (z. B. SOL, ETHUSDT, ARB) …" value={openSearch ? q : ""} onFocus={() => { setOpenSearch(true); setQ(""); }} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setOpenSearch(false), 150)} />
          {openSearch && (<div style={{ position: "absolute", top: 42, left: 0, right: 0, zIndex: 5, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, maxHeight: 320, overflowY: "auto", boxShadow: "0 12px 30px rgba(0,0,0,.5)" }}>{results.length ? results.map((s) => (<div key={s.s} className="cs-opt" onMouseDown={() => { setSymbol(s.s); setOpenSearch(false); setAnalysis(null); }}><span style={{ color: C.text }}>{s.b}<span style={{ color: C.faint }}>/USDT</span></span><span style={{ color: C.faint }}>{s.s}</span></div>)) : <div style={{ padding: 12, color: C.faint, fontFamily: MONO, fontSize: 12 }}>{symbols.length ? "kein Treffer" : "lade Symbole …"}</div>}</div>)}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO }}>{symbol}</span>
          {last && <span style={{ fontFamily: MONO, fontSize: 16 }}>{fmtPrice(last.c)}</span>}
          {last && <span style={{ fontFamily: MONO, fontSize: 12.5, color: dayChg >= 0 ? C.up : C.down }}>{fmtPct(dayChg)}</span>}
        </div>
        <button className="cs-ico" title="API-Key einrichten" onClick={() => setShowCfg((s) => !s)}>⚙︎</button>
      </div>

      {showCfg && (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginBottom: 12, display: "grid", gap: 9 }}>
          <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>Anthropic-API-Key. Bleibt nur im <b style={{ color: C.text }}>localStorage dieses Browsers</b> — nie im Repo, nie im Bundle. Nur auf deinem eigenen Gerät nutzen.</div>
          <input className="cs-inp" type="password" placeholder="sk-ant-…" value={cfg.apiKey} onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })} />
          <input className="cs-inp" placeholder={`Modell (Standard: ${DEFAULT_MODEL})`} value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} />
          <div><button className="cs-btn" onClick={saveCfg}>Speichern</button></div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 6 }}>{TFS.map((t) => <button key={t.id} className="cs-tf" data-on={t.id === tf ? 1 : 0} onClick={() => setTf(t.id)}>{t.label}</button>)}</div>
        <div style={{ width: 1, height: 18, background: C.line, margin: "0 4px" }} />
        <button className="cs-ma" style={{ color: showMA.ma20 ? C.ma20 : C.faint }} onClick={() => setShowMA((m) => ({ ...m, ma20: !m.ma20 }))}>MA20</button>
        <button className="cs-ma" style={{ color: showMA.ma50 ? C.ma50 : C.faint }} onClick={() => setShowMA((m) => ({ ...m, ma50: !m.ma50 }))}>MA50</button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button className="cs-ico" title="rauszoomen" onClick={() => setView((v) => ({ ...v, count: Math.min(LOAD, v.count + 20) }))}>−</button>
          <button className="cs-ico" title="reinzoomen" onClick={() => setView((v) => ({ ...v, count: Math.max(24, v.count - 20) }))}>+</button>
          <button className="cs-ico" title="zur Gegenwart" onClick={() => setView((v) => ({ ...v, offset: 0 }))}>⟩</button>
        </div>
      </div>

      <div id="cs-chart" style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "6px 4px" }}>
        {err ? <div style={{ height: 200, display: "grid", placeItems: "center", textAlign: "center", color: C.warn, fontFamily: MONO, fontSize: 12.5, padding: 16 }}>{err}</div> : <Chart all={all} view={view} setView={setView} tf={tf} symbol={symbol} mas={mas} />}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <button className="cs-btn" disabled={!canAnalyze || analyzing} onClick={runAnalysis}>{analyzing ? "Claude liest den Chart …" : "Chartbild mit Claude analysieren"}</button>
        {analyzing && <span style={{ width: 16, height: 16, border: `2px solid ${C.line}`, borderTopColor: C.accent, borderRadius: "50%", display: "inline-block", animation: "cs-spin .8s linear infinite" }} />}
        {!cfg.apiKey && <span style={{ fontSize: 12, color: C.faint }}>API-Key unter ⚙︎ eintragen, dann ist die Analyse aktiv.</span>}
      </div>
      {aErr && <div style={{ marginTop: 10, color: C.warn, fontSize: 12.5, fontFamily: MONO }}>{aErr}</div>}
      {analysis && <Analysis a={analysis} />}

      <div style={{ marginTop: 16, fontSize: 10.5, color: C.faint, lineHeight: 1.6, fontFamily: MONO }}>Kerzen von Binance (keyless). Ziehen = Pan, Rad/±-Buttons = Zoom. Analyse liest das sichtbare Chartbild. Datengestützte Einordnung, keine Anlageempfehlung.</div>
    </div>
  );
}
