/**
 * omp — Jarvis voice HUD client.
 *
 * Binds to the bridge over one WebSocket, renders the omp RPC stream, and
 * layers push-to-talk speech input plus spoken replies on top.
 *
 * Speech is browser-side on purpose: the omp server's `live_start` path needs a
 * realtime provider credential, whereas the Web Speech API needs none. When the
 * browser has no recognizer the HUD says so plainly instead of pretending to
 * listen.
 */

const $ = id => document.getElementById(id);

const els = {
	shell: $("shell"),
	stream: $("stream"),
	empty: $("stream-empty"),
	orb: $("orb"),
	phaseLabel: $("phase-label"),
	phaseDetail: $("phase-detail"),
	input: $("input"),
	composer: $("composer"),
	mic: $("mic"),
	send: $("send"),
	stop: $("btn-stop"),
	voice: $("btn-voice"),
	newSession: $("btn-new"),
	linkState: $("link-state"),
	linkText: $("link-text"),
	statModel: $("stat-model"),
	statEffort: $("stat-effort"),
	statContext: $("stat-context"),
	statTps: $("stat-tps"),
	hint: $("status-hint"),
	toasts: $("toasts"),
	voiceSupport: $("voice-support"),
};

const state = {
	phase: "boot",
	socket: null,
	reconnectAttempt: 0,
	streaming: false,
	thinking: false,
	listening: false,
	lastAssistantId: null,
	messages: new Map(),
	tools: new Map(),
	speechOut: true,
	usage: null,
	context: null,
	startedAt: 0,
	tps: null,
	token: new URLSearchParams(location.search).get("token") ?? "",
};

/* ── orb ──────────────────────────────────────────────────────────────── */

/**
 * The orb is the only animated surface. It renders a ring of analysis bars plus
 * a breathing core, driven by a phase gain and a live audio level so the owner
 * can see the HUD hearing them without reading text.
 */
