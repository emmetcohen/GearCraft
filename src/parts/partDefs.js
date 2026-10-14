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
// Entries with `hidden: true` are old parts kept only so old saves load.
// Entries with `tool: true` are not placed directly (e.g. the chain links two
// existing parts).
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
  { id: 'gears',     name: 'Gears & Chains', color: '#ffb627', icon: '⚙️' },
  { id: 'movers',    name: 'Wheels & Power', color: '#ff5d73', icon: '🚗' },
  { id: 'structure', name: 'Structure',      color: '#4ea8de', icon: '📏' },
  { id: 'anchors',   name: 'Anchors',        color: '#2ec4a6', icon: '📌' },
  { id: 'gadgets',   name: 'Gadgets',        color: '#ff9e00', icon: '🚀' },
  { id: 'controls',  name: 'Controls',       color: '#ffd23f', icon: '🎛️' },
  { id: 'world',     name: 'World',          color: '#bcb8b1', icon: '⛰️' },
  { id: 'objects',   name: 'Test Objects',   color: '#a77bca', icon: '📦' },
];

// A "drawn" part (drawn: true) is placed by click-dragging from one end to
// the other, like drawing a line. Its length lives in part.props.length, so
// one definition covers every length. Use partDef(part) to get a definition
// with the part's own length filled in.

