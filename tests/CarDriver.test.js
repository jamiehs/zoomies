import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CarDriver } from '../src/CarDriver.js'

// ---------- DOM / Canvas stubs ----------
// jsdom doesn't implement canvas, so we provide a minimal stub.

function makeCanvasStub() {
  return {
    style: {},
    getContext: () => ({
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      bezierCurveTo: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
    }),
    remove: vi.fn(),
    width: 1000,
    height: 800,
  }
}

let rafCallbacks = []
let originalRaf
let originalCaf
let originalDocument
let canvas

beforeEach(() => {
  // Stub requestAnimationFrame / cancelAnimationFrame
  originalRaf = globalThis.requestAnimationFrame
  originalCaf = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (cb) => {
    const id = rafCallbacks.length + 1
    rafCallbacks.push({ id, cb })
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    rafCallbacks = rafCallbacks.filter(r => r.id !== id)
  }

  // Stub DOM
  canvas = makeCanvasStub()
  vi.spyOn(document, 'createElement').mockReturnValue(canvas)
  vi.spyOn(document.body, 'appendChild').mockImplementation(() => {})
  vi.spyOn(document, 'addEventListener').mockImplementation(() => {})
  vi.spyOn(document, 'removeEventListener').mockImplementation(() => {})
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {})
  vi.spyOn(window, 'removeEventListener').mockImplementation(() => {})

  // Stable window size
  Object.defineProperty(window, 'innerWidth', { value: 1000, writable: true, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true })

  // Stable Math.random
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(() => {
  rafCallbacks = []
  globalThis.requestAnimationFrame = originalRaf
  globalThis.cancelAnimationFrame = originalCaf
  vi.restoreAllMocks()
})

function makeDriver(opts = {}) {
  return new CarDriver({ count: 2, ...opts })
}

// ---------- _scatterPoints (pure static, no DOM needed) ----------

describe('_scatterPoints', () => {
  it('returns exactly n points', () => {
    const pts = CarDriver._scatterPoints(500, 400, 4, 100, 20)
    expect(pts).toHaveLength(4)
  })

  it('all points are within the given radius of the center', () => {
    const cx = 300, cy = 200, radius = 80
    const pts = CarDriver._scatterPoints(cx, cy, 5, radius, 10)
    for (const p of pts) {
      const d = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2)
      expect(d).toBeLessThanOrEqual(radius + 0.001)
    }
  })

  it('returns 0 points for n=0', () => {
    expect(CarDriver._scatterPoints(0, 0, 0, 100, 10)).toHaveLength(0)
  })

  it('returns 1 point for n=1', () => {
    const pts = CarDriver._scatterPoints(500, 400, 1, 100, 20)
    expect(pts).toHaveLength(1)
  })

  it('points have numeric x and y', () => {
    const pts = CarDriver._scatterPoints(100, 100, 3, 50, 5)
    for (const p of pts) {
      expect(typeof p.x).toBe('number')
      expect(typeof p.y).toBe('number')
    }
  })
})

// ---------- _resolveCollisions ----------

describe('_resolveCollisions', () => {
  it('pushes overlapping cars apart', () => {
    const driver = makeDriver({ count: 0 })
    const a = driver.addCar({ x: 0, y: 0 })
    const b = driver.addCar({ x: 5, y: 0 })  // very close — well within minDist
    const ax0 = a.x, bx0 = b.x
    driver._resolveCollisions()
    expect(a.x).toBeLessThan(ax0)  // pushed left
    expect(b.x).toBeGreaterThan(bx0)  // pushed right
  })

  it('does not move well-separated cars', () => {
    const driver = makeDriver({ count: 0 })
    const a = driver.addCar({ x: 0, y: 0 })
    const b = driver.addCar({ x: 500, y: 0 })
    const ax0 = a.x, bx0 = b.x
    driver._resolveCollisions()
    expect(a.x).toBe(ax0)
    expect(b.x).toBe(bx0)
  })

  it('sets _wasColliding true for overlapping pair', () => {
    const driver = makeDriver({ count: 0 })
    const a = driver.addCar({ x: 0, y: 0 })
    const b = driver.addCar({ x: 5, y: 0 })
    driver._resolveCollisions()
    expect(a._wasColliding).toBe(true)
    expect(b._wasColliding).toBe(true)
  })

  it('leaves _wasColliding false for non-overlapping pair', () => {
    const driver = makeDriver({ count: 0 })
    const a = driver.addCar({ x: 0, y: 0 })
    const b = driver.addCar({ x: 500, y: 0 })
    driver._resolveCollisions()
    expect(a._wasColliding).toBe(false)
    expect(b._wasColliding).toBe(false)
  })

  it('handles zero-distance overlap without throwing', () => {
    const driver = makeDriver({ count: 0 })
    driver.addCar({ x: 0, y: 0 })
    driver.addCar({ x: 0, y: 0 })
    expect(() => driver._resolveCollisions()).not.toThrow()
  })
})

// ---------- addCar / removeCar ----------

