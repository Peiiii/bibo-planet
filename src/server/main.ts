import "dotenv/config";
import { resolve } from "node:path";
import { createWorldServer } from "./server.ts";
import { AuthStore } from "./auth-store.ts";
import { SpiritRuntime } from "./spirit-runtime.ts";
import { WorldStore } from "./world-store.ts";

const dataDir = resolve(process.env.BIBO_DATA_DIR ?? resolve(process.cwd(), ".data"));
const store = new WorldStore(dataDir);
await store.initialize();
const auth = new AuthStore(dataDir);
await auth.initialize();
const runtime = new SpiritRuntime(store);
await runtime.start();

const port = Number(process.env.PORT ?? 3038);
const server = createWorldServer(store, runtime, auth);
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
