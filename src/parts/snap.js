// =============================================================================
// snap.js — where does a part land when you drop it near other parts?
//
// Priority order:
//   1. SOCKET snap: centre lands on a nearby socket (motor shaft, pin, axle,
//      beam hole, another gear's centre...). Beams snap any of their holes.
//   2. MESH snap (gears only): slide to exactly r1 + r2 from a nearby gear.
//   3. GRID snap (optional), otherwise free placement.
// Gears are then rotated so their teeth slot between the neighbour's teeth
// (purely cosmetic — the physics uses ratio math, not teeth).
// =============================================================================
import { getDef, gearLayers, roleOf } from './partDefs.js';
import { socketsOf, gearCirclesOf, beamHoleOffsets, localToWorld } from './geometry.js';
import { MESH_TOL } from '../physics/gearTrain.js';

export const SOCKET_SNAP = 0.5;   // world units
export const MESH_SNAP = 0.7;
export const GRID = 0.4;

const roundTo = (v, step) => Math.round(v / step) * step;

/** Human-friendly description of what a socket belongs to. */
function socketLabel(def) {
  switch (def.kind) {
    case 'motor': return 'on motor shaft';
    case 'crank': return 'on crank shaft';
    case 'rotPin': return 'on rotating pin';
    case 'fixedPin': return 'on fixed pin';
    case 'axle': return 'on axle';
    case 'hinge': return 'on hinge';
    case 'beam': return 'on beam hole';
    default: return `stacked on ${def.name}`;
  }
}

/** Nearest socket of `others` to (x, y) within `radius`. */
function nearestSocket(others, x, y, radius) {
  let best = null;
  for (const part of others) {
    for (const s of socketsOf(part)) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < radius && (!best || d < best.d)) best = { x: s.x, y: s.y, d, part };
    }
  }
  return best;
}

/**
 * Tooth phase so that gear B (teeth nB, at bx,by) meshes nicely with gear A.
 * At the contact direction, a tooth of A must face a gap of B. If fA is how
 * far (0..1 of one tooth pitch) A's nearest tooth is from the contact line,
 * B's must be offset by half a tooth: fA + fB = 0.5.
 */
export function meshPhase(a, aAngle, bx, by, nB) {
  const phi = Math.atan2(by - a.y, bx - a.x);
  const pitchA = (2 * Math.PI) / a.teeth;
  let fA = ((phi - aAngle) / pitchA) % 1;
  if (fA < 0) fA += 1;
  return phi + Math.PI - ((2 * Math.PI) / nB) * (0.5 - fA);
}

/**
 * @param parts   all placed parts
 * @param type    part type being placed/moved
 * @param x,y     where the pointer wants it
 * @param angle   current rotation
 * @param opts    { excludeUid, grid: boolean }
 * @returns {{ x, y, angle, hint: string|null }}
 */
export function snapPart(parts, type, x, y, angle, opts = {}) {
  const def = getDef(type);
  const role = roleOf(def.kind);
  const others = parts.filter((p) => p.uid !== opts.excludeUid);
  const useGrid = opts.grid !== false;
  let out = { x, y, angle, hint: null };

  if (role === 'object') {
    // Loose objects go wherever you drop them (ramps snap to the grid).
    if (useGrid && (def.kind === 'ramp' || def.kind === 'block')) {
      out.x = roundTo(x, GRID / 2); out.y = roundTo(y, GRID / 2);
    }
    return out;
  }

  if (role === 'beam') {
    // Try every hole of this beam against every socket nearby.
    let best = null;
    for (const lx of beamHoleOffsets(def.length)) {
      const h = localToWorld(x, y, angle, lx, 0);
      const s = nearestSocket(others, h.x, h.y, SOCKET_SNAP);
      if (s && (!best || s.d < best.d)) best = { ...s, dx: s.x - h.x, dy: s.y - h.y };
    }
    if (best) return { x: x + best.dx, y: y + best.dy, angle, hint: `hole ${socketLabel(getDef(best.part.type)).replace('on ', 'onto ')}` };
    if (useGrid) { out.x = roundTo(x, GRID); out.y = roundTo(y, GRID); }
    return out;
  }

  // Rotors, drivers, connectors: snap the centre onto a socket.
  const s = nearestSocket(others, x, y, SOCKET_SNAP);
  if (s) {
    out = { x: s.x, y: s.y, angle, hint: socketLabel(getDef(s.part.type)) };
  } else if (def.kind === 'gear' || def.kind === 'compoundGear') {
    // Mesh snap: find the gear circle whose "touching distance" is closest.
    let best = null;
    const mine = gearLayers(def);
    for (const c of others.flatMap(gearCirclesOf)) {
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < 1e-3) continue;
      for (const m of mine) {
        const target = c.r + m.r;
        const err = Math.abs(d - target);
        if (err < MESH_SNAP && (!best || err < best.err)) {
          best = { err, x: c.x + ((x - c.x) / d) * target, y: c.y + ((y - c.y) / d) * target, c };
        }
      }
    }
    if (best) {
      const other = parts.find((p) => p.uid === best.c.uid);
      out = { x: best.x, y: best.y, angle, hint: `meshes with ${getDef(other.type).name}` };
    } else if (useGrid) {
      out.x = roundTo(x, GRID); out.y = roundTo(y, GRID);
    }
  } else if (useGrid) {
    out.x = roundTo(x, GRID); out.y = roundTo(y, GRID);
  }

  // Cosmetic: line the teeth up with the first gear we mesh with.
  if (def.kind === 'gear' || def.kind === 'compoundGear') {
    const mine = gearLayers(def);
    outer: for (const c of others.flatMap(gearCirclesOf)) {
      const d = Math.hypot(out.x - c.x, out.y - c.y);
      for (const m of mine) {
        if (Math.abs(d - (c.r + m.r)) < MESH_TOL) {
          const other = others.find((p) => p.uid === c.uid);
          out.angle = meshPhase(c, other.angle, out.x, out.y, m.teeth);
          if (!out.hint) out.hint = `meshes with ${getDef(other.type).name}`;
          else if (!out.hint.includes('meshes')) out.hint += ` · meshes with ${getDef(other.type).name}`;
          break outer;
        }
      }
    }
  }
  return out;
}
