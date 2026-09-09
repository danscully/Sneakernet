/**
 * Client-side application state (Svelte 5 runes).
 */
import type {
	ComparePlan,
	ConfirmDecision,
	DestinationConfig,
	DestProgress,
	DestSpaceWarning,
	PendingConfirm,
	SyncEvent,
	SyncLogInfo,
	SyncSet
} from '$lib/types';

export interface RateSample {
	ts: number;
	bytes: number;
}

export interface DestView {
	id: string;
	name: string;
	path: string;
	group: number;
	progress: DestProgress;
	startedAt: number | null;
	samples: RateSample[];
}

/** A selectable (copy/delete) destination cell in the compare table. */
function actionableDestIds(plan: ComparePlan, relPath: string): string[] {
	const item = plan.items.find((i) => i.relPath === relPath);
	if (!item) return [];
	return plan.destinations
		.filter((d) => item.dests[d.id] && item.dests[d.id]!.action !== 'same')
		.map((d) => d.id);
}

function blankProgress(destId: string): DestProgress {
	return {
		destId,
		status: 'queued',
		currentFile: null,
		currentFileBytes: 0,
		currentFileSize: 0,
		copiedBytes: 0,
		totalBytes: 0,
		filesDone: 0,
		filesTotal: 0,
		message: null
	};
}

function newDest(overrides: Partial<DestinationConfig> = {}): DestinationConfig {
	return {
		id: crypto.randomUUID().slice(0, 8),
		name: 'Destination',
		path: '',
		group: 1,
		...overrides
	};
}

export function newSyncSet(): SyncSet {
	return {
		id: crypto.randomUUID(),
		name: 'New Sync Set',
		source: '',
		destinations: [newDest({ name: 'Destination 1' })],
		dateDeltaSeconds: 0,
		syncDeletions: false,
		includeFilters: [],
		excludeFilters: [],
		errorPolicy: 'ask'
	};
}

export class AppState {
	sets: SyncSet[] = $state([]);
	activeSetId: string | null = $state(null);
	/** The sync set currently being edited (unsaved changes live here). */
	draft: SyncSet | null = $state(null);
	draftJson: string = $state('');

	plan: ComparePlan | null = $state(null);
	selection: Record<string, string[]> = $state({});
	comparing = $state(false);
	starting = $state(false);

	runId: string | null = $state(null);
	running = $state(false);
	dests: Record<string, DestView> = $state({});
	confirm: PendingConfirm | null = $state(null);
	finishedAt: number | null = $state(null);
	toast: { kind: 'error' | 'info'; text: string } | null = $state(null);

	/** True when the current draft has never been saved (new set or a copy). */
	get draftIsNew(): boolean {
		return this.draft !== null && !this.sets.some((s) => s.id === this.draft?.id);
	}

	/** True when the footer's Save button should be enabled. */
	get canSave(): boolean {
		return this.draft !== null && (this.dirty || this.draftIsNew);
	}

	/**
	 * Duplicate the set being edited as a new, unsaved draft. Saving creates
	 * the copy; cancelling returns to the original set untouched.
	 */
	duplicateSet(): void {
		const source = this.draft ?? this.activeSet;
		if (!source) return;
		const copy = $state.snapshot(source) as SyncSet;
		copy.id = crypto.randomUUID();
		copy.name = `${source.name} (copy)`;
		copy.destinations = copy.destinations.map((d) => ({ ...d, id: crypto.randomUUID().slice(0, 8) }));
		this.draft = copy;
		this.draftJson = JSON.stringify(copy);
		this.showToast('info', 'Editing a copy - press Save to create it');
	}

	/** Discard unsaved draft changes (revert to the saved set, or clear a new draft). */
	discardDraft(): void {
		const set = this.activeSet;
		this.draft = set ? ($state.snapshot(set) as SyncSet) : null;
		this.draftJson = set ? JSON.stringify(set) : '';
	}

	/**
	 * Create a brand-new (unsaved) sync set draft and open the editor modal.
	 * Called from the "Create New SyncSet..." dropdown entry.
	 */
	beginNewSet(): void {
		const set = newSyncSet();
		this.draft = set;
		this.draftJson = JSON.stringify(set);
		this.activeSetId = null;
		this.plan = null;
		this.selection = {};
		this.spaceWarning = null;
		this.settingsOpen = true;
	}

