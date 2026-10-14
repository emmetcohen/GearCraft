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
import { getDef, partDef, gearLayers, roleOf, LENGTH_STEP } from './partDefs.js';
import { socketsOf, gearCirclesOf, holesOf, localToWorld, lineEnds } from './geometry.js';
import { MESH_TOL } from '../physics/gearTrain.js';

export const SOCKET_SNAP = 0.5;   // world units
export const MESH_SNAP = 0.7;
export const GRID = 0.4;

const roundTo = (v, step) => Math.round(v / step) * step;

/** Human-friendly description of what a socket belongs to. */
function socketLabel(def, socket) {
  if (socket?.bolt) return 'on gear hole';
  if (socket?.pivot) return def.kind === 'slider' ? 'on slider block' : 'on crank pin';
  switch (def.kind) {
    case 'motor': return 'on motor shaft';
    case 'crank': return 'on crank shaft';
    case 'rotPin': return 'on rotating pin';
    case 'fixedPin': return 'on fixed pin';
    case 'axle': return 'on axle';
    case 'hinge': return 'on hinge';
    case 'beam': return 'on beam hole';
    case 'slider': return 'on slider rail';
    default: return `stacked on ${def.name}`;
  }
}

/** "Gear 24T", using a scaled gear's own tooth count. */
function gearName(part) {
  const def = partDef(part);
  return def.kind === 'gear' ? `Gear ${def.teeth}T` : def.name;
}

/** How close (world units) the pointer must be to a spot that meshes two gears at once. */
export const DOUBLE_MESH_SNAP = 1.5;

/**
 * A gear dropped near the gap between two gears: the spot where it meshes
 * with BOTH (an idler between them). Each gear's mesh distance is a circle
 * around it; the spots are where those two circles cross.
 * @returns {{ x, y, angle, hint }} or null
 */
export function doubleMesh(others, def, x, y, angle) {
  const circles = others.flatMap(gearCirclesOf);
  const r = gearLayers(def)[0].r;
  let best = null;
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i], b = circles[j];
      if (a.uid === b.uid) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d < 1e-6) continue; // stacked on one axle
      const ra = a.r + r, rb = b.r + r;
      if (d > ra + rb || d < Math.abs(ra - rb)) continue; // can't touch both
      const along = (ra * ra - rb * rb + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, ra * ra - along * along));
      const mx = a.x + (dx * along) / d, my = a.y + (dy * along) / d;
      for (const sgn of [1, -1]) {
        const px = mx - (dy / d) * h * sgn, py = my + (dx / d) * h * sgn;
        const err = Math.hypot(px - x, py - y);
        if (err > DOUBLE_MESH_SNAP || (best && err >= best.err)) continue;
        // Don't land overlapping some third gear.
        const clash = circles.some((c) => c.uid !== a.uid && c.uid !== b.uid &&
          Math.hypot(px - c.x, py - c.y) < c.r + r - MESH_TOL);
        if (clash) continue;
        best = { err, x: px, y: py, a, b };
      }
    }
  }
  if (!best) return null;
  const pa = others.find((p) => p.uid === best.a.uid), pb = others.find((p) => p.uid === best.b.uid);
  return { x: best.x, y: best.y, angle, hint: `meshes with ${gearName(pa)} + ${gearName(pb)}` };
}

