// Headless tests for the pure logic + physics. Run with:  node tests/run.mjs
// (No browser needed: Planck.js and our src/ modules are plain ES modules.)
import { emptyBuild, addPart } from '../src/core/build.js';
import { buildAssembly, WORLD, mainKey } from '../src/physics/assembly.js';
import { solveGearTrain } from '../src/physics/gearTrain.js';
import { Simulation, radToRpm, DT } from '../src/physics/world.js';
import { EXAMPLES } from '../src/save/examples.js';
import { toFile, fromFile } from '../src/save/storage.js';
import { findMeshes } from '../src/physics/gearTrain.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
