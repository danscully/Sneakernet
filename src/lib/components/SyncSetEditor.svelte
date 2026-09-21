<script lang="ts">
	import { Plus, FolderOpen, X, Lock } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import { app } from '$lib/state.svelte';
	import type { DestinationConfig } from '$lib/types';

	const GROUPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	const POLICIES = [
		{ value: 'stop', label: 'Stop on error' },
		{ value: 'ignore', label: 'Ignore all errors' },
		{ value: 'ask', label: 'Ask user' }
	];

	// Only local users (loopback: the desktop webview, the dev browser, the
	// operator at a standalone server) may change directories; remote LAN
	// users see the paths read-only. The server enforces the same rule.
	const canEditPaths = $derived(app.localUser);

	const draft = $derived(app.draft);

	/**
	 * Open the OS-native directory chooser (Tauri dialog plugin, loopback
	 * webview only) and assign the result to the source or a destination.
	 */
	async function browse(target: 'source' | { id: string }): Promise<void> {
		if (!canEditPaths || !draft) return;
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const picked = await open({
				directory: true,
				title: target === 'source' ? 'Choose the source directory' : 'Choose the destination directory'
			});
			if (typeof picked !== 'string') return; // cancelled
			if (target === 'source') {
				draft.source = picked;
			} else {
				const dest = draft.destinations.find((d) => d.id === target.id);
				if (dest) dest.path = picked;
			}
		} catch {
			app.showToast(
				'error',
				'The native directory picker is only available in the app window — type the absolute path instead.'
			);
		}
	}

	function addDestination(): void {
		draft?.destinations.push({
			id: crypto.randomUUID().slice(0, 8),
			name: `Destination ${draft.destinations.length + 1}`,
			path: '',
			group: 1
		});
	}

	function removeDestination(dest: DestinationConfig): void {
		if (!draft) return;
		draft.destinations = draft.destinations.filter((d) => d.id !== dest.id);
	}
</script>

