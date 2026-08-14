/**
 * ScanAction.jsx — QR scan landing page
 *
 * Reads URL params directly (App.jsx must NOT pass kind/action/id props):
 *   /?scan=start&job=<id>
 *   /?scan=stop&job=<id>
 *   /?alarm=raise&resource=<id>
 *   /?alarm=clear&resource=<id>
 *
 * Flow:
 *   START/STOP : loading → confirm → processing → done | error
 *   ALARM RAISE: loading → alarm_reason → processing → done | error
 *   ALARM CLEAR: loading → confirm → processing → done | error
 */

import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import {
    Play, Square, AlertOctagon, CheckCircle,
    ArrowLeft, AlertTriangle, Loader, Cpu, Clock,
    Wrench, Package, HelpCircle, Bell,
} from "lucide-react";

// ─── constants ────────────────────────────────────────────────────────────────

const ALARM_REASONS = [
    { id: "breakdown", label: "Machine breakdown",  icon: Wrench   },
    { id: "material",  label: "Material shortage",  icon: Package  },
    { id: "quality",   label: "Quality issue",      icon: AlertTriangle },
    { id: "other",     label: "Assistance needed",  icon: HelpCircle },
];

// ─── helpers ──────────────────────────────────────────────────────────────────

function getParam(key) {
    return new URLSearchParams(window.location.search).get(key);
}

async function loadState() {
    const { data, error } = await supabase
        .from("schedule_state").select("data").eq("id", 1).single();
    if (error) throw new Error("Cannot reach database");
    return data?.data || {};
}

async function saveState(newData) {
    const { error } = await supabase
        .from("schedule_state")
        .update({ data: newData, updated_at: new Date().toISOString() })
        .eq("id", 1);
    if (error) throw new Error("Save failed: " + error.message);
}

function fmtHours(h) {
    if (h == null) return "—";
    const totalMin = Math.round(h * 60);
    const hr = Math.floor(totalMin / 60);
    const mn = totalMin % 60;
    return hr > 0 ? `${hr}h ${mn}m` : `${mn}m`;
}

function getCurrentUser(stateData) {
    const username = sessionStorage.getItem("ps-username");
    const userId   = sessionStorage.getItem("ps-user-id");
    return (stateData.users || []).find(
        (u) => u.id === userId || u.username === username
    ) || null;
}

function checkMachine(user, jobResourceId, resources) {
    if (!user || user.role !== "operator" || !user.machineId)
        return { allowed: true, assignedMachineName: null, jobMachineName: null };
    const aM = resources.find((r) => r.id === user.machineId);
    const jM = resources.find((r) => r.id === jobResourceId);
    return {
        allowed: user.machineId === jobResourceId,
        assignedMachineName: aM ? aM.name : user.machineId,
        jobMachineName: jM ? jM.name : (jobResourceId || "Unassigned"),
    };
}

// ─── component ────────────────────────────────────────────────────────────────

