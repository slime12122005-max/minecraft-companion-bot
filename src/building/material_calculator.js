export function calculateMaterialShortage(requiredMaterials = {}, inventoryItems = [], chestTotals = {}) {
  const invMap = {};
  for (const item of inventoryItems) {
    if (!item?.name) continue;
    const key = String(item.name);
    invMap[key] = (invMap[key] ?? 0) + Math.max(0, Number(item.count ?? 1));
  }

  const required = {};
  const inInventory = {};
  const inChests = {};
  const fromChests = {};
  const missing = {};

  for (const [mat, rawReq] of Object.entries(requiredMaterials)) {
    const reqCount = Math.max(0, Number(rawReq ?? 0));
    if (reqCount <= 0) continue;
    required[mat] = reqCount;

    const invCount = invMap[mat] ?? 0;
    const chestCount = Math.max(0, Number(chestTotals?.[mat] ?? 0));
    inInventory[mat] = invCount;
    inChests[mat] = chestCount;

    const afterInv = Math.max(0, reqCount - invCount);
    const takeChest = Math.min(chestCount, afterInv);
    if (takeChest > 0) fromChests[mat] = takeChest;

    const missingCount = Math.max(0, afterInv - takeChest);
    if (missingCount > 0) missing[mat] = missingCount;
  }

  return {
    required,
    inInventory,
    inChests,
    fromChests,
    missing,
    readyToBuild: Object.keys(missing).length === 0,
  };
}

export function buildSupplyPlan(missingMaterials = {}) {
  const plan = [];
  for (const [mat, rawCount] of Object.entries(missingMaterials)) {
    const count = Math.max(0, Number(rawCount ?? 0));
    if (count <= 0) continue;

    if (mat.endsWith('_planks')) {
      const logType = mat.replace(/_planks$/, '_log');
      const logsNeeded = Math.ceil(count / 4);
      plan.push({ action: 'gather', target: logType, count: logsNeeded });
      plan.push({ action: 'craft', target: mat, count });
    } else if (mat === 'iron_ingot') {
      plan.push({ action: 'gather', target: 'raw_iron', count });
      plan.push({ action: 'smelt', target: 'sat', count });
    } else if (mat === 'gold_ingot') {
      plan.push({ action: 'gather', target: 'raw_gold', count });
      plan.push({ action: 'smelt', target: 'vang', count });
    } else if (mat === 'glass') {
      plan.push({ action: 'gather', target: 'sand', count });
      plan.push({ action: 'smelt', target: 'cat', count });
    } else if (mat === 'stone') {
      plan.push({ action: 'gather', target: 'cobblestone', count });
      plan.push({ action: 'smelt', target: 'da', count });
    } else {
      plan.push({ action: 'gather', target: mat, count });
    }
  }
  return plan;
}