	/** Ticker so elapsed/remaining displays stay live while running. */
	now = $state(Date.now());

	/** Absolute path of the sync root (from the server deployment config). */
	rootPath: string | null = $state(null);

	/** The sync set settings modal (editor lives on the main page now). */
	settingsOpen = $state(false);

	/** Pre-sync free-space warning awaiting user confirmation. */
	spaceWarning: DestSpaceWarning[] | null = $state(null);

	/** Sync run logs. */
	logs: SyncLogInfo[] | null = $state(null);
	logsFilter: 'session' | 'all' = $state('session');
	activeLogId: string | null = $state(null);
	logText: string | null = $state(null);
	loadingLogs = $state(false);
	loadingLogText = $state(false);

	#es: EventSource | null = null;
	#savedDraft = '';

	get activeSet(): SyncSet | null {
		return this.sets.find((s) => s.id === this.activeSetId) ?? null;
	}

	/** Fetch the absolute sync root path (read-only info for the UI). */
	async loadRoot(): Promise<void> {
		const res = await fetch('/api/config');
		if (!res.ok) return;
		const data = (await res.json()) as { root: string };
		this.rootPath = data.root;
	}

	get dirty(): boolean {
		return this.draft !== null && JSON.stringify(this.draft) !== this.draftJson;
	}

	get selectedCount(): number {
		return Object.keys(this.selection).length;
	}

	get selectedBytes(): number {
		if (!this.plan) return 0;
		let total = 0;
		for (const item of this.plan.items) {
			if (!this.selection[item.relPath]?.length) continue;
			if (item.isDir) continue;
			total += item.size;
		}
		return total;
	}

	get selectedDeletes(): number {
		if (!this.plan) return 0;
		let count = 0;
		for (const item of this.plan.items) {
			if (item.isDir) continue;
			for (const dest of this.plan.destinations) {
				if (
					this.selection[item.relPath]?.includes(dest.id) &&
					item.dests[dest.id]?.action === 'delete'
				) {
					count += 1;
				}
			}
		}
		return count;
	}

	get activeDests(): DestView[] {
		return Object.values(this.dests).sort(
			(a, b) => a.group - b.group || a.name.localeCompare(b.name)
		);
	}

	// --- Sync sets -----------------------------------------------------------

	async loadSets(): Promise<void> {
		const res = await fetch('/api/syncsets');
		if (!res.ok) {
			this.showToast('error', 'Could not load sync sets');
			return;
		}
		const data = (await res.json()) as { sets: SyncSet[] };
		this.sets = data.sets;
		if (this.activeSetId === null || !this.sets.some((s) => s.id === this.activeSetId)) {
			const lastUsed = localStorage.getItem('mfs.activeSet');
			this.selectSet(
				this.sets.find((s) => s.id === lastUsed)?.id ?? this.sets[0]?.id ?? null
			);
		}
	}

	selectSet(id: string | null): void {
		if (this.activeSetId === id) return;
		this.activeSetId = id;
		localStorage.setItem('mfs.activeSet', id ?? '');
		const set = this.activeSet;
		// $state.snapshot unwraps the reactive proxy so we can clone it.
		this.draft = set ? ($state.snapshot(set) as SyncSet) : null;
		this.draftJson = set ? JSON.stringify(set) : '';
		this.plan = null;
		this.selection = {};
		this.resetRun();
		if (id) {
			void this.restorePlan();
			this.connectStream(id);
		} else {
			this.closeStream();
		}
	}

	async restorePlan(): Promise<void> {
		const id = this.activeSetId;
		if (!id) return;
		const res = await fetch(`/api/compare?setId=${encodeURIComponent(id)}`);
		if (!res.ok) return;
		const data = (await res.json()) as { plan: ComparePlan };
		if (this.activeSetId === id) this.setPlan(data.plan);
	}

