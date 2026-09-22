import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
    assert.equal(store.recentEncounters("piko").length, 0);
    const restarted = new WorldStore(dir);
    await restarted.initialize();
    assert.equal(restarted.energy("mori"), INITIAL_ENERGY - 23);
    assert.equal(restarted.conversation("mori", "alice").length, 2);
    assert.equal(restarted.recentEncounters("mori").length, 1);
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
