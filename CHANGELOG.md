# Changelog

Releases are tagged per component, `<component>/vX.Y.Z`, with semantic versioning
([.ai/standards/release.md](.ai/standards/release.md)). Only the evidence adapter is
released so far; the control-plane service has no release and no deployment.

## evidence-adapter/v0.1.0 — 2026-11-15

Pre-release. No control-plane endpoint is configured, so every run exits 2 and submits nothing.

### Added

- Reusable workflow `.github/workflows/submit-evidence.yml`. A workspace calls it cross-repository
  at this tag, as its own job after the gate (`needs:` plus `if: ${{ !cancelled() }}`), with
  `id-token: write` and `contents: read`. It takes no inputs and no secrets.
- `packages/evidence-adapter`: reads the gate's `sdlc-controls-evidence` artifact and posts the
  record unchanged. It mints a fresh GitHub OIDC token for every attempt, for the audience
  `urn:codeaiforge:sdlc-control-plane:production` (ADR-0003), and never prints the token.
  Retries cover 502, 503 and 504 only: 4 attempts within 150 s.
- Exit codes: 0 accepted (202 with a decision); 1 not accepted (422); 2 local refusal; 3 no
  record (the job passes, because the gate's job has already failed); 4 refused by the control
  plane, or an answer the adapter does not handle; 5 no answer within the retry budget.

### Known limitations

- Runs on github.com only, and should run on GitHub-hosted runners only. The job does not
  check what kind of runner it is on (threat model RR-14).
- The token claims of fork and Dependabot runs have not been measured yet, and no workspace is
  registered yet (task 3.3).
- Actions are pinned by SHA at checkout v6.1.0, setup-node v6.5.0 and download-artifact
  v6.0.0. The move to v7/v8 is task 3.3.
- The change id is per run, so indicators count gate runs, not changes (RR-15).

Record: [.ai/sprints/sprint-3/tasks/3.1.md](.ai/sprints/sprint-3/tasks/3.1.md).
