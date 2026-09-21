/**
 * Fast directory walker used by the Compare step.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FilterState } from './filters';

export interface WalkEntry {
	relPath: string;
	isDir: boolean;
	size: number;
	mtime: number; // epoch ms
}

export type WalkMap = Map<string, WalkEntry>;

/** Lock file written at a destination root while a sync owns it. */
export const LOCK_FILE = '.sneakernet-lock';

/** True for files the engine parks inside destinations (locks, temp copies). */
export function isEngineFile(relPath: string): boolean {
	const base = relPath.split('/').at(-1) ?? '';
	return base === LOCK_FILE || base.includes('.sneakernet-tmp-');
}

/**
 * Walk a directory tree rooted at `absRoot` (an absolute path) and return a
 * map of relative path -> entry. Paths are filtered through the sync set's
 * filters. Directories are
 * only pruned when they (or an ancestor) match an exclusion - include filters
 * such as "*.txt" never prune a directory, because deeper paths may still
 * match. Symlinks are followed and treated as their targets.
 */
export async function walkTree(absRoot: string, filters: FilterState): Promise<WalkMap> {
	const out: WalkMap = new Map();
	const root = path.resolve(absRoot);
	try {
		const rootStat = await fs.stat(root);
		if (!rootStat.isDirectory()) throw new Error(`not a directory: ${absRoot}`);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith('not a directory')) throw e;
		return out; // missing source/destination -> empty map
	}

	async function walk(dir: string, prefix: string): Promise<void> {
		let entries;
		try {
			entries = await fs.opendir(dir);
		} catch {
			return;
		}
		for await (const dirent of entries) {
			const relPath = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
			let stat;
			try {
				stat = await fs.stat(path.join(dir, dirent.name));
			} catch {
				continue; // raced with the outside world
			}
			const isDir = stat.isDirectory();
			if (filters.matches(relPath)) {
				out.set(relPath, { relPath, isDir, size: isDir ? 0 : stat.size, mtime: stat.mtimeMs });
			}
			// Only exclusion matches make it safe to skip descending.
			if (isDir && !filters.isExcluded(relPath)) {
				await walk(path.join(dir, dirent.name), relPath);
			}
		}
	}

	await walk(root, '');
	return out;
}
