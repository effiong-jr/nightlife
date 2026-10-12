import type { MetadataRoute } from "next";

// Staff install this (DJ tablet, MC phone, club screen, manager). No service
// worker: nothing is cached offline (see CLAUDE.md "Design rules").
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/start",
    name: "Nightlife",
    short_name: "Nightlife",
    description: "DJ queue, MC shoutouts and the club screen for Nightlife staff.",
    start_url: "/start",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
