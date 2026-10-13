// Headless tests for the pure logic + physics. Run with:  node tests/run.mjs
// (No browser needed: Planck.js and our src/ modules are plain ES modules.)
import { emptyBuild, addPart } from '../src/core/build.js';
import { buildAssembly, WORLD, mainKey } from '../src/physics/assembly.js';
import { solveGearTrain } from '../src/physics/gearTrain.js';
import { Simulation, radToRpm, DT } from '../src/physics/world.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
