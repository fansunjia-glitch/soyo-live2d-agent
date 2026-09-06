const apiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL);
const wsBaseUrl = trimTrailingSlash(import.meta.env.VITE_WS_BASE_URL);

export const agentAccessTokenStorageKey = "soyo.agent.access-token.v1";
export const agentAuthenticationRequiredEvent = "soyo-agent-authentication-required";

export function getAgentAccessToken(): string {
  try {
    return typeof sessionStorage === "undefined"
      ? ""
      : sessionStorage.getItem(agentAccessTokenStorageKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setAgentAccessToken(token: string): void {
  if (typeof sessionStorage === "undefined") return;
  const normalized = token.trim();
  try {
    if (normalized) sessionStorage.setItem(agentAccessTokenStorageKey, normalized);
    else sessionStorage.removeItem(agentAccessTokenStorageKey);
  } catch {
    // Private browsing can deny session storage; the caller still gets a clear
    // authentication error from the next request.
  }
}

/** Adds the optional local-service bearer token without leaking it to device APIs. */
export const agentFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const token = getAgentAccessToken();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(agentAuthenticationRequiredEvent));
  }
  return response;
};

export function apiUrl(path: string) {
  return `${apiBaseUrl}${normalizePath(path)}`;
}

export function wsUrl(path: string) {
  if (wsBaseUrl) {
    return `${wsBaseUrl}${normalizePath(path)}`;
  }

  if (apiBaseUrl) {
    const url = new URL(apiBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = normalizePath(path);
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${normalizePath(path)}`;
}

function trimTrailingSlash(value: string | undefined) {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}
