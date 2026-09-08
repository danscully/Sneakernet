import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { syncManager } from '$lib/server/engine';
import type { ConfirmDecision } from '$lib/types';

const DECISIONS: ConfirmDecision[] = ['stop', 'skip', 'ignore-all', 'copy-anyway'];

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { confirmId?: string; decision?: ConfirmDecision };
	if (!body.confirmId || !body.decision || !DECISIONS.includes(body.decision)) {
		return json({ error: 'confirmId and a valid decision are required' }, { status: 400 });
	}
	if (!syncManager.respond(body.confirmId, body.decision)) {
		return json({ error: 'no pending confirmation with that id' }, { status: 404 });
	}
	return new Response(null, { status: 204 });
};
