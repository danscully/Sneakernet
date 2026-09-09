/**
 * Destination disk-space accounting for the pre-sync warning.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ComparePlan } from '$lib/types';
import { absPath } from './paths';
import type { Selection } from './engine';

/** Warn when a destination would have less than this much space left. */
export const MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GiB

export interface SpaceInfo {
	free: number;
	total: number;
	path: string;
}

/**
 * Free / total bytes of a directory (or the nearest existing ancestor - new
 * destinations may not exist yet).
 */
export async function diskSpace(relPath: string): Promise<SpaceInfo> {
	let rel = relPath;
	// Walk up until we find an existing directory (destinations may not exist yet).
	for (;;) {
		try {
			const st = await fs.statfs(absPath(rel));
			return {
				free: Number(st.bavail) * Number(st.bsize),
				total: Number(st.blocks) * Number(st.bsize),
				path: rel
			};
		} catch {
			if (rel === '') return { free: 0, total: 0, path: '' };
			const parent = path.posix.dirname(rel);
			rel = parent === '.' ? '' : parent;
		}
	}
}

export interface DestSpaceWarning {
	destId: string;
	name: string;
	path: string;
	/** Bytes that will be copied to this destination. */
	requiredBytes: number;
	/** Bytes currently free at (or above) the destination. */
	availableBytes: number;
	/** Projected free bytes after the sync. */
	projectedFreeBytes: number;
	insufficient: boolean;
}

/**
 * Total transfer size per destination for the selected plan items.
 */
export function requiredBytesPerDest(plan: ComparePlan, selection: Selection): Map<string, number> {
	const out = new Map<string, number>();
	for (const item of plan.items) {
		if (item.isDir) continue;
		const destIds = selection[item.relPath];
		if (!destIds) continue;
		const decision = item.dests;
		for (const destId of destIds) {
			if (decision[destId]?.action === 'copy') {
				out.set(destId, (out.get(destId) ?? 0) + item.size);
			}
		}
	}
	return out;
}

/**
 * Check whether any destination would fall below MIN_FREE_BYTES after copying
 * its selected files. Returns the destinations that warrant a warning.
 */
export async function checkDestinations(
	plan: ComparePlan,
	selection: Selection
): Promise<DestSpaceWarning[]> {
	const required = requiredBytesPerDest(plan, selection);
	const warnings: DestSpaceWarning[] = [];
	await Promise.all(
		plan.destinations.map(async (dest) => {
			const need = required.get(dest.id) ?? 0;
			if (need <= 0) return;
			const space = await diskSpace(dest.path);
			const projected = space.free - need;
			if (projected < MIN_FREE_BYTES) {
				warnings.push({
					destId: dest.id,
					name: dest.name,
					path: dest.path,
					requiredBytes: need,
					availableBytes: space.free,
					projectedFreeBytes: projected,
					insufficient: true
				});
			}
		})
	);
	return warnings;
}
