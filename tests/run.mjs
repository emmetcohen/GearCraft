// Headless tests for the pure logic + physics. Run with:  node tests/run.mjs
// (No browser needed: Planck.js and our src/ modules are plain ES modules.)
import { emptyBuild, addPart } from '../src/core/build.js';
import { buildAssembly, WORLD, mainKey } from '../src/physics/assembly.js';
import { solveGearTrain } from '../src/physics/gearTrain.js';
import { Simulation, radToRpm, DT } from '../src/physics/world.js';
import { EXAMPLES } from '../src/save/examples.js';
import { toFile, fromFile } from '../src/save/storage.js';
import { findMeshes } from '../src/physics/gearTrain.js';
import { snapPart, snapDrawEnd } from '../src/parts/snap.js';
import { socketsOf } from '../src/parts/geometry.js';
import { partDef, faceHoles } from '../src/parts/partDefs.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);

const SETTINGS = { gravity: 10, friction: 0.6, motorTorque: 60, motorRpm: 30 };
const MAP = { groundHalfWidth: 200 };
const run = (sim, seconds) => { for (let t = 0; t < seconds; t += DT) sim.step(); };

/** Motor + 12T gear, meshed with a 24T gear + wheel on a rotating pin. */
function sliceBuild() {
  const b = emptyBuild();
  const motor = addPart(b, 'motor', 0, 4);
  const g12 = addPart(b, 'gear-12', 0, 4);          // r = 1.2, sits on the motor shaft
  const pin = addPart(b, 'pin-rotating', 3.6, 4);   // 1.2 + 2.4 = 3.6 away
  const g24 = addPart(b, 'gear-24', 3.6, 4);
  const wheel = addPart(b, 'wheel-m', 3.6, 4);      // same shaft as the 24T gear
  return { b, motor, g12, pin, g24, wheel };
}

console.log('Step 1 — smallest slice');

test('assembly: gear-24 and wheel share one body, motor gear on its own body', () => {
  const { b, g12, g24, wheel, motor } = sliceBuild();
  const asm = buildAssembly(b.parts);
  assert(asm.bodyOf(mainKey(g24.uid)) === asm.bodyOf(mainKey(wheel.uid)), 'wheel + 24T should be one rigid body');
  assert(asm.bodyOf(mainKey(g12.uid)) !== asm.bodyOf(mainKey(g24.uid)), 'gears should be separate bodies');
  assert(asm.bodyOf(mainKey(motor.uid)) === WORLD, 'lone motor housing should be bolted to the background');
  assert(asm.revolutes.length === 2, `expected 2 axle joints, got ${asm.revolutes.length}`);
  assert(asm.revolutes.some((r) => r.driverUid === motor.uid), 'one joint should be motor-driven');
});

test('gear train: gears mesh and ratio is -0.5 (12T → 24T)', () => {
  const { b, g24 } = sliceBuild();
  const asm = buildAssembly(b.parts);
  const train = solveGearTrain(b.parts, asm);
  assert(train.meshes.length === 1, `expected 1 mesh, got ${train.meshes.length}`);
  const drive = train.driveOf(asm.bodyOf(mainKey(g24.uid)));
  near(drive.ratio, -0.5, 1e-9, 'ratio');
  assert(!drive.jammed, 'should not be jammed');
});

test('physics: wheel turns at -15 RPM when motor runs at 30 RPM', () => {
  const { b, wheel, g12 } = sliceBuild();
  const sim = new Simulation(b, SETTINGS, MAP);
  run(sim, 2);
  const rIn = sim.readout(g12.uid), rOut = sim.readout(wheel.uid);
  near(rIn.rpm, 30, 0.5, 'motor gear RPM');
  near(rOut.rpm, -15, 0.5, 'wheel RPM');
  near(rOut.ratio, -0.5, 1e-9, 'readout ratio');
});

test('physics: a huge motor-torque requirement stalls instead of breaking', () => {
  const { b } = sliceBuild();
  const sim = new Simulation(b, { ...SETTINGS, motorTorque: 0.05, friction: 1.5 }, MAP);
  run(sim, 2);
  const tel = [...sim.telemetry.values()][0];
  assert(tel.stalled, `motor should be stalled (load ${tel.load.toFixed(2)}, speed ${radToRpm(tel.speed).toFixed(1)} rpm)`);
});


console.log('\nStep 2 — full gallery mechanics');

const driveRatio = (b, uid) => {
  const asm = buildAssembly(b.parts);
  return solveGearTrain(b.parts, asm).driveOf(asm.bodyOf(mainKey(uid)));
};

test('compound gear: 12T → (24|12) → 24T gives ratio +0.25', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 4); addPart(b, 'gear-12', 0, 4);
  addPart(b, 'pin-rotating', 3.6, 4); addPart(b, 'compound-24-12', 3.6, 4);
  addPart(b, 'pin-rotating', 3.6, 7.6); const out = addPart(b, 'gear-24', 3.6, 7.6);
  near(driveRatio(b, out.uid).ratio, 0.25, 1e-9, 'ratio');
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 2);
  near(sim.readout(out.uid).rpm, 7.5, 0.3, 'output RPM');
});

test('idler: 12T → 12T → 12T keeps direction (ratio +1)', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 4); addPart(b, 'gear-12', 0, 4);
  addPart(b, 'pin-rotating', 2.4, 4); addPart(b, 'gear-12', 2.4, 4);
  addPart(b, 'pin-rotating', 4.8, 4); const out = addPart(b, 'gear-12', 4.8, 4);
  near(driveRatio(b, out.uid).ratio, 1, 1e-9, 'ratio');
});

