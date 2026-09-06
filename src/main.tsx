import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const isDeviceControl = window.location.pathname.replace(/\/+$/, "") === "/device-control";
const App = lazy(() => import("./App"));
const DeviceControlConsole = lazy(async () => {
  const module = await import("./device-control/DeviceControlConsole");
  return { default: module.DeviceControlConsole };
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isDeviceControl ? (
      <Suspense fallback={<main className="routeLoading">正在打开 iPhone 控制台…</main>}>
        <DeviceControlConsole />
      </Suspense>
    ) : (
      <Suspense fallback={<main className="routeLoading">正在唤醒 Soyo…</main>}>
        <App />
      </Suspense>
    )}
  </StrictMode>
);
