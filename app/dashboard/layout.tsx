import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase-server";
import { ensureAwpSeeded } from "@/lib/seed-awp";

export const dynamic = "force-dynamic";

/**
 * Dashboard layout: guards /dashboard/* against unauthenticated access and
 * auto-seeds AWP as every user's first project.
 */
export default async function DashboardLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const supabase = createServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?next=/dashboard");

  // Seed AWP as the user's first project. Best-effort — failures fall through.
  try {
    await ensureAwpSeeded(user.id);
  } catch {
    /* non-fatal — child pages handle missing-data UI */
  }

  return <>{children}</>;
}
