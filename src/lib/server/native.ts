/**
 * TypeScript wrapper around the native Sneakernet copy addon.
 *
 * All file movement (copy / rename / delete) goes through this module so that
 * the heavy lifting happens in native OS calls, with progress reported back
 * into JavaScript.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CopyOptions {
	/** Chunk size for the copy loop in bytes (default 8 MiB). */
	chunkSize?: number;
	/** Report progress at least every N bytes (default 32 MiB). */
	reportEveryBytes?: number;
	/** Use the APFS clonefile fast path when available (default true). */
	useClone?: boolean;
}

export interface CopyResult {
	cancelled: boolean;
	bytes: number;
	total: number;
	cloned: boolean;
}

export interface CopyHandle {
	/** Abort the copy. The partial destination file is removed natively. */
	cancel(): void;
	/** Resolves when the copy finishes (or is cancelled). */
	result: Promise<CopyResult>;
}

interface NativeBinding {
	copy(
		src: string,
		dest: string,
		opts: { chunkSize?: number; reportEveryBytes?: number; useClone?: boolean },
		onProgress: (p: { bytes: number; total: number }) => void,
		onDone: (err: string | null, res: CopyResult | null) => void
	): number;
	cancel(jobId: number): boolean;
	rename(src: string, dest: string): void;
	unlink(p: string): void;
	mkdirp(p: string): void;
	utimes(p: string, atimeMs: number, mtimeMs: number): void;
}

let binding: NativeBinding | null = null;

function loadBinding(): NativeBinding {
	if (binding) return binding;
	const require = createRequire(import.meta.url);
	const candidates: string[] = [];
	if (process.env['SNEAKERNET_NATIVE']) candidates.push(process.env['SNEAKERNET_NATIVE']);
	candidates.push(path.resolve(process.cwd(), 'native/build/Release/sneakernet_native.node'));
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		candidates.push(path.resolve(here, '../../../native/build/Release/sneakernet_native.node'));
	} catch {
		/* import.meta.url unavailable in some bundlers; cwd candidate covers it */
	}
	for (const c of candidates) {
		if (c && existsSync(c)) {
			binding = require(c) as NativeBinding;
			return binding;
		}
	}
	throw new Error(
		`Sneakernet native addon not found. Run \`npm run build:native\`. Tried: ${candidates.join(', ')}`
	);
}

export interface ProgressFn {
	(bytes: number, total: number): void;
}

/**
 * Copy a file asynchronously on a worker thread with progress callbacks.
 * The copy can be cancelled mid-flight via the returned handle.
 */
export function copyFile(
	src: string,
	dest: string,
	opts: CopyOptions,
	onProgress?: ProgressFn
): CopyHandle {
	const b = loadBinding();
	let jobId: number | null = null;
	let cancelRequested = false;
		// Only pass keys that are defined: N-API coerces present-but-undefined
		// properties when reading numbers.
		const rawOpts: Record<string, number | boolean> = {};
		if (opts.chunkSize !== undefined) rawOpts['chunkSize'] = opts.chunkSize;
		if (opts.reportEveryBytes !== undefined) rawOpts['reportEveryBytes'] = opts.reportEveryBytes;
		rawOpts['useClone'] = opts.useClone !== false;

		const result = new Promise<CopyResult>((resolve, reject) => {
			jobId = b.copy(
			src,
			dest,
			rawOpts,
			(p) => onProgress?.(p.bytes, p.total),
			(err, res) => {
				if (err !== null) reject(new Error(err));
				else resolve(res as CopyResult);
			}
		);
		if (cancelRequested && jobId !== null) b.cancel(jobId);
	});
	return {
		cancel: () => {
			if (jobId !== null) b.cancel(jobId);
			else cancelRequested = true;
		},
		result
	};
}

/** Atomically move/rename a file (rename(2), replaces existing targets on POSIX). */
export function renameFile(src: string, dest: string): void {
	loadBinding().rename(src, dest);
}

/** Delete a file (no-op if it does not exist). */
export function unlinkFile(p: string): void {
	loadBinding().unlink(p);
}

/** Create a directory and all missing parents (no error if it exists). */
export function makeDirs(p: string): void {
	loadBinding().mkdirp(p);
}

/** Set access/modification times (epoch ms) - used to preserve timestamps. */
export function setTimes(p: string, atimeMs: number, mtimeMs: number): void {
	loadBinding().utimes(p, atimeMs, mtimeMs);
}
