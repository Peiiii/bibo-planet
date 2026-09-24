import "dotenv/config";
import { resolve } from "node:path";
import { createWorldServer } from "./server.ts";
import { AccountDeletion } from "./account-deletion.ts";
import { AuthStore } from "./auth-store.ts";
import { DeletionLedger } from "./deletion-ledger.ts";
import { FileDeletionRemote, OssDeletionRemote } from "./deletion-remotes.ts";
import { SpiritRuntime } from "./spirit-runtime.ts";
import { WorldStore } from "./world-store.ts";

const dataDir = resolve(
  process.env.BIBO_DATA_DIR ?? resolve(process.cwd(), ".data"),
);
const requireExisting = process.env.NODE_ENV === "production";
const store = new WorldStore(dataDir);
await store.initialize(requireExisting);
const auth = new AuthStore(dataDir);
await auth.initialize(requireExisting);
const deletion = new AccountDeletion(
  auth,
  store,
  new DeletionLedger(
    requireExisting
      ? requiredEnvironment("BIBO_DELETION_LEDGER_DIR")
      : resolve(dataDir, "deletion-ledger"),
    requireExisting
      ? new OssDeletionRemote(
          requiredEnvironment("BIBO_OSSUTIL_PATH"),
          requiredEnvironment("BIBO_DELETION_OSS_PREFIX"),
          requiredEnvironment("BIBO_DELETION_OSS_ENDPOINT"),
          requiredEnvironment("BIBO_DELETION_OSS_REGION"),
        )
      : new FileDeletionRemote(resolve(dataDir, "deletion-offsite")),
  ),
);
await deletion.initialize();
const deletionEnabled = process.env.BIBO_ACCOUNT_DELETION_ENABLED === "true";
if (deletionEnabled) {
  const retentionDays = Number(
    requiredEnvironment("BIBO_BACKUP_RETENTION_DAYS"),
  );
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1)
    throw new Error("BIBO_BACKUP_RETENTION_DAYS 必须是正整数");
  requiredEnvironment("BIBO_PUBLIC_OPERATOR_NAME");
  requiredEnvironment("BIBO_PRIVACY_CONTACT");
}
const runtime = new SpiritRuntime(store);
await runtime.start();

const port = Number(process.env.PORT ?? 3038);
const server = createWorldServer(
  store,
  runtime,
  auth,
  deletion,
  deletionEnabled,
);
server.listen(port, "127.0.0.1", () => {
  console.log(`Bibo Planet listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => {
      void runtime.stop().finally(() => process.exit(0));
    });
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少生产配置：${name}`);
  return value;
}
