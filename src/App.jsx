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
  const scanAction  = params.get("scan");      // "start" | "stop"
  const scanJobId   = params.get("job");
  const alarmAction = params.get("alarm");     // "raise" | "clear"
  const alarmResId  = params.get("resource");

  const isScanRoute = (scanAction && scanJobId) || (alarmAction && alarmResId);
  const goHome = () => { window.location.href = window.location.origin; };

  // must be logged in before any scan action
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  // job start/stop
  if (scanAction && scanJobId) {
    return <ScanAction kind="job" action={scanAction} id={scanJobId} onDone={goHome} />;
  }

  // alarm raise/clear
  if (alarmAction && alarmResId) {
    return <ScanAction kind="alarm" action={alarmAction} id={alarmResId} onDone={goHome} />;
  }

  return <ProductionScheduler />;
}

export default App;