/**
 * HTTP + WebSocket server for the omp Jarvis system agent.
 *
 * Serves the HUD from `web/`, broadcasts the projected omp RPC stream, and
 * accepts a narrow command surface back. Binds to loopback by default: this
 * drives an agent that reads and edits files, so it is not a public service.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.mjs";
import { RpcBridge } from "./rpc-bridge.mjs";
import { correlationId, createRateLimiter, originAllowed, presentedToken, tokenMatches } from "./security.mjs";
import { attachWebSocket } from "./ws.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB_ROOT = resolve(HERE, "../web");
const DOCTRINE_PATH = resolve(HERE, "../agent/SYSTEM-AGENT.md");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webmanifest": "application/manifest+json",
	".ico": "image/x-icon",
};

/** Commands the browser may invoke. */
const UI_COMMANDS = {
	prompt: { rpc: "prompt", fields: ["message", "streamingBehavior"], validate: body => requireMessage(body) },
	steer: { rpc: "steer", fields: ["message"], validate: body => requireMessage(body) },
	follow_up: { rpc: "follow_up", fields: ["message"], validate: body => requireMessage(body) },
	abort: { rpc: "abort", fields: [] },
	new_session: { rpc: "new_session", fields: [] },
	set_model: { rpc: "set_model", fields: ["provider", "modelId"] },
	set_thinking_level: { rpc: "set_thinking_level", fields: ["level"] },
	get_state: { rpc: "get_state", fields: [] },
	compact: { rpc: "compact", fields: ["customInstructions"] },
	cycle_model: { rpc: "cycle_model", fields: [] },
	cycle_thinking_level: { rpc: "cycle_thinking_level", fields: [] },
	get_available_models: { rpc: "get_available_models", fields: [] },
	get_available_commands: { rpc: "get_available_commands", fields: [] },
};

function requireMessage(body) {
	if (typeof body?.payload?.message !== "string" || !body.payload.message.trim()) {
		throw Object.assign(new Error("message is required"), { status: 400 });
	}
	if (body.payload.message.length > 200_000) {
		throw Object.assign(new Error("message too large"), { status: 413 });
	}
}

