import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ROOT } from '$lib/server/config';

/** Read-only server deployment info (used by the settings screen). */
export const GET: RequestHandler = () => {
	return json({ root: ROOT });
};
