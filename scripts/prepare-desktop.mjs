/**
 * Assemble the desktop-app resources for the Tauri build (Option A in
 * DeployProposal.md).
 *
 * Produces desktop/src-tauri/resources/:
 *   server/    the adapter-node production server (from npm run build)
 *   native/    the platform's metfilesync_native.node addon
 *   runtime/   a standalone Node runtime (node / node.exe)
 *
 * The Node runtime is taken from MFS_NODE_RUNTIME_DIR if set, otherwise it is
 * downloaded from nodejs.org for the requested platform/arch and cached in
 * desktop/.node-cache/. Cross-target packaging (e.g. preparing Windows
 * resources on macOS) uses --platform/--arch flags.
 *
 *   node scripts/prepare-desktop.mjs [--platform darwin|win32|linux] [--arch arm64|x64]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDir = path.join(root, 'desktop', 'src-tauri', 'resources');
const cacheDir = path.join(root, 'desktop', '.node-cache');

const args = process.argv.slice(2);
function argValue(name) {
	const i = args.indexOf(`--${name}`);
	return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}
const platform = argValue('platform') ?? process.platform; // darwin | win32 | linux
const arch = argValue('arch') ?? process.arch; // arm64 | x64
const nodeVersion = process.versions.node;

const isWindows = platform === 'win32';

function fail(message) {
	console.error(`prepare-desktop: ${message}`);
	process.exit(1);
}

function copyDir(from, to) {
	fs.cpSync(from, to, { recursive: true });
}

// --- server bundle ---------------------------------------------------------
const serverBuild = path.join(root, 'build');
if (!fs.existsSync(path.join(serverBuild, 'index.js'))) {
	fail('build/index.js not found - run `npm run build` first.');
}

// --- native addon ----------------------------------------------------------
const addonSource = path.join(root, 'native', 'build', 'Release', 'metfilesync_native.node');
if (!fs.existsSync(addonSource)) {
	fail('native addon not found - run `npm run build:native` for the target platform first.');
}

// --- node runtime ---------------------------------------------------------
const runtimeDirSource = process.env.MFS_NODE_RUNTIME_DIR;
const nodeBinaryName = isWindows ? 'node.exe' : 'node';

async function downloadNodeRuntime() {
	if (runtimeDirSource) {
		const candidate = path.join(runtimeDirSource, nodeBinaryName);
		if (!fs.existsSync(candidate)) fail(`MFS_NODE_RUNTIME_DIR does not contain ${nodeBinaryName}`);
		return fs.realpathSync(candidate);
	}
	const distPlatform = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : 'linux';
	const ext = isWindows ? 'zip' : 'tar.gz';
	const distDir = `node-v${nodeVersion}-${distPlatform}-${arch === 'x64' ? 'x64' : arch}`;
	const url = `https://nodejs.org/dist/v${nodeVersion}/${distDir}.${ext}`;
	// The .tar.gz layout is <dir>/bin/node; the .zip layout is <dir>/node.exe.
	const inner = isWindows ? path.join(distDir, nodeBinaryName) : path.join(distDir, 'bin', nodeBinaryName);
	const cached = path.join(cacheDir, inner);
	if (fs.existsSync(cached)) return cached;

	console.log(`Downloading Node ${nodeVersion} (${platform}/${arch})...`);
	fs.mkdirSync(path.dirname(path.join(cacheDir, distDir)), { recursive: true });
	const archivePath = path.join(cacheDir, `${distDir}.${ext}`);
	if (!fs.existsSync(archivePath)) {
		const res = await fetch(url);
		if (!res.ok) fail(`could not download ${url} (${res.status})`);
		const buffer = Buffer.from(await res.arrayBuffer());
		fs.writeFileSync(archivePath, buffer);
	}
	// bsdtar is available on macOS, Linux and Windows runners.
	execFileSync('tar', ['-xf', archivePath, '-C', cacheDir], { stdio: 'inherit' });
	if (!fs.existsSync(cached)) fail(`unexpected archive layout: ${inner} not found`);
	return cached;
}

const nodeBinary = await downloadNodeRuntime();

// --- assemble --------------------------------------------------------------
fs.rmSync(resourcesDir, { recursive: true, force: true });
fs.mkdirSync(resourcesDir, { recursive: true });

console.log('  server/   <- build/');
copyDir(serverBuild, path.join(resourcesDir, 'server'));

// Watchdog wrapper: keeps the server tied to the shell's lifetime even if the
// shell is killed abruptly (the stdin pipe closes -> the server exits).
fs.writeFileSync(
	path.join(resourcesDir, 'server', 'server-wrapper.mjs'),
	`// MetFileSync server wrapper - exits when the desktop shell dies.
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', () => {
	/* stdin is never written to; closing it means the parent is gone */
});
await import('./index.js');
`
);

fs.mkdirSync(path.join(resourcesDir, 'native'), { recursive: true });
console.log('  native/   <- metfilesync_native.node');
fs.copyFileSync(addonSource, path.join(resourcesDir, 'native', 'metfilesync_native.node'));

fs.mkdirSync(path.join(resourcesDir, 'runtime'), { recursive: true });
console.log(`  runtime/  <- ${path.relative(root, nodeBinary)}`);
fs.copyFileSync(nodeBinary, path.join(resourcesDir, 'runtime', nodeBinaryName));
if (!isWindows) fs.chmodSync(path.join(resourcesDir, 'runtime', nodeBinaryName), 0o755);

console.log('Desktop resources assembled in desktop/src-tauri/resources');
