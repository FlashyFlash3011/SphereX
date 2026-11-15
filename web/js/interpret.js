// "What changed": turns each change in a visit comparison into a plain-words verdict backed by
// measurements and simple statistical tests. No AI: every number shown is computed here, from the photos
// and the Gaia catalogue, with the rules written out below.
import { measure } from "./spectrum.js";

const PX = 6.15;                    // arcseconds per pixel
const hasData = (v) => v > -1e29;
const MATCH_PX = 2.5;               // a Gaia star within this distance counts as "the same object"
const BRIGHT_G = 9;                 // Gaia G brighter than this: its halo and reflections can fake changes
const DETECTOR_HIT_S = 3;           // a change "shows up" in a detector if it reaches 3× the noise there
const DETECTOR_FALSE_RATE = 0.02;   // chance noise alone reaches that near a given spot in one detector
const LY_PER_MAS = 3261.56;         // distance in light years = 3261.56 / parallax in milliarcseconds

// ---- small statistics helpers -----------------------------------------------------------
function erfc(x) {   // complementary error function (Numerical Recipes approximation, error < 1.2e-7)
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
// Chance that pure noise produces a change this strong anywhere among `tests` pixels.
export function flukeChance(sigma, tests) { return Math.min(1, tests * 0.5 * erfc(Math.abs(sigma) / Math.SQRT2)); }

function binomTail(k, n, q) {   // P(at least k of n) when each happens with probability q
  let p = 0;
  for (let i = k; i <= n; i++) {
    let c = 1;
    for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1);
    p += c * q ** i * (1 - q) ** (n - i);
  }
  return Math.min(1, p);
}

const oneIn = (p) => (p < 1e-12 ? "less than 1 in a trillion" : p >= 0.5 ? "high" : `about 1 in ${Math.round(1 / p).toLocaleString("en-US")}`);
const mjdToYear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;

// ---- geometry: patch pixels ↔ sky (flat-sky; the patch is ≤ 13′ wide) --------------------
function pixToSky(place, n, x, y) {
  const c = (n - 1) / 2, cosd = Math.cos((place.dec * Math.PI) / 180);
  return { ra: place.ra - ((x - c) * PX) / 3600 / cosd, dec: place.dec + ((y - c) * PX) / 3600 };   // east is left
}
function skyToPix(place, n, ra, dec) {
  const c = (n - 1) / 2, cosd = Math.cos((place.dec * Math.PI) / 180);
  let dra = ra - place.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  return { x: c - (dra * cosd * 3600) / PX, y: c + ((dec - place.dec) * 3600) / PX };
}
function gaiaAt(star, year) {   // move a Gaia star from its 2016 position to another date
  const dt = year - 2016, cosd = Math.cos((star.dec * Math.PI) / 180);
  return { ra: star.ra + ((star.pmra || 0) * dt) / 3.6e6 / cosd, dec: star.dec + ((star.pmdec || 0) * dt) / 3.6e6 };
}

// Brightness-weighted centre of light near (x, y) in one image (background removed).
function centroid(img, n, x, y, r = 2.5) {
  const vals = [];
  for (let yy = Math.floor(y - r - 3); yy <= Math.ceil(y + r + 3); yy++) for (let xx = Math.floor(x - r - 3); xx <= Math.ceil(x + r + 3); xx++) {
    if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
    const d = (xx - x) ** 2 + (yy - y) ** 2, v = img[yy * n + xx];
    if (d > r * r && d <= (r + 3) ** 2 && hasData(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const bg = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  let sw = 0, sx = 0, sy = 0;
  for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++) for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
    if (xx < 0 || yy < 0 || xx >= n || yy >= n || (xx - x) ** 2 + (yy - y) ** 2 > r * r) continue;
    const v = img[yy * n + xx];
    if (!hasData(v)) continue;
    const w = Math.max(v - bg, 0);
    sw += w; sx += w * xx; sy += w * yy;
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : null;
}

function noDataNear(img, n, x, y, r) {
  for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++) for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
    if (xx >= 0 && yy >= 0 && xx < n && yy < n && !hasData(img[yy * n + xx])) return true;
  }
  return false;
}

