<script lang="ts">
	import { Folder, ArrowUp, ArrowLeft } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { app } from '$lib/state.svelte';

	/**
	 * Desktop-app settings (LAN sharing + sync root). Mounted in the layout
	 * but only ever opened from the header button, which the desktop webview
	 * alone shows - the endpoints behind this dialog are loopback-only.
	 */

	type Step = 'settings' | 'picker';

	interface BrowseDir {
		name: string;
		path: string;
	}

	let step = $state<Step>('settings');
	let loading = $state(false);
	let saving = $state(false);
	let loadError = $state<string | null>(null);

	// Draft + loaded-original values (only changed fields are sent on apply).
	let lanSharing = $state(false);
	let lanPort = $state(8787);
	let rootDirectory = $state<string | null>(null);
	let root = $state('');
	let lanUrl = $state<string | null>(null);
	let orig = $state({ lanSharing: false, lanPort: 8787, rootDirectory: null as string | null });

	// Inline root picker state.
	let pickerPath = $state('');
	let pickerParent = $state<string | null>(null);
	let pickerDirs = $state<BrowseDir[]>([]);
	let pickerLoading = $state(false);
	let pickerError = $state<string | null>(null);

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
			rootDirectory = data.rootDirectory;
			root = data.root;
			lanUrl = data.lanUrl;
			orig = { lanSharing: data.lanSharing, lanPort: data.lanPort, rootDirectory: data.rootDirectory };
		} finally {
			loading = false;
		}
	}

	async function loadPicker(p: string): Promise<void> {
		pickerLoading = true;
		pickerError = null;
		try {
			const res = await fetch(`/api/desktop/browse?path=${encodeURIComponent(p)}`);
			const data = (await res.json()) as {
				path?: string;
				parent?: string | null;
				dirs?: BrowseDir[];
				error?: string;
			};
			if (!res.ok) {
				pickerError = data.error ?? 'could not browse this directory';
				return;
			}
			pickerPath = data.path ?? p;
			pickerParent = data.parent ?? null;
			pickerDirs = data.dirs ?? [];
		} catch {
			pickerError = 'could not browse this directory';
		} finally {
			pickerLoading = false;
		}
	}

	function openPicker(): void {
		step = 'picker';
		void loadPicker(rootDirectory ?? root);
	}

	const portValid = $derived(Number.isInteger(lanPort) && lanPort >= 1 && lanPort <= 65535);
	const changed = $derived(
		lanSharing !== orig.lanSharing ||
			(portValid && lanPort !== orig.lanPort) ||
			rootDirectory !== orig.rootDirectory
	);

	async function apply(): Promise<void> {
		if (!changed || saving || !portValid) return;
		const update: { lanSharing?: boolean; lanPort?: number; rootDirectory?: string | null } = {};
		if (lanSharing !== orig.lanSharing) update.lanSharing = lanSharing;
		if (lanPort !== orig.lanPort) update.lanPort = lanPort;
		if (rootDirectory !== orig.rootDirectory) update.rootDirectory = rootDirectory;
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
		if (app.desktopSettingsOpen) {
			step = 'settings';
			void loadSettings();
		}
	});
</script>

<Dialog.Root bind:open={app.desktopSettingsOpen}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Desktop Settings</Dialog.Title>
			<Dialog.Description class="text-xs">
				{#if step === 'settings'}
					Sync root and network access for this machine. Applying changes restarts the app's
					server (finish any running sync first).
				{:else}
					Choose the root directory that contains all synced folders.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if step === 'settings'}
			<div class="grid gap-4">
				{#if loading}
					<p class="text-xs text-muted-foreground">Loading…</p>
				{:else if loadError}
					<p class="text-xs text-destructive">{loadError}</p>
				{:else}
					<!-- Sync root -->
					<div class="grid gap-1.5">
						<Label for="ds-root">Root directory</Label>
						<div class="flex gap-1.5">
							<Input
								id="ds-root"
								class="h-7 flex-1 font-mono text-xs"
								value={rootDirectory ?? root}
								readonly
								aria-readonly="true"
								title={rootDirectory
									? `${rootDirectory} (configured)`
									: `${root} (app default)`}
							/>
							<Button
								variant="outline"
								size="sm"
								class="h-7"
								onclick={openPicker}
								title="Browse for a different root directory"
							>
								<Folder class="size-3.5" /> Browse
							</Button>
						</div>
						<p class="text-[10px] text-muted-foreground">
							{#if rootDirectory !== null && rootDirectory !== orig.rootDirectory}
								Will become <code>{rootDirectory}</code> after applying.
							{:else}
								{#if rootDirectory === null}
									Currently the app default.
								{/if}
								All source and destination directories live under the root.
							{/if}
						</p>
					</div>

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
		{:else}
			<!-- Inline root picker (absolute paths, outside the current root) -->
			<div class="grid gap-2">
				<div class="flex items-center gap-1.5">
					<Button
						variant="ghost"
						size="sm"
						class="h-7 px-2"
						disabled={pickerParent === null}
						onclick={() => pickerParent && void loadPicker(pickerParent)}
						title="Go to the parent directory"
					>
						<ArrowUp class="size-3.5" />
					</Button>
					<code class="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 text-[11px]" title={pickerPath}>
						{pickerPath}
					</code>
				</div>
				{#if pickerError}
					<p class="text-xs text-destructive">{pickerError}</p>
				{/if}
				<ScrollArea type="always" class="h-64 rounded-md border p-1">
					{#if pickerLoading}
						<div class="p-4 text-xs text-muted-foreground">Loading…</div>
					{:else if pickerDirs.length === 0}
						<div class="p-4 text-xs text-muted-foreground">No subdirectories.</div>
					{:else}
						{#each pickerDirs as dir (dir.path)}
							<button
								type="button"
								class="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
								onclick={() => void loadPicker(dir.path)}
								title={dir.path}
							>
								<Folder class="size-3.5 shrink-0 text-muted-foreground" />
								<span class="truncate">{dir.name}</span>
							</button>
						{/each}
					{/if}
				</ScrollArea>
			</div>
		{/if}

		<Dialog.Footer class="gap-2">
			{#if step === 'settings'}
				<Button
					variant="outline"
					size="sm"
					onclick={() => (app.desktopSettingsOpen = false)}
					disabled={saving}
				>
					Cancel
				</Button>
				<Button
					size="sm"
					onclick={() => void apply()}
					disabled={!changed || !portValid || saving}
				>
					{#if saving}Applying…{:else}Apply{/if}
				</Button>
			{:else}
				<Button variant="outline" size="sm" onclick={() => (step = 'settings')}>
					<ArrowLeft class="size-3.5" /> Back
				</Button>
				<Button
					size="sm"
					onclick={() => {
						rootDirectory = pickerPath;
						step = 'settings';
					}}
					title="Use this directory as the new root"
				>
					Choose this directory
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
