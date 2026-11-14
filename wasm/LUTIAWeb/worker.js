// P2: the player's Web Worker. It waits for the page's start message (the shared memory, the card's size, the stack),
// then runs the Java player (player.wasm, WebMain), which never returns: from then on it reads input from the shared
// memory and sleeps in Atomics.wait. It draws on its own OffscreenCanvas and sends each finished frame to the page as an
// ImageBitmap (hz.present): a canvas handed over by the page would show nothing while this thread never yields.
// Everything the Java side needs is on self.hz.
importScripts("wasm-gc-runtime.min.js");
/** shared word 12: the frames the page has shown (player.js) */
const FRAMES_SHOWN = 12;
/** shared word 13: the scale the page shows the card at, in screen pixels per card pixel x 1000 (0: 1) */
const SCALE = 13;
/** shared word 14: counts the page's asks for the card again (a frame it could not show); by 1 << 20 when a frame came
 *  empty (player.js blankFrame: the card's canvas is made again, canvasLost) */
const REDRAW = 14;

// The drawing helpers CanvasGfx.java calls (on self.hz.ctx): one-pixel lines on pixel centres, inversion as the
// "difference" of white, HyperCard's grey as a 2x2 pattern aligned to the card, pictures from ARGB words.
function drawing() {
  const ctx = () => self.hz.ctx;
  const metrics = new Map();
  let fontNow = "";
  function rgba(c) { return "rgba(" + ((c >> 16) & 255) + "," + ((c >> 8) & 255) + "," + (c & 255) + "," + (((c >>> 24) & 255) / 255) + ")"; }
  function roundPath(c, x, y, w, h, a) {
    const r = Math.max(0, Math.min(a / 2, w / 2, h / 2));
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
  }
  return {
    reset() { fontNow = ""; },
    color(c) { const s = rgba(c); const x = ctx(); x.fillStyle = s; x.strokeStyle = s; },
    rect(x, y, w, h) { const c = ctx(); c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); },
    roundRect(x, y, w, h, a, stroke) {
      const c = ctx();
      if (stroke) { c.lineWidth = 1; roundPath(c, x + 0.5, y + 0.5, w, h, a); c.stroke(); }
      else { roundPath(c, x, y, w, h, a); c.fill(); }
    },
    oval(x, y, w, h, stroke) {
      const c = ctx();
      c.beginPath();
      if (stroke) { c.lineWidth = 1; c.ellipse(x + w / 2, y + h / 2, Math.max(0, (w - 1) / 2), Math.max(0, (h - 1) / 2), 0, 0, 2 * Math.PI); c.stroke(); }
      else { c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI); c.fill(); }
    },
    line(x1, y1, x2, y2) {
      const c = ctx();
      if (x1 === x2) { c.fillRect(x1, Math.min(y1, y2), 1, Math.abs(y2 - y1) + 1); return; }
      if (y1 === y2) { c.fillRect(Math.min(x1, x2), y1, Math.abs(x2 - x1) + 1, 1); return; }
      c.lineWidth = 1; c.beginPath(); c.moveTo(x1 + 0.5, y1 + 0.5); c.lineTo(x2 + 0.5, y2 + 0.5); c.stroke();
    },
    invert(kind, x, y, w, h, a) {
      const c = ctx();
      c.save();
      c.globalCompositeOperation = "difference";
      c.fillStyle = "#fff";
      if (kind === 0) c.fillRect(x, y, w, h);
      else if (kind === 1) { roundPath(c, x, y, w, h, a); c.fill(); }
      else { c.beginPath(); c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI); c.fill(); }
      c.restore();
    },
    checker(x, y, w, h) {
      const c = ctx();
      const tile = new OffscreenCanvas(2, 2), t = tile.getContext("2d");
      t.fillStyle = c.fillStyle; t.fillRect(0, 0, 1, 1); t.fillRect(1, 1, 1, 1);
      const p = c.createPattern(tile, "repeat"), m = c.getTransform();
      p.setTransform(new DOMMatrix([1, 0, 0, 1, -m.e / m.a, -m.f / m.d])); // (aligned to the card, in card pixels at any scale)
      const old = c.fillStyle;
      c.fillStyle = p; c.fillRect(x, y, w, h); c.fillStyle = old;
    },
    image(px, w, h, into) { // into: a canvas made here before, refilled in place
      // a picture's canvas whose graphics the browser threw away (its context lost, out of graphics memory or the page long
      // hidden) comes back empty: marked, and CanvasGfx fills it again from the picture's pixels (lost: every card picture
      // in HyperPiece 2 was gone after a while, the parts still drawn). A context still lost is never given back while this
      // thread runs on (the browser restores it in a task this thread never yields to), and pixels put into it go nowhere:
      // a new canvas then, as for one made before the card's canvas failed (canvasLost: its graphics may be gone without
      // the context saying so) (CarChaser: the menu card's picture stayed white after the frames had failed in a race)
      // Kept in memory (willReadFrequently: a canvas the graphics card does not hold, as the glyphs' and OffscreenGfx's):
      // a graphics-card one could come back empty with its context not lost and no event (Royal Game of Ur, the pane
      // hidden a few minutes: the board picture and every icon gone for good, the text still drawn; a read of it in
      // between kept it). Drawn onto the card's canvas no slower (200 frames of 2 pictures + 30 icons: 37 ms vs 55-75 ms)
      if (into) { const ic = into.getContext("2d"); if (into.hzGen !== self.hz.gen || (ic && ic.isContextLost && ic.isContextLost())) into = null; }
      const canvas = into || new OffscreenCanvas(w, h), c = canvas.getContext("2d", { willReadFrequently: true });
      if (!into) {
        const lost = () => { canvas.hzLost = true; self.hz.lostPictures = (self.hz.lostPictures | 0) + 1; };
        canvas.addEventListener("contextlost", lost); canvas.addEventListener("contextrestored", lost);
      }
      canvas.hzLost = false; canvas.hzGen = self.hz.gen;
      const data = c.createImageData(w, h), d = data.data;
      for (let i = 0, j = 0; i < px.length; i++, j += 4) {
        const p = px[i];
        d[j] = (p >> 16) & 255; d[j + 1] = (p >> 8) & 255; d[j + 2] = p & 255; d[j + 3] = (p >>> 24) & 255;
      }
      c.putImageData(data, 0, 0);
      return canvas;
    },
    font(css) {
      if (css === fontNow) return;
      fontNow = css;
      const c = ctx(); c.font = css; c.textBaseline = "alphabetic";
    },
    metric(which) {
      let m = metrics.get(fontNow);
      if (!m) {
        const t = ctx().measureText("Hgjp日本");
        m = [Math.round(t.fontBoundingBoxAscent || t.actualBoundingBoxAscent || 10), Math.round(t.fontBoundingBoxDescent || t.actualBoundingBoxDescent || 3)];
        metrics.set(fontNow, m);
      }
      return m[which];
    },
    // (pixels as the canvas keeps them: R, G, B, A bytes, one Int32 each; CanvasGfx swaps red and blue)
    // (the card's canvas drawn larger than the card - hz.scale - is read as card pixels, the middle of each, and written back
    // as card pixels made larger: a visual effect's frames)
    // (made larger here, pixel by pixel, and put straight into the screen's pixels: drawn through a second canvas
    // (putImageData there, drawImage onto the card's), the frames transferToImageBitmap made of it were often empty in the
    // 68K player: Train Set's card went blank for each "unlock screen with visual barn door close", and stayed blank when
    // nothing drew after it; a read of the canvas in between hid it)
    getPixels(x, y, w, h) {
      const c = ctx(), m = c.getTransform();
      if (m.a === 1 && m.d === 1) { const d = c.getImageData(x + m.e, y + m.f, w, h).data; return new Int32Array(d.buffer, d.byteOffset, w * h); }
      const X = Math.round(x * m.a + m.e), Y = Math.round(y * m.d + m.f), W = Math.max(1, Math.round(w * m.a)), H = Math.max(1, Math.round(h * m.d));
      const d = c.getImageData(X, Y, W, H).data, src = new Int32Array(d.buffer, d.byteOffset, W * H), out = new Int32Array(w * h);
      for (let j = 0; j < h; j++) {
        const row = Math.min(H - 1, Math.floor((j + 0.5) * H / h)) * W;
        for (let i = 0; i < w; i++) out[j * w + i] = src[row + Math.min(W - 1, Math.floor((i + 0.5) * W / w))];
      }
      return out;
    },
    putPixels(px, x, y, w, h) {
      const c = ctx(), m = c.getTransform(), data = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, w * h * 4), w, h);
      if (m.a === 1 && m.d === 1) { c.putImageData(data, x + m.e, y + m.f); return; }
      // (the screen's rectangle as getPixels reads it, so pixels read and put back stay where they were)
      const X = Math.round(x * m.a + m.e), Y = Math.round(y * m.d + m.f), W = Math.max(1, Math.round(w * m.a)), H = Math.max(1, Math.round(h * m.d));
      const out = new Int32Array(W * H), cols = new Int32Array(W);
      for (let i = 0; i < W; i++) cols[i] = Math.min(w - 1, Math.floor((i + 0.5) * w / W));
      for (let j = 0; j < H; j++) {
        const row = Math.min(h - 1, Math.floor((j + 0.5) * h / H)) * w, o = j * W;
        for (let i = 0; i < W; i++) out[o + i] = px[row + cols[i]];
      }
      c.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), W, H), X, Y);
    },
  };
}
// P4: text for the java.awt subset (CanvasGlyphs.java): line metrics and glyph images in 1/64 pixels, from a canvas of
// its own; a glyph's alpha bytes wait in hz.glyphs.alpha for the Java side to copy.
function glyphs() {
  const canvas = new OffscreenCanvas(64, 64), c = canvas.getContext("2d", { willReadFrequently: true });
  const lines = new Map(), widths = new Map();
  function font(css) { if (c.font !== css) c.font = css; }
  const api = {
    alpha: null,
    metrics(css) {
      let m = lines.get(css);
      if (!m) {
        font(css);
        const t = c.measureText("Hgjp"), w = c.measureText("W").width, mm = c.measureText("M").width;
        const asc = t.fontBoundingBoxAscent || t.actualBoundingBoxAscent || 10, desc = t.fontBoundingBoxDescent || t.actualBoundingBoxDescent || 3;
        m = new Int32Array([Math.round(asc * 64), Math.round(desc * 64), 0, Math.round(Math.max(w, mm) * 1.1 * 64)]);
        lines.set(css, m);
      }
      return m;
    },
    advance(css, sx, cp) {
      const key = css + "\u0000" + sx + "\u0000" + cp;
      let a = widths.get(key);
      if (a === undefined) { font(css); a = c.measureText(String.fromCodePoint(cp)).width * sx; widths.set(key, a); }
      return a;
    },
    glyph(css, sx, cp) {
      font(css);
      const s = String.fromCodePoint(cp), t = c.measureText(s);
      const size = parseFloat(css.replace(/^(italic |bold )*/, "")) || 12;
      const pad = Math.ceil(size / 2) + 2, w = Math.ceil(((t.actualBoundingBoxRight || t.width) + (t.actualBoundingBoxLeft || 0)) * sx) + 2 * pad, h = Math.ceil(size * 2) + 2 * pad;
      if (canvas.width < w) canvas.width = w;
      if (canvas.height < h) canvas.height = h;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, canvas.width, canvas.height);
      font(css);
      c.fillStyle = "#fff";
      c.textBaseline = "alphabetic";
      const ox = pad + Math.ceil((t.actualBoundingBoxLeft || 0) * sx), oy = pad + Math.ceil(size * 1.3);
      c.setTransform(sx, 0, 0, 1, ox, oy);
      c.fillText(s, 0, 0);
      c.setTransform(1, 0, 0, 1, 0, 0);
      const d = c.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) { api.alpha = new Int8Array(0); return new Int32Array([0, 0, 0, 0]); }
      const gw = x1 - x0 + 1, gh = y1 - y0 + 1, a = new Int8Array(gw * gh);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) a[y * gw + x] = d[((y0 + y) * w + x0 + x) * 4 + 3];
      api.alpha = a;
      return new Int32Array([x0 - ox, y0 - oy, gw, gh]);
    },
    has(name) {
      const probe = "mmmmmmmmmmlli WW 0123";
      for (const generic of ["monospace", "serif"]) {
        font("72px " + generic); const base = c.measureText(probe).width;
        font("72px '" + name.replace(/'/g, "") + "', " + generic);
        if (c.measureText(probe).width !== base) return true;
      }
      return false;
    },
    register(data, name) {
      try {
        const face = new FontFace(name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        self.fonts.add(face);
        face.load().catch(() => {});
        return face.status !== "error";
      } catch (e) { return false; }
    },
  };
  return api;
}
self.onmessage = async (e) => {
  const m = e.data;
  if (m.kind !== "start") return;
  if (m.javaStacks) self.hzJavaStacks = true; // patch-runtime.py
  self.hz = {
    shared: new Int32Array(m.shared),
    text: new Uint16Array(m.text),
    // the microphone's ring (player.js writes it): header {written, rate, state, available}, then the samples
    mic: m.mic ? { header: new Int32Array(m.mic, 0, 4), data: new Int16Array(m.mic, 16) } : null,
    canvas: null, ctx: null,
    stack: m.stack ? new Int8Array(m.stack) : null,
    name: m.name || "",
    /** the other stacks of the work (the stacks it uses or goes to: Export for Web packs them beside it), [{name, bytes}] */
    others: (m.others || []).map((o) => ({ name: o.name, bytes: new Int8Array(o.bytes) })),
    /** what the page kept of its stacks (the player's saves, IndexedDB), [{name, fingerprint, bytes}] */
    // (with the stack's painted pictures, HzPaint: files of {path, bytes})
    /** the files the stack wrote or the user brought in on the page's visits before (player.js kept.docs), [{path, bytes}] */
    docs: (m.docs || []).map((d) => ({ path: d.path, bytes: new Int8Array(d.bytes) })),
    saved: (m.saved || []).map((o) => ({ name: o.name, fingerprint: o.fingerprint, bytes: new Int8Array(o.bytes),
      files: (o.files || []).map((f) => ({ path: f.path, bytes: new Int8Array(f.bytes) })) })),
    /** HyperZebra's language catalog the page chose (lang/<tag>.po), {tag, bytes}, or null (English) */
    catalog: m.catalog ? { tag: m.catalog.tag, bytes: new Int8Array(m.catalog.bytes) } : null,
    /** a canvas of the card's size (the Java side calls it when the stack's size is known, and again when it changes), drawn
     *  at the scale the page shows it (shared word 13): the card's coordinates stay, the canvas has the screen's pixels, so
     *  text and lines are drawn sharp at that size and pictures grow pixel by pixel (no smoothing) */
    cardW: 0, cardH: 0, scale: 1,
    scaleWanted() { const v = Atomics.load(self.hz.shared, SCALE); return v > 0 ? Math.min(16, v / 1000) : 1; },
    scaleChanged() { return self.hz.scaleWanted() !== self.hz.scale; },
    /** true once after the page asked for the card again (a frame it could not show): WebHost.redrawWanted draws it then */
    redrawAsked() {
      // a frame skipped while the page was behind (present): drawn again once the page has caught up. Without it the card
      // stayed as it was before the last change until something else was drawn (HyperPiece 2's palette Next arrow: the
      // palette's hilite and the next card came in one burst, the card's frame was the one skipped)
      if (self.hz.missed && self.hz.sent - Atomics.load(self.hz.shared, FRAMES_SHOWN) < 2) { self.hz.missed = false; return true; }
      const r = Atomics.load(self.hz.shared, REDRAW);
      if (r === (self.hz.redrawSeen | 0)) return false;
      self.hz.redrawSeen = r; return true;
    },
    /** the card's canvas lost its graphics (the browser threw them away: graphics memory, the page long hidden): it is not
     *  given back while this thread runs, and every frame failed, so the card stayed blank while the stack went on (CarChaser's
     *  race) until the card's size changed. WebHost makes a new canvas (resize) and draws the card again */
    lost: false, gen: 0,
    canvasLost() {
      if (self.hz.lost) return true;
      // the page saw an empty frame (player.js blankFrame: shared word 14 by CANVAS_LOST): lost without the context saying so
      const asked = Atomics.load(self.hz.shared, REDRAW) >>> 20;
      if (asked !== (self.hz.lostAsked | 0)) { self.hz.lostAsked = asked; self.hz.lost = true; return true; }
      const c = self.hz.canvas && self.hz.canvas.getContext("2d");
      return !!(c && c.isContextLost && c.isContextLost());
    },
    resize(w, h) {
      const s = self.hz.scaleWanted(), W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
      self.hz.cardW = w; self.hz.cardH = h; self.hz.scale = s;
      // (made again after its frames failed: the pictures' canvases are made again too, CanvasGfx.lost0)
      // A larger card's canvas made again after it failed is kept in memory from then on (cpuCard): with the pane hidden a
      // few minutes a graphics-card canvas made again came empty too, every frame, the page asking for a new one each second
      // for ever (MONOKLOCK at 4.4x: the card white until the pane was shown and the next card; at 1:1 it never failed)
      if (self.hz.canvas && self.hz.canvasLost()) { self.hz.gen++; self.hz.cpuCard = true; }
      self.hz.canvas = new OffscreenCanvas(W, H);
      self.hz.lost = false;
      // its graphics thrown away and given back empty: the card drawn again (redrawAsked)
      self.hz.canvas.addEventListener("contextrestored", () => { self.hz.missed = true; });
      // (read back often only at 1:1: a larger card's canvas is drawn on by the graphics card, read only for an effect)
      self.hz.ctx = self.hz.canvas.getContext("2d", { willReadFrequently: s === 1 || !!self.hz.cpuCard });
      self.hz.ctx.imageSmoothingEnabled = false;
      if (s !== 1) self.hz.ctx.setTransform(W / w, 0, 0, H / h, 0, 0);
      if (self.hz.g) self.hz.g.reset();
    },
    /** an image into x, y, w, h (card pixels) on the current canvas; at a scale its rectangle goes to whole screen pixels, so
     *  pictures side by side meet without a seam (Mosslight's 16-pixel tiles at 0.72 showed a grid of the card's background) */
    image(img, x, y, w, h, smooth) {
      const c = self.hz.ctx, m = c.getTransform();
      c.imageSmoothingEnabled = smooth;
      if (m.b === 0 && m.c === 0 && (m.a !== 1 || m.d !== 1)) {
        const x0 = Math.round(m.a * x + m.e), y0 = Math.round(m.d * y + m.f), x1 = Math.round(m.a * (x + w) + m.e), y1 = Math.round(m.d * (y + h) + m.f);
        if (x1 > x0 && y1 > y0) { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(img, x0, y0, x1 - x0, y1 - y0); c.restore(); }
      } else c.drawImage(img, x, y, w, h);
      c.imageSmoothingEnabled = false;
    },
    /** a canvas of its own (OffscreenGfx: a picture's text and lines decoded off the screen) */
    offscreen(w, h) {
      const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      return { canvas, ctx };
    },
    /** the drawing helpers on that canvas from now on (null: the card's again) */
    use(o) {
      self.hz.ctx = o ? o.ctx : self.hz.canvas.getContext("2d");
      self.hz.g.reset();
    },
    /** the frame drawn so far, to the page; the canvas keeps it (the next frame draws over it). The page counts the frames it
     *  showed (shared word 12): with two still on their way (the page held up: busy, hidden, a screen capture) this one waits
     *  up to 50 ms, then is skipped, and the card is drawn again once the page has caught up (redrawAsked: missed). A frame
     *  whose ImageBitmap the browser cannot make (out of graphics memory with frames piling up) is skipped too: it ended the
     *  player. */
    sent: 0,
    present() {
      const sh = self.hz.shared, c = self.hz.canvas;
      let shown = Atomics.load(sh, FRAMES_SHOWN);
      if (self.hz.sent - shown >= 2) { Atomics.wait(sh, FRAMES_SHOWN, shown, 50); if (self.hz.sent - Atomics.load(sh, FRAMES_SHOWN) >= 2) { self.hz.missed = true; return; } }
      let b;
      if (self.hz.canvasLost()) { self.hz.missed = true; return; }
      try { b = c.transferToImageBitmap(); }
      catch (e) {
        // (seen in a long race with the page hidden: every later frame threw, the context not lost; a new canvas works)
        if (!self.hz.lostSeen) console.warn("A frame of the card could not be made, the card's canvas is made again: " + e);
        self.hz.lostSeen = true; self.hz.missed = true; self.hz.lost = true; return;
      }
      self.hz.missed = false;
      const x = self.hz.ctx; x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.drawImage(b, 0, 0); x.restore(); // (pixel for pixel, at any scale)
      self.hz.sent++;
      // the card's own size with it: the page maps the pointer to card pixels
      self.postMessage({ kind: "frame", bitmap: b, cardW: self.hz.cardW, cardH: self.hz.cardH }, [b]);
    },
  };
  self.hz.g = drawing();
  self.hz.glyphs = glyphs();
  self.hz.resize(m.width || 512, m.height || 342);
  // --log (the page's ?log): what the player prints (System.out/err reach the worker's console) also goes to the page
  if ((m.args || []).includes("--log")) for (const k of ["log", "info", "warn", "error", "debug"]) {
    const original = console[k].bind(console);
    console[k] = (...a) => { try { self.postMessage({ kind: "log", text: a.map(String).join(" ") }); } catch (e) {} original(...a); };
  }
  try {
    // player.wasm, or player-68k.wasm for a stack with 68K externals (the page names it: data-wasm, ?wasm=)
    // (the bytes the page downloaded with its progress bar, else the file)
    const teavm = await TeaVM.wasmGC.load(m.wasmBytes ? new Uint8Array(m.wasmBytes) : m.wasm || "player.wasm");
    self.postMessage({ kind: "loaded" });
    teavm.exports.main(m.args || []);
    self.postMessage({ kind: "ended" });
  } catch (err) {
    self.postMessage({ kind: "error", text: String(err) + "\n" + (err && err.stack || "") });
  }
};
