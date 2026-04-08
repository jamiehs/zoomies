import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Car } from '../src/Car.js'
import { bezierPoint } from '../src/utils.js'

let randomSpy

beforeEach(() => {
  // Seed Math.random to make maxSpeed = 320 * (0.8 + 0.5*0.4) = 320
  // and other random values predictable
  randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(() => {
  randomSpy.mockRestore()
})

function makeCar(x = 0, y = 0, opts = {}) {
  return new Car(x, y, { heading: 0, ...opts })
}

describe('bicycle model physics', () => {
  it('moves forward along heading with zero steering', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.speed = 100
    car.steeringAngle = 0
    car._applyBicycleModel(0.1)
    expect(car.x).toBeCloseTo(10, 1)
    expect(car.y).toBeCloseTo(0, 1)
    expect(car.heading).toBeCloseTo(0)
  })

  it('moves along angled heading', () => {
    const car = makeCar(0, 0, { heading: Math.PI / 2 })
    car.speed = 100
    car.steeringAngle = 0
    car._applyBicycleModel(0.1)
    expect(car.x).toBeCloseTo(0, 1)
    expect(car.y).toBeCloseTo(10, 1)
  })

  it('positive steering changes heading', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.speed = 100
    car.steeringAngle = 0.3
    const h0 = car.heading
    car._applyBicycleModel(0.1)
    expect(car.heading).not.toBeCloseTo(h0)
  })

  it('zero speed produces no movement', () => {
    const car = makeCar(5, 5, { heading: 0 })
    car.speed = 0
    car.steeringAngle = 0.5
    car._applyBicycleModel(0.1)
    expect(car.x).toBe(5)
    expect(car.y).toBe(5)
    expect(car.heading).toBe(0)
  })

  it('heading change is proportional to speed', () => {
    const car1 = makeCar(0, 0, { heading: 0 })
    car1.speed = 100
    car1.steeringAngle = 0.2
    car1._applyBicycleModel(0.1)
    const delta1 = car1.heading

    const car2 = makeCar(0, 0, { heading: 0 })
    car2.speed = 200
    car2.steeringAngle = 0.2
    car2._applyBicycleModel(0.1)
    const delta2 = car2.heading

    expect(delta2 / delta1).toBeCloseTo(2, 1)
  })
})

describe('acceleration and speed capping', () => {
  it('accelerates when far from target and aligned', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.driveTo(1000, 0)
    const s0 = car.speed
    car.update(0.1, [])
    expect(car.speed).toBeGreaterThan(s0)
  })

  it('does not exceed maxSpeed', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.driveTo(10000, 0)
    // Run many frames
    for (let i = 0; i < 200; i++) car.update(0.05, [])
    expect(car.speed).toBeLessThanOrEqual(car.maxSpeed * 1.01)
  })

  it('decelerates when braking', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.speed = 200
    car.driveTo(5, 0)  // very close
    car.update(0.1, [])
    expect(car.speed).toBeLessThan(200)
  })
})

describe('arrival zone', () => {
  it('stops and clears target inside arrival radius', () => {
    const car = makeCar(100, 100, { heading: 0 })
    car.driveTo(110, 100)  // 10px away, well within arrivalRadius (144)
    car.speed = 5
    car.update(0.1, [])
    expect(car.speed).toBe(0)
    expect(car.target).toBeNull()
    expect(car.path).toBeNull()
  })

  it('does not clear target outside arrival radius', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.driveTo(500, 500)
    car.update(0.1, [])
    expect(car.target).not.toBeNull()
  })

  it('brakes without steering inside arrival radius', () => {
    const car = makeCar(100, 100, { heading: 0.5 })
    car.driveTo(120, 100)  // within arrivalRadius
    car.speed = 50
    const heading0 = car.heading
    car.update(0.016, [])
    // Speed should decrease
    expect(car.speed).toBeLessThan(50)
    // Steering angle should not have been updated by navigation
    // (the bicycle model still applies, but no new steering input)
  })
})

describe('alignment-based speed scaling', () => {
  it('car facing away from target is slower than aligned car', () => {
    const aligned = makeCar(0, 0, { heading: 0 })
    aligned.driveTo(1000, 0)
    aligned.speed = 0
    for (let i = 0; i < 10; i++) aligned.update(0.05, [])

    const misaligned = makeCar(0, 0, { heading: Math.PI })
    misaligned.driveTo(1000, 0)
    misaligned.speed = 0
    for (let i = 0; i < 10; i++) misaligned.update(0.05, [])

    expect(aligned.speed).toBeGreaterThan(misaligned.speed)
  })
})

