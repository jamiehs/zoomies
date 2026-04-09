import { angleDiff, clamp, vec2, bezierPoint, bezierLength } from './utils.js'

const DEG = Math.PI / 180

// Physics defaults — all tunable via constructor options.
const DEFAULTS = {
  // width is intentionally absent — derived as wheelbase * 1.5 unless explicitly set
  height: 24,
  wheelbase: 32,         // px — distance between axles; also drives visual body length
  tireWidth: 4,          // px — skidmark line width
  maxSpeed: 320,         // px/s
  acceleration: 220,     // px/s²
  brakeDecel: 480,       // px/s²
  maxSteering: 35,       // degrees
  steeringRate: 120,     // degrees/s — how fast the wheel turns
  arrivalRadius: 144,    // ~3× car width — must be > min turning radius (≈ 46px)
  skidThreshold: 150,    // px/s — speed above which arrival triggers a skid
  color: '#e63946',
  // Exhaust afterfire flash
  exhaustPosition: null, // 'left' | 'right' | 'bothSides' | 'rear'
  exhaustOffset: 0.5,    // 0–1 along the chosen edge (see _exhaustPositions)
  exhaustRadius: 6,      // px — radius of each exhaust flash circle
  exhaustInterval: 2.2,  // seconds — minimum time between flashes; actual interval is exhaustInterval × (1 + random)
  // Sprite: URL string or HTMLImageElement; null = draw rectangle body
  sprite: null,
}

export class Car {
  constructor(x, y, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts }

    this.x = x
    this.y = y
    this.heading = opts.heading ?? (Math.random() * Math.PI * 2)
    this.speed = 0
    this.steeringAngle = 0   // radians; positive = turn left

    this.wheelbase = cfg.wheelbase
    this.width = cfg.width ?? this.wheelbase * 1.5  // body length derived from wheelbase
    this.height = cfg.height
    this.tireWidth = cfg.tireWidth
    this.maxSpeed = cfg.maxSpeed * (0.8 + Math.random() * 0.4)  // ±20% variation
    this.acceleration = cfg.acceleration
    this.brakeDecel = cfg.brakeDecel
    this.maxSteering = cfg.maxSteering * DEG
    this.steeringRate = cfg.steeringRate * DEG
    this.arrivalRadius = cfg.arrivalRadius
    this.skidThreshold = cfg.skidThreshold
    this.color = cfg.color

    // Exhaust afterfire
    this.exhaustPosition = cfg.exhaustPosition ?? null
    this.exhaustOffset   = cfg.exhaustOffset ?? 0.5
    this.exhaustRadius   = cfg.exhaustRadius ?? 6
    this.exhaustInterval = cfg.exhaustInterval ?? 3
    this._exhaustTimer = this.exhaustInterval * (1 + Math.random())  // seconds until first flash
    this._exhaustFrame = -1  // -1 = inactive; 0–4 = animation frame index

    // Sprite — accepts a URL string or an existing HTMLImageElement
    if (typeof cfg.sprite === 'string') {
      this.sprite = new Image()
      this.sprite.src = cfg.sprite
    } else {
      this.sprite = cfg.sprite ?? null
    }

    this.target = null  // { x, y }
    this.orbitDetection = true
    this.proximityBoost = true
    this._skidding = false
    this._cumulativeRotation = 0  // tracks total rotation for orbit detection
    this._orbiting = false        // true when braking out of an orbit
    this._avoidSpeedFactor = 1    // random speed tweak when avoiding
    this._wasColliding = false    // set by collision resolver each frame
    this._debugAvoiding = false   // true this frame if actively avoiding
    this._debugAvoidTargets = []  // cars being avoided this frame
    this._debugDesiredHeading = 0 // heading the car is trying to steer toward
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
    // Exhaust afterfire — gear-shift flash, independent of driving state
    if (this.exhaustPosition && this.speed > 50) {
      this._exhaustTimer -= dt
      if (this._exhaustTimer <= 0) {
        this._exhaustFrame = 0
        this._exhaustTimer = this.exhaustInterval * (1 + Math.random())
      }
    }
    if (this._exhaustFrame >= 0) {
      this._exhaustFrame++
      if (this._exhaustFrame >= 5) this._exhaustFrame = -1
    }

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

    // Inside arrival radius: just brake to a stop, don't steer
    if (insideArrival) {
      this.speed = Math.max(0, this.speed - this.brakeDecel * dt)
      this._applyBicycleModel(dt)
      if (this.speed < 10) {
        this.speed = 0
        this.steeringAngle = 0
        this._skidding = false
        this.target = null
        this.path = null
      }
      return
    }

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
    this._debugAvoidTargets = []
    if (!shouldBrake && !insideArrival) {
      const avoid = this._avoidanceForce(others)
      const avoidLen = Math.sqrt(avoid.x * avoid.x + avoid.y * avoid.y)
      if (avoidLen > 0.001) {
        steerX += avoid.x * 2.5
        steerY += avoid.y * 2.5
        avoiding = true
      }
    }
    this._debugAvoiding = avoiding

    const desiredHeading = Math.atan2(steerY, steerX)
    const headingError = angleDiff(this.heading, desiredHeading)
    this._debugDesiredHeading = desiredHeading

    // Drive steering toward desired, clamped to maxSteering
    const targetSteering = clamp(headingError, -this.maxSteering, this.maxSteering)
    const steerDelta = clamp(
      targetSteering - this.steeringAngle,
      -this.steeringRate * dt,
      this.steeringRate * dt,
    )
    this.steeringAngle += steerDelta

