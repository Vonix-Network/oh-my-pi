/**
 * omp RPC child-process manager.
 *
 * Owns exactly one `omp --mode rpc` process, speaks the newline-JSON protocol
 * documented in docs/rpc.md, reassembles protocol-v2 chunked frames, and
 * exposes a small command surface plus an event broadcast hook.
 *
 * Deliberately dependency-free: this runs under plain `node`, so the HUD works
 * without a workspace install.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/** Physical stdout frame ceiling advertised by the server in v1. */
export const MAX_V1_FRAME_BYTES = 1024 * 1024;
/** Advertised cap for a reassembled v2 logical frame. */
export const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;

/** Commands the bridge is willing to forward, so an HTTP caller cannot reach the whole RPC surface. */
export const ALLOWED_COMMANDS = new Set([
	"prompt",
	"abort",
	"steer",
	"follow_up",
	"remove_queued_message",
	"promote_queued_message",
	"new_session",
	"get_state",
	"get_available_models",
	"get_available_thinking_levels",
	"get_available_commands",
	"set_model",
	"set_thinking_level",
	"set_fast_mode",
	"set_slow_mode",
	"compact",
	"set_event_filter",
	"get_session_stats",
	"cycle_model",
	"cycle_thinking_level",
]);

/**
 * Reassembles protocol-v2 `rpc_chunk` sequences into complete logical frames.
 *
 * Validation is strict on purpose: an interleaved or interrupted sequence must
 * fail loudly rather than emit a corrupt object that the UI would render as
 * authoritative transcript.
 */
export class ChunkReassembler {
	constructor({ maxBytes = MAX_REASSEMBLED_FRAME_BYTES } = {}) {
		this.maxBytes = maxBytes;
		this.active = null;
	}

	/**
	 * @param {{chunkId: string, index: number, count: number, byteLength: number, data: string}} frame
	 * @returns {{ok: true, value: string} | {ok: false, error: string} | {ok: true, pending: true}}
	 */
	push(frame) {
		const { chunkId, index, count, byteLength, data } = frame;
		for (const [name, value] of Object.entries({ chunkId, index, count, byteLength, data })) {
			if (value === undefined || value === null) return { ok: false, error: `rpc_chunk missing ${name}` };
		}
		if (!Number.isInteger(count) || count < 1) return { ok: false, error: "rpc_chunk count must be a positive integer" };
		if (!Number.isInteger(index) || index < 0 || index >= count) return { ok: false, error: "rpc_chunk index out of range" };
		if (!Number.isFinite(byteLength) || byteLength < 0) return { ok: false, error: "rpc_chunk byteLength invalid" };
		if (byteLength > this.maxBytes) return { ok: false, error: `rpc_chunk byteLength ${byteLength} exceeds reassembly limit` };
		if (typeof data !== "string") return { ok: false, error: "rpc_chunk data must be base64 text" };

		if (index === 0) {
			if (this.active) return { ok: false, error: "rpc_chunk interrupted: new sequence began before completion" };
			this.active = { chunkId, count, byteLength, parts: new Array(count).fill(undefined), seen: 0 };
		} else if (!this.active) {
			return { ok: false, error: "rpc_chunk arrived with no sequence in progress" };
		}

		const seq = this.active;
		if (seq.chunkId !== chunkId) return { ok: false, error: "rpc_chunk chunkId changed mid-sequence" };
		if (seq.count !== count) return { ok: false, error: "rpc_chunk count changed mid-sequence" };
		if (seq.byteLength !== byteLength) return { ok: false, error: "rpc_chunk byteLength changed mid-sequence" };
		if (seq.parts[index] !== undefined) return { ok: false, error: `rpc_chunk duplicate index ${index}` };

		seq.parts[index] = data;
		seq.seen += 1;
		if (seq.seen < seq.count) return { ok: true, pending: true };

		this.active = null;
		let joined;
		try {
			joined = seq.parts.map(part => Buffer.from(part, "base64")).reduce((acc, buf) => Buffer.concat([acc, buf]), Buffer.alloc(0));
		} catch {
			return { ok: false, error: "rpc_chunk data was not valid base64" };
		}
		if (joined.byteLength !== byteLength) {
			return { ok: false, error: `rpc_chunk byteLength mismatch: got ${joined.byteLength}, expected ${byteLength}` };
		}
		return { ok: true, value: joined.toString("utf8") };
	}