	async saveDraft(): Promise<boolean> {
		const set = this.draft;
		if (!set) return false;
		const existing = this.sets.some((s) => s.id === set.id);
		const res = await fetch(
			existing ? `/api/syncsets/${set.id}` : '/api/syncsets',
			{
				method: existing ? 'PUT' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(set)
			}
		);
		if (!res.ok) {
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			this.showToast('error', data.error ?? 'Could not save sync set');
			return false;
		}
		const data = (await res.json()) as { set: SyncSet };
		this.sets = existing
			? this.sets.map((s) => (s.id === data.set.id ? data.set : s))
			: [...this.sets, data.set];
		this.draft = $state.snapshot(data.set) as SyncSet;
		this.draftJson = JSON.stringify(data.set);
		this.activeSetId = data.set.id;
		localStorage.setItem('mfs.activeSet', data.set.id);
		this.showToast('info', `Saved "${data.set.name}"`);
		return true;
	}

	async deleteActiveSet(): Promise<void> {
		const id = this.activeSetId;
		if (!id) return;
		const res = await fetch(`/api/syncsets/${id}`, { method: 'DELETE' });
		if (!res.ok) {
			this.showToast('error', 'Could not delete sync set');
			return;
		}
		this.sets = this.sets.filter((s) => s.id !== id);
		this.selectSet(this.sets[0]?.id ?? null);
	}

	async importSet(file: File): Promise<void> {
		try {
			const text = await file.text();
			const res = await fetch('/api/syncsets', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: text
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(data.error ?? 'invalid sync set file');
			}
			const data = (await res.json()) as { set: SyncSet };
			this.sets = [...this.sets, data.set];
			this.selectSet(data.set.id);
			this.showToast('info', `Imported "${data.set.name}"`);
		} catch (err) {
			this.showToast('error', err instanceof Error ? err.message : 'import failed');
		}
	}

