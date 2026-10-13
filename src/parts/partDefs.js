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
];

export const PARTS = [
  // ---------------------------------------------------------------- GEARS --
  // Orange/yellow family.
  { id: 'gear-12', name: 'Gear 12T', category: 'gears', kind: 'gear', size: 'S',
    teeth: 12, mass: 0.6, shape: 'gear', color: '#ffd23f' },
  { id: 'gear-24', name: 'Gear 24T', category: 'gears', kind: 'gear', size: 'M',
    teeth: 24, mass: 1.4, shape: 'gear', color: '#ffb627' },

  // --------------------------------------------------------------- MOVERS --
  // Red/coral family.
  { id: 'wheel-m', name: 'Wheel M', category: 'movers', kind: 'wheel', size: 'M',
    radius: 1.0, mass: 1.5, shape: 'wheel', color: '#ff5d73' },
  // A motor is a powered axle: whatever rotor sits on its shaft gets driven.
  // maxTorque/rpm are DEFAULTS; the sandbox sliders scale them.
  { id: 'motor', name: 'Motor', category: 'movers', kind: 'motor', size: 'M',
    housing: 1.2, mass: 2.0, maxTorque: 60, rpm: 30, shape: 'motor', color: '#ef476f' },

  // -------------------------------------------------------------- ANCHORS --
  // Green family. Anchors connect things to the background.
  { id: 'pin-rotating', name: 'Rotating Pin', category: 'anchors', kind: 'rotPin', size: 'S',
    radius: 0.22, mass: 0, shape: 'rotPin', color: '#2ec4a6',
    tip: 'Holds parts to the background but lets them spin.' },
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
