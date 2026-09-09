import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSet } from '$lib/server/syncsets';
import { syncManager, type Selection } from '$lib/server/engine';
import { checkDestinations } from '$lib/server/space';

/**
 * Start a sync. Unless `force` is set, the server first checks whether any
 * destination would be left with less than 1 GiB of free space after the
 * copy; in that case it responds with a warning instead of starting, and the
 * client re-sends with force=true after the user confirms.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as {
		setId?: string;
		selection?: Selection;
		force?: boolean;
	};
	if (!body.setId || !body.selection) {
		return json({ error: 'setId and selection are required' }, { status: 400 });
	}
	const set = await getSet(body.setId);
	if (!set) return json({ error: 'sync set not found' }, { status: 404 });
	const plan = syncManager.getPlan(body.setId);
	if (!plan) return json({ error: 'run a compare first' }, { status: 409 });

	if (!body.force) {
		const warnings = await checkDestinations(plan, body.selection);
		if (warnings.length > 0) {
			return json({ started: false, warning: { destinations: warnings } });
		}
	}

	try {
		const runId = syncManager.start(plan, body.selection, set.errorPolicy);
		return json({ started: true, runId });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'could not start sync';
		return json({ error: message }, { status: 409 });
	}
};
