// =============================================================================
// assembly.js — turns a build (list of placed parts) into a description of
// rigid BODIES and JOINTS, *without* touching the physics engine.
//
// Step 1: find JOINT POINTS. Every part has sockets (gear centres, beam holes,
//         pins...). Sockets that sit on top of each other form a "cluster".
// Step 2: apply the JOINING RULES at each cluster (below) to produce
//         WELDS (two things become one rigid piece) and
//         REVOLUTES (two things spin relative to each other around the point).
// Step 3: merge welded things into bodies with union-find.
//
// JOINING RULES at one joint point:
//   • Rotors (gears, wheels) stacked on the same point are locked together —
//     they share one shaft. (That's how "gears on a shared axle" works.)
//   • Beams on the same point are bolted together, unless a HINGE is there,
//     in which case each beam pivots freely.
//   • The rotors' shaft spins freely in whatever holds it ("the carrier"):
//     a rotating/fixed pin (= the background) or a beam.
//   • A MOTOR or CRANK on the point drives the shaft relative to the carrier.
//     With nothing else to sit on, a motor is bolted to the background.
//   • A FIXED PIN welds everything there to the background (nothing spins),
//     except a motor's shaft, which still turns.
//   • An AXLE locks the beams at that point onto the shaft too, so a beam
//     turns with the gear (great for arms and levers).
//
// Each part becomes one or two ELEMENTS (a motor has a housing AND a spinning
// hub). Elements are what get welded/jointed.
// =============================================================================
import { getDef, roleOf } from '../parts/partDefs.js';
import { socketsOf } from '../parts/geometry.js';

export const WORLD = 'world';
/** Sockets closer than this (world units) are treated as the same point. */
export const CLUSTER_TOL = 0.12;

/** Element key helpers. The "main" element of part 7 is "7"; its hub is "7:hub". */
export const mainKey = (uid) => String(uid);
export const hubKey = (uid) => `${uid}:hub`;

// ------------------------------------------------------------ union-find --
class UnionFind {
  constructor() { this.parent = new Map(); }
  add(k) { if (!this.parent.has(k)) this.parent.set(k, k); }
  find(k) {
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    // Path compression keeps later lookups fast.
    while (this.parent.get(k) !== r) { const n = this.parent.get(k); this.parent.set(k, r); k = n; }
    return r;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    // Keep WORLD as the root so the static body is always called "world".
    if (rb === WORLD) this.parent.set(ra, rb); else this.parent.set(rb, ra);
  }
}

/** Group sockets of all parts into joint points (clusters). */
export function findClusters(parts) {
  const clusters = [];
  for (const part of parts) {
    for (const s of socketsOf(part)) {
      let c = clusters.find((cl) => Math.hypot(cl.x - s.x, cl.y - s.y) < CLUSTER_TOL);
      if (!c) { c = { x: s.x, y: s.y, uids: [] }; clusters.push(c); }
      if (!c.uids.includes(part.uid)) c.uids.push(part.uid);
    }
  }
  return clusters;
}

/**
 * Build the assembly description.
 * @returns {{
 *   elements: Map<string,{key,uid,sub}>,
 *   bodies: Array<{id,keys,isStatic,origin}>,
 *   bodyOf: (key)=>string,
 *   revolutes: Array<{id,a,b,x,y,driverUid}>,
 *   clusters: Array, warnings: string[] }}
 */
