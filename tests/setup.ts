/**
 * Vitest global setup: point the server config at throwaway directories and
 * force the chunked (non-clone) copy path so progress + cancellation are
 * deterministic in tests. The desktop-settings file lives in the same
 * throwaway area so desktop-settings tests never touch real user data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mfs-test-'));
process.env['SNEAKERNET_ROOT'] = path.join(base, 'root');
process.env['SNEAKERNET_DATA'] = path.join(base, 'data');
process.env['SNEAKERNET_NO_CLONE'] = '1';
process.env['SNEAKERNET_DESKTOP_SETTINGS'] = path.join(base, 'desktop-settings.json');
fs.mkdirSync(process.env['SNEAKERNET_ROOT'], { recursive: true });
fs.mkdirSync(process.env['SNEAKERNET_DATA'], { recursive: true });
