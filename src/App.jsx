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
  const scanAction  = params.get("scan");
  const scanJobId   = params.get("job");
  const alarmAction = params.get("alarm");
  const alarmResId  = params.get("resource");

  const isScanRoute = (scanAction && scanJobId) || (alarmAction && alarmResId);

  // must be logged in before any scan/alarm action
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  if (isScanRoute) return <ScanAction />;

  return <ProductionScheduler />;
}

export default App;