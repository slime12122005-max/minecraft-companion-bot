import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter, hasNegationPhrase, normalizeText } from '../src/commands.js';
import { resolveCandidateNames } from '../src/survival/constants.js';
import { resolveCraftName } from '../src/crafting_recipes.js';

const router = new CommandRouter();

test('normalizeText strips Vietnamese accents including đ', () => {
  assert.equal(normalizeText('  Đứng   Đây  '), 'dung day');
  assert.equal(normalizeText('ĐÂY LÀ NHÀ'), 'day la nha');
});

test('parses movement, home, and help aliases with and without accents', () => {
  assert.deepEqual(router.parse('theo tôi'), { type: 'follow' });
  assert.deepEqual(router.parse('theo toi'), { type: 'follow' });
  assert.deepEqual(router.parse('tt'), { type: 'follow' });
  assert.deepEqual(router.parse('đứng đây'), { type: 'stay' });
  assert.deepEqual(router.parse('lại đây'), { type: 'come' });
  assert.deepEqual(router.parse('đây là nhà'), { type: 'set_home' });
  assert.deepEqual(router.parse('về nhà'), { type: 'go_home' });
  assert.deepEqual(router.parse('cất đồ'), { type: 'store' });
  assert.deepEqual(router.parse('ngủ'), { type: 'sleep' });
  assert.deepEqual(router.parse('nhặt đồ chết'), { type: 'recover_death' });
  assert.deepEqual(router.parse('recover'), { type: 'recover_death' });
  assert.deepEqual(router.parse('giúp'), { type: 'help' });
});

test('parses coordinates and waypoints', () => {
  assert.deepEqual(router.parse('đi tới 100 64 -50'), { type: 'goto', x: 100, y: 64, z: -50 });
  assert.deepEqual(router.parse('di toi x=10 y=70 z=-20'), { type: 'goto', x: 10, y: 70, z: -20 });
  assert.deepEqual(router.parse('lưu điểm Mỏ Sắt'), { type: 'save_waypoint', name: 'mo sat' });
  assert.deepEqual(router.parse('đi tới mỏ sắt'), { type: 'goto_waypoint', name: 'mo sat' });
});

test('parses gather, give, and build commands', () => {
  assert.deepEqual(router.parse('lấy 32 gỗ'), { type: 'gather', count: 32, target: 'go' });
  assert.deepEqual(router.parse('tìm kiếm đá'), { type: 'gather', count: 16, target: 'da' });
  assert.deepEqual(router.parse('đưa tôi 10 bánh mì'), { type: 'give', count: 10, target: 'banh mi' });
  assert.deepEqual(router.parse('xây MyHouse.schem 90'), { type: 'build', file: 'MyHouse.schem', rotation: 90 });
  assert.deepEqual(router.parse('xác nhận'), { type: 'confirm' });
  assert.deepEqual(router.parse('hủy'), { type: 'cancel' });
});

test('handles edge inputs, negative coords, comma syntax, and unknown commands', () => {
  assert.equal(router.parse('   '), null);
  assert.deepEqual(router.parse('chạy tới -120 64 -300'), { type: 'goto', x: -120, y: 64, z: -300 });
  assert.deepEqual(router.parse('goto x=-10, y=64, z=25'), { type: 'goto', x: -10, y: 64, z: 25 });
  assert.deepEqual(router.parse('danh sach diem'), { type: 'list_waypoints' });
  assert.deepEqual(router.parse('cất đồ'), { type: 'store' });
  assert.deepEqual(router.parse('đây là rương'), { type: 'set_chest' });
  assert.deepEqual(router.parse('trang bi'), { type: 'gear' });
  assert.deepEqual(router.parse('build builds/castle.schem 270'), { type: 'build', file: 'builds/castle.schem', rotation: 270 });
  assert.deepEqual(router.parse('tải mẫu https://www.minecraft-schematics.com/house.schem'), {
    type: 'download_schematic',
    url: 'https://www.minecraft-schematics.com/house.schem',
    filename: null,
  });
  assert.deepEqual(router.parse('download https://www.minecraft-schematics.com/a.schem my.schem'), {
    type: 'download_schematic',
    url: 'https://www.minecraft-schematics.com/a.schem',
    filename: 'my.schem',
  });
  assert.deepEqual(router.parse('chế tạo 4 đuốc'), { type: 'craft', count: 4, target: 'duoc' });
  assert.deepEqual(router.parse('nung 8 sắt'), { type: 'smelt', count: 8, target: 'sat' });
  assert.deepEqual(router.parse('lấy từ rương 5 sắt'), { type: 'take_from_chest', count: 5, target: 'sat' });
  assert.deepEqual(router.parse('xem rương'), { type: 'list_chests' });
  assert.deepEqual(router.parse('đào hầm 24'), { type: 'tunnel', length: 24 });
  assert.deepEqual(router.parse('làm ruộng'), { type: 'farm' });
  assert.deepEqual(router.parse('bật web'), { type: 'dashboard_on' });
  assert.deepEqual(router.parse('dọn mặt bằng house.schem 90'), {
    type: 'prepare',
    file: 'house.schem',
    rotation: 90,
  });
  assert.deepEqual(router.parse('nói chuyện linh tinh'), { type: 'unknown', raw: 'nói chuyện linh tinh' });
});

