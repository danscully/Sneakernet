/**
 * Server deployment configuration.
 *
 * All synced directories live under a single root path that is configured
 * locally on the server (never by the client). Resolution order:
 *   1. METFILESYNC_ROOT environment variable
 *   2. "root" key in ./config.json (server deployment config)
 *   3. ./data/root (development default)
 *
 * Persistent app data (sync sets, settings) is stored as JSON in METFILESYNC_DATA
 * (default ./data).
 */
import fs from 'node:fs';
import path from 'node:path';

interface LocalConfig {
	root?: string;
	data?: string;
}

function readLocalConfig(): LocalConfig {
	try {
		const raw = fs.readFileSync(path.resolve(process.cwd(), 'config.json'), 'utf8');
		return JSON.parse(raw) as LocalConfig;
	} catch {
		return {};
	}
}

const local = readLocalConfig();

function ensureDir(p: string): string {
	fs.mkdirSync(p, { recursive: true });
	return p;
}

/** Absolute path of the sync root. Everything the app can touch lives under this. */
export const ROOT = path.resolve(
	process.env['METFILESYNC_ROOT'] ?? local.root ?? path.join(process.cwd(), 'data', 'root')
);

/** Directory for persistent JSON data (sync sets, settings). */
export const DATA_DIR = ensureDir(
	path.resolve(process.env['METFILESYNC_DATA'] ?? local.data ?? path.join(process.cwd(), 'data'))
);

ensureDir(ROOT);

export const SYNCSETS_FILE = path.join(DATA_DIR, 'syncsets.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