function peakNear(S, n, x, y, sign, r = 1.5) {
  let best = 0;
  for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++) for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
    if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
    const v = S[yy * n + xx];
    if (hasData(v) && Math.sign(v) === sign) best = Math.max(best, Math.abs(v));
  }
  return best;
}

// ---- the evidence for one change ------------------------------------------------------------
// ctx: { n, place, stars, A, B (visit stats), S (change map), years: [tA, tB], perDet: [{det, S}],
//        photos: { A: [...], B: [...] } (member frames with px), thr }
// Bright stars overflow the detector at their centre, which makes their measured position rougher:
// allow them a larger matching distance.
const matchRadius = (s) => MATCH_PX + Math.max(0, 11 - s.g) * 0.6;
function nearestStar(ctx, points, year) {
  let best = null, bd = Infinity;
  for (const s of ctx.stars) {
    const p = skyToPix(ctx.place, ctx.n, ...Object.values(gaiaAt(s, year)));
    for (const q of points) {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d <= matchRadius(s) && d < bd) { bd = d; best = { star: s, at: p, dist: d }; }
    }
  }
  return best;
}

function brightStarNear(ctx, x, y, year, except) {
  for (const s of ctx.stars) {
    if (s.g > BRIGHT_G || (except && s.id === except.id)) continue;
    const p = skyToPix(ctx.place, ctx.n, ...Object.values(gaiaAt(s, year)));
    const d = Math.hypot(p.x - x, p.y - y), reach = 6 + 3 * (BRIGHT_G - s.g);   // brighter star, wider glow
    if (d < reach) return { star: s, dist: d };
  }
  return null;
}

function detectorsSeeing(ctx, points) {
  let k = 0, n = 0;
  for (const d of ctx.perDet) {
    n++;
    if (points.every(([x, y, sign]) => peakNear(d.S, ctx.n, x, y, sign) >= DETECTOR_HIT_S)) k++;
  }
  return { k, n, p: n ? binomTail(k, n, DETECTOR_FALSE_RATE) : 1 };
}

function brightnessChange(ctx, x, y) {
  const a = measure(ctx.A.mean, ctx.n, x, y), b = measure(ctx.B.mean, ctx.n, x, y);
  if (!a || !b || a.flux <= 0) return null;
  const ratio = b.flux / a.flux, err = ratio * Math.hypot(a.err / a.flux, b.err / Math.max(b.flux, 1e-9));
  return { pct: (ratio - 1) * 100, err: err * 100, before: a.flux, after: b.flux };
}

function colourOf(ctx, x, y) {   // brightness at long colours (4-5 µm) relative to short ones (1-1.6 µm)
  let s = 0, ns = 0, l = 0, nl = 0;
  for (const f of ctx.photos.all) {
    const m = measure(f.img, ctx.n, x, y);
    if (!m) continue;
    if (f.lam >= 1.0 && f.lam <= 1.6) { s += m.flux; ns++; }
    if (f.lam >= 4.0 && f.lam <= 5.0) { l += m.flux; nl++; }
  }
  if (!ns || !nl || s / ns <= 0) return null;
  return (l / nl) / (s / ns);
}

const dirText = (dx, dy) => {   // pixel shift → compass direction (x grows to the west, y to the north)
  const ang = (Math.atan2(-dx, dy) * 180) / Math.PI;   // 0 = north, 90 = east
  return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((ang + 360) % 360) / 45) % 8];
};

// Strong: very unlikely to be noise AND seen independently in at least 3 detectors.
// Moderate: unlikely to be noise AND seen in at least 2. Anything seen in only one detector is weak.
function confidence(fluke, det) {
  if (fluke < 1e-3 && det.k >= 3) return "strong";
  if (fluke < 0.01 && det.k >= 2) return "moderate";
  return "weak";
}

// Use the searched name when the matched star is the one at the search position (on the comparison's date).
function gaiaName(ctx, star) {
  const c = (ctx.n - 1) / 2, p = skyToPix(ctx.place, ctx.n, ...Object.values(gaiaAt(star, ctx.years[1])));
  return ctx.place.name && Math.hypot(p.x - c, p.y - c) < 3 ? `${ctx.place.name} (Gaia DR3 ${star.id})` : `Gaia DR3 ${star.id}`;
}

