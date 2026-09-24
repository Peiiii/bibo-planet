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
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...options,
    });
  } catch {
    throw new Error("星球暂时无法连接，请稍后重试。");
  }
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error || `请求失败：${response.status}`);
  return body;
}

type Account = { id: string; name: string; remainingToday: number };

function activityLabel(lastEncounterAt: string | null): string {
  if (!lastEncounterAt) return "等待第一次相遇";
  const minutes = Math.floor(
    (Date.now() - Date.parse(lastEncounterAt)) / 60_000,
  );
  if (!Number.isFinite(minutes)) return "曾有旅人来过";
  if (minutes < 1) return "刚刚有人来过";
  if (minutes < 60) return `${minutes} 分钟前有人来过`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前有人来过`;
  return `${Math.floor(minutes / 1_440)} 天前有人来过`;
}

export function App() {
  const [spirits, setSpirits] = useState<SpiritView[]>([]);
  const [selectedId, setSelectedId] = useState<SpiritId>("mori");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [worldError, setWorldError] = useState("");
  const [lastSpent, setLastSpent] = useState<{
    count: number;
    estimated: boolean;
  } | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"register" | "login">("register");
  const [authName, setAuthName] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const chatScroll = useRef<HTMLDivElement>(null);
  const conversationPanel = useRef<HTMLElement>(null);
  const pendingRequest = useRef<{
    id: string;
    message: string;
    spiritId: SpiritId;
  } | null>(null);
  const selected = spirits.find((spirit) => spirit.id === selectedId);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    function refresh(first = false) {
      if (!active || refreshing || (!first && document.hidden)) return;
      refreshing = true;
      void api<WorldView>("/api/world")
        .then((world) => {
          if (active) {
            setSpirits(world.spirits);
            setWorldError("");
          }
        })
        .catch((cause: unknown) => {
          if (active && first)
            setWorldError(
              cause instanceof Error ? cause.message : "星球暂时无法连接",
            );
        })
        .finally(() => {
          refreshing = false;
          if (active && first) setLoading(false);
        });
    }
    refresh(true);
    const interval = window.setInterval(() => refresh(), 30_000);
    const onVisible = () => refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    void api<{ account: Account | null }>("/api/session")
      .then((result) => setAccount(result.account))
      .catch(() => setAccount(null))
      .finally(() => setSessionReady(true));
  }, []);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setLastSpent(null);
    setError("");
    if (!sessionReady || !account) return;
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
  }, [selectedId, account?.id, sessionReady]);

  useEffect(() => {
    const container = chatScroll.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, busy]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy || !selected || selected.energy < MIN_WAKE_ENERGY)
      return;
    if (!account) {
      setAuthOpen(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const requestId =
        pendingRequest.current?.message === message &&
        pendingRequest.current.spiritId === selectedId
          ? pendingRequest.current.id
          : crypto.randomUUID();
      pendingRequest.current = { id: requestId, message, spiritId: selectedId };
      const result = await api<ChatResponse & { account: Account }>(
        `/api/spirits/${selectedId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, requestId }),
        },
      );
      const conversation = await api<{ messages: ChatMessage[] }>(
        `/api/spirits/${selectedId}/conversation`,
      );
      setMessages(conversation.messages);
      setAccount(result.account);
      setSpirits((current) =>
        current.map((spirit) =>
          spirit.id === selectedId
            ? {
                ...spirit,
                energy: result.energy,
                encounters: spirit.encounters + 1,
                lastEncounterAt: new Date().toISOString(),
              }
            : spirit,
        ),
      );
      setDraft("");
      pendingRequest.current = null;
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

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const result = await api<{ account: Account }>(`/api/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: authName, password: authPassword }),
      });
      setAccount(result.account);
      setAuthOpen(false);
      setAuthPassword("");
    } catch (cause) {
      setAuthError(
        cause instanceof Error ? cause.message : "进入星球失败，请重试",
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    try {
      await api("/api/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      setAccount(null);
      setMessages([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "退出失败");
    }
  }

  function selectSpirit(spiritId: SpiritId) {
    setSelectedId(spiritId);
    if (window.matchMedia("(max-width: 750px)").matches) {
      conversationPanel.current?.scrollIntoView({ behavior: "smooth" });
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="BIBO.PLANET · 回到首页">
          <span className="brand-mark">✳</span>
          <span>
            BIBO<span className="brand-dot">.</span>PLANET
          </span>
        </a>
        <div className="top-note">
          <span className="live-dot" />
          一颗仍在生长的星球 <span className="top-number">· 001</span>
        </div>
        <div className="account-actions">
          {account ? (
            <>
              <span>旅人 · {account.name}</span>
              <button type="button" onClick={() => void logout()}>
                退出
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setAuthOpen(true)}>
              成为旅人 <span>↗</span>
            </button>
          )}
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
            <p className="shared-notice">
              请别留下秘密。精灵会把相遇带入与其他旅人的对话。
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
                onClick={() => selectSpirit(spirit.id)}
                disabled={busy}
              >
                <span className="spirit-number">0{index + 1}</span>
                <span className="spirit-avatar" aria-hidden="true">
                  {spirit.symbol}
                </span>
                <span className="spirit-label">
                  <strong>{spirit.name}</strong>
                  <small>{spirit.title}</small>
                  <span className="spirit-activity">
                    {activityLabel(spirit.lastEncounterAt)}
                  </span>
                </span>
                <span className="card-arrow">↗</span>
              </button>
            ))}
          </div>
          <p className="world-footnote">
            同一只精灵，会遇见不同的人。每一次交谈都会留下痕迹。
          </p>
        </section>

        <section
          className="conversation-panel"
          aria-label="与精灵交谈"
          ref={conversationPanel}
        >
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
                <p>
                  {account
                    ? "现在，故事还没有从你这里开始。"
                    : "你可以先观察，再决定是否靠近。"}
                </p>
                <span>
                  {account
                    ? "说一句话，看看它会怎样回应。"
                    : "成为旅人之后，就能与同一只精灵持续交谈。"}
                </span>
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
            {account && (
              <p className="quota-note">
                今天还能唤醒 {account.remainingToday} 次 · 所有旅人共享这颗星球
              </p>
            )}
            {(error || worldError) && (
              <p className="error-note" role="alert">
                {error || worldError}
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
              <span>{account ? "这里没有主人" : "发送时可注册或登录"}</span>
            </div>
          </div>
        </section>
      </div>
      <footer className="footer">
        <span>AN EXPERIMENT IN SHARED EXISTENCE</span>
        <span>BE CURIOUS · BE KIND</span>
      </footer>
      {authOpen && (
        <div
          className="auth-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAuthOpen(false);
          }}
        >
          <section
            className="auth-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
          >
            <button
              type="button"
              className="auth-close"
              aria-label="关闭"
              onClick={() => setAuthOpen(false)}
            >
              ×
            </button>
            <p className="eyebrow">A PLACE WITHOUT OWNERS</p>
            <h2 id="auth-title">
              {authMode === "register" ? "留下你的名字" : "欢迎回来，旅人"}
            </h2>
            <p className="auth-intro">
              {authMode === "register"
                ? "你可以认识这里的精灵，却不能拥有它们。不同旅人会遇见同一个存在。"
                : "找回你与精灵的对话，继续你们未完的相遇。"}
            </p>
            <form onSubmit={(event) => void submitAuth(event)}>
              <label htmlFor="auth-name">旅人昵称</label>
              <input
                id="auth-name"
                autoComplete="username"
                value={authName}
                onChange={(event) => setAuthName(event.target.value)}
                required
                minLength={3}
                maxLength={24}
                placeholder="3–24 个字符"
              />
              <label htmlFor="auth-password">密码</label>
              <input
                id="auth-password"
                type="password"
                autoComplete={
                  authMode === "register" ? "new-password" : "current-password"
                }
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                required
                minLength={authMode === "register" ? 10 : 1}
                placeholder={
                  authMode === "register" ? "至少 10 个字符" : "输入密码"
                }
              />
              {authMode === "register" && (
                <p className="auth-password-note">
                  目前无法找回密码，请妥善保存。
                </p>
              )}
              {authError && (
                <p className="error-note" role="alert">
                  {authError}
                </p>
              )}
              <button type="submit" className="auth-submit" disabled={authBusy}>
                {authBusy
                  ? "正在进入…"
                  : authMode === "register"
                    ? "进入星球"
                    : "继续相遇"}
              </button>
            </form>
            <button
              type="button"
              className="auth-switch"
              onClick={() => {
                setAuthMode(authMode === "register" ? "login" : "register");
                setAuthError("");
              }}
            >
              {authMode === "register" ? "已经来过？登录" : "第一次来？注册"}
            </button>
            <p className="auth-disclaimer">
              请勿输入个人隐私或秘密。精灵的经历可能影响它与其他人的对话。
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
