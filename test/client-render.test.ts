import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  App,
  activityLabel,
  appendCompletedTurn,
  mergeConversationHistory,
  renderSpiritText,
} from "../src/client/app.tsx";

test("conversation identifies shared AI and discloses cross-user context", () => {
  const html = renderToStaticMarkup(createElement(App));
  assert.match(html, /共享 AI · 回复由模型生成/);
  assert.match(html, /你发送的内容可能进入共同上下文或 AI 的共享文件/);
  assert.match(html, /其他用户可能间接获知/);
  assert.match(html, /当前目录有哪些文件/);
  assert.doesNotMatch(html, /精灵星球|正在醒来|能量/);
});

test("spirit emphasis renders without exposing raw markup or HTML", () => {
  const content = renderSpiritText("叫它**追风签**。<script>no</script>");
  const html = renderToStaticMarkup(createElement("p", null, content));
  assert.equal(
    html,
    "<p>叫它<strong>追风签</strong>。&lt;script&gt;no&lt;/script&gt;</p>",
  );
});

test("mobile activity labels preserve recency without overflowing cards", () => {
  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  assert.equal(activityLabel(recent), "5 分钟前有人对话");
  assert.equal(activityLabel(recent, true), "5分钟前");
  assert.equal(activityLabel(null, true), "暂无对话");
});

test("a completed turn is visible immediately and a replay cannot duplicate it", () => {
  const reply = {
    id: "reply-1",
    role: "spirit" as const,
    text: "星球还在。",
    createdAt: "2026-09-24T06:00:00.000Z",
  };
  const once = appendCompletedTurn([], "你还在吗？", "request-1", reply);
  assert.deepEqual(
    once.map(({ role, text }) => [role, text]),
    [
      ["visitor", "你还在吗？"],
      ["spirit", "星球还在。"],
    ],
  );
  assert.equal(
    appendCompletedTurn(once, "你还在吗？", "request-1", reply),
    once,
  );
  const oldHistory = [
    {
      id: "old-visitor",
      requestId: "request-0",
      role: "visitor" as const,
      text: "之前的话",
      createdAt: reply.createdAt,
    },
    { ...reply, id: "old-reply" },
  ];
  const merged = mergeConversationHistory(oldHistory, once);
  assert.equal(merged.length, 4);
  assert.equal(merged[0]?.text, "之前的话");
  assert.equal(merged[2]?.text, "你还在吗？");
  const canonical = [
    ...oldHistory,
    { ...once[0]!, id: "saved-visitor" },
    reply,
  ];
  assert.deepEqual(mergeConversationHistory(canonical, once), canonical);
});
