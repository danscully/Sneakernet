<script lang="ts">
	import { Folder, File as FileIcon, ArrowRight, Trash2, ArrowUp, ArrowDown, ArrowUpDown } from '@lucide/svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { app } from '$lib/state.svelte';
	import { cn, formatBytes, formatDate } from '$lib/utils';
	import type { PlanItem } from '$lib/types';

	let { items }: { items: PlanItem[] } = $props();

	const dests = $derived(app.plan?.destinations ?? []);

	// --- Sorting ---------------------------------------------------------------
	type SortKey = 'name' | 'path' | 'size' | 'modified';
	let sortKey: SortKey | null = $state(null);
	let sortDir = $state<1 | -1>(1);

	function toggleSort(key: SortKey): void {
		if (sortKey === key) {
			if (sortDir === 1) sortDir = -1;
			else {
				// third click: back to plan order
				sortKey = null;
				sortDir = 1;
			}
		} else {
			sortKey = key;
			sortDir = 1;
		}
	}

	const sortedItems = $derived.by(() => {
		if (sortKey === null) return items;
		const key = sortKey;
		const dir = sortDir;
		const value = (item: PlanItem): number | string => {
			switch (key) {
				case 'name':
					return item.relPath.split('/').at(-1) ?? item.relPath;
				case 'path':
					return item.relPath;
				case 'size':
					return item.size;
				case 'modified':
					return item.mtime;
			}
		};
		return [...items].sort((a, b) => {
			const va = value(a);
			const vb = value(b);
			const cmp =
				typeof va === 'string' || typeof vb === 'string'
					? String(va).localeCompare(String(vb))
					: (va as number) - (vb as number);
			return cmp * dir;
		});
	});


	// --- Row selection (multi-select) ------------------------------------------
	// Click a row to select it; shift-click selects a range, cmd/ctrl-click
	// toggles single rows. Changing a sync checkbox while its row is part of
	// the selection applies the change to every selected row.
	let selectedRows = $state<string[]>([]);
	let anchor: string | null = null;

	const sortedPaths = $derived(sortedItems.map((i) => i.relPath));

	// A new plan (compare / set change) invalidates the row selection.
	$effect(() => {
		void app.plan?.id;
		selectedRows = [];
		anchor = null;
	});

	function onRowClick(e: MouseEvent, relPath: string): void {
		// Clicks on interactive elements (checkboxes) drive their own logic.
		if ((e.target as HTMLElement).closest('button,[role=checkbox],input,label,a')) return;
		if (e.shiftKey && anchor !== null) {
			const a = sortedPaths.indexOf(anchor);
			const b = sortedPaths.indexOf(relPath);
			if (a !== -1 && b !== -1) {
				const [lo, hi] = a < b ? [a, b] : [b, a];
				selectedRows = sortedPaths.slice(lo, hi + 1);
				return; // keep the anchor for further shift-clicks
			}
		}
		if (e.metaKey || e.ctrlKey) {
			selectedRows = selectedRows.includes(relPath)
				? selectedRows.filter((p) => p !== relPath)
				: [...selectedRows, relPath];
			anchor = relPath;
			return;
		}
		selectedRows = [relPath];
		anchor = relPath;
	}

	/**
	 * Rows a checkbox change applies to: the clicked row alone, or the whole
	 * multi-selection when the clicked row is part of it.
	 */
	function targetsFor(relPath: string): string[] {
		return selectedRows.includes(relPath) ? selectedRows : [relPath];
	}

	/** Row checkbox: select / clear every actionable cell of the row(s). */
	function onRowCheckbox(item: PlanItem): void {
		const makeSelected = !app.rowIsFullySelected(item.relPath);
		for (const t of targetsFor(item.relPath)) app.setRowSelection(t, makeSelected);
	}

	/** Destination cell checkbox: apply to the row(s), skipping rows where
	 * this destination has nothing to do ('same' decision). */
	function onCellCheckbox(item: PlanItem, destId: string): void {
		const makeSelected = !app.isSelected(item.relPath, destId);
		for (const t of targetsFor(item.relPath)) {
			if (app.isCellActionable(t, destId)) app.setCellSelection(t, destId, makeSelected);
		}
	}

	// --- Row helpers -----------------------------------------------------------
	function name(item: PlanItem): string {
		const parts = item.relPath.split('/');
		return parts.at(-1) ?? item.relPath;
	}
	function parentPath(item: PlanItem): string {
		const parts = item.relPath.split('/');
		parts.pop();
		return parts.join('/');
	}
</script>

