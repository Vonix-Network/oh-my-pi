import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, DEFAULTS, resolveConfig, stripJsonComments, validate } from "../src/config.mjs";

test("defaults validate and force an absolute cwd", () => {
	const config = validate({ cwd: "." });
	assert.ok(config.cwd.startsWith("/"));
	assert.equal(config.host, "127.0.0.1");
	assert.equal(config.ephemeral, true);
	assert.equal(config.rateLimitPerMinute, DEFAULTS.rateLimitPerMinute);
});

test("unknown keys are rejected so a typo cannot look applied", () => {
	assert.throws(() => validate({ prot: 1234 }), ConfigError);
	assert.throws(() => validate({ prot: 1234 }), /unknown config key: prot/);
	// Opting out is explicit.
	assert.doesNotThrow(() => validate({ prot: 1234 }, { strictUnknown: false }));
});

test("a quoted numeric string is coerced, a non-numeric one is rejected", () => {
	assert.equal(validate({ port: "7850" }).port, 7850);
	assert.throws(() => validate({ port: "eighty" }), /port must be a number/);
	assert.throws(() => validate({ port: 70000 }), /port must be an integer/);
});

test("boolean strings are accepted in the usual spellings", () => {
	for (const value of ["true", "1", "yes", "TRUE"]) assert.equal(validate({ doctrine: value }).doctrine, true);
	for (const value of ["false", "0", "no"]) assert.equal(validate({ ephemeral: value }).ephemeral, false, String(value));
	assert.throws(() => validate({ ephemeral: "maybe" }), /must be a boolean/);
});

test("a non-loopback bind without a token is refused", () => {
	assert.throws(() => validate({ host: "0.0.0.0" }), /without a token/);
	assert.throws(() => validate({ host: "0.0.0.0", token: "0123456789abcdef" }), /allowRemote/);
	assert.doesNotThrow(() => validate({ host: "0.0.0.0", token: "0123456789abcdef", allowRemote: true }));
});

test("loopback aliases do not require a token", () => {
	for (const host of ["127.0.0.1", "localhost", "::1"]) {
		assert.doesNotThrow(() => validate({ host }), host);
	}
});

test("a short token is refused rather than silently weak", () => {
	assert.throws(() => validate({ token: "short" }), /at least 16/);
});

test("log level is constrained to the real set", () => {
	assert.throws(() => validate({ logLevel: "verbose" }), /logLevel must be one of/);
	assert.doesNotThrow(() => validate({ logLevel: "debug" }));
});

test("env overrides file config and flags override env", () => {
	const env = { JARVIS_PORT: "7900", JARVIS_HOST: "127.0.0.1" };
	const fromEnv = resolveConfig({}, { env, configPath: null });
	assert.equal(fromEnv.port, 7900);
	const fromFlags = resolveConfig({ port: "7999" }, { env, configPath: null });
	assert.equal(fromFlags.port, 7999);
});

test("comments are stripped without touching string contents", () => {
	const text = `{
		// a line comment with "quotes"
		"host": "http://example.com//path",
		/* block */
		"port": 7801
	}`;
	const parsed = JSON.parse(stripJsonComments(text));
	assert.equal(parsed.host, "http://example.com//path");
	assert.equal(parsed.port, 7801);
});
