/**
 * Server deployment configuration.
 *
 * All synced directories live under a single root path that is configured
 * locally on the server (never by the client). Resolution order:
 *   1. Environment variable
 *   2. Key in ./config.json (server deployment config)
 *   3. Development default
 *
 * Persistent app data (sync sets, settings, sync logs) is stored as JSON in
 * SNEAKERNET_DATA (default ./data).
 */
import fs from 'node:fs';
import path from 'node:path';

interface LocalConfig {
	root?: string;
	data?: string;
	logRetentionDays?: number;
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
	process.env['SNEAKERNET_ROOT'] ?? local.root ?? path.join(process.cwd(), 'data', 'root')
);

/** Directory for persistent JSON data (sync sets, settings). */
export const DATA_DIR = ensureDir(
	path.resolve(process.env['SNEAKERNET_DATA'] ?? local.data ?? path.join(process.cwd(), 'data'))
);

ensureDir(ROOT);

/** How many days sync log files are kept (default 7). */
export const LOG_RETENTION_DAYS = (() => {
	const raw = Number(process.env['SNEAKERNET_LOG_RETENTION_DAYS'] ?? local.logRetentionDays ?? 7);
	return Number.isFinite(raw) && raw >= 0 ? raw : 7;
})();

/** Directory where per-run sync log files are written. */
export const LOG_DIR = ensureDir(path.join(DATA_DIR, 'logs'));

export const SYNCSETS_FILE = path.join(DATA_DIR, 'syncsets.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

/** Timestamp of the server process start (used to split "this session" logs). */
export const SERVER_STARTED_AT = Date.now();
