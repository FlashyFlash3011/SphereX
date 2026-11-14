// The timeline: one tick per image, grouped into visits with a visible gap between them.
// A tick is hollow until its image has arrived, then filled with its wavelength colour.

import { wavelengthColour } from "./flipbook.js";

const GAP = 30;        // px between visits
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function monthYear(utc) { return `${MONTHS[Number(utc.slice(5, 7)) - 1]} ${utc.slice(0, 4)}`; }

export class Timeline {
  constructor(canvas, input, onPick) {
    this.canvas = canvas;
    this.input = input;
    this.ctx = canvas.getContext("2d");
    this.exposures = [];
    this.loaded = new Map();   // frame number → wavelength
    this.at = 0;
    this.xs = [];
    input.addEventListener("input", () => onPick(Number(input.value)));
    // The range input gives keyboard and screen-reader support; pointer picks by tick position.
    const pick = (e) => {
      if (!this.xs.length) return;
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left;
      let best = 0;
      for (let i = 1; i < this.xs.length; i++) if (Math.abs(this.xs[i] - x) < Math.abs(this.xs[best] - x)) best = i;
      onPick(best);
    };
    input.addEventListener("pointerdown", (e) => { input.setPointerCapture(e.pointerId); pick(e); e.preventDefault(); input.focus(); });
    input.addEventListener("pointermove", (e) => { if (input.hasPointerCapture(e.pointerId)) pick(e); });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setExposures(exposures) {
    this.exposures = exposures;
    this.loaded.clear();
    this.at = 0;
    this.input.max = String(Math.max(exposures.length - 1, 0));
    this.draw();
  }

  markLoaded(i, wavelengthUm) { this.loaded.set(i, wavelengthUm); this.draw(); }

  setCurrent(i, valueText) {
    this.at = i;
    this.input.value = String(i);
    if (valueText) this.input.setAttribute("aria-valuetext", valueText);
    this.draw();
  }

  draw() {
    if (this._queued) return;
    this._queued = true;
    requestAnimationFrame(() => { this._queued = false; this._draw(); });
  }

  _draw() {
    const c = this.canvas, ctx = this.ctx, dpr = devicePixelRatio;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const ex = this.exposures;
    if (!ex.length) return;

    // Group consecutive frames by visit; each visit gets width in proportion to its frames.
    const groups = [];
    for (let i = 0; i < ex.length; i++) {
      const g = groups[groups.length - 1];
      if (g && g.pass === ex[i].pass) g.end = i; else groups.push({ pass: ex[i].pass, start: i, end: i });
    }
    const usable = W - GAP * (groups.length - 1);
    const tickTop = 8, tickBottom = H - 22;
    const dust = css("--dust"), rule = css("--rule"), paper = css("--paper"), safelight = css("--safelight");
    this.xs = new Array(ex.length);
    let x0 = 0;
    ctx.font = `13px ${css("--font")}`;
    ctx.textBaseline = "alphabetic";
    for (const g of groups) {
      const count = g.end - g.start + 1, width = usable * count / ex.length, step = width / count;
      const tw = Math.max(1, Math.min(step - 1, 4));
      for (let i = g.start; i <= g.end; i++) {
        const x = x0 + (i - g.start + 0.5) * step;
        this.xs[i] = x;
        if (this.loaded.has(i)) {
          const [r, gg, b] = wavelengthColour(this.loaded.get(i));
          ctx.fillStyle = `rgb(${r} ${gg} ${b})`;
          ctx.fillRect(x - tw / 2, tickTop, tw, tickBottom - tickTop);
        } else {
          ctx.fillStyle = rule;
          ctx.fillRect(x - tw / 2, tickTop + 10, tw, tickBottom - tickTop - 20);
        }
      }
      const a = monthYear(ex[g.start].utc), b = monthYear(ex[g.end].utc);
      const label = a === b ? a : `${a} to ${b}`;
      ctx.fillStyle = dust;
      ctx.fillText(ctx.measureText(label).width <= width ? label : a, x0, H - 4);
      x0 += width + GAP;
    }
    // Playhead
    const px = this.xs[this.at];
    if (px !== undefined) {
      ctx.fillStyle = safelight;
      ctx.fillRect(px - 1, 0, 2, tickBottom + 4);
      ctx.fillStyle = paper;
    }
  }
}
