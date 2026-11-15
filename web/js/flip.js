// The Flipbook tab: SPHEREx cut-outs of the chosen spot, grouped by visit, added up in one colour
// band, and looped like WiseView. Cut-outs stream in from the server; frames sharpen as they arrive.
import { API } from "./config.js";
import { Flipbook, NO_DATA } from "./flipbook.js";
import { interpretMove, interpretSpot } from "./interpret.js";

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

// The spread between photos is a good noise estimate only with enough photos: with 3 it can come out far too
// small by chance (measured 15 Nov: WISE 0855's 3-photo visit gave 19 false changes).
const MIN_PHOTOS_FOR_SPREAD = 5;
const MIN_VISIT_PHOTOS = 8;   // fewer photos in the chosen band: the visit is left out of comparisons

// One visit, added up: the mean image, and how uncertain each pixel of that mean is.
// With 5 or more photos, the uncertainty comes from how much the photos disagree (measured, not assumed);
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
    if (n >= MIN_PHOTOS_FOR_SPREAD) {
      const variance = Math.max((sq[k] - (sum[k] * sum[k]) / n) / (n - 1), 0);
      err[k] = Math.max(Math.sqrt(variance / n), 0.5 * floor);
    } else {
      err[k] = floor;   // too few photos to trust their spread: use the noise measured across the image
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
function findChanges(S, n, thr, minSupport = 1) {
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
      if (peak && support >= minSupport) out.push({ x, y, s: v });
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

// What the rings likely mean: a dimmer spot with a brighter spot right next to it is one thing that moved
// (from the fainter spot to the brighter one). Anything left is "brighter or new" / "fainter or gone".
const MOVE_PAIR_PX = 4.5;
function interpret(changes) {
  const faded = changes.filter((c) => c.s < 0), brightened = changes.filter((c) => c.s > 0), used = new Set(), moves = [];
  for (const b of [...faded].sort((p, q) => Math.abs(q.s) - Math.abs(p.s))) {
    let best = null, bestD = MOVE_PAIR_PX ** 2;
    for (const o of brightened) {
      const d = (o.x - b.x) ** 2 + (o.y - b.y) ** 2;
      if (!used.has(o) && d <= bestD) { best = o; bestD = d; }
    }
    if (best) { used.add(best); used.add(b); moves.push({ from: b, to: best }); }
  }
  return { moves, brighter: brightened.filter((o) => !used.has(o)), fainter: faded.filter((b) => !used.has(b)) };
}

function describe(found) {
  const parts = [];
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  if (found.moves.length) parts.push(n(found.moves.length, "thing moved", "things moved"));
  if (found.brighter.length) parts.push(`${found.brighter.length} got brighter or appeared`);
  if (found.fainter.length) parts.push(`${found.fainter.length} got fainter or disappeared`);
  return parts.length ? parts.join(", ") : "no clear changes";
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
    this.ghost = "off";
    this.ghostStyle = "colour";
    this.ghostAlpha = 0.7;
    this.ghostMarks = true;
    this.size = 64;
    this.place = null;
    this.spot = null;          // the spot measured by the Spectrum tab (image pixels); null = centre
    this.onUpdate = null;      // called after the frames are rebuilt
    this.onSpot = null;        // called when the visitor clicks the image to choose a spot
    this.bindSettings();
    this.overlay.addEventListener("click", (e) => this.pickSpot(e));
    new ResizeObserver(() => this.drawMarker()).observe(this.overlay);
  }

  // ---- loading ----------------------------------------------------------------------
  async open(place, size) {
    this.place = place;
    this.size = size;
    for (const b of $("flip-size").querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.size) === size));
    this.pause();
    this.spot = null;
    const run = (this.run = { id: null, n: size, exposures: [], meta: new Map(), px: new Map(), missing: [], done: false });
    this.views = [];
    this.at = 0;
    this.render();
    this.status("Starting… the server cuts your patch out of every SPHEREx photo of this spot.");
    if (!this.book.ok) { this.empty("This browser can't draw the images (it needs WebGL 2). Try a current Chrome, Firefox or Safari."); return; }
    if (place.prepared && size === place.prepared.size && await this.openPrepared(run, place.prepared)) return;
    try {
      const q = new URLSearchParams({ ra: place.ra.toFixed(6), dec: place.dec.toFixed(6), size: String(size),
                                      first: String(this.band.kind === "all" ? 0 : this.band.kind === "det" ? this.band.det : Math.floor(this.band.ch / 17) + 1) });
      const s = await getJson(`${API}/api/stacks?${q}`, { method: "POST" });
      if (this.run !== run) return;
      run.id = s.id;
      run.exposures = s.exposures;
      this.loadGaia(run, place, size);
      run.total = s.total;
      this.fillBands();
      if (!s.total) { this.empty("SPHEREx has no photos of this spot yet."); this.status(""); return; }
      await this.follow(run);
    } catch (err) {
      if (this.run === run) { this.status(err.message); this.empty(err.message); }
    }
  }

  // A target prepared in advance: everything comes from files in the website, nothing from the server.
  async openPrepared(run, t) {
    try {
      const base = `data/${t.slug}/`;
      const [st, bin, g] = await Promise.all([
        fetch(base + "stack.json").then((r) => { if (!r.ok) throw new Error(); return r.json(); }),
        fetch(base + "frames.bin").then((r) => { if (!r.ok) throw new Error(); return r.arrayBuffer(); }),
        fetch(base + "gaia.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (this.run !== run) return true;
      const n = st.summary.n, n2 = n * n;
      if (bin.byteLength !== st.frames.length * n2 * 2) throw new Error("incomplete");
      run.id = `prepared:${t.slug}`;
      run.n = n;
      run.exposures = st.summary.exposures;
      run.total = st.summary.total;
      run.missing = st.missing || [];
      st.frames.forEach((f, k) => { run.meta.set(f.i, f); run.px.set(f.i, decode(new Uint16Array(bin, k * n2 * 2, n2))); });
      run.gaia = g ? g.stars : null;
      run.gaiaState = g ? "ok" : "failed";
      run.done = true;
      this.fillBands();
      this.rebuild();
      this.status(`Prepared in advance: ${st.frames.length} photos, snapshot of ${t.built_utc.slice(0, 10)}. Search the coordinates for the newest photos.`);
      return true;
    } catch {
      return false;   // fall back to the live server
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

  async loadGaia(run, place, size) {
    run.gaia = null;
    run.gaiaState = "loading";
    const radius = Math.min(0.3, ((size * 6.15) / 3600) * 0.75 + 0.01);   // covers the patch corners
    try {
      const g = await getJson(`${API}/api/gaia?ra=${place.ra.toFixed(6)}&dec=${place.dec.toFixed(6)}&radius=${radius.toFixed(3)}`);
      if (this.run !== run) return;
      run.gaia = g.stars;
      run.gaiaState = "ok";
    } catch {
      if (this.run === run) run.gaiaState = "failed";
    }
    if (this.run === run) { for (const v of this.views) v.cards = null; this.renderChanges(); }
  }

  scheduleRebuild() {
    if (this._rebuildTimer) return;
    this._rebuildTimer = setTimeout(() => { this._rebuildTimer = null; this.rebuild(); }, 350);
  }

  // ---- building the frames ------------------------------------------------------------
  inBand(f) {
    if (this.band.kind === "all") return true;
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
          label: `Visit ${g.v + 1}`, small: g.range, data: g.stats.mean, group: g,
        }));
      } else {
        // A visit with very few photos in this band can't be compared reliably (it makes false changes in every
        // detector at once). Use only visits with enough photos; say which ones were left out.
        const usable = groups.filter((g) => g.list.length >= MIN_VISIT_PHOTOS);
        this.smallVisits = groups.filter((g) => g.list.length < MIN_VISIT_PHOTOS);
        for (let k = 1; k < usable.length; k++) {
          const ref = this.compare === "first" ? usable[0] : usable[k - 1], now = usable[k];
          const cmp = this.compareGroups(ref, now);
          if (!cmp) {
            views.push({ title: `${now.range} vs ${ref.range}`, label: `Visit ${now.v + 1} vs ${ref.v + 1}`, small: now.range,
                         sub: `Visit ${now.v + 1} and visit ${ref.v + 1} share no colours in this band, so they can't be compared fairly.`,
                         data: new Float32Array(n2).fill(NO_DATA), base: now.stats.mean, changes: [] });
            continue;
          }
          const { S, changes, found, inputs, shared } = cmp, B = inputs.B;
          views.push({
            title: `${now.range} vs ${ref.range}`,
            sub: `Visit ${now.v + 1} compared with visit ${ref.v + 1} (the ${shared.size} colour${shared.size === 1 ? "" : "s"} both share): ${describe(found)}`
              + (this.smallVisits.length ? `. Left out: visit ${this.smallVisits.map((g) => g.v + 1).join(", ")} (too few photos in this band)` : ""),
            found,
            label: `Visit ${now.v + 1} vs ${ref.v + 1}`, small: now.range,
            data: S, base: B.mean, ref: inputs.A.mean, changes, inputs,
          });
        }
        this.noCompare = usable.length < 2;
      }
    } else if (this.compare === "off") {
      views = members.map((f, k) => ({
        title: dayText(f.utc),
        sub: `Photo ${k + 1} of ${members.length}, ${f.lam_um.toFixed(3)} µm, visit ${f.pass + 1}, ${f.utc.slice(11, 16)} UTC`,
        label: dayText(f.utc), small: `${f.lam_um.toFixed(2)} µm`,
        data: run.px.get(f.i), channel: f.channel,
      }));
    } else {
      // Each single photo against the earlier visit's photos in exactly the same colour.
      const visits = [...new Set(members.map((f) => f.pass))].sort((a, b) => a - b);
      const refStats = new Map();   // "visit:channel" → stats of that visit's photos in that colour
      let skipped = 0;
      for (const f of members) {
        const at = visits.indexOf(f.pass);
        if (at === 0) continue;   // the first visit is what the others are compared with
        const refVisit = this.compare === "first" ? visits[0] : visits[at - 1];
        const key = `${refVisit}:${f.channel}`;
        if (!refStats.has(key)) {
          const same = members.filter((g) => g.pass === refVisit && g.channel === f.channel);
          refStats.set(key, same.length ? visitStats(same.map((g) => run.px.get(g.i)), n2) : null);
        }
        const A = refStats.get(key);
        if (!A) { skipped++; continue; }
        const px = run.px.get(f.i), noise = imageNoise(px);
        const B = { mean: px, err: px.map((v) => (hasData(v) ? noise : NO_DATA)) };
        // A single photo is noisy and can hold cosmic-ray hits (usually one pixel): require a change to cover
        // at least 3 neighbouring pixels, as starlight always does.
        const S = significance(A, B, n2), changes = findChanges(S, run.n, this.thr, 2), found = interpret(changes);
        views.push({
          title: dayText(f.utc),
          sub: `Photo at ${f.lam_um.toFixed(3)} µm (visit ${f.pass + 1}) compared with visit ${refVisit + 1} in the same colour: ${describe(found)}`,
          label: dayText(f.utc), small: `${f.lam_um.toFixed(2)} µm`,
          data: S, base: px, ref: A.mean, changes, found,
        });
      }
      this.noCompare = visits.length < 2;
      this.skippedPhotos = skipped;
    }
    this.views = views;
    if (this.at >= views.length) this.at = 0;
    const diff = views.length > 0 && !!views[0].base;
    // In compare mode the texture holds the change maps first, then the plain image under each one.
    this.book.setFrames(run.n, diff
      ? [...views.map((v) => v.data), ...views.map((v) => v.base), ...views.map((v) => v.ref || v.base)]
      : views.map((v) => v.data));
    this.book.set({ diff, thr: this.thr });
    $("flip-legend").hidden = !diff;
    this.updateCuts();
    this.render();
    if (this.onUpdate) this.onUpdate();
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
          this.empty("Fewer than two visits have enough photos in this colour band (at least 8 each) to compare reliably. Pick a wider band, such as All colours.");
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
    const style = this.ghostStyle === "plain" ? 1 : 2;
    if (this.compare !== "off" && v.ref) {
      // Changes and ghost together: the ghost is the visit this comparison is against.
      const on = this.ghost !== "off";
      this.ghostCmp = null;
      this.book.set({ layer: this.at, base: this.views.length + this.at,
                      ghost: on ? style : 0, ghostLayer: 2 * this.views.length + this.at, ghostAlpha: this.ghostAlpha });
      if (on) $("flip-sub").textContent = `${v.sub}. Ghost: the earlier visit (faint${style === 2 ? "; red = what's new now" : ""})`;
    } else {
      const gi = this.ghostIndex();
      this.ghostCmp = gi >= 0 ? this.ghostComparison(gi) : null;
      this.book.set({ layer: this.at, base: this.views.length + this.at,
                      ghost: gi >= 0 ? style : 0, ghostLayer: Math.max(gi, 0), ghostAlpha: this.ghostAlpha });
      if (gi >= 0) $("flip-sub").textContent = `${v.sub}. Ghost: ${this.views[gi].label} (faint = before${style === 2 ? ", red = what's new now" : ""})`;
    }
    this.renderStrip();
    this.renderChanges();
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

  // Compare two visits fairly: only the colours (channels) both have, because a detector spans a range of
  // colours and stars differ in brightness across it (the colour trap). Returns null if they share none.
  compareGroups(ref, now) {
    const run = this.run, n2 = run.n * run.n;
    const shared = new Set(ref.list.map((f) => f.channel).filter((c) => now.list.some((f) => f.channel === c)));
    if (!shared.size) return null;
    const refList = ref.list.filter((f) => shared.has(f.channel)), nowList = now.list.filter((f) => shared.has(f.channel));
    const A = visitStats(refList.map((f) => run.px.get(f.i)), n2), B = visitStats(nowList.map((f) => run.px.get(f.i)), n2);
    const S = significance(A, B, n2);
    const changes = findChanges(S, run.n, this.thr), found = interpret(changes);
    const meanYear = (list) => 2000 + (list.reduce((t, f) => t + f.mjd, 0) / list.length - 51544.5) / 365.25;
    const inputs = { A, B, S, refList, nowList, refVisit: ref.v, nowVisit: now.v, years: [meanYear(refList), meanYear(nowList)] };
    return { S, changes, found, inputs, shared };
  }

  // ---- ghost: an earlier frame laid under the current one ---------------------------------
  ghostIndex() {
    if (this.ghost === "off" || this.views.length < 2) return -1;
    const cur = this.views[this.at];
    let cands = this.views.map((v, k) => k).filter((k) => k !== this.at);
    if (cur.channel !== undefined) cands = cands.filter((k) => this.views[k].channel === cur.channel);   // same colour only
    const earlier = cands.filter((k) => k < this.at);
    if (!earlier.length) return -1;
    return this.ghost === "first" ? earlier[0] : earlier[earlier.length - 1];
  }

  // The ghost comparison (visits only, both with enough photos), so changes can be marked on the ghost view.
  ghostComparison(gi) {
    const cur = this.views[this.at], prev = this.views[gi];
    if (!cur || !prev || !cur.group || !prev.group) return null;
    if (cur.group.list.length < MIN_VISIT_PHOTOS || prev.group.list.length < MIN_VISIT_PHOTOS) return null;
    cur.ghostCmp = cur.ghostCmp || {};
    if (!(gi in cur.ghostCmp)) cur.ghostCmp[gi] = this.compareGroups(prev.group, cur.group);
    return cur.ghostCmp[gi];
  }

  // ---- "What changed": verdicts for each change in the current comparison ---------------
  cardsFor(view) {
    if (view.cards || !view.inputs || !view.found) return view.cards;
    const run = this.run, n = run.n, n2 = n * n, { A, B, S, refVisit, nowVisit, years } = view.inputs;
    // The same comparison repeated separately in each of the 6 detectors, whatever band is on screen
    // (for "seen independently in k of n"), each on the colours both visits share in that detector.
    const perDet = [], frames = [...run.meta.values()];
    for (let d = 1; d <= 6; d++) {
      const a0 = frames.filter((f) => f.det === d && f.pass === refVisit), b0 = frames.filter((f) => f.det === d && f.pass === nowVisit);
      const shared = new Set(a0.map((f) => f.channel).filter((c) => b0.some((f) => f.channel === c)));
      const a = a0.filter((f) => shared.has(f.channel)), b = b0.filter((f) => shared.has(f.channel));
      if (a.length && b.length) {
        perDet.push({ det: d, S: significance(visitStats(a.map((f) => run.px.get(f.i)), n2), visitStats(b.map((f) => run.px.get(f.i)), n2), n2) });
      }
    }
    const all = [...run.meta.values()].map((f) => ({ img: run.px.get(f.i), lam: f.lam_um }));
    const ctx = { n, place: this.place, stars: run.gaia || [], A, B, S, years, perDet, photos: { all }, thr: this.thr };
    const f = view.found;
    view.cards = [
      ...f.moves.map((m) => interpretMove(ctx, m)),
      ...f.brighter.map((c) => interpretSpot(ctx, c)),
      ...f.fainter.map((c) => interpretSpot(ctx, c)),
    ];
    const order = { "known-mover": 0, candidate: 1, mismatch: 2, variable: 3, appeared: 4, vanished: 5, unexplained: 6, artefact: 7 };
    view.cards.sort((p, q) => order[p.kind] - order[q.kind]);
    return view.cards;
  }

  renderChanges() {
    const box = $("flip-changes"), list = $("change-list"), view = this.ghostCmp || this.views[this.at];
    const show = !!(view && view.inputs);
    box.hidden = !show;
    if (!show) return;
    const cards = this.cardsFor(view) || [];
    const gaia = this.run.gaiaState === "ok" ? `checked against ${this.run.gaia.length.toLocaleString("en-US")} Gaia stars`
      : this.run.gaiaState === "loading" ? "checking Gaia…" : "Gaia unavailable right now";
    const solid = cards.filter((c) => c.conf !== "weak").length;
    $("changes-meta").textContent = `${solid ? `${solid} clear` : "nothing clear"}, ${gaia}`;
    const key = `${this.at}:${this.ghostCmp ? "g" : "c"}:${cards.length}:${this.run.gaiaState}:${!!this.showWeak}`;
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    list.replaceChildren();
    this.selectedCard = -1;
    const strong = cards.filter((c) => c.conf !== "weak"), weak = cards.filter((c) => c.conf === "weak");
    const showWeak = this.showWeak && weak.length;
    [...strong, ...(showWeak ? weak : [])].forEach((c) => {
      const k = cards.indexOf(c);
      const li = document.createElement("li"), row = document.createElement("button");
      li.className = "change-item";
      row.type = "button";
      row.className = "change-row";
      row.setAttribute("aria-expanded", "false");
      const ring = document.createElement("span"), what = document.createElement("span"), conf = document.createElement("span");
      ring.className = `ring ${c.sign > 0 ? "up" : c.sign < 0 ? "down" : ""}`;   // movers: neutral ring
      what.className = "what";
      what.textContent = c.title;
      conf.className = "conf";
      conf.textContent = `${c.conf} evidence`;
      row.append(ring, what, conf);
      const ev = document.createElement("ul");
      ev.className = "change-evidence";
      for (const line of c.lines) { const l = document.createElement("li"); l.textContent = line; ev.append(l); }
      row.addEventListener("click", () => {
        const open = !li.classList.contains("open");
        for (const o of list.children) { o.classList.remove("open"); o.firstChild.setAttribute("aria-expanded", "false"); }
        li.classList.toggle("open", open);
        row.setAttribute("aria-expanded", String(open));
        this.selectedCard = open ? k : -1;
        this.pause();
        this.drawMarker();
      });
      li.append(row, ev);
      list.append(li);
    });
    if (weak.length) {   // weak signals stay folded into one quiet line unless asked for
      const li = document.createElement("li"), b = document.createElement("button");
      li.className = "change-item";
      b.type = "button";
      b.className = "change-row";
      const what = document.createElement("span");
      what.className = "conf";
      what.textContent = showWeak ? `Hide the ${weak.length} weak signal${weak.length === 1 ? "" : "s"}`
        : `${weak.length} weak signal${weak.length === 1 ? "" : "s"}, probably noise or glare (show)`;
      b.append(what);
      b.addEventListener("click", () => { this.showWeak = !this.showWeak; list.dataset.key = ""; this.renderChanges(); });
      li.append(b);
      list.append(li);
    }
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
    const view = this.ghostCmp || this.views[this.at];
    if (view && view.changes && this.run && (this.ghostCmp ? this.ghostMarks : true)) this.drawChanges(ctx, w, h, view.changes, view.found, !!this.ghostCmp);
    const card = view && view.cards && view.cards[this.selectedCard];
    if (card && this.run) {   // the change chosen in the list: a larger thin ring
      const n = this.run.n, zoom = this.book.state.zoom;
      const sx = (0.5 + ((card.x + 0.5) / n - 0.5) * zoom) * w, sy = (0.5 + ((1 - (card.y + 0.5) / n) - 0.5) * zoom) * h;
      ctx.strokeStyle = "#DCE3EC";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(16, (w / n) * zoom * 4.5), 0, Math.PI * 2); ctx.stroke();
    }
    if (this.spot && this.run) {   // the spot chosen for the Spectrum tab: a small square
      const n = this.run.n, zoom = this.book.state.zoom, side = Math.max(10, (w / n) * zoom * 5);
      const sx = (0.5 + ((this.spot.x + 0.5) / n - 0.5) * zoom) * w, sy = (0.5 + ((1 - (this.spot.y + 0.5) / n) - 0.5) * zoom) * h;
      ctx.strokeStyle = "#DCE3EC";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - side / 2, sy - side / 2, side, side);
    }
    if (!$("flip-marker").checked || !this.views.length) return;
    // The search position is the centre of the patch; draw an open crosshair so the star stays visible.
    const zoom = this.book.state.zoom, px = (w / (this.run ? this.run.n : 64)) * zoom;
    const gap = Math.max(10, px * 1.6), len = Math.max(10, px * 1.4);
    ctx.strokeStyle = "#C5D0DC";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(w / 2 + dx * gap, h / 2 + dy * gap);
      ctx.lineTo(w / 2 + dx * (gap + len), h / 2 + dy * (gap + len));
    }
    ctx.stroke();
  }

  // Rings around clear changes. Image row 0 is the south edge, so flip y for the screen.
  drawChanges(ctx, w, h, changes, found, ghost = false) {
    const n = this.run.n, zoom = this.book.state.zoom, px = (w / n) * zoom, r = Math.max(7, px * 2.2);
    const at = (c) => [(0.5 + ((c.x + 0.5) / n - 0.5) * zoom) * w, (0.5 + ((1 - (c.y + 0.5) / n) - 0.5) * zoom) * h];
    ctx.lineWidth = 2;
    for (const c of changes) {
      const [sx, sy] = at(c);
      if (sx < 0 || sy < 0 || sx > w || sy > h) continue;
      ctx.strokeStyle = ghost ? "#FF0000" : c.s > 0 ? "#39FF14" : "#8F008F";
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // "Moved": an arrow from where it was to where it is now.
    if (!found) return;
    ctx.strokeStyle = ctx.fillStyle = ghost ? "#FF0000" : "#DCE3EC";
    ctx.lineWidth = 2;
    for (const m of found.moves) {
      const [x1, y1] = at(m.from), [x2, y2] = at(m.to);
      const ang = Math.atan2(y2 - y1, x2 - x1), len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 2) continue;
      const pad = Math.min(r * 0.6, len / 3);
      const ax = x1 + Math.cos(ang) * pad, ay = y1 + Math.sin(ang) * pad, bx = x2 - Math.cos(ang) * pad, by = y2 - Math.sin(ang) * pad;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - 8 * Math.cos(ang - 0.45), by - 8 * Math.sin(ang - 0.45));
      ctx.lineTo(bx - 8 * Math.cos(ang + 0.45), by - 8 * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
    }
  }

  // Clicking the image chooses the spot the Spectrum tab measures (undoing zoom and the north-up flip).
  pickSpot(e) {
    if (!this.run || !this.run.n || !this.views.length) return;
    const r = this.overlay.getBoundingClientRect(), n = this.run.n, zoom = this.book.state.zoom;
    const u = 0.5 + ((e.clientX - r.left) / r.width - 0.5) / zoom, v = 0.5 + ((e.clientY - r.top) / r.height - 0.5) / zoom;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    let x = Math.round(u * n - 0.5), y = Math.round((1 - v) * n - 0.5);
    // Snap to the brightest pixel within 2 pixels, so clicking near a star measures the star.
    const view = this.views[this.at], img = view && (view.base || view.data);
    if (img) {
      let best = -Infinity, bx = x, by = y;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n || dx * dx + dy * dy > 4) continue;
        const val = img[yy * n + xx];
        if (val > -1e29 && val > best) { best = val; bx = xx; by = yy; }
      }
      x = bx; y = by;
    }
    this.spot = { x, y };
    this.drawMarker();
    if (this.onSpot) this.onSpot();
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
    sel.append(new Option(`All colours, all 6 detectors (${run.exposures.length} photos)`, "all"));
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
    sel.value = this.band.kind === "all" ? "all" : this.band.kind === "det" ? `det:${this.band.det}` : `ch:${this.band.ch}`;
    if (!sel.value && sel.options.length) { sel.selectedIndex = 0; this.readBand(); }
  }

  readBand() {
    const [kind, num] = $("flip-band").value.split(":");
    this.band = kind === "all" ? { kind: "all" } : kind === "ch" ? { kind: "ch", ch: Number(num) } : { kind: "det", det: Number(num) };
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
    for (const b of $("flip-compare").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        this.compare = b.dataset.compare;
        for (const o of $("flip-compare").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        $("thr-setting").hidden = this.compare === "off";
        this.at = 0;
        this.rebuild();
      });
    }
    for (const b of $("flip-ghost").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        this.ghost = b.dataset.ghost;
        for (const o of $("flip-ghost").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        $("ghost-options").hidden = this.ghost === "off";
        this.render();
      });
    }
    for (const b of $("flip-ghost-style").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        this.ghostStyle = b.dataset.style;
        for (const o of $("flip-ghost-style").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        this.render();
      });
    }
    $("flip-ghost-alpha").addEventListener("input", (e) => { this.ghostAlpha = Number(e.target.value); this.book.set({ ghostAlpha: this.ghostAlpha }); });
    $("flip-ghost-marks").addEventListener("change", (e) => { this.ghostMarks = e.target.checked; this.drawMarker(); });
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