const orb = (() => {
	const canvas = els.orb;
	const ctx = canvas.getContext("2d", { alpha: true });
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	let width = 0;
	let height = 0;
	let frame = 0;
	let level = 0;
	let target = 0;
	let gain = 0.35;
	let raf = 0;

	function resize() {
		const rect = canvas.getBoundingClientRect();
		width = Math.max(1, Math.round(rect.width));
		height = Math.max(1, Math.round(rect.height));
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	const ACCENT = {
		boot: [110, 150, 190],
		idle: [96, 176, 226],
		listening: [79, 216, 255],
		thinking: [120, 170, 255],
		speaking: [255, 180, 87],
		error: [255, 107, 107],
	};

	function draw(now) {
		const t = now / 1000;
		level += (target - level) * 0.16;
		const accent = ACCENT[state.phase] ?? ACCENT.idle;
		const [r, g, b] = accent;
		const cx = width / 2;
		const cy = height / 2;
		const base = Math.min(width, height) / 2;
		const inner = base * 0.42;

		ctx.clearRect(0, 0, width, height);

		// Core halo.
		const pulse = 0.9 + Math.sin(t * (state.phase === "thinking" ? 2.4 : 1.1)) * 0.06 + level * 0.35;
		const halo = ctx.createRadialGradient(cx, cy, inner * 0.1, cx, cy, base * pulse);
		halo.addColorStop(0, `rgba(${r},${g},${b},${0.42 + level * 0.4})`);
		halo.addColorStop(0.45, `rgba(${r},${g},${b},${0.12 + level * 0.18})`);
		halo.addColorStop(1, "rgba(0,0,0,0)");
		ctx.fillStyle = halo;
		ctx.beginPath();
		ctx.arc(cx, cy, base * pulse, 0, Math.PI * 2);
		ctx.fill();

		// Inner disc.
		const disc = ctx.createRadialGradient(cx - inner * 0.25, cy - inner * 0.3, inner * 0.1, cx, cy, inner);
		disc.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
		disc.addColorStop(0.55, `rgba(${Math.round(r * 0.35)},${Math.round(g * 0.55)},${Math.round(b * 0.8)},0.85)`);
		disc.addColorStop(1, "rgba(4,8,14,0.92)");
		ctx.fillStyle = disc;
		ctx.beginPath();
		ctx.arc(cx, cy, inner, 0, Math.PI * 2);
		ctx.fill();

		// Analysis bars.
		const bars = 96;
		for (let i = 0; i < bars; i++) {
			const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
			const wobble =
				Math.sin(t * 1.7 + i * 0.55) * 0.5 +
				Math.sin(t * 0.9 - i * 0.21) * 0.35 +
				Math.sin(t * 3.1 + i * 1.4) * 0.15;
			const amp = (0.06 + Math.abs(wobble) * 0.55) * gain * (1 + level * 2.2);
			const from = inner * 1.16;
			const to = from + base * amp;
			const alpha = 0.18 + Math.abs(wobble) * 0.5 * Math.min(1, gain + level);
			ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
			ctx.lineWidth = Math.max(1, base * 0.012);
			ctx.beginPath();
			ctx.moveTo(cx + Math.cos(angle) * from, cy + Math.sin(angle) * from);
			ctx.lineTo(cx + Math.cos(angle) * to, cy + Math.sin(angle) * to);
			ctx.stroke();
		}

		// Sweep arc, only while working.
		if (state.phase === "thinking" || state.phase === "speaking") {
			const sweep = (t * 1.4) % (Math.PI * 2);
			ctx.strokeStyle = `rgba(${r},${g},${b},0.75)`;
			ctx.lineWidth = Math.max(1.5, base * 0.02);
			ctx.beginPath();
			ctx.arc(cx, cy, inner * 1.08, sweep, sweep + 0.7);
			ctx.stroke();
		}

		frame = requestAnimationFrame(draw);
	}

	function start() {
		if (raf) return;
		resize();
		frame = 0;
		raf = requestAnimationFrame(draw);
	}

	function stop() {
		if (!raf) return;
		cancelAnimationFrame(raf);
		raf = 0;
	}

	window.addEventListener("resize", resize, { passive: true });
	if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(canvas);

	return {
		start,
		stop,
		resize,
		setLevel(value) {
			target = Math.max(0, Math.min(1, value));
		},
		get running() {
			return Boolean(raf);
		},
		get frames() {
			return frame;
		},
		setGain(value) {
			gain = value;
		},
	};
})();

/* ── phase ────────────────────────────────────────────────────────────── */

const PHASE_TEXT = {
	boot: ["INITIALISING", "connecting to omp"],
	idle: ["STANDBY", "ready"],
	listening: ["LISTENING", "speak now"],
	thinking: ["WORKING", "omp is running"],
	speaking: ["SPEAKING", "replying aloud"],
	error: ["DEGRADED", "check the notice"],
};

let idleTimer = 0;

function setPhase(phase, detail) {
	if (state.phase === phase && !detail) return;
	state.phase = phase;
	els.shell.dataset.phase = phase;
	const [label, sub] = PHASE_TEXT[phase] ?? PHASE_TEXT.idle;
	els.phaseLabel.textContent = label;
	els.phaseDetail.textContent = detail ?? sub;
	orb.setGain(phase === "listening" ? 0.85 : phase === "thinking" ? 0.6 : phase === "speaking" ? 0.7 : 0.32);
}

function settlePhase() {
	clearTimeout(idleTimer);
	if (state.listening) return setPhase("listening");
	if (state.streaming) return setPhase("thinking");
	if (state.speaking) return setPhase("speaking");
	setPhase("idle");
}

/* ── transport ────────────────────────────────────────────────────────── */

function wsUrl() {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/ws`;
}

function connect() {
	setLink("connecting", "connecting");
	const socket = new WebSocket(wsUrl());
	state.socket = socket;

	socket.addEventListener("open", () => {
		state.reconnectAttempt = 0;
		state.startedAt = Date.now();
		setLink("open", "linked");
		setPhase("idle");
		requestState();
	});

	socket.addEventListener("close", () => {
		setLink("closed", "disconnected");
		if (state.phase !== "error") setPhase("error", "bridge disconnected");
		scheduleReconnect();
	});

	socket.addEventListener("error", () => {
		setLink("closed", "socket error");
	});

	socket.addEventListener("message", event => {
		let frame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			return;
		}
		handleFrame(frame);
	});
}

function scheduleReconnect() {
	const delay = Math.min(6000, 350 * 2 ** state.reconnectAttempt);
	state.reconnectAttempt += 1;
	setTimeout(() => {
		if (!state.socket || state.socket.readyState > WebSocket.OPEN) connect();
	}, delay);
}

function setLink(status, text) {
	els.linkState.dataset.state = status;
	els.linkText.textContent = text;
}

function sendCommand(type, payload, requestId) {
	const socket = state.socket;
	if (!socket || socket.readyState !== WebSocket.OPEN) {
		toast("Not connected to the omp bridge", "error");
		return false;
	}
	socket.send(JSON.stringify({ type, payload, requestId }));
	return true;
}

function requestState() {
	sendCommand("get_state", {}, "state-refresh");
}

/* ── frame handling ───────────────────────────────────────────────────── */

function handleFrame(frame) {
	switch (frame.type) {
		case "bridge_hello":
			applyBridge(frame.bridge);
			requestState();
			return;
		case "bridge_spawn":
			setLink("connecting", "spawning omp");
			return;
		case "ready":
			setLink("open", `rpc v${frame.protocolVersion}`);
			return;
		case "agent_start":
			state.streaming = true;
			els.stop.disabled = false;
			setPhase("thinking");
			return;
		case "agent_end":
			state.streaming = false;
			els.stop.disabled = true;
			finishStreamingBubbles();
			settlePhase();
			return;
		case "prompt_result":
			if (frame.status === "error" && frame.error) toast(`Turn failed: ${frame.error.message ?? frame.error}`, "error");
			if (frame.status === "aborted") toast("Turn stopped", "info");
			return;
		case "session_settled":
			state.streaming = false;
			els.stop.disabled = true;
			settlePhase();
			return;
		case "message_start":
			// Register the id before any delta arrives, so the first text_delta and
			// any tool line for this message attach to one bubble.
			if (frame.role === "assistant") {
				state.currentMessageId = frame.messageId;
				ensureAssistant(frame.messageId);
			} else if (frame.role === "user") {
				state.currentMessageId = frame.messageId;
			}
			return;
		case "message_end":
			finishMessage(frame);
			return;
		case "delta":
			appendDelta(frame);
			return;
		case "toolcall_start":
			return;
		case "tool_end":
			updateTool(frame);
			return;
		case "tool_start":
			startTool(frame);
			return;
		case "tool_update":
			updateTool(frame);
			return;
		case "queue":
			return;
		case "model_changed":
			if (frame.model) els.statModel.textContent = frame.model.name ?? frame.model.id;
			return;
		case "thinking_level_changed":
			els.statEffort.textContent = frame.level ?? "—";
			return;
		case "notice":
			if (frame.text) toast(frame.text, frame.kind === "error" ? "error" : "info");
			return;
		case "command_ack":
			if (frame.command === "prompt") state.lastPromptAck = frame.success ? "ok" : frame.error;
			if (!frame.success) toast(`${frame.command} failed: ${frame.error}`, "error");
			if (frame.data && frame.command === "get_state") applyState(frame.data);
			return;
		case "client_error":
			toast(frame.error, "error");
			return;
		case "goal":
			return;
		default:
			return;
	}
}

function applyBridge(bridge) {
	if (!bridge) return;
	if (bridge.cwd) els.statModel.title = `cwd ${bridge.cwd}`;
}

/* ── transcript ───────────────────────────────────────────────────────── */

const AUTO_SCROLL_SLACK = 80;

function nearBottom() {
	const el = els.stream;
	return el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_SLACK;
}

function scrollToBottom() {
	els.stream.scrollTop = els.stream.scrollHeight;
}

function dropEmptyState() {
	if (els.empty && els.empty.isConnected) els.empty.remove();
}

function ensureAssistant(messageId) {
	const key = messageId ?? "live-assistant";
	let entry = state.messages.get(key);
	if (entry) return entry;

	dropEmptyState();
	const li = document.createElement("li");
	li.className = "msg msg-assistant";
	li.dataset.messageId = key;

	const head = document.createElement("p");
	head.className = "msg-head";
	head.textContent = "omp";

	const thinking = document.createElement("div");
	thinking.className = "thinking";
	thinking.hidden = true;

	const body = document.createElement("p");
	body.className = "msg-body";

	const tools = document.createElement("ul");
	tools.className = "msg-tools";

	const meta = document.createElement("p");
	meta.className = "msg-meta";
	meta.hidden = true;

	li.append(head, thinking, body, tools, meta);
	const stick = nearBottom();
	els.stream.append(li);
	if (stick) scrollToBottom();

	entry = { li, body, thinking, tools, meta, messageId: key, text: "", thinkingText: "", toolIds: [] };
	state.messages.set(key, entry);
	return entry;
}

function ensureUser(messageId, text, local = false) {
	// The composer echoes a bubble locally for instant feedback; the server then
	// sends the same message with a real id. Adopt the echo rather than adding a
	// second bubble, or every prompt appears twice.
	const key = messageId ?? `user-local-${Date.now()}`;
	let entry = state.messages.get(key);
	if (!entry && messageId && state.pendingUserKey) {
		const echo = state.messages.get(state.pendingUserKey);
		if (echo && echo.local) {
			state.messages.delete(state.pendingUserKey);
			echo.local = false;
			echo.messageId = messageId;
			echo.li.dataset.messageId = messageId;
			state.messages.set(messageId, echo);
			if (text) {
				echo.text = text;
				echo.body.textContent = text;
			}
			state.pendingUserKey = null;
			return echo;
		}
	}
	if (entry) return entry;
	dropEmptyState();
	const li = document.createElement("li");
	li.className = "msg msg-user";
	li.dataset.messageId = key;
	const head = document.createElement("p");
	head.className = "msg-head";
	head.textContent = "you";
	const body = document.createElement("p");
	body.className = "msg-body";
	body.textContent = text;
	li.append(head, body);
	els.stream.append(li);
	scrollToBottom();
	entry = { li, body, text, messageId: local ? null : (messageId ?? null), local };
	state.messages.set(key, entry);
	return entry;
}

function appendDelta(frame) {
	if (frame.kind === "thinking") {
		const entry = ensureAssistant(frame.messageId);
		entry.thinkingText += frame.text;
		entry.thinking.textContent = entry.thinkingText;
		entry.thinking.hidden = false;
		if (nearBottom()) scrollToBottom();
		return;
	}
	const entry = ensureAssistant(frame.messageId);
	entry.text += frame.text;
	entry.body.textContent = entry.text;
	if (nearBottom()) scrollToBottom();
}

function finishMessage(frame) {
	if (frame.role === "user") {
		ensureUser(frame.messageId, frame.text ?? "");
		return;
	}
	// Tool results are not assistant prose; render them only as the tool line
	// they belong to, never as an empty assistant bubble.
	if (frame.role === "toolResult" || frame.role === "tool") {
		return;
	}
	if (frame.role !== "assistant") return;
	const entry = ensureAssistant(frame.messageId);
	// message_end is authoritative: a rebuilt stream can disagree with it.
	if (typeof frame.text === "string" && frame.text.length) {
		entry.text = frame.text;
		entry.body.textContent = frame.text;
	}
	if (frame.thinking) {
		entry.thinkingText = frame.thinking;
		entry.thinking.textContent = frame.thinking;
		entry.thinking.hidden = false;
	}
	if (Array.isArray(frame.toolCalls)) {
		for (const call of frame.toolCalls) {
			if (call?.name && !entry.toolIds.includes(call.id)) startTool({ id: call.id, tool: call.name, args: call.args });
		}
	}
	if (frame.usage) {
		state.usage = frame.usage;
		renderUsage(frame);
	}
	if (frame.stopReason === "error") {
		entry.meta.hidden = false;
		entry.meta.textContent = "turn ended with an error";
	}
	state.lastAssistantId = frame.messageId;
	speak(entry.text);
	if (nearBottom()) scrollToBottom();
}

function renderUsage(frame) {
	const meta = ensureAssistant(frame.messageId).meta;
	const parts = [];
	if (typeof frame.usage.input === "number") parts.push(`${frame.usage.input.toLocaleString()} in`);
	if (typeof frame.usage.output === "number") parts.push(`${frame.usage.output.toLocaleString()} out`);
	if (frame.usage.cost) parts.push(`$${Number(frame.usage.cost).toFixed(4)}`);
	if (typeof frame.duration === "number") parts.push(`${(frame.duration / 1000).toFixed(1)}s`);
	meta.textContent = parts.join(" · ");
	meta.hidden = parts.length === 0;
}

function finishStreamingBubbles() {
	for (const entry of state.messages.values()) {
		if (entry.meta && !entry.meta.textContent) entry.meta.hidden = true;
	}
}

function startTool(frame) {
	const entry = ensureAssistant(state.currentMessageId ?? "live-assistant");
	const toolId = frame.id ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	// A tool can be announced by both a streamed toolcall_end and a
	// tool_execution_start carrying the same id; render it once.
	if (state.tools.has(toolId)) return state.tools.get(toolId);
	const li = document.createElement("li");
	li.className = "tool-line";
	li.dataset.state = "running";
	li.dataset.toolId = toolId;
	const name = document.createElement("span");
	name.className = "tool-name";
	name.textContent = frame.tool ?? "tool";
	const arg = document.createElement("span");
	arg.className = "tool-arg";
	arg.textContent = describeArgs(frame.args);
	li.append(name, arg);
	entry.tools.append(li);
	const record = { li, name, arg, state: "running" };
	state.tools.set(toolId, record);
	if (nearBottom()) scrollToBottom();
	return record;
}

function updateTool(frame) {
	const known = frame.id ? state.tools.get(frame.id) : null;
	if (!known) {
		// A result with no prior start still deserves a line, and it is already
		// finished — starting it in "running" would leave it spinning forever.
		const created = startTool(frame);
		if (frame.type === "tool_end") {
			created.li.dataset.state = frame.isError ? "error" : "done";
			created.state = frame.isError ? "error" : "done";
			created.li.title = frame.result ?? "";
		}
		return;
	}
	if (frame.type === "tool_end") {
		known.li.dataset.state = frame.isError ? "error" : "done";
		known.state = frame.isError ? "error" : "done";
		known.li.title = frame.result ?? "";
	} else if (frame.text) {
		known.arg.textContent = describeArgs(null, frame.text);
	}
}

function describeArgs(args, existing) {
	if (args && typeof args === "object") {
		const interesting = args.path ?? args.command ?? args.pattern ?? args.query ?? args.message ?? args.file_path ?? args.prompt;
		if (typeof interesting === "string") return interesting.slice(0, 120);
		const first = Object.entries(args)[0];
		if (first) return `${first[0]}=${String(first[1]).slice(0, 80)}`;
		return "";
	}
	if (typeof args === "string") return args.slice(0, 120);
	return existing ?? "";
}

function notice(text, kind = "info") {
	dropEmptyState();
	const li = document.createElement("li");
	li.className = "notice";
	li.dataset.kind = kind;
	li.textContent = text;
	els.stream.append(li);
	if (nearBottom()) scrollToBottom();
}

function toast(text, kind = "error") {
	notice(text, kind);
	const node = document.createElement("div");
	node.className = "toast";
	node.dataset.kind = kind;
	node.textContent = text;
	els.toasts.append(node);
	setTimeout(() => node.remove(), kind === "error" ? 7000 : 3500);
}

/* ── state ────────────────────────────────────────────────────────────── */

function applyState(data) {
	if (!data || typeof data !== "object") return;
	if (data.model) {
		els.statModel.textContent = data.model.name ?? data.model.id ?? "—";
		els.statModel.title = `${data.model.provider ?? "?"}/${data.model.id ?? "?"}`;
	}
	els.statEffort.textContent = data.thinkingLevel ?? "—";
	if (data.contextUsage) renderContext(data.contextUsage);
	els.statTps.textContent = typeof data.tokensPerSecond === "number" ? data.tokensPerSecond.toFixed(0) : "—";
	state.streaming = Boolean(data.isStreaming);
	els.stop.disabled = !state.streaming;
	if (data.queuedMessageCount) els.hint.textContent = `${data.queuedMessageCount} message(s) queued`;
	setPhase(state.streaming ? "thinking" : "idle");
}

function renderContext(usage) {
	if (!usage || typeof usage.tokens !== "number") return;
	const pct = typeof usage.percent === "number" ? usage.percent : null;
	const window_ = usage.contextWindow ?? 0;
	const shownPct = pct !== null ? `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%` : "—";
	els.statContext.textContent = window_ ? `${shownPct} · ${formatCount(usage.tokens)}/${formatCount(window_)}` : `${formatCount(usage.tokens)} tok`;
}

function formatCount(n) {
	if (!Number.isFinite(n)) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
	return String(n);
}

/* ── composer ─────────────────────────────────────────────────────────── */

function submitPrompt(text) {
	const message = (text ?? els.input.value).trim();
	if (!message) return;
	if (!sendCommand("prompt", { message }, `prompt-${Date.now()}`)) return;
	// Remember the local echo's key so the server's copy of this message adopts
	// it instead of appending a duplicate bubble.
	state.pendingUserKey = `user-local-${Date.now()}`;
	ensureUser(state.pendingUserKey, message, true);
	els.input.value = "";
	autoGrow();
	setPhase("thinking", "sent");
}

function autoGrow() {
	const el = els.input;
	el.style.height = "auto";
	el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
}

els.composer.addEventListener("submit", event => {
	event.preventDefault();
	submitPrompt();
});

els.input.addEventListener("input", autoGrow);

els.input.addEventListener("keydown", event => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		submitPrompt();
	}
});

els.stop.addEventListener("click", () => {
	sendCommand("abort", {}, `abort-${Date.now()}`);
	setPhase("idle", "stopping");
});

els.newSession.addEventListener("click", () => {
	sendCommand("new_session", {}, `new-${Date.now()}`);
	state.messages.clear();
	state.tools.clear();
	els.stream.textContent = "";
	restoreEmptyState();
	toast("New session started", "info");
});

els.voice.addEventListener("click", () => {
	state.speechOut = !state.speechOut;
	els.voice.setAttribute("aria-pressed", String(state.speechOut));
	if (!state.speechOut) stopSpeaking();
});

function restoreEmptyState() {
	const li = document.createElement("li");
	li.className = "empty";
	li.id = "stream-empty";
	const p1 = document.createElement("p");
	p1.innerHTML = 'Hold <kbd>Space</kbd> and speak, or type below.';
	const p2 = document.createElement("p");
	p2.className = "muted";
	p2.id = "voice-support";
	p2.textContent = speechRecognitionStatus();
	li.append(p1, p2);
	els.stream.append(li);
	els.empty = li;
	els.voiceSupport = p2;
}

/* ── speech in ────────────────────────────────────────────────────────── */

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;

const speech = {
	recognition: null,
	active: false,
	finalText: "",
	interim: "",
	pressAt: 0,
};

function speechRecognitionStatus() {
	if (!Recognition) return "no speech recognizer in this browser — type instead";
	return "hold to talk · on-device microphone";
}

function buildRecognition() {
	if (!Recognition) return null;
	const rec = new Recognition();
	rec.lang = navigator.language || "en-US";
	rec.continuous = true;
	rec.interimResults = true;
	rec.maxAlternatives = 1;
	rec.onresult = event => {
		orb.setLevel(0.55);
		for (let i = event.resultIndex; i < event.results.length; i++) {
			const result = event.results[i];
			const text = result[0]?.transcript ?? "";
			if (result.isFinal) {
				speech.finalText = `${speech.finalText} ${text}`.trim();
				speech.interim = "";
			} else {
				speech.interim = text;
			}
		}
		const draft = `${speech.finalText} ${speech.interim}`.trim();
		els.input.value = draft;
		autoGrow();
	};
	rec.onerror = event => {
		if (event.error === "not-allowed" || event.error === "service-not-allowed") {
			toast("Microphone permission denied — allow it in the browser to speak", "error");
			stopListening(true);
			return;
		}
		if (event.error === "no-speech") return;
		toast(`Speech error: ${event.error}`, "error");
	};
	rec.onend = () => {
		speech.active = false;
		if (state.listening) stopListening();
	};
	return rec;
}

function startListening() {
	if (!Recognition) {
		toast("This browser has no speech recognizer. Chrome or Edge support it.", "error");
		return;
	}
	if (state.listening) return;
	speech.recognition ??= buildRecognition();
	speech.finalText = "";
	speech.interim = "";
	speech.pressAt = Date.now();
	state.listening = true;
	els.mic.setAttribute("aria-pressed", "true");
	try {
		speech.recognition.start();
		speech.active = true;
		setPhase("listening");
		orb.setLevel(0.6);
	} catch (error) {
		state.listening = false;
		els.mic.setAttribute("aria-pressed", "false");
		toast(`Could not start listening: ${error.message}`, "error");
	}
}

function stopListening(fromError = false) {
	if (!state.listening) return;
	state.listening = false;
	els.mic.setAttribute("aria-pressed", "false");
	orb.setLevel(0);
	try {
		speech.recognition?.stop();
	} catch {
		/* already stopped */
	}
	const draft = (els.input.value || `${speech.finalText} ${speech.interim}`).trim();
	els.input.value = draft;
	autoGrow();
	settlePhase();
	if (!fromError && draft) {
		// A very short press with no words is a mis-tap, not an empty prompt.
		if (draft.length > 1) submitPrompt(draft);
		else toast("Didn't catch that — hold Space and speak", "info");
	}
}

els.mic.addEventListener("pointerdown", event => {
	event.preventDefault();
	els.mic.setPointerCapture?.(event.pointerId);
	startListening();
});

for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
	els.mic.addEventListener(type, () => stopListening());
}

/* ── speech out ───────────────────────────────────────────────────────── */

const synth = window.speechSynthesis ?? null;
let speaking = false;

function pickVoice() {
	if (!synth) return null;
	const voices = synth.getVoices?.() ?? [];
	if (!voices.length) return null;
	const preferred = ["Google UK English Male", "Daniel", "Arthur", "Microsoft Ryan", "en-GB"];
	for (const want of preferred) {
		const found = voices.find(v => v.name?.includes(want) || v.lang === want);
		if (found) return found;
	}
	return voices.find(v => v.lang?.startsWith("en")) ?? voices[0];
}

/** Strip fenced code and markdown furniture; nobody wants a file read aloud. */
function speakable(text) {
	return text
		.replace(/```[\s\S]*?```/g, " (code omitted) ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/[*_#>]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 900);
}

function speak(text) {
	if (!state.speechOut || !synth || !text) return;
	const clean = speakable(text);
	if (!clean) return;
	const utter = new SpeechSynthesisUtterance(clean);
	const voice = pickVoice();
	if (voice) utter.voice = voice;
	utter.rate = 1.02;
	utter.pitch = 0.95;
	utter.onstart = () => {
		speaking = true;
		state.speaking = true;
		setPhase("speaking");
	};
	utter.onend = () => {
		speaking = false;
		state.speaking = false;
		settlePhase();
	};
	utter.onerror = () => {
		speaking = false;
		state.speaking = false;
		settlePhase();
	};
	synth.cancel();
	synth.speak(utter);
}

function stopSpeaking() {
	if (!synth) return;
	synth.cancel();
	speaking = false;
	state.speaking = false;
	settlePhase();
}

/* ── keyboard ─────────────────────────────────────────────────────────── */

let spaceHeld = false;

document.addEventListener("keydown", event => {
	const inField = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
	if (event.code === "Escape") {
		if (state.streaming) {
			event.preventDefault();
			els.stop.click();
		}
		return;
	}
	if (event.code === "Space" && !inField && !event.repeat) {
		event.preventDefault();
		spaceHeld = true;
		startListening();
	}
});

document.addEventListener("keyup", event => {
	if (event.code === "Space" && spaceHeld) {
		event.preventDefault();
		spaceHeld = false;
		stopListening();
	}
});

/* ── boot ─────────────────────────────────────────────────────────────── */

if (els.voiceSupport) els.voiceSupport.textContent = speechRecognitionStatus();
els.voice.setAttribute("aria-pressed", String(state.speechOut));
setPhase("boot");
orb.start();
connect();

// The orb loop is the HUD's only animation; keep it honest after tab switches.
document.addEventListener("visibilitychange", () => {
	if (document.hidden) orb.stop();
	else orb.start();
});

// Idle telemetry poll so context and tok/s stay current while nothing streams.
setInterval(() => {
	if (state.socket?.readyState === WebSocket.OPEN && !state.streaming) requestState();
}, 6000);

window.__jarvis = {
	get phase() {
		return state.phase;
	},
	get streaming() {
		return state.streaming;
	},
	get listening() {
		return state.listening;
	},
	get orbRunning() {
		return orb.running;
	},
	get messageCount() {
		return state.messages.size;
	},
	get speechSupported() {
		return Boolean(Recognition);
	},
	get ttsSupported() {
		return Boolean(synth);
	},
	speak,
	submitPrompt,
	startListening,
	stopListening,
};
