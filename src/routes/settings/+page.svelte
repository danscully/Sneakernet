<script lang="ts">
	import { ArrowLeft } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import SyncSetEditor from '$lib/components/SyncSetEditor.svelte';
	import { app } from '$lib/state.svelte';
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<!-- Toolbar -->
	<div class="flex h-11 shrink-0 items-center gap-3 border-b px-3">
		<Button variant="ghost" size="sm" class="h-7 px-2 text-xs" href="/" title="Back to sync">
			<ArrowLeft class="size-3.5" /> Back
		</Button>
		<h2 class="text-sm font-medium">Sync Set Settings</h2>
		{#if app.activeSet}
			<Badge variant="outline" class="h-5 text-[9px]">{app.activeSet.name}</Badge>
		{/if}
		{#if app.dirty}
			<Badge variant="secondary" class="h-5 text-[9px]">unsaved changes</Badge>
		{/if}
	</div>

	<!-- Settings content (scrollable, page does not scroll) -->
	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto flex max-w-2xl flex-col gap-4 p-4 text-xs">
			<!-- Root: read-only, from the server deployment configuration -->
			<div class="grid gap-1.5">
				<Label for="root-path">Root directory (server configuration, read-only)</Label>
				<Input
					id="root-path"
					class="h-7 cursor-not-allowed font-mono text-xs opacity-90"
					value={app.rootPath ?? '…'}
					disabled
					aria-readonly="true"
				/>
				<p class="text-[10px] text-muted-foreground">
					All source and destination directories live under this path. It is configured on the
					server (config.json or the METFILESYNC_ROOT environment variable), never in the browser.
				</p>
			</div>

			<!-- Full editor (name, source, destinations, options, filters, import/export) -->
			<SyncSetEditor />
		</div>
	</div>
</div>