	exportActiveSet(): void {
		const set = this.draft ?? this.activeSet;
		if (!set) return;
		const blob = new Blob([JSON.stringify(set, null, '\t')], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${set.name.replace(/[^a-z0-9_-]+/gi, '_')}.syncset.json`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	// --- Compare -------------------------------------------------------------

	setPlan(plan: ComparePlan): void {
		this.plan = plan;
		// Default: everything actionable is selected.
		const selection: Record<string, string[]> = {};
		for (const item of plan.items) {
			const ids = actionableDestIds(plan, item.relPath);
			if (ids.length > 0) selection[item.relPath] = ids;
		}
		this.selection = selection;
	}

	async compare(): Promise<void> {
		const id = this.activeSetId;
		if (!id || this.comparing) return;
		// A new compare invalidates the previous run's progress cards.
		this.dests = {};
		this.finishedAt = null;
		this.spaceWarning = null;
		if (this.dirty) {
			this.showToast('error', 'Save the sync set before comparing');
			return;
		}
		if (this.running) {
			this.showToast('error', 'A sync is running for this set');
			return;
		}
		this.comparing = true;
		try {
			const res = await fetch('/api/compare', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ setId: id })
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				this.showToast('error', data.error ?? 'compare failed');
				return;
			}
			const data = (await res.json()) as { plan: ComparePlan };
			if (this.activeSetId === id) this.setPlan(data.plan);
		} finally {
			this.comparing = false;
		}
	}

	isSelected(relPath: string, destId: string): boolean {
		return this.selection[relPath]?.includes(destId) ?? false;
	}

	rowIsFullySelected(relPath: string): boolean {
		if (!this.plan) return false;
		const ids = actionableDestIds(this.plan, relPath);
		return ids.length > 0 && ids.every((id) => this.isSelected(relPath, id));
	}

	toggleRow(relPath: string): void {
		if (!this.plan) return;
		const ids = actionableDestIds(this.plan, relPath);
		if (this.rowIsFullySelected(relPath)) {
			this.selection[relPath] = [];
		} else {
			this.selection[relPath] = [...ids];
		}
	}

	toggleCell(relPath: string, destId: string): void {
		const current = this.selection[relPath] ?? [];
		this.selection[relPath] = current.includes(destId)
			? current.filter((id) => id !== destId)
			: [...current, destId];
	}

	selectAll(): void {
		if (!this.plan) return;
		const selection: Record<string, string[]> = {};
		for (const item of this.plan.items) {
			const ids = actionableDestIds(this.plan, item.relPath);
			if (ids.length > 0) selection[item.relPath] = ids;
		}
		this.selection = selection;
	}

	deselectAll(): void {
		this.selection = {};
	}

	// --- Sync ----------------------------------------------------------------

	/**
	 * Start a sync. Returns true when the sync was started successfully;
	 * when the server reports a low-space warning it is stored in
	 * `spaceWarning` and the caller should ask the user, then re-invoke with
	 * force = true.
	 */
	async startSync(force = false): Promise<boolean> {
		const id = this.activeSetId;
		if (!id || !this.plan || this.running) return false;
		if (this.selectedCount === 0) {
			this.showToast('error', 'Nothing selected to sync');
			return false;
		}
		this.starting = true;
		this.spaceWarning = null;
		// Optimistic state *before* the request: a fast sync can complete on the
		// server before the fetch resolves, in which case the run-done event
		// arrives first and must never be overwritten by this function.
		this.running = true;
		this.finishedAt = null;
		this.dests = {};
		this.confirm = null;
		try {
			const res = await fetch('/api/sync/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ setId: id, selection: this.selection, force })
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				this.running = false;
				this.showToast('error', data.error ?? 'could not start sync');
				return false;
			}
			const data = (await res.json()) as {
				started: boolean;
				runId?: string;
				warning?: { destinations: DestSpaceWarning[] };
			};
			if (!data.started) {
				// Low-space warning: let the caller confirm, then force.
				this.running = false;
				this.spaceWarning = data.warning?.destinations ?? [];
				return false;
			}
			this.runId = data.runId ?? null;
			// Only add missing views - events may already have populated them.
			this.seedDestViews();
			return true;
		} finally {
			this.starting = false;
		}
	}

	async stopSync(destId: string | null): Promise<void> {
		const id = this.activeSetId;
		if (!id) return;
		await fetch('/api/sync/stop', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ setId: id, destId })
		}).catch(() => this.showToast('error', 'stop request failed'));
	}

	async respondConfirm(decision: ConfirmDecision): Promise<void> {
		const confirm = this.confirm;
		if (!confirm) return;
		this.confirm = null;
		const res = await fetch('/api/sync/confirm', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ confirmId: confirm.id, decision })
		});
		if (!res.ok) {
			this.showToast('error', 'could not deliver the decision');
		}
	}

	// --- Logs -----------------------------------------------------------------

	/** Fetch the list of sync run logs (all runs; filter client-side). */
	async loadLogs(): Promise<void> {
		this.loadingLogs = true;
		try {
			const res = await fetch('/api/logs');
			if (!res.ok) return;
			const data = (await res.json()) as { logs: SyncLogInfo[]; retentionDays: number };
			this.logs = data.logs;
		} finally {
			this.loadingLogs = false;
		}
	}

	/** Open one log (its content is shown in the Logs tab). */
	async openLog(runId: string): Promise<void> {
		this.activeLogId = runId;
		this.logText = null;
		this.loadingLogText = true;
		try {
			const res = await fetch(`/api/logs/${encodeURIComponent(runId)}`);
			if (!res.ok) {
				this.showToast('error', 'could not load the log');
				return;
			}
			const data = (await res.json()) as { content: string };
			this.logText = data.content;
		} finally {
			this.loadingLogText = false;
		}
	}

	get visibleLogs(): SyncLogInfo[] {
		const logs = this.logs ?? [];
		return this.logsFilter === 'session' ? logs.filter((l) => l.session) : logs;
	}

	// --- Live event stream ---------------------------------------------------

	/**
	 * Make sure every destination of the current plan has a view card. Existing
	 * views are never reset - SSE events may have arrived before the start
	 * request resolved, and their progress must be preserved.
	 */
	seedDestViews(): void {
		if (!this.plan) return;
		for (const dest of this.plan.destinations) {
			if (!this.dests[dest.id]) {
				this.dests[dest.id] = {
					id: dest.id,
					name: dest.name,
					path: dest.path,
					group: dest.group,
					progress: blankProgress(dest.id),
					startedAt: null,
					samples: []
				};
			}
		}
	}

	private ensureDestView(destId: string): DestView | null {
		if (this.dests[destId]) return this.dests[destId]!;
		if (!this.plan) return null;
		const dest = this.plan.destinations.find((d) => d.id === destId);
		if (!dest) return null;
		this.dests[destId] = {
			id: destId,
			name: dest.name,
			path: dest.path,
			group: dest.group,
			progress: blankProgress(destId),
			startedAt: null,
			samples: []
		};
		return this.dests[destId]!;
	}

	private applyProgress(destId: string, progress: DestProgress, ts: number): void {
		const view = this.ensureDestView(destId);
		if (!view) return;
		view.progress = { ...progress };
		if (progress.status === 'running' && view.startedAt === null) view.startedAt = ts;
		if (progress.status === 'queued' || progress.status === 'stopped') view.startedAt = null;
		if (progress.copiedBytes !== undefined) {
			view.samples.push({ ts, bytes: progress.copiedBytes });
			const cutoff = ts - 8000;
			while (view.samples.length > 2 && view.samples[0]!.ts < cutoff) view.samples.shift();
		}
	}

	handleEvent(e: SyncEvent): void {
		switch (e.type) {
			case 'run-start':
				this.running = true;
				this.finishedAt = null;
				this.seedDestViews();
				break;
			case 'dest-status':
			case 'file-start':
			case 'file-progress':
			case 'file-done':
				if (e.progress && e.destId) this.applyProgress(e.destId, e.progress, e.ts);
				break;
			case 'confirm':
				this.confirm = e.confirm ?? null;
				break;
			case 'confirm-resolved':
				this.confirm = null;
				break;
			case 'log':
				if (e.message) this.showToast('info', e.message);
				break;
			case 'dest-done':
				if (e.progress && e.destId) this.applyProgress(e.destId, e.progress, e.ts);
				break;
			case 'run-done':
				this.running = false;
				this.confirm = null;
				this.finishedAt = e.ts;
				break;
			default:
				break;
		}
		if (e.type === 'file-skipped' && e.message && !e.message.includes('up to date')) {
			this.showToast('info', `Skipped ${e.relPath}: ${e.message}`);
		}
	}

	connectStream(setId: string): void {
		this.closeStream();
		this.#es = new EventSource(`/api/sync/stream?setId=${encodeURIComponent(setId)}`);
		this.#es.addEventListener('snapshot', (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as {
				snapshot: { runId: string; progress: DestProgress[]; confirm: PendingConfirm | null } | null;
			};
			if (!data.snapshot) {
				this.running = false;
				this.runId = null;
				this.confirm = null;
				this.dests = {};
				return;
			}
			this.running = true;
			this.runId = data.snapshot.runId;
			this.confirm = data.snapshot.confirm;
			// Seed views if we do not have them yet (e.g. page reload mid-run).
			if (!this.plan) return;
			for (const p of data.snapshot.progress) this.applyProgress(p.destId, p, Date.now());
		});
		this.#es.addEventListener('event', (ev) => {
			this.handleEvent(JSON.parse((ev as MessageEvent).data) as SyncEvent);
		});
	}

	closeStream(): void {
		this.#es?.close();
		this.#es = null;
	}

	resetRun(): void {
		this.closeStream();
		this.running = false;
		this.runId = null;
		this.dests = {};
		this.confirm = null;
		this.finishedAt = null;
	}

	// --- Misc ----------------------------------------------------------------

	rateBps(destId: string): number {
		const view = this.dests[destId];
		if (!view) return 0;
		const samples = view.samples;
		if (samples.length < 2) return 0;
		const first = samples[0]!;
		const last = samples.at(-1)!;
		const dt = (last.ts - first.ts) / 1000;
		if (dt <= 0) return 0;
		return Math.max(0, (last.bytes - first.bytes) / dt);
	}

	showToast(kind: 'error' | 'info', text: string): void {
		this.toast = { kind, text };
		setTimeout(() => {
			if (this.toast?.text === text) this.toast = null;
		}, 5000);
	}
}

export const app = new AppState();
