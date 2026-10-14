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
import { MODULE, OUTLINE, gearLayers, faceHoles, pistonMount } from '../parts/partDefs.js';
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

/** Bolt holes you can attach beams to: a dark hole in a light ring. */
function boltHoles(ctx, px, holes, fill) {
  for (const [x, y] of holes) {
    circle(ctx, x, y, 0.15);
    ctx.fillStyle = shade(fill, 0.3);
    ctx.fill();
    outline(ctx, px, 1.5);
    ctx.stroke();
    circle(ctx, x, y, 0.085);
    ctx.fillStyle = '#3d3456';
    ctx.fill();
  }
}

function drawOneGear(ctx, px, teeth, r, fill, holesAt = null) {
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
  if (holesAt?.length) boltHoles(ctx, px, holesAt, fill);
  else {
    const holes = r >= 1.5 ? 5 : 3;
    const hr = Math.min(0.24, r * 0.16);
    ctx.fillStyle = shade(fill, -0.32);
    for (let i = 0; i < holes; i++) {
      const a = (i / holes) * Math.PI * 2 + Math.PI / 2;
      circle(ctx, Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, hr);
      ctx.fill();
    }
  }
  circle(ctx, 0, 0, Math.min(0.34, r * 0.32));
  ctx.fillStyle = shade(fill, 0.35);
  ctx.fill();
  outline(ctx, px, 2);
  ctx.stroke();
}

