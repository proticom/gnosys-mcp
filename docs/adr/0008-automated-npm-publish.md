# ADR-0008: Automated npm Publish via OIDC Trusted Publishing

- Status: Accepted
- Date: 2026-04-05
- Memory: deci-033

## Context

Releasing Gnosys to npm required a repeatable, low-friction publish path without storing long-lived NPM tokens in GitHub secrets. Manual `npm publish` with OTP does not scale for frequent patch releases.

## Decision

Publishing is fully automated: bump version (`npm version patch`), build, commit, push tags — GitHub Actions on `v*` tags publishes to npm via OIDC trusted publishing. No `NPM_TOKEN`, no manual publish step.

## Consequences

- Releases are tag-driven and reproducible; provenance attestation is handled by trusted publishing automatically.
- Workflow must use Node 24+ (npm v11 OIDC support); Node 22 fails with misleading 404 errors.
- `setup-node` must not set `registry-url` or `NODE_AUTH_TOKEN` — either overrides OIDC auth.
- Post-publish, users upgrade with `npm install -g gnosys@latest` and `gnosys upgrade` to sync projects.
- Removing secrets from CI reduces credential leak risk compared to stored npm tokens.
