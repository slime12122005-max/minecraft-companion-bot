import { normalizeText } from './commands.js';

export const CRAFT_ALIASES = {
  'ban che tao': 'crafting_table',
  'crafting table': 'crafting_table',
  'lo nung': 'furnace',
  furnace: 'furnace',
  ruong: 'chest',
  chest: 'chest',
  giuong: 'white_bed',
  bed: 'white_bed',
  duoc: 'torch',
  torch: 'torch',
  gay: 'stick',
  stick: 'stick',
  'van go': 'oak_planks',
  van: 'oak_planks',
  planks: 'oak_planks',
  khien: 'shield',
  shield: 'shield',
  cung: 'bow',
  bow: 'bow',
  ten: 'arrow',
  arrow: 'arrow',
  xo: 'bucket',
  bucket: 'bucket',
  'banh mi': 'bread',
  bread: 'bread',
  'cuoc go': 'wooden_pickaxe',
  'cuoc da': 'stone_pickaxe',
  'cuoc sat': 'iron_pickaxe',
  'cuoc kim cuong': 'diamond_pickaxe',
  'kiem go': 'wooden_sword',
  'kiem da': 'stone_sword',
  'kiem sat': 'iron_sword',
  'kiem kim cuong': 'diamond_sword',
  'riu go': 'wooden_axe',
  'riu da': 'stone_axe',
  'riu sat': 'iron_axe',
  'riu kim cuong': 'diamond_axe',
  'xeng go': 'wooden_shovel',
  'xeng da': 'stone_shovel',
  'xeng sat': 'iron_shovel',
  'mu sat': 'iron_helmet',
  'giap sat': 'iron_chestplate',
  'quan sat': 'iron_leggings',
  'giay sat': 'iron_boots',
  'mu kim cuong': 'diamond_helmet',
  'giap kim cuong': 'diamond_chestplate',
  'quan kim cuong': 'diamond_leggings',
  'giay kim cuong': 'diamond_boots',
};

export const SMELT_ALIASES = {
  sat: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  iron: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  vang: ['raw_gold', 'gold_ore', 'deepslate_gold_ore'],
  gold: ['raw_gold', 'gold_ore', 'deepslate_gold_ore'],
  dong: ['raw_copper', 'copper_ore'],
  copper: ['raw_copper', 'copper_ore'],
  thit: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit'],
  bo: ['beef'],
  heo: ['porkchop'],
  ga: ['chicken'],
  cuu: ['mutton'],
  ca: ['cod', 'salmon'],
  cat: ['sand', 'red_sand'],
  sand: ['sand', 'red_sand'],
  da: ['cobblestone', 'stone'],
  cuoi: ['cobblestone'],
  cobblestone: ['cobblestone'],
  go: ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log'],
  'than go': ['oak_log', 'birch_log', 'spruce_log'],
};

export const FUEL_VALUES = [
  { match: n => n === 'coal' || n === 'charcoal', per: 8 },
  { match: n => n.endsWith('_planks'), per: 1.5 },
  { match: n => /_(log|wood|stem|hyphae)$/.test(n), per: 1.5 },
  { match: n => n === 'stick', per: 0.5 },
  { match: n => n === 'blaze_rod', per: 12 },
  { match: n => n === 'coal_block', per: 80 },
];

export const LOG_TO_PLANKS = {
  oak_log: 'oak_planks',
  birch_log: 'birch_planks',
  spruce_log: 'spruce_planks',
  jungle_log: 'jungle_planks',
  acacia_log: 'acacia_planks',
  dark_oak_log: 'dark_oak_planks',
  cherry_log: 'cherry_planks',
  mangrove_log: 'mangrove_planks',
};

