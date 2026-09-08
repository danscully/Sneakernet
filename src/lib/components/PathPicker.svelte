<script lang="ts">
	import { Folder, ChevronRight, Home } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Badge } from '$lib/components/ui/badge';
	import { cn } from '$lib/utils';

	let {
		open = $bindable(false),
		title,
		onPick
	}: {
		open?: boolean;
		title: string;
		onPick: (rel: string) => void;
	} = $props();

	let path = $state('');
	let dirs = $state<{ name: string; rel: string }[]>([]);
	let exists = $state(true);
	let loading = $state(false);
	let selected = $state<string | null>(null);

	async function load(rel: string): Promise<void> {
		loading = true;
		try {
			const res = await fetch(`/api/tree?path=${encodeURIComponent(rel)}`);
			const data = (await res.json()) as {
				path: string;
				exists: boolean;
				dirs: { name: string; rel: string }[];
			};
			path = data.path;
			exists = data.exists;
			dirs = data.dirs;
			selected = null;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open) void load('');
	});

	const segments = $derived(
		path === '' ? [] : path.split('/').map((s, i, arr) => ({ name: s, rel: arr.slice(0, i + 1).join('/') }))
	);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description class="text-xs">
				Pick a directory under the sync root. Paths are relative to the root.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs">
			<Button variant="ghost" size="sm" class="h-6 px-2" onclick={() => void load('')}>
				<Home class="size-3.5" />
				root
			</Button>
			{#each segments as seg (seg.rel)}
				<ChevronRight class="size-3 text-muted-foreground" />
				<Button variant="ghost" size="sm" class="h-6 px-1.5" onclick={() => void load(seg.rel)}>
					{seg.name}
				</Button>
			{/each}
			{#if !exists}
				<Badge variant="destructive" class="ml-auto">not created yet</Badge>
			{/if}
		</div>

		<ScrollArea class="h-64 rounded-md border p-1">
			{#if loading}
				<div class="p-4 text-xs text-muted-foreground">Loading…</div>
			{:else if dirs.length === 0}
				<div class="p-4 text-xs text-muted-foreground">No subdirectories.</div>
			{:else}
				{#each dirs as dir (dir.rel)}
					<button
						type="button"
						class={cn(
							'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent',
							selected === dir.rel && 'bg-accent'
						)}
						onclick={() => (selected = dir.rel)}
						ondblclick={() => void load(dir.rel)}
					>
						<Folder class="size-3.5 text-muted-foreground" />
						{dir.name}
					</button>
				{/each}
			{/if}
		</ScrollArea>

		<Dialog.Footer class="gap-2">
			<Button
				variant="outline"
				size="sm"
				onclick={() => void load(selected ?? path)}
				disabled={selected === null}
			>
				Open
			</Button>
			<Button
				size="sm"
				onclick={() => {
					onPick(path);
					open = false;
				}}
			>
				Choose {path === '' ? '(root)' : path}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
