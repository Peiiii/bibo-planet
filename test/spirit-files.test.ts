import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SpiritFiles } from "../src/server/spirit-files.ts";

test("one AI can list, write and read persistent text without exposing another AI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-files-test-"));
  try {
    for (const id of ["mori", "piko"]) {
      await mkdir(join(dir, "workspace", "agents", id, "files"), {
        recursive: true,
      });
    }
    await writeFile(
      join(dir, "workspace", "agents", "mori", "AGENTS.md"),
      "AI identity",
    );
    const files = new SpiritFiles(dir);
    assert.deepEqual(await files.list("mori"), ["AGENTS.md", "files/"]);
    await files.write("mori", "files/想法/notes.md", "第一次内容");
    assert.deepEqual(await files.list("mori", "files"), ["想法/"]);
    assert.deepEqual(await files.list("mori", "files/想法"), ["notes.md"]);
    assert.equal(await files.read("mori", "files/想法/notes.md"), "第一次内容");
    assert.equal(await files.read("mori", "AGENTS.md"), "AI identity");
    await files.write("mori", "files/想法/notes.md", "更新内容");
    assert.equal(
      await new SpiritFiles(dir).read("mori", "files/想法/notes.md"),
      "更新内容",
    );
    assert.deepEqual(await files.list("piko", "files"), []);
    await assert.rejects(files.read("piko", "files/想法/notes.md"), {
      code: "ENOENT",
    });
    await assert.rejects(
      files.write("mori", "AGENTS.md", "overwrite"),
      /只能写入/,
    );
    assert.equal(
      await readFile(
        join(dir, "workspace", "agents", "mori", "AGENTS.md"),
        "utf8",
      ),
      "AI identity",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace tools reject traversal, symbolic links, binary data and over-quota writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibo-files-boundary-test-"));
  try {
    const root = join(dir, "workspace", "agents", "mori");
    await mkdir(join(root, "files"), { recursive: true });
    await writeFile(join(dir, "private.txt"), "not public");
    await symlink(dir, join(root, "files", "escape"));
    const files = new SpiritFiles(dir);
    for (const path of [
      "../private.txt",
      "/etc/passwd",
      "files/../../private.txt",
      "files\\private.txt",
      "files/.hidden",
      "files//a",
      "piko/files/a",
    ]) {
      await assert.rejects(files.write("mori", path, "x"));
      await assert.rejects(files.read("mori", path));
    }
    await assert.rejects(files.list("mori", "files"), /不支持的文件类型/);
    await assert.rejects(files.read("mori", "files/escape/private.txt"));
    await assert.rejects(files.write("mori", "files/escape/new.txt", "x"));
    await rm(join(root, "files", "escape"));
    await assert.rejects(files.write("mori", "files/binary", "a\0b"), /UTF-8/);
    await assert.rejects(
      files.write("mori", "files/big", "a".repeat(16_385)),
      /16 KiB/,
    );
    for (let index = 0; index < 8; index += 1)
      await files.write("mori", `files/${index}.txt`, "a".repeat(16_384));
    await assert.rejects(files.write("mori", "files/9.txt", "x"), /容量不足/);
    await files.write("mori", "files/0.txt", "short");
    assert.equal(await files.read("mori", "files/0.txt"), "short");
    assert.equal(
      await readFile(join(dir, "private.txt"), "utf8"),
      "not public",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
