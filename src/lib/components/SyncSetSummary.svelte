<script lang="ts">
	import { Pencil, FolderOpen } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import { app } from '$lib/state.svelte';

	const set = $derived(app.activeSet);
</script>

<div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-xs">
	{#if set === null}
		<p class="text-muted-foreground">
			No sync set selected. Create one in the settings screen.
		</p>
		<Button size="sm" class="w-fit" href="/settings">
			<Pencil class="size-3.5" /> Open Settings
		</Button>
	{:else}
		<div class="flex items-center justify-between gap-2">
			<span class="truncate text-sm font-medium" title={set.name}>{set.name}</span>
			<Button variant="outline" size="sm" class="h-6 px-2" href="/settings" title="Edit settings">
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

		<!-- Destinations -->
		<div class="grid gap-1">
			<span class="text-muted-foreground">Destinations ({set.destinations.length})</span>
			<div class="flex flex-col gap-1">
				{#each set.destinations as dest (dest.id)}
					<div class="flex items-center gap-1.5 rounded-md border px-2 py-1">
						<span class="truncate" title={dest.name}>{dest.name}</span>
						<Badge variant="outline" class="h-4 shrink-0 px-1 text-[9px]">G{dest.group}</Badge>
						<code class="ml-auto truncate text-[10px] text-muted-foreground" title={dest.path}>
							{dest.path || '(root)'}
						</code>
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
