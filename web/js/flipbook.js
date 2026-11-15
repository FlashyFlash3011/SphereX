// Draws one flipbook frame on the GPU. All frames sit in one texture array, so switching
// frames, contrast, zoom or invert is instant (no re-upload).

export const NO_DATA = -1e30;

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_frames;
uniform int u_layer;
uniform vec2 u_cuts;     // black point, white point
uniform float u_zoom;
uniform bool u_soft;     // asinh stretch
uniform bool u_invert;
uniform bool u_smooth;   // bilinear between pixels
uniform int u_n;
uniform bool u_diff;     // layer holds change significance; u_base holds the plain image underneath
uniform int u_base;
uniform float u_thr;     // only colour changes at least this many times the noise
uniform int u_ghost;     // 0 = off, 1 = plain ghost, 2 = coloured (what's new in red, earlier frame faint grey)
uniform int u_ghostLayer;
uniform float u_ghostAlpha;
in vec2 v_uv;
out vec4 o;

float fetchAt(ivec2 p, int layer) {
  p = clamp(p, ivec2(0), ivec2(u_n - 1));
  return texelFetch(u_frames, ivec3(p, layer), 0).r;
}
float fetchPx(ivec2 p) { return fetchAt(p, u_layer); }

float brightness(float v) {   // 0 = darkest, 1 = brightest, after contrast and stretch
  float t = clamp((v - u_cuts.x) / max(u_cuts.y - u_cuts.x, 1e-6), 0.0, 1.0);
  if (u_soft) t = log(t * 10.0 + sqrt(t * t * 100.0 + 1.0)) / 2.998223;   // asinh(10 t) / asinh(10)
  return t;
}
float shade(float v) { float t = brightness(v); return u_invert ? 1.0 - t : t; }

// Current frame with an earlier frame as a ghost. Plain: the earlier frame shows faintly through.
// Coloured: light only in the current frame is pure red (#FF0000); the earlier frame is a faint grey ghost.
vec3 ghostColour(float tc, float tg) {
  if (u_ghost == 1) {
    float t = max(tc, tg * u_ghostAlpha);
    return vec3(u_invert ? 1.0 - t : t);
  }
  float tg2 = tg * u_ghostAlpha;
  float now = max(tc - tg2, 0.0), grey = min(tc, tg2) + max(tg2 - tc, 0.0) * 0.5;
  return u_invert ? vec3(1.0 - grey, 1.0 - grey - now, 1.0 - grey - now) : vec3(grey + now, grey, grey);
}

