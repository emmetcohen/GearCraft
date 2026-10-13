// =============================================================================
// partDefs.js — THE single source of truth for every part in GearCraft.
//
// Adding a new part = adding one entry to PARTS below. Everything else
// (gallery, renderer, snapping, physics) reads these fields.
//
// Units: the world uses "units" (think: 1 unit ≈ 1 metre for the physics).
// Mass is in kg, torque in N·m, speeds in RPM for the UI.
//
// Common fields for each entry:
//   id        unique string, also stored in save files (never rename!)
//   name      label shown in the gallery
//   category  which gallery group it lives in (see CATEGORIES)
//   kind      which BEHAVIOUR the part has. Code switches on `kind`, never on
//             `id`, so several sizes can share one behaviour.
//   size      'S' | 'M' | 'L' (or similar) — just a label
//   mass      kg
//   shape     how the renderer draws it ('gear', 'wheel', 'beam', ...)
//   color     main fill colour (each category has its own colour family)
//   ...plus kind-specific fields (teeth, radius, length, ...)
//
// Placeholders: entries with `placeholder: true` are FUTURE parts. They show
// up greyed-out in the gallery so you can see what's planned, but cannot be
// placed and have no physics yet.
// =============================================================================

/** Gear "module": how big one tooth is. Pitch radius = MODULE * teeth / 2.
 *  Because every gear uses the same module, ANY two gears can mesh. */
export const MODULE = 0.2;

/** Distance between holes on beams. Chosen so that two meshed gears whose
 *  tooth counts are multiples of 4 always land exactly on beam holes. */
export const HOLE_SPACING = 0.4;

/** Pitch radius of a gear with `teeth` teeth (the circle where teeth touch). */
export const pitchRadius = (teeth) => (MODULE * teeth) / 2;

/** Shared outline colour for the cartoon look. */
export const OUTLINE = '#2b2140';

/** Gallery categories, in display order. Each has its own colour family. */
export const CATEGORIES = [
  { id: 'gears',     name: 'Gears',        color: '#ffb627', icon: '⚙️' },
  { id: 'movers',    name: 'Movers',       color: '#ff5d73', icon: '🚗' },
  { id: 'structure', name: 'Structure',    color: '#4ea8de', icon: '📏' },
  { id: 'anchors',   name: 'Anchors',      color: '#2ec4a6', icon: '📌' },
  { id: 'objects',   name: 'Test Objects', color: '#a77bca', icon: '📦' },
];

/** Placeholder helper: a planned part with no behaviour yet. */
const planned = (id, name, category, tip) => ({ id, name, category, kind: 'placeholder', placeholder: true, tip });

