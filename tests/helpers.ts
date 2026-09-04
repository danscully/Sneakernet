/**
 * Shared test scaffolding: build directory trees under the configured test
 * root and run sync flows against the engine.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ComparePlan, SyncEvent, SyncSet } from '../src/lib/types';
import { absPath } from '../src/lib/server/paths';
import { syncManager, type Selection } from '../src/lib/server/engine';

export async function mkdirp(rel: string): Promise<void> {
	await fs.mkdir(absPath(rel), { recursive: true });
}

export async function mkfile(rel: string, content: string | Buffer, mtime?: number): Promise<void> {
	const p = absPath(rel);
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, content);
	if (mtime !== undefined) {
		const when = new Date(mtime);
		await fs.utimes(p, when, when);
	}
}

export async function readFile(rel: string): Promise<string> {
	return fs.readFile(absPath(rel), 'utf8');
}

export async function exists(rel: string): Promise<boolean> {
	try {
		await fs.access(absPath(rel));
		return true;
	} catch {
		return false;
	}
}

export async function stat(rel: string): Promise<{ size: number; mtimeMs: number }> {
	const s = await fs.stat(absPath(rel));
	return { size: s.size, mtimeMs: s.mtimeMs };
}

export async function rmrf(rel: string): Promise<void> {
	await fs.rm(absPath(rel), { recursive: true, force: true });
}

export function makeSet(overrides: Partial<SyncSet> = {}): SyncSet {
	return {
		id: randomUUID(),
		name: 'Test Set',
		source: 'src',
		destinations: [{ id: 'd1', name: 'Dest 1', path: 'dst', group: 1 }],
		dateDeltaSeconds: 0,
		syncDeletions: false,
		includeFilters: [],
		excludeFilters: [],
		errorPolicy: 'ask',
		...overrides
	};
}

/** Select every actionable item (copies + deletes) for the given destinations. */
export function selectAll(plan: ComparePlan, destIds?: string[]): Selection {
	const allow = destIds ?? plan.destinations.map((d) => d.id);
	const selection: Selection = {};
	for (const item of plan.items) {
		const ids = allow.filter(
			(id) => item.dests[id] && item.dests[id]!.action !== 'same'
		);
		if (ids.length > 0) selection[item.relPath] = ids;
	}
	return selection;
}

export interface RunObserver {
	events: SyncEvent[];
	unsubscribe(): void;
	waitForRunDone(): Promise<void>;
	waitForConfirm(): Promise<{ id: string; kind: string }>;
}

/**
 * Start a run and observe its events. When `plan` is provided it is used as-is
 * (no re-compare) so mutations made after the compare stay visible to the
 * engine's verification logic.
 */
export async function runSync(
	set: SyncSet,
	selection: Selection,
	plan?: ComparePlan
): Promise<RunObserver> {
	const usePlan = plan ?? (await syncManager.compare(set));
	const events: SyncEvent[] = [];
	const unsubscribe = syncManager.subscribe((e) => {
		if (e.setId === set.id) events.push(e);
	});
	const runId = syncManager.start(usePlan, selection, set.errorPolicy);

	const waitForRunDone = async (): Promise<void> => {
		await new Promise<void>((resolve, reject) => {
			const timer = setInterval(() => {
				if (events.some((e) => e.type === 'run-done')) {
					clearInterval(timer);
					resolve();
				}
			}, 25);
			setTimeout(() => {
				clearInterval(timer);
				reject(new Error('timed out waiting for run-done'));
			}, 60_000).unref?.();
		});
	};

	const waitForConfirm = async (): Promise<{ id: string; kind: string }> => {
		return new Promise((resolve, reject) => {
			const timer = setInterval(() => {
				const snap = syncManager.snapshot(set.id);
				if (snap?.confirm) {
					clearInterval(timer);
					resolve({ id: snap.confirm.id, kind: snap.confirm.kind });
				}
			}, 25);
			setTimeout(() => {
				clearInterval(timer);
				reject(new Error('timed out waiting for a confirm prompt'));
			}, 60_000).unref?.();
		});
	};

	void runId;
	return { events, unsubscribe, waitForRunDone, waitForConfirm };
}
