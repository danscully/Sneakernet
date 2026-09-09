import { json } from '@sveltejs/kit';
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
	return json({
		path: abs,
		parent: parent === abs ? null : parent,
		dirs
	});
};
