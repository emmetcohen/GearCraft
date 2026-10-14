// =============================================================================
// renderer.js — draws the whole scene: sky, grid, ground, parts, overlays.
//
// The renderer is "dumb": every frame the app hands it a SCENE object
// describing what to draw. It never changes game state.
// =============================================================================
import { getDef, partDef, OUTLINE, roleOf, chainRadius } from '../parts/partDefs.js';
import { outerRadius, socketsOf, lineEnds, lineFrom } from '../parts/geometry.js';
import { drawPart, drawWhole, hasHub, hubFirst, drawChain, ropeStroke } from './draw.js';

/** Camera: world point (x, y) at the canvas centre, `zoom` pixels per unit. */
export class Camera {
  constructor(x = 0, y = 5, zoom = 36) { this.x = x; this.y = y; this.zoom = zoom; this.w = 1; this.h = 1; }
  worldToScreen(wx, wy) {
    return { x: (wx - this.x) * this.zoom + this.w / 2, y: this.h / 2 - (wy - this.y) * this.zoom };
  }
  screenToWorld(sx, sy) {
    return { x: (sx - this.w / 2) / this.zoom + this.x, y: (this.h / 2 - sy) / this.zoom + this.y };
  }
  /** Zoom around a screen point so the thing under the cursor stays put. */
  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.max(2.5, Math.min(160, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }
}

const CANNON_BALL = { kind: 'ball', radius: 0.25, color: '#343a40', category: 'objects' };

/** Draw order: lower numbers are drawn first (further back). */
function layerOf(def) {
  if (def.kind === 'ramp' || def.kind === 'block' || def.kind === 'track' || def.kind === 'conveyor' || def.kind === 'bouncePad') return 0;
  if (def.kind === 'water') return 8; // see-through, on top of everything
  if (def.kind === 'piston' || def.kind === 'trapdoor') return 1.6;
  if (def.kind === 'latch') return 5.9;
  if (roleOf(def.kind) === 'gadget') return 5.7;
  if (def.kind === 'chain') return 4;
  if (def.kind === 'wire') return 7;
  if (roleOf(def.kind) === 'control') return 5.8;
  if (def.kind === 'bolt') return 5.9;
  if (def.kind === 'slider') return 1.5; // rail sits on top of the beam it's bolted to
  if (def.kind === 'spring' || def.kind === 'rope') return 5.5;
  if (roleOf(def.kind) === 'beam') return 1;
  if (roleOf(def.kind) === 'driver') return 2;
  if (roleOf(def.kind) === 'rotor') return 3;
  if (roleOf(def.kind) === 'connector') return 5;
  return 6; // loose objects on top
}

export class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.dpr = 1;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.camera.w = r.width;
    this.camera.h = r.height;
  }

  render(scene) {
    const { ctx, camera } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._background(scene);

    const px = camera.zoom;
    // Same layer: bigger rotors first, so a small gear stacked on a big one shows on top.
    const size = (def) => (roleOf(def.kind) === 'rotor' ? -outerRadius(def) : 0);
    // A beam bolted onto a gear draws on top of the gear.
    const layer = (x) => (scene.onTop?.has(x.p.uid) ? 3.5 : layerOf(x.def));
    const parts = [...scene.parts].map((p, i) => ({ p, i, def: partDef(p) }))
      .sort((a, b) => layer(a) - layer(b) || size(a.def) - size(b.def) || a.i - b.i);
    const byUid = new Map(scene.parts.map((p) => [p.uid, p]));

    const drawOne = (p, def, layer) => {
      if (def.kind === 'chain') return this._chain(scene, p, byUid);
      if (def.kind === 'wire') return this._wire(scene, p, byUid);
      if (def.kind === 'spring' || def.kind === 'rope') return this._link(scene, p, def);
      const t = scene.transformOf(p.uid, layer);
      if (!t) return;
      const s = camera.worldToScreen(t.x, t.y);
      drawPart(ctx, def, { sx: s.x, sy: s.y, angle: t.angle }, px, {
        layer, load: scene.loadOf(p.uid), loadView: scene.loadView, squash: scene.squashOf(p.uid),
        on: scene.signalOf?.(p.uid), props: p.props,
      });
    };
    for (const { p, def } of parts) {
      if (hubFirst(def.kind)) drawOne(p, def, 'hub'); // a piston rod slides out from under its cylinder
      drawOne(p, def, 'main');
    }
    // Spinning hubs (motor shafts, crank handles, slider blocks) go above the rotors.
    for (const { p, def } of parts) if (hasHub(def.kind) && !hubFirst(def.kind)) drawOne(p, def, 'hub');

    // Cannon balls in flight.
    for (const s of scene.shots || []) {
      const p = camera.worldToScreen(s.x, s.y);
      drawPart(ctx, CANNON_BALL, { sx: p.x, sy: p.y, angle: s.angle }, px, {});
    }
    // Explosions: a quick orange flash that grows and fades.
    for (const b of scene.booms || []) {
      const p = camera.worldToScreen(b.x, b.y);
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - b.t);
      for (const [r, c] of [[2.6, '#ff9e00'], [1.7, '#ffd23f'], [0.8, '#ffffff']]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, (0.4 + b.t) * r * px, 0, Math.PI * 2);
        ctx.fillStyle = c;
        ctx.fill();
      }
      ctx.restore();
    }

    this._overlays(scene);
  }

  /** A chain wrapped round two sprockets/gears, at their live positions. */
  _chain(scene, part, byUid) {
    const pa = byUid.get(part.props.a), pb = byUid.get(part.props.b);
    if (!pa || !pb) return;
    const ta = scene.transformOf(pa.uid), tb = scene.transformOf(pb.uid);
    if (!ta || !tb) return;
    const z = this.camera.zoom;
    const ra = (chainRadius(partDef(pa)) + 0.05) * z, rb = (chainRadius(partDef(pb)) + 0.05) * z;
    const sa = this.camera.worldToScreen(ta.x, ta.y), sb = this.camera.worldToScreen(tb.x, tb.y);
    const state = scene.selection?.has(part.uid) ? 'selected' : scene.badChains?.has(part.uid) ? 'bad' : 'ok';
    // Links travel with sprocket A's rotation (screen y is flipped, hence +).
    drawChain(this.ctx, { x: sa.x, y: sa.y, r: ra }, { x: sb.x, y: sb.y, r: rb }, ta.angle * ra, state);
  }

  /** An electric wire from a control to a motor (edit mode only). */
  _wire(scene, part, byUid) {
    if (scene.mode !== 'edit') return;
    const pa = byUid.get(part.props.a), pb = byUid.get(part.props.b);
    if (!pa || !pb) return;
    const a = this.camera.worldToScreen(pa.x, pa.y), b = this.camera.worldToScreen(pb.x, pb.y);
    const { ctx } = this;
    const strong = scene.wiresStrong || scene.selection?.has(part.uid);
    ctx.save();
    ctx.globalAlpha = strong ? 1 : 0.45;
    // A gentle droop, like a real cable.
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + Math.min(60, Math.hypot(b.x - a.x, b.y - a.y) * 0.18);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.lineCap = 'round';
    if (scene.selection?.has(part.uid)) { ctx.strokeStyle = '#ff006e'; ctx.lineWidth = 9; ctx.stroke(); }
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    ctx.lineDashOffset = -performance.now() / 50; // current flowing to the motor
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd23f';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = OUTLINE;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A spring or rope between its two (live) ends. */
  _link(scene, part, def) {
    const ends = scene.linkEndsOf(part.uid) || lineEnds(part);
    const [a, b] = ends;
    const cur = lineFrom(a, b);
    const { ctx, camera } = this;
    const px = camera.zoom;
    if (def.kind === 'rope' && cur.length < def.length - 0.02) {
      // Slack rope: sag in the middle by about how much spare length there is.
      const sag = Math.sqrt(Math.max(0, def.length ** 2 - cur.length ** 2)) / 2;
      const sa = camera.worldToScreen(a.x, a.y), sb = camera.worldToScreen(b.x, b.y);
      const m = camera.worldToScreen(cur.x, cur.y - sag * 1.6);
      ctx.save();
      ropeStroke(ctx, 1, def.color, (c) => { c.moveTo(sa.x, sa.y); c.quadraticCurveTo(m.x, m.y, sb.x, sb.y); });
      ctx.restore();
      return;
    }
    const s = camera.worldToScreen(cur.x, cur.y);
    drawPart(ctx, { ...def, length: Math.max(0.05, cur.length) }, { sx: s.x, sy: s.y, angle: cur.angle }, px, {});
  }

  _background(scene) {
    const { ctx, camera } = this;
    const W = camera.w, H = camera.h;
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#bfe9ff');
    sky.addColorStop(1, '#eaf8ff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Grid: fine lines every 0.4 units when zoomed in, plus bolder ones every 2.
    const tl = camera.screenToWorld(0, 0), br = camera.screenToWorld(W, H);
    const drawGrid = (step, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        const sx = Math.round(camera.worldToScreen(x, 0).x) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, H);
      }
      for (let y = Math.floor(br.y / step) * step; y <= tl.y; y += step) {
        const sy = Math.round(camera.worldToScreen(0, y).y) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(W, sy);
      }
      ctx.stroke();
    };
    if (camera.zoom > 28 && scene.mode === 'edit' && scene.grid !== false) drawGrid(0.4, 'rgba(43,33,64,0.05)', 1);
    // Zoomed far out, space the bold lines further apart so they don't blur together.
    drawGrid(camera.zoom > 10 ? 2 : camera.zoom > 4 ? 10 : 20, 'rgba(43,33,64,0.09)', 1);

    // Ground: grass strip on dirt, top at y = 0, out to ±halfWidth.
    const half = scene.map.groundHalfWidth;
    const g0 = camera.worldToScreen(-half, 0), g1 = camera.worldToScreen(half, 0);
    const left = Math.max(-10, g0.x), right = Math.min(W + 10, g1.x);
    if (g0.y < H && right > left) {
      ctx.fillStyle = '#a0704a';
      ctx.fillRect(left, g0.y, right - left, H - g0.y + 10);
      // Pebbles (deterministic so they don't flicker).
      ctx.fillStyle = '#8a5e3c';
      const pstep = camera.zoom > 8 ? 1 : 4;
      for (let wx = Math.floor(tl.x / pstep) * pstep; wx < br.x; wx += pstep) {
        const h = Math.sin(wx * 12.9898) * 43758.5453;
        const f = h - Math.floor(h);
        const s = camera.worldToScreen(wx + f, -0.6 - f * 2);
        ctx.beginPath(); ctx.arc(s.x, s.y, camera.zoom * 0.08, 0, Math.PI * 2); ctx.fill();
      }
      const gh = Math.max(4, camera.zoom * 0.3);
      ctx.fillStyle = '#7bd389';
      ctx.fillRect(left, g0.y, right - left, gh);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(left, g0.y); ctx.lineTo(right, g0.y); ctx.stroke();
    }
  }

  _overlays(scene) {
    const { ctx, camera } = this;
    const px = camera.zoom;

    // Snap points (while placing/drawing): every socket you could attach to.
    if (scene.showSockets) {
      ctx.save();
      for (const p of scene.parts) {
        for (const so of socketsOf(p)) {
          const s = camera.worldToScreen(so.x, so.y);
          ctx.beginPath();
          ctx.arc(s.x, s.y, so.pivot ? 5 : 3.5, 0, Math.PI * 2);
          ctx.fillStyle = so.pivot ? 'rgba(255,224,102,0.95)' : 'rgba(255,255,255,0.9)';
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(43,33,64,0.6)';
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Spring/rope ends that hang on the background.
    for (const e of scene.skyPins || []) {
      const s = camera.worldToScreen(e.x, e.y);
      drawPart(ctx, getDef('pin-fixed'), { sx: s.x, sy: s.y, angle: 0 }, Math.max(px, 30) * 0.7, {});
    }

    // Loose (unanchored) rope/spring ends: a little hook.
    for (const e of scene.hooks || []) {
      const s = camera.worldToScreen(e.x, e.y);
      const r = Math.max(4, 0.16 * px);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(s.x, s.y + r * 1.4, r, Math.PI * 0.9, Math.PI * 0.1, true);
      ctx.moveTo(s.x + r, s.y + r * 1.4); ctx.lineTo(s.x + r, s.y + r * 0.2);
      ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + r, s.y + r * 0.3);
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = '#c9ced6'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.restore();
    }

    // Joint markers (edit mode): what each shared point does.
    //   bolt (dark square) = bolted solid · ring = spins freely · yellow = motor/crank drives it
    if (scene.mode === 'edit' && scene.joints && px > 14) {
      for (const j of scene.joints) {
        const s = camera.worldToScreen(j.x, j.y);
        ctx.save();
        ctx.translate(s.x + 9, s.y - 9);
        ctx.lineWidth = 2;
        ctx.strokeStyle = OUTLINE;
        if (j.type === 'weld') {
          ctx.fillStyle = '#5c5470';
          ctx.beginPath(); ctx.roundRect(-4, -4, 8, 8, 2); ctx.fill(); ctx.stroke();
        } else {
          ctx.fillStyle = j.type === 'drive' ? '#ffd23f' : '#ffffff';
          ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.arc(0, 0, 2.2, 0.3, Math.PI * 1.6); ctx.lineWidth = 1.5; ctx.stroke();
        }
        ctx.restore();
      }
    }

    // Mesh contact markers (edit mode) — shows which gears are engaged.
    if (scene.mode === 'edit') {
      for (const m of scene.meshes) {
        if (m.chain) continue;
        const s = camera.worldToScreen(m.contact.x, m.contact.y);
        const bad = m.status !== 'ok' || m.jammed;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = bad ? '#ef233c' : '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = OUTLINE;
        ctx.stroke();
      }
    }

    // Hover + selection rings.
    const ring = (uid, style) => {
      const part = uid != null ? scene.parts.find((p) => p.uid === uid) : null;
      if (!part) return;
      const def = partDef(part);
      if (def.kind === 'chain') return; // chains highlight themselves
      let t = scene.transformOf(part.uid, 'main');
      let len = def.length;
      if (def.kind === 'spring' || def.kind === 'rope') {
        const ends = scene.linkEndsOf(part.uid);
        if (ends) { const l = lineFrom(ends[0], ends[1]); t = l; len = l.length; }
      }
      if (!t) return;
      const s = camera.worldToScreen(t.x, t.y);
      ctx.save();
      style();
      if (def.drawn || def.kind === 'beam' || def.kind === 'crate' || def.kind === 'block' || def.kind === 'ramp') {
        const w = (len ?? def.width) + (def.thickness ?? 0) + 0.3;
        const h = Math.max(def.thickness ?? def.height, 0.3) + 0.3;
        ctx.translate(s.x, s.y);
        ctx.rotate(-t.angle);
        ctx.beginPath();
        ctx.roundRect((-w / 2) * px, (-h / 2) * px, w * px, h * px, Math.min(12, (h / 2) * px));
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(s.x, s.y, (outerRadius(def) + 0.15) * px, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    };
    if (!scene.selection?.has(scene.hoverUid)) {
      ring(scene.hoverUid, () => { ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,0,110,0.35)'; });
    }
    for (const uid of scene.selection || []) {
      ring(uid, () => {
        ctx.setLineDash([6, 5]);
        ctx.lineDashOffset = -performance.now() / 40; // marching ants
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ff006e';
      });
    }
    // Chain tool: the first sprocket you picked.
    ring(scene.pickedUid, () => { ctx.lineWidth = 4; ctx.strokeStyle = '#ffd23f'; });

    // Rotate tool: a ring round the selection with a knob to drag.
    if (scene.rotateGizmo) {
      const g = scene.rotateGizmo;
      const c = camera.worldToScreen(g.x, g.y);
      const r = g.r * px + 18;
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#3a86ff';
      ctx.setLineDash([10, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      const k = { x: c.x + Math.cos(-g.angle) * r, y: c.y + Math.sin(-g.angle) * r };
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(k.x, k.y);
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(58,134,255,0.6)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(k.x, k.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#3a86ff'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#3a86ff'; ctx.fill();
      if (g.label) this._bubble(c.x, c.y - r - 22, g.label, '#ffffff');
      ctx.restore();
    }

    // Handles: pink circles stretch drawn parts, blue squares scale.
    for (const h of scene.handles || []) {
      const s = camera.worldToScreen(h.x, h.y);
      ctx.beginPath();
      if (h.kind === 'scale') ctx.roundRect(s.x - 7, s.y - 7, 14, 14, 3);
      else ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = h.kind === 'scale' ? '#3a86ff' : '#ff006e';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    if (scene.handleLabel) {
      const s = camera.worldToScreen(scene.handleLabel.x, scene.handleLabel.y);
      this._bubble(s.x, s.y - 24, scene.handleLabel.text, '#ffffff');
    }

    // Drag-select box.
    if (scene.marquee) {
      const m = scene.marquee;
      const a = camera.worldToScreen(m.x0, m.y0), b = camera.worldToScreen(m.x1, m.y1);
      ctx.save();
      ctx.fillStyle = m.del ? 'rgba(239,35,60,0.12)' : 'rgba(58,134,255,0.12)';
      ctx.strokeStyle = m.del ? '#ef233c' : '#3a86ff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
    }

    // Placement ghost + snap hint.
    if (scene.ghost) {
      const g = scene.ghost;
      const def = g.length != null ? partDef({ type: g.type, props: { length: g.length } }) : partDef({ type: g.type, props: g.props ?? {} });
      const s = camera.worldToScreen(g.x, g.y);
      if (!g.hintOnly) drawWhole(ctx, def, { sx: s.x, sy: s.y, angle: g.angle }, px, { ghost: true, props: g.props });
      if (g.label) {
        const e = camera.worldToScreen(g.labelAt.x, g.labelAt.y);
        this._bubble(e.x, e.y - 22, g.label, '#ffffff');
      }
      const r = def.drawn ? 0.4 : outerRadius(def);
      if (g.hint) this._bubble(s.x, s.y - (r * px + 22), `✨ ${g.hint}`, '#ffffff');
    }
    // A drawing tool's start point, before you drag.
    if (scene.drawStart) {
      const s = camera.worldToScreen(scene.drawStart.x, scene.drawStart.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = scene.drawStart.attached ? '#ffd23f' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = OUTLINE;
      ctx.stroke();
    }

    // Floating labels (STALLED / JAMMED / "no axle!").
    for (const l of scene.labels) {
      const s = camera.worldToScreen(l.x, l.y);
      this._bubble(s.x, s.y, l.text, l.color);
    }
  }

  /** A rounded speech-bubble label in screen space. */
  _bubble(x, y, text, color) {
    const { ctx } = this;
    ctx.font = '700 13px Fredoka, "Baloo 2", ui-rounded, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 16, h = 22;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 11);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    ctx.fillStyle = OUTLINE;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 1);
  }
}
