/**
 * Shared types used by both the client UI and the server engine.
 */

export type ErrorPolicy = 'stop' | 'ignore' | 'ask';

export type ConfirmDecision = 'stop' | 'skip' | 'ignore-all' | 'copy-anyway';

/** A single destination directory (all paths are relative to the configured root). */
export interface DestinationConfig {
	/** Stable unique id within the sync set. */
	id: string;
	name: string;
	/** Relative path under the sync root, e.g. "backups/photos". */
	path: string;
	/** Parallel group 1..10. Groups run in numerical order. */
	group: number;
}

export interface SyncSet {
	id: string;
	name: string;
	/** Relative path under the sync root. */
	source: string;
	destinations: DestinationConfig[];
	/** Timestamps differing by at most this many seconds are considered equal. */
	dateDeltaSeconds: number;
	/** Delete destination files that no longer exist in the source. */
	syncDeletions: boolean;
	/** Partial-path filters with '*' wildcards. Empty = include everything. */
	includeFilters: string[];
	excludeFilters: string[];
	/** How to handle errors during sync. */
	errorPolicy: ErrorPolicy;
}

export type ItemAction = 'copy' | 'delete' | 'same';

/** Per-destination decision for one row of the compare plan. */
export interface DestDecision {
	action: ItemAction;
	/** Source stats for copy items, destination stats for delete-only rows. */
	size: number;
	mtime: number;
}

/**
 * One row of a compare plan: a relative path (file or directory) with the
 * decision for every destination directory.
 */
export interface PlanItem {
	relPath: string;
	isDir: boolean;
	/** Source file size (0 for delete-only rows). */
	size: number;
	/** Source modified time in epoch ms (0 for delete-only rows). */
	mtime: number;
	/** Destination id -> decision. Destinations with action 'same' are included. */
	dests: Record<string, DestDecision>;
}

export interface ComparePlan {
	id: string;
	setId: string;
	setName: string;
	createdAt: number;
	/** Copy of relevant sync set settings used for the comparison. */
	source: string;
	dateDeltaSeconds: number;
	syncDeletions: boolean;
	destinations: DestinationConfig[];
	items: PlanItem[];
}

export type DestStatus =
	| 'queued'
	| 'waiting'
	| 'running'
	| 'paused'
	| 'done'
	| 'stopped'
	| 'stopped-error'
	| 'aborted';

export interface DestProgress {
	destId: string;
	status: DestStatus;
	/** Currently copying / deleting file (relative path). */
	currentFile: string | null;
	currentFileBytes: number;
	currentFileSize: number;
	/** Cumulative bytes copied in this destination. */
	copiedBytes: number;
	totalBytes: number;
	filesDone: number;
	filesTotal: number;
	message: string | null;
}

export interface PendingConfirm {
	id: string;
	destId: string;
	destName: string;
	relPath: string;
	kind: 'error' | 'source-changed';
	message: string;
	/** Expected vs. actual metadata, for source-changed confirms. */
	details?: { expectedSize: number; actualSize: number; expectedMtime: number; actualMtime: number };
}

export type SyncEventType =
	| 'run-start'
	| 'dest-status'
	| 'file-start'
	| 'file-progress'
	| 'file-done'
	| 'file-skipped'
	| 'file-deleted'
	| 'dir-created'
	| 'dest-done'
	| 'confirm'
	| 'confirm-resolved'
	| 'run-done'
	| 'runs-cleared'
	| 'log';

/** A destination of a run, as announced in run-start / run records. */
export interface RunDestInfo {
	id: string;
	name: string;
	path: string;
	group: number;
}

/**
 * One sync run in the global run registry: every run ever started by any
 * user in this server process, kept after it finishes until the user clears
 * it. This is what the Status tab shows.
 */
export interface RunRecord {
	runId: string;
	setId: string;
	setName: string;
	startedAt: number;
	/** null while the run is still executing. */
	finishedAt: number | null;
	/** True when the run ended by stopping (vs. completing normally). */
	stopped: boolean;
	dests: RunDestInfo[];
	/** Latest per-destination progress snapshot (aligned with dests by id). */
	progress: DestProgress[];
}

export interface SyncEvent {
	type: SyncEventType;
	runId: string;
	setId: string;
	ts: number;
	destId?: string;
	/** Snapshot of destination progress (dest-status / file events). */
	progress?: DestProgress;
	/** dest-done summary */
	copiedBytes?: number;
	totalBytes?: number;
	filesDone?: number;
	filesTotal?: number;
	error?: string;
	confirm?: PendingConfirm;
	message?: string;
	relPath?: string;
	/** Whether the run is finished (run-done). */
	finished?: boolean;
	/** run-start: the set's name and the run's destination info. */
	setName?: string;
	dests?: RunDestInfo[];
	/** run-done: true when the run ended by stopping. */
	stopped?: boolean;
}

/** Pre-sync free-space warning for one destination (below the 1 GiB floor). */
export interface DestSpaceWarning {
	destId: string;
	name: string;
	path: string;
	/** Bytes that will be copied to this destination. */
	requiredBytes: number;
	/** Bytes currently free at (or above) the destination. */
	availableBytes: number;
	/** Projected free bytes after the sync. */
	projectedFreeBytes: number;
	insufficient: boolean;
}

/** Log list entry (from the first line of a log file). */
export interface SyncLogInfo {
	runId: string;
	setId: string;
	setName: string;
	startedAt: number;
	file: string;
	size: number;
	/** True when the run belongs to the current server session. */
	session: boolean;
}
