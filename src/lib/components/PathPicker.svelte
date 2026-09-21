<!--
	RETAINED BUT CURRENTLY UNUSED. This root-relative directory picker (with
	its /api/tree backend) was replaced by the OS-native Tauri directory
	chooser when the root-directory concept was removed. It is kept intact so
	the change can be rolled back, or the picker reused, later.
-->
<script lang="ts">
	import { Folder, ChevronRight, Home, FolderPlus } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
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
	let newFolderName = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);

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

	async function createFolder(): Promise<void> {
		const name = newFolderName.trim();
		if (!name || creating) return;
		creating = true;
		createError = null;
		try {
			const res = await fetch('/api/tree', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ parent: path, name })
			});
			const data = (await res.json()) as { rel?: string; error?: string };

			if (!res.ok) {
				createError = data.error ?? 'could not create the directory';
				return;
			}
			newFolderName = '';
			// Navigate into the new directory so Choose picks it.
			if (data.rel) await load(data.rel);
		} finally {
			creating = false;
		}
	}

	$effect(() => {
		if (open) void load('');
	});

	const segments = $derived(
		path === ''
			? []
			: path.split('/').map((s, i, arr) => ({ name: s, rel: arr.slice(0, i + 1).join('/') }))
	);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description class="text-xs">
				Pick a directory under the sync root, or create a new subdirectory. Paths are relative to the root.
			</Dialog.Description>
		</Dialog.Header>

		<!-- min-w-0 + flex-wrap: deep paths wrap their crumbs to the next line
			instead of stretching the dialog grid track wider than the modal -->
		<div class="flex min-w-0 flex-wrap items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs">
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

		<div class="flex min-w-0 items-center gap-1.5">
			<Input
				class="h-7 min-w-0 flex-1 text-xs"
				placeholder="new subdirectory name"
				bind:value={newFolderName}
				onkeydown={(e) => {
					if (e.key === 'Enter') void createFolder();
				}}
			/>
			<Button
				variant="outline"
				size="sm"
				class="h-7"
				disabled={!newFolderName.trim() || creating}
				onclick={() => void createFolder()}
				title="Create this subdirectory in the current folder"
			>
				<FolderPlus class="size-3.5" />
				Create
			</Button>
		</div>
		{#if createError}
			<p class="text-[11px] text-destructive">{createError}</p>
		{/if}

		<ScrollArea class="h-64 min-w-0 rounded-md border p-1">
			{#if loading}
				<div class="p-4 text-xs text-muted-foreground">Loading…</div>
			{:else if dirs.length === 0}
				<div class="p-4 text-xs text-muted-foreground">No subdirectories.</div>
			{:else}
				{#each dirs as dir (dir.rel)}
					<button
						type="button"
						class={cn(
							'flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent',
							selected === dir.rel && 'bg-accent'
						)}
						onclick={() => (selected = dir.rel)}
						ondblclick={() => void load(dir.rel)}
					>
						<Folder class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="min-w-0 truncate">{dir.name}</span>
					</button>
				{/each}
			{/if}
		</ScrollArea>

		<Dialog.Footer class="min-w-0 gap-2">
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
				class="min-w-0"
				onclick={() => {
					onPick(path);
					open = false;
				}}
				title={path === '' ? '(root)' : path}
			>
				<!-- deep paths truncate instead of pushing past the modal -->
				<span class="min-w-0 truncate">Choose {path === '' ? '(root)' : path}</span>
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
