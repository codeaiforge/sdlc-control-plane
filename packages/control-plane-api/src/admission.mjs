// Ingress admission limits (threat model › Ingress body limit; MIT-4). Every value is a literal
// changed by a reviewed commit, never an environment variable: a tunable limit is a second policy
// surface with no review path, no approval record and no tier.

// The threat model's byte cap, unchanged.
export const MAX_BODY_BYTES = 1048576;

// Headers stay under 16 KiB (Node's maxHeaderSize) even with an 8 KiB token, so 10 s is generous
// and a sixth of Node's 60 s default, enforced to within a second (the interval below).
export const HEADERS_TIMEOUT_MS = 10000;
// The whole request, first byte to last. 1 MiB in 30 s needs about 35 KiB/s sustained, and the
// window leaves room for a 5 s key-set fetch. Derived by arithmetic from the cap, not measured on
// a real link; Node's default is 300 s.
export const REQUEST_TIMEOUT_MS = 30000;
// Node does not time each socket: it checks every connection against the two timeouts above on
// one timer, every connectionsCheckingInterval, 30 s by default. A slow request is cut at the
// first check after its timeout, so at the default the headers could last 10-40 s and the request
// 30-60 s. At 1000 ms the residual is one second: cut by 11 s and 31 s at the latest.
export const CONNECTIONS_CHECKING_INTERVAL_MS = 1000;

// Per principal, per fixed window, PER PROCESS. The count lives in this process's memory: N
// processes admit 60·N submissions per principal per window, and a restart resets the window.
// At the 1 MiB cap that is up to 60 MiB a minute per principal into the evidence store. Task 2.2
// moved the store into PostgreSQL and kept this quota per process (RR-6, re-accepted; RR-10
// records the per-request read). It is not a service-wide rate limit and must not be read as one.
export const SUBMISSION_QUOTA = 60;
export const SUBMISSION_QUOTA_WINDOW_MS = 60000;

// A fixed window per key, opened by the key's first submission. Only authorized principals reach
// it (the seam checks it after step 6), so it holds at most one entry per registration.
export function createSubmissionQuota({ now = Date.now } = {}) {
  const windows = new Map();
  return {
    take(key) {
      const at = now();
      let window = windows.get(key);
      if (window === undefined || at - window.start >= SUBMISSION_QUOTA_WINDOW_MS) {
        window = { start: at, count: 0 };
        windows.set(key, window);
      }
      if (window.count >= SUBMISSION_QUOTA) {
        const remainingMs = window.start + SUBMISSION_QUOTA_WINDOW_MS - at;
        return { ok: false, retryAfterS: Math.max(1, Math.ceil(remainingMs / 1000)) };
      }
      window.count += 1;
      return { ok: true };
    },
  };
}

// The body, read under the cap. `content-length` is a fast path only: an honest oversized length
// is refused before a byte is read. The running count of received bytes is what makes the limit
// true, because a chunked request declares no length and a header that lies is not a measurement.
//
// The cap is enforced inline and signalled by a return value, never by a throw: the seam answers
// any throw in this span with 400, which would turn a 413 into the wrong status silently.
//
// The iterator is driven by hand and never returned. Leaving a `for await` early calls the
// stream's return(), which destroys an IncomingMessage - and with it the socket - before the
// seam has written its 413, so the producer would see ECONNRESET and never learn why. Stopping
// here pulls no further chunk; the seam writes the 413 and then destroys the request.
//
// `beforeRead` runs after the fast path and before the first pull: the seam sends `100 Continue`
// from it, so an honest oversized length is refused without the body ever being invited.
export async function readBodyCapped(request, { beforeRead } = {}) {
  const declared = request.headers?.['content-length'];
  if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES)
    return { ok: false, reason: 'body-too-large' };
  beforeRead?.();
  const iterator = request[Symbol.asyncIterator]();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    // Concat then decode once, in the seam: decoding per chunk would turn a multi-byte character
    // split across a chunk boundary into U+FFFD.
    const chunk = Buffer.from(value);
    received += chunk.length;
    if (received > MAX_BODY_BYTES) return { ok: false, reason: 'body-too-large' };
    chunks.push(chunk);
  }
  return { ok: true, body: Buffer.concat(chunks) };
}
