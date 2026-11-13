/**
 * Single-instance lock and orphan prevention.
 *
 * Two failure modes this closes:
 *
 * 1. Two HUDs against one cwd, each spawning an agent that edits the same files.
 * 2. A HUD that dies (or is SIGKILLed) leaving a live `omp --mode rpc` child
 *    whose transcript keeps running with nobody attached. The child is told to
 *    die with us on several independent paths, because a `bash` parent can be
 *    replaced or the process can be signalled from outside.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Acquire an exclusive lock file. Stale locks (dead pid) are reclaimed; a live
 * lock is reported rather than stolen.
 *
 * @param {string} path
 * @returns {{ok: true, release: () => void, reclaimed: boolean} | {ok: false, holder: number|null, error: string}}
 */
export function acquireLock(path) {
	mkdirSync(dirname(path), { recursive: true });

	function readHolder() {
		try {
			const raw = readFileSync(path, "utf8").trim();
			const pid = Number.parseInt(raw.split(/\s+/)[0], 10);
			return Number.isFinite(pid) ? pid : null;
		} catch {
			return null;
		}
	}

	function alive(pid) {
		// Our own pid counts as alive: a second acquire in the same process is
		// contention, not a stale lock. Treating self as dead would let a caller
		// steal a lock it already holds, which then leaks the original handle.
		if (!pid) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error.code === "EPERM";
		}
	}

	let reclaimed = false;
	if (existsSync(path)) {
		const holder = readHolder();
		if (alive(holder)) return { ok: false, holder, error: `another instance is running (pid ${holder})` };
		reclaimed = true;
		try {
			unlinkSync(path);
		} catch {
			/* racing instance removed it first; the open below decides */
		}
	}

	let fd;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (error) {
		if (error.code === "EEXIST") {
			return { ok: false, holder: readHolder(), error: "another instance won the lock race" };
		}
		throw error;
	}
	writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
	closeSync(fd);

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			const holder = readHolder();
			if (holder === process.pid) unlinkSync(path);
		} catch {
			/* already gone */
		}
	};

	return { ok: true, release, reclaimed };
}

/**
 * Wire every available mechanism so a spawned agent cannot outlive this process.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {{name?: string, onOrphan?: () => void}} [options]
 * @returns {{disarm: () => void}}
 */
export function guardChild(child, options = {}) {
	const onOrphan = options.onOrphan ?? (() => {});
	const cleanups = [];

	// 1. stdin EOF is omp's documented shutdown path: closing it drains accepted
	//    commands, disposes the session, and exits. That is the primary guard
	//    because it needs no signal handling and cannot be missed by a trapped
	//    SIGTERM. Signals below are the backup for a child wedged mid-turn.
	const kill = signal => {
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill(signal);
		} catch {
			/* already gone */
		}
	};

	// 2. Signals: close stdin first so the child takes its documented exit path,
	//    then escalate if it does not leave.
	const onExit = () => {
		try {
			child.stdin?.end();
		} catch {
			/* stdin already closed */
		}
		kill("SIGTERM");
	};
	process.on("exit", onExit);
	cleanups.push(() => process.off("exit", onExit));

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
		const handler = () => {
			onOrphan();
			kill("SIGTERM");
		};
		process.on(signal, handler);
		cleanups.push(() => process.off(signal, handler));
	}

	// 3. If we are orphaned but still alive (parent re-parented), exit rather
	//    than drift: a console with no controlling terminal serves nobody.
	const parentAtStart = process.ppid;
	const orphanWatch = setInterval(() => {
		if (process.ppid !== parentAtStart && process.ppid === 1) {
			onOrphan();
			kill("SIGTERM");
			clearInterval(orphanWatch);
		}
	}, 5000);
	orphanWatch.unref?.();
	cleanups.push(() => clearInterval(orphanWatch));

	child.once("exit", () => {
		for (const cleanup of cleanups) cleanup();
	});

	return {
		disarm() {
			for (const cleanup of cleanups) cleanup();
		},
	};
}