test('parseChain splits multi-step chains across connectors and preserves single commands', () => {
  assert.deepEqual(router.parseChain('lấy 4 gỗ rồi chế tạo 1 bàn chế tạo'), {
    type: 'chain',
    steps: [
      { type: 'gather', count: 4, target: 'go' },
      { type: 'craft', count: 1, target: 'ban che tao' },
    ],
  });
  assert.deepEqual(router.parseChain('lấy 4 gỗ sau đó ngủ -> về nhà; làm ruộng'), {
    type: 'chain',
    steps: [
      { type: 'gather', count: 4, target: 'go' },
      { type: 'sleep' },
      { type: 'go_home' },
      { type: 'farm' },
    ],
  });
  assert.deepEqual(router.parseChain('lấy 8 gỗ'), { type: 'gather', count: 8, target: 'go' });
  assert.deepEqual(router.parseChain('bạn thấy sao rồi còn ổn không?'), {
    type: 'unknown',
    raw: 'bạn thấy sao rồi còn ổn không?',
  });
  assert.deepEqual(router.parse('chào bot'), { type: 'greet' });
  assert.deepEqual(router.parse('trong túi có gì?'), { type: 'inventory' });
  assert.deepEqual(router.parseChain('ê bot ơi lấy cho tao 4 gỗ rồi làm cho tao 1 bàn chế tạo nhé'), {
    type: 'chain',
    steps: [
      { type: 'gather', count: 4, target: 'go' },
      { type: 'craft', count: 1, target: 'ban che tao' },
    ],
  });
  assert.equal(router.parse('Đã chỉnh thời gian thành 1000'), null);
  assert.equal(router.parse('Set the time to 1000'), null);
  assert.equal(router.parse('Set the time to 1000]'), null);
  assert.deepEqual(router.parse('lấy len hồng'), { type: 'gather', count: 16, target: 'len hong' });
  assert.deepEqual(router.parse('chặt cây cho tôi'), { type: 'gather', count: 16, target: 'cay' });
  assert.deepEqual(router.parse('tắt đánh'), { type: 'combat_off' });
  assert.deepEqual(router.parse('bật đánh'), { type: 'combat_on' });
  assert.deepEqual(router.parse('ăn'), { type: 'eat' });
  assert.deepEqual(router.parse('dọn túi'), { type: 'drop_junk' });
  assert.deepEqual(router.parse('bạn làm đc j'), { type: 'help' });
  assert.deepEqual(router.parse('m đang ở đâu'), { type: 'status' });
  assert.deepEqual(router.parse('ok cảm ơn nhé'), { type: 'ack' });

  // Gather-and-deliver + "all" + polite subject stripping
  assert.deepEqual(router.parse('chặt cây cho tôi'), { type: 'gather', count: 16, target: 'cay' });
  assert.deepEqual(router.parseChain('chặt cây cho tôi'), {
    type: 'chain',
    steps: [
      { type: 'gather', count: 16, target: 'cay' },
      { type: 'give', count: 'all', target: 'cay' },
    ],
  });
  assert.deepEqual(router.parseChain('bạn chặt cây cho tôi'), {
    type: 'chain',
    steps: [
      { type: 'gather', count: 16, target: 'cay' },
      { type: 'give', count: 'all', target: 'cay' },
    ],
  });
  assert.deepEqual(router.parseChain('chặt 5 gỗ rồi đưa tôi'), {
    type: 'chain',
    steps: [
      { type: 'gather', count: 5, target: 'go' },
      { type: 'give', count: 'all', target: 'go' },
    ],
  });
  assert.deepEqual(router.parse('đưa tôi hết gỗ'), { type: 'give', count: 'all', target: 'go' });
  assert.deepEqual(router.parse('đưa hết gỗ cho tôi'), { type: 'give', count: 'all', target: 'go' });
  assert.deepEqual(router.parse('bạn khỏe không'), { type: 'greet' });
});

