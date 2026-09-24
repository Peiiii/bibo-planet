import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  INITIAL_ENERGY,
  MIN_ACCOUNT_PASSWORD_LENGTH,
  MIN_WAKE_ENERGY,
  type ChatMessage,
  type ChatResponse,
  type DeletionPolicyView,
  type ModelDisclosure,
  type PersonalDataArchive,
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
    throw new Error("暂时无法连接服务，请稍后重试。");
  }
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new ApiError(
      body.error || `请求失败：${response.status}`,
      response.status,
    );
  return body;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Account = { id: string; name: string; remainingToday: number };

const sharedMemoryNotice =
  "你发送的内容可能进入共同上下文或 AI 的共享文件，其他用户可能间接获知。请勿输入隐私或秘密。";

function handleDialogKeys(
  event: KeyboardEvent<HTMLElement>,
  close: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled)",
    ),
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function activityLabel(
  lastEncounterAt: string | null,
  compact = false,
): string {
  if (!lastEncounterAt) return compact ? "暂无对话" : "还没有对话";
  const minutes = Math.floor(
    (Date.now() - Date.parse(lastEncounterAt)) / 60_000,
  );
  if (!Number.isFinite(minutes)) return compact ? "已有对话" : "有人使用过";
  if (minutes < 1) return compact ? "刚刚" : "刚刚有人对话";
  if (minutes < 60)
    return compact ? `${minutes}分钟前` : `${minutes} 分钟前有人对话`;
  if (minutes < 1_440)
    return compact
      ? `${Math.floor(minutes / 60)}小时前`
      : `${Math.floor(minutes / 60)} 小时前有人对话`;
  return compact
    ? `${Math.floor(minutes / 1_440)}天前`
    : `${Math.floor(minutes / 1_440)} 天前有人对话`;
}

