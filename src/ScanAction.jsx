import { useEffect, useState, useRef } from "react";
import { CheckCircle2, XCircle, Loader2, AlertTriangle, AlertOctagon, Play, Square, Cpu, AlertCircle, Lock, ChevronLeft } from "lucide-react";
import { supabase } from "./supabaseClient";

const ALARM_REASONS = [
    { id: "breakdown", label: "Machine breakdown" },
    { id: "material",  label: "Material shortage" },
    { id: "quality",   label: "Quality issue" },
    { id: "other",     label: "Assistance needed" },
];

const GREEN   = "#007A36";
const GREEN_D = "#005A27";
const RED     = "#C4372E";
const RED_D   = "#9B1F18";
const AMBER   = "#B45309";
const BLUE    = "#1976D2";
const BLUE_D  = "#0F559E";

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
        if (error || !data?.data) { setPhase("error"); setErrorMsg("Failed to load data. Please try again."); return; }
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
                const cur = users.find((u) => u.username.toLowerCase() === uname.toLowerCase());
                const mids = Array.isArray(cur?.assignedMachineIds) ? cur.assignedMachineIds : (cur?.assignedMachineId ? [cur.assignedMachineId] : []);
                if (mids.length === 0) { setPhase("no_machine"); return; }
                // prefer the machine that matches the planned resource; otherwise use first assigned
                const mid = (planned && mids.includes(planned.id)) ? planned.id : mids[0];
                const machine = (sd.resources || []).find((r) => r.id === mid) || null;
                setResource(machine);
                if (machine?.alarmActive) {
                    setBlockReason(ALARM_REASONS.find((a) => a.id === machine.alarmReason)?.label || "Alarm");
                    setPhase("blocked"); return;
                }
                overridePinRef.current = sd.appConfig?.overridePin || "";
                const match = planned && mids.includes(planned.id);
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
        const cur = (sd.users || []).find((u) => u.username.toLowerCase() === uname.toLowerCase());
        const mids = Array.isArray(cur?.assignedMachineIds) ? cur.assignedMachineIds : (cur?.assignedMachineId ? [cur.assignedMachineId] : []);
        if (mids.length === 0) { setPhase("no_machine"); return; }
        const freshJob = (sd.jobs || []).find((jj) => jj.id === id);
        const planned = freshJob ? (sd.resources || []).find((r) => r.id === freshJob.resourceId) || null : plannedRes;
        if (freshJob) { setJob(freshJob); setPlannedRes(planned); }
        // prefer machine matching planned resource; otherwise first assigned
        const mid = (planned && mids.includes(planned.id)) ? planned.id : mids[0];
        const machine = (sd.resources || []).find((r) => r.id === mid) || null;
        setResource(machine);
        if (machine?.alarmActive) {
            setBlockReason(ALARM_REASONS.find((a) => a.id === machine.alarmReason)?.label || "Alarm");
            setPhase("blocked"); return;
        }
        overridePinRef.current = sd.appConfig?.overridePin || "";
        const match = planned && mids.includes(planned.id);
        setIsOverride(!match);
        setChosenAction("start");
        setPhase(match ? "job_confirm" : "mismatch");
    }

    async function handleConfirmJob() {
        setPhase("working");
        const scanActor = sessionStorage.getItem("ps-username") || "Floor (scan/QR)";
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
        const ea = chosenAction || action;
        const jobs = (data.data.jobs || []).map((j) => {
            if (j.id !== id) return j;
            if (ea === "start") return { ...j, isRunning: true, runStartedAt: nowIso, lastScanAt: nowIso, completed: false, actualResourceId: isOverride && resource ? resource.id : null, scanBy: scanActor };
            const elapsedH = j.runStartedAt ? Math.max(0, (Date.now() - new Date(j.runStartedAt).getTime()) / 3600000) : 0;
            const jt = Array.isArray(j.tools) ? j.tools : [];
            const est = jt.reduce((s, t) => s + (t.hours || 0), 0);
            const updTools = jt.map((t) => { const share = est > 0 ? (t.hours || 0) / est : jt.length ? 1 / jt.length : 0; const h = elapsedH * share; upsertTool(t.number, t.name, h, j.name); return { ...t, actualHours: (t.actualHours || 0) + h }; });
            return { ...j, isRunning: false, completed: true, runStartedAt: null, lastScanAt: nowIso, actualRunHours: (j.actualRunHours || 0) + elapsedH, tools: jt.length > 0 ? updTools : j.tools, scanBy: scanActor };
        });
        const { error: ue } = await supabase.from("schedule_state")
            .update({ data: { ...data.data, jobs, toolHistory }, updated_at: nowIso }).eq("id", 1);
        if (ue) { setPhase("error"); setErrorMsg("Failed to save. Please try again."); return; }
        setPhase("done");
    }

    async function handleConfirmAlarm() {
        setPhase("working");
        const scanActor = sessionStorage.getItem("ps-username") || "Floor (scan/QR)";
        const { data, error } = await supabase
            .from("schedule_state").select("data").eq("id", 1).single();
        if (error || !data?.data) { setPhase("error"); setErrorMsg("Failed to save. Please try again."); return; }
        const resources = (data.data.resources || []).map((r) =>
            r.id !== id ? r : action === "raise"
                ? { ...r, alarmActive: true, alarmReason, alarmAt: Date.now(), scanBy: scanActor }
                : { ...r, alarmActive: false, alarmReason: null, alarmAt: null, scanBy: scanActor }
        );
        const { error: ue } = await supabase.from("schedule_state")
            .update({ data: { ...data.data, resources }, updated_at: new Date().toISOString() }).eq("id", 1);
        if (ue) { setPhase("error"); setErrorMsg("Failed to save. Please try again."); return; }
        setPhase("done");
    }

    async function handleOverrideClick() {
        setPinInput(""); setPinError("");
        try { const { data } = await supabase.from("schedule_state").select("data").eq("id", 1).single(); overridePinRef.current = data?.data?.appConfig?.overridePin || ""; } catch {}
        overridePinRef.current ? setShowPinModal(true) : setPhase("job_confirm");
    }

    function checkPin() {
        const entered = pinInput.trim();
        if (entered === overridePinRef.current) { setShowPinModal(false); setPhase("job_confirm"); }
        else { setPinError("Incorrect PIN — try again"); setPinInput(""); }
    }

    const ea = chosenAction || action;
    const isStart = kind === "job" && ea === "start";
    const isStop  = kind === "job" && ea === "stop";
    const isRaise = kind === "alarm" && action === "raise";
    const isClear = kind === "alarm" && action === "clear";
    const doneGreen = isStart || isClear;

    const roleColor = urole === "admin" ? BLUE : urole === "operator" ? GREEN : "#6E6E6E";
    const roleLabel = urole === "admin" ? "Admin" : urole === "operator" ? "Operator" : "Viewer";

    return (
        <div style={S.shell}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&display=swap');
                * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
                @keyframes spin { to { transform: rotate(360deg); } }
                @keyframes fadeIn { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform: translateY(0); } }
                .sa-spin { animation: spin 1s linear infinite; }
                .sa-fade { animation: fadeIn 0.18s ease; }
                .sa-btn:hover { filter: brightness(0.93); }
                .sa-btn:active { filter: brightness(0.86); transform: scale(0.98); }
                .sa-ghost:hover { background: #EDEDED !important; }
                .sa-select { width:100%; background:#fff; border:1px solid #ABABAB; border-radius:2px; padding:8px 10px; font-family:'Segoe UI','Inter',sans-serif; font-size:13px; color:#262626; margin-top:10px; }
            `}</style>

            {/* ── Title bar (matches Login) ── */}
            <div style={S.titleBar}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <button onClick={onDone} style={S.backBtn}>
                        <ChevronLeft size={15} strokeWidth={2} />
                    </button>
                    <span style={S.brandText}>
                        ProdSched
                        <span style={S.brandUnderline} />
                    </span>
                </div>
                {uname && (
                    <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                        <div style={{ ...S.avatar, background: roleColor }}>
                            {uname.charAt(0).toUpperCase()}
                        </div>
                        <div>
                            <div style={{ fontSize:11.5, fontWeight:600, color:"#262626", lineHeight:1.2 }}>{uname}</div>
                            <div style={{ fontSize:10, color: roleColor, fontWeight:600 }}>{roleLabel}</div>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Page body ── */}
            <div style={S.body}>
                <div style={S.card} className="sa-fade" key={phase}>

                    {/* Loading */}
                    {phase === "loading" && (
                        <div style={S.center}>
                            <Loader2 className="sa-spin" size={32} color={BLUE} />
                            <div style={S.sub}>Loading...</div>
                        </div>
                    )}

                    {/* No machine */}
                    {phase === "no_machine" && (
                        <>
                            <div style={{ ...S.pill, background:"#FEF3C7", color:AMBER }}>⚠ No machine assigned</div>
                            <div style={{ ...S.iconBox, background:"#FEF3C7" }}><Cpu size={24} color={AMBER} strokeWidth={2} /></div>
                            {job?.name && <div style={S.mono}>{job.name}</div>}
                            <div style={S.title}>Contact your Admin</div>
                            <div style={S.sub}>Your account has no machine assigned. Ask your Admin to assign a machine before scanning jobs.</div>
                            <button className="sa-btn" style={S.btnBlue} onClick={onDone}>Back to Schedule</button>
                        </>
                    )}

                    {/* Mismatch */}
                    {phase === "mismatch" && job && (
                        <>
                            <div style={{ ...S.pill, background:"#FEF3C7", color:AMBER }}>⚠ Machine mismatch</div>
                            <div style={{ ...S.iconBox, background:"#FEF3C7" }}><AlertCircle size={24} color={AMBER} strokeWidth={2} /></div>
                            <div style={S.mono}>{job.name}</div>
                            <div style={S.infoBox}>
                                <div style={S.infoRow}>
                                    <span style={S.infoLabel}>Your machine</span>
                                    <span style={{ ...S.infoVal, color:AMBER }}>{resource?.name || "—"}</span>
                                </div>
                                <div style={{ ...S.infoRow, borderTop:"1px solid #EBEBEB", paddingTop:7 }}>
                                    <span style={S.infoLabel}>Planned machine</span>
                                    <span style={{ ...S.infoVal, color:GREEN_D }}>{plannedRes?.name || "Unassigned"}</span>
                                </div>
                            </div>
                            <div style={S.warnBox}>This job is scheduled on <b>{plannedRes?.name || "another machine"}</b>. Verify with your Supervisor before proceeding.</div>
                            <div style={S.btnRow}>
                                <button className="sa-ghost sa-btn" style={S.btnGhost} onClick={onDone}>Cancel</button>
                                <button className="sa-btn" style={{ ...S.btnConfirm, background:AMBER }} onClick={handleOverrideClick}>Override &amp; Start</button>
                            </div>
                        </>
                    )}

                    {/* Choose start / stop */}
                    {phase === "choose_action" && job && (
                        <>
                            <div style={{ ...S.iconBox, background: job.isRunning ? "#FDF0EF" : "#EAF6EF", width:64, height:64 }}>
                                {job.isRunning ? <Square size={28} color={RED} strokeWidth={2} /> : <Play size={28} color={GREEN} strokeWidth={2} />}
                            </div>
                            <div style={S.mono}>{job.name}</div>
                            <div style={S.sub}>{plannedRes?.name || "Unassigned"} · {job.product}</div>
                            <div style={{ ...S.pill, background: job.isRunning ? "#EAF6EF" : "#F5F5F5", color: job.isRunning ? GREEN_D : "#666", marginTop:2 }}>
                                <span style={{ width:6, height:6, borderRadius:"50%", background: job.isRunning ? GREEN : "#ABABAB", display:"inline-block", flexShrink:0 }} />
                                {job.isRunning ? "Currently running" : "Not started"}
                            </div>
                            <div style={S.divider} />
                            <div style={S.fieldLabel}>Select action</div>
                            <div style={S.bigBtnRow}>
                                <button className="sa-btn" disabled={!!job.isRunning}
                                    style={{ ...S.bigBtn, background: job.isRunning ? "#E8E8E8" : GREEN, color: job.isRunning ? "#ABABAB" : "#fff", cursor: job.isRunning ? "not-allowed" : "pointer" }}
                                    onClick={checkMachineAndStart}>
                                    <Play size={18} strokeWidth={2.5} />
                                    <span style={{ fontSize:13, fontWeight:700, letterSpacing:"0.04em" }}>START</span>
                                </button>
                                <button className="sa-btn" disabled={!job.isRunning}
                                    style={{ ...S.bigBtn, background: !job.isRunning ? "#E8E8E8" : RED, color: !job.isRunning ? "#ABABAB" : "#fff", cursor: !job.isRunning ? "not-allowed" : "pointer" }}
                                    onClick={() => { setChosenAction("stop"); setPhase("job_confirm"); }}>
                                    <Square size={18} strokeWidth={2.5} />
                                    <span style={{ fontSize:13, fontWeight:700, letterSpacing:"0.04em" }}>STOP</span>
                                </button>
                            </div>
                        </>
                    )}

                    {/* Job confirm */}
                    {phase === "job_confirm" && job && (
                        <>
                            <div style={{ ...S.iconBox, background: isStart ? "#EAF6EF" : "#FDF0EF", width:64, height:64 }}>
                                {isStart ? <Play size={28} color={GREEN} strokeWidth={2} /> : <Square size={28} color={RED} strokeWidth={2} />}
                            </div>
                            <div style={S.mono}>{job.name}</div>
                            <div style={S.sub}>{resource?.name || plannedRes?.name || "—"} · {job.product}</div>
                            {isOverride && resource && (
                                <div style={S.warnBox}>⚠ Override — running on <b>{resource.name}</b> instead of <b>{plannedRes?.name}</b></div>
                            )}
                            <div style={S.divider} />
                            <div style={S.title}>Confirm {isStart ? "start" : "stop"} job?</div>
                            <div style={S.btnRow}>
                                <button className="sa-ghost sa-btn" style={S.btnGhost} onClick={onDone}>Cancel</button>
                                <button className="sa-btn" style={{ ...S.btnConfirm, background: isStart ? GREEN : RED }} onClick={handleConfirmJob}>
                                    {isStart ? "Confirm Start" : "Confirm Stop"}
                                </button>
                            </div>
                        </>
                    )}

                    {/* Alarm confirm */}
                    {phase === "alarm_confirm" && resource && (
                        <>
                            <div style={{ ...S.iconBox, background: isRaise ? "#FDF0EF" : "#EAF6EF", width:64, height:64 }}>
                                {isRaise ? <AlertOctagon size={28} color={RED} strokeWidth={2} /> : <CheckCircle2 size={28} color={GREEN} strokeWidth={2} />}
                            </div>
                            <div style={S.mono}>{resource.name}</div>
                            <div style={S.sub}>{resource.type}</div>
                            <div style={S.divider} />
                            <div style={S.title}>{isRaise ? "Raise alarm?" : "Clear alarm?"}</div>
                            {isRaise && (
                                <select className="sa-select" value={alarmReason} onChange={(e) => setAlarmReason(e.target.value)}>
                                    {ALARM_REASONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                                </select>
                            )}
                            <div style={S.btnRow}>
                                <button className="sa-ghost sa-btn" style={S.btnGhost} onClick={onDone}>Cancel</button>
                                <button className="sa-btn" style={{ ...S.btnConfirm, background: isRaise ? RED : GREEN }} onClick={handleConfirmAlarm}>
                                    {isRaise ? "Confirm Alarm" : "Confirm Clear"}
                                </button>
                            </div>
                        </>
                    )}

                    {/* Blocked */}
                    {phase === "blocked" && (
                        <>
                            <div style={{ ...S.iconBox, background:"#FDF0EF", width:64, height:64 }}><AlertOctagon size={28} color={RED} strokeWidth={2} /></div>
                            {job?.name && <div style={S.mono}>{job.name}</div>}
                            <div style={{ ...S.title, color:RED_D }}>Cannot Start</div>
                            <div style={S.infoBox}>
                                <div style={S.infoRow}>
                                    <span style={S.infoLabel}>Machine</span>
                                    <span style={{ ...S.infoVal, color:RED_D }}>{resource?.name}</span>
                                </div>
                                <div style={{ ...S.infoRow, borderTop:"1px solid #EBEBEB", paddingTop:7 }}>
                                    <span style={S.infoLabel}>Active alarm</span>
                                    <span style={{ ...S.infoVal, color:RED_D }}>{blockReason}</span>
                                </div>
                            </div>
                            <div style={S.sub}>Clear the alarm before starting a job on this machine.</div>
                            <button className="sa-btn" style={S.btnBlue} onClick={onDone}>Back to Schedule</button>
                        </>
                    )}

                    {/* Working */}
                    {phase === "working" && (
                        <div style={S.center}>
                            <Loader2 className="sa-spin" size={32} color={BLUE} />
                            <div style={S.sub}>Saving...</div>
                        </div>
                    )}

                    {/* Done */}
                    {phase === "done" && (
                        <>
                            <div style={{ ...S.iconBox, background: doneGreen ? "#EAF6EF" : "#FDF0EF", width:64, height:64 }}>
                                {doneGreen ? <CheckCircle2 size={28} color={GREEN} strokeWidth={2} />
                                    : isStop ? <XCircle size={28} color={RED} strokeWidth={2} />
                                    : isRaise ? <AlertOctagon size={28} color={RED} strokeWidth={2} />
                                    : <CheckCircle2 size={28} color={GREEN} strokeWidth={2} />}
                            </div>
                            <div style={S.mono}>{job?.name || resource?.name}</div>
                            <div style={{ ...S.title, color: doneGreen ? GREEN_D : RED_D }}>
                                {isStop ? "Job Stopped" : isRaise ? "Alarm Raised" : isClear ? "Alarm Cleared" : "Job Started"}
                            </div>
                            <div style={S.sub}>{new Date().toLocaleString("en-GB", { hour:"2-digit", minute:"2-digit", day:"numeric", month:"short" })}</div>
                            <button className="sa-btn" style={{ ...S.btnBlue, marginTop:8 }} onClick={onDone}>Back to Schedule</button>
                        </>
                    )}

                    {/* Error */}
                    {phase === "error" && (
                        <>
                            <div style={{ ...S.iconBox, background:"#FDF0EF", width:64, height:64 }}><AlertTriangle size={28} color={RED} strokeWidth={2} /></div>
                            <div style={{ ...S.title, color:RED_D }}>Error</div>
                            <div style={S.sub}>{errorMsg}</div>
                            <button className="sa-btn" style={S.btnBlue} onClick={() => { setPhase("loading"); load(); }}>Try again</button>
                            <button className="sa-ghost sa-btn" style={{ ...S.btnGhost, marginTop:6 }} onClick={onDone}>Cancel</button>
                        </>
                    )}

                </div>
            </div>

            {/* ── PIN Modal ── */}
            {showPinModal && (
                <div style={S.overlay}>
                    <div style={S.modal}>
                        <div style={S.modalTitleBar}>
                            <Lock size={12} color={BLUE} style={{ marginRight:7 }} />
                            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontWeight:600, fontSize:12, color:"#262626" }}>Supervisor PIN</span>
                        </div>
                        <div style={S.modalBody}>
                            <div style={S.title}>Enter Override PIN</div>
                            <div style={S.sub}>This job is scheduled on a different machine. Enter Supervisor PIN to override.</div>
                            <input
                                type="password"
                                inputMode="numeric"
                                maxLength={8}
                                value={pinInput}
                                onChange={(e) => { setPinInput(e.target.value.replace(/\D/g, "")); setPinError(""); }}
                                onKeyDown={(e) => { if (e.key === "Enter") checkPin(); }}
                                autoFocus
                                style={{ ...S.pinInput, borderColor: pinError ? RED : "#ABABAB" }}
                                placeholder="••••"
                                autoComplete="off"
                            />
                            {pinError && (
                                <div style={{ fontSize:11.5, color:RED, display:"flex", alignItems:"center", gap:5, marginBottom:10 }}>
                                    <AlertCircle size={12} /> {pinError}
                                </div>
                            )}
                            <div style={S.btnRow}>
                                <button className="sa-ghost sa-btn" style={S.btnGhost}
                                    onClick={() => { setShowPinModal(false); setPinInput(""); setPinError(""); }}>Cancel</button>
                                <button className="sa-btn" style={{ ...S.btnConfirm, background:AMBER }} onClick={checkPin}>Confirm</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export function broadcastJobScan(jobId) {
    try { const ch = new BroadcastChannel("ps-scan"); ch.postMessage({ jobId }); ch.close(); } catch {}
}

const S = {
    // Shell
    shell:    { minHeight:"100dvh", background:"linear-gradient(180deg,#FDFDFD 0%,#F1F3F5 55%,#E6EAED 100%)", fontFamily:"'Segoe UI','Inter',sans-serif", display:"flex", flexDirection:"column" },
    // Title bar — same palette as Login
    titleBar: { display:"flex", alignItems:"center", justifyContent:"space-between", background:"#F5F6F7", borderBottom:"1px solid #D4D4D4", padding:"8px 14px" },
    backBtn:  { display:"flex", alignItems:"center", justifyContent:"center", width:26, height:26, border:"1px solid #C8C8C8", borderRadius:2, background:"#FFFFFF", cursor:"pointer", color:"#444", flexShrink:0, marginRight:4 },
    brandText:{ position:"relative", fontFamily:"'IBM Plex Mono',monospace", fontWeight:600, fontSize:12, letterSpacing:0.5, color:"#262626", paddingBottom:3 },
    brandUnderline: { position:"absolute", left:0, right:0, bottom:0, height:2, background:"#F2A900", borderRadius:1 },
    avatar:   { width:26, height:26, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:"#fff", fontFamily:"'IBM Plex Mono',monospace", flexShrink:0 },
    // Body
    body:     { flex:1, display:"flex", flexDirection:"column", alignItems:"center", padding:"28px 16px 48px", overflowY:"auto" },
    card:     { width:"100%", maxWidth:360, background:"#FFFFFF", border:"1px solid #C8C8C8", borderRadius:4, padding:"24px 22px", display:"flex", flexDirection:"column", alignItems:"center", gap:10, boxShadow:"0 6px 24px rgba(38,38,38,0.10)", textAlign:"center" },
    // Elements
    center:   { display:"flex", flexDirection:"column", alignItems:"center", gap:12, padding:"12px 0" },
    pill:     { display:"inline-flex", alignItems:"center", gap:6, fontSize:11.5, fontWeight:700, padding:"3px 10px", borderRadius:20 },
    iconBox:  { width:52, height:52, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
    mono:     { fontFamily:"'IBM Plex Mono',monospace", fontSize:15, fontWeight:600, color:"#262626", marginTop:2 },
    title:    { fontSize:14.5, fontWeight:600, color:"#262626" },
    sub:      { fontSize:12, color:"#6E6E6E", lineHeight:1.65, maxWidth:300 },
    fieldLabel: { fontSize:11.5, fontWeight:600, color:"#444", alignSelf:"flex-start" },
    divider:  { width:"100%", height:1, background:"#EBEBEB", margin:"2px 0" },
    infoBox:  { width:"100%", background:"#FAFAFA", border:"1px solid #EBEBEB", borderRadius:3, padding:"10px 14px", display:"flex", flexDirection:"column", gap:7, textAlign:"left" },
    infoRow:  { display:"flex", justifyContent:"space-between", alignItems:"center" },
    infoLabel:{ fontSize:12, color:"#6E6E6E", fontWeight:500 },
    infoVal:  { fontSize:12, fontWeight:700, fontFamily:"'IBM Plex Mono',monospace" },
    warnBox:  { width:"100%", background:"#FFFBEB", border:"1px solid #FDE68A", borderRadius:3, padding:"8px 12px", fontSize:12, color:"#78350F", textAlign:"left", lineHeight:1.6 },
    // Buttons
    btnRow:   { display:"flex", gap:8, width:"100%", marginTop:6 },
    bigBtnRow:{ display:"flex", gap:8, width:"100%", marginTop:4 },
    bigBtn:   { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:7, border:"none", borderRadius:3, padding:"16px 8px", cursor:"pointer" },
    btnBlue:  { width:"100%", marginTop:6, background:BLUE, color:"#fff", border:`1px solid ${BLUE_D}`, borderRadius:2, padding:"9px 0", fontSize:13.5, fontWeight:600, cursor:"pointer", transition:"background 0.12s" },
    btnConfirm:{ flex:1.4, border:"none", color:"#fff", borderRadius:2, padding:"9px 0", fontSize:13.5, fontWeight:600, cursor:"pointer" },
    btnGhost: { flex:1, background:"#FFFFFF", border:"1px solid #ABABAB", color:"#444", borderRadius:2, padding:"9px 0", fontSize:13, fontWeight:500, cursor:"pointer" },
    // PIN modal
    overlay:  { position:"fixed", inset:0, background:"rgba(38,38,38,0.45)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:999, padding:"20px 16px" },
    modal:    { background:"#FFFFFF", border:"1px solid #C8C8C8", borderRadius:4, width:"100%", maxWidth:340, boxShadow:"0 12px 40px rgba(38,38,38,0.22)", overflow:"hidden" },
    modalTitleBar: { display:"flex", alignItems:"center", background:"#F5F6F7", borderBottom:"1px solid #D4D4D4", padding:"7px 12px" },
    modalBody:{ padding:"20px 22px 22px", display:"flex", flexDirection:"column", gap:10 },
    pinInput: { width:"100%", border:"1px solid #ABABAB", borderRadius:2, padding:"12px 10px", fontSize:26, letterSpacing:14, textAlign:"center", fontFamily:"'IBM Plex Mono',monospace", outline:"none", background:"#FAFAFA", marginBottom:4 },
};