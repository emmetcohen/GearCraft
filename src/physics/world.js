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
export const CAT = { GROUND: 0x1, OBJECT: 0x2, MACHINE: 0x4, WHEEL: 0x8 };
const MASK = {
  [CAT.GROUND]: 0xffff,
  [CAT.OBJECT]: 0xffff,
  [CAT.MACHINE]: CAT.GROUND | CAT.OBJECT,
  [CAT.WHEEL]: CAT.GROUND | CAT.OBJECT,
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

export class Simulation {
  /**
   * @param build    the build (plain data, not modified)
   * @param settings { gravity, friction, motorTorque, motorRpm }
   * @param map      { groundHalfWidth } from the game mode
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
    this.throttle = 0;            // -1..1 from the arrow keys, for key-driven motors

    this._createBodies(map);
    this._createRevolutes();
    this._createPrismatics();
    this._createGearJoints();
    this._createLinks();
    this.applySettings(settings);

    this.grab = null;        // mouse joint on a loose body
    this.crankGrab = null;   // { uid, target: {x,y} }
  }

  // ------------------------------------------------------------- building --
  _createBodies(map) {
    const ground = this.world.createBody({ type: 'static' });
    this.bodies.set(WORLD, ground);
    this.ground = ground;
    const half = map.groundHalfWidth;
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
    const add = (shape, area, opts) => this._addFixture(body, shape, { density: mass / area, ...opts });

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
   *  any shape there (crates, beams...), otherwise the background. */
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
    return this.ground;
  }

  /** Springs and ropes: each end grabs whatever it touches. */
  _createLinks() {
    for (const part of this.parts) {
      const def = partDef(part);
      if (def.kind !== 'spring' && def.kind !== 'rope') continue;
      const [e1, e2] = lineEnds(part);
      const bodyA = this._bodyAt(e1), bodyB = this._bodyAt(e2);
      const link = { bodyA, la: bodyA.getLocalPoint(Vec2(e1.x, e1.y)), bodyB, lb: bodyB.getLocalPoint(Vec2(e2.x, e2.y)), joint: null };
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
    const dir = d.part.props.reverse ? -1 : 1;
    // Key-driven motors: → turns clockwise (rolls a car right), ← back,
    // no key = hold still (a brake).
    const amount = d.part.props.keys ? -this.throttle : 1;
    d.joint.setMotorSpeed(dir * amount * rpmToRad(this.settings.motorRpm));
    d.joint.setMaxMotorTorque(this.settings.motorTorque);
  }

  /** Arrow-key input for key-driven motors: -1 (←), 0 or 1 (→). */
  setThrottle(v) {
    if (v === this.throttle) return;
    this.throttle = v;
    for (const d of this.driverJoints.values()) {
      if (d.kind !== 'motor' || !d.part.props.keys || this.jammedBodies.has(d.bodyId)) continue;
      this._driveMotor(d);
      d.joint.getBodyB().setAwake(true);
    }
  }

  /** Does this machine have any arrow-key motors? */
  get hasKeyMotors() {
    return [...this.driverJoints.values()].some((d) => d.kind === 'motor' && d.part.props.keys);
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