/** A rope look: dark outline, tan core, braid dashes. `trace(ctx)` adds the path. */
export function ropeStroke(ctx, px, fill, trace) {
  ctx.beginPath();
  trace(ctx);
  ctx.lineCap = 'round';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 5 / px;
  ctx.stroke();
  ctx.strokeStyle = fill;
  ctx.lineWidth = 2.5 / px;
  ctx.stroke();
  ctx.setLineDash([3 / px, 4 / px]);
  ctx.strokeStyle = shade(fill, -0.3);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Short label for a key name: 'arrowleft' → '←', 'w' → 'W'. */
export function keyLabel(key) {
  return { arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', shift: '⇧' }[key] ?? key.toUpperCase();
}

// ------------------------------------------------------------ part shapes --
// Each painter draws in local part space (origin = part centre, already
// rotated). `fill` is the main colour (already load-tinted if needed).
const painters = {
  gear(ctx, def, px, fill) {
    const [g] = gearLayers(def);
    drawOneGear(ctx, px, g.teeth, g.r, fill, faceHoles(def));
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

  sprocket(ctx, def, px, fill) {
    // Thin plate with pointy teeth and cut-out spokes: reads as "bike part".
    const r = def.radius, n = def.teeth;
    const ro = r + 0.12, rr = r - 0.06;
    const step = (Math.PI * 2) / n;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = i * step;
      ctx.lineTo(rr * Math.cos(a - step * 0.5), rr * Math.sin(a - step * 0.5));
      ctx.lineTo(ro * Math.cos(a - step * 0.12), ro * Math.sin(a - step * 0.12));
      ctx.lineTo(ro * Math.cos(a + step * 0.12), ro * Math.sin(a + step * 0.12));
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    const bolts = faceHoles(def);
    ctx.fillStyle = shade(fill, -0.45);
    if (bolts.length) {
      // Cut-outs between the bolt holes, then the holes themselves.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        circle(ctx, Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, r * 0.16);
        ctx.fill();
      }
      boltHoles(ctx, px, bolts, fill);
    } else {
      const holes = r > 1.2 ? 6 : 4;
      for (let i = 0; i < holes; i++) {
        const a = (i / holes) * Math.PI * 2;
        circle(ctx, Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, r * 0.2);
        ctx.fill();
      }
    }
    circle(ctx, 0, 0, Math.min(0.3, r * 0.35));
    ctx.fillStyle = shade(fill, 0.3);
    ctx.fill();
    outline(ctx, px, 2);
    ctx.stroke();
    axleHole(ctx, px, 0.12);
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
    if (def.pinOffset) {
      // Drive wheel: a counterweight opposite a chunky crank pin.
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.58, Math.PI * 0.68, Math.PI * 1.32);
      ctx.arc(0, 0, r * 0.3, Math.PI * 1.32, Math.PI * 0.68, true);
      ctx.closePath();
      ctx.fillStyle = shade(fill, -0.3);
      ctx.fill();
      outline(ctx, px, 2);
      ctx.stroke();
      ctx.strokeStyle = shade(fill, -0.45);
      ctx.lineWidth = Math.max(3, 0.14 * px) / px;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(def.pinOffset, 0); ctx.stroke();
      circle(ctx, def.pinOffset, 0, 0.15);
      ctx.fillStyle = '#ffe066';
      ctx.fill();
      outline(ctx, px, 2);
      ctx.stroke();
    }
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

  slider(ctx, def, px, fill) {
    // The rail: a slim slotted bar with an end hole at each end.
    const L = def.length;
    roundRect(ctx, -L / 2 - 0.22, -0.16, L + 0.44, 0.32, 0.16);
    ctx.fillStyle = shade(fill, 0.35);
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    roundRect(ctx, -L / 2 + 0.2, -0.05, L - 0.4, 0.1, 0.05);
    ctx.fillStyle = shade(fill, -0.3);
    ctx.fill();
    ctx.fillStyle = shade(fill, -0.5);
    for (const hx of [-L / 2, L / 2]) { circle(ctx, hx, 0, 0.09); ctx.fill(); }
  },

  /** A slider's moving block (drawn with the block's own transform). */
  sliderHub(ctx, def, px, fill) {
    roundRect(ctx, -0.36, -0.3, 0.72, 0.6, 0.12);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    circle(ctx, 0, 0, 0.12);
    ctx.fillStyle = '#ffe066';
    ctx.fill();
    outline(ctx, px, 2);
    ctx.stroke();
  },

  spring(ctx, def, px, fill) {
    // A zigzag coil between two eyes. Fixed coil count, so it visibly squashes.
    const L = def.length, h = def.thickness / 2, coils = 9;
    const a = -L / 2 + 0.2, b = L / 2 - 0.2;
    ctx.beginPath();
    ctx.moveTo(-L / 2, 0); ctx.lineTo(a, 0);
    for (let i = 0; i < coils * 2; i++) {
      ctx.lineTo(a + ((i + 0.5) / (coils * 2)) * (b - a), i % 2 ? -h : h);
    }
    ctx.lineTo(b, 0); ctx.lineTo(L / 2, 0);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 6 / px;
    ctx.stroke();
    ctx.strokeStyle = fill;
    ctx.lineWidth = 3 / px;
    ctx.stroke();
    for (const x of [-L / 2, L / 2]) {
      circle(ctx, x, 0, 0.12);
      ctx.fillStyle = shade(fill, 0.4);
      ctx.fill();
      outline(ctx, px, 2);
      ctx.stroke();
    }
  },

  rope(ctx, def, px, fill) {
    const L = def.length;
    ropeStroke(ctx, px, fill, (c) => { c.moveTo(-L / 2, 0); c.lineTo(L / 2, 0); });
    for (const x of [-L / 2, L / 2]) {
      circle(ctx, x, 0, 0.09);
      ctx.fillStyle = shade(fill, -0.3);
      ctx.fill();
    }
  },

  track(ctx, def, px, fill) {
    // Sleepers under a steel rail.
    const L = def.length, t = def.thickness;
    roundRect(ctx, -L / 2, -t / 2, L, t, t * 0.3);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    ctx.fillStyle = shade(fill, -0.3);
    for (let x = -L / 2 + 0.3; x < L / 2 - 0.1; x += 0.6) ctx.fillRect(x - 0.08, -t / 2, 0.16, t * 0.75);
    roundRect(ctx, -L / 2, t / 2 - 0.1, L, 0.12, 0.05);
    ctx.fillStyle = '#d8d2e6';
    ctx.fill();
    outline(ctx, px, 1.5);
    ctx.stroke();
  },

  /** A toggle switch: lever left = off, right (green light) = on. */
  switch(ctx, def, px, fill, opts) {
    const on = !!opts.on;
    roundRect(ctx, -0.4, -0.28, 0.8, 0.56, 0.28);
    ctx.fillStyle = on ? '#3ddc84' : '#8d99ae';
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    circle(ctx, on ? 0.13 : -0.13, 0, 0.21);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2);
    ctx.stroke();
  },

  /** A big round push button on a base. */
  button(ctx, def, px, fill, opts) {
    roundRect(ctx, -0.4, -0.4, 0.8, 0.8, 0.14);
    ctx.fillStyle = '#5c5470';
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    circle(ctx, 0, 0, opts.on ? 0.23 : 0.28);
    ctx.fillStyle = opts.on ? shade(fill, -0.25) : fill;
    ctx.fill();
    outline(ctx, px, 2);
    ctx.stroke();
    if (!opts.on) {
      circle(ctx, -0.08, 0.08, 0.08);
      ctx.fillStyle = shade(fill, 0.45);
      ctx.fill();
    }
  },

  /** A keyboard key showing its letter. */
  keyButton(ctx, def, px, fill, opts) {
    roundRect(ctx, -0.4, -0.4, 0.8, 0.8, 0.14);
    ctx.fillStyle = opts.on ? '#ffd23f' : fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    roundRect(ctx, -0.3, -0.24, 0.6, 0.6, 0.1);
    ctx.fillStyle = shade(opts.on ? '#ffd23f' : fill, 0.4);
    ctx.fill();
    const pr = opts.props ?? {};
    const legacy = pr.key != null && pr.keyCW == null && pr.keyCCW == null;
    const ccw = pr.keyCCW ?? 'a', cw = pr.keyCW ?? 'd';
    const label = legacy ? keyLabel(pr.key)
      : [ccw, cw].filter((k) => k !== 'none').map(keyLabel).join(' ');
    ctx.save();
    ctx.scale(1, -1); // text upright (world y is up)
    ctx.fillStyle = OUTLINE;
    ctx.font = `700 ${label.length > 2 ? 0.24 : label.length > 1 ? 0.3 : 0.42}px Fredoka, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, -0.05);
    ctx.restore();
  },

  /** Piston cylinder (the rod is the hub, drawn on top). */
  piston(ctx, def, px, fill) {
    const L = def.length, t = def.thickness;
    roundRect(ctx, -L / 2 - 0.18, -t / 2, L * 0.92 + 0.18, t, 0.12);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    roundRect(ctx, -L / 2, t * 0.12, L * 0.85, t * 0.16, t * 0.08);
    ctx.fillStyle = shade(fill, 0.35);
    ctx.fill();
    // Bands + the bottom pivot.
    ctx.fillStyle = shade(fill, -0.3);
    ctx.fillRect(-L / 2 + L * 0.6, -t / 2, 0.08, t);
    // Both base joints: the bottom end and the one up the cylinder.
    for (const x of [-L / 2, -L / 2 + pistonMount(def)]) {
      circle(ctx, x, 0, 0.14);
      ctx.fillStyle = '#ffe066';
      ctx.fill();
      outline(ctx, px, 2);
      ctx.stroke();
    }
  },

  /** Piston rod: shiny shaft from the middle out to the top pivot. */
  pistonHub(ctx, def, px) {
    const L = def.length;
    roundRect(ctx, 0, -0.1, L / 2, 0.2, 0.08);
    ctx.fillStyle = '#e9ecef';
    ctx.fill();
    outline(ctx, px, 2);
    ctx.stroke();
    roundRect(ctx, L / 2 - 0.25, -0.2, 0.42, 0.4, 0.12);
    ctx.fillStyle = '#adb5bd';
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    circle(ctx, L / 2, 0, 0.12);
    ctx.fillStyle = '#ffe066';
    ctx.fill();
    outline(ctx, px, 2);
    ctx.stroke();
  },

  plate(ctx, def, px, fill) {
    const L = def.length, t = def.thickness;
    roundRect(ctx, -L / 2 - 0.1, -t / 2, L + 0.2, t, 0.16);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    roundRect(ctx, -L / 2 + 0.05, t / 2 - 0.22, L - 0.1, 0.1, 0.05);
    ctx.fillStyle = shade(fill, 0.35);
    ctx.fill();
    ctx.fillStyle = shade(fill, -0.45);
    for (const hx of beamHoleOffsets(L)) { circle(ctx, hx, 0, 0.09); ctx.fill(); }
    ctx.fillStyle = shade(fill, -0.25); // rivets
    for (const hx of [-L / 2 + 0.05, L / 2 - 0.05]) for (const hy of [-t / 2 + 0.18, t / 2 - 0.32]) { circle(ctx, hx, hy, 0.05); ctx.fill(); }
  },

  /** A rocket nozzle pointing +x; flames out the back when it's firing. */
  thruster(ctx, def, px, fill, opts) {
    const on = opts.on || 0;
    if (on) {
      const flick = 0.8 + 0.2 * Math.sin(performance.now() / 40);
      const len = (0.6 + 0.5 * Math.abs(on)) * flick * Math.sign(on);
      ctx.beginPath();
      ctx.moveTo(-0.4, 0.22); ctx.lineTo(-0.4 - len, 0); ctx.lineTo(-0.4, -0.22); ctx.closePath();
      ctx.fillStyle = '#ffd23f';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-0.4, 0.12); ctx.lineTo(-0.4 - len * 0.55, 0); ctx.lineTo(-0.4, -0.12); ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(-0.45, -0.3); ctx.lineTo(-0.25, -0.18); ctx.lineTo(-0.25, 0.18); ctx.lineTo(-0.45, 0.3); ctx.closePath();
    ctx.fillStyle = '#495057';
    ctx.fill();
    outline(ctx, px, 2);
    ctx.stroke();
    roundRect(ctx, -0.25, -0.24, 0.6, 0.48, 0.1);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0.35, -0.24); ctx.quadraticCurveTo(0.6, 0, 0.35, 0.24); ctx.closePath();
    ctx.fillStyle = '#ef476f';
    ctx.fill();
    ctx.stroke();
  },

  /** A horseshoe magnet; glowy field lines when it's on. */
  magnet(ctx, def, px, fill, opts) {
    if (opts.on) {
      ctx.save();
      ctx.strokeStyle = 'rgba(58,134,255,0.5)';
      ctx.lineWidth = 2 / px;
      const ph = (performance.now() / 600) % 1;
      for (let i = 0; i < 3; i++) {
        circle(ctx, 0, -0.1, 0.6 + ((i + ph) % 3) * 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(0, 0.05, 0.36, Math.PI, 0, true);
    ctx.lineTo(0.36, 0.35); ctx.lineTo(0.16, 0.35); ctx.lineTo(0.16, 0.05);
    ctx.arc(0, 0.05, 0.16, 0, Math.PI, false);
    ctx.lineTo(-0.16, 0.35); ctx.lineTo(-0.36, 0.35); ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    ctx.fillStyle = '#e9ecef';
    ctx.fillRect(-0.36, 0.2, 0.2, 0.15);
    ctx.fillRect(0.16, 0.2, 0.2, 0.15);
  },

  /** A cannon barrel pointing +x on a little mount; a puff after each shot. */
  cannon(ctx, def, px, fill, opts) {
    if (opts.on > 0.2) {
      ctx.fillStyle = `rgba(233,236,239,${Math.min(0.9, opts.on)})`;
      for (const [x, y, r] of [[1.0, 0.05, 0.22], [1.25, -0.1, 0.16], [1.2, 0.18, 0.14]]) { circle(ctx, x, y, r); ctx.fill(); }
    }
    roundRect(ctx, -0.25, -0.22, 1.0, 0.44, 0.12);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    roundRect(ctx, 0.62, -0.26, 0.16, 0.52, 0.06);
    ctx.fillStyle = shade(fill, 0.25);
    ctx.fill();
    ctx.stroke();
    circle(ctx, 0, 0, 0.3);
    ctx.fillStyle = '#8d6e63';
    ctx.fill();
    ctx.stroke();
    circle(ctx, 0, 0, 0.1);
    ctx.fillStyle = OUTLINE;
    ctx.fill();
  },

  balloon(ctx, def, px, fill) {
    const r = def.radius;
    // String hanging down.
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.05);
    ctx.quadraticCurveTo(r * 0.3, -r * 1.4, 0, -r * 1.8);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5 / px;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0.05 * r, r * 0.9, r, 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-0.1 * r, -r * 0.93); ctx.lineTo(0.1 * r, -r * 0.93); ctx.lineTo(0, -r * 1.08); ctx.closePath();
    ctx.fillStyle = shade(fill, -0.2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-r * 0.35, r * 0.35, r * 0.16, r * 0.26, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fill();
  },

  /** A belt with chevrons that roll along when it's running. */
  conveyor(ctx, def, px, fill, opts) {
    const L = def.length, t = def.thickness;
    roundRect(ctx, -L / 2, -t / 2, L, t, t / 2);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px);
    ctx.stroke();
    for (const x of [-L / 2 + t / 2, L / 2 - t / 2]) {
      circle(ctx, x, 0, t * 0.32);
      ctx.fillStyle = '#adb5bd';
      ctx.fill();
      outline(ctx, px, 1.5);
      ctx.stroke();
    }
    const on = opts.on ?? 1;
    const phase = ((performance.now() / 1000) * 3 * on) % 0.6;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-L / 2 + t, -t / 2, L - 2 * t, t);
    ctx.clip();
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 2.5 / px;
    for (let x = -L / 2 + phase - 0.6; x < L / 2 + 0.6; x += 0.6) {
      ctx.beginPath();
      ctx.moveTo(x - 0.12, t * 0.25); ctx.lineTo(x + 0.08, 0); ctx.lineTo(x - 0.12, -t * 0.25);
      ctx.stroke();
    }
    ctx.restore();
  },

  bouncePad(ctx, def, px, fill) {
    const w = def.width, h = def.height;
    roundRect(ctx, -w / 2, -h / 2, w, h * 0.45, 0.08);
    ctx.fillStyle = '#5c5470';
    ctx.fill();
    outline(ctx, px, 2);
    ctx.stroke();
    // Springs under the pad.
    ctx.strokeStyle = '#adb5bd';
    ctx.lineWidth = 2.5 / px;
    for (const sx of [-w * 0.3, 0, w * 0.3]) {
      ctx.beginPath();
      for (let i = 0; i <= 4; i++) ctx.lineTo(sx + (i % 2 ? 0.1 : -0.1), -h / 2 + h * 0.45 + (i / 4) * h * 0.3);
      ctx.stroke();
    }
    roundRect(ctx, -w / 2, h / 2 - h * 0.3, w, h * 0.3, h * 0.15);
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
  },

  /** Water: see-through blue with a wavy top (drawn above everything). */
  water(ctx, def, px, fill) {
    const w = def.width, h = def.height;
    const ph = performance.now() / 700;
    ctx.save();
    ctx.globalAlpha *= 0.42;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(-w / 2, h / 2);
    for (let x = -w / 2; x <= w / 2 + 1e-6; x += 0.25) ctx.lineTo(x, h / 2 + Math.sin(x * 2.2 + ph) * 0.06);
    ctx.lineTo(w / 2, -h / 2);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    for (let x = -w / 2; x <= w / 2 + 1e-6; x += 0.25) ctx.lineTo(x, h / 2 + Math.sin(x * 2.2 + ph) * 0.06);
    ctx.strokeStyle = shade(fill, 0.5);
    ctx.lineWidth = 3 / px;
    ctx.stroke();
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

  /** A silver hex bolt with a screwdriver slot. */
  bolt(ctx, def, px, fill) {
    const r = def.radius;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    outline(ctx, px, 2.5);
    ctx.stroke();
    circle(ctx, 0, 0, r * 0.55);
    ctx.fillStyle = shade(fill, 0.35);
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2 / px;
    ctx.beginPath(); ctx.moveTo(-r * 0.4, 0); ctx.lineTo(r * 0.4, 0); ctx.stroke();
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
 *               ghost: bool, squash: number, on: bool (controls), props }
 */
export function drawPart(ctx, def, t, px, opts = {}) {
  const painter = painters[opts.layer === 'hub' ? `${def.kind}Hub` : def.kind];
  if (!painter) return;
  let fill = def.color;
  if (opts.loadView && def.category !== 'objects' && def.category !== 'anchors' && def.category !== 'controls') {
    fill = opts.load == null ? UNPOWERED : loadColor(opts.load);
  }
  ctx.save();
  ctx.translate(t.sx, t.sy);
  if (opts.ghost) ctx.globalAlpha = 0.55;
  if (opts.squash) ctx.scale(1 + opts.squash, 1 - opts.squash); // squash & stretch!
  ctx.scale(px, -px);  // world units, y up
  ctx.rotate(t.angle);
  painter(ctx, def, px, fill, opts);
  ctx.restore();
}

/** Does this kind have a separately-moving hub layer? */
export const hasHub = (kind) => kind === 'motor' || kind === 'crank' || kind === 'slider' || kind === 'piston';

// ------------------------------------------------------------------ chains --
/**
 * Draw a chain wrapped round two circles (screen space, pixels).
 * a, b = { x, y, r } in screen pixels; phase = how far the chain has moved
 * (pixels), so the links visibly travel. state: 'ok' | 'bad' | 'selected'.
 */
export function drawChain(ctx, a, b, phase, state = 'ok') {
  const path = chainPath(a, b);
  if (!path) return;
  const trace = () => {
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.r, path.thA1, path.thA2, path.ccwA);
    ctx.lineTo(path.b2.x, path.b2.y);
    ctx.arc(b.x, b.y, b.r, path.thB2, path.thB1, path.ccwB);
    ctx.closePath();
  };
  const scale = Math.max(0.5, Math.min(1.6, (a.r + b.r) / 60));
  ctx.save();
  ctx.lineJoin = 'round';
  trace();
  if (state === 'selected') { ctx.strokeStyle = '#ff006e'; ctx.lineWidth = 12 * scale; ctx.stroke(); }
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 7 * scale;
  ctx.stroke();
  ctx.strokeStyle = state === 'bad' ? '#ef233c' : '#9a93ad';
  ctx.lineWidth = 4 * scale;
  ctx.setLineDash([5 * scale, 3 * scale]);
  ctx.lineDashOffset = phase;
  ctx.stroke();
  ctx.restore();
}

/** Outer tangents of two circles, for drawing and hit-testing a chain. */
export function chainPath(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
  if (d <= Math.abs(a.r - b.r) + 1e-6) return null;
  const th = Math.atan2(dy, dx);
  const beta = Math.acos((a.r - b.r) / d);
  // Tangent normals at th ± beta. Upper run: A(th+β) → B(th+β); lower: A(th−β) → B(th−β).
  const p = (c, ang) => ({ x: c.x + Math.cos(ang) * c.r, y: c.y + Math.sin(ang) * c.r });
  return {
    a1: p(a, th + beta), b1: p(b, th + beta), a2: p(a, th - beta), b2: p(b, th - beta),
    // Around A the far way (th+β → th−β through th+π), around B the near way.
    thA1: th + beta, thA2: th - beta + Math.PI * 2, ccwA: false,
    thB1: th + beta, thB2: th - beta, ccwB: false,
  };
}
