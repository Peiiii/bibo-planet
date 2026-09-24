import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { findSpirit, type SpiritId } from "../shared/world.ts";

const MAX_FILE_BYTES = 16_384;
const MAX_TOTAL_BYTES = 131_072;
const MAX_FILES = 64;
const MAX_DEPTH = 4;
const ROOT_FILES = new Set(["AGENTS.md", "IDENTITY.md", "MEMORY.md"]);

/** Text files belonging to one shared AI, not the host or another AI. */
export class SpiritFiles {
  constructor(private readonly dataDir: string) {}

  async list(spiritId: SpiritId, path = ""): Promise<string[]> {
    const segments = parsePath(
      path.endsWith("/") && !path.startsWith("/") ? path.slice(0, -1) : path,
    );
    if (segments.length === 0) {
      const root = this.root(spiritId);
      await requireDirectory(root);
      const entries = await readdir(root);
      return [
        ...entries.filter((entry) => ROOT_FILES.has(entry)),
        "files/",
      ].sort();
    }
    const directory = await this.resolveFilesPath(
      spiritId,
      segments,
      "directory",
    );
    const entries = await readdir(directory, { withFileTypes: true });
    if (
      entries.some(
        (entry) =>
          entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()),
      )
    )
      throw new Error("AI 工作区包含不支持的文件类型");
    return entries
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort();
  }

  async read(spiritId: SpiritId, path: string): Promise<string> {
    const segments = parsePath(path);
    let target: string;
    if (segments.length === 1 && ROOT_FILES.has(segments[0]!)) {
      const root = this.root(spiritId);
      await requireDirectory(root);
      target = join(root, segments[0]!);
      await requireFile(target);
    } else {
      target = await this.resolveFilesPath(spiritId, segments, "file");
    }
    const stat = await lstat(target);
    if (stat.size > MAX_FILE_BYTES) throw new Error("文件超过读取上限");
    const buffer = await readFile(target);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (text.includes("\0")) throw new Error("只支持 UTF-8 文本文件");
    return text;
  }

  async write(
    spiritId: SpiritId,
    path: string,
    content: string,
  ): Promise<void> {
    const segments = parsePath(path);
    if (
      segments[0] !== "files" ||
      segments.length < 2 ||
      segments.length > MAX_DEPTH + 1
    )
      throw new Error("只能写入自己工作区的 files/ 目录");
    if (typeof content !== "string" || content.includes("\0"))
      throw new Error("只能写入 UTF-8 文本");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error("单个文件最多 16 KiB");
    const root = this.root(spiritId);
    await requireDirectory(root);
    let parent = join(root, "files");
    await requireDirectory(parent);
    for (const segment of segments.slice(1, -1)) {
      parent = join(parent, segment);
      try {
        await requireDirectory(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(parent, { mode: 0o700 });
      }
    }
    const target = join(parent, segments.at(-1)!);
    let previousBytes = 0;
    let exists = false;
    try {
      previousBytes = (await requireFile(target)).size;
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const usage = await this.usage(join(root, "files"));
    if (
      usage.count + Number(!exists) > MAX_FILES ||
      usage.bytes - previousBytes + bytes > MAX_TOTAL_BYTES
    )
      throw new Error("AI 工作区容量不足");
    const temporary = join(parent, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async clearSharedFiles(spiritId: SpiritId): Promise<void> {
    const root = this.root(spiritId);
    try {
      await requireDirectory(root);
      const files = join(root, "files");
      await requireDirectory(files);
      await rm(files, { recursive: true });
      await mkdir(files, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private root(spiritId: SpiritId): string {
    if (!findSpirit(spiritId)) throw new Error("未知 AI");
    return join(this.dataDir, "workspace", "agents", spiritId);
  }

  private async resolveFilesPath(
    spiritId: SpiritId,
    segments: string[],
    kind: "file" | "directory",
  ): Promise<string> {
    if (segments[0] !== "files" || segments.length > MAX_DEPTH + 1)
      throw new Error("路径不在当前 AI 的工作区");
    const root = this.root(spiritId);
    await requireDirectory(root);
    let target = root;
    for (const [index, segment] of segments.entries()) {
      target = join(target, segment);
      if (index === segments.length - 1 && kind === "file")
        await requireFile(target);
      else await requireDirectory(target);
    }
    return target;
  }

  private async usage(
    directory: string,
  ): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const child = await this.usage(path);
        count += child.count;
        bytes += child.bytes;
      } else if (entry.isFile()) {
        const stat = await requireFile(path);
        count += 1;
        bytes += stat.size;
      } else throw new Error("AI 工作区包含不支持的文件类型");
    }
    return { count, bytes };
  }
}

function parsePath(path: string): string[] {
  if (typeof path !== "string" || path.length > 240 || path.startsWith("/"))
    throw new Error("无效的工作区路径");
  if (path === "") return [];
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment.length > 80 ||
        segment.includes("\\") ||
        [...segment].some(
          (character) =>
            character.codePointAt(0)! < 32 || character.codePointAt(0) === 127,
        ),
    )
  )
    throw new Error("无效的工作区路径");
  return segments;
}

async function requireDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error("工作区路径不是目录");
}

async function requireFile(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error("工作区路径不是普通文件");
  return stat;
}
