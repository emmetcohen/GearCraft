// =============================================================================
// world.js — builds and runs the Planck.js (Box2D) physics world from a build.
//
//   build ──assembly.js──▶ bodies + revolute joints (who spins on what)
//         ──gearTrain.js─▶ gear graph + ratios      (who drives whom)
//         ──this file────▶ real Planck bodies, RevoluteJoints, GearJoints
//
// Why GearJoints? A Box2D GearJoint links two revolute joints so that
//     angleA + ratio × angleB = constant
// which is EXACTLY the ratio math from gearTrain.js. The physics engine then
// pushes torque through that constraint, so loads (heavy wheels, crates,
// ramps, friction) automatically fight back against the motor.
//
// Motors are revolute-joint motors with a MAX TORQUE. If the load needs more
// torque than that, the joint just can't reach its target speed: it slows
// down or stalls. Nothing ever breaks.
// =============================================================================
import * as planck from '../../lib/planck.mjs';
import { getDef, partDef, gearLayers, roleOf } from '../parts/partDefs.js';
import { socketsOf, lineEnds } from '../parts/geometry.js';
import { buildAssembly, WORLD, mainKey, hubKey, CLUSTER_TOL } from './assembly.js';
import { solveGearTrain } from './gearTrain.js';

const { World, Vec2, Circle, Box, Polygon, RevoluteJoint, GearJoint, MouseJoint, PrismaticJoint, DistanceJoint, RopeJoint } = planck;

// Collision categories (bit flags). Machine parts don't collide with each
// other — gears are connected by math, not by teeth bumping — but everything
// collides with the ground and with test objects.
// SOLID = a machine part set to "Collisions: Everything" with the
// Screwdriver: it also bumps into other machine parts.
export const CAT = { GROUND: 0x1, OBJECT: 0x2, MACHINE: 0x4, WHEEL: 0x8, SOLID: 0x10 };
const MASK = {
  [CAT.GROUND]: 0xffff,
  [CAT.OBJECT]: 0xffff,
  [CAT.MACHINE]: CAT.GROUND | CAT.OBJECT | CAT.SOLID,
  [CAT.WHEEL]: CAT.GROUND | CAT.OBJECT | CAT.SOLID,
  [CAT.SOLID]: 0xffff,
};

/** Physics time step. Small steps + many iterations keep gear chains stiff. */
export const DT = 1 / 120;
const VEL_ITERS = 30;
const POS_ITERS = 10;

const rpmToRad = (rpm) => (rpm * 2 * Math.PI) / 60;
export const radToRpm = (w) => (w * 60) / (2 * Math.PI);

/** Bearing friction (N·m) on free axles, per unit of the friction slider. */
const AXLE_FRICTION = 0.6;
/** How strong the player's arm is when turning a hand crank (N·m). */
export const CRANK_TORQUE = 40;
/** Torque used to hold jammed gears still. */
const JAM_TORQUE = 1e6;
/** Spring stiffness presets (oscillation frequency in Hz: higher = stiffer). */
export const SPRING_HZ = { soft: 1.8, medium: 3.5, stiff: 7 };

/** A motor's own keys: { cw, ccw } or null. (Old saves: keys:true = the arrows.) */
export function motorKeys(part) {
  const p = part.props;
  const cw = p.keyCW ?? (p.keys ? 'arrowright' : 'none');
  const ccw = p.keyCCW ?? (p.keys ? 'arrowleft' : 'none');
  return cw === 'none' && ccw === 'none' ? null : { cw, ccw };
}

/** A Key control's two keys. Defaults: D turns ↻ (car goes right), A turns ↺. */
export function keyControlKeys(part) {
  return { cw: part.props.keyCW ?? 'd', ccw: part.props.keyCCW ?? 'a' };
}

/** Old saves: a Key control with one `key` that turned motors "on". */
export const isLegacyKey = (part) => part.props.key != null && part.props.keyCW == null && part.props.keyCCW == null;

