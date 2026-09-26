import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SETUP_VERSION } from "@oh-my-pi/pi-tui/setup/setup-version";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const probeEntry = path.join(import.meta.dir, "fixtures", "cli-initial-title-probe.ts");

describe.skipIf(process.platform === "win32")("CLI initial-message title generation", () => {
	test("generates a title for the positional initial message", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-title-"));
		const agentDir = path.join(root, "agent");
		const outputPath = path.join(root, "probe.json");
		try {
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(
				path.join(agentDir, "config.yml"),
				`setupVersion: ${CURRENT_SETUP_VERSION}\nstartup:\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\nproviders:\n  tinyModel: online\n`,
			);
			let terminalOutput = "";
			await using terminal = new Bun.Terminal({
				cols: 120,
				rows: 30,
				data(_terminal, data) {
					terminalOutput = (terminalOutput + new TextDecoder().decode(data)).slice(-8192);
				},
			});
			const proc = Bun.spawn(
				[
					process.execPath,
					"--preload",
					probeEntry,
					cliEntry,
					"--no-session",
					"--model",
					"anthropic/claude-sonnet-4-5",
					"implement X",
				],
				{
					cwd: repoRoot,
					terminal,
					env: {
						...process.env,
						HOME: root,
						NO_COLOR: "1",
						OMP_TITLE_PROBE_PATH: outputPath,
						PI_CODING_AGENT_DIR: agentDir,
						PI_NO_TITLE: "",
						TERM: "xterm-256color",
					},
				},
			);
			// A real CLI child cannot use fake timers; bound a stalled startup and kill it
			// before Bun's test deadline so failure includes the terminal's last output.
			let timedOut = false;
			const deadline = setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, 25_000);
			let exitCode: number;
			try {
				exitCode = await proc.exited;
			} finally {
				clearTimeout(deadline);
				proc.kill();
			}

			expect({ timedOut, exitCode, terminalOutput }).toMatchObject({ timedOut: false, exitCode: 0 });
			expect(await Bun.file(outputPath).text()).toBe(
				JSON.stringify({ generatedFrom: "implement X", sessionName: "CLI Initial Title" }),
			);
		} finally {
			await removeWithRetries(root);
		}
	}, 30_000);
});
