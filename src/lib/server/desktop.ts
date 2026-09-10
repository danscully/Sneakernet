/**
 * Desktop-app settings (the Tauri shell's `desktop-settings.json`).
 *
 * The web app can only touch these when it is running as the desktop app's
 * local server AND the request comes from the loopback interface (the Tauri
 * webview). Remote users - even when LAN sharing is enabled - are refused.
 *
 * The file is owned jointly by the shell (which restarts the server when it
 * changes) and the server (which the modal UI talks to). The shell points the
 * server at the file via SNEAKERNET_DESKTOP_SETTINGS.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';

export interface DesktopSettings {
	/** LAN sharing enabled (server binds 0.0.0.0 + token guard). */
	lanSharing: boolean;
	/** Stable port used when LAN sharing is enabled. */
	lanPort: number;
	/** Secret token embedded in the shared access link. */
	accessToken: string;
	/** Absolute path of the sync root; null = the shell's default. */
	rootDirectory: string | null;
}

/** Path of the settings file (only set when running under the desktop shell). */
const settingsPath = process.env['SNEAKERNET_DESKTOP_SETTINGS'] ?? null;

/** True when the server runs under the Tauri desktop shell. */
export function desktopMode(): boolean {
	return settingsPath !== null;
}

/** Pure helper: is this client address the loopback interface? */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
	return (
		addr === '127.0.0.1' ||
		addr === '::1' ||
		addr === '::ffff:127.0.0.1' ||
		addr === 'localhost'
	);
}

/** True when this request originates from the desktop app's webview. */
export function isDesktopHost(event: Pick<RequestEvent, 'getClientAddress'>): boolean {
	return desktopMode() && isLoopbackAddress(event.getClientAddress());
}

const DEFAULT_LAN_PORT = 8787;

function normalize(parsed: Partial<DesktopSettings>): DesktopSettings {
	const lanPort = Number(parsed.lanPort);
	return {
		lanSharing: Boolean(parsed.lanSharing),
		lanPort: Number.isInteger(lanPort) && lanPort >= 1 && lanPort <= 65535 ? lanPort : DEFAULT_LAN_PORT,
		accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : '',
		rootDirectory: typeof parsed.rootDirectory === 'string' && parsed.rootDirectory !== ''
			? parsed.rootDirectory
			: null
	};
}

/** Read the settings file (null when not in desktop mode or unreadable). */
export async function readDesktopSettings(): Promise<DesktopSettings | null> {
	if (!settingsPath) return null;
	try {
		const raw = await fs.readFile(settingsPath, 'utf8');
		return normalize(JSON.parse(raw) as Partial<DesktopSettings>);
	} catch {
		return null;
	}
}

/**
 * Merge + persist settings changes (atomic tmp+rename). Returns the new
 * settings, or null when not in desktop mode / no existing file.
 */
export async function writeDesktopSettings(
	update: { lanSharing?: boolean; lanPort?: number; rootDirectory?: string | null }
): Promise<DesktopSettings | null> {
	if (!settingsPath) return null;
	const current = await readDesktopSettings();
	if (!current) return null;
	const next: DesktopSettings = {
		lanSharing: update.lanSharing ?? current.lanSharing,
		lanPort: update.lanPort ?? current.lanPort,
		accessToken: current.accessToken,
		rootDirectory:
			update.rootDirectory === undefined ? current.rootDirectory : update.rootDirectory || null
	};
	const tmp = `${settingsPath}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(next, null, '\t'), 'utf8');
	await fs.rename(tmp, settingsPath);
	return next;
}

/** The directory containing the settings file (used for lock-free tmp files). */
export function desktopSettingsDir(): string | null {
	return settingsPath ? path.dirname(settingsPath) : null;
}
