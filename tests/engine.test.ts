/**
 * End-to-end engine tests: compare -> select -> sync against real directory
 * trees under the test root, using the native copy engine (chunked path).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SyncEvent, SyncSet } from '../src/lib/types';
import { syncManager } from '../src/lib/server/engine';
import { compareSet } from '../src/lib/server/compare';
import { absPath } from '../src/lib/server/paths';
import { exists, makeSet, mkdirp, mkfile, readFile, rmrf, runSync, selectAll, stat } from './helpers';

const NS = 'engine-test';

/** Wait until no run is active for the set. */
async function waitIdle(setId: string): Promise<void> {
	for (let i = 0; i < 2_000; i++) {
		if (!syncManager.isRunning(setId)) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error('engine never went idle');
}

beforeAll(async () => {
	await rmrf(NS);
	await mkdirp(`${NS}`);
});

describe('engine: happy path', () => {
	it('copies selected files, creates dirs, preserves timestamps', async () => {
		const set = makeSet({
			source: `${NS}/basic/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/basic/dst`, group: 1 }]
		});
		await mkdirp(`${NS}/basic/src/sub`);
		const mtime = Date.parse('2021-03-04T05:06:07Z');
		await mkfile(`${NS}/basic/src/a.txt`, 'alpha', mtime);
		await mkfile(`${NS}/basic/src/sub/b.bin`, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), mtime);

		const plan = await syncManager.compare(set);
		const obs = await runSync(set, selectAll(plan));
		await obs.waitForRunDone();
		obs.unsubscribe();

		expect(await readFile(`${NS}/basic/dst/a.txt`)).toBe('alpha');
		expect((await fs.readFile(absPath(`${NS}/basic/dst/sub/b.bin`))).length).toBe(8);
		const srcStat = await stat(`${NS}/basic/src/a.txt`);
		const dstStat = await stat(`${NS}/basic/dst/a.txt`);
		expect(dstStat.size).toBe(srcStat.size);
		expect(Math.abs(dstStat.mtimeMs - srcStat.mtimeMs)).toBeLessThan(1500);

		// A fresh compare must find nothing to do (timestamps preserved).
		const plan2 = await compareSet(set);
		expect(plan2.items).toEqual([]);

		// No temp files left behind.
		await expect(noTempFiles(`${NS}/basic/dst`)).resolves.toEqual(0);
	});

	it('emits file-progress events with byte counts', async () => {
		const set = makeSet({
			source: `${NS}/progress/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/progress/dst`, group: 1 }]
		});
		await mkdirp(`${NS}/progress/src`);
		const buf = crypto.randomBytes(64 * 1024 * 1024);
		await fs.writeFile(absPath(`${NS}/progress/src/big.bin`), buf);

		const plan = await syncManager.compare(set);
		const obs = await runSync(set, selectAll(plan));
		await obs.waitForRunDone();
		obs.unsubscribe();

		const progress = obs.events.filter((e) => e.type === 'file-progress');
		// A fast copy may only produce a couple of throttled updates; the first
		// and final events are always delivered.
		expect(progress.length).toBeGreaterThanOrEqual(2);
		const bytes = progress.map((e) => e.progress?.currentFileBytes ?? 0);
		for (let i = 1; i < bytes.length; i++) expect(bytes[i]).toBeGreaterThanOrEqual(bytes[i - 1]);
		expect(bytes.at(-1)).toBe(64 * 1024 * 1024);
		expect(
			obs.events.filter((e) => e.type === 'dest-done' && e.destId === 'd1').length
		).toBe(1);
		expect(buf.subarray(0, 16).toString('hex')).toBe(
			(await fs.readFile(absPath(`${NS}/progress/dst/big.bin`))).subarray(0, 16).toString('hex')
		);
	});

	it('deletes destination-only files when syncDeletions is on', async () => {
		const set = makeSet({
			source: `${NS}/deletions/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/deletions/dst`, group: 1 }],
			syncDeletions: true
		});
		await mkdirp(`${NS}/deletions/src`);
		await mkdirp(`${NS}/deletions/dst`);
		await mkfile(`${NS}/deletions/src/keep.txt`, 'keep');
		await mkfile(`${NS}/deletions/src/new.txt`, 'new');
		await mkfile(`${NS}/deletions/dst/keep.txt`, 'keep');
		await mkfile(`${NS}/deletions/dst/stale.txt`, 'stale');

		const plan = await syncManager.compare(set);
		const obs = await runSync(set, selectAll(plan));
		await obs.waitForRunDone();
		obs.unsubscribe();

		expect(await exists(`${NS}/deletions/dst/stale.txt`)).toBe(false);
		expect(await exists(`${NS}/deletions/dst/new.txt`)).toBe(true);
		await waitIdle(set.id);
	});

	it('honors the selection: deselected files are not synced', async () => {
		const set = makeSet({
			source: `${NS}/select/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/select/dst`, group: 1 }]
		});
		await mkdirp(`${NS}/select/src`);
		await mkfile(`${NS}/select/src/a.txt`, 'a');
		await mkfile(`${NS}/select/src/b.txt`, 'b');

		const plan = await syncManager.compare(set);
		const obs = await runSync(set, { 'a.txt': ['d1'] });
		await obs.waitForRunDone();
		obs.unsubscribe();

		expect(await exists(`${NS}/select/dst/a.txt`)).toBe(true);
		expect(await exists(`${NS}/select/dst/b.txt`)).toBe(false);
	});

	it('per-destination deselection via the selection map', async () => {
		const set = makeSet({
			source: `${NS}/perdest/src`,
			destinations: [
				{ id: 'd1', name: 'D1', path: `${NS}/perdest/dst1`, group: 1 },
				{ id: 'd2', name: 'D2', path: `${NS}/perdest/dst2`, group: 1 }
			]
		});
		await mkdirp(`${NS}/perdest/src`);
		await mkfile(`${NS}/perdest/src/a.txt`, 'a');

		const plan = await syncManager.compare(set);
		const obs = await runSync(set, { 'a.txt': ['d1'] });
		await obs.waitForRunDone();
		obs.unsubscribe();

		expect(await exists(`${NS}/perdest/dst1/a.txt`)).toBe(true);
		expect(await exists(`${NS}/perdest/dst2/a.txt`)).toBe(false);
	});

	it('does not sync files added after the compare', async () => {
		const set = makeSet({
			source: `${NS}/postcompare/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/postcompare/dst`, group: 1 }]
		});
		await mkdirp(`${NS}/postcompare/src`);
		await mkfile(`${NS}/postcompare/src/a.txt`, 'a');

		const plan = await syncManager.compare(set);
		await mkfile(`${NS}/postcompare/src/sneaky.txt`, 'late');
		const obs = await runSync(set, selectAll(plan));
		await obs.waitForRunDone();
		obs.unsubscribe();

		expect(await exists(`${NS}/postcompare/dst/sneaky.txt`)).toBe(false);
		expect(await exists(`${NS}/postcompare/dst/a.txt`)).toBe(true);
	});

	it('skips files that became up-to-date after the compare', async () => {
		const set = makeSet({
			source: `${NS}/uptodate/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/uptodate/dst`, group: 1 }],
			dateDeltaSeconds: 2
		});
		await mkdirp(`${NS}/uptodate/src`);
		await mkfile(`${NS}/uptodate/src/a.txt`, 'same');
		const plan = await syncManager.compare(set);
		// Someone else fixes the destination in between.
		await mkdirp(`${NS}/uptodate/dst`);
		await mkfile(`${NS}/uptodate/dst/a.txt`, 'same', Date.now());
		const obs = await runSync(set, selectAll(plan), plan);
		await obs.waitForRunDone();
		obs.unsubscribe();

		expect(
			obs.events.some(
				(e) => e.type === 'file-skipped' && e.message === 'destination already up to date'
			)
		).toBe(true);
	});
});

