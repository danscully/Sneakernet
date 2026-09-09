/**
 * Token-based access guard for the desktop app's optional LAN sharing mode.
 *
 * When the desktop shell starts the server with METFILESYNC_ACCESS_TOKEN set,
 * every request must prove knowledge of the token: via the `mfs_token` cookie
 * (set once a valid `?token=` query parameter is seen) or via the query
 * parameter itself. Without the env var (dev, `npm run build` deployments with
 * no sharing) all requests pass through untouched.
 */

export const ACCESS_COOKIE = 'mfs_token';

export type AccessDecision = 'open' | 'ok' | 'grant' | 'denied';

/**
 * Pure decision logic used by the server hook.
 * - 'open'   no token is required (guard disabled)
 * - 'ok'     a valid cookie was presented
 * - 'grant'  the query parameter carries the valid token (set the cookie)
 * - 'denied' no valid token
 */
export function accessDecision(opts: {
	required: string | undefined;
	cookie?: string | undefined;
	queryToken?: string | undefined;
}): AccessDecision {
	const required = opts.required;
	if (!required) return 'open';
	if (opts.cookie === required) return 'ok';
	if (opts.queryToken === required) return 'grant';
	return 'denied';
}

/** Serialize the access cookie for manual responses (redirects). */
export function accessCookieHeader(token: string): string {
	return `${ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}
