<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import * as Select from '$lib/components/ui/select';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import { Button } from '$lib/components/ui/button';
	import { MonitorCog } from '@lucide/svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import DesktopSettingsDialog from '$lib/components/DesktopSettingsDialog.svelte';
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
	<!-- Shared header. In the desktop app the window title already says
		"MetFileSync", so the in-window H1 is hidden there; remote browser
		users still see it. -->
	<header class="flex h-11 shrink-0 items-center gap-3 border-b px-3">
		{#if !app.desktopHost}
			<h1 class="text-sm font-semibold tracking-tight">MetFileSync</h1>
			<Separator orientation="vertical" class="h-5" />
		{/if}
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
			<!-- Desktop settings: only the desktop app's own webview can see or
				use this (the endpoints are loopback-only). -->
			{#if app.desktopHost}
				<Button
					variant="ghost"
					size="sm"
					class="h-7 w-7 p-0 text-muted-foreground"
					onclick={() => (app.desktopSettingsOpen = true)}
					title="Desktop settings (root directory, network access)"
				>
					<MonitorCog class="size-4" />
				</Button>
			{/if}
		</div>
	</header>

	<div class="flex min-h-0 flex-1">
		{@render children()}
	</div>
</div>

<ConfirmDialog />
<DesktopSettingsDialog />
