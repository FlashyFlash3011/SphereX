// The Flipbook tab: SPHEREx cut-outs of the chosen spot, grouped by visit, added up in one colour
// band, and looped like WiseView. Cut-outs stream in from the server; frames sharpen as they arrive.
import { API } from "./config.js";
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
function addUp(list, size) { return visitStats(list, size).mean; }

function median(values) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  return a[Math.floor(a.length / 2)];
}

// Typical noise of an image: robust spread of its pixels (stars barely affect it).
function imageNoise(img) {
  const v = [];
  for (let k = 0; k < img.length; k++) if (hasData(img[k])) v.push(img[k]);
  const m = median(v);
  return 1.4826 * median(v.map((x) => Math.abs(x - m))) || 1e-3;
}

// One visit, added up: the mean image, and how uncertain each pixel of that mean is.
// With 3 or more photos, the uncertainty comes from how much the photos disagree (measured, not assumed);
// that also absorbs small alignment errors, which makes the comparison cautious.
function visitStats(list, size) {
  const sum = new Float64Array(size), sq = new Float64Array(size), count = new Uint16Array(size);
  for (const a of list) for (let k = 0; k < size; k++) if (hasData(a[k])) { sum[k] += a[k]; sq[k] += a[k] * a[k]; count[k]++; }
  const mean = new Float32Array(size), err = new Float32Array(size);
  for (let k = 0; k < size; k++) mean[k] = count[k] ? sum[k] / count[k] : NO_DATA;
  const floor = imageNoise(mean);
  for (let k = 0; k < size; k++) {
    const n = count[k];
    if (!n) { err[k] = NO_DATA; continue; }
    if (n >= 3) {
      const variance = Math.max((sq[k] - (sum[k] * sum[k]) / n) / (n - 1), 0);
      err[k] = Math.max(Math.sqrt(variance / n), 0.5 * floor);
    } else {
      err[k] = floor;
    }
  }
  return { mean, err, n: list.length };
}

// How significant the change from visit A to visit B is, pixel by pixel:
// S = (B - A) / sqrt(errA² + errB² + (3% of the brighter value)²), then rescaled if the noise
// turns out larger than expected (resampling makes neighbouring pixels' noise move together).
// Stars are smaller than a SPHEREx pixel, so a star's pixel pattern depends on where it lands inside a
// pixel, which differs between visits. Pixels on a steep star edge get extra allowance: how much they would
// change if the star sat a fifth of a pixel differently. Measured on 14 Nov: this removed all 5 false alarms
// in an ordinary field while Barnard's Star's real 1-1.7 pixel motion still stood out.
const BRIGHT_STAR_ALLOWANCE = 0.03;
const PLACEMENT_ALLOWANCE_PX = 0.2;
function significance(A, B, size) {
  const n = Math.round(Math.sqrt(size)), S = new Float32Array(size), valid = [];
  const top = (k) => Math.max(hasData(A.mean[k]) ? A.mean[k] : -Infinity, hasData(B.mean[k]) ? B.mean[k] : -Infinity);
  const slope = (k, step) => {   // half the difference of the neighbours on each side, if both have data
    const p = top(k + step), q = top(k - step);
    return Number.isFinite(p) && Number.isFinite(q) ? (p - q) / 2 : 0;
  };
  for (let k = 0; k < size; k++) {
    const a = A.mean[k], b = B.mean[k];
    if (!hasData(a) || !hasData(b) || !hasData(A.err[k]) || !hasData(B.err[k])) { S[k] = NO_DATA; continue; }
    const x = k % n, y = (k - x) / n;
    const gx = x > 0 && x < n - 1 ? slope(k, 1) : 0, gy = y > 0 && y < n - 1 ? slope(k, n) : 0;
    const sys = BRIGHT_STAR_ALLOWANCE * Math.max(Math.abs(a), Math.abs(b));
    const place = PLACEMENT_ALLOWANCE_PX * Math.hypot(gx, gy);
    S[k] = (b - a) / Math.sqrt(A.err[k] ** 2 + B.err[k] ** 2 + sys * sys + place * place);
    valid.push(S[k]);
  }
  const m = median(valid), width = 1.4826 * median(valid.map((x) => Math.abs(x - m)));
  if (width > 1) for (let k = 0; k < size; k++) if (hasData(S[k])) S[k] /= width;
  return S;
}