export class Simulation {
  /**
   * @param build    the build (plain data, not modified)
   * @param settings { gravity, friction, motorTorque, motorRpm }
   * @param map      { groundHalfWidth } from the game mode (Infinity = endless)
   */
  constructor(build, settings, map) {
    this.parts = build.parts.map((p) => ({ ...p, props: { ...p.props } }));
    this.byUid = new Map(this.parts.map((p) => [p.uid, p]));
    this.settings = { ...settings };
    this.time = 0;

    this.assembly = buildAssembly(this.parts);
    this.train = solveGearTrain(this.parts, this.assembly);

    this.world = new World({ gravity: Vec2(0, -settings.gravity) });
    this.bodies = new Map();      // assembly body id -> planck Body
    this.elements = new Map();    // element key -> { body, lx, ly, part }
    this.axleJoints = new Map();  // assembly body id -> planck RevoluteJoint it spins on
    this.driverJoints = new Map();// driver uid -> { joint, kind, part }
    this.telemetry = new Map();   // driver uid -> { torque, maxTorque, speed, load, stalled }
    this.fixtures = [];           // [{ fixture, baseFriction }]
    this.links = new Map();       // spring/rope uid -> { bodyA, la, bodyB, lb, joint }
    this.held = new Set();        // keyboard keys held down (lower-case names)
    this.signals = new Map();     // control uid -> on (switch/button: bool; key: -1/0/+1)
    this.wires = new Map();       // motor uid -> [control uids wired to it]

    this._createBodies(map);
    this._createRevolutes();
    this._createPrismatics();
    this._createGearJoints();
    this._createLinks();
    this._createWires();
    this.applySettings(settings);

    this.grab = null;        // mouse joint on a loose body
    this.crankGrab = null;   // { uid, target: {x,y} }
  }

  // ------------------------------------------------------------- building --
  _createBodies(map) {
    const ground = this.world.createBody({ type: 'static' });
    this.bodies.set(WORLD, ground);
    this.ground = ground;
    // groundHalfWidth: Infinity = endless ground. Box2D needs a finite shape,
    // so "endless" is a million metres each way (days of driving).
    const half = Number.isFinite(map.groundHalfWidth) ? map.groundHalfWidth : 1e6;
    // The flat ground: a wide box whose top surface is y = 0.
    this._addFixture(ground, Box(half, 5, Vec2(0, -5), 0), { friction: 1, cat: CAT.GROUND });

    for (const ab of this.assembly.bodies) {
      let body = ground;
      if (!ab.isStatic) {
        body = this.world.createBody({ type: 'dynamic', position: Vec2(ab.origin.x, ab.origin.y) });
        this.bodies.set(ab.id, body);
      }
      const ox = ab.isStatic ? 0 : ab.origin.x;
      const oy = ab.isStatic ? 0 : ab.origin.y;
      for (const key of ab.keys) {
        const el = this.assembly.elements.get(key);
        const part = this.byUid.get(el.uid);
        const lx = part.x - ox, ly = part.y - oy;
        this.elements.set(key, { body, lx, ly, part });
        this._addPartFixtures(body, part, el.sub, lx, ly);
      }
    }
  }