test('jam: three gears meshed in a triangle lock up, motor stalls', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 4); addPart(b, 'gear-12', 0, 4);
  addPart(b, 'pin-rotating', 2.4, 4); addPart(b, 'gear-12', 2.4, 4);
  const h = 2.4 * Math.sqrt(3) / 2;
  addPart(b, 'pin-rotating', 1.2, 4 + h); const g = addPart(b, 'gear-12', 1.2, 4 + h);
  assert(driveRatio(b, g.uid).jammed, 'should be jammed');
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1);
  assert([...sim.telemetry.values()][0].stalled, 'motor should stall');
  near(sim.readout(g.uid).rpm, 0, 0.5, 'jammed gear RPM');
});

test('fixed pin: a gear on a fixed pin locks the train', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 4); addPart(b, 'gear-12', 0, 4);
  addPart(b, 'pin-fixed', 3.6, 4); const g = addPart(b, 'gear-24', 3.6, 4);
  assert(driveRatio(b, g.uid).jammed, 'should be jammed');
});

/** Simple car: a 16-hole chassis, motor + wheel at the rear, free wheel at the front. */
function carBuild(geared = false) {
  const b = emptyBuild();
  const chassis = addPart(b, 'beam-16', 0, 1.0);
  addPart(b, 'wheel-m', 3.2, 1.0);              // front wheel spins freely on the beam hole
  if (!geared) {
    addPart(b, 'motor', -3.2, 1.0); addPart(b, 'wheel-m', -3.2, 1.0);
  } else {
    // Motor drives a 12T; the 24T + rear wheel share a beam hole.
    addPart(b, 'motor', 0.4, 1.0); addPart(b, 'gear-12', 0.4, 1.0);
    addPart(b, 'gear-24', -3.2, 1.0);            // 1.2 + 2.4 = 3.6 away from the motor
    addPart(b, 'wheel-m', -3.2, 1.0);
  }
  return { b, chassis };
}

test('car: motor on a beam rides along and drives the wheel', () => {
  const { b, chassis } = carBuild();
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 3);
  const t = sim.transformOf(chassis.uid);
  // Positive motor speed = counter-clockwise = rolls left.
  assert(t.x < -2, `car should have driven left, chassis x = ${t.x.toFixed(2)}`);
  assert(Math.abs(t.angle) < 0.3, 'car should stay upright');
});

test('geared car: 12T→24T halves the wheel speed vs motor', () => {
  const { b } = carBuild(true);
  const wheel = b.parts.filter((p) => p.type === 'wheel-m')[1];
  near(driveRatio(b, wheel.uid).ratio, -0.5, 1e-9, 'ratio');
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 2);
  near(sim.readout(wheel.uid).rpm, -15, 1, 'wheel RPM relative to chassis');
});

test('hinge: a beam hinged to a pinned beam swings under gravity', () => {
  const b = emptyBuild();
  addPart(b, 'beam-10', 0, 6);                 // holes from -2 to 2
  addPart(b, 'pin-fixed', -2, 6);
  addPart(b, 'hinge', 2, 6);
  const arm = addPart(b, 'beam-10', 4, 6);     // left end on the hinge
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 0.6);
  const t = sim.transformOf(arm.uid);
  assert(Math.abs(t.angle) > 0.3, `arm should have swung, angle ${t.angle.toFixed(2)}`);
  near(Math.hypot(t.x - 2, t.y - 6), 2, 0.05, 'arm stays on the hinge');
});

/** A 9.6-long arm on an axle. Gravity torque ≈ 1.6 kg × 10 × 4.8 m ≈ 77 N·m. */
function leverBuild(geared) {
  const b = emptyBuild();
  if (!geared) {
    addPart(b, 'motor', 0, 6); addPart(b, 'axle', 0, 6);
    const arm = addPart(b, 'beam-24', 4.8, 6);
    return { b, arm, pivot: { x: 0, y: 6 } };
  }
  addPart(b, 'motor', -3.6, 6); addPart(b, 'gear-12', -3.6, 6);
  addPart(b, 'pin-rotating', 0, 6); addPart(b, 'gear-24', 0, 6); addPart(b, 'axle', 0, 6);
  const arm = addPart(b, 'beam-24', 4.8, 6);
  return { b, arm, pivot: { x: 0, y: 6 } };
}

test('torque: a 60 N·m motor cannot lift a 77 N·m arm directly (stalls, nothing breaks)', () => {
  const { b, arm } = leverBuild(false);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 3);
  const tel = [...sim.telemetry.values()][0];
  assert(tel.stalled, `motor should stall (load ${tel.load.toFixed(2)})`);
  assert(sim.transformOf(arm.uid).angle < 0, 'arm should sag, not rise');
});

test('torque: a 2:1 reduction doubles torque to 120 N·m and lifts the arm', () => {
  const { b, arm } = leverBuild(true);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 3);
  const a = sim.transformOf(arm.uid).angle;
  // Motor turns CCW, 24T turns CW → arm swings DOWN... so reverse the motor to lift.
  assert(Math.abs(a) > 0.5, `arm should move a lot, angle ${a.toFixed(2)}`);
  const { b: b2, arm: arm2 } = leverBuild(true);
  b2.parts[0].props.reverse = true;
  const sim2 = new Simulation(b2, SETTINGS, MAP); run(sim2, 2);
  const a2 = sim2.transformOf(arm2.uid).angle;
  assert(a2 > 0.5, `reversed motor should lift the arm, angle ${a2.toFixed(2)}`);
});

test('hand crank: dragging the handle turns the gear train', () => {
  const b = emptyBuild();
  const crank = addPart(b, 'crank', 0, 4); addPart(b, 'gear-12', 0, 4);
  addPart(b, 'pin-rotating', 3.6, 4); const out = addPart(b, 'gear-24', 3.6, 4);
  const sim = new Simulation(b, SETTINGS, MAP);
  let ang = 0;
  sim.grabCrank(crank.uid, { x: 1, y: 4 });
  for (let i = 0; i < 240; i++) {
    ang += 2 * DT; // the "hand" moves at 2 rad/s
    sim.dragTo({ x: Math.cos(ang), y: 4 + Math.sin(ang) });
    sim.step();
  }
  near(sim.readout(out.uid).rpm, radToRpm(-1), 3, 'output follows half the hand speed, reversed');
});


