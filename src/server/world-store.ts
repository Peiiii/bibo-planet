import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SpiritFiles } from "./spirit-files.ts";
import {
  INITIAL_ENERGY,
  MIN_WAKE_ENERGY,
  SPIRITS,
  findSpirit,
  type ChatMessage,
  type SpiritId,
  type SpiritView,
  type UsageKind,
  type WorldView,
} from "../shared/world.ts";

export type Encounter = {
  requestId?: string;
  visitorId: string;
  message: string;
  reply: string;
  createdAt: string;
  spent?: number;
  usageKind?: UsageKind;
};

type SpiritState = {
  version: 1;
  energy: number;
  encounters: Encounter[];
  conversations: Record<string, ChatMessage[]>;
};

export class EnergyExhaustedError extends Error {
  constructor() {
    super("这个 AI 的 token 额度不足，暂时无法继续对话。");
  }
}

export class WorldStore {
  private readonly states = new Map<SpiritId, SpiritState>();
  private readonly queues = new Map<SpiritId, Promise<unknown>>();
  private readonly suppressedVisitors = new Set<string>();

  readonly files: SpiritFiles;

  constructor(readonly dataDir: string) {
    this.files = new SpiritFiles(dataDir);
  }

  async initialize(requireExisting = false): Promise<void> {
    const saved = await Promise.all(
      SPIRITS.map(async (spirit): Promise<SpiritState | null> => {
        try {
          return JSON.parse(
            await readFile(this.statePath(spirit.id), "utf8"),
          ) as SpiritState;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }),
    );
    if (
      saved.some((state) => state === null) &&
      (requireExisting || saved.some((state) => state !== null))
    )
      throw new Error("精灵状态缺失，拒绝自动重建已有世界");

    for (const [index, spirit] of SPIRITS.entries()) {
      const state = saved[index];
      if (state) {
        if (state.version !== 1 || !Number.isSafeInteger(state.energy))
          throw new Error(`无效的精灵状态：${spirit.id}`);
        this.states.set(spirit.id, state);
        continue;
      }
      await mkdir(join(this.dataDir, "spirits", spirit.id), {
        recursive: true,
      });
      const initial: SpiritState = {
        version: 1,
        energy: INITIAL_ENERGY,
        encounters: [],
        conversations: {},
      };
      await this.persist(spirit.id, initial);
      this.states.set(spirit.id, initial);
    }
  }

  world(): Pick<WorldView, "spirits"> {
    return {
      spirits: SPIRITS.map((spirit): SpiritView => {
        const state = this.requireState(spirit.id);
        const encounters = this.visibleEncounters(spirit.id);
        return {
          id: spirit.id,
          name: spirit.name,
          title: spirit.title,
          description: spirit.description,
          color: spirit.color,
          symbol: spirit.symbol,
          energy: state.energy,
          encounters: encounters.length,
          lastEncounterAt: encounters.at(-1)?.createdAt ?? null,
        };
      }),
    };
  }

  conversation(spiritId: SpiritId, visitorId: string): ChatMessage[] {
    if (this.suppressedVisitors.has(visitorId)) return [];
    return [...(this.requireState(spiritId).conversations[visitorId] ?? [])];
  }

  visitorData(visitorId: string) {
    return SPIRITS.map((spirit) => {
      return {
        spirit: { id: spirit.id, name: spirit.name },
        messages: this.conversation(spirit.id, visitorId),
        sharedEncounters: this.visibleEncounters(spirit.id)
          .filter((encounter) => encounter.visitorId === visitorId)
          .map(({ visitorId: _visitorId, ...encounter }) => encounter),
      };
    });
  }

  completedRequest(
    spiritId: SpiritId,
    visitorId: string,
    requestId: string,
  ): {
    reply: ChatMessage;
    energy: number;
    spent: number;
    usageKind: UsageKind;
    replayed: true;
  } | null {
    if (this.suppressedVisitors.has(visitorId)) return null;
    const state = this.requireState(spiritId);
    const messages = state.conversations[visitorId] ?? [];
    const index = messages.findIndex(
      (item) => item.role === "visitor" && item.requestId === requestId,
    );
    const reply = messages[index + 1];
    const encounter = state.encounters.find(
      (item) => item.requestId === requestId && item.visitorId === visitorId,
    );
    if (
      index < 0 ||
      !reply ||
      reply.role !== "spirit" ||
      !encounter?.spent ||
      !encounter.usageKind
    )
      return null;
    return {
      reply,
      energy: state.energy,
      spent: encounter.spent,
      usageKind: encounter.usageKind,
      replayed: true,
    };
  }

  recentEncounters(spiritId: SpiritId, limit = 8): Encounter[] {
    return this.visibleEncounters(spiritId).slice(-limit);
  }

  relevantEncounters = (spiritId: SpiritId, query: string): Encounter[] => {
    const cues = this.recallCues(query);
    if (cues.length === 0) return [];
    return this.visibleEncounters(spiritId)
      .map((encounter, index) => {
        const text =
          `${encounter.message.slice(0, 400)} ${encounter.reply.slice(0, 400)}`
            .normalize("NFKC")
            .toLowerCase();
        const words = new Set(text.match(/[a-z0-9]{3,}/g) ?? []);
        const score = cues.reduce(
          (sum, cue) =>
            sum +
            (cue.kind === "han"
              ? Number(text.includes(cue.text))
              : Number(words.has(cue.text))),
          0,
        );
        return { encounter, index, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, 4)
      .map((item) => item.encounter);
  };

  energy(spiritId: SpiritId): number {
    return this.requireState(spiritId).energy;
  }

  assertCanWake(spiritId: SpiritId): void {
    if (this.energy(spiritId) < MIN_WAKE_ENERGY)
      throw new EnergyExhaustedError();
  }

  async withSpiritLock<T>(
    spiritId: SpiritId,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(spiritId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.queues.set(spiritId, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(spiritId) === current) this.queues.delete(spiritId);
    }
  }

  async recordTurn(input: {
    requestId?: string;
    spiritId: SpiritId;
    visitorId: string;
    message: string;
    reply: string;
    spent: number;
    usageKind: UsageKind;
  }): Promise<{ reply: ChatMessage; energy: number }> {
    const { spiritId, visitorId, message, reply, spent, usageKind, requestId } =
      input;
    if (this.suppressedVisitors.has(visitorId))
      throw new Error("正在删除的旅人不能留下新记录");
    if (!Number.isSafeInteger(spent) || spent < 1)
      throw new Error("无效的能量消耗");
    const old = this.requireState(spiritId);
    const createdAt = new Date().toISOString();
    const visitorMessage: ChatMessage = {
      id: randomUUID(),
      ...(requestId ? { requestId } : {}),
      role: "visitor",
      text: message,
      createdAt,
    };
    const spiritMessage: ChatMessage = {
      id: randomUUID(),
      role: "spirit",
      text: reply,
      createdAt,
    };
    const next: SpiritState = {
      ...old,
      energy: Math.max(0, old.energy - spent),
      encounters: [
        ...old.encounters,
        { requestId, visitorId, message, reply, createdAt, spent, usageKind },
      ],
      conversations: {
        ...old.conversations,
        [visitorId]: [
          ...(old.conversations[visitorId] ?? []),
          visitorMessage,
          spiritMessage,
        ],
      },
    };
    await this.persist(spiritId, next);
    this.states.set(spiritId, next);
    return { reply: spiritMessage, energy: next.energy };
  }

  suppressVisitor(visitorId: string): void {
    this.suppressedVisitors.add(visitorId);
  }

  async removeVisitorData(visitorId: string): Promise<void> {
    this.suppressVisitor(visitorId);
    for (const spirit of SPIRITS) {
      await this.withSpiritLock(spirit.id, async () => {
        const old = this.requireState(spirit.id);
        const encounters = old.encounters.filter(
          (encounter) => encounter.visitorId !== visitorId,
        );
        if (
          encounters.length === old.encounters.length &&
          !Object.hasOwn(old.conversations, visitorId)
        )
          return;
        const conversations = { ...old.conversations };
        delete conversations[visitorId];
        const next = { ...old, encounters, conversations };
        await this.persist(spirit.id, next);
        this.states.set(spirit.id, next);
      });
    }
  }

  async scrubSharedContentForDeletion(
    fingerprint: string,
    restoredAccountPresent = false,
  ): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(fingerprint))
      throw new Error("无效的删除记录指纹");
    const directory = join(this.dataDir, "workspace", "agents");
    const path = join(directory, ".deletion-scrub.json");
    let applied: string | undefined;
    try {
      if (!(await lstat(path)).isFile())
        throw new Error("删除清理标记不是普通文件");
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        version?: unknown;
        fingerprint?: unknown;
      };
      if (parsed?.version === 1 && typeof parsed.fingerprint === "string")
        applied = parsed.fingerprint;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
    if (applied === fingerprint && !restoredAccountPresent) return;
    for (const spirit of SPIRITS) {
      await this.withSpiritLock(spirit.id, async () => {
        // These shared contents cannot be safely attributed to one visitor.
        await this.files.clearSharedFiles(spirit.id);
        await this.replaceMemory(spirit.id, "");
      });
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, fingerprint }), {
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  async readMemory(spiritId: SpiritId): Promise<string> {
    const path = this.memoryPath(spiritId);
    try {
      if (!(await lstat(path)).isFile())
        throw new Error(`无效的 AI 记忆文件：${spiritId}`);
      const content = await readFile(path, "utf8");
      if (content.length > 8_000)
        throw new Error(`AI 记忆超过长度上限：${spiritId}`);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async replaceMemory(spiritId: SpiritId, content: string): Promise<void> {
    if (
      !findSpirit(spiritId) ||
      typeof content !== "string" ||
      content.length > 8_000
    )
      throw new Error("无效的 AI 共享记忆");
    const path = this.memoryPath(spiritId);
    await mkdir(join(this.dataDir, "workspace", "agents", spiritId), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  }

  async credit(spiritId: SpiritId, amount: number): Promise<number> {
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new Error("补充数量必须为正整数");
    return await this.withSpiritLock(spiritId, async () => {
      const old = this.requireState(spiritId);
      const next = { ...old, energy: old.energy + amount };
      if (!Number.isSafeInteger(next.energy)) throw new Error("能量数值溢出");
      await this.persist(spiritId, next);
      this.states.set(spiritId, next);
      return next.energy;
    });
  }

  private requireState(spiritId: SpiritId): SpiritState {
    const state = this.states.get(spiritId);
    if (!state || !findSpirit(spiritId))
      throw new Error(`未知精灵：${spiritId}`);
    return state;
  }

  private visibleEncounters(spiritId: SpiritId): Encounter[] {
    return this.requireState(spiritId).encounters.filter(
      (encounter) => !this.suppressedVisitors.has(encounter.visitorId),
    );
  }

  private statePath(spiritId: SpiritId): string {
    return join(this.dataDir, "spirits", spiritId, "state.json");
  }

  private memoryPath(spiritId: SpiritId): string {
    if (!findSpirit(spiritId)) throw new Error(`未知 AI：${spiritId}`);
    return join(this.dataDir, "workspace", "agents", spiritId, "MEMORY.md");
  }

  private async persist(spiritId: SpiritId, state: SpiritState): Promise<void> {
    const path = this.statePath(spiritId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, path);
  }

  private recallCues = (
    query: string,
  ): Array<{ text: string; kind: "han" | "word" }> => {
    const topical = query
      .normalize("NFKC")
      .toLowerCase()
      .replace(/你还记得|还记得吗|有人说过|我们聊过|之前提到|你知道吗/g, " ");
    const cues = new Map<string, { text: string; kind: "han" | "word" }>();
    for (const run of topical.match(/\p{Script=Han}+/gu) ?? []) {
      for (let index = 0; index <= run.length - 4; index += 1) {
        const text = run.slice(index, index + 4);
        cues.set(`han:${text}`, { text, kind: "han" });
      }
    }
    for (const word of topical.match(/[a-z0-9]{3,}/g) ?? []) {
      if (
        ["remember", "before", "about", "there", "what", "with"].includes(word)
      )
        continue;
      cues.set(`word:${word}`, { text: word, kind: "word" });
    }
    return [...cues.values()].slice(-64);
  };
}
