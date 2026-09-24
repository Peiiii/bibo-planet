import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SpiritRuntime } from "../src/server/spirit-runtime.ts";
import { WorldStore } from "../src/server/world-store.ts";

test("different visitors share encounters without sharing private dialogue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-runtime-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    const runs: Array<Array<Record<string, unknown>>> = [];
    const runtime = new SpiritRuntime(store, async (input) => {
      runs.push(input.messages);
      return {
        content:
          runs.length === 1 ? "我记得蓝色月亮。" : "之前有人提到蓝色月亮。",
        toolCalls: [],
        finishReason: "stop",
        usage: { totalTokens: 73 },
      };
    });
    await runtime.start();
    const first = await runtime.talk("mori", "alice", "我的秘密是蓝色月亮");
    const second = await runtime.talk("mori", "bob", "有人说过什么吗？");
    assert.equal(first.spent, 73);
    assert.equal(first.usageKind, "reported");
    assert.equal(second.spent, 73);
    assert.match(String(runs[1]?.[0]?.content), /蓝色月亮/);
    assert.equal(runs[1]?.length, 2);
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
    const runtime = new SpiritRuntime(store, async () => ({
      content: text,
      toolCalls: [],
      finishReason: "stop",
      usage: {},
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

test("the same visitor can continue a multi-turn conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-multiturn-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    const turns: Array<Array<Record<string, unknown>>> = [];
    const runtime = new SpiritRuntime(store, async (input) => {
      turns.push(input.messages);
      return {
        content: turns.length === 1 ? "第一句话" : "第二句话",
        toolCalls: [],
        finishReason: "stop",
        usage: {},
      };
    });

    await runtime.talk("sela", "alice", "第一轮");
    await runtime.talk("sela", "alice", "第二轮");

    assert.equal(turns[1]?.[1]?.content, "第一轮");
    assert.equal(turns[1]?.[2]?.content, "第一句话");
    assert.equal(store.conversation("sela", "alice").length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a later visitor can cue an older shared memory without seeing private history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-runtime-recall-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    await store.recordTurn({
      spiritId: "sela",
      visitorId: "alice",
      message: "小星球的暗号是蓝色风铃",
      reply: "蓝色风铃，我会记得。",
      spent: 20,
      usageKind: "reported",
    });
    for (let index = 0; index < 11; index += 1) {
      await store.recordTurn({
        spiritId: "sela",
        visitorId: `visitor-${index}`,
        message: `普通访问编号${index}`,
        reply: "下次见。",
        spent: 20,
        usageKind: "reported",
      });
    }
    let system = "";
    const runtime = new SpiritRuntime(store, async (input) => {
      system = String(input.messages[0]?.content);
      return {
        content: "我还记得那只蓝色风铃。",
        toolCalls: [],
        finishReason: "stop",
        usage: { totalTokens: 80 },
      };
    });
    await runtime.talk("sela", "bob", "你还记得蓝色风铃吗？");
    assert.match(system, /更早共同遭遇/);
    assert.match(system, /蓝色风铃/);
    assert.equal(store.conversation("sela", "bob").length, 2);
    assert.equal(store.conversation("sela", "alice").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
