<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import * as Select from '$lib/components/ui/select';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { app } from '$lib/state.svelte';

	let { children } = $props();

	onMount(() => {
		void app.loadSets();
		void app.loadRoot();
		const ticker = setInterval(() => (app.now = Date.now()), 250);
		return () => clearInterval(ticker);
	});

	function onSetChange(v: string): void {
		if (v === '__new__') {
			app.beginNewSet();
			return;
		}
		app.selectSet(v || null);
	}

	const triggerName = $derived(
		app.activeSet?.name ??
			(app.draft && !app.activeSet ? `New: ${app.draft.name}` : '— no sync set —')
	);
</script>

<div class="flex h-screen flex-col overflow-hidden">
	<!-- Shared header -->
	<header class="flex h-11 shrink-0 items-center gap-3 border-b px-3">
		<h1 class="text-sm font-semibold tracking-tight">MetFileSync</h1>
		<Separator orientation="vertical" class="h-5" />
		<span class="text-xs text-muted-foreground">Sync Set:</span>
		<Select.Root type="single" value={app.activeSetId ?? ''} onValueChange={onSetChange}>
			<Select.Trigger class="h-7 w-56 text-xs">
				{triggerName}
			</Select.Trigger>
			<Select.Content class="text-xs">
				{#each app.sets as set (set.id)}
					<Select.Item value={set.id} label={set.name} />
				{/each}
				<Select.Separator />
				<Select.Item value="__new__">Create New SyncSet...</Select.Item>
			</Select.Content>
		</Select.Root>

		{#if app.dirty}
			<Badge variant="secondary" class="h-5 text-[9px]">unsaved changes</Badge>
		{/if}

		<div class="ml-auto flex items-center gap-2">
			{#if app.toast}
				<span
					class="rounded px-2 py-0.5 text-[11px] {app.toast.kind === 'error'
						? 'bg-destructive/15 text-destructive'
						: 'bg-muted text-muted-foreground'}"
				>
					{app.toast.text}
				</span>
			{/if}
			{#if app.running}
				<Badge variant="secondary" class="h-5 text-[9px]">sync running</Badge>
			{/if}
		</div>
	</header>

	<div class="flex min-h-0 flex-1">
		{@render children()}
	</div>
</div>

<ConfirmDialog />
