import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UsageSection {
  name: string;
  percent: number;
  reset_text: string;
}

interface UsageResult {
  plan_name: string;
  sections: UsageSection[];
}

export interface UsageData {
  planName: string;
  percent: number;
  label: string;
  sections: UsageSection[];
  error: string | null;
}

function pickPrimarySection(sections: UsageSection[]): UsageSection | null {
  return (
    sections.find((s) => s.name === "Current session") ??
    sections.find((s) => s.name === "All models") ??
    sections[0] ??
    null
  );
}

function formatLabel(section: UsageSection): string {
  const reset = section.reset_text ? ` \u2014 resets ${section.reset_text}` : "";
  return `${section.percent}% used${reset}`;
}

export function useUsage(intervalMs: number = 60_000): UsageData {
  const [data, setData] = useState<UsageData>({
    planName: "Loading...",
    percent: 0,
    label: "Loading...",
    sections: [],
    error: null,
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function fetch() {
      try {
        const result = await invoke<UsageResult>("get_usage");
        if (!mountedRef.current) return;
        const primary = pickPrimarySection(result.sections);
        setData({
          planName: result.plan_name,
          percent: primary?.percent ?? 0,
          label: primary ? formatLabel(primary) : "No data",
          sections: result.sections,
          error: null,
        });
      } catch (e: any) {
        if (!mountedRef.current) return;
        setData((prev) => ({
          ...prev,
          error: typeof e === "string" ? e : e.message ?? "Unknown error",
          label: 'Run "claude auth" to connect',
        }));
      }
    }

    fetch();
    const id = setInterval(fetch, intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return data;
}
