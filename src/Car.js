import { angleDiff, clamp, bezierPoint, bezierLength } from './utils.js'

const DEG = Math.PI / 180

// Physics defaults — all tunable via constructor options.
const DEFAULTS = {
  // width is intentionally absent — derived as wheelbase * 1.5 unless explicitly set
  height: 24,
  wheelbase: 32,         // px — distance between axles; also drives visual body length
  tireWidth: 4,          // px — skidmark line width
  maxSpeed: 320,         // px/s
  acceleration: 220,     // px/s²
  brakes: 0.5,           // 0–1: braking strength (0 = poor ~60 px/s², 0.5 = default ~480 px/s², 1 = ABS ~900 px/s²)
  maxSteering: 35,       // ± degrees from centre (total lock-to-lock = maxSteering × 2)
  steeringRate: 120,     // degrees/s — how fast the wheel turns
  twitchiness: 0.4, // 0–1: high-speed steering damping (0 = super stable, 1 = very twitchy)
  arrivalRadius: 144,    // ~3× car width — must be > min turning radius (≈ 46px)
  skidThreshold: 150,    // px/s — speed above which arrival triggers a skid
  grip: 1.0,             // 0–1: tire grip — scales skid threshold, slip stiffness, slip visual, and braking force
  slipStiffness: 34,     // rear slip spring constant — ω_n = √34 ≈ 5.8 rad/s
  slipDamping: 3,        // slip damper — ζ ≈ 0.34, underdamped with clear overshoot
  slipScale: 1.0,        // multiplier on the mark offset — increase to exaggerate the visual wiggle
  driveBias: 1.0,        // 0 = FWD, 1 = RWD, 0–1 = AWD (affects accel skidmarks)
  aggression: 0.3,       // 0–1: how much the car follows the bezier path while braking (0 = careful/direct, 1 = committed/aggressive)
                         // TODO: consolidate other aggression-flavoured behaviours under this prop (e.g. avoidance assertiveness, arrival overshoot tolerance)
  shadowCornerRadius: 4, // px — corner radius of the shadow rectangle (0 = sharp)
  color: '#e63946',
  // Exhaust afterfire flash
  exhaustPosition: null, // 'left' | 'right' | 'bothSides' | 'rear'
  exhaustOffset: 0.5,    // 0–1 along the chosen edge (see _exhaustPositions)
  exhaustRadius: 6,      // px — base radius of the flame; scales length and width proportionally
  exhaustInterval: 0.9,  // seconds — minimum time between flashes; actual interval is exhaustInterval × (1 + random)
  exhaustAngle: 90,      // degrees — 90 = perpendicular to car side; up to 170 = swept back toward tail (side exhausts only)
  exhaustInset: 0,       // px — moves the emission point inboard from the car edge (toward centre)
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
    // brakeDecel: explicit override takes priority, otherwise derived from brakes (0–1)
    this.brakeDecel = opts.brakeDecel ?? (60 + cfg.brakes * 840)
    this.maxSteering = cfg.maxSteering * DEG
    this.steeringRate = cfg.steeringRate * DEG
    this.twitchiness = cfg.twitchiness
    this.arrivalRadius = cfg.arrivalRadius
    this.grip          = cfg.grip
    this.skidThreshold = cfg.skidThreshold
    this.slipStiffness = cfg.slipStiffness
    this.slipDamping   = cfg.slipDamping
    this.slipScale     = cfg.slipScale
    this.driveBias          = cfg.driveBias
    this.aggression         = cfg.aggression
    this.shadowCornerRadius = cfg.shadowCornerRadius
    this._slipAngle    = 0   // rear slip angle (rad); positive = rear slides right
    this._slipVel      = 0   // d(slipAngle)/dt
    this.color = cfg.color

    // Exhaust afterfire
    this.exhaustPosition = cfg.exhaustPosition ?? null
    this.exhaustOffset   = cfg.exhaustOffset ?? 0.5
    this.exhaustRadius   = cfg.exhaustRadius ?? 6
    this.exhaustInterval = cfg.exhaustInterval ?? 3
    this.exhaustAngle    = cfg.exhaustAngle  ?? 90
    this.exhaustInset    = cfg.exhaustInset  ?? 0
    this._exhaustTimer   = this.exhaustInterval * (1 + Math.random())  // seconds until first flash
    this._exhaustFrame   = -1   // -1 = inactive; 0–4 = animation frame index
    this._exhaustPending = 0    // follow-up pops queued in current burst (0 = single)
    this._exhaustScale   = 1    // random size multiplier, re-rolled each pop
    this._exhaustWiggle  = null // per-pop shape randomisation, re-rolled each pop

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
    this._playerControlled = false  // true when the user has taken over this car
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

  driveTo(x, y, sharedMid = null) {
    this.target = { x, y }
    this._cumulativeRotation = 0
    this._avoidSpeedFactor = 0.97 + Math.random() * 0.06  // 0.97–1.03
    this._generatePath(x, y, sharedMid)
  }

  _generatePath(tx, ty, sharedMid = null) {
    const p0 = { x: this.x, y: this.y }
    const p3 = { x: tx, y: ty }

    const dx = p3.x - p0.x
    const dy = p3.y - p0.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist < 1) {
      this.path = null
      return
    }

    // Forward and perpendicular unit vectors
    const fx = dx / dist
    const fy = dy / dist
    const px = -fy
    const py = fx

    // p1: if a shared midpoint is provided (fleet racing line), all cars funnel
    // through that region with a small individual jitter. Otherwise pure random.
    let p1
    if (sharedMid) {
      const jitter = dist * 0.12
      p1 = {
        x: sharedMid.x + (Math.random() - 0.5) * jitter,
        y: sharedMid.y + (Math.random() - 0.5) * jitter,
      }
    } else {
      const curve1 = (Math.random() - 0.5) * dist * 0.65
      p1 = {
        x: p0.x + fx * dist * 0.33 + px * curve1,
        y: p0.y + fy * dist * 0.33 + py * curve1,
      }
    }

    // p2: arrival — 15% chance of a wild approach angle (from side or behind),
    // otherwise a moderate sweep independently randomised per car.
    let p2
    if (Math.random() < 0.15) {
      const approachAngle = Math.random() * Math.PI * 2
      const approachDist  = dist * (0.2 + Math.random() * 0.25)
      p2 = {
        x: p3.x + Math.cos(approachAngle) * approachDist,
        y: p3.y + Math.sin(approachAngle) * approachDist,
      }
    } else {
      const curve2 = (Math.random() - 0.5) * dist * 0.55
      p2 = {
        x: p0.x + fx * dist * 0.67 + px * curve2,
        y: p0.y + fy * dist * 0.67 + py * curve2,
      }
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
    this._updateExhaust(dt)

    if (!this.target) {
      // Coast to a stop
      if (this.speed > 0) {
        const effectiveBrakeDecel = this.brakeDecel * (0.3 + 0.7 * this.grip)
        this.speed = Math.max(0, this.speed - effectiveBrakeDecel * dt)
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
    const effectiveBrakeDecel = this.brakeDecel * (0.3 + 0.7 * this.grip)
    const brakingDist = (this.speed * this.speed) / (2 * effectiveBrakeDecel)
    const shouldBrake = realDist < brakingDist * 1.2
    const insideArrival = realDist < this.arrivalRadius

    // Inside arrival radius: brake to a stop, but keep avoidance active so
    // cars don't blindly drive through each other while parking.
    if (insideArrival) {
      const avoid = this._avoidanceForce(others)
      const avoidLen = Math.sqrt(avoid.x * avoid.x + avoid.y * avoid.y)
      if (avoidLen > 0.001) {
        const desiredH = Math.atan2(avoid.y, avoid.x)
        const err = angleDiff(this.heading, desiredH)
        const targetSteering = clamp(err, -this.maxSteering, this.maxSteering)
        this.steeringAngle += clamp(targetSteering - this.steeringAngle, -this.steeringRate * dt, this.steeringRate * dt)
      } else {
        // No neighbours — let the wheel straighten naturally
        this.steeringAngle *= Math.max(0, 1 - dt * 4)
      }
      this.speed = Math.max(0, this.speed - effectiveBrakeDecel * dt)
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

    // Compute bezier lookahead direction — shared by path following and steering scaling.
    // bx/by default to aiming straight at the target when no active path.
    let bx = realDx / (realDist || 1)
    let by = realDy / (realDist || 1)
    // bezierAlignment: 1 = car heading matches bezier direction, 0 = fully sideways.
    // Drives adaptive aggression damping and steering boost — when the car is
    // oscillating it drops naturally, collapsing the boost and self-damping the weave.
    let bezierAlignment = 1

    if (this.path && this._pathT < 1) {
      const speedRatioLA = clamp(this.speed / this.maxSpeed, 0, 1)
      const lookaheadT   = 0.06 + speedRatioLA * 0.14   // 6% at rest → 20% at max speed
      const lookahead    = Math.min(this._pathT + lookaheadT, 1)
      const pt = bezierPoint(this.path.p0, this.path.p1, this.path.p2, this.path.p3, lookahead)
      const dx = pt.x - this.x
      const dy = pt.y - this.y
      const d  = Math.sqrt(dx * dx + dy * dy) || 1
      bx = dx / d
      by = dy / d
      bezierAlignment = Math.max(0, Math.cos(angleDiff(this.heading, Math.atan2(by, bx))))
    }

    let steerX, steerY
    if (this.path && this._pathT < 1 && (!shouldBrake || this.aggression > 0)) {
      if (shouldBrake && this.aggression < 1) {
        // Blend toward direct target as aggression decreases.
        // Dampen aggression by bezierAlignment so oscillating/sideways cars aim
        // directly at the target instead of amplifying the weave.
        const effectiveAggression = this.aggression * bezierAlignment
        const tx  = realDx / (realDist || 1)
        const ty  = realDy / (realDist || 1)
        steerX = tx + (bx - tx) * effectiveAggression
        steerY = ty + (by - ty) * effectiveAggression
        const sLen = Math.sqrt(steerX * steerX + steerY * steerY) || 1
        steerX /= sLen
        steerY /= sLen
      } else {
        steerX = bx
        steerY = by
      }
    } else {
      // Past the path end or aggression=0 while braking: aim straight at target.
      steerX = realDx / (realDist || 1)
      steerY = realDy / (realDist || 1)
    }

    const targetHeading = Math.atan2(realDy / (realDist || 1), realDx / (realDist || 1))

    let avoiding = false
    this._debugAvoidTargets = []
    if (!insideArrival) {
      const avoid = this._avoidanceForce(others)
      const avoidLen = Math.sqrt(avoid.x * avoid.x + avoid.y * avoid.y)
      if (avoidLen > 0.001) {
        // Reduce avoidance authority while braking so parked cars near the
        // target zone don't repel the arriving car away from its destination.
        const avoidWeight = shouldBrake ? 0.8 : 2.5
        steerX += avoid.x * avoidWeight
        steerY += avoid.y * avoidWeight
        avoiding = true
      }
    }
    this._debugAvoiding = avoiding

    const desiredHeading = Math.atan2(steerY, steerX)
    const headingError = angleDiff(this.heading, desiredHeading)
    this._debugDesiredHeading = desiredHeading

    // Aggressive cars steer faster and wider — unconditionally, so sharp bezier
    // turns don't create a catch-22 where misalignment collapses the very steering
    // authority needed to regain alignment. Oscillation damping is handled separately
    // in the steer direction blend above (via effectiveAggression * bezierAlignment).
    const speedRatio = clamp(this.speed / this.maxSpeed, 0, 1)
    const effectiveMaxSteering  = this.maxSteering * (1 + this.aggression * 0.4)
    const effectiveSteeringRate = this.steeringRate * (1 - speedRatio * (1 - this.twitchiness)) * (1 + this.aggression * 0.6)

    // Drive steering toward desired, clamped to effectiveMaxSteering
    const targetSteering = clamp(headingError, -effectiveMaxSteering, effectiveMaxSteering)
    const steerDelta = clamp(
      targetSteering - this.steeringAngle,
      -effectiveSteeringRate * dt,
      effectiveSteeringRate * dt,
    )
    this.steeringAngle += steerDelta

    // Scale target speed by alignment — slow down when pointing away
    // from the target so the car can tighten its turn instead of overshooting.
    // But don't penalize alignment when in a collision (heading gets knocked around)
    const alignment = Math.cos(headingError)
    const alignFloor = this._wasColliding ? 0.7 : 0.6
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
      this._skidding = this.speed > this.skidThreshold * this.grip
      this.speed = Math.max(0, this.speed - effectiveBrakeDecel * dt)
    } else if (this.speed > effectiveMax) {
      // Too fast for current heading error — ease off
      this._skidding = false
      this.speed = Math.max(effectiveMax, this.speed - effectiveBrakeDecel * 0.05 * dt)
    } else {
      this._skidding = false
      this.speed = Math.min(effectiveMax, this.speed + this.acceleration * dt)
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
    if (this.speed === 0) {
      // At rest, spring the slip angle back to zero
      const spring  = -this.slipStiffness * this.grip * this._slipAngle
      const damping = -this.slipDamping   * this._slipVel
      this._slipVel   += (spring + damping) * dt
      this._slipAngle += this._slipVel * dt
      return
    }
    // Rear-axle bicycle model
    const angularVel = (this.speed / this.wheelbase) * Math.tan(this.steeringAngle)
    this.heading += angularVel * dt
    this.x += Math.cos(this.heading) * this.speed * dt
    this.y += Math.sin(this.heading) * this.speed * dt

    // Rear slip angle — 2nd order damped oscillator driven by yaw rate.
    // The yaw rate is the "forcing" that builds up slip; tire grip (spring)
    // restores it to zero; damping controls how quickly it settles.
    // With slipDamping/slipStiffness tuned for ζ ≈ 0.64, you get one clean
    // overshoot when the car exits a corner — the tail steps out, then snaps back.
    const spring  = -this.slipStiffness * this.grip * this._slipAngle
    const damping = -this.slipDamping   * this._slipVel
    this._slipVel   += (angularVel + spring + damping) * dt
    this._slipAngle += this._slipVel * dt
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

  /** @param {CanvasRenderingContext2D} ctx @param {{ shadow?: boolean, shadowOpacity?: number, shadowBlur?: number, shadowOffsetX?: number, shadowOffsetY?: number, shadowCornerRadius?: number }} renderOpts */
  render(ctx, renderOpts = {}) {
    const w = this.width
    const h = this.height
    const r = 5  // corner radius

    // Visual body heading: rotate around the front axle by the slip angle so
    // the rear steps out while the front stays planted — matches skidmark fan.
    const axleOffset = w * 0.28
    const frontX = this.x + Math.cos(this.heading) * axleOffset
    const frontY = this.y + Math.sin(this.heading) * axleOffset
    const visualHeading = this.heading - this._slipAngle
    const bodyX = frontX - Math.cos(visualHeading) * axleOffset
    const bodyY = frontY - Math.sin(visualHeading) * axleOffset

    // Ground shadow — drawn in a separate transform so the offset is in
    // page-space (world-space), not car-local space. Zero offset = centered.
    if (renderOpts.shadow !== false) {
      const opacity = renderOpts.shadowOpacity ?? 0.40
      const blur    = renderOpts.shadowBlur    ?? 4
      const ox      = renderOpts.shadowOffsetX ?? 0
      const oy      = renderOpts.shadowOffsetY ?? 0
      ctx.save()
      ctx.translate(bodyX + ox, bodyY + oy)
      ctx.rotate(visualHeading)
      ctx.filter = `blur(${blur}px)`
      ctx.fillStyle = `rgba(0,0,0,${opacity})`
      const sr = this.shadowCornerRadius
      if (sr > 0) {
        ctx.beginPath()
        ctx.roundRect(-w / 2, -h / 2, w, h, sr)
        ctx.fill()
      } else {
        ctx.fillRect(-w / 2, -h / 2, w, h)
      }
      ctx.filter = 'none'
      ctx.restore()
    }

    ctx.save()
    ctx.translate(bodyX, bodyY)
    ctx.rotate(visualHeading)

    // Exhaust afterfire — rendered first so it appears under the car body
    if (this._exhaustFrame >= 0 && this.exhaustPosition) {
      const OPACITIES = [0.5, 1.0, 1.0, 0.66, 0.33]
      const opacity = OPACITIES[this._exhaustFrame] ?? 0
      const sc = this._exhaustScale ?? 1
      const wig = this._exhaustWiggle ?? { tipPerp: 0, tipLen: 1, lBulge: 1, rBulge: 1 }
      const er  = this.exhaustRadius
      const fl  = er * 3.5 * sc * wig.tipLen
      const hw  = er * 1.1 * sc
      const br  = er * 0.55

      ctx.save()
      ctx.globalAlpha = opacity

      for (const { x: px, y: py, dx, dy } of this._exhaustPositions(w, h)) {
        const lx = -dy, ly = dx   // left perpendicular to flame direction

        // Tip is slightly deflected perpendicular for an organic, asymmetric look
        const tipDeflect = wig.tipPerp * hw
        const tip = {
          x: px + dx * fl + lx * tipDeflect,
          y: py + dy * fl + ly * tipDeflect,
        }

        const lBase  = { x: px + lx * br,                              y: py + ly * br }
        const rBase  = { x: px - lx * br,                              y: py - ly * br }
        const lCP1   = { x: px + dx * fl * 0.15 + lx * hw * 1.2 * wig.lBulge, y: py + dy * fl * 0.15 + ly * hw * 1.2 * wig.lBulge }
        const lCP2   = { x: px + dx * fl * 0.72 + lx * hw * 0.12,     y: py + dy * fl * 0.72 + ly * hw * 0.12 }
        const rCP1   = { x: px + dx * fl * 0.72 - lx * hw * 0.12,     y: py + dy * fl * 0.72 - ly * hw * 0.12 }
        const rCP2   = { x: px + dx * fl * 0.15 - lx * hw * 1.2 * wig.rBulge, y: py + dy * fl * 0.15 - ly * hw * 1.2 * wig.rBulge }
        const backCP = { x: px - dx * br * 0.6,                        y: py - dy * br * 0.6 }

        const grad = ctx.createLinearGradient(px, py, px + dx * fl, py + dy * fl)
        grad.addColorStop(0,    'rgba(255, 255, 255, 1.0)')
        grad.addColorStop(0.12, 'rgba(255, 250, 180, 1.0)')
        grad.addColorStop(0.35, 'rgba(255, 145, 0,   0.9)')
        grad.addColorStop(0.70, 'rgba(255, 60,  0,   0.55)')
        grad.addColorStop(1.0,  'rgba(255, 20,  0,   0.0)')

        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.moveTo(lBase.x, lBase.y)
        ctx.bezierCurveTo(lCP1.x, lCP1.y, lCP2.x, lCP2.y, tip.x, tip.y)
        ctx.bezierCurveTo(rCP1.x, rCP1.y, rCP2.x, rCP2.y, rBase.x, rBase.y)
        ctx.quadraticCurveTo(backCP.x, backCP.y, lBase.x, lBase.y)
        ctx.fill()
      }

      ctx.restore()
    }

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

ctx.restore()
  }

  _updateExhaust(dt) {
    // Gear-shift afterfire — independent of driving state.
    // Each event has a 40% chance of a double pop and a 15% chance of a triple.
    if (this.exhaustPosition && Math.abs(this.speed) > 50) {
      this._exhaustTimer -= dt
      if (this._exhaustTimer <= 0) {
        this._exhaustFrame = 0
        this._exhaustTimer = this.exhaustInterval * (1 + Math.random())
        this._rollExhaustShape()
        const roll = Math.random()
        this._exhaustPending = roll < 0.15 ? 2 : roll < 0.55 ? 1 : 0
      }
    }
    if (this._exhaustFrame >= 0) {
      this._exhaustFrame++
      if (this._exhaustFrame >= 5) {
        if (this._exhaustPending > 0) {
          this._exhaustFrame = 0
          this._rollExhaustShape()
          this._exhaustPending--
        } else {
          this._exhaustFrame = -1
        }
      }
    }
  }

  /**
   * Player-controlled update — replaces the AI update() when the user has
   * taken over this car. Arrow keys: up = throttle, down = brake/reverse,
   * left/right = steer.
   * @param {number} dt  Delta time in seconds.
   * @param {Set<string>} keys  Currently held key names.
   */
  playerUpdate(dt, keys) {
    this._updateExhaust(dt)

    const fwd   = keys.has('ArrowUp')
    const back  = keys.has('ArrowDown')
    const left  = keys.has('ArrowLeft')
    const right = keys.has('ArrowRight')

    // Steering — self-centres when no key held
    if (left) {
      this.steeringAngle = Math.max(this.steeringAngle - this.steeringRate * dt, -this.maxSteering)
    } else if (right) {
      this.steeringAngle = Math.min(this.steeringAngle + this.steeringRate * dt,  this.maxSteering)
    } else {
      this.steeringAngle *= Math.max(0, 1 - dt * 6)
    }

    const effectiveBrakeDecel = this.brakeDecel * (0.3 + 0.7 * this.grip)

    if (fwd) {
      this.speed = Math.min(this.maxSpeed, this.speed + this.acceleration * dt)
      this._skidding = false
    } else if (back) {
      if (this.speed > 5) {
        // Brake first
        this.speed = Math.max(0, this.speed - effectiveBrakeDecel * dt)
        this._skidding = this.speed > this.skidThreshold * this.grip
      } else {
        // Reverse once nearly stopped
        this.speed = Math.max(-this.maxSpeed * 0.35, this.speed - this.acceleration * 0.4 * dt)
        this._skidding = false
      }
    } else {
      // Coast to a stop
      const coast = effectiveBrakeDecel * 0.08
      this.speed = Math.abs(this.speed) < 2 ? 0
                 : this.speed > 0            ? Math.max(0,               this.speed - coast * dt)
                                             : Math.min(0,               this.speed + coast * dt)
      this._skidding = false
    }

    if (this._skidding) {
      this.steeringAngle = clamp(this.steeringAngle * 1.4, -this.maxSteering * 1.4, this.maxSteering * 1.4)
    }

    this._applyBicycleModel(dt)
  }

  _rollExhaustShape() {
    this._exhaustScale  = 0.8 + Math.random() * 0.4
    this._exhaustWiggle = {
      tipPerp: (Math.random() - 0.5) * 0.7,  // tip deflection ± 35% of hw
      tipLen:  0.82 + Math.random() * 0.36,   // flame length ×0.82–1.18
      lBulge:  0.75 + Math.random() * 0.55,   // left side fullness
      rBulge:  0.75 + Math.random() * 0.55,   // right side fullness (independent)
    }
  }

  /**
   * Returns exhaust point(s) in car-local space with flame direction vectors.
   * x-axis = forward, y-axis = right side of car (canvas y-down convention).
   * offset 0 = front/left-corner, offset 1 = rear/right-corner.
   * exhaustAngle: 90 = perpendicular to car side, 170 = swept back toward tail.
   * dx/dy is the unit vector the flame points in (away from the car body).
   */
  _exhaustPositions(w, h) {
    const o = this.exhaustOffset
    const sideX = w / 2 - o * w
    const rearY  = -h / 2 + o * h
    // Sweep: 0 = perpendicular, increases toward tail (capped at 80° from perpendicular = 170° from nose)
    const sweep = clamp(this.exhaustAngle - 90, 0, 80) * DEG
    const sinS = Math.sin(sweep), cosS = Math.cos(sweep)
    const ins  = this.exhaustInset ?? 0
    // Left:  perpendicular = (0,-1); inset moves +y (toward centre); swept back toward (-1, 0)
    // Right: perpendicular = (0,+1); inset moves -y (toward centre); swept back toward (-1, 0)
    switch (this.exhaustPosition) {
      case 'left':      return [{ x: sideX, y: -h / 2 + ins, dx: -sinS, dy: -cosS }]
      case 'right':     return [{ x: sideX, y:  h / 2 - ins, dx: -sinS, dy:  cosS }]
      case 'bothSides': return [{ x: sideX, y: -h / 2 + ins, dx: -sinS, dy: -cosS },
                                { x: sideX, y:  h / 2 - ins, dx: -sinS, dy:  cosS }]
      case 'rear':      return [{ x: -w / 2 + ins, y: rearY,   dx: -1,    dy:  0    }]
      default:          return []
    }
  }
}
