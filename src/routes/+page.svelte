<script lang="ts">
	import { onMount } from 'svelte';
	import { GitCompare, RefreshCw, Square, CheckCheck, XCircle, Minus } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import SyncSetEditor from '$lib/components/SyncSetEditor.svelte';
	import CompareTable from '$lib/components/CompareTable.svelte';
	import DestCard from '$lib/components/DestCard.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { app } from '$lib/state.svelte';
	import { formatBytes } from '$lib/utils';

	let tab = $state('compare');

	onMount(() => {
		void app.loadSets();
		const ticker = setInterval(() => (app.now = Date.now()), 250);
		return () => clearInterval(ticker);
	});

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

<div class="flex h-screen flex-col overflow-hidden">
	<!-- Header -->
	<header class="flex h-11 shrink-0 items-center gap-3 border-b px-3">
		<h1 class="text-sm font-semibold tracking-tight">MetFileSync</h1>
		<Separator orientation="vertical" class="h-5" />
		<Select.Root
			type="single"
			value={app.activeSetId ?? ''}
			onValueChange={(v) => app.selectSet(v || null)}
		>
			<Select.Trigger class="h-7 w-56 text-xs">
				{app.activeSet?.name ?? '— no sync set —'}
			</Select.Trigger>
			<Select.Content class="text-xs">
				{#each app.sets as set (set.id)}
					<Select.Item value={set.id} label={set.name} />
				{/each}
			</Select.Content>
		</Select.Root>

		{#if app.dirty}
			<Badge variant="secondary" class="h-5 text-[9px]">unsaved changes</Badge>
		{/if}

		<div class="ml-auto flex items-center gap-2">
			{#if app.toast}
				<span
					class="rounded px-2 py-0.5 text-[11px] {app.toast.kind === 'error'
						? 'bg-destructive/15 text-destructive'
						: 'bg-muted text-muted-foreground'}"
				>
					{app.toast.text}
				</span>
			{/if}
			{#if app.running}
				<Badge variant="secondary" class="h-5 text-[9px]">sync running</Badge>
			{/if}
		</div>
	</header>

	<div class="flex min-h-0 flex-1">
		<!-- Left: sync set editor -->
		<aside class="w-96 shrink-0 overflow-hidden border-r">
			<SyncSetEditor />
		</aside>

		<!-- Right: compare + sync -->
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

				<Tabs.Content
					value="compare"
					class="min-h-0 flex-1 data-[state=active]:block"
				>
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
										: 'Select or create a sync set on the left.'}
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
	</div>
</div>

<ConfirmDialog />
