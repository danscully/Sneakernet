<script lang="ts">
	import { Folder, File as FileIcon, ArrowRight, Trash2 } from '@lucide/svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { app } from '$lib/state.svelte';
	import { cn, formatBytes, formatDate } from '$lib/utils';
	import type { PlanItem } from '$lib/types';

	let { items }: { items: PlanItem[] } = $props();

	const dests = $derived(app.plan?.destinations ?? []);

	function name(item: PlanItem): string {
		const parts = item.relPath.split('/');
		return parts.at(-1) ?? item.relPath;
	}
	function parentPath(item: PlanItem): string {
		const parts = item.relPath.split('/');
		parts.pop();
		return parts.join('/');
	}
	function rowSize(item: PlanItem): number {
		if (!item.isDir) return item.size;
		return 0;
	}
	function rowMtime(item: PlanItem): number {
		return item.mtime;
	}
</script>

<ScrollArea class="h-full">
	<Table.Root class="mfs-dense w-full caption-bottom">
		<Table.Header class="sticky top-0 z-10 bg-background">
			<Table.Row class="hover:bg-transparent">
				<Table.Head class="w-8 text-center">Sel</Table.Head>
				<Table.Head class="w-40">Name</Table.Head>
				<Table.Head>Path</Table.Head>
				<Table.Head class="w-20 text-right">Size</Table.Head>
				<Table.Head class="w-36">Modified</Table.Head>
				{#each dests as dest (dest.id)}
					<Table.Head class="w-20 text-center">
						<div class="flex flex-col items-center gap-0.5">
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
			{#each items as item (item.relPath)}
				{@const isRowSelected = app.rowIsFullySelected(item.relPath)}
				{@const someSelected = (app.selection[item.relPath] ?? []).length > 0}
				<Table.Row
					class={cn(
						item.isDir && 'text-muted-foreground',
						someSelected && !isRowSelected && 'bg-accent/30'
					)}
				>
					<Table.Cell class="text-center">
						<Checkbox
							checked={isRowSelected}
							indeterminate={someSelected && !isRowSelected}
							onCheckedChange={() => app.toggleRow(item.relPath)}
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
							{formatBytes(rowSize(item))}
						{/if}
					</Table.Cell>
					<Table.Cell class="text-muted-foreground">
						{#if item.isDir}–{:else}{formatDate(rowMtime(item))}{/if}
					</Table.Cell>
					{#each dests as dest (dest.id)}
						{@const decision = item.dests[dest.id]}
						{@const selected = app.isSelected(item.relPath, dest.id)}
						<Table.Cell class="text-center">
							{#if decision && decision.action !== 'same'}
								<div class="flex items-center justify-center gap-1">
									<span
										class={cn(
											decision.action === 'copy' ? 'text-sky-400' : 'text-destructive'
										)}
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
										onCheckedChange={() => app.toggleCell(item.relPath, dest.id)}
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
