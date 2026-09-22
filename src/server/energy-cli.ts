import { resolve } from "node:path";
import { findSpirit } from "../shared/world.ts";
import { WorldStore } from "./world-store.ts";

const [id, amountText] = process.argv.slice(2);
const spirit = findSpirit(id ?? "");
const amount = Number(amountText);
if (!spirit || !Number.isSafeInteger(amount) || amount < 1) {
  console.error(
    "用法：pnpm energy:add <mori|piko|sela> <正整数>（请先停止服务）",
  );
  process.exitCode = 1;
} else {
  const store = new WorldStore(resolve(process.cwd(), ".data"));
  await store.initialize();
  const energy = await store.credit(spirit.id, amount);
  console.log(`${spirit.name} 当前能量：${energy}`);
}
