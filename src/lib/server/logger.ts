/**
 * Per-run sync log files.
 *
 * Every sync run writes a log file to LOG_DIR/run-<runId>.log. The first line
 * is a JSON metadata record; the rest are TAB-DELIMITED text lines derived
 * from the engine's events:
 *
 *   <timestamp>\t<destination>\t<action>\t<path>\t<statistics>
 *
 * so they can be pasted straight into a spreadsheet. Status lines only appear
 * when a destination's status (or message) actually changes. Old logs are
 * pruned based on the configured retention (SNEAKERNET_LOG_RETENTION_DAYS /
 * config.json logRetentionDays, default 7).
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

/** Human-readable byte size for the statistics column. */
function fmtSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(2)} ${units[unit]}`;
}

/** Format a duration in seconds for the statistics column. */
function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
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
	/** destId -> human name (learned from the run-start event). */
	#destNames = new Map<string, string>();
	/** destId -> last logged `${status}|${message}` (status lines are deduped). */
	#lastStatus = new Map<string, string>();

	constructor(runId: string, setId: string, setName: string) {
		this.#meta = { runId, setId, setName, startedAt: Date.now(), finishedAt: null };
		// Header line (JSON meta) is line 1; the list endpoint reads it back.
		this.#pending.push(JSON.stringify(this.#meta));
	}

	handleEvent(e: SyncEvent): void {
		// Tab-delimited row: timestamp \t destination \t action \t path \t statistics.
		const row = (dest: string | undefined, action: string, path: string, stats: string) =>
			`${stamp(e.ts)}\t${(dest && this.#destNames.get(dest)) || dest || ''}\t${action}\t${path}\t${stats}`;

		let line: string | null = null;
		switch (e.type) {
			case 'run-start':
				// The event carries the destination info (id -> name).
				for (const d of e.dests ?? []) this.#destNames.set(d.id, d.name);
				line = row(undefined, 'run started', '', `set "${this.#meta.setName}"`);
				break;
			case 'dest-status': {
				if (!e.progress || !e.destId) break;
				// Only log a status line when the status (or its message)
				// changed - the engine re-reports 'running' after every file.
				const key = `${e.progress.status}|${e.progress.message ?? ''}`;
				if (this.#lastStatus.get(e.destId) === key) break;
				this.#lastStatus.set(e.destId, key);
				const stats = e.progress.message
					? `${e.progress.status} - ${e.progress.message}`
					: e.progress.status;
				line = row(e.destId, 'status', '', stats);
				break;
			}
			case 'file-start':
				line = row(e.destId, 'copy', e.relPath ?? '', fmtSize(e.progress?.currentFileSize ?? 0));
				break;
			case 'file-progress':
				break; // too chatty; start/done lines carry the info
			case 'file-done':
				line = row(
					e.destId,
					'copied',
					e.relPath ?? '',
					`${fmtSize(e.copiedBytes ?? 0)}/${fmtSize(e.totalBytes ?? 0)}; ${e.filesDone ?? 0}/${e.filesTotal ?? 0} files`
				);
				break;
			case 'file-skipped':
				line = row(e.destId, 'skipped', e.relPath ?? '', e.message ?? '');
				break;
			case 'file-deleted':
				line = row(e.destId, 'deleted', e.relPath ?? '', '');
				break;
			case 'dir-created':
				line = row(e.destId, 'created dir', e.relPath ?? '', '');
				break;
			case 'confirm':
				line = row(
					e.destId,
					'paused',
					e.relPath ?? '',
					`${e.confirm?.kind ?? 'error'}: ${e.confirm?.message ?? ''}`
				);
				break;
			case 'confirm-resolved':
				line = row(e.destId, 'resumed', '', 'prompt answered');
				break;
			case 'log':
				line = row(e.destId, 'log', '', e.message ?? '');
				break;
			case 'dest-done':
				line = row(
					e.destId,
					'finished',
					'',
					`${e.filesDone ?? 0}/${e.filesTotal ?? 0} files; ${fmtSize(e.copiedBytes ?? 0)} copied${e.error ? `; error: ${e.error}` : ''}`
				);
				break;
			case 'run-done':
				this.#meta.finishedAt = e.ts;
				line = row(undefined, 'run finished', '', fmtDuration(e.ts - this.#meta.startedAt));
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
