import { redirect } from "next/navigation";
import { staffHomePath } from "@/lib/server/staff";

// Where the installed app opens: the person's own view, or sign-in.
export async function GET() {
  redirect(await staffHomePath());
}
