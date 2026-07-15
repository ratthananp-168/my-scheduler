import { useState } from "react";
import Login from "./Login";
import ScanAction from "./ScanAction";
import ProductionScheduler from "./production-scheduler";
import "./App.css";

function App() {
  const [authed, setAuthed] = useState(
    sessionStorage.getItem("ps-authed") === "1"
  );

  // เช็คว่า URL มี ?scan=start&job=xxx หรือ ?scan=stop&job=xxx ไหม
  const params = new URLSearchParams(window.location.search);
  const scanAction = params.get("scan"); // "start" หรือ "stop"
  const scanJobId = params.get("job");

  if (scanAction && scanJobId) {
    return (
      <ScanAction
        action={scanAction}
        jobId={scanJobId}
        onDone={() => {
          window.location.href = window.location.origin;
        }}
      />
    );
  }

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return <ProductionScheduler />;
}

export default App;