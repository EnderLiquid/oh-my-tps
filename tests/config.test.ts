import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../extensions/shared/config.js";

function writeConfig(contents?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "oh-my-tps-"));
	const path = join(dir, "oh-my-tps.json");
	if (contents !== undefined) writeFileSync(path, contents, "utf-8");
	return path;
}

test("文件不存在时静默使用默认配置", () => {
	const result = loadConfig(writeConfig());
	assert.deepEqual(result.config, DEFAULT_CONFIG);
	assert.deepEqual(result.warnings, []);
});

test("合法配置覆盖默认值", () => {
	const result = loadConfig(writeConfig(JSON.stringify({ builtinRenderer: { enabled: false, color: "muted" } })));
	assert.deepEqual(result.config.builtinRenderer, { enabled: false, color: "muted" });
	assert.deepEqual(result.warnings, []);
});

test("只写部分字段时其余保持默认", () => {
	const result = loadConfig(writeConfig(JSON.stringify({ builtinRenderer: { color: "accent" } })));
	assert.deepEqual(result.config.builtinRenderer, { enabled: true, color: "accent" });
	assert.deepEqual(result.warnings, []);
});

test("JSON 非法时回落默认配置并给出警告", () => {
	const result = loadConfig(writeConfig("{ not json"));
	assert.deepEqual(result.config, DEFAULT_CONFIG);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0]!, /invalid JSON/);
});

test("顶层不是对象时回落默认配置", () => {
	const result = loadConfig(writeConfig("[1, 2, 3]"));
	assert.deepEqual(result.config, DEFAULT_CONFIG);
	assert.equal(result.warnings.length, 1);
});

test("字段类型非法时逐项回落并给出警告", () => {
	const result = loadConfig(writeConfig(JSON.stringify({ builtinRenderer: { enabled: "yes", color: 42 } })));
	assert.deepEqual(result.config, DEFAULT_CONFIG);
	assert.equal(result.warnings.length, 2);
});

test("颜色名的合法性不在本层校验，原样透传", () => {
	const result = loadConfig(writeConfig(JSON.stringify({ builtinRenderer: { color: "not-a-color" } })));
	assert.equal(result.config.builtinRenderer.color, "not-a-color");
	assert.deepEqual(result.warnings, []);
});
