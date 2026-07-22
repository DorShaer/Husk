<!-- Fictitious example. "ApiBridge" is a teaching project name; any resemblance to real products or organizations is coincidental. The example.org domain is RFC 2606 reserved. -->
---
task: "Migrate ApiBridge public API from REST to GraphQL with deprecation runway"
slug: 20260112-091500_apibridge-rest-to-graphql-migration
project: ApiBridge
effort: deep
effort_source: explicit
phase: execute
progress: 23/72
mode: interactive
started: 2026-01-12T17:15:00Z
updated: 2026-04-22T03:48:00Z
---

## Problem

The ApiBridge public API at `api.apibridge.example.org` has accumulated 14 REST endpoints across 4 years of organic growth. Half of them are over-fetching (one read of `/orgs/:id` pulls 38 fields when the dashboard uses 6); the other half are under-fetching (rendering a single project page costs 6 sequential GETs because each related resource lives behind its own URL). External consumers — 47 known integrations across 12 partners — repeatedly hit the same N+1 patterns and route around them with caching that's now stale more often than fresh. Internally, every new product surface argues over which existing endpoint to bend versus which new one to add, and the answer is usually "add another," which makes the surface worse.

A GraphQL endpoint at `api.apibridge.example.org/graphql` lets clients ask for exactly the fields they need in one round trip. The migration is hard because the 47 integrations cannot break — partners will move at their own pace, and at least three of them publish quarterly release trains. The goal is not "GraphQL replaces REST tomorrow." The goal is "GraphQL is preferred, REST is supported for six months with clear deprecation telemetry, and at the end of the window every active consumer has either migrated or is opted into a paid extended-support track."

## Vision

A partner integration team opens our docs, sees a single GraphQL playground next to a dimmed REST reference labeled "deprecated April 2026 → October 2026," runs three example queries, and realizes their nightly sync that takes 14 round trips can become one. They migrate their staging environment in an afternoon. Six months later, our REST egress drops to under 2% of total API traffic, and the cutover ships without a single Sev-2.

## Out of Scope

- Internal service-to-service traffic. Internal callers continue using gRPC; this migration is for the public boundary only.
- GraphQL subscriptions. Pub/sub realtime is a separate roadmap item; v1 is queries and mutations only.
- Schema federation. We expose one monolithic GraphQL schema; we are not introducing Apollo Federation, schema stitching, or a gateway tier in this migration.
- Authentication redesign. Existing OAuth 2.0 bearer tokens are reused unchanged; no migration to mTLS, no new scopes, no re-issuing keys.
- Webhook redesign. Webhook payloads remain JSON-shaped per existing contracts; this migration does not touch outbound delivery.
- Self-service partner portal. Partners continue to be onboarded by the partnerships team; no portal changes ship as part of this work.

## Principles

- **Public APIs are contracts, not implementations.** A consumer cannot tell us "we'll fix it next quarter" and have us break their build before that quarter ends. Migration windows must respect external release cadence.
- **Deprecation is a product, not an event.** The deprecation experience — telemetry, sunset headers, dashboard, partner emails, escalation paths — is itself a feature with its own ISCs.
- **Every breaking change has a non-breaking adapter.** If GraphQL cannot serve a REST shape verbatim, we add a thin REST→GraphQL adapter rather than asking the partner to change shape immediately.
- **Performance is part of the contract.** GraphQL must not be slower than REST for equivalent queries at p95. Latency regressions are bugs.
- **Schema is owned by product, not by transport.** The shape of `Project`, `Organization`, `User` lives in one place and is consumed by both REST adapters and GraphQL resolvers; we do not duplicate types.

## Constraints

- The current REST API at `api.apibridge.example.org/v1/*` continues to return correct, byte-identical responses for the entire 6-month deprecation window (April 22, 2026 → October 22, 2026). No silent shape changes.
- GraphQL endpoint exposed at `api.apibridge.example.org/graphql` only. No `/v2`, no subdomain split, no separate hostname.
- Apollo Server v4+ on Node 20 LTS. We do not roll a custom GraphQL implementation. We do not pin to v3.
- Schema-first development with codegen. The SDL file at `schema/api.graphql` is the source of truth; resolvers are generated, not hand-written from scratch.
- Every breaking change ships behind a feature flag with a default-off rollout managed by the existing LaunchDarkly account.
- Sunset headers (`Sunset`, `Deprecation`, `Link`) are emitted on every REST response per RFC 8594 throughout the deprecation window. No exceptions.
- The migration ships in 4 increments (schema → resolvers → REST adapter layer → deprecation telemetry); no big-bang cutover.
- Documentation site at `docs.apibridge.example.org` must show GraphQL and REST side-by-side for the entire window; "REST docs deleted" is not an option until October 22, 2026.

