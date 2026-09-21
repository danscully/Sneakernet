/**
 * Path handling.
 *
 * Sync set sources and destinations are ABSOLUTE paths chosen on the
 * machine running the server (via the native directory picker in the
 * desktop app). The functions below validate that.
 *
 * The root-relative helpers (`sanitizeRelPath` / `absPath`) are LEGACY:
 * they are kept for (a) the one-time migration of old root-relative sync
 * sets at load time, (b) the retained root-directory picker component
 * (PathPicker.svelte + /api/tree), and (c) the seed script.
 */
import path from 'node:path';
import { ROOT } from './config';

export class PathError extends Error {}

/**
 * Validate a user-supplied directory path. It must be absolute; the
 * normalized (resolved) form is returned. Empty paths are rejected.
 */
export function validateAbsolutePath(userPath: string): string {
	if (typeof userPath !== 'string') throw new PathError('path must be a string');
	const trimmed = userPath.trim();
	if (trimmed === '') throw new PathError('path is required');
	if (!path.isAbsolute(trimmed)) {
		throw new PathError(`path must be absolute: ${userPath}`);
	}
	return path.resolve(trimmed);
}

/**
 * Resolve a legacy root-relative path against the configured root
 * (absolute input passes through unchanged). Used only by the one-time
 * migration of old data to absolute paths.
 */
export function resolveLegacyPath(userPath: string): string {
	if (typeof userPath !== 'string') return ROOT;
	return path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(ROOT, userPath);
}

/**
 * LEGACY. Normalize a user-supplied relative path and verify it stays
 * inside the root. Returns the relative path with forward slashes and no
 * leading "./".
 */
export function sanitizeRelPath(userPath: string): string {
	if (typeof userPath !== 'string') throw new PathError('path must be a string');
	let p = userPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
	// Windows drive letters / absolute-ish inputs are rejected by the containment check below.
	p = p.replace(/^\.\//, '');
	if (p === '' || p === '.') return '';
	const abs = path.resolve(ROOT, p);
	const rel = path.relative(ROOT, abs);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new PathError(`path escapes the sync root: ${userPath}`);
	}
	return rel.split(path.sep).join('/');
}

/**
 * LEGACY. Absolute path for a sanitized relative path. Guaranteed to live
 * under ROOT.
 */
export function absPath(relPath: string): string {
	if (relPath === '') return ROOT;
	return path.join(ROOT, ...relPath.split('/'));
}
