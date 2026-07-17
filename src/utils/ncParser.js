// ncParser.js
// Pure utility functions for estimating job duration and tool usage from NC (G-code)
// program files. No React / component state in here on purpose — keep this file
// independently testable and reusable outside the scheduler if needed.

// Assumed rapid traverse rate (mm/min) used when simulating G0 moves and no faster/slower
// value is known for the target machine. Tune per-shop if your rapids are notably different.
export const NC_DEFAULT_RAPID_MM_MIN = 10000;

// Floor for feed rate to avoid divide-by-near-zero blowing up the time estimate on
// malformed or missing F words.
export const NC_MIN_FEED_MM_MIN = 1;

// Matches post-processor comments that label an operation with its tool, e.g.:
//   (B0001 , TOOL : FLAT_D8)
//   (SPOT_DRIL , TOOL : CENTERDRILL)
const TOOL_COMMENT_RE = /\(([^,()]+)\s*,\s*TOOL\s*:\s*([^)]+)\)/i;

// Matches an actual tool-change block, e.g. "N12 T01 M6" / "T1 M06"
const TOOL_CHANGE_RE = /\bT0*(\d+)\b/i;

/**
 * Look for a machining-time comment left behind by the post-processor, e.g.:
 *   (TOTAL TIME: 12.4 MIN)
 *   (CYCLE TIME 00:12:24)
 *   (ESTIMATED TIME: 1.2 HR)
 * Returns minutes as a number, or null if nothing matched.
 */
export function extractCommentTime(text) {
    const hms = text.match(/(?:TOTAL|CYCLE|MACHINING|EST(?:IMATED)?)\s*TIME[^0-9]{0,10}(\d{1,2}):(\d{2}):(\d{2})/i);
    if (hms) {
        const [, h, m, s] = hms;
        return parseInt(h) * 60 + parseInt(m) + parseInt(s) / 60;
    }
    const unit = text.match(/(?:TOTAL|CYCLE|MACHINING|EST(?:IMATED)?)\s*TIME[^0-9]{0,10}([\d.]+)\s*(HR|HOUR|MIN)/i);
    if (unit) {
        const value = parseFloat(unit[1]);
        return unit[2].toUpperCase().startsWith("H") ? value * 60 : value;
    }
    return null;
}

/**
 * Turn "BR-1042_OP1.nc" into "BR-1042_OP1" for use as a job name.
 */
export function jobNameFromFilename(filename) {
    return filename.replace(/\.[^/.]+$/, "").toUpperCase();
}

/**
 * Parse an NC program: estimate total machining time AND extract the list of tools
 * used, each with an estimated share of the total time.
 *
 * Time estimation strategy:
 *  1. If the post-processor already wrote a time comment, trust the TOTAL (most
 *     accurate) and use the simulated per-tool split just to divide that total
 *     proportionally across tools.
 *  2. Otherwise, walk the program line by line in a simple modal interpreter
 *     (G0/G1/G2/G3, F, G20/G21 units) and sum distance / feed-rate for every move.
 *     G2/G3 arcs are approximated as straight-line (chord) distance rather than true
 *     arc length — close enough for scheduling purposes, NOT a substitute for CAM
 *     verification.
 *
 * Tool extraction: looks for "(<op>, TOOL : <name>)" comments paired with the
 * following "T<n> M6" tool-change block. Some post-processors emit several
 * operation comments that reuse the currently-loaded tool without a new M6 — those
 * operations are still attributed to whichever tool is active at the time.
 *
 * @param {string} text - raw contents of the .nc/.tap/.ptp/.gcode file
 * @returns {{
 *   hours: number,
 *   source: "comment" | "simulated",
 *   tools: Array<{ number: string|null, name: string, opCount: number, hours: number }>
 * }}
 */
