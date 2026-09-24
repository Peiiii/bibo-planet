import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ACCOUNT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeletionRecord = {
  version: 1;
  accountId: string;
  createdAt: string;
};

export interface DeletionRemote {
  list(): Promise<DeletionRecord[]>;
  put(record: DeletionRecord): Promise<void>;
}

export class DeletionLedger {
  private readonly records = new Map<string, DeletionRecord>();

  constructor(
    private readonly localDir: string,
    private readonly remote: DeletionRemote,
  ) {}

  async initialize(): Promise<void> {
    // The remote is authoritative after an older account/world snapshot is restored.
    const remoteRecords = await this.remote.list();
    await mkdir(this.localDir, { recursive: true, mode: 0o700 });
    const localRecords = await this.readLocal();
    const remoteById = new Map<string, DeletionRecord>();
    for (const record of remoteRecords) {
      assertRecord(record);
      const prior = remoteById.get(record.accountId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(record))
        throw new Error("离机删除记录冲突，拒绝启动");
      remoteById.set(record.accountId, record);
    }
    for (const record of localRecords) {
      const offsite = remoteById.get(record.accountId);
      if (offsite && JSON.stringify(offsite) !== JSON.stringify(record))
        throw new Error("本地与离机删除记录不一致，拒绝启动");
      if (!offsite) await this.remote.put(record);
      remoteById.set(record.accountId, record);
    }
    for (const record of remoteById.values()) {
      if (!localRecords.some((local) => local.accountId === record.accountId))
        await this.persistLocal(record);
      this.records.set(record.accountId, record);
    }
  }

  list(): DeletionRecord[] {
    return [...this.records.values()];
  }

  has(accountId: string): boolean {
    return this.records.has(accountId);
  }

  async record(accountId: string): Promise<void> {
    if (!ACCOUNT_ID.test(accountId)) throw new Error("无效的账号编号");
    if (this.records.has(accountId)) return;
    const record: DeletionRecord = {
      version: 1,
      accountId,
      createdAt: new Date().toISOString(),
    };
    // Confirm the independent copy before claiming that the deletion can finish.
    await this.remote.put(record);
    await this.persistLocal(record);
    this.records.set(accountId, record);
  }

  private async readLocal(): Promise<DeletionRecord[]> {
    const records: DeletionRecord[] = [];
    for (const name of await readdir(this.localDir)) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(
        await readFile(join(this.localDir, name), "utf8"),
      ) as DeletionRecord;
      assertRecord(record);
      if (name !== `${record.accountId}.json`)
        throw new Error("本地删除记录文件名无效，拒绝启动");
      records.push(record);
    }
    return records;
  }

  private async persistLocal(record: DeletionRecord): Promise<void> {
    const path = join(this.localDir, `${record.accountId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  }
}

function assertRecord(record: DeletionRecord): void {
  if (
    record?.version !== 1 ||
    typeof record.accountId !== "string" ||
    !ACCOUNT_ID.test(record.accountId) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  )
    throw new Error("删除记录格式无效，拒绝启动");
}
