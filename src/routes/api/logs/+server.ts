import { json } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import type { RequestHandler } from './$types';
import type { SyncLogInfo } from '$lib/types';
import { LOG_DIR, LOG_RETENTION_DAYS, SERVER_STARTED_AT } from '$lib/server/config';

/** List all sync run logs (newest first). */
export const GET: RequestHandler = async () => {
	try {
		const names = await fs.readdir(LOG_DIR);
		const logs: SyncLogInfo[] = [];
		await Promise.all(
			names
				.filter((f) => f.startsWith('run-') && f.endsWith('.log'))
				.map(async (f) => {
					try {
						const full = `${LOG_DIR}/${f}`;
						const [stat, firstLine] = await Promise.all([
							fs.stat(full),
							fs.open(full, 'r').then(async (h) => {
								const buf = Buffer.alloc(1024);
								const { bytesRead } = await h.read(buf, 0, 1024, 0);
								await h.close();
								return buf.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
							})
						]);
						const meta = JSON.parse(firstLine) as Partial<SyncLogInfo>;
						logs.push({
							runId: meta.runId ?? f.slice(4, -4),
							setId: meta.setId ?? '',
							setName: meta.setName ?? '(unknown set)',
							startedAt: meta.startedAt ?? stat.mtimeMs,
							file: f,
							size: stat.size,
							session: (meta.startedAt ?? stat.mtimeMs) >= SERVER_STARTED_AT
						});
					} catch {
						/* unreadable log file; skip */
					}
				})
		);
		logs.sort((a, b) => b.startedAt - a.startedAt);
		return json({ logs, retentionDays: LOG_RETENTION_DAYS });
	} catch {
		return json({ logs: [], retentionDays: LOG_RETENTION_DAYS });
	}
};
