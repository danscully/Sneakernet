import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSet } from '$lib/server/syncsets';
import { syncManager } from '$lib/server/engine';

/** Run a fresh compare for a sync set. */
export const POST: RequestHandler = async ({ request }) => {
	const { setId } = (await request.json()) as { setId?: string };
	if (!setId) return json({ error: 'setId is required' }, { status: 400 });
	const set = await getSet(setId);
	if (!set) return json({ error: 'sync set not found' }, { status: 404 });
	try {
		const plan = await syncManager.compare(set);
		return json({ plan });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'compare failed';
		const status = message.includes('currently running') ? 409 : 500;
		return json({ error: message }, { status });
	}
};

/** Fetch the latest compare plan for a set (without re-comparing). */
export const GET: RequestHandler = async ({ url }) => {
	const setId = url.searchParams.get('setId');
	if (!setId) return json({ error: 'setId is required' }, { status: 400 });
	const plan = syncManager.getPlan(setId);
	if (!plan) return json({ error: 'no plan for this set' }, { status: 404 });
	return json({ plan });
};
