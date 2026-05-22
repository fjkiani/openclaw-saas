/**
 * apiFetch — fetch wrapper that:
 *  1. Prepends VITE_API_URL to every relative /api/... path (production cross-origin)
 *  2. Attaches Authorization: Bearer <token> when a Clerk token getter is registered
 *
 * Call `registerClerkTokenGetter(getToken)` once at app startup (in main.tsx or App.tsx)
 * to enable authenticated requests.
 */

const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");

type TokenGetter = () => Promise<string | null>;
let _tokenGetter: TokenGetter | null = null;

export function registerClerkTokenGetter(getter: TokenGetter): void {
  _tokenGetter = getter;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = API_BASE && path.startsWith("/") ? `${API_BASE}${path}` : path;

  const headers = new Headers(init.headers);

  // Attach Bearer token for authenticated cross-origin requests
  if (_tokenGetter && !headers.has("authorization")) {
    try {
      const token = await _tokenGetter();
      if (token) headers.set("authorization", `Bearer ${token}`);
    } catch {
      // If token fetch fails (e.g. not signed in), proceed without auth header
    }
  }

  return fetch(url, { credentials: "include", ...init, headers });
}
