import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		port: 5173
	},
	test: {
		setupFiles: ['tests/setup.ts'],
		include: ['tests/**/*.test.ts'],
		testTimeout: 120_000,
		hookTimeout: 120_000,
		sequence: { concurrent: false }
	}
});
