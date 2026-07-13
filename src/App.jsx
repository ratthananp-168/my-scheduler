import { useState } from "react";
import Login from "./Login";
import ProductionScheduler from "./production-scheduler"; // ชื่อไฟล์ตามที่คุณมีอยู่จริง
import "./App.css";

function App() {
  const [authed, setAuthed] = useState(
    sessionStorage.getItem("ps-authed") === "1"
  );

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return <ProductionScheduler />;
}

export default App;