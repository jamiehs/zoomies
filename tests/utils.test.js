import { describe, it, expect } from 'vitest'
import { angleDiff, clamp, lerp, bezierPoint, bezierLength, vec2 } from '../src/utils.js'

describe('angleDiff', () => {
  it('returns 0 for identical angles', () => {
    expect(angleDiff(0, 0)).toBe(0)
  })

  it('returns positive for small clockwise difference', () => {
    expect(angleDiff(0, 0.5)).toBeCloseTo(0.5)
  })

  it('returns negative for small counter-clockwise difference', () => {
    expect(angleDiff(0.5, 0)).toBeCloseTo(-0.5)
  })

  it('wraps across the pi boundary (positive)', () => {
    // 3.0 to -3.0 should go the short way (~0.283 rad)
    const result = angleDiff(3.0, -3.0)
    expect(result).toBeCloseTo(2 * Math.PI - 6.0, 5)
  })

  it('wraps across the pi boundary (negative)', () => {
    const result = angleDiff(-3.0, 3.0)
    expect(result).toBeCloseTo(-(2 * Math.PI - 6.0), 5)
  })

  it('returns pi for angles exactly pi apart', () => {
    expect(angleDiff(0, Math.PI)).toBeCloseTo(Math.PI)
  })

  it('result is in range (-pi, pi]', () => {
    // angleDiff(pi, 0) = -pi, but the while loop wraps -pi to +pi
    const result = angleDiff(Math.PI, 0)
    expect(result).toBeCloseTo(Math.PI)
  })

  it('handles large multiples of 2pi', () => {
    expect(angleDiff(0, 4 * Math.PI + 0.1)).toBeCloseTo(0.1)
  })
})

describe('clamp', () => {
  it('clamps value below min', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
  })

  it('clamps value above max', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })

  it('returns value when in range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('returns min when value equals min', () => {
    expect(clamp(0, 0, 10)).toBe(0)
  })

  it('returns max when value equals max', () => {
    expect(clamp(10, 0, 10)).toBe(10)
  })
})

describe('lerp', () => {
  it('returns a at t=0', () => {
    expect(lerp(10, 20, 0)).toBe(10)
  })

  it('returns b at t=1', () => {
    expect(lerp(10, 20, 1)).toBe(20)
  })

  it('returns midpoint at t=0.5', () => {
    expect(lerp(10, 20, 0.5)).toBe(15)
  })

  it('interpolates at t=0.25', () => {
    expect(lerp(0, 100, 0.25)).toBe(25)
  })

  it('works with negative range', () => {
    expect(lerp(-10, 10, 0.5)).toBe(0)
  })
})

describe('bezierPoint', () => {
  // Straight-line bezier: all control points collinear along x-axis
  const p0 = { x: 0, y: 0 }
  const p1 = { x: 1, y: 0 }
  const p2 = { x: 2, y: 0 }
  const p3 = { x: 3, y: 0 }

  it('returns p0 at t=0', () => {
    const pt = bezierPoint(p0, p1, p2, p3, 0)
    expect(pt.x).toBeCloseTo(0)
    expect(pt.y).toBeCloseTo(0)
  })

  it('returns p3 at t=1', () => {
    const pt = bezierPoint(p0, p1, p2, p3, 1)
    expect(pt.x).toBeCloseTo(3)
    expect(pt.y).toBeCloseTo(0)
  })

  it('returns midpoint at t=0.5 for straight-line bezier', () => {
    const pt = bezierPoint(p0, p1, p2, p3, 0.5)
    expect(pt.x).toBeCloseTo(1.5)
    expect(pt.y).toBeCloseTo(0)
  })

  it('produces non-zero y for curved bezier', () => {
    const curved1 = { x: 0, y: 2 }
    const curved2 = { x: 3, y: 2 }
    const pt = bezierPoint(p0, curved1, curved2, p3, 0.5)
    expect(pt.y).toBeGreaterThan(0)
  })
})

describe('bezierLength', () => {
  const p0 = { x: 0, y: 0 }
  const p3 = { x: 3, y: 0 }

  it('returns correct length for straight-line bezier', () => {
    const p1 = { x: 1, y: 0 }
    const p2 = { x: 2, y: 0 }
    expect(bezierLength(p0, p1, p2, p3)).toBeCloseTo(3, 1)
  })

  it('converges with more steps', () => {
    const p1 = { x: 1, y: 0 }
    const p2 = { x: 2, y: 0 }
    const len20 = bezierLength(p0, p1, p2, p3, 20)
    const len100 = bezierLength(p0, p1, p2, p3, 100)
    expect(Math.abs(len20 - len100)).toBeLessThan(0.01)
  })

  it('curved bezier is longer than chord distance', () => {
    const p1 = { x: 0, y: 5 }
    const p2 = { x: 3, y: 5 }
    const chord = 3
    expect(bezierLength(p0, p1, p2, p3)).toBeGreaterThan(chord)
  })
})

describe('vec2', () => {
  it('adds vectors', () => {
    const r = vec2.add({ x: 1, y: 2 }, { x: 3, y: 4 })
    expect(r).toEqual({ x: 4, y: 6 })
  })

  it('subtracts vectors', () => {
    const r = vec2.sub({ x: 5, y: 7 }, { x: 2, y: 3 })
    expect(r).toEqual({ x: 3, y: 4 })
  })

  it('scales vector', () => {
    const r = vec2.scale({ x: 2, y: 3 }, 4)
    expect(r).toEqual({ x: 8, y: 12 })
  })

  it('computes length', () => {
    expect(vec2.len({ x: 3, y: 4 })).toBe(5)
  })

  it('returns 0 for zero vector length', () => {
    expect(vec2.len({ x: 0, y: 0 })).toBe(0)
  })

  it('normalizes vector', () => {
    const r = vec2.normalize({ x: 3, y: 4 })
    expect(r.x).toBeCloseTo(0.6)
    expect(r.y).toBeCloseTo(0.8)
  })

  it('normalizes zero vector without error', () => {
    const r = vec2.normalize({ x: 0, y: 0 })
    expect(r).toEqual({ x: 0, y: 0 })
  })
})