export const SMELT_OUTPUT_TO_INPUT = Object.freeze({
  iron_ingot: { smeltTarget: 'sat', inputs: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'] },
  gold_ingot: { smeltTarget: 'vang', inputs: ['raw_gold', 'gold_ore', 'deepslate_gold_ore'] },
  copper_ingot: { smeltTarget: 'dong', inputs: ['raw_copper', 'copper_ore'] },
  glass: { smeltTarget: 'cat', inputs: ['sand', 'red_sand'] },
  stone: { smeltTarget: 'da', inputs: ['cobblestone'] },
  charcoal: { smeltTarget: 'than go', inputs: ['oak_log', 'birch_log', 'spruce_log'] },
});

const STANDARD_RECIPES = {
  oak_planks: { yields: 4, table: false, ingredients: { oak_log: 1 } },
  stick: { yields: 4, table: false, ingredients: { oak_planks: 2 } },
  crafting_table: { yields: 1, table: false, ingredients: { oak_planks: 4 } },
  furnace: { yields: 1, table: true, ingredients: { cobblestone: 8 } },
  chest: { yields: 1, table: true, ingredients: { oak_planks: 8 } },
  torch: { yields: 4, table: false, ingredients: { coal: 1, stick: 1 } },
  shield: { yields: 1, table: true, ingredients: { oak_planks: 6, iron_ingot: 1 } },
  bucket: { yields: 1, table: true, ingredients: { iron_ingot: 3 } },
  bread: { yields: 1, table: true, ingredients: { wheat: 3 } },
  wooden_pickaxe: { yields: 1, table: true, ingredients: { oak_planks: 3, stick: 2 } },
  stone_pickaxe: { yields: 1, table: true, ingredients: { cobblestone: 3, stick: 2 } },
  iron_pickaxe: { yields: 1, table: true, ingredients: { iron_ingot: 3, stick: 2 } },
  diamond_pickaxe: { yields: 1, table: true, ingredients: { diamond: 3, stick: 2 } },
  wooden_sword: { yields: 1, table: true, ingredients: { oak_planks: 2, stick: 1 } },
  stone_sword: { yields: 1, table: true, ingredients: { cobblestone: 2, stick: 1 } },
  iron_sword: { yields: 1, table: true, ingredients: { iron_ingot: 2, stick: 1 } },
  diamond_sword: { yields: 1, table: true, ingredients: { diamond: 2, stick: 1 } },
  wooden_axe: { yields: 1, table: true, ingredients: { oak_planks: 3, stick: 2 } },
  stone_axe: { yields: 1, table: true, ingredients: { cobblestone: 3, stick: 2 } },
  iron_axe: { yields: 1, table: true, ingredients: { iron_ingot: 3, stick: 2 } },
  diamond_axe: { yields: 1, table: true, ingredients: { diamond: 3, stick: 2 } },
  iron_helmet: { yields: 1, table: true, ingredients: { iron_ingot: 5 } },
  iron_chestplate: { yields: 1, table: true, ingredients: { iron_ingot: 8 } },
  iron_leggings: { yields: 1, table: true, ingredients: { iron_ingot: 7 } },
  iron_boots: { yields: 1, table: true, ingredients: { iron_ingot: 4 } },
};

export function resolveCraftName(targetText, botRegistry = null, inventoryItems = []) {
  const norm = normalizeText(targetText);
  if (!norm) return null;
  if (norm === 'van go' || norm === 'van' || norm === 'planks') {
    for (const item of inventoryItems) {
      const plank = LOG_TO_PLANKS[item?.name?.toLowerCase()];
      if (plank) return plank;
    }
    return 'oak_planks';
  }
  if (CRAFT_ALIASES[norm]) return CRAFT_ALIASES[norm];
  const snake = norm.replace(/\s+/g, '_');
  if (botRegistry?.itemsByName?.[snake]) return snake;
  const match = Object.keys(botRegistry?.itemsByName ?? {}).find(n => n === snake || n.includes(snake));
  return match ?? snake;
}

export function resolveSmeltInputs(targetText) {
  const norm = normalizeText(targetText);
  if (!norm) return [];
  if (SMELT_ALIASES[norm]) return SMELT_ALIASES[norm];
  const snake = norm.replace(/\s+/g, '_');
  return [snake];
}

export function planCraftDependencies(targetName, count = 1, inventoryItems = []) {
  const have = new Map();
  for (const item of inventoryItems) {
    if (!item?.name) continue;
    const key = String(item.name).toLowerCase();
    have.set(key, (have.get(key) ?? 0) + (item.count ?? 1));
  }

  let hasTable = (have.get('crafting_table') ?? 0) > 0;
  let hasFurnace = (have.get('furnace') ?? 0) > 0;
  const steps = [];
  const visiting = new Set();

  function ensure(item, qty) {
    if (qty <= 0) return;
    const avail = have.get(item) ?? 0;
    const take = Math.min(avail, qty);
    if (take > 0) have.set(item, avail - take);
    const missing = qty - take;
    if (missing <= 0) return;

    if (visiting.has(item)) {
      steps.push({ action: 'missing', item, count: missing });
      return;
    }
    visiting.add(item);

    const recipe = STANDARD_RECIPES[item];
    if (recipe) {
      const batches = Math.ceil(missing / recipe.yields);
      if (recipe.table && !hasTable) {
        ensure('crafting_table', 1);
        hasTable = true;
      }
      for (const [ing, amt] of Object.entries(recipe.ingredients)) {
        ensure(ing, amt * batches);
      }
      const produced = batches * recipe.yields;
      steps.push({ action: 'craft', item, count: produced });
      const leftover = produced - missing;
      if (leftover > 0) have.set(item, (have.get(item) ?? 0) + leftover);
    } else if (SMELT_OUTPUT_TO_INPUT[item]) {
      const rule = SMELT_OUTPUT_TO_INPUT[item];
      if (!hasFurnace) {
        ensure('furnace', 1);
        hasFurnace = true;
      }
      const inputItem = rule.inputs.find(n => (have.get(n) ?? 0) > 0) ?? rule.inputs[0];
      ensure(inputItem, missing);
      steps.push({ action: 'smelt', item, input: inputItem, count: missing });
    } else {
      steps.push({ action: 'missing', item, count: missing });
    }

    visiting.delete(item);
  }

  const resolved = resolveCraftName(targetName, null, inventoryItems) ?? String(targetName).toLowerCase();
  ensure(resolved, Math.max(1, count));
  return steps;
}
