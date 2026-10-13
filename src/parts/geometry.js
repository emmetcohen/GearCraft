// =============================================================================
// geometry.js — pure geometry helpers for placed parts.
//
// A *placed part* (an "instance") is plain data stored in the build:
//   { uid: 7, type: 'gear-12', x: 3.2, y: 4.0, angle: 0, props: {} }
// Its definition (sizes, colours...) comes from partDefs.js via getDef(type).
//
// Nothing here touches the DOM or the physics engine, so it can be unit
// tested in Node and reused by every mode.
// =============================================================================
import { getDef, gearLayers, HOLE_SPACING, MODULE, roleOf } from './partDefs.js';

/** Rotate a local point (lx, ly) by `angle` and move it to (x, y). */
export function localToWorld(x, y, angle, lx, ly) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: x + lx * c - ly * s, y: y + lx * s + ly * c };
}

/** Inverse of localToWorld. */
export function worldToLocal(x, y, angle, wx, wy) {
  const dx = wx - x, dy = wy - y;
  const c = Math.cos(-angle), s = Math.sin(-angle);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Local x-positions of the holes along a beam of length L (ends included). */
export function beamHoleOffsets(length) {
  const n = Math.round(length / HOLE_SPACING);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(-length / 2 + i * HOLE_SPACING);
  return out;
}

/**
 * Sockets are the points where parts can join each other.
 * Returns world-space points: [{ x, y, index }].
 *  - beams: every hole
 *  - everything else with a role (rotors, drivers, connectors): its centre
 *  - loose objects: none
 */
export function socketsOf(part) {
  const def = getDef(part.type);
  const role = roleOf(def.kind);
  if (role === 'object') return [];
  if (role === 'beam') {
    return beamHoleOffsets(def.length).map((lx, index) => ({
      ...localToWorld(part.x, part.y, part.angle, lx, 0), index,
    }));
  }
  return [{ x: part.x, y: part.y, index: 0 }];
}

/** Outer radius used for hit testing / selection rings of round parts. */
export function outerRadius(def) {
  switch (def.kind) {
    case 'gear': case 'compoundGear':
      return gearLayers(def)[0].r + MODULE * 0.9;
    case 'wheel': return def.radius;
    case 'motor': return def.housing * 0.62;
    case 'crank': return def.armLength + 0.3;
    case 'ball': return def.radius;
    default: return def.radius ?? 0.5;
  }
}

/** Does world point (wx, wy) touch this part? Used for clicking parts. */
export function hitTest(part, wx, wy) {
  const def = getDef(part.type);
  const p = worldToLocal(part.x, part.y, part.angle, wx, wy);
  switch (def.kind) {
    case 'beam':
      return Math.abs(p.x) <= def.length / 2 + def.thickness / 2 &&
             Math.abs(p.y) <= def.thickness / 2 + 0.05;
    case 'motor': {
      const h = def.housing / 2;
      return Math.abs(p.x) <= h && Math.abs(p.y) <= h;
    }
    case 'crate': case 'block': {
      return Math.abs(p.x) <= def.width / 2 && Math.abs(p.y) <= def.height / 2;
    }
    case 'ramp': {
      // Right triangle: bottom edge from (-w/2,-h/2) to (w/2,-h/2), high on the right.
      const w = def.width, h = def.height;
      const u = (p.x + w / 2) / w;           // 0..1 along the base
      const v = (p.y + h / 2) / h;           // 0..1 up
      return u >= 0 && u <= 1 && v >= 0 && v <= u;
    }
    case 'crank': {
      // Hit the base or the arm.
      if (Math.hypot(p.x, p.y) <= 0.45) return true;
      return p.x >= 0 && p.x <= def.armLength + 0.3 && Math.abs(p.y) <= 0.3;
    }
    default:
      return Math.hypot(p.x, p.y) <= outerRadius(def);
  }
}

/** Selection "priority": small connectors sit on top of bigger parts, so
 *  clicking a pin on a gear selects the pin. Higher = picked first. */
export function pickPriority(def) {
  switch (roleOf(def.kind)) {
    case 'connector': return 4;
    case 'driver': return 3;
    case 'rotor': return 2;
    case 'beam': return 1;
    default: return 0;
  }
}

/** Find the topmost part under a world point (or null). */
export function pickPart(parts, wx, wy) {
  let best = null, bestScore = -Infinity;
  parts.forEach((part, i) => {
    if (!hitTest(part, wx, wy)) return;
    const def = getDef(part.type);
    // Prefer higher priority, then smaller parts, then later (on-top) parts.
    const score = pickPriority(def) * 1000 - outerRadius(def) * 10 + i * 0.001;
    if (score > bestScore) { bestScore = score; best = part; }
  });
  return best;
}

/** Gear circles of a placed part in world space: [{ uid, layer, teeth, r, x, y }]. */
export function gearCirclesOf(part) {
  const def = getDef(part.type);
  return gearLayers(def).map((g, layer) => ({
    uid: part.uid, layer, teeth: g.teeth, r: g.r, x: part.x, y: part.y,
  }));
}

export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