console.log('\nStep 5 — save/load + examples');

test('file export/import round-trips a build exactly', () => {
  const { b } = sliceBuild();
  b.parts[0].props.reverse = true;
  const text = JSON.stringify(toFile(b, 'test'));
  const { build, dropped, name } = fromFile(text);
  assert(dropped === 0 && name === 'test', 'metadata');
  assert(JSON.stringify(build.parts) === JSON.stringify(b.parts), 'parts should match');
});

test('import skips unknown part types instead of crashing', () => {
  const { build, dropped } = fromFile({ build: { parts: [{ uid: 1, type: 'gear-12', x: 0, y: 0 }, { uid: 2, type: 'flux-capacitor', x: 1, y: 1 }] } });
  assert(build.parts.length === 1 && dropped === 1, 'one kept, one dropped');
  let threw = false; try { fromFile('{"nope":1}'); } catch { threw = true; }
  assert(threw, 'garbage should throw a friendly error');
});

test('gear-train example: chain ratio to the last wheel is -0.375', () => {
  const b = EXAMPLES[0].build();
  const wheel = b.parts.find((p) => p.type === 'wheel-s');
  // 12→24(-0.5), 12→24(+0.25), 24→8(-0.75), 8→16(+0.375), 16→16(-0.375)
  near(driveRatio(b, wheel.uid).ratio, -0.375, 1e-9, 'ratio');
});

test('example "Little car": drives right and gets over the ramp', () => {
  const b = EXAMPLES[1].build();
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 10);
  const t = sim.transformOf(b.parts[0].uid);
  assert(t.x > 16, `chassis should be past the ramp, x = ${t.x.toFixed(1)}`);
});

for (const ex of EXAMPLES) {
  test(`example "${ex.name}" builds and runs without errors`, () => {
    const b = ex.build();
    const asm = buildAssembly(b.parts);
    assert(asm.warnings.length === 0, asm.warnings.join('; '));
    const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1);
    for (const p of b.parts) { const t = sim.transformOf(p.uid); assert(Number.isFinite(t.x) && Number.isFinite(t.y), `${p.type} NaN`); }
  });
}

test('example "Torque test": direct arm stalls, geared arm lifts', () => {
  const b = EXAMPLES[2].build();
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 2);
  assert(sim.telemetry.get(b.parts[0].uid).stalled, 'direct motor stalls');
  assert(!sim.telemetry.get(b.parts[3].uid).stalled, 'geared motor keeps going');
  assert(sim.transformOf(b.parts[8].uid).angle > 0.5, 'geared arm rose');
});


console.log('\nSnapping');

test('snap: a gear dropped near another slides to exactly r1 + r2 and meshes', () => {
  const b = emptyBuild(); addPart(b, 'gear-12', 0, 0);
  const s = snapPart(b.parts, 'gear-24', 3.3, 0.4, 0);
  near(Math.hypot(s.x, s.y), 3.6, 1e-9, 'centre distance');
  assert(s.hint.includes('meshes'), 'hint mentions meshing');
});

test('snap: a gear dropped overlapping another is pushed out to mesh', () => {
  const b = emptyBuild(); addPart(b, 'gear-8', 0, 0);
  const s = snapPart(b.parts, 'gear-24', 2.4, 0.4, 0);
  near(Math.hypot(s.x, s.y), 3.2, 1e-9, 'centre distance');
});

test('snap: a gear near a motor snaps onto its shaft', () => {
  const b = emptyBuild(); addPart(b, 'motor', 2, 2);
  const s = snapPart(b.parts, 'gear-16', 2.3, 1.8, 0);
  assert(s.x === 2 && s.y === 2 && s.hint === 'on motor shaft', JSON.stringify(s));
});

test('snap: a beam snaps its nearest hole onto a pin', () => {
  const b = emptyBuild(); addPart(b, 'pin-rotating', 1.03, 1.02);
  const s = snapPart(b.parts, 'beam-10', 2.9, 1.1, 0);   // holes every 0.4 from x-2..x+2
  const holes = [-2, -1.6, -1.2, -0.8, -0.4, 0, 0.4, 0.8, 1.2, 1.6, 2].map((h) => s.x + h);
  assert(holes.some((h) => Math.abs(h - 1.03) < 1e-9) && Math.abs(s.y - 1.02) < 1e-9, JSON.stringify(s));
});

test('snap: teeth of a meshed gear interleave (tooth faces gap)', () => {
  const b = emptyBuild(); addPart(b, 'gear-12', 0, 0, 0.3);
  const s = snapPart(b.parts, 'gear-12', 2.4, 0, 0);
  // Tooth of A nearest the contact (angle 0): fA = frac((0 - 0.3) * 12 / 2π)
  const fA = (((0 - 0.3) * 12) / (2 * Math.PI) % 1 + 1) % 1;
  const fB = ((((Math.PI - s.angle) * 12) / (2 * Math.PI)) % 1 + 1) % 1;
  near((fA + fB) % 1, 0.5, 1e-9, 'phase sum');
});


console.log('\nNew parts — drawn beams, chains, crank pins, sliders, springs, ropes');

test('drawn beam: any length, a hole at both ends, mass scales with length', () => {
  const b = emptyBuild();
  const beam = addPart(b, 'beam', 0, 0, 0, { length: 3.0 });
  const holes = socketsOf(beam);
  near(holes[0].x, -1.5, 1e-9, 'left end hole');
  near(holes[holes.length - 1].x, 1.5, 1e-9, 'right end hole');
  near(partDef(beam).mass, 0.17 * 3, 1e-9, 'mass');
});

test('draw snapping: the far end of a beam lands exactly on a pin', () => {
  const b = emptyBuild(); addPart(b, 'pin-rotating', 3.1, 2.2);
  const e = snapDrawEnd(b.parts, 'beam', { x: 0, y: 0 }, { x: 3, y: 2.3 });
  assert(e.attached && e.x === 3.1 && e.y === 2.2, JSON.stringify(e));
});

