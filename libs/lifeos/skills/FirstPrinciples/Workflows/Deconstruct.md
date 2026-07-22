# Deconstruct Workflow

**Purpose**: Break down any problem, system, or concept into its fundamental constituent parts and irreducible truths.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the Deconstruct workflow in the FirstPrinciples skill to break down components"}' \
  > /dev/null 2>&1 &
```

Running the **Deconstruct** workflow in the **FirstPrinciples** skill to break down components...

---

**When to Use**:
- Starting any first principles analysis
- When a problem seems intractable
- When costs/complexity seem fixed
- When inherited solutions feel wrong but you can't articulate why

---

## What a Done Deconstruction Shows

Take the subject apart until you hit elements that can't be decomposed further, then separate what's fundamental from what's inherited. The output must:

- Start from the **stated** components (what the market/industry says it's made of) and drill each into its **actual** constituents — material inputs, minimum viable version, raw-material cost.
- Isolate the **fundamental truths**: laws of physics, mathematical certainties, empirically verified facts, irreducible requirements. Industry best-practices, "how it's always been done," market prices, and conventional wisdom are NOT fundamental truths.
- **Map the gap** between the stated cost/complexity and the actual fundamental cost — that gap is where the leverage is.

The one non-obvious move: a **market price is not a fundamental cost**. "Battery pack = $600/kWh" deconstructs to ~$80/kWh of commodity materials — 87% of the price is assembly and margin, not physics.

---

## Output Template

```markdown
## Deconstruction: [Subject]

### What We're Told
[Common description of the subject]

### Stated Components
1. [Component 1]
2. [Component 2]
3. [Component 3]

### Actual Constituents
For each stated component, the fundamental parts:

**[Component 1]**:
- Actual parts: [list]
- Real cost/value: [amount]
- Insight: [what's different from stated]

**[Component 2]**:
- Actual parts: [list]
- Real cost/value: [amount]
- Insight: [what's different from stated]

### Fundamental Truths (Irreducible)
1. [Truth 1 - cannot be decomposed further]
2. [Truth 2 - physics/math/verified fact]
3. [Truth 3 - actual hard requirement]

### Key Gaps Identified
| Stated | Actual | Gap |
|--------|--------|-----|
| [X costs $Y] | [Materials cost $Z] | [$Y-Z is not fundamental] |

### Implications
- [What this means for our approach]
- [What becomes possible now]
```

---

## Example: Deconstructing "Rocket Launch Costs"

### What We're Told
"Launching a rocket to orbit costs $65 million because aerospace is expensive"

### Stated Components
1. Rocket vehicle
2. Fuel
3. Launch operations
4. Aerospace-grade engineering

### Actual Constituents

**Rocket Vehicle**:
- Actual parts: Aluminum alloys, titanium, copper, carbon fiber
- Real cost: ~2% of typical rocket price on commodity markets
- Insight: 98% of vehicle cost is not materials

**Fuel**:
- Actual parts: Liquid oxygen, RP-1 kerosene
- Real cost: ~$200,000 per launch
- Insight: Fuel is negligible in total cost

**Launch Operations**:
- Actual parts: Pad rental, personnel, range safety
- Real cost: Variable but not fundamentally $60M+
- Insight: Most "operations cost" is amortized development

**Aerospace-grade Engineering**:
- Actual need: Reliability, not gold-plating
- Real requirement: Physics of reaching orbit
- Insight: "Aerospace-grade" is often convention, not physics

### Fundamental Truths (Irreducible)
1. Must achieve ~9.4 km/s delta-v to reach orbit (physics)
2. Must survive aerodynamic and thermal loads (physics)
3. Must carry payload mass (requirement)
4. Propellant mass ratio governed by rocket equation (physics)

### Key Gaps Identified
| Stated | Actual | Gap |
|--------|--------|-----|
| Vehicle: $50M | Materials: $1M | $49M is not fundamental |
| "Rockets are expensive" | Physics doesn't require $65M | Convention, not constraint |

### Implications
- We can build rockets for dramatically less if we start from materials
- "Aerospace-grade" practices should be challenged individually
- Vertical integration recaptures the 98% margin
- **This insight created SpaceX**

---

## Integration Notes

After Deconstruct, typically flow to:
- **Challenge** → Question each constraint classification
- **Reconstruct** → Build optimal solution from fundamental truths

Other skills can invoke:
```
→ FirstPrinciples/Deconstruct on [security model / architecture / cost structure]
```
