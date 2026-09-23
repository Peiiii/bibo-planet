import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const dataDir = resolve(root, ".data");
const pidPath = resolve(dataDir, "local-service.json");
const logPath = resolve(dataDir, "local-service.log");
const port = Number(process.env.PORT ?? 3038);
const healthUrl = `http://127.0.0.1:${port}/api/world`;

type ServiceRecord = {
  pid: number;
  startedAt: string;
};

async function readRecord(): Promise<ServiceRecord | null> {
  try {
    const value = JSON.parse(await readFile(pidPath, "utf8")) as ServiceRecord;
    return Number.isSafeInteger(value.pid) && value.pid > 0 ? value : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  return false;
}

async function start(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const existing = await readRecord();
  if (existing && isAlive(existing.pid)) {
    if (await isHealthy()) {
      console.log(`Bibo Planet 已在运行（PID ${existing.pid}）`);
      return;
    }
    throw new Error(
      `已有 Bibo Planet 进程但服务未就绪（PID ${existing.pid}），请查看 ${logPath} 或先运行 pnpm local:stop。`,
    );
  }
  if (await isHealthy()) {
    throw new Error(`端口 ${port} 已有另一个 Bibo Planet 服务，请先停止它。`);
  }
  if (existing) await rm(pidPath, { force: true });

  const log = openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [resolve(root, "node_modules/tsx/dist/cli.mjs"), "src/server/main.ts"],
    {
      cwd: root,
      detached: true,
      env: process.env,
      stdio: ["ignore", log, log],
    },
  );
  child.unref();
  closeSync(log);
  await writeFile(
    pidPath,
    JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  if (!(await waitForHealthy(15_000))) {
    throw new Error(`服务没有成功启动，请查看 ${logPath}`);
  }
  console.log(`Bibo Planet 已在后台运行：http://127.0.0.1:${port}`);
  console.log(`日志：${logPath}`);
}

async function stop(): Promise<void> {
  const record = await readRecord();
  if (!record || !isAlive(record.pid)) {
    await rm(pidPath, { force: true });
    console.log("Bibo Planet 当前没有运行。");
    return;
  }
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isAlive(record.pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  await rm(pidPath, { force: true });
  if (isAlive(record.pid))
    throw new Error(`服务未能正常停止（PID ${record.pid}）`);
  console.log("Bibo Planet 已停止。");
}

async function status(): Promise<void> {
  const record = await readRecord();
  if (record && isAlive(record.pid) && (await isHealthy())) {
    console.log(`Bibo Planet 正在运行（PID ${record.pid}）`);
    console.log(`http://127.0.0.1:${port}`);
    return;
  }
  console.log("Bibo Planet 当前没有运行。");
  process.exitCode = 1;
}

const command = process.argv[2];
if (command === "start") await start();
else if (command === "stop") await stop();
else if (command === "status") await status();
else throw new Error("用法：local-service.ts <start|stop|status>");