/** Nearest socket of `others` to (x, y) within `radius`. */
function nearestSocket(others, x, y, radius, opts = {}) {
  let best = null;
  for (const part of others) {
    for (const s of socketsOf(part)) {
      if (opts.noBolt && s.bolt) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < radius && (!best || d < best.d)) best = { x: s.x, y: s.y, d, part, socket: s };
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
 * @param opts    { excludeUid, grid: boolean, props: the part's own props (size overrides) }
 * @returns {{ x, y, angle, hint: string|null }}
 */
export function snapPart(parts, type, x, y, angle, opts = {}) {
  const def = partDef({ type, props: opts.props ?? {} });
  const role = roleOf(def.kind);
  const others = parts.filter((p) => p.uid !== opts.excludeUid);
  const useGrid = opts.grid !== false;
  let out = { x, y, angle, hint: null };

  if (def.kind === 'track' || def.kind === 'spring' || def.kind === 'rope' || def.kind === 'piston' || def.kind === 'conveyor') {
    // Drawn links/track being moved: snap whichever end is closest to a target.
    let best = null;
    for (const lx of [-def.length / 2, def.length / 2]) {
      const h = localToWorld(x, y, angle, lx, 0);
      const t = nearestAnchor(others, def.kind, h.x, h.y);
      if (t && (!best || t.d < best.d)) best = { ...t, dx: t.x - h.x, dy: t.y - h.y };
    }
    if (best) return { x: x + best.dx, y: y + best.dy, angle, hint: `end ${best.hint.replace('on ', 'onto ')}` };
    if (useGrid) { out.x = roundTo(x, GRID / 2); out.y = roundTo(y, GRID / 2); }
    return out;
  }

  if (role === 'bolt') {
    // Bolts go exactly where you drop them (they bolt whatever is under
    // them), but hop onto a hole if you're right next to one.
    const s = nearestSocket(others, x, y, 0.25);
    return s ? { x: s.x, y: s.y, angle, hint: `bolts ${socketLabel(getDef(s.part.type), s.socket).replace('on ', 'onto ')}` } : out;
  }

  if (role === 'object' || role === 'link' || role === 'control' || role === 'gadget') {
    // Loose objects go wherever you drop them (map pieces snap to the grid).
    if (useGrid && (def.kind === 'ramp' || def.kind === 'block' || def.kind === 'bouncePad' || def.kind === 'water')) {
      out.x = roundTo(x, GRID / 2); out.y = roundTo(y, GRID / 2);
    }
    return out;
  }

  if (role === 'beam') {
    // Try every hole of this beam against every socket nearby.
    let best = null;
    for (const lx of holesOf(def)) {
      const h = localToWorld(x, y, angle, lx, 0);
      const s = nearestSocket(others, h.x, h.y, SOCKET_SNAP);
      if (s && (!best || s.d < best.d)) best = { ...s, dx: s.x - h.x, dy: s.y - h.y };
    }
    if (best) return { x: x + best.dx, y: y + best.dy, angle, hint: `hole ${socketLabel(getDef(best.part.type), best.socket).replace('on ', 'onto ')}` };
    if (useGrid) { out.x = roundTo(x, GRID); out.y = roundTo(y, GRID); }
    return out;
  }

  // Rotors, drivers, connectors: snap the centre onto a socket. (Gears and
  // motors skip gear face holes, so meshing near another gear still works.)
  const s = nearestSocket(others, x, y, SOCKET_SNAP, { noBolt: role === 'rotor' || role === 'driver' });
  if (s) {
    out = { x: s.x, y: s.y, angle, hint: socketLabel(getDef(s.part.type), s.socket) };
  } else if ((def.kind === 'gear' || def.kind === 'compoundGear') && (out = doubleMesh(others, def, x, y, angle))) {
    // Dropped between two gears: sits where it meshes with BOTH.
  } else if (def.kind === 'gear' || def.kind === 'compoundGear') {
    out = { x, y, angle, hint: null };
    // Mesh snap: find the gear circle whose "touching distance" is closest.
    let best = null;
    const mine = gearLayers(def);
    for (const c of others.flatMap(gearCirclesOf)) {
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < 1e-3) continue;
      for (const m of mine) {
        const target = c.r + m.r;
        const err = Math.abs(d - target);
        // Snap when close to the meshing distance, OR when dropped overlapping
        // the other gear (push it out to mesh) — overlapping-but-not-meshed
        // gears would just be confusing.
        const near = err < MESH_SNAP || (d < target && d > SOCKET_SNAP);
        if (near && (!best || err < best.err)) {
          best = { err, x: c.x + ((x - c.x) / d) * target, y: c.y + ((y - c.y) / d) * target, c };
        }
      }
    }
    if (best) {
      const other = parts.find((p) => p.uid === best.c.uid);
      out = { x: best.x, y: best.y, angle, hint: `meshes with ${gearName(other)}` };
      // Pointer between two gears this one can't span? Say so.
      const r = mine[0].r;
      const far = others.flatMap(gearCirclesOf).find((c) => c.uid !== best.c.uid &&
        Math.hypot(x - c.x, y - c.y) - (c.r + r) > MESH_TOL && Math.hypot(x - c.x, y - c.y) - (c.r + r) < 1.6 &&
        Math.hypot(c.x - best.c.x, c.y - best.c.y) > best.c.r + c.r);
      if (far) out.hint += ` · too small to reach ${gearName(parts.find((p) => p.uid === far.uid))} too`;
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
          if (!out.hint) out.hint = `meshes with ${gearName(other)}`;
          else if (!out.hint.includes('meshes')) out.hint += ` · meshes with ${gearName(other)}`;
          break outer;
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ drawn parts --

/** Track and conveyors: map pieces whose ends snap together. */
const isGround = (kind) => kind === 'track' || kind === 'conveyor';

/** Ends of placed track pieces (track snaps end-to-end). */
function trackEnds(others) {
  const out = [];
  for (const p of others) if (isGround(getDef(p.type).kind)) for (const e of lineEnds(p)) out.push({ ...e, part: p });
  return out;
}

/** Nearest thing the end of a drawn part of `kind` can attach to. */
function nearestAnchor(others, kind, x, y) {
  if (isGround(kind)) {
    let best = null;
    for (const e of trackEnds(others)) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < SOCKET_SNAP && (!best || d < best.d)) best = { x: e.x, y: e.y, d, hint: 'on track end' };
    }
    return best;
  }
  const s = nearestSocket(others, x, y, SOCKET_SNAP);
  return s ? { x: s.x, y: s.y, d: s.d, hint: socketLabel(getDef(s.part.type), s.socket) } : null;
}

/**
 * Where does one END of a part being drawn land?
 * @returns {{ x, y, hint: string|null, attached: boolean }}
 */
export function snapEnd(parts, kind, x, y, opts = {}) {
  const a = nearestAnchor(parts, kind, x, y);
  if (a) return { x: a.x, y: a.y, hint: a.hint, attached: true };
  if (opts.grid !== false) return { x: roundTo(x, GRID), y: roundTo(y, GRID), hint: null, attached: false };
  return { x, y, hint: null, attached: false };
}

/**
 * The far end of a part being drawn from `a` toward the pointer `p`.
 * Lengths snap to whole holes so the far end lands on a hole too; the angle
 * snaps to 15° steps unless the end finds something to attach to.
 * @returns {{ x, y, length, hint, attached }}
 */
export function snapDrawEnd(parts, kind, a, p, opts = {}) {
  const step = isGround(kind) ? LENGTH_STEP / 2 : LENGTH_STEP;
  const min = isGround(kind) ? 1 : kind === 'piston' ? 1.2 : LENGTH_STEP * 2;
  // 1. Something to attach to near the pointer? Aim right at it.
  const t = nearestAnchor(parts, kind, p.x, p.y);
  if (t) {
    const d = Math.hypot(t.x - a.x, t.y - a.y);
    // Beams always get a hole at both ends, so the far end can land
    // exactly on it whatever the distance.
    if (d >= min * 0.75) return { x: t.x, y: t.y, length: d, hint: t.hint, attached: true };
  }
  // 2. Free end: snap the angle and the length.
  let ang = Math.atan2(p.y - a.y, p.x - a.x);
  if (opts.freeAngle !== true) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
  const L = Math.max(min, Math.round(Math.hypot(p.x - a.x, p.y - a.y) / step) * step);
  return { x: a.x + Math.cos(ang) * L, y: a.y + Math.sin(ang) * L, length: L, hint: null, attached: false };
}
