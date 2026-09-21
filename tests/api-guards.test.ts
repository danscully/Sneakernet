/**
 * Security guards around the sync-set and space endpoints:
 *
 * - creating sets (POST /api/syncsets, also used by JSON import) and
 *   changing a set's source/destination paths (PUT /api/syncsets/[id])
 *   are limited to LOCAL users (loopback requests). Remote LAN users —
 *   even ones holding the access token — can change only the non-path
 *   settings of an existing set.
 * - /api/space only reports paths that are registered as a destination of
 *   a stored sync set, so remote users cannot probe arbitrary disks.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncSet } from '../src/lib/types';
import { ROOT } from '../src/lib/server/config';
import { createSet, deleteSet, listSets, resetCacheForTests } from '../src/lib/server/syncsets';
import { makeSet, mkfile, mkdirp, rmrf } from './helpers';
import * as collection from '../src/routes/api/syncsets/+server';
import * as item from '../src/routes/api/syncsets/[id]/+server';
import * as space from '../src/routes/api/space/+server';

const LOCAL = '127.0.0.1';
const REMOTE = '192.168.1.50';

type PostEvent = Parameters<typeof collection.POST>[0];
type PutEvent = Parameters<typeof item.PUT>[0];
type SpaceEvent = Parameters<typeof space.GET>[0];

function postEvent(address: string, body: unknown): PostEvent {
	return {
		request: new Request('http://localhost/api/syncsets', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		getClientAddress: () => address
	} as unknown as PostEvent;
}

function putEvent(address: string, id: string, body: unknown): PutEvent {
	return {
		params: { id },
		request: new Request(`http://localhost/api/syncsets/${id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		getClientAddress: () => address
	} as unknown as PutEvent;
}

function spaceEvent(path: string): SpaceEvent {
	return {
		url: new URL(`http://localhost/api/space?path=${encodeURIComponent(path)}`)
	} as unknown as SpaceEvent;
}

const created: SyncSet[] = [];

afterEach(async () => {
	for (const s of created.splice(0)) await deleteSet(s.id);
});

describe('POST /api/syncsets (create / import)', () => {
	it('allows creation from the local machine (loopback)', async () => {
		const res = await collection.POST(postEvent(LOCAL, makeSet({ name: 'Local Create' })));
		expect(res.status).toBe(201);
		const data = (await res.json()) as { set: SyncSet };
		created.push(data.set);
	});

	it('refuses creation from remote users (403)', async () => {
		const res = await collection.POST(postEvent(REMOTE, makeSet({ name: 'Remote Create' })));
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toMatch(/created or imported/i);
		// Nothing was stored.
		expect((await listSets()).some((s) => s.name === 'Remote Create')).toBe(false);
	});
});

describe('PUT /api/syncsets/[id] (update)', () => {
	async function seed(): Promise<SyncSet> {
		const set = await createSet(makeSet({ name: 'Guard Set' }));
		created.push(set);
		return set;
	}

	it('refuses path changes from remote users (403)', async () => {
		const set = await seed();
		const withNewSource = { ...set, source: path.join(ROOT, 'somewhere-else') };
		const res = await item.PUT(putEvent(REMOTE, set.id, withNewSource));
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toMatch(/only be changed on this machine/i);
	});

	it('refuses destination path changes (and additions/removals) from remote users', async () => {
		const set = await seed();
		const changedDest = {
			...set,
			destinations: set.destinations.map((d) => ({ ...d, path: `${d.path}-x` }))
		};
		expect((await item.PUT(putEvent(REMOTE, set.id, changedDest))).status).toBe(403);

		const extraDest = {
			...set,
			destinations: [
				...set.destinations,
				{ id: 'dx', name: 'Extra', path: `${set.destinations[0]!.path}-extra`, group: 2 }
			]
		};
		expect((await item.PUT(putEvent(REMOTE, set.id, extraDest))).status).toBe(403);

		const removedDest = { ...set, destinations: set.destinations.slice(0, 0) };
		expect((await item.PUT(putEvent(REMOTE, set.id, removedDest))).status).toBe(403);
	});

	it('allows non-path settings changes from remote users', async () => {
		const set = await seed();
		const res = await item.PUT(
			putEvent(REMOTE, set.id, { ...set, name: 'Remote Rename', syncDeletions: true, dateDeltaSeconds: 5 })
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { set: SyncSet };
		expect(data.set.name).toBe('Remote Rename');
		expect(data.set.source).toBe(set.source);
	});

	it('allows path changes from the local machine', async () => {
		const set = await seed();
		const moved = makeSet({ name: set.name });
		const res = await item.PUT(putEvent(LOCAL, set.id, { ...set, source: moved.source }));
		expect(res.status).toBe(200);
		const data = (await res.json()) as { set: SyncSet };
		expect(data.set.source).toBe(moved.source);
	});
});

describe('GET /api/space', () => {
	it('reports space only for registered destination paths', async () => {
		const NS = 'space-guard-test';
		await rmrf(`${NS}`);
		await mkdirp(`${NS}/dst`);
		await mkfile(`${NS}/dst/f.txt`, 'x');
		const set = await createSet(
			makeSet({
				name: 'Space Guard',
				destinations: [{ id: 'd1', name: 'D1', path: `${NS}/dst`, group: 1 }]
			})
		);
		created.push(set);

		// The registered destination is allowed (from any client - the
		// sidebar shows free space to remote users too).
		const ok = await space.GET(spaceEvent(set.destinations[0]!.path));
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { free: number }).free).toBeGreaterThan(0);

		// An arbitrary absolute path is refused, even a parent of the
		// registered destination.
		const parent = set.destinations[0]!.path.replace(/\/[^/]+$/, '');
		expect((await space.GET(spaceEvent(parent))).status).toBe(404);

		expect((await space.GET(spaceEvent('/etc'))).status).toBe(404);

		// Relative paths are invalid input.
		expect((await space.GET(spaceEvent('relative'))).status).toBe(400);

		await rmrf(`${NS}`);
		resetCacheForTests();
	});
});
