const MAX_DIRECT_SYNC_BYTES = 16 * 1024 * 1024;

export function encodeVarInt(value) {
  let v = Number(value) >>> 0;
  const bytes = [];
  while ((v & ~0x7f) !== 0) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

export function readVarInt(buf, offset = 0) {
  let value = 0;
  let position = 0;
  let pos = offset;
  while (true) {
    if (pos >= buf.length) {
      throw new RangeError('Unexpected EOF while reading VarInt');
    }
    const currentByte = buf[pos++];
    value |= (currentByte & 0x7f) << position;
    if ((currentByte & 0x80) === 0) break;
    position += 7;
    if (position >= 32) {
      throw new RangeError('VarInt is too big');
    }
  }
  return { value: value | 0, offset: pos };
}

export function encodeMcString(str) {
  const strBuf = Buffer.from(String(str ?? ''), 'utf8');
  return Buffer.concat([encodeVarInt(strBuf.length), strBuf]);
}

export function readMcString(buf, offset = 0) {
  const { value: len, offset: start } = readVarInt(buf, offset);
  if (len < 0 || start + len > buf.length) {
    throw new RangeError(`Invalid string length (${len}) at offset ${offset}`);
  }
  return {
    value: buf.toString('utf8', start, start + len),
    offset: start + len,
  };
}

export function decodeChannelList(data) {
  if (Array.isArray(data)) {
    return data
      .map((s) => String(s ?? '').replace(/\0+$/g, '').trim())
      .filter(Boolean);
  }
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    return Buffer.from(data)
      .toString('utf8')
      .split('\0')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function splitIdentifier(fullId) {
  const s = String(fullId ?? '');
  const idx = s.indexOf(':');
  if (idx === -1) return ['minecraft', s];
  return [s.slice(0, idx) || 'minecraft', s.slice(idx + 1)];
}

export function decodeDirectRegistrySync(buf) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '');
  const syncedMap = new Map();
  if (buffer.length === 0) return syncedMap;

  let pos = 0;
  const regNsCountRes = readVarInt(buffer, pos);
  const regNsGroupAmount = regNsCountRes.value;
  pos = regNsCountRes.offset;

  for (let i = 0; i < regNsGroupAmount; i++) {
    const regNsRes = readMcString(buffer, pos);
    const regNamespace = regNsRes.value || 'minecraft';
    pos = regNsRes.offset;

    const regLenRes = readVarInt(buffer, pos);
    const regGroupLength = regLenRes.value;
    pos = regLenRes.offset;

    for (let j = 0; j < regGroupLength; j++) {
      const regPathRes = readMcString(buffer, pos);
      const regPath = regPathRes.value;
      pos = regPathRes.offset;

      const idMap = new Map();
      const idNsCountRes = readVarInt(buffer, pos);
      const idNamespaceGroupAmount = idNsCountRes.value;
      pos = idNsCountRes.offset;

      let lastBulkLastRawId = 0;

      for (let k = 0; k < idNamespaceGroupAmount; k++) {
        const idNsRes = readMcString(buffer, pos);
        const idNamespace = idNsRes.value || 'minecraft';
        pos = idNsRes.offset;

        const bulkCountRes = readVarInt(buffer, pos);
        const rawIdBulkAmount = bulkCountRes.value;
        pos = bulkCountRes.offset;

        for (let l = 0; l < rawIdBulkAmount; l++) {
          const diffRes = readVarInt(buffer, pos);
          pos = diffRes.offset;
          const sizeRes = readVarInt(buffer, pos);
          pos = sizeRes.offset;

          let currentRawId = (lastBulkLastRawId + diffRes.value) - 1;
          for (let m = 0; m < sizeRes.value; m++) {
            currentRawId += 1;
            const pathRes = readMcString(buffer, pos);
            pos = pathRes.offset;
            idMap.set(`${idNamespace}:${pathRes.value}`, currentRawId);
          }
          lastBulkLastRawId = currentRawId;
        }
      }

      syncedMap.set(`${regNamespace}:${regPath}`, idMap);
    }
  }

  return syncedMap;
}

