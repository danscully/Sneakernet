import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncSet } from '../src/lib/types';
import {
	createSet,
	deleteSet,
	listSets,
	resetCacheForTests,
	updateSet,
	validateSyncSet,
	ValidationError
} from '../src/lib/server/syncsets';
import { ROOT, SYNCSETS_FILE } from '../src/lib/server/config';
import { makeSet } from './helpers';

const abs = (p: string): string => path.join(ROOT, p);

describe('sync set validation (absolute paths)', () => {
	it('rejects relative paths (legacy data is migrated at load instead)', () => {
		expect(() => validateSyncSet({ ...makeSet(), source: 'photos' }, new Set())).toThrow(/absolute/);
		expect(() =>
			validateSyncSet(
				{
					...makeSet(),
					destinations: [{ id: 'd', name: 'x', path: 'dst', group: 1 }]
				},
				new Set()
			)
		).toThrow(/absolute/);
	});

	it('rejects empty source and destination paths', () => {
		expect(() => validateSyncSet({ ...makeSet(), source: '' }, new Set())).toThrow(/required|absolute/);
		expect(() =>
			validateSyncSet(
				{
					...makeSet(),
					destinations: [{ id: 'd', name: 'x', path: '', group: 1 }]
				},
				new Set()
			)
		).toThrow(/required|absolute/);
	});

	it('accepts absolute paths and normalizes them', () => {
		const set = validateSyncSet(
			makeSet({
				source: `${abs('src')}/`,
				destinations: [{ id: 'd', name: 'A', path: `${abs('dst')}/`, group: 1 }]
			}),
			new Set()
		);
		expect(set.source).toBe(abs('src'));
		expect(set.destinations[0]!.path).toBe(abs('dst'));
	});

	it('rejects duplicate destination paths and source == destination', () => {
		const base = makeSet({
			destinations: [
				{ id: 'd1', name: 'A', path: abs('dst'), group: 1 },
				{ id: 'd2', name: 'B', path: abs('dst'), group: 2 }
			]
		});
		expect(() => validateSyncSet(base, new Set())).toThrow(/duplicate/);
		expect(() =>
			validateSyncSet(
				makeSet({
					source: abs('x'),
					destinations: [{ id: 'd', name: 'A', path: abs('x'), group: 1 }]
				}),
				new Set()
			)
		).toThrow(/differ from source/);
	});

	it('rejects invalid groups and error policies', () => {
		expect(() =>
			validateSyncSet(
				makeSet({ destinations: [{ id: 'd', name: 'A', path: abs('dst'), group: 11 }] }),
				new Set()
			)
		).toThrow(/group/);
		expect(() => validateSyncSet(makeSet({ errorPolicy: 'explode' as never }), new Set())).toThrow(
			/errorPolicy/
		);
	});
});

describe('legacy migration (root-relative -> absolute)', () => {
	afterEach(async () => {
		// Clean out whatever the migration test wrote into the shared file.
		resetCacheForTests();
		const sets = await listSets();
		for (const s of sets) await deleteSet(s.id);
	});

	it('resolves stored relative paths against the legacy root and rewrites the file', async () => {
		// Write legacy (root-relative) data directly, bypassing validation.
		const legacySet: SyncSet = {
			id: 'legacy-migration-set',
			name: 'Legacy',
			source: 'demo/src',
			destinations: [{ id: 'd1', name: 'Primary', path: 'demo/dst', group: 1 }],
			dateDeltaSeconds: 0,
			syncDeletions: false,
			includeFilters: [],
			excludeFilters: [],
			errorPolicy: 'ask'
		};
		await fs.writeFile(
			SYNCSETS_FILE,
			JSON.stringify({ version: 1, sets: [legacySet] }),
			'utf8'
		);
		resetCacheForTests();

		const sets = await listSets();
		const migrated = sets.find((s) => s.id === legacySet.id);
		expect(migrated?.source).toBe(abs('demo/src'));
		expect(migrated?.destinations[0]!.path).toBe(abs('demo/dst'));

		// The file is rewritten with absolute paths (idempotent afterwards).
		const raw = JSON.parse(await fs.readFile(SYNCSETS_FILE, 'utf8')) as { sets: SyncSet[] };
		expect(raw.sets.find((s) => s.id === legacySet.id)?.source).toBe(abs('demo/src'));
		resetCacheForTests();
		const again = await listSets();
		expect(again.find((s) => s.id === legacySet.id)?.source).toBe(abs('demo/src'));
	});
});

describe('sync set persistence', () => {
	const created: SyncSet[] = [];

	afterEach(async () => {
		for (const s of created.splice(0)) await deleteSet(s.id);
	});

	it('creates, updates, lists and deletes', async () => {
		const a = await createSet(makeSet({ name: 'Alpha' }));
		created.push(a);
		const b = await createSet(makeSet({ name: 'Beta' }));
		created.push(b);

		let sets = await listSets();
		expect(sets.map((s) => s.name)).toContain('Alpha');
		expect(sets.map((s) => s.name)).toContain('Beta');

		await updateSet(a.id, { ...a, name: 'Alpha2', syncDeletions: true });
		sets = await listSets();
		expect(sets.find((s) => s.id === a.id)?.name).toBe('Alpha2');
		expect(sets.find((s) => s.id === a.id)?.syncDeletions).toBe(true);

		expect(await deleteSet(b.id)).toBe(true);
		expect(await deleteSet(b.id)).toBe(false);
		sets = await listSets();
		expect(sets.find((s) => s.id === b.id)).toBeUndefined();
	});

	it('round-trips through JSON (export/import shape)', async () => {
		const original = makeSet({ name: 'JsonSet', includeFilters: ['*.txt'], excludeFilters: ['skip'] });
		const stored = await createSet(original);
		created.push(stored);
		// Export = JSON of the set; import = createSet(JSON.parse(...)).
		const exported = JSON.stringify(stored);
		const imported = await createSet(JSON.parse(exported));
		created.push(imported);
		expect(imported.name).toBe('JsonSet');
		expect(imported.includeFilters).toEqual(['*.txt']);
		expect(imported.id).not.toBe(stored.id);
	});
});
