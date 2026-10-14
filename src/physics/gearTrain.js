// =============================================================================
// gearTrain.js — the gear-train GRAPH and RATIO MATH.
//
// We never simulate individual teeth. Instead:
//   1. Two gears are MESHED when the distance between their centres equals
//      the sum of their pitch radii (that's exactly where the snapping puts
//      them).
//   2. Each mesh is an edge in a graph whose nodes are rigid bodies (a body
//      may hold several gears that share an axle, e.g. a compound gear).
//   3. Walking the graph from the motor, each mesh applies
//          speed_out = -speed_in × (teeth_in / teeth_out)
//      The minus sign is because meshed gears turn in opposite directions.
//      Torque goes the other way: torque_out = torque_in × (teeth_out / teeth_in)
//      (so ratio × torque stays constant — energy is conserved, minus friction).
//   4. An idler (a gear between two others) flips direction twice, so the
//      output turns the same way as the input — that falls out of the math.
//
// JAMS: if a loop of gears disagrees about how fast something should turn
// (e.g. three gears meshed in a triangle) or a gear is meshed with something
// bolted to the background, that train is JAMMED: it simply doesn't move.
// Parts never break.
//
// CHAINS link two sprockets (or gears) at any distance. They're edges too,
// but the sign is + : both ends turn the SAME way.
//     speed_out = +speed_in × (teeth_in / teeth_out)
//
// The physics layer (world.js) turns each graph edge into a Planck GearJoint
// with exactly this ratio, so the physics engine then handles torque, load,
// inertia and stalling for us.
// =============================================================================
import { gearCirclesOf } from '../parts/geometry.js';
import { getDef, partDef, chainTeeth, chainRadius } from '../parts/partDefs.js';
import { WORLD, mainKey } from './assembly.js';

/** How close (world units) centre distance must be to r1 + r2 to count as meshed. */
export const MESH_TOL = 0.1;

/** All meshed gear pairs in a list of parts. */
export function findMeshes(parts) {
  const circles = parts.flatMap(gearCirclesOf);
  const meshes = [];
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i], b = circles[j];
      if (a.uid === b.uid) continue; // two layers of one compound gear
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < 1e-6 || Math.abs(d - (a.r + b.r)) > MESH_TOL) continue;
      const t = a.r / d; // contact point lies on the line between centres
      meshes.push({ a, b, contact: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } });
    }
  }
  return meshes;
}

/** All chains whose two ends still exist and can take a chain. */
export function findChains(parts) {
  const byUid = new Map(parts.map((p) => [p.uid, p]));
  const out = [];
  for (const p of parts) {
    if (getDef(p.type).kind !== 'chain') continue;
    const pa = byUid.get(p.props.a), pb = byUid.get(p.props.b);
    if (!pa || !pb) continue;
    const da = partDef(pa), db = partDef(pb);
    if (!chainTeeth(da) || !chainTeeth(db)) continue;
    out.push({
      chain: true, uid: p.uid,
      a: { uid: pa.uid, teeth: chainTeeth(da), r: chainRadius(da), x: pa.x, y: pa.y },
      b: { uid: pb.uid, teeth: chainTeeth(db), r: chainRadius(db), x: pb.x, y: pb.y },
    });
  }
  return out;
}

/**
 * Solve the gear train for a build.
 * @param parts     placed parts
 * @param assembly  result of buildAssembly(parts)
 */
