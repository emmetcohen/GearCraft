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
//   • PIVOT sockets (a drive wheel's crank pin, a slider's block) always
//     pivot on whatever else is at that point: side rods, pistons, legs.
//   • A SLIDER's rail is bolted down if nothing holds its end holes; its
//     block slides along it (a prismatic joint).
//   • LINKS (chains, springs, ropes, wires) have no sockets: they're added by
//     the gear train (chains) and the physics world (springs, ropes, wires).
//   • CONTROLS (switches, buttons, keys) ride on the part under them, or sit
//     on the background if there's nothing there.
//   • GADGETS and LATCHES ride on the part under them too. (A latch's grip
//     on the NEXT part under it is a joint the physics world can let go of.)
//   • A TRAP DOOR's hinge bracket bolts onto whatever is at its hinge end (or
//     the background); the flap swings on it (a powered hinge).
//   • An ANCHORED part (Screwdriver) is bolted to the background.
//   • A BOLT locks together every part under it, wherever they overlap.
//     Parts bolted together don't also join at each other's holes (a beam
//     bolted onto a gear and running through its centre isn't its axle).
//
// Each part becomes one or two ELEMENTS (a motor has a housing AND a spinning
// hub). Elements are what get welded/jointed.
// =============================================================================
import { getDef, roleOf } from '../parts/partDefs.js';
import { socketsOf, pickPart, partsAt } from '../parts/geometry.js';

export const WORLD = 'world';
/** Roles that sit ON other parts instead of being something to sit on. */
const RIDERS = ['link', 'control', 'bolt', 'gadget', 'latch'];
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

/** Group sockets of all parts into joint points (clusters).
 *  cl.uids   = parts joined here by an ordinary socket
 *  cl.pivots = [{ uid, sub }] pivot sockets here (crank pins, slider blocks) */
