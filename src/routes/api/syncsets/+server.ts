import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSet, listSets, ValidationError } from '$lib/server/syncsets';

export const GET: RequestHandler = async () => {
	return json({ sets: await listSets() });
};

export const POST: RequestHandler = async ({ request }) => {
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
