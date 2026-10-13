// =============================================================================
// gallery.js — the left-hand parts gallery, built entirely from partDefs.js.
//
// Interaction:
//   • press on a part and drag it onto the world to place it, OR
//   • click a part to "arm" it, then click in the world (handy on touch).
// =============================================================================
import { CATEGORIES, PARTS, getDef } from '../parts/partDefs.js';
import { outerRadius } from '../parts/geometry.js';
import { drawPart, hasHub } from '../render/draw.js';

const THUMB_W = 64, THUMB_H = 56;

/** How big a part is, so its thumbnail can be scaled to fit. */
function extentOf(def) {
  switch (def.kind) {
    case 'beam': return (def.length + def.thickness) / 2;
    case 'crate': case 'block': return Math.max(def.width, def.height) / 2;
    case 'ramp': return Math.max(def.width, def.height) / 2;
    case 'crank': return def.armLength * 0.75;
    default: return outerRadius(def);
  }
}

function drawThumb(canvas, def) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = THUMB_W * dpr;
  canvas.height = THUMB_H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const px = Math.min(26, (Math.min(THUMB_W, THUMB_H) / 2 - 4) / extentOf(def));
  // Cranks look best centred on their arm.
  const cx = def.kind === 'crank' ? THUMB_W / 2 - (def.armLength * px) / 2 : THUMB_W / 2;
  const angle = def.kind === 'beam' ? Math.PI / 9 : 0;
  drawPart(ctx, def, { sx: cx, sy: THUMB_H / 2, angle }, px);
  if (hasHub(def.kind)) drawPart(ctx, def, { sx: cx, sy: THUMB_H / 2, angle: def.kind === 'crank' ? 0 : angle }, px, { layer: 'hub' });
}

/**
 * @param root      the <aside> to fill
 * @param handlers  { onDragStart(type, pointerEvent), onArm(type|null) }
 * @param filter    optional (def) => bool, so a mode can limit parts
 */
export function buildGallery(root, handlers, filter = () => true) {
  root.innerHTML = '';
  const items = new Map();
  for (const cat of CATEGORIES) {
    const parts = PARTS.filter((p) => p.category === cat.id && (p.placeholder || filter(p)));
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
      if (def.placeholder) {
        // Planned parts: visible, clearly marked, not placeable.
        el.classList.add('placeholder');
        el.title = `${def.name} — coming soon. ${def.tip ?? ''}`;
        el.innerHTML = `<div class="icon">🔒</div><div class="name">${def.name}</div><span class="soon">SOON</span>`;
        body.appendChild(el);
        continue;
      }
      el.title = def.tip ? `${def.name}: ${def.tip}` : def.name;
      el.dataset.type = def.id;
      const cv = document.createElement('canvas');
      el.appendChild(cv);
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = def.name;
      el.appendChild(name);
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
    /** Highlight the armed part (click-to-place), or clear with null. */
    setArmed(type) {
      for (const [id, el] of items) el.classList.toggle('armed', id === type);
    },
    /** Redraw thumbnails (e.g. after fonts load / DPR change). */
    redraw() {
      for (const [id, el] of items) drawThumb(el.querySelector('canvas'), getDef(id));
    },
  };
}