test('router.route fast-routes exact commands, resolves minor typos locally, and escalates complex text to llm_needed', () => {
  const exact = router.route('về nhà');
  assert.equal(exact.tier, 'exact');
  assert.equal(exact.confidence, 1.0);
  assert.deepEqual(exact.command, { type: 'go_home' });
  assert.ok(exact.latencyMs < 50);

  const fuzzyHome = router.route('ve nhaa');
  assert.equal(fuzzyHome.tier, 'fuzzy');
  assert.ok(fuzzyHome.confidence >= 0.75);
  assert.deepEqual(fuzzyHome.command, { type: 'go_home' });

  const fuzzyFollow = router.route('theo toii');
  assert.equal(fuzzyFollow.tier, 'fuzzy');
  assert.ok(fuzzyFollow.confidence >= 0.75);
  assert.deepEqual(fuzzyFollow.command, { type: 'follow' });

  const complex = router.route('bạn đề xuất xem hôm nay mình nên đi đào kim cương hay xây nhà?');
  assert.equal(complex.tier, 'llm_needed');
  assert.equal(complex.command.type, 'unknown');
});

test('supports emergency ! prefix commands and blocks negated/prohibition phrases from fuzzy misrouting', () => {
  assert.deepEqual(router.parse('!stop'), { type: 'stay' });
  assert.deepEqual(router.parse('!come'), { type: 'come' });
  assert.deepEqual(router.parse('!home'), { type: 'go_home' });
  assert.deepEqual(router.parse('!follow'), { type: 'follow' });
  assert.deepEqual(router.parse('!cancel'), { type: 'cancel' });
  assert.deepEqual(router.parse('!confirm'), { type: 'confirm' });
  assert.deepEqual(router.parse('!unknowncmd'), { type: 'unknown', raw: '!unknowncmd' });

  assert.equal(hasNegationPhrase('đứng đây'), false);
  assert.equal(hasNegationPhrase('bạn khỏe không'), false);
  assert.equal(hasNegationPhrase('đừng đào đá nữa chạy lại đây đưa sắt cho mk'), true);
  assert.equal(hasNegationPhrase('ko cần đào nữa'), true);
  assert.equal(hasNegationPhrase("don't mine stone"), true);

  const negatedFuzzy = router.route('đừng theo');
  assert.equal(negatedFuzzy.tier, 'llm_needed');
  assert.equal(negatedFuzzy.command.type, 'unknown');

  const negatedStatus = router.route('không cần hỏi đang ở đâu');
  assert.equal(negatedStatus.tier, 'llm_needed');
  assert.equal(negatedStatus.command.type, 'unknown');

  assert.equal(router.route('đứng đây').command.type, 'stay');
  assert.equal(router.route('tắt đánh').command.type, 'combat_off');
});

