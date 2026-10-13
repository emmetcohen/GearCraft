// =============================================================================
// gallery.js — the left-hand parts gallery, built entirely from partDefs.js.
//
// Interaction:
//   • press on a part and drag it onto the world to place one, OR
//   • click a part to pick it as your TOOL, then click in the world as many
//     times as you like. Esc, right-click or clicking it again puts it down.
//   • drawn parts (beams, springs, track...) and the chain are always tools:
//     click-drag in the world to draw them.
// =============================================================================
import { CATEGORIES, PARTS, getDef } from '../parts/partDefs.js';
import { outerRadius } from '../parts/geometry.js';
import { drawPart, hasHub, drawChain } from '../render/draw.js';


/** How big a part is, so its thumbnail can be scaled to fit. */
function extentOf(def) {
  if (def.drawn) return (def.length + def.thickness) / 2;
  switch (def.kind) {
    case 'beam': return (def.length + def.thickness) / 2;
    case 'crate': case 'block': return Math.max(def.width, def.height) / 2;
    case 'ramp': return Math.max(def.width, def.height) / 2;
    case 'crank': return def.armLength * 0.75;
    default: return outerRadius(def);
  }
}

/** Draw a part's picture into a small canvas (also used by the tool dock). */
export function drawThumb(canvas, def, THUMB_W = 64, THUMB_H = 56) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = THUMB_W * dpr;
  canvas.height = THUMB_H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (def.kind === 'chain') {
    // Two sprockets and a chain.
    const sp = getDef('sprocket-16'), sm = getDef('sprocket-10');
    const z = (THUMB_W / 64) * 15;
    const a = { x: THUMB_W * 0.31, y: THUMB_H / 2, r: sp.radius * z }, b = { x: THUMB_W * 0.78, y: THUMB_H / 2, r: sm.radius * z };
    drawPart(ctx, sp, { sx: a.x, sy: a.y, angle: 0 }, z);
    drawPart(ctx, sm, { sx: b.x, sy: b.y, angle: 0 }, z);
    drawChain(ctx, { ...a, r: a.r + 1 }, { ...b, r: b.r + 1 }, 0);
    return;
  }
  const px = Math.min(26 * THUMB_W / 64, (Math.min(THUMB_W, THUMB_H) / 2 - 3) / extentOf(def));
  // Cranks look best centred on their arm.
  const cx = def.kind === 'crank' ? THUMB_W / 2 - (def.armLength * px) / 2 : THUMB_W / 2;
  const angle = def.kind === 'beam' || def.kind === 'spring' || def.kind === 'rope' ? Math.PI / 9 : 0;
  drawPart(ctx, def, { sx: cx, sy: THUMB_H / 2, angle }, px);
  if (hasHub(def.kind)) drawPart(ctx, def, { sx: cx, sy: THUMB_H / 2, angle: def.kind === 'crank' ? 0 : angle }, px, { layer: 'hub' });
}

/**
 * @param root      the <aside> to fill
 * @param handlers  { onDragStart(type, pointerEvent) }
 * @param filter    optional (def) => bool, so a mode can limit parts
 * @param hotkeys   optional { partId: 'B', ... } shown as little key badges
 */
export function buildGallery(root, handlers, filter = () => true, hotkeys = {}) {
  root.innerHTML = '';
  const items = new Map();
  for (const cat of CATEGORIES) {
    const parts = PARTS.filter((p) => p.category === cat.id && !p.hidden && filter(p));
    if (!parts.length) continue;
    const box = document.createElement('section');
    box.className = 'cat';
    box.style.setProperty('--cat-color', cat.color);
    box.innerHTML = `<button class="cat-head" aria-expanded="true"><span>${cat.icon}</span>${cat.name}<span class="chev">▾</span></button><div class="cat-body"></div>`;
    const head = box.querySelector('.cat-head');
    head.addEventListener('click', () => {
      box.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!box.classList.contains('collapsed')));
    });
    const body = box.querySelector('.cat-body');

    for (const def of parts) {
      const el = document.createElement('div');
      el.className = 'part';
      if (def.drawn || def.tool) el.classList.add('is-tool');
      el.title = def.tip ? `${def.name}: ${def.tip}` : def.name;
      el.dataset.type = def.id;
      const cv = document.createElement('canvas');
      el.appendChild(cv);
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = def.name;
      el.appendChild(name);
      if (hotkeys[def.id]) {
        const k = document.createElement('kbd');
        k.className = 'hotkey';
        k.textContent = hotkeys[def.id];
        el.appendChild(k);
      }
      if (def.drawn) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'drag to draw';
        el.appendChild(tag);
      }
      body.appendChild(el);
      drawThumb(cv, def);
      items.set(def.id, el);

      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        handlers.onDragStart(def.id, e);
      });
    }
    root.appendChild(box);
  }

  return {
    /** Highlight the current tool, or clear with null. */
    setArmed(type) {
      for (const [id, el] of items) el.classList.toggle('armed', id === type);
    },
    /** Redraw thumbnails (e.g. after fonts load / DPR change). */
    redraw() {
      for (const [id, el] of items) drawThumb(el.querySelector('canvas'), getDef(id));
    },
  };
}
