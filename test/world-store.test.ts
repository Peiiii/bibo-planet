import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INITIAL_ENERGY, MIN_WAKE_ENERGY } from "../src/shared/world.ts";
import { EnergyExhaustedError, WorldStore } from "../src/server/world-store.ts";

test("shared encounters persist while raw conversations remain visitor-specific", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-world-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    assert.equal(store.world().spirits.length, 3);
    assert.equal(store.world().spirits[0]?.lastEncounterAt, null);
    assert.equal(store.energy("mori"), INITIAL_ENERGY);
    await store.recordTurn({
      spiritId: "mori",
      visitorId: "alice",
      message: "我的秘密是蓝色月亮",
      reply: "我记下了。",
      spent: 23,
      usageKind: "reported",
    });
    assert.equal(store.energy("mori"), INITIAL_ENERGY - 23);
    assert.equal(store.conversation("mori", "alice").length, 2);
    assert.equal(store.conversation("mori", "bob").length, 0);
    assert.equal(
      store.recentEncounters("mori")[0]?.message,
      "我的秘密是蓝色月亮",
    );
    assert.equal(store.recentEncounters("mori")[0]?.spent, 23);
    assert.equal(store.recentEncounters("mori")[0]?.usageKind, "reported");
    assert.equal(
      store.world().spirits[0]?.lastEncounterAt,
      store.recentEncounters("mori")[0]?.createdAt,
    );
    assert.equal(store.recentEncounters("piko").length, 0);
    const restarted = new WorldStore(dir);
    await restarted.initialize();
    assert.equal(restarted.energy("mori"), INITIAL_ENERGY - 23);
    assert.equal(restarted.conversation("mori", "alice").length, 2);
    assert.equal(restarted.recentEncounters("mori").length, 1);
    assert.equal(
      restarted.world().spirits[0]?.lastEncounterAt,
      store.world().spirits[0]?.lastEncounterAt,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("energy threshold refuses a new wake and credit restores it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-energy-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    await store.recordTurn({
      spiritId: "piko",
      visitorId: randomUUID(),
      message: "hello",
      reply: "hi",
      spent: INITIAL_ENERGY - MIN_WAKE_ENERGY + 1,
      usageKind: "estimated",
    });
    assert.throws(() => store.assertCanWake("piko"), EnergyExhaustedError);
    assert.equal(await store.credit("piko", 1000), MIN_WAKE_ENERGY - 1 + 1000);
    assert.doesNotThrow(() => store.assertCanWake("piko"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an older shared clue is recalled after it leaves the recent window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-recall-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    await store.recordTurn({
      spiritId: "mori",
      visitorId: "alice",
      message: "这颗星球的暗号是蓝色风铃，英文代号 bluebell",
      reply: "我记下了蓝色风铃。",
      spent: 20,
      usageKind: "reported",
    });
    for (let index = 0; index < 11; index += 1) {
      await store.recordTurn({
        spiritId: "mori",
        visitorId: `other-${index}`,
        message: `第${index}次普通路过`,
        reply: "你好，旅人。",
        spent: 20,
        usageKind: "reported",
      });
    }
    assert.equal(store.recentEncounters("mori", 10).length, 10);
    assert.ok(
      store
        .recentEncounters("mori", 10)
        .every((item) => !item.message.includes("蓝色风铃")),
    );
    assert.match(
      store.relevantEncounters("mori", "你还记得蓝色风铃吗")[0]!.message,
      /蓝色风铃/,
    );
    assert.equal(
      store.relevantEncounters("mori", "Was bluebell mentioned?").length,
      1,
    );
    assert.deepEqual(store.relevantEncounters("mori", "你还记得吗"), []);
    const restarted = new WorldStore(dir);
    await restarted.initialize();
    assert.equal(
      restarted.relevantEncounters("mori", "关于蓝色风铃").length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-spirit turns run serially", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-lock-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    const order: string[] = [];
    const first = store.withSpiritLock("sela", async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
    });
    const second = store.withSpiritLock("sela", async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each shared AI keeps only its own bounded notes, and deletion clears all notes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-memory-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    await store.replaceMemory("mori", "蓝色风铃");
    await store.replaceMemory("piko", "普通石头");
    assert.equal(await store.readMemory("mori"), "蓝色风铃");
    assert.equal(await store.readMemory("sela"), "");
    await assert.rejects(
      store.replaceMemory("mori", "x".repeat(8_001)),
      /无效/,
    );
    const restarted = new WorldStore(dir);
    await restarted.initialize(true);
    assert.equal(await restarted.readMemory("piko"), "普通石头");
    await restarted.scrubSharedContentForDeletion("a".repeat(64));
    await restarted.removeVisitorData("any-visitor");
    for (const spirit of ["mori", "piko", "sela"] as const)
      assert.equal(await restarted.readMemory(spirit), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing worlds never silently recreate missing spirit state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-world-required-test-"));
  try {
    await assert.rejects(new WorldStore(dir).initialize(true), /精灵状态缺失/);
    await new WorldStore(dir).initialize();
    await new WorldStore(dir).initialize(true);
    const missingPath = join(dir, "spirits", "piko", "state.json");
    await unlink(missingPath);
    await assert.rejects(new WorldStore(dir).initialize(), /精灵状态缺失/);
    await assert.rejects(readFile(missingPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("suppressed visitor memories stay out of model recall and are removed without refunding energy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-visitor-removal-test-"));
  try {
    const store = new WorldStore(dir);
    await store.initialize();
    for (const spiritId of ["mori", "piko", "sela"] as const) {
      await store.recordTurn({
        spiritId,
        visitorId: "alice",
        message: "只属于 alice 的蓝色风铃",
        reply: "精灵记下蓝色风铃。",
        spent: 25,
        usageKind: "reported",
      });
      await store.recordTurn({
        spiritId,
        visitorId: "bob",
        message: "bob 留下一颗普通石头",
        reply: "石头还在。",
        spent: 20,
        usageKind: "reported",
      });
    }
    const energyBefore = store.world().spirits.map(({ energy }) => energy);
    store.suppressVisitor("alice");
    for (const spiritId of ["mori", "piko", "sela"] as const) {
      assert.equal(store.recentEncounters(spiritId).length, 1);
      assert.equal(store.recentEncounters(spiritId)[0]?.visitorId, "bob");
      assert.equal(store.conversation(spiritId, "alice").length, 0);
      assert.equal(
        store.world().spirits.find(({ id }) => id === spiritId)?.encounters,
        1,
      );
    }
    assert.deepEqual(
      store
        .visitorData("alice")
        .map(({ sharedEncounters }) => sharedEncounters.length),
      [0, 0, 0],
    );
    await assert.rejects(
      store.recordTurn({
        spiritId: "mori",
        visitorId: "alice",
        message: "不能重新写入",
        reply: "不能重新回复",
        spent: 1,
        usageKind: "reported",
      }),
      /正在删除/,
    );
    await store.removeVisitorData("alice");
    await store.removeVisitorData("alice");
    assert.deepEqual(
      store.world().spirits.map(({ energy }) => energy),
      energyBefore,
    );
    const restarted = new WorldStore(dir);
    await restarted.initialize(true);
    for (const spiritId of ["mori", "piko", "sela"] as const) {
      assert.equal(restarted.conversation(spiritId, "alice").length, 0);
      assert.equal(restarted.conversation(spiritId, "bob").length, 2);
      assert.equal(restarted.recentEncounters(spiritId).length, 1);
      assert.equal(restarted.recentEncounters(spiritId)[0]?.visitorId, "bob");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
