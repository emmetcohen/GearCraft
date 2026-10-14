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
import { renderProps } from '../ui/props.js';
import { EXAMPLES } from '../save/examples.js';

export const sandboxMode = {
  id: 'sandbox',
  name: 'Sandbox',
  map: { groundHalfWidth: Infinity }, // endless ground
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

    // ---- selected part(s) -------------------------------------------------
    const sel = panel.section('Selected', { id: 'sel-section' });
    const selBody = document.createElement('div');
    sel.appendChild(selBody);
    const renderSelection = () => renderProps(selBody, app, app.selectedParts(), { actions: true });
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
      label: '🎥 Camera follows while playing', checked: app.options.follow,
      title: 'When you press Play, the camera follows your vehicle. Click any part while playing to follow it instead.',
      onChange: (v) => { app.options.follow = v; if (!v && app.sim) app.follow(null); },
    });
    panel.toggle(view, {
      label: 'Snap to grid', checked: app.options.grid,
      onChange: (v) => { app.options.grid = v; },
    });
    panel.toggle(view, {
      label: 'Show joints', checked: app.options.joints,
      title: 'Little markers where parts join: ■ bolted solid, ○ spins freely, yellow = driven by a motor/crank',
      onChange: (v) => { app.options.joints = v; },
    });
    view.insertAdjacentHTML('beforeend',
      `<p class="legend"><span class="j weld"></span>bolted <span class="j spin"></span>spins <span class="j drive"></span>driven</p>`);
    panel.toggle(view, {
      label: 'Auto-pin gears', checked: app.options.autoPin,
      title: 'A gear dropped in empty space gets a rotating pin so it can spin in place',
      onChange: (v) => { app.options.autoPin = v; },
    });
    this._loadToggle = loadToggle;

    // ---- help ------------------------------------------------------------
    const help = panel.section('How to build', { collapsible: true });
    help.insertAdjacentHTML('beforeend', `<ul class="tips">
      <li><b>Toolbar</b> (under the world): <kbd>1</kbd> Move · <kbd>2</kbd> Rotate · <kbd>3</kbd> Scale · <kbd>4</kbd> Wrench · <kbd>5</kbd> Screwdriver · <kbd>6</kbd> Delete.</li>
      <li><b>Select:</b> click a part, <kbd>Shift</kbd>-click to add more, or drag a box on empty space. <kbd>Ctrl/⌘+A</kbd> selects all.</li>
      <li><b>Place:</b> click a part on the left, then click the world as often as you like. <kbd>Esc</kbd> or right-click to stop.</li>
      <li><b>Beams, springs, ropes, sliders, track:</b> drag from one point to another to draw them.</li>
      <li>Gears <b>snap</b> to mesh (white dot). Drop a gear <b>between two gears</b> and it meshes with both.</li>
      <li><b>Bolt a beam onto a gear:</b> draw the beam across the gear, then press <kbd>G</kbd> (Bolt) and click where they overlap. Now they turn together. Works on wheels and crates too.</li>
      <li><b>Ropes &amp; springs:</b> untick <b>Anchored</b> (Screwdriver) and a loose end hangs free on a hook.</li>
      <li><b>Scale</b> a gear for more teeth, a wheel for a bigger tyre, a crate or block for a bigger box.</li>
      <li><b>Wrench:</b> click a Switch, Button or Key, then a motor. While playing, use the control to run the motor.</li>
      <li><b>Screwdriver:</b> collisions (normal / everything / none), anchored, and each part's own settings.</li>
      <li><b>Chain:</b> click one sprocket, then another. <b>Train:</b> draw a beam between two drive wheels' yellow <b>crank pins</b>.</li>
      <li><kbd>Q</kbd>/<kbd>E</kbd> rotate · <kbd>Del</kbd> delete · <kbd>Ctrl/⌘+C</kbd>/<kbd>V</kbd> copy/paste · <kbd>Ctrl/⌘+D</kbd> duplicate · <kbd>Space</kbd> play</li>
      <li><b>View:</b> right-drag or arrow keys to pan, scroll to zoom. While playing the camera follows your vehicle; click any part and press <b>🎥 Follow this</b> to follow something else.</li>
      <li><b>Drive with keys:</b> use the Screwdriver on a motor and pick a ↻ clockwise key and a ↺ counter-clockwise key (clockwise rolls a car right). Or wire a <b>Key</b> control (A / D by default) to several motors.</li>
    </ul>`);
  },

  onKey(app, e) {
    if (e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.metaKey) {
      app.options.loadView = !app.options.loadView;
      this._loadToggle?.set(app.options.loadView);
      app.toast(app.options.loadView ? '🌡 Load view on' : 'Load view off');
    }
  },
};
