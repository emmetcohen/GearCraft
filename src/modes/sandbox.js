// =============================================================================
// sandbox.js — SANDBOX MODE: free building on an open test map.
//
// A "mode" is a plain object the App reads. It decides:
//   map              the world (ground size...)
//   defaultSettings  starting slider values
//   partFilter       which gallery parts are available
//   autoPinType      which anchor to auto-add under free-standing gears
//   setup(app)       builds the right-hand panel for this mode
//   onKey(app, e)    extra keyboard shortcuts
//
// The puzzle mode (puzzle.js, later) will be another object with the same
// shape, plus goals/level data. Parts and physics never import modes.
// =============================================================================
import { getDef } from '../parts/partDefs.js';
import { findPart } from '../core/build.js';
import { EXAMPLES } from '../save/examples.js';

export const sandboxMode = {
  id: 'sandbox',
  name: 'Sandbox',
  map: { groundHalfWidth: 300 },
  defaultSettings: { gravity: 10, friction: 0.6, motorTorque: 60, motorRpm: 30 },
  // Sandbox allows every part, and anchors can go ANYWHERE on the map.
  partFilter: () => true,
  autoPinType: 'pin-rotating',

  /** First visit (no autosave yet): start with a small demo machine. */
  starter() {
    const ex = EXAMPLES[0];
    return { build: ex.build(), camera: ex.camera };
  },

  setup(app) {
    const { panel } = app;

    // ---- selected part ---------------------------------------------------
    const sel = panel.section('Selected part', { id: 'sel-section' });
    const selBody = document.createElement('div');
    sel.appendChild(selBody);
    const renderSelection = () => {
      selBody.innerHTML = '';
      const part = app.selectedUid != null ? findPart(app.sim ? { parts: app.sim.parts } : app.build, app.selectedUid) : null;
      if (!part) {
        selBody.innerHTML = '<p>Click a part to select it.</p>';
        return;
      }
      const def = getDef(part.type);
      const p = document.createElement('p');
      p.innerHTML = `<b>${def.name}</b>${def.teeth ? ` · ${def.teeth} teeth` : ''}${def.layers ? ` · ${def.layers.join('/')} teeth` : ''} · ${def.mass} kg`;
      selBody.appendChild(p);
      if (!app.editable) {
        selBody.insertAdjacentHTML('beforeend', '<p><i>Reset to edit.</i></p>');
        return;
      }
      panel.buttons(selBody, [
        { label: '⟲', title: 'Rotate left (Q)', onClick: () => app.rotateSelected(1) },
        { label: '⟳', title: 'Rotate right (E)', onClick: () => app.rotateSelected(-1) },
        { label: '🗑 Delete', title: 'Delete (Del)', className: 'btn-danger', onClick: () => app.deleteSelected() },
      ]);
      if (def.kind === 'motor') {
        panel.toggle(selBody, {
          label: 'Reverse direction', checked: !!part.props.reverse,
          onChange: (v) => app.setPartProp(part.uid, 'reverse', v),
        });
      }
    };
    app.on((type) => { if (type === 'select' || type === 'state' || type === 'changed') renderSelection(); });
    renderSelection();

    // ---- world & motor sliders ---------------------------------------------
    // These apply live, even while the machine is running.
    const world = panel.section('World & motors');
    const s = app.settings;
    panel.slider(world, {
      label: 'Gravity', min: 0, max: 30, step: 0.5, value: s.gravity,
      format: (v) => `${v.toFixed(1)} m/s²`, onInput: (v) => app.setSetting('gravity', v),
    });
    panel.slider(world, {
      label: 'Friction', min: 0, max: 1.5, step: 0.05, value: s.friction,
      format: (v) => `×${v.toFixed(2)}`, onInput: (v) => app.setSetting('friction', v),
    });
    panel.slider(world, {
      label: 'Motor power (max torque)', min: 5, max: 300, step: 5, value: s.motorTorque,
      format: (v) => `${v} N·m`, onInput: (v) => app.setSetting('motorTorque', v),
    });
    panel.slider(world, {
      label: 'Motor speed', min: 0, max: 120, step: 1, value: s.motorRpm,
      format: (v) => `${v} RPM`, onInput: (v) => app.setSetting('motorRpm', v),
    });

    // ---- view & building options ------------------------------------------
    const view = panel.section('View & snapping');
    const loadToggle = panel.toggle(view, {
      label: '🌡 Load view', checked: app.options.loadView,
      title: 'Colour parts by how hard they work while running: green = easy, red = near stall (L)',
      onChange: (v) => { app.options.loadView = v; },
    });
    view.insertAdjacentHTML('beforeend',
      '<p style="margin:-2px 0 6px 26px;font-size:11.5px">Green = easy · Yellow = working · Red = near stall. Shows while running.</p>');
    panel.toggle(view, {
      label: 'Snap to grid', checked: app.options.grid,
      onChange: (v) => { app.options.grid = v; },
    });
    panel.toggle(view, {
      label: 'Auto-pin gears', checked: app.options.autoPin,
      title: 'A gear dropped in empty space gets a rotating pin so it can spin in place',
      onChange: (v) => { app.options.autoPin = v; },
    });
    this._loadToggle = loadToggle;

    // ---- help ------------------------------------------------------------
    const help = panel.section('How to build');
    help.innerHTML += `<ul class="tips">
      <li>Drag parts from the left onto the world.</li>
      <li>Gears <b>snap</b> to mesh. A white dot = meshed.</li>
      <li>Put gears &amp; wheels on a <b>motor</b>, a <b>pin</b> or a beam hole.</li>
      <li>Things stacked on one point share an axle.</li>
      <li><kbd>Q</kbd>/<kbd>E</kbd> rotate · <kbd>Del</kbd> delete · <kbd>Space</kbd> play/pause</li>
      <li>Drag empty space to pan, scroll to zoom.</li>
      <li>While running: drag a <b>crank</b> handle to turn it, or grab loose objects.</li>
    </ul>`;
  },

  onKey(app, e) {
    if (e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.metaKey) {
      app.options.loadView = !app.options.loadView;
      this._loadToggle?.set(app.options.loadView);
      app.toast(app.options.loadView ? '🌡 Load view on' : 'Load view off');
    }
  },
};