	reset() {
		this.active = null;
	}
}

/**
 * Splits a byte stream into newline-delimited JSON objects without assuming
 * chunk boundaries line up with frames.
 */
export class LineSplitter {
	constructor() {
		this.buffer = "";
	}

	/** @param {string} chunk @returns {string[]} complete non-empty lines */
	push(chunk) {
		this.buffer += chunk;
		const lines = [];
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (line) lines.push(line);
			index = this.buffer.indexOf("\n");
		}
		return lines;
	}
}

/**
 * One live `omp --mode rpc` process plus the command plumbing the HUD needs.
 *
 * Events: `frame` (every parsed outbound frame), `exit`, `error`, `spawn`,
 * `stderr`, `protocol`.
 */
export class RpcBridge extends EventEmitter {
	/**
	 * @param {object} options
	 * @param {string} [options.command="omp"]
	 * @param {string[]} [options.args]
	 * @param {string} [options.cwd]
	 * @param {string} [options.profile]
	 * @param {string} [options.model]
	 * @param {string} [options.sessionDir]
	 * @param {boolean} [options.ephemeral=false] pass `--no-session`
	 * @param {number} [options.maxFrameBytes]
	 * @param {string|null} [options.doctrinePath] appended to the agent's system prompt
	 * @param {number} [options.restartBackoffMs=500]
	 * @param {number} [options.restartBackoffMaxMs=30_000]
	 * @param {object} [options.logger]
	 */
	constructor(options = {}) {
		super();
		this.options = options;
		this.log = options.logger ?? null;
		this.child = null;
		this.startedAt = 0;
		this.restarts = 0;
		this.ready = false;
		this.protocolVersion = 1;
		this.state = null;
		this.pending = new Map();
		this.nextId = 1;
		this.lastError = null;
		this.stopping = false;
		this.restartTimer = null;
		this.#installFramePipeline();
	}

	/** Build the argv for the child, keeping every option explicit. */
	buildArgs() {
		const args = ["--mode", "rpc", "--no-ui", ...(this.options.args ?? [])];
		if (this.options.ephemeral) args.push("--no-session");
		if (this.options.sessionDir) args.push("--session-dir", this.options.sessionDir);
		if (this.options.profile) args.push("--profile", this.options.profile);
		if (this.options.model) args.push("--model", this.options.model);
		// Doctrine rides the documented append route, so the default tool policy,
		// project context and rules discovery stay intact underneath it.
		if (this.options.doctrinePath) args.push("--append-system-prompt", this.options.doctrinePath);
		return args;
	}

