// =============================================================================
// props.js — the PROPERTY EDITOR for the selected part(s).
//
// Used in two places: the Screwdriver tool's pop-up next to your selection,
// and the "Selected" box in the right panel. With several parts selected,
// each setting changes every selected part that has it; a setting shows as
// "mixed" until you pick a value.
// =============================================================================
import { getDef, partDef, roleOf, COLLIDE_MODES, HOLE_SPACING } from '../parts/partDefs.js';
import { keyLabel } from '../render/draw.js';

/** Keys a Key control can listen for. (Space plays/pauses, so it's not here.) */
export const KEY_CHOICES = ['w', 'a', 's', 'd', 'q', 'e', 'z', 'x', 'c', 'f', 'g',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '1', '2', '3', '4', '5'];

/** Every editable property, and which parts have it. */
const PROPS = [
  { key: 'collide', label: 'Collisions', type: 'choice', default: 'normal',
    options: COLLIDE_MODES.map(([v, l]) => [v, l]),
    title: COLLIDE_MODES.map(([, l, tip]) => `${l}: ${tip}`).join('\n'),
    has: (def) => !['link', 'connector', 'control'].includes(roleOf(def.kind)) && !isMap(def) && def.kind !== 'motor' && def.kind !== 'crank' },
  { key: 'anchored', label: '⚓ Anchored', type: 'toggle', default: false,
    title: 'Bolted to the background: it stays exactly where it is.',
    has: (def) => !['link', 'control'].includes(roleOf(def.kind)) && !isMap(def) && def.kind !== 'fixedPin' && def.kind !== 'rotPin' },
  { key: 'reverse', label: 'Reverse direction', type: 'toggle', default: false, has: (def) => def.kind === 'motor' },
  { key: 'keyCW', label: '⌨️ ↻ Clockwise key', type: 'select', default: 'none', options: keyOptions(true),
    title: 'Hold this key to turn the motor clockwise (rolls a car to the RIGHT). With keys set, it only runs while you hold one.',
    value: (p) => p.props.keyCW ?? (p.props.keys ? 'arrowright' : 'none'),
    has: (def) => def.kind === 'motor' },
  { key: 'keyCCW', label: '⌨️ ↺ Counter-clockwise key', type: 'select', default: 'none', options: keyOptions(true),
    title: 'Hold this key to turn the motor counter-clockwise (rolls a car to the LEFT).',
    value: (p) => p.props.keyCCW ?? (p.props.keys ? 'arrowleft' : 'none'),
    has: (def) => def.kind === 'motor' },
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
    has: (def) => def.kind === 'switch' || def.kind === 'button' },
];

function keyOptions(withNone) {
  return [...(withNone ? [['none', '— none —']] : []), ...KEY_CHOICES.map((k) => [k, keyLabel(k)])];
}

const isMap = (def) => def.kind === 'ramp' || def.kind === 'block' || def.kind === 'track';

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
    const label = owners.length < parts.length ? `${prop.label} <small>(${owners.length})</small>` : prop.label;
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
    const sel = document.createElement('select');
    sel.className = 'select';
    if (value === undefined) sel.insertAdjacentHTML('beforeend', '<option value="">mixed</option>');
    for (const [v, text] of prop.options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = text;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { if (sel.value) set(sel.value); });
    wrap.appendChild(sel);
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

/** Does any part in this list have something the Screwdriver can set? */
export const hasProps = (parts) => parts.some((p) => PROPS.some((prop) => prop.has(partDef(p))));
