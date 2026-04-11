# car-driver

Drop animated top-down race cars into any web page. Cars drive to wherever the user clicks, avoid each other, and move with realistic physics — rear-axle bicycle steering, acceleration, braking, skidmarks, exhaust flashes, and soft shadows.

```js
import { CarDriver } from 'car-driver'

const driver = new CarDriver({ skidOpacity: 0.08, shadowBlur: 4 })

driver.addCar({ color: '#fff', sprite: './car.png', exhaustPosition: 'rear' })
driver.addCar({ color: '#00f', maxSpeed: 500, tireWidth: 6 })

// Click anywhere → cars drive there. Or call programmatically:
driver.driveTo(400, 300)        // all cars
driver.cars[0].driveTo(200, 200) // one car
```

---

## Installation

```bash
npm install car-driver
```

Or drop the IIFE build straight into a `<script>` tag:

```html
<script src="dist/car-driver.iife.js"></script>
<script>
  const driver = new CarDriver()
</script>
```

---

## CarDriver options

```js
new CarDriver({
  // Fleet
  count: 3,               // cars spawned on init (default 3)

  // Rendering
  zIndex: 9999,           // canvas z-index

  // Skidmarks
  skidOpacity: 0.08,      // per-segment opacity multiplier (0–1); 1 = raw baked alpha

  // Shadows
  shadow: true,           // draw soft shadow under each car
  shadowOpacity: 0.40,    // shadow fill opacity
  shadowBlur: 4.5,        // shadow blur radius in px
  shadowOffsetX: 4,       // shadow offset in page-space (not car-space)
  shadowOffsetY: 6,

  // Debug
  debug: false,           // Ctrl+Shift+Space also toggles at runtime
})
```

### CarDriver methods & properties

| | |
|---|---|
| `driver.driveTo(x, y)` | Send all cars to a scattered cluster around (x, y) |
| `driver.addCar(opts)` | Spawn a new car; returns the `Car` instance |
| `driver.removeCar(car)` | Remove a car |
| `driver.cars` | Array of `Car` instances |
| `driver.destroy()` | Remove canvas and all event listeners |
| `driver.debug` | Toggle debug overlay (also Ctrl+Shift+Space) |
| `driver.skidOpacity` | Adjust skidmark opacity live |
| `driver.shadow` / `driver.shadowBlur` / etc. | Adjust shadow live |

---

## Car options

All options are optional — sensible defaults are provided.

### Physics

| Option | Default | Description |
|---|---|---|
| `maxSpeed` | 320 | Top speed in px/s (±20% random variation per car) |
| `acceleration` | 220 | Acceleration in px/s² |
| `brakes` | 0.5 | Braking strength: `0` = poor (~60 px/s²), `0.5` = default (~480 px/s²), `1` = ABS (~900 px/s²). Override with raw `brakeDecel` (px/s²) for precise control. |
| `wheelbase` | 32 | Distance between axles in px; also drives visual body length |
| `maxSteering` | 35 | Maximum front wheel angle in ± degrees from centre (lock-to-lock = `maxSteering × 2`) |
| `steeringRate` | 120 | How fast the steering wheel turns, in degrees/s |
| `twitchiness` | 0.4 | High-speed steering character. `0` = super stable (steering rate drops to zero at max speed), `1` = very twitchy (full steering rate at any speed). Controls how much `steeringRate` is reduced as speed rises. |
| `arrivalRadius` | 144 | Radius around target where car brakes to a stop |
| `skidThreshold` | 150 | Speed above which braking produces a skid effect |
| `grip` | `1.0` | Tire grip level (0–1). Scales four physics values: `skidThreshold × grip` (lower grip → skids start sooner), `slipStiffness × grip` (less restoring force → more oversteer), `slipScale / grip` (wider skidmark fan), and `brakeDecel × (0.3 + 0.7 × grip)` (minimum 30% braking even at grip=0). |
| `slipStiffness` | 34 | Rear slip spring constant — how quickly tires restore grip (ω_n = √k ≈ 5.8 rad/s) |
| `slipDamping` | 3 | Slip damper — ζ ≈ 0.34, clearly underdamped with visible overshoot on corner exit |
| `slipScale` | 1.0 | Multiplier on the mark lateral offset — increase to exaggerate the visual wiggle without changing physics |

