import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteSet, getSet, updateSet, ValidationError } from '$lib/server/syncsets';

export const GET: RequestHandler = async ({ params }) => {
	const set = await getSet(params.id);
	if (!set) return json({ error: 'sync set not found' }, { status: 404 });
	return json({ set });
};

export const PUT: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const set = await updateSet(params.id, body);
		return json({ set });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'invalid sync set';
		const status = err instanceof ValidationError ? 400 : 500;
		return json({ error: message }, { status });
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	const ok = await deleteSet(params.id);
	if (!ok) return json({ error: 'sync set not found' }, { status: 404 });
	return new Response(null, { status: 204 });
};
