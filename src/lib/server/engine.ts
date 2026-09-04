/**
 * Sync engine: runs the two-phase Compare -> Sync workflow.
 *
 * - Compare produces a plan (which files/dirs to copy or delete per destination).
 * - Start syncs the *selected* plan items only. Files added to the source after
 *   the compare are ignored.
 * - Destination directories are grouped (1..10). Groups run in numerical order;
 *   destinations within a group sync in parallel.
 * - Files are copied to a temp name and atomically renamed on completion.
 * - If a source file changed since the compare, the user is always asked to
 *   confirm before copying it.
 * - Errors follow the sync set policy: stop / ignore / ask. "ask" pauses the
 *   destination until the user responds.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ComparePlan, DestProgress, ErrorPolicy, PendingConfirm, SyncEvent, SyncSet } from '$lib/types';
import { absPath } from './paths';
import { compareSet } from './compare';
import { copyFile, makeDirs, renameFile, setTimes, unlinkFile } from './native';

/** Test/dev escape hatch to force the chunked copy loop (disables clonefile). */
const NO_CLONE = process.env['METFILESYNC_NO_CLONE'] === '1';

export type ConfirmDecision = 'stop' | 'skip' | 'ignore-all' | 'copy-anyway';
/** Selection map: relative path -> destination ids to sync. */
export type Selection = Record<string, string[]>;

interface DestTasks {
	copies: string[];
	deletes: string[];
	dirs: string[];
}

interface DestRun {
	destId: string;
	destName: string;
	destRel: string;
	group: number;
	tasks: DestTasks;
	progress: DestProgress;
	/** Native handle of the in-flight copy, for cancellation. */
	currentCopy: { cancel(): void } | null;
	ignoreErrors: boolean;
	stopped: boolean;
	tempFiles: Set<string>;
	pendingConfirm: PendingConfirm | null;
}

class RunState {
	readonly runId = randomUUID();
	private manager: SyncManager;
	private plan: ComparePlan;
	private selection: Selection;
	private errorPolicy: ErrorPolicy;
	private dests: DestRun[] = [];
	private resolvers = new Map<string, (d: ConfirmDecision) => void>();
	private stopAllRequested = false;
	private lastProgressEmit = new Map<string, number>();

	constructor(manager: SyncManager, plan: ComparePlan, selection: Selection, errorPolicy: ErrorPolicy) {
		this.manager = manager;
		this.plan = plan;
		this.selection = selection;
		this.errorPolicy = errorPolicy;
	}

	get setId(): string {
		return this.plan.setId;
	}

	pendingConfirm(): PendingConfirm | null {
		return this.dests.find((d) => d.pendingConfirm)?.pendingConfirm ?? null;
	}

	respond(confirmId: string, decision: ConfirmDecision): boolean {
		const resolve = this.resolvers.get(confirmId);
		if (!resolve) return false;
		this.resolvers.delete(confirmId);
		this.emit({ type: 'confirm-resolved' });
		resolve(decision);
		return true;
	}

	stopAll(): void {
		this.stopAllRequested = true;
		for (const d of this.dests) this.stopDest(d.destId);
	}

	stopDest(destId: string): void {
		const d = this.dests.find((x) => x.destId === destId);
		if (!d || d.stopped) return;
		d.stopped = true;
		if (d.pendingConfirm) {
			const resolve = this.resolvers.get(d.pendingConfirm.id);
			if (resolve) {
				this.resolvers.delete(d.pendingConfirm.id);
				resolve('stop');
			}
			d.pendingConfirm = null;
		}
		// Cancelling an in-flight copy resolves the worker with cancelled=true.
		d.currentCopy?.cancel();
	}

	snapshot(): { runId: string; progress: DestProgress[]; confirm: PendingConfirm | null } {
		return {
			runId: this.runId,
			progress: this.dests.map((d) => ({ ...d.progress })),
			confirm: this.pendingConfirm()
		};
	}

	private emit(e: Omit<SyncEvent, 'runId' | 'setId' | 'ts'>): void {
		this.manager.emit({ runId: this.runId, setId: this.plan.setId, ts: Date.now(), ...e });
	}

	private setProgress(d: DestRun, patch: Partial<DestProgress>, status?: DestProgress['status']): void {
		Object.assign(d.progress, patch);
		if (status !== undefined) d.progress.status = status;
		this.emit({ type: 'dest-status', destId: d.destId, progress: { ...d.progress } });
	}