### Appearance

| Option | Default | Description |
|---|---|---|
| `color` | `'#e63946'` | CSS color — any format (hex, named, rgb()) |
| `height` | 24 | Car body height in px |
| `tireWidth` | 4 | Skidmark line width in px |
| `sprite` | `null` | URL string or `HTMLImageElement`; falls back to a colored rectangle |
| `shadowCornerRadius` | `4` | Corner radius for the shadow rectangle in px; set to `0` for a square shadow |

### Exhaust afterfire

When `exhaustPosition` is set, a brief yellow flash fires periodically while the car is moving above 50 px/s. The interval is `exhaustInterval × (1–2)`, so the default 0.9 s setting fires every 0.9–1.8 s.

| Option | Default | Description |
|---|---|---|
| `exhaustPosition` | `null` | `'left'` \| `'right'` \| `'bothSides'` \| `'rear'` |
| `exhaustOffset` | 0.5 | Position along the chosen edge (0 = front/left corner, 1 = rear/right corner) |
| `exhaustRadius` | 6 | Radius of each flash circle in px |
| `exhaustInterval` | 0.9 | Minimum seconds between flashes; actual interval is `exhaustInterval × (1–2)` |

### Behaviour flags

| Option | Default | Description |
|---|---|---|
| `driveBias` | `1.0` | Drivetrain layout: `0` = FWD (front marks on acceleration), `1` = RWD (rear marks), `0`–`1` = AWD with blended front/rear marks |
| `aggression` | `0.3` | How committed the car is to its bezier path while braking. `0` = careful (drops the path, aims straight at target); `1` = aggressive (follows the path all the way in). Values in between blend the two steering directions. |
| `orbitDetection` | `true` | Detect and escape infinite-circle situations |
| `proximityBoost` | `true` | Lead car gets a speed boost to pull away from a trailing car |
| `heading` | random | Initial heading in radians |
| `x`, `y` | center | Initial position |

---

## Physics

### Bicycle model

Each car is a kinematic rear-axle bicycle model. The two rear wheels are collapsed to a single pivot; only the front axle steers. Heading changes at:

```
ω = (v / L) · tan(δ)
```

where `v` is speed, `L` is wheelbase, and `δ` is steering angle (clamped to ±`maxSteering`°). `maxSteering` is a one-sided limit — the wheel travels that many degrees left or right from centre, so total lock-to-lock is `maxSteering × 2`. Each frame: `heading += ω · dt`, then the rear axle advances along the new heading. No lateral slip.

### Steering control loop

The steering system is a **P controller** (proportional only) with a rate-limited actuator. Each frame:

1. **Error** — `headingError = angleDiff(heading, desiredHeading)`
2. **Command** — `targetSteering = clamp(headingError, ±maxSteering)`
3. **Rate limit** — `steeringAngle` advances toward `targetSteering` by at most `effectiveSteeringRate × dt`

There is no I or D term. The absence of a derivative means the wheel can overshoot the setpoint and reverse — this is intentional and contributes to the car's character.

The three steering props operate in a pipeline:

- **`maxSteering`** — the geometric ceiling on wheel travel. Sets the minimum turning radius at any speed (`r = wheelbase / tan(maxSteering)`). Does not change with speed.
- **`steeringRate`** — how fast the wheel can physically move (degrees/s). This is the rate limiter on the actuator — the fastest the wheel will ever travel, regardless of how large the error is. Tune this at **low speed** where `twitchiness` has no effect.
- **`twitchiness`** — a speed-sensitive scalar applied to `steeringRate` each frame:

```
effectiveSteeringRate = steeringRate × (1 − speedRatio × (1 − twitchiness))
```

At `twitchiness: 1` the scalar is always 1 — full `steeringRate` at any speed. At `twitchiness: 0` the rate drops to zero at max speed. `twitchiness` does **not** affect `maxSteering`; a stable car can still reach full lock, it just takes longer to get there. Tune this at **high speed** after `steeringRate` is set.

