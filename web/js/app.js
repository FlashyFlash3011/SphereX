import * as api from "./api.js";
import { Flipbook, wavelengthColour } from "./flipbook.js";
import { Timeline } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EXAMPLES = ["Barnard's Star", "Epsilon Indi B", "WISE 0855-0714", "RW Aurigae", "R Draconis"];
const SIZE = 64;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const book = new Flipbook($("view"));
const timeline = new Timeline($("ticks"), $("scrub"), (i) => { pause(); show(i); });

// Everything about the current search lives here; a new search replaces it.
let run = null;
let timer = null;

function setStatus(text) { $("status").textContent = text; }

function setHint(text, bad) {
  $("hint").textContent = text;
  $("hint").classList.toggle("bad", !!bad);
}

// ---- search ----------------------------------------------------------------------
for (const name of EXAMPLES) {
  const li = document.createElement("li"), b = document.createElement("button");
  b.type = "button";
  b.textContent = name;
  b.addEventListener("click", () => { $("q").value = name; search(name); });
  li.append(b);
  $("examples").append(li);
}

$("search").addEventListener("submit", (e) => { e.preventDefault(); search($("q").value); });

async function search(raw) {
  const text = raw.trim().slice(0, 64);
  if (!text) { setHint("Type a name or a position first.", true); return; }
  pause();
  const mine = (run = { id: null, frames: new Map(), loaded: [], total: 0, at: -1, cancelled: false });
  const button = $("search").querySelector("button[type=submit]");
  button.disabled = true;
  setHint("A name we know, or RA and Dec in degrees.");
  setStatus("Finding this place…");
  try {
    const place = await api.resolve(text);
    if (run !== mine) return;
    setStatus("Finding observations…");
    const stack = await api.startStack(place.ra, place.dec, SIZE);
    if (run !== mine) return;
    history.replaceState(null, "", "#q=" + encodeURIComponent(text));
    begin(mine, place, stack);
    button.disabled = false;
    await follow(mine);
  } catch (err) {
    if (run === mine) { setHint(err.message, true); setStatus(""); }
  } finally {
    button.disabled = false;
  }
}

function begin(r, place, stack) {
  r.id = stack.id;
  r.n = stack.n;
  r.total = stack.total;
  r.exposures = stack.exposures;
  r.passes = new Set(stack.exposures.map((e) => e.pass)).size;
  const where = `${place.ra.toFixed(4)}°, ${place.dec >= 0 ? "+" : "−"}${Math.abs(place.dec).toFixed(4)}°`;
  $("place").textContent = place.name ? `${place.name}, at ${where}` : where;
  $("empty").hidden = true;
  $("examples").hidden = true;
  $("compass").hidden = stack.total === 0;
  $("entry").hidden = stack.total === 0;
  $("bar").hidden = stack.total === 0;
  if (stack.total === 0) {
    $("empty").hidden = false;
    $("examples").hidden = false;
    setStatus("SPHEREx has no images of this place yet. Try another one.");
    return;
  }
  if (!book.ok) {
    setStatus("This browser can't draw the images (it needs WebGL 2). Try a current Chrome, Firefox or Safari.");
    return;
  }
  book.reset(r.n, r.total);
  timeline.setExposures(r.exposures);
}

// Keep asking the server for newly finished frames until the stack is complete.
async function follow(r) {
  if (!r.total || !book.ok) return;
  let after = 0, autoStarted = false;
  for (;;) {
    const st = await api.stackStatus(r.id, after);
    if (run !== r) return;
    after = st.next;
    if (st.frames.length) {
      const pixels = await api.framePixels(r.id, st.frames.map((f) => f.i), r.n);
      if (run !== r) return;
      st.frames.forEach((f, k) => {
        book.addFrame(f.i, pixels[k]);
        r.frames.set(f.i, f);
        timeline.markLoaded(f.i, f.lam_um);
      });
      r.loaded = [...r.frames.keys()].sort((a, b) => a - b);
      if (r.at < 0) show(r.loaded[0]);
      if (!autoStarted && !reducedMotion && r.loaded.length >= 8) { autoStarted = true; play(); }
    }
    const lost = st.missing.length;
    if (st.done) {
      const got = r.loaded.length;
      setStatus(got === 0 ? "None of the images could be loaded. NASA's archive may be busy; search again in a minute."
        : `${got} images` + (lost ? `, ${lost} could not be loaded` : "") + (r.passes > 1 ? `, from ${r.passes} visits` : ", from 1 visit"));
      return;
    }
    setStatus(`Loading images, ${st.ready} of ${st.total}`);
    await new Promise((res) => setTimeout(res, st.frames.length ? 250 : 700));
  }
}

