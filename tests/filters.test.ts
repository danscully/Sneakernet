import { describe, expect, it } from 'vitest';
import { buildFilters, matchesPattern, normalizeFilterList } from '../src/lib/server/filters';

describe('filter patterns', () => {
	it('matches exact partial paths', () => {
		expect(matchesPattern('photos/a.jpg', 'photos/a.jpg')).toBe(true);
		expect(matchesPattern('photos/b.jpg', 'photos/a.jpg')).toBe(false);
	});

	it('matches ancestor directories (whole subtrees)', () => {
		expect(matchesPattern('photos/2024/a.jpg', 'photos')).toBe(true);
		expect(matchesPattern('photos/2024/a.jpg', 'photos/2024')).toBe(true);
		expect(matchesPattern('other/a.jpg', 'photos')).toBe(false);
	});

	it('treats * as a wildcard', () => {
		expect(matchesPattern('photos/a.jpg', '*.jpg')).toBe(true);
		expect(matchesPattern('deep/nested/dir/a.txt', '*.txt')).toBe(true);
		expect(matchesPattern('a/b.jpg', 'photos/*')).toBe(false);
		expect(matchesPattern('photos/sub/dir/a.jpg', 'photos/*.jpg')).toBe(true); // * crosses /
	});

	it('escapes regex metacharacters', () => {
		expect(matchesPattern('a.b/c.jpg', 'a.b/*.jpg')).toBe(true);
		expect(matchesPattern('axb/c.jpg', 'a.b/*.jpg')).toBe(false);
	});

	it('ignores empty patterns', () => {
		expect(matchesPattern('anything', '')).toBe(false);
		expect(matchesPattern('anything', '   ')).toBe(false);
	});
});

describe('buildFilters', () => {
	it('empty include list includes everything', () => {
		const f = buildFilters([], []);
		expect(f.matches('x/y.txt')).toBe(true);
		expect(f.includesEverything).toBe(true);
	});

	it('include filters restrict the file set', () => {
		const f = buildFilters(['photos', '*.txt'], []);
		expect(f.matches('photos/a.jpg')).toBe(true);
		expect(f.matches('photos/sub/b.mp4')).toBe(true);
		expect(f.matches('readme.txt')).toBe(true);
		expect(f.matches('other/a.mp4')).toBe(false);
	});

	it('exclude filters are applied after includes', () => {
		const f = buildFilters(['photos'], ['*.tmp', 'photos/private']);
		expect(f.matches('photos/a.jpg')).toBe(true);
		expect(f.matches('photos/a.tmp')).toBe(false);
		expect(f.matches('photos/private/secret.key')).toBe(false);
	});

	it('exclusion of a directory excludes the whole subtree', () => {
		const f = buildFilters([], ['node_modules']);
		expect(f.matches('node_modules/foo/index.js')).toBe(false);
		expect(f.isExcluded('node_modules/dep')).toBe(true);
		expect(f.matches('src/index.ts')).toBe(true);
	});

	it('normalizeFilterList splits, trims, dedupes', () => {
		expect(normalizeFilterList(['a', ' a ', 'b\\c', '', 'a'])).toEqual(['a', 'b/c']);
		expect(normalizeFilterList('x\n  y \n\nx')).toEqual(['x', 'y']);
	});
});