	#installFramePipeline() {
		this.splitter = new LineSplitter();
		this.chunks = new ChunkReassembler({ maxBytes: this.options.maxFrameBytes ?? MAX_REASSEMBLED_FRAME_BYTES });
	}

	/** Exponential backoff with a ceiling, so a crash loop cannot spin the CPU. */
	#scheduleRestart() {
		if (this.stopping || this.options.respawn === false) return;
		const base = this.options.restartBackoffMs ?? 500;
		const max = this.options.restartBackoffMaxMs ?? 30_000;
		this.restarts += 1;
		const delay = Math.min(max, base * 2 ** Math.min(this.restarts - 1, 10));
		this.log?.warn("restarting omp child", { attempt: this.restarts, delayMs: delay });
		clearTimeout(this.restartTimer);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			if (!this.stopping && !this.child) this.start();
		}, delay);
		this.restartTimer.unref?.();
	}

	start() {
		if (this.child) return this;
		this.#installFramePipeline();
		this.ready = false;
		this.stopping = false;
		const args = this.buildArgs();
		const child = spawn(this.options.command ?? "omp", args, {
			cwd: this.options.cwd ?? process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_NO_TITLE: "1" },
		});
		this.child = child;
		this.startedAt = Date.now();
		this.emit("spawn", { pid: child.pid, args });

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", chunk => {
			for (const line of this.splitter.push(chunk)) this.#handleLine(line);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", text => {
			this.lastError = text.trim().slice(0, 2000);
			this.emit("stderr", text);
		});
		child.on("error", error => {
			this.lastError = error.message;
			this.emit("error", error);
		});
		child.on("exit", (code, signal) => {
			this.child = null;
			this.ready = false;
			this.state = null;
			for (const [, entry] of this.pending) {
				entry.reject(Object.assign(new Error(`omp RPC exited (code ${code ?? "null"}, signal ${signal ?? "none"})`), { code: "child_exit" }));
			}
			this.pending.clear();
			this.chunks.reset();
			this.emit("exit", { code, signal });
			this.#scheduleRestart();
		});
		return this;
	}

	#handleLine(line) {
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			this.emit("frame", { type: "bridge_parse_error", raw: line.slice(0, 400) });
			return;
		}
		if (frame && frame.type === "rpc_chunk") {
			const result = this.chunks.push(frame);
			if (result.ok && result.pending) return;
			if (!result.ok) {
				this.chunks.reset();
				this.emit("frame", { type: "bridge_transport_error", error: result.error });
				return;
			}
			try {
				frame = JSON.parse(result.value);
			} catch (error) {
				this.emit("frame", { type: "bridge_transport_error", error: `reassembled frame was not JSON: ${error.message}` });
				return;
			}
		}
		this.ingest(frame);
	}

	/** Feed one complete logical frame: resolves pending responses, then broadcasts. */
	ingest(frame) {
		if (!frame || typeof frame !== "object" || typeof frame.type !== "string") {
			this.emit("frame", { type: "bridge_transport_error", error: "frame had no type" });
			return;
		}
		if (frame.type === "ready") {
			this.ready = true;
			this.protocolVersion = frame.protocolVersion ?? 1;
			this.emit("protocol", frame);
			// Ask for the lossless transport when the server offers it, so a large
			// tool result arrives whole instead of failing an overflow check.
			const supported = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : [1];
			if (supported.includes(2)) {
				this.send({ type: "negotiate_protocol", protocolVersion: 2 }, { id: "bridge-negotiate" });
			}
		}
		if (frame.type === "response") {
			const entry = frame.id ? this.pending.get(frame.id) : undefined;
			if (entry) {
				this.pending.delete(frame.id);
				if (frame.success) entry.resolve(frame);
				else entry.reject(Object.assign(new Error(frame.error ?? "command failed"), { code: frame.code, response: frame }));
			}
			if (frame.command === "negotiate_protocol" && frame.success) this.protocolVersion = 2;
			if (frame.command === "get_state" && frame.success) this.state = frame.data;
		}
		this.emit("frame", frame);
	}

	/**
	 * Send a raw command frame.
	 * @param {Record<string, unknown>} command
	 * @param {{id?: string, timeoutMs?: number}} [options]
	 */
	send(command, options = {}) {
		if (!this.child?.stdin?.writable) throw new Error("omp RPC process is not running");
		const id = options.id ?? command.id ?? `c${this.nextId++}`;
		const frame = { ...command, id };
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
		return id;
	}

	/**
	 * Send an allowed command and wait for its response.
	 * @param {string} type
	 * @param {Record<string, unknown>} [payload]
	 * @param {{timeoutMs?: number}} [options]
	 */
	call(type, payload = {}, options = {}) {
		if (!ALLOWED_COMMANDS.has(type)) return Promise.reject(new Error(`command not allowed: ${type}`));
		return new Promise((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? 60_000;
			let id;
			try {
				id = this.send({ ...payload, type });
			} catch (error) {
				reject(error);
				return;
			}
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(Object.assign(new Error(`timed out waiting for ${type}`), { code: "timeout" }));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				resolve: value => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: error => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
	}

	/** Snapshot of bridge health for the HUD status rail. */
	describe() {
		return {
			pid: this.child?.pid ?? null,
			ready: this.ready,
			protocolVersion: this.protocolVersion,
			uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
			restarts: this.restarts,
			pending: this.pending.size,
			lastError: this.lastError,
			cwd: this.options.cwd ?? process.cwd(),
			sessionDir: this.options.sessionDir ?? null,
			ephemeral: Boolean(this.options.ephemeral),
		};
	}

	async stop() {
		this.stopping = true;
		const child = this.child;
		if (!child) return;
		await new Promise(resolve => {
			const done = () => resolve();
			child.once("exit", done);
			try {
				child.stdin.end();
			} catch {
				/* stdin already closed */
			}
			setTimeout(() => {
				if (this.child) child.kill("SIGTERM");
			}, 1500).unref?.();
			setTimeout(() => {
				if (this.child) child.kill("SIGKILL");
				resolve();
			}, 4000).unref?.();
		});
	}
}
