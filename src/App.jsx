import { useState } from "react";
import Login from "./Login";
import ScanAction from "./ScanAction";
import ProductionScheduler from "./production-scheduler";
import "./App.css";

function App() {
  const [authed, setAuthed] = useState(
    sessionStorage.getItem("ps-authed") === "1"
  );

  const params      = new URLSearchParams(window.location.search);
  const scanParam   = params.get("scan");   // "job" (unified) | "start" | "stop" (legacy)
  const scanJobId   = params.get("job");
  const alarmAction = params.get("alarm");  // "raise" | "clear"
  const alarmResId  = params.get("resource");

  const goHome = () => { window.location.href = window.location.origin; };

  // Any scan/alarm URL requires login first
  // After login, redirect back to the same URL so the scan resumes automatically
  const isScanUrl = (scanParam && scanJobId) || (alarmAction && alarmResId);

  if (isScanUrl && !authed) {
    return (
      <Login
        onSuccess={() => {
          // reload the same URL — now authed, so scan will render
          window.location.reload();
        }}
        hint="Please sign in to continue scanning"
      />
    );
  }

  // Unified job QR — one QR per job, choose start/stop on screen
  if (scanParam === "job" && scanJobId) {
    return <ScanAction kind="job" action="choose" id={scanJobId} onDone={goHome} />;
  }

  // Legacy URLs (old QR codes still work)
  if ((scanParam === "start" || scanParam === "stop") && scanJobId) {
    return <ScanAction kind="job" action={scanParam} id={scanJobId} onDone={goHome} />;
  }

  // Alarm raise/clear
  if (alarmAction && alarmResId) {
    return <ScanAction kind="alarm" action={alarmAction} id={alarmResId} onDone={goHome} />;
  }

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  return <ProductionScheduler />;
}

export default App;