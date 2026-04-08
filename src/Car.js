import { angleDiff, clamp, vec2, bezierPoint, bezierLength } from './utils.js'

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
  arrivalRadius: 48 * 3, // 3× car width — must be > min turning radius (≈ 46px)
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
    this.path = null              // { p0, p1, p2, p3 } cubic bezier
    this._pathT = 0               // progress along path (0–1)
    this._pathLen = 0             // approximate arc length
  }

  driveTo(x, y) {
    this.target = { x, y }
    this._cumulativeRotation = 0
    this._avoidSpeedFactor = 0.97 + Math.random() * 0.06  // 0.97–1.03
    this._generatePath(x, y)
  }

  _generatePath(tx, ty) {
    const p0 = { x: this.x, y: this.y }
    const p3 = { x: tx, y: ty }

    const dx = p3.x - p0.x
    const dy = p3.y - p0.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist < 1) {
      this.path = null
      return
    }

    // Perpendicular to the straight line
    const px = -dy / dist
    const py = dx / dist

    // Random curvature — each control point gets an independent offset
    // for variety (arcs, S-curves, mild wiggles)
    const curve1 = (Math.random() - 0.5) * dist * 0.6
    const curve2 = (Math.random() - 0.5) * dist * 0.4

    const p1 = {
      x: p0.x + dx * 0.33 + px * curve1,
      y: p0.y + dy * 0.33 + py * curve1,
    }
    const p2 = {
      x: p0.x + dx * 0.67 + px * curve2,
      y: p0.y + dy * 0.67 + py * curve2,
    }

    this.path = { p0, p1, p2, p3 }
    this._pathT = 0
    this._pathLen = bezierLength(p0, p1, p2, p3)
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
    // Brake based on stopping distance only — the large arrival radius
    // is just for parking, not for triggering early deceleration
    const brakingDist = (this.speed * this.speed) / (2 * this.brakeDecel)
    const shouldBrake = realDist < brakingDist * 1.2
    const insideArrival = realDist < this.arrivalRadius

    // Sync path progress with actual position — derive from remaining
    // distance so the lookahead never falls behind the car
    if (this.path && this._pathT < 1) {
      const distanceT = 1 - (realDist / (this._pathLen || 1))
      const travelT = this._pathT + (this.speed * dt) / (this._pathLen || 1)
      this._pathT = clamp(Math.max(distanceT, travelT), this._pathT, 1)
    }

    let steerX, steerY
    if (this.path && this._pathT < 1) {
      // Lookahead: aim a bit ahead on the curve for smooth steering
      const lookahead = Math.min(this._pathT + 0.08, 1)
      const pt = bezierPoint(this.path.p0, this.path.p1, this.path.p2, this.path.p3, lookahead)
      const dx = pt.x - this.x
      const dy = pt.y - this.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      steerX = dx / d
      steerY = dy / d
    } else {
      steerX = realDx / (realDist || 1)
      steerY = realDy / (realDist || 1)
    }

    const targetHeading = Math.atan2(realDy / (realDist || 1), realDx / (realDist || 1))

    let avoiding = false
    if (!shouldBrake && !insideArrival) {
      const avoid = this._avoidanceForce(others)
      const avoidLen = Math.sqrt(avoid.x * avoid.x + avoid.y * avoid.y)
      if (avoidLen > 0.001) {
        steerX += avoid.x * 2.5
        steerY += avoid.y * 2.5
        avoiding = true
      }
    }

    let desiredHeading = Math.atan2(steerY, steerX)

    // Clamp avoidance deflection: never steer more than 30° away from
    // the direct-to-target heading, so avoidance can't cause full orbits
    const maxDeflection = 15 * DEG
    const deflection = angleDiff(targetHeading, desiredHeading)
    if (Math.abs(deflection) > maxDeflection) {
      desiredHeading = targetHeading + Math.sign(deflection) * maxDeflection
    }
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

    // Proximity brake: slow down when very close to another car
    let proximityFactor = 1
    for (const other of others) {
      if (other === this) continue
      const dx = this.x - other.x
      const dy = this.y - other.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const safetyDist = this.width * 1.5
      if (dist < safetyDist) {
        proximityFactor = Math.min(proximityFactor, dist / safetyDist)
      }
    }

    const effectiveMax = this.maxSpeed * alignFactor * proximityFactor

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
    const radius = this.width * 0.5
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
