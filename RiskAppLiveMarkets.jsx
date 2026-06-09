import React, { useState, useEffect, useRef, useMemo } from "react";

/**
 * Live-Märkte — Modul für das Risiko-Journal
 * ------------------------------------------------------------------
 * Vergleicht den Kurs EINES Assets über mehrere OFFENE Börsen
 * (Binance, Coinbase, Kraken, Bitstamp) und zeigt den Spread in bps.
 * Candlestick-Chart aus Binance-Klines mit Zeitebenen-Umschaltung.
 *
 * Keyless & proxy-frei: alle Endpunkte sind öffentliche REST-APIs mit
 * CORS-Freigabe. Läuft unverändert im Claude.ai-Artefakt UND in der
 * eigenständigen PWA (GitHub Pages).
 */

// ── Palette (Instrument-Panel / Trading-Desk) ──────────────────────
const C = {
  bg: "#0B0E14",
  panel: "#121722",
  panel2: "#0F141D",
  line: "#222A39",
  text: "#E6E9EF",
  dim: "#8A93A6",
  faint: "#566076",
  accent: "#4DD4C0",
  up: "#46C77E",
  down: "#F0616D",
  warn: "#E3B341",
};
const MONO = "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// ── Asset → Börsen-Symbol-Mapping ──────────────────────────────────
const ASSETS = {
  BTC:  { binance: "BTCUSDT",  coinbase: "BTC-USD",  kraken: "XBTUSD",  bitstamp: "btcusd"  },
  ETH:  { binance: "ETHUSDT",  coinbase: "ETH-USD",  kraken: "ETHUSD",  bitstamp: "ethusd"  },
  SOL:  { binance: "SOLUSDT",  coinbase: "SOL-USD",  kraken: "SOLUSD",  bitstamp: "solusd"  },
  XRP:  { binance: "XRPUSDT",  coinbase: "XRP-USD",  kraken: "XRPUSD",  bitstamp: "xrpusd"  },
  ADA:  { binance: "ADAUSDT",  coinbase: "ADA-USD",  kraken: "ADAUSD",  bitstamp: "adausd"  },
  DOGE: { binance: "DOGEUSDT", coinbase: "DOGE-USD", kraken: "XDGUSD",  bitstamp: "dogeusd" },
  LINK: { binance: "LINKUSDT", coinbase: "LINK-USD", kraken: "LINKUSD", bitstamp: "linkusd" },
  AVAX: { binance: "AVAXUSDT", coinbase: "AVAX-USD", kraken: "AVAXUSD", bitstamp: "avaxusd" },
};
const VENUES = [
  { id: "binance",  name: "Binance",  quote: "USDT" },
  { id: "coinbase", name: "Coinbase", quote: "USD"  },
  { id: "kraken",   name: "Kraken",   quote: "USD"  },
  { id: "bitstamp", name: "Bitstamp", quote: "USD"  },
];
const TFS = [
  { id: "1h", label: "1H", limit: 120 },
  { id: "4h", label: "4H", limit: 120 },
  { id: "1d", label: "1D", limit: 120 },
];

