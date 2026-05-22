/**
 * apiFetch — thin wrapper around fetch() that prepends VITE_API_URL to
 * every relative /api/... path.
 *
 * In local dev VITE_API_URL is unset, so paths stay relative and the Vite
 * dev-server proxy handles them.  In production (Render static site) the
 * env var is set to https://openclaw-api-8j2z.onrender.com and every call
 * is routed to the correct backend service.
 */

const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = API_BASE && path.startsWith("/") ? `${API_BASE}${path}` : path;
  return fetch(url, { credentials: "include", ...init });
}
