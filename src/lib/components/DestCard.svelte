<script lang="ts">
	import { Square } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Badge } from '$lib/components/ui/badge';
	import { rateOf } from '$lib/state.svelte';
	import { formatBytes, formatDuration, cn } from '$lib/utils';
	import type { DestView } from '$lib/state.svelte';

	let {
		dest,
		now,
		runActive,
		onStop
	}: {
		dest: DestView;
		now: number;
		/** Whether this destination's run is still executing. */
		runActive: boolean;
		/** Stop just this destination (the parent wires it to the run). */
		onStop: (destId: string) => void;
	} = $props();

	const rate = $derived(rateOf(dest));
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
				: (dest.finishedAt ?? now) - dest.startedAt
	);
	// Average over the whole run so far - the fallback for "remaining time"
	// when the rolling rate reads zero during a stall (a big single file can
	// go many seconds between progress events).
	const lifetimeBps = $derived(
		dest.startedAt === null ? 0 : copied / Math.max(0.001, (now - dest.startedAt) / 1000)
	);
	const effectiveBps = $derived(
		dest.progress.status === 'running' ? (rate > 0 ? rate : lifetimeBps) : 0
	);
	const remainingMs = $derived(effectiveBps > 0 ? (remainingBytes / effectiveBps) * 1000 : null);

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

	// The current-file line truncates with a LEADING ellipsis (the file name
	// at the end of a path is the interesting part), and the card has a fixed
	// width so long names can never stretch the layout. Measured imperatively
	// in an effect: write the full text, then drop leading characters until
	// it fits.
	let fileLineEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		const el = fileLineEl;
		if (!el) return;
		const running = dest.progress.status === 'running';
		const text = dest.progress.currentFile ?? (running ? '' : (dest.progress.message ?? ''));
		el.textContent = text;
		if (el.scrollWidth > el.clientWidth) {
			let start = 1;
			while (start < text.length) {
				el.textContent = `…${text.slice(start)}`;
				if (el.scrollWidth <= el.clientWidth) break;
				// Adaptive step: overshoot by the rough char width of the overflow.
				start += Math.max(1, Math.ceil((el.scrollWidth - el.clientWidth) / 4));
			}
		}
	});
</script>

<!-- w-72 (fixed): a long current-file path must never expand the card -->
<div class="flex w-72 flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-xs">
	<div class="flex items-center gap-2">
		<span class="min-w-0 truncate font-medium" title={`${dest.name} — ${dest.path}`}
			>{dest.name}</span
		>
		<Badge variant="outline" class="h-4 shrink-0 px-1 text-[9px]">G{dest.group}</Badge>
		<Badge variant={statusVariant} class="ml-auto h-4 shrink-0 px-1.5 text-[9px]"
			>{statusText}</Badge
		>
	</div>

	<div class="text-[10px] text-muted-foreground">
		<span class="block truncate" title={dest.path}>{dest.path}</span>
	</div>

	<!-- Leading-ellipsis truncation happens in the effect above -->
	<div
		bind:this={fileLineEl}
		class="min-w-0 overflow-hidden text-nowrap text-[11px]"
		title={dest.progress.currentFile ?? dest.progress.message ?? ''}
	></div>

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
				{#if remainingMs !== null}
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

	<div class="flex items-center justify-between text-[10px] text-muted-foreground">
		<span>files {dest.progress.filesDone}/{dest.progress.filesTotal}</span>
		<span class={cn(dest.progress.status === 'done' && 'text-emerald-400')}>
			{pct.toFixed(1)}%
		</span>
		<Button
			variant="ghost"
			size="sm"
			class="h-5 shrink-0 gap-1 px-1 text-[9px] text-muted-foreground hover:text-destructive"
			title="Stop this destination"
			disabled={!runActive || dest.progress.status === 'done' || dest.progress.status === 'stopped' || dest.progress.status === 'stopped-error'}
			onclick={() => onStop(dest.id)}
		>
			<Square class="size-3" /> Stop
		</Button>
	</div>
</div>
