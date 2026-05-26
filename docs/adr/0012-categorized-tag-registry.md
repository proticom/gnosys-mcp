# ADR-0012: Categorized Tag Registry

- Status: Accepted
- Date: 2026-03-04
- Memory: dec-006

## Context

Tags drive manifest routing (LLM relevance), contradiction detection, and lens filtering in Gnosys. Fully freeform tags produce inconsistent vocabulary across ingestion sessions. A rigid controlled vocabulary kills adoption when the registry cannot grow. We need a middle path that keeps tags structured without blocking new concepts.

## Decision

Tags are managed via a categorized registry in `.gnosys/tags.yml`. Tags belong to named categories (`domain`, `type`, `concern`, `status-tag`). The ingestion LLM must prefer registry tags but may propose new ones; the user approves before they are added. Directory categories (`architecture/`, `decisions/`) remain orthogonal to tags — a file's folder is its human browsability home; tags are its semantic reach for machine routing.

## Consequences

- Lenses can filter precisely (e.g., `domain:auth`) instead of fuzzy-matching across tag types.
- New tags require explicit user approval, preventing silent vocabulary sprawl.
- Contradiction detection gains reliable overlap signals from categorized tags.
- Each project maintains its own registry; tags are not global unless synced via the central brain.
- Trade-off: ingestion adds a confirmation step when proposing new tags, which is intentional friction.
