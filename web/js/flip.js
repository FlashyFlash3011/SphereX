// The Flipbook tab: SPHEREx cut-outs of the chosen spot, grouped by visit, added up in one colour
// band, and looped like WiseView. Cut-outs stream in from the server; frames sharpen as they arrive.
import { Flipbook, NO_DATA } from "./flipbook.js";

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DET_UM = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00] };
const DEFAULT_DET = 3;   // 1.6-2.4 µm: most stars are bright here
// "No data" is stored as -1e30 in 32-bit floats, which isn't exactly -1e30 any more: always compare with a threshold.
const hasData = (v) => v > -1e29;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const monthYear = (utc) => `${MONTHS[Number(utc.slice(5, 7)) - 1]} ${utc.slice(0, 4)}`;
const dayText = (utc) => `${Number(utc.slice(8, 10))} ${MONTHS[Number(utc.slice(5, 7)) - 1]} ${utc.slice(0, 4)}`;

function rangeText(a, b) {
  const x = monthYear(a), y = monthYear(b);
  if (x === y) return x;
  return x.slice(-4) === y.slice(-4) ? `${x.slice(0, 3)} – ${y}` : `${x} – ${y}`;
}

// float16 bits → float32; the server marks "no data" as -30000.
function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}
function decode(u16) {
  const out = new Float32Array(u16.length);
  for (let k = 0; k < u16.length; k++) {
    const v = halfToFloat(u16[k]);
    out[k] = Number.isFinite(v) && v > -20000 ? v : NO_DATA;
  }
  return out;
}

// Mean of several cut-outs, pixel by pixel, ignoring pixels without data.
function addUp(list, size) {
  const sum = new Float64Array(size), count = new Uint16Array(size), out = new Float32Array(size);
  for (const a of list) for (let k = 0; k < size; k++) if (hasData(a[k])) { sum[k] += a[k]; count[k]++; }
  for (let k = 0; k < size; k++) out[k] = count[k] ? sum[k] / count[k] : NO_DATA;
  return out;
}

async function getJson(url, options) {
  let resp;
  try { resp = await fetch(url, options); } catch { throw new Error("Can't reach the SphereX server. Check your connection."); }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(typeof body.detail === "string" ? body.detail : "The server couldn't do that. Try again.");
  return body;
}

export class Flip {
  constructor() {
    this.book = new Flipbook($("flip-canvas"));
    this.overlay = $("flip-overlay");
    this.run = null;
    this.views = [];
    this.at = 0;
    this.timer = null;
    this.band = { kind: "det", det: DEFAULT_DET };
    this.mode = "visits";
    this.size = 64;
    this.place = null;
    this.bindSettings();
    new ResizeObserver(() => this.drawMarker()).observe(this.overlay);
  }

