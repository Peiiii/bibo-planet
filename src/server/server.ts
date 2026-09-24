import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSpirit,
  type DeletionPolicyView,
  type PersonalDataArchive,
  type SpiritId,
} from "../shared/world.ts";
import { AuthError, AuthStore } from "./auth-store.ts";
import { AccountDeletion, DeletionPendingError } from "./account-deletion.ts";
import { EnergyExhaustedError, WorldStore } from "./world-store.ts";
import type { SpiritRuntime } from "./spirit-runtime.ts";

const COOKIE_NAME = "bibo_session";
const root = resolve(fileURLToPath(new URL("../../dist/", import.meta.url)));

export function createWorldServer(
  store: WorldStore,
  runtime: Pick<SpiritRuntime, "talk" | "modelDisclosure">,
  auth: AuthStore,
  deletion: AccountDeletion,
  deletionPolicy: DeletionPolicyView,
): Server {
  return createServer(async (request, response) => {
    try {
      const edgeSecret = process.env.BIBO_EDGE_SECRET;
      if (
        edgeSecret &&
        !matchesEdgeSecret(request.headers["x-bibo-edge-secret"], edgeSecret)
      ) {
        sendJson(response, 403, { error: "入口不可用" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/")) {
        await serveStatic(url.pathname, response);
        return;
      }
      const token = getCookie(request);
      const account = auth.account(token);
      const clientIp = getClientIp(request);
      if (request.method === "GET" && url.pathname === "/api/world") {
        sendJson(response, 200, {
          ...store.world(),
          model: runtime.modelDisclosure,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        sendJson(response, 200, { account });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/account/deletion-policy"
      ) {
        sendJson(response, 200, deletionPolicy);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/account/data") {
        if (!account) throw new AuthError(401, "请先登录，再导出你的数据");
        const archive: PersonalDataArchive = {
          format: "bibo-planet-personal-data-v1",
          exportedAt: new Date().toISOString(),
          account: auth.accountData(account.id),
          spirits: store.visitorData(account.id),
        };
        sendJson(response, 200, archive);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/account/delete") {
        assertMutation(request);
        if (!deletionPolicy.enabled)
          throw new AuthError(503, "账号在线删除尚未开放");
        if (!account || !token)
          throw new AuthError(401, "请先登录，再删除你的账号");
        const body = await readJsonBody(request);
        if (body.confirm !== true)
          throw new AuthError(400, "请先确认删除范围与影响");
        const password = typeof body.password === "string" ? body.password : "";
        await deletion.delete(token, password);
        response.setHeader("Set-Cookie", sessionCookie("", 0));
        sendJson(response, 200, { account: null, deleted: true });
        return;
      }
      if (
        request.method === "POST" &&
        ["/api/register", "/api/login", "/api/logout"].includes(url.pathname)
      ) {
        assertMutation(request);
        if (url.pathname === "/api/logout") {
          await auth.logout(token);
          response.setHeader("Set-Cookie", sessionCookie("", 0));
          sendJson(response, 200, { account: null });
          return;
        }
        const body = await readJsonBody(request);
        const name = typeof body.name === "string" ? body.name : "";
        const password = typeof body.password === "string" ? body.password : "";
        const result =
          url.pathname === "/api/register"
            ? await auth.register(name, password, clientIp)
            : await auth.login(name, password, clientIp);
        response.setHeader(
          "Set-Cookie",
          sessionCookie(result.token, 30 * 86_400),
        );
        sendJson(response, 200, { account: result.account });
        return;
      }
      const match = /^\/api\/spirits\/([a-z]+)\/(conversation|messages)$/.exec(
        url.pathname,
      );
      const spirit = match && findSpirit(match[1]);
      if (spirit && match?.[2] === "conversation" && request.method === "GET") {
        if (!account) throw new AuthError(401, "请先登录，再继续与精灵交谈");
        sendJson(response, 200, {
          messages: store.conversation(spirit.id, account.id),
        });
        return;
      }
      if (spirit && match?.[2] === "messages" && request.method === "POST") {
        assertMutation(request);
        if (!account) throw new AuthError(401, "请先登录，再继续与精灵交谈");
        const body = await readJsonBody(request);
        const message =
          typeof body.message === "string" ? body.message.trim() : "";
        const requestId =
          typeof body.requestId === "string" ? body.requestId : "";
        if (!message || message.length > 1500) {
          sendJson(response, 400, { error: "消息需要为 1–1500 个字符" });
          return;
        }
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            requestId,
          )
        ) {
          sendJson(response, 400, { error: "无效的请求编号" });
          return;
        }
        const completed = store.completedRequest(
          spirit.id,
          account.id,
          requestId,
        );
        if (completed) {
          sendJson(response, 200, {
            ...completed,
            account: auth.account(token),
            spirit: store.world().spirits.find((item) => item.id === spirit.id),
          });
          return;
        }
        const result = await auth.withMessagePermit(account.id, () =>
          runtime.talk(spirit.id as SpiritId, account.id, message, requestId),
        );
        sendJson(response, 200, {
          ...result,
          account: auth.account(token),
          spirit: store.world().spirits.find((item) => item.id === spirit.id),
        });
        return;
      }
      sendJson(response, 404, { error: "入口不存在" });
    } catch (error) {
      if (error instanceof AuthError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      if (error instanceof DeletionPendingError) {
        console.error("Account deletion remains pending:", error.cause);
        sendJson(response, 503, { error: error.message });
        return;
      }
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

function matchesEdgeSecret(
  candidate: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof candidate !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

function getCookie(request: IncomingMessage): string | undefined {
  const raw = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const candidate = raw?.slice(COOKIE_NAME.length + 1);
  return candidate && /^[A-Za-z0-9_-]{40,60}$/.test(candidate)
    ? candidate
    : undefined;
}

function sessionCookie(token: string, maxAge: number): string {
  const secure = process.env.BIBO_PUBLIC_ORIGIN ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function getClientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-bibo-client-ip"];
  return typeof forwarded === "string" && /^[\da-fA-F:.]{3,45}$/.test(forwarded)
    ? forwarded
    : (request.socket.remoteAddress ?? "unknown");
}

function assertMutation(request: IncomingMessage): void {
  if (!isSameHostOrigin(request)) throw new AuthError(403, "请求来源不受允许");
  if (
    !request.headers["content-type"]?.startsWith("application/json") &&
    request.url !== "/api/logout"
  )
    throw new AuthError(415, "需要 JSON 请求");
}

function isSameHostOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const publicOrigin = process.env.BIBO_PUBLIC_ORIGIN?.trim();
  if (!origin) return !publicOrigin;
  try {
    const expected = publicOrigin
      ? new URL(publicOrigin).origin
      : new URL(`http://${request.headers.host}`).origin;
    return new URL(origin).origin === expected;
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
