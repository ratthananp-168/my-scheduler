import { useState } from "react";
import Login from "./Login";
import ScanAction from "./ScanAction";
import ProductionScheduler from "./production-scheduler";
import "./App.css";

function App() {
  const [authed, setAuthed] = useState(
    sessionStorage.getItem("ps-authed") === "1"
  );

  // เช็คว่า URL มี ?scan=start|stop&job=xxx หรือ ?alarm=raise|clear&resource=xxx ไหม
  const params = new URLSearchParams(window.location.search);
  const scanAction = params.get("scan"); // "start" หรือ "stop"
  const scanJobId = params.get("job");
  const alarmAction = params.get("alarm"); // "raise" หรือ "clear"
  const alarmResourceId = params.get("resource");

  const goHome = () => {
    window.location.href = window.location.origin;
  };

  if (scanAction && scanJobId) {
    return (
      <ScanAction kind="job" action={scanAction} id={scanJobId} onDone={goHome} />
    );
  }

  if (alarmAction && alarmResourceId) {
    return (
      <ScanAction kind="alarm" action={alarmAction} id={alarmResourceId} onDone={goHome} />
    );
  }

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return <ProductionScheduler />;
}

export default App;