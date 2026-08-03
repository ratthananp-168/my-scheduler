import { useEffect, useState, useRef } from "react";
import { CheckCircle2, XCircle, Loader2, AlertTriangle, AlertOctagon, Play, Square, Cpu, AlertCircle, Camera, CameraOff } from "lucide-react";
import { supabase } from "./supabaseClient";
import jsQR from "jsqr";

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

// Parse QR URL → { kind, jobId } or null
function parseQRUrl(text) {
    try {
        const url    = new URL(text);
        const params = url.searchParams;
        const scan   = params.get("scan");
        const job    = params.get("job");
        if (scan === "start" && job) return { kind: "start", jobId: job };
    } catch {}
    return null;
}

export default function ScanAction({ kind, action, id, onDone }) {
    const [phase,       setPhase]       = useState("loading");
    const [resource,    setResource]    = useState(null);
    const [job,         setJob]         = useState(null);
    const [plannedRes,  setPlannedRes]  = useState(null);
    const [errorMsg,    setErrorMsg]    = useState("");
    const [alarmReason, setAlarmReason] = useState(ALARM_REASONS[0].id);
    const [blockReason, setBlockReason] = useState("");
    const [allData,     setAllData]     = useState(null);
    const [camError,    setCamError]    = useState("");
    const [scanning,    setScanning]    = useState(false);
    const [isOverride,  setIsOverride]  = useState(false);

    const videoRef   = useRef(null);
    const canvasRef  = useRef(null);
    const streamRef  = useRef(null);
    const rafRef     = useRef(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        load();
        return () => {
            mountedRef.current = false;
            stopCamera();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Camera helpers ────────────────────────────────────────────────────────
    async function startCamera() {
        setCamError("");
        setScanning(true);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false,
            });
            if (!mountedRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play();
                requestAnimationFrame(scanFrame);
            }
        } catch (err) {
            setScanning(false);
            if (err.name === "NotAllowedError") setCamError("ไม่ได้รับอนุญาตใช้กล้อง — กรุณาอนุญาตในการตั้งค่าเบราว์เซอร์");
            else setCamError("เปิดกล้องไม่ได้: " + err.message);
        }
    }

    function stopCamera() {
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
        if (videoRef.current) videoRef.current.srcObject = null;
        if (mountedRef.current) setScanning(false);
    }

    function scanFrame() {
        const video  = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || !mountedRef.current || !streamRef.current) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width  = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx  = canvas.getContext("2d");
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (code?.data) {
                const parsed = parseQRUrl(code.data);
                if (parsed) {
                    stopCamera();
                    handleJobScanned(parsed.jobId, resource, allData);
                    return;
                }
            }
        }
        rafRef.current = requestAnimationFrame(scanFrame);
    }

    // ── Load schedule data ────────────────────────────────────────────────────
    async function load() {
        const { data, error } = await supabase
            .from("schedule_state").select("data").eq("id", 1).single();

        if (error || !data?.data) {
            setPhase("error");
            setErrorMsg("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
            return;
        }

        const sd = data.data;
        setAllData(sd);

        if (kind === "bind") {
            const res = (sd.resources || []).find((r) => r.id === id);
            if (!res) { setPhase("error"); setErrorMsg("ไม่พบเครื่องจักรนี้ในระบบ"); return; }
            setResource(res);
            setPhase("bind_confirm");

        } else if (kind === "job") {
            const j = (sd.jobs || []).find((jj) => jj.id === id);
            if (!j) { setPhase("error"); setErrorMsg("ไม่พบงานนี้ในระบบ"); return; }
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
            const res = (sd.resources || []).find((r) => r.id === id);
            if (!res) { setPhase("error"); setErrorMsg("ไม่พบเครื่องจักรนี้ในระบบ"); return; }
            setResource(res);
            setPhase("alarm_confirm");
        }
    }

    // ── Bind confirm → open camera ────────────────────────────────────────────
    function handleConfirmBind() {
        setPhase("bind_scanning");
        setTimeout(startCamera, 80); // let DOM render first
    }

    // ── Job scanned (from camera decode) ─────────────────────────────────────
    function handleJobScanned(jobId, boundResource, sd) {
        const j = (sd.jobs || []).find((jj) => jj.id === jobId);
        if (!j) { setErrorMsg("ไม่พบงาน id: " + jobId); setPhase("error"); return; }
        const planned = (sd.resources || []).find((r) => r.id === j.resourceId) || null;
        setJob(j);
        setPlannedRes(planned);

        if (planned?.alarmActive) {
            const label = ALARM_REASONS.find((a) => a.id === planned.alarmReason)?.label || "แจ้งเตือน";
            setBlockReason(label);
            setPhase("blocked");
            return;
        }

        const match = planned && boundResource && planned.id === boundResource.id;
        setIsOverride(!match);
        setPhase(match ? "bind_job_confirm" : "bind_mismatch");
    }

    // ── Supabase writes ───────────────────────────────────────────────────────
    async function handleConfirmJobStart(targetJob) {
        setPhase("working");
        const { data, error } = await supabase
            .from("schedule_state").select("data").eq("id", 1).single();
        if (error || !data?.data) { setPhase("error"); setErrorMsg("โหลดข้อมูลไม่สำเร็จ"); return; }

        const nowIso = new Date().toISOString();
        // override → record actualResourceId (where it's actually running)
        // planning resourceId stays unchanged so Gantt planning bar doesn't move
        const actualResId = isOverride && resource ? resource.id : null;
        const jobs = (data.data.jobs || []).map((j) =>
            j.id !== targetJob.id ? j : {
                ...j,
                isRunning: true,
                runStartedAt: nowIso,
                lastScanAt: nowIso,
                completed: false,
                actualResourceId: actualResId,
            }
        );
        const { error: ue } = await supabase
            .from("schedule_state")
            .update({ data: { ...data.data, jobs }, updated_at: nowIso }).eq("id", 1);
        if (ue) { setPhase("error"); setErrorMsg("บันทึกสถานะไม่สำเร็จ"); return; }
        setPhase("done");
    }

    async function handleConfirmJob() {
        setPhase("working");
        const { data, error } = await supabase
            .from("schedule_state").select("data").eq("id", 1).single();
        if (error || !data?.data) { setPhase("error"); setErrorMsg("โหลดข้อมูลไม่สำเร็จ"); return; }

        const nowIso = new Date().toISOString();
        const toolHistory = Array.isArray(data.data.toolHistory)
            ? data.data.toolHistory.map((h) => ({ ...h })) : [];

        function upsertTool(number, name, hoursToAdd, jobName) {
            if (!name || hoursToAdd <= 0) return;
            const idx = toolHistory.findIndex((h) => (h.number || null) === (number || null) && h.name === name);
            if (idx === -1) { toolHistory.push({ number: number || null, name, actualHours: hoursToAdd, lastRunAt: nowIso, jobNames: jobName ? [jobName] : [] }); return; }
            const ex = toolHistory[idx];
            const jn = ex.jobNames ? [...ex.jobNames] : [];
            if (jobName && !jn.includes(jobName)) { jn.push(jobName); if (jn.length > 20) jn.shift(); }
            toolHistory[idx] = { ...ex, actualHours: (ex.actualHours || 0) + hoursToAdd, lastRunAt: nowIso, jobNames: jn };
        }

        const jobs = (data.data.jobs || []).map((j) => {
            if (j.id !== id) return j;
            if (action === "start") return { ...j, isRunning: true, runStartedAt: nowIso, lastScanAt: nowIso, completed: false };
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
        if (ue) { setPhase("error"); setErrorMsg("บันทึกสถานะไม่สำเร็จ"); return; }
        setPhase("done");
    }

    async function handleConfirmAlarm() {
        setPhase("working");
        const { data, error } = await supabase
            .from("schedule_state").select("data").eq("id", 1).single();
        if (error || !data?.data) { setPhase("error"); setErrorMsg("โหลดข้อมูลไม่สำเร็จ"); return; }

        const resources = (data.data.resources || []).map((r) =>
            r.id !== id ? r : action === "raise"
                ? { ...r, alarmActive: true, alarmReason, alarmAt: Date.now() }
                : { ...r, alarmActive: false, alarmReason: null, alarmAt: null }
        );
        const { error: ue } = await supabase.from("schedule_state")
            .update({ data: { ...data.data, resources }, updated_at: new Date().toISOString() }).eq("id", 1);
        if (ue) { setPhase("error"); setErrorMsg("บันทึกสถานะไม่สำเร็จ"); return; }
        setPhase("done");
    }

    // ── Derived ───────────────────────────────────────────────────────────────
    const isStart = kind === "job" && action === "start";
    const isStop  = kind === "job" && action === "stop";
    const isRaise = kind === "alarm" && action === "raise";
    const isClear = kind === "alarm" && action === "clear";
    const resDisplay = plannedRes?.name || (kind !== "job" ? resource?.name : "") || "unassigned";

    const doneIsGreen = isStart || isClear || phase === "bind_job_confirm" || phase === "bind_mismatch";

    return (
        <div style={styles.wrap}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap');
                @keyframes spin   { to { transform:rotate(360deg); } }
                @keyframes fadeIn { from { opacity:0;transform:translateY(8px); } to { opacity:1;transform:translateY(0); } }
                @keyframes scan   { 0%,100% { top:8%; } 50% { top:82%; } }
                .ps-spin   { animation:spin 1s linear infinite; }
                .ps-fadein { animation:fadeIn 0.22s ease; }
                .ps-scanline { position:absolute; left:0; right:0; height:2px; background:rgba(29,78,216,0.7); animation:scan 1.8s ease-in-out infinite; box-shadow:0 0 8px rgba(29,78,216,0.5); }
                .ps-btn-primary:hover { filter:brightness(0.9); }
                .ps-btn-cancel:hover  { background:#EBEBEB !important; }
                .ps-scan-select { background:#fff; border:1px solid #C8C8C8; color:#262626; border-radius:8px; padding:9px 10px; font-family:'Segoe UI','Inter',sans-serif; font-size:13.5px; width:100%; box-sizing:border-box; margin-top:14px; }
            `}</style>

            {/* hidden canvas for QR decode */}
            <canvas ref={canvasRef} style={{ display: "none" }} />

            <div style={styles.card} className="ps-fadein" key={phase}>

                {/* Loading */}
                {phase === "loading" && (
                    <><Loader2 className="ps-spin" size={40} color="#1B6E8C" /><div style={styles.title}>กำลังโหลดข้อมูล...</div></>
                )}

                {/* ── Step 1: confirm machine ── */}
                {phase === "bind_confirm" && resource && (
                    <>
                        <div style={{ ...styles.badge, background: BIND_BG, color: BIND_BLUE }}>ขั้นที่ 1 / 2 — เลือกเครื่อง</div>
                        <div style={{ ...styles.iconWrap, background: BIND_BG }}>
                            <Cpu size={28} color={BIND_BLUE} strokeWidth={2.5} />
                        </div>
                        <div style={styles.mono}>{resource.name}</div>
                        <div style={styles.sub}>{resource.type}</div>
                        <div style={{ ...styles.title, marginTop: 8 }}>ยืนยันเลือกเครื่องนี้?</div>
                        <div style={styles.btnRow}>
                            <button className="ps-btn-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button className="ps-btn-primary" style={{ ...styles.confirmBtn, background: BIND_BLUE }} onClick={handleConfirmBind}>
                                ยืนยัน → สแกนงาน
                            </button>
                        </div>
                    </>
                )}

                {/* ── Step 2: camera viewfinder ── */}
                {phase === "bind_scanning" && resource && (
                    <>
                        <div style={{ ...styles.badge, background: BIND_BG, color: BIND_BLUE }}>ขั้นที่ 2 / 2 — สแกน QR งาน</div>
                        <div style={styles.mono}>{resource.name}</div>

                        {/* viewfinder */}
                        <div style={styles.viewfinderWrap}>
                            <video ref={videoRef} style={styles.video} playsInline muted />
                            {scanning && <div className="ps-scanline" />}
                            {/* corner brackets */}
                            {["tl","tr","bl","br"].map((c) => (
                                <div key={c} style={{ ...styles.corner, ...cornerPos[c] }} />
                            ))}
                        </div>

                        {camError && (
                            <div style={styles.camErr}>
                                <CameraOff size={14} /> {camError}
                            </div>
                        )}

                        {!scanning && !camError && (
                            <button className="ps-btn-primary" style={{ ...styles.confirmBtn, background: BIND_BLUE, width: "100%", marginTop: 10 }}
                                onClick={startCamera}>
                                <Camera size={15} style={{ marginRight: 6 }} /> เปิดกล้อง
                            </button>
                        )}

                        <div style={styles.sub}>หันกล้องไปที่ QR งาน (START) เพื่อเริ่มทำงาน</div>
                        <button className="ps-btn-cancel" style={{ ...styles.cancelBtn, width: "100%" }} onClick={onDone}>ยกเลิก</button>
                    </>
                )}

                {/* ── Mismatch ── */}
                {phase === "bind_mismatch" && job && (
                    <>
                        <div style={{ ...styles.badge, background: "#FEF3C7", color: WARN_AMBER }}>⚠ งานไม่ตรงกับเครื่องที่เลือก</div>
                        <div style={{ ...styles.iconWrap, background: "#FEF3C7" }}>
                            <AlertCircle size={28} color={WARN_AMBER} strokeWidth={2.5} />
                        </div>
                        <div style={styles.mono}>{job.name}</div>
                        <div style={styles.mismatchTable}>
                            <div style={styles.mismatchRow}>
                                <span style={styles.mismatchLabel}>เครื่องที่สแกน</span>
                                <span style={{ ...styles.mismatchVal, color: WARN_AMBER }}>{resource?.name || "—"}</span>
                            </div>
                            <div style={{ ...styles.mismatchRow, borderTop: "1px solid #E8E8E8", paddingTop: 6 }}>
                                <span style={styles.mismatchLabel}>เครื่องตาม Planning</span>
                                <span style={{ ...styles.mismatchVal, color: RUNNING_GREEN_DARK }}>{plannedRes?.name || "ไม่ได้กำหนด"}</span>
                            </div>
                        </div>
                        <div style={styles.warnBox}>
                            งานนี้ถูกวางแผนไว้บน <b>{plannedRes?.name || "เครื่องอื่น"}</b><br />
                            กรุณาตรวจสอบกับ Supervisor ก่อนดำเนินการต่อ
                        </div>
                        <div style={styles.btnRow}>
                            <button className="ps-btn-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button className="ps-btn-primary" style={{ ...styles.confirmBtn, background: WARN_AMBER, fontSize: 12.5 }}
                                onClick={() => setPhase("bind_job_confirm")}>
                                Override &amp; เริ่มงาน
                            </button>
                        </div>
                    </>
                )}

                {/* ── Bind job confirm ── */}
                {phase === "bind_job_confirm" && job && (
                    <>
                        <div style={{ ...styles.badge, background: "#E3F5E9", color: RUNNING_GREEN_DARK }}>ขั้นที่ 2 / 2 — เริ่มงาน</div>
                        <div style={{ ...styles.iconWrap, background: "#E3F5E9" }}>
                            <Play size={28} color={RUNNING_GREEN_DARK} strokeWidth={2.5} />
                        </div>
                        <div style={styles.mono}>{job.name}</div>
                        <div style={styles.sub}>{resDisplay} · {job.product}</div>
                        <div style={{ ...styles.title, marginTop: 8 }}>ยืนยันเริ่มงาน?</div>
                        <div style={styles.btnRow}>
                            <button className="ps-btn-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button className="ps-btn-primary" style={{ ...styles.confirmBtn, background: RUNNING_GREEN }}
                                onClick={() => handleConfirmJobStart(job)}>ยืนยันเริ่มงาน</button>
                        </div>
                    </>
                )}

                {/* ── Standalone job confirm ── */}
                {phase === "job_confirm" && job && (
                    <>
                        <div style={{ ...styles.iconWrap, background: isStart ? "#E3F5E9" : "#FFF1EF" }}>
                            {isStart ? <Play size={28} color={RUNNING_GREEN_DARK} strokeWidth={2.5} />
                                     : <Square size={28} color="#C4372E" strokeWidth={2.5} />}
                        </div>
                        <div style={styles.mono}>{job.name}</div>
                        <div style={styles.sub}>{resDisplay} · {job.product}</div>
                        <div style={{ ...styles.title, marginTop: 8 }}>ยืนยัน{isStart ? "เริ่มงาน" : "หยุดงาน"}?</div>
                        <div style={styles.btnRow}>
                            <button className="ps-btn-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button className="ps-btn-primary" style={{ ...styles.confirmBtn, background: isStart ? RUNNING_GREEN : "#C4372E" }}
                                onClick={handleConfirmJob}>{isStart ? "ยืนยันเริ่มงาน" : "ยืนยันหยุดงาน"}</button>
                        </div>
                    </>
                )}

                {/* ── Alarm confirm ── */}
                {phase === "alarm_confirm" && resource && (
                    <>
                        <div style={{ ...styles.iconWrap, background: isRaise ? "#FDECEB" : "#E3F5E9" }}>
                            {isRaise ? <AlertOctagon size={28} color={ALARM_RED} strokeWidth={2.5} />
                                     : <CheckCircle2 size={28} color={RUNNING_GREEN_DARK} strokeWidth={2.5} />}
                        </div>
                        <div style={styles.mono}>{resource.name}</div>
                        <div style={styles.sub}>{resource.type}</div>
                        <div style={{ ...styles.title, marginTop: 8 }}>ยืนยัน{isRaise ? "แจ้งเตือน" : "ยกเลิกแจ้งเตือน"}?</div>
                        {isRaise && (
                            <select className="ps-scan-select" value={alarmReason} onChange={(e) => setAlarmReason(e.target.value)}>
                                {ALARM_REASONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                            </select>
                        )}
                        <div style={styles.btnRow}>
                            <button className="ps-btn-cancel" style={styles.cancelBtn} onClick={onDone}>ยกเลิก</button>
                            <button className="ps-btn-primary" style={{ ...styles.confirmBtn, background: isRaise ? ALARM_RED : RUNNING_GREEN }}
                                onClick={handleConfirmAlarm}>{isRaise ? "ยืนยันแจ้งเตือน" : "ยืนยันยกเลิก"}</button>
                        </div>
                    </>
                )}

                {/* ── Blocked ── */}
                {phase === "blocked" && (
                    <>
                        <div style={{ ...styles.iconWrap, background: "#FBE4E2" }}>
                            <AlertOctagon size={28} color={ALARM_RED} strokeWidth={2.5} />
                        </div>
                        <div style={styles.mono}>{job?.name}</div>
                        <div style={styles.sub}>{resDisplay}</div>
                        <div style={{ ...styles.title, color: ALARM_RED_DARK, marginTop: 8 }}>ไม่สามารถเริ่มงานได้</div>
                        <div style={styles.sub}>เครื่อง {resDisplay} มีการแจ้งเตือน: {blockReason}<br />กรุณาเคลียร์ก่อนเริ่มงาน</div>
                        <button className="ps-btn-primary ps-scan-btn" style={styles.btn} onClick={onDone}>เข้าดูตารางงาน</button>
                    </>
                )}

                {/* ── Working ── */}
                {phase === "working" && (
                    <><Loader2 className="ps-spin" size={40} color="#1B6E8C" /><div style={styles.title}>กำลังบันทึกสถานะ...</div></>
                )}

                {/* ── Done ── */}
                {phase === "done" && (
                    <>
                        <div style={{ ...styles.iconWrap, background: doneIsGreen ? "#E3F5E9" : "#FDECEB" }}>
                            {(isStart || phase === "bind_job_confirm") && <CheckCircle2 size={30} color="#21A366" />}
                            {isStop  && <XCircle size={30} color="#C4372E" />}
                            {isRaise && <AlertOctagon size={30} color={ALARM_RED} />}
                            {isClear && <CheckCircle2 size={30} color="#21A366" />}
                            {(!isStart && !isStop && !isRaise && !isClear) && <CheckCircle2 size={30} color="#21A366" />}
                        </div>
                        <div style={styles.mono}>{job?.name || resource?.name}</div>
                        <div style={{ ...styles.title, color: doneIsGreen ? "#21A366" : "#C4372E" }}>
                            {isStop ? "หยุดทำงานแล้ว" : isRaise ? "แจ้งเตือนแล้ว" : isClear ? "ยกเลิกแจ้งเตือนแล้ว" : "เริ่มทำงานแล้ว"}
                        </div>
                        <div style={styles.sub}>{new Date().toLocaleString("th-TH")}</div>
                        <button className="ps-btn-primary" style={styles.btn} onClick={onDone}>เข้าดูตารางงาน</button>
                    </>
                )}

                {/* ── Error ── */}
                {phase === "error" && (
                    <>
                        <div style={{ ...styles.iconWrap, background: "#FDECEB" }}>
                            <AlertTriangle size={30} color="#C4372E" />
                        </div>
                        <div style={{ ...styles.title, color: "#C4372E" }}>เกิดข้อผิดพลาด</div>
                        <div style={styles.sub}>{errorMsg}</div>
                        <button className="ps-btn-primary" style={styles.btn} onClick={onDone}>เข้าดูตารางงาน</button>
                    </>
                )}
            </div>
        </div>
    );
}

export function broadcastJobScan(jobId) {
    try { const ch = new BroadcastChannel("ps-scan"); ch.postMessage({ jobId }); ch.close(); } catch {}
}

const cornerPos = {
    tl: { top: 0,    left: 0,    borderTopWidth: 3,    borderLeftWidth: 3,    borderBottomWidth: 0, borderRightWidth: 0 },
    tr: { top: 0,    right: 0,   borderTopWidth: 3,    borderRightWidth: 3,   borderBottomWidth: 0, borderLeftWidth: 0 },
    bl: { bottom: 0, left: 0,    borderBottomWidth: 3, borderLeftWidth: 3,    borderTopWidth: 0,    borderRightWidth: 0 },
    br: { bottom: 0, right: 0,   borderBottomWidth: 3, borderRightWidth: 3,   borderTopWidth: 0,    borderLeftWidth: 0 },
};

const styles = {
    wrap: { width:"100vw", height:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#F2F2F2", fontFamily:"'Segoe UI','Inter',sans-serif", boxSizing:"border-box", padding:20 },
    card: { width:"100%", maxWidth:360, background:"#FFFFFF", border:"1px solid #D9D9D9", borderRadius:4, padding:"28px 24px", display:"flex", flexDirection:"column", alignItems:"center", gap:8, boxShadow:"0 8px 28px rgba(38,38,38,0.08)", boxSizing:"border-box", textAlign:"center" },
    badge: { fontSize:11.5, fontWeight:700, padding:"3px 10px", borderRadius:20, marginBottom:4 },
    iconWrap: { width:56, height:56, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:6 },
    mono: { fontFamily:"'IBM Plex Mono',monospace", fontSize:15, color:"#262626", fontWeight:600 },
    title: { fontFamily:"'Segoe UI',sans-serif", fontWeight:700, fontSize:17, color:"#262626" },
    sub: { fontSize:12.5, color:"#6E6E6E", marginBottom:6, lineHeight:1.6 },
    viewfinderWrap: { position:"relative", width:"100%", aspectRatio:"1/1", background:"#000", borderRadius:8, overflow:"hidden", marginTop:4, marginBottom:4 },
    video: { width:"100%", height:"100%", objectFit:"cover", display:"block" },
    corner: { position:"absolute", width:22, height:22, borderColor:"#FFFFFF", borderStyle:"solid", borderWidth:3 },
    camErr: { display:"flex", alignItems:"center", gap:6, fontSize:12, color:ALARM_RED_DARK, background:"#FEF2F2", border:"1px solid #FECACA", borderRadius:6, padding:"7px 10px", width:"100%", boxSizing:"border-box", textAlign:"left" },
    warnBox: { fontSize:12, color:"#78350F", background:"#FFFBEB", border:"1px solid #FDE68A", borderRadius:6, padding:"8px 12px", textAlign:"left", lineHeight:1.65, width:"100%", boxSizing:"border-box" },
    mismatchTable: { width:"100%", background:"#FAFAFA", border:"1px solid #E8E8E8", borderRadius:6, padding:"10px 14px", display:"flex", flexDirection:"column", gap:6 },
    mismatchRow: { display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:12.5, paddingBottom:2 },
    mismatchLabel: { color:"#6E6E6E", fontWeight:500 },
    mismatchVal: { fontFamily:"'IBM Plex Mono',monospace", fontSize:12, fontWeight:700 },
    btnRow: { display:"flex", gap:10, marginTop:16, width:"100%" },
    cancelBtn: { flex:1, background:"#FFFFFF", border:"1px solid #C8C8C8", color:"#595959", borderRadius:3, padding:"12px 0", fontSize:13.5, fontWeight:600, cursor:"pointer", fontFamily:"'Segoe UI','Inter',sans-serif" },
    confirmBtn: { flex:1.5, border:"none", color:"#FFFFFF", borderRadius:3, padding:"12px 0", fontSize:13.5, fontWeight:700, cursor:"pointer", fontFamily:"'Segoe UI','Inter',sans-serif", display:"flex", alignItems:"center", justifyContent:"center" },
    btn: { marginTop:16, width:"100%", background:"#1B6E8C", color:"#FFFFFF", border:"none", borderRadius:3, padding:"11px 0", fontSize:13.5, fontWeight:600, cursor:"pointer", fontFamily:"'Segoe UI','Inter',sans-serif" },
};