**Tuning order:** set `steeringRate` by watching slow-speed corner entry, then dial `twitchiness` by watching the front wheel lines in the debug overlay during a high-speed path change. Think of `steeringRate` as how fast the driver's hands move, and `twitchiness` as how much they slow down at pace.

| Scenario | What dominates |
|---|---|
| Slow speed, tight corner | `maxSteering` — is there enough lock? `steeringRate` barely matters since the wheel has time to catch up |
| High speed, gradual curve | `twitchiness` — how quickly does the wheel respond to the path's gentle demand? |
| High speed, sudden obstacle | All three — `twitchiness` limits how fast the wheel moves, `steeringRate` is the ceiling on that, and `maxSteering` is whether there's enough authority to make the turn at all |
| Cornering slip / tail-happy | `steeringRate` × `twitchiness` together determine how quickly yaw rate builds, which is the forcing term driving the slip angle oscillator |

### Bézier paths

On each new target, a cubic Bézier is generated from the car's position to the destination. Control points are offset perpendicular to the straight line by random amounts (up to 60% and 40% of the total distance), producing arcs and S-curves. The car tracks a speed-adaptive lookahead point ahead of its current arc progress — 6% at rest, rising to 20% at top speed — so fast cars anticipate direction changes earlier and don't oscillate chasing a point too close to their nose.

### Speed & alignment scaling

Target speed is scaled by how well the car faces the target:

```
v_eff = v_max · clamp(floor + (1 − floor) · cos(θ_err), floor, 1)
```

The floor is 0.3 normally, rising to 0.7 during an active collision so a bumped car isn't artificially slowed.

### Speed & braking

Three props set the speed envelope; `grip` then scales two of them:

```
brakeDecel          = 60 + brakes × 840
effectiveBrakeDecel = brakeDecel × (0.3 + 0.7 × grip)
brakingDist         = v² / (2 × effectiveBrakeDecel)
skidding            = speed > skidThreshold × grip
```

- **`maxSpeed`** — the per-car ceiling, with ±20% random variation applied at construction. The car never actually reaches this in a straight line because alignment scaling reduces target speed proportionally to heading error (floor 0.3, so even a sideways car keeps 30% to aid turning). Proximity boost can push a lead car briefly above it.
- **`acceleration`** — a constant px/s² ramp. There is no traction limit on acceleration; it runs at the same rate regardless of speed or steering angle.
- **`brakes`** — maps 0–1 onto a deceleration range: `0` ≈ 60 px/s² (barely slows), `0.5` ≈ 480 px/s² (default), `1` ≈ 900 px/s² (near-instant). Use raw `brakeDecel` (px/s²) for precise control.
- **`grip`** — a single 0–1 knob that touches four values simultaneously: effective braking force (`brakeDecel × (0.3 + 0.7 × grip)`), skid trigger threshold (`skidThreshold × grip`), rear slip spring stiffness (`slipStiffness × grip`), and skidmark fan width (`slipScale / grip`). Lowering grip makes the car skid sooner, oversteer more, leave wider marks, and stop in a longer distance.

**Tuning order:** set `maxSpeed` for the car's character, then `brakes` so stopping distance feels right (the debug overlay shows the arrival radius — braking should begin just outside it), then `grip` to dial skid frequency and oversteer character. Adjust `slipScale` last; it is purely visual with no physics effect.

| Scenario | What dominates |
|---|---|
| Car slides past target | `brakes` too low — stopping distance exceeds the approach gap; increase `brakes` or reduce `maxSpeed` |
| Stops too abruptly, no character | `brakes` too high — reduce it, or lower `grip` to soften effective decel |
| Skids at very low speed | `grip` too low — it multiplies `skidThreshold` down; raise `grip` or raise `skidThreshold` directly |
| No skids at all | `maxSpeed` is below `skidThreshold × grip`; lower `grip` or lower `skidThreshold` |
| Dramatic rear oversteer / drift | Low `grip` weakens the slip spring; pair with high `slipScale` for wider marks |
| Car won't reach top speed | Alignment scaling is capping it — large heading error from tight bezier; reduce `aggression` or widen the path |
| Acceleration feels sluggish | `acceleration` too low; or `maxSpeed` very high making the ramp long |

### Braking & arrival

