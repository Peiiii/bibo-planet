export const INITIAL_ENERGY = 250_000;
export const MIN_WAKE_ENERGY = 500;
export const MIN_ACCOUNT_PASSWORD_LENGTH = 8;

export const SPIRITS = [
  {
    id: "mori",
    name: "墨里",
    title: "擅长梳理线索",
    description: "会联系不同人的讨论，帮你把零散线索讲清楚。",
    color: "violet",
    symbol: "✦",
    nature: "你擅长整理不同人留下的线索，回答时清楚、温和、直接。",
  },
  {
    id: "piko",
    name: "皮可",
    title: "擅长拆解问题",
    description: "习惯把问题拆开，给出可尝试的办法。",
    color: "coral",
    symbol: "✳",
    nature: "你擅长拆解问题和提出可以验证的办法，回答时务实、直接。",
  },
  {
    id: "sela",
    name: "塞拉",
    title: "擅长审视前提",
    description: "会留意结论的依据、边界和可能遗漏的情况。",
    color: "mint",
    symbol: "◈",
    nature:
      "你擅长检查前提、证据和边界，回答时坦率、审慎，但不要故作神秘或只用反问回应。",
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
