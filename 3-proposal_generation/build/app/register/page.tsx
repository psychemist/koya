import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/auth";
import { RegisterForm } from "./RegisterForm";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col justify-center px-5 py-10">
      <div className="mb-6">
        <div className="eyebrow text-[var(--accent)]">Koya</div>
        <h1 className="page-title mt-2">Create your account</h1>
      </div>
      <RegisterForm />
    </main>
  );
}