/** Two sprockets on pins linked by a chain. */
function chainBuild(nA = 'sprocket-10', nB = 'sprocket-24') {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 4); const a = addPart(b, nA, 0, 4);
  addPart(b, 'pin-rotating', 6, 4); const c = addPart(b, nB, 6, 4);
  addPart(b, 'chain', 3, 4, 0, { a: a.uid, b: c.uid });
  return { b, a, c };
}

test('chain: 10T → 24T turns the same way at 10/24 speed', () => {
  const { b, c } = chainBuild();
  near(driveRatio(b, c.uid).ratio, 10 / 24, 1e-9, 'ratio');
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 2);
  near(sim.readout(c.uid).rpm, 30 * 10 / 24, 0.5, 'output RPM');
});

test('chain: a chain fighting a gear mesh jams', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 4); const a = addPart(b, 'gear-12', 0, 4);
  addPart(b, 'pin-rotating', 2.4, 4); const g = addPart(b, 'gear-12', 2.4, 4);
  addPart(b, 'chain', 1.2, 4, 0, { a: a.uid, b: g.uid });
  assert(driveRatio(b, g.uid).jammed, 'mesh flips direction, chain does not: jam');
});

test('chain: a deleted sprocket leaves the chain harmless', () => {
  const { b, c } = chainBuild();
  b.parts = b.parts.filter((p) => p.uid !== c.uid);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 0.2);
});

/** A locomotive frame: two drive wheels on a beam, linked by a side rod on their crank pins. */
function locoBuild() {
  const b = emptyBuild();
  const frame = addPart(b, 'beam', 0, 0.8, 0, { length: 4 });
  addPart(b, 'motor', -2, 0.8, 0, { reverse: true });
  // Crank pins 0.6 right of each centre: the rod runs right along the
  // frame, but its holes fall between the frame's, so it stays free.
  const w1 = addPart(b, 'drive-wheel-s', -2, 0.8);
  const w2 = addPart(b, 'drive-wheel-s', 2, 0.8);
  const rod = addPart(b, 'beam', 0.6, 0.8, 0, { length: 4 });
  return { b, frame, w1, w2, rod };
}

test('crank pins: the side rod pivots on both wheels (no welds, no warnings)', () => {
  const { b, w1, w2, rod } = locoBuild();
  const asm = buildAssembly(b.parts);
  assert(asm.warnings.length === 0, asm.warnings.join('; '));
  const pivots = asm.revolutes.filter((r) => r.pivot);
  assert(pivots.length === 2, `expected 2 crank-pin pivots, got ${pivots.length}`);
  assert(asm.bodyOf(mainKey(rod.uid)) !== asm.bodyOf(mainKey(w1.uid)), 'rod is its own body');
  assert(asm.axleOf(asm.bodyOf(mainKey(w2.uid))), 'the front wheel still spins on its centre');
});

test('crank pins: a side-rod loco drives along and the unpowered wheel keeps up', () => {
  const { b, frame, w1, w2 } = locoBuild();
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 4);
  const t = sim.transformOf(frame.uid);
  assert(t.x > 2, `loco should drive right, x = ${t.x.toFixed(2)}`);
  near(sim.readout(w2.uid).rpm, sim.readout(w1.uid).rpm, 2, 'both wheels turn together');
});

test('slider: a crank pin drives a slider block back and forth (piston)', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 4); addPart(b, 'drive-wheel-l', 0, 4);    // pin at (1, 4)
  const sl = addPart(b, 'slider', 5, 4, 0, { length: 6.4 });        // block at (5, 4), rail ends 1.8 & 8.2
  addPart(b, 'beam', 3, 4, 0, { length: 4 });                       // rod from pin to block: a rod hole sits on the rail's end hole
  const asm = buildAssembly(b.parts);
  assert(asm.prismatics.length === 1, 'one prismatic joint');
  assert(asm.bodyOf(mainKey(sl.uid)) === WORLD, 'a free rail is bolted down');
  const sim = new Simulation(b, SETTINGS, MAP);
  let lo = Infinity, hi = -Infinity;
  for (let t = 0; t < 3; t += DT) { sim.step(); const x = sim.transformOf(sl.uid, 'hub').x; lo = Math.min(lo, x); hi = Math.max(hi, x); }
  near(hi - lo, 2.0, 0.15, 'piston stroke = 2 × crank radius');
});

test('spring: a crate hanging on a spring bobs and settles below its rest length', () => {
  const b = emptyBuild();
  addPart(b, 'spring', 0, 7, -Math.PI / 2, { length: 2 });          // from (0,8) down to (0,6)
  const crate = addPart(b, 'crate', 0, 5.6);                        // top edge at y = 6.2
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 4);
  const y = sim.transformOf(crate.uid).y;
  assert(y < 5.6 && y > 3, `crate should sag a bit on the spring, y = ${y.toFixed(2)}`);
  const ends = sim.linkEnds(b.parts[0].uid);
  near(ends[0].y, 8, 1e-6, 'top end anchored in the air');
});

test('rope: a crate hangs from a pinned beam and never drops further than the rope', () => {
  const b = emptyBuild();
  addPart(b, 'beam', 0, 8, 0, { length: 4 }); addPart(b, 'pin-fixed', -2, 8); addPart(b, 'pin-fixed', 2, 8);
  addPart(b, 'rope', 0, 6.5, -Math.PI / 2, { length: 3 });          // (0,8) to (0,5)
  const crate = addPart(b, 'crate', 0, 4.8);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 3);
  const y = sim.transformOf(crate.uid).y;
  near(y, 4.8, 0.1, 'crate hangs at the rope length');
});