## Goal

Ship the GraphQL endpoint at `api.apibridge.example.org/graphql` with full coverage of the 14 REST endpoints' read and write surface area, parity-tested under load, with a published 6-month deprecation runway for REST that emits RFC 8594 sunset headers, exposes per-partner deprecation telemetry on an internal dashboard, and lands the cutover without any external integration breaking before its partner-confirmed migration date.

## Criteria

- [x] ISC-1: `schema/api.graphql` exists, validates against `graphql-schema-linter`, and covers all 14 REST endpoint shapes.
- [x] ISC-2: GraphQL endpoint responds with `200` and a valid introspection result for `query { __schema { queryType { name } } }`.
- [x] ISC-3: All 14 REST endpoints have a corresponding query or mutation in the schema (probe: `node scripts/coverage-check.ts` exits 0).
- [x] ISC-4: Schema codegen produces typed resolver stubs at `src/generated/resolvers.ts`.
- [x] ISC-5: 100% of read-side resolvers return data byte-identical to the matching REST endpoint for a 1,000-row golden fixture (probe: `bun test parity/read.test.ts`).
- [ ] ISC-6: 100% of write-side resolvers produce identical database side-effects to the matching REST mutation for the golden fixture (probe: `bun test parity/write.test.ts`).
- [x] ISC-7: GraphQL p95 latency for the 5 most common query shapes is ≤ matching REST p95 + 10ms under 200 rps load.
- [ ] ISC-7.1: GraphQL p95 latency for the 20 next-most-common query shapes is ≤ matching REST p95 + 25ms under 200 rps load.
- [ ] ISC-8: GraphQL p99 latency under 1000 rps load remains under 800ms.
- [x] ISC-9: REST responses include `Sunset: Wed, 22 Oct 2026 00:00:00 GMT` header.
- [x] ISC-10: REST responses include `Deprecation: true` header.
- [x] ISC-11: REST responses include `Link: <https://docs.apibridge.example.org/graphql>; rel="successor-version"`.
- [ ] ISC-12: Per-partner deprecation telemetry dashboard at `internal.apibridge.example.org/deprecation` shows REST request count, GraphQL request count, and migration percentage by partner ID.
- [ ] ISC-13: Dashboard shows the 5 most-called deprecated REST endpoints by partner.
- [ ] ISC-14: Dashboard alerts fire when any partner's REST traffic increases week-over-week after April 22, 2026.
- [x] ISC-15: All 47 known integrations are tagged with a `partner_id` in request logs.
- [ ] ISC-16: Migration emails sent to partner technical contacts at T-90, T-60, T-30, T-14, T-7, T-1 days from cutover.
- [x] ISC-17: GraphQL playground at `api.apibridge.example.org/graphql` loads in a browser with example queries pre-populated.
- [x] ISC-18: Documentation site shows GraphQL and REST side-by-side for every endpoint.
- [ ] ISC-19: Anti: REST endpoints return shape-changed responses during the deprecation window (probe: `bun test parity/rest-stability.test.ts` runs daily).
- [ ] ISC-20: Anti: GraphQL endpoint accepts queries deeper than 8 levels (probe: depth-limit middleware blocks query at depth 9 with `400`).
- [ ] ISC-21: Anti: GraphQL endpoint accepts queries with cost > 1000 (probe: cost analysis middleware blocks high-cost query with `400`).
- [ ] ISC-22: Anti: introspection is enabled in production (probe: `query { __schema { types { name } } }` returns `403` against `api.apibridge.example.org/graphql` with non-admin token).
- [ ] ISC-23: Anti: any partner is silently cut off (probe: cutover script requires partner-confirmed migration date in `partner-status.json` for every active partner_id).
- [x] ISC-24: Feature flag `graphql_endpoint_enabled` defaults to `false` and is explicitly enabled per environment.
- [x] ISC-25: Feature flag `rest_sunset_headers_enabled` defaults to `false` until April 22, 2026.
- [ ] ISC-26: Rollback runbook at `docs/runbooks/graphql-rollback.md` exists and has been dry-run executed in staging.
- [x] ISC-27: Schema changes go through PR review with at least one API-team approver (probe: `.github/CODEOWNERS` lists `schema/` under `@api-team`).
- [x] ISC-28: Every resolver has a Datadog APM span tagged with `graphql.operation_name` and `graphql.field_name`.
- [ ] ISC-29: Authorization middleware enforces the same scopes on GraphQL fields as the matching REST endpoint requires (probe: `bun test auth/scope-parity.test.ts`).
- [ ] ISC-30: Rate limits applied per partner at the GraphQL layer match the REST layer (probe: `bun test rate-limit/parity.test.ts`).
- [ ] ISC-31: Error responses follow the structured GraphQL error spec with `extensions.code` set per error class.
- [x] ISC-32: REST request logs include `Accept-Migration` header value when partner sends it (used to track partners actively testing GraphQL).
- [ ] ISC-33: Partner status file `partner-status.json` lists every `partner_id` with fields `confirmed_migration_date`, `last_rest_request`, `first_graphql_request`, `migration_pct`.
- [ ] ISC-34: Status file is regenerated nightly from request logs.
- [ ] ISC-35: Partner support runbook at `docs/runbooks/partner-migration-support.md` covers the top 10 expected migration questions with copy-paste GraphQL equivalents.
- [ ] ISC-36: Public changelog entry posted at `docs.apibridge.example.org/changelog` announcing GraphQL availability with example queries.
- [ ] ISC-37: Public changelog entry posted announcing REST deprecation with sunset date.
- [x] ISC-38: GraphQL schema is published at `schema.apibridge.example.org/api.graphql` for tooling consumption.
- [ ] ISC-39: Schema diff CI gate fails the build if a breaking schema change is introduced without `BREAKING_CHANGE_APPROVED=true` env flag.
- [x] ISC-40: Resolvers reuse the existing data-access layer (no duplicate query logic between REST handlers and GraphQL resolvers).
- [ ] ISC-41: Load test simulating partner-realistic query patterns (mix of 60% reads, 30% writes, 10% complex nested queries) sustains 500 rps for 1 hour without error rate exceeding 0.5%.
- [x] ISC-42: GraphQL endpoint enforces request body size limit of 100KB.
- [x] ISC-43: GraphQL endpoint enforces query timeout of 10 seconds at the resolver layer.
- [ ] ISC-44: Anti: REST endpoint `/v1/orgs/:id/projects` returns 404 before October 22, 2026 (probe: synthetic monitor pings every 5 minutes).
- [ ] ISC-45: Anti: any GraphQL field returns PII not present in the matching REST endpoint (probe: `bun test parity/pii-coverage.test.ts`).
- [ ] ISC-46: Cutover dry-run executed at T-30 against staging with all 47 partner integrations simulated.
- [ ] ISC-47: Sentry release tag `graphql-cutover-v1` exists.
- [ ] ISC-48: PagerDuty escalation policy `graphql-launch` is on-call rotation for the 2 weeks following October 22, 2026.
- [x] ISC-49: GraphQL endpoint logs include `partner_id` extracted from the bearer token claim.
- [x] ISC-50: REST adapter layer at `src/rest/adapter.ts` translates REST routes to internal GraphQL execution (single resolver path, two transports).
- [ ] ISC-51: Adapter layer adds < 5ms p95 overhead vs. direct REST handler.
- [x] ISC-52: All 14 REST routes are now served by the adapter (legacy direct handlers deleted).
- [ ] ISC-53: Adapter is feature-flagged by `rest_via_adapter_enabled` and rolled out in 10% increments.
- [ ] ISC-54: Adapter rollout reaches 100% before deprecation telemetry begins (April 22, 2026).
- [ ] ISC-55: Migration retrospective document at `docs/retrospectives/graphql-migration.md` written by November 1, 2026.
- [x] ISC-56: GraphQL gateway has a circuit breaker that opens when downstream data layer error rate exceeds 5% over 60s.
- [ ] ISC-57: Circuit-breaker behavior documented in incident response runbook.
- [x] ISC-58: Persisted queries are supported via APQ (Automatic Persisted Queries) for partners that opt in.
- [ ] ISC-59: At least 3 partners using APQ in production by October 1, 2026.
- [ ] ISC-60: GraphQL access logs are retained for 90 days in the existing log retention bucket.
- [ ] ISC-61: Audit log for schema changes is queryable via `bun scripts/schema-history.ts`.
- [x] ISC-62: Anti: a single resolver makes more than 3 sequential database calls without batching via DataLoader (probe: lint rule `no-sequential-db-calls` runs in CI).
- [x] ISC-63: DataLoader instances are created per-request, not per-process (probe: `bun test dataloader/scope.test.ts`).
- [ ] ISC-64: Schema documentation generated from SDL comments and published to docs site.
- [ ] ISC-65: Partner-specific cost limits enforced (cost ≤ 500 for free tier, cost ≤ 2000 for paid tier, cost ≤ 5000 for enterprise tier).
- [x] ISC-66: GraphQL errors are scrubbed of internal stack traces in production responses.
- [ ] ISC-67: External health check at `api.apibridge.example.org/graphql/health` returns `200` with schema version.
- [ ] ISC-68: Anti: deprecation cutover proceeds with any partner still showing > 100 REST requests/day in the 7 days before cutover (probe: cutover script blocks).
- [ ] ISC-69: Extended support contract template exists at `legal/extended-rest-support-template.md` for partners needing a paid runway past October 22, 2026.
- [ ] ISC-70: At most 3 partners are on extended support after October 22, 2026.
- [ ] ISC-71: Public status page at `status.apibridge.example.org` has a `graphql` component and a `rest` component, each with independent uptime SLOs.
- [ ] ISC-72: Final cutover postmortem published to docs site within 14 days of October 22, 2026.