export function encodeDirectRegistrySync(registryMap) {
  const regEntries = registryMap instanceof Map
    ? Array.from(registryMap.entries())
    : Object.entries(registryMap || {});

  const regNamespaceGroups = new Map();
  for (const [regFullId, rawEntries] of regEntries) {
    const [regNs, regPath] = splitIdentifier(regFullId);
    if (!regNamespaceGroups.has(regNs)) regNamespaceGroups.set(regNs, []);
    const entriesMap = rawEntries instanceof Map
      ? Array.from(rawEntries.entries())
      : Object.entries(rawEntries || {});
    regNamespaceGroups.get(regNs).push([regPath, entriesMap]);
  }

  const chunks = [encodeVarInt(regNamespaceGroups.size)];
  for (const [regNs, regs] of regNamespaceGroups.entries()) {
    chunks.push(encodeMcString(regNs === 'minecraft' ? '' : regNs));
    chunks.push(encodeVarInt(regs.length));

    for (const [regPath, entries] of regs) {
      chunks.push(encodeMcString(regPath));

      const idNamespaceGroups = new Map();
      for (const [idFull, rawId] of entries) {
        const [idNs, idPath] = splitIdentifier(idFull);
        if (!idNamespaceGroups.has(idNs)) idNamespaceGroups.set(idNs, []);
        idNamespaceGroups.get(idNs).push({ path: idPath, rawId: Number(rawId) });
      }

      chunks.push(encodeVarInt(idNamespaceGroups.size));
      let lastBulkLastRawId = 0;

      for (const [idNs, list] of idNamespaceGroups.entries()) {
        list.sort((a, b) => a.rawId - b.rawId);
        const bulks = [];
        for (const item of list) {
          const curBulk = bulks.at(-1);
          if (!curBulk || curBulk.at(-1).rawId + 1 !== item.rawId) {
            bulks.push([item]);
          } else {
            curBulk.push(item);
          }
        }

        chunks.push(encodeMcString(idNs === 'minecraft' ? '' : idNs));
        chunks.push(encodeVarInt(bulks.length));

        for (const bulk of bulks) {
          const firstRawId = bulk[0].rawId;
          const bulkDiff = firstRawId - lastBulkLastRawId;
          chunks.push(encodeVarInt(bulkDiff));
          chunks.push(encodeVarInt(bulk.length));
          for (const item of bulk) {
            chunks.push(encodeMcString(item.path));
            lastBulkLastRawId = item.rawId;
          }
        }
      }
    }
  }

  return Buffer.concat(chunks);
}

export function applyFabricRegistrySync(registry, syncedMap) {
  if (!registry || !syncedMap || !(syncedMap instanceof Map)) {
    return { totalEntries: 0, namespaces: [], itemsAdded: 0, blocksAdded: 0, entitiesAdded: 0 };
  }

  const modNamespaces = new Set();
  let totalEntries = 0;
  for (const idMap of syncedMap.values()) {
    for (const fullId of idMap.keys()) {
      totalEntries += 1;
      const [ns] = splitIdentifier(fullId);
      if (ns && ns !== 'minecraft') modNamespaces.add(ns);
    }
  }

  const vanillaMaxStateId = Object.values(registry.blocks || {}).reduce(
    (max, b) => Math.max(max, Number(b?.maxStateId ?? 0)),
    0
  );

  let itemsAdded = 0;
  const syncedItems = syncedMap.get('minecraft:item');
  if (syncedItems && registry.items) {
    for (const [fullId, rawId] of syncedItems.entries()) {
      if (registry.items[rawId] !== undefined) continue;
      const name = fullId.replace(/^minecraft:/, '');
      const entry = {
        id: rawId,
        name,
        displayName: fullId,
        stackSize: 64,
      };
      registry.items[rawId] = entry;
      if (registry.itemsByName && !registry.itemsByName[name]) {
        registry.itemsByName[name] = entry;
      }
      if (Array.isArray(registry.itemsArray)) {
        registry.itemsArray.push(entry);
      }
      itemsAdded += 1;
    }
  }

  let blocksAdded = 0;
  const syncedBlocks = syncedMap.get('minecraft:block');
  if (syncedBlocks && registry.blocks) {
    for (const [fullId, rawId] of syncedBlocks.entries()) {
      if (registry.blocks[rawId] !== undefined) continue;
      const name = fullId.replace(/^minecraft:/, '');
      const entry = {
        id: rawId,
        name,
        displayName: fullId,
        hardness: 1.5,
        resistance: 6,
        minStateId: 0,
        maxStateId: 0,
        states: [],
        drops: [],
        diggable: false,
        transparent: true,
        filterLight: 0,
        emitLight: 0,
        boundingBox: 'empty',
        material: 'default',
        shapes: [],
      };
      registry.blocks[rawId] = entry;
      if (registry.blocksByName && !registry.blocksByName[name]) {
        registry.blocksByName[name] = entry;
      }
      if (Array.isArray(registry.blocksArray)) {
        registry.blocksArray.push(entry);
      }
      blocksAdded += 1;
    }
  }

  let entitiesAdded = 0;
  const syncedEntities = syncedMap.get('minecraft:entity_type');
  if (syncedEntities && registry.entities) {
    for (const [fullId, rawId] of syncedEntities.entries()) {
      if (registry.entities[rawId] !== undefined) continue;
      const name = fullId.replace(/^minecraft:/, '');
      const entry = {
        id: rawId,
        internalId: rawId,
        name,
        displayName: fullId,
        width: 0.6,
        height: 1.8,
        type: 'other',
        category: 'Modded',
      };
      registry.entities[rawId] = entry;
      if (registry.entitiesByName && !registry.entitiesByName[name]) {
        registry.entitiesByName[name] = entry;
      }
      if (Array.isArray(registry.entitiesArray)) {
        registry.entitiesArray.push(entry);
      }
      entitiesAdded += 1;
    }
  }

  if (registry.blocksByStateId && !registry.blocksByStateId._isFabricProxy) {
    const fallbackModBlock = {
      id: -1,
      name: 'modded_block',
      displayName: 'Modded Block',
      hardness: 1.5,
      minStateId: 0,
      maxStateId: 0,
      states: [],
      drops: [],
      diggable: false,
      transparent: true,
      filterLight: 0,
      emitLight: 0,
      boundingBox: 'empty',
      shapes: [],
    };
    registry.blocksByStateId = new Proxy(registry.blocksByStateId, {
      get(target, prop, receiver) {
        if (prop === '_isFabricProxy') return true;
        const val = Reflect.get(target, prop, receiver);
        if (val !== undefined) return val;
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const n = Number(prop);
          if (n > vanillaMaxStateId && n < 2000000) {
            return { ...fallbackModBlock, minStateId: n, maxStateId: n };
          }
        }
        return val;
      },
    });
  }

  return {
    totalEntries,
    namespaces: Array.from(modNamespaces).sort(),
    itemsAdded,
    blocksAdded,
    entitiesAdded,
  };
}