  /** Add the collision shapes for one element of a part. (lx, ly) = part
   *  position relative to the body origin. */
  _addPartFixtures(body, part, sub, lx, ly) {
    const def = partDef(part);
    const a = part.angle;
    const c = Vec2(lx, ly);
    const at = (dx, dy) => Vec2(lx + dx * Math.cos(a) - dy * Math.sin(a), ly + dx * Math.sin(a) + dy * Math.cos(a));
    const mass = def.mass || 0.1;
    // Screwdriver collision setting: 'normal' | 'all' (hits machine parts too) | 'none' (ghost).
    const collide = part.props?.collide ?? 'normal';
    const add = (shape, area, opts) => {
      const o = { density: mass / area, ...opts };
      if (collide === 'none') o.sensor = true;
      else if (collide === 'all' && !o.sensor && (o.cat === CAT.MACHINE || o.cat === CAT.WHEEL)) o.cat = CAT.SOLID;
      return this._addFixture(body, shape, o);
    };

    switch (def.kind) {
      case 'gear': case 'compoundGear': {
        const r = gearLayers(def)[0].r;
        add(Circle(c, r), Math.PI * r * r, { cat: CAT.MACHINE, friction: 0.4 });
        break;
      }
      case 'wheel':
        add(Circle(c, def.radius), Math.PI * def.radius ** 2,
          { cat: CAT.WHEEL, friction: 1.6, restitution: 0.05 });
        break;
      case 'sprocket':
        add(Circle(c, def.radius), Math.PI * def.radius ** 2, { cat: CAT.MACHINE, friction: 0.4 });
        break;
      case 'beam': {
        const hx = def.length / 2 + def.thickness / 2, hy = def.thickness / 2;
        add(Box(hx, hy, c, a), 4 * hx * hy, { cat: CAT.MACHINE, friction: 0.5 });
        break;
      }
      case 'slider':
        if (sub === 'hub') add(Box(0.36, 0.3, c, a), 0.43, { cat: CAT.MACHINE, sensor: true, density: 1.5 });
        else {
          const hx = def.length / 2 + 0.2, hy = 0.14;
          add(Box(hx, hy, c, a), 4 * hx * hy, { cat: CAT.MACHINE, friction: 0.5 });
        }
        break;
      case 'track':
        this._addFixture(body, Box(def.length / 2 + 0.05, def.thickness / 2, c, a), { cat: CAT.GROUND, friction: 1 });
        break;
      case 'motor':
        if (sub === 'hub') add(Circle(c, 0.18), 0.1, { cat: CAT.MACHINE, sensor: true, density: 2 });
        else add(Box(def.housing / 2, def.housing / 2, c, a), def.housing ** 2, { cat: CAT.MACHINE });
        break;
      case 'crank':
        if (sub === 'hub') {
          const L = def.armLength;
          add(Box(L / 2, 0.12, at(L / 2, 0), a), L * 0.24, { cat: CAT.MACHINE, sensor: true });
        } else {
          add(Circle(c, 0.35), 0.4, { cat: CAT.MACHINE, sensor: true, density: 2 });
        }
        break;
      case 'axle': case 'hinge':
        add(Circle(c, 0.16), 0.08, { cat: CAT.MACHINE, sensor: true, density: 1 });
        break;
      case 'switch': case 'button': case 'keyButton':
        add(Circle(c, def.radius), Math.PI * def.radius ** 2, { cat: CAT.MACHINE, sensor: true });
        break;
      case 'ball':
        add(Circle(c, def.radius), Math.PI * def.radius ** 2,
          { cat: CAT.OBJECT, friction: 0.6, restitution: def.bounce ?? 0.3 });
        break;
      case 'crate':
        add(Box(def.width / 2, def.height / 2, c, a), def.width * def.height,
          { cat: CAT.OBJECT, friction: 0.7 });
        break;
      case 'block':
        this._addFixture(body, Box(def.width / 2, def.height / 2, c, a), { cat: CAT.GROUND, friction: 0.8 });
        break;
      case 'ramp': {
        const w = def.width / 2, h = def.height / 2;
        this._addFixture(body, Polygon([at(-w, -h), at(w, -h), at(w, h)]), { cat: CAT.GROUND, friction: 0.8 });
        break;
      }
      default: break; // pins have no shape: they are part of the background
    }
  }

  _addFixture(body, shape, { density = 1, friction = 0.6, restitution = 0, cat, sensor = false }) {
    const fixture = body.createFixture({
      shape, density, friction, restitution, isSensor: sensor,
      filterCategoryBits: cat, filterMaskBits: MASK[cat],
    });
    this.fixtures.push({ fixture, baseFriction: friction });
    return fixture;
  }