export function solveGearTrain(parts, assembly) {
  const meshes = [...findMeshes(parts), ...findChains(parts)].map((m) => ({
    ...m,
    bodyA: assembly.bodyOf(mainKey(m.a.uid)),
    bodyB: assembly.bodyOf(mainKey(m.b.uid)),
    tree: false,        // true = becomes a physics GearJoint
    status: 'ok',       // 'ok' | 'floating' | 'sameBody'
    component: -1,
  }));

  // Classify each body: 'static' (background), 'mounted' (spins on an
  // axle joint) or 'floating' (no axle: a loose gear).
  const nodeType = (body) => {
    if (body === WORLD) return 'static';
    return assembly.axleOf(body) ? 'mounted' : 'floating';
  };

  // Adjacency list over bodies.
  const adj = new Map();
  const floatingGears = new Set();
  for (const m of meshes) {
    if (m.bodyA === m.bodyB) { m.status = 'sameBody'; continue; }
    const ta = nodeType(m.bodyA), tb = nodeType(m.bodyB);
    if (ta === 'floating' || tb === 'floating') {
      m.status = 'floating';
      if (ta === 'floating') floatingGears.add(m.a.uid);
      if (tb === 'floating') floatingGears.add(m.b.uid);
      continue;
    }
    for (const [from, to, gFrom, gTo] of [[m.bodyA, m.bodyB, m.a, m.b], [m.bodyB, m.bodyA, m.b, m.a]]) {
      if (!adj.has(from)) adj.set(from, []);
      // factor: speed(to) = factor × speed(from). Meshes flip direction, chains don't.
      adj.get(from).push({ to, factor: (m.chain ? 1 : -1) * gFrom.teeth / gTo.teeth, mesh: m });
    }
  }

  const components = [];
  const bodyInfo = new Map(); // body -> { component, ratio }
  const driverOfBody = (b) => (b === WORLD ? null : assembly.axleOf(b)?.driverUid ?? null);

  for (const start of adj.keys()) {
    if (bodyInfo.has(start)) continue;

    // Collect the component first so we can choose a good root (the motor).
    const members = [];
    const stack = [start];
    const seen = new Set([start]);
    while (stack.length) {
      const b = stack.pop();
      members.push(b);
      for (const e of adj.get(b) || []) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    }
    const driven = members.filter((b) => driverOfBody(b) != null);
    const root = driven[0] || members.find((b) => b !== WORLD) || members[0];

    const comp = {
      id: components.length, bodies: members, root,
      driverUids: driven.map(driverOfBody),
      ratio: new Map([[root, 1]]),
      jammed: false, reason: '',
    };
    components.push(comp);

    // Breadth-first walk from the root, multiplying ratios along the way.
    const queue = [root];
    while (queue.length) {
      const b = queue.shift();
      for (const e of adj.get(b) || []) {
        e.mesh.component = comp.id;
        const expected = comp.ratio.get(b) * e.factor;
        if (!comp.ratio.has(e.to)) {
          comp.ratio.set(e.to, expected);
          e.mesh.tree = true;
          queue.push(e.to);
        } else if (!e.mesh.tree) {
          // A loop: fine if consistent (the edge is just redundant),
          // a jam if the loop disagrees.
          const have = comp.ratio.get(e.to);
          if (Math.abs(have - expected) > 1e-6 * Math.max(1, Math.abs(have))) {
            comp.jammed = true;
            comp.reason = 'Gear loop fights itself';
          }
        }
      }
    }
    if (members.includes(WORLD)) {
      comp.jammed = true;
      comp.reason = comp.reason || 'Meshed with a gear that is bolted down';
    }
    for (const b of members) bodyInfo.set(b, { component: comp.id, ratio: comp.ratio.get(b) });
  }

  return {
    meshes, components, bodyInfo, floatingGears,
    /**
     * How is this body driven? → { driverUid, ratio, jammed, component } or null.
     * ratio = this body's speed / the motor's speed (signed).
     */
    driveOf(bodyId) {
      const info = bodyInfo.get(bodyId);
      if (info) {
        const comp = components[info.component];
        if (!comp.driverUids.length) return { driverUid: null, ratio: info.ratio, jammed: comp.jammed, component: comp };
        // Root of a powered component is the motor's body, so ratio is already relative to it.
        return { driverUid: comp.driverUids[0], ratio: info.ratio, jammed: comp.jammed, component: comp };
      }
      const axle = bodyId === WORLD ? null : assembly.axleOf(bodyId);
      if (axle?.driverUid != null) return { driverUid: axle.driverUid, ratio: 1, jammed: false, component: null };
      return null;
    },
  };
}
