/**
 * Configuration resolution for the Jarvis system agent.
 *
 * Precedence, highest first: CLI flags → environment → config file → defaults.
 * Validation is strict and every rejection names the offending key, because an
 * unattended daemon that silently ignores a typo runs with the wrong blast
 * radius.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_CONFIG_PATHS = [
	"/etc/omp-jarvis/config.json",
	join(homedir(), ".config", "omp-jarvis", "config.json"),
];

/** Shape defaults. Every key here is validated below. */
export const DEFAULTS = {
	host: "127.0.0.1",
	port: 7801,
	cwd: process.cwd(),
	profile: null,
	model: null,
	sessionDir: null,
	token: null,
	ephemeral: true,
	doctrine: true,
	doctrinePath: null,
	logDir: null,
	logLevel: "info",
	maxSessions: 1,
	requestTimeoutMs: 120_000,
	promptTimeoutMs: 30_000,
	maxBodyBytes: 2 * 1024 * 1024,
	rateLimitPerMinute: 120,
	allowRemote: false,
	restartBackoffMs: 500,
	restartBackoffMaxMs: 30_000,
	healthcheckGraceMs: 20_000,
};

const STRING_KEYS = ["host", "cwd", "profile", "model", "sessionDir", "token", "logLevel", "doctrinePath", "logDir"];
const NUMBER_KEYS = [
	"port",
	"maxSessions",
	"requestTimeoutMs",
	"promptTimeoutMs",
	"maxBodyBytes",
	"rateLimitPerMinute",
	"restartBackoffMs",
	"restartBackoffMaxMs",
	"healthcheckGraceMs",
];
const BOOLEAN_KEYS = ["ephemeral", "doctrine", "allowRemote"];

const ENV_MAP = {
	JARVIS_HOST: "host",
	JARVIS_PORT: "port",
	JARVIS_CWD: "cwd",
	JARVIS_PROFILE: "profile",
	JARVIS_MODEL: "model",
	JARVIS_SESSION_DIR: "sessionDir",
	JARVIS_TOKEN: "token",
	JARVIS_LOG_DIR: "logDir",
	JARVIS_LOG_LEVEL: "logLevel",
	JARVIS_ALLOW_REMOTE: "allowRemote",
};

export class ConfigError extends Error {
	constructor(message) {
		super(message);
		this.name = "ConfigError";
	}
}

/** Strip `//` and block comments without touching string contents. */
export function stripJsonComments(text) {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inLine) {
			if (ch === "\n") {
				inLine = false;
				out += ch;
			}
			continue;
		}
		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlock = true;
			i++;
			continue;
		}
		out += ch;
	}
	return out;
}