    // Scale target speed by alignment — slow down when pointing away
    // from the target so the car can tighten its turn instead of overshooting.
    // But don't penalize alignment when in a collision (heading gets knocked around)
    const alignment = Math.cos(headingError)
    const alignFloor = this._wasColliding ? 0.7 : 0.3
    const alignFactor = clamp(alignFloor + (1 - alignFloor) * alignment, alignFloor, 1)

    // Proximity response: when very close to another car, the lead car
    // (closer to target) gets a speed boost to pull away; the trailing
    // car maintains its current speed. Neither slows down.
    let proximityBoost = 0
    if (this.proximityBoost) {
      for (const other of others) {
        if (other === this) continue
        const dx = this.x - other.x
        const dy = this.y - other.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        const safetyDist = this.width * 1.5
        if (dist < safetyDist) {
          const myDist = realDist
          const otherDx = (other.target ? other.target.x : other.x) - other.x
          const otherDy = (other.target ? other.target.y : other.y) - other.y
          const otherDist = Math.sqrt(otherDx * otherDx + otherDy * otherDy)
          if (myDist < otherDist) {
            // We're the lead car — boost to pull away
            const urgency = 1 - (dist / safetyDist)
            const boostAmount = this._wasColliding ? urgency * 0.7 : urgency * 0.3
            proximityBoost = Math.max(proximityBoost, boostAmount)
          }
        }
      }
    }

    const effectiveMax = this.maxSpeed * alignFactor * (1 + proximityBoost)

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
    if (this.orbitDetection) {
      const nearFinish = realDist < this.width * 5
      if (nearFinish && this.speed > 5) {
        const angularVel = (this.speed / this.wheelbase) * Math.tan(this.steeringAngle)
        this._cumulativeRotation += Math.abs(angularVel * dt)
      } else if (!nearFinish) {
        this._cumulativeRotation = 0
        this._orbiting = false
      }

      if (this._cumulativeRotation > Math.PI * 2) {
        this._orbiting = true
        this._cumulativeRotation = 0
      }
    } else {
      this._cumulativeRotation = 0
      this._orbiting = false
    }

    // Orbit escape: brake to a stop if stuck circling
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
    const radius = this.width * 0.66
    let fx = 0
    let fy = 0
    const avoidTargets = []

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
        avoidTargets.push(other)
      }
    }

    this._debugAvoidTargets = avoidTargets
    return { x: fx, y: fy }
  }

  /** @param {CanvasRenderingContext2D} ctx @param {{ shadow?: boolean, shadowOpacity?: number, shadowBlur?: number, shadowOffsetX?: number, shadowOffsetY?: number }} renderOpts */
  render(ctx, renderOpts = {}) {
    const w = this.width
    const h = this.height
    const r = 5  // corner radius

    // Ground shadow — drawn in a separate transform so the offset is in
    // page-space (world-space), not car-local space. Zero offset = centered.
    if (renderOpts.shadow !== false) {
      const opacity = renderOpts.shadowOpacity ?? 0.40
      const blur    = renderOpts.shadowBlur    ?? 4
      const ox      = renderOpts.shadowOffsetX ?? 0
      const oy      = renderOpts.shadowOffsetY ?? 0
      ctx.save()
      ctx.translate(this.x + ox, this.y + oy)
      ctx.rotate(this.heading)
      ctx.filter = `blur(${blur}px)`
      ctx.fillStyle = `rgba(0,0,0,${opacity})`
      ctx.fillRect(-w / 2, -h / 2, w, h)
      ctx.filter = 'none'
      ctx.restore()
    }

    ctx.save()
    ctx.translate(this.x, this.y)
    ctx.rotate(this.heading)

    // Body — sprite if loaded, otherwise rectangle
    if (this.sprite && this.sprite.complete && this.sprite.naturalWidth > 0) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(this.sprite, -w / 2, -h / 2, w, h)
    } else {
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, r)
      ctx.fillStyle = this.color
      ctx.fill()

      // Windshield stripe (front third, slightly darker)
      ctx.beginPath()
      ctx.roundRect(w / 2 - w / 3, -h / 2 + 3, w / 3 - 3, h - 6, 2)
      ctx.fillStyle = 'rgba(0,0,0,0.25)'
      ctx.fill()
    }

    // Exhaust afterfire flash
    if (this._exhaustFrame >= 0 && this.exhaustPosition) {
      const OPACITIES = [0.5, 1.0, 1.0, 0.66, 0.33]
      const opacity = OPACITIES[this._exhaustFrame] ?? 0
      const radius = this.exhaustRadius
      ctx.fillStyle = `rgba(255, 220, 0, ${opacity})`
      for (const p of this._exhaustPositions(w, h)) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    ctx.restore()
  }

  /**
   * Returns exhaust point(s) in car-local space.
   * x-axis = forward, y-axis = right side of car (canvas y-down convention).
   * offset 0 = front/left-corner, offset 1 = rear/right-corner.
   */
  _exhaustPositions(w, h) {
    const o = this.exhaustOffset
    const sideX  = w / 2 - o * w   // offset=0 → front (+w/2), offset=1 → rear (−w/2)
    const rearY  = -h / 2 + o * h  // offset=0 → left corner, offset=1 → right corner
    switch (this.exhaustPosition) {
      case 'left':      return [{ x: sideX, y: -h / 2 }]
      case 'right':     return [{ x: sideX, y:  h / 2 }]
      case 'bothSides': return [{ x: sideX, y: -h / 2 }, { x: sideX, y: h / 2 }]
      case 'rear':      return [{ x: -w / 2, y: rearY }]
      default:          return []
    }
  }
}
