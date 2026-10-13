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
import { partDef } from '../src/parts/partDefs.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
