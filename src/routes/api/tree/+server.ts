import { json } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { absPath, sanitizeRelPath } from '$lib/server/paths';

interface TreeDir {
	name: string;
	rel: string;
}

/**
 * List the subdirectories of a path under the sync root (for the path picker).
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
