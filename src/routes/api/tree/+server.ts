import { json } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { absPath, sanitizeRelPath } from '$lib/server/paths';

interface TreeDir {
	name: string;
	rel: string;
}

/**
 * List the subdirectories of a path under the sync root (for the legacy
 * path picker).
 *
 * NOTE: currently unused by the UI — the root-relative PathPicker component
 * was replaced by the OS-native directory chooser when absolute paths
 * replaced the sync-root concept. Retained for rollback/reuse.
 */
export const GET: RequestHandler = async ({ url }) => {
	let rel: string;
	try {
		rel = sanitizeRelPath(url.searchParams.get('path') ?? '');
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'invalid path' }, { status: 400 });
	}
	const abs = absPath(rel);
	const dirs: TreeDir[] = [];
	let exists = false;
	try {
		const dirents = await fs.readdir(abs, { withFileTypes: true });
		exists = true;
		for (const d of dirents) {
			if (d.isDirectory()) {
				dirs.push({ name: d.name, rel: rel === '' ? d.name : `${rel}/${d.name}` });
			}
		}
		dirs.sort((a, b) => a.name.localeCompare(b.name));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT' && code !== 'ENOTDIR') {
			return json({ error: `cannot read ${rel || '<root>'}` }, { status: 500 });
		}
	}
	return json({ path: rel, exists, dirs });
};

/**
 * Create a subdirectory (and any missing parents) under a path inside the
 * sync root. Used by the directory picker to create new folders.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { parent?: string; name?: string };
	const name = (body.name ?? '').trim();
	if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
		return json({ error: 'invalid directory name' }, { status: 400 });
	}
	if (name.length > 255) return json({ error: 'directory name is too long' }, { status: 400 });

	let parentRel: string;
	try {
		parentRel = sanitizeRelPath(body.parent ?? '');
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'invalid path' }, { status: 400 });
	}
	const rel = parentRel === '' ? name : `${parentRel}/${name}`;
	const abs = absPath(rel);
	try {
		await fs.mkdir(abs, { recursive: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		const message = code === 'EEXIST' ? 'a directory with that name already exists' : 'could not create the directory';
		return json({ error: message }, { status: code === 'EEXIST' ? 409 : 500 });
	}
	return json({ rel }, { status: 201 });
};
