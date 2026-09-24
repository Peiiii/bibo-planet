import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SESSION_DAYS = 30;
const USER_DAILY_LIMIT = 12;
const WORLD_DAILY_LIMIT = 240;

type Account = {
  id: string;
  name: string;
  normalizedName: string;
  password: string;
  createdAt: string;
  usageDay: string;
  usageCount: number;
};

type Session = { accountId: string; expiresAt: number };
type AuthState = {
  version: 1;
  accounts: Account[];
  sessions: Record<string, Session>;
};

export type AccountView = { id: string; name: string; remainingToday: number };

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class AuthStore {
  private state: AuthState = { version: 1, accounts: [], sessions: {} };
  private operation: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Set<string>();
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly dataDir: string) {}

  async initialize(requireExisting = false): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as AuthState;
      if (
        state.version !== 1 ||
        !Array.isArray(state.accounts) ||
        !state.sessions
      )
        throw new Error("账号数据格式无效");
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (requireExisting) throw new Error("账号状态缺失，拒绝启动已有世界");
      await this.persist(this.state);
    }
  }

  async register(
    name: string,
    password: string,
    clientIp: string,
  ): Promise<{ account: AccountView; token: string }> {
    this.limitAttempts(`register:${clientIp}`, 20, 24 * 60 * 60_000);
    const displayName = name.normalize("NFC").trim();
    const normalizedName = displayName.toLocaleLowerCase("zh-CN");
    if (!/^[\p{L}\p{N}_]{3,24}$/u.test(displayName))
      throw new AuthError(400, "昵称需要 3–24 个汉字、字母、数字或下划线");
    if (password.length < 10 || password.length > 128)
      throw new AuthError(400, "密码需要 10–128 个字符");
    const passwordHash = await hashPassword(password);
    return await this.serial(async () => {
      if (
        this.state.accounts.some(
          (account) => account.normalizedName === normalizedName,
        )
      )
        throw new AuthError(409, "这个昵称已经有人使用");
      const account: Account = {
        id: randomUUID(),
        name: displayName,
        normalizedName,
        password: passwordHash,
        createdAt: new Date().toISOString(),
        usageDay: dayKey(),
        usageCount: 0,
      };
      const token = randomBytes(32).toString("base64url");
      const next: AuthState = {
        ...this.state,
        accounts: [...this.state.accounts, account],
        sessions: {
          ...this.state.sessions,
          [tokenHash(token)]: {
            accountId: account.id,
            expiresAt: Date.now() + SESSION_DAYS * 86_400_000,
          },
        },
      };
      await this.persist(next);
      this.state = next;
      return { account: this.view(account), token };
    });
  }

  async login(
    name: string,
    password: string,
    clientIp: string,
  ): Promise<{ account: AccountView; token: string }> {
    this.limitAttempts(`login:${clientIp}`, 10, 10 * 60_000);
    const normalizedName = name
      .normalize("NFC")
      .trim()
      .toLocaleLowerCase("zh-CN");
    const account = this.state.accounts.find(
      (item) => item.normalizedName === normalizedName,
    );
    if (!account || !(await checkPassword(password, account.password)))
      throw new AuthError(401, "昵称或密码不正确");
    return await this.serial(async () => {
      const token = randomBytes(32).toString("base64url");
      const next: AuthState = {
        ...this.state,
        sessions: {
          ...this.state.sessions,
          [tokenHash(token)]: {
            accountId: account.id,
            expiresAt: Date.now() + SESSION_DAYS * 86_400_000,
          },
        },
      };
      await this.persist(next);
      this.state = next;
      return { account: this.view(account), token };
    });
  }

  account(token: string | undefined): AccountView | null {
    if (!token) return null;
    const session = this.state.sessions[tokenHash(token)];
    if (!session || session.expiresAt <= Date.now()) return null;
    const account = this.state.accounts.find(
      (item) => item.id === session.accountId,
    );
    return account ? this.view(account) : null;
  }

  accountData(
    accountId: string,
  ): Pick<Account, "id" | "name" | "createdAt" | "usageDay" | "usageCount"> {
    const account = this.state.accounts.find((item) => item.id === accountId);
    if (!account) throw new AuthError(401, "登录状态已失效");
    const { id, name, createdAt, usageDay, usageCount } = account;
    return { id, name, createdAt, usageDay, usageCount };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.serial(async () => {
      const sessions = { ...this.state.sessions };
      delete sessions[tokenHash(token)];
      const next = { ...this.state, sessions };
      await this.persist(next);
      this.state = next;
    });
  }

  async withMessagePermit<T>(
    accountId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.inFlight.has(accountId))
      throw new AuthError(429, "请等上一条消息完成后再发送");
    const today = dayKey();
    const account = this.state.accounts.find((item) => item.id === accountId);
    if (!account) throw new AuthError(401, "登录状态已失效");
    if (account.usageDay === today && account.usageCount >= USER_DAILY_LIMIT)
      throw new AuthError(429, "今天的唤醒次数已用完，明天再来看看它吧");
    const worldUsed = this.state.accounts.reduce(
      (sum, item) => sum + (item.usageDay === today ? item.usageCount : 0),
      0,
    );
    if (worldUsed + this.inFlight.size >= WORLD_DAILY_LIMIT)
      throw new AuthError(429, "星球今天需要休息，明天会再次开放");
    this.inFlight.add(accountId);
    try {
      const result = await action();
      await this.serial(async () => {
        const accounts = this.state.accounts.map((item) =>
          item.id === accountId
            ? {
                ...item,
                usageDay: today,
                usageCount: (item.usageDay === today ? item.usageCount : 0) + 1,
              }
            : item,
        );
        const next = { ...this.state, accounts };
        await this.persist(next);
        this.state = next;
      });
      return result;
    } finally {
      this.inFlight.delete(accountId);
    }
  }

  private view(account: Account): AccountView {
    return {
      id: account.id,
      name: account.name,
      remainingToday: Math.max(
        0,
        USER_DAILY_LIMIT -
          (account.usageDay === dayKey() ? account.usageCount : 0),
      ),
    };
  }

  private limitAttempts(key: string, count: number, windowMs: number): void {
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter(
      (at) => at > now - windowMs,
    );
    if (recent.length >= count)
      throw new AuthError(429, "操作太频繁，请稍后再试");
    recent.push(now);
    this.attempts.set(key, recent);
  }

  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const current = this.operation.catch(() => undefined).then(action);
    this.operation = current;
    return await current;
  }

  private get path(): string {
    return join(this.dataDir, "accounts.json");
  }

  private async persist(state: AuthState): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function dayKey(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function checkPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [, saltHex, hashHex] = encoded.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = (await scrypt(
    password,
    Buffer.from(saltHex, "hex"),
    expected.length,
  )) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