export const PARTS = [
  // ---------------------------------------------------------------- GEARS --
  // Orange/yellow family. Bigger gear = more teeth = slower but stronger.
  { id: 'gear-8',  name: 'Gear 8T',  category: 'gears', kind: 'gear', size: 'XS',
    teeth: 8,  mass: 0.3, shape: 'gear', color: '#ffe066' },
  { id: 'gear-12', name: 'Gear 12T', category: 'gears', kind: 'gear', size: 'S',
    teeth: 12, mass: 0.6, shape: 'gear', color: '#ffd23f' },
  { id: 'gear-16', name: 'Gear 16T', category: 'gears', kind: 'gear', size: 'M',
    teeth: 16, mass: 0.9, shape: 'gear', color: '#ffc43d' },
  { id: 'gear-24', name: 'Gear 24T', category: 'gears', kind: 'gear', size: 'L',
    teeth: 24, mass: 1.4, shape: 'gear', color: '#ffb627' },
  { id: 'gear-32', name: 'Gear 32T', category: 'gears', kind: 'gear', size: 'XL',
    teeth: 32, mass: 2.2, shape: 'gear', color: '#ff9f1c' },
  // Compound gear: two gears fused on one axle. `layers` = tooth counts,
  // biggest first. Other gears can mesh with either layer.
  { id: 'compound-24-12', name: 'Compound 24/12', category: 'gears', kind: 'compoundGear', size: 'M',
    layers: [24, 12], mass: 1.8, shape: 'compoundGear', color: '#ff9f1c',
    tip: 'Two gears on one axle. Mesh one gear with each layer to stack up big ratios.' },
  { id: 'compound-32-16', name: 'Compound 32/16', category: 'gears', kind: 'compoundGear', size: 'L',
    layers: [32, 16], mass: 3.0, shape: 'compoundGear', color: '#f48c06',
    tip: 'Two gears on one axle.' },
  planned('worm-gear', 'Worm Gear', 'gears', 'A screw that drives a gear: huge reduction, can\'t be back-driven.'),
  planned('rack-pinion', 'Rack & Pinion', 'gears', 'Turns rotation into straight-line motion.'),
  planned('bevel-gear', 'Bevel / Idler', 'gears', 'Changes the axis of rotation.'),

  // --------------------------------------------------------------- MOVERS --
  // Red/coral family.
  { id: 'wheel-s', name: 'Wheel S', category: 'movers', kind: 'wheel', size: 'S',
    radius: 0.6, mass: 0.6, shape: 'wheel', color: '#ff8fa3' },
  { id: 'wheel-m', name: 'Wheel M', category: 'movers', kind: 'wheel', size: 'M',
    radius: 1.0, mass: 1.5, shape: 'wheel', color: '#ff5d73' },
  { id: 'wheel-l', name: 'Wheel L', category: 'movers', kind: 'wheel', size: 'L',
    radius: 1.6, mass: 3.5, shape: 'wheel', color: '#e63958' },
  // A motor is a powered axle: whatever rotor sits on its shaft gets driven.
  // maxTorque/rpm are the sandbox slider defaults.
  { id: 'motor', name: 'Motor', category: 'movers', kind: 'motor', size: 'M',
    housing: 1.2, mass: 2.0, maxTorque: 60, rpm: 30, shape: 'motor', color: '#ef476f',
    tip: 'Drives whatever sits on its shaft. On a beam it rides along; otherwise it\'s bolted to the background.' },
  { id: 'crank', name: 'Hand Crank', category: 'movers', kind: 'crank', size: 'M',
    armLength: 1.0, mass: 0.5, shape: 'crank', color: '#ff70a6',
    tip: 'Human power! While playing, drag the handle around to turn it.' },
  planned('cam', 'Cam', 'movers', 'An egg-shaped wheel that pushes a follower up and down.'),
  planned('crank-arm', 'Crank & Slider', 'movers', 'Turns rotation into back-and-forth motion.'),
  planned('pulley', 'Pulley & Belt', 'movers', 'Links two axles at a distance, same direction.'),
  planned('sprocket', 'Chain & Sprocket', 'movers', 'Like a belt, but it can\'t slip.'),

  // ------------------------------------------------------------ STRUCTURE --
  // Blue family. Beams have holes every HOLE_SPACING; holes are sockets.
  { id: 'beam-6',  name: 'Beam 6',  category: 'structure', kind: 'beam', size: 'S',
    length: 2.4, thickness: 0.44, mass: 0.4, shape: 'beam', color: '#90e0ef' },
  { id: 'beam-10', name: 'Beam 10', category: 'structure', kind: 'beam', size: 'M',
    length: 4.0, thickness: 0.44, mass: 0.7, shape: 'beam', color: '#4ea8de' },
  { id: 'beam-16', name: 'Beam 16', category: 'structure', kind: 'beam', size: 'L',
    length: 6.4, thickness: 0.44, mass: 1.1, shape: 'beam', color: '#48bfe3' },
  { id: 'beam-24', name: 'Beam 24', category: 'structure', kind: 'beam', size: 'XL',
    length: 9.6, thickness: 0.44, mass: 1.6, shape: 'beam', color: '#5390d9' },
  { id: 'axle', name: 'Axle', category: 'structure', kind: 'axle', size: 'S',
    radius: 0.18, mass: 0.1, shape: 'axle', color: '#a2d2ff',
    tip: 'Locks the beams on this point to the gears/wheels, so they all turn together (arms, levers).' },
  { id: 'hinge', name: 'Hinge', category: 'structure', kind: 'hinge', size: 'S',
    radius: 0.22, mass: 0.1, shape: 'hinge', color: '#3a86ff',
    tip: 'Lets beams on this point pivot freely instead of being bolted together.' },
  planned('spring', 'Spring', 'structure', 'Stretchy connection between two points.'),
  planned('brake', 'Brake / Clutch', 'structure', 'Stops or disconnects an axle on command.'),

  // -------------------------------------------------------------- ANCHORS --
  // Green family. Anchors connect things to the background. In sandbox mode
  // you can put them anywhere.
  { id: 'pin-fixed', name: 'Fixed Pin', category: 'anchors', kind: 'fixedPin', size: 'S',
    radius: 0.24, mass: 0, shape: 'fixedPin', color: '#57cc99',
    tip: 'Bolts parts to the background. Nothing on it can move or spin (except a motor shaft).' },
  { id: 'pin-rotating', name: 'Rotating Pin', category: 'anchors', kind: 'rotPin', size: 'S',
    radius: 0.22, mass: 0, shape: 'rotPin', color: '#2ec4a6',
    tip: 'Holds parts to the background but lets them spin.' },
  planned('rail-anchor', 'Sliding Rail', 'anchors', 'An anchor that slides along a track.'),

  // --------------------------------------------------------- TEST OBJECTS --
  // Purple/brown/stone. Loose things to push, lift and roll.
  { id: 'ball-s', name: 'Ball', category: 'objects', kind: 'ball', size: 'S',
    radius: 0.5, mass: 1, bounce: 0.4, shape: 'ball', color: '#b388eb' },
  { id: 'ball-l', name: 'Big Ball', category: 'objects', kind: 'ball', size: 'L',
    radius: 0.9, mass: 5, bounce: 0.25, shape: 'ball', color: '#8f5fd6' },
  { id: 'crate', name: 'Crate', category: 'objects', kind: 'crate', size: 'M',
    width: 1.2, height: 1.2, mass: 3, shape: 'crate', color: '#e0a96d' },
  { id: 'crate-heavy', name: 'Heavy Crate', category: 'objects', kind: 'crate', size: 'L',
    width: 1.6, height: 1.6, mass: 40, heavy: true, shape: 'crate', color: '#8d99ae',
    tip: '40 kg. Great for testing stalls.' },
  { id: 'ramp-s', name: 'Ramp', category: 'objects', kind: 'ramp', size: 'S',
    width: 6, height: 2, mass: 0, shape: 'ramp', color: '#bcb8b1', tip: 'Part of the map: it never moves.' },
  { id: 'ramp-l', name: 'Steep Ramp', category: 'objects', kind: 'ramp', size: 'L',
    width: 8, height: 4, mass: 0, shape: 'ramp', color: '#a8a39d', tip: 'Part of the map: it never moves.' },
  { id: 'block', name: 'Block', category: 'objects', kind: 'block', size: 'M',
    width: 4, height: 1, mass: 0, shape: 'block', color: '#c2b9b0', tip: 'A static platform.' },
  planned('weight', 'Hanging Weight', 'objects', 'A weight on a rope, for lifting tests.'),
];

