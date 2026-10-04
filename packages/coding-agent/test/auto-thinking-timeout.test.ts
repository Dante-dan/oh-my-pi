import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as classifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgProvidersAutoThinkingTimeoutMs } from "@oh-my-pi/pi-coding-agent/session/settings";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";

afterEach(() => vi.restoreAllMocks());

function controls(settings: Settings): ModelControls {
	const model = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!model) throw new Error("Expected bundled Claude Sonnet 4.6");
	return new ModelControls(
		{
			settings,
			agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {}, metadataForProvider: () => undefined },
			model: () => model,
			promptGeneration: () => 0,
			sessionId: () => "auto-thinking-timeout",
			sessionManager: SessionManager.inMemory(),
			magicKeywordEnabled: () => false,
			emit: () => {},
		} as unknown as ModelControlsHost,
		{ thinkingLevel: AUTO_THINKING },
	);
}

function slowClassifier(): { aborted: () => boolean } {
	let aborted = false;
	vi.spyOn(classifier, "classifyDifficulty").mockImplementation(async (_request, options) => {
		const pending = Promise.withResolvers<Effort | undefined>();
		options.signal?.addEventListener(
			"abort",
			() => {
				aborted = true;
				pending.reject(new Error("classification aborted"));
			},
			{ once: true },
		);
		return pending.promise;
	});
	return { aborted: () => aborted };
}

describe("auto-thinking classification timeout", () => {
	it("bounds an unconfigured slow judge and retains provisional effort", async () => {
		const session = controls(Settings.isolated());
		const provisional = session.thinkingLevel;
		const judge = slowClassifier();
		const started = performance.now();
		await session.applyAutoThinkingLevel("slow judge", 0);
		expect(performance.now() - started).toBeGreaterThanOrEqual(3900);
		expect(judge.aborted()).toBe(true);
		expect(session.thinkingLevel).toBe(provisional);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	}, 6000);

	it("allows a judge to finish under a longer configured budget", async () => {
		const settings = Settings.isolated({ providers: { autoThinkingTimeoutMs: 6000 } });
		const session = controls(settings);
		vi.spyOn(classifier, "classifyDifficulty").mockImplementation(async (_request, options) => {
			await Bun.sleep(4500);
			expect(options.signal?.aborted).toBe(false);
			return Effort.Low;
		});
		await session.applyAutoThinkingLevel("judge with latency", 0);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("uses a live timeout change, aborting the judge without losing the previous resolution", async () => {
		const settings = Settings.isolated();
		const session = controls(settings);
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		await session.applyAutoThinkingLevel("first turn", 0);
		cfgProvidersAutoThinkingTimeoutMs.set(settings, 20);
		const judge = slowClassifier();
		await session.applyAutoThinkingLevel("next slow turn", 0);
		expect(judge.aborted()).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		"rejects unsafe timer input %s instead of silently aborting immediately",
		value => {
			const settings = Settings.isolated();
			expect(() => cfgProvidersAutoThinkingTimeoutMs.set(settings, value)).toThrow("integer between");
		},
	);
});
