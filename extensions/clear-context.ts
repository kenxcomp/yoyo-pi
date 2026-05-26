/**
 * Clear/restore context snapshots.
 *
 * /clear
 *   Saves the current branch context to .tmp/<random>.jsonl, then starts a new empty session.
 *
 * /restore <name>
 *   Restores .tmp/<name>.jsonl into a fresh session file and switches to it.
 *   /resume remains pi's built-in session picker.
 */

import { randomBytes, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionHeader } from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const SNAPSHOT_DIR = ".tmp";
const SNAPSHOT_EXT = ".jsonl";
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9_-]+$/;

function snapshotDir(cwd: string): string {
	return path.resolve(cwd, SNAPSHOT_DIR);
}

function snapshotPath(cwd: string, name: string): string {
	return path.join(snapshotDir(cwd), `${name}${SNAPSHOT_EXT}`);
}

function randomName(): string {
	return randomBytes(5).toString("hex");
}

function normalizeSnapshotName(raw: string): string | undefined {
	const firstArg = raw.trim().split(/\s+/)[0] ?? "";
	const name = firstArg.endsWith(SNAPSHOT_EXT) ? firstArg.slice(0, -SNAPSHOT_EXT.length) : firstArg;
	if (!name || !SNAPSHOT_NAME_RE.test(name)) return undefined;
	return name;
}

async function createUniqueSnapshotPath(cwd: string): Promise<{ name: string; filePath: string }> {
	await fsp.mkdir(snapshotDir(cwd), { recursive: true });

	for (let i = 0; i < 100; i++) {
		const name = randomName();
		const filePath = snapshotPath(cwd, name);
		try {
			await fsp.access(filePath);
		} catch {
			return { name, filePath };
		}
	}

	throw new Error("Failed to generate a unique snapshot name");
}

async function saveCurrentBranch(ctx: ExtensionCommandContext): Promise<{ name: string; filePath: string; entryCount: number }> {
	const { name, filePath } = await createUniqueSnapshotPath(ctx.cwd);
	const now = new Date().toISOString();
	const currentFile = ctx.sessionManager.getSessionFile();
	const currentHeader = ctx.sessionManager.getHeader();

	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: randomUUID(),
		timestamp: now,
		cwd: currentHeader?.cwd ?? ctx.cwd,
		...(currentFile ? { parentSession: currentFile } : {}),
	};

	const entries = ctx.sessionManager.getBranch();
	const content = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	await fsp.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });

	return { name, filePath, entryCount: entries.length };
}

async function materializeSnapshot(snapshotFile: string, ctx: ExtensionCommandContext): Promise<string> {
	const raw = await fsp.readFile(snapshotFile, "utf8");
	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length === 0) {
		throw new Error(`Snapshot is empty: ${snapshotFile}`);
	}

	const first = JSON.parse(lines[0]!) as SessionHeader;
	if (first.type !== "session") {
		throw new Error(`Snapshot is not a pi session file: ${snapshotFile}`);
	}

	const id = randomUUID();
	const now = new Date().toISOString();
	const header: SessionHeader = {
		...first,
		version: first.version ?? CURRENT_SESSION_VERSION,
		id,
		timestamp: now,
		cwd: ctx.cwd,
		parentSession: snapshotFile,
	};
	lines[0] = JSON.stringify(header);

	const sessionDir = ctx.sessionManager.getSessionDir() || snapshotDir(ctx.cwd);
	await fsp.mkdir(sessionDir, { recursive: true });
	const destPath = path.join(sessionDir, `${now.replace(/[:.]/g, "-")}_${id}${SNAPSHOT_EXT}`);
	await fsp.writeFile(destPath, lines.join("\n") + "\n", { encoding: "utf8", flag: "wx" });
	return destPath;
}

export default function clearContextExtension(pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Save current context to .tmp/<name>.jsonl and start a clean session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const snapshot = await saveCurrentBranch(ctx);
			const shortPath = path.join(SNAPSHOT_DIR, `${snapshot.name}${SNAPSHOT_EXT}`);

			const result = await ctx.newSession({
				parentSession: snapshot.filePath,
				withSession: async (newCtx) => {
					newCtx.ui.notify(`Context saved to ${shortPath}. Restore with /restore ${snapshot.name}`, "info");
				},
			});

			if (result.cancelled) {
				ctx.ui.notify(`Context saved to ${shortPath}, but clearing was cancelled.`, "warning");
			}
		},
	});

	pi.registerCommand("restore", {
		description: "Restore a /clear snapshot by name: /restore <name>",
		handler: async (args, ctx) => {
			const name = normalizeSnapshotName(args);
			if (!name) {
				ctx.ui.notify("Usage: /restore <snapshot-name>", "warning");
				return;
			}

			await ctx.waitForIdle();

			const sourcePath = snapshotPath(ctx.cwd, name);
			try {
				await fsp.access(sourcePath);
			} catch {
				ctx.ui.notify(`No snapshot found at ${path.join(SNAPSHOT_DIR, `${name}${SNAPSHOT_EXT}`)}`, "error");
				return;
			}

			const restorePath = await materializeSnapshot(sourcePath, ctx);
			const result = await ctx.switchSession(restorePath, {
				withSession: async (newCtx) => {
					newCtx.ui.notify(`Restored context from ${path.join(SNAPSHOT_DIR, `${name}${SNAPSHOT_EXT}`)}`, "info");
				},
			});

			if (result.cancelled) {
				await fsp.rm(restorePath, { force: true });
				ctx.ui.notify("Restore cancelled.", "warning");
			}
		},
	});
}