// ---- showing a frame ---------------------------------------------------------------
function nearestLoaded(i) {
  const L = run.loaded;
  let best = L[0];
  for (const k of L) if (Math.abs(k - i) < Math.abs(best - i)) best = k;
  return best;
}

function show(i) {
  if (!run || !run.loaded.length) return;
  if (!run.frames.has(i)) i = nearestLoaded(i);
  const f = run.frames.get(i);
  run.at = i;
  book.show(i, f.cuts, f.lam_um);
  const date = `${Number(f.utc.slice(8, 10))} ${MONTHS[Number(f.utc.slice(5, 7)) - 1]} ${f.utc.slice(0, 4)}`;
  $("date").textContent = date;
  $("time").textContent = `${f.utc.slice(11, 16)} UTC`;
  $("colour").textContent = `${f.lam_um.toFixed(2)} µm infrared`;
  $("swatch").style.background = `rgb(${wavelengthColour(f.lam_um).join(" ")})`;
  $("detector").textContent = `${f.det} of 6`;
  $("visit").textContent = `${f.pass + 1} of ${run.passes}`;
  $("frame").textContent = `${i + 1} of ${run.total}`;
  const link = $("source");
  if (f.access_url.startsWith("https://irsa.ipac.caltech.edu/")) link.href = f.access_url; else link.removeAttribute("href");
  timeline.setCurrent(i, `Image ${i + 1} of ${run.total}, ${date}, ${f.lam_um.toFixed(2)} microns`);
}

function step(dir) {
  if (!run || !run.loaded.length) return;
  const L = run.loaded, k = L.indexOf(run.at);
  show(L[(k + dir + L.length) % L.length]);
}

// ---- playing -----------------------------------------------------------------------
function play() {
  if (timer || !run || run.loaded.length < 2) return;
  $("play").setAttribute("aria-pressed", "true");
  $("play").setAttribute("aria-label", "Pause");
  let last = performance.now();
  const tick = (now) => {
    const interval = 1000 / Number($("fps").value);
    if (now - last >= interval) { last = now; step(1); }
    timer = requestAnimationFrame(tick);
  };
  timer = requestAnimationFrame(tick);
}

function pause() {
  if (timer) cancelAnimationFrame(timer);
  timer = null;
  $("play").setAttribute("aria-pressed", "false");
  $("play").setAttribute("aria-label", "Play");
}

$("play").addEventListener("click", () => (timer ? pause() : play()));
$("prev").addEventListener("click", () => { pause(); step(-1); });
$("next").addEventListener("click", () => { pause(); step(1); });

document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" && e.target.type !== "range" || tag === "SELECT" || tag === "BUTTON" && e.key === " ") return;
  if (e.key === " ") { e.preventDefault(); timer ? pause() : play(); }
  else if (e.key === "ArrowLeft" && tag !== "INPUT") { pause(); step(-1); }
  else if (e.key === "ArrowRight" && tag !== "INPUT") { pause(); step(1); }
  else if (e.key === "/") { e.preventDefault(); $("q").focus(); }
});

// ---- a shared link reopens the same search -------------------------------------------
function fromHash() {
  const q = new URLSearchParams(location.hash.slice(1)).get("q");
  if (q && q.length <= 64) { $("q").value = q; search(q); }
}
window.addEventListener("hashchange", fromHash);
fromHash();
