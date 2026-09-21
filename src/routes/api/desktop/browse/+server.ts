import { json } from '@sveltejs/kit';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestHandler } from './$types';
import { desktopMode, isDesktopHost } from '$lib/server/desktop';

/**
 * Absolute-path directory listing for the root-directory picker in the
 * desktop settings dialog. Unlike /api/tree (which is sandboxed to the sync
 * root), this walks the real filesystem - so it is strictly loopback-only,
 * desktop mode only. Remote users can never enumerate the machine's disks.
 */

/** A drive/volume that can be jumped to directly (Windows only). */
interface Drive {
	name: string;
	path: string;
}

/** Drive letters exist; probing 26 letters can involve removable/network
 * media, so the result is cached briefly. */
let driveCache: { at: number; drives: Drive[] } | null = null;

function windowsDrives(): Drive[] {
	if (driveCache && Date.now() - driveCache.at < 30_000) return driveCache.drives;
	const drives: Drive[] = [];
	// Probe A: through Z: - absent letters error immediately.
	for (let code = 65; code <= 90; code++) {
		const letter = String.fromCharCode(code);
		const root = `${letter}:\\`;
		try {
			fsSync.accessSync(root);
			drives.push({ name: `${letter}:`, path: root });
		} catch {
			/* drive not present */
		}
	}
	driveCache = { at: Date.now(), drives };
	return drives;
}

export const GET: RequestHandler = async (event) => {
	if (!desktopMode()) {
		return json({ error: 'not running as the desktop app' }, { status: 503 });
	}
	if (!isDesktopHost(event)) {
		return json({ error: 'directory browsing is only accessible in the app' }, { status: 403 });
	}
	const requested = event.url.searchParams.get('path');
	const abs = requested && path.isAbsolute(requested) ? path.resolve(requested) : os.homedir();

	let dirs: { name: string; path: string }[] = [];
	try {
		const dirents = await fs.readdir(abs, { withFileTypes: true });
		for (const d of dirents) {
			if (d.isDirectory()) dirs.push({ name: d.name, path: path.join(abs, d.name) });
		}
	} catch {
		return json({ error: `cannot read ${abs}` }, { status: 400 });
	}
	// Visible directories first, then dotfiles, both alphabetical.
	dirs.sort(
		(a, b) =>
			Number(a.name.startsWith('.')) - Number(b.name.startsWith('.')) ||
			a.name.localeCompare(b.name)
	);

	const parent = path.dirname(abs);
	// On Windows, walking "up" from a drive root has nowhere to go - the
	// client shows the available drives as direct jump targets instead.
	const drives = process.platform === 'win32' ? windowsDrives() : [];

	return json({
		path: abs,
		parent: parent === abs ? null : parent,
		dirs,
		drives
	});
};
