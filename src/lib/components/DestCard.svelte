<script lang="ts">
	import { Square } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Badge } from '$lib/components/ui/badge';
	import { app } from '$lib/state.svelte';
	import { formatBytes, formatDuration, cn } from '$lib/utils';
	import type { DestView } from '$lib/state.svelte';

	let { dest, now }: { dest: DestView; now: number } = $props();

	const rate = $derived(app.rateBps(dest.id));
	const copied = $derived(dest.progress.copiedBytes);
	const total = $derived(dest.progress.totalBytes);
	const finished = $derived(dest.progress.status === 'done');
	// A finished run is always 100%: quick runs may not produce intermediate
	// byte events, deletions carry no bytes, and files skipped as already
	// up-to-date never add to copiedBytes.
	const pct = $derived(
		finished
			? 100
			: total > 0
				? (copied / total) * 100
				: (dest.progress.filesTotal > 0 && dest.progress.filesDone >= dest.progress.filesTotal ? 100 : 0)
	);
	const remainingBytes = $derived(finished ? 0 : Math.max(0, total - copied));
	const elapsedMs = $derived(
		dest.startedAt === null
			? 0
			: (dest.progress.status === 'running' || dest.progress.status === 'paused')
				? now - dest.startedAt
				: (app.finishedAt ?? now) - dest.startedAt
	);
	const remainingMs = $derived(rate > 0 ? (remainingBytes / rate) * 1000 : null);

	const statusVariant = $derived(
		dest.progress.status === 'done'
			? 'default'
			: dest.progress.status === 'running'
				? 'secondary'
				: dest.progress.status === 'paused' || dest.progress.status === 'queued' || dest.progress.status === 'waiting'
					? 'outline'
					: 'destructive'
	);
	const statusText = $derived(
		{
			queued: 'queued',
			waiting: 'waiting for lock',
			running: 'syncing',
			paused: 'paused',
			done: 'done',
			stopped: 'stopped',
			'stopped-error': 'stopped (error)',
			aborted: 'aborted'
		}[dest.progress.status] ?? dest.progress.status
	);
</script>

<div class="flex min-w-72 flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-xs">
	<div class="flex items-center gap-2">
		<span class="truncate font-medium" title={`${dest.name} — ${dest.path}`}>{dest.name}</span>
		<Badge variant="outline" class="h-4 px-1 text-[9px]">G{dest.group}</Badge>
		<Badge variant={statusVariant} class="ml-auto h-4 px-1.5 text-[9px]">{statusText}</Badge>
		<Button
			variant="ghost"
			size="sm"
			class="size-6 p-1 text-muted-foreground hover:text-destructive"
			title="Stop this destination"
			disabled={!app.running || dest.progress.status === 'done' || dest.progress.status === 'stopped' || dest.progress.status === 'stopped-error'}
			onclick={() => void app.stopSync(dest.id)}
		>
			<Square class="size-3.5" />
		</Button>
	</div>

	<div class="text-[10px] text-muted-foreground">
		<span class="truncate" title={dest.path}>{dest.path || '(root)'}</span>
	</div>

	<div class="truncate text-[11px]" title={dest.progress.currentFile ?? dest.progress.message ?? ''}>
		{#if dest.progress.currentFile}
			<span class="text-foreground">{dest.progress.currentFile}</span>
		{:else if dest.progress.status === 'running'}
			<span class="text-muted-foreground">…</span>
		{:else if dest.progress.message}
			<span class="text-destructive">{dest.progress.message}</span>
		{/if}
	</div>

	<Progress value={pct} class="h-1.5" />

	<div class="grid grid-cols-5 gap-1 text-center text-[10px]">
		<div>
			<div class="text-muted-foreground">MB/s</div>
			<div class="tabular-nums">{(rate / (1024 * 1024)).toFixed(1)}</div>
		</div>
		<div>
			<div class="text-muted-foreground">Elapsed</div>
			<div class="tabular-nums">{formatDuration(elapsedMs)}</div>
		</div>
		<div>
			<div class="text-muted-foreground">Remaining</div>
			<div class="tabular-nums">
				{#if dest.progress.status === 'running' && remainingMs !== null}
					{formatDuration(remainingMs)}
				{:else}
					–
				{/if}
			</div>
		</div>
		<div>
			<div class="text-muted-foreground">Copied</div>
			<div class="tabular-nums">{formatBytes(copied)}</div>
		</div>
		<div>
			<div class="text-muted-foreground">Left</div>
			<div class="tabular-nums">{formatBytes(remainingBytes)}</div>
		</div>
	</div>

	<div class="flex justify-between text-[10px] text-muted-foreground">
		<span>files {dest.progress.filesDone}/{dest.progress.filesTotal}</span>
		<span class={cn(dest.progress.status === 'done' && 'text-emerald-400')}>
			{pct.toFixed(1)}%
		</span>
	</div>
</div>
