"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// Nudges staff to install the app (full screen, own icon; push alerts later).
// Chrome/Android/desktop: a real "Install" button. iPhone Safari: how to add it
// to the home screen. Hidden once installed or dismissed.
//
// Chrome fires `beforeinstallprompt` once per full page load, but staff move
// between /dj, /mc and /club without reloading, and each page mounts its own
// hint. So the event is caught once here, at module level, and shared.

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const DISMISSED_KEY = "nightlife:install-hint-dismissed";

let deferredPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useInstallPrompt(): InstallPromptEvent | null {
  return useSyncExternalStore(
    subscribe,
    () => deferredPrompt,
    () => null,
  );
}

type Mode = "hidden" | "available";

export function InstallHint() {
  const prompt = useInstallPrompt();
  // Decided after mount (reads the browser), never during render.
  const [mode, setMode] = useState<Mode>("hidden");
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      // Storage blocked: just show the hint.
    }
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent);
    const timer = setTimeout(() => {
      setIsIos(ios);
      setMode(standalone || dismissed ? "hidden" : "available");
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // A real install prompt wins; iPhone Safari (which has none) gets instructions.
  if (mode === "hidden" || (!prompt && !isIos)) return null;

  const dismiss = () => {
    setMode("hidden");
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Ignore: it just shows again next time.
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-sm">
      <p className="flex-1 text-muted-foreground">
        {prompt
          ? "Install Nightlife for a full-screen app on this device."
          : "Install: tap Share, then “Add to Home Screen”."}
      </p>
      {prompt && (
        <button
          type="button"
          onClick={async () => {
            await prompt.prompt();
            await prompt.userChoice;
            // A prompt can only be used once.
            deferredPrompt = null;
            notify();
          }}
          className="rounded-lg bg-foreground px-3 py-1.5 font-medium text-background"
        >
          Install
        </button>
      )}
      <button type="button" onClick={dismiss} className="px-2 py-1.5 text-muted-foreground" aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
