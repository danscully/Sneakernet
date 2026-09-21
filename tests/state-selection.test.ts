/**
 * File List selection logic in the client state (src/lib/state.svelte.ts):
 * per-destination header checkboxes (tri-state + set-all), row/cell
 * selection setters used by the multi-row selection, and the plan-header
 * sync after saving a set (group changes show up without a re-compare).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComparePlan, PlanItem, SyncSet } from '../src/lib/types';
import { AppState } from '../src/lib/state.svelte';

// localStorage does not exist in the node test environment. Plain assignment
// (not vi.stubGlobal) so it survives vi.unstubAllGlobals() in individual tests.
globalThis.localStorage = {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined
} as unknown as Storage;

function fakePlan(): { set: SyncSet; plan: ComparePlan } {
	const set: SyncSet = {
		id: 's1',
		name: 'S',
		source: '/src',
		destinations: [
			{ id: 'd1', name: 'D1', path: '/dst1', group: 1 },
			{ id: 'd2', name: 'D2', path: '/dst2', group: 2 }
		],
		dateDeltaSeconds: 0,
		syncDeletions: false,
		includeFilters: [],
		excludeFilters: [],
		errorPolicy: 'ask'
	};
	const item = (relPath: string, dests: PlanItem['dests']): PlanItem => ({
		relPath,
		isDir: false,
		size: 1,
		mtime: 0,
		dests
	});
	const plan: ComparePlan = {
		id: 'p1',
		setId: 's1',
		setName: 'S',
		createdAt: 0,
		source: '/src',
		dateDeltaSeconds: 0,
		syncDeletions: false,
		destinations: set.destinations,
		items: [
			// a.txt: actionable in both destinations.
			item('a.txt', {
				d1: { action: 'copy', size: 1, mtime: 0 },
				d2: { action: 'copy', size: 1, mtime: 0 }
			}),
			// b.txt: nothing to do for d1; a deletion in d2.
			item('b.txt', {
				d1: { action: 'same', size: 1, mtime: 0 },
				d2: { action: 'delete', size: 1, mtime: 0 }
			})
		]
	};
	return { set, plan };
}

describe('file list selection state', () => {
	let app: AppState;

	beforeEach(() => {
		app = new AppState();
		const { plan } = fakePlan();
		app.setPlan(plan); // default: every actionable cell selected
	});

	it('isCellActionable reflects the plan decisions', () => {
		expect(app.isCellActionable('a.txt', 'd1')).toBe(true);
		expect(app.isCellActionable('b.txt', 'd1')).toBe(false);
		expect(app.isCellActionable('b.txt', 'd2')).toBe(true);
		expect(app.isCellActionable('missing.txt', 'd1')).toBe(false);
	});

	it('header tri-state: all -> some -> none as cells are cleared', () => {
		// Everything actionable is selected by default.
		expect(app.destSelectionState('d1')).toBe('all');
		expect(app.destSelectionState('d2')).toBe('all');

		app.setCellSelection('a.txt', 'd2', false);
		expect(app.destSelectionState('d2')).toBe('some'); // b.txt delete still selected

		app.setCellSelection('b.txt', 'd2', false);
		expect(app.destSelectionState('d2')).toBe('none');
		expect(app.destSelectionState('d1')).toBe('all'); // untouched
	});

	it('setDestAll clears / selects one destination for every actionable row', () => {
		app.setDestAll('d1', false);
		expect(app.selection['a.txt']).toEqual(['d2']); // d1 cleared, d2 kept
		expect(app.selection['b.txt']).toEqual(['d2']); // d1 never there ('same')
		expect(app.destSelectionState('d1')).toBe('none');

		app.setDestAll('d2', false);
		expect(app.selection['a.txt']).toEqual([]);
		expect(app.selection['b.txt']).toEqual([]);

		app.setDestAll('d2', true);
		expect(app.selection['a.txt']).toEqual(['d2']);
		expect(app.selection['b.txt']).toEqual(['d2']);
	});

	it('setRowSelection selects/clears only actionable cells of a row', () => {
		app.setRowSelection('b.txt', false);
		expect(app.selection['b.txt']).toEqual([]);
		app.setRowSelection('b.txt', true);
		// d1 is 'same' for b.txt -> only d2.
		expect(app.selection['b.txt']).toEqual(['d2']);
		app.setRowSelection('a.txt', true);
		expect(app.selection['a.txt']).toEqual(['d1', 'd2']);
	});

	it('selectedCount only counts rows with something selected', () => {
		// 2 actionable rows by default (a.txt, b.txt).
		expect(app.selectedCount).toBe(2);
		// Deselecting a row leaves an empty array in the map - it must not
		// count as selected (this used to report the un-deselected total).
		app.setRowSelection('a.txt', false);
		expect(app.selectedCount).toBe(1);
		app.setCellSelection('a.txt', 'd2', true);
		expect(app.selectedCount).toBe(2);
		app.setRowSelection('a.txt', false);
		app.setRowSelection('b.txt', false);
		expect(app.selectedCount).toBe(0);
	});

	it('setCellSelection never duplicates and can re-select', () => {
		app.setCellSelection('a.txt', 'd1', true);
		expect(app.selection['a.txt']).toEqual(['d1', 'd2']);
		app.setCellSelection('a.txt', 'd1', false);
		expect(app.selection['a.txt']).toEqual(['d2']);
		app.setCellSelection('a.txt', 'd1', true);
		expect(app.selection['a.txt']).toEqual(['d2', 'd1']);
	});
});

describe('plan header sync after saving a set', () => {
	it('updates destination names/groups in the plan without a re-compare', async () => {
		const app = new AppState();
		const { set, plan } = fakePlan();
		app.sets = [set];
		app.draft = { ...set };
		app.draftJson = JSON.stringify(set);
		app.setPlan(plan);
		expect(app.plan?.destinations.find((d) => d.id === 'd2')?.group).toBe(2);

		// The user moves D2 to group 1 in the editor and saves.
		const saved: SyncSet = {
			...set,
			destinations: [
				{ id: 'd1', name: 'D1', path: '/dst1', group: 1 },
				{ id: 'd2', name: 'D2-renamed', path: '/dst2', group: 1 }
			]
		};
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ set: saved })
		});
		vi.stubGlobal('fetch', fetchMock);
		try {
			app.draft = saved;
			const ok = await app.saveDraft();
			expect(ok).toBe(true);
			// The File List header now reflects the saved set...
			const header = app.plan?.destinations.find((d) => d.id === 'd2');
			expect(header?.group).toBe(1);
			expect(header?.name).toBe('D2-renamed');
			// ...but the plan items (the actual decisions) are untouched.
			expect(app.plan?.id).toBe('p1');
			expect(app.plan?.items.length).toBe(2);
			// The selection survives too.
			expect(app.selection['a.txt']).toEqual(['d1', 'd2']);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('does not touch the plan when another set was saved', async () => {
		const app = new AppState();
		const { set, plan } = fakePlan();
		app.sets = [set];
		app.setPlan(plan);
		const other: SyncSet = { ...set, id: 's2', name: 'Other' };
		app.draft = other;
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: true, json: async () => ({ set: other }) })
		);
		try {
			await app.saveDraft();
			expect(app.plan?.destinations.find((d) => d.id === 'd2')?.group).toBe(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
