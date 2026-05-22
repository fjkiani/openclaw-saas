/**
 * apiFetch — fetch wrapper that:
 *  1. Prepends VITE_API_URL to every relative /api/... path (production cross-origin)
 *  2. Attaches Authorization: Bearer <token> when a Clerk token getter is registered
 *  3. Injects userId into JSON request bodies as a fallback for Clerk dev instances
 *     deployed cross-origin (where SameSite=Lax cookies + CORS block token refresh)
 *
 * Call `registerClerkTokenGetter(getToken, getUserId)` once at app startup.
 */

const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");

type TokenGetter = () => Promise<string | null>;
type UserIdGetter = () => string | null | undefined;

let _tokenGetter: TokenGetter | null = null;
let _userIdGetter: UserIdGetter | null = null;

export function registerClerkTokenGetter(getter: TokenGetter, userIdGetter?: UserIdGetter): void {
  _tokenGetter = getter;
  if (userIdGetter) _userIdGetter = userIdGetter;
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
      // Token fetch failed (CORS on dev instance) — fall through to userId header/body injection
    }
  }

  // Inject X-User-Id header on ALL requests (including GET) as fallback auth.
  // The server reads this when JWT verification fails (SameSite/CORS on dev FAPI).
  if (_userIdGetter && !headers.has("x-user-id")) {
    const userId = _userIdGetter();
    if (userId) headers.set("x-user-id", userId);
  }

  // Always inject userId into JSON POST/PUT/PATCH bodies.
  // The server uses req.auth?.userId first (JWT), then req.body.userId as fallback.
  // Injecting unconditionally means cross-origin dev instances work even when
  // the Bearer token is present but the server-side JWT verification fails.
  let body = init.body;
  const method = (init.method ?? "GET").toUpperCase();
  if (
    _userIdGetter &&
    ["POST", "PUT", "PATCH"].includes(method) &&
    (headers.get("content-type")?.includes("application/json") || typeof body === "string")
  ) {
    const userId = _userIdGetter();
    if (userId) {
      try {
        const parsed = body ? JSON.parse(body as string) : {};
        if (!parsed.userId) {
          parsed.userId = userId;
          body = JSON.stringify(parsed);
          headers.set("content-type", "application/json");
        }
      } catch {
        // Body isn't JSON — skip injection
      }
    }
  }

  return fetch(url, { credentials: "include", ...init, body, headers });
}
