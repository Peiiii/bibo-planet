# 模型尝试预算 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

状态（2026-09-24）：本机实现已完成，24/24 测试、TypeScript、lint、格式、构建和 Worker dry-run 通过；尚未部署到公网，生产备份与真实链路复验待做。本文仅记录这次实现范围，正式交付状态以[公网验收记录](2026-09-24-public-launch.plan.md)为准。

**Goal:** 模型调用前持久预留次数，保证失败、超时和重启也不能绕过每日调用次数上限，同时保留成功回复的独立额度。

**Architecture:** 账号状态仍由 `AuthStore` 单一拥有；在现有 `accounts.json` 的每个账号中增加可选的 `attemptDay` 与 `attemptCount`，缺失时按同日已成功次数回填语义，不做整库迁移。进入 `withMessagePermit` 时先在串行队列中检查并持久预留，再调用模型；结果成功才增加原有 `usageCount`。当日全星球预留次数不得超过 240；单账号尝试最多 18 次、成功最多 12 次。

**Tech Stack:** TypeScript、Node.js、`node:test`、React；既有 JSON 原子重命名持久化，不加新数据库或单独预算服务。

---

## 方案取舍

- 仅统计成功：供应商超时/失败可能已经计费，无法限制调用次数；淘汰。
- 失败直接算成功额度：实现简单，但供应商故障会吞掉原有 12 次成功机会；淘汰。
- **成功额度与模型尝试分开**：失败占一次尝试，不虚记成功回复；保留 6 次个人失败缓冲，同时全世界最高仍是 240 次实际发起调用；采用。

## Task 1：用失败测试锁定预算合同

**Files:** 修改 `test/auth-store.test.ts`、`test/server.test.ts`。

1. 新增一个注入失败模型的测试：连续失败后 `usageCount` 仍为 0，`attemptCount` 持久增加；重新构造 `AuthStore` 后不能恢复次数；第 19 次在调用模型前返回 429。
2. 新增并发测试：同账号并发请求不能双重预留；不同账号并发时全局预留由同一个 `serial` 队列裁决。
3. 对旧格式账号状态验证：没有 `attemptCount` 时，用当日 `usageCount` 作为已消耗尝试的保守下界。
4. 运行 `pnpm test`，确认新增断言先失败。

## Task 2：在唯一账号状态 owner 中预留

**Files:** 修改 `src/server/auth-store.ts`、必要时 `src/shared/world.ts`。

1. 给 `Account` 增加可选的 `attemptDay` 和 `attemptCount`，不改变已有版本号和旧文件读取行为。
2. `withMessagePermit` 在调用 `action` 前进入 `serial`：检查个人成功 12、个人尝试 18、全世界尝试 240；成功持久写入新的当日尝试计数，失败不调用模型。
3. 退出时仍在 `finally` 释放 `inFlight`。原有成功路径才递增 `usageCount`；失败保留预留，防止重试绕过。已有幂等成功重放继续在进入许可前处理。
4. `remainingToday` 取成功剩余与尝试剩余的较小值；个人数据导出包含尝试日与尝试数，不静默漏掉用户相关状态。

## Task 3：验证、说明与发布

**Files:** 修改 `src/client/app.tsx`、`README.md`、`docs/plans/2026-09-24-public-launch.plan.md`、`docs/OPERATIONS.md`。

1. 页面把剩余额度称为“还可尝试唤醒”，并说明模型失败也可能消耗一次尝试预算；不声称金额级硬上限，供应商价格、内部重试和账单仍需独立监测。
2. 运行定向与完整测试、`pnpm tsc`、`pnpm lint`、`pnpm format:check`、`pnpm build`、Worker dry-run 与 `git diff --check`。
3. 发布前做 Bibo 专用一致备份，保留旧格式恢复路径；只更新 Bibo 服务和同源前端。真实公网验证一次成功回复、幂等重放不增加尝试、旧账号会话可用；不在生产故意打满额度。
4. 把实际版本和证据写入交付记录；若远端启动、账号数据读取或公网链路失败，按运行手册保留数据并回滚代码，不能清空 `accounts.json`。

## 完成边界

本计划提供**模型调用尝试次数上限**，不是供应商账单金额绝对上限；如果 Harness 或供应商在一次调用内部重试、价格变化，仍需外部用量与余额监控。浏览器控制不可用时，只能报告 API 证据，UI 验收保持开放。
