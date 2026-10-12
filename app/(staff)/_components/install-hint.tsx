"use client";

import { useEffect, useState } from "react";

// Nudges staff to install the app (full screen, own icon; push alerts later).
// Android/desktop Chrome: a real "Install" button. iPhone Safari: how to add it
// to the home screen. Hidden once installed or dismissed.

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const DISMISSED_KEY = "nightlife:install-hint-dismissed";

export function InstallHint() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);

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
    if (standalone || dismissed) return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    // iOS Safari has no install prompt event.
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent);
    const timer = isIos ? setTimeout(() => setShowIosHelp(true), 0) : null;
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!prompt && !showIosHelp) return null;

  const dismiss = () => {
    setPrompt(null);
    setShowIosHelp(false);
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
            setPrompt(null);
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
