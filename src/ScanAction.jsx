/**
 * ScanAction.jsx — QR scan landing page
 *
 * URL patterns handled:
 *   /?scan=start&job=<id>          → mark job as running
 *   /?scan=stop&job=<id>           → mark job as complete
 *   /?alarm=raise&resource=<id>    → raise alarm on machine
 *   /?alarm=clear&resource=<id>    → clear alarm on machine
 *
 * Machine-user validation:
 *   On every START/STOP scan, if the logged-in user (operator) has an
 *   assigned machineId, the system checks that job.resourceId matches.
 *   Mismatch → warning; operator must confirm override or go back.
 */

import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import {
    Play, Square, AlertOctagon, CheckCircle,
    ArrowLeft, AlertTriangle, Loader, ChevronRight,
} from "lucide-react";

// ─── helpers ────────────────────────────────────────────────────────────────

function getParam(key) {
    const p = new URLSearchParams(window.location.search);
    return p.get(key);
}

async function loadState() {
    const { data, error } = await supabase
        .from("schedule_state")
        .select("data")
        .eq("id", 1)
        .single();
    if (error) throw new Error("DB error: " + error.message);
    return data?.data || {};
}

async function saveState(newData) {
    const { error } = await supabase
        .from("schedule_state")
        .update({ data: newData, updated_at: new Date().toISOString() })
        .eq("id", 1);
    if (error) throw new Error("Save error: " + error.message);
}

// ─── machine check ───────────────────────────────────────────────────────────

async function checkUserMachine(jobResourceId, stateData) {
    // fast path: main app already loaded and exposed the helper
    if (typeof window.__psCheckUserMachine === "function") {
        return window.__psCheckUserMachine(jobResourceId);
    }
    // fallback: read directly from state blob
    const username = sessionStorage.getItem("ps-username");
    const userId   = sessionStorage.getItem("ps-user-id");
    const users     = stateData.users || [];
    const resources = stateData.resources || [];
    const user = users.find((u) => u.id === userId || u.username === username);
    if (!user || user.role !== "operator" || !user.machineId) {
        return { allowed: true, assignedMachineName: null, jobMachineName: null };
    }
    const assignedMachine = resources.find((r) => r.id === user.machineId);
    const jobMachine      = resources.find((r) => r.id === jobResourceId);
    return {
        allowed: user.machineId === jobResourceId,
        assignedMachineName: assignedMachine ? assignedMachine.name : user.machineId,
        jobMachineName: jobMachine ? jobMachine.name : (jobResourceId || "Unassigned"),
    };
}

// ─── component ───────────────────────────────────────────────────────────────

