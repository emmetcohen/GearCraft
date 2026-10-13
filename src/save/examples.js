// =============================================================================
// examples.js — ready-made builds that show off (and test) the mechanics.
// Each is a list of [type, x, y, angle?, props?]. Gears get their teeth
// lined up automatically by running them through the same snapper the
// player uses.
// =============================================================================
import { emptyBuild, addPart } from '../core/build.js';
import { snapPart } from '../parts/snap.js';
import { getDef } from '../parts/partDefs.js';

function make(list) {
  const b = emptyBuild();
  for (const [type, x, y, angle = 0, props = {}] of list) {
    const k = getDef(type).kind;
    const a = k === 'gear' || k === 'compoundGear'
      ? snapPart(b.parts, type, x, y, angle, { grid: false }).angle
      : angle;
    addPart(b, type, x, y, a, props);
  }
  return b;
}

export const EXAMPLES = [
  {
    name: 'Gear train',
    blurb: 'Motor → 12T → compound 24/12 → 24T → 8T. Select gears to compare RPM & torque.',
    camera: { x: -1, y: 7, zoom: 30 },
    build: () => make([
      ['motor', -6, 6], ['gear-12', -6, 6],
      ['pin-rotating', -2.4, 6], ['compound-24-12', -2.4, 6],
      ['pin-rotating', -2.4, 9.6], ['gear-24', -2.4, 9.6],
      ['pin-rotating', 0.8, 9.6], ['gear-8', 0.8, 9.6],
      // 8T → 16T (idler) → 16T: the idler flips direction back again.
      ['pin-rotating', 3.2, 9.6], ['gear-16', 3.2, 9.6],
      ['pin-rotating', 3.2, 6.4], ['gear-16', 3.2, 6.4], ['wheel-s', 3.2, 6.4],
    ]),
  },
  {
    name: 'Little car',
    blurb: 'A motor riding on a beam drives the back wheel. Watch it climb the ramp.',
    camera: { x: 6, y: 4, zoom: 26 },
    build: () => make([
      ['beam-16', 0, 1.6],
      ['motor', -3.2, 1.6, 0, { reverse: true }], ['wheel-l', -3.2, 1.6],
      ['wheel-l', 3.2, 1.6],
      ['ramp-s', 13, 1],
      ['crate', 21, 0.6], ['ball-s', 24, 0.5],
    ]),
  },
  {
    name: 'Torque test',
    blurb: 'Same motor, same arm. Left: direct drive stalls. Right: a 2:1 reduction doubles torque and lifts it.',
    camera: { x: 0, y: 8, zoom: 22 },
    build: () => make([
      // Direct: 60 N·m motor vs ~77 N·m of arm → stall.
      ['motor', -13, 10], ['axle', -13, 10], ['beam-24', -8.2, 10],
      // Geared: 12T → 24T gives 120 N·m at the arm → lifts.
      ['motor', 0, 10, 0, { reverse: true }], ['gear-12', 0, 10],
      ['pin-rotating', 3.6, 10], ['gear-24', 3.6, 10], ['axle', 3.6, 10], ['beam-24', 8.4, 10],
    ]),
  },
  {
    name: 'Hand crank',
    blurb: 'Press Play, then drag the pink crank handle around in circles.',
    camera: { x: 3, y: 5, zoom: 32 },
    build: () => make([
      ['crank', 0, 5], ['gear-12', 0, 5],
      ['pin-rotating', 4.4, 5], ['gear-32', 4.4, 5], ['axle', 4.4, 5], ['beam-10', 6.4, 5],
      ['ball-s', 7.6, 6],
    ]),
  },
  {
    name: 'Jammed!',
    blurb: 'Three gears in a triangle can never turn. The motor stalls; nothing breaks.',
    camera: { x: 1.2, y: 5, zoom: 36 },
    build: () => make([
      ['motor', 0, 4], ['gear-12', 0, 4],
      ['pin-rotating', 2.4, 4], ['gear-12', 2.4, 4],
      ['pin-rotating', 1.2, 4 + 2.4 * Math.sqrt(3) / 2], ['gear-12', 1.2, 4 + 2.4 * Math.sqrt(3) / 2],
    ]),
  },
];