export const PARTS = [
  // ---------------------------------------------------------------- GEARS --
  // Orange/yellow family. Bigger gear = more teeth = slower but stronger.
  // Stack two gears on one pin/axle and they turn together (a compound gear).
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
  // Sprockets don't mesh with gears: link two of them with a chain. A chain
  // keeps both turning the SAME way, at any distance.
  { id: 'sprocket-10', name: 'Sprocket 10T', category: 'gears', kind: 'sprocket', size: 'S',
    teeth: 10, radius: 0.6, mass: 0.3, shape: 'sprocket', color: '#c9ced6',
    tip: 'Link two sprockets (or gears) with a Chain. Same direction, any distance.' },
  { id: 'sprocket-16', name: 'Sprocket 16T', category: 'gears', kind: 'sprocket', size: 'M',
    teeth: 16, radius: 0.96, mass: 0.5, shape: 'sprocket', color: '#b5bcc7',
    tip: 'Link two sprockets (or gears) with a Chain. Same direction, any distance.' },
  { id: 'sprocket-24', name: 'Sprocket 24T', category: 'gears', kind: 'sprocket', size: 'L',
    teeth: 24, radius: 1.44, mass: 0.8, shape: 'sprocket', color: '#a3abb8',
    tip: 'Link two sprockets (or gears) with a Chain. Same direction, any distance.' },
  { id: 'sprocket-32', name: 'Sprocket 32T', category: 'gears', kind: 'sprocket', size: 'XL',
    teeth: 32, radius: 1.92, mass: 1.1, shape: 'sprocket', color: '#949daa',
    tip: 'Link two sprockets (or gears) with a Chain. Same direction, any distance.' },
  { id: 'chain', name: 'Chain', category: 'gears', kind: 'chain', size: 'M',
    mass: 0, shape: 'chain', color: '#5c5470', tool: true,
    tip: 'Click one sprocket or gear, then another, to link them like a bike chain.' },

  // --------------------------------------------------------------- MOVERS --
  // Red/coral family.
  { id: 'wheel-s', name: 'Wheel S', category: 'movers', kind: 'wheel', size: 'S',
    radius: 0.6, mass: 0.6, shape: 'wheel', color: '#ff8fa3' },
  { id: 'wheel-m', name: 'Wheel M', category: 'movers', kind: 'wheel', size: 'M',
    radius: 1.0, mass: 1.5, shape: 'wheel', color: '#ff5d73' },
  { id: 'wheel-l', name: 'Wheel L', category: 'movers', kind: 'wheel', size: 'L',
    radius: 1.6, mass: 3.5, shape: 'wheel', color: '#e63958' },
  // Drive wheels have a CRANK PIN off-centre. Put a beam hole on the pin and
  // the beam pivots there: side rods for trains, pistons, walking legs...
  // pinOffset is deliberately NOT a multiple of HOLE_SPACING, so a side rod
  // drawn level with the frame never lands on (and bolts to) frame holes.
  { id: 'drive-wheel-s', name: 'Drive Wheel', category: 'movers', kind: 'wheel', size: 'M',
    radius: 0.8, pinOffset: 0.6, mass: 1.2, shape: 'wheel', color: '#d62828',
    tip: 'A wheel with a crank pin. Link two with a beam on their pins (train side rods), or drive a piston.' },
  { id: 'drive-wheel-l', name: 'Big Drive Wheel', category: 'movers', kind: 'wheel', size: 'L',
    radius: 1.4, pinOffset: 1.0, mass: 3.0, shape: 'wheel', color: '#b5179e',
    tip: 'A big wheel with a crank pin. Rotate it (Q/E) to set where the pin starts.' },
  // A motor is a powered axle: whatever rotor sits on its shaft gets driven.
  // maxTorque/rpm are the sandbox slider defaults.
  { id: 'motor', name: 'Motor', category: 'movers', kind: 'motor', size: 'M',
    housing: 1.2, mass: 2.0, maxTorque: 60, rpm: 30, shape: 'motor', color: '#ef476f',
    tip: 'Drives whatever sits on its shaft. On a beam it rides along; otherwise it\'s bolted to the background. Give it keys with the Screwdriver to drive it yourself.' },
  // A powered push-rod. Draw it like a beam (that's its short length); it
  // pushes out to nearly twice that. Both ends pivot on what they touch;
  // a free bottom end is fixed to the background.
  { id: 'piston', name: 'Piston', category: 'movers', kind: 'piston', size: 'M', drawn: true,
    length: 2.4, thickness: 0.5, massPerLength: 0.5, shape: 'piston', color: '#8338ec',
    tip: 'Drag to draw it. It pushes out and pulls back on its own, or give it keys / wire a switch. Its ends pivot; put BOTH yellow base joints on a beam and it can\'t swing.' },
  { id: 'crank', name: 'Hand Crank', category: 'movers', kind: 'crank', size: 'M',
    armLength: 1.0, mass: 0.5, shape: 'crank', color: '#ff70a6',
    tip: 'Human power! While playing, drag the handle around to turn it.' },

  // ------------------------------------------------------------ STRUCTURE --
  // Blue family. Beams have holes every HOLE_SPACING; holes are sockets.
  { id: 'beam', name: 'Beam', category: 'structure', kind: 'beam', size: 'M', drawn: true,
    length: 4.0, thickness: 0.44, massPerLength: 0.17, shape: 'beam', color: '#4ea8de',
    tip: 'Click and drag to draw a beam of any length. Ends snap onto holes, pins and shafts.' },
  { id: 'axle', name: 'Axle', category: 'structure', kind: 'axle', size: 'S',
    radius: 0.18, mass: 0.1, shape: 'axle', color: '#a2d2ff',
    tip: 'Locks the beams on this point to the gears/wheels, so they all turn together (arms, levers).' },
  { id: 'bolt', name: 'Bolt', category: 'structure', kind: 'bolt', size: 'S',
    radius: 0.2, mass: 0.05, shape: 'bolt', color: '#c9ced6',
    tip: 'Drop it where two parts overlap (a beam over a gear, wheel or crate) and they\'re bolted together: they move and turn as one.' },
  { id: 'hinge', name: 'Hinge', category: 'structure', kind: 'hinge', size: 'S',
    radius: 0.22, mass: 0.1, shape: 'hinge', color: '#3a86ff',
    tip: 'Lets beams on this point pivot freely instead of being bolted together.' },
  { id: 'plate', name: 'Plate', category: 'structure', kind: 'plate', size: 'L', drawn: true,
    length: 4.0, thickness: 1.2, massPerLength: 0.45, shape: 'plate', color: '#90e0ef',
    tip: 'A wide, solid beam: car bodies, boat hulls, decks. Holes along the middle like a beam.' },
  { id: 'slider', name: 'Slider', category: 'structure', kind: 'slider', size: 'M', drawn: true,
    length: 3.2, thickness: 0.5, massPerLength: 0.3, shape: 'slider', color: '#7209b7',
    tip: 'A rail with a sliding block. Bolt the rail down (pins or beams on its end holes) and link the block to a crank pin for a piston.' },
  { id: 'spring', name: 'Spring', category: 'structure', kind: 'spring', size: 'M', drawn: true,
    length: 2.0, thickness: 0.4, mass: 0.2, shape: 'spring', color: '#f72585',
    tip: 'Draw between two points. Stretchy: great for suspension. Ends grab whatever they touch.' },
  { id: 'rope', name: 'Rope', category: 'structure', kind: 'rope', size: 'M', drawn: true,
    length: 3.0, thickness: 0.12, mass: 0, shape: 'rope', color: '#c08552',
    tip: 'Draw between two points. Can\'t stretch longer, but goes slack. Ends grab whatever they touch.' },

  // -------------------------------------------------------------- ANCHORS --
  // Green family. Anchors connect things to the background. In sandbox mode
  // you can put them anywhere.
  { id: 'pin-fixed', name: 'Fixed Pin', category: 'anchors', kind: 'fixedPin', size: 'S',
    radius: 0.24, mass: 0, shape: 'fixedPin', color: '#57cc99',
    tip: 'Bolts parts to the background. Nothing on it can move or spin (except a motor shaft).' },
  { id: 'pin-rotating', name: 'Rotating Pin', category: 'anchors', kind: 'rotPin', size: 'S',
    radius: 0.22, mass: 0, shape: 'rotPin', color: '#2ec4a6',
    tip: 'Holds parts to the background but lets them spin.' },

  // -------------------------------------------------------------- GADGETS --
  // Orange family. Gadgets ride on the part under them (like controls) and
  // can be run by keys or wired controls (Wrench). With neither, they just go.
  { id: 'thruster', name: 'Thruster', category: 'gadgets', kind: 'thruster', size: 'S',
    radius: 0.45, width: 1.0, height: 0.6, mass: 0.3, shape: 'thruster', color: '#ff9e00',
    tip: 'A rocket: pushes the part it sits on (the way it points). Give it a key or wire a button to fire it when you want.' },
  { id: 'magnet', name: 'Magnet', category: 'gadgets', kind: 'magnet', size: 'S',
    radius: 0.45, mass: 0.5, shape: 'magnet', color: '#e63946',
    tip: 'Pulls nearby crates and balls toward it. Put it on a crane arm! Give it a key or a switch to turn it on and off.' },
  { id: 'cannon', name: 'Cannon', category: 'gadgets', kind: 'cannon', size: 'S',
    radius: 0.5, mass: 1.0, shape: 'cannon', color: '#495057',
    tip: 'Fires balls the way it points (with a kick back). Fires by itself, or give it a key / wire a button.' },
  { id: 'balloon', name: 'Balloon', category: 'gadgets', kind: 'balloon', size: 'M',
    radius: 0.7, mass: 0.2, lift: 14, shape: 'balloon', color: '#ff70a6',
    tip: 'Floats up. Tie it to things with a Rope (draw the rope from the balloon to a part).' },

  // ------------------------------------------------------------- CONTROLS --
  // Yellow family. Wire them to motors with the Wrench. A control rides on
  // whatever part it's placed on (or is fixed to the background).
  { id: 'switch', name: 'Switch', category: 'controls', kind: 'switch', size: 'S',
    radius: 0.4, mass: 0.1, shape: 'switch', color: '#ffd23f',
    tip: 'Click it while playing to turn wired motors on or off. Wire it with the Wrench.' },
  { id: 'button', name: 'Button', category: 'controls', kind: 'button', size: 'S',
    radius: 0.4, mass: 0.1, shape: 'button', color: '#ef476f',
    tip: 'Wired motors run while you hold it down (while playing). Wire it with the Wrench.' },
  { id: 'key-button', name: 'Key', category: 'controls', kind: 'keyButton', size: 'S',
    radius: 0.4, mass: 0.1, shape: 'keyButton', color: '#e9ecef',
    tip: 'Two keys: D turns wired motors clockwise (a car goes right), A the other way. Change the keys with the Screwdriver. Wire it with the Wrench.' },
  // The wire itself is made by the Wrench tool (not from the gallery).
  { id: 'wire', name: 'Wire', category: 'controls', kind: 'wire', hidden: true, mass: 0, shape: 'wire', color: '#ffd23f' },

  // ---------------------------------------------------------------- WORLD --
  // Grey/stone. Part of the map: they never move.
  { id: 'track', name: 'Track', category: 'world', kind: 'track', size: 'L', drawn: true,
    length: 8.0, thickness: 0.3, mass: 0, shape: 'track', color: '#8d6e63',
    tip: 'Click and drag to lay track or a road. Ends snap together, so you can build hills and bridges.' },
  { id: 'conveyor', name: 'Conveyor', category: 'world', kind: 'conveyor', size: 'L', drawn: true,
    length: 6.0, thickness: 0.5, mass: 0, shape: 'conveyor', color: '#5c5470',
    tip: 'Drag to draw a belt. It carries things along (left to right as drawn). Keys or a switch can run or reverse it.' },
  { id: 'bounce-pad', name: 'Bounce Pad', category: 'world', kind: 'bouncePad', size: 'M',
    width: 2.0, height: 0.5, mass: 0, shape: 'bouncePad', color: '#06d6a0',
    tip: 'A trampoline. Things bounce off it.' },
  { id: 'water', name: 'Water', category: 'world', kind: 'water', size: 'L',
    width: 12, height: 3, mass: 0, shape: 'water', color: '#4cc9f0',
    tip: 'Light things float, heavy things sink. Build a boat! Resize it with the Scale tool.' },
  { id: 'ramp-s', name: 'Ramp', category: 'world', kind: 'ramp', size: 'S',
    width: 6, height: 2, mass: 0, shape: 'ramp', color: '#bcb8b1', tip: 'Part of the map: it never moves.' },
  { id: 'ramp-l', name: 'Steep Ramp', category: 'world', kind: 'ramp', size: 'L',
    width: 8, height: 4, mass: 0, shape: 'ramp', color: '#a8a39d', tip: 'Part of the map: it never moves.' },
  { id: 'block', name: 'Block', category: 'world', kind: 'block', size: 'M',
    width: 4, height: 1, mass: 0, shape: 'block', color: '#c2b9b0', tip: 'A static platform.' },

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

  // --------------------------------------------------------------- LEGACY --
  // Hidden from the gallery but kept so old saves still load.
  { id: 'beam-6',  name: 'Beam 6',  category: 'structure', kind: 'beam', hidden: true,
    length: 2.4, thickness: 0.44, mass: 0.4, shape: 'beam', color: '#90e0ef' },
  { id: 'beam-10', name: 'Beam 10', category: 'structure', kind: 'beam', hidden: true,
    length: 4.0, thickness: 0.44, mass: 0.7, shape: 'beam', color: '#4ea8de' },
  { id: 'beam-16', name: 'Beam 16', category: 'structure', kind: 'beam', hidden: true,
    length: 6.4, thickness: 0.44, mass: 1.1, shape: 'beam', color: '#48bfe3' },
  { id: 'beam-24', name: 'Beam 24', category: 'structure', kind: 'beam', hidden: true,
    length: 9.6, thickness: 0.44, mass: 1.6, shape: 'beam', color: '#5390d9' },
  { id: 'compound-24-12', name: 'Compound 24/12', category: 'gears', kind: 'compoundGear', hidden: true,
    layers: [24, 12], mass: 1.8, shape: 'compoundGear', color: '#ff9f1c' },
  { id: 'compound-32-16', name: 'Compound 32/16', category: 'gears', kind: 'compoundGear', hidden: true,
    layers: [32, 16], mass: 3.0, shape: 'compoundGear', color: '#f48c06' },
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

/** Lengths of drawn parts snap to this (one beam hole). */
export const LENGTH_STEP = HOLE_SPACING;

/** Size properties a placed part may override (set by drawing or the Scale tool). */
const SIZE_KEYS = ['length', 'teeth', 'radius', 'width', 'height'];

/** The definition of a placed part, with its own size (and the mass that
 *  goes with it) filled in: drawn parts have their own length, and the
 *  Scale tool can change teeth, radius, width and height. */
export function partDef(part) {
  const def = getDef(part.type);
  const props = part.props;
  if (!props || !SIZE_KEYS.some((k) => props[k] != null)) {
    return def.massPerLength ? { ...def, mass: def.massPerLength * def.length } : def;
  }
  const out = { ...def };
  for (const k of SIZE_KEYS) if (props[k] != null && def[k] != null) out[k] = props[k];
  // Mass follows size: area for flat things, length for drawn ones.
  if (def.massPerLength) out.mass = def.massPerLength * out.length;
  else if (def.mass) {
    let f = 1;
    if (def.teeth && out.teeth !== def.teeth) f = (out.teeth / def.teeth) ** 2;
    else if (def.radius && out.radius !== def.radius) f = (out.radius / def.radius) ** 2;
    else if (def.width) f = (out.width * out.height) / (def.width * def.height);
    out.mass = def.mass * f;
  }
  if (def.kind === 'sprocket' && out.teeth !== def.teeth) out.radius = out.teeth * 0.06;
  if (def.pinOffset) out.pinOffset = Math.min(def.pinOffset, out.radius * 0.8);
  return out;
}

/**
 * How the Scale tool resizes a part kind, or null if it can't be scaled.
 *   key   which size property changes
 *   min, max, step   limits and snapping
 *   axis  for boxes: 'x' (width) or 'y' (height) handles
 */
export function scaleSpec(def) {
  switch (def.kind) {
    case 'gear':     return [{ key: 'teeth', min: 8, max: 64, step: 4, unit: 'teeth' }];
    case 'sprocket': return [{ key: 'teeth', min: 6, max: 48, step: 2, unit: 'teeth' }];
    case 'wheel':    return [{ key: 'radius', min: 0.3, max: 3, step: 0.1, unit: 'm' }];
    case 'ball':     return [{ key: 'radius', min: 0.2, max: 3, step: 0.1, unit: 'm' }];
    case 'crate':    return [{ key: 'width', axis: 'x', min: 0.4, max: 8, step: 0.2, unit: 'm' },
                             { key: 'height', axis: 'y', min: 0.4, max: 8, step: 0.2, unit: 'm' }];
    case 'balloon':  return [{ key: 'radius', min: 0.3, max: 2.5, step: 0.1, unit: 'm' }];
    case 'block': case 'ramp': case 'bouncePad': case 'water':
      return [{ key: 'width', axis: 'x', min: 0.5, max: 30, step: 0.5, unit: 'm' },
              { key: 'height', axis: 'y', min: 0.25, max: 12, step: 0.25, unit: 'm' }];
    default: return def.drawn ? [{ key: 'length', unit: 'm' }] : null;
  }
}

/** A piston's second base joint: this far up the cylinder from its bottom
 *  end (a whole number of holes, so a beam along the piston hits both). */
export const pistonMount = (def) => (def.length >= 2 ? 2 : 1) * HOLE_SPACING;

/** Parts the Wrench can wire controls to, and keys can run. */
export const isActuator = (kind) => ['motor', 'piston', 'thruster', 'magnet', 'cannon', 'conveyor'].includes(kind);

/** Collision modes the Screwdriver can set (props.collide). */
export const COLLIDE_MODES = [
  ['normal', 'Normal', 'Bumps into the ground and loose objects, passes through other machine parts.'],
  ['all', 'Everything', 'Also bumps into other machine parts (e.g. an arm that hits a wall).'],
  ['none', 'None', 'A ghost: passes through everything, even the ground.'],
];

/** Parts placed by click-dragging a line. */
export const isDrawn = (def) => !!def.drawn;

/**
 * Broad ROLE of a part kind. The assembly and snapping code reason in roles:
 *   rotor     – spins on an axle (gears, wheels)
 *   beam      – structure with holes
 *   driver    – powers an axle (motor, crank)
 *   connector – joins things at a point (pins, axle, hinge)
 *   link      – ties other parts together without sockets (chain, spring, rope, wire)
 *   control   – switches/buttons/keys: ride on the part under them, wired to motors
 *   bolt      – locks together every part under it (no sockets needed)
 *   piston    – a powered push-rod with a pivot at each end
 *   gadget    – thruster/magnet/cannon: ride on the part under them
 *   object    – loose test objects (balls, crates) or map pieces (ramps)
 */
export function roleOf(kind) {
  switch (kind) {
    case 'gear': case 'compoundGear': case 'wheel': case 'sprocket': return 'rotor';
    case 'beam': case 'slider': return 'beam';
    case 'motor': case 'crank': return 'driver';
    case 'axle': case 'hinge': case 'fixedPin': case 'rotPin': return 'connector';
    case 'chain': case 'spring': case 'rope': case 'wire': return 'link';
    case 'plate': return 'beam';
    case 'piston': return 'piston';
    case 'thruster': case 'magnet': case 'cannon': return 'gadget';
    case 'switch': case 'button': case 'keyButton': return 'control';
    case 'bolt': return 'bolt';
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

/**
 * Bolt holes on a gear's or sprocket's face (local offsets). A beam put on
 * one is bolted to the gear and turns with it; add a hinge there and it
 * pivots instead (a crank). Four holes on a ring whose radius is a whole
 * number of holes PLUS half a hole, so a beam running through the gear's
 * centre never lands on them by accident.
 */
export function faceHoles(def) {
  let r;
  if (def.kind === 'gear') r = pitchRadius(def.teeth) * 0.62;
  else if (def.kind === 'sprocket') r = def.radius * 0.7;
  else return [];
  const ring = Math.floor((r - HOLE_SPACING / 2) / HOLE_SPACING) * HOLE_SPACING + HOLE_SPACING / 2;
  if (ring < 0.5) return []; // too small for holes
  return [[ring, 0], [0, ring], [-ring, 0], [0, -ring]];
}

/** Tooth count a chain sees on this part (sprockets and gears), or 0. */
export function chainTeeth(def) {
  if (def.kind === 'sprocket' || def.kind === 'gear') return def.teeth;
  return 0;
}

/** Radius the chain wraps around. */
export function chainRadius(def) {
  if (def.kind === 'sprocket') return def.radius;
  if (def.kind === 'gear') return pitchRadius(def.teeth);
  return 0;
}