// ── Fetch-Helfer ───────────────────────────────────────────────────
async function j(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
const fetchers = {
  binance:  (s) => j(`https://api.binance.com/api/v3/ticker/price?symbol=${s}`).then((d) => parseFloat(d.price)),
  coinbase: (s) => j(`https://api.exchange.coinbase.com/products/${s}/ticker`).then((d) => parseFloat(d.price)),
  kraken:   (s) => j(`https://api.kraken.com/0/public/Ticker?pair=${s}`).then((d) => parseFloat(Object.values(d.result)[0].c[0])),
  bitstamp: (s) => j(`https://www.bitstamp.net/api/v2/ticker/${s}/`).then((d) => parseFloat(d.last)),
};

async function fetchAllPrices(asset) {
  const m = ASSETS[asset];
  const settled = await Promise.allSettled(VENUES.map((v) => fetchers[v.id](m[v.id])));
  return VENUES.map((v, i) => ({
    ...v,
    price: settled[i].status === "fulfilled" && isFinite(settled[i].value) ? settled[i].value : null,
  }));
}

async function fetchCandles(asset, tf) {
  const s = ASSETS[asset].binance;
  const lim = TFS.find((t) => t.id === tf).limit;
  const d = await j(`https://api.binance.com/api/v3/klines?symbol=${s}&interval=${tf}&limit=${lim}`);
  return d.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

// ── Formatierung ───────────────────────────────────────────────────
function fmtPrice(p) {
  if (p == null || isNaN(p)) return "—";
  const d = p >= 1000 ? 2 : p >= 1 ? 2 : p >= 0.01 ? 4 : 6;
  return p.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtBps(v) {
  return v.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function fmtTime(ms, tf) {
  const dt = new Date(ms);
  if (tf === "1d") return dt.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  return dt.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ── Candlestick-Chart (handgerolltes SVG) ──────────────────────────
function Candles({ candles, tf }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((es) => {
      for (const e of es) setW(Math.max(320, e.contentRect.width));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const H = 360, padT = 14, padB = 26, padL = 6, padR = 70;
  const geo = useMemo(() => {
    if (!candles.length) return null;
    const plotW = w - padL - padR;
    const plotH = H - padT - padB;
    const lows = candles.map((c) => c.l), highs = candles.map((c) => c.h);
    const min = Math.min(...lows), max = Math.max(...highs);
    const pad = (max - min || 1) * 0.06;
    const yMin = min - pad, yMax = max + pad;
    const y = (p) => padT + ((yMax - p) / (yMax - yMin)) * plotH;
    const n = candles.length;
    const step = plotW / n;
    const cx = (i) => padL + step * (i + 0.5);
    const bodyW = Math.max(1.5, Math.min(9, step * 0.62));
    return { plotW, plotH, yMin, yMax, y, n, step, cx, bodyW };
  }, [candles, w]);

  if (!candles.length || !geo) return null;
  const { plotH, yMin, yMax, y, n, step, cx, bodyW } = geo;

  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
  const xEvery = Math.max(1, Math.floor(n / 6));
  const last = candles[n - 1];

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * w;
    let i = Math.floor((x - padL) / step);
    i = Math.max(0, Math.min(n - 1, i));
    setHover(i);
  };

  const hc = hover != null ? candles[hover] : null;
  const tipW = 168;
  const tipX = hover != null ? Math.min(cx(hover) + 10, w - padR - tipW) : 0;

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <svg
        viewBox={`0 0 ${w} ${H}`}
        width="100%"
        height={H}
        style={{ display: "block", cursor: "crosshair" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Gitter + Preis-Achse */}
        {yTicks.map((p, i) => (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={y(p)} y2={y(p)} stroke={C.line} strokeWidth={1} />
            <text x={w - padR + 6} y={y(p) + 3.5} fill={C.faint} fontSize={10.5} fontFamily={MONO}>
              {fmtPrice(p)}
            </text>
          </g>
        ))}

        {/* Zeit-Achse */}
        {candles.map((c, i) =>
          i % xEvery === 0 ? (
            <text key={i} x={cx(i)} y={H - 8} fill={C.faint} fontSize={10} fontFamily={MONO} textAnchor="middle">
              {fmtTime(c.t, tf)}
            </text>
          ) : null
        )}

        {/* Letzte-Kurs-Linie */}
        <line x1={padL} x2={w - padR} y1={y(last.c)} y2={y(last.c)} stroke={C.accent} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
        <rect x={w - padR} y={y(last.c) - 8} width={padR} height={16} fill={C.accent} rx={2} />
        <text x={w - padR + 5} y={y(last.c) + 3.5} fill={C.bg} fontSize={10.5} fontFamily={MONO} fontWeight={700}>
          {fmtPrice(last.c)}
        </text>

        {/* Kerzen */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const col = up ? C.up : C.down;
          const bx = cx(i);
          const top = Math.min(y(c.o), y(c.c));
          const h = Math.max(1, Math.abs(y(c.c) - y(c.o)));
          return (
            <g key={i} opacity={hover == null || hover === i ? 1 : 0.55}>
              <line x1={bx} x2={bx} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} />
              <rect x={bx - bodyW / 2} y={top} width={bodyW} height={h} fill={col} />
            </g>
          );
        })}

        {/* Hover-Fadenkreuz + Tooltip */}
        {hc && (
          <g pointerEvents="none">
            <line x1={cx(hover)} x2={cx(hover)} y1={padT} y2={H - padB} stroke={C.dim} strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
            <g transform={`translate(${tipX}, ${padT + 4})`}>
              <rect width={tipW} height={92} rx={6} fill={C.panel2} stroke={C.line} />
              <text x={10} y={18} fill={C.dim} fontSize={10.5} fontFamily={MONO}>{fmtTime(hc.t, tf)}</text>
              {[
                ["O", hc.o], ["H", hc.h], ["L", hc.l], ["C", hc.c],
              ].map(([k, v], r) => (
                <g key={k}>
                  <text x={10 + (r % 2) * 82} y={38 + Math.floor(r / 2) * 18} fill={C.faint} fontSize={10.5} fontFamily={MONO}>{k}</text>
                  <text x={26 + (r % 2) * 82} y={38 + Math.floor(r / 2) * 18} fill={C.text} fontSize={10.5} fontFamily={MONO}>{fmtPrice(v)}</text>
                </g>
              ))}
              <text x={10} y={82} fill={hc.c >= hc.o ? C.up : C.down} fontSize={10.5} fontFamily={MONO}>
                {((hc.c / hc.o - 1) * 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })}% Kerze
              </text>
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}

// ── Hauptkomponente ────────────────────────────────────────────────
export default function LiveMarkets() {
  const [asset, setAsset] = useState("BTC");
  const [tf, setTf] = useState("1h");
  const [prices, setPrices] = useState([]);
  const [candles, setCandles] = useState([]);
  const [chartErr, setChartErr] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [loading, setLoading] = useState(true);

  // Preise: initial + alle 15s
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const run = async () => {
      const r = await fetchAllPrices(asset);
      if (alive) { setPrices(r); setUpdated(Date.now()); setLoading(false); }
    };
    run();
    const id = setInterval(run, 15000);
    return () => { alive = false; clearInterval(id); };
  }, [asset]);

  // Kerzen: bei Asset/Zeitebene + alle 60s
  useEffect(() => {
    let alive = true;
    setChartErr(null);
    const run = async () => {
      try {
        const c = await fetchCandles(asset, tf);
        if (alive) setCandles(c);
      } catch {
        if (alive) { setCandles([]); setChartErr("Chart-Quelle (Binance) nicht erreichbar. Preisvergleich bleibt aktiv."); }
      }
    };
    run();
    const id = setInterval(run, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [asset, tf]);

  const spread = useMemo(() => {
    const valid = prices.filter((p) => p.price != null);
    if (valid.length < 2) return null;
    const s = [...valid].sort((a, b) => a.price - b.price);
    const lo = s[0], hi = s[s.length - 1];
    return { lo, hi, abs: hi.price - lo.price, bps: ((hi.price - lo.price) / lo.price) * 1e4 };
  }, [prices]);

  const css = `
    .lm-pill{background:${C.panel2};color:${C.dim};border:1px solid ${C.line};border-radius:7px;padding:6px 13px;font:600 12.5px ${SANS};cursor:pointer;transition:all .12s}
    .lm-pill:hover{color:${C.text};border-color:${C.faint}}
    .lm-pill[data-on="1"]{background:${C.accent};color:${C.bg};border-color:${C.accent}}
    .lm-tf{background:transparent;color:${C.dim};border:1px solid ${C.line};border-radius:6px;padding:4px 12px;font:600 11.5px ${MONO};cursor:pointer}
    .lm-tf[data-on="1"]{background:${C.panel2};color:${C.accent};border-color:${C.accent}}
    .lm-card{background:${C.panel2};border:1px solid ${C.line};border-radius:10px;padding:13px 15px;transition:border-color .15s}
    .lm-card:focus-visible,.lm-pill:focus-visible,.lm-tf:focus-visible{outline:2px solid ${C.accent};outline-offset:2px}
    @keyframes lm-pulse{0%,100%{opacity:1}50%{opacity:.35}}
    .lm-dot{width:7px;height:7px;border-radius:50%;background:${C.up};animation:lm-pulse 1.8s ease-in-out infinite}
  `;

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: SANS, padding: 20, borderRadius: 14, maxWidth: 860, margin: "0 auto" }}>
      <style dangerouslySetInnerHTML={{ __html: css }} />

      {/* Kopf */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: C.accent, fontFamily: MONO, fontWeight: 700 }}>LIVE-MÄRKTE</div>
          <div style={{ fontSize: 19, fontWeight: 700, marginTop: 2 }}>Börsenvergleich &amp; Chart</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: C.dim, fontFamily: MONO }}>
          <span className="lm-dot" />
          {updated ? `aktualisiert ${new Date(updated).toLocaleTimeString("de-DE")}` : "lade …"}
        </div>
      </div>

      {/* Asset-Auswahl */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 18 }}>
        {Object.keys(ASSETS).map((a) => (
          <button key={a} className="lm-pill" data-on={a === asset ? 1 : 0} onClick={() => setAsset(a)}>{a}</button>
        ))}
      </div>

      {/* Börsen-Kacheln */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
        {prices.map((v) => {
          const isLo = spread && v.price === spread.lo.price && v.price != null;
          const isHi = spread && v.price === spread.hi.price && spread.abs > 0;
          const dBps = spread && v.price != null ? ((v.price - spread.lo.price) / spread.lo.price) * 1e4 : null;
          return (
            <div key={v.id} className="lm-card" style={{ borderColor: isLo ? C.up : isHi ? C.down : C.line }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{v.name}</span>
                <span style={{ fontSize: 9.5, color: C.faint, fontFamily: MONO, border: `1px solid ${C.line}`, borderRadius: 4, padding: "1px 5px" }}>{v.quote}</span>
              </div>
              <div style={{ fontSize: 19, fontFamily: MONO, fontWeight: 600, color: v.price == null ? C.faint : C.text }}>
                {v.price == null ? "n/v" : fmtPrice(v.price)}
              </div>
              <div style={{ fontSize: 11, fontFamily: MONO, marginTop: 4, color: isLo ? C.up : isHi ? C.down : C.dim }}>
                {v.price == null ? "Börse antwortet nicht" : isLo ? "günstigste" : `+${fmtBps(dBps)} bps`}
              </div>
            </div>
          );
        })}
      </div>

      {/* Spread-Zusammenfassung — das Signaturelement */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", marginBottom: 22, display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 10, color: C.faint, fontFamily: MONO, letterSpacing: 1 }}>SPREAD ÜBER BÖRSEN</div>
          <div style={{ fontSize: 22, fontFamily: MONO, fontWeight: 700, color: spread && spread.bps > 15 ? C.warn : C.accent }}>
            {spread ? `${fmtBps(spread.bps)} bps` : "—"}
          </div>
        </div>
        {spread && (
          <div style={{ fontSize: 12.5, color: C.dim, lineHeight: 1.6 }}>
            <div>günstig: <b style={{ color: C.up }}>{spread.lo.name}</b> {fmtPrice(spread.lo.price)}</div>
            <div>teuer: <b style={{ color: C.down }}>{spread.hi.name}</b> {fmtPrice(spread.hi.price)}</div>
          </div>
        )}
        <div style={{ fontSize: 10.5, color: C.faint, maxWidth: 230, marginLeft: "auto", lineHeight: 1.5 }}>
          USDT-Quotes (Binance) tragen eine kleine Stablecoin-Basis ggü. USD — bei der bps-Lesung mitdenken.
        </div>
      </div>

      {/* Chart */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.dim, fontFamily: MONO }}>{asset} · Binance · Kerzen</div>
        <div style={{ display: "flex", gap: 6 }}>
          {TFS.map((t) => (
            <button key={t.id} className="lm-tf" data-on={t.id === tf ? 1 : 0} onClick={() => setTf(t.id)}>{t.label}</button>
          ))}
        </div>
      </div>

      {chartErr ? (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: 24, textAlign: "center", color: C.warn, fontSize: 12.5, fontFamily: MONO }}>
          {chartErr}
        </div>
      ) : candles.length ? (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 6px" }}>
          <Candles candles={candles} tf={tf} />
        </div>
      ) : (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: 24, textAlign: "center", color: C.faint, fontSize: 12.5, fontFamily: MONO }}>
          lade Kerzen …
        </div>
      )}

      {/* Fuß */}
      <div style={{ marginTop: 16, fontSize: 10.5, color: C.faint, lineHeight: 1.6, fontFamily: MONO }}>
        Quellen: öffentliche REST-APIs von Binance, Coinbase, Kraken, Bitstamp (keyless, CORS).
        Preise alle 15s, Kerzen alle 60s. Keine Anlageempfehlung.
      </div>
    </div>
  );
}
