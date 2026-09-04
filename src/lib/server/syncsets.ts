/**
 * Sync Set persistence. All settings are stored as JSON in the data directory;
 * import/export of sync sets as JSON files is supported at the API layer.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { DestinationConfig, SyncSet } from '$lib/types';
import { SYNCSETS_FILE } from './config';
import { sanitizeRelPath } from './paths';
import { normalizeFilterList } from './filters';

interface SyncSetsFile {
	version: 1;
	sets: SyncSet[];
}

const MAX_GROUPS = 10;

export class ValidationError extends Error {}

function newDestId(): string {
	return randomUUID().slice(0, 8);
}

/** Parse and validate a sync set coming from a client / import file. */
export function validateSyncSet(input: unknown, existingIds: Set<string>): SyncSet {
	if (typeof input !== 'object' || input === null) throw new ValidationError('sync set must be an object');
	const raw = input as Record<string, unknown>;
	const name = String(raw['name'] ?? '').trim();
	if (!name) throw new ValidationError('name is required');
	if (name.length > 100) throw new ValidationError('name is too long');

	let source: string;
	try {
		source = sanitizeRelPath(String(raw['source'] ?? ''));
	} catch (e) {
		throw new ValidationError(e instanceof Error ? e.message : 'invalid source path');
	}
	if (source === '') throw new ValidationError('source is required');

	const policy = String(raw['errorPolicy'] ?? 'ask');
	if (!['stop', 'ignore', 'ask'].includes(policy)) {
		throw new ValidationError('errorPolicy must be one of stop, ignore, ask');
	}

	const dateDeltaSeconds = Number(raw['dateDeltaSeconds'] ?? 0);
	if (!Number.isFinite(dateDeltaSeconds) || dateDeltaSeconds < 0 || dateDeltaSeconds > 86400 * 365) {
		throw new ValidationError('dateDeltaSeconds must be a non-negative number');
	}

	const syncDeletions = Boolean(raw['syncDeletions']);

	const rawDests = Array.isArray(raw['destinations']) ? raw['destinations'] : [];
	if (rawDests.length === 0) throw new ValidationError('at least one destination is required');
	if (rawDests.length > 50) throw new ValidationError('too many destinations (max 50)');
	const destinations: DestinationConfig[] = [];
	const seenPaths = new Set<string>();
	for (const rd of rawDests) {
		if (typeof rd !== 'object' || rd === null) throw new ValidationError('invalid destination');
		const d = rd as Record<string, unknown>;
		const dName = String(d['name'] ?? '').trim();
		if (!dName) throw new ValidationError('destination name is required');
		let dPath: string;
		try {
			dPath = sanitizeRelPath(String(d['path'] ?? ''));
		} catch (e) {
			throw new ValidationError(e instanceof Error ? e.message : 'invalid destination path');
		}
		if (dPath === '') throw new ValidationError('destination path is required');
		if (seenPaths.has(dPath)) throw new ValidationError(`duplicate destination path: ${dPath}`);
		if (dPath === source) throw new ValidationError('destination path must differ from source');
		seenPaths.add(dPath);
		const group = Math.round(Number(d['group'] ?? 1));
		if (!Number.isInteger(group) || group < 1 || group > MAX_GROUPS) {
			throw new ValidationError(`destination group must be 1..${MAX_GROUPS}`);
		}
		destinations.push({
			id: typeof d['id'] === 'string' && d['id'] ? d['id'] : newDestId(),
			name: dName,
			path: dPath,
			group
		});
	}
	// Deduplicate destination ids defensively.
	const seenIds = new Set<string>();
	for (const d of destinations) {
		let id = d.id;
		while (seenIds.has(id)) id = newDestId();
		seenIds.add(id);
		d.id = id;
	}

	return {
		id: typeof raw['id'] === 'string' && raw['id'] ? raw['id'] : randomUUID(),
		name,
		source,
		destinations,
		dateDeltaSeconds,
		syncDeletions,
		includeFilters: normalizeFilterList(
			Array.isArray(raw['includeFilters']) ? (raw['includeFilters'] as unknown[]) : []
		),
		excludeFilters: normalizeFilterList(
			Array.isArray(raw['excludeFilters']) ? (raw['excludeFilters'] as unknown[]) : []
		),
		errorPolicy: policy as SyncSet['errorPolicy']
	};
}

let cache: SyncSet[] | null = null;

export async function listSets(): Promise<SyncSet[]> {
	if (cache) return cache;
	try {
		const raw = await fs.readFile(SYNCSETS_FILE, 'utf8');
		const parsed = JSON.parse(raw) as SyncSetsFile;
		cache = parsed.sets.filter((s) => typeof s.id === 'string');
	} catch {
		cache = [];
	}
	return cache;
}

async function persist(sets: SyncSet[]): Promise<void> {
	const data: SyncSetsFile = { version: 1, sets };
	const tmp = `${SYNCSETS_FILE}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(data, null, '\t'), 'utf8');
	await fs.rename(tmp, SYNCSETS_FILE);
	cache = sets;
}

export async function getSet(id: string): Promise<SyncSet | undefined> {
	const sets = await listSets();
	return sets.find((s) => s.id === id);
}

export async function createSet(input: unknown): Promise<SyncSet> {
	const sets = await listSets();
	const existingIds = new Set(sets.map((s) => s.id));
	let set = validateSyncSet(input, existingIds);
	// Guarantee unique id.
	while (existingIds.has(set.id)) set = { ...set, id: randomUUID() };
	await persist([...sets, set]);
	return set;
}

export async function updateSet(id: string, input: unknown): Promise<SyncSet> {
	const sets = await listSets();
	const idx = sets.findIndex((s) => s.id === id);
	if (idx === -1) throw new ValidationError('sync set not found');
	const updated = { ...validateSyncSet(input, new Set(sets.map((s) => s.id))), id };
	sets[idx] = updated;
	await persist(sets);
	return updated;
}

export async function deleteSet(id: string): Promise<boolean> {
	const sets = await listSets();
	const next = sets.filter((s) => s.id !== id);
	if (next.length === sets.length) return false;
	await persist(next);
	return true;
}