test('arrow-key motor: holds still until you press →, then drives right', () => {
  const { b, chassis } = carBuild();
  b.parts.find((p) => p.type === 'motor').props.keys = true;
  const sim = new Simulation(b, SETTINGS, MAP);
  assert(sim.hasKeyMotors, 'detects key motors');
  run(sim, 1);
  near(sim.transformOf(chassis.uid).x, 0, 0.2, 'no keys = parked');
  sim.setThrottle(1); run(sim, 2);
  assert(sim.transformOf(chassis.uid).x > 1.5, `→ drives right, x = ${sim.transformOf(chassis.uid).x.toFixed(2)}`);
});

test('track: wheels roll on drawn track laid above the ground', () => {
  const b = emptyBuild();
  addPart(b, 'track', 0, 3, 0, { length: 12 });
  const ball = addPart(b, 'ball-s', 0, 4);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1);
  near(sim.transformOf(ball.uid).y, 3.15 + 0.5, 0.05, 'ball rests on the track');
});


console.log('\nBuild-a-Boat tools — scale, screwdriver properties, wires, double mesh');

test('double mesh: a gear dropped between two gears meshes with both at once', () => {
  const b = emptyBuild();
  addPart(b, 'gear-12', 0, 0); addPart(b, 'gear-12', 4, 0);      // 4 apart: a 12T can't span it, a 16T+ can
  const s = snapPart(b.parts, 'gear-16', 2, 0.9, 0);
  near(Math.hypot(s.x - 0, s.y - 0), 1.2 + 1.6, 1e-9, 'meshes the left gear');
  near(Math.hypot(s.x - 4, s.y - 0), 1.2 + 1.6, 1e-9, 'meshes the right gear');
  assert(s.hint.includes('+'), `hint names both gears: ${s.hint}`);
  addPart(b, 'pin-rotating', 0, 0); addPart(b, 'pin-rotating', 4, 0); addPart(b, 'pin-rotating', s.x, s.y);
  const mid = addPart(b, 'gear-16', s.x, s.y, s.angle);
  const right = b.parts[1];
  b.parts[0].type = 'gear-12'; addPart(b, 'motor', 0, 0);
  near(driveRatio(b, right.uid).ratio, 1, 1e-9, 'idler passes the motor speed straight through');
  assert(findMeshes(b.parts).filter((m) => m.a.uid === mid.uid || m.b.uid === mid.uid).length === 2, 'two meshes');
});

test('double mesh: says when the gear is too small to reach both', () => {
  const b = emptyBuild();
  addPart(b, 'gear-12', 0, 0); addPart(b, 'gear-12', 6, 0);
  const s = snapPart(b.parts, 'gear-12', 2.2, 0.3, 0);
  assert(s.hint.includes('too small'), s.hint);
});

test('scale: a gear scaled from 12T to 24T meshes and gears down like a 24T', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 4); addPart(b, 'gear-12', 0, 4);
  addPart(b, 'pin-rotating', 3.6, 4); const g = addPart(b, 'gear-12', 3.6, 4, 0, { teeth: 24 });
  near(driveRatio(b, g.uid).ratio, -0.5, 1e-9, 'ratio');
  near(partDef(g).mass, 2.4, 1e-9, 'mass grows with area');
});

test('scale: a bigger wheel rolls a car further per turn', () => {
  const dist = (r) => {
    const { b, chassis } = carBuild();
    for (const p of b.parts) { p.y = r; if (p.type === 'wheel-m') p.props.radius = r; } // axles at wheel height
    const sim = new Simulation(b, SETTINGS, MAP); run(sim, 3);
    return Math.abs(sim.transformOf(chassis.uid).x);
  };
  assert(dist(1.5) > dist(1.0) * 1.15, 'bigger wheels go further');
});

test('screwdriver: an anchored beam stays put in mid-air', () => {
  const b = emptyBuild();
  const beam = addPart(b, 'beam', 0, 6, 0, { length: 4, anchored: true });
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1);
  near(sim.transformOf(beam.uid).y, 6, 1e-6, 'did not fall');
});

test('screwdriver: an anchored crate is a wall a ball bounces off', () => {
  const b = emptyBuild();
  const crate = addPart(b, 'crate', 0, 3, 0, { anchored: true });
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1);
  near(sim.transformOf(crate.uid).y, 3, 1e-6, 'crate hangs in the air');
});

test('screwdriver: collisions "none" falls through the ground, "all" lands on a beam', () => {
  const b = emptyBuild();
  const ghost = addPart(b, 'wheel-m', 0, 3, 0, { collide: 'none' });
  addPart(b, 'beam', 5, 2, 0, { length: 4, anchored: true });
  const solid = addPart(b, 'wheel-s', 5, 4, 0, { collide: 'all' });
  const normal = addPart(b, 'wheel-s', 6, 4);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1.5);
  assert(sim.transformOf(ghost.uid).y < -1, 'ghost wheel fell through the ground');
  near(sim.transformOf(solid.uid).y, 2 + 0.22 + 0.6, 0.06, '"all" wheel rests on the beam');
  assert(sim.transformOf(normal.uid).y < 1, 'normal wheel passes through the beam to the ground');
});

/** A motor on a pin with a gear, wired to a control. */
function wiredBuild(ctlType, ctlProps = {}) {
  const b = emptyBuild();
  const motor = addPart(b, 'motor', 0, 4); const g = addPart(b, 'gear-12', 0, 4);
  const ctl = addPart(b, ctlType, 4, 4, 0, ctlProps);
  addPart(b, 'wire', 2, 4, 0, { a: ctl.uid, b: motor.uid });
  return { b, motor, g, ctl };
}

test('wire: a switch turns its motor on and off', () => {
  const { b, g, ctl } = wiredBuild('switch');
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 0.5);
  near(sim.readout(g.uid).rpm, 0, 0.5, 'off at start');
  sim.toggleSwitch(ctl.uid); run(sim, 1);
  near(sim.readout(g.uid).rpm, 30, 0.5, 'on');
  sim.toggleSwitch(ctl.uid); run(sim, 1);
  near(sim.readout(g.uid).rpm, 0, 0.5, 'off again (brakes)');
});

