import { FOOD_PRIORITY, isBeneficialPotion } from './constants.js';

export function bestFood(bot) {
  const items = bot.inventory?.items?.() ?? [];
  for (const foodName of FOOD_PRIORITY) {
    const found = items.find(i => i?.name?.toLowerCase() === foodName);
    if (found) return found;
  }
  return null;
}

export async function emergencyHeal(ctx) {
  const now = Date.now();
  if (ctx.eating || now - ctx.lastHealAt < 3000) return false;
  if (typeof ctx.bot.equip !== 'function' || typeof ctx.bot.consume !== 'function') return false;

  const health = ctx.bot.health ?? 20;
  const burning = ctx._isOnFire() || ctx._isInLava();
  if (health > 8 && !burning) return false;

  const items = ctx.bot.inventory?.items?.() ?? [];
  let item = null;
  if (burning) {
    item = items.find(i => isBeneficialPotion(i, { fireOnly: true }))
      ?? (health <= 12 ? items.find(i => i?.name === 'golden_apple' || i?.name === 'enchanted_golden_apple') : null);
  }
  if (!item && health <= 8) {
    item = items.find(i => isBeneficialPotion(i))
      ?? items.find(i => i?.name === 'golden_apple')
      ?? items.find(i => i?.name === 'enchanted_golden_apple');
  }
  if (!item) return false;

  ctx.eating = true;
  ctx.lastHealAt = now;
  try {
    if (ctx.bot.targetDigBlock) {
      try { ctx.bot.stopDigging?.(); } catch {}
    }
    await ctx.bot.equip(item, 'hand');
    await ctx.bot.consume();
    ctx.log(`💊 Đã dùng hồi phục khẩn cấp: ${item.name}`);
    return true;
  } catch (err) {
    ctx.log(`Không thể dùng ${item.name}: ${err.message}`);
    return false;
  } finally {
    ctx.eating = false;
  }
}

export async function autoEat(ctx, { force = false } = {}) {
  const now = Date.now();
  if (ctx.bot.isSleeping || ctx.eating || (!force && now - ctx.lastEatAt < 3500)) return false;
  const food = ctx.bot.food ?? 20;
  const health = ctx.bot.health ?? 20;
  if (force ? food >= 20 : (food >= 14 && !(health <= 14 && food < 20))) return false;

  const item = ctx._bestFood();
  if (!item || typeof ctx.bot.equip !== 'function' || typeof ctx.bot.consume !== 'function') {
    return false;
  }

  ctx.eating = true;
  ctx.lastEatAt = now;
  try {
    await ctx.bot.equip(item, 'hand');
    await ctx.bot.consume();
    ctx.log(`🍖 Đã ăn ${item.name}`);
    return true;
  } catch (err) {
    ctx.log(`Không thể ăn ${item.name}: ${err.message}`);
    return false;
  } finally {
    ctx.eating = false;
  }
}
