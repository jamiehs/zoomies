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
   * along a "finish line" perpendicular to the average approach direction.
   */
  driveTo(x, y) {
    const n = this.cars.length
    if (n === 0) return

    if (n === 1) {
      this.cars[0].driveTo(x, y)
      return
    }

    // Compute centroid of all cars → average approach direction
    let cx = 0, cy = 0
    for (const car of this.cars) { cx += car.x; cy += car.y }
    cx /= n; cy /= n

    const dx = x - cx
    const dy = y - cy
    const dist = Math.sqrt(dx * dx + dy * dy)

    // Perpendicular unit vector (the "finish line" axis)
    let px, py
    if (dist < 1) {
      px = 1; py = 0 // arbitrary if cars are already on the target
    } else {
      px = -dy / dist
      py = dx / dist
    }

    // Spread cars along the perpendicular, centered on the click point.
    // Width is purely a function of car count, not distance.
    const spacing = this.cars[0].width * 1.5
    const totalWidth = (n - 1) * spacing
    for (let i = 0; i < n; i++) {
      const offset = -totalWidth / 2 + i * spacing
      this.cars[i].driveTo(x + px * offset, y + py * offset)
    }

    // Store finish line for debug rendering
    const half = totalWidth / 2
    this._finishLine = {
      x1: x - px * half, y1: y - py * half,
      x2: x + px * half, y2: y + py * half,
    }
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
    // Finish line
    if (this._finishLine) {
      const fl = this._finishLine
      ctx.beginPath()
      ctx.moveTo(fl.x1, fl.y1)
      ctx.lineTo(fl.x2, fl.y2)
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Per-car: target crosshair + line from car to target
    for (const car of this.cars) {
      if (!car.target) continue
      const tx = car.target.x
      const ty = car.target.y
      const size = 10

      // Line from car to its target
      ctx.beginPath()
      ctx.moveTo(car.x, car.y)
      ctx.lineTo(tx, ty)
      ctx.strokeStyle = car.color + '66'
      ctx.lineWidth = 1
      ctx.stroke()

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
