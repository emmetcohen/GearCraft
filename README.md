# ⚙️ GearCraft

A cartoony 2D physics building sandbox. Build machines out of **gears, chains,
wheels, beams, springs and motors**, press Play, and real torque and speed rules decide whether
your machine works. Parts never break: if something is too heavy, the motor
simply slows down or stalls.

- Plain HTML + JavaScript (ES modules). No build step.
- Physics by [Planck.js](https://github.com/piqnt/planck.js) (a Box2D port), vendored in `lib/`.
- Rendering on a plain HTML `<canvas>`.

---

## Run it locally

ES modules don't load from `file://`, so serve the folder with any static web
server, then open the address it prints.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (`npx serve .` works too.)

### Run the tests

The gear math, joining rules, snapping and physics are plain modules, so they
run headless in Node 18+:

```bash
node tests/run.mjs
```

## Publish on GitHub Pages

1. Create a repository on GitHub and push this folder to its `main` branch:
   ```bash
   git remote add origin https://github.com/<you>/gearcraft.git
   git push -u origin main
   ```
2. On GitHub open **Settings → Pages**.
3. Under **Build and deployment**, set **Source: Deploy from a branch**, pick
   **Branch: `main`** and folder **`/ (root)`**, then **Save**.
4. After a minute your game is live at `https://<you>.github.io/gearcraft/`.

`index.html` is at the repo root and every path is relative, so nothing else
needs configuring. (`.nojekyll` tells Pages to serve the files as-is.)

---

## How to play

| Do this | How |
|---|---|
| Place a part | Drag it from the gallery onto the world, **or click it** to pick it as a tool and click the world as often as you like |
| Put the tool down | **Esc**, **right-click**, **V**, or click the part again |
| Draw beams, springs, ropes, sliders, track | Pick the tool, then **drag from one point to the other** (or click, click). Ends snap onto holes, pins and shafts; **Alt** = any angle |
| Stretch / swing a drawn part | Select it and drag its pink end handles |
| Chain | Pick **Chain** (**C**), click one sprocket or gear, then another |
| Quick tools | The dock under the world, or keys: **B** beam · **A** axle · **H** hinge · **P** rotating pin · **F** fixed pin · **C** chain · **S** spring · **O** rope · **J** slider · **T** track |
| Move | Drag a placed part |
| Numbers (RPM, torque, ratio) | Click a gear, wheel or motor |
| Rotate | **Q** / **E** (or the ⟲ ⟳ buttons) |
| Delete | **Del** / **Backspace** |
| Undo / redo | **Ctrl/⌘+Z**, **Ctrl/⌘+Shift+Z** (or **Ctrl+Y**) |
| Play / pause | **Space** |
| Reset to your pre-play build | ⟲ Reset, or **R** while running |
| Pan / zoom | Drag empty space (or right/middle-drag), mouse wheel, **Home** recentres |
| Load view | Toggle in the right panel, or **L** |
| Save / load / share | 💾 Save / Load (**Ctrl/⌘+S**): named slots, examples, export/import `.json` |
| Drive | Tick **Drive with ← / → keys** on a motor, then hold **←** / **→** while running |
| While running | Drag a **hand crank's** handle in circles to turn it. Grab loose objects to fling them. Select a part and the camera follows it. |

### Building rules (how parts join)

Every part has **sockets**: gear and wheel centres, every beam hole, motor
shafts, pins. Parts whose sockets sit on the same spot are **joined** there.
With **Show joints** on, a marker shows what each joint does: ■ bolted, ○ spins
freely, yellow = driven.

- **Gears, sprockets and wheels stacked on one point share an axle.** They always turn together (stack a big and a small gear for a compound gear).
- That shared axle **spins freely** in whatever holds it: a beam hole, a **rotating pin**, or a **motor/crank** (which drives it).
- **Beams on the same point are bolted together**, unless there's a **hinge** there, in which case they pivot.
- An **axle** part also locks the *beams* on that point to the gears, so a beam turns with the gear (arms, levers).
- A **fixed pin** bolts everything on it to the background. Nothing there can turn (except a motor's shaft).
- A **motor** on a beam rides along with it (cars!). Anywhere else it's bolted to the background.
- **Gears mesh** when their teeth touch. The snapper places them exactly. A **white dot** marks a working mesh; a **red dot** means a problem (no axle, or jammed).
- A **chain** links two sprockets (or gears) at any distance; both turn the **same** way.
- **Drive wheels** have a yellow **crank pin**. A beam hole on it always **pivots**: train side rods, pistons, walking legs. A rod hooked on a pin never bolts onto that wheel's other holes.
- A **slider** is a rail with a sliding block. The rail is bolted to the background unless something holds its end holes; hook a rod from a crank pin onto the block for a piston.
- **Springs** and **ropes** grab whatever their ends touch (a socket, or any part). An end touching nothing hangs on the background (shown with a little green pin).
- **Track** is part of the map: lay roads, hills and bridges; ends snap together.
- With **Auto-pin gears** on, a gear or sprocket dropped in empty space gets a rotating pin automatically.

### The gear maths

GearCraft never simulates individual teeth. It builds a **gear-train graph**
from the snap data and applies ratio math along each mesh:

```
speed_out  = −speed_in × (teeth_in / teeth_out)     (meshed gears turn opposite ways)
speed_out  = +speed_in × (teeth_in / teeth_out)     (chains keep the direction)
torque_out =  torque_in × (teeth_out / teeth_in)    (slower = stronger)
```

An idler gear flips direction twice, so it passes direction through. A loop of
gears that disagrees with itself (e.g. three gears in a triangle), or a gear
meshed with something bolted down, is **jammed**: it won't turn and the motor
stalls.

Each mesh becomes a Box2D **GearJoint** with exactly that ratio. Motors are
joint motors with a **max torque**. The physics engine pushes torque through
the gear joints, so weight, friction, slopes and inertia all fight back, and a
motor that can't supply enough torque slows down or stalls.

---

## Project structure

```
index.html            entry point (GitHub Pages serves this)
styles.css            cartoon UI styles
lib/planck.mjs        Planck.js 1.4.2 (vendored, MIT, see PLANCK-LICENSE.txt)
src/
  main.js             picks a mode and starts the app
  app.js              controller: state, input, play/pause/reset, render loop
  parts/
    partDefs.js       ★ every part as data: name, category, size, teeth, mass, shape, colour
    geometry.js       sockets, hit-testing (pure functions)
    snap.js           socket / mesh / grid snapping + tooth alignment
  physics/
    assembly.js       joining rules → rigid bodies + revolute joints (pure)
    gearTrain.js      gear-train graph, ratios, jam detection (pure)
    world.js          builds & steps the Planck world; motors, telemetry, stalls
  render/
    draw.js           cartoon painters for each part kind
    renderer.js       camera, sky/ground, draw order, overlays
  ui/
    gallery.js        left parts gallery (built from partDefs)
    panel.js          right-panel widgets (sliders, toggles, buttons)
    readout.js        floating RPM / torque / ratio card
    saveDialog.js     save/load/examples/export/import window
  modes/
    sandbox.js        sandbox mode: map, default settings, panel contents
    puzzle.js         stub for the future puzzle mode (documents the plan)
  core/
    build.js          the build data model (plain JSON)
    history.js        snapshot undo/redo
  save/
    storage.js        localStorage slots, autosave, file export/import
    examples.js       ready-made example machines
tests/run.mjs         headless tests (node tests/run.mjs)
```

**Layering:** `parts/`, `physics/` and `core/` never touch the DOM or import
a mode. Modes and UI sit on top. That's what lets a puzzle mode plug in later
without touching the physics.

### Adding a part

Add an entry to `PARTS` in `src/parts/partDefs.js`. A new *size* of an
existing kind (say a 40-tooth gear) needs nothing else:

```js
{ id: 'gear-40', name: 'Gear 40T', category: 'gears', kind: 'gear', size: 'XXL',
  teeth: 40, mass: 3.2, shape: 'gear', color: '#f77f00' },
```

A brand-new *kind* also needs a painter in `render/draw.js`, a collision
shape in `physics/world.js` and, if it joins things, a rule in
`physics/assembly.js`. The planned parts (worm gear, rack & pinion,
bevel/idler, cam, crank & slider, pulley/belt, chain/sprocket, spring,
brake/clutch, sliding rail anchor, hanging weight) are already listed as
`placeholder: true` entries, so they show greyed out in the gallery.

### Save file format

```json
{ "app": "GearCraft", "format": 1, "name": "My car", "savedAt": "…",
  "build": { "version": 1, "nextUid": 9,
    "parts": [ { "uid": 1, "type": "gear-12", "x": 0, "y": 4, "angle": 0, "props": {} } ] } }
```

Unknown part types are skipped on import, so old files keep loading.

---

## Known issues

- **Machine parts don't collide with each other.** Gears, beams and motors pass through one another (gears are linked by ratio math, not tooth contact). They do collide with the ground and test objects.
- **Meshing is decided when you press Play.** Gears that swing into or out of contact during a run (e.g. on a moving arm) don't mesh or unmesh mid-run.
- **Compound gears are flat.** A gear meshing with the small layer visually overlaps the big layer.
- **One set of motor sliders.** All motors share the speed and torque sliders; only direction is per motor. Two motors in the same gear train fight each other, and readouts use the first one.
- **Long gear chains under heavy load can feel slightly springy**, a property of Box2D's iterative solver. Parts pinned to the background can push a little into the ground when a motor shoves them against it.
- **Load view shows motor effort** (how close the driving motor is to stalling), not per-gear stress.
- Wheel and gear RPM readouts are relative to the part they're mounted on (e.g. a car chassis).
- Moving a part doesn't drag along what's attached to it (except a pin sitting under a gear or motor).
- If the browser can't keep up (or the tab is throttled), the simulation runs in slow motion rather than skipping ahead.
- Undo history doesn't survive a page reload (the autosave does).
- Touch works for placing and dragging, but there's no pinch-zoom yet (use the ＋/－ buttons).
- Puzzle mode, levels and scoring are intentionally not built yet (see `src/modes/puzzle.js`).

## License

GearCraft code: yours to choose. Planck.js is MIT-licensed (`lib/PLANCK-LICENSE.txt`).
