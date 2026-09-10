/**
 * Per-run sync log files.
 *
 * Every sync run writes a log file to LOG_DIR/run-<runId>.log. The first line
 * is a JSON metadata record; the rest are timestamped text lines derived from
 * the engine's events. Old logs are pruned based on the configured retention
 * (SNEAKERNET_LOG_RETENTION_DAYS / config.json logRetentionDays, default 7).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SyncEvent } from '$lib/types';
import { LOG_DIR, LOG_RETENTION_DAYS } from './config';

export interface SyncLogMeta {
	runId: string;
	setId: string;
	setName: string;
	startedAt: number;
	finishedAt: number | null;
}

const TIME_FMT = new Intl.DateTimeFormat('en-CA', {
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hour12: false
});

function stamp(ts: number): string {
	const d = new Date(ts);
	return `${TIME_FMT.format(d)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function logFilePath(runId: string): string {
	// runId is a server-generated UUID; keep only safe characters.
	const safe = runId.replace(/[^a-zA-Z0-9-]/g, '');
	return path.join(LOG_DIR, `run-${safe}.log`);
}

/**
 * Log writer bound to one run. Subscribed to the manager's events; appends
 * lines to the log file (buffered); must be closed when the run finishes.
 */
export class RunLogger {
	#pending: string[] = [];
	#meta: SyncLogMeta;
	#lastFlush = 0;
	#writePromise: Promise<void> = Promise.resolve();
	#finalMetaWritten = false;

	constructor(runId: string, setId: string, setName: string) {
		this.#meta = { runId, setId, setName, startedAt: Date.now(), finishedAt: null };
		// Header line (JSON meta) is line 1; the list endpoint reads it back.
		this.#pending.push(JSON.stringify(this.#meta));
	}

	handleEvent(e: SyncEvent): void {
		const when = `[${stamp(e.ts)}]`;
		let line: string | null = null;
		const dest = e.destId ? ` dest ${e.destId}` : '';
		switch (e.type) {
			case 'run-start':
				line = `${when} sync run started (set "${this.#meta.setName}")`;
				break;
			case 'dest-status':
				if (e.progress) {
					line = `${when} dest ${e.destId}: status ${e.progress.status}${e.progress.message ? ` - ${e.progress.message}` : ''}`;
				}
				break;
			case 'file-start':
				line = `${when} dest ${e.destId}: copy ${e.relPath} (${e.progress?.currentFileSize ?? 0} B)`;
				break;
			case 'file-progress':
				return; // too chatty; start/done lines carry the info
			case 'file-done':
				line = `${when} dest ${e.destId}: done ${e.relPath} (${e.copiedBytes ?? 0}/${e.totalBytes ?? 0} B, ${e.filesDone ?? 0}/${e.filesTotal ?? 0} files)`;
				break;
			case 'file-skipped':
				line = `${when} dest ${e.destId}: skipped ${e.relPath}${e.message ? ` (${e.message})` : ''}`;
				break;
			case 'file-deleted':
				line = `${when} dest ${e.destId}: deleted ${e.relPath}`;
				break;
			case 'dir-created':
				line = `${when} dest ${e.destId}: created dir ${e.relPath}`;
				break;
			case 'confirm':
				line = `${when} dest ${e.destId}: PAUSED - ${e.confirm?.kind}: ${e.confirm?.message}`;
				break;
			case 'confirm-resolved':
				line = `${when}${dest}: user answered the prompt, sync continues`;
				break;
			case 'log':
				line = `${when}${dest}: ${e.message ?? ''}`;
				break;
			case 'dest-done':
				line = `${when} dest ${e.destId}: finished (${e.filesDone ?? 0}/${e.filesTotal ?? 0} files, ${e.copiedBytes ?? 0} B copied${e.error ? `, error: ${e.error}` : ''})`;
				break;
			case 'run-done':
				this.#meta.finishedAt = e.ts;
				line = `${when} sync run finished`;
				break;
			default:
				break;
		}
		if (line) this.#pending.push(line);
		// Throttled append: at most every 2s (plus a full flush on close).
		if (this.#pending.length >= 1 && Date.now() - this.#lastFlush > 2000) {
			this.#flush();
		}
	}

	#flush(): void {
		if (this.#pending.length === 0) return;
		this.#lastFlush = Date.now();
		const chunk = this.#pending.splice(0, this.#pending.length).join('\n') + '\n';
		this.#writePromise = this.#writePromise.then(async () => {
			await fs.appendFile(logFilePath(this.#meta.runId), chunk, 'utf8').catch(() => {
				/* a failing log write must never break the sync */
			});
		});
	}

	async close(): Promise<void> {
		this.#flush();
		// Final metadata record for the finished run.
		if (!this.#finalMetaWritten && this.#meta.finishedAt !== null) {
			this.#finalMetaWritten = true;
			this.#pending.push(JSON.stringify(this.#meta));
			this.#flush();
		}
		await this.#writePromise;
	}
}

/**
 * Delete log files older than the configured retention. Called on boot and
 * whenever a new run starts.
 */
export async function cleanupOldLogs(): Promise<void> {
	try {
		const entries = await fs.readdir(LOG_DIR);
		const now = Date.now();
		await Promise.all(
			entries
				.filter((f) => f.startsWith('run-') && f.endsWith('.log'))
				.map(async (f) => {
					const full = path.join(LOG_DIR, f);
					try {
						const st = await fs.stat(full);
						if (now - st.mtimeMs > LOG_RETENTION_DAYS * 24 * 3600 * 1000) {
							await fs.unlink(full);
						}
					} catch {
						/* raced; ignore */
					}
				})
		);
	} catch {
		/* logs dir missing; ignore */
	}
}
