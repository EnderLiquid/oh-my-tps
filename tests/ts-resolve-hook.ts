/**
 * Node 解析钩子：把扩展源码里的 `./x.js` 说明符指向同目录的 `./x.ts`。
 *
 * 扩展由 Pi 用 jiti 加载，而 jiti 支持 TypeScript 的 NodeNext 写法
 * （源码写 `.js`，实际解析到 `.ts`）。Node 原生类型剥离不支持这一点，
 * 因此测试通过 `node --import ./tests/ts-resolve-hook.ts --test` 运行。
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
			const url = new URL(specifier, context.parentURL);
			const tsUrl = new URL(url.href.replace(/\.js$/, ".ts"));
			if (existsSync(fileURLToPath(tsUrl))) {
				return { url: tsUrl.href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	},
});
