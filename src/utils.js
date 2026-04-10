/**
 * Returns the shortest signed angular difference from angle `a` to angle `b`,
 * in radians, in the range (−π, π].
 */
export function angleDiff(a, b) {
  // TODO(perf): while loops → single modulo: ((b-a+Math.PI) % (2*Math.PI)) - Math.PI
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d <= -Math.PI) d += 2 * Math.PI
  return d
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}

/** Evaluate a cubic bezier at parameter t (0–1). */
export function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t
  return {
    x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
    y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
  }
}

/** Approximate the arc length of a cubic bezier by sampling. */
export function bezierLength(p0, p1, p2, p3, steps = 20) {
  let len = 0
  let prev = p0
  for (let i = 1; i <= steps; i++) {
    const pt = bezierPoint(p0, p1, p2, p3, i / steps)
    const dx = pt.x - prev.x
    const dy = pt.y - prev.y
    len += Math.sqrt(dx * dx + dy * dy)
    prev = pt
  }
  return len
}

/** Minimal 2-D vector helpers. */
export const vec2 = {
  add(a, b) { return { x: a.x + b.x, y: a.y + b.y } },
  sub(a, b) { return { x: a.x - b.x, y: a.y - b.y } },
  scale(v, s) { return { x: v.x * s, y: v.y * s } },
  len(v) { return Math.sqrt(v.x * v.x + v.y * v.y) },
  normalize(v) {
    const l = vec2.len(v)
    return l === 0 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l }
  },
}