export function readConfigFile(path) {
	if (!existsSync(path)) return {};
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigError(`cannot read config ${path}: ${error.message}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(stripJsonComments(text));
	} catch (error) {
		throw new ConfigError(`invalid JSON in ${path}: ${error.message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(`config ${path} must be a JSON object`);
	}
	return parsed;
}

export function envOverrides(env = process.env) {
	const out = {};
	for (const [key, field] of Object.entries(ENV_MAP)) {
		if (env[key] === undefined || env[key] === "") continue;
		out[field] = env[key];
	}
	return out;
}

/**
 * Coerce and validate. Unknown keys are rejected so a misspelled option cannot
 * look like it took effect.
 */
export function validate(raw, { strictUnknown = true } = {}) {
	const known = new Set([...STRING_KEYS, ...NUMBER_KEYS, ...BOOLEAN_KEYS]);
	for (const key of Object.keys(raw)) {
		if (!known.has(key)) {
			if (strictUnknown) throw new ConfigError(`unknown config key: ${key}`);
			continue;
		}
	}

	const out = { ...DEFAULTS, ...raw };

	for (const key of STRING_KEYS) {
		if (out[key] !== null && typeof out[key] !== "string") throw new ConfigError(`${key} must be a string`);
	}
	for (const key of BOOLEAN_KEYS) {
		if (typeof out[key] === "string") {
			const lowered = out[key].toLowerCase();
			if (!["true", "false", "1", "0", "yes", "no"].includes(lowered)) throw new ConfigError(`${key} must be a boolean`);
			out[key] = ["true", "1", "yes"].includes(lowered);
		}
		if (typeof out[key] !== "boolean") throw new ConfigError(`${key} must be a boolean`);
	}
	for (const key of NUMBER_KEYS) {
		if (typeof out[key] === "string") {
			const parsed = Number(out[key]);
			if (!Number.isFinite(parsed)) throw new ConfigError(`${key} must be a number`);
			out[key] = parsed;
		}
		if (!Number.isFinite(out[key])) throw new ConfigError(`${key} must be a number`);
	}

	if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new ConfigError("port must be an integer 0..65535");
	if (out.maxSessions < 1) throw new ConfigError("maxSessions must be at least 1");
	if (out.maxBodyBytes < 1024) throw new ConfigError("maxBodyBytes must be at least 1024");
	if (out.rateLimitPerMinute < 1) throw new ConfigError("rateLimitPerMinute must be at least 1");
	if (!["debug", "info", "warn", "error", "silent"].includes(out.logLevel)) {
		throw new ConfigError("logLevel must be one of debug, info, warn, error, silent");
	}
	if (!isAbsolute(out.cwd)) out.cwd = resolve(out.cwd);
	if (out.sessionDir && !isAbsolute(out.sessionDir)) out.sessionDir = resolve(out.sessionDir);
	if (out.logDir && !isAbsolute(out.logDir)) out.logDir = resolve(out.logDir);
	if (out.doctrinePath && !isAbsolute(out.doctrinePath)) out.doctrinePath = resolve(out.doctrinePath);

	const loopback = out.host === "127.0.0.1" || out.host === "localhost" || out.host === "::1";
	if (!loopback && !out.token) {
		throw new ConfigError(`refusing to bind ${out.host} without a token: this console drives a live agent that can edit files`);
	}
	if (!loopback && !out.allowRemote) {
		throw new ConfigError(`refusing to bind ${out.host}: set allowRemote true and provide a token`);
	}
	if (out.token !== null && out.token.length < 16) {
		throw new ConfigError("token must be at least 16 characters");
	}

	return out;
}

/**
 * Resolve final config from all layers.
 * @param {Record<string, unknown>} cliFlags already-parsed flags (undefined = absent)
 * @param {{env?: NodeJS.ProcessEnv, configPath?: string|null, strictUnknown?: boolean}} [options]
 */
export function resolveConfig(cliFlags = {}, options = {}) {
	const env = options.env ?? process.env;
	let fileConfig = {};
	if (options.configPath !== null) {
		if (options.configPath) {
			fileConfig = readConfigFile(options.configPath);
		} else {
			for (const candidate of DEFAULT_CONFIG_PATHS) {
				if (existsSync(candidate)) {
					fileConfig = readConfigFile(candidate);
					break;
				}
			}
		}
	}

	const merged = { ...fileConfig };
	for (const [key, value] of Object.entries(envOverrides(env))) {
		if (key === "port" || key === "allowRemote") merged[key] = value;
		else merged[key] = value;
	}
	for (const [key, value] of Object.entries(cliFlags)) {
		if (value !== undefined) merged[key] = value;
	}
	return validate(merged, { strictUnknown: options.strictUnknown ?? true });
}

export function describeConfig(config) {
	return {
		host: config.host,
		port: config.port,
		cwd: config.cwd,
		profile: config.profile,
		model: config.model,
		sessionDir: config.sessionDir,
		ephemeral: config.ephemeral,
		doctrine: config.doctrine,
		logDir: config.logDir,
		logLevel: config.logLevel,
		tokenSet: Boolean(config.token),
		allowRemote: config.allowRemote,
	};
}
