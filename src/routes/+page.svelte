<script lang="ts">
	import { onMount } from 'svelte';
	import { GitCompare, RefreshCw, Square, CheckCheck, Minus, PanelLeftClose, PanelLeftOpen } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Tabs from '$lib/components/ui/tabs';
	import SyncSetSummary from '$lib/components/SyncSetSummary.svelte';
	import CompareTable from '$lib/components/CompareTable.svelte';
	import DestCard from '$lib/components/DestCard.svelte';
	import { app } from '$lib/state.svelte';
	import { formatBytes } from '$lib/utils';

	let tab = $state('compare');
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

	async function startSync(): Promise<void> {
		const started = await app.startSync();
		if (started) tab = 'sync';
	}

	const summary = $derived(
		app.plan
			? `${app.plan.items.filter((i) => !i.isDir).length} files, ${app.plan.items.filter((i) => i.isDir).length} dirs`
			: ''
	);
</script>

<!-- Collapsible summary sidebar -->
<aside
	class="flex shrink-0 flex-col border-r transition-[width] {sidebarOpen
		? 'w-80'
		: 'w-9'}"
>
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

<!-- Compare / Sync -->
<main class="flex min-w-0 flex-1 flex-col">
	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
		<div class="flex h-11 shrink-0 items-center gap-2 border-b px-3">
			<Tabs.List class="h-7">
				<Tabs.Trigger value="compare" class="h-7 px-3 text-xs">Compare</Tabs.Trigger>
				<Tabs.Trigger value="sync" class="h-7 px-3 text-xs">Sync</Tabs.Trigger>
			</Tabs.List>

			<div class="ml-auto flex items-center gap-1.5">
				{#if tab === 'compare'}
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
					{#if app.plan}
						<span class="text-[11px] text-muted-foreground">
							{summary} · {app.selectedCount} selected · {formatBytes(app.selectedBytes)}
							{#if app.selectedDeletes > 0}
								· {app.selectedDeletes} deletions
							{/if}
						</span>
					{/if}
					<Button
						variant="secondary"
						size="sm"
						class="h-7"
						onclick={() => void startSync()}
						disabled={!app.plan || app.starting || app.running || app.selectedCount === 0}
					>
						Sync selected
					</Button>
				{:else}
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
				{/if}
			</div>
		</div>

		<Tabs.Content value="compare" class="min-h-0 flex-1 data-[state=active]:block">
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
								: 'Select or create a sync set (open the settings via the gear above).'}
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

		<Tabs.Content value="sync" class="min-h-0 flex-1 data-[state=active]:block">
			{#if Object.keys(app.dests).length === 0}
				<div class="flex h-full items-center justify-center text-xs text-muted-foreground">
					No sync running. Compare, select files, and press “Sync selected”.
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
	</Tabs.Root>
</main>
