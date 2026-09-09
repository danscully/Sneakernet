/**
 * Sync run log files: written per run, readable, and pruned by retention.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncManager } from '../src/lib/server/engine';
import { RunLogger, cleanupOldLogs, logFilePath } from '../src/lib/server/logger';
import { LOG_DIR, LOG_RETENTION_DAYS } from '../src/lib/server/config';
import { exists, makeSet, mkdirp, mkfile, rmrf, runSync, selectAll } from './helpers';

const NS = 'logs-test';

beforeAll(async () => {
	await rmrf(`${NS}`);
	await mkdirp(`${NS}/logs/src`);
	await mkfile(`${NS}/logs/src/a.txt`, 'a');
});

describe('sync logs', () => {
	it('writes a log for every run with header metadata and event lines', async () => {
		const set = makeSet({
			source: `${NS}/logs/src`,
			destinations: [{ id: 'd1', name: 'D1', path: `${NS}/logs/dst`, group: 1 }],
			name: 'Log Test Set'
		});
		const plan = await syncManager.compare(set);
		const obs = await runSync(set, selectAll(plan), plan);
		await obs.waitForRunDone();
		obs.unsubscribe();

		const file = logFilePath(obs.events[0]!.runId);
		// The logger flushes asynchronously after run-done; wait for the tail.
		let content = '';
		for (let i = 0; i < 100; i++) {
			content = await fs.readFile(file, 'utf8').catch(() => '');
			if (content.includes('sync run finished')) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const lines = content.split('\n').filter(Boolean);

		// First line: JSON metadata.
		const meta = JSON.parse(lines[0]!) as { runId: string; setName: string; startedAt: number };
		expect(meta.setName).toBe('Log Test Set');
		expect(meta.runId).toBe(obs.events[0]!.runId);

		// The last metadata record (written on close) marks the run finished.
		const tail = JSON.parse(lines.at(-1)!) as { finishedAt: number | null };
		expect(tail.finishedAt).not.toBeNull();

		// Event lines in between.
		expect(content).toContain('sync run started');
		expect(content).toContain('copy a.txt');
		expect(content).toContain('done a.txt');
		expect(content).toContain('sync run finished');
	});

	it('appends engine log lines (e.g. stale lock messages)', async () => {
		const logger = new RunLogger('unit-log-run', 'set-1', 'Set One');
		logger.handleEvent({
			type: 'log',
			runId: 'unit-log-run',
			setId: 'set-1',
			ts: Date.now(),
			destId: 'd1',
			message: 'hello from the engine'
		});
		await logger.close();
		const content = await fs.readFile(logFilePath('unit-log-run'), 'utf8');
		expect(content).toContain('hello from the engine');
		await fs.unlink(logFilePath('unit-log-run')).catch(() => undefined);
	});

	it('prunes logs older than the retention window', async () => {
		expect(LOG_RETENTION_DAYS).toBe(7);

		const oldFile = path.join(LOG_DIR, 'run-old-test.log');
		await fs.writeFile(oldFile, '{"runId":"old-test"}\n', 'utf8');
		const freshFile = path.join(LOG_DIR, 'run-fresh-test.log');
		await fs.writeFile(freshFile, '{"runId":"fresh-test"}\n', 'utf8');

		const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
		await fs.utimes(oldFile, tenDaysAgo, tenDaysAgo);

		await cleanupOldLogs();

		await expect(fs.access(oldFile)).rejects.toThrow();
		await expect(fs.stat(freshFile)).resolves.toBeDefined(); // still there
		await fs.unlink(freshFile).catch(() => undefined);
	});
});
