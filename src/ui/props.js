// =============================================================================
// props.js — the PROPERTY EDITOR for the selected part(s).
//
// Used in two places: the Screwdriver tool's pop-up next to your selection,
// and the "Selected" box in the right panel. With several parts selected,
// each setting changes every selected part that has it; a setting shows as
// "mixed" until you pick a value.
//
// Keys are set by clicking the key box and then pressing the key you want
// (Esc cancels, Backspace clears).
// =============================================================================
import { getDef, partDef, roleOf, COLLIDE_MODES, HOLE_SPACING } from '../parts/partDefs.js';
import { keyLabel } from '../render/draw.js';

/** Common keys (kept for old code; any key can be picked by pressing it).
 *  Space plays/pauses, so it can't be used. */
export const KEY_CHOICES = ['w', 'a', 's', 'd', 'q', 'e', 'z', 'x', 'c', 'f', 'g',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '1', '2', '3', '4', '5'];

/** Every editable property, and which parts have it. */
const PROPS = [
  { key: 'collide', label: 'Collisions', type: 'choice', default: 'normal',
    options: COLLIDE_MODES.map(([v, l]) => [v, l]),
    title: COLLIDE_MODES.map(([, l, tip]) => `${l}: ${tip}`).join('\n'),
    has: (def) => !['link', 'connector', 'control', 'bolt', 'gadget', 'latch'].includes(roleOf(def.kind)) && !isMap(def) && def.kind !== 'motor' && def.kind !== 'crank' },
  { key: 'anchored', label: '⚓ Anchored', type: 'toggle', default: false,
    title: 'Bolted to the background: it stays exactly where it is.',
    has: (def) => !['link', 'control', 'bolt', 'gadget', 'latch', 'door'].includes(roleOf(def.kind)) && !isMap(def) && def.kind !== 'fixedPin' && def.kind !== 'rotPin' },
  { key: 'extended', label: 'Starts pushed out', type: 'toggle', default: false,
    title: 'On: the rod starts all the way out (things on its top joint go up there too).',
    has: (def) => def.kind === 'piston' },
  { key: 'pinEnds', label: '⚓ Anchored', type: 'toggle', default: true,
    title: 'On: an end touching nothing is pinned to the background. Off: it hangs free with a little hook.',
    has: (def) => def.kind === 'rope' || def.kind === 'spring' },
  { key: 'reverse', label: 'Reverse direction', type: 'toggle', default: false, has: (def) => def.kind === 'motor' },
  { key: 'keyCW', label: '⌨️ ↻ Clockwise key', type: 'select', default: 'none', options: keyOptions(true),
    title: 'Hold this key to turn the motor clockwise (rolls a car to the RIGHT). With keys set, it only runs while you hold one.',
    value: (p) => p.props.keyCW ?? (p.props.keys ? 'arrowright' : 'none'),
    has: (def) => def.kind === 'motor' },
  { key: 'keyCCW', label: '⌨️ ↺ Counter-clockwise key', type: 'select', default: 'none', options: keyOptions(true),
    title: 'Hold this key to turn the motor counter-clockwise (rolls a car to the LEFT).',
    value: (p) => p.props.keyCCW ?? (p.props.keys ? 'arrowleft' : 'none'),
    has: (def) => def.kind === 'motor' },
  // Gadget keys: what "+" and "−" mean depends on the gadget.
  { key: 'keyPlus', type: 'select', default: 'none', options: keyOptions(true),
    label: (def) => ({ piston: '⬆ Push-out key', thruster: '🔥 Fire key', magnet: '🧲 On key', cannon: '💥 Fire key', conveyor: '→ Forward key',
      trapdoor: '🚪 Open key', latch: '🔓 Let-go key', bomb: '💣 Boom key' }[def.kind]),
    title: 'Hold this key while playing. With no keys (and no wires) it just runs on its own.',
    has: (def) => ['piston', 'thruster', 'magnet', 'cannon', 'conveyor', 'trapdoor', 'latch', 'bomb'].includes(def.kind) },
  { key: 'keyMinus', type: 'select', default: 'none', options: keyOptions(true),
    label: (def) => ({ piston: '⬇ Pull-in key', thruster: '↩ Reverse key', conveyor: '← Backward key' }[def.kind]),
    has: (def) => ['piston', 'thruster', 'conveyor'].includes(def.kind) },
  { key: 'thrust', label: 'Thrust', type: 'choice', default: 'medium',
    options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], has: (def) => def.kind === 'thruster' },
  { key: 'power', label: 'Power', type: 'choice', default: 'medium',
    options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], has: (def) => def.kind === 'cannon' },
  { key: 'opens', label: 'Opens', type: 'choice', default: 'down',
    options: [['down', '⬇ Down'], ['up', '⬆ Up']], has: (def) => def.kind === 'trapdoor' },
  { key: 'speed', label: 'Speed', type: 'choice', default: 'gentle',
    options: [['gentle', 'Gentle'], ['fast', 'Snap! (catapult)']], has: (def) => def.kind === 'trapdoor' },
  { key: 'every', label: 'Flips every', type: 'choice', default: 1,
    options: [[0.5, '½ s'], [1, '1 s'], [2, '2 s'], [4, '4 s']], has: (def) => def.kind === 'timer' },
  { key: 'idle', label: 'When not powered', type: 'choice', default: 'brake',
    options: [['brake', 'Brake'], ['free', 'Spin free']],
    title: 'For motors run by keys or wired controls: what happens when nothing is pressed.',
    has: (def) => def.kind === 'motor' },
  { key: 'stiffness', label: 'Stiffness', type: 'choice', default: 'medium',
    options: [['soft', 'Soft'], ['medium', 'Medium'], ['stiff', 'Stiff']], has: (def) => def.kind === 'spring' },
  { key: 'on', label: 'Starts on', type: 'toggle', default: false, has: (def) => def.kind === 'switch' },
  { key: 'keyCW', label: '↻ Clockwise key', type: 'select', default: 'd', options: keyOptions(true),
    title: 'Hold it to turn wired motors clockwise (rolls a car to the RIGHT).',
    value: (p) => p.props.keyCW ?? (p.props.key != null && p.props.keyCCW == null ? 'none' : 'd'),
    has: (def) => def.kind === 'keyButton' },
  { key: 'keyCCW', label: '↺ Counter-clockwise key', type: 'select', default: 'a', options: keyOptions(true),
    title: 'Hold it to turn wired motors counter-clockwise (rolls a car to the LEFT).',
    value: (p) => p.props.keyCCW ?? (p.props.key != null && p.props.keyCW == null ? p.props.key : 'a'),
    has: (def) => def.kind === 'keyButton' },
  { key: 'reverse', label: 'Makes motors go', type: 'choice', default: false,
    options: [[false, 'Forward'], [true, 'Reverse']],
    has: (def) => ['switch', 'button', 'timer', 'pressurePlate'].includes(def.kind) },
];

