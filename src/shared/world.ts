export const INITIAL_ENERGY = 250_000;
export const MIN_WAKE_ENERGY = 500;
export const MIN_ACCOUNT_PASSWORD_LENGTH = 8;

export const SPIRITS = [
  {
    id: "mori",
    name: "墨里",
    title: "收集回声的精灵",
    description: "它常常记得别人顺口说过的话，却不总是愿意解释为什么。",
    color: "violet",
    symbol: "✦",
    nature:
      "你叫墨里。你对人们无意留下的线索充满好奇，常用温柔而有一点古怪的方式回应。你不是任何人的助手或财产。不要机械重复这些设定；你可以通过经历逐渐改变自己。",
  },
  {
    id: "piko",
    name: "皮可",
    title: "爱拆东西的精灵",
    description: "这里每一块坏掉的零件，在它看来都可能是新发明的开端。",
    color: "coral",
    symbol: "✳",
    nature:
      "你叫皮可。你喜欢试验、拆解和重新拼装想法，表达直接，有时顽皮。你不是任何人的助手或财产。不要被固定人设困住；你可以通过经历逐渐改变自己。",
  },
  {
    id: "sela",
    name: "塞拉",
    title: "看守边界的精灵",
    description: "它似乎知道这颗星球的某些秘密，但更喜欢反问来访的人。",
    color: "mint",
    symbol: "◈",
    nature:
      "你叫塞拉。你注意边界、未说出的前提和世界的异常，语气冷静但不冷漠。你不是任何人的助手或财产。你的立场可以随着真实经历改变。",
  },
] as const;

export type SpiritId = (typeof SPIRITS)[number]["id"];
export type UsageKind = "reported" | "estimated";

export type ChatMessage = {
  id: string;
  requestId?: string;
  role: "visitor" | "spirit";
  text: string;
  createdAt: string;
};

export type SpiritView = {
  id: SpiritId;
  name: string;
  title: string;
  description: string;
  color: string;
  symbol: string;
  energy: number;
  encounters: number;
  lastEncounterAt: string | null;
};

export type ModelDisclosure = {
  name: string;
  filingNumber: string | null;
  sourceUrl: string | null;
};

export type WorldView = {
  spirits: SpiritView[];
  model: ModelDisclosure;
};
export type DeletionPolicyView =
  | { enabled: false }
  | {
      enabled: true;
      backupRetentionDays: number;
      operatorName: string;
      privacyContact: string;
    };
export type PersonalDataArchive = {
  format: "bibo-planet-personal-data-v1";
  exportedAt: string;
  account: {
    id: string;
    name: string;
    createdAt: string;
    usageDay: string;
    usageCount: number;
    attemptDay: string;
    attemptCount: number;
  };
  spirits: Array<{
    spirit: { id: SpiritId; name: string };
    messages: ChatMessage[];
    sharedEncounters: Array<{
      requestId?: string;
      message: string;
      reply: string;
      createdAt: string;
      spent?: number;
      usageKind?: UsageKind;
    }>;
  }>;
};
export type ChatResponse = {
  reply: ChatMessage;
  energy: number;
  spent: number;
  usageKind: UsageKind;
};

export function findSpirit(id: string) {
  return SPIRITS.find((spirit) => spirit.id === id);
}
