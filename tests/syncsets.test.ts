import { afterEach, describe, expect, it } from 'vitest';
import type { SyncSet } from '../src/lib/types';
import { createSet, deleteSet, listSets, updateSet, validateSyncSet, ValidationError } from '../src/lib/server/syncsets';
import { makeSet } from './helpers';

describe('sync set validation', () => {
	it('rejects paths that escape the root', () => {
		expect(() => validateSyncSet({ ...makeSet(), source: '../outside' }, new Set())).toThrow(ValidationError);
		expect(() =>
			validateSyncSet(
				{
					...makeSet(),
					destinations: [{ id: 'd', name: 'x', path: '../../evil', group: 1 }]
				},
				new Set()
			)
		).toThrow(ValidationError);
	});

	it('rejects duplicate destination paths and source == destination', () => {
		const base = makeSet({
			destinations: [
				{ id: 'd1', name: 'A', path: 'dst', group: 1 },
				{ id: 'd2', name: 'B', path: 'dst', group: 2 }
			]
		});
		expect(() => validateSyncSet(base, new Set())).toThrow(/duplicate/);
		expect(() => validateSyncSet(makeSet({ source: 'x', destinations: [{ id: 'd', name: 'A', path: 'x', group: 1 }] }), new Set())).toThrow(/differ from source/);
	});

	it('rejects invalid groups and error policies', () => {
		expect(() =>
			validateSyncSet(makeSet({ destinations: [{ id: 'd', name: 'A', path: 'dst', group: 11 }] }), new Set())
		).toThrow(/group/);
		expect(() =>
			validateSyncSet(makeSet({ errorPolicy: 'explode' as never }), new Set())
		).toThrow(/errorPolicy/);
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
