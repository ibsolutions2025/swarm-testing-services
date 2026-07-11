import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter, PublicHeader } from "../_components/public-site";

export const metadata: Metadata = { title: "Privacy | Swarm Testing Services", description: "Private-beta privacy notice for Swarm Testing Services." };

export default function PrivacyPage() {
  return (
    <main className="min-h-screen">
      <PublicHeader />
      <article className="container-narrow max-w-4xl py-16 lg:py-20">
        <p className="text-sm uppercase tracking-widest text-accent">Legal</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">Privacy Notice</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">Effective July 11, 2026</p>
        <div className="mt-10 rounded-lg border border-amber-400/30 bg-amber-400/10 p-5 text-sm leading-6 text-amber-100">Private-beta retention schedules and subprocessors are still being finalized. Unless a written beta agreement says otherwise, do not submit production personal data, regulated data, private keys, API secrets, payment credentials, or information you are not authorized to share.</div>
        <div className="mt-12 space-y-12">
          <LegalSection title="Information we receive"><p><strong className="text-white">Account information:</strong> email address, authentication records, and basic account metadata.</p><p><strong className="text-white">Campaign content:</strong> target and documentation URLs, scope, instructions, authorization confirmations, test configuration, generated plans, results, and evidence.</p><p><strong className="text-white">Service data:</strong> request metadata, device and browser information, diagnostics, security events, timestamps, usage counts, and support communications.</p></LegalSection>
          <LegalSection title="How we use information"><p>We use information to provide and secure the beta, validate and plan campaigns, communicate with users, troubleshoot failures, prevent abuse, measure reliability, meet legal obligations, and improve product quality. We do not sell personal information or use customer campaign content for targeted advertising.</p></LegalSection>
          <LegalSection title="AI and automated processing"><p>Campaign content may be sent to model providers or other service providers to produce product summaries, scenarios, personas, rubrics, and quality checks. Model output can be inaccurate or inferred. Do not include secrets or unnecessary personal data in source documents, URLs, or instructions.</p></LegalSection>
          <LegalSection title="When information is shared"><p>We may share information with infrastructure, database, authentication, observability, communications, and AI service providers acting on our behalf; with professional advisers; in a business transaction; to comply with law; or to address fraud, abuse, safety, and security risks. We do not authorize providers to use customer content for their own advertising.</p></LegalSection>
          <LegalSection title="Security"><p>We use technical and organizational safeguards appropriate to a private beta, but no system is completely secure. Use staging environments, synthetic identities, least-privilege accounts, and non-production data. Report suspected security issues to <Link href="mailto:hello@swarm-testing.dev" className="text-accent hover:underline">hello@swarm-testing.dev</Link> and do not include exploit details in a public channel.</p></LegalSection>
          <LegalSection title="Retention and deletion"><p>During private beta, retention periods depend on operational needs and any written evaluation agreement. We retain information as needed to operate, secure, troubleshoot, and meet legal obligations, then delete or de-identify it when it is no longer needed. You may request deletion of an account or campaign content. Some records may be retained when required for security, fraud prevention, legal compliance, dispute resolution, or backups.</p></LegalSection>
          <LegalSection title="Your choices and rights"><p>You may ask to access, correct, export, or delete personal information, or object to certain processing. Rights vary by location and may be subject to verification and legal exceptions. You can also choose not to provide optional information, though that may limit the beta&apos;s usefulness.</p></LegalSection>
          <LegalSection title="International processing and children"><p>Providers may process information in countries other than your own, subject to available legal safeguards. STS is intended for business users and is not directed to children under 13 or the minimum age required by local law.</p></LegalSection>
          <LegalSection title="Changes and contact"><p>We may update this notice as the service and its data practices mature. The effective date will identify the latest version. Privacy questions and requests can be sent to <Link href="mailto:hello@swarm-testing.dev" className="text-accent hover:underline">hello@swarm-testing.dev</Link>.</p></LegalSection>
        </div>
      </article>
      <PublicFooter />
    </main>
  );
}

function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="text-xl font-medium">{title}</h2><div className="mt-3 space-y-4 text-sm leading-7 text-[var(--muted)]">{children}</div></section>;
}