test('wire: a key set to Reverse runs the motor backwards while held', () => {
  const { b, g, ctl } = wiredBuild('key-button', { key: 'a', reverse: true });
  const sim = new Simulation(b, SETTINGS, MAP);
  assert(sim.keyControls('a').includes(ctl.uid), 'bound to A');
  for (const uid of sim.keyControls('a')) sim.setSignal(uid, true);
  run(sim, 1);
  near(sim.readout(g.uid).rpm, -30, 0.5, 'reverse while held');
});

test('controls ride on the part under them', () => {
  const b = emptyBuild();
  const beam = addPart(b, 'beam', 0, 3, 0, { length: 4 });
  const sw = addPart(b, 'switch', 1.2, 3);
  const asm = buildAssembly(b.parts);
  assert(asm.bodyOf(mainKey(sw.uid)) === asm.bodyOf(mainKey(beam.uid)), 'switch is part of the beam body');
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1);
  assert(sim.transformOf(sw.uid).y < 1, 'switch fell with the beam');
});


console.log('\nTwo-key control + camera follow');

test('motor keys: D turns it clockwise (car goes right), A counter-clockwise (left)', () => {
  const { b, chassis } = carBuild();
  Object.assign(b.parts.find((p) => p.type === 'motor').props, { keyCW: 'd', keyCCW: 'a' });
  const sim = new Simulation(b, SETTINGS, MAP);
  assert(sim.boundKeys.has('d') && sim.boundKeys.has('a'), 'both keys bound');
  run(sim, 0.5);
  near(sim.transformOf(chassis.uid).x, 0, 0.2, 'parked with no keys');
  sim.setKeys(['d']); run(sim, 2);
  const x1 = sim.transformOf(chassis.uid).x;
  assert(x1 > 1.5, `D drives right, x = ${x1.toFixed(2)}`);
  sim.setKeys(['a']); run(sim, 3);
  assert(sim.transformOf(chassis.uid).x < x1 - 1, 'A drives back left');
});

test('Key control: one Key wired to a motor gives both directions', () => {
  const { b, g, ctl } = wiredBuild('key-button', { keyCW: 'e', keyCCW: 'q' });
  const sim = new Simulation(b, SETTINGS, MAP);
  sim.setKeys(['q']); run(sim, 1);
  near(sim.readout(g.uid).rpm, 30, 0.5, 'Q: counter-clockwise');
  sim.setKeys(['e']); run(sim, 1);
  near(sim.readout(g.uid).rpm, -30, 0.5, 'E: clockwise');
  sim.setKeys([]); run(sim, 1);
  near(sim.readout(g.uid).rpm, 0, 0.5, 'neither: brakes');
  assert(sim.keyControls('q').includes(ctl.uid), 'keyControls finds it');
});

test('follow: the camera picks the car chassis, not a gear spinning on a pin', () => {
  const { b, chassis } = carBuild();
  addPart(b, 'motor', 10, 6); addPart(b, 'gear-24', 10, 6);   // a big static machine elsewhere
  const sim = new Simulation(b, SETTINGS, MAP);
  assert(sim.autoFollowTarget() === chassis.uid, `picked ${sim.autoFollowTarget()}`);
  const s2 = new Simulation(sliceBuild().b, SETTINGS, MAP);
  assert(s2.autoFollowTarget() === null, 'nothing free-moving: no follow');
});


console.log('\nEndless map, loose ropes, bolting onto gears');

test('endless map: the ground is still there 2 km away', () => {
  const b = emptyBuild();
  const ball = addPart(b, 'ball-s', 2000, 3);
  const sim = new Simulation(b, SETTINGS, { groundHalfWidth: Infinity }); run(sim, 2);
  near(sim.transformOf(ball.uid).y, 0.5, 0.05, 'ball rests on the ground');
});

test('gear face holes: a beam bolted on a driven gear swings round with it', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 6); const g = addPart(b, 'gear-24', 0, 6);
  const ring = faceHoles(partDef(g))[0][0];                       // 1.4 for a 24T
  const arm = addPart(b, 'beam', ring + 1.6, 6, 0, { length: 3.2 }); // left end on the right-hand hole
  const asm = buildAssembly(b.parts);
  assert(asm.bodyOf(mainKey(arm.uid)) === asm.bodyOf(mainKey(g.uid)), 'arm is bolted to the gear');
  assert(asm.warnings.length === 0, asm.warnings.join('; '));
  const sim = new Simulation(b, { ...SETTINGS, motorTorque: 300 }, MAP); run(sim, 1);
  const t = sim.transformOf(arm.uid);
  near(Math.hypot(t.x, t.y - 6), ring + 1.6, 0.05, 'arm stays the same distance from the gear centre');
  assert(Math.abs(t.angle) > 0.5, `arm turned with the gear (angle ${t.angle.toFixed(2)})`);
});

test('gear face holes: a hinge there makes a crank (the beam pivots)', () => {
  const b = emptyBuild();
  addPart(b, 'pin-fixed', 0, 6); const g = addPart(b, 'gear-24', 0, 6, 0, { anchored: true });
  const ring = faceHoles(partDef(g))[0][0];
  addPart(b, 'hinge', ring, 6);
  const arm = addPart(b, 'beam', ring + 1.6, 6, 0, { length: 3.2 });
  const asm = buildAssembly(b.parts);
  assert(asm.bodyOf(mainKey(arm.uid)) !== asm.bodyOf(mainKey(g.uid)), 'not bolted');
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 0.6);
  assert(sim.transformOf(arm.uid).angle < -0.3, 'arm swings down on the hinge');
});

test('gear face holes: a beam through the gear centre doesn\'t steal its axle', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 6); const g = addPart(b, 'gear-24', 0, 6);
  const ring = faceHoles(partDef(g))[0][0];
  addPart(b, 'beam', 0, 6, 0, { length: ring * 2 });                // hole to hole, across the centre
  const asm = buildAssembly(b.parts);
  assert(asm.warnings.length === 0, asm.warnings.join('; '));
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1);
  near(sim.readout(g.uid).rpm, 30, 1, 'gear still driven');
});

