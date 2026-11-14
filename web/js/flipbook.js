// The image view. Every frame lives in one GPU texture array, so switching frames is a
// single number change: instant, with no loading while playing.

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_frames;
uniform float u_layer;
uniform vec2 u_cuts;      // black point, white point
uniform vec3 u_tint;      // colour of this frame's wavelength
uniform float u_px;       // screen pixels per image pixel
in vec2 v_uv;
out vec4 o;
void main() {
  float v = texture(u_frames, vec3(v_uv, u_layer)).r;
  if (v < -20000.0) {     // no data here: draw hatching, never black sky
    float d = mod(gl_FragCoord.x + gl_FragCoord.y, 8.0);
    o = vec4(vec3(d < 1.5 ? 0.18 : 0.07), 1.0);
    return;
  }
  float t = clamp((v - u_cuts.x) / (u_cuts.y - u_cuts.x), 0.0, 1.0);
  float s = log(t * 10.0 + sqrt(t * t * 100.0 + 1.0)) / 2.998223;   // asinh(10 t) / asinh(10)
  vec3 c = u_tint * min(s * 1.5, 1.0);
  c = mix(c, vec3(1.0), smoothstep(0.62, 1.0, s));                  // brightest pixels go white
  o = vec4(c, 1.0);
}`;

// Wavelength → colour, the same ramp the timeline uses.
const RAMP = [[0.75, 0x6F, 0x7B, 0xFF], [1.6, 0x35, 0xC6, 0xC0], [2.4, 0xB9, 0xD6, 0x50],
              [3.8, 0xFF, 0xB1, 0x3D], [5.0, 0xE8, 0x47, 0x2B]];

export function wavelengthColour(um) {
  const x = Math.min(Math.max(um, RAMP[0][0]), RAMP[RAMP.length - 1][0]);
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i][0]) {
      const a = RAMP[i - 1], b = RAMP[i], f = (x - a[0]) / (b[0] - a[0]);
      return [1, 2, 3].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
    }
  }
  return RAMP[RAMP.length - 1].slice(1);
}

export class Flipbook {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    this.ok = !!this.gl;
    this.n = 0;
    this.layers = 0;
    if (!this.ok) return;
    const gl = this.gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
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
    this.u = Object.fromEntries(["u_layer", "u_cuts", "u_tint", "u_px"].map((k) => [k, gl.getUniformLocation(prog, k)]));
    this.maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    this.current = null;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  // Reserve room for `layers` frames of n×n pixels.
  reset(n, layers) {
    if (!this.ok) return;
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    this.n = n;
    this.layers = Math.min(layers, this.maxLayers);
    this.current = null;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R16F, n, n, Math.max(this.layers, 1));
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.draw();
  }

  // `halfFloats` is a Uint16Array of n×n float16 values, straight from the server.
  addFrame(layer, halfFloats) {
    if (!this.ok || layer >= this.layers) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, this.n, this.n, 1, gl.RED, gl.HALF_FLOAT, halfFloats);
  }

  show(layer, cuts, wavelengthUm) {
    this.current = { layer, cuts, tint: wavelengthColour(wavelengthUm).map((v) => v / 255) };
    this.draw();
  }

  draw() {
    if (!this.ok) return;
    const gl = this.gl, c = this.canvas;
    const w = Math.round(c.clientWidth * devicePixelRatio), h = Math.round(c.clientHeight * devicePixelRatio);
    if (w === 0 || h === 0) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.current || !this.tex) return;
    gl.uniform1f(this.u.u_layer, this.current.layer);
    gl.uniform2f(this.u.u_cuts, this.current.cuts[0], this.current.cuts[1]);
    gl.uniform3fv(this.u.u_tint, this.current.tint);
    gl.uniform1f(this.u.u_px, w / Math.max(this.n, 1));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
