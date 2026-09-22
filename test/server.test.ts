import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorldServer } from "../src/server/server.ts";
import { SpiritRuntime } from "../src/server/spirit-runtime.ts";
import { WorldStore } from "../src/server/world-store.ts";

test("HTTP cookies isolate conversation lists, while both visitors can wake the same spirit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-server-test-"));
  const store = new WorldStore(dir);
  await store.initialize();
  const runtime = new SpiritRuntime(store, async (input) => ({
    schemaVersion: "nextclaw.task/v1",
    status: "completed",
    kind: "agent",
    agentId: input.agentId,
    sessionId: input.sessionId,
    runId: "run",
    text: "你好，来访者。",
    completedMessage: null,
  }));
  const server = createWorldServer(store, runtime);
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server address unavailable");
    const base = `http://127.0.0.1:${address.port}`;
    const a = await fetch(`${base}/api/world`);
    const b = await fetch(`${base}/api/world`);
    const cookieA = a.headers.get("set-cookie")!.split(";")[0]!;
    const cookieB = b.headers.get("set-cookie")!.split(";")[0]!;
    assert.notEqual(cookieA, cookieB);
    assert.match(a.headers.get("set-cookie")!, /HttpOnly/);
    const sent = await fetch(`${base}/api/spirits/mori/messages`, {
      method: "POST",
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "你好" }),
    });
    assert.equal(sent.status, 200);
    const convoA = await fetch(`${base}/api/spirits/mori/conversation`, {
      headers: { Cookie: cookieA },
    });
    const convoB = await fetch(`${base}/api/spirits/mori/conversation`, {
      headers: { Cookie: cookieB },
    });
    assert.equal(
      ((await convoA.json()) as { messages: unknown[] }).messages.length,
      2,
    );
    assert.equal(
      ((await convoB.json()) as { messages: unknown[] }).messages.length,
      0,
    );
    assert.equal(store.world().spirits[0]?.encounters, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