export function attachFabricModCompat(bot, { log = () => {} } = {}) {
  const client = bot?._client;
  if (!client || typeof client.on !== 'function') {
    return { detach: () => {} };
  }

  let directChunks = [];
  let directBytes = 0;
  let registeredConfig = false;
  let pendingSyncedMap = null;

  const resetConfigTransfer = () => {
    registeredConfig = false;
    directChunks = [];
    directBytes = 0;
  };

  const applyPendingIfReady = () => {
    if (!pendingSyncedMap || !bot.registry) return;
    const map = pendingSyncedMap;
    pendingSyncedMap = null;
    try {
      const summary = applyFabricRegistrySync(bot.registry, map);
      log(`🧩 Đã đồng bộ ${summary.totalEntries} mục registry mod từ Fabric (${summary.namespaces.slice(0, 6).join(', ') || 'vanilla'}).`);
    } catch (err) {
      log(`⚠️ Không áp dụng được Fabric registry sync: ${err.message}`);
    }
  };

  const onCustomPayload = (packet) => {
    const channel = packet?.channel;
    if (!channel) return;

    if (client.state === 'configuration' && channel === 'minecraft:register') {
      const channels = decodeChannelList(packet.data);
      if (!registeredConfig && channels.some((ch) => ch.startsWith('fabric:'))) {
        registeredConfig = true;
        bot._fabricModded = true;
        client.write('custom_payload', {
          channel: 'minecraft:brand',
          data: encodeMcString('fabric'),
        });
        client.write('custom_payload', {
          channel: 'minecraft:register',
          data: Buffer.from('fabric:registry/sync/direct\0fabric:registry/sync', 'ascii'),
        });
        log('🧩 Phát hiện server Fabric — đã đăng ký kênh đồng bộ mod (Fabric Registry Sync).');
      }
      return;
    }

    if (channel === 'fabric:registry/sync/direct') {
      const buf = Buffer.isBuffer(packet.data)
        ? packet.data
        : Buffer.from(packet.data ?? '');
      if (buf.length > 0) {
        if (directBytes + buf.length <= MAX_DIRECT_SYNC_BYTES) {
          directChunks.push(buf);
          directBytes += buf.length;
        }
        return;
      }

      const fullBuf = Buffer.concat(directChunks);
      directChunks = [];
      directBytes = 0;

      try {
        const syncedMap = decodeDirectRegistrySync(fullBuf);
        if (bot.registry) {
          const summary = applyFabricRegistrySync(bot.registry, syncedMap);
          log(`🧩 Đã đồng bộ ${summary.totalEntries} mục registry mod từ Fabric (${summary.namespaces.slice(0, 6).join(', ') || 'vanilla'}).`);
        } else {
          pendingSyncedMap = syncedMap;
        }
      } catch (err) {
        log(`⚠️ Lỗi giải mã Fabric registry sync (${fullBuf.length} bytes): ${err.message}`);
      }

      client.write('custom_payload', {
        channel: 'fabric:registry/sync/complete',
        data: Buffer.alloc(0),
      });
      return;
    }

    if (client.state === 'configuration' && channel === 'fabric:registry/sync') {
      client.write('custom_payload', {
        channel: 'fabric:registry/sync/complete',
        data: Buffer.alloc(0),
      });
    }
  };

  client.on('success', resetConfigTransfer);
  client.on('start_configuration', resetConfigTransfer);
  client.on('custom_payload', onCustomPayload);
  bot.once('inject_allowed', applyPendingIfReady);

  return {
    detach() {
      const offClient = (ev, fn) => {
        if (typeof client.off === 'function') client.off(ev, fn);
        else if (typeof client.removeListener === 'function') client.removeListener(ev, fn);
      };
      offClient('success', resetConfigTransfer);
      offClient('start_configuration', resetConfigTransfer);
      offClient('custom_payload', onCustomPayload);
      if (typeof bot.off === 'function') bot.off('inject_allowed', applyPendingIfReady);
      else if (typeof bot.removeListener === 'function') bot.removeListener('inject_allowed', applyPendingIfReady);
    },
  };
}

export default attachFabricModCompat;
