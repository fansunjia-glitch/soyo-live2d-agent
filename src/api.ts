const apiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL);
const wsBaseUrl = trimTrailingSlash(import.meta.env.VITE_WS_BASE_URL);

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
