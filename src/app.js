// =============================================================================
// app.js — the game controller. Owns the state and wires everything together:
//
//   build (plain data) ──▶ edit-mode analysis (snaps, meshes, predictions)
//                     └─▶ Simulation (only while playing/paused)
//   input (mouse/keys) ──▶ edits to the build / grabs in the simulation
//   every frame        ──▶ renderer.render(scene)
//
// EDITING works like Build a Boat: a TOOLBAR of tools (Move, Rotate, Scale,
// Wrench, Screwdriver, Delete) acts on the SELECTION (click, Shift-click,
// or drag a box). Picking a part in the gallery is "placing" mode, which
// stays on until Esc / right-click.
//
// The GAME MODE (src/modes/*) decides the map, default settings, which parts
// are allowed and which controls appear. App itself is mode-agnostic.
// =============================================================================
import { getDef, partDef, roleOf, chainTeeth, chainRadius, scaleSpec, pitchRadius, HOLE_SPACING } from './parts/partDefs.js';
import { pickPart, partsAt, socketsOf, outerRadius, lineEnds, lineFrom, boundsOf, worldToLocal, localToWorld } from './parts/geometry.js';
import { snapPart, snapEnd, snapDrawEnd, GRID } from './parts/snap.js';
import { emptyBuild, cloneBuild, addPart, findPart, removePart } from './core/build.js';
import { buildAssembly, mainKey, hubKey, WORLD } from './physics/assembly.js';
import { solveGearTrain } from './physics/gearTrain.js';
import { Simulation, DT, CRANK_TORQUE, motorKeys, keyControlKeys, isLegacyKey } from './physics/world.js';
import { keyLabel } from './render/draw.js';
import { Camera, Renderer } from './render/renderer.js';
import { chainPath } from './render/draw.js';
import { buildGallery } from './ui/gallery.js';
import { Panel } from './ui/panel.js';
import { showReadout } from './ui/readout.js';
import { renderProps } from './ui/props.js';
import { History } from './core/history.js';
import { autosave, loadAutosave } from './save/storage.js';
import { createSaveDialog } from './ui/saveDialog.js';

const ROTATE_STEP = Math.PI / 12; // 15°

/** Keyboard shortcuts for picking a part to place (edit mode). */
export const HOTKEYS = {
  beam: 'B', bolt: 'G', axle: 'A', hinge: 'H', 'pin-rotating': 'P', 'pin-fixed': 'F',
  chain: 'C', spring: 'S', rope: 'O', slider: 'J', track: 'T',
};

/** The toolbar, left to right. */
export const TOOLS = [
  { id: 'move',   key: '1', icon: '✥',  name: 'Move',        tip: 'Click to select, Shift-click to add, drag a box to select many. Drag parts to move them.' },
  { id: 'rotate', key: '2', icon: '⟳',  name: 'Rotate',      tip: 'Select parts, then drag the blue ring (or a selected part) to turn them. Alt = any angle.' },
  { id: 'scale',  key: '3', icon: '⤢',  name: 'Scale',       tip: 'Click a part, then drag its blue handles to resize it (gears get more teeth). Beams stretch by their ends.' },
  { id: 'wire',   key: '4', icon: '🔧', name: 'Wrench',      tip: 'Wire a Switch, Button or Key to a motor: click one, then the other. Click the same pair again to cut the wire.' },
  { id: 'props',  key: '5', icon: '🪛', name: 'Screwdriver', tip: 'Click parts (Shift-click / box for several) to change their properties: collisions, anchored, and more.' },
  { id: 'delete', key: '6', icon: '🔨', name: 'Delete',      tip: 'Click a part to remove it, or drag a box to remove everything inside.' },
];

const HANDLE_PX = 11; // how close (pixels) you must press to grab a handle

const kindOf = (p) => getDef(p.type).kind;
const isLinkKind = (k) => k === 'chain' || k === 'wire';

