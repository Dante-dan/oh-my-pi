import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

const outputPath = Bun.env.OMP_TITLE_PROBE_PATH;
if (!outputPath) {
	throw new Error("OMP_TITLE_PROBE_PATH is required");
}

let generatedFrom: string | undefined;

AgentSession.prototype.generateTitle = (firstMessage: string): Promise<string | null> => {
	generatedFrom = firstMessage;
	return Promise.resolve("CLI Initial Title");
};

const setSessionName = SessionManager.prototype.setSessionName;
SessionManager.prototype.setSessionName = async function (name, source, trigger) {
	const changed = await setSessionName.call(this, name, source, trigger);
	if (changed) {
		await Bun.write(outputPath, JSON.stringify({ generatedFrom, sessionName: this.getSessionName() }));
		process.exit(0);
	}
	return changed;
};

AgentSession.prototype.prompt = async function (): Promise<boolean> {
	return true;
};