test('gear face holes: grid beams on a gearbox don\'t bolt to gears by accident', () => {
  const { b } = carBuild(true);                                     // 24T + 12T sitting on the chassis beam
  const asm = buildAssembly(b.parts);
  const g24 = b.parts.find((p) => p.type === 'gear-24');
  assert(asm.axleOf(asm.bodyOf(mainKey(g24.uid))), '24T still spins on the chassis');
});

test('loose rope: unanchored, the free end hangs on a hook below its top', () => {
  const b = emptyBuild();
  addPart(b, 'beam', 0, 8, 0, { length: 4, anchored: true });
  const rope = addPart(b, 'rope', 3, 8, 0, { length: 2, pinEnds: false }); // (2,8) on the beam → (4,8) in the air
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 3);
  assert(sim.hookEnds(rope.uid).length === 1, 'one hooked end');
  const [top, end] = sim.linkEnds(rope.uid);
  near(Math.hypot(end.x - top.x, end.y - top.y), 2, 0.08, 'rope pulled taut by the hook');
  assert(end.y < 7, `hook swung down below the beam (y ${end.y.toFixed(2)})`);
  near(top.y, 8, 1e-6, 'top end stays on the beam');
});


console.log('\nBolt');

test('bolt: a beam bolted anywhere on a driven gear turns with it', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 6); const g = addPart(b, 'gear-32', 0, 6);
  const arm = addPart(b, 'beam', 2.1, 6.3, 0, { length: 4 });        // not on any hole
  addPart(b, 'bolt', 1.0, 6.3);                                      // where the beam overlaps the gear
  const asm = buildAssembly(b.parts);
  assert(asm.bodyOf(mainKey(arm.uid)) === asm.bodyOf(mainKey(g.uid)), 'bolted into one piece');
  assert(asm.onRotor.has(arm.uid), 'drawn on top of the gear');
  const sim = new Simulation(b, { ...SETTINGS, motorTorque: 300 }, MAP); run(sim, 1);
  assert(Math.abs(sim.transformOf(arm.uid).angle) > 0.5, 'arm turned with the gear');
});

test('bolt: a beam through the gear centre, bolted on, doesn\'t steal the gear\'s axle', () => {
  const b = emptyBuild();
  addPart(b, 'motor', 0, 6); const g = addPart(b, 'gear-24', 0, 6);
  addPart(b, 'beam', 0, 6, 0, { length: 4 });                         // centre hole on the motor shaft
  addPart(b, 'bolt', 1.2, 6);
  const asm = buildAssembly(b.parts);
  assert(asm.warnings.length === 0, asm.warnings.join('; '));
  const sim = new Simulation(b, { ...SETTINGS, motorTorque: 300 }, MAP); run(sim, 1);
  near(sim.readout(g.uid).rpm, 30, 1.5, 'gear still driven, beam along for the ride');
});

test('bolt: a beam bolted to a crate carries it', () => {
  const b = emptyBuild();
  addPart(b, 'beam', 0, 3, 0, { length: 4 }); addPart(b, 'pin-rotating', -2, 3);
  const crate = addPart(b, 'crate', 1.6, 3); addPart(b, 'bolt', 1.6, 3);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 0.8);
  const t = sim.transformOf(crate.uid);
  near(Math.hypot(t.x + 2, t.y - 3), 3.6, 0.05, 'crate swings on the beam, stuck at the same spot');
});


console.log('\nGadgets: piston, thruster, magnet, cannon, balloon, conveyor, bounce pad, water, plate');

test('piston: on its own it pushes out and pulls back again', () => {
  const b = emptyBuild();
  const pis = addPart(b, 'piston', 0, 2, Math.PI / 2, { length: 2 });   // standing up, base free (fixed to ground)
  const sim = new Simulation(b, SETTINGS, MAP);
  let hi = -Infinity, lo = Infinity;
  for (let t = 0; t < 3; t += DT) { sim.step(); const y = sim.transformOf(pis.uid, 'hub').y; hi = Math.max(hi, y); if (t > 1) lo = Math.min(lo, y); }
  near(hi - 2, 1.8, 0.1, 'pushed out ~90% of its length');
  assert(lo < 2.3, `pulled back in again (lowest after 1 s: ${lo.toFixed(2)})`);
});

test('piston: lifts a platform with keys and holds it when you let go', () => {
  const b = emptyBuild();
  const pis = addPart(b, 'piston', 0, 1.2, Math.PI / 2, { length: 2.4, keyPlus: 'w', keyMinus: 's' }); // (0,0) to (0,2.4)
  const deck = addPart(b, 'beam', 0, 2.4, 0, { length: 4 });              // top pivot under the deck
  addPart(b, 'crate', 1.2, 3.2);
  const sim = new Simulation(b, SETTINGS, MAP);
  assert(sim.boundKeys.has('w'), 'W bound');
  run(sim, 0.5);
  const y0 = sim.transformOf(deck.uid).y;
  sim.setKeys(['w']); run(sim, 0.6);
  sim.setKeys([]); run(sim, 0.5);
  const y1 = sim.transformOf(deck.uid).y;
  assert(y1 > y0 + 1, `deck rose (${y0.toFixed(2)} → ${y1.toFixed(2)})`);
  run(sim, 1);
  near(sim.transformOf(deck.uid).y, y1, 0.1, 'holds still with no key');
});

test('thruster: pushes a car along', () => {
  const { b, chassis } = carBuild();
  b.parts = b.parts.filter((p) => p.type !== 'motor');
  addPart(b, 'thruster', 0, 1.0);                                  // on the chassis, pointing right
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 2);
  assert(sim.transformOf(chassis.uid).x > 2, `car pushed right, x = ${sim.transformOf(chassis.uid).x.toFixed(2)}`);
});