export class App {
  constructor(mode) {
    this.mode = mode;
    this.build = emptyBuild();
    this.settings = { ...mode.defaultSettings };
    this.options = { loadView: false, grid: true, autoPin: true, joints: true, follow: true };
    this.state = 'edit';        // 'edit' | 'playing' | 'paused'
    this.sim = null;            // Simulation while playing/paused
    this.preplay = null;        // copy of the build from before Play (for Reset)
    this.selection = new Set(); // selected part uids
    this.selectedUid = null;    // the "main" selected part (last clicked): panel, info card, camera follow
    this.tool = 'move';         // toolbar tool (see TOOLS)
    this.armedType = null;      // part being PLACED (from the gallery); stays until Esc
    this.drag = null;           // current pointer gesture
    this.ghost = null;          // placement preview
    this.drawing = null;        // click-click drawing in progress: { type, a }
    this.drawStart = null;      // where a drawing tool would start (hover dot)
    this.chainPick = null;      // chain placing: first sprocket picked
    this.wirePick = null;       // wrench: first control/motor picked
    this.hoverUid = null;       // part under the pointer (edit mode)
    this.showInfo = false;      // readout card: only after you CLICK a part
    this.keys = new Set();      // keys held while playing
    this.mouse = { x: 0, y: 0 };// last pointer position (world), for paste
    this.clipboard = null;      // copied parts
    this.followUid = null;      // part the camera follows while playing
    this.prePlayCamera = null;  // where the camera was when you pressed Play
    this.followPopUid = null;   // part showing the "Follow this" button (playing)
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
    this.propsPopEl = document.getElementById('props-pop');
    this.followPopEl = document.getElementById('follow-pop');

    this.gallery = buildGallery(document.getElementById('gallery'), {
      onDragStart: (type, e) => this._beginGalleryDrag(type, e),
    }, this.mode.partFilter, HOTKEYS);
    this._buildToolbar();
    this.panel = new Panel(document.getElementById('panel'));
    this.mode.setup(this);

    this._bindTopbar();
    this._bindCanvas();
    this._bindKeys();
    window.addEventListener('resize', () => this.renderer.resize());
    this.renderer.resize();
    document.fonts?.ready.then(() => this.gallery.redraw());
    window.addEventListener('blur', () => { this.keys.clear(); this._syncKeys(); });
    this.on((type) => { if (type === 'select' || type === 'changed' || type === 'state') this._syncPropsPop(); });

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
      this._panWithKeys(dt);
      this._followCamera(dt);
      this._render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /** Subscribe to app events ('changed', 'state', 'select', 'tool'). */
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
    this._pruneSelection();
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
    if (this._linkBetween('chain', uidA, uidB)) { this.toast('Those two are already chained'); return null; }
    const pa = findPart(this.build, uidA), pb = findPart(this.build, uidB);
    const ra = chainRadius(partDef(pa)), rb = chainRadius(partDef(pb));
    if (Math.hypot(pb.x - pa.x, pb.y - pa.y) <= Math.abs(ra - rb) + 0.3) {
      this.toast('Too close: move them apart first');
      return null;
    }
    const part = addPart(this.build, 'chain', (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, 0, { a: uidA, b: uidB });
    this.commit();
    return part;
  }

  /** Wrench: wire a control to a motor, or cut the wire if there already is one. */
  toggleWire(uidA, uidB) {
    const existing = this._linkBetween('wire', uidA, uidB);
    if (existing) {
      removePart(this.build, existing.uid);
      this.commit();
      this.toast('✂️ Wire cut');
      return null;
    }
    const pa = findPart(this.build, uidA), pb = findPart(this.build, uidB);
    const part = addPart(this.build, 'wire', (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, 0, { a: uidA, b: uidB });
    this.commit();
    this.toast('⚡ Wired! Press Play and use the control.');
    return part;
  }

  _linkBetween(kind, a, b) {
    return this.build.parts.find((p) => kindOf(p) === kind &&
      ((p.props.a === a && p.props.b === b) || (p.props.a === b && p.props.b === a))) || null;
  }

  /** Is there something at this part's centre that it could spin on? */
  _hasMountAt(part) {
    return this.build.parts.some((p) => p.uid !== part.uid &&
      socketsOf(p).some((s) => Math.hypot(s.x - part.x, s.y - part.y) < 0.12));
  }

  /** Connectors sitting on this part's centre that nothing else uses
   *  (e.g. the auto-pin under a gear). They move/delete with the part. */
  _passengers(part) {
    const role = roleOf(kindOf(part));
    if (role !== 'rotor' && role !== 'driver') return [];
    const at = (p) => Math.hypot(p.x - part.x, p.y - part.y) < 0.12;
    const others = this.build.parts.filter((p) => p.uid !== part.uid);
    const sharers = others.filter((p) => roleOf(kindOf(p)) !== 'connector' &&
      socketsOf(p).some((s) => Math.hypot(s.x - part.x, s.y - part.y) < 0.12));
    if (sharers.length) return [];
    return others.filter((p) => roleOf(kindOf(p)) === 'connector' && at(p));
  }

  /** Selected parts plus their passengers: everything that moves together. */
  _movingSet() {
    const set = new Set();
    for (const uid of this.selection) {
      const p = findPart(this.build, uid);
      if (!p || isLinkKind(kindOf(p))) continue;
      set.add(p);
      for (const q of this._passengers(p)) set.add(q);
    }
    return [...set];
  }

  /** Remove parts (and whatever can't live without them: passengers, chains, wires). */
  deleteParts(uids) {
    if (!this.editable) return;
    const gone = new Set();
    for (const uid of uids) {
      const p = findPart(this.build, uid);
      if (!p) continue;
      gone.add(uid);
      for (const q of this._passengers(p)) gone.add(q.uid);
    }
    for (const p of this.build.parts) {
      if (isLinkKind(kindOf(p)) && (gone.has(p.props.a) || gone.has(p.props.b))) gone.add(p.uid);
    }
    if (!gone.size) return;
    for (const uid of gone) removePart(this.build, uid);
    this._pruneSelection();
    this.commit();
  }

  deleteSelection() { this.deleteParts([...this.selection]); }

  /** Centre of the selection (a single part: its own centre). */
  selectionCenter() {
    const parts = this._movingSet().filter((p) => this.selection.has(p.uid));
    if (!parts.length) return null;
    if (parts.length === 1) return { x: parts[0].x, y: parts[0].y, r: this._radiusOf(parts) };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of parts) {
      const b = boundsOf(p);
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    const c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    // Keep the pivot on the grid so rotated holes still land on grid points.
    if (this.options.grid) { c.x = Math.round(c.x / GRID) * GRID; c.y = Math.round(c.y / GRID) * GRID; }
    return { ...c, r: this._radiusOf(parts, c) };
  }

  _radiusOf(parts, c = parts[0]) {
    let r = 0.5;
    for (const p of parts) {
      const b = boundsOf(p);
      for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x1, b.y0]]) r = Math.max(r, Math.hypot(x - c.x, y - c.y) * 0.85);
    }
    return r;
  }

  /** Turn the moving set by `delta` radians round centre c (from saved originals). */
  _applyRotation(orig, c, delta) {
    const cos = Math.cos(delta), sin = Math.sin(delta);
    for (const o of orig) {
      const dx = o.x - c.x, dy = o.y - c.y;
      o.p.x = c.x + dx * cos - dy * sin;
      o.p.y = c.y + dx * sin + dy * cos;
      o.p.angle = o.angle + delta;
    }
  }

  rotateSelection(dir) {
    if (!this.editable || !this.selection.size) return;
    const c = this.selectionCenter();
    const orig = this._movingSet().map((p) => ({ p, x: p.x, y: p.y, angle: p.angle }));
    this._applyRotation(orig, c, dir * ROTATE_STEP);
    for (const o of orig) this.placedAt.set(o.p.uid, performance.now());
    this.commit();
  }

  /** Copy the selection (plus chains/wires between selected parts). */
  copySelection() {
    const moving = this._movingSet();
    if (!moving.length) return false;
    const uids = new Set(moving.map((p) => p.uid));
    const links = this.build.parts.filter((p) => isLinkKind(kindOf(p)) && uids.has(p.props.a) && uids.has(p.props.b));
    const parts = [...moving, ...links];
    const c = this.selectionCenter();
    this.clipboard = { parts: cloneBuild({ parts }).parts, cx: c.x, cy: c.y };
    return true;
  }

  /** Paste the clipboard centred at (x, y), or offset from the original. */
  paste(at = null) {
    if (!this.editable || !this.clipboard) return;
    const { parts, cx, cy } = this.clipboard;
    let dx = 1.2, dy = -1.2;
    if (at) {
      dx = at.x - cx; dy = at.y - cy;
      if (this.options.grid) { dx = Math.round(dx / GRID) * GRID; dy = Math.round(dy / GRID) * GRID; }
    }
    const map = new Map();
    const made = [];
    for (const p of parts) {
      const q = addPart(this.build, p.type, p.x + dx, p.y + dy, p.angle, p.props);
      map.set(p.uid, q.uid);
      made.push(q);
    }
    for (const q of made) if (isLinkKind(kindOf(q))) { q.props.a = map.get(q.props.a); q.props.b = map.get(q.props.b); }
    for (const q of made) this.placedAt.set(q.uid, performance.now());
    this.commit();
    this.setSelection(made.filter((q) => !isLinkKind(kindOf(q))).map((q) => q.uid));
  }

  duplicateSelection() {
    if (!this.copySelection()) return;
    // Paste just beside the original, then remember the shifted copy so the
    // next duplicate steps along again.
    this.paste();
    this.clipboard.cx -= 1.2; this.clipboard.cy += 1.2;
    this.clipboard.parts.forEach((p) => { p.x += 1.2; p.y -= 1.2; });
  }

  /** Set a property on several parts at once (Screwdriver / panel). */
  setProps(uids, key, value) {
    if (!this.editable) return;
    for (const uid of uids) {
      const part = findPart(this.build, uid);
      if (part) part.props[key] = value;
    }
    this.commit();
  }

  /** Back-compat: set one part's property. */
  setPartProp(uid, key, value) { this.setProps([uid], key, value); }

  // ============================================================ selection ==
  /** Select one part (or nothing). Shift-style adding is in setSelection. */
  select(uid) { this.setSelection(uid == null ? [] : [uid]); }

  setSelection(uids, primary = uids[uids.length - 1] ?? null) {
    const next = new Set(uids);
    if (primary !== this.selectedUid || next.size !== 1) this.showInfo = false;
    this.selection = next;
    this.selectedUid = next.has(primary) ? primary : null;
    this.emit('select');
  }

  toggleSelected(uid) {
    const s = new Set(this.selection);
    if (s.has(uid)) s.delete(uid); else s.add(uid);
    this.setSelection([...s], s.has(uid) ? uid : [...s].pop());
  }

  _pruneSelection() {
    const keep = [...this.selection].filter((uid) => findPart(this.build, uid));
    if (keep.length !== this.selection.size) this.setSelection(keep);
  }

  selectedParts() {
    const src = this.sim ? { parts: this.sim.parts } : this.build;
    return [...this.selection].map((uid) => findPart(src, uid)).filter(Boolean);
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
      this.prePlayCamera = { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom };
      // Reset brings the camera back to the vehicle, even if you stop following it.
      this.resetFocusUid = this.sim.autoFollowTarget();
      this.followUid = this.options.follow ? this.resetFocusUid : null;
      for (const w of this.sim.assembly.warnings) this.toast(w);
      const hints = new Set();
      for (const p of this.sim.parts) {
        const k = kindOf(p);
        const pair = k === 'motor' ? motorKeys(p) : k === 'keyButton' && !isLegacyKey(p) ? keyControlKeys(p) : null;
        if (pair) {
          if (pair.cw !== 'none') hints.add(`${keyLabel(pair.cw)} ↻`);
          if (pair.ccw !== 'none') hints.add(`${keyLabel(pair.ccw)} ↺`);
        } else if (k === 'keyButton') hints.add(keyLabel(p.props.key));
      }
      if (hints.size) this.toast(`🎮 Keys: ${[...hints].join(' · ')}`, 3500);
      else if (this.sim.signals.size) this.toast('🎛️ Click switches and hold buttons to run your motors', 3500);
      this._syncKeys();
    }
    this._cancelPlacement();
    this.hoverUid = null;
    this.state = 'playing';
    this.emit('state');
    this._syncToolUI();
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
    // Camera back to where things started: on the part you were following
    // (now back at its start), otherwise where the camera was before Play.
    const cam = this.prePlayCamera;
    const focus = this.followUid ?? this.resetFocusUid;
    const followed = focus != null && findPart(this.build, focus);
    if (cam) this.camera.zoom = cam.zoom;
    if (followed) { this.camera.x = followed.x; this.camera.y = followed.y + 1; }
    else if (cam) { this.camera.x = cam.x; this.camera.y = cam.y; }
    this.followUid = null;
    this.followPopUid = null;
    this.changed();
    this.emit('state');
    this._syncToolUI();
  }

  /** Follow a part with the camera while playing (null = stop following). */
  follow(uid) {
    this.followUid = uid;
    if (uid != null) this.resetFocusUid = uid;
    this.followPopUid = null;
    if (uid != null) this.toast(`🎥 Following ${getDef(findPart({ parts: this.sim?.parts ?? this.build.parts }, uid).type).name}`, 1400);
    this._syncToolUI();
  }

  /** Glide the camera after the followed part. */
  _followCamera(dt) {
    if (!this.sim || this.followUid == null) return;
    const t = this.sim.transformOf(this.followUid);
    if (!t || !Number.isFinite(t.x)) return;
    const k = Math.min(1, dt * 5);
    this.camera.x += (t.x - this.camera.x) * k;
    this.camera.y += (t.y + 1 - this.camera.y) * k;
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
    const kind = kindOf(part);
    if (kind === 'spring' || kind === 'rope') {
      const ends = this.sim.linkEnds(part.uid);
      if (!ends) return part;
      const l = lineFrom(ends[0], ends[1]);
      return { ...part, x: l.x, y: l.y, angle: l.angle, props: { ...part.props, length: l.length } };
    }
    // A crank's clickable arm is on its spinning hub, so use the hub's angle.
    const layer = kind === 'crank' ? 'hub' : 'main';
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
    const def = partDef(part);
    const name = def.kind === 'gear' ? `Gear ${def.teeth}T` : def.name;
    const role = roleOf(def.kind);
    // Only parts with numbers worth showing get a card (the panel has the rest).
    if (role !== 'rotor' && role !== 'driver') return null;
    if (this.sim) {
      const r = this.sim.readout(uid);
      const note = r.jammed ? '⛔ Jammed: these gears lock each other.'
        : r.stalled ? '🛑 Stalled: the load needs more torque than the motor has.'
        : r.driverUid == null ? (r.mounted ? 'Not powered.' : 'Not on an axle.') : null;
      return { name, live: true, rpm: r.rpm, torque: r.torque, ratio: r.ratio,
        load: r.driverUid != null ? r.load : null, note };
    }
    // Edit mode: predict from the gear-train graph.
    const { assembly, train } = this._analysis();
    const key = role === 'driver' ? hubKey(uid) : mainKey(uid);
    const bodyId = assembly.bodyOf(key);
    const drive = train.driveOf(bodyId);
    if (!drive || drive.driverUid == null) {
      const mounted = bodyId === WORLD || assembly.axleOf(bodyId);
      return { name, ratio: null,
        note: drive?.jammed ? '⛔ This gear train is jammed.' : mounted ? 'Not connected to a motor or crank yet.' : 'No axle: put it on a pin, beam hole or motor.' };
    }
    const driver = findPart(this.build, drive.driverUid);
    const dkind = kindOf(driver);
    if (drive.jammed) return { name, ratio: drive.ratio, note: '⛔ This gear train is jammed and won’t turn.' };
    if (dkind === 'crank') {
      return { name, ratio: drive.ratio, torque: CRANK_TORQUE / Math.abs(drive.ratio),
        note: 'Driven by a hand crank: press Play and drag the crank handle.' };
    }
    const dir = driver.props.reverse ? -1 : 1;
    return { name, ratio: drive.ratio,
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
    const hooks = []; // loose rope/spring ends (unanchored)

    if (this.sim) {
      for (const [uid] of this.sim.links) {
        const ends = this.sim.linkEnds(uid);
        for (const i of this.sim.hookEnds(uid)) hooks.push(ends[i]);
      }
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
      const solid = this.build.parts.filter((q) => roleOf(kindOf(q)) !== 'link');
      for (const p of this.build.parts) {
        const k = kindOf(p);
        if (k !== 'spring' && k !== 'rope') continue;
        for (const e of lineEnds(p)) {
          const onSocket = solid.some((q) => socketsOf(q).some((so) => Math.hypot(so.x - e.x, so.y - e.y) < 0.12));
          if (!onSocket && !pickPart(solid, e.x, e.y)) (p.props.pinEnds === false ? hooks : skyPins).push(e);
        }
      }
      for (const uid of train.floatingGears) {
        const p = findPart(this.build, uid);
        if (p) labels.push({ x: p.x, y: p.y + outerRadius(partDef(p)) + 0.5, text: '❗ no axle', color: '#ffe066' });
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
    const busy = d && d.moved;
    const placing = editing && (this.armedType || this.drawing ||
      (d && (d.kind === 'draw' || d.kind === 'stretch' || (d.kind === 'move' && d.moved))) || this._galleryDragging);

    // Tool overlays: handles, rotate ring, wire highlights.
    let handles = [], rotateGizmo = null, handleLabel = null;
    if (editing && !this.armedType) {
      if (this.tool === 'move' || this.tool === 'scale') handles = this._handles();
      if (d?.label) handleLabel = d.label;
      if (this.tool === 'rotate' && this.selection.size && !(d && d.kind === 'move')) {
        const c = d?.kind === 'rotate' ? d.c : this.selectionCenter();
        if (c) rotateGizmo = { x: c.x, y: c.y, r: c.r, angle: d?.kind === 'rotate' ? d.knob : Math.PI / 4,
          label: d?.kind === 'rotate' ? d.text : null };
      }
    }

    this.renderer.render({
      parts, mode: editing ? 'edit' : 'play', map: this.mode.map, grid: this.options.grid,
      transformOf: (uid, layer) => this.transformOf(uid, layer),
      linkEndsOf: (uid) => (this.sim ? this.sim.linkEnds(uid) : null),
      signalOf: (uid) => this.sim?.signals.get(uid) ?? (editing ? !!findPart(this.build, uid)?.props.on : false),
      loadOf: (uid) => (this.options.loadView && this.sim ? this.sim.loadOf(uid) : null),
      loadView: this.options.loadView && !!this.sim, // load colours only mean something while running
      squashOf: (uid) => {
        const t0 = this.placedAt.get(uid);
        if (t0 == null) return 0;
        const t = (now - t0) / 1000;
        if (t > 0.6) { this.placedAt.delete(uid); return 0; }
        return 0.22 * Math.exp(-t * 8) * Math.cos(t * 26); // squash, bounce, settle
      },
      selection: this.selection,
      hoverUid: editing && !busy ? this.hoverUid : null,
      pickedUid: this.chainPick ?? this.wirePick,
      ghost: this.ghost,
      drawStart: editing && !d ? (this.drawing ? null : this.drawStart) : null,
      showSockets: !!placing,
      wiresStrong: editing && this.tool === 'wire' && !this.armedType,
      marquee: d?.kind === 'marquee' && d.moved ? { ...d.box, del: this.tool === 'delete' } : null,
      onTop: (this.sim ? this.sim.assembly : this._analysis().assembly).onRotor,
      handles, handleLabel, rotateGizmo, joints, badChains, skyPins, hooks,
      meshes, labels,
    });

    // Readout card beside the selected part — only after you clicked it,
    // never just because you placed or dragged something.
    const t = this.selectedUid != null ? this.transformOf(this.selectedUid) : null;
    if (t) {
      const s = this.camera.worldToScreen(t.x, t.y);
      const sel = (this.sim ? this.sim.parts : this.build.parts).find((p) => p.uid === this.selectedUid);
      const def = sel && partDef(sel);
      const r = def ? (def.drawn ? def.thickness : outerRadius(def)) * this.camera.zoom : 0;
      const show = this.showInfo && !this.drag && this.selection.size === 1 && (this.tool === 'move' || !this.editable);
      showReadout(this.readoutEl, show ? this.readoutFor(this.selectedUid) : null, s, r);
    } else {
      showReadout(this.readoutEl, null);
    }
    this._placePropsPop();
    this._placeFollowPop();
  }

  /** While playing: a "Follow this" button beside the part you clicked. */
  _placeFollowPop() {
    const el = this.followPopEl;
    if (!el) return;
    const uid = this.sim ? this.followPopUid : null;
    const t = uid != null ? this.sim.transformOf(uid) : null;
    if (!t) { el.hidden = true; return; }
    const following = this.followUid === uid;
    const label = following ? '✕ Stop following' : '🎥 Follow this';
    if (el.dataset.label !== label) {
      el.dataset.label = label;
      el.innerHTML = `<button class="btn small">${label}</button>`;
      el.querySelector('button').addEventListener('click', () => this.follow(following ? null : uid));
    }
    el.hidden = false;
    const s = this.camera.worldToScreen(t.x, t.y);
    const part = this.sim.parts.find((p) => p.uid === uid);
    const def = part && partDef(part);
    const r = def ? (def.drawn ? def.thickness : outerRadius(def)) * this.camera.zoom : 0;
    el.style.left = `${Math.max(8, Math.min(this.camera.w - el.offsetWidth - 8, s.x - el.offsetWidth / 2))}px`;
    el.style.top = `${Math.min(this.camera.h - 40, s.y + r + 12)}px`;
  }

  /** Handles for the Move tool (stretch ends) and Scale tool (resize). */
  _handles() {
    if (this.selection.size !== 1 || this.selectedUid == null) return [];
    const part = findPart(this.build, this.selectedUid);
    if (!part) return [];
    const def = partDef(part);
    if (def.drawn) return lineEnds(part).map((p, i) => ({ ...p, kind: 'end', end: i }));
    if (this.tool !== 'scale') return [];
    const spec = scaleSpec(def);
    if (!spec) return [];
    if (spec[0].axis) {
      // Boxes: one handle on the right edge (width), one on top (height).
      return spec.map((sp) => {
        const half = sp.axis === 'x' ? { x: def.width / 2, y: 0 } : { x: def.kind === 'ramp' ? def.width / 2 : 0, y: def.height / 2 };
        return { ...localToWorld(part.x, part.y, part.angle, half.x, half.y), kind: 'scale', spec: sp };
      });
    }
    return [{ x: part.x + outerRadius(def), y: part.y, kind: 'scale', spec: spec[0] }];
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

  // ======================================================== props pop-up ==
  /** The Screwdriver's floating property card, next to the selection. */
  _syncPropsPop() {
    const el = this.propsPopEl;
    if (!el) return;
    const parts = this.editable && this.tool === 'props' && !this.armedType ? this.selectedParts() : [];
    if (!parts.length) { el.hidden = true; return; }
    el.hidden = false;
    renderProps(el, this, parts, { tips: false });
    this._placePropsPop(true);
  }

  _placePropsPop(force = false) {
    const el = this.propsPopEl;
    if (!el || el.hidden) return;
    if (!force && this.drag) return;
    const parts = this.selectedParts();
    if (!parts.length) return;
    let x1 = -Infinity, yMid = 0;
    for (const p of parts) { const b = boundsOf(p); x1 = Math.max(x1, b.x1); yMid += (b.y0 + b.y1) / 2; }
    const s = this.camera.worldToScreen(x1, yMid / parts.length);
    const w = el.offsetWidth, h = el.offsetHeight, W = this.camera.w, H = this.camera.h;
    let x = s.x + 18, y = s.y - h / 2;
    if (x + w > W - 8) {
      let x0 = Infinity;
      for (const p of parts) x0 = Math.min(x0, boundsOf(p).x0);
      x = this.camera.worldToScreen(x0, 0).x - w - 18;
    }
    el.style.left = `${Math.max(8, Math.min(W - w - 8, x))}px`;
    el.style.top = `${Math.max(8, Math.min(H - h - 70, y))}px`;
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

  _screenAt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _overCanvas(e) {
    const r = this.canvas.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  /** Pick a part under the pointer (using live positions while playing). */
  _pick(w) {
    const parts = (this.sim ? this.sim.parts : this.build.parts).map((p) => this.livePart(p));
    const hit = pickPart(parts, w.x, w.y);
    if (hit && roleOf(kindOf(hit)) !== 'beam' && roleOf(kindOf(hit)) !== 'object') return hit;
    return this._pickLink(parts, w) || hit;
  }

  /** A chain or wire (edit mode) passing under the pointer. */
  _pickLink(parts, w) {
    const byUid = new Map(parts.map((p) => [p.uid, p]));
    const segDist = (p, a, b) => {
      const vx = b.x - a.x, vy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
    };
    const tol = Math.max(0.2, 8 / this.camera.zoom);
    for (const p of parts) {
      const k = kindOf(p);
      if (k !== 'chain' && !(k === 'wire' && this.editable)) continue;
      const pa = byUid.get(p.props.a), pb = byUid.get(p.props.b);
      if (!pa || !pb) continue;
      if (k === 'chain') {
        const path = chainPath({ x: pa.x, y: pa.y, r: chainRadius(partDef(pa)) }, { x: pb.x, y: pb.y, r: chainRadius(partDef(pb)) });
        if (path && (segDist(w, path.a1, path.b1) < tol || segDist(w, path.a2, path.b2) < tol)) return p;
      } else {
        // The wire droops like the drawing does: sample its curve.
        const sa = this.camera.worldToScreen(pa.x, pa.y), sb = this.camera.worldToScreen(pb.x, pb.y);
        const droop = Math.min(60, Math.hypot(sb.x - sa.x, sb.y - sa.y) * 0.18) / this.camera.zoom;
        const m = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 - droop };
        let prev = pa;
        for (let i = 1; i <= 12; i++) {
          const t = i / 12, u = 1 - t;
          const q = { x: u * u * pa.x + 2 * u * t * m.x + t * t * pb.x, y: u * u * pa.y + 2 * u * t * m.y + t * t * pb.y };
          if (segDist(w, prev, q) < tol) return p;
          prev = q;
        }
      }
    }
    return null;
  }

  /** Handle under a screen point, if any. */
  _handleAt(sp) {
    for (const h of this._handles()) {
      const s = this.camera.worldToScreen(h.x, h.y);
      if (Math.hypot(s.x - sp.x, s.y - sp.y) < HANDLE_PX) return h;
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
      // Middle/right button pans. A right CLICK (no drag) cancels what you're doing.
      if (e.button === 1 || e.button === 2) {
        this.drag = { kind: 'pan', sx, sy, cx: this.camera.x, cy: this.camera.y, cancel: e.button === 2 };
        cv.classList.add('panning');
        return;
      }
      if (this.sim) { this._playDown(w, e); return; }
      if (this.armedType) { this._toolDown(w, e); return; }
      this._editDown(w, e);
    });

    cv.addEventListener('pointermove', (e) => {
      const w = this._worldAt(e);
      this.mouse = w;
      const d = this.drag;
      if (!d) { this._hover(w, e); return; }
      if (!d.moved && Math.hypot(e.clientX - (d.sx ?? e.clientX), e.clientY - (d.sy ?? e.clientY)) > 4) d.moved = true;
      switch (d.kind) {
        case 'pan':
          if (d.moved) {
            d.cancel = false; d.clickUid = null;
            if (this.sim && this.followUid != null) { this.followUid = null; this._syncToolUI(); }
          }
          this.camera.x = d.cx - (e.clientX - d.sx) / this.camera.zoom;
          this.camera.y = d.cy + (e.clientY - d.sy) / this.camera.zoom;
          break;
        case 'sim': this.sim.dragTo(w); break;
        case 'draw': this._drawPreview(d.type, d.a, w, e); break;
        case 'stretch': this._stretchMove(d, w, e); break;
        case 'scale': this._scaleMove(d, w); break;
        case 'move': if (d.moved) this._moveMove(d, w); break;
        case 'rotate': if (d.moved) this._rotateMove(d, w, e); break;
        case 'marquee':
          d.box = { x0: Math.min(d.a.x, w.x), y0: Math.min(d.a.y, w.y), x1: Math.max(d.a.x, w.x), y1: Math.max(d.a.y, w.y) };
          break;
        default: break;
      }
    });

    const end = (e) => {
      const d = this.drag;
      this.drag = null;
      cv.classList.remove('panning');
      if (!d) return;
      const w = this._worldAt(e);
      switch (d.kind) {
        case 'sim':
          this.sim?.release();
          if (d.button != null) this.sim?.setSignal(d.button, false);
          if (!d.moved && d.clickUid != null) { this.followPopUid = d.clickUid; this.showInfo = true; }
          break;
        case 'pan':
          if (d.cancel) this._cancelAll();
          else if (d.play) {
            // A click while running: show the part's numbers and a Follow button.
            this.followPopUid = d.clickUid;
            if (d.clickUid != null) this.showInfo = true;
          }
          break;
        case 'move':
          if (d.moved) {
            for (const o of d.orig) this.placedAt.set(o.p.uid, performance.now());
            this.ghost = null;
            this.commit();
          } else {
            this._clickPart(d);
          }
          break;
        case 'rotate':
          if (d.moved) { for (const o of d.orig) this.placedAt.set(o.p.uid, performance.now()); this.commit(); }
          else if (d.clickUid != null) this._clickPart({ ...d, uid: d.clickUid });
          break;
        case 'stretch': case 'scale':
          this.ghost = null;
          if (d.moved) { this.placedAt.set(d.uid, performance.now()); this.commit(); }
          else this._clickPart(d);
          break;
        case 'marquee': this._marqueeEnd(d, e); break;
        case 'draw':
          if (!d.moved) {
            // Click (no drag): keep drawing; the next click sets the far end.
            this.drawing = { type: d.type, a: d.a };
            this._drawPreview(d.type, d.a, w, e);
          } else {
            this._finishDraw(d.type, d.a, w, e);
          }
          break;
        default: break;
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

  /** Pointer pressed while the machine runs: cranks, switches, buttons, grabbing. */
  _playDown(w, e) {
    const hit = this._pick(w);
    if (hit) this.select(hit.uid);
    const kind = hit && kindOf(hit);
    if (this.state === 'playing' && kind === 'switch') {
      this.sim.toggleSwitch(hit.uid);
      this.drag = { kind: 'sim' };
      return;
    }
    if (this.state === 'playing' && (kind === 'button' || kind === 'keyButton')) {
      this.sim.setSignal(hit.uid, true);
      this.drag = { kind: 'sim', button: hit.uid };
      return;
    }
    if (this.state === 'playing' && kind === 'crank') {
      this.sim.grabCrank(hit.uid, w);
      this.drag = { kind: 'sim' };
      return;
    }
    if (this.state === 'playing' && this.sim.grabBodyAt(w)) {
      // Grabbing a moving part; letting go without dragging counts as a click.
      this.drag = { kind: 'sim', sx: e.clientX, sy: e.clientY, clickUid: hit?.uid ?? null };
      return;
    }
    if (!hit) this.select(null);
    this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: this.camera.x, cy: this.camera.y, clickUid: hit?.uid ?? null, play: true };
  }

  /** Pointer pressed in edit mode with a toolbar tool (not placing). */
  _editDown(w, e) {
    const sx = e.clientX, sy = e.clientY;
    const sp = this._screenAt(e);
    const tool = this.tool;
    const hit = this._pick(w);
    const stack = partsAt(this.build.parts, w.x, w.y);

    // Handles first (Move: stretch ends · Scale: resize).
    const h = (tool === 'move' || tool === 'scale') ? this._handleAt(sp) : null;
    if (h) {
      const part = findPart(this.build, this.selectedUid);
      if (h.kind === 'end') {
        this.drag = { kind: 'stretch', uid: part.uid, fixed: lineEnds(part)[1 - h.end], end: h.end, sx, sy, stack };
      } else {
        this.drag = { kind: 'scale', uid: part.uid, spec: h.spec, sx, sy, stack };
      }
      return;
    }

    if (tool === 'wire') { this._wireClick(hit); return; }
    if (tool === 'delete') {
      if (hit) { this.deleteParts([hit.uid]); this.toast(`🔨 Removed ${getDef(hit.type).name}`, 1200); return; }
      this.drag = { kind: 'marquee', a: w, sx, sy, add: false };
      return;
    }

    if (tool === 'rotate' && this.selection.size) {
      // Grab the ring (or a selected part) to turn the selection.
      const c = this.selectionCenter();
      const cs = this.camera.worldToScreen(c.x, c.y);
      const ringR = c.r * this.camera.zoom + 18;
      const onRing = Math.abs(Math.hypot(sp.x - cs.x, sp.y - cs.y) - ringR) < 14;
      const onSelected = hit && this.selection.has(hit.uid) && !e.shiftKey;
      if (onRing || onSelected) {
        const start = Math.atan2(w.y - c.y, w.x - c.x);
        this.drag = { kind: 'rotate', c, start, knob: start, sx, sy, delta: 0, clickUid: onSelected ? hit.uid : null,
          orig: this._movingSet().map((p) => ({ p, x: p.x, y: p.y, angle: p.angle })) };
        return;
      }
    }

    if (!hit) {
      // Empty space: drag a selection box (Shift adds to the selection).
      if (!e.shiftKey && tool !== 'scale') this.setSelection([]);
      if (tool === 'scale') { this.setSelection([]); return; }
      this.drag = { kind: 'marquee', a: w, sx, sy, add: e.shiftKey };
      return;
    }

    if (tool === 'scale') {
      // Pins sit on top of gears; scale the first part here that can be scaled.
      const target = stack.find((p) => scaleSpec(partDef(p))) || hit;
      this.select(target.uid);
      this._explainScale(target);
      return;
    }

    // Click / Shift-click selection.
    const wasSelected = this.selection.has(hit.uid) ||
      (this.selection.size === 1 && stack.some((p) => this.selection.has(p.uid)));
    if (e.shiftKey) { this.toggleSelected(hit.uid); return; }
    let grab = hit;
    if (!this.selection.has(hit.uid)) {
      if (wasSelected) grab = findPart(this.build, this.selectedUid); // keep grabbing the selected one in a stack
      else this.select(hit.uid);
    } else {
      this.selectedUid = hit.uid;
    }
    if (tool === 'props' || tool === 'rotate') { this.emit('select'); return; }
    // Move tool: drag the whole selection.
    this.drag = { kind: 'move', uid: grab.uid, ox: grab.x - w.x, oy: grab.y - w.y, sx, sy,
      stack: wasSelected ? stack : null,
      orig: this._movingSet().map((p) => ({ p, x: p.x, y: p.y })) };
  }

  _explainScale(part) {
    const def = partDef(part);
    if (!scaleSpec(def)) this.toast(`${def.name} can't be scaled`, 1500);
  }

  /** A click (no drag) on a part with the Move tool. */
  _clickPart(d) {
    if (d.stack && d.stack.length > 1 && this.selection.size === 1) {
      // Clicked an already-selected part: step down to the next one stacked there.
      const i = d.stack.findIndex((p) => p.uid === d.uid);
      const next = d.stack[(i + 1) % d.stack.length];
      this.select(next.uid);
      this.toast(`Selected ${getDef(next.type).name} (click again for the next part here)`, 1600);
    }
    this.showInfo = true; // a plain click shows the info card
  }

  _moveMove(d, w) {
    this.showInfo = false;
    const part = findPart(this.build, d.uid);
    const moving = new Set(d.orig.map((o) => o.p.uid));
    const others = this.build.parts.filter((p) => !moving.has(p.uid));
    const o0 = d.orig.find((o) => o.p.uid === d.uid);
    // Snap the part you grabbed; everything else in the selection follows.
    const snap = snapPart(others, part.type, w.x + d.ox, w.y + d.oy, part.angle,
      { grid: this.options.grid, props: part.props });
    const dx = snap.x - o0.x, dy = snap.y - o0.y;
    for (const o of d.orig) { o.p.x = o.x + dx; o.p.y = o.y + dy; }
    if (d.orig.length === 1) part.angle = snap.angle;
    this.ghost = snap.hint ? { type: part.type, props: part.props, x: part.x, y: part.y, angle: part.angle, hint: snap.hint, hintOnly: true } : null;
    this.changed();
  }

  _rotateMove(d, w, e) {
    let delta = Math.atan2(w.y - d.c.y, w.x - d.c.x) - d.start;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (!e.altKey) delta = Math.round(delta / ROTATE_STEP) * ROTATE_STEP;
    d.knob = d.start + delta;
    d.delta = delta;
    d.text = `${Math.round((delta * 180) / Math.PI)}°`;
    this._applyRotation(d.orig, d.c, delta);
    this.changed();
  }

  _stretchMove(d, w, e) {
    const part = findPart(this.build, d.uid);
    const others = this.build.parts.filter((p) => p.uid !== part.uid);
    const end = snapDrawEnd(others, kindOf(part), d.fixed, w, { freeAngle: e.altKey });
    const [a, b] = d.end === 1 ? [d.fixed, end] : [end, d.fixed];
    const l = lineFrom(a, b);
    Object.assign(part, { x: l.x, y: l.y, angle: l.angle });
    part.props.length = +l.length.toFixed(4);
    d.label = { x: end.x, y: end.y, text: this._lengthLabel(part.type, l.length) + (end.hint ? ` · ${end.hint}` : '') };
    this.changed();
  }

  /** Scale tool: drag a handle to resize. */
  _scaleMove(d, w) {
    const part = findPart(this.build, d.uid);
    const def = partDef(part);
    const sp = d.spec;
    let raw;
    if (sp.axis) {
      const l = worldToLocal(part.x, part.y, part.angle, w.x, w.y);
      raw = 2 * Math.abs(sp.axis === 'x' ? l.x : l.y);
    } else {
      const R = Math.hypot(w.x - part.x, w.y - part.y);
      if (sp.key === 'teeth') raw = def.kind === 'sprocket' ? (R - 0.12) / 0.06 : (2 * (R - 0.18)) / 0.2;
      else raw = R;
    }
    let v = Math.round(raw / sp.step) * sp.step;
    v = Math.max(sp.min, Math.min(sp.max, +v.toFixed(3)));
    part.props[sp.key] = v;
    const nd = partDef(part);
    d.label = { x: part.x, y: part.y + (nd.height ? nd.height / 2 : outerRadius(nd)),
      text: sp.key === 'teeth' ? `${v} teeth` : `${sp.key} ${v.toFixed(2).replace(/\.?0+$/, '')} m` };
    this.changed();
  }

  _marqueeEnd(d, e) {
    if (!d.moved || !d.box) { if (this.tool === 'delete') this.toast('Drag a box to delete everything inside it', 1500); return; }
    const b = d.box;
    const inside = (p) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
    const solid = this.build.parts.filter((p) => !isLinkKind(kindOf(p)) && inside(p));
    const ids = new Set(solid.map((p) => p.uid));
    if (this.tool === 'delete') {
      if (solid.length) { this.deleteParts([...ids]); this.toast(`🔨 Removed ${solid.length} part${solid.length > 1 ? 's' : ''}`, 1400); }
      return;
    }
    const uids = [...ids];
    this.setSelection(d.add ? [...this.selection, ...uids] : uids);
    if (uids.length > 1) this.toast(`${this.selection.size} parts selected`, 1200);
  }

  /** Wrench: click a control, then a motor (either order). */
  _wireClick(hit) {
    const k = hit && kindOf(hit);
    const ok = hit && (roleOf(k) === 'control' || k === 'motor');
    if (!ok) {
      if (hit && k === 'wire') { this.select(hit.uid); this.toast('Wire selected: press Delete to cut it', 1600); return; }
      if (this.wirePick != null) { this.wirePick = null; this.toast('Wire cancelled'); }
      else this.toast('Click a Switch, Button or Key, then a motor (or the other way round)');
      return;
    }
    if (this.wirePick == null || this.wirePick === hit.uid) {
      this.wirePick = hit.uid;
      this.toast(roleOf(k) === 'control' ? 'Now click the motor it should control' : 'Now click the Switch, Button or Key that controls it');
      return;
    }
    const first = findPart(this.build, this.wirePick);
    const kinds = [roleOf(kindOf(first)) === 'control', roleOf(k) === 'control'];
    if (kinds[0] === kinds[1]) {
      this.toast(kinds[0] ? 'Wire a control to a MOTOR' : 'Wire a motor to a Switch, Button or Key');
      this.wirePick = hit.uid;
      return;
    }
    this.toggleWire(this.wirePick, hit.uid);
    this.wirePick = null;
  }

  /** Pointer moved with no button held: hover highlight, previews, cursor. */
  _hover(w, e) {
    if (!this.editable) {
      const hit = this._pick(w);
      const k = hit && kindOf(hit);
      this.canvas.style.cursor = k === 'switch' || k === 'button' || k === 'keyButton' || k === 'crank' ? 'pointer' : '';
      this.hoverUid = null;
      return;
    }
    const type = this.armedType;
    const def = type ? getDef(type) : null;
    if (type) {
      if (this.drawing) this._drawPreview(this.drawing.type, this.drawing.a, w, e);
      else if (def.drawn) {
        this.drawStart = snapEnd(this.build.parts, def.kind, w.x, w.y, { grid: this.options.grid });
        this.ghost = this.drawStart.hint ? { type, x: this.drawStart.x, y: this.drawStart.y, angle: 0, hint: this.drawStart.hint, hintOnly: true } : null;
      } else if (def.kind === 'chain') this.ghost = null;
      else this._updateGhost(type, w);
      if (def.kind === 'chain') {
        const hit = this._pick(w);
        this.hoverUid = hit && chainTeeth(partDef(hit)) ? hit.uid : null;
        this.canvas.style.cursor = this.hoverUid != null ? 'pointer' : 'crosshair';
      } else {
        this.hoverUid = null;
        this.canvas.style.cursor = 'crosshair';
      }
      return;
    }
    const hit = this._pick(w);
    const tool = this.tool;
    const k = hit && kindOf(hit);
    if (tool === 'wire') this.hoverUid = hit && (roleOf(k) === 'control' || k === 'motor' || k === 'wire') ? hit.uid : null;
    else this.hoverUid = hit?.uid ?? null;
    const h = (tool === 'move' || tool === 'scale') && this._handleAt(this._screenAt(e));
    const cursor = {
      move: h ? 'nwse-resize' : hit ? 'grab' : '',
      rotate: hit ? 'alias' : '',
      scale: h ? 'nwse-resize' : hit ? 'pointer' : '',
      wire: this.hoverUid != null ? 'pointer' : 'crosshair',
      props: hit ? 'pointer' : '',
      delete: hit ? 'not-allowed' : 'crosshair',
    }[tool];
    this.canvas.style.cursor = cursor;
  }

  /** Pointer pressed in the world while placing a part from the gallery. */
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
      if (!hit || !chainTeeth(partDef(hit))) {
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
    if (def.drawn || def.tool) { this.setPlacing(this.armedType === type ? null : type); return; }
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
        // A plain click picks the part: click the world to place, as many
        // times as you like.
        this.setPlacing(this.armedType === type ? null : type);
      } else {
        this.ghost = null;
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Start placing a part from the gallery (null = stop placing). */
  setPlacing(type) {
    if (type && !this.editable) { this.toast('Press ⟲ Reset to edit your build'); return; }
    this.armedType = type;
    this.ghost = null;
    this.drawing = null;
    this.drawStart = null;
    this.chainPick = null;
    this.gallery.setArmed(type);
    this._syncToolUI();
  }

  /** Pick a toolbar tool. Stops placing. */
  setTool(id) {
    if (!this.editable) return;
    this.tool = id;
    this.wirePick = null;
    this.setPlacing(null);
    this._syncPropsPop();
    this.emit('tool');
  }

  _cancelPlacement() { this.setPlacing(null); }

  /** Esc / right-click: back out of whatever you're in the middle of. */
  _cancelAll() {
    if (this.drawing || this.chainPick != null || this.wirePick != null) {
      this.drawing = null; this.chainPick = null; this.wirePick = null; this.ghost = null;
    } else if (this.armedType) this.setPlacing(null);
    else if (this.selection.size) this.setSelection([]);
    else if (this.tool !== 'move') this.setTool('move');
  }

  /** Tool chip + toolbar highlight. */
  _syncToolUI() {
    for (const [id, el] of this.toolButtons || []) el.classList.toggle('on', id === this.tool && !this.armedType);
    const chip = this.toolChipEl;
    if (!chip) return;
    if (!this.editable) {
      // While playing the chip shows what the camera is following.
      const part = this.followUid != null && this.sim?.parts.find((p) => p.uid === this.followUid);
      if (!part) { chip.hidden = true; return; }
      chip.innerHTML = `<b>🎥 Following ${getDef(part.type).name}</b><span>click a part to follow it instead</span><button class="chip-x" title="Stop following">Stop ✕</button>`;
      chip.querySelector('button').addEventListener('click', () => this.follow(null));
      chip.hidden = false;
      return;
    }
    const type = this.armedType;
    let title = null, how = '';
    if (type) {
      const def = getDef(type);
      title = def.name;
      how = def.kind === 'chain' ? 'click a sprocket or gear, then another'
        : def.drawn ? 'drag from one point to another (or click, click). Alt = any angle'
        : 'click to place, again and again';
    } else if (this.tool !== 'move') {
      const t = TOOLS.find((x) => x.id === this.tool);
      title = `${t.icon} ${t.name}`;
      how = t.tip;
    }
    if (!title) { chip.hidden = true; return; }
    chip.innerHTML = `<b>${title}</b><span>${how}</span><button class="chip-x" title="Stop (Esc)">Esc ✕</button>`;
    chip.querySelector('button').addEventListener('click', () => (type ? this.setPlacing(null) : this.setTool('move')));
    chip.hidden = false;
  }

  /** The toolbar along the bottom of the world (Build a Boat style). */
  _buildToolbar() {
    const bar = document.getElementById('dock');
    if (!bar) return;
    this.toolButtons = new Map();
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'dock-btn';
      b.title = `${t.name} (${t.key})\n${t.tip}`;
      b.innerHTML = `<span class="dock-ico">${t.icon}</span><span class="dock-name">${t.name}</span><kbd>${t.key}</kbd>`;
      b.addEventListener('click', () => this.setTool(t.id));
      bar.appendChild(b);
      this.toolButtons.set(t.id, b);
    }
    this.on((type) => { if (type === 'state') bar.classList.toggle('disabled', !this.editable); });
    this._syncToolUI();
  }

  // =================================================================== keys ==
  /** Arrow keys / key controls while playing. */
  _syncKeys() {
    if (this.sim) this.sim.setKeys(this.keys);
  }

  /** Edit mode: arrow keys pan the view. */
  _panWithKeys(dt) {
    if (!this.keys.size) return;
    // While playing, arrows the machine uses drive it instead.
    const bound = this.sim ? this.sim.boundKeys : new Set();
    const held = (k) => this.keys.has(k) && !bound.has(k);
    if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].some(held)) return;
    if (this.followUid != null) { this.followUid = null; this._syncToolUI(); }
    const sp = (600 / this.camera.zoom) * dt;
    if (held('arrowleft')) this.camera.x -= sp;
    if (held('arrowright')) this.camera.x += sp;
    if (held('arrowup')) this.camera.y += sp;
    if (held('arrowdown')) this.camera.y -= sp;
  }

  _bindKeys() {
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (this.keys.delete(k)) this._syncKeys();
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select, dialog')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // While playing, keys bound to Key controls (and the arrows) drive the machine.
      if (this.sim && !mod && this.sim.boundKeys.has(k)) {
        e.preventDefault();
        if (!e.repeat) { this.keys.add(k); this._syncKeys(); }
        return;
      }
      if (!mod && k.startsWith('arrow')) { e.preventDefault(); this.keys.add(k); return; }
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
      } else if (mod && k === 's') {
        e.preventDefault();
        this.openSaveDialog();
      } else if (mod && k === 'y') {
        e.preventDefault();
        this.redo();
      } else if (mod && k === 'a' && this.editable) {
        e.preventDefault();
        this.setSelection(this.build.parts.filter((p) => !isLinkKind(kindOf(p))).map((p) => p.uid));
      } else if (mod && k === 'c' && this.editable) {
        if (this.copySelection()) this.toast(`Copied ${this.selection.size} part${this.selection.size > 1 ? 's' : ''}`, 1200);
      } else if (mod && k === 'v' && this.editable) {
        e.preventDefault();
        this.paste(this.mouse);
      } else if (mod && k === 'd' && this.editable) {
        e.preventDefault();
        this.duplicateSelection();
      } else if (k === ' ') {
        e.preventDefault();
        if (this.state === 'playing') this.pause(); else this.play();
      } else if (k === 'escape') {
        this._cancelAll();
      } else if ((k === 'delete' || k === 'backspace') && !mod) {
        e.preventDefault();
        this.deleteSelection();
      } else if (!mod && (k === 'e' || (k === 'r' && !e.shiftKey && this.editable))) {
        this.rotateSelection(-1); // clockwise
      } else if (!mod && (k === 'q' || (k === 'r' && e.shiftKey))) {
        this.rotateSelection(1);  // counter-clockwise
      } else if (k === 'r' && !mod && !this.editable) {
        this.reset();
      } else if (k === 'home') {
        this.recenter();
      } else if (!mod && !e.altKey && this.editable && k === 'v') {
        this.setTool('move');
      } else if (!mod && !e.altKey && this.editable && TOOLS.some((t) => t.key === k)) {
        this.setTool(TOOLS.find((t) => t.key === k).id);
      } else if (!mod && !e.altKey && this.editable && Object.values(HOTKEYS).includes(k.toUpperCase())) {
        const id = Object.keys(HOTKEYS).find((x) => HOTKEYS[x] === k.toUpperCase());
        this.setPlacing(this.armedType === id ? null : id);
      } else {
        this.mode.onKey?.(this, e);
      }
    });
  }
}