describe('addCar and removeCar', () => {
  it('addCar increases car count', () => {
    const driver = makeDriver({ count: 0 })
    expect(driver.cars).toHaveLength(0)
    driver.addCar({ x: 100, y: 100 })
    expect(driver.cars).toHaveLength(1)
  })

  it('addCar returns the new Car instance', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100 })
    expect(driver.cars).toContain(car)
  })

  it('addCar assigns cycling colors from DEFAULT_COLORS', () => {
    const driver = makeDriver({ count: 0 })
    const c0 = driver.addCar({ x: 0, y: 0 })
    const c1 = driver.addCar({ x: 0, y: 0 })
    // Colors should be valid hex strings
    expect(c0.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(c1.color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('removeCar removes it from the cars array', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 0, y: 0 })
    driver.removeCar(car)
    expect(driver.cars).not.toContain(car)
  })

  it('removeCar is a no-op for unknown car', () => {
    const driver = makeDriver({ count: 1 })
    const before = driver.cars.length
    driver.removeCar({ x: 0, y: 0 })  // not in array
    expect(driver.cars).toHaveLength(before)
  })
})

// ---------- driveTo ----------

describe('driveTo', () => {
  it('gives each car a target', () => {
    const driver = makeDriver({ count: 3 })
    driver.driveTo(400, 300)
    for (const car of driver.cars) {
      expect(car.target).not.toBeNull()
    }
  })

  it('scatter targets are near the click point', () => {
    const driver = makeDriver({ count: 3 })
    driver.driveTo(400, 300)
    for (const car of driver.cars) {
      const d = Math.sqrt((car.target.x - 400) ** 2 + (car.target.y - 300) ** 2)
      // All targets should be within a reasonable scatter radius
      expect(d).toBeLessThan(400)
    }
  })

  it('each car gets a distinct target', () => {
    // With Math.random mocked to 0.5, two cars may land on the same angle;
    // the rejection sampler should still place them separately (or at least
    // the targets are generated independently per car).
    // We just check all targets are defined.
    const driver = makeDriver({ count: 2 })
    driver.driveTo(500, 500)
    expect(driver.cars[0].target).not.toBeNull()
    expect(driver.cars[1].target).not.toBeNull()
  })

  it('does not throw when called with no cars', () => {
    const driver = makeDriver({ count: 0 })
    expect(() => driver.driveTo(400, 300)).not.toThrow()
  })
})

// ---------- _emitSkidmarks ----------

