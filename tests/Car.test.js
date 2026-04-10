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

describe('slip angle oscillator', () => {
  it('at rest: spring pulls slip angle toward zero', () => {
    const car = makeCar(0, 0)
    car.speed = 0
    car._slipAngle = 0.2
    car._slipVel = 0
    for (let i = 0; i < 20; i++) car._applyBicycleModel(0.05)
    expect(Math.abs(car._slipAngle)).toBeLessThan(0.2)
  })

  it('at rest: slip velocity driven by spring force on first step', () => {
    const car = makeCar(0, 0)
    car.speed = 0
    car._slipAngle = 0.1
    car._slipVel = 0
    car._applyBicycleModel(0.01)
    // spring = -34 * 0.1 = -3.4; damping = 0; vel += -3.4 * 0.01 = -0.034
    expect(car._slipVel).toBeCloseTo(-0.034, 4)
  })

  it('at rest: position and heading do not change', () => {
    const car = makeCar(5, 5)
    car.speed = 0
    car._slipAngle = 0.3
    car._applyBicycleModel(0.1)
    expect(car.x).toBe(5)
    expect(car.y).toBe(5)
    expect(car.heading).toBe(0)
  })

  it('moving: yaw rate excites slip angle', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.speed = 100
    car.steeringAngle = 0.3
    car._slipAngle = 0
    car._slipVel = 0
    car._applyBicycleModel(0.05)
    // angularVel = (100/32)*tan(0.3) ≈ 9.72 rad/s — forces slip vel non-zero
    expect(car._slipAngle).not.toBe(0)
    expect(Math.abs(car._slipVel)).toBeGreaterThan(0)
  })
})

describe('orbitDetection flag', () => {
  it('orbitDetection=false: cumulativeRotation stays 0 and orbiting stays false', () => {
    const car = makeCar(0, 0, { heading: 0 })
    car.driveTo(500, 0)
    car.orbitDetection = false
    car._cumulativeRotation = 99  // would trigger if detection were on
    car.speed = 100
    car.update(0.016, [])
    expect(car._cumulativeRotation).toBe(0)
    expect(car._orbiting).toBe(false)
  })
})

describe('exhaust afterfire', () => {
  it('timer fires and starts frame sequence when speed > 50', () => {
    const car = makeCar(0, 0, { exhaustPosition: 'rear', exhaustInterval: 1.0 })
    car.speed = 100
    car._exhaustTimer = 0.01  // expires after dt=0.1
    car.update(0.1, [])
    // Frame was set to 0 then incremented once in the same tick
    expect(car._exhaustFrame).toBe(1)
  })

  it('frame advances each tick', () => {
    const car = makeCar(0, 0, { exhaustPosition: 'rear' })
    car._exhaustFrame = 1
    car.speed = 0  // timer branch skipped; only frame advancement runs
    car.update(0.016, [])
    expect(car._exhaustFrame).toBe(2)
  })

  it('frame resets to -1 after 5 ticks', () => {
    const car = makeCar(0, 0, { exhaustPosition: 'rear' })
    car._exhaustFrame = 4
    car.speed = 0
    car.update(0.016, [])
    expect(car._exhaustFrame).toBe(-1)
  })

  it('timer does not fire when speed <= 50', () => {
    const car = makeCar(0, 0, { exhaustPosition: 'rear' })
    car._exhaustTimer = -100  // deeply expired
    car.speed = 30
    car.update(0.016, [])
    expect(car._exhaustFrame).toBe(-1)
  })

  it('timer does not fire without exhaustPosition', () => {
    const car = makeCar(0, 0)  // exhaustPosition = null
    car._exhaustTimer = -100
    car.speed = 100
    car.update(0.016, [])
    expect(car._exhaustFrame).toBe(-1)
  })

  it('timer resets with randomised interval after firing', () => {
    const car = makeCar(0, 0, { exhaustPosition: 'rear', exhaustInterval: 1.0 })
    car.speed = 100
    car._exhaustTimer = 0.01
    car.update(0.1, [])
    // Math.random = 0.5 → new timer = 1.0 * (1 + 0.5) = 1.5
    expect(car._exhaustTimer).toBeCloseTo(1.5, 1)
  })
})

describe('proximityBoost', () => {
  it('lead car reaches higher speed when trailing car is nearby (near maxSpeed)', () => {
    // Without boost: speed(325) > maxSpeed(320) → eases off
    const noBoost = makeCar(0, 0, { heading: 0 })
    noBoost.driveTo(10000, 0)
    noBoost.speed = 325
    noBoost.proximityBoost = false
    noBoost.update(0.016, [])

    // With boost: effectiveMax rises above 325 → car accelerates instead
    const boosted = makeCar(0, 0, { heading: 0 })
    boosted.driveTo(10000, 0)
    boosted.speed = 325
    const trailer = makeCar(40, 0, { heading: 0 })
    trailer.driveTo(500000, 0)  // very far from its target → trailer is the follower
    boosted.update(0.016, [trailer])

    expect(boosted.speed).toBeGreaterThan(noBoost.speed)
  })

  it('trailing car does not get boost (only lead car does)', () => {
    const lead = makeCar(0, 0, { heading: 0 })
    lead.driveTo(100, 0)    // close to target

    const trail = makeCar(40, 0, { heading: 0 })
    trail.driveTo(500000, 0)  // far from target
    trail.speed = 50
    const speedBefore = trail.speed

    // trail's myDist(499960) > lead's otherDist(100) → trail is NOT the lead → no boost
    trail.update(0.016, [lead])
    expect(trail.speed).toBeGreaterThanOrEqual(speedBefore)
  })

  it('colliding-state boost (0.7×) yields higher speed than normal boost (0.3×)', () => {
    // speed=370: above non-colliding effectiveMax(~362) but below colliding effectiveMax(~419)
    const nonColliding = makeCar(0, 0, { heading: 0 })
    nonColliding.driveTo(10000, 0)
    nonColliding.speed = 370
    nonColliding._wasColliding = false
    const trail1 = makeCar(40, 0, { heading: 0 })
    trail1.driveTo(500000, 0)
    nonColliding.update(0.016, [trail1])

    const colliding = makeCar(0, 0, { heading: 0 })
    colliding.driveTo(10000, 0)
    colliding.speed = 370
    colliding._wasColliding = true
    const trail2 = makeCar(40, 0, { heading: 0 })
    trail2.driveTo(500000, 0)
    colliding.update(0.016, [trail2])

    expect(colliding.speed).toBeGreaterThan(nonColliding.speed)
  })

  it('proximityBoost=false: speed eases off normally with no boost', () => {
    const lead = makeCar(0, 0, { heading: 0 })
    lead.driveTo(10000, 0)
    lead.speed = 325  // above maxSpeed → would ease off without boost
    lead.proximityBoost = false
    const trailer = makeCar(40, 0, { heading: 0 })
    trailer.driveTo(500000, 0)
    lead.update(0.016, [trailer])
    // No boost → effectiveMax = 320 → speed eases toward 320
    expect(lead.speed).toBeLessThan(325)
  })
})
