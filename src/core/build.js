// =============================================================================
// build.js — the BUILD is the player's machine as plain JSON-friendly data.
//
//   build = {
//     version: 1,
//     nextUid: 12,
//     parts: [ { uid, type, x, y, angle, props: {...} }, ... ]
//   }
//
// Keeping the build as plain data (no physics objects inside!) is what makes
// save/load, undo/redo and "reset to pre-play state" trivial: we just copy it.
// The physics world is always rebuilt FROM the build when you press Play.
// =============================================================================
import { hasDef } from '../parts/partDefs.js';

export const BUILD_VERSION = 1;

export function emptyBuild() {
  return { version: BUILD_VERSION, nextUid: 1, parts: [] };
}

/** Deep copy (builds are small, so JSON round-trip is simple and safe). */
export function cloneBuild(build) {
  return JSON.parse(JSON.stringify(build));
}

/** Add a new part and return it. */
export function addPart(build, type, x, y, angle = 0, props = {}) {
  const part = { uid: build.nextUid++, type, x, y, angle, props: { ...props } };
  build.parts.push(part);
  return part;
}

export function findPart(build, uid) {
  return build.parts.find((p) => p.uid === uid) || null;
}

export function removePart(build, uid) {
  const i = build.parts.findIndex((p) => p.uid === uid);
  if (i >= 0) build.parts.splice(i, 1);
}

/**
 * Validate + normalise a build loaded from storage or an imported file.
 * Unknown part types are dropped (with a count) instead of crashing, so old
 * saves keep working if a part is ever removed.
 */
export function sanitizeBuild(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.parts)) {
    throw new Error('Not a GearCraft build file');
  }
  const out = emptyBuild();
  let dropped = 0;
  for (const p of data.parts) {
    if (!p || !hasDef(p.type) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      dropped++; continue;
    }
    out.parts.push({
      uid: Number.isInteger(p.uid) ? p.uid : 0,
      type: p.type,
      x: p.x, y: p.y,
      angle: Number.isFinite(p.angle) ? p.angle : 0,
      props: p.props && typeof p.props === 'object' ? { ...p.props } : {},
    });
  }
  // Re-number uids if any are missing/duplicated.
  const seen = new Set();
  let next = 1;
  for (const p of out.parts) next = Math.max(next, p.uid + 1);
  for (const p of out.parts) {
    if (p.uid <= 0 || seen.has(p.uid)) p.uid = next++;
    seen.add(p.uid);
  }
  out.nextUid = next;
  return { build: out, dropped };
}