  // ---- loading ----------------------------------------------------------------------
  async open(place, size) {
    this.place = place;
    this.size = size;
    for (const b of $("flip-size").querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.size) === size));
    this.pause();
    const run = (this.run = { id: null, n: size, exposures: [], meta: new Map(), px: new Map(), missing: [], done: false });
    this.views = [];
    this.at = 0;
    this.render();
    this.status("Starting… the server cuts your patch out of every SPHEREx photo of this spot.");
    if (!this.book.ok) { this.empty("This browser can't draw the images (it needs WebGL 2). Try a current Chrome, Firefox or Safari."); return; }
    try {
      const q = new URLSearchParams({ ra: place.ra.toFixed(6), dec: place.dec.toFixed(6), size: String(size),
                                      first: String(this.band.kind === "det" ? this.band.det : Math.floor(this.band.ch / 17) + 1) });
      const s = await getJson(`/api/stacks?${q}`, { method: "POST" });
      if (this.run !== run) return;
      run.id = s.id;
      run.exposures = s.exposures;
      run.total = s.total;
      this.fillBands();
      if (!s.total) { this.empty("SPHEREx has no photos of this spot yet."); this.status(""); return; }
      await this.follow(run);
    } catch (err) {
      if (this.run === run) { this.status(err.message); this.empty(err.message); }
    }
  }

  async follow(run) {
    let after = 0;
    for (;;) {
      const st = await getJson(`/api/stacks/${run.id}/status?after=${after}`);
      if (this.run !== run) return;
      after = st.next;
      run.missing = st.missing;
      const fresh = st.frames;
      for (let k = 0; k < fresh.length; k += 48) {
        const part = fresh.slice(k, k + 48);
        let resp;
        try { resp = await fetch(`/api/stacks/${run.id}/frames?i=${part.map((f) => f.i).join(",")}`); } catch { resp = null; }
        if (this.run !== run) return;
        if (!resp || !resp.ok) continue;
        const buf = await resp.arrayBuffer(), n2 = run.n * run.n;
        if (buf.byteLength !== part.length * n2 * 2) continue;
        part.forEach((f, j) => {
          run.meta.set(f.i, f);
          run.px.set(f.i, decode(new Uint16Array(buf, j * n2 * 2, n2)));
        });
      }
      if (fresh.length) this.scheduleRebuild();
      const lost = st.missing.length;
      if (st.done) {
        run.done = true;
        this.rebuild();
        this.status(`All ${st.ready} photos loaded` + (lost ? `; ${lost} could not be loaded (not on the detector or the archive didn't answer).` : "."));
        return;
      }
      this.status(`Loading photos: ${st.ready} of ${st.total}. The frames get clearer as photos arrive.`);
      await new Promise((r) => setTimeout(r, fresh.length ? 300 : 800));
    }
  }

  scheduleRebuild() {
    if (this._rebuildTimer) return;
    this._rebuildTimer = setTimeout(() => { this._rebuildTimer = null; this.rebuild(); }, 350);
  }

  // ---- building the frames ------------------------------------------------------------
  inBand(f) {
    return this.band.kind === "det" ? f.det === this.band.det : f.channel === this.band.ch;
  }

  rebuild() {
    const run = this.run;
    if (!run) return;
    this.fillBands();
    const members = [...run.meta.values()].filter((f) => this.inBand(f)).sort((a, b) => a.mjd - b.mjd);
    const n2 = run.n * run.n;
    let views = [];
    if (this.mode === "visits") {
      const byVisit = new Map();
      for (const f of members) { if (!byVisit.has(f.pass)) byVisit.set(f.pass, []); byVisit.get(f.pass).push(f); }
      const nVisits = new Set(run.exposures.map((e) => e.pass)).size;
      views = [...byVisit.entries()].sort((a, b) => a[0] - b[0]).map(([v, list]) => ({
        title: rangeText(list[0].utc, list[list.length - 1].utc),
        sub: `Visit ${v + 1} of ${nVisits}, ${list.length} photo${list.length === 1 ? "" : "s"} added together`,
        label: `Visit ${v + 1}`, small: rangeText(list[0].utc, list[list.length - 1].utc),
        data: addUp(list.map((f) => run.px.get(f.i)), n2),
      }));
    } else {
      views = members.map((f, k) => ({
        title: dayText(f.utc),
        sub: `Photo ${k + 1} of ${members.length}, ${f.lam_um.toFixed(3)} µm, visit ${f.pass + 1}, ${f.utc.slice(11, 16)} UTC`,
        label: dayText(f.utc), small: `${f.lam_um.toFixed(2)} µm`,
        data: run.px.get(f.i),
      }));
    }
    this.views = views;
    if (this.at >= views.length) this.at = 0;
    this.book.setFrames(run.n, views.map((v) => v.data));
    this.updateCuts();
    this.render();
    if (!this.timer && !reducedMotion && views.length >= 2 && this._autoplay !== false) { this._autoplay = false; this.play(); }
  }

  updateCuts() {
    const vals = [];
    for (const v of this.views) for (let k = 0; k < v.data.length; k += 3) if (hasData(v.data[k])) vals.push(v.data[k]);
    if (!vals.length) return;
    vals.sort((a, b) => a - b);
    const pick = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor((p / 100) * vals.length)))];
    const lo = pick(Number($("flip-low").value)), hi = pick(Number($("flip-high").value));
    this.book.set({ cuts: [lo, hi > lo ? hi : lo + 1e-3] });
    $("flip-cuts-out").textContent = `${lo.toFixed(1)} to ${hi.toFixed(1)} MJy/sr`;
  }

  // ---- showing ---------------------------------------------------------------------
  render() {
    const v = this.views[this.at];
    if (!this.run || !this.run.id) { $("flip-title").textContent = ""; $("flip-sub").textContent = ""; }
    if (!v) {
      if (this.run && this.run.id) this.empty(this.run.done ? "No photos in this colour band. Pick another band." : "Loading the first photos of this colour band…");
      this.renderStrip();
      return;
    }
    $("flip-empty").hidden = true;
    $("flip-title").textContent = v.title;
    $("flip-sub").textContent = v.sub;
    this.book.set({ layer: this.at });
    this.renderStrip();
    this.drawMarker();
  }

  renderStrip() {
    const strip = $("flip-frames"), slider = $("flip-slider");
    const many = this.views.length > 8;
    strip.hidden = many;
    slider.hidden = !many;
    if (many) {
      slider.max = String(this.views.length - 1);
      slider.value = String(this.at);
      return;
    }
    if (strip.childElementCount !== this.views.length || strip.dataset.mode !== this.mode) {
      strip.replaceChildren();
      strip.dataset.mode = this.mode;
      this.views.forEach((v, k) => {
        const b = document.createElement("button"), strong = document.createElement("strong");
        b.type = "button";
        strong.textContent = v.label;
        b.append(strong, document.createTextNode(v.small));
        b.addEventListener("click", () => { this.pause(); this.go(k); });
        strip.append(b);
      });
    }
    [...strip.children].forEach((b, k) => {
      b.setAttribute("aria-current", String(k === this.at));
      b.lastChild.textContent = this.views[k].small;
    });
  }

  empty(text) {
    $("flip-empty").textContent = text;
    $("flip-empty").hidden = false;
    $("flip-title").textContent = $("flip-title").textContent || "";
  }

  status(text) { $("flip-status").textContent = text; }

  drawMarker() {
    const c = this.overlay, ctx = c.getContext("2d"), dpr = devicePixelRatio;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!$("flip-marker").checked || !this.views.length) return;
    // The search position is the centre of the patch; draw an open crosshair so the star stays visible.
    const zoom = this.book.state.zoom, px = (w / (this.run ? this.run.n : 64)) * zoom;
    const gap = Math.max(10, px * 1.6), len = Math.max(10, px * 1.4);
    ctx.strokeStyle = "#FFB547";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(w / 2 + dx * gap, h / 2 + dy * gap);
      ctx.lineTo(w / 2 + dx * (gap + len), h / 2 + dy * (gap + len));
    }
    ctx.stroke();
  }

  go(k) {
    if (!this.views.length) return;
    this.at = (k + this.views.length) % this.views.length;
    this.render();
  }

  play() {
    if (this.timer || this.views.length < 2) return;
    $("flip-play").setAttribute("aria-pressed", "true");
    $("flip-play").setAttribute("aria-label", "Pause");
    const tick = () => { this.go(this.at + 1); this.timer = setTimeout(tick, Number($("flip-interval").value)); };
    this.timer = setTimeout(tick, Number($("flip-interval").value));
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    $("flip-play").setAttribute("aria-pressed", "false");
    $("flip-play").setAttribute("aria-label", "Play");
  }

  // ---- the colour band list -----------------------------------------------------------
  fillBands() {
    const run = this.run, sel = $("flip-band");
    if (!run) return;
    const detCount = {}, chCount = new Map();
    for (const e of run.exposures) detCount[e.det] = (detCount[e.det] || 0) + 1;
    for (const f of run.meta.values()) {
      const c = chCount.get(f.channel) || { n: 0, lam: 0 };
      c.n++; c.lam += f.lam_um;
      chCount.set(f.channel, c);
    }
    const key = `${Object.entries(detCount).join()}|${[...chCount].map(([c, v]) => c + ":" + v.n).join()}`;
    if (sel.dataset.key === key) return;
    sel.dataset.key = key;
    sel.replaceChildren();
    const g1 = document.createElement("optgroup");
    g1.label = "Whole detector (clearer)";
    for (let d = 1; d <= 6; d++) {
      if (!detCount[d]) continue;
      const o = new Option(`Detector ${d}: ${DET_UM[d][0].toFixed(2)}–${DET_UM[d][1].toFixed(2)} µm (${detCount[d]} photos)`, `det:${d}`);
      g1.append(o);
    }
    sel.append(g1);
    if (chCount.size) {
      const g2 = document.createElement("optgroup");
      g2.label = "One exact colour (fairest)";
      for (const [c, v] of [...chCount].sort((a, b) => a[0] - b[0])) {
        g2.append(new Option(`${(v.lam / v.n).toFixed(2)} µm (${v.n} photo${v.n === 1 ? "" : "s"} so far)`, `ch:${c}`));
      }
      sel.append(g2);
    }
    sel.value = this.band.kind === "det" ? `det:${this.band.det}` : `ch:${this.band.ch}`;
    if (!sel.value && sel.options.length) { sel.selectedIndex = 0; this.readBand(); }
  }

  readBand() {
    const [kind, num] = $("flip-band").value.split(":");
    this.band = kind === "ch" ? { kind: "ch", ch: Number(num) } : { kind: "det", det: Number(num) };
  }

  // ---- settings ------------------------------------------------------------------------
  bindSettings() {
    $("flip-band").addEventListener("change", () => { this.readBand(); this.at = 0; this.rebuild(); });
    for (const b of $("flip-mode").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        this.mode = b.dataset.mode;
        for (const o of $("flip-mode").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        this.at = 0;
        this.rebuild();
      });
    }
    $("flip-interval").addEventListener("input", (e) => { $("flip-interval-out").textContent = `${e.target.value} ms`; });
    $("flip-zoom").addEventListener("input", (e) => {
      $("flip-zoom-out").textContent = `${e.target.value}×`;
      this.book.set({ zoom: Number(e.target.value) });
      this.drawMarker();
    });
    $("flip-low").addEventListener("input", () => this.updateCuts());
    $("flip-high").addEventListener("input", () => this.updateCuts());
    for (const b of $("flip-stretch").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        for (const o of $("flip-stretch").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        this.book.set({ soft: b.dataset.stretch === "soft" });
      });
    }
    $("flip-invert").addEventListener("change", (e) => this.book.set({ invert: e.target.checked }));
    $("flip-smooth").addEventListener("change", (e) => this.book.set({ smooth: e.target.checked }));
    $("flip-marker").addEventListener("change", () => this.drawMarker());
    for (const b of $("flip-size").querySelectorAll("button")) {
      b.addEventListener("click", () => { if (this.place && Number(b.dataset.size) !== this.size) this.open(this.place, Number(b.dataset.size)); });
    }
    $("flip-play").addEventListener("click", () => (this.timer ? this.pause() : this.play()));
    $("flip-prev").addEventListener("click", () => { this.pause(); this.go(this.at - 1); });
    $("flip-next").addEventListener("click", () => { this.pause(); this.go(this.at + 1); });
    $("flip-slider").addEventListener("input", (e) => { this.pause(); this.go(Number(e.target.value)); });
    document.addEventListener("keydown", (e) => {
      if (!document.body.classList.contains("flip-mode")) return;
      const t = e.target.tagName;
      if (t === "INPUT" && e.target.type !== "range" || t === "SELECT" || t === "TEXTAREA") return;
      if (e.key === " " && t !== "BUTTON") { e.preventDefault(); this.timer ? this.pause() : this.play(); }
      else if (e.key === "ArrowRight" && t !== "INPUT") { this.pause(); this.go(this.at + 1); }
      else if (e.key === "ArrowLeft" && t !== "INPUT") { this.pause(); this.go(this.at - 1); }
    });
  }
}
