import { hasNegationPhrase, normalizeText } from './commands.js';

const RESOURCE_TO_TEXT = {
  go: 'go',
  da: 'da',
  than: 'than',
  sat: 'sat',
  vang: 'vang',
  kim_cuong: 'kim cuong',
  cat: 'cat',
  dat: 'dat',
  banh_mi: 'banh mi',
  tao: 'tao',
  thit: 'thit',
  duoc: 'duoc',
  cuoc_sat: 'cuoc sat',
  kiem_sat: 'kiem sat',
  khien: 'khien',
  ban_che_tao: 'ban che tao',
  lo_nung: 'lo nung',
  ruong: 'ruong',
  cuoc_go: 'cuoc go',
  cuoc_da: 'cuoc da',
  cuoc_kim_cuong: 'cuoc kim cuong',
  riu_sat: 'riu sat',
  van_go: 'van go',
  gay: 'gay',
  cung: 'cung',
  ten: 'ten',
  xo: 'xo',
  giuong: 'giuong',
};

export const INTENT_QUESTIONS = {
  intent: {
    type: 'choice',
    instructions: 'Ý định chính của người chơi là gì?',
    criteria: {
      follow: 'Đi theo người chơi',
      stay: 'Đứng yên hoặc dừng việc đang làm',
      come: 'Chạy lại gần chỗ người chơi',
      go_home: 'Đi về nhà',
      set_home: 'Đặt vị trí hiện tại làm nhà',
      store: 'Cất đồ vào rương',
      list_chests: 'Hỏi xem trong rương đang chứa những đồ gì',
      take_from_chest: 'Lấy đồ từ trong rương ra',
      sleep: 'Đi ngủ trên giường',
      recover_death: 'Quay lại chỗ chết nhặt đồ',
      gather: 'Đi thu thập, đào, chặt tài nguyên',
      craft: 'Chế tạo, làm công cụ, vũ khí, khiên, bàn chế tạo, rương, đuốc',
      smelt: 'Nung quặng sắt/vàng hoặc nướng thịt, nấu đồ bằng lò nung',
      farm: 'Thu hoạch nông sản và gieo hạt làm ruộng',
      tunnel: 'Đào hầm xuyên đá tìm quặng',
      give: 'Đưa, cho, vứt vật phẩm hoặc đồ ăn cho người chơi',
      status: 'Hỏi máu, thức ăn, trang bị hoặc trạng thái bot',
      gear: 'Mặc giáp hoặc kiểm tra trang bị',
      list_waypoints: 'Xem danh sách các điểm đã lưu',
      help: 'Hỏi bot biết làm gì, chức năng gì hoặc xem danh sách lệnh',
      greet: 'Chào hỏi bot',
      inventory: 'Hỏi xem trong túi đồ của bot đang có gì',
      combat_off: 'Tắt chế độ đánh nhau, hòa bình, ngừng tấn công quái',
      combat_on: 'Bật lại chế độ chiến đấu, tự vệ',
      eat: 'Ăn thức ăn hồi đói ngay',
      drop_junk: 'Vứt bớt giáp/công cụ cũ dởm để dọn túi',
      unknown: 'Nói chuyện phiếm hoặc không rõ yêu cầu',
    },
  },
  resource: {
    type: 'choice',
    instructions: 'Loại tài nguyên hoặc vật phẩm được nhắc tới (nếu có)?',
    criteria: {
      go: 'Gỗ, củi, cây',
      da: 'Đá, cuội',
      than: 'Than',
      sat: 'Sắt, quặng sắt',
      vang: 'Vàng',
      kim_cuong: 'Kim cương',
      cat: 'Cát',
      dat: 'Đất',
      banh_mi: 'Bánh mì, đồ ăn',
      tao: 'Táo',
      thit: 'Thịt sống hoặc chín',
      duoc: 'Đuốc',
      cuoc_go: 'Cuốc gỗ',
      cuoc_da: 'Cuốc đá',
      cuoc_sat: 'Cuốc sắt hoặc cuốc đào',
      cuoc_kim_cuong: 'Cuốc kim cương',
      kiem_sat: 'Kiếm sắt hoặc kiếm',
      riu_sat: 'Rìu sắt hoặc rìu',
      khien: 'Khiên',
      cung: 'Cung tên',
      ten: 'Mũi tên',
      xo: 'Xô nước / xô',
      ban_che_tao: 'Bàn chế tạo',
      van_go: 'Ván gỗ',
      gay: 'Gậy gỗ',
      lo_nung: 'Lò nung',
      ruong: 'Rương',
      giuong: 'Giường',
      none: 'Không nhắc tới vật phẩm cụ thể',
    },
  },
};

export async function classifyIntent(llm, rawMessage, { minConfidence = 0.55 } = {}) {
  const text = String(rawMessage ?? '').trim();
  if (!llm?.ask || !text) return null;
  if (hasNegationPhrase(text) || /[;]/.test(text) || text.includes('->')) {
    return null;
  }

  const res = await llm.ask({
    state: { message: text },
    questions: INTENT_QUESTIONS,
  });

  const intentAns = res?.answers?.intent;
  const intent = intentAns?.choice ?? 'unknown';
  const confidence = intentAns?.confidence ?? 0;
  if (intent === 'unknown' || confidence < minConfidence) {
    return null;
  }

  const resAns = res?.answers?.resource;
  const resourceKey = resAns?.choice ?? 'none';
  const resourceText = RESOURCE_TO_TEXT[resourceKey] ?? null;

  const numMatch = text.match(/\b(\d+)\b/);
  const parsedCount = numMatch ? Math.max(1, Math.min(256, Number(numMatch[1]))) : null;

  let command = null;
  if (intent === 'gather') {
    if (!resourceText) return null;
    const normText = normalizeText(text);
    const wantsDelivery =
      /\b(?:cho toi|cho minh|cho tao|dua toi|mang cho toi)\b/.test(normText) &&
      !/\b(?:che tao|lam |craft|nung|nuong|cat |store)\b/.test(normText);
    const gatherCmd = { type: 'gather', count: parsedCount ?? 16, target: resourceText };
    command = wantsDelivery
      ? { type: 'chain', steps: [gatherCmd, { type: 'give', count: 'all', target: resourceText }] }
      : gatherCmd;
  } else if (intent === 'give' || intent === 'take_from_chest') {
    if (!resourceText) return null;
    command = { type: intent, count: parsedCount ?? 1, target: resourceText };
  } else if (intent === 'craft' || intent === 'smelt') {
    if (!resourceText) return null;
    command = { type: intent, count: parsedCount ?? 1, target: resourceText };
  } else if (intent === 'tunnel') {
    command = { type: 'tunnel', length: parsedCount ?? 16 };
  } else {
    command = { type: intent };
  }

  return {
    command,
    confidence,
    intent,
    resource: resourceText,
  };
}
