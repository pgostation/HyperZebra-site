// P2: the page side of the HyperZebra web player. It makes the shared memory (the same layout as WebMain.java), hands
// the canvas and the stack to the worker (worker.js, which runs the Java player and never returns), and turns the
// page's input into words and events in the shared memory, waking the worker with Atomics.notify. Requests from the
// worker (dialogs, the message box, menus, beep) come as messages.
(function () {
  "use strict";
  const WAKE = 0, MOUSE_X = 1, MOUSE_Y = 2, BUTTONS = 3, MODS = 4, ABORT = 5, RING_WRITE = 6, RING_READ = 7,
    REPLY_READY = 8, REPLY_LENGTH = 9, REPLY_BUTTON = 10, FRAMES_SHOWN = 12, SCALE = 13, REDRAW = 14, SCREEN_TL = 11, SCREEN_BR = 15, RING = 16, RING_SIZE = 256, EVENT_WORDS = 8;
  const EV = { DOWN: 1, UP: 2, KEY_DOWN: 3, KEY_UP: 4, MOVE: 5, MSG: 6, MENU: 7, FLUSH: 8, WHEEL: 9, PART_INFO: 10, POPUP: 11 };

  /** What the player keeps of its stacks (PlayerSaving): each stack's _stack.xml in IndexedDB, under this page's folder and
   *  the stack's name, with the fingerprint of the _stack.xml it was exported with (the player uses it only for that one). */
  const kept = {
    page: location.pathname.replace(/[^/]*$/, ""),
    open() {
      return new Promise((resolve, reject) => {
        const r = indexedDB.open("hyperzebra-player", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("stacks");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async all() {
      const db = await kept.open(), out = [];
      await new Promise((resolve, reject) => {
        const c = db.transaction("stacks").objectStore("stacks").openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) { resolve(); return; }
          if (cur.value && cur.value.page === kept.page) out.push(cur.value);
          cur.continue();
        };
        c.onerror = () => reject(c.error);
      });
      db.close();
      return out;
    },
    // files: the stack's other files the player wrote (painted pictures), [{path, bytes}], kept in the same record
    async put(name, fingerprint, bytes, files) {
      const db = await kept.open();
      await new Promise((resolve, reject) => {
        const t = db.transaction("stacks", "readwrite");
        t.objectStore("stacks").put({ page: kept.page, name, fingerprint, bytes, files: files || [], savedAt: Date.now() }, kept.page + "\n" + name);
        t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
      });
      db.close();
    },
    /** the files in a database of their own (a players' older pages open "hyperzebra-player" at version 1: a new store in it
     *  would need version 2, which those could no longer open) */
    openDocs() {
      return new Promise((resolve, reject) => {
        const r = indexedDB.open("hyperzebra-player-docs", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("docs");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    /** the files the stack wrote (close file) or the user brought in (answer file's Upload…): [{path, bytes}] of this page */
    async docs() {
      const db = await kept.openDocs(), out = [];
      await new Promise((resolve, reject) => {
        const c = db.transaction("docs").objectStore("docs").openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) { resolve(); return; }
          if (cur.value && cur.value.page === kept.page) out.push(cur.value);
          cur.continue();
        };
        c.onerror = () => reject(c.error);
      });
      db.close();
      return out;
    },
    async putDoc(path, bytes) {
      const db = await kept.openDocs();
      await new Promise((resolve, reject) => {
        const t = db.transaction("docs", "readwrite");
        t.objectStore("docs").put({ page: kept.page, path, bytes, savedAt: Date.now() }, kept.page + "\n" + path);
        t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
      });
      db.close();
    },
    /** forgets what this page kept (?reset): its stacks' changes and its files */
    async clear() {
      const docs = await kept.docs();
      for (const r of await kept.all()) {
        const db = await kept.open();
        await new Promise((resolve) => { const t = db.transaction("stacks", "readwrite"); t.objectStore("stacks").delete(kept.page + "\n" + r.name); t.oncomplete = resolve; t.onerror = resolve; });
        db.close();
      }
      for (const d of docs) {
        const db = await kept.openDocs();
        await new Promise((resolve) => { const t = db.transaction("docs", "readwrite"); t.objectStore("docs").delete(kept.page + "\n" + d.path); t.oncomplete = resolve; t.onerror = resolve; });
        db.close();
      }
    },
  };

  /** Cross-origin isolation (SharedArrayBuffer needs it): from the server's headers, else from sw.js after one reload. */
  async function isolate() {
    if (self.crossOriginIsolated) return true;
    if (!("serviceWorker" in navigator)) return false;
    const reg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    if (!sessionStorage.getItem("hz-isolation-reload")) {
      sessionStorage.setItem("hz-isolation-reload", "1");
      location.reload();
      return new Promise(() => {});
    }
    return false;
  }

  function mods(e) {
    return (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.ctrlKey ? 8 : 0) |
      (e.getModifierState && e.getModifierState("CapsLock") ? 16 : 0);
  }

  async function start(opts) {
    const status = opts.status || (() => {});
    if (!(await isolate())) { status("This page needs cross-origin isolation (SharedArrayBuffer): it could not be turned on."); return null; }
    sessionStorage.removeItem("hz-isolation-reload");
    // what the player kept of its stacks when the page was open before (opts.keep false: nothing kept, nothing read)
    let saved = [], docs = [];
    const keeping = opts.keep !== false && typeof indexedDB !== "undefined";
    if (keeping) {
      try { if (opts.reset) await kept.clear(); saved = await kept.all(); docs = await kept.docs(); }
      catch (err) { console.warn("The stacks' kept changes could not be read: " + err); }
    }
    const sharedBuf = new SharedArrayBuffer(4 * (RING + RING_SIZE * EVENT_WORDS));
    const textBuf = new SharedArrayBuffer(2 * 65536);
    // the microphone (a 68K external records: SPBRecord, SndRecord): opened only when the worker asks, the browser asking the
    // user; mono 16-bit samples go round a ring of MIC_SAMPLES (~43 s at 48 kHz) the worker reads as it records
    const MIC_SAMPLES = 1 << 21, micBuf = new SharedArrayBuffer(16 + 2 * MIC_SAMPLES);
    const micHeader = new Int32Array(micBuf, 0, 4), micData = new Int16Array(micBuf, 16);
    Atomics.store(micHeader, 3, navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 1 : 0);
    let mic = null;
    async function micOn(on) {
      if (!on) {
        if (mic) { try { mic.stream.getTracks().forEach((t) => t.stop()); mic.ctx.close(); } catch (e) {} mic = null; }
        Atomics.store(micHeader, 2, 0); return;
      }
      if (mic) return;
      Atomics.store(micHeader, 2, 0); // asking (the user may take a while to answer the browser)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0); let w = Atomics.load(micHeader, 0);
          for (let i = 0; i < input.length; i++, w++) micData[w % MIC_SAMPLES] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
          Atomics.store(micHeader, 0, w);
          e.outputBuffer.getChannelData(0).fill(0);
        };
        src.connect(proc); proc.connect(ctx.destination);
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        mic = { stream, ctx, src, proc };
        Atomics.store(micHeader, 1, ctx.sampleRate); Atomics.store(micHeader, 2, 1);
      } catch (err) { Atomics.store(micHeader, 2, -1); }
    }
    const shared = new Int32Array(sharedBuf), text = new Uint16Array(textBuf);
    const canvas = opts.canvas;
    const worker = new Worker("worker.js");
    const wake = () => { Atomics.add(shared, WAKE, 1); Atomics.notify(shared, WAKE); };
    function event(type, x, y, keyCode, ch, extra) {
      const w = Atomics.load(shared, RING_WRITE), r = Atomics.load(shared, RING_READ);
      if (w - r >= RING_SIZE) return; // the player is far behind: drop it
      const b = RING + (w % RING_SIZE) * EVENT_WORDS;
      shared[b] = type; shared[b + 1] = x | 0; shared[b + 2] = y | 0; shared[b + 3] = Atomics.load(shared, MODS);
      shared[b + 4] = keyCode | 0; shared[b + 5] = ch | 0; shared[b + 6] = extra | 0; shared[b + 7] = (performance.now() | 0);
      Atomics.store(shared, RING_WRITE, w + 1);
      wake();
    }
    function putText(s) {
      const n = Math.min(s.length, text.length);
      for (let i = 0; i < n; i++) text[i] = s.charCodeAt(i);
      return n;
    }
    // an event's text (a message box line, a menu choice) each in its own place after the first 4096 (a dialog's reply is at 0):
    // two sent close together each keep theirs (the second one, written at 0 too, replaced the first before the worker read it)
    const EVENT_TEXT = 4096;
    let textAt = EVENT_TEXT;
    function putEventText(s) {
      const n = Math.min(s.length, text.length - EVENT_TEXT);
      if (textAt + n > text.length) textAt = EVENT_TEXT;
      const at = textAt;
      for (let i = 0; i < n; i++) text[at + i] = s.charCodeAt(i);
      textAt += n;
      return [at, n];
    }
    // the card's pixels: the canvas shows the card at any size (the worker draws it at the screen's pixels: hz.scale), inside
    // its border
    let cardW = canvas.width, cardH = canvas.height;
    function at(e) {
      const r = canvas.getBoundingClientRect(), w = canvas.clientWidth || r.width, h = canvas.clientHeight || r.height;
      return [Math.floor((e.clientX - r.left - canvas.clientLeft) * cardW / w), Math.floor((e.clientY - r.top - canvas.clientTop) * cardH / h)];
    }
    // the pointer on the card, and on the palettes floating over the page (their places in the card's coordinates too, also
    // outside it): held, it stays theirs until it is let go (a drag goes on outside them)
    // (the press's moves and release are also taken from the whole window: a palette moved in the page while it is dragged,
    // or a pointer let go off the card, would lose them)
    let pressing = false;
    const release = (e) => {
      if (!pressing) return;
      pressing = false;
      const [x, y] = at(e);
      Atomics.store(shared, MOUSE_X, x); Atomics.store(shared, MOUSE_Y, y);
      Atomics.store(shared, MODS, mods(e)); Atomics.store(shared, BUTTONS, 0);
      event(EV.UP, x, y, 0, 0, e.detail);
    };
    // a press the page lost (the browser cancelled the pointer, the window lost the focus while it was held, or the pointer
    // came back with the button already up: let go where the page did not see it) ends as a cancelled release, -1: where the
    // pointer was last, no mouseUp and no drop (Drag and Drop 1.1: Command-Tab while dragging a line left the mouse down, its
    // mouseStillDown running, until the next click)
    const cancelPress = () => {
      if (!pressing) return;
      pressing = false;
      Atomics.store(shared, BUTTONS, 0);
      event(EV.UP, Atomics.load(shared, MOUSE_X), Atomics.load(shared, MOUSE_Y), 0, 0, -1);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", cancelPress);
    window.addEventListener("blur", cancelPress);
    window.addEventListener("pointermove", (e) => {
      if (!pressing) return;
      if (e.buttons === 0 && e.pointerType === "mouse") { cancelPress(); return; }
      const [x, y] = at(e);
      Atomics.store(shared, MOUSE_X, x); Atomics.store(shared, MOUSE_Y, y);
      wake();
    });
    function pointerTarget(el, own) {
      el.addEventListener("pointerdown", (e) => {
        if (own && e.target !== el) return;
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
        pressing = true;
        const [x, y] = at(e);
        Atomics.store(shared, MOUSE_X, x); Atomics.store(shared, MOUSE_Y, y);
        Atomics.store(shared, MODS, mods(e)); Atomics.store(shared, BUTTONS, 1);
        event(EV.DOWN, x, y, 0, 0, e.detail);
        e.preventDefault();
        focusKeys();
      });
      el.addEventListener("pointerup", release);
      // leaving the card: the pointer's place outside it (the part it was over gets mouseLeave)
      el.addEventListener("pointerleave", (e) => {
        const [x, y] = at(e);
        Atomics.store(shared, MOUSE_X, x); Atomics.store(shared, MOUSE_Y, y);
        wake();
      });
      el.addEventListener("pointermove", (e) => {
        const [x, y] = at(e);
        Atomics.store(shared, MOUSE_X, x); Atomics.store(shared, MOUSE_Y, y);
        Atomics.store(shared, MODS, mods(e));
        wake();
      });
    }
    pointerTarget(canvas);
    // the page round the card (opts.desktop: the elements whose own presses are the screen outside the card window): a press
    // there reaches the player at its place off the card, as a click on HyperCard's desktop does: the mouseClick of a running
    // handler (HyperPiece 2's card wobble ends on a click though the card has gone off the page)
    for (const el of [].concat(opts.desktop || [])) pointerTarget(el, true);
    // HyperCard's palettes as windows of their own over the page (the player sends them: PlayerHost.floatingWindows), where
    // they may leave the card as palettes beside the card window do on the desktop; at the card's scale, front last
    const layer = document.createElement("div");
    layer.className = "hz-palettes";
    Object.assign(layer.style, { position: "fixed", left: "0", top: "0", width: "0", height: "0", zIndex: "5" });
    document.body.appendChild(layer);
    const floats = new Map();
    function placeFloats() {
      const r = canvas.getBoundingClientRect(), cw = canvas.clientWidth || r.width;
      if (!cw || !cardW) return;
      const s = cw / cardW, ox = r.left + canvas.clientLeft, oy = r.top + canvas.clientTop;
      // the page's window in card coordinates (shared words 11, 15: two 16-bit halves each): where a palette may go
      const clamp = (v) => Math.max(-32768, Math.min(32767, v));
      const pack = (a, b) => ((clamp(a) & 0xFFFF) << 16) | (clamp(b) & 0xFFFF);
      const vw = document.documentElement.clientWidth || innerWidth, vh = document.documentElement.clientHeight || innerHeight;
      Atomics.store(shared, SCREEN_TL, pack(Math.ceil(-ox / s), Math.ceil(-oy / s)));
      Atomics.store(shared, SCREEN_BR, pack(Math.floor((vw - ox) / s), Math.floor((vh - oy) / s)));
      for (const f of floats.values()) {
        Object.assign(f.el.style, { left: (ox + f.x * s) + "px", top: (oy + f.y * s) + "px", width: (f.w * s) + "px", height: (f.h * s) + "px" });
      }
    }
    window.addEventListener("resize", () => placeFloats());
    // the browser may throw canvases' pixels away while the page is hidden (graphics memory): shown again, the card is asked
    // for again (shared word 14) and the palettes are put back from their pictures (HyperPiece 2: the card and its palette
    // were white after the pane had been hidden, until something on the card changed)
    const redrawAll = () => {
      Atomics.add(shared, REDRAW, 1); wake();
      for (const f of floats.values()) if (f.image) { try { f.el.getContext("2d").putImageData(f.image, 0, 0); } catch (e) {} }
    };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") redrawAll(); });
    window.addEventListener("pageshow", redrawAll);
    canvas.addEventListener("contextrestored", redrawAll);
    // the wheel: card pixels down (a scrolling field under the pointer scrolls), what is left of a pixel kept for the next
    let wheelRest = 0;
    canvas.addEventListener("wheel", (e) => {
      const r = canvas.getBoundingClientRect(), h = canvas.clientHeight || r.height;
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * cardH : e.deltaY * cardH / h;
      wheelRest += px;
      const n = Math.trunc(wheelRest);
      e.preventDefault();
      if (n === 0) return;
      wheelRest -= n;
      const [x, y] = at(e);
      event(EV.WHEEL, x, y, 0, 0, n);
    }, { passive: false });
    // Keys go to an invisible text area over the card: plain keys arrive as keydown (sent at once, the text area never
    // changes), text from an input method (Japanese), dictation or pasting arrives as input/compositionend and is sent
    // one character at a time, as if typed
    let keyTarget = opts.keyTarget;
    if (!keyTarget) {
      keyTarget = document.createElement("textarea");
      keyTarget.setAttribute("aria-label", "Keyboard input for the stack");
      keyTarget.autocapitalize = "off"; keyTarget.spellcheck = false; keyTarget.autocomplete = "off";
      Object.assign(keyTarget.style, { position: "absolute", opacity: "0", width: "1px", height: "1em", padding: "0", border: "0",
        resize: "none", overflow: "hidden", pointerEvents: "none", left: "0", top: "0" });
      (canvas.parentNode || document.body).insertBefore(keyTarget, canvas.nextSibling);
      if (getComputedStyle(canvas.parentNode).position === "static") canvas.parentNode.style.position = "relative";
    }
    const focusKeys = () => { try { keyTarget.focus({ preventScroll: true }); } catch (e) {} };
    function typed() {
      const s = keyTarget.value || "";
      if (keyTarget.value !== undefined) keyTarget.value = "";
      for (const c of s) {
        const cp = c.codePointAt(0);
        if (cp === 10 || cp === 13) event(EV.KEY_DOWN, 0, 0, 13, 13, 0);
        else event(EV.KEY_DOWN, 0, 0, 0, cp, 0);
      }
    }
    // with a key: 1 on the keypad, 2 the left one, 4 the right one (shift, option, control, command), 8 off the Mac
    // (control is command too there, as on the desktop)
    const offMac = !/Mac|iPhone|iPad/.test(navigator.platform);
    function keyExtra(e) { return (e.location === 3 ? 1 : 0) | (e.location === 1 ? 2 : 0) | (e.location === 2 ? 4 : 0) | (offMac ? 8 : 0); }
    // a key's browser key code by its place on the keyboard (KeyboardEvent.code), for a key the input method took (229)
    const PLACE_CODES = { Space: 32, Enter: 13, NumpadEnter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, ArrowLeft: 37,
      ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221, Backslash: 220,
      IntlYen: 220, Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191, IntlRo: 191, Backquote: 192,
      NumpadAdd: 107, NumpadSubtract: 109, NumpadMultiply: 106, NumpadDivide: 111, NumpadDecimal: 110 };
    function codeOfPlace(place) {
      if (!place) return 0;
      let m = /^Key([A-Z])$/.exec(place); if (m) return m[1].charCodeAt(0);
      m = /^Digit([0-9])$/.exec(place); if (m) return 48 + +m[1];
      m = /^Numpad([0-9])$/.exec(place); if (m) return 96 + +m[1];
      return PLACE_CODES[place] || 0;
    }
    let composing = false;
    keyTarget.addEventListener("compositionstart", () => { composing = true; });
    keyTarget.addEventListener("compositionend", () => { composing = false; typed(); });
    keyTarget.addEventListener("input", (e) => { if (!composing && !e.isComposing) typed(); });
    // A Mac browser tells no keyup for a key let go while Command is down (the key-polling externals, KStealKeyX, would see
    // it held on): such a key counts as held while its auto-repeat keeps coming, and up when Command is let go. The waits
    // are learnt from the repeats seen (the user's Keyboard settings); macOS repeats only the last key pressed, so a key
    // pressed before it stays held until Command is let go
    const cmdKeys = new Map(); // keyCode -> {extra, timer, at, repeats}
    let cmdFirstWait = 600, cmdRepeatWait = 150;
    const isModifier = (e) => ["Meta", "OS", "Shift", "Alt", "Control", "CapsLock", "Fn", "AltGraph"].includes(e.key);
    function cmdUntrack(code) { const k = cmdKeys.get(code); if (k) { clearTimeout(k.timer); cmdKeys.delete(code); } return k; }
    function cmdRelease(code) { const k = cmdUntrack(code); if (k) event(EV.KEY_UP, 0, 0, code, 0, k.extra); }
    function cmdReleaseAll() { for (const code of [...cmdKeys.keys()]) cmdRelease(code); }
    function cmdTrack(e) {
      const code = e.keyCode, now = performance.now();
      let k = cmdKeys.get(code);
      if (k && e.repeat) {
        const gap = now - k.at;
        if (k.repeats === 0) cmdFirstWait = Math.max(300, Math.min(2500, gap * 1.3 + 60));
        else cmdRepeatWait = Math.max(100, Math.min(1000, gap * 2.5 + 40));
        k.repeats++;
        clearTimeout(k.timer);
      } else {
        cmdUntrack(code);
        for (const o of cmdKeys.values()) { clearTimeout(o.timer); o.timer = 0; } // their repeat stops now
        k = { extra: keyExtra(e), repeats: 0 };
        cmdKeys.set(code, k);
      }
      k.at = now;
      k.timer = setTimeout(() => cmdRelease(code), k.repeats ? cmdRepeatWait : cmdFirstWait);
    }
    keyTarget.addEventListener("keydown", (e) => {
      Atomics.store(shared, MODS, mods(e));
      // the input method has it (Japanese input on: every letter comes as 229 "Process"); the key is still held, as GetKeys
      // sees it on a Mac whatever the input method, so the key-polling externals get it by its place (LUTIA's KStealKeyX
      // Z and X did nothing with Japanese input on, the arrows worked): extra 16 = held only, no keyDown
      if (composing || e.isComposing || e.key === "Process" || e.keyCode === 229) {
        const code = e.keyCode && e.keyCode !== 229 ? e.keyCode : codeOfPlace(e.code);
        if (code) event(EV.KEY_DOWN, 0, 0, code, 0, keyExtra(e) | 16);
        return;
      }
      if (!offMac && !isModifier(e)) { if (e.metaKey) cmdTrack(e); else cmdUntrack(e.keyCode); }
      // Command-period stops a running handler, as in HyperCard
      if ((e.metaKey || e.ctrlKey) && e.key === ".") { Atomics.store(shared, ABORT, 1); wake(); e.preventDefault(); return; }
      const ch = e.key.length === 1 || [...e.key].length === 1 ? e.key.codePointAt(0) : 0;
      event(EV.KEY_DOWN, 0, 0, e.keyCode, ch, keyExtra(e));
      if (ch || ["Enter", "Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) e.preventDefault();
    });
    keyTarget.addEventListener("keyup", (e) => {
      Atomics.store(shared, MODS, mods(e));
      if (e.key === "Meta" || e.key === "OS") cmdReleaseAll();
      const code = e.keyCode && e.keyCode !== 229 ? e.keyCode : codeOfPlace(e.code);
      if (e.key !== "Meta" && e.key !== "OS") cmdUntrack(code);
      if (code) event(EV.KEY_UP, 0, 0, code, 0, keyExtra(e)); // (also while composing: the key held for the externals is let go)
    });
    // the keys held (the key-polling externals): released all at once when the page loses the keyboard
    // (the modifiers too: one let go in another window or program never tells this page, and the shiftKey stayed down
    // until the next key or pointer event here - the Keyboard stack check, Nov 13)
    const releaseAll = () => { for (const code of [...cmdKeys.keys()]) cmdUntrack(code); Atomics.store(shared, MODS, 0); event(EV.KEY_UP, 0, 0, -1, 0, 0); };
    keyTarget.addEventListener("blur", releaseAll);
    window.addEventListener("blur", releaseAll);

    const handlers = opts.handlers || {};
    // set the cursor (PlayerUiHost.showCursor): HyperCard's cursor over the card while the handlers run, a CSS cursor (the
    // stack's own as an image at its hot spot); empty: the page's own again
    handlers.cursor = handlers.cursor || ((m) => { canvas.style.cursor = m.text || ""; });
    handlers.windows = handlers.windows || ((m) => {
      const seen = new Set(), order = [];
      for (const w of m.list) {
        seen.add(w.id);
        let f = floats.get(w.id);
        if (!f) {
          const el = document.createElement("canvas");
          el.setAttribute("aria-label", "Palette");
          Object.assign(el.style, { position: "absolute", imageRendering: "pixelated", touchAction: "none", boxShadow: "0 2px 8px rgba(0,0,0,.25)" });
          pointerTarget(el);
          f = { el };
          const ff = f;
          el.addEventListener("contextrestored", () => { if (ff.image) ff.el.getContext("2d").putImageData(ff.image, 0, 0); });
          floats.set(w.id, f);
        }
        f.x = w.x; f.y = w.y; f.w = w.w; f.h = w.h;
        if (w.data) {
          f.el.width = w.w; f.el.height = w.h;
          const c = f.el.getContext("2d"), img = c.createImageData(w.w, w.h), d = img.data, a = w.data;
          for (let i = 0, j = 0; i < a.length; i++, j += 4) { const v = a[i]; d[j] = (v >> 16) & 255; d[j + 1] = (v >> 8) & 255; d[j + 2] = v & 255; d[j + 3] = (v >>> 24) & 255; }
          c.putImageData(img, 0, 0);
          f.image = img; // (kept: put back when the browser threw the canvas's pixels away)
        }
        order.push(f.el);
      }
      for (const [id, f] of floats) if (!seen.has(id)) { f.el.remove(); floats.delete(id); }
      // in the list's order, the front one last; the elements stay put when it is the same (moving one in the page ends a
      // drag's pointer capture)
      const now = [...layer.children];
      if (now.length !== order.length || order.some((el, i) => now[i] !== el)) for (const el of order) layer.appendChild(el);
      placeFloats();
    });
    const api = {
      shared, text, worker, event, wake,
      /** a key of the page's virtual game pad pressed or let go, as the keyboard's would be (the browser's key code, the
       *  character, the modifier bit it holds (1 shift, 2 option, 4 command, 8 control), 1 for the keypad): the stack's
       *  key-polling externals (KStealKeyX, GetKeys) see it held, keyDown and arrowKey come as for a key */
      padKey(down, code, ch, mod, keypad) {
        if (mod) Atomics.store(shared, MODS, down ? Atomics.load(shared, MODS) | mod : Atomics.load(shared, MODS) & ~mod);
        event(down ? EV.KEY_DOWN : EV.KEY_UP, 0, 0, code, down ? ch : 0, (keypad ? 1 : 0) | (mod ? 2 : 0));
      },
      /** the file the user picked in an answer file dialog (Upload…), read a piece at a time as the worker asks */
      uploading: null,
      /** a reply to a dialog the worker asked for: the button's number (1-based), the text (ask) */
      reply(button, s) {
        Atomics.store(shared, REPLY_LENGTH, putText(s || ""));
        Atomics.store(shared, REPLY_BUTTON, button);
        Atomics.store(shared, REPLY_READY, 1);
        wake();
      },
      /** a line typed into the message box (Return) or a menu item chosen: the text goes in the text area */
      // (the text's place goes as the event's keyCode, its length as extra: PlayerHost.eventText)
      sendText(type, s) { const [at, n] = putEventText(s); event(type, 0, 0, at, 0, n); },
      /** the modifier keys held as an event of the page's own (a menu item clicked) has them: the optionKey a menuMsg asks for
       *  (Window Tools: Option-choosing an open stack closes it), though the keyboard was the open menu's then */
      modifiers(e) { Atomics.store(shared, MODS, mods(e)); },
      /** the keyboard to the stack (after a dialog or the message box) */
      focus: focusKeys,
      /** the card's size in its own pixels (from the frames) */
      cardSize: () => [cardW, cardH],
      /** the card shown at that many screen pixels a card pixel: the worker draws it again at that size */
      setScale(s) {
        const v = Math.max(100, Math.min(16000, Math.round(s * 1000)));
        if (Atomics.load(shared, SCALE) === v) return;
        Atomics.store(shared, SCALE, v); wake();
      },
      EV,
    };
    // a frame with nothing in it: the worker's card canvas (on the graphics card when the card is shown larger) can lose its
    // graphics with its context not lost and no event, as the worker never yields (Royal Game of Ur: after some minutes with
    // the page out of sight every frame came empty, the card fully transparent while the game went on). A card frame is
    // never transparent all over (the card is opaque), so the page looks, once a second at most (a read of the frame
    // made small), and tells the worker (shared word 14 by CANVAS_LOST: worker.js canvasLost), which makes its canvases
    // again and draws the card
    const CANVAS_LOST = 1 << 20;
    let blankChecked = 0, blankCanvas = null, blankWarned = false, blankLater = 0;
    function isBlank(image) {
      if (!blankCanvas) blankCanvas = new OffscreenCanvas(8, 8);
      const c = blankCanvas.getContext("2d", { willReadFrequently: true });
      c.clearRect(0, 0, 8, 8); c.imageSmoothingEnabled = true; c.drawImage(image, 0, 0, 8, 8);
      const d = c.getImageData(0, 0, 8, 8).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
      return true;
    }
    function blankFrame(bitmap) {
      const now = performance.now();
      // a frame inside the second after a look: the card as shown is looked at once that second is over. The frame drawn on
      // the canvas made again came empty too and was the last one (Earth 〜魔法の水晶〜: after a battle with the pane hidden
      // the card stayed white on the map, nothing on it changing, until the next card)
      if (now - blankChecked < 1000) {
        if (!blankLater) blankLater = setTimeout(() => {
          blankLater = 0; blankChecked = performance.now();
          try { if (framed && canvas.width > 0 && isBlank(canvas)) { Atomics.add(shared, REDRAW, CANVAS_LOST); wake(); } } catch (e) {}
        }, 1000 - (now - blankChecked) + 50);
        return false;
      }
      blankChecked = now;
      try {
        if (!isBlank(bitmap)) return false;
        if (!blankWarned) console.warn("A frame of the card came empty: the player's canvas is made again");
        blankWarned = true;
        return true;
      } catch (e) { return false; }
    }
    let frameFailed = false, lastCardBox = "";
    worker.onmessage = (e) => {
      const m = e.data, h = handlers[m.kind];
      if (m.kind === "mic") { micOn(m.on); return; }
      if (m.kind === "save") { // a stack's _stack.xml to keep (PlayerSaving)
        if (keeping) kept.put(m.name, m.fingerprint, m.bytes.buffer, (m.files || []).map((f) => ({ path: f.path, bytes: f.bytes.buffer }))).catch((err) => { console.warn("Could not keep the changes of " + m.name + ": " + err); status("The changes could not be kept in this browser: " + err); });
        return;
      }
      if (m.kind === "keepFile") { // a file the stack wrote or the user brought in (PlayerHost.keepFile)
        if (keeping) kept.putDoc(m.path, m.bytes.buffer).catch((err) => { console.warn("Could not keep " + m.path + ": " + err); status("The file could not be kept in this browser: " + err); });
        return;
      }
      if (m.kind === "uploadPiece") { // answer file's Upload…: a piece of the picked file (api.uploading) as a reply, a byte a word
        const f = api.uploading;
        if (!f) { api.reply(0, ""); return; }
        f.slice(m.at, m.at + m.n).arrayBuffer().then((b) => {
          const u = new Uint8Array(b);
          for (let i = 0; i < u.length; i++) text[i] = u[i];
          Atomics.store(shared, REPLY_LENGTH, u.length); Atomics.store(shared, REPLY_BUTTON, 1); Atomics.store(shared, REPLY_READY, 1); wake();
          if (m.at + m.n >= f.size) api.uploading = null;
        }, () => { api.uploading = null; api.reply(0, ""); });
        return;
      }
      if (m.kind === "download") { // File > Save a Copy…: the stack as an .hzb
        const url = URL.createObjectURL(new Blob([m.bytes], { type: "application/zip" }));
        const a = document.createElement("a"); a.href = url; a.download = m.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
      }
      if (m.kind === "frame") {
        // a frame shown: the worker sends the next (worker.js present: it holds frames back while the page is behind). Counted
        // also when it could not be shown (the browser threw away the canvas's graphics while the page sat hidden): uncounted,
        // two of them held every later frame back and the card stayed blank or frozen while the stack went on. The card is
        // then asked for again (shared word 14), a moment later
        if (m.bitmap && blankFrame(m.bitmap)) { Atomics.add(shared, REDRAW, CANVAS_LOST); wake(); }
        try { if (h) h(m, api); }
        catch (err) {
          if (!frameFailed) console.warn("A frame of the card could not be shown: " + err);
          frameFailed = true;
          try { m.bitmap.close(); } catch (e) {}
          setTimeout(() => { Atomics.add(shared, REDRAW, 1); wake(); }, 250);
        }
        finally { Atomics.add(shared, FRAMES_SHOWN, 1); Atomics.notify(shared, FRAMES_SHOWN); }
        // the card may show at another size or place now: the palettes go with it (and the page's window, in card pixels)
        const r = canvas.getBoundingClientRect();
        if ([r.left, r.top, r.width, cardW].join(",") !== lastCardBox) { lastCardBox = [r.left, r.top, r.width, cardW].join(","); placeFloats(); }
        return;
      }
      if (h) h(m, api); else if (m.kind === "error") status("ERROR " + m.text);
      if (m.kind === "scripterror") console.warn(m.text); // (the player shows it in a dialog too)
      else if (m.kind === "log") console.log(m.text); // the player's own output (?log)
    };
    // frames come from the worker as ImageBitmaps; the card's size from the stack (hz.resize in the worker)
    const screen = canvas.getContext("bitmaprenderer");
    let framed = false, sizedW = 0, sizedH = 0;
    handlers.frame = handlers.frame || ((m) => {
      if (canvas.width !== m.bitmap.width || canvas.height !== m.bitmap.height) { canvas.width = m.bitmap.width; canvas.height = m.bitmap.height; }
      if (m.cardW) { cardW = m.cardW; cardH = m.cardH; }
      screen.transferFromImageBitmap(m.bitmap);
      if (!framed) { framed = true; if (opts.firstFrame) opts.firstFrame(); }
      // the card's size known, or another (a stack of another size): the page fits it to the window
      if (opts.cardSized && (cardW !== sizedW || cardH !== sizedH)) { sizedW = cardW; sizedH = cardH; opts.cardSized(cardW, cardH); }
    });
    // the player's code: the bytes the page downloaded (wasmBytes: its progress bar counted them), else its URL
    worker.postMessage({ kind: "start", shared: sharedBuf, text: textBuf, mic: micBuf, width: canvas.width, height: canvas.height,
      stack: opts.stack || null, name: opts.name || "", args: opts.args || [], wasm: opts.wasm || "player.wasm", wasmBytes: opts.wasmBytes || null,
      catalog: opts.catalog || null, others: opts.others || [], saved, docs: docs.map((d) => ({ path: d.path, bytes: d.bytes })),
      // Java stack traces (patch-runtime.py leaves them out: a throw costs ~10 us with them): ?javastacks=1
      javaStacks: /[?&]javastacks=1/.test(location.search) },
      (opts.stack ? [opts.stack] : []).concat(opts.wasmBytes ? [opts.wasmBytes] : [], opts.catalog ? [opts.catalog.bytes] : [], (opts.others || []).map((o) => o.bytes)));
    // hidden or closing: the player keeps its stacks' changes now (it would wait for the next second's look otherwise)
    if (keeping) {
      const flush = () => event(EV.FLUSH, 0, 0, 0, 0, 0);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
      window.addEventListener("pagehide", flush);
    }
    return api;
  }
  self.HyperZebraPlayer = { start, isolate };
})();
