// Main screen: the interactive sky (Aladin Lite) with the search panel on top.
import { API } from "./config.js";
import A from "../vendor/aladin-lite-3.8.2/aladin.js";
import { angleText, decText, degText, raText, wavelengthColour } from "./format.js";
import { Results } from "./results.js";
import { Flip } from "./flip.js";

const flip = new Flip();

const $ = (id) => document.getElementById(id);

const BACKGROUNDS = {
  spherex: { url: "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube",
             credit: "SPHEREx DR1 all-sky map, NASA/IPAC IRSA" },
  "2mass": { url: "https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color",
             credit: "2MASS near-infrared colour, via NASA/IPAC IRSA" },
  dss: { url: "https://skies.esac.esa.int/DSSColor",
         credit: "Digitized Sky Survey colour, via ESA ESASky" },
};
const DETECTORS = [[1, 0.75, 1.09], [2, 1.10, 1.62], [3, 1.63, 2.41], [4, 2.42, 3.82], [5, 3.83, 4.41], [6, 4.42, 5.00]];
const EXAMPLES = ["Barnard's Star", "Epsilon Indi B", "WISE 0855-0714", "RW Aurigae", "R Draconis", "269.45 4.77"];
const PIXEL_ARCSEC = 6.15;
const BLANK_PLANES = new Set([51, 52]);

// Wavelength of each of the 102 planes. Read from the map's own description; this list is the fallback.
let planes = Array.from({ length: 102 }, (_, i) => 0.75 * Math.pow(5.0 / 0.75, i / 101));
let plane = 2;   // plane 1 is stored under a file name Aladin can't request
let aladin = null;
let spherexLayer = null;
let markers = null;
let outline = null;
let chosen = null;      // { ra, dec, name }
let size = 64;
let results = null;
let fromClickText = null;

// ---- the sky ------------------------------------------------------------------------
async function startSky() {
  try {
    await A.init;
  } catch {
    $("sky-error").textContent = "This browser can't show the interactive sky (it needs WebGL 2). Try a current version of Chrome, Firefox or Safari.";
    $("sky-error").hidden = false;
    return;
  }
  aladin = A.aladin("#sky", {
    survey: BACKGROUNDS.spherex.url,
    projection: "SIN",
    fov: 180,
    target: "266.4 -29.0",          // the centre of the Milky Way: a bright first view
    cooFrame: "ICRS",
    showReticle: false,
    showZoomControl: false,
    showLayersControl: false,
    showFullscreenControl: false,
    showProjectionControl: false,
    showFrame: false,
    showCooLocation: false,
    showFov: false,
    showStatusBar: false,
    showSimbadPointerControl: false,
    showCooGridControl: false,
    showSettingsControl: false,
    showShareControl: false,
    showContextMenu: false,
    backgroundColor: "rgb(5, 7, 11)",
    log: false,                      // no usage ping to CDS
  });
  // Aladin creates the map layer a moment after start-up; wait for it (needed to change colour plane).
  for (let i = 0; i < 100 && !aladin.getBaseImageLayer(); i++) await new Promise((r) => setTimeout(r, 50));
  spherexLayer = aladin.getBaseImageLayer();
  markers = A.catalog({ name: "Search position", shape: "cross", color: "#FFB547", sourceSize: 22 });
  outline = A.graphicOverlay({ color: "#FFB547", lineWidth: 1.5 });
  results = new Results(A, aladin);
  aladin.addCatalog(markers);
  aladin.addOverlay(outline);

  aladin.on("mouseMove", (e) => {
    const p = skyPoint(e);
    $("cursor").textContent = p ? `${raText(p.ra)}  ${decText(p.dec)}   (${degText(p.ra, p.dec)})` : "Move over the sky";
  });
  aladin.on("click", (e) => {
    if ((e && e.isDragging) || document.body.classList.contains("results-mode")) return;
    const p = skyPoint(e);
    if (p) choose(p.ra, p.dec, null, true);
  });
  aladin.on("zoomChanged", showFov);
  showFov();
  setPlane(plane);
}

function skyPoint(e) {
  if (!e) return null;
  let ra = e.ra, dec = e.dec;
  if ((ra === undefined || dec === undefined) && e.x !== undefined) {
    const w = aladin.pix2world(e.x, e.y);
    if (w) [ra, dec] = w;
  }
  return Number.isFinite(ra) && Number.isFinite(dec) ? { ra: ((ra % 360) + 360) % 360, dec } : null;
}

