/**
 * Include / Exclude filters.
 *
 * Filters are lists of partial paths with '*' wildcards (matches any
 * characters, including separators). A file or directory matches a filter if
 * the path itself matches, or any of its ancestor directories match - so
 * "photos" includes everything under "photos/", and "photos/*.jpg" includes
 * all jpg files anywhere below "photos/".
 *
 * Inclusion is applied first, exclusion afterwards (exclusion wins).
 * An empty include list includes everything.
 */

/** Escape a partial-path pattern into a regular expression source string. */
export function patternToRegexSource(pattern: string): string {
	let out = '';
	for (const ch of pattern) {
		if (ch === '*') out += '[\\s\\S]*';
		else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
	}
	return out;
}

/** All ancestor directory prefixes of a relative path, longest first. */
export function ancestorsAndSelf(relPath: string): string[] {
	const parts = relPath.split('/');
	const out: string[] = [relPath];
	for (let i = parts.length - 1; i > 0; i--) {
		out.push(parts.slice(0, i).join('/'));
	}
	return out;
}

/** Does this single pattern match the path or one of its ancestor directories? */
export function matchesPattern(relPath: string, pattern: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) return false;
	const re = new RegExp(`^(?:${patternToRegexSource(trimmed)})$`);
	return ancestorsAndSelf(relPath).some((candidate) => re.test(candidate));
}

export interface FilterState {
	/** True if the path (and its ancestors) pass the include + exclude filters. */
	matches(relPath: string): boolean;
	/** True if the path or an ancestor is explicitly excluded (safe to prune dirs). */
	isExcluded(relPath: string): boolean;
	/** True when there are no include filters (everything passes inclusion). */
	includesEverything: boolean;
}

/** Build a filter evaluator from the filter lists of a sync set. */
export function buildFilters(includeFilters: string[], excludeFilters: string[]): FilterState {
	const includes = includeFilters.map((f) => f.trim()).filter(Boolean);
	const excludes = excludeFilters.map((f) => f.trim()).filter(Boolean);
	const includesEverything = includes.length === 0;
	return {
		includesEverything,
		isExcluded: (relPath) => excludes.some((p) => matchesPattern(relPath, p)),
		matches(relPath: string): boolean {
			if (!includesEverything && !includes.some((p) => matchesPattern(relPath, p))) return false;
			if (excludes.some((p) => matchesPattern(relPath, p))) return false;
			return true;
		}
	};
}

/** Normalize a raw filter list (split newlines, trim, drop empties and dups). */
export function normalizeFilterList(list: string[] | string): string[] {
	const raw = Array.isArray(list) ? list : list.split('\n');
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		const t = String(item).trim().replace(/\\/g, '/').replace(/^\.\//, '');
		if (!t || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}