  _createRevolutes() {
    for (const r of this.assembly.revolutes) {
      const bodyA = this.bodies.get(r.a);
      const bodyB = this.bodies.get(r.b);
      if (r.pivot) {
        // Crank pins and slider blocks: a plain free pivot.
        this.world.createJoint(RevoluteJoint({}, bodyA, bodyB, Vec2(r.x, r.y)));
        continue;
      }
      const joint = this.world.createJoint(RevoluteJoint(
        { enableMotor: true, motorSpeed: 0, maxMotorTorque: 0 }, bodyA, bodyB, Vec2(r.x, r.y)));
      if (!this.axleJoints.has(r.b)) this.axleJoints.set(r.b, joint);
      if (r.driverUid != null) {
        const part = this.byUid.get(r.driverUid);
        const kind = getDef(part.type).kind;
        this.driverJoints.set(r.driverUid, { joint, kind, part, bodyId: r.b });
        bodyB.setSleepingAllowed(false);
        this.telemetry.set(r.driverUid, { torque: 0, maxTorque: 0, speed: 0, commanded: 0, load: 0, stalled: false, jammed: false });
      }
    }
  }

  /** Slider blocks slide along their rails, stopping at the ends. */
  _createPrismatics() {
    for (const pr of this.assembly.prismatics) {
      const part = this.byUid.get(pr.uid);
      const def = partDef(part);
      const axis = Vec2(Math.cos(part.angle), Math.sin(part.angle));
      const half = def.length / 2 - 0.36;
      this.world.createJoint(PrismaticJoint({
        enableLimit: true, lowerTranslation: -half, upperTranslation: half,
        enableMotor: true, maxMotorForce: AXLE_FRICTION * 2, motorSpeed: 0,
      }, this.bodies.get(pr.a), this.bodies.get(pr.b), Vec2(part.x, part.y), axis));
    }
  }

  /** The body under a world point: a part with a socket there first, then
   *  any shape there (crates, beams...), otherwise null. */
  _bodyAt(pt) {
    for (const part of this.parts) {
      for (const s of socketsOf(part)) {
        if (Math.hypot(s.x - pt.x, s.y - pt.y) >= CLUSTER_TOL) continue;
        const key = s.sub === 'hub' ? hubKey(part.uid) : mainKey(part.uid);
        const id = this.assembly.bodyOf(key);
        if (this.bodies.has(id)) return this.bodies.get(id);
      }
    }
    // A little tolerance, so an end drawn right on a crate's edge still grabs it.
    const probes = [[0, 0], [0, -0.12], [0, 0.12], [-0.12, 0], [0.12, 0]];
    for (const [dx, dy] of probes) {
      const q = Vec2(pt.x + dx, pt.y + dy);
      let found = null;
      this.world.queryAABB(planck.AABB(Vec2(q.x - 0.01, q.y - 0.01), Vec2(q.x + 0.01, q.y + 0.01)), (f) => {
        if (f.getBody().isDynamic() && f.testPoint(q)) { found = f.getBody(); return false; }
        return true;
      });
      if (found) return found;
    }
    return null;
  }

  /** Springs and ropes: each end grabs whatever it touches. */
  _createLinks() {
    for (const part of this.parts) {
      const def = partDef(part);
      if (def.kind !== 'spring' && def.kind !== 'rope') continue;
      const [e1, e2] = lineEnds(part);
      // An end touching nothing is pinned to the background, unless the
      // Screwdriver unanchored it: then it hangs free with a little hook.
      const free = part.props.pinEnds === false;
      const endBody = (e) => this._bodyAt(e) || (free ? this._hook(e) : this.ground);
      const bodyA = endBody(e1), bodyB = endBody(e2);
      const link = { bodyA, la: bodyA.getLocalPoint(Vec2(e1.x, e1.y)), bodyB, lb: bodyB.getLocalPoint(Vec2(e2.x, e2.y)), joint: null,
        hooks: [bodyA.isHook ? 0 : -1, bodyB.isHook ? 1 : -1].filter((i) => i >= 0) };
      this.links.set(part.uid, link);
      if (bodyA === bodyB) continue;
      if (def.kind === 'spring') {
        const hz = SPRING_HZ[part.props.stiffness] ?? SPRING_HZ.medium;
        link.joint = this.world.createJoint(DistanceJoint(
          { frequencyHz: hz, dampingRatio: 0.35, length: def.length, collideConnected: true },
          bodyA, bodyB, Vec2(e1.x, e1.y), Vec2(e2.x, e2.y)));
      } else {
        link.joint = this.world.createJoint(RopeJoint(
          { maxLength: def.length, localAnchorA: link.la, localAnchorB: link.lb, collideConnected: true }, bodyA, bodyB));
      }
      bodyA.setSleepingAllowed(false);
      bodyB.setSleepingAllowed(false);
    }
  }

