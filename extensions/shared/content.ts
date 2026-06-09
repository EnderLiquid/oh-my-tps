export type AssistantContentBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	args?: unknown;
};

export function collectAssistantText(message: { content?: AssistantContentBlock[] }): string {
	let text = "";
	for (const block of message.content ?? []) {
		if (block.type === "text") {
			text += block.text ?? "";
			continue;
		}
		if (block.type === "thinking") {
			text += block.thinking ?? "";
			continue;
		}
		if (block.type === "toolCall") {
			text += block.name ?? "";
			text += JSON.stringify(block.args ?? "");
		}
	}
	return text;
}