<div class="flex flex-col gap-3 text-xs">
	{#if draft === null}
		<div class="flex flex-col gap-2">
			<p class="text-muted-foreground">No sync set selected. Create one to get started.</p>
			<Button size="sm" class="w-fit" onclick={() => app.beginNewSet()}>
				<Plus class="size-3.5" /> Create New SyncSet
			</Button>
		</div>
	{:else}
		<div class="grid grid-cols-2 items-start gap-x-5">
			<!-- Left: identity + destinations -->
			<div class="flex flex-col gap-3">
				<!-- Name -->
				<div class="grid gap-1.5">
					<Label for="set-name">Sync set name</Label>
					<Input id="set-name" class="h-7 text-xs" bind:value={draft.name} />
				</div>

				<!-- Source (absolute path; editable only for local users) -->
				<div class="grid gap-1.5">
					<Label for="set-source">Source directory</Label>
					<div class="flex min-w-0 gap-1.5">
						<Input
							id="set-source"
							class="h-7 min-w-0 flex-1 font-mono text-xs"
							bind:value={draft.source}
							placeholder="/absolute/path/to/source"
							disabled={!canEditPaths}
							title={draft.source}
						/>
						{#if canEditPaths}
							<Button
								variant="outline"
								size="sm"
								class="h-7 shrink-0 px-2"
								onclick={() => void browse('source')}
								title="Browse with the native directory picker"
							>
								<FolderOpen class="size-3.5" />
							</Button>
						{/if}
					</div>
					{#if !canEditPaths}
						<p class="flex items-center gap-1 text-[10px] text-muted-foreground">
							<Lock class="size-3" /> Directories can only be changed on the machine running
							Sneakernet.
						</p>
					{/if}
				</div>

				<!-- Destinations -->
				<div class="flex items-center justify-between">
					<Label>Destinations</Label>
					{#if canEditPaths}
						<Button variant="outline" size="sm" class="h-6 px-2" onclick={addDestination}>
							<Plus class="size-3.5" /> Add
						</Button>
					{/if}
				</div>
				<div class="flex flex-col gap-2">
					{#each draft.destinations as dest (dest.id)}
						<div class="rounded-md border p-2">
							<div class="flex items-center gap-1.5">
								<Input
									class="h-6 min-w-0 flex-1 text-xs"
									placeholder="Name"
									bind:value={dest.name}
									aria-label="Destination name"
								/>
								{#if canEditPaths}
									<Button
										variant="ghost"
										size="sm"
										class="size-6 shrink-0 p-1 text-muted-foreground hover:text-destructive"
										onclick={() => removeDestination(dest)}
										title="Remove destination"
									>
										<X class="size-3.5" />
									</Button>
								{/if}
							</div>
							<div class="mt-1.5 flex min-w-0 items-center gap-1.5">
								<Input
									class="h-6 min-w-0 flex-1 font-mono text-xs"
									placeholder="/absolute/path/to/destination"
									bind:value={dest.path}
									aria-label="Destination path"
									disabled={!canEditPaths}
									title={dest.path}
								/>
								{#if canEditPaths}
									<Button
										variant="outline"
										size="sm"
										class="h-6 shrink-0 px-1.5"
										onclick={() => void browse({ id: dest.id })}
										title="Browse with the native directory picker"
									>
										<FolderOpen class="size-3.5" />
									</Button>
								{/if}
							</div>
							<div class="mt-1.5 flex items-center gap-1.5">
								<Label class="text-muted-foreground">Group</Label>
								<Select.Root
									type="single"
									value={String(dest.group)}
									onValueChange={(v) => (dest.group = Number(v))}
								>
									<Select.Trigger class="h-6 w-16 text-xs">
										{dest.group}
									</Select.Trigger>
									<Select.Content class="text-xs">
										{#each GROUPS as g (g)}
											<Select.Item value={String(g)} label={`Group ${g}`} />
										{/each}
									</Select.Content>
								</Select.Root>
								<span class="ml-auto text-[10px] text-muted-foreground">groups sync in order 1 → 10</span>
							</div>
						</div>
					{/each}
					{#if draft.destinations.length === 0}
						<p class="text-muted-foreground">No destinations.</p>
					{/if}
				</div>

				<Separator />
			</div>
			<!-- Right: options + filters -->
			<div class="flex flex-col gap-3">
				<!-- Options -->
				<div class="grid gap-1.5">
					<Label for="set-delta">Datestamp delta (seconds)</Label>
					<Input
						id="set-delta"
						class="h-7 w-24 text-xs"
						type="number"
						min="0"
						step="1"
						bind:value={draft.dateDeltaSeconds}
					/>
					<p class="text-[10px] text-muted-foreground">
						Files with equal size and timestamps within this delta are considered in sync.
					</p>
				</div>

				<div class="flex items-center justify-between">
					<Label for="set-deletions">Sync deletions</Label>
					<Switch id="set-deletions" bind:checked={draft.syncDeletions} />
				</div>

				<div class="grid gap-1.5">
					<Label>Error handling</Label>
					<Select.Root
						type="single"
						value={draft.errorPolicy}
						onValueChange={(v) => (draft.errorPolicy = v as typeof draft.errorPolicy)}
					>
						<Select.Trigger class="h-7 text-xs">
							{POLICIES.find((p) => p.value === draft.errorPolicy)?.label ?? 'Ask user'}
						</Select.Trigger>
						<Select.Content class="text-xs">
							{#each POLICIES as policy (policy.value)}
								<Select.Item value={policy.value} label={policy.label} />
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<div class="grid gap-1.5">
					<Label for="set-include">Include filters (one per line, * wildcard)</Label>
					<Textarea
						id="set-include"
						class="min-h-16 text-xs"
						placeholder={'photos\n*.txt'}
						value={draft.includeFilters.join('\n')}
						oninput={(e: Event & { currentTarget: EventTarget & HTMLTextAreaElement }) =>
							(draft.includeFilters = e.currentTarget.value
								.split('\n')
								.map((s) => s.trim())
								.filter(Boolean))}
					/>
					<p class="text-[10px] text-muted-foreground">Empty list includes everything.</p>
				</div>

				<div class="grid gap-1.5">
					<Label for="set-exclude">Exclude filters (one per line, * wildcard)</Label>
					<Textarea
						id="set-exclude"
						class="min-h-16 text-xs"
						placeholder={'*.tmp\nnode_modules'}
						value={draft.excludeFilters.join('\n')}
						oninput={(e: Event & { currentTarget: EventTarget & HTMLTextAreaElement }) =>
							(draft.excludeFilters = e.currentTarget.value
								.split('\n')
								.map((s) => s.trim())
								.filter(Boolean))}
					/>
					<p class="text-[10px] text-muted-foreground">Exclusions are applied after inclusions.</p>
				</div>
			</div>
		</div>
	{/if}
</div>

<!-- NOTE: the root-relative PathPicker component
     (src/lib/components/PathPicker.svelte + /api/tree) is intentionally kept
     in the codebase but no longer used, so this change can be rolled back or
     the picker reused later. -->
