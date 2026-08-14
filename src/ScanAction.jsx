import { useState } from "react";
import Login from "./Login";
import ScanAction from "./ScanAction";
import ProductionScheduler from "./production-scheduler";
import "./App.css";

// read URL params once at module load — never re-read on re-render
const _params     = new URLSearchParams(window.location.search);
const _scanAction = _params.get("scan");
const _scanJobId  = _params.get("job");
const _alarmAction= _params.get("alarm");
const _alarmResId = _params.get("resource");
const IS_SCAN_ROUTE = (_scanAction && _scanJobId) || (_alarmAction && _alarmResId);

function App() {
  const [authed, setAuthed] = useState(
    sessionStorage.getItem("ps-authed") === "1"
  );

  // must be logged in before any scan/alarm action
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  if (IS_SCAN_ROUTE) return <ScanAction />;

  return <ProductionScheduler />;
}

export default App;