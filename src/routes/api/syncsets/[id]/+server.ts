import { json } from '@sveltejs/kit';
import path from 'node:path';
import type { RequestHandler } from './$types';
import type { SyncSet } from '$lib/types';
import { deleteSet, getSet, updateSet, ValidationError } from '$lib/server/syncsets';
import { isLoopbackAddress } from '$lib/server/desktop';

export const GET: RequestHandler = async ({ params }) => {
	const set = await getSet(params.id);
	if (!set) return json({ error: 'sync set not found' }, { status: 404 });
	return json({ set });
};

/**
 * True when the submitted update changes the set's directory paths (source,
 * destination list) relative to the stored set. Anything ambiguous counts
 * as a change.
 */
function pathsChanged(stored: SyncSet, input: unknown): boolean {
	if (typeof input !== 'object' || input === null) return true;
	const raw = input as Record<string, unknown>;

	const source = raw['source'];
	if (typeof source !== 'string' || !path.isAbsolute(source)) return true;
	if (path.resolve(source) !== stored.source) return true;

	const dests = Array.isArray(raw['destinations']) ? raw['destinations'] : [];
	if (dests.length !== stored.destinations.length) return true;
	const storedPaths = new Set(stored.destinations.map((d) => d.path));
	const seen = new Set<string>();
	for (const d of dests) {
		if (typeof d !== 'object' || d === null) return true;
		const p = (d as Record<string, unknown>)['path'];
		if (typeof p !== 'string' || !path.isAbsolute(p)) return true;
		const resolved = path.resolve(p);
		if (!storedPaths.has(resolved) || seen.has(resolved)) return true;
		seen.add(resolved);
	}
	return false;
}

/**
 * Update a sync set. Local users (loopback - the desktop webview, the dev
 * browser, the operator at a standalone server) may change everything.
 * Remote LAN users may change the non-directory settings only; any change
 * to the source or destination paths is refused with a 403. Deleting a set
 * stays allowed for remote users (no paths involved).
 */
export const PUT: RequestHandler = async ({ params, request, getClientAddress }) => {
	const stored = await getSet(params.id);
	if (!stored) return json({ error: 'sync set not found' }, { status: 404 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	if (!isLoopbackAddress(getClientAddress()) && pathsChanged(stored, body)) {
		return json(
			{ error: 'directory paths can only be changed on this machine' },
			{ status: 403 }
		);
	}

	try {
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
