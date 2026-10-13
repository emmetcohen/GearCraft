// =============================================================================
// renderer.js — draws the whole scene: sky, grid, ground, parts, overlays.
//
// The renderer is "dumb": every frame the app hands it a SCENE object
// describing what to draw. It never changes game state.
// =============================================================================
import { getDef, OUTLINE, roleOf } from '../parts/partDefs.js';
import { outerRadius } from '../parts/geometry.js';
import { drawPart, hasHub } from './draw.js';

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
    this.zoom = Math.max(8, Math.min(160, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }
}

/** Draw order: lower numbers are drawn first (further back). */
function layerOf(def) {
  if (def.kind === 'ramp' || def.kind === 'block') return 0;
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
    const parts = [...scene.parts].map((p, i) => ({ p, i, def: getDef(p.type) }))
      .sort((a, b) => layerOf(a.def) - layerOf(b.def) || a.i - b.i);

    const drawOne = (p, def, layer) => {
      const t = scene.transformOf(p.uid, layer);
      if (!t) return;
      const s = camera.worldToScreen(t.x, t.y);
      drawPart(ctx, def, { sx: s.x, sy: s.y, angle: t.angle }, px, {
        layer, load: scene.loadOf(p.uid), loadView: scene.loadView, squash: scene.squashOf(p.uid),
      });
    };
    for (const { p, def } of parts) drawOne(p, def, 'main');
    // Spinning hubs (motor shafts, crank handles) go above the rotors.
    for (const { p, def } of parts) if (hasHub(def.kind)) drawOne(p, def, 'hub');

    this._overlays(scene);
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
    if (camera.zoom > 28 && scene.mode === 'edit') drawGrid(0.4, 'rgba(43,33,64,0.05)', 1);
    drawGrid(2, 'rgba(43,33,64,0.09)', 1);

    // Ground: grass strip on dirt, top at y = 0, out to ±halfWidth.
    const half = scene.map.groundHalfWidth;
    const g0 = camera.worldToScreen(-half, 0), g1 = camera.worldToScreen(half, 0);
    const left = Math.max(-10, g0.x), right = Math.min(W + 10, g1.x);
    if (g0.y < H && right > left) {
      ctx.fillStyle = '#a0704a';
      ctx.fillRect(left, g0.y, right - left, H - g0.y + 10);
      // Pebbles (deterministic so they don't flicker).
      ctx.fillStyle = '#8a5e3c';
      for (let wx = Math.floor(tl.x); wx < br.x; wx += 1) {
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

    // Mesh contact markers (edit mode) — shows which gears are engaged.
    if (scene.mode === 'edit') {
      for (const m of scene.meshes) {
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

    // Selection ring.
    const sel = scene.selectedUid != null ? scene.parts.find((p) => p.uid === scene.selectedUid) : null;
    if (sel) {
      const def = getDef(sel.type);
      const t = scene.transformOf(sel.uid, 'main');
      const s = camera.worldToScreen(t.x, t.y);
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -performance.now() / 40; // marching ants
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ff006e';
      if (def.kind === 'beam' || def.kind === 'crate' || def.kind === 'block' || def.kind === 'ramp') {
        const w = (def.length ?? def.width) + (def.thickness ?? 0) + 0.3;
        const h = (def.thickness ?? def.height) + 0.3;
        ctx.translate(s.x, s.y);
        ctx.rotate(-t.angle);
        ctx.strokeRect((-w / 2) * px, (-h / 2) * px, w * px, h * px);
      } else {
        ctx.beginPath();
        ctx.arc(s.x, s.y, (outerRadius(def) + 0.15) * px, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Placement ghost + snap hint.
    if (scene.ghost) {
      const g = scene.ghost;
      const def = getDef(g.type);
      const s = camera.worldToScreen(g.x, g.y);
      if (!g.hintOnly) drawPart(ctx, def, { sx: s.x, sy: s.y, angle: g.angle }, px, { ghost: true });
      if (!g.hintOnly && (def.kind === 'motor' || def.kind === 'crank')) {
        drawPart(ctx, def, { sx: s.x, sy: s.y, angle: g.angle }, px, { ghost: true, layer: 'hub' });
      }
      if (g.hint) this._bubble(s.x, s.y - (outerRadius(def) * px + 22), `✨ ${g.hint}`, '#ffffff');
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
