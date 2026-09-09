import { json } from '@sveltejs/kit';
import path from 'node:path';
import type { RequestHandler } from './$types';
import { ROOT } from '$lib/server/config';
import {
	desktopMode,
	isDesktopHost,
	readDesktopSettings,
	writeDesktopSettings
} from '$lib/server/desktop';

/**
 * Desktop-app settings (`desktop-settings.json`, owned by the Tauri shell).
 *
 * These endpoints are the ONLY client-facing way to change the sync root and
 * LAN sharing, and they are restricted to the desktop app's own webview:
 * requests that do not come from the loopback interface are refused with 403,
 * so remote users (even with the LAN access link) can never alter them.
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
		rootDirectory: settings?.rootDirectory ?? null,
		// The effective root (shell default when rootDirectory is null).
		root: ROOT,
		// Set by the desktop shell when LAN sharing is enabled.
		lanUrl: process.env['METFILESYNC_LAN_URL'] ?? null
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
		rootDirectory?: unknown;
	} | null;
	if (!body) return json({ error: 'invalid JSON body' }, { status: 400 });

	const update: { lanSharing?: boolean; lanPort?: number; rootDirectory?: string | null } = {};
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
	if (body.rootDirectory !== undefined) {
		if (body.rootDirectory === null) {
			update.rootDirectory = null;
		} else if (typeof body.rootDirectory !== 'string' || !path.isAbsolute(body.rootDirectory)) {
			return json({ error: 'rootDirectory must be an absolute path (or null)' }, { status: 400 });
		} else {
			update.rootDirectory = body.rootDirectory;
		}
	}
	if (Object.keys(update).length === 0) {
		return json({ error: 'no settings to update' }, { status: 400 });
	}

	const next = await writeDesktopSettings(update);
	if (!next) {
		return json({ error: 'could not write the desktop settings file' }, { status: 500 });
	}
	// The shell watches the settings file and restarts the server (rebinding
	// it and switching the root) within ~1s of this write.
	return json({ ok: true, restarting: true });
};
