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
import { getDef, partDef, roleOf, chainTeeth, chainRadius, HOLE_SPACING } from './parts/partDefs.js';
import { pickPart, partsAt, socketsOf, outerRadius, lineEnds, lineFrom } from './parts/geometry.js';
import { snapPart, snapEnd, snapDrawEnd } from './parts/snap.js';
import { emptyBuild, cloneBuild, addPart, findPart, removePart } from './core/build.js';
import { buildAssembly, mainKey, hubKey, WORLD } from './physics/assembly.js';
import { solveGearTrain } from './physics/gearTrain.js';
import { Simulation, DT, CRANK_TORQUE } from './physics/world.js';
import { Camera, Renderer } from './render/renderer.js';
import { chainPath } from './render/draw.js';
import { buildGallery, drawThumb } from './ui/gallery.js';
import { Panel } from './ui/panel.js';
import { showReadout } from './ui/readout.js';
import { History } from './core/history.js';
import { autosave, loadAutosave } from './save/storage.js';
import { createSaveDialog } from './ui/saveDialog.js';

const ROTATE_STEP = Math.PI / 12; // 15°

/** Keyboard shortcuts for picking a tool (edit mode). */
export const HOTKEYS = {
  beam: 'B', axle: 'A', hinge: 'H', 'pin-rotating': 'P', 'pin-fixed': 'F',
  chain: 'C', spring: 'S', rope: 'O', slider: 'J', track: 'T',
};
/** The tool dock under the world, left to right. null = Select. */
const DOCK = [null, 'beam', 'axle', 'hinge', 'pin-rotating', 'pin-fixed', 'chain', 'spring', 'rope', 'slider', 'track'];
const HANDLE_PX = 11; // how close (pixels) you must press to grab a stretch handle

export class App {
  constructor(mode) {
    this.mode = mode;
    this.build = emptyBuild();
    this.settings = { ...mode.defaultSettings };
    this.options = { loadView: false, grid: true, autoPin: true, joints: true };
    this.state = 'edit';        // 'edit' | 'playing' | 'paused'
    this.sim = null;            // Simulation while playing/paused
    this.preplay = null;        // copy of the build from before Play (for Reset)
    this.selectedUid = null;
    this.armedType = null;      // current TOOL: a part id that stays picked until Esc
    this.drag = null;           // current pointer gesture
    this.ghost = null;          // placement preview
    this.drawing = null;        // click-click drawing in progress: { type, a }
    this.drawStart = null;      // where a drawing tool would start (hover dot)
    this.chainPick = null;      // chain tool: first sprocket picked
    this.hoverUid = null;       // part under the pointer (edit mode)
    this.showInfo = false;      // readout card: only after you CLICK a part
    this.keys = new Set();      // arrow keys held (driving key motors)
    this.placedAt = new Map();  // uid -> time placed (for the squash animation)
    this.analysis = null;       // cached edit-mode assembly + gear train
    this.listeners = [];        // (event) => void, for modes/panels
    this.history = new History();
  }