  /** Wires: which controls drive which motors. Switches start in their saved state. */
  _createWires() {
    for (const part of this.parts) {
      const kind = getDef(part.type).kind;
      if (kind === 'switch') this.signals.set(part.uid, !!part.props.on);
      if (kind === 'button') this.signals.set(part.uid, false);
      if (kind === 'keyButton') this.signals.set(part.uid, 0);
      if (kind !== 'wire') continue;
      const a = this.byUid.get(part.props.a), b = this.byUid.get(part.props.b);
      if (!a || !b) continue;
      const [ctl, motor] = roleOf(getDef(a.type).kind) === 'control' ? [a, b] : [b, a];
      if (getDef(motor.type).kind !== 'motor') continue;
      if (!this.wires.has(motor.uid)) this.wires.set(motor.uid, []);
      this.wires.get(motor.uid).push(ctl.uid);
    }
  }

  /** Turn a control on/off (click a switch, hold a button). */
  setSignal(uid, on) {
    if (this.signals.get(uid) === on) return;
    this.signals.set(uid, on);
    for (const [motorUid, ctls] of this.wires) {
      if (ctls.includes(uid)) this._redrive(motorUid);
    }
  }

  _redrive(motorUid) {
    const d = this.driverJoints.get(motorUid);
    if (d && !this.jammedBodies.has(d.bodyId)) { this._driveMotor(d); d.joint.getBodyB().setAwake(true); }
  }

  /** Flip a switch. */
  toggleSwitch(uid) { this.setSignal(uid, !this.signals.get(uid)); }

  /** Keys held right now (a Set of lower-case key names). Drives Key
   *  controls and motors with their own keys. */
  setKeys(held) {
    this.held = new Set(held);
    for (const p of this.parts) {
      if (getDef(p.type).kind === 'keyButton') this.signals.set(p.uid, this._keySignal(p));
    }
    for (const d of this.driverJoints.values()) {
      if (d.kind === 'motor' && (motorKeys(d.part) || this.wires.has(d.part.uid))) this._redrive(d.part.uid);
    }
  }

  /** A Key control's output: +1 counter-clockwise, -1 clockwise, 0 neither.
   *  (Old saves had one `key` that just turned it "on".) */
  _keySignal(p) {
    if (isLegacyKey(p)) return this.held.has(p.props.key) ? 1 : 0;
    const k = keyControlKeys(p);
    return (this.held.has(k.ccw) ? 1 : 0) - (this.held.has(k.cw) ? 1 : 0);
  }

  /** Every key that does something in this machine. */
  get boundKeys() {
    const out = new Set();
    for (const p of this.parts) {
      const kind = getDef(p.type).kind;
      if (kind === 'keyButton') {
        if (isLegacyKey(p)) out.add(p.props.key);
        else { const k = keyControlKeys(p); out.add(k.cw); out.add(k.ccw); }
      }
      if (kind === 'motor') { const k = motorKeys(p); if (k) { out.add(k.cw); out.add(k.ccw); } }
    }
    out.delete('none');
    return out;
  }

  /** Key controls bound to this key (lower-case key name). */
  keyControls(key) {
    return this.parts.filter((p) => getDef(p.type).kind === 'keyButton' &&
      (isLegacyKey(p) ? p.props.key === key : Object.values(keyControlKeys(p)).includes(key))).map((p) => p.uid);
  }

