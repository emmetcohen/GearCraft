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
import { getDef, partDef, gearLayers, roleOf, isActuator, pistonStroke, pistonExt } from '../parts/partDefs.js';
import { socketsOf, lineEnds, partsAt } from '../parts/geometry.js';
import { buildAssembly, WORLD, mainKey, hubKey, CLUSTER_TOL } from './assembly.js';
import { solveGearTrain } from './gearTrain.js';

const { World, Vec2, Circle, Box, Polygon, RevoluteJoint, GearJoint, MouseJoint, PrismaticJoint, DistanceJoint, RopeJoint, WeldJoint } = planck;

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

/** Gadget tuning. */
export const PISTON_SPEED = 2.5;         // m/s
export const PISTON_FORCE_PER_TORQUE = 6; // piston force (N) per N·m of the motor-power slider
export const THRUST = { low: 15, medium: 35, high: 90 }; // N
export const MAGNET_RANGE = 4.5;         // m
export const CANNON_SPEED = 16;          // m/s (medium power)
export const CANNON_POWER = { low: 10, medium: 16, high: 24 }; // m/s
export const MAGNET_GRIP = 4;            // things a magnet can hold at once
export const DOOR_SPEED = { gentle: 3, fast: 14 }; // rad/s
export const DOOR_SWING = Math.PI / 2;
export const LATCH_AUTO = 2;             // s: an uncontrolled latch lets go after this
export const BOMB_RANGE = 4.5;           // m
export const BOMB_KICK = 30;             // N·s at point blank
export const BOMB_IMPACT = 7;            // m/s: a bump this hard sets a bomb off
export const CONVEYOR_SPEED = 3;         // m/s
export const WATER_DENSITY = 1.5;        // kg/m² (2D): lighter parts float
const MAX_SHOTS = 40;