function showFov() {
  if (!aladin) return;
  const [w, h] = aladin.getFov();
  $("fov").textContent = `${angleText(w)} × ${angleText(h)}`;
}

async function loadPlaneWavelengths() {
  try {
    const text = await (await fetch(BACKGROUNDS.spherex.url + "/properties")).text();
    const m = text.match(/^data_cube_crval3_arr\s*=\s*(.+)$/m);
    const list = m ? m[1].trim().split(/\s+/).map(Number) : [];
    if (list.length === 102 && list.every(Number.isFinite)) planes = list;
  } catch { /* keep the fallback list */ }
  setPlane(plane);
}

function setPlane(n) {
  plane = Math.min(Math.max(Math.round(n) || 2, 2), 102);
  const um = planes[plane - 1];
  $("plane-um").textContent = `${um.toFixed(3)} µm`;
  $("plane-swatch").style.background = wavelengthColour(um);
  $("plane-num").value = String(plane);
  $("plane-slider").value = String(plane);
  // IRSA's map has no data for the two colours where the camera's light splitter divides the light.
  $("plane-gap").hidden = !BLANK_PLANES.has(plane);
  applyPlane();
}

// Aladin ignores a plane change until the map layer is attached, so wait for that.
let planeTimer = null;
function applyPlane(tries = 0) {
  clearTimeout(planeTimer);
  if (!spherexLayer || !spherexLayer.setSliceNumber) return;
  if (!spherexLayer.added && tries < 50) { planeTimer = setTimeout(() => applyPlane(tries + 1), 100); return; }
  spherexLayer.setSliceNumber(sliceFor(plane));
}

// Aladin turns its "slice" number into a file number through frequency, not linearly:
// file = floor(depth * (f - fMin) / (fMax - fMin)), with f = 1 / (emMin + slice / depth * (emMax - emMin)).
// Measured on 14 Nov (slice 1 -> file 95, 50 -> 13, 100 -> 0). IRSA stores plane n as file n - 1,
// so invert the formula to ask for exactly the plane we want (aiming at the middle of the file's range).
function sliceFor(planeNumber) {
  const L = spherexLayer, depth = L.cubeDepth || 102;
  const fMin = 1 / L.emMax, fMax = 1 / L.emMin;
  const f = fMin + ((planeNumber - 1 + 0.5) / depth) * (fMax - fMin);
  return ((1 / f - L.emMin) / (L.emMax - L.emMin)) * depth;
}

$("plane-prev").addEventListener("click", () => setPlane(plane - 1));
$("plane-next").addEventListener("click", () => setPlane(plane + 1));
$("plane-slider").addEventListener("input", (e) => setPlane(Number(e.target.value)));
$("plane-num").addEventListener("change", (e) => setPlane(Number(e.target.value)));

$("background").addEventListener("change", (e) => {
  const key = e.target.value in BACKGROUNDS ? e.target.value : "spherex";
  $("credit").textContent = BACKGROUNDS[key].credit;
  $("plane").classList.toggle("off", key !== "spherex");
  if (!aladin) return;
  if (key === "spherex") {
    aladin.setBaseImageLayer(spherexLayer);
    setPlane(plane);
  } else {
    aladin.setBaseImageLayer(aladin.newImageSurvey(BACKGROUNDS[key].url));
  }
});

for (const [id, proj, other] of [["proj-globe", "SIN", "proj-flat"], ["proj-flat", "AIT", "proj-globe"]]) {
  $(id).addEventListener("click", () => {
    $(id).setAttribute("aria-pressed", "true");
    $(other).setAttribute("aria-pressed", "false");
    if (aladin) aladin.setProjection(proj);
  });
}

$("zoom-in").addEventListener("click", () => aladin && aladin.setFoV(aladin.getFov()[0] / 2));
$("zoom-out").addEventListener("click", () => aladin && aladin.setFoV(Math.min(aladin.getFov()[0] * 2, 360)));

// ---- choosing a place -----------------------------------------------------------------
function patchDegrees() { return (size * PIXEL_ARCSEC) / 3600; }

