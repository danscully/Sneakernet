<script lang="ts">
	import { onMount } from 'svelte';
	import { Pencil, FolderOpen } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import { app } from '$lib/state.svelte';
	import { formatBytes } from '$lib/utils';

	const set = $derived(app.activeSet);

	/** Free space per destination, refreshed every 60s. */
	let freeSpace = $state<Record<string, number | null>>({});

	async function loadSpace(): Promise<void> {
		const current = app.activeSet;
		if (!current) return;
		const entries = await Promise.all(
			current.destinations.map(async (dest) => {
				try {
					const res = await fetch(`/api/space?path=${encodeURIComponent(dest.path)}`);
					if (!res.ok) return [dest.id, null] as const;
					const data = (await res.json()) as { free: number };
					return [dest.id, data.free] as const;
				} catch {
					return [dest.id, null] as const;
				}
			})
		);
		const next: Record<string, number | null> = {};
		for (const [id, free] of entries) next[id] = free;
		freeSpace = next;
	}

	$effect(() => {
		// Reload whenever the set or its destination paths change.
		const paths = (app.activeSet?.destinations ?? []).map((d) => `${d.id}:${d.path}`).join('|');
		void paths;
		void loadSpace();
	});

	onMount(() => {
		const timer = setInterval(() => void loadSpace(), 60_000);
		return () => clearInterval(timer);
	});
</script>

<div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-xs">
	{#if set === null}
		<p class="text-muted-foreground">
			No sync set selected. Create one from the Sync Set dropdown.
		</p>
		<Button size="sm" class="w-fit" onclick={() => app.beginNewSet()}>
			<Pencil class="size-3.5" /> Create New SyncSet
		</Button>
	{:else}
		<div class="flex items-center justify-between gap-2">
			<span class="truncate text-sm font-medium" title={set.name}>{set.name}</span>
			<Button
				variant="outline"
				size="sm"
				class="h-6 px-2"
				onclick={() => (app.settingsOpen = true)}
				title="Edit settings"
			>
				<Pencil class="size-3.5" /> Edit
			</Button>
		</div>

		{#if app.dirty}
			<Badge variant="secondary" class="w-fit text-[9px]">unsaved changes</Badge>
		{/if}

		<!-- Root -->
		<div class="grid gap-1">
			<span class="text-muted-foreground">Root directory</span>
			<code class="block truncate rounded-md border bg-muted/40 px-2 py-1 text-[10px]" title={app.rootPath ?? ''}>
				{app.rootPath ?? '…'}
			</code>
		</div>

		<!-- Source -->
		<div class="grid gap-1">
			<span class="text-muted-foreground">Source</span>
			<span class="flex items-center gap-1.5">
				<FolderOpen class="size-3.5 shrink-0 text-muted-foreground" />
				<code class="truncate" title={set.source}>{set.source || '(root)'}</code>
			</span>
		</div>

		<!-- Destinations (with free space) -->
		<div class="grid gap-1">
			<span class="text-muted-foreground">Destinations ({set.destinations.length})</span>
			<div class="flex flex-col gap-1">
				{#each set.destinations as dest (dest.id)}
					<div class="rounded-md border px-2 py-1">
						<div class="flex items-center gap-1.5">
							<span class="truncate" title={dest.name}>{dest.name}</span>
							<Badge variant="outline" class="h-4 shrink-0 px-1 text-[9px]">G{dest.group}</Badge>
							<span
								class="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground"
								title="Free space at this destination"
							>
								{freeSpace[dest.id] === undefined
									? '…'
									: freeSpace[dest.id] === null
										? 'n/a'
										: `${formatBytes(freeSpace[dest.id]!)} free`}
							</span>
						</div>
						<div class="mt-0.5 truncate text-[10px] text-muted-foreground" title={dest.path}>
							{dest.path || '(root)'}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<Separator />

		<!-- Options -->
		<div class="grid gap-1.5">
			<span class="text-muted-foreground">Options</span>
			<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
				<span class="text-muted-foreground">Datestamp delta</span>
				<span class="tabular-nums">{set.dateDeltaSeconds}s</span>
				<span class="text-muted-foreground">Sync deletions</span>
				<span>{set.syncDeletions ? 'yes' : 'no'}</span>
				<span class="text-muted-foreground">Error handling</span>
				<span>{set.errorPolicy === 'stop' ? 'stop on error' : set.errorPolicy === 'ignore' ? 'ignore all errors' : 'ask user'}</span>
			</div>
		</div>

		<!-- Filters -->
		<div class="grid gap-1">
			<span class="text-muted-foreground">Include filters</span>
			{#if set.includeFilters.length === 0}
				<span class="text-muted-foreground">(everything)</span>
			{:else}
				<div class="flex flex-wrap gap-1">
					{#each set.includeFilters as f (f)}
						<code class="rounded bg-muted/60 px-1.5 py-0.5 text-[10px]">{f}</code>
					{/each}
				</div>
			{/if}
		</div>
		<div class="grid gap-1">
			<span class="text-muted-foreground">Exclude filters</span>
			{#if set.excludeFilters.length === 0}
				<span class="text-muted-foreground">(none)</span>
			{:else}
				<div class="flex flex-wrap gap-1">
					{#each set.excludeFilters as f (f)}
						<code class="rounded bg-muted/60 px-1.5 py-0.5 text-[10px]">{f}</code>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
