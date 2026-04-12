import { Car } from './Car.js'

const DEFAULT_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261']

export class CarDriver {
  /**
   * @param {object} opts
   * @param {number}  [opts.count=1]        Number of cars to spawn initially.
   * @param {number}  [opts.zIndex=-1]      CSS z-index of the canvas overlay.
   * @param {Element} [opts.clickTarget]    Element to bind click events on (default: document).
   * @param {object}  [opts.carOptions]     Default options forwarded to each Car constructor.
   */
  constructor(opts = {}) {
    const {
      count = 1,
      zIndex = -1,
      clickTarget = document,
      carOptions = {},
    } = opts

    this.cars = []
    this.fixedCanvas = opts.fixedCanvas ?? false
    this.debug = opts.debug ?? false
    this.driverChange = opts.driverChange ?? true
    this.skidOpacity = opts.skidOpacity ?? 0.33
    this.shadow = opts.shadow ?? true
    this.shadowOpacity = opts.shadowOpacity ?? 0.40
    this.shadowBlur = opts.shadowBlur ?? 4.5
    this.shadowOffsetX = opts.shadowOffsetX ?? 4
    this.shadowOffsetY = opts.shadowOffsetY ?? 6
    this.orbitDetection = opts.orbitDetection ?? true
    this.proximityBoost = opts.proximityBoost ?? true
    this._carOptions = carOptions
    this._clickTarget = clickTarget
    this._rafId = null
    this._finishLine = null  // { x1, y1, x2, y2 } for debug viz

    // Skidmarks: each entry is { x1, y1, x2, y2, type, alpha }
    // Stored as a replay buffer for resize recovery; max 6000 segments
    this._skidmarks = []
    this._maxSkidmarks = 6000

    // Per-event coin flip: flip once when a skid type starts, hold for its duration
    this._skidEnabled  = new Map()  // car → bool
    this._lastSkidType = new Map()  // car → last active type (to detect new events)

    // Stop/accel tracks: all four wheel positions stored each frame
    this._stopAccelPrev = new Map()  // car → { flx, fly, frx, fry, rlx, rly, rrx, rry }
    this._prevSpeed     = new Map()  // car → speed last frame (for accel detection)
    this._brakeLockBias = new Map()  // car → { fa, ra } — front/rear alpha weights, set once per stop event

    // Bump tracks: four wheels, fired when a nearly-stopped car is nudged
    this._bumpPrev = new Map()  // car → { flx, fly, frx, fry, rlx, rly, rrx, rry }

    // Turn tracks: outer emitted immediately, inner delayed so it starts late and ends early
    this._turnOuterPrev        = new Map()  // car → { x, y }
    this._turnInnerQueue       = new Map()  // car → Array<{ x, y, steerAngle }>
    this._turnInnerDelayedPrev = new Map()  // car → { x, y }
    this._turnStreakId         = new Map()  // car → current streak ID
    this._nextStreakId         = 0

    // Persistent skid canvas — drawn to once per segment, never cleared except on resize
    this._skidCanvas = document.createElement('canvas')
    const sk = this._skidCanvas.style
    sk.position = 'absolute'
    sk.top = '0'
    sk.left = '0'
    sk.pointerEvents = 'none'
    sk.zIndex = String(zIndex - 1)
    document.body.appendChild(this._skidCanvas)
    this._skidCtx = this._skidCanvas.getContext('2d')

    // Main canvas (cars + debug overlay)
    // fixedCanvas=true: viewport-sized, cheaper clear, but disconnects from rubber-band overscroll
    // fixedCanvas=false (default): full document size, follows page naturally
    this._canvas = document.createElement('canvas')
    const s = this._canvas.style
    s.position = this.fixedCanvas ? 'fixed' : 'absolute'
    s.top = '0'
    s.left = '0'
    s.pointerEvents = 'none'
    s.zIndex = String(zIndex)
    document.body.appendChild(this._canvas)
    this._ctx = this._canvas.getContext('2d')

    // Off-screen canvas for the shadow pre-pass — silhouettes are drawn here once
    // per frame, then blitted to the main canvas with a single blur filter operation.
    // This keeps GPU shadow cost O(1) w.r.t. car count regardless of fleet size.
    this._shadowCanvas = document.createElement('canvas')
    this._shadowCtx = this._shadowCanvas.getContext('2d')

    this._resize()
    this._onResize = this._resize.bind(this)
    window.addEventListener('resize', this._onResize)

    // driverChange click — bound to document always, independent of clickTarget
    this._onDriverChangeClick = (e) => {
      const x = e.pageX
      const y = e.pageY
      for (const car of this.cars) {
        if (this._hitTestCar(car, x, y)) {
          if (this._playerCar === car) {
            this._releasePlayerCar()
          } else {
            this._releasePlayerCar()
            this._playerCar = car
            car._playerControlled = true
            car.target = null
            car.path = null
          }
          return
        }
      }
      // Click on empty space — release player car
      this._releasePlayerCar()
    }
    if (this.driverChange) document.addEventListener('click', this._onDriverChangeClick)

    // Click-to-drive binding — pass clickTarget: null to disable
    this._onClick = (e) => { this.driveTo(e.pageX, e.pageY) }
    if (clickTarget) clickTarget.addEventListener('click', this._onClick)

    // Arrow-key state for player-controlled car
    this._keys = new Set()
    this._playerCar = null
    this._onKeyDown = (e) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
      if (this._playerCar) e.preventDefault()
      this._keys.add(e.key)
    }
    this._onKeyUp = (e) => { this._keys.delete(e.key) }
    document.addEventListener('keydown', this._onKeyDown)
    document.addEventListener('keyup',   this._onKeyUp)