  /** A small free weight on the loose end of an unanchored rope/spring. */
  _hook(e) {
    const body = this.world.createBody({ type: 'dynamic', position: Vec2(e.x, e.y), linearDamping: 0.4 });
    this._addFixture(body, Circle(Vec2(0, 0), 0.16), { density: 0.3 / (Math.PI * 0.16 ** 2), friction: 0.6, cat: CAT.OBJECT });
    body.isHook = true;
    return body;
  }

  /** Which ends (0, 1) of a rope/spring hang free on a hook. */
  hookEnds(uid) { return this.links.get(uid)?.hooks ?? []; }

  /** Current world positions of a spring's or rope's two ends. */
  linkEnds(uid) {
    const l = this.links.get(uid);
    if (!l) return null;
    const a = l.bodyA.getWorldPoint(l.la), b = l.bodyB.getWorldPoint(l.lb);
    return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  }

  _createGearJoints() {
    this.gearJoints = [];
    this.jammedBodies = new Set();
    for (const comp of this.train.components) {
      if (comp.jammed) {
        // Hold every gear in a jammed train still (the motor will stall).
        for (const b of comp.bodies) if (b !== WORLD) this.jammedBodies.add(b);
        for (const uid of comp.driverUids) {
          const t = this.telemetry.get(uid);
          if (t) t.jammed = true;
        }
      }
    }
    for (const m of this.train.meshes) {
      if (!m.tree || this.train.components[m.component].jammed) continue;
      const j1 = this.axleJoints.get(m.bodyA);
      const j2 = this.axleJoints.get(m.bodyB);
      // GearJoint constraint: angleA + ratio·angleB = const. For meshed gears
      // ωB = −ωA·(Na/Nb) ⇒ ratio = Nb/Na. A chain keeps the direction ⇒ −Nb/Na.
      const ratio = (m.chain ? -1 : 1) * m.b.teeth / m.a.teeth;
      const gj = this.world.createJoint(GearJoint({}, j1.getBodyB(), j2.getBodyB(), j1, j2, ratio));
      this.gearJoints.push(gj);
    }
  }

  // ------------------------------------------------------------- settings --
  /** Apply slider values. Safe to call while running. */
  applySettings(settings) {
    const prev = this.settings;
    this.settings = { ...settings };
    this.world.setGravity(Vec2(0, -settings.gravity));
    if (prev.friction !== settings.friction || !this._frictionApplied) {
      for (const { fixture, baseFriction } of this.fixtures) fixture.setFriction(baseFriction * settings.friction);
      // Existing contacts cache friction; reset them so the change is felt now.
      for (let c = this.world.getContactList(); c; c = c.getNext()) c.resetFriction();
      this._frictionApplied = true;
    }
    for (const [bodyId, joint] of this.axleJoints) {
      if (this.jammedBodies.has(bodyId)) {
        joint.setMotorSpeed(0);
        joint.setMaxMotorTorque(JAM_TORQUE);
      } else {
        // Free axles get a little bearing friction (a motor with target speed 0).
        joint.setMotorSpeed(0);
        joint.setMaxMotorTorque(AXLE_FRICTION * settings.friction);
      }
    }
    for (const [uid, d] of this.driverJoints) {
      if (this.jammedBodies.has(d.bodyId)) continue; // jammed trains stay locked
      if (d.kind === 'motor') this._driveMotor(d);
    }
    for (const b of this.bodies.values()) b.setAwake(true);
  }

