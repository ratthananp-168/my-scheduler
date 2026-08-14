import { useState } from "react";
import { supabase } from "./supabaseClient";
import { Lock, AlertCircle, LogIn } from "lucide-react";

// same SHA-256 hash as production-scheduler.jsx — must stay in sync
async function hashPassword(plain) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function Login({ onSuccess }) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError]       = useState("");
    const [loading, setLoading]   = useState(false);

    async function handleSubmit(e) {
        if (e && e.preventDefault) e.preventDefault();
        setError("");
        if (!username.trim() || !password) {
            setError("Please enter username and password");
            return;
        }
        setLoading(true);
        try {
            const { data, error: dbError } = await supabase
                .from("schedule_state")
                .select("data")
                .eq("id", 1)
                .single();

            if (dbError) throw new Error("Cannot reach database");

            const users = data?.data?.users || [];

            // first-run bootstrap: no users yet → accept anything as admin
            if (users.length === 0) {
                sessionStorage.setItem("ps-authed", "1");
                sessionStorage.setItem("ps-username", username.trim());
                sessionStorage.setItem("ps-role", "admin");
                onSuccess();
                return;
            }

            const match = users.find(
                (u) => u.username.toLowerCase() === username.trim().toLowerCase()
            );
            if (!match) {
                setError("Incorrect username or password");
                setLoading(false);
                return;
            }

            const hash = await hashPassword(password);
            if (hash !== match.passwordHash) {
                setError("Incorrect username or password");
                setLoading(false);
                return;
            }

            sessionStorage.setItem("ps-authed", "1");
            sessionStorage.setItem("ps-username", match.username);
            sessionStorage.setItem("ps-role", match.role);
            // record last login time — fire-and-forget, don't block onSuccess
            supabase.from("schedule_state").select("data").eq("id", 1).single().then(({ data }) => {
                if (!data?.data) return;
                const updatedUsers = (data.data.users || []).map((u) =>
                    u.id === match.id ? { ...u, lastLoginAt: new Date().toISOString() } : u
                );
                supabase.from("schedule_state")
                    .update({ data: { ...data.data, users: updatedUsers }, updated_at: new Date().toISOString() })
                    .eq("id", 1).then();
            });
            onSuccess();
        } catch (e) {
            setError(e.message || "Login failed");
            setLoading(false);
        }
    }

    return (
        <div style={styles.wrap}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&display=swap');
                .ps-login-input:focus {
                    outline: none;
                    border-color: #1976D2 !important;
                    box-shadow: 0 0 0 1px rgba(25,118,210,0.35);
                }
                .ps-login-input::placeholder { color: #9A9A9A; }
                .ps-login-btn:hover { background: #1565C0 !important; }
                .ps-login-btn:active { background: #0F559E !important; }
            `}</style>
            <form onSubmit={handleSubmit} style={styles.card}>
                {/* NX-style ribbon/title bar */}
                <div style={styles.titleBar}>
                    <div style={styles.titleBarLeft}>
                        <Lock size={13} color="#1976D2" style={{ marginRight: 8, flexShrink: 0 }} />
                        <span style={styles.titleBarText}>
                            ProdSched
                            <span style={styles.tabUnderline} />
                        </span>
                    </div>
                    <span style={styles.titleBarDim}>Sign In</span>
                </div>

                <div style={styles.body}>
                    <div style={styles.title}>Production Scheduler</div>
                    <div style={styles.sub}>Enter your credentials to continue</div>

                    <div style={styles.fieldLabel}>Username</div>
                    <input
                        className="ps-login-input"
                        type="text"
                        autoFocus
                        autoCapitalize="none"
                        autoComplete="username"
                        value={username}
                        onChange={(e) => { setUsername(e.target.value); setError(""); }}
                        placeholder="username"
                        style={{
                            ...styles.input,
                            borderColor: error ? "#D83B01" : "#ABABAB",
                            marginBottom: 14,
                        }}
                    />

                    <div style={styles.fieldLabel}>Password</div>
                    <input
                        className="ps-login-input"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); setError(""); }}
                        placeholder="password"
                        style={{
                            ...styles.input,
                            borderColor: error ? "#D83B01" : "#ABABAB",
                        }}
                    />

                    {error && (
                        <div style={styles.errorRow}>
                            <AlertCircle size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="ps-login-btn"
                        disabled={loading}
                        style={{ ...styles.btn, opacity: loading ? 0.7 : 1, cursor: loading ? "not-allowed" : "pointer" }}
                    >
                        {loading ? "Signing in…" : "Enter"}
                    </button>

                    <div style={styles.hint}>
                        First time with no users? Any credentials work —<br />you'll be signed in as admin.
                    </div>
                </div>
            </form>
        </div>
    );
}

// ===== Siemens NX light palette =====
const styles = {
    wrap: {
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(180deg, #FDFDFD 0%, #F1F3F5 55%, #E6EAED 100%)",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        boxSizing: "border-box",
    },
    card: {
        width: 340,
        background: "#FFFFFF",
        border: "1px solid #C8C8C8",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 6px 24px rgba(38,38,38,0.14)",
        boxSizing: "border-box",
        overflow: "hidden",
    },
    titleBar: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "#F5F6F7",
        borderBottom: "1px solid #D4D4D4",
        padding: "8px 12px",
        boxSizing: "border-box",
    },
    titleBarLeft: {
        display: "flex",
        alignItems: "center",
        minWidth: 0,
    },
    titleBarText: {
        position: "relative",
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 600,
        fontSize: 12,
        letterSpacing: 0.5,
        color: "#262626",
        paddingBottom: 3,
    },
    tabUnderline: {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 2,
        background: "#F2A900",
        borderRadius: 1,
    },
    titleBarDim: {
        fontSize: 11,
        color: "#6E6E6E",
    },
    body: {
        display: "flex",
        flexDirection: "column",
        padding: "24px 24px 22px",
        boxSizing: "border-box",
    },
    title: {
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        fontWeight: 600,
        fontSize: 16.5,
        color: "#262626",
        marginBottom: 4,
    },
    sub: {
        fontSize: 12,
        color: "#6E6E6E",
        marginBottom: 20,
    },
    fieldLabel: {
        fontSize: 11.5,
        fontWeight: 600,
        color: "#444444",
        marginBottom: 5,
    },
    input: {
        width: "100%",
        background: "#FFFFFF",
        border: "1px solid #ABABAB",
        borderRadius: 2,
        padding: "9px 10px",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        fontSize: 13.5,
        color: "#262626",
        boxSizing: "border-box",
        transition: "border-color 0.12s ease, box-shadow 0.12s ease",
    },
    errorRow: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: "#D83B01",
        marginTop: 10,
    },
    btn: {
        width: "100%",
        marginTop: 20,
        background: "#1976D2",
        color: "#FFFFFF",
        border: "1px solid #0F559E",
        borderRadius: 2,
        padding: "9px 0",
        fontSize: 13.5,
        fontWeight: 600,
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        transition: "background 0.12s ease",
    },
    hint: {
        fontSize: 11,
        color: "#ABABAB",
        textAlign: "center",
        marginTop: 16,
        lineHeight: 1.6,
    },
};