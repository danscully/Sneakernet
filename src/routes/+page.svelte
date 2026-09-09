<script lang="ts">
	import { onMount } from 'svelte';
	import {
		GitCompare,
		RefreshCw,
		Square,
		CheckCheck,
		Minus,
		PanelLeftClose,
		PanelLeftOpen,
		RefreshCcw,
		HardDriveDownload,
		Copy,
		Trash2,
		Download,
		Upload
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import SyncSetSummary from '$lib/components/SyncSetSummary.svelte';
	import SyncSetEditor from '$lib/components/SyncSetEditor.svelte';
	import CompareTable from '$lib/components/CompareTable.svelte';
	import DestCard from '$lib/components/DestCard.svelte';
	import { app } from '$lib/state.svelte';
	import { formatBytes, formatDate, cn } from '$lib/utils';

	let tab = $state('filelist');
	let sidebarOpen = $state(true);

	onMount(() => {
		sidebarOpen = localStorage.getItem('mfs.sidebar') !== 'collapsed';
	});

	function toggleSidebar(): void {
		sidebarOpen = !sidebarOpen;
		localStorage.setItem('mfs.sidebar', sidebarOpen ? 'open' : 'collapsed');
	}

	async function compare(): Promise<void> {
		await app.compare();
	}

	async function startSync(force = false): Promise<void> {
		const started = await app.startSync(force);
		if (started) tab = 'status';
	}

	/** Save the sync set and close the settings modal (stays open on failure). */
	async function saveAndClose(): Promise<void> {
		if (await app.saveDraft()) app.settingsOpen = false;
	}

	let importInput = $state<HTMLInputElement | null>(null);

	async function onImport(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) await app.importSet(file);
		input.value = '';
	}

	/** Load logs whenever the Logs tab becomes visible. */
	$effect(() => {
		if (tab === 'logs') void app.loadLogs();
	});

	const summary = $derived(
		app.plan
			? `${app.plan.items.filter((i) => !i.isDir).length} files, ${app.plan.items.filter((i) => i.isDir).length} dirs`
			: ''
	);
</script>

