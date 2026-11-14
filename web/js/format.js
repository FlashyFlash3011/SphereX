// Turning numbers into text people can read.

const pad = (n, w) => String(n).padStart(w, "0");

// 269.4461 → "17h 57m 47.1s"
export function raText(deg) {
  let s = ((deg % 360) + 360) % 360 / 15 * 3600;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${pad(h, 2)}h ${pad(m, 2)}m ${s.toFixed(1).padStart(4, "0")}s`;
}

// 4.7707 → "+04° 46′ 15″"
export function decText(deg) {
  const sign = deg < 0 ? "−" : "+";
  let s = Math.abs(deg) * 3600;
  const d = Math.floor(s / 3600); s -= d * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${sign}${pad(d, 2)}° ${pad(m, 2)}′ ${pad(Math.floor(s), 2)}″`;
}

export function degText(ra, dec) {
  return `${ra.toFixed(4)}°, ${dec >= 0 ? "+" : "−"}${Math.abs(dec).toFixed(4)}°`;
}

// Field of view in degrees → "12.4°" / "35′" / "48″"
export function angleText(deg) {
  if (deg >= 1) return `${deg.toFixed(deg >= 10 ? 0 : 1)}°`;
  if (deg * 60 >= 1) return `${(deg * 60).toFixed(deg * 60 >= 10 ? 0 : 1)}′`;
  return `${Math.round(deg * 3600)}″`;
}

// Wavelength → colour on the infrared ramp (0.75 µm blue … 5 µm red).
const RAMP = [[0.75, 0x7E, 0x8F, 0xC4], [1.6, 0x6F, 0xA6, 0xA2], [2.4, 0xA3, 0xAE, 0x7C],
              [3.8, 0xC2, 0xA2, 0x72], [5.0, 0xB9, 0x7E, 0x6C]];   // blue → red, muted
export function wavelengthColour(um) {
  const x = Math.min(Math.max(um, RAMP[0][0]), RAMP[RAMP.length - 1][0]);
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i][0]) {
      const a = RAMP[i - 1], b = RAMP[i], f = (x - a[0]) / (b[0] - a[0]);
      return `rgb(${[1, 2, 3].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)).join(" ")})`;
    }
  }
  return "rgb(185 126 108)";
}