## Test Strategy

```yaml
- isc: ISC-3
  type: coverage-probe
  check: every REST endpoint maps to a GraphQL field
  threshold: 14/14
  tool: node scripts/coverage-check.ts

- isc: ISC-5
  type: parity-test
  check: GraphQL response body byte-equal to REST response for 1000 fixtures
  threshold: 1000/1000
  tool: bun test parity/read.test.ts

- isc: ISC-7
  type: load
  check: GraphQL p95 vs REST p95 for top-5 query shapes
  threshold: GraphQL p95 ≤ REST p95 + 10ms at 200 rps
  tool: k6 run loadtests/p95-parity.js

- isc: ISC-9
  type: header-probe
  check: every REST 2xx response includes Sunset header
  threshold: 100% of sampled responses
  tool: synthetic monitor + grep

- isc: ISC-19
  type: regression-probe
  check: REST shape diff vs frozen golden bodies
  threshold: zero diffs
  tool: bun test parity/rest-stability.test.ts (daily cron)

- isc: ISC-20
  type: anti-probe
  check: depth-limit middleware blocks deep queries
  threshold: 400 response on depth=9
  tool: curl + jq

- isc: ISC-22
  type: anti-probe
  check: introspection disabled in production
  threshold: 403 on __schema query with non-admin token
  tool: bun test security/introspection.test.ts

- isc: ISC-23
  type: anti-probe
  check: cutover requires partner confirmation
  threshold: cutover.ts exits non-zero if any active partner_id missing confirmed_migration_date
  tool: bun scripts/cutover.ts --dry-run

- isc: ISC-41
  type: load
  check: 1-hour soak at 500 rps mixed workload
  threshold: error rate < 0.5%
  tool: k6 run loadtests/soak.js
```

