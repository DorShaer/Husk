# QuickCheck Workflow

Fast audit of a single file or rule set.

## Input

User provides either:
- A file path to audit
- A block of rules/instructions to evaluate
- "check this file" with a file already in context

## Steps

### 1. Read the target

If a file path, read it. If inline, use the provided text.

### 2. Apply the Five Questions

For each rule/instruction found, evaluate against the five questions from SKILL.md. Focus on:
- Is this restating Claude's default behavior?
- Is this vague enough that it'll be interpreted differently each time?
- Does this look like it was added to fix one specific bad output?

### 3. Report

Concise output:

```
**File:** [path or "inline"]
**Rules found:** [count]
**Verdict:** [X] keep, [Y] cut, [Z] sharpen

### Cut
- [rule] — [reason]

### Sharpen
- [rule] — [how]

### Keep
- [rule] — [why]
```
