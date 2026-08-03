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
                @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600;700&display=swap');
                .ps-login-input:focus { outline: none; border-color: #2F6E86 !important; box-shadow: 0 0 0 3px rgba(47,110,134,0.14); }
                .ps-login-btn:hover { background: #234F60 !important; }
            `}</style>
            <form onSubmit={handleSubmit} style={styles.card}>
                <div style={styles.iconWrap}>
                    <Lock size={20} color="#2F6E86" />
                </div>
                <div style={styles.title}>Production Scheduler</div>
                <div style={styles.sub}>sign in to continue</div>

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
                        borderColor: error ? "#F0625B" : "#DCE4E7",
                        marginBottom: 10,
                    }}
                />

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
                        borderColor: error ? "#F0625B" : "#DCE4E7",
                    }}
                />

                {error && (
                    <div style={styles.errorRow}>
                        <AlertCircle size={13} style={{ marginRight: 5, flexShrink: 0 }} />
                        incorrect username or password
                    </div>
                )}

                <button type="submit" className="ps-login-btn" style={styles.btn}>
                    Enter
                </button>
            </form>
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
    },
    card: {
        width: 320,
        background: "#FFFFFF",
        border: "1px solid #E4EAEC",
        borderRadius: 18,
        padding: "28px 26px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        boxShadow: "0 8px 28px rgba(27,34,38,0.08)",
        boxSizing: "border-box",
    },
    iconWrap: {
        width: 44,
        height: 44,
        borderRadius: 12,
        background: "#E7EEF1",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginBottom: 14,
    },
    title: {
        fontFamily: "'Poppins', sans-serif",
        fontWeight: 700,
        fontSize: 16,
        color: "#1B2226",
        marginBottom: 4,
        textAlign: "center",
    },
    sub: {
        fontSize: 12.5,
        color: "#7C8A93",
        marginBottom: 20,
        textAlign: "center",
    },
    input: {
        width: "100%",
        background: "#F2F6F7",
        border: "1px solid #DCE4E7",
        borderRadius: 10,
        padding: "10px 12px",
        fontFamily: "'Inter', sans-serif",
        fontSize: 13.5,
        color: "#1B2226",
        boxSizing: "border-box",
    },
    errorRow: {
        display: "flex",
        alignItems: "center",
        fontSize: 11.5,
        color: "#C4372E",
        marginTop: 8,
        alignSelf: "flex-start",
    },
    btn: {
        width: "100%",
        marginTop: 16,
        background: "#2F6E86",
        color: "#FFFFFF",
        border: "none",
        borderRadius: 10,
        padding: "10px 0",
        fontSize: 13.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'Inter', sans-serif",
    },
};
