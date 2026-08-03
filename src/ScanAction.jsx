import { useEffect, useState, useRef } from "react";
import { CheckCircle2, XCircle, Loader2, AlertTriangle, AlertOctagon, Play, Square, Cpu, AlertCircle, QrCode } from "lucide-react";
import { supabase } from "./supabaseClient";

const ALARM_REASONS = [
    { id: "breakdown", label: "เครื่องขัดข้อง" },
    { id: "material",  label: "ขาดวัตถุดิบ" },
    { id: "quality",   label: "ปัญหาคุณภาพ" },
    { id: "other",     label: "ต้องการความช่วยเหลือ" },
];

const RUNNING_GREEN      = "#009140";
const RUNNING_GREEN_DARK = "#00612B";
const ALARM_RED          = "#FF2D20";
const ALARM_RED_DARK     = "#D6180A";
const WARN_AMBER         = "#B45309";
const BIND_BLUE          = "#1D4ED8";
const BIND_BG            = "#EFF6FF";

// ── Props ────────────────────────────────────────────────────────────────────
// kind: "bind"  -> action: "resource", id: resourceId   (scan 1: bind machine, then waits for scan 2)
// kind: "job"   -> action: "start" | "stop", id: jobId  (standalone scan 2 — backward compat)
// kind: "alarm" -> action: "raise" | "clear", id: resourceId
//
// BIND FLOW (single session, no sessionStorage):
//   phase "bind_confirm"   — show machine, ask confirm
//   phase "bind_waiting"   — show "scan job QR now" screen + listen for next URL scan
//   phase "bind_mismatch"  — job QR scanned but doesn't match planned resource
//   phase "bind_job_confirm" — match OK, show start confirm
//   phase "working" / "done" / "error"  — same as before