export function parseNCProgram(text) {
    const commentMin = extractCommentTime(text);

    let unitsScale = 1; // 1 = mm (G21), 25.4 = inch (G20) converted to mm
    let x = 0, y = 0, z = 0;
    let feed = 0;
    let motion = null;
    let seconds = 0;

    let pendingOp = null; // { label, name } seen in a TOOL comment, not yet confirmed by a T..M6 line
    let currentTool = null; // the toolMap entry currently active
    const toolMap = new Map(); // key -> { number, name, opLabels: Set, seconds, order }

    function ensureTool(number, name) {
        const key = (number || "?") + "::" + name;
        if (!toolMap.has(key)) {
            toolMap.set(key, { number: number || null, name, opLabels: new Set(), seconds: 0, order: toolMap.size });
        }
        return toolMap.get(key);
    }

    for (const raw of text.split(/\r?\n/)) {
        const toolComment = raw.match(TOOL_COMMENT_RE);
        if (toolComment) {
            pendingOp = { label: toolComment[1].trim(), name: toolComment[2].trim() };
            if (currentTool) currentTool.opLabels.add(pendingOp.label);
            continue; // comment-only line, no motion to parse
        }

        // strip any other parenthetical comments / ";" line comments before parsing words
        const line = raw.split("(")[0].replace(/;.*$/, "").trim();
        if (!line) continue;

        if (/M0?6\b/i.test(line)) {
            const toolNum = line.match(TOOL_CHANGE_RE);
            if (toolNum) {
                const number = toolNum[1];
                const name = pendingOp ? pendingOp.name : `T${number}`;
                currentTool = ensureTool(number, name);
                if (pendingOp) currentTool.opLabels.add(pendingOp.label);
                pendingOp = null;
                continue;
            }
        }

        if (/\bG20\b/i.test(line)) unitsScale = 25.4;
        if (/\bG21\b/i.test(line)) unitsScale = 1;

        const g = line.match(/G0?([0123])(?!\d)/i);
        if (g) motion = "G" + g[1];

        const f = line.match(/F([\d.]+)/i);
        if (f) feed = parseFloat(f[1]) * unitsScale;

        // dwell: G4 P<ms> or G4 X<sec>
        if (/\bG4\b/i.test(line)) {
            const p = line.match(/P([\d.]+)/i);
            const xs = line.match(/X([\d.]+)/i);
            const dwellSec = xs ? parseFloat(xs[1]) : p ? parseFloat(p[1]) / 1000 : 0;
            seconds += dwellSec;
            if (currentTool) currentTool.seconds += dwellSec;
            continue;
        }

        const xm = line.match(/X(-?[\d.]+)/i);
        const ym = line.match(/Y(-?[\d.]+)/i);
        const zm = line.match(/Z(-?[\d.]+)/i);
        if (!xm && !ym && !zm) continue;

        const nx = xm ? parseFloat(xm[1]) * unitsScale : x;
        const ny = ym ? parseFloat(ym[1]) * unitsScale : y;
        const nz = zm ? parseFloat(zm[1]) * unitsScale : z;
        const dist = Math.sqrt((nx - x) ** 2 + (ny - y) ** 2 + (nz - z) ** 2);
        x = nx; y = ny; z = nz;

        if (dist > 0) {
            const rate = motion === "G0" ? NC_DEFAULT_RAPID_MM_MIN : Math.max(feed, NC_MIN_FEED_MM_MIN);
            const dt = (dist / rate) * 60;
            seconds += dt;
            if (currentTool) currentTool.seconds += dt;
        }
    }

    const simulatedHours = seconds / 3600;
    const totalHours = commentMin != null ? commentMin / 60 : simulatedHours;
    const scale = commentMin != null && simulatedHours > 0 ? totalHours / simulatedHours : 1;

    const tools = Array.from(toolMap.values())
        .sort((a, b) => a.order - b.order)
        .map((t) => ({
            number: t.number,
            name: t.name,
            opCount: t.opLabels.size,
            hours: t.seconds / 3600 * scale,
        }));

    return {
        hours: totalHours,
        source: commentMin != null ? "comment" : "simulated",
        tools,
    };
}