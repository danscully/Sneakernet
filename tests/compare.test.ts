import { beforeAll, describe, expect, it } from 'vitest';
import type { ComparePlan } from '../src/lib/types';
import { compareSet } from '../src/lib/server/compare';
import { makeSet, mkfile, mkdirp, rmrf } from './helpers';

const NS = 'compare-test';

describe('compare', () => {
	beforeAll(async () => {
		await rmrf(`${NS}`);
		await mkdirp(`${NS}/src/sub`);
		await mkfile(`${NS}/src/f1.txt`, 'hello');
		await mkfile(`${NS}/src/sub/f2.txt`, 'world');
		await mkfile(`${NS}/src/f3.jpg`, 'jpeg');
	});

	function actionsOf(plan: ComparePlan, relPath: string): Record<string, string> {
		const item = plan.items.find((i) => i.relPath === relPath);
		if (!item) return {};
		return Object.fromEntries(
			Object.entries(item.dests).map(([id, d]) => [id, d.action])
		);
	}

	it('plans copies for missing destination content', async () => {
		const set = makeSet({
			source: `${NS}/src`,
			destinations: [
				{ id: 'd1', name: 'D1', path: `${NS}/dst1`, group: 1 },
				{ id: 'd2', name: 'D2', path: `${NS}/dst2`, group: 1 }
			]
		});
		const plan = await compareSet(set);
		// dirs first, then files alphabetically
		expect(plan.items.map((i) => i.relPath)).toEqual(['sub', 'f1.txt', 'f3.jpg', 'sub/f2.txt']);
		for (const item of plan.items) {
			expect(actionsOf(plan, item.relPath)).toEqual({ d1: 'copy', d2: 'copy' });
		}
		const f1 = plan.items.find((i) => i.relPath === 'f1.txt')!;
		expect(f1.size).toBe(5);
		expect(typeof f1.mtime).toBe('number');
	});

	it('marks identical files as same', async () => {
		await mkdirp(`${NS}/same`);
		const mtime = Date.parse('2021-01-01T00:00:00Z');
		await mkfile(`${NS}/same/src/a.txt`, 'same', mtime);
		await mkfile(`${NS}/same/dst/a.txt`, 'same', mtime);
		const set = makeSet({ source: `${NS}/same/src`, destinations: [{ id: 'd1', name: 'D1', path: `${NS}/same/dst`, group: 1 }] });
		const plan = await compareSet(set);
		expect(plan.items.filter((i) => !i.isDir)).toEqual([]);
	});

	it('detects differences via size and datestamp with delta', async () => {
		await mkdirp(`${NS}/delta/src`);
		await mkdirp(`${NS}/delta/dst`);
		// same size, mtime within delta -> same
		await mkfile(`${NS}/delta/src/a.txt`, '12345', 1_000_000_000_000);
		await mkfile(`${NS}/delta/dst/a.txt`, '12345', 1_000_000_000_000 + 1_500);
		// same size, mtime outside delta -> copy
		await mkfile(`${NS}/delta/src/b.txt`, '12345', 1_000_000_000_000);
		await mkfile(`${NS}/delta/dst/b.txt`, '12345', 1_000_000_000_000 + 5_000);
		// different size -> copy
		await mkfile(`${NS}/delta/src/c.txt`, '123456', 1_000_000_000_000);
		await mkfile(`${NS}/delta/dst/c.txt`, '123', 1_000_000_000_000);

		const set = makeSet({
			source: `${NS}/delta/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/delta/dst`, group: 1 }],
			dateDeltaSeconds: 2
		});
		const plan = await compareSet(set);
		const actions: Record<string, string> = {};
		for (const item of plan.items) actions[item.relPath] = item.dests['d1']!.action;
		expect(actions).toEqual({ 'b.txt': 'copy', 'c.txt': 'copy' });
	});

	it('plans deletions only when syncDeletions is enabled', async () => {
		await mkdirp(`${NS}/del/src`);
		await mkdirp(`${NS}/del/dst`);
		const mtime = Date.parse('2021-01-01T00:00:00Z');
		await mkfile(`${NS}/del/src/new.txt`, 'new', mtime);
		await mkfile(`${NS}/del/dst/new.txt`, 'new', mtime);
		await mkfile(`${NS}/del/dst/obsolete.txt`, 'old');

		const base = {
			source: `${NS}/del/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/del/dst`, group: 1 }],
			syncDeletions: false
		};
		const off = await compareSet(makeSet(base));
		expect(off.items.filter((i) => !i.isDir).map((i) => i.relPath)).toEqual([]);

		const on = await compareSet(makeSet({ ...base, syncDeletions: true }));
		const obsolete = on.items.find((i) => i.relPath === 'obsolete.txt')!;
		expect(obsolete.dests['d1']!.action).toBe('delete');
		expect(obsolete.size).toBe(3);
	});

	it('applies include filters then exclude filters', async () => {
		await mkdirp(`${NS}/filters/src/keep`);
		await mkfile(`${NS}/filters/src/keep/a.txt`, 'a');
		await mkfile(`${NS}/filters/src/keep/b.log`, 'b');
		await mkfile(`${NS}/filters/src/c.txt`, 'c');

		const set = makeSet({
			source: `${NS}/filters/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/filters/dst`, group: 1 }],
			includeFilters: ['*.txt'],
			excludeFilters: ['c.txt']
		});
		const plan = await compareSet(set);
		// 'keep' matches no include filter (it is a dir, not a .txt file); only
		// keep/a.txt is planned. b.log fails the include, c.txt the exclude.
		expect(plan.items.map((i) => i.relPath)).toEqual(['keep/a.txt']);
	});

	it('reports per-destination actions independently', async () => {
		await mkdirp(`${NS}/mixed/src`);
		await mkdirp(`${NS}/mixed/dst2`);
		const mtime = Date.parse('2021-01-01T00:00:00Z');
		await mkfile(`${NS}/mixed/src/a.txt`, 'x', mtime);
		await mkfile(`${NS}/mixed/dst2/a.txt`, 'x', mtime);
		const set = makeSet({
			source: `${NS}/mixed/src`,
			destinations: [
				{ id: 'd1', name: 'D1', path: `${NS}/mixed/dst1`, group: 1 },
				{ id: 'd2', name: 'D2', path: `${NS}/mixed/dst2`, group: 1 }
			]
		});
		const plan = await compareSet(set);
		expect(actionsOf(plan, 'a.txt')).toEqual({ d1: 'copy', d2: 'same' });
	});
});
