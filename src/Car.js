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
  arrivalRadius: 55,   // px — must be > min turning radius (wheelbase/tan(maxSteering) ≈ 46)
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
    this.maxSpeed = cfg.maxSpeed * (0.8 + Math.random() * 0.4)  // ±20% variation
    this.acceleration = cfg.acceleration
    this.brakeDecel = cfg.brakeDecel
    this.maxSteering = cfg.maxSteering * DEG
    this.steeringRate = cfg.steeringRate * DEG
    this.arrivalRadius = cfg.arrivalRadius
    this.skidThreshold = cfg.skidThreshold
    this.color = cfg.color

    this.target = null  // { x, y }
    this._skidding = false
    this._cumulativeRotation = 0  // tracks total rotation for orbit detection
    this._orbiting = false        // true when braking out of an orbit
    this._avoidSpeedFactor = 1    // random speed tweak when avoiding
  }

  driveTo(x, y) {
    this.target = { x, y }
    this._cumulativeRotation = 0
    this._avoidSpeedFactor = 0.97 + Math.random() * 0.06  // 0.97–1.03
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

    let avoiding = false
    if (!shouldBrake) {
      const avoid = this._avoidanceForce(others)
      const avoidLen = Math.sqrt(avoid.x * avoid.x + avoid.y * avoid.y)
      if (avoidLen > 0.001) {
        // Blend: mostly target direction, plus lateral avoidance push
        steerX += avoid.x * 2.5
        steerY += avoid.y * 2.5
        avoiding = true
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

    // Scale target speed by alignment — slow down when pointing away
    // from the target so the car can tighten its turn instead of overshooting
    const alignment = Math.cos(headingError)               // 1 = on target, 0 = perpendicular, -1 = backwards
    const alignFactor = clamp(0.3 + 0.7 * alignment, 0.3, 1) // at worst 30% of max speed
    const effectiveMax = this.maxSpeed * alignFactor

    if (shouldBrake) {
      this._skidding = this.speed > this.skidThreshold
      this.speed = Math.max(0, this.speed - this.brakeDecel * dt)
    } else if (this.speed > effectiveMax) {
      // Too fast for current heading error — ease off
      this._skidding = false
      this.speed = Math.max(effectiveMax, this.speed - this.brakeDecel * 0.5 * dt)
    } else {
      this._skidding = false
      this.speed = Math.min(effectiveMax, this.speed + this.acceleration * dt)
      if (avoiding) this.speed *= this._avoidSpeedFactor
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

    // Track cumulative rotation for orbit detection — only near the finish
    const nearFinish = realDist < this.width * 5
    if (nearFinish && this.speed > 5) {
      const angularVel = (this.speed / this.wheelbase) * Math.tan(this.steeringAngle)
      this._cumulativeRotation += Math.abs(angularVel * dt)
    } else if (!nearFinish) {
      this._cumulativeRotation = 0
      this._orbiting = false
    }

    // Orbit escape: if the car has done a full rotation near the finish,
    // it's stuck. Begin braking to a stop.
    if (this._cumulativeRotation > Math.PI * 2) {
      this._orbiting = true
      this._cumulativeRotation = 0
    }
    if (this._orbiting) {
      this.speed = Math.max(0, this.speed - this.brakeDecel * 0.6 * dt)
      if (this.speed < 2) {
        this.speed = 0
        this.steeringAngle = 0
        this._skidding = false
        this._orbiting = false
        this.target = null
      }
    }

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
