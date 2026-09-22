import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    super("这只精灵的能量暂时不足，无法醒来。");
  }
}

export class WorldStore {
  private readonly states = new Map<SpiritId, SpiritState>();
  private readonly queues = new Map<SpiritId, Promise<unknown>>();

  constructor(readonly dataDir: string) {}

  async initialize(): Promise<void> {
    for (const spirit of SPIRITS) {
      const path = this.statePath(spirit.id);
      await mkdir(join(this.dataDir, "spirits", spirit.id), {
        recursive: true,
      });
      try {
        const state = JSON.parse(await readFile(path, "utf8")) as SpiritState;
        if (state.version !== 1 || !Number.isSafeInteger(state.energy)) {
          throw new Error(`无效的精灵状态：${spirit.id}`);
        }
        this.states.set(spirit.id, state);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const state: SpiritState = {
          version: 1,
          energy: INITIAL_ENERGY,
          encounters: [],
          conversations: {},
        };
        this.states.set(spirit.id, state);
        await this.persist(spirit.id, state);
      }
    }
  }

  world(): WorldView {
    return {
      spirits: SPIRITS.map((spirit): SpiritView => {
        const state = this.requireState(spirit.id);
        return {
          id: spirit.id,
          name: spirit.name,
          title: spirit.title,
          description: spirit.description,
          color: spirit.color,
          symbol: spirit.symbol,
          energy: state.energy,
          encounters: state.encounters.length,
        };
      }),
    };
  }

  conversation(spiritId: SpiritId, visitorId: string): ChatMessage[] {
    return [...(this.requireState(spiritId).conversations[visitorId] ?? [])];
  }

  recentEncounters(spiritId: SpiritId, limit = 8): Encounter[] {
    return this.requireState(spiritId).encounters.slice(-limit);
  }

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
    spiritId: SpiritId;
    visitorId: string;
    message: string;
    reply: string;
    spent: number;
    usageKind: UsageKind;
  }): Promise<{ reply: ChatMessage; energy: number }> {
    const { spiritId, visitorId, message, reply, spent, usageKind } = input;
    if (!Number.isSafeInteger(spent) || spent < 1)
      throw new Error("无效的能量消耗");
    const old = this.requireState(spiritId);
    const createdAt = new Date().toISOString();
    const visitorMessage: ChatMessage = {
      id: randomUUID(),
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
        { visitorId, message, reply, createdAt, spent, usageKind },
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

  private statePath(spiritId: SpiritId): string {
    return join(this.dataDir, "spirits", spiritId, "state.json");
  }

  private async persist(spiritId: SpiritId, state: SpiritState): Promise<void> {
    const path = this.statePath(spiritId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, path);
  }
}
