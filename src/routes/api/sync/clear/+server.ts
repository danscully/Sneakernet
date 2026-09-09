import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { syncManager } from '$lib/server/engine';

/**
 * Remove all finished (completed or stopped) sync runs from the global run
 * registry - the "Clear completed" button in the Status view. Running syncs
 * are never touched. Every connected client is notified via the event stream.
 */
export const POST: RequestHandler = () => {
	syncManager.clearCompleted();
	return json({ ok: true });
};
