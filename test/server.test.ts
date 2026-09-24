import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorldServer } from "../src/server/server.ts";
import { AuthStore } from "../src/server/auth-store.ts";
import { SpiritRuntime } from "../src/server/spirit-runtime.ts";
import { WorldStore } from "../src/server/world-store.ts";

test("registered accounts isolate conversation lists, while both visitors can wake the same spirit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-server-test-"));
  const store = new WorldStore(dir);
  await store.initialize();
  const auth = new AuthStore(dir);
  await auth.initialize();
  const runtime = new SpiritRuntime(store, async () => ({
    content: "你好，来访者。",
    toolCalls: [],
    finishReason: "stop",
    usage: { totalTokens: 31 },
  }));
  const server = createWorldServer(store, runtime, auth);
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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("model failure returns an error without recording a turn or spending quota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-model-failure-test-"));
  const store = new WorldStore(dir);
  await store.initialize();
  const auth = new AuthStore(dir);
  await auth.initialize();
  const runtime = new SpiritRuntime(store, async () => {
    throw new Error("model request failed (401)");
  });
  const server = createWorldServer(store, runtime, auth);
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
      error: "模型凭据无效，精灵暂时无法回应。",
    });
    const conversation = await fetch(`${base}/api/spirits/mori/conversation`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(await conversation.json(), { messages: [] });
    assert.equal(store.world().spirits[0]!.energy, energyBefore);
    assert.equal(store.world().spirits[0]!.encounters, 0);
    assert.equal(auth.account(cookie.split("=")[1])?.remainingToday, 12);
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
    content: "精灵回应。",
    toolCalls: [],
    finishReason: "stop",
    usage: { totalTokens: 31 },
  }));
  const server = createWorldServer(store, runtime, auth);
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
