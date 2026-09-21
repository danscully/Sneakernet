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
	RunDestInfo,
	RunRecord,
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
	/** When this destination reached a final state (null while active). */
	finishedAt: number | null;
	samples: RateSample[];
}

/**
 * One sync run as shown in the Status view. Every client sees every run
 * (from any sync set and any user) via the global event stream.
 */
export interface RunView {
	runId: string;
	setId: string;
	setName: string;
	startedAt: number;
	/** null while the run is still executing. */
	finishedAt: number | null;
	/** True when the run ended by stopping (vs. completing normally). */
	stopped: boolean;
	dests: Record<string, DestView>;
}

/** Transfer rate of a destination view, from its byte samples. */
export function rateOf(view: DestView): number {
	const samples = view.samples;
	if (samples.length < 2) return 0;
	const first = samples[0]!;
	const last = samples.at(-1)!;
	const dt = (last.ts - first.ts) / 1000;
	if (dt <= 0) return 0;
	return Math.max(0, (last.bytes - first.bytes) / dt);
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

/** Settings shown in the desktop-app-only settings dialog. */
export interface DesktopSettingsView {
	lanSharing: boolean;
	lanPort: number;
	lanUrl: string | null;
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

	/**
	 * Every sync run this server process has seen (running and finished),
	 * from any set and any user - the Status view. Finished runs stay until
	 * the user clears them ("Clear completed").
	 */
	runs: Record<string, RunView> = $state({});
	confirm: PendingConfirm | null = $state(null);
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

	/** True when this client connected over loopback (desktop webview, dev
	 * browser, or the operator at a standalone server). Only local users
	 * may change a sync set's source/destination directories. */
	localUser = $state(false);

	/** Full LAN access link when the server is in sharing mode, else null. */
	lanUrl: string | null = $state(null);

	/** True when this client is the desktop app's own webview. */
	desktopHost = $state(false);

	/** The sync set settings modal (editor lives on the main page now). */
	settingsOpen = $state(false);

	/** The desktop-app settings modal (LAN sharing + sync root). */
	desktopSettingsOpen = $state(false);

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

	/** Fetch read-only server info (LAN link, desktop/local client flags). */
	async loadConfig(): Promise<void> {
		const res = await fetch('/api/config');
		if (!res.ok) return;
		const data = (await res.json()) as {
			lanUrl?: string | null;
			desktopHost?: boolean;
			localUser?: boolean;
		};
		this.lanUrl = data.lanUrl ?? null;
		this.desktopHost = data.desktopHost ?? false;
		this.localUser = data.localUser ?? false;
	}

	// --- Desktop app settings (Tauri webview only) ---------------------------

	/** Fetch the current desktop settings (null when unavailable). */
	async loadDesktopSettings(): Promise<DesktopSettingsView | null> {
		const res = await fetch('/api/desktop/settings');
		if (!res.ok) return null;
		return (await res.json()) as DesktopSettingsView;
	}

	/**
	 * Persist desktop settings. The shell picks up the file change and
	 * restarts the server (which re-navigates the webview). Returns true on
	 * success; failures surface as a toast.
	 */
	async saveDesktopSettings(update: { lanSharing?: boolean; lanPort?: number }): Promise<boolean> {
		const res = await fetch('/api/desktop/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(update)
		});
		if (!res.ok) {
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			this.showToast('error', data.error ?? 'could not save the settings');
			return false;
		}
		return true;
	}

	get dirty(): boolean {
		return this.draft !== null && JSON.stringify(this.draft) !== this.draftJson;
	}

	get selectedCount(): number {
		// Deselected rows keep an empty array in the map (cheaper than
		// deleting the key); only rows with something selected count here.
		let count = 0;
		for (const ids of Object.values(this.selection)) {
			if (ids.length > 0) count += 1;
		}
		return count;
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

	/** True when a sync is running for the currently active set. */
	get running(): boolean {
		const id = this.activeSetId;
		return (
			id !== null && Object.values(this.runs).some((r) => r.setId === id && r.finishedAt === null)
		);
	}

	/** True when any user has a sync running (any set). */
	get anyRunning(): boolean {
		return Object.values(this.runs).some((r) => r.finishedAt === null);
	}

	/** True when at least one finished run is still shown. */
	get anyFinished(): boolean {
		return Object.values(this.runs).some((r) => r.finishedAt !== null);
	}

	/** All runs, newest first (the Status list). */
	get runList(): RunView[] {
		return Object.values(this.runs).sort((a, b) => b.startedAt - a.startedAt);
	}

	/** The destinations of one run, in group order. */
	destListOf(run: RunView): DestView[] {
		return Object.values(run.dests).sort(
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
			const lastUsed = localStorage.getItem('sneakernet.activeSet');
			this.selectSet(
				this.sets.find((s) => s.id === lastUsed)?.id ?? this.sets[0]?.id ?? null
			);
		}
	}

	selectSet(id: string | null): void {
		if (this.activeSetId === id) return;
		this.activeSetId = id;
		localStorage.setItem('sneakernet.activeSet', id ?? '');
		const set = this.activeSet;
		// $state.snapshot unwraps the reactive proxy so we can clone it.
		this.draft = set ? ($state.snapshot(set) as SyncSet) : null;
		this.draftJson = set ? JSON.stringify(set) : '';
		this.plan = null;
		this.selection = {};
		// The global run stream (Status view) stays connected across set
		// changes; a fresh set selection always triggers a silent re-compare
		// so the File List tab shows current data without a manual click.
		if (id) void this.compare(true);
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
		// Keep the File List header (destination names + groups) in sync with
		// the saved set - the plan holds a snapshot from compare time, so
		// without this a group change would not show up until the next Compare
		// (and a re-compare would discard the user's current selection).
		if (this.plan && this.plan.setId === data.set.id) {
			this.plan = {
				...this.plan,
				destinations: $state.snapshot(data.set.destinations) as DestinationConfig[]
			};
		}
		this.draft = $state.snapshot(data.set) as SyncSet;
		this.draftJson = JSON.stringify(data.set);
		this.activeSetId = data.set.id;
		localStorage.setItem('sneakernet.activeSet', data.set.id);
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

	/**
	 * Run a compare. With `auto` = true (first load / set switch) it stays
	 * completely silent when there is nothing to do; manual runs surface the
	 * reason as a toast instead.
	 */
	async compare(auto = false): Promise<void> {
		const id = this.activeSetId;
		if (!id || this.comparing) return;
		if (this.dirty) {
			if (!auto) this.showToast('error', 'Save the sync set before comparing');
			return;
		}
		if (this.running) {
			if (!auto) this.showToast('error', 'A sync is running for this set');
			return;
		}
		// Finished runs stay in the Status view until the user clears them;
		// only the pending low-space warning belongs to the compare flow.
		this.spaceWarning = null;
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

	/** Does this row have a copy/delete decision for this destination? */
	isCellActionable(relPath: string, destId: string): boolean {
		if (!this.plan) return false;
		const decision = this.plan.items.find((i) => i.relPath === relPath)?.dests[destId];
		return !!decision && decision.action !== 'same';
	}

	/** Select (or clear) every actionable destination cell of one row. */
	setRowSelection(relPath: string, selected: boolean): void {
		if (!this.plan) return;
		this.selection[relPath] = selected ? actionableDestIds(this.plan, relPath) : [];
	}

	/** Select (or deselect) one destination cell of one row. */
	setCellSelection(relPath: string, destId: string, selected: boolean): void {
		const current = this.selection[relPath] ?? [];
		this.selection[relPath] = selected
			? [...new Set([...current, destId])]
			: current.filter((id) => id !== destId);
	}

	/**
	 * Tri-state of one destination across every actionable row of the plan:
	 * 'all' | 'some' | 'none'. Drives the per-destination header checkbox.
	 */
	destSelectionState(destId: string): 'all' | 'some' | 'none' {
		if (!this.plan) return 'none';
		let any = false;
		let every = true;
		for (const item of this.plan.items) {
			if (!this.isCellActionable(item.relPath, destId)) continue;
			if (this.isSelected(item.relPath, destId)) any = true;
			else every = false;
		}
		return any ? (every ? 'all' : 'some') : 'none';
	}

	/**
	 * Select (or clear) one destination for every actionable row - the
	 * per-destination header checkbox applies to all files at once.
	 */
	setDestAll(destId: string, selected: boolean): void {
		if (!this.plan) return;
		for (const item of this.plan.items) {
			if (this.isCellActionable(item.relPath, destId)) {
				this.setCellSelection(item.relPath, destId, selected);
			}
		}
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
		try {
			const res = await fetch('/api/sync/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ setId: id, selection: this.selection, force })
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
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
				this.spaceWarning = data.warning?.destinations ?? [];
				return false;
			}
			// Seed the run view immediately (the run-start event only fills in
			// anything missing; a fast sync may even complete before it arrives).
			if (data.runId && this.plan) {
				this.upsertRun(
					data.runId,
					id,
					this.activeSet?.name ?? '',
					Date.now(),
					this.plan.destinations.map((d) => ({
						id: d.id,
						name: d.name,
						path: d.path,
						group: d.group
					}))
				);
			}
			return true;
		} finally {
			this.starting = false;
		}
	}

	/** Stop a run of any set (destId = null stops the whole run). */
	async stopSync(setId: string, destId: string | null): Promise<void> {
		await fetch('/api/sync/stop', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ setId, destId })
		}).catch(() => this.showToast('error', 'stop request failed'));
	}

	/**
	 * Remove all finished (completed or stopped) runs from the Status view.
	 * Running syncs are never touched; every connected user's view updates.
	 */
	async clearCompletedRuns(): Promise<void> {
		const res = await fetch('/api/sync/clear', { method: 'POST' });
		if (!res.ok) {
			this.showToast('error', 'could not clear completed syncs');
			return;
		}
		// The runs-cleared stream event handles this for every user; clear
		// locally too in case the event races or the stream is down.
		for (const run of Object.values(this.runs)) {
			if (run.finishedAt !== null) delete this.runs[run.runId];
		}
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

	// --- Live run stream (global: all sets, all users) ------------------------

	/** Create (or complete) the local view of a run. */
	private upsertRun(
		runId: string,
		setId: string,
		setName: string,
		startedAt: number,
		dests: RunDestInfo[]
	): RunView {
		let run = this.runs[runId];
		if (!run) {
			run = { runId, setId, setName, startedAt, finishedAt: null, stopped: false, dests: {} };
			this.runs[runId] = run;
		} else {
			run.setName = setName || run.setName;
		}
		for (const info of dests) this.ensureDestView(run, info);
		return run;
	}

	private ensureDestView(run: RunView, info: { id: string } & Partial<RunDestInfo>): DestView {
		if (run.dests[info.id]) return run.dests[info.id]!;
		const view: DestView = {
			id: info.id,
			name: info.name ?? info.id,
			path: info.path ?? '',
			group: info.group ?? 1,
			progress: blankProgress(info.id),
			startedAt: null,
			finishedAt: null,
			samples: []
		};
		run.dests[info.id] = view;
		return view;
	}

	private applyProgress(run: RunView, destId: string, progress: DestProgress, ts: number): void {
		const view = this.ensureDestView(run, { id: destId });
		view.progress = { ...progress };
		if (progress.status === 'running' && view.startedAt === null) view.startedAt = ts;
		if (progress.status === 'queued' || progress.status === 'stopped') view.startedAt = null;
		if (progress.copiedBytes !== undefined) {
			view.samples.push({ ts, bytes: progress.copiedBytes });
			// Keep a generous window (30s): short stalls (a big single file,
			// a slow lock wait) must not zero out the rolling transfer rate.
			const cutoff = ts - 30_000;
			while (view.samples.length > 2 && view.samples[0]!.ts < cutoff) view.samples.shift();
		}
		if (['done', 'stopped', 'stopped-error', 'aborted'].includes(progress.status)) {
			view.finishedAt ??= ts;
		}
	}

	handleEvent(e: SyncEvent): void {
		switch (e.type) {
			case 'run-start':
				this.upsertRun(e.runId, e.setId, e.setName ?? '', e.ts, e.dests ?? []);
				break;
			case 'dest-status':
			case 'file-start':
			case 'file-progress':
			case 'file-done':
			case 'dest-done': {
				if (e.progress && e.destId) {
					const run = this.runs[e.runId];
					if (run) this.applyProgress(run, e.destId, e.progress, e.ts);
				}
				break;
			}
			case 'confirm':
				this.confirm = e.confirm ?? null;
				break;
			case 'confirm-resolved':
				this.confirm = null;
				break;
			case 'log':
				if (e.message) this.showToast('info', e.message);
				break;
			case 'run-done': {
				const run = this.runs[e.runId];
				if (run) {
					run.finishedAt = e.ts;
					run.stopped = e.stopped ?? false;
				}
				if (this.confirm) this.confirm = null;
				break;
			}
			case 'runs-cleared':
				for (const run of Object.values(this.runs)) {
					if (run.finishedAt !== null) delete this.runs[run.runId];
				}
				break;
			default:
				break;
		}
		// Skipped-file toasts belong to the user's own compare workflow.
		if (
			e.type === 'file-skipped' &&
			e.message &&
			!e.message.includes('up to date') &&
			e.setId === this.activeSetId
		) {
			this.showToast('info', `Skipped ${e.relPath}: ${e.message}`);
		}
	}

	/** Connect the global run stream once: all sets, all users. */
	connectStream(): void {
		this.closeStream();
		this.#es = new EventSource('/api/sync/stream');
		this.#es.addEventListener('snapshot', (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { runs: RunRecord[] };
			for (const record of data.runs) {
				const run = this.upsertRun(
					record.runId,
					record.setId,
					record.setName,
					record.startedAt,
					record.dests
				);
				run.finishedAt = record.finishedAt;
				run.stopped = record.stopped;
				for (const p of record.progress) {
					this.applyProgress(run, p.destId, p, record.finishedAt ?? Date.now());
				}
			}
		});
		this.#es.addEventListener('event', (ev) => {
			this.handleEvent(JSON.parse((ev as MessageEvent).data) as SyncEvent);
		});
	}

	closeStream(): void {
		this.#es?.close();
		this.#es = null;
	}

	// --- Misc ----------------------------------------------------------------

	showToast(kind: 'error' | 'info', text: string): void {
		this.toast = { kind, text };
		setTimeout(() => {
			if (this.toast?.text === text) this.toast = null;
		}, 5000);
	}
}

export const app = new AppState();
