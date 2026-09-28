/** Actions supported by the Hub's per-agent message editor. */
export interface HubMessageSession {
	prompt(text: string, options: { streamingBehavior: "steer" }): Promise<unknown>;
	compact(): Promise<unknown>;
}

/** A bare /compact is an agent command, not a prompt for the model to interpret. */
export function sendHubMessage(session: HubMessageSession, text: string): Promise<unknown> {
	if (text === "/compact") return session.compact();
	return session.prompt(text, { streamingBehavior: "steer" });
}
