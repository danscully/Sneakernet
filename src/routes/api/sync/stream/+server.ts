import type { RequestHandler } from './$types';
import { syncManager } from '$lib/server/engine';
import type { SyncEvent } from '$lib/types';

/**
 * Server-sent events stream.
 *
 * Without a `setId` the stream is global: the snapshot lists every run in
 * the registry (running and finished, from any set / user) and every engine
 * event is forwarded. This is what the Status view uses, so all users watch
 * all syncs. With a `setId` the stream stays scoped to that set (snapshot of
 * its active run + that set's events only).
 */
export const GET: RequestHandler = ({ url, request }) => {
	const setId = url.searchParams.get('setId');
	const { signal } = request;
	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
					);
				} catch {
					closed = true;
				}
			};

			if (setId === null) {
				send('snapshot', { runs: syncManager.runsSnapshot() });
			} else {
				send('snapshot', { snapshot: syncManager.snapshot(setId) });
			}
			const unsubscribe = syncManager.subscribe((e: SyncEvent) => {
				if (setId === null || e.setId === setId) send('event', e);
			});

			const cleanup = () => {
				if (closed) return;
				closed = true;
				unsubscribe();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			signal.addEventListener('abort', cleanup);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		}
	});
};