export function interpretMove(ctx, m) {
  const [tA, tB] = ctx.years, dt = tB - tA;
  const mid = { x: (m.from.x + m.to.x) / 2, y: (m.from.y + m.to.y) / 2 };
  const cA = centroid(ctx.A.mean, ctx.n, mid.x, mid.y) || m.from, cB = centroid(ctx.B.mean, ctx.n, mid.x, mid.y) || m.to;
  const dx = cB.x - cA.x, dy = cB.y - cA.y, shift = Math.hypot(dx, dy) * PX;
  // No measurement usually means an overflowing (very bright) centre: its position is then set by the bright wings.
  const snr = (img, c) => { const r = measure(img, ctx.n, c.x, c.y); return r && r.err > 0 ? r.flux / r.err : 20; };
  const sigPos = (s) => 0.15 + 1.2 / Math.max(s, 1);   // pixels: coarse-pixel floor plus noise term
  const sDelta = Math.hypot(sigPos(snr(ctx.A.mean, cA)), sigPos(snr(ctx.B.mean, cB))) * PX;
  const fluke = flukeChance(Math.max(Math.abs(m.from.s), Math.abs(m.to.s)), ctx.n * ctx.n);
  const det = detectorsSeeing(ctx, [[m.from.x, m.from.y, -1], [m.to.x, m.to.y, 1]]);
  // Among Gaia stars close enough to be this object, take the one whose predicted motion fits best.
  let match = null, bestChi = Infinity;
  for (const s of ctx.stars) {
    const pA = skyToPix(ctx.place, ctx.n, ...Object.values(gaiaAt(s, tA)));
    if (![cA, m.from, mid].some((q) => Math.hypot(pA.x - q.x, pA.y - q.y) <= matchRadius(s))) continue;
    const pB = skyToPix(ctx.place, ctx.n, ...Object.values(gaiaAt(s, tB)));
    const chi = ((dx - (pB.x - pA.x)) ** 2 + (dy - (pB.y - pA.y)) ** 2) * PX * PX / (sDelta * sDelta);
    if (chi < bestChi) { bestChi = chi; match = { star: s, at: pA }; }
  }
  const lines = [
    `Moved ${shift.toFixed(1)}″ ± ${sDelta.toFixed(1)}″ ${dirText(dx, dy)} in ${(dt * 12).toFixed(0)} months, about ${(shift / dt).toFixed(1)}″ per year.`,
    `Seen independently in ${det.k} of ${det.n} detectors.`,
    `Chance this is just noise: ${oneIn(fluke)}.`,
  ];
  const conf = confidence(fluke, det);
  if (match) {
    const s = match.star, pA = skyToPix(ctx.place, ctx.n, ...Object.values(gaiaAt(s, tA))), pB = skyToPix(ctx.place, ctx.n, ...Object.values(gaiaAt(s, tB)));
    const gdx = pB.x - pA.x, gdy = pB.y - pA.y, gShift = Math.hypot(gdx, gdy) * PX;
    const chi2 = ((dx - gdx) ** 2 + (dy - gdy) ** 2) * PX * PX / (sDelta * sDelta);   // 2 degrees of freedom
    const consistent = chi2 < 9.21;   // 99% level
    const pmTotal = Math.hypot(s.pmra || 0, s.pmdec || 0) / 1000;
    const bright = brightStarNear(ctx, cA.x, cA.y, tA, s);
    lines.splice(1, 0, `Gaia predicts ${gShift.toFixed(1)}″ ${dirText(gdx, gdy)} for these dates (${pmTotal.toFixed(2)}″ per year): ${consistent ? "consistent" : "doesn't match"}.`);
    if (s.plx > 0) lines.push(`Distance from Gaia: ${(LY_PER_MAS / s.plx).toFixed(LY_PER_MAS / s.plx < 100 ? 1 : 0)} light years.`);
    if (consistent && gShift > 0.5 * PX) {
      return { kind: "known-mover", title: `Known moving star: ${gaiaName(ctx, s)}`, conf, lines, x: cB.x, y: cB.y };
    }
    if (bright) {
      lines.push(`Very bright star nearby (Gaia G ${bright.star.g.toFixed(1)}): its glow can fake small shifts.`);
      return { kind: "artefact", title: "Probably not real: next to a very bright star", conf: "weak", lines, x: cB.x, y: cB.y };
    }
    if (gShift < 0.15 * PX) {
      return { kind: "unexplained", title: `Shift not expected: Gaia says ${gaiaName(ctx, s)} barely moves`, conf: conf === "strong" ? "moderate" : "weak", lines, x: cB.x, y: cB.y };
    }
    return { kind: "mismatch", title: `Known moving star, but our measurement differs: ${gaiaName(ctx, s)}`, conf, lines, x: cB.x, y: cB.y };
  }
  lines.splice(1, 0, "No star in Gaia here. (Gaia sees visible light; the coldest objects are invisible to it.)");
  const red = colourOf(ctx, cB.x, cB.y);
  if (red !== null) lines.push(red > 1 ? `Brighter at long colours (4-5 µm) than short ones (${red.toFixed(1)}×): very red, like a cold brown dwarf.` : `Colour like an ordinary star (long/short colours: ${red.toFixed(2)}×).`);
  const bright = brightStarNear(ctx, cA.x, cA.y, tA, null);
  if (bright) {
    lines.push(`Very bright star nearby (Gaia G ${bright.star.g.toFixed(1)}): its glow can fake small shifts.`);
    return { kind: "artefact", title: "Probably not real: next to a very bright star", conf: "weak", lines, x: cB.x, y: cB.y };
  }
  const title = det.k >= 2 ? (red > 1 ? "Unknown mover, very red: possible brown dwarf (candidate)" : "Unknown mover: candidate worth a closer look")
    : "Possible mover, weak evidence";
  return { kind: "candidate", title, conf: det.k >= 2 ? conf : "weak", lines, x: cB.x, y: cB.y };
}