<!-- Collapsible summary sidebar -->
<aside class="flex shrink-0 flex-col border-r transition-[width] {sidebarOpen ? 'w-80' : 'w-9'}">
	<Button
		variant="ghost"
		size="sm"
		class="h-9 w-9 shrink-0 justify-self-start rounded-none border-b p-0 text-muted-foreground"
		onclick={toggleSidebar}
		title={sidebarOpen ? 'Collapse panel' : 'Expand panel'}
	>
		{#if sidebarOpen}
			<PanelLeftClose class="size-4" />
		{:else}
			<PanelLeftOpen class="size-4" />
		{/if}
	</Button>
	{#if sidebarOpen}
		<div class="min-h-0 flex-1">
			<SyncSetSummary />
		</div>
	{/if}
</aside>

<!-- File List / In Progress / Logs -->
<main class="flex min-w-0 flex-1 flex-col">
	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
		<div class="flex h-11 shrink-0 items-center gap-2 border-b px-3">
			<Tabs.List class="h-7">
				<Tabs.Trigger value="filelist" class="h-7 px-3 text-xs">File List</Tabs.Trigger>
				<Tabs.Trigger value="status" class="h-7 px-3 text-xs">Status</Tabs.Trigger>
				<Tabs.Trigger value="logs" class="h-7 px-3 text-xs">Logs</Tabs.Trigger>
			</Tabs.List>

			<!-- Compare statistics, centered between the tabs and the buttons -->
			{#if tab === 'filelist' && app.plan}
				<span class="min-w-0 flex-1 truncate text-center text-[11px] text-muted-foreground">
					{summary} · {app.selectedCount} selected · {formatBytes(app.selectedBytes)}
					{#if app.selectedDeletes > 0}
						· {app.selectedDeletes} deletions
					{/if}
				</span>
			{:else}
				<span class="flex-1"></span>
			{/if}

			<div class="flex shrink-0 items-center gap-1.5">
				{#if tab === 'filelist'}
					<Button
						size="sm"
						class="h-7"
						onclick={() => void compare()}
						disabled={!app.activeSetId || app.comparing || app.running}
					>
						{#if app.comparing}
							<RefreshCw class="size-3.5 animate-spin" />
						{:else}
							<GitCompare class="size-3.5" />
						{/if}
						Compare
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="h-7"
						onclick={() => app.selectAll()}
						disabled={!app.plan}
						title="Select all"
					>
						<CheckCheck class="size-3.5" />
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="h-7"
						onclick={() => app.deselectAll()}
						disabled={!app.plan}
						title="Deselect all"
					>
						<Minus class="size-3.5" />
					</Button>
					<Button
						size="sm"
						class="h-7 bg-emerald-600 text-white hover:bg-emerald-500 disabled:pointer-events-none disabled:opacity-50"
						onclick={() => void startSync()}
						disabled={!app.plan || app.starting || app.running || app.selectedCount === 0}
					>
						Sync Selected
					</Button>
				{:else if tab === 'status'}
					<Button
						variant="destructive"
						size="sm"
						class="h-7"
						onclick={() => void app.stopSync(null)}
						disabled={!app.running}
					>
						<Square class="size-3.5" /> Stop all
					</Button>
					{#if app.finishedAt !== null && !app.running}
						<span class="text-[11px] text-muted-foreground">finished</span>
					{/if}
				{:else if tab === 'logs'}
					<div class="flex items-center gap-1">
						<Button
							variant={app.logsFilter === 'session' ? 'secondary' : 'ghost'}
							size="sm"
							class="h-6 px-2 text-[11px]"
							onclick={() => (app.logsFilter = 'session')}
						>
							Current session
						</Button>
						<Button
							variant={app.logsFilter === 'all' ? 'secondary' : 'ghost'}
							size="sm"
							class="h-6 px-2 text-[11px]"
							onclick={() => (app.logsFilter = 'all')}
						>
							All syncs
						</Button>
						<Button
							variant="ghost"
							size="sm"
							class="size-6 p-1"
							title="Refresh logs"
							onclick={() => void app.loadLogs()}
						>
							<RefreshCcw class="size-3.5" />
						</Button>
					</div>
				{/if}
			</div>
		</div>

		<Tabs.Content value="filelist" class="min-h-0 flex-1 data-[state=active]:block">
			{#if app.plan === null}
				<div class="flex h-full items-center justify-center text-muted-foreground">
					{#if app.comparing}
						<span class="flex items-center gap-2 text-xs">
							<RefreshCw class="size-4 animate-spin" /> Comparing…
						</span>
					{:else}
						<span class="text-xs">
							{app.activeSetId
								? 'Run a Compare to see what needs syncing.'
								: 'Select a sync set, or create one from the Sync Set dropdown.'}
						</span>
					{/if}
				</div>
			{:else if app.plan.items.length === 0}
				<div class="flex h-full items-center justify-center text-xs text-emerald-400">
					Everything is in sync.
				</div>
			{:else}
				<div class="h-full">
					<CompareTable items={app.plan.items} />
				</div>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="status" class="min-h-0 flex-1 data-[state=active]:block">
			{#if Object.keys(app.dests).length === 0}
				<div class="flex h-full items-center justify-center text-xs text-muted-foreground">
					No sync running.
				</div>
			{:else}
				<div class="h-full overflow-y-auto p-3">
					<div class="flex flex-wrap gap-2.5">
						{#each app.activeDests as dest (dest.id)}
							<DestCard {dest} now={app.now} />
						{/each}
					</div>
				</div>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="logs" class="min-h-0 flex-1 data-[state=active]:block">
			<div class="flex h-full min-h-0">
				<!-- Run list -->
				<div class="w-72 shrink-0 overflow-y-auto border-r p-2">
					{#if app.loadingLogs}
						<p class="p-2 text-xs text-muted-foreground">Loading…</p>
					{:else if app.visibleLogs.length === 0}
						<p class="p-2 text-xs text-muted-foreground">
							{app.logsFilter === 'session'
								? 'No syncs in the current session yet. Switch to “All syncs” to see older runs.'
								: 'No sync logs yet.'}
						</p>
					{:else}
						{#each app.visibleLogs as log (log.runId)}
							<button
								type="button"
								class={cn(
									'w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent',
									app.activeLogId === log.runId && 'bg-accent'
								)}
								onclick={() => void app.openLog(log.runId)}
							>
								<div class="flex items-center justify-between gap-2">
									<span class="truncate font-medium">{log.setName}</span>
									<span class="shrink-0 text-[10px] text-muted-foreground">
										{formatBytes(log.size)}
									</span>
								</div>
								<div class="text-[10px] text-muted-foreground">
									{formatDate(log.startedAt)}
								</div>
							</button>
						{/each}
					{/if}
				</div>
				<!-- Log content -->
				<div class="min-w-0 flex-1">
					{#if app.activeLogId === null}
						<div class="flex h-full items-center justify-center text-xs text-muted-foreground">
							Select a sync run to view its log.
						</div>
					{:else if app.loadingLogText}
						<div class="flex h-full items-center justify-center text-xs text-muted-foreground">
							Loading…
						</div>
					{:else}
						<ScrollArea type="always" class="h-full">
							<pre class="whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed">{app.logText}</pre>
						</ScrollArea>
					{/if}
				</div>
			</div>
		</Tabs.Content>
	</Tabs.Root>
</main>

<!-- Sync set settings modal -->
<Dialog.Root bind:open={app.settingsOpen}>
	<Dialog.Content class="flex max-h-[90vh] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
		<Dialog.Header class="shrink-0 border-b p-4 pb-3">
			<Dialog.Title>
				Sync Set Settings{#if app.draft} — {app.draft.name}{/if}
			</Dialog.Title>
			<Dialog.Description class="text-xs">
				All directories live under the root configured on the server.
			</Dialog.Description>
		</Dialog.Header>
		<!-- Settings body: bounded scroll region with a persistent scrollbar;
			the header above and the footer below stay fixed. -->
		<ScrollArea type="always" class="min-h-0 flex-1">
			<div class="flex flex-col gap-4 p-4 text-xs">
				<div class="grid gap-1.5">
					<Label for="root-path">Root directory (server configuration, read-only)</Label>
					<Input
						id="root-path"
						class="h-7 cursor-not-allowed font-mono text-xs opacity-90"
						value={app.rootPath ?? '…'}
						disabled
						aria-readonly="true"
					/>
					<p class="text-[10px] text-muted-foreground">
						{app.desktopHost
							? 'Change the root from the Desktop Settings dialog (cog/monitor icon in the header).'
							: 'Configured via config.json or the METFILESYNC_ROOT environment variable on the server.'}
					</p>
				</div>
				{#if app.lanUrl}
					<div class="grid gap-1.5">
						<Label for="lan-url">Network access (currently enabled)</Label>
						<Input
							id="lan-url"
							class="h-7 cursor-not-allowed font-mono text-xs opacity-90"
							value={app.lanUrl}
							disabled
							aria-readonly="true"
						/>
						<p class="text-[10px] text-muted-foreground">
							Anyone on your network who opens this link can view and run syncs on this machine.
							Share it only with people you trust; sharing is managed in the Desktop Settings dialog.
						</p>
					</div>
				{/if}
				<SyncSetEditor />
			</div>
		</ScrollArea>
		<Dialog.Footer
			class="m-0 flex shrink-0 flex-row items-center justify-between gap-2 border-t bg-muted/30 p-3 sm:justify-between"
		>
			<!-- Set actions, left-justified -->
			<div class="flex flex-wrap items-center gap-1.5">
				<Button
					variant="outline"
					size="sm"
					class="h-7"
					onclick={() => app.duplicateSet()}
					title="Duplicate this sync set as a new one"
					disabled={!app.draft}
				>
					<Copy class="size-3.5" /> Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="h-7"
					onclick={() => {
						if (app.activeSetId && confirm(`Delete sync set "${app.draft?.name}"?`)) {
							void app.deleteActiveSet();
						}
					}}
					disabled={!app.activeSetId || app.draftIsNew}
					title={app.draftIsNew
						? 'Save the set first (this copy is not stored yet)'
						: 'Delete the saved sync set'}
				>
					<Trash2 class="size-3.5" /> Delete
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="h-7"
					onclick={() => app.exportActiveSet()}
					title="Export this sync set as a JSON file"
					disabled={!app.draft}
				>
					<Download class="size-3.5" /> Export
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="h-7"
					onclick={() => importInput?.click()}
					title="Import a sync set from a JSON file"
				>
					<Upload class="size-3.5" /> Import
				</Button>
				<input
					bind:this={importInput}
					type="file"
					accept="application/json,.json"
					class="hidden"
					onchange={(e) => void onImport(e)}
				/>
				{#if app.dirty}
					<Badge variant="secondary" class="text-[9px]">unsaved changes</Badge>
				{/if}
			</div>
			<!-- Cancel / Save, right-justified -->
			<div class="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					class="h-7"
					onclick={() => {
						app.discardDraft();
						app.settingsOpen = false;
					}}
				>
					Cancel
				</Button>
				<Button
					size="sm"
					class="h-7"
					onclick={() => void saveAndClose()}
					disabled={!app.canSave}
				>
					Save
				</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Low-space warning modal -->
<Dialog.Root open={app.spaceWarning !== null}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<HardDriveDownload class="size-4 text-amber-500" />
				Low disk space warning
			</Dialog.Title>
			<Dialog.Description class="text-xs">
				One or more destinations would be left with less than 1&nbsp;GB of free space by this
				sync. Review the details below before proceeding.
			</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-1.5 text-xs tabular-nums">
			{#each app.spaceWarning ?? [] as w (w.destId)}
				<div class="rounded-md border p-2">
					<div class="mb-1 flex items-center justify-between">
						<span class="font-medium">{w.name}</span>
						<code class="text-[10px] text-muted-foreground">{w.path}</code>
					</div>
					<div class="grid grid-cols-2 gap-x-4 text-[11px]">
						<span class="text-muted-foreground">Transfer size</span>
						<span>{formatBytes(w.requiredBytes)}</span>
						<span class="text-muted-foreground">Available now</span>
						<span>{formatBytes(w.availableBytes)}</span>
						<span class="text-muted-foreground">Free after sync</span>
						<span class="text-amber-500">{formatBytes(w.projectedFreeBytes)}</span>
					</div>
				</div>
			{/each}
		</div>
		<Dialog.Footer class="gap-2">
			<Button variant="outline" size="sm" onclick={() => (app.spaceWarning = null)}>Cancel</Button>
			<Button variant="destructive" size="sm" onclick={() => { app.spaceWarning = null; void startSync(true); }}>
				Proceed with sync
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
