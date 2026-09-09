import { describe, expect, it } from 'vitest';
import { accessCookieHeader, accessDecision } from '../src/lib/server/access';

describe('access decision (LAN sharing guard)', () => {
	const TOKEN = 'secret-token-1';

	it('is open when no token is required (dev / non-shared desktop)', () => {
		expect(accessDecision({ required: undefined })).toBe('open');
		expect(accessDecision({ required: undefined, cookie: 'whatever' })).toBe('open');
	});

	it('accepts a matching cookie', () => {
		expect(accessDecision({ required: TOKEN, cookie: TOKEN })).toBe('ok');
	});

	it('grants when the query parameter matches (and sets a cookie)', () => {
		expect(accessDecision({ required: TOKEN, queryToken: TOKEN })).toBe('grant');
		expect(accessDecision({ required: TOKEN, cookie: 'wrong', queryToken: TOKEN })).toBe('grant');
	});

	it('denies missing, wrong or partial knowledge', () => {
		expect(accessDecision({ required: TOKEN })).toBe('denied');
		expect(accessDecision({ required: TOKEN, cookie: 'nope' })).toBe('denied');
		expect(accessDecision({ required: TOKEN, queryToken: 'nope' })).toBe('denied');
		// Prefix/token-confusion variants
		expect(accessDecision({ required: TOKEN, queryToken: `${TOKEN}x` })).toBe('denied');
		expect(accessDecision({ required: TOKEN, queryToken: '' })).toBe('denied');
	});

	it('serializes a restrictive access cookie', () => {
		const header = accessCookieHeader(TOKEN);
		expect(header).toContain(`mfs_token=${TOKEN}`);
		expect(header).toContain('Path=/');
		expect(header).toContain('HttpOnly');
		expect(header).toContain('SameSite=Lax');
	});
});
