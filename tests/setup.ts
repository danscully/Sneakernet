/**
 * Vitest global setup: point the server config at throwaway directories and
 * force the chunked (non-clone) copy path so progress + cancellation are
 * deterministic in tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mfs-test-'));
process.env['METFILESYNC_ROOT'] = path.join(base, 'root');
process.env['METFILESYNC_DATA'] = path.join(base, 'data');
process.env['METFILESYNC_NO_CLONE'] = '1';
fs.mkdirSync(process.env['METFILESYNC_ROOT'], { recursive: true });
fs.mkdirSync(process.env['METFILESYNC_DATA'], { recursive: true });
