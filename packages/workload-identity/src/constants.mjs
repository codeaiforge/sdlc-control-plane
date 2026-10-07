// The reviewed constants of ADR-0003. Every value here is a literal changed only by a reviewed
// commit, never an environment variable: a tunable issuer, audience or limit is a second policy
// surface with no review path, no approval record and no tier (ADR-0003 › Issuer; the threat
// model's reasoning for the body limit). constants.test.mjs pins every value and fails if any
// non-test module in this package reads the environment at all.
//
// This package imports nothing from the workspace. The issuer therefore appears twice: here as
// ISSUER, which step 4 compares `iss` against, and in packages/contracts as the one member of
// ACCEPTED_ISSUERS, which the registry checks a registration against. control-plane-api refuses
// to start unless the two agree (assertIssuerAgreement in main.mjs), so the copy is held by a
// check rather than by prose.

// Byte-equal, no trailing slash: the discovery document's `issuer` [ADR-0003 S1].
export const ISSUER = 'https://token.actions.githubusercontent.com';
// The discovery document's `jwks_uri` [S1]. Discovery is never fetched at runtime.
export const JWKS_URI = 'https://token.actions.githubusercontent.com/.well-known/jwks';
// urn:codeaiforge:sdlc-control-plane:<deployment-id>; the MVP names one deployment.
export const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';

// Refused whatever their event and whatever a registration admits (ADR-0003 › Workload
// contexts). Canonical decimal strings, compared with the string claim by equality: a number
// would never equal the claim and the refusal would fail open.
//
// UNMEASURED. '49699333' is the `dependabot[bot]` account ID GitHub's REST API reports
// (ADR-0003 [S14]). That a Dependabot-triggered run's `actor_id` claim carries it is unverified;
// the founder's gate decision Q-2 (2026-10-07) records it unmeasured, and task 3.1 measures it.
export const REFUSED_ACTOR_IDS = Object.freeze(['49699333']);

// An array and Array.prototype.includes, not a Set: Object.freeze does not freeze a Set's
// contents, so a frozen Set could still be extended at runtime.
export const isRefusedActor = (actorId) => REFUSED_ACTOR_IDS.includes(actorId);

// Token lifetime (ADR-0003 › Token lifetime and replay).
export const CLOCK_SKEW_S = 60;
export const MAX_LIFETIME_S = 900;

// Token header (ADR-0003 › Credential transport, Keys and rotation).
export const MAX_TOKEN_BYTES = 8192;
export const MAX_KID_LENGTH = 256;

// The key-set fetch and cache (ADR-0003 › Keys and rotation).
export const JWKS_TIMEOUT_MS = 5000;
export const JWKS_MAX_BYTES = 65536;
export const JWKS_MIN_TTL_S = 60;
export const JWKS_MAX_TTL_S = 3600;
export const JWKS_MIN_FETCH_INTERVAL_MS = 60000;
