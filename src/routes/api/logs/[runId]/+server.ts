import { json } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { LOG_DIR } from '$lib/server/config';

/** Full text of one sync run log. */
export const GET: RequestHandler = async ({ params }) => {
	const runId = params.runId;
	// runId is a server-generated UUID; reject anything unexpected.
	if (!/^[a-zA-Z0-9-]+$/.test(runId)) {
		return json({ error: 'invalid log id' }, { status: 400 });
	}
	const file = `${LOG_DIR}/run-${runId}.log`;
	try {
		const content = await fs.readFile(file, 'utf8');
		return json({ content });
	} catch {
		return json({ error: 'log not found' }, { status: 404 });
	}
};