void main() {
  // Row 0 of the image is its south edge, so the top of the screen reads the last row (north up).
  vec2 uv = 0.5 + (v_uv - 0.5) / u_zoom;
  vec2 xy = vec2(uv.x, 1.0 - uv.y) * float(u_n) - 0.5;
  float v;
  if (u_smooth) {
    ivec2 b = ivec2(floor(xy));
    vec2 f = xy - floor(xy);
    float a = fetchPx(b), c = fetchPx(b + ivec2(1, 0)), d = fetchPx(b + ivec2(0, 1)), e = fetchPx(b + ivec2(1, 1));
    if (a < -1e29 || c < -1e29 || d < -1e29 || e < -1e29) v = fetchPx(ivec2(floor(xy + 0.5)));
    else v = mix(mix(a, c, f.x), mix(d, e, f.x), f.y);
  } else {
    v = fetchPx(ivec2(floor(xy + 0.5)));
  }
  if (v < -1e29) {                       // no data: hatching, never "empty sky"
    float h = mod(gl_FragCoord.x + gl_FragCoord.y, 10.0);
    o = vec4(vec3(h < 2.0 ? 0.32 : 0.16), 1.0);
    return;
  }
  if (u_diff) {
    // Faint sky underneath for orientation; green = got brighter, purple = got fainter.
    float b = fetchAt(ivec2(floor(xy + 0.5)), u_base);
    vec3 col = vec3(b < -1e29 ? 0.5 : mix(0.5, shade(b), 0.45));
    if (u_ghost > 0 && b > -1e29) {          // changes and ghost together: the compared visit as the ghost
      float gb = fetchAt(ivec2(floor(xy + 0.5)), u_ghostLayer);
      col = mix(vec3(0.5), ghostColour(brightness(b), gb < -1e29 ? brightness(b) : brightness(gb)), 0.65);
    }
    float a = clamp((abs(v) - u_thr) / u_thr, 0.0, 1.0);
    if (abs(v) >= u_thr) col = mix(col, v > 0.0 ? vec3(0.224, 1.0, 0.078) : vec3(0.561, 0.0, 0.561), 0.6 + 0.4 * a);   // brighter #39FF14 / fainter #8F008F
    o = vec4(col, 1.0);
    return;
  }
  if (u_ghost > 0) {
    float g = fetchAt(ivec2(floor(xy + 0.5)), u_ghostLayer);
    float tc = brightness(v);
    o = vec4(ghostColour(tc, g < -1e29 ? tc : brightness(g)), 1.0);
    return;
  }
  o = vec4(vec3(shade(v)), 1.0);
}`;

export class Flipbook {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: true });
    this.ok = !!this.gl;
    this.n = 0;
    this.layers = 0;
    this.state = { layer: -1, cuts: [0, 1], zoom: 1, soft: true, invert: true, smooth: false, diff: false, base: 0, thr: 5, ghost: 0, ghostLayer: 0, ghostAlpha: 0.7 };
    if (!this.ok) return;
    const gl = this.gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.ok = false; return; }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = Object.fromEntries(["u_layer", "u_cuts", "u_zoom", "u_soft", "u_invert", "u_smooth", "u_n", "u_diff", "u_base", "u_thr", "u_ghost", "u_ghostLayer", "u_ghostAlpha"]
      .map((k) => [k, gl.getUniformLocation(prog, k)]));
    this.maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  // Replace all frames. `frames` is a list of Float32Array(n*n), NO_DATA where there's nothing.
  setFrames(n, frames) {
    if (!this.ok) return;
    const gl = this.gl, count = Math.max(1, Math.min(frames.length, this.maxLayers));
    if (!this.tex || n !== this.n || count > this.layers) {
      if (this.tex) gl.deleteTexture(this.tex);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
      this.layers = Math.min(Math.max(count, 8), this.maxLayers);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, n, n, this.layers);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.NEAREST);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.n = n;
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    frames.slice(0, this.layers).forEach((f, k) => {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, n, n, 1, gl.RED, gl.FLOAT, f);
    });
    this.draw();
  }

  set(changes) {
    Object.assign(this.state, changes);
    this.draw();
  }

  draw() {
    if (!this.ok) return;
    const gl = this.gl, c = this.canvas, s = this.state;
    const w = Math.round(c.clientWidth * devicePixelRatio), h = Math.round(c.clientHeight * devicePixelRatio);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.tex || s.layer < 0) return;
    gl.uniform1i(this.u.u_layer, s.layer);
    gl.uniform2f(this.u.u_cuts, s.cuts[0], s.cuts[1]);
    gl.uniform1f(this.u.u_zoom, s.zoom);
    gl.uniform1i(this.u.u_soft, s.soft ? 1 : 0);
    gl.uniform1i(this.u.u_invert, s.invert ? 1 : 0);
    gl.uniform1i(this.u.u_smooth, s.smooth ? 1 : 0);
    gl.uniform1i(this.u.u_n, this.n);
    gl.uniform1i(this.u.u_diff, s.diff ? 1 : 0);
    gl.uniform1i(this.u.u_base, s.base);
    gl.uniform1f(this.u.u_thr, s.thr);
    gl.uniform1i(this.u.u_ghost, s.ghost);
    gl.uniform1i(this.u.u_ghostLayer, s.ghostLayer);
    gl.uniform1f(this.u.u_ghostAlpha, s.ghostAlpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
