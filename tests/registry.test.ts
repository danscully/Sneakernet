/**
 * Global run registry tests (the Status view's data source): every run of
 * every set/user stays in the registry after it finishes - with start/finish
 * stamps - until it is explicitly cleared, and clearing never touches
 * running syncs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { syncManager } from '../src/lib/server/engine';
import { makeSet, mkdirp, mkfile, rmrf, runSync, selectAll } from './helpers';

const NS = 'registry-test';

/** A set whose sync completes quickly. */
function quickSet(name: string, subdir: string) {
	return makeSet({
		name,
		source: `${NS}/${subdir}/src`,
		destinations: [{ id: 'd1', name: 'D1', path: `${NS}/${subdir}/dst`, group: 1 }]
	});
}

beforeAll(async () => {
	await rmrf(NS);
	await mkdirp(NS);
});

describe('run registry', () => {
	it('keeps finished runs with start/finish stamps until cleared', async () => {
		const set = quickSet('Registry Set', 'keep');
		await mkdirp(`${NS}/keep/src`);
		await mkfile(`${NS}/keep/src/f.txt`, 'data');
		const obs = await runSync(set, selectAll(await syncManager.compare(set)));
		await obs.waitForRunDone();
		obs.unsubscribe();

		const runs = syncManager.runsSnapshot();
		expect(runs.length).toBeGreaterThanOrEqual(1);
		const run = runs.at(-1)!;
		expect(run.setId).toBe(set.id);
		expect(run.setName).toBe('Registry Set');
		expect(run.finishedAt).not.toBeNull();
		expect(run.finishedAt!).toBeGreaterThanOrEqual(run.startedAt);
		expect(run.stopped).toBe(false);
		expect(run.dests.map((d) => d.id)).toEqual(['d1']);
		expect(run.progress.find((p) => p.destId === 'd1')?.status).toBe('done');

		// The run-start event announced the set name + destination info.
		const start = obs.events.find((e) => e.type === 'run-start')!;
		expect(start.setName).toBe('Registry Set');
		expect(start.dests?.[0]).toMatchObject({ id: 'd1', name: 'D1', group: 1 });
		// The run-done event reports whether the run ended by stopping.
		const done = obs.events.find((e) => e.type === 'run-done')!;
		expect(done.stopped).toBe(false);

		// Clearing removes finished runs.
		syncManager.clearCompleted();
		expect(syncManager.runsSnapshot()).toEqual([]);
	});

	it('marks runs that end by stopping as stopped', async () => {
		const set = quickSet('Stopped Set', 'stopped');
		await mkdirp(`${NS}/stopped/src`);
		await mkfile(`${NS}/stopped/src/f.txt`, 'data');
		const obs = await runSync(set, selectAll(await syncManager.compare(set)));
		syncManager.stopDest(set.id, null);
		await obs.waitForRunDone();
		obs.unsubscribe();

		const run = syncManager.runsSnapshot().at(-1)!;
		expect(run.setId).toBe(set.id);
		expect(run.stopped).toBe(true);
		expect(run.finishedAt).not.toBeNull();

		syncManager.clearCompleted();
	});

	it('clearCompleted never touches a running sync', async () => {
		const set = quickSet('Running Set', 'running');
		set.errorPolicy = 'ask';
		await rmrf(`${NS}/running/src`);
		await mkdirp(`${NS}/running/src`);
		await mkfile(`${NS}/running/src/f.txt`, 'data');
		const plan = await syncManager.compare(set);
		// Change the source after the compare: the engine will pause on a
		// confirm prompt, keeping the run alive while we clear.
		await mkfile(`${NS}/running/src/f.txt`, 'changed');

		const obs = await runSync(set, selectAll(plan), plan);
		const confirm = await obs.waitForConfirm();

		syncManager.clearCompleted();
		let runs = syncManager.runsSnapshot();
		expect(runs.length).toBe(1);
		expect(runs[0]!.finishedAt).toBeNull();
		expect(syncManager.isRunning(set.id)).toBe(true);

		// Let the paused run finish and clean up.
		expect(syncManager.respond(confirm.id, 'skip')).toBe(true);
		await obs.waitForRunDone();
		obs.unsubscribe();

		runs = syncManager.runsSnapshot();
		expect(runs.length).toBe(1);
		expect(runs[0]!.finishedAt).not.toBeNull();

		syncManager.clearCompleted();
		expect(syncManager.runsSnapshot()).toEqual([]);
	});
});
