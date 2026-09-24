import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AccountDeletion,
  DeletionPendingError,
} from "../src/server/account-deletion.ts";
import { AuthStore } from "../src/server/auth-store.ts";
import {
  DeletionLedger,
  type DeletionRecord,
  type DeletionRemote,
} from "../src/server/deletion-ledger.ts";
import { WorldStore } from "../src/server/world-store.ts";
import type { SpiritId } from "../src/shared/world.ts";

class MemoryDeletionRemote implements DeletionRemote {
  readonly records = new Map<string, DeletionRecord>();
  unavailable = false;
  putUnavailable = false;

  list = async (): Promise<DeletionRecord[]> => {
    if (this.unavailable) throw new Error("offsite unavailable");
    return [...this.records.values()];
  };

  put = async (record: DeletionRecord): Promise<void> => {
    if (this.unavailable || this.putUnavailable)
      throw new Error("offsite unavailable");
    this.records.set(record.accountId, record);
  };
}

test("a deletion survives interruption and an older account/world snapshot cannot revive it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-delete-replay-test-"));
  const remote = new MemoryDeletionRemote();
  try {
    const auth = new AuthStore(dir);
    const world = new WorldStore(dir);
    await auth.initialize();
    await world.initialize();
    const alice = await auth.register(
      "原旅人",
      "ten-characters-or-more",
      "203.0.113.81",
    );
    const bob = await auth.register(
      "另一旅人",
      "ten-characters-or-more",
      "203.0.113.82",
    );
    for (const spiritId of ["mori", "piko", "sela"] as const) {
      await world.recordTurn({
        spiritId,
        visitorId: alice.account.id,
        message: "原旅人留下蓝色风铃",
        reply: "我听见蓝色风铃",
        spent: 11,
        usageKind: "reported",
      });
      await world.recordTurn({
        spiritId,
        visitorId: bob.account.id,
        message: "另一旅人留下石头",
        reply: "我看见石头",
        spent: 13,
        usageKind: "reported",
      });
    }
    const snapshotPaths = [
      join(dir, "accounts.json"),
      ...(["mori", "piko", "sela"] as const).map((spiritId) =>
        join(dir, "spirits", spiritId, "state.json"),
      ),
    ];
    const oldSnapshot = await Promise.all(
      snapshotPaths.map((path) => readFile(path)),
    );
    const energyBefore = world.world().spirits.map(({ energy }) => energy);
    const ledger = new DeletionLedger(join(dir, "deletion-ledger"), remote);
    const deletion = new AccountDeletion(auth, world, ledger);
    await deletion.initialize();

    const mutableWorld = world as unknown as {
      persist: (spiritId: SpiritId, state: unknown) => Promise<void>;
    };
    const originalPersist = mutableWorld.persist.bind(world);
    let failPiko = true;
    mutableWorld.persist = async (spiritId, state) => {
      if (spiritId === "piko" && failPiko) {
        failPiko = false;
        throw new Error("injected piko write failure");
      }
      await originalPersist(spiritId, state);
    };
    await assert.rejects(
      deletion.delete(alice.token, "ten-characters-or-more"),
      (error: unknown) =>
        error instanceof DeletionPendingError &&
        (error.cause as Error).message === "injected piko write failure",
    );
    assert.equal(auth.account(alice.token), null);
    assert.equal(remote.records.size, 1);
    for (const spiritId of ["mori", "piko", "sela"] as const) {
      assert.equal(world.conversation(spiritId, alice.account.id).length, 0);
      assert.ok(
        world
          .recentEncounters(spiritId)
          .every((encounter) => encounter.visitorId !== alice.account.id),
      );
    }

    const restartedAuth = new AuthStore(dir);
    const restartedWorld = new WorldStore(dir);
    await restartedAuth.initialize(true);
    await restartedWorld.initialize(true);
    const restartedDeletion = new AccountDeletion(
      restartedAuth,
      restartedWorld,
      new DeletionLedger(join(dir, "deletion-ledger"), remote),
    );
    await restartedDeletion.initialize();
    assert.deepEqual(restartedAuth.deletingAccountIds(), []);
    assert.equal(restartedAuth.account(alice.token), null);
    assert.equal(restartedAuth.account(bob.token)?.id, bob.account.id);
    assert.deepEqual(
      restartedWorld.world().spirits.map(({ energy }) => energy),
      energyBefore,
    );

    for (const [index, path] of snapshotPaths.entries()) {
      await writeFile(path, oldSnapshot[index]!);
    }
    await rm(join(dir, "deletion-ledger"), { recursive: true, force: true });
    const restoredAuth = new AuthStore(dir);
    const restoredWorld = new WorldStore(dir);
    await restoredAuth.initialize(true);
    await restoredWorld.initialize(true);
    const restoredDeletion = new AccountDeletion(
      restoredAuth,
      restoredWorld,
      new DeletionLedger(join(dir, "deletion-ledger"), remote),
    );
    await restoredDeletion.initialize();
    assert.equal(restoredAuth.account(alice.token), null);
    assert.equal(restoredAuth.account(bob.token)?.id, bob.account.id);
    for (const spiritId of ["mori", "piko", "sela"] as const) {
      assert.equal(
        restoredWorld.conversation(spiritId, alice.account.id).length,
        0,
      );
      assert.equal(
        restoredWorld.conversation(spiritId, bob.account.id).length,
        2,
      );
      assert.equal(restoredWorld.recentEncounters(spiritId).length, 1);
      assert.equal(
        restoredWorld.recentEncounters(spiritId)[0]?.visitorId,
        bob.account.id,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed offsite write leaves the account frozen and is retried before startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-delete-upload-test-"));
  const remote = new MemoryDeletionRemote();
  try {
    const auth = new AuthStore(dir);
    const world = new WorldStore(dir);
    await auth.initialize();
    await world.initialize();
    const alice = await auth.register(
      "待续做旅人",
      "ten-characters-or-more",
      "203.0.113.83",
    );
    await world.recordTurn({
      spiritId: "mori",
      visitorId: alice.account.id,
      message: "不能回流的文字",
      reply: "记住了",
      spent: 10,
      usageKind: "reported",
    });
    const deletion = new AccountDeletion(
      auth,
      world,
      new DeletionLedger(join(dir, "deletion-ledger"), remote),
    );
    await deletion.initialize();
    remote.putUnavailable = true;
    await assert.rejects(
      deletion.delete(alice.token, "ten-characters-or-more"),
      (error: unknown) =>
        error instanceof DeletionPendingError &&
        (error.cause as Error).message === "offsite unavailable",
    );
    assert.equal(auth.account(alice.token), null);
    assert.equal(world.recentEncounters("mori").length, 0);
    assert.equal(remote.records.size, 0);

    remote.putUnavailable = false;
    const restartedAuth = new AuthStore(dir);
    const restartedWorld = new WorldStore(dir);
    await restartedAuth.initialize(true);
    await restartedWorld.initialize(true);
    await new AccountDeletion(
      restartedAuth,
      restartedWorld,
      new DeletionLedger(join(dir, "deletion-ledger"), remote),
    ).initialize();
    assert.equal(remote.records.size, 1);
    assert.equal(restartedAuth.account(alice.token), null);
    assert.equal(restartedWorld.recentEncounters("mori").length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup fails closed when the independent deletion record cannot be read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-delete-offsite-test-"));
  try {
    const auth = new AuthStore(dir);
    const world = new WorldStore(dir);
    await auth.initialize();
    await world.initialize();
    const remote = new MemoryDeletionRemote();
    remote.unavailable = true;
    const deletion = new AccountDeletion(
      auth,
      world,
      new DeletionLedger(join(dir, "deletion-ledger"), remote),
    );
    await assert.rejects(deletion.initialize(), /offsite unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