  _driveMotor(d) {
    const p = d.part.props;
    const dir = p.reverse ? -1 : 1;
    // spin: +1 = counter-clockwise (the physics' positive direction).
    // A motor with its own keys or wired controls only runs when told to:
    //   its keys: ↻ key turns it clockwise (rolls a car right), ↺ key the other way
    //   switches/buttons: on = its normal direction (or backwards if set to Reverse)
    //   Key controls: their ↻ / ↺ keys, like the motor's own keys
    // With nothing pressed it brakes (or spins freely if its idle mode is 'free').
    const keys = motorKeys(d.part);
    const ctls = this.wires.get(d.part.uid);
    let spin = dir;
    if (keys || ctls) {
      spin = keys ? (this.held.has(keys.ccw) ? 1 : 0) - (this.held.has(keys.cw) ? 1 : 0) : 0;
      for (const uid of ctls || []) {
        const ctl = this.byUid.get(uid);
        const v = this.signals.get(uid);
        if (getDef(ctl.type).kind === 'keyButton' && !isLegacyKey(ctl)) spin += v;
        else if (v) spin += (ctl.props.reverse ? -1 : 1) * dir * Number(v);
      }
      spin = Math.max(-1, Math.min(1, spin));
    }
    const idleFree = spin === 0 && p.idle === 'free';
    d.joint.setMotorSpeed(spin * rpmToRad(this.settings.motorRpm));
    d.joint.setMaxMotorTorque(idleFree ? AXLE_FRICTION * this.settings.friction : this.settings.motorTorque);
  }

  /** Old API: arrow keys as a number, -1 (←), 0 or 1 (→). */
  setThrottle(v) {
    const held = new Set([...this.held].filter((k) => k !== 'arrowleft' && k !== 'arrowright'));
    if (v > 0) held.add('arrowright');
    if (v < 0) held.add('arrowleft');
    this.setKeys(held);
  }

  /** Does this machine have any key-driven motors or Key controls? */
  get hasKeyMotors() { return this.boundKeys.size > 0; }

  /**
   * What the camera should follow by default: the "vehicle". That's a body
   * that moves freely (not pinned or spinning on the background), preferably
   * one carrying a motor; the heaviest wins. Returns a part uid or null.
   */
  autoFollowTarget() {
    const pinned = new Set();
    for (const r of this.assembly.revolutes) {
      if (r.a === WORLD) pinned.add(r.b);
      if (r.b === WORLD) pinned.add(r.a);
    }
    for (const pr of this.assembly.prismatics) if (pr.a === WORLD) pinned.add(pr.b);
    let best = null;
    for (const ab of this.assembly.bodies) {
      if (ab.isStatic || pinned.has(ab.id)) continue;
      const parts = ab.keys.map((k) => this.byUid.get(this.assembly.elements.get(k).uid));
      const machine = parts.filter((q) => roleOf(getDef(q.type).kind) !== 'object');
      if (!machine.length) continue;
      const hasMotor = parts.some((q) => getDef(q.type).kind === 'motor');
      const mass = this.bodies.get(ab.id)?.getMass() ?? 0;
      const score = (hasMotor ? 1e6 : 0) + mass;
      if (!best || score > best.score) {
        const beams = machine.filter((q) => roleOf(getDef(q.type).kind) === 'beam');
        const rep = beams.sort((a, b) => partDef(b).length - partDef(a).length)[0] || machine[0];
        best = { score, uid: rep.uid };
      }
    }
    return best?.uid ?? null;
  }

  // ---------------------------------------------------------------- input --
  /** Start turning a hand crank toward a world point. */
  grabCrank(uid, point) { this.crankGrab = { uid, target: point }; }
  /** Grab a loose dynamic body (crate/ball/anything) with a mouse joint. */
  grabBodyAt(point) {
    let found = null;
    this.world.queryAABB(planck.AABB(Vec2(point.x - 0.01, point.y - 0.01), Vec2(point.x + 0.01, point.y + 0.01)), (f) => {
      if (f.getBody().isDynamic() && f.testPoint(Vec2(point.x, point.y))) { found = f.getBody(); return false; }
      return true;
    });
    if (!found) return false;
    this.grab = this.world.createJoint(MouseJoint(
      { maxForce: 400 * found.getMass(), frequencyHz: 5, dampingRatio: 0.7 }, this.ground, found, Vec2(point.x, point.y)));
    found.setAwake(true);
    return true;
  }
  dragTo(point) {
    if (this.grab) this.grab.setTarget(Vec2(point.x, point.y));
    if (this.crankGrab) this.crankGrab.target = point;
  }
  release() {
    if (this.grab) { this.world.destroyJoint(this.grab); this.grab = null; }
    this.crankGrab = null;
  }