	async execute(): Promise<void> {
		// Build per-destination task lists from the plan + selection.
		for (const dest of this.plan.destinations) {
			const tasks: DestTasks = { copies: [], deletes: [], dirs: [] };
			let totalBytes = 0;
			let filesTotal = 0;
			for (const item of this.plan.items) {
				if (!this.selection[item.relPath]?.includes(dest.id)) continue;
				const decision = item.dests[dest.id];
				if (!decision || decision.action === 'same') continue;
				if (item.isDir) {
					if (decision.action === 'copy') tasks.dirs.push(item.relPath);
				} else if (decision.action === 'copy') {
					tasks.copies.push(item.relPath);
					totalBytes += item.size;
					filesTotal += 1;
				} else if (decision.action === 'delete') {
					tasks.deletes.push(item.relPath);
					filesTotal += 1;
				}
			}
			this.dests.push({
				destId: dest.id,
				destName: dest.name,
				destRel: dest.path,
				group: dest.group,
				tasks,
				progress: {
					destId: dest.id,
					status: 'queued',
					currentFile: null,
					currentFileBytes: 0,
					currentFileSize: 0,
					copiedBytes: 0,
					totalBytes,
					filesDone: 0,
					filesTotal,
					message: null
				},
				currentCopy: null,
				ignoreErrors: false,
				stopped: false,
				tempFiles: new Set(),
				pendingConfirm: null
			});
		}

		this.emit({ type: 'run-start' });

		// Groups run in numerical order; destinations within a group in parallel.
		const groups = [...new Set(this.dests.map((d) => d.group))].sort((a, b) => a - b);
		for (const group of groups) {
			if (this.stopAllRequested) break;
			const members = this.dests.filter((d) => d.group === group);
			await Promise.all(members.map((d) => this.runDest(d)));
		}

		this.emit({ type: 'run-done', finished: true });
	}

	private async runDest(d: DestRun): Promise<void> {
		if (d.stopped) {
			this.setProgress(d, { status: 'stopped' });
			this.emitDestDone(d);
			return;
		}
		this.setProgress(d, { status: 'running' });

		const destRootAbs = absPath(d.destRel);
		const srcRootAbs = absPath(this.plan.source);

		try {
			// 1. Create missing directories.
			for (const relPath of d.tasks.dirs) {
				if (d.stopped) break;
				makeDirs(path.join(destRootAbs, relPath));
				this.emit({ type: 'dir-created', destId: d.destId, relPath });
			}

			// 2. Copy selected files (in plan order).
			for (const relPath of d.tasks.copies) {
				if (d.stopped) break;
				const item = this.plan.items.find((i) => i.relPath === relPath);
				if (!item) continue;

				const srcAbs = path.join(srcRootAbs, relPath);
				const destAbs = path.join(destRootAbs, relPath);

				// Verify the source still matches its compare-time metadata.
				const check = await this.checkSource(d, relPath, item);
				if (check === 'stop') break;
				if (check === 'skip') {
					this.emit({ type: 'file-skipped', destId: d.destId, relPath });
					continue;
				}

				// Destination may already have been fixed outside the app.
				if (!(await this.needsCopy(srcAbs, destAbs))) {
					d.progress.filesDone += 1;
					this.emit({
						type: 'file-skipped',
						destId: d.destId,
						relPath,
						message: 'destination already up to date'
					});
					this.emitFileDone(d);
					continue;
				}

				// Copy to a temp name, then rename atomically on completion.
				const dirAbs = path.dirname(destAbs);
				makeDirs(dirAbs);
				const tempAbs = path.join(
					dirAbs,
					`.${path.basename(destAbs)}.mfs-tmp-${this.runId.slice(0, 8)}-${randomUUID().slice(0, 8)}`
				);
				d.tempFiles.add(tempAbs);

				this.setProgress(d, { currentFile: relPath, currentFileBytes: 0, currentFileSize: item.size });
				this.emit({ type: 'file-start', destId: d.destId, relPath, progress: { ...d.progress } });

				try {
					const handle = copyFile(
						srcAbs,
						tempAbs,
						{
							chunkSize: 8 * 1024 * 1024,
							reportEveryBytes: 4 * 1024 * 1024,
							useClone: !NO_CLONE
						},
						(bytes, total) => this.emitProgress(d, relPath, bytes, total)
					);
					d.currentCopy = handle;
					const result = await handle.result;
					d.currentCopy = null;

					if (result.cancelled || d.stopped) {
						this.removeTemp(d, tempAbs);
						break; // d.stopped -> stopped path at the end
					}

					// Preserve the source modification time so the next compare
					// sees the pair as identical.
					setTimes(tempAbs, Date.now(), item.mtime);
					renameFile(tempAbs, destAbs);
					d.tempFiles.delete(tempAbs);

					d.progress.copiedBytes += result.bytes;
				} catch (err) {
					d.currentCopy = null;
					this.removeTemp(d, tempAbs);
					const message = err instanceof Error ? err.message : String(err);
					const handled = await this.handleError(d, relPath, message);
					if (handled === 'stop') break;
					continue;
				}

				d.progress.filesDone += 1;
				this.setProgress(d, { currentFile: null, currentFileBytes: 0, currentFileSize: 0 });
				this.emitFileDone(d);
			}

			// 3. Deletions.
			for (const relPath of d.tasks.deletes) {
				if (d.stopped) break;
				try {
					unlinkFile(path.join(destRootAbs, relPath));
					d.progress.filesDone += 1;
					this.emit({ type: 'file-deleted', destId: d.destId, relPath });
					this.emitFileDone(d);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const handled = await this.handleError(d, relPath, message);
					if (handled === 'stop') break;
				}
			}
		} catch (err) {
			// Structural failure (e.g. destination root cannot be created).
			const message = err instanceof Error ? err.message : String(err);
			this.removeTemps(d);
			d.stopped = true;
			this.setProgress(d, { status: 'stopped-error', message });
			this.emitDestDone(d, message);
			return;
		}

		this.removeTemps(d);
		if (d.stopped) {
			if (d.progress.status !== 'stopped-error') this.setProgress(d, { status: 'stopped' });
			this.emitDestDone(d);
		} else {
			this.setProgress(d, { status: 'done' });
			this.emitDestDone(d);
		}
	}

