import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foodSupply,
  bestPickTier,
  hasPickaxeTier,
  requiredPickTier,
  summarizeReadiness,
} from '../src/readiness.js';

test('foodSupply sums safe hunger points and excludes raw chicken, rotten flesh, and golden apples', () => {
  const items = [
    { name: 'cooked_beef', count: 2 },        // 16
    { name: 'bread', count: 1 },              // 5
    { name: 'sweet_berries', count: 3 },      // 6
    { name: 'chicken', count: 10 },           // 0 (raw chicken)
    { name: 'rotten_flesh', count: 10 },      // 0
    { name: 'golden_apple', count: 5 },       // 0 (reserved for emergency heal)
    { name: 'enchanted_golden_apple', count: 1 }, // 0
  ];
  assert.equal(foodSupply(items), 27);
  assert.equal(foodSupply([]), 0);
});

test('bestPickTier and hasPickaxeTier rank pickaxe tiers accurately', () => {
  assert.equal(bestPickTier([]), 'none');
  assert.equal(bestPickTier([{ name: 'golden_pickaxe' }]), 'wood');
  assert.equal(bestPickTier([{ name: 'wooden_pickaxe' }, { name: 'stone_pickaxe' }]), 'stone');
  assert.equal(bestPickTier([{ name: 'iron_pickaxe' }]), 'iron');
  assert.equal(bestPickTier([{ name: 'netherite_pickaxe' }]), 'diamond');

  assert.equal(hasPickaxeTier([{ name: 'stone_pickaxe' }], 'stone'), true);
  assert.equal(hasPickaxeTier([{ name: 'wooden_pickaxe' }], 'stone'), false);
  assert.equal(hasPickaxeTier([], 'none'), true);
});

test('requiredPickTier maps blocks and ores to correct harvest tiers', () => {
  assert.equal(requiredPickTier(['oak_log', 'dirt']), 'none');
  assert.equal(requiredPickTier(['stone', 'cobblestone']), 'wood');
  assert.equal(requiredPickTier(['coal_ore']), 'wood');
  assert.equal(requiredPickTier(['iron_ore', 'deepslate_iron_ore']), 'stone');
  assert.equal(requiredPickTier(['copper_ore', 'lapis_ore']), 'stone');
  assert.equal(requiredPickTier(['gold_ore', 'diamond_ore', 'emerald_ore']), 'iron');
  assert.equal(requiredPickTier(['obsidian', 'ancient_debris']), 'diamond');
});

test('summarizeReadiness reports food points, threshold status, and best pickaxe', () => {
  const sum = summarizeReadiness(
    [{ name: 'bread', count: 4 }, { name: 'stone_pickaxe', count: 1 }],
    { minFoodPoints: 20 }
  );
  assert.deepEqual(sum, {
    foodPoints: 20,
    minFoodPoints: 20,
    foodOk: true,
    pickaxe: 'stone',
  });

  const low = summarizeReadiness([{ name: 'apple', count: 2 }], { minFoodPoints: 20 });
  assert.equal(low.foodPoints, 8);
  assert.equal(low.foodOk, false);
  assert.equal(low.pickaxe, 'none');
});
