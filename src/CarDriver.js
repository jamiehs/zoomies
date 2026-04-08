import { Car } from './Car.js'

const DEFAULT_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261']

export class CarDriver {
  /**
   * @param {object} opts
   * @param {number}  [opts.count=1]        Number of cars to spawn initially.
   * @param {number}  [opts.zIndex=9999]    CSS z-index of the canvas overlay.
   * @param {Element} [opts.clickTarget]    Element to bind click events on (default: document).
   * @param {object}  [opts.carOptions]     Default options forwarded to each Car constructor.
   */
  constructor(opts = {}) {
    const {
      count = 1,
      zIndex = 9999,
      clickTarget = document,
      carOptions = {},
    } = opts

    this.cars = []
    this.debug = opts.debug ?? false
    this._carOptions = carOptions
    this._clickTarget = clickTarget
    this._rafId = null
    this._finishLine = null  // { x1, y1, x2, y2 } for debug viz

    // Canvas setup
    this._canvas = document.createElement('canvas')
    const s = this._canvas.style
    s.position = 'fixed'
    s.inset = '0'
    s.width = '100%'
    s.height = '100%'
    s.pointerEvents = 'none'
    s.zIndex = String(zIndex)
    document.body.appendChild(this._canvas)
    this._ctx = this._canvas.getContext('2d')

    this._resize()
    this._onResize = this._resize.bind(this)
    window.addEventListener('resize', this._onResize)

    // Click binding
    this._onClick = (e) => {
      this.driveTo(e.clientX, e.clientY)
    }
    clickTarget.addEventListener('click', this._onClick)

    // Spawn initial cars
    for (let i = 0; i < count; i++) {
      this.addCar()
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
    const n = this.cars.length
    if (n === 0) return

    // Scatter radius scales with car count so they have room
    const carW = this.cars[0].width
    const scatterRadius = carW * (1 + n * 0.5)
    const minSeparation = carW * 1.5

    // Generate well-spaced targets via rejection sampling
    const targets = []
    const maxAttempts = 200
    for (let i = 0; i < n; i++) {
      let placed = false
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const angle = Math.random() * Math.PI * 2
        const r = Math.random() * scatterRadius
        const tx = x + Math.cos(angle) * r
        const ty = y + Math.sin(angle) * r

        // Check minimum distance from all already-placed targets
        let tooClose = false
        for (const t of targets) {
          const dx = tx - t.x
          const dy = ty - t.y
          if (dx * dx + dy * dy < minSeparation * minSeparation) {
            tooClose = true
            break
          }
        }
        if (!tooClose) {
          targets.push({ x: tx, y: ty })
          placed = true
          break
        }
      }
      // Fallback: if rejection sampling exhausts attempts, place anyway
      if (!placed) {
        const angle = Math.random() * Math.PI * 2
        const r = Math.random() * scatterRadius
        targets.push({ x: x + Math.cos(angle) * r, y: y + Math.sin(angle) * r })
      }
    }

    // Sort targets by distance from center (furthest first)
    targets.sort((a, b) => {
      const da = (a.x - x) ** 2 + (a.y - y) ** 2
      const db = (b.x - x) ** 2 + (b.y - y) ** 2
      return db - da
    })

    // Sort cars by maxSpeed (fastest first) — fastest car gets furthest target
    const sorted = [...this.cars].sort((a, b) => b.maxSpeed - a.maxSpeed)
    for (let i = 0; i < n; i++) {
      sorted[i].driveTo(targets[i].x, targets[i].y)
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

  /** Stop the animation loop and remove the canvas and event listeners. */
  destroy() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
    this._clickTarget.removeEventListener('click', this._onClick)
    window.removeEventListener('resize', this._onResize)
    this._canvas.remove()
  }

  _resize() {
    this._canvas.width = window.innerWidth
    this._canvas.height = window.innerHeight
  }

  _loop(timestamp) {
    const dt = this._lastTime === null ? 0 : Math.min((timestamp - this._lastTime) / 1000, 0.05)
    this._lastTime = timestamp

    const ctx = this._ctx
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height)

    for (const car of this.cars) {
      car.update(dt, this.cars)
    }
    for (const car of this.cars) {
      car.render(ctx)
    }

    if (this.debug) this._renderDebug(ctx)

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
      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)
      ctx.strokeStyle = car.color + '44'
      ctx.lineWidth = 2
      ctx.stroke()

      // Show control points as small dots
      for (const cp of [p1, p2]) {
        ctx.beginPath()
        ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2)
        ctx.fillStyle = car.color + '66'
        ctx.fill()
      }
    }

    // Per-car: avoidance radius (shaded circle around the car itself)
    for (const car of this.cars) {
      const avoidR = car.width * 0.5
      ctx.beginPath()
      ctx.arc(car.x, car.y, avoidR, 0, Math.PI * 2)
      ctx.fillStyle = car.color + '15'
      ctx.fill()
      ctx.strokeStyle = car.color + '33'
      ctx.lineWidth = 1
      ctx.stroke()
    }

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
      ctx.strokeStyle = car.color + '44'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
}
