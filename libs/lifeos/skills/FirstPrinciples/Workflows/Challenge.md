# Challenge Workflow

**Purpose**: Systematically challenge every assumption and constraint, classifying each as hard constraint (physics), soft constraint (choice), or unvalidated assumption.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the Challenge workflow in the FirstPrinciples skill to test assumptions"}' \
  > /dev/null 2>&1 &
```

Running the **Challenge** workflow in the **FirstPrinciples** skill to test assumptions...

---

**When to Use**:
- After Deconstruct, to evaluate what's actually fixed
- When requirements feel overly restrictive
- When "we can't do X" is stated without evidence
- For adversarial analysis (RedTeam, pentesting)
- Before major architecture or strategy decisions

---

## The Core Question

For every stated constraint, ask:

> "Is this a law of physics, or is it a choice someone made?"

If it's a choice, it can be changed.

---

## Classify Every Constraint

Gather everything presented as a constraint — requirements, "we have to..." statements, best practices, budget/timeline limits, policy — then classify each:

| Type | Definition | Test | Examples |
|------|------------|------|----------|
| **HARD** | Physics/math/reality | Would violating this break laws of nature? | Speed of light, thermodynamics, gravity |
| **SOFT** | Policy/choice/convention | Could a decision-maker change this? | "We use AWS", "REST APIs only", budget limits |
| **ASSUMPTION** | Unvalidated belief | Has this been tested? What's the evidence? | "Users won't accept that", "Too expensive" |

A done Challenge exhibits three properties:

- Every SOFT constraint traced to who decided it, why, and whether the original reason still holds; every ASSUMPTION paired with its evidence and a test that could disprove it.
- The **"remove it" test** applied to each non-hard constraint: if removing it unlocks significant value, it's worth challenging.
- The **hidden constraints** surfaced — the implicit ones so assumed they were never stated ("of course we need a database," "obviously this needs auth"). Those are the most dangerous.

---

## Output Template

```markdown
## Constraint Analysis: [Subject]

### All Stated Constraints
1. [Constraint 1]
2. [Constraint 2]
3. [Constraint 3]
...

### Classification

#### HARD Constraints (Physics/Reality)
| Constraint | Why It's Hard | Cannot Be Changed Because |
|------------|---------------|---------------------------|
| [X] | [Physics law] | [Would violate reality] |

#### SOFT Constraints (Policy/Choice)
| Constraint | Who Decided | Original Reason | Still Valid? | If Removed? |
|------------|-------------|-----------------|--------------|-------------|
| [X] | [Person/team] | [Why] | [Yes/No/Maybe] | [What's possible] |

#### ASSUMPTIONS (Unvalidated)
| Assumption | Evidence | Counter-Evidence | Test To Validate |
|------------|----------|------------------|------------------|
| [X] | [What supports it] | [What contradicts] | [How to prove/disprove] |

### Hidden Constraints Found
- [Implicit assumption 1 that was never stated]
- [Implicit assumption 2]

### Constraints Worth Challenging
1. **[Constraint]**: [Why it should be challenged, what becomes possible]
2. **[Constraint]**: [Why it should be challenged, what becomes possible]

### Recommended Actions
- [ ] Validate assumption: [X] by [method]
- [ ] Challenge soft constraint: [Y] with [stakeholder]
- [ ] Accept hard constraint: [Z] and design around it
```

---

## Example: Challenging "Enterprise Software Requirements"

### Stated Constraints
1. Must support 10,000 concurrent users
2. Must have 99.99% uptime
3. Must integrate with SAP
4. Must pass SOC 2 audit
5. Must use approved vendor list
6. Must have 24/7 support
7. Must support IE11

### Classification

#### HARD Constraints
| Constraint | Why Hard | Cannot Change |
|------------|----------|---------------|
| (None identified) | - | - |

*Note: None of these are physics - all are choices*

#### SOFT Constraints
| Constraint | Who Decided | Original Reason | Still Valid? | If Removed? |
|------------|-------------|-----------------|--------------|-------------|
| 10k concurrent | Capacity planning | Peak load estimate | Maybe - check actual usage | Right-size infrastructure |
| 99.99% uptime | SLA template | Standard enterprise SLA | Maybe - check actual need | 99.9% = 10x cheaper |
| SAP integration | Finance team | Existing ERP | Yes - but scope negotiable | Simpler integration |
| SOC 2 | Security policy | Customer requirement | Yes - but scope matters | Focus on relevant controls |
| Approved vendors | Procurement | Risk management | Questionable | Better/cheaper options |
| 24/7 support | Sales promise | Customer expectation | Check contract | Business hours might suffice |
| IE11 support | Legacy policy | Old corporate standard | NO - IE11 is dead | Modern stack, 30% less effort |

#### ASSUMPTIONS
| Assumption | Evidence | Counter-Evidence | Test |
|------------|----------|------------------|------|
| "Need 10k concurrent" | Capacity doc | Actual peak: 847 | Check logs |
| "Customers require 99.99%" | Sales said so | No SLA penalties paid | Review contracts |
| "Must support IE11" | 2019 policy | IE11 EOL, 0.1% traffic | Check analytics |

### Constraints Worth Challenging
1. **IE11 Support**: Dead browser, removes 30% of frontend complexity
2. **10k Concurrent**: Actual usage is 847 peak - right-size saves $$$
3. **99.99% Uptime**: 99.9% is likely sufficient, 10x cost difference
4. **Approved Vendor List**: May exclude better solutions for no real risk reduction

---

## Integration with Other Skills

**RedTeam**: Use Challenge to attack the assumptions behind any idea
```
→ FirstPrinciples/Challenge on stated security controls
→ FirstPrinciples/Challenge on business model assumptions
```

**Pentester**: Use Challenge to find real vs. assumed security boundaries
```
→ FirstPrinciples/Challenge on "the firewall protects us"
→ FirstPrinciples/Challenge on trust boundaries
```

**Architect**: Use Challenge before accepting any requirement
```
→ FirstPrinciples/Challenge on NFRs (non-functional requirements)
→ FirstPrinciples/Challenge on technology choices
```

---

## After Challenge

Flow to:
- **Reconstruct** → Build solution using only hard constraints
- Back to requester with constraint analysis for decision-making
