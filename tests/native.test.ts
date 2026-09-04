/**
 * Test scaffolding for the native copy engine.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFile, makeDirs, renameFile, setTimes, unlinkFile } from '../src/lib/server/native';

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'mfs-native-'));
}

function writeFile(dir: string, name: string, bytes: number): string {
	const p = path.join(dir, name);
	fs.writeFileSync(p, crypto.randomBytes(bytes));
	return p;
}

function sha256(p: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('native copy engine', () => {
	it('copies a file with identical content and preserved mode', async () => {
		const dir = tempDir();
		const src = writeFile(dir, 'src.bin', 24 * 1024 * 1024);
		const dest = path.join(dir, 'dest.bin');
		const events: number[] = [];
		const handle = copyFile(src, dest, { useClone: false, chunkSize: 1024 * 1024 }, (bytes) =>
			events.push(bytes)
		);
		const result = await handle.result;
		expect(result.cancelled).toBe(false);
		expect(result.bytes).toBe(24 * 1024 * 1024);
		expect(sha256(dest)).toBe(sha256(src));
		expect(fs.statSync(dest).mode & 0o777).toBe(fs.statSync(src).mode & 0o777);
		// Progress callbacks were delivered and are monotonic.
		expect(events.length).toBeGreaterThan(0);
		expect([...events].sort((a, b) => a - b)).toEqual(events);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('uses the clone fast path when available (same volume)', async () => {
		const dir = tempDir();
		const src = writeFile(dir, 'src.bin', 8 * 1024 * 1024);
		const dest = path.join(dir, 'dest.bin');
		const handle = copyFile(src, dest, {});
		const result = await handle.result;
		expect(result.cancelled).toBe(false);
		if (result.cloned) {
			// clonefile is available on APFS; if the temp dir is not APFS the
			// copy falls back to the chunk loop.
			expect(result.bytes).toBe(8 * 1024 * 1024);
		}
		expect(sha256(dest)).toBe(sha256(src));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('cancels mid-copy and removes the partial destination', async () => {
		const dir = tempDir();
		const src = writeFile(dir, 'big.bin', 256 * 1024 * 1024);
		const dest = path.join(dir, 'dest.bin');
		const handle = copyFile(src, dest, { useClone: false, chunkSize: 1024 * 1024 }, () => {
			// Cancel as soon as progress starts arriving.
			handle.cancel();
		});
		const result = await handle.result;
		expect(result.cancelled).toBe(true);
		expect(fs.existsSync(dest)).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('rejects when the source does not exist', async () => {
		const dir = tempDir();
		const handle = copyFile(path.join(dir, 'missing'), path.join(dir, 'out'), { useClone: false });
		await expect(handle.result).rejects.toThrow(/stat source/);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('overwrites an existing destination file', async () => {
		const dir = tempDir();
		const src = writeFile(dir, 'src.bin', 1024 * 1024);
		const dest = path.join(dir, 'dest.bin');
		fs.writeFileSync(dest, 'old contents');
		await copyFile(src, dest, { useClone: false }).result;
		expect(sha256(dest)).toBe(sha256(src));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('renames, deletes, creates directories and preserves timestamps', () => {
		const dir = tempDir();
		const src = writeFile(dir, 'a.bin', 4096);
		const dest = path.join(dir, 'b.bin');
		renameFile(src, dest);
		expect(fs.existsSync(src)).toBe(false);
		expect(fs.existsSync(dest)).toBe(true);

		const mtime = new Date('2020-05-06T07:08:09Z').getTime();
		setTimes(dest, mtime, mtime);
		expect(Math.abs(fs.statSync(dest).mtimeMs - mtime)).toBeLessThan(50);

		makeDirs(path.join(dir, 'x/y/z'));
		expect(fs.statSync(path.join(dir, 'x/y/z')).isDirectory()).toBe(true);
		makeDirs(path.join(dir, 'x/y/z')); // idempotent

		unlinkFile(dest);
		expect(fs.existsSync(dest)).toBe(false);
		unlinkFile(dest); // missing files are tolerated
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