// ---------------------------------------------------------------- lookups --
const BY_ID = new Map(PARTS.map((p) => [p.id, p]));

/** Get a part definition by id (throws on unknown ids so typos fail loudly). */
export function getDef(id) {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown part type: ${id}`);
  return def;
}

export const hasDef = (id) => BY_ID.has(id);

/**
 * Broad ROLE of a part kind. The assembly and snapping code reason in roles:
 *   rotor     – spins on an axle (gears, wheels)
 *   beam      – structure with holes
 *   driver    – powers an axle (motor, crank)
 *   connector – joins things at a point (pins, axle, hinge)
 *   object    – loose test objects (balls, crates) or map pieces (ramps)
 */
export function roleOf(kind) {
  switch (kind) {
    case 'gear': case 'compoundGear': case 'wheel': return 'rotor';
    case 'beam': return 'beam';
    case 'motor': case 'crank': return 'driver';
    case 'axle': case 'hinge': case 'fixedPin': case 'rotPin': return 'connector';
    default: return 'object';
  }
}

/** The gear "layers" of a gear-like part: [{teeth, r}], biggest first. */
export function gearLayers(def) {
  if (def.kind === 'gear') return [{ teeth: def.teeth, r: pitchRadius(def.teeth) }];
  if (def.kind === 'compoundGear') {
    return def.layers.map((teeth) => ({ teeth, r: pitchRadius(teeth) }));
  }
  return [];
}
