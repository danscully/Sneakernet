/**
 * Compare step: examine every destination directory against the source and
 * decide which files/directories need to be synced. All destination
 * comparisons run in parallel.
 */
import { randomUUID } from 'node:crypto';
import type { ComparePlan, DestDecision, PlanItem, SyncSet } from '$lib/types';
import { sanitizeRelPath } from './paths';
import { buildFilters } from './filters';
import { isEngineFile, walkTree, type WalkMap } from './walker';

/**
 * Compare a sync set's source against all of its destinations.
 * Paths in the sync set must already be sanitized.
 */
export async function compareSet(set: SyncSet): Promise<ComparePlan> {
	const sourceRel = sanitizeRelPath(set.source);
	const filters = buildFilters(set.includeFilters, set.excludeFilters);
	const deltaMs = Math.max(0, set.dateDeltaSeconds) * 1000;

	// The source tree is walked once; every destination walks its own tree.
	const source = await walkTree(sourceRel, filters);
	const destWalks: WalkMap[] = await Promise.all(
		set.destinations.map((d) => walkTree(sanitizeRelPath(d.path), filters))
	);

	const items = new Map<string, PlanItem>();

	const upsert = (relPath: string, isDir: boolean, size: number, mtime: number): PlanItem => {
		let item = items.get(relPath);
		if (!item) {
			item = { relPath, isDir, size, mtime, dests: {} };
			items.set(relPath, item);
		}
		return item;
	};

	set.destinations.forEach((dest, i) => {
		const destMap = destWalks[i]!;
		// Lock files and leftover temp copies belong to the engine, not the user.
		for (const relPath of destMap.keys()) {
			if (isEngineFile(relPath)) destMap.delete(relPath);
		}

		// --- Source -> destination -----------------------------------------
		for (const [relPath, srcEntry] of source) {
			if (!filters.matches(relPath)) continue; // walkTree already filters; defensive
			const item = upsert(relPath, srcEntry.isDir, srcEntry.size, srcEntry.mtime);
			const dst = destMap.get(relPath);
			let action: 'copy' | 'delete' | 'same';
			if (srcEntry.isDir) {
				action = dst && dst.isDir ? 'same' : 'copy';
			} else if (!dst || dst.isDir) {
				action = 'copy';
			} else if (srcEntry.size !== dst.size) {
				action = 'copy';
			} else if (Math.abs(srcEntry.mtime - dst.mtime) > deltaMs) {
				action = 'copy';
			} else {
				action = 'same';
			}
			if (action === 'copy') {
				item.dests[dest.id] = { action, size: srcEntry.size, mtime: srcEntry.mtime };
			} else {
				item.dests[dest.id] = { action, size: dst?.size ?? 0, mtime: dst?.mtime ?? 0 };
			}
		}

		// --- Destination -> source (deletions) -----------------------------
		if (set.syncDeletions) {
			for (const [relPath, dstEntry] of destMap) {
				if (dstEntry.isDir) continue; // only files are deleted
				const srcEntry = source.get(relPath);
				if (srcEntry) continue; // handled above
				const item = upsert(relPath, false, dstEntry.size, dstEntry.mtime);
				item.dests[dest.id] = { action: 'delete', size: dstEntry.size, mtime: dstEntry.mtime };
			}
		}
	});

	// Drop rows where every destination decided 'same' (nothing to do).
	for (const item of items.values()) {
		if (Object.values(item.dests).every((d) => d.action === 'same')) items.delete(item.relPath);
	}

	// Sort: directories first (creation order), then files; both alphabetical.
	const sorted = [...items.values()].sort((a, b) => {
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return a.relPath.localeCompare(b.relPath);
	});

	const destDecision = (d: DestDecision | undefined): DestDecision =>
		d ?? { action: 'same', size: 0, mtime: 0 };
	for (const item of sorted) {
		for (const dest of set.destinations) {
			item.dests[dest.id] = destDecision(item.dests[dest.id]);
		}
	}

	return {
		id: randomUUID(),
		setId: set.id,
		setName: set.name,
		createdAt: Date.now(),
		source: sourceRel,
		dateDeltaSeconds: set.dateDeltaSeconds,
		syncDeletions: set.syncDeletions,
		destinations: set.destinations,
		items: sorted
	};
}