export default function ScanAction() {
    const scanType   = getParam("scan");
    const alarmType  = getParam("alarm");
    const jobId      = getParam("job");
    const resourceId = getParam("resource");

    const [phase, setPhase]           = useState("loading");
    const [stateSnap, setStateSnap]   = useState(null);
    const [job, setJob]               = useState(null);
    const [alarmResource, setAlarmResource] = useState(null);
    const [currentUser, setCurrentUser]     = useState(null);
    const [machineInfo, setMachineInfo]     = useState(null);
    const [alarmReason, setAlarmReason]     = useState("breakdown");
    const [saving, setSaving]         = useState(false);
    const [doneMsg, setDoneMsg]       = useState("");
    const [errorMsg, setErrorMsg]     = useState("");

    const username    = sessionStorage.getItem("ps-username") || "—";
    const isStart     = scanType === "start";
    const isStop      = scanType === "stop";
    const isAlarmRaise = alarmType === "raise";
    const isAlarmClear = alarmType === "clear";

    useEffect(() => {
        (async () => {
            try {
                const state = await loadState();
                setStateSnap(state);
                const user = getCurrentUser(state);
                setCurrentUser(user);
                const resources = state.resources || [];

                if ((isAlarmRaise || isAlarmClear) && resourceId) {
                    const res = resources.find((r) => r.id === resourceId);
                    setAlarmResource(res || { id: resourceId, name: resourceId });
                    // raise → pick reason first; clear → straight to confirm
                    setPhase(isAlarmRaise ? "alarm_reason" : "confirm");
                    return;
                }

                if ((isStart || isStop) && jobId) {
                    const found = (state.jobs || []).find((j) => j.id === jobId);
                    if (!found) { setErrorMsg("Job not found"); setPhase("error"); return; }
                    setJob(found);
                    setMachineInfo(checkMachine(user, found.resourceId, resources));
                    setPhase("confirm");
                    return;
                }

                setErrorMsg("Unknown QR action");
                setPhase("error");
            } catch (e) {
                setErrorMsg(e.message || "Unexpected error");
                setPhase("error");
            }
        })();
    }, []);

    // ── save alarm ──
    async function executeAlarm() {
        setSaving(true);
        try {
            const state = stateSnap;
            const resources = (state.resources || []).map((r) => {
                if (r.id !== resourceId) return r;
                return isAlarmRaise
                    ? { ...r, alarmActive: true,  alarmReason, status: "alarm" }
                    : { ...r, alarmActive: false, alarmReason: null, status: "idle" };
            });
            await saveState({ ...state, resources });
            setDoneMsg(isAlarmRaise
                ? `Alarm raised · ${ALARM_REASONS.find((a) => a.id === alarmReason)?.label}`
                : `Alarm cleared on ${alarmResource?.name}`
            );
            setPhase("done");
        } catch (e) {
            setErrorMsg(e.message);
            setPhase("error");
        } finally {
            setSaving(false);
        }
    }

    // ── save job scan ──
    async function executeScan(override = false) {
        setSaving(true);
        try {
            const state = stateSnap;
            const nowISO = new Date().toISOString();
            const nowMs  = Date.now();
            let updatedJob;

            if (isStart) {
                updatedJob = { ...job, isRunning: true, runStartedAt: nowISO, completed: false };
                if (override) updatedJob.actualResourceId = job.resourceId;
            } else {
                const runHours = job.runStartedAt
                    ? Math.max(0, (nowMs - new Date(job.runStartedAt).getTime()) / 3600000)
                    : null;
                updatedJob = { ...job, isRunning: false, completed: true, actualRunHours: runHours };
                if (typeof window.__psLogToolChange === "function") {
                    try { window.__psLogToolChange({ jobId: job.id, jobName: job.name, resourceId: job.resourceId }); } catch (_) {}
                }
            }
            const jobs = (state.jobs || []).map((j) => (j.id === job.id ? updatedJob : j));
            await saveState({ ...state, jobs });
            setDoneMsg(isStart ? "Job started" : "Job completed");
            setPhase("done");
        } catch (e) {
            setErrorMsg(e.message || "Save failed");
            setPhase("error");
        } finally {
            setSaving(false);
        }
    }

    // ── derived ──
    const resources  = stateSnap?.resources || [];
    const jobMachine = job ? resources.find((r) => r.id === job.resourceId) : null;
    const userMachine = currentUser?.machineId ? resources.find((r) => r.id === currentUser.machineId) : null;
    const elapsedMin = (isStop && job?.runStartedAt)
        ? Math.round((Date.now() - new Date(job.runStartedAt).getTime()) / 60000) : null;

    const accentColor = isStart ? "#21A366" : isStop ? "#C4372E"
        : isAlarmRaise ? "#D97706" : "#21A366";

    // ─── render ──────────────────────────────────────────────────────────────
    return (
        <div style={S.wrap}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&display=swap');
                *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
                html, body { background: #0F172A; font-family: 'Segoe UI', sans-serif; }
                @keyframes spin { to { transform: rotate(360deg); } }
                @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
                .sa-btn:active { opacity: 0.82; transform: scale(0.97); }
                .sa-reason:hover { border-color: #475569 !important; background: #1E293B !important; }
                .sa-reason.selected { border-color: #D97706 !important; background: #1C1400 !important; }
            `}</style>

            <div style={S.card}>
                {/* top bar */}
                <div style={S.topBar}>
                    <span style={S.appName}>ProdSched</span>
                    <div style={S.userChip}>
                        <div style={S.avatar}>{username.charAt(0).toUpperCase()}</div>
                        <div>
                            <div style={S.uName}>{username}</div>
                            {userMachine && (
                                <div style={S.uMachine}><Cpu size={9}/> {userMachine.name}</div>
                            )}
                        </div>
                    </div>
                </div>

                <div style={S.body}>

                    {/* LOADING */}
                    {phase === "loading" && (
                        <div style={S.center}>
                            <Loader size={32} color="#475569" style={{ animation: "spin 1s linear infinite" }}/>
                            <div style={S.dim}>Loading…</div>
                        </div>
                    )}

                    {/* ALARM REASON PICKER */}
                    {phase === "alarm_reason" && alarmResource && (
                        <div style={{ animation: "fadeUp 0.2s ease" }}>
                            <div style={S.actionHead}>
                                <div style={{ ...S.actionIcon, background: "#D97706" }}>
                                    <Bell size={18} color="#fff"/>
                                </div>
                                <div>
                                    <div style={S.actionTitle}>Raise Alarm</div>
                                    <div style={S.actionSub}>{alarmResource.name}</div>
                                </div>
                            </div>

                            <div style={S.sectionLabel}>Select reason</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                                {ALARM_REASONS.map((r) => {
                                    const Icon = r.icon;
                                    const sel  = alarmReason === r.id;
                                    return (
                                        <button key={r.id}
                                            className={`sa-reason${sel ? " selected" : ""}`}
                                            style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, border: `1px solid ${sel ? "#D97706" : "#334155"}`, background: sel ? "#1C1400" : "#0F172A", cursor: "pointer", textAlign: "left", transition: "all 0.12s" }}
                                            onClick={() => setAlarmReason(r.id)}>
                                            <div style={{ width: 32, height: 32, borderRadius: 8, background: sel ? "#D97706" : "#1E293B", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.12s" }}>
                                                <Icon size={15} color={sel ? "#fff" : "#64748B"}/>
                                            </div>
                                            <span style={{ fontSize: 14, fontWeight: sel ? 700 : 500, color: sel ? "#FCD34D" : "#94A3B8" }}>{r.label}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <button className="sa-btn"
                                    style={{ ...S.btnPrimary, background: "#D97706" }}
                                    disabled={saving}
                                    onClick={() => executeAlarm()}>
                                    {saving ? <Loader size={15} style={{ animation: "spin 1s linear infinite" }}/> : <Bell size={15}/>}
                                    {saving ? "Saving…" : "Confirm Alarm"}
                                </button>
                                <button className="sa-btn" style={S.btnSecondary} onClick={() => window.history.back()}>
                                    <ArrowLeft size={15}/> Cancel
                                </button>
                            </div>
                        </div>
                    )}

                    {/* CONFIRM — job start/stop or alarm clear */}
                    {phase === "confirm" && (
                        <div style={{ animation: "fadeUp 0.2s ease" }}>

                            {/* action header */}
                            <div style={S.actionHead}>
                                <div style={{ ...S.actionIcon, background: accentColor }}>
                                    {isStart  && <Play size={18} color="#fff" fill="#fff"/>}
                                    {isStop   && <Square size={18} color="#fff" fill="#fff"/>}
                                    {(isAlarmClear) && <CheckCircle size={18} color="#fff"/>}
                                </div>
                                <div>
                                    <div style={S.actionTitle}>
                                        {isStart ? "Start Job" : isStop ? "Stop Job" : "Clear Alarm"}
                                    </div>
                                    <div style={S.actionSub}>Confirm before proceeding</div>
                                </div>
                            </div>

                            {/* job card or alarm card */}
                            {(isStart || isStop) && job && (
                                <div style={S.infoCard}>
                                    <div style={S.sectionLabel}>Job</div>
                                    <div style={{ fontSize: 17, fontWeight: 700, color: "#F8FAFC", marginBottom: 12 }}>{job.name}</div>
                                    <InfoRow icon={<Cpu size={13} color="#64748B"/>}   label="Machine" value={jobMachine ? jobMachine.name : "Unassigned"}/>
                                    <InfoRow icon={<Clock size={13} color="#64748B"/>} label="Planned"  value={fmtHours(job.duration)}/>
                                    {isStop && elapsedMin != null && (
                                        <InfoRow icon={<Clock size={13} color="#34D399"/>} label="Elapsed" value={fmtHours(elapsedMin / 60)} highlight/>
                                    )}
                                    {isStop && !job.isRunning && (
                                        <div style={{ fontSize: 12, color: "#F59E0B", marginTop: 6 }}>⚠ Job is not currently running</div>
                                    )}
                                </div>
                            )}

                            {isAlarmClear && alarmResource && (
                                <div style={S.infoCard}>
                                    <div style={S.sectionLabel}>Machine</div>
                                    <div style={{ fontSize: 17, fontWeight: 700, color: "#F8FAFC" }}>{alarmResource.name}</div>
                                </div>
                            )}

                            {/* machine mismatch */}
                            {machineInfo && !machineInfo.allowed && (
                                <div style={S.warnCard}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                                        <AlertTriangle size={15} color="#F59E0B"/>
                                        <span style={{ fontSize: 13, fontWeight: 700, color: "#FCD34D" }}>Wrong machine</span>
                                    </div>
                                    <WarnRow label="Your machine"  value={machineInfo.assignedMachineName} valueColor="#93C5FD"/>
                                    <WarnRow label="Job's machine" value={machineInfo.jobMachineName}      valueColor="#FCA5A5"/>
                                </div>
                            )}

                            {/* buttons */}
                            {machineInfo && !machineInfo.allowed ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <button className="sa-btn"
                                        style={{ ...S.btnPrimary, background: "#B45309" }}
                                        disabled={saving} onClick={() => executeScan(true)}>
                                        {saving ? <Loader size={15} style={{ animation: "spin 1s linear infinite" }}/> : <AlertTriangle size={15}/>}
                                        {saving ? "Saving…" : "Confirm anyway (override)"}
                                    </button>
                                    <button className="sa-btn" style={S.btnSecondary} onClick={() => window.history.back()}>
                                        <ArrowLeft size={15}/> Go back
                                    </button>
                                </div>
                            ) : (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <button className="sa-btn"
                                        style={{ ...S.btnPrimary, background: accentColor }}
                                        disabled={saving}
                                        onClick={() => (isAlarmClear ? executeAlarm() : executeScan(false))}>
                                        {saving
                                            ? <Loader size={15} style={{ animation: "spin 1s linear infinite" }}/>
                                            : isStart ? <Play size={15} fill="#fff"/>
                                            : isStop  ? <Square size={15} fill="#fff"/>
                                            : <CheckCircle size={15}/>}
                                        {saving ? "Saving…"
                                            : isStart ? "Confirm Start"
                                            : isStop  ? "Confirm Stop"
                                            : "Confirm Clear"}
                                    </button>
                                    <button className="sa-btn" style={S.btnSecondary} onClick={() => window.history.back()}>
                                        <ArrowLeft size={15}/> Cancel
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* DONE */}
                    {phase === "done" && (
                        <div style={{ ...S.center, animation: "fadeUp 0.2s ease" }}>
                            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#14532D", border: "2px solid #21A366", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                                <CheckCircle size={32} color="#21A366"/>
                            </div>
                            <div style={{ fontSize: 20, fontWeight: 700, color: "#F8FAFC", marginBottom: 6 }}>{doneMsg}</div>
                            {job && <div style={S.dim}>{job.name}</div>}
                            <button className="sa-btn" style={{ ...S.btnSecondary, marginTop: 24 }} onClick={() => window.history.back()}>
                                <ArrowLeft size={15}/> Back
                            </button>
                        </div>
                    )}

                    {/* ERROR */}
                    {phase === "error" && (
                        <div style={{ ...S.center, animation: "fadeUp 0.2s ease" }}>
                            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#450A0A", border: "2px solid #C4372E", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                                <AlertOctagon size={32} color="#C4372E"/>
                            </div>
                            <div style={{ fontSize: 16, fontWeight: 700, color: "#F8FAFC", marginBottom: 6 }}>{errorMsg}</div>
                            <button className="sa-btn" style={{ ...S.btnSecondary, marginTop: 20 }} onClick={() => window.history.back()}>
                                <ArrowLeft size={15}/> Back
                            </button>
                        </div>
                    )}

                </div>
            </div>
        </div>
    );
}

// ─── sub-components ───────────────────────────────────────────────────────────

function InfoRow({ icon, label, value, highlight }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            {icon}
            <span style={{ fontSize: 12, color: "#64748B", width: 56, flexShrink: 0 }}>{label}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: highlight ? "#34D399" : "#CBD5E1" }}>{value}</span>
        </div>
    );
}

function WarnRow({ label, value, valueColor }) {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
            <span style={{ fontSize: 12, color: "#92400E" }}>{label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: valueColor }}>{value}</span>
        </div>
    );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const S = {
    wrap:      { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0F172A", padding: 16 },
    card:      { width: "100%", maxWidth: 380, background: "#1E293B", borderRadius: 16, overflow: "hidden", boxShadow: "0 24px 48px rgba(0,0,0,0.5)", border: "1px solid #334155" },
    topBar:    { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #334155", background: "#0F172A" },
    appName:   { fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, fontSize: 12, color: "#1B6E8C", letterSpacing: 1 },
    userChip:  { display: "flex", alignItems: "center", gap: 8, background: "#1E293B", border: "1px solid #334155", borderRadius: 20, padding: "5px 10px 5px 5px" },
    avatar:    { width: 26, height: 26, borderRadius: "50%", background: "#1B6E8C", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#fff", flexShrink: 0 },
    uName:     { fontSize: 12, fontWeight: 600, color: "#E2E8F0" },
    uMachine:  { fontSize: 10, color: "#64748B", display: "flex", alignItems: "center", gap: 3, marginTop: 1 },
    body:      { padding: 20 },
    center:    { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "16px 0" },
    dim:       { fontSize: 13, color: "#64748B", marginTop: 6 },
    actionHead:{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 },
    actionIcon:{ width: 42, height: 42, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
    actionTitle:{ fontSize: 18, fontWeight: 700, color: "#F8FAFC" },
    actionSub: { fontSize: 12, color: "#64748B", marginTop: 2 },
    sectionLabel: { fontSize: 10, fontWeight: 700, color: "#475569", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10 },
    infoCard:  { background: "#0F172A", borderRadius: 10, border: "1px solid #334155", padding: "14px 16px", marginBottom: 14 },
    warnCard:  { background: "#451A03", border: "1px solid #92400E", borderRadius: 10, padding: "12px 14px", marginBottom: 14 },
    btnPrimary:{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "13px 16px", borderRadius: 10, border: "none", fontSize: 15, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: "'Segoe UI', sans-serif", transition: "opacity 0.15s, transform 0.1s" },
    btnSecondary: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "11px 16px", borderRadius: 10, border: "1px solid #334155", fontSize: 14, fontWeight: 600, color: "#94A3B8", background: "#0F172A", cursor: "pointer", fontFamily: "'Segoe UI', sans-serif", transition: "opacity 0.15s, transform 0.1s" },
};