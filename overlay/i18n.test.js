'use strict';

const assert = require('assert');
const i18n = require('./src/i18n');

console.log('Testing i18n module...');

// 1. Language Toggle
i18n.setLanguage('ko');
assert.strictEqual(i18n.getLanguage(), 'ko');
assert.strictEqual(i18n.t('panel.optimizer'), '⚡ 최적배치');

// 2. Combo Names in Korean
assert.strictEqual(i18n.comboName('EMBER'), '잉걸불');
assert.strictEqual(i18n.comboName('FROST'), '얼음무구');
assert.strictEqual(i18n.comboName('FLAMESWORD'), '태양검');
assert.strictEqual(i18n.comboName('DARKCLOUD'), '먹구름');
assert.strictEqual(i18n.comboName('yinggalbul'), '잉걸불');
assert.strictEqual(i18n.comboName('sun_sword'), '태양검');
assert.strictEqual(i18n.comboName('extrium'), '먹구름');
assert.strictEqual(i18n.comboName('magic_engineering'), '마법공학');

// 3. Switch to English
i18n.setLanguage('en');
assert.strictEqual(i18n.getLanguage(), 'en');
assert.strictEqual(i18n.t('panel.optimizer'), '⚡ Optimizer');
assert.strictEqual(i18n.comboName('EMBER'), 'Ember');
assert.strictEqual(i18n.comboName('FROST'), 'Frost Relic');
assert.strictEqual(i18n.comboName('FLAMESWORD'), 'Solar Blade');
assert.strictEqual(i18n.comboName('DARKCLOUD'), 'Storm Cloud');

// 4. Talents & Rarities
assert.strictEqual(i18n.abilityName('will'), 'Will');
assert.strictEqual(i18n.abilityName('rapid'), 'Swiftness');
assert.strictEqual(i18n.rarityName('Legend'), 'Legendary');
assert.strictEqual(i18n.rarityName('Eternal'), 'Mythic');

// Switch back to Korean
i18n.setLanguage('ko');
assert.strictEqual(i18n.abilityName('will'), '의지');
assert.strictEqual(i18n.abilityName('rapid'), '신속');
assert.strictEqual(i18n.rarityName('Legend'), '전설');
assert.strictEqual(i18n.rarityName('Eternal'), '신화');

// 5. Params Interpolation
assert.strictEqual(i18n.t('opt.movesCount', { moves: 3 }), '3개 이동');
assert.strictEqual(i18n.t('tt.setRequirement', { count: 4 }), '(4세트)');

console.log('ALL i18n TESTS PASSED SUCCESSFULLY! 🎉');
