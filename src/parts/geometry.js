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
import { getDef, partDef, gearLayers, faceHoles, pistonMount, pistonExt, HOLE_SPACING, MODULE, roleOf } from './partDefs.js';

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
  // Holes every HOLE_SPACING from the left end. A drawn beam's length may not
  // be a whole number of holes, so the right end always gets a hole too.
  const n = Math.floor(length / HOLE_SPACING + 1e-6);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(-length / 2 + i * HOLE_SPACING);
  const end = length / 2;
  if (end - out[out.length - 1] > 1e-6) {
    if (end - out[out.length - 1] < HOLE_SPACING * 0.45 && out.length > 1) out.pop();
    out.push(end);
  }
  return out;
}

/** Local x-positions of a beam-like part's holes (sliders only have end holes). */
export function holesOf(def) {
  if (def.kind === 'slider') return [-def.length / 2, def.length / 2];
  if (def.kind === 'beam' || def.kind === 'plate') return beamHoleOffsets(def.length);
  return [];
}

/** The two end points of a drawn part (beam, spring, rope, slider, track). */
export function lineEnds(part) {
  const def = partDef(part);
  const h = def.length / 2;
  return [localToWorld(part.x, part.y, part.angle, -h, 0), localToWorld(part.x, part.y, part.angle, h, 0)];
}

/** Centre, angle and length of a line from a to b (inverse of lineEnds). */
export function lineFrom(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: Math.atan2(b.y - a.y, b.x - a.x), length: Math.hypot(b.x - a.x, b.y - a.y) };
}

/**
 * Sockets are the points where parts can join each other.
 * Returns world-space points: [{ x, y, index, sub, pivot }].
 *  - beams: every hole (sliders: their two end holes)
 *  - everything else with a role (rotors, drivers, connectors): its centre
 *  - drive wheels: also a crank PIN off-centre (pivot: anything there pivots)
 *  - gears/sprockets: four face holes (bolt: things there are bolted on,
 *    or pivot if there's a hinge)
 *  - sliders: also the sliding block (sub 'hub', pivot)
 *  - loose objects and links: none
 * `sub` says which element of the part the socket belongs to ('main' or 'hub').
 */
export function socketsOf(part) {
  const def = partDef(part);
  const role = roleOf(def.kind);
  if (role === 'object' || role === 'link' || role === 'control' || role === 'bolt' || role === 'gadget' || role === 'latch') return [];
  if (role === 'door') {
    // The hinge, at the end it was drawn from. Its bracket MOUNTS (bolts) onto
    // whatever is there; the flap swings on the bracket.
    return [{ ...localToWorld(part.x, part.y, part.angle, -def.length / 2, 0), index: 0, sub: 'hub', pivot: true, mount: true }];
  }
  if (role === 'piston') {
    // A pivot at each end (the bottom on the cylinder, the top on the rod),
    // plus a second joint on the cylinder: pin both base joints to the same
    // beam and the piston can't swing.
    const h = def.length / 2;
    return [
      { ...localToWorld(part.x, part.y, part.angle, -h, 0), index: 0, sub: 'main', pivot: true },
      { ...localToWorld(part.x, part.y, part.angle, h + pistonExt(part, def), 0), index: 1, sub: 'hub', pivot: true },
      { ...localToWorld(part.x, part.y, part.angle, -h + pistonMount(def), 0), index: 2, sub: 'main', pivot: true },
    ];
  }
  if (role === 'beam') {
    const out = holesOf(def).map((lx, index) => ({
      ...localToWorld(part.x, part.y, part.angle, lx, 0), index, sub: 'main', pivot: false,
    }));
    if (def.kind === 'slider') {
      const t = part.props?.slide ?? 0;
      out.push({ ...localToWorld(part.x, part.y, part.angle, t, 0), index: 2, sub: 'hub', pivot: true });
    }
    return out;
  }
  const out = [{ x: part.x, y: part.y, index: 0, sub: 'main', pivot: false }];
  if (def.pinOffset) {
    out.push({ ...localToWorld(part.x, part.y, part.angle, def.pinOffset, 0), index: 1, sub: 'main', pivot: true });
  }
  // Gear/sprocket face holes: whatever goes on them is BOLTED to the gear.
  faceHoles(def).forEach(([lx, ly], i) => {
    out.push({ ...localToWorld(part.x, part.y, part.angle, lx, ly), index: 2 + i, sub: 'main', pivot: true, bolt: true });
  });
  return out;
}

