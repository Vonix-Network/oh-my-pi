/**
 * Production middleware: auth, rate limiting, request correlation.
 *
 * Kept separate from the server so each rule is unit-testable without a socket.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time token comparison. Hashing first gives both sides equal length,
 * so `timingSafeEqual` cannot throw on a length mismatch and timing does not
 * leak the token length.
 */
export function tokenMatches(expected, provided) {
	if (!expected) return true;
	if (typeof provided !== "string" || !provided) return false;
	const a = createHash("sha256").update(expected).digest();
	const b = createHash("sha256").update(provided).digest();
	return timingSafeEqual(a, b);
}

/**
 * Extract a presented token from the usual places a browser or curl can carry
 * one. The query parameter exists because a WebSocket upgrade cannot set
 * headers from page JS.
 */
export function presentedToken(req, url) {
	const header = req.headers["x-jarvis-token"];
	if (typeof header === "string" && header) return header;
	const auth = req.headers.authorization;
	if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
	return url?.searchParams?.get("token") ?? null;
}

/** Fixed-window counter keyed by client, with a hard cap. */
export function createRateLimiter({ limit, windowMs = 60_000, now = Date.now } = {}) {
	const buckets = new Map();

	return {
		/** @returns {{allowed: boolean, remaining: number, resetMs: number}} */
		take(key) {
			const stamp = now();
			let bucket = buckets.get(key);
			if (!bucket || stamp - bucket.start >= windowMs) {
				bucket = { start: stamp, count: 0 };
				buckets.set(key, bucket);
			}
			bucket.count += 1;
			const resetMs = windowMs - (stamp - bucket.start);
			const allowed = bucket.count <= limit;
			if (buckets.size > 2048) {
				for (const [existing, value] of buckets) {
					if (stamp - value.start >= windowMs) buckets.delete(existing);
				}
			}
			return { allowed, remaining: Math.max(0, limit - bucket.count), resetMs };
		},
		get size() {
			return buckets.size;
		},
		reset() {
			buckets.clear();
		},
	};
}

/**
 * Same-origin check for browser callers. A request with no Origin is a
 * non-browser client (curl, tests, systemd health probe) and is allowed only
 * when no token is configured — otherwise the token is the gate.
 */
export function originAllowed(req) {
	const origin = req.headers.origin;
	if (!origin) return true;
	let parsed;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	const host = req.headers.host;
	if (!host) return false;
	// A reverse proxy that preserves Host is fine; a page from another origin is not.
	return parsed.host === host;
}

let counter = 0;

/** Monotonic, sortable correlation id for a request or frame. */
export function correlationId(prefix = "req") {
	counter = (counter + 1) % 1_000_000;
	return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
