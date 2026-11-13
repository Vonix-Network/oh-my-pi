/**
 * Structured runtime logging with rotation.
 *
 * A system agent runs unattended, so its own diagnostics are the only record of
 * what it did. Logs are JSONL, size-rotated, and flushed synchronously on
 * shutdown so a crash-loop still leaves the lines that explain it.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * @param {object} [options]
 * @param {string} [options.dir] directory for log files; omit for stdout only
 * @param {string} [options.level="info"]
 * @param {number} [options.maxBytes=4_000_000] rotate above this size
 * @param {number} [options.keep=5] rotated files to retain
 * @param {string} [options.file="jarvis.log"]
 */
export function createLogger(options = {}) {
	const dir = options.dir ?? null;
	const level = LEVELS[options.level ?? "info"] ?? LEVELS.info;
	const maxBytes = options.maxBytes ?? 4_000_000;
	const keep = options.keep ?? 5;
	const file = join(dir ?? ".", options.file ?? "jarvis.log");
	const counters = { debug: 0, info: 0, warn: 0, error: 0 };
	let written = 0;
	let stdoutUsable = true;

	if (dir) {
		mkdirSync(dir, { recursive: true });
		written = existsSync(file) ? statSync(file).size : 0;
	}

	// A closed stdout pipe (the console was piped into `head`, or a supervisor
	// went away) makes `write` raise EPIPE asynchronously. That must disable the
	// console sink, never become the process's uncaught exception — otherwise a
	// logging call is what kills the daemon.
	process.stdout.on("error", error => {
		if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") stdoutUsable = false;
		else process.stderr.write(`jarvis: stdout error: ${error.message}\n`);
	});
	process.stderr.on("error", () => {});

	function writeStdout(line) {
		if (!stdoutUsable) return;
		try {
			process.stdout.write(line);
		} catch (error) {
			if (error.code === "EPIPE") stdoutUsable = false;
			else throw error;
		}
	}

	function rotate() {
		if (!dir) return;
		try {
			if (existsSync(`${file}.${keep}`)) unlinkSync(`${file}.${keep}`);
			for (let i = keep - 1; i >= 1; i--) {
				if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
			}
			if (existsSync(file)) renameSync(file, `${file}.1`);
			written = 0;
		} catch (error) {
			process.stderr.write(`jarvis: log rotation failed: ${error.message}\n`);
		}
	}

	function emit(severity, message, context) {
		counters[severity] += 1;
		if (LEVELS[severity] < level) return;
		const record = { ts: new Date().toISOString(), level: severity, msg: message, ...context };
		const line = `${JSON.stringify(record)}\n`;
		writeStdout(line);
		if (!dir) return;
		try {
			if (written + line.length > maxBytes) rotate();
			appendFileSync(file, line);
			written += line.length;
		} catch (error) {
			process.stderr.write(`jarvis: log write failed: ${error.message}\n`);
		}
	}

	return {
		debug: (message, context) => emit("debug", message, context),
		info: (message, context) => emit("info", message, context),
		warn: (message, context) => emit("warn", message, context),
		error: (message, context) => emit("error", message, context),
		child(scope) {
			return {
				debug: (message, context) => emit("debug", `${scope}: ${message}`, context),
				info: (message, context) => emit("info", `${scope}: ${message}`, context),
				warn: (message, context) => emit("warn", `${scope}: ${message}`, context),
				error: (message, context) => emit("error", `${scope}: ${message}`, context),
			};
		},
		get counters() {
			return { ...counters };
		},
		get path() {
			return dir ? file : null;
		},
	};
}
