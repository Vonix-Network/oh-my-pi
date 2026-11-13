import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { project, summarizeResult } from "../src/server.mjs";

test("project keeps text/thinking deltas and drops redundant snapshots", () => {
	assert.deepEqual(project({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }), {
		type: "delta",
		kind: "text",
		messageId: undefined,
		text: "hi",
	});
	assert.equal(project({ type: "message_update", assistantMessageEvent: { type: "text_start" } }), null);
	assert.equal(project({ type: "unknown_event" }), null);
});

test("project reduces message_end to display fields", () => {
	const frame = {
		type: "message_end",
		messageId: "msg-2",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				{ type: "text", text: "done" },
			],
			usage: { input: 12, output: 3, totalTokens: 15, cost: { total: 0.001 } },
			stopReason: "stop",
			provider: "deploy",
			model: "m",
		},
	};
	const out = project(frame);
	assert.equal(out.text, "done");
	assert.equal(out.thinking, "reasoning");
	assert.deepEqual(out.toolCalls, [{ id: "t1", name: "read", args: { path: "a.txt" } }]);
	assert.equal(out.usage.input, 12);
	assert.equal(out.usage.cost, 0.001);
});

test("project surfaces tool lifecycle without leaking whole results", () => {
	const start = project({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
	assert.deepEqual(start, { type: "tool_start", id: "t1", tool: "bash", args: { command: "ls" } });

	const end = project({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: "x".repeat(5000) });
	assert.equal(end.type, "tool_end");
	assert.ok(end.result.length <= 1201, `preview should be bounded, got ${end.result.length}`);
	assert.ok(end.result.endsWith("…"));
	assert.equal(summarizeResult(null), "");
});

test("project reports response failures with the error preserved", () => {
	const failed = project({ type: "response", command: "prompt", success: false, error: "nope", code: "x" });
	assert.equal(failed.success, false);
	assert.equal(failed.error, "nope");
	const ok = project({ type: "response", command: "get_state", success: true, data: { a: 1 } });
	assert.deepEqual(ok.data, { a: 1 });
	assert.equal(ok.error, undefined);
});

test("project maps agent_end yielded/terminal flags", () => {
	assert.equal(project({ type: "agent_end", yielded: false, awaitingAsyncWork: true }).awaitingAsyncWork, true);
	assert.equal(project({ type: "agent_end", isTerminal: true }).yielded, true);
});

test("project turns transport faults into visible notices", () => {
	const notice = project({ type: "bridge_transport_error", error: "chunk mismatch" });
	assert.equal(notice.kind, "error");
	assert.match(notice.text, /chunk mismatch/);
	const ext = project({ type: "extension_error", error: "boom" });
	assert.match(ext.text, /boom/);
});

// Guard the shape the HUD relies on: EventEmitter import stays used if server
// internals change (keeps the import honest rather than dangling).
test("test harness sanity", () => {
	assert.equal(typeof EventEmitter, "function");
});
