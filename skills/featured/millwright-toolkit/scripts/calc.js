/**
 * Millwright Toolkit: deterministic shop-floor math.
 *
 * The on-device LLM picks the action and extracts parameters; every number
 * the user sees is computed here so small models never have to do
 * arithmetic. Works in the skill webview (window.MillCalc) and in Node
 * (module.exports) so the formulas can be unit tested.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Reference data
  // ---------------------------------------------------------------------------

  // Unified National Coarse threads: nominal diameter (in) -> threads per inch.
  const UNC_TPI = {
    0.25: 20, 0.3125: 18, 0.375: 16, 0.4375: 14, 0.5: 13, 0.5625: 12,
    0.625: 11, 0.75: 10, 0.875: 9, 1: 8, 1.125: 7, 1.25: 7, 1.375: 6, 1.5: 6,
  };

  // ISO metric coarse threads: nominal diameter (mm) -> pitch (mm).
  const ISO_COARSE_PITCH = {
    3: 0.5, 4: 0.7, 5: 0.8, 6: 1.0, 8: 1.25, 10: 1.5, 12: 1.75, 14: 2.0,
    16: 2.0, 20: 2.5, 24: 3.0, 30: 3.5, 36: 4.0,
  };

  // Typical nut factors (K). Real values scatter +/-25%; OEM specs win.
  const NUT_FACTOR = {
    dry: 0.20,
    zinc: 0.20,
    lubricated: 0.15,
    'anti-seize': 0.12,
  };

  // Proof strength by grade. SAE J429 (psi) and ISO 898-1 (MPa).
  function sae_proof_psi(grade, dia_in) {
    switch (grade) {
      case '2':
        if (dia_in <= 0.75) return 55000;
        if (dia_in <= 1.5) return 33000;
        break;
      case '5':
        if (dia_in <= 1) return 85000;
        if (dia_in <= 1.5) return 74000;
        break;
      case '8':
        if (dia_in <= 1.5) return 120000;
        break;
      default:
        throw new Error(`Unknown SAE grade "${grade}". Use 2, 5 or 8.`);
    }
    throw new Error(`SAE grade ${grade} is only rated up to 1-1/2 in.`);
  }

  function iso_proof_mpa(cls, dia_mm) {
    switch (cls) {
      case '8.8': return dia_mm <= 16 ? 580 : 600;
      case '10.9': return 830;
      case '12.9': return 970;
      default:
        throw new Error(`Unknown property class "${cls}". Use 8.8, 10.9 or 12.9.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const N_PER_LBF = 4.4482216;
  const NM_PER_FTLB = 1.3558179;

  function num(v, name) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (typeof n !== 'number' || !isFinite(n)) {
      throw new Error(`"${name}" must be a number (got ${JSON.stringify(v)}).`);
    }
    return n;
  }

  function positive(v, name) {
    const n = num(v, name);
    if (n <= 0) throw new Error(`"${name}" must be greater than zero.`);
    return n;
  }

  // Round to a sensible number of significant figures for display.
  function sig(x, digits = 4) {
    if (x === 0 || !isFinite(x)) return x;
    return Number(x.toPrecision(digits));
  }

  // "1/2", "0.5", "1-1/8", "1 1/8" -> 0.5 / 1.125
  function parse_inch(str) {
    const s = String(str).trim().replace(/["”]|in(ch)?$/gi, '').trim();
    const mixed = s.match(/^(\d+)[\s-]+(\d+)\/(\d+)$/);
    if (mixed) return +mixed[1] + mixed[2] / mixed[3];
    const frac = s.match(/^(\d+)\/(\d+)$/);
    if (frac) return frac[1] / frac[2];
    const dec = parseFloat(s);
    if (isFinite(dec)) return dec;
    throw new Error(`Can't read bolt diameter "${str}".`);
  }

  /**
   * Parse a fastener callout into diameter + thread.
   *   "M10", "M10x1.25", "m12 x 1.5"      -> metric
   *   "1/2", "1/2-13", "1/2-20 UNF", "3/4" -> inch
   * Falls back to coarse thread when pitch / TPI is omitted.
   */
  function parse_size(size) {
    const s = String(size).trim();
    const metric = s.match(/^m\s*(\d+(?:\.\d+)?)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?/i);
    if (metric) {
      const d = +metric[1];
      const pitch = metric[2] ? +metric[2] : ISO_COARSE_PITCH[d];
      if (!pitch) throw new Error(`No coarse pitch on file for M${d}; give it as M${d}x<pitch>.`);
      return { system: 'metric', d, pitch, label: `M${d}x${pitch}` };
    }
    // Split "1/2-13" / "1-1/8-7" / "1-8" into diameter and TPI. A trailing
    // "-<digits>" is always TPI; a mixed number like "1-1/8" ends in "/8".
    const cleaned = s.replace(/\s*(unc|unf|un)\s*$/i, '');
    const m = cleaned.match(/^(.*?)-(\d+)$/);
    let d;
    let tpi;
    if (m) {
      d = parse_inch(m[1]);
      tpi = +m[2];
    } else {
      d = parse_inch(cleaned);
      tpi = UNC_TPI[d];
    }
    if (!tpi) throw new Error(`No UNC thread on file for ${d} in; give it as <dia>-<TPI>.`);
    return { system: 'inch', d, tpi, label: `${fmt_inch(d)}-${tpi}` };
  }

  function fmt_inch(d) {
    const whole = Math.floor(d);
    const rem = d - whole;
    if (rem < 1e-9) return `${whole}`;
    for (const den of [2, 4, 8, 16]) {
      const n = rem * den;
      if (Math.abs(n - Math.round(n)) < 1e-6) {
        const frac = `${Math.round(n)}/${den}`;
        return whole ? `${whole}-${frac}` : frac;
      }
    }
    return `${d}`;
  }

  // ---------------------------------------------------------------------------
  // 1. Bolt torque: T = K * D * F,  F = preload% * proof * As
  // ---------------------------------------------------------------------------

  function bolt_torque(input) {
    if (!input.size) throw new Error('"size" is required, e.g. "1/2-13" or "M10".');
    const t = parse_size(input.size);
    const grade = String(input.grade ?? (t.system === 'metric' ? '8.8' : '5'))
      .replace(/^(sae|grade|gr\.?|class)\s*/i, '').trim();
    const finish = String(input.finish ?? 'dry').toLowerCase();
    const k = input.k != null ? positive(input.k, 'k') : NUT_FACTOR[finish];
    if (k == null) {
      throw new Error(`Unknown finish "${finish}". Use ${Object.keys(NUT_FACTOR).join(', ')} or pass k.`);
    }
    const preload_pct = input.preload_pct != null ? positive(input.preload_pct, 'preload_pct') : 75;
    if (preload_pct > 100) throw new Error('"preload_pct" is a percent of proof load and must be <= 100.');

    const warnings = [];
    if (preload_pct > 90) warnings.push('Preload above 90% of proof leaves little margin. Typical: 75% reusable, 90% permanent.');

    if (t.system === 'inch') {
      const As = 0.7854 * (t.d - 0.9743 / t.tpi) ** 2;          // in^2
      const proof = sae_proof_psi(grade, t.d);                  // psi
      const F = (preload_pct / 100) * proof * As;               // lbf
      const T_inlb = k * t.d * F;
      const T_ftlb = T_inlb / 12;
      return {
        action: 'bolt_torque',
        title: `Bolt torque · ${t.label} SAE Gr ${grade}`,
        primary: { label: 'Tightening torque', value: sig(T_ftlb, 3), unit: 'ft·lb' },
        values: {
          torque_ftlb: sig(T_ftlb, 3),
          torque_inlb: sig(T_inlb, 3),
          torque_nm: sig(T_ftlb * NM_PER_FTLB, 3),
          clamp_load_lbf: sig(F, 4),
          tensile_stress_area_in2: sig(As, 4),
          proof_strength_psi: proof,
          nut_factor_k: k,
          preload_pct,
        },
        formula: 'As = 0.7854·(d − 0.9743/n)²   F = %·Sp·As   T = K·d·F',
        inputs: { size: t.label, grade: `SAE ${grade}`, finish: input.k != null ? 'custom K' : finish },
        warnings,
      };
    }

    const As = 0.7854 * (t.d - 0.9382 * t.pitch) ** 2;          // mm^2
    const proof = iso_proof_mpa(grade, t.d);                    // MPa = N/mm^2
    const F = (preload_pct / 100) * proof * As;                 // N
    const T_nm = k * (t.d / 1000) * F;
    return {
      action: 'bolt_torque',
      title: `Bolt torque · ${t.label} class ${grade}`,
      primary: { label: 'Tightening torque', value: sig(T_nm, 3), unit: 'N·m' },
      values: {
        torque_nm: sig(T_nm, 3),
        torque_ftlb: sig(T_nm / NM_PER_FTLB, 3),
        clamp_load_kn: sig(F / 1000, 4),
        clamp_load_lbf: sig(F / N_PER_LBF, 4),
        tensile_stress_area_mm2: sig(As, 4),
        proof_strength_mpa: proof,
        nut_factor_k: k,
        preload_pct,
      },
      formula: 'As = 0.7854·(d − 0.9382·P)²   F = %·Sp·As   T = K·d·F',
      inputs: { size: t.label, grade: `ISO ${grade}`, finish: input.k != null ? 'custom K' : finish },
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Belt drive: speed ratio, belt speed, belt length
  // ---------------------------------------------------------------------------

  function belt_drive(input) {
    const units = (input.units ?? 'in').toLowerCase() === 'mm' ? 'mm' : 'in';
    const n1 = positive(input.driver_rpm, 'driver_rpm');
    const D1 = positive(input.driver_dia, 'driver_dia');
    const warnings = [];

    let D2;
    let n2;
    if (input.driven_dia != null) {
      D2 = positive(input.driven_dia, 'driven_dia');
      n2 = n1 * D1 / D2;
    } else if (input.target_rpm != null) {
      n2 = positive(input.target_rpm, 'target_rpm');
      D2 = D1 * n1 / n2;
    } else {
      throw new Error('Give either "driven_dia" or "target_rpm".');
    }

    const values = {
      driven_rpm: sig(n2, 4),
      driven_dia: sig(D2, 4),
      speed_ratio: sig(D2 / D1, 4),
    };

    let belt_speed_label;
    if (units === 'in') {
      const fpm = Math.PI * D1 * n1 / 12;
      values.belt_speed_fpm = sig(fpm, 4);
      belt_speed_label = `${values.belt_speed_fpm} ft/min`;
      if (fpm > 6500) warnings.push('Belt speed over 6,500 ft/min: check belt and sheave ratings, and balance the sheaves.');
    } else {
      const mps = Math.PI * D1 * n1 / 60000;
      values.belt_speed_mps = sig(mps, 4);
      belt_speed_label = `${values.belt_speed_mps} m/s`;
      if (mps > 33) warnings.push('Belt speed over 33 m/s: check belt and sheave ratings, and balance the sheaves.');
    }

    if (input.center_distance != null) {
      const C = positive(input.center_distance, 'center_distance');
      const L = 2 * C + Math.PI * (D1 + D2) / 2 + (D2 - D1) ** 2 / (4 * C);
      values.belt_length = sig(L, 4);
      // Arc of contact on the small sheave.
      const wrap = 180 - 2 * Math.asin(Math.min(1, Math.abs(D2 - D1) / (2 * C))) * 180 / Math.PI;
      values.small_sheave_wrap_deg = sig(wrap, 4);
      if (wrap < 120) warnings.push(`Only ${sig(wrap, 3)}° wrap on the small sheave; expect slip. Increase centers or add an idler.`);
    }

    if (D2 / D1 > 6 || D1 / D2 > 6) warnings.push('Speed ratio beyond about 6:1 on a single stage; consider two stages.');

    return {
      action: 'belt_drive',
      title: 'Belt drive',
      primary: { label: 'Driven speed', value: values.driven_rpm, unit: 'rpm' },
      values,
      formula: 'n₂ = n₁·D₁/D₂   v = π·D₁·n₁   L = 2C + π(D₁+D₂)/2 + (D₂−D₁)²/4C',
      inputs: {
        driver: `${D1} ${units} @ ${n1} rpm`,
        driven: `${sig(D2, 4)} ${units}`,
        belt_speed: belt_speed_label,
        ...(input.center_distance != null ? { centers: `${input.center_distance} ${units}` } : {}),
      },
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Bearing L10 life (ISO 281 basic rating life)
  // ---------------------------------------------------------------------------

  function bearing_life(input) {
    const C = positive(input.dynamic_rating, 'dynamic_rating');
    const P = positive(input.load, 'load');
    const n = positive(input.rpm, 'rpm');
    const type = String(input.type ?? 'ball').toLowerCase().startsWith('r') ? 'roller' : 'ball';
    const p = type === 'ball' ? 3 : 10 / 3;

    const L10_mrev = (C / P) ** p;
    const L10_h = L10_mrev * 1e6 / (60 * n);
    const warnings = [];
    if (P > 0.5 * C) warnings.push('Load exceeds 50% of C: outside the range where L10 is reliable.');
    if (P < 0.02 * C) warnings.push('Very light load (< 2% of C): risk of skidding; check minimum load.');

    return {
      action: 'bearing_life',
      title: `Bearing L10 life · ${type}`,
      primary: { label: 'L10 life', value: sig(L10_h, 3), unit: 'hours' },
      values: {
        l10_hours: sig(L10_h, 3),
        l10_million_rev: sig(L10_mrev, 4),
        years_continuous: sig(L10_h / 8760, 3),
        years_one_shift: sig(L10_h / 2080, 3),
        life_exponent: sig(p, 3),
        load_ratio_c_over_p: sig(C / P, 3),
      },
      formula: 'L10 = (C/P)^p · 10⁶ / (60·n),   p = 3 ball, 10/3 roller',
      inputs: { C: `${C}`, P: `${P}`, speed: `${n} rpm`, type },
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Rolling-element bearing defect frequencies (vibration analysis)
  // ---------------------------------------------------------------------------

  function bearing_faults(input) {
    const rpm = positive(input.rpm, 'rpm');
    const N = positive(input.balls, 'balls');
    const Bd = positive(input.ball_dia, 'ball_dia');
    const Pd = positive(input.pitch_dia, 'pitch_dia');
    const theta = num(input.contact_angle ?? 0, 'contact_angle') * Math.PI / 180;
    if (Bd >= Pd) throw new Error('"ball_dia" must be smaller than "pitch_dia".');

    const f = rpm / 60;
    const r = (Bd / Pd) * Math.cos(theta);
    const orders = {
      ftf: 0.5 * (1 - r),
      bsf: (Pd / (2 * Bd)) * (1 - r * r),
      bpfo: (N / 2) * (1 - r),
      bpfi: (N / 2) * (1 + r),
    };
    const hz = Object.fromEntries(Object.entries(orders).map(([k, v]) => [k, v * f]));

    const values = { shaft_hz: sig(f, 4) };
    for (const k of Object.keys(orders)) {
      values[`${k}_hz`] = sig(hz[k], 4);
      values[`${k}_cpm`] = sig(hz[k] * 60, 4);
      values[`${k}_order`] = sig(orders[k], 4);
    }

    return {
      action: 'bearing_faults',
      title: 'Bearing defect frequencies',
      primary: { label: 'BPFO (outer race)', value: values.bpfo_hz, unit: 'Hz' },
      values,
      formula: 'BPFO = N/2·f·(1−r)   BPFI = N/2·f·(1+r)   BSF = Pd/2Bd·f·(1−r²)   FTF = f/2·(1−r),   r = Bd/Pd·cosθ',
      inputs: {
        speed: `${rpm} rpm (${sig(f, 4)} Hz)`,
        rolling_elements: `${N}`,
        'Bd / Pd': `${Bd} / ${Pd}`,
        contact_angle: `${num(input.contact_angle ?? 0, 'contact_angle')}°`,
      },
      warnings: [],
    };
  }

  // ---------------------------------------------------------------------------

  const ACTIONS = { bolt_torque, belt_drive, bearing_life, bearing_faults };

  function run(input) {
    const fn = ACTIONS[input && input.action];
    if (!fn) {
      throw new Error(`Unknown action "${input && input.action}". Use one of: ${Object.keys(ACTIONS).join(', ')}.`);
    }
    return fn(input);
  }

  const api = { run, parse_size, ...ACTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MillCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
