import type { AssistantMessage, ThinkingContent } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "../tui";
import type { Theme } from "../theme/theme";
import type { CustomMessage, HookMessage } from "./messages";

export type ExtensionUiComponent = Component & { dispose?(): void };

export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;

export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export interface AssistantThinkingRenderContext {
	/** Timestamp anchors streaming state; responseId may arrive only on finalization. */
	message: Readonly<Pick<AssistantMessage, "timestamp" | "responseId" | "api" | "provider" | "model">>;
	/** Provider-native identifiers may be absent; fall back to the block indexes. */
	content: Readonly<Pick<ThinkingContent, "itemId" | "thinkingSignature">>;
	contentIndex: number;
	thinkingIndex: number;
	/** Full current trimmed snapshot. Renderers may memoize expensive work across updates. */
	text: string;
	requestRender(): void;
}

/** Bare components append. The first successful replacement owns the default thinking body. */
export type AssistantThinkingRenderResult =
	| Component
	| { type: "append"; component: Component }
	| { type: "replace"; component: Component }
	| undefined;

export type AssistantThinkingRenderer = (
	context: AssistantThinkingRenderContext,
	theme: Theme,
) => AssistantThinkingRenderResult;

export interface HookMessageRenderOptions {
	/** Whether the view is expanded */
	expanded: boolean;
}

/**
 * Renderer for hook messages.
 * Hooks register these to provide custom TUI rendering for their message types.
 */
export type HookMessageRenderer<T = unknown> = (
	message: HookMessage<T>,
	options: HookMessageRenderOptions,
	theme: Theme,
) => Component | undefined;
