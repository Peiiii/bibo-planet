import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SpiritRuntime } from "../src/server/spirit-runtime.ts";
import { WorldStore } from "../src/server/world-store.ts";

test("each real Agent boots with one active provider and no copied literal key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-agent-config-test-"));
  const environment = {
    BIBO_MODEL: process.env.BIBO_MODEL,
    BIBO_API_KEY: process.env.BIBO_API_KEY,
    BIBO_NEXTCLAW_CONFIG: process.env.BIBO_NEXTCLAW_CONFIG,
    BIBO_AGENT_RUNTIME_DIR: process.env.BIBO_AGENT_RUNTIME_DIR,
  };
  process.env.BIBO_MODEL = "deepseek/deepseek-flash";
  process.env.BIBO_API_KEY = "test-only-provider-key";
  delete process.env.BIBO_NEXTCLAW_CONFIG;
  process.env.BIBO_AGENT_RUNTIME_DIR = join(dir, "runtime");
  const store = new WorldStore(join(dir, "data"));
  const runtime = new SpiritRuntime(store);
  try {
    await store.initialize();
    await runtime.start();
    const [runDirectory] = await readdir(join(dir, "runtime"));
    assert.ok(runDirectory);
    const runtimeFiles = await readdir(join(dir, "runtime", runDirectory));
    assert.deepEqual(runtimeFiles, ["configs"]);
    for (const spiritId of ["mori", "piko", "sela"] as const) {
      const raw = await readFile(
        join(dir, "runtime", runDirectory, "configs", `${spiritId}.json`),
        "utf8",
      );
      const config = JSON.parse(raw) as {
        agents: { list: Array<{ id: string }> };
        providers: Record<string, { apiKey: string }>;
        secrets: { refs: Record<string, { source: string; id: string }> };
      };
      assert.deepEqual(Object.keys(config.providers), ["deepseek", "nextclaw"]);
      assert.equal(config.providers.deepseek?.apiKey, "");
      assert.deepEqual(config.providers.nextclaw, {
        enabled: false,
        apiKey: "disabled",
      });
      assert.deepEqual(
        config.agents.list.map((agent) => agent.id),
        [spiritId],
      );
      assert.deepEqual(config.secrets.refs["providers.deepseek.apiKey"], {
        source: "env",
        id: "BIBO_API_KEY",
      });
      assert.ok(!raw.includes("test-only-provider-key"));
    }
  } finally {
    await runtime.stop();
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("model disclosure follows the configured provider instead of claiming a stale filing", () => {
  const previous = process.env.BIBO_MODEL;
  try {
    process.env.BIBO_MODEL = "deepseek/deepseek-flash";
    const deepseek = new SpiritRuntime(new WorldStore("unused"));
    assert.deepEqual(deepseek.modelDisclosure, {
      name: "DeepSeek Flash",
      filingNumber: null,
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
    });
    process.env.BIBO_MODEL = "deepseek/deepseek-chat";
    const legacy = new SpiritRuntime(new WorldStore("unused"));
    assert.deepEqual(legacy.modelDisclosure, {
      name: "deepseek/deepseek-chat",
      filingNumber: null,
      sourceUrl: null,
    });
    process.env.BIBO_MODEL = "other/unknown";
    const unknown = new SpiritRuntime(new WorldStore("unused"));
    assert.deepEqual(unknown.modelDisclosure, {
      name: "other/unknown",
      filingNumber: null,
      sourceUrl: null,
    });
  } finally {
    if (previous === undefined) delete process.env.BIBO_MODEL;
    else process.env.BIBO_MODEL = previous;
  }
});

test("different visitors share encounters without sharing private dialogue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-runtime-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    const contexts: string[] = [];
    let maxTokens = 0;
    const runtime = new SpiritRuntime(store, async (input) => {
      contexts.push(input.context);
      maxTokens = input.maxTokens;
      return {
        text:
          contexts.length === 1 ? "我记得蓝色月亮。" : "之前有人提到蓝色月亮。",
        totalTokens: 73,
      };
    });
    await runtime.start();
    const first = await runtime.talk(
      "mori",
      { id: "alice", name: "Alice" },
      "我的秘密是蓝色月亮",
    );
    const second = await runtime.talk(
      "mori",
      { id: "bob", name: "Bob" },
      "有人说过什么吗？",
    );
    assert.equal(first.spent, 73);
    assert.equal(first.usageKind, "reported");
    assert.equal(second.spent, 73);
    assert.match(contexts[1] ?? "", /蓝色月亮/);
    assert.match(contexts[1] ?? "", /"name":"Bob"/);
    assert.doesNotMatch(contexts[1] ?? "", /"name":"Alice"/);
    assert.match(contexts[1] ?? "", /不要假装自己生活在虚拟世界/);
    assert.match(contexts[1] ?? "", /不是你要模仿的说话风格/);
    assert.match(contexts[1] ?? "", /不要主动复述旧记录里的星球/);
    assert.doesNotMatch(contexts[1] ?? "", /你生活在 Bibo Planet/);
    assert.equal(maxTokens, 800);
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
      text,
      totalTokens: null,
    }));
    const first = await runtime.talk(
      "piko",
      { id: "alice", name: "Alice" },
      "你好",
    );
    assert.equal(first.usageKind, "estimated");
    assert.ok(first.spent > 0);
    text = "";
    await assert.rejects(
      runtime.talk("piko", { id: "alice", name: "Alice" }, "再说一遍"),
      /有效回复/,
    );
    assert.equal(store.conversation("piko", "alice").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopping the runtime cancels an active turn before cleaning up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-stop-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const runtime = new SpiritRuntime(store, async ({ signal }) => {
      signalStarted?.();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
      return { text: "unreachable", totalTokens: null };
    });
    const turn = runtime.talk("mori", { id: "alice", name: "Alice" }, "你好");
    const rejection = assert.rejects(turn, /cancelled/);
    await started;
    await runtime.stop();
    await rejection;
    assert.equal(store.conversation("mori", "alice").length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the same visitor can continue a multi-turn conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-multiturn-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    const turns: string[] = [];
    const runtime = new SpiritRuntime(store, async (input) => {
      turns.push(input.context);
      return {
        text: turns.length === 1 ? "第一句话" : "第二句话",
        totalTokens: null,
      };
    });

    await runtime.talk("sela", { id: "alice", name: "Alice" }, "第一轮");
    await runtime.talk("sela", { id: "alice", name: "Alice" }, "第二轮");

    assert.match(turns[1] ?? "", /第一轮/);
    assert.match(turns[1] ?? "", /第一句话/);
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
      system = input.context;
      return {
        text: "我还记得那只蓝色风铃。",
        totalTokens: 80,
      };
    });
    await runtime.talk(
      "sela",
      { id: "bob", name: "Bob" },
      "你还记得蓝色风铃吗？",
    );
    assert.match(system, /按本轮问题选取的共同记录/);
    assert.match(system, /蓝色风铃/);
    assert.equal(store.conversation("sela", "bob").length, 2);
    assert.equal(store.conversation("sela", "alice").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unrelated old world lore is not injected into a normal identity question", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-runtime-grounded-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    await store.recordTurn({
      spiritId: "mori",
      visitorId: "alice",
      message: "你是谁？你能做什么？这颗星球的精灵住在哪里？",
      reply: "精灵住在潮汐门边。",
      spent: 20,
      usageKind: "reported",
    });
    let system = "";
    const runtime = new SpiritRuntime(store, async (input) => {
      system = input.context;
      return {
        text: "我是共享 AI，可以回答问题。",
        totalTokens: 50,
      };
    });
    await runtime.talk(
      "mori",
      { id: "bob", name: "Bob" },
      "你是谁？你能做什么？",
    );
    assert.match(system, /不要主动复述旧记录里的星球/);
    assert.doesNotMatch(system, /潮汐门边/);
    await runtime.talk("mori", { id: "bob", name: "Bob" }, "别人说过什么吗？");
    assert.match(system, /潮汐门边/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
