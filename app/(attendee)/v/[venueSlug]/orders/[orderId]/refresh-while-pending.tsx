"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 60; // ~3 minutes

// Re-renders the receipt on the server until the payment webhook has landed.
// Unmounts (stopping the polling) as soon as the order is no longer pending.
export function RefreshWhilePending() {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }
      router.refresh();
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, [router]);

  if (!gaveUp) return null;
  return (
    <p className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-300">
      Still waiting for confirmation. If you were charged, it will show here shortly. You don&apos;t
      need to pay again. Refresh this page to check.
    </p>
  );
}
