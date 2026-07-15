import { useState, useRef, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";
import { Cog, PauseCircle, AlertTriangle, CircleOff, CheckCircle2, Lock, X, ZoomIn, ZoomOut, RotateCcw, Trash2, CalendarDays, Boxes, BarChart3, TrendingUp, AlertOctagon, Gauge, Home as HomeIcon, ArrowRight, ListChecks, Search, Maximize2, ChevronLeft, ChevronRight, QrCode, Play, Square, Zap } from "lucide-react";

const NAV_ITEMS = [
    { id: "home", label: "Home", Icon: HomeIcon },
    { id: "schedule", label: "Schedule", Icon: CalendarDays },
    { id: "analytics", label: "Analytics", Icon: BarChart3 },
    { id: "qrcodes", label: "QR Codes", Icon: QrCode },
];

const DAY_ABBR_LOCALE = { weekday: "short" };

const ROW_HEIGHT = 64;
const HEADER_HEIGHT = 52;
const RESOURCE_COL_WIDTH = 168;
const VIEW_DAY_OPTIONS = [7, 14, 30];

const RUNNING_GREEN = "#007A36";
const RUNNING_GREEN_DARK = "#003D1B";
const RUNNING_GREEN_LIGHT = "#00C853";

// vivid green used only for the "running" job block in the Gantt chart (kept bright on purpose)
const JOB_RUNNING_GREEN = "#00C853";

const ALARM_RED = "#FF2D20";
const ALARM_RED_DARK = "#D6180A";

const ALARM_REASONS = [
    { id: "breakdown", label: "เครื่องขัดข้อง" },
    { id: "material", label: "ขาดวัตถุดิบ" },
    { id: "quality", label: "ปัญหาคุณภาพ" },
    { id: "other", label: "ต้องการความช่วยเหลือ" },
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
    Bracket: "#2F6E86",
    Housing: "#17A2A0",
    Panel: "#3E96B8",
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
    running: { label: "Running", color: "#17A2A0", Icon: CheckCircle2 },
    idle: { label: "Idle", color: "#7C8A93", Icon: PauseCircle },
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

export default function ProductionScheduler() {
   const [jobs, setJobs] = useState(cloneJobs);
const [resources, setResources] = useState(cloneResources);
const [loaded, setLoaded] = useState(false);
const skipNextRealtimeRef = useRef(false);
// true when jobs/resources were just set FROM Supabase (initial load or a realtime event from
// another tab/device), as opposed to a genuine local edit (drag, add job, raise alarm, etc).
// Without this, applying a realtime update triggers the auto-save effect below, which writes
// the same data straight back to Supabase - and if two tabs are open, each tab's "harmless" echo
// triggers the other tab's echo in turn, forever, every ~1-2s. That loop can silently overwrite
// a just-scanned change with a stale snapshot before you ever see it.
const remoteUpdateRef = useRef(false);

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
                if (incoming) {
                    remoteUpdateRef.current = true;
                    if (incoming.jobs) setJobs(incoming.jobs);
                    if (incoming.resources) setResources(incoming.resources);
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
            .update({ data: { jobs, resources }, updated_at: new Date().toISOString() })
            .eq("id", 1)
            .then();
    }, 800);
    return () => clearTimeout(timer);
}, [jobs, resources, loaded]);
    const [hourWidth, setHourWidth] = useState(22);
    const [selectedJobId, setSelectedJobId] = useState(null);
    const [selectedResourceId, setSelectedResourceId] = useState(null);
    const [ghost, setGhost] = useState(null);
    const [activeNav, setActiveNav] = useState("home");
    const [loadView, setLoadView] = useState("week");
    const [searchQuery, setSearchQuery] = useState("");
    const [searchFocused, setSearchFocused] = useState(false);
    const [filterProduct, setFilterProduct] = useState("all");
    const [filterResourceType, setFilterResourceType] = useState("all");
    const [viewDays, setViewDays] = useState(7);
    const [filterFromDate, setFilterFromDate] = useState("");
    const [filterToDate, setFilterToDate] = useState("");
    const [pendingAlarmReason, setPendingAlarmReason] = useState(ALARM_REASONS[0].id);

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

    function fitWeekToView() {
        if (!gridScrollRef.current) return;
        if (isFitted) {
            setHourWidth(prevHourWidth);
            setIsFitted(false);
            return;
        }
        const availableWidth = gridScrollRef.current.clientWidth - RESOURCE_COL_WIDTH;
        const fitted = Math.floor(availableWidth / TOTAL_HOURS);
        setPrevHourWidth(hourWidth);
        setHourWidth(Math.max(4, Math.min(48, fitted)));
        setIsFitted(true);
    }

    function adjustZoom(delta) {
        setIsFitted(false);
        setHourWidth((w) => Math.max(10, Math.min(48, w + delta)));
    }

    useEffect(() => {
        // fit the full window into view on first load instead of defaulting to a width that requires scrolling
        const id = requestAnimationFrame(() => fitWeekToView());
        return () => cancelAnimationFrame(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // re-fit whenever the visible day range changes, so the timeline always fills the viewport
    useEffect(() => {
        if (isFitted) fitWeekToView();
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

    const jobDate = (job) => new Date(baseDate.getTime() + job.startHour * 3600000);

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

    // jobs currently marked as running (from QR start/stop scans), paired with their resource
    const runningNow = useMemo(() => {
        return jobs
            .filter((j) => j.isRunning && j.resourceId)
            .map((j) => ({ job: j, resource: resources.find((r) => r.id === j.resourceId) || null }))
            .filter((x) => x.resource);
    }, [jobs, resources]);

    // resources with an active alarm (from QR alarm scans or manual trigger)
    const activeAlarms = useMemo(() => resources.filter((r) => r.alarmActive), [resources]);

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
        if (d.mode === "resize") {
            const deltaHours = Math.round(dx / hw);
            const newDuration = Math.max(1, Math.min(TOTAL_HOURS - d.origStart, d.origDuration + deltaHours));
            setJobs((js) => js.map((j) => (j.id === d.jobId ? { ...j, duration: newDuration } : j)));
        } else {
            const deltaHours = Math.round(dx / hw);
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
                setJobs((js) => {
                    const job = js.find((j) => j.id === d.jobId);
                    if (!job) return js;
                    const startHour = Math.max(0, Math.min(TOTAL_HOURS - job.duration, Math.round(localX / hw)));
                    return js.map((j) => (j.id === d.jobId ? { ...j, resourceId: resourcesRef.current[rowIndex].id, startHour } : j));
                });
            }
            setGhost(null);
        } else if (d) {
            const poolRect = poolRef.current?.getBoundingClientRect();
            if (poolRect && e.clientY >= poolRect.top) {
                setJobs((js) => js.map((j) => (j.id === d.jobId ? { ...j, resourceId: null } : j)));
            }
        }
        dragRef.current = null;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
    }

    function onJobPointerDown(e, job, mode) {
        e.stopPropagation();
        setSelectedJobId(job.id);
        setSelectedResourceId(null);
        if (job.locked || isJobBlocked(job)) return;
        const rowIndex = resources.findIndex((r) => r.id === job.resourceId);
        dragRef.current = {
            jobId: job.id,
            mode,
            fromPool: false,
            startX: e.clientX,
            startY: e.clientY,
            origStart: job.startHour,
            origDuration: job.duration,
            origRowIndex: rowIndex,
        };
        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
    }

    function onPoolPointerDown(e, job) {
        e.stopPropagation();
        dragRef.current = { jobId: job.id, mode: "move", fromPool: true, startX: e.clientX, startY: e.clientY };
        setGhost({ jobId: job.id, x: e.clientX, y: e.clientY, name: job.name, color: PRODUCTS[job.product] });
        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
    }

    function updateJob(id, patch) {
        setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));
    }

    function deleteJob(id) {
        setJobs((js) => js.filter((j) => j.id !== id));
        setSelectedJobId(null);
    }

    function resetDemo() {
        setJobs(cloneJobs());
        setResources(cloneResources());
        setSelectedJobId(null);
        setSelectedResourceId(null);
    }

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
    }

    function addResource() {
        const n = resources.length + 1;
        const id = "new-r-" + Date.now();
        const newResource = { id, name: "RES-" + n, type: "Machine", status: "idle", alarmActive: false, alarmReason: null };
        setResources((rs) => [...rs, newResource]);
        setSelectedResourceId(id);
        setSelectedJobId(null);
    }

    function updateResource(id, patch) {
        setResources((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    }

    function deleteResource(id) {
        setResources((rs) => rs.filter((r) => r.id !== id));
        setJobs((js) => js.map((j) => (j.resourceId === id ? { ...j, resourceId: null } : j)));
        setSelectedResourceId(null);
    }

    const selectedJob = jobs.find((j) => j.id === selectedJobId) || null;
    const selectedResource = resources.find((r) => r.id === selectedResourceId) || null;
    const conflictCount = conflictIds.size;

    return (
        <div style={styles.appShell}>
            <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .ps-scroll::-webkit-scrollbar { height: 10px; width: 10px; }
        .ps-scroll::-webkit-scrollbar-track { background: #EEF2F3; }
        .ps-scroll::-webkit-scrollbar-thumb { background: #C7D5DA; border-radius: 6px; }
        .ps-scroll { scrollbar-width: thin; scrollbar-color: #C7D5DA #EEF2F3; }
        .ps-job:hover { filter: brightness(1.03); box-shadow: 0 4px 12px rgba(27,34,38,0.16) !important; }
        .ps-chip:hover { box-shadow: 0 4px 12px rgba(27,110,134,0.12); }
        .ps-chip:active { cursor: grabbing; }
        .ps-zoombtn:hover { background: #EEF2F3; border-color: #B9CBD1; }
        .ps-addbtn:hover { background: #234F60 !important; }
        .ps-select, .ps-input { background:#F2F6F7; border:1px solid #DCE4E7; color:#1B2226; border-radius:10px; padding:7px 9px; font-family:'Inter',sans-serif; font-size:13px; width:100%; box-sizing:border-box; }
        .ps-select:focus, .ps-input:focus { outline:none; border-color:#2F6E86; box-shadow:0 0 0 3px rgba(47,110,134,0.14); }
        .ps-navbtn { transition: background 0.15s, color 0.15s, transform 0.1s; }
        .ps-navbtn:hover { background: #E4EAEC !important; }
        .ps-navbtn:active { transform: scale(0.98); }
        .ps-upgradebtn:hover { background: #E4EAEC !important; }
        .ps-sidebar { transition: width 0.22s ease; overflow: hidden; width: 76px; }
        .ps-sidebar .ps-navlabel { opacity: 0; transition: opacity 0.12s ease; white-space: nowrap; }
        .ps-sidebar .ps-promo { opacity: 0; pointer-events: none; transition: opacity 0.12s ease; }
        .ps-sidebar:hover { width: 210px; box-shadow: 4px 0 16px rgba(0,0,0,0.12); }
        .ps-sidebar:hover .ps-navlabel { opacity: 1; }
        .ps-sidebar:hover .ps-promo { opacity: 1; pointer-events: auto; }
        .ps-searchitem:hover { background: #EEF2F3 !important; }
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
        @keyframes ps-statusbar-dot { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(0.85); } }
        .ps-statusbar-dot { animation: ps-statusbar-dot 1.4s ease-in-out infinite; }
        .ps-statuschip:hover { box-shadow: 0 3px 10px rgba(0,61,27,0.35); transform: translateY(-1px); }
        @keyframes ps-alarm-dot { 0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 0 rgba(255,45,32,0.6); } 50% { opacity: 0.5; transform: scale(0.82); box-shadow: 0 0 0 5px rgba(255,45,32,0); } }
        .ps-alarm-dot { animation: ps-alarm-dot 0.9s ease-in-out infinite; }
        @keyframes ps-alarmbar-bg { 0%, 100% { background: linear-gradient(90deg, #ff2200 0%, #fd8370 100%); } 50% { background: linear-gradient(90deg, #FFC2B8 0%, #FFEAE7 100%); } }
        .ps-alarmbar { animation: ps-alarmbar-bg 1.3s ease-in-out infinite; }
        .ps-alarmchip:hover { box-shadow: 0 3px 10px rgba(214,24,10,0.35); transform: translateY(-1px); }
        @keyframes ps-alarm-row-flash { 0%, 100% { background: #ff0000; } 50% { background: #FDEBEA; } }
        .ps-alarm-row { animation: ps-alarm-row-flash 1.1s ease-in-out infinite; }
        .ps-alarmraisebtn:hover { background: ${ALARM_RED_DARK} !important; }
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
                                        background: active ? "#1B2226" : "transparent",
                                        color: active ? "#FFFFFF" : "#33424A",
                                        boxShadow: active ? "0 4px 10px rgba(27,34,38,0.18)" : "none",
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
                            <AlertTriangle size={18} color="#2F6E86" />
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
                </nav>

                <div style={styles.app}>
                    <div style={styles.toolbar}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                            <span style={styles.appTitle}>
                                {activeNav === "home" ? "Home" : activeNav === "analytics" ? "Analytics" : activeNav === "qrcodes" ? "QR Codes" : "Production Scheduler"}
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
                                                    background: viewDays === d ? "#2F6E86" : "#F2F6F7",
                                                    color: viewDays === d ? "#FFFFFF" : "#2F6E86",
                                                    borderColor: viewDays === d ? "#2F6E86" : "#DCE4E7",
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
                                            background: isFitted ? "#2F6E86" : "#F2F6F7",
                                            color: isFitted ? "#FFFFFF" : "#2F6E86",
                                            borderColor: isFitted ? "#2F6E86" : "#DCE4E7",
                                        }}
                                        onClick={fitWeekToView}
                                    >
                                        <Maximize2 size={13} /> {isFitted ? "undo fit" : "fit view"}
                                    </button>
                                    <button className="ps-zoombtn" style={{ ...styles.zoomBtn, width: "auto", padding: "0 12px", gap: 6, display: "flex", alignItems: "center" }} onClick={resetDemo}>
                                        <RotateCcw size={13} /> reset
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    {activeAlarms.length > 0 && (
                        <div className="ps-alarmbar" style={styles.alarmBar}>
                            <div style={styles.alarmBarLabel}>
                                <AlertOctagon size={13} color={ALARM_RED_DARK} strokeWidth={2.5} />
                                แจ้งเตือน ({activeAlarms.length})
                            </div>
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
                                        <span style={styles.alarmChipReason}>{ALARM_REASONS.find((a) => a.id === r.alarmReason)?.label || "แจ้งเตือน"}</span>
                                        <button style={styles.alarmChipClear} onClick={() => clearAlarm(r.id)} title="clear alarm">
                                            <X size={11} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {runningNow.length > 0 && (
                        <div style={styles.statusBar}>
                            <div style={styles.statusBarLabel}>
                                <Zap size={13} color={RUNNING_GREEN_DARK} strokeWidth={2.5} />
                                กำลังทำงานอยู่ ({runningNow.length})
                            </div>
                            <div style={styles.statusBarStrip} className="ps-scroll">
                                {runningNow.map(({ job, resource }) => (
                                    <div
                                        key={job.id}
                                        className="ps-statuschip"
                                        style={styles.statusChip}
                                        onClick={() => {
                                            setActiveNav("schedule");
                                            jumpToJob(job);
                                        }}
                                    >
                                        <span className="ps-statusbar-dot" style={styles.statusChipDot} />
                                        <span style={styles.statusChipResource}>{resource.name}</span>
                                        <span style={styles.statusChipSep}>·</span>
                                        <span style={styles.statusChipJob}>{job.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {activeNav === "home" && (
                        <div className="ps-scroll" style={styles.homeWrap}>
                            <div style={styles.homeGreetingCard}>
                                <div>
                                    <div style={styles.homeGreetingTitle}>Good to see you Ratthanan 👋</div>
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
                                    <div style={{ ...styles.homeStatIcon, background: "#E7EEF1" }}>
                                        <Boxes size={17} color="#2F6E86" />
                                    </div>
                                    <span style={styles.homeStatValue}>{resources.length}</span>
                                    <span style={styles.homeStatLabel}>resources tracked</span>
                                </div>
                                <div style={styles.homeStatCard}>
                                    <div style={{ ...styles.homeStatIcon, background: "#E4F5EE" }}>
                                        <CheckCircle2 size={17} color="#17A2A0" />
                                    </div>
                                    <span style={styles.homeStatValue}>{resources.filter((r) => r.status === "running").length}</span>
                                    <span style={styles.homeStatLabel}>running now</span>
                                </div>
                                <div style={styles.homeStatCard}>
                                    <div style={{ ...styles.homeStatIcon, background: "#E9EFF1" }}>
                                        <ListChecks size={17} color="#33424A" />
                                    </div>
                                    <span style={styles.homeStatValue}>{scheduledJobs.length}</span>
                                    <span style={styles.homeStatLabel}>jobs scheduled</span>
                                </div>
                                <div style={styles.homeStatCard}>
                                    <div style={{ ...styles.homeStatIcon, background: poolJobs.length ? "#FCF0DC" : "#E4F5EE" }}>
                                        <PauseCircle size={17} color={poolJobs.length ? "#E8A33D" : "#17A2A0"} />
                                    </div>
                                    <span style={styles.homeStatValue}>{poolJobs.length}</span>
                                    <span style={styles.homeStatLabel}>waiting to be scheduled</span>
                                </div>
                                <div style={styles.homeStatCard}>
                                    <div style={{ ...styles.homeStatIcon, background: conflictCount ? "#FDECEB" : "#E4F5EE" }}>
                                        <AlertTriangle size={17} color={conflictCount ? "#F0625B" : "#17A2A0"} />
                                    </div>
                                    <span style={{ ...styles.homeStatValue, color: conflictCount ? "#C4372E" : "#1B2226" }}>{conflictCount}</span>
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
                                    <div style={{ ...styles.homeStatIcon, background: activeAlarms.length ? "#FDECEB" : "#E4F5EE" }}>
                                        <AlertOctagon size={17} color={activeAlarms.length ? ALARM_RED : "#17A2A0"} />
                                    </div>
                                    <span style={{ ...styles.homeStatValue, color: activeAlarms.length ? ALARM_RED_DARK : "#1B2226" }}>{activeAlarms.length}</span>
                                    <span style={styles.homeStatLabel}>active alarms</span>
                                </div>
                            </div>

                            <div style={styles.homeBottomGrid}>
                                <div style={styles.analyticsCard}>
                                    <div style={styles.analyticsCardHeader}>
                                        <Gauge size={15} color="#2F6E86" />
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
                                                            background: r.alarmActive ? "#FDECEB" : "#F7F9FA",
                                                            color: r.alarmActive ? ALARM_RED_DARK : meta.color,
                                                            borderColor: r.alarmActive ? "#F7CFCB" : "#DCE4E7",
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
                                        <ListChecks size={15} color="#33424A" />
                                        <span style={styles.analyticsCardTitle}>Unscheduled jobs</span>
                                    </div>
                                    {poolJobs.length === 0 ? (
                                        <div style={styles.bottleneckEmpty}>
                                            <CheckCircle2 size={16} color="#17A2A0" />
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
                                                <div style={{ fontSize: 11, color: "#7C8A93" }}>+{poolJobs.length - 6} more in schedule view</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeNav === "schedule" && (
                        <>
                            <div style={styles.filterBar}>
                                <div style={{ position: "relative" }}>
                                    <div style={styles.searchBox}>
                                        <Search size={14} color="#7C8A93" />
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
                            </div>

                            <div
                                ref={gridScrollRef}
                                className="ps-scroll"
                                style={styles.scrollArea}
                                onPointerDown={() => {
                                    setSelectedJobId(null);
                                    setSelectedResourceId(null);
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
                                                const zebraBg = d % 2 === 0 ? "#FFFFFF" : "#EEF2F3";
                                                return (
                                                    <div
                                                        key={d}
                                                        style={{
                                                            position: "absolute",
                                                            left: d * 24 * hourWidth,
                                                            top: 0,
                                                            width: 24 * hourWidth,
                                                            height: 26,
                                                            borderLeft: "1px solid #CFDBDF",
                                                            boxSizing: "border-box",
                                                            background: isToday ? "#DCE6E9" : zebraBg,
                                                            display: "flex",
                                                            alignItems: "center",
                                                        }}
                                                    >
                                                        <span style={{ ...styles.dayLabel, color: isToday ? "#2F6E86" : "#33424A" }}>
                                                            {hourWidth < 14
                                                                ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
                                                                : date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                                                        </span>
                                                    </div>
                                                );
                                            })}
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
                                                                top: 26,
                                                                height: HEADER_HEIGHT - 26,
                                                                borderLeft: isDayStart ? "1px solid #CFDBDF" : isMajor ? "1px solid #DCE4E7" : "1px solid #E7EDEF",
                                                            }}
                                                        >
                                                            {isMajor && hourWidth >= 16 && (
                                                                <span style={styles.hourLabel}>{String(h % 24).padStart(2, "0")}:00</span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            {nowHour >= 0 && nowHour <= TOTAL_HOURS && (
                                                <div style={{ position: "absolute", left: nowHour * hourWidth, top: 0, width: 2, height: HEADER_HEIGHT, background: "linear-gradient(180deg,#2F6E86,#3E96B8)", zIndex: 25, borderRadius: 2 }}>
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
                                                        background: selectedResourceId === r.id ? "#EEF2F3" : "#FFFFFF",
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
                                                <div style={{ position: "relative", width: timelineWidth, borderBottom: "1px solid #E7EDEF" }}>
                                                    {Array.from({ length: DAYS }).map((_, d) => {
                                                        const isToday = d === Math.floor(nowHour / 24);
                                                        const zebraBg = d % 2 === 0 ? "#FFFFFF" : "#EEF3F4";
                                                        return (
                                                            <div
                                                                key={d}
                                                                style={{
                                                                    position: "absolute",
                                                                    left: d * 24 * hourWidth,
                                                                    top: 0,
                                                                    bottom: 0,
                                                                    width: 24 * hourWidth,
                                                                    borderLeft: "1px solid #DCE4E7",
                                                                    background: isToday ? "#E3ECEE" : zebraBg,
                                                                }}
                                                            />
                                                        );
                                                    })}
                                                    {hourWidth >= 10 &&
                                                        Array.from({ length: TOTAL_HOURS }).map((_, h) =>
                                                            h % 6 === 0 && h % 24 !== 0 ? (
                                                                <div key={h} style={{ position: "absolute", left: h * hourWidth, top: 0, bottom: 0, borderLeft: "1px dashed #E5EBED" }} />
                                                            ) : null
                                                        )}
                                                    {nowHour >= 0 && nowHour <= TOTAL_HOURS && (
                                                        <div style={{ position: "absolute", left: nowHour * hourWidth, top: 0, bottom: 0, width: 2, background: "linear-gradient(180deg,#2F6E8622,#3E96B822)" }} />
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
                                                            const color = PRODUCTS[job.product];
                                                            const selected = selectedJobId === job.id;
                                                            const dimmed = isFilterActive && !jobMatchesFilter(job);
                                                            const blocked = isJobBlocked(job);
                                                            return (
                                                                <div
                                                                    key={job.id}
                                                                    className={`ps-job${job.isRunning && !blocked ? " ps-job-running" : ""}`}
                                                                    onPointerDown={(e) => onJobPointerDown(e, job, "move")}
                                                                    style={{
                                                                        position: "absolute",
                                                                        left: job.startHour * hourWidth,
                                                                        width: Math.max(6, job.duration * hourWidth - 2),
                                                                        top: 7,
                                                                        height: ROW_HEIGHT - 14,
                                                                        background: blocked ? "#FBE4E2" : job.isRunning ? JOB_RUNNING_GREEN : job.locked ? `${color}22` : "#FFFFFF",
                                                                        border: blocked ? `1px solid ${ALARM_RED}99` : isConflict ? "1px solid #F0625B" : job.locked ? `1px solid ${color}77` : "1px solid #E4EAEC",
                                                                        borderLeftWidth: 4,
                                                                        borderLeftColor: blocked ? ALARM_RED : color,
                                                                        boxShadow: selected ? `0 0 0 2px ${color}55, 0 4px 10px rgba(47,110,134,0.12)` : "0 1px 4px rgba(47,110,134,0.08)",
                                                                        borderRadius: 12,
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
                                                                                color: blocked ? ALARM_RED_DARK : job.isRunning ? "#FFFFFF" : "#1B2226",
                                                                                whiteSpace: "nowrap",
                                                                                textShadow: job.isRunning && !blocked ? "0 1px 2px rgba(0,60,20,0.35)" : "none",
                                                                            }}
                                                                        >
                                                                            {blocked ? (
                                                                                <AlertOctagon size={9} color={ALARM_RED_DARK} strokeWidth={2.5} />
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
                                                                        ) : (
                                                                            <div style={{ fontSize: 10, color: "#7C8A93", whiteSpace: "nowrap" }}>{job.duration}h</div>
                                                                        )}
                                                                    </div>
                                                                    {isConflict && <AlertTriangle size={11} color="#F0625B" style={{ position: "absolute", top: 4, right: 4, zIndex: 2 }} />}
                                                                    {!job.locked && !blocked && (
                                                                        <div
                                                                            onPointerDown={(e) => onJobPointerDown(e, job, "resize")}
                                                                            style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "ew-resize" }}
                                                                        />
                                                                    )}
                                                                </div>
                                                            );
                                                        })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div ref={poolRef} style={styles.pool}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                    <div style={styles.poolLabel}>unscheduled ({poolJobs.length})</div>
                                    <button className="ps-addbtn" style={styles.addJobBtn} onClick={addJob}>
                                        + new job
                                    </button>
                                </div>
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
                                                    borderLeft: `4px solid ${PRODUCTS[job.product]}`,
                                                    boxShadow: selectedJobId === job.id ? `0 0 0 2px ${PRODUCTS[job.product]}55` : "0 1px 4px rgba(47,110,134,0.08)",
                                                    opacity: dimmed ? 0.28 : 1,
                                                    filter: dimmed ? "grayscale(0.4)" : "none",
                                                    transition: "opacity 0.15s ease",
                                                }}
                                            >
                                                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, color: "#1B2226" }}>{job.name}</div>
                                                <div style={{ fontSize: 10, color: "#7C8A93" }}>{job.product} · {job.duration}h</div>
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
                                        <Gauge size={15} color="#2F6E86" />
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
                                            <span style={{ ...styles.analyticsStatValue, color: analyticsSummary.totalConflictJobs ? "#C4372E" : "#17A2A0" }}>{analyticsSummary.totalConflictJobs}</span>
                                            <span style={styles.analyticsStatLabel}>jobs in conflict</span>
                                        </div>
                                    </div>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
                                        {resources
                                            .slice()
                                            .sort((a, b) => (utilization[b.id] || 0) - (utilization[a.id] || 0))
                                            .map((r) => {
                                                const pct = utilization[r.id] || 0;
                                                const barColor = pct >= 85 ? "#F0625B" : pct >= 60 ? "#E8A33D" : "#17A2A0";
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
                                    <div style={styles.analyticsCardHeader}>
                                        <AlertOctagon size={15} color="#F0625B" />
                                        <span style={styles.analyticsCardTitle}>Bottleneck detection</span>
                                    </div>
                                    {analyticsSummary.bottlenecks.length === 0 ? (
                                        <div style={styles.bottleneckEmpty}>
                                            <CheckCircle2 size={16} color="#17A2A0" />
                                            no scheduling conflicts detected
                                        </div>
                                    ) : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                            {analyticsSummary.bottlenecks.map(({ resource: r, count }, i) => (
                                                <div
                                                    key={r.id}
                                                    style={styles.bottleneckRow}
                                                    onClick={() => {
                                                        setSelectedResourceId(r.id);
                                                        setSelectedJobId(null);
                                                    }}
                                                >
                                                    <span style={styles.bottleneckRank}>#{i + 1}</span>
                                                    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                                                        <span style={styles.utilRowName}>{r.name}</span>
                                                        <span style={styles.resourceType}>{r.type}</span>
                                                    </div>
                                                    <span style={styles.bottleneckBadge}>{count} conflict{count !== 1 ? "s" : ""}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div style={styles.analyticsCardWide}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                                        <div style={styles.analyticsCardHeader}>
                                            <TrendingUp size={15} color="#3E96B8" />
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
                                                        background: loadView === v ? "#2F6E86" : "#F2F6F7",
                                                        color: loadView === v ? "#FFFFFF" : "#2F6E86",
                                                        borderColor: loadView === v ? "#2F6E86" : "#DCE4E7",
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
                                                                    background: hours === 0 ? "#EEF3F4" : heatColor(intensity),
                                                                    color: hours === 0 ? "#7C8A93" : intensity > 0.35 ? "#FFFFFF" : "#1B2226",
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
                                                            <div style={{ ...styles.utilRowFill, width: `${pct}%`, background: "#3E96B8" }} />
                                                        </div>
                                                        <span style={styles.utilRowPct}>{total}h</span>
                                                    </div>
                                                );
                                            })}
                                            <div style={{ fontSize: 11, color: "#7C8A93", marginTop: 2 }}>
                                                showing totals for the current {DAYS}-day scheduling window
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeNav === "qrcodes" && (
                        <div className="ps-scroll" style={styles.analyticsWrap}>
                            <div style={{ maxWidth: 1100, margin: "0 auto" }}>
                                <div style={styles.qrIntro}>
                                    <QrCode size={16} color="#2F6E86" />
                                    <span>
                                        สแกน START เพื่อเริ่มงาน สแกน STOP เพื่อหยุดงาน — ปริ้นแปะไว้หน้างานจริงได้เลย
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
                                                        <div style={{ ...styles.qrLabel, color: "#17A2A0" }}>
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
                                        <div style={styles.bottleneckEmpty}>ยังไม่มีงานที่ถูกจัดตารางเลย</div>
                                    )}
                                </div>

                                <div style={{ ...styles.qrIntro, marginTop: 24, borderColor: "#F7CFCB", background: "#FEF6F5" }}>
                                    <AlertOctagon size={16} color={ALARM_RED_DARK} />
                                    <span>
                                        สแกน ALARM เพื่อแจ้งเตือนปัญหาเครื่องจักร สแกน CLEAR เพื่อยกเลิกแจ้งเตือน — ปริ้นแปะไว้ที่ตัวเครื่องได้เลย
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
                                                        <div style={{ ...styles.qrLabel, color: "#17A2A0" }}>
                                                            <CheckCircle2 size={11} /> CLEAR
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {resources.length === 0 && (
                                        <div style={styles.bottleneckEmpty}>ยังไม่มีเครื่องจักรในระบบ</div>
                                    )}
                                </div>
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
                                borderRadius: 12,
                                padding: "6px 10px",
                                fontFamily: "'IBM Plex Mono',monospace",
                                fontSize: 11.5,
                                color: "#1B2226",
                                boxShadow: "0 8px 20px rgba(47,110,134,0.25)",
                            }}
                        >
                            {ghost.name}
                        </div>
                    )}

                    {selectedJob && (
                        <div style={styles.panel}>
                            <div style={styles.panelHeader}>
                                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#1B2226" }}>{selectedJob.name}</span>
                                <button style={styles.panelClose} onClick={() => setSelectedJobId(null)}>
                                    <X size={15} />
                                </button>
                            </div>

                            <label style={styles.fieldLabel}>job name</label>
                            <input className="ps-input" value={selectedJob.name} onChange={(e) => updateJob(selectedJob.id, { name: e.target.value })} />

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
                                min={1}
                                max={TOTAL_HOURS}
                                value={selectedJob.duration}
                                onChange={(e) => updateJob(selectedJob.id, { duration: Math.max(1, Number(e.target.value) || 1) })}
                            />

                            {selectedJob.resourceId && (
                                <div style={{ fontSize: 11.5, color: "#7C8A93", marginTop: 4, fontFamily: "'IBM Plex Mono',monospace" }}>
                                    starts {new Date(baseDate.getTime() + selectedJob.startHour * 3600000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                                </div>
                            )}

                            <label style={{ ...styles.fieldLabel, display: "flex", alignItems: "center", gap: 6, marginTop: 14 }}>
                                <input type="checkbox" checked={selectedJob.locked} onChange={(e) => updateJob(selectedJob.id, { locked: e.target.checked })} />
                                locked (cannot be dragged)
                            </label>

                            {selectedJob.isRunning && (
                                <div style={styles.runningNote}>
                                    <CheckCircle2 size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    งานนี้กำลังทำงานอยู่ (สแกน START ล่าสุด)
                                </div>
                            )}

                            {isJobBlocked(selectedJob) && (
                                <div style={styles.alarmActiveNote}>
                                    <AlertOctagon size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    เครื่องนี้มีการแจ้งเตือนอยู่ — ห้ามเริ่ม/ลากงานจนกว่าจะเคลียร์
                                </div>
                            )}

                            {conflictIds.has(selectedJob.id) && (
                                <div style={styles.conflictNote}>
                                    <AlertTriangle size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    overlaps another job on this resource
                                </div>
                            )}

                            <button style={styles.deleteBtn} onClick={() => deleteJob(selectedJob.id)}>
                                <Trash2 size={13} style={{ marginRight: 6 }} />
                                delete job
                            </button>
                        </div>
                    )}

                    {selectedResource && (
                        <div style={styles.panel}>
                            <div style={styles.panelHeader}>
                                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#1B2226" }}>{selectedResource.name}</span>
                                <button style={styles.panelClose} onClick={() => setSelectedResourceId(null)}>
                                    <X size={15} />
                                </button>
                            </div>

                            <label style={styles.fieldLabel}>resource name</label>
                            <input className="ps-input" value={selectedResource.name} onChange={(e) => updateResource(selectedResource.id, { name: e.target.value })} />

                            <label style={styles.fieldLabel}>type</label>
                            <input className="ps-input" value={selectedResource.type} onChange={(e) => updateResource(selectedResource.id, { type: e.target.value })} />

                            <label style={styles.fieldLabel}>status</label>
                            <select className="ps-select" value={selectedResource.status} onChange={(e) => updateResource(selectedResource.id, { status: e.target.value })}>
                                {Object.keys(STATUS_META).map((s) => (
                                    <option key={s} value={s}>{STATUS_META[s].label}</option>
                                ))}
                            </select>

                            <div style={{ fontSize: 11.5, color: "#7C8A93", marginTop: 4, fontFamily: "'IBM Plex Mono',monospace" }}>
                                {utilization[selectedResource.id]}% booked this week
                            </div>

                            <label style={{ ...styles.fieldLabel, marginTop: 14 }}>alarm</label>
                            {selectedResource.alarmActive ? (
                                <div style={styles.alarmActiveNote}>
                                    <AlertOctagon size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                    {ALARM_REASONS.find((a) => a.id === selectedResource.alarmReason)?.label || "แจ้งเตือน"}
                                </div>
                            ) : (
                                <div style={{ fontSize: 11.5, color: "#7C8A93" }}>ไม่มีการแจ้งเตือน</div>
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

                            <button style={styles.deleteBtn} onClick={() => deleteResource(selectedResource.id)}>
                                <Trash2 size={13} style={{ marginRight: 6 }} />
                                delete resource
                            </button>
                        </div>
                    )}
                </div>
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
        background: "#EEF2F3",
        display: "flex",
        flexDirection: "column",
        padding: "22px 14px",
        boxSizing: "border-box",
        borderRight: "1px solid #DCE4E7",
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
        borderRadius: 9,
        background: "#1B2226",
        color: "#FFFFFF",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Poppins',sans-serif",
        fontWeight: 700,
        fontSize: 11.5,
        flexShrink: 0,
    },
    sidebarBrandText: { fontFamily: "'Poppins',sans-serif", fontWeight: 700, fontSize: 15, color: "#1B2226", letterSpacing: "0.01em" },
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
        borderRadius: 12,
        border: "none",
        padding: "0 12px",
        cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
        fontSize: 13,
        textAlign: "left",
    },
    sidebarBtnLabel: { whiteSpace: "nowrap" },
    sidebarPromo: {
        marginTop: 18,
        background: "linear-gradient(160deg, #2F6E86 0%, #234F60 100%)",
        border: "1px solid #1D3B49",
        borderRadius: 18,
        padding: "16px 14px",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 10,
    },
    sidebarPromoIcon: {
        width: 34,
        height: 34,
        borderRadius: 10,
        background: "#FFFFFF",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    },
    sidebarPromoText: { fontSize: 12, color: "#E9EFF1", lineHeight: 1.4 },
    sidebarPromoBtn: {
        width: "100%",
        background: "#1B2226",
        color: "#FFFFFF",
        border: "none",
        borderRadius: 10,
        padding: "8px 0",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
    },
    app: {
        fontFamily: "'Inter', sans-serif",
        background: "#F7F9FA",
        color: "#1B2226",
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
        borderBottom: "1px solid #E4EAEC",
        background: "#FFFFFF",
        flexWrap: "wrap",
        gap: 10,
    },
    appTitle: { fontSize: 14, fontWeight: 600, letterSpacing: "0.01em", color: "#1B2226", fontFamily: "'Poppins',sans-serif" },
    appSub: { fontSize: 11.5, color: "#7C8A93", fontFamily: "'IBM Plex Mono',monospace" },
    conflictBadge: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: "#B45309",
        background: "#FCF0DC",
        border: "1px solid #F3DDAE",
        borderRadius: 20,
        padding: "4px 10px",
        fontFamily: "'IBM Plex Mono',monospace",
    },
    statusBar: {
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "9px 18px",
        borderBottom: "1px solid #8FE0AF",
        background: "linear-gradient(90deg, #02ce53 0%, #02ce53 100%)",
        flexWrap: "nowrap",
    },
    statusBarLabel: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11.5,
        fontWeight: 700,
        color: RUNNING_GREEN_DARK,
        fontFamily: "'Inter',sans-serif",
        whiteSpace: "nowrap",
        flexShrink: 0,
    },
    statusBarStrip: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        overflowX: "auto",
        flex: 1,
        minWidth: 0,
        paddingBottom: 1,
    },
    statusChip: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
        background: "#FFFFFF",
        border: `1px solid ${RUNNING_GREEN}66`,
        borderRadius: 20,
        padding: "5px 11px",
        cursor: "pointer",
        transition: "box-shadow 0.15s ease, transform 0.15s ease",
    },
    statusChipDot: { width: 7, height: 7, borderRadius: "50%", background: RUNNING_GREEN, flexShrink: 0 },
    statusChipResource: { fontSize: 11.5, fontWeight: 700, color: "#1B2226", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap", cursor: "pointer" },
    statusChipSep: { color: "#B7C4C9", fontSize: 11 },
    statusChipJob: { fontSize: 11, color: "#5B6B72", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" },
    alarmBar: {
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "9px 18px",
        borderBottom: "1px solid #FFAFA6",
        flexWrap: "nowrap",
    },
    alarmBarLabel: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11.5,
        fontWeight: 700,
        color: ALARM_RED_DARK,
        fontFamily: "'Inter',sans-serif",
        whiteSpace: "nowrap",
        flexShrink: 0,
    },
    alarmChip: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
        background: "#FFFFFF",
        border: `1px solid ${ALARM_RED}66`,
        borderRadius: 20,
        padding: "5px 6px 5px 11px",
        transition: "box-shadow 0.15s ease, transform 0.15s ease",
    },
    alarmChipDot: { width: 7, height: 7, borderRadius: "50%", background: ALARM_RED, flexShrink: 0 },
    alarmChipReason: { fontSize: 11, color: "#8A4842", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" },
    alarmChipClear: {
        border: "none",
        background: "#FDECEB",
        color: ALARM_RED_DARK,
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
    },
    alarmActiveNote: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: ALARM_RED_DARK,
        background: "#FDECEB",
        border: "1px solid #F7CFCB",
        borderRadius: 16,
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
        borderRadius: 10,
        padding: "8px 10px",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
    },
    alarmClearBtn: {
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "1px solid #B7E3D3",
        color: "#0F6E56",
        borderRadius: 10,
        padding: "8px 10px",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
    },
    qrAlarmBadge: {
        marginLeft: "auto",
        fontSize: 10,
        color: ALARM_RED_DARK,
        background: "#FDECEB",
        borderRadius: 20,
        padding: "2px 8px",
        fontFamily: "'IBM Plex Mono',monospace",
    },
    viewDaysGroup: {
        display: "flex",
        gap: 4,
        background: "#F2F6F7",
        border: "1px solid #DCE4E7",
        borderRadius: 16,
        padding: 3,
    },
    zoomBtn: {
        width: 28,
        height: 28,
        background: "#F2F6F7",
        border: "1px solid #DCE4E7",
        color: "#2F6E86",
        borderRadius: 14,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
        fontSize: 11.5,
    },
    filterBar: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 18px",
        borderBottom: "1px solid #E4EAEC",
        background: "#FFFFFF",
        flexWrap: "wrap",
    },
    searchBox: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "#F2F6F7",
        border: "1px solid #DCE4E7",
        borderRadius: 10,
        padding: "6px 10px",
        minWidth: 220,
        flex: "0 1 260px",
    },
    searchInput: {
        border: "none",
        outline: "none",
        background: "transparent",
        fontSize: 12.5,
        fontFamily: "'Inter',sans-serif",
        color: "#1B2226",
        flex: 1,
        minWidth: 0,
    },
    searchClearBtn: {
        border: "none",
        background: "transparent",
        color: "#7C8A93",
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
        border: "1px solid #DCE4E7",
        borderRadius: 12,
        boxShadow: "0 10px 28px rgba(27,34,38,0.14)",
        zIndex: 80,
        padding: 6,
    },
    searchDropdownEmpty: { fontSize: 12, color: "#7C8A93", padding: "10px 8px" },
    searchDropdownItem: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 9px",
        borderRadius: 8,
        cursor: "pointer",
    },
    searchDropdownName: { fontSize: 12.5, fontFamily: "'IBM Plex Mono',monospace", color: "#1B2226", flexShrink: 0 },
    searchDropdownMeta: { fontSize: 11, color: "#7C8A93", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    searchDropdownLoc: {
        fontSize: 10.5,
        color: "#2F6E86",
        background: "#E7EEF1",
        borderRadius: 20,
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
    dateRangeSep: { color: "#7C8A93", fontSize: 12 },
    filterClearBtn: {
        background: "none",
        border: "1px solid #DCE4E7",
        color: "#5B6B72",
        borderRadius: 8,
        padding: "6px 12px",
        fontSize: 12,
        cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
        whiteSpace: "nowrap",
    },
    filterCount: {
        fontSize: 11.5,
        color: "#2F6E86",
        fontFamily: "'IBM Plex Mono',monospace",
        whiteSpace: "nowrap",
        marginLeft: "auto",
    },
    legend: {
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "10px 18px",
        borderBottom: "1px solid #E4EAEC",
        background: "#F4F7F8",
        fontSize: 11,
        color: "#5B6B72",
        flexWrap: "wrap",
    },
    legendItem: { display: "flex", alignItems: "center", gap: 5 },
    legendDot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
    legendDivider: { width: 1, height: 12, background: "#DCE4E7" },
    scrollArea: { overflow: "auto", flex: 1, minHeight: 0, position: "relative" },
    analyticsWrap: { overflow: "auto", flex: 1, minHeight: 0, padding: "18px" },
    homeWrap: { overflow: "auto", flex: 1, minHeight: 0, padding: "18px" },
    homeGreetingCard: {
        maxWidth: 1100,
        margin: "0 auto 16px",
        background: "linear-gradient(135deg, #2F6E86 0%, #234F60 100%)",
        borderRadius: 18,
        padding: "22px 24px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        boxShadow: "0 6px 18px rgba(35,79,96,0.25)",
    },
    homeGreetingTitle: { fontSize: 19, fontWeight: 700, color: "#FFFFFF", fontFamily: "'Poppins',sans-serif", marginBottom: 4 },
    homeGreetingSub: { fontSize: 12.5, color: "#DCEAEF", maxWidth: 420, lineHeight: 1.5 },
    homePrimaryBtn: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "#1B2226",
        color: "#FFFFFF",
        border: "none",
        borderRadius: 10,
        padding: "10px 16px",
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
    },
    homeSecondaryBtn: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "rgba(255,255,255,0.14)",
        color: "#FFFFFF",
        border: "1px solid rgba(255,255,255,0.35)",
        borderRadius: 10,
        padding: "10px 16px",
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
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
        border: "1px solid #E4EAEC",
        borderRadius: 14,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxShadow: "0 1px 4px rgba(27,34,38,0.05)",
    },
    homeStatIcon: {
        width: 32,
        height: 32,
        borderRadius: 9,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginBottom: 2,
    },
    homeStatValue: { fontSize: 21, fontWeight: 700, color: "#1B2226", fontFamily: "'Poppins',sans-serif" },
    homeStatLabel: { fontSize: 11, color: "#7C8A93" },
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
        borderRadius: 10,
        cursor: "pointer",
        background: "#F7F9FA",
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
        border: "1px solid #E4EAEC",
        borderRadius: 12,
        padding: "16px 18px",
        boxShadow: "0 1px 4px rgba(47,110,134,0.06)",
        boxSizing: "border-box",
    },
    analyticsCardWide: {
        background: "#FFFFFF",
        border: "1px solid #E4EAEC",
        borderRadius: 12,
        padding: "16px 18px",
        boxShadow: "0 1px 4px rgba(47,110,134,0.06)",
        boxSizing: "border-box",
        gridColumn: "1 / -1",
    },
    analyticsCardHeader: { display: "flex", alignItems: "center", gap: 7, marginBottom: 14 },
    analyticsCardTitle: { fontSize: 13, fontWeight: 600, color: "#1B2226", fontFamily: "'Poppins',sans-serif" },
    analyticsStatsRow: { display: "flex", gap: 22, marginBottom: 16, flexWrap: "wrap" },
    analyticsStat: { display: "flex", flexDirection: "column", gap: 2 },
    analyticsStatValue: { fontSize: 20, fontWeight: 600, color: "#1B2226", fontFamily: "'Poppins',sans-serif" },
    analyticsStatLabel: { fontSize: 10.5, color: "#7C8A93", textTransform: "uppercase", letterSpacing: "0.05em" },
    utilRow: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" },
    utilRowName: { fontSize: 12, fontFamily: "'IBM Plex Mono',monospace", width: 78, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    utilRowTrack: { flex: 1, height: 8, background: "#E7EDEF", borderRadius: 5, overflow: "hidden" },
    utilRowFill: { height: "100%", borderRadius: 5 },
    utilRowPct: { fontSize: 11.5, color: "#5B6B72", width: 36, textAlign: "right", flexShrink: 0, fontFamily: "'IBM Plex Mono',monospace" },
    bottleneckEmpty: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#5B6B72", padding: "8px 0" },
    bottleneckRow: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 8,
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
        borderRadius: 20,
        padding: "3px 9px",
        flexShrink: 0,
        fontFamily: "'IBM Plex Mono',monospace",
        whiteSpace: "nowrap",
    },
    heatmapDayLabel: { fontSize: 10.5, color: "#7C8A93", textAlign: "center", fontFamily: "'IBM Plex Mono',monospace", paddingBottom: 4 },
    heatLegendRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 },
    heatLegendLabel: { fontSize: 10.5, color: "#7C8A93", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" },
    heatLegendBar: {
        width: 160,
        height: 8,
        borderRadius: 5,
        background: "linear-gradient(90deg, hsl(130,70%,46%), hsl(65,70%,44%), hsl(0,70%,40%))",
    },
    heatmapRowLabel: { fontSize: 11.5, color: "#33424A", fontFamily: "'IBM Plex Mono',monospace", display: "flex", alignItems: "center", paddingRight: 6 },
    heatmapCell: {
        height: 30,
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 10.5,
        fontFamily: "'IBM Plex Mono',monospace",
    },
    headerRow: { position: "sticky", top: 0, zIndex: 30, display: "flex", boxShadow: "0 1px 0 #CFDBDF" },
    cornerCell: {
        position: "sticky",
        left: 0,
        top: 0,
        zIndex: 40,
        width: RESOURCE_COL_WIDTH,
        height: HEADER_HEIGHT,
        background: "#FFFFFF",
        borderRight: "1px solid #E4EAEC",
        borderBottom: "1px solid #CFDBDF",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        paddingLeft: 14,
        paddingRight: 10,
        fontSize: 10.5,
        letterSpacing: "0.06em",
        color: "#7C8A93",
        textTransform: "uppercase",
        boxSizing: "border-box",
    },
    addResBtn: { width: 20, height: 20, padding: 0, fontSize: 13, lineHeight: 1, background: "#2F6E86", color: "#FFFFFF", border: "none", borderRadius: 5, cursor: "pointer" },
    dayLabel: { fontSize: 12, fontWeight: 600, fontFamily: "'IBM Plex Mono',monospace", paddingLeft: 8, whiteSpace: "nowrap" },
    hourLabel: { position: "absolute", top: 4, left: 4, fontSize: 10.5, color: "#5B6B72", fontWeight: 500, fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" },
    nowDot: { position: "absolute", top: -3, left: -3, width: 8, height: 8, borderRadius: "50%", background: "#2F6E86", boxShadow: "0 0 0 3px #2F6E8622" },
    resourceCell: {
        position: "sticky",
        left: 0,
        zIndex: 20,
        width: RESOURCE_COL_WIDTH,
        background: "#FFFFFF",
        borderRight: "1px solid #E4EAEC",
        borderBottom: "1px solid #E7EDEF",
        padding: "8px 14px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 3,
    },
    resourceName: { fontSize: 12.5, fontWeight: 600, fontFamily: "'IBM Plex Mono',monospace" },
    resourceType: { fontSize: 10.5, color: "#7C8A93" },
    utilTrack: { width: "100%", height: 4, background: "#E7EDEF", borderRadius: 3, marginTop: 3, overflow: "hidden" },
    utilFill: { height: "100%", background: "linear-gradient(90deg,#2F6E86,#3E96B8)", borderRadius: 3 },
    pool: { borderTop: "1px solid #E4EAEC", background: "#F4F7F8", padding: "12px 18px 14px" },
    poolLabel: { fontSize: 10.5, letterSpacing: "0.06em", color: "#7C8A93", textTransform: "uppercase", marginBottom: 8 },
    addJobBtn: { width: "auto", height: 26, padding: "0 12px", fontSize: 11.5, fontWeight: 500, marginBottom: 8, background: "#2F6E86", color: "#FFFFFF", border: "1px solid #2F6E86" },
    poolStrip: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 },
    poolEmpty: { fontSize: 12, color: "#7C8A93", padding: "8px 0" },
    chip: {
        flexShrink: 0,
        background: "#FFFFFF",
        borderRadius: 12,
        padding: "7px 11px",
        minWidth: 96,
        cursor: "grab",
        userSelect: "none",
        border: "1px solid #E4EAEC",
    },
    panel: {
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 240,
        background: "#FFFFFF",
        borderLeft: "1px solid #E4EAEC",
        padding: "16px 16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        overflowY: "auto",
        zIndex: 50,
        boxShadow: "-8px 0 24px rgba(47,110,134,0.08)",
    },
    panelHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
    panelClose: { background: "none", border: "none", color: "#7C8A93", cursor: "pointer", padding: 2, display: "flex" },
    fieldLabel: { fontSize: 10.5, color: "#7C8A93", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 10, marginBottom: 4 },
    conflictNote: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: "#C4372E",
        background: "#FDECEB",
        border: "1px solid #F7CFCB",
        borderRadius: 16,
        padding: "8px 10px",
        marginTop: 12,
    },
    runningNote: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: "#0F6E56",
        background: "#E4F5EE",
        border: "1px solid #B7E3D3",
        borderRadius: 16,
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
        borderRadius: 12,
        padding: "8px 10px",
        fontSize: 12,
        cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
    },
    qrIntro: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12.5,
        color: "#5B6B72",
        background: "#F4F7F8",
        border: "1px solid #E4EAEC",
        borderRadius: 12,
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
        border: "1px solid #E4EAEC",
        borderRadius: 14,
        padding: "14px 16px",
        boxShadow: "0 1px 4px rgba(47,110,134,0.06)",
    },
    qrCardHeader: { display: "flex", alignItems: "center", gap: 6, marginBottom: 2 },
    qrJobName: { fontSize: 12.5, fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: "#1B2226" },
    qrRunningBadge: {
        marginLeft: "auto",
        fontSize: 10,
        color: "#17A2A0",
        background: "#E4F5EE",
        borderRadius: 20,
        padding: "2px 8px",
        fontFamily: "'IBM Plex Mono',monospace",
    },
    qrResourceName: { fontSize: 10.5, color: "#7C8A93", marginBottom: 10 },
    qrImages: { display: "flex", gap: 10 },
    qrImageBlock: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
    qrImage: { width: "100%", maxWidth: 130, height: "auto", borderRadius: 8, border: "1px solid #E4EAEC" },
    qrLabel: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, fontFamily: "'Inter',sans-serif" },
};