## Features

```yaml
- name: SchemaAndCodegen
  description: Define `schema/api.graphql` covering all 14 endpoint shapes; wire up codegen for typed resolver stubs at `src/generated/resolvers.ts`.
  satisfies: [ISC-1, ISC-2, ISC-3, ISC-4, ISC-27, ISC-38, ISC-39, ISC-64]
  depends_on: []
  parallelizable: false

- name: ResolverImplementation
  description: Implement read and write resolvers backed by the existing data-access layer; ensure parity with REST responses; enforce auth scopes; per-request DataLoader.
  satisfies: [ISC-5, ISC-6, ISC-29, ISC-31, ISC-40, ISC-49, ISC-62, ISC-63, ISC-66]
  depends_on: [SchemaAndCodegen]
  parallelizable: true  # split by resource group: orgs/projects/users/billing/audit

- name: GatewayHardening
  description: Apollo Server config, depth limit, cost analysis, request size limit, query timeout, circuit breaker, persisted queries, error scrubbing, introspection lock-down.
  satisfies: [ISC-20, ISC-21, ISC-22, ISC-30, ISC-42, ISC-43, ISC-56, ISC-58, ISC-65]
  depends_on: [ResolverImplementation]
  parallelizable: true

- name: RestAdapter
  description: Build `src/rest/adapter.ts` so the 14 REST routes execute through GraphQL resolvers; flag-rolled to 100% before deprecation telemetry begins; preserves REST byte-shape.
  satisfies: [ISC-19, ISC-50, ISC-51, ISC-52, ISC-53, ISC-54]
  depends_on: [ResolverImplementation]
  parallelizable: false

- name: DeprecationTelemetry
  description: Sunset/Deprecation/Link headers, partner_id tagging, internal dashboard, weekly partner status emails, alerting on REST traffic regression, partner-status.json nightly regen.
  satisfies: [ISC-9, ISC-10, ISC-11, ISC-12, ISC-13, ISC-14, ISC-15, ISC-16, ISC-25, ISC-32, ISC-33, ISC-34]
  depends_on: [RestAdapter]
  parallelizable: true

- name: DocsAndPlayground
  description: GraphQL playground at the live endpoint with pre-populated examples; side-by-side REST/GraphQL docs; public changelog entries; published SDL.
  satisfies: [ISC-17, ISC-18, ISC-36, ISC-37]
  depends_on: [SchemaAndCodegen]
  parallelizable: true

- name: CutoverGovernance
  description: Per-partner confirmed_migration_date tracking, T-90/60/30/14/7/1 emails, dry-run at T-30, runbooks, status page components, postmortem.
  satisfies: [ISC-23, ISC-26, ISC-35, ISC-44, ISC-46, ISC-47, ISC-48, ISC-55, ISC-57, ISC-67, ISC-68, ISC-69, ISC-70, ISC-71, ISC-72]
  depends_on: [DeprecationTelemetry]
  parallelizable: false
```

