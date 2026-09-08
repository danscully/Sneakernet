<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { app } from '$lib/state.svelte';
	import { formatBytes, formatDate } from '$lib/utils';

	const confirm = $derived(app.confirm);
	const isSourceChanged = $derived(confirm?.kind === 'source-changed');
</script>

<Dialog.Root open={confirm !== null}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				{#if confirm}
					{#if isSourceChanged}
						Source changed since compare
					{:else}
						Sync error
					{/if}
				{/if}
			</Dialog.Title>
			<Dialog.Description class="text-xs leading-relaxed">
				{#if confirm}
					<div class="flex flex-wrap items-center gap-1.5">
						<Badge variant="outline" class="h-4 px-1.5 text-[9px]">
							{confirm.destName}
						</Badge>
						<code class="text-[11px]">{confirm.relPath}</code>
					</div>
					<p class="mt-2">{confirm.message}</p>
					{#if confirm.details}
						<div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] tabular-nums">
							<span class="text-muted-foreground">expected size</span>
							<span>{formatBytes(confirm.details.expectedSize)}</span>
							<span class="text-muted-foreground">actual size</span>
							<span>{formatBytes(confirm.details.actualSize)}</span>
							<span class="text-muted-foreground">expected modified</span>
							<span>{formatDate(confirm.details.expectedMtime)}</span>
							<span class="text-muted-foreground">actual modified</span>
							<span>{formatDate(confirm.details.actualMtime)}</span>
						</div>
					{/if}
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="mt-2 gap-2 sm:justify-end">
			<Button
				variant="destructive"
				size="sm"
				onclick={() => void app.respondConfirm('stop')}
				title="Stop this destination"
			>
				Stop
			</Button>
			<Button variant="outline" size="sm" onclick={() => void app.respondConfirm('skip')}>
				{#if isSourceChanged}Skip file{:else}Skip file &amp; continue{/if}
			</Button>
			{#if isSourceChanged}
				<Button size="sm" onclick={() => void app.respondConfirm('copy-anyway')}>
					Sync anyway
				</Button>
			{:else}
				<Button size="sm" onclick={() => void app.respondConfirm('ignore-all')}>
					Continue &amp; ignore all errors
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
