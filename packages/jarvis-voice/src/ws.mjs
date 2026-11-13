/**
 * Minimal RFC 6455 WebSocket server (text frames only).
 *
 * The HUD streams agent events to the browser and takes commands back over one
 * socket. SSE would be simpler, but a long-lived EventSource wedges
 * `Page.captureScreenshot` under `--headless=new`, which is exactly how this UI
 * gets verified — so the extra ~150 lines buy a testable surface.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/** One accepted connection. Emits `message` (string) and `close`. */
export class WsConnection extends EventEmitter {
	constructor(socket, head) {
		super();
		this.socket = socket;
		this.closed = false;
		this.fragments = [];
		this.fragmentBytes = 0;
		this.fragmentOpcode = 0;
		this.buffer = Buffer.alloc(0);
		socket.setNoDelay(true);
		if (head?.length) this.#consume(head);
		socket.on("data", chunk => this.#consume(chunk));
		socket.on("error", () => this.destroy());
		socket.on("close", () => this.#finish());
	}

	send(text) {
		if (this.closed) return false;
		this.#writeFrame(OP_TEXT, Buffer.from(text, "utf8"));
		return true;
	}

	sendJson(value) {
		return this.send(JSON.stringify(value));
	}

	ping() {
		if (this.closed) return;
		this.#writeFrame(OP_PING, Buffer.alloc(0));
	}

	close(code = 1000, reason = "") {
		if (this.closed) return;
		const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
		payload.writeUInt16BE(code, 0);
		payload.write(reason, 2);
		this.#writeFrame(OP_CLOSE, payload);
		this.destroy();
	}

	destroy() {
		if (this.closed) return;
		this.closed = true;
		try {
			this.socket.destroy();
		} catch {
			/* already gone */
		}
		this.emit("close");
	}

	#finish() {
		if (this.closed) return;
		this.closed = true;
		this.emit("close");
	}

	#writeFrame(opcode, payload) {
		const length = payload.length;
		let header;
		if (length < 126) {
			header = Buffer.alloc(2);
			header[1] = length;
		} else if (length < 65536) {
			header = Buffer.alloc(4);
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		header[0] = 0x80 | opcode;
		try {
			this.socket.write(Buffer.concat([header, payload]));
		} catch {
			this.destroy();
		}
	}

	#consume(chunk) {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		while (this.buffer.length >= 2) {
			const first = this.buffer[0];
			const second = this.buffer[1];
			const fin = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				const big = this.buffer.readBigUInt64BE(2);
				if (big > BigInt(MAX_MESSAGE_BYTES)) {
					this.close(1009, "frame too large");
					return;
				}
				length = Number(big);
				offset = 10;
			}
			if (length > MAX_MESSAGE_BYTES) {
				this.close(1009, "frame too large");
				return;
			}
			const maskOffset = offset;
			if (masked) offset += 4;
			if (this.buffer.length < offset + length) return;

			let payload = this.buffer.subarray(offset, offset + length);
			if (masked) {
				const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
				const unmasked = Buffer.allocUnsafe(length);
				for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ mask[i & 3];
				payload = unmasked;
			}
			this.buffer = this.buffer.subarray(offset + length);

			if (opcode === OP_CLOSE) {
				this.close(1000);
				return;
			}
			if (opcode === OP_PING) {
				this.#writeFrame(OP_PONG, payload);
				continue;
			}
			if (opcode === OP_PONG) continue;
			if (opcode === OP_BINARY) {
				this.close(1003, "binary frames unsupported");
				return;
			}
			if (opcode === OP_TEXT || opcode === OP_CONT) {
				if (opcode === OP_TEXT) {
					this.fragments = [payload];
					this.fragmentBytes = payload.length;
					this.fragmentOpcode = OP_TEXT;
				} else {
					if (this.fragmentOpcode !== OP_TEXT) {
						this.close(1002, "unexpected continuation");
						return;
					}
					this.fragments.push(payload);
					this.fragmentBytes += payload.length;
				}
				if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
					this.close(1009, "message too large");
					return;
				}
				if (fin) {
					const text = Buffer.concat(this.fragments).toString("utf8");
					this.fragments = [];
					this.fragmentBytes = 0;
					this.fragmentOpcode = 0;
					this.emit("message", text);
				}
			}
		}
	}
}

/**
 * Attach a WebSocket upgrade handler to an existing `http.Server`.
 * @param {import("node:http").Server} server
 * @param {{path?: string, authorize?: (req: import("node:http").IncomingMessage) => boolean, onConnection: (conn: WsConnection, req: import("node:http").IncomingMessage) => void}} options
 */
export function attachWebSocket(server, { path = "/ws", authorize, onConnection }) {
	const sockets = new Set();
	server.on("upgrade", (req, socket) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== path) {
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		if (authorize && !authorize(req)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
			socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		const accept = createHash("sha1").update(key + GUID).digest("base64");
		socket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${accept}`,
				"\r\n",
			].join("\r\n"),
		);
		const conn = new WsConnection(socket, null);
		sockets.add(conn);
		conn.on("close", () => sockets.delete(conn));
		onConnection(conn, req);
	});

	return {
		get size() {
			return sockets.size;
		},
		broadcast(value) {
			const text = JSON.stringify(value);
			for (const conn of sockets) conn.send(text);
		},
		closeAll(code = 1001, reason = "server shutdown") {
			for (const conn of [...sockets]) conn.close(code, reason);
			sockets.clear();
		},
	};
}
