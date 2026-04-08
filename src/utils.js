/**
 * Returns the shortest signed angular difference from angle `a` to angle `b`,
 * in radians, in the range (−π, π].
 */
export function angleDiff(a, b) {
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