	private emitFileDone(d: DestRun): void {
		this.emit({
			type: 'file-done',
			destId: d.destId,
			filesDone: d.progress.filesDone,
			filesTotal: d.progress.filesTotal,
			copiedBytes: d.progress.copiedBytes,
			totalBytes: d.progress.totalBytes,
			progress: { ...d.progress }
		});
	}

	private emitDestDone(d: DestRun, error?: string): void {
		this.emit({
			type: 'dest-done',
			destId: d.destId,
			error,
			filesDone: d.progress.filesDone,
			filesTotal: d.progress.filesTotal,
			copiedBytes: d.progress.copiedBytes,
			totalBytes: d.progress.totalBytes,
			progress: { ...d.progress }
		});
	}

	/** Throttled progress emission for the in-flight file. */
	private emitProgress(d: DestRun, relPath: string, bytes: number, total: number): void {
		if (bytes < total) {
			const now = Date.now();
			const last = this.lastProgressEmit.get(d.destId) ?? 0;
			if (now - last < 100) return;
			this.lastProgressEmit.set(d.destId, now);
		}
		d.progress.currentFile = relPath;
		d.progress.currentFileBytes = bytes;
		d.progress.currentFileSize = total;
		this.emit({ type: 'file-progress', destId: d.destId, relPath, progress: { ...d.progress } });
	}

	/**
	 * Verify the source item still matches its compare-time metadata. When the
	 * source changed (or vanished) the user is always asked, regardless of the
	 * error policy. Returns 'ok' to proceed, 'skip', or 'stop'.
	 */
	private async checkSource(
		d: DestRun,
		relPath: string,
		item: { size: number; mtime: number }
	): Promise<'ok' | 'skip' | 'stop'> {
		const srcAbs = path.join(absPath(this.plan.source), relPath);
		let stat;
		try {
			stat = await fs.stat(srcAbs);
		} catch {
			const decision = await this.askUser(
				d,
				relPath,
				'error',
				`Source file no longer exists: ${relPath}`
			);
			return decision === 'stop' ? 'stop' : 'skip';
		}
		if (stat.size !== item.size || Math.abs(stat.mtimeMs - item.mtime) > 1000) {
			const decision = await this.askUser(d, relPath, 'source-changed',
				`Source file changed since the compare: ${relPath}`, {
					expectedSize: item.size,
					actualSize: stat.size,
					expectedMtime: item.mtime,
					actualMtime: stat.mtimeMs
				});
			if (decision === 'copy-anyway' || decision === 'ignore-all') return 'ok';
			if (decision === 'skip') return 'skip';
			d.stopped = true;
			return 'stop';
		}
		return 'ok';
	}

	/** Re-check the destination: has it already been made identical? */
	private async needsCopy(srcAbs: string, destAbs: string): Promise<boolean> {
		let srcStat, dstStat;
		try {
			srcStat = await fs.stat(srcAbs);
			dstStat = await fs.stat(destAbs);
		} catch {
			return true;
		}
		if (dstStat.isDirectory()) return true;
		if (srcStat.size !== dstStat.size) return true;
		return Math.abs(srcStat.mtimeMs - dstStat.mtimeMs) > this.plan.dateDeltaSeconds * 1000;
	}

