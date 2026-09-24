import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

test("new sessions prune expired hashes without a service restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-live-session-prune-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    const first = await auth.register(
      "会话清理旅人",
      "ten-characters-or-more",
      "203.0.113.40",
    );
    const firstHash = createHash("sha256").update(first.token).digest("hex");
    const internal = auth as unknown as {
      state: { sessions: Record<string, { expiresAt: number }> };
    };
    internal.state.sessions[firstHash]!.expiresAt = Date.now() - 1;

    const second = await auth.login(
      "会话清理旅人",
      "ten-characters-or-more",
      "203.0.113.41",
    );
    const path = join(dir, "accounts.json");
    const afterLogin = JSON.parse(await readFile(path, "utf8")) as {
      sessions: Record<string, { expiresAt: number }>;
    };
    assert.equal(afterLogin.sessions[firstHash], undefined);
    assert.equal(auth.account(second.token)?.id, first.account.id);

    const secondHash = createHash("sha256").update(second.token).digest("hex");
    internal.state.sessions[secondHash]!.expiresAt = Date.now() - 1;
    await auth.register("新来旅人", "ten-characters-or-more", "203.0.113.42");
    const afterRegister = JSON.parse(await readFile(path, "utf8")) as {
      sessions: Record<string, unknown>;
    };
    assert.equal(afterRegister.sessions[secondHash], undefined);
    assert.equal(Object.keys(afterRegister.sessions).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a ninth session replaces only the oldest session for that account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-session-ceiling-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    const first = await auth.register(
      "多设备旅人",
      "ten-characters-or-more",
      "203.0.113.43",
    );
    const other = await auth.register(
      "另一位旅人",
      "ten-characters-or-more",
      "203.0.113.44",
    );
    const tokens = [first.token];
    for (let index = 0; index < 7; index += 1) {
      const session = await auth.login(
        "多设备旅人",
        "ten-characters-or-more",
        "203.0.113.45",
      );
      tokens.push(session.token);
    }
    for (const token of tokens)
      assert.equal(auth.account(token)?.id, first.account.id);

    const newest = await auth.login(
      "多设备旅人",
      "ten-characters-or-more",
      "203.0.113.45",
    );
    assert.equal(auth.account(first.token), null);
    for (const token of tokens.slice(1))
      assert.equal(auth.account(token)?.id, first.account.id);
    assert.equal(auth.account(newest.token)?.id, first.account.id);
    assert.equal(auth.account(other.token)?.id, other.account.id);
    const saved = JSON.parse(
      await readFile(join(dir, "accounts.json"), "utf8"),
    ) as {
      sessions: Record<string, unknown>;
    };
    assert.equal(Object.keys(saved.sessions).length, 9);
    const restarted = new AuthStore(dir);
    await restarted.initialize();
    assert.equal(restarted.account(first.token), null);
    assert.equal(restarted.account(newest.token)?.id, first.account.id);
    assert.equal(restarted.account(other.token)?.id, other.account.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown and repeated logout do not rewrite the account state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-logout-noop-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    const registered = await auth.register(
      "退出旅人",
      "ten-characters-or-more",
      "203.0.113.46",
    );
    const path = join(dir, "accounts.json");
    const before = await stat(path);
    await auth.logout("A".repeat(43));
    assert.equal((await stat(path)).ino, before.ino);
    assert.equal(auth.account(registered.token)?.id, registered.account.id);

    await auth.logout(registered.token);
    assert.equal(auth.account(registered.token), null);
    const after = await stat(path);
    assert.notEqual(after.ino, before.ino);
    await auth.logout(registered.token);
    assert.equal((await stat(path)).ino, after.ino);
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

test("a durable world registration limit arbitrates concurrent final places", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-register-budget-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    await auth.register("旧旅人", "ten-characters-or-more", "203.0.113.80");
    const path = join(dir, "accounts.json");
    const state = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    state.registrationDay = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    state.registrationCount = 239;
    await writeFile(path, JSON.stringify(state));

    const restarted = new AuthStore(dir);
    await restarted.initialize();
    const results = await Promise.allSettled([
      restarted.register(
        "甲号新旅人",
        "ten-characters-or-more",
        "203.0.113.81",
      ),
      restarted.register(
        "乙号新旅人",
        "ten-characters-or-more",
        "203.0.113.82",
      ),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const exhausted = new AuthStore(dir);
    await exhausted.initialize();
    await assert.rejects(
      exhausted.register(
        "再来一位旅人",
        "ten-characters-or-more",
        "203.0.113.83",
      ),
      /注册名额已用完/,
    );
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      accounts: unknown[];
      registrationCount: number;
    };
    assert.equal(saved.accounts.length, 2);
    assert.equal(saved.registrationCount, 240);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy account state derives today's registration floor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-register-legacy-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    await auth.register("旧旅人", "ten-characters-or-more", "203.0.113.84");
    const path = join(dir, "accounts.json");
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    delete saved.registrationDay;
    delete saved.registrationCount;
    await writeFile(path, JSON.stringify(saved));
    const restarted = new AuthStore(dir);
    await restarted.initialize();
    await restarted.register(
      "新旅人",
      "ten-characters-or-more",
      "203.0.113.85",
    );
    const upgraded = JSON.parse(await readFile(path, "utf8")) as {
      registrationCount: number;
    };
    assert.equal(upgraded.registrationCount, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the in-memory IP attempt table stays bounded", async () => {
  const auth = new AuthStore("/unused");
  const limiter = auth as unknown as {
    limitAttempts: (key: string, count: number, windowMs: number) => void;
    attempts: Map<string, unknown>;
  };
  for (let index = 0; index < 10_050; index += 1)
    limiter.limitAttempts(`login:${index}`, 10, 600_000);
  assert.ok(limiter.attempts.size <= 10_000);
});

test("distributed login attempts hit a world-wide short-window ceiling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-login-budget-test-"));
  try {
    const auth = new AuthStore(dir);
    await auth.initialize();
    for (let index = 0; index < 600; index += 1) {
      await assert.rejects(
        auth.login(
          "不存在的旅人",
          "wrong-password",
          `198.51.${Math.floor(index / 254)}.${(index % 254) + 1}`,
        ),
        /昵称或密码不正确/,
      );
    }
    await assert.rejects(
      auth.login("不存在的旅人", "wrong-password", "203.0.113.86"),
      /操作太频繁/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("distributed invalid registration attempts hit a world-wide short-window ceiling", async () => {
  const auth = new AuthStore("/unused");
  for (let index = 0; index < 1_200; index += 1) {
    await assert.rejects(
      auth.register(
        "!",
        "ten-characters-or-more",
        `198.18.${Math.floor(index / 254)}.${(index % 254) + 1}`,
      ),
      /昵称需要/,
    );
  }
  await assert.rejects(
    auth.register("!", "ten-characters-or-more", "203.0.113.87"),
    /操作太频繁/,
  );
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
