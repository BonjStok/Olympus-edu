"use client";
import { useSyncExternalStore } from "react";
import { App } from "@/components/olympus/App";
import "@maxhub/max-ui/dist/styles.css";

const noop = () => () => undefined;

/** The app reads `window` (MAX bridge, storage, theme), so it renders on the client only. */
export default function Page() {
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  if (!mounted)
    return (
      <div className="ol-splash" role="status" aria-live="polite">
        <img src="/olympus-icon-ui.webp" alt="" width={72} height={72} />
        <span>Открываем Олимпус…</span>
      </div>
    );
  return <App />;
}
