import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Loader2, AlertTriangle, AlertOctagon, Play, Square } from "lucide-react";
import { supabase } from "./supabaseClient";

const ALARM_REASONS = [
    { id: "breakdown", label: "เครื่องขัดข้อง" },
    { id: "material", label: "ขาดวัตถุดิบ" },
    { id: "quality", label: "ปัญหาคุณภาพ" },
    { id: "other", label: "ต้องการความช่วยเหลือ" },
];

const RUNNING_GREEN = "#009140";
const RUNNING_GREEN_DARK = "#00612B";
const ALARM_RED = "#FF2D20";
const ALARM_RED_DARK = "#D6180A";

// kind: "job"   -> action: "start" | "stop",  id: jobId
// kind: "alarm" -> action: "raise" | "clear", id: resourceId
// Flow: loading (read-only fetch to show details) -> confirm (waits for a tap) -> working (writes to Supabase) -> done / error
export default function ScanAction({ kind, action, id, onDone }) {
    const [status, setStatus] = useState("loading");
    const [target, setTarget] = useState(null); // job or resource snapshot, read-only, just for display
    const [resourceName, setResourceName] = useState(""); // for job kind: the resource it's assigned to
    const [errorMsg, setErrorMsg] = useState("");
    const [alarmReason, setAlarmReason] = useState(ALARM_REASONS[0].id);
    const [blockReason, setBlockReason] = useState(""); // set when a job-start is blocked by an active resource alarm
    const [errorStage, setErrorStage] = useState(null); // "load" | "confirm" - which step to retry

    async function load() {
        try {
            const { data, error } = await supabase
                .from("schedule_state")
                .select("data")
                .eq("id", 1)
                .single();

            if (error || !data?.data) {
                setErrorStage("load");
                setStatus("error");
                setErrorMsg("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
                return;
            }

            if (kind === "job") {
                const job = (data.data.jobs || []).find((j) => j.id === id);
                if (!job) {
                    setStatus("error");
                    setErrorMsg("ไม่พบงานนี้ในระบบ (job id: " + id + ")");
                    return;
                }
                const resource = (data.data.resources || []).find((r) => r.id === job.resourceId);
                setTarget(job);
                setResourceName(resource ? resource.name : "unassigned");

                if (action === "start" && resource?.alarmActive) {
                    const reasonLabel = ALARM_REASONS.find((a) => a.id === resource.alarmReason)?.label || "แจ้งเตือน";
                    setBlockReason(reasonLabel);
                    setStatus("blocked");
                } else {
                    setStatus("confirm");
                }
            } else {
                const resource = (data.data.resources || []).find((r) => r.id === id);
                if (!resource) {
                    setStatus("error");
                    setErrorMsg("ไม่พบเครื่องจักรนี้ในระบบ (resource id: " + id + ")");
                    return;
                }
                setTarget(resource);
                setStatus("confirm");
            }
        } catch (err) {
            // network hiccup (e.g. right after switching from the camera/QR app to the browser) -
            // supabase-js throws instead of returning {error} for genuine connection failures
            setErrorStage("load");
            setStatus("error");
            setErrorMsg("เชื่อมต่อไม่สำเร็จ (เครือข่ายอาจมีปัญหาชั่วคราว) กดลองอีกครั้ง");
        }
    }

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function handleConfirm() {
        setStatus("working");

        try {
            const { data, error } = await supabase
                .from("schedule_state")
                .select("data")
                .eq("id", 1)
                .single();

            if (error || !data?.data) {
                setErrorStage("confirm");
                setStatus("error");
                setErrorMsg("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
                return;
            }

            let payload = data.data;

            if (kind === "job") {
                const jobs = (data.data.jobs || []).map((j) =>
                    j.id === id ? { ...j, isRunning: action === "start", lastScanAt: new Date().toISOString() } : j
                );
                payload = { ...data.data, jobs };
            } else {
                const resources = (data.data.resources || []).map((r) =>
                    r.id === id
                        ? action === "raise"
                            ? { ...r, alarmActive: true, alarmReason, alarmAt: Date.now() }
                            : { ...r, alarmActive: false, alarmReason: null, alarmAt: null }
                        : r
                );
                payload = { ...data.data, resources };
            }

            const { error: updateError } = await supabase
                .from("schedule_state")
                .update({ data: payload, updated_at: new Date().toISOString() })
                .eq("id", 1);

            if (updateError) {
                setErrorStage("confirm");
                setStatus("error");
                setErrorMsg("บันทึกสถานะไม่สำเร็จ ลองใหม่อีกครั้ง");
                return;
            }

            setStatus("done");
        } catch (err) {
            // network hiccup mid-write - without this catch the screen would hang on
            // "working" forever with nothing written and no way to retry but a full refresh
            setErrorStage("confirm");
            setStatus("error");
            setErrorMsg("เชื่อมต่อไม่สำเร็จระหว่างบันทึก (เครือข่ายอาจมีปัญหาชั่วคราว) กดลองอีกครั้ง");
        }
    }

    function handleRetry() {
        setErrorMsg("");
        if (errorStage === "confirm") {
            handleConfirm();
        } else {
            setStatus("loading");
            load();
        }
    }

    const isStart = kind === "job" && action === "start";
    const isStop = kind === "job" && action === "stop";
    const isRaise = kind === "alarm" && action === "raise";
    const isClear = kind === "alarm" && action === "clear";

    return (
        <div style={styles.wrap}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap');
                @keyframes spin { to { transform: rotate(360deg); } }
                .ps-spin { animation: spin 1s linear infinite; }
                .ps-scan-btn:hover { background: #234F60 !important; }
                .ps-scan-cancel:hover { background: #E4EAEC !important; }
                .ps-scan-select { background:#F2F6F7; border:1px solid #DCE4E7; color:#1B2226; border-radius:10px; padding:9px 10px; font-family:'Inter',sans-serif; font-size:13.5px; width:100%; box-sizing:border-box; margin-top:14px; }
            `}</style>
            <div style={styles.card}>
                {status === "loading" && (
                    <>
                        <Loader2 className="ps-spin" size={40} color="#2F6E86" />
                        <div style={styles.title}>กำลังโหลดข้อมูล...</div>
                    </>
                )}

                {status === "blocked" && target && (
                    <>
                        <div style={{ ...styles.iconWrap, background: "#FBE4E2" }}>
                            <AlertOctagon size={28} color={ALARM_RED} strokeWidth={2.5} />
                        </div>
                        <div style={styles.jobName}>{target.name}</div>
                        <div style={styles.sub}>{resourceName}</div>
                        <div style={{ ...styles.title, color: ALARM_RED_DARK, marginTop: 10 }}>
                            ไม่สามารถเริ่มงานได้
                        </div>
                        <div style={styles.sub}>
                            เครื่อง {resourceName} มีการแจ้งเตือนอยู่: {blockReason}
                            <br />
                            กรุณาเคลียร์การแจ้งเตือนก่อนเริ่มงาน
                        </div>
                        <button className="ps-scan-btn" style={styles.btn} onClick={onDone}>
                            เข้าดูตารางงาน
                        </button>
                    </>
                )}

                {status === "confirm" && kind === "job" && target && (
                    <>
                        <div style={{ ...styles.iconWrap, background: isStart ? "#E4F5EE" : "#FFF1EF" }}>
                            {isStart ? (
                                <Play size={28} color={RUNNING_GREEN_DARK} strokeWidth={2.5} />
                            ) : (
                                <Square size={28} color="#C4372E" strokeWidth={2.5} />
                            )}
                        </div>
                        <div style={styles.jobName}>{target.name}</div>
                        <div style={styles.sub}>{resourceName} · {target.product}</div>
                        <div style={{ ...styles.title, marginTop: 10 }}>
                            ยืนยัน{isStart ? "เริ่มงาน" : "หยุดงาน"}?
                        </div>
                        <div style={styles.btnRow}>
                            <button className="ps-scan-cancel" style={styles.cancelBtn} onClick={onDone}>
                                ยกเลิก
                            </button>
                            <button
                                style={{ ...styles.confirmBtn, background: isStart ? RUNNING_GREEN : "#C4372E" }}
                                onClick={handleConfirm}
                            >
                                {isStart ? "ยืนยันเริ่มงาน" : "ยืนยันหยุดงาน"}
                            </button>
                        </div>
                    </>
                )}

                {status === "confirm" && kind === "alarm" && target && (
                    <>
                        <div style={{ ...styles.iconWrap, background: isRaise ? "#FDECEB" : "#E4F5EE" }}>
                            {isRaise ? (
                                <AlertOctagon size={28} color={ALARM_RED} strokeWidth={2.5} />
                            ) : (
                                <CheckCircle2 size={28} color={RUNNING_GREEN_DARK} strokeWidth={2.5} />
                            )}
                        </div>
                        <div style={styles.jobName}>{target.name}</div>
                        <div style={styles.sub}>{target.type}</div>
                        <div style={{ ...styles.title, marginTop: 10 }}>
                            ยืนยัน{isRaise ? "แจ้งเตือน" : "ยกเลิกแจ้งเตือน"}?
                        </div>
                        {isRaise && (
                            <select
                                className="ps-scan-select"
                                value={alarmReason}
                                onChange={(e) => setAlarmReason(e.target.value)}
                            >
                                {ALARM_REASONS.map((a) => (
                                    <option key={a.id} value={a.id}>{a.label}</option>
                                ))}
                            </select>
                        )}
                        <div style={styles.btnRow}>
                            <button className="ps-scan-cancel" style={styles.cancelBtn} onClick={onDone}>
                                ยกเลิก
                            </button>
                            <button
                                style={{ ...styles.confirmBtn, background: isRaise ? ALARM_RED : RUNNING_GREEN }}
                                onClick={handleConfirm}
                            >
                                {isRaise ? "ยืนยันแจ้งเตือน" : "ยืนยันยกเลิก"}
                            </button>
                        </div>
                    </>
                )}

                {status === "working" && (
                    <>
                        <Loader2 className="ps-spin" size={40} color="#2F6E86" />
                        <div style={styles.title}>กำลังบันทึกสถานะ...</div>
                    </>
                )}

                {status === "done" && (
                    <>
                        <div style={{ ...styles.iconWrap, background: isStart || isClear ? "#E4F5EE" : "#FDECEB" }}>
                            {isStart && <CheckCircle2 size={30} color="#17A2A0" />}
                            {isStop && <XCircle size={30} color="#C4372E" />}
                            {isRaise && <AlertOctagon size={30} color={ALARM_RED} />}
                            {isClear && <CheckCircle2 size={30} color="#17A2A0" />}
                        </div>
                        <div style={styles.jobName}>{target?.name}</div>
                        <div style={{ ...styles.title, color: isStart || isClear ? "#17A2A0" : "#C4372E" }}>
                            {isStart && "เริ่มทำงานแล้ว"}
                            {isStop && "หยุดทำงานแล้ว"}
                            {isRaise && "แจ้งเตือนแล้ว"}
                            {isClear && "ยกเลิกแจ้งเตือนแล้ว"}
                        </div>
                        <div style={styles.sub}>{new Date().toLocaleString("th-TH")}</div>
                    </>
                )}

                {status === "error" && (
                    <>
                        <div style={{ ...styles.iconWrap, background: "#FDECEB" }}>
                            <AlertTriangle size={30} color="#C4372E" />
                        </div>
                        <div style={{ ...styles.title, color: "#C4372E" }}>เกิดข้อผิดพลาด</div>
                        <div style={styles.sub}>{errorMsg}</div>
                        <div style={styles.btnRow}>
                            <button className="ps-scan-cancel" style={styles.cancelBtn} onClick={onDone}>
                                เข้าดูตารางงาน
                            </button>
                            <button style={{ ...styles.confirmBtn, background: "#2F6E86" }} onClick={handleRetry}>
                                ลองอีกครั้ง
                            </button>
                        </div>
                    </>
                )}

                {status === "done" && (
                    <button className="ps-scan-btn" style={styles.btn} onClick={onDone}>
                        เข้าดูตารางงาน
                    </button>
                )}
            </div>
        </div>
    );
}

const styles = {
    wrap: {
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#F7F9FA",
        fontFamily: "'Inter', sans-serif",
        boxSizing: "border-box",
        padding: 20,
    },
    card: {
        width: "100%",
        maxWidth: 340,
        background: "#FFFFFF",
        border: "1px solid #E4EAEC",
        borderRadius: 18,
        padding: "36px 26px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        boxShadow: "0 8px 28px rgba(27,34,38,0.08)",
        boxSizing: "border-box",
        textAlign: "center",
    },
    iconWrap: {
        width: 56,
        height: 56,
        borderRadius: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginBottom: 6,
    },
    jobName: {
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 15,
        color: "#1B2226",
        fontWeight: 600,
    },
    title: {
        fontFamily: "'Poppins', sans-serif",
        fontWeight: 700,
        fontSize: 17,
        color: "#1B2226",
    },
    sub: {
        fontSize: 12.5,
        color: "#7C8A93",
        marginBottom: 10,
    },
    btnRow: {
        display: "flex",
        gap: 10,
        marginTop: 20,
        width: "100%",
    },
    cancelBtn: {
        flex: 1,
        background: "#F2F6F7",
        border: "1px solid #DCE4E7",
        color: "#5B6B72",
        borderRadius: 12,
        padding: "12px 0",
        fontSize: 13.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Inter', sans-serif",
    },
    confirmBtn: {
        flex: 1.4,
        border: "none",
        color: "#FFFFFF",
        borderRadius: 12,
        padding: "12px 0",
        fontSize: 13.5,
        fontWeight: 700,
        cursor: "pointer",
        fontFamily: "'Inter', sans-serif",
    },
    btn: {
        marginTop: 18,
        width: "100%",
        background: "#2F6E86",
        color: "#FFFFFF",
        border: "none",
        borderRadius: 10,
        padding: "11px 0",
        fontSize: 13.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Inter', sans-serif",
    },
};