/** Outer radius used for hit testing / selection rings of round parts. */
export function outerRadius(def) {
  switch (def.kind) {
    case 'gear': case 'compoundGear':
      return gearLayers(def)[0].r + MODULE * 0.9;
    case 'sprocket': return def.radius + 0.12;
    case 'wheel': return def.radius;
    case 'motor': return def.housing * 0.62;
    case 'crank': return def.armLength + 0.3;
    case 'ball': return def.radius;
    default: return def.radius ?? 0.5;
  }
}

/** Does world point (wx, wy) touch this part? Used for clicking parts. */
export function hitTest(part, wx, wy) {
  const def = partDef(part);
  const p = worldToLocal(part.x, part.y, part.angle, wx, wy);
  if (def.kind === 'piston') {
    // Its rod may start pushed out.
    return p.x >= -def.length / 2 - def.thickness / 2 && p.x <= def.length / 2 + pistonExt(part, def) + 0.2 &&
           Math.abs(p.y) <= def.thickness / 2 + 0.05;
  }
  if (def.drawn) {
    return Math.abs(p.x) <= def.length / 2 + def.thickness / 2 &&
           Math.abs(p.y) <= Math.max(def.thickness / 2, 0.2) + 0.05;
  }
  switch (def.kind) {
    case 'beam':
      return Math.abs(p.x) <= def.length / 2 + def.thickness / 2 &&
             Math.abs(p.y) <= def.thickness / 2 + 0.05;
    case 'chain': return false; // picked separately (it depends on two other parts)
    case 'motor': {
      const h = def.housing / 2;
      return Math.abs(p.x) <= h && Math.abs(p.y) <= h;
    }
    case 'crate': case 'block': case 'pressurePlate': {
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
  if (def.kind === 'spring' || def.kind === 'rope') return 3.5;
  if (['control', 'bolt', 'gadget', 'latch'].includes(roleOf(def.kind))) return 5;
  if (def.kind === 'piston' || def.kind === 'trapdoor') return 1.5;
  if (def.kind === 'water' || def.kind === 'conveyor' || def.kind === 'bouncePad') return 0;
  if (def.kind === 'track') return 0;
  switch (roleOf(def.kind)) {
    case 'connector': return 4;
    case 'driver': return 3;
    case 'rotor': return 2;
    case 'beam': return 1;
    default: return 0;
  }
}

/** Every part under a world point, topmost first. */
export function partsAt(parts, wx, wy) {
  return parts.map((part, i) => ({ part, i }))
    .filter(({ part }) => hitTest(part, wx, wy))
    .map(({ part, i }) => {
      const def = partDef(part);
      // Prefer higher priority, then smaller parts, then later (on-top) parts.
      return { part, score: pickPriority(def) * 1000 - outerRadius(def) * 10 + i * 0.001 };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.part);
}

/** Find the topmost part under a world point (or null). */
export function pickPart(parts, wx, wy) {
  return partsAt(parts, wx, wy)[0] || null;
}

/** Gear circles of a placed part in world space: [{ uid, layer, teeth, r, x, y }]. */
export function gearCirclesOf(part) {
  const def = partDef(part);
  return gearLayers(def).map((g, layer) => ({
    uid: part.uid, layer, teeth: g.teeth, r: g.r, x: part.x, y: part.y,
  }));
}

export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

/** Axis-aligned bounds of a placed part (world units): { x0, y0, x1, y1 }. */
export function boundsOf(part) {
  const def = partDef(part);
  let hx, hy;
  if (def.drawn) { hx = def.length / 2 + def.thickness / 2; hy = Math.max(def.thickness / 2, 0.15); }
  else if (def.width != null) { hx = def.width / 2; hy = def.height / 2; }
  else if (def.kind === 'motor') { hx = hy = def.housing / 2; }
  else { hx = hy = outerRadius(def); }
  // Rotate the box's corners and take their extent.
  const c = Math.abs(Math.cos(part.angle)), s = Math.abs(Math.sin(part.angle));
  const ex = hx * c + hy * s, ey = hx * s + hy * c;
  return { x0: part.x - ex, y0: part.y - ey, x1: part.x + ex, y1: part.y + ey };
}
