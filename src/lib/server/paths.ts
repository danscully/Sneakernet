/**
 * Path sanitization.
 *
 * Every user-supplied path is resolved against the configured root; any path
 * that attempts to escape the root is rejected.
 */
import path from 'node:path';
import { ROOT } from './config';

export class PathError extends Error {}

/**
 * Normalize a user-supplied relative path and verify it stays inside the root.
 * Returns the relative path with forward slashes and no leading "./".
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
 * Absolute path for a sanitized relative path. Guaranteed to live under ROOT.
 */
export function absPath(relPath: string): string {
	if (relPath === '') return ROOT;
	return path.join(ROOT, ...relPath.split('/'));
}
