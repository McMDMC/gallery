---
name: millwright-toolkit
description: Shop-floor calculator for mechanics and millwrights. Use when the user asks for bolt torque or clamp load, belt or pulley (sheave) speeds and belt length, bearing L10 life, or bearing defect frequencies (BPFO, BPFI, BSF, FTF) for vibration analysis.
metadata:
  homepage: https://github.com/McMDMC/gallery/tree/main/skills/featured/millwright-toolkit
---

# Millwright Toolkit

## Instructions

Never do the arithmetic yourself. Always call the `run_js` tool with:
- **script name**: `index.html`
- **data**: a JSON string with an `action` field and the fields for that action, listed below.

After the tool returns, give the main result in one or two short sentences using the exact
numbers it returned, then repeat any warnings. If a required field is missing, ask the user
for it instead of guessing.

### 1. Bolt torque (`action: "bolt_torque"`)
Use for "what torque for a 1/2 inch grade 8 bolt", "torque spec M12 10.9", clamp load questions.
- `size`: String, required. Inch as `"1/2"` or `"1/2-13"`; metric as `"M10"` or `"M10x1.25"`.
- `grade`: String. SAE `"2"`, `"5"`, `"8"` or ISO `"8.8"`, `"10.9"`, `"12.9"`. Default 5 (inch) or 8.8 (metric).
- `finish`: String. `"dry"`, `"zinc"`, `"lubricated"` or `"anti-seize"`. Default `"dry"`.
- `preload_pct`: Number. Target preload as % of proof load. Default 75.
- `k`: Number. Optional custom nut factor; overrides `finish`.

### 2. Belt drive (`action: "belt_drive"`)
Use for pulley/sheave speed, speed ratio, belt speed, belt length, or "what pulley size do I need for X rpm".
- `driver_rpm`: Number, required. Motor/driver speed.
- `driver_dia`: Number, required. Driver sheave pitch diameter.
- `driven_dia`: Number. Driven sheave pitch diameter.
- `target_rpm`: Number. Desired driven speed. Give this instead of `driven_dia` to size the sheave.
- `center_distance`: Number. Optional; adds belt length and wrap angle.
- `units`: `"in"` or `"mm"`. Default `"in"`.

### 3. Bearing life (`action: "bearing_life"`)
Use for "how long will this bearing last", L10 life.
- `dynamic_rating`: Number, required. Basic dynamic load rating C from the bearing catalog.
- `load`: Number, required. Equivalent dynamic load P, same units as C.
- `rpm`: Number, required.
- `type`: `"ball"` or `"roller"`. Default `"ball"`.

### 4. Bearing defect frequencies (`action: "bearing_faults"`)
Use for vibration analysis: BPFO, BPFI, BSF, FTF, "what frequency is an outer race fault".
- `rpm`: Number, required. Shaft speed.
- `balls`: Number, required. Number of rolling elements.
- `ball_dia`: Number, required. Rolling element diameter.
- `pitch_dia`: Number, required. Pitch diameter, same units as `ball_dia`.
- `contact_angle`: Number. Degrees. Default 0.

### Sample Commands
- "What torque for a 1/2-13 grade 5 bolt, oiled?"
- "Torque spec for M16 10.9 with anti-seize."
- "Motor is 1750 rpm with a 4 inch sheave, driven is 8 inch, 20 inch centers. Driven speed and belt length?"
- "What size pulley do I need to get 1200 rpm from a 1750 rpm motor with a 5 inch pulley?"
- "6205 bearing, C is 14,000 N, load 1,400 N at 1000 rpm. How many hours?"
- "Bearing fault frequencies at 1800 rpm: 9 balls, 7.94 mm ball, 39.04 mm pitch diameter."

### Rules
- All values are engineering estimates. If the user has an OEM torque spec or procedure, that wins. Say so when torque is asked for safety-critical joints.
- Do not change units the tool returned unless the user asks.
