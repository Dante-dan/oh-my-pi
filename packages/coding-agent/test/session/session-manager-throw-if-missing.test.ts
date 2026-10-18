import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("SessionManager.open with throwIfMissing", () => {
	it("repeated oversized resumes preserve the transcript and allow a fresh session", async () => {
		const root = makeTempDir("@pi-open-oversized-");
		const file = path.join(root, "oversized.jsonl");
		const header = JSON.stringify({ type: "session", version: 3, id: "large", timestamp: "t", cwd: root });
		await Bun.write(file, `${header}\n`);
		// Isolate the guard limit from inherited user configuration and keep the fixture small.
		const maxBytes = 1024;
		const limit = spyOn(sessionLoader, "sessionResumeLoadLimit").mockReturnValue(maxBytes);
		try {
			await fs.truncate(file, maxBytes + 1);
			const before = await fs.stat(file);
			for (let attempt = 0; attempt < 2; attempt++) {
				await expect(SessionManager.open(file)).rejects.toThrow(/transcript was not modified/);
			}
			const after = await fs.stat(file);
			expect(after.size).toBe(before.size);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			const fresh = await SessionManager.open(path.join(root, "fresh.jsonl"), root, undefined, { initialCwd: root });
			try {
				expect(fresh.getSessionId()).not.toBe("large");
				await expect(fresh.setSessionFile(file)).rejects.toThrow(/exceeding.*load limit/);
				expect(fresh.getSessionFile()).toBe(path.join(root, "fresh.jsonl"));
				expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
			} finally {
				await fresh.close();
			}
		} finally {
			limit.mockRestore();
		}
	});

	it("rejects a missing file without creating it", async () => {
		const root = makeTempDir("@pi-open-throw-missing-");
		const missing = path.join(root, "missing.jsonl");

		await expect(SessionManager.open(missing, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
			/ENOENT/,
		);
		// Fail closed means no phantom session is materialized at the requested path.
		expect(await Bun.file(missing).exists()).toBe(false);
	});

	it("still mints at a missing path when the flag is omitted, keeping --session working", async () => {
		const root = makeTempDir("@pi-open-mint-default-");
		const fresh = path.join(root, "fresh.jsonl");

		const manager = await SessionManager.open(fresh, undefined, undefined, { initialCwd: root });
		expect(manager.getSessionFile()).toBe(path.resolve(fresh));
		expect(await Bun.file(fresh).exists()).toBe(true);
		await manager.close();
	});

	it("rejects an existing but empty file instead of rewriting it", async () => {
		const root = makeTempDir("@pi-open-throw-empty-");
		const empty = path.join(root, "empty.jsonl");
		await Bun.write(empty, "");

		await expect(SessionManager.open(empty, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
			/holds no entries/,
		);
		expect(await Bun.file(empty).text()).toBe("");
	});
});
