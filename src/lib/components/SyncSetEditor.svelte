<script lang="ts">
	import {
		Plus,
		Save,
		Trash2,
		Download,
		Upload,
		FolderOpen,
		FilePlus2,
		X
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import { Badge } from '$lib/components/ui/badge';
	import PathPicker from './PathPicker.svelte';
	import { app, newSyncSet } from '$lib/state.svelte';
	import type { DestinationConfig } from '$lib/types';

	const GROUPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	const POLICIES = [
		{ value: 'stop', label: 'Stop on error' },
		{ value: 'ignore', label: 'Ignore all errors' },
		{ value: 'ask', label: 'Ask user' }
	];

	let pickerOpen = $state(false);
	let pickerTarget = $state<'source' | { id: string }>('source');
	let importInput = $state<HTMLInputElement | null>(null);

	const draft = $derived(app.draft);

	function pickFor(target: 'source' | { id: string }): void {
		pickerTarget = target;
		pickerOpen = true;
	}

	function onPick(rel: string): void {
		if (!draft) return;
		if (pickerTarget === 'source') draft.source = rel;
		else {
			const dest = draft.destinations.find((d) => d.id === (pickerTarget as { id: string }).id);
			if (dest) dest.path = rel;
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

	function newSet(): void {
		const set = newSyncSet();
		app.draft = set;
		app.draftJson = JSON.stringify(set);
		app.activeSetId = null;
	}

	async function onImport(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) await app.importSet(file);
		input.value = '';
	}
</script>

<div class="flex flex-col gap-3 text-xs">
	{#if draft === null}
		<div class="flex flex-col gap-2">
			<p class="text-muted-foreground">No sync set selected. Create one to get started.</p>
			<Button size="sm" class="w-fit" onclick={newSet}><FilePlus2 class="size-3.5" /> New Sync Set</Button>
		</div>
	{:else}
		<!-- Name -->
		<div class="grid gap-1.5">
			<Label for="set-name">Sync set name</Label>
			<Input id="set-name" class="h-7 text-xs" bind:value={draft.name} />
		</div>

		<!-- Source -->
		<div class="grid gap-1.5">
			<Label for="set-source">Source directory (under root)</Label>
			<div class="flex gap-1.5">
				<Input id="set-source" class="h-7 text-xs" bind:value={draft.source} placeholder="photos" />
				<Button variant="outline" size="sm" class="h-7 px-2" onclick={() => pickFor('source')} title="Browse">
					<FolderOpen class="size-3.5" />
				</Button>
			</div>
		</div>

		<Separator />

		<!-- Destinations -->
		<div class="flex items-center justify-between">
			<Label>Destinations</Label>
			<Button variant="outline" size="sm" class="h-6 px-2" onclick={addDestination}>
				<Plus class="size-3.5" /> Add
			</Button>
		</div>
		<div class="flex flex-col gap-2">
			{#each draft.destinations as dest (dest.id)}
				<div class="rounded-md border p-2">
					<div class="flex items-center gap-1.5">
						<Input
							class="h-6 flex-1 text-xs"
							placeholder="Name"
							bind:value={dest.name}
							aria-label="Destination name"
						/>
						<Button
							variant="ghost"
							size="sm"
							class="size-6 p-1 text-muted-foreground hover:text-destructive"
							onclick={() => removeDestination(dest)}
							title="Remove destination"
						>
							<X class="size-3.5" />
						</Button>
					</div>
					<div class="mt-1.5 flex items-center gap-1.5">
						<Input
							class="h-6 flex-1 text-xs"
							placeholder="path under root"
							bind:value={dest.path}
							aria-label="Destination path"
						/>
						<Button
							variant="outline"
							size="sm"
							class="h-6 px-1.5"
							onclick={() => pickFor({ id: dest.id })}
							title="Browse"
						>
							<FolderOpen class="size-3.5" />
						</Button>
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

		<Separator />

		<!-- Actions -->
		<div class="flex flex-wrap gap-1.5">
			<Button size="sm" class="h-7" onclick={() => void app.saveDraft()} disabled={!app.dirty}>
				<Save class="size-3.5" /> Save
			</Button>
			<Button variant="outline" size="sm" class="h-7" onclick={newSet}>
				<FilePlus2 class="size-3.5" /> New
			</Button>
			<Button
				variant="outline"
				size="sm"
				class="h-7"
				onclick={() => {
					if (app.activeSetId && confirm(`Delete sync set "${draft.name}"?`)) void app.deleteActiveSet();
				}}
				disabled={!app.activeSetId}
			>
				<Trash2 class="size-3.5" /> Delete
			</Button>
			<Button variant="outline" size="sm" class="h-7" onclick={() => app.exportActiveSet()}>
				<Download class="size-3.5" /> Export
			</Button>
			<Button variant="outline" size="sm" class="h-7" onclick={() => importInput?.click()}>
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
				<Badge variant="secondary" class="ml-auto">unsaved changes</Badge>
			{/if}
		</div>
	{/if}
</div>

<PathPicker bind:open={pickerOpen} title="Choose directory" onPick={onPick} />
