import assert from "node:assert/strict";
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
    const sent = await fetch(`${base}/api/spirits/mori/messages`, {
      method: "POST",
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "你好",
        requestId: "8aa9e674-7b48-4c63-84bc-9c2821b9fc20",
      }),
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
