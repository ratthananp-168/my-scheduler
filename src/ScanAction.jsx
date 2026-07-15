import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from "lucide-react";
import { supabase } from "./supabaseClient";

// reads ?scan=start|stop & job=<jobId> from the URL, updates the job's
// running status in Supabase, and shows a big confirmation screen.
export default function ScanAction({ action, jobId, onDone }) {
    const [status, setStatus] = useState("working"); // working | done | error
    const [jobName, setJobName] = useState("");
    const [errorMsg, setErrorMsg] = useState("");

    useEffect(() => {
        async function run() {
            const { data, error } = await supabase
                .from("schedule_state")
                .select("data")
                .eq("id", 1)
                .single();

            if (error || !data?.data?.jobs) {
                setStatus("error");
                setErrorMsg("โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
                return;
            }

            const jobs = data.data.jobs;
            const job = jobs.find((j) => j.id === jobId);
            if (!job) {
                setStatus("error");
                setErrorMsg("ไม่พบงานนี้ในระบบ (job id: " + jobId + ")");
                return;
            }

            job.isRunning = action === "start";
            job.lastScanAt = new Date().toISOString();

            const { error: updateError } = await supabase
                .from("schedule_state")
                .update({ data: { ...data.data, jobs }, updated_at: new Date().toISOString() })
                .eq("id", 1);

            if (updateError) {
                setStatus("error");
                setErrorMsg("บันทึกสถานะไม่สำเร็จ ลองใหม่อีกครั้ง");
                return;
            }

            setJobName(job.name);
            setStatus("done");
        }
        run();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const isStart = action === "start";

    return (
        <div style={styles.wrap}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap');
                @keyframes spin { to { transform: rotate(360deg); } }
                .ps-spin { animation: spin 1s linear infinite; }
                .ps-scan-btn:hover { background: #234F60 !important; }
            `}</style>
            <div style={styles.card}>
                {status === "working" && (
                    <>
                        <Loader2 className="ps-spin" size={40} color="#2F6E86" />
                        <div style={styles.title}>กำลังบันทึกสถานะ...</div>
                    </>
                )}

                {status === "done" && (
                    <>
                        <div style={{ ...styles.iconWrap, background: isStart ? "#E4F5EE" : "#FDECEB" }}>
                            {isStart ? <CheckCircle2 size={30} color="#17A2A0" /> : <XCircle size={30} color="#C4372E" />}
                        </div>
                        <div style={styles.jobName}>{jobName}</div>
                        <div style={{ ...styles.title, color: isStart ? "#17A2A0" : "#C4372E" }}>
                            {isStart ? "เริ่มทำงานแล้ว" : "หยุดทำงานแล้ว"}
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
                    </>
                )}

                <button className="ps-scan-btn" style={styles.btn} onClick={onDone}>
                    เข้าดูตารางงาน
                </button>
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
