"use client";
import { MaxUI } from "@maxhub/max-ui";
import { useMemo, useState, type ReactNode } from "react";
import { createApiClient, type ApiClient } from "@/lib/client/api";
import * as bridge from "@/lib/client/max-bridge";
import { AppShell } from "./AppShell";
import { DataProvider } from "./state/data";
import { NavigationProvider } from "./state/navigation";
import { ToastProvider } from "./state/toast";

// MAX passes launch data in the URL hash; keep it before the router normalises the hash.
if (typeof window !== "undefined") bridge.captureLaunchParams();

/** MAX UI provider: platform follows the MAX client, colour scheme follows the system. */
export function MaxRoot({ children }: { children: ReactNode }) {
  const [platform] = useState<"ios" | "android" | undefined>(() => {
    const p = bridge.platform();
    if (p === "ios") return "ios";
    if (p) return "android";
    return undefined;
  });
  return (
    <MaxUI platform={platform} className="ol-maxui">
      {children}
    </MaxUI>
  );
}

export function App({ api }: { api?: ApiClient }) {
  const client = useMemo(() => api ?? createApiClient({ getInitData: bridge.initData }), [api]);
  return (
    <MaxRoot>
      <ToastProvider>
        <DataProvider api={client}>
          <NavigationProvider>
            <AppShell />
          </NavigationProvider>
        </DataProvider>
      </ToastProvider>
    </MaxRoot>
  );
}
