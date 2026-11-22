import fs from 'node:fs/promises';
import path from 'node:path';
import { Vec3 } from 'vec3';

export const vector = (x, y, z) => new Vec3(x, y, z);

export const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
export const ROTATIONS = new Set([0, 90, 180, 270]);
const FACING = { north: 0, east: 1, south: 2, west: 3 };
const NAME_FACING = Object.fromEntries(Object.entries(FACING).map(([k, v]) => [v, k]));
export const FACING_TO_PLAYER_YAW = { north: Math.PI, east: Math.PI / 2, south: 0, west: -Math.PI / 2 };
export const BLOCKED = new Set(['chest', 'trapped_chest', 'barrel', 'shulker_box', 'spawner', 'end_portal_frame', 'command_block']);

export const SCHEMATIC_CATALOG = Object.freeze([
  { name: 'Minecraft Schematics (community)', url: 'https://www.minecraft-schematics.com/', format: 'schematic', free: true },
  { name: 'Planet Minecraft Projects', url: 'https://www.planetminecraft.com/projects/', format: 'schematic', free: true },
  { name: 'GrabCraft Blueprints', url: 'https://www.grabcraft.com/', format: 'schematic', free: true },
]);

export const abortError = () => Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
export const checkAbort = signal => { if (signal?.aborted) throw signal.reason ?? abortError(); };
export const blockName = block => block?.name ?? block?.type?.name ?? 'air';
export const isAir = block => !block || AIR_NAMES.has(blockName(block));
export const isReplaceable = block => isAir(block) || block?.getProperties?.().replaceable === true || block?.shapes?.length === 0;
export const keyFor = (file, x, y, z, rotation) => `building.progress:${path.resolve(file)}:${x},${y},${z}:${rotation}`;
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function downloadSchematic(url, destination, { maxBytes = 32 * 1024 * 1024, timeoutMs = 15000 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Schematic downloads require HTTPS');
  const allowed = new Set(SCHEMATIC_CATALOG.map(item => new URL(item.url).hostname));
  if (![...allowed].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    throw new Error('Download host is not in the curated schematic catalog');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Schematic download failed: HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > maxBytes) throw new Error(`Schematic exceeds download limit (${maxBytes} bytes)`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Schematic exceeds download limit (${maxBytes} bytes)`);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (!['.schem', '.schematic', '.json'].includes(ext)) throw new Error('Download URL must end in .schem, .schematic, or .json');
    await fs.mkdir(path.dirname(path.resolve(destination)), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'wx' });
    return { file: path.resolve(destination), bytes: bytes.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

function rotateFacing(facing, quarterTurns) {
  if (!Object.hasOwn(FACING, facing)) return facing;
  return NAME_FACING[(FACING[facing] + quarterTurns) % 4];
}

export function rotateBlock(block, rotation) {
  const properties = { ...(block.properties ?? block.getProperties?.() ?? {}) };
  const q = rotation / 90;
  if (typeof properties.facing === 'string') properties.facing = rotateFacing(properties.facing, q);
  if (Number.isInteger(properties.rotation)) properties.rotation = (properties.rotation + q * 4) % 16;
  return { name: block.name ?? 'air', properties };
}

export function rotatePosition(x, z, sizeX, sizeZ, rotation) {
  if (rotation === 90) return { x: sizeZ - 1 - z, z: x };
  if (rotation === 180) return { x: sizeX - 1 - x, z: sizeZ - 1 - z };
  if (rotation === 270) return { x: z, z: sizeX - 1 - x };
  return { x, z };
}

function parseJsonBlueprint(rawText, volumeLimit) {
  const doc = JSON.parse(rawText);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.blocks)) {
    throw new Error('JSON blueprint must contain a blocks array');
  }

  let size = doc.size;
  if (Array.isArray(size) && size.length >= 3) {
    size = { x: Number(size[0]), y: Number(size[1]), z: Number(size[2]) };
  } else if (!size && doc.blocks.length > 0) {
    let maxX = 0, maxY = 0, maxZ = 0;
    for (const b of doc.blocks) {
      if (Number(b.x) > maxX) maxX = Number(b.x);
      if (Number(b.y) > maxY) maxY = Number(b.y);
      if (Number(b.z) > maxZ) maxZ = Number(b.z);
    }
    size = { x: maxX + 1, y: maxY + 1, z: maxZ + 1 };
  }

  if (!size || !Number.isInteger(size.x) || !Number.isInteger(size.y) || !Number.isInteger(size.z)) {
    throw new Error('Blueprint has invalid dimensions');
  }
  if (size.x * size.y * size.z > volumeLimit) {
    throw new Error(`Schematic exceeds configured block limit (${volumeLimit})`);
  }

  const blocks = [];
  const materials = {};
  for (const b of doc.blocks) {
    const name = String(b?.name ?? 'air');
    if (AIR_NAMES.has(name)) continue;
    blocks.push({
      x: Number(b.x),
      y: Number(b.y),
      z: Number(b.z),
      name,
      properties: b?.properties && typeof b.properties === 'object' ? { ...b.properties } : {},
    });
    materials[name] = (materials[name] ?? 0) + 1;
  }

  return { size: { x: size.x, y: size.y, z: size.z }, blocks, materials };
}

export async function loadBlueprint(file, { bot, config = {} } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new TypeError('A schematic file path is required');
  const fullPath = path.resolve(file);
  const ext = path.extname(fullPath).toLowerCase();
  if (ext === '.litematic') throw new Error('Litematic files are not supported yet; export as .schem or .schematic');
  if (!['.schem', '.schematic', '.json'].includes(ext)) {
    throw new Error(`Unsupported schematic format: ${ext || '(no extension)'}`);
  }

  const stat = await fs.stat(fullPath);
  const maxBytes = config.maxSchematicBytes ?? 32 * 1024 * 1024;
  if (stat.size > maxBytes) throw new Error(`Schematic exceeds configured size limit (${maxBytes} bytes)`);
  const volumeLimit = config.maxBlocks ?? 50000;

  if (ext === '.json') {
    const raw = await fs.readFile(fullPath, 'utf8');
    return { file: fullPath, schematic: null, blueprint: parseJsonBlueprint(raw, volumeLimit) };
  }

  const data = await fs.readFile(fullPath);
  const mod = await import('prismarine-schematic');
  const factory = mod.default ?? mod;
  const mcData = bot?.registry ?? bot?.mcData ?? bot?.version;
  const Schematic = typeof factory === 'function' ? factory(mcData) : factory;
  let schematic;
  if (typeof Schematic.read === 'function') schematic = await Schematic.read(data, bot?.version);
  else if (typeof Schematic.parse === 'function') schematic = await Schematic.parse(data, bot?.version);
  else throw new Error('Installed prismarine-schematic has no read/parse API');

  const size = schematic.size ?? schematic.getSize?.();
  if (!size || !Number.isInteger(size.x) || !Number.isInteger(size.y) || !Number.isInteger(size.z)) {
    throw new Error('Schematic has invalid dimensions');
  }
  if (size.x * size.y * size.z > volumeLimit) {
    throw new Error(`Schematic exceeds configured block limit (${volumeLimit})`);
  }

  const blocks = [];
  const materials = {};
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        const block = schematic.getBlock?.(vector(x, y, z)) ?? schematic.getBlockAt?.(x, y, z);
        const name = blockName(block);
        if (AIR_NAMES.has(name)) continue;
        blocks.push({ x, y, z, name, properties: block?.getProperties?.() ?? block?.properties ?? {} });
        materials[name] = (materials[name] ?? 0) + 1;
      }
    }
  }

  return {
    file: fullPath,
    schematic,
    blueprint: { size: { x: size.x, y: size.y, z: size.z }, blocks, materials },
  };
}
