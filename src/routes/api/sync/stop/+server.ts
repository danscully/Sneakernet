import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { syncManager } from '$lib/server/engine';

/** Stop one destination (destId) or every destination (destId omitted/null). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { setId?: string; destId?: string | null };
	if (!body.setId) return json({ error: 'setId is required' }, { status: 400 });
	if (!syncManager.isRunning(body.setId)) {
		return json({ error: 'no sync is running for this set' }, { status: 409 });
	}
	syncManager.stopDest(body.setId, body.destId ?? null);
	return new Response(null, { status: 204 });
};
