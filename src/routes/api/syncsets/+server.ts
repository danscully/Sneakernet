import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSet, listSets, ValidationError } from '$lib/server/syncsets';
import { isLoopbackAddress } from '$lib/server/desktop';

export const GET: RequestHandler = async () => {
	return json({ sets: await listSets() });
};

/**
 * Create a sync set (also used by JSON import). Creating a set means
 * choosing its source and destination directories, which only a local
 * user may do: a remote LAN user - even one holding the access token -
 * gets a 403. Loopback requests cannot be spoofed over the network, so
 * this check is sound even when the server is LAN-shared.
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (!isLoopbackAddress(getClientAddress())) {
		return json(
			{ error: 'sync sets can only be created or imported on this machine' },
			{ status: 403 }
		);
	}
	try {
		const body = await request.json();
		const set = await createSet(body);
		return json({ set }, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'invalid sync set';
		const status = err instanceof ValidationError ? 400 : 500;
		return json({ error: message }, { status });
	}
};