	/** Handle an error per the sync set policy. Returns 'continue' or 'stop'. */
	private async handleError(d: DestRun, relPath: string, message: string): Promise<'continue' | 'stop'> {
		if (d.ignoreErrors || this.errorPolicy === 'ignore') {
			this.emit({ type: 'file-skipped', destId: d.destId, relPath, message });
			return 'continue';
		}
		if (this.errorPolicy === 'stop') {
			d.stopped = true;
			this.setProgress(d, { status: 'stopped-error', message: `${relPath}: ${message}` });
			return 'stop';
		}
		// 'ask'
		const decision = await this.askUser(d, relPath, 'error', `${relPath}: ${message}`);
		if (decision === 'stop') {
			d.stopped = true;
			this.setProgress(d, { status: 'stopped-error', message: `${relPath}: ${message}` });
			return 'stop';
		}
		if (decision === 'ignore-all') {
			d.ignoreErrors = true;
			this.emit({ type: 'log', destId: d.destId, message: 'ignoring all future errors' });
		}
		return 'continue';
	}

	/**
	 * Pause the destination and wait for the user's decision.
	 * Returns 'stop' if the destination was stopped while waiting.
	 */
	private async askUser(
		d: DestRun,
		relPath: string,
		kind: 'error' | 'source-changed',
		message: string,
		details?: PendingConfirm['details']
	): Promise<ConfirmDecision> {
		if (d.stopped) return 'stop';
		const confirm: PendingConfirm = {
			id: this.manager.nextConfirmId(),
			destId: d.destId,
			destName: d.destName,
			relPath,
			kind,
			message,
			details
		};
		d.pendingConfirm = confirm;
		this.setProgress(d, { status: 'paused', message });
		this.emit({ type: 'confirm', confirm, destId: d.destId });
		const decision = await new Promise<ConfirmDecision>((resolve) => {
			this.resolvers.set(confirm.id, resolve);
		});
		d.pendingConfirm = null;
		this.setProgress(d, { status: 'running', message: null });
		return decision;
	}

	private removeTemp(d: DestRun, tempAbs: string): void {
		d.tempFiles.delete(tempAbs);
		try {
			unlinkFile(tempAbs);
		} catch {
			/* best effort; the native cancel path also unlinks */
		}
	}

	private removeTemps(d: DestRun): void {
		for (const t of [...d.tempFiles]) this.removeTemp(d, t);
	}
}

class SyncManager {
	/** Latest compare plan per sync set. */
	private plans = new Map<string, ComparePlan>();
	private runs = new Map<string, RunState>();
	private subscribers = new Set<(e: SyncEvent) => void>();
	private confirmCounter = 0;

	subscribe(fn: (e: SyncEvent) => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	emit(e: SyncEvent): void {
		for (const sub of this.subscribers) {
			try {
				sub(e);
			} catch {
				/* subscriber errors must never break the engine */
			}
		}
	}

	nextConfirmId(): string {
		this.confirmCounter += 1;
		return `confirm-${this.confirmCounter}`;
	}

	getPlan(setId: string): ComparePlan | undefined {
		return this.plans.get(setId);
	}

	async compare(set: SyncSet): Promise<ComparePlan> {
		if (this.runs.has(set.id)) throw new Error('a sync is currently running for this set');
		const plan = await compareSet(set);
		this.plans.set(set.id, plan);
		return plan;
	}

	isRunning(setId: string): boolean {
		return this.runs.has(setId);
	}

	snapshot(setId: string): ReturnType<RunState['snapshot']> | null {
		const run = this.runs.get(setId);
		return run ? run.snapshot() : null;
	}

	start(plan: ComparePlan, selection: Selection, errorPolicy: ErrorPolicy): string {
		if (this.runs.has(plan.setId)) throw new Error('a sync is already running for this set');
		if (this.plans.get(plan.setId)?.id !== plan.id) {
			throw new Error('the compare plan is stale - run a new compare');
		}
		const run = new RunState(this, plan, selection, errorPolicy);
		this.runs.set(plan.setId, run);
		void run.execute().finally(() => {
			this.runs.delete(plan.setId);
		});
		return run.runId;
	}

	stopDest(setId: string, destId: string | null): void {
		const run = this.runs.get(setId);
		if (!run) return;
		if (destId === null) run.stopAll();
		else run.stopDest(destId);
	}

	respond(confirmId: string, decision: ConfirmDecision): boolean {
		for (const run of this.runs.values()) {
			if (run.respond(confirmId, decision)) return true;
		}
		return false;
	}
}

export const syncManager = new SyncManager();
