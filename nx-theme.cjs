/**
 * nx-theme.js — one-shot codemod: convert ProdSched palette to Siemens NX light theme
 *
 * Usage (from project root):
 *   node nx-theme.js src/ProductionScheduler.jsx src/ScanAction.jsx src/App.jsx
 *
 * - Makes a .bak backup of each file before writing
 * - Only touches colors, fonts, and border radii — no logic changes
 * - Safe to run once; running twice is a no-op (colors already mapped)
 */

const fs = require("fs");

// ===== teal palette -> Siemens NX light palette =====
// NX's actual chrome (title bar / OK button / selection) is a dark teal-blue,
// not a bright Fluent blue — matched from the NX dialog screenshot.
const COLOR_MAP = {
    // brand / accents
    "2F6E86": "1B6E8C", // teal primary        -> NX title-bar / OK-button teal-blue
    "234F60": "155A73", // teal dark           -> NX teal-blue, darker (hover)
    "1D3B49": "0F4557", // teal darker border  -> NX teal-blue, darkest (active/border)
    "3E96B8": "4FA8C9", // light blue          -> NX lighter teal-blue accent
    "17A2A0": "21A366", // teal-green accent   -> NX check green
    "0F6E56": "187A3E", // green-dark text     -> NX green dark

    // text
    "1B2226": "262626",
    "33424A": "404040",
    "5B6B72": "595959",
    "7C8A93": "6E6E6E",
    "9AA7AC": "8C8C8C",
    "B7C4C9": "ABABAB",

    // surfaces
    "F7F9FA": "F2F2F2", // app background
    "F4F7F8": "F5F5F5",
    "F2F6F7": "FFFFFF", // input / button wells -> white like NX ribbon controls
    "EEF2F3": "EDEDED", // sidebar / zebra
    "EEF3F4": "F5F5F5",
    "E9EFF1": "EDEDED",

    // borders / lines
    "E4EAEC": "D9D9D9",
    "DCE4E7": "C8C8C8",
    "E7EDEF": "E1E1E1",
    "E5EBED": "E5E5E5",
    "CFDBDF": "BFBFBF",
    "B9CBD1": "ABABAB",
    "B9C6CC": "B0B0B0",
    "C7D5DA": "C1C1C1",
    "D3E1E5": "BBD9F2",

    // teal-blue tints (selected rows, chips, "today" columns) — matches the
    // light selection-blue used on the "Main" tab in NX's Operation Navigator
    "E7EEF1": "D9EAF0",
    "EAF2F4": "D9EAF0",
    "DCE6E9": "CFE8F5",
    "E3ECEE": "E3F0F5",
    "DCEAEF": "D9EAF0",

    // green tints
    "E4F5EE": "E3F5E9",
    "B7E3D3": "A8DDBB",
};

// teal-based rgba() shadows/rings -> blue-based
const RGBA_MAP = [
    [/rgba\(47,\s*110,\s*134/g, "rgba(25,118,210"],
    [/rgba\(27,\s*110,\s*134/g, "rgba(25,118,210"], // typo variant in .ps-chip:hover
    [/rgba\(35,\s*79,\s*96/g, "rgba(21,101,192"],
    [/rgba\(27,\s*34,\s*38/g, "rgba(38,38,38"],
];

// NX is square-cornered: big radii -> 4, medium -> 3, small -> 2, tiny/circles untouched
function mapRadius(n) {
    n = Number(n);
    if (n <= 4) return n;
    if (n <= 7) return 2;
    if (n <= 13) return 3;
    return 4;
}

function transform(src) {
    let s = src;

    // 1) hex colors (also catches #RRGGBBAA forms like #2F6E8622)
    for (const [from, to] of Object.entries(COLOR_MAP)) {
        s = s.replace(new RegExp("#" + from, "gi"), "#" + to);
    }

    // 2) rgba shadows
    for (const [re, to] of RGBA_MAP) {
        s = s.replace(re, to);
    }

    // 3) fonts: drop Poppins, lead with Segoe UI (Windows/NX system font)
    s = s.replace(
        /family=Poppins:wght@600;700&family=Inter/g,
        "family=Inter"
    );
    s = s.replace(/'Poppins',\s*sans-serif/g, "'Segoe UI', sans-serif");
    // only prepend Segoe UI if it isn't already there (keeps re-runs idempotent)
    s = s.replace(/(?<!'Segoe UI',\s*)'Inter',\s*sans-serif/g, "'Segoe UI', 'Inter', sans-serif");

    // 4) border radii (inline style objects + the few string/CSS forms used)
    s = s.replace(/(borderRadius:\s*)(\d+)(?!\d|px|%)/g, (_, p, n) => p + mapRadius(n));
    s = s.replace(/(border(?:Top|Bottom)(?:Left|Right)Radius:\s*)(\d+)(?!\d)/g, (_, p, n) => p + mapRadius(n));
    s = s.replace(/borderRadius:\s*"6px 6px 0 0"/g, 'borderRadius: "2px 2px 0 0"');
    s = s.replace(/border-radius:\s*6px/g, "border-radius: 3px");

    // 5) active sidebar nav: dark pill -> NX selection teal-blue
    s = s.replace(
        /background: active \? "#262626" : "transparent"/g,
        'background: active ? "#1B6E8C" : "transparent"'
    );
    // already-converted files from a previous run of this script used the
    // brighter #1976D2 — nudge those to the corrected teal-blue too
    s = s.replace(/#1976D2/g, "#1B6E8C");
    s = s.replace(/#1565C0/g, "#155A73");
    s = s.replace(/#0F559E/g, "#0F4557");
    s = s.replace(/#3399FF/g, "#4FA8C9");
    s = s.replace(/rgba\(25,\s*118,\s*210/g, "rgba(27,110,140");
    s = s.replace(/rgba\(21,\s*101,\s*192/g, "rgba(21,90,115");

    return s;
}

const files = process.argv.slice(2);
if (files.length === 0) {
    console.log("Usage: node nx-theme.js <file1> [file2] ...");
    process.exit(1);
}

for (const f of files) {
    if (!fs.existsSync(f)) {
        console.log(`SKIP  ${f} (not found)`);
        continue;
    }
    const src = fs.readFileSync(f, "utf8");
    const out = transform(src);
    fs.writeFileSync(f + ".bak", src);
    fs.writeFileSync(f, out);
    const changed = src === out ? "no changes" : "converted";
    console.log(`OK    ${f} (${changed}, backup: ${f}.bak)`);
}
console.log("\nDone. Run `npm run dev` to preview. Restore with the .bak files if needed.");
