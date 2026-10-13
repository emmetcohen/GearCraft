// =============================================================================
// app.js — the game controller. Owns the state and wires everything together:
//
//   build (plain data) ──▶ edit-mode analysis (snaps, meshes, predictions)
//                     └─▶ Simulation (only while playing/paused)
//   input (mouse/keys) ──▶ edits to the build / grabs in the simulation
//   every frame        ──▶ renderer.render(scene)
//
// The GAME MODE (src/modes/*) decides the map, default settings, which parts
// are allowed and which controls appear. App itself is mode-agnostic.
// =============================================================================
import { getDef, roleOf } from './parts/partDefs.js';
import { pickPart, socketsOf, outerRadius } from './parts/geometry.js';
import { snapPart } from './parts/snap.js';
import { emptyBuild, cloneBuild, addPart, findPart, removePart } from './core/build.js';
import { buildAssembly, mainKey, hubKey, WORLD } from './physics/assembly.js';
import { solveGearTrain } from './physics/gearTrain.js';
import { Simulation, DT, CRANK_TORQUE } from './physics/world.js';
import { Camera, Renderer } from './render/renderer.js';
import { buildGallery } from './ui/gallery.js';
import { Panel } from './ui/panel.js';
import { showReadout } from './ui/readout.js';

const ROTATE_STEP = Math.PI / 12; // 15°

export class App {
  constructor(mode) {
    this.mode = mode;
    this.build = emptyBuild();
    this.settings = { ...mode.defaultSettings };
    this.options = { loadView: false, grid: true, autoPin: true };
    this.state = 'edit';        // 'edit' | 'playing' | 'paused'
    this.sim = null;            // Simulation while playing/paused
    this.preplay = null;        // copy of the build from before Play (for Reset)
    this.selectedUid = null;
    this.armedType = null;      // gallery part waiting for a click (click-to-place)
    this.drag = null;           // current pointer gesture
    this.ghost = null;          // placement preview
    this.placedAt = new Map();  // uid -> time placed (for the squash animation)
    this.analysis = null;       // cached edit-mode assembly + gear train
    this.listeners = [];        // (event) => void, for modes/panels
  }

