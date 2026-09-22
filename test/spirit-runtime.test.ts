import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NextclawTaskResult } from "@nextclaw/harness";
import { SpiritRuntime } from "../src/server/spirit-runtime.ts";
import { WorldStore } from "../src/server/world-store.ts";

test("different visitors use distinct sessions and share prior encounters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-runtime-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    const runs: Array<{ input: string; agentId: string; sessionId: string }> =
      [];
    const runtime = new SpiritRuntime(store, async (input) => {
      runs.push(input);
      return {
        schemaVersion: "nextclaw.task/v1",
        status: "completed",
        kind: "agent",
        agentId: input.agentId,
        sessionId: input.sessionId,
        runId: "run-1",
        text: runs.length === 1 ? "我记得蓝色月亮。" : "之前有人提到蓝色月亮。",
        completedMessage: {
          metadata: { ai_execution: { usage: { totalTokens: 73 } } },
        } as unknown as NextclawTaskResult["completedMessage"],
      };
    });
    await runtime.start();
    const first = await runtime.talk("mori", "alice", "我的秘密是蓝色月亮");
    const second = await runtime.talk("mori", "bob", "有人说过什么吗？");
    assert.equal(first.spent, 73);
    assert.equal(first.usageKind, "reported");
    assert.equal(second.spent, 73);
    assert.notEqual(runs[0]?.sessionId, runs[1]?.sessionId);
    assert.equal(runs[0]?.agentId, "mori");
    assert.match(runs[1]!.input, /蓝色月亮/);
    assert.equal(store.conversation("mori", "bob").length, 2);
    assert.equal(store.conversation("mori", "alice").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unreported usage is estimated and invalid empty responses are not recorded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-usage-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    let text = "这是一个真实模型的回复";
    const runtime = new SpiritRuntime(store, async (input) => ({
      schemaVersion: "nextclaw.task/v1",
      status: "completed",
      kind: "agent",
      agentId: input.agentId,
      sessionId: input.sessionId,
      runId: "run-1",
      text,
      completedMessage: null,
    }));
    const first = await runtime.talk("piko", "alice", "你好");
    assert.equal(first.usageKind, "estimated");
    assert.ok(first.spent > 0);
    text = "";
    await assert.rejects(runtime.talk("piko", "alice", "再说一遍"), /有效回复/);
    assert.equal(store.conversation("piko", "alice").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
