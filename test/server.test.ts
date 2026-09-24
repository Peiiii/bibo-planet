import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorldServer } from "../src/server/server.ts";
import { AccountDeletion } from "../src/server/account-deletion.ts";
import { AuthStore } from "../src/server/auth-store.ts";
import { DeletionLedger } from "../src/server/deletion-ledger.ts";
import { FileDeletionRemote } from "../src/server/deletion-remotes.ts";
import { SpiritRuntime } from "../src/server/spirit-runtime.ts";
import { WorldStore } from "../src/server/world-store.ts";

async function deletionFor(
  dir: string,
  auth: AuthStore,
  store: WorldStore,
): Promise<AccountDeletion> {
  const deletion = new AccountDeletion(
    auth,
    store,
    new DeletionLedger(
      join(dir, "deletion-ledger"),
      new FileDeletionRemote(join(dir, "deletion-offsite")),
    ),
  );
  await deletion.initialize();
  return deletion;
}

test("registered accounts isolate conversation lists, while both visitors can wake the same spirit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-server-test-"));
  const store = new WorldStore(dir);
  await store.initialize();
  const auth = new AuthStore(dir);
  await auth.initialize();
  const contexts: string[] = [];
  const runtime = new SpiritRuntime(store, async (input) => {
    contexts.push(input.context);
    return { text: "你好，来访者。", totalTokens: 31 };
  });
  const server = createWorldServer(
    store,
    runtime,
    auth,
    await deletionFor(dir, auth, store),
    { enabled: false },
  );
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server address unavailable");
    const base = `http://127.0.0.1:${address.port}`;
    const worldResponse = await fetch(`${base}/api/world`);
    assert.equal(worldResponse.status, 200);
    const worldBody = (await worldResponse.json()) as {
      model: {
        name: string;
        filingNumber: string | null;
        sourceUrl: string | null;
      };
    };
    assert.deepEqual(worldBody.model, runtime.modelDisclosure);
    const register = (name: string) =>
      fetch(`${base}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password: "longpassword123" }),
      });
    const a = await register("alice");
    const b = await register("bobby");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const cookieA = a.headers.get("set-cookie")!.split(";")[0]!;
    const cookieB = b.headers.get("set-cookie")!.split(";")[0]!;
    assert.notEqual(cookieA, cookieB);
    assert.match(a.headers.get("set-cookie")!, /HttpOnly/);
    assert.deepEqual(
      await (await fetch(`${base}/api/account/deletion-policy`)).json(),
      { enabled: false },
    );
    const notYetOpen = await fetch(`${base}/api/account/delete`, {
      method: "POST",
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "longpassword123", confirm: true }),
    });
    assert.equal(notYetOpen.status, 503);
    assert.notEqual(auth.account(cookieA.split("=")[1]), null);
    const requestId = "8aa9e674-7b48-4c63-84bc-9c2821b9fc20";
    const sent = await fetch(`${base}/api/spirits/mori/messages`, {
      method: "POST",
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "你好", requestId }),
    });
    assert.equal(sent.status, 200);
    const firstTurn = (await sent.json()) as {
      spirit: { energy: number; encounters: number; lastEncounterAt: string };
      reply: { text: string };
      account: { remainingToday: number };
    };
    assert.equal(firstTurn.reply.text, "你好，来访者。");
    assert.equal(firstTurn.spirit.encounters, 1);
    assert.equal(firstTurn.spirit.lastEncounterAt.length > 0, true);
    assert.equal(firstTurn.account.remainingToday, 11);
    assert.match(contexts[0] ?? "", /"name":"alice"/);
    assert.doesNotMatch(contexts[0] ?? "", /"name":"bobby"/);
    const replay = await fetch(`${base}/api/spirits/mori/messages`, {
      method: "POST",
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "你好", requestId }),
    });
    assert.equal(replay.status, 200);
    const replayedTurn = (await replay.json()) as typeof firstTurn & {
      replayed: boolean;
    };
    assert.equal(replayedTurn.replayed, true);
    assert.deepEqual(replayedTurn.spirit, firstTurn.spirit);
    assert.equal(replayedTurn.account.remainingToday, 11);
    for (const spiritId of ["mori", "piko", "sela"]) {
      const convoA = await fetch(
        `${base}/api/spirits/${spiritId}/conversation`,
        { headers: { Cookie: cookieA } },
      );
      const convoB = await fetch(
        `${base}/api/spirits/${spiritId}/conversation`,
        { headers: { Cookie: cookieB } },
      );
      assert.equal(
        ((await convoA.json()) as { messages: unknown[] }).messages.length,
        spiritId === "mori" ? 2 : 0,
      );
      assert.equal(
        ((await convoB.json()) as { messages: unknown[] }).messages.length,
        0,
      );
    }
    assert.equal(store.world().spirits[0]?.encounters, 1);

    const unknownLogout = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: { Cookie: `bibo_session=${"A".repeat(43)}` },
    });
    assert.equal(unknownLogout.status, 200);
    assert.deepEqual(await unknownLogout.json(), { account: null });
    const stillLoggedIn = await fetch(`${base}/api/session`, {
      headers: { Cookie: cookieA },
    });
    assert.equal(
      ((await stillLoggedIn.json()) as { account: { id: string } }).account.id,
      auth.account(cookieA.split("=")[1])?.id,
    );

    const logout = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookieA },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
    assert.deepEqual(await logout.json(), { account: null });
    assert.deepEqual(
      await (
        await fetch(`${base}/api/session`, { headers: { Cookie: cookieA } })
      ).json(),
      { account: null },
    );
    const otherStillLoggedIn = await fetch(`${base}/api/session`, {
      headers: { Cookie: cookieB },
    });
    assert.equal(
      ((await otherStillLoggedIn.json()) as { account: { name: string } })
        .account.name,
      "bobby",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("model failure returns an error without recording a turn or successful usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-model-failure-test-"));
  const store = new WorldStore(dir);
  await store.initialize();
  const auth = new AuthStore(dir);
  await auth.initialize();
  const runtime = new SpiritRuntime(store, async () => {
    throw new Error("model request failed (401)");
  });
  const server = createWorldServer(
    store,
    runtime,
    auth,
    await deletionFor(dir, auth, store),
    { enabled: false },
  );
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server address unavailable");
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "traveler", password: "longpassword123" }),
    });
    assert.equal(registered.status, 200);
    const cookie = registered.headers.get("set-cookie")!.split(";")[0]!;
    const energyBefore = store.world().spirits[0]!.energy;
    const sent = await fetch(`${base}/api/spirits/mori/messages`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "你好",
        requestId: "7de4f7ee-937d-4bbb-b89b-1ee95f72edc3",
      }),
    });
    assert.equal(sent.status, 502);
    assert.deepEqual(await sent.json(), {
      error: "模型凭据无效，AI 暂时无法回答。",
    });
    const conversation = await fetch(`${base}/api/spirits/mori/conversation`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(await conversation.json(), { messages: [] });
    assert.equal(store.world().spirits[0]!.energy, energyBefore);
    assert.equal(store.world().spirits[0]!.encounters, 0);
    assert.equal(auth.account(cookie.split("=")[1])?.remainingToday, 12);
    const accountId = auth.account(cookie.split("=")[1])?.id;
    assert.equal(auth.accountData(accountId!).attemptCount, 1);
    assert.equal(auth.accountData(accountId!).usageCount, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("personal data export uses only the cookie identity and excludes other travelers and credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-export-test-"));
  const store = new WorldStore(dir);
  await store.initialize();
  const auth = new AuthStore(dir);
  await auth.initialize();
  const runtime = new SpiritRuntime(store, async () => ({
    text: "精灵回应。",
    totalTokens: 31,
  }));
  const server = createWorldServer(
    store,
    runtime,
    auth,
    await deletionFor(dir, auth, store),
    { enabled: false },
  );
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server address unavailable");
    const base = `http://127.0.0.1:${address.port}`;
    const register = async (name: string) => {
      const response = await fetch(`${base}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password: "longpassword123" }),
      });
      assert.equal(response.status, 200);
      const account = (await response.json()) as {
        account: { id: string; name: string };
      };
      return {
        account: account.account,
        cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      };
    };
    const alice = await register("alice");
    const bobby = await register("bobby");
    const send = async (cookie: string, spirit: string, message: string) => {
      const response = await fetch(`${base}/api/spirits/${spirit}/messages`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ message, requestId: randomUUID() }),
      });
      assert.equal(response.status, 200);
    };
    await send(alice.cookie, "mori", "alice 的蓝色线索");
    await send(alice.cookie, "piko", "alice 的红色线索");
    await send(bobby.cookie, "mori", "bobby 的绿色线索");

    const anonymous = await fetch(`${base}/api/account/data`);
    assert.equal(anonymous.status, 401);
    const response = await fetch(
      `${base}/api/account/data?accountId=${bobby.account.id}`,
      { headers: { Cookie: alice.cookie } },
    );
    assert.equal(response.status, 200);
    const archive = (await response.json()) as {
      format: string;
      account: Record<string, unknown>;
      spirits: Array<{
        spirit: { id: string };
        messages: Array<{ text: string }>;
        sharedEncounters: Array<{ message: string }>;
      }>;
    };
    assert.equal(archive.format, "bibo-planet-personal-data-v1");
    assert.equal(archive.account.id, alice.account.id);
    assert.equal(archive.account.name, "alice");
    assert.equal(typeof archive.account.createdAt, "string");
    assert.equal(archive.account.usageCount, 2);
    assert.equal(archive.account.attemptCount, 2);
    assert.equal(archive.spirits.length, 3);
    assert.deepEqual(
      archive.spirits.map(({ spirit, sharedEncounters }) => [
        spirit.id,
        sharedEncounters.length,
      ]),
      [
        ["mori", 1],
        ["piko", 1],
        ["sela", 0],
      ],
    );
    const text = JSON.stringify(archive);
    assert.match(text, /alice 的蓝色线索/);
    assert.match(text, /alice 的红色线索/);
    assert.doesNotMatch(text, /bobby 的绿色线索/);
    assert.doesNotMatch(text, new RegExp(bobby.account.id));
    assert.doesNotMatch(text, /longpassword123|scrypt:|bibo_session/);
    assert.equal(
      "visitorId" in archive.spirits[0]!.sharedEncounters[0]!,
      false,
    );
    assert.equal(
      archive.spirits.find((item) => item.spirit.id === "mori")?.messages
        .length,
      2,
    );
    const bobbyResponse = await fetch(`${base}/api/account/data`, {
      headers: { Cookie: bobby.cookie },
    });
    assert.equal(bobbyResponse.status, 200);
    const bobbyText = await bobbyResponse.text();
    assert.match(bobbyText, /bobby 的绿色线索/);
    assert.doesNotMatch(bobbyText, /alice 的蓝色线索|alice 的红色线索/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("account deletion is cookie-scoped, password-confirmed, and leaves another traveler intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-delete-api-test-"));
  const store = new WorldStore(dir);
  await store.initialize();
  const auth = new AuthStore(dir);
  await auth.initialize();
  const runtime = new SpiritRuntime(store, async () => ({
    text: "精灵回应。",
    totalTokens: 31,
  }));
  const server = createWorldServer(
    store,
    runtime,
    auth,
    await deletionFor(dir, auth, store),
    {
      enabled: true,
      backupRetentionDays: 30,
      operatorName: "测试运营方",
      privacyContact: "test@example.invalid",
    },
  );
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server address unavailable");
    const base = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(
      await (await fetch(`${base}/api/account/deletion-policy`)).json(),
      {
        enabled: true,
        backupRetentionDays: 30,
        operatorName: "测试运营方",
        privacyContact: "test@example.invalid",
      },
    );
    const register = async (name: string) => {
      const response = await fetch(`${base}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password: "longpassword123" }),
      });
      assert.equal(response.status, 200);
      const data = (await response.json()) as { account: { id: string } };
      return {
        id: data.account.id,
        cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      };
    };
    const alice = await register("alice");
    const bobby = await register("bobby");
    for (const visitor of [alice, bobby]) {
      await store.recordTurn({
        spiritId: "mori",
        visitorId: visitor.id,
        message: `来自 ${visitor.id} 的线索`,
        reply: "我听到了。",
        spent: 10,
        usageKind: "reported",
      });
    }
    const deleteUrl = `${base}/api/account/delete?accountId=${bobby.id}`;
    const requestDeletion = (cookie: string | undefined, body: unknown) =>
      fetch(deleteUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await requestDeletion(undefined, {
          password: "longpassword123",
          confirm: true,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await requestDeletion(alice.cookie, {
          password: "wrong-password",
          confirm: true,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await requestDeletion(alice.cookie, {
          password: "longpassword123",
          confirm: false,
        })
      ).status,
      400,
    );
    const deleted = await requestDeletion(alice.cookie, {
      password: "longpassword123",
      confirm: true,
      accountId: bobby.id,
    });
    assert.equal(deleted.status, 200);
    assert.match(deleted.headers.get("set-cookie")!, /Max-Age=0/);
    assert.deepEqual(await deleted.json(), { account: null, deleted: true });
    const oldSession = await fetch(`${base}/api/session`, {
      headers: { Cookie: alice.cookie },
    });
    assert.deepEqual(await oldSession.json(), { account: null });
    assert.equal(
      (
        await fetch(`${base}/api/account/data`, {
          headers: { Cookie: alice.cookie },
        })
      ).status,
      401,
    );
    assert.equal(auth.account(bobby.cookie.split("=")[1])?.id, bobby.id);
    assert.equal(store.recentEncounters("mori").length, 1);
    assert.equal(store.recentEncounters("mori")[0]?.visitorId, bobby.id);
    const replacement = await register("alice");
    assert.notEqual(replacement.id, alice.id);
    const newConversation = await fetch(
      `${base}/api/spirits/mori/conversation`,
      { headers: { Cookie: replacement.cookie } },
    );
    assert.deepEqual(await newConversation.json(), { messages: [] });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
