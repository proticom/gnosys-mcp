# ADR-0011: README Positioning — No Competitor Comparisons

- Status: Accepted
- Date: 2026-05-25
- Memory: deci-01KSGRQ4GEGPHJQMYDD3V2XCWK

## Context

The npm README is the first surface many developers see, but Gnosys also maintains gnosys.ai as the canonical documentation site. Duplicating marketing content, feature matrices, or competitor comparisons across both surfaces creates maintenance drift. Gnosys is free and open-source; positioning should emphasize what it does, not how it ranks against alternatives.

## Decision

Do not add a "Why Gnosys vs alternatives" competitor-comparison section to the README or npm page. Keep the README minimal: install instructions, quick start, and a redirect to [gnosys.ai](https://gnosys.ai) as the source of truth for detailed docs, positioning, and reference material. When marketing or positioning content is considered for the README, defer to the website instead.

## Consequences

- One place to update positioning (gnosys.ai); the README stays stable and scannable.
- npm package page avoids stale comparison tables as the landscape shifts.
- Contributors find deep docs on the site; the repo README stays focused on running and contributing.
- Trade-off: npm browsers see less marketing copy, which is acceptable given the site redirect.