test('magnet: pulls a crate up off the ground, off when its switch is off', () => {
  const build = (on) => {
    const b = emptyBuild();
    addPart(b, 'beam', 0, 2.6, 0, { length: 4, anchored: true });
    const m = addPart(b, 'magnet', 0, 2.6);
    const sw = addPart(b, 'switch', 3, 5, 0, { on });
    addPart(b, 'wire', 1, 4, 0, { a: sw.uid, b: m.uid });
    const crate = addPart(b, 'crate', 0, 0.6);
    const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1.5);
    return sim.transformOf(crate.uid).y;
  };
  assert(build(true) > 1.2, 'switched on: crate pulled up to the magnet');
  near(build(false), 0.6, 0.05, 'switched off: crate stays down');
});

test('cannon: fires balls by itself, and kicks back', () => {
  const b = emptyBuild();
  addPart(b, 'cannon', 0, 3, 0.3);                                 // on nothing: fixed to the background
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 2);
  assert(sim.shotsNow.length >= 1, 'fired');
  const shot = sim.shotsNow[0];
  assert(shot.x > 3, `ball flew forward, x = ${shot.x.toFixed(2)}`);
});

test('balloon: floats up, and a rope holds it down to a crate', () => {
  const b = emptyBuild();
  const free = addPart(b, 'balloon', 0, 3);
  const tied = addPart(b, 'balloon', 6, 4);
  addPart(b, 'crate-heavy', 6, 0.8);
  addPart(b, 'rope', 6, 2.5, -Math.PI / 2, { length: 2 });         // balloon (6,3.5) to crate top (6,1.5)
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 3);
  assert(sim.transformOf(free.uid).y > 6, 'free balloon rises');
  assert(sim.transformOf(tied.uid).y < 4.6, 'tied balloon held by the rope');
});

test('conveyor: carries a crate along the way it was drawn', () => {
  const b = emptyBuild();
  addPart(b, 'conveyor', 0, 0.25, 0, { length: 10 });
  const crate = addPart(b, 'crate', -3, 1.1);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1.5);
  assert(sim.transformOf(crate.uid).x > -1, `crate moved right, x = ${sim.transformOf(crate.uid).x.toFixed(2)}`);
  const b2 = emptyBuild();
  addPart(b2, 'conveyor', 0, 0.25, Math.PI, { length: 10 });        // drawn right-to-left
  const c2 = addPart(b2, 'crate', 3, 1.1);
  const s2 = new Simulation(b2, SETTINGS, MAP); run(s2, 1.5);
  assert(s2.transformOf(c2.uid).x < 1, `reversed belt moves it left, x = ${s2.transformOf(c2.uid).x.toFixed(2)}`);
});

test('bounce pad: a dropped ball bounces back up', () => {
  const b = emptyBuild();
  addPart(b, 'bounce-pad', 0, 0.25);
  const ball = addPart(b, 'ball-s', 0, 5);
  const sim = new Simulation(b, SETTINGS, MAP);
  let landed = false, high = 0;
  for (let t = 0; t < 2.5; t += DT) { sim.step(); const y = sim.transformOf(ball.uid).y; if (y < 1.2) landed = true; if (landed) high = Math.max(high, y); }
  assert(high > 3.5, `bounced high (${high.toFixed(2)})`);
});

test('water: a plate boat floats, a heavy crate sinks', () => {
  const b = emptyBuild();
  addPart(b, 'water', 0, 1.5, 0, { width: 20, height: 3 });         // surface at y = 3
  const boat = addPart(b, 'plate', -4, 4, 0, { length: 4 });
  const crate = addPart(b, 'crate-heavy', 4, 4);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 4);
  const by = sim.transformOf(boat.uid).y;
  assert(by > 2.4 && by < 3.6, `boat floats at the surface (y ${by.toFixed(2)})`);
  near(sim.transformOf(crate.uid).y, 0.8, 0.1, 'heavy crate on the bottom');
});

test('plate: has holes like a beam and collides with the ground', () => {
  const b = emptyBuild();
  const pl = addPart(b, 'plate', 0, 3, 0, { length: 4 });
  assert(socketsOf(pl).length === 11, `11 holes, got ${socketsOf(pl).length}`);
  const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1.5);
  near(sim.transformOf(pl.uid).y, 0.6, 0.05, 'resting on the ground');
});

test('wrench: a Key control can drive a piston too', () => {
  const b = emptyBuild();
  const pis = addPart(b, 'piston', 0, 2, Math.PI / 2, { length: 2 });
  const key = addPart(b, 'key-button', 3, 3, 0, { keyCCW: 'w', keyCW: 's' });
  addPart(b, 'wire', 1, 3, 0, { a: key.uid, b: pis.uid });
  const sim = new Simulation(b, SETTINGS, MAP);
  run(sim, 0.5);
  near(sim.transformOf(pis.uid, 'hub').y, 2, 0.05, 'holds until told');
  sim.setKeys(['w']); run(sim, 0.5);
  assert(sim.transformOf(pis.uid, 'hub').y > 2.8, 'W pushes it out');
});


test('piston: two base joints on one beam stop it swinging', () => {
  // A beam bolted down (holes at x = -3.2 .. 0); the piston lies along it.
  const angleAfter = (bottomX) => {
    const b = emptyBuild();
    addPart(b, 'beam', -1.6, 3, 0, { length: 3.2 }); addPart(b, 'pin-fixed', -3.2, 3);
    const pis = addPart(b, 'piston', bottomX + 1.2, 3, 0, { length: 2.4, keyPlus: 'w' }); // second joint 0.8 up
    const sim = new Simulation(b, SETTINGS, MAP); run(sim, 1);
    return sim.transformOf(pis.uid).angle;
  };
  near(angleAfter(-0.8), 0, 0.02, 'both joints on the beam: stays level');
  assert(angleAfter(0) < -0.3, 'only the bottom joint on the beam: it swings down');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
