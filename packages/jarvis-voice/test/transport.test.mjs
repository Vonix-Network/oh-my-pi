import assert from "node:assert/strict";
import { test } from "node:test";
import { ChunkReassembler, LineSplitter } from "../src/rpc-bridge.mjs";

test("LineSplitter handles frames split across chunks", () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push('{"type":"ready"'), []);
	assert.deepEqual(splitter.push(',"protocolVersion":1}\n{"type":"a"}'), ['{"type":"ready","protocolVersion":1}']);
	assert.deepEqual(splitter.push('\n'), ['{"type":"a"}']);
	assert.deepEqual(splitter.push(""), []);
});

test("LineSplitter ignores blank lines and keeps a trailing partial", () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push("\n\n{\"x\":1}\n\npartial"), ['{"x":1}']);
	assert.deepEqual(splitter.push(" end\n"), ["partial end"]);
});

test("ChunkReassembler rebuilds a multi-chunk frame in order", () => {
	const body = JSON.stringify({ type: "message_end", text: "héllo wörld" });
	const bytes = Buffer.from(body, "utf8");
	const third = Math.ceil(bytes.length / 3);
	const parts = [bytes.subarray(0, third), bytes.subarray(third, third * 2), bytes.subarray(third * 2)];

	const reassembler = new ChunkReassembler();
	const results = parts.map((part, index) =>
		reassembler.push({ chunkId: "rpc-1", index, count: 3, byteLength: bytes.length, data: part.toString("base64") }),
	);
	assert.deepEqual(results.at(-1).value, body);
	assert.equal(results[0].pending, true);
	assert.equal(JSON.parse(results.at(-1).value).text, "héllo wörld");
});

test("ChunkReassembler rejects duplicate, out-of-order and mismatched sequences", () => {
	const bytes = Buffer.from("{}", "utf8");
	const b64 = bytes.toString("base64");

	const duplicate = new ChunkReassembler();
	duplicate.push({ chunkId: "a", index: 0, count: 3, byteLength: 6, data: b64 });
	duplicate.push({ chunkId: "a", index: 1, count: 3, byteLength: 6, data: b64 });
	const dup = duplicate.push({ chunkId: "a", index: 1, count: 3, byteLength: 6, data: b64 });
	assert.equal(dup.ok, false);
	assert.match(dup.error, /duplicate/);

	// A second index 0 is a restarted sequence, not a duplicate field.
	const restart = new ChunkReassembler();
	restart.push({ chunkId: "a", index: 0, count: 2, byteLength: 2, data: b64 });
	assert.match(restart.push({ chunkId: "a", index: 0, count: 2, byteLength: 2, data: b64 }).error, /interrupted/);

	const orphan = new ChunkReassembler();
	assert.equal(orphan.push({ chunkId: "a", index: 1, count: 2, byteLength: 2, data: b64 }).ok, false);

	const interleaved = new ChunkReassembler();
	interleaved.push({ chunkId: "a", index: 0, count: 3, byteLength: 3, data: b64 });
	const middle = interleaved.push({ chunkId: "b", index: 1, count: 3, byteLength: 3, data: b64 });
	assert.equal(middle.ok, false);
	assert.match(middle.error, /chunkId changed/);

	const huge = new ChunkReassembler({ maxBytes: 10 });
	assert.equal(huge.push({ chunkId: "a", index: 0, count: 1, byteLength: 99, data: b64 }).ok, false);

	const short = new ChunkReassembler();
	const truncated = short.push({ chunkId: "a", index: 0, count: 1, byteLength: 99, data: b64 });
	assert.equal(truncated.ok, false);
	assert.match(truncated.error, /byteLength mismatch/);
});

test("ChunkReassembler rejects an index outside the declared count", () => {
	const reassembler = new ChunkReassembler();
	const result = reassembler.push({ chunkId: "a", index: 4, count: 2, byteLength: 2, data: "e30=" });
	assert.equal(result.ok, false);
	assert.match(result.error, /index out of range/);
});
