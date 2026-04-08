import { angleDiff, clamp, vec2 } from './utils.js'

const DEG = Math.PI / 180

// Physics defaults — all tunable via constructor options.
const DEFAULTS = {
  width: 48,
  height: 24,
  wheelbase: 32,       // px — distance between axles
  maxSpeed: 320,       // px/s
  acceleration: 220,   // px/s²
  brakeDecel: 480,     // px/s²
  maxSteering: 35,     // degrees
  steeringRate: 120,   // degrees/s — how fast the wheel turns
  arrivalRadius: 12,   // px — "close enough" to target
  skidThreshold: 150,  // px/s — speed above which arrival triggers a skid
  color: '#e63946',
}

export class Car {
  constructor(x, y, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts }

    this.x = x
    this.y = y
    this.heading = opts.heading ?? (Math.random() * Math.PI * 2)
    this.speed = 0
    this.steeringAngle = 0   // radians; positive = turn left

    this.width = cfg.width
    this.height = cfg.height
    this.wheelbase = cfg.wheelbase
    this.maxSpeed = cfg.maxSpeed
    this.acceleration = cfg.acceleration
    this.brakeDecel = cfg.brakeDecel
    this.maxSteering = cfg.maxSteering * DEG
    this.steeringRate = cfg.steeringRate * DEG
    this.arrivalRadius = cfg.arrivalRadius
    this.skidThreshold = cfg.skidThreshold
    this.color = cfg.color

    this.target = null  // { x, y }
    this._skidding = false
  }

  driveTo(x, y) {
    this.target = { x, y }
  }

  /**
   * @param {number} dt  Delta time in seconds.
   * @param {Car[]} others  All other cars for avoidance.
   */
  update(dt, others) {
    if (!this.target) {
      // Coast to a stop
      if (this.speed > 0) {
        this.speed = Math.max(0, this.speed - this.brakeDecel * dt)
        this._applyBicycleModel(dt)
      }
      return
    }

    // Distance to the actual target
    const realDx = this.target.x - this.x
    const realDy = this.target.y - this.y
    const realDist = Math.sqrt(realDx * realDx + realDy * realDy)

    // --- Speed control ---
    const brakingDist = (this.speed * this.speed) / (2 * this.brakeDecel)
    const shouldBrake = realDist < this.arrivalRadius + brakingDist

    // Always steer toward the real target, but blend in avoidance as a
    // lateral bias while cruising. This way the car curves around others
    // en route but never loses sight of where it's actually going.
    const toTargetX = realDx / (realDist || 1)
    const toTargetY = realDy / (realDist || 1)

    let steerX = toTargetX
    let steerY = toTargetY

    if (!shouldBrake) {
      const avoid = this._avoidanceForce(others)
      const avoidLen = Math.sqrt(avoid.x * avoid.x + avoid.y * avoid.y)
      if (avoidLen > 0.001) {
        // Blend: mostly target direction, plus lateral avoidance push
        steerX += avoid.x * 2.5
        steerY += avoid.y * 2.5
      }
    }

    const desiredHeading = Math.atan2(steerY, steerX)
    const headingError = angleDiff(this.heading, desiredHeading)

    // Drive steering toward desired, clamped to maxSteering
    const targetSteering = clamp(headingError, -this.maxSteering, this.maxSteering)
    const steerDelta = clamp(
      targetSteering - this.steeringAngle,
      -this.steeringRate * dt,
      this.steeringRate * dt,
    )
    this.steeringAngle += steerDelta

    if (shouldBrake) {
      this._skidding = this.speed > this.skidThreshold
      this.speed = Math.max(0, this.speed - this.brakeDecel * dt)
    } else {
      this._skidding = false
      this.speed = Math.min(this.maxSpeed, this.speed + this.acceleration * dt)
    }

    // Skid: allow mild steering overshoot for a drift look
    if (this._skidding) {
      this.steeringAngle = clamp(
        this.steeringAngle * 1.4,
        -this.maxSteering * 1.4,
        this.maxSteering * 1.4,
      )
    }

    this._applyBicycleModel(dt)

    // Arrival
    if (realDist < this.arrivalRadius && this.speed < 10) {
      this.speed = 0
      this.steeringAngle = 0
      this._skidding = false
      this.target = null
    }
  }

  _applyBicycleModel(dt) {
    if (this.speed === 0) return
    // Rear-axle bicycle model
    const angularVel = (this.speed / this.wheelbase) * Math.tan(this.steeringAngle)
    this.heading += angularVel * dt
    this.x += Math.cos(this.heading) * this.speed * dt
    this.y += Math.sin(this.heading) * this.speed * dt
  }

  /**
   * Returns a normalized-ish repulsion vector pointing away from nearby cars.
   * Used as a steering bias, NOT a target offset.
   */
  _avoidanceForce(others) {
    const radius = this.width * 1.2
    let fx = 0
    let fy = 0

    for (const other of others) {
      if (other === this) continue
      const dx = this.x - other.x
      const dy = this.y - other.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const minDist = radius + other.width * 0.6

      if (dist < minDist && dist > 0) {
        const strength = (minDist - dist) / minDist
        fx += (dx / dist) * strength
        fy += (dy / dist) * strength
      }
    }

    return { x: fx, y: fy }
  }

  /** @param {CanvasRenderingContext2D} ctx */
  render(ctx) {
    ctx.save()
    ctx.translate(this.x, this.y)
    ctx.rotate(this.heading)

    const w = this.width
    const h = this.height
    const r = 5  // corner radius

    // Body
    ctx.beginPath()
    ctx.roundRect(-w / 2, -h / 2, w, h, r)
    ctx.fillStyle = this.color
    ctx.fill()

    // Windshield stripe (front third, slightly darker)
    ctx.beginPath()
    ctx.roundRect(w / 2 - w / 3, -h / 2 + 3, w / 3 - 3, h - 6, 2)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fill()

    // Skid indicator: darken the whole car slightly when skidding
    if (this._skidding) {
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, r)
      ctx.fillStyle = 'rgba(0,0,0,0.2)'
      ctx.fill()
    }

    ctx.restore()
  }
}
