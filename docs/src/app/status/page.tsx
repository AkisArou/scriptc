import { CoverageDashboard } from "@/components/coverage-dashboard";

export default function StatusPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-6 py-12 sm:py-16">
      <header className="grid gap-5 border-b border-gray-alpha-400 pb-10 lg:grid-cols-12 lg:gap-12">
        <h1 className="heading-40 text-gray-1000 sm:heading-48 lg:col-span-7">Compiler status</h1>
        <p className="max-w-2xl copy-16 text-gray-900 lg:col-span-5 lg:pt-2">
          Track the published compiler surface across releases, then audit it against programs that
          compile, run, and match Node.
        </p>
      </header>
      <CoverageDashboard />
    </div>
  );
}
