/**
 * Destination lock (semaphore) tests.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncManager } from '../src/lib/server/engine';
import { LOCK_FILE } from '../src/lib/server/walker';
import { absPath } from '../src/lib/server/paths';
import { exists, makeSet, mkdirp, mkfile, rmrf, runSync, selectAll } from './helpers';

const NS = 'locks-test';

function lockPath(destRel: string): string {
	return path.join(absPath(destRel), LOCK_FILE);
}

async function waitIdle(setId: string): Promise<void> {
	for (let i = 0; i < 3_000; i++) {
		if (!syncManager.isRunning(setId)) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error('engine never went idle');
}

beforeAll(async () => {
	await rmrf(`${NS}`);
	await mkdirp(`${NS}`);
});

describe('destination lock', () => {
	it('is deleted when the sync finishes', async () => {
		const set = makeSet({
			source: `${NS}/basic/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/basic/dst`, group: 1 }]
		});
		await mkdirp(`${NS}/basic/src`);
		await mkfile(`${NS}/basic/src/a.txt`, 'a');
		const plan = await syncManager.compare(set);
		const obs = await runSync(set, selectAll(plan), plan);
		await obs.waitForRunDone();
		obs.unsubscribe();
		expect(await exists(`${NS}/basic/dst/a.txt`)).toBe(true);
		await expect(fs.access(lockPath(`${NS}/basic/dst`))).rejects.toThrow();
	});

	it('makes a second sync targeting the same destination wait, then proceed', async () => {
		// Set A: pauses mid-run (unreadable file + ask policy) while holding the lock.
		const setA = makeSet({
			source: `${NS}/contended/srcA`,
			destinations: [{ id: 'ad1', name: 'A-Dest', path: `${NS}/contended/dst`, group: 1 }],
			errorPolicy: 'ask'
		});
		// Set B: a different set targeting the SAME destination directory.
		const setB = makeSet({
			source: `${NS}/contended/srcB`,
			destinations: [{ id: 'bd1', name: 'B-Dest', path: `${NS}/contended/dst`, group: 1 }]
		});

		await mkdirp(`${NS}/contended/srcA`);
		await mkdirp(`${NS}/contended/srcB`);
		await mkfile(`${NS}/contended/srcA/bad.txt`, 'bad');
		await mkfile(`${NS}/contended/srcB/good.txt`, 'good');

		const planA = await syncManager.compare(setA);
		await fs.chmod(absPath(`${NS}/contended/srcA/bad.txt`), 0o000);
		const obsA = await runSync(setA, selectAll(planA), planA);
		const confirmA = await obsA.waitForConfirm();

		// While A is paused it owns the lock; the file must exist.
		const lockStat = await fs.stat(lockPath(`${NS}/contended/dst`));
		expect(lockStat.isFile()).toBe(true);

		const planB = await syncManager.compare(setB);
		const obsB = await runSync(setB, selectAll(planB), planB);

		// B must report that it is waiting on the lock.
		await new Promise<void>((resolve, reject) => {
			const t = setInterval(() => {
				const snap = syncManager.snapshot(setB.id);
				if (snap?.progress.some((p) => p.status === 'waiting')) {
					clearInterval(t);
					resolve();
				}
			}, 25);
			setTimeout(() => { clearInterval(t); reject(new Error('B never reported waiting')); }, 10_000).unref?.();
		});
		expect(
			obsB.events.some((e) =>
				e.type === 'log' && e.message?.includes('Waiting 10 seconds to see if lock file is stale')
			)
		).toBe(true);
		// B must not have written its file yet.
		expect(await exists(`${NS}/contended/dst/good.txt`)).toBe(false);

		// Release A: B should take over the lock and finish.
		syncManager.respond(confirmA.id, 'skip');
		await obsA.waitForRunDone();
		await obsB.waitForRunDone();
		obsA.unsubscribe();
		obsB.unsubscribe();

		expect(await exists(`${NS}/contended/dst/good.txt`)).toBe(true);
		// Both runs released the lock.
		await expect(fs.access(lockPath(`${NS}/contended/dst`))).rejects.toThrow();
		await waitIdle(setA.id);
		await waitIdle(setB.id);
	});

	it('breaks a stale lock (untouched for 10+ seconds) and proceeds', async () => {
		const set = makeSet({
			source: `${NS}/stale/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/stale/dst`, group: 1 }]
		});
		await mkdirp(`${NS}/stale/src`);
		await mkfile(`${NS}/stale/src/a.txt`, 'a');
		await mkdirp(`${NS}/stale/dst`);
		// An old, no-longer-touched lock file from a crashed sync.
		const lock = lockPath(`${NS}/stale/dst`);
		await fs.writeFile(lock, JSON.stringify({ runId: 'ghost', pid: -1 }), 'utf8');
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(lock, old, old);

		const plan = await syncManager.compare(set);
		const obs = await runSync(set, selectAll(plan), plan);
		await obs.waitForRunDone();
		obs.unsubscribe();

		expect(
			obs.events.some((e) => e.type === 'log' && e.message?.includes('stale'))
		).toBe(true);
		expect(await exists(`${NS}/stale/dst/a.txt`)).toBe(true);
		// Our own lock was created and then released.
		await expect(fs.access(lock)).rejects.toThrow();
	}, 30_000);
});
