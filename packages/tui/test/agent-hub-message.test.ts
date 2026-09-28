import { describe, expect, it, mock } from "bun:test";
import { sendHubMessage } from "../src/overlays/agent-hub-message";

describe("Hub agent messages", () => {
	it("compacts the selected agent instead of asking its model to interpret /compact", async () => {
		const session = { prompt: mock(async () => {}), compact: mock(async () => {}) };
		await sendHubMessage(session, "/compact");
		expect(session.compact).toHaveBeenCalledTimes(1);
		expect(session.prompt).not.toHaveBeenCalled();

		await sendHubMessage(session, "Continue investigating");
		expect(session.prompt).toHaveBeenCalledWith("Continue investigating", { streamingBehavior: "steer" });
	});
});
