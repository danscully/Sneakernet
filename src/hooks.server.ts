import type { Handle } from '@sveltejs/kit';
import { ACCESS_COOKIE, accessCookieHeader, accessDecision } from '$lib/server/access';

/**
 * Server hook: token guard for the desktop app's LAN sharing mode.
 * See src/lib/server/access.ts. Without SNEAKERNET_ACCESS_TOKEN set this
 * hook is a no-op.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const required = process.env['SNEAKERNET_ACCESS_TOKEN'];
	const decision = accessDecision({
		required,
		cookie: event.cookies.get(ACCESS_COOKIE),
		queryToken: event.url.searchParams.get('token') ?? undefined
	});

	switch (decision) {
		case 'open':
		case 'ok':
			return resolve(event);
		case 'grant': {
			// Valid token in the URL: remember it in a cookie and, for page
			// navigations, redirect to a clean URL without the token.
			event.cookies.set(ACCESS_COOKIE, required as string, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				maxAge: 60 * 60 * 24 * 365,
				// LAN sharing runs over plain HTTP; a Secure cookie would be
				// rejected by browsers on non-TLS connections.
				secure: false
			});
			if (event.request.method === 'GET' && !event.url.pathname.startsWith('/api/')) {
				const clean = new URL(event.url);
				clean.searchParams.delete('token');
				return new Response(null, {
					status: 303,
					headers: {
						location: clean.pathname + (clean.search || ''),
						'set-cookie': accessCookieHeader(required as string)
					}
				});
			}
			return resolve(event);
		}
		default: {
			const message =
				'Sneakernet: access denied. Open the access link that was shared with you (it contains the access token).';
			if (event.url.pathname.startsWith('/api/')) {
				return new Response(JSON.stringify({ message }), {
					status: 401,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(
				`<!doctype html><html lang="en" style="color-scheme:dark"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0b;color:#e4e4e7;font:13px/1.6 system-ui,sans-serif"><p style="max-width:32rem;padding:2rem;text-align:center">${message}</p></body></html>`,
				{ status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } }
			);
		}
	}
};