export function renderSpiritText(text: string) {
  return text
    .split(/(\*\*[^*\n]+\*\*)/g)
    .map((part, index) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
}

export function appendCompletedTurn(
  messages: ChatMessage[],
  message: string,
  requestId: string,
  reply: ChatMessage,
): ChatMessage[] {
  if (
    messages.some(
      (item) => item.role === "visitor" && item.requestId === requestId,
    )
  )
    return messages;
  return [
    ...messages,
    {
      id: requestId,
      requestId,
      role: "visitor",
      text: message,
      createdAt: reply.createdAt,
    },
    reply,
  ];
}

export function mergeConversationHistory(
  persisted: ChatMessage[],
  visible: ChatMessage[],
): ChatMessage[] {
  let merged = persisted;
  for (let index = 0; index < visible.length - 1; index += 1) {
    const visitor = visible[index];
    const reply = visible[index + 1];
    if (
      visitor?.role === "visitor" &&
      visitor.requestId &&
      visitor.id === visitor.requestId &&
      reply?.role === "spirit"
    ) {
      merged = appendCompletedTurn(
        merged,
        visitor.text,
        visitor.requestId,
        reply,
      );
    }
  }
  return merged;
}

export function App() {
  const [spirits, setSpirits] = useState<SpiritView[]>([]);
  const [modelDisclosure, setModelDisclosure] =
    useState<ModelDisclosure | null>(null);
  const [selectedId, setSelectedId] = useState<SpiritId>("mori");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [worldRetry, setWorldRetry] = useState(0);
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
  const [exporting, setExporting] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [deletionPolicy, setDeletionPolicy] =
    useState<DeletionPolicyView | null>(null);
  const [accountError, setAccountError] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletionComplete, setDeletionComplete] = useState(false);
  const [deletionPending, setDeletionPending] = useState<
    "pending" | "unknown" | null
  >(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const conversationPanel = useRef<HTMLElement>(null);
  const authNameInput = useRef<HTMLInputElement>(null);
  const accountCloseButton = useRef<HTMLButtonElement>(null);
  const pendingRequest = useRef<{
    id: string;
    message: string;
    spiritId: SpiritId;
  } | null>(null);
  const selected = spirits.find((spirit) => spirit.id === selectedId);

  useEffect(() => {
    if (!authOpen) return;
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [authOpen]);

  useEffect(() => {
    if (authOpen) authNameInput.current?.focus();
  }, [authOpen, authMode]);

  useEffect(() => {
    if (!accountOpen) return;
    let active = true;
    const previous = document.activeElement;
    accountCloseButton.current?.focus();
    void api<DeletionPolicyView>("/api/account/deletion-policy")
      .then((policy) => {
        if (active) setDeletionPolicy(policy);
      })
      .catch(() => {
        if (active) setAccountError("暂时无法读取账号删除状态，请稍后重试。");
      });
    return () => {
      active = false;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
      else document.querySelector<HTMLElement>(".brand")?.focus();
    };
  }, [accountOpen]);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    let pending: AbortController | null = null;
    function refresh(first = false) {
      if (!active || refreshing || (!first && document.hidden)) return;
      refreshing = true;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 20_000);
      void api<WorldView>("/api/world", { signal: controller.signal })
        .then((world) => {
          if (active) {
            setSpirits(world.spirits);
            setModelDisclosure(world.model);
            setWorldError("");
          }
        })
        .catch(() => {
          if (active && first) setWorldError("AI 列表暂时无法加载，请重试。");
        })
        .finally(() => {
          window.clearTimeout(timeout);
          if (pending === controller) pending = null;
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
      pending?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [worldRetry]);

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
        if (active)
          setMessages((current) =>
            mergeConversationHistory(data.messages, current),
          );
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
      const result = await api<
        ChatResponse & { account: Account; spirit: SpiritView }
      >(`/api/spirits/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, requestId }),
      });
      setMessages((current) =>
        appendCompletedTurn(current, message, requestId, result.reply),
      );
      setAccount(result.account);
      setSpirits((current) =>
        current.map((spirit) =>
          spirit.id === selectedId ? result.spirit : spirit,
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
        cause instanceof Error ? cause.message : "这次对话失败了，请再试一次",
      );
      try {
        const session = await api<{ account: Account | null }>("/api/session");
        setAccount(session.account);
      } catch {
        // 会话检查也失败时，保留已有账号显示。
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    if (
      authMode === "register" &&
      Array.from(authPassword).length < MIN_ACCOUNT_PASSWORD_LENGTH
    ) {
      setAuthError(`密码至少需要 ${MIN_ACCOUNT_PASSWORD_LENGTH} 个字符`);
      return;
    }
    setAuthBusy(true);
    try {
      const result = await api<{ account: Account }>(`/api/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: authName, password: authPassword }),
      });
      setAccount(result.account);
      closeAuth();
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "登录失败，请重试");
    } finally {
      setAuthBusy(false);
    }
  }

  function closeAuth() {
    setAuthOpen(false);
    setAuthPassword("");
    setAuthError("");
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

  function openAccountData() {
    setDeletionPolicy(null);
    setAccountError("");
    setDeletePassword("");
    setDeleteConfirmed(false);
    setDeletionComplete(false);
    setDeletionPending(null);
    setAccountOpen(true);
  }

  function closeAccountData() {
    if (exporting || deleting) return;
    setAccountOpen(false);
    setDeletePassword("");
    setDeleteConfirmed(false);
    setAccountError("");
  }

  async function exportPersonalData() {
    if (!account || exporting) return;
    if (
      !window.confirm(
        "导出的文件包含你的私人对话，请只保存到安全的位置。继续导出吗？",
      )
    )
      return;
    setExporting(true);
    setAccountError("");
    try {
      const archive = await api<PersonalDataArchive>("/api/account/data");
      const blob = new Blob([JSON.stringify(archive, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `bibo-planet-my-data-${archive.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) {
      setAccountError(
        `导出未完成：${cause instanceof Error ? cause.message : "请稍后重试"}`,
      );
    } finally {
      setExporting(false);
    }
  }

  async function submitDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !account ||
      !deletionPolicy?.enabled ||
      !deleteConfirmed ||
      deleting ||
      exporting
    )
      return;
    setDeleting(true);
    setAccountError("");
    try {
      await api<{ account: null; deleted: true }>("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deletePassword, confirm: true }),
      });
      setAccount(null);
      setMessages([]);
      setDraft("");
      pendingRequest.current = null;
      setDeletePassword("");
      setDeleteConfirmed(false);
      setDeletionComplete(true);
      void api<WorldView>("/api/world")
        .then((world) => setSpirits(world.spirits))
        .catch(() => undefined);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "删除尚未完成，请稍后重试。";
      setAccountError(message);
      try {
        const session = await api<{ account: Account | null }>("/api/session");
        if (!session.account) {
          setAccount(null);
          setDeletionPending(
            cause instanceof ApiError && cause.status === 503
              ? "pending"
              : "unknown",
          );
        }
      } catch {
        // 网络失联时保留当前身份，不把未知状态冒充为删除成功。
      }
    } finally {
      setDeleting(false);
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
          多人共享的 AI <span className="top-number">· BETA</span>
        </div>
        <div className="account-actions">
          {account ? (
            <>
              <span>用户 · {account.name}</span>
              <button
                type="button"
                onClick={openAccountData}
                disabled={exporting || busy || deleting}
              >
                账号与数据
              </button>
              <button
                type="button"
                onClick={() => void logout()}
                disabled={exporting || busy}
              >
                退出
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setAuthOpen(true)}>
              注册 <span>↗</span>
            </button>
          )}
        </div>
      </header>

      <div className="layout">
        <section className="world-panel" aria-label="共享 AI">
          <div className="world-copy">
            <p className="eyebrow">ONE AI, MANY PEOPLE</p>
            <h1>
              同一个 AI，
              <br />
              <em>和不同的人交流。</em>
            </h1>
            <p className="intro">
              墨里、皮可和塞拉是三个持续存在的共享
              AI。你可以与任何一个对话；它们会参考相关的共同记录，但你的原始对话只在你的账号里展示。
            </p>
            <p className="shared-notice">{sharedMemoryNotice}</p>
          </div>

          <div className="shared-stage" aria-label="多人使用同一个 AI 的示意">
            <div className="shared-stage-people">
              <span>用户 A</span>
              <span>用户 B</span>
              <span>用户 C</span>
            </div>
            <div className="shared-stage-connection" aria-hidden="true" />
            <div className="shared-stage-center">
              <strong>同一个共享 AI</strong>
              <small>相关线索可以延续</small>
            </div>
            <p>私人对话分别保存 · 共同记录可能影响回答</p>
          </div>

          <div className="spirit-list" aria-label="选择 AI">
            {loading && <p className="muted">正在加载 AI…</p>}
            {worldError && (
              <div className="world-load-error" role="alert">
                <span>{worldError}</span>
                <button
                  type="button"
                  onClick={() => {
                    setWorldError("");
                    setLoading(true);
                    setWorldRetry((current) => current + 1);
                  }}
                >
                  重试
                </button>
              </div>
            )}
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
                  <span className="spirit-activity activity-full">
                    {activityLabel(spirit.lastEncounterAt)}
                  </span>
                  <span className="spirit-activity activity-compact">
                    {activityLabel(spirit.lastEncounterAt, true)}
                  </span>
                </span>
                <span className="card-arrow">↗</span>
              </button>
            ))}
          </div>
          <p className="world-footnote">
            每个 AI
            都由不同用户共同使用，也能整理自己的共享文本文件。试着问它：「当前目录有哪些文件？」
          </p>
        </section>

        <section
          className="conversation-panel"
          aria-label="与 AI 交谈"
          ref={conversationPanel}
        >
          <div className="conversation-header">
            <div>
              <p className="eyebrow">共享 AI · 回复由模型生成</p>
              <h2>{selected ? `与 ${selected.name} 对话` : "选择一个 AI"}</h2>
              {modelDisclosure && (
                <p className="model-disclosure">
                  模型：{modelDisclosure.name}
                  {modelDisclosure.filingNumber ? (
                    <> · 备案号 {modelDisclosure.filingNumber}</>
                  ) : (
                    <> · 备案信息待核定</>
                  )}
                  {modelDisclosure.sourceUrl && (
                    <>
                      {" "}
                      <a
                        href={modelDisclosure.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {modelDisclosure.filingNumber
                          ? "公示来源 ↗"
                          : "模型资料 ↗"}
                      </a>
                    </>
                  )}
                </p>
              )}
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
              <span>{selected?.description ?? "选择一个 AI 开始对话"}</span>
            </div>
          </div>
          <div className="energy-row">
            <span className="energy-icon">◉</span>
            <span>可用 token 额度</span>
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
            已完成 {selected?.encounters ?? 0} 次对话 · 额度按模型 token
            用量消耗
          </p>

          <div className="chat-scroll" ref={chatScroll}>
            {messages.length === 0 && !loading && (
              <div className="empty-chat">
                <div className="empty-symbol">✧</div>
                <p>
                  {account
                    ? "这里还没有你的对话。"
                    : "选一个 AI，看看它擅长什么。"}
                </p>
                <span>
                  {account
                    ? "输入真实问题，或问它：当前目录有哪些文件？"
                    : "注册后可以继续自己的对话。"}
                </span>
              </div>
            )}
            {messages.map((message) => (
              <div className={`message ${message.role}`} key={message.id}>
                <span className="message-author">
                  {message.role === "visitor" ? "你" : selected?.name}
                  {message.role === "spirit" && (
                    <span className="ai-origin">AI 生成</span>
                  )}
                </span>
                <p>
                  {message.role === "spirit"
                    ? renderSpiritText(message.text)
                    : message.text}
                </p>
              </div>
            ))}
            {busy && (
              <div className="message spirit waiting">
                <span className="message-author">{selected?.name}</span>
                <p>
                  正在回答<span className="dots">···</span>
                </p>
              </div>
            )}
          </div>

          <div className="composer-area">
            {lastSpent && (
              <p className="usage-note">
                上次回复消耗 {lastSpent.estimated ? "约 " : ""}
                {lastSpent.count} token
                {lastSpent.estimated
                  ? "（模型未报告 token，按文字估算）"
                  : "（模型报告 token）"}
              </p>
            )}
            {account && (
              <p className="quota-note">
                今天还可尝试对话 {account.remainingToday} 次 ·
                失败尝试也占用资源预算
              </p>
            )}
            {error && (
              <p className="error-note" role="alert">
                {error}
              </p>
            )}
            {selected && selected.energy < MIN_WAKE_ENERGY && (
              <p className="error-note">
                {selected.name}的 token 额度不足，暂时无法继续对话。
              </p>
            )}
            <form
              onSubmit={(event) => {
                void send(event);
              }}
              className="composer"
            >
              <label className="sr-only" htmlFor="message">
                发送给 AI 的消息
              </label>
              <textarea
                id="message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  selected ? `发送给 ${selected.name}…` : "先选一个 AI…"
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
        <span>SHARED AI · PRIVATE ACCOUNTS</span>
        <span>REAL ANSWERS · SHARED CONTEXT</span>
      </footer>
      {authOpen && (
        <div
          className="auth-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAuth();
          }}
        >
          <section
            className="auth-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
            onKeyDown={(event) => handleDialogKeys(event, closeAuth)}
          >
            <button
              type="button"
              className="auth-close"
              aria-label="关闭"
              onClick={closeAuth}
            >
              ×
            </button>
            <p className="eyebrow">SHARED AI</p>
            <h2 id="auth-title">
              {authMode === "register" ? "创建账号" : "欢迎回来"}
            </h2>
            <p className="auth-intro">
              {authMode === "register"
                ? "不同用户可以与同一个 AI 对话。你的原始对话只在你的账号里展示。"
                : "登录后继续你之前的对话。"}
            </p>
            <form onSubmit={(event) => void submitAuth(event)}>
              <label htmlFor="auth-name">昵称</label>
              <input
                id="auth-name"
                ref={authNameInput}
                autoComplete="username"
                value={authName}
                onChange={(event) => {
                  setAuthName(event.target.value);
                  setAuthError("");
                }}
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
                onChange={(event) => {
                  setAuthPassword(event.target.value);
                  setAuthError("");
                }}
                required
                minLength={1}
                placeholder={
                  authMode === "register"
                    ? `至少 ${MIN_ACCOUNT_PASSWORD_LENGTH} 个字符`
                    : "输入密码"
                }
              />
              {authMode === "register" && (
                <p className="auth-password-note">
                  建议使用更长的密码；目前无法找回，请妥善保存。
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
                    ? "创建账号"
                    : "登录"}
              </button>
            </form>
            <button
              type="button"
              className="auth-switch"
              onClick={() => {
                setAuthMode(authMode === "register" ? "login" : "register");
                setAuthPassword("");
                setAuthError("");
              }}
            >
              {authMode === "register" ? "已经来过？登录" : "第一次来？注册"}
            </button>
            <p className="auth-disclaimer">{sharedMemoryNotice}</p>
          </section>
        </div>
      )}
      {accountOpen && (
        <div
          className="auth-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAccountData();
          }}
        >
          <section
            className="auth-dialog account-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-title"
            onKeyDown={(event) => handleDialogKeys(event, closeAccountData)}
          >
            <button
              type="button"
              className="auth-close"
              ref={accountCloseButton}
              aria-label="关闭账号与数据"
              onClick={closeAccountData}
              disabled={exporting || deleting}
            >
              ×
            </button>
            <p className="eyebrow">YOUR DATA</p>
            <h2 id="account-title">账号与数据</h2>
            {deletionComplete ? (
              <div className="account-result" role="status">
                <strong>你在线留下的原始记录已移除。</strong>
                <p>
                  账号与会话已经失效；历史加密备份会按公布的到期规则清理，其他用户此前收到的生成回复无法自动收回。
                </p>
                <button type="button" onClick={closeAccountData}>
                  返回首页
                </button>
              </div>
            ) : deletionPending ? (
              <div className="account-result" role="status">
                <strong>
                  {deletionPending === "pending"
                    ? "删除尚未完成。"
                    : "删除结果尚未确认。"}
                </strong>
                <p>
                  {deletionPending === "pending"
                    ? "为避免新的记录产生，你的账号已暂停使用。请联系运营方跟进；不要把暂停视作数据已经全部清除。"
                    : "当前登录状态已失效，但网络异常使删除结果无法确认。请重新打开网站核实，必要时联系运营方。"}
                </p>
                {deletionPolicy?.enabled && (
                  <p>联系渠道：{deletionPolicy.privacyContact}</p>
                )}
              </div>
            ) : (
              <>
                <p className="auth-intro">
                  你可以下载自己的原始记录，查看账号数据的处理方式；共享 AI
                  可能参考不同用户留下的线索。
                </p>
                <div className="account-section">
                  <h3>导出我的数据</h3>
                  <p>
                    下载账号基本资料、你与三个 AI
                    的私人会话，以及你贡献的共同记录。文件可能包含敏感内容，请妥善保管。
                  </p>
                  <button
                    type="button"
                    className="account-export"
                    onClick={() => void exportPersonalData()}
                    disabled={exporting || deleting}
                  >
                    {exporting ? "正在准备文件…" : "下载我的数据 ↗"}
                  </button>
                </div>
                <div className="account-section account-danger">
                  <h3>删除账号与在线记录</h3>
                  {deletionPolicy?.enabled ? (
                    <>
                      <p>
                        将删除你的账号、所有登录会话、你与三个 AI
                        的私人会话，及你贡献的共同记录。其他用户的原始记录不会因此改写。
                      </p>
                      <p>
                        历史加密备份按 {deletionPolicy.backupRetentionDays}
                        天到期规则清理；对象存储按天执行，实际清理可能延后。如果恢复旧快照，删除记录会再次清理你的在线原文。其他用户此前收到的生成回复无法自动收回。
                      </p>
                      <p>
                        运营者：{deletionPolicy.operatorName} · 联系渠道：
                        {deletionPolicy.privacyContact}
                      </p>
                      <form onSubmit={(event) => void submitDeletion(event)}>
                        <label htmlFor="delete-password">再次输入密码</label>
                        <input
                          id="delete-password"
                          type="password"
                          autoComplete="current-password"
                          value={deletePassword}
                          onChange={(event) =>
                            setDeletePassword(event.target.value)
                          }
                          required
                          placeholder="确认这是你的账号"
                        />
                        <label
                          className="delete-confirm"
                          htmlFor="delete-confirm"
                        >
                          <input
                            id="delete-confirm"
                            type="checkbox"
                            checked={deleteConfirmed}
                            onChange={(event) =>
                              setDeleteConfirmed(event.target.checked)
                            }
                          />
                          我理解此操作会移除我的在线记录，且不能撤销。
                        </label>
                        <button
                          type="submit"
                          className="delete-submit"
                          disabled={
                            !deleteConfirmed ||
                            !deletePassword ||
                            deleting ||
                            exporting
                          }
                        >
                          {deleting ? "正在处理…" : "删除我的账号"}
                        </button>
                      </form>
                    </>
                  ) : deletionPolicy ? (
                    <p>在线删除尚未开放。现在仍可先导出本人的数据。</p>
                  ) : (
                    <p>正在读取删除服务状态…</p>
                  )}
                </div>
              </>
            )}
            {accountError && (
              <p className="error-note" role="alert">
                {accountError}
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
