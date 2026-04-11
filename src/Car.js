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
  exhaustRadius: 6,      // px — radius of each exhaust flash circle
  exhaustInterval: 0.9,  // seconds — minimum time between flashes; actual interval is exhaustInterval × (1 + random)
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

    let steerX, steerY
    if (this.path && this._pathT < 1 && (!shouldBrake || this.aggression > 0)) {
      // Speed-adaptive lookahead: faster = aim further ahead on the curve,
      // reducing the heading error gain and damping path-following oscillation.
      const speedRatioLA = clamp(this.speed / this.maxSpeed, 0, 1)
      const lookaheadT   = 0.06 + speedRatioLA * 0.14   // 6% at rest → 20% at max speed
      const lookahead    = Math.min(this._pathT + lookaheadT, 1)
      const pt = bezierPoint(this.path.p0, this.path.p1, this.path.p2, this.path.p3, lookahead)
      const dx = pt.x - this.x
      const dy = pt.y - this.y
      const d  = Math.sqrt(dx * dx + dy * dy) || 1
      const bx = dx / d
      const by = dy / d

      if (shouldBrake && this.aggression < 1) {
        // Blend toward direct target as aggression decreases.
        // aggression=0: aim straight at target; aggression=1: fully committed to path.
        const tx  = realDx / (realDist || 1)
        const ty  = realDy / (realDist || 1)
        steerX = tx + (bx - tx) * this.aggression
        steerY = ty + (by - ty) * this.aggression
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

    // Speed-sensitive steering: limit how fast the wheel can move at high speed
    // so fast cars can't snap to full lock instantly, but can still hold full
    // lock in a sustained corner. This preserves alignFactor and slip dynamics.
    const speedRatio = clamp(this.speed / this.maxSpeed, 0, 1)
    const effectiveSteeringRate = this.steeringRate * (1 - speedRatio * (1 - this.twitchiness))

    // Drive steering toward desired, clamped to maxSteering
    const targetSteering = clamp(headingError, -this.maxSteering, this.maxSteering)
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
      this._skidding = this.speed > this.skidThreshold * this.grip
      this.speed = Math.max(0, this.speed - effectiveBrakeDecel * dt)
    } else if (this.speed > effectiveMax) {
      // Too fast for current heading error — ease off
      this._skidding = false
      this.speed = Math.max(effectiveMax, this.speed - effectiveBrakeDecel * 0.5 * dt)
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
