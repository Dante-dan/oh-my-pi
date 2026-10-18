import { describe, expect, it } from "bun:test";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Storage whose stat lags its content, simulating an interleaving appender. */
class SkewedStorage extends MemorySessionStorage {
	override statSync(path: string) {
		const stat = super.statSync(path);
		return { ...stat, size: Math.max(0, stat.size - 12) };
	}
}

const HEADER = JSON.stringify({ type: "session", id: "s1", version: 1, timestamp: "t", cwd: "/c" });
const LINE = JSON.stringify({ type: "message", id: "m1" });

describe("loadSessionFile sourceSize", () => {
	it("describes the snapshot actually read, not the pre-read stat", async () => {
		const storage = new SkewedStorage();
		const content = `${HEADER}\n${LINE}\n`;
		storage.writeTextSync("/s/l.jsonl", content);

		const loaded = await loadSessionFile("/s/l.jsonl", storage);
		expect(loaded.entries.length).toBeGreaterThan(0);
		expect(loaded.sourceSize).toBe(Buffer.byteLength(content, "utf8"));
	});

	it("refuses an oversized full load without reading or changing the journal", async () => {
		const storage = new MemorySessionStorage();
		const content = `${HEADER}\n${LINE}\n`;
		storage.writeTextSync("/s/limited.jsonl", content);
		const size = Buffer.byteLength(content, "utf8");

		await expect(loadSessionFile("/s/limited.jsonl", storage, { maxBytes: size - 1 })).rejects.toThrow(
			/exceeding.*load limit/,
		);
		expect(await storage.readText("/s/limited.jsonl")).toBe(content);
		const loaded = await loadSessionFile("/s/limited.jsonl", storage, { maxBytes: size });
		expect(loaded.entries.map(entry => entry.id)).toEqual(["s1", "m1"]);
	});

	it("stays null when the path does not exist", async () => {
		const dir = TempDir.createSync("@loader-source-size-");
		try {
			const storage = new FileSessionStorage();
			const loaded = await loadSessionFile(`${dir.path()}/missing.jsonl`, storage);
			expect(loaded.sourceSize).toBeNull();
			expect(loaded.entries).toEqual([]);
		} finally {
			await dir.remove();
		}
	});
});
