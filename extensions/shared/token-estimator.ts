import { estimateTokenCount, type TokenEstimationOptions } from "tokenx";

export function estimateTokens(text: string, options?: TokenEstimationOptions): number {
	if (!text) return 0;
	return options ? estimateTokenCount(text, options) : estimateTokenCount(text);
}
