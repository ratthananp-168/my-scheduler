import { useState } from "react";
import Login from "./Login";
import ScanAction, { broadcastJobScan } from "./ScanAction";
import ProductionScheduler from "./production-scheduler";
import "./App.css";

function App() {
  const [authed, setAuthed] = useState(
    sessionStorage.getItem("ps-authed") === "1"
  );

  const params        = new URLSearchParams(window.location.search);
  const scanAction    = params.get("scan");      // "start" | "stop"
  const scanJobId     = params.get("job");
  const alarmAction   = params.get("alarm");     // "raise" | "clear"
  const alarmResId    = params.get("resource");
  const bindAction    = params.get("bind");      // "resource"

  const goHome = () => { window.location.href = window.location.origin; };

  // Scan 1 — bind machine (opens ScanAction in bind mode, stays on page waiting)
  if (bindAction === "resource" && alarmResId) {
    return <ScanAction kind="bind" action="resource" id={alarmResId} onDone={goHome} />;
  }

  // Scan 2 — job start/stop
  // If a bind tab is waiting, broadcast this job id to it so it can proceed inline.
  // Then render normally on this tab too (standalone fallback).
  if (scanAction && scanJobId) {
    if (scanAction === "start") broadcastJobScan(scanJobId);
    return <ScanAction kind="job" action={scanAction} id={scanJobId} onDone={goHome} />;
  }

  // Alarm raise/clear (unchanged)
  if (alarmAction && alarmResId) {
    return <ScanAction kind="alarm" action={alarmAction} id={alarmResId} onDone={goHome} />;
  }

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  return <ProductionScheduler />;
}

export default App;