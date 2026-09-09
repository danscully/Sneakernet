/**
 * Free-space accounting for the pre-sync warning.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import type { ComparePlan, PlanItem } from '../src/lib/types';
import { checkDestinations, diskSpace, MIN_FREE_BYTES, requiredBytesPerDest } from '../src/lib/server/space';
import { mkdirp, rmrf } from './helpers';

const NS = 'space-test';

function fakePlan(dests: { id: string; name: string; path: string }[]): ComparePlan {
	const items: PlanItem[] = [
		{
			relPath: 'small.txt',
			isDir: false,
			size: 1000,
			mtime: Date.now(),
			dests: Object.fromEntries(dests.map((d) => [d.id, { action: 'copy', size: 1000, mtime: 0 }]))
		},
		{
			relPath: 'huge.bin',
			isDir: false,
			size: 4 * 1024 * 1024 * 1024 * 1024, // 4 TiB
			mtime: Date.now(),
			dests: Object.fromEntries(dests.map((d) => [d.id, { action: 'copy', size: 4, mtime: 0 }]))
		},
		{
			relPath: 'to-delete.txt',
			isDir: false,
			size: 5,
			mtime: Date.now(),
			dests: Object.fromEntries(dests.map((d) => [d.id, { action: 'delete', size: 5, mtime: 0 }]))
		}
	];
	return {
		id: 'test-plan',
		setId: 'test-set',
		setName: 'Test',
		createdAt: Date.now(),
		source: 'src',
		dateDeltaSeconds: 0,
		syncDeletions: true,
		destinations: dests.map((d) => ({ ...d, group: 1 })),
		items
	};
}

beforeAll(async () => {
	await rmrf(`${NS}`);
	await mkdirp(`${NS}/dst`);
});

describe('space', () => {
	it('diskSpace reports free space for an existing directory', async () => {
		const space = await diskSpace(`${NS}/dst`);
		expect(space.free).toBeGreaterThan(0);
		expect(space.total).toBeGreaterThan(0);
	});

	it('diskSpace walks up for missing directories', async () => {
		const space = await diskSpace(`${NS}/missing/also-missing`);
		expect(space.free).toBeGreaterThan(0);
	});

	it('counts only selected copy bytes (not deletes or dirs)', () => {
		const plan = fakePlan([{ id: 'd1', name: 'D1', path: `${NS}/dst` }]);
		const all = requiredBytesPerDest(plan, {
			'small.txt': ['d1'],
			'huge.bin': ['d1'],
			'to-delete.txt': ['d1']
		});
		expect(all.get('d1')).toBe(1000 + 4 * 1024 * 1024 * 1024 * 1024);

		// Deselected files do not count.
		const partial = requiredBytesPerDest(plan, { 'small.txt': ['d1'] });
		expect(partial.get('d1')).toBe(1000);

		// Delete-only selections carry no transfer bytes.
		const deletesOnly = requiredBytesPerDest(plan, { 'to-delete.txt': ['d1'] });
		expect(deletesOnly.get('d1')).toBeUndefined();
	});

	it('warns when a destination would fall below 1 GiB free', async () => {
		const plan = fakePlan([{ id: 'd1', name: 'D1', path: `${NS}/dst` }]);
		// A 4 TiB transfer against a normal disk: projected free < 1 GiB.
		const warnings = await checkDestinations(plan, {
			'small.txt': ['d1'],
			'huge.bin': ['d1'],
			'to-delete.txt': ['d1']
		});
		expect(warnings.length).toBe(1);
		expect(warnings[0]!.destId).toBe('d1');
		expect(warnings[0]!.insufficient).toBe(true);
		expect(warnings[0]!.projectedFreeBytes).toBeLessThan(MIN_FREE_BYTES);
		expect(warnings[0]!.requiredBytes).toBe(1000 + 4 * 1024 * 1024 * 1024 * 1024);
	});

	it('does not warn for small transfers on a healthy disk', async () => {
		const plan = fakePlan([{ id: 'd1', name: 'D1', path: `${NS}/dst` }]);
		const warnings = await checkDestinations(plan, {
			'small.txt': ['d1'],
			'to-delete.txt': ['d1']
		});
		expect(warnings.length).toBe(0);
	});
});