describe('engine: groups', () => {
	it('syncs groups in numerical order; group 2 waits for a paused group 1', async () => {
		const set = makeSet({
			source: `${NS}/groups/src`,
			destinations: [
				{ id: 'd2', name: 'D2', path: `${NS}/groups/dst2`, group: 2 },
				{ id: 'g1b', name: 'G1B', path: `${NS}/groups/dst1b`, group: 1 },
				{ id: 'g1a', name: 'G1A', path: `${NS}/groups/dst1a`, group: 1 }
			],
			errorPolicy: 'ask'
		});
		await mkdirp(`${NS}/groups/src`);
		await mkfile(`${NS}/groups/src/bad.txt`, 'bad');
		await mkfile(`${NS}/groups/src/good.txt`, 'good');
		// Only g1a fails: its destination already contains a *directory* named
		// bad.txt, so the copy cannot create the file there.
		await mkdirp(`${NS}/groups/dst1a/bad.txt`);
		const plan = await syncManager.compare(set);

		const obs = await runSync(set, selectAll(plan));
		// Group 1 (g1a + g1b) is still blocked on the confirm prompt, and no
		// group-2 destination may have done anything yet.
		const confirm = await obs.waitForConfirm();
		expect(confirm.kind).toBe('error');
		expect(obs.events.filter((e) => e.destId === 'd2').length).toBe(0);
		expect(await exists(`${NS}/groups/dst1b/good.txt`)).toBe(true);
		expect(await exists(`${NS}/groups/dst2/good.txt`)).toBe(false);

		// Releasing the pause lets group 1 finish, then group 2 runs.
		expect(syncManager.respond(confirm.id, 'skip')).toBe(true);
		for (let i = 0; i < 10; i++) {
			await new Promise((r) => setTimeout(r, 50));
			const snap = syncManager.snapshot(set.id);
			if (!snap?.confirm) break;
			// Give the engine a chance to clear an already-answered confirm before
			// treating the next one as new.
			if (!syncManager.respond(snap.confirm.id, 'skip')) break;
		}
		await obs.waitForRunDone();
		obs.unsubscribe();

		expect(await exists(`${NS}/groups/dst1a/good.txt`)).toBe(true);
		expect(await exists(`${NS}/groups/dst2/good.txt`)).toBe(true);
		expect(await exists(`${NS}/groups/dst2/bad.txt`)).toBe(true);
	});
});

