import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeletionRecord, DeletionRemote } from "./deletion-ledger.ts";

const MARKER_NAME = "schema-v1.json";
const MARKER = { format: "bibo-planet-deletion-ledger-v1" };

export class FileDeletionRemote implements DeletionRemote {
  constructor(private readonly dir: string) {}

  list = async (): Promise<DeletionRecord[]> => {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return await readRecords(this.dir);
  };

  put = async (record: DeletionRecord): Promise<void> => {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${record.accountId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  };
}

export class OssDeletionRemote implements DeletionRemote {
  constructor(
    private readonly ossutilPath: string,
    private readonly prefix: string,
    private readonly endpoint: string,
    private readonly region: string,
  ) {
    if (!/^oss:\/\/[a-z0-9][a-z0-9-]*\/deletions\/?$/.test(prefix))
      throw new Error("离机删除记录前缀必须是专用 deletions/ 路径");
    if (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint))
      throw new Error("无效的 OSS 内网端点");
    if (!/^[a-z]+-[a-z0-9-]+$/.test(region)) throw new Error("无效的 OSS 地域");
  }

  list = async (): Promise<DeletionRecord[]> => {
    const temporary = await mkdtemp(join(tmpdir(), "bibo-deletion-sync-"));
    try {
      await this.run([
        "sync",
        `${this.prefix.replace(/\/$/, "")}/`,
        temporary,
        ...this.authArgs(),
        "--no-progress",
        "--no-error-report",
        "--force",
      ]);
      const marker = JSON.parse(
        await readFile(join(temporary, MARKER_NAME), "utf8"),
      ) as unknown;
      if (
        !marker ||
        typeof marker !== "object" ||
        !("format" in marker) ||
        marker.format !== MARKER.format
      )
        throw new Error("离机删除记录缺少正确的初始化标记，拒绝启动");
      return await readRecords(temporary);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };

  put = async (record: DeletionRecord): Promise<void> => {
    const temporary = await mkdtemp(join(tmpdir(), "bibo-deletion-put-"));
    try {
      const path = join(temporary, `${record.accountId}.json`);
      await writeFile(path, JSON.stringify(record), { mode: 0o600 });
      await this.run([
        "cp",
        path,
        `${this.prefix.replace(/\/$/, "")}/${record.accountId}.json`,
        ...this.authArgs(),
        "--force",
        "--no-progress",
        "--no-error-report",
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };

  private authArgs(): string[] {
    return [
      "--mode",
      "EcsRamRole",
      "-e",
      this.endpoint,
      "--region",
      this.region,
    ];
  }

  private async run(args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.ossutilPath, args, {
        stdio: "ignore",
        signal: AbortSignal.timeout(60_000),
      });
      child.once("error", () => reject(new Error("离机删除记录操作失败")));
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`离机删除记录操作失败（退出码 ${code}）`));
      });
    });
  }
}

async function readRecords(dir: string): Promise<DeletionRecord[]> {
  const records: DeletionRecord[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error("离机删除记录目录含非文件对象");
    const name = entry.name;
    if (name === MARKER_NAME || name.endsWith(".tmp")) continue;
    if (!/^[0-9a-f-]{36}\.json$/i.test(name))
      throw new Error("离机删除记录文件名无效");
    const record = JSON.parse(
      await readFile(join(dir, name), "utf8"),
    ) as DeletionRecord;
    if (name !== `${record.accountId}.json`)
      throw new Error("离机删除记录编号不一致");
    records.push(record);
  }
  return records;
}
