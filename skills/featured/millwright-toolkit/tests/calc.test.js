// Run: node --test skills/featured/millwright-toolkit/tests/calc.test.js
// Expected values come from published references noted beside each case.
const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../scripts/calc.js');

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected} ±${tol}, got ${actual}`);

test('parse_size handles common callouts', () => {
  assert.deepEqual(calc.parse_size('1/2-13'), { system: 'inch', d: 0.5, tpi: 13, label: '1/2-13' });
  assert.equal(calc.parse_size('1/2').tpi, 13);
  assert.equal(calc.parse_size('1/2-20 UNF').tpi, 20);
  assert.equal(calc.parse_size('1-1/8').d, 1.125);
  assert.equal(calc.parse_size('1-1/8-7').tpi, 7);
  assert.equal(calc.parse_size('1-8').d, 1);
  assert.equal(calc.parse_size('1-14').tpi, 14);
  assert.equal(calc.parse_size('5/16').label, '5/16-18');
  assert.deepEqual(calc.parse_size('M10'), { system: 'metric', d: 10, pitch: 1.5, label: 'M10x1.5' });
  assert.equal(calc.parse_size('m12 x 1.25').pitch, 1.25);
  assert.throws(() => calc.parse_size('M11'), /No coarse pitch/);
});

test('bolt_torque: 1/2-13 Gr 5 dry ≈ 75 ft·lb (standard SAE torque charts)', () => {
  const r = calc.run({ action: 'bolt_torque', size: '1/2-13', grade: '5' });
  near(r.values.tensile_stress_area_in2, 0.1419, 0.0002, 'As');   // ASME B1.1 table
  near(r.values.torque_ftlb, 75, 1.5, 'torque');
  near(r.values.clamp_load_lbf, 9050, 20, 'clamp');
});

test('bolt_torque: 3/8-16 Gr 8 dry ≈ 44 ft·lb', () => {
  const r = calc.run({ action: 'bolt_torque', size: '3/8', grade: 'Grade 8' });
  near(r.values.torque_ftlb, 44, 1, 'torque');
});

test('bolt_torque: M10 8.8 dry ≈ 50 N·m, As = 58.0 mm² (ISO 898-1)', () => {
  const r = calc.run({ action: 'bolt_torque', size: 'M10', grade: '8.8' });
  near(r.values.tensile_stress_area_mm2, 58.0, 0.1, 'As');
  near(r.values.torque_nm, 50.5, 0.5, 'torque');
});

test('bolt_torque: lubrication lowers torque by K ratio', () => {
  const dry = calc.run({ action: 'bolt_torque', size: 'M16', grade: '10.9', finish: 'dry' });
  const lub = calc.run({ action: 'bolt_torque', size: 'M16', grade: '10.9', finish: 'lubricated' });
  near(lub.values.torque_nm / dry.values.torque_nm, 0.75, 0.01, 'ratio');
  assert.equal(lub.values.clamp_load_kn, dry.values.clamp_load_kn);
});

test('bolt_torque: rejects grade outside its size range', () => {
  assert.throws(() => calc.run({ action: 'bolt_torque', size: '1-3/4', grade: '8' }), /No UNC|only rated/);
  assert.throws(() => calc.run({ action: 'bolt_torque', size: 'M10', grade: '4.6' }), /Unknown property class/);
});

test('belt_drive: 1750 rpm motor, 4 in → 8 in sheave', () => {
  const r = calc.run({ action: 'belt_drive', driver_rpm: 1750, driver_dia: 4, driven_dia: 8, center_distance: 20 });
  assert.equal(r.values.driven_rpm, 875);
  near(r.values.belt_speed_fpm, 1833, 1, 'belt speed');
  near(r.values.belt_length, 59.05, 0.05, 'length');  // 40 + 18.85 + 0.2
  near(r.values.small_sheave_wrap_deg, 168.5, 0.2, 'wrap');
});

test('belt_drive: solve sheave for target rpm', () => {
  const r = calc.run({ action: 'belt_drive', driver_rpm: 1750, driver_dia: 5, target_rpm: 1200 });
  near(r.values.driven_dia, 7.292, 0.001, 'driven dia');
});

test('bearing_life: ball C/P = 10 at 1000 rpm → 16,667 h', () => {
  const r = calc.run({ action: 'bearing_life', dynamic_rating: 14000, load: 1400, rpm: 1000 });
  near(r.values.l10_hours, 16700, 50, 'L10h');
  assert.equal(r.values.l10_million_rev, 1000);
});

test('bearing_life: roller uses 10/3 exponent', () => {
  const r = calc.run({ action: 'bearing_life', dynamic_rating: 10, load: 1, rpm: 1000, type: 'roller' });
  near(r.values.l10_million_rev, 2154, 1, 'L10');
});

test('bearing_faults: SKF 6205 orders match published values', () => {
  // 9 balls, Bd 7.94 mm, Pd 39.04 mm, 0°: BPFO 3.585, BPFI 5.415, BSF 2.357, FTF 0.398
  const r = calc.run({ action: 'bearing_faults', rpm: 1800, balls: 9, ball_dia: 7.94, pitch_dia: 39.04 });
  near(r.values.bpfo_order, 3.585, 0.002, 'BPFO');
  near(r.values.bpfi_order, 5.415, 0.002, 'BPFI');
  near(r.values.bsf_order, 2.357, 0.002, 'BSF');
  near(r.values.ftf_order, 0.398, 0.001, 'FTF');
  near(r.values.bpfo_hz, 107.6, 0.2, 'BPFO Hz');
});

test('run: unknown action and bad numbers give clear errors', () => {
  assert.throws(() => calc.run({ action: 'weld' }), /Unknown action/);
  assert.throws(() => calc.run({ action: 'bearing_life', dynamic_rating: 'abc', load: 1, rpm: 1 }), /must be a number/);
});
