// =============================================================================
// draw.js — cartoon drawing of every part kind on a 2D canvas.
//
// Coordinate trick: we translate to the part's screen position, then
// ctx.scale(px, -px) so we can draw in WORLD UNITS with y pointing UP (like
// the physics engine). Line widths are divided by px so outlines stay a fixed
// number of screen pixels thick no matter the zoom.
//
// The same functions draw the gallery thumbnails and the world, so a part
// always looks the same everywhere.
// =============================================================================
import { MODULE, OUTLINE, gearLayers } from '../parts/partDefs.js';
import { beamHoleOffsets } from '../parts/geometry.js';

// ---------------------------------------------------------------- colours --
/** Lighten (amt > 0) or darken (amt < 0) a #rrggbb colour. */
export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  r = f(r); g = f(g); b = f(b);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Load-view colour: 0 = green (easy) → 0.6 yellow → 1 red (near stall). */
export function loadColor(load) {
  const stops = [[0, [61, 220, 132]], [0.6, [255, 214, 10]], [1, [239, 35, 60]]];
  const t = Math.max(0, Math.min(1, load));
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
  const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
  const k = (t - t0) / (t1 - t0);
  const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
  return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`;
}

const UNPOWERED = '#c9c3d6'; // load view: parts with no motor

// ---------------------------------------------------------------- helpers --
function outline(ctx, px, w = 3) {
  ctx.lineWidth = w / px;
  ctx.strokeStyle = OUTLINE;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Chunky, friendly gear outline: rounded tooth tips on a root circle. */
function gearPath(ctx, teeth, r) {
  const ro = r + MODULE * 0.9;   // tip radius
  const rr = r - MODULE * 1.0;   // root radius
  const step = (Math.PI * 2) / teeth;
  ctx.beginPath();
  for (let i = 0; i < teeth; i++) {
    const a = i * step; // a tooth is centred on angle a
    ctx.arc(0, 0, rr, a - step * 0.5, a - step * 0.30);
    ctx.lineTo(ro * Math.cos(a - step * 0.20), ro * Math.sin(a - step * 0.20));
    ctx.arc(0, 0, ro, a - step * 0.20, a + step * 0.20);
    ctx.lineTo(rr * Math.cos(a + step * 0.30), rr * Math.sin(a + step * 0.30));
    ctx.arc(0, 0, rr, a + step * 0.30, a + step * 0.5);
  }
  ctx.closePath();
}

/** A dark technic-style axle hole with a "+" so you can see rotation. */
function axleHole(ctx, px, s = 0.16) {
  ctx.fillStyle = '#3d3456';
  circle(ctx, 0, 0, s);
  ctx.fill();
  ctx.strokeStyle = '#8f86a8';
  ctx.lineWidth = 2 / px;
  ctx.beginPath();
  ctx.moveTo(-s * 0.6, 0); ctx.lineTo(s * 0.6, 0);
  ctx.moveTo(0, -s * 0.6); ctx.lineTo(0, s * 0.6);
  ctx.stroke();
}

function drawOneGear(ctx, px, teeth, r, fill) {
  gearPath(ctx, teeth, r);
  ctx.fillStyle = fill;
  ctx.fill();
  outline(ctx, px);
  ctx.stroke();
  // Inner ring (slightly darker) and lightening holes that show rotation.
  circle(ctx, 0, 0, r - MODULE * 1.6);
  ctx.fillStyle = shade(fill, -0.1);
  ctx.fill();
  ctx.lineWidth = 1.5 / px;
  ctx.stroke();
  const holes = r >= 1.5 ? 5 : 3;
  const hr = Math.min(0.24, r * 0.16);
  ctx.fillStyle = shade(fill, -0.32);
  for (let i = 0; i < holes; i++) {
    const a = (i / holes) * Math.PI * 2 + Math.PI / 2;
    circle(ctx, Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, hr);
    ctx.fill();
  }
  circle(ctx, 0, 0, Math.min(0.34, r * 0.32));
  ctx.fillStyle = shade(fill, 0.35);
  ctx.fill();
  outline(ctx, px, 2);
  ctx.stroke();
}

// ------------------------------------------------------------ part shapes --
// Each painter draws in local part space (origin = part centre, already
// rotated). `fill` is the main colour (already load-tinted if needed).
const painters = {
  gear(ctx, def, px, fill) {
    const [g] = gearLayers(def);
    drawOneGear(ctx, px, g.teeth, g.r, fill);
    axleHole(ctx, px);
  },

  compoundGear(ctx, def, px, fill) {
    const layers = gearLayers(def);
    drawOneGear(ctx, px, layers[0].teeth, layers[0].r, shade(fill, -0.08));
    // Little drop shadow so the front gear reads as "on top".
    ctx.save();
    ctx.globalAlpha *= 0.25;
    ctx.fillStyle = OUTLINE;
    circle(ctx, 0.05, -0.08, layers[1].r + MODULE);
    ctx.fill();
    ctx.restore();
    drawOneGear(ctx, px, layers[1].teeth, layers[1].r, shade(fill, 0.18));
    axleHole(ctx, px);
  },

  wheel(ctx, def, px, fill) {
    const r = def.radius;
    // Tyre with chunky tread bumps.
    const bumps = Math.max(8, Math.round(r * 14));
    ctx.beginPath();
    for (let i = 0; i <= bumps * 2; i++) {
      const a = (i / (bumps * 2)) * Math.PI * 2;
      const rr = i % 2 === 0 ? r : r - 0.06;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = '#3b3355';
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    // Rim + spokes.
    circle(ctx, 0, 0, r * 0.62);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    ctx.strokeStyle = shade(fill, -0.35);
    ctx.lineWidth = Math.max(2, r * 0.12 * px) / px;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * r * 0.52, Math.sin(a) * r * 0.52);
    }
    ctx.stroke();
    circle(ctx, 0, 0, Math.min(0.26, r * 0.25));
    ctx.fillStyle = shade(fill, 0.4);
    ctx.fill();
    outline(ctx, px, 2);
    ctx.stroke();
    axleHole(ctx, px, 0.12);
  },

  motor(ctx, def, px, fill) {
    const s = def.housing;
    roundRect(ctx, -s / 2, -s / 2, s, s, s * 0.22);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    // Top highlight band + four bolts.
    roundRect(ctx, -s / 2 + 0.1, s / 2 - 0.3, s - 0.2, 0.18, 0.09);
    ctx.fillStyle = shade(fill, 0.35);
    ctx.fill();
    ctx.fillStyle = shade(fill, -0.4);
    for (const [bx, by] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      circle(ctx, bx * s * 0.36, by * s * 0.36, 0.06);
      ctx.fill();
    }
  },

  /** The spinning shaft of a motor (drawn with the hub's own transform). */
  motorHub(ctx, def, px) {
    circle(ctx, 0, 0, 0.3);
    ctx.fillStyle = '#d8d2e6';
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    ctx.fillStyle = OUTLINE;
    roundRect(ctx, -0.04, -0.04, 0.28, 0.08, 0.04); // a marker so you can see it turn
    ctx.fill();
  },

  crank(ctx, def, px, fill) {
    circle(ctx, 0, 0, 0.38);
    ctx.fillStyle = shade(fill, -0.2);
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
  },

  crankHub(ctx, def, px, fill) {
    const L = def.armLength;
    roundRect(ctx, -0.14, -0.14, L + 0.28, 0.28, 0.14);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    circle(ctx, L, 0, 0.26);
    ctx.fillStyle = shade(fill, 0.3);
    ctx.fill();
    ctx.stroke();
    axleHole(ctx, px, 0.12);
  },

  beam(ctx, def, px, fill) {
    const L = def.length, t = def.thickness;
    roundRect(ctx, -L / 2 - t / 2, -t / 2, L + t, t, t / 2);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    ctx.fillStyle = shade(fill, 0.25);
    roundRect(ctx, -L / 2, t * 0.12, L, t * 0.18, t * 0.09);
    ctx.fill();
    ctx.fillStyle = shade(fill, -0.45);
    for (const hx of beamHoleOffsets(L)) {
      circle(ctx, hx, 0, t * 0.2);
      ctx.fill();
    }
  },

  axle(ctx, def, px, fill) {
    circle(ctx, 0, 0, def.radius);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    ctx.fillStyle = OUTLINE;
    const s = def.radius * 0.62, w = def.radius * 0.24;
    ctx.fillRect(-s, -w / 2, 2 * s, w);
    ctx.fillRect(-w / 2, -s, w, 2 * s);
  },

  hinge(ctx, def, px, fill) {
    circle(ctx, 0, 0, def.radius);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    circle(ctx, 0, 0, def.radius * 0.45);
    ctx.fillStyle = shade(fill, -0.4);
    ctx.fill();
  },

  fixedPin(ctx, def, px, fill) {
    // A chunky hex bolt: clearly "not going anywhere".
    const r = def.radius;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    circle(ctx, 0, 0, r * 0.35);
    ctx.fillStyle = shade(fill, -0.45);
    ctx.fill();
  },

  rotPin(ctx, def, px, fill) {
    const r = def.radius;
    circle(ctx, 0, 0, r);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    // A bearing ring.
    circle(ctx, 0, 0, r * 0.6);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2 / px;
    ctx.stroke();
    circle(ctx, 0, 0, r * 0.25);
    ctx.fillStyle = OUTLINE;
    ctx.fill();
  },

  ball(ctx, def, px, fill) {
    circle(ctx, 0, 0, def.radius);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    // A stripe so you can see it roll.
    ctx.save();
    circle(ctx, 0, 0, def.radius);
    ctx.clip();
    ctx.fillStyle = shade(fill, -0.18);
    ctx.fillRect(-def.radius, -def.radius * 0.18, def.radius * 2, def.radius * 0.36);
    ctx.restore();
  },

  crate(ctx, def, px, fill) {
    const w = def.width, h = def.height;
    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.1);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    const inset = Math.min(w, h) * 0.14;
    ctx.strokeStyle = shade(fill, -0.3);
    ctx.lineWidth = 3 / px;
    ctx.beginPath();
    if (def.heavy) {
      // Steel box: rivets + stripes.
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        circle(ctx, sx * (w / 2 - inset), sy * (h / 2 - inset), 0.07);
        ctx.fillStyle = shade(fill, -0.4);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(-w / 2 + inset, 0); ctx.lineTo(w / 2 - inset, 0);
      ctx.stroke();
    } else {
      ctx.rect(-w / 2 + inset, -h / 2 + inset, w - 2 * inset, h - 2 * inset);
      ctx.moveTo(-w / 2 + inset, -h / 2 + inset); ctx.lineTo(w / 2 - inset, h / 2 - inset);
      ctx.stroke();
    }
  },

  block(ctx, def, px, fill) {
    const w = def.width, h = def.height;
    roundRect(ctx, -w / 2, -h / 2, w, h, 0.12);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    ctx.fillStyle = shade(fill, 0.25);
    roundRect(ctx, -w / 2 + 0.1, h / 2 - 0.25, w - 0.2, 0.12, 0.06);
    ctx.fill();
  },

  ramp(ctx, def, px, fill) {
    const w = def.width / 2, h = def.height / 2;
    ctx.beginPath();
    ctx.moveTo(-w, -h); ctx.lineTo(w, -h); ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    // A few stone speckles.
    ctx.fillStyle = shade(fill, -0.15);
    for (const [u, v] of [[0.55, 0.15], [0.8, 0.45], [0.7, 0.2], [0.9, 0.7]]) {
      circle(ctx, -w + u * 2 * w, -h + v * u * 2 * h, 0.08);
      ctx.fill();
    }
  },
};

/**
 * Draw one part.
 * @param ctx   canvas 2D context
 * @param def   part definition
 * @param t     { sx, sy, angle } screen position (pixels) + world angle
 * @param px    pixels per world unit
 * @param opts  { layer: 'main'|'hub', load: number|null, loadView: bool,
 *               ghost: bool, squash: number }
 */
export function drawPart(ctx, def, t, px, opts = {}) {
  const painter = painters[opts.layer === 'hub' ? `${def.kind}Hub` : def.kind];
  if (!painter) return;
  let fill = def.color;
  if (opts.loadView && def.category !== 'objects' && def.category !== 'anchors') {
    fill = opts.load == null ? UNPOWERED : loadColor(opts.load);
  }
  ctx.save();
  ctx.translate(t.sx, t.sy);
  if (opts.ghost) ctx.globalAlpha = 0.55;
  if (opts.squash) ctx.scale(1 + opts.squash, 1 - opts.squash); // squash & stretch!
  ctx.scale(px, -px);  // world units, y up
  ctx.rotate(t.angle);
  painter(ctx, def, px, fill);
  ctx.restore();
}

/** Does this kind have a separately-moving hub layer? */
export const hasHub = (kind) => kind === 'motor' || kind === 'crank';