describe('driveTo and path generation', () => {
  it('sets target', () => {
    const car = makeCar(0, 0)
    car.driveTo(500, 500)
    expect(car.target).toEqual({ x: 500, y: 500 })
  })

  it('generates bezier path', () => {
    const car = makeCar(100, 100)
    car.driveTo(500, 500)
    expect(car.path).not.toBeNull()
    expect(car.path).toHaveProperty('p0')
    expect(car.path).toHaveProperty('p1')
    expect(car.path).toHaveProperty('p2')
    expect(car.path).toHaveProperty('p3')
  })

  it('path starts at car position and ends at target', () => {
    const car = makeCar(100, 200)
    car.driveTo(500, 600)
    const start = bezierPoint(car.path.p0, car.path.p1, car.path.p2, car.path.p3, 0)
    const end = bezierPoint(car.path.p0, car.path.p1, car.path.p2, car.path.p3, 1)
    expect(start.x).toBeCloseTo(100)
    expect(start.y).toBeCloseTo(200)
    expect(end.x).toBeCloseTo(500)
    expect(end.y).toBeCloseTo(600)
  })

  it('very short distance produces null path', () => {
    const car = makeCar(100, 100)
    car.driveTo(100, 100.5)
    expect(car.path).toBeNull()
  })

  it('resets cumulative rotation', () => {
    const car = makeCar(0, 0)
    car._cumulativeRotation = 5.0
    car.driveTo(500, 500)
    expect(car._cumulativeRotation).toBe(0)
  })
})

describe('avoidance', () => {
  it('returns zero force with no other cars', () => {
    const car = makeCar(0, 0)
    const force = car._avoidanceForce([])
    expect(force.x).toBe(0)
    expect(force.y).toBe(0)
  })

  it('returns zero force for distant car', () => {
    const car = makeCar(0, 0)
    const other = makeCar(500, 0)
    const force = car._avoidanceForce([other])
    expect(Math.abs(force.x)).toBeLessThan(0.001)
    expect(Math.abs(force.y)).toBeLessThan(0.001)
  })

  it('produces repulsion from close car', () => {
    const car = makeCar(0, 0)
    const other = makeCar(20, 0)  // within avoidance radius
    const force = car._avoidanceForce([other])
    expect(force.x).toBeLessThan(0)  // pushed away (to the left)
  })

  it('force increases with proximity', () => {
    const car = makeCar(0, 0)
    const far = makeCar(40, 0)
    const close = makeCar(20, 0)
    const forceFar = car._avoidanceForce([far])
    const forceClose = car._avoidanceForce([close])
    expect(Math.abs(forceClose.x)).toBeGreaterThan(Math.abs(forceFar.x))
  })

  it('excludes self', () => {
    const car = makeCar(0, 0)
    const force = car._avoidanceForce([car])
    expect(force.x).toBe(0)
    expect(force.y).toBe(0)
  })

  it('is disabled inside arrival radius', () => {
    const car = makeCar(100, 100, { heading: 0 })
    car.driveTo(110, 100)  // 10px away, within arrivalRadius
    car.speed = 50
    const other = makeCar(105, 100)
    car.update(0.016, [other])
    expect(car._debugAvoiding).toBe(false)
  })
})

describe('orbit detection', () => {
  it('triggers orbiting when cumulative rotation exceeds 2pi near finish', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.driveTo(190, 0)  // within nearFinish zone (width*5=240) but outside arrivalRadius (144)
    car._cumulativeRotation = Math.PI * 2 + 0.1
    car.speed = 100
    car.steeringAngle = 0.1
    car.update(0.016, [])
    expect(car._orbiting).toBe(true)
  })

  it('orbiting car brakes to stop and clears target', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.driveTo(190, 0)
    car._orbiting = true
    car.speed = 50
    // Run updates until stopped
    for (let i = 0; i < 100; i++) car.update(0.05, [])
    expect(car.speed).toBe(0)
    expect(car.target).toBeNull()
    expect(car._orbiting).toBe(false)
  })

  it('resets cumulative rotation when far from target', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.driveTo(1000, 0)  // far — outside nearFinish zone (width*5=240)
    car._cumulativeRotation = 3.0
    car.speed = 100
    car.update(0.016, [])
    expect(car._cumulativeRotation).toBe(0)
  })
})

describe('coasting', () => {
  it('decelerates when no target', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.speed = 100
    car.update(0.1, [])
    expect(car.speed).toBeLessThan(100)
  })

  it('stops completely', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.speed = 10
    for (let i = 0; i < 50; i++) car.update(0.05, [])
    expect(car.speed).toBe(0)
  })
})
