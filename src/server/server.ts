import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findSpirit, type SpiritId } from "../shared/world.ts";
import { EnergyExhaustedError, WorldStore } from "./world-store.ts";
import type { SpiritRuntime } from "./spirit-runtime.ts";

const COOKIE_NAME = "bibo_visitor";
const VISITOR_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const root = resolve(fileURLToPath(new URL("../../dist/", import.meta.url)));

export function createWorldServer(
  store: WorldStore,
  runtime: Pick<SpiritRuntime, "talk">,
): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/")) {
        await serveStatic(url.pathname, response);
        return;
      }
      const visitorId = getVisitorId(request, response);
      if (request.method === "GET" && url.pathname === "/api/world") {
        sendJson(response, 200, store.world());
        return;
      }
      const match = /^\/api\/spirits\/([a-z]+)\/(conversation|messages)$/.exec(
        url.pathname,
      );
      const spirit = match && findSpirit(match[1]);
      if (spirit && match?.[2] === "conversation" && request.method === "GET") {
        sendJson(response, 200, {
          messages: store.conversation(spirit.id, visitorId),
        });
        return;
      }
      if (spirit && match?.[2] === "messages" && request.method === "POST") {
        if (!isSameHostOrigin(request)) {
          sendJson(response, 403, { error: "请求来源不受允许" });
          return;
        }
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 415, { error: "需要 JSON 请求" });
          return;
        }
        const body = await readJsonBody(request);
        const message =
          typeof body.message === "string" ? body.message.trim() : "";
        if (!message || message.length > 1500) {
          sendJson(response, 400, { error: "消息需要为 1–1500 个字符" });
          return;
        }
        const result = await runtime.talk(
          spirit.id as SpiritId,
          visitorId,
          message,
        );
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { error: "入口不存在" });
    } catch (error) {
      if (error instanceof EnergyExhaustedError) {
        sendJson(response, 409, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "未知错误";
      const status =
        message === "请求过大" || message === "无效 JSON" ? 400 : 502;
      console.error(
        "World request failed:",
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
      );
      const publicError = /\(429\)/.test(message)
        ? "模型服务额度已用完，精灵暂时无法回应。"
        : /\(402\)/.test(message)
          ? "模型账户余额不足，精灵暂时无法回应。"
          : /\(401\)/.test(message)
            ? "模型凭据无效，精灵暂时无法回应。"
            : "精灵暂时无法回应，请稍后再试。";
      sendJson(response, status, {
        error: status === 502 ? publicError : message,
      });
    }
  });
}

function getVisitorId(
  request: IncomingMessage,
  response: ServerResponse,
): string {
  const raw = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const candidate = raw?.slice(COOKIE_NAME.length + 1);
  if (candidate && VISITOR_ID.test(candidate)) return candidate;
  const visitorId = randomUUID();
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${visitorId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
  );
  return visitorId;
}

function isSameHostOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return (
      new URL(origin).hostname ===
      new URL(`http://${request.headers.host}`).hostname
    );
  } catch {
    return false;
  }
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > 4096) throw new Error("请求过大");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("无效 JSON");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function serveStatic(
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (path !== root && !path.startsWith(root + sep)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const body = await readFile(path);
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(
      "页面尚未构建。开发时请访问 http://127.0.0.1:5173，或先运行 pnpm build。",
    );
  }
}
