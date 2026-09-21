<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { app } from '$lib/state.svelte';

	/**
	 * Desktop-app settings (LAN sharing). Mounted in the layout but only
	 * ever opened from the header button, which the desktop webview alone
	 * shows - the endpoints behind this dialog are loopback-only.
	 */

	let loading = $state(false);
	let saving = $state(false);
	let loadError = $state<string | null>(null);

	// Draft + loaded-original values (only changed fields are sent on apply).
	let lanSharing = $state(false);
	let lanPort = $state(8787);
	let lanUrl = $state<string | null>(null);
	let orig = $state({ lanSharing: false, lanPort: 8787 });

	async function loadSettings(): Promise<void> {
		loading = true;
		loadError = null;
		try {
			const data = await app.loadDesktopSettings();
			if (!data) {
				loadError = 'Could not load the desktop settings.';
				return;
			}
			lanSharing = data.lanSharing;
			lanPort = data.lanPort;
			lanUrl = data.lanUrl;
			orig = { lanSharing: data.lanSharing, lanPort: data.lanPort };
		} finally {
			loading = false;
		}
	}

	const portValid = $derived(Number.isInteger(lanPort) && lanPort >= 1 && lanPort <= 65535);
	const changed = $derived(lanSharing !== orig.lanSharing || (portValid && lanPort !== orig.lanPort));

	async function apply(): Promise<void> {
		if (!changed || saving || !portValid) return;
		const update: { lanSharing?: boolean; lanPort?: number } = {};
		if (lanSharing !== orig.lanSharing) update.lanSharing = lanSharing;
		if (lanPort !== orig.lanPort) update.lanPort = lanPort;
		saving = true;
		try {
			const ok = await app.saveDesktopSettings(update);
			if (ok) {
				app.showToast('info', 'Applying changes — the server is restarting…');
				app.desktopSettingsOpen = false;
			}
		} finally {
			saving = false;
		}
	}

	$effect(() => {
		if (app.desktopSettingsOpen) void loadSettings();
	});
</script>

<Dialog.Root bind:open={app.desktopSettingsOpen}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Desktop Settings</Dialog.Title>
			<Dialog.Description class="text-xs">
				Network access for this machine. Applying changes restarts the app's server (finish
				any running sync first).
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-4">
			{#if loading}
				<p class="text-xs text-muted-foreground">Loading…</p>
			{:else if loadError}
				<p class="text-xs text-destructive">{loadError}</p>
			{:else}
				<!-- LAN sharing -->
				<div class="grid gap-1.5">
					<div class="flex items-center gap-2">
						<Switch id="ds-lan" bind:checked={lanSharing} />
						<Label for="ds-lan">Allow access from other devices on this network</Label>
					</div>
					<div class="grid gap-1.5 pl-7 {lanSharing ? '' : 'pointer-events-none opacity-50'}">
						<div class="grid gap-1.5">
							<Label for="ds-port">Port</Label>
							<Input
								id="ds-port"
								class="h-7 w-32 text-xs tabular-nums"
								type="number"
								min="1"
								max="65535"
								bind:value={lanPort}
								disabled={!lanSharing}
							/>
							{#if lanSharing && !portValid}
								<p class="text-[10px] text-destructive">Port must be between 1 and 65535.</p>
							{/if}
						</div>
						{#if lanSharing && lanUrl}
							<div class="grid gap-1.5">
								<Label for="ds-lan-url">Access link (share only with people you trust)</Label>
								<Input
									id="ds-lan-url"
									class="h-7 font-mono text-xs"
									value={lanUrl}
									readonly
									aria-readonly="true"
									title="Select and copy this link"
								/>
							</div>
						{/if}
						<p class="text-[10px] text-muted-foreground">
							Anyone who opens the access link can view and run syncs on this machine.
							Share it only on networks and with people you trust.
						</p>
					</div>
				</div>
			{/if}
		</div>

		<Dialog.Footer class="gap-2">
			<Button
				variant="outline"
				size="sm"
				onclick={() => (app.desktopSettingsOpen = false)}
				disabled={saving}
			>
				Cancel
			</Button>
			<Button size="sm" onclick={() => void apply()} disabled={!changed || !portValid || saving}>
				{#if saving}Applying…{:else}Apply{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
