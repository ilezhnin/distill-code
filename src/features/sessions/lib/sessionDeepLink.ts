/**
 * Protocols a session link may use, the one this build registers and creates
 * first. `distill:` is the protocol of the links earlier builds wrote into
 * transcripts, notes and memory entries; those are not rewritten, so the
 * installer keeps registering both schemes and the parser accepts both.
 * Mirrors `SESSION_DEEP_LINK_SCHEMES` in `src-tauri/src/deep_links.rs`.
 */
export const SESSION_LINK_PROTOCOLS = ["flock:", "distill:"] as const;

type SessionLinkProtocol = (typeof SESSION_LINK_PROTOCOLS)[number];

export function createSessionDeepLink(sessionId: string): string {
  return `${SESSION_LINK_PROTOCOLS[0]}//session/${encodeURIComponent(sessionId)}`;
}

type SessionDeepLinkRoute = "host" | "path";

interface RawSessionDeepLink {
  protocol: SessionLinkProtocol;
  route: SessionDeepLinkRoute;
}

/**
 * Each protocol is matched on its own length (never on the longest one), so
 * `distill://` is read past eight characters and `flock://` past six.
 */
function rawSessionLinkProtocol(raw: string): SessionLinkProtocol | null {
  if (raw.trim() !== raw) {
    return null;
  }

  return (
    SESSION_LINK_PROTOCOLS.find(
      (protocol) => raw.slice(0, protocol.length).toLowerCase() === protocol,
    ) ?? null
  );
}

function rawSessionDeepLinkRoute(raw: string): RawSessionDeepLink | null {
  const protocol = rawSessionLinkProtocol(raw);
  if (!protocol) {
    return null;
  }

  const route = raw.slice(protocol.length);
  if (route.startsWith("//session/")) {
    return { protocol, route: "host" };
  }
  if (route.startsWith("///session/")) {
    return { protocol, route: "path" };
  }
  return null;
}

function strictPathSegments(url: URL): string[] | null {
  const segments = url.pathname.split("/");
  if (segments[0] !== "") {
    return null;
  }

  const pathSegments = segments.slice(1);
  return pathSegments.every(Boolean) ? pathSegments : null;
}

export function parseSessionDeepLink(raw: string): string | null {
  const link = rawSessionDeepLinkRoute(raw);
  if (!link) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== link.protocol) {
    return null;
  }

  const segments = strictPathSegments(url);
  if (!segments) {
    return null;
  }

  let encodedSessionId: string | undefined;
  if (
    link.route === "host" &&
    url.hostname === "session" &&
    segments.length === 1
  ) {
    encodedSessionId = segments[0];
  } else if (
    link.route === "path" &&
    url.hostname === "" &&
    segments.length === 2 &&
    segments[0] === "session"
  ) {
    encodedSessionId = segments[1];
  }

  if (!encodedSessionId) {
    return null;
  }

  try {
    const sessionId = decodeURIComponent(encodedSessionId);
    return sessionId ? sessionId : null;
  } catch {
    return null;
  }
}
