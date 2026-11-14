// The Spectrum tab: brightness of one spot in every photo, placed at the exact colour that photo saw.
// Together, hundreds of photos trace the spot's "colour fingerprint" across SPHEREx's 0.75-5 µm range.
import { visitColour } from "./results.js";

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hasData = (v) => v > -1e29;

// One SPHEREx pixel covers (6.15″)² = 8.89e-10 steradian; images are in MJy/sr, so
// summing pixels and multiplying by this gives millijanskys (approximate: pixel size varies slightly).
const MJY_PER_PIXEL_SUM = 8.89e-10 * 1e9;
const APERTURE_R = 2;            // pixels: the light of a star falls within ~2 pixels
const SKY_R = [4, 7];            // pixels: ring used to measure the surrounding sky

// Where molecules absorb light in SPHEREx's range (approximate band edges, µm).
export const BANDS = [
  { name: "Water", lo: 1.33, hi: 1.47, short: "water" },
  { name: "Water", lo: 1.80, hi: 1.96, short: "water" },
  { name: "Water ice", lo: 2.90, hi: 3.20, short: "water ice" },
  { name: "Methane", lo: 3.24, hi: 3.40, short: "methane" },
  { name: "CO₂ ice", lo: 4.22, hi: 4.32, short: "CO₂" },
  { name: "CO", lo: 4.60, hi: 4.75, short: "CO" },
];
const BAND_TABLE = [
  ["Water", "1.4 and 1.9 µm", "a cool star's or brown dwarf's atmosphere"],
  ["Water ice", "3.0 µm", "the light passed through a cold, icy cloud, where stars and planets form"],
  ["Methane", "3.3 µm", "a very cold object: the classic sign of a brown dwarf"],
  ["CO₂ ice", "4.27 µm", "frozen carbon dioxide in a cold cloud or a comet"],
  ["CO", "4.67 µm", "frozen in the coldest clouds, or as gas in a brown dwarf's atmosphere"],
];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const dayText = (utc) => `${Number(utc.slice(8, 10))} ${MONTHS[Number(utc.slice(5, 7)) - 1]} ${utc.slice(0, 4)}`;

function median(a) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.floor(s.length / 2)];
}

// Brightness of the spot (cx, cy) in one cut-out: light in a small circle minus the surrounding sky.
export function measure(img, n, cx, cy) {
  let sum = 0, count = 0;
  const sky = [];
  const r2 = APERTURE_R * APERTURE_R, s0 = SKY_R[0] ** 2, s1 = SKY_R[1] ** 2;
  for (let y = Math.max(0, Math.floor(cy - SKY_R[1])); y <= Math.min(n - 1, Math.ceil(cy + SKY_R[1])); y++) {
    for (let x = Math.max(0, Math.floor(cx - SKY_R[1])); x <= Math.min(n - 1, Math.ceil(cx + SKY_R[1])); x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2, v = img[y * n + x];
      if (d <= r2) {
        if (!hasData(v)) return null;          // a flagged or overflowing pixel in the circle: no measurement
        sum += v; count++;
      } else if (d >= s0 && d <= s1 && hasData(v)) {
        sky.push(v);
      }
    }
  }
  if (!count || sky.length < 8) return null;
  const bg = median(sky);
  const spread = 1.4826 * median(sky.map((v) => Math.abs(v - bg)));
  return { flux: (sum - bg * count) * MJY_PER_PIXEL_SUM, err: spread * Math.sqrt(count) * MJY_PER_PIXEL_SUM };
}

