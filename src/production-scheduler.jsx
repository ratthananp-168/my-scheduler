import { useState, useRef, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";
import * as XLSX from "xlsx";
import { Cog, PauseCircle, AlertTriangle, CircleOff, CheckCircle2, Lock, X, ZoomIn, ZoomOut, RotateCcw, Trash2, CalendarDays, Boxes, BarChart3, TrendingUp, AlertOctagon, Gauge, Home as HomeIcon, ArrowRight, ListChecks, Search, Maximize2, Minimize2, ChevronLeft, ChevronRight, QrCode, Play, Square, Zap, Upload, Wrench, Clock, FileSpreadsheet, Printer, Volume2, VolumeX, Settings, Plus, Coffee, PieChart, Layers, Package, LogOut, History as HistoryIcon, Move, Link2, Cpu } from "lucide-react";
import { parseNCProgram, jobNameFromFilename } from "./utils/ncParser";

const NAV_ITEMS = [
    { id: "home", label: "Home", Icon: HomeIcon },
    { id: "schedule", label: "Schedule", Icon: CalendarDays },
    { id: "analytics", label: "Analytics", Icon: BarChart3 },
    { id: "tools", label: "Tools", Icon: Wrench },
    { id: "qrcodes", label: "QR Codes", Icon: QrCode },
    { id: "shifts", label: "Shifts", Icon: Settings },
    { id: "history", label: "History", Icon: HistoryIcon },
    { id: "settings", label: "Settings", Icon: Settings },
];

const DAY_ABBR_LOCALE = { weekday: "short" };

const ROW_HEIGHT = 80;
const HEADER_HEIGHT = 68;
const SHIFT_BAND_HEIGHT = 16;
const RESOURCE_COL_WIDTH = 168;
const VIEW_DAY_OPTIONS = [1, 7, 14, 30];
// default shift setup: name, start/end in decimal hours-of-day (0-24, end < start means it
// wraps past midnight), a background color, and optional breaks within the shift. Editable
// by the user on the Shifts settings page and persisted alongside jobs/resources.
const DEFAULT_SHIFTS = [
    { id: "shift-morning", name: "Morning", start: 6, end: 14, color: "#FFF3D6", breaks: [{ id: "brk-m1", label: "Lunch break", start: 10, end: 10.5 }] },
    { id: "shift-afternoon", name: "Afternoon", start: 14, end: 22, color: "#FFE3D3", breaks: [{ id: "brk-a1", label: "Evening break", start: 18, end: 18.5 }] },
    { id: "shift-night", name: "Night", start: 22, end: 6, color: "#DEE4F2", breaks: [{ id: "brk-n1", label: "Night break", start: 2, end: 2.5 }] },
];
function cloneShifts() {
    return DEFAULT_SHIFTS.map((s) => ({ ...s, breaks: s.breaks.map((b) => ({ ...b })) }));
}
function textColorForBg(hex) {
    const c = (hex || "#FFFFFF").replace("#", "");
    if (c.length !== 6) return "#404040";
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? "#404040" : "#FFFFFF";
}
function hourToTimeInput(h) {
    const hh = Math.floor(h) % 24;
    const mm = Math.round((h - Math.floor(h)) * 60);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
function timeInputToHour(v) {
    const [hh, mm] = String(v || "00:00").split(":").map(Number);
    return (hh || 0) + (mm || 0) / 60;
}
function newId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
// zoomed further in when fewer days are shown, so a single day can fill the screen clearly
function maxHourWidthForDays(days) {
    if (days <= 1) return 200;
    if (days <= 3) return 100;
    return 48;
}

function playAlarmTone(ctx, now) {
    [0, 0.45, 0.9, 1.35].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(880, now + offset);
        osc.frequency.setValueAtTime(660, now + offset + 0.22);
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.35, now + offset + 0.03);
        gain.gain.setValueAtTime(0.35, now + offset + 0.3);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.42);
    });
}
// smallest increment jobs can be dragged/resized to on the Gantt chart. Previously a fixed
// 15-minute grid; now 1 minute everywhere in the app (drag, resize, bulk shift, manual time
// entry, Excel import, tool-change duration growth) - fine enough to feel unrestricted for
// normal dragging, while keeping stored times as clean whole minutes instead of raw floats
// that could drift into ugly fractional-second values after repeated drags.
const SNAP_HOURS = 1 / 60;
function snapHours(hours) {
    return Math.round(hours / SNAP_HOURS) * SNAP_HOURS;
}
// how close a "to" job's start has to be to its linked "from" job's end+changeover to still
// count as adjacent - used both to prune stale links after a drag and, as a defense-in-depth
// safety net, to decide what's actually drawn as a connector at render time. Link positions are
// placed exactly (not grid-snapped), so this only needs to absorb floating-point rounding, not
// a real grid mismatch - but a normal drag on either job still snaps to SNAP_HOURS as usual,
// which is what correctly pushes it back out of tolerance and detaches the link.
const LINK_TOLERANCE_HOURS = 0.0005;

const RUNNING_GREEN = "#007A36";
const RUNNING_GREEN_DARK = "#003D1B";
const RUNNING_GREEN_LIGHT = "#00C853";

// vivid green used only for the "running" job block in the Gantt chart (kept bright on purpose)
const JOB_RUNNING_GREEN = "#00C853";

const ALARM_RED = "#FF2D20";
const ALARM_RED_DARK = "#D6180A";

const DONE_BLUE = "#1B6E8C";
const OVERDUE_AMBER = "#B45309";
const OVERDUE_AMBER_BORDER = "#E8A33D";
const OVERDUE_AMBER_BG = "#FDF3E4";

// order, color, and label for the job-status breakdown donut on the Analytics page
const JOB_STATUS_META = [
    { key: "running", label: "Running", color: JOB_RUNNING_GREEN },
    { key: "scheduled", label: "Scheduled", color: "#4FA8C9" },
    { key: "overdue", label: "Overdue", color: OVERDUE_AMBER },
    { key: "done", label: "Done", color: DONE_BLUE },
    { key: "unscheduled", label: "Unscheduled", color: "#ABABAB" },
];

// reference tool life used to gauge wear-out risk on the Tools page - every tool is
// assumed to be good for this many actual cutting hours before it should be replaced
const TOOL_LIFE_HOURS = 2;

// how many activity/audit entries to keep (oldest are dropped first)
const AUDIT_LOG_MAX = 200;

// icon + color per audit log action type, used on the History page
const ACTION_META = {
    job_created: { Icon: Plus, color: "#1B6E8C" },
    job_deleted: { Icon: Trash2, color: "#C4372E" },
    job_bulk_deleted: { Icon: Trash2, color: "#C4372E" },
    job_moved: { Icon: Move, color: "#4FA8C9" },
    job_resized: { Icon: Move, color: "#4FA8C9" },
    job_scheduled: { Icon: CalendarDays, color: "#4FA8C9" },
    job_unscheduled: { Icon: CalendarDays, color: "#6E6E6E" },
    job_bulk_moved: { Icon: Move, color: "#4FA8C9" },
    job_move_undone: { Icon: RotateCcw, color: "#6E6E6E" },
    job_started: { Icon: Play, color: RUNNING_GREEN },
    job_stopped: { Icon: Square, color: DONE_BLUE },
    alarm_raised: { Icon: AlertOctagon, color: ALARM_RED_DARK },
    alarm_cleared: { Icon: CheckCircle2, color: "#21A366" },
    resource_created: { Icon: Plus, color: "#1B6E8C" },
    resource_deleted: { Icon: Trash2, color: "#C4372E" },
    resource_status_changed: { Icon: Cog, color: OVERDUE_AMBER },
    shift_created: { Icon: Plus, color: "#1B6E8C" },
    shift_deleted: { Icon: Trash2, color: "#C4372E" },
    nc_created: { Icon: Upload, color: "#1B6E8C" },
    nc_updated: { Icon: Upload, color: OVERDUE_AMBER },
    job_linked: { Icon: Link2, color: "#1B6E8C" },
};
function actionMeta(action) {
    return ACTION_META[action] || { Icon: HistoryIcon, color: "#6E6E6E" };
}

// short "5m ago" / "2h ago" style relative time for the History page
function relativeTime(ts) {
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}

