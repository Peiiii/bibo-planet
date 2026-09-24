import { AuthStore } from "./auth-store.ts";
import { DeletionLedger } from "./deletion-ledger.ts";
import { WorldStore } from "./world-store.ts";

export class DeletionPendingError extends Error {
  constructor(options?: ErrorOptions) {
    super("删除尚未完成，账号已暂停使用；请稍后联系运营方处理。", options);
  }
}

export class AccountDeletion {
  constructor(
    private readonly auth: AuthStore,
    private readonly world: WorldStore,
    private readonly ledger: DeletionLedger,
  ) {}

  async initialize(): Promise<void> {
    await this.ledger.initialize();
    const ids = new Set([
      ...this.ledger.list().map((record) => record.accountId),
      ...this.auth.deletingAccountIds(),
    ]);
    for (const id of ids) this.world.suppressVisitor(id);
    for (const id of ids) {
      await this.ledger.record(id);
      await this.auth.markDeletingFromLedger(id);
      await this.world.removeVisitorData(id);
      await this.auth.completeDeletion(id);
    }
  }

  async delete(token: string, password: string): Promise<void> {
    const accountId = await this.auth.beginDeletion(token, password, (id) => {
      this.world.suppressVisitor(id);
    });
    try {
      await this.ledger.record(accountId);
      await this.world.removeVisitorData(accountId);
      await this.auth.completeDeletion(accountId);
    } catch (cause) {
      throw new DeletionPendingError({ cause });
    }
  }
}
