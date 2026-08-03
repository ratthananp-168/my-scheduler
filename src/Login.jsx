import { useState } from "react";
import { Lock, AlertCircle } from "lucide-react";

// change these to whatever credentials you want everyone to use
const SITE_USERNAME = "ratthanan";
const SITE_PASSWORD = "matadmin";

export default function Login({ onSuccess }) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState(false);

    function handleSubmit(e) {
        e.preventDefault();
        if (username === SITE_USERNAME && password === SITE_PASSWORD) {
            sessionStorage.setItem("ps-authed", "1");
            onSuccess();
        } else {
            setError(true);
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
                        value={username}
                        onChange={(e) => {
                            setUsername(e.target.value);
                            setError(false);
                        }}
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
                        value={password}
                        onChange={(e) => {
                            setPassword(e.target.value);
                            setError(false);
                        }}
                        placeholder="password"
                        style={{
                            ...styles.input,
                            borderColor: error ? "#D83B01" : "#ABABAB",
                        }}
                    />

                    {error && (
                        <div style={styles.errorRow}>
                            <AlertCircle size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                            Incorrect username or password
                        </div>
                    )}

                    <button type="submit" className="ps-login-btn" style={styles.btn}>
                        Enter
                    </button>
                </div>
            </form>
        </div>
    );
}

// ===== Siemens NX light palette (matched to NX - Manufacturing) =====
// window bg    #F0F0F0 → #FFFFFF  (viewport gradient)
// ribbon       #FFFFFF            (title/ribbon area)
// panel line   #D4D4D4            (dividers)
// border       #ABABAB            (control outlines)
// text         #262626            (primary)
// text dim     #6E6E6E            (secondary)
// accent blue  #1976D2            (operation names / selection)
// accent gold  #F2A900            (active ribbon tab underline)
// error        #D83B01

const styles = {
    wrap: {
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // NX viewport-style light falloff
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
    // gold underline like the active "Home" ribbon tab in NX
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
        cursor: "pointer",
        fontFamily: "'Segoe UI', 'Inter', sans-serif",
        transition: "background 0.12s ease",
    },
};