## Decisions

- 2026-01-12 17:15: Apollo Server v4 over Yoga or a hand-rolled implementation. Existing team familiarity, mature plugin ecosystem, schema-first defaults. Yoga rejected because the persisted-query story is less mature for partners on legacy SDKs.
- 2026-01-19 22:00: Schema-first with codegen rather than code-first. The SDL is the contract the partners read; making it the source of truth means PR diffs on `schema/api.graphql` are reviewable as contract changes by people who don't read TypeScript.
- 2026-01-26 14:30: REST adapter layer (one resolver path, two transports) rather than maintaining REST handlers in parallel. Eliminates parity drift by construction. Cost: adapter overhead measured at ~3ms p95 in early prototype, well under the ISC-51 budget of 5ms.
- 2026-02-03 11:00: ❌ DEAD END: Tried Apollo Federation v2 to split the schema across 3 services owned by different product teams. Reverted after week-long spike — gateway introspection added 40ms p95 overhead and the team boundary was nominal (all 3 services share the same database). Single monolithic schema, owned by api-team, reviewed by product-team approvers per CODEOWNERS.
- 2026-02-10 09:45: 6-month deprecation window over 3 months. Partner survey (37 of 47 responded) showed 4 partners with quarterly release trains where a 3-month window would force an emergency rollout. Cost is real (longer parity guarantees, more telemetry overhead) but cheaper than 4 angry partners.
- 2026-02-18 16:20: refined: ISC-7 split into ISC-7 (top-5 query shapes, +10ms budget) and ISC-7.1 (next-20 shapes, +25ms budget). The two budgets reflect that the top-5 are tightly optimized REST paths while the next-20 are over-fetching today and GraphQL will already be faster on those by virtue of asking for fewer fields.
- 2026-02-25 21:00: ❌ DEAD END: Considered exposing GraphQL at `api-v2.apibridge.example.org` so the cutover would be a DNS swap. Rejected — partner integrations using URL-based service discovery would have to change config rather than client library, and the URL change would have meant more breaking surface than the protocol change.
- 2026-03-04 10:00: APQ for partners that opt in, not mandatory. Mandatory APQ would force every partner to ship a registration step before going live; the migration cost is already non-trivial and APQ value is largest for the high-volume partners who will adopt it voluntarily.
- 2026-03-12 13:30: Cost limits per partner tier (500/2000/5000) calibrated against the most expensive REST endpoints' equivalent cost in the cost-analysis prototype; free-tier cap of 500 is ~2x the heaviest current REST call to leave migration headroom without leaving DoS surface.
- 2026-03-21 17:00: refined: added ISC-44 (synthetic monitor on deprecated endpoint pre-cutover) after partner-success team flagged that "deprecated" and "removed" had been conflated in two earlier migrations.
- 2026-04-08 09:30: Extended-support track capped at 3 partners (ISC-70). Operational cost of running parallel REST infrastructure past cutover scales worse than linearly; 3 is the threshold where a separate small REST cluster makes sense vs. ad-hoc bypass.
- 2026-04-15 22:15: refined: ISC-23 (anti: silent cutoff) hardened — the cutover script now reads `partner-status.json` and exits non-zero if any active partner_id is missing `confirmed_migration_date`. Earlier draft only logged a warning; partner-success caught a near-miss in dry-run where a newly added partner would have been cut off because the field was absent rather than false.

