import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isDesktopHost, isLoopbackAddress } from '$lib/server/desktop';

/**
 * Read-only info about this server instance, fetched once on page load:
 *
 * - `lanUrl`    the full access link when the desktop shell runs the server
 *               in LAN sharing mode (host address + port + token).
 * - `desktopHost` true only for the desktop app's own webview (desktop
 *               mode + loopback); the UI uses it for the Desktop Settings
 *               dialog and the hidden in-window app title.
 * - `localUser`  true for any loopback request (the desktop webview, the
 *               dev browser, or the operator sitting at a standalone
 *               server). Only local users may change the directories of
 *               a sync set; remote LAN users cannot be loopback.
 */
export const GET: RequestHandler = (event) => {
	return json({
		// Example: http://192.168.1.20:8787/?token=1a2b...
		lanUrl: process.env['SNEAKERNET_LAN_URL'] ?? null,
		desktopHost: isDesktopHost(event),
		localUser: isLoopbackAddress(event.getClientAddress())
	});
};
