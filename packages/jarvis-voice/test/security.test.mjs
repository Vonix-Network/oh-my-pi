import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireLock } from "../src/lifecycle.mjs";
import { createRateLimiter, originAllowed, presentedToken, tokenMatches } from "../src/security.mjs";

test("tokenMatches is exact and length-safe", () => {
	assert.equal(tokenMatches(null, undefined), true);
	assert.equal(tokenMatches(""), true);
	assert.equal(tokenMatches("a".repeat(32), "a".repeat(32)), true);
	assert.equal(tokenMatches("a".repeat(32), "a".repeat(31)), false);
	assert.equal(tokenMatches("a".repeat(32), undefined), false);
	assert.equal(tokenMatches("a".repeat(32), ""), false);
});

test("presentedToken reads header, bearer and query", () => {
	assert.equal(presentedToken({ headers: { "x-jarvis-token": "t1" } }), "t1");
	assert.equal(presentedToken({ headers: { authorization: "Bearer t2" } }), "t2");
	assert.equal(presentedToken({ headers: {} }, new URL("http://x/?token=t3")), "t3");
	assert.equal(presentedToken({ headers: {} }), null);
	// Header wins over query, so a leaked URL cannot override a real header.
	assert.equal(presentedToken({ headers: { "x-jarvis-token": "h" } }, new URL("http://x/?token=q")), "h");
});

test("originAllowed accepts same-origin and absent origin, rejects foreign", () => {
	assert.equal(originAllowed({ headers: {} }), true);
	assert.equal(originAllowed({ headers: { origin: "http://127.0.0.1:7801", host: "127.0.0.1:7801" } }), true);
	assert.equal(originAllowed({ headers: { origin: "https://evil.example", host: "127.0.0.1:7801" } }), false);
	assert.equal(originAllowed({ headers: { origin: "not a url", host: "127.0.0.1:7801" } }), false);
	assert.equal(originAllowed({ headers: { origin: "http://127.0.0.1:7801" } }), false);
});

test("rate limiter allows up to the limit then denies, and resets after the window", () => {
	let now = 1000;
	const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => now });
	assert.equal(limiter.take("a").allowed, true);
	assert.equal(limiter.take("a").allowed, true);
	const third = limiter.take("a");
	assert.equal(third.allowed, true);
	assert.equal(third.remaining, 0);
	assert.equal(limiter.take("a").allowed, false);
	// A different key is unaffected.
	assert.equal(limiter.take("b").allowed, true);
	now += 1001;
	assert.equal(limiter.take("a").allowed, true);
});

test("lock is exclusive, reported on contention, and releasable", () => {
	const dir = new URL("./tmp-lock/", import.meta.url).pathname;
	// Unique per run: a lock left by a previous run is legitimately reclaimed as
	// stale, which would mask the contention assertion below.
	const path = `${dir}nested/test-${process.pid}-${Date.now()}.lock`;

	const first = acquireLock(path);
	assert.equal(first.ok, true);
	assert.equal(first.reclaimed, false);

	const second = acquireLock(path);
	assert.equal(second.ok, false);
	assert.equal(second.holder, process.pid);
	assert.match(second.error, /another instance/);

	first.release();
	const third = acquireLock(path);
	assert.equal(third.ok, true);
	assert.equal(third.reclaimed, false, "releasing cleaned the file, so nothing was stale");
	third.release();
});

test("lock reclaims a stale file left by a dead pid", () => {
	const dir = new URL("./tmp-lock/", import.meta.url).pathname;
	const path = `${dir}nested/stale-${process.pid}-${Date.now()}.lock`;
	const first = acquireLock(path);
	assert.equal(first.ok, true);
	// Simulate a crash: write a pid that cannot be running, keeping the file.
	writeFileSync(path, "999999 2000-01-01T00:00:00.000Z\n");

	const second = acquireLock(path);
	assert.equal(second.ok, true);
	assert.equal(second.reclaimed, true);
	second.release();
});