describe('engine: errors and confirmations', () => {
	it('errorPolicy stop halts the destination', async () => {
		const set = makeSet({
			source: `${NS}/errstop/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/errstop/dst`, group: 1 }],
			errorPolicy: 'stop'
		});
		await mkdirp(`${NS}/errstop/src`);
		await mkfile(`${NS}/errstop/src/a.txt`, 'a');
		await mkfile(`${NS}/errstop/src/z.txt`, 'z');
		const plan = await syncManager.compare(set);
		// Make copying impossible: remove read permission from the source files.
		await fs.chmod(absPath(`${NS}/errstop/src/a.txt`), 0o000);
		const obs = await runSync(set, selectAll(plan));
		await obs.waitForRunDone();
		obs.unsubscribe();

		const destDone = obs.events.find((e) => e.type === 'dest-done' && e.destId === 'd1')!;
		expect(destDone.progress?.status).toBe('stopped-error');
		// z.txt (later in plan order) must not have been copied.
		expect(await exists(`${NS}/errstop/dst/z.txt`)).toBe(false);
		await fs.chmod(absPath(`${NS}/errstop/src/a.txt`), 0o644);
	});

	it('errorPolicy ignore continues past errors', async () => {
		const set = makeSet({
			source: `${NS}/errignore/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/errignore/dst`, group: 1 }],
			errorPolicy: 'ignore'
		});
		await mkdirp(`${NS}/errignore/src`);
		await mkfile(`${NS}/errignore/src/a.txt`, 'a');
		await mkfile(`${NS}/errignore/src/z.txt`, 'z');
		const plan = await syncManager.compare(set);
		await fs.chmod(absPath(`${NS}/errignore/src/a.txt`), 0o000);
		const obs = await runSync(set, selectAll(plan));
		await obs.waitForRunDone();
		obs.unsubscribe();

		expect(await exists(`${NS}/errignore/dst/z.txt`)).toBe(true);
		expect(await exists(`${NS}/errignore/dst/a.txt`)).toBe(false);
		const destDone = obs.events.find((e) => e.type === 'dest-done' && e.destId === 'd1')!;
		expect(destDone.progress?.status).toBe('done');
		await fs.chmod(absPath(`${NS}/errignore/src/a.txt`), 0o644);
	});

	it('errorPolicy ask pauses and can be told to skip or ignore-all', async () => {
		const set = makeSet({
			source: `${NS}/errask/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/errask/dst`, group: 1 }],
			errorPolicy: 'ask'
		});
		await mkdirp(`${NS}/errask/src`);
		await mkfile(`${NS}/errask/src/a.txt`, 'a');
		await mkfile(`${NS}/errask/src/b.txt`, 'b');
		await mkfile(`${NS}/errask/src/z.txt`, 'z');
		const plan = await syncManager.compare(set);
		await fs.chmod(absPath(`${NS}/errask/src/a.txt`), 0o000);
		await fs.chmod(absPath(`${NS}/errask/src/b.txt`), 0o000);

		const obs = await runSync(set, selectAll(plan));
		const c1 = await obs.waitForConfirm();
		expect(c1.kind).toBe('error');
		expect(syncManager.respond(c1.id, 'skip')).toBe(true);

		const c2 = await obs.waitForConfirm();
		expect(syncManager.respond(c2.id, 'ignore-all')).toBe(true);

		await obs.waitForRunDone();
		obs.unsubscribe();
		expect(await exists(`${NS}/errask/dst/z.txt`)).toBe(true);
		expect(await exists(`${NS}/errask/dst/a.txt`)).toBe(false);
		await fs.chmod(absPath(`${NS}/errask/src/a.txt`), 0o644);
		await fs.chmod(absPath(`${NS}/errask/src/b.txt`), 0o644);
	});

	it('asks for confirmation when the source changed since the compare', async () => {
		const set = makeSet({
			source: `${NS}/changed/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/changed/dst`, group: 1 }]
		});
		await mkdirp(`${NS}/changed/src`);
		await mkfile(`${NS}/changed/src/a.txt`, 'before');
		const plan = await syncManager.compare(set);
		await mkfile(`${NS}/changed/src/a.txt`, 'after - much longer');

		const obs = await runSync(set, selectAll(plan), plan);
		const c = await obs.waitForConfirm();
		expect(c.kind).toBe('source-changed');
		expect(syncManager.respond(c.id, 'copy-anyway')).toBe(true);
		await obs.waitForRunDone();
		obs.unsubscribe();
		expect(await readFile(`${NS}/changed/dst/a.txt`)).toBe('after - much longer');
	});

	it('respects a "skip" answer for a changed source', async () => {
		const set = makeSet({
			source: `${NS}/changedskip/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/changedskip/dst`, group: 1 }]
		});
		await mkdirp(`${NS}/changedskip/src`);
		await mkfile(`${NS}/changedskip/src/a.txt`, 'before');
		const plan = await syncManager.compare(set);
		await mkfile(`${NS}/changedskip/src/a.txt`, 'changed');

		const obs = await runSync(set, selectAll(plan), plan);
		const c = await obs.waitForConfirm();
		syncManager.respond(c.id, 'skip');
		await obs.waitForRunDone();
		obs.unsubscribe();
		expect(await exists(`${NS}/changedskip/dst/a.txt`)).toBe(false);
	});
});

