// GPU renderer on WebGL2. Every drawing is a texture. A stroke in progress is rasterised by shaders into a coverage
// mask: each piece of the stroke is a signed distance field (tapered capsule for the round brush, convex polygon for
// the flat nib) and pieces are max-blended, so they merge like one shape with clean anti-aliasing and no seams.
// When the pen lifts, the mask is baked into the drawing with one blended quad. The sheet (paper, reference, onion
// ghosts, drawing, stroke in progress) is composited straight onto the screen at the display's own resolution,
// with mipmaps when zoomed out. Nothing is read back to the CPU while drawing.
//
// Convention: textures keep the top row of the document at row 0, so readPixels returns rows top-down.

const QUAD_VS = `#version 300 es
in vec2 a_corner;
uniform vec4 u_place;   // where the document lands in the target: x, y, w, h in target pixels, y down
uniform vec2 u_target;
uniform bool u_screen;  // the default framebuffer has y up
uniform bool u_mirror;
out vec2 v_uv;          // document coordinates 0..1, top left = 0,0
void main() {
  v_uv = a_corner;
  vec2 c = vec2(u_mirror ? 1.0 - a_corner.x : a_corner.x, a_corner.y);
  vec2 clip = (u_place.xy + c * u_place.zw) / u_target * 2.0 - 1.0;
  gl_Position = vec4(clip.x, u_screen ? -clip.y : clip.y, 0.0, 1.0);
}`;