export default function ScanAction({ kind, action, id, onDone }) {
    const [phase,       setPhase]       = useState("loading");
    const [resource,    setResource]    = useState(null);   // bound machine
    const [job,         setJob]         = useState(null);   // scanned job
    const [plannedRes,  setPlannedRes]  = useState(null);   // job's planned resource
    const [errorMsg,    setErrorMsg]    = useState("");
    const [alarmReason, setAlarmReason] = useState(ALARM_REASONS[0].id);
    const [blockReason, setBlockReason] = useState("");
    const [allData,     setAllData]     = useState(null);   // cached schedule_state for bind flow

    // For bind flow: listen to popstate / storage events so operator can scan a second QR
    // without leaving the page — we intercept the URL change via a BroadcastChannel / polling.
    // Simplest cross-device approach: poll window.location.search every 500 ms for new ?scan= param.
    const pollRef = useRef(null);

    // ── initial load ──────────────────────────────────────────────────────────
    useEffect(() => {
        load();
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function load() {
        const { data, error } = await supabase
            .from("schedule_state")
            .select("data")
            .eq("id", 1)
            .single();

        if (error || !data?.data) {
            setPhase("error");
            setErrorMsg("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
            return;
        }

        const sd = data.data;
        setAllData(sd);

        if (kind === "bind") {
            // Scan 1: show the machine
            const res = (sd.resources || []).find((r) => r.id === id);
            if (!res) {
                setPhase("error");
                setErrorMsg("ไม่พบเครื่องจักรนี้ในระบบ (id: " + id + ")");
                return;
            }
            setResource(res);
            setPhase("bind_confirm");

        } else if (kind === "job") {
            // Standalone scan 2 (no prior bind)
            const j = (sd.jobs || []).find((jj) => jj.id === id);
            if (!j) {
                setPhase("error");
                setErrorMsg("ไม่พบงานนี้ในระบบ (job id: " + id + ")");
                return;
            }
            const res = (sd.resources || []).find((r) => r.id === j.resourceId);
            setJob(j);
            setPlannedRes(res || null);

            if (action === "start" && res?.alarmActive) {
                const label = ALARM_REASONS.find((a) => a.id === res.alarmReason)?.label || "แจ้งเตือน";
                setBlockReason(label);
                setPhase("blocked");
            } else {
                setPhase("job_confirm");
            }

        } else {
            // Alarm kind
            const res = (sd.resources || []).find((r) => r.id === id);
            if (!res) {
                setPhase("error");
                setErrorMsg("ไม่พบเครื่องจักรนี้ในระบบ (resource id: " + id + ")");
                return;
            }
            setResource(res);
            setPhase("alarm_confirm");
        }
    }

    // ── After bind confirm: start polling for scan 2 ──────────────────────────
    // The operator scans a job QR on the same device → the browser navigates to
    // /?scan=start&job=<id>. We intercept by listening to popstate OR by
    // opening in the same tab (the page reloads). To avoid a reload we use a
    // shared BroadcastChannel so the *existing* tab receives the job id.
    //
    // Implementation: after bind_confirm the UI shows a "scan now" screen and
    // registers a BroadcastChannel listener named "ps-scan". The QR page
    // (when kind="job" and action="start") posts to the channel FIRST, then
    // the existing bind tab picks it up and proceeds inline.
    //
    // Fallback: if this is a fresh tab load with kind="job" and the bind tab
    // already posted a resourceId via BroadcastChannel, we compare normally.
    const channelRef = useRef(null);

    function startListeningForJobScan(boundResource, scheduleData) {
        // BroadcastChannel: other tab / same tab posts { jobId }
        try {
            const ch = new BroadcastChannel("ps-scan");
            channelRef.current = ch;
            ch.onmessage = (e) => {
                if (e.data?.jobId) {
                    ch.close();
                    handleJobScanned(e.data.jobId, boundResource, scheduleData);
                }
            };
        } catch {}

        // Also handle if the scan QR navigates THIS same tab (popstate / hashchange won't
        // fire on full reload, so we use sessionStorage as a rendezvous).
        // The job scan page posts to BroadcastChannel AND writes sessionStorage,
        // then immediately closes itself. This tab picks it up here.
    }

    function handleConfirmBind() {
        setPhase("bind_waiting");
        startListeningForJobScan(resource, allData);
    }

    // Called when a job QR is scanned (from BroadcastChannel message)
    function handleJobScanned(jobId, boundResource, sd) {
        const j = (sd.jobs || []).find((jj) => jj.id === jobId);
        if (!j) {
            setErrorMsg("ไม่พบงาน id: " + jobId);
            setPhase("error");
            return;
        }
        const planned = (sd.resources || []).find((r) => r.id === j.resourceId) || null;
        setJob(j);
        setPlannedRes(planned);

        // Alarm blocked?
        if (planned?.alarmActive) {
            const label = ALARM_REASONS.find((a) => a.id === planned.alarmReason)?.label || "แจ้งเตือน";
            setBlockReason(label);
            setPhase("blocked");
            return;
        }

        // Mismatch check
        const match = planned && planned.id === boundResource.id;
        if (!match) {
            setPhase("bind_mismatch");
        } else {
            setPhase("bind_job_confirm");
        }
    }

    // ── Write to Supabase ─────────────────────────────────────────────────────
    async function handleConfirmJobStart(targetJob) {
        setPhase("working");
        const { data, error } = await supabase
            .from("schedule_state")
            .select("data")
            .eq("id", 1)
            .single();

        if (error || !data?.data) {
            setPhase("error");
            setErrorMsg("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
            return;
        }

        const nowIso = new Date().toISOString();
        const jobs = (data.data.jobs || []).map((j) =>
            j.id !== targetJob.id ? j : { ...j, isRunning: true, startedAt: nowIso, isDone: false }
        );

        const { error: updateError } = await supabase
            .from("schedule_state")
            .update({ data: { ...data.data, jobs }, updated_at: nowIso })
            .eq("id", 1);

        if (updateError) {
            setPhase("error");
            setErrorMsg("บันทึกสถานะไม่สำเร็จ ลองใหม่อีกครั้ง");
            return;
        }
        setPhase("done");
    }

    async function handleConfirmJob() {
        // standalone kind="job" (start or stop)
        setPhase("working");

        const { data, error } = await supabase
            .from("schedule_state")
            .select("data")
            .eq("id", 1)
            .single();

        if (error || !data?.data) {
            setPhase("error");
            setErrorMsg("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
            return;
        }

        const nowIso = new Date().toISOString();
        const toolHistory = Array.isArray(data.data.toolHistory)
            ? data.data.toolHistory.map((h) => ({ ...h }))
            : [];

        function upsertToolHistory(number, name, hoursToAdd, jobName) {
            if (!name || hoursToAdd <= 0) return;
            const idx = toolHistory.findIndex(
                (h) => (h.number || null) === (number || null) && h.name === name
            );
            if (idx === -1) {
                toolHistory.push({ number: number || null, name, actualHours: hoursToAdd, lastRunAt: nowIso, jobNames: jobName ? [jobName] : [] });
                return;
            }
            const existing = toolHistory[idx];
            const jobNames = existing.jobNames ? [...existing.jobNames] : [];
            if (jobName && !jobNames.includes(jobName)) {
                jobNames.push(jobName);
                if (jobNames.length > 20) jobNames.shift();
            }
            toolHistory[idx] = { ...existing, actualHours: (existing.actualHours || 0) + hoursToAdd, lastRunAt: nowIso, jobNames };
        }

        const jobs = (data.data.jobs || []).map((j) => {
            if (j.id !== id) return j;
            if (action === "start") {
                return { ...j, isRunning: true, startedAt: nowIso, isDone: false };
            }
            const elapsedHours = j.startedAt
                ? Math.max(0, (Date.now() - new Date(j.startedAt).getTime()) / 3600000)
                : 0;
            const jobTools = Array.isArray(j.tools) ? j.tools : [];
            const estTotal = jobTools.reduce((s, t) => s + (t.hours || 0), 0);
            const updatedTools = jobTools.map((t) => {
                const share = estTotal > 0 ? (t.hours || 0) / estTotal : jobTools.length ? 1 / jobTools.length : 0;
                const h = elapsedHours * share;
                upsertToolHistory(t.number, t.name, h, j.name);
                return { ...t, actualHours: (t.actualHours || 0) + h };
            });
            return {
                ...j,
                isRunning: false,
                isDone: true,
                startedAt: null,
                actualRunHours: (j.actualRunHours || 0) + elapsedHours,
                tools: jobTools.length > 0 ? updatedTools : j.tools,
            };
        });

        const { error: updateError } = await supabase
            .from("schedule_state")
            .update({ data: { ...data.data, jobs, toolHistory }, updated_at: nowIso })
            .eq("id", 1);

        if (updateError) {
            setPhase("error");
            setErrorMsg("บันทึกสถานะไม่สำเร็จ ลองใหม่อีกครั้ง");
            return;
        }
        setPhase("done");
    }

    async function handleConfirmAlarm() {
        setPhase("working");
        const { data, error } = await supabase
            .from("schedule_state")
            .select("data")
            .eq("id", 1)
            .single();

        if (error || !data?.data) {
            setPhase("error");
            setErrorMsg("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
            return;
        }

        const resources = (data.data.resources || []).map((r) =>
            r.id !== id ? r : action === "raise"
                ? { ...r, alarmActive: true, alarmReason, alarmAt: Date.now() }
                : { ...r, alarmActive: false, alarmReason: null, alarmAt: null }
        );

        const { error: updateError } = await supabase
            .from("schedule_state")
            .update({ data: { ...data.data, resources }, updated_at: new Date().toISOString() })
            .eq("id", 1);

        if (updateError) {
            setPhase("error");
            setErrorMsg("บันทึกสถานะไม่สำเร็จ ลองใหม่อีกครั้ง");
            return;
        }
        setPhase("done");
    }

    // ── Derived flags ─────────────────────────────────────────────────────────
    const isStart = (kind === "job" && action === "start") || phase === "bind_job_confirm" || phase === "bind_mismatch";
    const isStop  = kind === "job" && action === "stop";
    const isRaise = kind === "alarm" && action === "raise";
    const isClear = kind === "alarm" && action === "clear";

    // resource name for display
    const resourceNameDisplay = plannedRes?.name || (kind === "job" ? "unassigned" : resource?.name || "");

    return (
        <div style={styles.wrap}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap');
                @keyframes spin    { to { transform: rotate(360deg); } }
                @keyframes fadeIn  { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
                @keyframes pulse   { 0%,100% { opacity:1; } 50% { opacity:0.45; } }
                .ps-spin    { animation: spin 1s linear infinite; }
                .ps-fadein  { animation: fadeIn 0.22s ease; }
                .ps-pulse   { animation: pulse 1.6s ease-in-out infinite; }
                .ps-scan-btn:hover     { background: #155A73 !important; }
                .ps-scan-cancel:hover  { background: #EBEBEB !important; }
                .ps-scan-select { background:#FFFFFF; border:1px solid #C8C8C8; color:#262626; border-radius:8px; padding:9px 10px; font-family:'Segoe UI','Inter',sans-serif; font-size:13.5px; width:100%; box-sizing:border-box; margin-top:14px; }
            `}</style>

            <div style={styles.card} className="ps-fadein" key={phase}>

                {/* ── Loading ──────────────────────────────────────────────── */}
                {phase === "loading" && (
                    <>
                        <Loader2 className="ps-spin" size={40} color="#1B6E8C" />
                        <div style={styles.title}>กำลังโหลดข้อมูล...</div>
                    </>
                )}

                {/* ── Step 1: confirm bind machine ─────────────────────────── */}
                {phase === "bind_confirm" && resource && (
                    <>
                        <div style={{ ...styles.stepBadge, background: BIND_BG, color: BIND_BLUE }}>
                            ขั้นที่ 1 / 2 — เลือกเครื่อง
                        </div>
                        <div style={{ ...styles.iconWrap, background: BIND_BG }}>
                            <Cpu size={28} color={BIND_BLUE} strokeWidth={2.5} />
                        </div>
                        <div style={styles.machName}>{resource.name}</div>
                        <div style={styles.sub}>{resource.type}</div>
                        <div style={{ ...styles.title, marginTop: 8 }}>ยืนยันเลือกเครื่องนี้?</div>
                        <div style={styles.btnRow}>
                            <button className="ps-scan-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button style={{ ...styles.confirmBtn, background: BIND_BLUE }} onClick={handleConfirmBind}>
                                ยืนยัน
                            </button>
                        </div>
                    </>
                )}

                {/* ── Step 1 done: waiting for job scan ────────────────────── */}
                {phase === "bind_waiting" && resource && (
                    <>
                        <div style={{ ...styles.stepBadge, background: BIND_BG, color: BIND_BLUE }}>
                            ขั้นที่ 2 / 2 — สแกน QR งาน
                        </div>
                        <div style={{ ...styles.iconWrap, background: BIND_BG, position: "relative" }}>
                            <Cpu size={26} color={BIND_BLUE} strokeWidth={2} style={{ position: "absolute", top: 8, left: 8, opacity: 0.35 }} />
                            <QrCode className="ps-pulse" size={32} color={BIND_BLUE} strokeWidth={2.5} />
                        </div>
                        <div style={styles.machName}>{resource.name}</div>
                        <div style={{ ...styles.title, marginTop: 8 }}>สแกน QR งาน (START) ได้เลย</div>
                        <div style={styles.sub}>
                            เครื่องถูกเลือกแล้ว — สแกน QR START ของงานที่ต้องการเริ่ม
                        </div>
                        <button className="ps-scan-cancel" style={{ ...styles.cancelBtn, marginTop: 16, width: "100%" }} onClick={onDone}>
                            ยกเลิก
                        </button>
                    </>
                )}

                {/* ── Mismatch warning ─────────────────────────────────────── */}
                {phase === "bind_mismatch" && job && (
                    <>
                        <div style={{ ...styles.stepBadge, background: "#FEF3C7", color: WARN_AMBER }}>
                            ⚠ งานไม่ตรงกับเครื่องที่เลือก
                        </div>
                        <div style={{ ...styles.iconWrap, background: "#FEF3C7" }}>
                            <AlertCircle size={28} color={WARN_AMBER} strokeWidth={2.5} />
                        </div>
                        <div style={styles.machName}>{job.name}</div>

                        <div style={styles.mismatchTable}>
                            <div style={styles.mismatchRow}>
                                <span style={styles.mismatchLabel}>เครื่องที่เลือก</span>
                                <span style={{ ...styles.mismatchVal, color: WARN_AMBER }}>{resource?.name || "—"}</span>
                            </div>
                            <div style={{ ...styles.mismatchRow, borderTop: "1px solid #E8E8E8", paddingTop: 6 }}>
                                <span style={styles.mismatchLabel}>เครื่องตาม Planning</span>
                                <span style={{ ...styles.mismatchVal, color: RUNNING_GREEN_DARK }}>{plannedRes?.name || "ไม่ได้กำหนด"}</span>
                            </div>
                        </div>

                        <div style={{ fontSize: 12, color: "#78350F", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 6, padding: "8px 12px", textAlign: "left", lineHeight: 1.65 }}>
                            งานนี้ถูกวางแผนไว้บน <b>{plannedRes?.name || "เครื่องอื่น"}</b>
                            <br />กรุณาตรวจสอบกับ Supervisor ก่อนดำเนินการต่อ
                        </div>

                        <div style={styles.btnRow}>
                            <button className="ps-scan-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button style={{ ...styles.confirmBtn, background: WARN_AMBER, fontSize: 12.5 }}
                                onClick={() => setPhase("bind_job_confirm")}>
                                Override &amp; เริ่มงาน
                            </button>
                        </div>
                    </>
                )}

                {/* ── Step 2 confirm (bind flow) ───────────────────────────── */}
                {phase === "bind_job_confirm" && job && (
                    <>
                        <div style={{ ...styles.stepBadge, background: "#E3F5E9", color: RUNNING_GREEN_DARK }}>
                            ขั้นที่ 2 / 2 — เริ่มงาน
                        </div>
                        <div style={{ ...styles.iconWrap, background: "#E3F5E9" }}>
                            <Play size={28} color={RUNNING_GREEN_DARK} strokeWidth={2.5} />
                        </div>
                        <div style={styles.machName}>{job.name}</div>
                        <div style={styles.sub}>{resourceNameDisplay} · {job.product}</div>
                        <div style={{ ...styles.title, marginTop: 8 }}>ยืนยันเริ่มงาน?</div>
                        <div style={styles.btnRow}>
                            <button className="ps-scan-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button style={{ ...styles.confirmBtn, background: RUNNING_GREEN }}
                                onClick={() => handleConfirmJobStart(job)}>
                                ยืนยันเริ่มงาน
                            </button>
                        </div>
                    </>
                )}

                {/* ── Standalone job confirm (kind="job") ──────────────────── */}
                {phase === "job_confirm" && job && (
                    <>
                        <div style={{ ...styles.iconWrap, background: isStart ? "#E3F5E9" : "#FFF1EF" }}>
                            {isStart ? <Play size={28} color={RUNNING_GREEN_DARK} strokeWidth={2.5} />
                                     : <Square size={28} color="#C4372E" strokeWidth={2.5} />}
                        </div>
                        <div style={styles.machName}>{job.name}</div>
                        <div style={styles.sub}>{resourceNameDisplay} · {job.product}</div>
                        <div style={{ ...styles.title, marginTop: 8 }}>ยืนยัน{isStart ? "เริ่มงาน" : "หยุดงาน"}?</div>
                        <div style={styles.btnRow}>
                            <button className="ps-scan-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button style={{ ...styles.confirmBtn, background: isStart ? RUNNING_GREEN : "#C4372E" }}
                                onClick={handleConfirmJob}>
                                {isStart ? "ยืนยันเริ่มงาน" : "ยืนยันหยุดงาน"}
                            </button>
                        </div>
                    </>
                )}

                {/* ── Alarm confirm ────────────────────────────────────────── */}
                {phase === "alarm_confirm" && resource && (
                    <>
                        <div style={{ ...styles.iconWrap, background: isRaise ? "#FDECEB" : "#E3F5E9" }}>
                            {isRaise ? <AlertOctagon size={28} color={ALARM_RED} strokeWidth={2.5} />
                                     : <CheckCircle2 size={28} color={RUNNING_GREEN_DARK} strokeWidth={2.5} />}
                        </div>
                        <div style={styles.machName}>{resource.name}</div>
                        <div style={styles.sub}>{resource.type}</div>
                        <div style={{ ...styles.title, marginTop: 8 }}>ยืนยัน{isRaise ? "แจ้งเตือน" : "ยกเลิกแจ้งเตือน"}?</div>
                        {isRaise && (
                            <select className="ps-scan-select" value={alarmReason}
                                onChange={(e) => setAlarmReason(e.target.value)}>
                                {ALARM_REASONS.map((a) => (
                                    <option key={a.id} value={a.id}>{a.label}</option>
                                ))}
                            </select>
                        )}
                        <div style={styles.btnRow}>
                            <button className="ps-scan-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button style={{ ...styles.confirmBtn, background: isRaise ? ALARM_RED : RUNNING_GREEN }}
                                onClick={handleConfirmAlarm}>
                                {isRaise ? "ยืนยันแจ้งเตือน" : "ยืนยันยกเลิก"}
                            </button>
                        </div>
                    </>
                )}

                {/* ── Blocked ──────────────────────────────────────────────── */}
                {phase === "blocked" && (
                    <>
                        <div style={{ ...styles.iconWrap, background: "#FBE4E2" }}>
                            <AlertOctagon size={28} color={ALARM_RED} strokeWidth={2.5} />
                        </div>
                        <div style={styles.machName}>{job?.name}</div>
                        <div style={styles.sub}>{resourceNameDisplay}</div>
                        <div style={{ ...styles.title, color: ALARM_RED_DARK, marginTop: 8 }}>ไม่สามารถเริ่มงานได้</div>
                        <div style={styles.sub}>
                            เครื่อง {resourceNameDisplay} มีการแจ้งเตือนอยู่: {blockReason}
                            <br />กรุณาเคลียร์การแจ้งเตือนก่อนเริ่มงาน
                        </div>
                        <button className="ps-scan-btn" style={styles.btn} onClick={onDone}>เข้าดูตารางงาน</button>
                    </>
                )}

                {/* ── Working ──────────────────────────────────────────────── */}
                {phase === "working" && (
                    <>
                        <Loader2 className="ps-spin" size={40} color="#1B6E8C" />
                        <div style={styles.title}>กำลังบันทึกสถานะ...</div>
                    </>
                )}

                {/* ── Done ─────────────────────────────────────────────────── */}
                {phase === "done" && (
                    <>
                        <div style={{ ...styles.iconWrap, background: (isStart || isClear) ? "#E3F5E9" : "#FDECEB" }}>
                            {(isStart) && <CheckCircle2 size={30} color="#21A366" />}
                            {isStop   && <XCircle size={30} color="#C4372E" />}
                            {isRaise  && <AlertOctagon size={30} color={ALARM_RED} />}
                            {isClear  && <CheckCircle2 size={30} color="#21A366" />}
                        </div>
                        <div style={styles.machName}>{job?.name || resource?.name}</div>
                        <div style={{ ...styles.title, color: (isStart || isClear) ? "#21A366" : "#C4372E" }}>
                            {isStart && "เริ่มทำงานแล้ว"}
                            {isStop  && "หยุดทำงานแล้ว"}
                            {isRaise && "แจ้งเตือนแล้ว"}
                            {isClear && "ยกเลิกแจ้งเตือนแล้ว"}
                        </div>
                        <div style={styles.sub}>{new Date().toLocaleString("th-TH")}</div>
                        <button className="ps-scan-btn" style={styles.btn} onClick={onDone}>เข้าดูตารางงาน</button>
                    </>
                )}

                {/* ── Error ────────────────────────────────────────────────── */}
                {phase === "error" && (
                    <>
                        <div style={{ ...styles.iconWrap, background: "#FDECEB" }}>
                            <AlertTriangle size={30} color="#C4372E" />
                        </div>
                        <div style={{ ...styles.title, color: "#C4372E" }}>เกิดข้อผิดพลาด</div>
                        <div style={styles.sub}>{errorMsg}</div>
                        <button className="ps-scan-btn" style={styles.btn} onClick={onDone}>เข้าดูตารางงาน</button>
                    </>
                )}
            </div>
        </div>
    );
}

// ── When this page is loaded as a JOB scan (kind="job") AND the bind tab
// is waiting, broadcast the job id so the bind tab can proceed inline. ──────
// This is called from App.jsx before rendering ScanAction with kind="job".
export function broadcastJobScan(jobId) {
    try {
        const ch = new BroadcastChannel("ps-scan");
        ch.postMessage({ jobId });
        ch.close();
    } catch {}
}

const styles = {
    wrap: {
        width: "100vw", height: "100vh",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "#F2F2F2",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        boxSizing: "border-box", padding: 20,
    },
    card: {
        width: "100%", maxWidth: 340,
        background: "#FFFFFF", border: "1px solid #D9D9D9",
        borderRadius: 4, padding: "32px 26px",
        display: "flex", flexDirection: "column",
        alignItems: "center", gap: 8,
        boxShadow: "0 8px 28px rgba(38,38,38,0.08)",
        boxSizing: "border-box", textAlign: "center",
    },
    stepBadge: {
        fontSize: 11.5, fontWeight: 700,
        padding: "3px 10px", borderRadius: 20,
        marginBottom: 4, letterSpacing: 0.2,
    },
    iconWrap: {
        width: 56, height: 56, borderRadius: 4,
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 6,
    },
    machName: {
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 15, color: "#262626", fontWeight: 600,
    },
    title: {
        fontFamily: "'Segoe UI', sans-serif",
        fontWeight: 700, fontSize: 17, color: "#262626",
    },
    sub: { fontSize: 12.5, color: "#6E6E6E", marginBottom: 10 },
    mismatchTable: {
        width: "100%", background: "#FAFAFA",
        border: "1px solid #E8E8E8", borderRadius: 6,
        padding: "10px 14px", marginTop: 4,
        display: "flex", flexDirection: "column", gap: 6,
    },
    mismatchRow: {
        display: "flex", justifyContent: "space-between",
        alignItems: "center", fontSize: 12.5, paddingBottom: 2,
    },
    mismatchLabel: { color: "#6E6E6E", fontWeight: 500 },
    mismatchVal: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 700 },
    btnRow: { display: "flex", gap: 10, marginTop: 20, width: "100%" },
    cancelBtn: {
        flex: 1, background: "#FFFFFF",
        border: "1px solid #C8C8C8", color: "#595959",
        borderRadius: 3, padding: "12px 0",
        fontSize: 13.5, fontWeight: 600, cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    confirmBtn: {
        flex: 1.4, border: "none", color: "#FFFFFF",
        borderRadius: 3, padding: "12px 0",
        fontSize: 13.5, fontWeight: 700, cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
    btn: {
        marginTop: 18, width: "100%",
        background: "#1B6E8C", color: "#FFFFFF",
        border: "none", borderRadius: 3, padding: "11px 0",
        fontSize: 13.5, fontWeight: 600, cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
    },
};