describe('engine: stopping', () => {
	it('stops a destination mid-copy and removes temp files', async () => {
		const set = makeSet({
			source: `${NS}/stop/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/stop/dst`, group: 1 }]
		});
		await mkdirp(`${NS}/stop/src`);
		await fs.writeFile(absPath(`${NS}/stop/src/big.bin`), crypto.randomBytes(256 * 1024 * 1024));
		// Plan order is alphabetical, so zz-after.txt is copied only after the
		// big file; stopping mid-copy must leave it unsynced.
		await mkfile(`${NS}/stop/src/zz-after.txt`, 'after');
		const plan = await syncManager.compare(set);

		const obs = await runSync(set, selectAll(plan));
		// Wait for progress on the big file, then stop.
		await new Promise<void>((resolve, reject) => {
			const timer = setInterval(() => {
				if (obs.events.some((e) => e.type === 'file-progress')) {
					clearInterval(timer);
					resolve();
				}
			}, 20);
			setTimeout(() => reject(new Error('no progress events')), 30_000).unref?.();
		});
		syncManager.stopDest(set.id, 'd1');
		await obs.waitForRunDone();
		obs.unsubscribe();

		const destDone = obs.events.find((e) => e.type === 'dest-done' && e.destId === 'd1')!;
		expect(destDone.progress?.status).toBe('stopped');
		expect(await exists(`${NS}/stop/dst/big.bin`)).toBe(false);
		expect(await exists(`${NS}/stop/dst/zz-after.txt`)).toBe(false);
		await expect(noTempFiles(`${NS}/stop/dst`)).resolves.toEqual(0);
		await waitIdle(set.id);
	});

	it('stop all halts every destination', async () => {
		const set = makeSet({
			source: `${NS}/stopall/src`,
			destinations: [
				{ id: 'd1', name: 'D1', path: `${NS}/stopall/dst1`, group: 1 },
				{ id: 'd2', name: 'D2', path: `${NS}/stopall/dst2`, group: 1 }
			]
		});
		await mkdirp(`${NS}/stopall/src`);
		await fs.writeFile(absPath(`${NS}/stopall/src/big.bin`), crypto.randomBytes(256 * 1024 * 1024));
		const plan = await syncManager.compare(set);

		const obs = await runSync(set, selectAll(plan));
		await new Promise<void>((resolve, reject) => {
			const timer = setInterval(() => {
				if (obs.events.filter((e) => e.type === 'file-progress').length >= 2) {
					clearInterval(timer);
					resolve();
				}
			}, 20);
			setTimeout(() => reject(new Error('not enough progress events')), 30_000).unref?.();
		});
		syncManager.stopDest(set.id, null);
		await obs.waitForRunDone();
		obs.unsubscribe();

		for (const d of ['dst1', 'dst2']) {
			const done = obs.events.find((e) => e.type === 'dest-done' && e.destId === (d === 'dst1' ? 'd1' : 'd2'))!;
			expect(done.progress?.status).toBe('stopped');
			await expect(noTempFiles(`${NS}/stopall/${d}`)).resolves.toEqual(0);
		}
	});
});

/** Count leftover MetFileSync temp files in a directory tree. */
async function noTempFiles(rel: string): Promise<number> {
	let count = 0;
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await fs.opendir(dir);
		} catch {
			return;
		}
		for await (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.name.includes('.mfs-tmp-')) count += 1;
			const s = await fs.stat(p).catch(() => null);
			if (s?.isDirectory()) await walk(p);
		}
	}
	await walk(absPath(rel));
	return count;
}