test('strips Vietnamese indefinite quantifiers, unit classifiers, and particles cleanly while guarding questions', async () => {
  assert.deepEqual(router.parse('chặt ít gỗ đi'), { type: 'gather', count: 16, target: 'go', needsCount: true, autoDeliver: true });
  const woodCandidates = resolveCandidateNames('it go di');
  assert.ok(woodCandidates.includes('oak_log'));
  assert.ok(woodCandidates.includes('birch_log'));

  assert.deepEqual(router.parse('chặt 1 ít gỗ nha'), { type: 'gather', count: 16, target: 'go', needsCount: true, autoDeliver: true });
  assert.deepEqual(router.parse('đào vài cục sắt đi'), { type: 'gather', count: 16, target: 'sat', needsCount: true, autoDeliver: true });
  assert.deepEqual(router.parse('lấy 16 khối đá cuội coi'), { type: 'gather', count: 16, target: 'da cuoi' });
  assert.deepEqual(router.parse('chặt cây bạch dương đi'), { type: 'gather', count: 16, target: 'cay bach duong' });
  assert.deepEqual(resolveCandidateNames('cây bạch dương đi'), ['birch_log', 'birch_wood']);
  assert.deepEqual(router.parse('chặt cây đước đi'), { type: 'gather', count: 16, target: 'cay duoc' });
  assert.deepEqual(resolveCandidateNames('cay duoc'), ['mangrove_log', 'mangrove_wood']);
  assert.deepEqual(router.parse('lấy 10 đuốc đi'), { type: 'gather', count: 10, target: 'duoc' });

  assert.deepEqual(router.parse('làm 1 cái cúp đá đi'), { type: 'craft', count: 1, target: 'cup da' });
  assert.equal(resolveCraftName('1 cái cúp đá đi'), 'stone_pickaxe');
  assert.equal(resolveCraftName('cây đuốc'), 'torch');

  const { parseQuantityAnswer } = await import('../src/commands.js');
  assert.deepEqual(parseQuantityAnswer('10'), { mode: 'number', count: 10 });
  assert.deepEqual(parseQuantityAnswer('tầm 16 cục'), { mode: 'number', count: 16 });
  assert.deepEqual(parseQuantityAnswer('lấy hết'), { mode: 'all', count: 'all' });

  assert.equal(router.parse('chặt gỗ không?').type, 'unknown');
  assert.equal(router.parse('làm sao chế khiên?').type, 'unknown');

  assert.deepEqual(router.parse('chặt in ít gỗ'), { type: 'gather', count: 16, target: 'go', needsCount: true, autoDeliver: true });
  const inItCandidates = resolveCandidateNames('in it go');
  assert.ok(inItCandidates.includes('oak_log'));
  assert.ok(inItCandidates.includes('birch_log'));
  assert.deepEqual(router.parse('chặt chút ít gỗ'), { type: 'gather', count: 16, target: 'go', needsCount: true, autoDeliver: true });
  assert.deepEqual(router.parse('đào giúp mình tí xíu sắt'), { type: 'gather', count: 16, target: 'sat', needsCount: true, autoDeliver: true });
  assert.deepEqual(router.parse('chặt hộ tôi ít gỗ đi'), { type: 'gather', count: 16, target: 'go', needsCount: true, autoDeliver: true });
  assert.deepEqual(router.parse('kiếm vài ba cục than'), { type: 'gather', count: 16, target: 'than', needsCount: true, autoDeliver: true });
  assert.deepEqual(router.parseChain('chặt cho tui in ít gỗ'), {
    type: 'chain',
    steps: [
      { type: 'gather', count: 16, target: 'go', needsCount: true, autoDeliver: false },
      { type: 'give', count: 'all', target: 'go' },
    ],
    needsCount: true,
  });

  assert.deepEqual(router.parse('tự do đi'), { type: 'unknown', raw: 'tự do đi' });
  assert.deepEqual(router.parse('về nhà'), { type: 'go_home' });
  assert.deepEqual(router.parse('đây là nhà'), { type: 'set_home' });

  // Natural downward excavation phrases & conversational verb-clause guards
  assert.deepEqual(router.parse('đào thẳng xuống là có đá'), { type: 'gather', count: 16, target: 'da' });
  assert.deepEqual(router.parse('đào thẳng xuống'), { type: 'gather', count: 16, target: 'da' });
  assert.deepEqual(router.parse('đào xuống dưới'), { type: 'gather', count: 16, target: 'da' });
  assert.deepEqual(router.parse('đào thẳng xuống lấy 20 đá'), { type: 'gather', count: 20, target: 'da' });
  assert.equal(router.parse('đào kiểu gì mới có kim cương').type, 'unknown');
  assert.equal(router.parse('tìm mãi chẳng thấy sắt').type, 'unknown');
  assert.equal(router.parse('làm thế thì lâu lắm').type, 'unknown');
});
