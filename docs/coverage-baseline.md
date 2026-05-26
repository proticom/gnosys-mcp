# Coverage Baseline

Last updated: 2026-05-26 (post follow-up tasks CC.1–CC.4)

## Source

Generated via `npm run test:coverage` in `gnosys-public/`. Run output cached at `/tmp/cc5-coverage.log`.

## C.1 Target Files (≥80% lines required)

| File | C.1 Baseline | Post-CC.4 | Δ Lines |
|---|---|---|---|
| `mcpHttp.ts` | 89% | 92.42% | +3.42 |
| `ingest.ts` | 17% | 100% | +83 |
| `dream.ts` | 29% | 95.42% | +66.42 |
| `remote.ts` | 74% | 80.61% | +6.61 |
| `db.ts` | 77% | 88.47% | +11.47 |

All 5 files meet the ≥80% lines gate.

## Detail (post-CC.4 vitest v8 report, re-verified CC.5)

| File | % Stmts | % Branch | % Funcs | % Lines |
|---|---|---|---|---|
| `mcpHttp.ts` | 89.11 | 77.27 | 87.5 | 92.42 |
| `ingest.ts` | 100 | 91.93 | 100 | 100 |
| `dream.ts` | 91.68 | 78.04 | 95 | 95.42 |
| `remote.ts` | 80.83 | 75 | 95.65 | 80.61 |
| `db.ts` | 85.06 | 78.07 | 92.3 | 88.47 |

## Overall

| Metric | % |
|---|---|
| Statements | 63.41 |
| Branches | 54.91 |
| Functions | 70.79 |
| Lines | 65.02 |

## Follow-up tasks that produced these numbers

- **CC.1** — added `src/test/ingest-structured.test.ts` (21 tests) — ingest.ts 17% → 100%.
- **CC.2** — added `src/test/dream-coverage.test.ts` (29 tests) — dream.ts 29% → 95.42%.
- **CC.3** — added `src/test/remote-coverage.test.ts` (28 tests) — remote.ts 74% → 80.61%.
- **CC.4** — added `src/test/db-coverage.test.ts` (14 tests) — db.ts 81.26% → 88.47%.