function keyOptions(withNone) {
  return [...(withNone ? [['none', '— none —']] : []), ...KEY_CHOICES.map((k) => [k, keyLabel(k)])];
}

const isMap = (def) => ['ramp', 'block', 'track', 'conveyor', 'bouncePad', 'water'].includes(def.kind);

/**
 * Fill `root` with controls for `parts`.
 * @param app    the App (for setProps / rotate / delete)
 * @param opts   { actions: bool } also show rotate/delete buttons
 */
export function renderProps(root, app, parts, opts = {}) {
  root.innerHTML = '';
  if (!parts.length) { root.innerHTML = '<p class="muted">Click a part to select it. Shift-click or drag a box to pick several.</p>'; return; }
  const defs = parts.map((p) => partDef(p));
  // Title line.
  const head = document.createElement('p');
  if (parts.length === 1) {
    const def = defs[0];
    const len = def.drawn ? ` · ${(def.length / HOLE_SPACING).toFixed(1).replace(/\.0$/, '')} holes long` : '';
    const mass = def.mass ? ` · ${+def.mass.toFixed(2)} kg` : '';
    const teeth = def.teeth ? ` · ${def.teeth} teeth` : '';
    head.innerHTML = `<b>${def.name}</b>${teeth}${len}${mass}`;
  } else {
    head.innerHTML = `<b>${parts.length} parts selected</b>`;
  }
  root.appendChild(head);
  if (parts.length === 1 && defs[0].tip && opts.tips !== false) root.insertAdjacentHTML('beforeend', `<p class="hint">${defs[0].tip}</p>`);

  if (opts.actions && app.editable) {
    const row = document.createElement('div');
    row.className = 'btn-row';
    const mk = (label, title, fn, cls = '') => {
      const b = document.createElement('button');
      b.className = `btn small ${cls}`;
      b.textContent = label; b.title = title;
      b.addEventListener('click', fn);
      row.appendChild(b);
    };
    mk('⟲', 'Rotate left (Q)', () => app.rotateSelection(1));
    mk('⟳', 'Rotate right (E)', () => app.rotateSelection(-1));
    mk('⧉', 'Duplicate (Ctrl/⌘+D)', () => app.duplicateSelection());
    mk('🗑 Delete', 'Delete (Del)', () => app.deleteSelection(), 'btn-danger');
    root.appendChild(row);
  }
  if (!app.editable) { root.insertAdjacentHTML('beforeend', '<p><i>Reset to edit.</i></p>'); return; }

  for (const prop of PROPS) {
    const owners = parts.filter((p, i) => prop.has(defs[i]));
    if (!owners.length) continue;
    const values = owners.map((p) => (prop.value ? prop.value(p) : p.props[prop.key] ?? prop.default));
    const same = values.every((v) => v === values[0]);
    const value = same ? values[0] : undefined;
    const set = (v) => app.setProps(owners.map((p) => p.uid), prop.key, v);
    const base = typeof prop.label === 'function' ? prop.label(defs[parts.indexOf(owners[0])]) : prop.label;
    const label = owners.length < parts.length ? `${base} <small>(${owners.length})</small>` : base;
    root.appendChild(control(prop, label, value, set));
  }
}

