// =============================================================================
// storage.js — saving builds.
//
//   • Named save slots in localStorage (stay in this browser).
//   • An autosave of the current build, restored when you reopen the game.
//   • Export/import as a .json file, so builds can be shared.
//
// File format (also what each slot stores):
//   { "app": "GearCraft", "format": 1, "name": "...", "savedAt": "ISO date",
//     "build": { "version": 1, "nextUid": N, "parts": [...] } }
// =============================================================================
import { sanitizeBuild } from '../core/build.js';

const SLOTS_KEY = 'gearcraft.saves.v1';
const AUTOSAVE_KEY = 'gearcraft.autosave.v1';
export const FILE_FORMAT = 1;

// localStorage can throw (private mode, blocked storage, quota), so every
// access is wrapped and failures are reported instead of crashing the game.
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Wrap a build into the shareable file format. */
export function toFile(build, name) {
  return { app: 'GearCraft', format: FILE_FORMAT, name, savedAt: new Date().toISOString(), build };
}

/** Parse file contents (string or object) back into a clean build. */
export function fromFile(data) {
  const obj = typeof data === 'string' ? JSON.parse(data) : data;
  // Accept both the wrapped format and a bare build.
  const build = obj && obj.build ? obj.build : obj;
  return { ...sanitizeBuild(build), name: obj?.name ?? null };
}

// ---------------------------------------------------------------- slots --
export function listSlots() {
  const slots = readJSON(SLOTS_KEY, {});
  return Object.entries(slots)
    .map(([name, v]) => ({ name, savedAt: v.savedAt, count: v.build?.parts?.length ?? 0 }))
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

export function saveSlot(name, build) {
  const slots = readJSON(SLOTS_KEY, {});
  slots[name] = toFile(build, name);
  return writeJSON(SLOTS_KEY, slots);
}

export function loadSlot(name) {
  const slots = readJSON(SLOTS_KEY, {});
  if (!slots[name]) throw new Error(`No save called "${name}"`);
  return fromFile(slots[name]);
}

export function deleteSlot(name) {
  const slots = readJSON(SLOTS_KEY, {});
  delete slots[name];
  return writeJSON(SLOTS_KEY, slots);
}

// ------------------------------------------------------------- autosave --
export const autosave = (build) => writeJSON(AUTOSAVE_KEY, toFile(build, 'autosave'));
export function loadAutosave() {
  const data = readJSON(AUTOSAVE_KEY, null);
  if (!data) return null;
  try { return fromFile(data).build; } catch { return null; }
}

// --------------------------------------------------------- file export --
/** Download the build as a .json file. */
export function exportFile(build, name = 'my-machine') {
  const safe = name.replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'my-machine';
  const blob = new Blob([JSON.stringify(toFile(build, name), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}.gearcraft.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Ask the user for a .json file and parse it. Resolves to fromFile() output. */
export function importFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try { resolve(fromFile(await file.text())); }
      catch (e) { reject(new Error(`Couldn't read that file: ${e.message}`)); }
    });
    input.click();
  });
}
