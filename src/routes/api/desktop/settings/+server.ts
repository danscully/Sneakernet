import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	desktopMode,
	isDesktopHost,
	readDesktopSettings,
	writeDesktopSettings
} from '$lib/server/desktop';

/**
 * Desktop-app settings (`desktop-settings.json`, owned by the Tauri shell):
 * LAN sharing and its port. The shell picks up file changes and restarts
 * the server with the new binding.
 *
 * These endpoints are restricted to the desktop app's own webview
 * (desktop mode + loopback): requests that do not come from the loopback
 * interface are refused with 403, so remote users (even with the LAN
 * access link) can never alter them. The file also carries a legacy
 * `rootDirectory` field (owned by the shell); it is no longer part of the
 * API since the root-directory concept was removed.
 */

export const GET: RequestHandler = async (event) => {
	if (!desktopMode()) {
		return json({ error: 'not running as the desktop app' }, { status: 503 });
	}
	if (!isDesktopHost(event)) {
		return json({ error: 'desktop settings are only accessible in the app' }, { status: 403 });
	}
	const settings = await readDesktopSettings();
	return json({
		lanSharing: settings?.lanSharing ?? false,
		lanPort: settings?.lanPort ?? 8787,
		// Set by the desktop shell when LAN sharing is enabled.
		lanUrl: process.env['SNEAKERNET_LAN_URL'] ?? null
	});
};

export const PUT: RequestHandler = async (event) => {
	if (!desktopMode()) {
		return json({ error: 'not running as the desktop app' }, { status: 503 });
	}
	if (!isDesktopHost(event)) {
		return json({ error: 'desktop settings are only accessible in the app' }, { status: 403 });
	}
	const body = (await event.request.json().catch(() => null)) as {
		lanSharing?: unknown;
		lanPort?: unknown;
	} | null;
	if (!body) return json({ error: 'invalid JSON body' }, { status: 400 });

	const update: { lanSharing?: boolean; lanPort?: number } = {};
	if (body.lanSharing !== undefined) {
		if (typeof body.lanSharing !== 'boolean') {
			return json({ error: 'lanSharing must be a boolean' }, { status: 400 });
		}
		update.lanSharing = body.lanSharing;
	}
	if (body.lanPort !== undefined) {
		const port = Number(body.lanPort);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return json({ error: 'lanPort must be an integer between 1 and 65535' }, { status: 400 });
		}
		update.lanPort = port;
	}
	if (Object.keys(update).length === 0) {
		return json({ error: 'no settings to update' }, { status: 400 });
	}

	const next = await writeDesktopSettings(update);
	if (!next) {
		return json({ error: 'could not write the desktop settings file' }, { status: 500 });
	}
	// The shell watches the settings file and restarts the server (rebinding
	// it) within ~1s of this write.
	return json({ ok: true, restarting: true });
};