/** A gadget's keys: { plus, minus } ('none' = unused). */
export function gadgetKeys(part) {
  return { plus: part.props.keyPlus ?? 'none', minus: part.props.keyMinus ?? 'none' };
}

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
    this.wires = new Map();       // motor/gadget uid -> [control uids wired to it]
    this.pistons = new Map();     // piston uid -> { joint, stroke, dir }
    this.conveyors = new Map();   // fixture -> conveyor part
    this.shots = [];              // cannon balls in flight: { body, age }
    this.gadgetState = new Map(); // gadget uid -> { on, cool, prev }
    this.doors = new Map();       // trap door uid -> { joint, sign }
    this.latches = new Map();     // latch uid -> { a, b, la, lb, ref, x, y, joint }
    this.booms = [];              // explosions: { x, y, age }

    this._createBodies(map);
    this._createRevolutes();
    this._createPrismatics();
    this._createHinges();
    this._createGearJoints();
    this._createLinks();
    this._createLatches();
    this._createWires();
    this.world.on('pre-solve', (contact) => this._conveyorContact(contact));
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
    this._fixtureUid = part.uid; // tag fixtures with their part (bombs remove theirs)
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
      case 'axle': case 'hinge': case 'bolt':
        add(Circle(c, 0.16), 0.08, { cat: CAT.MACHINE, sensor: true, density: 1 });
        break;
      case 'piston': {
        const L = def.length;
        if (sub === 'hub') {
          // The rod: from deep inside the cylinder out to the top end (which
          // may start pushed out).
          const ext = pistonExt(part, def);
          add(Box((L - 0.1) / 2, 0.1, at(0.05 + ext, 0), a), (L - 0.1) * 0.2, { cat: CAT.MACHINE, friction: 0.5 });
        } else {
          add(Box(L / 2, def.thickness / 2, c, a), L * def.thickness, { cat: CAT.MACHINE, friction: 0.5 });
        }
        break;
      }
      case 'plate': {
        const hx = def.length / 2 + 0.1, hy = def.thickness / 2;
        add(Box(hx, hy, c, a), 4 * hx * hy, { cat: CAT.MACHINE, friction: 0.7 });
        break;
      }
      case 'thruster': case 'magnet': case 'cannon': case 'latch':
        add(Circle(c, def.radius * 0.9), Math.PI * (def.radius * 0.9) ** 2, { cat: CAT.MACHINE, sensor: true });
        break;
      case 'trapdoor':
        if (sub === 'hub') add(Circle(at(-def.length / 2, 0), 0.18), 0.1, { cat: CAT.MACHINE, sensor: true, density: 1 });
        else add(Box(def.length / 2, def.thickness / 2, c, a), def.length * def.thickness, { cat: CAT.MACHINE, friction: 0.8 });
        break;
      case 'bomb':
        add(Circle(c, def.radius), Math.PI * def.radius ** 2, { cat: CAT.OBJECT, friction: 0.6, restitution: 0.2 });
        break;
      case 'pressurePlate':
        add(Box(def.width / 2, def.height / 2, c, a), def.width * def.height, { cat: CAT.MACHINE, sensor: true });
        break;
      case 'balloon':
        add(Circle(c, def.radius), Math.PI * def.radius ** 2, { cat: CAT.OBJECT, friction: 0.3, restitution: 0.4 });
        body.setLinearDamping(0.8); // air drag: it floats up gently
        body.setAngularDamping(1);
        break;
      case 'conveyor': {
        const f = this._addFixture(body, Box(def.length / 2, def.thickness / 2, c, a), { cat: CAT.GROUND, friction: 1.2 });
        this.conveyors.set(f, part);
        break;
      }
      case 'bouncePad':
        this._addFixture(body, Box(def.width / 2, def.height / 2, c, a), { cat: CAT.GROUND, friction: 0.6, restitution: 1 });
        break;
      case 'water': break; // no shape: buoyancy is worked out each step
      case 'switch': case 'button': case 'keyButton': case 'timer':
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
    fixture.uid = this._fixtureUid;
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
      if (pr.piston) {
        // The rod pushes out from fully in (0) to `stroke`. It may start
        // pushed out (ext), and the joint counts from where it starts.
        const stroke = pistonStroke(def), ext = pistonExt(part, def);
        const joint = this.world.createJoint(PrismaticJoint({
          enableLimit: true, lowerTranslation: -ext, upperTranslation: stroke - ext,
          enableMotor: true, maxMotorForce: 0, motorSpeed: 0,
        }, this.bodies.get(pr.a), this.bodies.get(pr.b), Vec2(part.x, part.y), axis));
        this.pistons.set(pr.uid, { joint, stroke, offset: ext, dir: ext ? -1 : 1, part });
        this.bodies.get(pr.b).setSleepingAllowed(false);
        continue;
      }
      const half = def.length / 2 - 0.36;
      this.world.createJoint(PrismaticJoint({
        enableLimit: true, lowerTranslation: -half, upperTranslation: half,
        enableMotor: true, maxMotorForce: AXLE_FRICTION * 2, motorSpeed: 0,
      }, this.bodies.get(pr.a), this.bodies.get(pr.b), Vec2(part.x, part.y), axis));
    }
  }

  /** Trap doors: the flap swings on its bracket, driven by a little motor. */
  _createHinges() {
    for (const h of this.assembly.hinges) {
      const part = this.byUid.get(h.uid);
      // Which way is "open"? Rotating by +θ moves the free end up by θ·cos(angle).
      const c = Math.cos(part.angle);
      const down = (part.props.opens ?? 'down') === 'down';
      const sign = (Math.abs(c) < 0.2 ? -1 : -Math.sign(c)) * (down ? 1 : -1);
      const joint = this.world.createJoint(RevoluteJoint({
        enableLimit: true, lowerAngle: sign > 0 ? 0 : -DOOR_SWING, upperAngle: sign > 0 ? DOOR_SWING : 0,
        enableMotor: true, motorSpeed: 0, maxMotorTorque: 0,
      }, this.bodies.get(h.a), this.bodies.get(h.b), Vec2(h.x, h.y)));
      this.bodies.get(h.b).setSleepingAllowed(false);
      this.doors.set(h.uid, { joint, sign, part });
    }
  }

  /** Latches grip the next part under them (or the background) with a
   *  joint that can be let go of. */
  _createLatches() {
    const solid = this.parts.filter((p) => !['link', 'control', 'bolt', 'gadget', 'latch'].includes(roleOf(getDef(p.type).kind)) &&
      getDef(p.type).kind !== 'water');
    for (const part of this.parts) {
      if (getDef(part.type).kind !== 'latch') continue;
      const a = this.elements.get(mainKey(part.uid))?.body;
      if (!a) continue;
      let b = null;
      for (const p of partsAt(solid, part.x, part.y)) {
        const body = this.elements.get(mainKey(p.uid))?.body;
        if (body && body !== a) { b = body; break; }
      }
      if (!b && a !== this.ground) b = this.ground;
      if (!b) continue;
      const pt = Vec2(part.x, part.y);
      const latch = { a, b, la: a.getLocalPoint(pt), lb: b.getLocalPoint(pt), ref: b.getAngle() - a.getAngle(), joint: null };
      this._lock(latch);
      this.latches.set(part.uid, latch);
      a.setSleepingAllowed(false);
      b.setSleepingAllowed(false);
    }
  }

  _lock(latch) {
    latch.joint = this.world.createJoint(WeldJoint({}, latch.a, latch.b, latch.a.getWorldPoint(latch.la)));
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
      if (kind === 'button' || kind === 'timer' || kind === 'pressurePlate') this.signals.set(part.uid, false);
      if (kind === 'keyButton') this.signals.set(part.uid, 0);
      if (kind !== 'wire') continue;
      const a = this.byUid.get(part.props.a), b = this.byUid.get(part.props.b);
      if (!a || !b) continue;
      const [ctl, motor] = roleOf(getDef(a.type).kind) === 'control' ? [a, b] : [b, a];
      if (!isActuator(getDef(motor.type).kind) || roleOf(getDef(ctl.type).kind) !== 'control') continue;
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
      if (isActuator(kind) && kind !== 'motor') { const k = gadgetKeys(p); out.add(k.plus); out.add(k.minus); }
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
    // Pinned = joined to the background through any chain of joints (a
    // piston rod on a piston on a pin is pinned too).
    const edges = [...this.assembly.revolutes, ...this.assembly.prismatics, ...this.assembly.hinges];
    const pinned = new Set([WORLD]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of edges) {
        if (pinned.has(e.a) !== pinned.has(e.b)) { pinned.add(e.a); pinned.add(e.b); grew = true; }
      }
    }
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
    this._updateControls();
    this._updateGadgets(dt);
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

  /** Timers tick; pressure plates feel what's on them. */
  _updateControls() {
    for (const part of this.parts) {
      const kind = getDef(part.type).kind;
      if (kind === 'timer') {
        const every = Number(part.props.every ?? 1);
        this.setSignal(part.uid, Math.floor(this.time / every + 1e-9) % 2 === 1);
      } else if (kind === 'pressurePlate') {
        this.setSignal(part.uid, this._pressed(part));
      }
    }
  }

  /** Is anything (that isn't the plate's own machine) touching this plate? */
  _pressed(part) {
    const el = this.elements.get(mainKey(part.uid));
    const t = this.transformOf(part.uid);
    if (!el || !t) return false;
    const def = partDef(part);
    const c = Math.abs(Math.cos(t.angle)), s = Math.abs(Math.sin(t.angle));
    const ex = (def.width / 2) * c + (def.height / 2) * s + 0.1, ey = (def.width / 2) * s + (def.height / 2) * c + 0.1;
    let hit = false;
    this.world.queryAABB(planck.AABB(Vec2(t.x - ex, t.y - ey), Vec2(t.x + ex, t.y + ey)), (f) => {
      const b = f.getBody();
      if (b.isDynamic() && b !== el.body && !f.isSensor()) { hit = true; return false; }
      return true;
    });
    return hit;
  }

  // -------------------------------------------------------------- gadgets --
  /**
   * What a gadget is told to do: null = nobody's controlling it (it does its
   * default thing), otherwise -1..1 from its keys and wired controls.
   */
  _command(part) {
    const k = gadgetKeys(part);
    const ctls = this.wires.get(part.uid);
    if (k.plus === 'none' && k.minus === 'none' && !ctls) return null;
    let v = (this.held.has(k.plus) ? 1 : 0) - (this.held.has(k.minus) ? 1 : 0);
    for (const uid of ctls || []) {
      const ctl = this.byUid.get(uid);
      const s = this.signals.get(uid);
      if (getDef(ctl.type).kind === 'keyButton' && !isLegacyKey(ctl)) v += s;
      else if (s) v += (ctl.props.reverse ? -1 : 1) * Number(s);
    }
    return Math.max(-1, Math.min(1, v));
  }

  /** Is this gadget working right now? (for drawing flames, glow, belts) */
  gadgetOn(uid) { return this.gadgetState.get(uid)?.on ?? 0; }

  _updateGadgets(dt) {
    const g = this.settings.gravity;
    for (const part of this.parts) {
      const kind = getDef(part.type).kind;
      switch (kind) {
        case 'piston': this._piston(part); break;
        case 'trapdoor': this._door(part); break;
        case 'latch': this._latch(part); break;
        case 'bomb': this._bomb(part); break;
        case 'thruster': case 'magnet': case 'cannon': this._gadget(part, kind, dt); break;
        case 'conveyor': {
          const cmd = this._command(part);
          this.gadgetState.set(part.uid, { on: cmd == null ? 1 : cmd });
          break;
        }
        case 'balloon': {
          const t = this.elements.get(mainKey(part.uid));
          if (t && t.body !== this.ground) t.body.applyForceToCenter(Vec2(0, partDef(part).lift * (partDef(part).radius / 0.7) ** 2 * (g / 10)), true);
          break;
        }
        default: break;
      }
    }
    this._buoyancy();
    // Old cannon balls disappear.
    for (const s of this.shots) s.age += dt;
    while (this.shots.length && (this.shots.length > MAX_SHOTS || this.shots[0].age > 12)) {
      const body = this.shots.shift().body;
      this._dropHolds(body);
      this.world.destroyBody(body);
    }
    for (const b of this.booms) b.age += dt;
    this.booms = this.booms.filter((b) => b.age < 0.7);
  }

  _piston(part) {
    const p = this.pistons.get(part.uid);
    if (!p) return;
    const cmd = this._command(part);
    let v;
    if (cmd == null) {
      // Nobody's controlling it: push out, pull back, repeat.
      const x = p.joint.getJointTranslation() + p.offset;
      if (x >= p.stroke - 0.03) p.dir = -1;
      if (x <= 0.03) p.dir = 1;
      v = p.dir;
    } else v = cmd; // 0 = hold where it is
    p.joint.setMotorSpeed(v * PISTON_SPEED);
    p.joint.setMaxMotorForce(this.settings.motorTorque * PISTON_FORCE_PER_TORQUE);
    this.gadgetState.set(part.uid, { on: v });
  }

  /** Trap door: open while told to; with no control, open 2 s / shut 2 s. */
  _door(part) {
    const d = this.doors.get(part.uid);
    if (!d) return;
    const cmd = this._command(part);
    const open = cmd == null ? Math.floor(this.time / 2) % 2 === 1 : cmd > 0;
    const fast = part.props.speed === 'fast';
    d.joint.setMotorSpeed((open ? 1 : -1) * d.sign * DOOR_SPEED[fast ? 'fast' : 'gentle']);
    d.joint.setMaxMotorTorque(this.settings.motorTorque * (fast ? 4 : 2));
    this.gadgetState.set(part.uid, { on: open ? 1 : 0 });
  }

  /** Latch: lets go while told to (no control: after 2 s). Once it's told to
   *  hold again, it catches as soon as the two parts are back where they started. */
  _latch(part) {
    const l = this.latches.get(part.uid);
    if (!l) return;
    const cmd = this._command(part);
    const release = cmd == null ? this.time >= LATCH_AUTO : cmd > 0;
    if (release && l.joint) { this.world.destroyJoint(l.joint); l.joint = null; }
    if (!release && !l.joint) {
      const pa = l.a.getWorldPoint(l.la), pb = l.b.getWorldPoint(l.lb);
      let da = l.b.getAngle() - l.a.getAngle() - l.ref;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < 0.12 && Math.abs(da) < 0.06) this._lock(l);
    }
    this.gadgetState.set(part.uid, { on: l.joint ? 0 : 1 });
  }

  /** Bomb: goes off on a hard knock, or when its key / wired control says so. */
  _bomb(part) {
    const el = this.elements.get(mainKey(part.uid));
    if (!el) return; // already gone off
    const st = this.gadgetState.get(part.uid) ?? { on: 0 };
    const v = el.body.getLinearVelocity();
    // A knock = a big, sudden change that SLOWS it (hitting something), not
    // being flung (a catapult speeding it up).
    const knock = st.prev && this.time > 0.3 && Math.hypot(v.x - st.prev.x, v.y - st.prev.y) > BOMB_IMPACT &&
      Math.hypot(v.x, v.y) < Math.hypot(st.prev.x, st.prev.y);
    st.prev = { x: v.x, y: v.y };
    this.gadgetState.set(part.uid, st);
    const cmd = this._command(part);
    if (knock || (cmd != null && cmd > 0)) this._explode(part, el);
  }

  _explode(part, el) {
    const t = this.transformOf(part.uid);
    const body = el.body;
    for (let b = this.world.getBodyList(); b; b = b.getNext()) {
      if (!b.isDynamic()) continue;
      const c = b.getWorldCenter();
      const dx = c.x - t.x, dy = c.y - t.y, d = Math.hypot(dx, dy);
      if (d > BOMB_RANGE || (b === body && d < 1e-3)) continue;
      const J = BOMB_KICK * (1 - d / BOMB_RANGE);
      const n = d < 1e-3 ? { x: 0, y: 1 } : { x: dx / d, y: dy / d };
      b.applyLinearImpulse(Vec2(n.x * J, n.y * J), c, true);
    }
    this.booms.push({ x: t.x, y: t.y, age: 0 });
    // Take the bomb out (and its body, if nothing else is on it).
    this.elements.delete(mainKey(part.uid));
    for (let f = body.getFixtureList(); f;) {
      const next = f.getNext();
      if (f.uid === part.uid) {
        this.fixtures = this.fixtures.filter((x) => x.fixture !== f);
        body.destroyFixture(f);
      }
      f = next;
    }
    if (!body.getFixtureList() && body !== this.ground) {
      this._dropHolds(body);
      this.world.destroyBody(body);
    }
  }

  /** Explosions happening now, for drawing: [{ x, y, t }] (t = 0..1). */
  get boomsNow() { return this.booms.map((b) => ({ x: b.x, y: b.y, t: b.age / 0.7 })); }

  _gadget(part, kind, dt) {
    const el = this.elements.get(mainKey(part.uid));
    if (!el) return;
    const t = this.transformOf(part.uid);
    const dir = Vec2(Math.cos(t.angle), Math.sin(t.angle));
    const body = el.body;
    const cmd = this._command(part);
    const st = this.gadgetState.get(part.uid) ?? { on: 0, cool: 0.4 };
    st.cool -= dt;
    if (kind === 'thruster') {
      st.on = cmd == null ? 1 : cmd;
      if (st.on && body.isDynamic()) {
        const F = (THRUST[part.props.thrust] ?? THRUST.medium) * st.on;
        body.applyForce(Vec2(dir.x * F, dir.y * F), Vec2(t.x, t.y), true);
      }
    } else if (kind === 'magnet') {
      st.on = cmd == null ? 1 : cmd > 0 ? 1 : 0;
      st.held ??= [];
      if (st.on) this._magnet(t, body, st);
      else this._letGo(st);
    } else if (kind === 'cannon') {
      // Uncontrolled: fires every 1.5 s. Controlled: on press, then every 0.5 s while held.
      // (The cooldown keeps running while idle, so a fresh press fires at once.)
      const firing = cmd == null || cmd > 0;
      if (firing && st.cool <= 0) {
        this._fire(t, dir, body, CANNON_POWER[part.props.power] ?? CANNON_SPEED);
        st.cool = cmd == null ? 1.5 : 0.5;
      }
      st.on = Math.max(0, st.cool - (cmd == null ? 1 : 0)) / 0.5; // a puff of smoke just after a shot
    }
    this.gadgetState.set(part.uid, st);
  }

  /** Pull loose objects (crates, balls, hooks, cannon balls) toward the
   *  magnet; anything that reaches it sticks until the magnet turns off. */
  _magnet(t, magnetBody, st) {
    for (let b = this.world.getBodyList(); b; b = b.getNext()) {
      if (!b.isDynamic() || b === magnetBody || st.held.some((h) => h.body === b)) continue;
      let loose = false, size = 0;
      for (let f = b.getFixtureList(); f; f = f.getNext()) {
        if (f.getFilterCategoryBits() === CAT.OBJECT) loose = true;
        const bb = f.getAABB(0);
        size = Math.max(size, Math.min(bb.upperBound.x - bb.lowerBound.x, bb.upperBound.y - bb.lowerBound.y) / 2);
      }
      if (!loose) continue;
      const c = b.getWorldCenter();
      const dx = t.x - c.x, dy = t.y - c.y, d = Math.hypot(dx, dy);
      if (d > MAGNET_RANGE || d < 1e-3) continue;
      if (d < 0.5 + size && st.held.length < MAGNET_GRIP) {
        // Touching: stick it on.
        st.held.push({ body: b, joint: this.world.createJoint(WeldJoint({}, magnetBody, b, c)) });
        continue;
      }
      // An acceleration (so heavy and light things both come): beats gravity
      // within about 2 m, fades out by MAGNET_RANGE.
      const a = Math.min(50, 60 / (d * d + 1));
      const F = Vec2((dx / d) * a * b.getMass(), (dy / d) * a * b.getMass());
      b.applyForceToCenter(F, true);
      if (magnetBody.isDynamic()) magnetBody.applyForce(Vec2(-F.x, -F.y), Vec2(t.x, t.y), true);
    }
  }

  /** Turn a magnet off: drop everything it holds. */
  _letGo(st) {
    for (const h of st.held) this.world.destroyJoint(h.joint);
    st.held = [];
  }

  /** A body is about to disappear: magnets stop holding it. */
  _dropHolds(body) {
    for (const st of this.gadgetState.values()) {
      if (!st.held) continue;
      for (const h of st.held.filter((x) => x.body === body)) this.world.destroyJoint(h.joint);
      st.held = st.held.filter((x) => x.body !== body);
    }
  }

  /** Is a magnet holding something? (for drawing) */
  magnetHolding(uid) { return (this.gadgetState.get(uid)?.held?.length ?? 0) > 0; }

  /** Shoot a cannon ball, with a kick back on the cannon. */
  _fire(t, dir, body, speed = CANNON_SPEED) {
    const r = 0.25, m = 0.6;
    const ball = this.world.createBody({ type: 'dynamic', position: Vec2(t.x + dir.x * 0.75, t.y + dir.y * 0.75), bullet: true });
    this._addFixture(ball, Circle(Vec2(0, 0), r), { density: m / (Math.PI * r * r), friction: 0.5, restitution: 0.3, cat: CAT.OBJECT });
    const v0 = body.getLinearVelocityFromWorldPoint(Vec2(t.x, t.y));
    ball.setLinearVelocity(Vec2(v0.x + dir.x * speed, v0.y + dir.y * speed));
    if (body.isDynamic()) body.applyLinearImpulse(Vec2(-dir.x * m * speed, -dir.y * m * speed), Vec2(t.x, t.y), true);
    this.shots.push({ body: ball, age: 0 });
  }

  /** Cannon balls in flight, for drawing: [{ x, y, angle, r }]. */
  get shotsNow() {
    return this.shots.map((s) => { const p = s.body.getPosition(); return { x: p.x, y: p.y, angle: s.body.getAngle(), r: 0.25 }; });
  }

  /** Conveyor belts drag whatever touches them along the belt. */
  _conveyorContact(contact) {
    const fa = contact.getFixtureA(), fb = contact.getFixtureB();
    const belt = this.conveyors.get(fa) || this.conveyors.get(fb);
    if (!belt) return;
    const on = this.gadgetState.get(belt.uid)?.on ?? 1;
    // Tangent speed is measured along the contact normal's tangent, which
    // points from A to B: flip it when the belt is fixture B.
    const n = contact.getWorldManifold(null)?.normal;
    if (!n) return;
    const along = Vec2(Math.cos(belt.angle), Math.sin(belt.angle));
    const tangent = Vec2(n.y, -n.x); // Box2D's tangent = cross(normal, 1)
    const sign = (tangent.x * along.x + tangent.y * along.y) >= 0 ? 1 : -1;
    contact.setTangentSpeed(sign * on * CONVEYOR_SPEED * (this.conveyors.get(fa) ? 1 : -1));
  }

  /** Water: push up anything under the surface (by how much is under) and slow it down. */
  _buoyancy() {
    const pools = this.parts.filter((p) => getDef(p.type).kind === 'water').map((p) => {
      const d = partDef(p);
      return { x0: p.x - d.width / 2, x1: p.x + d.width / 2, y0: p.y - d.height / 2, y1: p.y + d.height / 2 };
    });
    if (!pools.length) return;
    const g = this.settings.gravity;
    for (let b = this.world.getBodyList(); b; b = b.getNext()) {
      if (!b.isDynamic()) continue;
      for (let f = b.getFixtureList(); f; f = f.getNext()) {
        if (f.isSensor()) continue;
        const bb = f.getAABB(0);
        const fx0 = bb.lowerBound.x, fy0 = bb.lowerBound.y, fx1 = bb.upperBound.x, fy1 = bb.upperBound.y;
        const boxArea = (fx1 - fx0) * (fy1 - fy0);
        if (boxArea <= 0) continue;
        const md = { mass: 0, center: Vec2(0, 0), I: 0 };
        f.getMassData(md);
        const area = f.getDensity() > 0 ? md.mass / f.getDensity() : boxArea * 0.7;
        for (const w of pools) {
          const ox = Math.min(fx1, w.x1) - Math.max(fx0, w.x0);
          const oy = Math.min(fy1, w.y1) - Math.max(fy0, w.y0);
          if (ox <= 0 || oy <= 0) continue;
          const sub = area * (ox * oy) / boxArea;          // area under water
          const cx = Math.max(fx0, w.x0) + ox / 2, cy = Math.max(fy0, w.y0) + oy / 2;
          const pt = Vec2(cx, cy);
          b.applyForce(Vec2(0, WATER_DENSITY * g * sub), pt, true);
          const v = b.getLinearVelocityFromWorldPoint(pt);
          b.applyForce(Vec2(-v.x * sub * 2.5, -v.y * sub * 2.5), pt, true); // water drag
        }
      }
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
