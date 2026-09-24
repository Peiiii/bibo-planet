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
import { MIN_ACCOUNT_PASSWORD_LENGTH } from "../shared/world.ts";

const scrypt = promisify(scryptCallback);
const SESSION_DAYS = 30;
const USER_DAILY_LIMIT = 12;
const USER_DAILY_ATTEMPT_LIMIT = 18;
const WORLD_DAILY_LIMIT = 240;
const WORLD_DAILY_REGISTRATION_LIMIT = 240;
const MAX_TRACKED_ATTEMPT_KEYS = 10_000;
const MAX_ACTIVE_SESSIONS_PER_ACCOUNT = 8;

type Account = {
  id: string;
  name: string;
  normalizedName: string;
  password: string;
  createdAt: string;
  usageDay: string;
  usageCount: number;
  attemptDay?: string;
  attemptCount?: number;
  deleting?: true;
};

type Session = { accountId: string; expiresAt: number };
type AuthState = {
  version: 1;
  accounts: Account[];
  sessions: Record<string, Session>;
  worldAttemptCarry?: { day: string; count: number };
  registrationDay?: string;
  registrationCount?: number;
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
  private readonly attempts = new Map<
    string,
    { timestamps: number[]; expiresAt: number }
  >();
  private nextAttemptSweep = 0;

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
      const now = Date.now();
      const sessions = activeSessions(state.sessions, now);
      const next = { ...state, sessions };
      if (Object.keys(sessions).length !== Object.keys(state.sessions).length)
        await this.persist(next);
      this.state = next;
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
    this.limitAttempts("register:global", 1_200, 10 * 60_000);
    const displayName = name.normalize("NFC").trim();
    const normalizedName = displayName.toLocaleLowerCase("zh-CN");
    if (!/^[\p{L}\p{N}_]{3,24}$/u.test(displayName))
      throw new AuthError(400, "昵称需要 3–24 个汉字、字母、数字或下划线");
    const passwordLength = Array.from(password).length;
    if (passwordLength < MIN_ACCOUNT_PASSWORD_LENGTH || passwordLength > 128)
      throw new AuthError(400, "密码需要 8–128 个字符");
    return await this.serial(async () => {
      const today = dayKey();
      const registrationCount = this.registrationsToday(today);
      if (registrationCount >= WORLD_DAILY_REGISTRATION_LIMIT)
        throw new AuthError(429, "今天的注册名额已用完，明天再试");
      if (
        this.state.accounts.some(
          (account) => account.normalizedName === normalizedName,
        )
      )
        throw new AuthError(409, "这个昵称已经有人使用");
      const passwordHash = await hashPassword(password);
      const account: Account = {
        id: randomUUID(),
        name: displayName,
        normalizedName,
        password: passwordHash,
        createdAt: new Date().toISOString(),
        usageDay: today,
        usageCount: 0,
        attemptDay: today,
        attemptCount: 0,
      };
      const token = randomBytes(32).toString("base64url");
      const now = Date.now();
      const next: AuthState = {
        ...this.state,
        registrationDay: today,
        registrationCount: registrationCount + 1,
        accounts: [...this.state.accounts, account],
        sessions: {
          ...activeSessions(this.state.sessions, now),
          [tokenHash(token)]: {
            accountId: account.id,
            expiresAt: now + SESSION_DAYS * 86_400_000,
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
    this.limitAttempts("login:global", 600, 10 * 60_000);
    const normalizedName = name
      .normalize("NFC")
      .trim()
      .toLocaleLowerCase("zh-CN");
    const account = this.state.accounts.find(
      (item) => item.normalizedName === normalizedName,
    );
    if (
      !account ||
      account.deleting ||
      !(await checkPassword(password, account.password))
    )
      throw new AuthError(401, "昵称或密码不正确");
    return await this.serial(async () => {
      const current = this.state.accounts.find(
        (item) => item.id === account.id && !item.deleting,
      );
      if (!current) throw new AuthError(401, "昵称或密码不正确");
      const token = randomBytes(32).toString("base64url");
      const now = Date.now();
      const sessions = activeSessions(this.state.sessions, now);
      const ownSessions = Object.entries(sessions)
        .filter(([, session]) => session.accountId === account.id)
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (const [hash] of ownSessions.slice(
        0,
        Math.max(0, ownSessions.length - MAX_ACTIVE_SESSIONS_PER_ACCOUNT + 1),
      ))
        delete sessions[hash];
      sessions[tokenHash(token)] = {
        accountId: account.id,
        expiresAt: now + SESSION_DAYS * 86_400_000,
      };
      const next: AuthState = {
        ...this.state,
        sessions,
      };
      await this.persist(next);
      this.state = next;
      return { account: this.view(current), token };
    });
  }

  account(token: string | undefined): AccountView | null {
    if (!token) return null;
    const session = this.state.sessions[tokenHash(token)];
    if (!session || session.expiresAt <= Date.now()) return null;
    const account = this.state.accounts.find(
      (item) => item.id === session.accountId,
    );
    return account && !account.deleting ? this.view(account) : null;
  }

  accountData(accountId: string): Pick<
    Account,
    "id" | "name" | "createdAt" | "usageDay" | "usageCount"
  > & {
    attemptDay: string;
    attemptCount: number;
  } {
    const account = this.state.accounts.find((item) => item.id === accountId);
    if (!account || account.deleting)
      throw new AuthError(401, "登录状态已失效");
    const { id, name, createdAt, usageDay, usageCount } = account;
    return {
      id,
      name,
      createdAt,
      usageDay,
      usageCount,
      attemptDay: account.attemptDay ?? usageDay,
      attemptCount: account.attemptDay
        ? (account.attemptCount ?? 0)
        : usageCount,
    };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.serial(async () => {
      const hash = tokenHash(token);
      if (!this.state.sessions[hash]) return;
      const sessions = { ...this.state.sessions };
      delete sessions[hash];
      const next = { ...this.state, sessions };
      await this.persist(next);
      this.state = next;
    });
  }

  async beginDeletion(
    token: string,
    password: string,
    onFrozen?: (accountId: string) => void,
  ): Promise<string> {
    const session = this.state.sessions[tokenHash(token)];
    const account = this.state.accounts.find(
      (item) => item.id === session?.accountId && !item.deleting,
    );
    if (!session || session.expiresAt <= Date.now() || !account)
      throw new AuthError(401, "登录状态已失效");
    if (!(await checkPassword(password, account.password)))
      throw new AuthError(401, "密码不正确");
    return await this.serial(async () => {
      const currentSession = this.state.sessions[tokenHash(token)];
      const current = this.state.accounts.find(
        (item) => item.id === currentSession?.accountId && !item.deleting,
      );
      if (
        !currentSession ||
        currentSession.expiresAt <= Date.now() ||
        !current ||
        current.id !== account.id
      )
        throw new AuthError(401, "登录状态已失效");
      if (this.inFlight.has(current.id))
        throw new AuthError(409, "请等上一条消息完成后再删除账号");
      const accounts = this.state.accounts.map((item) =>
        item.id === current.id ? { ...item, deleting: true as const } : item,
      );
      const next = { ...this.state, accounts };
      await this.persist(next);
      this.state = next;
      onFrozen?.(current.id);
      return current.id;
    });
  }

  async markDeletingFromLedger(accountId: string): Promise<void> {
    await this.serial(async () => {
      const account = this.state.accounts.find((item) => item.id === accountId);
      if (!account || account.deleting) return;
      if (this.inFlight.has(accountId))
        throw new AuthError(409, "账号仍有正在生成的消息");
      const accounts = this.state.accounts.map((item) =>
        item.id === accountId ? { ...item, deleting: true as const } : item,
      );
      const next = { ...this.state, accounts };
      await this.persist(next);
      this.state = next;
    });
  }

  deletingAccountIds(): string[] {
    return this.state.accounts
      .filter((account) => account.deleting)
      .map((account) => account.id);
  }

  async completeDeletion(accountId: string): Promise<void> {
    await this.serial(async () => {
      const account = this.state.accounts.find((item) => item.id === accountId);
      if (!account) return;
      if (!account.deleting || this.inFlight.has(accountId))
        throw new AuthError(409, "账号尚未进入可完成的删除状态");
      const today = dayKey();
      const worldAttemptCarry = {
        day: today,
        count:
          (this.state.worldAttemptCarry?.day === today
            ? this.state.worldAttemptCarry.count
            : 0) + this.attemptsToday(account, today),
      };
      const sessions = Object.fromEntries(
        Object.entries(this.state.sessions).filter(
          ([, session]) => session.accountId !== accountId,
        ),
      );
      const next = {
        ...this.state,
        accounts: this.state.accounts.filter((item) => item.id !== accountId),
        sessions,
        worldAttemptCarry,
      };
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
    this.inFlight.add(accountId);
    try {
      await this.serial(async () => {
        const account = this.state.accounts.find(
          (item) => item.id === accountId,
        );
        if (!account || account.deleting)
          throw new AuthError(401, "登录状态已失效");
        if (
          account.usageDay === today &&
          account.usageCount >= USER_DAILY_LIMIT
        )
          throw new AuthError(429, "今天的对话次数已用完，请明天再来");
        const attempts = this.attemptsToday(account, today);
        if (attempts >= USER_DAILY_ATTEMPT_LIMIT)
          throw new AuthError(429, "今天的对话尝试次数已用完，请明天再来");
        const worldAttempts =
          (this.state.worldAttemptCarry?.day === today
            ? this.state.worldAttemptCarry.count
            : 0) +
          this.state.accounts.reduce(
            (sum, item) => sum + this.attemptsToday(item, today),
            0,
          );
        if (worldAttempts >= WORLD_DAILY_LIMIT)
          throw new AuthError(429, "今天的全站对话额度已用完，请明天再来");
        const accounts = this.state.accounts.map((item) =>
          item.id === accountId
            ? { ...item, attemptDay: today, attemptCount: attempts + 1 }
            : item,
        );
        const next = { ...this.state, accounts };
        await this.persist(next);
        this.state = next;
      });
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
    const today = dayKey();
    return {
      id: account.id,
      name: account.name,
      remainingToday: Math.max(
        0,
        Math.min(
          USER_DAILY_LIMIT -
            (account.usageDay === today ? account.usageCount : 0),
          USER_DAILY_ATTEMPT_LIMIT - this.attemptsToday(account, today),
        ),
      ),
    };
  }

  private attemptsToday(account: Account, today: string): number {
    return Math.max(
      account.attemptDay === today ? (account.attemptCount ?? 0) : 0,
      account.usageDay === today ? account.usageCount : 0,
    );
  }

  private registrationsToday(today: string): number {
    const persisted =
      this.state.registrationDay === today
        ? (this.state.registrationCount ?? 0)
        : 0;
    const existing = this.state.accounts.filter(
      (account) => dayKey(new Date(account.createdAt)) === today,
    ).length;
    return Math.max(persisted, existing);
  }

  private limitAttempts(key: string, count: number, windowMs: number): void {
    const now = Date.now();
    const recent = (this.attempts.get(key)?.timestamps ?? []).filter(
      (at) => at > now - windowMs,
    );
    if (recent.length >= count)
      throw new AuthError(429, "操作太频繁，请稍后再试");
    recent.push(now);
    if (
      !this.attempts.has(key) &&
      this.attempts.size >= MAX_TRACKED_ATTEMPT_KEYS
    ) {
      if (now >= this.nextAttemptSweep) {
        for (const [trackedKey, entry] of this.attempts) {
          if (entry.expiresAt <= now) this.attempts.delete(trackedKey);
        }
        this.nextAttemptSweep = now + 60_000;
      }
      if (this.attempts.size >= MAX_TRACKED_ATTEMPT_KEYS) {
        const oldest = this.attempts.keys().next().value;
        if (oldest) this.attempts.delete(oldest);
      }
    }
    this.attempts.delete(key);
    this.attempts.set(key, { timestamps: recent, expiresAt: now + windowMs });
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

function activeSessions(
  sessions: Record<string, Session>,
  now: number,
): Record<string, Session> {
  return Object.fromEntries(
    Object.entries(sessions).filter(([, session]) => session.expiresAt > now),
  );
}

function dayKey(date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
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