// Clear changes: local peaks at least `thr` times the noise, backed by a neighbour (not one lone pixel).
function findChanges(S, n, thr) {
  const out = [];
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const v = S[y * n + x];
      if (!hasData(v) || Math.abs(v) < thr) continue;
      let peak = true, support = 0;
      for (let dy = -1; dy <= 1 && peak; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const w = S[(y + dy) * n + x + dx];
          if (!hasData(w)) continue;
          if (Math.sign(w) === Math.sign(v) && Math.abs(w) > Math.abs(v)) { peak = false; break; }
          if (Math.sign(w) === Math.sign(v) && Math.abs(w) >= thr / 2) support++;
        }
      }
      if (peak && support >= 1) out.push({ x, y, s: v });
    }
  }
  // One ring per change: drop peaks within 3 pixels of a stronger one of the same sign.
  out.sort((a, b) => Math.abs(b.s) - Math.abs(a.s));
  const kept = [];
  for (const c of out) {
    if (!kept.some((k) => Math.sign(k.s) === Math.sign(c.s) && (k.x - c.x) ** 2 + (k.y - c.y) ** 2 <= 9)) kept.push(c);
  }
  return kept.slice(0, 40);
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
    this.compare = "off";
    this.thr = 5;
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
      const s = await getJson(`${API}/api/stacks?${q}`, { method: "POST" });
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
      const st = await getJson(`${API}/api/stacks/${run.id}/status?after=${after}`);
      if (this.run !== run) return;
      after = st.next;
      run.missing = st.missing;
      const fresh = st.frames;
      for (let k = 0; k < fresh.length; k += 48) {
        const part = fresh.slice(k, k + 48);
        let resp;
        try { resp = await fetch(`${API}/api/stacks/${run.id}/frames?i=${part.map((f) => f.i).join(",")}`); } catch { resp = null; }
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
      const groups = [...byVisit.entries()].sort((a, b) => a[0] - b[0]).map(([v, list]) => ({
        v, list, range: rangeText(list[0].utc, list[list.length - 1].utc),
        stats: visitStats(list.map((f) => run.px.get(f.i)), n2),
      }));
      if (this.compare === "off") {
        views = groups.map((g) => ({
          title: g.range,
          sub: `Visit ${g.v + 1} of ${nVisits}, ${g.list.length} photo${g.list.length === 1 ? "" : "s"} added together`,
          label: `Visit ${g.v + 1}`, small: g.range, data: g.stats.mean,
        }));
      } else {
        for (let k = 1; k < groups.length; k++) {
          const ref = this.compare === "first" ? groups[0] : groups[k - 1], now = groups[k];
          // The colour trap: a detector spans a range of colours, and stars differ in brightness across it.
          // Compare only photos taken in colours (channels) that BOTH visits have.
          const shared = new Set(ref.list.map((f) => f.channel).filter((c) => now.list.some((f) => f.channel === c)));
          const refList = ref.list.filter((f) => shared.has(f.channel)), nowList = now.list.filter((f) => shared.has(f.channel));
          if (!shared.size) {
            views.push({ title: `${now.range} vs ${ref.range}`, label: `Visit ${now.v + 1} vs ${ref.v + 1}`, small: now.range,
                         sub: `Visit ${now.v + 1} and visit ${ref.v + 1} share no colours in this band, so they can't be compared fairly.`,
                         data: new Float32Array(n2).fill(NO_DATA), base: now.stats.mean, changes: [] });
            continue;
          }
          const A = visitStats(refList.map((f) => run.px.get(f.i)), n2), B = visitStats(nowList.map((f) => run.px.get(f.i)), n2);
          const S = significance(A, B, n2);
          const changes = findChanges(S, run.n, this.thr);
          views.push({
            title: `${now.range} vs ${ref.range}`,
            sub: `Visit ${now.v + 1} compared with visit ${ref.v + 1}, using the ${shared.size} colour${shared.size === 1 ? "" : "s"} both share: `
              + `${changes.length || "no"} clear change${changes.length === 1 ? "" : "s"} (${this.thr}× the noise or more)`,
            label: `Visit ${now.v + 1} vs ${ref.v + 1}`, small: now.range,
            data: S, base: B.mean, changes,
          });
        }
        this.noCompare = groups.length < 2;
      }
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
    const diff = views.length > 0 && !!views[0].base;
    // In compare mode the texture holds the change maps first, then the plain image under each one.
    this.book.setFrames(run.n, diff ? [...views.map((v) => v.data), ...views.map((v) => v.base)] : views.map((v) => v.data));
    this.book.set({ diff, thr: this.thr });
    $("flip-legend").hidden = !diff;
    this.updateCuts();
    this.render();
    if (!this.timer && !reducedMotion && views.length >= 2 && this._autoplay !== false) { this._autoplay = false; this.play(); }
  }

  updateCuts() {
    const vals = [];
    for (const v of this.views) { const img = v.base || v.data; for (let k = 0; k < img.length; k += 3) if (hasData(img[k])) vals.push(img[k]); }
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
      if (this.run && this.run.id) {
        if (this.compare !== "off" && this.noCompare && this.run.meta.size) {
          this.empty("Only one visit has photos in this colour band so far, so there's nothing to compare yet. Pick another band, or wait for more photos.");
        } else {
          this.empty(this.run.done ? "No photos in this colour band. Pick another band." : "Loading the first photos of this colour band…");
        }
      }
      this.renderStrip();
      return;
    }
    $("flip-empty").hidden = true;
    $("flip-title").textContent = v.title;
    $("flip-sub").textContent = v.sub;
    this.book.set({ layer: this.at, base: this.views.length + this.at });
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
    const view = this.views[this.at];
    if (view && view.changes && this.run) this.drawChanges(ctx, w, h, view.changes);
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

  // Rings around clear changes. Image row 0 is the south edge, so flip y for the screen.
  drawChanges(ctx, w, h, changes) {
    const n = this.run.n, zoom = this.book.state.zoom, px = (w / n) * zoom;
    ctx.lineWidth = 2;
    for (const c of changes) {
      const sx = (0.5 + ((c.x + 0.5) / n - 0.5) * zoom) * w;
      const sy = (0.5 + ((1 - (c.y + 0.5) / n) - 0.5) * zoom) * h;
      if (sx < 0 || sy < 0 || sx > w || sy > h) continue;
      ctx.strokeStyle = c.s > 0 ? "#FF8F29" : "#299EFF";
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(7, px * 2.2), 0, Math.PI * 2);
      ctx.stroke();
    }
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
        if (this.mode === "photos" && this.compare !== "off") $("flip-compare").querySelector('[data-compare="off"]').click();
        for (const o of $("flip-mode").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        this.at = 0;
        this.rebuild();
      });
    }
    for (const b of $("flip-compare").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        this.compare = b.dataset.compare;
        for (const o of $("flip-compare").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        $("thr-setting").hidden = this.compare === "off";
        if (this.compare !== "off" && this.mode !== "visits") {   // comparing works on whole visits
          this.mode = "visits";
          for (const o of $("flip-mode").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o.dataset.mode === "visits"));
        }
        this.at = 0;
        this.rebuild();
      });
    }
    $("flip-thr").addEventListener("input", (e) => {
      this.thr = Number(e.target.value);
      $("flip-thr-out").textContent = `${this.thr}×`;
      this.scheduleRebuild();
    });
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
