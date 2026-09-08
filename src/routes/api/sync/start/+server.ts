import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSet } from '$lib/server/syncsets';
import { syncManager, type Selection } from '$lib/server/engine';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { setId?: string; selection?: Selection };
	if (!body.setId || !body.selection) {
		return json({ error: 'setId and selection are required' }, { status: 400 });
	}
	const set = await getSet(body.setId);
	if (!set) return json({ error: 'sync set not found' }, { status: 404 });
	const plan = syncManager.getPlan(body.setId);
	if (!plan) return json({ error: 'run a compare first' }, { status: 409 });
	try {
		const runId = syncManager.start(plan, body.selection, set.errorPolicy);
		return json({ runId });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'could not start sync';
		return json({ error: message }, { status: 409 });
	}
};
