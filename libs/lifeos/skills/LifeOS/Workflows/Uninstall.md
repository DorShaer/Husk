# Uninstall — clean, manifest-keyed removal

Removes what LifeOS installed, and ONLY what LifeOS installed. Leaves the user's data and any foreign hooks untouched.

## Voice notification (first action)

```bash
curl -s -X POST http://localhost:31337/notify -H "Content-Type: application/json" \
  -d '{"message": "Running the Uninstall workflow in the LifeOS skill to remove LifeOS"}' > /dev/null 2>&1 &
```

## Steps

1. **DetectEnv** — `bun Tools/DetectEnv.ts`. If `isDevTree` → STOP. Uninstall never runs against the source repo.
2. **Confirm intent** — show exactly what will be removed (hook entries, system files, the LifeOS skill) and what will be KEPT (the user's config tree, their TELOS, their data). Wait for explicit confirmation.
3. **Manifest-keyed hook removal** — read `install/hooks/hooks.json`; remove ONLY settings.json entries whose command matches a shipped hook path. Leave every foreign entry in shared matcher buckets intact. Restore from the `settings.json` backup if one is present and the user prefers.
4. **Remove system files** — the LifeOS-owned system templates and copied hook files. Never the user config tree.
5. **Keep user data** — the config tree (identity, TELOS, memory) stays by default. Offer an explicit, separate, confirmed step to also remove it — opt-in only, never bundled.
6. **Report** — list what was removed and what was kept, with the backup path.

## Rule
Default-keep on anything the user authored. Uninstall is reversible up to the point of data deletion, which is always a separate explicit choice.
