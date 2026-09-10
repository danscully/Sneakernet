/**
 * Seed demo content for local development / manual testing.
 *
 * Creates a small source tree under the sync root plus two destination
 * directories and a demo sync set, so the UI has something to work with.
 *
 *   node scripts/seed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.env.SNEAKERNET_ROOT ?? path.resolve('data', 'root');
const dataDir = process.env.SNEAKERNET_DATA ?? path.resolve('data');

function mkfile(rel, content) {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
}

function mkfileRandom(rel, size) {
	mkfile(rel, crypto.randomBytes(size));
}

// --- Source tree -----------------------------------------------------------
mkfile('demo/src/documents/readme.txt', 'Sneakernet demo file\n');
mkfile('demo/src/documents/notes/todo.md', '# TODO\n\n- try a compare\n- run a sync\n');
mkfileRandom('demo/src/photos/2024/beach.jpg', 256 * 1024);
mkfileRandom('demo/src/photos/2024/city.jpg', 512 * 1024);
mkfileRandom('demo/src/photos/2025/hike.jpg', 1024 * 1024);
mkfileRandom('demo/src/video/clip.mp4', 4 * 1024 * 1024);
mkfile('demo/src/junk/scratch.tmp', 'should be excluded by *.tmp');

// Destination 1: stale copies (different sizes -> will re-sync), plus an
// extra file that exists only in the destination (deletion candidate).
mkfile('demo/dst-primary/documents/readme.txt', 'old contents\n');
mkfileRandom('demo/dst-primary/photos/2024/beach.jpg', 128 * 1024);
mkfile('demo/dst-primary/photos/obsolete.jpg', 'left over from the past');

// Destination 2: empty (fresh copy of everything).
fs.mkdirSync(path.join(root, 'demo/dst-archive'), { recursive: true });

// --- Demo sync set ----------------------------------------------------------
const setsFile = path.join(dataDir, 'syncsets.json');
let sets = [];
try {
	sets = JSON.parse(fs.readFileSync(setsFile, 'utf8')).sets ?? [];
} catch {
	/* first run */
}
if (!sets.some((s) => s.id === 'demo-set')) {
	sets.push({
		id: 'demo-set',
		name: 'Demo Set',
		source: 'demo/src',
		destinations: [
			{ id: 'demo-d1', name: 'Primary', path: 'demo/dst-primary', group: 1 },
			{ id: 'demo-d2', name: 'Archive', path: 'demo/dst-archive', group: 2 }
		],
		dateDeltaSeconds: 0,
		syncDeletions: true,
		includeFilters: [],
		excludeFilters: ['*.tmp'],
		errorPolicy: 'ask'
	});
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(setsFile, JSON.stringify({ version: 1, sets }, null, '\t'));
}

console.log(`Seeded demo content under ${root}`);
console.log(`Sync sets file: ${setsFile}`);
