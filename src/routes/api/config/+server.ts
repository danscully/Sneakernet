import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ROOT } from '$lib/server/config';

/**
 * Read-only server deployment info (used by the settings screen). When the
 * desktop shell started the server in LAN sharing mode, `lanUrl` contains the
 * full access link (host address + port + token) to share with other users.
 */
export const GET: RequestHandler = () => {
	return json({
		root: ROOT,
		// Set by the desktop shell when LAN sharing is enabled.
		// Example: http://192.168.1.20:8787/?token=1a2b...
		lanUrl: process.env['METFILESYNC_LAN_URL'] ?? null
	});
};