export function buildAssembly(parts) {
  const byUid = new Map(parts.map((p) => [p.uid, p]));
  const uf = new UnionFind();
  const elements = new Map();
  uf.add(WORLD);

  const addElement = (key, uid, sub) => { elements.set(key, { key, uid, sub }); uf.add(key); };

  // ---- elements --------------------------------------------------------
  for (const part of parts) {
    const def = getDef(part.type);
    addElement(mainKey(part.uid), part.uid, 'main');
    if (def.kind === 'motor' || def.kind === 'crank') addElement(hubKey(part.uid), part.uid, 'hub');
    // Map pieces (ramps, blocks) and pins are part of the static background.
    if (def.kind === 'ramp' || def.kind === 'block' ||
        def.kind === 'fixedPin' || def.kind === 'rotPin') {
      uf.union(WORLD, mainKey(part.uid));
    }
  }

  // ---- joining rules per cluster --------------------------------------
  const clusters = findClusters(parts);
  const pendingRevolutes = []; // [elemKeyA, elemKeyB, cluster, driverUid]
  const weld = (a, b) => uf.union(a, b);

  clusters.forEach((cl, ci) => {
    const kinds = cl.uids.map((uid) => ({ uid, def: getDef(byUid.get(uid).type) }));
    const has = (k) => kinds.some((e) => e.def.kind === k);
    const ofRole = (r) => kinds.filter((e) => roleOf(e.def.kind) === r);

    const fixed = has('fixedPin');
    const rot = has('rotPin');
    const axle = kinds.find((e) => e.def.kind === 'axle');
    const hinge = kinds.find((e) => e.def.kind === 'hinge');
    const drivers = ofRole('driver');
    const rotors = ofRole('rotor');
    const beams = ofRole('beam');

    // The spinning unit: all rotors, the axle, the driver's hub, and (with an
    // axle) the beams too.
    const unit = rotors.map((e) => mainKey(e.uid));
    if (axle) unit.push(mainKey(axle.uid));
    const driver = drivers[0] || null;
    if (driver) unit.push(hubKey(driver.uid));
    const freeBeams = axle ? [] : beams.map((e) => mainKey(e.uid));
    if (axle) for (const b of beams) unit.push(mainKey(b.uid));

    // What holds the unit?
    let carrier = null;
    if (fixed || rot) carrier = WORLD;
    else if (freeBeams.length) carrier = freeBeams[0];
    else if (driver) carrier = WORLD; // a lone motor is bolted to the background

    // Beams that aren't on the shaft.
    if (freeBeams.length) {
      if (fixed) {
        for (const b of freeBeams) weld(WORLD, b);
      } else if (hinge) {
        // Every beam pivots on its own. On a rotating pin they pivot on the
        // background; otherwise on the first beam.
        const base = rot ? WORLD : freeBeams[0];
        for (const b of freeBeams) if (b !== base) pendingRevolutes.push([base, b, cl, null]);
      } else {
        for (const b of freeBeams.slice(1)) weld(freeBeams[0], b);
        if (rot) pendingRevolutes.push([WORLD, freeBeams[0], cl, null]);
      }
    }

    // The hinge part itself is just drawn on the carrier.
    if (hinge) weld(mainKey(hinge.uid), carrier || unit[0] || mainKey(hinge.uid));

    // Driver housings sit on the carrier. Extra drivers on the same point
    // are just housings (only the first one drives).
    for (const d of drivers) weld(mainKey(d.uid), carrier || WORLD);
    for (const d of drivers.slice(1)) weld(hubKey(d.uid), mainKey(d.uid));

    // Lock the unit together and join it to the carrier.
    for (const k of unit.slice(1)) weld(unit[0], k);
    if (unit.length) {
      if (fixed && !driver) weld(WORLD, unit[0]);
      else if (carrier) pendingRevolutes.push([carrier, unit[0], cl, driver ? driver.uid : null]);
    }
    cl.index = ci;
  });

  // Loose objects (balls/crates) are simply their own bodies (nothing to do).

  // ---- resolve elements into bodies ------------------------------------
  const bodyOf = (key) => uf.find(key);
  const bodyMap = new Map();
  for (const key of [WORLD, ...elements.keys()]) {
    const id = bodyOf(key);
    if (!bodyMap.has(id)) bodyMap.set(id, { id, keys: [], isStatic: id === WORLD, origin: null });
    if (key !== WORLD) bodyMap.get(id).keys.push(key);
  }

  const warnings = [];
  const revolutes = [];
  for (const [ka, kb, cl, driverUid] of pendingRevolutes) {
    const a = bodyOf(ka), b = bodyOf(kb);
    if (a === b) {
      warnings.push(`Parts at (${cl.x.toFixed(1)}, ${cl.y.toFixed(1)}) are locked together, so that joint can't turn.`);
      continue;
    }
    if (b === WORLD) continue; // can't spin the background
    revolutes.push({ id: revolutes.length, a, b, x: cl.x, y: cl.y, driverUid });
  }

  // Body origin: its main pivot if it has one (nice for rotation), otherwise
  // the position of its first part.
  for (const body of bodyMap.values()) {
    if (body.isStatic) { body.origin = { x: 0, y: 0 }; continue; }
    const pivot = revolutes.find((r) => r.b === body.id);
    if (pivot) body.origin = { x: pivot.x, y: pivot.y };
    else {
      const p = byUid.get(elements.get(body.keys[0]).uid);
      body.origin = { x: p.x, y: p.y };
    }
  }

  return {
    elements, bodies: [...bodyMap.values()], bodyOf, revolutes, clusters, warnings,
    /** The revolute that a body spins on (it is the joint's body B), if any. */
    axleOf(bodyId) { return revolutes.find((r) => r.b === bodyId) || null; },
  };
}