// full "Mon 21 Jul, 14:05" style timestamp for the History detail view
function fullTime(ts) {
    return new Date(ts).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// The app has one shared login (no real per-person accounts), so this reads whatever
// username was typed at sign-in. Requires Login.jsx to also store it - add this next to its
// existing `sessionStorage.setItem("ps-authed", "1")` line:
//   sessionStorage.setItem("ps-username", username);
// Falls back to the known shared username if that key isn't present yet.
function getOperatorName() {
    return sessionStorage.getItem("ps-username") || "ratthanan";
}

const ALARM_REASONS = [
    { id: "breakdown", label: "Machine breakdown" },
    { id: "material", label: "Material shortage" },
    { id: "quality", label: "Quality issue" },
    { id: "other", label: "Assistance needed" },
];

const INITIAL_RESOURCES = [
    { id: "r1", name: "CNC-01", type: "CNC mill", status: "running", alarmActive: false, alarmReason: null },
    { id: "r2", name: "CNC-02", type: "CNC mill", status: "idle", alarmActive: false, alarmReason: null },
    { id: "r3", name: "PRESS-A", type: "Stamping press", status: "running", alarmActive: false, alarmReason: null },
    { id: "r4", name: "PRESS-B", type: "Stamping press", status: "maintenance", alarmActive: false, alarmReason: null },
    { id: "r5", name: "ASSY-01", type: "Assembly line", status: "running", alarmActive: false, alarmReason: null },
    { id: "r6", name: "PAINT-01", type: "Paint booth", status: "down", alarmActive: false, alarmReason: null },
];

const PRODUCTS = {
    Bracket: "#1B6E8C",
    Housing: "#21A366",
    Panel: "#4FA8C9",
    Fixture: "#E0559B",
    Rework: "#F0625B",
};

const INITIAL_JOBS = [
    { id: "j1", name: "BR-1042", product: "Bracket", resourceId: "r1", startHour: 2, duration: 6, locked: false },
    { id: "j2", name: "BR-1043", product: "Bracket", resourceId: "r1", startHour: 10, duration: 4, locked: false },
    { id: "j3", name: "HS-2210", product: "Housing", resourceId: "r2", startHour: 4, duration: 8, locked: true },
    { id: "j4", name: "PN-3305", product: "Panel", resourceId: "r3", startHour: 0, duration: 5, locked: false },
    { id: "j5", name: "PN-3306", product: "Panel", resourceId: "r3", startHour: 26, duration: 6, locked: false },
    { id: "j6", name: "FX-4401", product: "Fixture", resourceId: "r5", startHour: 8, duration: 10, locked: false },
    { id: "j7", name: "HS-2211", product: "Housing", resourceId: "r2", startHour: 30, duration: 7, locked: false },
    { id: "j8", name: "RW-9001", product: "Rework", resourceId: "r1", startHour: 50, duration: 3, locked: true },
    { id: "j9", name: "BR-1044", product: "Bracket", resourceId: "r5", startHour: 48, duration: 5, locked: false },
    { id: "j10", name: "PN-3307", product: "Panel", resourceId: "r3", startHour: 52, duration: 4, locked: false },
    { id: "j11", name: "HS-2212", product: "Housing", resourceId: "r1", startHour: 4, duration: 5, locked: false },
    { id: "p1", name: "BR-1045", product: "Bracket", resourceId: null, startHour: 0, duration: 6, locked: false },
    { id: "p2", name: "FX-4402", product: "Fixture", resourceId: null, startHour: 0, duration: 8, locked: false },
    { id: "p3", name: "PN-3308", product: "Panel", resourceId: null, startHour: 0, duration: 4, locked: false },
    { id: "p4", name: "HS-2213", product: "Housing", resourceId: null, startHour: 0, duration: 5, locked: false },
];

const STATUS_META = {
    running: { label: "Running", color: "#21A366", Icon: CheckCircle2 },
    idle: { label: "Idle", color: "#6E6E6E", Icon: PauseCircle },
    maintenance: { label: "Maintenance", color: "#E8A33D", Icon: Cog },
    down: { label: "Down", color: "#F0625B", Icon: CircleOff },
};

function cloneJobs() {
    return INITIAL_JOBS.map((j) => ({ ...j }));
}

function cloneResources() {
    return INITIAL_RESOURCES.map((r) => ({ ...r }));
}

// intensity: 0 (light load) -> 1 (heavy load). Interpolates green -> yellow -> red.
function heatColor(intensity) {
    const t = Math.max(0, Math.min(1, intensity));
    const hue = 130 - t * 130; // 130 = green, 0 = red
    const sat = 70;
    const light = 46 - t * 6;
    return `hsl(${hue.toFixed(0)}, ${sat}%, ${light}%)`;
}

function toDateInputValue(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}


// ── Override PIN Settings component ──────────────────────────────────────────
function OverridePinSettings({ currentPin, onSave }) {
    const [mode,      setMode]      = useState("view"); // "view" | "edit" | "saving" | "saved"
    const [newPin,    setNewPin]    = useState("");
    const [confirmPn, setConfirmPn] = useState("");
    const [error,     setError]     = useState("");

    function handleSave() {
        if (newPin.length > 0 && (newPin.length < 4 || newPin.length > 8)) {
            setError("PIN must be 4–8 digits"); return;
        }
        if (!/^\d*$/.test(newPin)) {
            setError("PIN must contain digits only"); return;
        }
        if (newPin !== confirmPn) {
            setError("PINs do not match"); return;
        }
        setMode("saving");
        onSave(newPin);
        setTimeout(() => { setMode("saved"); setTimeout(() => setMode("view"), 1500); }, 300);
    }

    if (mode === "view" || mode === "saved") return (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, background: "#F5F5F5", border: "1px solid #E8E8E8", borderRadius: 4, padding: "10px 14px", fontSize: 13.5, color: currentPin ? "#262626" : "#ADADAD", fontFamily: currentPin ? "'IBM Plex Mono',monospace" : "inherit" }}>
                {currentPin ? "●".repeat(currentPin.length) : "No PIN set (no protection)"}
            </div>
            {mode === "saved"
                ? <div style={{ fontSize: 12.5, color: "#21A366", fontWeight: 600 }}>✓ Saved</div>
                : <button style={{ background: "#1B6E8C", color: "#fff", border: "none", borderRadius: 4, padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={() => { setNewPin(""); setConfirmPn(""); setError(""); setMode("edit"); }}>
                    {currentPin ? "Change PIN" : "Set PIN"}
                </button>
            }
            {currentPin && mode !== "saved" && (
                <button style={{ background: "#FDECEB", color: "#C4372E", border: "1px solid #F7CFCB", borderRadius: 4, padding: "9px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                    onClick={() => { onSave(""); setMode("saved"); setTimeout(() => setMode("view"), 1500); }}>
                    Remove PIN
                </button>
            )}
        </div>
    );

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11.5, color: "#6E6E6E", marginBottom: 4 }}>New PIN (4–8 digits)</div>
                    <input
                        type="password" inputMode="numeric" maxLength={8}
                        value={newPin} onChange={(e) => { setNewPin(e.target.value.replace(/\D/g, "")); setError(""); }}
                        style={{ width: "100%", boxSizing: "border-box", border: "1px solid #C8C8C8", borderRadius: 4, padding: "9px 12px", fontSize: 18, letterSpacing: 6, fontFamily: "'IBM Plex Mono',monospace" }}
                        placeholder="••••"
                        autoComplete="new-password"
                    />
                </div>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11.5, color: "#6E6E6E", marginBottom: 4 }}>Confirm PIN</div>
                    <input
                        type="password" inputMode="numeric" maxLength={8}
                        value={confirmPn} onChange={(e) => { setConfirmPn(e.target.value.replace(/\D/g, "")); setError(""); }}
                        style={{ width: "100%", boxSizing: "border-box", border: "1px solid #C8C8C8", borderRadius: 4, padding: "9px 12px", fontSize: 18, letterSpacing: 6, fontFamily: "'IBM Plex Mono',monospace" }}
                        placeholder="••••"
                        autoComplete="new-password"
                    />
                </div>
            </div>
            {error && <div style={{ fontSize: 12, color: "#C4372E", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 4, padding: "6px 10px" }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button style={{ flex: 1, background: "#FFFFFF", border: "1px solid #C8C8C8", color: "#595959", borderRadius: 4, padding: "9px 0", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                    onClick={() => setMode("view")}>Cancel</button>
                <button style={{ flex: 1.5, background: "#1B6E8C", color: "#fff", border: "none", borderRadius: 4, padding: "9px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: mode === "saving" ? 0.6 : 1 }}
                    onClick={handleSave} disabled={mode === "saving"}>
                    {mode === "saving" ? "Saving..." : "Save PIN"}
                </button>
            </div>
        </div>
    );
}

export default function ProductionScheduler() {
   const [jobs, setJobs] = useState(cloneJobs);
const [resources, setResources] = useState(cloneResources);
// persistent, append-only ledger of actual tool usage hours, keyed by tool identity.
// Unlike job.tools[].actualHours (which lives on the job and disappears if the job is
// deleted), this survives job deletion so the Tools page keeps an accurate lifetime total.
// Written to by ScanAction.jsx on every STOP scan.
const [toolHistory, setToolHistory] = useState([]);
// lightweight activity/audit trail - who/what/when for deletions, drags, alarms, scans,
// resource edits, and NC imports. Capped to the most recent AUDIT_LOG_MAX entries so the
// JSON blob doesn't grow unbounded. Shared the same way toolHistory is: embedded in the
// schedule_state row, so (like toolHistory) concurrent writes from two tabs within the same
// ~800ms debounce window can in rare cases drop one tab's entry - acceptable for an activity
// feed, unlike toolHistory's authoritative hour totals.
const [auditLog, setAuditLog] = useState([]);
const [shiftConfig, setShiftConfig] = useState(cloneShifts);
const [appConfig, setAppConfig] = useState({ overridePin: "" });
// sequential links between two jobs on the same resource, created when a dragged job is
// dropped on top of another (a collision) and the person enters a changeover time instead of
// leaving them stuck overlapping. { id, fromJobId, toJobId, changeoverMin }. Rendered as a
// connecting line on the Gantt chart between the two job blocks.
const [jobLinks, setJobLinks] = useState([]);
const [loaded, setLoaded] = useState(false);
const skipNextRealtimeRef = useRef(false);
// true when jobs/resources were just set FROM Supabase (initial load or a realtime event from
// another tab/device), as opposed to a genuine local edit (drag, add job, raise alarm, etc).
// Without this, applying a realtime update triggers the auto-save effect below, which writes
// the same data straight back to Supabase - and if two tabs are open, each tab's "harmless" echo
// triggers the other tab's echo in turn, forever, every ~1-2s. That loop can silently overwrite
// a just-scanned change with a stale snapshot before you ever see it.
const remoteUpdateRef = useRef(false);
// mirrors of latest jobs/resources + which job/resource is currently open in the edit panel.
// Used so an incoming realtime update never clobbers the row you're actively typing into
// (previously: typing a name while a realtime event landed reset the field almost instantly).
const jobsRef = useRef(jobs);
const editingJobIdRef = useRef(null);
const editingResourceIdRef = useRef(null);

useEffect(() => {
    supabase
        .from("schedule_state")
        .select("data")
        .eq("id", 1)
        .single()
        .then(({ data, error }) => {
            remoteUpdateRef.current = true;
            if (!error && data?.data && Object.keys(data.data).length > 0) {
                setJobs(data.data.jobs || cloneJobs());
                setResources(data.data.resources || cloneResources());
                setToolHistory(data.data.toolHistory || []);
                setAuditLog(data.data.auditLog || []);
                setShiftConfig(data.data.shiftConfig || cloneShifts());
                setJobLinks(data.data.jobLinks || []);
                if (data.data.appConfig) setAppConfig(data.data.appConfig);
            }
            setLoaded(true);
        });
}, []);

// listen for changes made by other people/tabs and apply them live
useEffect(() => {
    const channel = supabase
        .channel("schedule_state_changes")
        .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "schedule_state", filter: "id=eq.1" },
            (payload) => {
                // ignore the echo of our own save
                if (skipNextRealtimeRef.current) {
                    skipNextRealtimeRef.current = false;
                    return;
                }
                const incoming = payload.new?.data;
                if (!incoming) return;

                const editingJobId = editingJobIdRef.current;
                const editingResourceId = editingResourceIdRef.current;
                let keptLocalEdit = false;

                if (incoming.jobs) {
                    const localEditingJob = editingJobId ? jobsRef.current.find((j) => j.id === editingJobId) : null;
                    if (localEditingJob) {
                        // keep whatever is currently in the name/duration/etc fields for the job
                        // being edited, but still accept the fresh data for every other job
                        keptLocalEdit = true;
                        setJobs(incoming.jobs.map((j) => (j.id === editingJobId ? localEditingJob : j)));
                    } else {
                        setJobs(incoming.jobs);
                    }
                }
                if (incoming.resources) {
                    const localEditingResource = editingResourceId ? resourcesRef.current.find((r) => r.id === editingResourceId) : null;
                    if (localEditingResource) {
                        keptLocalEdit = true;
                        setResources(incoming.resources.map((r) => (r.id === editingResourceId ? localEditingResource : r)));
                    } else {
                        setResources(incoming.resources);
                    }
                }
                if (incoming.toolHistory) {
                    setToolHistory(incoming.toolHistory);
                }
                if (incoming.auditLog) {
                    setAuditLog(incoming.auditLog);
                }
                if (incoming.shiftConfig) {
                    setShiftConfig(incoming.shiftConfig);
                }
                if (incoming.jobLinks) {
                    setJobLinks(incoming.jobLinks);
                }

                // if we kept an in-progress edit, this update is NOT a pure remote sync -
                // let the autosave effect below run normally so the edit still gets saved
                if (!keptLocalEdit) {
                    remoteUpdateRef.current = true;
                }
            }
        )
        .subscribe();

    return () => {
        supabase.removeChannel(channel);
    };
}, []);

useEffect(() => {
    if (!loaded) return;
    // this change came from Supabase itself (initial load or another tab's realtime event) -
    // it already matches the database, so writing it back would just feed the echo loop
    if (remoteUpdateRef.current) {
        remoteUpdateRef.current = false;
        return;
    }
    const timer = setTimeout(() => {
        skipNextRealtimeRef.current = true;
        supabase
            .from("schedule_state")
            .update({ data: { jobs, resources, toolHistory, auditLog, shiftConfig, jobLinks, appConfig }, updated_at: new Date().toISOString() })
            .eq("id", 1)
            .then();
    }, 800);
    return () => clearTimeout(timer);
}, [jobs, resources, toolHistory, auditLog, shiftConfig, jobLinks, loaded]);

// belt-and-suspenders consistency pass: re-validate every job link any time `jobs` changes,
// no matter *why* it changed - a plain drag, a resize, a bulk shift, a manual edit in the side
// panel, dropping a job back onto the grid from the unscheduled pool, deleting a job/resource,
// an NC re-import, or even an incoming realtime update from someone else's tab. Threading a
// manual pruneStaleLinks() call into every individual place that can move a job kept missing
// edge cases (pool drops, cross-tab updates, etc.), so this effect is the actual guarantee:
// a link can never survive more than one render past the moment its two jobs stop being
// exactly back-to-back, regardless of which code path caused that.
useEffect(() => {
    setJobLinks((links) => {
        const pruned = pruneStaleLinks(jobs, links);
        // skip the update (and the save/broadcast it would trigger) when nothing changed
        if (pruned.length === links.length && pruned.every((l, i) => l === links[i])) return links;
        return pruned;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [jobs]);

    const [hourWidth, setHourWidth] = useState(22);
    const [selectedJobId, setSelectedJobId] = useState(null);
    const [selectedResourceId, setSelectedResourceId] = useState(null);
    const [ghost, setGhost] = useState(null);
    // single-slot undo for the most recent job drag (move/resize/schedule/unschedule) - not a
    // full undo stack, just "undo the last thing I dragged", auto-dismissed after a few seconds
    const [lastMoveUndo, setLastMoveUndo] = useState(null);
    // generic confirmation modal for destructive actions (delete job/resource/shift/bulk-delete).
    // null when hidden; otherwise { title, message, confirmLabel, danger, onConfirm }
    const [confirmDialog, setConfirmDialog] = useState(null);
    function requestConfirm(opts) {
        setConfirmDialog(opts);
    }
    // popup shown when a dragged job is dropped on top of another job on the same resource -
    // lets the person enter a changeover time between the two instead of leaving them stuck
    // overlapping. null when hidden; otherwise { fromJobId, fromJobName, toJobId, toJobName,
    // resourceId, changeoverMin, revert: { jobId, startHour, duration, resourceId } }
    const [linkPrompt, setLinkPrompt] = useState(null);
    // which History entry's inline detail is expanded (null = none)
    const [selectedHistoryEntryId, setSelectedHistoryEntryId] = useState(null);
    const [activeNav, setActiveNav] = useState("home");
    const [loadView, setLoadView] = useState("week");
    const [searchQuery, setSearchQuery] = useState("");
    const [searchFocused, setSearchFocused] = useState(false);
    const [filterProduct, setFilterProduct] = useState("all");
    const [filterResourceType, setFilterResourceType] = useState("all");
    const [viewDays, setViewDays] = useState(7);
    const [filterFromDate, setFilterFromDate] = useState("");
    const [filterToDate, setFilterToDate] = useState("");
    const [focusMode, setFocusMode] = useState(false);
    const [pendingAlarmReason, setPendingAlarmReason] = useState(ALARM_REASONS[0].id);
    const [bulkSelectedIds, setBulkSelectedIds] = useState(() => new Set());
    const [importError, setImportError] = useState("");
    const excelFileInputRef = useRef(null);
    const [alarmSoundEnabled, setAlarmSoundEnabled] = useState(true);
    const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
    const audioCtxRef = useRef(null);
    const prevAlarmIdsRef = useRef(new Set());
    // mirrors alarmSoundEnabled so playAlarmBeep always reads the CURRENT mute state even when
    // called from a setInterval closure created on an earlier render (the bug that made mute
    // stop working once the repeat timer had already started)
    const alarmSoundEnabledRef = useRef(true);
    useEffect(() => {
        alarmSoundEnabledRef.current = alarmSoundEnabled;
    }, [alarmSoundEnabled]);
    const [selectedToolKey, setSelectedToolKey] = useState(null);
    const [toolsJobFilter, setToolsJobFilter] = useState("all");
    // index of the tool-change row currently being drag-and-drop reordered in the job panel
    const [draggedToolChangeIdx, setDraggedToolChangeIdx] = useState(null);
    const [nowTick, setNowTick] = useState(Date.now());
    useEffect(() => {
        const t = setInterval(() => setNowTick(Date.now()), 30000);
        return () => clearInterval(t);
    }, []);
    const [isDraggingNC, setIsDraggingNC] = useState(false);
    // stacked notices for the current import batch: { id, type: "created"|"updated"|"unchanged"|"error", text }
    const [ncImportNotices, setNcImportNotices] = useState([]);
    const ncFileInputRef = useRef(null);

    // rough signature of an NC job's substance (duration + tool list), used to tell a genuine
    // revision (re-imported file whose content actually changed) apart from a no-op re-import
    function ncContentSignature(duration, tools) {
        const toolsSig = (tools || [])
            .map((t) => `${t.number || ""}:${t.name}:${(t.hours || 0).toFixed(2)}`)
            .sort()
            .join("|");
        return `${duration.toFixed(2)}::${toolsSig}`;
    }

    // NC file import (browser drag-drop / file picker) - the only import path now that the
    // local sync script has been retired. ncFilePath is the dedup key: browsers don't reliably
    // expose a real folder path for dropped/picked files, so we use the filename itself as a
    // stable identity. Re-importing a file with the same name updates the existing job (fresh
    // duration/tools/source) instead of creating a duplicate, but leaves the job's scheduling
    // (resourceId/startHour/locked) and any custom name untouched. Every import shows a notice
    // so it's never a silent no-op: new job created, existing job refreshed (with what changed),
    // or existing job re-imported with no actual content change.
    function importNCFiles(fileList) {
        const files = Array.from(fileList || []);
        if (files.length === 0) return;
        setNcImportNotices([]);

        // A synchronously-maintained snapshot of jobs for this whole import batch. FileReader
        // callbacks fire asynchronously, but JS itself is single-threaded, so only one onload
        // below ever runs at a time - each file's onload reads and updates this same array in
        // turn, so a second file always sees the first file's result even if their reads
        // finish close together. setJobs is then called with a *plain array* (not a function),
        // so there's no dependency on exactly when/how many times React internally invokes a
        // functional updater - the outcome for the notice/log is computed and used immediately,
        // in the same synchronous block, every time.
        let workingJobs = jobsRef.current;

        files.forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const { hours, source, tools } = parseNCProgram(String(reader.result || ""));
                    const duration = Math.max(SNAP_HOURS, snapHours(hours)); // round to nearest minute
                    const ncFilePath = file.name;
                    const newSig = ncContentSignature(duration, tools);
                    const noticeId = "ncnotice-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);

                    const existingIdx = workingJobs.findIndex((j) => j.ncFilePath === ncFilePath);
                    let nextWorkingJobs;
                    let outcome;

                    if (existingIdx !== -1) {
                        const existing = workingJobs[existingIdx];
                        const oldSig = ncContentSignature(existing.duration, existing.tools);
                        const changed = oldSig !== newSig;
                        const refreshedToolChanges = toolChangesFromParsedTools(tools);
                        const updatedJob = {
                            ...existing,
                            duration,
                            ncSource: source,
                            ncFileName: file.name,
                            ncFilePath,
                            toolChanges: refreshedToolChanges,
                            tools: recomputeAggregatedTools(refreshedToolChanges),
                        };
                        nextWorkingJobs = workingJobs.slice();
                        nextWorkingJobs[existingIdx] = updatedJob;
                        outcome = { kind: "existing", changed, jobId: existing.id, jobName: existing.name, fromDuration: existing.duration, toDuration: duration };
                    } else {
                        const id = "nc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
                        const initialToolChanges = toolChangesFromParsedTools(tools);
                        const newJob = {
                            id,
                            name: jobNameFromFilename(file.name),
                            product: Object.keys(PRODUCTS)[0],
                            resourceId: null,
                            startHour: 0,
                            duration,
                            locked: false,
                            ncSource: source,
                            ncFileName: file.name,
                            ncFilePath,
                            toolChanges: initialToolChanges,
                            tools: recomputeAggregatedTools(initialToolChanges),
                        };
                        nextWorkingJobs = [...workingJobs, newJob];
                        outcome = { kind: "created", jobId: id, jobName: newJob.name };
                    }

                    workingJobs = nextWorkingJobs;
                    setJobs(nextWorkingJobs);

                    setSelectedJobId(outcome.jobId);
                    setSelectedResourceId(null);
                    if (outcome.kind === "created") {
                        setNcImportNotices((ns) => [...ns, { id: noticeId, type: "created", text: `"${file.name}" imported as new job "${outcome.jobName}"` }]);
                        logActivity("nc_created", `${outcome.jobName} created from ${file.name}`, { jobId: outcome.jobId });
                    } else if (outcome.changed) {
                        setNcImportNotices((ns) => [...ns, { id: noticeId, type: "updated", text: `"${file.name}" updated existing job "${outcome.jobName}" — est. time ${outcome.fromDuration.toFixed(2)}h → ${outcome.toDuration.toFixed(2)}h (revision detected)` }]);
                        logActivity("nc_updated", `${outcome.jobName} refreshed from ${file.name} (content changed)`, { jobId: outcome.jobId, fileName: file.name, fromDuration: outcome.fromDuration, toDuration: outcome.toDuration });
                    } else {
                        setNcImportNotices((ns) => [...ns, { id: noticeId, type: "unchanged", text: `"${file.name}" already imported as "${outcome.jobName}" — no changes, nothing new added` }]);
                        logActivity("nc_updated", `${outcome.jobName} re-imported from ${file.name} (no change)`, { jobId: outcome.jobId, fileName: file.name, fromDuration: outcome.fromDuration, toDuration: outcome.toDuration });
                    }
                } catch {
                    setNcImportNotices((ns) => [...ns, { id: "ncnotice-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7), type: "error", text: `Couldn't read "${file.name}"` }]);
                }
            };
            reader.onerror = () => setNcImportNotices((ns) => [...ns, { id: "ncnotice-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7), type: "error", text: `Couldn't read "${file.name}"` }]);
            reader.readAsText(file);
        });
    }

    function handleNCBrowseChange(e) {
        importNCFiles(e.target.files);
        e.target.value = "";
    }

    function handleNCDrop(e) {
        e.preventDefault();
        setIsDraggingNC(false);
        importNCFiles(e.dataTransfer.files);
    }

    const DAYS = viewDays;
    const TOTAL_HOURS = DAYS * 24;

    const gridScrollRef = useRef(null);
    const poolRef = useRef(null);
    const dragRef = useRef(null);
    const hourWidthRef = useRef(hourWidth);
    const resourcesRef = useRef(resources);
    const [isFitted, setIsFitted] = useState(false);
    const [prevHourWidth, setPrevHourWidth] = useState(22);
    useEffect(() => {
        hourWidthRef.current = hourWidth;
    }, [hourWidth]);
    useEffect(() => {
        resourcesRef.current = resources;
    }, [resources]);
    useEffect(() => {
        jobsRef.current = jobs;
    }, [jobs]);
    useEffect(() => {
        editingJobIdRef.current = selectedJobId;
    }, [selectedJobId]);
    useEffect(() => {
        editingResourceIdRef.current = selectedResourceId;
    }, [selectedResourceId]);

    function computeFitHourWidth() {
        if (!gridScrollRef.current) return null;
        const availableWidth = gridScrollRef.current.clientWidth - RESOURCE_COL_WIDTH;
        const fitted = Math.floor(availableWidth / TOTAL_HOURS);
        return Math.max(4, Math.min(maxHourWidthForDays(DAYS), fitted));
    }

    function fitWeekToView() {
        if (!gridScrollRef.current) return;
        if (isFitted) {
            setHourWidth(prevHourWidth);
            setIsFitted(false);
            return;
        }
        const fitted = computeFitHourWidth();
        if (fitted == null) return;
        setPrevHourWidth(hourWidth);
        setHourWidth(fitted);
        setIsFitted(true);
    }

    function adjustZoom(delta) {
        setIsFitted(false);
        setHourWidth((w) => Math.max(10, Math.min(maxHourWidthForDays(DAYS), w + delta)));
    }

    useEffect(() => {
        // fit the full window into view on first load instead of defaulting to a width that requires scrolling
        const id = requestAnimationFrame(() => fitWeekToView());
        return () => cancelAnimationFrame(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // re-fit whenever the visible day range changes, so the timeline always fills the viewport
    useEffect(() => {
        const id = requestAnimationFrame(() => {
            const fitted = computeFitHourWidth();
            if (fitted != null) {
                setHourWidth(fitted);
                setIsFitted(true);
            }
        });
        return () => cancelAnimationFrame(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewDays]);

    const baseDate = useMemo(() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    }, []);

    const nowHour = useMemo(() => (Date.now() - baseDate.getTime()) / 3600000, [baseDate]);

    const timelineWidth = TOTAL_HOURS * hourWidth;

    const scheduledJobs = jobs.filter((j) => j.resourceId);
    const poolJobs = jobs.filter((j) => !j.resourceId);

    const resourceTypes = useMemo(() => {
        return Array.from(new Set(resources.map((r) => r.type))).sort();
    }, [resources]);

    // expand each shift's start/end into one or two same-day [start,end] segments (a shift
    // that wraps past midnight, e.g. 22-06, becomes two segments: 22-24 and 0-6)
    const shiftDaySegments = useMemo(() => {
        return shiftConfig.map((shift) => {
            const segments =
                shift.end > shift.start
                    ? [{ start: shift.start, end: shift.end }]
                    : [
                          ...(shift.end > 0 ? [{ start: 0, end: shift.end }] : []),
                          ...(shift.start < 24 ? [{ start: shift.start, end: 24 }] : []),
                      ];
            return { ...shift, segments };
        });
    }, [shiftConfig]);

    // hour-of-day boundaries (0 < h < 24) where a shift starts or ends, used to draw the thin
    // guide lines that run down through every resource row
    const shiftBoundaryHours = useMemo(() => {
        const set = new Set();
        shiftConfig.forEach((s) => {
            if (s.start > 0 && s.start < 24) set.add(s.start);
            if (s.end > 0 && s.end < 24) set.add(s.end);
        });
        return Array.from(set).sort((a, b) => a - b);
    }, [shiftConfig]);

    // duration of a shift in hours, handling the case where it wraps past midnight
    function shiftDurationHours(shift) {
        return shift.end > shift.start ? shift.end - shift.start : 24 - shift.start + shift.end;
    }

    // minute-by-minute coverage count across the 24h day (used by the Shifts settings page to
    // show total covered/gap time and to detect overlapping shifts at a glance)
    const shiftCoverage = useMemo(() => {
        const minutes = new Array(1440).fill(0);
        shiftDaySegments.forEach((shift) => {
            shift.segments.forEach((seg) => {
                const startMin = Math.max(0, Math.round(seg.start * 60));
                const endMin = Math.min(1440, Math.round(seg.end * 60));
                for (let m = startMin; m < endMin; m++) minutes[m]++;
            });
        });
        const coveredMinutes = minutes.reduce((s, c) => s + (c > 0 ? 1 : 0), 0);
        const overlapMinutes = minutes.reduce((s, c) => s + (c > 1 ? 1 : 0), 0);
        return { coveredHours: coveredMinutes / 60, overlapHours: overlapMinutes / 60, gapHours: (1440 - coveredMinutes) / 60 };
    }, [shiftDaySegments]);

    // ids of shifts whose time range overlaps with at least one other shift, so each shift
    // card can flag itself instead of the user having to spot it manually
    const shiftOverlapIds = useMemo(() => {
        const overlapping = new Set();
        for (let i = 0; i < shiftDaySegments.length; i++) {
            for (let j = i + 1; j < shiftDaySegments.length; j++) {
                const a = shiftDaySegments[i];
                const b = shiftDaySegments[j];
                const intersects = a.segments.some((sa) => b.segments.some((sb) => sa.start < sb.end && sb.start < sa.end));
                if (intersects) {
                    overlapping.add(a.id);
                    overlapping.add(b.id);
                }
            }
        }
        return overlapping;
    }, [shiftDaySegments]);

    const jobDate = (job) => new Date(baseDate.getTime() + job.startHour * 3600000);
    // renders a startHour (hours since baseDate/midnight today) as a readable date+time, for
    // the History detail modal's "from/to" schedule display
    function formatScheduleTime(startHour) {
        if (startHour === null || startHour === undefined) return null;
        return new Date(baseDate.getTime() + startHour * 3600000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    }

    // inline expandable detail for a History row: from/to card for move-type events
    // (schedule/move/resize/unschedule/undo), or a plain key/value list otherwise
    function renderHistoryDetail(entry) {
        const m = entry.meta || {};
        const isMoveType = m.toResourceName !== undefined || m.fromResourceName !== undefined;
        const metaEntries = Object.entries(m).filter(([k, v]) => v !== null && v !== undefined && v !== "" && !/Id$/.test(k));
        return (
            <div style={styles.historyDetailInline}>
                <div style={styles.historyDetailMeta}>{entry.actor} · {fullTime(entry.at)}</div>
                {isMoveType ? (
                    <div style={styles.historyFromToRow}>
                        <div style={styles.historyFromToCol}>
                            <span style={styles.historyFromToLabel}>From</span>
                            <span style={styles.historyFromToValue}>{m.fromResourceName || "—"}</span>
                            {formatScheduleTime(m.fromStartHour) && <span style={styles.historyFromToSub}>{formatScheduleTime(m.fromStartHour)}</span>}
                            {m.fromDuration != null && <span style={styles.historyFromToSub}>{m.fromDuration}h</span>}
                        </div>
                        <ArrowRight size={16} color="#ABABAB" style={{ flexShrink: 0 }} />
                        <div style={styles.historyFromToCol}>
                            <span style={styles.historyFromToLabel}>To</span>
                            <span style={styles.historyFromToValue}>{m.toResourceName || "—"}</span>
                            {formatScheduleTime(m.toStartHour) && <span style={styles.historyFromToSub}>{formatScheduleTime(m.toStartHour)}</span>}
                            {m.toDuration != null && <span style={styles.historyFromToSub}>{m.toDuration}h</span>}
                        </div>
                    </div>
                ) : (
                    metaEntries.length > 0 && (
                        <div style={styles.historyMetaList}>
                            {metaEntries.map(([k, v]) => (
                                <div key={k} style={styles.historyMetaRow}>
                                    <span style={styles.historyMetaKey}>{k.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}</span>
                                    <span style={styles.historyMetaValue}>{typeof v === "number" ? (k.toLowerCase().includes("hour") || k.toLowerCase().includes("duration") ? `${v}h` : v) : String(v)}</span>
                                </div>
                            ))}
                        </div>
                    )
                )}
            </div>
        );
    }

    const rangeFromDate = filterFromDate ? new Date(filterFromDate + "T00:00:00") : null;
    const rangeToDate = filterToDate ? new Date(filterToDate + "T23:59:59") : null;

    const isFilterActive =
        searchQuery.trim() !== "" || filterProduct !== "all" || filterResourceType !== "all" || !!filterFromDate || !!filterToDate;

    const jobMatchesFilter = (job) => {
        if (searchQuery.trim() && !job.name.toLowerCase().includes(searchQuery.trim().toLowerCase())) return false;
        if (filterProduct !== "all" && job.product !== filterProduct) return false;
        if (filterResourceType !== "all") {
            const res = resources.find((r) => r.id === job.resourceId);
            if (!res || res.type !== filterResourceType) return false;
        }
        if (rangeFromDate || rangeToDate) {
            if (!job.resourceId) return false;
            const start = jobDate(job);
            const end = new Date(start.getTime() + job.duration * 3600000);
            if (rangeFromDate && end < rangeFromDate) return false;
            if (rangeToDate && start > rangeToDate) return false;
        }
        return true;
    };

    function jumpToDateRange() {
        if (!rangeFromDate || !gridScrollRef.current) return;
        const hoursFromBase = (rangeFromDate.getTime() - baseDate.getTime()) / 3600000;
        const targetLeft = Math.max(0, hoursFromBase * hourWidth - 20);
        gridScrollRef.current.scrollTo({ left: targetLeft, behavior: "smooth" });
    }

    const searchSuggestions = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return [];
        return jobs
            .filter((j) => j.name.toLowerCase().includes(q))
            .slice(0, 8)
            .map((j) => ({ job: j, resource: resources.find((r) => r.id === j.resourceId) || null }));
    }, [searchQuery, jobs, resources]);

    const conflictIds = useMemo(() => {
        const ids = new Set();
        resources.forEach((r) => {
            const rJobs = jobs
                .filter((j) => j.resourceId === r.id)
                .slice()
                .sort((a, b) => a.startHour - b.startHour);
            for (let i = 1; i < rJobs.length; i++) {
                if (rJobs[i].startHour < rJobs[i - 1].startHour + rJobs[i - 1].duration) {
                    ids.add(rJobs[i].id);
                    ids.add(rJobs[i - 1].id);
                }
            }
        });
        return ids;
    }, [jobs, resources]);

    const utilization = useMemo(() => {
        const map = {};
        resources.forEach((r) => {
            const total = jobs.filter((j) => j.resourceId === r.id).reduce((s, j) => s + j.duration, 0);
            map[r.id] = Math.min(100, Math.round((total / TOTAL_HOURS) * 100));
        });
        return map;
    }, [jobs, resources, TOTAL_HOURS]);

    const resourceConflictCounts = useMemo(() => {
        const map = {};
        resources.forEach((r) => {
            const rJobs = jobs
                .filter((j) => j.resourceId === r.id)
                .slice()
                .sort((a, b) => a.startHour - b.startHour);
            let count = 0;
            for (let i = 1; i < rJobs.length; i++) {
                if (rJobs[i].startHour < rJobs[i - 1].startHour + rJobs[i - 1].duration) count++;
            }
            map[r.id] = count;
        });
        return map;
    }, [jobs, resources]);

    const dailyLoad = useMemo(() => {
        const map = {};
        resources.forEach((r) => {
            map[r.id] = Array.from({ length: DAYS }, () => 0);
        });
        jobs.forEach((j) => {
            if (!j.resourceId || !map[j.resourceId]) return;
            const dayIndex = Math.floor(j.startHour / 24);
            if (dayIndex < 0 || dayIndex >= DAYS) return;
            map[j.resourceId][dayIndex] += j.duration;
        });
        return map;
    }, [jobs, resources, DAYS]);

    const analyticsSummary = useMemo(() => {
        const utilValues = resources.map((r) => utilization[r.id] || 0);
        const avgUtil = utilValues.length ? Math.round(utilValues.reduce((a, b) => a + b, 0) / utilValues.length) : 0;
        const busiest = resources.slice().sort((a, b) => (utilization[b.id] || 0) - (utilization[a.id] || 0))[0] || null;
        const totalConflictJobs = conflictIds.size;
        const bottlenecks = resources
            .map((r) => ({ resource: r, count: resourceConflictCounts[r.id] || 0 }))
            .filter((x) => x.count > 0)
            .sort((a, b) => b.count - a.count);
        return { avgUtil, busiest, totalConflictJobs, bottlenecks };
    }, [resources, utilization, resourceConflictCounts, conflictIds]);

    // Today's job summary: jobs whose planned window overlaps today
    const todaySummary = useMemo(() => {
        const todayStartH = Math.floor(nowHour / 24) * 24;
        const todayEndH = todayStartH + 24;
        const todayJobs = jobs.filter((j) => j.resourceId && j.startHour < todayEndH && j.startHour + j.duration > todayStartH);
        const total = todayJobs.length;
        const done = todayJobs.filter((j) => j.completed).length;
        const running = todayJobs.filter((j) => j.isRunning).length;
        const overdue = todayJobs.filter((j) => !j.isRunning && !j.completed && j.startHour + j.duration < nowHour).length;
        const scheduled = total - done - running - overdue;

        // For completed jobs: compare actual run hours vs planned duration
        const completedWithTiming = todayJobs
            .filter((j) => j.completed && j.runStartedAt && j.actualRunHours != null)
            .map((j) => {
                const actualH = j.actualRunHours;
                const plannedH = j.duration;
                const diffMin = Math.round((actualH - plannedH) * 60);
                return {
                    id: j.id, name: j.name, product: j.product,
                    resourceId: j.resourceId,
                    plannedH, actualH, diffMin,
                    status: diffMin > 0 ? "delayed" : diffMin < 0 ? "early" : "on-time",
                };
            });
        const delayedCount = completedWithTiming.filter((j) => j.status === "delayed").length;
        const earlyCount   = completedWithTiming.filter((j) => j.status === "early").length;
        const onTimeCount  = completedWithTiming.filter((j) => j.status === "on-time").length;
        const avgDelayMin  = completedWithTiming.filter((j) => j.status === "delayed").reduce((s, j) => s + j.diffMin, 0) / (delayedCount || 1);
        const avgEarlyMin  = Math.abs(completedWithTiming.filter((j) => j.status === "early").reduce((s, j) => s + j.diffMin, 0) / (earlyCount || 1));

        return { total, done, running, overdue, scheduled, completedWithTiming, delayedCount, earlyCount, onTimeCount, avgDelayMin, avgEarlyMin };
    }, [jobs, nowHour]);

    // how many jobs currently sit in each lifecycle state - powers the status breakdown
    // donut on the Analytics page. Mirrors the same running/done/overdue logic used to
    // color job blocks on the Gantt chart, just aggregated across all jobs.
    const jobStatusBreakdown = useMemo(() => {
        const counts = { running: 0, done: 0, overdue: 0, scheduled: 0, unscheduled: 0 };
        jobs.forEach((j) => {
            if (j.isRunning) counts.running++;
            else if (j.completed) counts.done++;
            else if (!j.resourceId) counts.unscheduled++;
            else if (j.startHour + j.duration < nowHour) counts.overdue++;
            else counts.scheduled++;
        });
        return counts;
    }, [jobs, nowHour]);

    // job count + scheduled hours per product family - powers the product mix donut
    const productMix = useMemo(() => {
        const map = {};
        jobs.forEach((j) => {
            if (!map[j.product]) map[j.product] = { count: 0, hours: 0 };
            map[j.product].count++;
            map[j.product].hours += j.duration;
        });
        return Object.entries(map)
            .map(([product, v]) => ({ product, ...v, color: PRODUCTS[product] || "#6E6E6E" }))
            .sort((a, b) => b.hours - a.hours);
    }, [jobs]);

    // average utilization grouped by resource type - lets you compare e.g. all CNC mills
    // vs all stamping presses at a glance instead of scanning every individual resource
    const resourceTypeUtil = useMemo(() => {
        const map = {};
        resources.forEach((r) => {
            if (!map[r.type]) map[r.type] = { total: 0, count: 0 };
            map[r.type].total += utilization[r.id] || 0;
            map[r.type].count++;
        });
        return Object.entries(map)
            .map(([type, v]) => ({ type, avg: Math.round(v.total / v.count), count: v.count }))
            .sort((a, b) => b.avg - a.avg);
    }, [resources, utilization]);

    // aggregate tool usage for the Tools summary page.
    // actualHours (the durable total) comes from toolHistory, which ScanAction.jsx updates
    // on every STOP scan and which is NOT tied to any single job - so it survives job
    // deletion. estHours/liveHours/job-list still come from whichever jobs currently exist.
    const toolSummary = useMemo(() => {
        const map = new Map();

        toolHistory.forEach((h) => {
            const key = (h.number || "?") + "::" + h.name;
            map.set(key, {
                number: h.number,
                name: h.name,
                estHours: 0,
                actualHours: h.actualHours || 0,
                liveHours: 0,
                opCount: 0,
                jobs: [],
                historicalJobNames: h.jobNames || [],
                maxLife: h.maxLife || null,
            });
        });

        jobs.forEach((job) => {
            const jobTools = job.tools || [];
            const estTotal = jobTools.reduce((s, t) => s + (t.hours || 0), 0);
            let liveElapsed = 0;
            if (job.isRunning && job.runStartedAt) {
                liveElapsed = Math.max(0, (nowTick - new Date(job.runStartedAt).getTime()) / 3600000);
            }
            jobTools.forEach((t) => {
                const key = (t.number || "?") + "::" + t.name;
                if (!map.has(key)) {
                    map.set(key, { number: t.number, name: t.name, estHours: 0, actualHours: 0, liveHours: 0, opCount: 0, jobs: [], historicalJobNames: [] });
                }
                const entry = map.get(key);
                const share = estTotal > 0 ? (t.hours || 0) / estTotal : jobTools.length ? 1 / jobTools.length : 0;
                const jobLiveHours = liveElapsed * share;
                entry.estHours += t.hours || 0;
                entry.liveHours += jobLiveHours;
                entry.opCount += t.opCount || 0;
                entry.jobs.push({ id: job.id, name: job.name, estHours: t.hours || 0, actualHours: t.actualHours || 0, liveHours: jobLiveHours, isRunning: job.isRunning });
            });
        });

        return Array.from(map.values()).sort((a, b) => (b.actualHours + b.liveHours) - (a.actualHours + a.liveHours));
    }, [jobs, toolHistory, nowTick]);

    // jobs worth offering in the Tools page "filter by job" dropdown - only ones that
    // actually carry a tool breakdown (i.e. were imported from an NC file)
    const toolsJobOptions = useMemo(() => {
        return jobs.filter((j) => j.tools && j.tools.length > 0).slice().sort((a, b) => a.name.localeCompare(b.name));
    }, [jobs]);

    // narrow the Tools page down to just the tools used by one job when a filter is picked -
    // otherwise every tool across every job piles up in one long list
    const visibleToolSummary = useMemo(() => {
        if (toolsJobFilter === "all") return toolSummary;
        return toolSummary.filter((t) => t.jobs.some((j) => j.id === toolsJobFilter));
    }, [toolSummary, toolsJobFilter]);

    // tools that are close to needing replacement (>=80% of reference life used), sorted
    // most-urgent first - surfaced at the top of the Tools page so nobody has to hunt for
    // them in the full list. Always computed off the full toolSummary (not the job-filtered
    // view) since a tool wearing out matters regardless of which job filter is active.
    const nearEndOfLifeTools = useMemo(() => {
        return toolSummary
            .map((t) => {
                const usedHours = t.actualHours + t.liveHours;
                const refLife = t.maxLife || TOOL_LIFE_HOURS;
                return { ...t, usedHours, lifePct: Math.min(100, (usedHours / refLife) * 100) };
            })
            .filter((t) => t.lifePct >= 80)
            .sort((a, b) => b.lifePct - a.lifePct);
    }, [toolSummary]);

    // top 10 tools by actual hours used (respects the job filter), for the bar chart
    const topToolsByUsage = useMemo(() => {
        return visibleToolSummary
            .map((t) => ({ ...t, usedHours: t.actualHours + t.liveHours }))
            .sort((a, b) => b.usedHours - a.usedHours)
            .slice(0, 10);
    }, [visibleToolSummary]);

    // jobs currently marked as running (from QR start/stop scans), paired with their resource.
    // NC-imported jobs often start out unscheduled (no resourceId) - they can still be
    // scanned start/stop from the QR Codes page, so don't require a resource to show here.
    const runningNow = useMemo(() => {
        return jobs
            .filter((j) => j.isRunning)
            .map((j) => {
                // actualResourceId set when operator overrode the planned machine at scan time
                const actualRes = j.actualResourceId ? resources.find((r) => r.id === j.actualResourceId) || null : null;
                const plannedRes = resources.find((r) => r.id === j.resourceId) || null;
                return { job: j, resource: actualRes || plannedRes, isOverride: !!actualRes, plannedResource: actualRes ? plannedRes : null };
            });
    }, [jobs, resources]);

    // resources with an active alarm (from QR alarm scans or manual trigger)
    const activeAlarms = useMemo(() => resources.filter((r) => r.alarmActive), [resources]);

    function playAlarmBeep() {
        // read from the ref (not the alarmSoundEnabled state directly) so this still respects
        // mute even when called from a setInterval closure created on an earlier render
        if (!alarmSoundEnabledRef.current) return;
        try {
            if (!audioCtxRef.current) {
                audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
            }
            const ctx = audioCtxRef.current;
            if (ctx.state === "suspended") ctx.resume().catch(() => {});
            playAlarmTone(ctx, ctx.currentTime);
            setNeedsAudioUnlock(false);
        } catch (err) {
            setNeedsAudioUnlock(true);
        }
    }

    // fire an immediate beep whenever a resource newly becomes alarmed (including alarms
    // that arrive via realtime from a QR scan on another device/tab)
    useEffect(() => {
        const currentIds = new Set(activeAlarms.map((r) => r.id));
        let hasNew = false;
        currentIds.forEach((id) => {
            if (!prevAlarmIdsRef.current.has(id)) hasNew = true;
        });
        prevAlarmIdsRef.current = currentIds;
        if (hasNew) playAlarmBeep();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeAlarms]);

    // keep repeating the beep periodically while at least one alarm is still active,
    // in case the first beep gets missed
    useEffect(() => {
        if (activeAlarms.length === 0) return;
        const id = setInterval(() => playAlarmBeep(), 20000);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeAlarms.length]);

    // appends one entry to the activity/audit trail, capped to AUDIT_LOG_MAX. Also de-dupes
    // against the immediately preceding entry when it's the same action+summary within 4s,
    // which covers this component's own effects re-firing (e.g. StrictMode double-invoke)
    // without adding real engineering to solve the harder cross-tab race (see auditLog comment).
    function logActivity(action, summary, meta, actorOverride) {
        setAuditLog((log) => {
            const last = log[log.length - 1];
            if (last && last.action === action && last.summary === summary && Date.now() - last.at < 4000) {
                return log;
            }
            const entry = { id: "log-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7), at: Date.now(), action, summary, actor: actorOverride || getOperatorName(), meta: meta || {} };
            const next = [...log, entry];
            return next.length > AUDIT_LOG_MAX ? next.slice(next.length - AUDIT_LOG_MAX) : next;
        });
    }

    // previous snapshots used only to detect job/resource *transitions* worth logging (started,
    // stopped, alarm raised/cleared) - this catches QR-scan-triggered changes from ScanAction.jsx
    // too, since those arrive here as ordinary state updates (local edit or realtime sync) just
    // like everything else. Structural changes (create/delete/drag/import) are logged directly
    // at their call sites instead, so each event type has exactly one place that logs it.
    const prevJobsForLogRef = useRef(null);
    const prevResourcesForLogRef = useRef(null);

    useEffect(() => {
        if (!loaded) return;
        const prev = prevJobsForLogRef.current;
        if (prev) {
            const prevMap = new Map(prev.map((j) => [j.id, j]));
            jobs.forEach((j) => {
                const p = prevMap.get(j.id);
                if (!p) return;
                if (!p.isRunning && j.isRunning) {
                    const res = resourcesRef.current.find((r) => r.id === j.resourceId);
                    logActivity("job_started", `${j.name} started`, { jobId: j.id, resourceId: j.resourceId, resourceName: res ? res.name : null }, "Floor (scan/QR)");
                } else if (p.isRunning && !j.isRunning && j.completed && !p.completed) {
                    const res = resourcesRef.current.find((r) => r.id === j.resourceId);
                    logActivity("job_stopped", `${j.name} stopped${j.actualRunHours ? ` · ${j.actualRunHours.toFixed(1)}h` : ""}`, { jobId: j.id, resourceId: j.resourceId, resourceName: res ? res.name : null, actualRunHours: j.actualRunHours || null }, "Floor (scan/QR)");
                }
            });
        }
        prevJobsForLogRef.current = jobs;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobs, loaded]);

    useEffect(() => {
        if (!loaded) return;
        const prev = prevResourcesForLogRef.current;
        if (prev) {
            const prevMap = new Map(prev.map((r) => [r.id, r]));
            resources.forEach((r) => {
                const p = prevMap.get(r.id);
                if (!p) return;
                if (!p.alarmActive && r.alarmActive) {
                    logActivity(
                        "alarm_raised",
                        `${r.name} alarm raised · ${ALARM_REASONS.find((a) => a.id === r.alarmReason)?.label || "unknown reason"}`,
                        { resourceId: r.id, resourceName: r.name, reason: ALARM_REASONS.find((a) => a.id === r.alarmReason)?.label || r.alarmReason },
                        "Floor (scan/QR)"
                    );
                } else if (p.alarmActive && !r.alarmActive) {
                    logActivity("alarm_cleared", `${r.name} alarm cleared`, { resourceId: r.id, resourceName: r.name }, "Floor (scan/QR)");
                }
                // status is a <select>, so it changes atomically on commit - safe to diff here.
                // name/type are free-text inputs that update per keystroke, so they're
                // intentionally NOT diffed (would spam one log entry per character typed).
                if (p.status !== r.status) {
                    logActivity("resource_status_changed", `${r.name} status: ${STATUS_META[p.status]?.label || p.status} → ${STATUS_META[r.status]?.label || r.status}`, {
                        resourceId: r.id,
                        resourceName: r.name,
                        fromStatus: STATUS_META[p.status]?.label || p.status,
                        toStatus: STATUS_META[r.status]?.label || r.status,
                    });
                }
            });
        }
        prevResourcesForLogRef.current = resources;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resources, loaded]);

    function raiseAlarm(resourceId, reasonId) {
        setResources((rs) => rs.map((r) => (r.id === resourceId ? { ...r, alarmActive: true, alarmReason: reasonId, alarmAt: Date.now() } : r)));
    }

    function clearAlarm(resourceId) {
        setResources((rs) => rs.map((r) => (r.id === resourceId ? { ...r, alarmActive: false, alarmReason: null, alarmAt: null } : r)));
    }

    // jobs on a resource that currently has an active alarm can't be dragged or started
    function isJobBlocked(job) {
        const res = resources.find((r) => r.id === job.resourceId);
        return !!res?.alarmActive;
    }

    // finds another job on the same resource whose time window overlaps the given one -
    // called right after a drag lands, to offer linking the two with a changeover time
    // instead of silently leaving them stuck overlapping
    function findOverlapOnResource(jobsList, resourceId, startHour, duration, excludeJobId) {
        return jobsList.find(
            (j) => j.resourceId === resourceId && j.id !== excludeJobId && startHour < j.startHour + j.duration && startHour + duration > j.startHour
        );
    }

    // drops any job link whose two jobs are no longer sitting exactly back-to-back (same
    // resource, "to" starting right after "from" plus its changeover). Called after anything
    // that can move/resize/unschedule a job, so dragging a linked job away automatically
    // detaches the link instead of leaving a stale connector pointing at an old position.
    // Dragging a *group* that includes both linked jobs together keeps them adjacent, so the
    // link naturally survives that case too - only jobs that actually moved apart get dropped.
    // true if the two jobs referenced by a link are still sitting exactly back-to-back (same
    // resource, "to" starting right at "from"'s end plus its stored changeover)
    function isLinkStillAdjacent(fromJ, toJ, link) {
        if (!fromJ || !toJ) return false;
        if (!fromJ.resourceId || !toJ.resourceId || fromJ.resourceId !== toJ.resourceId) return false;
        const expectedStart = fromJ.startHour + fromJ.duration + (Number(link.changeoverMin) || 0) / 60;
        return Math.abs(toJ.startHour - expectedStart) < LINK_TOLERANCE_HOURS;
    }

    function pruneStaleLinks(jobsList, links) {
        return links.filter((link) => {
            const fromJ = jobsList.find((j) => j.id === link.fromJobId);
            const toJ = jobsList.find((j) => j.id === link.toJobId);
            return isLinkStillAdjacent(fromJ, toJ, link);
        });
    }

    // opens the changeover popup for a just-dropped job that landed on top of `otherJob`.
    // Whichever of the two starts earlier is treated as "from" and the later one as "to" -
    // confirming keeps the earlier job in place and pushes the dragged job to sit right
    // after/before it, separated by the entered changeover time.
    function openChangeoverPrompt(draggedJobId, draggedJobName, draggedStart, draggedDuration, resourceId, otherJob, revert) {
        const draggedIsAfter = draggedStart >= otherJob.startHour;
        setLinkPrompt({
            reason: "collision",
            fromJobId: draggedIsAfter ? otherJob.id : draggedJobId,
            fromJobName: draggedIsAfter ? otherJob.name : draggedJobName,
            toJobId: draggedIsAfter ? draggedJobId : otherJob.id,
            toJobName: draggedIsAfter ? draggedJobName : otherJob.name,
            resourceId,
            draggedJobId,
            draggedIsAfter,
            draggedDuration,
            otherStart: otherJob.startHour,
            otherDuration: otherJob.duration,
            changeoverMin: 15,
            revert,
        });
    }

    // manual alternative to the drag-collision popup: pick exactly two jobs (ctrl/cmd+click)
    // and link them without needing to actually drag one on top of the other. The earlier
    // job stays put; the later one gets moved to start right after it once confirmed.
    function canManualLinkSelection() {
        if (bulkSelectedIds.size !== 2) return false;
        const [idA, idB] = Array.from(bulkSelectedIds);
        const a = jobs.find((j) => j.id === idA);
        const b = jobs.find((j) => j.id === idB);
        return !!(a && b && a.resourceId && b.resourceId && a.resourceId === b.resourceId);
    }

    function openManualLinkPrompt() {
        const [idA, idB] = Array.from(bulkSelectedIds);
        const a = jobs.find((j) => j.id === idA);
        const b = jobs.find((j) => j.id === idB);
        if (!a || !b || !a.resourceId || !b.resourceId || a.resourceId !== b.resourceId) return;
        const [earlier, later] = a.startHour <= b.startHour ? [a, b] : [b, a];
        setLinkPrompt({
            reason: "manual",
            fromJobId: earlier.id,
            fromJobName: earlier.name,
            toJobId: later.id,
            toJobName: later.name,
            resourceId: earlier.resourceId,
            draggedJobId: later.id,
            draggedIsAfter: true,
            draggedDuration: later.duration,
            otherStart: earlier.startHour,
            otherDuration: earlier.duration,
            changeoverMin: 15,
            revert: null,
        });
        setBulkSelectedIds(new Set());
    }

    function confirmLinkPrompt() {
        if (!linkPrompt) return;
        // the changeover time is honored exactly - the just-linked job is placed at the precise
        // computed offset, not snapped to the usual 15-minute grid, so the gap always matches
        // what was typed to the minute. (Every other job everywhere else in the app still snaps
        // normally when dragged/resized - this only applies to the position this link sets.)
        const changeoverMinEntered = Math.max(0, Number(linkPrompt.changeoverMin) || 0);
        const changeoverHours = changeoverMinEntered / 60;
        const rawStart = linkPrompt.draggedIsAfter
            ? linkPrompt.otherStart + linkPrompt.otherDuration + changeoverHours
            : linkPrompt.otherStart - changeoverHours - linkPrompt.draggedDuration;
        const newStart = Math.max(0, rawStart);
        setJobs((js) => js.map((j) => (j.id === linkPrompt.draggedJobId ? { ...j, startHour: newStart, resourceId: linkPrompt.resourceId } : j)));
        setJobLinks((links) => [
            ...links.filter((l) => !(l.fromJobId === linkPrompt.fromJobId && l.toJobId === linkPrompt.toJobId)),
            { id: newId("link"), fromJobId: linkPrompt.fromJobId, toJobId: linkPrompt.toJobId, changeoverMin: changeoverMinEntered },
        ]);
        logActivity("job_linked", `${linkPrompt.fromJobName} → ${linkPrompt.toJobName} linked (${changeoverMinEntered}m changeover)`, {
            fromJobId: linkPrompt.fromJobId,
            toJobId: linkPrompt.toJobId,
            changeoverMin: changeoverMinEntered,
        });
        setLinkPrompt(null);
    }

    function cancelLinkPrompt() {
        if (!linkPrompt) return;
        if (linkPrompt.revert) {
            const r = linkPrompt.revert;
            setJobs((js) => js.map((j) => (j.id === r.jobId ? { ...j, startHour: r.startHour, duration: r.duration, resourceId: r.resourceId } : j)));
        }
        setLinkPrompt(null);
    }

    function handlePointerMove(e) {
        const d = dragRef.current;
        if (!d) return;
        if (d.fromPool) {
            setGhost((g) => (g ? { ...g, x: e.clientX, y: e.clientY } : g));
            return;
        }
        const hw = hourWidthRef.current;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (d.mode === "group-move") {
            const deltaHours = snapHours(dx / hw);
            const deltaRows = Math.round(dy / ROW_HEIGHT);
            const resList = resourcesRef.current;
            setJobs((js) =>
                js.map((j) => {
                    const origin = d.origins[j.id];
                    if (!origin) return j;
                    const newRowIndex = Math.max(0, Math.min(resList.length - 1, origin.rowIndex + deltaRows));
                    const newStart = Math.max(0, Math.min(TOTAL_HOURS - j.duration, origin.startHour + deltaHours));
                    return { ...j, startHour: newStart, resourceId: resList[newRowIndex].id };
                })
            );
            return;
        }
        if (d.mode === "resize") {
            const deltaHours = snapHours(dx / hw);
            const newDuration = Math.max(SNAP_HOURS, Math.min(TOTAL_HOURS - d.origStart, d.origDuration + deltaHours));
            setJobs((js) => js.map((j) => (j.id === d.jobId ? { ...j, duration: newDuration } : j)));
        } else {
            const deltaHours = snapHours(dx / hw);
            const deltaRows = Math.round(dy / ROW_HEIGHT);
            const newStart = Math.max(0, Math.min(TOTAL_HOURS - d.origDuration, d.origStart + deltaHours));
            const newRowIndex = Math.max(0, Math.min(resourcesRef.current.length - 1, d.origRowIndex + deltaRows));
            const newResourceId = resourcesRef.current[newRowIndex].id;
            setJobs((js) => js.map((j) => (j.id === d.jobId ? { ...j, startHour: newStart, resourceId: newResourceId } : j)));
        }
    }

    function handlePointerUp(e) {
        const d = dragRef.current;
        if (d && d.fromPool) {
            const rect = gridScrollRef.current.getBoundingClientRect();
            const inGrid =
                e.clientX > rect.left + RESOURCE_COL_WIDTH &&
                e.clientX < rect.right &&
                e.clientY > rect.top + HEADER_HEIGHT &&
                e.clientY < rect.bottom;
            if (inGrid) {
                const scrollLeft = gridScrollRef.current.scrollLeft;
                const scrollTop = gridScrollRef.current.scrollTop;
                const localX = e.clientX - rect.left - RESOURCE_COL_WIDTH + scrollLeft;
                const localY = e.clientY - rect.top - HEADER_HEIGHT + scrollTop;
                const rowIndex = Math.max(0, Math.min(resourcesRef.current.length - 1, Math.floor(localY / ROW_HEIGHT)));
                const hw = hourWidthRef.current;
                const targetRes = resourcesRef.current[rowIndex];
                let appliedStartHour = null;
                let appliedDuration = d.origDuration;
                setJobs((js) => {
                    const job = js.find((j) => j.id === d.jobId);
                    if (!job) return js;
                    appliedDuration = job.duration;
                    appliedStartHour = Math.max(0, Math.min(TOTAL_HOURS - job.duration, snapHours(localX / hw)));
                    return js.map((j) => (j.id === d.jobId ? { ...j, resourceId: targetRes.id, startHour: appliedStartHour } : j));
                });
                if (appliedStartHour != null) {
                    const overlap = findOverlapOnResource(jobsRef.current, targetRes.id, appliedStartHour, appliedDuration, d.jobId);
                    if (overlap) {
                        openChangeoverPrompt(d.jobId, d.jobName, appliedStartHour, appliedDuration, targetRes.id, overlap, {
                            jobId: d.jobId,
                            startHour: d.origStart,
                            duration: d.origDuration,
                            resourceId: d.origResourceId,
                        });
                    } else {
                        logActivity("job_scheduled", `${d.jobName} scheduled to ${targetRes ? targetRes.name : "resource"}`, {
                            jobId: d.jobId,
                            fromResourceId: d.origResourceId,
                            fromResourceName: "unscheduled",
                            fromStartHour: d.origStart,
                            fromDuration: d.origDuration,
                            toResourceId: targetRes.id,
                            toResourceName: targetRes.name,
                            toStartHour: appliedStartHour,
                            toDuration: d.origDuration,
                        });
                        setLastMoveUndo({ jobId: d.jobId, jobName: d.jobName, prevStartHour: d.origStart, prevDuration: d.origDuration, prevResourceId: d.origResourceId });
                    }
                }
            }
            setGhost(null);
        } else if (d && d.mode !== "group-move") {
            const poolRect = poolRef.current?.getBoundingClientRect();
            if (poolRect && e.clientY >= poolRect.top) {
                let nextJobsSnapshot = null;
                setJobs((js) => {
                    const next = js.map((j) => (j.id === d.jobId ? { ...j, resourceId: null } : j));
                    nextJobsSnapshot = next;
                    return next;
                });
                // becoming unscheduled always breaks any link this job was part of
                if (nextJobsSnapshot) {
                    setJobLinks((links) => pruneStaleLinks(nextJobsSnapshot, links));
                }
                if (d.origResourceId) {
                    const fromRes = resourcesRef.current.find((r) => r.id === d.origResourceId);
                    logActivity("job_unscheduled", `${d.jobName} moved back to unscheduled`, {
                        jobId: d.jobId,
                        fromResourceId: d.origResourceId,
                        fromResourceName: fromRes ? fromRes.name : "resource",
                        fromStartHour: d.origStart,
                        fromDuration: d.origDuration,
                        toResourceId: null,
                        toResourceName: "unscheduled",
                        toStartHour: null,
                        toDuration: d.origDuration,
                    });
                    setLastMoveUndo({ jobId: d.jobId, jobName: d.jobName, prevStartHour: d.origStart, prevDuration: d.origDuration, prevResourceId: d.origResourceId });
                }
            } else {
                // ordinary grid move/resize ended - jobsRef is fresh here since it's kept in
                // sync with every setJobs call made during the preceding pointermove drags
                const finalJob = jobsRef.current.find((j) => j.id === d.jobId);
                if (finalJob && (finalJob.startHour !== d.origStart || finalJob.duration !== d.origDuration || finalJob.resourceId !== d.origResourceId)) {
                    const isResize = d.mode === "resize";
                    // moving or resizing this job may have pulled it away from a job it was
                    // linked to (or, for a resize, changed the gap) - re-validate all links
                    // against the fresh positions now that the drag has committed
                    setJobLinks((links) => pruneStaleLinks(jobsRef.current, links));
                    // collision handling (changeover popup) only applies to plain moves - a
                    // resize that now overlaps a neighbor still just shows as an ordinary
                    // conflict (red outline), since "grow into the next job" isn't a sequencing
                    // action the way dragging one job onto another is
                    if (!isResize) {
                        const overlap = findOverlapOnResource(jobsRef.current, finalJob.resourceId, finalJob.startHour, finalJob.duration, d.jobId);
                        if (overlap) {
                            openChangeoverPrompt(d.jobId, finalJob.name, finalJob.startHour, finalJob.duration, finalJob.resourceId, overlap, {
                                jobId: d.jobId,
                                startHour: d.origStart,
                                duration: d.origDuration,
                                resourceId: d.origResourceId,
                            });
                            dragRef.current = null;
                            window.removeEventListener("pointermove", handlePointerMove);
                            window.removeEventListener("pointerup", handlePointerUp);
                            return;
                        }
                    }
                    const fromRes = resourcesRef.current.find((r) => r.id === d.origResourceId);
                    const toRes = resourcesRef.current.find((r) => r.id === finalJob.resourceId);
                    logActivity(isResize ? "job_resized" : "job_moved", `${finalJob.name} ${isResize ? "resized" : "moved"}`, {
                        jobId: d.jobId,
                        fromResourceId: d.origResourceId,
                        fromResourceName: fromRes ? fromRes.name : "resource",
                        fromStartHour: d.origStart,
                        fromDuration: d.origDuration,
                        toResourceId: finalJob.resourceId,
                        toResourceName: toRes ? toRes.name : "resource",
                        toStartHour: finalJob.startHour,
                        toDuration: finalJob.duration,
                    });
                    setLastMoveUndo({ jobId: d.jobId, jobName: finalJob.name, prevStartHour: d.origStart, prevDuration: d.origDuration, prevResourceId: d.origResourceId });
                }
            }
        } else if (d && d.mode === "group-move") {
            // a bulk drag may have moved only one half of a linked pair (if the other job
            // wasn't part of the selection) - re-check every link against the fresh positions
            setJobLinks((links) => pruneStaleLinks(jobsRef.current, links));
        }
        dragRef.current = null;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
    }

    function onJobPointerDown(e, job, mode) {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) {
            setBulkSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(job.id)) next.delete(job.id);
                else next.add(job.id);
                return next;
            });
            setSelectedJobId(null);
            setSelectedResourceId(null);
            return;
        }
        // dragging (no ctrl) one of an existing multi-selection moves the whole group together
        if (mode === "move" && bulkSelectedIds.size > 1 && bulkSelectedIds.has(job.id)) {
            setSelectedJobId(null);
            setSelectedResourceId(null);
            const origins = {};
            bulkSelectedIds.forEach((id) => {
                const j = jobsRef.current.find((jj) => jj.id === id);
                if (!j || j.locked || isJobBlocked(j)) return;
                origins[id] = {
                    startHour: j.startHour,
                    rowIndex: resourcesRef.current.findIndex((r) => r.id === j.resourceId),
                };
            });
            dragRef.current = {
                mode: "group-move",
                fromPool: false,
                startX: e.clientX,
                startY: e.clientY,
                origins,
            };
            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", handlePointerUp);
            return;
        }

        if (bulkSelectedIds.size > 0) setBulkSelectedIds(new Set());
        setSelectedJobId(job.id);
        setSelectedResourceId(null);
        if (job.locked || isJobBlocked(job)) return;
        const rowIndex = resources.findIndex((r) => r.id === job.resourceId);
        dragRef.current = {
            jobId: job.id,
            jobName: job.name,
            mode,
            fromPool: false,
            startX: e.clientX,
            startY: e.clientY,
            origStart: job.startHour,
            origDuration: job.duration,
            origRowIndex: rowIndex,
            origResourceId: job.resourceId,
        };
        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
    }

    function onPoolPointerDown(e, job) {
        e.stopPropagation();
        dragRef.current = {
            jobId: job.id,
            jobName: job.name,
            mode: "move",
            fromPool: true,
            startX: e.clientX,
            startY: e.clientY,
            origStart: job.startHour,
            origDuration: job.duration,
            origResourceId: job.resourceId,
        };
        setGhost({ jobId: job.id, x: e.clientX, y: e.clientY, name: job.name, color: PRODUCTS[job.product] });
        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
    }

    function updateJob(id, patch) {
        let nextJobsSnapshot = null;
        setJobs((js) => {
            const next = js.map((j) => (j.id === id ? { ...j, ...patch } : j));
            nextJobsSnapshot = next;
            return next;
        });
        // manually retyping a job's start time, duration, or resource in the side panel can
        // just as easily pull it away from a linked partner as dragging it can
        if (nextJobsSnapshot && ("startHour" in patch || "duration" in patch || "resourceId" in patch)) {
            setJobLinks((links) => pruneStaleLinks(nextJobsSnapshot, links));
        }
    }

    // datetime-local input <-> startHour (hours since baseDate/midnight today) conversions
    function startHourToLocalInputValue(startHour) {
        const d = new Date(baseDate.getTime() + startHour * 3600000);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const h = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${y}-${m}-${day}T${h}:${min}`;
    }

    function handleStartTimeInputChange(job, value) {
        if (!value) return;
        const picked = new Date(value);
        if (Number.isNaN(picked.getTime())) return;
        const hoursFromBase = (picked.getTime() - baseDate.getTime()) / 3600000;
        const snapped = snapHours(hoursFromBase);
        const clamped = Math.max(0, Math.min(TOTAL_HOURS - job.duration, snapped));
        updateJob(job.id, { startHour: clamped });
    }

    function deleteJob(id) {
        const job = jobs.find((j) => j.id === id);
        setJobs((js) => js.filter((j) => j.id !== id));
        setJobLinks((links) => links.filter((l) => l.fromJobId !== id && l.toJobId !== id));
        setSelectedJobId(null);
        if (job) logActivity("job_deleted", `${job.name} deleted`, { jobId: id });
    }

    function resetDemo() {
        setJobs(cloneJobs());
        setResources(cloneResources());
        setJobLinks([]);
        setSelectedJobId(null);
        setSelectedResourceId(null);
    }

    function autoFixConflicts() {
        let nextJobsSnapshot = null;
        setJobs((js) => {
            const byResource = {};
            js.forEach((j) => {
                if (!j.resourceId) return;
                (byResource[j.resourceId] ||= []).push(j);
            });
            const updates = {};
            Object.values(byResource).forEach((resJobs) => {
                const sorted = resJobs.slice().sort((a, b) => a.startHour - b.startHour);
                let cursor = -Infinity;
                sorted.forEach((job) => {
                    if (job.locked) {
                        cursor = Math.max(cursor, job.startHour + job.duration);
                        return;
                    }
                    let newStart = job.startHour;
                    if (job.startHour < cursor) newStart = snapHours(cursor);
                    cursor = Math.max(cursor, newStart + job.duration);
                    if (newStart !== job.startHour) updates[job.id] = newStart;
                });
            });
            if (Object.keys(updates).length === 0) {
                nextJobsSnapshot = js;
                return js;
            }
            const next = js.map((j) => (updates[j.id] !== undefined ? { ...j, startHour: updates[j.id] } : j));
            nextJobsSnapshot = next;
            return next;
        });
        // the shifted positions don't respect any changeover gap, so re-validate links
        if (nextJobsSnapshot) setJobLinks((links) => pruneStaleLinks(nextJobsSnapshot, links));
    }

    function sanitizeFilename(name) {
        return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "export";
    }

    async function saveWorkbook(wb, defaultName) {
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: `${defaultName}.xlsx`,
                    types: [
                        {
                            description: "Excel Workbook",
                            accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] },
                        },
                    ],
                });
                const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
                const writable = await handle.createWritable();
                await writable.write(wbout);
                await writable.close();
                return;
            } catch (err) {
                if (err && err.name === "AbortError") return; // user cancelled the dialog
                // fall through to download fallback below on any other error
            }
        }
        const chosen = window.prompt("Enter filename (no .xlsx needed)", defaultName);
        if (chosen === null) return;
        XLSX.writeFile(wb, `${sanitizeFilename(chosen || defaultName)}.xlsx`);
    }

    function formatDateForExcel(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const h = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${y}-${m}-${day} ${h}:${min}`;
    }

    async function exportScheduleExcel() {
        const defaultName = `schedule_${toDateInputValue(baseDate)}`;
        const rows = jobs
            .slice()
            .sort((a, b) => {
                const ra = resources.find((r) => r.id === a.resourceId)?.name || "zzz-unscheduled";
                const rb = resources.find((r) => r.id === b.resourceId)?.name || "zzz-unscheduled";
                return ra.localeCompare(rb) || a.startHour - b.startHour;
            })
            .map((j) => {
                const res = resources.find((r) => r.id === j.resourceId);
                const start = j.resourceId ? new Date(baseDate.getTime() + j.startHour * 3600000) : null;
                const end = start ? new Date(start.getTime() + j.duration * 3600000) : null;
                const status = j.isRunning ? "Running" : j.completed ? "Done" : conflictIds.has(j.id) ? "Conflict" : !j.resourceId ? "Unscheduled" : "Scheduled";
                return {
                    Job: j.name,
                    Product: j.product,
                    Resource: res ? res.name : "unscheduled",
                    Start: start ? formatDateForExcel(start) : "",
                    End: end ? formatDateForExcel(end) : "",
                    "Duration (h)": j.duration,
                    Locked: j.locked ? "yes" : "no",
                    Status: status,
                };
            });
        const ws = XLSX.utils.json_to_sheet(rows);
        ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 12 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Schedule");
        await saveWorkbook(wb, defaultName);
    }

    async function exportToolsExcel() {
        const defaultName = `tool_usage_${toDateInputValue(baseDate)}`;
        const rows = toolSummary.map((t) => ({
            "Tool #": t.number || "",
            "Tool name": t.name,
            Jobs: t.jobs.length,
            "Estimated (h)": Number(t.estHours.toFixed(2)),
            "Actual (h)": Number((t.actualHours + t.liveHours).toFixed(2)),
            "Max life (h)": t.maxLife || TOOL_LIFE_HOURS,
            "Tool life used (%)": Number(Math.min(100, ((t.actualHours + t.liveHours) / (t.maxLife || TOOL_LIFE_HOURS)) * 100).toFixed(0)),
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        ws["!cols"] = [{ wch: 8 }, { wch: 22 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 13 }, { wch: 16 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Tool usage");
        await saveWorkbook(wb, defaultName);
    }

    async function exportTodaySummaryExcel() {
        const today = new Date(baseDate.getTime() + Math.floor(nowHour / 24) * 86400000);
        const dateStr = today.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
        const defaultName = `daily_summary_${toDateInputValue(today)}`;

        // Sheet 1: overview
        const overviewRows = [
            { Metric: "Date", Value: dateStr },
            { Metric: "Total jobs today", Value: todaySummary.total },
            { Metric: "Done", Value: todaySummary.done },
            { Metric: "Running", Value: todaySummary.running },
            { Metric: "Scheduled (not started)", Value: todaySummary.scheduled },
            { Metric: "Overdue", Value: todaySummary.overdue },
            { Metric: "Completed — delayed", Value: todaySummary.delayedCount },
            { Metric: "Completed — on time", Value: todaySummary.onTimeCount },
            { Metric: "Completed — early", Value: todaySummary.earlyCount },
            { Metric: "Avg delay (min)", Value: todaySummary.delayedCount > 0 ? Math.round(todaySummary.avgDelayMin) : "—" },
            { Metric: "Avg early (min)", Value: todaySummary.earlyCount > 0 ? Math.round(todaySummary.avgEarlyMin) : "—" },
        ];
        const ws1 = XLSX.utils.json_to_sheet(overviewRows);
        ws1["!cols"] = [{ wch: 30 }, { wch: 16 }];

        // Sheet 2: per-job timing
        const jobRows = todaySummary.completedWithTiming.map((j) => {
            const res = resources.find((r) => r.id === j.resourceId);
            return {
                "Job": j.name,
                "Product": j.product,
                "Resource": res ? res.name : "—",
                "Planned (h)": Number(j.plannedH.toFixed(2)),
                "Actual (h)": Number(j.actualH.toFixed(2)),
                "Diff (min)": j.diffMin,
                "Status": j.status === "delayed" ? "Delayed" : j.status === "early" ? "Early" : "On time",
            };
        });
        const ws2 = XLSX.utils.json_to_sheet(jobRows.length > 0 ? jobRows : [{ Note: "No completed jobs with timing data today" }]);
        ws2["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws1, "Overview");
        XLSX.utils.book_append_sheet(wb, ws2, "Job timing");
        await saveWorkbook(wb, defaultName);
    }

    function printSchedule() {
        window.print();
    }

    function handleImportExcelFile(e) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setImportError("");
        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const data = new Uint8Array(evt.target.result);
                const wb = XLSX.read(data, { type: "array" });
                const sheetName = wb.SheetNames[0];
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
                if (rows.length === 0) {
                    setImportError("No data found in file");
                    return;
                }
                let updated = 0;
                let created = 0;
                setJobs((js) => {
                    const next = js.slice();
                    const byName = new Map(next.map((j, i) => [j.name.trim().toLowerCase(), i]));
                    rows.forEach((row) => {
                        const name = String(row["Job"] || "").trim();
                        if (!name) return;
                        const productRaw = String(row["Product"] || "").trim();
                        const product = Object.keys(PRODUCTS).find((p) => p.toLowerCase() === productRaw.toLowerCase()) || Object.keys(PRODUCTS)[0];
                        const resourceName = String(row["Resource"] || "").trim();
                        const res = resources.find((r) => r.name.toLowerCase() === resourceName.toLowerCase());
                        const resourceId = res ? res.id : null;

                        let startHour = 0;
                        const startRaw = String(row["Start"] || "").trim();
                        if (resourceId && startRaw) {
                            const parsed = new Date(startRaw.replace(" ", "T"));
                            if (!Number.isNaN(parsed.getTime())) {
                                startHour = Math.max(0, snapHours((parsed.getTime() - baseDate.getTime()) / 3600000));
                            }
                        }
                        const durationRaw = Number(row["Duration (h)"]);
                        const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? snapHours(durationRaw) : 1;
                        const locked = String(row["Locked"] || "").trim().toLowerCase() === "yes";

                        const key = name.toLowerCase();
                        const existingIdx = byName.get(key);
                        if (existingIdx !== undefined) {
                            next[existingIdx] = { ...next[existingIdx], product, resourceId, startHour, duration, locked };
                            updated++;
                        } else {
                            const id = "imp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
                            next.push({ id, name, product, resourceId, startHour, duration, locked });
                            byName.set(key, next.length - 1);
                            created++;
                        }
                    });
                    return next;
                });
                setImportError(`Import successful — updated ${updated} job${updated !== 1 ? 's' : ''}, created ${created} new job${created !== 1 ? 's' : ''}`);
            } catch (err) {
                setImportError("Failed to read file — check that columns match the exported format (Job, Product, Resource, Start, Duration (h), Locked)");
            }
        };
        reader.onerror = () => setImportError("Failed to read file");
        reader.readAsArrayBuffer(file);
    }

    function bulkDeleteSelected() {
        const count = bulkSelectedIds.size;
        setJobs((js) => js.filter((j) => !bulkSelectedIds.has(j.id)));
        setJobLinks((links) => links.filter((l) => !bulkSelectedIds.has(l.fromJobId) && !bulkSelectedIds.has(l.toJobId)));
        setBulkSelectedIds(new Set());
        if (count > 0) logActivity("job_bulk_deleted", `${count} job${count !== 1 ? "s" : ""} deleted (bulk)`, { count });
    }

    function bulkMoveToResource(resourceId) {
        const count = bulkSelectedIds.size;
        const res = resources.find((r) => r.id === resourceId);
        let nextJobsSnapshot = null;
        setJobs((js) => {
            const next = js.map((j) => (bulkSelectedIds.has(j.id) && !j.locked ? { ...j, resourceId } : j));
            nextJobsSnapshot = next;
            return next;
        });
        if (nextJobsSnapshot) setJobLinks((links) => pruneStaleLinks(nextJobsSnapshot, links));
        if (count > 0) logActivity("job_bulk_moved", `${count} job${count !== 1 ? "s" : ""} moved to ${res ? res.name : "resource"} (bulk)`, { count, resourceId });
    }

    function bulkShiftHours(deltaHours) {
        const count = bulkSelectedIds.size;
        let nextJobsSnapshot = null;
        setJobs((js) => {
            const next = js.map((j) => {
                if (!bulkSelectedIds.has(j.id) || j.locked) return j;
                const newStart = Math.max(0, Math.min(TOTAL_HOURS - j.duration, snapHours(j.startHour + deltaHours)));
                return { ...j, startHour: newStart };
            });
            nextJobsSnapshot = next;
            return next;
        });
        // shifting only the selected jobs can pull one half of a linked pair away from the
        // other (if only one of the two was selected) - re-check links against fresh positions
        if (nextJobsSnapshot) setJobLinks((links) => pruneStaleLinks(nextJobsSnapshot, links));
        if (count > 0) logActivity("job_bulk_moved", `${count} job${count !== 1 ? "s" : ""} shifted by ${deltaHours > 0 ? "+" : ""}${deltaHours}h (bulk)`, { count, deltaHours });
    }

    function clearBulkSelection() {
        setBulkSelectedIds(new Set());
    }

    function undoLastMove() {
        if (!lastMoveUndo) return;
        const { jobId, prevStartHour, prevDuration, prevResourceId } = lastMoveUndo;
        const restoredRes = resources.find((r) => r.id === prevResourceId);
        setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, startHour: prevStartHour, duration: prevDuration, resourceId: prevResourceId } : j)));
        logActivity("job_move_undone", `${lastMoveUndo.jobName} move undone`, {
            jobId,
            toResourceId: prevResourceId,
            toResourceName: restoredRes ? restoredRes.name : "unscheduled",
            toStartHour: prevStartHour,
            toDuration: prevDuration,
        });
        setLastMoveUndo(null);
    }

    useEffect(() => {
        if (!lastMoveUndo) return;
        const t = setTimeout(() => setLastMoveUndo(null), 8000);
        return () => clearTimeout(t);
    }, [lastMoveUndo]);

    function jumpToJob(job) {
        setSearchQuery(job.name);
        setSearchFocused(false);
        setSelectedJobId(job.id);
        setSelectedResourceId(null);
        if (job.resourceId && gridScrollRef.current) {
            const rowIndex = resources.findIndex((r) => r.id === job.resourceId);
            if (rowIndex >= 0) {
                const targetLeft = Math.max(0, job.startHour * hourWidth - 120);
                const targetTop = Math.max(0, rowIndex * ROW_HEIGHT - 80);
                gridScrollRef.current.scrollTo({ left: targetLeft, top: targetTop, behavior: "smooth" });
            }
        }
    }

    function addJob() {
        const n = jobs.length + 1;
        const id = "new-" + Date.now();
        const newJob = { id, name: "JOB-" + n, product: Object.keys(PRODUCTS)[0], resourceId: null, startHour: 0, duration: 4, locked: false };
        setJobs((js) => [...js, newJob]);
        setSelectedJobId(id);
        setSelectedResourceId(null);
        logActivity("job_created", `${newJob.name} created`, { jobId: id });
    }

    function addResource() {
        const n = resources.length + 1;
        const id = "new-r-" + Date.now();
        const newResource = { id, name: "RES-" + n, type: "Machine", status: "idle", alarmActive: false, alarmReason: null };
        setResources((rs) => [...rs, newResource]);
        setSelectedResourceId(id);
        setSelectedJobId(null);
        logActivity("resource_created", `${newResource.name} created`, { resourceId: id });
    }

    function updateResource(id, patch) {
        setResources((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    }

    function deleteResource(id) {
        const res = resources.find((r) => r.id === id);
        setResources((rs) => rs.filter((r) => r.id !== id));
        let nextJobsSnapshot = null;
        setJobs((js) => {
            const next = js.map((j) => (j.resourceId === id ? { ...j, resourceId: null } : j));
            nextJobsSnapshot = next;
            return next;
        });
        if (nextJobsSnapshot) setJobLinks((links) => pruneStaleLinks(nextJobsSnapshot, links));
        setSelectedResourceId(null);
        if (res) logActivity("resource_deleted", `${res.name} deleted`, { resourceId: id });
    }

    function addShift() {
        setShiftConfig((sc) => [...sc, { id: newId("shift"), name: "New shift", start: 8, end: 16, color: "#E4EDEA", breaks: [] }]);
        logActivity("shift_created", "New shift added", {});
    }

    function updateShift(id, patch) {
        setShiftConfig((sc) => sc.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    }

    function deleteShift(id) {
        const shift = shiftConfig.find((s) => s.id === id);
        setShiftConfig((sc) => sc.filter((s) => s.id !== id));
        if (shift) logActivity("shift_deleted", `${shift.name} shift deleted`, { shiftId: id });
    }

    function addBreak(shiftId) {
        setShiftConfig((sc) =>
            sc.map((s) => (s.id === shiftId ? { ...s, breaks: [...s.breaks, { id: newId("brk"), label: "Break", start: s.start, end: Math.min(24, s.start + 0.5) }] } : s))
        );
    }

    function updateBreak(shiftId, breakId, patch) {
        setShiftConfig((sc) =>
            sc.map((s) => (s.id === shiftId ? { ...s, breaks: s.breaks.map((b) => (b.id === breakId ? { ...b, ...patch } : b)) } : s))
        );
    }

    function deleteBreak(shiftId, breakId) {
        setShiftConfig((sc) => sc.map((s) => (s.id === shiftId ? { ...s, breaks: s.breaks.filter((b) => b.id !== breakId) } : s)));
    }

    function resetShiftsToDefault() {
        setShiftConfig(cloneShifts());
    }

    // clears the "ps-authed" flag that Login.jsx sets and App.jsx checks on mount, then
    // reloads so App.jsx re-evaluates and shows the login screen again
    function handleLogout() {
        sessionStorage.removeItem("ps-authed");
        window.location.reload();
    }

    function clearAuditLog() {
        setAuditLog([]);
    }

    // ---------------------------------------------------------------------------------
    // Tool-change timeline helpers: a job now carries an ordered `toolChanges` list, each
    // entry describing "switch to tool X at minute N (relative to the job's own start),
    // for D minutes". job.tools (the aggregated summary the Tools/Analytics pages read)
    // is recomputed automatically from toolChanges any time it's edited, so no other page
    // needs to know about toolChanges at all - they keep reading job.tools like before.
    // ---------------------------------------------------------------------------------
    function recomputeAggregatedTools(toolChanges) {
        const map = new Map();
        (toolChanges || []).forEach((c) => {
            const key = (c.toolNumber || "?") + "::" + (c.toolName || "");
            if (!map.has(key)) {
                map.set(key, { number: c.toolNumber, name: c.toolName, hours: 0, opCount: 0 });
            }
            map.get(key).hours += (Number(c.durationMin) || 0) / 60;
        });
        return Array.from(map.values());
    }

    // furthest point (in hours) any tool-change segment reaches - used to make sure the job's
    // scheduled duration always covers the full tool-change timeline the user has entered
    function toolChangesSpanHours(toolChanges) {
        const maxEndMin = (toolChanges || []).reduce((max, c) => Math.max(max, (Number(c.startMin) || 0) + (Number(c.durationMin) || 0)), 0);
        return maxEndMin / 60;
    }

    // grows (never shrinks) a job's duration to fit its tool-change timeline, snapped to the
    // usual 15-minute grid - called any time a tool-change's start/length is edited
    function growDurationForToolChanges(job, toolChanges) {
        const spanHours = toolChangesSpanHours(toolChanges);
        if (spanHours <= job.duration) return job.duration;
        return Math.max(SNAP_HOURS, snapHours(spanHours));
    }

    // builds an initial tool-change list from an NC file's parsed tool list (number/name) so
    // the person doesn't have to retype which tools are used - only the timing (start/duration)
    // is left blank for them to fill in themselves, since the NC file's theoretical estimate
    // isn't reliable enough to assume as the real changeover timing.
    function toolChangesFromParsedTools(tools) {
        return (tools || []).map((t) => ({
            id: newId("tc"),
            toolNumber: t.number ? `T${t.number}` : "",
            toolName: t.name || "Tool",
            startMin: 0,
            durationMin: 0,
        }));
    }

    function addToolChange(jobId) {
        setJobs((js) => js.map((j) => {
            if (j.id !== jobId) return j;
            const changes = j.toolChanges || [];
            // continue from last segment end if available, otherwise start at minute 0
            const last = changes[changes.length - 1];
            const nextStart = last ? last.startMin + last.durationMin : 0;
            const newChange = { id: newId("tc"), toolNumber: "", toolName: "New tool", startMin: nextStart, durationMin: 15 };
            const nextChanges = [...changes, newChange];
            return { ...j, toolChanges: nextChanges, tools: recomputeAggregatedTools(nextChanges), duration: growDurationForToolChanges(j, nextChanges) };
        }));
    }

    function updateToolChange(jobId, changeId, patch) {
        setJobs((js) => js.map((j) => {
            if (j.id !== jobId) return j;
            const nextChanges = (j.toolChanges || []).map((c) => (c.id === changeId ? { ...c, ...patch } : c));
            return { ...j, toolChanges: nextChanges, tools: recomputeAggregatedTools(nextChanges), duration: growDurationForToolChanges(j, nextChanges) };
        }));
    }

    function removeToolChange(jobId, changeId) {
        setJobs((js) => js.map((j) => {
            if (j.id !== jobId) return j;
            const nextChanges = (j.toolChanges || []).filter((c) => c.id !== changeId);
            return { ...j, toolChanges: nextChanges, tools: recomputeAggregatedTools(nextChanges) };
        }));
    }

    // reorders the tool-change list (drag-and-drop) - times stay attached to each entry as-is,
    // only the display/aggregation order changes
    function reorderToolChanges(jobId, fromIdx, toIdx) {
        setJobs((js) => js.map((j) => {
            if (j.id !== jobId) return j;
            const changes = [...(j.toolChanges || [])];
            if (fromIdx < 0 || fromIdx >= changes.length || toIdx < 0 || toIdx >= changes.length) return j;
            const [moved] = changes.splice(fromIdx, 1);
            changes.splice(toIdx, 0, moved);
            return { ...j, toolChanges: changes, tools: recomputeAggregatedTools(changes) };
        }));
    }

    const selectedJob = jobs.find((j) => j.id === selectedJobId) || null;
    const selectedResource = resources.find((r) => r.id === selectedResourceId) || null;
    const toolKey = (t) => (t.number || "?") + "::" + t.name;

    function updateToolMaxLife(t, newMaxLife) {
        const key = (t.number || "?") + "::" + t.name;
        setToolHistory((prev) => {
            const existing = prev.find((h) => (h.number || "?") + "::" + h.name === key);
            if (existing) {
                return prev.map((h) =>
                    (h.number || "?") + "::" + h.name === key ? { ...h, maxLife: newMaxLife || null } : h
                );
            }
            return [...prev, { number: t.number, name: t.name, actualHours: 0, jobNames: [], maxLife: newMaxLife || null }];
        });
    }
    const selectedTool = (selectedToolKey ? visibleToolSummary.find((t) => toolKey(t) === selectedToolKey) : null) || visibleToolSummary[0] || null;
    const conflictCount = conflictIds.size;

    // time-of-day greeting shown on the Home page
    const homeGreeting = useMemo(() => {
        const h = new Date().getHours();
        if (h < 5) return "Working late";
        if (h < 12) return "Good morning";
        if (h < 17) return "Good afternoon";
        if (h < 21) return "Good evening";
        return "Working late";
    }, [nowTick]);

    // jobs starting within the next 4 hours that haven't started yet - a quick "what's next"
    // list for the Home page, separate from "unscheduled" (which has no time at all)
    const upcomingJobs = useMemo(() => {
        return jobs
            .filter((j) => j.resourceId && !j.isRunning && !j.completed && j.startHour > nowHour && j.startHour - nowHour <= 4)
            .sort((a, b) => a.startHour - b.startHour)
            .slice(0, 6)
            .map((j) => ({ job: j, resource: resources.find((r) => r.id === j.resourceId) || null }));
    }, [jobs, resources, nowHour]);

    return (
        <div style={styles.appShell}>
            <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .ps-scroll::-webkit-scrollbar { height: 10px; width: 10px; }
        .ps-scroll::-webkit-scrollbar-track { background: #EDEDED; }
        .ps-scroll::-webkit-scrollbar-thumb { background: #C1C1C1; border-radius: 3px; }
        .ps-scroll { scrollbar-width: thin; scrollbar-color: #C1C1C1 #EDEDED; }
        .ps-job:hover { filter: brightness(1.03); box-shadow: 0 4px 12px rgba(38,38,38,0.16) !important; }
        .ps-chip:hover { box-shadow: 0 4px 12px rgba(27,110,140,0.12); }
        .ps-chip:active { cursor: grabbing; }
        .ps-zoombtn:hover { background: #EDEDED; border-color: #ABABAB; }
        .ps-addbtn:hover { background: #155A73 !important; }
        .ps-select, .ps-input { background:#FFFFFF; border:1px solid #C8C8C8; color:#262626; border-radius:10px; padding:7px 9px; font-family:'Segoe UI', 'Inter', sans-serif; font-size:13px; width:100%; box-sizing:border-box; }
        .ps-select:focus, .ps-input:focus { outline:none; border-color:#1B6E8C; box-shadow:0 0 0 3px rgba(27,110,140,0.14); }
        .ps-navbtn { transition: background 0.15s, color 0.15s, transform 0.1s; }
        .ps-navbtn:hover { background: #D9D9D9 !important; }
        .ps-navbtn:active { transform: scale(0.98); }
        .ps-upgradebtn:hover { background: #D9D9D9 !important; }
        .ps-logoutbtn:hover { background: #FDECEB !important; color: #C4372E !important; }
        .ps-sidebar { transition: width 0.22s ease; overflow: hidden; width: 76px; }
        .ps-sidebar .ps-navlabel { opacity: 0; transition: opacity 0.12s ease; white-space: nowrap; }
        .ps-sidebar .ps-promo { opacity: 0; pointer-events: none; transition: opacity 0.12s ease; }
        .ps-sidebar:hover { width: 210px; box-shadow: 4px 0 16px rgba(0,0,0,0.12); }
        .ps-sidebar:hover .ps-navlabel { opacity: 1; }
        .ps-sidebar:hover .ps-promo { opacity: 1; pointer-events: auto; }
        .ps-searchitem:hover { background: #EDEDED !important; }
        .ps-tool-sidebar-item:hover { background: #FFFFFF !important; }
        @keyframes ps-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(0,200,83,0.55); } 50% { box-shadow: 0 0 0 5px rgba(0,200,83,0); } }
        .ps-running-dot { animation: ps-pulse 1.4s ease-in-out infinite; }
        @keyframes ps-job-glow { 0%, 100% { box-shadow: 0 0 0 2px rgba(0,200,83,0.55), 0 3px 12px rgba(0,200,83,0.35); } 50% { box-shadow: 0 0 0 6px rgba(0,200,83,0.16), 0 3px 12px rgba(0,200,83,0.35); } }
        .ps-job-running {
          background: linear-gradient(135deg, #00B84A 0%, #00D65E 55%, #00B84A 100%) !important;
          border: 2px solid #00913C !important;
          animation: ps-job-glow 1.7s ease-in-out infinite;
        }
        .ps-job-running::after {
          content: '';
          position: absolute;
          top: 0;
          left: -70%;
          width: 55%;
          height: 100%;
          background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.65) 50%, rgba(255,255,255,0) 100%);
          animation: ps-running-sweep 1.6s linear infinite;
          pointer-events: none;
        }
        @keyframes ps-running-sweep {
          0% { left: -70%; }
          100% { left: 130%; }
        }
        @keyframes ps-pulse-ring-green {
          0%   { box-shadow: 0 0 0 0 rgba(0,168,80,0.45); }
          70%  { box-shadow: 0 0 0 7px rgba(0,168,80,0); }
          100% { box-shadow: 0 0 0 0 rgba(0,168,80,0); }
        }
        .ps-statusbar-dot { animation: ps-pulse-ring-green 1.8s ease-out infinite; }
        .ps-statuschip:hover { box-shadow: 0 4px 12px rgba(0,40,15,0.28); transform: translateY(-1px); }
        @keyframes ps-pulse-ring-red {
          0%   { box-shadow: 0 0 0 0 rgba(224,54,40,0.45); }
          70%  { box-shadow: 0 0 0 7px rgba(224,54,40,0); }
          100% { box-shadow: 0 0 0 0 rgba(224,54,40,0); }
        }
        .ps-alarm-dot { animation: ps-pulse-ring-red 1.4s ease-out infinite; }
        .ps-alarmchip:hover { box-shadow: 0 4px 12px rgba(60,10,5,0.28); transform: translateY(-1px); }
        @keyframes ps-alarm-row-flash { 0%, 100% { background: #ff0000; } 50% { background: #FDEBEA; } }
        .ps-alarm-row { animation: ps-alarm-row-flash 1.1s ease-in-out infinite; }
        @keyframes ps-island-glow-green {
          0%, 100% { box-shadow: 0 3px 8px rgba(0,168,68,0.28); transform: translateY(0); }
          50%      { box-shadow: 0 4px 10px rgba(0,168,68,0.38); transform: translateY(-1px); }
        }
        .ps-island-green { animation: ps-island-glow-green 2.6s ease-in-out infinite; }
        @keyframes ps-island-flash-red {
          0%, 100% { background: linear-gradient(135deg, #FF3B2E 0%, #D6180A 100%); box-shadow: 0 3px 8px rgba(224,40,20,0.32); transform: translateY(0); }
          50%      { background: linear-gradient(135deg, #FF6B5E 0%, #FF2D20 100%); box-shadow: 0 4px 10px rgba(224,40,20,0.45); transform: translateY(-1px); }
        }
        .ps-island-red { animation: ps-island-flash-red 0.9s ease-in-out infinite; }
        .ps-alarmraisebtn:hover { background: ${ALARM_RED_DARK} !important; }
        .ps-print-only { display: none; }
        @media print {
          body * { visibility: hidden; }
          .ps-print-only, .ps-print-only * { visibility: visible; }
          .ps-print-only { display: block !important; position: absolute; left: 0; top: 0; width: 100%; padding: 24px; box-sizing: border-box; }
        }
      `}</style>

            <div style={styles.floatCard}>
                <nav className="ps-sidebar" style={styles.sidebar}>
                    <div style={styles.sidebarBrand}>
                        <div style={styles.sidebarLogo}>PS</div>
                        <span className="ps-navlabel" style={styles.sidebarBrandText}>ProdSched</span>
                    </div>
                    <div style={styles.sidebarNavGroup}>
                        {NAV_ITEMS.map(({ id, label, Icon }) => {
                            const active = activeNav === id;
                            return (
                                <button
                                    key={id}
                                    className="ps-navbtn"
                                    title={label}
                                    onClick={() => setActiveNav(id)}
                                    style={{
                                        ...styles.sidebarBtn,
                                        background: active ? "#1B6E8C" : "transparent",
                                        color: active ? "#FFFFFF" : "#404040",
                                        boxShadow: active ? "0 4px 10px rgba(38,38,38,0.18)" : "none",
                                        fontWeight: active ? 600 : 500,
                                    }}
                                >
                                    <Icon size={17} strokeWidth={2} style={{ flexShrink: 0 }} />
                                    <span className="ps-navlabel" style={styles.sidebarBtnLabel}>{label}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div style={{ flex: 1 }} />
                    <div className="ps-promo" style={styles.sidebarPromo}>
                        <div style={styles.sidebarPromoIcon}>
                            <AlertTriangle size={18} color="#1B6E8C" />
                        </div>
                        <span style={styles.sidebarPromoText}>
                            {conflictCount > 0 ? `${conflictCount} conflict${conflictCount !== 1 ? "s" : ""} need attention` : "All schedules are conflict-free"}
                        </span>
                        <button
                            className="ps-upgradebtn"
                            style={styles.sidebarPromoBtn}
                            onClick={() => setActiveNav("analytics")}
                        >
                            View analytics
                        </button>
                    </div>

                    <div style={styles.sidebarLogoutWrap}>
                        <button className="ps-logoutbtn" title="Log out" onClick={handleLogout} style={styles.sidebarLogoutBtn}>
                            <LogOut size={17} strokeWidth={2} style={{ flexShrink: 0 }} />
                            <span className="ps-navlabel" style={styles.sidebarBtnLabel}>Log out</span>
                        </button>
                    </div>
                </nav>

                <div style={styles.app}>
                    {!focusMode && (
                    <div style={styles.toolbar}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                            <span style={styles.appTitle}>
                                {activeNav === "home" ? "Home" : activeNav === "analytics" ? "Analytics" : activeNav === "tools" ? "Tools" : activeNav === "qrcodes" ? "QR Codes" : activeNav === "shifts" ? "Shifts" : activeNav === "history" ? "History" : activeNav === "settings" ? "Settings" : "Production Scheduler"}
                            </span>
                            <span style={styles.appSub}>from {baseDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · {DAYS} day{DAYS !== 1 ? "s" : ""} shown</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                            {conflictCount > 0 && (
                                <div style={styles.conflictBadge}>
                                    <AlertTriangle size={13} style={{ marginRight: 5 }} />
                                    {conflictCount} conflicting job{conflictCount !== 1 ? "s" : ""}
                                </div>
                            )}
                            {activeNav === "schedule" && (
                                <>
                                    <div style={styles.viewDaysGroup}>
                                        {VIEW_DAY_OPTIONS.map((d) => (
                                            <button
                                                key={d}
                                                className="ps-zoombtn"
                                                style={{
                                                    ...styles.zoomBtn,
                                                    width: "auto",
                                                    padding: "0 10px",
                                                    background: viewDays === d ? "#1B6E8C" : "#FFFFFF",
                                                    color: viewDays === d ? "#FFFFFF" : "#1B6E8C",
                                                    borderColor: viewDays === d ? "#1B6E8C" : "#C8C8C8",
                                                }}
                                                onClick={() => setViewDays(d)}
                                            >
                                                {d}d
                                            </button>
                                        ))}
                                    </div>
                                    <div style={{ display: "flex", gap: 6 }}>
                                        <button className="ps-zoombtn" style={styles.zoomBtn} onClick={() => adjustZoom(-6)}>
                                            <ZoomOut size={14} />
                                        </button>
                                        <button className="ps-zoombtn" style={styles.zoomBtn} onClick={() => adjustZoom(6)}>
                                            <ZoomIn size={14} />
                                        </button>
                                    </div>
                                    <button
                                        className="ps-zoombtn"
                                        style={{
                                            ...styles.zoomBtn,
                                            width: "auto",
                                            padding: "0 12px",
                                            gap: 6,
                                            display: "flex",
                                            alignItems: "center",
                                            background: isFitted ? "#1B6E8C" : "#FFFFFF",
                                            color: isFitted ? "#FFFFFF" : "#1B6E8C",
                                            borderColor: isFitted ? "#1B6E8C" : "#C8C8C8",
                                        }}
                                        onClick={fitWeekToView}
                                    >
                                        <Maximize2 size={13} /> {isFitted ? "undo fit" : "fit view"}
                                    </button>
                                    {conflictCount > 0 && (
                                        <button
                                            className="ps-zoombtn"
                                            style={{ ...styles.zoomBtn, width: "auto", padding: "0 12px", gap: 6, display: "flex", alignItems: "center", background: "#FDECEB", color: "#C4372E", borderColor: "#F7CFCB" }}
                                            onClick={autoFixConflicts}
                                            title="auto-shift overlapping jobs to the next free slot"
                                        >
                                            <Wrench size={13} /> fix {conflictCount} conflict{conflictCount !== 1 ? "s" : ""}
                                        </button>
                                    )}
                                    <button className="ps-zoombtn" style={{ ...styles.zoomBtn, width: "auto", padding: "0 12px", gap: 6, display: "flex", alignItems: "center" }} onClick={resetDemo}>
                                        <RotateCcw size={13} /> reset
                                    </button>
                                    <div style={{ width: 1, height: 20, background: "#C8C8C8" }} />
                                    <input
                                        ref={excelFileInputRef}
                                        type="file"
                                        accept=".xlsx,.xls"
                                        style={{ display: "none" }}
                                        onChange={handleImportExcelFile}
                                    />
                                    <button
                                        className="ps-zoombtn"
                                        style={{ ...styles.zoomBtn, width: "auto", padding: "0 12px", gap: 6, display: "flex", alignItems: "center" }}
                                        onClick={() => excelFileInputRef.current?.click()}
                                        title="import schedule from Excel (matches Job by name)"
                                    >
                                        <Upload size={13} /> Import Excel
                                    </button>
                                    <button
                                        className="ps-zoombtn"
                                        style={{ ...styles.zoomBtn, width: "auto", padding: "0 12px", gap: 6, display: "flex", alignItems: "center" }}
                                        onClick={exportScheduleExcel}
                                        title="export schedule as Excel"
                                    >
                                        <FileSpreadsheet size={13} /> Excel
                                    </button>
                                    <button
                                        className="ps-zoombtn"
                                        style={{ ...styles.zoomBtn, width: "auto", padding: "0 12px", gap: 6, display: "flex", alignItems: "center" }}
                                        onClick={printSchedule}
                                        title="print / save as PDF"
                                    >
                                        <Printer size={13} /> Print / PDF
                                    </button>
                                    <div style={{ width: 1, height: 20, background: "#C8C8C8" }} />
                                    <button
                                        className="ps-zoombtn"
                                        style={styles.zoomBtn}
                                        onClick={() => setFocusMode(true)}
                                        title="Focus mode — hide sidebar, show Gantt + unscheduled pool only"
                                    >
                                        <Maximize2 size={14} />
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    )}

                    {focusMode && (
                        <button style={styles.focusExitBtn} onClick={() => setFocusMode(false)} title="Exit focus mode">
                            <Minimize2 size={15} />
                        </button>
                    )}

                    {(runningNow.length > 0 || activeAlarms.length > 0) && !focusMode && (
                        <div style={styles.islandRow}>
                            {runningNow.length > 0 && (
                                <div className="ps-island-green" style={styles.statusBar}>
                                    <div style={styles.statusBarLabel}>
                                        <Zap size={13} color="#FFFFFF" strokeWidth={2.5} />
                                        Running ({runningNow.length})
                                    </div>
                                    <div style={styles.statusBarStrip} className="ps-scroll">
                                        {runningNow.map(({ job, resource, isOverride, plannedResource }) => (
                                            <div
                                                key={job.id}
                                                className="ps-statuschip"
                                                style={{ ...styles.statusChip, ...(isOverride ? { border: "1px solid rgba(251,191,36,0.5)" } : {}) }}
                                                onClick={() => {
                                                    setActiveNav("schedule");
                                                    jumpToJob(job);
                                                }}
                                                title={isOverride ? `Override: running on ${resource?.name} instead of planned ${plannedResource?.name}` : undefined}
                                            >
                                                <span className="ps-statusbar-dot" style={styles.statusChipDot} />
                                                <span style={styles.statusChipResource}>{resource ? resource.name : "unscheduled"}</span>
                                                {isOverride && (
                                                    <span style={{ fontSize: 9, fontWeight: 700, color: "#92400E", background: "rgba(251,191,36,0.35)", borderRadius: 3, padding: "1px 4px", marginLeft: 2, letterSpacing: 0.2 }}>OVR</span>
                                                )}
                                                <span style={styles.statusChipSep}>·</span>
                                                <span style={styles.statusChipJob}>{job.name}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {activeAlarms.length > 0 && (
                                <div className="ps-island-red" style={styles.alarmBar}>
                                    <div style={styles.alarmBarLabel}>
                                        <AlertOctagon size={13} color="#FFFFFF" strokeWidth={2.5} />
                                        Alarm ({activeAlarms.length})
                                    </div>
                                    {needsAudioUnlock && (
                                        <button
                                            style={styles.alarmUnlockBtn}
                                            onClick={playAlarmBeep}
                                            title="Browser blocked autoplay — click to enable alarm sound"
                                        >
                                            <Volume2 size={12} /> Enable sound
                                        </button>
                                    )}
                                    <button
                                        style={styles.alarmMuteBtn}
                                        onClick={() => setAlarmSoundEnabled((v) => !v)}
                                        title={alarmSoundEnabled ? "Mute alarm sound" : "Unmute alarm sound"}
                                    >
                                        {alarmSoundEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
                                    </button>
                                    <div style={styles.statusBarStrip} className="ps-scroll">
                                        {activeAlarms.map((r) => (
                                            <div key={r.id} className="ps-alarmchip" style={styles.alarmChip}>
                                                <span className="ps-alarm-dot" style={styles.alarmChipDot} />
                                                <span
                                                    style={styles.statusChipResource}
                                                    onClick={() => {
                                                        setActiveNav("schedule");
                                                        setSelectedResourceId(r.id);
                                                        setSelectedJobId(null);
                                                    }}
                                                >
                                                    {r.name}
                                                </span>
                                                <span style={styles.statusChipSep}>·</span>
                                                <span style={styles.alarmChipReason}>{ALARM_REASONS.find((a) => a.id === r.alarmReason)?.label || "Alarm"}</span>
                                                <button style={styles.alarmChipClear} onClick={() => clearAlarm(r.id)} title="clear alarm">
                                                    <X size={11} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {activeNav === "home" && (
                        <div className="ps-scroll" style={styles.homeWrap}>
                            <div style={styles.homeGreetingCard}>
                                <div>
                                    <div style={styles.homeGreetingTitle}>{homeGreeting}, Ratthanan 👋</div>
                                    <div style={styles.homeGreetingSub}>
                                        Here's what's happening across the floor for the {DAYS}-day window starting {baseDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.
                                    </div>
                                </div>
                                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                    <button style={styles.homePrimaryBtn} onClick={() => setActiveNav("schedule")}>
                                        Open schedule <ArrowRight size={14} />
                                    </button>
                                    <button style={styles.homeSecondaryBtn} onClick={() => setActiveNav("analytics")}>
                                        View analytics <ArrowRight size={14} />
                                    </button>
                                </div>
                            </div>

                            <div style={styles.homeStatsGrid}>
                                <div style={styles.homeStatCard}>
                                    <div style={{ ...styles.homeStatIcon, background: "#E3F0FB" }}>
                                        <Boxes size={17} color="#1B6E8C" />
                                    </div>
                                    <span style={styles.homeStatValue}>{resources.length}</span>
                                    <span style={styles.homeStatLabel}>resources tracked</span>
                                </div>
                                <div style={styles.homeStatCard}>
                                    <div style={{ ...styles.homeStatIcon, background: "#E3F5E9" }}>
                                        <CheckCircle2 size={17} color="#21A366" />
                                    </div>
                                    <span style={styles.homeStatValue}>{resources.filter((r) => r.status === "running").length}</span>
                                    <span style={styles.homeStatLabel}>running now</span>
                                </div>
                                <div style={styles.homeStatCard}>
                                    <div style={{ ...styles.homeStatIcon, background: "#EDEDED" }}>
                                        <ListChecks size={17} color="#404040" />
                                    </div>
                                    <span style={styles.homeStatValue}>{scheduledJobs.length}</span>
                                    <span style={styles.homeStatLabel}>jobs scheduled</span>
                                </div>
                                <div style={styles.homeStatCard}>
                                    <div style={{ ...styles.homeStatIcon, background: poolJobs.length ? "#FCF0DC" : "#E3F5E9" }}>
                                        <PauseCircle size={17} color={poolJobs.length ? "#E8A33D" : "#21A366"} />
                                    </div>
                                    <span style={styles.homeStatValue}>{poolJobs.length}</span>
                                    <span style={styles.homeStatLabel}>waiting to be scheduled</span>
                                </div>
                                <div style={styles.homeStatCard}>
                                    <div style={{ ...styles.homeStatIcon, background: conflictCount ? "#FDECEB" : "#E3F5E9" }}>
                                        <AlertTriangle size={17} color={conflictCount ? "#F0625B" : "#21A366"} />
                                    </div>
                                    <span style={{ ...styles.homeStatValue, color: conflictCount ? "#C4372E" : "#262626" }}>{conflictCount}</span>
                                    <span style={styles.homeStatLabel}>jobs in conflict</span>
                                </div>
                                <div
                                    style={{ ...styles.homeStatCard, cursor: "pointer" }}
                                    onClick={() => {
                                        if (activeAlarms[0]) {
                                            setActiveNav("schedule");
                                            setSelectedResourceId(activeAlarms[0].id);
                                            setSelectedJobId(null);
                                        }
                                    }}
                                >
                                    <div style={{ ...styles.homeStatIcon, background: activeAlarms.length ? "#FDECEB" : "#E3F5E9" }}>
                                        <AlertOctagon size={17} color={activeAlarms.length ? ALARM_RED : "#21A366"} />
                                    </div>
                                    <span style={{ ...styles.homeStatValue, color: activeAlarms.length ? ALARM_RED_DARK : "#262626" }}>{activeAlarms.length}</span>
                                    <span style={styles.homeStatLabel}>active alarms</span>
                                </div>
                            </div>

                            <div style={styles.homeMidGrid}>
                                <div style={styles.analyticsCard}>
                                    <div style={styles.analyticsCardHeader}>
                                        <PieChart size={15} color={JOB_RUNNING_GREEN} />
                                        <span style={styles.analyticsCardTitle}>Job status</span>
                                    </div>
                                    {jobs.length === 0 ? (
                                        <div style={styles.bottleneckEmpty}>
                                            <ListChecks size={16} color="#6E6E6E" />
                                            no jobs yet
                                        </div>
                                    ) : (
                                        <div style={styles.donutRow}>
                                            {(() => {
                                                const total = jobs.length;
                                                let cumulative = 0;
                                                const stops = JOB_STATUS_META.filter((m) => jobStatusBreakdown[m.key] > 0).map((m) => {
                                                    const startPct = (cumulative / total) * 100;
                                                    cumulative += jobStatusBreakdown[m.key];
                                                    const endPct = (cumulative / total) * 100;
                                                    return `${m.color} ${startPct}% ${endPct}%`;
                                                });
                                                return (
                                                    <div style={{ ...styles.donutChart, background: `conic-gradient(${stops.join(", ")})` }}>
                                                        <div style={styles.donutHole}>
                                                            <span style={styles.donutHoleValue}>{total}</span>
                                                            <span style={styles.donutHoleLabel}>jobs</span>
                                                        </div>
                                                    </div>
                                                );
                                            })()}
                                            <div style={styles.donutLegend}>
                                                {JOB_STATUS_META.filter((m) => jobStatusBreakdown[m.key] > 0).map((m) => (
                                                    <div key={m.key} style={styles.donutLegendRow}>
                                                        <span style={{ ...styles.legendDot, background: m.color }} />
                                                        <span style={styles.donutLegendLabel}>{m.label}</span>
                                                        <span style={styles.donutLegendValue}>{jobStatusBreakdown[m.key]}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div style={styles.analyticsCard}>
                                    <div style={styles.analyticsCardHeader}>
                                        <Clock size={15} color="#1B6E8C" />
                                        <span style={styles.analyticsCardTitle}>Upcoming (next 4h)</span>
                                    </div>
                                    {upcomingJobs.length === 0 ? (
                                        <div style={styles.bottleneckEmpty}>
                                            <CheckCircle2 size={16} color="#21A366" />
                                            nothing starting soon
                                        </div>
                                    ) : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                            {upcomingJobs.map(({ job, resource }) => (
                                                <div
                                                    key={job.id}
                                                    style={styles.homeStatusRow}
                                                    onClick={() => {
                                                        setActiveNav("schedule");
                                                        jumpToJob(job);
                                                    }}
                                                >
                                                    <span style={{ ...styles.legendDot, background: PRODUCTS[job.product] }} />
                                                    <span style={styles.utilRowName}>{job.name}</span>
                                                    <span style={styles.resourceType}>{resource ? resource.name : ""}</span>
                                                    <span style={{ ...styles.bottleneckBadge, marginLeft: "auto" }}>
                                                        in {(job.startHour - nowHour).toFixed(1)}h
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div style={styles.homeBottomGrid}>
                                <div style={styles.analyticsCard}>
                                    <div style={styles.analyticsCardHeader}>
                                        <Gauge size={15} color="#1B6E8C" />
                                        <span style={styles.analyticsCardTitle}>Resource status</span>
                                    </div>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                        {resources.map((r) => {
                                            const meta = STATUS_META[r.status];
                                            return (
                                                <div
                                                    key={r.id}
                                                    style={styles.homeStatusRow}
                                                    onClick={() => {
                                                        setSelectedResourceId(r.id);
                                                        setSelectedJobId(null);
                                                        setActiveNav("schedule");
                                                    }}
                                                >
                                                    <meta.Icon size={14} color={meta.color} />
                                                    <span style={styles.utilRowName}>{r.name}</span>
                                                    <span style={styles.resourceType}>{r.type}</span>
                                                    <span
                                                        style={{
                                                            ...styles.bottleneckBadge,
                                                            background: r.alarmActive ? "#FDECEB" : "#F2F2F2",
                                                            color: r.alarmActive ? ALARM_RED_DARK : meta.color,
                                                            borderColor: r.alarmActive ? "#F7CFCB" : "#C8C8C8",
                                                            marginLeft: "auto",
                                                        }}
                                                    >
                                                        {r.alarmActive ? "ALARM" : meta.label}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div style={styles.analyticsCard}>
                                    <div style={styles.analyticsCardHeader}>
                                        <ListChecks size={15} color="#404040" />
                                        <span style={styles.analyticsCardTitle}>Unscheduled jobs</span>
                                    </div>
                                    {poolJobs.length === 0 ? (
                                        <div style={styles.bottleneckEmpty}>
                                            <CheckCircle2 size={16} color="#21A366" />
                                            everything is scheduled
                                        </div>
                                    ) : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                            {poolJobs.slice(0, 6).map((job) => (
                                                <div
                                                    key={job.id}
                                                    style={styles.homeStatusRow}
                                                    onClick={() => {
                                                        setSelectedJobId(job.id);
                                                        setSelectedResourceId(null);
                                                        setActiveNav("schedule");
                                                    }}
                                                >
                                                    <span style={{ ...styles.legendDot, background: PRODUCTS[job.product] }} />
                                                    <span style={styles.utilRowName}>{job.name}</span>
                                                    <span style={{ ...styles.resourceType, marginLeft: "auto" }}>{job.duration}h</span>
                                                </div>
                                            ))}
                                            {poolJobs.length > 6 && (
                                                <div style={{ fontSize: 11, color: "#6E6E6E" }}>+{poolJobs.length - 6} more in schedule view</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeNav === "schedule" && (
                        <>
                            {importError && (
                                <div style={{ ...styles.qrIntro, margin: "0 18px 0", borderRadius: 0, borderLeft: "none", borderRight: "none" }}>
                                    <FileSpreadsheet size={14} color="#1B6E8C" />
                                    <span>{importError}</span>
                                    <button style={{ ...styles.searchClearBtn, marginLeft: "auto" }} onClick={() => setImportError("")}>
                                        <X size={13} />
                                    </button>
                                </div>
                            )}
                            {!focusMode && (
                            <div style={styles.filterBar}>
                                <div style={{ position: "relative" }}>
                                    <div style={styles.searchBox}>
                                        <Search size={14} color="#6E6E6E" />
                                        <input
                                            className="ps-searchinput"
                                            placeholder="Search jobs by name..."
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            onFocus={() => setSearchFocused(true)}
                                            onBlur={() => setSearchFocused(false)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Escape") {
                                                    setSearchQuery("");
                                                    e.currentTarget.blur();
                                                } else if (e.key === "Enter" && searchSuggestions.length > 0) {
                                                    jumpToJob(searchSuggestions[0].job);
                                                }
                                            }}
                                            style={styles.searchInput}
                                        />
                                        {searchQuery && (
                                            <button style={styles.searchClearBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => setSearchQuery("")}>
                                                <X size={13} />
                                            </button>
                                        )}
                                    </div>
                                    {searchFocused && searchQuery.trim() !== "" && (
                                        <div style={styles.searchDropdown}>
                                            {searchSuggestions.length === 0 ? (
                                                <div style={styles.searchDropdownEmpty}>no jobs match "{searchQuery.trim()}"</div>
                                            ) : (
                                                searchSuggestions.map(({ job, resource }) => (
                                                    <div
                                                        key={job.id}
                                                        className="ps-searchitem"
                                                        style={styles.searchDropdownItem}
                                                        onMouseDown={(e) => {
                                                            e.preventDefault();
                                                            jumpToJob(job);
                                                        }}
                                                    >
                                                        <span style={{ ...styles.legendDot, background: PRODUCTS[job.product] }} />
                                                        <span style={styles.searchDropdownName}>{job.name}</span>
                                                        <span style={styles.searchDropdownMeta}>{job.product} · {job.duration}h</span>
                                                        <span style={styles.searchDropdownLoc}>{resource ? resource.name : "unscheduled"}</span>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    )}
                                </div>
                                <select className="ps-select" style={styles.filterSelect} value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)}>
                                    <option value="all">all products</option>
                                    {Object.keys(PRODUCTS).map((p) => (
                                        <option key={p} value={p}>{p}</option>
                                    ))}
                                </select>
                                <select className="ps-select" style={styles.filterSelect} value={filterResourceType} onChange={(e) => setFilterResourceType(e.target.value)}>
                                    <option value="all">all resource types</option>
                                    {resourceTypes.map((t) => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                                <div style={styles.dateRangeGroup}>
                                    <input
                                        type="date"
                                        className="ps-input"
                                        style={styles.dateInput}
                                        value={filterFromDate}
                                        max={filterToDate || undefined}
                                        onChange={(e) => setFilterFromDate(e.target.value)}
                                    />
                                    <span style={styles.dateRangeSep}>–</span>
                                    <input
                                        type="date"
                                        className="ps-input"
                                        style={styles.dateInput}
                                        value={filterToDate}
                                        min={filterFromDate || undefined}
                                        onChange={(e) => setFilterToDate(e.target.value)}
                                    />
                                    {(filterFromDate || filterToDate) && (
                                        <button className="ps-zoombtn" style={{ ...styles.zoomBtn, width: "auto", padding: "0 10px" }} onClick={jumpToDateRange} title="scroll to range">
                                            go
                                        </button>
                                    )}
                                </div>
                                {isFilterActive && (
                                    <button
                                        style={styles.filterClearBtn}
                                        onClick={() => {
                                            setSearchQuery("");
                                            setFilterProduct("all");
                                            setFilterResourceType("all");
                                            setFilterFromDate("");
                                            setFilterToDate("");
                                        }}
                                    >
                                        clear filters
                                    </button>
                                )}
                                {isFilterActive && (
                                    <span style={styles.filterCount}>
                                        {jobs.filter(jobMatchesFilter).length} match{jobs.filter(jobMatchesFilter).length !== 1 ? "es" : ""}
                                    </span>
                                )}
                            </div>
                            )}
                            {!focusMode && (
                            <div style={styles.legend}>
                                {Object.entries(PRODUCTS).map(([name, color]) => (
                                    <div key={name} style={styles.legendItem}>
                                        <span style={{ ...styles.legendDot, background: color }} />
                                        {name}
                                    </div>
                                ))}
                                <div style={styles.legendDivider} />
                                {Object.entries(STATUS_META).map(([key, meta]) => (
                                    <div key={key} style={styles.legendItem}>
                                        <meta.Icon size={12} color={meta.color} style={{ marginRight: 4 }} />
                                        {meta.label}
                                    </div>
                                ))}
                                <div style={styles.legendDivider} />
                                <div style={styles.legendItem}>
                                    <CheckCircle2 size={12} color={DONE_BLUE} style={{ marginRight: 4 }} />
                                    Done
                                </div>
                                <div style={styles.legendItem}>
                                    <Clock size={12} color={OVERDUE_AMBER} style={{ marginRight: 4 }} />
                                    Overdue
                                </div>
                                <div style={styles.legendDivider} />
                                {shiftConfig.map((s) => (
                                    <div key={s.id} style={styles.legendItem}>
                                        <span style={{ ...styles.legendDot, borderRadius: 3, background: s.color }} />
                                        {s.name} {hourToTimeInput(s.start)}–{hourToTimeInput(s.end)}
                                    </div>
                                ))}
                                <div style={styles.legendDivider} />
                                <div style={{ ...styles.legendItem, color: "#8C8C8C", fontStyle: "italic" }}>
                                    ctrl/cmd + click to multi-select jobs
                                </div>
                            </div>
                            )}

                            <div
                                ref={gridScrollRef}
                                className="ps-scroll"
                                style={styles.scrollArea}
                                onPointerDown={() => {
                                    setSelectedJobId(null);
                                    setSelectedResourceId(null);
                                    setBulkSelectedIds(new Set());
                                }}
                            >
                                <div style={{ position: "relative", width: RESOURCE_COL_WIDTH + timelineWidth }}>
                                    <div style={{ ...styles.headerRow, width: RESOURCE_COL_WIDTH + timelineWidth }}>
                                        <div style={styles.cornerCell}>
                                            resource
                                            <button className="ps-addbtn" style={styles.addResBtn} onClick={addResource}>+</button>
                                        </div>
                                        <div style={{ position: "relative", width: timelineWidth, height: HEADER_HEIGHT, background: "#FFFFFF" }}>
                                            {Array.from({ length: DAYS }).map((_, d) => {
                                                const date = new Date(baseDate.getTime() + d * 86400000);
                                                const isToday = d === Math.floor(nowHour / 24);
                                                const zebraBg = d % 2 === 0 ? "#FFFFFF" : "#EDEDED";
                                                return (
                                                    <div
                                                        key={d}
                                                        style={{
                                                            position: "absolute",
                                                            left: d * 24 * hourWidth,
                                                            top: 0,
                                                            width: 24 * hourWidth,
                                                            height: 26,
                                                            borderLeft: "1px solid #BFBFBF",
                                                            boxSizing: "border-box",
                                                            background: isToday ? "#D6E8FA" : zebraBg,
                                                            display: "flex",
                                                            alignItems: "center",
                                                        }}
                                                    >
                                                        <span style={{ ...styles.dayLabel, color: isToday ? "#1B6E8C" : "#404040" }}>
                                                            {hourWidth < 14
                                                                ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
                                                                : date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                            {Array.from({ length: DAYS }).flatMap((_, d) =>
                                                shiftDaySegments.flatMap((shift) =>
                                                    shift.segments.map((seg, si) => {
                                                        const left = (d * 24 + seg.start) * hourWidth;
                                                        const width = (seg.end - seg.start) * hourWidth;
                                                        const showLabel = width >= 34;
                                                        const breaksInSeg = shift.breaks.filter((b) => b.start < seg.end && b.end > seg.start);
                                                        const tooltip =
                                                            `${shift.name} shift ${hourToTimeInput(shift.start)}–${hourToTimeInput(shift.end)}` +
                                                            (breaksInSeg.length ? `\nBreaks: ${breaksInSeg.map((b) => `${b.label} ${hourToTimeInput(b.start)}–${hourToTimeInput(b.end)}`).join(", ")}` : "");
                                                        return (
                                                            <div
                                                                key={`shiftband-${d}-${shift.id}-${si}`}
                                                                title={tooltip}
                                                                style={{
                                                                    position: "absolute",
                                                                    left,
                                                                    top: 26,
                                                                    width,
                                                                    height: SHIFT_BAND_HEIGHT,
                                                                    background: shift.color,
                                                                    borderLeft: "1px solid #FFFFFF",
                                                                    boxSizing: "border-box",
                                                                    display: "flex",
                                                                    alignItems: "center",
                                                                    justifyContent: "center",
                                                                    fontSize: 8.5,
                                                                    fontWeight: 700,
                                                                    letterSpacing: "0.03em",
                                                                    color: textColorForBg(shift.color),
                                                                    fontFamily: "'IBM Plex Mono',monospace",
                                                                    overflow: "hidden",
                                                                    whiteSpace: "nowrap",
                                                                }}
                                                            >
                                                                {showLabel ? shift.name : ""}
                                                            </div>
                                                        );
                                                    })
                                                )
                                            )}
                                            {hourWidth >= 10 &&
                                                Array.from({ length: TOTAL_HOURS }).map((_, h) => {
                                                    const isDayStart = h % 24 === 0;
                                                    const isMajor = h % 6 === 0;
                                                    const isMinor = h % 2 === 0;
                                                    if (!isMinor) return null;
                                                    return (
                                                        <div
                                                            key={h}
                                                            style={{
                                                                position: "absolute",
                                                                left: h * hourWidth,
                                                                top: 26 + SHIFT_BAND_HEIGHT,
                                                                height: HEADER_HEIGHT - 26 - SHIFT_BAND_HEIGHT,
                                                                borderLeft: isDayStart ? "1px solid #BFBFBF" : isMajor ? "1px solid #C8C8C8" : "1px solid #E1E1E1",
                                                            }}
                                                        >
                                                            {isMajor && hourWidth >= 16 && (
                                                                <span style={styles.hourLabel}>{String(h % 24).padStart(2, "0")}:00</span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            {nowHour >= 0 && nowHour <= TOTAL_HOURS && (
                                                <div style={{ position: "absolute", left: nowHour * hourWidth, top: 0, width: 2, height: HEADER_HEIGHT, background: "linear-gradient(180deg,#1B6E8C,#4FA8C9)", zIndex: 25, borderRadius: 2 }}>
                                                    <div style={styles.nowDot} />
                                                </div>
                                            )}
                                            {rangeFromDate && (() => {
                                                const h = (rangeFromDate.getTime() - baseDate.getTime()) / 3600000;
                                                if (h < 0 || h > TOTAL_HOURS) return null;
                                                return <div style={{ position: "absolute", left: h * hourWidth, top: 0, width: 2, height: HEADER_HEIGHT, background: "#E0559B", zIndex: 24 }} />;
                                            })()}
                                            {rangeToDate && (() => {
                                                const h = (rangeToDate.getTime() - baseDate.getTime()) / 3600000;
                                                if (h < 0 || h > TOTAL_HOURS) return null;
                                                return <div style={{ position: "absolute", left: h * hourWidth, top: 0, width: 2, height: HEADER_HEIGHT, background: "#E0559B", zIndex: 24 }} />;
                                            })()}
                                        </div>
                                    </div>

                                    {resources.map((r, rowIndex) => {
                                        const meta = STATUS_META[r.status];
                                        return (
                                            <div key={r.id} style={{ display: "flex", height: ROW_HEIGHT }}>
                                                <div
                                                    className={r.alarmActive ? "ps-alarm-row" : undefined}
                                                    style={{
                                                        ...styles.resourceCell,
                                                        cursor: "pointer",
                                                        background: selectedResourceId === r.id ? "#EDEDED" : "#FFFFFF",
                                                        borderLeft: r.alarmActive ? `3px solid ${ALARM_RED}` : "3px solid transparent",
                                                    }}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    onClick={() => {
                                                        setSelectedResourceId(r.id);
                                                        setSelectedJobId(null);
                                                    }}
                                                >
                                                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                        <meta.Icon size={13} color={meta.color} />
                                                        <span style={styles.resourceName}>{r.name}</span>
                                                        {r.alarmActive && <AlertOctagon size={12} color={ALARM_RED} strokeWidth={2.5} />}
                                                    </div>
                                                    <span style={styles.resourceType}>{r.type}</span>
                                                    <div style={styles.utilTrack}>
                                                        <div style={{ ...styles.utilFill, width: `${utilization[r.id]}%` }} />
                                                    </div>
                                                </div>
                                                <div style={{ position: "relative", width: timelineWidth, borderBottom: "1px solid #E1E1E1" }}>
                                                    {Array.from({ length: DAYS }).map((_, d) => {
                                                        const isToday = d === Math.floor(nowHour / 24);
                                                        const zebraBg = d % 2 === 0 ? "#FFFFFF" : "#F5F5F5";
                                                        return (
                                                            <div
                                                                key={d}
                                                                style={{
                                                                    position: "absolute",
                                                                    left: d * 24 * hourWidth,
                                                                    top: 0,
                                                                    bottom: 0,
                                                                    width: 24 * hourWidth,
                                                                    borderLeft: "1px solid #C8C8C8",
                                                                    background: isToday ? "#E9F3FC" : zebraBg,
                                                                }}
                                                            />
                                                        );
                                                    })}
                                                    {hourWidth >= 10 &&
                                                        Array.from({ length: TOTAL_HOURS }).map((_, h) =>
                                                            h % 6 === 0 && h % 24 !== 0 ? (
                                                                <div key={h} style={{ position: "absolute", left: h * hourWidth, top: 0, bottom: 0, borderLeft: "1px dashed #E5E5E5" }} />
                                                            ) : null
                                                        )}
                                                    {Array.from({ length: DAYS }).flatMap((_, d) =>
                                                        shiftBoundaryHours.map((sh) => (
                                                            <div
                                                                key={`shiftline-${d}-${sh}`}
                                                                style={{ position: "absolute", left: (d * 24 + sh) * hourWidth, top: 0, bottom: 0, borderLeft: "1px dashed #B0B0B0" }}
                                                            />
                                                        ))
                                                    )}
                                                    {nowHour >= 0 && nowHour <= TOTAL_HOURS && (
                                                        <div style={{ position: "absolute", left: nowHour * hourWidth, top: 0, bottom: 0, width: 2, background: "linear-gradient(180deg,#1B6E8C22,#4FA8C922)" }} />
                                                    )}
                                                    {(rangeFromDate || rangeToDate) && (() => {
                                                        const fromH = rangeFromDate ? Math.max(0, (rangeFromDate.getTime() - baseDate.getTime()) / 3600000) : 0;
                                                        const toH = rangeToDate ? Math.min(TOTAL_HOURS, (rangeToDate.getTime() - baseDate.getTime()) / 3600000) : TOTAL_HOURS;
                                                        if (toH <= fromH) return null;
                                                        return (
                                                            <div
                                                                style={{
                                                                    position: "absolute",
                                                                    left: fromH * hourWidth,
                                                                    width: (toH - fromH) * hourWidth,
                                                                    top: 0,
                                                                    bottom: 0,
                                                                    background: "rgba(224,85,155,0.06)",
                                                                    borderLeft: "1px dashed #E0559B77",
                                                                    borderRight: "1px dashed #E0559B77",
                                                                    pointerEvents: "none",
                                                                }}
                                                            />
                                                        );
                                                    })()}
                                                    {scheduledJobs
                                                        .filter((j) => j.resourceId === r.id)
                                                        .map((job) => {
                                                            const isConflict = conflictIds.has(job.id);
                                                            const bulkSelected = bulkSelectedIds.has(job.id);
                                                            const color = PRODUCTS[job.product];
                                                            const selected = selectedJobId === job.id;
                                                            const dimmed = isFilterActive && !jobMatchesFilter(job);
                                                            const blocked = isJobBlocked(job);
                                                            // scheduled window is over but the job never got scanned start/stop
                                                            const isDone = !!job.completed;
                                                            const isOverdue = !isDone && !job.isRunning && !blocked && job.startHour + job.duration < nowHour;
                                                            return (
                                                                <div
                                                                    key={job.id}
                                                                    className={`ps-job${job.isRunning && !blocked ? " ps-job-running" : ""}`}
                                                                    onPointerDown={(e) => onJobPointerDown(e, job, "move")}
                                                                    style={{
                                                                        position: "absolute",
                                                                        left: job.startHour * hourWidth,
                                                                        width: Math.max(6, job.duration * hourWidth - 2),
                                                                        top: 5,
                                                                        height: ROW_HEIGHT - 28,
background: blocked ? "#FBE4E2" : job.isRunning ? JOB_RUNNING_GREEN : isDone ? "#E3F0FB" : isOverdue ? OVERDUE_AMBER_BG : job.locked ? `${color}22` : `${color}40`,
border: blocked ? `1px solid ${ALARM_RED}99` : isOverdue ? `1px solid ${OVERDUE_AMBER_BORDER}` : isConflict ? "1px solid #F0625B" : isDone ? `1px solid ${DONE_BLUE}55` : job.locked ? `1px solid ${color}77` : `1px solid ${color}AA`,
                                                                        borderLeftWidth: 4,
                                                                        borderLeftColor: blocked ? ALARM_RED : isOverdue ? OVERDUE_AMBER_BORDER : isDone ? DONE_BLUE : color,
                                                                        boxShadow: bulkSelected
                                                                            ? `0 0 0 2px #1B6E8C, 0 0 0 4px rgba(27,110,140,0.25)`
                                                                            : selected
                                                                            ? `0 0 0 2px ${color}55, 0 4px 10px rgba(27,110,140,0.12)`
                                                                            : "0 1px 4px rgba(27,110,140,0.08)",
                                                                        borderRadius: 3,
                                                                        cursor: blocked ? "not-allowed" : job.locked ? "pointer" : "grab",
                                                                        overflow: "hidden",
                                                                        userSelect: "none",
                                                                        boxSizing: "border-box",
                                                                        opacity: dimmed ? 0.28 : 1,
                                                                        filter: dimmed ? "grayscale(0.4)" : "none",
                                                                        transition: "opacity 0.15s ease",
                                                                    }}
                                                                >
                                                                    {(job.locked || blocked) && (
                                                                        <div
                                                                            style={{
                                                                                position: "absolute",
                                                                                inset: 0,
                                                                                backgroundImage: blocked
                                                                                    ? `repeating-linear-gradient(135deg, transparent, transparent 6px, ${ALARM_RED}26 6px, ${ALARM_RED}26 12px)`
                                                                                    : `repeating-linear-gradient(135deg, transparent, transparent 6px, ${color}30 6px, ${color}30 12px)`,
                                                                            }}
                                                                        />
                                                                    )}
                                                                    <div style={{ padding: "4px 7px", position: "relative", zIndex: 1 }}>
                                                                        <div
                                                                            style={{
                                                                                display: "flex",
                                                                                alignItems: "center",
                                                                                gap: 4,
                                                                                fontFamily: "'IBM Plex Mono',monospace",
                                                                                fontSize: 11,
                                                                                color: blocked ? ALARM_RED_DARK : job.isRunning ? "#FFFFFF" : "#262626",
                                                                                whiteSpace: "nowrap",
                                                                                textShadow: job.isRunning && !blocked ? "0 1px 2px rgba(0,60,20,0.35)" : "none",
                                                                            }}
                                                                        >
                                                                            {blocked ? (
                                                                                <AlertOctagon size={9} color={ALARM_RED_DARK} strokeWidth={2.5} />
                                                                            ) : isDone ? (
                                                                                <CheckCircle2 size={9} color={DONE_BLUE} strokeWidth={2.5} />
                                                                            ) : isOverdue ? (
                                                                                <Clock size={9} color={OVERDUE_AMBER} strokeWidth={2.5} />
                                                                            ) : (
                                                                                job.locked && <Lock size={9} color={job.isRunning ? "#FFFFFF" : color} strokeWidth={2.5} />
                                                                            )}
                                                                            {job.name}
                                                                        </div>
                                                                        {blocked ? (
                                                                            <div style={{ fontSize: 9.5, fontWeight: 800, color: ALARM_RED_DARK, letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                                                                                BLOCKED
                                                                            </div>
                                                                        ) : job.isRunning ? (
                                                                            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 800, color: "#FFFFFF", letterSpacing: "0.05em", whiteSpace: "nowrap", textShadow: "0 1px 2px rgba(0,60,20,0.35)" }}>
                                                                                <span className="ps-running-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "#FFFFFF", flexShrink: 0 }} />
                                                                                RUNNING
                                                                            </div>
                                                                        ) : isDone ? (
                                                                            <div style={{ fontSize: 9.5, fontWeight: 800, color: DONE_BLUE, letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                                                                                DONE
                                                                            </div>
                                                                        ) : isOverdue ? (
                                                                            <div style={{ fontSize: 9.5, fontWeight: 800, color: OVERDUE_AMBER, letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                                                                                OVERDUE
                                                                            </div>
                                                                        ) : (
                                                                            <div style={{ fontSize: 10, color: "#6E6E6E", whiteSpace: "nowrap" }}>{job.duration}h</div>
                                                                        )}
                                                                    </div>
                                                                    {isConflict && <AlertTriangle size={11} color="#F0625B" style={{ position: "absolute", top: 4, right: 4, zIndex: 2 }} />}
                                                                    {bulkSelected && (
                                                                        <div style={{ position: "absolute", top: 4, left: 4, zIndex: 3, width: 14, height: 14, borderRadius: "50%", background: "#1B6E8C", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                                                            <CheckCircle2 size={10} color="#FFFFFF" />
                                                                        </div>
                                                                    )}
                                                                    {!job.locked && !blocked && (
                                                                        <div
                                                                            onPointerDown={(e) => onJobPointerDown(e, job, "resize")}
                                                                            style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "ew-resize" }}
                                                                        />
                                                                    )}
                                                                    {(job.toolChanges || []).length > 0 && (() => {
                                                                        const totalJobMin = job.duration * 60;
                                                                        return (
                                                                            <div style={{ position: "absolute", left: 4, right: 4, bottom: 3, height: 4, borderRadius: 2, background: "rgba(0,0,0,0.08)", overflow: "hidden", pointerEvents: "none" }}
                                                                                title={`Tool changes: ${(job.toolChanges||[]).length} step${(job.toolChanges||[]).length!==1?"s":""} · ${job.toolChanges.reduce((s,c)=>s+(Number(c.durationMin)||0),0)}min total`}>
                                                                                {(job.toolChanges||[]).map((c,ci) => {
                                                                                    const startPct = Math.min(100, ((Number(c.startMin)||0)/totalJobMin)*100);
                                                                                    const widthPct = Math.min(100-startPct, ((Number(c.durationMin)||0)/totalJobMin)*100);
                                                                                    if (widthPct <= 0) return null;
                                                                                    return <div key={c.id||ci} style={{ position:"absolute", left:`${startPct}%`, width:`${widthPct}%`, top:0, bottom:0, background: job.isRunning?"rgba(255,255,255,0.75)":"#E8A33D", borderRadius:2 }} />;
                                                                                })}
                                                                            </div>
                                                                        );
                                                                    })()}
                                                                </div>
                                                            );
                                                        })}
                                                    {/* ── Actual-run bars: grey bg at real scan-start, fill = elapsed ── */}
                                                    {/* actualResourceId: set when operator scanned a different machine (override) */}
                                                    {[...scheduledJobs
                                                        .filter((j) => j.resourceId === r.id && !j.actualResourceId && j.runStartedAt && (j.isRunning || j.completed)),
                                                      ...scheduledJobs
                                                        .filter((j) => j.actualResourceId === r.id && j.runStartedAt && (j.isRunning || j.completed))]
                                                        .map((job) => {
                                                            const runStart = new Date(job.runStartedAt);
                                                            const barStartH = (runStart.getTime() - baseDate.getTime()) / 3600000;
                                                            if (barStartH < 0) return null;
                                                            const bgW = Math.max(6, job.duration * hourWidth);
                                                            const elapsedH = job.isRunning
                                                                ? Math.max(0, (nowTick - runStart.getTime()) / 3600000)
                                                                : (job.actualRunHours || 0);
                                                            const fillW = Math.max(0, elapsedH * hourWidth);
                                                            const isRunning = !!job.isRunning;
                                                            const fillColor = isRunning ? "#00C853" : DONE_BLUE;
                                                            const fillBg   = isRunning ? "rgba(0,200,83,0.82)" : "rgba(27,110,140,0.72)";
                                                            const elapsedMin = (elapsedH * 60).toFixed(0);
                                                            return (
                                                                <div
                                                                    key={`actual-${job.id}`}
                                                                    title={isRunning
                                                                        ? `${job.name} · Running · ${elapsedMin}min elapsed / ${(job.duration*60).toFixed(0)}min planned${job.actualResourceId ? " · ⚠ Override from planned resource" : ""}`
                                                                        : `${job.name} · Done · ${elapsedMin}min actual / ${(job.duration*60).toFixed(0)}min planned${job.actualResourceId ? " · ⚠ Override from planned resource" : ""}`}
                                                                    style={{ position: "absolute", left: barStartH * hourWidth, width: bgW, top: ROW_HEIGHT - 20, height: 15, borderRadius: 3, background: "#D4D4D4", border: job.actualResourceId ? "1px solid #F59E0B" : "1px solid #B0B0B0", borderLeft: job.actualResourceId ? "3px solid #D97706" : "3px solid #909090", overflow: "hidden", pointerEvents: "none", zIndex: 3, boxSizing: "border-box" }}
                                                                >
                                                                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: Math.min(fillW, bgW), background: fillBg, borderLeft: `3px solid ${fillColor}`, transition: isRunning ? "width 1s linear" : "none" }} />
                                                                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", gap: 3, paddingLeft: 5, zIndex: 1 }}>
                                                                        {isRunning && <span className="ps-running-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "#fff", flexShrink: 0, boxShadow: "0 0 0 1px #00C85377" }} />}
                                                                        <span style={{ fontSize: 9, fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: fillW > bgW * 0.4 ? "#fff" : "#444", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textShadow: fillW > bgW * 0.4 ? "0 1px 2px rgba(0,0,0,0.35)" : "none" }}>
                                                                            {job.name}{bgW > 90 ? ` · ${elapsedMin}min` : ""}
                                                                        </span>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    {jobLinks
                                                        .map((link) => ({ link, fromJ: jobs.find((j) => j.id === link.fromJobId), toJ: jobs.find((j) => j.id === link.toJobId) }))
                                                        .filter(({ link, fromJ, toJ }) => fromJ && toJ && fromJ.resourceId === r.id && toJ.resourceId === r.id && isLinkStillAdjacent(fromJ, toJ, link))
                                                        .map(({ link, fromJ, toJ }) => {
                                                            const x1 = (fromJ.startHour + fromJ.duration) * hourWidth;
                                                            const x2 = toJ.startHour * hourWidth;
                                                            const midY = ROW_HEIGHT / 2;
                                                            if (x2 <= x1) {
                                                                // jobs got dragged back into overlap after linking - still show a marker
                                                                // at the "to" job's start so the link isn't silently invisible
                                                                return (
                                                                    <div key={link.id} title={`${fromJ.name} → ${toJ.name} · ${link.changeoverMin}m changeover`} style={{ position: "absolute", left: x2 - 8, top: midY - 8, width: 16, height: 16, borderRadius: "50%", background: "#1B6E8C", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 6, pointerEvents: "none" }}>
                                                                        <Link2 size={9} color="#FFFFFF" />
                                                                    </div>
                                                                );
                                                            }
                                                            return (
                                                                <div key={link.id} style={{ position: "absolute", left: x1, top: midY - 1, width: x2 - x1, height: 2, zIndex: 6, pointerEvents: "none" }}>
                                                                    <div style={{ position: "absolute", inset: 0, borderTop: "2px dashed #1B6E8C" }} />
                                                                    <div
                                                                        style={{
                                                                            position: "absolute",
                                                                            left: "50%",
                                                                            top: "50%",
                                                                            transform: "translate(-50%, -50%)",
                                                                            display: "flex",
                                                                            alignItems: "center",
                                                                            gap: 3,
                                                                            background: "#1B6E8C",
                                                                            color: "#FFFFFF",
                                                                            borderRadius: 8,
                                                                            padding: "1px 6px",
                                                                            fontSize: 9,
                                                                            fontWeight: 700,
                                                                            fontFamily: "'IBM Plex Mono',monospace",
                                                                            whiteSpace: "nowrap",
                                                                        }}
                                                                        title={`${fromJ.name} → ${toJ.name} · ${link.changeoverMin}m changeover`}
                                                                    >
                                                                        <Link2 size={9} /> {link.changeoverMin}m
                                                                    </div>
                                                                    <div
                                                                        style={{
                                                                            position: "absolute",
                                                                            right: -1,
                                                                            top: -3,
                                                                            width: 0,
                                                                            height: 0,
                                                                            borderTop: "4px solid transparent",
                                                                            borderBottom: "4px solid transparent",
                                                                            borderLeft: "6px solid #1B6E8C",
                                                                        }}
                                                                    />
                                                                </div>
                                                            );
                                                        })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div
                                ref={poolRef}
                                style={{
                                    ...styles.pool,
                                    border: isDraggingNC ? "2px dashed #1B6E8C" : "2px dashed transparent",
                                    background: isDraggingNC ? "#E3F0FB" : styles.pool.background,
                                    transition: "background 0.12s ease, border-color 0.12s ease",
                                    boxSizing: "border-box",
                                }}
                                onDragOver={(e) => {
                                    if (Array.from(e.dataTransfer.items || []).some((it) => it.kind === "file")) {
                                        e.preventDefault();
                                        setIsDraggingNC(true);
                                    }
                                }}
                                onDragLeave={(e) => {
                                    if (e.currentTarget.contains(e.relatedTarget)) return;
                                    setIsDraggingNC(false);
                                }}
                                onDrop={handleNCDrop}
                            >
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                                    <div style={styles.poolLabel}>
                                        unscheduled ({poolJobs.length})
                                        {isDraggingNC && <span style={{ marginLeft: 8, color: "#1B6E8C", textTransform: "none" }}>Drop NC files here</span>}
                                    </div>
                                    <div style={{ display: "flex", gap: 8 }}>
                                        <input
                                            ref={ncFileInputRef}
                                            type="file"
                                            accept=".nc,.tap,.cnc,.gcode,.nc1,.mpf,.eia,.txt"
                                            multiple
                                            style={{ display: "none" }}
                                            onChange={handleNCBrowseChange}
                                        />
                                        <button
                                            className="ps-addbtn"
                                            style={{ ...styles.addJobBtn, background: "#404040", border: "1px solid #404040", display: "flex", alignItems: "center", gap: 5 }}
                                            onClick={() => ncFileInputRef.current?.click()}
                                            title="Select NC files to create jobs with estimated durations"
                                        >
                                            <Upload size={12} /> import NC
                                        </button>
                                        <button className="ps-addbtn" style={styles.addJobBtn} onClick={addJob}>
                                            + new job
                                        </button>
                                    </div>
                                </div>
                                {ncImportNotices.length > 0 && (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                                        {ncImportNotices.map((n) => (
                                            <div key={n.id} style={{ ...styles.ncNotice, ...styles[`ncNotice_${n.type}`] }}>
                                                <span style={{ flex: 1, minWidth: 0 }}>{n.text}</span>
                                                <button
                                                    style={styles.ncNoticeClose}
                                                    onClick={() => setNcImportNotices((ns) => ns.filter((x) => x.id !== n.id))}
                                                >
                                                    <X size={11} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div style={styles.poolStrip}>
                                    {poolJobs.map((job) => {
                                        const dimmed = isFilterActive && !jobMatchesFilter(job);
                                        return (
                                            <div
                                                key={job.id}
                                                className="ps-chip"
                                                onPointerDown={(e) => onPoolPointerDown(e, job)}
                                                onClick={() => setSelectedJobId(job.id)}
                                                style={{
                                                    ...styles.chip,
                                                    borderLeft: `4px solid ${job.isRunning ? RUNNING_GREEN : PRODUCTS[job.product]}`,
                                                    background: job.isRunning ? "#E3F5E9" : "#FFFFFF",
                                                    boxShadow: selectedJobId === job.id ? `0 0 0 2px ${PRODUCTS[job.product]}55` : job.isRunning ? "0 0 0 1px #A8DDBB" : "0 1px 4px rgba(27,110,140,0.08)",
                                                    opacity: dimmed ? 0.28 : 1,
                                                    filter: dimmed ? "grayscale(0.4)" : "none",
                                                    transition: "opacity 0.15s ease",
                                                }}
                                            >
                                                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, color: "#262626" }}>{job.name}</div>
                                                <div style={{ fontSize: 10, color: "#6E6E6E" }}>{job.product} · {job.duration}h</div>
                                                {job.isRunning && (
                                                    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 800, color: RUNNING_GREEN_DARK, letterSpacing: "0.05em", marginTop: 2 }}>
                                                        <span className="ps-running-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: RUNNING_GREEN, flexShrink: 0 }} />
                                                        RUNNING · not scheduled yet
                                                    </div>
                                                )}
                                                {job.ncFileName && (
                                                    <div style={{ fontSize: 9.5, color: "#1B6E8C", marginTop: 2, display: "flex", alignItems: "center", gap: 3 }}>
                                                        <Upload size={9} /> {job.ncSource === "comment" ? "from NC header" : "estimated"}
                                                    </div>
                                                )}
                                                {job.tools && job.tools.length > 0 && (
                                                    <div style={{ fontSize: 9.5, color: "#595959", marginTop: 2, display: "flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
                                                        <Wrench size={9} />
                                                        {job.tools[0].name}
                                                        {job.tools.length > 1 && ` +${job.tools.length - 1}`}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {poolJobs.length === 0 && <div style={styles.poolEmpty}>all jobs scheduled</div>}
                                </div>
                            </div>
                        </>
                    )}

                    {activeNav === "analytics" && (
                        <div className="ps-scroll" style={styles.analyticsWrap}>
                            <div style={styles.analyticsGrid}>
                                <div style={styles.analyticsCardWide}>
                                    <div style={styles.analyticsCardHeader}>
                                        <Gauge size={15} color="#1B6E8C" />
                                        <span style={styles.analyticsCardTitle}>Utilization overview</span>
                                    </div>
                                    <div style={styles.analyticsStatsRow}>
                                        <div style={styles.analyticsStat}>
                                            <span style={styles.analyticsStatValue}>{analyticsSummary.avgUtil}%</span>
                                            <span style={styles.analyticsStatLabel}>avg utilization</span>
                                        </div>
                                        <div style={styles.analyticsStat}>
                                            <span style={styles.analyticsStatValue}>{analyticsSummary.busiest ? analyticsSummary.busiest.name : "—"}</span>
                                            <span style={styles.analyticsStatLabel}>busiest resource</span>
                                        </div>
                                        <div style={styles.analyticsStat}>
                                            <span style={{ ...styles.analyticsStatValue, color: analyticsSummary.totalConflictJobs ? "#C4372E" : "#21A366" }}>{analyticsSummary.totalConflictJobs}</span>
                                            <span style={styles.analyticsStatLabel}>jobs in conflict</span>
                                        </div>
                                    </div>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
                                        {resources
                                            .slice()
                                            .sort((a, b) => (utilization[b.id] || 0) - (utilization[a.id] || 0))
                                            .map((r) => {
                                                const pct = utilization[r.id] || 0;
                                                const barColor = pct >= 85 ? "#F0625B" : pct >= 60 ? "#E8A33D" : "#21A366";
                                                return (
                                                    <div
                                                        key={r.id}
                                                        style={styles.utilRow}
                                                        onClick={() => {
                                                            setSelectedResourceId(r.id);
                                                            setSelectedJobId(null);
                                                        }}
                                                    >
                                                        <span style={styles.utilRowName}>{r.name}</span>
                                                        <div style={styles.utilRowTrack}>
                                                            <div style={{ ...styles.utilRowFill, width: `${pct}%`, background: barColor }} />
                                                        </div>
                                                        <span style={styles.utilRowPct}>{pct}%</span>
                                                    </div>
                                                );
                                            })}
                                    </div>
                                </div>

                                <div style={styles.analyticsCard}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                                        <div style={styles.analyticsCardHeader}>
                                            <ListChecks size={15} color="#1B6E8C" />
                                            <span style={styles.analyticsCardTitle}>Today's summary</span>
                                        </div>
                                        <button
                                            className="ps-zoombtn"
                                            title="Export today's summary to Excel"
                                            onClick={exportTodaySummaryExcel}
                                            style={{ ...styles.zoomBtn, width: "auto", padding: "0 10px", fontSize: 11, display: "flex", alignItems: "center", gap: 4, color: "#1B6E8C", borderColor: "#1B6E8C" }}
                                        >
                                            <FileSpreadsheet size={12} /> Export
                                        </button>
                                    </div>

                                    {/* Job count pills */}
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 10 }}>
                                        {[
                                            { label: "Total today", value: todaySummary.total, color: "#1B6E8C", bg: "#EBF4F8" },
                                            { label: "Done", value: todaySummary.done, color: "#21A366", bg: "#E8F6EE" },
                                            { label: "Running", value: todaySummary.running, color: JOB_RUNNING_GREEN, bg: "#E3F5E9" },
                                            { label: "Overdue", value: todaySummary.overdue, color: "#C4372E", bg: "#FDECEB" },
                                        ].map((s) => (
                                            <div key={s.label} style={{ background: s.bg, borderRadius: 6, padding: "7px 10px", display: "flex", flexDirection: "column", gap: 1 }}>
                                                <span style={{ fontSize: 20, fontWeight: 700, color: s.color, fontFamily: "'IBM Plex Mono',monospace", lineHeight: 1 }}>{s.value}</span>
                                                <span style={{ fontSize: 10, color: "#6E6E6E" }}>{s.label}</span>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Completion timing breakdown */}
                                    <div style={{ fontSize: 11, fontWeight: 600, color: "#595959", marginBottom: 6, paddingTop: 6, borderTop: "1px solid #E5E5E5" }}>
                                        Completed jobs timing
                                    </div>
                                    {todaySummary.completedWithTiming.length === 0 ? (
                                        <div style={styles.bottleneckEmpty}>
                                            <Clock size={14} color="#A0A0A0" />
                                            no completed jobs with timing data
                                        </div>
                                    ) : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                                            {/* summary row */}
                                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                                                {[
                                                    { label: "On time", value: todaySummary.onTimeCount, color: "#21A366", bg: "#E8F6EE" },
                                                    { label: "Early", value: todaySummary.earlyCount, color: "#1B6E8C", bg: "#EBF4F8" },
                                                    { label: "Delayed", value: todaySummary.delayedCount, color: "#C4372E", bg: "#FDECEB" },
                                                ].map((s) => (
                                                    <div key={s.label} style={{ background: s.bg, borderRadius: 4, padding: "3px 8px", display: "flex", alignItems: "center", gap: 4 }}>
                                                        <span style={{ fontSize: 12, fontWeight: 700, color: s.color, fontFamily: "'IBM Plex Mono',monospace" }}>{s.value}</span>
                                                        <span style={{ fontSize: 10, color: "#6E6E6E" }}>{s.label}</span>
                                                    </div>
                                                ))}
                                            </div>
                                            {todaySummary.delayedCount > 0 && (
                                                <div style={{ fontSize: 10.5, color: "#C4372E" }}>avg delay: <b>{Math.round(todaySummary.avgDelayMin)}min</b></div>
                                            )}
                                            {todaySummary.earlyCount > 0 && (
                                                <div style={{ fontSize: 10.5, color: "#1B6E8C" }}>avg early: <b>{Math.round(todaySummary.avgEarlyMin)}min</b></div>
                                            )}
                                            {/* per-job list */}
                                            <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4, maxHeight: 180, overflowY: "auto" }}>
                                                {todaySummary.completedWithTiming.map((j) => (
                                                    <div key={j.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 6px", borderRadius: 4, background: j.status === "delayed" ? "#FFF5F5" : j.status === "early" ? "#F0F8FF" : "#F5FBF7" }}>
                                                        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, fontWeight: 600, color: "#262626", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.name}</span>
                                                        <span style={{ fontSize: 9.5, color: "#8C8C8C", flexShrink: 0 }}>{(j.plannedH * 60).toFixed(0)}m→{(j.actualH * 60).toFixed(0)}m</span>
                                                        <span style={{
                                                            fontSize: 9, fontWeight: 700, flexShrink: 0, borderRadius: 3, padding: "1px 5px",
                                                            color: j.status === "delayed" ? "#C4372E" : j.status === "early" ? "#1B6E8C" : "#21A366",
                                                            background: j.status === "delayed" ? "#FDECEB" : j.status === "early" ? "#EBF4F8" : "#E8F6EE",
                                                        }}>
                                                            {j.status === "delayed" ? `+${j.diffMin}m` : j.status === "early" ? `${j.diffMin}m` : "✓"}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div style={styles.analyticsCardWide}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                                        <div style={styles.analyticsCardHeader}>
                                            <TrendingUp size={15} color="#4FA8C9" />
                                            <span style={styles.analyticsCardTitle}>Gantt summary</span>
                                        </div>
                                        <div style={{ display: "flex", gap: 6 }}>
                                            {["week", "month"].map((v) => (
                                                <button
                                                    key={v}
                                                    className="ps-zoombtn"
                                                    style={{
                                                        ...styles.zoomBtn,
                                                        width: "auto",
                                                        padding: "0 12px",
                                                        background: loadView === v ? "#1B6E8C" : "#FFFFFF",
                                                        color: loadView === v ? "#FFFFFF" : "#1B6E8C",
                                                        borderColor: loadView === v ? "#1B6E8C" : "#C8C8C8",
                                                    }}
                                                    onClick={() => setLoadView(v)}
                                                >
                                                    {v}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {loadView === "week" ? (
                                        <div style={{ overflowX: "auto" }}>
                                            <div style={styles.heatLegendRow}>
                                                <span style={styles.heatLegendLabel}>light load</span>
                                                <div style={styles.heatLegendBar} />
                                                <span style={styles.heatLegendLabel}>heavy load</span>
                                            </div>
                                            <div style={{ display: "grid", gridTemplateColumns: `140px repeat(${DAYS}, minmax(28px, 1fr))`, gap: 4, minWidth: 140 + DAYS * 30 }}>
                                                <div />
                                                {Array.from({ length: DAYS }).map((_, d) => {
                                                    const date = new Date(baseDate.getTime() + d * 86400000);
                                                    return (
                                                        <div key={d} style={styles.heatmapDayLabel}>
                                                            {date.toLocaleDateString("en-GB", DAY_ABBR_LOCALE)}
                                                        </div>
                                                    );
                                                })}
                                                {resources.flatMap((r) => [
                                                    <div key={r.id + "-label"} style={styles.heatmapRowLabel}>{r.name}</div>,
                                                    ...dailyLoad[r.id].map((hours, d) => {
                                                        const intensity = Math.min(1, hours / 16);
                                                        return (
                                                            <div
                                                                key={r.id + "-" + d}
                                                                title={`${r.name} · ${hours}h scheduled`}
                                                                style={{
                                                                    ...styles.heatmapCell,
                                                                    background: hours === 0 ? "#F5F5F5" : heatColor(intensity),
                                                                    color: hours === 0 ? "#6E6E6E" : intensity > 0.35 ? "#FFFFFF" : "#262626",
                                                                }}
                                                            >
                                                                {hours > 0 ? hours : ""}
                                                            </div>
                                                        );
                                                    }),
                                                ])}
                                            </div>
                                        </div>
                                    ) : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                            {resources.map((r) => {
                                                const total = dailyLoad[r.id].reduce((a, b) => a + b, 0);
                                                const pct = Math.min(100, Math.round((total / TOTAL_HOURS) * 100));
                                                return (
                                                    <div key={r.id} style={styles.utilRow}>
                                                        <span style={styles.utilRowName}>{r.name}</span>
                                                        <div style={styles.utilRowTrack}>
                                                            <div style={{ ...styles.utilRowFill, width: `${pct}%`, background: "#4FA8C9" }} />
                                                        </div>
                                                        <span style={styles.utilRowPct}>{total}h</span>
                                                    </div>
                                                );
                                            })}
                                            <div style={{ fontSize: 11, color: "#6E6E6E", marginTop: 2 }}>
                                                showing totals for the current {DAYS}-day scheduling window
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div style={styles.analyticsCard}>
                                    <div style={styles.analyticsCardHeader}>
                                        <PieChart size={15} color={JOB_RUNNING_GREEN} />
                                        <span style={styles.analyticsCardTitle}>Job status</span>
                                    </div>
                                    {jobs.length === 0 ? (
                                        <div style={styles.bottleneckEmpty}>
                                            <ListChecks size={16} color="#6E6E6E" />
                                            no jobs yet
                                        </div>
                                    ) : (
                                        <div style={styles.donutRow}>
                                            {(() => {
                                                const total = jobs.length;
                                                let cumulative = 0;
                                                const stops = JOB_STATUS_META.filter((m) => jobStatusBreakdown[m.key] > 0).map((m) => {
                                                    const startPct = (cumulative / total) * 100;
                                                    cumulative += jobStatusBreakdown[m.key];
                                                    const endPct = (cumulative / total) * 100;
                                                    return `${m.color} ${startPct}% ${endPct}%`;
                                                });
                                                return (
                                                    <div style={{ ...styles.donutChart, background: `conic-gradient(${stops.join(", ")})` }}>
                                                        <div style={styles.donutHole}>
                                                            <span style={styles.donutHoleValue}>{total}</span>
                                                            <span style={styles.donutHoleLabel}>jobs</span>
                                                        </div>
                                                    </div>
                                                );
                                            })()}
                                            <div style={styles.donutLegend}>
                                                {JOB_STATUS_META.filter((m) => jobStatusBreakdown[m.key] > 0).map((m) => (
                                                    <div key={m.key} style={styles.donutLegendRow}>
                                                        <span style={{ ...styles.legendDot, background: m.color }} />
                                                        <span style={styles.donutLegendLabel}>{m.label}</span>
                                                        <span style={styles.donutLegendValue}>{jobStatusBreakdown[m.key]}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div style={styles.analyticsCard}>
                                    <div style={styles.analyticsCardHeader}>
                                        <Package size={15} color="#1B6E8C" />
                                        <span style={styles.analyticsCardTitle}>Product mix</span>
                                    </div>
                                    {productMix.length === 0 ? (
                                        <div style={styles.bottleneckEmpty}>
                                            <Package size={16} color="#6E6E6E" />
                                            no jobs yet
                                        </div>
                                    ) : (
                                        <div style={styles.donutRow}>
                                            {(() => {
                                                const total = productMix.reduce((s, p) => s + p.hours, 0) || 1;
                                                let cumulative = 0;
                                                const stops = productMix.map((p) => {
                                                    const startPct = (cumulative / total) * 100;
                                                    cumulative += p.hours;
                                                    const endPct = (cumulative / total) * 100;
                                                    return `${p.color} ${startPct}% ${endPct}%`;
                                                });
                                                return (
                                                    <div style={{ ...styles.donutChart, background: `conic-gradient(${stops.join(", ")})` }}>
                                                        <div style={styles.donutHole}>
                                                            <span style={styles.donutHoleValue}>{total.toFixed(0)}h</span>
                                                            <span style={styles.donutHoleLabel}>total</span>
                                                        </div>
                                                    </div>
                                                );
                                            })()}
                                            <div style={styles.donutLegend}>
                                                {productMix.map((p) => (
                                                    <div key={p.product} style={styles.donutLegendRow}>
                                                        <span style={{ ...styles.legendDot, background: p.color }} />
                                                        <span style={styles.donutLegendLabel}>{p.product}</span>
                                                        <span style={styles.donutLegendValue}>{p.count}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div style={styles.analyticsCardWide}>
                                    <div style={styles.analyticsCardHeader}>
                                        <Layers size={15} color="#4FA8C9" />
                                        <span style={styles.analyticsCardTitle}>Utilization by resource type</span>
                                    </div>
                                    {resourceTypeUtil.length === 0 ? (
                                        <div style={styles.bottleneckEmpty}>
                                            <Layers size={16} color="#6E6E6E" />
                                            no resources yet
                                        </div>
                                    ) : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                            {resourceTypeUtil.map((t) => {
                                                const barColor = t.avg >= 85 ? "#F0625B" : t.avg >= 60 ? "#E8A33D" : "#21A366";
                                                return (
                                                    <div key={t.type} style={styles.utilRow}>
                                                        <span style={{ ...styles.utilRowName, width: 130 }}>
                                                            {t.type} <span style={{ color: "#ABABAB" }}>· {t.count}</span>
                                                        </span>
                                                        <div style={styles.utilRowTrack}>
                                                            <div style={{ ...styles.utilRowFill, width: `${t.avg}%`, background: barColor }} />
                                                        </div>
                                                        <span style={styles.utilRowPct}>{t.avg}%</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeNav === "tools" && (
                        <div className="ps-scroll" style={styles.analyticsWrap}>
                            <div style={{ maxWidth: 1100, margin: "0 auto" }}>
                                {toolSummary.length === 0 ? (
                                    <div style={styles.bottleneckEmpty}>
                                        <Wrench size={16} color="#6E6E6E" />
                                        No tool data yet — import an NC file with TOOL comments to see a summary here
                                    </div>
                                ) : (
                                    <>
                                        {nearEndOfLifeTools.length > 0 && (
                                            <div style={styles.eolCard}>
                                                <div style={styles.eolCardHeader}>
                                                    <AlertOctagon size={15} color={ALARM_RED_DARK} />
                                                    <span style={styles.analyticsCardTitle}>Near end of life — replace soon ({nearEndOfLifeTools.length})</span>
                                                </div>
                                                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                                    {nearEndOfLifeTools.map((t) => {
                                                        const key = toolKey(t);
                                                        const critical = t.lifePct >= 100;
                                                        return (
                                                            <div
                                                                key={key}
                                                                style={styles.eolRow}
                                                                onClick={() => {
                                                                    setToolsJobFilter("all");
                                                                    setSelectedToolKey(key);
                                                                }}
                                                            >
                                                                <Wrench size={12} color={critical ? ALARM_RED_DARK : "#B45309"} style={{ flexShrink: 0 }} />
                                                                <span style={styles.toolRowName}>{t.number ? `T${t.number} · ` : ""}{t.name}</span>
                                                                <div style={styles.eolTrack}>
                                                                    <div style={{ height: "100%", width: `${t.lifePct}%`, borderRadius: 4, background: critical ? ALARM_RED : OVERDUE_AMBER_BORDER }} />
                                                                </div>
                                                                <span
                                                                    style={{
                                                                        ...styles.bottleneckBadge,
                                                                        color: critical ? ALARM_RED_DARK : "#B45309",
                                                                        borderColor: critical ? "#F7CFCB" : "#F3DDAE",
                                                                        background: critical ? "#FDECEB" : "#FCF0DC",
                                                                        flexShrink: 0,
                                                                    }}
                                                                >
                                                                    {critical ? "Expired" : `${t.lifePct.toFixed(0)}%`}
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}

                                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                                            <label style={{ fontSize: 11.5, color: "#6E6E6E", flexShrink: 0 }}>Filter by job</label>
                                            <select
                                                className="ps-select"
                                                style={{ width: "auto", minWidth: 220 }}
                                                value={toolsJobFilter}
                                                onChange={(e) => {
                                                    setToolsJobFilter(e.target.value);
                                                    setSelectedToolKey(null);
                                                }}
                                            >
                                                <option value="all">All jobs ({toolSummary.length} tools)</option>
                                                {toolsJobOptions.map((j) => (
                                                    <option key={j.id} value={j.id}>{j.name} ({(j.tools || []).length} tools)</option>
                                                ))}
                                            </select>
                                            {toolsJobFilter !== "all" && (
                                                <button
                                                    className="ps-zoombtn"
                                                    style={{ ...styles.zoomBtn, width: "auto", padding: "0 10px" }}
                                                    onClick={() => {
                                                        setToolsJobFilter("all");
                                                        setSelectedToolKey(null);
                                                    }}
                                                >
                                                    clear filter
                                                </button>
                                            )}
                                            <button
                                                className="ps-zoombtn"
                                                style={{ ...styles.zoomBtn, width: "auto", padding: "0 12px", gap: 6, display: "flex", alignItems: "center", marginLeft: "auto" }}
                                                onClick={exportToolsExcel}
                                                title="export tool usage as Excel"
                                            >
                                                <FileSpreadsheet size={13} /> Excel
                                            </button>
                                        </div>

                                        {visibleToolSummary.length === 0 ? (
                                            <div style={styles.bottleneckEmpty}>No tools found for this job</div>
                                        ) : (
                                        <>
                                        <div style={styles.toolsLayout}>
                                            <div style={styles.toolsSidebar} className="ps-scroll">
                                                {visibleToolSummary.map((t) => {
                                                    const key = toolKey(t);
                                                    const active = selectedTool && toolKey(selectedTool) === key;
                                                    const usedHours = t.actualHours + t.liveHours;
                                                    const refLife = t.maxLife || TOOL_LIFE_HOURS;
                                                    const lifePct = Math.min(100, (usedHours / refLife) * 100);
                                                    const lifeOver = usedHours > refLife;
                                                    return (
                                                        <div
                                                            key={key}
                                                            className="ps-tool-sidebar-item"
                                                            onClick={() => setSelectedToolKey(key)}
                                                            style={{
                                                                ...styles.toolsSidebarItem,
                                                                background: active ? "#E3F0FB" : "transparent",
                                                                borderLeft: active ? `3px solid ${DONE_BLUE}` : "3px solid transparent",
                                                            }}
                                                        >
                                                            <Wrench size={13} color={active ? DONE_BLUE : "#6E6E6E"} style={{ flexShrink: 0 }} />
                                                            <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 3 }}>
                                                                <span style={{ ...styles.toolsSidebarName, color: active ? "#262626" : "#404040" }}>
                                                                    {t.number ? `T${t.number} · ` : ""}{t.name}
                                                                </span>
                                                                <span style={styles.toolsSidebarSub}>{t.jobs.length} job{t.jobs.length !== 1 ? "s" : ""}</span>
                                                                <div style={{ height: 4, background: "#E1E1E1", borderRadius: 3, overflow: "hidden" }}>
                                                                    <div style={{ height: "100%", width: `${lifePct}%`, borderRadius: 3, background: lifeOver ? "#F0625B" : lifePct > 75 ? "#E8A33D" : "#21A366" }} />
                                                                </div>
                                                            </div>
                                                            {t.liveHours > 0 && <span className="ps-running-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: RUNNING_GREEN, flexShrink: 0 }} />}
                                                            <span style={{ ...styles.toolsSidebarHours, color: lifeOver ? "#C4372E" : "#262626" }}>{usedHours.toFixed(1)}h</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>

                                            <div style={styles.toolsRightCol}>
                                            <div style={styles.toolsDetail}>
                                                {selectedTool ? (
                                                    (() => {
                                                        const t = selectedTool;
                                                        const usedHours = t.actualHours + t.liveHours;
                                                        const pct = t.estHours > 0 ? Math.min(100, (usedHours / t.estHours) * 100) : 0;
                                                        const overEstimate = t.estHours > 0 && usedHours > t.estHours;
                                                        const refLife = t.maxLife || TOOL_LIFE_HOURS;
                                                        const lifePct = Math.min(100, (usedHours / refLife) * 100);
                                                        const lifeOver = usedHours > refLife;
                                                        return (
                                                            <>
                                                                <div style={styles.qrCardHeader}>
                                                                    <Wrench size={16} color="#1B6E8C" />
                                                                    <span style={{ ...styles.qrJobName, fontSize: 15 }}>{t.number ? `T${t.number} · ` : ""}{t.name}</span>
                                                                    {t.liveHours > 0 && (
                                                                        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: RUNNING_GREEN }}>
                                                                            <span className="ps-running-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: RUNNING_GREEN }} />
                                                                            Running now
                                                                        </span>
                                                                    )}
                                                                </div>

                                                                <div style={styles.analyticsStatsRow}>
                                                                    <div style={styles.analyticsStat}>
                                                                        <span style={styles.analyticsStatValue}>{t.estHours.toFixed(1)}h</span>
                                                                        <span style={styles.analyticsStatLabel}>Estimated</span>
                                                                    </div>
                                                                    <div style={styles.analyticsStat}>
                                                                        <span style={{ ...styles.analyticsStatValue, color: overEstimate ? "#C4372E" : "#262626" }}>{usedHours.toFixed(1)}h</span>
                                                                        <span style={styles.analyticsStatLabel}>Actual used</span>
                                                                    </div>
                                                                    <div style={styles.analyticsStat}>
                                                                        <span style={styles.analyticsStatValue}>{t.jobs.length}</span>
                                                                        <span style={styles.analyticsStatLabel}>Active jobs</span>
                                                                    </div>
                                                                </div>

                                                                <div style={styles.toolsBarsGrid}>
                                                                    <div>
                                                                        <label style={styles.fieldLabel}>vs estimate</label>
                                                                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                                                                            <div style={{ flex: 1, height: 8, background: "#E1E1E1", borderRadius: 2, overflow: "hidden" }}>
                                                                                <div
                                                                                    style={{
                                                                                        height: "100%",
                                                                                        width: `${pct}%`,
                                                                                        borderRadius: 2,
                                                                                        background: overEstimate ? "#F0625B" : t.liveHours > 0 ? RUNNING_GREEN : "#21A366",
                                                                                    }}
                                                                                />
                                                                            </div>
                                                                            <span style={{ fontSize: 11, color: "#6E6E6E", flexShrink: 0 }}>{pct.toFixed(0)}%</span>
                                                                        </div>
                                                                    </div>
                                                                    <div>
                                                                        <label style={styles.fieldLabel}>tool life (max {refLife.toFixed(1)}h)</label>
                                                                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                                                                            <div style={{ flex: 1, height: 8, background: "#E1E1E1", borderRadius: 2, overflow: "hidden" }}>
                                                                                <div style={{ height: "100%", width: `${lifePct}%`, borderRadius: 2, background: lifeOver ? "#F0625B" : lifePct > 75 ? "#E8A33D" : "#21A366" }} />
                                                                            </div>
                                                                            <span style={{ fontSize: 11, color: lifeOver ? "#C4372E" : "#6E6E6E", fontWeight: lifeOver ? 700 : 400, flexShrink: 0, whiteSpace: "nowrap" }}>
                                                                                {lifePct.toFixed(0)}%{lifeOver ? " — replace" : ""}
                                                                            </span>
                                                                        </div>
                                                                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                                                                            <label style={{ ...styles.fieldLabel, marginBottom: 0, flexShrink: 0 }}>Set max life (h):</label>
                                                                            <input
                                                                                type="number" min="0.1" step="0.5"
                                                                                defaultValue={t.maxLife || TOOL_LIFE_HOURS}
                                                                                key={toolKey(t)}
                                                                                style={{ width: 72, fontSize: 12, padding: "3px 6px", border: "1px solid #C8C8C8", borderRadius: 4, background: "#FAFAFA" }}
                                                                                onBlur={(e) => { const val = parseFloat(e.target.value); if (!isNaN(val) && val > 0) updateToolMaxLife(t, val); }}
                                                                                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                                                                            />
                                                                            <span style={{ fontSize: 11, color: "#8C8C8C" }}>hours</span>
                                                                        </div>
                                                                    </div>
                                                                </div>

                                                                <label style={styles.fieldLabel}>jobs using this tool</label>
                                                                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 4 }}>
                                                                    {t.jobs.map((j, i) => (
                                                                        <div
                                                                            key={j.id + i}
                                                                            style={styles.toolRow}
                                                                            onClick={() => {
                                                                                setActiveNav("schedule");
                                                                                const found = jobs.find((jj) => jj.id === j.id);
                                                                                if (found) jumpToJob(found);
                                                                            }}
                                                                        >
                                                                            <span style={{ ...styles.legendDot, background: PRODUCTS[jobs.find((jj) => jj.id === j.id)?.product] || "#6E6E6E" }} />
                                                                            <span style={styles.toolRowName}>{j.name}</span>
                                                                            <span style={styles.toolRowHours}>
                                                                                {(j.actualHours + j.liveHours) >= 0.1 ? `${(j.actualHours + j.liveHours).toFixed(1)}h` : "<0.1h"} / {j.estHours.toFixed(1)}h
                                                                            </span>
                                                                        </div>
                                                                    ))}
                                                                    {t.jobs.length === 0 && t.historicalJobNames.length > 0 && (
                                                                        <div style={{ fontSize: 10.5, color: "#6E6E6E", padding: "4px 8px" }}>
                                                                            Previously used in (deleted): {t.historicalJobNames.join(", ")}
                                                                        </div>
                                                                    )}
                                                                    {t.jobs.length === 0 && t.historicalJobNames.length === 0 && (
                                                                        <div style={{ fontSize: 10.5, color: "#6E6E6E", padding: "4px 8px" }}>No jobs currently use this tool</div>
                                                                    )}
                                                                </div>
                                                            </>
                                                        );
                                                    })()
                                                ) : (
                                                    <div style={styles.bottleneckEmpty}>Select a tool on the left to see details</div>
                                                )}
                                            </div>

                                            <div style={styles.analyticsCard}>
                                                <div style={styles.analyticsCardHeader}>
                                                    <BarChart3 size={15} color="#4FA8C9" />
                                                    <span style={styles.analyticsCardTitle}>Top tools by actual usage</span>
                                                </div>
                                                <div style={styles.barChartWrap} className="ps-scroll">
                                                    {(() => {
                                                        const maxHours = Math.max(0.1, ...topToolsByUsage.map((t) => t.usedHours));
                                                        return topToolsByUsage.map((t) => {
                                                            const key = toolKey(t);
                                                            const heightPct = Math.max(2, (t.usedHours / maxHours) * 100);
                                                            const over = t.usedHours > (t.maxLife || TOOL_LIFE_HOURS);
                                                            const active = selectedTool && toolKey(selectedTool) === key;
                                                            return (
                                                                <div
                                                                    key={key}
                                                                    style={styles.barChartCol}
                                                                    onClick={() => setSelectedToolKey(key)}
                                                                    title={`${t.number ? `T${t.number} · ` : ""}${t.name}: ${t.usedHours.toFixed(1)}h`}
                                                                >
                                                                    <span style={styles.barChartValue}>{t.usedHours.toFixed(1)}h</span>
                                                                    <div style={styles.barChartTrack}>
                                                                        <div
                                                                            style={{
                                                                                ...styles.barChartFill,
                                                                                height: `${heightPct}%`,
                                                                                background: over ? "#F0625B" : "#4FA8C9",
                                                                                boxShadow: active ? `0 0 0 2px ${DONE_BLUE}55` : "none",
                                                                            }}
                                                                        />
                                                                    </div>
                                                                    <span style={styles.barChartLabel}>{t.number ? `T${t.number}` : t.name.slice(0, 6)}</span>
                                                                </div>
                                                            );
                                                        });
                                                    })()}
                                                    {topToolsByUsage.length === 0 && <div style={styles.bottleneckEmpty}>No usage data yet</div>}
                                                </div>
                                            </div>
                                            </div>
                                        </div>
                                        </>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                    {activeNav === "qrcodes" && (
                        <div className="ps-scroll" style={styles.analyticsWrap}>
                            <div style={{ maxWidth: 1100, margin: "0 auto" }}>

                                {/* ── STEP 1: Machine bind QR ─────────────────────────────── */}
                                <div style={{ ...styles.qrIntro, background: "#EFF6FF", borderColor: "#BFDBFE" }}>
                                    <Cpu size={16} color="#1D4ED8" />
                                    <span style={{ color: "#1D4ED8" }}>
                                        <b>Step 1</b> — Scan machine QR to lock which machine you are working on, then scan the job QR
                                    </span>
                                </div>
                                <div style={styles.qrGrid}>
                                    {resources.map((r) => {
                                        const origin = typeof window !== "undefined" ? window.location.origin : "";
                                        const bindUrl = `${origin}/?bind=resource&resource=${r.id}`;
                                        const bindImg = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(bindUrl)}`;
                                        const meta = STATUS_META[r.status];
                                        return (
                                            <div key={r.id} style={{ ...styles.qrCard, borderColor: "#BFDBFE" }}>
                                                <div style={styles.qrCardHeader}>
                                                    <meta.Icon size={13} color="#1D4ED8" />
                                                    <span style={styles.qrJobName}>{r.name}</span>
                                                </div>
                                                <div style={styles.qrResourceName}>{r.type}</div>
                                                <div style={styles.qrImages}>
                                                    <div style={styles.qrImageBlock}>
                                                        <img src={bindImg} alt={`bind ${r.name}`} style={styles.qrImage} />
                                                        <div style={{ ...styles.qrLabel, color: "#1D4ED8" }}>
                                                            <Cpu size={11} /> BIND
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {resources.length === 0 && (
                                        <div style={styles.bottleneckEmpty}>No machines in system</div>
                                    )}
                                </div>

                                {/* ── STEP 2: Job QR ──────────────────────────────────────── */}
                                <div style={{ ...styles.qrIntro, marginTop: 24 }}>
                                    <QrCode size={16} color="#1B6E8C" />
                                    <span>
                                        <b>Step 2</b> — Scan START to begin / STOP to finish — system will verify job matches selected machine
                                    </span>
                                </div>
                                <div style={styles.qrGrid}>
                                    {scheduledJobs.map((job) => {
                                        const origin = typeof window !== "undefined" ? window.location.origin : "";
                                        const startUrl = `${origin}/?scan=start&job=${job.id}`;
                                        const stopUrl = `${origin}/?scan=stop&job=${job.id}`;
                                        const startImg = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(startUrl)}`;
                                        const stopImg = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(stopUrl)}`;
                                        const res = resources.find((r) => r.id === job.resourceId);
                                        return (
                                            <div key={job.id} style={styles.qrCard}>
                                                <div style={styles.qrCardHeader}>
                                                    <span style={{ ...styles.legendDot, background: PRODUCTS[job.product] }} />
                                                    <span style={styles.qrJobName}>{job.name}</span>
                                                    {job.isRunning && <span style={styles.qrRunningBadge}>running</span>}
                                                </div>
                                                <div style={styles.qrResourceName}>{res ? res.name : "unassigned"}</div>
                                                <div style={styles.qrImages}>
                                                    <div style={styles.qrImageBlock}>
                                                        <img src={startImg} alt={`start ${job.name}`} style={styles.qrImage} />
                                                        <div style={{ ...styles.qrLabel, color: "#21A366" }}>
                                                            <Play size={11} /> START
                                                        </div>
                                                    </div>
                                                    <div style={styles.qrImageBlock}>
                                                        <img src={stopImg} alt={`stop ${job.name}`} style={styles.qrImage} />
                                                        <div style={{ ...styles.qrLabel, color: "#C4372E" }}>
                                                            <Square size={11} /> STOP
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {scheduledJobs.length === 0 && (
                                        <div style={styles.bottleneckEmpty}>No scheduled jobs yet</div>
                                    )}
                                </div>

                                <div style={{ ...styles.qrIntro, marginTop: 24, borderColor: "#F7CFCB", background: "#FEF6F5" }}>
                                    <AlertOctagon size={16} color={ALARM_RED_DARK} />
                                    <span>
                                        Scan ALARM to report a machine issue · Scan CLEAR to resolve — print and attach to each machine
                                    </span>
                                </div>
                                <div style={styles.qrGrid}>
                                    {resources.map((r) => {
                                        const origin = typeof window !== "undefined" ? window.location.origin : "";
                                        const alarmUrl = `${origin}/?alarm=raise&resource=${r.id}`;
                                        const clearUrl = `${origin}/?alarm=clear&resource=${r.id}`;
                                        const alarmImg = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(alarmUrl)}`;
                                        const clearImg = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(clearUrl)}`;
                                        const meta = STATUS_META[r.status];
                                        return (
                                            <div key={r.id} style={styles.qrCard}>
                                                <div style={styles.qrCardHeader}>
                                                    <meta.Icon size={13} color={meta.color} />
                                                    <span style={styles.qrJobName}>{r.name}</span>
                                                    {r.alarmActive && <span style={styles.qrAlarmBadge}>alarm</span>}
                                                </div>
                                                <div style={styles.qrResourceName}>{r.type}</div>
                                                <div style={styles.qrImages}>
                                                    <div style={styles.qrImageBlock}>
                                                        <img src={alarmImg} alt={`alarm ${r.name}`} style={styles.qrImage} />
                                                        <div style={{ ...styles.qrLabel, color: ALARM_RED_DARK }}>
                                                            <AlertOctagon size={11} /> ALARM
                                                        </div>
                                                    </div>
                                                    <div style={styles.qrImageBlock}>
                                                        <img src={clearImg} alt={`clear ${r.name}`} style={styles.qrImage} />
                                                        <div style={{ ...styles.qrLabel, color: "#21A366" }}>
                                                            <CheckCircle2 size={11} /> CLEAR
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {resources.length === 0 && (
                                        <div style={styles.bottleneckEmpty}>No machines in system</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeNav === "shifts" && (
                        <div className="ps-scroll" style={styles.analyticsWrap}>
                            <div style={{ maxWidth: 900, margin: "0 auto" }}>
                                <div style={styles.shiftIntroCard}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                            <div style={styles.shiftIntroIcon}>
                                                <Clock size={14} color="#1B6E8C" />
                                            </div>
                                            <div style={styles.shiftIntroTitle}>Shift Settings</div>
                                        </div>
                                        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                                            <button className="ps-zoombtn" style={{ ...styles.zoomBtn, width: "auto", padding: "0 12px", gap: 6, display: "flex", alignItems: "center" }} onClick={resetShiftsToDefault}>
                                                <RotateCcw size={13} /> Reset
                                            </button>
                                            <button className="ps-addbtn" style={{ ...styles.addJobBtn, marginBottom: 0, display: "flex", alignItems: "center", gap: 5 }} onClick={addShift}>
                                                <Plus size={13} /> Add shift
                                            </button>
                                        </div>
                                    </div>

                                    {shiftConfig.length > 0 && (
                                        <>
                                            <div style={styles.shiftTimelineRuler}>
                                                {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
                                                    <span key={h} style={{ ...styles.shiftTimelineTick, left: `${(h / 24) * 100}%` }}>
                                                        {String(h % 24).padStart(2, "0")}:00
                                                    </span>
                                                ))}
                                            </div>
                                            <div style={styles.shiftTimelineTrack}>
                                                {shiftDaySegments.flatMap((shift) =>
                                                    shift.segments.map((seg, si) => (
                                                        <div
                                                            key={shift.id + "-" + si}
                                                            title={`${shift.name} ${hourToTimeInput(shift.start)}–${hourToTimeInput(shift.end)}`}
                                                            style={{
                                                                position: "absolute",
                                                                left: `${(seg.start / 24) * 100}%`,
                                                                width: `${((seg.end - seg.start) / 24) * 100}%`,
                                                                top: 0,
                                                                bottom: 0,
                                                                background: shift.color,
                                                                opacity: 0.9,
                                                                mixBlendMode: "multiply",
                                                            }}
                                                        />
                                                    ))
                                                )}
                                                {nowHour >= 0 && nowHour < 24 && (
                                                    <div style={{ ...styles.shiftTimelineNow, left: `${(nowHour / 24) * 100}%` }} title="Now" />
                                                )}
                                            </div>

                                            <div style={styles.shiftStatsRow}>
                                                <div style={styles.shiftStatItem}>
                                                    <span style={styles.shiftStatValue}>{shiftCoverage.coveredHours.toFixed(1)}h</span>
                                                    <span style={styles.shiftStatLabel}>Covered</span>
                                                </div>
                                                <div style={styles.shiftStatItem}>
                                                    <span style={{ ...styles.shiftStatValue, color: shiftCoverage.gapHours > 0 ? OVERDUE_AMBER : "#262626" }}>{shiftCoverage.gapHours.toFixed(1)}h</span>
                                                    <span style={styles.shiftStatLabel}>Gap</span>
                                                </div>
                                                <div style={styles.shiftStatItem}>
                                                    <span style={{ ...styles.shiftStatValue, color: shiftCoverage.overlapHours > 0 ? "#C4372E" : "#262626" }}>{shiftCoverage.overlapHours.toFixed(1)}h</span>
                                                    <span style={styles.shiftStatLabel}>Overlap</span>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>

                                {shiftConfig.length === 0 && (
                                    <div style={styles.shiftEmptyState}>
                                        <Clock size={20} color="#6E6E6E" />
                                        <div style={{ fontSize: 12.5, color: "#404040", fontWeight: 600 }}>No shifts yet</div>
                                    </div>
                                )}

                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    {shiftConfig.map((s) => {
                                        const overlapping = shiftOverlapIds.has(s.id);
                                        const duration = shiftDurationHours(s);
                                        const wraps = s.end <= s.start;
                                        return (
                                            <div
                                                key={s.id}
                                                style={{
                                                    ...styles.shiftCard,
                                                    ...(overlapping ? styles.shiftCardOverlap : {}),
                                                    borderLeft: `4px solid ${s.color}`,
                                                }}
                                            >
                                                <div style={styles.shiftCardRow}>
                                                    <label style={styles.shiftColorSwatchWrap} title="Change color">
                                                        <input
                                                            type="color"
                                                            value={s.color}
                                                            onChange={(e) => updateShift(s.id, { color: e.target.value })}
                                                            style={styles.shiftColorInputHidden}
                                                        />
                                                        <span style={{ ...styles.shiftColorSwatch, background: s.color }} />
                                                    </label>
                                                    <input
                                                        className="ps-input"
                                                        style={styles.shiftNameInput}
                                                        value={s.name}
                                                        onChange={(e) => updateShift(s.id, { name: e.target.value })}
                                                        placeholder="Shift name"
                                                    />
                                                    <input
                                                        type="time"
                                                        className="ps-input"
                                                        style={styles.shiftTimeInputCompact}
                                                        value={hourToTimeInput(s.start)}
                                                        onChange={(e) => updateShift(s.id, { start: timeInputToHour(e.target.value) })}
                                                    />
                                                    <ArrowRight size={12} color="#ABABAB" style={{ flexShrink: 0 }} />
                                                    <input
                                                        type="time"
                                                        className="ps-input"
                                                        style={styles.shiftTimeInputCompact}
                                                        value={hourToTimeInput(s.end)}
                                                        onChange={(e) => updateShift(s.id, { end: timeInputToHour(e.target.value) })}
                                                    />
                                                    <span style={styles.shiftDurationBadge}>
                                                        {duration.toFixed(1)}h{wraps ? " · overnight" : ""}
                                                    </span>
                                                    {overlapping && (
                                                        <span style={styles.shiftOverlapBadge} title="Overlaps another shift">
                                                            <AlertTriangle size={11} /> Overlap
                                                        </span>
                                                    )}
                                                    <button
                                                        style={{ ...styles.panelClose, marginLeft: "auto" }}
                                                        onClick={() =>
                                                            requestConfirm({
                                                                title: "Delete shift?",
                                                                message: `"${s.name}" and its ${s.breaks.length} break${s.breaks.length !== 1 ? "s" : ""} will be removed. This can't be undone.`,
                                                                confirmLabel: "Delete shift",
                                                                danger: true,
                                                                onConfirm: () => deleteShift(s.id),
                                                            })
                                                        }
                                                        title="Delete shift"
                                                    >
                                                        <Trash2 size={14} color="#C4372E" />
                                                    </button>
                                                </div>

                                                <div style={styles.shiftBreaksSection}>
                                                    <div style={styles.shiftBreaksHeader}>
                                                        <Coffee size={12} color="#6E6E6E" />
                                                        <span style={styles.shiftBreaksLabel}>Breaks ({s.breaks.length})</span>
                                                        <button style={styles.shiftAddBreakBtn} onClick={() => addBreak(s.id)}>
                                                            <Plus size={11} /> Add break
                                                        </button>
                                                    </div>

                                                    {s.breaks.length > 0 && (
                                                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                                                            {s.breaks.map((b) => (
                                                                <div key={b.id} style={styles.shiftBreakRow}>
                                                                    <Coffee size={11} color="#B45309" style={{ flexShrink: 0 }} />
                                                                    <input
                                                                        className="ps-input"
                                                                        style={styles.shiftBreakLabelInput}
                                                                        value={b.label}
                                                                        onChange={(e) => updateBreak(s.id, b.id, { label: e.target.value })}
                                                                        placeholder="Break name"
                                                                    />
                                                                    <input
                                                                        type="time"
                                                                        className="ps-input"
                                                                        style={styles.shiftBreakTimeInput}
                                                                        value={hourToTimeInput(b.start)}
                                                                        onChange={(e) => updateBreak(s.id, b.id, { start: timeInputToHour(e.target.value) })}
                                                                    />
                                                                    <span style={{ color: "#ABABAB", fontSize: 11 }}>–</span>
                                                                    <input
                                                                        type="time"
                                                                        className="ps-input"
                                                                        style={styles.shiftBreakTimeInput}
                                                                        value={hourToTimeInput(b.end)}
                                                                        onChange={(e) => updateBreak(s.id, b.id, { end: timeInputToHour(e.target.value) })}
                                                                    />
                                                                    <button style={styles.panelClose} onClick={() => deleteBreak(s.id, b.id)} title="Delete break">
                                                                        <X size={13} color="#C4372E" />
                                                                    </button>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeNav === "history" && (
                        <div className="ps-scroll" style={styles.analyticsWrap}>
                            <div style={{ maxWidth: 900, margin: "0 auto" }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                                    <div style={{ fontSize: 12.5, color: "#595959" }}>
                                        {auditLog.length} recent event{auditLog.length !== 1 ? "s" : ""} · tap any row for details
                                    </div>
                                    {auditLog.length > 0 && (
                                        <button
                                            className="ps-zoombtn"
                                            style={{ ...styles.zoomBtn, width: "auto", padding: "0 12px", gap: 6, display: "flex", alignItems: "center" }}
                                            onClick={() =>
                                                requestConfirm({
                                                    title: "Clear history?",
                                                    message: `All ${auditLog.length} event${auditLog.length !== 1 ? "s" : ""} will be removed for everyone. This can't be undone.`,
                                                    confirmLabel: "Clear history",
                                                    danger: true,
                                                    onConfirm: clearAuditLog,
                                                })
                                            }
                                        >
                                            <Trash2 size={13} /> clear
                                        </button>
                                    )}
                                </div>

                                {auditLog.length === 0 ? (
                                    <div style={styles.bottleneckEmpty}>
                                        <HistoryIcon size={16} color="#6E6E6E" />
                                        No activity recorded yet
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                        {auditLog
                                            .slice()
                                            .reverse()
                                            .map((entry) => {
                                                const meta = actionMeta(entry.action);
                                                const isOpen = selectedHistoryEntryId === entry.id;
                                                return (
                                                    <div key={entry.id}>
                                                        <div
                                                            style={{ ...styles.historyRow, ...(isOpen ? styles.historyRowOpen : {}) }}
                                                            onClick={() => setSelectedHistoryEntryId(isOpen ? null : entry.id)}
                                                        >
                                                            <div style={{ ...styles.historyIconWrap, background: `${meta.color}18` }}>
                                                                <meta.Icon size={13} color={meta.color} />
                                                            </div>
                                                            <span style={styles.historySummary}>{entry.summary}</span>
                                                            <span style={styles.historyActor}>{entry.actor}</span>
                                                            <span style={styles.historyTime}>{relativeTime(entry.at)}</span>
                                                            <ChevronRight size={13} color="#ABABAB" style={{ flexShrink: 0, transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.12s ease" }} />
                                                        </div>
                                                        {isOpen && renderHistoryDetail(entry)}
                                                    </div>
                                                );
                                            })}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {ghost && (
                        <div
                            style={{
                                position: "fixed",
                                left: ghost.x + 12,
                                top: ghost.y + 12,
                                zIndex: 999,
                                pointerEvents: "none",
                                background: "#FFFFFF",
                                border: `1px solid ${ghost.color}`,
                                borderRadius: 3,
                                padding: "6px 10px",
                                fontFamily: "'IBM Plex Mono',monospace",
                                fontSize: 11.5,
                                color: "#262626",
                                boxShadow: "0 8px 20px rgba(27,110,140,0.25)",
                            }}
                        >
                            {ghost.name}
                        </div>
                    )}

                    {lastMoveUndo && (
                        <div style={styles.undoPill}>
                            <span style={styles.undoPillText}>Moved {lastMoveUndo.jobName}</span>
                            <button style={styles.undoPillBtn} onClick={undoLastMove}>
                                Undo
                            </button>
                            <button style={styles.undoPillClose} onClick={() => setLastMoveUndo(null)} title="dismiss">
                                <X size={12} />
                            </button>
                        </div>
                    )}

                    {bulkSelectedIds.size > 0 && (
                        <div style={styles.bulkBar}>
                            <span style={styles.bulkBarCount}>{bulkSelectedIds.size} selected</span>
                            <div style={styles.bulkBarDivider} />
                            <button style={styles.bulkBarBtn} onClick={() => bulkShiftHours(-1)}><ChevronLeft size={12} />1h</button>
                            <button style={styles.bulkBarBtn} onClick={() => bulkShiftHours(1)}>1h<ChevronRight size={12} /></button>
                            <button style={styles.bulkBarBtn} onClick={() => bulkShiftHours(-24)}>-1d</button>
                            <button style={styles.bulkBarBtn} onClick={() => bulkShiftHours(24)}>+1d</button>
                            <select
                                className="ps-select"
                                style={{ width: "auto", minWidth: 150 }}
                                defaultValue=""
                                onChange={(e) => {
                                    if (e.target.value) bulkMoveToResource(e.target.value);
                                    e.target.value = "";
                                }}
                            >
                                <option value="" disabled>move to resource...</option>
                                {resources.map((r) => (
                                    <option key={r.id} value={r.id}>{r.name}</option>
                                ))}
                            </select>
                            {bulkSelectedIds.size === 2 && (
                                <button
                                    style={{ ...styles.bulkBarBtn, opacity: canManualLinkSelection() ? 1 : 0.4, cursor: canManualLinkSelection() ? "pointer" : "not-allowed" }}
                                    onClick={openManualLinkPrompt}
                                    disabled={!canManualLinkSelection()}
                                    title={canManualLinkSelection() ? "Link these two jobs with a changeover time" : "Both jobs must be scheduled on the same resource to link"}
                                >
                                    <Link2 size={12} /> link
                                </button>
                            )}
                            <button
                                style={styles.bulkBarDeleteBtn}
                                onClick={() =>
                                    requestConfirm({
                                        title: "Delete selected jobs?",
                                        message: `${bulkSelectedIds.size} job${bulkSelectedIds.size !== 1 ? "s" : ""} will be permanently removed. This can't be undone.`,
                                        confirmLabel: "Delete jobs",
                                        danger: true,
                                        onConfirm: bulkDeleteSelected,
                                    })
                                }
                            >
                                <Trash2 size={12} /> delete
                            </button>
                            <button style={styles.bulkBarClearBtn} onClick={clearBulkSelection}>
                                <X size={14} />
                            </button>
                        </div>
                    )}


                    {activeNav === "settings" && (
                        <div className="ps-scroll" style={styles.analyticsWrap}>
                            <div style={{ maxWidth: 600, margin: "0 auto" }}>

                                {/* ── Override PIN ── */}
                                <div style={{ background: "#FFFFFF", border: "1px solid #E8E8E8", borderRadius: 4, padding: "24px 28px", marginBottom: 20 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                                        <Lock size={16} color="#1B6E8C" />
                                        <span style={{ fontWeight: 700, fontSize: 15, color: "#262626" }}>Override PIN</span>
                                    </div>
                                    <div style={{ fontSize: 12.5, color: "#6E6E6E", marginBottom: 20, lineHeight: 1.6 }}>
                                        4–8 digit PIN to authorize overriding a job to run on a different machine than planned
                                        <br />If no PIN is set, overrides require no confirmation
                                    </div>

                                    <OverridePinSettings
                                        currentPin={appConfig.overridePin || ""}
                                        onSave={(newPin) => {
                                            const next = { ...appConfig, overridePin: newPin };
                                            setAppConfig(next);
                                        }}
                                    />
                                </div>

                            </div>
                        </div>
                    )}

                    {selectedJob && (
                        <div style={styles.panel}>
                            <div style={styles.panelHeader}>
                                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#262626" }}>{selectedJob.name}</span>
                                <button style={styles.panelClose} onClick={() => setSelectedJobId(null)}>
                                    <X size={15} />
                                </button>
                            </div>

                            <label style={styles.fieldLabel}>job name</label>
                            <input
                                className="ps-input"
                                value={selectedJob.name}
                                onChange={(e) => updateJob(selectedJob.id, { name: e.target.value })}
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                spellCheck="false"
                                name="job-name-field"
                                data-lpignore="true"
                                data-1p-ignore="true"
                            />

                            <label style={styles.fieldLabel}>product family</label>
                            <select className="ps-select" value={selectedJob.product} onChange={(e) => updateJob(selectedJob.id, { product: e.target.value })}>
                                {Object.keys(PRODUCTS).map((p) => (
                                    <option key={p} value={p}>{p}</option>
                                ))}
                            </select>

                            <label style={styles.fieldLabel}>resource</label>
                            <select
                                className="ps-select"
                                value={selectedJob.resourceId || ""}
                                onChange={(e) => updateJob(selectedJob.id, { resourceId: e.target.value || null })}
                            >
                                <option value="">unscheduled</option>
                                {resources.map((r) => (
                                    <option key={r.id} value={r.id}>{r.name}</option>
                                ))}
                            </select>

                            <label style={styles.fieldLabel}>duration (hours)</label>
                            <input
                                className="ps-input"
                                type="number"
                                min={SNAP_HOURS}
                                step={SNAP_HOURS}
                                max={TOTAL_HOURS}
                                value={selectedJob.duration}
                                onChange={(e) => updateJob(selectedJob.id, { duration: Math.max(SNAP_HOURS, snapHours(Number(e.target.value) || SNAP_HOURS)) })}
                            />

                            {selectedJob.resourceId && (
                                <>
                                    <label style={styles.fieldLabel}>start time</label>
                                    <input
                                        className="ps-input"
                                        type="datetime-local"
                                        step={SNAP_HOURS * 3600}
                                        value={startHourToLocalInputValue(selectedJob.startHour)}
                                        onChange={(e) => handleStartTimeInputChange(selectedJob, e.target.value)}
                                    />
                                    <div style={{ fontSize: 11.5, color: "#6E6E6E", marginTop: 4, fontFamily: "'IBM Plex Mono',monospace" }}>
                                        starts {new Date(baseDate.getTime() + selectedJob.startHour * 3600000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                                    </div>
                                </>
                            )}

                            <label style={{ ...styles.fieldLabel, display: "flex", alignItems: "center", gap: 6, marginTop: 14 }}>
                                <input type="checkbox" checked={selectedJob.locked} onChange={(e) => updateJob(selectedJob.id, { locked: e.target.checked })} />
                                locked (cannot be dragged)
                            </label>

                            <div style={{ marginTop: 14 }}>
                                <label style={styles.fieldLabel}>Tool change sequence ({(selectedJob.toolChanges || []).length})</label>
                                {(selectedJob.toolChanges || []).length > 0 && (
                                    <div style={styles.toolSpanNote}>
                                        Tool time total: {toolChangesSpanHours(selectedJob.toolChanges).toFixed(2)}h · Job duration: {selectedJob.duration.toFixed(2)}h
                                    </div>
                                )}
                                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                    {(selectedJob.toolChanges || []).map((c, idx) => (
                                        <div
                                            key={c.id}
                                            draggable
                                            onDragStart={(e) => {
                                                setDraggedToolChangeIdx(idx);
                                                e.dataTransfer.effectAllowed = "move";
                                            }}
                                            onDragOver={(e) => e.preventDefault()}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                if (draggedToolChangeIdx !== null && draggedToolChangeIdx !== idx) {
                                                    reorderToolChanges(selectedJob.id, draggedToolChangeIdx, idx);
                                                }
                                                setDraggedToolChangeIdx(null);
                                            }}
                                            onDragEnd={() => setDraggedToolChangeIdx(null)}
                                            style={{
                                                ...styles.toolEditCard,
                                                opacity: draggedToolChangeIdx === idx ? 0.4 : 1,
                                                borderColor: draggedToolChangeIdx !== null && draggedToolChangeIdx !== idx ? "#1B6E8C55" : styles.toolEditCard.border,
                                            }}
                                        >
                                            <div style={styles.toolEditHeaderRow}>
                                                <Move size={12} color="#ABABAB" style={{ cursor: "grab", flexShrink: 0 }} title="Drag to reorder" />
                                                <span style={styles.toolChangeIndex}>#{idx + 1}</span>
                                                <input
                                                    className="ps-input"
                                                    style={styles.toolNumberInput}
                                                    placeholder="Tool #"
                                                    value={c.toolNumber || ""}
                                                    onChange={(e) => updateToolChange(selectedJob.id, c.id, { toolNumber: e.target.value })}
                                                />
                                                <input
                                                    className="ps-input"
                                                    style={styles.toolNameInput}
                                                    placeholder="Tool name"
                                                    value={c.toolName || ""}
                                                    onChange={(e) => updateToolChange(selectedJob.id, c.id, { toolName: e.target.value })}
                                                />
                                                <button style={styles.panelClose} onClick={() => removeToolChange(selectedJob.id, c.id)} title="Delete">
                                                    <Trash2 size={13} color="#C4372E" />
                                                </button>
                                            </div>
                                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                                                <span style={styles.segmentFieldLabel}>Start (min)</span>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    step={1}
                                                    className="ps-input"
                                                    style={styles.shiftBreakTimeInput}
                                                    value={c.startMin}
                                                    onChange={(e) => updateToolChange(selectedJob.id, c.id, { startMin: e.target.value })}
                                                    onBlur={() => updateToolChange(selectedJob.id, c.id, { startMin: Math.max(0, Number(c.startMin) || 0) })}
                                                />
                                                <span style={styles.segmentFieldLabel}>Duration (min)</span>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    step={1}
                                                    className="ps-input"
                                                    style={styles.shiftBreakTimeInput}
                                                    value={c.durationMin}
                                                    onChange={(e) => updateToolChange(selectedJob.id, c.id, { durationMin: e.target.value })}
                                                    onBlur={() => updateToolChange(selectedJob.id, c.id, { durationMin: Math.max(1, Number(c.durationMin) || 1) })}
                                                />
                                            </div>
                                        </div>
                                    ))}
                                    <button
                                        className="ps-addbtn"
                                        style={{ ...styles.addJobBtn, marginBottom: 0, display: "flex", alignItems: "center", gap: 5, width: "100%", justifyContent: "center" }}
                                        onClick={() => addToolChange(selectedJob.id)}
                                    >
                                        <Plus size={12} /> Add tool change
                                    </button>
                                </div>
                            </div>

                            {selectedJob.isRunning && (
                                <div style={styles.runningNote}>
                                    <CheckCircle2 size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    Job is currently running (last START scan)
                                </div>
                            )}

                            {!selectedJob.isRunning && selectedJob.completed && (
                                <div style={{ ...styles.runningNote, color: DONE_BLUE, background: "#E3F0FB", border: `1px solid ${DONE_BLUE}55` }}>
                                    <CheckCircle2 size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    Job completed{selectedJob.actualRunHours ? ` — actual run time ${selectedJob.actualRunHours.toFixed(1)}h` : ""}
                                </div>
                            )}

                            {!selectedJob.isRunning && !selectedJob.completed && !isJobBlocked(selectedJob) && selectedJob.resourceId && selectedJob.startHour + selectedJob.duration < nowHour && (
                                <div style={{ ...styles.runningNote, color: OVERDUE_AMBER, background: OVERDUE_AMBER_BG, border: `1px solid ${OVERDUE_AMBER_BORDER}` }}>
                                    <Clock size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    Past scheduled start — not yet scanned to start
                                </div>
                            )}

                            {isJobBlocked(selectedJob) && (
                                <div style={styles.alarmActiveNote}>
                                    <AlertOctagon size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    Machine has an active alarm — start/drag blocked until cleared
                                </div>
                            )}

                            {conflictIds.has(selectedJob.id) && (
                                <div style={styles.conflictNote}>
                                    <AlertTriangle size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    overlaps another job on this resource
                                </div>
                            )}

                            <button
                                style={styles.deleteBtn}
                                onClick={() =>
                                    requestConfirm({
                                        title: "Delete job?",
                                        message: `"${selectedJob.name}" will be permanently removed${selectedJob.tools && selectedJob.tools.length > 0 ? " along with its tool breakdown" : ""}. This can't be undone.`,
                                        confirmLabel: "Delete job",
                                        danger: true,
                                        onConfirm: () => deleteJob(selectedJob.id),
                                    })
                                }
                            >
                                <Trash2 size={13} style={{ marginRight: 6 }} />
                                delete job
                            </button>
                        </div>
                    )}

                    {selectedResource && (
                        <div style={styles.panel}>
                            <div style={styles.panelHeader}>
                                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#262626" }}>{selectedResource.name}</span>
                                <button style={styles.panelClose} onClick={() => setSelectedResourceId(null)}>
                                    <X size={15} />
                                </button>
                            </div>

                            <label style={styles.fieldLabel}>resource name</label>
                            <input
                                className="ps-input"
                                value={selectedResource.name}
                                onChange={(e) => updateResource(selectedResource.id, { name: e.target.value })}
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                spellCheck="false"
                                name="resource-name-field"
                                data-lpignore="true"
                                data-1p-ignore="true"
                            />

                            <label style={styles.fieldLabel}>type</label>
                            <input className="ps-input" value={selectedResource.type} onChange={(e) => updateResource(selectedResource.id, { type: e.target.value })} />

                            <label style={styles.fieldLabel}>status</label>
                            <select className="ps-select" value={selectedResource.status} onChange={(e) => updateResource(selectedResource.id, { status: e.target.value })}>
                                {Object.keys(STATUS_META).map((s) => (
                                    <option key={s} value={s}>{STATUS_META[s].label}</option>
                                ))}
                            </select>

                            <div style={{ fontSize: 11.5, color: "#6E6E6E", marginTop: 4, fontFamily: "'IBM Plex Mono',monospace" }}>
                                {utilization[selectedResource.id]}% booked this week
                            </div>

                            <label style={{ ...styles.fieldLabel, marginTop: 14 }}>alarm</label>
                            {selectedResource.alarmActive ? (
                                <div style={styles.alarmActiveNote}>
                                    <AlertOctagon size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    {ALARM_REASONS.find((a) => a.id === selectedResource.alarmReason)?.label || "Alarm"}
                                </div>
                            ) : (
                                <div style={{ fontSize: 11.5, color: "#6E6E6E" }}>No active alarm</div>
                            )}

                            {!selectedResource.alarmActive && (
                                <select
                                    className="ps-select"
                                    style={{ marginTop: 8 }}
                                    value={pendingAlarmReason}
                                    onChange={(e) => setPendingAlarmReason(e.target.value)}
                                >
                                    {ALARM_REASONS.map((a) => (
                                        <option key={a.id} value={a.id}>{a.label}</option>
                                    ))}
                                </select>
                            )}

                            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                                {selectedResource.alarmActive ? (
                                    <button style={styles.alarmClearBtn} onClick={() => clearAlarm(selectedResource.id)}>
                                        <CheckCircle2 size={13} style={{ marginRight: 6 }} />
                                        clear alarm
                                    </button>
                                ) : (
                                    <button className="ps-alarmraisebtn" style={styles.alarmRaiseBtn} onClick={() => raiseAlarm(selectedResource.id, pendingAlarmReason)}>
                                        <AlertOctagon size={13} style={{ marginRight: 6 }} />
                                        raise alarm
                                    </button>
                                )}
                            </div>

                            <button
                                style={styles.deleteBtn}
                                onClick={() => {
                                    const assignedCount = jobs.filter((j) => j.resourceId === selectedResource.id).length;
                                    requestConfirm({
                                        title: "Delete resource?",
                                        message: `"${selectedResource.name}" will be removed${assignedCount > 0 ? `. ${assignedCount} job${assignedCount !== 1 ? "s" : ""} on it will move back to unscheduled` : ""}. This can't be undone.`,
                                        confirmLabel: "Delete resource",
                                        danger: true,
                                        onConfirm: () => deleteResource(selectedResource.id),
                                    });
                                }}
                            >
                                <Trash2 size={13} style={{ marginRight: 6 }} />
                                delete resource
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {confirmDialog && (
                <div style={styles.confirmOverlay} onClick={() => setConfirmDialog(null)}>
                    <div style={styles.confirmCard} onClick={(e) => e.stopPropagation()}>
                        <div style={styles.confirmTitle}>{confirmDialog.title}</div>
                        <div style={styles.confirmMessage}>{confirmDialog.message}</div>
                        <div style={styles.confirmBtnRow}>
                            <button style={styles.confirmCancelBtn} onClick={() => setConfirmDialog(null)}>
                                Cancel
                            </button>
                            <button
                                style={confirmDialog.danger ? styles.confirmDangerBtn : styles.confirmOkBtn}
                                onClick={() => {
                                    confirmDialog.onConfirm();
                                    setConfirmDialog(null);
                                }}
                            >
                                {confirmDialog.confirmLabel || "Confirm"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {linkPrompt && (
                <div style={styles.confirmOverlay} onClick={cancelLinkPrompt}>
                    <div style={styles.confirmCard} onClick={(e) => e.stopPropagation()}>
                        <div style={styles.confirmTitle}>{linkPrompt.reason === "manual" ? "Link these jobs" : "Jobs collide"}</div>
                        <div style={styles.confirmMessage}>
                            {linkPrompt.reason === "manual"
                                ? `Enter a changeover time and "${linkPrompt.toJobName}" will be moved to start right after "${linkPrompt.fromJobName}" ends.`
                                : `"${linkPrompt.fromJobName}" and "${linkPrompt.toJobName}" now overlap on this resource. Enter a changeover time and they'll be linked back-to-back instead.`}
                        </div>
                        <div style={styles.linkPromptRow}>
                            <span style={styles.linkPromptJobName}>{linkPrompt.fromJobName}</span>
                            <ArrowRight size={14} color="#ABABAB" style={{ flexShrink: 0 }} />
                            <span style={styles.linkPromptJobName}>{linkPrompt.toJobName}</span>
                        </div>
                        <label style={styles.fieldLabel}>Changeover time (minutes)</label>
                        <input
                            className="ps-input"
                            type="number"
                            min={0}
                            step={1}
                            autoFocus
                            value={linkPrompt.changeoverMin}
                            onChange={(e) => setLinkPrompt((lp) => (lp ? { ...lp, changeoverMin: e.target.value } : lp))}
                            onBlur={() => setLinkPrompt((lp) => (lp ? { ...lp, changeoverMin: Math.max(0, Number(lp.changeoverMin) || 0) } : lp))}
                        />
                        <div style={styles.linkPromptHint}>The job is placed at exactly this gap - no rounding to the schedule grid</div>
                        <div style={styles.confirmBtnRow}>
                            <button style={styles.confirmCancelBtn} onClick={cancelLinkPrompt}>
                                {linkPrompt.revert ? "Cancel (revert)" : "Cancel"}
                            </button>
                            <button style={styles.confirmOkBtn} onClick={confirmLinkPrompt}>
                                Link jobs
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="ps-print-only">
                <div style={{ fontFamily: "'Segoe UI', sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 2 }}>Production Schedule Report</div>
                <div style={{ fontFamily: "'Segoe UI', 'Inter', sans-serif", fontSize: 11, color: "#595959", marginBottom: 16 }}>
                    {DAYS}-day window from {baseDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · generated {new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Segoe UI', 'Inter', sans-serif", fontSize: 11 }}>
                    <thead>
                        <tr>
                            {["Job", "Product", "Resource", "Start", "End", "Duration", "Status"].map((h) => (
                                <th key={h} style={{ textAlign: "left", borderBottom: "2px solid #262626", padding: "6px 8px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {jobs
                            .slice()
                            .sort((a, b) => {
                                const ra = resources.find((r) => r.id === a.resourceId)?.name || "zzz-unscheduled";
                                const rb = resources.find((r) => r.id === b.resourceId)?.name || "zzz-unscheduled";
                                return ra.localeCompare(rb) || a.startHour - b.startHour;
                            })
                            .map((j) => {
                                const res = resources.find((r) => r.id === j.resourceId);
                                const start = j.resourceId ? new Date(baseDate.getTime() + j.startHour * 3600000) : null;
                                const end = start ? new Date(start.getTime() + j.duration * 3600000) : null;
                                const status = j.isRunning ? "Running" : j.completed ? "Done" : conflictIds.has(j.id) ? "Conflict" : !j.resourceId ? "Unscheduled" : "Scheduled";
                                return (
                                    <tr key={j.id}>
                                        <td style={{ padding: "5px 8px", borderBottom: "1px solid #C8C8C8", fontFamily: "'IBM Plex Mono',monospace" }}>{j.name}</td>
                                        <td style={{ padding: "5px 8px", borderBottom: "1px solid #C8C8C8" }}>{j.product}</td>
                                        <td style={{ padding: "5px 8px", borderBottom: "1px solid #C8C8C8" }}>{res ? res.name : "—"}</td>
                                        <td style={{ padding: "5px 8px", borderBottom: "1px solid #C8C8C8" }}>{start ? start.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                                        <td style={{ padding: "5px 8px", borderBottom: "1px solid #C8C8C8" }}>{end ? end.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                                        <td style={{ padding: "5px 8px", borderBottom: "1px solid #C8C8C8" }}>{j.duration}h</td>
                                        <td style={{ padding: "5px 8px", borderBottom: "1px solid #C8C8C8" }}>{status}</td>
                                    </tr>
                                );
                            })}
                    </tbody>
                </table>
            </div>

        </div>
    );
}

const styles = {
    appShell: {
        display: "flex",
        flexDirection: "row",
        width: "100vw",
        height: "100vh",
        boxSizing: "border-box",
        overflow: "hidden",
    },
    floatCard: {
        display: "flex",
        flexDirection: "row",
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        position: "relative",
    },
    sidebar: {
        height: "100%",
        flexShrink: 0,
        background: "#EDEDED",
        display: "flex",
        flexDirection: "column",
        padding: "22px 14px",
        boxSizing: "border-box",
        borderRight: "1px solid #C8C8C8",
        zIndex: 70,
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
    },
    sidebarBrand: { display: "flex", alignItems: "center", gap: 10, marginBottom: 28, paddingLeft: 4 },
    sidebarLogo: {
        width: 32,
        height: 32,
        borderRadius: 3,
        background: "#262626",
        color: "#FFFFFF",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Segoe UI', sans-serif",
        fontWeight: 700,
        fontSize: 11.5,
        flexShrink: 0,
    },
    sidebarBrandText: { fontFamily: "'Segoe UI', sans-serif", fontWeight: 700, fontSize: 15, color: "#262626", letterSpacing: "0.01em" },
    sidebarNavGroup: {
        display: "flex",
        flexDirection: "column",
        gap: 4,
    },
    sidebarBtn: {
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        height: 40,
        borderRadius: 3,
        border: "none",
        padding: "0 12px",
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        fontSize: 13,
        textAlign: "left",
    },
    sidebarBtnLabel: { whiteSpace: "nowrap" },
    sidebarPromo: {
        marginTop: 18,
        background: "linear-gradient(160deg, #1B6E8C 0%, #155A73 100%)",
        border: "1px solid #0F4557",
        borderRadius: 4,
        padding: "16px 14px",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 10,
    },
    sidebarPromoIcon: {
        width: 34,
        height: 34,
        borderRadius: 3,
        background: "#FFFFFF",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    },
    sidebarPromoText: { fontSize: 12, color: "#EDEDED", lineHeight: 1.4 },
    sidebarPromoBtn: {
        width: "100%",
        background: "#262626",
        color: "#FFFFFF",
        border: "none",
        borderRadius: 3,
        padding: "8px 0",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    sidebarLogoutWrap: { marginTop: 10, paddingTop: 10, borderTop: "1px solid #C8C8C8" },
    sidebarLogoutBtn: {
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        height: 40,
        borderRadius: 3,
        border: "none",
        padding: "0 12px",
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        fontSize: 13,
        textAlign: "left",
        background: "transparent",
        color: "#6E6E6E",
    },
    app: {
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        background: "#F2F2F2",
        color: "#262626",
        overflow: "hidden",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        height: "100%",
        boxSizing: "border-box",
        marginLeft: 76,
    },
    toolbar: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "14px 18px",
        borderBottom: "1px solid #D9D9D9",
        background: "#FFFFFF",
        flexWrap: "wrap",
        gap: 10,
    },
    appTitle: { fontSize: 14, fontWeight: 600, letterSpacing: "0.01em", color: "#262626", fontFamily: "'Segoe UI', sans-serif" },
    appSub: { fontSize: 11.5, color: "#6E6E6E", fontFamily: "'IBM Plex Mono',monospace" },
    conflictBadge: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: "#B45309",
        background: "#FCF0DC",
        border: "1px solid #F3DDAE",
        borderRadius: 4,
        padding: "4px 10px",
        fontFamily: "'IBM Plex Mono',monospace",
    },
    focusExitBtn: {
        position: "absolute",
        top: 10,
        right: 14,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        background: "#262626",
        color: "#FFFFFF",
        border: "none",
        borderRadius: "50%",
        padding: 0,
        cursor: "pointer",
        boxShadow: "0 6px 16px rgba(38,38,38,0.3)",
        opacity: 0.85,
    },
    islandRow: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        margin: "10px 18px 16px",
        position: "sticky",
        top: 0,
        zIndex: 60,
        flexWrap: "wrap",
        // this row has no explicit width, so as a block-level div it stretches across the
        // full app content area (a transparent hitbox) even though only the pills are visible.
        // Being position:sticky with a higher z-index than the edit panel (50), that invisible
        // area sat on top of the panel's inputs and silently ate every click before it reached
        // them. pointer-events:none lets clicks fall through the empty space; the pills below
        // opt back in with pointer-events:auto so they stay clickable.
        pointerEvents: "none",
    },
    statusBar: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "fit-content",
        maxWidth: "calc(50% - 5px)",
        padding: "6px 10px",
        borderRadius: 4,
        background: "linear-gradient(135deg, #00D65E 0%, #00A844 100%)",
        flexWrap: "nowrap",
        pointerEvents: "auto",
    },
    statusBarLabel: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: 10.5,
        fontWeight: 700,
        color: "#FFFFFF",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        whiteSpace: "nowrap",
        flexShrink: 0,
        background: "rgba(255,255,255,0.2)",
        padding: "5px 9px 5px 7px",
        borderRadius: 4,
    },
    statusBarStrip: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        overflowX: "auto",
        minWidth: 0,
        paddingBottom: 1,
    },
    statusChip: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        flexShrink: 0,
        background: "#FFFFFF",
        border: "none",
        borderRadius: 4,
        padding: "4px 9px",
        cursor: "pointer",
        boxShadow: "0 2px 6px rgba(0,40,15,0.2)",
        transition: "box-shadow 0.15s ease, transform 0.15s ease",
    },
    statusChipDot: { width: 6, height: 6, borderRadius: "50%", background: "#00A844", flexShrink: 0 },
    statusChipResource: { fontSize: 11.5, fontWeight: 700, color: "#262626", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap", cursor: "pointer" },
    statusChipSep: { color: "#ABABAB", fontSize: 11 },
    statusChipJob: { fontSize: 11, color: "#595959", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" },
    alarmBar: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "fit-content",
        maxWidth: "calc(50% - 5px)",
        marginLeft: "auto",
        padding: "6px 10px",
        borderRadius: 4,
        background: "linear-gradient(135deg, #FF3B2E 0%, #D6180A 100%)",
        flexWrap: "nowrap",
        pointerEvents: "auto",
    },
    alarmBarLabel: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: 10.5,
        fontWeight: 700,
        color: "#FFFFFF",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        whiteSpace: "nowrap",
        flexShrink: 0,
        background: "rgba(255,255,255,0.2)",
        padding: "5px 9px 5px 7px",
        borderRadius: 4,
    },
    alarmChip: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        flexShrink: 0,
        background: "#FFFFFF",
        border: "none",
        borderRadius: 4,
        padding: "4px 5px 4px 9px",
        boxShadow: "0 2px 6px rgba(60,10,5,0.2)",
        transition: "box-shadow 0.15s ease, transform 0.15s ease",
    },
    alarmChipDot: { width: 6, height: 6, borderRadius: "50%", background: "#FF2D20", flexShrink: 0 },
    alarmChipReason: { fontSize: 11, color: "#8A4842", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" },
    alarmChipClear: {
        border: "none",
        background: "#FCEAE8",
        color: "#B23218",
        borderRadius: "50%",
        width: 18,
        height: 18,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        flexShrink: 0,
        marginLeft: 2,
        padding: 0,
        transition: "background 0.15s ease",
    },
    alarmMuteBtn: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        border: "none",
        background: "rgba(255,255,255,0.2)",
        color: "#FFFFFF",
        borderRadius: "50%",
        width: 24,
        height: 24,
        cursor: "pointer",
        padding: 0,
    },
    alarmUnlockBtn: {
        display: "flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        border: "none",
        background: "#FFFFFF",
        color: "#B23218",
        borderRadius: 4,
        padding: "4px 9px",
        fontSize: 10.5,
        fontWeight: 700,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        whiteSpace: "nowrap",
    },
    alarmActiveNote: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: ALARM_RED_DARK,
        background: "#FDECEB",
        border: "1px solid #F7CFCB",
        borderRadius: 4,
        padding: "8px 10px",
    },
    alarmRaiseBtn: {
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: ALARM_RED,
        color: "#FFFFFF",
        border: "none",
        borderRadius: 3,
        padding: "8px 10px",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    alarmClearBtn: {
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "1px solid #A8DDBB",
        color: "#187A3E",
        borderRadius: 3,
        padding: "8px 10px",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    qrAlarmBadge: {
        marginLeft: "auto",
        fontSize: 10,
        color: ALARM_RED_DARK,
        background: "#FDECEB",
        borderRadius: 4,
        padding: "2px 8px",
        fontFamily: "'IBM Plex Mono',monospace",
    },
    viewDaysGroup: {
        display: "flex",
        gap: 4,
        background: "#FFFFFF",
        border: "1px solid #C8C8C8",
        borderRadius: 4,
        padding: 3,
    },
    zoomBtn: {
        width: 28,
        height: 28,
        background: "#FFFFFF",
        border: "1px solid #C8C8C8",
        color: "#1B6E8C",
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        fontSize: 11.5,
    },
    filterBar: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 18px",
        borderBottom: "1px solid #D9D9D9",
        background: "#FFFFFF",
        flexWrap: "wrap",
    },
    searchBox: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "#FFFFFF",
        border: "1px solid #C8C8C8",
        borderRadius: 3,
        padding: "6px 10px",
        minWidth: 220,
        flex: "0 1 260px",
    },
    searchInput: {
        border: "none",
        outline: "none",
        background: "transparent",
        fontSize: 12.5,
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        color: "#262626",
        flex: 1,
        minWidth: 0,
    },
    searchClearBtn: {
        border: "none",
        background: "transparent",
        color: "#6E6E6E",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        padding: 0,
    },
    searchDropdown: {
        position: "absolute",
        top: "calc(100% + 6px)",
        left: 0,
        width: 340,
        maxHeight: 280,
        overflowY: "auto",
        background: "#FFFFFF",
        border: "1px solid #C8C8C8",
        borderRadius: 3,
        boxShadow: "0 10px 28px rgba(38,38,38,0.14)",
        zIndex: 80,
        padding: 6,
    },
    searchDropdownEmpty: { fontSize: 12, color: "#6E6E6E", padding: "10px 8px" },
    searchDropdownItem: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 9px",
        borderRadius: 3,
        cursor: "pointer",
    },
    searchDropdownName: { fontSize: 12.5, fontFamily: "'IBM Plex Mono',monospace", color: "#262626", flexShrink: 0 },
    searchDropdownMeta: { fontSize: 11, color: "#6E6E6E", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    searchDropdownLoc: {
        fontSize: 10.5,
        color: "#1B6E8C",
        background: "#E3F0FB",
        borderRadius: 4,
        padding: "2px 8px",
        flexShrink: 0,
        whiteSpace: "nowrap",
        fontFamily: "'IBM Plex Mono',monospace",
    },
    filterSelect: {
        width: "auto",
        minWidth: 130,
        fontSize: 12.5,
        padding: "6px 9px",
    },
    dateRangeGroup: {
        display: "flex",
        alignItems: "center",
        gap: 6,
    },
    dateInput: {
        width: "auto",
        minWidth: 128,
        fontSize: 12,
        padding: "6px 8px",
    },
    dateRangeSep: { color: "#6E6E6E", fontSize: 12 },
    filterClearBtn: {
        background: "none",
        border: "1px solid #C8C8C8",
        color: "#595959",
        borderRadius: 3,
        padding: "6px 12px",
        fontSize: 12,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        whiteSpace: "nowrap",
    },
    filterCount: {
        fontSize: 11.5,
        color: "#1B6E8C",
        fontFamily: "'IBM Plex Mono',monospace",
        whiteSpace: "nowrap",
        marginLeft: "auto",
    },
    legend: {
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "10px 18px",
        borderBottom: "1px solid #D9D9D9",
        background: "#F5F5F5",
        fontSize: 11,
        color: "#595959",
        flexWrap: "wrap",
    },
    legendItem: { display: "flex", alignItems: "center", gap: 5 },
    legendDot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
    legendDivider: { width: 1, height: 12, background: "#C8C8C8" },
    scrollArea: { overflow: "auto", flex: 1, minHeight: 0, position: "relative" },
    analyticsWrap: { overflow: "auto", flex: 1, minHeight: 0, padding: "18px" },
    homeWrap: { overflow: "auto", flex: 1, minHeight: 0, padding: "18px" },
    homeGreetingCard: {
        maxWidth: 1100,
        margin: "0 auto 16px",
        background: "linear-gradient(135deg, #1B6E8C 0%, #155A73 100%)",
        borderRadius: 4,
        padding: "22px 24px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        boxShadow: "0 6px 18px rgba(21,90,115,0.25)",
    },
    homeGreetingTitle: { fontSize: 19, fontWeight: 700, color: "#FFFFFF", fontFamily: "'Segoe UI', sans-serif", marginBottom: 4 },
    homeGreetingSub: { fontSize: 12.5, color: "#E3F0FB", maxWidth: 420, lineHeight: 1.5 },
    homePrimaryBtn: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "#262626",
        color: "#FFFFFF",
        border: "none",
        borderRadius: 3,
        padding: "10px 16px",
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    homeSecondaryBtn: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "rgba(255,255,255,0.14)",
        color: "#FFFFFF",
        border: "1px solid rgba(255,255,255,0.35)",
        borderRadius: 3,
        padding: "10px 16px",
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    homeStatsGrid: {
        maxWidth: 1100,
        margin: "0 auto 16px",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 12,
    },
    homeStatCard: {
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        borderRadius: 4,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxShadow: "0 1px 4px rgba(38,38,38,0.05)",
    },
    homeStatIcon: {
        width: 32,
        height: 32,
        borderRadius: 3,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginBottom: 2,
    },
    homeStatValue: { fontSize: 21, fontWeight: 700, color: "#262626", fontFamily: "'Segoe UI', sans-serif" },
    homeStatLabel: { fontSize: 11, color: "#6E6E6E" },
    homeMidGrid: {
        maxWidth: 1100,
        margin: "0 auto 16px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
    },
    homeBottomGrid: {
        maxWidth: 1100,
        margin: "0 auto",
        display: "grid",
        gridTemplateColumns: "1fr 300px",
        gap: 16,
    },
    homeStatusRow: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 3,
        cursor: "pointer",
        background: "#F2F2F2",
    },
    analyticsGrid: {
        display: "grid",
        gridTemplateColumns: "1fr 300px",
        gap: 16,
        maxWidth: 1100,
        margin: "0 auto",
    },
    analyticsCard: {
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        borderRadius: 3,
        padding: "16px 18px",
        boxShadow: "0 1px 4px rgba(27,110,140,0.06)",
        boxSizing: "border-box",
    },
    analyticsCardWide: {
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        borderRadius: 3,
        padding: "16px 18px",
        boxShadow: "0 1px 4px rgba(27,110,140,0.06)",
        boxSizing: "border-box",
        gridColumn: "1 / -1",
    },
    analyticsCardHeader: { display: "flex", alignItems: "center", gap: 7, marginBottom: 14 },
    analyticsCardTitle: { fontSize: 13, fontWeight: 600, color: "#262626", fontFamily: "'Segoe UI', sans-serif" },
    analyticsStatsRow: { display: "flex", gap: 22, marginBottom: 16, flexWrap: "wrap" },
    analyticsStat: { display: "flex", flexDirection: "column", gap: 2 },
    analyticsStatValue: { fontSize: 20, fontWeight: 600, color: "#262626", fontFamily: "'Segoe UI', sans-serif" },
    analyticsStatLabel: { fontSize: 10.5, color: "#6E6E6E", textTransform: "uppercase", letterSpacing: "0.05em" },
    utilRow: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" },
    utilRowName: { fontSize: 12, fontFamily: "'IBM Plex Mono',monospace", width: 78, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    utilRowTrack: { flex: 1, height: 8, background: "#E1E1E1", borderRadius: 2, overflow: "hidden" },
    utilRowFill: { height: "100%", borderRadius: 2 },
    utilRowPct: { fontSize: 11.5, color: "#595959", width: 36, textAlign: "right", flexShrink: 0, fontFamily: "'IBM Plex Mono',monospace" },
    bottleneckEmpty: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#595959", padding: "8px 0" },
    historyRow: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 3,
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        cursor: "pointer",
    },
    historyRowOpen: {
        borderColor: "#ABABAB",
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
    },
    historyDetailInline: {
        background: "#F2F2F2",
        border: "1px solid #ABABAB",
        borderTop: "none",
        borderBottomLeftRadius: 3,
        borderBottomRightRadius: 3,
        padding: "10px 12px 12px",
    },
    historyIconWrap: {
        width: 26,
        height: 26,
        borderRadius: 3,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
    },
    historySummary: { fontSize: 12.5, color: "#262626", flex: 1, minWidth: 0 },
    historyTime: { fontSize: 10.5, color: "#8C8C8C", fontFamily: "'IBM Plex Mono',monospace", flexShrink: 0, whiteSpace: "nowrap" },
    historyActor: {
        fontSize: 10.5,
        color: "#1B6E8C",
        background: "#E3F0FB",
        borderRadius: 4,
        padding: "2px 8px",
        flexShrink: 0,
        whiteSpace: "nowrap",
    },
    historyDetailMeta: { fontSize: 11.5, color: "#6E6E6E", marginTop: 2, fontFamily: "'IBM Plex Mono',monospace" },
    historyFromToRow: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "#F2F2F2",
        border: "1px solid #D9D9D9",
        borderRadius: 3,
        padding: "14px 12px",
        marginBottom: 18,
    },
    historyFromToCol: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 },
    historyFromToLabel: { fontSize: 9.5, color: "#8C8C8C", textTransform: "uppercase", letterSpacing: "0.06em" },
    historyFromToValue: { fontSize: 13, fontWeight: 600, color: "#262626", fontFamily: "'IBM Plex Mono',monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    historyFromToSub: { fontSize: 10.5, color: "#6E6E6E" },
    historyMetaList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 },
    historyMetaRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 12 },
    historyMetaKey: { color: "#6E6E6E" },
    historyMetaValue: { color: "#262626", fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, textAlign: "right" },
    confirmOverlay: {
        position: "fixed",
        inset: 0,
        background: "rgba(38,38,38,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 300,
    },
    confirmCard: {
        width: 340,
        background: "#FFFFFF",
        borderRadius: 4,
        padding: "20px 22px",
        boxShadow: "0 20px 50px rgba(38,38,38,0.35)",
        boxSizing: "border-box",
    },
    confirmTitle: { fontSize: 15, fontWeight: 700, color: "#262626", fontFamily: "'Segoe UI', sans-serif", marginBottom: 8 },
    confirmMessage: { fontSize: 12.5, color: "#595959", lineHeight: 1.5, marginBottom: 18 },
    confirmBtnRow: { display: "flex", justifyContent: "flex-end", gap: 8 },
    linkPromptRow: { display: "flex", alignItems: "center", gap: 8, background: "#F2F2F2", border: "1px solid #D9D9D9", borderRadius: 3, padding: "8px 10px", marginBottom: 6 },
    linkPromptJobName: { fontSize: 12.5, fontFamily: "'IBM Plex Mono',monospace", color: "#262626", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    linkPromptHint: { fontSize: 10.5, color: "#8C8C8C", marginTop: 4 },
    confirmCancelBtn: {
        background: "none",
        border: "1px solid #C8C8C8",
        color: "#595959",
        borderRadius: 3,
        padding: "8px 16px",
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    confirmOkBtn: {
        background: "#1B6E8C",
        border: "none",
        color: "#FFFFFF",
        borderRadius: 3,
        padding: "8px 16px",
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    confirmDangerBtn: {
        background: "#C4372E",
        border: "none",
        color: "#FFFFFF",
        borderRadius: 3,
        padding: "8px 16px",
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    donutRow: { display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" },
    donutChart: {
        position: "relative",
        width: 108,
        height: 108,
        borderRadius: "50%",
        flexShrink: 0,
    },
    donutHole: {
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: 66,
        height: 66,
        borderRadius: "50%",
        background: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
    },
    donutHoleValue: { fontSize: 16, fontWeight: 700, color: "#262626", fontFamily: "'Segoe UI', sans-serif", lineHeight: 1.1 },
    donutHoleLabel: { fontSize: 9, color: "#6E6E6E", textTransform: "uppercase", letterSpacing: "0.05em" },
    donutLegend: { display: "flex", flexDirection: "column", gap: 7, flex: 1, minWidth: 110 },
    donutLegendRow: { display: "flex", alignItems: "center", gap: 7 },
    donutLegendLabel: { fontSize: 12, color: "#404040", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    donutLegendValue: { fontSize: 12, color: "#262626", fontWeight: 600, fontFamily: "'IBM Plex Mono',monospace", flexShrink: 0 },
    eolCard: {
        background: "#FFF9F4",
        border: "1px solid #F7CFCB",
        borderRadius: 3,
        padding: "10px 14px",
        marginBottom: 12,
        boxShadow: "0 1px 4px rgba(224,54,40,0.06)",
        boxSizing: "border-box",
    },
    eolCardHeader: { display: "flex", alignItems: "center", gap: 7, marginBottom: 8 },
    eolRow: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        borderRadius: 3,
        cursor: "pointer",
        background: "#FFFFFF",
    },
    eolTrack: { flex: 1, minWidth: 60, height: 6, background: "#E1E1E1", borderRadius: 4, overflow: "hidden" },
    barChartWrap: {
        display: "flex",
        alignItems: "flex-end",
        gap: 14,
        overflowX: "auto",
        paddingTop: 6,
        paddingBottom: 2,
        minHeight: 150,
    },
    barChartCol: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        width: 46,
        cursor: "pointer",
    },
    barChartValue: { fontSize: 10, color: "#595959", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" },
    barChartTrack: {
        width: 26,
        height: 108,
        display: "flex",
        alignItems: "flex-end",
        background: "#FFFFFF",
        borderRadius: 2,
        overflow: "hidden",
    },
    barChartFill: { width: "100%", borderRadius: "2px 2px 0 0", transition: "height 0.2s ease" },
    barChartLabel: { fontSize: 10, color: "#6E6E6E", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 46 },
    toolsLayout: {
        display: "flex",
        gap: 14,
        alignItems: "flex-start",
        marginBottom: 14,
    },
    toolsSidebar: {
        width: 230,
        flexShrink: 0,
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        borderRadius: 3,
        boxShadow: "0 1px 4px rgba(27,110,140,0.06)",
        maxHeight: 420,
        overflowY: "auto",
        padding: 5,
        boxSizing: "border-box",
    },
    toolsSidebarItem: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 9px",
        borderRadius: 3,
        cursor: "pointer",
    },
    toolsSidebarName: { fontSize: 12, fontFamily: "'IBM Plex Mono',monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    toolsSidebarSub: { fontSize: 10, color: "#6E6E6E" },
    toolsSidebarHours: { fontSize: 11, fontFamily: "'IBM Plex Mono',monospace", color: "#262626", flexShrink: 0 },
    toolsBarsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, margin: "10px 0 14px" },
    toolsRightCol: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 },
    toolsDetail: {
        flex: 1,
        minWidth: 0,
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        borderRadius: 3,
        padding: "14px 16px",
        boxShadow: "0 1px 4px rgba(27,110,140,0.06)",
        boxSizing: "border-box",
    },
    toolsSummarySection: {
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        borderRadius: 3,
        padding: "16px 18px",
        boxShadow: "0 1px 4px rgba(27,110,140,0.06)",
        boxSizing: "border-box",
    },
    toolsSummaryHeaderRow: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 8px",
        fontSize: 10.5,
        color: "#6E6E6E",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        borderBottom: "1px solid #D9D9D9",
    },
    toolsSummaryRow: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 8px",
        borderRadius: 3,
        cursor: "pointer",
    },
    toolsSummaryCol: { width: 70, flexShrink: 0, fontSize: 11.5, fontFamily: "'IBM Plex Mono',monospace", color: "#595959", textAlign: "right" },
    toolRow: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 8px",
        borderRadius: 3,
        background: "#F2F2F2",
        cursor: "pointer",
    },
    toolRowName: { fontSize: 11.5, fontFamily: "'IBM Plex Mono',monospace", color: "#262626", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    toolRowHours: { fontSize: 10.5, color: "#6E6E6E", fontFamily: "'IBM Plex Mono',monospace", flexShrink: 0 },
    toolEditCard: {
        background: "#F9F9F9",
        border: "1px solid #E1E1E1",
        borderRadius: 3,
        padding: "8px 9px",
        boxSizing: "border-box",
    },
    toolEditHeaderRow: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 6,
        flexWrap: "wrap",
    },
    toolNumberInput: { width: 46, flexShrink: 0, fontSize: 11.5, padding: "5px 6px" },
    toolNameInput: { width: "auto", flex: "1 1 80px", minWidth: 70, fontSize: 11.5, padding: "5px 7px" },
    toolEditHours: { fontSize: 10.5, color: "#595959", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap", flexShrink: 0 },
    toolChangeIndex: { fontSize: 10.5, color: "#8C8C8C", fontFamily: "'IBM Plex Mono',monospace", flexShrink: 0 },
    segmentFieldLabel: { fontSize: 10, color: "#8C8C8C", whiteSpace: "nowrap", flexShrink: 0 },
    toolSpanNote: { fontSize: 10.5, color: "#1B6E8C", background: "#E3F0FB", border: "1px solid #BBD9F2", borderRadius: 3, padding: "4px 8px", marginBottom: 6 },
    bottleneckRow: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 3,
        background: "#FDECEB",
        border: "1px solid #F7CFCB",
        cursor: "pointer",
    },
    bottleneckRank: { fontSize: 11, color: "#C4372E", fontFamily: "'IBM Plex Mono',monospace", flexShrink: 0 },
    bottleneckBadge: {
        fontSize: 10.5,
        color: "#C4372E",
        background: "#FFFFFF",
        border: "1px solid #F7CFCB",
        borderRadius: 4,
        padding: "3px 9px",
        flexShrink: 0,
        fontFamily: "'IBM Plex Mono',monospace",
        whiteSpace: "nowrap",
    },
    heatmapDayLabel: { fontSize: 10.5, color: "#6E6E6E", textAlign: "center", fontFamily: "'IBM Plex Mono',monospace", paddingBottom: 4 },
    heatLegendRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 },
    heatLegendLabel: { fontSize: 10.5, color: "#6E6E6E", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" },
    heatLegendBar: {
        width: 160,
        height: 8,
        borderRadius: 2,
        background: "linear-gradient(90deg, hsl(130,70%,46%), hsl(65,70%,44%), hsl(0,70%,40%))",
    },
    heatmapRowLabel: { fontSize: 11.5, color: "#404040", fontFamily: "'IBM Plex Mono',monospace", display: "flex", alignItems: "center", paddingRight: 6 },
    heatmapCell: {
        height: 30,
        borderRadius: 2,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 10.5,
        fontFamily: "'IBM Plex Mono',monospace",
    },
    headerRow: { position: "sticky", top: 0, zIndex: 30, display: "flex", boxShadow: "0 1px 0 #BFBFBF" },
    cornerCell: {
        position: "sticky",
        left: 0,
        top: 0,
        zIndex: 40,
        width: RESOURCE_COL_WIDTH,
        height: HEADER_HEIGHT,
        background: "#FFFFFF",
        borderRight: "1px solid #D9D9D9",
        borderBottom: "1px solid #BFBFBF",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        paddingLeft: 14,
        paddingRight: 10,
        fontSize: 10.5,
        letterSpacing: "0.06em",
        color: "#6E6E6E",
        textTransform: "uppercase",
        boxSizing: "border-box",
    },
    addResBtn: { width: 20, height: 20, padding: 0, fontSize: 13, lineHeight: 1, background: "#1B6E8C", color: "#FFFFFF", border: "none", borderRadius: 2, cursor: "pointer" },
    dayLabel: { fontSize: 12, fontWeight: 600, fontFamily: "'IBM Plex Mono',monospace", paddingLeft: 8, whiteSpace: "nowrap" },
    hourLabel: { position: "absolute", top: 4, left: 4, fontSize: 10.5, color: "#595959", fontWeight: 500, fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" },
    nowDot: { position: "absolute", top: -3, left: -3, width: 8, height: 8, borderRadius: "50%", background: "#1B6E8C", boxShadow: "0 0 0 3px #1B6E8C22" },
    resourceCell: {
        position: "sticky",
        left: 0,
        zIndex: 20,
        width: RESOURCE_COL_WIDTH,
        background: "#FFFFFF",
        borderRight: "1px solid #D9D9D9",
        borderBottom: "1px solid #E1E1E1",
        padding: "8px 14px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 3,
    },
    resourceName: { fontSize: 12.5, fontWeight: 600, fontFamily: "'IBM Plex Mono',monospace" },
    resourceType: { fontSize: 10.5, color: "#6E6E6E" },
    utilTrack: { width: "100%", height: 4, background: "#E1E1E1", borderRadius: 3, marginTop: 3, overflow: "hidden" },
    utilFill: { height: "100%", background: "linear-gradient(90deg,#1B6E8C,#4FA8C9)", borderRadius: 3 },
    pool: { borderTop: "1px solid #D9D9D9", background: "#F5F5F5", padding: "12px 18px 14px" },
    poolLabel: { fontSize: 10.5, letterSpacing: "0.06em", color: "#6E6E6E", textTransform: "uppercase", marginBottom: 8 },
    ncNotice: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 11,
        padding: "6px 8px 6px 10px",
        borderRadius: 3,
        border: "1px solid transparent",
    },
    ncNotice_created: { background: "#E3F5E9", color: "#187A3E", borderColor: "#A8DDBB" },
    ncNotice_updated: { background: "#FCF0DC", color: "#8A5A0F", borderColor: "#F3DDAE" },
    ncNotice_unchanged: { background: "#FFFFFF", color: "#595959", borderColor: "#C8C8C8" },
    ncNotice_error: { background: "#FDECEB", color: "#C4372E", borderColor: "#F7CFCB" },
    ncNoticeClose: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "none",
        color: "inherit",
        opacity: 0.6,
        cursor: "pointer",
        flexShrink: 0,
        padding: 0,
    },
    addJobBtn: { width: "auto", height: 26, padding: "0 12px", fontSize: 11.5, fontWeight: 500, marginBottom: 8, background: "#1B6E8C", color: "#FFFFFF", border: "1px solid #1B6E8C" },
    poolStrip: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 },
    poolEmpty: { fontSize: 12, color: "#6E6E6E", padding: "8px 0" },
    chip: {
        flexShrink: 0,
        background: "#FFFFFF",
        borderRadius: 3,
        padding: "7px 11px",
        minWidth: 96,
        cursor: "grab",
        userSelect: "none",
        border: "1px solid #D9D9D9",
    },
    panel: {
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 240,
        background: "#FFFFFF",
        borderLeft: "1px solid #D9D9D9",
        padding: "16px 16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        overflowY: "auto",
        zIndex: 50,
        boxShadow: "-8px 0 24px rgba(27,110,140,0.08)",
    },
    panelHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
    panelClose: { background: "none", border: "none", color: "#6E6E6E", cursor: "pointer", padding: 2, display: "flex" },
    fieldLabel: { fontSize: 10.5, color: "#6E6E6E", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 10, marginBottom: 4 },
    conflictNote: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: "#C4372E",
        background: "#FDECEB",
        border: "1px solid #F7CFCB",
        borderRadius: 4,
        padding: "8px 10px",
        marginTop: 12,
    },
    runningNote: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: "#187A3E",
        background: "#E3F5E9",
        border: "1px solid #A8DDBB",
        borderRadius: 4,
        padding: "8px 10px",
        marginTop: 12,
    },
    deleteBtn: {
        marginTop: 18,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "1px solid #F7CFCB",
        color: "#C4372E",
        borderRadius: 3,
        padding: "8px 10px",
        fontSize: 12,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    qrIntro: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12.5,
        color: "#595959",
        background: "#F5F5F5",
        border: "1px solid #D9D9D9",
        borderRadius: 3,
        padding: "10px 14px",
        marginBottom: 16,
    },
    qrGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: 14,
    },
    qrCard: {
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        borderRadius: 4,
        padding: "14px 16px",
        boxShadow: "0 1px 4px rgba(27,110,140,0.06)",
    },
    qrCardHeader: { display: "flex", alignItems: "center", gap: 6, marginBottom: 2 },
    qrJobName: { fontSize: 12.5, fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: "#262626" },
    qrRunningBadge: {
        marginLeft: "auto",
        fontSize: 10,
        color: "#21A366",
        background: "#E3F5E9",
        borderRadius: 4,
        padding: "2px 8px",
        fontFamily: "'IBM Plex Mono',monospace",
    },
    qrResourceName: { fontSize: 10.5, color: "#6E6E6E", marginBottom: 10 },
    qrImages: { display: "flex", gap: 10 },
    qrImageBlock: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
    qrImage: { width: "100%", maxWidth: 130, height: "auto", borderRadius: 3, border: "1px solid #D9D9D9" },
    qrLabel: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, fontFamily: "'Segoe UI', 'Inter', sans-serif" },
    shiftIntroCard: {
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        borderRadius: 4,
        padding: "10px 14px",
        boxShadow: "0 1px 4px rgba(27,110,140,0.06)",
        marginBottom: 10,
        boxSizing: "border-box",
    },
    shiftIntroIcon: {
        width: 24,
        height: 24,
        borderRadius: 2,
        background: "#E3F0FB",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
    },
    shiftIntroTitle: { fontSize: 13, fontWeight: 600, color: "#262626", fontFamily: "'Segoe UI', sans-serif" },
    shiftTimelineRuler: { position: "relative", height: 14, marginTop: 10 },
    shiftTimelineTick: { position: "absolute", top: 0, fontSize: 9, color: "#8C8C8C", fontFamily: "'IBM Plex Mono',monospace", transform: "translateX(-50%)", whiteSpace: "nowrap" },
    shiftTimelineTrack: {
        position: "relative",
        height: 22,
        borderRadius: 2,
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        overflow: "hidden",
    },
    shiftTimelineNow: {
        position: "absolute",
        top: 0,
        bottom: 0,
        width: 2,
        background: "#262626",
        boxShadow: "0 0 0 3px rgba(38,38,38,0.12)",
    },
    shiftStatsRow: { display: "flex", gap: 18, marginTop: 8, flexWrap: "wrap" },
    shiftStatItem: { display: "flex", flexDirection: "column", gap: 1 },
    shiftStatValue: { fontSize: 14, fontWeight: 600, color: "#262626", fontFamily: "'Segoe UI', sans-serif" },
    shiftStatLabel: { fontSize: 9.5, color: "#6E6E6E", textTransform: "uppercase", letterSpacing: "0.05em" },
    shiftEmptyState: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: "22px 20px",
        background: "#FFFFFF",
        border: "1px dashed #C8C8C8",
        borderRadius: 4,
        marginBottom: 8,
    },
    shiftCard: {
        background: "#FFFFFF",
        border: "1px solid #D9D9D9",
        borderRadius: 3,
        padding: "8px 10px",
        boxShadow: "0 1px 4px rgba(27,110,140,0.06)",
        boxSizing: "border-box",
    },
    shiftCardOverlap: {
        background: "#FFFAF4",
        borderColor: "#F3DDAE",
    },
    shiftCardRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    shiftColorSwatchWrap: { position: "relative", display: "flex", cursor: "pointer", flexShrink: 0 },
    shiftColorInputHidden: { position: "absolute", inset: 0, width: 26, height: 26, opacity: 0, cursor: "pointer", border: "none", padding: 0 },
    shiftColorSwatch: { width: 26, height: 26, borderRadius: 3, border: "1px solid rgba(0,0,0,0.08)", boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.5)", flexShrink: 0 },
    shiftNameInput: { width: "auto", flex: "1 1 110px", minWidth: 90, fontWeight: 600, fontSize: 12.5, padding: "5px 8px" },
    shiftTimeInputCompact: { width: 84, flexShrink: 0, fontSize: 12, padding: "5px 6px" },
    shiftDurationBadge: {
        fontSize: 10,
        color: "#1B6E8C",
        background: "#E3F0FB",
        border: "1px solid #BBD9F2",
        borderRadius: 4,
        padding: "3px 8px",
        fontFamily: "'IBM Plex Mono',monospace",
        whiteSpace: "nowrap",
        flexShrink: 0,
    },
    shiftOverlapBadge: {
        display: "flex",
        alignItems: "center",
        gap: 3,
        fontSize: 10,
        color: "#B45309",
        background: "#FCF0DC",
        border: "1px solid #F3DDAE",
        borderRadius: 4,
        padding: "3px 8px",
        whiteSpace: "nowrap",
        flexShrink: 0,
    },
    shiftBreaksSection: { marginTop: 6, background: "#F2F2F2", border: "1px solid #E1E1E1", borderRadius: 3, padding: "6px 8px" },
    shiftBreaksHeader: { display: "flex", alignItems: "center", gap: 5, marginBottom: 4 },
    shiftBreaksLabel: { fontSize: 10, color: "#6E6E6E", textTransform: "uppercase", letterSpacing: "0.05em" },
    shiftAddBreakBtn: {
        display: "flex",
        alignItems: "center",
        gap: 4,
        marginLeft: "auto",
        background: "none",
        border: "1px dashed #ABABAB",
        color: "#1B6E8C",
        borderRadius: 4,
        padding: "3px 8px",
        fontSize: 10,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        whiteSpace: "nowrap",
    },
    shiftBreakRow: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        background: "#FFFFFF",
        border: "1px solid #E1E1E1",
        borderRadius: 3,
        padding: "4px 7px",
        flexWrap: "wrap",
    },
    shiftBreakLabelInput: { width: "auto", flex: "1 1 90px", minWidth: 80, fontSize: 11.5, padding: "4px 7px" },
    shiftBreakTimeInput: { width: 78, flexShrink: 0, fontSize: 11.5, padding: "4px 6px" },
    shiftColorInput: {
        width: 32,
        height: 32,
        padding: 0,
        border: "1px solid #C8C8C8",
        borderRadius: 3,
        cursor: "pointer",
        background: "none",
        flexShrink: 0,
    },
    undoPill: {
        position: "absolute",
        bottom: 18,
        right: 18,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "#262626",
        borderRadius: 4,
        padding: "8px 8px 8px 14px",
        boxShadow: "0 10px 28px rgba(38,38,38,0.35)",
    },
    undoPillText: { fontSize: 12, color: "#FFFFFF", fontFamily: "'Segoe UI', 'Inter', sans-serif", whiteSpace: "nowrap" },
    undoPillBtn: {
        background: "#1B6E8C",
        color: "#FFFFFF",
        border: "none",
        borderRadius: 3,
        padding: "6px 12px",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        whiteSpace: "nowrap",
    },
    undoPillClose: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(255,255,255,0.12)",
        border: "none",
        color: "#FFFFFF",
        borderRadius: "50%",
        width: 22,
        height: 22,
        cursor: "pointer",
        flexShrink: 0,
    },
    bulkBar: {
        position: "absolute",
        bottom: 18,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "#262626",
        borderRadius: 4,
        padding: "8px 12px",
        boxShadow: "0 10px 28px rgba(38,38,38,0.35)",
    },
    bulkBarCount: { fontSize: 12.5, fontWeight: 600, color: "#FFFFFF", fontFamily: "'Segoe UI', 'Inter', sans-serif", whiteSpace: "nowrap", paddingLeft: 4 },
    bulkBarDivider: { width: 1, height: 18, background: "rgba(255,255,255,0.2)" },
    bulkBarBtn: {
        display: "flex",
        alignItems: "center",
        gap: 4,
        background: "rgba(255,255,255,0.1)",
        border: "1px solid rgba(255,255,255,0.18)",
        color: "#FFFFFF",
        borderRadius: 4,
        padding: "6px 10px",
        fontSize: 11.5,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        whiteSpace: "nowrap",
    },
    bulkBarDeleteBtn: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        background: "rgba(240,98,91,0.18)",
        border: "1px solid rgba(240,98,91,0.4)",
        color: "#FF8B83",
        borderRadius: 4,
        padding: "6px 12px",
        fontSize: 12,
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        whiteSpace: "nowrap",
    },
    bulkBarClearBtn: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(255,255,255,0.12)",
        border: "none",
        color: "#FFFFFF",
        borderRadius: "50%",
        width: 26,
        height: 26,
        cursor: "pointer",
        flexShrink: 0,
    },
};