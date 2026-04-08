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
    this.debug = opts.debug ?? false
    this._carOptions = carOptions
    this._clickTarget = clickTarget
    this._rafId = null
    this._finishLine = null  // { x1, y1, x2, y2 } for debug viz

    // Canvas setup
    this._canvas = document.createElement('canvas')
    const s = this._canvas.style
    s.position = 'absolute'
    s.top = '0'
    s.left = '0'
    s.pointerEvents = 'none'
    s.zIndex = String(zIndex)
    document.body.appendChild(this._canvas)
    this._ctx = this._canvas.getContext('2d')

    this._resize()
    this._onResize = this._resize.bind(this)
    window.addEventListener('resize', this._onResize)

    // Click binding
    this._onClick = (e) => {
      this.driveTo(e.pageX, e.pageY)
    }
    clickTarget.addEventListener('click', this._onClick)

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
    const n = this.cars.length
    if (n === 0) return

    // Scatter radius scales with car count so they have room
    const carW = this.cars[0].width
    const mult = this._scatterMult ?? 1.0
    const scatterRadius = carW * (0.66 + n * 0.33) * mult
    const minSeparation = carW * 1.5

    const targets = CarDriver._scatterPoints(x, y, n, scatterRadius, minSeparation)

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

  /**
   * Push overlapping cars apart so they never visually intersect.
   * Each pair is checked; if overlapping, both are nudged along
   * the separation axis by half the overlap distance.
   */
  _resolveCollisions() {
    const cars = this.cars
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
          const torqueA = a.target ? baseTorque * 0.15 : baseTorque
          const torqueB = b.target ? baseTorque * 0.15 : baseTorque
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
    this._clickTarget.removeEventListener('click', this._onClick)
    window.removeEventListener('resize', this._onResize)
    this._canvas.remove()
  }

  _resize() {
    const docEl = document.documentElement
    this._canvas.width = Math.max(docEl.scrollWidth, window.innerWidth)
    this._canvas.height = Math.max(docEl.scrollHeight, window.innerHeight)
  }

  _loop(timestamp) {
    const dt = this._lastTime === null ? 0 : Math.min((timestamp - this._lastTime) / 1000, 0.05)
    this._lastTime = timestamp

    const ctx = this._ctx
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height)

    for (const car of this.cars) {
      car.update(dt, this.cars)
    }

    // Post-movement collision resolution: push overlapping cars apart.
    // This is a hard constraint — no matter what steering does, cars
    // will never visually overlap.
    this._resolveCollisions()

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

    // Per-car: avoidance radius, active-avoidance highlight, desired heading
    for (const car of this.cars) {
      const avoidR = car.width * 0.66
      ctx.beginPath()
      ctx.arc(car.x, car.y, avoidR, 0, Math.PI * 2)
      ctx.fillStyle = car.color + '15'
      ctx.fill()
      ctx.strokeStyle = car.color + '33'
      ctx.lineWidth = 1
      ctx.stroke()

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