export class Spectrum {
  constructor(flip) {
    this.flip = flip;
    this.canvas = $("spec-canvas");
    this.points = [];
    this.place = null;
    const rows = $("band-rows");
    for (const [name, where, meaning] of BAND_TABLE) {
      const tr = document.createElement("tr");
      for (const text of [name, where, meaning]) { const td = document.createElement("td"); td.textContent = text; tr.append(td); }
      rows.append(tr);
    }
    $("spec-csv").addEventListener("click", () => this.download());
    this.canvas.addEventListener("pointermove", (e) => this.hover(e));
    this.canvas.addEventListener("pointerleave", () => { $("spec-tip").hidden = true; });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  visible() { return !$("spec-stage").hidden; }

  update() {
    const run = this.flip.run;
    if (!run || !run.n) return;
    const n = run.n, spot = this.flip.spot || { x: (n - 1) / 2, y: (n - 1) / 2 };
    const pts = [];
    let skipped = 0;
    for (const f of run.meta.values()) {
      const m = measure(run.px.get(f.i), n, spot.x, spot.y);
      if (!m) { skipped++; continue; }
      pts.push({ lam: f.lam_um, ...m, visit: f.pass, utc: f.utc, det: f.det, obs: f.obs_id });
    }
    pts.sort((a, b) => a.lam - b.lam);
    this.points = pts;
    this.skipped = skipped;
    this.describe(spot, n, run);
    this.draw();
  }

  describe(spot, n, run) {
    const place = this.flip.place;
    const centre = Math.abs(spot.x - (n - 1) / 2) < 0.6 && Math.abs(spot.y - (n - 1) / 2) < 0.6;
    $("spec-title").textContent = `Colour fingerprint of ${centre && place && place.name ? place.name : "this spot"}`;
    if (centre) {
      $("spec-spot").textContent = "Measuring: the centre of the patch (your search position).";
    } else {
      const dx = (spot.x - (n - 1) / 2) * 6.15, dy = (spot.y - (n - 1) / 2) * 6.15;
      const ew = dx < 0 ? `${Math.abs(dx).toFixed(0)}″ east` : `${dx.toFixed(0)}″ west`;
      const ns = dy >= 0 ? `${dy.toFixed(0)}″ north` : `${Math.abs(dy).toFixed(0)}″ south`;
      $("spec-spot").textContent = `Measuring: a spot ${ew} and ${ns} of the search position.`;
    }
    const total = this.points.length + this.skipped, loading = !run.done;
    let sub = `${this.points.length} photo${this.points.length === 1 ? "" : "s"} measured`;
    if (this.skipped) sub += `, ${this.skipped} left out (bad or overflowing pixels at this spot)`;
    if (loading) sub += ". More photos are still loading.";
    $("spec-sub").textContent = sub;
    const tooBright = total > 10 && this.skipped > 0.6 * total;
    const empty = $("spec-empty");
    empty.hidden = this.points.length > 0 && !tooBright;
    empty.textContent = !total ? "Loading photos…"
      : tooBright ? "This spot is too bright: its centre overflows SPHEREx's detector in most photos, so it can't be measured reliably. Click a fainter star on the Flipbook image."
      : "No usable measurements at this spot.";
    const visits = [...new Set(this.points.map((p) => p.visit))].sort((a, b) => a - b);
    const legend = $("spec-legend");
    legend.replaceChildren();
    for (const v of visits) {
      const span = document.createElement("span"), dot = document.createElement("i");
      dot.className = "dot";
      dot.style.background = visitColour(v);
      const first = this.points.find((p) => p.visit === v);
      span.append(dot, document.createTextNode(`Visit ${v + 1} (${MONTHS[Number(first.utc.slice(5, 7)) - 1]} ${first.utc.slice(0, 4)})`));
      legend.append(span);
    }
    if (visits.length) {
      const band = document.createElement("span");
      const sw = document.createElement("i");
      sw.className = "key";
      sw.style.background = "rgba(157, 178, 200, .16)";
      band.append(sw, document.createTextNode("Molecule band"));
      legend.append(band);
    }
  }

  // ---- drawing ------------------------------------------------------------------------
  layout() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { w, h, l: 84, r: w - 24, t: 52, b: h - 46 };
  }