function drawChoice() {
  if (!aladin || !chosen) return;
  markers.removeAll();
  outline.removeAll();
  markers.addSources([A.source(chosen.ra, chosen.dec, { name: chosen.name || "Search position" })]);
  const h = patchDegrees() / 2, c = Math.cos((chosen.dec * Math.PI) / 180) || 1e-6;
  const r = chosen.ra, d = chosen.dec;
  outline.add(A.polygon([[r - h / c, d - h], [r + h / c, d - h], [r + h / c, d + h], [r - h / c, d + h]]));
}

function choose(ra, dec, name, fromClick) {
  chosen = { ra, dec, name };
  if (fromClick) {
    $("q").value = `${ra.toFixed(4)} ${dec >= 0 ? "+" : ""}${dec.toFixed(4)}`;
    fromClickText = $("q").value;
  }
  echo(`${name ? name + ": " : ""}${raText(ra)} ${decText(dec)}  (${degText(ra, dec)})`, "ok");
  drawChoice();
}

function echo(text, kind) {
  $("q-echo").textContent = text;
  $("q-echo").className = "echo" + (kind ? " " + kind : "");
}

// Light check while typing; the server makes the final decision.
function looksLikeCoordinates(text) {
  const m = text.trim().match(/^([+-]?\d+(?:\.\d+)?)[\s,]+([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const ra = Number(m[1]), dec = Number(m[2]);
  return ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? { ra, dec } : "bad";
}

$("q").addEventListener("input", () => {
  const t = $("q").value;
  const c = looksLikeCoordinates(t);
  if (!t.trim()) echo("Or click anywhere on the sky.");
  else if (c === "bad") echo("RA goes from 0 to 360 and Dec from −90 to +90 degrees.", "bad");
  else if (c) echo(`${raText(c.ra)} ${decText(c.dec)}  (${degText(c.ra, c.dec)})`, "ok");
  else echo("Press Search to look up this name.");
});

for (const name of EXAMPLES) {
  const li = document.createElement("li"), b = document.createElement("button");
  b.type = "button";
  b.textContent = name;
  b.addEventListener("click", () => { $("q").value = name; search(); });
  li.append(b);
  $("examples").append(li);
}

// ---- search options --------------------------------------------------------------------
for (const [n, lo, hi] of DETECTORS) {
  const label = document.createElement("label"), box = document.createElement("input");
  label.className = "detector";
  box.type = "checkbox";
  box.checked = true;
  box.value = String(n);
  box.addEventListener("change", summariseColours);
  const sw = document.createElement("span"), name = document.createElement("span"), range = document.createElement("span");
  sw.className = "swatch";
  sw.style.background = wavelengthColour((lo + hi) / 2);
  name.textContent = `Detector ${n}`;
  range.className = "range";
  range.textContent = `${lo.toFixed(2)}–${hi.toFixed(2)} µm`;
  label.append(box, sw, name, range);
  $("detectors").append(label);
}

function summariseColours() {
  const on = [...$("detectors").querySelectorAll("input")].filter((b) => b.checked).map((b) => b.value);
  $("colour-value").textContent = on.length === 6 ? "All 6 detectors" : on.length ? `Detectors ${on.join(", ")}` : "None selected";
}

function summariseWhen() {
  const f = $("when-from").value, t = $("when-to").value;
  $("when-value").textContent = f || t ? `${f || "start"} to ${t || "today"}` : "Any date";
}
$("when-from").addEventListener("change", summariseWhen);
$("when-to").addEventListener("change", summariseWhen);

for (const b of $("size").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    size = Number(b.dataset.size);
    for (const o of $("size").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
    drawChoice();
  });
}

$("search-collapse").addEventListener("click", () => {
  const collapsed = $("search-panel").classList.toggle("collapsed");
  $("search-collapse").setAttribute("aria-expanded", String(!collapsed));
  $("search-collapse").setAttribute("aria-label", collapsed ? "Show search" : "Hide search");
});

// ---- search ------------------------------------------------------------------------------
async function resolve(text) {
  let resp;
  try {
    resp = await fetch(`${API}/api/resolve?name=${encodeURIComponent(text)}`);
  } catch {
    throw new Error("Can't reach the SphereX server. Check your connection and try again.");
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(typeof body.detail === "string" ? body.detail : "That search didn't work. Try again.");
  return body;
}

async function getJson(url) {
  let resp;
  try {
    resp = await fetch(url);
  } catch {
    throw new Error("Can't reach the SphereX server. Check your connection and try again.");
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(typeof body.detail === "string" ? body.detail : "That didn't work. Try again.");
  return body;
}

function filters() {
  const dets = [...$("detectors").querySelectorAll("input")].filter((b) => b.checked).map((b) => b.value);
  const q = new URLSearchParams({ ra: chosen.ra.toFixed(6), dec: chosen.dec.toFixed(6), dets: dets.join(",") });
  if ($("when-from").value) q.set("from", $("when-from").value);
  if ($("when-to").value) q.set("to", $("when-to").value);
  return { q, dets };
}

async function search() {
  const text = $("q").value.trim().slice(0, 64);
  const note = $("search-note");
  note.className = "search-note";
  if (!text && !chosen) { note.textContent = "Type a name or coordinates, or click the sky."; note.classList.add("bad"); return; }
  $("search-go").disabled = true;
  note.textContent = "Looking up…";
  try {
    if (text && !(chosen && fromClickText === text)) {
      const place = await resolve(text);
      choose(place.ra, place.dec, place.name, false);
    }
    const { q, dets } = filters();
    if (!dets.length) throw new Error("Choose at least one detector under Colours.");
    note.textContent = "Asking NASA's archive for every photo of this spot… (if the server was asleep, the first search can take about a minute)";
    const data = await getJson(`${API}/api/search?${q}`);
    note.textContent = "";
    openResults(data);
  } catch (err) {
    note.textContent = err.message;
    note.classList.add("bad");
  } finally {
    $("search-go").disabled = false;
  }
}

function openResults(data) {
  results.show(data, chosen);
  showSubview("coverage");
  if (data.total) flip.open({ ...chosen }, size);   // start cutting out photos now, so the flipbook is ready
  $("tab-results").disabled = false;
  $("tab-results").removeAttribute("title");
  showView("results");
  if (aladin) {
    aladin.animateToRaDec(chosen.ra, chosen.dec, 1.2);
    aladin.zoomToFoV(14, 1.2);   // the photos are 3.5° wide and scattered around the spot
  }
}

function showSubview(which) {
  const fb = which === "flipbook";
  document.body.classList.toggle("flip-mode", fb && document.body.classList.contains("results-mode"));
  $("flip-stage").hidden = !fb;
  $("flip-settings").hidden = !fb;
  for (const [id, on] of [["view-coverage", !fb], ["view-flipbook", fb]]) {
    $(id).setAttribute("aria-pressed", String(on));
    $(id).setAttribute("aria-selected", String(on));
  }
  if (!fb) flip.pause();
}
$("view-coverage").addEventListener("click", () => showSubview("coverage"));
$("view-flipbook").addEventListener("click", () => showSubview("flipbook"));

function showView(view) {
  const res = view === "results";
  const flipChosen = $("view-flipbook").getAttribute("aria-pressed") === "true";
  // Everything that belongs to Results must be hidden on the Sky tab, including the flipbook picture.
  document.body.classList.toggle("flip-mode", res && flipChosen);
  $("flip-stage").hidden = !(res && flipChosen);
  $("flip-settings").hidden = !(res && flipChosen);
  if (!res) flip.pause();
  document.body.classList.toggle("results-mode", res);
  $("results").hidden = !res;
  $("legend").hidden = !res;
  $("tab-sky").toggleAttribute("aria-current", !res);
  $("tab-results").toggleAttribute("aria-current", res);
  if (res) $("tab-results").setAttribute("aria-current", "page"); else $("tab-sky").setAttribute("aria-current", "page");
}

$("tab-sky").addEventListener("click", () => showView("sky"));
$("tab-results").addEventListener("click", () => { if (!$("tab-results").disabled) showView("results"); });

$("search").addEventListener("submit", (e) => { e.preventDefault(); search(); });

// ---- about ---------------------------------------------------------------------------------
$("about-open").addEventListener("click", () => $("about").showModal());

// For debugging in the browser console.
window.sphereX = { get aladin() { return aladin; }, get layer() { return spherexLayer; } };

// Wake the server as soon as the page opens: the free server sleeps when idle and takes about a minute to start.
fetch(`${API}/health`).catch(() => {});

startSky().then(loadPlaneWavelengths);
