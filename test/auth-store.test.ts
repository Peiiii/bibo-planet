import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AuthStore } from "../src/server/auth-store.ts";

test("registration, login, quota and logout survive a store restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-auth-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    const registered = await auth.register(
      "星球旅人",
      "ten-characters-or-more",
      "127.0.0.1",
    );
    assert.equal(auth.account(registered.token)?.name, "星球旅人");
    await auth.withMessagePermit(registered.account.id, async () => "ok");
    const restarted = new AuthStore(dir);
    await restarted.initialize();
    assert.equal(restarted.account(registered.token)?.remainingToday, 11);
    await assert.rejects(
      restarted.login("星球旅人", "wrong-password", "127.0.0.2"),
      /不正确/,
    );
    const loggedIn = await restarted.login(
      "星球旅人",
      "ten-characters-or-more",
      "127.0.0.2",
    );
    assert.equal(loggedIn.account.id, registered.account.id);
    await restarted.logout(registered.token);
    assert.equal(restarted.account(registered.token), null);
    assert.equal(restarted.account(loggedIn.token)?.id, registered.account.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup removes expired session hashes without logging out a live session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-expired-session-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    const first = await auth.register(
      "过期会话旅人",
      "ten-characters-or-more",
      "203.0.113.1",
    );
    const second = await auth.login(
      "过期会话旅人",
      "ten-characters-or-more",
      "203.0.113.2",
    );
    const path = join(dir, "accounts.json");
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      sessions: Record<string, { expiresAt: number }>;
    };
    const expiredHash = createHash("sha256").update(first.token).digest("hex");
    saved.sessions[expiredHash]!.expiresAt = Date.now() - 1;
    await writeFile(path, JSON.stringify(saved));

    const restarted = new AuthStore(dir);
    await restarted.initialize();
    assert.equal(restarted.account(first.token), null);
    assert.equal(restarted.account(second.token)?.id, first.account.id);
    const compacted = JSON.parse(await readFile(path, "utf8")) as {
      sessions: Record<string, unknown>;
    };
    assert.equal(compacted.sessions[expiredHash], undefined);
    assert.equal(Object.keys(compacted.sessions).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("several travelers behind one address can register", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-shared-ip-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    for (let index = 0; index < 4; index += 1) {
      const registered = await auth.register(
        `旅人${index + 1}号`,
        "ten-characters-or-more",
        "203.0.113.9",
      );
      assert.equal(registered.account.name, `旅人${index + 1}号`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production account initialization refuses a missing data file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-auth-required-test-"));
  try {
    await assert.rejects(new AuthStore(dir).initialize(true), /账号状态缺失/);
    await new AuthStore(dir).initialize();
    await new AuthStore(dir).initialize(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed model attempts consume a persisted attempt budget without claiming success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-attempt-budget-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    const registered = await auth.register(
      "尝试预算旅人",
      "ten-characters-or-more",
      "203.0.113.12",
    );
    let calls = 0;
    for (let index = 0; index < 18; index += 1) {
      await assert.rejects(
        auth.withMessagePermit(registered.account.id, async () => {
          calls += 1;
          throw new Error("provider timeout");
        }),
        /provider timeout/,
      );
    }
    assert.equal(calls, 18);
    assert.equal(auth.accountData(registered.account.id).usageCount, 0);
    assert.equal(auth.accountData(registered.account.id).attemptCount, 18);
    assert.equal(auth.account(registered.token)?.remainingToday, 0);

    const restarted = new AuthStore(dir);
    await restarted.initialize();
    await assert.rejects(
      restarted.withMessagePermit(registered.account.id, async () => {
        calls += 1;
      }),
      /尝试次数已用完/,
    );
    assert.equal(calls, 18);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy account rows count prior successful messages as attempts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-legacy-budget-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    const registered = await auth.register(
      "旧账号旅人",
      "ten-characters-or-more",
      "203.0.113.13",
    );
    await auth.withMessagePermit(registered.account.id, async () => "ok");
    const path = join(dir, "accounts.json");
    const legacy = JSON.parse(await readFile(path, "utf8")) as {
      accounts: Array<Record<string, unknown>>;
    };
    for (const account of legacy.accounts) {
      delete account.attemptDay;
      delete account.attemptCount;
    }
    await writeFile(path, JSON.stringify(legacy));
    const restarted = new AuthStore(dir);
    await restarted.initialize();
    assert.equal(restarted.accountData(registered.account.id).attemptCount, 1);
    assert.equal(restarted.account(registered.token)?.remainingToday, 11);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-account concurrency cannot reserve twice while a model call is in flight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-concurrent-budget-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    const registered = await auth.register(
      "并发预算旅人",
      "ten-characters-or-more",
      "203.0.113.14",
    );
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = auth.withMessagePermit(registered.account.id, async () => {
      await pending;
    });
    await assert.rejects(
      auth.withMessagePermit(registered.account.id, async () => {
        throw new Error("second model call should not run");
      }),
      /上一条消息/,
    );
    finish();
    await first;
    assert.equal(auth.accountData(registered.account.id).attemptCount, 1);
    assert.equal(auth.accountData(registered.account.id).usageCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("account deletion requires password, waits for active calls, and freezes every session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-delete-auth-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    const first = await auth.register(
      "删除旅人",
      "ten-characters-or-more",
      "203.0.113.70",
    );
    const second = await auth.login(
      "删除旅人",
      "ten-characters-or-more",
      "203.0.113.71",
    );
    await assert.rejects(
      auth.beginDeletion(first.token, "wrong-password"),
      /密码不正确/,
    );
    await assert.rejects(
      auth.beginDeletion("unknown", "ten-characters-or-more"),
      /登录状态已失效/,
    );
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const inFlight = auth.withMessagePermit(first.account.id, () => pending);
    await assert.rejects(
      auth.beginDeletion(first.token, "ten-characters-or-more"),
      /上一条消息/,
    );
    finish();
    await inFlight;
    assert.equal(
      await auth.beginDeletion(first.token, "ten-characters-or-more"),
      first.account.id,
    );
    assert.equal(auth.account(first.token), null);
    assert.equal(auth.account(second.token), null);
    assert.deepEqual(auth.deletingAccountIds(), [first.account.id]);
    await assert.rejects(
      auth.login("删除旅人", "ten-characters-or-more", "203.0.113.72"),
      /昵称或密码不正确/,
    );
    await assert.rejects(
      auth.withMessagePermit(first.account.id, async () => undefined),
      /登录状态已失效/,
    );
    await auth.completeDeletion(first.account.id);
    await auth.completeDeletion(first.account.id);
    assert.deepEqual(auth.deletingAccountIds(), []);
    const replacement = await auth.register(
      "删除旅人",
      "ten-characters-or-more",
      "203.0.113.73",
    );
    assert.notEqual(replacement.account.id, first.account.id);
    const restarted = new AuthStore(dir);
    await restarted.initialize();
    assert.equal(restarted.account(first.token), null);
    assert.equal(restarted.account(second.token), null);
    assert.equal(
      restarted.account(replacement.token)?.id,
      replacement.account.id,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("world attempt reservations stop at 240 across accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-world-budget-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    let calls = 0;
    let lastAccountId = "";
    for (let index = 0; index < 20; index += 1) {
      const account = await auth.register(
        `额度旅人${index}`,
        "ten-characters-or-more",
        `203.0.113.${index + 30}`,
      );
      lastAccountId = account.account.id;
      for (let turn = 0; turn < (index === 19 ? 11 : 12); turn += 1) {
        await auth.withMessagePermit(account.account.id, async () => {
          calls += 1;
        });
      }
    }
    assert.equal(calls, 239);
    const competing = await auth.register(
      "竞争旅人",
      "ten-characters-or-more",
      "203.0.113.59",
    );
    const results = await Promise.allSettled([
      auth.withMessagePermit(lastAccountId, async () => {
        calls += 1;
      }),
      auth.withMessagePermit(competing.account.id, async () => {
        calls += 1;
      }),
    ]);
    assert.equal(
      results.filter((item) => item.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((item) => item.status === "rejected").length,
      1,
    );
    assert.equal(calls, 240);
    const deleted = await auth.login(
      "额度旅人0",
      "ten-characters-or-more",
      "203.0.113.90",
    );
    await auth.beginDeletion(deleted.token, "ten-characters-or-more");
    await auth.completeDeletion(deleted.account.id);
    const restarted = new AuthStore(dir);
    await restarted.initialize();
    const extra = await restarted.register(
      "额外旅人",
      "ten-characters-or-more",
      "203.0.113.60",
    );
    await assert.rejects(
      restarted.withMessagePermit(extra.account.id, async () => {
        calls += 1;
      }),
      /星球今天需要休息/,
    );
    assert.equal(calls, 240);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
