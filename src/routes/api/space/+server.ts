import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateAbsolutePath } from '$lib/server/paths';
import { listSets } from '$lib/server/syncsets';
import { diskSpace } from '$lib/server/space';

/**
 * Free/total space of a sync set destination (for the sidebar display).
 *
 * Only paths that are registered as a destination of a stored sync set are
 * reported: a remote user must not be able to probe the machine's disks by
 * asking for arbitrary absolute paths.
 */
export const GET: RequestHandler = async ({ url }) => {
	let abs: string;
	try {
		abs = validateAbsolutePath(url.searchParams.get('path') ?? '');
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'invalid path' }, { status: 400 });
	}
	const sets = await listSets();
	const known = new Set(sets.flatMap((s) => s.destinations.map((d) => d.path)));
	if (!known.has(abs)) {
		return json({ error: 'path is not a known sync destination' }, { status: 404 });
	}
	const space = await diskSpace(abs);
	return json({ ...space, requestedPath: abs });
};