  // ----------------------------------------------------------------- step --
  step(dt = DT) {
    this._updateCranks();
    this.world.step(dt, VEL_ITERS, POS_ITERS);
    this.time += dt;
    this._updateTelemetry(dt);
  }

  _updateCranks() {
    for (const [uid, d] of this.driverJoints) {
      if (d.kind !== 'crank') continue;
      const j = d.joint;
      if (this.crankGrab?.uid === uid) {
        // Turn the crank arm toward the mouse, with limited human torque.
        const t = this.transformOf(uid, 'hub');
        const target = Math.atan2(this.crankGrab.target.y - t.y, this.crankGrab.target.x - t.x);
        let diff = target - t.angle;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap to -π..π
        j.setMotorSpeed(Math.max(-8, Math.min(8, diff * 10)));
        j.setMaxMotorTorque(CRANK_TORQUE);
      } else {
        j.setMotorSpeed(0);
        j.setMaxMotorTorque(AXLE_FRICTION * this.settings.friction);
      }
    }
  }

  _updateTelemetry(dt) {
    for (const [uid, d] of this.driverJoints) {
      const t = this.telemetry.get(uid);
      const j = d.joint;
      const torque = Math.abs(j.getMotorTorque(1 / dt));
      // Smooth the readings: solver impulses jitter step to step.
      t.torque += (torque - t.torque) * 0.1;
      t.speed += (j.getJointSpeed() - t.speed) * 0.2;
      t.maxTorque = d.kind === 'motor' ? this.settings.motorTorque : CRANK_TORQUE;
      t.commanded = j.getMotorSpeed();
      const active = d.kind === 'motor' || this.crankGrab?.uid === uid;
      t.load = t.jammed ? 1 : active && t.maxTorque > 0 ? Math.min(1, t.torque / t.maxTorque) : 0;
      t.stalled = t.jammed || (d.kind === 'motor' && Math.abs(t.commanded) > 0.05 &&
        t.load > 0.9 && Math.abs(t.speed) < 0.25 * Math.abs(t.commanded));
    }
  }

  // -------------------------------------------------------------- queries --
  /** Current world transform of a part (sub = 'main' or 'hub'). */
  transformOf(uid, sub = 'main') {
    const key = sub === 'hub' ? hubKey(uid) : mainKey(uid);
    const el = this.elements.get(key);
    if (!el) return null;
    const p = el.body.getWorldPoint(Vec2(el.lx, el.ly));
    return { x: p.x, y: p.y, angle: el.body.getAngle() + el.part.angle };
  }

  /** Live readout for a part: { rpm, torque, ratio, load, driverUid, jammed, stalled } or null. */
  readout(uid) {
    const part = this.byUid.get(uid);
    if (!part) return null;
    const def = getDef(part.type);
    const role = roleOf(def.kind);
    const key = role === 'driver' ? hubKey(uid) : mainKey(uid);
    const bodyId = this.assembly.bodyOf(key);
    const axle = this.axleJoints.get(bodyId);
    const rpm = axle ? radToRpm(axle.getJointSpeed()) : 0;
    const drive = this.train.driveOf(bodyId);
    const tel = drive?.driverUid != null ? this.telemetry.get(drive.driverUid) : null;
    return {
      rpm,
      ratio: drive ? drive.ratio : null,
      torque: tel && drive.ratio ? tel.torque / Math.abs(drive.ratio) : 0,
      load: tel ? tel.load : 0,
      driverUid: drive?.driverUid ?? null,
      jammed: !!drive?.jammed || this.jammedBodies.has(bodyId),
      stalled: !!tel?.stalled,
      mounted: !!axle || bodyId === WORLD,
    };
  }

  /** Load fraction 0..1 for a part, for the load-view colouring (null = unpowered). */
  loadOf(uid) {
    const r = this.readout(uid);
    if (!r) return null;
    if (r.jammed) return 1;
    return r.driverUid != null ? r.load : null;
  }
}