export default function ScanAction() {
    const scanType   = getParam("scan");    // "start" | "stop" | null
    const alarmType  = getParam("alarm");   // "raise" | "clear" | null
    const jobId      = getParam("job");
    const resourceId = getParam("resource");

    const [phase, setPhase]             = useState("loading");
    const [message, setMessage]         = useState("");
    const [detail, setDetail]           = useState("");
    const [machineWarn, setMachineWarn] = useState(null);
    const [stateSnap, setStateSnap]     = useState(null);

    useEffect(() => {
        (async () => {
            try {
                const state = await loadState();
                setStateSnap(state);

                // alarm actions
                if (alarmType && resourceId) {
                    await handleAlarm(state, alarmType, resourceId);
                    return;
                }

                // scan start/stop
                if ((scanType === "start" || scanType === "stop") && jobId) {
                    const job = (state.jobs || []).find((j) => j.id === jobId);
                    if (!job) { setPhase("error"); setMessage("Job not found"); return; }

                    const check = await checkUserMachine(job.resourceId, state);
                    if (!check.allowed) {
                        setMachineWarn({
                            assignedMachineName: check.assignedMachineName,
                            jobMachineName:      check.jobMachineName,
                            jobName:             job.name,
                        });
                        setPhase("machine_warning");
                        return;
                    }
                    await executeScan(state, job);
                    return;
                }

                setPhase("error");
                setMessage("Unknown QR action");

            } catch (e) {
                setPhase("error");
                setMessage(e.message || "Unexpected error");
            }
        })();
    }, []);

    async function handleAlarm(state, action, resId) {
        const resources = (state.resources || []).map((r) => {
            if (r.id !== resId) return r;
            return action === "raise"
                ? { ...r, alarmActive: true,  status: "alarm" }
                : { ...r, alarmActive: false, alarmReason: null, status: "idle" };
        });
        await saveState({ ...state, resources });
        setPhase("done");
        setMessage(action === "raise" ? "Alarm raised" : "Alarm cleared");
        const r = (state.resources || []).find((x) => x.id === resId);
        setDetail(r ? r.name : resId);
    }

    async function executeScan(state, job, overrideConfirmed = false) {
        setPhase("processing");
        try {
            const now   = new Date().toISOString();
            const nowMs = Date.now();

            let updatedJob;
            if (scanType === "start") {
                if (job.isRunning) { setPhase("done"); setMessage("Already running"); setDetail(job.name); return; }
                updatedJob = { ...job, isRunning: true, runStartedAt: now, completed: false };
                if (overrideConfirmed) updatedJob.actualResourceId = job.resourceId;
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

            setPhase("done");
            setMessage(scanType === "start" ? "Job started" : "Job completed");
            setDetail(job.name);
        } catch (e) {
            setPhase("error");
            setMessage(e.message || "Save failed");
        }
    }

    async function confirmOverride() {
        try {
            const job = (stateSnap.jobs || []).find((j) => j.id === jobId);
            if (!job) { setPhase("error"); setMessage("Job not found"); return; }
            await executeScan(stateSnap, job, true);
        } catch (e) {
            setPhase("error");
            setMessage(e.message);
        }
    }

    // ─── render ─────────────────────────────────────────────────────────────

    const actionLabel = scanType === "start" ? "START" : scanType === "stop" ? "STOP"
        : alarmType === "raise" ? "ALARM" : alarmType === "clear" ? "CLEAR" : "SCAN";

    const actionColor = scanType === "start" ? "#21A366" : scanType === "stop" ? "#C4372E"
        : alarmType ? "#C4372E" : "#1B6E8C";

    const ActionIcon = scanType === "start" ? Play : scanType === "stop" ? Square
        : alarmType ? AlertOctagon : ChevronRight;

    return (
        <div style={S.wrap}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&display=swap');
                * { box-sizing: border-box; }
                body { margin: 0; background: #F3F4F6; font-family: 'Segoe UI', sans-serif; }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            `}</style>

            <div style={S.card}>
                <div style={{ ...S.header, background: actionColor }}>
                    <ActionIcon size={22} color="#fff" />
                    <span style={S.headerLabel}>{actionLabel}</span>
                </div>

                <div style={S.body}>

                    {phase === "loading" && (
                        <div style={S.center}>
                            <Loader size={28} color="#6B7280" style={{ animation: "spin 1s linear infinite" }} />
                            <div style={S.subtext}>Loading…</div>
                        </div>
                    )}

                    {phase === "machine_warning" && machineWarn && (
                        <div>
                            <div style={S.warnBanner}>
                                <AlertTriangle size={20} color="#D97706" />
                                <span style={{ fontWeight: 700, fontSize: 14, color: "#92400E" }}>Wrong machine</span>
                            </div>
                            <div style={S.warnBody}>
                                <div style={S.warnRow}>
                                    <span style={S.warnLabel}>Your machine</span>
                                    <span style={{ ...S.warnValue, color: "#1D4ED8", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
                                        {machineWarn.assignedMachineName}
                                    </span>
                                </div>
                                <div style={S.warnRow}>
                                    <span style={S.warnLabel}>This job runs on</span>
                                    <span style={{ ...S.warnValue, color: "#C4372E", background: "#FEF2F2", border: "1px solid #FECACA" }}>
                                        {machineWarn.jobMachineName}
                                    </span>
                                </div>
                                <div style={{ fontSize: 12.5, color: "#6B7280", marginTop: 12 }}>
                                    Job: <b>{machineWarn.jobName}</b>
                                </div>
                            </div>
                            <div style={S.warnActions}>
                                <button style={{ ...S.btn, background: "#F9FAFB", color: "#374151", border: "1px solid #D1D5DB" }}
                                    onClick={() => window.history.back()}>
                                    <ArrowLeft size={14} /> Go back
                                </button>
                                <button style={{ ...S.btn, background: "#D97706", color: "#fff", border: "none" }}
                                    onClick={confirmOverride}>
                                    <AlertTriangle size={14} /> Scan anyway (override)
                                </button>
                            </div>
                        </div>
                    )}

                    {phase === "processing" && (
                        <div style={S.center}>
                            <Loader size={28} color={actionColor} style={{ animation: "spin 1s linear infinite" }} />
                            <div style={S.subtext}>Saving…</div>
                        </div>
                    )}

                    {phase === "done" && (
                        <div style={S.center}>
                            <CheckCircle size={48} color="#21A366" />
                            <div style={{ fontSize: 18, fontWeight: 700, color: "#111827", marginTop: 12 }}>{message}</div>
                            {detail && <div style={S.subtext}>{detail}</div>}
                            <button style={{ ...S.btn, marginTop: 24, background: "#111827", color: "#fff", border: "none" }}
                                onClick={() => window.history.back()}>
                                <ArrowLeft size={14} /> Back
                            </button>
                        </div>
                    )}

                    {phase === "error" && (
                        <div style={S.center}>
                            <AlertOctagon size={48} color="#C4372E" />
                            <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginTop: 12 }}>{message}</div>
                            <button style={{ ...S.btn, marginTop: 24, background: "#111827", color: "#fff", border: "none" }}
                                onClick={() => window.history.back()}>
                                <ArrowLeft size={14} /> Back
                            </button>
                        </div>
                    )}

                </div>
            </div>
        </div>
    );
}

const S = {
    wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F3F4F6", padding: 16 },
    card: { width: "100%", maxWidth: 400, background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.10)" },
    header: { display: "flex", alignItems: "center", gap: 12, padding: "18px 24px" },
    headerLabel: { fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, fontSize: 18, color: "#fff", letterSpacing: 2 },
    body: { padding: 24 },
    center: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "8px 0" },
    subtext: { fontSize: 13.5, color: "#6B7280", marginTop: 8 },
    warnBanner: { display: "flex", alignItems: "center", gap: 10, background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 8, padding: "12px 16px", marginBottom: 16 },
    warnBody: { background: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: 8, padding: "14px 16px", marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 },
    warnRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
    warnLabel: { fontSize: 12.5, color: "#6B7280", flexShrink: 0 },
    warnValue: { fontSize: 13, fontWeight: 700, borderRadius: 6, padding: "3px 10px" },
    warnActions: { display: "flex", gap: 8, flexDirection: "column" },
    btn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 8, padding: "10px 16px", fontSize: 13.5, fontWeight: 600, cursor: "pointer", width: "100%", fontFamily: "'Segoe UI', sans-serif" },
};