  // =============================================================== startup ==
  start() {
    this.canvas = document.getElementById('world');
    this.camera = new Camera(0, 5, 36);
    this.renderer = new Renderer(this.canvas, this.camera);
    this.readoutEl = document.getElementById('readout');
    this.toastEl = document.getElementById('toast');

    this.gallery = buildGallery(document.getElementById('gallery'), {
      onDragStart: (type, e) => this._beginGalleryDrag(type, e),
    }, this.mode.partFilter);
    this.panel = new Panel(document.getElementById('panel'));
    this.mode.setup(this);

    this._bindTopbar();
    this._bindCanvas();
    this._bindKeys();
    window.addEventListener('resize', () => this.renderer.resize());
    this.renderer.resize();
    document.fonts?.ready.then(() => this.gallery.redraw());

    this.changed();
    let last = performance.now(), acc = 0;
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (this.state === 'playing') {
        acc += dt;
        let steps = 0;
        while (acc >= DT && steps < 12) { this.sim.step(DT); acc -= DT; steps++; }
        if (steps === 12) acc = 0; // too slow: drop time rather than spiral
      }
      this._render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /** Subscribe to app events ('changed', 'state', 'select'). */
  on(fn) { this.listeners.push(fn); }
  emit(type) { for (const fn of this.listeners) fn(type); }

  // ========================================================= build editing ==
  /** Call after any change to the build. */
  changed() {
    this.analysis = null;
    this.emit('changed');
  }

  /** The build changed in a way worth an undo step. */
  commit() {
    this.changed();
  }

  get editable() { return this.state === 'edit'; }

  _analysis() {
    if (!this.analysis) {
      const assembly = buildAssembly(this.build.parts);
      const train = solveGearTrain(this.build.parts, assembly);
      this.analysis = { assembly, train };
    }
    return this.analysis;
  }

  placePart(type, x, y, angle = 0) {
    const snap = snapPart(this.build.parts, type, x, y, angle, { grid: this.options.grid });
    const part = addPart(this.build, type, snap.x, snap.y, snap.angle);
    this.placedAt.set(part.uid, performance.now());
    const def = getDef(type);
    // Convenience: a gear dropped in empty space gets a rotating pin, so it
    // stays put and can spin. (Toggle "Auto-pin gears" to turn this off.)
    if (this.options.autoPin && (def.kind === 'gear' || def.kind === 'compoundGear') &&
        !this._hasMountAt(part)) {
      const pinType = this.mode.autoPinType;
      if (pinType) addPart(this.build, pinType, part.x, part.y, 0);
    }
    this.select(part.uid);
    this.commit();
    return part;
  }

  /** Is there something at this part's centre that it could spin on? */
  _hasMountAt(part) {
    return this.build.parts.some((p) => p.uid !== part.uid &&
      socketsOf(p).some((s) => Math.hypot(s.x - part.x, s.y - part.y) < 0.12));
  }

  /** Connectors sitting on this part's centre that nothing else uses
   *  (e.g. the auto-pin under a gear). They move/delete with the part. */
  _passengers(part) {
    const role = roleOf(getDef(part.type).kind);
    if (role !== 'rotor' && role !== 'driver') return [];
    const at = (p) => Math.hypot(p.x - part.x, p.y - part.y) < 0.12;
    const others = this.build.parts.filter((p) => p.uid !== part.uid);
    const sharers = others.filter((p) => roleOf(getDef(p.type).kind) !== 'connector' &&
      socketsOf(p).some((s) => Math.hypot(s.x - part.x, s.y - part.y) < 0.12));
    if (sharers.length) return [];
    return others.filter((p) => roleOf(getDef(p.type).kind) === 'connector' && at(p));
  }

  deleteSelected() {
    if (!this.editable || this.selectedUid == null) return;
    const part = findPart(this.build, this.selectedUid);
    if (!part) return;
    for (const p of this._passengers(part)) removePart(this.build, p.uid);
    removePart(this.build, part.uid);
    this.select(null);
    this.commit();
  }

  rotateSelected(dir) {
    if (!this.editable || this.selectedUid == null) return;
    const part = findPart(this.build, this.selectedUid);
    if (!part) return;
    part.angle += dir * ROTATE_STEP;
    this.placedAt.set(part.uid, performance.now());
    this.commit();
  }

  /** Set a per-part property (e.g. motor direction). */
  setPartProp(uid, key, value) {
    const part = findPart(this.build, uid);
    if (!part || !this.editable) return;
    part.props[key] = value;
    this.commit();
  }

  select(uid) {
    this.selectedUid = uid;
    this.emit('select');
  }

  /** Replace the whole build (load, undo...). */
  setBuild(build) {
    if (this.state !== 'edit') this.reset();
    this.build = build;
    this.select(null);
    this.changed();
  }

  // ============================================================ play state ==
  play() {
    if (this.state === 'playing') return;
    if (this.state === 'edit') {
      this.preplay = cloneBuild(this.build);
      this.sim = new Simulation(this.build, this.settings, this.mode.map);
      for (const w of this.sim.assembly.warnings) this.toast(w);
    }
    this._cancelPlacement();
    this.state = 'playing';
    this.emit('state');
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.sim?.release();
    this.emit('state');
  }

  /** Back to the exact pre-play build. */
  reset() {
    if (this.state === 'edit') return;
    this.sim = null;
    this.build = this.preplay;
    this.preplay = null;
    this.state = 'edit';
    this.drag = null;
    this.changed();
    this.emit('state');
  }

  setSetting(key, value) {
    this.settings[key] = value;
    this.sim?.applySettings(this.settings);
    this.emit('settings');
  }

  // ============================================================== queries ==
  /** Parts as they currently are (live physics positions while playing). */
  livePart(part) {
    if (!this.sim) return part;
    const t = this.sim.transformOf(part.uid);
    return t ? { ...part, x: t.x, y: t.y, angle: t.angle } : part;
  }

  transformOf(uid, layer = 'main') {
    if (this.sim) return this.sim.transformOf(uid, layer);
    const p = findPart(this.build, uid);
    return p ? { x: p.x, y: p.y, angle: p.angle } : null;
  }

  /** Readout for the selected part: live numbers while playing, predictions while editing. */
  readoutFor(uid) {
    const part = findPart(this.sim ? { parts: this.sim.parts } : this.build, uid);
    if (!part) return null;
    const def = getDef(part.type);
    const role = roleOf(def.kind);
    if (role !== 'rotor' && role !== 'driver') {
      return { name: def.name, note: def.tip ?? null };
    }
    if (this.sim) {
      const r = this.sim.readout(uid);
      const note = r.jammed ? '⛔ Jammed: these gears lock each other.'
        : r.stalled ? '🛑 Stalled: the load needs more torque than the motor has.'
        : r.driverUid == null ? (r.mounted ? 'Not powered.' : 'Not on an axle.') : null;
      return { name: def.name, live: true, rpm: r.rpm, torque: r.torque, ratio: r.ratio,
        load: r.driverUid != null ? r.load : null, note };
    }
    // Edit mode: predict from the gear-train graph.
    const { assembly, train } = this._analysis();
    const key = role === 'driver' ? hubKey(uid) : mainKey(uid);
    const bodyId = assembly.bodyOf(key);
    const drive = train.driveOf(bodyId);
    if (!drive || drive.driverUid == null) {
      const mounted = bodyId === WORLD || assembly.axleOf(bodyId);
      return { name: def.name, ratio: null,
        note: drive?.jammed ? '⛔ This gear train is jammed.' : mounted ? 'Not connected to a motor or crank yet.' : 'No axle: put it on a pin, beam hole or motor.' };
    }
    const driver = findPart(this.build, drive.driverUid);
    const dkind = getDef(driver.type).kind;
    if (drive.jammed) return { name: def.name, ratio: drive.ratio, note: '⛔ This gear train is jammed and won’t turn.' };
    if (dkind === 'crank') {
      return { name: def.name, ratio: drive.ratio, torque: CRANK_TORQUE / Math.abs(drive.ratio),
        note: 'Driven by a hand crank: press Play and drag the crank handle.' };
    }
    const dir = driver.props.reverse ? -1 : 1;
    return { name: def.name, ratio: drive.ratio,
      rpm: this.settings.motorRpm * dir * drive.ratio,
      torque: this.settings.motorTorque / Math.abs(drive.ratio),
      note: 'Prediction. Press Play to see it under real load.' };
  }

  // ============================================================== drawing ==
  _render() {
    const now = performance.now();
    const parts = this.sim ? this.sim.parts : this.build.parts;
    const labels = [];
    let meshes = [];

    if (this.sim) {
      for (const [uid, t] of this.sim.telemetry) {
        if (!t.stalled) continue;
        const tr = this.sim.transformOf(uid);
        labels.push({ x: tr.x, y: tr.y + 1.1, text: t.jammed ? '⛔ JAMMED' : '🛑 STALLED', color: '#ff8fa3' });
      }
    } else {
      const { train } = this._analysis();
      meshes = train.meshes.map((m) => ({ ...m, jammed: m.component >= 0 && train.components[m.component].jammed }));
      for (const uid of train.floatingGears) {
        const p = findPart(this.build, uid);
        if (p) labels.push({ x: p.x, y: p.y + outerRadius(getDef(p.type)) + 0.5, text: '❗ no axle', color: '#ffe066' });
      }
      for (const c of train.components) {
        if (!c.jammed) continue;
        const b = c.bodies.find((id) => id !== WORLD);
        const asm = this.analysis.assembly;
        const key = asm.bodies.find((x) => x.id === b)?.keys[0];
        const p = key && findPart(this.build, asm.elements.get(key).uid);
        if (p) labels.push({ x: p.x, y: p.y + 0.6, text: `⛔ ${c.reason}`, color: '#ff8fa3' });
      }
    }

    this.renderer.render({
      parts, mode: this.state === 'edit' ? 'edit' : 'play', map: this.mode.map,
      transformOf: (uid, layer) => this.transformOf(uid, layer),
      loadOf: (uid) => (this.options.loadView && this.sim ? this.sim.loadOf(uid) : null),
      loadView: this.options.loadView,
      squashOf: (uid) => {
        const t0 = this.placedAt.get(uid);
        if (t0 == null) return 0;
        const t = (now - t0) / 1000;
        if (t > 0.6) { this.placedAt.delete(uid); return 0; }
        return 0.22 * Math.exp(-t * 8) * Math.cos(t * 26); // squash, bounce, settle
      },
      selectedUid: this.selectedUid,
      ghost: this.ghost,
      meshes, labels,
    });

    // Readout card beside the selected part.
    if (this.selectedUid != null && this.transformOf(this.selectedUid)) {
      const t = this.transformOf(this.selectedUid);
      const s = this.camera.worldToScreen(t.x, t.y);
      showReadout(this.readoutEl, this.readoutFor(this.selectedUid), s);
    } else {
      showReadout(this.readoutEl, null);
    }
  }

  toast(text, ms = 2200) {
    const el = this.toastEl;
    el.textContent = text;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth; // restart the pop animation
    el.style.animation = '';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ================================================================ input ==
  _bindTopbar() {
    const $ = (id) => document.getElementById(id);
    $('btn-play').addEventListener('click', () => this.play());
    $('btn-pause').addEventListener('click', () => this.pause());
    $('btn-reset').addEventListener('click', () => this.reset());
    $('btn-zoom-in').addEventListener('click', () => this.camera.zoomAt(this.camera.w / 2, this.camera.h / 2, 1.25));
    $('btn-zoom-out').addEventListener('click', () => this.camera.zoomAt(this.camera.w / 2, this.camera.h / 2, 0.8));
    $('btn-home').addEventListener('click', () => this.recenter());
    const sync = () => {
      $('btn-play').disabled = this.state === 'playing';
      $('btn-pause').disabled = this.state !== 'playing';
      $('btn-reset').disabled = this.state === 'edit';
      $('status').textContent = { edit: '✏️ Editing', playing: '▶ Running', paused: '⏸ Paused' }[this.state];
      document.body.dataset.state = this.state;
    };
    this.on((type) => { if (type === 'state') sync(); });
    sync();
  }

  recenter() {
    this.camera.x = 0; this.camera.y = 5; this.camera.zoom = 36;
  }

  _worldAt(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.camera.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  }

  _overCanvas(e) {
    const r = this.canvas.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  /** Pick a part under the pointer (using live positions while playing). */
  _pick(w) {
    const parts = (this.sim ? this.sim.parts : this.build.parts).map((p) => this.livePart(p));
    return pickPart(parts, w.x, w.y);
  }

  _bindCanvas() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const w = this._worldAt(e);
      const sx = e.clientX, sy = e.clientY;
      // Middle/right button or space-drag always pans.
      if (e.button === 1 || e.button === 2) {
        this.drag = { kind: 'pan', sx, sy, cx: this.camera.x, cy: this.camera.y };
        cv.classList.add('panning');
        return;
      }
      // Click-to-place an armed gallery part.
      if (this.armedType) {
        if (this.editable) this.placePart(this.armedType, w.x, w.y, 0);
        else this.toast('Press ⟲ Reset to edit your build');
        if (!e.shiftKey) this._cancelPlacement(); // hold Shift to keep placing
        return;
      }
      const hit = this._pick(w);
      if (this.sim) {
        // While running: cranks can be turned, loose bodies grabbed.
        if (hit) this.select(hit.uid);
        if (this.state === 'playing' && hit && getDef(hit.type).kind === 'crank') {
          this.sim.grabCrank(hit.uid, w);
          this.drag = { kind: 'sim' };
          return;
        }
        if (this.state === 'playing' && this.sim.grabBodyAt(w)) {
          this.drag = { kind: 'sim' };
          return;
        }
        if (!hit) this.select(null);
        this.drag = { kind: 'pan', sx, sy, cx: this.camera.x, cy: this.camera.y };
        return;
      }
      if (hit) {
        this.select(hit.uid);
        const passengers = this._passengers(hit).map((p) => ({ p, dx: p.x - hit.x, dy: p.y - hit.y }));
        this.drag = { kind: 'move', uid: hit.uid, ox: hit.x - w.x, oy: hit.y - w.y, sx, sy, moved: false, passengers };
      } else {
        this.select(null);
        this.drag = { kind: 'pan', sx, sy, cx: this.camera.x, cy: this.camera.y };
        cv.classList.add('panning');
      }
    });

    cv.addEventListener('pointermove', (e) => {
      const w = this._worldAt(e);
      const d = this.drag;
      if (!d) {
        // Hover preview for click-to-place.
        if (this.armedType && this.editable) this._updateGhost(this.armedType, w);
        return;
      }
      if (d.kind === 'pan') {
        this.camera.x = d.cx - (e.clientX - d.sx) / this.camera.zoom;
        this.camera.y = d.cy + (e.clientY - d.sy) / this.camera.zoom;
      } else if (d.kind === 'sim') {
        this.sim.dragTo(w);
      } else if (d.kind === 'move') {
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
        d.moved = true;
        const part = findPart(this.build, d.uid);
        const ignore = new Set([d.uid, ...d.passengers.map((q) => q.p.uid)]);
        const others = this.build.parts.filter((p) => !ignore.has(p.uid));
        const snap = snapPart(others, part.type, w.x + d.ox, w.y + d.oy, part.angle, { grid: this.options.grid });
        part.x = snap.x; part.y = snap.y; part.angle = snap.angle;
        for (const q of d.passengers) { q.p.x = part.x + q.dx; q.p.y = part.y + q.dy; }
        this.ghost = snap.hint ? { type: part.type, x: part.x, y: part.y, angle: part.angle, hint: snap.hint, hintOnly: true } : null;
        this.changed();
      }
    });

    const end = () => {
      const d = this.drag;
      this.drag = null;
      cv.classList.remove('panning');
      if (!d) return;
      if (d.kind === 'sim') this.sim?.release();
      if (d.kind === 'move' && d.moved) {
        this.placedAt.set(d.uid, performance.now());
        this.ghost = null;
        this.commit();
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.drag && this.armedType) this.ghost = null; });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      this.camera.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
  }

  _updateGhost(type, w) {
    const snap = snapPart(this.build.parts, type, w.x, w.y, 0, { grid: this.options.grid });
    this.ghost = { type, x: snap.x, y: snap.y, angle: snap.angle, hint: snap.hint };
  }

  /** Drag from the gallery: track the pointer over the whole window. */
  _beginGalleryDrag(type, e) {
    if (!this.editable) { this.toast('Press ⟲ Reset to edit your build'); return; }
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) moved = true;
      if (moved && this._overCanvas(ev)) this._updateGhost(type, this._worldAt(ev));
      else if (moved) this.ghost = null;
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved && this._overCanvas(ev)) {
        const w = this._worldAt(ev);
        this.placePart(type, w.x, w.y, 0);
        this._cancelPlacement();
      } else if (!moved) {
        // A plain click arms the part: click in the world to place it.
        if (this.armedType === type) this._cancelPlacement();
        else { this.armedType = type; this.gallery.setArmed(type); this.toast(`Click in the world to place ${getDef(type).name} (Shift = keep placing)`); }
      } else {
        this.ghost = null;
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _cancelPlacement() {
    this.armedType = null;
    this.ghost = null;
    this.gallery.setArmed(null);
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, dialog')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (k === ' ') {
        e.preventDefault();
        if (this.state === 'playing') this.pause(); else this.play();
      } else if (k === 'escape') {
        this._cancelPlacement();
        this.select(null);
      } else if ((k === 'delete' || k === 'backspace') && !mod) {
        e.preventDefault();
        this.deleteSelected();
      } else if (!mod && (k === 'e' || (k === 'r' && !e.shiftKey && this.editable))) {
        this.rotateSelected(-1); // clockwise
      } else if (!mod && (k === 'q' || (k === 'r' && e.shiftKey))) {
        this.rotateSelected(1);  // counter-clockwise
      } else if (k === 'r' && !mod && !this.editable) {
        this.reset();
      } else if (k === 'home') {
        this.recenter();
      } else {
        this.mode.onKey?.(this, e);
      }
    });
  }
}