export function interpretSpot(ctx, c) {
  const [tA, tB] = ctx.years, brighter = c.s > 0;
  const fluke = flukeChance(c.s, ctx.n * ctx.n);
  const det = detectorsSeeing(ctx, [[c.x, c.y, Math.sign(c.s)]]);
  const match = nearestStar(ctx, [c], brighter ? tB : tA);
  const change = brightnessChange(ctx, c.x, c.y);
  const lines = [];
  const measurable = change && Math.abs(change.pct) >= 2 * change.err;
  if (change) {
    lines.push(measurable ? `${change.pct >= 0 ? "Brighter" : "Fainter"} by ${Math.abs(change.pct).toFixed(0)}% ± ${change.err.toFixed(0)}% between the two visits.`
      : "The brightness change is too small to measure reliably at this spot.");
  }
  lines.push(`Seen independently in ${det.k} of ${det.n} detectors.`, `Chance this is just noise: ${oneIn(fluke)}.`);
  let conf = confidence(fluke, det);
  if (!measurable) conf = "weak";
  const saturated = noDataNear(ctx.A.mean, ctx.n, c.x, c.y, 2) || noDataNear(ctx.B.mean, ctx.n, c.x, c.y, 2);
  const bright = brightStarNear(ctx, c.x, c.y, tB, match && match.dist < 1.5 ? match.star : null);
  if (bright || saturated) {
    lines.push(bright ? `Very bright star nearby (Gaia G ${bright.star.g.toFixed(1)}): its halo and reflections can fake changes.`
      : "Some pixels here overflow the detector, so the measurement is unreliable.");
    return { kind: "artefact", title: "Probably not real: next to a very bright star", conf: "weak", lines, x: c.x, y: c.y, sign: Math.sign(c.s) };
  }
  if (match) {
    lines.splice(0, 0, `Matches ${gaiaName(ctx, match.star)} (Gaia G ${match.star.g.toFixed(1)}).`);
    if (match.star.variable) lines.push("Gaia also flags this star as variable.");
    return { kind: "variable", title: `Known star got ${brighter ? "brighter" : "fainter"}`, conf, lines, x: c.x, y: c.y, sign: Math.sign(c.s) };
  }
  lines.splice(0, 0, "No star in Gaia here.");
  return {
    kind: brighter ? "appeared" : "vanished",
    title: brighter ? "Something appeared: possibly a passing asteroid or comet" : "Something disappeared: possibly an asteroid that was here earlier",
    conf, lines, x: c.x, y: c.y, sign: Math.sign(c.s),
  };
}
