import { useEffect, useState, useRef } from "react";
import { CheckCircle2, XCircle, Loader2, AlertTriangle, AlertOctagon, Play, Square, Cpu, AlertCircle, Lock, ChevronLeft } from "lucide-react";
import { supabase } from "./supabaseClient";

const ALARM_REASONS = [
    { id: "breakdown", label: "Machine breakdown" },
    { id: "material",  label: "Material shortage" },
    { id: "quality",   label: "Quality issue" },
    { id: "other",     label: "Assistance needed" },
];

const GREEN  = "#00913C";
const GREEN_D = "#006B2B";
const RED    = "#E8302A";
const RED_D  = "#B01F1A";
const AMBER  = "#B45309";
const BLUE   = "#1B6E8C";

export default function ScanAction({ kind, action, id, onDone }) {
    const [phase,        setPhase]        = useState("loading");
    const [chosenAction, setChosenAction] = useState(null);
    const [resource,     setResource]     = useState(null);
    const [job,          setJob]          = useState(null);
    const [plannedRes,   setPlannedRes]   = useState(null);
    const [errorMsg,     setErrorMsg]     = useState("");
    const [alarmReason,  setAlarmReason]  = useState(ALARM_REASONS[0].id);
    const [blockReason,  setBlockReason]  = useState("");
    const [isOverride,   setIsOverride]   = useState(false);
    const [showPinModal, setShowPinModal] = useState(false);
    const overridePinRef = useRef("");
    const [pinInput,     setPinInput]     = useState("");
    const [pinError,     setPinError]     = useState("");
    const mountedRef = useRef(true);

    const uname = sessionStorage.getItem("ps-username") || "";
    const urole = sessionStorage.getItem("ps-role") || "";

    useEffect(() => {
        mountedRef.current = true;
        load();
        return () => { mountedRef.current = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function load() {
        const { data, error } = await supabase
            .from("schedule_state").select("data").eq("id", 1).single();
        if (error || !data?.data) {
            setPhase("error"); setErrorMsg("Failed to load data. Please try again."); return;
        }
        const sd = data.data;

        if (kind === "alarm") {
            const res = (sd.resources || []).find((r) => r.id === id);
            if (!res) { setPhase("error"); setErrorMsg("Machine not found in system."); return; }
            setResource(res); setPhase("alarm_confirm"); return;
        }

        if (kind === "job") {
            const j = (sd.jobs || []).find((jj) => jj.id === id);
            if (!j) { setPhase("error"); setErrorMsg("Job not found in system."); return; }
            const planned = (sd.resources || []).find((r) => r.id === j.resourceId) || null;
            setJob(j); setPlannedRes(planned);

            if (action === "choose") { setPhase("choose_action"); return; }

            if (action === "start") {
                const users = sd.users || [];
                const currentUser = users.find((u) => u.username.toLowerCase() === uname.toLowerCase());
                const assignedMachineId = currentUser?.assignedMachineId || null;
                if (!assignedMachineId) { setPhase("no_machine"); return; }
                const assignedMachine = (sd.resources || []).find((r) => r.id === assignedMachineId) || null;
                setResource(assignedMachine);
                if (assignedMachine?.alarmActive) {
                    setBlockReason(ALARM_REASONS.find((a) => a.id === assignedMachine.alarmReason)?.label || "Alarm");
                    setPhase("blocked"); return;
                }
                overridePinRef.current = sd.appConfig?.overridePin || "";
                const match = planned && assignedMachineId === planned.id;
                setIsOverride(!match);
                setPhase(match ? "job_confirm" : "mismatch");
            } else {
                setPhase("job_confirm");
            }
        }
    }

    async function checkMachineAndStart() {
        setPhase("loading");
        const { data, error } = await supabase
            .from("schedule_state").select("data").eq("id", 1).single();
        if (error || !data?.data) { setPhase("error"); setErrorMsg("Failed to load data."); return; }
        const sd = data.data;
        const users = sd.users || [];
        const currentUser = users.find((u) => u.username.toLowerCase() === uname.toLowerCase());
        const assignedMachineId = currentUser?.assignedMachineId || null;
        if (!assignedMachineId) { setPhase("no_machine"); return; }
        const assignedMachine = (sd.resources || []).find((r) => r.id === assignedMachineId) || null;
        setResource(assignedMachine);
        if (assignedMachine?.alarmActive) {
            setBlockReason(ALARM_REASONS.find((a) => a.id === assignedMachine.alarmReason)?.label || "Alarm");
            setPhase("blocked"); return;
        }
        const freshJob = (sd.jobs || []).find((jj) => jj.id === id);
        const planned = freshJob ? (sd.resources || []).find((r) => r.id === freshJob.resourceId) || null : plannedRes;
        if (freshJob) { setJob(freshJob); setPlannedRes(planned); }
        overridePinRef.current = sd.appConfig?.overridePin || "";
        const match = planned && assignedMachineId === planned.id;
        setIsOverride(!match);
        setChosenAction("start");
        setPhase(match ? "job_confirm" : "mismatch");
    }

    async function handleConfirmJob() {
        setPhase("working");
        const { data, error } = await supabase
            .from("schedule_state").select("data").eq("id", 1).single();
        if (error || !data?.data) { setPhase("error"); setErrorMsg("Failed to save. Please try again."); return; }
        const nowIso = new Date().toISOString();
        const toolHistory = Array.isArray(data.data.toolHistory) ? data.data.toolHistory.map((h) => ({ ...h })) : [];
        function upsertTool(number, name, hoursToAdd, jobName) {
            if (!name || hoursToAdd <= 0) return;
            const idx = toolHistory.findIndex((h) => (h.number || null) === (number || null) && h.name === name);
            if (idx === -1) { toolHistory.push({ number: number || null, name, actualHours: hoursToAdd, lastRunAt: nowIso, jobNames: jobName ? [jobName] : [] }); return; }
            const ex = toolHistory[idx];
            const jn = ex.jobNames ? [...ex.jobNames] : [];
            if (jobName && !jn.includes(jobName)) { jn.push(jobName); if (jn.length > 20) jn.shift(); }
            toolHistory[idx] = { ...ex, actualHours: (ex.actualHours || 0) + hoursToAdd, lastRunAt: nowIso, jobNames: jn };
        }
        const effectiveAction = chosenAction || action;
        const jobs = (data.data.jobs || []).map((j) => {
            if (j.id !== id) return j;
            if (effectiveAction === "start") {
                return { ...j, isRunning: true, runStartedAt: nowIso, lastScanAt: nowIso, completed: false, actualResourceId: isOverride && resource ? resource.id : null };
            }
            const elapsedH = j.runStartedAt ? Math.max(0, (Date.now() - new Date(j.runStartedAt).getTime()) / 3600000) : 0;
            const jt = Array.isArray(j.tools) ? j.tools : [];
            const est = jt.reduce((s, t) => s + (t.hours || 0), 0);
            const updTools = jt.map((t) => {
                const share = est > 0 ? (t.hours || 0) / est : jt.length ? 1 / jt.length : 0;
                const h = elapsedH * share;
                upsertTool(t.number, t.name, h, j.name);
                return { ...t, actualHours: (t.actualHours || 0) + h };
            });
            return { ...j, isRunning: false, completed: true, runStartedAt: null, lastScanAt: nowIso, actualRunHours: (j.actualRunHours || 0) + elapsedH, tools: jt.length > 0 ? updTools : j.tools };
        });
        const { error: ue } = await supabase.from("schedule_state")
            .update({ data: { ...data.data, jobs, toolHistory }, updated_at: nowIso }).eq("id", 1);
        if (ue) { setPhase("error"); setErrorMsg("Failed to save. Please try again."); return; }
        setPhase("done");
    }

    async function handleConfirmAlarm() {
        setPhase("working");
        const { data, error } = await supabase
            .from("schedule_state").select("data").eq("id", 1).single();
        if (error || !data?.data) { setPhase("error"); setErrorMsg("Failed to save. Please try again."); return; }
        const resources = (data.data.resources || []).map((r) =>
            r.id !== id ? r : action === "raise"
                ? { ...r, alarmActive: true, alarmReason, alarmAt: Date.now() }
                : { ...r, alarmActive: false, alarmReason: null, alarmAt: null }
        );
        const { error: ue } = await supabase.from("schedule_state")
            .update({ data: { ...data.data, resources }, updated_at: new Date().toISOString() }).eq("id", 1);
        if (ue) { setPhase("error"); setErrorMsg("Failed to save. Please try again."); return; }
        setPhase("done");
    }

    async function handleOverrideClick() {
        setPinInput(""); setPinError("");
        try {
            const { data } = await supabase.from("schedule_state").select("data").eq("id", 1).single();
            overridePinRef.current = data?.data?.appConfig?.overridePin || "";
        } catch {}
        overridePinRef.current ? setShowPinModal(true) : setPhase("job_confirm");
    }

    function checkPin() {
        const entered = pinInput.trim();
        if (entered === overridePinRef.current) {
            setShowPinModal(false); setPhase("job_confirm");
        } else {
            setPinError("Incorrect PIN — try again"); setPinInput("");
        }
    }

    const effectiveAction = chosenAction || action;
    const isStart = kind === "job" && effectiveAction === "start";
    const isStop  = kind === "job" && effectiveAction === "stop";
    const isRaise = kind === "alarm" && action === "raise";
    const isClear = kind === "alarm" && action === "clear";
    const doneIsGreen = isStart || isClear;

    const roleColor = urole === "admin" ? BLUE : urole === "operator" ? GREEN : "#6E6E6E";
    const roleLabel = urole === "admin" ? "Admin" : urole === "operator" ? "Operator" : "Viewer";

    return (
        <div style={S.shell}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap');
                * { -webkit-tap-highlight-color: transparent; }
                @keyframes spin   { to { transform:rotate(360deg); } }
                @keyframes fadeUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
                @keyframes pulse  { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
                .sa-spin   { animation: spin 1s linear infinite; }
                .sa-fade   { animation: fadeUp 0.25s ease; }
                .sa-pulse  { animation: pulse 1.6s ease-in-out infinite; }
                .sa-btn    { transition: filter 0.12s, transform 0.1s; }
                .sa-btn:active { filter: brightness(0.88); transform: scale(0.97); }
                .sa-ghost:active { background: #E8E8E8 !important; }
            `}</style>

            {/* ── Top bar ── */}
            <div style={S.topBar}>
                <button onClick={onDone} style={S.backBtn}>
                    <ChevronLeft size={18} strokeWidth={2.5} />
                </button>
                <span style={S.topBarTitle}>ProdSched</span>
                {uname ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ ...S.avatar, background: roleColor }}>
                            {uname.charAt(0).toUpperCase()}
                        </div>
                        <div style={{ lineHeight: 1.2 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1A1A" }}>{uname}</div>
                            <div style={{ fontSize: 10, color: roleColor, fontWeight: 600 }}>{roleLabel}</div>
                        </div>
                    </div>
                ) : <div style={{ width: 32 }} />}
            </div>

            {/* ── Card ── */}
            <div style={S.scroll}>
                <div style={S.card} className="sa-fade" key={phase}>

                    {/* Loading */}
                    {phase === "loading" && (
                        <div style={S.centerCol}>
                            <Loader2 className="sa-spin" size={44} color={BLUE} />
                            <div style={S.loadingText}>Loading...</div>
                        </div>
                    )}

                    {/* No machine assigned */}
                    {phase === "no_machine" && (
                        <>
                            <div style={{ ...S.statusPill, background: "#FEF3C7", color: AMBER }}>
                                ⚠ No machine assigned
                            </div>
                            <div style={{ ...S.iconCircle, background: "#FEF3C7" }}>
                                <Cpu size={32} color={AMBER} strokeWidth={2} />
                            </div>
                            {job?.name && <div style={S.jobName}>{job.name}</div>}
                            <div style={S.sectionTitle}>Contact your Admin</div>
                            <div style={S.bodyText}>
                                Your account is not assigned to any machine. Ask your Admin to assign a machine before scanning jobs.
                            </div>
                            <button className="sa-btn" style={S.btnPrimary("#1B6E8C")} onClick={onDone}>
                                Back to Schedule
                            </button>
                        </>
                    )}

                    {/* Mismatch */}
                    {phase === "mismatch" && job && (
                        <>
                            <div style={{ ...S.statusPill, background: "#FEF3C7", color: AMBER }}>
                                ⚠ Machine mismatch
                            </div>
                            <div style={{ ...S.iconCircle, background: "#FEF3C7" }}>
                                <AlertCircle size={32} color={AMBER} strokeWidth={2} />
                            </div>
                            <div style={S.jobName}>{job.name}</div>
                            <div style={S.infoTable}>
                                <div style={S.infoRow}>
                                    <span style={S.infoLabel}>Your machine</span>
                                    <span style={{ ...S.infoVal, color: AMBER }}>{resource?.name || "—"}</span>
                                </div>
                                <div style={{ ...S.infoRow, borderTop: "1px solid #F0F0F0", paddingTop: 8 }}>
                                    <span style={S.infoLabel}>Planned machine</span>
                                    <span style={{ ...S.infoVal, color: GREEN_D }}>{plannedRes?.name || "Unassigned"}</span>
                                </div>
                            </div>
                            <div style={S.warnBox}>
                                This job is scheduled on <b>{plannedRes?.name || "another machine"}</b>. Verify with your Supervisor before proceeding.
                            </div>
                            <div style={S.btnStack}>
                                <button className="sa-btn" style={S.btnPrimary(AMBER)} onClick={handleOverrideClick}>
                                    Override &amp; Start
                                </button>
                                <button className="sa-ghost sa-btn" style={S.btnGhost} onClick={onDone}>Cancel</button>
                            </div>
                        </>
                    )}

                    {/* Choose start / stop */}
                    {phase === "choose_action" && job && (
                        <>
                            <div style={{ ...S.iconCircle, background: job.isRunning ? "#FFF1EF" : "#EDFAF3", width: 80, height: 80 }}>
                                {job.isRunning
                                    ? <Square size={36} color={RED} strokeWidth={2} />
                                    : <Play  size={36} color={GREEN} strokeWidth={2} />}
                            </div>
                            <div style={S.jobName}>{job.name}</div>
                            <div style={S.jobMeta}>{plannedRes?.name || "Unassigned"} · {job.product}</div>

                            <div style={{ ...S.statusPill, background: job.isRunning ? "#E8FFF3" : "#F5F5F5", color: job.isRunning ? GREEN_D : "#666", marginTop: 4 }}>
                                <span style={{ width: 7, height: 7, borderRadius: "50%", background: job.isRunning ? GREEN : "#ABABAB", display: "inline-block", flexShrink: 0 }} />
                                {job.isRunning ? "Currently running" : "Not started"}
                            </div>

                            <div style={S.chooseLabel}>What would you like to do?</div>

                            <div style={S.bigBtnRow}>
                                <button
                                    className="sa-btn"
                                    disabled={!!job.isRunning}
                                    style={{ ...S.bigBtn, background: job.isRunning ? "#E8E8E8" : GREEN, color: job.isRunning ? "#ABABAB" : "#fff", cursor: job.isRunning ? "not-allowed" : "pointer" }}
                                    onClick={checkMachineAndStart}
                                >
                                    <Play size={22} strokeWidth={2.5} />
                                    <span>START</span>
                                </button>
                                <button
                                    className="sa-btn"
                                    disabled={!job.isRunning}
                                    style={{ ...S.bigBtn, background: !job.isRunning ? "#E8E8E8" : RED, color: !job.isRunning ? "#ABABAB" : "#fff", cursor: !job.isRunning ? "not-allowed" : "pointer" }}
                                    onClick={() => { setChosenAction("stop"); setPhase("job_confirm"); }}
                                >
                                    <Square size={22} strokeWidth={2.5} />
                                    <span>STOP</span>
                                </button>
                            </div>
                        </>
                    )}

                    {/* Job confirm */}
                    {phase === "job_confirm" && job && (
                        <>
                            <div style={{ ...S.iconCircle, background: isStart ? "#EDFAF3" : "#FFF1EF", width: 80, height: 80 }}>
                                {isStart
                                    ? <Play  size={36} color={GREEN} strokeWidth={2} />
                                    : <Square size={36} color={RED}   strokeWidth={2} />}
                            </div>
                            <div style={S.jobName}>{job.name}</div>
                            <div style={S.jobMeta}>{resource?.name || plannedRes?.name || "—"} · {job.product}</div>
                            {isOverride && resource && (
                                <div style={{ ...S.warnBox, marginTop: 4 }}>
                                    ⚠ Override — running on <b>{resource.name}</b> instead of planned <b>{plannedRes?.name}</b>
                                </div>
                            )}
                            <div style={S.confirmQuestion}>
                                Confirm {isStart ? "START" : "STOP"} this job?
                            </div>
                            <div style={S.btnStack}>
                                <button className="sa-btn" style={S.btnPrimary(isStart ? GREEN : RED)} onClick={handleConfirmJob}>
                                    {isStart ? "Yes, Start" : "Yes, Stop"}
                                </button>
                                <button className="sa-ghost sa-btn" style={S.btnGhost} onClick={onDone}>Cancel</button>
                            </div>
                        </>
                    )}

                    {/* Alarm confirm */}
                    {phase === "alarm_confirm" && resource && (
                        <>
                            <div style={{ ...S.iconCircle, background: isRaise ? "#FFF0EF" : "#EDFAF3", width: 80, height: 80 }}>
                                {isRaise
                                    ? <AlertOctagon size={36} color={RED}   strokeWidth={2} />
                                    : <CheckCircle2  size={36} color={GREEN} strokeWidth={2} />}
                            </div>
                            <div style={S.jobName}>{resource.name}</div>
                            <div style={S.jobMeta}>{resource.type}</div>
                            <div style={S.confirmQuestion}>
                                {isRaise ? "Raise alarm on this machine?" : "Clear alarm on this machine?"}
                            </div>
                            {isRaise && (
                                <select
                                    value={alarmReason}
                                    onChange={(e) => setAlarmReason(e.target.value)}
                                    style={S.select}
                                >
                                    {ALARM_REASONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                                </select>
                            )}
                            <div style={S.btnStack}>
                                <button className="sa-btn" style={S.btnPrimary(isRaise ? RED : GREEN)} onClick={handleConfirmAlarm}>
                                    {isRaise ? "Confirm Alarm" : "Confirm Clear"}
                                </button>
                                <button className="sa-ghost sa-btn" style={S.btnGhost} onClick={onDone}>Cancel</button>
                            </div>
                        </>
                    )}

                    {/* Blocked */}
                    {phase === "blocked" && (
                        <>
                            <div style={{ ...S.iconCircle, background: "#FFF0EF", width: 80, height: 80 }}>
                                <AlertOctagon size={36} color={RED} strokeWidth={2} />
                            </div>
                            {job?.name && <div style={S.jobName}>{job.name}</div>}
                            <div style={{ ...S.sectionTitle, color: RED_D }}>Cannot Start</div>
                            <div style={S.infoTable}>
                                <div style={S.infoRow}>
                                    <span style={S.infoLabel}>Machine</span>
                                    <span style={{ ...S.infoVal, color: RED_D }}>{resource?.name}</span>
                                </div>
                                <div style={{ ...S.infoRow, borderTop: "1px solid #F0F0F0", paddingTop: 8 }}>
                                    <span style={S.infoLabel}>Active alarm</span>
                                    <span style={{ ...S.infoVal, color: RED_D }}>{blockReason}</span>
                                </div>
                            </div>
                            <div style={S.bodyText}>Clear the alarm on this machine before starting a job.</div>
                            <button className="sa-btn" style={S.btnPrimary(BLUE)} onClick={onDone}>Back to Schedule</button>
                        </>
                    )}

                    {/* Working */}
                    {phase === "working" && (
                        <div style={S.centerCol}>
                            <Loader2 className="sa-spin" size={44} color={BLUE} />
                            <div style={S.loadingText}>Saving...</div>
                        </div>
                    )}

                    {/* Done */}
                    {phase === "done" && (
                        <>
                            <div style={{ ...S.iconCircle, background: doneIsGreen ? "#EDFAF3" : "#FFF0EF", width: 80, height: 80 }}>
                                {doneIsGreen
                                    ? <CheckCircle2 size={36} color={GREEN} strokeWidth={2} />
                                    : isStop ? <XCircle size={36} color={RED} strokeWidth={2} />
                                    : isRaise ? <AlertOctagon size={36} color={RED} strokeWidth={2} />
                                    : <CheckCircle2 size={36} color={GREEN} strokeWidth={2} />}
                            </div>
                            <div style={S.jobName}>{job?.name || resource?.name}</div>
                            <div style={{ ...S.sectionTitle, color: doneIsGreen ? GREEN_D : RED_D, fontSize: 22 }}>
                                {isStop ? "Job Stopped" : isRaise ? "Alarm Raised" : isClear ? "Alarm Cleared" : "Job Started"}
                            </div>
                            <div style={S.bodyText}>{new Date().toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", year: "numeric" })}</div>
                            <button className="sa-btn" style={{ ...S.btnPrimary(BLUE), marginTop: 8 }} onClick={onDone}>
                                Back to Schedule
                            </button>
                        </>
                    )}

                    {/* Error */}
                    {phase === "error" && (
                        <>
                            <div style={{ ...S.iconCircle, background: "#FFF0EF", width: 80, height: 80 }}>
                                <AlertTriangle size={36} color={RED} strokeWidth={2} />
                            </div>
                            <div style={{ ...S.sectionTitle, color: RED_D }}>Something went wrong</div>
                            <div style={S.bodyText}>{errorMsg}</div>
                            <button className="sa-btn" style={S.btnPrimary(BLUE)} onClick={() => { setPhase("loading"); load(); }}>
                                Try again
                            </button>
                            <button className="sa-ghost sa-btn" style={{ ...S.btnGhost, marginTop: 8 }} onClick={onDone}>Cancel</button>
                        </>
                    )}

                </div>
            </div>

            {/* ── PIN Modal ── */}
            {showPinModal && (
                <div style={S.overlay}>
                    <div style={S.modal}>
                        <div style={{ ...S.iconCircle, background: "#FEF3C7", width: 56, height: 56, margin: "0 auto 16px" }}>
                            <Lock size={24} color={AMBER} strokeWidth={2} />
                        </div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: "#1A1A1A", marginBottom: 6 }}>Supervisor PIN</div>
                        <div style={{ fontSize: 13, color: "#6E6E6E", marginBottom: 20, lineHeight: 1.5 }}>
                            This job runs on a different machine than planned. Enter Supervisor PIN to override.
                        </div>
                        <input
                            type="password"
                            inputMode="numeric"
                            maxLength={8}
                            value={pinInput}
                            onChange={(e) => { setPinInput(e.target.value.replace(/\D/g, "")); setPinError(""); }}
                            onKeyDown={(e) => { if (e.key === "Enter") checkPin(); }}
                            autoFocus
                            style={{ ...S.pinInput, borderColor: pinError ? RED : "#D0D0D0" }}
                            placeholder="••••"
                            autoComplete="off"
                        />
                        {pinError && (
                            <div style={{ fontSize: 12.5, color: RED_D, background: "#FEF2F2", border: `1px solid ${RED}44`, borderRadius: 8, padding: "8px 12px", marginBottom: 12, width: "100%", boxSizing: "border-box" }}>
                                {pinError}
                            </div>
                        )}
                        <button className="sa-btn" style={{ ...S.btnPrimary(AMBER), width: "100%", marginBottom: 10 }} onClick={checkPin}>
                            Confirm
                        </button>
                        <button className="sa-ghost sa-btn" style={{ ...S.btnGhost, width: "100%" }}
                            onClick={() => { setShowPinModal(false); setPinInput(""); setPinError(""); }}>
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export function broadcastJobScan(jobId) {
    try { const ch = new BroadcastChannel("ps-scan"); ch.postMessage({ jobId }); ch.close(); } catch {}
}

// ── Styles ──────────────────────────────────────────────────────────────────
const S = {
    shell:   { minHeight: "100dvh", background: "#F0F2F5", fontFamily: "'Inter', 'Segoe UI', sans-serif", display: "flex", flexDirection: "column" },
    topBar:  { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#FFFFFF", borderBottom: "1px solid #EBEBEB", position: "sticky", top: 0, zIndex: 10, boxShadow: "0 1px 8px rgba(0,0,0,0.05)" },
    backBtn: { width: 36, height: 36, borderRadius: 10, border: "1px solid #E5E5E5", background: "#FAFAFA", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#444", flexShrink: 0 },
    topBarTitle: { fontSize: 15, fontWeight: 800, color: "#1B6E8C", letterSpacing: "0.01em", fontFamily: "'IBM Plex Mono', monospace" },
    avatar:  { width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: "'IBM Plex Mono', monospace", flexShrink: 0 },

    scroll:  { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 16px 40px", overflowY: "auto" },
    card:    { width: "100%", maxWidth: 420, background: "#FFFFFF", borderRadius: 20, padding: "32px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, boxShadow: "0 4px 24px rgba(0,0,0,0.08)", boxSizing: "border-box", textAlign: "center" },

    centerCol:   { display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "20px 0" },
    loadingText: { fontSize: 15, fontWeight: 600, color: "#6E6E6E" },

    statusPill:  { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, padding: "5px 12px", borderRadius: 20, letterSpacing: "0.02em" },
    iconCircle:  { width: 68, height: 68, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
    jobName:     { fontSize: 22, fontWeight: 800, color: "#1A1A1A", fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "-0.01em", lineHeight: 1.2, marginTop: 4 },
    jobMeta:     { fontSize: 13, color: "#888", fontWeight: 500, marginTop: -4 },
    sectionTitle: { fontSize: 18, fontWeight: 700, color: "#1A1A1A", marginTop: 4 },
    bodyText:    { fontSize: 13.5, color: "#6E6E6E", lineHeight: 1.6, maxWidth: 320 },
    confirmQuestion: { fontSize: 16, fontWeight: 700, color: "#1A1A1A", marginTop: 8 },
    chooseLabel: { fontSize: 14, fontWeight: 600, color: "#888", marginTop: 4 },

    infoTable: { width: "100%", background: "#FAFAFA", border: "1px solid #EBEBEB", borderRadius: 12, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8, textAlign: "left" },
    infoRow:   { display: "flex", justifyContent: "space-between", alignItems: "center" },
    infoLabel: { fontSize: 13, color: "#888", fontWeight: 500 },
    infoVal:   { fontSize: 13, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" },

    warnBox:   { width: "100%", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#78350F", textAlign: "left", lineHeight: 1.6, boxSizing: "border-box" },

    bigBtnRow: { display: "flex", gap: 12, width: "100%", marginTop: 8 },
    bigBtn:    { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, border: "none", borderRadius: 16, padding: "20px 12px", fontSize: 15, fontWeight: 800, cursor: "pointer", letterSpacing: "0.04em", minHeight: 90 },

    btnStack: { display: "flex", flexDirection: "column", gap: 10, width: "100%", marginTop: 8 },
    btnPrimary: (bg) => ({ width: "100%", background: bg, color: "#fff", border: "none", borderRadius: 14, padding: "16px 0", fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }),
    btnGhost:  { width: "100%", background: "#F5F5F5", color: "#555", border: "none", borderRadius: 14, padding: "15px 0", fontSize: 14, fontWeight: 600, cursor: "pointer" },

    select:    { width: "100%", background: "#FAFAFA", border: "1px solid #D5D5D5", borderRadius: 12, padding: "12px 14px", fontSize: 14, color: "#1A1A1A", cursor: "pointer", marginTop: 4, boxSizing: "border-box" },

    overlay:   { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 999, padding: "0 0 env(safe-area-inset-bottom, 0)" },
    modal:     { background: "#FFFFFF", borderRadius: "24px 24px 0 0", padding: "28px 24px 36px", width: "100%", maxWidth: 480, boxSizing: "border-box", textAlign: "center" },
    pinInput:  { width: "100%", boxSizing: "border-box", border: "2px solid #D0D0D0", borderRadius: 14, padding: "18px 16px", fontSize: 32, letterSpacing: 16, textAlign: "center", fontFamily: "'IBM Plex Mono', monospace", outline: "none", marginBottom: 12, background: "#FAFAFA" },
};