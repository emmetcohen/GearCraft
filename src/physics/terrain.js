// =============================================================================
// terrain.js — the shape of the ground.
//
// A terrain is just a height function h(x) (world units, ground top at y = h).
// The physics builds the ground from it in chunks as things drive along, and
// the renderer draws the same function, so they always agree.
//
// Every terrain is flat near the middle (|x| < FLAT_ZONE) so you always have
// somewhere level to build, then blends into its bumps.
// =============================================================================

export const TERRAINS = [
  { id: 'flat',    name: 'Flat',    icon: '▬' },
  { id: 'bumpy',   name: 'Bumpy',   icon: '〰️' },
  { id: 'hills',   name: 'Hills',   icon: '⛰️' },
  { id: 'jumps',   name: 'Jumps',   icon: '🛹' },
  { id: 'stairs',  name: 'Stairs',  icon: '🪜' },
  { id: 'craters', name: 'Moon',    icon: '🌑' },
  { id: 'ice',     name: 'Ice',     icon: '🧊' },
];

export const isTerrain = (id) => TERRAINS.some((t) => t.id === id);

/** Half-width of the level building area in the middle. */
export const FLAT_ZONE = 10;
const BLEND = 10;

/** Ground friction (× the friction slider). */
export const terrainFriction = (id) => (id === 'ice' ? 0.04 : 1);

/** Colours for drawing: { dirt, top, pebble }. */
export function terrainColors(id) {
  if (id === 'ice') return { dirt: '#8fb8d6', top: '#e3f6ff', pebble: '#7aa6c4' };
  if (id === 'craters') return { dirt: '#9d99ab', top: '#d6d3e0', pebble: '#86829a' };
  return { dirt: '#a0704a', top: '#7bd389', pebble: '#8a5e3c' };
}

/** Is the ground just the plain flat box? */
export const isFlat = (id) => !id || id === 'flat' || id === 'ice';

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Ground height at x. */
export function heightAt(id, x) {
  if (isFlat(id)) return 0;
  const s = Math.abs(x);
  const w = smooth((s - FLAT_ZONE) / BLEND); // 0 in the middle, 1 out in the bumps
  if (w === 0) return 0;
  switch (id) {
    case 'bumpy':
      return w * (0.28 * Math.sin(1.7 * x) + 0.18 * Math.sin(3.1 * x + 1.3) + 0.14 * Math.sin(0.6 * x + 0.4));
    case 'hills':
      return w * (2.6 * Math.sin(x / 11) + 1.4 * Math.sin(x / 5.3 + 1.7) + 0.4 * Math.sin(x / 2.1 + 0.3));
    case 'jumps': {
      // Kicker ramps facing away from the middle, every 36 m.
      const u = (s - FLAT_ZONE - 6) % 36;
      if (s < FLAT_ZONE + 6 || u > 9.4) return 0;
      if (u <= 9) return 2.2 * (u / 9) ** 2;
      return 2.2 * (1 - (u - 9) / 0.4); // the drop
    }
    case 'stairs': {
      // 12 steps up, 12 down, 0.3 m each, 2.4 m deep (risers are a little sloped).
      const d = s - FLAT_ZONE - 4;
      if (d < 0) return 0;
      const n = Math.floor(d / 2.4), f = (d - n * 2.4) / 0.3;
      const level = (k) => { const m = ((k % 24) + 24) % 24; return m < 12 ? m + 1 : 23 - m; };
      const prev = n === 0 ? 0 : level(n - 1);
      return 0.3 * (f < 1 ? prev + (level(n) - prev) * f : level(n));
    }
    case 'craters': {
      // Bowl-shaped craters with raised rims, every 15 m.
      const c = (s - FLAT_ZONE - 4) % 15;
      if (s < FLAT_ZONE + 4 || c > 9) return 0;
      const t = c / 9; // 0..1 across the crater: a rim, a 1 m deep bowl, a rim
      return Math.sin(Math.PI * t) ** 2 * (0.4 + 1.4 * Math.cos(2 * Math.PI * t));
    }
    default: return 0;
  }
}