  scales() {
    const L = this.layout(), lam0 = 0.7, lam1 = 5.1;
    const vals = this.points.map((p) => p.flux).sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))] || 0;
    let lo = Math.min(0, q(0.01)), hi = q(0.99);
    if (hi <= lo) hi = lo + 1;
    hi += (hi - lo) * 0.12;
    return {
      ...L, lo, hi,
      x: (lam) => L.l + ((lam - lam0) / (lam1 - lam0)) * (L.r - L.l),
      y: (f) => L.b - ((f - lo) / (hi - lo)) * (L.b - L.t),
    };
  }

  draw() {
    const c = this.canvas, dpr = devicePixelRatio, ctx = c.getContext("2d");
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const S = this.scales(), line = css("--line"), text2 = css("--text-2"), text3 = css("--text-3");
    ctx.font = `12px ${css("--font")}`;

    // molecule bands: flat shading, labelled at the top
    for (const b of BANDS) {
      const x0 = S.x(b.lo), x1 = S.x(b.hi);
      ctx.fillStyle = "rgba(157, 178, 200, .08)";
      ctx.fillRect(x0, S.t, x1 - x0, S.b - S.t);
    }
    ctx.fillStyle = text2;
    ctx.textAlign = "center";
    const rowRight = [-Infinity, -Infinity];   // two label rows, so neighbouring bands never hide a label
    for (const b of BANDS) {
      const xm = (S.x(b.lo) + S.x(b.hi)) / 2, tw = ctx.measureText(b.short).width;
      const row = xm - tw / 2 >= rowRight[0] + 6 ? 0 : 1;
      ctx.fillText(b.short, xm, S.t - 10 - row * 16);
      rowRight[row] = xm + tw / 2;
    }

    // axes
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(S.l, S.t); ctx.lineTo(S.l, S.b); ctx.lineTo(S.r, S.b);
    ctx.stroke();
    ctx.fillStyle = text3;
    ctx.textAlign = "center";
    for (const lam of [0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]) {
      const x = S.x(lam);
      ctx.beginPath(); ctx.moveTo(x, S.b); ctx.lineTo(x, S.b + 4); ctx.stroke();
      ctx.fillText(String(lam), x, S.b + 18);
    }
    ctx.fillText("Colour (wavelength, µm)", (S.l + S.r) / 2, S.b + 38);
    ctx.textAlign = "right";
    const step = niceStep((S.hi - S.lo) / 5);
    for (let v = Math.ceil(S.lo / step) * step; v <= S.hi; v += step) {
      const y = S.y(v);
      ctx.fillText(fmt(v), S.l - 8, y + 4);
      ctx.strokeStyle = line;
      ctx.beginPath(); ctx.moveTo(S.l - 4, y); ctx.lineTo(S.l, y); ctx.stroke();
    }
    ctx.save();
    ctx.translate(18, (S.t + S.b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("Brightness (millijanskys)", 0, 0);
    ctx.restore();

    // measurements: error bar + dot, coloured by visit
    for (const p of this.points) {
      const x = S.x(p.lam), y = S.y(p.flux);
      if (y < S.t - 2 || y > S.b + 2) continue;
      const col = visitColour(p.visit);
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.45;
      ctx.beginPath(); ctx.moveTo(x, S.y(p.flux - p.err)); ctx.lineTo(x, S.y(p.flux + p.err)); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    this.S = S;
  }

  hover(e) {
    const tip = $("spec-tip");
    if (!this.S || !this.points.length) { tip.hidden = true; return; }
    const r = this.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 144;
    for (const p of this.points) {
      const d = (this.S.x(p.lam) - mx) ** 2 + (this.S.y(p.flux) - my) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) { tip.hidden = true; return; }
    tip.textContent = `${best.lam.toFixed(3)} µm: ${fmt(best.flux)} ± ${fmt(best.err)} mJy. ${dayText(best.utc)}, visit ${best.visit + 1}, detector ${best.det}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(mx + 12, r.width - tw - 8)}px`;
    tip.style.top = `${Math.max(my - 36, 4)}px`;
  }

  download() {
    if (!this.points.length) return;
    const rows = [["wavelength_um", "brightness_mJy", "error_mJy", "date_utc", "visit", "detector", "obs_id"]];
    for (const p of this.points) rows.push([p.lam.toFixed(4), p.flux.toFixed(4), p.err.toFixed(4), p.utc, p.visit + 1, p.det, p.obs]);
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n") + "\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "spherex-spectrum.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1))), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function fmt(v) {
  if (Math.abs(v) < 1e-9) return "0";
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
}