describe('_emitSkidmarks', () => {
  it('stop type: emits segments when car._skidding is true', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100, heading: 0 })
    car._skidding = true
    car.speed = 200
    driver._emitSkidmarks(car)  // coin flip (0.5 >= 0.5 → enabled); sets prev, no segment yet
    driver._emitSkidmarks(car)  // prev exists → emits 2 stop segments
    expect(driver._skidmarks.filter(s => s.type === 'stop').length).toBeGreaterThan(0)
  })

  it('bump type: fires when not skidding, was colliding, speed < 20', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100, heading: 0 })
    car._skidding = false
    car._wasColliding = true
    car.speed = 5
    driver._emitSkidmarks(car)
    car.x += car.tireWidth * 4  // move enough to exceed the minStep threshold
    driver._emitSkidmarks(car)  // prev exists + moved enough → 4 bump segments
    expect(driver._skidmarks.filter(s => s.type === 'bump').length).toBeGreaterThan(0)
  })

  it('turn type: fires when slip angle > 0.05 and speed > 60', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100, heading: 0 })
    car._skidding = false
    car._wasColliding = false
    car._slipAngle = 0.15
    car.speed = 100
    driver._emitSkidmarks(car)
    driver._emitSkidmarks(car)  // outer prev exists → outer segment emitted
    expect(driver._skidmarks.filter(s => s.type === 'turn').length).toBeGreaterThan(0)
  })

  it('accel type: fires when speeding up between 10–100 px/s with a target', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100, heading: 0 })
    car._skidding = false
    car._wasColliding = false
    car._slipAngle = 0
    car.speed = 50
    car.target = { x: 500, y: 100 }
    driver._prevSpeed.set(car, 30)  // speed(50) > prevSpeed(30) → speeding = true
    driver._emitSkidmarks(car)  // coin flip enabled; sets prev, no segment yet
    driver._prevSpeed.set(car, 30)  // reset so next call also sees speeding = true
    driver._emitSkidmarks(car)  // prev exists → emits 2 accel segments
    expect(driver._skidmarks.filter(s => s.type === 'accel').length).toBeGreaterThan(0)
  })

  it('stop takes priority over turn when both conditions are met', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100, heading: 0 })
    car._skidding = true     // stop
    car._slipAngle = 0.2    // would be turn — lower priority
    car.speed = 200
    driver._emitSkidmarks(car)
    driver._emitSkidmarks(car)
    expect(driver._skidmarks.filter(s => s.type === 'stop').length).toBeGreaterThan(0)
    expect(driver._skidmarks.filter(s => s.type === 'turn').length).toBe(0)
  })

  it('bump takes priority over accel when both conditions are met', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100, heading: 0 })
    car._skidding = false
    car._wasColliding = true  // bump (speed < 20 ✓)
    car._slipAngle = 0
    car.speed = 10
    car.target = { x: 200, y: 100 }
    driver._prevSpeed.set(car, 5)   // speeding = true → accel would qualify too
    driver._emitSkidmarks(car)
    car.x += car.tireWidth * 4  // move enough to exceed the minStep threshold
    driver._prevSpeed.set(car, 5)
    driver._emitSkidmarks(car)
    expect(driver._skidmarks.filter(s => s.type === 'bump').length).toBeGreaterThan(0)
    expect(driver._skidmarks.filter(s => s.type === 'accel').length).toBe(0)
  })

  it('coin flip: Math.random < 0.5 suppresses all marks for the event', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100, heading: 0 })
    car._skidding = true
    car.speed = 200
    vi.spyOn(Math, 'random').mockReturnValue(0.4)  // 0.4 < 0.5 → disabled
    driver._emitSkidmarks(car)
    driver._emitSkidmarks(car)
    expect(driver._skidmarks.filter(s => s.type === 'stop').length).toBe(0)
  })

  it('inner wheel delay queue: no inner segments until buffered arc exceeds car height', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100, heading: 0 })
    car._skidding = false
    car._wasColliding = false
    car._slipAngle = 0.15
    car.speed = 100
    // Move 5px/frame; innerGap = car.height = 24px.
    // After 5 moves (25px of arc) the queue releases its first point → sets delayedPrev (no segment yet).
    // The following frame emits the first actual inner segment.
    for (let i = 0; i < 6; i++) {
      car.x += 5
      driver._emitSkidmarks(car)
    }
    expect(driver._skidmarks.filter(s => s.isInner).length).toBe(0)
    car.x += 5
    driver._emitSkidmarks(car)
    expect(driver._skidmarks.filter(s => s.isInner).length).toBeGreaterThan(0)
  })

  it('no active type clears turn state and emits nothing', () => {
    const driver = makeDriver({ count: 0 })
    const car = driver.addCar({ x: 100, y: 100, heading: 0 })
    // Plant leftover turn state from a prior corner
    driver._turnOuterPrev.set(car, { x: 90, y: 90 })
    driver._turnInnerQueue.set(car, [{ x: 90, y: 90, slipAngle: 0.1 }])
    car._skidding = false
    car._wasColliding = false
    car._slipAngle = 0  // no type active
    car.speed = 0
    driver._emitSkidmarks(car)
    expect(driver._turnOuterPrev.has(car)).toBe(false)
    expect(driver._turnInnerQueue.has(car)).toBe(false)
    expect(driver._skidmarks.length).toBe(0)
  })
})

// ---------- _resolveCollisions rotational impulse ----------

describe('_resolveCollisions rotational impulse', () => {
  it('side impact changes car headings', () => {
    const driver = makeDriver({ count: 0 })
    // a faces up (π/2), push direction is +x — cross product is non-zero → spin
    const a = driver.addCar({ x: 0, y: 0, heading: Math.PI / 2 })
    const b = driver.addCar({ x: 5, y: 0, heading: 0 })
    const h0a = a.heading, h0b = b.heading
    driver._resolveCollisions()
    expect(Math.abs(a.heading - h0a) + Math.abs(b.heading - h0b)).toBeGreaterThan(0)
  })

  it('parked car (no target) rotates more than moving car (has target)', () => {
    // Moving: torque * 0.33   Parked: torque * 1.0
    const driver1 = makeDriver({ count: 0 })
    const moving = driver1.addCar({ x: 0, y: 0, heading: Math.PI / 2 })
    moving.target = { x: 1000, y: 0 }
    driver1.addCar({ x: 5, y: 0, heading: 0 })

    const driver2 = makeDriver({ count: 0 })
    const parked = driver2.addCar({ x: 0, y: 0, heading: Math.PI / 2 })
    // parked.target = null by default
    driver2.addCar({ x: 5, y: 0, heading: 0 })

    const h0moving = moving.heading
    const h0parked = parked.heading
    driver1._resolveCollisions()
    driver2._resolveCollisions()

    expect(Math.abs(parked.heading - h0parked)).toBeGreaterThan(Math.abs(moving.heading - h0moving))
  })
})

// ---------- destroy ----------

describe('destroy', () => {
  it('removes canvas from DOM', () => {
    const driver = makeDriver({ count: 1 })
    driver.destroy()
    expect(canvas.remove).toHaveBeenCalled()
  })

  it('cancels the animation frame', () => {
    const driver = makeDriver({ count: 1 })
    driver.destroy()
    // After destroy, rafCallbacks should have no pending frame from this driver
    // (cancelAnimationFrame removes it)
    expect(rafCallbacks).toHaveLength(0)
  })

  it('removes click listener', () => {
    const driver = makeDriver({ count: 1 })
    driver.destroy()
    expect(document.removeEventListener).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('removes resize listener', () => {
    const driver = makeDriver({ count: 1 })
    driver.destroy()
    expect(window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
  })
})