{#snippet sortIcon(key: SortKey)}
	{#if sortKey !== key}
		<ArrowUpDown class="size-3" />
	{:else if sortDir === 1}
		<ArrowUp class="size-3" />
	{:else}
		<ArrowDown class="size-3" />
	{/if}
{/snippet}

<ScrollArea type="always" class="h-full">
	<Table.Root class="sn-dense w-full caption-bottom">
		<Table.Header>
			<Table.Row class="hover:bg-transparent">
				<Table.Head class="w-8 text-center" title="Select rows to change them together: click a row, shift-click for a range, cmd/ctrl-click to toggle. Checkbox changes then apply to every selected row.">Sel</Table.Head>
				<Table.Head class="w-40">
					<button
						type="button"
						class="flex items-center gap-1 hover:text-foreground"
						onclick={() => toggleSort('name')}
						title="Sort by name"
					>
						Name
						{@render sortIcon('name') }
					</button>
				</Table.Head>
				<Table.Head>
					<button
						type="button"
						class="flex items-center gap-1 hover:text-foreground"
						onclick={() => toggleSort('path')}
						title="Sort by path"
					>
						Path
						{@render sortIcon('path') }
					</button>
				</Table.Head>
				<Table.Head class="w-20 text-right">
					<button
						type="button"
						class="ml-auto flex items-center gap-1 hover:text-foreground"
						onclick={() => toggleSort('size')}
						title="Sort by size"
					>
						Size
						{@render sortIcon('size') }
					</button>
				</Table.Head>
				<Table.Head class="w-36">
					<button
						type="button"
						class="flex items-center gap-1 hover:text-foreground"
						onclick={() => toggleSort('modified')}
						title="Sort by modified date"
					>
						Modified
						{@render sortIcon('modified') }
					</button>
				</Table.Head>
				{#each dests as dest (dest.id)}
					{@const destState = app.destSelectionState(dest.id)}
					<Table.Head class="w-20 text-center">
						<div class="flex flex-col items-center gap-0.5">
							<Checkbox
								checked={destState === 'all'}
								indeterminate={destState === 'some'}
								onCheckedChange={() => app.setDestAll(dest.id, destState !== 'all')}
								aria-label={`${dest.name}: select or clear this destination for all files`}
							/>
							<span class="max-w-24 truncate" title={`${dest.name} — ${dest.path}`}>
								{dest.name}
							</span>
							<Badge variant="outline" class="h-4 px-1 text-[9px]">G{dest.group}</Badge>
						</div>
					</Table.Head>
				{/each}
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each sortedItems as item (item.relPath)}
				{@const isRowSelected = app.rowIsFullySelected(item.relPath)}
				{@const someSelected = (app.selection[item.relPath] ?? []).length > 0}
				{@const rowSel = selectedRows.includes(item.relPath)}
				<Table.Row
					class={cn(
						'cursor-pointer',
						item.isDir && 'text-muted-foreground',
						someSelected && !isRowSelected && !rowSel && 'bg-accent/30',
						rowSel && 'bg-primary/15 outline outline-1 -outline-offset-1 outline-primary/30'
					)}
					onclick={(e) => onRowClick(e, item.relPath)}
				>
					<Table.Cell class="text-center">
						<Checkbox
							checked={isRowSelected}
							indeterminate={someSelected && !isRowSelected}
							onCheckedChange={() => onRowCheckbox(item)}
							aria-label="Select row"
						/>
					</Table.Cell>
					<Table.Cell>
						<span class="flex items-center gap-1.5">
							{#if item.isDir}
								<Folder class="size-3.5 shrink-0" />
							{:else}
								<FileIcon class="size-3.5 shrink-0" />
							{/if}
							<span class="truncate" title={item.relPath}>{name(item)}</span>
						</span>
					</Table.Cell>
					<Table.Cell class="text-muted-foreground">
						<span class="truncate" title={parentPath(item)}>
							{parentPath(item) === '' ? '·' : parentPath(item)}
						</span>
					</Table.Cell>
					<Table.Cell class="text-right">
						{#if item.isDir}
							<span class="text-[10px]">dir</span>
						{:else}
							{formatBytes(item.size)}
						{/if}
					</Table.Cell>
					<Table.Cell class="text-muted-foreground">
						{#if item.isDir}–{:else}{formatDate(item.mtime)}{/if}
					</Table.Cell>
					{#each dests as dest (dest.id)}
						{@const decision = item.dests[dest.id]}
						{@const selected = app.isSelected(item.relPath, dest.id)}
						<Table.Cell class="text-center">
							{#if decision && decision.action !== 'same'}
								<div class="flex items-center justify-center gap-1">
									<span
										class={cn(decision.action === 'copy' ? 'text-sky-400' : 'text-destructive')}
										title={decision.action === 'copy' ? 'copy' : 'delete'}
									>
										{#if decision.action === 'copy'}
											<ArrowRight class="size-3.5" />
										{:else}
											<Trash2 class="size-3.5" />
										{/if}
									</span>
									<Checkbox
										checked={selected}
										onCheckedChange={() => onCellCheckbox(item, dest.id)}
										aria-label={`${dest.name}: ${decision.action}`}
									/>
								</div>
							{:else}
								<span class="text-muted-foreground/50">·</span>
							{/if}
						</Table.Cell>
					{/each}
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</ScrollArea>
