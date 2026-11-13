#!/usr/bin/env node
/**
 * `omp-jarvis` — run the voice-first system agent console.
 *
 * Production entry point: resolves layered config, takes a single-instance
 * lock, guards the agent child against orphaning, waits for real readiness, and
 * exits non-zero on a failed start so systemd can restart it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, describeConfig, resolveConfig } from "./config.mjs";
import { acquireLock, guardChild } from "./lifecycle.mjs";
import { createLogger } from "./logger.mjs";
import { createJarvisServer } from "./server.mjs";

const FLAG_MAP = {
	"--port": ["port", String],
	"-p": ["port", String],
	"--host": ["host", String],
	"--cwd": ["cwd", String],
	"-C": ["cwd", String],
	"--profile": ["profile", String],
	"--model": ["model", String],
	"-m": ["model", String],
	"--session-dir": ["sessionDir", String],
	"--token": ["token", String],
	"--log-dir": ["logDir", String],
	"--log-level": ["logLevel", String],
	"--doctrine": ["doctrinePath", String],
	"--rate-limit": ["rateLimitPerMinute", String],
	"--config": ["__config", String],
};

function parseArgs(argv) {
	const flags = {};
	const result = { flags, help: false, version: false, printConfig: false, persist: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			result.help = true;
			continue;
		}
		if (arg === "--version" || arg === "-v") {
			result.version = true;
			continue;
		}
		if (arg === "--print-config") {
			result.printConfig = true;
			continue;
		}
		if (arg === "--persist") {
			result.persist = true;
			continue;
		}
		if (arg === "--no-doctrine") {
			flags.doctrine = false;
			continue;
		}
		const mapped = FLAG_MAP[arg];
		if (mapped) {
			const value = argv[++i];
			if (value === undefined) throw new ConfigError(`${arg} requires a value`);
			flags[mapped[0]] = value;
			continue;
		}
		if (arg.startsWith("-")) throw new ConfigError(`unknown option: ${arg}`);
		flags.cwd = arg;
	}
	if (flags.sessionDir) result.persist = true;
	return result;
}

const HELP = `omp-jarvis — voice-first system agent console for omp

Usage
  omp-jarvis [options] [cwd]

Options
  -p, --port <n>         HTTP port (default 7801, env JARVIS_PORT)
      --host <addr>      bind address (default 127.0.0.1)
  -C, --cwd <dir>        workspace the agent operates on
      --profile <name>   omp profile to run under
  -m, --model <id>       model as <provider>/<model>
      --session-dir <d>  persist sessions in d (implies --persist)
      --persist          keep session files instead of --no-session
      --token <value>    require this token (>=16 chars) for API/WS access
      --log-dir <dir>    write JSONL logs here (default: stdout only)
      --log-level <lvl>  debug | info | warn | error | silent
      --doctrine <path>  override the system-agent doctrine file
      --no-doctrine      run with the stock omp prompt only
      --rate-limit <n>   API requests per minute per client (default 120)
      --config <path>    explicit config file (default: /etc/omp-jarvis/config.json,
                         then ~/.config/omp-jarvis/config.json)
      --print-config     print resolved config and exit
  -v, --version          print version

Environment (overrides file config, overridden by flags)
  JARVIS_HOST JARVIS_PORT JARVIS_CWD JARVIS_PROFILE JARVIS_MODEL
  JARVIS_SESSION_DIR JARVIS_TOKEN JARVIS_LOG_DIR JARVIS_LOG_LEVEL
  JARVIS_ALLOW_REMOTE

Security
  Binds loopback by default. A non-loopback bind requires both a token and
  allowRemote=true, because this console drives an agent that edits files.

Voice
  Listening and speaking happen in the browser (Web Speech API). The omp
  server-side live-voice path needs a realtime provider credential and is not
  used; the HUD reports its absence instead of pretending to listen.`;

async function main() {
	let parsed;
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`omp-jarvis: ${error.message}\n`);
		process.exit(2);
	}

	if (parsed.help) {
		process.stdout.write(`${HELP}\n`);
		return;
	}

	if (parsed.version) {
		const pkg = await import("../package.json", { with: { type: "json" } }).then(m => m.default).catch(() => ({ version: "unknown" }));
		process.stdout.write(`${pkg.version}\n`);
		return;
	}

	const configPath = parsed.flags.__config ?? undefined;
	delete parsed.flags.__config;

	let config;
	try {
		config = resolveConfig(parsed.flags, { configPath });
	} catch (error) {
		process.stderr.write(`omp-jarvis: ${error.message}\n`);
		process.exit(error instanceof ConfigError ? 2 : 1);
	}

	if (parsed.persist) config.ephemeral = false;

	if (parsed.printConfig) {
		process.stdout.write(`${JSON.stringify(describeConfig(config), null, 2)}\n`);
		return;
	}

	const log = createLogger({ dir: config.logDir, level: config.logLevel });
	const listen = log.child("cli");

	if (!existsSync(config.cwd)) {
		listen.error("workspace does not exist", { cwd: config.cwd });
		process.exit(2);
	}

	const lockDir = config.logDir ?? join(homedir(), ".local", "state", "omp-jarvis");
	const lock = acquireLock(join(lockDir, `jarvis-${config.port}.lock`));
	if (!lock.ok) {
		listen.error("already running", { holder: lock.holder, port: config.port, error: lock.error });
		process.exit(3);
	}
	if (lock.reclaimed) listen.warn("reclaimed a stale lock");

	const jarvis = createJarvisServer({ ...config, logger: log });
	let guard = null;

	try {
		const { port, host } = await jarvis.listen({ port: config.port, host: config.host });
		log.info("listening", { host, port, ...describeConfig(config) });
		process.stdout.write(`omp-jarvis listening on http://${host === "127.0.0.1" ? "127.0.0.1" : host}:${port}/\n`);
		process.stdout.write(`  workspace ${config.cwd}\n`);
		process.stdout.write(`  session   ${config.ephemeral ? "ephemeral" : (config.sessionDir ?? "persisted")}\n`);
		process.stdout.write(`  doctrine  ${config.doctrine === false ? "disabled" : (config.doctrinePath ?? "bundled system-agent")}\n`);
		if (config.token) process.stdout.write("  auth      token required (append ?token=<value>)\n");
		if (config.logDir) process.stdout.write(`  logs      ${config.logDir}\n`);

		guard = guardChild(jarvis.bridge.child, {
			onOrphan: () => log.warn("parent disappeared; shutting down"),
		});
		jarvis.bridge.on("spawn", info => {
			guard?.disarm();
			guard = guardChild(jarvis.bridge.child, { onOrphan: () => log.warn("parent disappeared; shutting down") });
			if (info?.pid) log.debug("guarded child", { pid: info.pid });
		});

		// Readiness: a listening socket is not a working agent. Wait for the RPC
		// ready frame so a supervisor sees the true state.
		const deadline = Date.now() + config.healthcheckGraceMs;
		while (!jarvis.bridge.ready && Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 120));
		}
		if (jarvis.bridge.ready) {
			log.info("agent ready", { pid: jarvis.bridge.child?.pid, protocolVersion: jarvis.bridge.protocolVersion });
			await jarvis.bridge.call("get_state", {}, { timeoutMs: config.requestTimeoutMs }).then(
				response => log.info("session ready", {
					model: response.data?.model?.id,
					contextWindow: response.data?.model?.contextWindow,
					thinkingLevel: response.data?.thinkingLevel,
				}),
				error => log.warn("get_state failed during startup", { error: error.message }),
			);
		} else {
			log.error("agent did not become ready within grace period", { graceMs: config.healthcheckGraceMs, lastError: jarvis.bridge.lastError });
			await jarvis.shutdown("startup-timeout");
			lock.release();
			process.exit(4);
		}
	} catch (error) {
		log.error("startup failed", { error: error.message, code: error.code });
		await jarvis.shutdown("startup-error").catch(() => {});
		lock.release();
		process.exit(1);
	}

	let closing = false;
	const close = async (reason, code = 0) => {
		if (closing) return;
		closing = true;
		log.info("shutting down", { reason });
		guard?.disarm();
		await jarvis.shutdown(reason).catch(error => log.error("shutdown error", { error: error.message }));
		lock.release();
		process.exit(code);
	};

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(signal, () => void close(signal));
	}
	process.on("uncaughtException", error => {
		// EPIPE from a closed pipe is a dead sink, not a broken agent; the logger
		// already disables that sink, so do not tear the console down for it.
		if (error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED") {
			log.warn("ignoring closed stream", { code: error.code });
			return;
		}
		log.error("uncaught exception", { error: error.message, stack: error.stack?.split("\n").slice(0, 5).join(" | ") });
		void close("uncaughtException", 1);
	});
	process.on("unhandledRejection", reason => {
		log.error("unhandled rejection", { error: String(reason) });
	});
}

main().catch(error => {
	process.stderr.write(`omp-jarvis: fatal: ${error.stack ?? error.message}\n`);
	process.exit(1);
});