  // =============================================================== startup ==
  start() {
    this.canvas = document.getElementById('world');
    this.camera = new Camera(0, 5, 36);
    this.renderer = new Renderer(this.canvas, this.camera);
    this.readoutEl = document.getElementById('readout');
    this.toastEl = document.getElementById('toast');

    this.toolChipEl = document.getElementById('tool-chip');
    this.gallery = buildGallery(document.getElementById('gallery'), {
      onDragStart: (type, e) => this._beginGalleryDrag(type, e),
    }, this.mode.partFilter, HOTKEYS);
    this._buildDock();
    this.panel = new Panel(document.getElementById('panel'));
    this.mode.setup(this);

    this._bindTopbar();
    this._bindCanvas();
    this._bindKeys();
    window.addEventListener('resize', () => this.renderer.resize());
    this.renderer.resize();
    document.fonts?.ready.then(() => this.gallery.redraw());
    window.addEventListener('blur', () => { this.keys.clear(); this._syncThrottle(); });

    // Pick up where you left off, or start with the mode's starter build.
    const saved = loadAutosave();
    if (saved) this.build = saved;
    else if (this.mode.starter) {
      const st = this.mode.starter();
      this.build = st.build;
      if (st.camera) Object.assign(this.camera, st.camera);
    }
    this.history.reset(this.build);
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
    this.history.push(this.build);
    // Autosave shortly after edits settle.
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => autosave(this.build), 400);
    this.changed();
    this.emit('history');
  }

  undo() { this._travel(() => this.history.undo(), 'Nothing to undo'); }
  redo() { this._travel(() => this.history.redo(), 'Nothing to redo'); }

  _travel(step, emptyMsg) {
    if (!this.editable) { this.toast('Press ⟲ Reset first, then undo'); return; }
    const build = step();
    if (!build) { this.toast(emptyMsg); return; }
    this.build = build;
    if (this.selectedUid != null && !findPart(build, this.selectedUid)) this.select(null);
    this.changed();
    this.emit('history');
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
    if (this.options.autoPin && (def.kind === 'gear' || def.kind === 'compoundGear' || def.kind === 'sprocket') &&
        !this._hasMountAt(part)) {
      const pinType = this.mode.autoPinType;
      if (pinType) addPart(this.build, pinType, part.x, part.y, 0);
    }
    this.commit();
    return part;
  }

  /** Add a drawn part (beam, spring, track...) from end a to end b. */
  placeDrawn(type, a, b) {
    const l = lineFrom(a, b);
    const part = addPart(this.build, type, l.x, l.y, l.angle, { length: +l.length.toFixed(4) });
    this.placedAt.set(part.uid, performance.now());
    this.commit();
    return part;
  }

  /** Link two sprockets/gears with a chain. */
  placeChain(uidA, uidB) {
    const exists = this.build.parts.some((p) => getDef(p.type).kind === 'chain' &&
      ((p.props.a === uidA && p.props.b === uidB) || (p.props.a === uidB && p.props.b === uidA)));
    if (exists) { this.toast('Those two are already chained'); return null; }
    const pa = findPart(this.build, uidA), pb = findPart(this.build, uidB);
    const ra = chainRadius(getDef(pa.type)), rb = chainRadius(getDef(pb.type));
    if (Math.hypot(pb.x - pa.x, pb.y - pa.y) <= Math.abs(ra - rb) + 0.3) {
      this.toast('Too close: move them apart first');
      return null;
    }
    const part = addPart(this.build, 'chain', (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, 0, { a: uidA, b: uidB });
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
    const gone = new Set([part.uid, ...this._passengers(part).map((p) => p.uid)]);
    // Chains attached to a deleted sprocket go too.
    for (const p of this.build.parts) {
      if (getDef(p.type).kind === 'chain' && (gone.has(p.props.a) || gone.has(p.props.b))) gone.add(p.uid);
    }
    for (const uid of gone) removePart(this.build, uid);
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
    if (uid !== this.selectedUid) this.showInfo = false;
    this.selectedUid = uid;
    this.emit('select');
  }

  /** Replace the whole build (e.g. loading a save). Undoable. */
  setBuild(build) {
    if (this.state !== 'edit') this.reset();
    this.build = build;
    this.select(null);
    this.commit();
  }

  // ============================================================ play state ==
  play() {
    if (this.state === 'playing') return;
    if (this.state === 'edit') {
      this.preplay = cloneBuild(this.build);
      this.sim = new Simulation(this.build, this.settings, this.mode.map);
      for (const w of this.sim.assembly.warnings) this.toast(w);
      if (this.sim.hasKeyMotors) this.toast('🎮 Hold ← / → to drive your motors', 3500);
      this._syncThrottle();
    }
    this._cancelPlacement();
    this.hoverUid = null;
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
    this.showInfo = false;
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
    const kind = getDef(part.type).kind;
    if (kind === 'spring' || kind === 'rope') {
      const ends = this.sim.linkEnds(part.uid);
      if (!ends) return part;
      const l = lineFrom(ends[0], ends[1]);
      return { ...part, x: l.x, y: l.y, angle: l.angle, props: { ...part.props, length: l.length } };
    }
    // A crank's clickable arm is on its spinning hub, so use the hub's angle.
    const layer = getDef(part.type).kind === 'crank' ? 'hub' : 'main';
    const t = this.sim.transformOf(part.uid, layer);
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
    // Only parts with numbers worth showing get a card (the panel has the rest).
    if (role !== 'rotor' && role !== 'driver') return null;
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
    let joints = null;
    const badChains = new Set();
    const skyPins = [];

    if (this.sim) {
      for (const [uid, t] of this.sim.telemetry) {
        if (!t.stalled) continue;
        const tr = this.sim.transformOf(uid);
        labels.push({ x: tr.x, y: tr.y + 1.1, text: t.jammed ? '⛔ JAMMED' : '🛑 STALLED', color: '#ff8fa3' });
      }
    } else {
      const { train, assembly } = this._analysis();
      meshes = train.meshes.map((m) => ({ ...m, jammed: m.component >= 0 && train.components[m.component].jammed }));
      for (const m of meshes) if (m.chain && (m.status !== 'ok' || m.jammed)) badChains.add(m.uid);
      if (this.options.joints) joints = assembly.joints;
      // Spring/rope ends touching nothing hang on the background: show a pin there.
      for (const p of this.build.parts) {
        const k = getDef(p.type).kind;
        if (k !== 'spring' && k !== 'rope') continue;
        for (const e of lineEnds(p)) {
          const solid = this.build.parts.filter((q) => roleOf(getDef(q.type).kind) !== 'link');
          const onSocket = solid.some((q) => socketsOf(q).some((so) => Math.hypot(so.x - e.x, so.y - e.y) < 0.12));
          if (!onSocket && !pickPart(solid, e.x, e.y)) skyPins.push(e);
        }
      }
      for (const uid of train.floatingGears) {
        const p = findPart(this.build, uid);
        if (p) labels.push({ x: p.x, y: p.y + outerRadius(getDef(p.type)) + 0.5, text: '❗ no axle', color: '#ffe066' });
      }
      for (const c of train.components) {
        if (!c.jammed) continue;
        const b = c.bodies.find((id) => id !== WORLD);
        const key = assembly.bodies.find((x) => x.id === b)?.keys[0];
        const p = key && findPart(this.build, assembly.elements.get(key).uid);
        if (p) labels.push({ x: p.x, y: p.y + 0.6, text: `⛔ ${c.reason}`, color: '#ff8fa3' });
      }
    }

    const d = this.drag;
    const editing = this.editable;
    const placing = editing && (this.armedType || this.drawing ||
      (d && (d.kind === 'draw' || d.kind === 'stretch' || (d.kind === 'move' && d.moved))) || this._galleryDragging);
    const selPart = editing && this.selectedUid != null ? findPart(this.build, this.selectedUid) : null;
    const handles = selPart && partDef(selPart).drawn && !(d && d.kind === 'move' && d.moved) ? lineEnds(selPart) : [];

    this.renderer.render({
      parts, mode: editing ? 'edit' : 'play', map: this.mode.map, grid: this.options.grid,
      transformOf: (uid, layer) => this.transformOf(uid, layer),
      linkEndsOf: (uid) => (this.sim ? this.sim.linkEnds(uid) : null),
      loadOf: (uid) => (this.options.loadView && this.sim ? this.sim.loadOf(uid) : null),
      loadView: this.options.loadView && !!this.sim, // load colours only mean something while running
      squashOf: (uid) => {
        const t0 = this.placedAt.get(uid);
        if (t0 == null) return 0;
        const t = (now - t0) / 1000;
        if (t > 0.6) { this.placedAt.delete(uid); return 0; }
        return 0.22 * Math.exp(-t * 8) * Math.cos(t * 26); // squash, bounce, settle
      },
      selectedUid: this.selectedUid,
      hoverUid: editing && !d ? this.hoverUid : null,
      pickedUid: this.chainPick,
      ghost: this.ghost,
      drawStart: editing && !d ? (this.drawing ? null : this.drawStart) : null,
      showSockets: !!placing,
      handles, joints, badChains, skyPins,
      meshes, labels,
    });

    // Readout card beside the selected part — only after you clicked it,
    // never just because you placed or dragged something.
    const t = this.selectedUid != null ? this.transformOf(this.selectedUid) : null;
    if (t) {
      let s = this.camera.worldToScreen(t.x, t.y);
      // While running, gently keep the selected part in view (select your
      // car's chassis and the camera follows it). Not while you're dragging.
      if (this.state === 'playing' && !this.drag) {
        const cam = this.camera, mx = cam.w * 0.25, my = cam.h * 0.25;
        const dx = s.x < mx ? s.x - mx : s.x > cam.w - mx ? s.x - (cam.w - mx) : 0;
        const dy = s.y < my ? s.y - my : s.y > cam.h - my ? s.y - (cam.h - my) : 0;
        cam.x += (dx / cam.zoom) * 0.15;
        cam.y -= (dy / cam.zoom) * 0.15;
        s = cam.worldToScreen(t.x, t.y);
      }
      const sel = (this.sim ? this.sim.parts : this.build.parts).find((p) => p.uid === this.selectedUid);
      const def = sel && partDef(sel);
      const r = def ? (def.drawn ? def.thickness : outerRadius(def)) * this.camera.zoom : 0;
      showReadout(this.readoutEl, this.showInfo && !this.drag ? this.readoutFor(this.selectedUid) : null, s, r);
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

    // Undo / redo buttons live in the top bar's edit-tools group.
    const tools = $('edit-tools');
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      tools.appendChild(b);
      return b;
    };
    const undoBtn = mk('↶ Undo', 'Undo (Ctrl/⌘+Z)', () => this.undo());
    const redoBtn = mk('↷ Redo', 'Redo (Ctrl/⌘+Shift+Z)', () => this.redo());
    this.addTopbarButton = mk;
    const saveDialog = createSaveDialog(this);
    this.openSaveDialog = () => saveDialog.open();
    mk('💾 Save / Load', 'Save, load, examples, export & import (Ctrl/⌘+S)', () => saveDialog.open());
    const clearBtn = mk('🧹 Clear', 'Start a new empty build (undoable)', () => {
      if (!this.build.parts.length) return;
      this.setBuild(emptyBuild());
      this.currentName = null;
      this.toast('Cleared. Undo brings it back.');
    });
    this.on((type) => { if (type === 'state') clearBtn.disabled = !this.editable; });
    const syncHistory = () => {
      undoBtn.disabled = !this.editable || !this.history.canUndo;
      redoBtn.disabled = !this.editable || !this.history.canRedo;
    };
    this.on((type) => { if (type === 'history' || type === 'state') syncHistory(); });
    syncHistory();
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
    const hit = pickPart(parts, w.x, w.y);
    if (hit && roleOf(getDef(hit.type).kind) !== 'beam' && roleOf(getDef(hit.type).kind) !== 'object') return hit;
    return this._pickChain(parts, w) || hit;
  }

  /** A chain whose straight runs pass under the pointer. */
  _pickChain(parts, w) {
    const byUid = new Map(parts.map((p) => [p.uid, p]));
    const segDist = (p, a, b) => {
      const vx = b.x - a.x, vy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
    };
    for (const p of parts) {
      if (getDef(p.type).kind !== 'chain') continue;
      const pa = byUid.get(p.props.a), pb = byUid.get(p.props.b);
      if (!pa || !pb) continue;
      const path = chainPath({ x: pa.x, y: pa.y, r: chainRadius(getDef(pa.type)) }, { x: pb.x, y: pb.y, r: chainRadius(getDef(pb.type)) });
      if (path && (segDist(w, path.a1, path.b1) < 0.2 || segDist(w, path.a2, path.b2) < 0.2)) return p;
    }
    return null;
  }

  _bindCanvas() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const w = this._worldAt(e);
      const sx = e.clientX, sy = e.clientY;
      // Middle/right button pans. A right CLICK (no drag) also puts the tool down.
      if (e.button === 1 || e.button === 2) {
        this.drag = { kind: 'pan', sx, sy, cx: this.camera.x, cy: this.camera.y, cancelTool: e.button === 2 };
        cv.classList.add('panning');
        return;
      }
      if (this.sim) {
        const hit = this._pick(w);
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
        this.drag = { kind: 'pan', sx, sy, cx: this.camera.x, cy: this.camera.y, clickUid: hit?.uid ?? null };
        return;
      }
      if (this.armedType) { this._toolDown(w, e); return; }

      // Stretch handle of the selected drawn part?
      const sel = this.selectedUid != null ? findPart(this.build, this.selectedUid) : null;
      if (sel && partDef(sel).drawn) {
        const ends = lineEnds(sel);
        for (let i = 0; i < 2; i++) {
          const s = this.camera.worldToScreen(ends[i].x, ends[i].y);
          const r = this.canvas.getBoundingClientRect();
          if (Math.hypot(s.x - (sx - r.left), s.y - (sy - r.top)) < HANDLE_PX) {
            this.drag = { kind: 'stretch', uid: sel.uid, fixed: ends[1 - i], end: i, moved: false,
              stack: partsAt(this.build.parts, w.x, w.y) };
            return;
          }
        }
      }

      let hit = this._pick(w);
      // Clicking the selected part again picks the next one stacked under
      // the pointer (e.g. the motor hidden under its wheel).
      const stack = partsAt(this.build.parts, w.x, w.y);
      const wasSelected = hit && this.selectedUid != null && stack.some((p) => p.uid === this.selectedUid);
      if (hit && wasSelected) hit = findPart(this.build, this.selectedUid);
      if (hit) {
        this.select(hit.uid);
        const passengers = this._passengers(hit).map((p) => ({ p, dx: p.x - hit.x, dy: p.y - hit.y }));
        this.drag = { kind: 'move', uid: hit.uid, ox: hit.x - w.x, oy: hit.y - w.y, sx, sy, moved: false, passengers,
          stack: wasSelected ? stack : null };
      } else {
        this.select(null);
        this.drag = { kind: 'pan', sx, sy, cx: this.camera.x, cy: this.camera.y };
        cv.classList.add('panning');
      }
    });

    cv.addEventListener('pointermove', (e) => {
      const w = this._worldAt(e);
      const d = this.drag;
      if (!d) { this._hover(w); return; }
      if (d.kind === 'pan') {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) { d.cancelTool = false; d.clickUid = null; }
        this.camera.x = d.cx - (e.clientX - d.sx) / this.camera.zoom;
        this.camera.y = d.cy + (e.clientY - d.sy) / this.camera.zoom;
      } else if (d.kind === 'sim') {
        this.sim.dragTo(w);
      } else if (d.kind === 'draw') {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6) d.moved = true;
        this._drawPreview(d.type, d.a, w, e);
      } else if (d.kind === 'stretch') {
        d.moved = true;
        const part = findPart(this.build, d.uid);
        const kind = getDef(part.type).kind;
        const others = this.build.parts.filter((p) => p.uid !== part.uid);
        const end = snapDrawEnd(others, kind, d.fixed, w, { freeAngle: e.altKey });
        const [a, b] = d.end === 1 ? [d.fixed, end] : [end, d.fixed];
        const l = lineFrom(a, b);
        Object.assign(part, { x: l.x, y: l.y, angle: l.angle });
        part.props.length = +l.length.toFixed(4);
        this.ghost = { type: part.type, x: l.x, y: l.y, angle: l.angle, hintOnly: true, hint: end.hint,
          label: this._lengthLabel(part.type, l.length), labelAt: end };
        this.changed();
      } else if (d.kind === 'move') {
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
        d.moved = true;
        this.showInfo = false;
        const part = findPart(this.build, d.uid);
        const ignore = new Set([d.uid, ...d.passengers.map((q) => q.p.uid)]);
        const others = this.build.parts.filter((p) => !ignore.has(p.uid));
        const snap = snapPart(others, part.type, w.x + d.ox, w.y + d.oy, part.angle,
          { grid: this.options.grid, length: part.props.length });
        part.x = snap.x; part.y = snap.y; part.angle = snap.angle;
        for (const q of d.passengers) { q.p.x = part.x + q.dx; q.p.y = part.y + q.dy; }
        this.ghost = snap.hint ? { type: part.type, x: part.x, y: part.y, angle: part.angle, hint: snap.hint, hintOnly: true } : null;
        this.changed();
      }
    });

    const end = (e) => {
      const d = this.drag;
      this.drag = null;
      cv.classList.remove('panning');
      if (!d) return;
      if (d.kind === 'sim') this.sim?.release();
      if (d.kind === 'pan') {
        if (d.cancelTool && (this.armedType || this.drawing)) this._cancelPlacement();
        else if (d.clickUid != null) this.showInfo = true; // a click on a part while running
      }
      if (d.kind === 'move') {
        if (d.moved) {
          this.placedAt.set(d.uid, performance.now());
          this.ghost = null;
          this.commit();
        } else {
          this._cycleStack(d);
          this.showInfo = true; // a plain click shows the info card
        }
      }
      if (d.kind === 'stretch') {
        this.ghost = null;
        if (d.moved) { this.placedAt.set(d.uid, performance.now()); this.commit(); }
        else { this._cycleStack(d); this.showInfo = true; }
      }
      if (d.kind === 'draw') {
        const w = this._worldAt(e);
        if (!d.moved) {
          // Click (no drag): keep drawing; the next click sets the far end.
          this.drawing = { type: d.type, a: d.a };
          this._drawPreview(d.type, d.a, w, e);
        } else {
          this._finishDraw(d.type, d.a, w, e);
        }
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
      this.hoverUid = null;
      if (!this.drag && this.armedType && !this.drawing) { this.ghost = null; this.drawStart = null; }
    });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      this.camera.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
  }

  /** Clicked an already-selected part: step down to the next part stacked there. */
  _cycleStack(d) {
    if (!d.stack || d.stack.length < 2) return;
    const i = d.stack.findIndex((p) => p.uid === d.uid);
    const next = d.stack[(i + 1) % d.stack.length];
    this.select(next.uid);
    this.toast(`Selected ${getDef(next.type).name} (click again for the next part here)`, 1600);
  }

  /** Pointer moved with no button held: hover highlight, tool previews. */
  _hover(w) {
    if (!this.editable) { this.hoverUid = null; this.canvas.style.cursor = ''; return; }
    const type = this.armedType;
    const def = type ? getDef(type) : null;
    if (this.drawing) {
      this._drawPreview(this.drawing.type, this.drawing.a, w, {});
    } else if (def?.drawn) {
      this.drawStart = snapEnd(this.build.parts, def.kind, w.x, w.y, { grid: this.options.grid });
      this.ghost = this.drawStart.hint ? { type, x: this.drawStart.x, y: this.drawStart.y, angle: 0, hint: this.drawStart.hint, hintOnly: true } : null;
    } else if (def?.kind === 'chain') {
      this.ghost = null;
    } else if (type) {
      this._updateGhost(type, w);
    }
    const hit = type && !def.tool && !def.drawn ? null : this._pick(w);
    this.hoverUid = hit?.uid ?? null;
    if (def?.kind === 'chain') {
      this.hoverUid = hit && chainTeeth(getDef(hit.type)) ? hit.uid : null;
      this.canvas.style.cursor = this.hoverUid != null ? 'pointer' : 'crosshair';
    } else if (type) {
      this.canvas.style.cursor = 'crosshair';
      if (def.drawn) this.hoverUid = null;
    } else {
      // Over a stretch handle?
      const sel = this.selectedUid != null ? findPart(this.build, this.selectedUid) : null;
      const overHandle = sel && partDef(sel).drawn && lineEnds(sel).some((p) => {
        const a = this.camera.worldToScreen(p.x, p.y), b = this.camera.worldToScreen(w.x, w.y);
        return Math.hypot(a.x - b.x, a.y - b.y) < HANDLE_PX;
      });
      this.canvas.style.cursor = overHandle ? 'nwse-resize' : hit ? 'grab' : '';
    }
  }

  /** Pointer pressed in the world while a tool is picked. */
  _toolDown(w, e) {
    const type = this.armedType;
    const def = getDef(type);
    if (def.drawn) {
      if (this.drawing) { this._finishDraw(this.drawing.type, this.drawing.a, w, e); return; }
      const a = snapEnd(this.build.parts, def.kind, w.x, w.y, { grid: this.options.grid });
      this.drag = { kind: 'draw', type, a, sx: e.clientX, sy: e.clientY, moved: false };
      this.drawStart = null;
      return;
    }
    if (def.kind === 'chain') {
      const hit = this._pick(w);
      if (!hit || !chainTeeth(getDef(hit.type))) {
        if (this.chainPick != null) { this.chainPick = null; this.toast('Chain cancelled. Click a sprocket or gear to start.'); }
        else this.toast('Click a sprocket or gear to start the chain');
        return;
      }
      if (this.chainPick == null || this.chainPick === hit.uid) {
        this.chainPick = hit.uid;
        this.toast('Now click the sprocket or gear to link it to');
        return;
      }
      const made = this.placeChain(this.chainPick, hit.uid);
      this.chainPick = null;
      if (made) this.toast('⛓ Chained! Both turn the same way.');
      return;
    }
    this.placePart(type, w.x, w.y, 0);
  }

  /** Preview of a part being drawn from `a` toward pointer `w`. */
  _drawPreview(type, a, w, e) {
    const kind = getDef(type).kind;
    const b = snapDrawEnd(this.build.parts, kind, a, w, { freeAngle: !!e.altKey });
    const l = lineFrom(a, b);
    this.ghost = { type, x: l.x, y: l.y, angle: l.angle, length: l.length, hint: b.hint,
      label: this._lengthLabel(type, l.length), labelAt: b };
  }

  _finishDraw(type, a, w, e) {
    const kind = getDef(type).kind;
    const b = snapDrawEnd(this.build.parts, kind, a, w, { freeAngle: !!e.altKey });
    this.drawing = null;
    this.ghost = null;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.3) return;
    this.placeDrawn(type, a, b);
  }

  /** "10 holes" for beams, plain length for the rest. */
  _lengthLabel(type, length) {
    const def = getDef(type);
    if (def.kind === 'beam' || def.kind === 'slider') {
      const holes = Math.round((length / HOLE_SPACING) * 10) / 10;
      return `${Number.isInteger(holes) ? holes + 1 : holes.toFixed(1)} holes`;
    }
    return `${length.toFixed(1)} m`;
  }

  _updateGhost(type, w) {
    const snap = snapPart(this.build.parts, type, w.x, w.y, 0, { grid: this.options.grid });
    this.ghost = { type, x: snap.x, y: snap.y, angle: snap.angle, hint: snap.hint };
  }

  /** Drag from the gallery: track the pointer over the whole window. */
  _beginGalleryDrag(type, e) {
    if (!this.editable) { this.toast('Press ⟲ Reset to edit your build'); return; }
    const def = getDef(type);
    // Drawn parts and the chain are tools: a press just picks them.
    if (def.drawn || def.tool) { this.setTool(this.armedType === type ? null : type); return; }
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) moved = true;
      this._galleryDragging = moved;
      if (moved && this._overCanvas(ev)) this._updateGhost(type, this._worldAt(ev));
      else if (moved) this.ghost = null;
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this._galleryDragging = false;
      if (moved && this._overCanvas(ev)) {
        const w = this._worldAt(ev);
        this.placePart(type, w.x, w.y, 0);
        this.ghost = null;
      } else if (!moved) {
        // A plain click picks the part as a tool: click the world to place,
        // as many times as you like.
        this.setTool(this.armedType === type ? null : type);
      } else {
        this.ghost = null;
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Pick a tool (a part id) or go back to Select (null). */
  setTool(type) {
    if (type && !this.editable) { this.toast('Press ⟲ Reset to edit your build'); return; }
    this.armedType = type;
    this.ghost = null;
    this.drawing = null;
    this.drawStart = null;
    this.chainPick = null;
    this.gallery.setArmed(type);
    this._syncToolUI();
  }

  _cancelPlacement() { this.setTool(null); }

  /** Tool chip + dock highlight. */
  _syncToolUI() {
    const type = this.armedType;
    for (const [id, el] of this.dockButtons || []) el.classList.toggle('on', id === type);
    const chip = this.toolChipEl;
    if (!chip) return;
    if (!type) { chip.hidden = true; return; }
    const def = getDef(type);
    const how = def.kind === 'chain' ? 'click a sprocket or gear, then another'
      : def.drawn ? 'drag from one point to another (or click, click). Alt = any angle'
      : 'click to place, again and again';
    chip.innerHTML = `<b>${def.name}</b><span>${how}</span><button class="chip-x" title="Stop (Esc)">Esc ✕</button>`;
    chip.querySelector('button').addEventListener('click', () => this.setTool(null));
    chip.hidden = false;
  }

  /** The tool dock along the bottom of the world. */
  _buildDock() {
    const dock = document.getElementById('dock');
    if (!dock) return;
    this.dockButtons = new Map();
    for (const id of DOCK) {
      if (id && !this.mode.partFilter(getDef(id))) continue;
      const b = document.createElement('button');
      b.className = 'dock-btn';
      const def = id ? getDef(id) : null;
      b.title = id ? `${def.name} (${HOTKEYS[id]})${def.tip ? `\n${def.tip}` : ''}` : 'Select & move (V / Esc)';
      if (id) {
        const cv = document.createElement('canvas');
        cv.style.width = '34px'; cv.style.height = '28px';
        b.appendChild(cv);
        drawThumb(cv, def, 34, 28);
      } else {
        b.insertAdjacentHTML('beforeend', '<span class="dock-ico">🖐</span>');
      }
      b.insertAdjacentHTML('beforeend', `<kbd>${id ? HOTKEYS[id] : 'V'}</kbd>`);
      b.addEventListener('click', () => this.setTool(id));
      dock.appendChild(b);
      this.dockButtons.set(id, b);
    }
    this.on((type) => { if (type === 'state') dock.classList.toggle('disabled', !this.editable); });
    this._syncToolUI();
  }

  _syncThrottle() {
    const v = (this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('arrowleft') ? 1 : 0);
    this.sim?.setThrottle(v);
  }

  _bindKeys() {
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (this.keys.delete(k)) this._syncThrottle();
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, dialog')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if ((k === 'arrowleft' || k === 'arrowright') && this.sim) {
        e.preventDefault();
        this.keys.add(k);
        this._syncThrottle();
        return;
      }
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
      } else if (mod && k === 's') {
        e.preventDefault();
        this.openSaveDialog();
      } else if (mod && k === 'y') {
        e.preventDefault();
        this.redo();
      } else if (k === ' ') {
        e.preventDefault();
        if (this.state === 'playing') this.pause(); else this.play();
      } else if (k === 'escape') {
        if (this.drawing || this.chainPick != null) { this.drawing = null; this.chainPick = null; this.ghost = null; }
        else if (this.armedType) this._cancelPlacement();
        else this.select(null);
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
      } else if (!mod && !e.altKey && this.editable && k === 'v') {
        this.setTool(null);
      } else if (!mod && !e.altKey && this.editable && Object.values(HOTKEYS).includes(k.toUpperCase())) {
        const id = Object.keys(HOTKEYS).find((x) => HOTKEYS[x] === k.toUpperCase());
        this.setTool(this.armedType === id ? null : id);
      } else {
        this.mode.onKey?.(this, e);
      }
    });
  }
}
