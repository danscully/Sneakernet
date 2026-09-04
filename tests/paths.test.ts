import { describe, expect, it } from 'vitest';
import { absPath, sanitizeRelPath } from '../src/lib/server/paths';
import { ROOT } from '../src/lib/server/config';

describe('sanitizeRelPath', () => {
	it('normalizes separators and leading ./', () => {
		expect(sanitizeRelPath('photos//2024')).toBe('photos/2024');
		expect(sanitizeRelPath('./photos')).toBe('photos');
		expect(sanitizeRelPath('photos\\2024')).toBe('photos/2024');
	});

	it('accepts root itself', () => {
		expect(sanitizeRelPath('')).toBe('');
		expect(sanitizeRelPath('.')).toBe('');
	});

	it('rejects paths escaping the root', () => {
		expect(() => sanitizeRelPath('../outside')).toThrow(/escapes/);
		expect(() => sanitizeRelPath('a/../../outside')).toThrow(/escapes/);
		expect(() => sanitizeRelPath('..')).toThrow(/escapes/);
	});

	it('maps absolute-looking paths inside the root', () => {
		// Cannot escape; treated as relative to the root.
		expect(sanitizeRelPath('/etc')).toBe('etc');
	});

	it('absPath stays under the root', () => {
		expect(absPath('a/b')).toBe(`${ROOT}/a/b`);
		expect(absPath('')).toBe(ROOT);
	});
});
