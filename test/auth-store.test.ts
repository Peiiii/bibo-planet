import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
