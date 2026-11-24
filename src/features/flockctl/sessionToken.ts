/**
 * A session's proof that a flockctl call is its own.
 *
 * Nothing in a call's transport says which session makes it: one harness
 * process serves every session of that harness, so the environment cannot
 * carry a per-session id, and `--parent-session-id` is a claim anyone can
 * type. A worker that may start nobody typed the conductor's id there, or
 * typed nothing and was read as the operator, and its sessions were started
 * (11-14).
 *
 * The app therefore tells each session that may start others a token only
 * the app can make: the session's id and a keyed digest of it. The session
 * passes it back as `--session-token`, and the spawn gate recomputes the
 * digest. Checking needs no record of what was issued. The commands that
 * act on what one session owns ask for the same proof: `session stop`, and
 * the wave verbs that change a wave (`resolveFlockctlCaller`).
 *
 * This is a guardrail, not a security boundary. An agent has a shell: it can
 * read another session's transcript, where that session's token is written,
 * or the key itself. What the token ends is the cheap bypass — a session
 * cannot pass as another by naming it, nor as the operator by naming nobody.
 */

const KEY_STORAGE = "flock:flockctl:sessionTokenKey";
const KEY_BYTES = 32;
const DIGEST_HEX_CHARS = 16;
const SEPARATOR = ".";

/** A token that verified: the session it was issued to. */
export interface VerifiedSessionToken {
  sessionId: string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function fromHex(text: string): Uint8Array | null {
  if (text.length !== KEY_BYTES * 2 || !/^[0-9a-f]+$/.test(text)) return null;
  const bytes = new Uint8Array(KEY_BYTES);
  for (let index = 0; index < KEY_BYTES; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The install's signing key, made on first use. It lives in local storage
 * because every window of the app reads the same one: a popped-out chat
 * window tells its session a token the main window, where commands run,
 * must accept.
 */
function signingKeyBytes(): Uint8Array | null {
  try {
    const stored = fromHex(window.localStorage.getItem(KEY_STORAGE) ?? "");
    if (stored) return stored;
    const fresh = new Uint8Array(KEY_BYTES);
    globalThis.crypto.getRandomValues(fresh);
    window.localStorage.setItem(KEY_STORAGE, hex(fresh));
    // Another window may have written its own between the read and the
    // write: what is stored now is the one both use.
    return fromHex(window.localStorage.getItem(KEY_STORAGE) ?? "");
  } catch {
    return null;
  }
}

async function digest(sessionId: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  const keyBytes = subtle ? signingKeyBytes() : null;
  if (!subtle || !keyBytes) return null;
  try {
    const key = await subtle.importKey(
      "raw",
      keyBytes as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(sessionId),
    );
    return hex(new Uint8Array(signature)).slice(0, DIGEST_HEX_CHARS);
  } catch {
    return null;
  }
}

/**
 * Whether this renderer can make and check tokens at all. Where it cannot
 * (no WebCrypto, no storage), no session is told a token, and the spawn
 * gate must not ask for one: a rule nobody can satisfy would stop every
 * agent from starting a session.
 */
export async function sessionTokensAvailable(): Promise<boolean> {
  return (await digest("probe")) !== null;
}

/** The token for `sessionId`, or `null` where tokens cannot be made. */
export async function sessionTokenFor(
  sessionId: string,
): Promise<string | null> {
  const id = sessionId.trim();
  if (!id) return null;
  const mac = await digest(id);
  return mac ? `${id}${SEPARATOR}${mac}` : null;
}

/**
 * The session a token was issued to, or `null` when it is not a token this
 * install made. The id is everything before the digest, so an id may itself
 * contain the separator.
 */
export async function verifySessionToken(
  token: string | null | undefined,
): Promise<VerifiedSessionToken | null> {
  const text = token?.trim() ?? "";
  const cut = text.length - DIGEST_HEX_CHARS - SEPARATOR.length;
  if (cut <= 0 || text[cut] !== SEPARATOR) return null;
  const sessionId = text.slice(0, cut);
  const expected = await sessionTokenFor(sessionId);
  return expected !== null && expected === text ? { sessionId } : null;
}

/** Test-only: forget the signing key, as a fresh install would have none. */
export function __resetSessionTokenKeyForTests(): void {
  try {
    window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    // No storage, nothing to forget.
  }
}
