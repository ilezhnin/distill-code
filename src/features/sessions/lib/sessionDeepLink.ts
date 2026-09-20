export function createSessionDeepLink(sessionId: string): string {
  return `distill://session/${encodeURIComponent(sessionId)}`;
}

const SESSION_LINK_PROTOCOL = "distill:";

type SessionDeepLinkRoute = "host" | "path";

function rawSessionDeepLinkRoute(raw: string): SessionDeepLinkRoute | null {
  if (
    raw.trim() !== raw ||
    raw.slice(0, SESSION_LINK_PROTOCOL.length).toLowerCase() !==
      SESSION_LINK_PROTOCOL
  ) {
    return null;
  }

  const route = raw.slice(SESSION_LINK_PROTOCOL.length);
  if (route.startsWith("//session/")) {
    return "host";
  }
  if (route.startsWith("///session/")) {
    return "path";
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
  const route = rawSessionDeepLinkRoute(raw);
  if (!route) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== SESSION_LINK_PROTOCOL) {
    return null;
  }

  const segments = strictPathSegments(url);
  if (!segments) {
    return null;
  }

  let encodedSessionId: string | undefined;
  if (route === "host" && url.hostname === "session" && segments.length === 1) {
    encodedSessionId = segments[0];
  } else if (
    route === "path" &&
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
