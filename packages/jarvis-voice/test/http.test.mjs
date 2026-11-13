/**
 * HTTP surface tests against a real listening server.
 *
 * These pin behaviour that unit-level projection tests cannot: a request for a
 * path that does not exist must *answer* (404) rather than hang, and the token
 * must gate data while leaving the app shell loadable.
 *
 * No agent is spawned: the bridge is pointed at a command that exits instantly,
 * which is enough to exercise routing, auth and static serving.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createJarvisServer } from "../src/server.mjs";
import { DEFAULTS, validate } from "../src/config.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
let jarvis;
let base;

function config(overrides = {}) {
	return validate({
		...DEFAULTS,
		cwd: process.cwd(),
		host: "127.0.0.1",
		port: 0,
		ephemeral: true,
		doctrine: false,
		logLevel: "silent",
		requestTimeoutMs: 2000,
		...overrides,
	});
}

before(async () => {
	// `ompCommand` is a createJarvisServer option, not a validated config key, so
	// it is added after validation rather than smuggled through the validator.
	const cfg = config({ token: TOKEN });
	jarvis = createJarvisServer({ ...cfg, ompCommand: "/bin/false" });
	const { port } = await jarvis.listen({ port: 0, host: "127.0.0.1" });
	base = `http://127.0.0.1:${port}`;
});

after(async () => {
	await jarvis?.shutdown("test");
});

/** Fetch with a hard deadline, so a hanging handler fails the test instead of stalling it. */
async function get(path, headers = {}, timeoutMs = 4000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${base}${path}`, { headers, signal: controller.signal, redirect: "manual" });
		return { status: response.status, text: await response.text() };
	} finally {
		clearTimeout(timer);
	}
}

test("the app shell loads without a token", async () => {
	for (const path of ["/", "/app.js", "/styles.css", "/favicon.svg"]) {
		const { status } = await get(path);
		assert.equal(status, 200, `${path} should be served`);
	}
});

test("the shell is the real app, not an error page", async () => {
	const { text } = await get("/");
	assert.match(text, /omp — Jarvis/);
	assert.match(text, /id="orb"/);
});

test("data endpoints require the token", async () => {
	assert.equal((await get("/api/history")).status, 401);
	assert.equal((await get("/api/history", { "x-jarvis-token": "wrongwrongwrongwrong" })).status, 401);
	assert.equal((await get("/api/history", { "x-jarvis-token": TOKEN })).status, 200);
});

test("a missing static path answers 404 instead of hanging", async () => {
	const { status } = await get("/does-not-exist.js");
	assert.equal(status, 404, "an unanswered request would hang until the test deadline");
});

test("path traversal is refused, not served", async () => {
	for (const path of ["/../package.json", "/..%2f..%2fpackage.json", "/%00"]) {
		const { status } = await get(path);
		assert.ok([400, 403, 404].includes(status), `${path} returned ${status}`);
	}
});

test("health reports not-ready while the agent is down, with 503", async () => {
	const { status, text } = await get("/api/health");
	assert.equal(status, 503);
	const body = JSON.parse(text);
	assert.equal(body.ok, false);
	assert.equal(body.status, "starting");
});

test("metrics are readable without a token and are not rate limited", async () => {
	for (let i = 0; i < 6; i++) {
		assert.equal((await get("/api/metrics")).status, 200, `probe ${i} should not be throttled`);
	}
});

test("a GET on a data endpoint with the wrong method is refused", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 4000);
	try {
		const response = await fetch(`${base}/app.js`, { method: "POST", signal: controller.signal, headers: { "x-jarvis-token": TOKEN } });
		assert.equal(response.status, 405);
	} finally {
		clearTimeout(timer);
	}
});