const LAYER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform int u_mode;       // 0 solid colour, 1 texture, 2 drawing with the stroke in progress, 3 stroke mask alone
uniform vec4 u_color;     // premultiplied
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform vec4 u_sub;       // texture placement inside the document, in document uv
uniform float u_opacity;
uniform vec4 u_tint;      // rgb, a = strength
uniform bool u_erase;
out vec4 o;
void main() {
  if (u_mode == 0) { o = u_color; return; }
  if (u_mode == 3) {
    float m = texture(u_mask, v_uv).r;
    o = u_erase ? vec4(0.0, 0.0, 0.0, m) : u_color * m;
    return;
  }
  vec2 uv = (v_uv - u_sub.xy) / u_sub.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  vec4 c = texture(u_tex, uv);
  if (u_mode == 2) {
    float m = texture(u_mask, uv).r;
    c = u_erase ? c * (1.0 - m) : u_color * m + c * (1.0 - m);
  }
  c.rgb = mix(c.rgb, u_tint.rgb * c.a, u_tint.a);
  o = c * u_opacity;
}`;

// Round brush: one instance per segment, a capsule whose ends may have different radii (pressure).
const CAPS_VS = `#version 300 es
in vec2 a_corner;
in vec4 a_seg;  // x0 y0 x1 y1, document pixels
in vec2 a_rad;  // r0 r1
uniform vec2 u_size;
out vec2 v_p;
flat out vec4 v_seg;
flat out vec2 v_rad;
void main() {
  float r = max(a_rad.x, a_rad.y) + 1.5;
  v_p = mix(min(a_seg.xy, a_seg.zw) - r, max(a_seg.xy, a_seg.zw) + r, a_corner);
  v_seg = a_seg;
  v_rad = a_rad;
  gl_Position = vec4(v_p / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;

// Distance to a capsule with uneven radii (after Inigo Quilez, "2D distance functions").
const CAPS_FS = `#version 300 es
precision highp float;
in vec2 v_p;
flat in vec4 v_seg;
flat in vec2 v_rad;
out vec4 o;
float cro(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
void main() {
  vec2 p = v_p - v_seg.xy;
  vec2 pb = v_seg.zw - v_seg.xy;
  float ra = v_rad.x, rb = v_rad.y;
  float h = dot(pb, pb);
  float b = ra - rb;
  float d;
  if (h < 1e-4 || b * b >= h) {
    d = min(length(p) - ra, length(p - pb) - rb); // a dab, or one circle swallowing the other
  } else {
    vec2 q = vec2(dot(p, vec2(pb.y, -pb.x)), dot(p, pb)) / h;
    q.x = abs(q.x);
    vec2 c = vec2(sqrt(h - b * b), b);
    float k = cro(c, q), m = dot(c, q), n = dot(q, q);
    if (k < 0.0) d = sqrt(h * n) - ra;
    else if (k > c.x) d = sqrt(h * (n + 1.0 - 2.0 * q.y)) - rb;
    else d = m - ra;
  }
  o = vec4(clamp(0.5 - d, 0.0, 1.0));
}`;

// Flat brush: one instance per convex polygon (the nib swept between two samples), up to 8 vertices.
const POLY_VS = `#version 300 es
in vec2 a_corner;
in vec4 a_v0; in vec4 a_v1; in vec4 a_v2; in vec4 a_v3;
in float a_n;
uniform vec2 u_size;
out vec2 v_p;
flat out vec4 f0; flat out vec4 f1; flat out vec4 f2; flat out vec4 f3;
flat out int f_n;
void main() {
  int n = int(a_n);
  vec2 v[8] = vec2[8](a_v0.xy, a_v0.zw, a_v1.xy, a_v1.zw, a_v2.xy, a_v2.zw, a_v3.xy, a_v3.zw);
  vec2 lo = v[0], hi = v[0];
  for (int i = 1; i < 8; i++) {
    if (i >= n) break;
    lo = min(lo, v[i]);
    hi = max(hi, v[i]);
  }
  v_p = mix(lo - 1.5, hi + 1.5, a_corner);
  f0 = a_v0; f1 = a_v1; f2 = a_v2; f3 = a_v3; f_n = n;
  gl_Position = vec4(v_p / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;

// Distance to a convex polygon with positive (shoelace) orientation: the largest distance to its edge lines.
const POLY_FS = `#version 300 es
precision highp float;
in vec2 v_p;
flat in vec4 f0; flat in vec4 f1; flat in vec4 f2; flat in vec4 f3;
flat in int f_n;
out vec4 o;
void main() {
  vec2 v[8] = vec2[8](f0.xy, f0.zw, f1.xy, f1.zw, f2.xy, f2.zw, f3.xy, f3.zw);
  float d = -1e9;
  for (int i = 0; i < 8; i++) {
    if (i >= f_n) break;
    vec2 a = v[i];
    vec2 e = v[(i + 1) % f_n] - a;
    float l = length(e);
    if (l < 1e-5) continue;
    d = max(d, dot(v_p - a, vec2(e.y, -e.x) / l));
  }
  o = vec4(clamp(0.5 - d, 0.0, 1.0));
}`;

export const CAPS_FLOATS = 6;
export const POLY_FLOATS = 17;

export class GPU {
  constructor(canvas, onRestore) {
    this.canvas = canvas;
    this.sync = false; // the benchmark sets it to wait for the GPU after every frame
    canvas.addEventListener('webglcontextlost', e => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => {
      this.init();
      onRestore?.();
    });
    this.init();
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('Відеокарта не дає WebGL2');
    this.gl = gl;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.mask = null;
    this.scratch = new Map(); // reusable render targets by name

    const compile = (vs, fs) => {
      const prog = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        gl.attachShader(prog, sh);
      }
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      const u = {};
      for (let i = 0; i < gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i++) {
        const name = gl.getActiveUniform(prog, i).name;
        u[name] = gl.getUniformLocation(prog, name);
      }
      return { prog, u, attr: name => gl.getAttribLocation(prog, name) };
    };
    this.layerProg = compile(QUAD_VS, LAYER_FS);
    this.capsProg = compile(CAPS_VS, CAPS_FS);
    this.polyProg = compile(POLY_VS, POLY_FS);

    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const withCorners = p => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      const loc = p.attr('a_corner');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      return vao;
    };
    const instanced = (p, buf, stride, fields) => {
      const vao = withCorners(p);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (const [name, size, offset] of fields) {
        const loc = p.attr(name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
        gl.vertexAttribDivisor(loc, 1);
      }
      gl.bindVertexArray(null);
      return vao;
    };
    this.layerVao = withCorners(this.layerProg);
    gl.bindVertexArray(null);
    this.capsBuf = gl.createBuffer();
    this.capsVao = instanced(this.capsProg, this.capsBuf, CAPS_FLOATS, [['a_seg', 4, 0], ['a_rad', 2, 4]]);
    this.polyBuf = gl.createBuffer();
    this.polyVao = instanced(this.polyProg, this.polyBuf, POLY_FLOATS, [['a_v0', 4, 0], ['a_v1', 4, 4], ['a_v2', 4, 8], ['a_v3', 4, 12], ['a_n', 1, 16]]);

    gl.useProgram(this.layerProg.prog);
    gl.uniform1i(this.layerProg.u.u_tex, 0);
    gl.uniform1i(this.layerProg.u.u_mask, 1);
  }

  get lost() {
    return this.gl.isContextLost();
  }

  // ---------- textures ----------

  // A texture with its own framebuffer. Mipmap levels are allocated up front and rebuilt lazily when the texture is
  // shown smaller than 1:1.
  layer(w, h, { mips = true, red = false } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, red ? gl.R8 : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const l = { tex, fbo, w, h, levels, mipsDirty: true, mipFilter: false };
    this.clear(l);
    return l;
  }

  free(l) {
    if (!l || this.lost) return;
    this.gl.deleteTexture(l.tex);
    this.gl.deleteFramebuffer(l.fbo);
  }

  clear(l, r = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, l.fbo);
    gl.viewport(0, 0, l.w, l.h);
    if (r) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(r.x, r.y, r.w, r.h);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    l.mipsDirty = true;
  }

  // Any canvas, ImageBitmap or video frame of exactly the layer's size.
  upload(l, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, l.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    l.mipsDirty = true;
  }

  // Premultiplied RGBA, rows top-down.
  read(l, r = { x: 0, y: 0, w: l.w, h: l.h }) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, l.fbo);
    const out = new Uint8Array(r.w * r.h * 4);
    gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  blit(from, to, a, b) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fbo);
    gl.blitFramebuffer(a.x, a.y, a.x + a.w, a.y + a.h, b.x, b.y, b.x + b.w, b.y + b.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    to.mipsDirty = true;
  }

  // Copies a rectangle out into a texture of its own (undo history stays on the GPU).
  copyOut(l, r) {
    const t = this.layer(r.w, r.h, { mips: false });
    this.blit(l, t, r, { x: 0, y: 0, w: r.w, h: r.h });
    return t;
  }

  copyIn(l, t, r) {
    this.blit(t, l, { x: 0, y: 0, w: r.w, h: r.h }, r);
  }

  duplicate(l) {
    const t = this.layer(l.w, l.h);
    this.blit(l, t, { x: 0, y: 0, w: l.w, h: l.h }, { x: 0, y: 0, w: l.w, h: l.h });
    return t;
  }

  scratchLayer(name, w, h) {
    let l = this.scratch.get(name);
    if (!l || l.w !== w || l.h !== h) {
      this.free(l);
      l = this.layer(w, h, { mips: name === 'ref' || name === 'under' });
      this.scratch.set(name, l);
    }
    return l;
  }

  prepare(l, minify) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, l.tex);
    const want = minify && l.levels > 1;
    if (want && l.mipsDirty) {
      gl.generateMipmap(gl.TEXTURE_2D);
      l.mipsDirty = false;
    }
    if (want !== l.mipFilter) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, want ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      l.mipFilter = want;
    }
  }

  // ---------- strokes ----------

  beginStroke(w, h) {
    if (!this.mask || this.mask.w !== w || this.mask.h !== h) {
      this.free(this.mask);
      this.mask = this.layer(w, h, { red: true });
    } else {
      this.clear(this.mask);
    }
  }

  stamp(p, vao, buf, data, count) {
    const gl = this.gl;
    const m = this.mask;
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.fbo);
    gl.viewport(0, 0, m.w, m.h);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.u_size, m.w, m.h);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
    gl.blendEquation(gl.FUNC_ADD);
    m.mipsDirty = true;
  }

  capsules(data, count) {
    this.stamp(this.capsProg, this.capsVao, this.capsBuf, data, count);
  }

  polygons(data, count) {
    this.stamp(this.polyProg, this.polyVao, this.polyBuf, data, count);
  }

  // Bakes the stroke mask into a drawing: paint is colour over, the eraser multiplies alpha away.
  commit(l, color, erase, r) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, l.fbo);
    gl.viewport(0, 0, l.w, l.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.x, r.y, r.w, r.h);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.layerProg;
    gl.useProgram(p.prog);
    this.placeUniforms({ x: 0, y: 0, w: l.w, h: l.h }, l.w, l.h, false);
    gl.uniform1i(p.u.u_mode, 3);
    gl.uniform4fv(p.u.u_color, color);
    gl.uniform1i(p.u.u_erase, erase ? 1 : 0);
    this.unbind();
    gl.activeTexture(gl.TEXTURE1);
    this.prepare(this.mask, false);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.layerVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    l.mipsDirty = true;
  }

  // ---------- compositing ----------

  // A texture may not be sampled while it is the render target, so start every pass with empty units.
  unbind() {
    const gl = this.gl;
    for (const unit of [gl.TEXTURE1, gl.TEXTURE0]) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  placeUniforms(place, tw, th, screen) {
    const gl = this.gl;
    const u = this.layerProg.u;
    gl.uniform4f(u.u_place, place.x, place.y, place.w, place.h);
    gl.uniform2f(u.u_target, tw, th);
    gl.uniform1i(u.u_screen, screen ? 1 : 0);
    gl.uniform1i(u.u_mirror, place.mirror ? 1 : 0);
  }

  // target: a layer, or null for the screen. place: where the document lands, in target pixels.
  // ops, back to front: { color } | { layer, sub, opacity, tint, mask: { color, erase } }, docW: document width.
  draw(target, place, docW, ops) {
    const gl = this.gl;
    const tw = target ? target.w : this.canvas.width;
    const th = target ? target.h : this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, tw, th);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.layerProg;
    const u = p.u;
    gl.useProgram(p.prog);
    gl.bindVertexArray(this.layerVao);
    this.unbind();
    this.placeUniforms(place, tw, th, !target);
    const scale = Math.abs(place.w) / docW; // target pixels per document pixel
    for (const op of ops) {
      if (op.color) {
        gl.uniform1i(u.u_mode, 0);
        gl.uniform4fv(u.u_color, op.color);
      } else {
        const sub = op.sub || [0, 0, 1, 1];
        // Shown smaller than its own resolution: sample the mipmaps instead of skipping pixels.
        const minify = (scale * docW * sub[2]) / op.layer.w < 0.999;
        gl.activeTexture(gl.TEXTURE0);
        this.prepare(op.layer, minify);
        gl.uniform4fv(u.u_sub, sub);
        gl.uniform1f(u.u_opacity, op.opacity ?? 1);
        gl.uniform4fv(u.u_tint, op.tint || [0, 0, 0, 0]);
        if (op.mask) {
          gl.activeTexture(gl.TEXTURE1);
          this.prepare(this.mask, minify);
          gl.activeTexture(gl.TEXTURE0);
          gl.uniform1i(u.u_mode, 2);
          gl.uniform4fv(u.u_color, op.mask.color);
          gl.uniform1i(u.u_erase, op.mask.erase ? 1 : 0);
        } else {
          gl.uniform1i(u.u_mode, 1);
        }
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
    if (this.sync) gl.finish();
  }
}
