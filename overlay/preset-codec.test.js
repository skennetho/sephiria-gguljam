const assert = require('assert');
const {
  encodePreset,
  decodePreset,
  buildPlainFromWikiBuild,
  getOrGeneratePresetCode,
} = require('./src/preset-codec');

console.log('Testing preset-codec...');

// Test 1: Basic encode / decode
const sample = "AAP1\r\nW:101\r\nC:OrangeRabbit\r\nS:\r\nF:1001,1002,1005\r\nP:1,5;2,10\r\nB:1\r\nR:attack,5;critical,10\r\n";
const code = encodePreset(sample);
assert(code.startsWith('AAF_PRESET_OBFZ|v1'), 'Must have correct header');

const decoded = decodePreset(code);
assert.strictEqual(decoded, sample, 'Decoded text must match original sample');
console.log('✔ Test 1: Basic encode/decode passed');

// Test 2: Auto-generate from Wiki Build JSON
const wikiBuild = {
  id: 980,
  title: '티모는 사랑입니다',
  costume: 'orange_rabbit',
  weapon: 105,
  artifacts: [1001, 2042, 3010],
  passives: [
    { id: 1, point: 5 },
    { id: 2, point: 10 }
  ],
  fruit_skewer: [
    { key: 'attack', value: 5 },
    { key: 'adaptive_drop_bonus', value: 1 }
  ]
};

const generatedCode = getOrGeneratePresetCode(wikiBuild);
assert(generatedCode.startsWith('AAF_PRESET_OBFZ|v1'), 'Generated code must have valid header');

const plainGen = decodePreset(generatedCode);
console.log('\nGenerated AAP1 Plaintext:');
console.log(plainGen);

assert(plainGen.includes('W:105'), 'Must contain W:105');
assert(plainGen.includes('C:OrangeRabbit'), 'Must contain C:OrangeRabbit');
assert(plainGen.includes('F:1001,2042,3010'), 'Must contain F:1001,2042,3010');
assert(plainGen.includes('P:1,5;2,10'), 'Must contain P:1,5;2,10');
assert(plainGen.includes('R:attack,5'), 'Must contain R:attack,5');
console.log('✔ Test 2: Wiki Build auto-generation passed');

console.log('\nALL PRESET CODEC TESTS PASSED SUCCESSFULLY! 🎉');
