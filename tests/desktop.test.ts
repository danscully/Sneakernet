/**
 * Desktop-app settings (`src/lib/server/desktop.ts`): loopback detection and
 * the desktop-settings.json read/write cycle used by the Desktop Settings
 * dialog. The settings path comes from METFILESYNC_DESKTOP_SETTINGS (set to
 * a temp file in tests/setup.ts).
 */
import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	desktopMode,
	isLoopbackAddress,
	readDesktopSettings,
	writeDesktopSettings
} from '$lib/server/desktop';

const settingsFile = process.env['METFILESYNC_DESKTOP_SETTINGS'] as string;

/** A well-formed settings file as the shell would write it. */
function seedFile(overrides: Record<string, unknown> = {}): void {
	fs.writeFileSync(
		settingsFile,
		JSON.stringify({
			lanSharing: false,
			lanPort: 8787,
			accessToken: 'a'.repeat(32),
			rootDirectory: null,
			...overrides
		})
	);
}

beforeEach(() => {
	fs.rmSync(settingsFile, { force: true });
});

describe('desktopMode', () => {
	it('is true when the settings path env is set', () => {
		expect(desktopMode()).toBe(true);
	});
});

describe('isLoopbackAddress', () => {
	it('accepts loopback addresses', () => {
		expect(isLoopbackAddress('127.0.0.1')).toBe(true);
		expect(isLoopbackAddress('::1')).toBe(true);
		expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
		expect(isLoopbackAddress('localhost')).toBe(true);
	});

	it('rejects remote addresses and missing values', () => {
		expect(isLoopbackAddress('192.168.1.20')).toBe(false);
		expect(isLoopbackAddress('::ffff:192.168.1.20')).toBe(false);
		expect(isLoopbackAddress('10.0.0.5')).toBe(false);
		expect(isLoopbackAddress(undefined)).toBe(false);
		expect(isLoopbackAddress(null)).toBe(false);
	});
});

describe('readDesktopSettings', () => {
	it('returns null when the settings file does not exist', async () => {
		expect(await readDesktopSettings()).toBeNull();
	});

	it('round-trips a settings file and defaults invalid values', async () => {
		seedFile({
			lanSharing: true,
			lanPort: 9100,
			rootDirectory: '/tmp/some-root'
		});
		const settings = await readDesktopSettings();
		expect(settings).toEqual({
			lanSharing: true,
			lanPort: 9100,
			accessToken: 'a'.repeat(32),
			rootDirectory: '/tmp/some-root'
		});
	});

	it('normalizes an out-of-range port to the default', async () => {
		seedFile({ lanPort: 99999 });
		const settings = await readDesktopSettings();
		expect(settings?.lanPort).toBe(8787);
	});

	it('treats a missing/empty rootDirectory as the app default (null)', async () => {
		fs.writeFileSync(
			settingsFile,
			JSON.stringify({ lanSharing: false, lanPort: 8787, accessToken: 't' })
		);
		const settings = await readDesktopSettings();
		expect(settings?.rootDirectory).toBeNull();
	});
});

describe('writeDesktopSettings', () => {
	it('returns null when there is no existing settings file', async () => {
		expect(await writeDesktopSettings({ lanSharing: true })).toBeNull();
	});

	it('merges partial updates into the existing file', async () => {
		seedFile({ lanSharing: false, lanPort: 8787, rootDirectory: null });
		const next = await writeDesktopSettings({ lanSharing: true, lanPort: 9100 });
		expect(next).toMatchObject({ lanSharing: true, lanPort: 9100 });

		const settings = await readDesktopSettings();
		expect(settings).toMatchObject({
			lanSharing: true,
			lanPort: 9100,
			rootDirectory: null,
			accessToken: 'a'.repeat(32)
		});
	});

	it('never lets writes change the access token', async () => {
		seedFile();
		const next = await writeDesktopSettings({ lanSharing: true });
		expect(next?.accessToken).toBe('a'.repeat(32));
	});

	it('stores an empty rootDirectory as null (back to the app default)', async () => {
		seedFile({ rootDirectory: '/tmp/some-root' });
		const next = await writeDesktopSettings({ rootDirectory: '' });
		expect(next?.rootDirectory).toBeNull();
		expect((await readDesktopSettings())?.rootDirectory).toBeNull();
	});
});