Stopping distance at any speed: `d_stop = v² / (2 · effectiveBrakeDecel)`. Braking begins when the car is within `d_stop × 1.2` of its target. Inside the arrival radius, the car brakes to a dead stop while avoidance steering remains active — cars will nudge each other apart even while parking.

### Orbit detection

Cumulative angular displacement is tracked within `5 × width` of the target. If it exceeds 2π the car is flagged as orbiting and brakes to a stop at 60% normal deceleration, then clears its target.

### Collision resolution

After every tick, overlapping pairs are hard-separated along their centre axis by the exact overlap amount (½ each). A rotational impulse proportional to the cross product of push direction and forward axis spins side-hit cars without affecting head-on collisions. Moving cars receive 15% of the impulse a parked car would.

### Proximity boost

When two cars are within 1.5 car-widths, the lead car (closer to its target) receives a forward speed boost: `urgency × (0.7 if colliding, else 0.3)`. The trailing car is never slowed.

### Rear slip angle

Turn skidmarks are driven by a rear slip angle `α` modelled as a 2nd-order damped oscillator:

```
d²α/dt² = ω − k·α − c·(dα/dt)
```

where `ω` is the current yaw rate (the cornering forcing), `k` is `slipStiffness`, and `c` is `slipDamping`. With `ζ = c / (2√k) ≈ 0.34` the system is clearly underdamped — on corner exit the rear steps out and oscillates back through zero before settling, producing the snap-back wiggle characteristic of a car on the limit. Turn marks fire when `|α| > 0.05 rad` and their contact-patch positions are offset laterally by `sin(α)`, so the marks fan outward mid-corner and trace the oscillation on exit.

### Avoidance steering

A repulsion vector from neighbours within `0.66 × width` is blended into the desired heading. Weight is 2.5 normally, 0.8 while braking (so nearby parked cars don't push an arriving car away from its target), and reduced but still active inside the arrival radius so cars nudge apart while parking. Steering rate caps actual wheel movement at ±120°/s.

---

## Skidmarks

Four types, evaluated in priority order each frame. Marks are drawn once to a persistent background canvas and accumulate at zero per-frame cost.

| Type | Trigger | Wheels | Alpha |
|---|---|---|---|
| **Stop** | Braking above `skidThreshold × grip` px/s | All four — random lock bias per event: 50% balanced, 25% front-heavy (fa=1.0, ra=0.25), 25% rear-heavy (fa=0.25, ra=1.0) | 1.0 × axle bias weight |
| **Accel** | Speed 10–100 px/s while gaining speed | Driven wheels only — rear at `driveBias` weight, front at `1 − driveBias`; RWD = rear only, FWD = front only, AWD = both | `1 − (v − 10) / 90` (fades as speed rises) |
| **Turn** | Steering > 65% lock at > 100 px/s | Outer rear (solid), inner rear (20% alpha, 10-frame delayed start) | Proportional to lock angle × 0.5 |
| **Bump** | Any collision while not hard-braking | All four | 0.5 |

Each skid *event* (type first activating) has a 50% chance of producing no marks at all, giving organic variation. `skidOpacity` is a global multiplier applied on top of all baked alphas.

---

## Shadows

Shadows are drawn in a separate canvas transform before the car body, so the offset is in page-space (world-space) rather than car-local space. A car rotated 180° still casts its shadow toward the same corner of the screen.

Set `shadowOffsetX: 0, shadowOffsetY: 0` for a shadow directly underneath (no directional offset).

---

## Debug overlay

Press **Ctrl+Shift+Space** (or set `driver.debug = true`) to enable:

- Bezier path curves and control points, tinted per car
- Avoidance radius circle per car
- Desired heading arrow
- Active-avoidance highlight box (yellow) and avoided-car flash (magenta)
- Exhaust position crosshair(s)
- Skid type ring + label per active car (colored by type)
- Skid segment count breakdown by type
- Target crosshair + arrival radius circle

In debug mode, `skidOpacity` is bypassed and marks render at their raw baked alpha so individual values are easy to tune.

---

## Build

```bash
npm run dev    # Vite dev server
npm run build  # Outputs dist/car-driver.es.js and dist/car-driver.iife.js
npm test       # Vitest (109 tests)
```