export function findClusters(parts) {
  const clusters = [];
  for (const part of parts) {
    for (const s of socketsOf(part)) {
      let c = clusters.find((cl) => Math.hypot(cl.x - s.x, cl.y - s.y) < CLUSTER_TOL);
      if (!c) { c = { x: s.x, y: s.y, uids: [], pivots: [] }; clusters.push(c); }
      if (s.pivot) c.pivots.push({ uid: part.uid, sub: s.sub, bolt: !!s.bolt, mount: !!s.mount });
      else if (!c.uids.includes(part.uid)) c.uids.push(part.uid);
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
 *   revolutes: Array<{id,a,b,x,y,driverUid,pivot}>,
 *   prismatics: Array<{a,b,uid}>,
 *   hinges: Array<{a,b,uid,x,y}>,  // trap doors: flap b swings on bracket a
 *   joints: Array<{x,y,type}>,   // 'weld' | 'spin' | 'drive' (edit-mode markers)
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
    if (roleOf(def.kind) === 'link') continue; // chains/springs/ropes aren't bodies
    addElement(mainKey(part.uid), part.uid, 'main');
    if (['motor', 'crank', 'slider', 'piston', 'trapdoor'].includes(def.kind)) addElement(hubKey(part.uid), part.uid, 'hub');
    // Map pieces (ramps, blocks, track) and pins are part of the static background.
    if (def.kind === 'ramp' || def.kind === 'block' || def.kind === 'track' ||
        def.kind === 'conveyor' || def.kind === 'bouncePad' || def.kind === 'water' ||
        def.kind === 'fixedPin' || def.kind === 'rotPin' || part.props?.anchored) {
      uf.union(WORLD, mainKey(part.uid));
    }
  }

  // Controls, gadgets and latches ride on whatever solid part is under them.
  const solid = parts.filter((p) => !RIDERS.includes(roleOf(getDef(p.type).kind)) && getDef(p.type).kind !== 'water');
  for (const part of parts) {
    const r = roleOf(getDef(part.type).kind);
    if (r !== 'control' && r !== 'gadget' && r !== 'latch') continue;
    const under = pickPart(solid, part.x, part.y);
    uf.union(under ? mainKey(under.uid) : WORLD, mainKey(part.uid));
  }

  // ---- bolts ------------------------------------------------------------
  // Everything under a bolt becomes one rigid piece (with the bolt).
  const boltGroup = new UnionFind();
  for (const part of parts) {
    if (getDef(part.type).kind !== 'bolt') continue;
    const under = partsAt(solid, part.x, part.y);
    if (!under.length) { uf.union(WORLD, mainKey(part.uid)); continue; }
    for (const p of under) {
      uf.union(mainKey(under[0].uid), mainKey(p.uid));
      boltGroup.add(p.uid); boltGroup.add(under[0].uid);
      boltGroup.union(under[0].uid, p.uid);
    }
    uf.union(mainKey(under[0].uid), mainKey(part.uid));
  }
  const bolted = (a, b) => boltGroup.parent.has(a) && boltGroup.parent.has(b) && boltGroup.find(a) === boltGroup.find(b);

  // ---- joining rules per cluster --------------------------------------
  const clusters = findClusters(parts);

  // Bolted-together parts don't also join at a shared hole: drop the beam
  // (keep the gear/wheel/motor, which needs that point as its axle).
  const keepRank = (uid) => ({ rotor: 3, driver: 3, connector: 2 }[roleOf(getDef(byUid.get(uid).type).kind)] ?? 1);
  for (const cl of clusters) {
    cl.uids = cl.uids.filter((u) => !cl.uids.some((v) => v !== u && bolted(u, v) && keepRank(v) > keepRank(u)));
  }

  // A part hooked onto another part's PIVOT (a rod on a crank pin or slider
  // block) must move relative to it, so it never bolts onto that part's
  // other holes, even where it happens to lie across them (a piston rod
  // running along its rail).
  const hookedTo = new Map(); // pivot owner uid -> Set of uids on its pivots
  for (const cl of clusters) {
    for (const pv of cl.pivots) {
      if (!hookedTo.has(pv.uid)) hookedTo.set(pv.uid, new Set());
      for (const u of cl.uids) hookedTo.get(pv.uid).add(u);
    }
  }
  for (const cl of clusters) {
    for (const [owner, hooked] of hookedTo) {
      if (cl.uids.includes(owner)) cl.uids = cl.uids.filter((u) => u === owner || !hooked.has(u));
    }
  }
  const pendingRevolutes = []; // [elemKeyA, elemKeyB, cluster, driverUid, pivot]
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

    // Pivot sockets (crank pins, slider blocks) pivot on whatever is here.
    // Gear face holes ("bolt") bolt it on instead, unless there's a hinge or
    // a rotating pin here.
    // Trap door brackets ("mount") always bolt on.
    const pivotKeys = cl.pivots.map((pv) => ({ key: pv.sub === 'hub' ? hubKey(pv.uid) : mainKey(pv.uid), bolt: pv.bolt, mount: pv.mount }));
    if (pivotKeys.length) {
      const base = freeBeams[0] ?? unit[0] ?? (fixed || rot ? WORLD : pivotKeys[0].key);
      for (const { key: k, bolt, mount } of pivotKeys) {
        if (k === base) continue;
        if ((fixed && base === WORLD) || mount || (bolt && !hinge && !rot)) weld(base, k);
        else pendingRevolutes.push([base, k, cl, null, true]);
      }
    }
    cl.index = ci;
  });

  // Sliders: the rail is bolted to the background unless something holds
  // one of its end holes; the block slides along the rail.
  // Pistons: the rod slides out of the cylinder; a free bottom end is fixed
  // to the background.
  const pendingPrismatics = [];
  for (const part of parts) {
    if (getDef(part.type).kind !== 'piston') continue;
    // Free = neither base joint (bottom end, or the one up the cylinder) touches anything.
    const bases = clusters.filter((cl) => cl.pivots.some((pv) => pv.uid === part.uid && pv.sub === 'main'));
    if (bases.every((cl) => cl.uids.length === 0 && cl.pivots.length === 1)) weld(WORLD, mainKey(part.uid));
    pendingPrismatics.push([mainKey(part.uid), hubKey(part.uid), part.uid, true]);
  }
  // Trap doors: a bracket with nothing at its hinge is on the background.
  const pendingHinges = [];
  for (const part of parts) {
    if (getDef(part.type).kind !== 'trapdoor') continue;
    const cl = clusters.find((c) => c.pivots.some((pv) => pv.uid === part.uid));
    if (!cl || (cl.uids.length === 0 && cl.pivots.every((pv) => pv.mount))) weld(WORLD, hubKey(part.uid));
    pendingHinges.push([hubKey(part.uid), mainKey(part.uid), part.uid, cl]);
  }
  for (const part of parts) {
    if (getDef(part.type).kind !== 'slider') continue;
    const held = clusters.some((cl) => cl.uids.length > 1 && cl.uids.includes(part.uid));
    if (!held) weld(WORLD, mainKey(part.uid));
    pendingPrismatics.push([mainKey(part.uid), hubKey(part.uid), part.uid]);
  }

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
  for (const [ka, kb, cl, driverUid, pivot = false] of pendingRevolutes) {
    let a = bodyOf(ka), b = bodyOf(kb);
    if (a === b) {
      if (pivot) continue; // e.g. a piston end bolted to what it's on: just rigid
      warnings.push(`Parts at (${cl.x.toFixed(1)}, ${cl.y.toFixed(1)}) are locked together, so that joint can't turn.`);
      continue;
    }
    if (b === WORLD) {
      if (!pivot) continue; // can't spin the background
      [a, b] = [b, a];
    }
    revolutes.push({ id: revolutes.length, a, b, x: cl.x, y: cl.y, driverUid, pivot, cluster: cl.index });
  }
  const prismatics = [];
  for (const [ka, kb, uid, piston = false] of pendingPrismatics) {
    const a = bodyOf(ka), b = bodyOf(kb);
    if (a !== b && b !== WORLD) prismatics.push({ a, b, uid, piston });
  }

  const hinges = [];
  for (const [ka, kb, uid, cl] of pendingHinges) {
    const a = bodyOf(ka), b = bodyOf(kb);
    if (a !== b && b !== WORLD) hinges.push({ a, b, uid, x: cl.x, y: cl.y });
  }

  // Joint markers for edit mode: what happens at each shared point?
  const joints = [];
  for (const cl of clusters) {
    if (cl.uids.length + cl.pivots.length < 2) continue;
    const here = revolutes.filter((r) => r.cluster === cl.index);
    const type = here.some((r) => r.driverUid != null) ? 'drive' : here.length || hinges.some((h) => h.x === cl.x && h.y === cl.y) ? 'spin' : 'weld';
    joints.push({ x: cl.x, y: cl.y, type });
  }

  // Body origin: its main pivot if it has one (nice for rotation), otherwise
  // the position of its first part.
  for (const body of bodyMap.values()) {
    if (body.isStatic) { body.origin = { x: 0, y: 0 }; continue; }
    const pivot = revolutes.find((r) => r.b === body.id && !r.pivot);
    if (pivot) body.origin = { x: pivot.x, y: pivot.y };
    else {
      const p = byUid.get(elements.get(body.keys[0]).uid);
      body.origin = { x: p.x, y: p.y };
    }
  }

  // Beams bolted onto a gear/wheel (draw them on top of it, so they look attached).
  const onRotor = new Set();
  for (const body of bodyMap.values()) {
    if (body.isStatic) continue;
    const uids = body.keys.map((k) => elements.get(k).uid);
    if (!uids.some((u) => roleOf(getDef(byUid.get(u).type).kind) === 'rotor')) continue;
    for (const u of uids) if (roleOf(getDef(byUid.get(u).type).kind) === 'beam') onRotor.add(u);
  }

  return {
    onRotor,
    elements, bodies: [...bodyMap.values()], bodyOf, revolutes, prismatics, hinges, joints, clusters, warnings,
    /** The axle revolute that a body spins on (it is the joint's body B), if any.
     *  Pivots (crank pins) don't count: a wheel spins on its centre. */
    axleOf(bodyId) { return revolutes.find((r) => r.b === bodyId && !r.pivot) || null; },
  };
}