## Changelog

- 2026-02-18 conjectured: a single +10ms p95 budget would cover all GraphQL query shapes vs REST. / refuted by: prototype load test (k6, 200 rps) showed top-5 already at +8ms while shapes 6-25 ranged +12ms to +22ms — single budget would fail on hot paths and over-budget on long-tail. / learned: REST is irregularly optimized; the top-5 shapes have hand-tuned indexes, the rest don't. GraphQL inherits this asymmetry. / criterion now: ISC-7 (top-5, +10ms) + ISC-7.1 (next-20, +25ms) — two budgets reflecting the underlying optimization asymmetry.

- 2026-02-25 conjectured: a `/v2` URL split would make cutover a clean DNS-level swap with no client code changes. / refuted by: partner survey identified 11 integrations using URL-based service discovery (env vars or config files); URL change would force config-file edits and re-deploy, while protocol change touches only the client library. / learned: URL stability is a stronger contract than transport stability for service-discovery-based partners. / criterion now: GraphQL co-located at `api.apibridge.example.org/graphql`; no `/v2`, no subdomain split — preserved as a Constraint.

- 2026-03-21 conjectured: the deprecation-window guarantee that "REST endpoints continue working" was sufficient. / refuted by: partner-success team review found that "endpoint working" had been ambiguously interpreted in two earlier minor-version cutovers — partners read it as "still routable," ops read it as "still serving the documented payload." / learned: the deprecation contract has to specify byte-shape stability AND endpoint reachability, separately, with separate probes. / criterion now: ISC-19 (Anti: REST shape changes) plus ISC-44 (Anti: REST endpoint returns 404 before cutover) — two probes, daily cadence, separate failure modes.

- 2026-04-15 conjectured: cutover script logging a warning when a partner_id was missing `confirmed_migration_date` was sufficient governance. / refuted by: dry-run revealed a newly onboarded partner whose record had been created without the field; warning was lost in normal log volume and the script proceeded. / learned: governance gates must hard-fail; partial enforcement of a binary anti-criterion is no enforcement. / criterion now: ISC-23 hardened — cutover script exits non-zero on missing field; partner-success owns the field-presence check in onboarding.

## Verification

- ISC-1: `graphql-schema-linter schema/api.graphql` exits 0; output `0 errors, 0 warnings`. Verified 2026-02-04.
- ISC-2: `curl -s -X POST api.apibridge.example.org/graphql -H "Authorization: Bearer $T" -d '{"query":"{ __schema { queryType { name } } }"}' | jq -r '.data.__schema.queryType.name'` returns `Query`. Verified 2026-02-12 (staging) and 2026-03-04 (production behind feature flag).
- ISC-3: `node scripts/coverage-check.ts` outputs `14/14 REST endpoints have a matching GraphQL field`. Verified 2026-02-15.
- ISC-5: `bun test parity/read.test.ts` reports `1000 passed, 0 failed`. Verified 2026-03-08.
- ISC-7: k6 run output for top-5 query shapes — REST p95: 87ms / GraphQL p95: 91ms (+4ms, well within +10ms budget). Verified 2026-03-22.
- ISC-9, ISC-10, ISC-11: `curl -I api.apibridge.example.org/v1/orgs/test-org` shows `Sunset: Wed, 22 Oct 2026 00:00:00 GMT`, `Deprecation: true`, `Link: <https://docs.apibridge.example.org/graphql>; rel="successor-version"`. Verified 2026-04-22.
- ISC-22: introspection probe with non-admin token returns `403 Forbidden` with body `{"errors":[{"message":"Introspection disabled in production","extensions":{"code":"INTROSPECTION_DISABLED"}}]}`. Verified 2026-03-04.
- ISC-50, ISC-52: `git log --oneline src/rest/handlers/` shows final commit deleting all 14 legacy direct handlers; `src/rest/adapter.ts` is the sole REST entry point. Verified 2026-04-10.
