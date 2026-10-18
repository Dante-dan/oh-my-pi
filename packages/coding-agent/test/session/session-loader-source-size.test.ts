import { describe, expect, it } from "bun:test";
import { loadSessionFile, sessionResumeLoadLimit } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs";

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

	it("refuses a journal that grows past the cap after stat, including a small-file load", async () => {
		const dir = TempDir.createSync("@loader-growing-size-");
		try {
			const file = `${dir.path()}/growing.jsonl`;
			const original = `${HEADER}\n`;
			const appended = `${LINE}\n${LINE}\n`;
			await Bun.write(file, original);
			class GrowingStorage extends FileSessionStorage {
				override statSync(path: string) {
					const before = super.statSync(path);
					fs.appendFileSync(path, appended);
					return before;
				}
			}
			await expect(
				loadSessionFile(file, new GrowingStorage(), { maxBytes: Buffer.byteLength(original, "utf8") }),
			).rejects.toThrow(/exceeding.*load limit/);
			expect(await Bun.file(file).text()).toBe(original + appended);
			const exactSize = Buffer.byteLength(original + appended, "utf8");
			const complete = await loadSessionFile(file, new FileSessionStorage(), { maxBytes: exactSize });
			expect(complete.entries.map(entry => entry.id)).toEqual(["s1", "m1", "m1"]);
			expect(complete.sourceSize).toBe(exactSize);
		} finally {
			await dir.remove();
		}
	});

	it("refuses a non-file backend's grown snapshot before parsing it", async () => {
		const storage = new SkewedStorage();
		const content = `${HEADER}\n${LINE}\n`;
		storage.writeTextSync("/s/grown.jsonl", content);
		await expect(
			loadSessionFile("/s/grown.jsonl", storage, { maxBytes: storage.statSync("/s/grown.jsonl").size }),
		).rejects.toThrow(/exceeding.*load limit/);
		expect(await storage.readText("/s/grown.jsonl")).toBe(content);
	});

	it("invalid exponential and unsafe-integer overrides do not become tiny resume limits", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync("/s/override.jsonl", `${HEADER}\n${LINE}\n`);
		const exponential = await loadSessionFile("/s/override.jsonl", storage, {
			maxBytes: sessionResumeLoadLimit("1e9"),
		});
		expect(exponential.entries.map(entry => entry.id)).toEqual(["s1", "m1"]);
		const unsafe = await loadSessionFile("/s/override.jsonl", storage, {
			maxBytes: sessionResumeLoadLimit("9007199254740992"),
		});
		expect(unsafe.entries.map(entry => entry.id)).toEqual(["s1", "m1"]);
		await expect(
			loadSessionFile("/s/override.jsonl", storage, { maxBytes: sessionResumeLoadLimit("1") }),
		).rejects.toThrow(/exceeding.*load limit/);
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
