import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sanitizeRelPath } from '$lib/server/paths';
import { diskSpace } from '$lib/server/space';

/** Free/total space of a directory under the sync root (for the sidebar). */
export const GET: RequestHandler = async ({ url }) => {
	let rel: string;
	try {
		rel = sanitizeRelPath(url.searchParams.get('path') ?? '');
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'invalid path' }, { status: 400 });
	}
	const space = await diskSpace(rel);
	return json({ ...space, requestedPath: rel });
};
