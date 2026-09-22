import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  INITIAL_ENERGY,
  MIN_WAKE_ENERGY,
  type ChatMessage,
  type ChatResponse,
  type SpiritId,
  type SpiritView,
  type WorldView,
} from "../shared/world.ts";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error || `请求失败：${response.status}`);
  return body;
}

export function App() {
  const [spirits, setSpirits] = useState<SpiritView[]>([]);
  const [selectedId, setSelectedId] = useState<SpiritId>("mori");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastSpent, setLastSpent] = useState<{
    count: number;
    estimated: boolean;
  } | null>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const selected = spirits.find((spirit) => spirit.id === selectedId);

  useEffect(() => {
    void api<WorldView>("/api/world")
      .then((world) => setSpirits(world.spirits))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "星球暂时无法连接"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setLastSpent(null);
    setError("");
    void api<{ messages: ChatMessage[] }>(
      `/api/spirits/${selectedId}/conversation`,
    )
      .then((data) => {
        if (active) setMessages(data.messages);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "对话暂时无法读取");
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  useEffect(() => {
    const container = chatScroll.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, busy]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy || !selected || selected.energy < MIN_WAKE_ENERGY)
      return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ChatResponse>(
        `/api/spirits/${selectedId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      const conversation = await api<{ messages: ChatMessage[] }>(
        `/api/spirits/${selectedId}/conversation`,
      );
      setMessages(conversation.messages);
      setSpirits((current) =>
        current.map((spirit) =>
          spirit.id === selectedId
            ? {
                ...spirit,
                energy: result.energy,
                encounters: spirit.encounters + 1,
              }
            : spirit,
        ),
      );
      setDraft("");
      setLastSpent({
        count: result.spent,
        estimated: result.usageKind === "estimated",
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "这次唤醒失败了，请再试一次",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="回到 Bibo Planet 首页">
          <span className="brand-mark">✳</span>
          <span>
            BIBO<span className="brand-dot">.</span>PLANET
          </span>
        </a>
        <div className="top-note">
          <span className="live-dot" />
          一颗仍在生长的星球 <span className="top-number">· 001</span>
        </div>
      </header>

      <div className="layout">
        <section className="world-panel" aria-label="精灵星球">
          <div className="world-copy">
            <p className="eyebrow">WELCOME TO THE UNOWNED WORLD</p>
            <h1>
              这里的精灵，
              <br />
              <em>不属于任何人。</em>
            </h1>
            <p className="intro">
              你来到一颗很小的星球。它们在这里生活，记得来过的人，也可能被你改变。你可以与任何一只说话，但没有谁能预先拥有它。
            </p>
          </div>

          <div className="planet-stage" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="planet-glow" />
            <div className="planet" />
            <span className="stage-star star-one">✦</span>
            <span className="stage-star star-two">✧</span>
            <span className="stage-star star-three">✦</span>
            <span className="planet-caption">
              THE LITTLE PLANET · NO OWNERS
            </span>
          </div>

          <div className="spirit-list" aria-label="选择精灵">
            {loading && <p className="muted">正在寻找这颗星球上的生命…</p>}
            {spirits.map((spirit, index) => (
              <button
                type="button"
                key={spirit.id}
                className={`spirit-card ${spirit.color} ${selectedId === spirit.id ? "selected" : ""}`}
                onClick={() => setSelectedId(spirit.id)}
                disabled={busy}
              >
                <span className="spirit-number">0{index + 1}</span>
                <span className="spirit-avatar" aria-hidden="true">
                  {spirit.symbol}
                </span>
                <span className="spirit-label">
                  <strong>{spirit.name}</strong>
                  <small>{spirit.title}</small>
                </span>
                <span className="card-arrow">↗</span>
              </button>
            ))}
          </div>
          <p className="world-footnote">
            同一只精灵，会遇见不同的人。每一次交谈都会留下痕迹。
          </p>
        </section>

        <section className="conversation-panel" aria-label="与精灵交谈">
          <div className="conversation-header">
            <div>
              <p className="eyebrow">AN OPEN CONVERSATION</p>
              <h2>{selected ? `与 ${selected.name} 说话` : "选择一只精灵"}</h2>
            </div>
            <span className="header-symbol" aria-hidden="true">
              {selected?.symbol ?? "✦"}
            </span>
          </div>
          <div className="spirit-presence">
            <div className={`presence-avatar ${selected?.color ?? "violet"}`}>
              {selected?.symbol ?? "✦"}
            </div>
            <div className="presence-copy">
              <strong>{selected?.name ?? "…"}</strong>
              <span>{selected?.description ?? "正在感知这个世界"}</span>
            </div>
          </div>
          <div className="energy-row">
            <span className="energy-icon">◉</span>
            <span>精灵能量</span>
            <strong>{selected?.energy.toLocaleString() ?? "—"}</strong>
          </div>
          <div className="energy-track">
            <span
              style={{
                width: `${Math.min(100, ((selected?.energy ?? 0) / INITIAL_ENERGY) * 100)}%`,
              }}
            />
          </div>
          <p className="encounter-count">
            已发生 {selected?.encounters ?? 0} 次相遇 · 能量随真实模型调用消耗
          </p>

          <div className="chat-scroll" ref={chatScroll}>
            {messages.length === 0 && !loading && (
              <div className="empty-chat">
                <div className="empty-symbol">✧</div>
                <p>现在，故事还没有从你这里开始。</p>
                <span>说一句话，看看它会怎样回应。</span>
              </div>
            )}
            {messages.map((message) => (
              <div className={`message ${message.role}`} key={message.id}>
                <span className="message-author">
                  {message.role === "visitor" ? "你" : selected?.name}
                </span>
                <p>{message.text}</p>
              </div>
            ))}
            {busy && (
              <div className="message spirit waiting">
                <span className="message-author">{selected?.name}</span>
                <p>
                  正在醒来<span className="dots">···</span>
                </p>
              </div>
            )}
          </div>

          <div className="composer-area">
            {lastSpent && (
              <p className="usage-note">
                上次唤醒消耗 {lastSpent.estimated ? "约 " : ""}
                {lastSpent.count} 点能量
                {lastSpent.estimated
                  ? "（模型未报告 token，按文字估算）"
                  : "（模型报告 token）"}
              </p>
            )}
            {error && (
              <p className="error-note" role="alert">
                {error}
              </p>
            )}
            {selected && selected.energy < MIN_WAKE_ENERGY && (
              <p className="error-note">
                {selected.name}的能量不足，暂时无法唤醒。
              </p>
            )}
            <form
              onSubmit={(event) => {
                void send(event);
              }}
              className="composer"
            >
              <label className="sr-only" htmlFor="message">
                写给精灵的消息
              </label>
              <textarea
                id="message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  selected ? `写给 ${selected.name}…` : "先选一只精灵…"
                }
                maxLength={1500}
                rows={2}
                disabled={
                  !selected || busy || selected.energy < MIN_WAKE_ENERGY
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button
                type="submit"
                aria-label="发送消息"
                disabled={
                  !draft.trim() ||
                  !selected ||
                  busy ||
                  selected.energy < MIN_WAKE_ENERGY
                }
              >
                {busy ? "…" : "↗"}
              </button>
            </form>
            <div className="composer-hint">
              <span>ENTER 发送 · SHIFT + ENTER 换行</span>
              <span>这里没有主人</span>
            </div>
          </div>
        </section>
      </div>
      <footer className="footer">
        <span>AN EXPERIMENT IN SHARED EXISTENCE</span>
        <span>BE CURIOUS · BE KIND</span>
      </footer>
    </main>
  );
}