    // Spawn initial cars in a cluster with aligned headings
    const spawnX = window.innerWidth * 0.8
    const spawnY = window.innerHeight * 0.4
    const baseHeading = Math.random() * Math.PI * 2
    const carW = carOptions.width ?? 48
    const spawnRadius = carW * (0.66 + count * 0.33)
    const spawnPoints = CarDriver._scatterPoints(spawnX, spawnY, count, spawnRadius, carW * 1.5)
    for (let i = 0; i < count; i++) {
      const heading = baseHeading + (Math.random() - 0.5) * (10 * Math.PI / 180)  // ±5°
      this.addCar({ x: spawnPoints[i].x, y: spawnPoints[i].y, heading })
    }

    // Start loop
    this._lastTime = null
    this._rafId = requestAnimationFrame(this._loop.bind(this))
  }

  /**
   * Drive all cars toward (x, y), scattering their individual targets
   * in a random circular pattern around the click point.
   */
  driveTo(x, y) {
    const activeCars = this.cars.filter(c => !c._playerControlled)
    const n = activeCars.length
    if (n === 0) return

    // Scatter radius scales with car count so they have room.
    // minSeparation is 2.5× car width so targets are far enough apart that
    // cars don't enter each other's arrival zones simultaneously.
    const carW = activeCars[0].width
    const mult = this._scatterMult ?? 1.0
    const minSeparation = carW * 2.5
    const scatterRadius = Math.max(carW * (0.66 + n * 0.33), minSeparation * 0.9) * mult

    const targets = CarDriver._scatterPoints(x, y, n, scatterRadius, minSeparation)

    // Sort targets by distance from center (furthest first)
    targets.sort((a, b) => {
      const da = (a.x - x) ** 2 + (a.y - y) ** 2
      const db = (b.x - x) ** 2 + (b.y - y) ** 2
      return db - da
    })

    // Shared racing-line midpoint: from the fleet's average position toward the
    // destination, laterally offset so all cars funnel through the same region
    // before spreading to their individual targets.
    const avgX = activeCars.reduce((s, c) => s + c.x, 0) / n
    const avgY = activeCars.reduce((s, c) => s + c.y, 0) / n
    const jDx = x - avgX
    const jDy = y - avgY
    const jDist = Math.sqrt(jDx * jDx + jDy * jDy) || 1
    const jPx = -jDy / jDist  // perpendicular to fleet→target
    const jPy =  jDx / jDist
    const lateral = (Math.random() - 0.5) * jDist * 0.7
    const sharedMid = {
      x: avgX + jDx * 0.45 + jPx * lateral,
      y: avgY + jDy * 0.45 + jPy * lateral,
    }

    // Sort active cars by maxSpeed (fastest first) — fastest gets furthest target
    const sorted = [...activeCars].sort((a, b) => b.maxSpeed - a.maxSpeed)
    for (let i = 0; i < n; i++) {
      sorted[i].driveTo(targets[i].x, targets[i].y, sharedMid)
    }

    // Store scatter zone for debug rendering
    this._scatterZone = { x, y, radius: scatterRadius }
    this._finishLine = null
  }

  /**
   * Add a car at a random edge position (or specified x/y).
   * @param {object} [opts]  Passed to Car constructor; may include x, y, color.
   * @returns {Car}
   */
  addCar(opts = {}) {
    const color = opts.color ?? DEFAULT_COLORS[this.cars.length % DEFAULT_COLORS.length]
    const x = opts.x ?? Math.random() * this._canvas.width
    const y = opts.y ?? Math.random() * this._canvas.height
    const car = new Car(x, y, { ...this._carOptions, ...opts, color })
    this.cars.push(car)
    return car
  }

  /** Remove a car instance. */
  removeCar(car) {
    const idx = this.cars.indexOf(car)
    if (idx !== -1) this.cars.splice(idx, 1)
  }

  _pushSkid(seg) {
    this._skidmarks.push(seg)
    if (this._skidmarks.length > this._maxSkidmarks) this._skidmarks.shift()
    this._drawSkidSegment(seg)
  }

  // Emit a skid segment, subdividing if it exceeds maxLen so marks stay smooth
  // at any framerate. Intermediate points are linearly interpolated.
  _pushSkidSmooth(seg, maxLen) {
    const dx = seg.x2 - seg.x1
    const dy = seg.y2 - seg.y1
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len <= maxLen) { this._pushSkid(seg); return }
    const steps = Math.ceil(len / maxLen)
    let x1 = seg.x1, y1 = seg.y1
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const x2 = seg.x1 + dx * t
      const y2 = seg.y1 + dy * t
      this._pushSkid({ ...seg, x1, y1, x2, y2 })
      x1 = x2; y1 = y2
    }
  }

  _drawSkidSegment(s) {
    const turnColor = this.debug
      ? (s.isInner ? '0, 160, 160' : '0, 255, 255')
      : '20, 15, 10'
    const COLORS = this.debug
      ? { accel: '102, 51, 153', turn: turnColor, stop: '255, 20, 147', bump: '255, 165, 0' }
      : { accel: '20, 15, 10',   turn: '20, 15, 10',  stop: '20, 15, 10',   bump: '20, 15, 10'  }
    this._skidCtx.lineCap = 'round'
    this._skidCtx.lineWidth = s.tw ?? 4
    const finalAlpha = this.debug ? s.alpha : s.alpha * this.skidOpacity
    this._skidCtx.strokeStyle = `rgba(${COLORS[s.type]}, ${finalAlpha})`
    this._skidCtx.beginPath()
    this._skidCtx.moveTo(s.x1, s.y1)
    this._skidCtx.lineTo(s.x2, s.y2)
    this._skidCtx.stroke()
  }

  /**
   * Emit skidmark segments for a car based on its current driving state.
   * Priority: stop > turn > accel (multiple can be true at once; one wins).
   *   stop  — hard braking at speed (car._skidding)
   *   bump  — car being physically pushed by another (any speed)
   *   turn  — cornering near steering lock at speed
   *   accel — wheel-spin during launch (low speed, has target, not braking)
   *
   * Turning skidmarks use a delay queue for the inner wheel: it starts emitting
   * D frames late and stops D frames early, giving a centered shorter inner track
   * with no gaps — matching real tyre load transfer behaviour.
   */
  _emitSkidmarks(car) {
    const prevSpeed = this._prevSpeed.get(car) ?? car.speed
    this._prevSpeed.set(car, car.speed)
    const speeding  = car.speed > prevSpeed  // actually gaining speed this frame

    const stop  = car._skidding
    const bump  = !stop && car._wasColliding
    const turn  = !stop && !bump && Math.abs(car._slipAngle) > 0.05 && car.speed > 60
    const accel = !stop && !bump && !turn && speeding && car.target !== null && car.speed > 10 && car.speed < 100
    const type = stop ? 'stop' : bump ? 'bump' : turn ? 'turn' : accel ? 'accel' : null

    // Flip once per event (when type changes), hold the decision for its duration
    if (type !== this._lastSkidType.get(car)) {
      this._skidEnabled.set(car, Math.random() >= 0.5)
      this._lastSkidType.set(car, type)
      // For braking: randomly pick which axle(s) lock harder this event
      if (type === 'stop') {
        const r = Math.random()
        this._brakeLockBias.set(car,
          r < 0.50 ? { fa: 1.0,  ra: 1.0  } :  // all four locked equally
          r < 0.75 ? { fa: 1.0,  ra: 0.25 } :  // front-biased lock
                     { fa: 0.25, ra: 1.0  }     // rear-biased lock
        )
      }
    }

    if (!type || !this._skidEnabled.get(car)) {
      // Clear prev state so there's no phantom segment when the next event starts
      this._stopAccelPrev.delete(car)
      this._bumpPrev.delete(car)
      this._clearTurnState(car)
      return
    }

    const perpX  = -Math.sin(car.heading)
    const perpY  =  Math.cos(car.heading)
    const fwdX   =  Math.cos(car.heading)
    const fwdY   =  Math.sin(car.heading)
    const trackHalf = car.height * 0.38
    // car.x/y is the visual center; axles sit ±28% of width from center
    const axleOffset = car.width * 0.28

    // Rear axle wheel positions — offset laterally by slip angle so marks
    // fan outward mid-corner and trace the snap-back wiggle on corner exit.
    // perpX points LEFT of heading; positive slipAngle = rear slides RIGHT.
    const slipOffset = Math.sin(car._slipAngle) * car.height * 1.5 * (car.slipScale / Math.max(car.grip, 0.1))
    const rlx = car.x - fwdX * axleOffset + perpX * trackHalf - perpX * slipOffset
    const rly = car.y - fwdY * axleOffset + perpY * trackHalf - perpY * slipOffset
    const rrx = car.x - fwdX * axleOffset - perpX * trackHalf - perpX * slipOffset
    const rry = car.y - fwdY * axleOffset - perpY * trackHalf - perpY * slipOffset
    // Front axle wheel positions
    const flx = car.x + fwdX * axleOffset + perpX * trackHalf
    const fly = car.y + fwdY * axleOffset + perpY * trackHalf
    const frx = car.x + fwdX * axleOffset - perpX * trackHalf
    const fry = car.y + fwdY * axleOffset - perpY * trackHalf

    // Alpha baked at emit time — persistent canvas means no global i/n position
    const solidAlpha = 1.0
    const accelAlpha = Math.max(0, 1 - (car.speed - 10) / 90)                // 1 at launch → 0 at 100px/s
    const maxSlip    = 0.20  // radians at which turn marks reach full alpha
    const turnAlpha  = Math.min(Math.abs(car._slipAngle) / maxSlip, 1.0) * 0.5
    const bumpAlpha  = 0.5                                                     // light — nudge marks, not hard stops
    const tw = car.tireWidth  // baked into segment for persistent canvas

    if (type === 'bump') {
      const prev = this._bumpPrev.get(car)
      const minStep = car.tireWidth * 0.5
      const moved = prev ? Math.hypot(rlx - prev.rlx, rly - prev.rly) : Infinity
      if (prev && moved >= minStep) {
        this._pushSkid({ x1: prev.flx, y1: prev.fly, x2: flx, y2: fly, type, alpha: bumpAlpha, tw })
        this._pushSkid({ x1: prev.frx, y1: prev.fry, x2: frx, y2: fry, type, alpha: bumpAlpha, tw })
        this._pushSkid({ x1: prev.rlx, y1: prev.rly, x2: rlx, y2: rly, type, alpha: bumpAlpha, tw })
        this._pushSkid({ x1: prev.rrx, y1: prev.rry, x2: rrx, y2: rry, type, alpha: bumpAlpha, tw })
        this._bumpPrev.set(car, { flx, fly, frx, fry, rlx, rly, rrx, rry })
      } else if (!prev) {
        this._bumpPrev.set(car, { flx, fly, frx, fry, rlx, rly, rrx, rry })
      }
      this._stopAccelPrev.delete(car)
      this._clearTurnState(car)
    } else if (type === 'stop' || type === 'accel') {
      this._bumpPrev.delete(car)
      const prev = this._stopAccelPrev.get(car)

      if (type === 'stop') {
        // Braking marks on all four corners — axle alphas vary per event
        const { fa, ra } = this._brakeLockBias.get(car) ?? { fa: 1.0, ra: 1.0 }
        if (prev) {
          this._pushSkid({ x1: prev.flx, y1: prev.fly, x2: flx, y2: fly, type, alpha: fa * solidAlpha, tw })
          this._pushSkid({ x1: prev.frx, y1: prev.fry, x2: frx, y2: fry, type, alpha: fa * solidAlpha, tw })
          this._pushSkid({ x1: prev.rlx, y1: prev.rly, x2: rlx, y2: rly, type, alpha: ra * solidAlpha, tw })
          this._pushSkid({ x1: prev.rrx, y1: prev.rry, x2: rrx, y2: rry, type, alpha: ra * solidAlpha, tw })
        }
      } else {
        // Accel marks on driven wheels only, weighted by driveBias
        const rearAlpha  = car.driveBias       * accelAlpha
        const frontAlpha = (1 - car.driveBias) * accelAlpha
        if (prev) {
          if (rearAlpha > 0) {
            this._pushSkid({ x1: prev.rlx, y1: prev.rly, x2: rlx, y2: rly, type, alpha: rearAlpha,  tw })
            this._pushSkid({ x1: prev.rrx, y1: prev.rry, x2: rrx, y2: rry, type, alpha: rearAlpha,  tw })
          }
          if (frontAlpha > 0) {
            this._pushSkid({ x1: prev.flx, y1: prev.fly, x2: flx, y2: fly, type, alpha: frontAlpha, tw })
            this._pushSkid({ x1: prev.frx, y1: prev.fry, x2: frx, y2: fry, type, alpha: frontAlpha, tw })
          }
        }
      }

      this._stopAccelPrev.set(car, { flx, fly, frx, fry, rlx, rly, rrx, rry })
      this._clearTurnState(car)
    } else if (type === 'turn') {
      this._bumpPrev.delete(car)
      const innerLeft = car._slipAngle > 0  // positive slip = rear goes right = left is inner
      const ox = innerLeft ? rrx : rlx,  oy = innerLeft ? rry : rly  // outer
      const ix = innerLeft ? rlx : rrx,  iy = innerLeft ? rly : rry  // inner

      if (!this._turnOuterPrev.has(car)) {
        this._turnStreakId.set(car, this._nextStreakId++)
      }
      const streakId = this._turnStreakId.get(car)

      // Outer track — emit immediately with steering-proportional alpha;
      // subdivide long segments so marks stay smooth at any framerate.
      const outerPrev = this._turnOuterPrev.get(car)
      if (outerPrev) {
        this._pushSkidSmooth({ x1: outerPrev.x, y1: outerPrev.y, x2: ox, y2: oy, type, streakId, isInner: false, alpha: turnAlpha, tw }, tw * 2)
      }
      this._turnOuterPrev.set(car, { x: ox, y: oy })

      // Inner track — distance-based buffer: hold points until the buffered arc
      // length exceeds one car-width. This makes the inner/outer gap a consistent
      // world-space distance regardless of framerate or speed, grounded in actual
      // tire geometry (the inner wheel travels ~track_width fewer px around a corner).
      const innerGap = car.height
      let queue = this._turnInnerQueue.get(car)
      if (!queue) { queue = []; this._turnInnerQueue.set(car, queue) }
      queue.push({ x: ix, y: iy, slipAngle: car._slipAngle })

      let arcLen = 0
      for (let i = 1; i < queue.length; i++) {
        const a = queue[i - 1], b = queue[i]
        arcLen += Math.hypot(b.x - a.x, b.y - a.y)
      }

      if (arcLen > innerGap) {
        const current = queue.shift()
        const delayedPrev = this._turnInnerDelayedPrev.get(car)
        const innerAlpha = Math.min(Math.abs(current.slipAngle) / maxSlip, 1.0) * 0.2
        if (delayedPrev) {
          this._pushSkidSmooth({ x1: delayedPrev.x, y1: delayedPrev.y, x2: current.x, y2: current.y, type, streakId, isInner: true, alpha: innerAlpha, tw }, tw * 2)
        }
        this._turnInnerDelayedPrev.set(car, current)
      }

      this._stopAccelPrev.delete(car)
    }
  }

  _clearTurnState(car) {
    this._turnOuterPrev.delete(car)
    this._turnInnerQueue.delete(car)
    this._turnInnerDelayedPrev.delete(car)
    this._turnStreakId.delete(car)
  }

  /**
   * Push overlapping cars apart so they never visually intersect.
   * Each pair is checked; if overlapping, both are nudged along
   * the separation axis by half the overlap distance.
   */
  _resolveCollisions() {
    const cars = this.cars
    // TODO(perf): O(n²) — add spatial grid/quadtree for large car counts (n > ~20)
    // Reset collision flag each frame
    for (const car of cars) car._wasColliding = false
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i]
        const b = cars[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        const minDist = (a.width + b.width) * 0.5

        if (dist < minDist && dist > 0) {
          const overlap = minDist - dist
          const nx = dx / dist
          const ny = dy / dist
          // Push each car half the overlap
          a.x -= nx * overlap * 0.5
          a.y -= ny * overlap * 0.5
          b.x += nx * overlap * 0.5
          b.y += ny * overlap * 0.5

          // Rotational impulse: compute the cross product of the push
          // direction against each car's forward axis. A hit to the
          // side of the car spins it; a head-on hit doesn't.
          // Moving cars get very light torque; parked cars get more.
          const baseTorque = overlap * 0.015
          const torqueA = a.target ? baseTorque * 0.33 : baseTorque
          const torqueB = b.target ? baseTorque * 0.33 : baseTorque
          const crossA = (-nx) * Math.sin(a.heading) - (-ny) * Math.cos(a.heading)
          a.heading += crossA * torqueA
          const crossB = nx * Math.sin(b.heading) - ny * Math.cos(b.heading)
          b.heading += crossB * torqueB

          a._wasColliding = true
          b._wasColliding = true
        } else if (dist === 0) {
          a.x -= 1
          b.x += 1
        }
      }
    }
  }

  /** Stop the animation loop and remove the canvas and event listeners. */
  destroy() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
    if (this._clickTarget) this._clickTarget.removeEventListener('click', this._onClick)
    if (this.driverChange) document.removeEventListener('click', this._onDriverChangeClick)
    window.removeEventListener('resize', this._onResize)
    document.removeEventListener('keydown', this._onKeyDown)
    document.removeEventListener('keyup',   this._onKeyUp)
    this._canvas.remove()
    this._skidCanvas.remove()
  }

  _releasePlayerCar() {
    if (this._playerCar) {
      this._playerCar._playerControlled = false
      this._playerCar = null
    }
  }

  /** Returns true if world-space point (px, py) falls inside the car's rotated rectangle. */
  _hitTestCar(car, px, py) {
    const dx  = px - car.x
    const dy  = py - car.y
    const cos = Math.cos(-car.heading)
    const sin = Math.sin(-car.heading)
    const lx  = dx * cos - dy * sin
    const ly  = dx * sin + dy * cos
    return Math.abs(lx) <= car.width / 2 + 4 && Math.abs(ly) <= car.height / 2 + 4
  }

  _resize() {
    const docEl = document.documentElement
    const sw = Math.max(docEl.scrollWidth, window.innerWidth)
    const sh = Math.max(docEl.scrollHeight, window.innerHeight)
    // Fixed mode: main canvas is viewport-sized (cheaper clear, no rubber-band follow)
    // Absolute mode: main canvas matches full document (follows page naturally)
    this._canvas.width  = this.fixedCanvas ? window.innerWidth  : sw
    this._canvas.height = this.fixedCanvas ? window.innerHeight : sh
    this._skidCanvas.width  = sw
    this._skidCanvas.height = sh
    this._shadowCanvas.width  = window.innerWidth
    this._shadowCanvas.height = window.innerHeight
    // Replay stored segments back onto the freshly-cleared skid canvas
    for (const s of this._skidmarks) this._drawSkidSegment(s)
  }

  _loop(timestamp) {
    const dt = this._lastTime === null ? 0 : Math.min((timestamp - this._lastTime) / 1000, 0.05)
    this._lastTime = timestamp

    const ctx = this._ctx
    const sx = window.scrollX
    const sy = window.scrollY
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Fixed: clear viewport-sized canvas from origin.
    // Absolute: clear viewport + a padding that covers (a) the car rendering overhang
    // (cars are drawn up to car.width outside the viewport due to culling threshold) and
    // (b) shadow bleed from the blur blit extending past the shadow canvas edge.
    // Chrome scrolls on the compositor thread before the main thread can RAF-clear,
    // so without this pad, stale content just outside the viewport is briefly visible.
    if (this.fixedCanvas) {
      ctx.clearRect(0, 0, vw, vh)
    } else {
      const maxCarWidth = this.cars.reduce((m, c) => Math.max(m, c.width), 0)
      const pad = Math.ceil(this.shadowBlur * 3)
                + Math.max(this.shadowOffsetX, this.shadowOffsetY, 0)
                + maxCarWidth  // covers rendering overhang from viewport culling threshold
      ctx.clearRect(sx - pad, sy - pad, vw + pad * 2, vh + pad * 2)
    }

    for (const car of this.cars) {
      car.orbitDetection = this.orbitDetection
      car.proximityBoost = this.proximityBoost
      if (car._playerControlled) {
        car.playerUpdate(dt, this._keys)
      } else {
        car.update(dt, this.cars)
      }
    }

    // Post-movement collision resolution: push overlapping cars apart.
    // This is a hard constraint — no matter what steering does, cars
    // will never visually overlap.
    this._resolveCollisions()

    // Emit new skidmark segments; clean up prev-refs for removed cars
    for (const car of this.cars) this._emitSkidmarks(car)
    // TODO(perf): _loop scans maps every frame to cull removed cars; removeCar()
    // could push stale refs onto a cleanup queue instead
    for (const car of this._stopAccelPrev.keys()) {
      if (!this.cars.includes(car)) {
        this._stopAccelPrev.delete(car)
        this._prevSpeed.delete(car)
        this._bumpPrev.delete(car)
        this._brakeLockBias.delete(car)
        this._skidEnabled.delete(car)
        this._lastSkidType.delete(car)
      }
    }
    for (const car of this._turnOuterPrev.keys()) {
      if (!this.cars.includes(car)) this._clearTurnState(car)
    }

    // Fixed: translate page coords → viewport coords
    // Absolute: canvas is already in page coords, no translate needed
    if (this.fixedCanvas) ctx.save(), ctx.translate(-sx, -sy)

    // Shadow pre-pass: draw all silhouettes to an offscreen canvas (viewport-sized,
    // in viewport coordinates), then blit the whole layer once with blur. This is one
    // GPU blur operation instead of one per car — O(1) GPU cost regardless of fleet size.
    if (this.shadow) {
      const sc = this._shadowCtx
      sc.clearRect(0, 0, vw, vh)
      sc.save()
      sc.translate(-sx, -sy)  // page → viewport coords
      for (const car of this.cars) {
        const vx = car.x - sx
        const vy = car.y - sy
        if (vx < -car.width || vx > vw + car.width || vy < -car.height || vy > vh + car.height) continue
        car.renderSilhouette(sc)
      }
      sc.restore()

      // Blit the blurred shadow layer. After fixedCanvas translate, (sx + offsetX, sy + offsetY)
      // maps to canvas-coord (offsetX, offsetY); in absolute mode it maps to page-coord
      // (sx + offsetX, sy + offsetY) which is exactly where the viewport top-left lives.
      ctx.save()
      ctx.filter = `blur(${this.shadowBlur}px)`
      ctx.globalAlpha = this.shadowOpacity
      ctx.drawImage(this._shadowCanvas, sx + this.shadowOffsetX, sy + this.shadowOffsetY)
      ctx.globalAlpha = 1
      ctx.filter = 'none'
      ctx.restore()
    }

    for (const car of this.cars) {
      // Skip cars fully outside the viewport
      const vx = car.x - sx
      const vy = car.y - sy
      if (vx < -car.width || vx > vw + car.width || vy < -car.height || vy > vh + car.height) continue
      car.render(ctx, { shadow: false })
    }

    if (this.debug) this._renderDebug(ctx)

    if (this.fixedCanvas) ctx.restore()

    this._rafId = requestAnimationFrame(this._loop.bind(this))
  }

  _renderDebug(ctx) {
    // Scatter zone circle
    if (this._scatterZone) {
      const sz = this._scatterZone
      ctx.beginPath()
      ctx.arc(sz.x, sz.y, sz.radius, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'
      ctx.lineWidth = 1
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.setLineDash([])
      // Center dot
      ctx.beginPath()
      ctx.arc(sz.x, sz.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fill()
    }

    // Per-car: bezier path
    for (const car of this.cars) {
      if (!car.path) continue
      const { p0, p1, p2, p3 } = car.path
      ctx.strokeStyle = car.color
      ctx.lineWidth = 2
      ctx.globalAlpha = 0.27
      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)
      ctx.stroke()

      // Show control points as small dots
      ctx.fillStyle = car.color
      ctx.globalAlpha = 0.40
      for (const cp of [p1, p2]) {
        ctx.beginPath()
        ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    // Per-car: avoidance radius, active-avoidance highlight, desired heading
    for (const car of this.cars) {
      const avoidR = car.width * 0.66
      ctx.beginPath()
      ctx.arc(car.x, car.y, avoidR, 0, Math.PI * 2)
      ctx.fillStyle = car.color
      ctx.globalAlpha = 0.08
      ctx.fill()
      ctx.strokeStyle = car.color
      ctx.globalAlpha = 0.20
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = 1

      // Highlight: rectangle outline around car when actively avoiding
      if (car._debugAvoiding) {
        ctx.save()
        ctx.translate(car.x, car.y)
        ctx.rotate(car.heading)
        const pad = 6
        ctx.strokeStyle = '#ff0'
        ctx.lineWidth = 2
        ctx.strokeRect(
          -car.width / 2 - pad, -car.height / 2 - pad,
          car.width + pad * 2, car.height + pad * 2,
        )
        ctx.restore()

        // Flash the cars being avoided
        for (const other of car._debugAvoidTargets) {
          ctx.save()
          ctx.translate(other.x, other.y)
          ctx.rotate(other.heading)
          ctx.strokeStyle = '#f0f'
          ctx.lineWidth = 2
          ctx.setLineDash([4, 3])
          ctx.strokeRect(
            -other.width / 2 - 4, -other.height / 2 - 4,
            other.width + 8, other.height + 8,
          )
          ctx.setLineDash([])
          ctx.restore()
        }
      }

      // Exhaust direction arrow — shaft along flame vector, arrowhead at tip.
      // Scaled to actual flame size so the indicator matches what renders.
      if (car.exhaustPosition) {
        ctx.save()
        ctx.translate(car.x, car.y)
        ctx.rotate(car.heading)
        const pts = car._exhaustPositions(car.width, car.height)
        const er     = car.exhaustRadius
        const shaftL = er * 3.5   // same base length as the flame
        const headL  = er * 0.9   // arrowhead leg length
        const headA  = 0.42       // arrowhead half-angle (radians, ~24°)
        ctx.strokeStyle = 'rgba(255, 220, 0, 0.9)'
        ctx.lineWidth = 1.5
        for (const { x: px, y: py, dx, dy } of pts) {
          const tipX = px + dx * shaftL
          const tipY = py + dy * shaftL
          // Shaft
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(tipX, tipY)
          ctx.stroke()
          // Arrowhead — two lines back from the tip at ±headA from the reverse direction
          const backAngle = Math.atan2(-dy, -dx)
          ctx.beginPath()
          ctx.moveTo(tipX, tipY)
          ctx.lineTo(tipX + Math.cos(backAngle + headA) * headL, tipY + Math.sin(backAngle + headA) * headL)
          ctx.moveTo(tipX, tipY)
          ctx.lineTo(tipX + Math.cos(backAngle - headA) * headL, tipY + Math.sin(backAngle - headA) * headL)
          ctx.stroke()
        }
        ctx.restore()
      }

      // Rear slip angle widget — arrow at rear axle perpendicular to heading,
      // scaled by slip angle magnitude. Orange = sliding right, cyan = sliding left.
      {
        const fwdX  =  Math.cos(car.heading)
        const fwdY  =  Math.sin(car.heading)
        const perpX = -Math.sin(car.heading)
        const perpY =  Math.cos(car.heading)
        const axleOffset = car.width * 0.28
        const rearX = car.x - fwdX * axleOffset
        const rearY = car.y - fwdY * axleOffset
        const SLIP_VIZ_SCALE = 200  // px per radian — makes ~0.14 rad = 28px
        const slipPx = car._slipAngle * SLIP_VIZ_SCALE
        // Arrow tip (perpX points left; positive slipAngle = slides right = -perp)
        const tipX = rearX - perpX * slipPx
        const tipY = rearY - perpY * slipPx
        const slipping = Math.abs(car._slipAngle) > 0.05
        const color = car._slipAngle > 0 ? '#ff6600' : '#00ccff'
        ctx.strokeStyle = slipping ? color : 'rgba(255,255,255,0.3)'
        ctx.fillStyle   = slipping ? color : 'rgba(255,255,255,0.3)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(rearX, rearY)
        ctx.lineTo(tipX, tipY)
        ctx.stroke()
        // Arrowhead
        if (Math.abs(slipPx) > 4) {
          const len = Math.sqrt((tipX - rearX) ** 2 + (tipY - rearY) ** 2)
          const ux = (tipX - rearX) / len, uy = (tipY - rearY) / len
          ctx.beginPath()
          ctx.arc(tipX, tipY, 3, 0, Math.PI * 2)
          ctx.fill()
        }
        // Slip angle label in degrees
        ctx.fillStyle = 'rgba(255,255,255,0.6)'
        ctx.font = '9px monospace'
        ctx.fillText(`α ${(car._slipAngle * 180 / Math.PI).toFixed(1)}°`, rearX + 6, rearY - 6)
      }

      // Desired heading: line from car center showing where it wants to go
      if (car.target) {
        const len = 40
        const hx = Math.cos(car._debugDesiredHeading) * len
        const hy = Math.sin(car._debugDesiredHeading) * len
        ctx.beginPath()
        ctx.moveTo(car.x, car.y)
        ctx.lineTo(car.x + hx, car.y + hy)
        ctx.strokeStyle = '#0f0'
        ctx.lineWidth = 2
        ctx.stroke()
        // Small arrowhead
        ctx.beginPath()
        ctx.arc(car.x + hx, car.y + hy, 3, 0, Math.PI * 2)
        ctx.fillStyle = '#0f0'
        ctx.fill()
      }

      // Front wheel steering lines — paper-thin top-down wheels oriented at
      // heading + steeringAngle. Shows actual wheel direction vs car heading.
      {
        const fwdX   =  Math.cos(car.heading)
        const fwdY   =  Math.sin(car.heading)
        const perpX  = -Math.sin(car.heading)
        const perpY  =  Math.cos(car.heading)
        const axleOffset = car.width * 0.28
        const trackHalf  = car.height * 0.38
        const wheelHalf  = car.height * 0.5   // half-length of each wheel line

        const axleCX = car.x + fwdX * axleOffset
        const axleCY = car.y + fwdY * axleOffset

        // Left and right front wheel centres
        const flX = axleCX + perpX * trackHalf
        const flY = axleCY + perpY * trackHalf
        const frX = axleCX - perpX * trackHalf
        const frY = axleCY - perpY * trackHalf

        // Wheel rolling direction
        const wheelAngle = car.heading + car.steeringAngle
        const wdX = Math.cos(wheelAngle) * wheelHalf
        const wdY = Math.sin(wheelAngle) * wheelHalf

        ctx.strokeStyle = '#ffe600'
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.moveTo(flX - wdX, flY - wdY)
        ctx.lineTo(flX + wdX, flY + wdY)
        ctx.moveTo(frX - wdX, frY - wdY)
        ctx.lineTo(frX + wdX, frY + wdY)
        ctx.stroke()
      }
    }

    // Per-car: skid type indicator — ring + label in matching skidmark color
    const SKID_COLORS = { accel: 'rebeccapurple', turn: 'aqua', stop: 'deeppink', bump: 'orange' }
    const SKID_LABELS = { accel: 'ACCEL', turn: 'CORNER', stop: 'BRAKE', bump: 'BUMP' }
    for (const car of this.cars) {
      const stop  = car._skidding
      const bump  = !stop && car._wasColliding
      const turn  = !stop && !bump && Math.abs(car._slipAngle) > 0.05 && car.speed > 60
      const accel = !stop && !bump && !turn && car.target !== null && car.speed > 10 && car.speed < 100
      const type  = stop ? 'stop' : bump ? 'bump' : turn ? 'turn' : accel ? 'accel' : null
      if (!type) continue

      ctx.beginPath()
      ctx.arc(car.x, car.y, car.width * 0.7, 0, Math.PI * 2)
      ctx.strokeStyle = SKID_COLORS[type]
      ctx.lineWidth = 2
      ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])

      ctx.fillStyle = SKID_COLORS[type]
      ctx.font = 'bold 10px monospace'
      ctx.fillText(SKID_LABELS[type], car.x + car.width * 0.75, car.y - 4)
    }

    // Skidmark segment count breakdown by type
    // TODO(perf): scanning _skidmarks (up to 6000 entries) every debug frame;
    // track counts incrementally in _pushSkid() instead
    const counts = { accel: 0, turn: 0, stop: 0, bump: 0 }
    for (const s of this._skidmarks) counts[s.type]++
    ctx.font = '11px monospace'
    ctx.fillStyle = 'rebeccapurple'; ctx.fillText(`accel: ${counts.accel}`, 12, this._canvas.height - 66)
    ctx.fillStyle = 'aqua';          ctx.fillText(`turn:  ${counts.turn}`,  12, this._canvas.height - 52)
    ctx.fillStyle = 'deeppink';      ctx.fillText(`stop:  ${counts.stop}`,  12, this._canvas.height - 38)
    ctx.fillStyle = 'orange';        ctx.fillText(`bump:  ${counts.bump}`,  12, this._canvas.height - 24)

    // Per-car: target crosshair + arrival radius
    for (const car of this.cars) {
      if (!car.target) continue
      const tx = car.target.x
      const ty = car.target.y
      const size = 10

      // Crosshair at target
      ctx.beginPath()
      ctx.moveTo(tx - size, ty)
      ctx.lineTo(tx + size, ty)
      ctx.moveTo(tx, ty - size)
      ctx.lineTo(tx, ty + size)
      ctx.strokeStyle = car.color
      ctx.lineWidth = 2
      ctx.stroke()

      // Small circle at target showing arrival radius
      ctx.beginPath()
      ctx.arc(tx, ty, car.arrivalRadius, 0, Math.PI * 2)
      ctx.strokeStyle = car.color
      ctx.globalAlpha = 0.27
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  /**
   * Generate n well-spaced points in a circle via rejection sampling.
   * @returns {{ x: number, y: number }[]}
   */
  static _scatterPoints(cx, cy, n, radius, minSeparation) {
    const points = []
    const maxAttempts = 200
    for (let i = 0; i < n; i++) {
      let placed = false
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const angle = Math.random() * Math.PI * 2
        const r = Math.random() * radius
        const px = cx + Math.cos(angle) * r
        const py = cy + Math.sin(angle) * r

        let tooClose = false
        for (const p of points) {
          const dx = px - p.x
          const dy = py - p.y
          if (dx * dx + dy * dy < minSeparation * minSeparation) {
            tooClose = true
            break
          }
        }
        if (!tooClose) {
          points.push({ x: px, y: py })
          placed = true
          break
        }
      }
      if (!placed) {
        const angle = Math.random() * Math.PI * 2
        const r = Math.random() * radius
        points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r })
      }
    }
    return points
  }
}
