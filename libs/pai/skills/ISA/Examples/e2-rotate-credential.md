<!-- Fictitious example. The CI pipeline and credential surfaces here are teaching placeholders. -->

---
task: "Rotate the production deploy credential in the CI pipeline"
slug: 20260208-103000_rotate-deploy-credential
effort: extended
effort_source: explicit
phase: execute
progress: 0/16
mode: interactive
started: 2026-02-08T18:30:00Z
updated: 2026-02-08T18:30:00Z
---

## Problem

The production deploy credential (a long-lived API token stored in CI as `DEPLOY_API_TOKEN`) was provisioned 14 months ago, has never been rotated, and grants broad write scope on the deploy target. Per the org's quarterly rotation policy this is overdue. We need to rotate it without breaking the next deploy and without leaving the old token live longer than necessary.

## Goal

Rotate `DEPLOY_API_TOKEN` end-to-end: provision a new token with the same scope, update the CI secret, run a verification deploy on a non-production branch, then revoke the old token. The next production deploy after this rotation must succeed, and the old token must be inactive within four hours of the new one going live.

## Criteria

### Pre-rotation

- [ ] ISC-1: New token provisioned via the deploy target's API with scope `deploy:write` only — no broader scopes (probe: `curl -H "Authorization: Bearer $NEW_TOKEN" /v1/me` returns scopes `["deploy:write"]` exactly).
- [ ] ISC-2: New token expires in 90 days (probe: `curl /v1/tokens/<id>` shows `expires_at` ≤ 90 days from now).
- [ ] ISC-3: New token's `created_by` is the rotation runbook service account, not an individual user (probe: token metadata).

### CI update

- [ ] ISC-4: `DEPLOY_API_TOKEN` secret in the CI provider is updated to the new value (probe: `gh secret list --repo <org>/<repo>` shows updated `updated_at` within last 5 minutes).
- [ ] ISC-5: No commit, log line, or artifact contains the new token value as a string (probe: `gh run view <run-id> --log | rg "$(echo $NEW_TOKEN | head -c 8)" | wc -l` returns 0).

### Verification

- [ ] ISC-6: A test deploy on a `rotation-test` branch using the new token completes successfully (probe: deploy job exit 0, deploy target's API confirms new artifact registered).
- [ ] ISC-7: The verification deploy creates an artifact tagged `rotation-test-<timestamp>` that is removable post-verify (probe: `curl /v1/artifacts?tag=rotation-test` lists the artifact).
- [ ] ISC-8: Post-verify cleanup removes the test artifact within 60 minutes (probe: `curl /v1/artifacts/<id>` returns 404 after cleanup).

### Old token revocation

- [ ] ISC-9: Old token is revoked via the deploy target's API ≤ 4 hours after new token activation (probe: `curl /v1/tokens/<old-id>` returns `revoked_at` populated).
- [ ] ISC-10: A deploy attempt with the old token returns 401 within 60s of revocation (probe: `curl -H "Authorization: Bearer $OLD_TOKEN" /v1/deploys -X POST` returns 401).
- [ ] ISC-11: The revocation is logged in the org's auth audit log with actor, time, reason (probe: SIEM query for `token_revoked` event in last hour).

### Documentation

- [ ] ISC-12: `docs/runbooks/credential-rotation.md` is updated with the new token's ID and the rotation date.
- [ ] ISC-13: The next-rotation reminder is scheduled in the team calendar for `now + 90 days - 14 days` (early warning).

### Anti-criteria

- [ ] ISC-14: Anti: privacy — neither token value appears in any commit message, PR description, Slack/email message, or CI log (probe: `git log --all -S "$(echo $NEW_TOKEN | head -c 8)" --oneline` returns empty; same for old).
- [ ] ISC-15: Anti: scope creep — new token does NOT have `admin:write`, `users:write`, or any scope beyond `deploy:write` (probe: token metadata scope-list comparison).
- [ ] ISC-16: Anti: rollback safety — old token stays active for ≥ 30 minutes after new token deploys to verify, so a failed rotation can re-pin the old token (probe: timestamps on activation/revocation events show ≥ 30 min gap).

## Test Strategy

```yaml
- isc: ISC-1
  type: api-probe
  check: new token's scope list is exactly [deploy:write]
  threshold: scopes == ["deploy:write"]
  tool: curl -s -H "Authorization: Bearer $NEW_TOKEN" https://deploy.example.org/v1/me | jq -r '.scopes | sort | join(",")'

- isc: ISC-5
  type: log-grep
  check: new token value never appears in CI logs
  threshold: 0 matches
  tool: gh run view --log | rg "$(echo $NEW_TOKEN | head -c 8)"

- isc: ISC-6
  type: integration
  check: test deploy with new token succeeds
  threshold: exit 0
  tool: gh workflow run deploy.yml --ref rotation-test && wait-for-completion

- isc: ISC-10
  type: api-probe
  check: old token is rejected
  threshold: HTTP 401
  tool: curl -i -H "Authorization: Bearer $OLD_TOKEN" -X POST https://deploy.example.org/v1/deploys

- isc: ISC-14
  type: privacy
  check: neither token's first 8 chars appear in any tracked log/commit/artifact
  threshold: 0 matches across all surfaces
  tool: bash scripts/credential-leak-audit.sh

- isc: ISC-16
  type: timing
  check: gap between new-token-active and old-token-revoked ≥ 30 min
  threshold: ≥ 1800s
  tool: jq '.activated - .revoked' rotation-log.json
```

<!--
E2 ops ISA. Required sections: Problem, Goal, Criteria, Test Strategy.
Demonstrates the ISA primitive applied to an ops/runbook task — the same shape as a code task. ISC count of 16 hits the E2 floor exactly. Anti-criteria (ISC-14, 15, 16) cover privacy, scope, and rollback safety — typical ops-task regression-prevention concerns. Note ISC-16 explicitly preserves a safety window — a real-world lesson learned from prior bungled rotations.
-->