function pick(source, fields) {
	const out = {};
	if (!source || typeof source !== "object") return out;
	for (const field of fields) if (source[field] !== undefined) out[field] = source[field];
	return out;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(block => block && block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("");
}

function thinkingOf(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter(block => block && (block.type === "thinking" || block.type === "reasoning") && typeof block.thinking === "string")
		.map(block => block.thinking)
		.join("");
}

function toolCallsOf(content) {
	if (!Array.isArray(content)) return [];
	return content
		.filter(block => block && (block.type === "toolCall" || block.type === "tool_call"))
		.map(block => ({ id: block.id ?? null, name: block.name ?? "tool", args: block.arguments ?? block.args ?? {} }));
}

/**
 * Reduce an omp RPC frame to the display shape the HUD binds to.
 * Returning `null` drops the frame entirely.
 */
export function project(frame) {
	if (!frame || typeof frame.type !== "string") return null;
	switch (frame.type) {
		case "ready":
			return { type: "ready", protocolVersion: frame.protocolVersion ?? 1, supported: frame.supportedProtocolVersions ?? [1] };
		case "response":
			return {
				type: "response",
				command: frame.command,
				success: Boolean(frame.success),
				error: frame.success ? undefined : frame.error,
				code: frame.code,
				data: frame.success ? frame.data : undefined,
			};
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end", yielded: frame.yielded ?? frame.isTerminal ?? true, awaitingAsyncWork: Boolean(frame.awaitingAsyncWork) };
		case "turn_start":
			return { type: "turn_start" };
		case "turn_end":
			return { type: "turn_end" };
		case "prompt_result":
			return { type: "prompt_result", agentInvoked: frame.agentInvoked, status: frame.status, sessionSettled: frame.sessionSettled, error: frame.error };
		case "session_settled":
			return { type: "session_settled" };
		case "message_start":
			return { type: "message_start", messageId: frame.messageId, role: frame.message?.role };
		case "message_end": {
			const message = frame.message ?? {};
			const content = message.content ?? [];
			return {
				type: "message_end",
				messageId: frame.messageId,
				role: message.role,
				text: textOf(content),
				thinking: thinkingOf(content),
				toolCalls: toolCallsOf(content),
				usage: message.usage
					? {
							input: message.usage.input,
							output: message.usage.output,
							cost: message.usage.cost?.total ?? 0,
							totalTokens: message.usage.totalTokens,
						}
					: undefined,
				stopReason: message.stopReason,
				provider: message.provider,
				model: message.model,
				duration: message.duration,
				ttft: message.ttft,
			};
		}
		case "message_update": {
			const event = frame.assistantMessageEvent ?? {};
			const delta = event.delta;
			if (event.type === "text_delta") return { type: "delta", kind: "text", messageId: frame.messageId, text: delta ?? "" };
			if (event.type === "thinking_delta") return { type: "delta", kind: "thinking", messageId: frame.messageId, text: delta ?? "" };
			if (event.type === "toolcall_start") return { type: "toolcall_start", messageId: frame.messageId, tool: event.block?.name ?? null, id: event.block?.id ?? null };
			if (event.type === "toolcall_delta") return { type: "toolcall_delta", messageId: frame.messageId, text: delta ?? "" };
			if (event.type === "toolcall_end") return { type: "toolcall_end", messageId: frame.messageId, tool: event.toolCall?.name ?? null, args: event.toolCall?.arguments ?? null };
			return null;
		}
		case "tool_execution_start":
			return { type: "tool_start", id: frame.toolCallId, tool: frame.toolName, args: frame.args ?? null };
		case "tool_execution_end":
			return { type: "tool_end", id: frame.toolCallId, tool: frame.toolName, isError: Boolean(frame.isError), result: summarizeResult(frame.result) };
		case "tool_execution_update":
			return { type: "tool_update", id: frame.toolCallId, tool: frame.toolName, text: summarizeResult(frame.partialResult ?? frame.result) };
		case "queue_update":
			return { type: "queue", steering: frame.steering ?? [], followUp: frame.followUp ?? [] };
		case "model_changed":
			return { type: "model_changed", model: frame.model ? { provider: frame.model.provider, id: frame.model.id, name: frame.model.name } : null };
		case "thinking_level_changed":
			return { type: "thinking_level_changed", level: frame.level ?? null };
		case "auto_compaction_start":
		case "manual_compaction_start":
			return { type: "notice", kind: "compaction", text: "Compacting context…" };
		case "auto_compaction_end":
		case "manual_compaction_end":
			return { type: "notice", kind: "compaction", text: frame.errorMessage ? `Compaction failed: ${frame.errorMessage}` : "Context compacted" };
		case "auto_retry_start":
			return { type: "notice", kind: "retry", text: `Retrying (attempt ${frame.attempt ?? "?"})…` };
		case "retry_fallback_applied":
			return { type: "notice", kind: "retry", text: `Falling back to ${frame.to ?? "another model"}` };
		case "notice":
			return { type: "notice", kind: frame.kind ?? "info", text: frame.message ?? frame.text ?? "" };
		case "extension_error":
			return { type: "notice", kind: "error", text: `Extension error: ${frame.error ?? "unknown"}` };
		case "bridge_parse_error":
		case "bridge_transport_error":
			return { type: "notice", kind: "error", text: frame.raw ?? frame.error ?? "transport error" };
		case "goal_updated":
			return { type: "goal", goal: frame.goal ?? null };
		default:
			return null;
	}
}

/** Tool results can hold whole files; the HUD needs a short readable preview. */
export function summarizeResult(result, limit = 1200) {
	if (result === undefined || result === null) return "";
	if (typeof result === "string") return result.length > limit ? `${result.slice(0, limit)}…` : result;

	// Tool results arrive wrapped as `{ content: [{ type: "text", text }], details }`.
	// Rendering the envelope as JSON buries the actual output in metadata.
	const unwrap = value => {
		if (!value || typeof value !== "object") return null;
		const blocks = value.content;
		if (!Array.isArray(blocks)) return null;
		const text = blocks
			.filter(block => block && typeof block.text === "string")
			.map(block => block.text)
			.join("\n")
			.trim();
		return text || null;
	};

	const inner = unwrap(result);
	if (inner) return inner.length > limit ? `${inner.slice(0, limit)}…` : inner;

	try {
		const text = JSON.stringify(result);
		return text.length > limit ? `${text.slice(0, limit)}…` : text;
	} catch {
		return String(result).slice(0, limit);
	}
}

/**
 * @param {import("./config.mjs").DEFAULTS} options validated configuration
 */
export function createJarvisServer(options) {
	const log = options.logger ?? createLogger({ dir: options.logDir, level: options.logLevel ?? "info" });
	const logScope = log.child("server");
	const limiter = createRateLimiter({ limit: options.rateLimitPerMinute ?? 120 });
	const metrics = { requests: 0, rejected: 0, commands: 0, prompts: 0, errors: 0, wsConnections: 0, wsRejected: 0, startedAt: Date.now() };

	let doctrine = null;
	if (options.doctrine !== false) {
		const path = options.doctrinePath ?? DOCTRINE_PATH;
		if (existsSync(path)) doctrine = path;
		else logScope.warn("doctrine file missing; running with default prompt", { path });
	}

	const bridge = new RpcBridge({
		command: options.ompCommand ?? "omp",
		cwd: options.cwd,
		profile: options.profile,
		model: options.model,
		sessionDir: options.sessionDir,
		ephemeral: options.ephemeral,
		doctrinePath: doctrine,
		restartBackoffMs: options.restartBackoffMs,
		restartBackoffMaxMs: options.restartBackoffMaxMs,
		logger: logScope,
	});

	const history = [];
	const HISTORY_LIMIT = 400;
	const wsClients = { current: null };

	function broadcast(frame) {
		wsClients.current?.broadcast(frame);
	}

	bridge.on("frame", raw => {
		const frame = project(raw);
		if (!frame) return;
		history.push(frame);
		if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
		if (frame.type === "notice" && frame.kind === "error") metrics.errors += 1;
		broadcast(frame);
	});
	bridge.on("exit", info => {
		logScope.warn("omp child exited", info);
		broadcast({ type: "notice", kind: "error", text: `omp exited (code ${info.code ?? "null"})` });
	});
	bridge.on("spawn", info => {
		logScope.info("omp child spawned", { pid: info.pid, args: info.args });
		broadcast({ type: "bridge_spawn", pid: info.pid });
	});

	const server = createServer(async (req, res) => {
		metrics.requests += 1;
		const started = Date.now();
		const rid = correlationId();
		res.setHeader("x-request-id", rid);
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("x-frame-options", "SAMEORIGIN");

		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const clientKey = req.socket.remoteAddress ?? "unknown";

		try {
			const isApi = url.pathname.startsWith("/api/");
			// Health and metrics are exempt: a supervisor polling every second must
			// never 429 itself into reporting a healthy daemon as down.
			const exempt = url.pathname === "/api/health" || url.pathname === "/api/metrics";
			if (isApi && !exempt) {
				const bucket = limiter.take(clientKey);
				res.setHeader("x-ratelimit-remaining", String(bucket.remaining));
				if (!bucket.allowed) {
					metrics.rejected += 1;
					throw Object.assign(new Error("rate limit exceeded"), { status: 429, retryAfterMs: bucket.resetMs });
				}
			}

			if (url.pathname === "/api/health") {
				const body = {
					ok: bridge.ready,
					status: bridge.ready ? "ready" : "starting",
					bridge: bridge.describe(),
					clients: wsClients.current?.size ?? 0,
					doctrine: doctrine ? "loaded" : "absent",
					uptimeMs: Date.now() - metrics.startedAt,
				};
				return json(res, bridge.ready ? 200 : 503, body);
			}

			if (url.pathname === "/api/metrics") {
				return json(res, 200, {
					...metrics,
					uptimeMs: Date.now() - metrics.startedAt,
					bridge: bridge.describe(),
					clients: wsClients.current?.size ?? 0,
					rateLimitBuckets: limiter.size,
					logCounters: log.counters,
					logFile: log.path,
				});
			}

			// The token gates data and commands, not the app shell. Static assets
			// carry no secrets, and a browser cannot attach a header (or a query
			// string) to a subresource request — gating them makes the page load as
			// blank HTML with 401s for its own script and stylesheet.
			if (!url.pathname.startsWith("/api/")) {
				if (req.method !== "GET" && req.method !== "HEAD") throw Object.assign(new Error("method not allowed"), { status: 405 });
				// `await` matters: returning the promise from inside `try` would let a
				// rejection (the 404/403 paths below) escape this catch, so the
				// response is never written and the client hangs until it times out.
				return await serveStatic(res, url.pathname, req.method === "HEAD");
			}

			// Everything below is data or an effect, so a token is required when one
			// is configured.
			if (options.token && !tokenMatches(options.token, presentedToken(req, url))) {
				metrics.rejected += 1;
				throw Object.assign(new Error("unauthorized"), { status: 401 });
			}

			if (url.pathname === "/api/state") {
				if (!bridge.ready) return json(res, 503, { error: "omp RPC not ready", bridge: bridge.describe() });
				const response = await bridge.call("get_state", {}, { timeoutMs: options.requestTimeoutMs });
				return json(res, 200, response.data);
			}

			if (url.pathname === "/api/history") {
				return json(res, 200, { frames: history });
			}

			if (url.pathname === "/api/command" && req.method === "POST") {
				const body = await readJson(req, options.maxBodyBytes);
				const spec = UI_COMMANDS[body?.type];
				if (!spec) throw Object.assign(new Error(`unsupported command: ${body?.type}`), { status: 400 });
				if (!bridge.ready) return json(res, 503, { error: "omp RPC not ready", bridge: bridge.describe() });
				spec.validate?.(body);
				const payload = pick(body.payload, spec.fields);
				const timeoutMs = body.timeoutMs ?? (body.type === "prompt" ? options.promptTimeoutMs : options.requestTimeoutMs);
				metrics.commands += 1;
				if (body.type === "prompt") metrics.prompts += 1;
				const response = await bridge.call(spec.rpc, payload, { timeoutMs });
				return json(res, 200, { ok: true, requestId: rid, data: response.data ?? null });
			}

			if (url.pathname === "/api/shutdown" && req.method === "POST") {
				logScope.info("shutdown requested over HTTP", { rid });
				json(res, 202, { ok: true });
				setTimeout(() => void shutdown("api"), 50);
				return;
			}

			// The token gates data and commands, not the app shell. Static assets
			// carry no secrets, and a browser cannot attach a header (or a query
			// string) to a subresource request — gating them makes the page load as
			// blank HTML with 401s for its own script and stylesheet.
			if (req.method !== "GET" && req.method !== "HEAD") throw Object.assign(new Error("method not allowed"), { status: 405 });
			return serveStatic(res, url.pathname, req.method === "HEAD");
		} catch (error) {
			metrics.errors += 1;
			const status = error.status ?? (error.code === "timeout" ? 504 : 500);
			if (status >= 500) logScope.error("request failed", { rid, path: url.pathname, error: error.message, status });
			else logScope.debug("request rejected", { rid, path: url.pathname, error: error.message, status });
			if (error.retryAfterMs) res.setHeader("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
			if (!res.headersSent) return json(res, status, { error: error.message, code: error.code ?? null, requestId: rid });
			return res.end();
		} finally {
			logScope.debug("request", { rid, method: req.method, path: url.pathname, ms: Date.now() - started });
		}
	});

	wsClients.current = attachWebSocket(server, {
		path: "/ws",
		authorize: req => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			if (!originAllowed(req)) {
				metrics.wsRejected += 1;
				logScope.warn("ws rejected: cross-origin", { origin: req.headers.origin });
				return false;
			}
			if (options.token && !tokenMatches(options.token, presentedToken(req, url))) {
				metrics.wsRejected += 1;
				logScope.warn("ws rejected: bad token", { from: req.socket.remoteAddress });
				return false;
			}
			return true;
		},
		onConnection: (conn, req) => {
			metrics.wsConnections += 1;
			logScope.info("ws connected", { from: req.socket.remoteAddress });
			conn.sendJson({ type: "bridge_hello", bridge: bridge.describe(), doctrine: Boolean(doctrine) });
			for (const frame of history.slice(-120)) conn.sendJson(frame);
			conn.on("message", text => void onSocketCommand(conn, text));
		},
	});

	async function onSocketCommand(conn, text) {
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			conn.sendJson({ type: "client_error", error: "invalid JSON" });
			return;
		}
		if (body?.type === "ping") {
			conn.sendJson({ type: "pong", at: Date.now() });
			return;
		}
		const spec = UI_COMMANDS[body?.type];
		if (!spec) {
			conn.sendJson({ type: "client_error", error: `unsupported command: ${body?.type}` });
			return;
		}
		try {
			spec.validate?.(body);
			const payload = pick(body.payload, spec.fields);
			const timeoutMs = body.timeoutMs ?? (body.type === "prompt" ? options.promptTimeoutMs : options.requestTimeoutMs);
			metrics.commands += 1;
			if (body.type === "prompt") metrics.prompts += 1;
			const response = await bridge.call(spec.rpc, payload, { timeoutMs });
			conn.sendJson({ type: "command_ack", requestId: body.requestId ?? null, command: spec.rpc, success: true, data: response.data ?? null });
		} catch (error) {
			metrics.errors += 1;
			conn.sendJson({ type: "command_ack", requestId: body.requestId ?? null, command: spec.rpc, success: false, error: error.message, code: error.code ?? null });
		}
	}

	async function serveStatic(res, pathname, headOnly) {
		const rel = pathname === "/" ? "/index.html" : pathname;
		const candidate = resolve(WEB_ROOT, `.${rel}`);
		if (!candidate.startsWith(WEB_ROOT)) throw Object.assign(new Error("forbidden"), { status: 403 });
		if (!existsSync(candidate) || !statSync(candidate).isFile()) throw Object.assign(new Error("not found"), { status: 404 });
		const type = MIME[extname(candidate)] ?? "application/octet-stream";
		res.writeHead(200, {
			"content-type": type,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy":
				"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'",
		});
		if (headOnly) return res.end();
		createReadStream(candidate).pipe(res);
	}

	let shuttingDown = false;
	async function shutdown(reason) {
		if (shuttingDown) return;
		shuttingDown = true;
		logScope.info("shutting down", { reason });
		broadcast({ type: "notice", kind: "info", text: `Shutting down (${reason})` });
		wsClients.current?.closeAll(1001, "server shutdown");
		server.close();
		await bridge.stop();
	}

	return {
		server,
		bridge,
		log,
		metrics,
		ws: () => wsClients.current,
		history,
		shutdown,
		async listen({ port = options.port, host = options.host } = {}) {
			await new Promise((resolveListen, rejectListen) => {
				server.once("error", rejectListen);
				server.listen(port, host, () => {
					server.off("error", rejectListen);
					resolveListen();
				});
			});
			bridge.start();
			const address = server.address();
			return { port: typeof address === "object" && address ? address.port : port, host };
		},
	};
}

function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(payload);
}

async function readJson(req, maxBytes = 2 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) throw Object.assign(new Error("request body too large"), { status: 413 });
		chunks.push(chunk);
	}
	if (!chunks.length) return null;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(new Error("invalid JSON body"), { status: 400 });
	}
}

export function readPackageVersion() {
	return readFile(new URL("../package.json", import.meta.url), "utf8").then(text => JSON.parse(text).version);
}