function control(prop, label, value, set) {
  const wrap = document.createElement('div');
  if (prop.title) wrap.title = prop.title;
  if (prop.type === 'toggle') {
    wrap.className = 'toggle';
    wrap.innerHTML = `<input type="checkbox"><span>${label}</span>`;
    const input = wrap.querySelector('input');
    input.checked = value === true;
    input.indeterminate = value === undefined;
    input.addEventListener('change', () => set(input.checked));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) input.click(); });
    return wrap;
  }
  wrap.className = 'choice';
  wrap.innerHTML = `<span>${label}</span>`;
  if (prop.type === 'select') {
    wrap.appendChild(keyPicker(value, set));
    return wrap;
  }
  const row = document.createElement('div');
  row.className = 'seg';
  for (const [v, text] of prop.options) {
    const b = document.createElement('button');
    b.className = `seg-btn${v === value ? ' on' : ''}`;
    b.textContent = text;
    b.addEventListener('click', () => set(v));
    row.appendChild(b);
  }
  wrap.appendChild(row);
  return wrap;
}

// ------------------------------------------------------------ key picker --
/** Cancels the key box that's waiting for a key press (only one at a time). */
let stopListening = null;

/** Keys that can't be used (Space plays/pauses). */
const RESERVED = [' '];

/**
 * A key box: shows the key; click it, then press any key to use that one.
 * Esc cancels, Backspace/Delete sets "none".
 */
function keyPicker(value, set) {
  const row = document.createElement('div');
  row.className = 'key-pick';
  const box = document.createElement('button');
  box.className = 'key-box';
  const show = () => {
    box.classList.remove('listening');
    box.textContent = value === undefined ? 'mixed' : value === 'none' ? '— none —' : keyLabel(value);
    box.classList.toggle('empty', value === 'none' || value === undefined);
  };
  show();
  box.title = 'Click, then press the key you want';
  const clear = document.createElement('button');
  clear.className = 'key-clear';
  clear.textContent = '✕';
  clear.title = 'No key';
  clear.hidden = value === 'none';
  clear.addEventListener('click', () => set('none'));

  box.addEventListener('click', (e) => {
    e.stopPropagation();
    if (stopListening) { const was = box.classList.contains('listening'); stopListening(); if (was) return; }
    box.classList.add('listening');
    box.textContent = 'Press a key…';
    const onKey = (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const k = ev.key.toLowerCase();
      if (k === 'escape') return done();
      if (k === 'backspace' || k === 'delete') { done(); set('none'); return; }
      if (RESERVED.includes(k)) { box.textContent = 'Not Space! Another key…'; return; }
      done();
      set(k);
    };
    const onPointer = (ev) => { if (ev.target !== box) done(); };
    const done = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      stopListening = null;
      show();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    stopListening = done;
  });
  row.append(box, clear);
  return row;
}

/** Does any part in this list have something the Screwdriver can set? */
export const hasProps = (parts) => parts.some((p) => PROPS.some((prop) => prop.has(partDef(p))));
